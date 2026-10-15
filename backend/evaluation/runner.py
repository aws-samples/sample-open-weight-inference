"""Opt-in local benchmark runner for existing inference services.

No resource creation, model downloads, shell commands, generated-code execution,
credential files, or server-side endpoint fetching. AWS requests use the caller's
SDK credentials. Self-hosted requests must use an explicit loopback tunnel.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from api.model_usage import normalized_usage

from .benchmarks import (
    VERSION, MAX_BYTES, _bounded_json, _integer, _number, _object, _text,
    compare_benchmarks, digest, validate_run,
)

MAX_RESPONSE = 1_000_000
MAX_TASKS = 50
MAX_REQUESTS = 200


def validate_plan(value: Any) -> dict[str, Any]:
    _bounded_json(value)
    plan = _object(value, "Benchmark plan")
    if plan.get("schemaVersion") != VERSION:
        raise ValueError(f"Use schemaVersion {VERSION}.")
    if set(plan) - {"schemaVersion", "workload", "target", "settings"}:
        raise ValueError("The plan contains unsupported fields.")
    workload = _object(plan.get("workload"), "Workload")
    _text(workload.get("name"), "Workload name")
    tasks = workload.get("tasks")
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_TASKS:
        raise ValueError(f"Use between 1 and {MAX_TASKS} tasks.")
    ids = set()
    for task in tasks:
        task = _object(task, "Task")
        task_id = _text(task.get("id"), "Task ID", 100)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}", task_id) or task_id in ids:
            raise ValueError("Each task needs a unique short ID.")
        ids.add(task_id)
        _text(task.get("input"), "Task input", 8000)
        _text(task.get("expected"), "Expected answer", 8000)
        if set(task) - {"id", "input", "expected"}:
            raise ValueError("Tasks contain only id, input and expected. Commands and scripts are not supported.")
    target = _object(plan.get("target"), "Target")
    allowed = {"provider", "model", "revision", "runtime", "region", "hardware", "label",
               "endpointName", "baseUrl", "modelName", "instanceType", "instanceCount", "requestModel"}
    if set(target) - allowed:
        raise ValueError("The target contains unsupported fields. Do not put credentials in a plan.")
    for key in ("model", "revision", "runtime", "region", "hardware", "label"):
        _text(target.get(key), f"Target {key}")
        if target[key].startswith("YOUR_"):
            raise ValueError(f"Replace the target {key} placeholder before validating or executing the plan.")
    for key in ("modelName", "requestModel"):
        if key in target:
            _text(target[key], f"Target {key}")
    if target.get("provider") not in ("bedrock", "sagemaker", "self_hosted"):
        raise ValueError("Use bedrock, sagemaker or self_hosted.")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", target["region"]):
        raise ValueError("Set an AWS Region such as us-east-1.")
    if target["provider"] == "sagemaker":
        if not re.fullmatch(r"[A-Za-z0-9](?:-*[A-Za-z0-9]){0,62}", str(target.get("endpointName", ""))):
            raise ValueError("Set a valid existing SageMaker endpoint name.")
    if target["provider"] == "bedrock" and (
        not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", target["model"]) or target["model"].startswith("arn:")
    ):
        raise ValueError("Use a Bedrock model ID or system inference-profile ID, not an ARN or URL.")
    if target["provider"] == "self_hosted":
        _loopback_url(target.get("baseUrl"))
    if target.get("instanceType") is not None:
        if not re.fullmatch(r"(?:ml\.)?[a-z0-9-]+\.[a-z0-9]+", str(target["instanceType"])):
            raise ValueError("Use an AWS instance type.")
        _integer(target.get("instanceCount", 1), "Instance count", 100, 1)
    elif "instanceCount" in target:
        raise ValueError("An instance count also needs an instance type.")
    if set(workload) - {"name", "tasks"}:
        raise ValueError("The workload contains unsupported fields.")
    settings = _object(plan.get("settings", {}), "Settings")
    if set(settings) - {"maxOutputTokens", "temperature", "repetitions", "concurrency",
                        "caseSensitive", "maxDurationSeconds"}:
        raise ValueError("The plan contains unsupported settings.")
    normalized = {
        "maxOutputTokens": _integer(settings.get("maxOutputTokens", 128), "Output token limit", 2048, 1),
        "temperature": _number(settings.get("temperature", 0), "Temperature", 2),
        "repetitions": _integer(settings.get("repetitions", 1), "Repetitions", 5, 1),
        "concurrency": _integer(settings.get("concurrency", 1), "Concurrency", 8, 1),
        "maxDurationSeconds": _integer(settings.get("maxDurationSeconds", 300), "Run deadline", 1800, 1),
        "caseSensitive": settings.get("caseSensitive", True),
    }
    if not isinstance(normalized["caseSensitive"], bool):
        raise ValueError("caseSensitive must be true or false.")
    if len(tasks) * normalized["repetitions"] > MAX_REQUESTS:
        raise ValueError(f"A run may schedule at most {MAX_REQUESTS} requests.")
    return {**plan, "settings": normalized}


def _loopback_url(value: Any) -> str:
    text = _text(value, "Loopback base URL", 200)
    parsed = urllib.parse.urlsplit(text)
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("Use a loopback URL with an explicit non-privileged port.") from None
    if (
        parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1")
        or port is None or not 1024 <= port <= 65535
        or parsed.path.rstrip("/") != "/v1" or parsed.query or parsed.fragment
        or parsed.username or parsed.password
    ):
        raise ValueError("Use http://127.0.0.1:PORT/v1 (or [::1]) through your own SSH tunnel.")
    return text.rstrip("/") + "/chat/completions"


class AwsAdapter:
    def __init__(self, plan: dict[str, Any], session: Any):
        from botocore.config import Config
        target = plan["target"]
        self.target, self.settings = target, plan["settings"]
        service = "bedrock-runtime" if target["provider"] == "bedrock" else "sagemaker-runtime"
        self.client = session.client(service, region_name=target["region"], config=Config(
            connect_timeout=3, read_timeout=min(65, self.settings["maxDurationSeconds"]),
            retries={"total_max_attempts": 1},
        ))

    def __call__(self, text: str) -> dict[str, Any]:
        settings, target = self.settings, self.target
        started = time.perf_counter()
        if target["provider"] == "bedrock":
            response = self.client.converse_stream(
                modelId=target["model"],
                messages=[{"role": "user", "content": [{"text": text}]}],
                inferenceConfig={"maxTokens": settings["maxOutputTokens"], "temperature": settings["temperature"]},
            )
            parts, size, first, usage = [], 0, None, None
            stream = response["stream"]
            try:
                for event in stream:
                    if time.perf_counter() - started > self.settings["maxDurationSeconds"]:
                        raise TimeoutError("The stream exceeded the run deadline.")
                    if any(key.endswith("Exception") for key in event):
                        raise ValueError("The provider returned a streaming error.")
                    chunk = event.get("contentBlockDelta", {}).get("delta", {}).get("text", "")
                    if chunk:
                        first = first if first is not None else (time.perf_counter() - started) * 1000
                        size += len(chunk.encode())
                        if size > MAX_RESPONSE:
                            raise ValueError("The response exceeded the byte limit.")
                        parts.append(chunk)
                    if "metadata" in event:
                        usage = normalized_usage(event["metadata"].get("usage"), bedrock=True)
            finally:
                stream.close()
            return {"output": "".join(parts), "ttftMs": first, "usage": usage}
        response = self.client.invoke_endpoint(
            EndpointName=target["endpointName"], ContentType="application/json", Accept="application/json",
            Body=json.dumps({
                "model": target.get("requestModel", target["model"]), "messages": [{"role": "user", "content": text}],
                "max_tokens": settings["maxOutputTokens"], "temperature": settings["temperature"], "stream": False,
            }).encode(),
        )
        body = response["Body"]
        try:
            raw = body.read(MAX_RESPONSE + 1)
        finally:
            body.close()
        if len(raw) > MAX_RESPONSE:
            raise ValueError("The response exceeded the byte limit.")
        data = json.loads(raw)
        return {"output": data["choices"][0]["message"]["content"], "ttftMs": None,
                "usage": normalized_usage(data.get("usage"))}


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Benchmark endpoint redirects are not allowed.")


class LoopbackAdapter:
    """An existing OpenAI-compatible endpoint reached through a local tunnel."""
    def __init__(self, plan: dict[str, Any]):
        self.url = _loopback_url(plan["target"]["baseUrl"])
        self.target, self.settings = plan["target"], plan["settings"]
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirects())
        self.key = os.environ.get("EDDIE_BENCHMARK_API_KEY")
        if self.key and (len(self.key) > 8192 or "\n" in self.key or "\r" in self.key):
            raise ValueError("The benchmark API key environment variable is invalid.")

    def __call__(self, text: str) -> dict[str, Any]:
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if self.key:
            headers["Authorization"] = "Bearer " + self.key
        request = urllib.request.Request(self.url, method="POST", headers=headers, data=json.dumps({
            "model": self.target.get("requestModel", self.target["model"]), "messages": [{"role": "user", "content": text}],
            "max_tokens": self.settings["maxOutputTokens"], "temperature": self.settings["temperature"],
            "stream": True, "stream_options": {"include_usage": True},
        }).encode())
        started = time.perf_counter()
        parts, total, first, usage, done = [], 0, None, None, False
        with self.opener.open(request, timeout=min(65, self.settings["maxDurationSeconds"])) as response:
            while True:
                if time.perf_counter() - started > self.settings["maxDurationSeconds"]:
                    raise TimeoutError("The stream exceeded the run deadline.")
                line = response.readline(MAX_RESPONSE + 1)
                if not line:
                    break
                total += len(line)
                if total > MAX_RESPONSE:
                    raise ValueError("The response exceeded the byte limit.")
                if not line.startswith(b"data:"):
                    continue
                raw = line[5:].strip()
                if raw == b"[DONE]":
                    done = True
                    break
                data = json.loads(raw)
                if data.get("error"):
                    raise ValueError("The provider returned a streaming error.")
                if data.get("usage") is not None:
                    usage = normalized_usage(data["usage"])
                for choice in data.get("choices", []):
                    chunk = choice.get("delta", {}).get("content")
                    if isinstance(chunk, str) and chunk:
                        first = first if first is not None else (time.perf_counter() - started) * 1000
                        parts.append(chunk)
            if not done:
                raise ValueError("The response stream ended before completion.")
        return {"output": "".join(parts), "ttftMs": first, "usage": usage}


def run_plan(plan: dict[str, Any], invoke: Callable[[str], dict[str, Any]],
             cost: dict[str, Any] | None = None,
             stopped: Callable[[], bool] = lambda: False) -> dict[str, Any]:
    plan = validate_plan(plan)
    settings, target = plan["settings"], plan["target"]
    tasks = plan["workload"]["tasks"]
    scheduled = [(task, repeat) for repeat in range(1, settings["repetitions"] + 1) for task in tasks]
    observations: dict[int, dict[str, Any]] = {}
    started = time.perf_counter()
    deadline = started + settings["maxDurationSeconds"]

    def request(task: dict[str, Any], repeat: int) -> dict[str, Any]:
        before = time.perf_counter()
        base = {"taskId": task["id"], "repetition": repeat, "ttftMs": None, "usage": None}
        try:
            result = invoke(task["input"])
            output = result.get("output")
            if not isinstance(output, str) or len(output.encode()) > MAX_RESPONSE:
                raise ValueError("No bounded text response.")
            left, right = output.strip(), task["expected"].strip()
            if not settings["caseSensitive"]:
                left, right = left.casefold(), right.casefold()
            return {
                **base, "status": "ok", "accepted": bool(left) and left == right,
                "elapsedMs": max(.001, (time.perf_counter() - before) * 1000),
                "ttftMs": result.get("ttftMs"), "usage": result.get("usage"),
                "outputDigest": hashlib_sha(output),
            }
        except Exception:
            # Provider exceptions can include prompts, endpoint names or credentials.
            return {**base, "status": "error", "accepted": False,
                    "elapsedMs": max(.001, (time.perf_counter() - before) * 1000),
                    "errorCode": "request_failed"}

    next_index = 0
    pending = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=settings["concurrency"]) as pool:
        while next_index < len(scheduled) or pending:
            while (
                next_index < len(scheduled) and len(pending) < settings["concurrency"]
                and time.perf_counter() < deadline and not stopped()
            ):
                task, repeat = scheduled[next_index]
                pending[pool.submit(request, task, repeat)] = next_index
                next_index += 1
            if not pending:
                break
            done, _ = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                observations[pending.pop(future)] = future.result()
    for index, (task, repeat) in enumerate(scheduled):
        if index not in observations:
            observations[index] = {
                "taskId": task["id"], "repetition": repeat, "status": "not_run",
                "accepted": False, "elapsedMs": None, "ttftMs": None, "usage": None,
            }
    run = {
        "schemaVersion": VERSION, "runId": "bench-" + uuid.uuid4().hex,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "configuration": {key: target[key] for key in (
            "label", "model", "revision", "runtime", "region", "hardware", "provider",
        )} | {"harness": VERSION},
        "workload": {
            "name": plan["workload"]["name"],
            "datasetDigest": digest(sorted(tasks, key=lambda task: task["id"])),
            "rubricDigest": digest({"acceptance": "exact-answer/1", "caseSensitive": settings["caseSensitive"]}),
            "taskIds": [task["id"] for task in tasks],
        },
        "protocol": {
            key: settings[key] for key in ("maxOutputTokens", "temperature", "repetitions", "concurrency")
        } | {"warmupRequests": 0, "measurement": "client_end_to_end", "loadModel": "closed_loop",
             "acceptance": "exact-answer/1"},
        "state": "completed" if next_index == len(scheduled) else "stopped",
        "durationSeconds": max(.001, time.perf_counter() - started),
        "samples": [observations[index] for index in range(len(scheduled))],
        "cost": cost or {"basis": "unknown", "scope": "benchmark_window"},
    }
    validate_run(run)
    return run


def hashlib_sha(text: str) -> str:
    import hashlib
    return hashlib.sha256(text.encode()).hexdigest()


def public_price(plan: dict[str, Any]) -> dict[str, Any]:
    """Reuse the application's collectors. Unavailable prices remain unknown."""
    from decimal import Decimal
    from catalog.native import _bedrock, native_rates
    from catalog.pricing import ec2_on_demand_rate, sagemaker_hosting_rate
    target = plan["target"]
    unknown = {"basis": "unknown", "scope": "benchmark_window"}
    now = datetime.now(timezone.utc).isoformat()
    try:
        if target["provider"] == "bedrock":
            # A caller-supplied display name must not select another model's price.
            # Profile-specific prices need their own verified route/price mapping.
            # The runner can invoke a profile, but does not borrow a regional quote.
            if target["model"].startswith(("global.", "us.", "eu.", "apac.")):
                return unknown
            model = _bedrock(target["region"]).get_foundation_model(
                modelIdentifier=target["model"],
            )["modelDetails"]
            if model.get("modelId") != target["model"] or not model.get("modelName"):
                return unknown
            rates = native_rates(target["model"], model["modelName"], target["region"], now)
            if not rates.get("input") or not rates.get("output"):
                return unknown
            return {
                "basis": "tokens", "scope": "benchmark_window", "currency": "USD",
                "source": "AWS Price List Query API, standard text On-Demand",
                "retrievedAt": now, "rateId": rates["input"].sku + "/" + rates["output"].sku,
                "perMillion": {
                    "freshInputTokens": str(rates["input"].amount), "outputTokens": str(rates["output"].amount),
                    "cacheReadTokens": None, "cacheWriteTokens": None,
                },
            }
        instance = target.get("instanceType")
        if not instance:
            return unknown
        collector = sagemaker_hosting_rate if target["provider"] == "sagemaker" else ec2_on_demand_rate
        rate = collector(instance, target["region"])
        if rate is None:
            return unknown
        return {
            "basis": "capacity", "scope": "benchmark_window", "currency": "USD",
            "source": rate.source, "retrievedAt": now, "rateId": rate.sku,
            "hourlyUsd": str(rate.amount * Decimal(target.get("instanceCount", 1))),
        }
    except Exception:
        return unknown


def _load(path: Path) -> Any:
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError("Use a JSON file smaller than 1 MB.")
    def unique_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("Duplicate JSON fields are not supported.")
            value[key] = item
        return value
    try:
        return json.loads(path.read_text(), object_pairs_hook=unique_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON.")))
    except (RecursionError, UnicodeError):
        raise ValueError("The input file is not supported JSON.") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run bounded inference tests against existing services; no resources are created.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", type=Path, help="Validate a JSON plan. Add --execute to send requests.")
    mode.add_argument("--compare", type=Path, nargs="+", help="Compare report files offline.")
    parser.add_argument("--execute", action="store_true", help="Explicitly permit this plan's bounded inference requests.")
    parser.add_argument("--expect-account", help="Required for execution: expected 12-digit AWS account.")
    parser.add_argument("--output", type=Path, help="New output file; existing files are never overwritten.")
    parser.add_argument("--minimum-acceptance", type=float, default=95)
    parser.add_argument("--maximum-p95-ms", type=float)
    args = parser.parse_args(argv)
    output_stream = None
    try:
        if args.output and args.output.exists():
            raise ValueError("The output file already exists. Choose a new filename.")
        if args.compare:
            if args.execute:
                raise ValueError("--compare is an offline operation; omit --execute.")
            report = compare_benchmarks({
                "runs": [_load(path) for path in args.compare],
                "settings": {"minimumAcceptancePercent": args.minimum_acceptance, "maximumP95Ms": args.maximum_p95_ms},
            })
        else:
            plan = validate_plan(_load(args.plan))
            if not args.execute:
                print(json.dumps({
                    "valid": True, "planDigest": digest(plan), "provider": plan["target"]["provider"],
                    "scheduledRequests": len(plan["workload"]["tasks"]) * plan["settings"]["repetitions"],
                    "settings": plan["settings"],
                    "next": "Use --execute --expect-account YOUR_ACCOUNT_ID --output NEW_FILE.json to send requests.",
                    "charges": "Requests and existing capacity can incur charges. The deadline stops new requests; "
                               "in-flight requests use bounded network timeouts. No resources are created or removed.",
                }, indent=2))
                return 0
            if not args.output:
                raise ValueError("Execution requires --output so the experiment has a durable report.")
            if not args.expect_account or not re.fullmatch(r"\d{12}", args.expect_account):
                raise ValueError("Execution requires --expect-account with the intended AWS account.")
            import boto3
            from botocore.config import Config
            session = boto3.Session(region_name=plan["target"]["region"])
            identity = session.client("sts", config=Config(
                connect_timeout=3, read_timeout=5, retries={"total_max_attempts": 1},
            )).get_caller_identity()
            if identity.get("Account") != args.expect_account:
                raise ValueError("AWS credentials do not match --expect-account. No model request was sent.")
            # Reserve a writable, private output before sending billable requests.
            fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            output_stream = os.fdopen(fd, "w")
            adapter = LoopbackAdapter(plan) if plan["target"]["provider"] == "self_hosted" else AwsAdapter(plan, session)
            cost = public_price(plan)
            stop = threading.Event()
            previous_handler = signal.signal(signal.SIGINT, lambda *_: stop.set())
            try:
                report = run_plan(plan, adapter, cost, stopped=stop.is_set)
            finally:
                signal.signal(signal.SIGINT, previous_handler)
        if args.output:
            # Exclusive create prevents races/clobbering; owner-only protects local
            # model identities and measurements even though prompts are not exported.
            if output_stream is None:
                fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                output_stream = os.fdopen(fd, "w")
            json.dump(report, output_stream, indent=2, allow_nan=False)
            output_stream.write("\n")
            output_stream.flush()
            print(f"Report written to {args.output}")
        else:
            print(json.dumps(report, indent=2, allow_nan=False))
        return 0
    except Exception as exc:
        if isinstance(exc, (ValueError, OSError)):
            print(f"Benchmark stopped: {exc}", file=sys.stderr)
        else:
            print("Benchmark stopped: credentials, permissions or service access could not be verified.", file=sys.stderr)
        return 2
    finally:
        if output_stream is not None:
            output_stream.close()


if __name__ == "__main__":
    raise SystemExit(main())
