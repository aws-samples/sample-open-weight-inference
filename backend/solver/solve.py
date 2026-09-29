"""The deterministic solver.

    solve(request, snapshot, policy) -> PlacementDecision

Performs no network I/O and makes no LLM calls, so the same frozen inputs always
produce the same gates, costs, and ordering.

Three stages, lexicographic (docs/architecture.md):

  1. Feasibility  -- hard eliminations. Latency is a gate here, never a cost penalty.
  2. Cost         -- minimize comparable cost within the all-pass set only.
  3. Ties         -- (ops_burden, blast_radius, residency_preference, stable_id).

An UNKNOWN gate keeps a candidate out of the ranking entirely. It is neither a
pass nor a failure: it means "run this experiment to find out".
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Callable, Optional

from .models import (
    Candidate,
    CandidateEvidence,
    CapacityState,
    EvaluatedCandidate,
    EvidenceSnapshot,
    Gate,
    GateStatus,
    Modality,
    PlacementDecision,
    PlacementRequest,
    Target,
)

SOLVER_VERSION = "1.3.0"

# Marker for evidence that satisfied the thresholds but is not qualified as a
# measurement. Kept distinct from a real run id so nothing downstream can mistake
# supplied numbers for something EDDIE observed.
SUPPLIED_EVIDENCE_REF = "supplied"

# Architectures Bedrock Custom Model Import accepts. Server-side allowlist; there
# is no customer-side extension point, so an architecture absent here is a hard
# FAIL for CMI rather than an UNKNOWN.
# Source: docs/architecture.md and the CMI compatibility documentation.
CMI_SUPPORTED_ARCHITECTURES = frozenset(
    {
        "MistralForCausalLM",
        "MixtralForCausalLM",
        "T5ForConditionalGeneration",  # Flan
        "LlamaForCausalLM",
        "MllamaForConditionalGeneration",
        "GPTBigCodeForCausalLM",
        "Qwen2ForCausalLM",
        "Qwen2VLForConditionalGeneration",
        "Qwen2_5_VLForConditionalGeneration",
        "Qwen3ForCausalLM",
        "Qwen3MoeForCausalLM",
        "GptOssForCausalLM",
    }
)

# CMI serves text and vision-language only. Speech and embedding models cannot be
# imported at all.
CMI_SUPPORTED_MODALITIES = frozenset({Modality.TEXT, Modality.VISION_LANGUAGE})

CMI_REGIONS = frozenset({"us-east-1", "us-east-2", "us-west-2", "eu-central-1"})

# Documented CMI resource limits.
CMI_MAX_CONTEXT_TOKENS = 128_000
CMI_MAX_TEXT_WEIGHTS_GB = Decimal("200")
CMI_MAX_MULTIMODAL_WEIGHTS_GB = Decimal("100")


@dataclass(frozen=True)
class SolverPolicy:
    """Versioned decision policy.

    `min_samples_for_tail` prevents a short smoke run from qualifying a p99 gate.
    `required_violation_confidence` is the one-sided bound the measured violation
    rate must satisfy.
    """

    min_samples_for_tail: int = 10_000
    require_violation_bound: bool = True
    treat_offer_as_capacity: bool = False
    policy_version: str = "1.0.0"


# --------------------------------------------------------------------------
# Individual gates
# --------------------------------------------------------------------------


def gate_region(cand: Candidate, req: PlacementRequest) -> Gate:
    if cand.region not in req.constraints.permitted_regions:
        return Gate(
            "region",
            GateStatus.FAIL,
            f"{cand.region} is not in permitted regions "
            f"{list(req.constraints.permitted_regions)}",
        )
    if cand.target is Target.BEDROCK_CMI and cand.region not in CMI_REGIONS:
        return Gate(
            "region",
            GateStatus.FAIL,
            f"Custom Model Import is not available in {cand.region}",
        )
    if cand.target is Target.BEDROCK_NATIVE:
        if not cand.routing_verified or not cand.processing_regions:
            return Gate(
                "region", GateStatus.UNKNOWN,
                cand.routing_issue or "Choose and verify the Bedrock request route",
            )
        allowed = req.constraints.permitted_processing_regions or req.constraints.permitted_regions
        outside = sorted(set(cand.processing_regions) - set(allowed))
        if outside:
            return Gate(
                "region", GateStatus.FAIL,
                "This route may process requests outside your allowed Regions: "
                + ", ".join(outside)
                + ". Choose another route or explicitly allow its processing Regions.",
            )
        return Gate(
            "region", GateStatus.PASS,
            f"API entry: {cand.region}. Allowed processing Regions: "
            + ", ".join(cand.processing_regions),
        )
    return Gate("region", GateStatus.PASS, f"{cand.region} permitted")


def gate_architecture(cand: Candidate, req: PlacementRequest, ev: CandidateEvidence) -> Gate:
    """CMI's architecture allowlist is enforced server-side, so a miss is a FAIL."""
    if cand.target is Target.BEDROCK_NATIVE:
        return Gate(
            "architecture",
            GateStatus.PASS if ev.architecture_supported is True else (
                GateStatus.FAIL if ev.architecture_supported is False else GateStatus.UNKNOWN
            ),
            "Exact model found in the live Bedrock catalog" if ev.architecture_supported is True
            else ev.unsupported_reason or "Could not verify this model in the Bedrock catalog",
        )
    if cand.target is not Target.BEDROCK_CMI:
        if ev.architecture_supported is False:
            return Gate(
                "architecture",
                GateStatus.FAIL,
                ev.unsupported_reason or "Architecture unsupported by target",
            )
        return Gate("architecture", GateStatus.PASS, "No import allowlist applies")

    arch = req.model.architecture
    if arch not in CMI_SUPPORTED_ARCHITECTURES:
        return Gate(
            "architecture",
            GateStatus.FAIL,
            f"{arch} is not on the Custom Model Import allowlist. "
            "No framework can bypass this; the gate is server-side at import.",
        )
    if req.model.modality not in CMI_SUPPORTED_MODALITIES:
        return Gate(
            "architecture",
            GateStatus.FAIL,
            f"Custom Model Import does not accept {req.model.modality.value} models",
        )
    if req.model.context_tokens and req.model.context_tokens > CMI_MAX_CONTEXT_TOKENS:
        return Gate(
            "architecture",
            GateStatus.FAIL,
            f"Context {req.model.context_tokens} exceeds the {CMI_MAX_CONTEXT_TOKENS} limit",
        )
    if req.model.weights_gb is not None:
        cap = (
            CMI_MAX_MULTIMODAL_WEIGHTS_GB
            if req.model.modality is Modality.VISION_LANGUAGE
            else CMI_MAX_TEXT_WEIGHTS_GB
        )
        if req.model.weights_gb > cap:
            return Gate(
                "architecture",
                GateStatus.FAIL,
                f"Weights {req.model.weights_gb} GB exceed the {cap} GB limit",
            )
    return Gate("architecture", GateStatus.PASS, f"{arch} is import-eligible")


def gate_modality(cand: Candidate, req: PlacementRequest) -> Gate:
    if cand.target in (Target.EC2_CPU, Target.AWS_BATCH_CPU):
        return Gate("modality", GateStatus.UNKNOWN,
                    f"CPU compute can host different runtimes. Validate the complete {req.model.modality.value} "
                    "pipeline; general-purpose CPU hardware alone does not establish modality support.")
    if req.model.modality not in cand.supported_modalities:
        return Gate(
            "modality",
            GateStatus.FAIL,
            f"{cand.target.value} candidate does not serve {req.model.modality.value}",
        )
    return Gate("modality", GateStatus.PASS, f"{req.model.modality.value} supported")


def gate_weights_exportable(cand: Candidate, req: PlacementRequest) -> Gate:
    """A vendor API does not imply exportable weights.

    Self-hosting targets require an artifact you may actually deploy.
    """
    self_hosted = {
        Target.BEDROCK_CMI,
        Target.SAGEMAKER_REALTIME,
        Target.SAGEMAKER_HYPERPOD,
        Target.EC2_GPU,
        Target.EC2_CPU,
        Target.AWS_BATCH_CPU,
        Target.EKS,
    }
    if cand.target in self_hosted and not req.model.weights_exportable:
        return Gate(
            "weights_exportable",
            GateStatus.FAIL,
            "Model is API-only; weights are not exportable for self-hosting",
        )
    return Gate("weights_exportable", GateStatus.PASS, "Artifact availability consistent")


def gate_license(ev: CandidateEvidence) -> Gate:
    if ev.license_cleared is None:
        return Gate("license", GateStatus.UNKNOWN, "License/entitlement not established")
    if not ev.license_cleared:
        return Gate("license", GateStatus.FAIL, "License or entitlement not cleared")
    return Gate("license", GateStatus.PASS, "License cleared")


def gate_recipe(cand: Candidate, ev: CandidateEvidence) -> Gate:
    """Discoverable is not deployable. A generated Dockerfile is not a recipe."""
    if cand.target in (Target.BEDROCK_NATIVE, Target.PROVIDER_API):
        return Gate("recipe", GateStatus.PASS, "Managed API integration, no build recipe needed")
    if ev.recipe_qualified is None:
        return Gate("recipe", GateStatus.UNKNOWN, "No qualified deployment recipe recorded")
    if not ev.recipe_qualified:
        return Gate(
            "recipe",
            GateStatus.FAIL,
            "Deployment recipe exists but is not qualified for this artifact/target",
        )
    return Gate("recipe", GateStatus.PASS, f"Recipe {cand.recipe_id} qualified")


def gate_quota(ev: CandidateEvidence) -> Gate:
    if ev.quota_headroom_ok is None:
        return Gate("quota", GateStatus.UNKNOWN, "Quota headroom not collected")
    if not ev.quota_headroom_ok:
        return Gate("quota", GateStatus.FAIL, "Insufficient quota headroom")
    return Gate("quota", GateStatus.PASS, "Quota headroom sufficient")


def gate_capacity(cand: Candidate, req: PlacementRequest, ev: CandidateEvidence,
                  policy: SolverPolicy) -> Gate:
    """An offering is not held inventory.

    Bedrock serverless targets have provider-managed availability rather than a
    customer-held GPU reservation, so the strict-capacity requirement does not
    apply to them.
    """
    serverless = {Target.BEDROCK_NATIVE, Target.BEDROCK_CMI, Target.PROVIDER_API}
    if cand.target in serverless:
        return Gate(
            "capacity",
            GateStatus.PASS,
            "Provider-managed availability; no customer GPU reservation required",
        )

    if not req.constraints.require_held_capacity:
        if ev.capacity in (CapacityState.UNAVAILABLE,):
            return Gate("capacity", GateStatus.FAIL, "Capacity reported unavailable")
        if ev.capacity is CapacityState.UNKNOWN:
            return Gate("capacity", GateStatus.UNKNOWN, "Capacity evidence not collected")
        return Gate("capacity", GateStatus.PASS, f"Capacity state {ev.capacity.value}")

    if ev.capacity is CapacityState.HELD_READY:
        return Gate("capacity", GateStatus.PASS, "Held, ready allocation matches candidate")
    if ev.capacity is CapacityState.RESERVED_FUTURE:
        return Gate(
            "capacity",
            GateStatus.FAIL,
            "Reservation covers a future start and is not usable now",
        )
    if ev.capacity is CapacityState.OFFER_AVAILABLE and not policy.treat_offer_as_capacity:
        return Gate(
            "capacity",
            GateStatus.FAIL,
            "A purchasable offering was observed but no capacity is held",
        )
    if ev.capacity is CapacityState.OBSERVED_RELEASED:
        return Gate(
            "capacity",
            GateStatus.FAIL,
            "A previous allocation succeeded but has been released; historical only",
        )
    if ev.capacity in (CapacityState.QUOTA_ONLY, CapacityState.UNKNOWN):
        return Gate(
            "capacity",
            GateStatus.UNKNOWN,
            "Quota alone does not establish current capacity",
        )
    return Gate("capacity", GateStatus.FAIL, f"Capacity state {ev.capacity.value}")


# Which field of LatencyEvidence answers each SLO metric. A metric with no matching
# field cannot be evaluated: judging a time-to-first-audio objective against a p99
# figure silently answers a different question from the one asked.
METRIC_EVIDENCE_FIELD = {
    "p99_latency_ms": "p99_ms",
    # Its own measurement. This used to point at p99_ms, so a run that actually
    # measured p95 was ignored in favour of the looser tail, and the gate reported
    # a p99 figure while naming the p95 objective. p99 is still accepted as a
    # conservative stand-in when no p95 was measured -- see
    # METRIC_CONSERVATIVE_BOUND -- but only then, and the reason says so.
    "p95_latency_ms": "p95_ms",
    "p50_latency_ms": "p50_ms",
    "ttft_ms": "ttft_ms",
    # Each objective is judged against its own measurement. TTFA is not TTFT and
    # neither is completion latency: how soon the first audio frame plays is a
    # different quantity from how soon the first token appears, which is different
    # again from how long the whole answer takes. Mapping any of these onto another
    # would answer a question the user did not ask.
    "ttfa_ms": "ttfa_ms",
    "conversation_response_ms": "conversation_response_ms",
}

#: The percentile a metric's name carries, when it carries one.
#:
#: `percentile` used to default to 99 for every objective, so "half of requests
#: under 400 ms" was recorded and reported as a 99th-percentile requirement. It is
#: now derived from the metric, and an explicit percentile that contradicts the
#: metric is rejected rather than quietly overridden.
METRIC_IMPLIED_PERCENTILE = {
    "p50_latency_ms": Decimal("50"),
    "p95_latency_ms": Decimal("95"),
    "p99_latency_ms": Decimal("99"),
}

#: A measurement that strictly bounds another, usable only when the exact one is
#: absent and only with the substitution stated in the gate reason.
#:
#: p99 bounds p95: if 99% of requests are under the threshold then 95% are too, so
#: passing on p99 evidence is sound. Nothing bounds TTFT or TTFA -- a fast complete
#: response does not imply a fast first token -- so there is deliberately no entry
#: for them, and completion-latency evidence can never satisfy them.
METRIC_CONSERVATIVE_BOUND = {
    "p95_latency_ms": ("p99_ms", "p99"),
}


def gate_latency(cand: Candidate, req: PlacementRequest, ev: CandidateEvidence,
                 policy: SolverPolicy) -> Gate:
    """Latency eliminates; it never becomes a dollar penalty.

    A cold-start miss cannot be repaired by scoring the candidate slightly worse.
    Prewarming creates a different, more expensive candidate that must be
    benchmarked separately.
    """
    if not req.slos:
        return Gate("latency", GateStatus.PASS, "No latency objective declared")

    if ev.latency is None:
        return Gate(
            "latency",
            GateStatus.UNKNOWN,
            "No measured latency for this exact candidate key; benchmark required",
        )

    lat = ev.latency

    if lat.sample_count < policy.min_samples_for_tail:
        return Gate(
            "latency",
            GateStatus.UNKNOWN,
            f"INSUFFICIENT_EVIDENCE: {lat.sample_count} samples is below the "
            f"{policy.min_samples_for_tail} tail-qualification floor",
        )

    for slo in req.slos:
        field = METRIC_EVIDENCE_FIELD.get(slo.metric)
        if field is None:
            return Gate(
                "latency",
                GateStatus.UNKNOWN,
                f"No evidence field corresponds to {slo.metric}. EDDIE will not judge "
                f"it using a different measurement; supply {slo.metric} evidence or "
                "choose a metric this release evaluates.",
            )
        observed_for_metric = getattr(lat, field, None)
        substitution: Optional[str] = None
        if observed_for_metric is None:
            # The exact measurement is absent. A strictly-bounding one may stand in,
            # but only where that implication actually holds and only with the
            # substitution named. There is no bound for TTFT or TTFA, so completion
            # latency can never stand in for them.
            bound = METRIC_CONSERVATIVE_BOUND.get(slo.metric)
            bound_value = getattr(lat, bound[0], None) if bound else None
            if bound_value is None:
                return Gate(
                    "latency",
                    GateStatus.UNKNOWN,
                    f"{slo.metric} requires a {field} measurement, which this evidence "
                    f"does not carry. EDDIE will not judge it using a different "
                    f"measurement: a completed-response time does not establish how "
                    f"soon the first token or first audio arrived.",
                )
            observed_for_metric = bound_value
            substitution = (
                f"judged against {bound[1]} evidence, which bounds {slo.metric}"
            )

        if slo.include_cold and not lat.includes_cold:
            return Gate(
                "latency",
                GateStatus.UNKNOWN,
                "This objective counts the first request after idle, but the "
                "measurement deliberately excluded cold requests. A warm-only run "
                "cannot establish it; either measure with cold requests included or "
                "state that the objective applies to warm requests only.",
            )

        # Cold-start exposure.
        #
        # Prewarming *reduces* exposure; it does not make every request warm. A
        # prewarmed copy is still restored after a deployment, a scaling event or an
        # eviction, and those requests are in the population when the objective
        # includes cold requests. Requiring a cold measurement only for the
        # scale-to-zero candidate silently treated "prewarmed" as a guarantee, so a
        # prewarmed candidate could qualify on steady-state numbers alone.
        observed = observed_for_metric
        if slo.include_cold and cand.may_serve_cold_requests:
            if lat.cold_start_ms is None:
                return Gate(
                    "latency",
                    GateStatus.UNKNOWN,
                    (
                        "Prewarming reduces cold starts but does not eliminate them: a "
                        "restored copy still serves the request after a deployment, "
                        "scaling event or eviction. This objective counts those "
                        "requests and no cold-restoration time has been measured."
                        if cand.prewarmed
                        else "This candidate releases capacity when idle, so the first "
                        "request after idle pays a restoration whose duration has not "
                        "been measured for this configuration."
                    ),
                )
            observed = max(observed, lat.cold_start_ms)

        if observed > slo.threshold_ms:
            detail = (
                f"cold restoration {lat.cold_start_ms} ms"
                if observed == lat.cold_start_ms
                else f"{slo.metric} {observed_for_metric} ms"
            )
            reason = f"{detail} exceeds {slo.metric} threshold {slo.threshold_ms} ms"
            if substitution:
                reason = f"{reason} ({substitution})"
            return Gate(
                "latency",
                GateStatus.FAIL,
                reason,
                evidence_ref=lat.benchmark_run_id,
            )

        if policy.require_violation_bound:
            bound = lat.violation_rate_upper_bound
            if bound is None:
                return Gate(
                    "latency",
                    GateStatus.UNKNOWN,
                    "No one-sided confidence bound on the violation rate",
                )
            if bound > slo.error_budget_fraction:
                return Gate(
                    "latency",
                    GateStatus.FAIL,
                    f"Violation-rate upper bound {bound} exceeds error budget "
                    f"{slo.error_budget_fraction}",
                )

    # Applicability decides whether this counts as measured. A run identifier alone
    # proves nothing: it must state the candidate it was observed against, the
    # metrics it covers, and the workload it was driven with.
    inapplicable: list[str] = []
    workload_hash = req.workload.workload_hash()
    for slo in req.slos:
        why = lat.applicability(cand.candidate_id, slo.metric, workload_hash,
                                req.model.artifact_digest or req.model.hf_commit)
        if why:
            inapplicable.append(why)

    if inapplicable:
        return Gate(
            "latency",
            GateStatus.PASS,
            f"Thresholds met against supplied evidence, but it is not qualified as a "
            f"measurement: {inapplicable[0]}",
            # No evidence_ref: an unqualified run must not read as measured.
            evidence_ref=SUPPLIED_EVIDENCE_REF,
        )

    return Gate(
        "latency",
        GateStatus.PASS,
        f"Thresholds met against validated run {lat.benchmark_run_id} "
        f"over {lat.sample_count} samples",
        evidence_ref=lat.benchmark_run_id,
    )


def gate_budget(req: PlacementRequest, ev: CandidateEvidence) -> Gate:
    """A missing price makes budget qualification UNKNOWN, never a pass."""
    if ev.cost is None:
        return Gate("budget", GateStatus.UNKNOWN, "No cost estimate produced")
    if not ev.cost.is_complete:
        return Gate(
            "budget",
            GateStatus.UNKNOWN,
            f"Unpriced components: {', '.join(ev.cost.unpriced)}",
        )
    if req.constraints.budget_usd is None:
        return Gate("budget", GateStatus.PASS, "No budget ceiling declared")
    total = ev.cost.total
    assert total is not None
    if total > req.constraints.budget_usd:
        return Gate(
            "budget",
            GateStatus.FAIL,
            f"Estimated ${total.quantize(Decimal('0.01'))} exceeds budget "
            f"${req.constraints.budget_usd}",
        )
    return Gate("budget", GateStatus.PASS, f"Within ${req.constraints.budget_usd} budget")


def gate_ops(cand: Candidate, req: PlacementRequest) -> Gate:
    ceiling = req.constraints.max_ops_burden
    if ceiling is not None and int(cand.ops_burden) > int(ceiling):
        return Gate(
            "operations",
            GateStatus.FAIL,
            f"{cand.ops_burden.name} exceeds the declared ceiling {ceiling.name}",
        )
    return Gate("operations", GateStatus.PASS, f"{cand.ops_burden.name} acceptable")


# --------------------------------------------------------------------------
# Solver
# --------------------------------------------------------------------------

GateFn = Callable[[Candidate, PlacementRequest, CandidateEvidence, SolverPolicy], Gate]


def evaluate_candidate(
    cand: Candidate,
    req: PlacementRequest,
    ev: CandidateEvidence,
    policy: SolverPolicy,
) -> EvaluatedCandidate:
    """Run every gate. All gates always run so the report lists all reasons."""
    from .qualification import unresolved_requirements
    from .cpu import cpu_gates
    pending_requirements = unresolved_requirements(req.qualification)
    gates = (
        gate_region(cand, req),
        gate_architecture(cand, req, ev),
        gate_modality(cand, req),
        Gate(
            "quality", GateStatus.UNKNOWN if req.quality_goal else GateStatus.PASS,
            "An acceptance test with applicable model outputs is needed for the requested answer-quality goal"
            if req.quality_goal else "No answer-quality objective declared",
        ),
        gate_weights_exportable(cand, req),
        gate_license(ev),
        gate_recipe(cand, ev),
        gate_quota(ev),
        gate_capacity(cand, req, ev, policy),
        gate_latency(cand, req, ev, policy),
        gate_budget(req, ev),
        gate_ops(cand, req),
        *cpu_gates(cand, req),
        *(
            (Gate("declared_requirements", GateStatus.UNKNOWN, " ".join(pending_requirements)),)
            if pending_requirements else ()
        ),
    )
    return EvaluatedCandidate(candidate=cand, gates=gates, cost=ev.cost)


def _residency_rank(cand: Candidate, req: PlacementRequest) -> int:
    prefs = req.constraints.residency_preference
    if cand.region in prefs:
        return prefs.index(cand.region)
    return len(prefs)


def solve(
    request: PlacementRequest,
    candidates: tuple[Candidate, ...],
    snapshot: EvidenceSnapshot,
    policy: Optional[SolverPolicy] = None,
) -> PlacementDecision:
    """Evaluate, then rank the all-pass set by cost and declared tie-breaks."""
    policy = policy or SolverPolicy()

    evaluated = [
        evaluate_candidate(
            cand,
            request,
            snapshot.per_candidate.get(cand.candidate_id, CandidateEvidence()),
            policy,
        )
        # Deterministic enumeration order regardless of caller ordering.
        for cand in sorted(candidates, key=lambda c: c.candidate_id)
    ]

    feasible = [e for e in evaluated if e.is_feasible]
    excluded = [e for e in evaluated if e.failures]
    # UNKNOWN but no FAIL: resolvable by running the named experiment.
    unresolved = [e for e in evaluated if not e.failures and e.unknowns]

    def rank_key(e: EvaluatedCandidate) -> tuple:
        total = e.total_cost
        assert total is not None, "feasible candidates always have a complete cost"
        return (
            total,
            int(e.candidate.ops_burden),
            int(e.candidate.blast_radius),
            _residency_rank(e.candidate, request),
            e.candidate.candidate_id,
        )

    feasible.sort(key=rank_key)

    assumptions = [
        f"Common comparison horizon: {request.workload.horizon_hours} hours",
        "Latency is a feasibility gate, not a cost penalty",
        "UNKNOWN evidence excludes a candidate from ranking",
    ]
    if request.workload.billable_copy_hours is not None:
        assumptions.append(
            f"CMI billable presence assumed at {request.workload.billable_copy_hours} "
            "copy-hours; requires a billing-policy simulation to substantiate"
        )

    return PlacementDecision(
        request_hash=request.input_hash(),
        snapshot_hash=snapshot.snapshot_hash(),
        solver_version=f"{SOLVER_VERSION}+policy{policy.policy_version}",
        ranked=tuple(feasible),
        excluded=tuple(excluded),
        unresolved=tuple(unresolved),
        horizon_hours=request.workload.horizon_hours,
        assumptions=tuple(assumptions),
    )
