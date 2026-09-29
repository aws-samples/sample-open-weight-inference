---
name: tune-batching-admission
description: Tune inference batching, concurrency and admission control without sacrificing response deadlines. Use for queue growth, mixed prompt lengths, throughput optimization, overload, CPU batching and request fairness.
---
# Tune batching and admission

**Decision:** What batching and queue policy maximizes completed work within the SLO?

Distinguish client concurrency, server-active sequences, token budget per scheduling step and fleet replicas. Increasing all four together hides the source of gains or regressions.

## Establish a baseline

Record arrival process, input/output lengths, model/runtime, precision, replica layout, batch settings, memory, latency distributions and errors. Include queue wait in the user SLO.

For stateless classification or embedding requests, dynamic batching can combine independent items. For autoregressive generation, continuous/inflight batching changes which sequences run at each step. Stateful sequences require the server's appropriate ordering and scheduling contract.

## Run a bounded sweep

1. Vary maximum active sequences or batch size while keeping workload and fleet fixed.
2. Vary allowed batch delay or token budget. Waiting to fill a batch can improve throughput while worsening first-response latency.
3. Test long and short requests together; check starvation and tail latency.
4. Set bounded queueing and explicit overload behavior. Rejecting or deferring excess work can be more reliable than accepting requests that inevitably time out.
5. Test cancellation and retry behavior so abandoned requests do not keep consuming capacity unnecessarily.

A high GPU utilization percentage is not the objective. Count successful requests or tokens delivered within their deadline and report rejected/failed work alongside them.

## Return and revisit

Return the tested throughput/latency curve, selected setting, queue limit and overload policy. Keep the original configuration available for rollback.

If the load mix or model changes, repeat the sweep. Do not transfer an embedding batch size to long-form generation or assume a CPU batch benchmark describes GPU serving.

## Sources

- [Triton dynamic batching, sequence batching and queue policies](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html)
- [vLLM scheduling and token-budget tuning](https://docs.vllm.ai/en/latest/configuration/optimization.html)
- [Handling overload](https://sre.google/sre-book/handling-overload/)
