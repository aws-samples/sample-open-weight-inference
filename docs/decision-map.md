# Explain a hosting comparison

In **Compare hosting**, choose **View decision map**. The map opens over the
workspace; your project stays in place. **Why this option?** opens the same map
with that exact configuration selected.

The first view shows the evaluated model, comparison period, location constraints,
budget and whether a response-time target was requested. The map shows
Bedrock model API, Bedrock import, SageMaker, CPU hosting and GPU hosting paths.
CPU candidates stay visible for downloadable models when no latency target is set;
missing runtime or performance evidence remains explicit.

Select **Explore path** to see:

1. The recorded requirement checks, with a short explanation of what remains
   unresolved or was not met. Expand a check for its reason and evidence reference.
2. The estimated cost and whether the configuration entered the solver's ranking.
   Open price evidence for quantities, rates, source, SKU and effective date.
3. The recorded cost ordering and the rule used when costs are equal.

**Challenge this option** opens an Advisor draft containing the comparison and
configuration references. It does not send the message, alter requirements or
approve a deployment. You can edit the question before sending. Manual
**Change my requirements** and **Review testing options** remain available.

## What the statuses mean

| Status | Meaning |
|---|---|
| Selected by solver | The recorded solver chose this configuration from its qualifying set. |
| Conditional cost leader / Conditional fit | The ranking depends on assumptions or incomplete qualification. |
| Needs verification | At least one required check lacks evidence; a price is not a recommendation. |
| Ruled out | A recorded requirement failed for the configurations on this branch. |
| Not evaluated | This comparison contains no evaluated configuration for this path. |
| Not requested, on a check | The corresponding objective was not declared. This is not a measurement. |
| Assumed / Supplied result | Evidence provenance is explicit; these labels do not claim EDDIE observed it. |

The GPU branch currently explains a coverage gap. It does not claim AWS has no
capacity. Choosing a native model does not invent downloadable weights or task
equivalence with a different open-weight model.

## Evidence contract

This is a presentation of `EvaluateResponse`, not a second solver. It preserves
the backend's `ranked`, `unresolved` and `excluded` sets and their order. It does
not calculate prices, predict performance, infer model suitability, or synthesize
an agent's private reasoning.

The solver first checks requirements, then minimizes comparable exact total cost
among feasible configurations. Equal costs use operational burden, failure
impact, location preference and a stable identifier. The map explains that rule;
it does not invent an individual tie-break explanation absent from the response.

The map reads the evaluated request, not unsaved form values. Changing the
requirements removes the current explanation until the comparison is updated.
A changed request or evidence snapshot closes an open map. Historical comparisons
remain identifiable and do not offer current-decision controls.

## Interaction and verification

Cloudscape supplies the modal, buttons, selectors, expandable checks, status
indicators and icons. Decorative CSS connectors express the same hierarchy as the
text. No diagram CDN or graph runtime is used.

The modal keeps its title and close controls visible during scrolling. Branch
selection brings the detail panel into view, respects reduced motion, and moves
keyboard focus to that panel. **All paths** returns to the overview. Escape closes
the modal and restores focus. Mobile uses a single-column branching layout;
light and dark themes share the same states and controls.

`DecisionMap.test.tsx` covers evidence provenance, exact-candidate selection,
unchanged ranking, assumptions, absent objectives, stale snapshots, untrusted
text and the optional Advisor handoff. The real-data
`e2e/manual-hosting.spec.ts` exercises the map with native Bedrock and SageMaker
comparisons, budget changes, keyboard focus, both themes and a 390-pixel viewport.
It creates no inference resources and sends no Advisor message.

See [the first-project walkthrough](getting-started.md#compare-your-first-model)
and [CPU/GPU planning examples](compute-planning.md) for reproducible inputs.
