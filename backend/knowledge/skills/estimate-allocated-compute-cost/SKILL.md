---
name: estimate-allocated-compute-cost
description: Estimate CPU or GPU instance costs using allocated lifetime rather than busy inference time. Use for SageMaker endpoints, EC2, AWS Batch, startup, idle retention, shutdown and per-job versus monthly comparisons.
---
# Estimate allocated compute cost

**Decision:** What compute lifetime is billed to deliver the workload?

Identify the service, exact instance/task configuration, Region, platform, pricing term and rate timestamp. EC2 and SageMaker prices for related hardware are not interchangeable.

## Build the lifetime ledger

`compute cost = sum over resources(hourly rate × billed hours)`

Apply the service's billing granularity and minimum duration. Include the portions of provisioning, loading, useful processing, idle retention and shutdown that the service bills. Use observed lifecycle timestamps when available.

For a warm endpoint, allocated time continues between requests. Low GPU utilization does not reduce an instance-hour charge. For a batch worker, job processing duration can be shorter than the worker's charged lifetime.

Account for:

- Concurrent resources and any spare capacity.
- Retries, interrupted work and duplicated execution.
- Model/image storage, scratch volumes and retained assets.
- Network paths, public IPs, NAT/load balancing, logs and orchestration.

If a supporting cost is unknown, list it as excluded and explain how to obtain it. Do not silently label a compute-only estimate as the total bill.

## Reconcile measurements and plans

The podcast CPU observation establishes one measured job and worker lifetime. Extrapolation to a full episode, many jobs or retained workers requires an explicit model or another measurement.

Report cost per completed job only after defining completion and including failure behavior. Compare CPU and GPU over the same job set, deadline and operating schedule.

## Return and revisit

Return rate identity, resource timeline, modeled charges, exclusions and the stop condition. A “Remove requested” event is not a verified end to charges; confirm the resource's terminal state.

Use EDᗡIE's supported pricing/calculation tools. A runbook cannot purchase a commitment, launch a worker or assert that cleanup succeeded.

## Sources

- [AWS Price List product attributes and limitations](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)
- [SageMaker inference modes](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
- [AWS Batch compute environments](https://docs.aws.amazon.com/batch/latest/userguide/compute_environments.html)
- [Spot interruption behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-interruptions.html)
