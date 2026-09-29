"""EDDIE coordinator on AgentCore Runtime.

Replaces the earlier API Gateway + Lambda control plane. API Gateway's 29-second
integration timeout cannot host this workload: price collection alone takes tens of
seconds, and benchmark/build/deploy actions are minutes to hours.

AgentCore Runtime limits (docs/evidence):
    synchronous request   15 minutes
    streaming             60 minutes
    asynchronous job       8 hours
    payload              100 MB

Container contract (required by AgentCore):
    GET  /ping         health; must report HealthyBusy while work is in flight or the
                       session is terminated after 15 minutes of apparent idleness
    POST /invocations  agent interactions, JSON or SSE
    host 0.0.0.0, port 8080, ARM64

Authorization is an inbound Cognito JWT authorizer, so the browser calls this runtime
with `Authorization: Bearer <access_token>` and no request ever transits API Gateway.

The advisor LLM is not on the numeric path. Prices come from the Price List API and
rankings come from the deterministic solver; generated text can explain a result but
cannot create one.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from catalog.candidates import build_snapshot, enumerate_candidates
from catalog.native import collect_native, is_native_request, list_native_catalog
from catalog.connectors import connector_inventory
from evaluation.scoring import score_responses
from projects.store import ProjectConflict, ProjectStore
from catalog.model_inspect import inspect_model_source
from catalog.pricing import ec2_on_demand_rate, resolve_rates, sagemaker_hosting_rate
from knowledge.coa import KnowledgeAdapter
from knowledge.aws_docs import AwsDocumentationTurn
from knowledge.runbooks import find_runbooks, read_runbooks
from platform_ops.sleep import DemoLifecycle
from api.handler import parse_latency, parse_request
from agent.advisor import SUGGESTED_PROMPTS, Advisor
from agent.dynamodb_sessions import (
    ConversationError, ConversationScope, DynamoSessionRepository, RecordedTurn,
)
from api.serialize import decision_json, rate_json, request_json
from solver.solve import SOLVER_VERSION, SolverPolicy, solve
from runtime.principal import (
    AuthenticationError,
    Authenticator,
    AuthorizationError,
    Principal,
    authorize_action,
    authorize_project,
    strip_identity_fields,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("eddie.runtime")

REGION = os.environ.get("EDDIE_REGION", os.environ.get("AWS_REGION", "us-east-1"))
DEFAULT_ADVISOR = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
ENVIRONMENT = os.environ.get("EDDIE_ENVIRONMENT", "dev")

app = FastAPI(title="EDDIE coordinator", version=SOLVER_VERSION)

# Verifies every request's token against the user pool. Configured from the stack
# outputs; an unconfigured verifier refuses all requests rather than deferring to
# whatever sits in front of the container.
authenticator = Authenticator.from_environment()

knowledge = KnowledgeAdapter.from_environment()
lifecycle = DemoLifecycle.from_environment()


# --------------------------------------------------------------------------
# Busy tracking for /ping
# --------------------------------------------------------------------------


class BusyTracker:
    """Counts in-flight work so /ping can report HealthyBusy.

    AgentCore measures idleness from the ping status. A session that reports Healthy
    while a long job runs in the background is eligible for termination at 15
    minutes, which would kill a benchmark or a build mid-flight.
    """

    def __init__(self) -> None:
        self._active = 0
        self._lock = asyncio.Lock()
        self._last_change = time.time()

    async def enter(self) -> None:
        async with self._lock:
            self._active += 1
            self._last_change = time.time()

    async def leave(self) -> None:
        async with self._lock:
            self._active = max(0, self._active - 1)
            self._last_change = time.time()

    @property
    def busy(self) -> bool:
        return self._active > 0

    @property
    def snapshot(self) -> dict[str, Any]:
        return {
            "active": self._active,
            "time_of_last_update": datetime.fromtimestamp(
                self._last_change, tz=timezone.utc
            ).isoformat(),
        }


busy = BusyTracker()


@dataclass
class ChatTransport:
    emit: Any
    cancelled: threading.Event


chat_transport: ContextVar[ChatTransport | None] = ContextVar("chat_transport", default=None)


def conversation_repository(context: "ActionContext", case_id: str) -> DynamoSessionRepository:
    import boto3
    from botocore.config import Config
    table = os.environ.get("CASE_TABLE")
    if not table:
        raise ConversationError("sessions_unavailable", "Advisor conversation storage is not configured.")
    project_id = authorize_project(context.principal, context.project_id)
    return DynamoSessionRepository(
        boto3.client("dynamodb", region_name=REGION,
                     config=Config(connect_timeout=3, read_timeout=5, retries={"total_max_attempts": 1})),
        table, ConversationScope(context.principal.subject, project_id, case_id),
    )


@app.get("/ping")
async def ping() -> JSONResponse:
    """AgentCore health probe.

    Returns HealthyBusy while any invocation is in flight so the runtime is not
    reclaimed underneath long-running work.
    """
    return JSONResponse(
        {
            "status": "HealthyBusy" if busy.busy else "Healthy",
            **busy.snapshot,
        }
    )


# --------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _error(error: str, detail: str, action: Optional[str] = None) -> JSONResponse:
    """Return a handled error as HTTP 200 with an explicit envelope.

    AgentCore replaces any non-2xx container response with a generic
    "Received error (400) from runtime. Please check your CloudWatch logs"
    message, discarding the detail. A validation message like
    "model.architecture is required" would never reach the user.

    The transport succeeded, so the HTTP status is 200; `ok: false` carries the
    operation-level failure and preserves the detail for the UI.
    """
    return JSONResponse(
        {"action": action, "ok": False, "error": error, "detail": detail}
    )


async def action_health(_: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "OK",
        "solverVersion": SOLVER_VERSION,
        "region": REGION,
        "environment": ENVIRONMENT,
        "runtime": "agentcore",
        "timestamp": _now(),
        "limits": {
            "syncRequestMinutes": 15,
            "streamingMinutes": 60,
            "asyncJobHours": 8,
            "note": "AgentCore Runtime quotas; API Gateway's 29s cap does not apply.",
        },
    }
    try:
        rate = await asyncio.to_thread(sagemaker_hosting_rate, "ml.g5.2xlarge", REGION)
        result["priceList"] = {
            "status": "OK" if rate else "NO_RESULT",
            "sampleRate": rate_json(rate),
        }
    except Exception as exc:  # noqa: BLE001
        result["priceList"] = {"status": "ERROR", "error": str(exc)}
        result["status"] = "DEGRADED"

    result["knowledge"] = knowledge.status()
    result["awsDocumentation"] = {
        "state": "CONFIGURED" if AwsDocumentationTurn().enabled else "DISABLED",
        "provider": "AWS Knowledge MCP", "affectsPlacement": False,
        "detail": "Configuration only. Each Advisor turn records whether documentation was actually retrieved.",
    }
    result["demoLifecycle"] = await asyncio.to_thread(lifecycle.status)
    return result


async def action_rates(payload: dict[str, Any]) -> dict[str, Any]:
    instance = payload.get("instanceType", "ml.g5.2xlarge")
    architecture = payload.get("architecture", "LlamaForCausalLM")
    resolved = await asyncio.to_thread(resolve_rates, instance, REGION, architecture)
    return {
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
    }


async def action_catalog(payload: dict[str, Any]) -> dict[str, Any]:
    import re
    region = payload.get("region") or REGION
    if not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", region):
        raise ValueError("Choose a valid AWS Region")

    return await asyncio.to_thread(list_native_catalog, region)


def _evaluate_core(payload: dict[str, Any]) -> dict[str, Any]:
    """Synchronous evaluate.

    Shared by the HTTP action and the advisor's `evaluate_placement` tool so both
    take the identical deterministic path. Kept synchronous deliberately: the
    advisor's tools run inside a worker thread, and scheduling coroutines back onto
    the serving loop from there was fragile.
    """
    request = parse_request(payload)
    if is_native_request(request):
        collected = collect_native(request, parse_latency(payload))
        decision = solve(
            request, collected.candidates, collected.snapshot,
            SolverPolicy(
                min_samples_for_tail=int(payload.get("minSamplesForTail", 10_000)),
                require_violation_bound=bool(payload.get("requireViolationBound", True)),
            ),
        )
        return decision_json(decision, request, extra={
            "request": request_json(request),
            "nativePricing": list(collected.pricing),
            "priceFreshness": {
                f"{q['region']}/{side}": "LIVE" if q[f"{side}Rate"] else "UNKNOWN"
                for q in collected.pricing for side in ("input", "output")
            },
            "retrievedAt": collected.snapshot.retrieved_at,
            "cmiFamily": None,
            "pricedRegions": list(request.constraints.permitted_regions),
            "latencyEvidenceProvenance": "SUPPLIED" if payload.get("latencyEvidence") else "NONE",
            "checksStipulated": False,
            "evaluatedRequest": payload,
            "evaluatedRequestHash": _payload_hash(payload),
        })
    candidates = enumerate_candidates(request)
    if not candidates:
        return {
            "outcome": "NO_CANDIDATES",
            "detail": (
                "No supported candidate configuration exists for this artifact and "
                "modality in this release."
            ),
            "request": request_json(request),
        }

    rates: dict[str, Any] = {}
    freshness: dict[str, str] = {}
    regions = tuple(dict.fromkeys(c.region for c in candidates))
    resolved_by_region = {
        region: resolve_rates("ml.g5.2xlarge", region, request.model.architecture)
        for region in regions
    }
    for region, row in resolved_by_region.items():
        for name in ("cmi_per_cmu_minute", "cmi_per_cmu_month"):
            rates[f"region::{region}::{name}"] = row[name]
        freshness.update({f"{region}/{name}": value for name, value in row["freshness"].items()})

    wanted = sorted({(c.region, c.instance_type) for c in candidates if c.instance_type})
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(wanted)))) as pool:
        for (region, instance), rate in zip(
            wanted, pool.map(lambda item: (
                sagemaker_hosting_rate(item[1], item[0]) if item[1].startswith("ml.")
                else ec2_on_demand_rate(item[1], item[0])
            ), wanted)
        ):
            rates[f"region::{region}::instance::{instance}"] = rate
            freshness[f"{region}/{instance}"] = "LIVE" if rate else "UNKNOWN"
    resolved = resolved_by_region[regions[0]]

    snapshot = build_snapshot(
        request,
        candidates,
        rates,
        retrieved_at=resolved["retrieved_at"],
        latency_by_candidate=parse_latency(payload),
        assume_cleared=bool(payload.get("assumeChecksCleared", False)),
    )

    policy = SolverPolicy(
        min_samples_for_tail=int(payload.get("minSamplesForTail", 10_000)),
        require_violation_bound=bool(payload.get("requireViolationBound", True)),
    )
    decision = solve(request, candidates, snapshot, policy)

    return decision_json(
        decision,
        request,
        extra={
            "request": request_json(request),
            "priceFreshness": freshness,
            "retrievedAt": resolved["retrieved_at"],
            "cmiFamily": resolved.get("cmi_family"),
            "pricedRegions": list(regions),
            "latencyEvidenceProvenance": (
                "SUPPLIED" if payload.get("latencyEvidence") else "NONE"
            ),
            "checksStipulated": bool(payload.get("assumeChecksCleared", False)),
            # The authoritative input identity. Staleness and cross-surface sharing
            # must compare against what the solver actually received, not against a
            # form snapshot: an advisor patch or a strictness change can alter the
            # evaluated request after any snapshot was taken.
            "evaluatedRequest": payload,
            "evaluatedRequestHash": _payload_hash(payload),
        },
    )


async def action_evaluate(
    payload: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    """HTTP action: run the deterministic core, then attach governed context.

    Knowledge is attached for explanation only and is never an input to a price or
    a gate, which is why it is retrieved after the decision rather than before.
    """
    result = await asyncio.to_thread(_evaluate_core, payload)
    if result.get("outcome") != "NO_CANDIDATES":
        request_echo = result.get("request", {})
        model = request_echo.get("model", {})
        result["knowledge"] = await knowledge.retrieve_context(
            f"inference hosting for {model.get('architecture','')} "
            f"{model.get('modality','')}",
            # The verified caller's own token, taken from the principal rather than
            # from the payload. COA authorizes namespace access from the acting
            # user's delegated identity, so this must be the real user -- but it must
            # not be reachable from anything the model composes.
            bearer_token=context.principal.token,
        )
    return result


async def action_knowledge(
    payload: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    source = payload.get("source", "coa")
    if source == "runbooks":
        operation = payload.get("operation", "search")
        if operation == "search":
            return await asyncio.to_thread(find_runbooks, payload)
        if operation == "read":
            return await asyncio.to_thread(read_runbooks, payload)
        raise ValueError("Choose search or read for inference runbooks.")
    if source != "coa":
        raise ValueError("Choose an available knowledge source.")
    return await knowledge.retrieve_context(
        payload.get("query", ""), bearer_token=context.principal.token
    )


# Fields the advisor may write into the case. Anything outside this set is dropped, so
# a hallucinated key cannot reach the form or the solver.
from solver.qualification import (
    QUALIFICATION_SCHEMA, parse_qualification, calculate_usage, require_inference_scope,
)

ADVISOR_WRITABLE_FIELDS = frozenset(
    {
        "modelName", "architecture", "modality", "weightsExportable",
        "hfRepo",
        "horizonHours", "billableCopyHours", "description", "concurrency",
        "successCriteria", "requests", "inputTokensPerRequest", "outputTokensPerRequest",
        # The SLO metric matters: a time-to-first-audio objective is not the same
        # requirement as generic p99 latency, and silently rewriting one to the
        # other changed what the user asked for.
        "sloMetric", "sloThresholdMs",
        # Whether the first request after idle counts. "Under 800 ms after idle" is
        # a cold-inclusive objective and "warm requests only" is not; the advisor
        # could previously express neither, so this always rode the default and the
        # user got no confirmation that the distinction had been understood.
        "sloIncludeCold",
        # Constraints the user states in prose must reach the solver. Dropping them
        # meant a stated region or budget only ever appeared in the advisor's
        # commentary while the solver ranked against different constraints.
        "permittedRegions", "budgetUsd", "requireHeldCapacity", "maxOpsBurden",
        *QUALIFICATION_SCHEMA.keys(),
        "trafficPattern", "scheduled", "dedicatedInstanceHours", "provideSlo",
        "sloPercentile", "sloErrorBudgetFraction",
    }
)

# Deliberately absent from the set above: totalParamsB, contextTokens, weightsGb,
# licenseId and precision. These are properties of the model, not things the user
# tells the advisor, and the advisor recalling that "Llama 3.1 8B has 8 billion
# parameters" is not a measurement. They reach the case from `inspect_model`, which
# retrieves them and records the source revision, or from the user typing an explicit
# override in the form. Keeping them out of the allowlist makes that a property of
# the system rather than an instruction the model may drift from: a guessed weights
# size silently changes which instances look feasible.
ADVISOR_FIELDS_REQUIRING_INSPECTION = frozenset(
    {"totalParamsB", "contextTokens", "weightsGb", "licenseId", "precision"}
)

# SLO metrics the solver understands. An unrecognised metric is reported rather than
# quietly rewritten to p99 latency.
SUPPORTED_SLO_METRICS = frozenset(
    {"p99_latency_ms", "p95_latency_ms", "p50_latency_ms", "ttft_ms", "ttfa_ms",
     "conversation_response_ms"}
)


# Case keys that exist for the interface, not the advisor. `modelInspection` is a
# nested record with per-field provenance, source URLs and prose detail; dumping it
# into the system prompt every turn would spend a growing share of the context on
# text the advisor already received as a tool result.
_CASE_KEYS_NOT_FOR_PROMPT = ("modelInspection",)


def _case_summary(case: dict[str, Any]) -> str:
    if not case:
        return "Nothing established yet."
    visible = {
        k: v
        for k, v in case.items()
        if v not in (None, "", []) and k not in _CASE_KEYS_NOT_FOR_PROMPT
    }
    inspection = case.get("modelInspection")
    if isinstance(inspection, dict):
        # A one-line replacement, so the advisor still knows an inspection happened
        # and which values are detected rather than declared.
        detected = sorted(
            name
            for name, field in (inspection.get("fields") or {}).items()
            if isinstance(field, dict) and field.get("origin") == "DETECTED"
        )
        visible["modelInspectedFrom"] = {
            "repo": inspection.get("repo"),
            "revision": inspection.get("revision"),
            "access": inspection.get("access"),
            "detectedFields": detected,
        }
    return json.dumps(visible, indent=2, default=str)


def _payload_hash(payload: dict[str, Any]) -> str:
    """Stable identity for an evaluate payload.

    Computed over the solver-relevant fields only, so cosmetic differences such as
    caseId or description do not invalidate a result. This is the value both chat
    and the form compare against to decide whether a displayed decision is still
    current.
    """
    relevant = {
        "model": payload.get("model"),
        "workload": {
            k: v
            for k, v in (payload.get("workload") or {}).items()
            if k != "description"
        },
        "slos": payload.get("slos"),
        "constraints": payload.get("constraints"),
        "assumeChecksCleared": payload.get("assumeChecksCleared"),
        "latencyEvidence": payload.get("latencyEvidence"),
        "qualityGoal": payload.get("qualityGoal"),
        "qualification": payload.get("qualification"),
    }
    canonical = json.dumps(relevant, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


def _unsupported_inputs(case: dict[str, Any]) -> list[dict[str, str]]:
    """Inputs the solver cannot act on, reported instead of dropped silently.

    CHAT-01: a stated requirement that never reaches the solver is worse than a
    rejected one, because the advisor's prose still discusses it while the ranking
    ignores it.
    """
    issues: list[dict[str, str]] = []
    metric = case.get("sloMetric")
    if metric and metric not in SUPPORTED_SLO_METRICS:
        issues.append(
            {
                "field": "sloMetric",
                "value": str(metric),
                "reason": (
                    f"{metric} is not a metric the solver evaluates. Supported: "
                    f"{', '.join(sorted(SUPPORTED_SLO_METRICS))}."
                ),
            }
        )
    return issues


def _case_to_evaluate_payload(
    case: dict[str, Any], assume_cleared: bool
) -> dict[str, Any]:
    """Translate the accumulated case into an /evaluate payload.

    Constraints, precision and any supplied latency evidence are carried through
    even though the advisor cannot write them. They arrive from the form when a
    user edited requirements before switching to chat, and dropping them would
    make a chat turn silently ignore a budget or a held-capacity requirement the
    user had already set.
    """
    slo = case.get("sloThresholdMs") if case.get("provideSlo") is not False else None
    payload: dict[str, Any] = {
        "caseId": case.get("caseId", "chat-case"),
        "qualityGoal": case.get("successCriteria"),
        "qualification": parse_qualification({key: case[key] for key in QUALIFICATION_SCHEMA if key in case}) or None,
        "model": {
            "name": case.get("modelName") or case.get("architecture") or "unnamed",
            "architecture": case.get("architecture", ""),
            "modality": case.get("modality", "TEXT"),
            "totalParamsB": case.get("totalParamsB"),
            "contextTokens": case.get("contextTokens"),
            "weightsGb": case.get("weightsGb"),
            "licenseId": case.get("licenseId"),
            "hfRepo": case.get("hfRepo"),
            "hfCommit": case.get("hfCommit"),
            **({"artifactDigest": case["artifactDigest"]} if case.get("artifactDigest") else {}),
            "sourceKind": case.get("sourceKind"),
            "inferenceProfileId": case.get("inferenceProfileId"),
            "weightsExportable": case.get("weightsExportable", True),
        },
        "workload": {
            "horizonHours": case.get("horizonHours") or "720",
            "billableCopyHours": case.get("billableCopyHours"),
            "description": case.get("description", ""),
            "scheduled": case.get("scheduled", False),
            "dedicatedInstanceHours": case.get("dedicatedInstanceHours") or None,
        },
        "assumeChecksCleared": assume_cleared,
    }
    payload["model"]["precision"] = case.get("precision", "BF16")

    for key in ("requests", "inputTokensPerRequest", "outputTokensPerRequest"):
        if case.get(key) not in (None, ""):
            payload["workload"][key] = case[key]

    if case.get("concurrency"):
        payload["workload"]["concurrency"] = case["concurrency"]

    if slo:
        # Preserve the requested metric. Hardcoding p99_latency_ms turned an explicit
        # "p99 time to first audio under 800 ms" into a different requirement.
        metric = str(case.get("sloMetric") or "p99_latency_ms")
        entry: dict[str, Any] = {"metric": metric, "thresholdMs": str(slo)}
        # Carried explicitly, including an explicit false. Omitting the key let the
        # parser apply its default, so the evaluated request never recorded what the
        # user actually said about cold requests.
        include_cold = case.get("sloIncludeCold")
        entry["includeCold"] = True if include_cold is None else bool(include_cold)
        if metric in ("ttft_ms", "ttfa_ms", "conversation_response_ms") and case.get("sloPercentile"):
            entry["percentile"] = str(case["sloPercentile"])
        if case.get("sloErrorBudgetFraction"):
            entry["errorBudgetFraction"] = str(case["sloErrorBudgetFraction"])
        payload["slos"] = [entry]

    # Only send constraints the user actually set: an empty ConstraintSpec field
    # means "no ceiling", and sending a blank would be read as a real limit.
    constraints: dict[str, Any] = {}
    if case.get("permittedRegions"):
        regions = case["permittedRegions"]
        constraints["permittedRegions"] = (
            [r.strip() for r in regions.split(",") if r.strip()]
            if isinstance(regions, str)
            else regions
        )
    if case.get("budgetUsd"):
        constraints["budgetUsd"] = str(case["budgetUsd"])
    if case.get("permittedProcessingRegions"):
        regions = case["permittedProcessingRegions"]
        constraints["permittedProcessingRegions"] = (
            [r.strip() for r in regions.split(",") if r.strip()]
            if isinstance(regions, str) else regions
        )
    if case.get("requireHeldCapacity"):
        constraints["requireHeldCapacity"] = True
    if case.get("maxOpsBurden"):
        constraints["maxOpsBurden"] = case["maxOpsBurden"]
    if constraints:
        payload["constraints"] = constraints

    if case.get("latencyEvidence"):
        payload["latencyEvidence"] = case["latencyEvidence"]

    return payload


async def action_chat(
    payload: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    """Conversational intake and explanation.

    The advisor fills the case and narrates the solver's output. It never computes a
    price or a ranking: `evaluate_placement` calls the same deterministic path the
    form uses, and the structured decision is returned alongside the prose so the UI
    renders numbers from the solver rather than from generated text.
    """
    # Only the new user prompt is accepted. Native Strands restores history from
    # DynamoDB; browser-authored assistant messages/tool results carry no authority.
    message = payload.get("message")
    if message is None and payload.get("messages"):
        last = payload["messages"][-1]
        if not isinstance(last, dict) or last.get("role") != "user":
            raise ValueError("The latest message must be from the user.")
        message = "\n".join(block["text"] for block in last.get("content", [])
                            if isinstance(block, dict) and isinstance(block.get("text"), str))
    if not message:
        return {
            "reply": None,
            "suggestedPrompts": SUGGESTED_PROMPTS,
            "detail": "No messages supplied.",
        }

    if not isinstance(message, str) or not message.strip() or len(message.encode()) > 16_384:
        raise ValueError("Enter a message of up to 16 KB.")
    case: dict[str, Any] = dict(payload.get("case") or {})
    initial_case = dict(case)
    if len(json.dumps(case, allow_nan=False).encode()) > 256 * 1024:
        raise ValueError("The current case is too large for an Advisor turn.")
    case_id = str(case.get("caseId") or payload.get("caseId") or "")
    turn_id = payload.get("turnId")
    assume_cleared_default = payload.get("assumeChecksCleared", False)
    if not isinstance(assume_cleared_default, bool):
        raise ValueError("Assumed checks must be an explicit true or false.")
    request_hash = hashlib.sha256(json.dumps({
        "message": message, "case": case, "assumeChecksCleared": assume_cleared_default,
    }, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()).hexdigest()
    transport = chat_transport.get() or ChatTransport(lambda *_: None, threading.Event())

    def prepare():
        repo = conversation_repository(context, case_id)
        repo.acquire(turn_id, request_hash, message)
        return repo

    try:
        repository = await asyncio.to_thread(prepare)
    except RecordedTurn as recorded:
        return {**recorded.result, "replayed": True}
    captured: dict[str, Any] = {
        "decision": None,
        "evaluatedPayload": None,
        "strictRequestedByAdvisor": False,
    }

    def tool_propose_case_patch(args: dict[str, Any]) -> dict[str, Any]:
        try:
            require_inference_scope(case)
            require_inference_scope(args)
        except ValueError as exc:
            return {"error": str(exc)}
        locked = ({"modelName", "architecture", "modality", "weightsExportable", "hfRepo", "modelStage"}
                  if case.get("sourceKind") == "checkpoint" else set())
        applied = {
            k: v
            for k, v in args.items()
            if k in ADVISOR_WRITABLE_FIELDS and k not in locked and v not in (None, "")
        }
        parse_qualification({key: value for key, value in applied.items() if key in QUALIFICATION_SCHEMA})
        for key in ("weightsExportable", "requireHeldCapacity", "sloIncludeCold", "provideSlo", "scheduled"):
            if key in applied and not isinstance(applied[key], bool):
                raise ValueError(f"{key} must be true or false.")
        rejected = sorted(set(args) - set(applied) - {"rationale"})
        case.update(applied)
        # Name the inspection-only fields separately. A bare "rejected" list left the
        # advisor retrying the same patch; it needs to know the value was refused
        # because it must be retrieved, not because the field name was wrong.
        needs_inspection = sorted(
            set(rejected) & ADVISOR_FIELDS_REQUIRING_INSPECTION
        )
        note = (
            "Recorded. These are declared inputs, not measurements."
            if applied
            else "Nothing applied: no recognised field carried a value."
        )
        if needs_inspection:
            note += (
                f" Refused {', '.join(needs_inspection)}: these are properties of the "
                f"model and must be retrieved, not recalled. Call inspect_model with "
                f"the model source instead of supplying them."
            )
        if locked.intersection(args):
            note += " The selected private checkpoint was kept. To change its identity or files, use Your fine-tuned model in Models & sources."
        return {
            "applied": applied,
            "rejected": rejected,
            "needsInspection": needs_inspection,
            "note": note,
        }

    def tool_evaluate(args: dict[str, Any]) -> dict[str, Any]:
        try:
            require_inference_scope(case)
        except ValueError as exc:
            return {"error": str(exc)}
        # Inspect before evaluating, deterministically.
        #
        # A prompt instruction was not enough. When the advisor evaluated first and
        # inspected second, inspection then wrote architecture, weights size and context
        # length onto the case, and the decision the user was reading was immediately
        # marked "out of date" -- a fresh recommendation, already stale, listing the very
        # fields EDDIE had just filled in. Enforcing the order here means it cannot
        # happen however the model chooses to sequence its calls.
        repo = (case.get("hfRepo") or "").strip()
        if repo and not case.get("modelInspection"):
            inspected = tool_inspect_model({"source": repo})
            if not inspected.get("ok"):
                return {
                    "error": (
                        f"Cannot evaluate yet: reading {repo} did not succeed, so the "
                        f"model's properties are unknown. {inspected.get('error') or ''}"
                    ).strip()
                }

        if not case.get("architecture"):
            return {
                "error": (
                    "Cannot evaluate: the model is not established yet. Ask for the "
                    "model link, or for the provider if it is an API."
                )
            }
        # One-directional: the advisor may tighten the evaluation when the user
        # refuses stipulated checks, but cannot switch stipulation on. Letting it
        # choose freely made identical prompts sometimes return nothing ranked.
        assume = assume_cleared_default
        if args.get("requireVerifiedChecks") is True:
            assume = False
            captured["strictRequestedByAdvisor"] = True

        payload_for_solver = _case_to_evaluate_payload(case, assume)
        result = _evaluate_core(payload_for_solver)
        captured["evaluatedPayload"] = payload_for_solver
        captured["decision"] = result
        # Return a compact view: the advisor needs the outcome and reasons, not the
        # full payload, and a smaller result keeps it from paraphrasing noise.
        return {
            "outcome": result.get("outcome"),
            "winner": (
                {
                    "candidateId": result["winner"]["candidateId"],
                    "target": result["winner"]["target"],
                    "totalCost": result["winner"]["cost"]["total"],
                }
                if result.get("winner")
                else None
            ),
            "ranked": [
                {
                    "candidateId": c["candidateId"],
                    "target": c["target"],
                    "totalCost": c["cost"]["total"] if c.get("cost") else None,
                }
                for c in result.get("ranked", [])
            ],
            "excluded": [
                {
                    "candidateId": c["candidateId"],
                    "failedGates": [
                        {"gate": g["name"], "reason": g["reason"]}
                        for g in c["gates"]
                        if g["status"] == "FAIL"
                    ],
                    "totalCost": c["cost"]["total"] if c.get("cost") else None,
                }
                for c in result.get("excluded", [])
            ],
            "unresolved": [
                {
                    "candidateId": c["candidateId"],
                    "unknownGates": [
                        {"gate": g["name"], "reason": g["reason"]}
                        for g in c["gates"]
                        if g["status"] == "UNKNOWN"
                    ],
                }
                for c in result.get("unresolved", [])
            ],
            "breakeven": result.get("breakeven"),
            "checksStipulated": result.get("checksStipulated"),
            "detail": result.get("detail"),
        }

    def tool_inspect_model(args: dict[str, Any]) -> dict[str, Any]:
        """Read a model's real properties and record the detected ones on the case.

        This exists so the advisor never has to infer an architecture, parameter
        count or weights size from a model's name. Detected values are written to
        the case directly, marked as detected, so the user is not asked for facts
        the source already publishes.
        """
        source = (args.get("source") or "").strip()
        if not source:
            return {"error": "Give a model source, such as a Hugging Face repository."}

        if case.get("sourceKind") == "checkpoint":
            return {"ok": False, "error": (
                "The case uses a private fine-tuned checkpoint. A public base-model inspection "
                "cannot replace it. Use Read checkpoint details in Models & sources to inspect "
                "the authorized private artifact, or explicitly choose another model there."
            )}
        inspection = inspect_model_source(source)
        payload = inspection.to_json()

        applied: dict[str, str] = {}
        if inspection.ok:
            # Only detected values are applied. A field the inspection could not
            # establish is left exactly as it was rather than blanked or guessed.
            for field, detected in (
                ("architecture", inspection.architecture),
                ("modality", inspection.modality),
                ("totalParamsB", inspection.total_params_b),
                ("contextTokens", inspection.context_tokens),
                ("weightsGb", inspection.weights_gb),
                ("precision", inspection.precision),
                ("licenseId", inspection.license_id),
            ):
                if detected.detected and detected.value is not None:
                    case[field] = detected.value
                    applied[field] = detected.value
            if inspection.repo:
                case["hfRepo"] = inspection.repo
                applied["hfRepo"] = inspection.repo
            # An inspectable repository publishes weights, so they are exportable in
            # the sense the solver means: an artifact exists to host. Whether the
            # licence permits it is a separate, unresolved question.
            case["weightsExportable"] = True
            case["hfCommit"] = inspection.revision
            case["modelInspection"] = payload
            captured["inspection"] = payload

        return {
            "ok": inspection.ok,
            "error": inspection.error,
            "repo": inspection.repo,
            "revision": inspection.revision,
            "access": inspection.access,
            "accessDetail": inspection.access_detail,
            "detected": applied,
            "notDetected": {
                name: field["detail"]
                for name, field in payload["fields"].items()
                if field["origin"] != "DETECTED"
            },
            "notes": payload["notes"],
            "inferenceProfile": payload.get("inference"),
        }

    def tool_rates(args: dict[str, Any]) -> dict[str, Any]:
        arch = args.get("architecture") or case.get("architecture") or "LlamaForCausalLM"
        resolved = resolve_rates("ml.g5.2xlarge", REGION, arch)
        return {
            "cmiFamily": resolved.get("cmi_family"),
            "freshness": resolved["freshness"],
            "sagemakerInstanceHour": rate_json(resolved["sagemaker_instance_hour"]),
            "cmiPerCmuMinute": rate_json(resolved["cmi_per_cmu_minute"]),
            "cmiPerCmuMonth": rate_json(resolved["cmi_per_cmu_month"]),
        }

    def tool_catalog(_: dict[str, Any]) -> dict[str, Any]:
        region = (case.get("permittedRegions") or REGION)
        if isinstance(region, list):
            region = region[0] if region else REGION
        region = str(region).split(",")[0].strip()
        catalog = list_native_catalog(region)
        # The old first-60 slice omitted models while claiming a complete catalog.
        return catalog

    def tool_calculate_usage(args: dict[str, Any]) -> dict[str, Any]:
        try:
            require_inference_scope(case)
        except ValueError as exc:
            return {"error": str(exc)}
        return calculate_usage(args)

    def tool_estimate_inference(args: dict[str, Any]) -> dict[str, Any]:
        from catalog.sizing import estimate_inference
        from solver.inference_sizing import validate_settings
        try:
            require_inference_scope(case)
            prior = case.get("sizingSettings") or {}
            if not isinstance(prior, dict):
                raise ValueError("Sizing settings must be an object.")
            settings = validate_settings({**prior, **(args.get("settings") or {})})
            request = _case_to_evaluate_payload(case, assume_cleared_default)
            report = estimate_inference({"request": request, "settings": settings})
            case["sizingSettings"] = settings
            captured["sizingReport"] = report
            return report
        except ValueError as exc:
            return {"error": str(exc)}

    # A fresh instance per authorized turn prevents cross-user or stale-document
    # reuse. Only topic/source IDs enter this adapter, never the project payload.
    aws_documents = AwsDocumentationTurn(cancel_signal=transport.cancelled)
    advisor = Advisor(
        tools={
            "propose_case_patch": tool_propose_case_patch,
            "evaluate_placement": tool_evaluate,
            "get_rates": tool_rates,
            "get_catalog": tool_catalog,
            "inspect_model": tool_inspect_model,
            "calculate_usage": tool_calculate_usage,
            "estimate_inference": tool_estimate_inference,
            "find_runbooks": find_runbooks,
            "read_runbooks": read_runbooks,
            "lookup_aws_documentation": aws_documents.lookup,
            "read_aws_documentation": aws_documents.read,
        },
        model_id=os.environ.get("ADVISOR_MODEL_ID", DEFAULT_ADVISOR),
    )

    try:
        outcome = await asyncio.to_thread(
            advisor.converse, message, _case_summary(case), repository,
            transport.emit, transport.cancelled, context.principal.expires_at,
        )
    except Exception as exc:
        # Initialization errors still get a durable receipt and release the lease.
        # An expired/superseded lease fails closed in finish(), preventing a stale
        # worker from releasing another worker's admission slot.
        outcome = {"reply": "", "status": "FAILED", "truncated": True,
                   "detail": safe_failure_detail(exc, "chat")}

    result = {
        "turnId": turn_id,
        "status": outcome.get("status", "FAILED"),
        "detail": outcome.get("detail"),
        "sessionExpiresAt": repository.expiry,
        "reply": outcome["reply"],
        "case": case,
        # The final applied state wins over an intermediate tool patch. A model
        # may be corrected twice in one turn or inspected after a patch; the
        # requirements chip must describe the values now present in the form.
        "casePatch": {
            key: value for key, value in case.items()
            if key in ADVISOR_WRITABLE_FIELDS and initial_case.get(key) != value
        },
        # The full decision, so the UI renders the same panels the form produces.
        "decision": captured["decision"],
        "toolCalls": outcome.get("toolCalls", []),
        "awsDocumentation": aws_documents.snapshot(),
        # The exact request the solver received, so a requirement that failed to
        # reach it is visible in the UI rather than only in the advisor's prose.
        "evaluatedRequest": captured["evaluatedPayload"],
        "evaluatedRequestHash": (
            _payload_hash(captured["evaluatedPayload"])
            if captured["evaluatedPayload"]
            else None
        ),
        "strictRequestedByAdvisor": captured["strictRequestedByAdvisor"],
        # The inspection, when one ran this turn, so the interface can label each
        # model field's origin and show the source revision it was read at.
        "modelInspection": captured.get("inspection"),
        "sizingReport": captured.get("sizingReport"),
        "unsupportedInputs": _unsupported_inputs(case),
        "rounds": outcome.get("rounds"),
        "truncated": outcome.get("truncated", False),
        "advisorModelId": outcome.get("modelId"),
        "usage": outcome.get("usage", {}),
        "suggestedPrompts": SUGGESTED_PROMPTS,
        "provenance": (
            "Costs, gates and rankings come from the deterministic solver and live "
            "AWS prices. Advisor prose is generated explanation, not independently verified evidence."
        ),
    }
    await asyncio.to_thread(repository.finish, result, status=result["status"])
    return result


async def action_chat_history(payload: dict[str, Any], context: "ActionContext") -> dict[str, Any]:
    def read():
        return conversation_repository(context, str(payload.get("caseId") or "")).history(payload.get("beforeSequence"))
    return await asyncio.to_thread(read)


async def action_chat_cancel(payload: dict[str, Any], context: "ActionContext") -> dict[str, Any]:
    def cancel():
        return conversation_repository(context, str(payload.get("caseId") or "")).request_cancel(payload.get("turnId"))
    return await asyncio.to_thread(cancel)


# --------------------------------------------------------------------------
# Inference deployment: read side
# --------------------------------------------------------------------------
#
# Configured installations forward deployment actions to independently authenticated
# services. A read-only fallback exposes prior state when those services are absent.

CASE_TABLE = os.environ.get("CASE_TABLE", "")
DEPLOYMENT_CONTROLLER = os.environ.get("EDDIE_DEPLOYMENT_CONTROLLER", "")
INFERENCE_FUNCTION = os.environ.get("EDDIE_INFERENCE_FUNCTION", "")


async def forward_deployment(action: str, payload: dict[str, Any], context: "ActionContext") -> dict[str, Any]:
    """The token crosses only this service boundary; it never enters the agent payload.

    Both receiving functions verify it independently. The runtime cannot assume
    their execution roles or write their deployment authority table.
    """
    function = INFERENCE_FUNCTION if action == "deployment.invoke" else DEPLOYMENT_CONTROLLER
    if not function:
        raise ValueError("Deployment services have not been configured in this installation.")
    def call():
        import boto3
        from botocore.config import Config
        service = boto3.client("lambda", region_name=REGION,
            config=Config(connect_timeout=3, read_timeout=95, retries={"total_max_attempts": 1}))
        response = service.invoke(FunctionName=function, InvocationType="RequestResponse",
            Payload=json.dumps({"action": action, "payload": {**payload, "projectId": context.project_id},
                                "authorization": context.principal.token}).encode())
        if response.get("FunctionError"):
            raise ValueError("The deployment service could not complete the request. Refresh deployments before retrying.")
        body = json.loads(response["Payload"].read())
        if not body.get("ok"):
            raise ValueError(body.get("detail") or "The deployment service refused this request.")
        return body["result"]
    return await asyncio.to_thread(call)


def deployment_action(name: str):
    async def run(payload: dict[str, Any], context: "ActionContext") -> dict[str, Any]:
        return await forward_deployment(name, payload, context)
    return run


def _deploy_store() -> Any:
    """The durable store, or None when the table is not configured."""
    if not CASE_TABLE:
        return None
    from deploy.store import DynamoStore

    return DynamoStore(CASE_TABLE, REGION)


def _deployment_capability() -> dict[str, Any]:
    """What this installation can currently execute, stated plainly.

    The interface reads this rather than assuming. An adapter that does not exist must
    show as unavailable with a reason, not as a button that fails.
    """
    return {
        "targets": [
            {
                "target": "SAGEMAKER_REALTIME",
                "label": "Managed endpoint — Amazon SageMaker",
                "available": False,
                "reason": (
                    "The SageMaker deployment adapter is not implemented yet. Plans "
                    "cannot be created for it."
                ),
            },
            {
                "target": "BEDROCK_CMI",
                "label": "Import into Amazon Bedrock",
                "available": False,
                "reason": "The Bedrock import adapter is not implemented yet.",
            },
            {
                "target": "EC2_GPU",
                "label": "GPU server — Amazon EC2",
                "available": False,
                "reason": "The EC2 GPU adapter is not implemented yet.",
            },
        ],
        "canCreatePlans": False,
        "note": (
            "EDDIE can evaluate where a model should run. Creating the resources is "
            "not implemented yet, so no deployment can be started from here."
        ),
    }


async def action_deployment_list(
    payload: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    """Deployments in the caller's project, with what is still chargeable."""
    if DEPLOYMENT_CONTROLLER:
        return await forward_deployment("deployment.list", payload, context)
    store = _deploy_store()
    if store is None:
        return {
            "deployments": [],
            "residual": None,
            "capability": _deployment_capability(),
            "storeConfigured": False,
        }

    def read() -> dict[str, Any]:
        from deploy.reconciler import residual_report

        jobs = store.list_jobs(context.project_id)
        return {
            "deployments": [job.to_json() for job in jobs],
            "residual": residual_report(store, project_id=context.project_id),
            "capability": _deployment_capability(),
            "storeConfigured": True,
        }

    return await asyncio.to_thread(read)


async def action_deployment_get(
    payload: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    if DEPLOYMENT_CONTROLLER:
        return await forward_deployment("deployment.get", payload, context)
    job_id = (payload.get("jobId") or "").strip()
    if not job_id:
        raise ValueError("jobId is required")
    store = _deploy_store()
    if store is None:
        raise ValueError("This installation has no deployment store configured.")

    def read() -> dict[str, Any]:
        from deploy.store import NotFound

        try:
            job = store.get_job(context.project_id, job_id)
        except NotFound as exc:
            # Authorization is enforced by the project scope in the key, and the
            # message is identical whether the job is absent or another project's.
            raise ValueError(exc.detail) from exc
        return {
            "deployment": job.to_json(),
            "resources": [r.to_json() for r in store.list_resources(job_id)],
        }

    return await asyncio.to_thread(read)


async def action_plan_list(
    payload: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    if DEPLOYMENT_CONTROLLER:
        return await forward_deployment("plan.list", payload, context)
    store = _deploy_store()
    if store is None:
        return {"plans": [], "capability": _deployment_capability()}

    def read() -> dict[str, Any]:
        return {
            "plans": [p.to_json() for p in store.list_plans(context.project_id)],
            "capability": _deployment_capability(),
        }

    return await asyncio.to_thread(read)


async def action_demo_status(_: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(lifecycle.status)


async def action_demo_wake(
    payload: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    """Wake EDDIE's own knowledge stack. Operators only.

    The capability check in `authorize_action` already refused a non-operator; this
    records who did it, because waking infrastructure starts charges.
    """
    log.info(
        "demo.wake by subject=%s groups=%s", context.principal.subject,
        list(context.principal.groups),
    )
    hours = payload.get("expiryHours")
    return await asyncio.to_thread(
        lifecycle.wake, float(hours) if hours else None
    )


async def action_demo_sleep(
    _: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    log.info("demo.sleep by subject=%s", context.principal.subject)
    return await asyncio.to_thread(lifecycle.sleep)


async def action_inspect_model(payload: dict[str, Any]) -> dict[str, Any]:
    """Inspect a model source on its own, for the Model details panel.

    Separate from the chat tool so the form can offer an explicit Inspect action:
    a user editing requirements directly should not have to phrase a sentence to
    get their model read.
    """
    source = (payload.get("source") or "").strip()
    if not source:
        return {"ok": False, "error": "Give a model source to inspect."}
    revision = payload.get("revision") or None
    inspection = await asyncio.to_thread(
        inspect_model_source, source, revision
    )
    return inspection.to_json()


@dataclass(frozen=True)
class ActionContext:
    """The verified caller and the project this call operates in.

    Passed as a separate argument rather than merged into the payload so it cannot be
    confused with caller-supplied data. Handlers that need identity take it; handlers
    that do not cannot accidentally read a spoofed one, because there is nothing to
    read in the payload.
    """

    principal: Principal
    project_id: str


#: Actions whose handler needs the verified caller. Everything else keeps the plain
#: `(payload)` signature, so adding identity to a handler is a deliberate edit.
CONTEXT_ACTIONS: frozenset[str] = frozenset(
    {
        "case.get", "case.save", "case.list", "case.remove",
        "chat", "chat.history", "chat.cancel",
        "evaluate",
        "knowledge",
        "demo.wake",
        "demo.sleep",
        # Every deployment read is project-scoped, so all of them take the context.
        "deployment.list",
        "deployment.get",
        "plan.list", "plan.create", "plan.get", "plan.approve",
        "deployment.invoke", "deployment.delete",
        "checkpoint.list", "checkpoint.inspect",
    }
)


async def _dispatch(
    action: str, payload: dict[str, Any], context: "ActionContext"
) -> dict[str, Any]:
    """Call the handler, giving it the verified context only if it takes one."""
    handler = ACTIONS[action]
    if action in CONTEXT_ACTIONS:
        return await handler(payload, context)  # type: ignore[call-arg]
    return await handler(payload)  # type: ignore[call-arg]


async def action_connectors(_: dict[str, Any]) -> dict[str, Any]:
    return connector_inventory()


async def action_sizing(payload: dict[str, Any]) -> dict[str, Any]:
    from catalog.sizing import estimate_inference
    return await asyncio.to_thread(estimate_inference, payload)


async def action_score(payload: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(score_responses, payload)


def project_action(action: str):
    async def handle(payload: dict[str, Any], context: ActionContext) -> dict[str, Any]:
        import boto3
        from botocore.config import Config
        table_name = os.environ.get("CASE_TABLE")
        if not table_name:
            raise ValueError("Project saving is not configured on this installation.")
        store = ProjectStore(boto3.resource("dynamodb", region_name=REGION,
            config=Config(connect_timeout=3, read_timeout=5, retries={"total_max_attempts": 2})).Table(table_name))
        # The request cannot choose an owner, partition or deployment namespace.
        subject = hashlib.sha256(json.dumps(
            [context.principal.subject, context.project_id], separators=(",", ":")
        ).encode()).hexdigest()
        if action == "case.list":
            return await asyncio.to_thread(store.list, subject, payload.get("afterCaseId"))
        case_id = str(payload.get("caseId", ""))
        if action == "case.get":
            return await asyncio.to_thread(store.get, subject, case_id)
        if action == "case.remove":
            if "expectedRevision" not in payload:
                raise ValueError("Read the project before removing it.")
            return await asyncio.to_thread(store.remove, subject, case_id, payload["expectedRevision"])
        return await asyncio.to_thread(
            store.save, subject, case_id, payload.get("document"),
            payload.get("expectedRevision"),
        )
    return handle


ACTIONS = {
    "case.get": project_action("case.get"),
    "case.list": project_action("case.list"),
    "case.save": project_action("case.save"),
    "case.remove": project_action("case.remove"),
    "connectors": action_connectors,
    "evaluation.score": action_score,
    "health": action_health,
    "inspect_model": action_inspect_model,
    "sizing.estimate": action_sizing,
    "checkpoint.list": deployment_action("checkpoint.list"),
    "checkpoint.inspect": deployment_action("checkpoint.inspect"),
    "chat": action_chat,
    "chat.history": action_chat_history,
    "chat.cancel": action_chat_cancel,
    "rates": action_rates,
    "catalog": action_catalog,
    "evaluate": action_evaluate,
    "knowledge": action_knowledge,
    "deployment.list": action_deployment_list,
    "deployment.get": action_deployment_get,
    "plan.list": action_plan_list,
    "plan.create": deployment_action("plan.create"),
    "plan.get": deployment_action("plan.get"),
    "plan.approve": deployment_action("plan.approve"),
    "deployment.invoke": deployment_action("deployment.invoke"),
    "deployment.delete": deployment_action("deployment.delete"),
    "demo.status": action_demo_status,
    "demo.wake": action_demo_wake,
    "demo.sleep": action_demo_sleep,
}


# --------------------------------------------------------------------------
# /invocations
# --------------------------------------------------------------------------


def _bearer(request: Request) -> Optional[str]:
    """The presented bearer token, or None.

    Only `authenticate` consumes this. It is no longer copied into the action payload:
    the payload is composed by the advisor, so anything in it is model-visible, and a
    credential does not belong there.
    """
    header = request.headers.get("authorization", "")
    return header[7:] if header.lower().startswith("bearer ") else None


def safe_failure_detail(exc: Exception, action: Optional[str]) -> str:
    """Keep SDK payloads, URLs and programming errors out of client-facing text."""
    reference = uuid.uuid4().hex[:12]
    aws_code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
    log.error("action_failed reference=%s action=%s type=%s aws_code=%s",
              reference, action, type(exc).__name__, aws_code)
    return f"EDDIE could not complete this request. Refresh before retrying. Reference: {reference}."


@app.post("/invocations")
async def invocations(request: Request) -> Any:
    await busy.enter()
    stream_owns_busy = False
    started = time.perf_counter()
    action = None
    try:
        try:
            # Authenticate before reading a potentially large project upload.
            # JWT key retrieval/verification must not block concurrent streams.
            principal = await asyncio.to_thread(authenticator.authenticate, _bearer(request))
        except AuthenticationError as exc:
            return _error(exc.code, exc.detail)
        try:
            raw = bytearray()
            async with asyncio.timeout(15):
                async for chunk in request.stream():
                    if len(raw) + len(chunk) > 5 * 1024 * 1024:
                        return _error("request_too_large", "This request is too large. Save or send a smaller project.")
                    raw.extend(chunk)
            body = json.loads(raw)
        except TimeoutError:
            return _error("request_timeout", "The request upload timed out. Your browser draft has been kept.")
        except (ValueError, UnicodeError):
            return _error("invalid_json", "request body is not valid JSON")
        if not isinstance(body, dict) or not isinstance(body.get("payload", {}), dict):
            return _error("invalid_request", "Send an action and an object containing its inputs.")
        if "stream" in body and not isinstance(body["stream"], bool):
            return _error("invalid_request", "The stream flag must be true or false.")

        action = body.get("action")
        payload = dict(body.get("payload", {}))
        stream = body.get("stream", False)

        if not isinstance(action, str) or action not in ACTIONS:
            return _error(
                "unknown_action",
                f"action must be one of {sorted(ACTIONS)}",
            )
        if "assumeChecksCleared" in payload and not isinstance(payload["assumeChecksCleared"], bool):
            return _error("invalid_request", "Assumed checks must be an explicit true or false.", action=action)

        # ---- authenticate, then authorize, then handle --------------------
        #
        # In that order and before anything else. SEC-01 requires authorization
        # *before* SSE data is sent, so this runs ahead of the streaming branch: a
        # rejected caller must not receive a stream that has already begun, and must
        # cause no billable work.
        try:
            authorize_action(principal, action)
        except AuthenticationError as exc:
            log.warning("authentication refused for action=%s: %s", action, exc.code)
            return _error(exc.code, exc.detail, action=action)
        except AuthorizationError as exc:
            log.warning(
                "authorization refused subject=%s action=%s: %s",
                "unknown", action, exc.code,
            )
            return _error(exc.code, exc.detail, action=action)

        # Identity fields in the payload are model-writable and carry no authority.
        payload, rejected_identity = strip_identity_fields(payload)
        if rejected_identity:
            log.warning(
                "ignored caller-supplied identity fields on action=%s: %s",
                action, rejected_identity,
            )

        try:
            project_id = authorize_project(principal, payload.get("projectId"))
        except AuthorizationError as exc:
            return _error(exc.code, exc.detail, action=action)
        payload["projectId"] = project_id

        context = ActionContext(principal=principal, project_id=project_id)

        if stream:
            stream_owns_busy = True
            return StreamingResponse(
                _stream_action(action, payload, started, context),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
            )

        try:
            result = await _dispatch(action, payload, context)
        except AuthorizationError as exc:
            return _error(exc.code, exc.detail, action=action)
        except ProjectConflict as exc:
            return _error("save_conflict", str(exc), action=action)
        except ConversationError as exc:
            return _error(exc.code, str(exc), action=action)
        except ValueError as exc:
            return _error("invalid_request", str(exc), action=action)

        if rejected_identity:
            # Visible in the response, not silently dropped, so a client sending one
            # by mistake finds out.
            result = {
                **result,
                "ignoredFields": rejected_identity,
                "ignoredFieldsNote": (
                    "These fields were removed: identity and authority come from your "
                    "verified session, never from the request body."
                ),
            }

        return JSONResponse(
            {
                "action": action,
                "ok": True,
                "result": result,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
            }
        )
    except Exception as exc:  # noqa: BLE001
        return _error("internal_error", safe_failure_detail(exc, action), action=action)
    finally:
        if not stream_owns_busy:
            await busy.leave()


async def _stream_action(
    action: str,
    payload: dict[str, Any],
    started: float,
    context: "ActionContext",
):
    """Forward native text deltas without buffering the completed agent answer."""
    def frame(event: str, data: dict[str, Any]) -> str:
        return f"event: {event}\ndata: {json.dumps({'event': event, **data}, ensure_ascii=False)}\n\n"

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=2048)
    stop = threading.Event()
    delivery_closed = threading.Event()

    def enqueue(event: str, data: dict[str, Any]):
        if delivery_closed.is_set():
            return
        if queue.full():
            # A slow consumer must not exhaust process memory. Stop this turn;
            # reconnecting reads its receipt rather than starting another model.
            stop.set()
            return
        queue.put_nowait((event, data))

    def emit(event: str, data: dict[str, Any]):
        loop.call_soon_threadsafe(enqueue, event, data)

    token = chat_transport.set(ChatTransport(emit, stop))
    task = asyncio.create_task(_dispatch(action, payload, context))
    chat_transport.reset(token)
    try:
        yield frame("start", {"action": action, "at": _now()})
        while not task.done() or not queue.empty():
            if not queue.empty():
                event, data = queue.get_nowait()
                yield frame(event, data)
                continue
            pending = asyncio.create_task(queue.get())
            done, _ = await asyncio.wait({pending, task}, timeout=5, return_when=asyncio.FIRST_COMPLETED)
            if pending in done:
                event, data = pending.result()
                yield frame(event, data)
            else:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                if not done:
                    yield frame("heartbeat", {"elapsedMs": round((time.perf_counter() - started) * 1000, 1)})
        result = await task
        # Callbacks scheduled by the worker before it returned are now drained.
        while not queue.empty():
            event, data = queue.get_nowait()
            yield frame(event, data)
        yield frame(
            "complete" if action == "chat" else "result",
            {
                "action": action,
                "ok": True,
                "result": result,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
            },
        )
    except AuthorizationError as exc:
        yield frame("error", {"error": exc.code, "detail": exc.detail})
    except ConversationError as exc:
        yield frame("error", {"error": exc.code, "detail": str(exc)})
    except ValueError as exc:
        yield frame("error", {"error": "invalid_request", "detail": str(exc)})
    except Exception as exc:  # noqa: BLE001
        yield frame("error", {"error": "internal_error", "detail": safe_failure_detail(exc, action)})
    finally:
        delivery_closed.set()
        stop.set()

        async def finish_background():
            try:
                await asyncio.shield(task)
            except Exception:
                pass  # Sanitized handler/receipt already records the failure.
            finally:
                await busy.leave()

        if task.done():
            await finish_background()
        else:
            # Closing the browser must request native cooperative cancellation,
            # not abandon an asyncio.to_thread worker or release its lease early.
            asyncio.create_task(finish_background())

    yield frame("end", {"action": action})
