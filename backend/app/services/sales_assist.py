from __future__ import annotations

from collections import Counter
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from ..models import Customer, Invoice, InvoiceLine, Product, Quote, QuoteLine, Tenant
from .sales_document_defaults import (
    default_quote_valid_until,
    default_sales_accounting_account,
    due_days_from_terms,
    sales_payment_terms,
)


def _to_float(value: object | None) -> float:
    try:
        return float(Decimal(str(value or 0)))
    except Exception:
        return 0.0


def _line_payload(line: InvoiceLine | QuoteLine, product: Product | None = None) -> dict[str, Any]:
    return {
        "product_name": getattr(line, "product_name", None) or getattr(product, "name", None),
        "detail": getattr(line, "detail", None) or getattr(product, "description", None),
        "quantity": _to_float(getattr(line, "quantity", 1)),
        "unit_price": _to_float(getattr(line, "unit_price", None) or getattr(product, "unit_price", 0)),
        "vat_rate": _to_float(getattr(line, "vat_rate", None) or getattr(product, "vat_rate", 20)),
        "vat_category": getattr(line, "vat_category", None) or "S",
        "unit_code": getattr(line, "unit_code", None) or getattr(product, "unit_code", None) or "C62",
        "item_id": getattr(line, "item_id", None) or getattr(product, "id", None),
        "accounting_account": getattr(line, "accounting_account", None),
    }


def customer_sales_habits(db: Session, tenant_id: str, customer_id: str) -> dict[str, Any]:
    customer = db.get(Customer, customer_id)
    if not customer or customer.tenant_id != tenant_id:
        return {"reason": "customer_not_found", "confidence": 0.0}

    invoices = (
        db.query(Invoice)
        .filter(Invoice.tenant_id == tenant_id, Invoice.customer_id == customer_id, Invoice.type == "invoice")
        .order_by(Invoice.issue_date.desc(), Invoice.created_at.desc())
        .limit(20)
        .all()
    )
    quotes = (
        db.query(Quote)
        .filter(Quote.tenant_id == tenant_id, Quote.customer_id == customer_id)
        .order_by(Quote.issue_date.desc(), Quote.created_at.desc())
        .limit(20)
        .all()
    )
    payment_terms = [
        value
        for value in [*(invoice.payment_terms for invoice in invoices), *(quote.payment_terms for quote in quotes)]
        if value
    ]
    due_days = [invoice.due_days for invoice in invoices if invoice.due_days is not None]
    accounts: list[str] = []
    invoice_ids = [invoice.id for invoice in invoices]
    quote_ids = [quote.id for quote in quotes]
    if invoice_ids:
        accounts.extend(
            row[0]
            for row in db.query(InvoiceLine.accounting_account)
            .filter(InvoiceLine.invoice_id.in_(invoice_ids), InvoiceLine.accounting_account.isnot(None))
            .all()
            if row[0]
        )
    if quote_ids:
        accounts.extend(
            row[0]
            for row in db.query(QuoteLine.accounting_account)
            .filter(QuoteLine.quote_id.in_(quote_ids), QuoteLine.accounting_account.isnot(None))
            .all()
            if row[0]
        )

    return {
        "invoice_count": len(invoices),
        "quote_count": len(quotes),
        "payment_terms": Counter(payment_terms).most_common(1)[0][0] if payment_terms else None,
        "due_days": Counter(due_days).most_common(1)[0][0] if due_days else None,
        "sales_account": Counter(accounts).most_common(1)[0][0] if accounts else None,
        "reason": "customer_history" if invoices or quotes else "tenant_defaults",
        "confidence": 0.8 if invoices or quotes else 0.5,
    }


def suggest_payment_terms(db: Session, tenant_id: str, customer_id: str) -> dict[str, Any]:
    tenant = db.get(Tenant, tenant_id)
    customer = db.get(Customer, customer_id)
    if not tenant or not customer or customer.tenant_id != tenant_id:
        return {"value": "30 jours date de facture", "source": "fallback", "confidence": 0.4}
    if customer.payment_terms_default:
        return {"value": customer.payment_terms_default, "source": "customer_default", "confidence": 0.9}
    habits = customer_sales_habits(db, tenant_id, customer_id)
    if habits.get("payment_terms"):
        return {"value": habits["payment_terms"], "source": "customer_history", "confidence": 0.8}
    return {"value": sales_payment_terms(None, customer), "source": "fallback", "confidence": 0.55}


def suggest_validity_days(db: Session, tenant_id: str, customer_id: str) -> dict[str, Any]:
    terms = suggest_payment_terms(db, tenant_id, customer_id)
    return {
        "value": due_days_from_terms(terms.get("value"), 30),
        "source": terms.get("source"),
        "confidence": terms.get("confidence", 0.5),
    }


def suggest_sales_account(db: Session, tenant_id: str, customer_id: str) -> dict[str, Any]:
    tenant = db.get(Tenant, tenant_id)
    habits = customer_sales_habits(db, tenant_id, customer_id)
    if habits.get("sales_account"):
        return {"value": habits["sales_account"], "source": "customer_history", "confidence": 0.75}
    return {
        "value": default_sales_accounting_account(tenant, "services"),
        "source": "tenant_default" if tenant and tenant.fec_account_revenue else "fallback",
        "confidence": 0.6,
    }


def suggest_lines_for_customer(db: Session, tenant_id: str, customer_id: str, limit: int = 5) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    invoices = (
        db.query(InvoiceLine)
        .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
        .filter(Invoice.tenant_id == tenant_id, Invoice.customer_id == customer_id, InvoiceLine.line_type == "item")
        .order_by(Invoice.issue_date.desc(), Invoice.created_at.desc())
        .limit(limit)
        .all()
    )
    for line in invoices:
        lines.append({"source": "invoice_history", "confidence": 0.75, "line": _line_payload(line)})
    if len(lines) < limit:
        quotes = (
            db.query(QuoteLine)
            .join(Quote, Quote.id == QuoteLine.quote_id)
            .filter(Quote.tenant_id == tenant_id, Quote.customer_id == customer_id, QuoteLine.line_type == "item")
            .order_by(Quote.issue_date.desc(), Quote.created_at.desc())
            .limit(limit - len(lines))
            .all()
        )
        for line in quotes:
            lines.append({"source": "quote_history", "confidence": 0.7, "line": _line_payload(line)})
    return lines[:limit]


def suggest_document_defaults(
    db: Session,
    tenant_id: str,
    customer_id: str,
    document_type: str,
) -> dict[str, Any]:
    payment_terms = suggest_payment_terms(db, tenant_id, customer_id)
    due_days = due_days_from_terms(payment_terms.get("value"), 30)
    validity = suggest_validity_days(db, tenant_id, customer_id)
    sales_account = suggest_sales_account(db, tenant_id, customer_id)
    return {
        "document_type": document_type,
        "suggested_payment_terms": payment_terms.get("value"),
        "suggested_due_days": due_days,
        "suggested_valid_until_days": validity.get("value"),
        "suggested_valid_until": default_quote_valid_until(date.today(), payment_terms.get("value")).isoformat()
        if document_type == "quote"
        else None,
        "suggested_sales_account": sales_account.get("value"),
        "suggested_lines": suggest_lines_for_customer(db, tenant_id, customer_id),
        "reason": payment_terms.get("source") or sales_account.get("source") or "fallback",
        "confidence": max(float(payment_terms.get("confidence") or 0), float(sales_account.get("confidence") or 0)),
    }
