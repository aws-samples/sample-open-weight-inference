---
name: route-sagemaker-serving-mode
description: Choose among SageMaker real-time, asynchronous, serverless and Batch Transform inference using response deadlines, payloads, traffic and cold-start tolerance. Use for scale-to-zero and always-on endpoint questions.
---
# Choose a SageMaker serving mode

**Decision:** Which request lifecycle fits the application?

Ask whether a caller waits for an immediate response or can retrieve a completed result later. Then establish payload size, longest processing time, arrival pattern and maximum tolerable startup delay.

| Mode | Consider when | Check before choosing |
| --- | --- | --- |
| Real-time endpoint | Immediate responses or streaming are required | Container/API support, measured SLOs, warm capacity and scaling |
| Asynchronous inference | Requests may queue and results can be delivered later | Supported payload/runtime limits, S3 workflow, backlog and deadline |
| Serverless inference | Intermittent requests fit the service's resource envelope | CPU-only constraints, memory, feature exclusions and cold starts |
| Batch Transform | A finite dataset can be processed as an offline job | Input splitting, container support, job completion and output handling |

A podcast pipeline requiring custom orchestration may fit AWS Batch better than a transform request contract. A large generative model does not become serverless-compatible solely because its request volume is low.

## Treat scale-to-zero precisely

Asynchronous inference can be configured to scale down when idle. Selected real-time deployments with inference components also support zero instances with the required scaling configuration.

For the real-time zero-instance mechanism, requests cannot be served while capacity is reprovisioning and can fail until an instance is ready. Include wake-up behavior and client handling in the SLO. “Supports scale-to-zero” does not mean instantaneous responses or that every SageMaker endpoint does it automatically.

Separate provisioned concurrency, allocated instance time and per-invocation charges according to the selected mode. Idle and startup costs must be included where billed.

## Return and revisit

Return one preferred mode to benchmark, a viable alternative, and explicit reasons for exclusions. If deadlines, payloads or duty cycle change, reopen this choice. EDᗡIE's deployment UI supports a bounded real-time trial; the other modes require a separate implementation.

## Sources

- [SageMaker inference options](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
- [Asynchronous inference](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference.html)
- [Serverless inference constraints](https://docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints.html)
- [Real-time endpoints with zero instances](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling-zero-instances.html)
- [Batch Transform](https://docs.aws.amazon.com/sagemaker/latest/dg/batch-transform.html)
