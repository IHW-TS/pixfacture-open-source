from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Customer, Quote, QuoteLine, Tenant


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _to_decimal(v: Any) -> Decimal:
    if v is None:
        return Decimal("0")
    if isinstance(v, Decimal):
        return v
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal("0")


def _amount_str(v: Any) -> str:
    """Normalize monetary values as a deterministic string with 2 decimals."""
    d = _to_decimal(v).quantize(Decimal("0.01"))
    return f"{d:.2f}"


def _date_iso(d: date | None) -> str | None:
    if not d:
        return None
    try:
        return d.isoformat()
    except Exception:
        return None


def _dt_iso(d: datetime | None) -> str | None:
    if not d:
        return None
    try:
        return d.replace(microsecond=0).isoformat() + "Z"
    except Exception:
        return None


def _digits(value: str | None) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _derive_siren(siret_or_siren: str | None) -> str:
    return _digits(siret_or_siren)[:9]


def _address_text(
    fallback: str | None,
    line1: str | None,
    line2: str | None,
    postal_code: str | None,
    city: str | None,
    country_code: str | None,
) -> str:
    structured = [
        str(line1 or "").strip(),
        str(line2 or "").strip(),
        " ".join(part for part in [str(postal_code or "").strip(), str(city or "").strip()] if part),
        str(country_code or "").strip(),
    ]
    text = "\n".join(part for part in structured if part)
    return text or str(fallback or "").strip()


@dataclass
class QuoteSealPayload:
    meta: dict[str, Any]
    supplier: dict[str, Any]
    buyer: dict[str, Any]
    lines: list[dict[str, Any]]
    totals: dict[str, Any]


def build_quote_seal_payload(db: Session, quote: Quote) -> QuoteSealPayload:
    """Build a canonical payload used for quote sealing (hashing).

    The goal is to provide a deterministic, auditable representation of what the
    customer saw when the quote was sent/shared.
    """
    tenant = db.get(Tenant, quote.tenant_id)
    customer = db.get(Customer, quote.customer_id)
    if not tenant or not customer:
        raise ValueError("Tenant ou client introuvable pour sceller le devis.")

    lines_db = (
        db.query(QuoteLine)
        .filter(QuoteLine.quote_id == quote.id)
        .order_by(QuoteLine.id.asc())
        .all()
    )

    supplier_address = _address_text(
        tenant.address,
        tenant.address_line1,
        tenant.address_line2,
        tenant.postal_code,
        tenant.city,
        tenant.country_code or tenant.country,
    )
    supplier_siret = tenant.siret or ""
    template_options = getattr(quote, "template_options", None)
    if not isinstance(template_options, dict):
        template_options = {}

    supplier = {
        "name": tenant.name,
        "address": supplier_address,
        "address_line1": tenant.address_line1 or "",
        "address_line2": tenant.address_line2 or "",
        "postal_code": tenant.postal_code or "",
        "city": tenant.city or "",
        "country_code": tenant.country_code or tenant.country or "",
        "country": tenant.country or tenant.country_code or "",
        "siret": supplier_siret,
        "siren": _derive_siren(supplier_siret),
        "naf_code": getattr(tenant, "naf_code", None) or "",
        "vat_number": tenant.vat_number or "",
        "vat_regime": getattr(tenant, "vat_regime", None) or "",
        "vat_on_debits": bool(getattr(tenant, "vat_on_debits", False)),
        "payment_terms_block": {
            "discount_terms": getattr(tenant, "discount_terms", None),
            "late_payment_interest": getattr(tenant, "late_payment_interest", None),
            "recovery_fee_eur": _amount_str(getattr(tenant, "recovery_fee_eur", None) or 40),
        },
        "iban": tenant.iban or "",
        "bic": tenant.bic or "",
        "rcs": tenant.rcs or "",
        "legal_form": tenant.legal_form or "",
        "share_capital": tenant.share_capital or "",
        "legal_mentions": tenant.legal_mentions or "",
        "vat_exemption_notice": tenant.vat_exemption_notice or "",
        "phone": tenant.phone or "",
        "email": tenant.email_reply_to or "",
        "email_reply_to": tenant.email_reply_to or "",
        "logo_url": tenant.logo_url or "",
    }
    payment_bank_account = template_options.get("payment_bank_account")
    if isinstance(payment_bank_account, dict):
        payment_iban = str(payment_bank_account.get("iban") or "").strip()
        payment_bic = str(payment_bank_account.get("bic") or "").strip()
        if payment_iban or payment_bic:
            supplier["iban"] = payment_iban
            supplier["bic"] = payment_bic

    buyer_siret = customer.siret or getattr(customer, "siren", None) or ""
    buyer_address = _address_text(
        customer.address,
        customer.address_line1,
        customer.address_line2,
        customer.postal_code,
        customer.city,
        customer.country_code or customer.country,
    )
    buyer = {
        "name": customer.name,
        "address": buyer_address,
        "address_line1": customer.address_line1 or "",
        "address_line2": customer.address_line2 or "",
        "postal_code": customer.postal_code or "",
        "city": customer.city or "",
        "country_code": customer.country_code or customer.country or "",
        "country": customer.country or customer.country_code or "",
        "siret": buyer_siret,
        "siren": getattr(customer, "siren", None) or _derive_siren(buyer_siret),
        "vat_number": customer.vat_number or "",
        "email": customer.email or "",
    }

    lines: list[dict[str, Any]] = []
    for line in lines_db:
        lines.append(
            {
                "display_number": getattr(line, "display_number", None),
                "line_type": getattr(line, "line_type", None) or "item",
                "reference": getattr(line, "reference", None),
                "product_name": line.product_name,
                "detail": getattr(line, "detail", None),
                "quantity": _amount_str(line.quantity),
                "unit_price": _amount_str(line.unit_price),
                "vat_rate": _amount_str(line.vat_rate),
                "vat_category": line.vat_category,
                "exemption_reason_code": line.exemption_reason_code,
                "unit_code": line.unit_code,
                "item_id": line.item_id,
                "accounting_account": getattr(line, "accounting_account", None),
                "line_total": _amount_str(line.line_total),
            }
        )

    totals = {
        "total_ex_vat": _amount_str(quote.total_ex_vat),
        "total_vat": _amount_str(quote.total_vat),
        "total_inc_vat": _amount_str(quote.total_inc_vat),
        "currency": (quote.currency or "EUR").upper(),
    }
    meta = {
        "tenant_id": quote.tenant_id,
        "quote_id": quote.id,
        "number": quote.number,
        "issue_date": _dt_iso(quote.issue_date),
        "valid_until": _date_iso(quote.valid_until),
        "service_date": _date_iso(getattr(quote, "service_date", None)),
        "payment_terms": quote.payment_terms,
        "purchase_order_number": quote.purchase_order_number,
        "note": quote.note,
        "template_key": getattr(quote, "template_key", None),
        "template_options": template_options if isinstance(template_options, dict) else None,
        "schema": "quote_seal_v2",
        "app_env": getattr(settings, "APP_ENV", None),
    }
    return QuoteSealPayload(meta=meta, supplier=supplier, buyer=buyer, lines=lines, totals=totals)


def compute_seal_hash(payload: QuoteSealPayload) -> str:
    canonical = json.dumps(asdict(payload), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def clear_quote_seal(quote: Quote) -> Quote:
    quote.supplier_snapshot = None
    quote.buyer_snapshot = None
    quote.lines_snapshot = None
    quote.totals_snapshot = None
    quote.seal_hash = None
    quote.seal_created_at = None
    return quote


def ensure_quote_sealed(db: Session, quote: Quote, *, force: bool = False) -> Quote:
    """Seal a quote if not already sealed.

    Idempotent by default. Use ``force=True`` when a draft is being frozen
    after a previous draft share, because editable drafts can invalidate their
    old snapshots.
    """
    if getattr(quote, "seal_hash", None) and not force:
        return quote
    payload = build_quote_seal_payload(db, quote)
    quote.supplier_snapshot = payload.supplier
    quote.buyer_snapshot = payload.buyer
    quote.lines_snapshot = payload.lines
    quote.totals_snapshot = payload.totals
    quote.seal_hash = compute_seal_hash(payload)
    quote.seal_created_at = _utcnow()
    db.add(quote)
    return quote
