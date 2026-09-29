"""`includeCold` survives the whole round trip, in both directions.

The requirement is that cold-request inclusion is explicit end to end: whatever the
user said reaches the solver, is what the solver actually used, and is visible in the
evaluated request afterwards.

Two failure modes this guards, and they fail in opposite directions:

* An **explicit false** silently becoming true. The user said the objective applies
  to warm requests only; a lost `false` applies a stricter gate than they asked for
  and reports candidates as unqualified when they may well qualify.
* An **absent key** being read as false. `bool(payload.get("includeCold"))` does
  exactly this, and it is the dangerous direction: it quietly narrows the population
  to warm requests, which is how a candidate that releases capacity when idle comes
  to look fast.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from api.handler import _parse_slo, parse_request
from api.serialize import request_json


def payload(slo: dict) -> dict:
    return {
        "caseId": "cold-round-trip",
        "model": {
            "name": "Llama 3.1 8B",
            "architecture": "LlamaForCausalLM",
            "modality": "TEXT",
            "weightsGb": "16",
        },
        "workload": {"horizonHours": "72", "billableCopyHours": "6"},
        "slos": [slo],
    }


BASE = {"metric": "p99_latency_ms", "thresholdMs": "800"}


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


def test_an_explicit_false_is_preserved():
    slo = _parse_slo({**BASE, "includeCold": False})
    assert slo.include_cold is False


def test_an_absent_key_means_included():
    """The documented default, and the safe direction."""
    assert _parse_slo(BASE).include_cold is True


@pytest.mark.parametrize("falsey", [False, 0, "", None])
def test_the_default_is_not_reachable_by_accident(falsey):
    """`None` must mean absent, not false.

    A single `bool(...)` over these would collapse the distinction, and absence is
    the case that must stay True.
    """
    slo = _parse_slo({**BASE, "includeCold": falsey})
    if falsey is None:
        assert slo.include_cold is True, "absent must mean cold requests count"
    else:
        assert slo.include_cold is False


# --------------------------------------------------------------------------
# Serialization back out
# --------------------------------------------------------------------------


def test_an_explicit_false_survives_serialization():
    request = parse_request(payload({**BASE, "includeCold": False}))
    echoed = request_json(request)
    assert echoed["slos"][0]["includeCold"] is False
    # And through JSON, where a Python False could become a string.
    assert json.loads(json.dumps(echoed, default=str))["slos"][0]["includeCold"] is False


def test_true_survives_serialization():
    request = parse_request(payload({**BASE, "includeCold": True}))
    assert request_json(request)["slos"][0]["includeCold"] is True


def test_the_evaluated_request_shows_what_was_used_not_what_was_sent():
    """The echo comes from the parsed request, so it reflects the actual population.

    This is what makes the value checkable by a user: reading back the payload they
    submitted would prove nothing about what the solver did with it.
    """
    request = parse_request(payload({**BASE}))  # key absent
    echoed = request_json(request)
    # Absent on the way in, explicit on the way out.
    assert echoed["slos"][0]["includeCold"] is True


# --------------------------------------------------------------------------
# Percentile fidelity through the same round trip
# --------------------------------------------------------------------------


def test_a_p50_objective_round_trips_as_the_50th_percentile():
    request = parse_request(payload({"metric": "p50_latency_ms", "thresholdMs": "400"}))
    echoed = request_json(request)
    assert echoed["slos"][0]["percentile"] == "50"
    assert echoed["slos"][0]["metric"] == "p50_latency_ms"


def test_a_first_audio_objective_invents_no_percentile():
    request = parse_request(payload({"metric": "ttfa_ms", "thresholdMs": "800"}))
    echoed = request_json(request)
    # Null rather than the string "None", and rather than a fabricated 99.
    assert echoed["slos"][0]["percentile"] is None
    assert json.loads(json.dumps(echoed, default=str))["slos"][0]["percentile"] is None


def test_the_metric_is_never_rewritten_on_the_way_through():
    for metric in (
        "ttft_ms",
        "ttfa_ms",
        "conversation_response_ms",
        "p50_latency_ms",
        "p95_latency_ms",
        "p99_latency_ms",
    ):
        request = parse_request(payload({"metric": metric, "thresholdMs": "800"}))
        assert request.slos[0].metric == metric
        assert request_json(request)["slos"][0]["metric"] == metric


def test_threshold_is_carried_exactly():
    """Decimal, not float: 0.1-style drift in a threshold changes a gate outcome."""
    request = parse_request(payload({**BASE, "thresholdMs": "833.5"}))
    assert request.slos[0].threshold_ms == Decimal("833.5")
    assert request_json(request)["slos"][0]["thresholdMs"] == "833.5"
