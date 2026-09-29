"""How many Custom Model Units an imported model copy needs.

This is the single most consequential number in a Bedrock Custom Model Import quote:
cost is linear in it, so getting it wrong by a factor scales the whole figure by that
factor. EDDIE previously hardcoded 2 for every imported model, which is correct for a
Llama 3.1 8B at 128K context and understates a Llama 3.1 70B by 4x.

**AWS decides this, at import.** The documentation is explicit: the number depends on the
model's architecture, parameter count and context length, and Amazon Bedrock determines
it when the model is imported. It is then readable as
`customModelUnitsPerModelCopy` from `GetImportedModel`. There is no published formula, so
there is nothing to compute exactly.

That leaves three honest states, and the type below keeps them distinct:

* **MEASURED** -- read from an actual imported model in this account. The only exact value.
* **DOCUMENTED** -- the model matches an example AWS publishes, so the figure is theirs.
* **ASSUMED** -- neither applies. An estimate with its basis stated, carried through the
  cost as an assumption rather than presented as a quote.

An assumed value is never silently a quote. `CmuEstimate.assumption` is text the interface
must show, and the cost line item is labelled PROJECTED.

Sources:
  https://docs.aws.amazon.com/bedrock/latest/APIReference/API_CustomModelUnits.html
  https://aws.amazon.com/blogs/machine-learning/deploy-deepseek-r1-distilled-llama-models-with-amazon-bedrock-custom-model-import/
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional

#: Examples AWS publishes, keyed by (architecture family, parameter billions, context).
#:
#: Only entries AWS actually states. The two Llama examples appear in the Custom Model
#: Import pricing documentation; nothing else is added by inference, because a plausible
#: guess recorded here would become indistinguishable from a documented fact.
DOCUMENTED_CMUS: dict[tuple[str, int, int], int] = {
    ("Llama", 8, 128_000): 2,
    ("Llama", 70, 128_000): 8,
}

#: Provenance of a CMU figure, most trustworthy first.
MEASURED = "MEASURED"
DOCUMENTED = "DOCUMENTED"
ASSUMED = "ASSUMED"


@dataclass(frozen=True)
class CmuEstimate:
    """A CMU count with where it came from and what it assumes."""

    units: Decimal
    provenance: str
    basis: str
    #: Non-empty when this is not a verified figure. The interface must show it.
    assumption: str = ""
    #: A conservative upper bound, when one can be stated. Cost uncertainty is real and
    #: hiding it behind a single number is how an estimate becomes a quote.
    upper_bound: Optional[Decimal] = None

    @property
    def verified(self) -> bool:
        return self.provenance == MEASURED

    def to_json(self) -> dict[str, Any]:
        return {
            "units": str(self.units),
            "provenance": self.provenance,
            "basis": self.basis,
            "assumption": self.assumption or None,
            "upperBound": str(self.upper_bound) if self.upper_bound else None,
            "verified": self.verified,
        }


def _family(architecture: str) -> str:
    """The pricing family a CMI architecture belongs to."""
    lowered = (architecture or "").lower()
    if "llama" in lowered:
        return "Llama"
    if "mistral" in lowered or "mixtral" in lowered:
        return "Mistral"
    if "qwen" in lowered:
        return "Qwen"
    if "gptoss" in lowered or "gpt_oss" in lowered:
        return "OSS"
    return "Unknown"


def estimate_cmus(
    *,
    architecture: str,
    total_params_b: Optional[Decimal],
    context_tokens: Optional[int],
    weights_gb: Optional[Decimal] = None,
    measured_units: Optional[int] = None,
) -> CmuEstimate:
    """Best available CMU count, labelled with how good it is.

    `measured_units` is `customModelUnitsPerModelCopy` from an actual import. When it is
    present nothing else is considered, because it is the real answer.
    """
    if measured_units is not None:
        return CmuEstimate(
            units=Decimal(measured_units),
            provenance=MEASURED,
            basis=(
                "Read from the imported model in this account "
                "(customModelUnitsPerModelCopy)."
            ),
        )

    family = _family(architecture)

    # An exact documented example.
    if total_params_b is not None and context_tokens:
        key = (family, int(total_params_b.to_integral_value()), int(context_tokens))
        documented = DOCUMENTED_CMUS.get(key)
        if documented is not None:
            return CmuEstimate(
                units=Decimal(documented),
                provenance=DOCUMENTED,
                basis=(
                    f"AWS publishes {documented} Custom Model Units for a {family} "
                    f"{key[1]}B model at {key[2]:,} context."
                ),
            )

    # Nothing documented matches. Estimate from the two published anchors and say so.
    #
    # The anchors are 8B/128K -> 2 and 70B/128K -> 8. Those are not proportional to
    # parameters (they imply 4B per unit at the small end and 8.75B at the large end), so
    # no formula is fitted. Instead the nearest anchor at or above the model's size is
    # used, which is the conservative direction: it cannot understate cost, and
    # understating a bill is the failure that matters.
    if total_params_b is not None:
        params = total_params_b
        if params <= Decimal("8"):
            units, bound = Decimal("2"), Decimal("2")
        elif params <= Decimal("70"):
            # Between the anchors. The lower anchor cannot be assumed, so the range is
            # stated and the upper end is used for cost.
            units, bound = Decimal("4"), Decimal("8")
        else:
            units, bound = Decimal("8"), None
        return CmuEstimate(
            units=units,
            provenance=ASSUMED,
            basis=(
                "Estimated from the two examples AWS publishes: 2 units for an 8B model "
                "and 8 units for a 70B model, both at 128K context."
            ),
            assumption=(
                f"Assumed {units} Custom Model Units per copy. Amazon Bedrock decides "
                f"the real number when the model is imported, from its architecture, "
                f"parameter count and context length"
                + (
                    f"; for a model this size it could be as high as {bound}, which "
                    f"would raise the running cost proportionally."
                    if bound and bound != units
                    else "."
                )
            ),
            upper_bound=bound,
        )

    # No parameter count at all: this is genuinely unknown, and the conservative anchor
    # is used only so a figure can be shown at all -- clearly marked.
    return CmuEstimate(
        units=Decimal("2"),
        provenance=ASSUMED,
        basis="No parameter count is known for this model.",
        assumption=(
            "Assumed 2 Custom Model Units per copy, the smallest documented value, "
            "because this model's parameter count has not been established. Inspect the "
            "model so the estimate can be based on its real size. Amazon Bedrock decides "
            "the actual number at import."
        ),
        upper_bound=None,
    )
