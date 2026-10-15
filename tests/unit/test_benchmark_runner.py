from copy import deepcopy

import pytest

from evaluation.benchmarks import VERSION, compare_benchmarks
from evaluation.runner import _loopback_url, run_plan, validate_plan


def plan():
    return {
        "schemaVersion": VERSION,
        "workload": {"name": "Synthetic exact-answer test", "tasks": [
            {"id": "one", "input": "Return A.", "expected": "A"},
            {"id": "two", "input": "Return B.", "expected": "B"},
        ]},
        "target": {"provider": "bedrock", "model": "example.model-v1", "revision": "provider-version-1",
                   "runtime": "Converse", "hardware": "AWS managed", "region": "us-east-1", "label": "Example"},
        "settings": {"repetitions": 2, "concurrency": 2},
    }


def test_runner_executes_every_task_repeat_and_exports_no_prompts_or_outputs():
    calls = []
    def invoke(text):
        calls.append(text)
        return {"output": text.split()[1][0]}
    report = run_plan(plan(), invoke)
    assert len(calls) == len(report["samples"]) == 4
    assert all(row["accepted"] for row in report["samples"])
    assert "Return A." not in str(report)
    assert all("outputDigest" in row for row in report["samples"])
    assert compare_benchmarks({"runs": [report]})["rows"][0]["accepted"] == 4


def test_errors_are_preserved_with_no_provider_exception_leak():
    def invoke(text):
        raise RuntimeError("private prompt and credential must not be exported")
    report = run_plan(plan(), invoke)
    assert len(report["samples"]) == 4
    assert all(row["status"] == "error" for row in report["samples"])
    assert "private prompt" not in str(report)


def test_runner_keeps_dataset_and_rubric_identities_distinct():
    first = plan()
    second = deepcopy(first)
    second["target"]["model"] = "another.model"
    a, b = run_plan(first, lambda _: {"output": "A"}), run_plan(second, lambda _: {"output": "A"})
    assert a["workload"] == b["workload"]
    second["settings"]["caseSensitive"] = False
    c = run_plan(second, lambda _: {"output": "A"})
    assert c["workload"]["rubricDigest"] != a["workload"]["rubricDigest"]


@pytest.mark.parametrize("url", [
    "https://example.com/v1", "http://169.254.169.254:8000/v1", "http://localhost:8000/v1",
    "http://127.0.0.1:80/v1", "http://127.0.0.1:8000/v1?target=elsewhere",
    "http://user:secret@127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1/../../secret",
])
def test_self_hosted_endpoint_is_limited_to_explicit_loopback_tunnel(url):
    with pytest.raises(ValueError):
        _loopback_url(url)


def test_loopback_literals_are_supported():
    assert _loopback_url("http://127.0.0.1:8000/v1") == "http://127.0.0.1:8000/v1/chat/completions"
    assert _loopback_url("http://[::1]:8000/v1/") == "http://[::1]:8000/v1/chat/completions"


@pytest.mark.parametrize("field,value", [("concurrency", 9), ("repetitions", 6),
                                       ("maxOutputTokens", 5000), ("maxDurationSeconds", 0)])
def test_execution_bounds(field, value):
    value_plan = plan()
    value_plan["settings"][field] = value
    with pytest.raises(ValueError):
        validate_plan(value_plan)


def test_no_task_commands_or_credential_fields():
    value = plan()
    value["workload"]["tasks"][0]["command"] = "arbitrary command"
    with pytest.raises(ValueError, match="Commands"):
        validate_plan(value)
    value = plan()
    value["target"]["apiKey"] = "secret"
    with pytest.raises(ValueError, match="credentials"):
        validate_plan(value)
