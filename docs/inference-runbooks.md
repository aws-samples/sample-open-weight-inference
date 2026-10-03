# Advisor skills

This library contains 53 focused decision guides authored for EDᗡIE. Their topics
follow the decisions a team makes from workload discovery to operating inference.
They synthesize public documentation and research; each guide links to its sources
and explains the evidence needed for its recommendation.

The scope is **inference**, including hosting an existing fine-tuned checkpoint.
Training a new model is outside the library.

## Where the guidance comes from

The [source registry](../backend/knowledge/skills/sources.json) records 83 public
references, their review dates, what each supports and its limitations. Examples:

- **AWS service documentation:** model availability, Custom Model Import,
  SageMaker serving options, Batch, EC2/EKS, Neuron, pricing and capacity.
- **Evaluation research:** [Stanford HELM](https://crfm.stanford.edu/2022/11/17/helm.html)
  for evaluation design and [MLPerf Inference](https://mlcommons.org/benchmarks/inference-datacenter/)
  for interpreting comparable benchmark scenarios.
- **Optimization research and runtime documentation:**
  [MIT AWQ](https://hanlab.mit.edu/projects/awq),
  [vLLM](https://docs.vllm.ai/en/latest/), Hugging Face and NVIDIA documentation.
- **A recorded application experiment:** the [recorded speech example](../backend/catalog/speech_example.json),
  with the exact speech model, runtime, instance, timings and limitations.

A published benchmark describes its own experiment. It does not establish the
performance, access, capacity or cost of a participant's project.

## How the Advisor uses the library

The Advisor searches short descriptions with `find_runbooks`, then reads up to
three relevant guides with `read_runbooks`. The response includes public citations,
review status and a shared [decision contract](../backend/knowledge/skills/references/decision-contract.md).
Guidance and tool results persist in the existing Strands session; follow-ups can
reuse them within its context window.

Skill retrieval is local to the application. Changing AWS service knowledge is
retrieved through [AWS Knowledge MCP](advisor-knowledge.md) during the Advisor turn.
The optional [COA connector](ontology-backend.md) is independent. Manual project
entry continues to work without opening the Advisor.

## Directory conventions

The [library layout](../backend/knowledge/skills/README.md) follows the Agent Skills
format: one folder per skill, a required `SKILL.md`, and optional references or
scripts when needed. The application packages these under `backend/knowledge/skills`.
It does not depend on Codex or Claude Code discovering a hidden repository folder.
Short skills keep their procedure in `SKILL.md`; a second `RUNBOOK.md` would repeat it.

The library helps identify the next check or experiment. Application tools still
provide model inspection, numerical estimates and solver decisions. A guide cannot
write a requirement, clear a gate, purchase capacity or deploy a resource. Some
AWS paths described here require work outside the application's supported trial flow.

## Browse the guides

### Qualify the workload

- [Qualify the inference workload](../backend/knowledge/skills/qualify-inference-workload/SKILL.md)
- [Pin the model being evaluated](../backend/knowledge/skills/pin-model-identity/SKILL.md)
- [Qualify an existing fine-tuned checkpoint](../backend/knowledge/skills/qualify-byo-checkpoint/SKILL.md)
- [Define what "fast enough" means](../backend/knowledge/skills/set-workload-slos/SKILL.md)
- [Turn traffic into explicit demand](../backend/knowledge/skills/model-traffic-shape/SKILL.md)
- [Qualify data and model boundaries](../backend/knowledge/skills/qualify-data-boundaries/SKILL.md)
- [Choose who operates each layer](../backend/knowledge/skills/choose-operating-model/SKILL.md)

### Evaluate model and runtime evidence

- [Evaluate a model shortlist](../backend/knowledge/skills/evaluate-model-shortlist/SKILL.md)
- [Build a task evaluation](../backend/knowledge/skills/build-task-evaluation/SKILL.md)
- [Evaluate retrieval and grounded answers](../backend/knowledge/skills/evaluate-rag-grounding/SKILL.md)
- [Evaluate classification and ranking](../backend/knowledge/skills/evaluate-classifiers-rerankers/SKILL.md)
- [Evaluate speech generation](../backend/knowledge/skills/evaluate-speech-generation/SKILL.md)
- [Evaluate code and tool behavior](../backend/knowledge/skills/evaluate-code-tool-use/SKILL.md)
- [Benchmark useful serving capacity](../backend/knowledge/skills/benchmark-serving-slos/SKILL.md)
- [Check whether benchmark evidence transfers](../backend/knowledge/skills/validate-benchmark-transfer/SKILL.md)
- [Validate a quantized serving configuration](../backend/knowledge/skills/test-quantized-quality/SKILL.md)

### Choose a hosting path

- [Check the Bedrock model API path](../backend/knowledge/skills/route-bedrock-catalog/SKILL.md)
- [Resolve a missing Bedrock model or feature](../backend/knowledge/skills/resolve-bedrock-catalog-gap/SKILL.md)
- [Assess an existing checkpoint for Bedrock import](../backend/knowledge/skills/route-bedrock-custom-import/SKILL.md)
- [Check the SageMaker JumpStart path](../backend/knowledge/skills/route-jumpstart/SKILL.md)
- [Verify a SageMaker serving container](../backend/knowledge/skills/route-sagemaker-container/SKILL.md)
- [Choose a SageMaker serving mode](../backend/knowledge/skills/route-sagemaker-serving-mode/SKILL.md)
- [Assess EC2 or EKS inference](../backend/knowledge/skills/route-self-managed-eks-ec2/SKILL.md)
- [Assess HyperPod for inference](../backend/knowledge/skills/route-hyperpod-inference/SKILL.md)
- [Consider CPU for offline inference](../backend/knowledge/skills/route-cpu-batch/SKILL.md)
- [Choose a CPU execution environment](../backend/knowledge/skills/route-cpu-serverless/SKILL.md)
- [Assess Neuron accelerators for inference](../backend/knowledge/skills/route-neuron/SKILL.md)
- [Qualify a partner inference offering](../backend/knowledge/skills/qualify-partner-inference/SKILL.md)

### Size memory and compute

- [Establish the model memory footprint](../backend/knowledge/skills/size-model-memory/SKILL.md)
- [Account for attention-cache memory](../backend/knowledge/skills/size-kv-cache/SKILL.md)
- [Plan a deployable model replica](../backend/knowledge/skills/size-moe-parallelism/SKILL.md)
- [Size a CPU inference worker](../backend/knowledge/skills/size-cpu-inference/SKILL.md)
- [Size a GPU serving fleet](../backend/knowledge/skills/size-gpu-fleet/SKILL.md)

### Improve serving performance

- [Locate the inference bottleneck](../backend/knowledge/skills/diagnose-prefill-decode/SKILL.md)
- [Tune batching and admission](../backend/knowledge/skills/tune-batching-admission/SKILL.md)
- [Evaluate prefix-cache reuse](../backend/knowledge/skills/tune-prefix-caching/SKILL.md)
- [Evaluate speculative decoding](../backend/knowledge/skills/tune-speculative-decoding/SKILL.md)
- [Serve an existing adapter or merged checkpoint](../backend/knowledge/skills/tune-lora-serving/SKILL.md)
- [Assess separate prefill and decode serving](../backend/knowledge/skills/assess-disaggregated-serving/SKILL.md)

### Compare costs

- [Analyze inference Tokenomics](../backend/knowledge/skills/analyze-tokenomics/SKILL.md)
- [Compare equivalent inference costs](../backend/knowledge/skills/compare-like-for-like-cost/SKILL.md)
- [Estimate native model usage cost](../backend/knowledge/skills/estimate-native-token-cost/SKILL.md)
- [Estimate imported-model capacity cost](../backend/knowledge/skills/estimate-import-copy-cost/SKILL.md)
- [Estimate allocated compute cost](../backend/knowledge/skills/estimate-allocated-compute-cost/SKILL.md)
- [Test discounts and break-even claims](../backend/knowledge/skills/evaluate-discounts-break-even/SKILL.md)

### Check capacity

- [Verify quota and capacity independently](../backend/knowledge/skills/verify-quota-and-capacity/SKILL.md)
- [Prepare a capacity fallback](../backend/knowledge/skills/plan-capacity-fallbacks/SKILL.md)

### Deploy, observe and revisit

- [Prepare a reproducible inference deployment](../backend/knowledge/skills/prepare-reproducible-deployment/SKILL.md)
- [Release with a tested rollback](../backend/knowledge/skills/release-with-rollback/SKILL.md)
- [Observe the inference service](../backend/knowledge/skills/observe-inference-service/SKILL.md)
- [Revalidate a recorded decision](../backend/knowledge/skills/revalidate-model-decisions/SKILL.md)
- [Prepare an actionable service-gap handoff](../backend/knowledge/skills/handoff-service-gap/SKILL.md)
- [Verify cleanup and remaining charges](../backend/knowledge/skills/verify-cleanup/SKILL.md)

## Maintain the library

The [catalogue](../backend/knowledge/skills/catalog.json) is the search index.
Its tags and questions should describe when a guide changes a decision. Keep a
guide focused; add a separate guide only when it answers a distinct question.
Names match their directory, descriptions stay within 1,024 characters, and
`SKILL.md` stays under 500 lines. Keep changing service values out of the procedure;
use live documentation and the application's evidence tools. Keep experiment
figures in their versioned records rather than copying them into multiple skills.

After reviewing an edit, update the catalogue description, citations and SHA-256
content digest. Update review dates only after checking the relevant source
content. Source retrieval hashes identify the fetched snapshot; they do not
certify its claims. Review deadlines flag changing service or runtime guidance as
`REVIEW_DUE` while keeping the historical explanation available.

From the development environment, run:

```bash
python scripts/validate_runbooks.py
python -m pytest tests/unit/test_runbooks.py tests/unit/test_native_sessions.py tests/unit/test_runtime_session_boundary.py -q
```

The validator checks source links, dates, catalogue coverage and content digests
offline. The tests cover retrieval scenarios, input bounds, file isolation,
authentication and session restoration. Neither check establishes live model
answer quality or current AWS support; those require their own evidence.
