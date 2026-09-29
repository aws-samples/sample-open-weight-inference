"""Solver behaviour tests.

The load-bearing properties, from docs/architecture.md:

* Latency is a hard gate. A cold-start miss eliminates; it is never a cost penalty.
* UNKNOWN is neither pass nor fail -- it keeps a candidate out of the ranking.
* The CMI architecture allowlist is a FAIL, not an UNKNOWN.
* Frozen inputs produce identical gates, costs, and ordering.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from solver.cost import (
    CmiSpec,
    cmi_active_copy_hour_rate,
    cmi_cost,
    continuous_allocation,
    sagemaker_endpoint_cost,
)
from solver.models import (
    Candidate,
    CandidateEvidence,
    CapacityState,
    ConstraintSpec,
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
from solver.solve import SolverPolicy, solve

CMI_MINUTE = Rate.usd("0.05718", "USD/CMU-minute", sku="8EJKXB49YY4SMCKM")
CMI_STORAGE = Rate.usd("1.95", "USD/CMU-month", sku="YQSJA22BPUVEWDW3")
SM_HOUR = Rate.usd("1.515", "USD/instance-hour", sku="BTQ8KZF3DKVFJY87")

LLAMA_8B = ModelSpec(
    name="Llama 3.1 8B",
    architecture="LlamaForCausalLM",
    modality=Modality.TEXT,
    total_params_b=Decimal("8"),
    context_tokens=128_000,
    weights_gb=Decimal("16"),
    weights_exportable=True,
    license_id="llama-3.1-community",
)


def cmi_candidate(**kw) -> Candidate:
    base = dict(
        candidate_id="cmi-cold",
        target=Target.BEDROCK_CMI,
        region="us-east-1",
        model_ref="imported/llama-3.1-8b",
        cmus_per_copy=Decimal("2"),
        scale_to_zero=True,
        ops_burden=OpsBurden.SERVICE_API,
        recipe_id="cmi-v1",
    )
    base.update(kw)
    return Candidate(**base)  # type: ignore[arg-type]


def sm_candidate(**kw) -> Candidate:
    base = dict(
        candidate_id="sm-g5-2xl",
        target=Target.SAGEMAKER_REALTIME,
        region="us-east-1",
        model_ref="s3://weights/llama-3.1-8b",
        instance_type="ml.g5.2xlarge",
        instance_count=Decimal("1"),
        ops_burden=OpsBurden.MANAGED_CONTAINER_ENDPOINT,
        recipe_id="sm-tgi-v1",
    )
    base.update(kw)
    return Candidate(**base)  # type: ignore[arg-type]


def all_clear(cost, latency=None) -> CandidateEvidence:
    """Evidence with every non-latency gate satisfied."""
    return CandidateEvidence(
        latency=latency,
        capacity=CapacityState.HELD_READY,
        quota_headroom_ok=True,
        license_cleared=True,
        architecture_supported=True,
        recipe_qualified=True,
        cost=cost,
    )


def snapshot(**per_candidate) -> EvidenceSnapshot:
    return EvidenceSnapshot(per_candidate=dict(per_candidate), retrieved_at="2026-09-12T00:00:00Z")


def good_latency(p99="420", cold=None, samples=12_000) -> LatencyEvidence:
    return LatencyEvidence(
        p50_ms=Decimal("120"),
        p99_ms=Decimal(p99),
        sample_count=samples,
        cold_start_ms=Decimal(cold) if cold else None,
        includes_cold=True,
        violation_rate_upper_bound=Decimal("0.004"),
        benchmark_run_id="run-1",
    )


# --------------------------------------------------------------------------
# Traffic shape decides the winner
# --------------------------------------------------------------------------


def test_bursty_event_ranks_cmi_first():
    """3-day bursty event: CMI's 8.33% billable duty beats continuous allocation."""
    workload = WorkloadSpec(
        horizon_hours=Decimal("72"),
        billable_copy_hours=Decimal("6"),
        description="three day bursty event",
    )
    req = PlacementRequest(model=LLAMA_8B, workload=workload)

    cmi = cmi_candidate(scale_to_zero=True)
    sm = sm_candidate()
    snap = snapshot(
        **{
            "cmi-cold": all_clear(
                cmi_cost(CmiSpec(Decimal("2"), Decimal("6"), Decimal("1")),
                         CMI_MINUTE, CMI_STORAGE)
            ),
            "sm-g5-2xl": all_clear(
                sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR)
            ),
        }
    )

    decision = solve(req, (cmi, sm), snap)
    assert decision.outcome == "QUALIFIED_PLACEMENT"
    assert decision.winner.candidate.candidate_id == "cmi-cold"
    assert decision.winner.total_cost == Decimal("45.06960")


def test_always_on_ranks_sagemaker_first():
    """Same artifact, 30-day always-on: the ranking inverts."""
    workload = WorkloadSpec(
        horizon_hours=Decimal("720"),
        billable_copy_hours=Decimal("720"),
        description="always on",
    )
    req = PlacementRequest(model=LLAMA_8B, workload=workload)
    snap = snapshot(
        **{
            "cmi-cold": all_clear(
                cmi_cost(CmiSpec(Decimal("2"), Decimal("720"), Decimal("1")),
                         CMI_MINUTE, CMI_STORAGE)
            ),
            "sm-g5-2xl": all_clear(
                sagemaker_endpoint_cost(continuous_allocation(Decimal("720")), SM_HOUR)
            ),
        }
    )
    decision = solve(req, (cmi_candidate(), sm_candidate()), snap)
    assert decision.winner.candidate.candidate_id == "sm-g5-2xl"
    assert decision.winner.total_cost == Decimal("1090.800")


# --------------------------------------------------------------------------
# Latency is a gate, not a penalty
# --------------------------------------------------------------------------


def test_cold_start_eliminates_cmi_under_tight_slo():
    """The central rule: a 45s cold start cannot be offset by being cheaper.

    CMI is ~$64 cheaper here and still must not win.
    """
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72"), billable_copy_hours=Decimal("6")),
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    snap = snapshot(
        **{
            "cmi-cold": all_clear(
                cmi_cost(CmiSpec(Decimal("2"), Decimal("6"), Decimal("1")),
                         CMI_MINUTE, CMI_STORAGE),
                latency=good_latency(p99="500", cold="45000"),
            ),
            "sm-g5-2xl": all_clear(
                sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR),
                latency=good_latency(p99="480"),
            ),
        }
    )
    decision = solve(req, (cmi_candidate(scale_to_zero=True), sm_candidate()), snap)

    assert decision.winner.candidate.candidate_id == "sm-g5-2xl"
    cmi_result = next(e for e in decision.excluded if e.candidate.candidate_id == "cmi-cold")
    latency_gate = next(g for g in cmi_result.gates if g.name == "latency")
    assert latency_gate.status is GateStatus.FAIL
    assert "cold restoration" in latency_gate.reason
    # Cheaper, and still excluded.
    assert cmi_result.total_cost < decision.winner.total_cost


def test_prewarming_does_not_excuse_a_candidate_from_cold_measurement():
    """Prewarming reduces cold-start exposure; it does not remove it.

    A prewarmed copy is still restored after a deployment, a scaling event or an
    eviction, and those requests are in the population when the objective counts
    cold requests. The gate previously required a cold measurement only for the
    scale-to-zero candidate, which treated "prewarmed" as a guarantee and let a
    prewarmed candidate qualify on steady-state numbers alone.
    """
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72"), billable_copy_hours=Decimal("72")),
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    warm = cmi_candidate(candidate_id="cmi-prewarmed", scale_to_zero=False, prewarmed=True)
    snap = snapshot(
        **{
            "cmi-prewarmed": all_clear(
                cmi_cost(CmiSpec(Decimal("2"), Decimal("72"), Decimal("1")),
                         CMI_MINUTE, CMI_STORAGE),
                # Steady-state only: no cold restoration measured.
                latency=good_latency(p99="500"),
            )
        }
    )
    decision = solve(req, (warm,), snap)
    assert not decision.has_qualified_placement
    gate = next(g for g in decision.unresolved[0].gates if g.name == "latency")
    assert gate.status is GateStatus.UNKNOWN
    assert "does not eliminate" in gate.reason


def test_prewarmed_cmi_passes_once_its_cold_restoration_is_measured():
    """With a measured cold restoration inside the threshold, it qualifies."""
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72"), billable_copy_hours=Decimal("72")),
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    warm = cmi_candidate(candidate_id="cmi-prewarmed", scale_to_zero=False, prewarmed=True)
    snap = snapshot(
        **{
            "cmi-prewarmed": all_clear(
                cmi_cost(CmiSpec(Decimal("2"), Decimal("72"), Decimal("1")),
                         CMI_MINUTE, CMI_STORAGE),
                latency=good_latency(p99="500", cold="700"),
            )
        }
    )
    decision = solve(req, (warm,), snap)
    assert decision.has_qualified_placement
    # Prewarmed duty is 100%, so it costs far more than the bursty cold variant.
    assert decision.winner.total_cost > Decimal("490")


def test_no_slo_means_latency_gate_passes_without_evidence():
    req = PlacementRequest(
        model=LLAMA_8B, workload=WorkloadSpec(horizon_hours=Decimal("72"))
    )
    snap = snapshot(
        **{"sm-g5-2xl": all_clear(
            sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR)
        )}
    )
    decision = solve(req, (sm_candidate(),), snap)
    assert decision.has_qualified_placement


# --------------------------------------------------------------------------
# UNKNOWN never passes
# --------------------------------------------------------------------------


def test_missing_latency_makes_candidate_unresolved_not_ranked():
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72")),
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    snap = snapshot(
        **{"sm-g5-2xl": all_clear(
            sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR)
        )}
    )
    decision = solve(req, (sm_candidate(),), snap)
    assert decision.outcome == "NO_QUALIFIED_PLACEMENT"
    assert len(decision.unresolved) == 1
    assert not decision.excluded


def test_smoke_run_sample_count_cannot_qualify_a_tail():
    """200 samples is a smoke run, not p99 qualification."""
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72")),
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    snap = snapshot(
        **{"sm-g5-2xl": all_clear(
            sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR),
            latency=good_latency(p99="100", samples=200),
        )}
    )
    decision = solve(req, (sm_candidate(),), snap)
    gate = next(g for g in decision.unresolved[0].gates if g.name == "latency")
    assert gate.status is GateStatus.UNKNOWN
    assert "INSUFFICIENT_EVIDENCE" in gate.reason


def test_missing_violation_bound_is_unknown():
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72")),
        slos=(SLO(metric="p99_latency_ms", threshold_ms=Decimal("800")),),
    )
    lat = LatencyEvidence(
        p50_ms=Decimal("100"),
        p99_ms=Decimal("400"),
        sample_count=20_000,
        includes_cold=True,
        violation_rate_upper_bound=None,
    )
    snap = snapshot(
        **{"sm-g5-2xl": all_clear(
            sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR), latency=lat
        )}
    )
    decision = solve(req, (sm_candidate(),), snap)
    assert not decision.has_qualified_placement


def test_unpriced_component_makes_budget_unknown():
    req = PlacementRequest(model=LLAMA_8B, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    unpriced = sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), None)
    snap = snapshot(**{"sm-g5-2xl": all_clear(unpriced)})
    decision = solve(req, (sm_candidate(),), snap)
    gate = next(g for g in decision.unresolved[0].gates if g.name == "budget")
    assert gate.status is GateStatus.UNKNOWN
    assert "Unpriced" in gate.reason


def test_empty_evidence_yields_unknowns_not_a_pass():
    req = PlacementRequest(model=LLAMA_8B, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    decision = solve(req, (sm_candidate(),), snapshot())
    assert decision.outcome == "NO_QUALIFIED_PLACEMENT"
    assert decision.unresolved[0].unknowns


# --------------------------------------------------------------------------
# CMI architecture allowlist
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "arch",
    ["DeepseekV3ForCausalLM", "KimiK3ForCausalLM", "SomeNovelArch"],
)
def test_unsupported_architecture_fails_cmi(arch):
    """Not UNKNOWN: the import job rejects it server-side. No framework fixes this."""
    model = ModelSpec(name="x", architecture=arch, modality=Modality.TEXT)
    req = PlacementRequest(model=model, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    snap = snapshot(
        **{"cmi-cold": all_clear(
            cmi_cost(CmiSpec(Decimal("2"), Decimal("6")), CMI_MINUTE, CMI_STORAGE)
        )}
    )
    decision = solve(req, (cmi_candidate(),), snap)
    gate = next(g for g in decision.excluded[0].gates if g.name == "architecture")
    assert gate.status is GateStatus.FAIL
    assert "allowlist" in gate.reason


def test_speech_model_cannot_use_cmi():
    """CMI accepts text and vision-language only."""
    model = ModelSpec(
        name="voice", architecture="LlamaForCausalLM", modality=Modality.SPEECH_TO_SPEECH
    )
    req = PlacementRequest(model=model, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    snap = snapshot(**{"cmi-cold": all_clear(None)})
    decision = solve(req, (cmi_candidate(),), snap)
    gate = next(g for g in decision.excluded[0].gates if g.name == "architecture")
    assert gate.status is GateStatus.FAIL
    assert "SPEECH_TO_SPEECH" in gate.reason


def test_cmi_context_limit_enforced():
    model = ModelSpec(
        name="long", architecture="LlamaForCausalLM", context_tokens=1_000_000
    )
    req = PlacementRequest(model=model, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    decision = solve(req, (cmi_candidate(),), snapshot(**{"cmi-cold": all_clear(None)}))
    gate = next(g for g in decision.excluded[0].gates if g.name == "architecture")
    assert gate.status is GateStatus.FAIL
    assert "Context" in gate.reason


def test_cmi_weight_size_limit_enforced():
    model = ModelSpec(
        name="huge", architecture="LlamaForCausalLM", weights_gb=Decimal("400")
    )
    req = PlacementRequest(model=model, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    decision = solve(req, (cmi_candidate(),), snapshot(**{"cmi-cold": all_clear(None)}))
    gate = next(g for g in decision.excluded[0].gates if g.name == "architecture")
    assert gate.status is GateStatus.FAIL
    assert "GB" in gate.reason


def test_cmi_unavailable_region_fails():
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72")),
        constraints=ConstraintSpec(permitted_regions=("ap-southeast-2",)),
    )
    cand = cmi_candidate(region="ap-southeast-2")
    decision = solve(req, (cand,), snapshot(**{"cmi-cold": all_clear(None)}))
    gate = next(g for g in decision.excluded[0].gates if g.name == "region")
    assert gate.status is GateStatus.FAIL


# --------------------------------------------------------------------------
# API-only models
# --------------------------------------------------------------------------


def test_api_only_model_cannot_self_host():
    """A third-party API does not imply exportable weights."""
    model = ModelSpec(
        name="vendor-voice", architecture="proprietary", weights_exportable=False
    )
    req = PlacementRequest(model=model, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    decision = solve(req, (sm_candidate(),), snapshot(**{"sm-g5-2xl": all_clear(None)}))
    gate = next(g for g in decision.excluded[0].gates if g.name == "weights_exportable")
    assert gate.status is GateStatus.FAIL


# --------------------------------------------------------------------------
# Capacity honesty
# --------------------------------------------------------------------------


def test_offer_available_fails_strict_capacity():
    """A purchasable offering is not held inventory."""
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72")),
        constraints=ConstraintSpec(require_held_capacity=True),
    )
    ev = CandidateEvidence(
        capacity=CapacityState.OFFER_AVAILABLE,
        quota_headroom_ok=True,
        license_cleared=True,
        recipe_qualified=True,
        cost=sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR),
    )
    decision = solve(req, (sm_candidate(),), snapshot(**{"sm-g5-2xl": ev}))
    gate = next(g for g in decision.excluded[0].gates if g.name == "capacity")
    assert gate.status is GateStatus.FAIL
    assert "no capacity is held" in gate.reason


def test_quota_only_is_unknown_not_pass():
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72")),
        constraints=ConstraintSpec(require_held_capacity=True),
    )
    ev = CandidateEvidence(
        capacity=CapacityState.QUOTA_ONLY,
        quota_headroom_ok=True,
        license_cleared=True,
        recipe_qualified=True,
        cost=sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR),
    )
    decision = solve(req, (sm_candidate(),), snapshot(**{"sm-g5-2xl": ev}))
    assert not decision.has_qualified_placement
    gate = next(g for g in decision.unresolved[0].gates if g.name == "capacity")
    assert gate.status is GateStatus.UNKNOWN


def test_serverless_targets_exempt_from_gpu_capacity():
    """Bedrock serverless has provider-managed availability, not held GPUs."""
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72"), billable_copy_hours=Decimal("6")),
        constraints=ConstraintSpec(require_held_capacity=True),
    )
    ev = CandidateEvidence(
        capacity=CapacityState.UNKNOWN,
        quota_headroom_ok=True,
        license_cleared=True,
        recipe_qualified=True,
        cost=cmi_cost(CmiSpec(Decimal("2"), Decimal("6")), CMI_MINUTE, CMI_STORAGE),
    )
    decision = solve(req, (cmi_candidate(),), snapshot(**{"cmi-cold": ev}))
    gate = next(
        g for g in (decision.ranked + decision.unresolved)[0].gates if g.name == "capacity"
    )
    assert gate.status is GateStatus.PASS


# --------------------------------------------------------------------------
# Determinism and tie-breaks
# --------------------------------------------------------------------------


def test_identical_inputs_produce_identical_decisions():
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72"), billable_copy_hours=Decimal("6")),
    )
    snap = snapshot(
        **{
            "cmi-cold": all_clear(
                cmi_cost(CmiSpec(Decimal("2"), Decimal("6"), Decimal("1")),
                         CMI_MINUTE, CMI_STORAGE)
            ),
            "sm-g5-2xl": all_clear(
                sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR)
            ),
        }
    )
    a = solve(req, (cmi_candidate(), sm_candidate()), snap)
    # Reversed input order must not change anything.
    b = solve(req, (sm_candidate(), cmi_candidate()), snap)

    assert a.request_hash == b.request_hash
    assert a.snapshot_hash == b.snapshot_hash
    assert [e.candidate.candidate_id for e in a.ranked] == [
        e.candidate.candidate_id for e in b.ranked
    ]
    assert [e.total_cost for e in a.ranked] == [e.total_cost for e in b.ranked]


def test_cost_tie_broken_by_ops_burden():
    """Equal cost: the lower operational burden wins, not an arbitrary order."""
    req = PlacementRequest(model=LLAMA_8B, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    same_cost = sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR)
    simple = sm_candidate(candidate_id="b-simple", ops_burden=OpsBurden.SERVICE_API)
    complex_ = sm_candidate(
        candidate_id="a-complex", ops_burden=OpsBurden.CLUSTER_DISTRIBUTED_RUNTIME
    )
    snap = snapshot(
        **{"b-simple": all_clear(same_cost), "a-complex": all_clear(same_cost)}
    )
    decision = solve(req, (simple, complex_), snap)
    assert decision.winner.candidate.candidate_id == "b-simple"


def test_ops_burden_ceiling_excludes_candidate():
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("72")),
        constraints=ConstraintSpec(max_ops_burden=OpsBurden.MANAGED_CONTAINER_ENDPOINT),
    )
    cand = sm_candidate(
        candidate_id="hyperpod", ops_burden=OpsBurden.CLUSTER_DISTRIBUTED_RUNTIME
    )
    snap = snapshot(
        **{"hyperpod": all_clear(
            sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), SM_HOUR)
        )}
    )
    decision = solve(req, (cand,), snap)
    gate = next(g for g in decision.excluded[0].gates if g.name == "operations")
    assert gate.status is GateStatus.FAIL


def test_budget_ceiling_excludes_expensive_candidate():
    req = PlacementRequest(
        model=LLAMA_8B,
        workload=WorkloadSpec(horizon_hours=Decimal("720")),
        constraints=ConstraintSpec(budget_usd=Decimal("500")),
    )
    snap = snapshot(
        **{"sm-g5-2xl": all_clear(
            sagemaker_endpoint_cost(continuous_allocation(Decimal("720")), SM_HOUR)
        )}
    )
    decision = solve(req, (sm_candidate(),), snap)
    gate = next(g for g in decision.excluded[0].gates if g.name == "budget")
    assert gate.status is GateStatus.FAIL
    assert "exceeds budget" in gate.reason


def test_all_gates_run_so_report_lists_every_reason():
    """Gates do not short-circuit: the user sees all failures at once."""
    model = ModelSpec(
        name="bad", architecture="UnknownArch", modality=Modality.ASR, weights_exportable=False
    )
    req = PlacementRequest(
        model=model,
        workload=WorkloadSpec(horizon_hours=Decimal("72")),
        constraints=ConstraintSpec(permitted_regions=("eu-west-1",)),
    )
    decision = solve(req, (cmi_candidate(),), snapshot())
    failures = {g.name for g in decision.excluded[0].failures}
    assert {"region", "architecture", "modality", "weights_exportable"} <= failures


def test_no_candidates_returns_no_qualified_placement():
    req = PlacementRequest(model=LLAMA_8B, workload=WorkloadSpec(horizon_hours=Decimal("72")))
    decision = solve(req, (), snapshot())
    assert decision.outcome == "NO_QUALIFIED_PLACEMENT"
    assert decision.winner is None
