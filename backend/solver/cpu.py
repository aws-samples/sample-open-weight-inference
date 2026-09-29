"""CPU candidate checks and same-period costs; no inferred performance."""
from decimal import Decimal

from .models import Candidate, Gate, GateStatus, PlacementRequest, Target
from .money import CostBreakdown, Evidence, LineItem, Rate

CPU_TARGETS = frozenset({Target.EC2_CPU, Target.AWS_BATCH_CPU})
CPU_INSTANCE = "c7i.8xlarge"
CPU_RAM_GIB = Decimal("64")
CPU_SPEC_URL = "https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html"
QWEN_TTS_REPOS = frozenset({
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
})


def cpu_gates(candidate: Candidate, request: PlacementRequest) -> tuple[Gate, ...]:
    """Retain CPU with missing requirements; reject only a stated incompatibility."""
    if candidate.target not in CPU_TARGETS:
        return ()
    answers = request.qualification
    known_example = (
        request.model.hf_repo in QWEN_TTS_REPOS
        and request.model.source_kind != "checkpoint"
    )
    runtime_required = answers.get("cpuRuntime") == "gpu-required"
    example_note = (
        " A recorded Qwen3-TTS Base + CustomVoice CPU run demonstrates offline "
        "feasibility, not this project's revision, complete runtime or performance."
        if known_example else ""
    )
    runtime = Gate(
        "cpu_runtime", GateStatus.FAIL if runtime_required else GateStatus.UNKNOWN,
        "The specified runtime requires GPU operators. Use a compatible CPU implementation or change this requirement."
        if runtime_required else
        "Validate a CPU-only container, dependencies, precision and audio/model components for this exact artifact."
        + example_note,
        "declared:cpuRuntime" if runtime_required else
        ("recorded-example:qwen-tts-cpu-20260923" if known_example else None),
    )
    weights = request.model.weights_gb
    too_large = weights is not None and weights >= CPU_RAM_GIB
    memory = Gate(
        "cpu_memory", GateStatus.FAIL if too_large else GateStatus.UNKNOWN,
        f"The declared weight footprint ({weights} GiB) reaches or exceeds this {CPU_RAM_GIB} GiB RAM profile. "
        "This candidate keeps the full model resident; a larger CPU profile or an explicit offload plan must be evaluated separately."
        if too_large else
        f"This CPU profile has {CPU_RAM_GIB} GiB RAM. Measure peak process memory including runtime precision, "
        "all models, decoders, OS headroom and concurrent workers. Weight storage alone does not establish a fit.",
        CPU_SPEC_URL,
    )
    pattern = answers.get("servingPattern")
    if candidate.target is Target.AWS_BATCH_CPU and pattern in ("interactive", "both"):
        delivery = Gate(
            "cpu_delivery", GateStatus.FAIL,
            "This candidate is a queued Batch job, not a live streaming endpoint. "
            "Use the EC2 CPU service candidate to benchmark interactive delivery, or separate the offline workload.",
            "declared:servingPattern",
        )
    else:
        questions = []
        if pattern not in ("interactive", "batch", "both"):
            questions.append("Do people need live output or can the work run in a queue?")
        if pattern != "interactive" and not answers.get("completionDeadlineSeconds"):
            questions.append("What is the completion deadline, including startup and model loading?")
        if request.workload.concurrency is None:
            questions.append("How many jobs or requests can run at the same time?")
        if request.workload.requests is None:
            questions.append("How many complete jobs or requests will run in the comparison period, and what is one job?")
        delivery = Gate(
            "cpu_delivery", GateStatus.UNKNOWN,
            "CPU remains an option. " + " ".join(questions) if questions else
            "The delivery and workload inputs are recorded. Benchmark that workload before accepting this CPU configuration.",
        )
    return runtime, memory, delivery


def cpu_cost(candidate: Candidate, request: PlacementRequest, hourly: Rate | None) -> CostBreakdown:
    """Never compare a sample's single-job cost with another target's monthly cost."""
    workload = request.workload
    batch = candidate.target is Target.AWS_BATCH_CPU
    hours = workload.dedicated_instance_hours
    # An always-on EC2 worker can be costed as such. Batch is never silently
    # treated as 720 busy hours, nor assigned the example's 635-second lifetime.
    if hours is None and not batch:
        hours = workload.horizon_hours
    if hours is None:
        compute = LineItem(
            label="AWS Batch EC2 allocated compute — schedule needed",
            phase="serving", quantity=Decimal("1"), quantity_unit="allocation plan",
            rate=None, evidence=Evidence.UNKNOWN,
            note=f"Enter allocated instance hours over the same {workload.horizon_hours}-hour comparison period. "
            "Include all jobs, startup, loading, idle time, retries and shutdown. The podcast sample is not reused.",
        )
    else:
        compute = LineItem(
            label=("AWS Batch EC2 CPU" if batch else "EC2 CPU") + " allocated compute",
            phase="serving", quantity=hours * candidate.instance_count,
            quantity_unit="instance-hour", rate=hourly,
            note=f"{hours} allocated hours per worker over {workload.horizon_hours} hours. "
            + ("Uses the shared allocation schedule, including startup, idle time and shutdown. "
               if workload.dedicated_instance_hours is not None else
               "Assumes continuous allocation because no start/stop schedule was supplied. ")
            + "The same schedule is used for dedicated SageMaker compute; equal allocated time does not prove equal throughput.",
        )
    field = "batchAdditionalCostUsd" if batch else "cpuAdditionalCostUsd"
    allowance = request.qualification.get(field)
    basis = request.qualification.get("cpuCostNotes")
    extra = LineItem(
        label="Supporting services over the comparison period",
        phase="serving", quantity=Decimal("1"), quantity_unit="period allowance",
        rate=Rate.usd(allowance, "USD/period", region=candidate.region,
                      source="User-supplied allowance: " + basis) if allowance is not None and basis else None,
        evidence=Evidence.PROJECTED if allowance is not None and basis else Evidence.UNKNOWN,
        note=basis or "Add a sourced allowance for EBS/S3, networking or IP, logs and request charges. "
        "Missing charges are not zero; AWS Batch has no additional scheduling fee.",
    )
    return CostBreakdown(items=(compute, extra))
