---
name: route-cpu-batch
description: Consider CPU EC2 or AWS Batch for offline open-weight inference before assuming a GPU. Use for Qwen3-TTS podcasts, embeddings, classification, reranking and low-concurrency work with completion deadlines.
---
# Consider CPU for offline inference

**Decision:** Can a CPU worker complete the required work with acceptable quality, deadline and cost?

CPU deserves an early experiment for asynchronous, low-concurrency work. Model size alone is not a sound exclusion rule: runtime kernels, memory bandwidth, precision, context and modality affect feasibility.

## Ask only what is missing

- Is live streaming required, or can the user collect a result later?
- What is the completion deadline, including queueing and startup?
- How many jobs overlap, how long is each input/output, and how often do jobs arrive?
- Does the exact runtime support the whole pipeline on the target CPU architecture?

A missing latency target leaves performance unresolved. It does not imply interactive service or authorize excluding CPU.

## Test the whole worker

Start with one representative job on a compatible CPU image. Measure model and auxiliary-component loading, peak resident memory, processing time, output validity, queue/provisioning delay and worker lifetime. Repeat with full-length inputs and expected concurrency.

Check thread count, physical cores, NUMA placement and memory headroom. Extra processes can replicate model weights and exhaust RAM before CPU utilization becomes the limit.

AWS Batch provides queueing and compute-environment selection; EC2 workers offer direct control. Specify instance families, resource requirements, retry policy and whether workers may scale to zero. A scheduler accepting a job does not prove it can place or finish it.

Read the [recorded CPU experiment](../../../catalog/podcast_example.json) through `estimate_inference` for a concrete illustration. Its observations belong to that exact configuration. They can inform an offline test, but do not establish that another model, processor or production load meets its deadline.

## Decide and compare

Keep CPU if measured completion, memory and quality pass. Consider GPU if supported CPU execution misses the deadline or costs more for the same completed work. For unmeasured configurations, report a benchmark requirement.

Compare both workers over the same workload and schedule, including startup, idle retention, retries, storage and network. A short CPU job cost cannot be ranked against a month of warm GPU service.

## Sources

- [AWS Batch compute environments](https://docs.aws.amazon.com/batch/latest/userguide/compute_environments.html)
- [Batch retry behavior](https://docs.aws.amazon.com/batch/latest/userguide/job_retries.html)
- [CPU runtime and tuning considerations](https://docs.vllm.ai/en/latest/getting_started/installation/cpu.html)
- [Qwen3-TTS exact model and interfaces](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base)
