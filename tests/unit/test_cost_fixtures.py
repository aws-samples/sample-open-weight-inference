"""The cost engine must reproduce examples/cost-scenarios.json exactly.

These fixtures are the arithmetic contract from docs/cost-model.md. They are
billing illustrations using real retrieved rates -- they are NOT evidence of
measured model performance, and passing them does not qualify a placement.
"""

from __future__ import annotations

import json
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import pytest

from solver.cost import (
    AllocationEpisode,
    CmiSpec,
    TokenWorkload,
    breakeven_copy_hours,
    cmi_active_copy_hour_rate,
    cmi_cost,
    continuous_allocation,
    duty_cycle_breakeven,
    native_token_cost,
    sagemaker_endpoint_cost,
)
from solver.money import Evidence, Rate

REPO = Path(__file__).resolve().parents[2]
FIXTURES = json.loads((REPO / "examples" / "cost-scenarios.json").read_text())


@pytest.fixture(scope="module")
def rates() -> dict[str, Rate]:
    r = FIXTURES["rates"]
    return {
        "cmi_minute": Rate.usd(
            r["cmi_usd_per_cmu_minute"], "USD/CMU-minute", sku=r["cmi_inference_sku"]
        ),
        "cmi_storage": Rate.usd(
            r["cmi_storage_usd_per_cmu_month"], "USD/CMU-month", sku=r["cmi_storage_sku"]
        ),
        "sagemaker": Rate.usd(
            r["sagemaker_usd_per_instance_hour"], "USD/instance-hour", sku=r["sagemaker_sku"]
        ),
    }


def scenario(scenario_id: str) -> dict:
    for s in FIXTURES["scenarios"]:
        if s["id"] == scenario_id:
            return s
    raise KeyError(scenario_id)


CMUS = Decimal(str(FIXTURES["model_assumptions"]["cmi_units_per_copy"]))


# --------------------------------------------------------------------------
# Derived rates
# --------------------------------------------------------------------------


def test_cmi_active_copy_hour_rate(rates):
    """2 CMU x $0.05718 x 60 = $6.8616 per active copy-hour."""
    got = cmi_active_copy_hour_rate(CMUS, rates["cmi_minute"])
    assert got == Decimal(FIXTURES["derived_rates"]["cmi_usd_per_active_copy_hour"])


def test_compute_only_breakeven_matches_fixture(rates):
    """$1.515 / $6.8616 = 22.08%.

    Compared against exact rational arithmetic rather than a copied decimal
    expansion. The fixture originally recorded ...910454 at 15 dp; the exact
    value 2525/11436 is ...910458. The fixture was corrected -- see
    docs/cost-model.md.
    """
    be = duty_cycle_breakeven(
        dedicated_hourly=rates["sagemaker"].amount,
        cmi_active_hourly=cmi_active_copy_hour_rate(CMUS, rates["cmi_minute"]),
    )

    num, den = FIXTURES["derived_rates"]["compute_only_breakeven_exact_rational"].split("/")
    exact = Decimal(int(num)) / Decimal(int(den))
    # Decimal division rounds to context precision, so agreement is asserted at a
    # declared precision rather than as exact rational equality.
    assert be.duty_fraction.quantize(Decimal("1E-15")) == exact.quantize(Decimal("1E-15"))

    recorded = Decimal(FIXTURES["derived_rates"]["compute_only_breakeven_fraction"])
    assert be.duty_fraction.quantize(Decimal("1E-15")) == recorded
    assert str(be.display_percent) == FIXTURES["derived_rates"][
        "compute_only_breakeven_display_percent"
    ]


# --------------------------------------------------------------------------
# Scenario: three-day bursty event -> CMI cheaper
# --------------------------------------------------------------------------


def test_three_day_event_cmi_compute(rates):
    s = scenario("three_day_event")
    breakdown = cmi_cost(
        CmiSpec(
            cmus_per_copy=CMUS,
            billable_copy_hours=Decimal(s["cmi_billable_copy_hours"]),
        ),
        per_cmu_minute=rates["cmi_minute"],
        per_cmu_month=rates["cmi_storage"],
    )
    assert breakdown.total == Decimal(s["cmi_compute_usd"])


def test_three_day_event_cmi_compute_plus_storage(rates):
    """Storage budgets a full month at $3.90 even for a 3-day event."""
    s = scenario("three_day_event")
    breakdown = cmi_cost(
        CmiSpec(
            cmus_per_copy=CMUS,
            billable_copy_hours=Decimal(s["cmi_billable_copy_hours"]),
            stored_cmu_months=Decimal("1"),
        ),
        per_cmu_minute=rates["cmi_minute"],
        per_cmu_month=rates["cmi_storage"],
    )
    assert breakdown.total == Decimal(s["cmi_compute_plus_storage_budget_usd"])
    storage = next(i for i in breakdown.items if "storage" in i.label)
    assert storage.amount == Decimal(s["cmi_full_month_storage_budget_usd"])


def test_three_day_event_billable_duty_fraction():
    s = scenario("three_day_event")
    episodes = Decimal(str(s["cmi_billable_episodes"]))
    minutes = Decimal(str(s["cmi_billable_minutes_per_episode"]))
    copy_hours = episodes * minutes / Decimal("60")
    assert copy_hours == Decimal(s["cmi_billable_copy_hours"])

    duty = copy_hours / Decimal(str(s["horizon_hours"]))
    assert duty.quantize(Decimal("1E-16")) == Decimal(
        s["cmi_billable_duty_fraction"]
    ).quantize(Decimal("1E-16"))


def test_three_day_event_sagemaker_continuous(rates):
    s = scenario("three_day_event")
    breakdown = sagemaker_endpoint_cost(
        continuous_allocation(Decimal(str(s["horizon_hours"]))),
        per_instance_hour=rates["sagemaker"],
    )
    assert breakdown.total == Decimal(s["sagemaker_compute_usd"])


def test_three_day_event_prefers_cmi(rates):
    """The whole point of the duty-cycle model: bursty favours CMI."""
    s = scenario("three_day_event")
    cmi = cmi_cost(
        CmiSpec(CMUS, Decimal(s["cmi_billable_copy_hours"]), Decimal("1")),
        rates["cmi_minute"],
        rates["cmi_storage"],
    ).total
    sm = sagemaker_endpoint_cost(
        continuous_allocation(Decimal(str(s["horizon_hours"]))), rates["sagemaker"]
    ).total
    assert cmi < sm


# --------------------------------------------------------------------------
# Scenario: always-on 30 days -> SageMaker cheaper
# --------------------------------------------------------------------------


def test_always_on_cmi_compute(rates):
    s = scenario("always_on_thirty_days")
    breakdown = cmi_cost(
        CmiSpec(CMUS, Decimal(s["cmi_billable_copy_hours"])),
        rates["cmi_minute"],
        rates["cmi_storage"],
    )
    assert breakdown.total == Decimal(s["cmi_compute_usd"])


def test_always_on_sagemaker_compute(rates):
    s = scenario("always_on_thirty_days")
    breakdown = sagemaker_endpoint_cost(
        continuous_allocation(Decimal(str(s["horizon_hours"]))), rates["sagemaker"]
    )
    assert breakdown.total == Decimal(s["sagemaker_compute_usd"])


def test_always_on_prefers_sagemaker(rates):
    """Same artifact, opposite answer. This inversion is the product's core insight."""
    s = scenario("always_on_thirty_days")
    cmi = cmi_cost(
        CmiSpec(CMUS, Decimal(s["cmi_billable_copy_hours"]), Decimal("1")),
        rates["cmi_minute"],
        rates["cmi_storage"],
    ).total
    sm = sagemaker_endpoint_cost(
        continuous_allocation(Decimal(str(s["horizon_hours"]))), rates["sagemaker"]
    ).total
    assert sm < cmi


# --------------------------------------------------------------------------
# Scenario: scheduled SageMaker counterexample
# --------------------------------------------------------------------------


def test_scheduled_sagemaker_beats_event_cmi(rates):
    """21 billed hours x $1.515 = $31.815, below the event's CMI compute.

    Changing only the *allocation policy* reverses the earlier conclusion, which
    is why allocation policy is part of candidate identity.
    """
    s = scenario("event_scheduled_sagemaker_counterexample")
    breakdown = sagemaker_endpoint_cost(
        (
            AllocationEpisode(
                instance_count=Decimal("1"),
                billed_hours=Decimal(s["sagemaker_billed_instance_hours"]),
                label="three scheduled windows",
            ),
        ),
        per_instance_hour=rates["sagemaker"],
    )
    assert breakdown.total == Decimal(s["sagemaker_compute_usd"])

    event_cmi = cmi_cost(
        CmiSpec(CMUS, Decimal(scenario("three_day_event")["cmi_billable_copy_hours"])),
        rates["cmi_minute"],
        rates["cmi_storage"],
    ).total
    assert breakdown.total < event_cmi


# --------------------------------------------------------------------------
# Breakeven with fixed-cost difference
# --------------------------------------------------------------------------


def test_event_breakeven_with_storage_allowance(rates):
    """Docs: with the $3.90 storage allowance the event breakeven is ~21.29%."""
    be = duty_cycle_breakeven(
        dedicated_hourly=rates["sagemaker"].amount,
        cmi_active_hourly=cmi_active_copy_hour_rate(CMUS, rates["cmi_minute"]),
        horizon_hours=Decimal("72"),
        cmi_fixed=Decimal("3.90"),
    )
    assert be.display_percent == Decimal("21.29")


def test_breakeven_copy_hours_scheduled_form(rates):
    """Absolute form: how many CMI copy-hours match 21 dedicated hours."""
    got = breakeven_copy_hours(
        dedicated_hourly=rates["sagemaker"].amount,
        dedicated_instance_hours=Decimal("21"),
        cmi_active_hourly=cmi_active_copy_hour_rate(CMUS, rates["cmi_minute"]),
    )
    # 21 x 1.515 / 6.8616 = 31.815 / 6.8616
    assert got.quantize(Decimal("0.0001")) == Decimal("4.6367")


# --------------------------------------------------------------------------
# UNKNOWN propagation: a missing price must never become zero
# --------------------------------------------------------------------------


def test_missing_cmi_price_yields_unknown_total(rates):
    breakdown = cmi_cost(
        CmiSpec(CMUS, Decimal("6")), per_cmu_minute=None, per_cmu_month=rates["cmi_storage"]
    )
    assert breakdown.total is None
    assert not breakdown.is_complete
    assert "Bedrock CMI active copy compute" in breakdown.unpriced


def test_missing_sagemaker_price_yields_unknown_total():
    breakdown = sagemaker_endpoint_cost(
        continuous_allocation(Decimal("720")), per_instance_hour=None
    )
    assert breakdown.total is None


def test_unknown_total_is_not_comparable_as_zero(rates):
    """A candidate with an unpriced component must not sort below a priced one."""
    unknown = cmi_cost(CmiSpec(CMUS, Decimal("6")), None, None)
    priced = sagemaker_endpoint_cost(continuous_allocation(Decimal("72")), rates["sagemaker"])
    assert unknown.total is None
    assert priced.total is not None


# --------------------------------------------------------------------------
# Native token costing
# --------------------------------------------------------------------------


def test_native_token_cost_disjoint_categories():
    """Cached input must not be charged at the uncached rate as well."""
    breakdown = native_token_cost(
        TokenWorkload(
            uncached_input=Decimal("1000000"),
            output=Decimal("500000"),
            cache_read=Decimal("2000000"),
        ),
        p_input=Rate.usd("3.00", "USD/million tokens"),
        p_output=Rate.usd("15.00", "USD/million tokens"),
        p_cache_read=Rate.usd("0.30", "USD/million tokens"),
    )
    # 1.0x3.00 + 0.5x15.00 + 2.0x0.30 = 3.00 + 7.50 + 0.60
    assert breakdown.total == Decimal("11.10")


def test_native_token_cost_missing_output_rate_is_unknown():
    breakdown = native_token_cost(
        TokenWorkload(uncached_input=Decimal("1000"), output=Decimal("100")),
        p_input=Rate.usd("3.00", "USD/million tokens"),
        p_output=None,
    )
    assert breakdown.total is None


# --------------------------------------------------------------------------
# Guardrails
# --------------------------------------------------------------------------


def test_float_rate_rejected():
    with pytest.raises(TypeError):
        Rate(amount=0.05718, unit="USD/CMU-minute")  # type: ignore[arg-type]


def test_negative_rate_rejected():
    with pytest.raises(ValueError):
        Rate(amount=Decimal("-1"), unit="USD/CMU-minute")


def test_zero_cmi_rate_breakeven_rejected():
    with pytest.raises(ValueError):
        duty_cycle_breakeven(Decimal("1.515"), Decimal("0"))


def test_phase_partitioning(rates):
    """Every billable segment belongs to exactly one phase."""
    breakdown = cmi_cost(
        CmiSpec(CMUS, Decimal("6"), Decimal("1")), rates["cmi_minute"], rates["cmi_storage"]
    )
    assert breakdown.by_phase("serving") == breakdown.total
    assert breakdown.by_phase("platform") == Decimal("0")


def test_fixtures_declare_no_measured_performance():
    """Guard against the fixtures being mistaken for qualification evidence."""
    assert FIXTURES["performance_measured"] is False
    assert FIXTURES["capacity_verified"] is False
    assert FIXTURES["qualified_recommendation"] is False
