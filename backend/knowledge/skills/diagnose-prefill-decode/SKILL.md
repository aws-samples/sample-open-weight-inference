---
name: diagnose-prefill-decode
description: Diagnose slow inference by separating queueing, prompt prefill, first-token latency, decoding and transport. Use when a user asks whether caching, a faster GPU, chunked prefill or a smaller output would address latency.
---
# Locate the inference bottleneck

**Decision:** Which stage prevents the workload from meeting its SLO?

Measure the user-visible request boundary and the server stages. Time to first token includes work before decoding starts; inter-token latency describes delivery during generation. End-to-end latency also depends on output length and transport.

## Match symptoms to a test

| Observation | Investigate next |
| --- | --- |
| Queue grows as arrivals increase | Admission limits, sustainable capacity, scaling delay |
| Long prompts delay the first token | Prefill work, tokenization, prefix reuse, chunked prefill |
| First token arrives promptly but output is slow | Decode memory/compute, batching, output length, supported speculative decoding |
| Tail token latency spikes during long prompts | Prefill/decode interference and scheduling |
| Server timings are healthy but user experience is slow | Proxy buffering, network, client rendering and application work |
| Frequent preemption or out-of-memory failures | Cache occupancy, sequence limits, runtime allocations |

These are hypotheses. Confirm them with traces, representative load and a controlled change.

## Interpret metrics consistently

Check the installed server version's metric definitions. Request-average time per output token is not the same distribution as individual inter-token gaps, especially with one-token outputs or speculative decoding.

Do not assume a fixed prefill-to-decode speed ratio. Dense, MoE, multimodal and different input lengths can behave differently. A roofline ceiling is a model with assumptions, not proof that the application receives that throughput.

## Return and revisit

Return the observed limiting stage, evidence boundary, one proposed experiment and its success/rollback criteria. Change one main variable at a time; record any coupled settings.

The Advisor can suggest experiments and interpret supplied results. It must not claim it profiled an endpoint, enabled kernels or measured latency through a runbook lookup.

## Sources

- [vLLM latency and queue metrics](https://docs.vllm.ai/en/latest/design/metrics/)
- [Chunked prefill and runtime tuning](https://docs.vllm.ai/en/latest/configuration/optimization.html)
- [FlashAttention: memory-aware attention computation](https://arxiv.org/abs/2205.14135)
