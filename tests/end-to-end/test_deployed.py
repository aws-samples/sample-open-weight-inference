"""End-to-end tests against a deployed EDDIE environment.

These hit real AWS: live Price List rates, the real Bedrock catalogue, and the
deployed Lambda. They are skipped unless EDDIE_API_URL is set, so the default test
run stays offline and fast.

    EDDIE_API_URL=https://<id>.execute-api.us-east-1.amazonaws.com/prod \
    EDDIE_SITE_URL=https://<dist>.cloudfront.net \
        ./.venv/bin/python -m pytest tests/end-to-end -v

Passing these proves the deployed application works. It does not measure model
latency and does not qualify any p99.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from decimal import Decimal

import pytest

from netio import open_url

API = os.environ.get("EDDIE_API_URL", "").rstrip("/")
SITE = os.environ.get("EDDIE_SITE_URL", "").rstrip("/")

pytestmark = pytest.mark.skipif(not API, reason="EDDIE_API_URL not set")

TIMEOUT = 60

LLAMA = {
    "name": "Llama 3.1 8B",
    "architecture": "LlamaForCausalLM",
    "weightsGb": "16",
    "contextTokens": 128000,
}


def get(path: str) -> tuple[int, dict]:
    with open_url(f"{API}{path}", timeout=TIMEOUT) as r:
        return r.status, json.loads(r.read())


def post(path: str, payload: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with open_url(req, timeout=TIMEOUT) as r:
        return r.status, json.loads(r.read())


def evaluate(**overrides) -> dict:
    body = {
        "caseId": "e2e",
        "model": LLAMA,
        "workload": {"horizonHours": "72", "billableCopyHours": "6"},
        "assumeChecksCleared": True,
    }
    body.update(overrides)
    status, data = post("/evaluate", body)
    assert status == 200, data
    return data


# --------------------------------------------------------------------------
# Service health and live evidence
# --------------------------------------------------------------------------


def test_health_reports_ok_and_price_list_reachable():
    status, body = get("/health")
    assert status == 200, body
    assert body["status"] == "OK"
    assert body["priceList"]["status"] == "OK"
    assert body["solverVersion"]


def test_rates_are_live_with_sku_and_effective_date():
    """Prices must be real observations, not constants baked into the code."""
    status, body = get("/rates")
    assert status == 200
    sm = body["rates"]["sagemakerInstanceHour"]
    assert sm is not None, "no SageMaker rate returned"
    assert Decimal(sm["amount"]) > 0
    assert sm["sku"], "rate has no SKU"
    assert sm["effectiveDate"], "rate has no effective date"
    assert body["freshness"]["sagemaker"] in ("LIVE", "PINNED")


def test_cmi_rates_resolve_for_llama_family():
    status, body = get("/rates?architecture=LlamaForCausalLM")
    assert status == 200
    assert body["cmiFamily"] == "Llama"
    per_min = body["rates"]["cmiPerCmuMinute"]
    assert per_min is not None
    assert Decimal(per_min["amount"]) > 0


def test_unmapped_architecture_returns_no_cmi_rate_rather_than_guessing():
    """Borrowing another family's rate would misprice silently."""
    status, body = get("/rates?architecture=DeepseekV3ForCausalLM")
    assert status == 200
    assert body["cmiFamily"] is None
    assert body["rates"]["cmiPerCmuMinute"] is None


def test_catalog_lists_native_models_from_the_account():
    status, body = get("/catalog/models")
    assert status == 200
    assert body["count"] > 0
    sample = body["models"][0]
    assert sample["modelId"]
    assert "inputModalities" in sample


# --------------------------------------------------------------------------
# The economic result, computed from live prices
# --------------------------------------------------------------------------


def test_bursty_event_ranks_cmi_first():
    body = evaluate()
    assert body["outcome"] == "QUALIFIED_PLACEMENT"
    assert body["winner"]["target"] == "BEDROCK_CMI"
    assert Decimal(body["winner"]["cost"]["total"]) > 0


def test_always_on_ranks_dedicated_first():
    """Same artifact, inverted answer. This is the product's central claim."""
    body = evaluate(workload={"horizonHours": "720", "billableCopyHours": "720"})
    assert body["winner"]["target"] == "SAGEMAKER_REALTIME"


def test_traffic_shape_alone_inverts_the_winner():
    bursty = evaluate()
    steady = evaluate(workload={"horizonHours": "720", "billableCopyHours": "720"})
    assert bursty["winner"]["target"] != steady["winner"]["target"]


def test_breakeven_is_reported_with_a_verdict():
    be = evaluate()["breakeven"]
    assert be is not None
    assert Decimal(be["breakevenDutyPercent"]) > 0
    assert Decimal(be["actualDutyPercent"]) < Decimal(be["breakevenDutyPercent"])
    assert be["verdict"] == "BURST_FAVOURS_CMI"


def test_every_cost_line_item_is_traceable_to_a_sku():
    for item in evaluate()["winner"]["cost"]["items"]:
        assert item["rate"] is not None
        assert item["rate"]["sku"], f"{item['label']} has no SKU"
        assert item["rate"]["source"], f"{item['label']} has no source"


# --------------------------------------------------------------------------
# Feasibility gates on the deployed service
# --------------------------------------------------------------------------


def test_cold_start_excludes_the_cheaper_candidate():
    """Latency eliminates. Being $64 cheaper is not a defence."""
    body = evaluate(
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
    excluded = {c["candidateId"]: c for c in body["excluded"]}
    assert "cmi-scale-to-zero" in excluded
    cmi = excluded["cmi-scale-to-zero"]
    gate = next(g for g in cmi["gates"] if g["name"] == "latency")
    assert gate["status"] == "FAIL"
    assert Decimal(cmi["cost"]["total"]) < Decimal(body["winner"]["cost"]["total"])


def test_smoke_sample_count_cannot_qualify_a_tail():
    body = evaluate(
        slos=[{"metric": "p99_latency_ms", "thresholdMs": "800"}],
        latencyEvidence={
            "cmi-scale-to-zero": {
                "p50Ms": "50", "p99Ms": "100", "sampleCount": 150,
                "violationRateUpperBound": "0.001",
            }
        },
    )
    cmi = next(
        (c for c in body["unresolved"] if c["candidateId"] == "cmi-scale-to-zero"), None
    )
    assert cmi is not None, "a 150-sample run should not qualify a p99"
    gate = next(g for g in cmi["gates"] if g["name"] == "latency")
    assert gate["status"] == "UNKNOWN"
    assert "INSUFFICIENT_EVIDENCE" in gate["reason"]


def test_unstipulated_case_ranks_nothing():
    status, body = post(
        "/evaluate",
        {"model": LLAMA, "workload": {"horizonHours": "72", "billableCopyHours": "6"}},
    )
    assert status == 200
    assert body["outcome"] == "NO_QUALIFIED_PLACEMENT"
    assert body["counts"]["ranked"] == 0
    assert body["checksStipulated"] is False


def test_budget_ceiling_excludes_candidates():
    body = evaluate(
        workload={"horizonHours": "720", "billableCopyHours": "720"},
        constraints={"budgetUsd": "10"},
    )
    assert body["counts"]["ranked"] == 0
    reasons = [
        g["reason"]
        for c in body["excluded"]
        for g in c["gates"]
        if g["name"] == "budget" and g["status"] == "FAIL"
    ]
    assert reasons, "budget ceiling did not exclude anything"


def test_unsupported_architecture_is_never_placed_on_cmi():
    body = evaluate(
        model={"name": "DeepSeek V3", "architecture": "DeepseekV3ForCausalLM"},
        workload={"horizonHours": "720"},
    )
    assert not [c for c in body["ranked"] if c["target"] == "BEDROCK_CMI"]


def test_speech_model_is_not_placed_on_cmi():
    body = evaluate(
        model={
            "name": "voice", "architecture": "LlamaForCausalLM",
            "modality": "SPEECH_TO_SPEECH",
        },
        workload={"horizonHours": "72"},
    )
    assert not [c for c in body["ranked"] if c["target"] == "BEDROCK_CMI"]


def test_determinism_across_separate_requests():
    a, b = evaluate(), evaluate()
    assert a["requestHash"] == b["requestHash"]
    assert [c["candidateId"] for c in a["ranked"]] == [
        c["candidateId"] for c in b["ranked"]
    ]
    assert [c["cost"]["total"] for c in a["ranked"]] == [
        c["cost"]["total"] for c in b["ranked"]
    ]


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


def test_invalid_request_returns_400():
    with pytest.raises(urllib.error.HTTPError) as exc:
        post("/evaluate", {"model": {}, "workload": {}})
    assert exc.value.code == 400
    assert "architecture" in json.loads(exc.value.read())["detail"]


def test_unknown_route_returns_404():
    with pytest.raises(urllib.error.HTTPError) as exc:
        get("/does-not-exist")
    assert exc.value.code == 404


# --------------------------------------------------------------------------
# Frontend delivery
# --------------------------------------------------------------------------


@pytest.mark.skipif(not SITE, reason="EDDIE_SITE_URL not set")
def test_frontend_is_served_over_cloudfront():
    req = urllib.request.Request(SITE, headers={"user-agent": "eddie-e2e"})
    with open_url(req, timeout=TIMEOUT) as r:
        body = r.read().decode("utf-8", "replace")
    assert r.status == 200
    assert 'id="root"' in body or "id='root'" in body


@pytest.mark.skipif(not SITE, reason="EDDIE_SITE_URL not set")
def test_frontend_runtime_config_points_at_the_api():
    with open_url(f"{SITE}/config.json", timeout=TIMEOUT) as r:
        cfg = json.loads(r.read())
    assert cfg["apiBaseUrl"].startswith("https://")
    assert cfg["releaseId"]


@pytest.mark.skipif(not SITE, reason="EDDIE_SITE_URL not set")
def test_frontend_sends_security_headers():
    req = urllib.request.Request(SITE, headers={"user-agent": "eddie-e2e"})
    with open_url(req, timeout=TIMEOUT) as r:
        headers = {k.lower(): v for k, v in r.headers.items()}
    assert "strict-transport-security" in headers
    assert headers.get("x-content-type-options") == "nosniff"
    assert headers.get("x-frame-options") == "DENY"
