---
name: size-model-memory
description: Explain model footprint using tensor bytes, mixed precision, quantization metadata, active versus total parameters and runtime overhead. Use when a parameter count, disk size or advertised VRAM number is being treated as a deployable memory requirement.
---
# Establish the model memory footprint

**Decision:** What evidence supports the memory needed by one serving replica?

Read the exact revision's configuration and tensor metadata. Keep decimal GB and binary GiB explicit. A repository's display size can include duplicate formats, optimizer artifacts or non-weight files; it is not automatically resident inference memory.

## Build a memory ledger

| Component | Basis |
| --- | --- |
| Resident weights | Tensor shapes and stored/runtime dtypes, or a clearly labelled approximation |
| Quantization metadata | Scales, zero points, grouping and any higher-precision tensors |
| Attention cache | Architecture-specific layout, cached lengths, concurrency and cache dtype |
| Activations/workspaces | Runtime, prefill/batch shape, kernels and graph allocations |
| Auxiliary components | Encoders, audio components, tokenizers or additional models that load |
| Headroom | Explicit planning assumption, later replaced by observed peak memory |

For an uncompressed tensor, elements × bytes per element is the basic accounting relationship. For mixed precision, account for each tensor group separately. “FP8 model” does not mean every stored or resident tensor uses one byte, and a quantized file may expand in an incompatible runtime.

MoE total resident weights remain relevant even when only a subset of experts executes per token. Active parameters help estimate compute; they cannot replace total weights in the memory ledger.

## Reconcile estimates with observations

Record which fields were inspected, supplied, calculated or assumed. EDᗡIE's sizing tool can expose its supported formulas and assumptions; it must leave an unsupported architecture's cache or compute model unknown.

Compare estimates with peak memory during model loading, long-input prefill and target-concurrency decoding. Include temporary duplicate allocations when the loader creates them. A fixed overhead percentage is a planning margin, not an empirical model property.

## Return and revisit

Return a component ledger with units and provenance, missing geometry and the measurement needed before choosing hardware. A fit estimate cannot establish runtime compatibility, latency, availability or quality.

Recompute after changing revision, precision, serving engine, context, batch size, auxiliary models or parallel layout.

## Sources

- [Model-card metadata and limitations](https://huggingface.co/docs/hub/model-cards)
- [Quantization implementations and hardware support](https://docs.vllm.ai/en/latest/features/quantization/)
- [PagedAttention memory-management research](https://arxiv.org/abs/2309.06180)
- [MIT AWQ: weight quantization and hardware-aware execution](https://hanlab.mit.edu/projects/awq)
