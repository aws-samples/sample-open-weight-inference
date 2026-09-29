"""Collect public model and price facts for the shared inference planner.

No credential forwarding, arbitrary endpoints, model code execution or deployment.
Private checkpoint metadata is not replaced with its public base model.
"""
from __future__ import annotations

import copy
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal

from catalog.model_inspect import inspect_model_source
from catalog.pricing import REGION_TO_LOCATION, ec2_on_demand_rate
from solver.inference_sizing import build_sizing_report, validate_settings, number

_CACHE: dict[tuple[str, str | None], tuple[float, dict]] = {}
_LOCK = threading.Lock()


def public_profile(source: str, revision: str | None) -> dict | None:
    key = (source, revision)
    with _LOCK:
        cached = _CACHE.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return copy.deepcopy(cached[1])
    inspection = inspect_model_source(source, revision)
    if not inspection.ok or not inspection.inference:
        return None
    value = inspection.inference
    with _LOCK:
        if len(_CACHE) >= 32:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = (time.monotonic(), copy.deepcopy(value))
    return value


def estimate_inference(payload: dict) -> dict:
    from api.handler import parse_request

    if not isinstance(payload, dict):
        raise ValueError("Give the project request and sizing settings.")
    raw = payload.get("request")
    if not isinstance(raw, dict) or any(not isinstance(raw.get(key, {}), dict) for key in ("model", "workload", "constraints")):
        raise ValueError("A sizing estimate needs model, workload and constraints objects.")
    # Same inference-scope and requirement validation as the placement solver.
    parse_request(raw)
    settings = validate_settings(payload.get("settings"))
    workload = raw.get("workload") or {}
    number(workload.get("horizonHours", "720"), "Comparison hours", Decimal(".000001"), 876000)
    number(workload.get("concurrency"), "Concurrency", 1, 100000, optional=True, integer=True)
    model = raw.get("model") or {}
    source = model.get("hfRepo")
    revision = model.get("hfCommit")
    if source is not None and (not isinstance(source, str) or len(source) > 300):
        raise ValueError("Use a Hugging Face repository identifier.")
    if revision is not None and (not isinstance(revision, str) or len(revision) > 160):
        raise ValueError("Use a model revision identifier.")
    regions = (raw.get("constraints") or {}).get("permittedRegions") or ["us-east-1"]
    if not isinstance(regions, list) or not regions or not isinstance(regions[0], str):
        raise ValueError("Choose an AWS Region.")
    region = regions[0]
    if region not in REGION_TO_LOCATION:
        raise ValueError("Sizing price collection is not available in this Region.")
    profile = None
    if source and model.get("sourceKind") not in ("checkpoint", "bedrock") and model.get("weightsExportable") is not False:
        profile = public_profile(source, revision)
    report = build_sizing_report(raw, profile, settings)
    instance = settings["cpuInstance"] if report["compute"] == "cpu" else (report.get("hardware") or {}).get("instance")
    rate = None
    if instance and not settings["hourlyRateUsd"]:
        found = ec2_on_demand_rate(instance, region)
        if found:
            rate = {
                "amount": str(found.amount), "unit": found.unit, "region": region,
                "instance": instance, "sku": found.sku, "effectiveDate": found.effective_date,
                "source": found.source, "sourceUrl": "https://aws.amazon.com/ec2/pricing/on-demand/",
            }
    report = build_sizing_report(raw, profile, settings, rate=rate,
                                 retrieved_at=datetime.now(timezone.utc).isoformat())
    report["region"] = region
    report["request"] = raw
    if len(regions) > 1:
        report["limitations"].append(f"This sizing sheet uses {region}; the hosting comparison evaluates its own permitted Regions.")
    if source and not profile:
        report["limitations"].append("No accessible configuration for the exact model source was read. A base model is not a substitute for a private or fine-tuned artifact.")
    if instance and not rate and not settings["hourlyRateUsd"]:
        report["limitations"].append("A current EC2 hourly quote was unavailable. No zero price or commitment discount was substituted.")
    return report
