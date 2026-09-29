"""Native Strands + DynamoDB protocol tests. No model API or billable resources."""
import asyncio
import copy
import json
import threading

import boto3
import pytest
from moto import mock_aws
from strands.models.model import Model
from strands.session.repository_session_manager import RepositorySessionManager
from strands.types.session import SessionMessage

from agent.advisor import Advisor, TOOL_SPECS
from agent.dynamodb_sessions import (
    ConversationError, ConversationScope, DynamoSessionRepository,
    HISTORY_PAGE_SIZE, LEASE_SECONDS, RecordedTurn,
)
from solver.qualification import calculate_usage
from knowledge.runbooks import find_runbooks, read_runbooks


@pytest.fixture
def storage():
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1",
                              aws_access_key_id="testing", aws_secret_access_key="testing")
        client.create_table(
            TableName="cases",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        now = [1_700_000_000]
        def repository(user="alice", project="customer-a", case="demo"):
            return DynamoSessionRepository(client, "cases", ConversationScope(user, project, case),
                                           clock=lambda: now[0])
        yield repository, now


def test_scope_includes_user_customer_and_case(storage):
    factory, _ = storage
    first = factory()
    first.acquire("turn1", "hash1", "private message")
    manager = RepositorySessionManager(first.scope.session_id, first)
    assert manager.session is not None
    for other in (factory(user="bob"), factory(project="customer-b"), factory(case="other")):
        assert other.history()["turns"] == []
        with pytest.raises(ConversationError, match="restricted"):
            other.read_session(first.scope.session_id)
    with pytest.raises(ConversationError, match="restricted"):
        first.read_agent(first.scope.session_id, "a-model-supplied-agent")


def test_only_one_turn_and_duplicate_does_not_execute(storage):
    factory, _ = storage
    first, other = factory(), factory()
    first.acquire("turn1", "hash1", "hello")
    with pytest.raises(ConversationError) as busy:
        other.acquire("turn2", "hash2", "another")
    assert busy.value.code == "conversation_busy"
    with pytest.raises(ConversationError) as duplicate:
        other.acquire("turn1", "hash1", "hello")
    assert duplicate.value.code == "turn_in_progress"
    first.finish({"reply": "Saved answer", "status": "COMPLETE"}, status="COMPLETE")
    with pytest.raises(RecordedTurn) as receipt:
        other.acquire("turn1", "hash1", "hello")
    assert receipt.value.result["reply"] == "Saved answer"
    with pytest.raises(ConversationError) as conflict:
        other.acquire("turn1", "changed", "different")
    assert conflict.value.code == "turn_conflict"


def test_stalled_worker_cannot_write_or_release_new_workers_lease(storage):
    factory, now = storage
    old = factory()
    old.acquire("turn1", "hash1", "hello")
    RepositorySessionManager(old.scope.session_id, old)
    now[0] += LEASE_SECONDS + 1
    newer = factory()
    newer.acquire("turn2", "hash2", "continue")
    with pytest.raises(ConversationError):
        old.create_message(old.scope.session_id, "advisor",
                           SessionMessage(message={"role": "assistant", "content": [{"text": "stale"}]}, message_id=0))
    with pytest.raises(ConversationError):
        old.finish({"reply": "stale"}, status="COMPLETE")
    assert newer.check_active() is False
    assert newer.history()["turns"][0]["status"] == "INTERRUPTED"


def test_server_expiry_is_enforced_even_while_rows_remain(storage):
    factory, now = storage
    repo = factory()
    repo.acquire("turn1", "hash1", "hello")
    RepositorySessionManager(repo.scope.session_id, repo)
    now[0] = repo.expiry
    for operation in (
        lambda: factory().history(),
        lambda: factory().acquire("turn2", "hash2", "hello"),
        lambda: repo.read_session(repo.scope.session_id),
        lambda: repo.create_message(repo.scope.session_id, "advisor",
                                    SessionMessage(message={"role": "user", "content": [{"text": "late"}]}, message_id=0)),
    ):
        with pytest.raises(ConversationError) as error:
            operation()
        assert error.value.code == "conversation_expired"


def test_stop_is_scoped_and_does_not_release_running_turn(storage):
    factory, _ = storage
    repo = factory()
    repo.acquire("turn1", "hash1", "hello")
    assert factory(user="bob").request_cancel("turn1")["requested"] is False
    assert repo.check_active() is False
    assert factory().request_cancel("turn1")["requested"] is True
    assert repo.check_active() is True
    with pytest.raises(ConversationError):
        factory().acquire("turn2", "hash2", "next")
    repo.finish({"reply": "partial", "status": "CANCELLED"}, status="CANCELLED")
    factory().acquire("turn2", "hash2", "next")


class ScriptedModel(Model):
    """Deterministic provider stream; the real Strands loop/session hooks run."""
    def __init__(self, *, tool_first=False, fail_after_text=False, tool_turns=(), usage=None, answer_stop_reason="end_turn"):
        self.tool_turns = list(tool_turns)
        if tool_first:
            self.tool_turns.insert(0, ("calculate_usage", {
                "users": "7", "requestsPerUserPerDay": "2", "days": "3"}))
        self.fail_after_text = fail_after_text
        self.answer_stop_reason = answer_stop_reason
        self.usage = usage or {"inputTokens": 20, "outputTokens": 10, "totalTokens": 30}
        self.calls = []

    def get_config(self):
        return {"model_id": "unit-test-model"}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError
        yield  # pragma: no cover

    async def stream(self, messages, *args, **kwargs):
        self.calls.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if len(self.calls) <= len(self.tool_turns):
            name, inputs = self.tool_turns[len(self.calls) - 1]
            yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {
                "toolUse": {"toolUseId": f"tool-{len(self.calls)}", "name": name}}}}
            yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {
                "toolUse": {"input": json.dumps(inputs)}}}}
            yield {"contentBlockStop": {"contentBlockIndex": 0}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}}
            for text in ["Your project ", "is remembered. ", "Café."]:
                await asyncio.sleep(0.002)
                yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": text}}}
                if self.fail_after_text:
                    raise RuntimeError("synthetic upstream failure")
            yield {"contentBlockStop": {"contentBlockIndex": 0}}
            yield {"messageStop": {"stopReason": self.answer_stop_reason}}
        yield {"metadata": {"usage": self.usage, "metrics": {"latencyMs": 10}}}


def advisor(model):
    tools = {item["toolSpec"]["name"]: lambda _: {} for item in TOOL_SPECS}
    tools["calculate_usage"] = calculate_usage
    tools["find_runbooks"] = find_runbooks
    tools["read_runbooks"] = read_runbooks
    return Advisor(tools, model=model)


def test_native_tool_results_and_context_restore_after_new_worker(storage):
    factory, _ = storage
    first = factory()
    first.acquire("turn1", "hash1", "Use seven people for the trial")
    model = ScriptedModel(tool_first=True)
    events = []
    result = advisor(model).converse("Use seven people for the trial", "{}", first,
                                    lambda name, data: events.append((name, data)), threading.Event())
    assert result["status"] == "COMPLETE", result
    assert len([event for event in events if event[0] == "answer_delta"]) == 3
    assert result["reply"] == "Your project is remembered. Café."
    messages = first.list_messages(first.scope.session_id, "advisor")
    assert any("toolUse" in block for message in messages for block in message.message["content"])
    assert any("toolResult" in block for message in messages for block in message.message["content"])
    first.finish(result, status="COMPLETE")

    # No agent, model, repository instance or browser history is reused.
    restored = factory()
    restored.acquire("turn2", "hash2", "What was the group size?")
    next_model = ScriptedModel()
    followup = advisor(next_model).converse("What was the group size?", "{}", restored,
                                            lambda *_: None, threading.Event())
    assert followup["status"] == "COMPLETE"
    assert any("seven people" in block.get("text", "") for m in next_model.calls[0] for block in m["content"])
    assert any("toolResult" in block for m in next_model.calls[0] for block in m["content"])
    assert next_model.calls[0][-1]["content"][0]["text"] == "What was the group size?"
    restored.finish(followup, status="COMPLETE")


def test_native_failure_keeps_partial_answer_and_never_retries_model(storage):
    factory, _ = storage
    repo = factory()
    repo.acquire("turn1", "hash1", "hello")
    model = ScriptedModel(fail_after_text=True)
    result = advisor(model).converse("hello", "{}", repo, lambda *_: None, threading.Event())
    assert result["status"] == "FAILED"
    assert result["reply"] == "Your project "
    assert len(model.calls) == 1
    repo.finish(result, status="FAILED")
    assert factory().history()["turns"][0]["reply"] == "Your project "


def test_native_stop_preserves_visible_text_without_another_provider_call(storage):
    factory, _ = storage
    repo = factory()
    repo.acquire("turn1", "hash1", "hello")
    model = ScriptedModel()
    cancel = threading.Event()
    deltas = []

    def emit(name, data):
        if name == "answer_delta":
            deltas.append(data["delta"])
            cancel.set()

    result = advisor(model).converse("hello", "{}", repo, emit, cancel)
    assert result["status"] == "CANCELLED"
    assert result["reply"] == "".join(deltas) == "Your project "
    assert len(model.calls) == 1
    repo.finish(result, status="CANCELLED")
    assert factory().history()["turns"][0]["status"] == "CANCELLED"


def test_display_history_is_paged_and_ordered_even_with_same_second_turns(storage):
    factory, _ = storage
    for index in range(HISTORY_PAGE_SIZE + 2):
        repo = factory()
        repo.acquire(f"turn{index}", f"hash{index}", f"Question {index}")
        repo.finish({"reply": f"Answer {index}", "status": "COMPLETE"}, status="COMPLETE")
    latest = factory().history()
    assert len(latest["turns"]) == HISTORY_PAGE_SIZE
    assert latest["turns"][0]["prompt"] == "Question 2"
    assert latest["turns"][-1]["prompt"] == f"Question {HISTORY_PAGE_SIZE + 1}"
    earlier = factory().history(latest["nextBeforeSequence"])
    assert [turn["prompt"] for turn in earlier["turns"]] == ["Question 0", "Question 1"]
    assert earlier["nextBeforeSequence"] is None
    assert factory(user="bob").history(latest["nextBeforeSequence"])["turns"] == []
    with pytest.raises(ConversationError):
        factory().history(-1)


def test_native_sliding_window_bounds_context_without_deleting_archive(storage):
    factory, _ = storage
    last_model = None
    for index in range(19):
        repo = factory()
        repo.acquire(f"turn{index}", f"hash{index}", f"Question {index}")
        model = ScriptedModel()
        result = advisor(model).converse(f"Question {index}", "{}", repo, lambda *_: None, threading.Event())
        assert result["status"] == "COMPLETE"
        repo.finish(result, status="COMPLETE")
        last_model = model
    assert len(last_model.calls[0]) <= 33  # 32 retained messages + current prompt.
    # The window trims model context, not the durable transcript.
    archive = repo.list_messages(repo.scope.session_id, "advisor")
    assert len(archive) == 38
    state = repo.read_agent(repo.scope.session_id, "advisor")
    assert state.conversation_manager_state["removed_message_count"] > 0


def test_runbook_search_read_and_citations_survive_native_session_restore(storage):
    factory, _ = storage
    repo = factory()
    repo.acquire("guidance1", "guidance-hash1", "Can this offline podcast run on CPU?")
    model = ScriptedModel(tool_turns=[
        ("find_runbooks", {"query": "Qwen3-TTS offline CPU podcast", "limit": 2}),
        ("read_runbooks", {"ids": ["route-cpu-batch", "evaluate-speech-generation"]}),
    ])
    events = []
    result = advisor(model).converse("Can this offline podcast run on CPU?", "{}", repo,
                                    lambda name, data: events.append((name, data)), threading.Event())
    assert result["status"] == "COMPLETE", result
    assert len(model.calls) == 3
    assert [item["name"] for item in result["toolCalls"]] == ["find_runbooks", "read_runbooks"]
    assert result["casePatch"] == {}
    assert any(name == "answer_delta" for name, _ in events)
    assert all("citations" not in data for name, data in events if name == "progress")
    repo.finish(result, status="COMPLETE")

    restored = factory()
    restored.acquire("guidance2", "guidance-hash2", "Does that prove real-time performance?")
    followup_model = ScriptedModel()
    followup = advisor(followup_model).converse("Does that prove real-time performance?", "{}", restored,
                                               lambda *_: None, threading.Event())
    assert followup["status"] == "COMPLETE"
    tool_results = [block["toolResult"] for message in followup_model.calls[0]
                    for block in message["content"] if "toolResult" in block]
    payloads = [content["json"] for result in tool_results
                for content in result["content"] if "json" in content]
    retained = next(value for value in payloads if "runbooks" in value)
    assert retained["trust"] == "guidance" and retained["affectsPlacement"] is False
    assert retained["citations"]
    assert "one observed short run" in retained["runbooks"][1]["content"]
    assert factory(user="bob").history()["turns"] == []
    restored.finish(followup, status="COMPLETE")


def test_guidance_followups_allow_answer_after_large_tool_context(storage):
    """Regression: live guide reads exhausted the old 48k cap before any prose.

    Provider usage includes repeated history on each pass, not just new tokens.
    The real Strands loop and session restoration must still reach the answer,
    trim context between calls, and keep the complete durable tool transcript.
    """
    factory, _ = storage
    models = []
    for index in range(3):
        repo = factory()
        prompt = f"Guidance question {index} about this offline podcast"
        repo.acquire(f"guidance{index}", f"guidance-hash{index}", prompt)
        model = ScriptedModel(tool_turns=[
            ("find_runbooks", {"query": "offline CPU podcast", "limit": 2}),
            ("find_runbooks", {"query": "CPU memory sizing", "limit": 2}),
            ("read_runbooks", {"ids": ["size-cpu-inference", "route-cpu-batch", "model-traffic-shape"]}),
        ], usage={"inputTokens": 20_000, "outputTokens": 100, "totalTokens": 20_100})
        result = advisor(model).converse(prompt, "{}", repo, lambda *_: None, threading.Event())
        assert result["status"] == "COMPLETE", result
        assert result["reply"] == "Your project is remembered. Café."
        assert len(model.calls) == 4
        assert result["usage"]["totalTokens"] == 80_400
        repo.finish(result, status="COMPLETE")
        models.append(model)
    assert all(len(messages) <= 16 for model in models for messages in model.calls)
    assert len(repo.list_messages(repo.scope.session_id, "advisor")) == 24
    assert repo.read_agent(repo.scope.session_id, "advisor").conversation_manager_state["removed_message_count"] > 0
    assert len(factory().history()["turns"]) == 3
    assert any("toolResult" in block for message in models[-1].calls[-1] for block in message["content"])


def test_processing_limit_is_explained_and_never_restarts_the_turn(storage):
    factory, _ = storage
    repo = factory()
    repo.acquire("too-large", "large-hash", "Explain this unusually large context")
    model = ScriptedModel(tool_first=True,
                          usage={"inputTokens": 150_000, "outputTokens": 100, "totalTokens": 150_100})
    result = advisor(model).converse("Explain this unusually large context", "{}", repo,
                                    lambda *_: None, threading.Event())
    assert result["status"] == "FAILED"
    assert result["reply"] == ""
    assert "processing limit" in result["detail"]
    assert len(model.calls) == 1
    assert len(result["toolCalls"]) == 1
    repo.finish(result, status="FAILED")
    with pytest.raises(RecordedTurn):
        factory().acquire("too-large", "large-hash", "Explain this unusually large context")


def test_native_answer_length_limit_preserves_text_without_restarting(storage):
    factory, _ = storage
    repo = factory()
    repo.acquire("length-limit", "length-hash", "Explain a long procedure")
    model = ScriptedModel(answer_stop_reason="max_tokens")
    result = advisor(model).converse("Explain a long procedure", "{}", repo,
                                    lambda *_: None, threading.Event())
    assert result["status"] == "FAILED"
    assert result["reply"] == "Your project is remembered. Café."
    assert "length limit" in result["detail"]
    assert len(model.calls) == 1
    repo.finish(result, status="FAILED")
    assert factory().history()["turns"][0]["reply"] == result["reply"]


def test_documentation_receipts_restore_with_owner_history_only(storage):
    factory, _ = storage
    repo = factory()
    repo.acquire("docs-turn", "hash", "Check an AWS service")
    receipt = {"provider": "AWS Knowledge MCP", "affectsPlacement": False, "checks": [{
        "topic": "bedrock-import", "label": "Bedrock Custom Model Import",
        "state": "RETRIEVED", "retrievedAt": "2026-09-29T00:00:00+00:00",
        "sources": [{"id": "aws-doc-example", "title": "AWS documentation",
                     "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html"}],
    }]}
    repo.finish({"reply": "A sourced answer", "awsDocumentation": receipt}, status="COMPLETE")
    history = factory().history()
    assert history["turns"][0]["awsDocumentation"] == receipt
    assert factory(user="bob").history()["turns"] == []
    assert factory(project="customer-b").history()["turns"] == []
    assert "excerpt" not in json.dumps(history)
    assert "search_phrase" not in json.dumps(history)


def test_native_session_keeps_documentation_tool_results_for_followups(storage):
    factory, _ = storage
    repo = factory()
    repo.acquire("docs-turn", "hash", "Does this AWS option support my workload?")
    model = ScriptedModel(tool_turns=[("lookup_aws_documentation", {"topics": ["bedrock-import"]})])
    instance = advisor(model)
    instance.tools["lookup_aws_documentation"] = lambda _: {
        "state": "UNVERIFIED", "affectsPlacement": False,
        "error": "Current documentation is unavailable. Keep service support unverified.",
    }
    result = instance.converse("Check AWS support", "{}", repo, lambda *_: None, threading.Event())
    assert result["status"] == "COMPLETE"
    assert result["toolCalls"] == [{"name": "lookup_aws_documentation", "input": {}, "status": "error"}]
    messages = repo.list_messages(repo.scope.session_id, "advisor")
    assert any("UNVERIFIED" in json.dumps(message.message) for message in messages)
    repo.finish(result, status="COMPLETE")
    resumed = factory()
    resumed.acquire("docs-followup", "hash2", "Keep that check unverified")
    followup = ScriptedModel()
    advisor(followup).converse("Keep that check unverified", "{}", resumed, lambda *_: None, threading.Event())
    assert "UNVERIFIED" in json.dumps(followup.calls[0])
    assert len(followup.calls) == 1  # A broken read never replays a completed turn.
