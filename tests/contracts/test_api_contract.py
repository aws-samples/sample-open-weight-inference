"""API response-shape contract.

The frontend renders directly from these fields, so a silent rename or type change
here breaks the UI. These tests pin the contract without touching the network:
pricing is stubbed so the shape is asserted deterministically.

Separately, tests/end-to-end/ exercises the deployed API against live pricing.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from api import handler
from solver.money import Rate

LLAMA = {
    "name": "Llama 3.1 8B",
    "architecture": "LlamaForCausalLM",
    "weightsGb": "16",
    "contextTokens": 128000,
}

CMI_MINUTE = Rate.usd("0.05718", "USD/CMU-minute", sku="8EJKXB49YY4SMCKM")
CMI_MONTH = Rate.usd("1.95", "USD/CMU-month", sku="YQSJA22BPUVEWDW3")
SM_HOUR = Rate.usd("1.515", "USD/instance-hour", sku="BTQ8KZF3DKVFJY87")


#: The Region these frozen rates are quoted in. `Rate.usd` defaults to it, and a rate may
#: only price a candidate in its OWN Region, so the two have to be stated together.
STUB_REGION = "us-east-1"


@pytest.fixture(autouse=True)
def stub_pricing(monkeypatch):
    """Freeze prices AND the Region, so the contract is environment-independent.

    The Region pin is not tidiness. A request that names no Region falls back to
    `handler.REGION`, which reads `AWS_REGION` from the environment, while these frozen
    rates are quoted in `STUB_REGION`. `candidates._cost_for` then correctly refuses to
    price a us-west-2 candidate with a us-east-1 rate -- the guard exists so a price from
    the coordinator's Region cannot silently price another one -- so every CMI line item
    came back unpriced, the budget gate went UNKNOWN, and `ranked` was empty.

    Nine tests in this file then failed for a developer with `AWS_REGION=us-west-2`
    exported and passed for everyone else, which is the worst failure mode a contract
    test has: it was green because of an environment, not because of the code.
    """

    def fake_resolve(instance_type, region=STUB_REGION, architecture="LlamaForCausalLM",
                     cmu_version="v1"):
        return {
            "sagemaker_instance_hour": SM_HOUR,
            "cmi_per_cmu_minute": CMI_MINUTE,
            "cmi_per_cmu_month": CMI_MONTH,
            "freshness": {"sagemaker": "LIVE", "cmi_minute": "LIVE", "cmi_month": "LIVE"},
            "retrieved_at": "2026-09-12T00:00:00Z",
            "region": region,
            "cmi_family": "Llama",
            "cmu_version": cmu_version,
        }

    monkeypatch.setenv("AWS_REGION", STUB_REGION)
    monkeypatch.setattr(handler, "REGION", STUB_REGION)
    monkeypatch.setattr(handler, "resolve_rates", fake_resolve)
    monkeypatch.setattr(handler, "sagemaker_hosting_rate", lambda *a, **k: SM_HOUR)
    monkeypatch.setattr(handler, "ec2_on_demand_rate", lambda *a, **k:
                        Rate.usd("1.428", "USD/instance-hour", sku="fixture-ec2-cpu"))


def test_the_frozen_rates_price_the_region_the_candidates_land_in():
    """Guards the fixture itself, since its failure mode is silent over-permission.

    Without this, a future change to how the default Region is resolved would make every
    other test in the file green-by-accident again, and nothing would say so.
    """
    body = bursty()
    regions = {c["region"] for group in ("ranked", "unresolved", "excluded")
               for c in body[group]}
    assert regions == {STUB_REGION}, (
        f"candidates landed in {sorted(regions)} but the frozen rates are quoted in "
        f"{STUB_REGION}; the Region pin in stub_pricing is not taking effect"
    )
    assert body["ranked"], "a fully priced request must rank something"
    for candidate in body["ranked"]:
        assert candidate["cost"]["isComplete"], candidate["cost"]["unpriced"]


def post(body: dict) -> dict:
    resp = handler.lambda_handler(
        {"path": "/evaluate", "httpMethod": "POST", "body": json.dumps(body)}
    )
    assert resp["statusCode"] == 200, resp["body"]
    return json.loads(resp["body"])


def bursty(**overrides) -> dict:
    body = {
        "caseId": "contract",
        "model": LLAMA,
        "workload": {"horizonHours": "72", "billableCopyHours": "6"},
        "assumeChecksCleared": True,
    }
    body.update(overrides)
    return post(body)


# --------------------------------------------------------------------------
# Top-level shape
# --------------------------------------------------------------------------

REQUIRED_TOP_LEVEL = {
    "outcome",
    "requestHash",
    "snapshotHash",
    "solverVersion",
    "horizonHours",
    "assumptions",
    "ranked",
    "unresolved",
    "excluded",
    "winner",
    "breakeven",
    "counts",
    "qualification",
    "request",
    "priceFreshness",
    "retrievedAt",
    "checksStipulated",
    "latencyEvidenceProvenance",
}


def test_evaluate_returns_every_contracted_field():
    body = bursty()
    missing = REQUIRED_TOP_LEVEL - set(body)
    assert not missing, f"missing contracted fields: {sorted(missing)}"


def test_counts_agree_with_list_lengths():
    body = bursty()
    assert body["counts"]["ranked"] == len(body["ranked"])
    assert body["counts"]["unresolved"] == len(body["unresolved"])
    assert body["counts"]["excluded"] == len(body["excluded"])


def test_candidate_shape():
    cand = bursty()["ranked"][0]
    for field in (
        "candidateId", "target", "region", "modelRef", "instanceType",
        "instanceCount", "cmusPerCopy", "scaleToZero", "prewarmed", "opsBurden",
        "blastRadius", "recipeId", "notes", "isFeasible", "cost", "gates",
        "failureCount", "unknownCount",
    ):
        assert field in cand, f"candidate missing {field}"


def test_cost_line_items_carry_full_provenance():
    """Every line item must be replayable: quantity, unit, rate, SKU, evidence."""
    cand = bursty()["ranked"][0]
    assert cand["cost"]["items"], "no cost line items"
    for item in cand["cost"]["items"]:
        for field in ("label", "phase", "quantity", "quantityUnit", "rate", "amount",
                      "evidence", "note"):
            assert field in item, f"line item missing {field}"
        assert item["rate"]["sku"], "line item rate has no SKU"
        assert item["rate"]["unit"], "line item rate has no unit"
        assert item["evidence"] in ("MEASURED", "PROJECTED", "UNKNOWN")
        assert item["phase"] in (
            "platform", "discovery", "build", "trial", "serving", "cleanup"
        )


def test_gate_shape_and_status_vocabulary():
    for cand in bursty()["ranked"]:
        for gate in cand["gates"]:
            assert set(gate) == {"name", "status", "reason", "evidenceRef"}
            assert gate["status"] in ("PASS", "FAIL", "UNKNOWN")
            assert gate["reason"], f"gate {gate['name']} has no reason"


# --------------------------------------------------------------------------
# Numeric values are strings, so no float rounding reaches the UI
# --------------------------------------------------------------------------


def test_money_is_serialized_as_string_not_float():
    cand = bursty()["ranked"][0]
    assert isinstance(cand["cost"]["total"], str)
    assert isinstance(cand["cost"]["totalExact"], str)
    for item in cand["cost"]["items"]:
        assert isinstance(item["amount"], str)
        assert isinstance(item["rate"]["amount"], str)


def test_display_total_is_two_decimal_places():
    total = bursty()["ranked"][0]["cost"]["total"]
    assert Decimal(total) == Decimal(total).quantize(Decimal("0.01"))


# --------------------------------------------------------------------------
# The economic result
# --------------------------------------------------------------------------


def test_bursty_ranks_cmi_first_with_expected_total():
    body = bursty()
    assert body["outcome"] == "QUALIFIED_PLACEMENT"
    assert body["winner"]["target"] == "BEDROCK_CMI"
    assert body["winner"]["cost"]["total"] == "45.07"


def test_always_on_ranks_dedicated_first():
    body = post({
        "model": LLAMA,
        "workload": {"horizonHours": "720", "billableCopyHours": "720"},
        "assumeChecksCleared": True,
    })
    assert body["winner"]["target"] == "SAGEMAKER_REALTIME"


def test_breakeven_block_shape_and_verdict():
    be = bursty()["breakeven"]
    for field in ("breakevenDutyPercent", "cmiActiveHourly", "dedicatedHourly",
                  "actualDutyPercent", "verdict", "explanation",
                  "cmiComparedCandidate", "dedicatedComparedCandidate"):
        assert field in be, f"breakeven missing {field}"
    assert be["verdict"] == "BURST_FAVOURS_CMI"
    assert Decimal(be["actualDutyPercent"]) < Decimal(be["breakevenDutyPercent"])


def test_breakeven_compares_against_cheapest_dedicated_candidate():
    """Regression: it previously compared against the first candidate by ID."""
    body = bursty()
    be = body["breakeven"]
    dedicated = [
        c for c in body["ranked"] + body["unresolved"] + body["excluded"]
        if c["target"] == "SAGEMAKER_REALTIME" and c["cost"] and c["cost"]["total"]
    ]
    cheapest = min(dedicated, key=lambda c: Decimal(c["cost"]["total"]))
    assert be["dedicatedComparedCandidate"] == cheapest["candidateId"]


# --------------------------------------------------------------------------
# Honesty flags the UI must be able to render
# --------------------------------------------------------------------------


def test_stipulation_is_reported():
    assert bursty()["checksStipulated"] is True
    body = post({"model": LLAMA, "workload": {"horizonHours": "72"}})
    assert body["checksStipulated"] is False


def test_supplied_latency_is_labelled_not_measured():
    body = bursty(latencyEvidence={
        "cmi-scale-to-zero": {
            "p50Ms": "120", "p99Ms": "500", "sampleCount": 12000,
            "violationRateUpperBound": "0.004",
        }
    })
    assert body["latencyEvidenceProvenance"] == "SUPPLIED"
    assert bursty()["latencyEvidenceProvenance"] == "NONE"


def test_unstipulated_case_ranks_nothing():
    body = post({"model": LLAMA, "workload": {"horizonHours": "72"}})
    assert body["outcome"] == "NO_QUALIFIED_PLACEMENT"
    assert body["counts"]["ranked"] == 0
    assert body["counts"]["unresolved"] > 0


def test_excluded_candidates_never_appear_in_ranked():
    body = bursty(
        slos=[{"metric": "p99_latency_ms", "thresholdMs": "800"}],
        latencyEvidence={
            "cmi-scale-to-zero": {
                "p50Ms": "120", "p99Ms": "500", "coldStartMs": "45000",
                "sampleCount": 12000, "violationRateUpperBound": "0.004",
            },
            "sagemaker-ml.g5.2xlarge": {
                "p50Ms": "110", "p99Ms": "480", "sampleCount": 12000,
                "violationRateUpperBound": "0.003",
            },
        },
    )
    ranked_ids = {c["candidateId"] for c in body["ranked"]}
    excluded_ids = {c["candidateId"] for c in body["excluded"]}
    assert not (ranked_ids & excluded_ids)
    assert "cmi-scale-to-zero" in excluded_ids


def test_cheaper_but_too_slow_candidate_is_excluded():
    """The headline rule, asserted at the API boundary."""
    body = bursty(
        slos=[{"metric": "p99_latency_ms", "thresholdMs": "800"}],
        latencyEvidence={
            "cmi-scale-to-zero": {
                "p50Ms": "120", "p99Ms": "500", "coldStartMs": "45000",
                "sampleCount": 12000, "violationRateUpperBound": "0.004",
            },
            "sagemaker-ml.g5.2xlarge": {
                "p50Ms": "110", "p99Ms": "480", "sampleCount": 12000,
                "violationRateUpperBound": "0.003",
            },
        },
    )
    cmi = next(c for c in body["excluded"] if c["candidateId"] == "cmi-scale-to-zero")
    assert Decimal(cmi["cost"]["total"]) < Decimal(body["winner"]["cost"]["total"])
    gate = next(g for g in cmi["gates"] if g["name"] == "latency")
    assert gate["status"] == "FAIL"
    assert "cold restoration" in gate["reason"]


# --------------------------------------------------------------------------
# Errors and edges
# --------------------------------------------------------------------------


def test_missing_architecture_returns_400_with_specific_detail():
    resp = handler.lambda_handler(
        {"path": "/evaluate", "httpMethod": "POST", "body": json.dumps({"model": {}})}
    )
    assert resp["statusCode"] == 400
    body = json.loads(resp["body"])
    assert body["error"] == "invalid_request"
    assert "architecture" in body["detail"]


def test_malformed_json_returns_400():
    resp = handler.lambda_handler(
        {"path": "/evaluate", "httpMethod": "POST", "body": "{not json"}
    )
    assert resp["statusCode"] == 400
    assert json.loads(resp["body"])["error"] == "invalid_json"


def test_negative_horizon_rejected():
    resp = handler.lambda_handler({
        "path": "/evaluate", "httpMethod": "POST",
        "body": json.dumps({"model": LLAMA, "workload": {"horizonHours": "-5"}}),
    })
    assert resp["statusCode"] == 400
    assert "positive" in json.loads(resp["body"])["detail"]


def test_unknown_route_returns_404():
    resp = handler.lambda_handler({"path": "/nope", "httpMethod": "GET"})
    assert resp["statusCode"] == 404


def test_get_on_evaluate_returns_405():
    resp = handler.lambda_handler({"path": "/evaluate", "httpMethod": "GET"})
    assert resp["statusCode"] == 405


def test_options_preflight_returns_cors_headers():
    resp = handler.lambda_handler({"path": "/evaluate", "httpMethod": "OPTIONS"})
    assert resp["statusCode"] == 204
    assert "Access-Control-Allow-Origin" in resp["headers"]


def test_oversized_artifact_keeps_cpu_profiles_with_an_explained_memory_exclusion():
    body = post({
        "model": {"name": "big", "architecture": "DeepseekV3ForCausalLM",
                  "weightsGb": "700"},
        "workload": {"horizonHours": "720"},
        "assumeChecksCleared": True,
    })
    assert body["outcome"] == "NO_QUALIFIED_PLACEMENT"
    assert {c["target"] for c in body["excluded"]} == {"EC2_CPU", "AWS_BATCH_CPU"}
    for candidate in body["excluded"]:
        memory = next(g for g in candidate["gates"] if g["name"] == "cpu_memory")
        assert memory["status"] == "FAIL"
        assert "larger CPU profile" in memory["reason"]


def test_unsupported_architecture_never_ranks_on_cmi():
    body = post({
        "model": {"name": "DeepSeek V3", "architecture": "DeepseekV3ForCausalLM"},
        "workload": {"horizonHours": "720"},
        "assumeChecksCleared": True,
    })
    assert not [c for c in body["ranked"] if c["target"] == "BEDROCK_CMI"]


def test_determinism_same_request_same_hashes_and_order():
    a, b = bursty(), bursty()
    assert a["requestHash"] == b["requestHash"]
    assert a["snapshotHash"] == b["snapshotHash"]
    assert [c["candidateId"] for c in a["ranked"]] == [
        c["candidateId"] for c in b["ranked"]
    ]
