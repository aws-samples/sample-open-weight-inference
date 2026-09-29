"""HTTP authorization, request bounds and incremental delivery contracts."""
import asyncio
import json
import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from runtime import app as runtime
from runtime.principal import Authenticator, Principal, capabilities_for


@pytest.fixture
def authenticated_runtime(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="local-test", alg="RS256", use="sig")
    verifier = Authenticator(user_pool_id="us-east-1_TESTPOOL",
                             allowed_client_ids=("local-test-client",), region="us-east-1")

    class Keys:
        def key_for(self, kid, allow_refresh=True):
            return public

    verifier._jwks = Keys()
    monkeypatch.setattr(runtime, "authenticator", verifier)

    def headers(subject="alice", groups=("eddie-users",)):
        # Ephemeral test signature, never an application credential or auth bypass.
        token = jwt.encode({
            "sub": subject, "username": subject, "token_use": "access",
            "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL",
            "client_id": "local-test-client", "cognito:groups": list(groups),
            "exp": int(time.time()) + 60, "iat": int(time.time()),
        }, key, algorithm="RS256", headers={"kid": "local-test"})
        return {"Authorization": f"Bearer {token}"}

    with TestClient(runtime.app) as client:
        yield client, headers


def test_unauthenticated_stream_never_dispatches_or_starts_sse(authenticated_runtime, monkeypatch):
    client, _ = authenticated_runtime
    called = []

    async def handler(*args):
        called.append(args)
        return {}

    monkeypatch.setitem(runtime.ACTIONS, "chat", handler)
    response = client.post("/invocations", json={"action": "chat", "stream": True, "payload": {}})
    assert response.json()["ok"] is False
    assert "text/event-stream" not in response.headers["content-type"]
    assert called == []


def test_reader_cannot_chat_and_guessed_customer_is_refused(authenticated_runtime, monkeypatch):
    client, headers = authenticated_runtime
    called = []

    async def handler(*args):
        called.append(args)
        return {}

    monkeypatch.setitem(runtime.ACTIONS, "chat", handler)
    response = client.post("/invocations", headers=headers(groups=("eddie-readers",)),
                           json={"action": "chat", "payload": {}})
    assert response.json()["ok"] is False
    for project in ("customer-other", "user:bob", "missing"):
        response = client.post("/invocations", headers=headers(),
                               json={"action": "chat", "payload": {"projectId": project}})
        assert response.json()["error"] == "project_forbidden"
    assert called == []


def test_removal_requires_authentication_write_access_and_the_correct_project(authenticated_runtime, monkeypatch):
    client, headers = authenticated_runtime
    calls = []

    async def handler(payload, context):
        calls.append((payload, context))
        return {"caseId": payload["caseId"], "removed": True}

    monkeypatch.setitem(runtime.ACTIONS, "case.remove", handler)
    payload = {"caseId": "demo", "expectedRevision": "revision-1"}
    for auth, inputs in (
        ({}, payload),
        (headers(groups=("eddie-readers",)), payload),
        (headers(), {**payload, "projectId": "user:bob"}),
    ):
        response = client.post("/invocations", headers=auth,
                               json={"action": "case.remove", "payload": inputs})
        assert response.json()["ok"] is False
    assert calls == []
    response = client.post("/invocations", headers=headers(),
                           json={"action": "case.remove", "payload": {**payload, "subject": "bob"}})
    assert response.json()["ok"] is True
    inputs, context = calls[0]
    assert context.principal.subject == "alice"
    assert context.project_id == "user:alice"
    assert "subject" not in inputs


@pytest.mark.parametrize("body", [
    [], {"action": "chat", "payload": []}, {"action": ["chat"]},
    {"action": "chat", "stream": "false"},
    {"action": "chat", "payload": {"assumeChecksCleared": "false"}},
])
def test_invalid_request_shapes_never_run_the_model(authenticated_runtime, monkeypatch, body):
    client, headers = authenticated_runtime
    called = []

    async def handler(*args):
        called.append(args)
        return {}

    monkeypatch.setitem(runtime.ACTIONS, "chat", handler)
    response = client.post("/invocations", headers=headers(), json=body)
    assert response.json()["ok"] is False
    assert called == []


def test_upload_limit_is_enforced_before_parsing_or_dispatch(authenticated_runtime):
    client, headers = authenticated_runtime
    response = client.post("/invocations", headers=headers(), content=b" " * (5 * 1024 * 1024 + 1))
    assert response.json()["error"] == "request_too_large"


def test_payload_cannot_replace_verified_identity(authenticated_runtime, monkeypatch):
    client, headers = authenticated_runtime
    observed = []

    async def handler(payload, context):
        observed.append((payload, context))
        return {"turns": [], "activeTurnId": None, "expiresAt": None}

    monkeypatch.setitem(runtime.ACTIONS, "chat.history", handler)
    response = client.post("/invocations", headers=headers(),
                           json={"action": "chat.history", "payload": {
                               "caseId": "demo", "subject": "bob", "capabilities": ["OPERATE"],
                           }})
    assert response.json()["ok"] is True
    payload, context = observed[0]
    assert context.principal.subject == "alice"
    assert context.project_id == "user:alice"
    assert "subject" not in payload and "capabilities" not in payload


def test_text_is_delivered_before_handler_completion(monkeypatch):
    async def scenario():
        release = asyncio.Event()
        completed = False

        async def handler(payload, context):
            nonlocal completed
            transport = runtime.chat_transport.get()
            transport.emit("answer_delta", {"delta": "First ", "sequence": 1})
            await release.wait()
            transport.emit("answer_delta", {"delta": "second.", "sequence": 2})
            completed = True
            return {"reply": "First second.", "status": "COMPLETE"}

        monkeypatch.setitem(runtime.ACTIONS, "chat", handler)
        principal = Principal(subject="alice", username="alice",
                              capabilities=capabilities_for(("eddie-users",)))
        context = runtime.ActionContext(principal=principal, project_id="user:alice")
        await runtime.busy.enter()
        stream = runtime._stream_action("chat", {}, time.perf_counter(), context)
        assert "event: start" in await anext(stream)
        first = await asyncio.wait_for(anext(stream), timeout=1)
        assert "event: answer_delta" in first and "First " in first
        assert completed is False
        assert runtime.busy.busy
        release.set()
        remaining = [frame async for frame in stream]
        names = [frame.splitlines()[0] for frame in remaining]
        assert names == ["event: answer_delta", "event: complete", "event: end"]
        assert runtime.busy.busy is False

    asyncio.run(scenario())


def test_disconnect_requests_stop_and_retains_busy_until_worker_finishes(monkeypatch):
    async def scenario():
        admitted = asyncio.Event()
        release = asyncio.Event()
        transport = None

        async def handler(payload, context):
            nonlocal transport
            transport = runtime.chat_transport.get()
            admitted.set()
            await release.wait()
            return {"status": "CANCELLED", "reply": ""}

        monkeypatch.setitem(runtime.ACTIONS, "chat", handler)
        principal = Principal(subject="alice", username="alice",
                              capabilities=capabilities_for(("eddie-users",)))
        context = runtime.ActionContext(principal=principal, project_id="user:alice")
        await runtime.busy.enter()
        stream = runtime._stream_action("chat", {}, time.perf_counter(), context)
        await anext(stream)
        await admitted.wait()
        await stream.aclose()
        assert transport.cancelled.is_set()
        assert runtime.busy.busy
        release.set()
        for _ in range(20):
            if not runtime.busy.busy:
                break
            await asyncio.sleep(0)
        assert not runtime.busy.busy

    asyncio.run(scenario())


def test_runbook_knowledge_keeps_existing_read_authorization(authenticated_runtime, monkeypatch):
    client, headers = authenticated_runtime
    calls = []
    original = runtime.find_runbooks

    def observed(payload):
        calls.append(payload)
        return original(payload)

    monkeypatch.setattr(runtime, "find_runbooks", observed)
    request = {"action": "knowledge", "payload": {
        "source": "runbooks", "operation": "search", "query": "offline CPU podcast"}}
    response = client.post("/invocations", json=request)
    assert response.json()["ok"] is False
    assert calls == []
    response = client.post("/invocations", headers=headers(groups=("eddie-readers",)), json=request)
    result = response.json()
    assert result["ok"] is True, result
    assert result["result"]["matches"]
    assert result["result"]["affectsPlacement"] is False
    assert len(calls) == 1
    response = client.post("/invocations", headers=headers(), json={"action": "knowledge", "payload": {
        "source": "runbooks", "operation": "read", "ids": ["route-cpu-batch"]}})
    assert response.json()["ok"] is True
    assert response.json()["result"]["citations"]


@pytest.mark.parametrize("payload", [
    {"source": "runbooks", "operation": "execute", "ids": ["route-cpu-batch"]},
    {"source": "runbooks", "operation": "read", "ids": ["../../private"]},
    {"source": "runbooks", "operation": "search", "limit": 500},
    {"source": "runbooks", "operation": "search", "query": "x" * 1201},
    {"source": "unknown-provider", "query": "anything"},
])
def test_knowledge_rejects_unsupported_source_operation_and_inputs(authenticated_runtime, payload):
    client, headers = authenticated_runtime
    response = client.post("/invocations", headers=headers(),
                           json={"action": "knowledge", "payload": payload})
    assert response.json()["ok"] is False
    assert "../../private" not in response.text


def test_default_coa_request_still_uses_verified_callers_token(authenticated_runtime, monkeypatch):
    client, headers = authenticated_runtime
    received = []

    async def context(query, *, bearer_token):
        received.append((query, bearer_token))
        return {"state": "NOT_INSTALLED", "affectsPlacement": False}

    monkeypatch.setattr(runtime, "knowledge", SimpleNamespace(retrieve_context=context))
    auth = headers()
    response = client.post("/invocations", headers=auth,
                           json={"action": "knowledge", "payload": {"query": "inference"}})
    assert response.json()["ok"] is True
    assert received == [("inference", auth["Authorization"].removeprefix("Bearer "))]
    assert response.json()["result"]["state"] == "NOT_INSTALLED"
