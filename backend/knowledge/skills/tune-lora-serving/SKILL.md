---
name: tune-lora-serving
description: Assess serving existing LoRA adapters versus merged checkpoints. Use for shared-base multi-tenant inference, adapter memory, base revision compatibility and preventing a fine-tuned model from silently becoming the base model.
---
# Serve an existing adapter or merged checkpoint

**Decision:** Should the customer serve a merged artifact or a supported adapter on a shared base?

This is an inference packaging and serving decision. Training new adapters is outside the scope.

## Pin the full identity

Record the adapter revision, exact base revision, target modules/rank, tokenizer/template changes, precision and intended task. An adapter file does not contain the full base model. Loading only the base silently changes the requested model.

For a merged checkpoint, record the new artifact digest and validate quality after merging. Do not assume merge support for every adapter, quantization method or server.

## Compare serving choices

| Choice | Main checks |
| --- | --- |
| Merged checkpoint | Artifact size, storage, per-replica memory, supported architecture and output equivalence |
| Base plus fixed adapter | Runtime support, loading order, base compatibility and additional memory |
| Shared base with multiple adapters | Per-request authorization, routing, adapter limits, eviction, mixed-batch performance and isolation |

Warm adapter switching, loading from storage and a cache miss have different latency costs. Measure the expected adapter distribution rather than assuming every request uses a hot adapter.

Dynamic adapter-loading endpoints and arbitrary remote adapter downloads create additional control surfaces. Prefer pre-reviewed, pinned artifacts and server-controlled authorization; do not enable an unrestricted loader from a runbook instruction.

## Return and revisit

Return the complete model identity, selected packaging approach, supported runtime and evidence needed for quality/SLOs. Reopen the decision after any base, adapter, tokenizer, merge or precision change.

EDᗡIE's bounded trial accepts only its documented checkpoint recipe. Adapter guidance does not imply that its deployment page supports arbitrary LoRA loading.

## Sources

- [PEFT checkpoint contents and base-model relationship](https://huggingface.co/docs/peft/main/en/developer_guides/checkpoint)
- [vLLM LoRA serving and dynamic-loading cautions](https://docs.vllm.ai/en/latest/features/lora.html)
- [Model artifact loading risks](https://huggingface.co/docs/hub/security-pickle)
