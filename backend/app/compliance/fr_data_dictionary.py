from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Iterable, Any

from ..config import fr_dgfip_spec_target_for_issue_date
from ..models import Customer, Invoice, InvoiceLine, Tenant
from ..services.pdp.service import is_fr_b2b
from ..services.seqino_periodicity_payload import is_vat_franchise_regime
from ..utils.money import calc_line_total, calc_tax_amount, quantize_amount, to_decimal


_ALLOWED_OPERATION_NATURES = {"goods", "services", "mixed"}


def _digits(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value if ch.isdigit())


def _get_value(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _siren_from_customer(customer: Customer) -> str:
    siren = _digits(getattr(customer, "siren", None))
    if siren and len(siren) == 9:
        return siren
    siret = _digits(getattr(customer, "siret", None))
    if len(siret) == 14:
        return siret[:9]
    if len(siret) == 9:
        return siret
    return ""


def _is_fr_b2b(tenant: Tenant, customer: Customer) -> bool:
    return is_fr_b2b(tenant.country, customer.country, customer.client_type)


def _add_error(errors: list[str], field: str, message: str) -> None:
    errors.append(f"{field}: {message}")


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    return to_decimal(value)


def _has_date_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (date, datetime)):
        return True
    if isinstance(value, str):
        return bool(value.strip())
    return False


def _spec_target(invoice: Invoice) -> str:
    return fr_dgfip_spec_target_for_issue_date(getattr(invoice, "issue_date", None))


def _line_total(line: Any) -> Decimal:
    raw_total = _get_value(line, "line_total")
    if raw_total is not None:
        return to_decimal(raw_total)
    qty = _get_value(line, "quantity", 0)
    unit = _get_value(line, "unit_price", 0)
    return calc_line_total(qty, unit)


def _is_billable_line(line: Any) -> bool:
    return (_get_value(line, "line_type", "item") or "item").strip().lower() == "item"


def _tenant_has_vat_exemption_reason(tenant: Tenant) -> bool:
    vat_number = (getattr(tenant, "vat_number", "") or "").strip()
    exemption_notice = (getattr(tenant, "vat_exemption_notice", "") or "").strip()
    return is_vat_franchise_regime(getattr(tenant, "vat_regime", None)) or bool(exemption_notice and not vat_number)


def validate_fr_invoice_minimum_2026(
    tenant: Tenant,
    customer: Customer,
    invoice: Invoice,
    lines: Iterable[InvoiceLine] | None,
) -> list[str]:
    errors: list[str] = []
    if not _is_fr_b2b(tenant, customer):
        return errors

    if not _siren_from_customer(customer):
        _add_error(errors, "customer.siren", "Renseignez le SIREN du client (B2B France).")

    operation_nature = (getattr(invoice, "operation_nature", None) or "").strip().lower()
    if operation_nature not in _ALLOWED_OPERATION_NATURES:
        _add_error(
            errors,
            "invoice.operation_nature",
            "Indiquez la nature de l'operation (biens/services/mixte - categories LB/PS/LBPS).",
        )

    total_ex_vat = _decimal_or_none(getattr(invoice, "total_ex_vat", None))
    total_vat = _decimal_or_none(getattr(invoice, "total_vat", None))
    total_inc_vat = _decimal_or_none(getattr(invoice, "total_inc_vat", None))

    if total_ex_vat is None:
        _add_error(errors, "invoice.total_ex_vat", "Montant HT manquant.")
    if total_vat is None:
        _add_error(errors, "invoice.total_vat", "Montant TVA manquant.")
    if total_inc_vat is None:
        _add_error(errors, "invoice.total_inc_vat", "Montant TTC manquant.")

    invoice_type = (getattr(invoice, "type", None) or "invoice").strip().lower()
    if invoice_type != "credit_note":
        if total_ex_vat is not None and total_ex_vat < 0:
            _add_error(errors, "invoice.total_ex_vat", "Le montant HT doit etre superieur ou egal a 0.")
        if total_vat is not None and total_vat < 0:
            _add_error(errors, "invoice.total_vat", "Le montant TVA doit etre superieur ou egal a 0.")
        if total_inc_vat is not None and total_inc_vat < 0:
            _add_error(errors, "invoice.total_inc_vat", "Le montant TTC doit etre superieur ou egal a 0.")

    if total_ex_vat is not None and total_vat is not None and total_inc_vat is not None:
        expected_ttc = quantize_amount(total_ex_vat + total_vat)
        if quantize_amount(total_inc_vat) != expected_ttc:
            _add_error(errors, "invoice.total_inc_vat", "Le montant TTC doit etre egal a HT + TVA.")

    tenant_vat_exemption_reason = _tenant_has_vat_exemption_reason(tenant)
    line_totals_sum = Decimal("0")
    line_vat_sum = Decimal("0")
    for idx, line in enumerate(lines or [], start=1):
        if not _is_billable_line(line):
            continue
        line_total = _line_total(line)
        line_totals_sum += line_total
        rate = to_decimal(_get_value(line, "vat_rate", 0))
        line_vat_sum += calc_tax_amount(line_total, rate)

        vat_category = (_get_value(line, "vat_category", "S") or "S").strip().upper()
        exemption_code = (_get_value(line, "exemption_reason_code", "") or "").strip()
        if (rate == 0 or vat_category != "S") and not exemption_code and not tenant_vat_exemption_reason:
            _add_error(
                errors,
                f"lines[{idx}].exemption_reason_code",
                "Renseignez le motif d'exoneration de TVA pour cette ligne ou configurez la mention TVA de l'entreprise.",
            )

    if total_ex_vat is not None and (lines or []):
        if quantize_amount(total_ex_vat) != quantize_amount(line_totals_sum):
            _add_error(
                errors,
                "invoice.total_ex_vat",
                "Le montant HT ne correspond pas a la somme des lignes.",
            )
    if total_vat is not None and (lines or []):
        if quantize_amount(total_vat) != quantize_amount(line_vat_sum):
            _add_error(
                errors,
                "invoice.total_vat",
                "Le montant TVA ne correspond pas a la somme des lignes.",
            )

    return errors


def validate_fr_invoice_minimum_2027(
    tenant: Tenant,
    customer: Customer,
    invoice: Invoice,
    lines: Iterable[InvoiceLine] | None,
) -> list[str]:
    if _spec_target(invoice) != "2027":
        return []
    if not _is_fr_b2b(tenant, customer):
        return []
    errors: list[str] = []
    service_date = _get_value(invoice, "service_date", None)
    if not _has_date_value(service_date):
        _add_error(
            errors,
            "invoice.service_date",
            "Date de prestation requise (spec 2027+).",
        )
    # Placeholder for 2027 line-by-line requirements.
    return errors
