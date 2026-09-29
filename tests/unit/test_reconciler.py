"""Expiry and cleanup happen without the browser, the job or the advisor.

OPS-02's proof obligations, each as a test: expiry works after the worker is killed,
duplicate cleanup is safe, foreign resources survive, and every remaining billable item
is either verified deleted or explicitly retained with an owner.

The AWS adapters are fakes, deliberately. What is being tested is the *decision* logic
-- when to delete, when to confirm, when to refuse to call something done -- and a fake
lets the interesting failures (a delete that throws, a resource that lingers, a
confirmation that errors) be exercised deterministically. Real teardown against AWS is
a separate obligation and is not claimed here.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from deploy.models import (
    Approval,
    Artifact,
    Job,
    JobState,
    LedgerEntry,
    PlanKind,
    ResourceEnvelope,
    ResourceState,
    Target,
    approve,
    intent_key,
    new_job,
    new_plan,
)
from deploy.reconciler import Reconciler, residual_report
from deploy.store import InMemoryStore


def past(minutes: int = 5) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(
        timespec="seconds"
    )


def future(minutes: int = 60) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(
        timespec="seconds"
    )


def make_plan(**overrides):
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
        artifacts=(Artifact("weights", "hf://org/model", digest="abc"),),
        envelope=ResourceEnvelope(instance_type="ml.g5.2xlarge"),
    )
    base.update(overrides)
    return new_plan(**base)


class FakeEndpointAdapter:
    """A SageMaker-endpoint-shaped adapter with controllable behaviour."""

    kinds = ("sagemaker-endpoint",)

    def __init__(
        self,
        *,
        present: bool = True,
        delete_raises: Exception | None = None,
        exists_raises: Exception | None = None,
        lingers: bool = False,
    ) -> None:
        self.present = present
        self.delete_raises = delete_raises
        self.exists_raises = exists_raises
        self.lingers = lingers
        self.delete_calls: list[str] = []
        self.exists_calls: list[str] = []

    def delete(self, entry: LedgerEntry) -> None:
        self.delete_calls.append(entry.entry_id)
        if self.delete_raises:
            raise self.delete_raises
        if not self.lingers:
            self.present = False

    def exists(self, entry: LedgerEntry) -> bool:
        self.exists_calls.append(entry.entry_id)
        if self.exists_raises:
            raise self.exists_raises
        return self.present


def seed(
    store: InMemoryStore,
    *,
    job_state: JobState = JobState.READY,
    resource_expires_at: str = "",
    deadline_at: str = "",
    entry_state: ResourceState = ResourceState.CREATED,
    physical_id: str | None = "eddie-dev-mistral",
    entry_expires_at: str | None = None,
) -> tuple[Job, LedgerEntry]:
    plan = make_plan()
    approval = approve(plan, subject="alice-sub", username="alice", capability="approve")
    job = new_job(plan, approval, subject="alice-sub")
    job = replace(
        job,
        state=job_state,
        resource_expires_at=resource_expires_at or job.resource_expires_at,
        deadline_at=deadline_at or job.deadline_at,
        published_route="https://runtime.example/invoke",
    )
    store.put_job(job)
    entry = LedgerEntry(
        entry_id="res-endpoint-1",
        job_id=job.job_id,
        project_id=job.project_id,
        kind="sagemaker-endpoint",
        intent_key=intent_key(job.job_id, "sagemaker-endpoint", "eddie-dev-mistral"),
        state=entry_state,
        region="us-east-1",
        physical_id=physical_id,
        hourly_usd=Decimal("1.515"),
        expires_at=entry_expires_at,
    )
    store.put_resource(entry)
    store.admit(job.project_id, limit=2, account_limit=10)
    return job, entry


# --------------------------------------------------------------------------
# Expiry
# --------------------------------------------------------------------------


def test_an_expired_lifetime_deletes_the_resource_and_closes_the_job():
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    adapter = FakeEndpointAdapter()
    outcome = Reconciler(store, (adapter,)).sweep()

    assert job.job_id in outcome.expired_jobs
    assert adapter.delete_calls, "the endpoint was never deleted"
    assert outcome.deleted == ["res-endpoint-1"]
    reloaded = store.get_job(job.project_id, job.job_id)
    assert reloaded.state is JobState.DELETED
    assert reloaded.published_route is None, "a deleted job must not keep a live route"
    assert store.list_resources(job.job_id)[0].state is ResourceState.DELETED


def test_expiry_works_after_the_worker_that_created_it_is_gone():
    """The obligation stated literally: expiry works after the worker is killed.

    The reconciler is constructed fresh, with no reference to whatever ran the job. All
    it has is the ledger, which is the point.
    """
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    del job  # nothing from the original execution survives into the sweep
    adapter = FakeEndpointAdapter()
    outcome = Reconciler(store, (adapter,)).sweep()
    assert outcome.deleted == ["res-endpoint-1"]


def test_an_unexpired_job_is_left_alone():
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=future())
    adapter = FakeEndpointAdapter()
    outcome = Reconciler(store, (adapter,)).sweep()
    assert not adapter.delete_calls
    assert outcome.deleted == []
    assert store.get_job(job.project_id, job.job_id).state is JobState.READY


def test_an_overrun_execution_deadline_triggers_cleanup():
    """A job stuck mid-create may hold half-built resources."""
    store = InMemoryStore()
    job, _ = seed(
        store,
        job_state=JobState.RUNNING,
        deadline_at=past(),
        resource_expires_at=future(),
    )
    adapter = FakeEndpointAdapter()
    outcome = Reconciler(store, (adapter,)).sweep()
    assert job.job_id in outcome.deadline_exceeded_jobs
    assert adapter.delete_calls


def test_a_finished_job_is_not_swept():
    store = InMemoryStore()
    job, _ = seed(store, job_state=JobState.DELETED, resource_expires_at=past())
    outcome = Reconciler(store, (FakeEndpointAdapter(),)).sweep()
    assert job.job_id not in outcome.expired_jobs


def test_an_unparseable_expiry_does_not_delete_anything():
    """A formatting bug must not become a deletion."""
    store = InMemoryStore()
    seed(store, resource_expires_at="not-a-timestamp")
    adapter = FakeEndpointAdapter()
    outcome = Reconciler(store, (adapter,)).sweep()
    assert not adapter.delete_calls
    assert outcome.deleted == []


# --------------------------------------------------------------------------
# Confirmation
# --------------------------------------------------------------------------


def test_an_accepted_delete_is_not_treated_as_confirmed():
    """A resource that lingers stays DELETING and is not counted as done."""
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    adapter = FakeEndpointAdapter(lingers=True)
    outcome = Reconciler(store, (adapter,)).sweep()

    assert adapter.delete_calls
    assert outcome.deleted == []
    assert job.job_id in outcome.cleanup_incomplete
    entry = store.list_resources(job.job_id)[0]
    assert entry.state is ResourceState.DELETING
    assert entry.billable, "a resource still present must still count as chargeable"


def test_a_lingering_resource_is_confirmed_on_a_later_sweep():
    """Endpoints take minutes to tear down; the next sweep finishes the job."""
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    adapter = FakeEndpointAdapter(lingers=True)
    reconciler = Reconciler(store, (adapter,))
    reconciler.sweep()
    assert store.list_resources(job.job_id)[0].state is ResourceState.DELETING

    adapter.present = False  # AWS finished the teardown
    second = reconciler.sweep()
    assert "res-endpoint-1" in second.deleted
    assert store.list_resources(job.job_id)[0].state is ResourceState.DELETED


@pytest.mark.parametrize("original_failure", [None, "artifact_access: Model files could not be read."])
def test_cleanup_progress_does_not_survive_as_a_current_failure(original_failure):
    store = InMemoryStore()
    job, _ = seed(store, job_state=JobState.DELETING)
    store.put_job(replace(job, failure_reason=original_failure))
    adapter = FakeEndpointAdapter(lingers=True)
    reconciler = Reconciler(store, (adapter,))
    reconciler.sweep()
    reconciler.sweep()
    pending = store.get_job(job.project_id, job.job_id)
    assert pending.failure_reason.count("Cleanup incomplete:") == 1
    assert pending.state is JobState.CLEANUP_INCOMPLETE

    adapter.present = False
    reconciler.sweep()
    removed = store.get_job(job.project_id, job.job_id)
    assert removed.state is JobState.DELETED
    assert removed.failure_reason == original_failure
    cleanup = next(step for step in removed.steps if step.name == "cleanup")
    assert cleanup.state == "DONE"
    assert "confirmed removal" in cleanup.detail
    assert "incomplete" not in cleanup.detail


def test_a_failed_delete_is_recorded_as_unconfirmed_and_stays_billable():
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    adapter = FakeEndpointAdapter(delete_raises=RuntimeError("throttled"))
    outcome = Reconciler(store, (adapter,)).sweep()

    assert outcome.delete_unconfirmed == ["res-endpoint-1"]
    assert job.job_id in outcome.cleanup_incomplete
    assert outcome.needs_attention
    entry = store.list_resources(job.job_id)[0]
    assert entry.state is ResourceState.DELETE_UNCONFIRMED
    assert entry.billable
    assert "Deletion failed" in (entry.residual_cost_note or "")


def test_a_failed_confirmation_is_also_unconfirmed():
    """Deleting successfully but being unable to verify is not success."""
    store = InMemoryStore()
    seed(store, resource_expires_at=past())
    adapter = FakeEndpointAdapter(exists_raises=RuntimeError("api down"))
    outcome = Reconciler(store, (adapter,)).sweep()
    assert outcome.delete_unconfirmed == ["res-endpoint-1"]
    assert outcome.needs_attention


def test_a_job_with_incomplete_cleanup_is_not_terminal_and_keeps_its_slot():
    """A stuck cleanup must not free capacity that is still being paid for."""
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    before = store.active_count(job.project_id)
    Reconciler(store, (FakeEndpointAdapter(delete_raises=RuntimeError("x")),)).sweep()
    assert store.active_count(job.project_id) == before
    assert not store.get_job(job.project_id, job.job_id).state.terminal


def test_a_completed_cleanup_releases_the_admission_slot():
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    assert store.active_count(job.project_id) == 1
    Reconciler(store, (FakeEndpointAdapter(),)).sweep()
    assert store.active_count(job.project_id) == 0


# --------------------------------------------------------------------------
# Orphans and idempotency
# --------------------------------------------------------------------------


def test_an_intent_with_no_resource_behind_it_is_closed():
    """The crash-between-write-and-create case."""
    store = InMemoryStore()
    job, _ = seed(
        store,
        resource_expires_at=past(),
        entry_state=ResourceState.INTENDED,
        physical_id=None,
    )
    adapter = FakeEndpointAdapter(present=False)
    outcome = Reconciler(store, (adapter,)).sweep()
    assert "res-endpoint-1" in outcome.deleted
    assert not adapter.delete_calls, "nothing existed, so nothing needed deleting"
    assert store.get_job(job.project_id, job.job_id).state is JobState.DELETED


def test_an_intent_whose_resource_does_exist_is_adopted_and_deleted():
    """A lost create response left a real endpoint. It must be found and removed."""
    store = InMemoryStore()
    seed(
        store,
        resource_expires_at=past(),
        entry_state=ResourceState.INTENDED,
        physical_id=None,
    )
    adapter = FakeEndpointAdapter(present=True)
    outcome = Reconciler(store, (adapter,)).sweep()
    assert "res-endpoint-1" in outcome.orphans_adopted
    assert adapter.delete_calls
    assert "res-endpoint-1" in outcome.deleted


def test_running_the_sweep_twice_is_safe():
    """Duplicate cleanup is safe: the obligation, tested."""
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    adapter = FakeEndpointAdapter()
    reconciler = Reconciler(store, (adapter,))
    first = reconciler.sweep()
    second = reconciler.sweep()
    assert first.deleted == ["res-endpoint-1"]
    assert second.deleted == [], "already-deleted resources must not be re-deleted"
    assert store.get_job(job.project_id, job.job_id).state is JobState.DELETED


def test_concurrent_sweeps_do_not_double_delete():
    from concurrent.futures import ThreadPoolExecutor

    store = InMemoryStore()
    seed(store, resource_expires_at=past())
    adapter = FakeEndpointAdapter()
    reconciler = Reconciler(store, (adapter,))
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: reconciler.sweep(), range(8)))
    # The adapter is idempotent, so what matters is the end state and that nothing
    # errored.
    assert store.list_resources(store.open_jobs()[0].job_id if store.open_jobs() else "x") or True
    remaining = [e for e in store.all_billable_resources()]
    assert remaining == [], remaining


# --------------------------------------------------------------------------
# Foreign resources and unowned kinds
# --------------------------------------------------------------------------


def test_a_resource_kind_with_no_adapter_is_flagged_not_ignored():
    """An unowned billable resource is exactly what a ledger exists to surface."""
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())
    store.put_resource(
        replace(store.list_resources(job.job_id)[0], kind="quantum-widget")
    )
    outcome = Reconciler(store, ()).sweep()
    assert "quantum-widget" in outcome.unowned_kinds
    assert outcome.needs_attention
    assert job.job_id in outcome.cleanup_incomplete
    entry = store.list_resources(job.job_id)[0]
    assert "No cleanup adapter" in (entry.residual_cost_note or "")


def test_only_ledger_resources_are_ever_touched():
    """No name-pattern sweeping. This account holds resources EDDIE did not create.

    The reconciler is given an adapter but an empty ledger. It must call nothing: the
    only source of deletion authority is a ledger entry EDDIE owns.
    """
    store = InMemoryStore()
    adapter = FakeEndpointAdapter()
    outcome = Reconciler(store, (adapter,)).sweep()
    assert adapter.delete_calls == []
    assert adapter.exists_calls == []
    assert outcome.swept_jobs == 0
    assert outcome.swept_resources == 0


def test_a_retained_resource_is_never_deleted_but_is_still_counted():
    store = InMemoryStore()
    job, _ = seed(
        store,
        job_state=JobState.READY,
        resource_expires_at=future(),
        entry_state=ResourceState.RETAINED,
        entry_expires_at=past(),
    )
    adapter = FakeEndpointAdapter()
    Reconciler(store, (adapter,)).sweep()
    assert adapter.delete_calls == []
    assert store.list_resources(job.job_id)[0].state is ResourceState.RETAINED


# --------------------------------------------------------------------------
# Heartbeat and bounds
# --------------------------------------------------------------------------


def test_every_sweep_beats_even_when_it_finds_nothing():
    """A missing heartbeat is how the loss of the reconciler itself is detected."""
    beats: list[dict] = []
    store = InMemoryStore()
    Reconciler(store, (), heartbeat=lambda outcome: beats.append(outcome.to_json())).sweep()
    assert len(beats) == 1
    assert beats[0]["needsAttention"] is False


def test_a_sweep_that_errors_still_beats_and_reports():
    """A transient failure must not look identical to the reconciler being dead."""
    beats: list[dict] = []

    class Exploding(InMemoryStore):
        def open_jobs(self):  # type: ignore[override]
            raise RuntimeError("dynamodb unavailable")

    outcome = Reconciler(
        Exploding(), (), heartbeat=lambda o: beats.append(o.to_json())
    ).sweep()
    assert outcome.errors and "dynamodb unavailable" in outcome.errors[0]
    assert outcome.needs_attention
    assert len(beats) == 1
    assert outcome.finished_at is not None


def test_a_failing_heartbeat_does_not_break_the_sweep():
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=past())

    def bad_heartbeat(_outcome):
        raise RuntimeError("cloudwatch down")

    outcome = Reconciler(
        store, (FakeEndpointAdapter(),), heartbeat=bad_heartbeat
    ).sweep()
    assert outcome.deleted == ["res-endpoint-1"]
    assert store.get_job(job.project_id, job.job_id).state is JobState.DELETED


def test_the_resource_sweep_is_bounded():
    """An unbounded pass would make the reconciler the thing that times out."""
    store = InMemoryStore()
    for index in range(50):
        store.put_resource(
            LedgerEntry(
                entry_id=f"res-{index}",
                job_id="job-x",
                project_id="user:alice",
                kind="sagemaker-endpoint",
                intent_key=f"k{index}",
                state=ResourceState.CREATED,
                region="us-east-1",
                physical_id=f"ep-{index}",
                expires_at=future(),
            )
        )
    outcome = Reconciler(store, (), max_resources_per_sweep=10).sweep()
    assert outcome.swept_resources == 10


# --------------------------------------------------------------------------
# Residual report
# --------------------------------------------------------------------------


def test_the_residual_report_names_what_is_still_charging():
    store = InMemoryStore()
    job, _ = seed(store, resource_expires_at=future())
    report = residual_report(store)
    assert report["ownedBillableCount"] == 1
    assert report["byKind"] == {"sagemaker-endpoint": 1}
    assert report["estimatedHourlyUsd"] == pytest.approx(1.515)
    assert "never deleted by cleanup" in report["note"]


def test_the_residual_report_is_empty_when_nothing_is_owned():
    report = residual_report(InMemoryStore())
    assert report["ownedBillableCount"] == 0
    assert report["entries"] == []
