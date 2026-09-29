"""The coordinator's real forwarding code reaches the independent services."""
import asyncio
import importlib
import io
import json

import boto3
import pytest

from runtime.principal import Principal


@pytest.mark.parametrize("action,function", [
    ("deployment.list", "deployment-controller"),
    ("plan.approve", "deployment-controller"),
    ("deployment.invoke", "test-inference"),
])
def test_forwarding_uses_verified_identity_and_the_correct_function(monkeypatch, action, function):
    calls = []

    class Lambda:
        def invoke(self, **kwargs):
            calls.append(kwargs)
            return {"Payload": io.BytesIO(b'{"ok":true,"result":{"receipt":"test-result"}}')}

    def client(service, **kwargs):
        assert service == "lambda"
        return Lambda()

    monkeypatch.setattr(boto3, "client", client)
    app = importlib.import_module("runtime.app")
    monkeypatch.setattr(app, "DEPLOYMENT_CONTROLLER", "deployment-controller")
    monkeypatch.setattr(app, "INFERENCE_FUNCTION", "test-inference")
    principal = Principal(subject="alice", username="Alice", capabilities=frozenset({"read"}),
                          token="verified-token-fixture")
    result = asyncio.run(app.forward_deployment(
        action, {"projectId": "spoofed-project", "jobId": "test-job"},
        app.ActionContext(principal=principal, project_id="user:alice"),
    ))
    assert result == {"receipt": "test-result"}
    assert len(calls) == 1
    assert calls[0]["FunctionName"] == function
    sent = json.loads(calls[0]["Payload"])
    assert sent["payload"]["projectId"] == "user:alice"
    assert sent["authorization"] == "verified-token-fixture"
    assert "authorization" not in sent["payload"]
    assert "verified-token-fixture" not in repr(principal)



def test_unexpected_error_never_exposes_exception_payload_to_client_or_log(caplog):
    app = importlib.import_module("runtime.app")
    message = app.safe_failure_detail(RuntimeError("secret-fixture-in-sdk-url"), "deployment.list")
    assert "Reference:" in message
    assert "secret-fixture" not in message
    assert "secret-fixture" not in caplog.text
    assert "type=RuntimeError" in caplog.text
