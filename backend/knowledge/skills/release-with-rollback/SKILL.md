---
name: release-with-rollback
description: Plan canary or staged inference releases with quality, latency, error and cost rollback criteria. Use when a model or runtime update is ready for traffic and the team needs a safe production handoff.
---
# Release with a tested rollback

**Decision:** Can the new inference configuration receive traffic without losing a known recovery path?

Record the current and proposed model/runtime/configuration manifests. Define failure thresholds before observing the new deployment, and preserve a recoverable baseline.

## Choose a release strategy

For supported SageMaker real-time or asynchronous endpoints, review deployment guardrails and feature exclusions. Canary, linear, blue/green and rolling updates have different traffic and temporary-capacity implications.

For another serving platform, identify its actual rollout and rollback mechanism. EDᗡIE's trial workflow is not a production rollout controller.

## Define observable gates

- Critical quality failures and task-level success on approved test data.
- Error, rejection and timeout rates, plus user-visible latency tails.
- Throughput, queue growth and resource saturation under real traffic.
- Cost or resource growth outside the agreed envelope.

Use a bake period with sufficient representative traffic. An HTTP health check can pass while responses are incorrect or slow.

Include old/new fleet overlap in quota, capacity and cost planning. A rollback depending on unavailable old capacity is not a proven recovery path.

## Test recovery

Verify that the previous model, tokenizer, image and configuration remain available. Consider stateful sessions, adapter identity, cache invalidation and API changes. Traffic rollback alone may not reverse a changed external side effect.

If shadowing or replaying requests, obtain the normal data authorization, count the extra cost and prevent duplicate tool actions or writes.

## Return and revisit

Return rollout steps, monitoring signals, thresholds, rollback owner and measured recovery outcome. Report whether rollback was actually tested.

A runbook or successful sample trial does not authorize production changes. Use the customer's deployment process and the application's existing approval boundaries.

## Sources

- [SageMaker deployment guardrails and exclusions](https://docs.aws.amazon.com/sagemaker/latest/dg/deployment-guardrails.html)
- [SageMaker endpoint monitoring](https://docs.aws.amazon.com/sagemaker/latest/dg/monitoring-cloudwatch.html)
- [Defining service-level objectives](https://sre.google/workbook/implementing-slos/)
