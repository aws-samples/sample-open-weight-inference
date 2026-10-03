"""Public EC2 and Savings Plans economics, with explicit commitment boundaries.

No Cost Explorer, purchased-plan, customer-discount, or purchasing API is used.
Only matching Linux/shared EC2 offering rates are compared. Missing or ambiguous
offers stay unavailable. A smaller usage schedule never reduces an SP commitment.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

import boto3
from botocore.config import Config

from .accelerators import ACCELERATORS, AWS_SPECS, REVIEWED

log = logging.getLogger(__name__)
HOURS_PER_YEAR = Decimal("8760")  # AWS defines an SP year as 365 days.
TERMS = {31_536_000: 1, 94_608_000: 3}
PAYMENTS = ("No Upfront", "Partial Upfront", "All Upfront")
PLAN_TYPES = ("Compute", "EC2Instance")
OD_SOURCE = "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html"
SP_SOURCE = "https://docs.aws.amazon.com/savingsplans/latest/APIReference/API_DescribeSavingsPlansOfferingRates.html"
SP_GUIDE = "https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html"
PLAN_GUIDE = "https://docs.aws.amazon.com/savingsplans/latest/userguide/plan-types.html"
_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}
_CACHE_LOCK = threading.Lock()
_TTL_SECONDS = 1800
_CONFIG = Config(connect_timeout=3, read_timeout=8, retries={"total_max_attempts": 2, "mode": "standard"})


def _number(value: Any, name: str, minimum: Decimal, maximum: Decimal) -> Decimal:
    try:
        if isinstance(value, bool):
            raise ValueError
        result = Decimal(str(value))
        if not result.is_finite() or not minimum <= result <= maximum:
            raise ValueError
        return result
    except (ValueError, TypeError, InvalidOperation) as error:
        raise ValueError(f"{name} must be a number from {minimum} to {maximum}.") from error


def parse_inputs(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Supply a GPU pool to compare.")
    instance = payload.get("instanceType", "")
    region = payload.get("region", "")
    if not isinstance(instance, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,20}\.[a-z0-9]{1,20}", instance):
        raise ValueError("Choose an EC2 instance type, such as p6-b200.48xlarge.")
    if not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+){1,2}-\d", region):
        raise ValueError("Choose an AWS Region.")
    sizes = payload.get("poolSizes", [1, 2])
    if not isinstance(sizes, list) or not 1 <= len(sizes) <= 4:
        raise ValueError("Compare one to four pool sizes.")
    counts = []
    for value in sizes:
        count = _number(value, "Pool size", Decimal("1"), Decimal("1024"))
        if count != count.to_integral_value() or int(count) in counts:
            raise ValueError("Pool sizes must be distinct whole numbers.")
        counts.append(int(count))
    hours = _number(payload.get("hoursPerDay", "24"), "Allocated hours per day", Decimal("0"), Decimal("24"))
    tokens = payload.get("monthlyOutputTokens")
    if tokens in ("", None):
        tokens = None
    else:
        tokens = _number(tokens, "Monthly output tokens", Decimal("1"), Decimal("1e18"))
    return {"instanceType": instance, "region": region, "poolSizes": counts,
            "hoursPerDay": hours, "monthlyOutputTokens": tokens}


def _client(service: str):
    return boto3.client(service, region_name="us-east-1", config=_CONFIG)


def collect_on_demand(instance: str, region: str, client=None) -> dict:
    """Require a single unambiguous public Linux/shared RunInstances rate."""
    expected = {"instanceType": instance, "regionCode": region, "operatingSystem": "Linux",
                "tenancy": "Shared", "preInstalledSw": "NA", "capacitystatus": "Used",
                "operation": "RunInstances"}
    client = client or _client("pricing")
    token, matches = None, []
    for _ in range(4):
        params = {"ServiceCode": "AmazonEC2", "MaxResults": 100,
                  "Filters": [{"Type": "TERM_MATCH", "Field": key, "Value": value}
                              for key, value in expected.items()]}
        if token:
            params["NextToken"] = token
        response = client.get_products(**params)
        for raw in response.get("PriceList", []):
            product = json.loads(raw) if isinstance(raw, str) else raw
            attrs = product.get("product", {}).get("attributes", {})
            if any(attrs.get(key) != value for key, value in expected.items()):
                continue
            for term in product.get("terms", {}).get("OnDemand", {}).values():
                for dimension in term.get("priceDimensions", {}).values():
                    if (dimension.get("unit") != "Hrs" or dimension.get("beginRange") != "0"
                            or dimension.get("endRange") != "Inf"):
                        continue
                    rate = _number(dimension.get("pricePerUnit", {}).get("USD"), "Public rate",
                                   Decimal("0.000000001"), Decimal("1000000"))
                    matches.append({"status": "AVAILABLE", "hourlyRateUsd": str(rate),
                                    "sku": product["product"]["sku"], "rateCode": dimension.get("rateCode"),
                                    "effectiveDate": term.get("effectiveDate"), "sourceUrl": OD_SOURCE})
        token = response.get("NextToken")
        if not token:
            break
    if token:
        return {"status": "UNAVAILABLE", "reason": "The public price lookup did not complete."}
    if not matches:
        return {"status": "NOT_LISTED", "reason": "No matching Linux/shared On-Demand rate was returned."}
    if len({Decimal(row["hourlyRateUsd"]) for row in matches}) != 1:
        return {"status": "UNAVAILABLE", "reason": "The public catalogue returned conflicting On-Demand rates."}
    return matches[0]


def offer_key(plan: str, years: int, payment: str) -> str:
    return f"{plan}-{years}-{payment.lower().replace(' ', '-')}"


def collect_savings_plans(instance: str, region: str, client=None) -> dict:
    """Offering rates are public prices, not rates from an account's owned plans."""
    expected = {"region": region, "instanceType": instance,
                "productDescription": "Linux/UNIX", "tenancy": "shared"}
    client = client or _client("savingsplans")
    token, matches = None, {}
    for _ in range(4):
        params = {
            "products": ["EC2"], "serviceCodes": ["AmazonEC2"], "operations": ["RunInstances"],
            "savingsPlanTypes": list(PLAN_TYPES), "savingsPlanPaymentOptions": list(PAYMENTS),
            "filters": [{"name": key, "values": [value]} for key, value in expected.items()],
            "maxResults": 1000,
        }
        if token:
            params["nextToken"] = token
        response = client.describe_savings_plans_offering_rates(**params)
        for item in response.get("searchResults", []):
            properties = {p.get("name"): p.get("value") for p in item.get("properties", [])}
            if any(properties.get(key) != value for key, value in expected.items()):
                continue
            offering = item.get("savingsPlanOffering", {})
            years = TERMS.get(offering.get("durationSeconds"))
            plan, payment = offering.get("planType"), offering.get("paymentOption")
            if (item.get("productType") != "EC2" or item.get("serviceCode") != "AmazonEC2"
                    or item.get("operation") != "RunInstances" or item.get("unit") != "Hrs"
                    or offering.get("currency") != "USD" or not years
                    or plan not in PLAN_TYPES or payment not in PAYMENTS):
                continue
            rate = _number(item.get("rate"), "Public rate", Decimal("0.000000001"), Decimal("1000000"))
            key = offer_key(plan, years, payment)
            matches.setdefault(key, []).append({
                "status": "AVAILABLE", "hourlyRateUsd": str(rate), "offeringId": offering.get("offeringId"),
                "durationSeconds": offering["durationSeconds"], "usageType": item.get("usageType"),
                "sourceUrl": SP_SOURCE,
            })
        token = response.get("nextToken")
        if not token:
            break
    result = {}
    for plan in PLAN_TYPES:
        for years in (1, 3):
            for payment in PAYMENTS:
                key = offer_key(plan, years, payment)
                values = matches.get(key, [])
                if token:
                    result[key] = {"status": "UNAVAILABLE", "reason": "The offering lookup did not complete."}
                elif not values:
                    result[key] = {"status": "NOT_LISTED", "reason": "No matching public offer was returned for this term and payment option."}
                elif len({Decimal(value["hourlyRateUsd"]) for value in values}) != 1:
                    result[key] = {"status": "UNAVAILABLE", "reason": "Conflicting public offering rates were returned."}
                else:
                    result[key] = values[0]
    return result


def _safe_collect(function, instance: str, region: str) -> dict:
    try:
        return function(instance, region)
    except Exception:  # Provider failures never become zero prices or raw IAM errors.
        log.warning("Public %s lookup unavailable for %s in %s", function.__name__, instance, region)
        return {"status": "UNAVAILABLE", "reason": "Live public pricing could not be retrieved. Refresh or check the installation's pricing access."}


def collect_prices(instance: str, region: str) -> dict:
    key = (instance, region)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached and time.monotonic() - cached[0] < _TTL_SECONDS:
            return copy.deepcopy(cached[1])
    with ThreadPoolExecutor(max_workers=2) as pool:
        od = pool.submit(_safe_collect, collect_on_demand, instance, region)
        sp = pool.submit(_safe_collect, collect_savings_plans, instance, region)
        result = {"onDemand": od.result(), "savingsPlans": sp.result(),
                  "retrievedAt": datetime.now(timezone.utc).isoformat()}
    # A permission or network failure should be immediately retryable after repair.
    if result["onDemand"].get("status") == "AVAILABLE" and "status" not in result["savingsPlans"]:
        with _CACHE_LOCK:
            if len(_CACHE) >= 64:
                _CACHE.pop(next(iter(_CACHE)))
            _CACHE[key] = (time.monotonic(), copy.deepcopy(result))
    return result


def _money(value: Decimal | None) -> str | None:
    return None if value is None else format(value.quantize(Decimal("0.01")), "f")


def compare(payload: dict, *, prices: dict | None = None) -> dict:
    inputs = parse_inputs(payload)
    instance, region = inputs["instanceType"], inputs["region"]
    prices = prices if prices is not None else collect_prices(instance, region)
    od = prices["onDemand"]
    od_rate = Decimal(od["hourlyRateUsd"]) if od.get("status") == "AVAILABLE" else None
    usage_hours = inputs["hoursPerDay"] * 365
    rows = []
    choices = [("OnDemand", 0, "Pay as you go", od)]
    for years in (1, 3):
        for plan in PLAN_TYPES:
            for payment in PAYMENTS:
                key = offer_key(plan, years, payment)
                offers = prices["savingsPlans"]
                evidence = offers.get(key) or (offers if "status" in offers else {
                    "status": "UNAVAILABLE", "reason": "No pricing evidence is available."})
                choices.append((plan, years, payment, evidence))
    for plan, years, payment, evidence in choices:
        available = evidence.get("status") == "AVAILABLE"
        rate = Decimal(evidence["hourlyRateUsd"]) if available else None
        pools = []
        for count in inputs["poolSizes"]:
            yearly = None if rate is None else rate * count * (usage_hours if plan == "OnDemand" else HOURS_PER_YEAR)
            baseline = None if od_rate is None else od_rate * count * usage_hours
            total = yearly * years if yearly is not None and years else None
            # A partial upfront amount is selected at purchase; do not invent 50%.
            upfront = (total if payment == "All Upfront" else Decimal("0")
                       if available and payment in ("No Upfront", "Pay as you go") else None)
            saving = baseline - yearly if baseline is not None and yearly is not None else None
            percent = saving / baseline * 100 if saving is not None and baseline else None
            recurring = (yearly / 12 if payment in ("No Upfront", "Pay as you go") and yearly is not None
                         else Decimal("0") if available and payment == "All Upfront" else None)
            monthly_tokens = inputs["monthlyOutputTokens"]
            unit_cost = yearly / (monthly_tokens * 12) * 1_000_000 if yearly is not None and monthly_tokens else None
            pools.append({
                "instances": count, "annualCostUsd": _money(yearly),
                "monthlyEquivalentUsd": _money(yearly / 12 if yearly is not None else None),
                "upfrontUsd": _money(upfront), "recurringMonthlyUsd": _money(recurring),
                "termCommitmentUsd": _money(total), "annualSavingsUsd": _money(saving),
                "savingsPercent": None if percent is None else format(percent.quantize(Decimal("0.1")), "f"),
                "hourlyCommitmentUsd": None if rate is None or plan == "OnDemand" else str(rate * count),
                "costPerMillionOutputTokensUsd": None if unit_cost is None else format(unit_cost.quantize(Decimal("0.0001")), "f"),
            })
        rows.append({
            "id": "on-demand" if not years else offer_key(plan, years, payment),
            "planType": plan, "termYears": years, "paymentOption": payment,
            "status": evidence["status"], "reason": evidence.get("reason"),
            "effectiveHourlyRateUsd": None if rate is None else str(rate),
            "breakEvenAllocatedPercent": None if rate is None or od_rate is None or not years else
                format((rate / od_rate * 100).quantize(Decimal("0.1")), "f"),
            "evidence": evidence, "pools": pools,
        })
    hardware = next((item.to_json() for item in ACCELERATORS if item.instance == instance), None)
    result = {
        "schemaVersion": 1, "scope": "PUBLIC_EC2_COMPUTE_ESTIMATE", "currency": "USD",
        "instanceType": instance, "region": region, "poolSizes": inputs["poolSizes"],
        "hoursPerDay": str(inputs["hoursPerDay"]), "hoursPerYear": str(usage_hours),
        "commitmentHoursPerYear": str(HOURS_PER_YEAR),
        "monthlyOutputTokens": None if inputs["monthlyOutputTokens"] is None else str(inputs["monthlyOutputTokens"]),
        "retrievedAt": prices["retrievedAt"], "hardware": hardware,
        "hardwareChoices": [{"instance": item.instance, "accelerator": item.accelerator, "gpus": item.gpus}
                            for item in ACCELERATORS],
        "rows": rows,
        "assumptions": [
            "Linux, shared tenancy, public USD prices. No private pricing, PPA, credits, taxes or customer billing data.",
            "One year is 365 days; a monthly equivalent is annual cost divided by 12. A 3-year commitment covers all three years.",
            "Savings Plans are hourly spending commitments paid throughout the term, including idle hours. The pool is fully covered at the selected public rate.",
            "Other eligible usage might consume idle commitment, but that usage is not modeled here.",
            "Compute only: storage, network, EKS control plane, load balancers, observability and other services are additional.",
            "Pricing does not reserve GPU capacity or prove model fit, throughput or response time.",
            "Any output-token cost uses your supplied volume for the same workload in each pool; it is not a throughput measurement.",
        ],
        "sources": [{"label": "Savings Plans commitment terms", "url": SP_GUIDE},
                    {"label": "Compute and EC2 Instance plan scope", "url": PLAN_GUIDE},
                    {"label": "EC2 instance specifications", "url": AWS_SPECS, "reviewedAt": REVIEWED}],
        "calculatorUrl": "https://calculator.aws/",
    }
    result["quoteHash"] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result
