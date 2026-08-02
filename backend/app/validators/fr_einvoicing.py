from __future__ import annotations

from ..models import Customer, Invoice, Tenant


ALLOWED_OPERATION_NATURE = {"goods", "services", "mixed"}


def _normalize_country(value: str | None) -> str:
    return (value or "").strip().upper()


def _digits(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value if ch.isdigit())


def _is_fr_b2b(customer: Customer, supplier: Tenant) -> bool:
    if _normalize_country(customer.country) != "FR":
        return False
    if _normalize_country(supplier.country) != "FR":
        return False
    client_type = (customer.client_type or "business").strip().lower()
    return client_type == "business"


def _has_siren(customer: Customer) -> bool:
    siren_digits = _digits(customer.siren)
    if len(siren_digits) == 9:
        return True
    siret_digits = _digits(customer.siret)
    return len(siret_digits) >= 9


def _address_complete(value: str | None) -> bool:
    if not value:
        return False
    stripped = value.strip()
    return len(stripped) >= 5


def validate_fr_b2b_invoice_ready(
    invoice: Invoice,
    customer: Customer,
    supplier: Tenant,
) -> list[str]:
    if not _is_fr_b2b(customer, supplier):
        return []
    missing: list[str] = []
    if not _has_siren(customer):
        missing.append("customer.siren")
    operation_nature = (invoice.operation_nature or "").strip().lower()
    if operation_nature not in ALLOWED_OPERATION_NATURE:
        missing.append("invoice.operation_nature")
    delivery_address = (invoice.delivery_address or "").strip()
    customer_address = (customer.address or "").strip()
    differs_flag = bool(getattr(invoice, "delivery_address_differs", False))
    differs = differs_flag or (delivery_address and delivery_address != customer_address)
    if differs and not _address_complete(delivery_address):
        missing.append("invoice.delivery_address")
    return missing


def fr_einvoicing_error(fields: list[str]) -> dict[str, object]:
    return {
        "code": "fr_einvoicing_missing_fields",
        "fields": fields,
        "message": "Informations manquantes pour une facture B2B France.",
    }
