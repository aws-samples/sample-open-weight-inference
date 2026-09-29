"""Authenticated inference facade for EDDIE-owned test endpoints.

The caller can choose text and a small output bound, never an endpoint name, IAM
role, Region or URL. The endpoint is resolved from the caller's project ledger.
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import replace
from typing import Any

import boto3
from botocore.config import Config

from runtime.principal import Authenticator, authorize_action, authorize_project, strip_identity_fields
from .models import JobState, with_step, _iso, _now
from .recipes import Settings
from .store import DynamoStore, NotFound

SETTINGS = Settings.from_environment()
AUTH = Authenticator.from_environment()


def invoke(store: Any, settings: Settings, payload: dict[str, Any], project: str) -> dict[str, Any]:
    job = store.get_job(project, str(payload.get("jobId", "")))
    if job.resources_expired or job.state not in (JobState.EXPERIMENTAL, JobState.READY):
        raise ValueError("This test is not ready or is being removed. Refresh its status.")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 8000:
        raise ValueError("Enter a test message of 1–8,000 characters.")
    max_tokens = payload.get("maxTokens", 128)
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or not 1 <= max_tokens <= 256:
        raise ValueError("Choose between 1 and 256 output tokens.")
    plan = store.get_plan(project, job.plan_id)
    entries = store.list_resources(job.job_id)
    endpoint = next((e for e in entries if e.kind == "sagemaker-endpoint"), None)
    if not endpoint or endpoint.state.value != "CREATED" or not endpoint.physical_id:
        raise ValueError("No live endpoint is recorded for this test.")
    if endpoint.account_id != settings.account or endpoint.region != settings.region:
        raise ValueError("This endpoint is outside the configured inference account or Region.")
    # Bounded trials have an independently enforced request allowance too. It is
    # reserved before invoking, so concurrent requests cannot each see spare room.
    store.reserve_invocation(project, job.job_id, maximum=100)
    runtime = boto3.client("sagemaker-runtime", region_name=endpoint.region,
                           config=Config(connect_timeout=3, read_timeout=65,
                                         retries={"mode": "standard", "total_max_attempts": 1}))
    started = time.perf_counter()
    response = runtime.invoke_endpoint(
        EndpointName=endpoint.physical_id, ContentType="application/json", Accept="application/json",
        Body=json.dumps({"model": "eddie-model", "messages": [{"role": "user", "content": text}],
                         "max_tokens": max_tokens, "temperature": 0, "stream": False}).encode(),
    )
    raw = response["Body"].read(256 * 1024 + 1)
    elapsed = round((time.perf_counter() - started) * 1000, 1)
    if len(raw) > 256 * 1024:
        raise ValueError("The endpoint returned more than the response limit.")
    generated = json.loads(raw)
    choices = generated.get("choices") or []
    output = (choices[0].get("message") or {}).get("content") if choices else None
    if not isinstance(output, str) or not output.strip():
        raise ValueError("The model did not return a usable text answer.")
    receipt = {
        "runId": "invoke-" + uuid.uuid4().hex,
        "at": _iso(_now()), "model": plan.model_ref,
        "revision": next(a.digest for a in plan.artifacts if a.kind == "weights"),
        "jobId": job.job_id, "endpointArn": endpoint.arn,
        "requestId": response.get("ResponseMetadata", {}).get("RequestId"),
        "outputSha256": hashlib.sha256(output.encode()).hexdigest(),
        "elapsedMs": str(elapsed), "metric": "single_request_end_to_end_ms",
        "sampleCount": 1, "percentileQualified": False, "qualityQualified": False,
        "promptStored": False, "outputStored": False,
    }
    # Cleanup and inference completion may race. Never resurrect a removed job or
    # replace its latest creation state with the earlier invocation snapshot.
    with store.lease_job(job.job_id, seconds=90) as acquired:
        if acquired:
            current = store.get_job(project, job.job_id)
            if current.state in (JobState.EXPERIMENTAL, JobState.READY):
                store.put_job(replace(with_step(current, "test-invocation", "DONE",
                    "An authenticated request returned a real model answer. Quality and p99 are not certified."),
                    invocation_receipt=receipt))
    return {"output": output, "receipt": receipt}


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    from runtime.principal import AuthenticationError, AuthorizationError
    try:
        principal = AUTH.authenticate(event.get("authorization"))
        authorize_action(principal, "deployment.invoke")
        if event.get("action") != "deployment.invoke":
            raise ValueError("This function only serves authenticated test invocations.")
        payload, _ = strip_identity_fields(event.get("payload") or {})
        project = authorize_project(principal, payload.get("projectId"))
        result = invoke(DynamoStore(SETTINGS.table, SETTINGS.region), SETTINGS, payload, project)
        return {"ok": True, "result": result}
    except (ValueError, NotFound, AuthenticationError, AuthorizationError) as exc:
        return {"ok": False, "error": getattr(exc, "code", "invalid_request"), "detail": str(exc)}
    except Exception:
        return {"ok": False, "error": "test_invocation_failed",
                "detail": "The model request did not return successfully. Refresh deployment status before trying again."}
