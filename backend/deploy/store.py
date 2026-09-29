"""Durable state for plans, approvals, jobs, the resource ledger and admission.

Two properties are the reason this is not just a dict.

**Admission is atomic.** OPS-01 requires that concurrent users cannot oversubscribe a
project or the account. A read-then-write check cannot provide that: two requests can
both read "0 running" and both proceed. Admission is therefore a conditional increment
on a single counter item, and the condition failing *is* the refusal.

**Execution is idempotent.** OPS-02 and SEC-08 require that duplicate delivery, a
retried call or a stale worker cannot create a second resource set. `start_job` writes
the job under a deterministic `execution_key` with a "must not exist" condition; if it
exists, the existing job is returned instead of a new one being created.

Both are expressed against a small interface so the concurrency semantics can be
tested exhaustively in memory, and so DynamoDB is an implementation rather than a
prerequisite for reasoning about correctness. The in-memory store is used by tests; the
DynamoDB store is what runs.
"""

from __future__ import annotations

import threading
import copy
import time
import uuid
from contextlib import contextmanager
from dataclasses import replace
from typing import Any, Optional, Protocol

from .models import (
    Approval,
    ApprovalError,
    Job,
    JobState,
    LedgerEntry,
    Plan,
    ResourceEnvelope,
    ResourceState,
)


class ConcurrencyLimitExceeded(Exception):
    """Admission refused. Carries what the limit was, so the message is actionable."""

    def __init__(self, detail: str, code: str = "concurrency_limit") -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code


class SpendLimitExceeded(Exception):
    def __init__(self, detail: str, code: str = "spend_limit") -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code


#: Reconciliation index partitions. A row carries one of these only while a
#: reconciler needs to see it, and the attribute is removed when it does not -- a
#: sparse index keeps the sweep proportional to open work rather than to history.
RECONCILE_OPEN_JOB = "open-job"
RECONCILE_BILLABLE_RESOURCE = "billable-resource"


class NotFound(Exception):
    def __init__(self, detail: str, code: str = "not_found") -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code


class Store(Protocol):
    """What the controller needs from persistence."""

    def launch(self, plan: Plan, approval: Approval, job: Job, limit: int, account_limit: int) -> tuple[Job, bool]: ...
    def lease_job(self, job_id: str, seconds: int = 660): ...
    def request_deletion(self, project_id: str, job_id: str) -> Job: ...
    def put_plan(self, plan: Plan, review: Optional[dict[str, Any]] = None) -> None: ...
    def get_plan_review(self, project_id: str, plan_id: str) -> dict[str, Any]: ...
    def get_plan(self, project_id: str, plan_id: str) -> Plan: ...
    def list_plans(self, project_id: str) -> list[Plan]: ...

    def put_approval(self, approval: Approval) -> None: ...
    def get_approval(self, project_id: str, approval_id: str) -> Approval: ...
    def consume_approval(self, approval: Approval, job_id: str) -> Approval: ...

    def start_job(self, job: Job) -> tuple[Job, bool]: ...
    def put_job(self, job: Job) -> None: ...
    def get_job(self, project_id: str, job_id: str) -> Job: ...
    def get_job_by_execution_key(self, key: str) -> Optional[Job]: ...
    def list_jobs(self, project_id: str) -> list[Job]: ...

    def admit(self, project_id: str, limit: int, account_limit: int) -> None: ...
    def release(self, project_id: str) -> None: ...
    def release_for_job(self, job: Job) -> bool: ...

    def put_resource(self, entry: LedgerEntry) -> None: ...
    def list_resources(self, job_id: str) -> list[LedgerEntry]: ...
    def all_billable_resources(self) -> list[LedgerEntry]: ...
    def open_jobs(self) -> list[Job]: ...


# --------------------------------------------------------------------------
# In-memory
# --------------------------------------------------------------------------


class InMemoryStore:
    """Reference implementation with the same atomicity guarantees.

    A single lock stands in for DynamoDB's conditional writes. That is not how the real
    store works, but it gives the same observable semantics, which is what the tests
    are about: they exercise the *rules*, not the transport.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._plans: dict[tuple[str, str], Plan] = {}
        self._reviews: dict[tuple[str, str], dict[str, Any]] = {}
        self._approvals: dict[tuple[str, str], Approval] = {}
        self._jobs: dict[tuple[str, str], Job] = {}
        self._by_execution_key: dict[str, tuple[str, str]] = {}
        self._resources: dict[str, LedgerEntry] = {}
        self._active: dict[str, int] = {}
        self._leases: dict[str, tuple[str, float]] = {}
        self._invocations: dict[tuple[str, str], int] = {}

    def launch(self, plan: Plan, approval: Approval, job: Job, limit: int, account_limit: int) -> tuple[Job, bool]:
        """Admission, approval consumption and job creation are one commit."""
        with self._lock:
            existing = self._by_execution_key.get(job.execution_key)
            if existing:
                return self._jobs[existing], False
            persisted = self._plans.get((plan.project_id, plan.plan_id))
            granted = self._approvals.get((approval.project_id, approval.approval_id))
            if persisted != plan or granted is None:
                raise NotFound("The approved plan could not be read.")
            if not plan.approvable:
                raise ApprovalError("This plan must be prepared again.", "plan_expired_or_blocked")
            granted.authorizes(plan)
            active = self._active.get(job.project_id, 0)
            if active >= limit or sum(self._active.values()) >= account_limit:
                raise ConcurrencyLimitExceeded("The deployment limit is reached. Remove an existing test first.")
            self._active[job.project_id] = active + 1
            self._approvals[(approval.project_id, approval.approval_id)] = replace(granted, consumed_by_job=job.job_id)
            self._jobs[(job.project_id, job.job_id)] = job
            self._by_execution_key[job.execution_key] = (job.project_id, job.job_id)
            return job, True

    @contextmanager
    def lease_job(self, job_id: str, seconds: int = 660):
        token = str(uuid.uuid4())
        with self._lock:
            old = self._leases.get(job_id)
            acquired = old is None or old[1] < time.time()
            if acquired:
                self._leases[job_id] = (token, time.time() + seconds)
        try:
            yield acquired
        finally:
            with self._lock:
                if acquired and self._leases.get(job_id, (None,))[0] == token:
                    del self._leases[job_id]

    def request_deletion(self, project_id: str, job_id: str) -> Job:
        with self._lock:
            key = (project_id, job_id)
            if key not in self._jobs:
                raise NotFound("No such deployment in this project.")
            current = self._jobs[key]
            if current.state is not JobState.DELETED:
                self._jobs[key] = replace(current, state=JobState.DELETING)
            return self._jobs[key]

    def reserve_invocation(self, project_id: str, job_id: str, maximum: int = 100) -> None:
        with self._lock:
            key = (project_id, job_id)
            job = self._jobs.get(key)
            if not job or job.resources_expired or job.state not in (JobState.EXPERIMENTAL, JobState.READY):
                raise ValueError("This test is not accepting requests.")
            if self._invocations.get(key, 0) >= maximum:
                raise ValueError("This test has used its 100-request allowance.")
            self._invocations[key] = self._invocations.get(key, 0) + 1

    # ---- plans ---------------------------------------------------------

    def put_plan(self, plan: Plan, review: Optional[dict[str, Any]] = None) -> None:
        with self._lock:
            key = (plan.project_id, plan.plan_id)
            if key in self._plans and self._plans[key] != plan:
                raise ApprovalError("Prepared plans cannot be overwritten.", "plan_immutable")
            self._plans.setdefault(key, plan)
            self._reviews.setdefault(key, copy.deepcopy(review or {}))

    def get_plan_review(self, project_id: str, plan_id: str) -> dict[str, Any]:
        plan = self.get_plan(project_id, plan_id)
        with self._lock:
            review = copy.deepcopy(self._reviews.get((project_id, plan_id), {}))
        return {**review, "plan": plan.to_json()}

    def get_plan(self, project_id: str, plan_id: str) -> Plan:
        with self._lock:
            plan = self._plans.get((project_id, plan_id))
        if plan is None:
            # Same message whether it does not exist or belongs to another project, so
            # identifiers cannot be probed.
            raise NotFound("No such plan in this project.")
        return plan

    def list_plans(self, project_id: str) -> list[Plan]:
        with self._lock:
            return [p for (proj, _), p in self._plans.items() if proj == project_id]

    # ---- approvals -----------------------------------------------------

    def put_approval(self, approval: Approval) -> None:
        with self._lock:
            self._approvals.setdefault((approval.project_id, approval.approval_id), approval)

    def get_approval(self, project_id: str, approval_id: str) -> Approval:
        with self._lock:
            approval = self._approvals.get((project_id, approval_id))
        if approval is None:
            raise NotFound("No such approval in this project.")
        return approval

    def consume_approval(self, approval: Approval, job_id: str) -> Approval:
        """Mark single-use, atomically.

        The condition is "not already consumed". Two concurrent starts race here, and
        exactly one wins; the loser is told which job holds it rather than being
        allowed to create a parallel resource set.
        """
        key = (approval.project_id, approval.approval_id)
        with self._lock:
            current = self._approvals.get(key)
            if current is None:
                raise NotFound("No such approval in this project.")
            if current.consumed_by_job and current.consumed_by_job != job_id:
                raise ApprovalError(
                    f"This approval was already used by job "
                    f"{current.consumed_by_job}.",
                    "approval_consumed",
                )
            consumed = replace(current, consumed_by_job=job_id)
            self._approvals[key] = consumed
            return consumed

    # ---- jobs ----------------------------------------------------------

    def start_job(self, job: Job) -> tuple[Job, bool]:
        """Create the job, or return the existing one for this execution key.

        Returns `(job, created)`. `created is False` means this was a duplicate start
        and no new resources should be provisioned.
        """
        with self._lock:
            existing_key = self._by_execution_key.get(job.execution_key)
            if existing_key is not None:
                return self._jobs[existing_key], False
            self._jobs[(job.project_id, job.job_id)] = job
            self._by_execution_key[job.execution_key] = (job.project_id, job.job_id)
            return job, True

    def put_job(self, job: Job) -> None:
        with self._lock:
            key = (job.project_id, job.job_id)
            current = self._jobs.get(key)
            if current:
                if current.state is JobState.DELETED and job.state is not JobState.DELETED:
                    raise ValueError("A removed deployment cannot be restarted.")
                if current.state is JobState.DELETING and job.state not in (JobState.DELETED, JobState.CLEANUP_INCOMPLETE):
                    job = replace(job, state=JobState.DELETING)
                if current.admission_released:
                    job = replace(job, admission_released=True)
            self._jobs[key] = job

    def get_job(self, project_id: str, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get((project_id, job_id))
        if job is None:
            raise NotFound("No such deployment in this project.")
        return job

    def get_job_by_execution_key(self, key: str) -> Optional[Job]:
        with self._lock:
            located = self._by_execution_key.get(key)
            return self._jobs[located] if located else None

    def list_jobs(self, project_id: str) -> list[Job]:
        with self._lock:
            return [j for (proj, _), j in self._jobs.items() if proj == project_id]

    # ---- admission -----------------------------------------------------

    def admit(self, project_id: str, limit: int, account_limit: int) -> None:
        """Reserve one concurrency slot, atomically, or refuse.

        Both ceilings are checked in the same critical section. Checking the project
        limit and the account limit separately would let two projects each pass their
        own check and jointly exceed the account's.
        """
        with self._lock:
            project_active = self._active.get(project_id, 0)
            account_active = sum(self._active.values())
            if project_active >= limit:
                raise ConcurrencyLimitExceeded(
                    f"This project already has {project_active} deployment(s) running, "
                    f"which is its limit of {limit}. Wait for one to finish or delete "
                    f"it first."
                )
            if account_active >= account_limit:
                raise ConcurrencyLimitExceeded(
                    f"This EDDIE installation already has {account_active} deployment(s) "
                    f"running across all projects, which is the account limit of "
                    f"{account_limit}."
                )
            self._active[project_id] = project_active + 1

    def release(self, project_id: str) -> None:
        with self._lock:
            self._active[project_id] = max(0, self._active.get(project_id, 0) - 1)

    def release_for_job(self, job: Job) -> bool:
        """Give back this job's slot exactly once. Returns True if it did.

        Idempotent per job, and atomic with the flag that records it. `release` alone
        was not enough: two sweeps cleaning the same job decremented the counter twice,
        releasing a slot belonging to a different deployment that was still running.
        """
        with self._lock:
            key = (job.project_id, job.job_id)
            current = self._jobs.get(key, job)
            if current.admission_released:
                return False
            self._jobs[key] = replace(current, admission_released=True)
            self._active[job.project_id] = max(
                0, self._active.get(job.project_id, 0) - 1
            )
            return True

    def active_count(self, project_id: Optional[str] = None) -> int:
        with self._lock:
            if project_id is None:
                return sum(self._active.values())
            return self._active.get(project_id, 0)

    # ---- resources -----------------------------------------------------

    def put_resource(self, entry: LedgerEntry) -> None:
        with self._lock:
            self._resources[entry.entry_id] = entry

    def find_resource_by_intent(self, intent: str) -> Optional[LedgerEntry]:
        with self._lock:
            for entry in self._resources.values():
                if entry.intent_key == intent:
                    return entry
        return None

    def list_resources(self, job_id: str) -> list[LedgerEntry]:
        with self._lock:
            return [e for e in self._resources.values() if e.job_id == job_id]

    def all_billable_resources(self) -> list[LedgerEntry]:
        with self._lock:
            # INTENDED is included even though nothing is billing yet: a row written
            # before a create that then crashed is what the orphan sweep looks for.
            return [
                e
                for e in self._resources.values()
                if e.billable or e.state is ResourceState.INTENDED
            ]

    def open_jobs(self) -> list[Job]:
        with self._lock:
            return [j for j in self._jobs.values() if not j.state.terminal]


# --------------------------------------------------------------------------
# DynamoDB
# --------------------------------------------------------------------------


def _plan_from_document(doc: dict[str, Any]) -> Plan:
    """Rebuild a Plan from its stored JSON.

    Explicit rather than reflective. A generic decoder that silently skipped an
    unrecognised field would produce a plan whose hash differs from the one that was
    approved, and the approval check would then fail for a reason nobody could see.
    Missing required fields raise instead.
    """
    from decimal import Decimal as D

    from .models import Artifact, Check, CheckStatus, Lifecycle, PlanKind, Target

    def artifact(raw: dict[str, Any]) -> Artifact:
        return Artifact(
            kind=raw["kind"],
            uri=raw["uri"],
            digest=raw.get("digest"),
            produced_by_build=bool(raw.get("producedByBuild", False)),
            scan_status=raw.get("scanStatus"),
        )

    def check(raw: dict[str, Any]) -> Check:
        return Check(
            check_id=raw["checkId"],
            status=CheckStatus(raw["status"]),
            lifecycle=Lifecycle(raw["lifecycleBoundary"]),
            expected=raw.get("expectedControl", ""),
            observed=raw.get("observedResult", ""),
            required=bool(raw.get("required", True)),
            evidence_ref=raw.get("redactedEvidenceRef"),
            checked_at=raw.get("checkedAt", ""),
        )

    envelope_raw = doc["envelope"]
    envelope = ResourceEnvelope(
        instance_type=envelope_raw.get("instanceType"),
        max_instance_count=int(envelope_raw["maxInstanceCount"]),
        max_concurrent_jobs=int(envelope_raw["maxConcurrentJobs"]),
        max_spend_usd=D(str(envelope_raw["maxSpendUsd"])),
        max_lifetime_minutes=int(envelope_raw["maxLifetimeMinutes"]),
        execution_deadline_minutes=int(envelope_raw["executionDeadlineMinutes"]),
        max_storage_gb=int(envelope_raw["maxStorageGb"]),
        max_retries=int(envelope_raw["maxRetries"]),
        permitted_regions=tuple(envelope_raw.get("permittedRegions") or []),
    )
    plan = Plan(
        plan_id=doc["planId"],
        kind=PlanKind(doc["kind"]),
        target=Target(doc["target"]),
        project_id=doc["projectId"],
        account_id=doc["accountId"],
        region=doc["region"],
        created_by=doc["createdBy"],
        created_at=doc["createdAt"],
        recipe_id=doc["recipeId"],
        recipe_version=doc["recipeVersion"],
        model_ref=doc["modelRef"],
        artifacts=tuple(artifact(a) for a in doc.get("artifacts") or []),
        envelope=envelope,
        evaluated_request_hash=doc.get("evaluatedRequestHash"),
        decision_outcome=doc.get("decisionOutcome"),
        estimated_setup_usd=(
            D(str(doc["estimatedSetupUsd"]))
            if doc.get("estimatedSetupUsd") is not None
            else None
        ),
        estimated_hourly_usd=(
            D(str(doc["estimatedHourlyUsd"]))
            if doc.get("estimatedHourlyUsd") is not None
            else None
        ),
        checks=tuple(check(c) for c in doc.get("checks") or []),
        notes=tuple(doc.get("notes") or []),
        policy_version=doc.get("policyVersion", ""),
        expires_at=doc.get("expiresAt", ""),
    )
    # The stored hash is recomputed, not trusted. If a round trip changed the
    # substance, that must surface here rather than as a mysterious approval failure.
    stored = doc.get("planHash")
    if stored and stored != plan.plan_hash:
        raise ValueError(
            f"plan {plan.plan_id} did not survive its round trip: stored hash "
            f"{stored[:12]} but rebuilt {plan.plan_hash[:12]}"
        )
    return plan


def _approval_from_document(doc: dict[str, Any]) -> Approval:
    return Approval(
        approval_id=doc["approvalId"],
        plan_id=doc["planId"],
        plan_hash=doc["planHash"],
        project_id=doc["projectId"],
        approved_by_subject=doc["approvedBySubject"],
        approved_by_username=doc["approvedByUsername"],
        approved_capability=doc["approvedCapability"],
        approved_at=doc["approvedAt"],
        expires_at=doc["expiresAt"],
        policy_version=doc["policyVersion"],
        consumed_by_job=doc.get("consumedByJob"),
    )


def _resource_from_document(doc: dict[str, Any]) -> LedgerEntry:
    from decimal import Decimal as D

    return LedgerEntry(
        entry_id=doc["entryId"],
        job_id=doc["jobId"],
        project_id=doc["projectId"],
        kind=doc["kind"],
        intent_key=doc["intentKey"],
        state=ResourceState(doc["state"]),
        region=doc["region"],
        account_id=doc.get("accountId", ""),
        physical_id=doc.get("physicalId"),
        planned_name=doc.get("plannedName"),
        client_token=doc.get("clientToken"),
        arn=doc.get("arn"),
        parent_entry_id=doc.get("parentEntryId"),
        created_at=doc.get("createdAt", ""),
        updated_at=doc.get("updatedAt", ""),
        expires_at=doc.get("expiresAt"),
        residual_cost_note=doc.get("residualCostNote"),
        hourly_usd=(
            D(str(doc["hourlyUsd"])) if doc.get("hourlyUsd") is not None else None
        ),
        tags=dict(doc.get("tags") or {}),
    )


def _job_from_document(doc: dict[str, Any]) -> Job:
    from .models import Check, CheckStatus, JobStep, Lifecycle, Target

    return Job(
        job_id=doc["jobId"],
        plan_id=doc["planId"],
        plan_hash=doc["planHash"],
        approval_id=doc["approvalId"],
        project_id=doc["projectId"],
        target=Target(doc["target"]),
        state=JobState(doc["state"]),
        execution_key=doc["executionKey"],
        started_by_subject=doc["startedBySubject"],
        created_at=doc["createdAt"],
        updated_at=doc["updatedAt"],
        deadline_at=doc.get("deadlineAt", ""),
        resource_expires_at=doc.get("resourceExpiresAt", ""),
        steps=tuple(
            JobStep(
                name=s["name"],
                state=s["state"],
                started_at=s.get("startedAt"),
                ended_at=s.get("endedAt"),
                detail=s.get("detail", ""),
            )
            for s in doc.get("steps") or []
        ),
        checks=tuple(
            Check(
                check_id=c["checkId"],
                status=CheckStatus(c["status"]),
                lifecycle=Lifecycle(c["lifecycleBoundary"]),
                expected=c.get("expectedControl", ""),
                observed=c.get("observedResult", ""),
                required=bool(c.get("required", True)),
                evidence_ref=c.get("redactedEvidenceRef"),
                checked_at=c.get("checkedAt", ""),
            )
            for c in doc.get("checks") or []
        ),
        resources=tuple(_resource_from_document(r) for r in doc.get("resources") or []),
        attempts=int(doc.get("attempts", 0)),
        failure_reason=doc.get("failureReason"),
        invocation_receipt=doc.get("invocationReceipt"),
        admission_released=bool(doc.get("admissionReleased", False)),
        published_route=doc.get("publishedRoute"),
    )


class DynamoStore:
    """DynamoDB implementation.

    One table, keyed `pk`/`sk`. Plans and approvals use separate authority
    partitions, allowing IAM to deny workers any writes to those records. Jobs and
    resources are grouped for project and job reads. Conditional expressions provide
    the atomicity the in-memory store gets from a lock:

      * `start_job` uses `attribute_not_exists(pk)` on an execution-key item, so a
        duplicate start cannot create a second job.
      * `consume_approval` uses `attribute_not_exists(consumedByJob)`, so an approval
        is spent once.
      * `admit` uses `ADD` with a condition on the current count, so admission does not
        read-then-write.

    Serialisation is deliberately explicit rather than reflective: a field silently
    dropped by a generic encoder would be a field silently not enforced.
    """

    def __init__(self, table_name: str, region: str) -> None:
        import boto3

        self.table_name = table_name
        self._table = boto3.resource("dynamodb", region_name=region).Table(table_name)
        self._client = boto3.client("dynamodb", region_name=region)

    @staticmethod
    def _wire(item: dict[str, Any]) -> dict[str, Any]:
        from boto3.dynamodb.types import TypeSerializer
        serializer = TypeSerializer()
        return {key: serializer.serialize(value) for key, value in item.items()}

    @staticmethod
    def _job_item(job: Job) -> dict[str, Any]:
        item = {
            **DynamoStore._job_keys(job.project_id, job.job_id),
            "kind": "job", "state": job.state.value,
            "executionKey": job.execution_key, "document": job.to_json(),
        }
        if not job.state.terminal:
            item["reconcileClass"] = RECONCILE_OPEN_JOB
            item["expiresAt"] = min([d for d in (job.deadline_at, job.resource_expires_at) if d] or [job.updated_at])
        return item

    def launch(self, plan: Plan, approval: Approval, job: Job, limit: int, account_limit: int) -> tuple[Job, bool]:
        """One database transaction. A crash cannot spend approval or capacity alone."""
        from botocore.exceptions import ClientError
        from .models import _iso, _now
        existing = self.get_job_by_execution_key(job.execution_key)
        if existing:
            return existing, False
        if not plan.approvable:
            raise ApprovalError("This plan must be prepared again.", "plan_expired_or_blocked")
        approval.authorizes(plan)
        now = _iso(_now())
        tx = [
            {"ConditionCheck": {
                "TableName": self.table_name,
                "Key": self._wire(self._plan_keys(plan.project_id, plan.plan_id)),
                "ConditionExpression": "planHash = :hash AND #doc.expiresAt > :now",
                "ExpressionAttributeNames": {"#doc": "document"},
                "ExpressionAttributeValues": self._wire({":hash": plan.plan_hash, ":now": now}),
            }},
            {"Update": {
                "TableName": self.table_name,
                "Key": self._wire(self._approval_keys(approval.project_id, approval.approval_id)),
                "UpdateExpression": "SET consumedByJob = :job",
                "ConditionExpression": "attribute_exists(pk) AND attribute_not_exists(consumedByJob) AND #doc.planHash = :hash AND #doc.expiresAt > :now",
                "ExpressionAttributeNames": {"#doc": "document"},
                "ExpressionAttributeValues": self._wire({":job": job.job_id, ":hash": plan.plan_hash, ":now": now}),
            }},
            {"Put": {"TableName": self.table_name, "Item": self._wire({
                "pk": f"execution#{job.execution_key}", "sk": "job", "kind": "execution-key",
                "projectId": job.project_id, "jobId": job.job_id,
            }), "ConditionExpression": "attribute_not_exists(pk)"}},
            {"Put": {"TableName": self.table_name, "Item": self._wire(self._job_item(job)),
                     "ConditionExpression": "attribute_not_exists(pk)"}},
        ]
        for key, ceiling in ((f"project#{job.project_id}", limit), ("account", account_limit)):
            tx.append({"Update": {"TableName": self.table_name,
                "Key": self._wire({"pk": "admission", "sk": key}),
                "UpdateExpression": "ADD activeCount :one",
                "ConditionExpression": "attribute_not_exists(activeCount) OR activeCount < :limit",
                "ExpressionAttributeValues": self._wire({":one": 1, ":limit": ceiling}),
            }})
        try:
            self._client.transact_write_items(TransactItems=tx)
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            existing = self.get_job_by_execution_key(job.execution_key)
            if existing:
                return existing, False
            reasons = exc.response.get("CancellationReasons", [])
            if any(r.get("Code") == "ConditionalCheckFailed" for r in reasons[4:]):
                raise ConcurrencyLimitExceeded("The deployment limit is reached. Remove an existing test first.") from exc
            if any(r.get("Code") == "ConditionalCheckFailed" for r in reasons[:2]):
                raise ApprovalError("The plan or approval changed or expired. Prepare a new plan.", "approval_not_current") from exc
            raise
        return job, True

    @contextmanager
    def lease_job(self, job_id: str, seconds: int = 660):
        """Lease outlasts the Lambda's hard timeout; cleanup uses the same lock.

        Locks are separate rows so updating a job cannot drop a live lease. Lambda
        invocations are bounded to 600s and AWS requests have shorter timeouts.
        """
        from botocore.exceptions import ClientError
        token = str(uuid.uuid4())
        key = {"pk": f"worker-lock#{job_id}", "sk": "lease"}
        try:
            self._table.update_item(Key=key,
                UpdateExpression="SET leaseToken = :token, leaseUntil = :until",
                ConditionExpression="attribute_not_exists(leaseUntil) OR leaseUntil < :now",
                ExpressionAttributeValues={":token": token, ":until": int(time.time()) + seconds, ":now": int(time.time())})
            acquired = True
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            acquired = False
        try:
            yield acquired
        finally:
            if acquired:
                try:
                    self._table.delete_item(Key=key, ConditionExpression="leaseToken = :token",
                                            ExpressionAttributeValues={":token": token})
                except ClientError as exc:
                    if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                        raise

    def request_deletion(self, project_id: str, job_id: str) -> Job:
        current = self.get_job(project_id, job_id)
        if current.state is not JobState.DELETED:
            self._table.update_item(Key=self._job_keys(project_id, job_id),
                UpdateExpression="SET deleteRequested = :yes",
                ConditionExpression="attribute_exists(pk)", ExpressionAttributeValues={":yes": True})
        return self.get_job(project_id, job_id)

    def reserve_invocation(self, project_id: str, job_id: str, maximum: int = 100) -> None:
        from botocore.exceptions import ClientError
        from .models import _iso, _now
        try:
            self._table.update_item(Key=self._job_keys(project_id, job_id),
                UpdateExpression="ADD invocationCount :one",
                ConditionExpression="attribute_exists(pk) AND (#state = :trial OR #state = :ready) AND attribute_not_exists(deleteRequested) AND #doc.resourceExpiresAt > :now AND (attribute_not_exists(invocationCount) OR invocationCount < :max)",
                ExpressionAttributeNames={"#state": "state", "#doc": "document"},
                ExpressionAttributeValues={":one": 1, ":max": maximum, ":now": _iso(_now()),
                                           ":trial": JobState.EXPERIMENTAL.value, ":ready": JobState.READY.value})
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise ValueError("This test is expired, being removed, or has used its 100-request allowance.") from exc
            raise

    # Serialisation helpers -------------------------------------------------

    @staticmethod
    def _plan_keys(project_id: str, plan_id: str) -> dict[str, str]:
        return {"pk": f"authority-plan#{project_id}", "sk": f"plan#{plan_id}"}

    @staticmethod
    def _approval_keys(project_id: str, approval_id: str) -> dict[str, str]:
        return {"pk": f"authority-approval#{project_id}", "sk": f"approval#{approval_id}"}

    @staticmethod
    def _job_keys(project_id: str, job_id: str) -> dict[str, str]:
        return {"pk": f"project#{project_id}", "sk": f"job#{job_id}"}

    def put_plan(self, plan: Plan, review: Optional[dict[str, Any]] = None) -> None:
        from botocore.exceptions import ClientError
        try:
            self._table.put_item(Item={
                **self._plan_keys(plan.project_id, plan.plan_id), "kind": "plan",
                "planHash": plan.plan_hash, "document": plan.to_json(), "review": review or {},
            }, ConditionExpression="attribute_not_exists(pk)")
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            if self.get_plan(plan.project_id, plan.plan_id) != plan:
                raise ApprovalError("Prepared plans cannot be overwritten.", "plan_immutable") from exc

    def get_plan_review(self, project_id: str, plan_id: str) -> dict[str, Any]:
        item = self._get(self._plan_keys(project_id, plan_id))
        if item is None:
            raise NotFound("No such plan in this project.")
        plan = _plan_from_document(item["document"])
        return {**item.get("review", {}), "plan": plan.to_json()}

    def get_plan(self, project_id: str, plan_id: str) -> Plan:
        item = self._get(self._plan_keys(project_id, plan_id))
        if item is None:
            # Identical message whether absent or another project's, so an identifier
            # cannot be probed by comparing errors.
            raise NotFound("No such plan in this project.")
        return _plan_from_document(item["document"])

    def list_plans(self, project_id: str) -> list[Plan]:
        return [
            _plan_from_document(item["document"])
            for item in self._query_prefix(f"authority-plan#{project_id}", "plan#")
        ]

    def put_approval(self, approval: Approval) -> None:
        from botocore.exceptions import ClientError
        try:
            self._table.put_item(Item={
                **self._approval_keys(approval.project_id, approval.approval_id),
                "kind": "approval", "document": approval.to_json(),
            }, ConditionExpression="attribute_not_exists(pk)")
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            # The deterministic approval id is immutable, including its consumption.
            # A concurrent retry must read that record rather than reset it.

    def get_approval(self, project_id: str, approval_id: str) -> Approval:
        item = self._get(self._approval_keys(project_id, approval_id))
        if item is None:
            raise NotFound("No such approval in this project.")
        document = dict(item["document"])
        # `consumedByJob` is a top-level attribute so it can be the subject of a
        # conditional write; the document copy is only a convenience, so the attribute
        # wins if they ever disagree.
        if item.get("consumedByJob"):
            document["consumedByJob"] = item["consumedByJob"]
        return _approval_from_document(document)

    def consume_approval(self, approval: Approval, job_id: str) -> Approval:
        from botocore.exceptions import ClientError

        try:
            self._table.update_item(
                Key=self._approval_keys(approval.project_id, approval.approval_id),
                UpdateExpression="SET consumedByJob = :job",
                # Single-use, enforced by the database rather than by a prior read.
                ConditionExpression=(
                    "attribute_exists(pk) AND attribute_not_exists(consumedByJob)"
                ),
                ExpressionAttributeValues={":job": job_id},
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise ApprovalError(
                    "This approval has already been used.", "approval_consumed"
                ) from exc
            raise
        return replace(approval, consumed_by_job=job_id)

    def start_job(self, job: Job) -> tuple[Job, bool]:
        """Legacy job insertion remains atomic; admitted trials use launch instead."""
        from botocore.exceptions import ClientError
        try:
            self._client.transact_write_items(TransactItems=[
                {"Put": {"TableName": self.table_name, "Item": self._wire({
                    "pk": f"execution#{job.execution_key}", "sk": "job", "kind": "execution-key",
                    "projectId": job.project_id, "jobId": job.job_id,
                }), "ConditionExpression": "attribute_not_exists(pk)"}},
                {"Put": {"TableName": self.table_name, "Item": self._wire(self._job_item(job)),
                         "ConditionExpression": "attribute_not_exists(pk)"}},
            ])
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            existing = self.get_job_by_execution_key(job.execution_key)
            if existing is not None:
                return existing, False
            raise
        return job, True

    def put_job(self, job: Job) -> None:
        # Update only owned fields. Approval-release and delete-request flags survive
        # a worker writing an older document, instead of being lost to PutItem.
        item = self._job_item(job)
        names = {"#kind": "kind", "#state": "state", "#doc": "document"}
        values = {":kind": item["kind"], ":state": item["state"], ":key": job.execution_key,
                  ":doc": item["document"], ":deleted": JobState.DELETED.value}
        expression = "SET #kind = :kind, #state = :state, executionKey = :key, #doc = :doc"
        if not job.state.terminal:
            expression += ", reconcileClass = :class, expiresAt = :expires"
            values.update({":class": item["reconcileClass"], ":expires": item["expiresAt"]})
        else:
            expression += " REMOVE reconcileClass, expiresAt"
        self._table.update_item(Key=self._job_keys(job.project_id, job.job_id),
            UpdateExpression=expression,
            ConditionExpression="attribute_not_exists(#state) OR #state <> :deleted OR :state = :deleted",
            ExpressionAttributeNames=names, ExpressionAttributeValues=values)

    def get_job(self, project_id: str, job_id: str) -> Job:
        item = self._get(self._job_keys(project_id, job_id))
        if item is None:
            raise NotFound("No such deployment in this project.")
        return self._job_from_item(item)

    @staticmethod
    def _job_from_item(item: dict[str, Any]) -> Job:
        # The atomic flags are authoritative for list/read responses too. A stale
        # embedded document must not make a requested removal look cancelled.
        job = _job_from_document(item["document"])
        if item.get("admissionReleased"):
            job = replace(job, admission_released=True)
        if item.get("deleteRequested") and job.state is not JobState.DELETED:
            job = replace(job, state=JobState.DELETING)
        return job

    def get_job_by_execution_key(self, key: str) -> Optional[Job]:
        pointer = self._get({"pk": f"execution#{key}", "sk": "job"})
        if pointer is None:
            return None
        try:
            return self.get_job(pointer["projectId"], pointer["jobId"])
        except NotFound:
            # The pointer exists but the job row does not: a crash between the two
            # writes. Returning None here would invite a duplicate create, so the
            # caller is told to reconcile instead.
            raise NotFound(
                "A previous start recorded this execution but no job state was "
                "written. It needs reconciliation before retrying.",
                "reconciliation_required",
            ) from None

    def list_jobs(self, project_id: str) -> list[Job]:
        return [
            self._job_from_item(item)
            for item in self._query_prefix(f"project#{project_id}", "job#")
        ]

    def admit(self, project_id: str, limit: int, account_limit: int) -> None:
        """Legacy standalone admission. New execution uses launch's single transaction."""
        from botocore.exceptions import ClientError
        tx = []
        for key, ceiling in ((f"project#{project_id}", limit), ("account", account_limit)):
            tx.append({"Update": {"TableName": self.table_name,
                "Key": self._wire({"pk": "admission", "sk": key}),
                "UpdateExpression": "ADD activeCount :one",
                "ConditionExpression": "attribute_not_exists(activeCount) OR activeCount < :limit",
                "ExpressionAttributeValues": self._wire({":one": 1, ":limit": ceiling}),
            }})
        try:
            self._client.transact_write_items(TransactItems=tx)
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "TransactionCanceledException" and any(
                r.get("Code") == "ConditionalCheckFailed" for r in exc.response.get("CancellationReasons", [])
            ):
                raise ConcurrencyLimitExceeded("The project or account deployment limit is reached.") from exc
            raise

    def _release_updates(self, project_id: str) -> list[dict[str, Any]]:
        return [{"Update": {"TableName": self.table_name,
            "Key": self._wire({"pk": "admission", "sk": key}),
            "UpdateExpression": "ADD activeCount :minus",
            "ConditionExpression": "activeCount > :zero",
            "ExpressionAttributeValues": self._wire({":minus": -1, ":zero": 0}),
        }} for key in (f"project#{project_id}", "account")]

    def release_for_job(self, job: Job) -> bool:
        """The release flag and both counters change together, or none does."""
        from botocore.exceptions import ClientError
        tx = [{"Update": {"TableName": self.table_name,
            "Key": self._wire(self._job_keys(job.project_id, job.job_id)),
            "UpdateExpression": "SET admissionReleased = :yes",
            "ConditionExpression": "attribute_exists(pk) AND (attribute_not_exists(admissionReleased) OR admissionReleased = :no)",
            "ExpressionAttributeValues": self._wire({":yes": True, ":no": False}),
        }}] + self._release_updates(job.project_id)
        try:
            self._client.transact_write_items(TransactItems=tx)
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "TransactionCanceledException" and self.get_job(job.project_id, job.job_id).admission_released:
                return False
            raise
        return True

    def release(self, project_id: str) -> None:
        self._client.transact_write_items(TransactItems=self._release_updates(project_id))

    def put_resource(self, entry: LedgerEntry) -> None:
        item: dict[str, Any] = {
            "pk": f"job#{entry.job_id}",
            "sk": f"resource#{entry.entry_id}",
            "kind": "resource",
            "intentKey": entry.intent_key,
            "state": entry.state.value,
            "billable": entry.billable,
            "document": entry.to_json(),
        }
        # INTENDED counts as needing reconciliation even though nothing is billing yet:
        # a row written before a create that then crashed is exactly what the orphan
        # sweep exists to find.
        if entry.billable or entry.state is ResourceState.INTENDED:
            item["reconcileClass"] = RECONCILE_BILLABLE_RESOURCE
            item["expiresAt"] = entry.expires_at or entry.updated_at
        self._table.put_item(Item=item)

    def list_resources(self, job_id: str) -> list[LedgerEntry]:
        return [
            _resource_from_document(item["document"])
            for item in self._query_prefix(f"job#{job_id}", "resource#")
        ]

    def all_billable_resources(self) -> list[LedgerEntry]:
        """Every resource that may still be charging, across all projects.

        Queried through the reconciliation index rather than scanned. A reconciler that
        needed a full table scan would get slower as the installation grew, which is
        how expiry enforcement quietly stops happening.
        """
        return [
            _resource_from_document(item["document"])
            for item in self._query_index(RECONCILE_BILLABLE_RESOURCE)
        ]

    def open_jobs(self) -> list[Job]:
        """Jobs that are not finished, for deadline and expiry reconciliation."""
        return [
            _job_from_document(item["document"])
            for item in self._query_index(RECONCILE_OPEN_JOB)
        ]

    # ---- query helpers -------------------------------------------------

    def _get(self, key: dict[str, str]) -> Optional[dict[str, Any]]:
        response = self._table.get_item(Key=key, ConsistentRead=True)
        return response.get("Item")

    def _query_prefix(self, pk: str, sk_prefix: str) -> list[dict[str, Any]]:
        """All items under one partition with an sk prefix, paginated.

        Pagination is not optional: a truncated result would silently under-report
        resources, and an incomplete inventory must never look like a clean one.
        """
        from boto3.dynamodb.conditions import Key

        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(sk_prefix),
            "ConsistentRead": True,
        }
        while True:
            response = self._table.query(**kwargs)
            items.extend(response.get("Items", []))
            token = response.get("LastEvaluatedKey")
            if not token:
                return items
            kwargs["ExclusiveStartKey"] = token

    def _query_index(self, reconcile_class: str) -> list[dict[str, Any]]:
        from boto3.dynamodb.conditions import Key

        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "IndexName": "reconcile-index",
            "KeyConditionExpression": Key("reconcileClass").eq(reconcile_class),
        }
        while True:
            response = self._table.query(**kwargs)
            items.extend(response.get("Items", []))
            token = response.get("LastEvaluatedKey")
            if not token:
                return items
            kwargs["ExclusiveStartKey"] = token
