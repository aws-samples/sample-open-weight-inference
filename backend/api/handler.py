"""API Gateway Lambda handler.

Routes:
  GET  /health                 service and dependency status
  GET  /catalog/models         Bedrock native models available to this account
  POST /evaluate               case -> live prices -> candidates -> decision
  GET  /rates                  current price evidence with freshness labels

The advisor LLM is not in this path. Numbers come from the Price List API and the
deterministic solver, so a placement cannot be influenced by generated text.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from catalog.candidates import build_snapshot, enumerate_candidates
from catalog.pricing import ec2_on_demand_rate, resolve_rates, sagemaker_hosting_rate
from solver.models import (
    ConstraintSpec,
    LatencyEvidence,
    Modality,
    ModelSpec,
    OpsBurden,
    PlacementRequest,
    SLO,
    WorkloadSpec,
)
from solver.solve import (
    METRIC_IMPLIED_PERCENTILE,
    SOLVER_VERSION,
    SolverPolicy,
    solve,
)
from .serialize import decision_json, rate_json, request_json

log = logging.getLogger()
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

REGION = os.environ.get("EDDIE_REGION", os.environ.get("AWS_REGION", "us-east-1"))

CORS = {
    "Access-Control-Allow-Origin": os.environ.get("CORS_ORIGIN", "*"),
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}


def _response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", **CORS},
        "body": json.dumps(body, default=str),
    }


def _dec(value: Any, field: str) -> Decimal:
    try:
        number = Decimal(str(value))
        if not number.is_finite():
            raise ValueError(f"{field} must be finite")
        return number
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a number, got {value!r}") from exc


def _opt_dec(value: Any, field: str) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    return _dec(value, field)


# --------------------------------------------------------------------------
# Request parsing
# --------------------------------------------------------------------------


def _parse_slo(s: dict[str, Any]) -> SLO:
    """One objective, with its percentile preserved rather than defaulted to 99.

    `percentile` used to be `supplied or 99`, so "half of requests under 400 ms"
    became a 99th-percentile objective -- a much stricter requirement than the one
    asked for, applied without saying so. It is now derived from the metric when the
    metric names a percentile, left absent when it does not (a first-token or
    first-audio objective carries no inherent percentile), and a stated percentile
    that contradicts the metric is rejected instead of being silently overridden.
    """
    metric = s.get("metric", "p99_latency_ms")
    stated = _opt_dec(s.get("percentile"), "slo.percentile")
    implied = METRIC_IMPLIED_PERCENTILE.get(metric)

    if stated is not None and implied is not None and stated != implied:
        raise ValueError(
            f"slo.percentile {stated} contradicts metric {metric}, which is the "
            f"{implied}th percentile. Use the metric for that percentile, or drop "
            f"slo.percentile."
        )

    return SLO(
        metric=metric,
        threshold_ms=_dec(s["thresholdMs"], "slo.thresholdMs"),
        percentile=stated if stated is not None else implied,
        # Cold requests count unless the caller explicitly says otherwise. `bool()`
        # on a missing key would read absence as False, which is the unsafe
        # direction: it would quietly narrow the population to warm requests.
        include_cold=(
            True if s.get("includeCold") is None else bool(s.get("includeCold"))
        ),
        error_budget_fraction=(
            _opt_dec(s.get("errorBudgetFraction"), "slo.errorBudgetFraction")
            or Decimal("0.01")
        ),
    )


def parse_request(body: dict[str, Any]) -> PlacementRequest:
    """Build a PlacementRequest from the UI payload, validating as we go.

    Raises ValueError with a specific message so the UI can show which field is
    wrong rather than a generic failure.
    """
    from solver.qualification import parse_qualification, require_inference_scope
    qualification = parse_qualification(body.get("qualification"))
    require_inference_scope(qualification)
    m = body.get("model") or {}
    w = body.get("workload") or {}
    c = body.get("constraints") or {}

    if not m.get("architecture"):
        raise ValueError("model.architecture is required")
    source_kind = m.get("sourceKind") or None
    if source_kind not in (None, "bedrock", "huggingface", "company", "api", "checkpoint"):
        raise ValueError("model.sourceKind is not supported")
    artifact_digest = m.get("artifactDigest") or None
    if artifact_digest is not None and (
        not isinstance(artifact_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", artifact_digest)
    ):
        raise ValueError("The checkpoint content identity must be a SHA-256 digest.")
    if source_kind == "checkpoint" and not artifact_digest:
        raise ValueError("Read the checkpoint details before comparing hosting; its content identity is missing.")
    profile_id = m.get("inferenceProfileId") or None
    if profile_id is not None and (
        not isinstance(profile_id, str)
        or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.:-]{0,255}", profile_id)
    ):
        raise ValueError("Choose a valid Bedrock inference profile")

    try:
        modality = Modality(m.get("modality", "TEXT"))
    except ValueError as exc:
        raise ValueError(
            f"model.modality must be one of {[x.value for x in Modality]}"
        ) from exc

    model = ModelSpec(
        name=m.get("name") or m["architecture"],
        architecture=m["architecture"],
        modality=modality,
        total_params_b=_opt_dec(m.get("totalParamsB"), "model.totalParamsB"),
        context_tokens=int(m["contextTokens"]) if m.get("contextTokens") else None,
        precision=m.get("precision", "BF16"),
        weights_gb=_opt_dec(m.get("weightsGb"), "model.weightsGb"),
        weights_exportable=bool(m.get("weightsExportable", True)),
        license_id=m.get("licenseId"),
        hf_repo=m.get("hfRepo"),
        hf_commit=m.get("hfCommit"),
        artifact_digest=artifact_digest,
        source_kind=source_kind,
        inference_profile_id=profile_id,
    )

    horizon = _dec(w.get("horizonHours", 720), "workload.horizonHours")
    if horizon <= 0:
        raise ValueError("workload.horizonHours must be positive")

    billable = _opt_dec(w.get("billableCopyHours"), "workload.billableCopyHours")
    if billable is not None and billable < 0:
        raise ValueError("workload.billableCopyHours cannot be negative")

    traffic = {}
    for key in ("requests", "inputTokensPerRequest", "outputTokensPerRequest"):
        value = _opt_dec(w.get(key), f"workload.{key}")
        if value is not None and value < 0:
            raise ValueError(f"workload.{key} cannot be negative")
        traffic[key] = value

    dedicated_hours = _opt_dec(w.get("dedicatedInstanceHours"), "workload.dedicatedInstanceHours")
    if dedicated_hours is not None and (dedicated_hours < 0 or dedicated_hours > horizon):
        raise ValueError("Allocated hours per instance must be between zero and the comparison period.")
    concurrency = _opt_dec(w.get("concurrency"), "workload.concurrency")
    if concurrency is not None and (concurrency < 1 or concurrency != concurrency.to_integral_value() or concurrency > 1000000):
        raise ValueError("Concurrency must be a whole number between one and one million.")
    workload = WorkloadSpec(
        requests=traffic["requests"],
        input_tokens_per_request=traffic["inputTokensPerRequest"],
        output_tokens_per_request=traffic["outputTokensPerRequest"],
        horizon_hours=horizon,
        billable_copy_hours=billable,
        dedicated_instance_hours=dedicated_hours,
        concurrency=int(concurrency) if concurrency is not None else None,
        scheduled=bool(w.get("scheduled", False)),
        description=w.get("description", ""),
    )

    slos = tuple(
        _parse_slo(s)
        for s in body.get("slos", [])
        if s.get("thresholdMs") is not None
    )

    ops_ceiling = None
    if c.get("maxOpsBurden"):
        try:
            ops_ceiling = OpsBurden[c["maxOpsBurden"]]
        except KeyError as exc:
            raise ValueError(
                f"constraints.maxOpsBurden must be one of {[o.name for o in OpsBurden]}"
            ) from exc

    regions = c.get("permittedRegions") or [REGION]
    if not isinstance(regions, list) or len(regions) > 8 or any(
        not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", region)
        for region in regions
    ):
        raise ValueError("Choose between one and eight valid AWS Regions")
    processing_regions = c.get("permittedProcessingRegions") or []
    if not isinstance(processing_regions, list) or len(processing_regions) > 32 or any(
        not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", region)
        for region in processing_regions
    ):
        raise ValueError("Choose valid processing Regions from the Bedrock route")
    constraints = ConstraintSpec(
        permitted_regions=tuple(dict.fromkeys(regions)),
        permitted_processing_regions=tuple(dict.fromkeys(processing_regions)),
        budget_usd=_opt_dec(c.get("budgetUsd"), "constraints.budgetUsd"),
        require_held_capacity=bool(c.get("requireHeldCapacity", False)),
        max_ops_burden=ops_ceiling,
        residency_preference=tuple(c.get("residencyPreference") or []),
    )

    return PlacementRequest(
        model=model,
        workload=workload,
        slos=slos,
        constraints=constraints,
        case_id=body.get("caseId", "case-adhoc"),
        quality_goal=str(body["qualityGoal"]).strip() if body.get("qualityGoal") else None,
        qualification=qualification,
    )


def parse_latency(body: dict[str, Any]) -> dict[str, LatencyEvidence]:
    """Optional supplied benchmark evidence, keyed by candidate ID.

    Real evidence comes from the benchmark harness. Accepting it here lets the UI
    demonstrate how measured tails change the outcome without pretending the
    numbers were measured by this service -- the response labels them SUPPLIED.
    """
    out: dict[str, LatencyEvidence] = {}
    for cid, raw in (body.get("latencyEvidence") or {}).items():
        if raw is None:
            continue
        out[cid] = LatencyEvidence(
            p50_ms=_dec(raw.get("p50Ms", 0), "p50Ms"),
            p99_ms=_dec(raw["p99Ms"], "p99Ms"),
            sample_count=int(raw.get("sampleCount", 0)),
            cold_start_ms=_opt_dec(raw.get("coldStartMs"), "coldStartMs"),
            p95_ms=_opt_dec(raw.get("p95Ms"), "p95Ms"),
            ttft_ms=_opt_dec(raw.get("ttftMs"), "ttftMs"),
            ttfa_ms=_opt_dec(raw.get("ttfaMs"), "ttfaMs"),
            conversation_response_ms=_opt_dec(
                raw.get("conversationResponseMs"), "conversationResponseMs"
            ),
            # Absent means the run did include cold requests, matching the SLO
            # default. `bool(...True)` would read an explicit false correctly but an
            # absent key as True as well, which is what we want here -- stated
            # explicitly so the asymmetry with `includeCold` is visible.
            includes_cold=(
                True if raw.get("includesCold") is None
                else bool(raw.get("includesCold"))
            ),
            violation_rate_upper_bound=_opt_dec(
                raw.get("violationRateUpperBound"), "violationRateUpperBound"
            ),
            benchmark_run_id=raw.get("benchmarkRunId", "supplied"),
        )
    return out


# --------------------------------------------------------------------------
# Route handlers
# --------------------------------------------------------------------------


def handle_health() -> dict[str, Any]:
    checks: dict[str, Any] = {
        "solverVersion": SOLVER_VERSION,
        "region": REGION,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        rate = sagemaker_hosting_rate("ml.g5.2xlarge", REGION)
        checks["priceList"] = {
            "status": "OK" if rate else "NO_RESULT",
            "sampleRate": rate_json(rate),
        }
    except Exception as exc:  # noqa: BLE001
        checks["priceList"] = {"status": "ERROR", "error": str(exc)}

    ok = checks.get("priceList", {}).get("status") == "OK"
    return _response(200 if ok else 503, {"status": "OK" if ok else "DEGRADED", **checks})


def handle_catalog() -> dict[str, Any]:
    """Native Bedrock models visible to this account.

    A catalogue hit is a candidate, not evidence that a native model is equivalent
    to the customer's artifact.
    """
    import boto3

    try:
        client = boto3.client("bedrock", region_name=REGION)
        resp = client.list_foundation_models()
        models = [
            {
                "modelId": m.get("modelId"),
                "modelName": m.get("modelName"),
                "provider": m.get("providerName"),
                "inputModalities": m.get("inputModalities", []),
                "outputModalities": m.get("outputModalities", []),
                "streamingSupported": m.get("responseStreamingSupported", False),
                "inferenceTypes": m.get("inferenceTypesSupported", []),
            }
            for m in resp.get("modelSummaries", [])
        ]
        return _response(
            200,
            {
                "region": REGION,
                "count": len(models),
                "models": sorted(models, key=lambda x: (x["provider"] or "", x["modelId"] or "")),
                "note": (
                    "Native catalogue availability. Equivalence to a customer "
                    "artifact requires a separate task-quality evaluation."
                ),
            },
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("Catalog listing failed: %s", exc)
        return _response(502, {"error": "catalog_unavailable", "detail": str(exc)})


def handle_rates(params: dict[str, str]) -> dict[str, Any]:
    instance = params.get("instanceType", "ml.g5.2xlarge")
    architecture = params.get("architecture", "LlamaForCausalLM")
    resolved = resolve_rates(instance, REGION, architecture)
    return _response(
        200,
        {
            "region": resolved["region"],
            "retrievedAt": resolved["retrieved_at"],
            "freshness": resolved["freshness"],
            "cmiFamily": resolved.get("cmi_family"),
            "cmuVersion": resolved.get("cmu_version"),
            "rates": {
                "sagemakerInstanceHour": rate_json(resolved["sagemaker_instance_hour"]),
                "cmiPerCmuMinute": rate_json(resolved["cmi_per_cmu_minute"]),
                "cmiPerCmuMonth": rate_json(resolved["cmi_per_cmu_month"]),
            },
        },
    )


def handle_evaluate(body: dict[str, Any]) -> dict[str, Any]:
    try:
        request = parse_request(body)
    except ValueError as exc:
        return _response(400, {"error": "invalid_request", "detail": str(exc)})

    candidates = enumerate_candidates(request)
    if not candidates:
        return _response(
            200,
            {
                "outcome": "NO_CANDIDATES",
                "detail": (
                    "No supported candidate configuration exists for this artifact "
                    "and modality in this release."
                ),
                "request": request_json(request),
            },
        )

    # Price each candidate in its own region. This legacy route uses the same
    # regional key convention as the authenticated AgentCore coordinator.
    rates: dict[str, Any] = {}
    freshness: dict[str, str] = {}
    regions = tuple(dict.fromkeys(c.region for c in candidates))
    resolved = None
    for region in regions:
        row = resolve_rates("ml.g5.2xlarge", region, request.model.architecture)
        resolved = resolved or row
        for name in ("cmi_per_cmu_minute", "cmi_per_cmu_month"):
            rates[f"region::{region}::{name}"] = row[name]
        freshness.update({f"{region}/{key}": value for key, value in row["freshness"].items()})
    for cand in candidates:
        key = f"region::{cand.region}::instance::{cand.instance_type}"
        if cand.instance_type and key not in rates:
            value = (sagemaker_hosting_rate(cand.instance_type, cand.region)
                     if cand.instance_type.startswith("ml.")
                     else ec2_on_demand_rate(cand.instance_type, cand.region))
            rates[key] = value
            freshness[f"{cand.region}/{cand.instance_type}"] = "LIVE" if value else "UNKNOWN"
    assert resolved is not None

    snapshot = build_snapshot(
        request,
        candidates,
        rates,
        retrieved_at=resolved["retrieved_at"],
        latency_by_candidate=parse_latency(body),
        assume_cleared=bool(body.get("assumeChecksCleared", False)),
    )

    policy = SolverPolicy(
        min_samples_for_tail=int(body.get("minSamplesForTail", 10_000)),
        require_violation_bound=bool(body.get("requireViolationBound", True)),
    )
    decision = solve(request, candidates, snapshot, policy)

    return _response(
        200,
        decision_json(
            decision,
            request,
            extra={
                "request": request_json(request),
                "priceFreshness": freshness,
                "retrievedAt": resolved["retrieved_at"],
                "cmiFamily": resolved.get("cmi_family"),
                "latencyEvidenceProvenance": (
                    "SUPPLIED" if body.get("latencyEvidence") else "NONE"
                ),
                "checksStipulated": bool(body.get("assumeChecksCleared", False)),
            },
        ),
    )


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def lambda_handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    method = (
        event.get("httpMethod")
        or event.get("requestContext", {}).get("http", {}).get("method")
        or "GET"
    )
    path = event.get("path") or event.get("rawPath") or "/"
    params = event.get("queryStringParameters") or {}

    if method == "OPTIONS":
        return _response(204, {})

    try:
        if path.endswith("/health"):
            return handle_health()
        if path.endswith("/catalog/models"):
            return handle_catalog()
        if path.endswith("/rates"):
            return handle_rates(params)
        if path.endswith("/evaluate"):
            if method != "POST":
                return _response(405, {"error": "method_not_allowed"})
            raw = event.get("body") or "{}"
            try:
                body = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError as exc:
                return _response(400, {"error": "invalid_json", "detail": str(exc)})
            return handle_evaluate(body)
        return _response(404, {"error": "not_found", "path": path})
    except Exception as exc:  # noqa: BLE001 - never leak a stack trace to the client
        log.exception("Unhandled error on %s %s", method, path)
        return _response(500, {"error": "internal_error", "detail": str(exc)})
