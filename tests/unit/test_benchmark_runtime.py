"""Benchmark evidence is recomputed, scoped and never deployment authority."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from moto import mock_aws

from evaluation.benchmarks import compare_benchmarks
from runtime.principal import ACTION_CAPABILITY, Capability, PUBLIC_ACTIONS
from test_benchmark_comparison import run
from test_project_saving import document, store  # noqa: F401 - reuse the isolated DynamoDB fixture
from test_runtime_session_boundary import authenticated_runtime  # noqa: F401 - real signed HTTP test fixture


@pytest.mark.parametrize("action", ["evaluation.compare", "benchmarks.public"])
def test_comparison_is_authenticated_and_read_only(action):
    assert ACTION_CAPABILITY[action] is Capability.READ
    assert action not in PUBLIC_ACTIONS


def test_public_http_action_accepts_authenticated_context_but_not_arbitrary_query_fields(
    authenticated_runtime, monkeypatch,
):
    from evaluation import published
    client, headers = authenticated_runtime
    snapshot = Mock(return_value={"cohorts": [{"id": "1.0.0"}], "rows": []})
    monkeypatch.setattr(published, "_snapshot", snapshot)
    response = client.post("/invocations", headers=headers(groups=("eddie-readers",)),
                           json={"action": "benchmarks.public", "payload": {}})
    assert response.json()["ok"] is True
    assert response.json()["result"]["state"] == "READY"
    assert "projectId" not in response.json()["result"]
    snapshot.assert_called_once()
    snapshot.reset_mock()
    for payload in ({"url": "https://example.com/"}, {"projectId": "user:bob"}):
        response = client.post("/invocations", headers=headers(),
                               json={"action": "benchmarks.public", "payload": payload})
        assert response.json()["ok"] is False
    response = client.post("/invocations", json={"action": "benchmarks.public", "payload": {}})
    assert response.json()["ok"] is False
    snapshot.assert_not_called()


def test_saved_measurements_round_trip_without_changing_deployment_fields(store):
    doc = document()
    reports = [run()]
    doc["evaluationDraft"].update(benchmarkRuns=reports, benchmarkComparison=compare_benchmarks({"runs": reports}))
    store.save("alice", "demo", doc, None)
    assert store.get("alice", "demo")["project"]["document"] == doc
    assert store.get("bob", "demo") == {"project": None}
    assert "approval" not in doc


def test_invalid_benchmark_never_reaches_project_storage(store):
    doc = document()
    bad = run()
    bad["samples"][0]["status"] = "not_run"
    doc["evaluationDraft"]["benchmarkRuns"] = [bad]
    with pytest.raises(ValueError):
        store.save("alice", "demo", doc, None)
    assert store.list("alice")["projects"] == []


@pytest.mark.parametrize("with_reports", [False, True])
def test_advisor_tool_reads_current_project_measurements_without_running_models(monkeypatch, with_reports):
    with mock_aws():
        from runtime import app
        repo = SimpleNamespace(expiry=2_000_000_000, acquire=Mock(), finish=Mock())
        monkeypatch.setattr(app, "conversation_repository", lambda *_: repo)
        evaluate = Mock(side_effect=AssertionError("Measurements must not trigger deployment qualification"))
        monkeypatch.setattr(app, "_evaluate_core", evaluate)
        observed = {}
        class Advisor:
            def __init__(self, tools, **kwargs):
                self.tools = tools
            def converse(self, *args):
                observed.update(self.tools["read_benchmark_results"]({}))
                return {"reply": "These are supplied sample results.", "status": "COMPLETE"}
        monkeypatch.setattr(app, "Advisor", Advisor)
        case = {"caseId": "bench-project"}
        payload = {"case": case, "turnId": "bench-turn", "message": "Compare my measured runs."}
        if with_reports:
            payload["benchmarkRuns"] = [run()]
        result = asyncio.run(app.action_chat(
            payload, SimpleNamespace(principal=SimpleNamespace(expires_at=0))))
        assert observed["available"] is with_reports
        if with_reports:
            assert observed["rows"][0]["accepted"] == 1
            assert "taskOutcomes" not in observed["rows"][0]
            assert observed["deploymentQualified"] is False
        assert result["case"] == case and result["casePatch"] == {} and result["decision"] is None
        evaluate.assert_not_called()


def test_old_turn_idempotency_hash_is_preserved_without_measurements(monkeypatch):
    import hashlib
    import json
    with mock_aws():
        from runtime import app
        repo = SimpleNamespace(expiry=2_000_000_000, acquire=Mock(), finish=Mock())
        monkeypatch.setattr(app, "conversation_repository", lambda *_: repo)
        monkeypatch.setattr(app, "Advisor", lambda **_: SimpleNamespace(
            converse=lambda *_: {"reply": "Hello.", "status": "COMPLETE"}))
        case = {"caseId": "old-project"}
        asyncio.run(app.action_chat(
            {"case": case, "turnId": "old-turn", "message": "Hello."},
            SimpleNamespace(principal=SimpleNamespace(expires_at=0))))
        expected = hashlib.sha256(json.dumps({"message": "Hello.", "case": case, "assumeChecksCleared": False},
                                             sort_keys=True, allow_nan=False, separators=(",", ":")).encode()).hexdigest()
        assert repo.acquire.call_args.args[1] == expected
