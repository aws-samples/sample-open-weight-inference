"""Bounded trial contracts; AWS calls are faked here, live receipts are separate."""
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest

from deploy import service, recipes
from deploy.executor import admitted_plan, still_creating
from deploy.models import (
    ApprovalError, Artifact, CheckStatus, JobState, PlanKind, ResourceEnvelope,
    Target, approve, new_job, new_plan, _iso, _now,
)
from deploy.reconciler import Reconciler
from deploy.staging import permitted_download
from deploy.store import ConcurrencyLimitExceeded, InMemoryStore, NotFound


@pytest.fixture
def settings():
    return recipes.Settings(
        account="123456789012", region="us-east-1", environment="test",
        table="trial-table", bucket="trial-artifacts", kms_key="key",
        image="123456789012.dkr.ecr.us-east-1.amazonaws.com/eddie-test-serving@sha256:" + "a" * 64,
        execution_role="arn:aws:iam::123456789012:role/serving",
        subnets=("subnet-one", "subnet-two"), security_group="sg-private",
        worker_function="worker", staging_function="stager",
        inference_function="inference", reconciler_function="reconciler",
    )


@pytest.fixture
def prepared(settings, monkeypatch):
    store = InMemoryStore()
    principal = SimpleNamespace(subject="alice", username="Alice")
    metadata = {"source": recipes.MODEL_SOURCES[0], "revision": "b" * 40,
                "bytes": 1000, "files": [], "license": "apache-2.0", "licenseUrl": "https://huggingface.co/license"}
    monkeypatch.setattr(service, "inspect_recipe_model", lambda *args: metadata)
    monkeypatch.setattr(service, "safety_checks", lambda *_: [service.check("network", True, "private", "private")])
    import catalog.pricing
    monkeypatch.setattr(catalog.pricing, "sagemaker_hosting_rate", lambda *args: SimpleNamespace(
        amount=Decimal("1.52"), unit="USD/Hrs", currency="USD", region="us-east-1",
        sku="test-price-sku", effective_date="2026-09-01", source="test fixture",
    ))
    app = service.DeploymentService(settings, store)
    monkeypatch.setattr(app, "notify", lambda *args: None)
    payload = {"source": recipes.MODEL_SOURCES[0], "region": "us-east-1", "caseFingerprint": "c" * 64,
               "lifetimeMinutes": 45, "maxSpendUsd": "5.00"}
    return app, store, principal, payload


def test_review_survives_navigation_with_identical_cost_and_identity(prepared):
    app, store, actor, payload = prepared
    review = app.prepare(payload, actor, "user:alice")
    restored = store.get_plan_review("user:alice", review["plan"]["planId"])
    assert restored == review
    assert restored["cost"]["hostingEstimateUsd"] == "1.14"
    assert restored["cost"]["admissionEstimateUsd"] == "2.02"
    assert restored["plan"]["evaluatedRequestHash"] == "c" * 64
    review["cost"]["hostingEstimateUsd"] = "0.00"
    assert store.get_plan_review("user:alice", restored["plan"]["planId"])["cost"]["hostingEstimateUsd"] == "1.14"


def test_low_guard_produces_reviewable_blocker_and_cannot_be_approved(prepared):
    app, store, actor, payload = prepared
    review = app.prepare({**payload, "maxSpendUsd": "0.50"}, actor, "user:alice")
    assert review["plan"]["approvable"] is False
    assert review["plan"]["blockers"][0]["checkId"] == "budget.guard"
    with pytest.raises(ApprovalError):
        app.approve_and_start({"planId": review["plan"]["planId"], "planHash": review["plan"]["planHash"],
                              "acknowledgeCost": True, "modelTermsReviewed": True}, actor, "user:alice")
    assert store.list_jobs("user:alice") == []


def test_region_and_missing_case_identity_are_not_silently_replaced(prepared):
    app, _, actor, payload = prepared
    with pytest.raises(ValueError, match="selected Region was not changed"):
        app.prepare({**payload, "region": "us-west-2"}, actor, "user:alice")
    with pytest.raises(ValueError, match="identity"):
        app.prepare({**payload, "caseFingerprint": None}, actor, "user:alice")


def test_changed_project_changes_approval_identity(prepared):
    app, _, actor, payload = prepared
    a = app.prepare(payload, actor, "user:alice")["plan"]
    b = app.prepare({**payload, "caseFingerprint": "d" * 64}, actor, "user:alice")["plan"]
    assert a["planHash"] != b["planHash"]
    with pytest.raises(ApprovalError, match="no longer matches"):
        app.approve_and_start({"planId": a["planId"], "planHash": b["planHash"]}, actor, "user:alice")


def test_review_cannot_be_read_from_a_different_project(prepared):
    app, store, actor, payload = prepared
    review = app.prepare(payload, actor, "user:alice")
    with pytest.raises(NotFound, match="No such plan in this project"):
        store.get_plan_review("user:bob", review["plan"]["planId"])


def test_prepared_plan_cannot_be_overwritten(prepared):
    app, store, actor, payload = prepared
    view = app.prepare(payload, actor, "user:alice")["plan"]
    plan = store.get_plan("user:alice", view["planId"])
    with pytest.raises(ApprovalError, match="cannot be overwritten"):
        store.put_plan(replace(plan, region="us-west-2"))


def test_approval_acknowledgments_and_replay(prepared):
    app, store, actor, payload = prepared
    plan = app.prepare(payload, actor, "user:alice")["plan"]
    consent = {"planId": plan["planId"], "planHash": plan["planHash"]}
    with pytest.raises(ValueError, match="terms"):
        app.approve_and_start(consent, actor, "user:alice")
    consent.update(acknowledgeCost=True, modelTermsReviewed=True)
    first = app.approve_and_start(consent, actor, "user:alice")
    second = app.approve_and_start(consent, actor, "user:alice")
    assert first["created"] is True
    assert second["created"] is False
    assert second["deployment"]["jobId"] == first["deployment"]["jobId"]
    assert len(store.list_jobs("user:alice")) == 1


def test_admission_failure_does_not_consume_another_approval(prepared):
    app, store, actor, payload = prepared
    for number in range(2):
        plan = app.prepare({**payload, "caseFingerprint": str(number) * 64}, actor, "user:alice")["plan"]
        consent = {"planId": plan["planId"], "planHash": plan["planHash"], "acknowledgeCost": True, "modelTermsReviewed": True}
        if number == 0:
            app.approve_and_start(consent, actor, "user:alice")
        else:
            with pytest.raises(ConcurrencyLimitExceeded):
                app.approve_and_start(consent, actor, "user:alice")
            approval_id = "approval-" + recipes.digest([plan["planId"], plan["planHash"], actor.subject])[:32]
            assert store.get_approval("user:alice", approval_id).consumed_by_job is None


def test_cleanup_checks_are_repeated_immediately_before_start(prepared, monkeypatch):
    app, store, actor, payload = prepared
    plan = app.prepare(payload, actor, "user:alice")["plan"]
    monkeypatch.setattr(service, "safety_checks", lambda *_: [service.check("cleanup", False, "healthy", "stopped")])
    with pytest.raises(ApprovalError, match="check changed"):
        app.approve_and_start({"planId": plan["planId"], "planHash": plan["planHash"],
                              "acknowledgeCost": True, "modelTermsReviewed": True}, actor, "user:alice")
    assert store.list_jobs("user:alice") == []


def test_live_worker_lease_prevents_cleanup_of_an_intent(prepared):
    app, store, actor, payload = prepared
    plan = app.prepare(payload, actor, "user:alice")["plan"]
    job = app.approve_and_start({"planId": plan["planId"], "planHash": plan["planHash"],
                               "acknowledgeCost": True, "modelTermsReviewed": True}, actor, "user:alice")["deployment"]
    stored = store.get_job("user:alice", job["jobId"])
    store.put_job(replace(stored, resource_expires_at=_iso(_now() - timedelta(minutes=1))))
    with store.lease_job(stored.job_id) as acquired:
        assert acquired
        Reconciler(store, ()).sweep()
        assert store.get_job("user:alice", stored.job_id).state is JobState.PENDING
    Reconciler(store, ()).sweep()
    assert store.get_job("user:alice", stored.job_id).state is JobState.DELETED


def test_deletion_request_cannot_be_overwritten_by_an_older_worker(prepared):
    app, store, actor, payload = prepared
    plan = app.prepare(payload, actor, "user:alice")["plan"]
    view = app.approve_and_start({"planId": plan["planId"], "planHash": plan["planHash"],
                                "acknowledgeCost": True, "modelTermsReviewed": True}, actor, "user:alice")["deployment"]
    before = store.get_job("user:alice", view["jobId"])
    store.request_deletion("user:alice", before.job_id)
    store.put_job(replace(before, state=JobState.RUNNING))
    assert store.get_job("user:alice", before.job_id).state is JobState.DELETING
    with pytest.raises(ValueError, match="no longer accepting"):
        still_creating(store, before)


@pytest.mark.parametrize("url", [
    "http://huggingface.co/model", "https://huggingface.co.evil.test/model",
    "https://169.254.169.254/latest/meta-data", "https://user:secret@huggingface.co/model",
    "file:///etc/passwd", "https://huggingface.co:8443/model",
])
def test_model_redirects_cannot_reach_arbitrary_hosts(url):
    assert permitted_download(url) is False


def test_false_cleanup_health_does_not_pass_without_recent_completed_metric(settings, monkeypatch):
    class Services:
        def describe_rule(self, **kwargs):
            return {"State": "ENABLED", "ScheduleExpression": "rate(5 minutes)"}
        def list_targets_by_rule(self, **kwargs):
            return {"Targets": [{"Arn": settings.reconciler_function}]}
        def get_function_configuration(self, **kwargs):
            return {"State": "Active", "LastUpdateStatus": "Successful"}
        def describe_alarms(self, **kwargs):
            return {"MetricAlarms": [{"StateValue": "OK", "ActionsEnabled": True, "AlarmActions": ["topic"]} for _ in range(4)]}
        def get_metric_data(self, **kwargs):
            return {"MetricDataResults": [{"StatusCode": "Complete", "Timestamps": [], "Values": []}]}
    monkeypatch.setattr(service, "client", lambda *args: Services())
    assert service.verify_cleanup(settings).status is CheckStatus.FAIL



def test_worker_refuses_job_whose_actor_differs_from_approval(prepared):
    app, store, actor, payload = prepared
    view = app.prepare(payload, actor, "user:alice")["plan"]
    started = app.approve_and_start({"planId": view["planId"], "planHash": view["planHash"],
                                    "acknowledgeCost": True, "modelTermsReviewed": True}, actor, "user:alice")
    job = store.get_job("user:alice", started["deployment"]["jobId"])
    with pytest.raises(ValueError, match="do not agree"):
        admitted_plan(store, app.settings, replace(job, started_by_subject="different-user"))


def test_database_lists_honor_atomic_removal_and_release_flags(prepared):
    from deploy.store import DynamoStore
    app, store, actor, payload = prepared
    view = app.prepare(payload, actor, "user:alice")["plan"]
    started = app.approve_and_start({"planId": view["planId"], "planHash": view["planHash"],
                                    "acknowledgeCost": True, "modelTermsReviewed": True}, actor, "user:alice")
    job = store.get_job("user:alice", started["deployment"]["jobId"])
    database = object.__new__(DynamoStore)
    database._query_prefix = lambda *args: [{"document": job.to_json(), "deleteRequested": True, "admissionReleased": True}]
    listed = database.list_jobs("user:alice")[0]
    assert listed.state is JobState.DELETING
    assert listed.admission_released is True


def test_worker_keeps_actionable_failure_before_independent_cleanup(prepared, monkeypatch, caplog):
    from deploy import executor
    from deploy.failures import endpoint_failure
    app, store, actor, payload = prepared
    view = app.prepare(payload, actor, "user:alice")["plan"]
    started = app.approve_and_start({"planId": view["planId"], "planHash": view["planHash"],
                                    "acknowledgeCost": True, "modelTermsReviewed": True}, actor, "user:alice")
    job_id = started["deployment"]["jobId"]

    class FailedEndpoint:
        def __init__(self, *args): pass
        def advance(self, job):
            raise endpoint_failure("Failed", "Docker image download failed: https://example.test/layer?secret=token")

    monkeypatch.setattr(executor, "SETTINGS", app.settings)
    monkeypatch.setattr(executor, "DynamoStore", lambda *args: store)
    monkeypatch.setattr(executor, "SageMakerExecutor", FailedEndpoint)
    executor.handler({"projectId": "user:alice", "jobId": job_id})
    failed = store.get_job("user:alice", job_id)
    assert failed.state is JobState.FAILED
    assert "serving_image_unavailable" in failed.failure_reason
    assert "ValueError" not in failed.failure_reason
    assert "Docker image download failed" in caplog.text
    assert "secret=token" not in caplog.text
    assert failed.published_route is None
    assert failed.invocation_receipt is None
