---
name: compare-like-for-like-cost
description: Normalize inference alternatives to the same workload, quality, deadline, operating schedule and cost period. Use when a CPU job, Bedrock token estimate and monthly GPU endpoint quote appear in one comparison.
---
# Compare equivalent inference costs

**Decision:** Which qualified option costs less for the same service obligation?

First state the comparison contract: workload volume and units, input/output mix, model or quality-equivalent alternatives, quality threshold, SLO, active schedule, horizon, Region and resilience requirement.

## Reconcile each estimate

| Cost component | Check |
| --- | --- |
| API usage | Input/output and other applicable meters, retries, cache behavior, batch eligibility |
| Import capacity | Assigned CMUs, copies, billed active windows and storage |
| Allocated compute | Instance/task count over billed lifetime, including startup and idle time |
| Supporting services | Storage, networking, load balancing, logging, requests and orchestration |
| Commitments | Term, eligible service, upfront amount and unused commitment |
| Operational work | Explicit customer-supplied assumptions, shown separately from AWS charges |

Missing supporting costs remain “not included,” not zero. Show what is modeled and what still needs a rate or measurement.

A short offline CPU job and a warm interactive GPU endpoint provide different availability. Either align their schedule and deadline or present separate scenarios without ranking them as equivalents.

## Compare cost per useful outcome

Use cost per successful task, delivered audio minute or SLO-compliant request when these better describe value than raw tokens. Keep quality failures, retries and rejected requests in the denominator discussion.

For different models, quality equivalence must be established. A cheaper model that fails the task does not qualify merely because its token price is low.

## Return and revisit

Return a comparable cost table with formula, period, unit, rate source/date, assumptions, exclusions and qualification state. EDᗡIE's numerical tools provide the arithmetic; the runbook does not calculate unverified prices in prose.

Recompute after changing volume, model, output length, schedule, Region, pricing term or failure policy. A budget change alters affordability, not the underlying price.

## Sources

- [AWS Price List coverage and limitations](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)
- [Bedrock pricing meters](https://aws.amazon.com/bedrock/pricing/)
- [SageMaker inference operating modes](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
