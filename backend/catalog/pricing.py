"""Live price collection from the AWS Price List Query API.

Prices are evidence, not constants. Every Rate returned carries its SKU, term
effective date, and retrieval time so a decision can be replayed against the
exact catalogue entry it used.

Two things this module refuses to do:
  * Return zero for a missing price. Absent prices raise or return None so the
    solver records UNKNOWN.
  * Infer a Hosting price from an EC2 or Training SKU.

Note: the Price List API endpoint region is not the deployment region. Queries
run against us-east-1 while filtering on the deployment region's location name.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterator, Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from solver.money import Rate

log = logging.getLogger(__name__)

# The Price List Query API is only offered in these endpoint regions.
PRICING_ENDPOINT_REGION = "us-east-1"

# Price List filters use human-readable location names, not region codes.
REGION_TO_LOCATION = {
    "us-east-1": "US East (N. Virginia)",
    "us-east-2": "US East (Ohio)",
    "us-west-2": "US West (Oregon)",
    "eu-central-1": "EU (Frankfurt)",
    "eu-west-1": "EU (Ireland)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "ap-south-1": "Asia Pacific (Mumbai)",
    "ap-southeast-2": "Asia Pacific (Sydney)",
}


def _client(region: str = PRICING_ENDPOINT_REGION):
    return boto3.client(
        "pricing",
        region_name=region,
        config=Config(retries={"max_attempts": 4, "mode": "standard"}),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iter_products(
    service_code: str, filters: list[dict[str, str]], max_pages: int = 20
) -> Iterator[dict[str, Any]]:
    """Yield parsed PriceList entries, following pagination."""
    client = _client()
    token: Optional[str] = None
    pages = 0
    while pages < max_pages:
        kwargs: dict[str, Any] = {
            "ServiceCode": service_code,
            "Filters": [
                {"Type": "TERM_MATCH", "Field": f["Field"], "Value": f["Value"]}
                for f in filters
            ],
            "MaxResults": 100,
        }
        if token:
            kwargs["NextToken"] = token
        resp = client.get_products(**kwargs)
        for raw in resp.get("PriceList", []):
            yield json.loads(raw) if isinstance(raw, str) else raw
        token = resp.get("NextToken")
        pages += 1
        if not token:
            return


def _first_on_demand_dimension(product: dict[str, Any]) -> Optional[tuple[Decimal, str, str, str]]:
    """Extract (price, unit, sku, effective_date) from an On-Demand term.

    Skips zero-priced dimensions, which in these catalogues are usually free-tier
    or placeholder entries rather than the real rate.
    """
    sku = product.get("product", {}).get("sku", "")
    on_demand = product.get("terms", {}).get("OnDemand", {})
    for term in on_demand.values():
        effective = term.get("effectiveDate", "")
        for dim in term.get("priceDimensions", {}).values():
            usd = dim.get("pricePerUnit", {}).get("USD")
            if usd is None:
                continue
            price = Decimal(usd)
            if price <= 0:
                continue
            return price, dim.get("unit", ""), sku, effective
    return None


# --------------------------------------------------------------------------
# EC2 compute, kept distinct from SageMaker Hosting
# --------------------------------------------------------------------------


def ec2_on_demand_rate(instance_type: str, region: str = "us-east-1") -> Optional[Rate]:
    """Return one unambiguous Linux shared-tenancy instance-hour price."""
    location = REGION_TO_LOCATION.get(region)
    if not location or not re.fullmatch(r"[a-z0-9-]+\.[a-z0-9]+", instance_type):
        return None
    expected = {
        "instanceType": instance_type, "location": location, "operatingSystem": "Linux",
        "tenancy": "Shared", "preInstalledSw": "NA", "capacitystatus": "Used",
        "operation": "RunInstances",
    }
    matches = []
    try:
        for product in _iter_products("AmazonEC2", [
            {"Field": key, "Value": value} for key, value in expected.items()
        ], max_pages=2):
            attrs = product.get("product", {}).get("attributes", {})
            if any(attrs.get(key) != value for key, value in expected.items()):
                continue
            found = _first_on_demand_dimension(product)
            if found and found[1] == "Hrs":
                matches.append(found)
        if not matches or len({row[0] for row in matches}) != 1:
            return None
        price, _, sku, effective = matches[0]
        return Rate(amount=price, unit="USD/Hrs", region=region, sku=sku,
                    effective_date=effective,
                    source=f"AmazonEC2 Price List, Linux Shared On-Demand, retrieved {_now()}")
    except Exception:
        # Price absence is not a zero quote; do not expose provider errors to chat.
        log.warning("EC2 pricing unavailable for %s in %s", instance_type, region)
        return None


# --------------------------------------------------------------------------
# SageMaker hosting
# --------------------------------------------------------------------------


def sagemaker_hosting_rate(instance_type: str, region: str = "us-east-1") -> Optional[Rate]:
    """Price one SageMaker real-time Hosting instance-hour.

    Filters on the Hosting usage family so a Training or Notebook SKU for the same
    instance type cannot be returned by mistake.
    """
    location = REGION_TO_LOCATION.get(region)
    if not location:
        log.warning("No Price List location mapping for region %s", region)
        return None

    try:
        for product in _iter_products(
            "AmazonSageMaker",
            [
                {"Field": "instanceName", "Value": instance_type},
                {"Field": "location", "Value": location},
            ],
        ):
            attrs = product.get("product", {}).get("attributes", {})
            family = (attrs.get("usagetype", "") or "") + (attrs.get("operation", "") or "")
            platform = attrs.get("platousageType", "") or attrs.get("platoUsageType", "") or ""
            # Hosting SKUs are identified by usage type, not by instance name.
            if "Host" not in family and "Host" not in platform:
                continue
            found = _first_on_demand_dimension(product)
            if not found:
                continue
            price, unit, sku, effective = found
            return Rate(
                amount=price,
                unit=f"USD/{unit or 'Hrs'}",
                region=region,
                sku=sku,
                effective_date=effective,
                source=f"AmazonSageMaker Price List, retrieved {_now()}",
            )
    except ClientError as exc:
        log.warning("SageMaker pricing lookup failed for %s: %s", instance_type, exc)
        return None
    except Exception as exc:  # noqa: BLE001 - evidence collection must not crash a request
        log.warning("SageMaker pricing lookup error for %s: %s", instance_type, exc)
        return None

    log.info("No Hosting SKU found for %s in %s", instance_type, region)
    return None


# --------------------------------------------------------------------------
# Bedrock Custom Model Import
# --------------------------------------------------------------------------


# CMI usage types encode family and CMU version, e.g.
#   USE1-Llama-CustomModelImport-Inference-v1:0
#   USE1-OSS-CustomModelImport-Inference-v2:0
# Rates differ materially between them: observed 2026-09-12 in us-east-1, Llama v1
# inference is $0.05718/CMU-minute while OSS v2 is $0.1433 -- roughly 2.5x. Both
# family and CMU version must therefore be matched, per docs/cost-model.md.
CMI_USAGETYPE = re.compile(
    r"^[A-Z0-9]+-(?P<family>.+?)-CustomModelImport-(?P<kind>Inference|Storage)-"
    r"(?P<version>v\d+):(?P<minor>\d+)$"
)

# Maps a model architecture class to its CMI pricing family label.
ARCHITECTURE_TO_CMI_FAMILY = {
    "LlamaForCausalLM": "Llama",
    "MllamaForConditionalGeneration": "MLlama",
    "MistralForCausalLM": "Mistral",
    "MixtralForCausalLM": "Mixtral",
    "T5ForConditionalGeneration": "Flan",
    "GPTBigCodeForCausalLM": "GPTBigCode",
    "Qwen2ForCausalLM": "Qwen2",
    "Qwen3ForCausalLM": "Qwen2",
    "Qwen3MoeForCausalLM": "Qwen2",
    "Qwen2VLForConditionalGeneration": "Qwen2VL",
    "Qwen2_5_VLForConditionalGeneration": "Qwen2-5-VL",
    "GptOssForCausalLM": "OSS",
}


@dataclass(frozen=True)
class CmiPriceKey:
    family: str
    version: str


def bedrock_cmi_price_matrix(region: str = "us-east-1") -> dict[tuple[str, str, str], Rate]:
    """Return every CMI rate keyed by (family, kind, version).

    kind is "Inference" (per CMU-minute) or "Storage" (per model-month). Returning
    the whole matrix keeps family/version selection explicit at the call site
    instead of hiding it behind a "first match" heuristic.
    """
    location = REGION_TO_LOCATION.get(region)
    matrix: dict[tuple[str, str, str], Rate] = {}
    if not location:
        return matrix

    try:
        for product in _iter_products(
            "AmazonBedrock", [{"Field": "location", "Value": location}], max_pages=40
        ):
            attrs = product.get("product", {}).get("attributes", {})
            if attrs.get("feature") != "Custom Model Import":
                continue
            match = CMI_USAGETYPE.match(attrs.get("usagetype", "") or "")
            if not match:
                continue
            found = _first_on_demand_dimension(product)
            if not found:
                continue
            price, unit, sku, effective = found
            key = (match["family"], match["kind"], match["version"])
            # Keep the first observation per key; the catalogue should not contain
            # conflicting duplicates, and overwriting would hide it if it did.
            if key in matrix:
                continue
            matrix[key] = Rate(
                amount=price,
                unit=f"USD/{unit}",
                region=region,
                sku=sku,
                effective_date=effective,
                source=(
                    f"AmazonBedrock Price List, usagetype {attrs['usagetype']}, "
                    f"retrieved {_now()}"
                ),
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("Bedrock CMI price matrix lookup failed: %s", exc)

    return matrix


def bedrock_cmi_rates(
    region: str = "us-east-1",
    architecture: str = "LlamaForCausalLM",
    cmu_version: str = "v1",
) -> dict[str, Optional[Rate]]:
    """CMI inference and storage rates for one family and CMU version.

    An unmapped architecture returns None rather than an arbitrary family's rate:
    guessing here would silently misprice the candidate.
    """
    family = ARCHITECTURE_TO_CMI_FAMILY.get(architecture)
    if family is None:
        log.info("No CMI pricing family mapped for architecture %s", architecture)
        return {"per_cmu_minute": None, "per_cmu_month": None, "family": None}

    matrix = bedrock_cmi_price_matrix(region)
    return {
        "per_cmu_minute": matrix.get((family, "Inference", cmu_version)),
        "per_cmu_month": matrix.get((family, "Storage", cmu_version)),
        "family": family,
    }


# --------------------------------------------------------------------------
# Pinned fallback evidence
# --------------------------------------------------------------------------

# Retrieved 2026-09-12 and recorded in docs/evidence/prices-2026-09-12.json.
# Used only when a live lookup fails, and always labelled as dated evidence so a
# stale rate is never presented as a fresh observation.
PINNED_RATES: dict[str, Rate] = {
    "cmi_per_cmu_minute": Rate(
        amount=Decimal("0.05718"),
        unit="USD/CMU-minute",
        region="us-east-1",
        sku="8EJKXB49YY4SMCKM",
        effective_date="2026-08-01",
        source="docs/evidence/prices-2026-09-12.json (pinned; retrieved 2026-09-12)",
    ),
    "cmi_per_cmu_month": Rate(
        amount=Decimal("1.95"),
        unit="USD/CMU-month",
        region="us-east-1",
        sku="YQSJA22BPUVEWDW3",
        effective_date="2026-08-01",
        source="docs/evidence/prices-2026-09-12.json (pinned; retrieved 2026-09-12)",
    ),
    "ml.g5.2xlarge": Rate(
        amount=Decimal("1.515"),
        unit="USD/instance-hour",
        region="us-east-1",
        sku="BTQ8KZF3DKVFJY87",
        effective_date="2026-09-01",
        source="docs/evidence/prices-2026-09-12.json (pinned; retrieved 2026-09-12)",
    ),
}


def resolve_rates(
    instance_type: str,
    region: str = "us-east-1",
    architecture: str = "LlamaForCausalLM",
    cmu_version: str = "v1",
) -> dict[str, Any]:
    """Collect the rates a CMI-versus-SageMaker comparison needs.

    Returns the rates plus a per-rate freshness label so the UI can distinguish a
    live observation from pinned dated evidence.
    """
    freshness: dict[str, str] = {}

    sm = sagemaker_hosting_rate(instance_type, region)
    if sm is None:
        sm = PINNED_RATES.get(instance_type)
        freshness["sagemaker"] = "PINNED" if sm else "UNKNOWN"
    else:
        freshness["sagemaker"] = "LIVE"

    cmi = bedrock_cmi_rates(region, architecture, cmu_version)
    family = cmi.get("family")
    per_min = cmi.get("per_cmu_minute")
    per_month = cmi.get("per_cmu_month")

    # The pinned fallback was captured for Llama CMU v1 only. Applying it to any
    # other family or CMU version would substitute a rate that can be materially
    # wrong -- OSS v2 is $0.1433/CMU-minute against Llama v1's $0.05718 -- so the
    # fallback is scoped to exactly what was observed. An unmapped architecture
    # stays UNKNOWN rather than borrowing another family's price.
    pinned_applies = family == "Llama" and cmu_version == "v1"

    if per_min is not None:
        freshness["cmi_minute"] = "LIVE"
    elif pinned_applies:
        per_min = PINNED_RATES.get("cmi_per_cmu_minute")
        freshness["cmi_minute"] = "PINNED" if per_min else "UNKNOWN"
    else:
        freshness["cmi_minute"] = "UNKNOWN"

    if per_month is not None:
        freshness["cmi_month"] = "LIVE"
    elif pinned_applies:
        per_month = PINNED_RATES.get("cmi_per_cmu_month")
        freshness["cmi_month"] = "PINNED" if per_month else "UNKNOWN"
    else:
        freshness["cmi_month"] = "UNKNOWN"

    return {
        "sagemaker_instance_hour": sm,
        "cmi_per_cmu_minute": per_min,
        "cmi_per_cmu_month": per_month,
        "freshness": freshness,
        "retrieved_at": _now(),
        "region": region,
        "cmi_family": cmi.get("family"),
        "cmu_version": cmu_version,
    }
