from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from sqlalchemy.orm import Session

from app.models import Invoice, InvoiceDepositApplication

TWOPLACES = Decimal("0.01")


def _to_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _money(value: Any) -> Decimal:
    return _to_decimal(value).quantize(TWOPLACES, rounding=ROUND_HALF_UP)


def _positive(value: Any) -> Decimal:
    amount = _money(value)
    return abs(amount)


def _deposit_vat_rate_from_amounts(amount_ht: Decimal, amount_vat: Decimal) -> Decimal | None:
    if amount_ht == 0:
        return None
    return _money((amount_vat / amount_ht) * Decimal("100"))


def _deposit_credit_notes(db: Session, deposit: Invoice) -> list[Invoice]:
    return (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == deposit.tenant_id,
            Invoice.related_invoice_id == deposit.id,
            Invoice.type == "credit_note",
            Invoice.status.notin_(["draft", "canceled", "cancelled"]),
        )
        .all()
    )


def deposit_invoice_net_amounts(db: Session, deposit: Invoice) -> dict[str, Decimal | bool | None]:
    amount_ht = _positive(deposit.total_ex_vat)
    amount_vat = _positive(deposit.total_vat)
    amount_ttc = _positive(deposit.total_inc_vat)

    credited_ht = Decimal("0.00")
    credited_vat = Decimal("0.00")
    credited_ttc = Decimal("0.00")
    for credit_note in _deposit_credit_notes(db, deposit):
        credited_ht += _positive(credit_note.total_ex_vat)
        credited_vat += _positive(credit_note.total_vat)
        credited_ttc += _positive(credit_note.total_inc_vat)

    net_ht = max(Decimal("0.00"), _money(amount_ht - credited_ht))
    net_vat = max(Decimal("0.00"), _money(amount_vat - credited_vat))
    net_ttc = max(Decimal("0.00"), _money(amount_ttc - credited_ttc))
    return {
        "amount_ht": amount_ht,
        "amount_vat": amount_vat,
        "amount_ttc": amount_ttc,
        "credited_ht": _money(credited_ht),
        "credited_vat": _money(credited_vat),
        "credited_ttc": _money(credited_ttc),
        "net_ht": net_ht,
        "net_vat": net_vat,
        "net_ttc": net_ttc,
        "vat_rate": _deposit_vat_rate_from_amounts(net_ht, net_vat),
        "fully_credited": net_ttc <= Decimal("0.01") and amount_ttc > Decimal("0.00"),
    }


def deposit_application_effective_amounts(db: Session, app: InvoiceDepositApplication) -> dict[str, Decimal | bool | None]:
    deposit = app.deposit_invoice or db.get(Invoice, app.deposit_invoice_id)
    if deposit is None:
        amount_ht = _positive(app.amount_ht)
        amount_vat = _positive(app.amount_vat)
        amount_ttc = _positive(app.amount_ttc)
        return {
            "amount_ht": amount_ht,
            "amount_vat": amount_vat,
            "amount_ttc": amount_ttc,
            "credited_ht": Decimal("0.00"),
            "credited_vat": Decimal("0.00"),
            "credited_ttc": Decimal("0.00"),
            "net_ht": amount_ht,
            "net_vat": amount_vat,
            "net_ttc": amount_ttc,
            "vat_rate": _deposit_vat_rate_from_amounts(amount_ht, amount_vat),
            "fully_credited": False,
        }
    return deposit_invoice_net_amounts(db, deposit)


def deposit_application_entry(db: Session, app: InvoiceDepositApplication) -> dict[str, object] | None:
    amounts = deposit_application_effective_amounts(db, app)
    amount_ttc = _money(amounts["net_ttc"])
    if amount_ttc <= Decimal("0.01"):
        return None
    number = str(app.deposit_number or "").strip()
    issue_date = app.deposit_issue_date.date().isoformat() if app.deposit_issue_date else ""
    return {
        "reference": number,
        "label": f"Acompte facture {number}" if number else "Acompte facture",
        "source": "deposit_invoice",
        "invoice_id": app.deposit_invoice_id,
        "invoice_number": number,
        "issue_date": issue_date,
        "quote_id": app.quote_id,
        "amount_ht": float(_money(amounts["net_ht"])),
        "amount_vat": float(_money(amounts["net_vat"])),
        "amount_ttc": float(amount_ttc),
        "vat_rate": float(_money(amounts["vat_rate"])) if amounts["vat_rate"] is not None else None,
        "credited_amount_ttc": float(_money(amounts["credited_ttc"])),
    }


def final_invoice_deposit_entries(db: Session, final_invoice: Invoice) -> list[dict[str, object]]:
    apps = (
        db.query(InvoiceDepositApplication)
        .filter(
            InvoiceDepositApplication.tenant_id == final_invoice.tenant_id,
            InvoiceDepositApplication.final_invoice_id == final_invoice.id,
        )
        .order_by(InvoiceDepositApplication.created_at.asc(), InvoiceDepositApplication.id.asc())
        .all()
    )
    entries: list[dict[str, object]] = []
    for app in apps:
        entry = deposit_application_entry(db, app)
        if entry is not None:
            entries.append(entry)
    return entries


def paid_advance_entries(template_options: dict | None) -> list[dict[str, object]]:
    raw = template_options.get("advance_payments") if isinstance(template_options, dict) else None
    if not isinstance(raw, list):
        return []
    entries: list[dict[str, object]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        source = str(item.get("source") or "").strip()
        if source == "requested_advance":
            continue
        entries.append(item)
    return entries


def invoice_effective_template_options(db: Session, invoice: Invoice) -> dict | None:
    options = dict(invoice.template_options or {}) if isinstance(invoice.template_options, dict) else {}
    if (invoice.invoice_kind or "standard") != "final" or (invoice.type or "invoice") == "credit_note":
        if not options:
            return None
        options["advance_payments"] = paid_advance_entries(options)
        return options

    manual_entries = [
        entry
        for entry in paid_advance_entries(options)
        if str(entry.get("source") or "").strip() != "deposit_invoice"
    ]
    deposit_entries = final_invoice_deposit_entries(db, invoice)
    if manual_entries or deposit_entries:
        options["advance_payments"] = [*manual_entries, *deposit_entries]
    else:
        options.pop("advance_payments", None)
    return options or None


def final_invoice_applied_deposit_totals(db: Session, final_invoice: Invoice) -> dict[str, Any]:
    entries = final_invoice_deposit_entries(db, final_invoice)
    total_ht = sum((_money(entry.get("amount_ht")) for entry in entries), Decimal("0.00"))
    total_vat = sum((_money(entry.get("amount_vat")) for entry in entries), Decimal("0.00"))
    total_ttc = sum((_money(entry.get("amount_ttc")) for entry in entries), Decimal("0.00"))
    return {
        "amount_ht": _money(total_ht),
        "amount_vat": _money(total_vat),
        "amount_ttc": _money(total_ttc),
        "deposit_invoice_ids": [str(entry.get("invoice_id") or "") for entry in entries if entry.get("invoice_id")],
        "entries": entries,
    }


def invoice_vat_effect_for_period(
    db: Session,
    invoice: Invoice,
    *,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
) -> dict[str, Any]:
    issue_date = invoice.issue_date
    if issue_date is None:
        return {"included": False, "reason": "Document sans date d'émission", "vat_effect": Decimal("0.00")}
    if period_start is not None and issue_date < period_start:
        return {"included": False, "reason": "Document avant période", "vat_effect": Decimal("0.00")}
    if period_end is not None and issue_date >= period_end:
        return {"included": False, "reason": "Document après période", "vat_effect": Decimal("0.00")}
    if str(invoice.status or "").lower() in {"draft", "canceled", "cancelled"}:
        return {"included": False, "reason": "Document non émis", "vat_effect": Decimal("0.00")}

    total_ht = _money(invoice.total_ex_vat)
    total_vat = _money(invoice.total_vat)
    total_ttc = _money(invoice.total_inc_vat)

    if (invoice.type or "invoice") == "credit_note":
        return {
            "included": True,
            "kind": "credit_note",
            "reason": "Avoir déduit de la TVA collectée",
            "taxable_effect": -abs(total_ht),
            "vat_effect": -abs(total_vat),
            "total_effect": -abs(total_ttc),
            "deposit_ht_deducted": Decimal("0.00"),
            "deposit_vat_deducted": Decimal("0.00"),
            "deposit_ttc_deducted": Decimal("0.00"),
            "deposit_invoice_ids": [],
        }

    if (invoice.invoice_kind or "standard") == "final":
        deposits = final_invoice_applied_deposit_totals(db, invoice)
        deposit_ht = _money(deposits["amount_ht"])
        deposit_vat = _money(deposits["amount_vat"])
        deposit_ttc = _money(deposits["amount_ttc"])
        return {
            "included": True,
            "kind": "invoice",
            "invoice_kind": "final",
            "reason": "TVA collectée sur facture finale nette des acomptes appliqués",
            "taxable_effect": _money(total_ht - deposit_ht),
            "vat_effect": _money(total_vat - deposit_vat),
            "total_effect": _money(total_ttc - deposit_ttc),
            "deposit_ht_deducted": deposit_ht,
            "deposit_vat_deducted": deposit_vat,
            "deposit_ttc_deducted": deposit_ttc,
            "deposit_invoice_ids": deposits["deposit_invoice_ids"],
        }

    invoice_kind = invoice.invoice_kind or "standard"
    return {
        "included": True,
        "kind": "invoice",
        "invoice_kind": invoice_kind,
        "reason": "TVA collectée sur facture d'acompte"
        if invoice_kind == "deposit"
        else "TVA collectée sur facture émise",
        "taxable_effect": total_ht,
        "vat_effect": total_vat,
        "total_effect": total_ttc,
        "deposit_ht_deducted": Decimal("0.00"),
        "deposit_vat_deducted": Decimal("0.00"),
        "deposit_ttc_deducted": Decimal("0.00"),
        "deposit_invoice_ids": [],
    }
