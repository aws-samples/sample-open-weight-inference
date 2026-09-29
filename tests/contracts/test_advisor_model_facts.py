"""The advisor cannot record model properties it merely remembers.

Architecture, parameter count, context length, weights size, precision and licence
are properties of the model, published by its source. Before inspection existed the
system prompt told the advisor to infer them from the model's name -- so a DeepSeek-R1
distill got `LlamaForCausalLM` or `Qwen2ForCausalLM` on a coin flip, and a recalled
weights size silently changed which instances looked feasible.

The guarantee is now structural rather than a prompt instruction: the coordinator's
allowlist refuses those fields, and the tool schema does not offer them. These tests
bind the two together, because a schema that advertises a field the coordinator drops
produces a silent no-op, and an allowlist that re-admits one restores the defect.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from agent.advisor import SYSTEM_PROMPT, TOOL_SPECS

BACKEND = Path(__file__).resolve().parents[2] / "backend"

INSPECTION_ONLY = {"totalParamsB", "contextTokens", "weightsGb", "licenseId", "precision"}


def _tool(name: str) -> dict:
    for spec in TOOL_SPECS:
        if spec["toolSpec"]["name"] == name:
            return spec["toolSpec"]
    raise AssertionError(f"no tool named {name}; tools are not optional to this contract")


def _frozenset_literal(source: str, name: str) -> set[str]:
    """Read a module-level `name = frozenset({...})` without importing the module.

    runtime/app.py constructs boto3 clients and a FastAPI app at import time, so it
    is parsed rather than imported.
    """
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if name not in targets:
            continue
        call = node.value
        assert isinstance(call, ast.Call), f"{name} is not a frozenset(...) call"
        return {
            element.value
            for element in ast.walk(call)
            if isinstance(element, ast.Constant) and isinstance(element.value, str)
        }
    raise AssertionError(f"{name} not found in the coordinator")


@pytest.fixture(scope="module")
def app_source() -> str:
    return (BACKEND / "runtime" / "app.py").read_text()


def test_the_allowlist_refuses_every_inspection_only_field(app_source):
    writable = _frozenset_literal(app_source, "ADVISOR_WRITABLE_FIELDS")
    leaked = INSPECTION_ONLY & writable
    assert not leaked, (
        f"{sorted(leaked)} are writable by the advisor again. A recalled parameter "
        f"count or weights size would be recorded as an established fact."
    )


def test_the_two_declarations_agree(app_source):
    declared = _frozenset_literal(app_source, "ADVISOR_FIELDS_REQUIRING_INSPECTION")
    assert declared == INSPECTION_ONLY, (
        "the coordinator's inspection-only set has drifted from this contract"
    )


def test_the_patch_schema_does_not_offer_what_the_coordinator_drops():
    """A schema field the coordinator refuses is a silent no-op for the model."""
    properties = set(_tool("propose_case_patch")["inputSchema"]["json"]["properties"])
    offered = INSPECTION_ONLY & properties
    assert not offered, (
        f"propose_case_patch advertises {sorted(offered)}, which the coordinator "
        f"refuses. The advisor would believe it recorded a value that was dropped."
    )


def test_the_patch_schema_still_carries_workload_fields():
    """Guard against over-correcting: the advisor must still record the workload."""
    properties = set(_tool("propose_case_patch")["inputSchema"]["json"]["properties"])
    for required in ("horizonHours", "billableCopyHours", "architecture", "hfRepo"):
        assert required in properties, f"{required} must stay writable by the advisor"


def test_an_inspection_tool_exists_and_takes_a_source():
    spec = _tool("inspect_model")
    schema = spec["inputSchema"]["json"]
    assert "source" in schema["properties"]
    assert schema.get("required") == ["source"], (
        "inspecting nothing in particular is not a meaningful call"
    )
    # The description must state the boundary that makes this safe to run on an
    # arbitrary user-supplied repository.
    assert "does not execute" in spec["description"]


def test_the_tool_is_registered_in_the_coordinator(app_source):
    assert '"inspect_model": tool_inspect_model' in app_source, (
        "the tool is advertised to the model but not implemented, so every call fails"
    )
    assert '"inspect_model": action_inspect_model' in app_source, (
        "the Model details panel needs the action to inspect without a chat turn"
    )


def test_the_prompt_forbids_recalling_model_properties():
    assert "NEVER state a model's architecture" in SYSTEM_PROMPT
    # The old instruction, which is the defect this replaced.
    assert "Infer the architecture class yourself" not in SYSTEM_PROMPT
    assert "inspect_model" in SYSTEM_PROMPT


def test_the_prompt_requires_plain_language():
    """The non-expert contract: no unexplained CMI in the primary flow."""
    assert "import your model into Amazon Bedrock" in SYSTEM_PROMPT
    assert "Expand an acronym the first time" in SYSTEM_PROMPT


def test_evaluation_inspects_first_when_a_repository_is_known(app_source):
    """Ordering is enforced in code, not requested in the prompt.

    Evaluating before inspecting produced a decision computed without the architecture,
    weights size and context length -- which inspection then wrote, immediately marking
    the user's fresh recommendation "out of date" and listing those exact fields as
    having changed. A prompt rule cannot prevent that reliably; this does.
    """
    assert "if repo and not case.get(\"modelInspection\"):" in app_source
    assert "inspected = tool_inspect_model({\"source\": repo})" in app_source


def test_the_prompt_bounds_how_many_questions_are_asked():
    """The interrogation complaint: five numbered questions with sub-bullets, twice."""
    assert "Ask AT MOST TWO questions in a turn" in SYSTEM_PROMPT
    assert "NEVER re-ask something already answered" in SYSTEM_PROMPT
    assert "Prefer acting over asking" in SYSTEM_PROMPT


def test_no_static_follow_up_suggestions_are_returned():
    """A fixed list cannot be a follow-up.

    Five hardcoded examples were returned on every turn, so a conversation about an
    always-on Qwen 0.5B service was offered "Where should I host Llama 3.1 8B?" and
    "We want ElevenLabs voices" as its follow-ups.
    """
    from agent.advisor import SUGGESTED_PROMPTS

    assert SUGGESTED_PROMPTS == []
