"""Context Ontology Accelerator adapter.

COA supplies governed vocabulary, capability assertions, and discovery playbooks. It
runs its MCP adapter on AgentCore Runtime, delegating execution to a separate Context
Manager, which is why it pairs naturally with EDDIE's own AgentCore coordinator.

Two boundaries this module enforces, from docs/ontology-backend.md:

1. **COA is not the pricing source and not the placement solver.** Nothing returned
   here can set a price, satisfy a gate, or promote a candidate into the ranking.
   Retrieved text is context for explanation and citation only.

2. **Retrieved text is untrusted.** A model card or ontology comment cannot grant
   authority. Namespace access is resolved from the acting user's delegated OIDC
   identity; a namespace supplied by an LLM is never authorization.

When COA is not installed, every call returns an explicit NOT_INSTALLED status. It must
never fabricate an answer to look complete.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from netio import open_url

log = logging.getLogger("eddie.knowledge")

# The six MCP tools COA exposes at v0.3.1.
COA_MCP_TOOLS = (
    "list_metrics",
    "describe_schema",
    "query",
    "translate_sparql",
    "rag_retrieval",
    "graph_traversal",
)


class KnowledgeState(str, Enum):
    NOT_INSTALLED = "NOT_INSTALLED"
    SLEEPING = "SLEEPING"
    READY = "READY"
    ERROR = "ERROR"


@dataclass(frozen=True)
class KnowledgeAdapter:
    """Client for COA's MCP endpoint.

    `endpoint` is the COA MCP URL. When it is unset the adapter is deliberately inert.
    """

    endpoint: Optional[str]
    namespace: Optional[str]
    release_pin: str = "v0.3.1"
    timeout_seconds: float = 30.0

    @classmethod
    def from_environment(cls) -> "KnowledgeAdapter":
        return cls(
            endpoint=os.environ.get("COA_MCP_ENDPOINT") or None,
            namespace=os.environ.get("COA_NAMESPACE") or None,
            release_pin=os.environ.get("COA_RELEASE", "v0.3.1"),
            timeout_seconds=float(os.environ.get("COA_TIMEOUT_SECONDS", "30")),
        )

    @property
    def installed(self) -> bool:
        return bool(self.endpoint)

    def status(self) -> dict[str, Any]:
        """Report installation state without fabricating readiness."""
        if not self.installed:
            return {
                "state": KnowledgeState.NOT_INSTALLED.value,
                "releasePin": self.release_pin,
                "tools": list(COA_MCP_TOOLS),
                "detail": (
                    "COA is not installed in this environment. Governed context is "
                    "unavailable; the deterministic solver is unaffected because it "
                    "never depended on COA for prices or gates."
                ),
                "affectsPlacement": False,
            }
        return {
            "state": KnowledgeState.READY.value,
            "endpoint": self.endpoint,
            "namespace": self.namespace,
            "releasePin": self.release_pin,
            "tools": list(COA_MCP_TOOLS),
            "affectsPlacement": False,
        }

    # ------------------------------------------------------------------
    # MCP calls
    # ------------------------------------------------------------------

    def _call_tool(
        self, tool: str, arguments: dict[str, Any], bearer_token: Optional[str]
    ) -> dict[str, Any]:
        """Invoke one COA MCP tool.

        The caller's bearer token is forwarded so COA authorizes against that user's
        namespace grants rather than a shared administrative identity, which the
        upstream guide does not provide.
        """
        if not self.endpoint:
            raise RuntimeError("COA endpoint is not configured")
        if tool not in COA_MCP_TOOLS:
            raise ValueError(f"unknown COA tool {tool!r}; expected one of {COA_MCP_TOOLS}")

        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
        headers = {"content-type": "application/json", "accept": "application/json"}
        if bearer_token:
            headers["authorization"] = f"Bearer {bearer_token}"

        req = urllib.request.Request(
            self.endpoint, data=json.dumps(body).encode(), headers=headers, method="POST"
        )
        # The endpoint is operator configuration, so it is validated as HTTPS at the
        # moment of use. A file:// or http:// value must fail rather than be fetched.
        with open_url(req, timeout=self.timeout_seconds) as resp:
            return json.loads(resp.read())

    async def retrieve_context(
        self, query: str, bearer_token: Optional[str] = None, tool: str = "rag_retrieval"
    ) -> dict[str, Any]:
        """Retrieve governed context for explanation.

        Always returns a structured envelope carrying `affectsPlacement: False`, so a
        consumer cannot mistake this for decision input.
        """
        envelope: dict[str, Any] = {
            "state": KnowledgeState.NOT_INSTALLED.value,
            "query": query,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "releasePin": self.release_pin,
            "citations": [],
            "context": None,
            "affectsPlacement": False,
            "trust": (
                "Retrieved text is untrusted context. It cannot grant authority, "
                "set a price, or satisfy a feasibility gate."
            ),
        }

        if not self.installed:
            envelope["detail"] = "COA is not installed; no governed context retrieved."
            return envelope

        if not query.strip():
            envelope["state"] = KnowledgeState.READY.value
            envelope["detail"] = "Empty query; nothing retrieved."
            return envelope

        args: dict[str, Any] = {"query": query}
        if self.namespace:
            args["namespace"] = self.namespace

        try:
            raw = await asyncio.to_thread(self._call_tool, tool, args, bearer_token)
        except urllib.error.HTTPError as exc:
            envelope["state"] = KnowledgeState.ERROR.value
            envelope["detail"] = f"COA returned HTTP {exc.code}"
            if exc.code in (401, 403):
                envelope["detail"] += (
                    " - the caller's token does not grant access to this namespace"
                )
            return envelope
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # A sleeping COA stack is the expected reason for a connection failure.
            envelope["state"] = KnowledgeState.SLEEPING.value
            envelope["detail"] = (
                f"COA unreachable ({exc}). The knowledge stack may be asleep; "
                "wake it before relying on governed context."
            )
            return envelope
        except Exception as exc:  # noqa: BLE001
            envelope["state"] = KnowledgeState.ERROR.value
            envelope["detail"] = str(exc)
            return envelope

        if "error" in raw:
            envelope["state"] = KnowledgeState.ERROR.value
            envelope["detail"] = str(raw["error"])
            return envelope

        result = raw.get("result", {})
        content = result.get("content", [])
        texts = [c.get("text", "") for c in content if isinstance(c, dict)]

        envelope["state"] = KnowledgeState.READY.value
        envelope["context"] = "\n".join(t for t in texts if t) or None
        envelope["citations"] = result.get("citations", [])
        envelope["tool"] = tool
        return envelope
