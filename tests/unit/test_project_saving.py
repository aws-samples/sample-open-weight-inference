"""Saved drafts are scoped user input, with conditional revision protection."""
import copy
import json
import zlib

import boto3
import pytest
from moto import mock_aws

from projects.store import (
    MAX_DOCUMENT_BYTES, ProjectConflict, ProjectStore, decode_document,
)


@pytest.fixture
def store():
    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1",
                                 aws_access_key_id="testing", aws_secret_access_key="testing")
        table = dynamodb.create_table(
            TableName="cases",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield ProjectStore(table)


def document():
    return {
        "form": {"caseId": "demo", "description": "Support request classification",
                 "budgetUsd": "200.50", "provideSlo": False},
        "draft": "What if we use Bedrock?",
        "turns": [], "decision": None,
        "evaluationDraft": {
            "rows": [{"input": "I cannot sign in", "expected": "account", "actual": None}],
            "target": "95", "caseSensitive": False, "report": None, "reportKey": None,
        },
    }


def test_draft_round_trip_includes_tests_and_exact_money(store):
    saved = store.save("verified-user-and-customer", "demo", document(), None)["project"]
    restored = store.get("verified-user-and-customer", "demo")["project"]
    assert restored == saved
    assert restored["document"] == document()
    assert restored["document"]["form"]["budgetUsd"] == "200.50"


def test_older_browser_cannot_overwrite_a_new_revision(store):
    initial = store.save("alice", "demo", document(), None)["project"]
    edited = copy.deepcopy(document())
    edited["form"]["budgetUsd"] = "300"
    saved = store.save("alice", "demo", edited, initial["revision"])["project"]
    other_edit = copy.deepcopy(document())
    other_edit["form"]["budgetUsd"] = "100"
    with pytest.raises(ProjectConflict):
        store.save("alice", "demo", other_edit, initial["revision"])
    assert store.get("alice", "demo")["project"] == saved


def test_lost_save_response_can_be_recovered_without_another_revision(store):
    first = store.save("alice", "demo", document(), None)["project"]
    repeated = store.save("alice", "demo", document(), None)["project"]
    assert repeated["revision"] == first["revision"]
    assert repeated["savedAt"] == first["savedAt"]


def test_another_user_or_customer_cannot_read_list_or_replace_a_project(store):
    saved = store.save("alice-customer-a", "demo", document(), None)["project"]
    for other in ("bob-customer-a", "alice-customer-b"):
        assert store.get(other, "demo") == {"project": None}
        assert store.list(other)["projects"] == []
        with pytest.raises(ProjectConflict):
            store.save(other, "demo", document(), saved["revision"])
    assert store.get("alice-customer-a", "demo")["project"] == saved


@pytest.mark.parametrize("case_id", ["../other", "", "case/other", "x" * 101])
def test_invalid_identifiers_never_become_storage_keys(store, case_id):
    with pytest.raises(ValueError):
        store.save("alice", case_id, document(), None)


@pytest.mark.parametrize("patch", [
    {"approval": {"approved": True}},
    {"form": {"budgetUsd": float("nan")}},
    {"evaluationDraft": {"rows": "not a list"}},
    {"turns": [{"id": "turn", "prompt": 123}]},
])
def test_malformed_or_authority_fields_are_rejected_before_write(store, patch):
    with pytest.raises(ValueError):
        store.save("alice", "demo", {**document(), **patch}, None)
    assert store.list("alice")["projects"] == []


def test_compressed_payload_cannot_expand_without_a_bound():
    encoded = zlib.compress(json.dumps({"form": {"description": "x" * MAX_DOCUMENT_BYTES}}).encode())
    with pytest.raises(ValueError, match="safely"):
        decode_document(encoded)


def test_removal_hides_a_project_but_preserves_history_and_deployment_records(store):
    saved = store.save("alice", "demo", document(), None)["project"]
    deployment = {"pk": "project#alice", "sk": "job#running", "state": "READY"}
    session = {"pk": "advisor#alice", "sk": "message#1", "text": "Saved answer"}
    for item in (deployment, session):
        store.table.put_item(Item=item)
    assert store.remove("alice", "demo", saved["revision"]) == {"caseId": "demo", "removed": True}
    assert store.get("alice", "demo") == {"project": None, "removed": True}
    assert store.list("alice")["projects"] == []
    assert store.list("alice")["removedCaseIds"] == ["demo"]
    raw = store.table.get_item(Key=store.key("alice", "demo"))["Item"]
    assert decode_document(raw["document"]) == document()
    for item in (deployment, session):
        assert store.table.get_item(Key={key: item[key] for key in ("pk", "sk")})["Item"] == item


def test_removal_is_idempotent_and_stale_save_cannot_restore_even_identical_content(store):
    saved = store.save("alice", "demo", document(), None)["project"]
    first = store.remove("alice", "demo", saved["revision"])
    assert store.remove("alice", "demo", saved["revision"]) == first
    assert store.remove("alice", "demo", None) == first
    for revision in (saved["revision"], None):
        with pytest.raises(ProjectConflict, match="removed"):
            store.save("alice", "demo", document(), revision)


def test_removing_a_browser_only_draft_prevents_its_later_cloud_save(store):
    store.remove("alice", "browser-only", None)
    assert store.get("alice", "browser-only") == {"project": None, "removed": True}
    with pytest.raises(ProjectConflict, match="removed"):
        store.save("alice", "browser-only", document(), None)


def test_removal_against_an_old_revision_cannot_hide_newer_work(store):
    first = store.save("alice", "demo", document(), None)["project"]
    newer = document()
    newer["form"]["budgetUsd"] = "100"
    current = store.save("alice", "demo", newer, first["revision"])["project"]
    for revision in (first["revision"], None):
        with pytest.raises(ProjectConflict, match="changed"):
            store.remove("alice", "demo", revision)
    assert store.get("alice", "demo")["project"] == current


def test_another_user_or_customer_cannot_remove_the_owners_project(store):
    saved = store.save("alice-customer-a", "demo", document(), None)["project"]
    for other in ("bob-customer-a", "alice-customer-b"):
        with pytest.raises(ProjectConflict):
            store.remove(other, "demo", saved["revision"])
        # A guessed identifier can only mark the caller's own empty namespace.
        store.remove(other, "demo", None)
    assert store.get("alice-customer-a", "demo")["project"] == saved
    assert store.list("alice-customer-a")["removedCaseIds"] == []


def test_removed_entries_do_not_hide_later_pages_of_saved_projects(store):
    for index in range(101):
        store.remove("alice", f"a-{index:03}", None)
    saved = store.save("alice", "z-keep", document(), None)["project"]
    first = store.list("alice")
    assert first["projects"] == [] and first["hasMore"]
    assert len(first["removedCaseIds"]) == 100
    second = store.list("alice", first["nextCaseId"])
    assert [item["caseId"] for item in second["projects"]] == [saved["caseId"]]
    assert len(second["removedCaseIds"]) == 1
    assert not second["hasMore"] and second["nextCaseId"] is None


@pytest.mark.parametrize("case_id,revision", [
    ("../other", None), ("", None), ("demo", ""), ("demo", {"revision": "x"}),
])
def test_invalid_removal_input_never_writes_a_marker(store, case_id, revision):
    with pytest.raises(ValueError):
        store.remove("alice", case_id, revision)
    assert store.list("alice")["removedCaseIds"] == []
