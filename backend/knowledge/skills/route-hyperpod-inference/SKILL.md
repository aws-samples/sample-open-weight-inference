---
name: route-hyperpod-inference
description: Assess SageMaker HyperPod inference for Kubernetes-based multi-node or shared-fleet serving. Use for managed orchestration, caching, routing, heterogeneous instance choices and the boundary between HyperPod and a managed endpoint.
---
# Assess HyperPod for inference

**Decision:** Would HyperPod's inference capabilities help the customer's Kubernetes serving platform?

HyperPod supports inference; it is not restricted to training. The workload in this runbook uses an existing model. Do not ask for training-job duration or propose model training to size inference.

## Establish the platform need

Record the existing cluster strategy, deployment scale, topology, operating skills and the specific capability sought. Examples include multi-node replicas, coordinated scaling, model/image caching, request routing or shared compute governance.

Distinguish a SageMaker managed endpoint from a HyperPod Kubernetes deployment. They expose different interfaces and operating responsibilities. A customer wanting only an authenticated model API may not need the additional platform choices.

## Verify selected features

1. Check the current supported model sources, serving runtimes, deployment interfaces and instance types.
2. Validate replica layout, resource requests, tenancy and request limits before enabling autoscaling.
3. Test weight/image caching against startup time, and prefix/session-aware routing against actual reuse. Cache hit rate is an observation, not an assumed benefit.
4. Check the exact cache backend's encryption and isolation properties. The public documentation describes limitations for some managed L2 cache options; do not assume all deployments or tenants have isolated, encrypted cache storage.
5. Prequalify any alternative instance types for model loading, parallelism and SLOs. Scheduler preference does not make incompatible hardware a safe fallback.
6. Define failure handling, observability, cost ownership and rollback.

## Return and revisit

Return the platform problem HyperPod would address, selected capabilities, required controls and a representative benchmark plan. Compare with a managed endpoint or existing EKS implementation under the same workload.

EDᗡIE provides this as a planning handoff. It does not create a HyperPod cluster, run these experiments or convert a theoretical fleet into reserved capacity.

## Sources

- [Deploying models on SageMaker HyperPod](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-model-deployment.html)
- [SageMaker inference deployment choices](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
- [Distributed serving considerations](https://docs.vllm.ai/en/latest/serving/parallelism_scaling.html)
