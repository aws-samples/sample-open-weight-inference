---
name: qualify-partner-inference
description: Distinguish a partner SaaS API, Marketplace subscription, customer-account endpoint and Bedrock Marketplace model. Use when an offering says it runs on AWS and the customer needs to know where inference, data and billing actually occur.
---
# Qualify a partner inference offering

**Decision:** Does the specific offering satisfy the customer's model, data, control and procurement requirements?

An AWS Marketplace listing establishes a procurement route. It does not, by itself, establish which account serves requests, the processing Region, network isolation or data-retention terms.

## Identify the delivery model

| Delivery | Verify |
| --- | --- |
| Partner-hosted SaaS API | Operator, processing locations, authentication, retention, terms and network path |
| Software/container in the customer's account | Image provenance, execution role, egress, runtime dependencies and support ownership |
| Bedrock Marketplace deployment | Supported model, subscription, SageMaker-managed endpoint and supported Bedrock APIs |
| Native Bedrock catalog model | Exact ID, Region/profile, access prerequisites, API and billing mode |

Obtain documentation for the actual product and contract. Do not generalize from another offering by the same company.

## Check functional and operating fit

Verify exact model/version or the provider's substitution policy, fine-tuned artifact support, modalities, limits, streaming, failure behavior and quality/SLO evidence. Ask whether the application requires access to downloadable weights or only an inference interface.

Separate license/subscription charges from compute, request, storage and network charges. A prepaid entitlement is not proof that every deployment cost is included. Record renewal and removal responsibilities.

## Return and revisit

Return the delivery model, data boundary, model identity guarantee, price meters and unresolved contractual or technical checks. Route unresolved terms to the customer's normal review process without claiming that a Marketplace listing is an approval.

If the requirement is customer-account inference, keep compatible import, SageMaker and compute paths available. A hosted partner option may be useful, but the user must knowingly choose any change in control or data boundary.

## Sources

- [Bedrock Marketplace endpoints and API access](https://docs.aws.amazon.com/bedrock/latest/userguide/amazon-bedrock-marketplace.html)
- [Marketplace SaaS contract mechanics](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-contracts.html)
- [Bedrock model access and terms](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
