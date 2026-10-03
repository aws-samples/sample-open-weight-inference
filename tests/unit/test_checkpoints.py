"""Fine-tuned BYO contracts. Tiny tensor files below are structural test fixtures.

AWS is faked; none of these tests establish deployed model quality or latency.
"""
import hashlib
import io
import json
import struct
from dataclasses import replace
from decimal import Decimal
from types import SimpleNamespace

import pytest

from api.handler import parse_request
from api.serialize import request_json
from deploy import checkpoints as cp, recipes, service, staging
from deploy.executor import admitted_plan
from deploy.models import approve, new_job
from deploy.store import InMemoryStore
from solver.models import LatencyEvidence


@pytest.fixture
def settings():
    return recipes.Settings(
        account="123456789012", region="us-east-1", environment="test",
        table="test-table", bucket="test-artifacts", kms_key="key",
        image="123456789012.dkr.ecr.us-east-1.amazonaws.com/eddie-test-serving@sha256:" + "a" * 64,
        execution_role="arn:aws:iam::123456789012:role/serving",
        subnets=("subnet-one", "subnet-two"), security_group="sg-private",
        worker_function="worker", staging_function="stager",
        inference_function="inference", reconciler_function="reconciler",
    )


class ObjectStore:
    def __init__(self):
        self.objects = {}
        self.reads = []
        self.writes = []

    def get_object(self, **args):
        self.reads.append(args)
        content, version = self.objects[args["Key"]]
        assert args["ExpectedBucketOwner"] == "123456789012"
        if "VersionId" in args:
            assert args["VersionId"] == version
        total = len(content)
        if "Range" in args:
            start, end = map(int, args["Range"].removeprefix("bytes=").split("-"))
            content = content[start:end + 1]
        return {"Body": io.BytesIO(content), "VersionId": version, "ContentLength": total}

    def put_object(self, **args):
        body = args["Body"]
        self.writes.append({**args, "Body": body.read() if hasattr(body, "read") else body})


@pytest.fixture
def checkpoint(settings):
    def raw(value):
        return json.dumps(value, separators=(",", ":")).encode()

    header = raw({"model.embed_tokens.weight": {
        "dtype": "BF16", "shape": [2, 4], "data_offsets": [0, 16],
    }})
    files = {
        "config.json": raw({"architectures": ["Qwen2ForCausalLM"], "model_type": "qwen2",
                            "torch_dtype": "bfloat16", "max_position_embeddings": 32768}),
        "tokenizer_config.json": raw({"tokenizer_class": "Qwen2Tokenizer",
                                      "chat_template": "{{ messages }}"}),
        "tokenizer.json": raw({"test": "structural fixture"}),
        "model.safetensors": struct.pack("<Q", len(header)) + header + b"\0" * 16,
    }
    document = {
        "schemaVersion": 1, "name": "Structural test checkpoint",
        "artifactFormat": "merged-checkpoint", "customization": "fine-tuned",
        "baseModel": {"source": "Qwen/Qwen2.5-1.5B-Instruct", "revision": "b" * 40},
        "lineage": {"trainingRun": "unit-test-supplied-lineage", "trainingDataSha256": "c" * 64},
        "license": {"id": "apache-2.0", "url": "https://example.com/terms"},
        "files": [{"name": name, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                  for name, content in sorted(files.items())],
    }
    identity = recipes.digest(document)
    prefix = cp.checkpoint_root(settings) + "shared/test-model/" + identity + "/"
    store = ObjectStore()
    for item in document["files"]:
        item["versionId"] = "pinned-" + item["name"]
        store.objects[prefix + "files/" + item["name"]] = (files[item["name"]], item["versionId"])
    key = prefix + "manifest.json"
    store.objects[key] = (raw(document), "manifest-version")
    return store, f"s3://{settings.bucket}/{key}", document


def test_reads_actual_tensor_count_and_distinguishes_base_from_checkpoint(settings, checkpoint):
    s3, source, _ = checkpoint
    result = cp.inspect_checkpoint(source, settings, "user:alice", s3)
    assert result["source"] == source
    assert result["totalParamsB"] == "8E-9"  # No parameter count inferred from the base name.
    assert result["baseModel"]["source"] == "Qwen/Qwen2.5-1.5B-Instruct"
    assert result["revision"] != result["baseModel"]["revision"]
    assert result["lineageStatus"] == "SUPPLIED"
    assert result["fullContentVerified"] is False
    assert all("VersionId" in row for row in s3.reads[1:])
    view = cp.inspection_result(result)
    assert view["checkpoint"]["revision"] == result["revision"]
    assert view["ok"] is True and view["error"] is None


@pytest.mark.parametrize("source", [
    "s3://other-bucket/checkpoints/anything/manifest.json",
    "https://example.com/manifest.json",
    "file:///tmp/manifest.json",
    "s3://test-artifacts/models/test/manifest.json",
    "s3://test-artifacts/checkpoints/eddie-test/shared/a/../manifest.json",
])
def test_out_of_scope_sources_are_refused_before_aws(settings, source):
    s3 = ObjectStore()
    with pytest.raises(ValueError):
        cp.inspect_checkpoint(source, settings, "user:alice", s3)
    assert s3.reads == []


def test_other_project_namespace_cannot_be_read(settings, checkpoint):
    s3, source, _ = checkpoint
    source = source.replace("/shared/", "/" + cp.project_namespace("user:bob") + "/")
    with pytest.raises(ValueError, match="not in your project"):
        cp.inspect_checkpoint(source, settings, "user:alice", s3)
    assert s3.reads == []


@pytest.mark.parametrize("change", ["adapter", "duplicate", "code", "version", "digest", "too_large"])
def test_rejects_non_executable_or_unpinned_exports(checkpoint, change):
    _, _, document = checkpoint
    if change == "adapter":
        document["artifactFormat"] = "lora-adapter"
    elif change == "duplicate":
        document["files"].append(document["files"][0].copy())
    elif change == "code":
        document["files"][0]["name"] = "modeling_custom.py"
    elif change == "version":
        document["files"][0]["versionId"] = "null"
    elif change == "digest":
        document["files"][0]["sha256"] = "not-a-digest"
    else:
        document["files"][0]["size"] = cp.CHECKPOINT_MAX_FILE_BYTES + 1
    with pytest.raises(ValueError):
        cp.validate_manifest(document)


def test_detects_pinned_metadata_tampering(settings, checkpoint):
    s3, source, _ = checkpoint
    key = next(key for key in s3.objects if key.endswith("/config.json"))
    raw, version = s3.objects[key]
    s3.objects[key] = (raw.replace(b"32768", b"32769"), version)
    with pytest.raises(ValueError, match="content check"):
        cp.inspect_checkpoint(source, settings, "user:alice", s3)


def test_rejects_changed_manifest_revision(settings, checkpoint):
    s3, source, _ = checkpoint
    with pytest.raises(ValueError, match="manifest changed"):
        cp.inspect_checkpoint(source, settings, "user:alice", s3, "d" * 64)


def test_rejects_custom_code_and_quantized_config():
    config = {"architectures": ["Qwen2ForCausalLM"], "model_type": "qwen2",
              "torch_dtype": "bfloat16", "max_position_embeddings": 32768}
    tokenizer = {"tokenizer_class": "Qwen2TokenizerFast", "chat_template": "{{ messages }}"}
    with pytest.raises(ValueError, match="custom repository code"):
        cp.validate_config({**config, "auto_map": {"AutoModel": "custom.Model"}}, tokenizer)
    with pytest.raises(ValueError, match="Quantized"):
        cp.validate_config({**config, "quantization_config": {"bits": 4}}, tokenizer)


def prepare(settings, checkpoint, monkeypatch):
    s3, source, _ = checkpoint
    monkeypatch.setattr(service, "client", lambda *args: s3)
    monkeypatch.setattr(service, "safety_checks", lambda *_: [service.check("test", True, "test", "fixture")])
    import catalog.pricing
    monkeypatch.setattr(catalog.pricing, "sagemaker_hosting_rate", lambda *args: SimpleNamespace(
        amount=Decimal("1.52"), unit="USD/Hrs", currency="USD", region="us-east-1",
        sku="test-price", effective_date="2026-09-01", source="test fixture",
    ))
    store = InMemoryStore()
    app = service.DeploymentService(settings, store)
    actor = SimpleNamespace(subject="alice", username="Alice")
    result = app.prepare({"source": source, "caseFingerprint": "c" * 64}, actor, "user:alice")
    plan = store.get_plan("user:alice", result["plan"]["planId"])
    approval = approve(plan, subject="alice", username="Alice", capability="approve")
    store.put_approval(approval)
    job = new_job(plan, approval, subject="alice")
    job, _ = store.launch(plan, approval, job, limit=1, account_limit=2)
    return store, job, plan


def test_real_recipe_preserves_checkpoint_identity_into_approval_and_staging(settings, checkpoint, monkeypatch):
    s3, source, _ = checkpoint
    store, job, plan = prepare(settings, checkpoint, monkeypatch)
    assert plan.model_ref == source
    assert plan.recipe_id == cp.CHECKPOINT_RECIPE_ID
    assert admitted_plan(store, settings, job).model_ref == source
    monkeypatch.setattr(staging, "client", lambda *args: s3)
    monkeypatch.setattr(staging, "open_url", lambda *args, **kwargs: pytest.fail("Private BYO must not fetch the base model"))
    staging.stage(store, settings, job)
    receipt = json.loads(next(row["Body"] for row in s3.writes if row["Key"].endswith("/receipt.json")))
    assert receipt["model"] == source and receipt["fullContentVerified"]
    assert receipt["sourceKind"] == "checkpoint"
    assert all(row["ServerSideEncryption"] == "aws:kms" for row in s3.writes)
    assert not any(row["Key"].startswith("checkpoints/") for row in s3.writes)
    assert any(row.get("VersionId") == "manifest-version" for row in s3.reads)


def test_corrupted_weight_bytes_never_complete_preparation(settings, checkpoint, monkeypatch):
    s3, _, _ = checkpoint
    store, job, _ = prepare(settings, checkpoint, monkeypatch)
    key = next(key for key in s3.objects if key.endswith(".safetensors"))
    raw, version = s3.objects[key]
    s3.objects[key] = (raw[:-1] + b"\1", version)
    monkeypatch.setattr(staging, "client", lambda *args: s3)
    with pytest.raises(ValueError, match="content check"):
        staging.stage(store, settings, job)
    assert not any(row["Key"].endswith("receipt.json") for row in s3.writes)
    assert store.list_resources(job.job_id)  # Partial files remain owned for cleanup.


def test_checkpoint_change_reaches_the_solver_and_changes_request_identity():
    body = {"model": {"name": "Acme checkpoint", "architecture": "Qwen2ForCausalLM",
                     "sourceKind": "checkpoint", "artifactDigest": "a" * 64},
            "workload": {"horizonHours": "720"}}
    first = parse_request(body)
    assert first.model.artifact_digest == "a" * 64
    assert request_json(first)["model"]["artifactDigest"] == "a" * 64
    body["model"]["artifactDigest"] = "b" * 64
    assert request_json(parse_request(body)) != request_json(first)
    body["model"].pop("artifactDigest")
    with pytest.raises(ValueError, match="identity is missing"):
        parse_request(body)


def test_base_model_benchmark_cannot_become_fine_tuned_model_measurement():
    evidence = LatencyEvidence(
        p50_ms=Decimal("100"), p99_ms=Decimal("200"), sample_count=1000,
        benchmark_run_id="real-run", validated=True, measured_candidate_id="same-gpu",
        metrics_covered=("p99_latency_ms",), measured_model_digest="a" * 64,
    )
    assert evidence.applicability("same-gpu", "p99_latency_ms", None, "a" * 64) is None
    assert "exact model checkpoint" in evidence.applicability("same-gpu", "p99_latency_ms", None, "b" * 64)
    assert "exact model checkpoint" in replace(evidence, measured_model_digest=None).applicability(
        "same-gpu", "p99_latency_ms", None, "b" * 64,
    )
