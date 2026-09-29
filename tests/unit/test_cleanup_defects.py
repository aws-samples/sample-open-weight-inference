"""Four reproduced defects, each as the reproduction that found it.

A reviewer built these against fake AWS clients on 16 September, after the scheduled
worker was deployed and I had called reconciliation closed. Every one would have left a
customer paying for something while the ledger said otherwise, and none was caught by
the earlier tests -- which passed because they only exercised the paths I had thought of.

  1. INTENDED with no physical id became DELETED with no AWS call at all.
  2. Cleanup used the worker's Region, not the entry's, so a not-found from the wrong
     Region read as confirmed absence.
  3. `_is_not_found` matched the substring "not found" anywhere in a message, so
     AccessDenied and transport errors established deletion.
  4. Two sweeps over one job released admission twice, freeing a slot belonging to a
     different deployment that was still running.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from deploy.adapters.aws_cleanup import (
    Ec2InstanceAdapter,
    SageMakerEndpointAdapter,
    UnknownIdentity,
    UnsupportedScope,
    is_not_found,
)
from deploy.models import (
    Artifact,
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
from deploy.reconciler import Reconciler
from deploy.store import InMemoryStore


def past(minutes: int = 5) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(
        timespec="seconds"
    )


def client_error(code: str, message: str) -> Exception:
    exc = Exception(message)
    exc.response = {"Error": {"Code": code, "Message": message}}  # type: ignore[attr-defined]
    return exc


class FakeClient:
    def __init__(self, **behaviour):
        self.behaviour = behaviour
        self.calls: list[tuple[str, dict]] = []

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append((name, kwargs))
            outcome = self.behaviour.get(name)
            if isinstance(outcome, Exception):
                raise outcome
            if callable(outcome):
                return outcome(**kwargs)
            return outcome if outcome is not None else {}

        return call


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
        model_ref="org/model",
        artifacts=(Artifact("weights", "hf://org/model", digest="abc"),),
        envelope=ResourceEnvelope(instance_type="ml.g5.2xlarge"),
    )
    base.update(overrides)
    return new_plan(**base)


def seeded_job(store: InMemoryStore, project_id: str = "user:alice"):
    plan = make_plan(project_id=project_id)
    approval = approve(plan, subject="s", username="u", capability="approve")
    job, _ = store.start_job(new_job(plan, approval, subject="s"))
    job = replace(job, state=JobState.READY, resource_expires_at=past())
    store.put_job(job)
    return job


# --------------------------------------------------------------------------
# Defect 1: missing identity treated as confirmed absence
# --------------------------------------------------------------------------


def test_an_intent_with_no_identity_at_all_is_not_declared_deleted():
    """AWS may have created the endpoint; the response was lost.

    The old behaviour marked this DELETED without asking AWS anything, because the
    adapter short-circuited on the absent physical id. A real endpoint would keep
    billing while the ledger reported it gone.
    """
    store = InMemoryStore()
    job = seeded_job(store)
    store.put_resource(
        LedgerEntry(
            entry_id="res-1",
            job_id=job.job_id,
            project_id=job.project_id,
            kind="sagemaker-endpoint",
            intent_key=intent_key(job.job_id, "sagemaker-endpoint", "x"),
            state=ResourceState.INTENDED,
            region="us-east-1",
            account_id="123456789012",
            physical_id=None,
            planned_name=None,  # nothing recoverable
        )
    )
    adapter = SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: FakeClient(),
    )
    outcome = Reconciler(store, (adapter,)).sweep()

    entry = store.list_resources(job.job_id)[0]
    assert entry.state is not ResourceState.DELETED, "absence was never established"
    assert entry.state is ResourceState.DELETE_UNCONFIRMED
    assert entry.billable
    assert "res-1" in outcome.delete_unconfirmed
    assert outcome.needs_attention


def test_a_planned_name_makes_a_lost_create_recoverable():
    """With the recoverable identity recorded, AWS is actually asked."""
    store = InMemoryStore()
    job = seeded_job(store)
    store.put_resource(
        LedgerEntry(
            entry_id="res-1",
            job_id=job.job_id,
            project_id=job.project_id,
            kind="sagemaker-endpoint",
            intent_key="k",
            state=ResourceState.INTENDED,
            region="us-east-1",
            account_id="123456789012",
            physical_id=None,
            planned_name="eddie-dev-mistral",
        )
    )
    client = FakeClient(
        describe_endpoint={"EndpointName": "eddie-dev-mistral", "EndpointArn": "arn:aws:sagemaker:us-east-1:123456789012:endpoint/eddie-dev-mistral"},
        list_tags={"Tags": [{"Key": "eddie:job", "Value": job.job_id}]},
    )
    adapter = SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: client,
    )
    outcome = Reconciler(store, (adapter,)).sweep()

    # It existed, so it was adopted and deleted rather than assumed absent.
    assert "res-1" in outcome.orphans_adopted
    assert any(name == "describe_endpoint" for name, _ in client.calls)
    assert any(name == "delete_endpoint" for name, _ in client.calls)


def test_the_adapter_refuses_rather_than_reporting_absence_without_identity():
    adapter = SageMakerEndpointAdapter(
        permitted_regions=("us-east-1",), client_factory=lambda region: FakeClient()
    )
    entry = LedgerEntry(
        entry_id="res-1",
        job_id="j",
        project_id="p",
        kind="sagemaker-endpoint",
        intent_key="k",
        state=ResourceState.INTENDED,
        region="us-east-1",
    )
    with pytest.raises(UnknownIdentity):
        adapter.exists(entry)


def test_an_ec2_instance_is_recovered_through_its_client_token():
    """EC2 names its own instances, so the token is the recoverable identity."""
    client = FakeClient(
        describe_instances=lambda **kwargs: (
            {
                "Reservations": [
                    {"Instances": [{"InstanceId": "i-recovered",
                                    "State": {"Name": "running"}}]}
                ]
            }
            if kwargs.get("Filters")
            else {"Reservations": [{"Instances": [{"InstanceId": "i-recovered",
                                                  "State": {"Name": "running"}}]}]}
        )
    )
    adapter = Ec2InstanceAdapter(
        permitted_regions=("us-east-1",), client_factory=lambda region: client
    )
    entry = LedgerEntry(
        entry_id="res-1",
        job_id="j",
        project_id="p",
        kind="ec2-instance",
        intent_key="k",
        state=ResourceState.INTENDED,
        region="us-east-1",
        physical_id=None,
        client_token="eddie-token-1",
    )
    assert adapter.exists(entry) is True
    adapter.delete(entry)
    assert any(name == "terminate_instances" for name, _ in client.calls)


def test_an_ec2_entry_with_neither_id_nor_token_refuses():
    adapter = Ec2InstanceAdapter(
        permitted_regions=("us-east-1",), client_factory=lambda region: FakeClient()
    )
    entry = LedgerEntry(
        entry_id="res-1", job_id="j", project_id="p", kind="ec2-instance",
        intent_key="k", state=ResourceState.INTENDED, region="us-east-1",
    )
    with pytest.raises(UnknownIdentity):
        adapter.exists(entry)


# --------------------------------------------------------------------------
# Defect 2: the entry's Region and account were ignored
# --------------------------------------------------------------------------


def test_a_resource_in_another_region_is_queried_in_that_region():
    """The client is built for the entry's Region, not the worker's."""
    regions_asked: list[str] = []

    def factory(region: str):
        regions_asked.append(region)
        return FakeClient(describe_endpoint={"EndpointName": "x"})

    adapter = SageMakerEndpointAdapter(
        permitted_regions=("us-east-1", "us-west-2"), client_factory=factory
    )
    entry = LedgerEntry(
        entry_id="res-1", job_id="j", project_id="p", kind="sagemaker-endpoint",
        intent_key="k", state=ResourceState.CREATED, region="us-west-2",
        physical_id="eddie-dev-x",
    )
    assert adapter.exists(entry) is True
    assert regions_asked == ["us-west-2"], regions_asked


def test_a_resource_outside_the_permitted_regions_is_not_declared_deleted():
    """The reproduction: a us-west-2 entry with a us-east-1 worker.

    Previously the us-east-1 client was asked, returned a legitimate not-found, and the
    entry was marked DELETED while the endpoint kept running in Oregon.
    """
    store = InMemoryStore()
    job = seeded_job(store)
    store.put_resource(
        LedgerEntry(
            entry_id="res-1",
            job_id=job.job_id,
            project_id=job.project_id,
            kind="sagemaker-endpoint",
            intent_key="k",
            state=ResourceState.CREATED,
            region="us-west-2",
            account_id="123456789012",
            physical_id="eddie-dev-oregon",
            hourly_usd=Decimal("1.515"),
        )
    )
    adapter = SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),  # worker only cleans us-east-1
        client_factory=lambda region: FakeClient(
            describe_endpoint=client_error(
                "ValidationException", "Could not find endpoint eddie-dev-oregon."
            )
        ),
    )
    outcome = Reconciler(store, (adapter,)).sweep()

    entry = store.list_resources(job.job_id)[0]
    assert entry.state is not ResourceState.DELETED
    assert entry.billable, "an endpoint in another Region is still charging"
    assert outcome.needs_attention
    assert job.job_id in outcome.cleanup_incomplete


def test_a_resource_in_another_account_is_refused():
    adapter = SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: FakeClient(),
    )
    entry = LedgerEntry(
        entry_id="res-1", job_id="j", project_id="p", kind="sagemaker-endpoint",
        intent_key="k", state=ResourceState.CREATED, region="us-east-1",
        account_id="111111111111", physical_id="eddie-dev-x",
    )
    with pytest.raises(UnsupportedScope, match="not"):
        adapter.exists(entry)


def test_an_entry_with_no_region_is_refused():
    adapter = SageMakerEndpointAdapter(
        permitted_regions=("us-east-1",), client_factory=lambda region: FakeClient()
    )
    entry = LedgerEntry(
        entry_id="res-1", job_id="j", project_id="p", kind="sagemaker-endpoint",
        intent_key="k", state=ResourceState.CREATED, region="",
        physical_id="eddie-dev-x",
    )
    with pytest.raises(UnsupportedScope):
        adapter.exists(entry)


# --------------------------------------------------------------------------
# Defect 3: "not found" anywhere in a message meant absence
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "code,message",
    [
        # The reproduction: an authorization failure whose message contains the phrase.
        ("AccessDeniedException",
         "User: arn:aws:sts::1:assumed-role/eddie/x is not authorized; role not found"),
        ("UnauthorizedOperation", "You are not authorized to perform this operation"),
        ("EndpointConnectionError", "Could not connect to the endpoint URL: host not found"),
        ("ThrottlingException", "Rate exceeded"),
        ("ServiceUnavailable", "not found in cache, try again"),
        ("ExpiredTokenException", "The security token included in the request is expired"),
        # A genuine validation error, not an absence.
        ("ValidationException", "1 validation error detected: value too long"),
    ],
)
def test_an_error_that_is_not_a_service_not_found_never_means_deleted(code, message):
    assert not is_not_found(
        client_error(code, message),
        codes=("ValidationException",),
        require_message=("could not find", "does not exist"),
    )


def test_a_genuine_sagemaker_absence_is_recognised():
    assert is_not_found(
        client_error("ValidationException", "Could not find endpoint eddie-dev-x."),
        codes=("ValidationException",),
        require_message=("could not find", "does not exist"),
    )


def test_a_code_with_no_message_requirement_is_enough():
    assert is_not_found(
        client_error("ResourceNotFoundException", "anything at all"),
        codes=("ResourceNotFoundException",),
    )


def test_an_exception_with_no_error_code_is_never_absence():
    """A bare Python exception -- a socket error, a bug -- proves nothing."""
    assert not is_not_found(
        RuntimeError("connection reset; endpoint not found"),
        codes=("ValidationException",),
        require_message=("not found",),
    )


def test_an_access_denied_confirmation_leaves_the_resource_billable():
    """End to end: the reconciler must not close on an authorization failure."""
    store = InMemoryStore()
    job = seeded_job(store)
    store.put_resource(
        LedgerEntry(
            entry_id="res-1", job_id=job.job_id, project_id=job.project_id,
            kind="sagemaker-endpoint", intent_key="k", state=ResourceState.CREATED,
            region="us-east-1", account_id="123456789012",
            physical_id="eddie-dev-x", hourly_usd=Decimal("1.515"),
        )
    )
    adapter = SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: FakeClient(
            delete_endpoint=client_error(
                "AccessDeniedException", "not authorized: endpoint not found"
            )
        ),
    )
    Reconciler(store, (adapter,)).sweep()
    entry = store.list_resources(job.job_id)[0]
    assert entry.state is ResourceState.DELETE_UNCONFIRMED
    assert entry.billable


# --------------------------------------------------------------------------
# Defect 4: admission released more than once per job
# --------------------------------------------------------------------------


def test_two_sweeps_over_one_job_release_admission_once():
    """The reproduction: 2 -> 1 -> 0 while another job was still READY.

    Two deployments hold a slot each. One expires. Sweeping twice must take the count
    from 2 to 1, not to 0: the second decrement would free a slot belonging to the
    deployment still running.
    """
    store = InMemoryStore()
    expiring = seeded_job(store, project_id="user:alice")
    store.admit("user:alice", limit=5, account_limit=50)

    # A second, still-running deployment in the same project.
    other_plan = make_plan(project_id="user:alice")
    other_approval = approve(other_plan, subject="s", username="u", capability="approve")
    other, _ = store.start_job(new_job(other_plan, other_approval, subject="s"))
    store.put_job(replace(other, state=JobState.READY))
    store.admit("user:alice", limit=5, account_limit=50)
    assert store.active_count("user:alice") == 2

    store.put_resource(
        LedgerEntry(
            entry_id="res-1", job_id=expiring.job_id, project_id="user:alice",
            kind="sagemaker-endpoint", intent_key="k", state=ResourceState.CREATED,
            region="us-east-1", account_id="123456789012", physical_id="eddie-dev-x",
        )
    )
    adapter = SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: FakeClient(
            delete_endpoint={},
            describe_endpoint=client_error(
                "ValidationException", "Could not find endpoint eddie-dev-x."
            ),
        ),
    )
    reconciler = Reconciler(store, (adapter,))
    reconciler.sweep()
    after_first = store.active_count("user:alice")
    reconciler.sweep()
    after_second = store.active_count("user:alice")

    assert after_first == 1, after_first
    assert after_second == 1, (
        f"the second sweep released a slot again ({after_first} -> {after_second}); "
        f"the still-running deployment lost its reservation"
    )


def test_concurrent_sweeps_release_admission_once():
    from concurrent.futures import ThreadPoolExecutor

    store = InMemoryStore()
    job = seeded_job(store, project_id="user:alice")
    store.admit("user:alice", limit=5, account_limit=50)
    store.admit("user:alice", limit=5, account_limit=50)
    assert store.active_count("user:alice") == 2

    store.put_resource(
        LedgerEntry(
            entry_id="res-1", job_id=job.job_id, project_id="user:alice",
            kind="sagemaker-endpoint", intent_key="k", state=ResourceState.CREATED,
            region="us-east-1", account_id="123456789012", physical_id="eddie-dev-x",
        )
    )
    adapter = SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: FakeClient(
            delete_endpoint={},
            describe_endpoint=client_error(
                "ValidationException", "Could not find endpoint eddie-dev-x."
            ),
        ),
    )
    reconciler = Reconciler(store, (adapter,))
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: reconciler.sweep(), range(8)))
    assert store.active_count("user:alice") == 1


def test_release_for_job_is_idempotent_and_records_itself():
    store = InMemoryStore()
    job = seeded_job(store)
    store.admit(job.project_id, limit=5, account_limit=50)
    assert store.release_for_job(job) is True
    assert store.release_for_job(job) is False
    assert store.get_job(job.project_id, job.job_id).admission_released is True
    assert store.active_count(job.project_id) == 0


def test_a_failed_cleanup_does_not_release_admission():
    store = InMemoryStore()
    job = seeded_job(store)
    store.admit(job.project_id, limit=5, account_limit=50)
    store.put_resource(
        LedgerEntry(
            entry_id="res-1", job_id=job.job_id, project_id=job.project_id,
            kind="sagemaker-endpoint", intent_key="k", state=ResourceState.CREATED,
            region="us-east-1", account_id="123456789012", physical_id="eddie-dev-x",
        )
    )
    adapter = SageMakerEndpointAdapter(
        account_id="123456789012",
        permitted_regions=("us-east-1",),
        client_factory=lambda region: FakeClient(
            delete_endpoint=client_error("ThrottlingException", "Rate exceeded")
        ),
    )
    Reconciler(store, (adapter,)).sweep()
    assert store.active_count(job.project_id) == 1, "a stuck cleanup freed capacity"
    assert store.get_job(job.project_id, job.job_id).admission_released is False


def test_the_release_flag_survives_serialisation():
    from deploy.store import _job_from_document

    store = InMemoryStore()
    job = seeded_job(store)
    store.admit(job.project_id, limit=5, account_limit=50)
    store.release_for_job(job)
    reloaded = store.get_job(job.project_id, job.job_id)
    assert _job_from_document(reloaded.to_json()).admission_released is True
