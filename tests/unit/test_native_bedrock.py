"""Native pricing and routing: fixtures are frozen API data, not benchmarks."""
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal

import pytest

from api.handler import parse_request
from catalog import native
from catalog.candidates import enumerate_candidates
from solver.models import GateStatus
from solver.solve import gate_region, solve

MODEL_ID = "amazon.nova-2-lite-v1:0"
PROFILE_ID = f"us.{MODEL_ID}"
REGIONS = ["us-east-1", "us-east-2", "us-west-2"]
AS_OF = "2026-09-19T00:00:00Z"


def product(direction, amount, sku=None, **attributes):
    return {
        "product": {"sku": sku or f"fixture-{direction}", "attributes": {
            "regionCode": "us-east-1", "model": "Nova 2.0 Lite",
            "feature": "On-demand Inference", "inferenceType": f"{direction.title()} tokens",
            "usagetype": f"USE1-Nova2.0Lite-{direction}-tokens", **attributes,
        }},
        "terms": {"OnDemand": {"term": {
            "effectiveDate": "2026-09-01T00:00:00Z",
            "priceDimensions": {"dimension": {
                "unit": "1K tokens", "beginRange": "0", "endRange": "Inf",
                "pricePerUnit": {"USD": amount}, "appliesTo": [],
            }},
        }}},
    }


PRODUCTS = [product("input", "0.00033"), product("output", "0.00275")]


class Bedrock:
    def get_foundation_model(self, **kwargs):
        assert kwargs["modelIdentifier"] == MODEL_ID
        return {"modelDetails": {
            "modelId": MODEL_ID, "modelName": "Nova 2 Lite",
            "inputModalities": ["TEXT", "IMAGE", "VIDEO"], "outputModalities": ["TEXT"],
            "inferenceTypesSupported": ["INFERENCE_PROFILE"], "responseStreamingSupported": True,
        }}

    def list_inference_profiles(self, **kwargs):
        assert kwargs["typeEquals"] == "SYSTEM_DEFINED"
        return {"inferenceProfileSummaries": [{
            "inferenceProfileId": PROFILE_ID, "inferenceProfileName": "US Amazon Nova 2 Lite",
            "status": "ACTIVE", "models": [
                {"modelArn": f"arn:aws:bedrock:{region}::foundation-model/{MODEL_ID}"}
                for region in REGIONS
            ],
        }, {
            "inferenceProfileId": f"global.{MODEL_ID}", "status": "ACTIVE",
            "models": [{"modelArn": f"arn:aws:bedrock:::foundation-model/{MODEL_ID}"}],
        }]}


class Pricing:
    def get_products(self, **kwargs):
        assert kwargs["ServiceCode"] == "AmazonBedrock"
        filters = {item["Field"]: item["Value"] for item in kwargs["Filters"]}
        assert filters == {"model": "Nova 2.0 Lite", "regionCode": "us-east-1"}
        return {"PriceList": deepcopy(PRODUCTS)}


@pytest.fixture
def aws(monkeypatch):
    monkeypatch.setattr(native, "_bedrock", lambda _: Bedrock())
    monkeypatch.setattr(native, "pricing_client", Pricing)


def payload():
    return {
        "caseId": "native-fixture",
        "model": {"name": MODEL_ID, "architecture": "vendor-api", "sourceKind": "bedrock",
                  "weightsExportable": False, "inferenceProfileId": PROFILE_ID},
        "constraints": {"permittedRegions": ["us-east-1"], "permittedProcessingRegions": REGIONS,
                        "budgetUsd": "2000"},
        "workload": {"horizonHours": "720", "requests": "30000", "inputTokensPerRequest": "1000",
                     "outputTokensPerRequest": "250"},
    }


def test_realistic_text_quote_normalizes_units_and_never_qualifies_access_or_latency(aws):
    body = payload()
    request = parse_request(body)
    assert enumerate_candidates(request) == ()
    collected = native.collect_native(request)
    decision = solve(request, collected.candidates, collected.snapshot)
    assert not decision.ranked
    candidate = decision.unresolved[0]
    assert candidate.cost.total == Decimal("30.525")
    assert candidate.cost.display_total() == Decimal("30.53")
    gates = {gate.name: gate for gate in candidate.gates}
    assert gates["region"].status is GateStatus.PASS
    assert gates["quota"].status is GateStatus.UNKNOWN
    assert gates["license"].status is GateStatus.UNKNOWN
    assert "No latency objective" in gates["latency"].reason
    quote = collected.pricing[0]
    assert Decimal(quote["inputRate"]["amount"]) == Decimal(".33")
    assert Decimal(quote["outputRate"]["amount"]) == Decimal("2.75")
    assert quote["inputRate"]["sku"] and quote["inputRate"]["effectiveDate"]

    body["workload"]["requests"] = "60000"
    doubled = native.collect_native(parse_request(body))
    assert next(iter(doubled.snapshot.per_candidate.values())).cost.total == Decimal("61.05")


def test_strict_single_region_is_not_silently_expanded_for_a_profile(aws):
    body = payload()
    del body["constraints"]["permittedProcessingRegions"]
    request = parse_request(body)
    collected = native.collect_native(request)
    gate = gate_region(collected.candidates[0], request)
    assert gate.status is GateStatus.FAIL
    assert "us-east-2" in gate.reason and "us-west-2" in gate.reason


def test_missing_route_remains_unresolved_and_cannot_reuse_a_different_route_benchmark(aws):
    body = payload()
    original = native.collect_native(parse_request(body))
    del body["model"]["inferenceProfileId"]
    request = parse_request(body)
    collected = native.collect_native(request)
    assert gate_region(collected.candidates[0], request).status is GateStatus.UNKNOWN
    assert original.candidates[0].candidate_id != collected.candidates[0].candidate_id


def test_global_route_is_not_quoted_using_regional_rates(aws):
    body = payload()
    body["model"]["inferenceProfileId"] = f"global.{MODEL_ID}"
    request = parse_request(body)
    collected = native.collect_native(request)
    assert gate_region(collected.candidates[0], request).status is GateStatus.UNKNOWN
    assert collected.pricing[0]["inputRate"] is None
    assert next(iter(collected.snapshot.per_candidate.values())).cost is None


@pytest.mark.parametrize("missing", ["requests", "inputTokensPerRequest", "outputTokensPerRequest"])
def test_unknown_usage_shows_rates_without_a_zero_total(aws, missing):
    body = payload()
    del body["workload"][missing]
    collected = native.collect_native(parse_request(body))
    assert next(iter(collected.snapshot.per_candidate.values())).cost is None
    assert collected.pricing[0]["inputRate"] is not None
    assert len(collected.pricing[0]["missingUsage"]) == 1


def test_tighter_budget_and_unmeasured_ttft_change_actual_gates(aws):
    body = payload()
    body["constraints"]["budgetUsd"] = "20"
    body["slos"] = [{"metric": "ttft_ms", "percentile": "99", "thresholdMs": "1000", "includeCold": True}]
    request = parse_request(body)
    collected = native.collect_native(request)
    decision = solve(request, collected.candidates, collected.snapshot)
    candidate = decision.excluded[0]
    gates = {gate.name: gate.status for gate in candidate.gates}
    assert gates["budget"] is GateStatus.FAIL
    assert gates["latency"] is GateStatus.UNKNOWN
    assert candidate.cost.total == Decimal("30.525")


@pytest.mark.parametrize("attrs", [
    {"service_tier": "priority"}, {"usagetype": "input-tokens-cross-region-global"},
    {"feature": "Batch Inference"}, {"modality": "video"}, {"regionCode": "us-west-2"},
])
def test_other_billing_products_are_not_substituted(attrs):
    rows = [product("input", ".0001", **attrs)]
    assert native._rate_from_products(rows, "input", "us-east-1", "Nova 2.0 Lite", AS_OF) is None


def test_ambiguous_skus_tiers_future_prices_and_unknown_units_fail_closed():
    first = product("input", ".00033")
    assert native._rate_from_products(
        [first, product("input", ".0001", sku="another")], "input", "us-east-1", "Nova 2.0 Lite", AS_OF
    ) is None
    for change in ("unit", "tier", "future"):
        row = deepcopy(first)
        term = row["terms"]["OnDemand"]["term"]
        if change == "unit":
            term["priceDimensions"]["dimension"]["unit"] = "hours"
        elif change == "tier":
            term["priceDimensions"]["second"] = deepcopy(term["priceDimensions"]["dimension"])
        else:
            term["effectiveDate"] = "2099-01-01T00:00:00Z"
        assert native._rate_from_products([row], "input", "us-east-1", "Nova 2.0 Lite", AS_OF) is None


def test_profile_catalog_pagination_must_finish_before_any_routes_are_trusted():
    class Unending(Bedrock):
        def list_inference_profiles(self, **kwargs):
            return {**super().list_inference_profiles(**kwargs), "nextToken": "more"}
    with pytest.raises(RuntimeError, match="pagination"):
        native._profiles(Unending())


def test_parser_keeps_explicit_route_and_residency_in_request_identity():
    request = parse_request(payload())
    assert request.model.inference_profile_id == PROFILE_ID
    assert request.constraints.permitted_processing_regions == tuple(REGIONS)
    assert request.input_hash() != replace(
        request, constraints=replace(request.constraints, permitted_processing_regions=())
    ).input_hash()
