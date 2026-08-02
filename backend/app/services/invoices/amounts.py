from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any


TWOPLACES = Decimal("0.01")


def _to_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _money(value: Decimal) -> Decimal:
    return value.quantize(TWOPLACES, rounding=ROUND_HALF_UP)


def invoice_advance_payments_total_ttc(template_options: dict | None) -> Decimal:
    raw = template_options.get("advance_payments") if isinstance(template_options, dict) else None
    if not isinstance(raw, list):
        return Decimal("0.00")

    total = Decimal("0")
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("source") or "").strip() == "requested_advance":
            continue
        amount_ttc = _to_decimal(entry.get("amount_ttc"))
        if amount_ttc <= 0:
            amount_ttc = _to_decimal(entry.get("amount_ht")) + _to_decimal(entry.get("amount_vat"))
        if amount_ttc > 0:
            total += amount_ttc
    return _money(total)


def invoice_balance_due_amount(
    total_inc_vat: Any,
    template_options: dict | None,
    *,
    credits: Any = 0,
    paid: Any = 0,
) -> Decimal:
    return _money(
        _to_decimal(total_inc_vat)
        - invoice_advance_payments_total_ttc(template_options)
        - _to_decimal(credits)
        - _to_decimal(paid)
    )
