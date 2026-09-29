---
name: model-traffic-shape
description: Separate requests, tokens, concurrency, batch jobs and allocated hours when estimating inference demand. Use for monthly-volume claims, bursts, schedules and missing usage assumptions.
---
# Turn traffic into explicit demand

**Decision:** What arrives, how quickly, and what work does each arrival create?

A billion tokens per month is not a billion requests. Neither establishes peak concurrency, billed hours or a required GPU count.

## Record quantities with units

Collect a comparison period, request/job count, input/output size distributions and arrival pattern. For text, separate input from generated output tokens and account for retrieval context, system prompts and repeated tool turns. For speech, record text length and produced audio duration; do not substitute text decode tokens for audio output.

Ask about peak windows, concurrent requests and queue tolerance. Daily averages hide concentrated demand. User count is not concurrency; active users may make several requests or wait between them.

## Calculate only from established inputs

Use `calculate_usage` for supplied user/request/day counts and `estimate_inference` for supported planning calculations. Label estimates and preserve their inputs. Do not infer allocated instance hours from the time people actively read answers.

For a steady system, average concurrency relates to arrival rate and average time in system. Treat that relation as a consistency check under stable conditions, not a substitute for a peak-load trace. A rising queue violates the steady-state assumption.

For scheduled batch work, record jobs per window, model-loading frequency, worker packing and cleanup time. If every job creates a new worker, startup can dominate. If a worker stays warm, idle time belongs in the cost.

## Return and revisit

Return a workload envelope: typical, peak and growth scenarios with explicit units and unknowns. The scenarios must not silently overwrite the saved production requirement.

Ask for one trace or representative window when a fleet decision hinges on an unsupported peak assumption. Recompute when request size, agent turn count, cache reuse, schedule or concurrency changes.

**Boundary:** Average token volume may support an API cost estimate. It cannot establish a hardware throughput guarantee or a latency pass.

## Sources

- [MLPerf: workload scenarios and load generators](https://mlcommons.org/benchmarks/inference-datacenter/)
- [vLLM serving benchmark controls](https://docs.vllm.ai/en/latest/cli/bench/serve/)
- [Google SRE: handling overload](https://sre.google/sre-book/handling-overload/)
