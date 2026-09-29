---
name: evaluate-code-tool-use
description: Assess code generation, structured output and tool selection using task completion and safe execution boundaries. Use when an open-weight model will produce code, JSON or tool arguments.
---
# Evaluate code and tool behavior

**Decision:** Does the model complete the intended task with valid, authorized actions?

Valid JSON proves syntax, not correctness or permission. Likewise, code that parses has not necessarily passed its tests or respected the task's boundaries.

## Design representative tasks

For code, pin the repository state, test environment, language/toolchain and task instructions. Include dependency constraints and negative tests for unintended changes. Run generated code only in a controlled test environment with bounded time, resources and access.

For tool selection, specify the allowed tools, schemas and expected outcomes. Include missing-information cases where the correct response is a question or abstention. Check whether the model invents arguments, calls unnecessary tools or tries to bypass approval.

Use held-out tasks representative of the application. Public coding scores are useful shortlist signals, but differences in agent harness, tool access, retries and time budget can dominate a comparison.

## Measure the whole workflow

Record accepted task completion, schema validity, failed/extra calls, retries, elapsed time and total model usage. Include repeated turns and tool results in context and cost. A cheaper token may still produce a more expensive successful task if it requires many retries.

Structured decoding can constrain output form. Verify the serving engine supports the requested schema features and the application independently validates the result. Prompt injection in retrieved files or tool results remains untrusted data; never let it enlarge the model's authority.

## Return and revisit

Return a task-completion scorecard with harness/version, failure examples and costs for comparable workloads. Keep human review or authorization requirements in the application even when the model's benchmark improves.

EDᗡIE can specify the evaluation and inspect a candidate. It does not run arbitrary generated code or a coding-agent benchmark. Its Advisor cannot approve deployment.

Revisit after model, reasoning/output budget, tool schema, runtime, prompt or agent harness changes.

## Sources

- [vLLM structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs.html)
- [Stanford HELM: adaptation affects evaluation](https://crfm.stanford.edu/2022/11/17/helm.html)
- [vLLM security guidance](https://docs.vllm.ai/en/latest/usage/security/)
