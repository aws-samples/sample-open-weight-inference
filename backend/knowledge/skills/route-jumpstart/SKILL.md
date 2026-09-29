---
name: route-jumpstart
description: Evaluate SageMaker JumpStart as a supported model and deployment starting point. Use when a model is missing from Bedrock, a customer asks about JumpStart, or a catalog example must be distinguished from hosting a private fine-tuned checkpoint.
---
# Check the SageMaker JumpStart path

**Decision:** Does JumpStart provide a suitable, supported starting configuration for the required model?

JumpStart helps discover and deploy models. It is not the boundary of all models that SageMaker can serve, and a catalog model does not establish support for every customer checkpoint derived from it.

## Check the starting point

1. Find the exact model ID and version in the current JumpStart catalog for the target Region. Record task, input/output contract, license or EULA, supported instances and serving image.
2. Determine whether the participant wants the provided model or their own fine-tune. For a private checkpoint, verify that the selected deployment method actually accepts those weights and its required packaging.
3. Check server capabilities, including context, streaming, quantization and adapters. A notebook's default instance is a starting point, not a workload-specific sizing recommendation.
4. Establish model quality with the task evaluation, then benchmark candidate configurations against SLOs. Quota and capacity checks remain separate from model catalog support.
5. Check artifacts, container provenance and account/network permissions before creating resources.

If the catalog has no match, continue to the compatible-container path. Do not report that SageMaker cannot host the model merely because JumpStart lacks a template.

## Make the handoff usable

Return a deployment manifest to prepare: model/version, artifact source, container/version, Region, candidate hardware, endpoint mode, test workload and cleanup owner. Use current public examples or the supported SDK; avoid copying an old notebook's unpinned image and presenting it as production-ready.

Inference Recommender can help benchmark supported SageMaker configurations. It runs experiments that consume AWS resources; it is not evidence already collected by EDᗡIE.

## Return and revisit

Explain which setup work JumpStart supplies and which checks belong to the customer. EDᗡIE currently provides guidance rather than a general JumpStart deployment control. Revisit the manifest when the catalog model, image, checkpoint or performance target changes.

## Sources

- [SageMaker JumpStart](https://docs.aws.amazon.com/sagemaker/latest/dg/studio-jumpstart.html)
- [SageMaker deployment methods](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
- [Inference Recommender](https://docs.aws.amazon.com/sagemaker/latest/dg/inference-recommender.html)
