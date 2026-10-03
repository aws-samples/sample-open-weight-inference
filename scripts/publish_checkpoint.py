#!/usr/bin/env python3
"""Operator tool: validate a complete checkpoint or the reviewed speech bundle, then optionally publish.

Default: local validation only. Publication requires an explicit account, bucket,
KMS key and --publish. It does not train a model, create hosting or accept terms.
Run with EDDIE's Python environment; no ML framework is needed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import struct
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from deploy.checkpoints import (  # noqa: E402
    CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_FILE_BYTES, FILE_NAMES, SHARD, MAX_HEADER_BYTES, MAX_CONFIG_BYTES,
    checkpoint_root, project_namespace, tensor_header, validate_config, validate_manifest,
)
from deploy.recipes import digest  # noqa: E402
from deploy.speech import (  # noqa: E402
    BUNDLE_FILES, is_speech_manifest, library_document, validate_speech_manifest, verify_file,
)


def read_metadata(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_CONFIG_BYTES:
        raise ValueError("Checkpoint metadata must be bounded, ordinary JSON files.")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Checkpoint JSON contains a duplicate key.")
            result[key] = value
        return result

    value = json.loads(path.read_bytes(), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError("Checkpoint metadata must be a JSON object.")
    return value


def describe(directory: Path, description: dict) -> tuple[dict, dict[str, Path]]:
    """Read inert configs and stream hashes; never import code from the model folder."""
    config = read_metadata(directory / "config.json")
    tokenizer = read_metadata(directory / "tokenizer_config.json")
    validate_config(config, tokenizer)
    paths, rows, tensors, actual_map, params, total = {}, [], set(), {}, 0, 0
    for path in sorted(directory.iterdir()):
        if path.name not in FILE_NAMES and not SHARD.fullmatch(path.name):
            continue  # README/training notes are not inference inputs.
        if path.is_symlink() or not path.is_file():
            raise ValueError("Model files must be ordinary files, not symbolic links.")
        size = path.stat().st_size
        total += size
        if not 0 < size <= CHECKPOINT_MAX_FILE_BYTES or total > CHECKPOINT_MAX_BYTES:
            raise ValueError("The checkpoint exceeds the reviewed file or model-size limit.")
        sha = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(8 * 1024 * 1024):
                sha.update(chunk)
        if path.suffix == ".safetensors":
            with path.open("rb") as stream:
                length = stream.read(8)
                if len(length) != 8:
                    raise ValueError("Incomplete Safetensors file.")
                header_size = struct.unpack("<Q", length)[0]
                if not 2 <= header_size <= MAX_HEADER_BYTES or header_size + 8 >= size:
                    raise ValueError("Invalid Safetensors header size.")
                header = json.loads(stream.read(header_size))
            count, names = tensor_header(header, size - 8 - header_size)
            if tensors.intersection(names):
                raise ValueError("Duplicate tensors across checkpoint shards.")
            tensors.update(names)
            actual_map.update({name: path.name for name in names})
            params += count
        paths[path.name] = path
        rows.append({"name": path.name, "size": size, "sha256": sha.hexdigest()})
    if not 0 < params <= 8_000_000_000:
        raise ValueError("This recipe accepts at most 8 billion stored parameters.")
    if "model.safetensors.index.json" in paths:
        if read_metadata(paths["model.safetensors.index.json"]).get("weight_map") != actual_map:
            raise ValueError("The shard index does not match the tensor files.")
    document = {
        "schemaVersion": 1, "name": description["name"],
        "customization": "fine-tuned", "artifactFormat": description["artifactFormat"],
        "baseModel": description["baseModel"], "lineage": description["lineage"],
        "license": description["license"], "files": rows,
    }
    # Validate the exact publication contract before any AWS call. Versions are
    # filled with actual S3 responses only after each successful upload.
    validate_manifest({**document, "files": [{**row, "versionId": "not-yet-published"} for row in rows]})
    return document, paths


def describe_speech(directory: Path) -> tuple[dict, dict[str, Path]]:
    """The reviewed published speech bundle: every file must match its pinned recipe."""
    paths = {}
    for name, item in BUNDLE_FILES.items():
        path = directory.joinpath(*name.split("/"))
        verify_file(path, item)
        paths[name] = path
    document = library_document()
    validate_speech_manifest({**document, "files": [
        {**row, "versionId": "not-yet-published"} for row in document["files"]]})
    return document, paths


def publish(document, paths, *, session, account, region, bucket, key, environment, name, project):
    identity = session.client("sts", region_name=region).get_caller_identity()
    if identity.get("Account") != account:
        raise ValueError("The active AWS account does not match --account. Nothing was uploaded.")
    if not re.fullmatch(r"\d{12}", account) or not re.fullmatch(
        rf"arn:aws:kms:{re.escape(region)}:{account}:key/[a-zA-Z0-9-]+", key,
    ):
        raise ValueError("Use an explicit account and a KMS key ARN in that account and Region.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name):
        raise ValueError("The checkpoint ID must be a short lowercase slug.")
    scope = project_namespace(project) if project else "shared"
    prefix = checkpoint_root(SimpleNamespace(environment=environment)) + scope + "/" + name + "/" + digest(document) + "/"
    s3 = session.client("s3", region_name=region)
    if s3.get_bucket_versioning(Bucket=bucket, ExpectedBucketOwner=account).get("Status") != "Enabled":
        raise ValueError("The destination bucket must have versioning enabled.")
    block = s3.get_public_access_block(Bucket=bucket, ExpectedBucketOwner=account)["PublicAccessBlockConfiguration"]
    if not all(block.get(value) for value in ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")):
        raise ValueError("All four S3 public-access blocks must be enabled.")
    for row in document["files"]:
        with paths[row["name"]].open("rb") as file:
            response = s3.put_object(
                Bucket=bucket, Key=prefix + "files/" + row["name"], Body=file,
                ContentLength=row["size"], ExpectedBucketOwner=account,
                ServerSideEncryption="aws:kms", SSEKMSKeyId=key,
                ChecksumSHA256=base64.b64encode(bytes.fromhex(row["sha256"])).decode(),
            )
        version = response.get("VersionId")
        if not version or version == "null":
            raise ValueError("S3 did not return a pinned version. No manifest was published.")
        row["versionId"] = version
    (validate_speech_manifest if is_speech_manifest(document) else validate_manifest)(document)
    raw = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    response = s3.put_object(
        Bucket=bucket, Key=prefix + "manifest.json", Body=raw,
        ContentType="application/json", ExpectedBucketOwner=account,
        ServerSideEncryption="aws:kms", SSEKMSKeyId=key,
        ChecksumSHA256=base64.b64encode(hashlib.sha256(raw).digest()).decode(),
    )
    return {"source": f"s3://{bucket}/{prefix}manifest.json",
            "revision": hashlib.sha256(raw).hexdigest(),
            "manifestVersionId": response.get("VersionId"),
            "inferenceDeployed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--description", type=Path,
                        help="JSON: name, artifactFormat, baseModel, lineage and license")
    parser.add_argument("--speech-bundle", action="store_true",
                        help="Validate --directory as the reviewed Magpie TTS v2607 bundle instead")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--profile")
    parser.add_argument("--account")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--bucket")
    parser.add_argument("--kms-key")
    parser.add_argument("--environment")
    parser.add_argument("--id")
    parser.add_argument("--project", help="Authenticated project namespace. Omit for the installation's shared library.")
    args = parser.parse_args()
    if args.speech_bundle:
        document, paths = describe_speech(args.directory)
    elif args.description:
        document, paths = describe(args.directory, json.loads(args.description.read_text()))
    else:
        parser.error("--description is required for a fine-tuned checkpoint")
    if not args.publish:
        print(json.dumps({"validated": True, "fileCount": len(paths),
                          "bytes": sum(row["size"] for row in document["files"]),
                          "contentIdentity": digest(document), "published": False}, indent=2))
        return
    if not all((args.account, args.bucket, args.kms_key, args.environment, args.id)):
        parser.error("--publish requires --account, --bucket, --kms-key, --environment and --id")
    import boto3
    result = publish(document, paths, session=boto3.Session(profile_name=args.profile),
                     account=args.account, region=args.region, bucket=args.bucket,
                     key=args.kms_key, environment=args.environment, name=args.id, project=args.project)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
