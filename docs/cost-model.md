# EDDIE cost model specification

Prices retrieved 12 September 2026. Currency in the worked example is USD; Region is **us-east-1**. These are public list prices, not a customer's negotiated bill. No latency benchmark or capacity allocation was performed.

## Contract for a reproducible estimate

Each line item must contain:

```text
resource/service + Region/AZ + SKU/offer + purchase option
usage dimension + quantity + quantity unit + price + price unit
effective date + retrieval time + source reference/hash
billing minimum/rounding + allocation rule + uncertainty
```

Use decimal arithmetic. Normalize units explicitly; reject ambiguous or missing dimensions. An unavailable price is `UNKNOWN`, never zero.

For candidate `c` and workload scenario `s`:

```text
C(c,s) = compute + model/software + storage + network
       + observability/security services + request services
       + one-time setup/migration + attributable commitments
```

Show the components even when some cancel between candidates. State exclusions such as tax, support plans, customer discounts, and unpriced publisher offers. An estimate with a material unpriced component cannot claim a complete budget pass.

Compare the same horizon and functional workload. A three-day event includes preparation, warm readiness, session drain, cleanup, and any commitment extending beyond the event. Repeated events should also show the recurring total, not repeatedly hide setup costs.

v1 minimizes estimated direct cash cost for the agreed trace. For an uncertain trace, produce low/base/high scenarios and apply the user's explicit budget/risk policy. Do not invent a weighted blend of latency, price, and operations. If plausible price/usage ranges reverse the winner, report a contingent ordering and the evidence needed to resolve it.

For a new commitment, charge its full unavoidable outlay. For an existing commitment or cluster, show both incremental cash cost and allocated cost; label which measure drives the decision. Do not pretend unused prepaid capacity is free in one candidate while charging fully allocated cost to another.

## Input sources

| Input | Authoritative source or API | Required interpretation |
|---|---|---|
| Public service SKU and price | AWS Price List Query: `DescribeServices`, `GetAttributeValues`, `GetProducts`; Bulk catalogs / `ListPriceLists`, `GetPriceListFileUrl` | Filter deployment Region and exact usage/product attributes. Price List API endpoint Region is not the deployment Region. Preserve product and term dimensions, currency, effective date, and pagination. |
| Prices used in this document | Public **Bulk API JSON** for AmazonBedrock and AmazonSageMaker, pinned versions below | No authenticated `GetProducts` call was made. These are actual retrieved catalogs, not inferred prices. |
| CMI units and generation | Bedrock `GetImportedModel.customModelUnits` | Use `customModelUnitsPerModelCopy` and `customModelUnitsVersion`; match both model family and CMU version to pricing. Pre-import CMU sizing is an assumption unless separately verified. |
| CMI copies and workload | CloudWatch `ModelCopy`, invocation telemetry, benchmark request trace, billing export | Copy counts alone are not a complete billing-window ledger. Calibrate the billing policy against observed line items. |
| Dedicated instance counts/configuration | SageMaker `DescribeEndpoint`, `DescribeEndpointConfig`, `DescribeInferenceComponent`; EC2 `DescribeInstances`; HyperPod `DescribeCluster` / node inventory | Include minimum ready capacity, rollout overlap, multi-AZ replicas, idle time, setup, and drain. Model endpoint-specific runtime overhead. |
| Effective quota and usage | Service Quotas `ListServiceQuotas`, `GetServiceQuota`; service/resource usage APIs and CloudWatch usage metrics | Check both the permitted limit and remaining headroom. Different quotas can count instances, vCPUs, models, tokens, requests, or jobs. |
| Capacity evidence | Existing allocation; EC2 `DescribeCapacityReservations`; `DescribeCapacityBlockOfferings`; SageMaker `SearchTrainingPlanOfferings` / `DescribeTrainingPlan` | A quoted offer does not reserve inventory. The usable resource type, status, quantity, AZ, dates, and remaining capacity must match the candidate. |
| Spot price | EC2 `DescribeSpotPriceHistory` plus launch/fulfillment evidence | A historical spot price is not a price guarantee or proof of capacity. Store interruption/recovery assumptions separately. |
| Reservation or publisher price | Exact Capacity Block/training-plan offer; Marketplace/private-offer agreement; authorized vendor quote | Preserve upfront, recurring, minimum, overage, currency, term, and renewal conditions. No estimated substitute for a missing private offer. |
| Actual usage and reconciliation | AWS Data Exports / CUR, tagged resource inventory; vendor usage export | Cost Explorer can provide aggregates; detailed billing dimensions/resource IDs are needed to debug discrepancies. Never double-count reused reports or charges. |
| Model throughput/latency and quality | Applicable benchmark and evaluation records | Determines feasibility and the required copy/allocation trace. Does not provide a “latency penalty” in the cost function. |

Public references: [Price List Query API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html), [CMI metadata](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetImportedModel.html), [SageMaker endpoint capacity plans](https://docs.aws.amazon.com/sagemaker/latest/dg/training-plan-utilization-for-inference-endpoints.html).

## Formulas by hosting target

### 1. Bedrock Custom Model Import

Let:

* `u_m` = CMUs per copy of imported model `m`, from the import metadata.
* `r_m` = USD per CMU-minute for its family, Region, and CMU version.
* `W_mj` = number of billable five-minute windows attributable to copy/allocation episode `j`.
* `B_m = 5 × Σ_j W_mj` = total billable **copy-minutes**.
* `s_m` = USD per stored CMU-month.
* `M_m` = stored-month quantity under the applicable storage billing policy.

```text
CMI_compute(m) = u_m × r_m × B_m
CMI_storage(m) = u_m × s_m × M_m
CMI_total      = Σ_m (CMI_compute(m) + CMI_storage(m)) + other line items
```

Import itself has no import fee. Source S3 storage, transfers, and surrounding infrastructure can still cost money.

`B_m` is not application wall-clock busy time. Derive it from the workload and an experimentally qualified scaling/billing policy: copy startup/readiness, routing, concurrent copies, idle retention, and billable window boundaries. Include prewarming traffic. Do not separately round every request or simply multiply the last observed copy count by the entire month.

Public docs establish five-minute billing windows beginning with successful invocation, but their cost-guide equation is dimensionally inconsistent and does not fully specify every scale/idle boundary. The formula above is exact for known billable windows. A predeployment simulation must identify its policy version and uncertainty; validate that policy against billing export before claiming invoice accuracy.

Current pricing examples imply the storage meter is per CMU, although the raw catalog uses a generic `Model/month` label. Normalize this with an explicit source annotation. Do not invent partial-month proration. See [pricing](https://aws.amazon.com/bedrock/pricing/) and the [cost guide](https://docs.aws.amazon.com/bedrock/latest/userguide/import-model-calculate-cost.html).

### 2. Bedrock native on-demand models

Use the exact model's billable dimensions rather than forcing everything into tokens:

```text
C_native = Σ_d quantity_d × rate_d
```

For a text model whose quoted rates are per million tokens:

```text
C_text = (uncached_input_tokens × p_input
        + cache_write_tokens × p_cache_write
        + cache_read_tokens × p_cache_read
        + output_tokens × p_output) / 1,000,000
```

The input categories must be disjoint under that model's actual accounting. Reasoning tokens, cache duration, image tokenization, tools, and other billable features follow the model's own meter; do not charge cached input twice.

Audio/video can be billed by provider-specific audio tokens, seconds, minutes, or other units. Store distinct input/output and modality prices. Speech sessions can transmit silence, context, text, tool results, and regenerated audio; use actual metered usage instead of “minutes spoken” alone.

Standard/Priority/Flex use their supported model/tier prices. Do not apply an assumed global multiplier. Verify that the selected model supports the tier and that its measured latency is acceptable.

For an applicable Reserved-tier offer:

```text
C_reserved = monthly_fixed_offer(input_TPM, output_TPM) × committed_months
           + Standard_overflow_cost
           + other offered charges
```

The current public guide specifies one- or three-month terms; the actual quote supplies rates. Bedrock Provisioned Throughput is a separate model-specific purchase option, with its own model-unit price and commitment. Neither should be silently applied to CMI. [Tier guide](https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html)

### 3. SageMaker real-time endpoints, JumpStart, and NIM

For allocation episode `e`, let `b_e` be **billed hours after the applicable billing minimum and rounding**, `n_e` the identical instance count, and `p_e` the exact Hosting SKU price:

```text
C_SM_compute = Σ_e n_e × p_e × b_e
C_SM_total   = C_SM_compute + endpoint_storage + network
             + publisher/software_fee + other line items
```

Do not price a Hosting endpoint from an EC2 price or a SageMaker Training/Cluster SKU. A JumpStart deployment or a NIM container does not erase the infrastructure bill or determine the publisher fee.

For an autoscaling trace, partition time at count/configuration changes and sum the allocated instance-time. Price initial loading, idle readiness, deployment overlap, and teardown lag. A continuously allocated endpoint has 24 hours/day of compute charges. A scheduled endpoint only has its actual allocation periods.

Inference-component scale-to-zero is a distinct policy: price zero instances when actually at zero, but qualify multi-minute readiness and invocation failures before allowing it for interactive traffic. Do not assume every endpoint or container supports the same scaling configuration. [Scale-to-zero guide](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling-zero-instances.html)

For a SageMaker training plan used by an endpoint:

```text
C_plan = whole_offer_cost + uncovered_on_demand_usage
       + separately_billed_items_in_offer
```

Never add ordinary on-demand compute a second time for instance-time already covered by the offer. Validate the plan's target resource and Active dates.

### 4. SageMaker HyperPod

```text
C_HyperPod = Σ_node_episodes (node_count × HyperPod_cluster_rate × billed_hours)
           + EKS_control_plane_if_used + CPU/system_nodes
           + storage/shared_filesystems + networking
           + applicable_management/publisher_charges
           + other line items
```

Use the exact SageMaker Cluster purchase option and instance SKU, not a Hosting or generic EC2 rate. Include idle nodes, resilient capacity, model loading, distributed communication, and deployment overlap. Multi-node scheduling changes the minimum feasible allocation, so required node count must come from a qualified deployment.

If a plan covers nodes, apply its offer once and price uncovered usage separately. Mark every additional service as included/excluded by the offer to avoid double-counting. A large model's active MoE parameter count alone is insufficient for memory or cost sizing: total resident weights, KV cache, parallelism, and communication matter.

### 5. EC2 GPU and EKS

```text
C_EC2 = Σ_allocation_episodes (instance_count × exact_EC2_rate × billed_hours)
      + EBS + software + common charges

C_EKS = C_worker_capacity + C_control_plane + system_nodes
      + applicable_Auto_Mode_or_other_management_charges + common charges
```

Current public EKS standard-support control-plane pricing is $0.10/cluster-hour; extended support is $0.60/cluster-hour. This is **not** the GPU worker price. Additional EKS modes have their own charges. [EKS pricing](https://aws.amazon.com/eks/pricing/)

For shared clusters, report both the added capacity required and the agreed share of existing cluster cost. Reject spare-capacity assumptions that disappear under the concurrent workloads being promised.

For an immediate EC2 On-Demand Capacity Reservation:

```text
C_reserved_capacity = covered_running_instance_cost
                    + unused_reserved_instance_count × applicable_rate × billed_hours
```

Equivalently, for a homogeneous reservation and no discounts, pay for the reserved count throughout the held period, plus any extra unreserved instances. Do not charge the used reservation and its running instance twice. ODCR provides capacity assurance, not inherently a discount. Future-dated reservations can have commitment/cancellation rules; use their actual terms. Savings Plans generally discount eligible usage without reserving capacity. [ODCR guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-reservations.html)

For Capacity Blocks:

```text
C_block = full_purchased_offer + separately_billed_OS/storage/network
        + capacity_outside_the_block
```

Charge the purchased block even if the model is idle. Use its specific available dates, quantity, instance type, and offer price; do not substitute an on-demand estimate. Pricing documentation excludes Savings Plans/Reserved Instance discounts for blocks. [Block billing](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/capacity-blocks-pricing-billing.html)

For Spot, integrate the applicable rate over successful allocation and include replacement/recovery allocation. For a critical live session, an interruption-tolerant architecture and measured recovery are feasibility requirements; a cheap mean hourly price does not offset an SLO failure.

### 6. Marketplace and external APIs

Marketplace is procurement metadata, not a sixth compute meter:

| Purchased product | Cost model |
|---|---|
| Model software deployed to a Bedrock Marketplace/SageMaker endpoint | SageMaker hosting + the exact model software/offer charges + surrounding AWS usage |
| Registered BYOE endpoint | Underlying endpoint cost + applicable offer/integration charges; registration is not a conversion to CMI billing |
| Vendor SaaS/API | Contract/subscription/minimum + metered overage + connector/network cost; execution location comes from the service agreement |
| Celebrity voice or IP license | Exact rights-holder/vendor fees, permitted usage, territories, term, and renewal; often a separate line from synthesis usage |

For a contract with included usage, calculate overage only after applying the specific entitlement rules. Do not charge full metered usage and included credits twice. A monthly subscription with usage-based overage is not the same as pure no-minimum pay-as-you-go.

## Duty-cycle breakeven

For **one CMI copy versus one continuously allocated dedicated instance**, both already proven to serve the same required workload:

```text
H       = common comparison horizon in hours
r_CMI   = CMUs_per_copy × price_per_CMU_minute × 60
D_bill  = CMI_billable_copy_hours / H
C_CMI   = H × D_bill × r_CMI + F_CMI
C_ded   = H × p_instance + F_ded

D_star  = p_instance / r_CMI
          + (F_ded - F_CMI) / (H × r_CMI)
```

Ignoring differing fixed/ancillary costs gives the proposed ratio:

```text
D_star = instance_hourly / CMI_hourly_when_active
```

The comparison must change if one candidate needs more replicas:

```text
CMI_copy_hours_star =
    (p_instance × dedicated_instance_hours + F_ded - F_CMI) / r_CMI
```

This form handles scheduled dedicated allocation and variable instance count. If a single “duty cycle” is shown for multiple copies, specify the reference copy count used in its denominator; aggregate copy-hours can exceed wall-clock hours.

Duty cycle means **billable presence**, not GPU utilization or fraction of seconds spent decoding. Requests arriving often enough to defeat scale-to-zero can produce nearly 100% billable duty at very low utilization. Prewarming can improve latency while removing most of the scale-to-zero savings.

## Worked example: same model, different traffic shape

### Price evidence

The public regional catalogs were retrieved and their relevant products/terms saved in [prices-2026-09-12.json](evidence/prices-2026-09-12.json).

| Meter | Current price | Evidence |
|---|---:|---|
| Llama CMI v1, us-east-1 | $0.05718/CMU/minute | Bedrock SKU `8EJKXB49YY4SMCKM`; term effective 2026-08-01 |
| CMI storage, us-east-1 | $1.95/CMU/month | SKU `YQSJA22BPUVEWDW3`; public pricing table supplies the per-CMU interpretation |
| SageMaker `ml.g5.2xlarge`, Hosting, us-east-1 | $1.515/instance-hour | SKU `BTQ8KZF3DKVFJY87`; term effective 2026-09-01 |

Pinned catalogs:

* [AmazonBedrock, published 2026-09-11 12:44:08 UTC](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/20260911124408/us-east-1/index.json)
* [AmazonSageMaker, published 2026-09-11 19:43:04 UTC](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/20260911194304/us-east-1/index.json)

### Explicit illustrative assumptions

Use the same Llama 3.1 8B weight artifact in both targets. For arithmetic, assume its CMI import reports **two CMUs** and one copy or one `ml.g5.2xlarge` would be sufficient under the requested workload. **Neither assumption has been benchmarked here.** Two CMUs comes from an AWS reference example, not a new import performed for this task.

The requests have an illustrative short token mix of 1,024 input / 128 output tokens. This is not a claim that a single 24 GB GPU can serve 128K contexts at the required concurrency. Actual artifact precision, configured context, throughput, queueing, and p99 must qualify both candidates before either can be recommended.

`ml.g5.2xlarge` is a concrete priced comparator, not a claim that it is the cheapest feasible SageMaker instance. A real solver must evaluate the other supported configurations.

Both columns exclude networking, endpoint disk, observability, publisher fees, accelerator/COA operation, build/benchmark spending, and other unprovided usage. They are hosting arithmetic, not a complete application quote. The CMI storage column budgets a **full month** at $3.90 even for the event; it does not assert exact partial-month invoicing. Dedicated allocation periods below are billed-hour assumptions including readiness/drain; a real plan must supply those times.

```text
CMI active-copy rate = 2 × $0.05718 × 60 = $6.8616/hour
Compute-only breakeven = $1.515 / $6.8616 = 22.08%
```

| Scenario | Three-day bursty event | Always-on, 30-day service |
|---|---:|---:|
| Comparison horizon | 72 hours | 720 hours |
| CMI billable copy activity | 36 separated episodes × 10 billable minutes = 6 copy-hours | One copy × 720 hours |
| CMI billable duty | 8.33% | 100% |
| CMI compute | **$41.17** | **$4,940.35** |
| CMI full-month storage allowance | $3.90 | $3.90 |
| CMI compute + storage allowance | **$45.07** | **$4,944.25** |
| SageMaker continuously allocated compute | **$109.08** | **$1,090.80** |
| Arithmetic outcome under these assumptions | CMI is cheaper | SageMaker is cheaper |

The ten-minute episodes are **assumed billable-window outcomes**, including any idle/prewarming effects. They are not an assertion that ten minutes of traffic always bills ten minutes. A timestamped trace and billing-policy simulation must substantiate them.

With the $3.90 CMI storage allowance and no other differing costs, the event breakeven is approximately 21.29%, rather than the compute-only 22.08%.

Now change only the dedicated allocation policy. If the event has predictable seven-hour service windows on each of three days, and startup/drain fit within **21 billed hours**, SageMaker compute is:

```text
21 × $1.515 = $31.815 ≈ $31.82
```

That is below the assumed CMI event compute, even before storage. It requires a measured readiness plan and obtainable capacity for each scheduled allocation. If readiness requires additional time, charge it. If the windows cannot be predicted, this policy may be ineligible.

Likewise, if the first request after idle must receive audio or text in hundreds of milliseconds, an unprepared cold CMI copy may fail feasibility. It does not win because $45.07 is lower than $109.08. Keeping CMI warm changes its billable duty and requires recomputing the comparison.

These examples establish the economic method using real current **rates**. They do not establish a latency-qualified placement. [Machine-readable arithmetic assumptions](../examples/cost-scenarios.json) retain that distinction.

## Benchmark economics and calibration

Before each experiment:

```text
experiment_budget = estimated_allocation_and_loading
                  + expected_metered_test_usage
                  + storage/network/logging
                  + bounded_cleanup_contingency
```

Use a short screening stage before expensive tail measurements. A rejected artifact should not receive a full multi-hour load test. Compare the next experiment's cost with plausible decision value; do not spend more benchmarking a tiny event than the decision can reasonably save unless risk reduction justifies it.

Afterward, reconcile predicted usage against detailed billing by resource, meter, time window, and offer. Record discrepancy and update the versioned billing policy. A new policy changes the decision snapshot and is reviewable; the agent must not silently “adjust” a result to match an expected winner.

## Full application and lifecycle cost

Installing the sample application has costs of its own. The [application architecture](architecture-overview.md) identifies the deployed services; [costs and cleanup](cost-budget.md) explains what can remain billable.

Assign every billable usage segment to exactly one phase and owner:

```text
phase = platform | discovery | build | trial | serving | cleanup
owner = installation | project | case | experiment | deployment
```

For the selected decision horizon:

```text
C_solution =
    C_shared_platform_allocated
  + C_case_discovery
  + C_preselection_experiments
  + C_selected_deployment

C_selected_deployment =
    approved_build_and_staging
  + inference_operation
  + deployment_specific_network_storage_observability
  + rollout_overlap_and_cleanup
  + attributable_commercial_commitments
```

These are partitions of the cost ledger, not extra charges to add on top of overlapping earlier terms. For example, endpoint storage and rollout hours already included in the hosting formula appear once in `C_selected_deployment`. A promoted benchmark endpoint's timeline is partitioned into trial and serving intervals without charging its entire lifetime to both.

| Component | Calculation/input |
|---|---|
| Frontend/control plane | Sum the billable CloudFront/S3/WAF/API Gateway/Lambda/DynamoDB/Step Functions/AgentCore usage dimensions and any standing capacity from the deployed profile |
| COA | Actual graph/search, containers/load balancers, NAT/private endpoints, runtimes, storage, logs, and request usage from its deployed inventory; include production redundancy and backups |
| Advisor and COA model calls | Per model/region/tier: input, cached-input, output, embedding, or other documented units divided by the rate's unit size, multiplied by that exact rate; include retries and internal COA calls |
| Container/artifact build | CodeBuild billed duration and compute class, artifact acquisition/transfer, ECR/S3 storage, scans and required validation resources under their applicable meters |
| Benchmark/quality campaigns | Actual allocated time and provider usage across candidates, load workers, retention, and cleanup contingency; account for trials that fail |
| Inference facade/bridge | Request/duration/connection and transfer meters of the actual path; for a production speech bridge include minimum healthy capacity and deployment overlap |
| Operations/retention | Logs/traces, retained artifacts, backups, recovery capacity, and residual resource storage according to the declared policy |

Obtain AWS rates through the Price List service/attribute discovery and exact regional SKU/term mapping. Obtain usage from infrastructure configuration, planned workflow traces, runtime telemetry, and billing exports. Obtain advisor/vendor commercial rates from the exact configured provider and offer. Do not assume one shared “LLM price” covers the advisor, embeddings, COA, and workload.

No full platform price was measured or quoted in this research. In particular, COA's graph/search and container inventory cannot be assigned zero idle cost because the frontend is serverless.

### Ranking and allocation policy

Show both incremental project cost and any allocated share of the common platform. If a shared charge is equal across candidates, identify it as common; it can still make the overall solution exceed the budget. A candidate-specific bridge, knowledge requirement, or dedicated fleet is not a common charge.

The [evidence guidance](sources.md) adds request/task cost denominators, source deduplication, billing revision/coverage, and fixed-mix breakeven formulas for usage APIs. Public list rates remain a labeled baseline when accepted contract rates are unavailable. Do not substitute an anecdotal invoice discount ratio for a verified price term.

Already-spent research/benchmark expense is reported as sunk spending when comparing the next action. Future required experiments and setup are included in the plan's forward cost. State whether the selection horizon includes the initial build, recurring events, replacements, or a new minimum commercial term.

The deployment plan shows:

* Expected setup/build and trial spend.
* Expected and conservative running-cost scenarios over an explicit horizon.
* Maximum approved resource counts and allocation lifetimes.
* Storage/retention and non-cancellable commitment exposure.
* Platform cost separately from the selected inference service.

Admission control, time limits, and independent cleanup enforce resource bounds. Cost telemetry and deletion can lag; do not market an AWS Budgets alarm or a cost estimate as a cent-exact hard spending cap.

## Expanded benchmark and GPU comparisons

The [CPU/GPU planning guide](compute-planning.md) extend the consumers of these formulas. A single `PriceSnapshot`/cost implementation serves comparison, GPU tools, reports and deployment plans.

* Collect applicable Savings Plans offering rates through `DescribeSavingsPlansOfferings` / `DescribeSavingsPlansOfferingRates`, preserving plan type, product, term, payment option, rate unit and coverage. Query existing-plan coverage only with appropriate authorization. A discount does not reserve capacity.
* Compare the full purchasable instance and new commitment exposure. A tensor-parallel fraction is an allocation assumption, not a cash price, unless a supported fractional product or qualified shared-fleet policy establishes otherwise.
* Report cost per attempted and valid successful logical task with the cost of failed work/retries in the numerator. Zero successful tasks produce no finite cost-per-success estimate.
* Preserve all relevant setup, screening/qualification, judge, load-worker and cleanup costs. Separate experiment overhead from ongoing inference economics while retaining a complete spend total.
* Native runtime token quota/burndown, Mantle input/output accounting and billed tokens remain distinct. Regional/profile availability and quota collection do not determine price by themselves.
* A quality/cost frontier is exploratory and cohort-specific; final selection remains feasibility followed by cost. Do not use a weighted cost/quality score or mislabel cost as a percentage saving.

Public reference: [Savings Plans offering rates](https://docs.aws.amazon.com/savingsplans/latest/APIReference/API_DescribeSavingsPlansOfferingRates.html).
