---
name: size-gpu-fleet
description: Convert a validated GPU replica into a serving fleet using peak demand, SLO-constrained throughput, burst handling and redundancy. Use when monthly token volume, theoretical throughput or utilization is being used to commit instance counts.
---
# Size a GPU serving fleet

**Decision:** How many validated replicas are needed at the required service level?

First establish a compatible replica with sufficient memory. Fleet sizing needs measured serving capacity for the workload, not just an advertised device specification or roofline calculation.

## Align demand and capacity units

Record peak arrivals, input/output length distributions, concurrent sequences, active schedule and response SLOs. Monthly requests, monthly tokens and peak requests per second describe different things.

If estimating required replicas from throughput, use compatible units:

`replicas ≥ ceiling(peak workload rate / tested sustainable rate per replica)`

The tested rate must meet the latency and error targets on the same workload shape. Add resilience, maintenance and growth capacity explicitly. Do not apply a utilization discount twice when the tested sustainable rate already includes the intended headroom.

## Stress the assumptions

1. Test the expected mix of long and short requests, not just a single fixed prompt.
2. Measure time to first token, token delivery, end-to-end latency, rejected work and successful completions.
3. Test bursts and overload behavior. Average demand spread over a month can hide a severe peak.
4. Measure scale-out delay: node provisioning, image pull, weight loading and readiness.
5. Test the agreed failure case, such as losing one replica or an availability zone.

For offline work, use the completion deadline and sustainable job throughput. A warm interactive fleet and a queued batch worker are not comparable until their operating schedules and service obligations are aligned.

## Return and revisit

Return the demand envelope, tested per-replica rate, redundancy policy, fleet range and scaling trigger. Distinguish an analytical estimate from a benchmark-backed plan and from capacity actually secured.

EDᗡIE's sizing sheet is a planning tool. It cannot qualify latency or promise GPU availability from a modeled token rate.

## Sources

- [Scenario-specific benchmark methodology](https://mlcommons.org/benchmarks/inference-datacenter/)
- [SageMaker endpoint autoscaling](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling.html)
- [Overload and capacity behavior](https://sre.google/sre-book/handling-overload/)
