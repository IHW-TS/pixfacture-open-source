from __future__ import annotations

from typing import Any

from ..config import fr_dgfip_spec_target_for_issue_date
from ..models import Customer, Invoice, Tenant


VAT_ON_DEBITS_MENTION = "Option pour le paiement de la taxe d'après les débits"


def _digits(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value if ch.isdigit())


def _is_b2b_fr(tenant: Tenant, customer: Customer) -> bool:
    customer_country = (customer.country or "FR").strip().upper()
    if customer_country != "FR":
        return False
    tenant_country = (tenant.country or "FR").strip().upper()
    if tenant_country != "FR":
        return False
    client_type = (customer.client_type or "business").strip().lower()
    return client_type == "business"


def _issue(
    code: str,
    field: str,
    message: str,
    target: str,
    status: str = "missing",
) -> dict[str, Any]:
    return {
        "code": code,
        "field": field,
        "message": message,
        "target": target,
        "status": status,
    }


def _should_apply_2027(invoice: Invoice) -> bool:
    return fr_dgfip_spec_target_for_issue_date(getattr(invoice, "issue_date", None)) == "2027"


def _validate_fr_einvoicing_fields_2027(
    invoice: Invoice,
    tenant: Tenant,
    customer: Customer,
) -> list[dict[str, Any]]:
    # Placeholder for 2027+ requirements.
    return []


def validate_fr_einvoicing_fields(
    invoice: Invoice,
    tenant: Tenant,
    customer: Customer,
) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    if not _is_b2b_fr(tenant, customer):
        return checks

    siren_digits = _digits(customer.siren)
    if not siren_digits:
        checks.append(
            _issue(
                "customer_siren_missing",
                "customer.siren",
                "Renseignez le SIREN du client pour une facture B2B France.",
                "client",
            )
        )
    elif len(siren_digits) != 9:
        checks.append(
            _issue(
                "customer_siren_invalid",
                "customer.siren",
                "SIREN client invalide (9 chiffres requis) pour une facture B2B France.",
                "client",
            )
        )

    operation_nature = (invoice.operation_nature or "").strip().lower()
    if operation_nature not in {"goods", "services", "mixed"}:
        checks.append(
            _issue(
                "invoice_operation_nature_missing",
                "invoice.operation_nature",
                "Indiquez la nature de l'operation (biens, services ou mixte).",
                "facture",
            )
        )

    delivery_address = (invoice.delivery_address or "").strip()
    customer_address = (customer.address or "").strip()
    differs_flag = bool(getattr(invoice, "delivery_address_differs", False))
    differs = differs_flag or (delivery_address and delivery_address != customer_address)
    if differs and not delivery_address:
        checks.append(
            _issue(
                "invoice_delivery_address_missing",
                "invoice.delivery_address",
                "Renseignez l'adresse de livraison si elle diffère de l'adresse de facturation.",
                "facture",
            )
        )

    if bool(getattr(tenant, "vat_on_debits", False)):
        checks.append(
            _issue(
                "tenant_vat_on_debits_notice",
                "tenant.vat_on_debits",
                VAT_ON_DEBITS_MENTION,
                "entreprise",
                status="info",
            )
        )

    if _should_apply_2027(invoice):
        checks.extend(_validate_fr_einvoicing_fields_2027(invoice, tenant, customer))

    return checks
