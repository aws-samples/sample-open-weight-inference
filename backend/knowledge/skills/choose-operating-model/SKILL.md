---
name: choose-operating-model
description: Compare managed APIs, managed model serving and an existing self-managed platform using workload needs and operating responsibilities. Use before treating services as a fixed fallback ladder.
---
# Choose who operates each layer

**Decision:** Which responsibilities must the customer control, and which do they want managed?

Evaluate service fit alongside model fit. Do not force an established EC2/EKS platform through a sequence of service rejections, or make a new team operate a cluster solely because weights are downloadable.

## Establish the operating constraints

Ask about an existing production platform, on-call ownership, custom containers/kernels, accelerator requirements, autoscaling, isolation and upgrade responsibility. Capture the cost and migration effort of changing platforms.

| Route | Responsibility to discuss |
| --- | --- |
| Native Bedrock model API | Model selection, application behavior, access, usage and evaluation |
| Bedrock Custom Model Import | Compatible supplied artifact and import lifecycle, with AWS-managed serving |
| SageMaker inference | Container/model configuration, endpoint mode, sizing and scaling on managed infrastructure |
| HyperPod inference | Cluster-based serving with managed capabilities; Kubernetes skills and integration still matter |
| EC2/EKS | Customer-owned runtime, orchestration, scaling, upgrades and recovery |
| CPU batch/container jobs | Queue, deadline, worker lifecycle and artifact loading |

JumpStart is a model discovery and deployment starting point within SageMaker. Absence from its catalogue does not exhaust SageMaker's custom-model capabilities.

## Make the comparison

First eliminate only evidenced incompatibilities. Then identify a small set of feasible operating models and the cost/performance experiments needed to compare them. A model listed in Bedrock can still fail a workload requirement; a self-managed route can still be the right fit when a mature team values specific controls.

Include deployment lead time, operational work and capacity uncertainty. "Managed" does not mean no customer responsibilities. "Self-managed" does not imply a GPU; CPU workloads can use these routes too.

## Return and revisit

Return the preferred operating responsibilities, viable alternatives and what evidence would alter the choice. Separate AWS capability from EDᗡIE's implemented recipes. Do not equate a documented route with an available deploy button.

Revisit after platform staffing, isolation requirements, serving software or launch dates change.

## Sources

- [SageMaker inference options](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
- [SageMaker JumpStart](https://docs.aws.amazon.com/sagemaker/latest/dg/studio-jumpstart.html)
- [HyperPod model deployment](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-model-deployment.html)
