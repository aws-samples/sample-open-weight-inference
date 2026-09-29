---
name: pin-model-identity
description: Establish exact model, revision, tokenizer, precision and artifact identity before making compatibility or sizing claims. Use for ambiguous names, model aliases and public repository links.
---
# Pin the model being evaluated

**Decision:** Are all observations about the same artifact?

A display name is insufficient. A catalogue API, downloadable base model, distilled derivative, adapter and merged fine-tune can share a family name while requiring different hosting paths.

## Inspect rather than infer

For public weights, use model inspection to record repository, immutable revision, architecture, tokenizer/configuration, tensor format, precision and detected file size. Preserve missing fields. Model-card claims are published statements; metadata read from the pinned artifact is an inspection result. Neither proves task quality.

For a native API, record the provider's model ID, version, serving Region and inference profile where applicable. Do not invent weight size for a provider-managed API.

For a private checkpoint, use the project-authorized checkpoint controls. Keep its manifest, base-model reference, revision and object versions together. A public base-model lookup must not overwrite a private fine-tune's identity.

## Resolve ambiguity explicitly

| Observation | Treatment |
| --- | --- |
| Marketing name differs from inspected repository | Explain the mismatch and obtain the intended identity |
| Adapter-only artifact | Identify the exact base revision and adapter runtime; do not size the adapter alone |
| Multiple tensor dtypes | Preserve the split; do not multiply every parameter by one guessed byte width |
| MoE active parameter count | Keep it separate from total stored parameters |
| Catalogue alias or version changes | Recheck access, interface and quality for the new version |

For example, evidence read from a Kimi-K2 repository does not establish a Kimi-K3 footprint. Likewise, Qwen text-generation architecture support says nothing by itself about a Qwen speech pipeline.

## Return and revisit

Return the exact identity, facts detected, source/revision of each fact and remaining ambiguity. Explain which downstream decisions are blocked. Avoid repeating questions the inspector already answered.

Reinspect after an artifact, tokenizer, revision, quantization or adapter change. Preserve the old evidence record rather than silently relabelling it as evidence for the new model. Refuse to execute repository code just to resolve metadata.

## Sources

- [Hugging Face model cards](https://huggingface.co/docs/hub/model-cards)
- [PEFT checkpoint format and base-model dependency](https://huggingface.co/docs/peft/main/en/developer_guides/checkpoint)
- [Amazon Bedrock model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html)
