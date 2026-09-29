---
name: route-bedrock-custom-import
description: Assess Bedrock Custom Model Import for an existing fine-tuned or open-weight checkpoint. Check exact architecture, artifact format, precision, context, Region, import limits and invocation support without treating the base model as the custom model.
---
# Assess an existing checkpoint for Bedrock import

**Decision:** Can Bedrock's managed import service serve this exact checkpoint under the project's constraints?

Record the immutable checkpoint location, base-model identity, architecture, tokenizer, precision and whether the artifact is a full model, merged model or adapter. Fine-tuning has already happened; this procedure evaluates inference only.

## Establish compatibility

1. Match the checkpoint's actual architecture to the current import support table. Sharing a name such as Qwen, Llama or Mistral is insufficient. Text, multimodal and speech variants can use different architectures.
2. Check supported weight format, model files, tokenizer/configuration and current serving-library requirements. An adapter alone is not a full checkpoint. Merging outside EDᗡIE creates a new artifact that needs validation.
3. Check the current weight-size and context limits for that architecture. Disk bytes, parameter count and runtime memory are different quantities.
4. Verify that the target Region supports this model type. Special model families can have a narrower Region set than the import service generally.
5. Match the invocation API and required features. Do not infer Converse, embeddings, streaming or batch support from another model's capabilities.
6. Confirm artifact access, encryption permissions, license rights and account quotas using authorized checks.

Fail with a specific incompatibility when evidence establishes one. Otherwise retain an unresolved check; do not turn incomplete metadata into a pass.

## Cost and performance boundary

Imported models use model-copy/Custom Model Unit billing and storage, not the native model's token price. Assigned CMUs and cold-start behavior require service evidence for the imported artifact. A guessed CMU count cannot establish a price or speed advantage.

Compare expected active windows, startup tolerance, concurrent demand and storage with the same workload on SageMaker. Bursty use is a reason to investigate, not a guaranteed import winner.

## Return and revisit

Return the compatibility checklist, invocation choice, cost inputs still needed and an alternative container route if import fails. EDᗡIE can explain and compare supported import scenarios; its bounded SageMaker trial does not execute an import.

## Sources

- [Supported architectures, files, limits and Regions](https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html)
- [Invoking an imported model](https://docs.aws.amazon.com/bedrock/latest/userguide/invoke-imported-model.html)
- [Imported-model metadata and assigned capacity](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetImportedModel.html)
