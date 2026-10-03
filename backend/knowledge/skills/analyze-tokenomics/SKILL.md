---
name: analyze-tokenomics
description: Analyze inference cost per successful task across model calls, agent loops, context, tools, caching, retries and allocated compute. Use when token prices alone do not explain the bill or when comparing model and harness changes before buying capacity.
---
# Analyze inference Tokenomics

**Decision:** Which change reduces the cost of an acceptable outcome while preserving quality, response time and data boundaries?

Tokenomics connects workload behavior to inference economics. Start with the complete application task, then identify its billable work. A request, a token and a completed task are different units.

## Define the outcome and baseline

Reuse the project's task, quality threshold, response-time or completion deadline, volume, traffic shape and comparison period. Choose a useful outcome: an accepted classification, a usable audio minute or a verified code change. Record success rate and latency alongside cost.

Cost per successful outcome is all attributable cost for the workload and period divided by accepted outcomes in that same scope. Include failed attempts, retries and fallbacks in the cost. If no outcomes succeeded, unit cost is undefined; it is not zero. Keep compute-only estimates separate from total application cost.

Prefer aggregate usage counters and synthetic evaluation tasks. Do not request raw prompts, recordings or customer documents just to estimate cost. Never add private examples, account identifiers, usage records or negotiated rates to the skill library. Documentation searches should describe the public technical question without private workload content.

## Follow the complete task

| Record | What to include |
| --- | --- |
| Model calls | Exact model/version, endpoint, input, output and other reported billing meters for every call |
| Input context | Instructions, tool definitions, retrieved content, repeated history and tool results actually sent to the model |
| Agent work | Parent and child calls, retries, fallbacks, router calls, compaction and evaluation overhead |
| Cache use | Reads, writes and misses under the exact API's usage-field definitions |
| Serving cost | Allocated CPU/GPU lifetime, startup, idle time, commitments and supporting services |

Use provider usage records where available. Do not infer total cost from the final answer's length. Resolve counter semantics before adding them: cached or reasoning tokens may already be included in a reported total. A tool's output affects model input only when supplied to a model, although running the tool can incur its own charges.

An agent's **harness** is the surrounding code that selects tools, manages context and controls its execution loop. Evaluate the model and harness together; changing either can change the number of calls needed to finish a task.

## Separate billing, quotas and capacity

- **Billing:** apply current rates to the applicable meters. Use application pricing tools for numerical quotes; missing rates remain unknown.
- **Quotas:** inspect the exact model, endpoint and account limits. Admission reservations and token quota accounting are not billing multipliers. Dividing tokens per minute by an output cap does not establish concurrent capacity.
- **Performance:** measure accepted work within the required deadline under representative load. Cached context still occupies the model's context window. Lower token counts do not prove higher useful throughput.

Use `lookup_aws_documentation`, then `read_aws_documentation` when necessary, before explaining changing AWS cache rules, quota accounting or billing behavior. Preserve model, API and Region scope. Do not carry forward cache lifetimes, thresholds, discounts or quota factors from an old example.

## Test one lever at a time

| Hypothesis | Evidence required before recommending it |
| --- | --- |
| Load only relevant tools, skills and retrieval results | Compare call counts, input usage and task success; retain necessary instructions and evidence |
| Reuse an eligible stable prefix | Measure cache writes, subsequent reads, misses and applicable rates at realistic request spacing; verify isolation and invalidation |
| Compact history or delegate a bounded task | Count summarization and child-agent work as well as the parent; verify that essential context survives |
| Route to a different model or simplify the harness | Test the same tasks and acceptance criteria, including routing errors, fallbacks and retries |
| Bound output, reasoning or retry loops | Check truncation, incomplete tasks and recovery costs; a smaller limit is not automatically an optimization |
| Change serving runtime or fleet allocation | Benchmark the same quality and SLO; verify that released capacity or fewer billed hours actually reduce charges |

Cache hits do not make all inference free. Delegation or parallel calls may improve completion time while increasing total cost. A cheaper token rate can lose if the application needs more attempts.

Reducing tokens does not automatically lower an allocated GPU bill or an existing Savings Plan obligation. Distinguish a potential future capacity reduction from cash savings that the operating schedule and commitment actually permit.

## Return the next decision

Give a short baseline, the largest evidenced cost driver, one proposed experiment and its acceptance criteria. Compare cost per successful outcome, success rate and latency before and after. Label measurements, estimates, exclusions and unresolved meters. Do not claim that EDᗡIE has run an application benchmark or inspected billing data unless a tool result establishes it.

Read only the additional guide needed:

- `compare-like-for-like-cost` for equivalent service obligations and complete cost boundaries.
- `estimate-native-token-cost` or `tune-prefix-caching` for model usage and cache experiments.
- `benchmark-serving-slos` or `size-gpu-fleet` for capacity justified by useful throughput.
- `evaluate-discounts-break-even` for commitments. Use `compare_gpu_commitments` for live public EC2 On-Demand and Savings Plan quotes; a quote is not proof of workload fit or reserved capacity.

If a required meter or calculation is unsupported, return that gap and the evidence needed. Never substitute an invented price, customer example or universal savings percentage.

## Sources

- [Context engineering and its tradeoffs](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Agent workflow patterns and evaluation](https://www.anthropic.com/engineering/building-effective-agents)
- [Bedrock prompt-cache scope and billing](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [Bedrock token quota accounting](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-token-burndown.html)
- [Bedrock pricing meters](https://aws.amazon.com/bedrock/pricing/)
