---
name: resolve-bedrock-catalog-gap
description: Find an AWS inference path when Bedrock does not list the requested model or feature. Distinguish catalog absence, account access, Region, custom checkpoint, API gaps and tool implementation gaps before considering import, JumpStart, containers or compute.
---
# Resolve a missing Bedrock model or feature

**Decision:** What can run the required workload on AWS while preserving the actual requirement?

First classify the gap. “Bedrock does not support it” could mean an absent model, a different revision, an unavailable Region, missing account access, an incompatible API, a private fine-tune, or an incomplete EDᗡIE catalog. Each calls for a different action.

## Follow the evidence

| Situation | Next check |
| --- | --- |
| Exact model exists but invocation fails | Access, inference profile, Region and API contract |
| Customer requires their own downloadable checkpoint | Import compatibility and SageMaker container compatibility |
| Open-weight model is absent from the native catalog | JumpStart catalog, suitable container, and optional Marketplace offering |
| Model requires a custom server or accelerator configuration | SageMaker container control, HyperPod or EC2/EKS according to operating needs |
| Small or tolerant offline workload | Keep CPU/Batch in the shortlist before assuming a GPU |
| Model has no obtainable weights | Verify an authorized hosted offering; self-hosting cannot recreate missing weights |
| Another model may solve the task | Ask permission to evaluate a substitute; retain the original requirement |

Do not make this a universal service waterfall. A compatible import may suit a bursty custom model; a supported container may suit runtime control; a catalog API may suit a different model that passes evaluation. The selection follows evidence about the workload and the team's requirements.

## Preserve decision continuity

Keep artifact identity, quality criteria, data boundaries, traffic shape and deadline the same when comparing paths. Recalculate cost on a common period. Switching hosting does not prove equivalent outputs, latency or availability.

Record whether an option was **ruled out**, **needs verification**, or **not evaluated by this installation**. In particular, a missing EDᗡIE deployment adapter is not evidence that AWS cannot host the model.

## Return and revisit

Produce a short path table: exact gap, viable next path, unresolved check, owner and next experiment. Record the missing model/version/Region/API capability as a service-gap handoff. A launch ETA requires an authoritative commitment; the Advisor must not invent one.

## Sources

- [Bedrock catalog](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html)
- [Custom Model Import requirements](https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html)
- [SageMaker deployment choices](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
- [Bedrock Marketplace deployment model](https://docs.aws.amazon.com/bedrock/latest/userguide/amazon-bedrock-marketplace.html)
