"""The recorded metadata shapes in test_model_inspect.py still match Hugging Face.

The unit tests assert the inspector's logic against recorded responses. That is the
right way round -- they must not fail because a model card changed -- but it leaves
one risk: if Hugging Face moves a field, every unit test still passes while the
deployed inspector detects nothing.

This contract test hits the live API and asserts only the things that would break
the inspector: that the fields exist and are the right shape. It deliberately does
not assert specific values, which the provider is free to change.

Skipped when the network is unavailable, so it never breaks an offline build.
"""

from __future__ import annotations

import pytest

from catalog.model_inspect import Origin, inspect_hf_model

# Apache-2.0, public, sharded with a manifest, and a `consolidated` duplicate: it
# exercises every branch that matters.
PUBLIC_REPO = "mistralai/Mistral-7B-Instruct-v0.3"
# Gated with manual review, so config.json 401s while the listing stays readable.
GATED_REPO = "meta-llama/Llama-3.1-8B-Instruct"


def _require_network(result) -> None:  # noqa: ANN001
    if not result.ok and result.error and "Could not reach" in result.error:
        pytest.skip(f"Hugging Face unreachable: {result.error}")


@pytest.mark.live
def test_public_repository_detects_every_field():
    result = inspect_hf_model(PUBLIC_REPO)
    _require_network(result)

    assert result.ok, result.error
    assert result.access == "PUBLIC"
    assert result.revision and len(result.revision) == 40, "expected a resolved commit"

    for name in ("architecture", "total_params_b", "context_tokens", "weights_gb",
                 "precision", "license_id"):
        detected = getattr(result, name)
        assert detected.origin == Origin.DETECTED, f"{name}: {detected.detail}"
        assert detected.value and detected.source_url

    # Shapes, not values: a parameter count in billions and a plausible weight size.
    assert 1 < float(result.total_params_b.value) < 2000
    assert 0.1 < float(result.weights_gb.value) < 5000
    assert int(result.context_tokens.value) >= 512
    assert result.architecture.value.isidentifier()


@pytest.mark.live
def test_manifest_total_is_not_the_doubled_listing_total():
    """The duplicate-copy defect, checked against the real repository.

    This repo publishes a sharded set and a `consolidated.safetensors` holding the
    same tensors. The weights must reflect one copy: at the time of writing 13.50
    GiB rather than the 27.00 GiB the file listing sums to. Asserted as a ratio so
    the test survives the provider re-quantising or re-sharding.
    """
    result = inspect_hf_model(PUBLIC_REPO)
    _require_network(result)

    params_b = float(result.total_params_b.value)
    weights_gib = float(result.weights_gb.value)
    # Two bytes per parameter at BF16; 1 GiB = 1.074e9 bytes.
    expected = params_b * 2 / 1.0737
    ratio = weights_gib / expected
    assert 0.85 < ratio < 1.35, (
        f"{weights_gib} GiB for {params_b}B parameters is {ratio:.2f}x the "
        f"~{expected:.1f} GiB one BF16 copy should occupy; a second copy is "
        f"probably being counted"
    )


@pytest.mark.live
def test_gated_repository_reports_the_acceptance_requirement():
    result = inspect_hf_model(GATED_REPO)
    _require_network(result)

    assert result.ok, result.error
    assert result.access == "GATED", (
        "this repository is expected to require accepted terms; if the provider "
        "un-gated it, pick another gated repository rather than deleting this test"
    )
    assert result.access_detail
    # Readable without credentials.
    assert result.total_params_b.origin == Origin.DETECTED
    assert result.weights_gb.origin == Origin.DETECTED
    # Architecture survives the gate via Hugging Face's indexed config summary, so
    # a gated model stays evaluatable by a solver that requires one. It is retrieved
    # metadata, and labelled as describing the default branch.
    assert result.architecture.origin == Origin.DETECTED
    assert result.architecture.value == "LlamaForCausalLM"
    assert "indexed model metadata" in result.architecture.detail

    # What only the file itself carries is still behind the gate, and explained
    # rather than guessed.
    assert result.context_tokens.origin == Origin.NOT_DETECTED
    assert result.context_tokens.value is None
    assert "credentials" in (result.context_tokens.detail or "")


@pytest.mark.live
def test_a_nonexistent_repository_names_both_possible_causes():
    """Hugging Face answers 401, not 404, for a name that does not exist.

    It will not confirm whether a private repository exists, so the two cases are
    indistinguishable. Reporting only "access restricted" sent someone who mistyped
    a repository name looking for permissions they did not need, so the message has
    to name both causes and suggest checking the spelling.
    """
    result = inspect_hf_model("eddie-test/definitely-not-a-real-model-xyzzy")
    _require_network(result)
    assert not result.ok
    assert "no repository with that name" in result.error
    assert "spelling" in result.error
    assert "private" in result.error
