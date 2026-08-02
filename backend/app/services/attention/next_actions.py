from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ...models import Customer, InboundInvoice, Invoice, Quote


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _money(value: object) -> float:
    return float(Decimal(str(value or 0)))


def _invoice_action(invoice: Invoice) -> dict[str, Any]:
    due = invoice.due_date.date().isoformat() if getattr(invoice.due_date, "date", None) else None
    return {
        "kind": "invoice",
        "id": invoice.id,
        "label": invoice.number or "Facture sans numéro",
        "status": invoice.status,
        "priority": "high" if invoice.status == "overdue" else "medium",
        "amount_ttc": _money(invoice.total_inc_vat),
        "due_date": due,
        "action": "Relancer ou enregistrer le paiement",
    }


def _quote_action(quote: Quote) -> dict[str, Any]:
    return {
        "kind": "quote",
        "id": quote.id,
        "label": quote.number or "Devis sans numéro",
        "status": quote.status,
        "priority": "high" if quote.status == "accepted" else "medium",
        "amount_ttc": _money(quote.total_inc_vat),
        "valid_until": quote.valid_until.isoformat() if quote.valid_until else None,
        "action": "Créer la facture" if quote.status == "accepted" else "Suivre le devis",
    }


def _purchase_action(purchase: InboundInvoice) -> dict[str, Any]:
    return {
        "kind": "purchase",
        "id": purchase.id,
        "label": purchase.invoice_number or purchase.supplier_name or "Achat fournisseur",
        "status": purchase.status,
        "priority": "medium",
        "amount_ttc": _money(purchase.total_ttc),
        "received_at": purchase.received_at.isoformat() if purchase.received_at else None,
        "action": "Choisir un compte comptable définitif",
    }


def _customer_action(customer: Customer) -> dict[str, Any]:
    return {
        "kind": "customer",
        "id": customer.id,
        "label": customer.name,
        "status": "incomplete",
        "priority": "low",
        "action": "Compléter les identifiants client",
    }


def today_actions(
    db: Session,
    tenant_id: str,
    *,
    limit: int = 50,
    include_payments: bool = True,
    include_purchases: bool = True,
) -> list[dict[str, Any]]:
    today = _today()
    today_start = datetime.combine(today, datetime.min.time())
    remaining = max(1, min(int(limit), 200))
    actions: list[dict[str, Any]] = []
    invoices: list[Invoice] = []
    if include_payments:
        invoices = (
            db.query(Invoice)
            .filter(
                Invoice.tenant_id == tenant_id,
                Invoice.type == "invoice",
                or_(
                    Invoice.status == "overdue",
                    and_(
                        Invoice.status.in_(["issued", "sent", "partial"]),
                        Invoice.due_date.isnot(None),
                        Invoice.due_date < today_start,
                    ),
                ),
            )
            .order_by(Invoice.due_date.asc().nullslast(), Invoice.issue_date.desc())
            .limit(remaining)
            .all()
        )
    actions.extend(_invoice_action(invoice) for invoice in invoices)
    remaining = max(0, limit - len(actions))
    if remaining:
        quotes = (
            db.query(Quote)
            .filter(Quote.tenant_id == tenant_id, Quote.status == "accepted", Quote.invoice_id.is_(None))
            .order_by(Quote.accepted_at.desc().nullslast(), Quote.valid_until.asc().nullslast())
            .limit(remaining)
            .all()
        )
        actions.extend(_quote_action(quote) for quote in quotes)
    remaining = max(0, limit - len(actions))
    if remaining and include_purchases:
        account_key = func.upper(func.replace(func.coalesce(InboundInvoice.accounting_account, ""), " ", ""))
        purchases = (
            db.query(InboundInvoice)
            .filter(
                InboundInvoice.tenant_id == tenant_id,
                InboundInvoice.status.in_(["received", "draft", "to_complete"]),
                account_key.like("471%"),
            )
            .order_by(InboundInvoice.received_at.desc().nullslast())
            .limit(remaining)
            .all()
        )
        actions.extend(_purchase_action(purchase) for purchase in purchases)
    remaining = max(0, limit - len(actions))
    if remaining:
        customers = (
            db.query(Customer)
            .filter(
                Customer.tenant_id == tenant_id,
                Customer.client_type.in_(["business", "public"]),
                func.length(func.trim(func.coalesce(Customer.siret, ""))) == 0,
            )
            .order_by(Customer.created_at.desc())
            .limit(remaining)
            .all()
        )
        actions.extend(_customer_action(customer) for customer in customers)
    return actions[:limit]


def action_counts(
    db: Session,
    tenant_id: str,
    *,
    include_payments: bool = True,
    include_purchases: bool = True,
) -> dict[str, int]:
    actions = today_actions(
        db,
        tenant_id,
        limit=200,
        include_payments=include_payments,
        include_purchases=include_purchases,
    )
    counts = {"total": len(actions), "invoice": 0, "quote": 0, "purchase": 0, "customer": 0}
    for action in actions:
        kind = str(action.get("kind") or "")
        if kind in counts:
            counts[kind] += 1
    return counts
