"""Inspect operator-published, version-pinned fine-tuned checkpoints in private S3.

The caller selects a manifest, not an arbitrary bucket, role, container or URL.
Only this installation's shared library and the authenticated project's namespace
are readable. The application cannot publish into either namespace.

Inspection reads configuration and Safetensors headers. Full content hashes are
verified by the artifact stager before the SageMaker serving runtime sees the files.
Training lineage is supplied information, never proof of model quality.
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from .recipes import digest

CHECKPOINT_RECIPE_ID = "byo-qwen2-safetensors"
CHECKPOINT_RECIPE_VERSION = "1.0.0"
CHECKPOINT_MAX_BYTES = 18 * 1024**3
CHECKPOINT_MAX_FILE_BYTES = 5 * 1024**3 - 1
MAX_MANIFEST_BYTES = 128 * 1024
MAX_CONFIG_BYTES = 2 * 1024**2
MAX_HEADER_BYTES = 8 * 1024**2
MAX_FILES = 32
HEX = re.compile(r"[0-9a-f]{64}")
FILE_NAMES = frozenset({
    "config.json", "generation_config.json", "tokenizer.json",
    "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json",
    "vocab.json", "merges.txt", "model.safetensors", "model.safetensors.index.json",
    "LICENSE", "LICENSE.txt",
})
SHARD = re.compile(r"model-\d{5}-of-\d{5}\.safetensors")
SOURCE_DOC = "https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html"


def project_namespace(project: str) -> str:
    return hashlib.sha256(project.encode()).hexdigest()


def checkpoint_root(settings: Any) -> str:
    if not re.fullmatch(r"[a-z0-9-]{1,24}", settings.environment):
        raise ValueError("This installation's checkpoint namespace is not configured.")
    return f"checkpoints/eddie-{settings.environment}/"


def location(source: Any, settings: Any, project: str) -> tuple[str, str]:
    """Resolve a permitted manifest before making any AWS request."""
    if not isinstance(source, str) or len(source) > 1024:
        raise ValueError("Choose a checkpoint manifest from this installation's model library.")
    parsed = urlsplit(source)
    key = parsed.path.removeprefix("/")
    root = re.escape(checkpoint_root(settings))
    scope = rf"(?:shared|{project_namespace(project)})"
    shape = root + scope + r"/[a-z0-9][a-z0-9-]{0,62}/[0-9a-f]{64}/manifest\.json"
    if (parsed.scheme != "s3" or parsed.netloc != settings.bucket
            or parsed.query or parsed.fragment or not re.fullmatch(shape, key)):
        raise ValueError("This checkpoint is not in your project's library or the installation's shared library.")
    return parsed.netloc, key


def _body(response: dict[str, Any], maximum: int) -> bytes:
    stream = response["Body"]
    try:
        raw = stream.read(maximum + 1)
    finally:
        stream.close()
    if len(raw) > maximum:
        raise ValueError("A checkpoint metadata file exceeds its size limit.")
    return raw


def _json(raw: bytes) -> dict[str, Any]:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Checkpoint JSON contains a duplicate key.")
            result[key] = value
        return result
    result = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(result, dict):
        raise ValueError("Checkpoint metadata must be a JSON object.")
    return result


def validate_manifest(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Static contract also used by the operator's publication command."""
    if type(document.get("schemaVersion")) is not int or document["schemaVersion"] != 1:
        raise ValueError("Unsupported checkpoint manifest version.")
    if document.get("artifactFormat") not in ("full-checkpoint", "merged-checkpoint"):
        raise ValueError(
            "A complete checkpoint is required. An adapter-only LoRA export must first "
            "be merged with its exact base revision and exported as Safetensors."
        )
    if document.get("customization") != "fine-tuned":
        raise ValueError("Use the published-model path for an unchanged base model.")
    name = document.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise ValueError("The checkpoint needs a short, non-empty display name.")
    base = document.get("baseModel") or {}
    if (not isinstance(base, dict)
            or not re.fullmatch(r"Qwen/Qwen2\.5-(?:0\.5|1\.5|7)B(?:-Instruct)?", str(base.get("source", "")))
            or not re.fullmatch(r"[0-9a-f]{40}", str(base.get("revision", "")))):
        raise ValueError("This serving recipe supports fine-tunes of a pinned Qwen2.5 0.5B, 1.5B or 7B base.")
    lineage = document.get("lineage") or {}
    if (not isinstance(lineage, dict)
            or not isinstance(lineage.get("trainingRun"), str)
            or not 1 <= len(lineage["trainingRun"]) <= 256
            or not HEX.fullmatch(str(lineage.get("trainingDataSha256", "")))):
        raise ValueError("Record the training run and training-data digest without including the training data.")
    terms = document.get("license") or {}
    if (not isinstance(terms, dict) or not isinstance(terms.get("id"), str)
            or not 1 <= len(terms["id"]) <= 120):
        raise ValueError("Record the checkpoint's usage terms; the base licence alone is not sufficient.")
    # A terms link is displayed, never fetched. Restrict it to credential-free HTTPS.
    parsed = urlsplit(str(terms.get("url", "")))
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.port not in (None, 443)):
        raise ValueError("The usage-terms link must be a credential-free HTTPS address.")
    files = document.get("files")
    if not isinstance(files, list) or not 4 <= len(files) <= MAX_FILES:
        raise ValueError("The checkpoint manifest must contain 4–32 model files.")
    names = set()
    total = 0
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("Invalid checkpoint file entry.")
        name, size = item.get("name"), item.get("size")
        if not isinstance(name, str) or (name not in FILE_NAMES and not SHARD.fullmatch(name)):
            raise ValueError("Only model configuration, tokenizer, licence and Safetensors files are accepted.")
        if name in names:
            raise ValueError("A checkpoint file is listed more than once.")
        names.add(name)
        if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= CHECKPOINT_MAX_FILE_BYTES:
            raise ValueError("Each checkpoint file must be non-empty and smaller than 5 GiB.")
        total += size
        if not HEX.fullmatch(str(item.get("sha256", ""))):
            raise ValueError("Every checkpoint file requires a SHA-256 content digest.")
        version = item.get("versionId")
        if not isinstance(version, str) or not 1 <= len(version) <= 1024 or version == "null":
            raise ValueError("Every checkpoint file requires an immutable S3 version.")
    if total > CHECKPOINT_MAX_BYTES:
        raise ValueError("This bounded serving recipe accepts at most 18 GiB of model files.")
    if not {"config.json", "tokenizer.json", "tokenizer_config.json"}.issubset(names):
        raise ValueError("The complete model configuration and tokenizer files are required.")
    weights = [name for name in names if name.endswith(".safetensors")]
    if not 1 <= len(weights) <= 8:
        raise ValueError("Supply one Safetensors file or at most eight weight shards.")
    if "model.safetensors" in names and len(weights) != 1:
        raise ValueError("Choose the consolidated checkpoint or its shards, not both copies.")
    if len(weights) > 1 and "model.safetensors.index.json" not in names:
        raise ValueError("Sharded weights require their authoritative Safetensors index.")
    return files


def validate_config(config: dict[str, Any], tokenizer: dict[str, Any]) -> None:
    if config.get("architectures") != ["Qwen2ForCausalLM"] or config.get("model_type") != "qwen2":
        raise ValueError("This recipe requires a Qwen2ForCausalLM checkpoint, read from its actual configuration.")
    if config.get("auto_map") or tokenizer.get("auto_map"):
        raise ValueError("This checkpoint requires custom repository code, which this recipe does not execute.")
    if config.get("quantization_config"):
        raise ValueError("Quantized exports need a separately reviewed serving recipe; no conversion is implied.")
    if config.get("torch_dtype", config.get("dtype")) != "bfloat16":
        raise ValueError("This recipe accepts BF16 checkpoint weights.")
    context = config.get("max_position_embeddings")
    if isinstance(context, bool) or not isinstance(context, int) or not 1 <= context < 131072:
        raise ValueError("The imported model configuration must declare a context length below 128K.")
    if tokenizer.get("tokenizer_class") not in ("Qwen2Tokenizer", "Qwen2TokenizerFast"):
        raise ValueError("This recipe requires the Qwen2 tokenizer.")
    if not isinstance(tokenizer.get("chat_template"), str) or not tokenizer["chat_template"].strip():
        raise ValueError("Export the fine-tuned model's chat template with its tokenizer.")


def tensor_header(header: dict[str, Any], data_bytes: int) -> tuple[int, set[str]]:
    """Validate inert Safetensors metadata without loading any tensor or code."""
    params, spans, names = 0, [], set()
    for name, value in header.items():
        if name == "__metadata__":
            continue
        if not isinstance(name, str) or not name or len(name) > 512 or not isinstance(value, dict):
            raise ValueError("Malformed Safetensors tensor metadata.")
        shape, offsets = value.get("shape"), value.get("data_offsets")
        if (not isinstance(shape, list) or not 1 <= len(shape) <= 8
                or any(isinstance(n, bool) or not isinstance(n, int) or not 0 < n <= 8_000_000_000 for n in shape)
                or not isinstance(offsets, list) or len(offsets) != 2
                or any(isinstance(n, bool) or not isinstance(n, int) for n in offsets)):
            raise ValueError("Malformed tensor dimensions or byte offsets.")
        count = 1
        for size in shape:
            count *= size
            if count > 8_000_000_000:
                raise ValueError("This tensor exceeds the bounded Qwen recipe.")
        start, end = offsets
        if value.get("dtype") != "BF16" or not 0 <= start < end <= data_bytes or end - start != count * 2:
            raise ValueError("Tensor bytes do not match BF16 dimensions.")
        spans.append((start, end))
        params += count
        names.add(name)
    if not spans:
        raise ValueError("No weights were found in the Safetensors file.")
    cursor = 0
    for start, end in sorted(spans):
        if start != cursor:
            raise ValueError("Safetensors data contains overlapping tensors or unclaimed bytes.")
        cursor = end
    if cursor != data_bytes:
        raise ValueError("Safetensors file length does not match its tensor metadata.")
    return params, names


def inspect_checkpoint(source: str, settings: Any, project: str, s3: Any,
                       revision: str | None = None,
                       manifest_version: str | None = None) -> dict[str, Any]:
    bucket, key = location(source, settings, project)
    args = {"Bucket": bucket, "Key": key, "ExpectedBucketOwner": settings.account}
    if manifest_version:
        args["VersionId"] = manifest_version
    response = s3.get_object(**args)
    raw = _body(response, MAX_MANIFEST_BYTES)
    manifest_digest = hashlib.sha256(raw).hexdigest()
    if revision and revision != manifest_digest:
        raise ValueError("The checkpoint manifest changed. Inspect and review the new checkpoint before continuing.")
    if response.get("VersionId") in (None, "", "null"):
        raise ValueError("The checkpoint library must use S3 versioning.")
    document = _json(raw)
    files = validate_manifest(document)
    # The content-addressed folder covers names, digests, sizes and supplied lineage.
    identity = {**document, "files": [
        {k: item[k] for k in ("name", "size", "sha256")} for item in files
    ]}
    if key.split("/")[-2] != digest(identity):
        raise ValueError("The checkpoint's content identity does not match its library location.")
    prefix = key.removesuffix("manifest.json") + "files/"
    by_name = {item["name"]: item for item in files}

    def read_file(name: str, maximum: int, byte_range: str | None = None) -> bytes:
        item = by_name[name]
        request = dict(Bucket=bucket, Key=prefix + name, VersionId=item["versionId"],
                       ExpectedBucketOwner=settings.account)
        if byte_range:
            request["Range"] = byte_range
        content = _body(s3.get_object(**request), maximum)
        if not byte_range and (len(content) != item["size"]
                               or hashlib.sha256(content).hexdigest() != item["sha256"]):
            raise ValueError("A checkpoint metadata file failed its pinned content check.")
        return content

    config = _json(read_file("config.json", MAX_CONFIG_BYTES))
    tokenizer = _json(read_file("tokenizer_config.json", MAX_CONFIG_BYTES))
    validate_config(config, tokenizer)
    tensors, parameters, weight_bytes, actual_map = set(), 0, 0, {}
    for item in files:
        name = item["name"]
        if not name.endswith(".safetensors"):
            continue
        length = read_file(name, 8, "bytes=0-7")
        if len(length) != 8:
            raise ValueError("Incomplete Safetensors header.")
        header_length = struct.unpack("<Q", length)[0]
        if not 2 <= header_length <= MAX_HEADER_BYTES or header_length + 8 >= item["size"]:
            raise ValueError("Invalid or oversized Safetensors header.")
        header = _json(read_file(name, MAX_HEADER_BYTES, f"bytes=8-{7 + header_length}"))
        count, tensor_names = tensor_header(header, item["size"] - 8 - header_length)
        if tensors.intersection(tensor_names):
            raise ValueError("The checkpoint contains duplicate tensors across weight files.")
        tensors.update(tensor_names)
        parameters += count
        weight_bytes += item["size"]
        actual_map.update({tensor: name for tensor in tensor_names})
    if not 0 < parameters <= 8_000_000_000:
        raise ValueError("This serving recipe accepts Qwen checkpoints up to 8 billion stored parameters.")
    if "model.safetensors.index.json" in by_name:
        index = _json(read_file("model.safetensors.index.json", MAX_CONFIG_BYTES))
        if index.get("weight_map") != actual_map:
            raise ValueError("The shard index does not match the checkpoint's actual weight files.")
    return {
        "source": source, "sourceKind": "checkpoint", "revision": manifest_digest,
        "manifestVersionId": response["VersionId"], "name": document["name"],
        "files": [{**item, "key": prefix + item["name"], "digest": item["sha256"], "algorithm": "sha256"}
                  for item in files],
        "bytes": sum(item["size"] for item in files), "weightBytes": weight_bytes,
        "architecture": "Qwen2ForCausalLM", "precision": "BF16",
        "totalParamsB": str(Decimal(parameters) / 1_000_000_000),
        "contextTokens": str(config["max_position_embeddings"]),
        "weightsGb": str((Decimal(weight_bytes) / 1024**3).quantize(Decimal("0.001"))),
        "license": document["license"]["id"], "licenseUrl": document["license"]["url"],
        "artifactFormat": document["artifactFormat"], "customization": "fine-tuned",
        "baseModel": document["baseModel"], "lineage": document["lineage"],
        "lineageStatus": "SUPPLIED", "fullContentVerified": False,
        "recipeId": CHECKPOINT_RECIPE_ID, "recipeVersion": CHECKPOINT_RECIPE_VERSION,
    }


def inspection_result(metadata: dict[str, Any]) -> dict[str, Any]:
    from .models import _iso, _now
    fields = {
        name: {"origin": "DETECTED", "value": str(metadata[key]),
               "sourceUrl": None,
               "detail": "Read from the pinned checkpoint's configuration and tensor headers."}
        for name, key in (
            ("architecture", "architecture"), ("totalParamsB", "totalParamsB"),
            ("contextTokens", "contextTokens"), ("weightsGb", "weightsGb"),
            ("precision", "precision"), ("licenseId", "license"),
        )
    }
    fields["licenseId"]["detail"] = "Usage terms supplied by the checkpoint publisher; review them before deployment."
    return {
        "ok": True, "error": None, "source": metadata["source"], "repo": metadata["source"],
        "revision": metadata["revision"], "retrievedAt": _iso(_now()),
        "access": "PRIVATE", "accessDetail": "Read from your authorized private model library.",
        "fields": fields, "weightFiles": sum(f["name"].endswith(".safetensors") for f in metadata["files"]),
        "notes": ["The checkpoint is separate from its base model.",
                  "Training lineage is supplied; answer quality and performance have not been verified.",
                  "Full file checksums are verified during preparation before deployment."],
        "checkpoint": {k: metadata[k] for k in (
            "source", "name", "revision", "manifestVersionId", "artifactFormat",
            "customization", "baseModel", "lineage", "lineageStatus", "fullContentVerified",
        )},
    }


def list_checkpoints(settings: Any, project: str, s3: Any) -> dict[str, Any]:
    """List only the authorized library namespaces, with bounded pagination."""
    results = []
    truncated = False
    for scope in ("shared", project_namespace(project)):
        token = None
        prefix = checkpoint_root(settings) + scope + "/"
        for _ in range(5):
            args = dict(Bucket=settings.bucket, Prefix=prefix, MaxKeys=200,
                        ExpectedBucketOwner=settings.account)
            if token:
                args["ContinuationToken"] = token
            page = s3.list_objects_v2(**args)
            for item in page.get("Contents", []):
                key = item["Key"]
                if not key.endswith("/manifest.json"):
                    continue
                source = f"s3://{settings.bucket}/{key}"
                try:
                    location(source, settings, project)
                except ValueError:
                    continue
                if len(results) >= 50:
                    truncated = True
                    break
                results.append({"source": source, "label": key.split("/")[-3],
                                "library": "Shared with this installation" if scope == "shared" else "Your project"})
            token = page.get("NextContinuationToken")
            if not token or len(results) >= 50:
                truncated = truncated or bool(token)
                break
        else:
            truncated = True
    return {"checkpoints": results, "truncated": truncated,
            "note": "Inspect a checkpoint to read its model facts. A library listing does not verify training or quality."}
