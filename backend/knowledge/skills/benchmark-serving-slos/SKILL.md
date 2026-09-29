---
name: benchmark-serving-slos
description: Design a reproducible load experiment measuring useful throughput under latency and error limits. Use before capacity commitments or when a token-per-second figure is being treated as a benchmark.
---
# Benchmark useful serving capacity

**Decision:** How much representative traffic can this configuration serve while meeting the required experience?

An analytical roofline estimate is a planning bound. A measured single request is a baseline. Neither establishes sustainable production capacity.

## Specify the experiment

Pin model/revision, tokenizer, container digest, engine/version, hardware, precision, parallelism, context limits and cache settings. Record Region and measurement boundary.

Use representative input/output lengths and arrival patterns. Separate a closed-loop concurrency test from an open-loop request-rate test: a client that waits for each response can reduce offered load as the server slows, hiding queue growth.

Run baseline, expected peak and overload conditions with bounded duration and spend. Include warm and cold cases where required. Record offered requests, completed requests, failures/timeouts, queue depth, first-token/audio latency, output-token gaps, completion latency and resource usage.

## Judge capacity

Report throughput that satisfies the chosen latency and error rules. Do not maximize aggregate tokens per second while ignoring late or failed requests. For batch, judge useful jobs completed by their deadlines.

Keep the measurement interval and sample count. Tail percentiles need enough observations and stable load to be meaningful; a tiny sample cannot establish p99 reliability. Repeat near the proposed operating point to assess variability.

Identify whether the bottleneck is queueing, prefill, decode, memory, tokenization, preprocessing or a downstream dependency before choosing a larger instance.

## Return and revisit

Return the configuration manifest, workload generator settings, raw-result location, measurements and passing operating envelope. Show the next experiment needed for an unresolved gate.

SageMaker Inference Recommender can automate supported benchmarking experiments and incurs underlying resource charges. EDᗡIE currently offers planning and supplied evidence; its deployment-backed load runner is not connected.

Rebenchmark after changing model, precision, runtime, hardware, cache policy, parallelism or traffic distribution.

## Sources

- [MLPerf inference scenarios and metrics](https://mlcommons.org/benchmarks/inference-datacenter/)
- [vLLM serving benchmark](https://docs.vllm.ai/en/latest/cli/bench/serve/)
- [SageMaker Inference Recommender](https://docs.aws.amazon.com/sagemaker/latest/dg/inference-recommender.html)
