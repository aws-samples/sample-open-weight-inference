---
name: size-moe-parallelism
description: Plan deployable tensor, pipeline, expert and data parallelism for dense or MoE models. Use when active parameters are confused with resident weights, GPU counts are rounded only by VRAM, or a multi-node layout is proposed.
---
# Plan a deployable model replica

**Decision:** How can the exact model be placed across devices using a supported runtime layout?

Separate **one replica's layout** from **the number of replicas**. Tensor, pipeline and expert parallelism distribute model work; data parallelism adds serving replicas. A topology that fits is not automatically the lowest-latency one.

## Establish the model facts

Record total tensor bytes, expert count and routing, any active-parameter estimate, attention geometry, precision and auxiliary components. For MoE, inactive experts still require storage and placement unless an explicit offloading strategy is being evaluated.

Do not apply an active-parameter estimate for one architecture to another. Shared layers, expert shapes, routing and quantization metadata affect the accounting.

## Check placement constraints

1. Compute a memory lower bound using weights, cache and runtime allocations.
2. Check supported parallel degrees, attention/KV-head divisibility and any replicated tensors or caches.
3. Choose an actual instance topology. Seven devices needed by a memory division does not establish a supported seven-way tensor-parallel deployment.
4. Prefer an in-box layout when it meets requirements, then measure. If multiple nodes are needed, verify communication support, interconnect, placement and collective performance.
5. For expert parallelism, test routing imbalance and communication at representative token distributions.
6. Add independent replicas for traffic and resilience only after establishing one replica's behavior.

NVLink/NVSwitch connectivity, PCIe and inter-node networking have different performance properties. A count of GPUs multiplied by advertised bandwidth is not a measured serving rate.

## Return and revisit

Return tensor/pipeline/expert layout, GPUs per replica, replicas per instance, instance count, network needs and unresolved runtime checks. EDᗡIE's current sizing model has a bounded set of single-node layouts; unsupported multi-node or expert layouts require a separate benchmark.

Revisit when hardware, runtime, quantization, sequence length or expert routing changes. Do not label a roofline estimate as empirical throughput.

## Sources

- [vLLM parallelism and scaling](https://docs.vllm.ai/en/latest/serving/parallelism_scaling.html)
- [AWS accelerator memory and topology characteristics](https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html)
- [Runtime quantization support](https://docs.vllm.ai/en/latest/features/quantization/)
