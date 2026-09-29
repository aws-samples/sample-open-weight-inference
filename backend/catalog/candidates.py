"""Deterministic candidate enumeration and evidence assembly.

Turns a validated case into the concrete configurations the solver will rank, then
attaches priced cost breakdowns. Candidate identity includes allocation policy,
because "CMI cold" and "CMI prewarmed" have different costs and different
feasibility.

No LLM is involved here. Enumeration is a small pure function over the request.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Optional

from solver.cost import (
    AllocationEpisode,
    CmiSpec,
    cmi_cost,
    continuous_allocation,
    sagemaker_endpoint_cost,
)
from .cmu import estimate_cmus
from solver.models import (
    BlastRadius,
    Candidate,
    CandidateEvidence,
    CapacityState,
    EvidenceSnapshot,
    Modality,
    OpsBurden,
    PlacementRequest,
    Target,
)
from solver.money import Rate
from solver.cpu import CPU_INSTANCE, CPU_TARGETS, cpu_cost
from .pricing import ARCHITECTURE_TO_CMI_FAMILY

# Instance shortlist for the SageMaker real-time target. A real solver evaluates
# more; these are the sizes with recipes qualified in this release.
SAGEMAKER_SHORTLIST = ("ml.g5.2xlarge", "ml.g5.12xlarge", "ml.g6.2xlarge")

# Rough weight-capacity screen used only to reject obvious non-fits. This is a
# memory feasibility hint, never a latency or throughput prediction.
INSTANCE_GPU_MEMORY_GB = {
    "ml.g5.2xlarge": Decimal("24"),
    "ml.g5.12xlarge": Decimal("96"),
    "ml.g6.2xlarge": Decimal("24"),
}


def enumerate_candidates(req: PlacementRequest) -> tuple[Candidate, ...]:
    """Search every permitted region; one region must not stand in for the others."""
    if not req.model.weights_exportable or req.model.architecture == "vendor-api" or req.model.source_kind == "bedrock":
        # Hosted APIs have no artifact for these self-hosting recipes. The native
        # collector enumerates exact Bedrock routes separately.
        return ()
    regions = tuple(dict.fromkeys(req.constraints.permitted_regions))
    candidates = []
    for region in regions:
        for candidate in _candidates_in_region(req, region):
            # Keep old single-region case links usable. Multi-region results need
            # distinct IDs so their prices and evidence cannot overwrite each other.
            if len(regions) > 1:
                candidate = replace(candidate, candidate_id=f"{candidate.candidate_id}@{region}")
            candidates.append(candidate)
    return tuple(sorted(candidates, key=lambda c: c.candidate_id))


def _candidates_in_region(req: PlacementRequest, region: str) -> tuple[Candidate, ...]:
    out: list[Candidate] = []
    arch = req.model.architecture

    # Compute choice is not inferred from a model name or missing latency target.
    # Keep concrete CPU profiles visible; the solver records unknowns/exclusions.
    for target, prefix, ops in (
        (Target.EC2_CPU, "ec2-cpu", OpsBurden.SELF_MANAGED_HOSTS),
        (Target.AWS_BATCH_CPU, "batch-cpu", OpsBurden.MANAGED_CONTAINER_ENDPOINT),
    ):
        out.append(Candidate(
            candidate_id=f"{prefix}-{CPU_INSTANCE}", target=target, region=region,
            model_ref=req.model.name, instance_type=CPU_INSTANCE,
            ops_burden=ops, supported_modalities=tuple(Modality),
            supports_streaming=target is Target.EC2_CPU,
            notes="CPU-only experiment profile: 32 vCPU, 64 GiB RAM, full model resident, no GPU or disk offload. "
            "The container, complete process memory and workload need validation. "
            + ("Queued inference on EC2 through AWS Batch; no additional Batch scheduling fee."
               if target is Target.AWS_BATCH_CPU else
               "An EC2 CPU worker; continuous allocation unless a shared start/stop schedule is supplied."),
        ))

    cmi_eligible = (
        arch in ARCHITECTURE_TO_CMI_FAMILY
        and req.model.modality in (Modality.TEXT, Modality.VISION_LANGUAGE)
    )

    if cmi_eligible:
        # How many Custom Model Units a copy needs, with its provenance.
        #
        # This was hardcoded to 2 for every imported model: right for an 8B at 128K,
        # and a 4x understatement for a 70B, which AWS documents as needing 8. Cost is
        # linear in this number, so a constant made every large-model quote wrong.
        cmu = estimate_cmus(
            architecture=arch,
            total_params_b=req.model.total_params_b,
            context_tokens=req.model.context_tokens,
            weights_gb=req.model.weights_gb,
        )
        cmu_note = f" {cmu.assumption}" if cmu.assumption else ""

        # Two distinct allocation policies, deliberately separate candidates.
        out.append(
            Candidate(
                candidate_id="cmi-scale-to-zero",
                target=Target.BEDROCK_CMI,
                region=region,
                model_ref=req.model.name,
                cmus_per_copy=cmu.units,
                scale_to_zero=True,
                prewarmed=False,
                ops_burden=OpsBurden.SERVICE_API,
                blast_radius=BlastRadius.SHARED_ACCOUNT_SERVICE,
                recipe_id="cmi-import-v1",
                supported_modalities=(Modality.TEXT, Modality.VISION_LANGUAGE),
                notes=(
                    "Releases capacity after 5 idle minutes, which is what makes it "
                    "cheap for bursty traffic. The first request after idle waits for "
                    "the model to be restored. That restoration has not been measured "
                    "for this configuration, so its duration is unknown here -- it is "
                    "the specific risk to test against a first-response objective."
                    + cmu_note
                ),
            )
        )
        out.append(
            Candidate(
                candidate_id="cmi-prewarmed",
                target=Target.BEDROCK_CMI,
                region=region,
                model_ref=req.model.name,
                cmus_per_copy=cmu.units,
                scale_to_zero=False,
                prewarmed=True,
                ops_burden=OpsBurden.SERVICE_API,
                blast_radius=BlastRadius.SHARED_ACCOUNT_SERVICE,
                recipe_id="cmi-import-v1",
                supported_modalities=(Modality.TEXT, Modality.VISION_LANGUAGE),
                notes=(
                    "Kept resident to reduce cold restorations rather than to remove "
                    "them: a copy is still restored after a deployment, a scaling "
                    "event or an eviction. Billable presence approaches 100%, "
                    "removing most of the scale-to-zero saving."
                    + cmu_note
                ),
            )
        )

    for instance in SAGEMAKER_SHORTLIST:
        if req.model.weights_gb is not None:
            capacity = INSTANCE_GPU_MEMORY_GB.get(instance)
            # Weights alone must fit with headroom for KV cache and activations.
            if capacity is not None and req.model.weights_gb > capacity * Decimal("0.8"):
                continue
        out.append(
            Candidate(
                candidate_id=f"sagemaker-{instance}",
                target=Target.SAGEMAKER_REALTIME,
                region=region,
                model_ref=req.model.name,
                instance_type=instance,
                instance_count=Decimal("1"),
                ops_burden=OpsBurden.MANAGED_CONTAINER_ENDPOINT,
                blast_radius=BlastRadius.ISOLATED_DEPLOYMENT,
                recipe_id="sagemaker-tgi-v1",
                supported_modalities=(
                    Modality.TEXT,
                    Modality.VISION_LANGUAGE,
                    Modality.ASR,
                    Modality.TTS,
                ),
                notes="Continuously allocated real-time endpoint.",
            )
        )

    return tuple(sorted(out, key=lambda c: c.candidate_id))


def cost_for_candidate(
    cand: Candidate,
    req: PlacementRequest,
    rates: dict[str, Optional[Rate]],
):
    """Price one candidate over the request's horizon.

    Billable presence for CMI comes from the workload: a scale-to-zero candidate
    uses the supplied billable_copy_hours, while a prewarmed candidate is billed
    for the whole horizon.
    """
    horizon = req.workload.horizon_hours

    def rate(name: str) -> Optional[Rate]:
        value = rates.get(f"region::{cand.region}::{name}", rates.get(name))
        # A price from the coordinator's region cannot price a different region.
        return value if value is None or value.region == cand.region else None

    if cand.target is Target.BEDROCK_CMI:
        if cand.prewarmed:
            copy_hours = horizon
        else:
            copy_hours = (
                req.workload.billable_copy_hours
                if req.workload.billable_copy_hours is not None
                else horizon
            )
        # Storage is budgeted as a full month; no partial-month proration asserted.
        months = Decimal("1")
        return cmi_cost(
            CmiSpec(
                # The candidate already carries its estimated units; no second default.
                cmus_per_copy=cand.cmus_per_copy or Decimal("2"),
                billable_copy_hours=copy_hours,
                stored_cmu_months=months,
            ),
            per_cmu_minute=rate("cmi_per_cmu_minute"),
            per_cmu_month=rate("cmi_per_cmu_month"),
        )

    if cand.target is Target.SAGEMAKER_REALTIME:
        hours = req.workload.effective_dedicated_hours
        if req.workload.scheduled and req.workload.dedicated_instance_hours is not None:
            episodes = (
                AllocationEpisode(
                    instance_count=cand.instance_count,
                    billed_hours=hours,
                    label="scheduled windows incl. readiness and drain",
                ),
            )
        else:
            episodes = continuous_allocation(hours, cand.instance_count)
        return sagemaker_endpoint_cost(
            episodes, per_instance_hour=rate(f"instance::{cand.instance_type}")
        )

    if cand.target in CPU_TARGETS:
        return cpu_cost(cand, req, rate(f"instance::{cand.instance_type}"))

    return None


def build_snapshot(
    req: PlacementRequest,
    candidates: tuple[Candidate, ...],
    rates: dict[str, Optional[Rate]],
    retrieved_at: str,
    latency_by_candidate: Optional[dict] = None,
    assume_cleared: bool = False,
) -> EvidenceSnapshot:
    """Assemble the frozen evidence snapshot the solver consumes.

    `assume_cleared` stipulates the checks this release does not collect: licence,
    quota, qualified recipe, and capacity. Stipulation is an explicit, surfaced
    assumption (the API returns checksStipulated) so it is never mistaken for a
    verified pass. Without it these gates correctly report UNKNOWN and no
    dedicated candidate can rank, because missing evidence is not an implicit pass.
    """
    latency_by_candidate = latency_by_candidate or {}
    per_candidate: dict[str, CandidateEvidence] = {}

    for cand in candidates:
        per_candidate[cand.candidate_id] = CandidateEvidence(
            latency=latency_by_candidate.get(cand.candidate_id),
            capacity=(
                CapacityState.HELD_READY if assume_cleared else CapacityState.UNKNOWN
            ),
            quota_headroom_ok=True if assume_cleared else None,
            license_cleared=True if assume_cleared else None,
            architecture_supported=True,
            # CPU is newly evaluated, not an executable/qualified app recipe.
            recipe_qualified=True if assume_cleared and cand.target not in CPU_TARGETS else None,
            cost=cost_for_candidate(cand, req, rates),
        )

    return EvidenceSnapshot(
        per_candidate=per_candidate,
        retrieved_at=retrieved_at,
        price_source="AWS Price List Query API",
    )
