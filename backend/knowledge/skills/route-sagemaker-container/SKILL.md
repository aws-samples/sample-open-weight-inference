---
name: route-sagemaker-container
description: Check a SageMaker inference container for an existing model, including architecture, serving contract, CPU or GPU backend, CUDA driver compatibility and artifact loading. Use for BYOC, unsupported JumpStart models and container-start failures.
---
# Verify a SageMaker serving container

**Decision:** Can a supported or customer-owned inference image serve the exact artifact on the selected hardware?

Establish three independent facts: the model fits, the software can run it, and the resulting service meets the SLO. More VRAM cannot fix a missing model implementation or an incompatible kernel.

## Validate the stack

| Layer | Evidence to collect |
| --- | --- |
| Artifact | Revision/digest, format, tokenizer, architecture, custom code and adapters |
| Server | Image digest, runtime version, supported task/API, model implementation |
| Hardware | CPU instruction set or accelerator architecture, memory and topology |
| GPU software | Container CUDA/runtime requirements, host driver and available inference AMI |
| Hosting contract | Model loading, health checks, request handling, timeout and shutdown behavior |
| Isolation | Execution role, model access, network policy, logging and secret handling |

For a startup failure, separate download errors, health-check timeouts, model-code exceptions, CPU/GPU image mismatch and driver/kernel incompatibility. Capture the actual failure and image/instance versions before suggesting a fix.

SageMaker exposes `InferenceAmiVersion` for applicable endpoint configurations; Batch Transform has `TransformAmiVersion`. Check the current API values and container compatibility documentation. Do not compare CUDA and driver version numbers as if they shared one version scale, or enable compatibility libraries indiscriminately.

## Prove serving behavior

Start with an authorized, bounded smoke test of artifact loading and representative requests. Then measure quality, latency, throughput and memory under the intended concurrency. Passing health checks alone does not qualify the configuration.

Avoid executing model repository code simply to inspect metadata. Any required custom code or image belongs in the customer's reviewed build process.

## Return and revisit

Return the compatibility evidence, exact failure category if any, and the smallest next test. EDᗡIE's existing deploy recipe is narrower than general SageMaker BYOC; do not promise that an arbitrary image can be launched from the trial page.

## Sources

- [SageMaker inference container contract](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms-inference-code.html)
- [NVIDIA Container Toolkit compatibility](https://docs.aws.amazon.com/sagemaker/latest/dg/container-nvidia-compliance.html)
- [Endpoint configuration and inference AMI options](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_ProductionVariant.html)
- [Batch Transform resource and AMI options](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_TransformResources.html)
