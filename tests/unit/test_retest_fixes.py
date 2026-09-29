"""Regressions for project editing, response provenance and request failures.

Each test names the finding it pins so a future change cannot quietly reintroduce it.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from api.serialize import qualification_json
from solver.cost import continuous_allocation, sagemaker_endpoint_cost
from solver.models import (
    Candidate,
    CandidateEvidence,
    CapacityState,
    EvidenceSnapshot,
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
from solver.money import Rate
from solver.solve import solve

SM_HOUR = Rate.usd("1.515", "USD/instance-hour", sku="BTQ8KZF3DKVFJY87")
LLAMA = ModelSpec(name="Llama 3.1 8B", architecture="LlamaForCausalLM",
                  modality=Modality.TEXT, weights_gb=Decimal("16"))


def sm_candidate(cid="sagemaker-ml.g5.2xlarge") -> Candidate:
    return Candidate(
        candidate_id=cid, target=Target.SAGEMAKER_REALTIME, region="us-east-1",
        model_ref="s3://w", instance_type="ml.g5.2xlarge",
        ops_burden=OpsBurden.MANAGED_CONTAINER_ENDPOINT, recipe_id="r",
    )


def cleared(cost, latency=None) -> CandidateEvidence:
    return CandidateEvidence(
        latency=latency, capacity=CapacityState.HELD_READY, quota_headroom_ok=True,
        license_cleared=True, architecture_supported=True, recipe_qualified=True,
        cost=cost,
    )


def snap(**kw) -> EvidenceSnapshot:
    return EvidenceSnapshot(per_candidate=dict(kw), retrieved_at="2026-09-13T00:00:00Z")


def cost72():
    return sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR)


# --------------------------------------------------------------------------
# CHAT-02: "Performance measured: Yes" with no benchmark evidence
# --------------------------------------------------------------------------


def test_no_slo_means_not_measured_not_measured_yes():
    """The reported defect: no objective, no evidence, yet measured said Yes.

    A latency gate that passes because nothing was asked proves nothing.
    """
    req = PlacementRequest(model=LLAMA, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72())}))
    assert decision.has_qualified_placement

    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is False
    assert q["latencyStatus"] == "NOT_REQUESTED"
    assert q["sloRequested"] is False
    assert q["benchmarkRunIds"] == []
    # A ranked result with nothing measured must read as conditional.
    assert q["conditional"] is True


def test_supplied_evidence_is_not_measured():
    """Evidence handed to the API is real input, but EDDIE did not observe it."""
    req = PlacementRequest(
        model=LLAMA, workload=WorkloadSpec(horizon_hours=Decimal("72")),
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    lat = LatencyEvidence(
        p50_ms=Decimal("100"), p99_ms=Decimal("400"), sample_count=20_000,
        includes_cold=True, violation_rate_upper_bound=Decimal("0.001"),
        benchmark_run_id="supplied",
    )
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), lat)}))
    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is False, "supplied evidence must not read as measured"
    assert q["latencyStatus"] == "SUPPLIED"
    assert q["conditional"] is True


def applicable_run(candidate_id="sagemaker-ml.g5.2xlarge", workload=None,
                   metrics=("p99_latency_ms",), **kw) -> LatencyEvidence:
    """Evidence that establishes applicability, as MEASURED now requires."""
    base = dict(
        p50_ms=Decimal("100"), p99_ms=Decimal("400"), sample_count=20_000,
        includes_cold=True, violation_rate_upper_bound=Decimal("0.001"),
        benchmark_run_id="run-2026-09-13-abc123",
        measured_candidate_id=candidate_id,
        metrics_covered=metrics,
        workload_hash=workload.workload_hash() if workload else None,
        validated=True,
    )
    base.update(kw)
    return LatencyEvidence(**base)  # type: ignore[arg-type]


def test_validated_applicable_run_reads_as_measured():
    """MEASURED requires a validated run matching candidate, metric and workload."""
    workload = WorkloadSpec(horizon_hours=Decimal("72"))
    req = PlacementRequest(
        model=LLAMA, workload=workload,
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge":
                             cleared(cost72(), applicable_run(workload=workload))}))
    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is True
    assert q["latencyStatus"] == "MEASURED"
    assert q["benchmarkRunIds"] == ["run-2026-09-13-abc123"]
    assert q["conditional"] is False


def test_bare_run_id_is_not_measured():
    """A run identifier alone cannot establish that the objective was measured."""
    workload = WorkloadSpec(horizon_hours=Decimal("72"))
    req = PlacementRequest(
        model=LLAMA, workload=workload,
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    bare = LatencyEvidence(
        p50_ms=Decimal("100"), p99_ms=Decimal("400"), sample_count=20_000,
        includes_cold=True, violation_rate_upper_bound=Decimal("0.001"),
        benchmark_run_id="run-2026-09-13-abc123",  # no applicability declared
    )
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), bare)}))
    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is False
    assert q["latencyStatus"] == "SUPPLIED"
    assert q["conditional"] is True


def test_run_measured_against_another_candidate_is_not_measured():
    """Reusing a nearest-looking benchmark is what the architecture forbids."""
    workload = WorkloadSpec(horizon_hours=Decimal("72"))
    req = PlacementRequest(
        model=LLAMA, workload=workload,
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    other = applicable_run(candidate_id="sagemaker-ml.g5.12xlarge", workload=workload)
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), other)}))
    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is False
    gate = next(g for g in decision.ranked[0].gates if g.name == "latency")
    assert "was measured against" in gate.reason


def test_run_not_covering_the_requested_metric_is_not_measured():
    workload = WorkloadSpec(horizon_hours=Decimal("72"))
    req = PlacementRequest(
        model=LLAMA, workload=workload,
        slos=(SLO(metric="ttft_ms", threshold_ms=Decimal("800")),),
    )
    run = applicable_run(workload=workload, metrics=("p99_latency_ms",),
                         ttft_ms=Decimal("300"))
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), run)}))
    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is False
    gate = next(g for g in decision.ranked[0].gates if g.name == "latency")
    assert "but not ttft_ms" in gate.reason


def test_run_from_a_different_workload_is_not_measured():
    workload = WorkloadSpec(horizon_hours=Decimal("72"), concurrency=4)
    other_workload = WorkloadSpec(horizon_hours=Decimal("72"), concurrency=400)
    req = PlacementRequest(
        model=LLAMA, workload=workload,
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    run = applicable_run(workload=other_workload)
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), run)}))
    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is False
    gate = next(g for g in decision.ranked[0].gates if g.name == "latency")
    assert "different workload" in gate.reason


def test_unvalidated_run_is_not_measured():
    workload = WorkloadSpec(horizon_hours=Decimal("72"))
    req = PlacementRequest(
        model=LLAMA, workload=workload,
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    run = applicable_run(workload=workload, validated=False)
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), run)}))
    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is False
    gate = next(g for g in decision.ranked[0].gates if g.name == "latency")
    assert "not been validated" in gate.reason


def test_slo_requested_without_evidence_is_not_measured():
    req = PlacementRequest(
        model=LLAMA, workload=WorkloadSpec(horizon_hours=Decimal("72")),
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72())}))
    q = qualification_json(decision, req)
    assert q["performanceMeasured"] is False
    assert q["latencyStatus"] == "NOT_MEASURED"
    assert not decision.has_qualified_placement


# --------------------------------------------------------------------------
# CHAT-01: a TTFA objective must not be judged with a p99 number
# --------------------------------------------------------------------------


def test_ttfa_objective_is_not_judged_using_p99():
    """The reported defect: p99 TTFA became generic p99 latency.

    Carrying the label through is not enough -- the gate must refuse to answer a
    question it has no matching measurement for.
    """
    req = PlacementRequest(
        model=LLAMA, workload=WorkloadSpec(horizon_hours=Decimal("72")),
        slos=(SLO(metric="ttfa_ms", threshold_ms=Decimal("800")),),
    )
    # A comfortable p99 that would have passed if the metric were ignored.
    lat = LatencyEvidence(
        p50_ms=Decimal("90"), p99_ms=Decimal("200"), sample_count=20_000,
        includes_cold=True, violation_rate_upper_bound=Decimal("0.001"),
        benchmark_run_id="run-1",
    )
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), lat)}))
    assert not decision.has_qualified_placement, "TTFA was judged using p99"
    gate = next(g for g in decision.unresolved[0].gates if g.name == "latency")
    assert gate.status is GateStatus.UNKNOWN
    assert "ttfa_ms" in gate.reason


def test_ttft_objective_uses_the_ttft_field():
    req = PlacementRequest(
        model=LLAMA, workload=WorkloadSpec(horizon_hours=Decimal("72")),
        slos=(SLO(metric="ttft_ms", threshold_ms=Decimal("300")),),
    )
    over = LatencyEvidence(
        p50_ms=Decimal("90"), p99_ms=Decimal("200"), ttft_ms=Decimal("900"),
        sample_count=20_000, includes_cold=True,
        violation_rate_upper_bound=Decimal("0.001"), benchmark_run_id="run-1",
    )
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), over)}))
    gate = next(g for g in decision.excluded[0].gates if g.name == "latency")
    assert gate.status is GateStatus.FAIL
    # Failed on TTFT, not on the comfortable p99.
    assert "ttft_ms" in gate.reason


def test_ttft_objective_unknown_when_ttft_absent():
    req = PlacementRequest(
        model=LLAMA, workload=WorkloadSpec(horizon_hours=Decimal("72")),
        slos=(SLO(metric="ttft_ms", threshold_ms=Decimal("300")),),
    )
    lat = LatencyEvidence(
        p50_ms=Decimal("90"), p99_ms=Decimal("200"), sample_count=20_000,
        includes_cold=True, violation_rate_upper_bound=Decimal("0.001"),
        benchmark_run_id="run-1",
    )
    decision = solve(req, (sm_candidate(),),
                     snap(**{"sagemaker-ml.g5.2xlarge": cleared(cost72(), lat)}))
    gate = next(g for g in decision.unresolved[0].gates if g.name == "latency")
    assert gate.status is GateStatus.UNKNOWN
    assert "ttft_ms" in gate.reason
