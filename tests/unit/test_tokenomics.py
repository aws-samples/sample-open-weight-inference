"""Public-price comparisons. Rates are deliberately synthetic test inputs."""
from copy import deepcopy
from decimal import Decimal
from types import SimpleNamespace
import json

import pytest

from catalog import tokenomics as t


def request(**changes):
    return {"instanceType": "p6-b200.48xlarge", "region": "us-east-1",
            "poolSizes": [1, 2], "hoursPerDay": "24", **changes}


def prices():
    offers = {}
    for plan in t.PLAN_TYPES:
        for years in (1, 3):
            for payment in t.PAYMENTS:
                offers[t.offer_key(plan, years, payment)] = {
                    "status": "AVAILABLE", "hourlyRateUsd": "4",
                    "offeringId": f"synthetic-{plan}-{years}-{payment}", "sourceUrl": t.SP_SOURCE,
                }
    return {
        "onDemand": {"status": "AVAILABLE", "hourlyRateUsd": "10", "sku": "synthetic",
                     "sourceUrl": t.OD_SOURCE},
        "savingsPlans": offers, "retrievedAt": "2026-10-03T00:00:00+00:00",
    }


def by_id(report):
    return {row["id"]: row for row in report["rows"]}


def test_one_and_three_year_commitments_are_distinct_from_annual_cost():
    report = t.compare(request(monthlyOutputTokens="1000000"), prices=prices())
    rows = by_id(report)
    assert report["scope"] == "PUBLIC_EC2_COMPUTE_ESTIMATE"
    assert len(rows) == 13 and report["hardware"]["gpus"] == 8
    assert rows["on-demand"]["pools"][0]["annualCostUsd"] == "87600.00"
    assert rows["on-demand"]["pools"][0]["termCommitmentUsd"] is None
    annual = rows["Compute-1-no-upfront"]["pools"][0]
    three_year = rows["EC2Instance-3-no-upfront"]["pools"][0]
    assert annual["annualCostUsd"] == three_year["annualCostUsd"] == "35040.00"
    assert annual["termCommitmentUsd"] == "35040.00"
    assert three_year["termCommitmentUsd"] == "105120.00"
    assert annual["monthlyEquivalentUsd"] == "2920.00"
    assert annual["savingsPercent"] == "60.0"
    assert annual["costPerMillionOutputTokensUsd"] == "2920.0000"
    second = rows["Compute-1-no-upfront"]["pools"][1]
    assert Decimal(second["annualCostUsd"]) == 2 * Decimal(annual["annualCostUsd"])
    assert second["costPerMillionOutputTokensUsd"] == "5840.0000"  # Same supplied workload.
    assert len(report["quoteHash"]) == 64


def test_payment_timing_never_hides_full_upfront_cash_or_invents_partial_payment():
    rows = by_id(t.compare(request(), prices=prices()))
    prepaid = rows["EC2Instance-3-all-upfront"]["pools"][0]
    partial = rows["EC2Instance-3-partial-upfront"]["pools"][0]
    deferred = rows["Compute-1-no-upfront"]["pools"][0]
    assert prepaid["upfrontUsd"] == prepaid["termCommitmentUsd"] == "105120.00"
    assert prepaid["recurringMonthlyUsd"] == "0.00"
    assert prepaid["monthlyEquivalentUsd"] == "2920.00"
    assert partial["upfrontUsd"] is None and partial["recurringMonthlyUsd"] is None
    assert partial["annualCostUsd"] == "35040.00"
    assert deferred["upfrontUsd"] == "0.00"
    assert deferred["recurringMonthlyUsd"] == "2920.00"


def test_idle_hours_can_make_the_commitment_more_expensive_than_on_demand():
    rows = by_id(t.compare(request(hoursPerDay="6"), prices=prices()))
    od = rows["on-demand"]["pools"][0]
    sp = rows["Compute-1-no-upfront"]["pools"][0]
    assert od["annualCostUsd"] == "21900.00"
    assert sp["annualCostUsd"] == "35040.00"  # Never multiply the SP by six hours.
    assert sp["annualSavingsUsd"] == "-13140.00" and sp["savingsPercent"] == "-60.0"
    assert rows["Compute-1-no-upfront"]["breakEvenAllocatedPercent"] == "40.0"
    zero = by_id(t.compare(request(hoursPerDay="0"), prices=prices()))
    assert zero["Compute-1-no-upfront"]["pools"][0]["savingsPercent"] is None
    assert zero["Compute-1-no-upfront"]["pools"][0]["annualCostUsd"] == "35040.00"


def test_absent_terms_and_failed_lookups_never_become_free_or_estimated_discounts():
    evidence = prices()
    evidence["savingsPlans"]["EC2Instance-1-no-upfront"] = {
        "status": "NOT_LISTED", "reason": "No matching public offer."}
    rows = by_id(t.compare(request(), prices=evidence))
    row = rows["EC2Instance-1-no-upfront"]
    assert row["status"] == "NOT_LISTED" and row["effectiveHourlyRateUsd"] is None
    assert all(pool["annualCostUsd"] is None for pool in row["pools"])
    evidence["onDemand"] = {"status": "UNAVAILABLE"}
    evidence["savingsPlans"] = {"status": "UNAVAILABLE", "reason": "Access unavailable"}
    rows = by_id(t.compare(request(), prices=evidence))
    for row in rows.values():
        assert row["status"] == "UNAVAILABLE"
        assert all(pool["annualCostUsd"] is None and pool["upfrontUsd"] is None
                   and pool["savingsPercent"] is None for pool in row["pools"])


@pytest.mark.parametrize("changes", [
    {"instanceType": "p6-b200.48xlarge/../../secret"}, {"instanceType": True},
    {"region": "https://example.com"}, {"region": "us-east-1.attacker.example"},
    {"poolSizes": [1, 1]}, {"poolSizes": [1.5]}, {"poolSizes": [True]},
    {"poolSizes": [0]}, {"poolSizes": [1025]}, {"poolSizes": []},
    {"poolSizes": [1, 2, 3, 4, 5]}, {"hoursPerDay": "NaN"},
    {"hoursPerDay": "-1"}, {"hoursPerDay": "24.1"}, {"monthlyOutputTokens": "Infinity"},
    {"monthlyOutputTokens": "0"}, {"monthlyOutputTokens": "1e19"},
])
def test_input_limits_are_enforced_before_any_network_request(monkeypatch, changes):
    monkeypatch.setattr(t, "collect_prices", lambda *_: pytest.fail("must validate first"))
    with pytest.raises(ValueError):
        t.compare(request(**changes))


def od_product(rate="10", **attrs):
    return json.dumps({
        "product": {"sku": "synthetic-od", "attributes": {
            "instanceType": "p6-b200.48xlarge", "regionCode": "us-east-1",
            "operatingSystem": "Linux", "tenancy": "Shared", "preInstalledSw": "NA",
            "capacitystatus": "Used", "operation": "RunInstances", **attrs}},
        "terms": {"OnDemand": {"term": {"effectiveDate": "2026-10-01T00:00:00Z",
            "priceDimensions": {"dimension": {"rateCode": "synthetic-rate", "unit": "Hrs",
                "beginRange": "0", "endRange": "Inf", "pricePerUnit": {"USD": rate}}}}}},
    })


def sp_offer(rate="4", plan="Compute", years=1, payment="No Upfront", **properties):
    return {
        "rate": rate, "unit": "Hrs", "productType": "EC2", "serviceCode": "AmazonEC2",
        "operation": "RunInstances", "usageType": "BoxUsage:p6-b200.48xlarge",
        "savingsPlanOffering": {"currency": "USD", "durationSeconds": years * 31536000,
            "offeringId": f"synthetic-{plan}-{years}", "planType": plan, "paymentOption": payment},
        "properties": [{"name": key, "value": value} for key, value in {
            "region": "us-east-1", "instanceType": "p6-b200.48xlarge",
            "productDescription": "Linux/UNIX", "tenancy": "shared", **properties}.items()],
    }


def test_on_demand_filters_and_returned_dimensions_both_match():
    calls = []
    pages = [{"PriceList": [od_product(regionCode="us-west-2"), od_product(operatingSystem="Windows")],
              "NextToken": "page2"}, {"PriceList": [od_product()]}]

    def get(**kwargs):
        calls.append(kwargs)
        return pages.pop(0)

    result = t.collect_on_demand("p6-b200.48xlarge", "us-east-1", SimpleNamespace(get_products=get))
    assert result["hourlyRateUsd"] == "10"
    assert calls[1]["NextToken"] == "page2"
    filters = {row["Field"]: row["Value"] for row in calls[0]["Filters"]}
    assert filters["operatingSystem"] == "Linux" and filters["regionCode"] == "us-east-1"
    assert filters["tenancy"] == "Shared" and filters["capacitystatus"] == "Used"


def test_savings_plans_use_public_offerings_and_verify_all_scope_fields():
    calls = []
    wrong_currency = sp_offer()
    wrong_currency["savingsPlanOffering"]["currency"] = "CNY"
    wrong_term = sp_offer(years=2)
    data = [sp_offer(region="us-west-2"), sp_offer(tenancy="dedicated"),
            sp_offer(productDescription="Windows"), wrong_currency, wrong_term,
            sp_offer(plan="EC2Instance", years=3, payment="All Upfront")]

    def offering_rates(**kwargs):
        calls.append(kwargs)
        return {"searchResults": data}

    result = t.collect_savings_plans("p6-b200.48xlarge", "us-east-1",
                                    SimpleNamespace(describe_savings_plans_offering_rates=offering_rates))
    assert calls[0]["savingsPlanTypes"] == ["Compute", "EC2Instance"]
    assert calls[0]["products"] == ["EC2"] and calls[0]["operations"] == ["RunInstances"]
    assert result["EC2Instance-3-all-upfront"]["hourlyRateUsd"] == "4"
    assert result["Compute-1-no-upfront"]["status"] == "NOT_LISTED"
    assert len(result) == 12


def test_conflicting_or_truncated_catalogues_fail_closed():
    od = SimpleNamespace(get_products=lambda **_: {"PriceList": [od_product("9"), od_product("10")]})
    assert t.collect_on_demand("p6-b200.48xlarge", "us-east-1", od)["status"] == "UNAVAILABLE"
    sp = SimpleNamespace(describe_savings_plans_offering_rates=lambda **_: {
        "searchResults": [sp_offer("4"), sp_offer("5")]})
    assert t.collect_savings_plans("p6-b200.48xlarge", "us-east-1", sp)[
        "Compute-1-no-upfront"]["status"] == "UNAVAILABLE"
    sp = SimpleNamespace(describe_savings_plans_offering_rates=lambda **_: {
        "searchResults": [sp_offer()], "nextToken": "still-more"})
    assert all(row["status"] == "UNAVAILABLE" for row in
               t.collect_savings_plans("p6-b200.48xlarge", "us-east-1", sp).values())


def test_boto_sdk_accepts_the_public_api_request_and_response_contracts():
    import boto3
    from botocore.stub import Stubber
    # Synthetic test credentials prevent the SDK from consulting a real profile.
    clients = {name: boto3.client(name, region_name="us-east-1",
               aws_access_key_id="testing", aws_secret_access_key="testing")
               for name in ("pricing", "savingsplans")}
    with Stubber(clients["pricing"]) as stub:
        stub.add_response("get_products", {"PriceList": [od_product()]})
        assert t.collect_on_demand("p6-b200.48xlarge", "us-east-1", clients["pricing"])["status"] == "AVAILABLE"
    with Stubber(clients["savingsplans"]) as stub:
        stub.add_response("describe_savings_plans_offering_rates", {"searchResults": [sp_offer()]})
        assert t.collect_savings_plans("p6-b200.48xlarge", "us-east-1", clients["savingsplans"])[
            "Compute-1-no-upfront"]["status"] == "AVAILABLE"


def test_public_cache_is_bounded_and_failed_access_is_retryable(monkeypatch):
    t._CACHE.clear()
    calls = []
    monkeypatch.setattr(t, "collect_on_demand", lambda *a: calls.append("od") or prices()["onDemand"])
    monkeypatch.setattr(t, "collect_savings_plans", lambda *a: calls.append("sp") or prices()["savingsPlans"])
    first = t.collect_prices("p6-b200.48xlarge", "us-east-1")
    first["onDemand"]["hourlyRateUsd"] = "999"
    second = t.collect_prices("p6-b200.48xlarge", "us-east-1")
    assert second["onDemand"]["hourlyRateUsd"] == "10" and len(calls) == 2
    t._CACHE.clear()
    monkeypatch.setattr(t, "collect_savings_plans", lambda *a: (_ for _ in ()).throw(RuntimeError("secret")))
    failed = t.collect_prices("p6-b200.48xlarge", "us-east-1")
    assert failed["savingsPlans"]["status"] == "UNAVAILABLE" and not t._CACHE
    assert "secret" not in json.dumps(failed)


def test_payload_cannot_supply_prices_discounts_or_customer_billing_inputs(monkeypatch):
    calls = []
    monkeypatch.setattr(t, "collect_prices", lambda *a: calls.append(a) or prices())
    report = t.compare(request(prices={"onDemand": {"hourlyRateUsd": "0"}}, accountId="000000000000", ppa="90"))
    assert calls == [("p6-b200.48xlarge", "us-east-1")]
    assert by_id(report)["on-demand"]["effectiveHourlyRateUsd"] == "10"
    assert "accountId" not in report and "ppa" not in report


def test_tokenomics_requires_authenticated_read_permission_and_exposes_no_purchase_action():
    from runtime.principal import (
        ACTION_CAPABILITY, PUBLIC_ACTIONS, Capability, Principal, AuthorizationError, authorize_action,
    )
    assert ACTION_CAPABILITY["tokenomics.compare"] == Capability.READ
    assert "tokenomics.compare" not in PUBLIC_ACTIONS
    reader = Principal("test-user", "test-user", frozenset({Capability.READ}))
    authorize_action(reader, "tokenomics.compare")
    with pytest.raises(AuthorizationError):
        authorize_action(Principal("no-rights", "no-rights", frozenset()), "tokenomics.compare")
    assert not any("purchase" in action or "savingsplan.create" in action for action in ACTION_CAPABILITY)
