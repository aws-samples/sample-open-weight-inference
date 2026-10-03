# Tokenomics: compare GPU commitments

For broader cost questions, the Advisor uses the
[Tokenomics skill](../backend/knowledge/skills/analyze-tokenomics/SKILL.md) to examine
cost per successful task, including context, caching, retries and agent work. The
GPU comparison focuses on compute commitments.

In **Compare hosting**, open **Tokenomics: compare GPU prices and Savings Plans**.
Choose an EC2 instance, Region, pool sizes and allocated hours per day, then choose
**Compare public prices**. The B200 example fills in a one- and two-instance pool;
it does not choose a model or reserve capacity.

The table shows annual cost, monthly equivalent, full-term commitment and savings
against On-Demand. Expand the details for exact rates, upfront cash, source IDs
and the allocation break-even point. Download the table with its assumptions, or
open AWS Pricing Calculator to prepare an estimate there. The app does not create
a saved Calculator estimate.

## Where prices come from

| Price | Live source and matching scope |
| --- | --- |
| On-Demand | AWS Price List `GetProducts`: exact EC2 instance and Region, Linux, shared tenancy, no bundled software |
| Savings Plans | `DescribeSavingsPlansOfferingRates`: exact EC2 instance and Region, Linux/UNIX, shared tenancy, Compute or EC2 Instance plan, 1 or 3 years, and payment option |

No price or discount percentage is hardcoded. Public quotes are cached for up to
30 minutes and show their retrieval time. Missing terms show **Not listed**;
failed, conflicting or incomplete lookups show **Pricing unavailable**. Neither
becomes a zero price or an inferred discount. A missing one-year EC2 Instance
offer does not imply that a one-year Compute offer is missing.

The runtime needs `pricing:GetProducts` and
`savingsplans:DescribeSavingsPlansOfferingRates`. The application template grants
these read-only operations. This feature does not read Cost Explorer, owned plans,
customer discounts or private pricing agreements, and cannot purchase plans.
After updating an existing installation, redeploy its runtime role as well as its
code.

## Read the commitment correctly

For `N` instances, hourly On-Demand rate `R`, effective Savings Plan rate `S`, and
allocated hours per day `H`:

| Figure | Calculation |
| --- | --- |
| On-Demand annual compute | `N × R × H × 365` |
| Savings Plan annual equivalent | `N × S × 8,760` |
| Full-term commitment | Annual equivalent × term in years |
| Monthly equivalent | Annual equivalent ÷ 12 |
| Annual savings | On-Demand annual compute − Savings Plan annual equivalent |
| Allocation break-even | `S ÷ R` of the year's hours |

AWS defines a Savings Plan year as 365 days. **A three-year annual figure is not
the total paid for three years.** All-upfront plans show that full payment at the
start. Partial-upfront cash is selected at purchase, so the table does not invent
a split. Monthly equivalent is an amortized comparison, not the monthly invoice.

Commitments remain payable during idle hours. Lowering the allocation schedule
reduces the On-Demand estimate but not the Savings Plan obligation; savings can
therefore be negative. Other eligible workloads may use idle commitment, but
that usage is outside this comparison. GPU utilization is not allocated time.

Compute Savings Plans cover eligible usage across instance families and Regions.
EC2 Instance Savings Plans are scoped to a family and Region. Both are billing
commitments, not GPU capacity reservations. EC2 rates can price the underlying
instances used by EKS; they do not include the EKS control-plane fee or price
SageMaker endpoints.

Optional monthly output tokens give a compute-only cost per million **supplied**
output tokens. The same workload volume is used for each pool. Doubling the
instance count does not assert double throughput. Measure useful output and
quality before treating that unit cost as achievable.

Storage, networking, orchestration, observability, taxes and other services are
additional. Customer agreements may change the eventual bill; this table stays
at public pricing.

- [Public offering-rate API](https://docs.aws.amazon.com/savingsplans/latest/APIReference/API_DescribeSavingsPlansOfferingRates.html)
- [Savings Plans terms](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html)
- [Plan types](https://docs.aws.amazon.com/savingsplans/latest/userguide/plan-types.html)
- [Purchase and upfront payment](https://docs.aws.amazon.com/savingsplans/latest/userguide/purchase-sp-direct.html)
