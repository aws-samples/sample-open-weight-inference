"""Per-target cost formulas from docs/cost-model.md.

Each function implements one hosting target's billing model exactly as specified.
The duty-cycle breakeven at the bottom is the economic core of EDDIE: it decides
whether burst-priced serverless capacity or continuously allocated capacity is
cheaper for a given traffic shape.

Nothing here predicts latency. Cost functions answer "what does this cost";
feasibility gates in rules.py answer "is this allowed at all".
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from .money import CostBreakdown, Evidence, LineItem, Rate

MINUTES_PER_HOUR = Decimal("60")


# --------------------------------------------------------------------------
# 1. Bedrock Custom Model Import
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class CmiSpec:
    """Bedrock Custom Model Import billing inputs.

    `billable_copy_hours` is billable *presence*, not GPU utilization and not
    application busy time. It must come from a billing-policy simulation over a
    timestamped trace, or from observed CloudWatch ModelCopy episodes. Requests
    arriving often enough to defeat scale-to-zero produce nearly 100% billable
    duty at very low utilization.
    """

    cmus_per_copy: Decimal
    billable_copy_hours: Decimal
    stored_cmu_months: Decimal = Decimal("0")
    cmu_version: str = "v1.0"


def cmi_active_copy_hour_rate(cmus_per_copy: Decimal, per_cmu_minute: Rate) -> Decimal:
    """USD per hour for one *active* copy.

    r_CMI = CMUs_per_copy x price_per_CMU_minute x 60
    """
    return cmus_per_copy * per_cmu_minute.amount * MINUTES_PER_HOUR


def cmi_cost(
    spec: CmiSpec,
    per_cmu_minute: Optional[Rate],
    per_cmu_month: Optional[Rate],
    evidence: Evidence = Evidence.PROJECTED,
) -> CostBreakdown:
    """CMI_compute = u_m x r_m x B_m  (B_m expressed here in copy-hours)
    CMI_storage = u_m x s_m x M_m

    There is no import fee. Source S3 storage and transfer are separate items
    supplied by the caller.
    """
    items: list[LineItem] = [
        LineItem(
            label="Bedrock CMI active copy compute",
            phase="serving",
            quantity=spec.cmus_per_copy * spec.billable_copy_hours,
            quantity_unit="CMU-hour",
            rate=(
                Rate(
                    amount=per_cmu_minute.amount * MINUTES_PER_HOUR,
                    unit="USD/CMU-hour",
                    region=per_cmu_minute.region,
                    sku=per_cmu_minute.sku,
                    effective_date=per_cmu_minute.effective_date,
                    source=per_cmu_minute.source,
                )
                if per_cmu_minute
                else None
            ),
            evidence=evidence,
            note=(
                "Billable five-minute windows from first successful invocation. "
                "Billable presence, not utilization."
            ),
        )
    ]

    if spec.stored_cmu_months > 0:
        items.append(
            LineItem(
                label="Bedrock CMI model storage",
                phase="serving",
                quantity=spec.cmus_per_copy * spec.stored_cmu_months,
                quantity_unit="CMU-month",
                rate=per_cmu_month,
                evidence=evidence,
                note="Full-month allowance; no partial-month proration asserted.",
            )
        )

    return CostBreakdown(items=tuple(items))


# --------------------------------------------------------------------------
# 2. Bedrock native on-demand
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class TokenWorkload:
    """Token counts by disjoint billing category.

    The categories must be disjoint under the model's actual accounting: cached
    input is not charged twice.
    """

    uncached_input: Decimal
    output: Decimal
    cache_write: Decimal = Decimal("0")
    cache_read: Decimal = Decimal("0")


PER_MILLION = Decimal("1000000")


def native_token_cost(
    workload: TokenWorkload,
    p_input: Optional[Rate],
    p_output: Optional[Rate],
    p_cache_write: Optional[Rate] = None,
    p_cache_read: Optional[Rate] = None,
    evidence: Evidence = Evidence.PROJECTED,
) -> CostBreakdown:
    """C_text = (uncached_input x p_in + cache_write x p_cw
                 + cache_read x p_cr + output x p_out) / 1e6

    Rates are quoted per million tokens; quantities are converted to millions so
    the line item's rate unit and quantity unit agree.
    """
    items: list[LineItem] = []

    def add(label: str, tokens: Decimal, rate: Optional[Rate]) -> None:
        if tokens == 0 and rate is None:
            return
        items.append(
            LineItem(
                label=label,
                phase="serving",
                quantity=tokens / PER_MILLION,
                quantity_unit="million tokens",
                rate=rate,
                evidence=evidence,
            )
        )

    add("Native input tokens", workload.uncached_input, p_input)
    add("Native output tokens", workload.output, p_output)
    if workload.cache_write:
        add("Native cache-write tokens", workload.cache_write, p_cache_write)
    if workload.cache_read:
        add("Native cache-read tokens", workload.cache_read, p_cache_read)

    return CostBreakdown(items=tuple(items))


# --------------------------------------------------------------------------
# 3. SageMaker real-time endpoints
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class AllocationEpisode:
    """One period of continuous allocation at a fixed instance count.

    `billed_hours` must already include startup, warm readiness, rollout overlap,
    and drain. An autoscaling trace is partitioned into one episode per count
    change.
    """

    instance_count: Decimal
    billed_hours: Decimal
    label: str = "allocation"


def sagemaker_endpoint_cost(
    episodes: tuple[AllocationEpisode, ...],
    per_instance_hour: Optional[Rate],
    evidence: Evidence = Evidence.PROJECTED,
) -> CostBreakdown:
    """C_SM_compute = sum_e n_e x p_e x b_e

    Priced from the Hosting SKU. An EC2 rate or a Training/Cluster SKU is not a
    substitute.
    """
    items = [
        LineItem(
            label=f"SageMaker hosting compute ({ep.label})",
            phase="serving",
            quantity=ep.instance_count * ep.billed_hours,
            quantity_unit="instance-hour",
            rate=per_instance_hour,
            evidence=evidence,
            note="Includes readiness and drain per the allocation plan.",
        )
        for ep in episodes
    ]
    return CostBreakdown(items=tuple(items))


def continuous_allocation(horizon_hours: Decimal, instances: Decimal = Decimal("1")):
    """A single episode covering the whole horizon: 24 hours/day of charges."""
    return (
        AllocationEpisode(
            instance_count=instances,
            billed_hours=horizon_hours,
            label="continuous",
        ),
    )


# --------------------------------------------------------------------------
# 4. EKS control plane (worker capacity is priced separately as EC2)
# --------------------------------------------------------------------------

EKS_STANDARD_CONTROL_PLANE = Rate.usd(
    "0.10", "USD/cluster-hour", source="https://aws.amazon.com/eks/pricing/"
)
EKS_EXTENDED_CONTROL_PLANE = Rate.usd(
    "0.60", "USD/cluster-hour", source="https://aws.amazon.com/eks/pricing/"
)


# --------------------------------------------------------------------------
# Duty-cycle breakeven
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Breakeven:
    """Result of comparing burst-priced against continuously allocated capacity."""

    duty_fraction: Decimal
    cmi_active_hourly: Decimal
    dedicated_hourly: Decimal
    fixed_delta: Decimal
    horizon_hours: Decimal

    @property
    def display_percent(self) -> Decimal:
        return (self.duty_fraction * Decimal("100")).quantize(Decimal("0.01"))


def duty_cycle_breakeven(
    dedicated_hourly: Decimal,
    cmi_active_hourly: Decimal,
    horizon_hours: Decimal = Decimal("0"),
    cmi_fixed: Decimal = Decimal("0"),
    dedicated_fixed: Decimal = Decimal("0"),
) -> Breakeven:
    """D* = p_instance / r_CMI + (F_ded - F_CMI) / (H x r_CMI)

    Below D* the burst-priced copy is cheaper; above it the continuously
    allocated instance is. With no fixed-cost difference this reduces to the
    compute-only ratio instance_hourly / cmi_hourly_when_active.

    Duty means billable presence, not utilization.
    """
    if cmi_active_hourly <= 0:
        raise ValueError("cmi_active_hourly must be positive to form a breakeven ratio")

    duty = dedicated_hourly / cmi_active_hourly
    fixed_delta = dedicated_fixed - cmi_fixed
    if horizon_hours > 0 and fixed_delta != 0:
        duty += fixed_delta / (horizon_hours * cmi_active_hourly)

    return Breakeven(
        duty_fraction=duty,
        cmi_active_hourly=cmi_active_hourly,
        dedicated_hourly=dedicated_hourly,
        fixed_delta=fixed_delta,
        horizon_hours=horizon_hours,
    )


def breakeven_copy_hours(
    dedicated_hourly: Decimal,
    dedicated_instance_hours: Decimal,
    cmi_active_hourly: Decimal,
    cmi_fixed: Decimal = Decimal("0"),
    dedicated_fixed: Decimal = Decimal("0"),
) -> Decimal:
    """CMI_copy_hours* = (p_inst x ded_hours + F_ded - F_CMI) / r_CMI

    Absolute-copy-hours form. Use this instead of a duty fraction when the
    dedicated side is scheduled rather than continuous, or when instance count
    varies: aggregate copy-hours can exceed wall-clock hours.
    """
    if cmi_active_hourly <= 0:
        raise ValueError("cmi_active_hourly must be positive")
    numerator = dedicated_hourly * dedicated_instance_hours + dedicated_fixed - cmi_fixed
    return numerator / cmi_active_hourly
