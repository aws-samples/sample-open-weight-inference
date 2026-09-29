"""Typed inputs and outputs for the deterministic solver.

Mirrors the intake contract in docs/architecture.md. These types are deliberately
plain data: the solver performs no I/O and no LLM calls, so everything it needs
must arrive frozen in a PlacementRequest plus an EvidenceSnapshot.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from decimal import Decimal
from enum import Enum
from typing import Optional

from .money import CostBreakdown, Evidence


class GateStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    UNKNOWN = "UNKNOWN"


class Target(str, Enum):
    """Fundamental hosting/billing targets.

    JumpStart is a catalogue/deployment path and NIM a serving distribution;
    neither is a separate billing target, so neither appears here.
    """

    BEDROCK_NATIVE = "BEDROCK_NATIVE"
    BEDROCK_CMI = "BEDROCK_CMI"
    SAGEMAKER_REALTIME = "SAGEMAKER_REALTIME"
    SAGEMAKER_HYPERPOD = "SAGEMAKER_HYPERPOD"
    EC2_GPU = "EC2_GPU"
    EC2_CPU = "EC2_CPU"
    AWS_BATCH_CPU = "AWS_BATCH_CPU"
    EKS = "EKS"
    PROVIDER_API = "PROVIDER_API"


class Modality(str, Enum):
    TEXT = "TEXT"
    VISION_LANGUAGE = "VISION_LANGUAGE"
    ASR = "ASR"
    TTS = "TTS"
    SPEECH_TO_SPEECH = "SPEECH_TO_SPEECH"
    EMBEDDING = "EMBEDDING"


class CapacityState(str, Enum):
    """Honest capacity states from docs/architecture.md.

    Only HELD_READY (or RESERVED_FUTURE for a future-dated request) can satisfy a
    strict capacity requirement. An offering is not held inventory.
    """

    HELD_READY = "HELD_READY"
    RESERVED_FUTURE = "RESERVED_FUTURE"
    OBSERVED_RELEASED = "OBSERVED_RELEASED"
    OFFER_AVAILABLE = "OFFER_AVAILABLE"
    QUOTA_ONLY = "QUOTA_ONLY"
    UNAVAILABLE = "UNAVAILABLE"
    UNKNOWN = "UNKNOWN"


class OpsBurden(int, Enum):
    """Tie-break rubric. Lower is less operational burden."""

    SERVICE_API = 1
    MANAGED_CONTAINER_ENDPOINT = 2
    SELF_MANAGED_HOSTS = 3
    CLUSTER_DISTRIBUTED_RUNTIME = 4


class BlastRadius(int, Enum):
    """Tie-break rubric describing the shared failure domain. Lower is narrower."""

    ISOLATED_DEPLOYMENT = 1
    SHARED_ACCOUNT_SERVICE = 2
    SHARED_CLUSTER = 3


# --------------------------------------------------------------------------
# Request
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class SLO:
    """A latency or reliability objective.

    Cold requests are included in the population by default: excluding them is how
    a scale-to-zero candidate looks artificially fast.
    """

    metric: str  # p99_latency_ms | ttft_ms | ttfa_ms | conversation_response_ms
    threshold_ms: Decimal
    #: None when the objective names no percentile. It previously defaulted to 99,
    #: so "half of requests under 400 ms" was recorded as a 99th-percentile
    #: objective -- a far stricter requirement than the one that was asked for.
    #: For a metric whose name carries a percentile this is derived from the metric;
    #: for a first-token or first-audio objective it stays None unless stated.
    percentile: Optional[Decimal] = None
    include_cold: bool = True
    error_budget_fraction: Decimal = Decimal("0.01")


@dataclass(frozen=True)
class ModelSpec:
    """Artifact identity. Parameter count alone is insufficient for sizing."""

    name: str
    architecture: str  # e.g. "LlamaForCausalLM", "Qwen3MoeForCausalLM"
    modality: Modality = Modality.TEXT
    total_params_b: Optional[Decimal] = None
    active_params_b: Optional[Decimal] = None
    context_tokens: Optional[int] = None
    precision: str = "BF16"
    weights_gb: Optional[Decimal] = None
    weights_exportable: bool = True
    license_id: Optional[str] = None
    hf_repo: Optional[str] = None
    hf_commit: Optional[str] = None
    artifact_digest: Optional[str] = None
    source_kind: Optional[str] = None
    inference_profile_id: Optional[str] = None


@dataclass(frozen=True)
class WorkloadSpec:
    """Traffic shape. `billable_copy_hours` drives burst-priced targets.

    horizon_hours is the common comparison horizon; every candidate is costed over
    the same horizon and functional workload.
    """

    horizon_hours: Decimal
    billable_copy_hours: Optional[Decimal] = None
    dedicated_instance_hours: Optional[Decimal] = None
    requests: Optional[Decimal] = None
    input_tokens_per_request: Optional[Decimal] = None
    output_tokens_per_request: Optional[Decimal] = None
    concurrency: Optional[int] = None
    scheduled: bool = False
    description: str = ""

    def workload_hash(self) -> str:
        """Stable identity for the traffic shape, for benchmark applicability."""
        payload = json.dumps(
            {
                "horizon": str(self.horizon_hours),
                "billable": str(self.billable_copy_hours),
                "dedicated": str(self.dedicated_instance_hours),
                "requests": str(self.requests),
                "input_tokens": str(self.input_tokens_per_request),
                "output_tokens": str(self.output_tokens_per_request),
                "concurrency": self.concurrency,
                "scheduled": self.scheduled,
            },
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode()).hexdigest()[:16]

    @property
    def effective_dedicated_hours(self) -> Decimal:
        """Continuous allocation unless a schedule was supplied."""
        if self.dedicated_instance_hours is not None:
            return self.dedicated_instance_hours
        return self.horizon_hours


@dataclass(frozen=True)
class ConstraintSpec:
    permitted_regions: tuple[str, ...] = ("us-east-1",)
    account_id: Optional[str] = None
    budget_usd: Optional[Decimal] = None
    require_held_capacity: bool = False
    max_ops_burden: Optional[OpsBurden] = None
    residency_preference: tuple[str, ...] = ()
    # API entry region is not necessarily the processing region. An empty list
    # retains the original single/multiple-region restriction, never "anywhere".
    permitted_processing_regions: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlacementRequest:
    model: ModelSpec
    workload: WorkloadSpec
    slos: tuple[SLO, ...] = ()
    constraints: ConstraintSpec = field(default_factory=ConstraintSpec)
    case_id: str = "case-local"
    quality_goal: Optional[str] = None
    qualification: dict[str, str] = field(default_factory=dict)

    def input_hash(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True, default=str)
        return hashlib.sha256(payload.encode()).hexdigest()


# --------------------------------------------------------------------------
# Candidate and evidence
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    """A complete configuration, not a service name.

    "CMI cold scale-to-zero", "CMI with scheduled prewarming", and "CMI kept
    active" are three different candidates and must not share a benchmark.
    """

    candidate_id: str
    target: Target
    region: str
    model_ref: str
    instance_type: Optional[str] = None
    instance_count: Decimal = Decimal("1")
    cmus_per_copy: Optional[Decimal] = None
    scale_to_zero: bool = False
    prewarmed: bool = False
    ops_burden: OpsBurden = OpsBurden.MANAGED_CONTAINER_ENDPOINT
    blast_radius: BlastRadius = BlastRadius.ISOLATED_DEPLOYMENT
    recipe_id: Optional[str] = None
    supported_modalities: tuple[Modality, ...] = (Modality.TEXT,)
    supports_streaming: bool = True
    notes: str = ""
    inference_profile_id: Optional[str] = None
    processing_regions: tuple[str, ...] = ()
    routing_verified: bool = False
    routing_issue: Optional[str] = None

    @property
    def may_serve_cold_requests(self) -> bool:
        """Whether a request here can be served by a copy that was not resident.

        True for both elastic allocation policies, and that is the point. A
        scale-to-zero copy is released when idle, so the next request waits for a
        restoration. A *prewarmed* copy is kept resident to avoid that -- but
        prewarming reduces the exposure rather than removing it: the copy is still
        restored after a deployment, a scaling event or an eviction, and whoever
        issues the next request waits.

        So `prewarmed` is not a licence to judge a candidate on steady-state numbers
        alone. An objective that counts cold requests needs a cold measurement for
        either policy.

        False for a continuously allocated endpoint, where capacity is held for the
        whole horizon and is being paid for whether or not requests arrive.
        """
        return self.scale_to_zero or self.prewarmed


@dataclass(frozen=True)
class LatencyEvidence:
    """Measured tail latency for an exact candidate key.

    `sample_count` and `violation_rate_upper_bound` exist so a short smoke run
    cannot masquerade as tail qualification.

    Applicability is explicit. A run identifier alone cannot establish that the
    requested objective was measured: the run must state which candidate it was
    observed against, which metrics it actually covers, and under which workload.
    Evidence that does not declare those cannot be treated as measured, only as
    supplied -- reusing a nearest-looking benchmark is exactly what
    docs/architecture.md forbids.
    """

    p50_ms: Decimal
    p99_ms: Decimal
    sample_count: int
    cold_start_ms: Optional[Decimal] = None
    #: Each response-time metric has its own field. They are not interchangeable:
    #: a completion-latency measurement says nothing about how soon the first token
    #: or the first audio frame arrived, so it can never satisfy a TTFT or TTFA
    #: objective. Absent means unmeasured, and the gate reports UNKNOWN.
    p95_ms: Optional[Decimal] = None
    ttft_ms: Optional[Decimal] = None
    ttfa_ms: Optional[Decimal] = None
    conversation_response_ms: Optional[Decimal] = None
    #: False when the run deliberately excluded the first request after idle. Such a
    #: run cannot establish an objective whose population includes cold requests.
    includes_cold: bool = True
    violation_rate_upper_bound: Optional[Decimal] = None
    evidence: Evidence = Evidence.MEASURED
    benchmark_run_id: Optional[str] = None

    # ---- applicability ----
    #: Candidate the run was observed against. Must equal the candidate being
    #: evaluated; a run from a different configuration proves nothing about this one.
    measured_candidate_id: Optional[str] = None
    #: Metrics this run actually measured, e.g. ("p99_latency_ms", "ttft_ms").
    metrics_covered: tuple[str, ...] = ()
    #: Hash of the workload distribution the run was driven with, compared against
    #: the request's workload so a benchmark from different traffic is not reused.
    workload_hash: Optional[str] = None
    #: True only when a validation pass confirmed the run against its cache key.
    validated: bool = False
    #: Exact checkpoint observed. A run on a base model cannot qualify a fine-tune.
    measured_model_digest: Optional[str] = None

    def applicability(
        self, candidate_id: str, metric: str, workload_hash: Optional[str],
        model_digest: Optional[str] = None,
    ) -> Optional[str]:
        """Return why this evidence does not apply, or None when it does."""
        if not self.benchmark_run_id:
            return "the evidence carries no benchmark run identifier"
        if not self.validated:
            return f"run {self.benchmark_run_id} has not been validated"
        if model_digest and self.measured_model_digest != model_digest:
            return f"run {self.benchmark_run_id} does not verify this exact model checkpoint"
        if not self.measured_candidate_id:
            return f"run {self.benchmark_run_id} does not state which candidate it measured"
        if self.measured_candidate_id != candidate_id:
            return (
                f"run {self.benchmark_run_id} was measured against "
                f"{self.measured_candidate_id}, not {candidate_id}"
            )
        if not self.metrics_covered:
            return f"run {self.benchmark_run_id} does not state which metrics it covers"
        if metric not in self.metrics_covered:
            return (
                f"run {self.benchmark_run_id} covers "
                f"{', '.join(self.metrics_covered)} but not {metric}"
            )
        if workload_hash and self.workload_hash and self.workload_hash != workload_hash:
            return (
                f"run {self.benchmark_run_id} was driven with a different workload "
                "distribution"
            )
        return None


@dataclass(frozen=True)
class CandidateEvidence:
    """Everything the solver knows about one candidate. Absent fields are UNKNOWN."""

    latency: Optional[LatencyEvidence] = None
    capacity: CapacityState = CapacityState.UNKNOWN
    quota_headroom_ok: Optional[bool] = None
    license_cleared: Optional[bool] = None
    architecture_supported: Optional[bool] = None
    recipe_qualified: Optional[bool] = None
    cost: Optional[CostBreakdown] = None
    unsupported_reason: Optional[str] = None


@dataclass(frozen=True)
class EvidenceSnapshot:
    """Immutable, frozen evidence. Collectors refresh it before the solver runs."""

    per_candidate: dict[str, CandidateEvidence]
    retrieved_at: str
    price_source: str = ""

    def snapshot_hash(self) -> str:
        payload = json.dumps(
            {k: asdict(v) for k, v in sorted(self.per_candidate.items())},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(payload.encode()).hexdigest()


# --------------------------------------------------------------------------
# Decision
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Gate:
    name: str
    status: GateStatus
    reason: str
    evidence_ref: Optional[str] = None


@dataclass(frozen=True)
class EvaluatedCandidate:
    candidate: Candidate
    gates: tuple[Gate, ...]
    cost: Optional[CostBreakdown]

    @property
    def failures(self) -> tuple[Gate, ...]:
        return tuple(g for g in self.gates if g.status is GateStatus.FAIL)

    @property
    def unknowns(self) -> tuple[Gate, ...]:
        return tuple(g for g in self.gates if g.status is GateStatus.UNKNOWN)

    @property
    def is_feasible(self) -> bool:
        """Feasible means every gate passed. An UNKNOWN is not a pass."""
        return not self.failures and not self.unknowns

    @property
    def total_cost(self) -> Optional[Decimal]:
        return self.cost.total if self.cost else None

    def tie_key(self) -> tuple:
        return (
            int(self.candidate.ops_burden),
            int(self.candidate.blast_radius),
            self.candidate.candidate_id,
        )


@dataclass(frozen=True)
class PlacementDecision:
    """Structured result. `ranked` contains only all-pass candidates."""

    request_hash: str
    snapshot_hash: str
    solver_version: str
    ranked: tuple[EvaluatedCandidate, ...]
    excluded: tuple[EvaluatedCandidate, ...]
    unresolved: tuple[EvaluatedCandidate, ...]
    horizon_hours: Decimal
    assumptions: tuple[str, ...] = ()

    @property
    def has_qualified_placement(self) -> bool:
        return len(self.ranked) > 0

    @property
    def winner(self) -> Optional[EvaluatedCandidate]:
        return self.ranked[0] if self.ranked else None

    @property
    def outcome(self) -> str:
        return "QUALIFIED_PLACEMENT" if self.ranked else "NO_QUALIFIED_PLACEMENT"

    @property
    def blocked_only_on_latency(self) -> bool:
        """Nothing qualified, and the only thing standing in the way is measurement.

        Distinguished from a real incompatibility because the two need opposite
        responses. If an architecture is not importable, no amount of benchmarking
        helps. If every candidate is merely unmeasured, the answer is not "none of
        these work" -- it is "nobody has measured them yet", and the next step is a
        performance test rather than a different model.
        """
        if self.ranked or not self.unresolved:
            return False
        for evaluated in self.unresolved:
            if evaluated.failures:
                return False
            unknown = {g.name for g in evaluated.gates if g.status is GateStatus.UNKNOWN}
            if unknown != {"latency"}:
                return False
        return True

    @property
    def detail(self) -> Optional[str]:
        """A plain statement of why there is no recommendation yet."""
        if self.ranked:
            return None
        if self.blocked_only_on_latency:
            return (
                "No option is qualified yet; performance testing is needed. Every "
                "candidate meets the other requirements, but none has a response-time "
                "measurement for this exact configuration, so none can be shown to "
                "meet the objective. Nothing is ruled out."
            )
        return None
