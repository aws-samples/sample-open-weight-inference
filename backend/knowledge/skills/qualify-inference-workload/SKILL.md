---
name: qualify-inference-workload
description: Turn a business request into an inference decision without preselecting a model or AWS service. Use when the workload, output, or acceptance criteria are unclear.
---
# Qualify the inference workload

**Decision:** What must an existing model produce, for whom, and under what conditions?

Use the [decision contract](../references/decision-contract.md). Start from the user's task, not a preferred service or GPU. A fine-tuned checkpoint that already exists belongs here; creating it is a separate training project.

## Establish the minimum brief

Ask for an example input and a useful output. Then establish who consumes it: a person waiting for a reply, an application requiring a schema, or a queue collecting completed jobs. Reuse answers already present in the project.

Record the failure that matters: an incorrect category, unsupported claim, invalid tool argument, unintelligible audio, or a late result. Identify whether a person reviews the answer and what the application must do when it cannot answer reliably. "Better quality" is not yet an acceptance criterion.

Separate constraints from preferences. An exact private checkpoint, data location, completion deadline and maximum spend can be constraints. "We heard this model is popular" is a reason to evaluate a candidate. A familiar platform is an operational preference unless the team explicitly requires it.

## Choose the next decision

| What is known | Next step |
| --- | --- |
| Task clear, model open | Build a small shortlist and a representative evaluation set |
| Exact model required | Pin its artifact; evaluate task fit and hosting compatibility independently |
| Interactive output | Define first useful output, completion latency and concurrent demand |
| Queued output | Define completion deadline, job size and arrival schedule; retain CPU options |
| No useful example | Establish one before requesting hardware estimates |

For Acme Corp's document extraction, record the fields, error tolerance and review process. For Acme's weekly podcast, record audio duration, acceptable completion time and listener criteria. Neither brief should contain a hosting answer.

## Return and revisit

Return a short brief, known constraints and the next two missing inputs. Save only agreed requirements through the existing project controls. Leave unknown scale and speed visible; do not fill them with industry averages.

Reopen qualification when the task changes, a prototype becomes interactive, a new language is added, or unattended execution replaces human review. A previous hosting result may then cease to apply.

## Sources

- [Stanford HELM: scenarios, adaptation and multiple evaluation metrics](https://crfm.stanford.edu/2022/11/17/helm.html)
- [SageMaker inference options](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
