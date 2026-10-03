"""Read a model's technical properties from its source, without running its code.

Why this exists: EDDIE previously asked a first-time user to supply an architecture
class, a parameter count, a context length, a weights size and a licence identifier
before it would evaluate anything. Those are properties *of the model*, discoverable
from its published metadata, and a novice inventing them is how a wrong `weights_gb`
silently changes which instances look feasible.

Three rules hold this module honest:

1.  **Detected means retrieved.** Every value carries the URL it came from, the
    repository revision it was read at, and when. A value we could not retrieve is
    `NOT_DETECTED` with the reason, never a plausible number. There are no presets
    or name-pattern heuristics here: "Llama-3.1-8B" does not imply 8e9 parameters.
2.  **No repository code is executed.** Only JSON metadata is read. `trust_remote_code`
    models are inspected the same way; their custom modelling code is never imported.
3.  **The manifest defines the weights, not the file listing.** Repositories commonly
    publish the same tensors twice -- a sharded `model-0000n-of-000NN.safetensors` set
    plus a `consolidated.safetensors` or an `original/*.pth` for another runtime.
    Summing the listing double-counts: Mistral-7B reads 27.00 GiB instead of 13.50,
    which would size an instance for roughly twice the memory the model needs. The
    shard manifest is authoritative about which files constitute one copy.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from urllib.parse import quote
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from netio import open_url
from .inference_profile import inference_profile

HF_API = "https://huggingface.co/api"
HF_HOST = "https://huggingface.co"
#: Inspection only ever reads the public model registry. Pinning the host stops a
#: malformed repository reference from turning a metadata read into a request
#: somewhere else, and stops a non-HTTPS scheme from reaching urlopen at all.
HF_HOSTS = ("huggingface.co", "hf.co")
USER_AGENT = "eddie-model-inspector/1.0"
TIMEOUT_SECONDS = 20
GIB = Decimal(1024**3)

# A repository id, as `owner/name`. Anything else is rejected before a request is
# made, so a caller cannot steer the inspector at another host or path.
HF_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")

# Weight containers we can account for. `.gguf` is listed because a repo may hold
# only GGUF; it is reported, though no current recipe imports it.
WEIGHT_SUFFIXES = (".safetensors", ".bin", ".pth", ".gguf")

# Shard manifests, in preference order. The first that exists defines one copy.
INDEX_FILES = ("model.safetensors.index.json", "pytorch_model.bin.index.json")

# Paths that hold a second copy of the same tensors for a different runtime.
# Excluded only when a manifest is absent and we are falling back to the listing.
DUPLICATE_PREFIXES = ("original/",)
DUPLICATE_STEMS = ("consolidated",)


class Origin:
    """Where a value came from. Mirrors the labels the interface shows."""

    DETECTED = "DETECTED"
    NOT_DETECTED = "NOT_DETECTED"
    NOT_APPLICABLE = "NOT_APPLICABLE"


@dataclass(frozen=True)
class Detected:
    """One property, with its provenance or the reason it is missing.

    `value` is `None` exactly when `origin` is not `DETECTED`. Callers must not
    substitute a default for `None`; that is the whole point of the type.
    """

    origin: str
    value: Optional[str] = None
    detail: Optional[str] = None
    source_url: Optional[str] = None

    @property
    def detected(self) -> bool:
        return self.origin == Origin.DETECTED

    def to_json(self) -> dict[str, Any]:
        return {
            "origin": self.origin,
            "value": self.value,
            "detail": self.detail,
            "sourceUrl": self.source_url,
        }


def _missing(detail: str) -> Detected:
    return Detected(origin=Origin.NOT_DETECTED, detail=detail)


@dataclass
class ModelInspection:
    """The result of inspecting one source.

    `revision` is the resolved commit, not a branch name: a later inspection of
    `main` is a different revision and its values are not interchangeable.
    """

    source: str
    repo: str
    revision: Optional[str]
    retrieved_at: str
    ok: bool
    error: Optional[str] = None
    # Access state. `gated` repositories need terms accepted by the account whose
    # credentials will fetch the weights; that is an unresolved requirement, not a
    # failure to detect, and not something a typed licence identifier satisfies.
    access: str = "UNKNOWN"
    access_detail: Optional[str] = None
    architecture: Detected = field(default_factory=lambda: _missing("not inspected"))
    total_params_b: Detected = field(default_factory=lambda: _missing("not inspected"))
    context_tokens: Detected = field(default_factory=lambda: _missing("not inspected"))
    weights_gb: Detected = field(default_factory=lambda: _missing("not inspected"))
    precision: Detected = field(default_factory=lambda: _missing("not inspected"))
    license_id: Detected = field(default_factory=lambda: _missing("not inspected"))
    weight_files: int = 0
    notes: tuple[str, ...] = ()
    inference: Optional[dict[str, Any]] = None
    modality: Detected = field(default_factory=lambda: _missing("No supported task type was published."))

    def to_json(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "repo": self.repo,
            "revision": self.revision,
            "retrievedAt": self.retrieved_at,
            "ok": self.ok,
            "error": self.error,
            "access": self.access,
            "accessDetail": self.access_detail,
            "weightFiles": self.weight_files,
            "notes": list(self.notes),
            "inference": self.inference,
            "fields": {
                "architecture": self.architecture.to_json(),
                "modality": self.modality.to_json(),
                "totalParamsB": self.total_params_b.to_json(),
                "contextTokens": self.context_tokens.to_json(),
                "weightsGb": self.weights_gb.to_json(),
                "precision": self.precision.to_json(),
                "licenseId": self.license_id.to_json(),
            },
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _fetch(url: str, token: Optional[str] = None) -> tuple[int, Any]:
    """GET JSON. Returns the status and either parsed JSON or an error string.

    Never raises for an HTTP status: a 401 on a gated repository is an expected
    outcome that must be reported to the user, not an exception that loses the
    partial result already gathered.
    """
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with open_url(request, timeout=TIMEOUT_SECONDS, allowed_hosts=HF_HOSTS) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                return 0, "Model metadata exceeds the inspection size limit."
            return response.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            body = ""
        return exc.code, body
    except json.JSONDecodeError:
        return 200, None
    except Exception as exc:  # noqa: BLE001  (timeout, DNS, TLS)
        return 0, f"{type(exc).__name__}: {exc}"


def _precision_from_dtype(dtype: Optional[str]) -> Optional[str]:
    """Map a torch dtype to the solver's precision vocabulary.

    Unrecognised dtypes return None so the field stays NOT_DETECTED. Quantisation
    is a recipe with quality consequences, never inferred from a config string.
    """
    return {
        "bfloat16": "BF16",
        "float16": "FP16",
        "half": "FP16",
        "float8_e4m3fn": "FP8",
        "int8": "INT8",
    }.get((dtype or "").lower())


def _file_size(entry: dict[str, Any]) -> int:
    """LFS size when present: `size` on an LFS pointer is the pointer, not the blob."""
    lfs = entry.get("lfs") or {}
    return int(lfs.get("size") or entry.get("size") or 0)


def _weights_from_manifest(
    tree: list[dict[str, Any]], repo: str, revision: str, token: Optional[str]
) -> tuple[Optional[int], int, Optional[str], Optional[str]]:
    """Total bytes of one copy of the weights.

    Returns (bytes, file_count, source_url, note). Prefers a shard manifest, which
    states exactly which files form one copy. Without one, falls back to the file
    listing with known duplicate locations excluded.
    """
    by_path = {entry.get("path", ""): entry for entry in tree}

    for index_name in INDEX_FILES:
        if index_name not in by_path:
            continue
        url = f"{HF_HOST}/{repo}/resolve/{revision}/{index_name}"
        status, index = _fetch(url, token)
        if status != 200 or not isinstance(index, dict):
            continue
        weight_map = index.get("weight_map")
        if not isinstance(weight_map, dict) or not weight_map:
            continue
        # Distinct shard filenames: many tensors map to the same file.
        shards = sorted(set(weight_map.values()))
        total = 0
        missing: list[str] = []
        for shard in shards:
            entry = by_path.get(shard)
            if entry is None:
                missing.append(shard)
                continue
            total += _file_size(entry)
        if missing:
            return (
                None,
                len(shards),
                url,
                f"manifest {index_name} lists {len(missing)} file(s) absent from the "
                f"repository listing, so the total would be understated",
            )
        return total, len(shards), url, None

    # No manifest. Single-file repositories are the common case here.
    candidates = [
        entry
        for path, entry in by_path.items()
        if path.endswith(WEIGHT_SUFFIXES)
        and not path.startswith(DUPLICATE_PREFIXES)
        and path.rsplit("/", 1)[-1].rsplit(".", 1)[0] not in DUPLICATE_STEMS
    ]
    if not candidates:
        return None, 0, None, "no weight files found in the repository listing"
    total = sum(_file_size(entry) for entry in candidates)
    note = None
    if len(candidates) > 1:
        # A uniform `model-00001-of-00004.safetensors` set is self-evidently one
        # copy: the names state how many parts there are. Warning about it added
        # noise to the common gated-repository case, where the manifest itself is
        # behind the gate but the shard names are still visible.
        names = [path.rsplit("/", 1)[-1] for path in _paths_of(candidates, by_path)]
        extensions = {name.rsplit(".", 1)[-1] for name in names}
        sharded = all("-of-" in name for name in names) and len(extensions) == 1
        if not sharded:
            # Mixed formats with no manifest to say which files form one copy.
            # Report the sum, and say it may double-count, rather than presenting a
            # possibly-doubled figure as a measurement.
            note = (
                f"no shard manifest; summed {len(candidates)} weight files, which "
                f"overstates the total if the repository ships more than one format"
            )
    return total, len(candidates), f"{HF_API}/models/{repo}/tree/{revision}", note


def _paths_of(
    entries: list[dict[str, Any]], by_path: dict[str, dict[str, Any]]
) -> list[str]:
    """Paths for the given entries, using the listing's own keys."""
    wanted = {id(entry) for entry in entries}
    return [path for path, entry in by_path.items() if id(entry) in wanted]


def inspect_hf_model(
    repo: str, revision: Optional[str] = None, token: Optional[str] = None
) -> ModelInspection:
    """Inspect a Hugging Face repository's published metadata.

    Partial success is the normal case and is preserved: a gated repository hides
    `config.json` (so architecture, context and precision stay undetected) while
    still exposing its file listing and parameter count. Returning nothing because
    one request failed would throw away facts the user can act on.
    """
    repo = (repo or "").strip().removeprefix("https://huggingface.co/").strip("/")
    inspection = ModelInspection(
        source="huggingface",
        repo=repo,
        revision=revision,
        retrieved_at=_now(),
        ok=False,
    )
    if not HF_REPO_RE.match(repo):
        inspection.error = (
            "Expected a Hugging Face repository as owner/name, for example "
            "mistralai/Mistral-7B-Instruct-v0.3."
        )
        return inspection

    if revision is not None and (
        not isinstance(revision, str) or not revision or len(revision) > 160
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", revision)
        or any(part in (".", "..", "") for part in revision.split("/"))
    ):
        inspection.error = "Use a valid model revision or commit."
        return inspection
    info_url = f"{HF_API}/models/{repo}"
    if revision:
        # Parameter counts and config must describe the same revision.
        info_url += f"/revision/{quote(revision, safe='')}"
    status, info = _fetch(info_url, token)
    if status == 404:
        inspection.error = f"No Hugging Face model repository named {repo}."
        return inspection
    if status in (401, 403):
        # Hugging Face answers 401 for a repository that does not exist as well as
        # for one that is private, so as not to disclose which private repos exist.
        # Reporting this as "access restricted" sends someone who simply mistyped a
        # name looking for permissions they do not need, so both causes are named.
        inspection.access = "AUTHENTICATION_REQUIRED"
        inspection.access_detail = (
            "Hugging Face returns the same response for a repository that does not "
            "exist and one that is private, so which applies cannot be determined "
            "without credentials."
        )
        inspection.error = (
            f"Hugging Face returned no metadata for {repo}. Either there is no "
            f"repository with that name -- check the spelling, including capitals -- "
            f"or it is private and needs credentials."
        )
        return inspection
    if status != 200 or not isinstance(info, dict):
        inspection.error = (
            f"Could not reach Hugging Face metadata for {repo} (status {status})."
        )
        return inspection

    inspection.ok = True
    resolved = info.get("sha")
    if not isinstance(resolved, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}", resolved):
        resolved = None
    inspection.revision = resolved
    published_task = info.get("pipeline_tag")
    task_modality = {
        "text-to-speech": "TTS", "text-to-audio": "TTS",
        "automatic-speech-recognition": "ASR", "feature-extraction": "EMBEDDING",
        "sentence-similarity": "EMBEDDING", "text-generation": "TEXT",
        "image-text-to-text": "VISION_LANGUAGE",
    }.get(published_task) if isinstance(published_task, str) else None
    if task_modality:
        inspection.modality = Detected(
            origin=Origin.DETECTED, value=task_modality,
            detail=f"Published model task: {published_task}. Confirm all pipeline components when benchmarking.",
            source_url=info_url,
        )

    # ---- access state -----------------------------------------------------
    gated = info.get("gated")
    if info.get("private"):
        inspection.access = "PRIVATE"
        inspection.access_detail = (
            "A private repository. The account fetching the weights needs read access."
        )
    elif gated in ("auto", "manual", True):
        inspection.access = "GATED"
        inspection.access_detail = (
            "The provider requires its terms to be accepted for the account that will "
            "fetch these weights"
            + (
                ", and reviews each request manually."
                if gated == "manual"
                else " before download is permitted."
            )
        )
    else:
        inspection.access = "PUBLIC"
        inspection.access_detail = "Downloadable without accepting additional terms."

    # ---- licence ----------------------------------------------------------
    card = info.get("cardData") or {}
    license_id = card.get("license")
    if not license_id:
        tags = [t for t in info.get("tags", []) if str(t).startswith("license:")]
        license_id = tags[0].split(":", 1)[1] if tags else None
    license_name = card.get("license_name")
    if license_id == "other" and isinstance(license_name, str) and license_name.strip():
        # "other" is a placeholder; the card names the actual terms separately.
        inspection.license_id = Detected(
            origin=Origin.DETECTED,
            value=license_name.strip()[:120],
            detail="Declared by the model card as license: other with this licence name. Read the terms on the model card.",
            source_url=info_url,
        )
    elif license_id:
        inspection.license_id = Detected(
            origin=Origin.DETECTED,
            value=str(license_id),
            detail="Declared by the model card.",
            source_url=info_url,
        )
    else:
        inspection.license_id = _missing("The model card declares no licence.")

    # ---- parameter count --------------------------------------------------
    # The safetensors header is counted by Hugging Face, so this is the tensor
    # count rather than a figure parsed out of the model's name.
    safetensors = info.get("safetensors") or {}
    total_params = safetensors.get("total")
    gguf = info.get("gguf") if isinstance(info.get("gguf"), dict) else {}
    gguf_total = gguf.get("total")
    if not (isinstance(total_params, int) and total_params > 0) and isinstance(gguf_total, int) and gguf_total > 0:
        billions = (Decimal(gguf_total) / Decimal(10**9)).quantize(Decimal("0.001"))
        inspection.total_params_b = Detected(
            origin=Origin.DETECTED,
            value=str(billions),
            detail=f"{gguf_total:,} stored tensor elements in the GGUF file, from Hugging Face's GGUF metadata. "
                   "This can differ from a model's marketed size.",
            source_url=info_url,
        )
    elif isinstance(total_params, int) and total_params > 0:
        billions = (Decimal(total_params) / Decimal(10**9)).quantize(Decimal("0.001"))
        inspection.total_params_b = Detected(
            origin=Origin.DETECTED,
            value=str(billions),
            detail=f"{total_params:,} tensor parameters, counted from the safetensors headers.",
            source_url=info_url,
        )
    else:
        inspection.total_params_b = _missing(
            "Hugging Face publishes no safetensors parameter count for this "
            "repository, and a count is not inferable from the model's name."
        )

    if not resolved:
        inspection.notes += (
            "The repository reported no commit, so values cannot be pinned to a revision.",
        )
        return inspection

    # ---- config.json: architecture, context, precision --------------------
    config_url = f"{HF_HOST}/{repo}/resolve/{resolved}/config.json"
    status, config = _fetch(config_url, token)
    if status == 200 and isinstance(config, dict):
        inspection.inference = inference_profile(
            info, config, source_url=info_url, config_url=config_url,
            repo=repo, revision=resolved,
        )
        architectures = config.get("architectures")
        if isinstance(architectures, list) and architectures:
            inspection.architecture = Detected(
                origin=Origin.DETECTED,
                value=str(architectures[0]),
                detail="Read from config.json; used to check which hosting options support it.",
                source_url=config_url,
            )
            # The Base repository currently omits pipeline_tag. Its pinned
            # config still declares the speech architecture; do not leave the
            # previous form's TEXT default attached to this audio model.
            if not task_modality and architectures[0] == "Qwen3TTSForConditionalGeneration":
                inspection.modality = Detected(
                    origin=Origin.DETECTED, value="TTS",
                    detail="The pinned config declares Qwen3TTSForConditionalGeneration, a speech-generation architecture. "
                           "Validate all audio components and runtime dependencies before deployment.",
                    source_url=config_url,
                )
            if len(architectures) > 1:
                inspection.notes += (
                    f"config.json lists {len(architectures)} architectures; the first "
                    f"is used.",
                )
        else:
            inspection.architecture = _missing(
                "config.json declares no architectures entry."
            )

        context = config.get("max_position_embeddings")
        if isinstance(context, int) and context > 0:
            inspection.context_tokens = Detected(
                origin=Origin.DETECTED,
                value=str(context),
                detail=(
                    "The maximum this model supports, from config.json. What this "
                    "deployment is configured for, and the input lengths actually "
                    "sent, are separate."
                ),
                source_url=config_url,
            )
        else:
            inspection.context_tokens = _missing(
                "config.json declares no max_position_embeddings."
            )

        precision = _precision_from_dtype(config.get("torch_dtype"))
        if precision:
            inspection.precision = Detected(
                origin=Origin.DETECTED,
                value=precision,
                detail=f"torch_dtype {config.get('torch_dtype')} in config.json.",
                source_url=config_url,
            )
        else:
            inspection.precision = _missing(
                f"config.json torch_dtype {config.get('torch_dtype')!r} is not one of "
                f"the precisions EDDIE evaluates."
            )
    else:
        reason = (
            "config.json is not readable without accepted terms and credentials."
            if status in (401, 403)
            else f"config.json could not be read (status {status})."
        )
        for attr in ("architecture", "context_tokens", "precision"):
            setattr(inspection, attr, _missing(reason))

        # Hugging Face indexes a summary of config.json in its own model metadata,
        # and that summary stays readable when the file itself is behind a gate. It
        # is still retrieved metadata rather than a guess from the model's name, so
        # the architecture is recoverable for gated repositories like Llama -- which
        # would otherwise be un-evaluatable, since the solver requires one.
        #
        # It is attributed to the repository index, not the pinned revision: this
        # summary describes the default branch, which may have moved.
        indexed = info.get("config") or {}
        architectures = indexed.get("architectures")
        if not architectures and isinstance(gguf.get("architecture"), str) and gguf["architecture"].strip():
            # A GGUF-only repository has no config.json. Its GGUF header names the
            # runtime architecture; it is not a Transformers class and no LLM context,
            # cache or precision is derived from it here.
            inspection.architecture = Detected(
                origin=Origin.DETECTED,
                value=gguf["architecture"].strip()[:120],
                detail="GGUF architecture from Hugging Face's GGUF metadata. GGUF files need a compatible GGUF runtime; "
                       "Transformers-based serving containers and Bedrock Custom Model Import do not load them.",
                source_url=info_url,
            )
            inspection.context_tokens = _missing(
                "This repository has no config.json. A GGUF context length is runtime-specific and is not "
                "treated as a chat context window.")
            inspection.notes += (
                "Weights are published as GGUF. Check that your serving runtime loads this exact file and any "
                "companion files (for example, a speech codec) before planning a deployment.",
            )
        if isinstance(architectures, list) and architectures:
            inspection.architecture = Detected(
                origin=Origin.DETECTED,
                value=str(architectures[0]),
                detail=(
                    "From Hugging Face's indexed model metadata, because config.json "
                    "itself is not readable. Describes the repository's default "
                    "branch rather than the pinned revision."
                ),
                source_url=info_url,
            )

    # ---- weights ----------------------------------------------------------
    tree_url = f"{HF_API}/models/{repo}/tree/{resolved}?recursive=true"
    status, tree = _fetch(tree_url, token)
    if status == 200 and isinstance(tree, list):
        total_bytes, count, source_url, note = _weights_from_manifest(
            tree, repo, resolved, token
        )
        inspection.weight_files = count
        if total_bytes:
            gib = (Decimal(total_bytes) / GIB).quantize(Decimal("0.01"))
            inspection.weights_gb = Detected(
                origin=Origin.DETECTED,
                value=str(gib),
                detail=(
                    f"{total_bytes:,} bytes across {count} weight file(s), in GiB. "
                    "This is the download size, not the GPU memory the model needs: "
                    "runtime, KV cache and concurrency add to it."
                ),
                source_url=source_url,
            )
        else:
            inspection.weights_gb = _missing(note or "No weight files were found.")
        if note and total_bytes:
            inspection.notes += (note,)
    else:
        inspection.weights_gb = _missing(
            f"The repository file listing could not be read (status {status})."
        )

    return inspection


def inspect_model_source(
    source: str, revision: Optional[str] = None, token: Optional[str] = None
) -> ModelInspection:
    """Dispatch on the kind of source.

    Only Hugging Face is implemented. An S3 or OCI artifact is a different
    inspection (read the manifest in the user's own account) and is reported as
    unsupported rather than attempted, so the interface never claims a detection
    it did not perform.
    """
    text = (source or "").strip()
    lowered = text.lower()
    if lowered.startswith(("s3://", "oci://")):
        return ModelInspection(
            source="s3" if lowered.startswith("s3://") else "oci",
            repo=text,
            revision=None,
            retrieved_at=_now(),
            ok=False,
            error=(
                "Inspecting artifacts in object storage or a container registry is not "
                "implemented yet. Enter the technical details under Model details, or "
                "give a Hugging Face repository."
            ),
        )
    return inspect_hf_model(text, revision=revision, token=token)
