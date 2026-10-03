"""Authenticated inference facade for EDDIE-owned test endpoints.

The caller can choose text and a small output bound, never an endpoint name, IAM
role, Region or URL. The endpoint is resolved from the caller's project ledger.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import time
import uuid
import wave
from dataclasses import replace
from typing import Any

import boto3
from botocore.config import Config

from runtime.principal import Authenticator, authorize_action, authorize_project, strip_identity_fields
from .models import JobState, with_step, _iso, _now
from .recipes import Settings
from .speech import (
    BUNDLE, SPEECH_MAX_RESPONSE_BYTES, SPEECH_MAX_TEXT, SPEECH_RECIPE_ID, SPEECH_SPEAKERS,
)
from .store import DynamoStore, NotFound

SETTINGS = Settings.from_environment()
AUTH = Authenticator.from_environment()


def decoded_audio(audio: bytes, reported: dict[str, Any]) -> dict[str, Any]:
    """Functional acceptance: the bytes are a complete, non-empty WAV in the recipe's format."""
    try:
        with wave.open(io.BytesIO(audio)) as wav:
            channels, width, rate, frames = (wav.getnchannels(), wav.getsampwidth(),
                                             wav.getframerate(), wav.getnframes())
            pcm = wav.readframes(frames)
    except (wave.Error, EOFError) as exc:
        raise ValueError("The endpoint's audio did not decode as WAV.") from exc
    if (channels, width, rate) != (1, 2, BUNDLE["sampleRateHz"]) or frames <= 0 or len(pcm) != frames * 2:
        raise ValueError("The endpoint's audio is not complete 16-bit mono 22,050 Hz PCM.")
    seconds = round(frames / rate, 3)
    if abs(seconds - float(reported.get("audioSeconds", -1))) > 0.01:
        raise ValueError("The decoded audio length does not match the runtime's report.")
    return {"decoded": True, "audioSeconds": seconds, "sampleRateHz": rate, "channels": channels,
            "bitsPerSample": width * 8, "frames": frames}


def invoke_speech(store: Any, settings: Settings, payload: dict[str, Any], project: str,
                  job: Any, plan: Any, endpoint: Any) -> dict[str, Any]:
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > SPEECH_MAX_TEXT:
        raise ValueError(f"Enter text of 1–{SPEECH_MAX_TEXT} characters.")
    speaker = payload.get("speaker", "jason")
    if speaker not in SPEECH_SPEAKERS:
        raise ValueError("Choose one of the bundle's preset speakers.")
    store.reserve_invocation(project, job.job_id, maximum=100)
    runtime = boto3.client("sagemaker-runtime", region_name=endpoint.region,
                           config=Config(connect_timeout=3, read_timeout=65,
                                         retries={"mode": "standard", "total_max_attempts": 1}))
    started = time.perf_counter()
    try:
        response = runtime.invoke_endpoint(
            EndpointName=endpoint.physical_id, ContentType="application/json", Accept="application/json",
            Body=json.dumps({"text": text, "speaker": speaker}).encode(),
        )
    except runtime.exceptions.ModelError as exc:
        # The runtime's own refusal (deadline, empty or silent audio) is the useful
        # failure evidence. It never contains the submitted text.
        try:
            reason = json.loads(exc.response.get("OriginalMessage", "{}")).get("error", "")
        except ValueError:
            reason = ""
        raise ValueError(f"The model did not return valid audio: {str(reason)[:300] or 'no reason given'}") from None
    raw = response["Body"].read(SPEECH_MAX_RESPONSE_BYTES + 1)
    elapsed = round((time.perf_counter() - started) * 1000, 1)
    if len(raw) > SPEECH_MAX_RESPONSE_BYTES:
        raise ValueError("The endpoint returned more than the response limit.")
    generated = json.loads(raw)
    try:
        audio = base64.b64decode(generated.pop("audio"), validate=True)
    except (KeyError, ValueError, TypeError) as exc:
        raise ValueError("The model did not return audio.") from exc
    sha = hashlib.sha256(audio).hexdigest()
    if sha != generated.get("audioSha256"):
        raise ValueError("The audio changed between the runtime and this service.")
    check = decoded_audio(audio, generated)
    receipt = {
        "runId": "invoke-" + uuid.uuid4().hex,
        "at": _iso(_now()), "model": plan.model_ref,
        "revision": next(a.digest for a in plan.artifacts if a.kind == "weights"),
        "jobId": job.job_id, "endpointArn": endpoint.arn,
        "requestId": response.get("ResponseMetadata", {}).get("RequestId"),
        "outputSha256": sha, "inputSha256": hashlib.sha256(text.encode()).hexdigest(),
        "elapsedMs": str(elapsed), "metric": "single_request_end_to_end_ms",
        # DynamoDB rejects floats: durations are recorded as decimal strings, as elapsedMs is.
        "speaker": speaker, **{k: (str(v) if isinstance(v, float) else v) for k, v in check.items()},
        "synthesisSeconds": str(generated.get("synthesisSeconds")),
        "peakRssMiB": str(generated.get("peakRssMiB")), "threads": generated.get("threads"),
        "instanceType": plan.envelope.instance_type,
        "sampleCount": 1, "percentileQualified": False, "qualityQualified": False,
        "promptStored": False, "outputStored": False,
    }
    with store.lease_job(job.job_id, seconds=90) as acquired:
        if acquired:
            current = store.get_job(project, job.job_id)
            if current.state in (JobState.EXPERIMENTAL, JobState.READY):
                store.put_job(replace(with_step(current, "test-invocation", "DONE",
                    "An authenticated request returned audio that decoded completely. "
                    "Speech quality has not been evaluated."),
                    invocation_receipt=receipt))
    return {"audio": base64.b64encode(audio).decode(), "format": "audio/wav", "receipt": receipt}


def invoke(store: Any, settings: Settings, payload: dict[str, Any], project: str) -> dict[str, Any]:
    job = store.get_job(project, str(payload.get("jobId", "")))
    if job.resources_expired or job.state not in (JobState.EXPERIMENTAL, JobState.READY):
        raise ValueError("This test is not ready or is being removed. Refresh its status.")
    if store.get_plan(project, job.plan_id).recipe_id == SPEECH_RECIPE_ID:
        plan = store.get_plan(project, job.plan_id)
        endpoint = next((e for e in store.list_resources(job.job_id) if e.kind == "sagemaker-endpoint"), None)
        if not endpoint or endpoint.state.value != "CREATED" or not endpoint.physical_id:
            raise ValueError("No live endpoint is recorded for this test.")
        if endpoint.account_id != settings.account or endpoint.region != settings.region:
            raise ValueError("This endpoint is outside the configured inference account or Region.")
        return invoke_speech(store, settings, payload, project, job, plan, endpoint)
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
