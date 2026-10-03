"""Workload-specific experiment guidance, separate from placement qualification."""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

WORKLOADS = {
    "general": ("Your inference workload",
                ["Task quality", "End-to-end latency at expected load", "Completed work per dollar"],
                ["Establish a representative input set", "Measure cold and warm requests separately"]),
    "chat": ("Interactive text",
             ["Time to first text", "Time between output tokens", "Completed answers per second at target concurrency", "Answer quality"],
             ["Continuous batching and cache capacity", "Speculative decoding when supported; check quality and acceptance rate"]),
    "rag": ("Questions over documents",
            ["Answer correctness and grounding", "First-token latency by input length", "Throughput with realistic retrieved context"],
            ["Prefix caching with measured hit rates", "Chunked prefill and retrieval latency"]),
    "code": ("Code generation",
             ["Tests passed by generated code", "Time to first token and complete patch", "Cost per accepted result"],
             ["Serving engine and kernels", "Speculative decoding; verify task correctness"]),
    "batch": ("Offline text processing",
              ["Task quality", "Queue-to-completion deadline", "Completed items per hour", "Cost per completed item"],
              ["Try CPU when the runtime and memory fit", "Batch size, parallel workers and model-load amortization"]),
    "tts": ("Batch speech",
            ["Complete, decodable audio for the supplied text", "Synthesis seconds / audio seconds", "Queue-to-completion time",
             "Peak process memory", "Cost per completed job", "Listening quality, when it is a requirement"],
            ["CPU runtime, thread count and the precision the runtime actually uses", "Load the model once and reuse it across jobs",
             "Compare GPU only if the CPU deadline, concurrency or economics fall short"]),
    "voice": ("Live voice",
              ["Time to first audio", "Pause in a complete conversation", "Audio continuity at peak concurrency", "Listening quality"],
              ["Measure the whole audio pipeline", "Streaming support, audio chunk size and warm capacity"]),
    "embeddings": ("Embeddings and reranking",
                   ["Retrieval or ranking quality", "Documents per second by input length", "Tail latency and cost per document"],
                   ["CPU kernels and vector instructions", "Batch size; compare GPU when throughput requires it"]),
    "classification": ("Classification",
                       ["Per-class accuracy and error costs", "Items per second", "Tail latency or completion deadline"],
                       ["CPU runtime and quantization with a quality check", "Batch size and input-length distribution"]),
    "multimodal": ("Images, audio and text",
                   ["Task quality for each modality", "End-to-end latency", "Memory and throughput of each component"],
                   ["Profile encoders, generators and decoders separately", "Avoid applying a text-token roofline to the whole pipeline"]),
}

CPU_SERVICES = [
    {
        "id": "batch", "name": "AWS Batch", "fit": "Queued or scheduled jobs",
        "detail": "Run a container on EC2 CPU instances or Fargate. Start with a job deadline, queue limits and a scale-down policy. Startup and model loading count toward the deadline.",
        "sourceUrl": "https://docs.aws.amazon.com/batch/latest/userguide/what-is-batch.html",
    },
    {
        "id": "fargate", "name": "Amazon ECS on Fargate", "fit": "CPU containers without managing hosts",
        "detail": "Use for compatible CPU jobs or services within the supported task sizes. Include image pull and model download. Fargate does not expose GPUs.",
        "sourceUrl": "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html",
    },
    {
        "id": "ec2", "name": "Amazon EC2 CPU", "fit": "Control over memory, instructions and model reuse",
        "detail": "Compare compute-optimized C instances and memory-optimized R instances using measured process memory. Persistent workers can amortize loading; allocated instances cost money while idle.",
        "sourceUrl": "https://docs.aws.amazon.com/ec2/latest/instancetypes/instance-types.html",
    },
    {
        "id": "sagemaker", "name": "Amazon SageMaker AI CPU", "fit": "Managed serving or offline transformation",
        "detail": "CPU endpoints and Batch Transform can serve compatible models. Check the container, payload limits, job mode and instance support. SageMaker does not imply GPU.",
        "sourceUrl": "https://docs.aws.amazon.com/sagemaker/latest/dg/batch-transform.html",
    },
    {
        "id": "lambda", "name": "AWS Lambda", "fit": "Small, short, event-driven inference",
        "detail": "For standard Lambda functions, test the 10,240 MB memory and 15-minute invocation limits, package size, cold starts and available CPU. A model that fits on disk may still exceed process memory. Evaluate other Lambda compute modes separately.",
        "sourceUrl": "https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html",
    },
]


def benchmark_guidance(kind: str) -> dict:
    title, metrics, levers = WORKLOADS.get(kind, WORKLOADS["general"])
    return {
        "title": title, "metrics": metrics, "levers": levers,
        "record": [
            "Exact model revision and all pipeline components",
            "Container digest, engine version, precision and cache settings",
            "CPU architecture and threads, or GPU type and parallelism",
            "Representative inputs, output lengths, arrival rate and concurrency",
            "Cold/warm timing, sample count, percentiles, errors and quality results",
            "Run date, Region, resource lifetime and billable usage",
        ],
        "sourceUrl": "https://docs.aws.amazon.com/sagemaker/latest/dg/inference-recommender.html",
        "note": "These are experiments to run, not results. A published optimization or a different customer's benchmark does not verify this configuration.",
    }


EXAMPLE = Path(__file__).resolve().parents[1] / "catalog" / "speech_example.json"


def recorded_example() -> dict | None:
    """A sanitized record of one real run, or nothing; never a placeholder."""
    return json.loads(EXAMPLE.read_text()) if EXAMPLE.is_file() else None


def compute_guidance(request: dict, settings: dict, weights_bytes: Decimal | None = None,
                     *, cpu_memory_gib: int = 64) -> dict:
    """Choose a next experiment, never infer a universal CPU parameter cutoff."""
    kind = settings["workloadKind"]
    qualification = request.get("qualification") or {}
    pattern = settings["servingMode"]
    if pattern == "unsure":
        pattern = qualification.get("servingPattern", "unsure")
    concurrency = settings.get("jobConcurrency") or (request.get("workload") or {}).get("concurrency")
    low_concurrency = concurrency is not None and str(concurrency) != "" and Decimal(str(concurrency)) <= 2
    batch = pattern == "batch" or (pattern == "unsure" and kind in {"batch", "tts"})
    native = (request.get("model") or {}).get("weightsExportable") is False or (request.get("model") or {}).get("sourceKind") == "bedrock"
    runtime = settings["cpuRuntime"]
    weight_floor = weights_bytes / Decimal(1024**3) if weights_bytes is not None else None
    reported_peak = Decimal(settings["cpuPeakGiB"]) if settings["cpuPeakGiB"] else None
    reported_time = Decimal(settings["cpuJobSeconds"]) if settings["cpuJobSeconds"] else None
    deadline = Decimal(settings["deadlineSeconds"]) if settings["deadlineSeconds"] else None
    memory_exceeds = any(value is not None and value >= cpu_memory_gib for value in (weight_floor, reported_peak))
    cpu_trial = settings["computePreference"] == "cpu" or batch and low_concurrency or kind in {"embeddings", "classification"}
    if native:
        priority, title = "MANAGED_API", "Check the hosted API"
        why = "This request identifies an already-hosted model. Self-hosting requires separate downloadable artifacts and permission to use them."
    elif runtime == "unsupported":
        priority, title = "GPU_BENCHMARK", "The selected runtime rules out CPU"
        why = "You marked the CPU runtime as unsupported. Find a compatible CPU runtime or benchmark an accelerator configuration."
    elif cpu_trial and memory_exceeds:
        priority, title = "CPU_MEMORY_REVIEW", "The selected CPU profile needs more memory"
        why = "The weight estimate or reported process peak reaches this machine's RAM limit before allowing for the OS and other workers. Choose a larger-memory CPU profile or explore GPUs; batch delivery does not remove this limit."
    elif cpu_trial and reported_time is not None and deadline is not None and reported_time > deadline:
        priority, title = "CPU_DEADLINE_REVIEW", "The reported CPU run misses the deadline"
        why = "Check where time was spent: queueing, startup, loading or generation. Test reuse, a faster CPU or GPU acceleration, then repeat the full job measurement."
    elif batch and low_concurrency:
        priority, title = "CPU_BENCHMARK_FIRST", "Test CPU before reserving GPUs"
        why = "Queued work with low concurrency can trade completion time for simpler compute. First check runtime support, peak memory and the full job deadline."
    elif kind in {"embeddings", "classification"}:
        priority, title = "CPU_AND_GPU", "Start with a CPU baseline"
        why = "These tasks can be efficient on CPU, depending on the model and input length. Compare GPU when the measured arrival rate or latency requires it."
    elif kind in {"chat", "code", "rag", "voice"} and pattern == "interactive":
        priority, title = "GPU_BENCHMARK", "Benchmark for interactive response"
        why = "Tail latency, long contexts and concurrent generation can favor accelerators. Small models may still meet the target on CPU; measure rather than exclude them by name."
    else:
        priority, title = "NEEDS_WORKLOAD", "Establish the workload before choosing compute"
        why = "CPU versus GPU depends on the runtime, deadline, memory and arrival rate. A model size or traffic total alone cannot answer it."
    checks = [
        {"label": "CPU runtime", "value": {"unknown": "Not verified", "supported": "Reported supported", "unsupported": "Reported unsupported"}[runtime],
         "detail": "Confirm all operators and dependencies run on CPU. A laptop with no discrete GPU may still use Apple Metal or another integrated accelerator."},
        {"label": "Delivery", "value": {"batch": "Queued / batch", "interactive": "Interactive", "both": "Both", "unsure": "Not specified"}.get(pattern, "Not specified"),
         "detail": "Include queueing, image pull, model loading and generation in a batch deadline."},
        {"label": "Concurrent jobs", "value": str(concurrency) if concurrency not in (None, "") else "Not specified",
         "detail": "Low concurrency is an experiment priority, not a proof that CPU will meet demand."},
        {"label": "Completion budget", "value": f"{settings['deadlineSeconds']} seconds" if settings["deadlineSeconds"] else "Not specified",
         "detail": "A batch completion budget differs from first-token or first-audio latency."},
        {"label": "CPU memory screen",
         "value": "Exceeds selected RAM" if memory_exceeds else "Peak measurement needed" if reported_peak is None else "Reported peak below RAM",
         "detail": f"The selected CPU profile has {cpu_memory_gib} GiB RAM. Include every loaded model, decoder, process and concurrent worker; a weight-only estimate is a floor."},
    ]
    return {
        "priority": priority, "title": title, "reason": why, "checks": checks,
        "cpuServices": CPU_SERVICES,
        "sizeGuidance": [
            "There is no universal parameter-count cutoff. Measure peak resident memory, supported operations and time per item.",
            "A rough weight-only floor is parameters × bytes per parameter: FP32 uses 4, BF16/FP16 2, INT8 1. Runtime expansion, caches, audio decoders and simultaneous models add memory.",
            "For scale: 1.7B FP32 weights alone need about 6.3 GiB; 7B need 26.1 GiB; 70B need 260.8 GiB. Halving storage precision only halves that floor if the CPU runtime actually uses it without expanding the weights.",
            "Large generative models, long context, high concurrency or a missed deadline can make CPU impractical even when RAM is sufficient.",
        ],
        "graviton": "Graviton is an ARM CPU option, not a GPU. Build an ARM64 image with compatible libraries and kernels, then compare completed work per dollar against x86. Do not reuse an x86 timing or assume a fixed speedup.",
        "example": recorded_example(),
        "qualifiesDeployment": False,
    }
