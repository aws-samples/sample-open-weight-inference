"""An existing fine-tuned artifact is inference; training counts are not traffic."""
import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from moto import mock_aws

from agent.advisor import TOOL_SPECS, _AdvisorTool
from api.handler import parse_request
from solver.qualification import parse_qualification, require_inference_scope


@pytest.mark.parametrize("workload_type", ["training", "both"])
def test_old_training_projects_remain_readable_but_cannot_be_evaluated(workload_type):
    answers = parse_qualification({"workloadType": workload_type, "modelStage": "fine-tuned"})
    assert answers["workloadType"] == workload_type
    with pytest.raises(ValueError, match="Training job counts and durations cannot be reused"):
        parse_request({"qualification": answers})


@pytest.mark.parametrize("model_stage", ["base", "fine-tuned"])
def test_existing_base_and_fine_tuned_models_are_valid_inference(model_stage):
    request = parse_request({
        "qualification": {"workloadType": "inference", "modelStage": model_stage},
        "model": {
            "name": "Acme completed checkpoint", "architecture": "Qwen2ForCausalLM",
            "hfRepo": "acme/existing-model", "hfCommit": "a" * 40,
        },
        "workload": {"horizonHours": "720", "requests": "4500"},
        "constraints": {"permittedRegions": ["us-east-1"]},
    })
    assert request.qualification["modelStage"] == model_stage
    assert request.model.hf_commit == "a" * 40
    assert request.workload.requests == 4500


def test_older_inference_projects_do_not_need_a_new_scope_answer():
    for answers in ({}, {"modelStage": "fine-tuned"}, {"workloadType": "unsure"}):
        require_inference_scope(answers)


@pytest.mark.parametrize("workload_type", ["training", "both"])
def test_strands_rejects_a_training_patch_before_calling_the_handler(workload_type):
    invoke = Mock()
    spec = next(item["toolSpec"] for item in TOOL_SPECS
                if item["toolSpec"]["name"] == "propose_case_patch")
    tool = _AdvisorTool(spec, invoke, lambda: None, lambda *_: None)

    async def run():
        return [event async for event in tool.stream({
            "toolUseId": "scope-check",
            "input": {"workloadType": workload_type, "requests": "4500"},
        }, {})]

    events = asyncio.run(run())
    assert events[-1]["status"] == "error"
    invoke.assert_not_called()


@pytest.fixture
def runtime(monkeypatch):
    with mock_aws():
        from runtime import app

        repo = SimpleNamespace(expiry=2_000_000_000, acquire=Mock(), finish=Mock())
        monkeypatch.setattr(app, "conversation_repository", lambda *_: repo)
        monkeypatch.setattr(app, "_evaluate_core", Mock(side_effect=AssertionError("Unexpected evaluation")))
        monkeypatch.setattr(app, "inspect_model_source", Mock(side_effect=AssertionError("Unexpected inspection")))
        yield app


@pytest.mark.parametrize("tool_name,arguments", [
    ("propose_case_patch", {"workloadType": "inference", "requests": "4500"}),
    ("evaluate_placement", {}),
    ("calculate_usage", {"users": "15", "requestsPerUserPerDay": "10", "days": "30"}),
])
def test_coordinator_does_not_relabel_or_use_legacy_training_counts(runtime, monkeypatch, tool_name, arguments):
    observed = {}

    class ScriptedAdvisor:
        def __init__(self, tools, **_):
            self.tools = tools

        def converse(self, *_):
            observed.update(self.tools[tool_name](arguments))
            return {"reply": "Please confirm the inference workload.", "status": "COMPLETE"}

    monkeypatch.setattr(runtime, "Advisor", ScriptedAdvisor)
    case = {
        "caseId": "legacy-training-case", "workloadType": "training",
        "modelStage": "fine-tuned", "requests": "4500",
        "architecture": "Qwen2ForCausalLM", "hfRepo": "acme/existing-model",
    }
    original = copy.deepcopy(case)
    result = asyncio.run(runtime.action_chat(
        {"case": case, "turnId": "scope-turn", "message": "Help me with this project"},
        SimpleNamespace(principal=SimpleNamespace(expires_at=0)),
    ))
    assert "Use this project for inference" in observed["error"]
    assert result["case"] == original
    assert result["casePatch"] == {}
    assert result["decision"] is None
    runtime._evaluate_core.assert_not_called()
    runtime.inspect_model_source.assert_not_called()
