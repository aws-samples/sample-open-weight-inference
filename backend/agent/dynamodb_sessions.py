"""DynamoDB persistence for Strands' native RepositorySessionManager.

Only the storage contract is implemented here. Strands owns message/tool-result
serialization, history repair and SlidingWindowConversationManager state.

Every repository is bound to one verified user, authorized project, and case.
Writes are fenced by a conditional, expiring turn lease. A worker that resumes
after losing its lease cannot append messages or release another worker's lease.
Expiry is enforced on reads and writes; DynamoDB TTL is not an authorization check.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
import zlib
from dataclasses import dataclass
from typing import Any, Callable

from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError
from strands.session.session_repository import SessionRepository
from strands.types.session import Session, SessionAgent, SessionMessage

ID = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60
TURN_TIMEOUT_SECONDS = 180
LEASE_SECONDS = TURN_TIMEOUT_SECONDS + 30
MAX_RAW_BYTES = 4 * 1024 * 1024
MAX_STORED_BYTES = 300 * 1024
HISTORY_PAGE_SIZE = 50
_serialize = TypeSerializer()
_deserialize = TypeDeserializer()


class ConversationError(ValueError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code


class RecordedTurn(ConversationError):
    """An identical request already completed; return its receipt, never rerun."""

    def __init__(self, result: dict[str, Any]):
        super().__init__("turn_recorded", "This turn has already completed.")
        self.result = result


@dataclass(frozen=True)
class ConversationScope:
    subject: str
    project_id: str
    case_id: str

    def __post_init__(self):
        if not self.subject or not self.project_id or not ID.fullmatch(self.case_id):
            raise ConversationError("invalid_conversation", "A valid conversation is required.")

    @property
    def session_id(self) -> str:
        # Array encoding prevents ambiguous concatenations. Identifiers supplied
        # by the browser never become a DynamoDB partition or native session ID.
        raw = json.dumps([self.subject, self.project_id, self.case_id], separators=(",", ":"))
        return hashlib.sha256(raw.encode()).hexdigest()

    @property
    def partition(self) -> str:
        return f"advisor#{self.session_id}"


def _values(values: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize.serialize(value) for key, value in values.items()}


def _item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: _deserialize.deserialize(value) for key, value in item.items()}


def _pack(value: dict[str, Any]) -> bytes:
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    if len(raw) > MAX_RAW_BYTES:
        raise ConversationError("conversation_too_large", "This conversation item is too large to save.")
    result = zlib.compress(raw)
    if len(result) > MAX_STORED_BYTES:
        raise ConversationError("conversation_too_large", "This conversation item is too large to save.")
    return result


def _unpack(value: Any) -> dict[str, Any]:
    decoder = zlib.decompressobj()
    raw = decoder.decompress(bytes(value), MAX_RAW_BYTES + 1)
    if len(raw) > MAX_RAW_BYTES or not decoder.eof or decoder.unused_data:
        raise ConversationError("conversation_unreadable", "The saved conversation could not be read.")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ConversationError("conversation_unreadable", "The saved conversation could not be read.")
    return result


def _conditional_failure(exc: ClientError) -> bool:
    code = exc.response["Error"]["Code"]
    if code == "ConditionalCheckFailedException":
        return True
    return code == "TransactionCanceledException" and any(
        reason.get("Code") == "ConditionalCheckFailed"
        for reason in exc.response.get("CancellationReasons", [])
    )


class DynamoSessionRepository(SessionRepository):
    """A native Strands repository plus the application's admission boundary.

    Construct scope only after authentication and authorize_project(). The runtime
    role is limited to advisor#* keys in the existing encrypted CaseTable. No table
    scans, arbitrary session IDs, or caller-supplied ownership fields are accepted.
    """

    def __init__(self, client: Any, table_name: str, scope: ConversationScope,
                 *, clock: Callable[[], float] = time.time,
                 lifetime_seconds: int = SESSION_LIFETIME_SECONDS):
        self.client, self.table_name, self.scope = client, table_name, scope
        self.clock, self.lifetime_seconds = clock, lifetime_seconds
        self.lease_token: str | None = None
        self.turn_id: str | None = None
        self.turn_sequence: int | None = None
        self.expiry: int | None = None

    def _key(self, sort_key: str) -> dict[str, Any]:
        return _values({"pk": self.scope.partition, "sk": sort_key})

    def _read(self, sort_key: str) -> dict[str, Any] | None:
        result = self.client.get_item(TableName=self.table_name, Key=self._key(sort_key),
                                      ConsistentRead=True).get("Item")
        return _item(result) if result else None

    def _control(self, *, create: bool = False) -> dict[str, Any] | None:
        control = self._read("control")
        now = int(self.clock())
        if control is None and create:
            control = {"pk": self.scope.partition, "sk": "control",
                       "sessionExpiresAt": now + self.lifetime_seconds, "schemaVersion": 1}
            try:
                self.client.put_item(TableName=self.table_name, Item=_values(control),
                                     ConditionExpression="attribute_not_exists(pk)")
            except ClientError as exc:
                if not _conditional_failure(exc):
                    raise
                control = self._read("control")
        if control is not None:
            if control["sessionExpiresAt"] <= now:
                raise ConversationError(
                    "conversation_expired",
                    "This Advisor conversation has expired. Start a new conversation; your saved project is separate.",
                )
            self.expiry = int(control["sessionExpiresAt"])
        return control

    def acquire(self, turn_id: str, request_hash: str, prompt: str) -> None:
        if not isinstance(turn_id, str) or not ID.fullmatch(turn_id):
            raise ConversationError("invalid_turn", "A unique turn identifier is required.")
        control = self._control(create=True)
        previous_sequence = int(control.get("turnSequence", 0))
        sequence = previous_sequence + 1
        now = int(self.clock())
        token = uuid.uuid4().hex
        receipt = {"pk": self.scope.partition, "sk": f"turn#{turn_id}",
                   "requestHash": request_hash, "status": "RUNNING",
                   "startedAt": now, "sequence": sequence, "sessionExpiresAt": self.expiry,
                   "data": _pack({"prompt": prompt})}
        display = self._display_item(receipt)
        try:
            self.client.transact_write_items(TransactItems=[
                {"Update": {
                    "TableName": self.table_name, "Key": self._key("control"),
                    "UpdateExpression": "SET leaseToken = :token, leaseUntil = :until, activeTurn = :turn, cancelRequested = :no, turnSequence = :sequence",
                    "ConditionExpression": "sessionExpiresAt > :now AND (attribute_not_exists(leaseToken) OR leaseUntil <= :now) AND (attribute_not_exists(turnSequence) OR turnSequence = :previous)",
                    "ExpressionAttributeValues": _values({
                        ":token": token, ":until": now + LEASE_SECONDS, ":turn": turn_id,
                        ":now": now, ":no": False, ":sequence": sequence, ":previous": previous_sequence,
                    }),
                }},
                {"Put": {"TableName": self.table_name, "Item": _values(receipt),
                         "ConditionExpression": "attribute_not_exists(pk)"}},
                {"Put": {"TableName": self.table_name, "Item": _values(display),
                         "ConditionExpression": "attribute_not_exists(pk)"}},
            ])
        except ClientError as exc:
            if not _conditional_failure(exc):
                raise
            existing = self._read(f"turn#{turn_id}")
            if existing:
                if existing["requestHash"] != request_hash:
                    raise ConversationError("turn_conflict", "This turn identifier was already used for a different request.") from exc
                if existing["status"] != "RUNNING":
                    raise RecordedTurn(_unpack(existing["data"])["result"]) from exc
                raise ConversationError(
                    "turn_in_progress",
                    "This turn already started. Restore the conversation to check it; EDDIE will not run it twice.",
                ) from exc
            self._control()  # Distinguish expiry, without revealing another scope.
            raise ConversationError(
                "conversation_busy",
                "Another answer is still running in this conversation. Wait for it to finish or stop it first.",
            ) from exc
        self.lease_token, self.turn_id = token, turn_id
        self.turn_sequence = sequence

    def _fence(self) -> dict[str, Any]:
        if not self.lease_token:
            raise ConversationError("turn_not_active", "There is no active turn for this write.")
        return {
            "TableName": self.table_name, "Key": self._key("control"),
            "ConditionExpression": "leaseToken = :token AND leaseUntil > :now AND sessionExpiresAt > :now",
            "ExpressionAttributeValues": _values({":token": self.lease_token, ":now": int(self.clock())}),
        }

    def check_active(self) -> bool:
        """Return a stop request, or refuse an expired/superseded worker."""
        control = self._control()
        if not control or control.get("leaseToken") != self.lease_token or control.get("leaseUntil", 0) <= self.clock():
            raise ConversationError("turn_lease_lost", "This turn is no longer active. Restore the conversation before continuing.")
        return control.get("cancelRequested") is True

    def request_cancel(self, turn_id: str) -> dict[str, Any]:
        if not isinstance(turn_id, str) or not ID.fullmatch(turn_id):
            raise ConversationError("invalid_turn", "A valid turn identifier is required.")
        self._control()
        try:
            self.client.update_item(
                TableName=self.table_name, Key=self._key("control"),
                UpdateExpression="SET cancelRequested = :yes",
                ConditionExpression="activeTurn = :turn AND leaseUntil > :now AND sessionExpiresAt > :now",
                ExpressionAttributeValues=_values({":yes": True, ":turn": turn_id, ":now": int(self.clock())}),
            )
            return {"requested": True, "detail": "Stop requested. An operation already in progress may take a moment to finish."}
        except ClientError as exc:
            if not _conditional_failure(exc):
                raise
            # Same response for absent and completed turns. Never reveals an owner.
            return {"requested": False, "detail": "No active matching turn was found."}

    def finish(self, result: dict[str, Any], *, status: str) -> None:
        if status not in {"COMPLETE", "CANCELLED", "FAILED"}:
            raise ValueError("Invalid turn status.")
        receipt = self._read(f"turn#{self.turn_id}")
        if not receipt:
            raise ConversationError("turn_not_active", "The active turn could not be found.")
        receipt.update(status=status, finishedAt=int(self.clock()),
                       data=_pack({**_unpack(receipt["data"]), "result": result}))
        update = self._fence()
        update["UpdateExpression"] = "REMOVE leaseToken, leaseUntil, activeTurn, cancelRequested"
        try:
            self.client.transact_write_items(TransactItems=[
                {"Update": update},
                {"Put": {"TableName": self.table_name, "Item": _values(receipt)}},
                {"Put": {"TableName": self.table_name, "Item": _values(self._display_item(receipt))}},
            ])
        except ClientError as exc:
            if _conditional_failure(exc):
                raise ConversationError("turn_lease_lost", "This turn lost its write lease. Its answer was not marked complete.") from exc
            raise
        self.lease_token = None

    def _display_item(self, receipt: dict[str, Any]) -> dict[str, Any]:
        """A bounded, ordered display record; full native messages stay separate."""
        data = _unpack(receipt["data"])
        result = data.get("result", {})
        return {
            "pk": self.scope.partition, "sk": f"display#{int(receipt['sequence']):012d}",
            "sequence": receipt["sequence"], "turnId": receipt["sk"][5:],
            "startedAt": receipt["startedAt"], "status": receipt["status"],
            "sessionExpiresAt": receipt["sessionExpiresAt"],
            "data": _pack({
                "prompt": data["prompt"], "reply": result.get("reply"),
                "casePatch": result.get("casePatch", {}),
                "advisorModelId": result.get("advisorModelId"),
                # A bounded source receipt only, never MCP excerpts or tool inputs.
                "awsDocumentation": result.get("awsDocumentation"),
            }),
        }

    def history(self, before_sequence: int | None = None) -> dict[str, Any]:
        if before_sequence is not None and (
            type(before_sequence) is not int or not 1 <= before_sequence < 10**12
        ):
            raise ConversationError("invalid_history_page", "The conversation page is invalid.")
        control = self._control()
        if not control:
            return {"turns": [], "activeTurnId": None, "expiresAt": None, "nextBeforeSequence": None}
        # Return display receipts, never raw model messages or tool arguments.
        upper = (before_sequence - 1) if before_sequence is not None else 10**12 - 1
        items = self._query("display#000000000001", f"display#{upper:012d}",
                            HISTORY_PAGE_SIZE + 1, forward=False) if upper >= 1 else []
        has_more = len(items) > HISTORY_PAGE_SIZE
        items = items[:HISTORY_PAGE_SIZE]
        turns = []
        for item in reversed(items):
            data = _unpack(item["data"])
            is_active = (control.get("activeTurn") == item["turnId"]
                         and control.get("leaseUntil", 0) > self.clock())
            turns.append({
                "turnId": item["turnId"], "sequence": int(item["sequence"]), "prompt": data["prompt"],
                "reply": data.get("reply"), "startedAt": int(item["startedAt"]),
                "status": item["status"] if item["status"] != "RUNNING" or is_active else "INTERRUPTED",
                "casePatch": data.get("casePatch", {}),
                "advisorModelId": data.get("advisorModelId"),
                "awsDocumentation": data.get("awsDocumentation"),
            })
        return {"turns": turns, "activeTurnId": control.get("activeTurn")
                if control.get("leaseUntil", 0) > self.clock() else None,
                "expiresAt": self.expiry,
                "nextBeforeSequence": int(items[-1]["sequence"]) if has_more else None}

    def _assert_session(self, session_id: str, agent_id: str | None = None) -> None:
        if session_id != self.scope.session_id or (agent_id is not None and agent_id != "advisor"):
            raise ConversationError("conversation_forbidden", "Access restricted to your conversation.")
        if self._control() is None:
            raise ConversationError("conversation_missing", "The conversation has not been started.")

    def _write_native(self, sort_key: str, value: dict[str, Any], *, create: bool = False) -> None:
        item = {"pk": self.scope.partition, "sk": sort_key,
                "sessionExpiresAt": self.expiry, "data": _pack(value)}
        put: dict[str, Any] = {"TableName": self.table_name, "Item": _values(item)}
        if create:
            put["ConditionExpression"] = "attribute_not_exists(pk)"
        try:
            self.client.transact_write_items(TransactItems=[
                {"ConditionCheck": self._fence()}, {"Put": put},
            ])
        except ClientError as exc:
            if _conditional_failure(exc):
                raise ConversationError("session_write_conflict", "The conversation changed before this message could be saved.") from exc
            raise

    def _query(self, lower: str, upper: str, limit: int | None = None,
               *, forward: bool = True) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        request = {
            "TableName": self.table_name, "ConsistentRead": True, "ScanIndexForward": forward,
            "KeyConditionExpression": "pk = :pk AND sk BETWEEN :lo AND :hi",
            "ExpressionAttributeValues": _values({":pk": self.scope.partition, ":lo": lower, ":hi": upper}),
        }
        while limit is None or len(items) < limit:
            if limit is not None:
                request["Limit"] = limit - len(items)
            response = self.client.query(**request)
            items.extend(_item(item) for item in response.get("Items", []))
            if not response.get("LastEvaluatedKey"):
                break
            request["ExclusiveStartKey"] = response["LastEvaluatedKey"]
        return items

    def create_session(self, session: Session, **kwargs: Any) -> Session:
        self._assert_session(session.session_id)
        self._write_native("native#session", session.to_dict(), create=True)
        return session

    def read_session(self, session_id: str, **kwargs: Any) -> Session | None:
        self._assert_session(session_id)
        item = self._read("native#session")
        return Session.from_dict(_unpack(item["data"])) if item else None

    def create_agent(self, session_id: str, session_agent: SessionAgent, **kwargs: Any) -> None:
        self._assert_session(session_id, session_agent.agent_id)
        self._write_native("native#agent#advisor", session_agent.to_dict(), create=True)

    def read_agent(self, session_id: str, agent_id: str, **kwargs: Any) -> SessionAgent | None:
        self._assert_session(session_id, agent_id)
        item = self._read("native#agent#advisor")
        return SessionAgent.from_dict(_unpack(item["data"])) if item else None

    def update_agent(self, session_id: str, session_agent: SessionAgent, **kwargs: Any) -> None:
        self._assert_session(session_id, session_agent.agent_id)
        self._write_native("native#agent#advisor", session_agent.to_dict())

    @staticmethod
    def _message_key(message_id: int) -> str:
        if not isinstance(message_id, int) or not 0 <= message_id < 10**12:
            raise ValueError("Invalid message index.")
        return f"native#message#advisor#{message_id:012d}"

    def create_message(self, session_id: str, agent_id: str, session_message: SessionMessage, **kwargs: Any) -> None:
        self._assert_session(session_id, agent_id)
        self._write_native(self._message_key(session_message.message_id), session_message.to_dict(), create=True)

    def read_message(self, session_id: str, agent_id: str, message_id: int, **kwargs: Any) -> SessionMessage | None:
        self._assert_session(session_id, agent_id)
        item = self._read(self._message_key(message_id))
        return SessionMessage.from_dict(_unpack(item["data"])) if item else None

    def update_message(self, session_id: str, agent_id: str, session_message: SessionMessage, **kwargs: Any) -> None:
        self._assert_session(session_id, agent_id)
        self._write_native(self._message_key(session_message.message_id), session_message.to_dict())

    def list_messages(self, session_id: str, agent_id: str, limit: int | None = None,
                      offset: int = 0, **kwargs: Any) -> list[SessionMessage]:
        self._assert_session(session_id, agent_id)
        if limit is not None and limit < 0:
            raise ValueError("Invalid message limit.")
        items = self._query(self._message_key(offset), self._message_key(10**12 - 1), limit)
        return [SessionMessage.from_dict(_unpack(item["data"])) for item in items]
