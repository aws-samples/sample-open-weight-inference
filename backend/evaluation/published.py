"""Read public result metadata, never benchmark tasks, model weights or code.

The source adapter is deliberately fixed. User/model input cannot choose a URL.
Published results remain third-party evidence and cannot qualify a deployment.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from html.parser import HTMLParser
from typing import Any
from urllib.request import Request

from netio import open_url
from .benchmarks import digest

SOURCE = "https://www.swebench.com/"
METHODOLOGY = "https://www.swebench.com/SWE-bench/guides/datasets/"
# This adapter names a particular published benchmark, not a changing AWS limit.
BENCHMARK = "SWE-bench Verified"
TASK_COUNT = 500
MAX_BYTES = 4_000_000
CACHE_SECONDS = 900
_lock = threading.Lock()
_cache: tuple[float, dict[str, Any]] | None = None


class _Results(HTMLParser):
    def __init__(self):
        super().__init__()
        self.reading = False
        self.parts: list[str] = []
        self.matches = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("id") == "leaderboard-data" and attrs.get("type") == "application/json":
            self.reading = True
            self.matches += 1

    def handle_endtag(self, tag):
        if tag == "script":
            self.reading = False

    def handle_data(self, data):
        if self.reading:
            self.parts.append(data)


def _download() -> bytes:
    started = time.monotonic()
    chunks, size = [], 0
    request = Request(SOURCE, headers={"User-Agent": "EDDIE-Public-Benchmark-Reader/1", "Accept": "text/html"})
    with open_url(request, timeout=10, allowed_hosts=("www.swebench.com",)) as response:
        while chunk := response.read(64 * 1024):
            size += len(chunk)
            if size > MAX_BYTES or time.monotonic() - started > 15:
                raise ValueError("The public result source exceeded the read limit.")
            chunks.append(chunk)
    return b"".join(chunks)


def _safe(value: Any, maximum: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError("Missing or invalid published identity.")
    if any(ord(char) < 32 for char in value):
        raise ValueError("Unsupported control character in a published identity.")
    return value


def _amount(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or not 0 <= value <= 1_000_000:
        return None
    return Decimal(str(value))


def _usd(value: Decimal | None) -> str | None:
    return format(value.quantize(Decimal("0.00000001")), "f") if value is not None else None


def _interval(passed: int, count: int) -> list[float]:
    # Descriptive Wilson interval under an independent-task sampling assumption.
    # It is not a confidence claim about unseen customer workloads.
    z = 1.959963984540054
    p = passed / count
    denominator = 1 + z * z / count
    midpoint = (p + z * z / (2 * count)) / denominator
    radius = z * math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator
    return [round(max(0, midpoint - radius) * 100, 2), round(min(1, midpoint + radius) * 100, 2)]


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("The public source contains ambiguous duplicate fields.")
        result[key] = value
    return result


def _invalid_constant(_):
    raise ValueError("The public source contains a non-finite JSON value.")


def _row(raw: dict[str, Any]) -> dict[str, Any]:
    identifier = _safe(raw.get("folder"))
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", identifier):
        raise ValueError("Invalid published record ID.")
    version = _safe(raw.get("mini-swe-agent_version"), 40)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", version):
        raise ValueError("Invalid harness version.")
    tags = raw.get("tags", [])
    if not isinstance(tags, list) or len(tags) > 50:
        raise ValueError("Invalid published configuration tags.")
    models = [_safe(tag[7:]) for tag in tags if isinstance(tag, str) and tag.startswith("Model: ")]
    date = _safe(raw.get("date"), 10)
    datetime.strptime(date, "%Y-%m-%d")
    problems = []
    if "System: Attempts - 1" not in tags:
        problems.append("The source does not identify a single attempt per task.")
    warning = raw.get("warning")
    if warning:
        problems.append("The source flags this submission. Review its original record.")
    details = raw.get("per_instance_details")
    if not isinstance(details, dict) or len(details) != TASK_COUNT:
        problems.append(f"Complete per-task records for all {TASK_COUNT} benchmark tasks are unavailable.")
        details = details if isinstance(details, dict) and len(details) <= TASK_COUNT else {}
    observations, costs = {}, []
    unknown = 0
    for task, entry in details.items():
        if not isinstance(task, str) or len(task) > 160 or not isinstance(entry, dict):
            unknown += 1
            continue
        accepted = entry.get("resolved")
        if not isinstance(accepted, bool):
            unknown += 1
        else:
            observations[task] = accepted
        cost = _amount(entry.get("cost"))
        costs.append(cost)
    if unknown:
        problems.append(f"{unknown} task records lack an explicit pass/fail outcome.")
    passed = sum(observations.values())
    complete = len(observations) == TASK_COUNT
    total = sum(costs, Decimal(0)) if len(costs) == TASK_COUNT and all(v is not None for v in costs) else None
    if total is None:
        problems.append("Complete per-task cost records are unavailable.")
    percent = passed * 100 / TASK_COUNT if complete else None
    publisher_percent = _amount(raw.get("resolved"))
    publisher_total = _amount(raw.get("cost"))
    publisher_mean = _amount(raw.get("instance_cost"))
    outcomes_consistent = complete and publisher_percent is not None and abs(
        Decimal(str(percent)) - publisher_percent) <= Decimal("0.05")
    costs_consistent = total is not None and publisher_total is not None and publisher_mean is not None and (
        abs(total - publisher_total) <= Decimal("0.005")
        and abs(total / TASK_COUNT - publisher_mean) <= Decimal("0.00001"))
    if complete and not outcomes_consistent:
        problems.append("The task outcomes do not reproduce the published resolution percentage.")
    if total is not None:
        if publisher_total is None or abs(total - publisher_total) > Decimal("0.005"):
            problems.append("The task costs do not reproduce the published total cost.")
        if publisher_mean is None or abs(total / TASK_COUNT - publisher_mean) > Decimal("0.00001"):
            problems.append("The task costs do not reproduce the published mean cost.")
    if len(models) != 1:
        problems.append("The source does not identify one model configuration.")
    return {
        "id": identifier, "model": _safe(raw.get("name")), "modelId": models[0] if len(models) == 1 else "Not supplied",
        "openWeights": raw.get("os_model") if isinstance(raw.get("os_model"), bool) else None,
        "harness": "mini-SWE-agent", "harnessVersion": version,
        "reasoningEffort": _safe(raw["reasoning_effort"], 50) if raw.get("reasoning_effort") else "Not supplied",
        "date": date, "sourceReviewFlag": raw.get("checked") if isinstance(raw.get("checked"), bool) else None,
        "tasks": len(observations), "resolved": passed if complete else None,
        "outcomesConsistent": outcomes_consistent, "costsConsistent": costs_consistent,
        "resolvedPercent": percent, "publishedResolvedPercent": float(publisher_percent) if publisher_percent is not None else None,
        "resolutionInterval95": _interval(passed, TASK_COUNT) if complete else None,
        "costPerTaskUsd": _usd(total / TASK_COUNT) if total is not None else None,
        "costPerResolvedUsd": _usd(total / passed) if total is not None and passed else None,
        "totalCostUsd": _usd(total),
        "taskSetDigest": digest(sorted(observations)) if complete else None,
        "eligible": not problems, "reasons": problems, "frontier": False,
        # Server-only observations support paired comparisons. They never enter
        # the source repository or the model's context.
        "_observations": observations, "_total": total,
    }


def parse_source(body: bytes) -> dict[str, Any]:
    if len(body) > MAX_BYTES:
        raise ValueError("Public benchmark data exceeds the size limit.")
    parser = _Results()
    parser.feed(body.decode("utf-8"))
    if parser.matches != 1:
        raise ValueError("The public source format changed.")
    data = json.loads("".join(parser.parts), object_pairs_hook=_unique_object,
                      parse_constant=_invalid_constant)
    if not isinstance(data, list) or len(data) > 30:
        raise ValueError("The public source format changed.")
    verified = [item for item in data if isinstance(item, dict) and item.get("name") == "Verified"]
    if len(verified) != 1 or not isinstance(verified[0].get("results"), list) or len(verified[0]["results"]) > 2000:
        raise ValueError("The Verified result set is unavailable.")
    rows, malformed = [], 0
    for raw in verified[0]["results"]:
        if not isinstance(raw, dict) or raw.get("agent") != "mini-SWE-agent":
            continue
        try:
            rows.append(_row(raw))
        except (ValueError, TypeError, KeyError, OverflowError):
            malformed += 1
    if not rows or len({row["id"] for row in rows}) != len(rows):
        raise ValueError("No unambiguous mini-SWE-agent results are available.")
    versions = sorted({row["harnessVersion"] for row in rows})
    cohorts = []
    for version in versions:
        group = [row for row in rows if row["harnessVersion"] == version]
        ids = Counter(row["taskSetDigest"] for row in group if row["eligible"])
        reference = ids.most_common(1)[0][0] if ids else None
        for row in group:
            if row["eligible"] and row["taskSetDigest"] != reference:
                row["eligible"] = False
                row["reasons"].append("The task set differs from the other complete records in this harness cohort.")
        valid = [row for row in group if row["eligible"]]
        for row in valid:
            row["frontier"] = not any(
                other["resolved"] >= row["resolved"] and other["_total"] <= row["_total"]
                and (other["resolved"] > row["resolved"] or other["_total"] < row["_total"])
                for other in valid if other is not row
            )
        cohorts.append({"id": version, "label": f"mini-SWE-agent {version}", "records": len(group),
                        "comparable": len(valid), "latestDate": max(row["date"] for row in group)})
    cohorts.sort(key=lambda item: (item["latestDate"], item["comparable"]), reverse=True)
    return {
        "source": SOURCE, "methodology": METHODOLOGY, "benchmark": BENCHMARK,
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "sourceSha256": hashlib.sha256(body).hexdigest(), "cohorts": cohorts,
        "malformedRecords": malformed, "rows": rows,
    }


def _snapshot() -> dict[str, Any]:
    global _cache
    with _lock:
        if _cache is not None and time.monotonic() - _cache[0] < CACHE_SECONDS:
            return _cache[1]
        result = parse_source(_download())
        _cache = (time.monotonic(), result)
        return result


def public_benchmarks(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"cohort", "baseline", "contender"}:
        raise ValueError("Choose a published harness cohort and, optionally, two results.")
    for key in ("cohort", "baseline", "contender"):
        if key in payload:
            _safe(payload[key])
    try:
        source = _snapshot()
    except Exception:
        return {"state": "UNAVAILABLE", "source": SOURCE, "benchmark": BENCHMARK,
                "detail": "The public results could not be read or validated. Retry later or open the source. "
                          "No remembered scores or prices were substituted."}
    selected = payload.get("cohort") or source["cohorts"][0]["id"]
    if selected not in {cohort["id"] for cohort in source["cohorts"]}:
        raise ValueError("The selected cohort is not in the current source. Reload the results.")
    rows = [row for row in source["rows"] if row["harnessVersion"] == selected]
    paired = None
    if "baseline" in payload or "contender" in payload:
        by_id = {row["id"]: row for row in rows}
        if payload.get("baseline") not in by_id or payload.get("contender") not in by_id:
            raise ValueError("Both paired results must belong to the selected cohort.")
        a, b = by_id[payload["baseline"]], by_id[payload["contender"]]
        if not a["eligible"] or not b["eligible"] or a["taskSetDigest"] != b["taskSetDigest"]:
            raise ValueError("Paired comparisons require complete, consistent results for the same task set.")
        wins = sum(b["_observations"][task] and not passed for task, passed in a["_observations"].items())
        losses = sum(passed and not b["_observations"][task] for task, passed in a["_observations"].items())
        paired = {
            "baseline": a["id"], "contender": b["id"], "tasks": TASK_COUNT,
            "contenderOnly": wins, "baselineOnly": losses,
            "bothResolved": sum(passed and b["_observations"][task] for task, passed in a["_observations"].items()),
            "neitherResolved": sum(not passed and not b["_observations"][task] for task, passed in a["_observations"].items()),
            "differencePercentagePoints": round((wins - losses) * 100 / TASK_COUNT, 2),
        }
    result = {key: value for key, value in source.items() if key != "rows"}
    result.update(
        state="READY", selectedCohort=selected, cacheSeconds=CACHE_SECONDS,
        provenance="PUBLISHED_RESULTS", deploymentQualified=False,
        rows=[{key: value for key, value in row.items() if not key.startswith("_")} for row in rows],
        paired=paired,
        notes=[
            "Scores are recomputed from published test outcomes on SWE-bench Verified, not an LLM judge score. "
            "The sample tests coding issue resolution; it does not measure all inference workloads.",
            "Each cohort holds the agent version and task set constant. Model and reasoning settings differ. "
            "Exact weight digests, time/step budgets and all sampling settings are not established by this source.",
            "Costs are the source's historical API-cost records, including unresolved tasks. "
            "They are not current AWS prices or a self-hosted GPU bill. Use Tokenomics for AWS capacity scenarios.",
            "A 95% Wilson interval describes sampling uncertainty only under an independent-task assumption. "
            "Tasks may be correlated; it is not a guarantee for customer workloads or a significance test between models.",
            "The source review flag is reported separately. EDDIE checks coverage and arithmetic; it does not rerun "
            "these tests, verify submission integrity or rule out benchmark contamination.",
            "All source records in this harness cohort remain visible, including incomplete or inconsistent records. "
            "Only complete, internally consistent records with matching task sets enter the frontier.",
        ],
    )
    return copy.deepcopy(result)
