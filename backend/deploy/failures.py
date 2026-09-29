"""Safe, durable failure explanations for deployment jobs.

Capture the service's startup diagnosis before cleanup removes the endpoint. Only
the selected FailureReason field is considered, never an SDK response or request.
Raw container logs, prompts, credentials and signed URLs are not copied.
"""
from __future__ import annotations

import re


def provider_diagnostic(value: object) -> str:
    """Bound and redact service-generated operational text for encrypted logs."""
    if not isinstance(value, str):
        return ""
    text = value[:4096]
    text = re.sub(r"https?://[^\s<>\"']+", "[URL omitted]", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", "[credential omitted]", text)
    text = re.sub(r"(?i)\bauthorization\s*[:=]?\s*(?:bearer|basic)\s+\S+",
                  "[credential omitted]", text)
    text = re.sub(
        r"(?i)\b(?:authorization|bearer|aws_secret_access_key|aws_session_token|"
        r"x-amz-security-token|password|api[_-]?key|access[_-]?token|secret)"
        r"\s*[:=]?\s*[^\s,;]+",
        "[credential omitted]", text,
    )
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
                  "[credential omitted]", text)
    return " ".join(text.split())[:1500]


class DeploymentFailure(ValueError):
    """An explanation authored by EDDIE, with separate provider diagnostics."""

    def __init__(self, code: str, explanation: str, *, diagnostic: str = ""):
        super().__init__(explanation)
        self.code = code
        self.explanation = explanation
        self.diagnostic = provider_diagnostic(diagnostic)


def endpoint_failure(status: str, reason: object) -> DeploymentFailure:
    text = reason.lower() if isinstance(reason, str) else ""
    if "capacity" in text:
        code = "capacity_unavailable"
        explanation = "AWS could not allocate capacity for this test. No working endpoint was published."
    elif any(term in text for term in ("image", "ecr", "docker", "container registry")):
        code = "serving_image_unavailable"
        explanation = "AWS could not start the serving image. The operator needs to check image access and compatibility."
    elif any(term in text for term in ("s3", "model data", "modeldata", "artifact")):
        code = "model_artifacts_unavailable"
        explanation = "AWS could not load the model files. The operator needs to check private storage access."
    elif any(term in text for term in ("health", "ping", "startup", "container")):
        code = "model_startup_failed"
        explanation = "The model did not become healthy. The operator needs to check the serving configuration."
    else:
        code = "endpoint_startup_failed"
        explanation = "AWS did not finish starting this test. No working endpoint was published."
    return DeploymentFailure(code, explanation, diagnostic=f"State: {status}. {reason or ''}")
