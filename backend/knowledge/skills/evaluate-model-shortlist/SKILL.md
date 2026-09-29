---
name: evaluate-model-shortlist
description: Build a workload-specific shortlist and compare quality before substituting models or choosing hosting. Use when the customer has not committed to an exact model or asks which model is best.
---
# Evaluate a model shortlist

**Decision:** Which models meet the task's acceptance criteria and deserve serving experiments?

Published leaderboards identify candidates. They do not establish Acme's quality result, supported languages, tool behavior or tolerance for failure. Stanford HELM demonstrates why scenarios, adaptation and multiple metrics matter; its historical rankings are not current recommendations.

## Construct a controlled comparison

Start with the current baseline, a plausible smaller candidate and another candidate justified by task requirements. The number is a planning choice, not a limit. If the exact fine-tune is mandatory, evaluate it; alternatives are optional experiments.

Pin each model/version and serving interface. Use a shared representative test set, acceptance rubric and comparable decoding conditions. Record model-specific templates so a formatting mistake is not misdiagnosed as model quality. Separate tuning examples from a held-out assessment.

Include common cases, costly errors, long inputs, relevant languages and cases the application should decline. Have domain reviewers judge free-form outputs where exact string matching is inappropriate.

## Interpret results

| Result | Next action |
| --- | --- |
| Meets task criteria | Benchmark candidate serving configurations against the workload SLO |
| Fails a critical quality slice | Diagnose prompt/template or model fit; do not compensate with a cheaper instance |
| Evidence absent or tiny | Keep quality unresolved and collect more representative examples |
| Alternative wins public benchmark only | Treat it as a candidate, not an approved replacement |

Compare cost per accepted outcome when quality differs, not only token price. Keep statistical uncertainty and human-review disagreement visible; a few successful examples are not a production quality rate.

## Return and revisit

Return a scorecard with model identity, dataset/rubric, sample count, critical failures and next serving test. Preserve the customer's original model until a substitution is agreed.

EDᗡIE currently scores supplied answers and compares one selected model's hosting options. Automated multi-model evaluation is a documented external workflow, not a completed action in this installation.

## Sources

- [Stanford HELM evaluation framework](https://crfm.stanford.edu/2022/11/17/helm.html)
- [Amazon Bedrock model evaluation](https://docs.aws.amazon.com/bedrock/latest/userguide/evaluation.html)
- [EleutherAI evaluation harness](https://github.com/EleutherAI/lm-evaluation-harness)
