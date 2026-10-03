---
name: size-cpu-inference
description: Size a CPU inference worker using measured peak RAM, thread scaling, NUMA, job duration and concurrency. Use for speech models such as Magpie TTS, embeddings, rerankers, Graviton comparisons and requests for a universal CPU model-size threshold.
---
# Size a CPU inference worker

**Decision:** What CPU and memory allocation can complete the required work on time?

There is no universal parameter-count boundary between CPU and GPU. A model may load in RAM but miss the deadline; a smaller model may rely on a GPU-only operator. Verify software support before extrapolating timings.

## Measure an informative baseline

Record exact artifact, CPU architecture, runtime and precision, physical/logical cores, inference threads, process count, peak memory, input/output size and completion time.

Measure the full pipeline. A speech model can load additional acoustic or audio components; a classifier can depend on an encoder larger than its classification head. Weight bytes alone understate the worker footprint.

For a worked illustration, read the [recorded speech example](../../../catalog/speech_example.json) through `estimate_inference`. The record supplies the actual configuration, memory and timing. A short observed job cannot guarantee the deadline for longer audio or concurrent jobs.

## Sweep the dimensions that matter

- Test a small thread-count range. Logical vCPUs and physical cores are not interchangeable performance units.
- Reserve resources for request handling, decoding, I/O and the operating system.
- Check NUMA locality and memory bandwidth. More threads can reduce performance through contention.
- Test additional jobs or processes explicitly; each can retain its own model and cache.
- Rebuild and benchmark for ARM64 before using Graviton rates in a performance comparison.

Include load/staging time in the deadline when workers are cold. For a warm worker, include retention and idle cost. Avoid assuming linear scaling from one short job to a full podcast or many simultaneous jobs.

## Return and revisit

Return measured worker capacity, memory headroom, deadline margin and observations still needed. Use EDᗡIE's CPU inputs with a run reference; without evidence, return a test plan rather than invented job duration or cost.

CPU fails this configuration when a supported, representative run exceeds memory or misses the deadline. State that specific boundary and evaluate a larger CPU or GPU alternative.

## Sources

- [CPU threading, NUMA and cache tuning](https://docs.vllm.ai/en/latest/getting_started/installation/cpu.html)
- [Graviton compatibility and benchmarking](https://github.com/aws/aws-graviton-getting-started)
- [AWS Batch compute placement](https://docs.aws.amazon.com/batch/latest/userguide/compute_environments.html)
