---
name: qualify-data-boundaries
description: Establish permitted processing locations, weight custody, logging and access boundaries for inference. Use for residency, private fine-tunes, tenant isolation or hosted-provider concerns.
---
# Qualify data and model boundaries

**Decision:** Where may weights, prompts, outputs and operational records go?

Record organizational requirements without claiming a service name automatically satisfies them. AWS billing, AWS hosting and processing exclusively within the customer's account are different statements.

## Map the actual data flow

Identify the owner and allowed locations of model weights, prompt data, retrieved documents, generated outputs, logs, backups and benchmark artifacts. Ask which of these must remain in a particular account or Region. Distinguish a preference for management simplicity from an explicit custody requirement.

For Bedrock cross-Region inference, inspect the selected profile's destinations and applicable controls. An invocation submitted in one Region is not proof that processing stays there. A single-region requirement must be checked against the exact model's supported route.

For a SageMaker custom container, consider artifact access, runtime egress and logging. Network isolation can restrict container communication, but dependencies and external retrieval must be designed to work within it. It is not a generic switch that makes every architecture compliant.

For a partner API or Marketplace offer, determine where processing occurs and which party operates it. Procurement through AWS does not by itself establish the data boundary.

## Keep the decision evidence separate

Use recorded organizational requirements and verified service configuration as evidence. A source describing an available security control is not proof that the deployment enables it. An Advisor explanation cannot approve use of sensitive data.

Retrieve only project-authorized artifact metadata. Keep raw prompts, secrets and private model identifiers out of a public support packet or benchmark example. Use a redacted synthetic reproducer where possible.

## Return and revisit

Return a compact flow map, permitted boundaries, controls to verify and any route excluded by an explicit requirement. If the solver cannot check a requirement, preserve it as unresolved.

Revisit after adding a provider, retrieval tool, cross-Region profile, telemetry destination or fallback route.

## Sources

- [Bedrock cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [SageMaker network isolation](https://docs.aws.amazon.com/sagemaker/latest/dg/mkt-algo-model-internet-free.html)
- [Bedrock model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html)
