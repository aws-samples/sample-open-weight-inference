---
name: estimate-native-token-cost
description: Build a Bedrock native-model cost estimate from requests, input/output tokens and correctly normalized rates. Use for billion-token scenarios, cache pricing, batch eligibility, service tiers and missing usage estimates.
---
# Estimate native model usage cost

**Decision:** What would the selected API cost for the declared workload and billing mode?

Resolve the model ID, Region or inference profile, service tier and rate date. Do not reuse a sibling model's price.

## Establish usage

Record requests in the comparison period and average input/output tokens per request, or explicitly supplied token totals with their split. Count system prompts, retrieved context, tool messages and repeated turns where the provider bills them.

One billion tokens is not one billion requests. Input/output share changes price when those rates differ. User count does not establish request volume.

For uncached text rates expressed per million tokens, the accounting relationship is:

`input tokens / 1,000,000 × input rate + output tokens / 1,000,000 × output rate`

Use the rate's actual denominator if it is expressed differently. EDᗡIE's tools perform numerical calculations; the formula explains the estimate.

## Add mode-specific meters

Separate eligible cache writes, cache reads and uncached input using the provider's rules. Do not discount all input using an assumed hit rate. Batch pricing applies only to a supported asynchronous job that meets its completion needs.

Check any applicable modality, context, tier or other billing dimensions. Do not silently use a text-token formula for audio, image or video pricing. If rates cannot be resolved, leave the estimate unavailable and identify the missing meter.

Include expected retries or multi-call workflows only when the usage basis is known. A model response's visible text may not represent all billable usage.

## Return and revisit

Return model/mode, usage totals, formula, exact rates and source, cost period, exclusions and sensitivity to input/output length. Label estimates as estimates.

When inputs change, recalculate and mark the previous comparison stale. An API price does not establish quality, quota, latency or model access.

## Sources

- [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- [Prompt-cache billing and eligibility](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [Batch inference](https://docs.aws.amazon.com/bedrock/latest/userguide/batch-inference.html)
- [Inference profiles and usage attribution](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html)
