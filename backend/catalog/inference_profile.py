"""Small, typed facts for inference sizing, read from published model metadata.

Never import model code or interpret a model name as its architecture. Registry
tensor counts include buffers/scales; they are not a count of trainable parameters.
The original config and model card are deliberately not returned to the advisor.
"""
from __future__ import annotations

from typing import Any

DTYPE_BYTES = {
    "F64": 8, "F32": 4, "BF16": 2, "F16": 2,
    "F8_E4M3": 1, "F8_E5M2": 1, "F8_E4M3FN": 1,
    "I64": 8, "I32": 4, "I16": 2, "I8": 1, "U8": 1, "BOOL": 1,
}


def positive_int(value: Any, maximum: int = 10**15) -> int | None:
    return value if type(value) is int and 0 < value <= maximum else None


def inference_profile(info: dict, config: dict, *, source_url: str,
                      config_url: str, repo: str, revision: str | None) -> dict:
    """Extract only bounded numeric geometry and dtype counts."""
    cfg = config.get("text_config", config)
    if not isinstance(cfg, dict):
        cfg = {}
    tensors = info.get("safetensors")
    counts = tensors.get("parameters", {}) if isinstance(tensors, dict) else {}
    groups = []
    if isinstance(counts, dict) and len(counts) <= 32:
        for dtype, raw_count in sorted(counts.items(), key=lambda item: str(item[0])):
            count = positive_int(raw_count)
            if count is not None and isinstance(dtype, str) and len(dtype) <= 32:
                size = DTYPE_BYTES.get(dtype)
                groups.append({
                    "dtype": dtype, "elements": count, "bytesPerElement": size,
                    "bytes": count * size if size else None,
                })
    geometry = {
        key: positive_int(cfg.get(key), 10**7)
        for key in (
            "num_hidden_layers", "num_attention_heads", "num_key_value_heads",
            "head_dim", "hidden_size", "max_position_embeddings",
            "kv_lora_rank", "qk_rope_head_dim", "n_routed_experts",
            "num_local_experts", "num_experts", "num_experts_per_tok",
            "moe_intermediate_size",
        )
    }
    # Zero is meaningful: all layers can be expert layers.
    for key in ("first_k_dense_replace", "moe_layer_freq"):
        value = cfg.get(key)
        geometry[key] = value if type(value) is int and 0 <= value <= 10000 else None
    if not geometry["head_dim"] and geometry["hidden_size"] and geometry["num_attention_heads"]:
        width, heads = geometry["hidden_size"], geometry["num_attention_heads"]
        if width % heads == 0:
            geometry["head_dim"] = width // heads
    architectures = cfg.get("architectures") or config.get("architectures")
    arch = architectures[0] if isinstance(architectures, list) and architectures else None
    if not isinstance(arch, str) or len(arch) > 160:
        arch = None
    return {
        "schemaVersion": 1, "repo": repo, "revision": revision,
        "sourceUrl": source_url, "configUrl": config_url,
        "architecture": arch, "geometry": geometry, "tensorGroups": groups,
        "tensorBytes": sum(g["bytes"] for g in groups)
        if groups and all(g["bytes"] is not None for g in groups) else None,
        "storedElements": sum(g["elements"] for g in groups) if groups else None,
        "basis": "REGISTRY",
        "note": "Counts are the registry's indexed safetensors metadata. "
                "EDDIE has not downloaded weights or measured runtime memory.",
    }
