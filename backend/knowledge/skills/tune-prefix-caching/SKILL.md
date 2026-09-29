---
name: tune-prefix-caching
description: Assess prefix caching for repeated documents, system prompts and sessions. Use to separate shared-prefix prefill savings from decode speed, validate cache hit assumptions and protect tenant boundaries.
---
# Evaluate prefix-cache reuse

**Decision:** Does repeated prompt work justify caching under the workload's isolation requirements?

Identify exact reusable token prefixes, not merely similar text. Tokenization, templates, model/adapter identity and runtime configuration affect whether cached state is compatible.

## Test the benefit

1. Measure cold and warm requests using the actual prompt sequence and cache lifetime.
2. Record eligible prefix tokens, hit rate, first-token latency, cache occupancy and evictions.
3. Compare with caching disabled on the same workload. Include requests with no reuse.
4. Test the application after a model, tokenizer, template or adapter change.

Prefix caching saves repeated prefill work. It does not eliminate the work of generating new output tokens. A decode-heavy workload or one with little prefix reuse may gain little.

For a hosted API, use that provider's documented cache eligibility, write/read meters and lifetime. Self-hosted cache mechanics do not establish Bedrock cache billing or support.

## Preserve isolation

Define which users or tenants may share cached state. Follow the installed runtime's cache-key and isolation controls; where supported, use server-controlled tenant separation rather than trusting callers to select another tenant's cache identity.

Check multimodal identity handling as well as text prefixes. Cache files or remote cache backends need the project's retention, access and encryption controls.

## Return and revisit

Return measured reuse, latency/cost effect, memory cost and isolation configuration. Keep cache-hit assumptions visible in a price estimate. Do not mark the workload faster merely because a checkbox is enabled.

EDᗡIE can explain a cache experiment and cost assumptions; it does not inspect a remote server's actual hit rate through this runbook.

## Sources

- [vLLM prefix caching and its limits](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html)
- [vLLM cache and multi-tenant security](https://docs.vllm.ai/en/latest/usage/security/)
- [Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [SGLang research on structured programs and reuse](https://arxiv.org/abs/2312.07104)
