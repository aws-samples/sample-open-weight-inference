"""Check the bundled inference guides and citations offline; no cloud calls."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

import yaml

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))
from knowledge.runbooks import ROOT, MAX_RESPONSE_CHARS, RunbookLibrary

LINK = re.compile(r"!?\[[^\]\n]*\]\(([^)\n]+)\)")
DIGEST = re.compile(r"[0-9a-f]{64}")


def validate(root: Path = ROOT) -> dict:
    """Fail on stale indexes, missing files, uncited sources or invalid metadata.

    Review deadlines are reported, never silently renewed. Digests detect an
    editorial/index mismatch; they are not a claim that a source is trustworthy.
    """
    library = RunbookLibrary(root)
    errors = []
    used_sources: set[str] = set()
    dates = []
    found = {p.parent.name for p in library.root.glob("*/SKILL.md")}
    expected = set(library.entries)
    if found != expected:
        errors.append("Catalogue and SKILL.md files differ: " + ", ".join(sorted(found ^ expected)))
    source_by_url = {s["url"]: key for key, s in library.sources.items()}
    if len(source_by_url) != len(library.sources):
        errors.append("A citation URL appears under multiple source IDs")
    largest_response = 0
    for identifier, entry in library.entries.items():
        path = library.root / identifier / "SKILL.md"
        try:
            response = library.read([identifier])
            text = response["runbooks"][0]["content"]
            parts = text.split("---", 2)
            if len(parts) != 3 or parts[0].strip():
                raise ValueError("Missing YAML frontmatter")
            frontmatter = yaml.safe_load(parts[1])
            if not isinstance(frontmatter, dict) or frontmatter.get("name") != identifier:
                raise ValueError("Frontmatter name must match the catalogue ID")
            description = frontmatter.get("description")
            if not isinstance(description, str) or not 1 <= len(description) <= 1024:
                raise ValueError("Skill description must be between 1 and 1024 characters")
            if len(text.splitlines()) > 500:
                raise ValueError("Move detailed material into references; SKILL.md must stay under 500 lines")
            if frontmatter.get("description") != entry["description"]:
                raise ValueError("Description differs from the searchable catalogue")
            if set(frontmatter) != {"name", "description"}:
                raise ValueError("Expected name and description in skill frontmatter")
            if not parts[2].lstrip().startswith("# " + entry["title"] + "\n"):
                raise ValueError("Title differs from the searchable catalogue")
            for key in ("tags", "questions", "sources"):
                if (not isinstance(entry[key], list) or not entry[key]
                        or any(not isinstance(v, str) or not v.strip() for v in entry[key])
                        or len(entry[key]) != len(set(entry[key]))):
                    raise ValueError(f"Invalid {key} metadata")
            reviewed = date.fromisoformat(entry["reviewedOn"])
            if reviewed > date.fromisoformat(entry["reviewAfter"]):
                raise ValueError("Review deadline precedes the review")
            cited = set()
            for target in LINK.findall(text):
                target = target.split(" ", 1)[0].strip("<>")
                if target.startswith("#"):
                    continue
                if urlsplit(target).scheme:
                    if target not in source_by_url:
                        raise ValueError("External link has no source registry entry: " + target)
                    cited.add(source_by_url[target])
                else:
                    destination = (path.parent / unquote(target).split("#", 1)[0]).resolve()
                    if not destination.is_relative_to(REPO) or not destination.is_file():
                        raise ValueError("Local reference is missing or outside the repository")
            if cited != set(entry["sources"]):
                raise ValueError("Citations differ from the catalogue source list")
            used_sources.update(cited)
            if response["runbooks"][0]["freshness"] == "REVIEW_DUE":
                dates.append(identifier)
            largest_response = max(largest_response, len(json.dumps(response, ensure_ascii=False)))
        except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError) as exc:
            errors.append(f"{identifier}: {exc}")
    if used_sources != set(library.sources):
        errors.append("Source registry contains uncited entries: " + ", ".join(sorted(set(library.sources) - used_sources)))
    for key, source in library.sources.items():
        try:
            for field in ("title", "publisher", "kind", "supports", "limitations"):
                if not isinstance(source.get(field), str) or not source[field].strip():
                    raise ValueError(f"Missing {field}")
            if not DIGEST.fullmatch(source.get("retrievedContentSha256", "")):
                raise ValueError("Missing retrieved-source digest")
            reviewed = date.fromisoformat(source["reviewedOn"])
            retrieved = date.fromisoformat(source["retrievedOn"])
            if retrieved > reviewed or reviewed > date.fromisoformat(source["reviewAfter"]):
                raise ValueError("Invalid retrieval/review dates")
        except (ValueError, KeyError, TypeError) as exc:
            errors.append(f"Source {key}: {exc}")
    if errors:
        raise ValueError("\n".join(errors))
    return {
        "version": library.catalog["version"], "runbooks": len(library.entries),
        "sources": len(library.sources),
        "stages": dict(Counter(e["stage"] for e in library.entries.values())),
        "reviewDue": dates, "largestSingleReadCharacters": largest_response,
        "responseCharacterLimit": MAX_RESPONSE_CHARS,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        print(json.dumps(validate(), indent=2))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"Runbook validation failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
