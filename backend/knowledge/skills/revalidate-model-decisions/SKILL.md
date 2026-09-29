---
name: revalidate-model-decisions
description: Reopen an inference recommendation when models, checkpoints, runtime versions, workloads, rates or service support change. Use for stale comparisons, lifecycle notices, expired evidence and migration planning.
---
# Revalidate a recorded decision

**Decision:** Which parts of the earlier recommendation still hold?

Use the saved request and evidence manifest as the baseline. Do not overwrite it with a new result before showing what changed.

## Identify the trigger

| Change | Recheck |
| --- | --- |
| Model, checkpoint, adapter or tokenizer | Identity, compatibility, quality and memory |
| Server, driver, precision or kernel | Loading, output behavior, latency and throughput |
| Request mix, context, concurrency or deadline | Capacity, queueing, SLOs and cost |
| Region, data policy or serving API | Access, feature support, data boundaries and latency |
| Rates, commitment or operating schedule | Comparable cost and affordability |
| Model lifecycle or capacity window | Continued access, migration and fallback deadline |

Recheck only what the change can invalidate, then broaden if results reveal another issue.

## Handle lifecycle notices

Use the exact provider/service model card and applicable lifecycle policy. Bedrock lifecycle dates may differ from the upstream provider's dates, and policy can differ by launch cohort. Do not invent one universal retirement window.

A newer catalog model is a candidate for evaluation, not an automatic replacement for a required fine-tune. Preserve critical behaviors and the customer's permission to change model identity.

## Keep evidence fresh

Record source date, test date and the conditions that would invalidate each observation. A runbook's editorial review date is not a live price, quota or capacity check.

If a runbook is marked review due, use it to structure the investigation and verify dynamic claims before making a commitment. Do not silently treat stale documentation as current account evidence.

## Return and revisit

Return the changes, invalidated checks, retained evidence and next verification. Save a new comparison/version once the relevant inputs are agreed.

EDᗡIE should show stale results as stale. An unchanged cost number is not evidence that an earlier recommendation still qualifies.

## Sources

- [Bedrock model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html)
- [Current model cards](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html)
- [AWS Price List scope](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)
