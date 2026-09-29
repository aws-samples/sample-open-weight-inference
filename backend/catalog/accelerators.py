"""A small, sourced hardware shortlist for planning, not an availability claim.

Memory is in GiB, as in the EC2 instance specifications. The published bandwidth
and dense BF16 compute ceilings are not measurements of any inference workload.
No entry in this catalogue grants permission to deploy that instance.
"""
from dataclasses import asdict, dataclass

AWS_SPECS = "https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html"
REVIEWED = "2026-09-23"


@dataclass(frozen=True)
class Accelerator:
    instance: str
    accelerator: str
    gpus: int
    memory_gib: int
    bandwidth_gbps: int
    bf16_tflops: float
    interconnect: str
    compute_source: str

    def to_json(self) -> dict:
        return {**asdict(self), "sourceUrl": AWS_SPECS, "reviewedAt": REVIEWED,
                "basis": "PUBLISHED", "availability": "NOT_CHECKED"}


ACCELERATORS = (
    Accelerator("g6.2xlarge", "NVIDIA L4", 1, 22, 300, 121, "One GPU",
                "https://www.nvidia.com/en-us/data-center/l4/"),
    Accelerator("g5.2xlarge", "NVIDIA A10G", 1, 22, 600, 125, "One GPU",
                "https://www.nvidia.com/en-us/data-center/products/a10-gpu/"),
    Accelerator("g6e.2xlarge", "NVIDIA L40S", 1, 44, 864, 366.5, "One GPU",
                "https://www.nvidia.com/en-us/data-center/l40s/"),
    Accelerator("g5.12xlarge", "NVIDIA A10G", 4, 22, 600, 125, "PCIe; communication cost is not modeled",
                "https://www.nvidia.com/en-us/data-center/products/a10-gpu/"),
    Accelerator("p5.48xlarge", "NVIDIA H100", 8, 80, 3350, 989, "NVLink / NVSwitch within the node",
                "https://www.nvidia.com/en-us/data-center/h100/"),
    Accelerator("p5e.48xlarge", "NVIDIA H200", 8, 141, 4800, 989, "NVLink / NVSwitch within the node",
                "https://www.nvidia.com/en-us/data-center/h200/"),
    Accelerator("p6-b200.48xlarge", "NVIDIA B200", 8, 179, 8000, 2250, "NVLink / NVSwitch within the node",
                "https://www.nvidia.com/en-us/data-center/hgx/"),
)
