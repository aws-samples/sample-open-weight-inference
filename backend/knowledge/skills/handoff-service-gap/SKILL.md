---
name: handoff-service-gap
description: Prepare an actionable customer handoff for an unsupported model, missing API feature, capacity issue or unresolved inference optimization. Use to preserve exact workload evidence and next steps without inventing service commitments.
---
# Prepare an actionable service-gap handoff

**Decision:** What information will let the next engineer or service team resolve the gap?

Classify the issue as model availability, artifact/runtime compatibility, API feature, Region/data constraint, quota, capacity or performance. An EDᗡIE implementation gap belongs in the application backlog rather than being reported as an AWS service failure.

## Build the evidence packet

Include:

- Business task, required date and impact in the customer's own terms.
- Exact model/checkpoint, runtime and hardware identity.
- Region, serving mode and data-boundary requirements.
- Quality/SLO targets, workload distribution and expected scale.
- Observed error or measured result with timestamps and reproducible conditions.
- Alternatives tested, reasons they failed and the current workable path.
- The specific requested capability or investigation, owner and next review date.

Share resource identifiers, sanitized logs or datasets only through the customer's approved support channel. Public workshop examples should use synthetic data and placeholders.

## Match the next step

For access or quota, identify the missing permission or resource-specific applied limit. For compatibility, supply artifact/image details and a minimal failure case. For performance, provide a representative benchmark and the limiting stage.

For supported SageMaker workloads, Inference Recommender is one self-service benchmarking option. More complex work can be discussed with the customer's AWS account/support team. Do not advertise internal program thresholds, unpublished offers or guaranteed optimization results.

## Return and revisit

Return a concise handoff that another engineer can act on, plus a tested fallback when available. A requested feature or capacity date is not a service commitment.

EDᗡIE can help draft the record. It does not automatically submit support cases, transmit customer data, contact service teams or track an external team's acceptance.

## Sources

- [AWS Support case information and scope](https://docs.aws.amazon.com/awssupport/latest/user/case-management.html)
- [Inference Recommender](https://docs.aws.amazon.com/sagemaker/latest/dg/inference-recommender.html)
- [Applied quota retrieval](https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_GetServiceQuota.html)
