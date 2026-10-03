"""Reviewed deployment recipes. A catalog listing is not an executable recipe."""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.request
from dataclasses import dataclass
from typing import Any

from netio import open_url

RECIPE_ID = "sagemaker-qwen-small-vllm"
RECIPE_VERSION = "1.0.0"
MODEL_SOURCES = ("Qwen/Qwen2.5-0.5B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct")
#: Recipe metadata is read from the public model registry and nowhere else.
HF_HOSTS = ("huggingface.co", "hf.co")
INSTANCE_TYPE = "ml.g5.2xlarge"
QUOTA_CODE = "L-9614C779"
MAX_MODEL_BYTES = 4 * 1024**3
MAX_FILE_BYTES = MAX_MODEL_BYTES
INFERENCE_AMI = "al2-ami-sagemaker-inference-gpu-3-1"
MODEL_FILES = frozenset({
    "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
    "vocab.json", "merges.txt", "special_tokens_map.json", "added_tokens.json",
    "model.safetensors", "model.safetensors.index.json", "LICENSE",
})


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def model_source(value: Any) -> str:
    source = str(value or "").strip().removeprefix("https://huggingface.co/").rstrip("/")
    if source not in MODEL_SOURCES:
        raise ValueError(
            "This installation can currently deploy Qwen2.5 0.5B or 1.5B Instruct. "
            "Other models need a reviewed deployment recipe; the selected model was not substituted."
        )
    return source


def hf_json(path: str) -> dict[str, Any]:
    request = urllib.request.Request(
        "https://huggingface.co/" + path.lstrip("/"), headers={"Accept": "application/json"},
    )
    with open_url(request, timeout=20, allowed_hosts=HF_HOSTS) as response:
        raw = response.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError("Model metadata exceeds the inspection limit.")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("The model source returned invalid metadata.")
    return value


def inspect_recipe_model(source: str, revision: str | None = None) -> dict[str, Any]:
    source = model_source(source)
    if revision and not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Use the exact model revision returned by inspection.")
    metadata = hf_json(f"api/models/{source}" + (f"/revision/{revision}" if revision else "") + "?blobs=true")
    commit = metadata.get("sha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or (revision and commit != revision):
        raise ValueError("The model revision could not be pinned.")
    config = hf_json(f"{source}/resolve/{commit}/config.json")
    if config.get("architectures") != ["Qwen2ForCausalLM"] or config.get("auto_map"):
        raise ValueError("This recipe requires native Qwen2ForCausalLM without remote code.")
    files = []
    for entry in metadata.get("siblings", []):
        name = entry.get("rfilename", "")
        if name not in MODEL_FILES and not re.fullmatch(r"model-\d{5}-of-\d{5}\.safetensors", name):
            continue
        size = entry.get("size")
        lfs = entry.get("lfs") or {}
        if not isinstance(size, int) or size <= 0 or size > MAX_FILE_BYTES:
            raise ValueError("A model file has an unknown or unsupported size.")
        sha = lfs.get("sha256") or entry.get("blobId")
        algorithm = "sha256" if lfs else "git-blob-sha1"
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}" if lfs else r"[0-9a-f]{40}", sha):
            raise ValueError("A model file has no verifiable content identity.")
        files.append({"name": name, "size": size, "digest": sha, "algorithm": algorithm})
    names = {f["name"] for f in files}
    if not {"config.json", "tokenizer.json", "tokenizer_config.json", "LICENSE"} <= names:
        raise ValueError("Required model, tokenizer or licence files are missing.")
    if not any(n.endswith(".safetensors") for n in names):
        raise ValueError("Only safetensors weights are supported by this recipe.")
    size = sum(f["size"] for f in files)
    if size > MAX_MODEL_BYTES:
        raise ValueError("This recipe accepts up to 4 GiB of model artifacts.")
    license_name = (metadata.get("cardData") or {}).get("license")
    if license_name != "apache-2.0":
        raise ValueError("This recipe requires the published Apache-2.0 licence. No terms were accepted.")
    return {
        "source": source, "revision": commit, "files": sorted(files, key=lambda f: f["name"]),
        "bytes": size, "architecture": "Qwen2ForCausalLM", "license": license_name,
        "licenseUrl": f"https://huggingface.co/{source}/blob/{commit}/LICENSE",
    }


@dataclass(frozen=True)
class Settings:
    account: str
    region: str
    environment: str
    table: str
    bucket: str
    kms_key: str
    image: str
    execution_role: str
    subnets: tuple[str, ...]
    security_group: str
    worker_function: str
    staging_function: str
    inference_function: str
    reconciler_function: str
    speech_image: str = ""

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            account=os.environ.get("EDDIE_ACCOUNT_ID", ""),
            region=os.environ.get("EDDIE_REGION", os.environ.get("AWS_REGION", "")),
            environment=os.environ.get("EDDIE_ENVIRONMENT", ""),
            table=os.environ.get("DEPLOYMENT_TABLE", ""),
            bucket=os.environ.get("EDDIE_ARTIFACT_BUCKET", ""),
            kms_key=os.environ.get("EDDIE_DATA_KEY", ""),
            image=os.environ.get("EDDIE_SERVING_IMAGE", ""),
            execution_role=os.environ.get("EDDIE_SAGEMAKER_EXECUTION_ROLE_ARN", ""),
            subnets=tuple(filter(None, os.environ.get("EDDIE_SERVING_SUBNETS", "").split(","))),
            security_group=os.environ.get("EDDIE_SERVING_SECURITY_GROUP", ""),
            worker_function=os.environ.get("EDDIE_DEPLOYMENT_WORKER", ""),
            staging_function=os.environ.get("EDDIE_ARTIFACT_STAGER", ""),
            inference_function=os.environ.get("EDDIE_INFERENCE_FUNCTION", ""),
            reconciler_function=os.environ.get("EDDIE_RECONCILER_FUNCTION", ""),
            speech_image=os.environ.get("EDDIE_SPEECH_IMAGE", ""),
        )

    def _image(self, repository: str) -> str:
        return (rf"{re.escape(self.account)}\.dkr\.ecr\.{re.escape(self.region)}\.amazonaws\.com/"
                rf"eddie-{re.escape(self.environment)}-{repository}@sha256:[0-9a-f]{{64}}")

    @property
    def infrastructure_ready(self) -> bool:
        """The private network, roles, ledger and cleanup are present; no image implied."""
        return bool(
            re.fullmatch(r"\d{12}", self.account) and self.region and self.environment
            and self.table and self.bucket and self.kms_key
            and self.execution_role and len(self.subnets) >= 2 and self.security_group
            and self.worker_function and self.staging_function and self.inference_function
            and self.reconciler_function
        )

    @property
    def ready(self) -> bool:
        """The reviewed GPU text recipes: the vLLM serving image is configured."""
        return self.infrastructure_ready and bool(re.fullmatch(self._image("(?:kms-)?serving"), self.image))

    @property
    def speech_ready(self) -> bool:
        """The reviewed Magpie CPU recipe: the Magpie-only image is configured."""
        return self.infrastructure_ready and bool(re.fullmatch(self._image("speech"), self.speech_image))

    @property
    def any_ready(self) -> bool:
        return self.ready or self.speech_ready

    @property
    def fingerprint(self) -> str:
        # Infrastructure, engine arguments and AMI are part of the approved substance.
        return digest({
            "account": self.account, "region": self.region, "image": self.image,
            "role": self.execution_role, "subnets": self.subnets, "securityGroup": self.security_group,
            "bucket": self.bucket, "kms": self.kms_key, "instance": INSTANCE_TYPE,
            "ami": INFERENCE_AMI, "environment": serving_environment(),
            "recipe": [RECIPE_ID, RECIPE_VERSION],
        })

    def recipe_fingerprint(self, recipe: str, target: str) -> str:
        if recipe == RECIPE_ID and target == "SAGEMAKER_REALTIME":
            return self.fingerprint
        from .speech import SPEECH_RECIPE_ID, SPEECH_RECIPE_VERSION, SPEECH_INSTANCE_TYPE, speech_environment
        if recipe == SPEECH_RECIPE_ID and target == "SAGEMAKER_REALTIME":
            # The speech recipe has its own image and CPU instance; it does not
            # depend on the GPU serving image being configured.
            return digest({
                "account": self.account, "region": self.region, "image": self.speech_image,
                "role": self.execution_role, "subnets": self.subnets, "securityGroup": self.security_group,
                "bucket": self.bucket, "kms": self.kms_key, "instance": SPEECH_INSTANCE_TYPE,
                "environment": speech_environment(), "recipe": [recipe, SPEECH_RECIPE_VERSION],
                "target": target,
            })
        from .checkpoints import CHECKPOINT_RECIPE_ID, CHECKPOINT_RECIPE_VERSION
        if recipe != CHECKPOINT_RECIPE_ID or target != "SAGEMAKER_REALTIME":
            raise ValueError("The deployment recipe is not supported.")
        return digest({
            "base": self.fingerprint, "recipe": [recipe, CHECKPOINT_RECIPE_VERSION],
            "target": target, "servingEnvironment": serving_environment(checkpoint=True),
        })

    def capability(self) -> dict[str, Any]:
        from .speech import SPEECH_RECIPE_ID, SPEECH_RECIPE_VERSION, SPEECH_INSTANCE_TYPE, BUNDLE
        reviewed = [label for label, ok in (("reviewed small Qwen text models on one GPU", self.ready),
                                            ("the Magpie speech bundle on one CPU instance", self.speech_ready)) if ok]
        return {
            "targets": [
                {"target": "SAGEMAKER_REALTIME", "label": "Amazon SageMaker",
                 "available": self.any_ready,
                 "reason": ("Short, authenticated tests of " + " and ".join(reviewed) + "."
                            if reviewed else "The serving image or private deployment infrastructure is not configured.")},
                {"target": "BEDROCK_CMI", "label": "Import into Amazon Bedrock", "available": False,
                 "reason": "Custom Model Import can be evaluated. Import execution is not implemented in this installation."},
                {"target": "EC2_GPU", "label": "Amazon EC2 GPU", "available": False,
                 "reason": "Deployment execution for EC2 GPU servers is not implemented yet."},
            ],
            "canCreatePlans": self.any_ready,
            "speechRecipe": {
                "id": SPEECH_RECIPE_ID, "version": SPEECH_RECIPE_VERSION,
                "available": self.speech_ready, "bundle": BUNDLE["id"],
                "instanceType": SPEECH_INSTANCE_TYPE, "maximumLifetimeMinutes": 60,
                "targets": ["SAGEMAKER_REALTIME"],
                "note": ("The reviewed Magpie TTS v2607 bundle from your model library, unchanged, "
                         "in a Magpie-only NeMo-Speech.cpp image on one Graviton CPU instance. "
                         "One request at a time; audio is returned to you and not stored."
                         if self.speech_ready else
                         "The Magpie-only speech image is not configured in this installation."),
            },
            "checkpointRecipe": {
                "id": "byo-qwen2-safetensors", "version": "1.0.0",
                "available": self.ready, "maximumModelGiB": 18,
                "architectures": ["Qwen2ForCausalLM"],
                "targets": ["SAGEMAKER_REALTIME"],
                "note": "Full or merged BF16 fine-tunes of Qwen2.5 0.5B, 1.5B or 7B. Custom code and adapter-only exports need another recipe.",
            },
            "recipes": [{"id": RECIPE_ID, "version": RECIPE_VERSION, "models": list(MODEL_SOURCES),
                         "available": self.ready,
                         "region": self.region, "instanceType": INSTANCE_TYPE,
                         "maximumLifetimeMinutes": 60}],
            "note": "A test deployment does not certify answer quality or p99 latency. Review its cost and expiry before approving.",
        }


def serving_environment(*, checkpoint: bool = False) -> dict[str, str]:
    return {
        "SM_VLLM_MODEL": "/opt/ml/model",
        "SM_VLLM_SERVED_MODEL_NAME": "eddie-model",
        "SM_VLLM_MAX_MODEL_LEN": "4096",
        "SM_VLLM_MAX_NUM_SEQS": "2" if checkpoint else "4",
        "SM_VLLM_GPU_MEMORY_UTILIZATION": "0.88" if checkpoint else "0.70",
        "SM_VLLM_DTYPE": "bfloat16",
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1",
        "VLLM_NO_USAGE_STATS": "1", "VLLM_LOGGING_LEVEL": "WARNING",
    }
