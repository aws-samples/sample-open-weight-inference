"""Model inspection: what counts as detected, and what must stay unknown.

These tests drive the inspector against recorded metadata shapes rather than the
live API, so they assert the logic rather than Hugging Face's current contents.
The shapes are taken from real responses; `test_model_inspect_live.py` checks that
those shapes still match the API.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from catalog import model_inspect
from catalog.model_inspect import Origin, inspect_hf_model, inspect_model_source

GIB = 1024**3


# --------------------------------------------------------------------------
# Recorded metadata
# --------------------------------------------------------------------------

MISTRAL_INFO = {
    "sha": "c170c708c41dac9275d15a8fff4eca08d52bab71",
    "gated": False,
    "private": False,
    "cardData": {"license": "apache-2.0"},
    "tags": ["license:apache-2.0"],
    "safetensors": {"total": 7248023552, "parameters": {"BF16": 7248023552}},
}

MISTRAL_CONFIG = {
    "architectures": ["MistralForCausalLM"],
    "max_position_embeddings": 32768,
    "torch_dtype": "bfloat16",
    "model_type": "mistral",
}

# The repository ships a sharded set *and* a consolidated duplicate of the same
# tensors. One copy is 13.50 GiB; the listing sums to 27.00 GiB.
SHARD_BYTES = [4_949_000_000, 5_002_000_000, 4_542_000_000]
MISTRAL_TREE = [
    {"path": "config.json", "size": 700},
    {"path": "model.safetensors.index.json", "size": 25_000},
    {"path": "consolidated.safetensors", "lfs": {"size": sum(SHARD_BYTES)}},
    *[
        {"path": f"model-0000{i + 1}-of-00003.safetensors", "lfs": {"size": size}}
        for i, size in enumerate(SHARD_BYTES)
    ],
]

MISTRAL_INDEX = {
    "metadata": {"total_size": sum(SHARD_BYTES)},
    # Many tensors, three distinct shards.
    "weight_map": {
        f"model.layers.{n}.weight": f"model-0000{(n % 3) + 1}-of-00003.safetensors"
        for n in range(30)
    },
}


def fake_transport(responses: dict[str, tuple[int, object]]):
    """Match by URL substring, so tests state intent rather than exact query strings."""

    def _fetch(url: str, token=None):  # noqa: ANN001
        for fragment, result in responses.items():
            if fragment in url:
                return result
        raise AssertionError(f"unexpected request: {url}")

    return _fetch


@pytest.fixture
def mistral(monkeypatch):
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/api/models/mistralai/Mistral-7B-Instruct-v0.3/tree": (200, MISTRAL_TREE),
                "/api/models/mistralai/Mistral-7B-Instruct-v0.3": (200, MISTRAL_INFO),
                "/config.json": (200, MISTRAL_CONFIG),
                "model.safetensors.index.json": (200, MISTRAL_INDEX),
            }
        ),
    )
    return inspect_hf_model("mistralai/Mistral-7B-Instruct-v0.3")


# --------------------------------------------------------------------------
# Detection
# --------------------------------------------------------------------------


def test_detects_the_five_fields_a_novice_was_asked_to_invent(mistral):
    assert mistral.ok
    assert mistral.architecture.value == "MistralForCausalLM"
    assert mistral.context_tokens.value == "32768"
    assert mistral.precision.value == "BF16"
    assert mistral.license_id.value == "apache-2.0"
    # 7_248_023_552 / 1e9, not the "7" a preset carried.
    assert mistral.total_params_b.value == "7.248"


def test_every_detected_value_names_its_source_and_revision(mistral):
    assert mistral.revision == MISTRAL_INFO["sha"]
    for detected in (
        mistral.architecture,
        mistral.context_tokens,
        mistral.total_params_b,
        mistral.weights_gb,
        mistral.license_id,
    ):
        assert detected.origin == Origin.DETECTED
        assert detected.source_url, "a detected value with no source is not evidence"
    # The revision is in the URL of anything read at a pinned commit, so the value
    # cannot be silently re-attributed to a later state of the branch.
    assert MISTRAL_INFO["sha"] in mistral.architecture.source_url


def test_weights_come_from_the_manifest_not_the_file_listing(mistral):
    """The defect this guards: a duplicate copy doubling the weights.

    Summing the listing gives 27.00 GiB because `consolidated.safetensors` holds the
    same tensors as the three shards. An instance sized from that figure is sized
    for roughly twice the memory the model actually needs.
    """
    one_copy = Decimal(sum(SHARD_BYTES)) / Decimal(GIB)
    assert mistral.weights_gb.value == str(one_copy.quantize(Decimal("0.01")))
    assert mistral.weight_files == 3, "the consolidated duplicate must not be counted"
    listing_total = (
        Decimal(sum(SHARD_BYTES) * 2) / Decimal(GIB)
    ).quantize(Decimal("0.01"))
    assert mistral.weights_gb.value != str(listing_total)


def test_lfs_size_is_preferred_over_the_pointer_size(monkeypatch):
    """`size` on an LFS entry is the pointer file, a few hundred bytes."""
    tree = [
        {"path": "model.safetensors", "size": 135, "lfs": {"size": 8 * GIB}},
    ]
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, tree),
                "/api/models/x/y": (200, {"sha": "abc", "safetensors": {"total": 1}}),
                "/config.json": (200, {"architectures": ["X"]}),
            }
        ),
    )
    result = inspect_hf_model("x/y")
    assert result.weights_gb.value == "8.00"


# --------------------------------------------------------------------------
# Honest unknowns
# --------------------------------------------------------------------------


def test_a_gated_repository_keeps_partial_facts_and_names_the_requirement(monkeypatch):
    """Llama's config.json 401s while its listing and parameter count stay readable.

    Discarding the whole inspection because one request failed would throw away
    facts the user can act on, and reporting the gate as "not detected" would hide
    that there is an action available: accept the terms.
    """
    info = {
        "sha": "0e9e39f249a16976918f6564b8830bc894c89659",
        "gated": "manual",
        "cardData": {"license": "llama3.1"},
        "safetensors": {"total": 8030261248},
    }
    tree = [{"path": "model.safetensors", "lfs": {"size": 15 * GIB}}]
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, tree),
                "/api/models/meta-llama/Llama-3.1-8B-Instruct": (200, info),
                "/config.json": (401, "Access to model ... is restricted."),
            }
        ),
    )
    result = inspect_hf_model("meta-llama/Llama-3.1-8B-Instruct")

    assert result.ok
    assert result.access == "GATED"
    assert "manually" in (result.access_detail or "")
    # Readable despite the gate.
    assert result.total_params_b.value == "8.030"
    assert result.weights_gb.value == "15.00"
    assert result.license_id.value == "llama3.1"
    # Hidden by the gate, and said so.
    for blocked in (result.context_tokens, result.precision):
        assert blocked.origin == Origin.NOT_DETECTED
        assert blocked.value is None
        assert "accepted terms" in (blocked.detail or "")
    # Architecture survives: Hugging Face indexes a config summary that stays
    # readable behind the gate. Without this the solver, which requires an
    # architecture, could never evaluate a gated model like Llama.
    assert result.architecture.origin == Origin.NOT_DETECTED


def test_gated_architecture_falls_back_to_the_indexed_config(monkeypatch):
    """config.json is behind the gate, but HF's indexed summary of it is not.

    This is still retrieved metadata, not a guess from the model's name, and it is
    labelled as describing the default branch rather than the pinned revision.
    """
    info = {
        "sha": "abc",
        "gated": "manual",
        "config": {"architectures": ["LlamaForCausalLM"], "model_type": "llama"},
        "safetensors": {"total": 8030261248},
    }
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, []),
                "/api/models/meta-llama/gated": (200, info),
                "/config.json": (401, "restricted"),
            }
        ),
    )
    result = inspect_hf_model("meta-llama/gated")
    assert result.architecture.origin == Origin.DETECTED
    assert result.architecture.value == "LlamaForCausalLM"
    assert "indexed model metadata" in result.architecture.detail
    assert "default" in result.architecture.detail
    # The gate still hides what only the file itself carries.
    assert result.context_tokens.origin == Origin.NOT_DETECTED


def test_absent_parameter_count_is_not_inferred_from_the_name(monkeypatch):
    """"Llama-3.1-8B" must not become 8e9 parameters."""
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, []),
                "/api/models/acme/Some-Model-70B": (200, {"sha": "abc", "tags": []}),
                "/config.json": (200, {"architectures": ["LlamaForCausalLM"]}),
            }
        ),
    )
    result = inspect_hf_model("acme/Some-Model-70B")
    assert result.total_params_b.origin == Origin.NOT_DETECTED
    assert result.total_params_b.value is None
    assert "name" in (result.total_params_b.detail or "")


def test_missing_context_and_licence_stay_unknown(monkeypatch):
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, []),
                "/api/models/acme/bare": (200, {"sha": "abc", "tags": []}),
                # A config with no context field and an unmapped dtype.
                "/config.json": (200, {"architectures": ["A"], "torch_dtype": "float64"}),
            }
        ),
    )
    result = inspect_hf_model("acme/bare")
    assert result.context_tokens.origin == Origin.NOT_DETECTED
    assert result.license_id.origin == Origin.NOT_DETECTED
    # An unrecognised dtype is not silently mapped to BF16.
    assert result.precision.origin == Origin.NOT_DETECTED
    assert result.weights_gb.origin == Origin.NOT_DETECTED


def test_a_shard_named_in_the_manifest_but_absent_refuses_to_total(monkeypatch):
    """An understated total is worse than no total: it under-sizes the instance."""
    index = {"weight_map": {"a": "shard-1.safetensors", "b": "shard-2.safetensors"}}
    tree = [
        {"path": "model.safetensors.index.json", "size": 10},
        {"path": "shard-1.safetensors", "lfs": {"size": 4 * GIB}},
    ]
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, tree),
                "/api/models/acme/partial": (200, {"sha": "abc"}),
                "/config.json": (200, {}),
                "index.json": (200, index),
            }
        ),
    )
    result = inspect_hf_model("acme/partial")
    assert result.weights_gb.origin == Origin.NOT_DETECTED
    assert "absent" in (result.weights_gb.detail or "")


def test_unmanifested_multi_format_repo_reports_its_uncertainty(monkeypatch):
    """No manifest and several files: report the sum, and say it may overstate."""
    tree = [
        {"path": "model.safetensors", "lfs": {"size": 4 * GIB}},
        {"path": "pytorch_model.bin", "lfs": {"size": 4 * GIB}},
    ]
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, tree),
                "/api/models/acme/dual": (200, {"sha": "abc"}),
                "/config.json": (200, {}),
            }
        ),
    )
    result = inspect_hf_model("acme/dual")
    assert result.weights_gb.value == "8.00"
    assert any("overstates" in note for note in result.notes)


def test_known_duplicate_locations_are_excluded_without_a_manifest(monkeypatch):
    tree = [
        {"path": "model.safetensors", "lfs": {"size": 4 * GIB}},
        {"path": "original/consolidated.00.pth", "lfs": {"size": 4 * GIB}},
    ]
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, tree),
                "/api/models/acme/orig": (200, {"sha": "abc"}),
                "/config.json": (200, {}),
            }
        ),
    )
    result = inspect_hf_model("acme/orig")
    assert result.weights_gb.value == "4.00"
    assert result.weight_files == 1


# --------------------------------------------------------------------------
# Input handling and failure
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    ["", "not-a-repo", "http://evil.test/x/y", "owner/name/extra", "../../etc/passwd"],
)
def test_a_malformed_source_is_rejected_before_any_request(bad, monkeypatch):
    def explode(url, token=None):  # noqa: ANN001
        raise AssertionError(f"must not request {url}")

    monkeypatch.setattr(model_inspect, "_fetch", explode)
    result = inspect_hf_model(bad)
    assert not result.ok
    assert "owner/name" in (result.error or "")


def test_a_full_url_is_accepted_as_a_repository(monkeypatch):
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, []),
                "/api/models/acme/model": (200, {"sha": "abc"}),
                "/config.json": (200, {}),
            }
        ),
    )
    result = inspect_hf_model("https://huggingface.co/acme/model")
    assert result.repo == "acme/model"
    assert result.ok


def test_a_missing_repository_says_so(monkeypatch):
    monkeypatch.setattr(
        model_inspect, "_fetch", fake_transport({"/api/models/": (404, "Not Found")})
    )
    result = inspect_hf_model("acme/nope")
    assert not result.ok
    assert "No Hugging Face model repository" in result.error


def test_a_network_failure_is_reported_not_raised(monkeypatch):
    monkeypatch.setattr(
        model_inspect, "_fetch", fake_transport({"/api/models/": (0, "timeout")})
    )
    result = inspect_hf_model("acme/x")
    assert not result.ok
    assert "Could not reach" in result.error


def test_object_storage_sources_are_declared_unsupported_not_faked():
    for source in ("s3://bucket/model/", "oci://registry/repo:tag"):
        result = inspect_model_source(source)
        assert not result.ok
        assert "not implemented yet" in result.error
        assert result.architecture.origin == Origin.NOT_DETECTED


def test_serialisation_keeps_origin_and_provenance(mistral):
    payload = json.loads(json.dumps(mistral.to_json()))
    assert payload["access"] == "PUBLIC"
    assert payload["revision"] == MISTRAL_INFO["sha"]
    arch = payload["fields"]["architecture"]
    assert arch == {
        "origin": "DETECTED",
        "value": "MistralForCausalLM",
        "detail": arch["detail"],
        "sourceUrl": arch["sourceUrl"],
    }
    # A value the interface must render as "Not detected" carries no value at all.
    blocked = json.loads(json.dumps(model_inspect._missing("because").to_json()))
    assert blocked["origin"] == "NOT_DETECTED" and blocked["value"] is None


def test_a_uniform_shard_set_needs_no_caveat(monkeypatch):
    """A gated repository hides its manifest but not its shard names.

    `model-00001-of-00004.safetensors` states how many parts there are, so summing
    the set is not a guess. Warning about double-counting here was noise on the
    commonest gated case.
    """
    tree = [
        {"path": f"model-0000{n}-of-00004.safetensors", "lfs": {"size": 4 * GIB}}
        for n in range(1, 5)
    ]
    tree.append({"path": "original/consolidated.00.pth", "lfs": {"size": 16 * GIB}})
    monkeypatch.setattr(
        model_inspect,
        "_fetch",
        fake_transport(
            {
                "/tree": (200, tree),
                "/api/models/meta-llama/sharded": (200, {"sha": "abc", "gated": "manual"}),
                "/config.json": (401, "restricted"),
            }
        ),
    )
    result = inspect_hf_model("meta-llama/sharded")
    assert result.weights_gb.value == "16.00"
    assert result.weight_files == 4
    assert not any("overstates" in note for note in result.notes)
