"""Adversarial accounting and comparability cases for supplied measurements."""
from copy import deepcopy

import pytest

from evaluation.benchmarks import VERSION, compare_benchmarks, digest, token_totals, validate_run


def run(name="one", *, latency=100, hourly="3.6", accepted=True):
    return {
        "schemaVersion": VERSION, "runId": name, "createdAt": "2026-10-14T12:00:00Z",
        "configuration": {"label": name, "model": "example-model", "revision": "revision-1",
                          "runtime": "example-runtime/1", "harness": "example-harness/1",
                          "region": "us-east-1", "hardware": "CPU", "provider": "external"},
        "workload": {"name": "Authored test cases", "datasetDigest": digest(["task"]),
                     "rubricDigest": digest(["exact"]), "taskIds": ["task"]},
        "protocol": {"repetitions": 1, "concurrency": 1, "maxOutputTokens": 128,
                     "warmupRequests": 0, "temperature": 0, "measurement": "client_end_to_end",
                     "loadModel": "closed_loop", "acceptance": "exact-answer/1"},
        "state": "completed", "durationSeconds": 10,
        "samples": [{"taskId": "task", "repetition": 1, "status": "ok", "accepted": accepted,
                     "elapsedMs": latency, "ttftMs": None, "usage": None}],
        "cost": {"basis": "capacity", "scope": "benchmark_window", "currency": "USD",
                 "hourlyUsd": hourly, "retrievedAt": "2026-10-14T11:59:00Z",
                 "source": "Synthetic unit-test rate, not an AWS quote", "rateId": "test-price"},
    }


def test_capacity_cost_includes_idle_window_and_frontier_uses_useful_responses():
    cheap, costly = run("cheap"), run("costly", hourly="7.2", latency=200)
    report = compare_benchmarks({"runs": [cheap, costly], "settings": {"maximumP95Ms": 150}})
    assert report["rows"][0]["costUsd"] == "0.01000000"  # full 10s, not the .1s request
    assert report["rows"][0]["frontier"] is True
    assert report["rows"][1]["useful"] == 0
    assert report["rows"][1]["eligible"] is False
    assert report["lowestCostEligibleRunIds"] == ["cheap"]
    assert report["deploymentQualified"] is False
    assert report["provenance"] == "SUPPLIED_MEASUREMENTS"


@pytest.mark.parametrize("mode,expected", [("input_includes_cache", 110), ("cache_is_additional", 160)])
def test_cache_accounting_is_explicit_even_when_ratios_look_similar(mode, expected):
    usage = {"inputTokens": 100, "outputTokens": 10, "cacheReadTokens": 50,
             "cacheWriteTokens": 0, "accounting": mode}
    assert token_totals({"usage": usage})["totalTokens"] == expected
    usage["accounting"] = "unknown"
    assert token_totals({"usage": usage}) is None


def test_cache_subset_cannot_exceed_input_and_missing_usage_is_not_zero():
    with pytest.raises(ValueError, match="subsets"):
        token_totals({"usage": {"inputTokens": 10, "outputTokens": 1, "cacheReadTokens": 11,
                               "cacheWriteTokens": 0, "accounting": "input_includes_cache"}})
    a = run()
    a["cost"] = {"basis": "tokens", "scope": "benchmark_window", "currency": "USD",
                 "source": "test", "rateId": "test", "retrievedAt": "2026-10-14T12:00:00Z",
                 "perMillion": {"freshInputTokens": "1", "outputTokens": "2"}}
    report = compare_benchmarks({"runs": [a]})
    assert report["rows"][0]["costUsd"] is None
    assert not report["rows"][0]["eligible"]


def test_failed_request_usage_must_be_accounted_for():
    a = run()
    a["workload"]["taskIds"].append("error")
    a["samples"].append({"taskId": "error", "repetition": 1, "status": "error",
                          "accepted": False, "elapsedMs": 100, "usage": None})
    a["samples"][0]["usage"] = {"inputTokens": 100, "outputTokens": 10, "cacheReadTokens": 0,
                               "cacheWriteTokens": 0, "accounting": "input_includes_cache"}
    a["cost"] = {"basis": "tokens", "scope": "benchmark_window", "currency": "USD",
                 "source": "test", "rateId": "test", "retrievedAt": "2026-10-14T12:00:00Z",
                 "perMillion": {"freshInputTokens": "1", "outputTokens": "2"}}
    row = compare_benchmarks({"runs": [a]})["rows"][0]
    assert row["acceptancePercent"] == 50
    assert row["errors"] == 1
    assert row["costUsd"] is None


@pytest.mark.parametrize("change", ["datasetDigest", "rubricDigest", "concurrency", "maxOutputTokens"])
def test_mismatched_workloads_or_protocols_cannot_join_frontier(change):
    a, b = run("a"), run("b", hourly=".1")
    if change in a["workload"]:
        b["workload"][change] = digest("different")
    else:
        b["protocol"][change] += 1
    report = compare_benchmarks({"runs": [a, b]})
    assert report["lowestCostEligibleRunIds"] == ["a"]
    assert change in report["rows"][1]["comparisonDifferences"]


def test_failed_and_unstarted_tasks_cannot_be_dropped_or_marked_successful():
    a = run()
    a["workload"]["taskIds"].append("not-started")
    with pytest.raises(ValueError, match="every scheduled"):
        validate_run(a)
    a["samples"].append({"taskId": "not-started", "repetition": 1, "status": "not_run",
                         "accepted": False, "elapsedMs": None})
    with pytest.raises(ValueError, match="completed run"):
        validate_run(a)
    a["state"] = "stopped"
    row = compare_benchmarks({"runs": [a]})["rows"][0]
    assert row["acceptancePercent"] == 50
    assert row["notRun"] == 1
    assert row["eligible"] is False
    a["samples"][1]["accepted"] = True
    with pytest.raises(ValueError, match="cannot count"):
        validate_run(a)


def test_ungraded_outputs_need_review_even_with_zero_quality_floor():
    a = run(accepted=None)
    row = compare_benchmarks({"runs": [a], "settings": {"minimumAcceptancePercent": 0}})["rows"][0]
    assert row["ungraded"] == 1
    assert not row["eligible"]


def test_latency_and_cost_tradeoffs_both_survive_and_equal_runs_do_not_dominate():
    a, b, c = run("fast", latency=10, hourly="7.2"), run("cheap"), run("same")
    rows = compare_benchmarks({"runs": [a, b, c]})["rows"]
    assert all(row["frontier"] for row in rows)


def test_rounding_does_not_change_small_cost_order():
    a, b = run("a", hourly="0.0000002"), run("b", hourly="0.0000001")
    report = compare_benchmarks({"runs": [a, b]})
    assert report["rows"][0]["costPerUsefulUsd"] == report["rows"][1]["costPerUsefulUsd"]
    assert report["lowestCostEligibleRunIds"] == ["b"]
    assert not report["rows"][0]["frontier"]


@pytest.mark.parametrize("mutate", [
    lambda a: a.update(durationSeconds=float("nan")),
    lambda a: a["samples"][0].update(elapsedMs=-1),
    lambda a: a["samples"][0].update(ttftMs=200),
    lambda a: a["samples"][0].update(elapsedMs=20000),
    lambda a: a["cost"].update(hourlyUsd="NaN"),
    lambda a: a["protocol"].update(concurrency=True),
    lambda a: a["protocol"].update(warmupRequests=1),
    lambda a: a.update(summary={"winner": True}),
    lambda a: a["configuration"].update(apiKey="do-not-accept"),
])
def test_malformed_or_unaccounted_evidence_is_rejected(mutate):
    a = run()
    mutate(a)
    with pytest.raises(ValueError):
        compare_benchmarks({"runs": [a]})


def test_duplicate_runs_and_observations_are_rejected():
    a = run()
    with pytest.raises(ValueError, match="Run IDs"):
        compare_benchmarks({"runs": [a, deepcopy(a)]})
    a["protocol"]["repetitions"] = 2
    a["samples"].append(deepcopy(a["samples"][0]))
    with pytest.raises(ValueError, match="unique scheduled"):
        validate_run(a)


def test_more_repeats_do_not_manufacture_more_distinct_tasks():
    a = run()
    a["protocol"]["repetitions"] = 2
    a["samples"].append({**a["samples"][0], "repetition": 2})
    row = compare_benchmarks({"runs": [a], "settings": {"minimumTasks": 2}})["rows"][0]
    assert len(row["taskOutcomes"]) == 1
    assert row["eligible"] is False
