"""Reproducible inference planning arithmetic. Never benchmark evidence.

All functions are pure: network access belongs to the collector. In particular a
roofline ceiling cannot satisfy the solver's latency, quota, capacity or recipe
gates. Binary memory units, cache replication and traffic units stay explicit.
"""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal, InvalidOperation, ROUND_CEILING, localcontext
from typing import Any

from catalog.accelerators import ACCELERATORS, AWS_SPECS, Accelerator
from solver.inference_guidance import WORKLOADS, benchmark_guidance, compute_guidance

GIB = Decimal(1024**3)
BILLION = Decimal(10**9)
KV_BYTES = {"BF16": 2, "FP16": 2, "FP8": 1}
DEFAULTS = {
    "contextTokens": "4096", "batchSize": "1", "kvDtype": "BF16",
    "overheadPercent": "15", "utilizationPercent": "70", "minimumReplicas": "1",
    "peakFactor": "1", "hardwareId": "auto", "trafficMode": "requests",
    "totalTokens": "", "outputSharePercent": "", "prefillSpeedup": "",
    "hourlyRateUsd": "", "rateDescription": "", "workloadKind": "general",
    "servingMode": "unsure", "computePreference": "auto", "cpuRuntime": "unknown",
    "jobConcurrency": "", "deadlineSeconds": "",
    "cpuInstance": "c7i.8xlarge", "cpuPeakGiB": "", "cpuJobSeconds": "",
    "cpuBillableSeconds": "", "cpuRunReference": "",
}
WORKLOAD_KINDS = set(WORKLOADS)
CPU_PROFILES = {
    "c7i.8xlarge": {"vcpus": 32, "memoryGiB": 64, "architecture": "x86_64"},
    "c7g.8xlarge": {"vcpus": 32, "memoryGiB": 64, "architecture": "ARM64 / Graviton"},
    "m6g.xlarge": {"vcpus": 4, "memoryGiB": 16, "architecture": "ARM64 / Graviton2"},
    "m7i.2xlarge": {"vcpus": 8, "memoryGiB": 32, "architecture": "x86_64"},
    "m7g.2xlarge": {"vcpus": 8, "memoryGiB": 32, "architecture": "ARM64 / Graviton"},
    "r7i.2xlarge": {"vcpus": 8, "memoryGiB": 64, "architecture": "x86_64"},
    "r7g.2xlarge": {"vcpus": 8, "memoryGiB": 64, "architecture": "ARM64 / Graviton"},
}
CPU_SPECS = "https://docs.aws.amazon.com/ec2/latest/instancetypes/instance-types.html"
TEXT_CACHE_ARCHITECTURES = {
    "Qwen2ForCausalLM", "Qwen3ForCausalLM", "Qwen3MoeForCausalLM",
    "LlamaForCausalLM", "MistralForCausalLM", "MixtralForCausalLM",
    "DeepseekV3ForCausalLM", "DeepseekV2ForCausalLM",
}


def number(value: Any, name: str, low: Decimal | int, high: Decimal | int,
           *, optional: bool = False, integer: bool = False) -> Decimal | None:
    if value in (None, "") and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError(f"{name} must be a number.")
    if len(str(value)) > 64:
        raise ValueError(f"{name} is too long.")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError(f"{name} must be a number.") from exc
    if not result.is_finite() or not Decimal(str(low)) <= result <= Decimal(str(high)):
        raise ValueError(f"{name} must be between {low} and {high}.")
    if integer and result != result.to_integral_value():
        raise ValueError(f"{name} must be a whole number.")
    return result


def validate_settings(raw: Any) -> dict:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict) or set(raw) - set(DEFAULTS):
        raise ValueError("Sizing settings contain unsupported fields.")
    settings = {**DEFAULTS, **raw}
    ranges = {
        "contextTokens": (1, 1048576, True), "batchSize": (1, 4096, True),
        "overheadPercent": (0, 100, False), "utilizationPercent": (1, 100, False),
        "minimumReplicas": (1, 10000, True), "peakFactor": (1, 10000, False),
    }
    for key, (low, high, integer) in ranges.items():
        settings[key] = str(number(settings[key], key, low, high, integer=integer))
    for key, low, high in (
        ("totalTokens", 0, 10**18), ("outputSharePercent", 0, 100),
        ("prefillSpeedup", Decimal(".01"), 10000), ("hourlyRateUsd", Decimal(".000001"), 100000),
        ("jobConcurrency", 1, 100000), ("deadlineSeconds", Decimal(".001"), 31536000),
        ("cpuPeakGiB", Decimal(".001"), 10**6), ("cpuJobSeconds", Decimal(".001"), 31536000),
        ("cpuBillableSeconds", Decimal(".001"), 31536000),
    ):
        value = number(settings[key], key, low, high, optional=True, integer=key in ("jobConcurrency", "totalTokens"))
        settings[key] = str(value) if value is not None else ""
    if any(not isinstance(settings[key], str) for key in (
        "kvDtype", "hardwareId", "trafficMode", "workloadKind", "servingMode",
        "computePreference", "cpuRuntime", "cpuInstance", "cpuRunReference",
    )):
        raise ValueError("Sizing choices must be text.")
    if settings["kvDtype"] not in KV_BYTES:
        raise ValueError("Choose BF16, FP16 or FP8 for the attention cache.")
    if settings["hardwareId"] not in {"auto", *(a.instance for a in ACCELERATORS)}:
        raise ValueError("Choose a hardware profile from the shortlist.")
    if settings["trafficMode"] not in ("requests", "tokens"):
        raise ValueError("Specify whether the volume counts requests or tokens.")
    if settings["workloadKind"] not in WORKLOAD_KINDS:
        raise ValueError("Choose a supported inference workload.")
    if settings["servingMode"] not in ("unsure", "interactive", "batch", "both"):
        raise ValueError("Choose interactive or batch delivery.")
    if settings["computePreference"] not in ("auto", "cpu", "gpu"):
        raise ValueError("Choose a compute path.")
    if settings["cpuRuntime"] not in ("unknown", "supported", "unsupported"):
        raise ValueError("Specify CPU runtime support.")
    if settings["cpuInstance"] not in CPU_PROFILES:
        raise ValueError("Choose a CPU instance from the shortlist.")
    if len(settings["cpuRunReference"]) > 240:
        raise ValueError("Keep the run reference under 240 characters.")
    if any(settings[k] for k in ("cpuPeakGiB", "cpuJobSeconds", "cpuBillableSeconds")) and not settings["cpuRunReference"].strip():
        raise ValueError("Add a run reference for supplied CPU observations.")
    if not isinstance(settings["rateDescription"], str) or len(settings["rateDescription"]) > 160:
        raise ValueError("Keep the rate description under 160 characters.")
    if settings["hourlyRateUsd"] and not settings["rateDescription"].strip():
        raise ValueError("Describe the supplied rate, including any commitment term.")
    return settings


def display(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, Decimal):
        return str(value)
    with localcontext() as ctx:
        ctx.prec = 64
        return format(value.quantize(Decimal(".000001")), "f").rstrip("0").rstrip(".") if value else "0"


def metric(key: str, label: str, value: Any, unit: str, basis: str,
           explanation: str, formula: str | None = None, source: str | None = None) -> dict:
    return {"id": key, "label": label, "value": display(value), "unit": unit,
            "basis": basis if value is not None else "NOT_AVAILABLE",
            "explanation": explanation, "formula": formula, "sourceUrl": source}


def cache_geometry(profile: dict, dtype: str) -> tuple[int | None, str, bool]:
    g = profile.get("geometry") or {}
    if profile.get("architecture") not in TEXT_CACHE_ARCHITECTURES:
        return None, "This architecture needs a model-specific runtime memory profile.", False
    layers = g.get("num_hidden_layers")
    if layers and g.get("kv_lora_rank") and g.get("qk_rope_head_dim"):
        return (layers * (g["kv_lora_rank"] + g["qk_rope_head_dim"]) * KV_BYTES[dtype],
                "MLA: layers × (latent rank + positional key width) × bytes per element", True)
    if layers and g.get("num_key_value_heads") and g.get("head_dim"):
        return (2 * layers * g["num_key_value_heads"] * g["head_dim"] * KV_BYTES[dtype],
                "Key and value × layers × KV heads × head width × bytes per element", False)
    return None, "The model configuration does not establish a supported attention-cache layout.", False


def active_parameters(profile: dict) -> tuple[Decimal | None, str]:
    if profile.get("architecture") not in TEXT_CACHE_ARCHITECTURES:
        return None, "This architecture does not have a supported text-generation compute model."
    total = profile.get("storedElements")
    if not total:
        return None, "The registry did not publish a tensor count."
    g = profile.get("geometry") or {}
    experts = g.get("n_routed_experts") or g.get("num_local_experts") or g.get("num_experts")
    if not experts:
        return Decimal(total), "Dense-model approximation using stored tensor elements, including any buffers."
    required = ("num_hidden_layers", "hidden_size", "moe_intermediate_size", "num_experts_per_tok")
    if all(g.get(k) for k in required) and g.get("first_k_dense_replace") is not None and g.get("moe_layer_freq") == 1:
        layers = g["num_hidden_layers"] - g["first_k_dense_replace"]
        routed = Decimal(3 * layers * g["hidden_size"] * g["moe_intermediate_size"] * experts)
        if layers > 0 and g["num_experts_per_tok"] <= experts and routed <= total:
            active = Decimal(total) - routed * (1 - Decimal(g["num_experts_per_tok"]) / experts)
            return active, "Approximation: shared tensors plus the selected gated-MLP experts. Registry counts may include quantization scales."
    return None, "Expert routing is present, but active parameters cannot be calculated safely from this configuration."


def memory_layout(hardware: Accelerator, weights: Decimal | None, cache: Decimal | None,
                  profile: dict, overhead: Decimal, mla: bool) -> dict:
    g = profile.get("geometry") or {}
    heads, kv_heads = g.get("num_attention_heads"), g.get("num_key_value_heads")
    if weights is None or cache is None or not heads:
        return {"tp": None, "fits": None, "reason": "Read model geometry and set cache assumptions before sizing."}
    for tp in (1, 2, 4, 8):
        if tp > hardware.gpus or heads % tp:
            continue
        if not mla and kv_heads and tp <= kv_heads and kv_heads % tp:
            continue
        # MLA's compressed latent is replicated across tensor-parallel ranks.
        # GQA also repeats cache heads when TP exceeds the number of KV heads.
        cache_per_gpu = cache if mla else cache / min(tp, kv_heads or 1)
        per_gpu = (weights / tp + cache_per_gpu) * (1 + overhead)
        if per_gpu <= Decimal(hardware.memory_gib) * GIB:
            return {"tp": tp, "fits": True, "perGpuBytes": per_gpu,
                    "cachePhysicalBytes": cache_per_gpu * tp,
                    "replicaBytes": per_gpu * tp,
                    "reason": "Memory and attention-head divisibility fit this planning profile. The serving engine still needs validation."}
    return {"tp": None, "fits": False,
            "reason": "No supported tensor-parallel degree fits on one node with these cache and runtime assumptions."}


def build_sizing_report(request: dict, profile: dict | None, settings: dict,
                        *, rate: dict | None = None, retrieved_at: str = "") -> dict:
    """Return an explanation and numeric trace; never return a qualified candidate."""
    settings = validate_settings(settings)
    m, w = request.get("model") or {}, request.get("workload") or {}
    profile = profile or {}
    source = profile.get("sourceUrl")
    config_source = profile.get("configUrl")
    h = number(w.get("horizonHours", "720"), "Comparison hours", Decimal(".000001"), 876000)
    seconds = h * 3600
    context = int(Decimal(settings["contextTokens"]))
    batch = int(Decimal(settings["batchSize"]))
    overhead = Decimal(settings["overheadPercent"]) / 100
    utilization = Decimal(settings["utilizationPercent"]) / 100
    minimum = int(Decimal(settings["minimumReplicas"]))
    peak = Decimal(settings["peakFactor"])
    max_context = (profile.get("geometry") or {}).get("max_position_embeddings")
    if max_context and context > max_context:
        raise ValueError(f"Cached tokens per sequence exceeds the model's published limit of {max_context:,}.")
    native = m.get("sourceKind") == "bedrock" or m.get("weightsExportable") is False or m.get("architecture") == "vendor-api"
    weights = Decimal(profile["tensorBytes"]) if profile.get("tensorBytes") else None
    weight_basis = "REGISTRY"
    if weights is None and not native:
        given = number(m.get("weightsGb"), "Model weight GiB", 0, 10**7, optional=True)
        weights = given * GIB if given is not None else None
        weight_basis = "DECLARED"
    cpu = CPU_PROFILES[settings["cpuInstance"]]
    guidance = compute_guidance(request, settings, weights, cpu_memory_gib=cpu["memoryGiB"])
    compute = settings["computePreference"]
    if compute == "auto":
        compute = "cpu" if guidance["priority"] in (
            "CPU_BENCHMARK_FIRST", "CPU_AND_GPU", "CPU_MEMORY_REVIEW", "CPU_DEADLINE_REVIEW",
        ) else "gpu"
    if native:
        compute = "api"
    per_token, cache_formula, mla = cache_geometry(profile, settings["kvDtype"])
    cache = Decimal(per_token * context * batch) if per_token is not None else None
    base = weights + cache if weights is not None and cache is not None else None
    extra = base * overhead if base is not None else None
    total = base + extra if base is not None else None
    active, active_note = active_parameters(profile)
    stored = profile.get("storedElements")
    geometry = profile.get("geometry") or {}
    experts = geometry.get("n_routed_experts") or geometry.get("num_local_experts") or geometry.get("num_experts")
    warnings = []
    if native:
        warnings.append("A hosted model API does not expose its GPU layout. Plan token demand and verify the service's limits.")
    elif not profile:
        warnings.append("No matching model configuration was read. Supplied weight size cannot establish cache memory or a GPU layout.")
    if mla:
        warnings.append("This memory plan repeats the MLA cache on every tensor-parallel GPU; adding GPUs does not divide that cache.")
    if settings["kvDtype"] == "FP8":
        warnings.append("FP8 cache is an explicit assumption. Confirm serving-engine support and test answer quality.")

    input_total = output_total = requests = None
    if settings["trafficMode"] == "tokens":
        volume = number(settings["totalTokens"], "Tokens in the comparison period", 0, 10**18, optional=True)
        share = number(settings["outputSharePercent"], "Output token share", 0, 100, optional=True)
        if volume is not None and share is not None:
            output_total, input_total = volume * share / 100, volume * (1 - share / 100)
    else:
        requests = number(w.get("requests"), "Requests in the comparison period", 0, 10**18, optional=True)
        inp = number(w.get("inputTokensPerRequest"), "Input tokens per request", 0, 10**9, optional=True)
        out = number(w.get("outputTokensPerRequest"), "Output tokens per request", 0, 10**9, optional=True)
        input_total = requests * inp if requests is not None and inp is not None else None
        output_total = requests * out if requests is not None and out is not None else None
    input_rate = input_total / seconds if input_total is not None else None
    output_rate = output_total / seconds if output_total is not None else None
    ratio = number(settings["prefillSpeedup"], "Prefill-to-decode speed ratio", Decimal(".01"), 10000, optional=True)
    equivalent = (output_rate + input_rate / ratio) * peak if output_rate is not None and input_rate is not None and ratio else None

    layouts = [(a, memory_layout(a, weights, cache, profile, overhead, mla)) for a in ACCELERATORS]
    hardware, layout = next(
        ((a, l) for a, l in layouts if a.instance == settings["hardwareId"]),
        next(((a, l) for a, l in layouts if l["fits"]), (None, {"tp": None, "fits": None})),
    )
    if compute != "gpu":
        hardware, layout = None, {"tp": None, "fits": None}
    tp = layout["tp"]
    modeled = None
    if hardware and tp and active and weights:
        # Optimistic roofline: one full weight read per decode step, amortized over
        # batch. For MoE this deliberately does not assume perfect expert sparsity.
        physical_cache = layout["cachePhysicalBytes"]
        bandwidth_bound = Decimal(hardware.bandwidth_gbps) * BILLION * tp * batch / (weights + physical_cache)
        compute_bound = Decimal(str(hardware.bf16_tflops)) * Decimal(10**12) * tp / (2 * active)
        modeled = min(bandwidth_bound, compute_bound)
    copies = max(minimum, int((equivalent / (modeled * utilization)).to_integral_value(rounding=ROUND_CEILING))) if equivalent is not None and modeled else None
    packing = hardware.gpus // tp if hardware and tp else None
    # Spread replicas over nodes for fault isolation; density is reported but not
    # silently used as an availability strategy.
    fleet_nodes = copies
    rate_amount = Decimal(settings["hourlyRateUsd"]) if settings["hourlyRateUsd"] else None
    rate_basis = "DECLARED" if rate_amount is not None else "PUBLISHED"
    if rate_amount is None and rate and rate.get("amount"):
        rate_amount = number(rate["amount"], "Hourly rate", 0, 100000)
    node_cost = rate_amount * h if rate_amount is not None and hardware else None
    fleet_cost = node_cost * fleet_nodes if node_cost is not None and fleet_nodes is not None else None
    if compute == "gpu":
        warnings.extend([
            "Memory fit does not establish model-loader, quantization, kernel or tensor-parallel support.",
            "The throughput ceiling ignores communication, scheduling, attention compute and service overhead. Benchmark the exact configuration.",
            "A replica count derived from that ceiling is a planning floor, not a production fleet recommendation.",
        ])
    if minimum == 1 and compute == "gpu":
        warnings.append("One replica provides no node redundancy. Choose the availability floor your application requires.")
    if ratio is None and compute == "gpu":
        warnings.append("Input processing and output generation have different costs. Supply a measured or explicit assumed ratio before estimating a fleet.")

    groups = [{
        "id": "memory", "title": "Model and memory",
        "metrics": [
            metric("stored", "Stored tensor elements", Decimal(stored) / BILLION if stored else None, "billion", "REGISTRY", "Includes stored buffers and quantization scales; not a trainable-parameter count.", source=source),
            metric("active", "Active parameters per token", active / BILLION if active else None, "billion", "CALCULATED", active_note, source=config_source),
            metric("architecture", "Model structure", "Mixture of experts" if experts else "Dense text model" if stored and active else None, "", "REGISTRY", "Read from supported model geometry; other pipelines may contain multiple components.", source=config_source),
            metric("weights", "Weight storage footprint", weights / GIB if weights is not None else None, "GiB", weight_basis, "Tensor elements × storage bytes. This is a floor: the runtime may expand BF16 or quantized weights, especially on CPU.", "Sum of bytes across each published tensor dtype", source),
            metric("cachePerToken", "Attention cache per token", Decimal(per_token) / 1024 if per_token is not None else None, "KiB", "CALCULATED", cache_formula, cache_formula, config_source),
            metric("cache", "Attention cache, before sharding", cache / GIB if cache is not None else None, "GiB", "CALCULATED", f"{context:,} cached tokens × {batch:,} simultaneous sequences; {settings['kvDtype']} cache.", "Cache bytes per token × cached tokens × concurrent sequences", config_source),
            metric("overhead", "Runtime allowance", extra / GIB if extra is not None else None, "GiB", "ASSUMED", f"{settings['overheadPercent']}% for activations, workspaces and runtime. Validate observed peak memory.", "(Weights + cache) × runtime allowance"),
            metric("logicalMemory", "Memory before parallelism", total / GIB if total is not None else None, "GiB", "CALCULATED", "One logical model copy; the GPU layout below includes replicated cache.", "Weights + cache + runtime allowance"),
        ] + [metric(f"dtype-{g['dtype']}", f"{g['dtype']} tensors", Decimal(g["bytes"]) / GIB if g.get("bytes") is not None else None,
                    "GiB", "REGISTRY", f"{g['elements']:,} stored elements × {g.get('bytesPerElement')} bytes per element.", source=source)
             for g in profile.get("tensorGroups", [])],
    }, {
        "id": "traffic", "title": "Traffic to serve",
        "metrics": [
            metric("requests", "Requests in this period", requests, "requests", "DECLARED", "Tokens alone do not establish a request count."),
            metric("inputTokens", "Input volume", input_total, "tokens", "CALCULATED", "The input portion of the declared traffic."),
            metric("outputTokens", "Output volume", output_total, "tokens", "CALCULATED", "The generated portion of the declared traffic."),
            metric("inputRate", "Average input demand", input_rate, "tokens/s", "CALCULATED", "Average over the complete comparison period.", "Input tokens ÷ hours ÷ 3,600"),
            metric("outputRate", "Average output demand", output_rate, "tokens/s", "CALCULATED", "Average demand does not describe bursts.", "Output tokens ÷ hours ÷ 3,600"),
            metric("equivalentRate", "Decode-equivalent peak demand", equivalent, "tokens/s", "ASSUMED", "A planning normalization that depends on the supplied prefill ratio and peak multiplier.", "(Output/s + input/s ÷ prefill speed ratio) × peak multiplier"),
        ],
    }, {
        "id": "hardware", "title": "GPU layout",
        "metrics": [
            metric("instance", "Node profile", hardware.instance if hardware else None, "", "PUBLISHED", "A hardware planning profile; Region availability, quota and capacity have not been checked.", source=AWS_SPECS),
            metric("accelerator", "Accelerator", hardware.accelerator if hardware else None, "", "PUBLISHED", f"{hardware.gpus} GPUs per node." if hardware else "Select a hardware profile.", source=AWS_SPECS),
            metric("nodeMemory", "Published GPU memory per node", hardware.memory_gib * hardware.gpus if hardware else None, "GiB", "PUBLISHED", "Uses the EC2 specification's binary units, not a marketing GB label.", source=AWS_SPECS),
            metric("tensorParallel", "GPUs sharing one model copy", tp, "GPUs", "CALCULATED", layout.get("reason", "No single-node memory fit found."), "Smallest supported degree in 1, 2, 4, 8 that divides attention heads and fits memory"),
            metric("physicalMemory", "Memory across this model copy", layout.get("replicaBytes", Decimal(0)) / GIB if tp else None, "GiB", "CALCULATED", "Includes repeated cache where the attention layout requires it.", "(Weights per GPU + cache per GPU) × (1 + allowance) × GPUs"),
            metric("perGpuMemory", "Memory required on each GPU", layout.get("perGpuBytes", Decimal(0)) / GIB if tp else None, "GiB", "CALCULATED", "The per-GPU limit must pass; aggregate memory alone is insufficient."),
            metric("interconnect", "Within-node connection", hardware.interconnect if hardware else None, "", "PUBLISHED", "No inter-node tensor parallelism is modeled.", source=AWS_SPECS),
            metric("packing", "Maximum copies by GPU count", packing, "per node", "CALCULATED", "A density limit only. Shared-node contention and memory must be tested."),
        ],
    }, {
        "id": "fleet", "title": "Throughput and spend",
        "metrics": [
            metric("roofline", "Idealized decode ceiling", modeled, "tokens/s", "MODELED", "Analytical roofline using dense BF16 compute and memory bandwidth. This is not measured throughput.", "Min(compute ÷ (2 × active parameters), bandwidth × batch ÷ bytes read per decode step)", hardware.compute_source if hardware else None),
            metric("copies", "Traffic-based replica floor", copies, "copies", "MODELED", "One replica per node for fault isolation. Requires a prefill ratio; final capacity needs a load test.", "Max(availability floor, ceil(peak demand ÷ (decode ceiling × utilization)))"),
            metric("nodes", "Nodes at that planning floor", fleet_nodes, "nodes", "MODELED", "Copies are spread across nodes. Placement across Availability Zones is not established."),
            metric("hourly", "Hourly node rate", rate_amount if hardware else None, "USD/hour", rate_basis, settings["rateDescription"] or "Linux shared-tenancy EC2 On-Demand. SageMaker Hosting and commitment rates are separate.", source=(rate or {}).get("sourceUrl")),
            metric("nodeCost", "One node over this period", node_cost, "USD", "CALCULATED", f"{h} hours. Compute only; storage, networking and other charges are additional.", "Hourly rate × comparison hours"),
            metric("fleetCost", "Fleet compute at the planning floor", fleet_cost, "USD", "MODELED", "An estimate for the modeled replica floor. It is not the hosting comparison's recommendation.", "Nodes × hours × hourly node rate"),
            metric("ttft", "First-token latency", None, "ms", "NOT_AVAILABLE", "Requires a streaming benchmark for this model, engine, workload and GPU layout."),
        ],
    }]
    cpu_peak = Decimal(settings["cpuPeakGiB"]) if settings["cpuPeakGiB"] else None
    cpu_seconds = Decimal(settings["cpuJobSeconds"]) if settings["cpuJobSeconds"] else None
    cpu_billable = Decimal(settings["cpuBillableSeconds"]) if settings["cpuBillableSeconds"] else None
    deadline = Decimal(settings["deadlineSeconds"]) if settings["deadlineSeconds"] else None
    cpu_cost = rate_amount * cpu_billable / 3600 if rate_amount is not None and cpu_billable is not None and compute == "cpu" else None
    if compute == "cpu":
        # CPU pipelines may include voice models and decoders. Do not fill the
        # screen with inapplicable text-generation/TP cache calculations.
        groups[0]["title"] = "Model files"
        groups[0]["metrics"] = [
            item for item in groups[0]["metrics"]
            if item["id"] in ("stored", "weights") or item["id"].startswith("dtype-")
        ]
        groups = [groups[0], {
            "id": "cpu", "title": "CPU experiment",
            "metrics": [
                metric("cpuInstance", "CPU instance to test", settings["cpuInstance"], "", "DECLARED", "Your experiment profile. This is not a solver-selected deployment.", source=CPU_SPECS),
                metric("cpuArchitecture", "CPU architecture", cpu["architecture"], "", "PUBLISHED", "An ARM64 image and compatible native dependencies are required on Graviton.", source=CPU_SPECS),
                metric("cpuVcpus", "Virtual CPUs", cpu["vcpus"], "vCPUs", "PUBLISHED", "Thread count and CPU instructions affect performance.", source=CPU_SPECS),
                metric("cpuRam", "Instance RAM", cpu["memoryGiB"], "GiB", "PUBLISHED", "Allow memory for the OS and all concurrent workers.", source=CPU_SPECS),
                metric("cpuPeak", "Reported process memory", cpu_peak, "GiB", "SUPPLIED", "Supplied observation; the run and workload have not been independently validated."),
                metric("cpuJob", "Reported completion time", cpu_seconds, "seconds", "SUPPLIED", "Include queueing, loading and output processing for a job deadline."),
                metric("cpuDeadline", "Completion budget", deadline, "seconds", "DECLARED", "Your maximum acceptable queue-to-completion time."),
                metric("cpuWithinDeadline", "Reported run within budget", "Yes" if cpu_seconds <= deadline else "No", "", "SUPPLIED", "A single supplied run is not a percentile or a production guarantee.")
                if cpu_seconds is not None and deadline is not None else metric("cpuWithinDeadline", "Reported run within budget", None, "", "NOT_AVAILABLE", "Supply a run time and completion budget."),
                metric("cpuBillable", "Reported allocated time", cpu_billable, "seconds", "SUPPLIED", "Compute billing can start before the model runs and continue until the resource stops."),
                metric("cpuHourly", "EC2 hourly rate", rate_amount, "USD/hour", rate_basis, settings["rateDescription"] or "Linux shared-tenancy EC2 On-Demand; Fargate and SageMaker have different meters.", source=(rate or {}).get("sourceUrl")),
                metric("cpuCost", "Compute for the supplied allocation", cpu_cost, "USD", "CALCULATED", "Based on supplied billable time. Storage, network, logs and other services are additional.", "Allocated seconds ÷ 3,600 × hourly rate"),
            ],
        }]
        if cpu_peak is not None and cpu_peak >= cpu["memoryGiB"]:
            warnings.append("Reported process memory leaves no room on this instance. Choose more RAM or reduce memory before testing.")
        warnings.append("CPU observations are supplied evidence. They never pass the deployment solver's performance or compatibility checks automatically.")
    elif compute == "api":
        groups = [groups[1]]
    identity = {"model": m, "workload": w, "constraints": request.get("constraints"),
                "qualification": request.get("qualification"),
                "settings": settings, "profile": profile, "rate": rate}
    return {
        "schemaVersion": 1, "scope": "PLANNING_ONLY", "performanceMeasured": False,
        "reportHash": hashlib.sha256(json.dumps(identity, sort_keys=True, default=str).encode()).hexdigest(),
        "retrievedAt": retrieved_at, "settings": settings,
        "model": {"name": m.get("name"), "repo": profile.get("repo"),
                  "revision": profile.get("revision") or m.get("artifactDigest")},
        "groups": groups,
        "compute": compute, "guidance": guidance,
        "benchmark": benchmark_guidance(settings["workloadKind"]),
        "cpuChoices": [{"instance": key, **value} for key, value in CPU_PROFILES.items()],
        "pricing": rate,
        "memorySegments": [
            {"id": "weights", "label": "Weights", "gib": display(weights / GIB) if weights is not None else None},
            {"id": "cache", "label": "Attention cache", "gib": display(cache / GIB) if cache is not None else None},
            {"id": "runtime", "label": "Runtime allowance", "gib": display(extra / GIB) if extra is not None else None},
        ],
        "hardware": hardware.to_json() if hardware else None,
        "hardwareChoices": [a.to_json() for a in ACCELERATORS],
        "memoryFit": layout.get("fits"), "limitations": warnings,
        "selectionReason": "First memory fit in the published shortlist; not a price ranking."
        if settings["hardwareId"] == "auto" else "You selected this hardware profile.",
    }
