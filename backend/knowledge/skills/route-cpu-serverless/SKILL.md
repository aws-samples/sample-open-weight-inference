---
name: route-cpu-serverless
description: Choose CPU hosting among Fargate, Lambda, SageMaker serverless and EC2 using memory, runtime duration, startup, instruction-set support and workload shape. Use for small intermittent inference and Graviton questions.
---
# Choose a CPU execution environment

**Decision:** Which service envelope fits the measured CPU workload?

First establish peak memory, temporary storage, image/artifact size, processing duration, request shape and required native libraries. A small parameter count does not prove that the full runtime fits a small service allocation.

| Option | Useful starting condition | Deciding checks |
| --- | --- | --- |
| AWS Batch on EC2 | Queued jobs need flexible memory, CPU or long runtimes | Placement, worker lifetime, startup, retry and deadline |
| ECS or Batch on Fargate | A CPU container fits a supported task size | CPU/memory combination, architecture, storage, runtime features and startup |
| Lambda | Short, bounded inference fits the selected execution environment | Memory, duration, package/storage limits, loading time and concurrency |
| SageMaker serverless | Intermittent model requests fit its hosting contract | Memory envelope, CPU support, feature exclusions and cold starts |
| EC2 | Requirements need larger memory or direct runtime control | Lifecycle automation, idle cost, isolation and recovery |

Check current limits for the exact mode. For example, standard Lambda and Lambda Managed Instances can have different execution limits. Do not transplant a limit from one mode to another. Fargate is not a GPU path; a GPU-dependent container needs a different backend or platform.

## Test Graviton separately

Confirm an ARM64 image, framework wheels, native dependencies and model kernels. An x86 benchmark cannot establish ARM throughput. Compare cost for the same completed work, including any precision or runtime changes, and rerun quality checks where behavior changes.

## Return and revisit

Return the measured envelope, candidate services, explicit limit failures and missing tests. Compare the full process footprint from the actual run record with current service limits retrieved through AWS documentation. Do not size a smaller allocation using weight bytes alone.

EDᗡIE does not deploy these serverless CPU implementations. Keep the proposal as a handoff with a bounded benchmark and cleanup plan.

## Sources

- [Fargate task resources and architecture](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
- [Lambda execution and packaging limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [SageMaker serverless constraints](https://docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints.html)
- [Graviton porting and performance guidance](https://github.com/aws/aws-graviton-getting-started)
