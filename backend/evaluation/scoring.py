"""Score supplied outputs without executing customer code or invoking a model.

This supplies a useful first task-evaluation path. It deliberately cannot issue
latency evidence, certify that a model produced the outputs, or qualify deployment.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

MAX_ROWS = 1000
MAX_BYTES = 1_000_000
SCORER_VERSION = "exact-answer/1"


def score_responses(payload: dict[str, Any]) -> dict[str, Any]:
    rows = payload.get("examples")
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
        raise ValueError(f"Add between 1 and {MAX_ROWS} examples")
    if len(json.dumps(payload, ensure_ascii=False).encode()) > MAX_BYTES:
        raise ValueError("The evaluation request must be smaller than 1 MB")
    case_sensitive = payload.get("caseSensitive", True)
    if not isinstance(case_sensitive, bool):
        raise ValueError("caseSensitive must be true or false")
    try:
        threshold = Decimal(str(payload.get("passPercent", "95")))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("The target must be a percentage from 0 to 100") from exc
    if not threshold.is_finite() or not 0 <= threshold <= 100:
        raise ValueError("The target must be a percentage from 0 to 100")

    results = []
    normalized = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"Example {index + 1} must be an object")
        prompt, expected, actual = row.get("input", ""), row.get("expected"), row.get("actual")
        if not isinstance(prompt, str) or not isinstance(expected, str) or not expected.strip():
            raise ValueError(f"Example {index + 1} needs an expected answer and text input")
        if actual is not None and not isinstance(actual, str):
            raise ValueError(f"Example {index + 1}: the model response must be text or null")
        error = row.get("error")
        if error is not None and not isinstance(error, str):
            raise ValueError(f"Example {index + 1}: error must be text")
        # Strip only leading/trailing whitespace; never normalize away mistakes
        # or parse generated prose to manufacture a successful label.
        left = actual.strip() if actual is not None else None
        right = expected.strip()
        if not case_sensitive:
            left = left.casefold() if left is not None else None
            right = right.casefold()
        passed = not error and left is not None and left == right
        normalized.append({"input": prompt, "expected": expected, "actual": actual, "error": error})
        results.append({
            "example": index + 1, "input": prompt, "expected": expected, "actual": actual,
            "passed": bool(passed), "error": error,
            "reason": "Matched" if passed else ("Request failed" if error else "No response" if actual is None or actual == "" else "Different answer"),
        })

    total = len(rows)
    passed_count = sum(row["passed"] for row in results)
    percent = Decimal(passed_count) * 100 / Decimal(total)
    # Wilson interval describes sampling uncertainty for this test set; it does
    # not prove the set represents production or that submitted outputs are real.
    z = 1.959963984540054
    proportion = passed_count / total
    denominator = 1 + z * z / total
    midpoint = (proportion + z * z / (2 * total)) / denominator
    radius = z * math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total)) / denominator
    manifest = {
        "scorerVersion": SCORER_VERSION, "caseSensitive": case_sensitive,
        "passPercent": str(threshold), "model": payload.get("model"),
        "examples": normalized,
    }
    identity = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {
        "evaluationId": identity,
        "scorerVersion": SCORER_VERSION,
        "model": payload.get("model"),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "provenance": "SUPPLIED_OUTPUTS",
        "modelInvoked": False,
        "latencyMeasured": False,
        "deploymentQualified": False,
        "total": total, "passed": passed_count, "failed": total - passed_count,
        "matchPercent": str(percent.quantize(Decimal("0.01"))),
        "targetPercent": str(threshold),
        "sampleTargetMet": percent >= threshold,
        "confidence95Percent": [round(max(0, midpoint - radius) * 100, 2), round(min(1, midpoint + radius) * 100, 2)],
        "caseSensitive": case_sensitive,
        "results": results,
        "note": (
            "EDDIE scored supplied responses. It did not invoke a model, verify the "
            "source of these responses, or measure latency. This result applies only "
            "to these examples and this exact-answer rule. It does not establish "
            "overall quality, safety or production readiness."
        ),
    }
