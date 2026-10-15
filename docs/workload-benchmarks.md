# Evaluate with evidence

Use **Tests > Public benchmarks** to find candidates. Use **Tests > Your workload**
to check whether a configuration handles your own tasks. Published performance,
project measurements and hosting estimates answer different questions.

## Public coding comparisons

Choose **Load published results**, then a mini-SWE-agent version. EDDIE reads
the [official SWE-bench leaderboard](https://www.swebench.com/) and extracts
published result metadata for **SWE-bench Verified**.

The chart uses issues resolved by repository tests, rather than a judge's opinion
of generated code. It recomputes both resolution and cost from all 500 task records.
Model names, resolution scores and per-task costs appear directly on the graph.
Select a point for evidence, or enable the optional 95% intervals or full score axis.
Excluded records appear below with their reasons; **All records and calculations**
opens the detailed table.

The callouts are calculated from the selected cohort: lowest recorded cost,
highest observed resolution, and a cheaper configuration within one percentage
point of that score when one exists. The last comparison states its baseline,
price difference and score gap. It does not imply equivalent performance or
statistical significance. Select either configuration and compare paired outcomes.

| Check | What EDDIE does |
| --- | --- |
| Matched scope | Groups by agent version and checks matching task identities |
| Complete outcomes | Requires an explicit pass/fail result for every task |
| Consistent arithmetic | Reconciles task outcomes and costs with published totals |
| Failed work | Includes unresolved tasks in total cost and cost per resolved issue |
| Trade-offs | Marks configurations not dominated on cost and resolution |
| Regressions | Compares paired outcomes: contender only, baseline only, both, neither |
| Provenance | Exports submission dates, source retrieval time and snapshot SHA-256 |

**These costs are historical API-cost records from the source, not current AWS
quotes.** Use [Tokenomics](tokenomics.md) for current public AWS prices and
Savings Plans. Do not apply a published model score to an untested quantization,
different serving configuration or unrelated workload.

The source review flag is shown separately. Complete records are not proof that
EDDIE independently reran the benchmark or ruled out contamination. Harness
versions and task sets are checked; all time budgets, sampling settings and exact
weight digests are not established by the leaderboard.

The 95% intervals are descriptive Wilson intervals under an independent-task
sampling assumption. Tasks can be correlated and the benchmark is not a random
sample of customer work. Use paired outcomes to inspect differences; overlapping
or nonoverlapping intervals alone do not establish a model ranking.

Only metadata is fetched, from a fixed HTTPS source, with size and time bounds.
Results are cached for 15 minutes. If the source is unavailable or its format
changes, EDDIE reports that failure without substituting remembered numbers.
Benchmark datasets, submissions, generated code and model weights are not bundled.

## Run examples from the browser

1. In **Your workload**, write representative tasks and their expected answers.
   Exact matching suits labels and constrained answers. It does not grade open-ended
   writing, speech quality or whether generated code works.
2. Choose **Find ready text trials** and select an existing, approved text trial.
3. Set repetitions, concurrency, output limit and the deadline for starting requests.
   Review the request count, then choose **Run workload test**.
4. Set acceptance, error and response-time targets. Choose **Compare benchmark runs**.
5. Save the project or export its reports. Ask the Advisor to explain the evidence.

A browser run sends at most 40 requests, with at most four in flight. The existing
trial's independent 100-request allowance, expiry and project authorization still
apply. It cannot create or approve an endpoint.

Keep the page open. Stopping or navigating away stops new work; already-sent requests
may finish and incur charges. Recorded failures and unstarted requests remain in
partial reports. If grading fails, successful responses stay ungraded, not passed.

Browser response time includes the application and model call. It is not time to
first token. The first request is included; this runner does not silently discard
cold-start observations.

## Run against an existing service

The companion `benchmark.sh` supports:

| Target | Connection | Measured response time |
| --- | --- | --- |
| Bedrock model | AWS SDK Converse streaming | Complete response and first text token |
| SageMaker endpoint | AWS SDK, OpenAI-chat-compatible serving container | Complete response |
| Self-hosted model | OpenAI-compatible streaming API through your existing loopback tunnel | Complete response and first text token |

It creates no resources and downloads no models or datasets. Use the deployment
prerequisites and dependencies from [Getting started](getting-started.md).

Copy [the synthetic example plan](../examples/benchmark-plan.json), replace its
target placeholders, and validate it:

```bash
cp examples/benchmark-plan.json my-benchmark.json
./benchmark.sh --plan my-benchmark.json
```

Validation makes no AWS calls. To execute, provide the expected account and a new
report filename:

```bash
mkdir -p benchmark-results
./benchmark.sh --plan my-benchmark.json --execute \
  --expect-account YOUR_ACCOUNT_ID --output benchmark-results/run-1.json
```

The runner checks the caller's AWS account and reserves an owner-only output file
before sending requests. Output files are not overwritten. It caps a run at 200
requests, eight concurrent requests and a 30-minute scheduling deadline. Network
timeouts bound in-flight work. Ctrl+C stops scheduling and preserves completed,
failed and unstarted requests in the final report.

For another configuration, keep the workload and protocol unchanged, change the
target, and write a new report. Compare offline or import the individual reports
in **Tests**:

```bash
./benchmark.sh --compare benchmark-results/run-1.json benchmark-results/run-2.json \
  --minimum-acceptance 95 --maximum-p95-ms 3000 \
  --output benchmark-results/comparison.json
```

The target records the actual model, revision, runtime, hardware and Region.
For SageMaker, add `endpointName`. An optional `requestModel` is the API alias
expected by the container; it does not replace the recorded model identity.
For self-hosting, add `baseUrl`, such as `http://127.0.0.1:8000/v1`. Only an
explicit loopback address and non-privileged port are accepted; redirects are refused.
Put a required bearer token in `EDDIE_BENCHMARK_API_KEY`, never in the plan.

The runner collects applicable public prices through EDDIE's AWS pricing
collectors. For an instance-backed target, specify `instanceType` and
`instanceCount` for the entire fleet used in the test. A missing price or unknown
token/cache usage leaves cost unknown. No token counts are inferred from text length.

## Interpret a comparison

**Useful** means accepted by the declared rubric and within the per-request
response-time target, when set. Cost per useful response includes the cost of
unsuccessful work. A cheap configuration with no useful responses has no finite
cost per useful response.

The engine validates raw observations, recomputes metrics and checks identical
task/rubric fingerprints and protocols. It does not trust an uploaded winner.
Rows with missing usage, grades or prices remain visible with specific exclusions.

Observed p50/p95 and throughput describe this bounded, closed-loop sample.
A closed-loop client waits for responses; it can hide queue growth under overload.
Use a suitable open-loop load generator for a production arrival-rate target.
Repeating one task does not create independent task diversity.

For dedicated infrastructure, window cost is **full fleet hourly rate × elapsed
window**, including idle time inside that window. It excludes provisioning, idle
time outside it, storage, networking and commitments. Compare those separately in
Tokenomics. More tokens do not change a fixed fleet's hourly bill; more useful
work from that fleet can reduce cost per accepted outcome.

The frontier compares acceptance, observed p95 and cost per useful response.
The lowest observed cost among eligible runs is a candidate for further testing,
not a deployment recommendation or proof of production readiness.

## Bring an external evaluator

For coding agents, RAG, extraction or other free-form work, use a task-appropriate
evaluator. Export its acceptance decisions as `eddie-benchmark/1` reports.
Define the rubric before inspecting model results and keep human review where needed.
EDDIE never executes commands, code or URLs contained in an imported report.

The report contract is implemented in
[benchmarks.py](../backend/evaluation/benchmarks.py) and mirrored in
[benchmarks.ts](../frontend/src/api/benchmarks.ts). A report contains:

- Configuration: model/revision, runtime, harness, hardware and Region.
- Workload: name, task IDs, dataset SHA-256 and rubric SHA-256.
- Protocol: repetitions, concurrency, output limit, temperature and measurement boundary.
- Every scheduled observation: outcome, acceptance, elapsed time and available usage.
- Applicable price evidence, source, retrieval time and the complete measurement window.

An output hash is optional. Prompts and generated text are not included by the
companion runner. Token accounting must state whether input counts already include
cached tokens; unavailable counters remain null. All counts and money must be finite.

Uploads remain **supplied measurements**. Public results remain **published
evidence**. Neither can set a solver gate, approve a deployment or replace a
current account-capacity check.
