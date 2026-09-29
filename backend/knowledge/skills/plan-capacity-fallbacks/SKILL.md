---
name: plan-capacity-fallbacks
description: Build tested alternatives when preferred GPU capacity is unavailable or a reservation expires. Use for substitute accelerators, alternate Regions, smaller replicas, CPU batch fallbacks and release deadlines without an ETA.
---
# Prepare a capacity fallback

**Decision:** What can meet the business deadline if the preferred allocation is unavailable?

Record the required date, minimum viable throughput/SLO, evidence of the capacity gap and the consequence of delay. An uncertain ETA must remain uncertain.

## Create alternatives without erasing constraints

| Alternative | Revalidate |
| --- | --- |
| Different instance generation or size | Image/driver, precision kernels, memory, parallelism, SLO and price |
| More smaller replicas | Per-replica fit, aggregate goodput, routing, networking and operating cost |
| Another Region or Zone | Data policy, service support, network latency, dependencies and quota |
| Hosted or imported model | Exact model or approved substitute, quality, API and usage limits |
| CPU or deferred batch | Whole-pipeline compatibility, completion deadline and quality |
| Reduced initial rollout | User-approved scope, priority and overload behavior |

A newer GPU is not a drop-in substitute merely because it has more memory. Benchmark the actual runtime and topology.

## Plan the transition and expiry

For a confirmed reservation, record matching attributes, start/end times, launch readiness and the time needed to drain or move work. Capacity Blocks and future-dated reservations can have financial commitments; do not treat cancellation as universally free.

For a SageMaker endpoint using reserved capacity, inspect behavior at reservation expiry. A reservation-only setting can stop serving rather than automatically continue on demand.

For Spot workers, design restart-safe jobs and model the cost of interruption and repeated work. Do not use interruptible capacity as an unqualified guarantee for an interactive SLO.

## Return and revisit

Return a preferred plan, prequalified fallback, unresolved tests, owner, decision deadline and trigger. Preserve model/data constraints unless the user explicitly changes them.

EDᗡIE can document this plan; its Advisor cannot promise allocation dates, purchase reservations or silently change the deployment target.

## Sources

- [EC2 Capacity Blocks and their constraints](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-blocks.html)
- [Capacity Reservation matching and commitments](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-reservations.html)
- [Inference endpoint reservation expiry](https://docs.aws.amazon.com/sagemaker/latest/dg/training-plan-utilization-for-inference-endpoints.html)
- [Spot interruptions](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-interruptions.html)
