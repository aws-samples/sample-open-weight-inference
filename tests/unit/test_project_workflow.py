"""Behavioral contracts for the non-linear workspace; no AWS calls in these tests."""
from copy import deepcopy
from decimal import Decimal

import pytest

from api.handler import parse_request
from api.serialize import request_json
from catalog.candidates import build_snapshot, enumerate_candidates
from evaluation.scoring import score_responses
from solver.money import Rate
from solver.solve import solve


def case(**extra):
    return {
        "model": {"name": "test-model", "architecture": "Qwen2ForCausalLM", "weightsGb": "14", "totalParamsB": "7", "contextTokens": 32768},
        "workload": {"horizonHours": "72", "billableCopyHours": "6", "requests": "2880", "inputTokensPerRequest": "500", "outputTokensPerRequest": "200"},
        "constraints": {"permittedRegions": ["us-west-2", "us-east-2"]},
        **extra,
    }


def test_all_permitted_regions_have_distinct_candidates():
    request = parse_request(case())
    candidates = enumerate_candidates(request)
    assert {c.region for c in candidates} == {"us-west-2", "us-east-2"}
    assert len({c.candidate_id for c in candidates}) == len(candidates)
    assert all(c.candidate_id.endswith(c.region) for c in candidates)


def test_traffic_and_exact_model_revision_survive_parsing():
    payload = case()
    payload["model"]["hfCommit"] = "revision-123"
    request = parse_request(payload)
    echoed = request_json(request)
    assert echoed["workload"]["requests"] == "2880"
    assert echoed["workload"]["inputTokensPerRequest"] == "500"
    assert echoed["workload"]["outputTokensPerRequest"] == "200"
    assert echoed["model"]["hfCommit"] == "revision-123"
    changed = deepcopy(payload)
    changed["workload"]["outputTokensPerRequest"] = "800"
    assert parse_request(changed).workload.workload_hash() != request.workload.workload_hash()


def test_other_region_price_cannot_price_a_candidate():
    request = parse_request(case())
    candidates = enumerate_candidates(request)
    rates = {"instance::ml.g5.2xlarge": Rate.usd("1", "USD/instance-hour", region="us-east-1")}
    snapshot = build_snapshot(request, candidates, rates, "test", assume_cleared=True)
    for candidate in candidates:
        if candidate.instance_type == "ml.g5.2xlarge":
            assert snapshot.per_candidate[candidate.candidate_id].cost.total is None


def test_regional_costs_are_used_independently():
    request = parse_request(case())
    candidates = enumerate_candidates(request)
    rates = {
        "region::us-west-2::instance::ml.g5.2xlarge": Rate.usd("1", "USD/instance-hour", region="us-west-2"),
        "region::us-east-2::instance::ml.g5.2xlarge": Rate.usd("2", "USD/instance-hour", region="us-east-2"),
    }
    snapshot = build_snapshot(request, candidates, rates, "test", assume_cleared=True)
    assert snapshot.per_candidate["sagemaker-ml.g5.2xlarge@us-west-2"].cost.total == Decimal("72")
    assert snapshot.per_candidate["sagemaker-ml.g5.2xlarge@us-east-2"].cost.total == Decimal("144")


def test_stated_quality_goal_is_not_silently_ignored():
    request = parse_request(case(qualityGoal="Classify at least 95% of support requests correctly"))
    candidates = enumerate_candidates(request)
    snapshot = build_snapshot(request, candidates, {}, "test", assume_cleared=True)
    decision = solve(request, candidates, snapshot)
    assert not decision.ranked
    assert all(any(g.name == "quality" and g.status.value == "UNKNOWN" for g in ev.gates) for ev in decision.unresolved)


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "-2"])
def test_invalid_token_count_cannot_enter_solver(value):
    payload = case()
    payload["workload"]["inputTokensPerRequest"] = value
    with pytest.raises(ValueError):
        parse_request(payload)


def test_scoring_keeps_failures_in_the_denominator_and_never_claims_inference():
    report = score_responses({
        "examples": [
            {"input": "one", "expected": "billing", "actual": "billing"},
            {"input": "two", "expected": "technical", "actual": None},
            {"input": "three", "expected": "billing", "actual": "billing", "error": "timeout"},
            {"input": "four", "expected": "billing", "actual": "account"},
        ],
        "passPercent": "90",
    })
    assert report["total"] == 4
    assert report["passed"] == 1
    assert report["matchPercent"] == "25.00"
    assert report["sampleTargetMet"] is False
    assert report["provenance"] == "SUPPLIED_OUTPUTS"
    assert report["modelInvoked"] is report["latencyMeasured"] is report["deploymentQualified"] is False


def test_case_sensitivity_and_threshold_are_versioned_inputs():
    payload = {"examples": [{"input": "x", "expected": "Billing", "actual": "billing"}]}
    strict = score_responses(payload)
    insensitive = score_responses({**payload, "caseSensitive": False})
    assert strict["passed"] == 0
    assert insensitive["passed"] == 1
    assert strict["evaluationId"] != insensitive["evaluationId"]
    assert strict["evaluationId"] == score_responses(payload)["evaluationId"]
    assert score_responses({**payload, "passPercent": "80"})["evaluationId"] != strict["evaluationId"]


@pytest.mark.parametrize("payload", [
    {"examples": []},
    {"examples": [{"input": "x", "expected": "", "actual": ""}]},
    {"examples": [{"input": "x", "expected": "x", "actual": 2}]},
    {"examples": [{"input": "x", "expected": "x", "actual": "x"}], "passPercent": "NaN"},
    {"examples": [{"input": "x", "expected": "x", "actual": "x"}], "caseSensitive": "false"},
    {"examples": [{"input": "x" * 1_000_001, "expected": "x", "actual": "x"}]},
])
def test_invalid_scoring_inputs_are_rejected(payload):
    with pytest.raises(ValueError):
        score_responses(payload)


def test_answer_export_contains_every_input_needed_to_reproduce_its_identity():
    import hashlib
    import json
    from evaluation.scoring import score_responses
    report = score_responses({
        "examples": [{"input": "question", "expected": "billing", "actual": None, "error": "timeout"}],
        "model": {"source": "Qwen/Qwen2.5-7B-Instruct", "revision": "pinned-commit"},
        "passPercent": "95", "caseSensitive": False,
    })
    manifest = {
        "scorerVersion": report["scorerVersion"], "caseSensitive": report["caseSensitive"],
        "passPercent": report["targetPercent"], "model": report["model"],
        "examples": [{key: row[key] for key in ("input", "expected", "actual", "error")} for row in report["results"]],
    }
    rebuilt = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    assert rebuilt == report["evaluationId"]
    assert report["failed"] == 1
