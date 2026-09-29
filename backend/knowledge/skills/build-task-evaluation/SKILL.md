---
name: build-task-evaluation
description: Design a representative evaluation set, rubric and acceptance rule before treating model outputs as evidence. Use for small demonstrations, missing quality goals or inappropriate exact-match scoring.
---
# Build a task evaluation

**Decision:** What evidence would show that a model can perform this task acceptably?

Write the acceptance rule before inspecting candidate results. Otherwise, it is easy to choose the metric that favors an attractive model after the fact.

## Build the evidence set

Define the unit: a document, question, classification, code task or audio passage. Sample the real variation in length, language, ambiguity and input quality. Include rare but costly errors deliberately and report them as separate slices rather than allowing frequent easy cases to hide them.

Keep prompts, expected outputs or grading notes, reviewer instructions and dataset version together. Separate development examples from held-out evaluation. Remove unauthorized sensitive data before sending examples to an endpoint or evaluator.

Choose scoring that matches the output:

- Exact match suits a constrained label when acceptable formatting is defined.
- Field extraction needs field-level correctness and missing/extra-field checks.
- Free-form answers need a rubric for correctness, relevance and unsupported claims.
- Model judges need calibrated examples and periodic human review.
- Critical failures need their own acceptance rule, even when an average score is high.

## Run and interpret

Record model/revision, prompt/template, sampling parameters, evaluator and sample count. Retain failures and timeouts. Report uncertainty; a small exercise can establish a reproducible smoke test without establishing production reliability.

When using human reviewers, sample overlap to find disagreement and refine the rubric. When using a judge model, test positional and stylistic sensitivity. A fluent evaluator explanation is not itself ground truth.

## Return and revisit

Return an evaluation specification, a versioned dataset and the candidate scorecard. Identify the next sample or failure class needed to reduce uncertainty.

EDᗡIE's Tests page can score supplied expected/actual answers. Uploading answers does not run inference or validate their origin. A Bedrock evaluation job or external harness is a separate execution with its own costs and access requirements.

Re-run affected slices after model, template, quantization, retrieval or output-format changes.

## Sources

- [Stanford HELM methodology](https://crfm.stanford.edu/2022/11/17/helm.html)
- [Bedrock automatic, human and judge-model evaluation](https://docs.aws.amazon.com/bedrock/latest/userguide/evaluation.html)
- [EleutherAI evaluation harness](https://github.com/EleutherAI/lm-evaluation-harness)
