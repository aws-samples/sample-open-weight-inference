"""Pinned Hugging Face and private-checkpoint transfer for reviewed recipes.

No repository code, pickle weights, requirements.txt, custom handlers or shell
commands are ever downloaded or executed. All bytes are checked against the pinned
commit's Git/LFS identity before they are uploaded to the private staging prefix.
"""
from __future__ import annotations

import hashlib
import base64
import json
import time
import urllib.request
from dataclasses import replace
from contextlib import contextmanager
from tempfile import TemporaryFile
from typing import Any

from .executor import admitted_plan, still_creating, intent, created, step_done, model_prefix
from .models import JobState, with_step
from .recipes import Settings, inspect_recipe_model, digest
from .checkpoints import CHECKPOINT_RECIPE_ID, inspect_checkpoint
from .service import client
from .store import DynamoStore
from netio import open_url, permitted_url

SETTINGS = Settings.from_environment()


#: Weight bytes may only ever come from the public model registry, including the
#: CDN subdomains its download URLs redirect to.
DOWNLOAD_HOSTS = ("huggingface.co", "hf.co")


def permitted_download(url: str) -> bool:
    """Whether `url` is a credential-free HTTPS URL on an approved model host."""
    return permitted_url(url, DOWNLOAD_HOSTS)


class PublicModelRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        if not permitted_download(newurl):
            raise ValueError("The model download redirected outside the approved HTTPS hosts.")
        # This connector never has an HF token or a user credential to forward.
        return super().redirect_request(request, response, code, message, headers, newurl)


@contextmanager
def source_stream(metadata, item, settings, s3, opener):
    """Every private file is read at its reviewed S3 version; never follow a URL."""
    if metadata.get("sourceKind") == "checkpoint":
        response = s3.get_object(
            Bucket=settings.bucket, Key=item["key"], VersionId=item["versionId"],
            ExpectedBucketOwner=settings.account,
        )
        stream = response["Body"]
        try:
            if response.get("ContentLength") != item["size"]:
                raise ValueError("The checkpoint file does not match its approved size.")
            yield stream
        finally:
            stream.close()
    else:
        url = f"https://huggingface.co/{metadata['source']}/resolve/{metadata['revision']}/{item['name']}"
        with open_url(url, timeout=20, allowed_hosts=DOWNLOAD_HOSTS, opener=opener) as response:
            if not permitted_download(response.url):
                raise ValueError("Unexpected model download host.")
            yield response


def stage(store: Any, settings: Settings, job: Any, *, remaining=None) -> None:
    plan = admitted_plan(store, settings, job)
    if step_done(job, "prepare-model"):
        return
    revision = next(a.digest for a in plan.artifacts if a.kind == "weights")
    expected_manifest = next(a.digest for a in plan.artifacts if a.kind == "manifest")
    s3 = client("s3", settings.region)
    if plan.recipe_id == CHECKPOINT_RECIPE_ID:
        reviewed = store.get_plan_review(job.project_id, job.plan_id)["model"]
        if digest(reviewed) != expected_manifest:
            raise ValueError("The saved checkpoint manifest does not match the approved plan.")
        metadata = inspect_checkpoint(
            plan.model_ref, settings, job.project_id, s3, revision,
            manifest_version=reviewed["manifestVersionId"],
        )
    else:
        metadata = inspect_recipe_model(plan.model_ref, revision)
    if digest(metadata) != expected_manifest:
        raise ValueError("The pinned model manifest changed.")
    prefix = model_prefix(settings, job)
    entry = intent(store, settings, job, "s3-model-artifacts", f"s3://{settings.bucket}/{prefix}")
    opener = urllib.request.build_opener(PublicModelRedirects())
    deadline = time.monotonic() + 500
    receipts = []
    for item in metadata["files"]:
        still_creating(store, job)
        if time.monotonic() > deadline or (remaining and remaining() < 60_000):
            raise TimeoutError("Model preparation exceeded its time budget.")
        if item["algorithm"] not in ("sha256", "git-blob-sha1"):
            raise ValueError("The model manifest uses an unsupported content identity.")
        # Git's blob identifier has a SHA-1 wire format. It is a compatibility
        # identifier, not a cryptographic security primitive. LFS weight files use
        # SHA-256; every staged file also receives an independent SHA-256 checksum.
        # nosemgrep: python.lang.security.insecure-hash-algorithms.insecure-hash-algorithm-sha1
        hasher = hashlib.sha256() if item["algorithm"] == "sha256" else hashlib.sha1(usedforsecurity=False)
        content_sha256 = hashlib.sha256()
        if item["algorithm"] == "git-blob-sha1":
            hasher.update(f"blob {item['size']}\0".encode())
        # Bytes are streamed to the Lambda's encrypted ephemeral disk. Never read a
        # model into the controller's memory or into the agent's tool context.
        with TemporaryFile() as file:
            with source_stream(metadata, item, settings, s3, opener) as response:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > item["size"] or time.monotonic() > deadline:
                        raise ValueError("Model download exceeded its approved size or duration.")
                    hasher.update(chunk)
                    content_sha256.update(chunk)
                    file.write(chunk)
            if total != item["size"] or hasher.hexdigest() != item["digest"]:
                raise ValueError("The downloaded model file failed its content check.")
            still_creating(store, job)
            file.seek(0)
            key = prefix + "files/" + item["name"]
            s3.put_object(Bucket=settings.bucket, Key=key, Body=file, ContentLength=total,
                          ExpectedBucketOwner=settings.account,
                          ServerSideEncryption="aws:kms", SSEKMSKeyId=settings.kms_key,
                          ChecksumSHA256=base64.b64encode(content_sha256.digest()).decode("ascii"),
                          Metadata={"eddie-job": job.job_id, "source-digest": item["digest"]})
            receipts.append({"key": key, "bytes": total, "sourceDigest": item["digest"],
                             "sha256": content_sha256.hexdigest()})
    still_creating(store, job)
    receipt = {"model": plan.model_ref, "revision": revision, "manifestDigest": expected_manifest,
               "files": receipts, "remoteCodeExecuted": False,
               "sourceKind": metadata.get("sourceKind", "huggingface"),
               "fullContentVerified": True}
    s3.put_object(Bucket=settings.bucket, Key=prefix + "receipt.json",
                  Body=json.dumps(receipt).encode(), ContentType="application/json",
                  ServerSideEncryption="aws:kms", SSEKMSKeyId=settings.kms_key,
                  ExpectedBucketOwner=settings.account)
    created(store, entry)
    job = still_creating(store, job)
    store.put_job(replace(with_step(job, "prepare-model", "DONE",
        f"Pinned model files copied and verified ({metadata['bytes']} bytes). No repository code was executed."),
        state=JobState.RUNNING))


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    store = DynamoStore(SETTINGS.table, SETTINGS.region)
    project, job_id = str(event.get("projectId", "")), str(event.get("jobId", ""))
    with store.lease_job(job_id) as acquired:
        if not acquired:
            return {"ok": True, "busy": True}
        job = store.get_job(project, job_id)
        if job.state not in (JobState.PENDING, JobState.RUNNING):
            return {"ok": True, "skipped": True}
        try:
            stage(store, SETTINGS, job,
                  remaining=context.get_remaining_time_in_millis if context else None)
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code", type(exc).__name__)
            current = store.get_job(project, job_id)
            if current.state not in (JobState.DELETED, JobState.DELETING):
                store.put_job(replace(with_step(current, "prepare-model", "FAILED",
                    f"Model preparation stopped ({code}). Cleanup will remove any staged files."),
                    state=JobState.FAILED, failure_reason=f"Model preparation failed ({code}); cleanup requested."))
            return {"ok": False, "error": code}
    return {"ok": True}
