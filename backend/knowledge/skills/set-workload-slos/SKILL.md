---
name: set-workload-slos
description: Translate responsiveness and completion requirements into measurable inference SLOs. Use when latency is missing, vague, or confused with token throughput or batch completion.
---
# Define what "fast enough" means

**Decision:** Which user-visible event must occur within the target, and for what share of requests?

Use the workload's experience. Do not give every chat application a universal millisecond target or treat missing latency as permission to exclude CPU.

## Choose the metric

| Experience | Measure |
| --- | --- |
| Text begins appearing | Time to first token, including the agreed client/network boundary |
| Text continues smoothly | Inter-token latency or time per output token; distinguish gaps from averages |
| Complete response | End-to-end response latency |
| Speech begins | Time to first audible output |
| Live conversation | User turn-end to useful response, including detection and audio stages |
| Queued work | Submission-to-completion deadline, including provisioning, staging and retries |

Ask whether cold starts count and which percentile or proportion must meet the target. A p99 completion requirement is not satisfied by a mean first-token result. Record timeout and failure rates alongside latency; removing failed requests from a report can make an overloaded system look fast.

## Work when no target exists

Ask what a user can tolerate, then propose a measurement exercise rather than an invented requirement. For a weekly podcast, establish when the audio must be ready and how many episodes can overlap. For an interactive assistant, distinguish starting a response from completing a long answer.

If the customer intentionally leaves speed unconstrained, label the comparison accordingly. Runtime compatibility, memory, cost and other constraints still apply.

## Return and revisit

Return metric, threshold, percentile, measurement boundary, cold-start treatment, load shape and error allowance. Use supported form fields where they exist; keep unsupported objectives in the written brief without claiming the solver checks them.

A passing result needs observations at the relevant workload and concurrency. Use a low-load run only as a baseline. Revisit after prompt lengths, output lengths, Region, serving runtime, cache behavior or user concurrency changes.

## Sources

- [Google SRE: implementing service-level objectives](https://sre.google/workbook/implementing-slos/)
- [vLLM metrics definitions](https://docs.vllm.ai/en/latest/design/metrics/)
- [MLPerf inference scenarios and metrics](https://mlcommons.org/benchmarks/inference-datacenter/)
