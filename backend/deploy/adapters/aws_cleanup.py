"""Real AWS cleanup adapters.

Each adapter owns one resource kind and answers two questions: delete it, and is it
still there. The reconciler needs both, because an accepted delete does not prove
billing stopped -- only observed absence does.

Four rules, three of which exist because the first version got them wrong.

**Absence is classified per service, by error code.** An earlier version matched the
substring "not found" anywhere in an error message, which meant
`AccessDenied: role eddie-x not found` and a DNS failure mentioning a host not found
both read as "the resource is gone". Each adapter now declares the exact
`(code, message)` shapes its service uses for a genuine absence; anything else raises.
Transport failures and authorization failures can never establish deletion.

**Scope is validated before the call.** An entry records the account and Region its
resource lives in. Asking us-east-1 about a us-west-2 endpoint gets a legitimate
not-found, which would have been read as confirmed absence while the resource kept
billing in the other Region. A mismatch raises `UnsupportedScope`, and the reconciler
keeps the entry unresolved.

**Identity comes from the ledger, and "no identity" is not "absent".** Lookup uses the
physical id when known and the planned name otherwise, so a create whose response was
lost can still be reconciled. An entry with neither raises rather than reporting
absence -- the previous behaviour marked such entries DELETED without making any AWS
call at all.

**Deletion is idempotent.** A resource already gone is success, so a retry does not
report a failed cleanup. Nothing here lists or pattern-matches: this account contains
EC2 instances and SageMaker models EDDIE did not create.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Optional

from ..models import LedgerEntry

log = logging.getLogger("eddie.cleanup")


class UnsupportedScope(Exception):
    """The entry names an account or Region this adapter cannot act in.

    Raised rather than returning "absent", because a not-found from the wrong place is
    not evidence about the right place.
    """


class UnknownIdentity(Exception):
    """The entry carries no identifier and no planned name, so nothing can be checked."""


def _error_code(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return str((response.get("Error") or {}).get("Code", ""))
    return ""


def _error_message(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        message = (response.get("Error") or {}).get("Message")
        if message:
            return str(message)
    return str(exc)


def is_not_found(
    exc: Exception,
    *,
    codes: tuple[str, ...],
    require_message: tuple[str, ...] = (),
) -> bool:
    """Whether this exception definitely means the resource is absent.

    `codes` are the service's own not-found codes. `require_message` exists for
    services that reuse a generic code: SageMaker returns `ValidationException` both for
    a missing endpoint and for a malformed request, so for that code the message must
    also match. A code not in `codes` is never an absence, however its message reads --
    which is the fix for `AccessDenied: ... not found` being treated as deleted.
    """
    code = _error_code(exc)
    if not code or code not in codes:
        return False
    if require_message:
        lowered = _error_message(exc).lower()
        return any(fragment in lowered for fragment in require_message)
    return True


class _RegionalAdapter:
    """Base class holding the scope check and per-Region client construction.

    Clients are created per Region and cached, so an entry is always queried in the
    Region its resource actually lives in rather than wherever the worker happens to
    run.
    """

    kinds: tuple[str, ...] = ()
    service: str = ""

    def __init__(
        self,
        *,
        account_id: str = "",
        permitted_regions: tuple[str, ...] = (),
        client_factory: Optional[Callable[[str], Any]] = None,
    ) -> None:
        self.account_id = account_id
        self.permitted_regions = permitted_regions
        self._client_factory = client_factory
        self._clients: dict[str, Any] = {}
        self._lock = threading.Lock()

    def client(self, region: str) -> Any:
        with self._lock:
            existing = self._clients.get(region)
            if existing is not None:
                return existing
        if self._client_factory is not None:
            client = self._client_factory(region)
        else:
            import boto3

            client = boto3.client(self.service, region_name=region)
        with self._lock:
            self._clients[region] = client
        return client

    def _scoped_client(self, entry: LedgerEntry) -> Any:
        """Validate the entry's scope, then return a client for its Region."""
        if not entry.region:
            raise UnsupportedScope(
                f"{entry.entry_id} records no Region, so it cannot be checked safely."
            )
        if self.permitted_regions and entry.region not in self.permitted_regions:
            raise UnsupportedScope(
                f"{entry.entry_id} is in {entry.region}, which this installation is not "
                f"configured to clean up (permitted: {', '.join(self.permitted_regions)})."
            )
        if self.account_id and entry.account_id and entry.account_id != self.account_id:
            raise UnsupportedScope(
                f"{entry.entry_id} belongs to account {entry.account_id}, not "
                f"{self.account_id}. Cleanup will not act across accounts."
            )
        return self.client(entry.region)

    def _identity(self, entry: LedgerEntry) -> str:
        identity = entry.lookup_id
        if not identity:
            raise UnknownIdentity(
                f"{entry.entry_id} has neither a physical id nor a planned name, so "
                f"whether it exists cannot be determined."
            )
        return identity


class SageMakerEndpointAdapter(_RegionalAdapter):
    """Remove only the exact resource owned by the recorded deployment."""
    kinds = ("sagemaker-endpoint",)
    service = "sagemaker"
    NOT_FOUND_CODES = ("ValidationException",)
    NOT_FOUND_MESSAGES = ("could not find", "does not exist")
    describe_operation = "describe_endpoint"
    delete_operation = "delete_endpoint"
    name_parameter = "EndpointName"
    arn_field = "EndpointArn"

    def delete(self, entry: LedgerEntry) -> None:
        client = self._scoped_client(entry)
        name = self._identity(entry)
        try:
            resource = getattr(client, self.describe_operation)(**{self.name_parameter: name})
            arn = resource.get(self.arn_field)
            if not arn:
                raise UnknownIdentity("The resource description did not identify its ARN.")
            tags = {t["Key"]: t["Value"] for t in client.list_tags(ResourceArn=arn).get("Tags", [])}
            if tags.get("eddie:job") != entry.job_id:
                raise UnsupportedScope("The SageMaker resource is not owned by this deployment.")
            if entry.tags.get("eddie:plan-hash") and tags.get("eddie:plan-hash") != entry.tags["eddie:plan-hash"]:
                raise UnsupportedScope("The SageMaker resource belongs to a different approved plan.")
            getattr(client, self.delete_operation)(**{self.name_parameter: name})
        except Exception as exc:
            if is_not_found(exc, codes=self.NOT_FOUND_CODES, require_message=self.NOT_FOUND_MESSAGES):
                return
            raise

    def exists(self, entry: LedgerEntry) -> bool:
        client = self._scoped_client(entry)
        name = self._identity(entry)
        try:
            getattr(client, self.describe_operation)(**{self.name_parameter: name})
            return True
        except Exception as exc:
            if is_not_found(exc, codes=self.NOT_FOUND_CODES, require_message=self.NOT_FOUND_MESSAGES):
                return False
            raise


class SageMakerEndpointConfigAdapter(SageMakerEndpointAdapter):
    kinds = ("sagemaker-endpoint-config",)
    describe_operation = "describe_endpoint_config"
    delete_operation = "delete_endpoint_config"
    name_parameter = "EndpointConfigName"
    arn_field = "EndpointConfigArn"


class SageMakerModelAdapter(SageMakerEndpointAdapter):
    kinds = ("sagemaker-model",)
    describe_operation = "describe_model"
    delete_operation = "delete_model"
    name_parameter = "ModelName"
    arn_field = "ModelArn"


class BedrockImportedModelAdapter(_RegionalAdapter):
    kinds = ("bedrock-imported-model",)
    service = "bedrock"
    #: Bedrock uses a dedicated code, so no message check is needed.
    NOT_FOUND_CODES = ("ResourceNotFoundException",)

    def delete(self, entry: LedgerEntry) -> None:
        client = self._scoped_client(entry)
        identity = entry.arn or self._identity(entry)
        try:
            client.delete_imported_model(modelIdentifier=identity)
        except Exception as exc:  # noqa: BLE001
            if is_not_found(exc, codes=self.NOT_FOUND_CODES):
                return
            raise

    def exists(self, entry: LedgerEntry) -> bool:
        client = self._scoped_client(entry)
        identity = entry.arn or self._identity(entry)
        try:
            client.get_imported_model(modelIdentifier=identity)
            return True
        except Exception as exc:  # noqa: BLE001
            if is_not_found(exc, codes=self.NOT_FOUND_CODES):
                return False
            raise


class Ec2InstanceAdapter(_RegionalAdapter):
    """Terminate, and treat only `terminated` as gone.

    A `stopped` instance is not deleted: it stops compute charges but keeps billing for
    its EBS volumes, so reporting it as removed would understate the residual.

    EC2 names its own instances, so there is no planned name to fall back on. An entry
    with no instance id is recovered through its client token instead: `describe_instances`
    filtered on `client-token` finds the instance a lost `RunInstances` response created,
    which is the only way to avoid either leaking it or launching a second one.
    """

    kinds = ("ec2-instance",)
    service = "ec2"
    NOT_FOUND_CODES = ("InvalidInstanceID.NotFound",)

    def _resolve_instance_id(self, entry: LedgerEntry) -> Optional[str]:
        """The instance id, recovering it from the client token when necessary."""
        if entry.physical_id:
            return entry.physical_id
        if not entry.client_token:
            raise UnknownIdentity(
                f"{entry.entry_id} has no instance id and no client token, so the "
                f"instance a lost launch may have created cannot be found."
            )
        client = self._scoped_client(entry)
        response = client.describe_instances(
            Filters=[{"Name": "client-token", "Values": [entry.client_token]}]
        )
        for reservation in response.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                if (instance.get("State") or {}).get("Name") != "terminated":
                    return instance.get("InstanceId")
        return None

    def delete(self, entry: LedgerEntry) -> None:
        client = self._scoped_client(entry)
        instance_id = self._resolve_instance_id(entry)
        if instance_id is None:
            # Nothing was launched under this token. Confirmed by a real query, not by
            # the absence of a field.
            return
        try:
            client.terminate_instances(InstanceIds=[instance_id])
        except Exception as exc:  # noqa: BLE001
            if is_not_found(exc, codes=self.NOT_FOUND_CODES):
                return
            raise

    def exists(self, entry: LedgerEntry) -> bool:
        client = self._scoped_client(entry)
        instance_id = self._resolve_instance_id(entry)
        if instance_id is None:
            return False
        try:
            response = client.describe_instances(InstanceIds=[instance_id])
        except Exception as exc:  # noqa: BLE001
            if is_not_found(exc, codes=self.NOT_FOUND_CODES):
                return False
            raise
        for reservation in response.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                if (instance.get("State") or {}).get("Name") != "terminated":
                    return True
        return False


def default_adapters(
    region: str = "us-east-1",
    *,
    account_id: str = "",
    permitted_regions: tuple[str, ...] = (),
) -> tuple[Any, ...]:
    """Every adapter the reconciler needs to own EDDIE's resource kinds.

    `permitted_regions` defaults to the worker's own Region. An entry outside it is
    refused rather than checked in the wrong place, and the reconciler reports it as
    unresolved -- visible and still owned, rather than silently marked deleted.
    """
    scope = permitted_regions or (region,)
    common = {
        "account_id": account_id,
        "permitted_regions": scope,
    }
    return (
        SageMakerEndpointAdapter(**common),
        SageMakerEndpointConfigAdapter(**common),
        SageMakerModelAdapter(**common),
        BedrockImportedModelAdapter(**common),
        Ec2InstanceAdapter(**common),
    )
