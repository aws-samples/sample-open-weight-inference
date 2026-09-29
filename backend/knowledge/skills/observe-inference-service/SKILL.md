---
name: observe-inference-service
description: Define inference observability across user latency, quality, errors, queues, cache, resource use and cost. Use to distinguish GPU utilization from service health and avoid logging sensitive prompts by default.
---
# Observe the inference service

**Decision:** What signals show that the chosen configuration still meets its purpose?

Start with the task and SLO, then map each signal to a response. A dashboard containing GPU utilization alone cannot show answer quality, client delays or requests that never completed.

| Signal | Useful question |
| --- | --- |
| Task success and critical failures | Are users receiving acceptable outcomes? |
| First token/audio and completion latency | Is the user experience within its deadline? |
| Token gaps, errors, timeouts and rejections | Is delivery stable under load? |
| Queue depth and wait time | Is demand exceeding sustainable capacity? |
| Memory/cache occupancy and evictions | Is the serving footprint creating pressure? |
| CPU/GPU, network and storage activity | Which resource may explain the observed limit? |
| Usage and cost per successful task | Is value staying within the expected envelope? |

## Check definitions and scope

Use the installed runtime's metric definitions and labels. SageMaker normalized utilization and summed per-device utilization can have different ranges. Request-average token time is not the same as the distribution of individual token gaps.

Measure the application path too. Model-server latency omits some networking, retrieval, tool calls and browser rendering.

## Collect data deliberately

Prefer counters, timing and bounded metadata where sufficient. Prompt, output and reference-audio logging can contain sensitive data; configure purpose, access, retention and redaction under the project's rules.

Check whether the exact Bedrock endpoint/API is covered by invocation logging. Turning on one logging feature does not establish coverage for all serving interfaces.

## Return and revisit

Return a small signal-to-action table, dashboard owner, alert thresholds and evidence links. Keep observed values separate from configured limits and planning estimates.

The Advisor can interpret authorized supplied observations. A runbook lookup does not query CloudWatch or establish live health.

## Sources

- [SageMaker metric definitions](https://docs.aws.amazon.com/sagemaker/latest/dg/monitoring-cloudwatch.html)
- [vLLM metrics](https://docs.vllm.ai/en/latest/design/metrics/)
- [Bedrock invocation logging scope](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html)
- [Service-level objectives](https://sre.google/workbook/implementing-slos/)
