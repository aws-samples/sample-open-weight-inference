"""Reviewed published speech bundle: NVIDIA Magpie TTS v2607 with its GGUF runtime assets.

A bundle is accepted only when every file matches the pinned recipe exactly. It is a
published, unmodified model; there is no training lineage to supply or verify.
The weights run in NeMo-Speech.cpp on CPU. They are not a Hugging Face Transformers
checkpoint, so no Safetensors, LLM context or KV-cache facts are derived from them.
"""
from __future__ import annotations

import hashlib
import json
import re
import tarfile
from decimal import Decimal
from pathlib import Path, PurePosixPath
from typing import Any

BUNDLE = json.loads((Path(__file__).with_name("magpie-v2607.json")).read_text())
ARTIFACT_FORMAT = "gguf-speech-bundle"
BUNDLE_FILES = {item["name"]: item for item in BUNDLE["files"]}
BUNDLE_BYTES = sum(item["size"] for item in BUNDLE["files"])
#: The compressed archive is smaller than the files; bound both before reading.
MAX_ARCHIVE_BYTES = 800 * 1024**2
HEX = re.compile(r"[0-9a-f]{64}")
SPEECH_RECIPE_ID = "sagemaker-magpie-cpu"
SPEECH_RECIPE_VERSION = "1.0.1"
#: Graviton2, 4 vCPU and 16 GiB: the image is linux/arm64 and one request runs at a time.
#: Its default endpoint quota is 1 in new accounts, unlike the newer c7g sizes (0).
SPEECH_INSTANCE_TYPE = "ml.m6g.xlarge"
SPEECH_QUOTA_CODE = "L-2D2AAC6C"
SPEECH_SPEAKERS = tuple(BUNDLE["speakers"])
#: About 13 seconds of audio: measured synthesis on ml.m6g.xlarge ran at 3.2x the audio
#: length, and SageMaker real-time responses must finish within 60 seconds.
SPEECH_MAX_TEXT = 200
SPEECH_MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def speech_environment() -> dict[str, str]:
    # Below the 60-second SageMaker real-time response limit, so a stopped request
    # reports its own reason rather than an opaque timeout.
    return {"EDDIE_SPEECH_DEADLINE_SECONDS": "55"}


def library_document(name: str | None = None) -> dict[str, Any]:
    """The library manifest without S3 versions, built from the pinned recipe only."""
    return {
        "schemaVersion": 1, "name": name or BUNDLE["name"],
        "artifactFormat": ARTIFACT_FORMAT, "customization": "published",
        "bundle": BUNDLE["id"], "upstream": BUNDLE["upstream"],
        "runtime": BUNDLE["runtime"], "license": BUNDLE["license"],
        "files": [{k: item[k] for k in ("name", "size", "sha256")} for item in BUNDLE["files"]],
    }


def is_speech_manifest(document: dict[str, Any]) -> bool:
    return document.get("artifactFormat") == ARTIFACT_FORMAT


def validate_speech_manifest(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Exact match to the reviewed bundle; a different file is a different recipe."""
    if type(document.get("schemaVersion")) is not int or document["schemaVersion"] != 1:
        raise ValueError("Unsupported speech bundle manifest version.")
    if document.get("customization") != "published":
        raise ValueError("This speech recipe serves the published model unchanged; a fine-tune needs its own recipe.")
    name = document.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise ValueError("The speech bundle needs a short, non-empty display name.")
    expected = library_document(name)
    for key in ("bundle", "upstream", "runtime", "license"):
        if document.get(key) != expected[key]:
            raise ValueError(f"The speech bundle's {key} does not match the reviewed Magpie v2607 recipe.")
    files = document.get("files")
    if not isinstance(files, list) or len(files) != len(BUNDLE_FILES):
        raise ValueError("The speech bundle must include the reviewed model, codec, tokenizer and licence files. Republish an older bundle with the current packaging script.")
    seen = set()
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("Invalid speech bundle file entry.")
        pinned = BUNDLE_FILES.get(item.get("name"))
        if (pinned is None or item["name"] in seen or item.get("size") != pinned["size"]
                or item.get("sha256") != pinned["sha256"]):
            raise ValueError("A speech bundle file does not match the reviewed recipe.")
        seen.add(item["name"])
        version = item.get("versionId")
        if not isinstance(version, str) or not 1 <= len(version) <= 1024 or version == "null":
            raise ValueError("Every speech bundle file requires an immutable S3 version.")
    return files


def inspect_speech(document: dict[str, Any], files: list[dict[str, Any]], *, source: str,
                   revision: str, manifest_version: str, prefix: str) -> dict[str, Any]:
    by_role: dict[str, int] = {}
    for item in BUNDLE["files"]:
        by_role[item["role"]] = by_role.get(item["role"], 0) + item["size"]
    return {
        "source": source, "sourceKind": "checkpoint", "revision": revision,
        "manifestVersionId": manifest_version, "name": document["name"],
        "files": [{**item, "key": prefix + item["name"], "digest": item["sha256"], "algorithm": "sha256"}
                  for item in files],
        "bytes": BUNDLE_BYTES, "weightBytes": by_role["tts"] + by_role["codec"],
        "architecture": BUNDLE["architecture"], "modality": BUNDLE["modality"],
        "precision": BUNDLE["precision"],
        "storedTensorElements": BUNDLE["storedTensorElements"],
        "componentBytes": by_role,
        "weightsGb": str((Decimal(by_role["tts"] + by_role["codec"]) / 1024**3).quantize(Decimal("0.001"))),
        "license": document["license"]["id"], "licenseUrl": document["license"]["url"],
        "artifactFormat": ARTIFACT_FORMAT, "customization": "published",
        "upstream": document["upstream"], "runtime": document["runtime"],
        "baseModel": {"source": document["upstream"][0]["source"],
                      "revision": document["upstream"][0]["revision"]},
        "lineage": None, "lineageStatus": "NOT_APPLICABLE", "fullContentVerified": False,
        "recipeId": SPEECH_RECIPE_ID, "recipeVersion": SPEECH_RECIPE_VERSION,
    }


def speech_inspection_result(metadata: dict[str, Any]) -> dict[str, Any]:
    from .models import _iso, _now
    detail = "Read from the pinned speech bundle manifest; every file matches the reviewed recipe."
    params = Decimal(metadata["storedTensorElements"]) / 1_000_000_000
    fields = {
        "architecture": {"origin": "DETECTED", "value": metadata["architecture"], "sourceUrl": None,
                         "detail": "GGUF architecture of the Magpie model file (NeMo-Speech.cpp runtime)."},
        "modality": {"origin": "DETECTED", "value": metadata["modality"], "sourceUrl": None,
                     "detail": "Text-to-speech: text in, 22,050 Hz mono audio out."},
        "totalParamsB": {"origin": "DETECTED", "value": str(params.quantize(Decimal("0.001"))), "sourceUrl": None,
                         "detail": "Stored tensor elements in the Magpie GGUF file, not the marketed 357M figure."},
        "contextTokens": {"origin": "NOT_APPLICABLE", "value": None, "sourceUrl": None,
                          "detail": "A speech model has no chat context window; the recipe bounds input text instead."},
        "weightsGb": {"origin": "DETECTED", "value": metadata["weightsGb"], "sourceUrl": None,
                      "detail": "Magpie F16 GGUF plus the required Nano Codec decoder; tokenizer files are listed separately."},
        "precision": {"origin": "DETECTED", "value": metadata["precision"], "sourceUrl": None, "detail": detail},
        "licenseId": {"origin": "DETECTED", "value": metadata["license"], "sourceUrl": metadata["licenseUrl"],
                      "detail": "Upstream terms for the model and codec; review them before deployment."},
    }
    return {
        "ok": True, "error": None, "source": metadata["source"], "repo": metadata["source"],
        "revision": metadata["revision"], "retrievedAt": _iso(_now()),
        "access": "PRIVATE", "accessDetail": "Read from your authorized private model library.",
        "fields": fields, "weightFiles": 2,
        "notes": ["Published model, unchanged: there is no training lineage.",
                  "GGUF weights need the NeMo-Speech.cpp runtime. Transformers, vLLM and Bedrock "
                  "Custom Model Import do not load this artifact.",
                  "Full file checksums are verified during preparation before deployment."],
        "checkpoint": {k: metadata[k] for k in (
            "source", "name", "revision", "manifestVersionId", "artifactFormat",
            "customization", "baseModel", "lineage", "lineageStatus", "fullContentVerified",
            "upstream", "runtime", "componentBytes",
        )},
    }


def verify_file(path: Path, item: dict[str, Any]) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size != item["size"]:
        raise ValueError(f"Speech bundle file is missing or incomplete: {item['name']}")
    with path.open("rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != item["sha256"]:
            raise ValueError(f"Speech bundle file failed verification: {item['name']}")


def extract_bundle(archive: Path, destination: Path) -> None:
    """Extract exactly the pinned files from a tar.gz; never follow links or extra paths."""
    if not 0 < archive.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise ValueError("The speech bundle archive is outside its size limit.")
    destination.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            name = member.name
            parts = PurePosixPath(name).parts
            pinned = BUNDLE_FILES.get(name)
            if member.isdir() and name == "tokenizer":
                continue
            if (pinned is None or name in seen or not member.isreg() or name.startswith("/")
                    or ".." in parts or member.size != pinned["size"]):
                raise ValueError("The speech bundle archive contains an unexpected or unsafe entry.")
            seen.add(name)
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            incoming = source.extractfile(member)
            sha, size = hashlib.sha256(), 0
            with incoming, target.open("xb") as outgoing:
                while chunk := incoming.read(4 * 1024 * 1024):
                    size += len(chunk)
                    if size > pinned["size"]:
                        raise ValueError("A speech bundle entry is larger than its manifest.")
                    sha.update(chunk)
                    outgoing.write(chunk)
            if size != pinned["size"] or sha.hexdigest() != pinned["sha256"]:
                raise ValueError(f"Speech bundle file failed verification: {name}")
    if seen != set(BUNDLE_FILES):
        raise ValueError("The speech bundle archive is missing reviewed files.")
