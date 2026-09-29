# Decision engine

The [application architecture](architecture-overview.md) describes the deployed
components. This page explains the deterministic decision boundary.

```text
requirements + candidate/evidence snapshot + versioned policy
                          ↓
             feasibility → comparable cost → tie-break
                          ↓
       ranked options, unresolved options, excluded options
```

`backend/solver/solve.py` performs no network calls and uses no language model.
The same frozen inputs produce the same result. Collectors gather evidence before
the solver runs; the Advisor explains the result afterward.

## Requirements and evidence

The request records the exact workload-model identity, permitted Regions,
modalities, traffic, budget, operational constraints and optional quality or
response-time objectives. A fine-tuned checkpoint remains distinct from its base
model. No latency target means no latency claim; it does not imply a GPU.

Evidence is configuration-specific: model/revision, serving runtime, hardware,
Region, workload and measurement population matter. A service listing or quota
is not a reservation. Offered, requested, held and verified capacity are different
states. Unknown evidence must remain unknown.

Each required gate has a recorded reason and one of three outcomes:

| Gate | Effect |
|---|---|
| `PASS` | The available evidence satisfies this check |
| `FAIL` | Exclude the configuration and show the failed requirement |
| `UNKNOWN` | Keep the configuration unresolved and identify the missing evidence |

Optional objectives that were not requested remain explicitly identified.
Assumptions and supplied observations keep their provenance; they must not be
advertised as measurements made by EDDIE.

## Ordering

1. Apply feasibility checks first. A failed or unresolved required gate prevents
   entry into the qualified ranking. Latency is a gate, never a cost penalty that
   a cheaper configuration can compensate for.
2. Compare complete, comparable costs using decimal arithmetic. Missing prices
   remain unknown, never zero. See [the cost model](cost-model.md).
3. Resolve exactly equal costs using operational burden, failure impact, location
   preference and a stable identifier, in that order.

The [decision map](decision-map.md) renders the evaluated request and these
recorded outcomes. Changing a form value requires a new comparison; it cannot
retroactively change the evidence behind an old result.

## Authority

The Advisor is outside the workload inference data path. Its tools can inspect
metadata, propose input changes and call calculators, but cannot turn a ranking
into deployment approval. A supported trial uses a separate immutable plan,
capability check, approval and durable execution controller.

A planning candidate is not an executable recipe. CPU/GPU planning, Bedrock import
comparison and a bounded SageMaker trial have different support levels; consult
[the current capability table](architecture-overview.md#supported-paths).
