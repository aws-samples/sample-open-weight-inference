"""Bounded, offline retrieval of the inference runbooks shipped with EDᗡIE.

No query leaves this process. Documents are guidance; neither this module nor its
results can modify projects, prices, gate evidence or deployment authorization.
"""
from __future__ import annotations

from collections import Counter
from datetime import date
from functools import lru_cache
from hashlib import sha256
import json
import math
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).with_name("skills")
STAGES = ("qualify", "evaluate", "route", "size", "optimize", "cost", "capacity", "operate")
MAX_QUERY = 1200
MAX_DOCUMENTS = 3
MAX_BODY_BYTES = 12_000
MAX_RESPONSE_CHARS = 48_000
_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = frozenset(
    "a an and are as at be by can do does for from how i in is it me my of on or our "
    "please should the their this to use using want we what when which with would".split()
)


def _tokens(text: str) -> list[str]:
    return [word for word in _TOKEN.findall(text.lower()) if word not in _STOP]


def _read_file(root: Path, relative: str, limit: int) -> str:
    """All names originate in the bundled catalogue, never a caller's path."""
    path = root / relative
    if path.resolve() != path or not path.is_file() or path.stat().st_size > limit:
        raise ValueError("The bundled runbook library is incomplete or invalid.")
    return path.read_text(encoding="utf-8")


class RunbookLibrary:
    def __init__(self, root: Path = ROOT) -> None:
        self.root = root.resolve(strict=True)
        self.catalog = json.loads(_read_file(self.root, "catalog.json", 256_000))
        self.sources = json.loads(_read_file(self.root, "sources.json", 256_000))
        self.contract = _read_file(self.root, "references/decision-contract.md", 8_000)
        if sha256(self.contract.encode("utf-8")).hexdigest() != self.catalog.get("contractSha256"):
            raise ValueError("Runbook decision contract changed; validate its catalogue.")
        entries = self.catalog.get("runbooks", [])
        if self.catalog.get("format") != 1 or not 1 <= len(entries) <= 100:
            raise ValueError("Unsupported runbook catalogue.")
        self.entries: dict[str, dict[str, Any]] = {}
        self.documents: dict[str, Counter[str]] = {}
        self.frequency: Counter[str] = Counter()
        for entry in entries:
            identifier = entry.get("id", "")
            if (not isinstance(identifier, str) or not _ID.fullmatch(identifier)
                    or len(identifier) > 64 or identifier in self.entries
                    or entry.get("stage") not in STAGES
                    or not entry.get("sources")
                    or any(source not in self.sources for source in entry["sources"])):
                raise ValueError("Invalid runbook catalogue entry.")
            date.fromisoformat(entry["reviewAfter"])
            if not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256", "")):
                raise ValueError("Runbook content requires a digest.")
            # Keep bodies off the model context until it explicitly reads a result.
            text = " ".join([
                entry["title"], entry["description"], " ".join(entry["tags"]),
                " ".join(entry["questions"]), identifier.replace("-", " "),
            ])
            counts = Counter(_tokens(text))
            self.documents[identifier] = counts
            self.frequency.update(counts.keys())
            self.entries[identifier] = entry
        for source in self.sources.values():
            url = urlsplit(source["url"])
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.port not in (None, 443)
                    or source.get("visibility") != "public"):
                raise ValueError("Runbook citations require public HTTPS sources.")
            date.fromisoformat(source["reviewedOn"])
            date.fromisoformat(source["reviewAfter"])

    def _summary(self, entry: dict[str, Any], today: date) -> dict[str, Any]:
        overdue = today > date.fromisoformat(entry["reviewAfter"]) or any(
            today > date.fromisoformat(self.sources[key]["reviewAfter"])
            for key in entry["sources"]
        )
        return {
            "id": entry["id"], "title": entry["title"],
            "description": entry["description"], "stage": entry["stage"],
            "reviewedOn": entry["reviewedOn"], "reviewAfter": entry["reviewAfter"],
            "freshness": "REVIEW_DUE" if overdue else "WITHIN_REVIEW_WINDOW",
        }

    def search(self, query: str, stage: str | None = None, limit: int = 5,
               *, today: date | None = None) -> dict[str, Any]:
        if not isinstance(query, str) or len(query) > MAX_QUERY:
            raise ValueError(f"Use a search query of at most {MAX_QUERY} characters.")
        if stage is not None and stage not in STAGES:
            raise ValueError("Choose a documented inference stage.")
        if type(limit) is not int or not 1 <= limit <= 8:
            raise ValueError("Search returns between one and eight runbooks.")
        words = set(_tokens(query))
        today = today or date.today()
        scored = []
        total = len(self.entries)
        average_length = sum(sum(c.values()) for c in self.documents.values()) / total
        for identifier, entry in self.entries.items():
            if stage is not None and entry["stage"] != stage:
                continue
            counts = self.documents[identifier]
            score = 0.0
            for word in words:
                frequency = counts[word]
                if frequency:
                    inverse_frequency = math.log(1 + (total - self.frequency[word] + 0.5)
                                                 / (self.frequency[word] + 0.5))
                    length = sum(counts.values()) / average_length
                    score += inverse_frequency * frequency * 2.2 / (
                        frequency + 1.2 * (0.25 + 0.75 * length))
            if query.strip() == identifier:
                score += 100
            if score > 0 or (not words and stage is not None):
                scored.append((score, identifier, entry))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return {
            "state": "READY", "libraryVersion": self.catalog["version"],
            "affectsPlacement": False, "trust": "guidance",
            "matches": [self._summary(entry, today) for _, _, entry in scored[:limit]],
            "detail": (
                "Read the relevant runbooks for decision checks and sources. "
                "Search relevance is not a model or hosting recommendation."
                if scored else "No matching runbook. Refine the workload or decision; do not infer support."
            ),
        }

    def read(self, identifiers: list[str], *, today: date | None = None) -> dict[str, Any]:
        if (not isinstance(identifiers, list) or not 1 <= len(identifiers) <= MAX_DOCUMENTS
                or any(not isinstance(key, str) or key not in self.entries for key in identifiers)
                or len(set(identifiers)) != len(identifiers)):
            # Never echo a supplied path or enumerate documents on an invalid read.
            raise ValueError("Read one to three distinct IDs returned by runbook search.")
        today = today or date.today()
        documents = []
        source_ids: set[str] = set()
        for identifier in identifiers:
            entry = self.entries[identifier]
            body = _read_file(self.root, f"{identifier}/SKILL.md", MAX_BODY_BYTES)
            if sha256(body.encode("utf-8")).hexdigest() != entry["sha256"]:
                raise ValueError("Runbook content changed; rebuild and validate its catalogue.")
            documents.append({**self._summary(entry, today), "content": body})
            source_ids.update(entry["sources"])
        response = {
            "state": "READY", "libraryVersion": self.catalog["version"],
            "affectsPlacement": False, "trust": "guidance",
            "contract": self.contract, "runbooks": documents,
            "citations": [{"id": key, **self.sources[key]} for key in sorted(source_ids)],
            "detail": (
                "Use as explanatory guidance. Dates track editorial review, not live AWS verification. "
                "Recheck dynamic support and use application tools for numerical or gate decisions."
            ),
        }
        if len(json.dumps(response, ensure_ascii=False)) > MAX_RESPONSE_CHARS:
            raise ValueError("Read fewer runbooks to keep context bounded.")
        return response


@lru_cache(maxsize=1)
def library() -> RunbookLibrary:
    return RunbookLibrary()


def find_runbooks(args: dict[str, Any]) -> dict[str, Any]:
    return library().search(args.get("query", ""), args.get("stage"), args.get("limit", 5))


def read_runbooks(args: dict[str, Any]) -> dict[str, Any]:
    return library().read(args.get("ids", []))
