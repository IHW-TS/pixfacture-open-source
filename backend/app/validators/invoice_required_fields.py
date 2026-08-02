from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Iterable

from ..config import settings
from ..models import Customer, Invoice, InvoiceLine, Tenant


def _has_text(value: str | None) -> bool:
    return bool((value or "").strip())


def _digits(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value if ch.isdigit())


def _is_fr(value: str | None) -> bool:
    return (value or "FR").strip().upper() == "FR"


def _has_address(address: str | None, line1: str | None, postal_code: str | None, city: str | None) -> bool:
    if _has_text(address):
        return True
    if _has_text(line1) and _has_text(postal_code) and _has_text(city):
        return True
    return False


def _has_legal_id(value: str | None) -> bool:
    digits = _digits(value)
    return len(digits) in {9, 14}


def _is_individual_client_type(value: str | None) -> bool:
    return (value or "").strip().lower() in {
        "individual",
        "particulier",
        "consumer",
        "b2c",
        "private",
    }


def _invalid_billable_quantity(line: InvoiceLine, *, credit_note: bool) -> bool:
    raw = getattr(line, "quantity", None)
    if raw is None:
        return True
    try:
        quantity = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        return True
    if credit_note:
        return quantity == 0
    return quantity <= 0


def validate_invoice_required_fields(
    invoice: Invoice,
    tenant: Tenant,
    customer: Customer,
    lines: Iterable[InvoiceLine] | None,
) -> list[str]:
    missing: list[str] = []

    if not _has_text(tenant.name):
        missing.append("tenant.name")
    if not _has_address(tenant.address, tenant.address_line1, tenant.postal_code, tenant.city):
        missing.append("tenant.address")
    if _is_fr(tenant.country):
        supplier_siret = tenant.siret or settings.SUPPLIER_SIRET
        if not _has_legal_id(supplier_siret):
            missing.append("tenant.siret")
        if not (_has_text(tenant.vat_number) or _has_text(tenant.vat_exemption_notice)):
            missing.append("tenant.vat_number")
        if not _has_text(tenant.late_payment_interest):
            missing.append("tenant.late_payment_interest")

    if not _has_text(customer.name):
        missing.append("customer.name")
    if not _has_address(customer.address, customer.address_line1, customer.postal_code, customer.city):
        missing.append("customer.address")
    if _is_fr(customer.country) and not _is_individual_client_type(customer.client_type):
        if not _has_legal_id(customer.siret or customer.siren):
            missing.append("customer.siret")

    if not _has_text(invoice.number):
        missing.append("invoice.number")
    if not getattr(invoice, "issue_date", None):
        missing.append("invoice.issue_date")
    if not invoice.due_date and not _has_text(invoice.payment_terms):
        missing.append("invoice.payment_terms")

    document_lines = list(lines or [])
    if not document_lines:
        missing.append("invoice.lines")
    else:
        if any(not _has_text(getattr(line, "product_name", None)) for line in document_lines):
            missing.append("invoice.lines.product_name")
        billable_lines = [
            line
            for line in document_lines
            if (getattr(line, "line_type", None) or "item").strip().lower() == "item"
        ]
        if not billable_lines:
            missing.append("invoice.lines")
        credit_note = (getattr(invoice, "type", None) or "invoice").strip().lower() == "credit_note"
        if any(_invalid_billable_quantity(line, credit_note=credit_note) for line in billable_lines):
            missing.append("invoice.lines.quantity")
        if any(getattr(line, "unit_price", None) is None for line in billable_lines):
            missing.append("invoice.lines.unit_price")

    return sorted(set(missing))
