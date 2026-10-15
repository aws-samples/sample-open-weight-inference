"""Exercise wire parsing, bounded execution and accounting without AWS requests."""
import io
import json
from unittest.mock import Mock

import pytest

from api.model_usage import normalized_usage
from evaluation.benchmarks import token_totals
from evaluation.runner import AwsAdapter, LoopbackAdapter, _load, main, public_price, run_plan, validate_plan
from test_benchmark_runner import plan


def test_missing_or_invalid_provider_usage_is_not_zero():
    assert normalized_usage(None) is None
    assert normalized_usage({"prompt_tokens": True, "completion_tokens": 1}) is None
    usage = normalized_usage({"prompt_tokens": 10, "completion_tokens": 2})
    assert usage["cacheReadTokens"] is None
    assert token_totals({"usage": usage}) is None
    assert normalized_usage({"prompt_tokens": 10, "completion_tokens": 2,
                             "prompt_tokens_details": {"cached_tokens": 11}}) is None


def test_openai_and_converse_accounting_do_not_double_count_cache():
    common = normalized_usage({"prompt_tokens": 100, "completion_tokens": 20,
                               "prompt_tokens_details": {"cached_tokens": 50}})
    converse = normalized_usage({"inputTokens": 50, "outputTokens": 20, "cacheReadInputTokens": 50},
                                bedrock=True)
    assert token_totals({"usage": common}) == token_totals({"usage": converse})
    assert token_totals({"usage": common})["totalTokens"] == 120


def test_converse_stream_records_ttft_usage_and_closes():
    stream = Mock()
    stream.__iter__ = lambda _: iter([
        {"contentBlockStart": {}},
        {"contentBlockDelta": {"delta": {"text": "A"}}},
        {"metadata": {"usage": {"inputTokens": 3, "outputTokens": 1}}},
    ])
    client = Mock()
    client.converse_stream.return_value = {"stream": stream}
    session = Mock(client=Mock(return_value=client))
    adapter = AwsAdapter(validate_plan(plan()), session)
    result = adapter("Return A.")
    assert result["output"] == "A"
    assert result["ttftMs"] >= 0
    assert result["usage"]["inputTokens"] == 3
    stream.close.assert_called_once()
    configuration = session.client.call_args.kwargs["config"]
    assert configuration.retries["total_max_attempts"] == 1


def test_converse_error_closes_stream_and_retains_failed_sample():
    stream = Mock()
    stream.__iter__ = lambda _: iter([{"internalServerException": {"message": "private"}}])
    client = Mock()
    client.converse_stream.return_value = {"stream": stream}
    adapter = AwsAdapter(validate_plan(plan()), Mock(client=Mock(return_value=client)))
    report = run_plan(plan(), adapter)
    assert all(row["status"] == "error" for row in report["samples"])
    assert "private" not in json.dumps(report)
    assert stream.close.call_count == 4


def test_sagemaker_alias_does_not_replace_recorded_model_identity():
    value = plan()
    value["target"].update(provider="sagemaker", endpointName="owned-endpoint", requestModel="eddie-model")
    value = validate_plan(value)
    client = Mock()
    body = io.BytesIO(json.dumps({"choices": [{"message": {"content": "A"}}],
                                  "usage": {"prompt_tokens": 2, "completion_tokens": 1}}).encode())
    client.invoke_endpoint.return_value = {"Body": body}
    result = AwsAdapter(value, Mock(client=Mock(return_value=client)))("Return A.")
    assert result["output"] == "A" and result["ttftMs"] is None and body.closed
    request = json.loads(client.invoke_endpoint.call_args.kwargs["Body"])
    assert request["model"] == "eddie-model"
    assert value["target"]["model"] == "example.model-v1"


def test_loopback_stream_closes_and_requires_done(monkeypatch):
    value = plan()
    value["target"].update(provider="self_hosted", baseUrl="http://127.0.0.1:8000/v1")
    adapter = LoopbackAdapter(validate_plan(value))
    payload = b'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: [DONE]\n\n'
    response = io.BytesIO(payload)
    adapter.opener = Mock(open=Mock(return_value=response))
    assert adapter("Return A.")["output"] == "A"
    assert response.closed
    response = io.BytesIO(payload.replace(b"data: [DONE]\n\n", b""))
    adapter.opener.open.return_value = response
    with pytest.raises(ValueError, match="before completion"):
        adapter("Return A.")
    assert response.closed


def test_stop_preserves_scheduled_denominator_and_grades_completed_request():
    value = plan()
    value["settings"].update(concurrency=1)
    calls = []
    def invoke(text):
        calls.append(text)
        return {"output": "A"}
    report = run_plan(value, invoke, stopped=lambda: bool(calls))
    assert len(calls) == 1 and report["state"] == "stopped"
    assert len(report["samples"]) == 4
    assert sum(row["status"] == "not_run" for row in report["samples"]) == 3


def test_unicode_casefold_matches_existing_scorer():
    value = plan()
    value["workload"]["tasks"] = [{"id": "unicode", "input": "Return the word.", "expected": "STRASSE"}]
    value["settings"]["caseSensitive"] = False
    assert all(s["accepted"] for s in run_plan(value, lambda _: {"output": " Straße "})["samples"])


def test_validate_only_never_creates_aws_session(tmp_path, monkeypatch, capsys):
    import boto3
    session = Mock(side_effect=AssertionError("Validation must not contact AWS"))
    monkeypatch.setattr(boto3, "Session", session)
    path = tmp_path / "plan.json"
    path.write_text(json.dumps(plan()))
    assert main(["--plan", str(path)]) == 0
    assert json.loads(capsys.readouterr().out)["scheduledRequests"] == 4
    session.assert_not_called()


def test_account_mismatch_prevents_requests_and_output(tmp_path, monkeypatch):
    import boto3
    client = Mock()
    client.get_caller_identity.return_value = {"Account": "1" * 12}
    monkeypatch.setattr(boto3, "Session", Mock(return_value=Mock(client=Mock(return_value=client))))
    path, output = tmp_path / "plan.json", tmp_path / "report.json"
    path.write_text(json.dumps(plan()))
    assert main(["--plan", str(path), "--execute", "--expect-account", "2" * 12,
                 "--output", str(output)]) == 2
    client.converse_stream.assert_not_called()
    assert not output.exists()


def test_duplicate_json_fields_are_rejected(tmp_path):
    path = tmp_path / "duplicate.json"
    path.write_text('{"target":"one","target":"two"}')
    with pytest.raises(ValueError, match="Duplicate"):
        _load(path)


def test_bedrock_pricing_uses_verified_catalog_identity_not_a_caller_price_name(monkeypatch):
    from catalog import native
    from types import SimpleNamespace
    from decimal import Decimal
    value = plan()
    value["target"]["modelName"] = "Unrelated cheaper model"
    client = Mock()
    client.get_foundation_model.return_value = {"modelDetails": {
        "modelId": value["target"]["model"], "modelName": "Verified catalog name",
    }}
    rates = Mock(return_value={side: SimpleNamespace(amount=Decimal(".1"), sku=f"fixture-{side}")
                               for side in ("input", "output")})
    monkeypatch.setattr(native, "_bedrock", lambda _: client)
    monkeypatch.setattr(native, "native_rates", rates)
    assert public_price(value)["basis"] == "tokens"
    assert rates.call_args.args[1] == "Verified catalog name"
    client.get_foundation_model.return_value["modelDetails"]["modelId"] = "different-model"
    assert public_price(value)["basis"] == "unknown"


def test_profile_price_never_borrows_a_regional_model_rate(monkeypatch):
    from catalog import native
    call = Mock(side_effect=AssertionError("No unverified profile price mapping"))
    monkeypatch.setattr(native, "_bedrock", call)
    value = plan()
    value["target"]["model"] = "global." + value["target"]["model"]
    assert public_price(value)["basis"] == "unknown"
    call.assert_not_called()
