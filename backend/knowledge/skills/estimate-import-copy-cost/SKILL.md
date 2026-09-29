---
name: estimate-import-copy-cost
description: Estimate Custom Model Import cost from assigned CMUs, CMU version, active copies, billed windows and storage. Use when import is incorrectly priced per token or a guessed CMU count produces a misleading comparison.
---
# Estimate imported-model capacity cost

**Decision:** What does the imported model cost under the expected active-copy schedule?

Obtain the imported artifact's assigned CMUs per copy and CMU version from service metadata. Select the matching Region/version rate. A generic architecture label or weight-size heuristic is not a verified CMU assignment.

## Use a dimensionally consistent ledger

For a rate expressed in dollars per CMU per minute:

`capacity cost = sum over copies(CMUs per copy × billed minutes × rate)`

If accounting in five-minute billing windows, convert the number of billed windows to minutes by multiplying by five. If the rate is hourly, convert duration to hours instead. Never divide a window count by sixty and call it minutes.

Where copies change over time, use the observed or explicitly modeled copy schedule rather than one peak count multiplied by every hour.

Add imported-model storage and any other applicable charges separately. Distinguish model copies from GPU instances; a CMU is a service billing abstraction.

## Establish the schedule

Record the first successful invocation, idle gaps, billing-window behavior, scale-out copies and startup tolerance. “Used for six hours” is ambiguous if those hours are split into many short bursts.

Compare prewarmed and idle configurations only when their behavior and rates are documented. Never assume scale-to-zero eliminates storage or startup effects.

## Return and revisit

Return assigned-versus-assumed CMUs, rate version, active-copy timeline, billing granularity, storage, period and exclusions. If an import has not occurred, mark any capacity assignment as hypothetical.

EDᗡIE can explain supported cost scenarios; it does not turn a supplied CMU estimate into service metadata. Revisit when the checkpoint, assigned version, traffic shape or replica policy changes.

## Sources

- [Imported-model metadata](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetImportedModel.html)
- [CMUs, copies and billing-window definitions](https://docs.aws.amazon.com/bedrock/latest/userguide/import-model-calculate-cost.html)
- [Current Custom Model Import rates and storage charges](https://aws.amazon.com/bedrock/pricing/)
