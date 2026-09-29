"""Capability inventory for source connectors.

Discovery, artifact access, runtime compatibility and hosted inference are separate
capabilities. Registering a source must never execute its repository code.
"""
from __future__ import annotations

from typing import Any, Protocol


class ModelSourceConnector(Protocol):
    """Extension boundary for a reviewed, server-installed connector."""

    connector_id: str

    def inspect(self, source: str, revision: str | None = None) -> dict[str, Any]:
        """Return metadata and its provenance. Credentials come from server bindings."""
        ...


class HuggingFaceConnector:
    connector_id = "huggingface"

    def inspect(self, source: str, revision: str | None = None) -> dict[str, Any]:
        from .model_inspect import inspect_model_source
        return inspect_model_source(source, revision=revision).to_json()


def connector_inventory() -> dict[str, Any]:
    return {
        "connectors": [
            {
                "id": "huggingface", "name": "Hugging Face Hub",
                "status": "AVAILABLE", "capabilities": ["public_metadata", "pinned_revision"],
                "execution": False,
                "note": "Uses the existing inspect_model action. Gated or private access may require separate authorization.",
            },
            {
                "id": "bedrock", "name": "Amazon Bedrock catalogue",
                "status": "AVAILABLE", "capabilities": ["model_discovery"],
                "execution": False,
                "note": "A catalogue result is not evidence of model access, task quality or deployment support.",
            },
            {
                "id": "checkpoint", "name": "Private fine-tuned checkpoint",
                "status": "AVAILABLE", "capabilities": ["scoped_library", "pinned_revision", "safetensors_metadata"],
                "execution": False,
                "note": "Requires the installation's private S3 library. Inspection is read-only; deployment needs a separately reviewed and approved recipe.",
            },
            {
                "id": "company", "name": "Company repository or package",
                "status": "ADAPTER_REQUIRED", "capabilities": [],
                "execution": False,
                "note": "Requires a reviewed source adapter, scoped credential binding and a separate serving recipe.",
            },
            {
                "id": "vendor_api", "name": "Vendor API or SDK",
                "status": "ADAPTER_REQUIRED", "capabilities": [],
                "execution": False,
                "note": "Verify whether the SDK contains a runtime or only an API client; export and hosting rights are separate.",
            },
        ],
        "note": "Connectors describe what they can do. No connector may fabricate inspection, testing or deployment support.",
    }
