from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Customer, Invoice, InvoiceLine, Quote, QuoteLine, Tenant
from ..utils.unit_codes import normalize_unit_code
from .cii import normalize_facturx_profile
from .sales_document_defaults import (
    apply_template_option_defaults,
    compute_due_datetime,
    default_quote_valid_until,
    default_sales_accounting_account,
    due_days_from_terms,
    line_accounting_account,
    sales_payment_terms,
)


def _text(value: object | None) -> str:
    return str(value or "").strip()


def _blank(value: object | None) -> bool:
    return not _text(value)


def _amount(value: object | None) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _line_has_amount(line: InvoiceLine | QuoteLine) -> bool:
    return _amount(getattr(line, "line_total", None)).copy_abs() > Decimal("0.0001")


def _is_item(line: InvoiceLine | QuoteLine) -> bool:
    return _text(getattr(line, "line_type", None) or "item").lower() == "item"


def _public_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


def _change(
    field: str,
    before: Any,
    after: Any,
    *,
    source: str,
    confidence: float,
    reason: str,
) -> dict[str, Any]:
    return {
        "field": field,
        "before": _public_value(before),
        "after": _public_value(after),
        "source": source,
        "confidence": confidence,
        "reason": reason,
    }


def _append_change(
    changes: list[dict[str, Any]],
    field: str,
    before: Any,
    after: Any,
    *,
    source: str,
    confidence: float,
    reason: str,
) -> None:
    if before == after:
        return
    changes.append(
        _change(field, before, after, source=source, confidence=confidence, reason=reason)
    )


def auto_fix_applied_fields(changes: list[dict[str, Any]]) -> list[str]:
    """Return detailed fields plus legacy aliases consumed by older callers."""
    fields: list[str] = []
    for change in changes:
        field = str(change.get("field") or "")
        if not field:
            continue
        fields.append(field)
        if field.startswith("lines.") and field.endswith(".accounting_account"):
            fields.append("line_accounting_account")
        elif field.startswith("lines.") and field.endswith(".unit_code"):
            fields.append("line_unit_code")
        elif field.startswith("template_options."):
            fields.append(field.split(".", 1)[1])
    return list(dict.fromkeys(fields))


def _default_facturx_profile() -> str:
    return normalize_facturx_profile(getattr(settings, "FACTURX_PROFILE", None))


def _invoice_lines(db: Session, invoice: Invoice) -> list[InvoiceLine]:
    return db.query(InvoiceLine).filter(InvoiceLine.invoice_id == invoice.id).order_by(InvoiceLine.id.asc()).all()


def _quote_lines(db: Session, quote: Quote) -> list[QuoteLine]:
    return db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).order_by(QuoteLine.id.asc()).all()


def propose_invoice_autofix(db: Session, tenant_id: str, invoice: Invoice) -> list[dict[str, Any]]:
    tenant = db.get(Tenant, tenant_id)
    customer = db.get(Customer, invoice.customer_id) if invoice.customer_id else None
    if not tenant or not customer:
        return []
    changes: list[dict[str, Any]] = []

    payment_terms = sales_payment_terms(invoice.payment_terms, customer)
    if _blank(invoice.payment_terms) and payment_terms:
        _append_change(
            changes,
            "payment_terms",
            invoice.payment_terms,
            payment_terms,
            source="customer_history" if _text(getattr(customer, "payment_terms_default", None)) else "fallback",
            confidence=0.85,
            reason="Conditions de paiement manquantes.",
        )

    effective_terms = payment_terms or invoice.payment_terms
    due_days = due_days_from_terms(effective_terms, invoice.due_days if invoice.due_days is not None else 30)
    if invoice.due_days is None:
        _append_change(
            changes,
            "due_days",
            invoice.due_days,
            due_days,
            source="document_rule",
            confidence=0.9,
            reason="Délai de paiement absent.",
        )

    if not bool(getattr(invoice, "due_date_manual", False)):
        computed_due = compute_due_datetime(invoice.issue_date, effective_terms, due_days)
        current_due = invoice.due_date.replace(microsecond=0) if invoice.due_date else None
        expected_due = computed_due.replace(microsecond=0) if computed_due else None
        if current_due != expected_due:
            _append_change(
                changes,
                "due_date",
                invoice.due_date,
                computed_due,
                source="document_rule",
                confidence=0.9,
                reason="Échéance absente ou incohérente avec les conditions de paiement.",
            )

    if _blank(invoice.operation_nature):
        _append_change(
            changes,
            "operation_nature",
            invoice.operation_nature,
            "services",
            source="fallback",
            confidence=0.7,
            reason="Nature de l'opération manquante.",
        )

    if _blank(invoice.issued_profile):
        _append_change(
            changes,
            "facturx_profile",
            invoice.issued_profile,
            _default_facturx_profile(),
            source="tenant_default",
            confidence=0.75,
            reason="Profil Factur-X absent.",
        )

    options = dict(invoice.template_options or {})
    defaulted_options, option_fixes = apply_template_option_defaults(
        options,
        tenant=tenant,
        customer=customer,
        operation_nature=invoice.operation_nature or "services",
    )
    expected_kind = invoice.invoice_kind or "standard"
    if _text(defaulted_options.get("kind")) != expected_kind:
        before = options.get("kind")
        defaulted_options["kind"] = expected_kind
        _append_change(
            changes,
            "template_options.kind",
            before,
            expected_kind,
            source="document_rule",
            confidence=0.95,
            reason="Type de facture incohérent dans les options du document.",
        )
    if invoice.quote_id and _text(defaulted_options.get("source_quote_id")) != invoice.quote_id:
        before = options.get("source_quote_id")
        defaulted_options["source_quote_id"] = invoice.quote_id
        _append_change(
            changes,
            "template_options.source_quote_id",
            before,
            invoice.quote_id,
            source="document_rule",
            confidence=0.95,
            reason="Lien devis source absent dans les options du document.",
        )
    for key in option_fixes:
        _append_change(
            changes,
            f"template_options.{key}",
            options.get(key),
            defaulted_options.get(key),
            source="tenant_default",
            confidence=0.8,
            reason="Option de document sûre absente.",
        )

    if bool(invoice.delivery_address_differs) and _blank(invoice.delivery_address):
        _append_change(
            changes,
            "delivery_address_differs",
            invoice.delivery_address_differs,
            False,
            source="document_rule",
            confidence=0.95,
            reason="L'adresse de livraison différente est activée sans adresse.",
        )

    default_account = default_sales_accounting_account(tenant, invoice.operation_nature)
    for line in _invoice_lines(db, invoice):
        if not _is_item(line):
            continue
        normalized_unit = normalize_unit_code(line.unit_code)
        if _blank(line.unit_code) or normalized_unit != str(line.unit_code or "").strip().upper().replace(" ", "").replace("-", ""):
            _append_change(
                changes,
                f"lines.{line.id}.unit_code",
                line.unit_code,
                normalized_unit,
                source="document_rule",
                confidence=0.95,
                reason="Code unité absent ou non accepté en e-facturation.",
            )
        if _line_has_amount(line):
            account, changed = line_accounting_account(
                line.accounting_account,
                tenant=tenant,
                operation_nature=invoice.operation_nature,
            )
            if changed and account:
                _append_change(
                    changes,
                    f"lines.{line.id}.accounting_account",
                    line.accounting_account,
                    account or default_account,
                    source="tenant_default" if getattr(tenant, "fec_account_revenue", None) else "fallback",
                    confidence=0.75,
                    reason="Catégorie compta de vente absente ou temporaire.",
                )
    return changes


def apply_invoice_autofix(
    db: Session,
    tenant_id: str,
    invoice: Invoice,
    actor_id: str | None = None,
) -> list[dict[str, Any]]:
    changes = propose_invoice_autofix(db, tenant_id, invoice)
    if not changes:
        return []
    line_map = {line.id: line for line in _invoice_lines(db, invoice)}
    options = dict(invoice.template_options or {})
    for change in changes:
        field = str(change["field"])
        value = change["after"]
        if field == "payment_terms":
            invoice.payment_terms = value
        elif field == "due_days":
            invoice.due_days = int(value)
        elif field == "due_date":
            invoice.due_date = datetime.fromisoformat(value) if isinstance(value, str) else value
        elif field == "operation_nature":
            invoice.operation_nature = value
        elif field == "facturx_profile":
            invoice.issued_profile = value
        elif field == "delivery_address_differs":
            invoice.delivery_address_differs = bool(value)
        elif field.startswith("template_options."):
            options[field.split(".", 1)[1]] = value
        elif field.startswith("lines."):
            _, line_id, line_field = field.split(".", 2)
            line = line_map.get(line_id)
            if not line:
                continue
            if line_field == "unit_code":
                line.unit_code = value
            elif line_field == "accounting_account":
                line.accounting_account = value
    invoice.template_options = options
    invoice.updated_by = actor_id
    db.add(invoice)
    for line in line_map.values():
        db.add(line)
    return changes


def propose_quote_autofix(db: Session, tenant_id: str, quote: Quote) -> list[dict[str, Any]]:
    tenant = db.get(Tenant, tenant_id)
    customer = db.get(Customer, quote.customer_id) if quote.customer_id else None
    if not tenant or not customer:
        return []
    changes: list[dict[str, Any]] = []

    payment_terms = sales_payment_terms(quote.payment_terms, customer)
    if _blank(quote.payment_terms) and payment_terms:
        _append_change(
            changes,
            "payment_terms",
            quote.payment_terms,
            payment_terms,
            source="customer_history" if _text(getattr(customer, "payment_terms_default", None)) else "fallback",
            confidence=0.85,
            reason="Conditions de paiement manquantes.",
        )

    if not quote.valid_until:
        _append_change(
            changes,
            "valid_until",
            quote.valid_until,
            default_quote_valid_until(quote.issue_date, payment_terms),
            source="document_rule",
            confidence=0.9,
            reason="Date de validité manquante.",
        )

    if _blank(quote.template_key):
        _append_change(
            changes,
            "template_key",
            quote.template_key,
            "classic",
            source="fallback",
            confidence=0.7,
            reason="Modèle de document absent.",
        )

    options = dict(quote.template_options or {})
    operation_nature = _text(options.get("operation_nature")) or "services"
    defaulted_options, option_fixes = apply_template_option_defaults(
        options,
        tenant=tenant,
        customer=customer,
        operation_nature=operation_nature,
    )
    if _blank(defaulted_options.get("operation_nature")):
        before = options.get("operation_nature")
        defaulted_options["operation_nature"] = "services"
        _append_change(
            changes,
            "template_options.operation_nature",
            before,
            "services",
            source="fallback",
            confidence=0.7,
            reason="Nature de l'opération manquante.",
        )
    for key in option_fixes:
        _append_change(
            changes,
            f"template_options.{key}",
            options.get(key),
            defaulted_options.get(key),
            source="tenant_default",
            confidence=0.8,
            reason="Option de document sûre absente.",
        )

    default_account = default_sales_accounting_account(tenant, operation_nature)
    for line in _quote_lines(db, quote):
        if not _is_item(line):
            continue
        normalized_unit = normalize_unit_code(line.unit_code)
        if _blank(line.unit_code) or normalized_unit != str(line.unit_code or "").strip().upper().replace(" ", "").replace("-", ""):
            _append_change(
                changes,
                f"lines.{line.id}.unit_code",
                line.unit_code,
                normalized_unit,
                source="document_rule",
                confidence=0.95,
                reason="Code unité absent ou non accepté en e-facturation.",
            )
        if _line_has_amount(line):
            account, changed = line_accounting_account(
                line.accounting_account,
                tenant=tenant,
                operation_nature=operation_nature,
            )
            if changed and account:
                _append_change(
                    changes,
                    f"lines.{line.id}.accounting_account",
                    line.accounting_account,
                    account or default_account,
                    source="tenant_default" if getattr(tenant, "fec_account_revenue", None) else "fallback",
                    confidence=0.75,
                    reason="Catégorie compta de vente absente ou temporaire.",
                )
    return changes


def apply_quote_autofix(
    db: Session,
    tenant_id: str,
    quote: Quote,
    actor_id: str | None = None,
) -> list[dict[str, Any]]:
    changes = propose_quote_autofix(db, tenant_id, quote)
    if not changes:
        return []
    line_map = {line.id: line for line in _quote_lines(db, quote)}
    options = dict(quote.template_options or {})
    for change in changes:
        field = str(change["field"])
        value = change["after"]
        if field == "payment_terms":
            quote.payment_terms = value
        elif field == "valid_until":
            quote.valid_until = date.fromisoformat(value) if isinstance(value, str) else value
        elif field == "template_key":
            quote.template_key = value
        elif field.startswith("template_options."):
            options[field.split(".", 1)[1]] = value
        elif field.startswith("lines."):
            _, line_id, line_field = field.split(".", 2)
            line = line_map.get(line_id)
            if not line:
                continue
            if line_field == "unit_code":
                line.unit_code = value
            elif line_field == "accounting_account":
                line.accounting_account = value
    quote.template_options = options
    quote.updated_by = actor_id
    db.add(quote)
    for line in line_map.values():
        db.add(line)
    return changes
