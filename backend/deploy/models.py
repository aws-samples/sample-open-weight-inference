"""Plan, approval, job, resource ledger.

The shared contract every execution target goes through: SageMaker real-time, Bedrock
Custom Model Import and the bounded single-node EC2 GPU profile. Target-specific work
lives in an adapter; everything here is common and is where the safety properties are.

Four ideas carry the weight.

**A plan is immutable and identified by its content.** `plan_hash` covers the target,
region, account, artifacts, resource envelope, budget and lifetime. Approval binds to
that hash, so changing any of it invalidates the approval rather than silently
executing something else. There is no "edit plan" -- there is a new plan.

**Approval is a fact about a person.** It records the authenticated subject, the
capability they held, the policy version in force, and when. The advisor cannot
approve: it has no capability, and `Approval` is only constructed from a verified
principal. SEC-08.

**Execution is idempotent on a deterministic key.** `execution_key` is derived from the
plan hash and the approval id, so a duplicate `deployment.start` -- a retried request,
a double-clicked button, a redelivered workflow event -- reconciles to the same job
instead of creating a second endpoint. OPS-02.

**Intent is recorded before the side effect.** A resource is written to the ledger with
`INTENDED` before the AWS call, and updated with its real identifier after. A crash
between the two leaves a reconcilable record rather than an orphan nobody owns.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from typing import Any, Optional

#: Bumped when the meaning of a plan or its checks changes. Approval records the
#: version in force, so evidence gathered under an older policy is identifiable.
POLICY_VERSION = "2026-09-15.1"

#: Plans expire. An approval that sat unused for a day was granted against prices,
#: quotas and grants that may have moved.
PLAN_TTL = timedelta(hours=4)
APPROVAL_TTL = timedelta(hours=1)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


class Target(str, Enum):
    """Execution targets. Mirrors solver.models.Target for the three required paths."""

    SAGEMAKER_REALTIME = "SAGEMAKER_REALTIME"
    BEDROCK_CMI = "BEDROCK_CMI"
    EC2_GPU = "EC2_GPU"
    BEDROCK_NATIVE = "BEDROCK_NATIVE"
    VENDOR_API = "VENDOR_API"


class PlanKind(str, Enum):
    DEPLOYMENT = "DEPLOYMENT"
    #: A bounded experiment that may run without measured performance evidence. Every
    #: pre-creation security control still applies; only the SLO evidence is waived.
    TRIAL = "TRIAL"
    INTEGRATION = "INTEGRATION"
    REPLACEMENT = "REPLACEMENT"
    DELETION = "DELETION"


class JobState(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    #: Created and reachable by a test identity, but not published for ordinary
    #: callers: post-creation security and readiness checks have not passed.
    EXPERIMENTAL = "EXPERIMENTAL"
    READY = "READY"
    FAILED = "FAILED"
    DELETING = "DELETING"
    DELETED = "DELETED"
    #: Cleanup did not finish. Stays owned and open rather than being forgotten.
    CLEANUP_INCOMPLETE = "CLEANUP_INCOMPLETE"

    @property
    def terminal(self) -> bool:
        """No further reconciliation is needed.

        Only DELETED qualifies, and that is deliberate. READY is *not* terminal: a
        ready deployment has a live endpoint with a lifetime to enforce, and treating
        it as finished meant the reconciler never looked at the one state that is
        definitely costing money. FAILED is not terminal either -- a job can fail
        holding half-created resources, and it stays in view until cleanup has
        confirmed they are gone.
        """
        return self is JobState.DELETED

    @property
    def billable(self) -> bool:
        """States in which AWS may still be charging for something."""
        return self in (
            JobState.RUNNING,
            JobState.EXPERIMENTAL,
            JobState.READY,
            JobState.DELETING,
            JobState.CLEANUP_INCOMPLETE,
        )


class ResourceState(str, Enum):
    #: Written before the AWS call. A record in this state after a crash is the whole
    #: reason the ledger is written first.
    INTENDED = "INTENDED"
    CREATED = "CREATED"
    DELETING = "DELETING"
    DELETED = "DELETED"
    #: We asked AWS to delete it and could not confirm. Never treated as deleted:
    #: an accepted delete call does not prove billing stopped.
    DELETE_UNCONFIRMED = "DELETE_UNCONFIRMED"
    #: Deliberately kept, with an owner and a continuing cost.
    RETAINED = "RETAINED"


class CheckStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    UNKNOWN = "UNKNOWN"
    NOT_APPLICABLE = "NOT_APPLICABLE"

    @property
    def blocking(self) -> bool:
        """UNKNOWN blocks. Missing evidence is not permission to proceed."""
        return self in (CheckStatus.FAIL, CheckStatus.UNKNOWN)


class Lifecycle(str, Enum):
    """Where a check runs. Some controls need a resource to exist first."""

    PRE_CREATION = "PRE_CREATION"
    POST_CREATION = "POST_CREATION"
    PRE_PUBLISH = "PRE_PUBLISH"
    OPERATION = "OPERATION"


# --------------------------------------------------------------------------
# Envelope
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ResourceEnvelope:
    """The hard bounds execution may not exceed. OPS-01.

    Every field is a ceiling checked before allocation, not a hint. Exceeding one is a
    refusal that requires a revised plan, because "the agent decided it needed a bigger
    instance" is exactly the class of event this prevents.
    """

    instance_type: Optional[str] = None
    max_instance_count: int = 1
    max_concurrent_jobs: int = 1
    #: Total spend this plan may expose, setup plus running, over its lifetime.
    max_spend_usd: Decimal = Decimal("25")
    #: Wall-clock lifetime. The resource is torn down at expiry whether or not anyone
    #: is watching, by a reconciler that does not depend on the browser or the advisor.
    max_lifetime_minutes: int = 120
    #: Deadline for the deployment job itself, distinct from the resource lifetime.
    execution_deadline_minutes: int = 45
    max_storage_gb: int = 100
    max_retries: int = 3
    permitted_regions: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        return {
            "instanceType": self.instance_type,
            "maxInstanceCount": self.max_instance_count,
            "maxConcurrentJobs": self.max_concurrent_jobs,
            "maxSpendUsd": str(self.max_spend_usd),
            "maxLifetimeMinutes": self.max_lifetime_minutes,
            "executionDeadlineMinutes": self.execution_deadline_minutes,
            "maxStorageGb": self.max_storage_gb,
            "maxRetries": self.max_retries,
            "permittedRegions": list(self.permitted_regions),
        }


@dataclass(frozen=True)
class Artifact:
    """A pinned input. A mutable reference is not an artifact.

    `digest` is a content identity: a Hugging Face commit, an image digest, an S3
    version id. `uri` alone is insufficient, because `:latest` or a branch name can
    point at different bytes tomorrow than at approval time.
    """

    kind: str  # weights | image | model-package | config
    uri: str
    digest: Optional[str] = None
    #: Set when the digest is not yet known because a build has not run. SEC-08 is
    #: explicit that an unknown output digest must not be demanded before authorizing
    #: the build that produces it; the produced digest is recorded in the receipt and
    #: matched against these approved inputs.
    produced_by_build: bool = False
    scan_status: Optional[str] = None

    @property
    def pinned(self) -> bool:
        return bool(self.digest) or self.produced_by_build

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "uri": self.uri,
            "digest": self.digest,
            "producedByBuild": self.produced_by_build,
            "scanStatus": self.scan_status,
        }


@dataclass(frozen=True)
class Check:
    """One control outcome, in the shape the verification contract requires."""

    check_id: str
    status: CheckStatus
    lifecycle: Lifecycle
    expected: str
    observed: str
    required: bool = True
    evidence_ref: Optional[str] = None
    checked_at: str = field(default_factory=lambda: _iso(_now()))

    def to_json(self) -> dict[str, Any]:
        return {
            "checkId": self.check_id,
            "status": self.status.value,
            "lifecycleBoundary": self.lifecycle.value,
            "expectedControl": self.expected,
            "observedResult": self.observed,
            "required": self.required,
            "redactedEvidenceRef": self.evidence_ref,
            "checkedAt": self.checked_at,
            "policyVersion": POLICY_VERSION,
        }


def blocking_checks(checks: tuple[Check, ...], lifecycle: Lifecycle) -> tuple[Check, ...]:
    """Required checks at this boundary that are FAIL or UNKNOWN.

    UNKNOWN counts. A control we could not evaluate has not passed, and the contract
    is explicit that missing tools, denied permissions and timeouts never become a
    pass.
    """
    return tuple(
        c
        for c in checks
        if c.lifecycle is lifecycle and c.required and c.status.blocking
    )


# --------------------------------------------------------------------------
# Plan
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Plan:
    """An immutable, content-addressed intention to create inference resources."""

    plan_id: str
    kind: PlanKind
    target: Target
    project_id: str
    account_id: str
    region: str
    #: Who prepared it. Not authority to execute: that is the approval.
    created_by: str
    created_at: str
    recipe_id: str
    recipe_version: str
    model_ref: str
    artifacts: tuple[Artifact, ...]
    envelope: ResourceEnvelope
    #: Identity of the evaluation this plan acts on, so a decision and its execution
    #: cannot drift apart.
    evaluated_request_hash: Optional[str] = None
    decision_outcome: Optional[str] = None
    #: Estimated cost, for review. Not a cap; the cap is `envelope.max_spend_usd`.
    estimated_setup_usd: Optional[Decimal] = None
    estimated_hourly_usd: Optional[Decimal] = None
    checks: tuple[Check, ...] = ()
    notes: tuple[str, ...] = ()
    policy_version: str = POLICY_VERSION
    expires_at: str = ""

    # ---- identity ------------------------------------------------------

    def hashable(self) -> dict[str, Any]:
        """Exactly the fields an approval is a promise about.

        Deliberately excludes `plan_id`, `created_at`, `checks` and `notes`. Two plans
        with identical substance hash the same, so re-preparing the same plan does not
        invalidate an approval; but changing a region, an artifact digest, an instance
        type or a spend ceiling does.
        """
        return {
            "kind": self.kind.value,
            "target": self.target.value,
            "projectId": self.project_id,
            "accountId": self.account_id,
            "region": self.region,
            "recipeId": self.recipe_id,
            "recipeVersion": self.recipe_version,
            "modelRef": self.model_ref,
            "artifacts": [a.to_json() for a in self.artifacts],
            "envelope": self.envelope.to_json(),
            "evaluatedRequestHash": self.evaluated_request_hash,
            "policyVersion": self.policy_version,
        }

    @property
    def plan_hash(self) -> str:
        payload = json.dumps(self.hashable(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()

    @property
    def expired(self) -> bool:
        if not self.expires_at:
            return False
        return _now() > datetime.fromisoformat(self.expires_at)

    @property
    def unpinned_artifacts(self) -> tuple[Artifact, ...]:
        return tuple(a for a in self.artifacts if not a.pinned)

    def blockers(self) -> tuple[Check, ...]:
        return blocking_checks(self.checks, Lifecycle.PRE_CREATION)

    @property
    def approvable(self) -> bool:
        """Whether this plan may be approved at all.

        A draft plan is allowed to *show* blockers -- that is how a user learns what is
        wrong -- but it cannot be approved while a required pre-creation control is
        failing or unevaluated.
        """
        return not self.expired and not self.blockers() and not self.unpinned_artifacts

    def to_json(self) -> dict[str, Any]:
        blockers = self.blockers()
        return {
            "planId": self.plan_id,
            "planHash": self.plan_hash,
            "kind": self.kind.value,
            "target": self.target.value,
            "projectId": self.project_id,
            "accountId": self.account_id,
            "region": self.region,
            "createdBy": self.created_by,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
            "expired": self.expired,
            "recipeId": self.recipe_id,
            "recipeVersion": self.recipe_version,
            "modelRef": self.model_ref,
            "artifacts": [a.to_json() for a in self.artifacts],
            "envelope": self.envelope.to_json(),
            "evaluatedRequestHash": self.evaluated_request_hash,
            "decisionOutcome": self.decision_outcome,
            "estimatedSetupUsd": (
                str(self.estimated_setup_usd)
                if self.estimated_setup_usd is not None
                else None
            ),
            "estimatedHourlyUsd": (
                str(self.estimated_hourly_usd)
                if self.estimated_hourly_usd is not None
                else None
            ),
            "checks": [c.to_json() for c in self.checks],
            "blockers": [c.to_json() for c in blockers],
            "approvable": self.approvable,
            "unpinnedArtifacts": [a.to_json() for a in self.unpinned_artifacts],
            "notes": list(self.notes),
            "policyVersion": self.policy_version,
        }


def new_plan(**kwargs: Any) -> Plan:
    """Build a plan with generated identity and expiry."""
    created = _now()
    kwargs.setdefault("plan_id", f"plan-{uuid.uuid4().hex[:16]}")
    kwargs.setdefault("created_at", _iso(created))
    kwargs.setdefault("expires_at", _iso(created + PLAN_TTL))
    return Plan(**kwargs)


# --------------------------------------------------------------------------
# Approval
# --------------------------------------------------------------------------


class ApprovalError(Exception):
    """An approval could not be granted or consumed."""

    def __init__(self, detail: str, code: str = "approval_invalid") -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code


@dataclass(frozen=True)
class Approval:
    """An authenticated actor's authorization of one exact plan.

    Constructed only by `approve`, from a verified subject and the capability they
    actually held. There is no path for the advisor to produce one: it has no
    capability set, and a payload cannot carry an approval because identity fields are
    stripped from payloads before a handler sees them.
    """

    approval_id: str
    plan_id: str
    plan_hash: str
    project_id: str
    #: The authenticated subject. Not a display name and not an email from a payload.
    approved_by_subject: str
    approved_by_username: str
    approved_capability: str
    approved_at: str
    expires_at: str
    policy_version: str
    #: Set once execution has consumed it. An approval is single-use, enforced by a
    #: conditional write, so a replayed start cannot spend it twice.
    consumed_by_job: Optional[str] = None

    @property
    def expired(self) -> bool:
        return _now() > datetime.fromisoformat(self.expires_at)

    def authorizes(self, plan: Plan) -> None:
        """Raise unless this approval authorizes exactly this plan, now."""
        if self.plan_id != plan.plan_id:
            raise ApprovalError(
                "This approval was granted for a different plan.", "plan_mismatch"
            )
        if self.plan_hash != plan.plan_hash:
            raise ApprovalError(
                "The plan changed after it was approved, so the approval no longer "
                "applies. Review and approve the revised plan.",
                "plan_modified",
            )
        if self.policy_version != plan.policy_version:
            raise ApprovalError(
                "The security policy changed after this approval. Review the plan "
                "again under the current policy.",
                "policy_changed",
            )
        if self.expired:
            raise ApprovalError(
                "This approval has expired. Review the plan and approve it again.",
                "approval_expired",
            )
        if self.consumed_by_job:
            raise ApprovalError(
                f"This approval was already used by job {self.consumed_by_job}.",
                "approval_consumed",
            )

    def to_json(self) -> dict[str, Any]:
        return {
            "approvalId": self.approval_id,
            "planId": self.plan_id,
            "planHash": self.plan_hash,
            "projectId": self.project_id,
            "approvedBySubject": self.approved_by_subject,
            "approvedByUsername": self.approved_by_username,
            "approvedCapability": self.approved_capability,
            "approvedAt": self.approved_at,
            "expiresAt": self.expires_at,
            "expired": self.expired,
            "policyVersion": self.policy_version,
            "consumedByJob": self.consumed_by_job,
        }


def approve(plan: Plan, *, subject: str, username: str, capability: str) -> Approval:
    """Authorize a plan, or refuse with a reason.

    The plan's own approvability is rechecked here rather than trusted from whenever it
    was rendered: a control that was passing when the page loaded may not be now.
    """
    if plan.expired:
        raise ApprovalError(
            "This plan has expired. Prepare it again so its prices, quotas and "
            "permissions are current.",
            "plan_expired",
        )
    blockers = plan.blockers()
    if blockers:
        names = ", ".join(c.check_id for c in blockers)
        raise ApprovalError(
            f"Security checks need attention before this can be approved: {names}.",
            "blocked_by_checks",
        )
    unpinned = plan.unpinned_artifacts
    if unpinned:
        names = ", ".join(a.uri for a in unpinned)
        raise ApprovalError(
            f"These inputs are not pinned to an exact version: {names}. An approval "
            f"has to be a promise about specific bytes.",
            "unpinned_artifact",
        )
    granted = _now()
    return Approval(
        approval_id=f"appr-{uuid.uuid4().hex[:16]}",
        plan_id=plan.plan_id,
        plan_hash=plan.plan_hash,
        project_id=plan.project_id,
        approved_by_subject=subject,
        approved_by_username=username,
        approved_capability=capability,
        approved_at=_iso(granted),
        expires_at=_iso(granted + APPROVAL_TTL),
        policy_version=plan.policy_version,
    )


# --------------------------------------------------------------------------
# Resource ledger
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class LedgerEntry:
    """One AWS resource EDDIE created, or intended to create.

    `intent_key` is deterministic, so a retried create reconciles to the same entry
    instead of provisioning a second resource. `state` distinguishes an accepted delete
    from a confirmed one, because an accepted delete does not prove billing stopped.
    """

    entry_id: str
    job_id: str
    project_id: str
    kind: str  # sagemaker-endpoint | sagemaker-model | imported-model | ec2-instance | ...
    intent_key: str
    state: ResourceState
    region: str
    #: Account the resource lives in. Cleanup verifies this matches the account it is
    #: operating in and refuses rather than checking the wrong one: a "not found" from
    #: the wrong account would otherwise read as confirmed absence.
    account_id: str = ""
    #: The real AWS identifier, known only after creation succeeds.
    physical_id: Optional[str] = None
    #: The name EDDIE *will* use, decided before the create call and written with the
    #: INTENDED row.
    #:
    #: This is the recoverable creation identity. Without it, a create whose response
    #: was lost leaves an entry with no identifier at all, and cleanup cannot ask AWS
    #: whether anything exists -- which previously meant "no identifier" was treated as
    #: "confirmed absent" while a real endpoint kept billing. For resources EDDIE
    #: names (SageMaker, Bedrock imports) this is the name to look up. For resources
    #: AWS names (EC2 instances) it is None, and recovery goes through the
    #: client-token/tag path instead.
    planned_name: Optional[str] = None
    #: Idempotency token passed to the create call, so a lost response can be
    #: reconciled to the resource it created rather than producing a second one.
    client_token: Optional[str] = None
    arn: Optional[str] = None
    parent_entry_id: Optional[str] = None
    created_at: str = field(default_factory=lambda: _iso(_now()))
    updated_at: str = field(default_factory=lambda: _iso(_now()))
    expires_at: Optional[str] = None
    #: Charges that continue after the primary resource is gone: EBS volumes, S3
    #: objects, ECR images, log groups.
    residual_cost_note: Optional[str] = None
    hourly_usd: Optional[Decimal] = None
    tags: dict[str, str] = field(default_factory=dict)

    @property
    def billable(self) -> bool:
        return self.state in (
            ResourceState.CREATED,
            ResourceState.DELETING,
            ResourceState.DELETE_UNCONFIRMED,
            ResourceState.RETAINED,
        )

    @property
    def lookup_id(self) -> Optional[str]:
        """What to ask AWS about.

        The real identifier when we have it, otherwise the name we intended to use. An
        entry with neither cannot be checked, and the reconciler must treat that as
        unresolved rather than absent.
        """
        return self.physical_id or self.planned_name

    def to_json(self) -> dict[str, Any]:
        return {
            "entryId": self.entry_id,
            "jobId": self.job_id,
            "projectId": self.project_id,
            "kind": self.kind,
            "intentKey": self.intent_key,
            "state": self.state.value,
            "region": self.region,
            "accountId": self.account_id,
            "physicalId": self.physical_id,
            "plannedName": self.planned_name,
            "clientToken": self.client_token,
            "arn": self.arn,
            "parentEntryId": self.parent_entry_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "expiresAt": self.expires_at,
            "residualCostNote": self.residual_cost_note,
            "hourlyUsd": str(self.hourly_usd) if self.hourly_usd is not None else None,
            "billable": self.billable,
            "tags": dict(self.tags),
        }


def intent_key(job_id: str, kind: str, name: str) -> str:
    """Deterministic identity for a create intent.

    Same job, same kind, same logical name -> same key, so a duplicate create attempt
    is recognised as the same intention rather than becoming a second resource.
    """
    return hashlib.sha256(f"{job_id}|{kind}|{name}".encode()).hexdigest()[:32]


# --------------------------------------------------------------------------
# Job
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class JobStep:
    name: str
    state: str  # PENDING | RUNNING | DONE | FAILED | SKIPPED
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    detail: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class Job:
    """Durable execution state. Survives the chat turn that started it."""

    job_id: str
    plan_id: str
    plan_hash: str
    approval_id: str
    project_id: str
    target: Target
    state: JobState
    execution_key: str
    started_by_subject: str
    created_at: str
    updated_at: str
    #: When the job itself must be abandoned, distinct from resource expiry.
    deadline_at: str = ""
    #: When the created resources must be gone.
    resource_expires_at: str = ""
    steps: tuple[JobStep, ...] = ()
    checks: tuple[Check, ...] = ()
    resources: tuple[LedgerEntry, ...] = ()
    attempts: int = 0
    failure_reason: Optional[str] = None
    invocation_receipt: Optional[dict[str, Any]] = None
    #: True once this job's concurrency slot has been given back.
    #:
    #: Recorded on the job because release must be idempotent *per job*. Two sweeps
    #: cleaning the same job previously decremented the counter twice, so another
    #: deployment still holding a slot had its reservation silently released.
    admission_released: bool = False
    #: The one interface a caller uses to reach the model, published only after
    #: required post-creation checks pass.
    published_route: Optional[str] = None

    @property
    def past_deadline(self) -> bool:
        if not self.deadline_at:
            return False
        return _now() > datetime.fromisoformat(self.deadline_at)

    @property
    def resources_expired(self) -> bool:
        if not self.resource_expires_at:
            return False
        return _now() > datetime.fromisoformat(self.resource_expires_at)

    @property
    def billable_resources(self) -> tuple[LedgerEntry, ...]:
        return tuple(r for r in self.resources if r.billable)

    def to_json(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "planId": self.plan_id,
            "planHash": self.plan_hash,
            "approvalId": self.approval_id,
            "projectId": self.project_id,
            "target": self.target.value,
            "state": self.state.value,
            "executionKey": self.execution_key,
            "startedBySubject": self.started_by_subject,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "deadlineAt": self.deadline_at,
            "resourceExpiresAt": self.resource_expires_at,
            "pastDeadline": self.past_deadline,
            "resourcesExpired": self.resources_expired,
            "steps": [s.to_json() for s in self.steps],
            "checks": [c.to_json() for c in self.checks],
            "resources": [r.to_json() for r in self.resources],
            "billableResourceCount": len(self.billable_resources),
            "attempts": self.attempts,
            "failureReason": self.failure_reason,
            "invocationReceipt": self.invocation_receipt,
            "admissionReleased": self.admission_released,
            "publishedRoute": self.published_route,
        }


def execution_key(plan_hash: str, approval_id: str) -> str:
    """Deterministic execution identity. OPS-02/SEC-08.

    Derived from the plan's content and the approval that authorized it, so:
      * a retried `deployment.start` maps to the existing job;
      * a redelivered workflow event maps to the existing job;
      * a *different* approval of the same plan is a different execution, which is
        correct -- approving again is a deliberate second authorization.
    """
    return hashlib.sha256(f"{plan_hash}|{approval_id}".encode()).hexdigest()[:32]


def new_job(
    plan: Plan, approval: Approval, *, subject: str
) -> Job:
    created = _now()
    return Job(
        job_id=f"job-{uuid.uuid4().hex[:16]}",
        plan_id=plan.plan_id,
        plan_hash=plan.plan_hash,
        approval_id=approval.approval_id,
        project_id=plan.project_id,
        target=plan.target,
        state=JobState.PENDING,
        execution_key=execution_key(plan.plan_hash, approval.approval_id),
        started_by_subject=subject,
        created_at=_iso(created),
        updated_at=_iso(created),
        deadline_at=_iso(
            created + timedelta(minutes=plan.envelope.execution_deadline_minutes)
        ),
        resource_expires_at=_iso(
            created + timedelta(minutes=plan.envelope.max_lifetime_minutes)
        ),
    )


def with_step(job: Job, name: str, state: str, detail: str = "") -> Job:
    """Append or update a step, keeping the job immutable."""
    now = _iso(_now())
    steps = list(job.steps)
    for index, step in enumerate(steps):
        if step.name == name:
            steps[index] = replace(
                step,
                state=state,
                detail=detail or step.detail,
                ended_at=now if state in ("DONE", "FAILED", "SKIPPED") else step.ended_at,
            )
            break
    else:
        steps.append(
            JobStep(
                name=name,
                state=state,
                started_at=now,
                ended_at=now if state in ("DONE", "FAILED", "SKIPPED") else None,
                detail=detail,
            )
        )
    return replace(job, steps=tuple(steps), updated_at=now)
