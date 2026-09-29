---
name: evaluate-rag-grounding
description: Separate retrieval failures, unsupported answers and serving latency in a RAG workload. Use for document question answering, citations, long context or knowledge-base model comparisons.
---
# Evaluate retrieval and grounded answers

**Decision:** Is the system retrieving the needed evidence and using it correctly?

A larger generator cannot reliably recover information the retriever never supplies. Diagnose retrieval and generation separately before changing models or hardware.

## Collect a trace for each example

Record the question, approved source snapshot, expected supporting passages, retrieved passages, generated answer and citations. Pin embedding, reranker and generator identities independently. These are different models with different sizing and serving requirements.

Include answerable questions, missing-information questions, conflicting sources, stale documents and relevant access-boundary cases. Label which evidence the requesting user may see; relevance does not override document permissions.

## Locate the failure

| Observation | Investigation |
| --- | --- |
| Correct passage absent | Retrieval coverage, chunking, query formulation or reranking |
| Passage present, answer wrong | Generator, template, context ordering or task fit |
| Answer correct, citation unsupported | Citation fidelity and evidence attribution |
| No source supports an answer | Abstention behavior; do not reward plausible invention |
| Slow first output | Retrieval/reranking time plus prompt prefill and queue time |

Use a fixed retrieval snapshot when comparing generators. Use a fixed question set and relevance judgments when comparing retrievers. Changing both at once prevents attributing the improvement.

Track the resulting context length distribution. It drives prefill, KV memory and API input charges. Prefix caching helps only for compatible repeated prefixes; unique retrieved passages are not automatically cache hits.

## Return and revisit

Return separate retrieval and answer-quality results, examples of unsupported claims, end-to-end latency and the next isolated experiment. State how correctness was assessed and what remained unlabelled.

Bedrock offers knowledge-base evaluation workflows. EDᗡIE can help specify the experiment and record supplied results; it does not execute a complete retrieval benchmark in this installation.

Revisit after changing source corpus, permissions, chunking, embedding model, reranker, context budget or generator.

## Sources

- [Bedrock model and knowledge-base evaluation](https://docs.aws.amazon.com/bedrock/latest/userguide/evaluation.html)
- [vLLM pooling models for embeddings and scoring](https://docs.vllm.ai/en/latest/models/pooling_models.html)
- [vLLM prefix caching and its limits](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html)
