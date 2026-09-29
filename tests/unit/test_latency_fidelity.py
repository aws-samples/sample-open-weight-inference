"""One measurement cannot answer a different question.

Two substitutions the solver must refuse:

1.  **Completion latency for a first-response objective.** How long the whole answer
    takes says nothing about how soon the first token appeared, or how soon the first
    audio frame played. A voice application whose requirement is "first audio within
    800 ms" is not served by knowing the utterance completed in 600 ms, and it is not
    *failed* by an utterance that took 3 s either.

2.  **A warm-only run for an objective that counts cold requests.** Excluding the
    first request after idle is exactly how a candidate that releases capacity looks
    fast. The population has to match.

Both refusals produce UNKNOWN, not PASS and not FAIL: the objective has not been
measured, so nothing is established in either direction.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from solver.models import (
    BlastRadius,
    Candidate,
    CandidateEvidence,
    CapacityState,
    EvidenceSnapshot,
    Gate,
    GateStatus,
    LatencyEvidence,
    Modality,
    ModelSpec,
    OpsBurden,
    PlacementRequest,
    SLO,
    Target,
    WorkloadSpec,
)
from solver.money import CostBreakdown, LineItem, Rate
from solver.solve import solve

MODEL = ModelSpec(
    name="Llama 3.1 8B",
    architecture="LlamaForCausalLM",
    modality=Modality.TEXT,
    weights_gb=Decimal("16"),
)


def candidate(**kw) -> Candidate:
    base = dict(
        candidate_id="cmi-scale-to-zero",
        target=Target.BEDROCK_CMI,
        region="us-east-1",
        model_ref="Llama 3.1 8B",
        cmus_per_copy=Decimal("2"),
        scale_to_zero=True,
        prewarmed=False,
        ops_burden=OpsBurden.SERVICE_API,
        blast_radius=BlastRadius.SHARED_ACCOUNT_SERVICE,
        recipe_id="cmi-import-v1",
        supported_modalities=(Modality.TEXT, Modality.VISION_LANGUAGE),
    )
    base.update(kw)
    return Candidate(**base)


def cost() -> CostBreakdown:
    return CostBreakdown(
        items=(
            LineItem(
                label="compute",
                phase="serving",
                quantity=Decimal("12"),
                quantity_unit="CMU-hour",
                rate=Rate(Decimal("0.05718"), "CMU-Hrs", region="us-east-1"),
            ),
        )
    )


def snapshot(candidate_id: str, latency: LatencyEvidence) -> EvidenceSnapshot:
    """All non-latency gates cleared, so the latency gate is the only variable."""
    return EvidenceSnapshot(
        retrieved_at="2026-09-15T00:00:00Z",
        per_candidate={
            candidate_id: CandidateEvidence(
                latency=latency,
                capacity=CapacityState.HELD_READY,
                quota_headroom_ok=True,
                license_cleared=True,
                architecture_supported=True,
                recipe_qualified=True,
                cost=cost(),
            )
        },
    )


def request(metric: str, threshold: str, include_cold: bool = True) -> PlacementRequest:
    return PlacementRequest(
        model=MODEL,
        workload=WorkloadSpec(
            horizon_hours=Decimal("72"), billable_copy_hours=Decimal("6")
        ),
        slos=(
            SLO(
                metric=metric,
                threshold_ms=Decimal(threshold),
                include_cold=include_cold,
            ),
        ),
    )


def latency_gate(decision, group: str = "unresolved") -> Gate:
    items = getattr(decision, group)
    assert items, f"expected a candidate in {group}, got none"
    return next(g for g in items[0].gates if g.name == "latency")


def completion_only(**kw) -> LatencyEvidence:
    """A run that measured completed responses and nothing else."""
    base = dict(
        p50_ms=Decimal("120"),
        p99_ms=Decimal("420"),
        sample_count=20_000,
        cold_start_ms=Decimal("500"),
        includes_cold=True,
        violation_rate_upper_bound=Decimal("0.004"),
        benchmark_run_id="run-completion",
    )
    base.update(kw)
    return LatencyEvidence(**base)


# --------------------------------------------------------------------------
# 1. Completion latency cannot satisfy a first-response objective
# --------------------------------------------------------------------------


@pytest.mark.parametrize("metric", ["ttft_ms", "ttfa_ms", "conversation_response_ms"])
def test_completion_evidence_cannot_satisfy_a_first_response_objective(metric):
    """Fast completion is not evidence about the first token or first audio.

    The run's p99 of 420 ms is comfortably inside the 800 ms threshold, so a solver
    willing to substitute would report PASS. That would claim a first-response
    guarantee nobody measured.
    """
    decision = solve(
        request(metric, "800"),
        (candidate(),),
        snapshot("cmi-scale-to-zero", completion_only()),
    )

    assert not decision.has_qualified_placement
    assert not decision.ranked
    gate = latency_gate(decision)
    assert gate.status is GateStatus.UNKNOWN
    assert "does not establish how soon the first token or first audio" in gate.reason


@pytest.mark.parametrize(
    "metric,field",
    [("ttft_ms", "ttft_ms"), ("ttfa_ms", "ttfa_ms"),
     ("conversation_response_ms", "conversation_response_ms")],
)
def test_each_first_response_metric_is_judged_on_its_own_measurement(metric, field):
    """Supplying the right measurement resolves the same objective."""
    decision = solve(
        request(metric, "800"),
        (candidate(),),
        snapshot(
            "cmi-scale-to-zero",
            completion_only(**{field: Decimal("300")}),
        ),
    )
    assert decision.has_qualified_placement, latency_gate(decision).reason


def test_ttfa_evidence_does_not_satisfy_a_ttft_objective():
    """Audio and text first-response times are different quantities."""
    decision = solve(
        request("ttft_ms", "800"),
        (candidate(),),
        snapshot("cmi-scale-to-zero", completion_only(ttfa_ms=Decimal("200"))),
    )
    assert not decision.has_qualified_placement
    assert latency_gate(decision).status is GateStatus.UNKNOWN


def test_a_slow_first_token_fails_rather_than_being_excused_by_fast_completion():
    """The refusal is symmetric: the right measurement is used, whichever way it goes."""
    decision = solve(
        request("ttft_ms", "800"),
        (candidate(),),
        snapshot(
            "cmi-scale-to-zero",
            completion_only(ttft_ms=Decimal("1500"), cold_start_ms=Decimal("100")),
        ),
    )
    gate = latency_gate(decision, "excluded")
    assert gate.status is GateStatus.FAIL
    assert "ttft_ms 1500 ms" in gate.reason


# --------------------------------------------------------------------------
# Percentile fidelity
# --------------------------------------------------------------------------


def test_p95_may_use_p99_evidence_but_says_so():
    """p99 bounds p95, so the substitution is sound -- and it is stated."""
    decision = solve(
        request("p95_latency_ms", "300"),
        (candidate(),),
        snapshot("cmi-scale-to-zero", completion_only(p99_ms=Decimal("900"))),
    )
    gate = latency_gate(decision, "excluded")
    assert gate.status is GateStatus.FAIL
    assert "bounds p95_latency_ms" in gate.reason


def test_p95_prefers_its_own_measurement_when_present():
    decision = solve(
        request("p95_latency_ms", "500"),
        (candidate(),),
        snapshot(
            "cmi-scale-to-zero",
            completion_only(p95_ms=Decimal("300"), p99_ms=Decimal("900")),
        ),
    )
    # Passes on the real p95 rather than failing on the p99 that bounds it.
    assert decision.has_qualified_placement, latency_gate(decision).reason


def test_p50_objective_is_not_recorded_as_a_p99_one():
    """"Half of requests under 400 ms" must not become a 99th-percentile promise."""
    from api.handler import _parse_slo

    slo = _parse_slo({"metric": "p50_latency_ms", "thresholdMs": "400"})
    assert slo.percentile == Decimal("50")

    ttft = _parse_slo({"metric": "ttft_ms", "thresholdMs": "800"})
    # A first-token objective carries no inherent percentile, so none is invented.
    assert ttft.percentile is None


def test_a_percentile_contradicting_its_metric_is_rejected():
    from api.handler import _parse_slo

    with pytest.raises(ValueError, match="contradicts metric"):
        _parse_slo(
            {"metric": "p50_latency_ms", "thresholdMs": "400", "percentile": "99"}
        )


# --------------------------------------------------------------------------
# 2. Warm-only evidence cannot establish a cold-inclusive objective
# --------------------------------------------------------------------------


def test_warm_only_evidence_cannot_establish_a_cold_inclusive_objective():
    """The population has to match the objective.

    The measured numbers are well inside the threshold, so a solver that ignored the
    population would pass this -- which is precisely how a candidate that releases
    capacity when idle comes to look fast.
    """
    decision = solve(
        request("p99_latency_ms", "800", include_cold=True),
        (candidate(),),
        snapshot(
            "cmi-scale-to-zero",
            completion_only(includes_cold=False, p99_ms=Decimal("300")),
        ),
    )
    assert not decision.has_qualified_placement
    gate = latency_gate(decision)
    assert gate.status is GateStatus.UNKNOWN
    assert "deliberately excluded cold requests" in gate.reason


def test_warm_only_evidence_does_establish_a_warm_only_objective():
    """Stated explicitly, a warm-only objective is a legitimate thing to ask."""
    decision = solve(
        request("p99_latency_ms", "800", include_cold=False),
        (candidate(),),
        snapshot(
            "cmi-scale-to-zero",
            completion_only(includes_cold=False, p99_ms=Decimal("300")),
        ),
    )
    assert decision.has_qualified_placement, latency_gate(decision).reason


def test_a_cold_inclusive_objective_needs_a_cold_measurement():
    decision = solve(
        request("p99_latency_ms", "800", include_cold=True),
        (candidate(),),
        snapshot("cmi-scale-to-zero", completion_only(cold_start_ms=None)),
    )
    gate = latency_gate(decision)
    assert gate.status is GateStatus.UNKNOWN
    assert "releases capacity when idle" in gate.reason


def test_an_explicit_false_is_not_read_as_absent():
    """`includeCold: false` must survive parsing rather than defaulting to true."""
    from api.handler import _parse_slo

    assert (
        _parse_slo(
            {"metric": "p99_latency_ms", "thresholdMs": "800", "includeCold": False}
        ).include_cold
        is False
    )
    # Absent means included: the safe direction, and the documented default.
    assert (
        _parse_slo({"metric": "p99_latency_ms", "thresholdMs": "800"}).include_cold
        is True
    )


def test_an_always_allocated_endpoint_needs_no_cold_measurement():
    """Capacity is held for the whole horizon and paid for regardless."""
    sagemaker = candidate(
        candidate_id="sagemaker-ml.g6.2xlarge",
        target=Target.SAGEMAKER_REALTIME,
        instance_type="ml.g6.2xlarge",
        cmus_per_copy=None,
        scale_to_zero=False,
        prewarmed=False,
        ops_burden=OpsBurden.MANAGED_CONTAINER_ENDPOINT,
        blast_radius=BlastRadius.ISOLATED_DEPLOYMENT,
        recipe_id="sagemaker-tgi-v1",
    )
    decision = solve(
        request("p99_latency_ms", "800", include_cold=True),
        (sagemaker,),
        snapshot("sagemaker-ml.g6.2xlarge", completion_only(cold_start_ms=None)),
    )
    assert decision.has_qualified_placement, latency_gate(decision).reason
