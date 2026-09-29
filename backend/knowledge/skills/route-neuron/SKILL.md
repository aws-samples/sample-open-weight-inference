---
name: route-neuron
description: Assess AWS Inferentia or Trainium for inference through Neuron-supported models and runtimes. Use for accelerator alternatives, compiler compatibility, supported shapes and GPU-to-Neuron migration.
---
# Assess Neuron accelerators for inference

**Decision:** Can a supported Neuron configuration meet the workload with a worthwhile measured benefit?

Inferentia and supported Trainium instances can run inference. A hardware family associated with training is not an instruction to train a model. Preserve the existing checkpoint and inference objective.

## Qualify compatibility before economics

1. Identify the exact architecture, checkpoint format, precision and required operators.
2. Check the current Neuron SDK, NxD Inference or supported vLLM integration for that model and hardware generation.
3. Record compile requirements, supported input/context shapes, batching and parallelism. Verify adapters, multimodal processing and custom operations individually.
4. Check memory and NeuronCore placement, then benchmark the intended input/output lengths and concurrency.
5. Include model compilation, artifact storage, startup and operational migration work in the comparison.

CUDA compatibility or a working GPU container does not establish Neuron compatibility. A model absent from a supported list needs an engineering investigation, not an automatic throughput estimate.

## Evaluate a useful experiment

Compare a quality-checked checkpoint against the current baseline using the same SLOs and arrival pattern. Capture compile/runtime versions, hardware, precision, error rate, latency distribution, throughput and actual charged duration.

Do not extrapolate a different model's advertised price/performance ratio. An apparently cheaper hourly instance can be more expensive if it needs additional replicas or misses the deadline.

## Return and revisit

Return supported, unsupported or unresolved compatibility; the exact runtime/hardware pair; the migration tasks; and the benchmark required before choosing. Preserve GPU or CPU alternatives until the evidence resolves the decision.

EDᗡIE's current GPU sizing formulas are not Neuron sizing formulas. The Advisor must present this route as a documented handoff instead of fabricating a Neuron fleet or claiming a deployment completed.

## Sources

- [NxD Inference and supported Neuron workflows](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/libraries/nxd-inference/index.html)
- [AWS accelerated instance characteristics](https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html)
- [SageMaker inference configuration options](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_ProductionVariant.html)
