from __future__ import annotations

from decimal import Decimal
from typing import Any

from ..utils.money import quantize_amount

REQUESTED_ADVANCE_SOURCES = {"requested_advance", "manual_advance_payment"}


def _positive_amount_ttc(entry: dict[str, Any]) -> Decimal:
    try:
        amount = Decimal(str(entry.get("amount_ttc") or 0))
    except Exception:
        return Decimal("0")
    return quantize_amount(amount) if amount > 0 else Decimal("0")


def requested_quote_advance_total_ttc(options: dict | None) -> Decimal:
    if not isinstance(options, dict):
        return Decimal("0")
    raw_advances = options.get("advance_payments")
    legacy_total = Decimal("0")
    if isinstance(raw_advances, list):
        for entry in raw_advances:
            if isinstance(entry, dict):
                legacy_total += _positive_amount_ttc(entry)
    requested = options.get("requested_advance")
    requested_total = _positive_amount_ttc(requested) if isinstance(requested, dict) else Decimal("0")
    return max(quantize_amount(legacy_total), requested_total)


def requested_quote_advance_summary(options: dict | None) -> dict[str, Any] | None:
    if not isinstance(options, dict):
        return None

    requested = options.get("requested_advance")
    entries: list[dict[str, Any]] = []
    if isinstance(requested, dict) and _positive_amount_ttc(requested) > 0:
        entries = [requested]
    else:
        raw_advances = options.get("advance_payments")
        if isinstance(raw_advances, list):
            entries = [
                entry
                for entry in raw_advances
                if isinstance(entry, dict)
                and str(entry.get("source") or "").strip() in REQUESTED_ADVANCE_SOURCES
                and _positive_amount_ttc(entry) > 0
            ]

    if not entries:
        return None

    total_ht = quantize_amount(sum((Decimal(str(entry.get("amount_ht") or 0)) for entry in entries), Decimal("0")))
    total_vat = quantize_amount(sum((Decimal(str(entry.get("amount_vat") or 0)) for entry in entries), Decimal("0")))
    total_ttc = quantize_amount(sum((_positive_amount_ttc(entry) for entry in entries), Decimal("0")))
    if total_ttc <= 0:
        return None

    vat_rates = {
        str(entry.get("vat_rate")).strip()
        for entry in entries
        if entry.get("vat_rate") is not None and str(entry.get("vat_rate")).strip()
    }
    first = entries[0]
    label = str(first.get("label") or "Acompte demandé").strip() or "Acompte demandé"
    reference = str(first.get("reference") or "").strip() or None
    return {
        "label": label,
        "reference": reference,
        "amount_ht": float(total_ht),
        "amount_vat": float(total_vat),
        "amount_ttc": float(total_ttc),
        "vat_rate": float(Decimal(next(iter(vat_rates)))) if len(vat_rates) == 1 else None,
    }


def invoice_template_options_from_quote(
    quote_template_options: dict | None,
    *,
    source_quote_id: str,
    has_deposit_invoices: bool,
) -> dict:
    template_options = dict(quote_template_options) if isinstance(quote_template_options, dict) else {}
    template_options["source_quote_id"] = source_quote_id
    template_options["kind"] = "final" if has_deposit_invoices else "standard"

    raw_advances = template_options.get("advance_payments")
    requested_advance = None
    if isinstance(raw_advances, list):
        retained_advances = []
        for entry in raw_advances:
            source = str(entry.get("source") or "").strip() if isinstance(entry, dict) else ""
            if source in REQUESTED_ADVANCE_SOURCES:
                if (
                    not has_deposit_invoices
                    and requested_advance is None
                    and isinstance(entry, dict)
                    and _positive_amount_ttc(entry) > 0
                ):
                    requested_advance = dict(entry)
                    requested_advance["source"] = "requested_advance"
                    requested_advance["label"] = str(requested_advance.get("label") or "Acompte demandé").strip()
                continue
            retained_advances.append(entry)
        template_options["advance_payments"] = retained_advances

    existing_requested = template_options.get("requested_advance")
    if has_deposit_invoices:
        template_options.pop("requested_advance", None)
    elif requested_advance and not isinstance(existing_requested, dict):
        template_options["requested_advance"] = requested_advance

    return template_options
