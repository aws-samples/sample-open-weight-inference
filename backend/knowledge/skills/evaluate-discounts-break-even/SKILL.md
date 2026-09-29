---
name: evaluate-discounts-break-even
description: Compare on-demand, Savings Plans, reserved capacity and break-even scenarios with matching terms and service obligations. Use for claimed self-hosting thresholds, commitment discounts and confusion between price savings and GPU availability.
---
# Test discounts and break-even claims

**Decision:** Under which explicit assumptions would the cost preference change?

Begin with qualified, comparable configurations. A break-even calculation cannot repair different quality, response deadlines, availability or operating schedules.

## Normalize pricing terms

Record commitment type, eligible service, term, upfront payment, hourly commitment and expected utilization. Compute Savings Plans apply to eligible EC2, Fargate and Lambda usage; SageMaker AI has a separate Savings Plans offering.

Do not price SageMaker with an EC2 discount or compare a fully utilized annual commitment to a short on-demand experiment without explaining the unused commitment.

Savings Plans provide a billing benefit, not a GPU capacity reservation. Capacity Reservations and Capacity Blocks have separate matching, timing and financial obligations.

## Solve the stated comparison

For a fixed-cost service versus an API with a known marginal cost per equivalent task:

`break-even tasks = fixed cost over the period / API cost per task`

This simplified relationship applies only when fixed cost, task cost and capacity remain valid over that range. Include variable self-hosting costs, replica steps, caching, retry rates and commitments in a more complete comparison.

For active-hour comparisons, normalize all rates to the same time unit. Changing from sustained traffic to short bursts changes billed schedules and may cross pricing windows; it is not merely a utilization percentage.

## Return and revisit

Return a sensitivity table or range over volume, output mix and active duration, with assumptions and uncertainty. Name the measurement or rate change that would reverse the recommendation.

If a source's arithmetic conflicts with its units, reproduce the ledger and identify the inconsistency; do not repeat the published number as fact. EDᗡIE must use supported calculation tools and retain unknowns where the model lacks a required input.

## Sources

- [Savings Plans eligibility and commitment terms](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html)
- [Capacity Reservations versus pricing discounts](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-reservations.html)
- [AWS Price List coverage](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)
