"""Compare bounded, reproducible experiments without granting deployment authority.

Reports are supplied evidence, even when produced by EDDIE's companion runner.
This module never invokes models, executes submitted code, fetches report URLs,
trusts precomputed summaries, or converts an uploaded result into a solver gate.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

VERSION = "eddie-benchmark/1"
MAX_RUNS = 8
MAX_SAMPLES = 200
MAX_BYTES = 1_000_000
HEX = re.compile(r"[0-9a-f]{64}\Z")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}\Z")
ACCOUNTING = ("input_includes_cache", "cache_is_additional", "unknown")


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
    ).encode()).hexdigest()


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object.")
    return value


def _text(value: Any, label: str, maximum: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label} must contain 1–{maximum} characters.")
    return value


def _number(value: Any, label: str, maximum: float = 1e12, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number.")
    if not math.isfinite(value) or not (0 < value <= maximum if positive else 0 <= value <= maximum):
        raise ValueError(f"{label} is outside its supported range.")
    return float(value)


def _integer(value: Any, label: str, maximum: int, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be a whole number from {minimum} to {maximum}.")
    return value


def _money(value: Any, label: str) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError(f"{label} must be a non-negative USD amount.")
    try:
        parsed = Decimal(str(value))
    except InvalidOperation:
        raise ValueError(f"{label} must be a non-negative USD amount.") from None
    if not parsed.is_finite() or not 0 <= parsed <= Decimal("1000000000"):
        raise ValueError(f"{label} must be a non-negative USD amount.")
    return parsed


def _date(value: Any, label: str) -> str:
    text = _text(value, label, 50)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"{label} must be an ISO timestamp with a timezone.") from None
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone.")
    return text


def _bounded_json(value: Any) -> None:
    try:
        size = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode())
    except (TypeError, ValueError, RecursionError):
        raise ValueError("Benchmark evidence must be finite JSON data.") from None
    if size > MAX_BYTES:
        raise ValueError("Benchmark evidence must be smaller than 1 MB.")


def token_totals(sample: dict[str, Any]) -> dict[str, int] | None:
    """Normalize declared token semantics. Never infer cache semantics from ratios."""
    usage = sample.get("usage")
    if usage is None:
        return None
    usage = _object(usage, "Token usage")
    if set(usage) - {"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "accounting"}:
        raise ValueError("Token usage contains unsupported fields.")
    mode = usage.get("accounting")
    if mode not in ACCOUNTING:
        raise ValueError("Declare whether input tokens include cached tokens.")
    values = {}
    for key in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"):
        value = usage.get(key)
        values[key] = None if value is None else _integer(value, key, 1_000_000_000)
    if mode == "unknown" or any(value is None for value in values.values()):
        return None
    input_count = values["inputTokens"]
    cached = values["cacheReadTokens"] + values["cacheWriteTokens"]
    if mode == "input_includes_cache":
        if cached > input_count:
            raise ValueError("Cache token subsets cannot exceed total input tokens.")
        fresh, prompt = input_count - cached, input_count
    else:
        fresh, prompt = input_count, input_count + cached
    return {
        "freshInputTokens": fresh,
        "cacheReadTokens": values["cacheReadTokens"],
        "cacheWriteTokens": values["cacheWriteTokens"],
        "outputTokens": values["outputTokens"],
        "totalTokens": prompt + values["outputTokens"],
    }


def validate_run(value: Any) -> dict[str, Any]:
    """Validate raw observations; ignore any caller-authored ranking or summary."""
    run = _object(value, "Benchmark run")
    if set(run) - {"schemaVersion", "runId", "createdAt", "configuration", "workload",
                   "protocol", "durationSeconds", "state", "samples", "cost"}:
        raise ValueError("The report contains unsupported fields. Import observations, not precomputed rankings.")
    if run.get("schemaVersion") != VERSION:
        raise ValueError(f"Use a {VERSION} report.")
    if not ID.fullmatch(_text(run.get("runId"), "Run ID", 100)):
        raise ValueError("Run ID contains unsupported characters.")
    _date(run.get("createdAt"), "Run timestamp")
    configuration = _object(run.get("configuration"), "Configuration")
    if set(configuration) - {"label", "model", "revision", "runtime", "harness", "region", "hardware", "provider"}:
        raise ValueError("Configuration contains unsupported fields.")
    for key in ("label", "model", "revision", "runtime", "harness", "region", "hardware"):
        _text(configuration.get(key), f"Configuration {key}")
    if configuration.get("provider") not in ("bedrock", "sagemaker", "self_hosted", "external"):
        raise ValueError("Choose a supported benchmark provider.")
    workload = _object(run.get("workload"), "Workload")
    if set(workload) - {"name", "datasetDigest", "rubricDigest", "taskIds"}:
        raise ValueError("The report workload contains unsupported fields.")
    _text(workload.get("name"), "Workload name")
    for key in ("datasetDigest", "rubricDigest"):
        if not HEX.fullmatch(_text(workload.get(key), key, 64)):
            raise ValueError(f"{key} must be a SHA-256 digest.")
    tasks = workload.get("taskIds")
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_SAMPLES:
        raise ValueError(f"Provide 1–{MAX_SAMPLES} workload task IDs.")
    if any(not isinstance(task, str) or not ID.fullmatch(task) for task in tasks) or len(set(tasks)) != len(tasks):
        raise ValueError("Workload task IDs must be unique, short identifiers.")
    protocol = _object(run.get("protocol"), "Measurement protocol")
    if set(protocol) - {"repetitions", "concurrency", "maxOutputTokens", "warmupRequests",
                        "temperature", "measurement", "loadModel", "acceptance"}:
        raise ValueError("The measurement protocol contains unsupported fields.")
    repeats = _integer(protocol.get("repetitions"), "Repetitions", 10, 1)
    _integer(protocol.get("concurrency"), "Concurrency", 32, 1)
    _integer(protocol.get("maxOutputTokens"), "Output token limit", 8192, 1)
    # v1 measures the complete window from its first request. An external warm-up
    # would require its own cost/usage records; silently omitting it understates cost.
    _integer(protocol.get("warmupRequests"), "Unrecorded warm-up requests", 0)
    _number(protocol.get("temperature"), "Temperature", 2)
    if protocol.get("measurement") != "client_end_to_end":
        raise ValueError("Use client_end_to_end latency, including the complete response.")
    if protocol.get("loadModel") != "closed_loop":
        raise ValueError("This comparison supports closed_loop experiments.")
    _text(protocol.get("acceptance"), "Acceptance rule")
    _number(run.get("durationSeconds"), "Measurement duration", 86400, positive=True)
    if run.get("state") not in ("completed", "stopped"):
        raise ValueError("Run state must be completed or stopped.")
    samples = run.get("samples")
    if not isinstance(samples, list) or len(samples) != len(tasks) * repeats or len(samples) > MAX_SAMPLES:
        raise ValueError("Include every scheduled task and repetition, including errors and unstarted tasks.")
    identities = set()
    for sample in samples:
        sample = _object(sample, "Observation")
        if set(sample) - {"taskId", "repetition", "status", "accepted", "elapsedMs",
                          "ttftMs", "usage", "outputDigest", "errorCode"}:
            raise ValueError("Observations contain unsupported fields.")
        task = sample.get("taskId")
        repetition = _integer(sample.get("repetition"), "Repetition number", repeats, 1)
        if not isinstance(task, str) or task not in tasks or (task, repetition) in identities:
            raise ValueError("Each observation must name one unique scheduled task and repetition.")
        identities.add((task, repetition))
        status = sample.get("status")
        if status not in ("ok", "error", "not_run"):
            raise ValueError("Observation status must be ok, error or not_run.")
        accepted = sample.get("accepted")
        if accepted is not None and not isinstance(accepted, bool):
            raise ValueError("Acceptance must be true, false or null for an ungraded response.")
        if status != "ok" and accepted is not False:
            raise ValueError("Failed and unstarted requests cannot count as accepted.")
        elapsed = sample.get("elapsedMs")
        if status != "not_run":
            _number(elapsed, "Elapsed milliseconds", 86_400_000, positive=True)
            if elapsed > run["durationSeconds"] * 1000 + 1:
                raise ValueError("A request duration cannot exceed the complete benchmark window.")
        elif elapsed is not None:
            raise ValueError("An unstarted request cannot have measured latency.")
        first = sample.get("ttftMs")
        if first is not None:
            _number(first, "Time to first token", 86_400_000)
            if status != "ok" or first > elapsed:
                raise ValueError("Time to first token needs a completed request and cannot exceed its duration.")
        if status == "not_run" and sample.get("usage") is not None:
            raise ValueError("An unstarted request cannot have token usage.")
        token_totals(sample)
        if sample.get("outputDigest") is not None and (
            not isinstance(sample["outputDigest"], str) or not HEX.fullmatch(sample["outputDigest"])
        ):
            raise ValueError("Output digest must be a SHA-256 digest.")
        if sample.get("errorCode") is not None:
            _text(sample["errorCode"], "Error code", 100)
        if run["state"] == "completed" and status == "not_run":
            raise ValueError("A completed run cannot contain unstarted tasks.")
    cost = _object(run.get("cost"), "Cost evidence")
    if set(cost) - {"basis", "scope", "retrievedAt", "source", "rateId", "currency", "hourlyUsd", "perMillion"}:
        raise ValueError("Cost evidence contains unsupported fields.")
    if cost.get("basis") not in ("unknown", "tokens", "capacity"):
        raise ValueError("Cost basis must be tokens, capacity or unknown.")
    if cost.get("scope") != "benchmark_window":
        raise ValueError("Compare benchmark-window costs; lifecycle costs need a separate estimate.")
    if cost["basis"] != "unknown":
        _date(cost.get("retrievedAt"), "Rate retrieval time")
        _text(cost.get("source"), "Rate source", 500)
        _text(cost.get("rateId"), "Rate identifier", 500)
        if cost.get("currency") != "USD":
            raise ValueError("Benchmark prices must use USD.")
        if cost["basis"] == "capacity":
            _money(cost.get("hourlyUsd"), "Full fleet hourly price")
        else:
            prices = _object(cost.get("perMillion"), "Token prices")
            if set(prices) - {"freshInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"}:
                raise ValueError("Token prices contain unsupported fields.")
            for key in ("freshInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"):
                if prices.get(key) is not None:
                    _money(prices[key], key + " price")
    return run


def percentile(values: list[float], percent: float) -> float | None:
    """Nearest-rank observed percentile, not a population latency guarantee."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(percent * len(ordered)) - 1)]


def _cost(run: dict[str, Any]) -> tuple[Decimal | None, str | None]:
    evidence = run["cost"]
    if evidence["basis"] == "unknown":
        return None, "No applicable price evidence."
    if evidence["basis"] == "capacity":
        return _money(evidence["hourlyUsd"], "Hourly price") * Decimal(str(run["durationSeconds"])) / 3600, None
    total = Decimal(0)
    for sample in run["samples"]:
        if sample["status"] == "not_run":
            continue
        usage = token_totals(sample)
        if usage is None:
            return None, "Token usage or cache accounting is incomplete, including failed requests."
        for key in ("freshInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"):
            price = evidence["perMillion"].get(key)
            if usage[key] and price is None:
                return None, f"No applicable price for {key}."
            if usage[key]:
                total += Decimal(usage[key]) * _money(price, "Token price") / 1_000_000
    return total, None


def _amount(value: Decimal | None) -> str | None:
    return format(value.quantize(Decimal("0.00000001")), "f") if value is not None else None


def _summarize(run: dict[str, Any], quality_floor: float, latency_limit: float | None,
               error_ceiling: float, minimum_tasks: int) -> dict[str, Any]:
    samples = run["samples"]
    attempted = [s for s in samples if s["status"] != "not_run"]
    completed = [s for s in samples if s["status"] == "ok"]
    accepted = [s for s in completed if s["accepted"] is True]
    useful = [s for s in accepted if latency_limit is None or s["elapsedMs"] <= latency_limit]
    ungraded = sum(s["accepted"] is None for s in completed)
    errors = len(attempted) - len(completed)
    percent = len(accepted) * 100 / len(samples)
    error_percent = errors * 100 / len(attempted) if attempted else None
    p95 = percentile([float(s["elapsedMs"]) for s in completed], .95)
    p50 = percentile([float(s["elapsedMs"]) for s in completed], .5)
    first = [float(s["ttftMs"]) for s in completed if s.get("ttftMs") is not None]
    price, price_gap = _cost(run)
    per_useful = price / len(useful) if price is not None and useful else None
    reasons = []
    if run["state"] != "completed" or len(attempted) != len(samples):
        reasons.append("The scheduled workload was not completed.")
    if ungraded:
        reasons.append(f"{ungraded} successful responses still need quality grading.")
    if percent < quality_floor:
        reasons.append(f"Acceptance {percent:.2f}% is below the {quality_floor:g}% target.")
    if error_percent is None or error_percent > error_ceiling:
        reasons.append("The request failure rate exceeds the target or no request completed.")
    if latency_limit is not None and (p95 is None or p95 > latency_limit):
        reasons.append("Observed p95 response time exceeds the target or is unavailable.")
    if len(run["workload"]["taskIds"]) < minimum_tasks:
        reasons.append("Too few distinct tasks for the requested comparison.")
    if p95 is None:
        reasons.append("No successful response-time observations.")
    if price_gap:
        reasons.append(price_gap)
    if not useful:
        reasons.append("No accepted responses meet the response-time target.")
    task_outcomes = []
    for task in run["workload"]["taskIds"]:
        observations = [s for s in samples if s["taskId"] == task]
        task_outcomes.append({
            "taskId": task,
            "accepted": sum(s["accepted"] is True for s in observations),
            "attempts": len(observations),
            "allRepeatsAccepted": all(s["accepted"] is True for s in observations),
        })
    usage = [token_totals(s) for s in attempted]
    tokens = {key: sum(u[key] for u in usage) for key in (
        "freshInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens",
    )} if usage and all(u is not None for u in usage) else None
    return {
        "runId": run["runId"], "configuration": run["configuration"],
        "createdAt": run["createdAt"], "runDigest": digest(run),
        "planned": len(samples), "attempted": len(attempted), "errors": errors,
        "notRun": len(samples) - len(attempted), "ungraded": ungraded,
        "accepted": len(accepted), "useful": len(useful),
        "acceptancePercent": round(percent, 4), "errorPercent": error_percent,
        "p50Ms": p50, "p95Ms": p95,
        "p95TtftMs": percentile(first, .95) if len(first) == len(completed) else None,
        "ttftSamples": len(first), "latencySamples": len(completed),
        "durationSeconds": run["durationSeconds"],
        "usefulRequestsPerMinute": round(len(useful) * 60 / run["durationSeconds"], 4),
        "costUsd": _amount(price), "costPerUsefulUsd": _amount(per_useful),
        "costEvidence": run["cost"], "tokens": tokens,
        "eligible": not reasons, "reasons": reasons, "frontier": False,
        "taskOutcomes": task_outcomes,
    }


def compare_benchmarks(payload: dict[str, Any]) -> dict[str, Any]:
    """A sample-level comparison. Never clear hosting, safety or approval gates."""
    _bounded_json(payload)
    runs = payload.get("runs")
    if not isinstance(runs, list) or not 1 <= len(runs) <= MAX_RUNS:
        raise ValueError(f"Provide 1–{MAX_RUNS} benchmark runs.")
    runs = [validate_run(run) for run in runs]
    if len({run["runId"] for run in runs}) != len(runs):
        raise ValueError("Run IDs must be unique.")
    settings = _object(payload.get("settings", {}), "Comparison settings")
    if set(settings) - {"minimumAcceptancePercent", "maximumErrorPercent", "minimumTasks", "maximumP95Ms"}:
        raise ValueError("Comparison settings contain unsupported fields.")
    quality = _number(settings.get("minimumAcceptancePercent", 95), "Acceptance target", 100)
    error_ceiling = _number(settings.get("maximumErrorPercent", 0), "Error target", 100)
    minimum_tasks = _integer(settings.get("minimumTasks", 1), "Minimum distinct tasks", MAX_SAMPLES, 1)
    latency = settings.get("maximumP95Ms")
    if latency is not None:
        latency = _number(latency, "Response-time target", 86_400_000, positive=True)
    first = runs[0]
    rows = []
    for run in runs:
        row = _summarize(run, quality, latency, error_ceiling, minimum_tasks)
        differences = []
        for key in ("datasetDigest", "rubricDigest"):
            if run["workload"][key] != first["workload"][key]:
                differences.append(key)
        if set(run["workload"]["taskIds"]) != set(first["workload"]["taskIds"]):
            differences.append("taskIds")
        for key in ("concurrency", "repetitions", "warmupRequests", "maxOutputTokens",
                    "temperature", "measurement", "loadModel", "acceptance"):
            if run["protocol"][key] != first["protocol"][key]:
                differences.append(key)
        if differences:
            row["eligible"] = False
            row["reasons"].append("Not comparable to the first run: " + ", ".join(differences) + ".")
        row["comparisonDifferences"] = differences
        rows.append(row)
    # Use unrounded values for ranking. An inexpensive run must not become "free"
    # or tied merely because display rounding erased its price.
    raw_cost = {}
    for run, row in zip(runs, rows):
        cost, _ = _cost(run)
        if cost is not None and row["useful"]:
            raw_cost[row["runId"]] = cost / row["useful"]
    eligible = [row for row in rows if row["eligible"]]
    for row in eligible:
        row["frontier"] = not any(
            other is not row
            and other["acceptancePercent"] >= row["acceptancePercent"]
            and other["p95Ms"] <= row["p95Ms"]
            and raw_cost[other["runId"]] <= raw_cost[row["runId"]]
            and (
                other["acceptancePercent"] > row["acceptancePercent"]
                or other["p95Ms"] < row["p95Ms"]
                or raw_cost[other["runId"]] < raw_cost[row["runId"]]
            )
            for other in eligible
        )
    best = min((raw_cost[row["runId"]] for row in eligible), default=None)
    cheapest = [row["runId"] for row in eligible if raw_cost[row["runId"]] == best]
    normalized_settings = {
        "minimumAcceptancePercent": quality, "maximumErrorPercent": error_ceiling,
        "minimumTasks": minimum_tasks, "maximumP95Ms": latency,
    }
    return {
        "schemaVersion": VERSION, "comparisonId": digest({"runs": runs, "settings": normalized_settings}),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "provenance": "SUPPLIED_MEASUREMENTS", "deploymentQualified": False,
        "workload": first["workload"], "settings": normalized_settings, "rows": rows,
        "lowestCostEligibleRunIds": cheapest,
        "notes": [
            "The frontier contains configurations for which no eligible alternative is at least as good "
            "on acceptance, observed p95 and cost per useful response, and strictly better on one.",
            "Useful means accepted by this rubric and within the selected per-request response-time target. "
            "Errors and unstarted tasks stay in the scheduled denominator.",
            "Prices estimate the benchmark window. Dedicated capacity is charged for the full elapsed "
            "window, including idle time inside it. Startup, idle time outside it, storage, networking "
            "and commitments need the separate Tokenomics/lifecycle comparison.",
            "These are observed sample results, not production SLOs. Repeats of one task are not "
            "independent new tasks. Models, runtimes and harnesses may all differ.",
            "Imported reports are supplied evidence, not independently authenticated measurements. "
            "They cannot clear deployment, security, capacity or model-access checks.",
        ],
    }
