from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from ..models import Customer, Invoice, InvoiceLine, Tenant
from ..utils.money import calc_tax_amount, quantize_amount, to_decimal


_REQUIRED_INVOICE_DRAFT_FIELDS = (
    "issue_date",
    "type_code",
    "currency_code",
    "seller",
    "buyer",
    "invoice_lines",
    "vat_breakdowns",
    "document_totals",
)


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    return raw or None


def _normalize_country(value: Any) -> str | None:
    cleaned = _clean_text(value)
    if not cleaned:
        return None
    return cleaned.upper()


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return to_decimal(value)
    except Exception:
        return None


def _snapshot_value(snapshot: dict | None, key: str, fallback: Any = None) -> Any:
    if not isinstance(snapshot, dict):
        return fallback
    value = snapshot.get(key)
    if value is None:
        return fallback
    if isinstance(value, str) and not value.strip():
        return fallback
    return value


def _compact(payload: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in payload.items():
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, (list, dict)) and not value:
            continue
        cleaned[key] = value
    return cleaned


def _party_payload(
    snapshot: dict | None,
    *,
    name: str | None,
    legal_id: str | None,
    vat_number: str | None,
    address: str | None,
    address_line1: str | None,
    address_line2: str | None,
    postal_code: str | None,
    city: str | None,
    country: str | None,
    role: str,
) -> dict[str, Any]:
    resolved_legal_id = _clean_text(_snapshot_value(snapshot, "legal_id", None))
    if not resolved_legal_id:
        resolved_legal_id = _clean_text(_snapshot_value(snapshot, "siret", None))
    if not resolved_legal_id:
        resolved_legal_id = _clean_text(_snapshot_value(snapshot, "siren", None)) or _clean_text(legal_id)
    resolved_address = _clean_text(_snapshot_value(snapshot, "address", None)) or _clean_text(address)
    resolved_line1 = (
        _clean_text(_snapshot_value(snapshot, "address_line1", None))
        or _clean_text(address_line1)
    )
    resolved_line2 = (
        _clean_text(_snapshot_value(snapshot, "address_line2", None))
        or _clean_text(address_line2)
    )
    resolved_postal_code = (
        _clean_text(_snapshot_value(snapshot, "postal_code", None))
        or _clean_text(postal_code)
    )
    resolved_city = _clean_text(_snapshot_value(snapshot, "city", None)) or _clean_text(city)
    address_lines = [line.strip() for line in str(resolved_address or "").splitlines() if line.strip()]
    if not resolved_line1 and address_lines:
        resolved_line1 = address_lines[0]
    if not resolved_line2 and len(address_lines) > 2:
        resolved_line2 = address_lines[1]
    if not resolved_postal_code or not resolved_city:
        for line in reversed(address_lines):
            match = re.match(r"^\s*([A-Z0-9 -]{3,12})\s+(.+?)\s*$", line, re.IGNORECASE)
            if not match:
                continue
            candidate_postal = match.group(1).replace(" ", "")
            if not re.search(r"\d", candidate_postal):
                continue
            resolved_postal_code = resolved_postal_code or match.group(1).strip()
            resolved_city = resolved_city or match.group(2).strip()
            break

    resolved_country = (
        _normalize_country(_snapshot_value(snapshot, "country_code", None))
        or _normalize_country(_snapshot_value(snapshot, "country", None))
        or _normalize_country(country)
    )
    postal_address = _compact(
        {
            "street_name": resolved_line1,
            "additional_street_name": resolved_line2,
            "city_name": resolved_city,
            "postal_zone": resolved_postal_code,
            "country_code": resolved_country,
        }
    )
    resolved_name = _clean_text(_snapshot_value(snapshot, "name", None)) or _clean_text(name)
    resolved_vat = _clean_text(_snapshot_value(snapshot, "vat_number", None)) or _clean_text(vat_number)
    payload: dict[str, Any] = {
        "name": resolved_name,
        "postal_address": postal_address,
        "legal_registration_name": resolved_name,
        "party_identifier": resolved_legal_id,
        "party_identifier_scheme": "0009" if resolved_legal_id else None,
        "tax_registrations": (
            [{"scheme_id": "VAT", "value": resolved_vat}] if resolved_vat else None
        ),
    }
    if role == "seller":
        payload.update(
            {
                "seller_identifier": resolved_legal_id,
                "seller_identifier_scheme": "0009" if resolved_legal_id else None,
                "seller_vat_identifier": resolved_vat,
            }
        )
    else:
        payload.update(
            {
                "buyer_identifier": resolved_legal_id,
                "buyer_identifier_scheme": "0009" if resolved_legal_id else None,
                "buyer_legal_registration_identifier": resolved_legal_id,
                "buyer_vat_identifier": resolved_vat,
            }
        )
    return _compact(payload)


def _vat_category(line: InvoiceLine) -> str:
    raw = _clean_text(getattr(line, "vat_category", None))
    if raw:
        return raw.upper()
    rate = _to_decimal(line.vat_rate) or Decimal("0")
    return "S" if rate > 0 else "Z"


def _invoice_line_payload(line: InvoiceLine, index: int) -> dict[str, Any]:
    line_id = (
        _clean_text(getattr(line, "display_number", None))
        or _clean_text(getattr(line, "reference", None))
        or _clean_text(getattr(line, "id", None))
        or str(index)
    )
    payload = {
        "line_id": line_id,
        "invoiced_quantity": _to_float(quantize_amount(line.quantity)),
        "unit_of_measure": _clean_text(getattr(line, "unit_code", None)) or "C62",
        "line_net_amount": _to_float(quantize_amount(line.line_total)),
        "item_name": _clean_text(line.product_name),
        "item_description": _clean_text(getattr(line, "detail", None)),
        "item_seller_identifier": _clean_text(getattr(line, "item_id", None)),
        "item_price": _to_float(quantize_amount(line.unit_price)),
        "item_price_base_quantity": 1,
        "vat_category_code": _vat_category(line),
        "vat_rate": _to_float(quantize_amount(line.vat_rate)),
    }
    return _compact(payload)


def _is_item_line(line: InvoiceLine | None) -> bool:
    return str(getattr(line, "line_type", None) or "item").strip().lower() == "item"


def _vat_breakdowns(lines: list[InvoiceLine]) -> list[dict[str, Any]]:
    by_category_rate: dict[tuple[str, Decimal], Decimal] = {}
    for line in lines:
        if not _is_item_line(line):
            continue
        rate = _to_decimal(line.vat_rate)
        base = _to_decimal(line.line_total)
        if rate is None or base is None:
            continue
        key = (_vat_category(line), rate)
        by_category_rate[key] = by_category_rate.get(key, Decimal("0")) + base
    breakdowns: list[dict[str, Any]] = []
    for category, rate in sorted(by_category_rate.keys()):
        base = by_category_rate[(category, rate)]
        tax_amount = calc_tax_amount(base, rate)
        breakdowns.append(
            _compact(
                {
                    "category_code": category,
                    "rate": _to_float(quantize_amount(rate)),
                    "taxable_amount": _to_float(quantize_amount(base)),
                    "tax_amount": _to_float(tax_amount),
                }
            )
        )
    return breakdowns


def _document_totals(invoice: Invoice, lines: list[InvoiceLine]) -> dict[str, Any]:
    total_ex_vat = _to_decimal(invoice.total_ex_vat)
    total_vat = _to_decimal(invoice.total_vat)
    total_inc_vat = _to_decimal(invoice.total_inc_vat)
    if total_ex_vat is None:
        total_ex_vat = sum(
            (_to_decimal(line.line_total) or Decimal("0")) for line in lines
        ) or Decimal("0")
    if total_vat is None:
        total_vat = sum(
            (
                calc_tax_amount(
                    _to_decimal(line.line_total) or Decimal("0"),
                    _to_decimal(line.vat_rate) or Decimal("0"),
                )
            )
            for line in lines
        ) or Decimal("0")
    assert total_ex_vat is not None
    assert total_vat is not None
    if total_inc_vat is None:
        total_inc_vat = total_ex_vat + total_vat
    line_net_total = sum(
        (_to_decimal(line.line_total) or Decimal("0"))
        for line in lines
        if _is_item_line(line)
    )
    return _compact(
        {
            "sum_of_line_net_amounts": _to_float(quantize_amount(line_net_total)),
            "invoice_total_without_vat": _to_float(quantize_amount(total_ex_vat)),
            "invoice_total_vat_amount": _to_float(quantize_amount(total_vat)),
            "invoice_total_with_vat": _to_float(quantize_amount(total_inc_vat)),
            "amount_due_for_payment": _to_float(quantize_amount(total_inc_vat)),
        }
    )


def build_seqino_invoice_draft(
    invoice: Invoice,
    customer: Customer | None,
    lines: list[InvoiceLine],
    tenant: Tenant | None,
) -> dict[str, Any]:
    seller_snapshot = None
    if isinstance(invoice.supplier_snapshot, dict) and invoice.supplier_snapshot:
        seller_snapshot = invoice.supplier_snapshot
    elif isinstance(invoice.seller_snapshot, dict) and invoice.seller_snapshot:
        seller_snapshot = invoice.seller_snapshot
    buyer_snapshot = invoice.buyer_snapshot if isinstance(invoice.buyer_snapshot, dict) else None
    seller = _party_payload(
        seller_snapshot,
        name=(tenant.name if tenant else None),
        legal_id=(tenant.siret if tenant else None),
        vat_number=(tenant.vat_number if tenant else None),
        address=(tenant.address if tenant else None),
        address_line1=(tenant.address_line1 if tenant else None),
        address_line2=(tenant.address_line2 if tenant else None),
        postal_code=(tenant.postal_code if tenant else None),
        city=(tenant.city if tenant else None),
        country=(
            (getattr(tenant, "country_code", None) or getattr(tenant, "country", None))
            if tenant
            else None
        ),
        role="seller",
    )
    buyer = _party_payload(
        buyer_snapshot,
        name=(customer.name if customer else None),
        legal_id=((customer.siret or customer.siren) if customer else None),
        vat_number=(customer.vat_number if customer else None),
        address=(customer.address if customer else None),
        address_line1=(customer.address_line1 if customer else None),
        address_line2=(customer.address_line2 if customer else None),
        postal_code=(customer.postal_code if customer else None),
        city=(customer.city if customer else None),
        country=(
            (getattr(customer, "country_code", None) or getattr(customer, "country", None))
            if customer
            else None
        ),
        role="buyer",
    )
    issue_date = invoice.issue_date.date().isoformat() if invoice.issue_date else None
    currency_code = _clean_text(invoice.currency) or "EUR"
    type_code = "381" if (invoice.type or "").lower() == "credit_note" else "380"
    invoice_lines = [
        _invoice_line_payload(line, index)
        for index, line in enumerate((line for line in lines if _is_item_line(line)), start=1)
    ]
    vat_breakdowns = _vat_breakdowns(lines)
    draft = {
        "specification_identifier": (
            "urn:cen.eu:en16931:2017#compliant#"
            "urn:fdc:peppol.eu:2017:poacc:billing:3.0"
        ),
        "issue_date": issue_date,
        "due_date": invoice.due_date.date().isoformat() if invoice.due_date else None,
        "type_code": type_code,
        "currency_code": currency_code,
        "purchase_order_reference": _clean_text(invoice.purchase_order_number),
        "buyer_reference": (
            _clean_text(getattr(customer, "endpoint_id", None))
            or _clean_text(getattr(customer, "siret", None))
            or _clean_text(getattr(customer, "siren", None))
        ),
        "seller": seller,
        "buyer": buyer,
        "invoice_lines": invoice_lines,
        "vat_breakdowns": vat_breakdowns,
        "document_totals": _document_totals(invoice, lines),
        "payment_means_type_code": "30" if getattr(tenant, "iban", None) else None,
        "payment_account_identifier": _clean_text(getattr(tenant, "iban", None)),
        "payment_service_provider_identifier": _clean_text(getattr(tenant, "bic", None)),
        "remittance_information": _clean_text(invoice.number),
        "preceding_invoice_reference": (
            _clean_text(invoice.related_invoice_id) if type_code == "381" else None
        ),
    }
    return _compact(draft)


def validate_seqino_invoice_draft(draft: dict | None) -> list[str]:
    if not isinstance(draft, dict):
        return list(_REQUIRED_INVOICE_DRAFT_FIELDS)
    missing: list[str] = []
    for key in _REQUIRED_INVOICE_DRAFT_FIELDS:
        value = draft.get(key)
        if value is None:
            missing.append(key)
            continue
        if isinstance(value, str) and not value.strip():
            missing.append(key)
            continue
        if isinstance(value, (list, dict)) and not value:
            missing.append(key)
            continue
    for party_key in ("seller", "buyer"):
        party = draft.get(party_key)
        if not isinstance(party, dict):
            continue
        if not _clean_text(party.get("name")):
            missing.append(f"{party_key}.name")
        address = party.get("postal_address")
        if not isinstance(address, dict):
            missing.append(f"{party_key}.postal_address")
        else:
            for field in ("city_name", "country_code"):
                if not _clean_text(address.get(field)):
                    missing.append(f"{party_key}.postal_address.{field}")
    invoice_lines = draft.get("invoice_lines")
    if isinstance(invoice_lines, list):
        required_line_fields = (
            "line_id",
            "invoiced_quantity",
            "unit_of_measure",
            "line_net_amount",
            "item_name",
            "item_price",
            "vat_category_code",
        )
        for index, line in enumerate(invoice_lines):
            if not isinstance(line, dict):
                missing.append(f"invoice_lines.{index}")
                continue
            for field in required_line_fields:
                if line.get(field) is None or line.get(field) == "":
                    missing.append(f"invoice_lines.{index}.{field}")
    vat_breakdowns = draft.get("vat_breakdowns")
    if isinstance(vat_breakdowns, list):
        for index, breakdown in enumerate(vat_breakdowns):
            if not isinstance(breakdown, dict):
                missing.append(f"vat_breakdowns.{index}")
                continue
            for field in ("category_code", "taxable_amount", "tax_amount"):
                if breakdown.get(field) is None or breakdown.get(field) == "":
                    missing.append(f"vat_breakdowns.{index}.{field}")
    totals = draft.get("document_totals")
    if isinstance(totals, dict):
        for field in (
            "sum_of_line_net_amounts",
            "invoice_total_without_vat",
            "invoice_total_vat_amount",
            "invoice_total_with_vat",
            "amount_due_for_payment",
        ):
            if totals.get(field) is None or totals.get(field) == "":
                missing.append(f"document_totals.{field}")
    return missing
