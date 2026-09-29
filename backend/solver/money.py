"""Decimal money and rate primitives.

All monetary and rate arithmetic in EDDIE uses Decimal. Floats are never used for
cost, because the solver's ranking must be reproducible bit-for-bit from frozen
evidence (docs/architecture.md, "Solver interface and semantics").

An unavailable price is UNKNOWN, never zero (docs/cost-model.md).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from enum import Enum
from typing import Optional

# Display rounding only. Never round before summing line items.
CENTS = Decimal("0.01")


class Evidence(str, Enum):
    """Qualification state of a value or gate.

    UNKNOWN is a first-class outcome: missing evidence must not be coerced to a
    passing gate or a zero cost.
    """

    MEASURED = "MEASURED"
    PROJECTED = "PROJECTED"
    UNKNOWN = "UNKNOWN"


class MissingPrice(Exception):
    """Raised when a required price input is absent.

    Callers convert this into an UNKNOWN cost rather than substituting zero.
    """


@dataclass(frozen=True)
class Rate:
    """A price with its unit, region, and provenance.

    `sku` and `effective_date` are retained so a decision can be replayed against
    the exact catalogue entry it used.
    """

    amount: Decimal
    unit: str
    currency: str = "USD"
    region: str = "us-east-1"
    sku: Optional[str] = None
    effective_date: Optional[str] = None
    source: Optional[str] = None

    def __post_init__(self) -> None:
        if not isinstance(self.amount, Decimal):
            raise TypeError(f"Rate.amount must be Decimal, got {type(self.amount).__name__}")
        if self.amount < 0:
            raise ValueError(f"Rate.amount must be non-negative, got {self.amount}")

    @classmethod
    def usd(cls, amount: str, unit: str, **kw: object) -> "Rate":
        return cls(amount=Decimal(amount), unit=unit, **kw)  # type: ignore[arg-type]


@dataclass(frozen=True)
class LineItem:
    """One billable component of a candidate's cost.

    Carries the full reproducibility contract from docs/cost-model.md: what was
    billed, how much, at what rate, from which source, and how certain it is.
    """

    label: str
    phase: str  # platform | discovery | build | trial | serving | cleanup
    quantity: Decimal
    quantity_unit: str
    rate: Optional[Rate]
    evidence: Evidence = Evidence.PROJECTED
    note: str = ""

    @property
    def amount(self) -> Optional[Decimal]:
        """Extended cost, or None when the rate is unknown."""
        if self.rate is None:
            return None
        return self.quantity * self.rate.amount

    def __post_init__(self) -> None:
        if not isinstance(self.quantity, Decimal):
            raise TypeError(
                f"LineItem.quantity must be Decimal, got {type(self.quantity).__name__}"
            )


@dataclass(frozen=True)
class CostBreakdown:
    """Itemized cost for one candidate under one workload scenario.

    `total` is None when any line item lacks a rate: a partial sum would
    understate the candidate and could win a comparison it should not enter.
    """

    items: tuple[LineItem, ...]

    @property
    def is_complete(self) -> bool:
        return all(item.rate is not None for item in self.items)

    @property
    def total(self) -> Optional[Decimal]:
        if not self.is_complete:
            return None
        return sum((item.amount for item in self.items), start=Decimal("0"))

    @property
    def unpriced(self) -> tuple[str, ...]:
        return tuple(i.label for i in self.items if i.rate is None)

    def by_phase(self, phase: str) -> Optional[Decimal]:
        matching = [i for i in self.items if i.phase == phase]
        if any(i.rate is None for i in matching):
            return None
        return sum((i.amount for i in matching), start=Decimal("0"))

    def display_total(self) -> Optional[Decimal]:
        total = self.total
        return None if total is None else total.quantize(CENTS, rounding=ROUND_HALF_UP)
