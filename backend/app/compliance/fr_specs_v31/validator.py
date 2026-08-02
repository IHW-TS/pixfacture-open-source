from __future__ import annotations

from decimal import Decimal
from typing import Any, Iterable, TypedDict

from ...services.pdp.service import is_fr_b2b
from ...services.seqino_periodicity_payload import is_vat_franchise_regime
from ...utils.money import calc_line_total, calc_tax_amount, quantize_amount, to_decimal


_ALLOWED_OPERATION_NATURES = {"goods", "services", "mixed", "lb", "ps", "lbps"}
_OPERATION_NATURE_CODES = {"goods": "LB", "services": "PS", "mixed": "LBPS"}


class SectionMeta(TypedDict):
    label: str
    required: bool
    severity: str
    next_action: str | None


def _digits(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value if ch.isdigit())


def _get_value(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _siren_from_entity(entity: Any) -> str:
    siren = _digits(_get_value(entity, "siren", None))
    if siren and len(siren) == 9:
        return siren
    siret = _digits(_get_value(entity, "siret", None))
    if len(siret) == 14:
        return siret[:9]
    if len(siret) == 9:
        return siret
    legal_id = _digits(_get_value(entity, "legal_id", None))
    if len(legal_id) == 14:
        return legal_id[:9]
    if len(legal_id) == 9:
        return legal_id
    return ""


def _is_fr_b2b_invoice(supplier: Any, customer: Any) -> bool:
    supplier_country = _get_value(supplier, "country", None) or "FR"
    customer_country = _get_value(customer, "country", None) or "FR"
    client_type = _get_value(customer, "client_type", None) or "business"
    return is_fr_b2b(supplier_country, customer_country, client_type)


def _add_issue(
    issues: list[dict[str, str]],
    *,
    level: str,
    code: str,
    field: str | None,
    message: str,
    section: str,
    severity: str = "p0",
) -> None:
    issues.append(
        {
            "level": level,
            "code": code,
            "field": field or "",
            "message": message,
            "section": section,
            "severity": severity,
        }
    )


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    return to_decimal(value)


def _line_total(line: Any) -> Decimal:
    raw_total = _get_value(line, "line_total", None)
    if raw_total is not None:
        return to_decimal(raw_total)
    qty = _get_value(line, "quantity", 0)
    unit = _get_value(line, "unit_price", 0)
    return calc_line_total(qty, unit)


def _supplier_has_vat_exemption_reason(supplier: Any) -> bool:
    vat_number = (_get_value(supplier, "vat_number", "") or "").strip()
    exemption_notice = (_get_value(supplier, "vat_exemption_notice", "") or "").strip()
    return is_vat_franchise_regime(_get_value(supplier, "vat_regime", None)) or bool(
        exemption_notice and not vat_number
    )


def _checklist_item(
    *,
    key: str,
    label: str,
    required: bool,
    severity: str,
    issues: list[dict[str, str]],
    next_action: str | None,
    applicable: bool,
) -> dict[str, object]:
    status = "not_applicable"
    missing_fields: list[str] = []
    if applicable:
        status = "ok"
        error_issues = [issue for issue in issues if issue["level"] == "error"]
        warning_issues = [issue for issue in issues if issue["level"] == "warning"]
        if error_issues:
            status = "missing"
            missing_fields = []
            for issue in error_issues:
                value = issue.get("field") or issue.get("code")
                if value:
                    missing_fields.append(value)
        elif warning_issues:
            status = "warning"
            missing_fields = []
            for issue in warning_issues:
                value = issue.get("field") or issue.get("code")
                if value:
                    missing_fields.append(value)
    return {
        "key": key,
        "label": label,
        "status": status,
        "required": required,
        "severity": severity,
        "missing_fields": missing_fields,
        "next_action": next_action,
        "details": {"issues": issues},
    }


def _build_checklist(issues: list[dict[str, str]], applicable: bool) -> list[dict[str, object]]:
    sections: dict[str, SectionMeta] = {
        "supplier_identity": {
            "label": "Identite fournisseur",
            "required": True,
            "severity": "p0",
            "next_action": "Renseigner le SIREN/SIRET du fournisseur.",
        },
        "customer_identity": {
            "label": "Identite client",
            "required": True,
            "severity": "p0",
            "next_action": "Renseigner le SIREN/SIRET du client.",
        },
        "invoice_core": {
            "label": "Donnees facture",
            "required": True,
            "severity": "p0",
            "next_action": "Completer numero, date, devise et nature d'operation.",
        },
        "totals": {
            "label": "Montants & TVA",
            "required": True,
            "severity": "p0",
            "next_action": "Verifier les montants HT/TVA/TTC et leur coherence.",
        },
        "vat_exemption": {
            "label": "TVA exoneree",
            "required": False,
            "severity": "p1",
            "next_action": "Ajouter le motif d'exoneration si applicable.",
        },
    }
    checklist: list[dict[str, object]] = []
    for key, meta in sections.items():
        section_issues = [issue for issue in issues if issue.get("section") == key]
        checklist.append(
            _checklist_item(
                key=key,
                label=meta["label"],
                required=meta["required"],
                severity=meta["severity"],
                issues=section_issues,
                next_action=meta["next_action"],
                applicable=applicable,
            )
        )
    return checklist


def validate_fr_specs_v31(
    invoice: Any,
    supplier: Any,
    customer: Any,
    lines: Iterable[Any] | None,
) -> tuple[list[str], list[str], dict[str, object]]:
    errors: list[str] = []
    warnings: list[str] = []
    issues: list[dict[str, str]] = []

    applicable = _is_fr_b2b_invoice(supplier, customer)
    if not applicable:
        warnings.append("DSE v3.1 non applicable (facture hors FR B2B).")
        metadata = {
            "spec": "fr_specs_v31",
            "spec_version": "v3.1",
            "spec_date": "2025-10-31",
            "applicable": False,
            "checklist": _build_checklist([], applicable=False),
        }
        return errors, warnings, metadata

    supplier_siren = _siren_from_entity(supplier)
    if not supplier_siren:
        _add_issue(
            issues,
            level="error",
            code="supplier_siren_missing",
            field="supplier.siren",
            message="SIREN fournisseur requis pour une facture FR B2B.",
            section="supplier_identity",
        )
    elif len(supplier_siren) != 9:
        _add_issue(
            issues,
            level="error",
            code="supplier_siren_invalid",
            field="supplier.siren",
            message="SIREN fournisseur invalide (9 chiffres requis).",
            section="supplier_identity",
        )

    customer_siren = _siren_from_entity(customer)
    if not customer_siren:
        _add_issue(
            issues,
            level="error",
            code="customer_siren_missing",
            field="customer.siren",
            message="SIREN client requis pour une facture FR B2B.",
            section="customer_identity",
        )
    elif len(customer_siren) != 9:
        _add_issue(
            issues,
            level="error",
            code="customer_siren_invalid",
            field="customer.siren",
            message="SIREN client invalide (9 chiffres requis).",
            section="customer_identity",
        )

    invoice_number = (_get_value(invoice, "number", None) or _get_value(invoice, "invoice_number", None) or "").strip()
    if not invoice_number:
        _add_issue(
            issues,
            level="error",
            code="invoice_number_missing",
            field="invoice.number",
            message="Numero de facture manquant.",
            section="invoice_core",
        )

    issue_date = _get_value(invoice, "issue_date", None)
    if not issue_date:
        _add_issue(
            issues,
            level="error",
            code="invoice_issue_date_missing",
            field="invoice.issue_date",
            message="Date de facture manquante.",
            section="invoice_core",
        )

    currency = (_get_value(invoice, "currency", None) or "").strip()
    if not currency:
        _add_issue(
            issues,
            level="error",
            code="invoice_currency_missing",
            field="invoice.currency",
            message="Devise de facture manquante.",
            section="invoice_core",
        )

    operation_nature = (_get_value(invoice, "operation_nature", None) or "").strip().lower()
    if operation_nature not in _ALLOWED_OPERATION_NATURES:
        _add_issue(
            issues,
            level="error",
            code="invoice_operation_nature_missing",
            field="invoice.operation_nature",
            message="Nature d'operation requise (LB/PS/LBPS ou goods/services/mixed).",
            section="invoice_core",
        )

    total_ex_vat = _decimal_or_none(_get_value(invoice, "total_ex_vat", None))
    total_vat = _decimal_or_none(_get_value(invoice, "total_vat", None))
    total_inc_vat = _decimal_or_none(_get_value(invoice, "total_inc_vat", None))

    if total_ex_vat is None:
        _add_issue(
            issues,
            level="error",
            code="invoice_total_ex_vat_missing",
            field="invoice.total_ex_vat",
            message="Montant HT manquant.",
            section="totals",
        )
    if total_vat is None:
        _add_issue(
            issues,
            level="error",
            code="invoice_total_vat_missing",
            field="invoice.total_vat",
            message="Montant TVA manquant.",
            section="totals",
        )
    if total_inc_vat is None:
        _add_issue(
            issues,
            level="error",
            code="invoice_total_inc_vat_missing",
            field="invoice.total_inc_vat",
            message="Montant TTC manquant.",
            section="totals",
        )

    invoice_type = (_get_value(invoice, "type", None) or "invoice").strip().lower()
    if invoice_type != "credit_note":
        if total_ex_vat is not None and total_ex_vat < 0:
            _add_issue(
                issues,
                level="error",
                code="invoice_total_ex_vat_negative",
                field="invoice.total_ex_vat",
                message="Montant HT negatif.",
                section="totals",
            )
        if total_vat is not None and total_vat < 0:
            _add_issue(
                issues,
                level="error",
                code="invoice_total_vat_negative",
                field="invoice.total_vat",
                message="Montant TVA negatif.",
                section="totals",
            )
        if total_inc_vat is not None and total_inc_vat < 0:
            _add_issue(
                issues,
                level="error",
                code="invoice_total_inc_vat_negative",
                field="invoice.total_inc_vat",
                message="Montant TTC negatif.",
                section="totals",
            )

    if total_ex_vat is not None and total_vat is not None and total_inc_vat is not None:
        expected_ttc = quantize_amount(total_ex_vat + total_vat)
        if quantize_amount(total_inc_vat) != expected_ttc:
            _add_issue(
                issues,
                level="error",
                code="invoice_total_inc_vat_mismatch",
                field="invoice.total_inc_vat",
                message="Montant TTC doit etre egal a HT + TVA.",
                section="totals",
            )

    supplier_vat_exemption_reason = _supplier_has_vat_exemption_reason(supplier)
    line_totals_sum = Decimal("0")
    line_vat_sum = Decimal("0")
    for idx, line in enumerate(lines or [], start=1):
        line_total = _line_total(line)
        line_totals_sum += line_total
        rate = to_decimal(_get_value(line, "vat_rate", 0))
        line_vat_sum += calc_tax_amount(line_total, rate)
        vat_category = (_get_value(line, "vat_category", "S") or "S").strip().upper()
        exemption_code = (_get_value(line, "exemption_reason_code", "") or "").strip()
        if (rate == 0 or vat_category != "S") and not exemption_code and not supplier_vat_exemption_reason:
            _add_issue(
                issues,
                level="error",
                code="line_exemption_reason_missing",
                field=f"lines[{idx}].exemption_reason_code",
                message="Motif d'exoneration TVA requis pour cette ligne.",
                section="vat_exemption",
                severity="p1",
            )

    if total_ex_vat is not None and (lines or []):
        if quantize_amount(total_ex_vat) != quantize_amount(line_totals_sum):
            _add_issue(
                issues,
                level="error",
                code="invoice_total_ex_vat_mismatch",
                field="invoice.total_ex_vat",
                message="Montant HT ne correspond pas a la somme des lignes.",
                section="totals",
            )
    if total_vat is not None and (lines or []):
        if quantize_amount(total_vat) != quantize_amount(line_vat_sum):
            _add_issue(
                issues,
                level="error",
                code="invoice_total_vat_mismatch",
                field="invoice.total_vat",
                message="Montant TVA ne correspond pas a la somme des lignes.",
                section="totals",
            )

    for issue in issues:
        message = issue.get("message") or ""
        if issue.get("field"):
            entry = f"{issue.get('field')}: {message}"
        else:
            entry = message
        if not entry:
            continue
        if issue.get("level") == "warning":
            warnings.append(entry)
        else:
            errors.append(entry)

    metadata = {
        "spec": "fr_specs_v31",
        "spec_version": "v3.1",
        "spec_date": "2025-10-31",
        "applicable": True,
        "checklist": _build_checklist(issues, applicable=True),
        "operation_nature_codes": dict(_OPERATION_NATURE_CODES),
    }
    return errors, warnings, metadata
