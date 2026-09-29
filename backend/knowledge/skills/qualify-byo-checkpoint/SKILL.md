---
name: qualify-byo-checkpoint
description: Distinguish full fine-tuned weights, merged checkpoints and adapters before comparing Bedrock import or SageMaker BYO serving. Use when the customer brings an existing customized model.
---
# Qualify an existing fine-tuned checkpoint

**Decision:** What files and serving dependencies must be brought to the chosen platform?

Fine-tuning is already complete. Ask about the resulting artifact and intended inference, not epochs, training duration or the training bill.

## Establish artifact completeness

Identify whether the customer has full weights, merged base-plus-adapter weights, or only an adapter. Record the base revision, tokenizer, configuration, architecture, weight dtype, serialization format and any custom operators. Confirm the scope of access and applicable model/adapter terms separately.

An adapter is not a complete standalone model. Its small download does not imply a small resident-memory footprint. A merged checkpoint is a new artifact: pin its checksum and test it, rather than assuming merging preserved the exact earlier behavior.

## Compare routes for the exact checkpoint

1. Check Custom Model Import's current architecture, artifact, context, modality and Region requirements. Family-name similarity is insufficient.
2. Check whether a SageMaker-supported container can load the exact checkpoint. A compatible open-source runtime is useful evidence, but its version, drivers and deployment contract still matter.
3. If custom code is required, record a container review and reproducible test as the next action. Do not make the live application execute downloaded Python.
4. Consider a catalogue base model only if the customer permits substitution and a separate task evaluation supports it.

## Keep implementation limits explicit

EDᗡIE's current private-checkpoint deployment recipe is bounded to supported full or merged BF16 Qwen2.5-derived checkpoints. Inspect the recipe contract before promising an executable trial. Adapter-only, arbitrary architectures and arbitrary custom containers require another implementation; that does not mean SageMaker cannot host them.

Bedrock import comparison is also distinct from executing an import. A planning estimate cannot establish the assigned Custom Model Units or import success.

## Return and revisit

Return an artifact checklist, viable routes to investigate, failed compatibility checks and the next reproducible load test. Reopen the decision for any artifact or serving-version change. Never replace the customer's checkpoint with its base model merely to obtain a green result.

## Sources

- [PEFT checkpoint format](https://huggingface.co/docs/peft/main/en/developer_guides/checkpoint)
- [Amazon Bedrock Custom Model Import requirements](https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html)
- [SageMaker custom inference container contract](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms-inference-code.html)
