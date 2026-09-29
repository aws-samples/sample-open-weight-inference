"""Durable personal projects with optimistic concurrency.

Saved documents are user input, never approvals or benchmark evidence. The caller
identity comes from the verified runtime principal. Compression avoids duplicating
large solver reports across browser storage; both encoded and decoded sizes are
bounded. No project content is logged.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
import zlib
from datetime import datetime, timezone
from typing import Any

from botocore.exceptions import ClientError

MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
MAX_STORED_BYTES = 300 * 1024
CASE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
DOCUMENT_FIELDS = frozenset({
    "form", "decision", "turns", "draft", "inspection", "fieldOrigins",
    "evaluationDraft", "sizingDraft",
})


class ProjectConflict(ValueError):
    """A newer saved revision must not be overwritten."""


def validate_document(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - DOCUMENT_FIELDS:
        raise ValueError("The project has unsupported fields.")
    if not isinstance(value.get("form"), dict):
        raise ValueError("A project must contain its form.")
    if not isinstance(value.get("turns", []), list):
        raise ValueError("Project conversation must be a list.")
    if not isinstance(value.get("draft", ""), str):
        raise ValueError("The message draft must be text.")
    if any(not isinstance(key, str) or not isinstance(item, (str, bool, list, type(None)))
           for key, item in value["form"].items()):
        raise ValueError("Project form fields must contain text, flags or evidence lists.")
    for turn in value.get("turns", []):
        if not isinstance(turn, dict) or not isinstance(turn.get("id"), str) or not isinstance(turn.get("prompt"), str):
            raise ValueError("A saved conversation turn is invalid.")
        if not isinstance(turn.get("changedFields", []), list) or not isinstance(turn.get("toolCallSummary", []), list):
            raise ValueError("A saved conversation summary is invalid.")
    for name in ("decision", "inspection", "fieldOrigins", "evaluationDraft", "sizingDraft"):
        if value.get(name) is not None and not isinstance(value[name], dict):
            raise ValueError(f"Project {name} must be an object.")
    sizing = value.get("sizingDraft")
    if sizing is not None:
        from solver.inference_sizing import DEFAULTS

        settings = sizing.get("settings")
        # Drafts may be incomplete; numeric validation happens when calculating.
        if not isinstance(settings, dict) or set(settings) - set(DEFAULTS) or any(
            not isinstance(item, str) or len(item) > 240 for item in settings.values()
        ):
            raise ValueError("Saved sizing settings must contain supported text fields.")
        report = sizing.get("report")
        if report is not None and (
            not isinstance(report, dict) or report.get("schemaVersion") != 1
            or report.get("scope") != "PLANNING_ONLY"
            or report.get("performanceMeasured") is not False
            or not isinstance(report.get("groups"), list)
            or not isinstance(report.get("settings"), dict)
            or not isinstance(report.get("request"), dict)
        ):
            raise ValueError("The saved sizing sheet must be a planning report.")
    evaluation = value.get("evaluationDraft")
    if evaluation is not None:
        if not isinstance(evaluation.get("rows"), list) or not 1 <= len(evaluation["rows"]) <= 1000:
            raise ValueError("A saved answer test needs between 1 and 1,000 examples.")
        for example in evaluation["rows"]:
            if not isinstance(example, dict) or any(
                not isinstance(example.get(key), str) for key in ("input", "expected")
            ) or not isinstance(example.get("actual"), (str, type(None))):
                raise ValueError("A saved answer test has an invalid example.")
        if not isinstance(evaluation.get("target"), str) or not isinstance(evaluation.get("caseSensitive"), bool):
            raise ValueError("Saved answer-test settings are invalid.")
        if evaluation.get("report") is not None and not isinstance(evaluation["report"], dict):
            raise ValueError("The saved answer-test report is invalid.")
        if not isinstance(evaluation.get("reportKey"), (str, type(None))):
            raise ValueError("The saved answer-test identity is invalid.")
    return value


def encode_document(document: dict[str, Any]) -> tuple[bytes, str]:
    raw = json.dumps(validate_document(document), sort_keys=True, ensure_ascii=False,
                     allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise ValueError("This project is too large to save. Export a copy before starting a new project.")
    encoded = zlib.compress(raw)
    if len(encoded) > MAX_STORED_BYTES:
        raise ValueError("This project is too large to save. Export a copy before starting a new project.")
    return encoded, hashlib.sha256(raw).hexdigest()


def decode_document(value: Any) -> dict[str, Any]:
    decoder = zlib.decompressobj()
    raw = decoder.decompress(bytes(value), MAX_DOCUMENT_BYTES + 1)
    if len(raw) > MAX_DOCUMENT_BYTES or not decoder.eof or decoder.unused_data:
        raise ValueError("The saved project could not be read safely.")
    return validate_document(json.loads(raw))


class ProjectStore:
    def __init__(self, table: Any):
        self.table = table

    @staticmethod
    def key(subject: str, case_id: str) -> dict[str, str]:
        if not subject or not isinstance(case_id, str) or not CASE_ID.fullmatch(case_id):
            raise ValueError("A valid project identifier is required.")
        return {"pk": f"saved-case#{subject}", "sk": f"case#{case_id}"}

    def _read(self, subject: str, case_id: str) -> dict[str, Any] | None:
        return self.table.get_item(Key=self.key(subject, case_id), ConsistentRead=True).get("Item")

    @staticmethod
    def response(item: dict[str, Any]) -> dict[str, Any]:
        if item.get("formatVersion") != 1:
            raise ValueError("This saved project uses a format this installation cannot read.")
        return {
            "caseId": item["sk"][len("case#"):],
            "revision": item["revision"],
            "savedAt": item["savedAt"],
            "title": item["title"],
            "document": decode_document(item["document"]),
        }

    def get(self, subject: str, case_id: str) -> dict[str, Any]:
        item = self._read(subject, case_id)
        if item and item.get("removedAt"):
            return {"project": None, "removed": True}
        return {"project": self.response(item) if item else None}

    @staticmethod
    def validate_revision(expected_revision: Any) -> None:
        if expected_revision is not None and (
            not isinstance(expected_revision, str) or not expected_revision
            or len(expected_revision) > 100
        ):
            raise ValueError("The saved revision is invalid.")

    def save(self, subject: str, case_id: str, document: dict[str, Any],
             expected_revision: str | None) -> dict[str, Any]:
        key = self.key(subject, case_id)
        self.validate_revision(expected_revision)
        encoded, content_hash = encode_document(document)
        form = document["form"]
        title = str(form.get("description") or form.get("modelName") or "Untitled project")
        title = " ".join(title.split())[:120]
        item = {
            **key, "revision": uuid.uuid4().hex,
            "savedAt": datetime.now(timezone.utc).isoformat(), "title": title,
            "document": encoded, "contentHash": content_hash, "formatVersion": 1,
        }
        request: dict[str, Any] = {
            "Item": item,
            "ConditionExpression": "attribute_not_exists(pk)",
        }
        if expected_revision is not None:
            request.update(
                ConditionExpression="#revision = :expected AND attribute_not_exists(removedAt)",
                ExpressionAttributeNames={"#revision": "revision"},
                ExpressionAttributeValues={":expected": expected_revision},
            )
        try:
            self.table.put_item(**request)
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            current = self._read(subject, case_id)
            if current and current.get("removedAt"):
                raise ProjectConflict(
                    "This project was removed from your list. Start a new project to keep your changes."
                ) from exc
            # A response may be lost after a successful write. Retrying identical
            # content is safe; retrying different content against an old revision is not.
            if current and current.get("contentHash") == content_hash:
                return {"project": self.response(current)}
            raise ProjectConflict(
                "A newer version of this project is saved. Your edits are still here. "
                "Download your draft before loading the saved version."
            ) from exc
        return {"project": self.response(item)}

    def remove(self, subject: str, case_id: str, expected_revision: str | None) -> dict[str, Any]:
        """Remove from the owner's project lists, retaining history and deployment records.

        A marker also covers browser-only drafts. It prevents stale devices or a
        concurrent save from silently bringing a removed project back. This operation
        never reads or changes the separate deployment/session partitions.
        """
        key = self.key(subject, case_id)
        self.validate_revision(expected_revision)
        current = self._read(subject, case_id)
        if current and current.get("removedAt"):
            return {"caseId": case_id, "removed": True}
        request: dict[str, Any] = {
            "Item": {
                **(current or key), "removedAt": datetime.now(timezone.utc).isoformat(),
                "revision": uuid.uuid4().hex,
            },
            "ConditionExpression": "attribute_not_exists(pk)",
        }
        if expected_revision is not None:
            request.update(
                ConditionExpression="#revision = :expected",
                ExpressionAttributeNames={"#revision": "revision"},
                ExpressionAttributeValues={":expected": expected_revision},
            )
        try:
            self.table.put_item(**request)
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            current = self._read(subject, case_id)
            if not current or not current.get("removedAt"):
                raise ProjectConflict(
                    "This project changed before it could be removed. Review it and try Remove again."
                ) from exc
        return {"caseId": case_id, "removed": True}

    def list(self, subject: str, after_case_id: str | None = None) -> dict[str, Any]:
        if not subject:
            raise ValueError("A signed-in user is required.")
        cursor = {"ExclusiveStartKey": self.key(subject, after_case_id)} if after_case_id is not None else {}
        result = self.table.query(
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={":pk": f"saved-case#{subject}", ":prefix": "case#"},
            ProjectionExpression="sk, title, savedAt, revision, removedAt",
            ConsistentRead=True,
            Limit=100,
            **cursor,
        )
        projects = [
            {"caseId": item["sk"][len("case#"):], "title": item["title"],
             "savedAt": item["savedAt"], "revision": item["revision"]}
            for item in result.get("Items", []) if not item.get("removedAt")
        ]
        removed_ids = [
            item["sk"][len("case#"):]
            for item in result.get("Items", []) if item.get("removedAt")
        ]
        last_key = result.get("LastEvaluatedKey")
        return {
            "projects": sorted(projects, key=lambda item: item["savedAt"], reverse=True),
            "removedCaseIds": removed_ids,
            "hasMore": bool(last_key),
            "nextCaseId": last_key["sk"][len("case#"):] if last_key else None,
        }
