"""User-declared qualification answers shared by intake and placement.

These answers are planning inputs. They cannot grant permission, establish
compliance, or substitute for a workload benchmark.
"""
from __future__ import annotations

from typing import Any
from decimal import Decimal, InvalidOperation

QUALIFICATION_SCHEMA: dict[str, dict[str, Any]] = {
    # Training choices are retained only to read and explain legacy projects.
    # New Advisor input and all evaluation entry points are inference-only.
    "workloadType": {"type": "string", "enum": ["inference", "training", "both", "unsure"]},
    "modelStage": {"type": "string", "enum": ["base", "fine-tuned", "unsure"]},
    "selectionStage": {"type": "string", "enum": ["exploring", "committed", "unsure"]},
    "servingPattern": {"type": "string", "enum": ["interactive", "batch", "both", "unsure"]},
    "goLiveDate": {"type": "string", "description": "User's intended go-live date, not a delivery guarantee."},
    "platformPreference": {"type": "string", "enum": ["new", "sagemaker", "eks-ec2", "unsure"]},
    "growthNotes": {"type": "string", "description": "Expected growth over 6–12 months; do not invent it."},
    "availabilityNeeds": {"type": "string", "description": "User-declared uptime or failover needs; never a verified SLA."},
    "complianceNeeds": {"type": "string", "description": "User-declared residency, privacy or compliance requirements."},
    "weightCustody": {"type": "string", "enum": ["aws-managed", "own-account", "unsure"]},
    "currentSpendUsd": {"type": "string", "description": "Current monthly inference spend in USD. Not the new budget."},
    "benchmarkedAlternatives": {"type": "string", "description": "Alternatives previously tested. Prose is not benchmark evidence."},
    "requestsPerMinute": {"type": "string", "description": "Peak request arrivals per minute as stated by the user, not concurrency."},
    "cpuRuntime": {"type": "string", "enum": ["compatible", "gpu-required", "unsure"],
                   "description": "User-declared CPU runtime support. Not a validated deployment recipe."},
    "completionDeadlineSeconds": {"type": "string",
                                  "description": "Maximum queue-to-completion time for one inference job, including startup and loading."},
    "cpuAdditionalCostUsd": {"type": "string",
                            "description": "User-supplied EC2 CPU supporting-service allowance over the comparison period; never assume zero."},
    "batchAdditionalCostUsd": {"type": "string",
                              "description": "User-supplied AWS Batch supporting-service allowance over the comparison period; never assume zero."},
    "cpuCostNotes": {"type": "string",
                     "description": "Basis and included services for the CPU cost allowances; include storage, networking, logs and requests."},
}


def parse_qualification(value: Any) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - QUALIFICATION_SCHEMA.keys():
        raise ValueError("Qualification answers contain unsupported fields.")
    result: dict[str, str] = {}
    for key, raw in value.items():
        if raw in (None, "", "unsure"):
            continue
        schema = QUALIFICATION_SCHEMA[key]
        if not isinstance(raw, str) or len(raw) > 4000:
            raise ValueError(f"Qualification {key} must be text shorter than 4,001 characters.")
        if "enum" in schema and raw not in schema["enum"]:
            raise ValueError(f"Qualification {key} has an unsupported choice.")
        if key in ("requestsPerMinute", "currentSpendUsd", "completionDeadlineSeconds",
                   "cpuAdditionalCostUsd", "batchAdditionalCostUsd"):
            try:
                number = Decimal(raw)
            except InvalidOperation as exc:
                raise ValueError(f"{key} must be a non-negative number.") from exc
            if not number.is_finite() or number < 0:
                raise ValueError(f"{key} must be a non-negative number.")
            if key == "completionDeadlineSeconds" and (number <= 0 or number > 31536000):
                raise ValueError("Completion deadline must be greater than zero and at most one year.")
            if key in ("cpuAdditionalCostUsd", "batchAdditionalCostUsd") and number > Decimal("1e12"):
                raise ValueError("Supporting-service allowance is too large.")
        if raw.strip():
            result[key] = raw.strip()
    return result


def require_inference_scope(answers: dict[str, Any]) -> None:
    """Do not price training traffic as inference or relabel an old project."""
    if answers.get("workloadType") in ("training", "both"):
        raise ValueError(
            "This project includes training, which EDDIE does not plan or run. "
            "Hosting an already fine-tuned model is inference. "
            "Choose Use this project for inference in Your needs, then enter its "
            "inference traffic. Training job counts and durations cannot be reused."
        )


def calculate_usage(inputs: dict[str, Any]) -> dict[str, Any]:
    values = []
    for name in ("users", "requestsPerUserPerDay", "days"):
        raw = inputs.get(name)
        if not isinstance(raw, str) or len(raw) > 30:
            raise ValueError(f"{name} must be a short decimal string.")
        try:
            value = Decimal(raw)
        except InvalidOperation as exc:
            raise ValueError(f"{name} must be a non-negative number.") from exc
        if not value.is_finite() or value < 0 or value > Decimal("1e12"):
            raise ValueError(f"{name} must be between zero and one trillion.")
        values.append(value)
    total = values[0] * values[1] * values[2]
    return {
        "requests": format(total, "f"),
        "formula": "users × requests per user per day × days",
        "inputs": {key: inputs[key] for key in ("users", "requestsPerUserPerDay", "days")},
        "provenance": "DERIVED_FROM_DECLARED_INPUTS",
        "note": "An estimate from your assumptions. Not measured traffic, concurrency, capacity or billed copy hours.",
    }


def unresolved_requirements(answers: dict[str, str]) -> list[str]:
    """Restrictions this bounded inference evaluator cannot certify."""
    pending = []
    if answers.get("workloadType") in ("training", "both"):
        pending.append("Training is outside EDDIE's scope. Confirm an inference workload in Your needs.")
    if answers.get("servingPattern") in ("batch", "both"):
        pending.append("Validate the batch runtime and completion deadline, including queueing, startup and model loading.")
    for key, reason in {
        "requestsPerMinute": "Peak arrival rate is recorded; throughput at that load has not been measured.",
        "growthNotes": "Future growth is recorded; a future-capacity scenario has not been sized.",
        "availabilityNeeds": "Availability and failover requirements need an architecture review.",
        "complianceNeeds": "Data and compliance requirements need a verified policy review.",
        "goLiveDate": "The go-live date is recorded; provisioning lead time and launch capacity are not guaranteed.",
    }.items():
        if answers.get(key):
            pending.append(reason)
    if answers.get("weightCustody") == "own-account":
        pending.append("Account-level custody of weights and serving artifacts needs a service-specific review.")
    return pending
