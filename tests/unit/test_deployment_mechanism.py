"""Plan, approval, admission and idempotency: the properties that stop bad execution.

SEC-08, OPS-01 and OPS-02. Each test here corresponds to a proof obligation in
docs/security-posture.md: concurrent starts, replay, changed artifacts, expiry,
oversubscription, and a duplicate create that must not become a second resource set.

These run against `InMemoryStore`, which reproduces the atomicity the DynamoDB store
gets from conditional writes. That is deliberate: the rules are what is being tested,
and testing them against a real table would make the concurrency cases slow and flaky
without making them more truthful. The DynamoDB conditional expressions are reviewed
separately, and nothing here is claimed as evidence that the deployed table behaves the
same -- that is a live obligation.
"""

from __future__ import annotations

import dataclasses
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest

from deploy.models import (
    Approval,
    ApprovalError,
    Artifact,
    Check,
    CheckStatus,
    JobState,
    LedgerEntry,
    Lifecycle,
    Plan,
    PlanKind,
    ResourceEnvelope,
    ResourceState,
    Target,
    approve,
    execution_key,
    intent_key,
    new_job,
    new_plan,
    with_step,
)
from deploy.store import (
    ConcurrencyLimitExceeded,
    InMemoryStore,
    NotFound,
)


def artifacts() -> tuple[Artifact, ...]:
    return (
        Artifact("weights", "hf://mistralai/Mistral-7B-Instruct-v0.3", digest="c170c708"),
        Artifact("image", "763104351884.dkr.ecr.us-east-1.amazonaws.com/tgi:2.4.0",
                 digest="sha256:aaa"),
    )


def make_plan(**overrides) -> Plan:
    base = dict(
        kind=PlanKind.DEPLOYMENT,
        target=Target.SAGEMAKER_REALTIME,
        project_id="user:alice",
        account_id="123456789012",
        region="us-east-1",
        created_by="alice",
        recipe_id="sagemaker-tgi-v1",
        recipe_version="1.0.0",
        model_ref="mistralai/Mistral-7B-Instruct-v0.3",
        artifacts=artifacts(),
        envelope=ResourceEnvelope(
            instance_type="ml.g5.2xlarge",
            max_spend_usd=Decimal("10"),
            max_lifetime_minutes=60,
        ),
    )
    base.update(overrides)
    return new_plan(**base)


def granted(plan: Plan) -> Approval:
    return approve(plan, subject="alice-sub", username="alice", capability="approve")


# --------------------------------------------------------------------------
# Plan identity
# --------------------------------------------------------------------------


def test_the_same_substance_hashes_the_same():
    """Re-preparing an identical plan must not invalidate an approval."""
    assert make_plan().plan_hash == make_plan().plan_hash


@pytest.mark.parametrize(
    "field,value",
    [
        ("region", "us-west-2"),
        ("account_id", "111111111111"),
        ("target", Target.EC2_GPU),
        ("recipe_version", "2.0.0"),
        ("model_ref", "meta-llama/Llama-3.1-8B-Instruct"),
        ("project_id", "user:bob"),
    ],
)
def test_changing_substance_changes_the_hash(field, value):
    original = make_plan()
    changed = dataclasses.replace(original, **{field: value})
    assert changed.plan_hash != original.plan_hash


def test_changing_an_artifact_digest_changes_the_hash():
    """Different bytes is a different plan, even at the same URI."""
    original = make_plan()
    swapped = dataclasses.replace(
        original,
        artifacts=(
            Artifact("weights", "hf://mistralai/Mistral-7B-Instruct-v0.3",
                     digest="DIFFERENT"),
            original.artifacts[1],
        ),
    )
    assert swapped.plan_hash != original.plan_hash


def test_raising_a_spend_or_size_ceiling_changes_the_hash():
    original = make_plan()
    bigger = dataclasses.replace(
        original,
        envelope=dataclasses.replace(original.envelope, max_spend_usd=Decimal("500")),
    )
    assert bigger.plan_hash != original.plan_hash
    scaled = dataclasses.replace(
        original,
        envelope=dataclasses.replace(original.envelope, instance_type="ml.p4d.24xlarge"),
    )
    assert scaled.plan_hash != original.plan_hash


def test_cosmetic_fields_do_not_change_the_hash():
    """Notes and check results are not promises; they must not churn the identity."""
    original = make_plan()
    annotated = dataclasses.replace(
        original,
        notes=("prepared from chat",),
        checks=(
            Check("x", CheckStatus.PASS, Lifecycle.PRE_CREATION, "e", "o"),
        ),
    )
    assert annotated.plan_hash == original.plan_hash


# --------------------------------------------------------------------------
# Approval
# --------------------------------------------------------------------------


def test_an_approval_binds_the_actor_and_the_plan():
    plan = make_plan()
    approval = granted(plan)
    assert approval.approved_by_subject == "alice-sub"
    assert approval.plan_hash == plan.plan_hash
    approval.authorizes(plan)


def test_a_modified_plan_invalidates_the_approval():
    plan = make_plan()
    approval = granted(plan)
    moved = dataclasses.replace(plan, region="eu-central-1")
    with pytest.raises(ApprovalError) as caught:
        approval.authorizes(moved)
    assert caught.value.code == "plan_modified"


def test_an_approval_for_another_plan_is_refused():
    approval = granted(make_plan())
    with pytest.raises(ApprovalError) as caught:
        approval.authorizes(make_plan())
    assert caught.value.code == "plan_mismatch"


def test_an_expired_approval_is_refused():
    plan = make_plan()
    approval = granted(plan)
    stale = dataclasses.replace(
        approval,
        expires_at=(
            dataclasses.replace(approval).approved_at
        ),
    )
    # Force expiry by setting the deadline into the past.
    from datetime import datetime, timezone

    past = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(
        timespec="seconds"
    )
    stale = dataclasses.replace(approval, expires_at=past)
    with pytest.raises(ApprovalError) as caught:
        stale.authorizes(plan)
    assert caught.value.code == "approval_expired"


def test_a_plan_with_a_failing_required_check_cannot_be_approved():
    plan = make_plan(
        checks=(
            Check(
                "SEC-04.private-networking",
                CheckStatus.FAIL,
                Lifecycle.PRE_CREATION,
                "workload subnets are private",
                "no VPC configured",
            ),
        )
    )
    assert not plan.approvable
    with pytest.raises(ApprovalError) as caught:
        granted(plan)
    assert caught.value.code == "blocked_by_checks"
    assert "SEC-04.private-networking" in caught.value.detail


def test_an_unknown_required_check_also_blocks_approval():
    """UNKNOWN is not permission. This is the whole point of the contract's wording."""
    plan = make_plan(
        checks=(
            Check(
                "SEC-07.image-scan",
                CheckStatus.UNKNOWN,
                Lifecycle.PRE_CREATION,
                "the deployed digest has scan results",
                "scanner did not respond",
            ),
        )
    )
    with pytest.raises(ApprovalError) as caught:
        granted(plan)
    assert caught.value.code == "blocked_by_checks"


def test_an_optional_failing_check_does_not_block():
    plan = make_plan(
        checks=(
            Check(
                "nice-to-have",
                CheckStatus.FAIL,
                Lifecycle.PRE_CREATION,
                "e",
                "o",
                required=False,
            ),
        )
    )
    assert plan.approvable
    granted(plan)


def test_a_post_creation_check_does_not_block_approval():
    """A control needing a live endpoint cannot be a precondition for creating it."""
    plan = make_plan(
        checks=(
            Check(
                "SEC-01.endpoint-requires-auth",
                CheckStatus.UNKNOWN,
                Lifecycle.POST_CREATION,
                "the endpoint refuses anonymous calls",
                "endpoint does not exist yet",
            ),
        )
    )
    assert plan.approvable


def test_an_unpinned_artifact_cannot_be_approved():
    plan = make_plan(
        artifacts=(Artifact("weights", "hf://org/model"),)  # no digest, no build
    )
    with pytest.raises(ApprovalError) as caught:
        granted(plan)
    assert caught.value.code == "unpinned_artifact"


def test_an_artifact_a_build_will_produce_is_approvable():
    """SEC-08: do not demand an output digest before authorizing the build."""
    plan = make_plan(
        artifacts=(
            Artifact("weights", "hf://mistralai/Mistral-7B-Instruct-v0.3",
                     digest="c170c708"),
            Artifact("image", "eddie/serving:built-here", produced_by_build=True),
        )
    )
    assert plan.approvable
    granted(plan)


def test_an_expired_plan_cannot_be_approved():
    from datetime import datetime, timezone

    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(
        timespec="seconds"
    )
    plan = dataclasses.replace(make_plan(), expires_at=past)
    assert plan.expired
    with pytest.raises(ApprovalError) as caught:
        granted(plan)
    assert caught.value.code == "plan_expired"


def test_a_policy_change_invalidates_the_approval():
    plan = make_plan()
    approval = granted(plan)
    under_new_policy = dataclasses.replace(plan, policy_version="2027-01-01.1")
    with pytest.raises(ApprovalError) as caught:
        approval.authorizes(under_new_policy)
    # The hash covers policy_version, so this surfaces as a modified plan; either code
    # is a refusal, which is what matters.
    assert caught.value.code in ("plan_modified", "policy_changed")


# --------------------------------------------------------------------------
# Idempotent execution
# --------------------------------------------------------------------------


def test_a_duplicate_start_returns_the_same_job():
    store = InMemoryStore()
    plan, approval = make_plan(), None
    approval = granted(plan)
    first, created_first = store.start_job(new_job(plan, approval, subject="alice-sub"))
    second, created_second = store.start_job(new_job(plan, approval, subject="alice-sub"))
    assert created_first is True
    assert created_second is False
    assert first.job_id == second.job_id


def test_concurrent_starts_create_exactly_one_job():
    """OPS-02: duplicate workflow delivery cannot create another resource set."""
    store = InMemoryStore()
    plan = make_plan()
    approval = granted(plan)

    def start():
        return store.start_job(new_job(plan, approval, subject="alice-sub"))

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda _: start(), range(32)))

    created = [job for job, was_created in results if was_created]
    assert len(created) == 1, f"{len(created)} jobs created for one approval"
    assert len({job.job_id for job, _ in results}) == 1


def test_a_second_approval_of_the_same_plan_is_a_distinct_execution():
    """Approving again is a deliberate second authorization, not a duplicate."""
    plan = make_plan()
    first, second = granted(plan), granted(plan)
    assert first.approval_id != second.approval_id
    assert execution_key(plan.plan_hash, first.approval_id) != execution_key(
        plan.plan_hash, second.approval_id
    )


def test_an_approval_can_only_be_consumed_once():
    store = InMemoryStore()
    plan = make_plan()
    approval = granted(plan)
    store.put_approval(approval)
    store.consume_approval(approval, "job-1")
    with pytest.raises(ApprovalError) as caught:
        store.consume_approval(approval, "job-2")
    assert caught.value.code == "approval_consumed"


def test_consuming_the_same_approval_for_the_same_job_is_idempotent():
    """A retry of the same job must not look like a replay."""
    store = InMemoryStore()
    plan = make_plan()
    approval = granted(plan)
    store.put_approval(approval)
    store.consume_approval(approval, "job-1")
    again = store.consume_approval(approval, "job-1")
    assert again.consumed_by_job == "job-1"


def test_concurrent_consumption_has_exactly_one_winner():
    store = InMemoryStore()
    plan = make_plan()
    approval = granted(plan)
    store.put_approval(approval)

    outcomes: list[str] = []

    def consume(index: int) -> None:
        try:
            store.consume_approval(approval, f"job-{index}")
            outcomes.append("won")
        except ApprovalError:
            outcomes.append("refused")

    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(consume, range(32)))

    assert outcomes.count("won") == 1, outcomes


# --------------------------------------------------------------------------
# Admission
# --------------------------------------------------------------------------


def test_admission_refuses_beyond_the_project_limit():
    store = InMemoryStore()
    store.admit("user:alice", limit=1, account_limit=10)
    with pytest.raises(ConcurrencyLimitExceeded) as caught:
        store.admit("user:alice", limit=1, account_limit=10)
    assert "limit of 1" in caught.value.detail


def test_admission_refuses_beyond_the_account_limit_across_projects():
    """Two projects must not each pass their own check and jointly exceed the account."""
    store = InMemoryStore()
    store.admit("user:alice", limit=5, account_limit=2)
    store.admit("user:bob", limit=5, account_limit=2)
    with pytest.raises(ConcurrencyLimitExceeded) as caught:
        store.admit("user:carol", limit=5, account_limit=2)
    assert "account limit" in caught.value.detail


def test_concurrent_admission_cannot_oversubscribe():
    """OPS-01's explicit proof obligation."""
    store = InMemoryStore()
    limit = 3
    admitted: list[bool] = []

    def attempt(_: int) -> None:
        try:
            store.admit("user:alice", limit=limit, account_limit=100)
            admitted.append(True)
        except ConcurrencyLimitExceeded:
            admitted.append(False)

    with ThreadPoolExecutor(max_workers=32) as pool:
        list(pool.map(attempt, range(64)))

    assert admitted.count(True) == limit, f"admitted {admitted.count(True)} of {limit}"
    assert store.active_count("user:alice") == limit


def test_releasing_a_slot_allows_another_deployment():
    store = InMemoryStore()
    store.admit("user:alice", limit=1, account_limit=10)
    store.release("user:alice")
    store.admit("user:alice", limit=1, account_limit=10)
    assert store.active_count("user:alice") == 1


def test_release_never_goes_negative():
    """A double release during interrupted cleanup must not create free capacity."""
    store = InMemoryStore()
    store.release("user:alice")
    store.release("user:alice")
    assert store.active_count("user:alice") == 0


def test_queued_work_holds_no_slot():
    """OPS-01: queued work allocates no GPU. Admission happens at start, not enqueue."""
    store = InMemoryStore()
    assert store.active_count() == 0
    plan = make_plan()
    approval = granted(plan)
    store.start_job(new_job(plan, approval, subject="alice-sub"))
    # Creating the job record alone reserves nothing; the controller admits explicitly.
    assert store.active_count() == 0


# --------------------------------------------------------------------------
# Project isolation in the store
# --------------------------------------------------------------------------


def test_a_plan_is_not_readable_from_another_project():
    store = InMemoryStore()
    plan = make_plan(project_id="user:alice")
    store.put_plan(plan)
    with pytest.raises(NotFound):
        store.get_plan("user:bob", plan.plan_id)
    assert store.get_plan("user:alice", plan.plan_id).plan_id == plan.plan_id


def test_listing_is_scoped_to_the_project():
    store = InMemoryStore()
    store.put_plan(make_plan(project_id="user:alice"))
    store.put_plan(make_plan(project_id="user:bob"))
    assert len(store.list_plans("user:alice")) == 1
    assert len(store.list_plans("user:bob")) == 1


def test_a_job_is_not_readable_from_another_project():
    store = InMemoryStore()
    plan = make_plan(project_id="user:alice")
    job, _ = store.start_job(new_job(plan, granted(plan), subject="alice-sub"))
    with pytest.raises(NotFound):
        store.get_job("user:bob", job.job_id)


# --------------------------------------------------------------------------
# Ledger
# --------------------------------------------------------------------------


def test_intent_is_deterministic_so_a_retry_reconciles():
    first = intent_key("job-1", "sagemaker-endpoint", "eddie-dev-mistral")
    second = intent_key("job-1", "sagemaker-endpoint", "eddie-dev-mistral")
    assert first == second
    assert first != intent_key("job-2", "sagemaker-endpoint", "eddie-dev-mistral")


def test_an_intended_resource_is_found_before_a_duplicate_create():
    """The record written before the AWS call is what makes a crash reconcilable."""
    store = InMemoryStore()
    key = intent_key("job-1", "sagemaker-endpoint", "eddie-dev-mistral")
    store.put_resource(
        LedgerEntry(
            entry_id="res-1",
            job_id="job-1",
            project_id="user:alice",
            kind="sagemaker-endpoint",
            intent_key=key,
            state=ResourceState.INTENDED,
            region="us-east-1",
        )
    )
    found = store.find_resource_by_intent(key)
    assert found is not None
    assert found.state is ResourceState.INTENDED
    assert found.physical_id is None


def test_an_accepted_delete_is_not_a_confirmed_one():
    """An accepted delete does not prove billing stopped, so it stays billable."""
    entry = LedgerEntry(
        entry_id="res-1",
        job_id="job-1",
        project_id="user:alice",
        kind="sagemaker-endpoint",
        intent_key="k",
        state=ResourceState.DELETE_UNCONFIRMED,
        region="us-east-1",
        physical_id="eddie-dev-mistral",
    )
    assert entry.billable
    assert dataclasses.replace(entry, state=ResourceState.DELETED).billable is False


def test_a_retained_resource_stays_billable_and_owned():
    entry = LedgerEntry(
        entry_id="res-2",
        job_id="job-1",
        project_id="user:alice",
        kind="s3-staged-weights",
        intent_key="k2",
        state=ResourceState.RETAINED,
        region="us-east-1",
        residual_cost_note="14.96 GiB of staged weights, ~$0.34/month",
    )
    assert entry.billable
    assert entry.residual_cost_note


def test_billable_inventory_spans_jobs():
    store = InMemoryStore()
    for index, state in enumerate(
        [ResourceState.CREATED, ResourceState.DELETED, ResourceState.RETAINED]
    ):
        store.put_resource(
            LedgerEntry(
                entry_id=f"res-{index}",
                job_id=f"job-{index}",
                project_id="user:alice",
                kind="sagemaker-endpoint",
                intent_key=f"k{index}",
                state=state,
                region="us-east-1",
            )
        )
    billable = store.all_billable_resources()
    assert {e.state for e in billable} == {
        ResourceState.CREATED,
        ResourceState.RETAINED,
    }


# --------------------------------------------------------------------------
# Job state
# --------------------------------------------------------------------------


def test_a_job_records_both_deadlines():
    plan = make_plan(
        envelope=ResourceEnvelope(
            instance_type="ml.g5.2xlarge",
            execution_deadline_minutes=30,
            max_lifetime_minutes=90,
        )
    )
    job = new_job(plan, granted(plan), subject="alice-sub")
    assert job.deadline_at and job.resource_expires_at
    assert job.deadline_at < job.resource_expires_at
    assert not job.past_deadline


def test_a_browser_disconnect_does_not_remove_the_deadline():
    """The deadline is durable state, not a client-side timer."""
    plan = make_plan()
    job = new_job(plan, granted(plan), subject="alice-sub")
    store = InMemoryStore()
    store.put_job(job)
    reloaded = store.get_job(job.project_id, job.job_id)
    assert reloaded.deadline_at == job.deadline_at


def test_states_that_may_still_be_charging_are_marked_billable():
    for state in (
        JobState.RUNNING,
        JobState.EXPERIMENTAL,
        JobState.READY,
        JobState.DELETING,
        JobState.CLEANUP_INCOMPLETE,
    ):
        assert state.billable, state
    for state in (JobState.PENDING, JobState.DELETED, JobState.FAILED):
        assert not state.billable, state


def test_cleanup_incomplete_is_not_terminal():
    """Failed cleanup stays open and owned rather than being closed as done."""
    assert not JobState.CLEANUP_INCOMPLETE.terminal
    assert JobState.DELETED.terminal


def test_steps_accumulate_and_update_in_place():
    plan = make_plan()
    job = new_job(plan, granted(plan), subject="alice-sub")
    job = with_step(job, "resolve-artifacts", "RUNNING")
    job = with_step(job, "resolve-artifacts", "DONE", "2 artifacts pinned")
    job = with_step(job, "create-model", "RUNNING")
    assert [s.name for s in job.steps] == ["resolve-artifacts", "create-model"]
    assert job.steps[0].state == "DONE"
    assert job.steps[0].ended_at is not None
    assert job.steps[1].ended_at is None


def test_a_route_is_not_published_by_default():
    """An unverified route must not be usable by ordinary callers."""
    plan = make_plan()
    job = new_job(plan, granted(plan), subject="alice-sub")
    assert job.published_route is None
    assert job.state is JobState.PENDING


# --------------------------------------------------------------------------
# Durable round trip
# --------------------------------------------------------------------------


def test_a_plan_survives_serialisation_with_its_hash_intact():
    """The property that makes durable approval possible.

    If a plan's hash changed across a store round trip, every approval would fail
    after a reload with `plan_modified` -- a confusing symptom for a serialisation bug.
    The deserialiser recomputes the hash and raises if it disagrees, so the failure is
    named at the boundary instead.
    """
    from deploy.store import _plan_from_document

    original = make_plan()
    rebuilt = _plan_from_document(original.to_json())
    assert rebuilt.plan_hash == original.plan_hash
    assert rebuilt.plan_id == original.plan_id
    assert rebuilt.envelope == original.envelope
    assert rebuilt.artifacts == original.artifacts


def test_a_tampered_stored_plan_is_rejected_on_load():
    """A document whose recorded hash does not match its content is refused."""
    from deploy.store import _plan_from_document

    document = make_plan().to_json()
    document["region"] = "us-west-2"  # substance changed, planHash left alone
    with pytest.raises(ValueError, match="did not survive its round trip"):
        _plan_from_document(document)


def test_decimal_money_survives_the_round_trip_exactly():
    """Serialised as a string, so a spend ceiling cannot drift through a float."""
    from deploy.store import _plan_from_document

    original = make_plan(
        envelope=ResourceEnvelope(
            instance_type="ml.g5.2xlarge", max_spend_usd=Decimal("12.34")
        ),
        estimated_hourly_usd=Decimal("1.515"),
    )
    rebuilt = _plan_from_document(original.to_json())
    assert rebuilt.envelope.max_spend_usd == Decimal("12.34")
    assert rebuilt.estimated_hourly_usd == Decimal("1.515")


def test_an_approval_survives_serialisation():
    from deploy.store import _approval_from_document

    plan = make_plan()
    original = granted(plan)
    rebuilt = _approval_from_document(original.to_json())
    assert rebuilt == original
    rebuilt.authorizes(plan)


def test_a_consumed_approval_stays_consumed_across_a_reload():
    from deploy.store import _approval_from_document

    plan = make_plan()
    consumed = dataclasses.replace(granted(plan), consumed_by_job="job-1")
    rebuilt = _approval_from_document(consumed.to_json())
    assert rebuilt.consumed_by_job == "job-1"
    with pytest.raises(ApprovalError) as caught:
        rebuilt.authorizes(plan)
    assert caught.value.code == "approval_consumed"


def test_a_job_survives_serialisation_with_steps_and_resources():
    from deploy.store import _job_from_document

    plan = make_plan()
    job = new_job(plan, granted(plan), subject="alice-sub")
    job = with_step(job, "resolve-artifacts", "DONE", "2 pinned")
    job = dataclasses.replace(
        job,
        state=JobState.EXPERIMENTAL,
        resources=(
            LedgerEntry(
                entry_id="res-1",
                job_id=job.job_id,
                project_id=job.project_id,
                kind="sagemaker-endpoint",
                intent_key="k",
                state=ResourceState.CREATED,
                region="us-east-1",
                physical_id="eddie-dev-mistral",
                hourly_usd=Decimal("1.515"),
            ),
        ),
        checks=(
            Check("SEC-01.endpoint-auth", CheckStatus.PASS, Lifecycle.POST_CREATION,
                  "endpoint refuses anonymous", "refused"),
        ),
    )
    rebuilt = _job_from_document(job.to_json())
    assert rebuilt.state is JobState.EXPERIMENTAL
    assert rebuilt.execution_key == job.execution_key
    assert [s.name for s in rebuilt.steps] == ["resolve-artifacts"]
    assert rebuilt.resources[0].physical_id == "eddie-dev-mistral"
    assert rebuilt.resources[0].hourly_usd == Decimal("1.515")
    assert rebuilt.checks[0].status is CheckStatus.PASS
    assert len(rebuilt.billable_resources) == 1


def test_deadlines_survive_so_a_reloaded_job_is_still_bounded():
    from deploy.store import _job_from_document

    plan = make_plan()
    job = new_job(plan, granted(plan), subject="alice-sub")
    rebuilt = _job_from_document(job.to_json())
    assert rebuilt.deadline_at == job.deadline_at
    assert rebuilt.resource_expires_at == job.resource_expires_at


def test_an_artifact_awaiting_a_build_survives_as_such():
    """`produced_by_build` must not be lost, or the plan becomes unapprovable."""
    from deploy.store import _plan_from_document

    original = make_plan(
        artifacts=(
            Artifact("weights", "hf://org/model", digest="abc"),
            Artifact("image", "eddie/serving:built", produced_by_build=True),
        )
    )
    rebuilt = _plan_from_document(original.to_json())
    assert rebuilt.artifacts[1].produced_by_build is True
    assert rebuilt.approvable
    assert rebuilt.plan_hash == original.plan_hash


def test_a_ready_deployment_is_not_terminal():
    """A live endpoint is the state most certainly costing money.

    `terminal` once included READY, which meant the reconciler's open-job query
    excluded exactly the deployments with a running endpoint and a lifetime to enforce.
    Nothing would ever have expired.
    """
    assert not JobState.READY.terminal
    assert not JobState.FAILED.terminal, "a failed job can hold half-created resources"
    assert JobState.DELETED.terminal
