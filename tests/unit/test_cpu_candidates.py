"""CPU must be a visible, costed experiment candidate, not an inferred GPU need."""
import json
from copy import deepcopy
from decimal import Decimal

import pytest

from api import handler
from api.serialize import cost_json, decision_json
from catalog.candidates import build_snapshot, cost_for_candidate, enumerate_candidates
from solver.cpu import CPU_TARGETS
from solver.models import GateStatus, Target
from solver.solve import solve


def payload():
    return {
        "model": {
            "name": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            "hfRepo": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            "hfCommit": "a" * 40,
            "sourceKind": "huggingface",
            "architecture": "Qwen3TTSForConditionalGeneration",
            "modality": "TTS", "weightsGb": "3.6", "weightsExportable": True,
        },
        "workload": {"horizonHours": "720"},
        "constraints": {"permittedRegions": ["us-east-1"]},
        "slos": [],
    }


def evaluate(body=None, rates=None, assume=False):
    req = handler.parse_request(body or payload())
    candidates = enumerate_candidates(req)
    snap = build_snapshot(req, candidates, rates or {}, "fixture", assume_cleared=assume)
    decision = solve(req, candidates, snap)
    items = {e.candidate.target: e for e in decision.ranked + decision.unresolved + decision.excluded
             if e.candidate.target in CPU_TARGETS}
    return req, decision, items


def gate(item, name):
    return next(g for g in item.gates if g.name == name)


def test_exact_base_model_without_latency_exposes_both_cpu_options():
    req, decision, items = evaluate()
    assert set(items) == CPU_TARGETS
    assert not decision.ranked
    for item in items.values():
        assert item in decision.unresolved
        assert gate(item, "latency").status is GateStatus.PASS
        assert gate(item, "cpu_delivery").status is GateStatus.UNKNOWN
        questions = gate(item, "cpu_delivery").reason
        for phrase in ("live output", "completion deadline", "same time", "comparison period"):
            assert phrase in questions
        # A recorded speech run applies only to its own architecture, never this one.
        assert gate(item, "cpu_runtime").evidence_ref is None
        assert item.candidate.recipe_id is None
    wire = decision_json(decision, req)
    assert {i["target"] for i in wire["unresolved"]} >= {"EC2_CPU", "AWS_BATCH_CPU"}
    assert wire["qualification"]["performanceMeasured"] is False


def test_user_declared_runtime_and_stipulated_checks_cannot_qualify_cpu():
    body = payload()
    body["qualification"] = {"servingPattern": "batch", "cpuRuntime": "compatible",
                             "completionDeadlineSeconds": "1200"}
    body["workload"].update(concurrency=1, requests="4")
    _, decision, items = evaluate(body, assume=True)
    for item in items.values():
        assert item not in decision.ranked
        assert gate(item, "recipe").status is GateStatus.UNKNOWN
        assert gate(item, "cpu_runtime").status is GateStatus.UNKNOWN
        assert gate(item, "cpu_memory").status is GateStatus.UNKNOWN
        assert "Benchmark that workload" in gate(item, "cpu_delivery").reason
        assert "covers real-time serving" not in gate(item, "declared_requirements").reason


def test_explicit_gpu_runtime_requirement_is_explained_not_silently_filtered():
    body = payload()
    body["qualification"] = {"cpuRuntime": "gpu-required"}
    _, decision, items = evaluate(body)
    for item in items.values():
        assert item in decision.excluded
        assert gate(item, "cpu_runtime").status is GateStatus.FAIL
        assert gate(item, "cpu_runtime").evidence_ref == "declared:cpuRuntime"
        assert "compatible CPU implementation" in gate(item, "cpu_runtime").reason


def test_interactive_delivery_excludes_batch_but_does_not_assume_ec2_cpu_is_too_slow():
    body = payload()
    body["qualification"] = {"servingPattern": "interactive"}
    _, decision, items = evaluate(body)
    assert items[Target.AWS_BATCH_CPU] in decision.excluded
    assert "queued Batch job" in gate(items[Target.AWS_BATCH_CPU], "cpu_delivery").reason
    assert items[Target.EC2_CPU] in decision.unresolved


def test_profile_memory_failure_does_not_claim_all_cpu_is_impossible():
    body = payload()
    body["model"]["weightsGb"] = "80"
    _, decision, items = evaluate(body)
    for item in items.values():
        assert item in decision.excluded
        memory = gate(item, "cpu_memory")
        assert memory.status is GateStatus.FAIL
        assert "larger CPU profile" in memory.reason
        assert "offload" in memory.reason


def test_private_checkpoint_does_not_inherit_the_base_model_benchmark():
    body = payload()
    body["model"].update(sourceKind="checkpoint", artifactDigest="b" * 64)
    _, _, items = evaluate(body)
    assert all(gate(item, "cpu_runtime").evidence_ref is None for item in items.values())


def test_costs_require_batch_schedule_and_supporting_charges():
    from solver.money import Rate
    rates = {"instance::c7i.8xlarge": Rate.usd("1.428", "USD/instance-hour")}
    _, _, items = evaluate(rates=rates)
    ec2 = cost_json(items[Target.EC2_CPU].cost)
    batch = cost_json(items[Target.AWS_BATCH_CPU].cost)
    assert ec2["total"] is None and ec2["knownSubtotal"] == "1028.16"
    assert ec2["items"][0]["quantity"] == "720"
    assert "continuous allocation" in ec2["items"][0]["note"]
    assert batch["total"] is None
    assert all(item["amount"] is None for item in batch["items"])
    assert not any(item["evidence"] == "MEASURED" for item in ec2["items"] + batch["items"])


def test_same_period_allocation_and_sourced_allowances_use_exact_decimal_math():
    from solver.money import Rate
    body = payload()
    body["workload"].update(dedicatedInstanceHours="2", scheduled=True, requests="4", concurrency=1)
    body["qualification"] = {
        "servingPattern": "batch", "cpuAdditionalCostUsd": "1.25",
        "batchAdditionalCostUsd": "0.50", "cpuCostNotes": "Fixture allowance for storage, logs, IP and requests",
    }
    rates = {"instance::c7i.8xlarge": Rate.usd("1.428", "USD/instance-hour"),
             "instance::ml.g5.2xlarge": Rate.usd("1.515", "USD/instance-hour")}
    req, _, items = evaluate(body, rates)
    assert items[Target.EC2_CPU].cost.total == Decimal("4.106")
    assert items[Target.AWS_BATCH_CPU].cost.total == Decimal("3.356")
    for item in items.values():
        assert item.cost.items[0].quantity == 2
        assert "720 hours" in item.cost.items[0].note
        assert "startup, idle time and shutdown" in item.cost.items[0].note
    sm = next(c for c in enumerate_candidates(req) if c.instance_type == "ml.g5.2xlarge")
    assert cost_for_candidate(sm, req, rates).total == Decimal("3.030")
    assert cost_for_candidate(sm, req, rates).items[0].quantity == 2
    without_basis = deepcopy(body)
    without_basis["qualification"].pop("cpuCostNotes")
    assert all(i.cost.total is None for i in evaluate(without_basis, rates)[2].values())


@pytest.mark.parametrize("field,value", [
    ("completionDeadlineSeconds", "NaN"), ("completionDeadlineSeconds", "0"),
    ("cpuAdditionalCostUsd", "-1"), ("batchAdditionalCostUsd", "Infinity"),
    ("cpuRuntime", "proven"), ("cpuAdditionalCostUsd", "1000000000001"),
])
def test_invalid_cpu_inputs_are_rejected(field, value):
    body = payload()
    body["qualification"] = {field: value}
    with pytest.raises(ValueError):
        handler.parse_request(body)


@pytest.mark.parametrize("field,value", [
    ("dedicatedInstanceHours", "721"), ("dedicatedInstanceHours", "-1"),
    ("concurrency", "0"), ("concurrency", "1.5"),
])
def test_invalid_allocation_or_concurrency_cannot_be_silently_rounded(field, value):
    body = payload()
    body["workload"][field] = value
    with pytest.raises(ValueError):
        handler.parse_request(body)


def test_http_comparison_uses_ec2_meter_once_for_cpu_and_sagemaker_meter_for_ml(monkeypatch):
    from solver.money import Rate
    calls = []
    monkeypatch.setattr(handler, "resolve_rates", lambda *a: {
        "cmi_per_cmu_minute": None, "cmi_per_cmu_month": None,
        "freshness": {}, "retrieved_at": "fixture",
    })
    def ec2(instance, region):
        calls.append(("ec2", instance, region))
        assert not instance.startswith("ml.")
        return Rate.usd("1.428", "USD/instance-hour", region=region)
    def sm(instance, region):
        calls.append(("sagemaker", instance, region))
        assert instance.startswith("ml.")
        return Rate.usd("1.515", "USD/instance-hour", region=region)
    monkeypatch.setattr(handler, "ec2_on_demand_rate", ec2)
    monkeypatch.setattr(handler, "sagemaker_hosting_rate", sm)
    response = handler.handle_evaluate(payload())
    assert response["statusCode"] == 200
    result = json.loads(response["body"])
    assert {i["target"] for i in result["unresolved"]} >= {"EC2_CPU", "AWS_BATCH_CPU"}
    assert calls.count(("ec2", "c7i.8xlarge", "us-east-1")) == 1
    assert len([c for c in calls if c[0] == "sagemaker"]) == 3


@pytest.mark.parametrize("architecture,expected", [
    ("Qwen3TTSForConditionalGeneration", "TTS"), ("UnknownForSpeech", None),
])
def test_base_without_a_task_tag_uses_known_pinned_architecture_only(monkeypatch, architecture, expected):
    from catalog import model_inspect
    replies = [
        (200, {"sha": "a" * 40, "safetensors": {"total": 1700000000}}),
        (200, {"architectures": [architecture]}),
        (200, []),
    ]
    monkeypatch.setattr(model_inspect, "_fetch", lambda *_args: replies.pop(0))
    result = model_inspect.inspect_model_source("Qwen/Qwen3-TTS-12Hz-1.7B-Base")
    assert result.modality.value == expected
    if expected:
        assert "resolve/" + "a" * 40 in result.modality.source_url
