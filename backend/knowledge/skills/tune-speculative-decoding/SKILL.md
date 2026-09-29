---
name: tune-speculative-decoding
description: Evaluate speculative decoding with a supported draft or proposal method and target model. Use for slow decode, code generation and claims of free speedups or guaranteed identical outputs.
---
# Evaluate speculative decoding

**Decision:** Does a supported proposal-and-verification method improve this workload?

Speculative decoding proposes tokens and verifies them with the target model. Its benefit depends on acceptance rate, verification cost, runtime implementation, concurrency and the prompt/output distribution.

## Check compatibility and cost

Record target model/version, draft model or proposal method, tokenizer compatibility, precision and supported server configuration. Include additional model/cache memory and any extra devices.

Distinguish a method designed to preserve the target sampling distribution from a heuristic that changes generation. Even for a distribution-preserving method, numerical behavior and reproducibility need validation; identical output strings for every seeded run are not an automatic guarantee.

## Compare controlled runs

1. Use the same quality set and realistic input/output lengths with the feature off and on.
2. Measure accepted/proposed tokens, target work, inter-token and end-to-end latency, throughput and memory.
3. Repeat at the intended concurrency. Benefits at low load may shrink or reverse when the target already batches efficiently.
4. Include failures, unsupported features and fallback behavior.
5. Compare cost per successful task at the required SLO, including the proposal method's resource use.

Do not copy a percentage improvement from another model or vendor demonstration. A high acceptance rate is useful but does not by itself establish an application speedup.

## Return and revisit

Return measured benefit or regression, extra resource cost, supported feature set and rollback settings. Keep the original target-only configuration available.

Revalidate after changing model, draft, runtime, precision or load shape. EDᗡIE can propose this experiment; it does not run speculative decoding benchmarks through its Advisor tools.

## Sources

- [vLLM speculative decoding support and limitations](https://docs.vllm.ai/en/latest/features/speculative_decoding/)
- [Latency metric semantics](https://docs.vllm.ai/en/latest/design/metrics/)
- [Scenario and quality controls for benchmarks](https://mlcommons.org/benchmarks/inference-datacenter/)
