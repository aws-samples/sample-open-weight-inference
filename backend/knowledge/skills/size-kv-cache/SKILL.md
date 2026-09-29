---
name: size-kv-cache
description: Size attention-cache memory from exact model geometry, context, active sequences and cache precision. Use for GQA, MQA, MLA, long-context memory, FP8 KV assumptions and tensor-parallel cache replication.
---
# Account for attention-cache memory

**Decision:** How much cache must the runtime retain for the active workload?

Do not use the model's maximum context as the typical request size without agreement. Record the distribution of retained prompt and generated tokens, simultaneously active sequences, shared prefixes and cache policy.

## Choose the correct geometry

For a conventional key/value attention layout, the logical cache per retained token is:

`2 × sum across layers(KV heads × head width × bytes per cache element)`

With uniform layers this becomes `2 × layers × KV heads × head width × bytes`. The factor of two represents keys and values. Use KV-head count, not query-head count, for grouped-query or multi-query attention.

MLA, sliding-window, hybrid and other architectures need their actual runtime layout. MLA may retain compressed latent state and positional keys instead of a conventional full KV tensor. Do not apply the conventional formula or claim a supported model merely from its name.

## Convert logical demand into physical allocation

Multiply a supported per-token layout by retained tokens across active sequences. Then account for:

- Cache replication or sharding across tensor-parallel ranks.
- Prefix sharing only where the runtime actually reuses compatible entries.
- Allocator blocks, fragmentation, eviction and reserved pool size.
- Cache dtype, scales and the hardware/kernel support for that dtype.

FP8 weights do not establish FP8 KV cache. Cache precision is a separate choice that needs quality and performance validation. Some layouts replicate state across ranks, so dividing all cache bytes by the tensor-parallel degree underestimates memory.

## Return and revisit

Use EDᗡIE's sizing tool for supported geometry and label supplied choices as assumptions. Return logical cache demand, physical placement assumptions, configured pool and missing runtime facts.

Measure cache occupancy, preemption/eviction, memory and latency under long and mixed-length requests. Revisit after changing context distribution, active sequences, cache precision, prefix policy or parallelism. Lower cache memory does not by itself establish a faster or quality-equivalent service.

## Sources

- [PagedAttention and cache allocation](https://arxiv.org/abs/2309.06180)
- [Quantized KV cache](https://docs.vllm.ai/en/latest/features/quantization/quantized_kvcache.html)
- [Parallel serving layouts](https://docs.vllm.ai/en/latest/serving/parallelism_scaling.html)
