"""Decision -> JSON for the frontend.

The UI must never parse assistant prose to learn a gate outcome or a number. Every
value it renders comes from here, and every value carries its evidence label so
MEASURED, PROJECTED, and UNKNOWN stay visually distinguishable.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Optional

from solver.cost import cmi_active_copy_hour_rate, duty_cycle_breakeven
from solver.models import (
    EvaluatedCandidate,
    GateStatus,
    PlacementDecision,
    PlacementRequest,
    Target,
)
from solver.money import CostBreakdown, Rate

CENTS = Decimal("0.01")


def _money(value: Optional[Decimal]) -> Optional[str]:
    """Format for display. None means UNKNOWN, which the UI renders as such."""
    if value is None:
        return None
    return str(value.quantize(CENTS, rounding=ROUND_HALF_UP))


def rate_json(rate: Optional[Rate]) -> Optional[dict[str, Any]]:
    if rate is None:
        return None
    return {
        "amount": str(rate.amount),
        "unit": rate.unit,
        "currency": rate.currency,
        "region": rate.region,
        "sku": rate.sku,
        "effectiveDate": rate.effective_date,
        "source": rate.source,
    }


def cost_json(cost: Optional[CostBreakdown]) -> Optional[dict[str, Any]]:
    if cost is None:
        return None
    return {
        "total": _money(cost.total),
        "totalExact": str(cost.total) if cost.total is not None else None,
        "isComplete": cost.is_complete,
        "unpriced": list(cost.unpriced),
        "knownSubtotal": _money(sum(
            (item.amount for item in cost.items if item.amount is not None), Decimal("0")
        )),
        "items": [
            {
                "label": item.label,
                "phase": item.phase,
                "quantity": str(item.quantity),
                "quantityUnit": item.quantity_unit,
                "rate": rate_json(item.rate),
                "amount": _money(item.amount),
                "evidence": item.evidence.value,
                "note": item.note,
            }
            for item in cost.items
        ],
    }


def candidate_json(ev: EvaluatedCandidate) -> dict[str, Any]:
    c = ev.candidate
    return {
        "candidateId": c.candidate_id,
        "target": c.target.value,
        "region": c.region,
        "modelRef": c.model_ref,
        "instanceType": c.instance_type,
        "instanceCount": str(c.instance_count),
        "cmusPerCopy": str(c.cmus_per_copy) if c.cmus_per_copy else None,
        "scaleToZero": c.scale_to_zero,
        "prewarmed": c.prewarmed,
        "opsBurden": c.ops_burden.name,
        "blastRadius": c.blast_radius.name,
        "recipeId": c.recipe_id,
        "notes": c.notes,
        "inferenceProfileId": c.inference_profile_id,
        "processingRegions": list(c.processing_regions),
        "isFeasible": ev.is_feasible,
        "cost": cost_json(ev.cost),
        "gates": [
            {
                "name": g.name,
                "status": g.status.value,
                "reason": g.reason,
                "evidenceRef": g.evidence_ref,
            }
            for g in ev.gates
        ],
        "failureCount": len(ev.failures),
        "unknownCount": len(ev.unknowns),
    }


def breakeven_json(
    decision: PlacementDecision, request: PlacementRequest
) -> Optional[dict[str, Any]]:
    """Duty-cycle breakeven between the CMI and dedicated candidates, when both exist.

    This is the number that explains *why* the ranking came out as it did, so it is
    computed for display even when one side failed a gate.
    """
    everything = decision.ranked + decision.unresolved + decision.excluded

    cmi = next(
        (
            e
            for e in everything
            if e.candidate.target is Target.BEDROCK_CMI and not e.candidate.prewarmed
        ),
        None,
    )

    # Compare against the *cheapest* priced dedicated candidate. Taking the first
    # by candidate ID would compare against whichever instance sorts first, which
    # silently reports a breakeven for a configuration nobody would choose.
    dedicated = [
        e
        for e in everything
        if e.candidate.target is Target.SAGEMAKER_REALTIME
        and e.cost is not None
        and e.cost.total is not None
    ]
    ded = min(dedicated, key=lambda e: e.cost.total) if dedicated else None  # type: ignore[union-attr]

    if not cmi or not ded or not cmi.cost or not ded.cost:
        return None

    compute_item = next(
        (i for i in cmi.cost.items if "compute" in i.label and i.rate is not None), None
    )
    ded_item = next(
        (i for i in ded.cost.items if i.rate is not None), None
    )
    if compute_item is None or ded_item is None:
        return None

    cmus = cmi.candidate.cmus_per_copy or Decimal("2")
    # The CMI compute line item's rate is already per CMU-hour.
    cmi_hourly = cmus * compute_item.rate.amount  # type: ignore[union-attr]
    ded_hourly = ded_item.rate.amount * ded.candidate.instance_count  # type: ignore[union-attr]

    storage = next((i for i in cmi.cost.items if "storage" in i.label), None)
    cmi_fixed = storage.amount if storage and storage.amount is not None else Decimal("0")

    be = duty_cycle_breakeven(
        dedicated_hourly=ded_hourly,
        cmi_active_hourly=cmi_hourly,
        horizon_hours=request.workload.horizon_hours,
        cmi_fixed=cmi_fixed,
    )

    horizon = request.workload.horizon_hours
    actual = (
        (request.workload.billable_copy_hours / horizon)
        if request.workload.billable_copy_hours is not None and horizon > 0
        else None
    )

    return {
        "breakevenDutyPercent": str(be.display_percent),
        "cmiActiveHourly": _money(cmi_hourly),
        "dedicatedHourly": _money(ded_hourly),
        "actualDutyPercent": (
            str((actual * Decimal("100")).quantize(CENTS)) if actual is not None else None
        ),
        "verdict": (
            None
            if actual is None
            else ("BURST_FAVOURS_CMI" if actual < be.duty_fraction else "STEADY_FAVOURS_DEDICATED")
        ),
        "explanation": (
            "Duty means billable presence, not GPU utilization. Below the breakeven "
            "the burst-priced import is cheaper; above it the continuously allocated "
            "endpoint is."
        ),
        "cmiComparedCandidate": cmi.candidate.candidate_id,
        "dedicatedComparedCandidate": ded.candidate.candidate_id,
    }


def qualification_json(
    decision: PlacementDecision, request: PlacementRequest
) -> dict[str, Any]:
    """Whether anything was actually measured, and how conditional the result is.

    `performanceMeasured` previously came from a PASS latency gate. That was wrong in
    the most misleading direction: with no SLO declared, the latency gate passes
    trivially ("no latency objective declared") and the provenance panel then read
    "Performance measured: Yes / Latency evidence: None supplied" — a contradiction
    that claimed qualification nobody had earned.

    Measured status is now derived from the presence of an applicable benchmark run
    reference on a ranked candidate. No run reference means nothing was measured,
    whatever the gates say.
    """
    # Evidence that satisfied the thresholds but is not qualified as a measurement:
    # either caller-supplied, or a run that did not establish applicability to this
    # candidate, metric and workload. The solver marks both with this reference.
    from solver.solve import SUPPLIED_EVIDENCE_REF as SUPPLIED_RUN_ID

    measured_runs: list[str] = []
    supplied_runs: list[str] = []
    for evaluated in decision.ranked:
        for gate in evaluated.gates:
            if gate.name == "latency" and gate.status is GateStatus.PASS:
                # A gate that passed because no objective was declared carries no
                # evidence reference; only a real benchmark run does.
                ref = gate.evidence_ref
                if not ref:
                    continue
                if ref == SUPPLIED_RUN_ID:
                    supplied_runs.append(ref)
                else:
                    measured_runs.append(ref)

    measured = bool(measured_runs)
    slo_requested = bool(request.slos)

    if measured:
        status = "MEASURED"
        note = (
            "Latency was compared against validated benchmark runs whose applicability "
            "to this exact candidate, metric and workload was established (runs: "
            f"{', '.join(sorted(set(measured_runs)))})."
        )
    elif supplied_runs:
        status = "SUPPLIED"
        note = (
            "Latency thresholds were satisfied against evidence that is not qualified "
            "as a measurement -- either supplied with the request, or a run that did "
            "not establish applicability to this exact candidate, metric and workload. "
            "EDDIE did not observe it; treat the result as conditional on that "
            "evidence being correct. The gate reason names the specific reason."
        )
    elif slo_requested:
        status = "NOT_MEASURED"
        note = (
            "A latency objective was requested but no applicable benchmark evidence "
            "exists, so no candidate can qualify on latency. Affected candidates are "
            "reported as unresolved with the experiment needed to resolve them."
        )
    else:
        status = "NOT_REQUESTED"
        note = (
            "No latency objective was declared, so no latency gate was evaluated and "
            "nothing was measured. This is not the same as a demonstrated SLO: the "
            "ranking reflects comparable cost and the remaining gates only."
        )

    return {
        # Kept for compatibility, but now only true when a run reference exists.
        "performanceMeasured": measured,
        "latencyStatus": status,
        "sloRequested": slo_requested,
        "benchmarkRunIds": sorted(set(measured_runs)),
        "conditional": bool(decision.ranked) and not measured,
        "note": note,
    }


def decision_json(
    decision: PlacementDecision, request: PlacementRequest, extra: Optional[dict] = None
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "outcome": decision.outcome,
        "requestHash": decision.request_hash,
        "snapshotHash": decision.snapshot_hash,
        "solverVersion": decision.solver_version,
        "horizonHours": str(decision.horizon_hours),
        "assumptions": list(decision.assumptions),
        "ranked": [candidate_json(e) for e in decision.ranked],
        "unresolved": [candidate_json(e) for e in decision.unresolved],
        "excluded": [candidate_json(e) for e in decision.excluded],
        "winner": (
            candidate_json(decision.winner) if decision.winner else None
        ),
        "breakeven": breakeven_json(decision, request),
        "counts": {
            "ranked": len(decision.ranked),
            "unresolved": len(decision.unresolved),
            "excluded": len(decision.excluded),
        },
        "qualification": qualification_json(decision, request),
        # Present only when nothing is ranked. Says whether the blocker is missing
        # measurement (testable) or a real incompatibility (not).
        "detail": decision.detail,
        "blockedOnlyOnLatency": decision.blocked_only_on_latency,
    }
    if extra:
        payload.update(extra)
    return payload


def request_json(request: PlacementRequest) -> dict[str, Any]:
    m, w, c = request.model, request.workload, request.constraints
    return {
        "caseId": request.case_id,
        "qualityGoal": request.quality_goal,
        "qualification": request.qualification or None,
        "model": {
            "name": m.name,
            "architecture": m.architecture,
            "modality": m.modality.value,
            "totalParamsB": str(m.total_params_b) if m.total_params_b else None,
            "contextTokens": m.context_tokens,
            "precision": m.precision,
            "weightsGb": str(m.weights_gb) if m.weights_gb else None,
            "weightsExportable": m.weights_exportable,
            "licenseId": m.license_id,
            "hfRepo": m.hf_repo,
            "hfCommit": m.hf_commit,
            **({"artifactDigest": m.artifact_digest} if m.artifact_digest else {}),
            "sourceKind": m.source_kind,
            "inferenceProfileId": m.inference_profile_id,
        },
        "workload": {
            "horizonHours": str(w.horizon_hours),
            "billableCopyHours": (
                str(w.billable_copy_hours) if w.billable_copy_hours is not None else None
            ),
            "dedicatedInstanceHours": (
                str(w.dedicated_instance_hours)
                if w.dedicated_instance_hours is not None
                else None
            ),
            "scheduled": w.scheduled,
            "concurrency": w.concurrency,
            "requests": str(w.requests) if w.requests is not None else None,
            "inputTokensPerRequest": str(w.input_tokens_per_request) if w.input_tokens_per_request is not None else None,
            "outputTokensPerRequest": str(w.output_tokens_per_request) if w.output_tokens_per_request is not None else None,
            "description": w.description,
        },
        "slos": [
            {
                "metric": s.metric,
                "thresholdMs": str(s.threshold_ms),
                # None when the objective names no percentile. Rendering "None"
                # as a string would put the word in front of the user.
                "percentile": str(s.percentile) if s.percentile is not None else None,
                "includeCold": s.include_cold,
                "errorBudgetFraction": str(s.error_budget_fraction),
            }
            for s in request.slos
        ],
        "constraints": {
            "permittedRegions": list(c.permitted_regions),
            "permittedProcessingRegions": list(c.permitted_processing_regions),
            "budgetUsd": str(c.budget_usd) if c.budget_usd else None,
            "requireHeldCapacity": c.require_held_capacity,
            "maxOpsBurden": c.max_ops_burden.name if c.max_ops_burden else None,
        },
    }
