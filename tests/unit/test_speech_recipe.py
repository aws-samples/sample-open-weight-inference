"""Reviewed Magpie speech bundle and CPU trial contracts. AWS is faked.

None of these tests run the model; the bundle's real files are verified by
speech_bundle.py and the installer, and inference by a bounded trial.
"""
import base64
import hashlib
import io
import json
import tarfile
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

from api import handler
from catalog.candidates import GPU_RUNTIME_MISMATCH, build_snapshot, enumerate_candidates
from deploy import checkpoints as cp, recipes, speech
from deploy.inference import decoded_audio
from deploy.recipes import digest
from solver.models import GateStatus, Target
from solver.solve import solve

ACCOUNT = "123456789012"


def settings(**overrides):
    values = dict(
        account=ACCOUNT, region="us-east-1", environment="test",
        table="t", bucket="test-artifacts", kms_key="key", image="",
        execution_role="arn:aws:iam::123456789012:role/serving",
        subnets=("subnet-one", "subnet-two"), security_group="sg-private",
        worker_function="w", staging_function="s", inference_function="i", reconciler_function="r",
        speech_image=f"{ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/eddie-test-speech@sha256:" + "b" * 64,
    )
    values.update(overrides)
    return recipes.Settings(**values)


def published_manifest():
    document = speech.library_document()
    for row in document["files"]:
        row["versionId"] = "v-" + row["sha256"][:8]
    return document


def test_workshop_assets_stay_below_the_workshop_studio_object_limit():
    # The original failure: a 3,098,934,153-byte checkpoint ZIP against a
    # 1,000,000,000-byte limit. The speech bundle's files and archive bound fit.
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location(
        "package_assets", Path(__file__).resolve().parents[2] / "scripts/workshop/package_assets.py")
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    assert package.WORKSHOP_ASSET_LIMIT_BYTES == 1_000_000_000
    assert speech.BUNDLE_BYTES < package.WORKSHOP_ASSET_LIMIT_BYTES
    assert speech.MAX_ARCHIVE_BYTES < package.WORKSHOP_ASSET_LIMIT_BYTES


def test_oversized_asset_is_refused_before_upload(tmp_path):
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location(
        "package_assets", Path(__file__).resolve().parents[2] / "scripts/workshop/package_assets.py")
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    big = tmp_path / "too-big.zip"
    with big.open("wb") as file:
        file.truncate(package.WORKSHOP_ASSET_LIMIT_BYTES + 1)
    with pytest.raises(ValueError, match="at most 1,000,000,000 bytes"):
        package.check_asset_size(big)


def test_bundle_recipe_pins_model_codec_tokenizer_and_runtime():
    roles = {item["role"] for item in speech.BUNDLE["files"]}
    assert roles == {"tts", "codec", "tokenizer", "license"}
    assert len(speech.BUNDLE_FILES) == 14
    assert speech.BUNDLE["license"]["id"] == "NVIDIA Open Model License"
    assert speech.BUNDLE["runtime"]["revision"] == "0f706e43cf1fbc031bad1423e05460d3acaeaa1c"
    assert all(len(item["sha256"]) == 64 for item in speech.BUNDLE["files"])


def test_model_redistribution_notices_are_pinned_and_included():
    root = Path(speech.__file__).parent
    notices = [item for item in speech.BUNDLE["files"] if item["role"] == "license"]
    assert len(notices) == 2
    for item in notices:
        speech.verify_file(root / item["name"], item)
    assert "Licensed by NVIDIA Corporation under the NVIDIA Open Model License" in (
        root / "licenses/Notice.txt").read_text()
    assert "Redistribution." in (root / "licenses/NVIDIA-Open-Model-License.txt").read_text()


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "http://huggingface.co/model",
    "https://huggingface.co.attacker.example/model", "https://user:secret@huggingface.co/model",
])
def test_speech_bundle_downloader_refuses_unapproved_destinations_before_opening(url):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "speech_builder_test", Path(__file__).resolve().parents[2] / "scripts/workshop/speech_bundle.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    with pytest.raises(ValueError, match="Refusing"):
        builder._open(url)


def test_unknown_recipe_never_falls_back_to_the_gpu_execution_profile():
    from deploy.service import recipe_profile
    with pytest.raises(ValueError, match="not supported"):
        recipe_profile(settings(), "unknown-recipe")


def test_only_the_exact_reviewed_bundle_is_accepted():
    document = published_manifest()
    assert speech.validate_speech_manifest(document)
    for change in (
        lambda d: d["files"][0].update(sha256="0" * 64),
        lambda d: d["files"].append({"name": "extra.bin", "size": 1, "sha256": "1" * 64, "versionId": "v"}),
        lambda d: d.update(customization="fine-tuned"),
        lambda d: d["upstream"][0].update(revision="f" * 40),
        lambda d: d["license"].update(id="Apache-2.0"),
        lambda d: d["files"][1].update(versionId="null"),
    ):
        altered = json.loads(json.dumps(document))
        change(altered)
        with pytest.raises(ValueError):
            speech.validate_speech_manifest(altered)


def tar_with(entries):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz") as archive:
        for info, data in entries:
            archive.addfile(info, io.BytesIO(data) if data is not None else None)
    return raw.getvalue()


@pytest.mark.parametrize("entry", [
    (lambda: (tarfile.TarInfo("../escape"), b"x")),
    (lambda: (tarfile.TarInfo("model_weights.ckpt"), b"x")),
    (lambda: (setattr(info := tarfile.TarInfo("tokenizer/model_config.yaml"), "type", tarfile.SYMTYPE)
              or setattr(info, "linkname", "/etc/passwd") or (info, None))),
])
def test_unexpected_or_unsafe_archive_members_are_rejected_before_writing(tmp_path, entry):
    info, data = entry()
    if data is not None:
        info.size = len(data)
    archive = tmp_path / "bundle.tar.gz"
    archive.write_bytes(tar_with([(info, data)]))
    with pytest.raises(ValueError, match="unexpected or unsafe"):
        speech.extract_bundle(archive, tmp_path / "out")
    assert not any((tmp_path / "out").rglob("*")) if (tmp_path / "out").exists() else True


def test_truncated_member_fails_verification(tmp_path):
    name = "tokenizer/model_config.yaml"
    info = tarfile.TarInfo(name)
    info.size = 10
    archive = tmp_path / "bundle.tar.gz"
    archive.write_bytes(tar_with([(info, b"0123456789")]))
    with pytest.raises(ValueError):
        speech.extract_bundle(archive, tmp_path / "out")


class LibraryObjects:
    def __init__(self, objects):
        self.objects = objects

    def get_object(self, **args):
        assert args["ExpectedBucketOwner"] == ACCOUNT
        content, version = self.objects[args["Key"]]
        return {"Body": io.BytesIO(content), "VersionId": version, "ContentLength": len(content)}


def test_library_inspection_reports_speech_facts_without_llm_figures():
    document = published_manifest()
    identity = {**document, "files": [{k: row[k] for k in ("name", "size", "sha256")} for row in document["files"]]}
    key = f"checkpoints/eddie-test/shared/magpie-tts-v2607/{digest(identity)}/manifest.json"
    raw = json.dumps(document, sort_keys=True).encode()
    s3 = LibraryObjects({key: (raw, "manifest-v1")})
    source = f"s3://test-artifacts/{key}"
    metadata = cp.inspect_checkpoint(source, settings(), "project-1", s3)
    assert metadata["recipeId"] == speech.SPEECH_RECIPE_ID
    assert metadata["architecture"] == "magpietts" and metadata["modality"] == "TTS"
    assert metadata["lineage"] is None and metadata["customization"] == "published"
    assert metadata["revision"] == hashlib.sha256(raw).hexdigest()
    result = cp.inspection_result(metadata)
    assert result["fields"]["contextTokens"]["origin"] == "NOT_APPLICABLE"
    assert result["fields"]["totalParamsB"]["value"] == "0.284"
    assert result["checkpoint"]["componentBytes"]["codec"] == 78823104
    # Misplacing the manifest under another content identity is refused.
    wrong = key.replace(digest(identity), "0" * 64)
    with pytest.raises(ValueError, match="content identity"):
        cp.inspect_checkpoint(f"s3://test-artifacts/{wrong}", settings(), "project-1",
                              LibraryObjects({wrong: (raw, "manifest-v1")}))


def test_speech_recipe_has_its_own_readiness_image_and_fingerprint():
    ready = settings()
    assert ready.speech_ready and not ready.ready and ready.any_ready
    capability = ready.capability()
    assert capability["speechRecipe"]["available"] is True
    assert capability["speechRecipe"]["instanceType"] == "ml.m6g.xlarge"
    assert capability["checkpointRecipe"]["available"] is False
    fingerprint = ready.recipe_fingerprint(speech.SPEECH_RECIPE_ID, "SAGEMAKER_REALTIME")
    changed = settings(speech_image=ready.speech_image.replace("b" * 64, "c" * 64))
    assert changed.recipe_fingerprint(speech.SPEECH_RECIPE_ID, "SAGEMAKER_REALTIME") != fingerprint
    # A GPU serving image in the speech repository is not a speech image, and vice versa.
    assert not settings(speech_image=ready.speech_image.replace("-speech@", "-serving@")).speech_ready


def magpie_request(assume=False):
    req = handler.parse_request({
        "model": {"name": "Magpie TTS v2607", "sourceKind": "checkpoint",
                  "artifactDigest": "d" * 64, "architecture": "magpietts", "modality": "TTS",
                  "weightsGb": "0.603", "weightsExportable": True},
        "workload": {"horizonHours": "720"},
        "constraints": {"permittedRegions": ["us-east-1"]},
        "slos": [],
    })
    candidates = enumerate_candidates(req)
    return candidates, solve(req, candidates, build_snapshot(req, candidates, {}, "fixture", assume_cleared=assume))


def test_magpie_routes_show_why_import_and_gpu_recipes_are_ruled_out():
    candidates, decision = magpie_request()
    ids = {c.candidate_id for c in candidates}
    assert {"cmi-import", "sagemaker-ml.m6g.xlarge", "ec2-cpu-c7i.8xlarge", "batch-cpu-c7i.8xlarge"} <= ids
    every = {e.candidate.candidate_id: e for e in decision.ranked + decision.unresolved + decision.excluded}
    gate = lambda cid, name: next(g for g in every[cid].gates if g.name == name)
    assert gate("cmi-import", "architecture").status is GateStatus.FAIL
    assert "allowlist" in gate("cmi-import", "architecture").reason
    assert every["cmi-import"].cost is None
    for gpu in ("sagemaker-ml.g5.2xlarge", "sagemaker-ml.g6.2xlarge"):
        assert gate(gpu, "architecture").status is GateStatus.FAIL
        assert gate(gpu, "architecture").reason == GPU_RUNTIME_MISMATCH
    assert gate("sagemaker-ml.m6g.xlarge", "architecture").status is GateStatus.PASS
    assert gate("sagemaker-ml.m6g.xlarge", "modality").status is GateStatus.PASS
    cpu = next(c for c in candidates if c.candidate_id == "sagemaker-ml.m6g.xlarge")
    assert cpu.target is Target.SAGEMAKER_REALTIME and cpu.recipe_id == speech.SPEECH_RECIPE_ID


def wav(frames=2205, rate=22050, channels=1, width=2):
    raw = io.BytesIO()
    with wave.open(raw, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(width)
        out.setframerate(rate)
        out.writeframes(b"\x10\x00" * frames * channels)
    return raw.getvalue()


def test_returned_audio_must_decode_completely_in_the_recipe_format():
    audio = wav()
    assert decoded_audio(audio, {"audioSeconds": 0.1}) == {
        "decoded": True, "audioSeconds": 0.1, "sampleRateHz": 22050, "channels": 1,
        "bitsPerSample": 16, "frames": 2205}
    with pytest.raises(ValueError, match="22,050 Hz"):
        decoded_audio(wav(rate=16000), {"audioSeconds": 0.1378})
    with pytest.raises(ValueError, match="does not match"):
        decoded_audio(audio, {"audioSeconds": 5})
    with pytest.raises(ValueError, match="did not decode"):
        decoded_audio(audio[:20], {"audioSeconds": 0.1})
    with pytest.raises(ValueError):
        decoded_audio(wav(frames=0), {"audioSeconds": 0})


def test_a_review_read_back_from_dynamodb_hashes_as_approved():
    # Regression: the stager compared digest(review) after DynamoDB returned every
    # integer as Decimal, so json.dumps raised TypeError and preparation always failed.
    from decimal import Decimal
    from deploy.staging import from_store
    document = published_manifest()
    as_stored = json.loads(json.dumps(document), parse_int=Decimal)
    with pytest.raises(TypeError):
        digest(as_stored)
    assert digest(from_store(as_stored)) == digest(document)
    with pytest.raises(ValueError):
        from_store({"size": Decimal("1.5")})


def test_speech_receipt_is_storable_in_dynamodb(monkeypatch):
    # Regression: a float in the receipt made DynamoDB reject the job update, and the
    # caller saw a generic failure although valid audio had been produced.
    from boto3.dynamodb.types import TypeSerializer
    from deploy import inference
    audio = wav()
    body = {"audio": base64.b64encode(audio).decode(), "audioSha256": hashlib.sha256(audio).hexdigest(),
            "audioSeconds": 0.1, "synthesisSeconds": 0.2, "peakRssMiB": 900.5, "threads": 2}

    class Runtime:
        class exceptions:
            ModelError = type("ModelError", (Exception,), {})

        def invoke_endpoint(self, **_):
            return {"Body": io.BytesIO(json.dumps(body).encode()), "ResponseMetadata": {"RequestId": "r"}}

    monkeypatch.setattr(inference.boto3, "client", lambda *a, **k: Runtime())
    saved = {}

    class Store:
        def reserve_invocation(self, *a, **k): pass
        def lease_job(self, *a, **k):
            import contextlib
            return contextlib.nullcontext(False)
    job = SimpleNamespace(job_id="job-1")
    plan = SimpleNamespace(model_ref="s3://bucket/m.json", envelope=SimpleNamespace(instance_type="ml.m6g.xlarge"),
                           artifacts=[SimpleNamespace(kind="weights", digest="d" * 64)])
    endpoint = SimpleNamespace(region="us-east-1", physical_id="ep", arn="arn:ep")
    result = inference.invoke_speech(Store(), settings(), {"text": "Hello.", "speaker": "jason"},
                                     "project", job, plan, endpoint)
    serializer = TypeSerializer()
    for key, value in result["receipt"].items():
        serializer.serialize(value)  # raises TypeError for a float
    assert result["receipt"]["decoded"] is True and result["receipt"]["audioSeconds"] == "0.1"


def test_recorded_magpie_run_is_evidence_only_for_its_own_architecture():
    _, decision = magpie_request()
    every = {e.candidate.candidate_id: e for e in decision.ranked + decision.unresolved + decision.excluded}
    runtime = next(g for g in every["batch-cpu-c7i.8xlarge"].gates if g.name == "cpu_runtime")
    assert runtime.status is GateStatus.UNKNOWN  # Evidence informs; it never passes a gate.
    assert runtime.evidence_ref == "recorded-example:magpie-tts-v2607-sagemaker-m6g-20261003"
    record = json.loads((Path(__file__).resolve().parents[2] / "backend/catalog/speech_example.json").read_text())
    assert record["instance"] == speech.SPEECH_INSTANCE_TYPE
    assert record["artifactHashes"]["bundleArchive"] == "9034a43de72ea097a2ba59571ef85538a3f81500a048d133254871652bb8bad5"
    assert record["cleanup"]["endpointRemoved"] and record["cleanup"]["stagedFilesRemoved"]


@pytest.mark.parametrize("qualification,weights,failed_gate", [
    ({"cpuRuntime": "gpu-required"}, "0.603", "cpu_runtime"),
    ({}, "20", "cpu_memory"),
])
def test_sagemaker_cpu_candidate_cannot_bypass_cpu_constraints(qualification, weights, failed_gate):
    req = handler.parse_request({
        "model": {"name": "Magpie TTS v2607", "sourceKind": "checkpoint",
                  "artifactDigest": "d" * 64, "architecture": "magpietts", "modality": "TTS",
                  "weightsGb": weights, "weightsExportable": True},
        "workload": {"horizonHours": "720"}, "qualification": qualification,
        "constraints": {"permittedRegions": ["us-east-1"]}, "slos": [],
    })
    candidates = enumerate_candidates(req)
    decision = solve(req, candidates, build_snapshot(req, candidates, {}, "fixture", assume_cleared=True))
    cpu = next(e for e in decision.excluded if e.candidate.instance_type == speech.SPEECH_INSTANCE_TYPE)
    assert next(g for g in cpu.gates if g.name == failed_gate).status is GateStatus.FAIL
    assert not any(e.candidate.instance_type == speech.SPEECH_INSTANCE_TYPE for e in decision.ranked)


def test_assumed_account_checks_do_not_establish_cpu_memory_or_workload_performance():
    _, decision = magpie_request(assume=True)
    cpu = next(e for e in decision.unresolved if e.candidate.instance_type == speech.SPEECH_INSTANCE_TYPE)
    checks = {g.name: g for g in cpu.gates}
    assert all(checks[name].status is GateStatus.UNKNOWN for name in
               ("cpu_runtime", "cpu_memory", "cpu_delivery"))
    assert "16" in checks["cpu_memory"].reason
