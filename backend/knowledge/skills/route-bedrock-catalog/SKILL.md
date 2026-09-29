---
name: route-bedrock-catalog
description: Check whether an exact Bedrock catalog model can serve the task in the allowed Region and inference mode. Use for native API selection, model access, streaming, inference profiles and catalog-versus-readiness questions.
---
# Check the Bedrock model API path

**Decision:** Can a catalog model satisfy the task without operating its serving infrastructure?

Start from the evaluated model or shortlist, not a preference for an AWS service. A hosted base model is not a replacement for a required customer fine-tune unless the user agrees to evaluate that substitution.

## Check in order

1. Resolve the exact model ID, version and lifecycle status against the current catalog. A model family's name does not establish availability of every variant.
2. Match input/output modalities, context needs, structured output or tool use, streaming and the supported invocation API. An OpenAI-compatible interface, Converse and InvokeModel are different contracts.
3. Check the required Region and inference mode. If an inference profile is necessary, examine its destination Regions against the project's data boundaries.
4. Verify account permissions and any provider-specific prerequisites or terms. A catalog listing establishes discovery, not successful authorized use. First invocation may trigger subscription behavior; it is not a harmless permission check for every provider.
5. Evaluate quality and serving SLOs on the agreed workload. Token limits, throttling and concurrent usage by other applications can affect performance.

## Explain the economics

For text pricing, preserve separate input and output token counts and the exact rate units. Include supported caching, batch or service-tier choices only when their semantics fit the task and their rates are known. Other modalities can have different meters.

A missing usage estimate means “cost not yet estimated.” It does not mean zero cost or an unsuitable model. EDᗡIE's native comparison can use recorded usage and prices; a recommendation still needs the required evidence.

## Return and revisit

Return the model ID, invocation mode, allowed destinations, access state, quality/performance evidence and outstanding checks. If the catalog path fails, state the exact failed check and continue with the catalog-gap runbook. Revisit when a model version, Region, API feature, policy or workload changes.

## Sources

- [Bedrock models and their individual capability cards](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html)
- [Model access and first-use prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
- [Cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
