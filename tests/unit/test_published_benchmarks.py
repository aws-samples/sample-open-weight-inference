"""Synthetic metadata only: no downloaded benchmark tasks or results."""
import copy
import json
from decimal import Decimal
from unittest.mock import Mock

import pytest

from evaluation import published


def entry(name="a", passed=300, task_cost=.01, version="1.0.0"):
    return {
        "agent": "mini-SWE-agent", "mini-swe-agent_version": version,
        "folder": name, "name": f"Test model {name}", "date": "2026-01-01",
        "tags": [f"Model: test-{name}", "System: Attempts - 1"], "os_model": True,
        "checked": None, "reasoning_effort": "low",
        "per_instance_details": {
            f"fixture__module-{index}": {"resolved": index < passed, "cost": task_cost}
            for index in range(500)
        },
        "resolved": passed / 5, "cost": float(Decimal(str(task_cost)) * 500),
        "instance_cost": task_cost,
    }


def source(*rows):
    return ('<html><script id="leaderboard-data" type="application/json">' +
            json.dumps([{"name": "Verified", "results": list(rows)}]) + '</script></html>').encode()


@pytest.fixture(autouse=True)
def clear_cache(monkeypatch):
    monkeypatch.setattr(published, "_cache", None)


def test_recomputes_all_task_costs_frontier_and_cites_snapshot(monkeypatch):
    body = source(entry("better", passed=400), entry("worse", passed=300, task_cost=.02))
    monkeypatch.setattr(published, "_download", Mock(return_value=body))
    result = published.public_benchmarks({})
    a, b = result["rows"]
    assert a["resolved"] == 400 and a["resolvedPercent"] == 80
    assert a["costPerTaskUsd"] == "0.01000000" and a["costPerResolvedUsd"] == "0.01250000"
    assert a["frontier"] and not b["frontier"]
    assert a["outcomesConsistent"] and a["costsConsistent"]
    assert result["provenance"] == "PUBLISHED_RESULTS"
    assert result["deploymentQualified"] is False
    assert len(result["sourceSha256"]) == 64
    assert "_observations" not in a and "fixture__module" not in json.dumps(result)
    assert a["sourceReviewFlag"] is None


@pytest.mark.parametrize("field,value,reason", [
    ("resolved", 95, "percentage"), ("cost", 200, "total cost"), ("instance_cost", 2, "mean cost"),
    ("warning", "source caution", "flags this submission"),
    ("tags", ["Model: test"], "single attempt"),
])
def test_headline_disagreements_or_source_warnings_stay_visible_but_unranked(monkeypatch, field, value, reason):
    raw = entry()
    raw[field] = value
    monkeypatch.setattr(published, "_download", lambda: source(raw))
    row = published.public_benchmarks({})["rows"][0]
    assert not row["eligible"] and not row["frontier"]
    assert reason in " ".join(row["reasons"])
    if field == "resolved":
        assert not row["outcomesConsistent"]
    elif field in ("cost", "instance_cost"):
        assert not row["costsConsistent"]


def test_missing_outcomes_are_not_converted_to_false_and_costs_do_not_hide_gaps(monkeypatch):
    a = entry("missing")
    a["per_instance_details"]["fixture__module-3"]["resolved"] = None
    b = entry("short")
    b["per_instance_details"].pop("fixture__module-499")
    monkeypatch.setattr(published, "_download", lambda: source(a, b))
    rows = published.public_benchmarks({})["rows"]
    assert all(row["resolvedPercent"] is None and not row["eligible"] for row in rows)
    assert rows[0]["publishedResolvedPercent"] == 60
    assert "explicit pass/fail" in " ".join(rows[0]["reasons"])
    assert rows[1]["costPerTaskUsd"] is None


@pytest.mark.parametrize("value", [-1, True, "0.01", None])
def test_unknown_or_invalid_costs_never_become_free(monkeypatch, value):
    raw = entry()
    raw["per_instance_details"]["fixture__module-1"]["cost"] = value
    monkeypatch.setattr(published, "_download", lambda: source(raw))
    row = published.public_benchmarks({})["rows"][0]
    assert row["costPerTaskUsd"] is None and not row["eligible"]


def test_harness_versions_are_separate_and_different_tasks_are_excluded(monkeypatch):
    a, b, c = entry("a"), entry("b"), entry("c", version="2.0.0")
    b["per_instance_details"]["different"] = b["per_instance_details"].pop("fixture__module-1")
    monkeypatch.setattr(published, "_download", lambda: source(a, b, c))
    result = published.public_benchmarks({"cohort": "1.0.0"})
    assert len(result["cohorts"]) == 2
    assert len(result["rows"]) == 2
    assert result["rows"][0]["eligible"]
    assert "task set differs" in " ".join(result["rows"][1]["reasons"])
    with pytest.raises(ValueError, match="selected cohort"):
        published.public_benchmarks({"cohort": "1.0.0", "baseline": "a", "contender": "c"})


def test_paired_results_expose_regressions_not_just_headline_difference(monkeypatch):
    a, b = entry("a", passed=300), entry("b", passed=350)
    b["per_instance_details"]["fixture__module-1"]["resolved"] = False
    b["per_instance_details"]["fixture__module-499"]["resolved"] = True
    monkeypatch.setattr(published, "_download", lambda: source(a, b))
    result = published.public_benchmarks({"cohort": "1.0.0", "baseline": "a", "contender": "b"})
    pair = result["paired"]
    assert pair["contenderOnly"] == 51 and pair["baselineOnly"] == 1
    assert pair["differencePercentagePoints"] == 10
    assert pair["bothResolved"] + pair["neitherResolved"] + 52 == 500


def test_cache_preserves_retrieval_time_and_cannot_be_mutated_by_callers(monkeypatch):
    download = Mock(return_value=source(entry()))
    monkeypatch.setattr(published, "_download", download)
    first = published.public_benchmarks({})
    first["rows"][0]["resolved"] = 500
    second = published.public_benchmarks({})
    assert second["rows"][0]["resolved"] == 300
    assert first["retrievedAt"] == second["retrievedAt"]
    download.assert_called_once()


def test_source_unavailable_or_format_change_returns_no_fabricated_results(monkeypatch):
    monkeypatch.setattr(published, "_download", lambda: b"<html>Unavailable</html>")
    result = published.public_benchmarks({})
    assert result["state"] == "UNAVAILABLE" and "rows" not in result
    with pytest.raises(ValueError, match="format"):
        published.parse_source(source(entry()) + source(entry()))


@pytest.mark.parametrize("replacement", [
    b'"resolved": 60.0, "resolved": 60.0',
    b'"resolved": NaN',
])
def test_ambiguous_or_nonfinite_source_json_is_rejected(replacement):
    body = source(entry()).replace(b'"resolved": 60.0', replacement)
    with pytest.raises(ValueError, match="duplicate|non-finite"):
        published.parse_source(body)


def test_caller_and_model_cannot_select_outbound_url(monkeypatch):
    download = Mock()
    monkeypatch.setattr(published, "_download", download)
    with pytest.raises(ValueError):
        published.public_benchmarks({"url": "https://example.test/private"})
    download.assert_not_called()


def test_read_is_pinned_bounded_and_sends_no_user_data(monkeypatch):
    import io
    body = source(entry())
    opener = Mock(return_value=io.BytesIO(body))
    monkeypatch.setattr(published, "open_url", opener)
    assert published._download() == body
    request = opener.call_args.args[0]
    assert request.full_url == published.SOURCE and request.data is None
    assert opener.call_args.kwargs["allowed_hosts"] == ("www.swebench.com",)
    opener.return_value = io.BytesIO(b"x" * (published.MAX_BYTES + 1))
    with pytest.raises(ValueError, match="limit"):
        published._download()
