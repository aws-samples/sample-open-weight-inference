"""How many Custom Model Units a copy needs, and how honest the number is.

Cost is linear in this figure, so a constant made every large-model quote wrong: EDDIE
hardcoded 2 for every imported model, which AWS documents as correct for a Llama 3.1 8B
at 128K and a 4x understatement for a 70B, which needs 8.

The number is not computable. AWS states that it depends on architecture, parameter count
and context length, and that Bedrock decides it at import; the real value is then readable
from GetImportedModel. So the goal is not accuracy it cannot have -- it is that an
estimate is never mistaken for a quote.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from catalog.cmu import ASSUMED, DOCUMENTED, MEASURED, estimate_cmus


def test_a_measured_value_wins_over_everything():
    """Once imported, AWS has told us the answer; nothing else is considered."""
    estimate = estimate_cmus(
        architecture="LlamaForCausalLM",
        total_params_b=Decimal("70"),
        context_tokens=128_000,
        measured_units=5,
    )
    assert estimate.units == Decimal("5")
    assert estimate.provenance == MEASURED
    assert estimate.verified
    assert estimate.assumption == ""


def test_the_documented_llama_8b_example():
    estimate = estimate_cmus(
        architecture="LlamaForCausalLM",
        total_params_b=Decimal("8"),
        context_tokens=128_000,
    )
    assert estimate.units == Decimal("2")
    assert estimate.provenance == DOCUMENTED
    assert not estimate.verified


def test_the_documented_llama_70b_example_is_not_two():
    """The defect, stated as a test: a 70B needs 8 units, not 2."""
    estimate = estimate_cmus(
        architecture="LlamaForCausalLM",
        total_params_b=Decimal("70"),
        context_tokens=128_000,
    )
    assert estimate.units == Decimal("8")
    assert estimate.provenance == DOCUMENTED


def test_an_undocumented_model_is_assumed_and_says_so():
    """Qwen 7B is not one of AWS's published examples."""
    estimate = estimate_cmus(
        architecture="Qwen2ForCausalLM",
        total_params_b=Decimal("7.616"),
        context_tokens=32_768,
    )
    assert estimate.provenance == ASSUMED
    assert not estimate.verified
    assert estimate.assumption, "an assumed figure must carry text the UI can show"
    assert "Amazon Bedrock decides the real number" in estimate.assumption
    # 7.6B is at or below the 8B anchor, so the small anchor applies.
    assert estimate.units == Decimal("2")


def test_a_mid_sized_model_states_its_range():
    """Between the two anchors, the uncertainty is real and is shown."""
    estimate = estimate_cmus(
        architecture="Qwen2ForCausalLM",
        total_params_b=Decimal("32"),
        context_tokens=32_768,
    )
    assert estimate.provenance == ASSUMED
    assert estimate.upper_bound == Decimal("8")
    assert "as high as 8" in estimate.assumption


def test_a_very_large_model_uses_the_upper_anchor():
    estimate = estimate_cmus(
        architecture="Qwen2ForCausalLM",
        total_params_b=Decimal("235"),
        context_tokens=32_768,
    )
    assert estimate.units == Decimal("8")
    assert estimate.provenance == ASSUMED


def test_an_unknown_parameter_count_is_flagged_not_silently_defaulted():
    estimate = estimate_cmus(
        architecture="Qwen2ForCausalLM", total_params_b=None, context_tokens=None
    )
    assert estimate.provenance == ASSUMED
    assert "has not been established" in estimate.assumption
    assert "Inspect the model" in estimate.assumption


def test_no_undocumented_example_is_recorded_as_documented():
    """Guards the table itself.

    A plausible guess added to DOCUMENTED_CMUS would become indistinguishable from a
    figure AWS published, which is the one thing this module exists to prevent.
    """
    from catalog.cmu import DOCUMENTED_CMUS

    assert set(DOCUMENTED_CMUS) == {
        ("Llama", 8, 128_000),
        ("Llama", 70, 128_000),
    }


def test_serialisation_carries_the_provenance_to_the_interface():
    payload = estimate_cmus(
        architecture="Qwen2ForCausalLM",
        total_params_b=Decimal("7.616"),
        context_tokens=32_768,
    ).to_json()
    assert payload["provenance"] == ASSUMED
    assert payload["verified"] is False
    assert payload["assumption"]
    assert payload["basis"]


def test_the_candidate_uses_the_estimate_rather_than_a_constant():
    """End to end through candidate enumeration, which is what the cost reads."""
    from catalog.candidates import enumerate_candidates
    from solver.models import Modality, ModelSpec, PlacementRequest, WorkloadSpec

    def candidates_for(params: str, context: int):
        request = PlacementRequest(
            model=ModelSpec(
                name="m",
                architecture="LlamaForCausalLM",
                modality=Modality.TEXT,
                total_params_b=Decimal(params),
                context_tokens=context,
                weights_gb=Decimal("16"),
            ),
            workload=WorkloadSpec(
                horizon_hours=Decimal("720"), billable_copy_hours=Decimal("720")
            ),
        )
        return {
            c.candidate_id: c
            for c in enumerate_candidates(request)
            if c.candidate_id.startswith("cmi-")
        }

    small = candidates_for("8", 128_000)
    large = candidates_for("70", 128_000)
    assert small["cmi-scale-to-zero"].cmus_per_copy == Decimal("2")
    # The whole point: this used to be 2 as well, understating the cost fourfold.
    assert large["cmi-scale-to-zero"].cmus_per_copy == Decimal("8")
    assert large["cmi-prewarmed"].cmus_per_copy == Decimal("8")


def test_an_assumed_figure_reaches_the_candidate_notes():
    """The assumption has to be visible where the cost is read, not only in a log."""
    from catalog.candidates import enumerate_candidates
    from solver.models import Modality, ModelSpec, PlacementRequest, WorkloadSpec

    request = PlacementRequest(
        model=ModelSpec(
            name="Qwen2.5 7B Instruct",
            architecture="Qwen2ForCausalLM",
            modality=Modality.TEXT,
            total_params_b=Decimal("7.616"),
            context_tokens=32_768,
            weights_gb=Decimal("15"),
        ),
        workload=WorkloadSpec(
            horizon_hours=Decimal("720"), billable_copy_hours=Decimal("720")
        ),
    )
    cmi = [
        c for c in enumerate_candidates(request) if c.candidate_id.startswith("cmi-")
    ]
    assert cmi, "Qwen2ForCausalLM is import-eligible"
    for candidate in cmi:
        assert "Custom Model Units" in candidate.notes
        assert "decides the real number" in candidate.notes
