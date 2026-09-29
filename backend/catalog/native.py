"""Collect native Bedrock routes and token prices before the pure solver runs.

Catalog presence is not model access, quota headroom or measured performance.
Geographic profiles use standard prices; global profiles need a separate price
and residency policy and are deliberately not qualified here.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from solver.cost import TokenWorkload, native_token_cost
from solver.models import (
    BlastRadius, Candidate, CandidateEvidence, EvidenceSnapshot, Modality,
    OpsBurden, PlacementRequest, Target,
)
from solver.money import Rate
from .pricing import _client as pricing_client

log = logging.getLogger(__name__)
ROUTING_DOC = "https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html"
PRICING_DOC = "https://aws.amazon.com/bedrock/pricing/"
# Identifier mapping only, not prices. AWS uses different names in its two APIs.
PRICE_MODEL_NAMES = {"amazon.nova-2-lite-v1:0": "Nova 2.0 Lite"}
PRICE_SCOPE = (
    "Standard, uncached text input and output. User-estimated usage, live public USD rates. "
    "Excludes image/audio/video, prompt caching, batch, tools, guardrails, application "
    "infrastructure, taxes and private discounts. Account access, quota headroom and "
    "answer quality still need verification."
)


def _bedrock(region: str):
    return boto3.client(
        "bedrock", region_name=region,
        config=Config(connect_timeout=5, read_timeout=20, retries={"max_attempts": 2}),
    )


def _profiles(client) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    token = None
    for _ in range(10):
        args: dict[str, Any] = {"typeEquals": "SYSTEM_DEFINED", "maxResults": 100}
        if token:
            args["nextToken"] = token
        response = client.list_inference_profiles(**args)
        for profile in response.get("inferenceProfileSummaries", []):
            destinations, model_ids = set(), set()
            unbounded = False
            for entry in profile.get("models", []):
                parts = entry.get("modelArn", "").split(":", 5)
                if len(parts) != 6 or not parts[5].startswith("foundation-model/"):
                    unbounded = True
                    continue
                if parts[3]:
                    destinations.add(parts[3])
                else:
                    # An empty ARN region is a global route, not local processing.
                    unbounded = True
                model_ids.add(parts[5].removeprefix("foundation-model/"))
            result.append({
                "id": profile["inferenceProfileId"],
                "name": profile.get("inferenceProfileName", profile["inferenceProfileId"]),
                "status": profile.get("status"),
                "modelIds": sorted(model_ids),
                "processingRegions": sorted(destinations),
                "global": unbounded or profile["inferenceProfileId"].startswith("global."),
            })
        token = response.get("nextToken")
        if not token:
            return result
    raise RuntimeError("Inference profile listing exceeded its pagination limit")


def list_native_catalog(region: str) -> dict[str, Any]:
    client = _bedrock(region)
    response = client.list_foundation_models()
    models = [{
        "modelId": m["modelId"],
        "modelName": m.get("modelName", m["modelId"]),
        "provider": m.get("providerName", ""),
        "inputModalities": m.get("inputModalities", []),
        "outputModalities": m.get("outputModalities", []),
        "streamingSupported": m.get("responseStreamingSupported", False),
        "inferenceTypes": m.get("inferenceTypesSupported", []),
    } for m in response.get("modelSummaries", [])]
    profile_issue = None
    try:
        profiles = _profiles(client)
    except Exception:
        log.warning("Native inference profile discovery unavailable in %s", region)
        profiles = []
        profile_issue = "Request routes could not be loaded. Retry before choosing a cross-region model."
    return {
        "region": region, "count": len(models),
        "models": sorted(models, key=lambda m: (m["provider"], m["modelId"])),
        "inferenceProfiles": profiles, "profileIssue": profile_issue,
        "note": "Live catalog listing. Model access and task fit must be verified separately.",
    }


def is_native_request(request: PlacementRequest) -> bool:
    model = request.model
    # Old saved projects predate sourceKind. They can contain a canonical native
    # ID entered in the API-only picker; confirm that ID with AWS below.
    legacy_id = (
        model.architecture == "vendor-api" and "." in model.name
        and "/" not in model.name and ":" in model.name
    )
    return model.source_kind == "bedrock" or legacy_id


def _rate_from_products(
    products: list[dict], direction: str, region: str, price_name: str, as_of: str
) -> Rate | None:
    """Only one unambiguous, current, flat Standard text SKU may supply a rate."""
    matches: dict[str, Rate] = {}
    units = {"1K tokens": Decimal(1000), "1M tokens": Decimal(1000000), "tokens": Decimal(1)}
    for product in products:
        p = product.get("product", {})
        a = p.get("attributes", {})
        if (
            a.get("regionCode") != region or a.get("model") != price_name
            or a.get("feature") != "On-demand Inference"
            or a.get("inferenceType", "").casefold() != f"{direction} tokens"
            or a.get("service_tier", "standard").casefold() != "standard"
            or a.get("modality", "text").casefold() != "text"
            or a.get("batch", "").casefold() not in ("", "no", "false")
            or any(term in a.get("usagetype", "").casefold()
                   for term in ("cache", "batch", "global", "priority", "flex"))
        ):
            continue
        terms = [
            t for t in product.get("terms", {}).get("OnDemand", {}).values()
            if t.get("effectiveDate") and t["effectiveDate"] <= as_of
        ]
        if not terms:
            continue
        latest = max(t["effectiveDate"] for t in terms)
        terms = [t for t in terms if t["effectiveDate"] == latest]
        if len(terms) != 1:
            return None
        dimensions = list(terms[0].get("priceDimensions", {}).values())
        if len(dimensions) != 1:
            return None  # A tiered price needs its own formula, not the first tier.
        dim = dimensions[0]
        if (
            dim.get("unit") not in units or str(dim.get("beginRange")) != "0"
            or dim.get("endRange") != "Inf" or dim.get("appliesTo")
        ):
            return None
        try:
            amount = Decimal(dim["pricePerUnit"]["USD"]) * Decimal(1000000) / units[dim["unit"]]
        except (KeyError, InvalidOperation):
            return None
        if not amount.is_finite() or amount < 0:
            return None
        sku = p.get("sku")
        if not sku:
            return None
        rate = Rate(
            amount=amount, unit="USD/million tokens", region=region, sku=sku,
            effective_date=latest, source="AWS Price List Query API · AmazonBedrock",
        )
        if sku in matches and matches[sku] != rate:
            return None
        matches[sku] = rate
    return next(iter(matches.values())) if len(matches) == 1 else None


def native_rates(model_id: str, model_name: str, region: str, as_of: str) -> dict[str, Rate | None]:
    price_name = PRICE_MODEL_NAMES.get(model_id, model_name)
    client = pricing_client()
    products: list[dict] = []
    token = None
    for _ in range(10):
        args: dict[str, Any] = {
            "ServiceCode": "AmazonBedrock", "MaxResults": 100,
            "Filters": [
                {"Type": "TERM_MATCH", "Field": "regionCode", "Value": region},
                {"Type": "TERM_MATCH", "Field": "model", "Value": price_name},
            ],
        }
        if token:
            args["NextToken"] = token
        response = client.get_products(**args)
        products.extend(json.loads(p) if isinstance(p, str) else p for p in response.get("PriceList", []))
        token = response.get("NextToken")
        if not token:
            return {side: _rate_from_products(products, side, region, price_name, as_of)
                    for side in ("input", "output")}
    # Never quote from an incomplete scan that might have missed another tier/SKU.
    return {"input": None, "output": None}


@dataclass(frozen=True)
class NativeCollection:
    candidates: tuple[Candidate, ...]
    snapshot: EvidenceSnapshot
    pricing: tuple[dict[str, Any], ...]


def collect_native(request: PlacementRequest, latency: dict | None = None) -> NativeCollection:
    from api.serialize import rate_json

    retrieved = datetime.now(timezone.utc).isoformat()
    candidates, evidence, quotes = [], {}, []
    for region in request.constraints.permitted_regions:
        client = _bedrock(region)
        model_id = request.model.name
        model = None
        supported = None
        issue = None
        try:
            model = client.get_foundation_model(modelIdentifier=model_id)["modelDetails"]
            supported = model.get("modelId") == model_id
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            supported = False if code in ("ResourceNotFoundException", "ValidationException") else None
            issue = "This model could not be verified in the live Bedrock catalog for this Region."

        profile_id = request.model.inference_profile_id
        processing: tuple[str, ...] = ()
        routing_issue = "Choose a supported request route in Models & sources."
        routing_verified = False
        rates = {"input": None, "output": None}
        global_route = False
        if model:
            if profile_id:
                try:
                    profile = next((p for p in _profiles(client) if p["id"] == profile_id), None)
                    if profile and model_id in profile["modelIds"] and profile["status"] == "ACTIVE":
                        global_route = profile["global"]
                        processing = tuple(profile["processingRegions"])
                        routing_verified = bool(processing) and not global_route
                        if global_route:
                            routing_issue = "Global routing needs a worldwide residency policy and global pricing; it is not qualified here."
                    else:
                        routing_issue = "The selected profile is not an active route for this exact model in this Region."
                except Exception:
                    log.warning("Native route verification unavailable in %s", region)
                    routing_issue = "The request route could not be verified. Retry route discovery."
            elif "ON_DEMAND" in model.get("inferenceTypesSupported", []):
                processing, routing_verified = (region,), True
            elif not set(model.get("inferenceTypesSupported", [])) & {"ON_DEMAND", "INFERENCE_PROFILE"}:
                routing_issue = "This catalog model has no supported on-demand route. Provisioned-only pricing is not implemented."
            if not global_route and request.model.modality is Modality.TEXT:
                try:
                    rates = native_rates(model_id, model.get("modelName", model_id), region, retrieved)
                except Exception:
                    # "Token" is a pricing unit here; these arguments are public model and Region IDs.
                    # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
                    log.warning("Native token pricing unavailable for %s in %s", model_id, region)

        key = hashlib.sha256(f"{model_id}|{profile_id or 'regional'}|{region}".encode()).hexdigest()[:16]
        modalities = ()
        if model and "TEXT" in model.get("inputModalities", []) and "TEXT" in model.get("outputModalities", []):
            modalities = (Modality.TEXT,)
        cand = Candidate(
            candidate_id=f"bedrock-native-{key}", target=Target.BEDROCK_NATIVE,
            region=region, model_ref=model_id, inference_profile_id=profile_id,
            processing_regions=processing, routing_verified=routing_verified,
            routing_issue=None if routing_verified else routing_issue,
            ops_burden=OpsBurden.SERVICE_API, blast_radius=BlastRadius.SHARED_ACCOUNT_SERVICE,
            supported_modalities=modalities,
            supports_streaming=bool(model and model.get("responseStreamingSupported")),
            notes=PRICE_SCOPE,
        )
        w = request.workload
        missing = [label for label, value in (
            ("Requests in the comparison period", w.requests),
            ("Average input tokens per request", w.input_tokens_per_request),
            ("Average output tokens per request", w.output_tokens_per_request),
        ) if value is None]
        cost = None
        if not missing and request.model.modality is Modality.TEXT and all(rates.values()):
            cost = native_token_cost(
                TokenWorkload(
                    uncached_input=w.requests * w.input_tokens_per_request,
                    output=w.requests * w.output_tokens_per_request,
                ),
                rates["input"], rates["output"],
            )
        candidates.append(cand)
        # Even a hypothetical estimate must not label unchecked native access or
        # token quotas as verified. Route and model identity always use live data.
        evidence[cand.candidate_id] = CandidateEvidence(
            architecture_supported=supported, unsupported_reason=issue,
            cost=cost, latency=(latency or {}).get(cand.candidate_id),
        )
        quotes.append({
            "candidateId": cand.candidate_id, "modelId": model_id, "region": region,
            "inferenceProfileId": profile_id, "processingRegions": list(processing),
            "inputRate": rate_json(rates["input"]), "outputRate": rate_json(rates["output"]),
            "missingUsage": missing, "scope": PRICE_SCOPE, "retrievedAt": retrieved,
            "routingSource": ROUTING_DOC, "pricingSource": PRICING_DOC,
        })
    return NativeCollection(
        tuple(candidates), EvidenceSnapshot(evidence, retrieved, "AWS Price List Query API"),
        tuple(quotes),
    )
