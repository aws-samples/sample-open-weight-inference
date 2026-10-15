"""Normalize provider usage without inferring tokens from response length."""
from typing import Any


def normalized_usage(value: Any, *, bedrock: bool = False) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if bedrock:
        counts = {
            "inputTokens": value.get("inputTokens"),
            "outputTokens": value.get("outputTokens"),
            "cacheReadTokens": value.get("cacheReadInputTokens", 0),
            "cacheWriteTokens": value.get("cacheWriteInputTokens", 0),
        }
        accounting = "cache_is_additional"
    else:
        details = value.get("prompt_tokens_details")
        counts = {
            "inputTokens": value.get("prompt_tokens"),
            "outputTokens": value.get("completion_tokens"),
            # An endpoint may omit cache accounting. Do not invent a zero.
            "cacheReadTokens": details.get("cached_tokens") if isinstance(details, dict) else None,
            "cacheWriteTokens": 0,
        }
        accounting = "input_includes_cache"
    if any(v is not None and (isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 1_000_000_000)
           for v in counts.values()):
        return None
    if not bedrock and counts["inputTokens"] is not None and counts["cacheReadTokens"] is not None:
        if counts["cacheReadTokens"] > counts["inputTokens"]:
            return None
    return {**counts, "accounting": accounting}
