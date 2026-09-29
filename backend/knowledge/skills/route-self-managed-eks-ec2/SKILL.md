---
name: route-self-managed-eks-ec2
description: Assess EC2 or EKS inference when the customer needs control of scheduling, runtime, topology or an existing platform. Separate CPU and GPU choices, operating responsibilities, tenancy and failure recovery.
---
# Assess EC2 or EKS inference

**Decision:** Does control of the serving platform solve a requirement worth the operating work?

Consider this path for an existing Kubernetes platform, specialized scheduling, unusual serving dependencies, topology control or a measured cost/performance benefit. Neither “open weights” nor “large customer” implies EKS.

## Make control requirements concrete

Ask what the managed alternative cannot provide: a specific kernel, runtime, hardware layout, placement policy, multi-model scheduler or integration. Record who will operate upgrades, scaling, failures and security controls.

Choose the execution shape independently:

- **EC2 service:** direct control with a smaller orchestration surface; the customer still needs lifecycle, health, scaling and recovery mechanisms.
- **EKS service:** Kubernetes scheduling and platform integration; node provisioning, device support, networking and workload operations need an owner.
- **CPU batch or queued workers:** suitable candidates for compatible offline work; do not hide these behind a GPU-only label.

## Check a deployable replica

Pin artifact and image, then verify CPU/accelerator compatibility, memory, tensor or pipeline parallelism, in-box links and any inter-node network. EFA or a fast network requires a supported application stack and configuration; bandwidth in an instance table is not achieved collective performance.

Measure request handling and serving performance at the intended placement. Include storage throughput for startup, image distribution, model loading and recovery after a node loss.

For multi-tenant serving, define authentication, admission limits, model/adapter authorization and cache isolation. An inference server should not become publicly reachable merely because its example binds to all interfaces.

## Return and revisit

Return the unmet control requirement, candidate topology, operations owner and experiment needed to establish the benefit. Compare the fully loaded cost, including supporting services and agreed operational assumptions.

EDᗡIE can help plan and explain this path; its comparison or sizing sheet does not provision or certify an EC2/EKS inference fleet.

## Sources

- [EKS AI/ML best-practice areas](https://docs.aws.amazon.com/eks/latest/best-practices/aiml.html)
- [vLLM distributed serving and topology](https://docs.vllm.ai/en/latest/serving/parallelism_scaling.html)
- [vLLM security considerations](https://docs.vllm.ai/en/latest/usage/security/)
