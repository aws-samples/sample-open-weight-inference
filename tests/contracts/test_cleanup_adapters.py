"""Cleanup adapters: idempotent, honest about ambiguity, and complete.

The reconciler's guarantees only hold if the adapters underneath behave. Three
properties matter, and each has a failure mode that would quietly leave a customer
paying for something.
"""

from __future__ import annotations

import pytest

from deploy.adapters.aws_cleanup import (
    BedrockImportedModelAdapter,
    Ec2InstanceAdapter,
    SageMakerEndpointAdapter,
    SageMakerEndpointConfigAdapter,
    SageMakerModelAdapter,
    is_not_found,
    default_adapters,
)

SAGEMAKER_CODES = ("ValidationException",)
SAGEMAKER_MESSAGES = ("could not find", "does not exist")


def sagemaker_not_found(exc: Exception) -> bool:
    return is_not_found(exc, codes=SAGEMAKER_CODES, require_message=SAGEMAKER_MESSAGES)
from deploy.models import LedgerEntry, ResourceState


def entry(kind: str = "sagemaker-endpoint", physical_id: str | None = "eddie-dev-x"):
    return LedgerEntry(
        entry_id="res-1",
        job_id="job-1",
        project_id="user:alice",
        kind=kind,
        intent_key="k",
        state=ResourceState.CREATED,
        region="us-east-1",
        account_id="123456789012",
        physical_id=physical_id,
    )


def sm(client) -> SageMakerEndpointAdapter:
    return SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: client,
    )


def ec2(client) -> Ec2InstanceAdapter:
    return Ec2InstanceAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: client,
    )


class FakeClient:
    """Records calls and raises what it is told to."""

    def __init__(self, **behaviour):
        self.behaviour = behaviour
        self.calls: list[str] = []

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append(name)
            outcome = self.behaviour.get(name)
            if isinstance(outcome, Exception):
                raise outcome
            if callable(outcome):
                return outcome(**kwargs)
            return outcome if outcome is not None else {}

        return call


def client_error(code: str, message: str) -> Exception:
    exc = Exception(message)
    exc.response = {"Error": {"Code": code, "Message": message}}  # type: ignore[attr-defined]
    return exc


# --------------------------------------------------------------------------
# Not-found classification
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "code,message",
    [
        ("ValidationException", "Could not find endpoint eddie-dev-x."),
        ("ValidationException", "Could not find model eddie-dev-x."),
    ],
)
def test_definite_sagemaker_absence_is_recognised(code, message):
    assert sagemaker_not_found(client_error(code, message))


def test_each_service_declares_its_own_not_found_codes():
    """Classification is per service; there is no shared substring rule.

    A single global "not found" match previously let AccessDenied and transport errors
    establish deletion. See tests/unit/test_cleanup_defects.py for the reproduction.
    """
    assert is_not_found(
        client_error("ResourceNotFoundException", "anything"),
        codes=BedrockImportedModelAdapter.NOT_FOUND_CODES,
    )
    assert is_not_found(
        client_error("InvalidInstanceID.NotFound", "The instance ID does not exist"),
        codes=Ec2InstanceAdapter.NOT_FOUND_CODES,
    )
    # A SageMaker code is not an EC2 absence, and vice versa.
    assert not is_not_found(
        client_error("ValidationException", "Could not find endpoint"),
        codes=Ec2InstanceAdapter.NOT_FOUND_CODES,
    )


@pytest.mark.parametrize(
    "code,message",
    [
        ("ThrottlingException", "Rate exceeded"),
        ("AccessDeniedException", "User is not authorized"),
        ("ValidationException", "1 validation error detected: value too long"),
        ("ServiceUnavailable", "try again later"),
    ],
)
def test_an_ambiguous_error_is_not_read_as_absence(code, message):
    """The dangerous direction.

    A throttle or an authorization failure read as "already gone" would mark a live,
    billing endpoint as DELETED. SageMaker returns ValidationException for both a
    missing endpoint and a malformed request, so the message has to disambiguate.
    """
    assert not sagemaker_not_found(client_error(code, message))


# --------------------------------------------------------------------------
# Idempotent deletion
# --------------------------------------------------------------------------


def test_deleting_an_absent_endpoint_is_success():
    """The reconciler retries; the second attempt must not look like a failure."""
    client = FakeClient(
        describe_endpoint=client_error("ValidationException", "Could not find endpoint")
    )
    sm(client).delete(entry())  # must not raise


def test_a_throttled_delete_raises_so_it_is_recorded_unconfirmed():
    client = FakeClient(
        describe_endpoint={"EndpointArn": "arn:aws:sagemaker:us-east-1:123456789012:endpoint/eddie-dev-x"},
        list_tags={"Tags": [{"Key": "eddie:job", "Value": "job-1"}]},
        delete_endpoint=client_error("ThrottlingException", "Rate exceeded")
    )
    with pytest.raises(Exception, match="Rate exceeded"):
        sm(client).delete(entry())


def test_an_entry_with_no_identity_refuses_rather_than_reporting_absence():
    """Changed behaviour, and the reason is a reproduced defect.

    This previously returned False -- "not there" -- without calling AWS, so a create
    whose response was lost left a billing endpoint recorded as deleted. It now raises,
    and the reconciler records DELETE_UNCONFIRMED.
    """
    from deploy.adapters.aws_cleanup import UnknownIdentity

    client = FakeClient()
    with pytest.raises(UnknownIdentity):
        sm(client).exists(entry(physical_id=None))
    assert client.calls == []


def test_a_planned_name_is_used_when_the_physical_id_is_absent():
    import dataclasses

    client = FakeClient(describe_endpoint={"EndpointName": "eddie-dev-planned"})
    scoped = dataclasses.replace(
        entry(physical_id=None), planned_name="eddie-dev-planned"
    )
    assert scoped.lookup_id == "eddie-dev-planned"
    assert sm(client).exists(scoped) is True
    assert client.calls == ["describe_endpoint"]


# --------------------------------------------------------------------------
# Confirmation
# --------------------------------------------------------------------------


def test_a_describable_endpoint_still_exists():
    client = FakeClient(describe_endpoint={"EndpointName": "eddie-dev-x"})
    assert sm(client).exists(entry()) is True


def test_an_absent_endpoint_does_not_exist():
    client = FakeClient(
        describe_endpoint=client_error("ValidationException", "Could not find endpoint")
    )
    assert sm(client).exists(entry()) is False


def test_an_ambiguous_describe_raises_rather_than_claiming_absence():
    """"Cannot tell" must reach the reconciler as DELETE_UNCONFIRMED."""
    client = FakeClient(
        describe_endpoint=client_error("ThrottlingException", "Rate exceeded")
    )
    with pytest.raises(Exception, match="Rate exceeded"):
        sm(client).exists(entry())


# --------------------------------------------------------------------------
# EC2: stopped is not deleted
# --------------------------------------------------------------------------


def test_a_stopped_instance_still_exists():
    """Stopping halts compute charges but keeps billing EBS, so it is not removed."""
    client = FakeClient(
        describe_instances={
            "Reservations": [{"Instances": [{"State": {"Name": "stopped"}}]}]
        }
    )
    assert ec2(client).exists(entry("ec2-instance", "i-123")) is True


def test_a_terminated_instance_is_gone():
    client = FakeClient(
        describe_instances={
            "Reservations": [{"Instances": [{"State": {"Name": "terminated"}}]}]
        }
    )
    assert ec2(client).exists(entry("ec2-instance", "i-123")) is False


def test_a_running_instance_still_exists():
    client = FakeClient(
        describe_instances={
            "Reservations": [{"Instances": [{"State": {"Name": "running"}}]}]
        }
    )
    assert ec2(client).exists(entry("ec2-instance", "i-123")) is True


# --------------------------------------------------------------------------
# Coverage
# --------------------------------------------------------------------------


def test_every_adapter_declares_its_kinds():
    for adapter in default_adapters():
        assert adapter.kinds, f"{type(adapter).__name__} declares no kinds"


def test_the_adapter_set_covers_every_kind_the_controllers_create():
    """A kind with no adapter blocks cleanup completion, so the two must stay in step.

    The reconciler reports an uncovered kind as `unownedKinds` and refuses to call the
    cleanup done -- correct, but the fix belongs here rather than at 3am.
    """
    covered: set[str] = set()
    for adapter in default_adapters():
        covered.update(adapter.kinds)
    # Every resource kind any adapter is expected to create for the three required
    # targets. Adding a kind to a controller without adding cleanup fails this.
    required = {
        "sagemaker-endpoint",
        "sagemaker-endpoint-config",
        "sagemaker-model",
        "bedrock-imported-model",
        "ec2-instance",
    }
    assert required <= covered, f"no cleanup adapter for {sorted(required - covered)}"


def test_no_adapter_searches_the_account_by_name():
    """Identity must come from the ledger, never from a pattern scan.

    This account holds EC2 instances and SageMaker models EDDIE did not create. An
    adapter that listed and matched names could delete them.
    """
    import inspect

    from deploy.adapters import aws_cleanup

    source = inspect.getsource(aws_cleanup)
    for forbidden in ("list_endpoints", "list_models", "list_imported_models"):
        assert forbidden not in source, f"{forbidden} would search rather than target"
    # `describe_instances` with a client-token filter is allowed and necessary: EC2
    # names its own instances, so recovering a lost launch is the only way to avoid
    # either leaking the instance or launching a second one. It targets one token, not
    # a name pattern.
    assert "client-token" in source


def test_a_same_named_sagemaker_resource_owned_by_someone_else_is_not_deleted():
    from deploy.adapters.aws_cleanup import UnsupportedScope
    client = FakeClient(
        describe_endpoint={"EndpointArn": "arn:aws:sagemaker:us-east-1:123456789012:endpoint/eddie-dev-x"},
        list_tags={"Tags": [{"Key": "eddie:job", "Value": "another-job"}]},
    )
    with pytest.raises(UnsupportedScope):
        sm(client).delete(entry())
    assert "delete_endpoint" not in client.calls


def test_an_owned_endpoint_is_deleted_after_its_ownership_was_checked():
    client = FakeClient(
        describe_endpoint={"EndpointArn": "arn:aws:sagemaker:us-east-1:123456789012:endpoint/eddie-dev-x"},
        list_tags={"Tags": [{"Key": "eddie:job", "Value": "job-1"}]},
    )
    sm(client).delete(entry())
    assert client.calls == ["describe_endpoint", "list_tags", "delete_endpoint"]


def test_a_hidden_old_s3_version_is_still_counted_and_removed():
    from dataclasses import replace
    from deploy.adapters.artifact_cleanup import ModelArtifactsAdapter
    seen = []
    client = FakeClient(
        list_object_versions={"Versions": [{"Key": "models/eddie-dev/job-1/files/model.safetensors", "VersionId": "old-version"}],
                              "DeleteMarkers": [{"Key": "models/eddie-dev/job-1/files/model.safetensors", "VersionId": "marker"}]},
        delete_objects=lambda **kwargs: seen.append(kwargs) or {},
    )
    item = replace(entry("s3-model-artifacts", "s3://artifacts/models/eddie-dev/job-1/"), tags={"eddie:environment": "dev"})
    adapter = ModelArtifactsAdapter(bucket="artifacts", client_factory=lambda region: client)
    assert adapter.exists(item) is True
    adapter.delete(item)
    assert {row["VersionId"] for row in seen[0]["Delete"]["Objects"]} == {"old-version", "marker"}
