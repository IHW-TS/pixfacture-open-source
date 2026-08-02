from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_viewer_or_admin
from ..models import ActionLog, Customer, Invoice, Quote, Tenant, User
from ..services.product_capabilities import is_product_feature_enabled
from ..utils.pii import mask_email


router = APIRouter(prefix="/api/activity", tags=["activity"])

_PAYMENT_ACTIVITY_ENTITIES = {"payment", "credit_note_refund", "refund"}
_PURCHASE_ACTIVITY_ENTITIES = {
    "inbound_invoice",
    "purchase",
    "purchase_invoice",
    "purchase_payment",
    "purchase_supplier",
}


class ActivityItem(BaseModel):
    id: str
    at: datetime
    actor: str | None = None
    entity: str
    entity_id: str
    action: str
    title: str
    subtitle: str | None = None
    url: str | None = None


class ActivityResponse(BaseModel):
    items: list[ActivityItem]


def _humanize_action(action: str) -> str:
    a = (action or "").strip()
    if not a:
        return "Action"
    return a.replace(".", " ").replace("_", " ").strip()


def _activity_allowed(
    log_entry: ActionLog,
    *,
    purchases_enabled: bool,
    payments_enabled: bool,
) -> bool:
    entity = str(log_entry.entity or "").strip().lower()
    action = str(log_entry.action or "").strip().lower()
    if not payments_enabled and entity in _PAYMENT_ACTIVITY_ENTITIES:
        return False
    if not payments_enabled and (
        action == "remind" or any(token in action for token in ("payment", "refund", "followup"))
    ):
        return False
    if not purchases_enabled and entity in _PURCHASE_ACTIVITY_ENTITIES:
        return False
    return True


@router.get("/recent", response_model=ActivityResponse)
def recent_activity(
    limit: int = Query(20, ge=5, le=100),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    purchases_enabled = is_product_feature_enabled(tenant, "purchases_enabled")
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    candidate_logs = (
        db.query(ActionLog)
        .filter(ActionLog.tenant_id == user.tenant_id)
        .order_by(ActionLog.created_at.desc())
        .limit(limit * 3)
        .all()
    )
    logs = [
        row
        for row in candidate_logs
        if _activity_allowed(
            row,
            purchases_enabled=purchases_enabled,
            payments_enabled=payments_enabled,
        )
    ][:limit]
    if not logs:
        return ActivityResponse(items=[])

    # Bulk fetch names/numbers
    invoice_ids = [log_entry.entity_id for log_entry in logs if log_entry.entity in {"invoice", "credit_note"}]
    quote_ids = [log_entry.entity_id for log_entry in logs if log_entry.entity == "quote"]
    customer_ids = [log_entry.entity_id for log_entry in logs if log_entry.entity == "customer"]
    user_ids = [log_entry.user_id for log_entry in logs if log_entry.user_id]

    invoices = (
        {
            invoice.id: invoice
            for invoice in db.query(Invoice)
            .filter(Invoice.tenant_id == user.tenant_id, Invoice.id.in_(invoice_ids))
            .all()
        }
        if invoice_ids
        else {}
    )
    quotes = (
        {
            quote.id: quote
            for quote in db.query(Quote).filter(Quote.tenant_id == user.tenant_id, Quote.id.in_(quote_ids)).all()
        }
        if quote_ids
        else {}
    )
    customers = (
        {
            customer.id: customer
            for customer in db.query(Customer)
            .filter(Customer.tenant_id == user.tenant_id, Customer.id.in_(customer_ids))
            .all()
        }
        if customer_ids
        else {}
    )
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}

    items: list[ActivityItem] = []
    for log_entry in logs:
        actor = None
        if log_entry.user_id and log_entry.user_id in users:
            actor = mask_email(getattr(users[log_entry.user_id], "email", None))

        title = _humanize_action(log_entry.action)
        subtitle = None
        url = None

        if log_entry.entity in {"invoice", "credit_note"}:
            inv = invoices.get(log_entry.entity_id)
            if inv:
                doc_label = "Avoir" if inv.type == "credit_note" else "Facture"
                title = f"{doc_label} {inv.number or ''}: {title}".strip()
                url = f"/app/invoices/{inv.id}"
        elif log_entry.entity == "quote":
            qt = quotes.get(log_entry.entity_id)
            if qt:
                title = f"Devis {qt.number or ''}: {title}".strip()
                url = f"/app/quotes/{qt.id}"
        elif log_entry.entity == "customer":
            c = customers.get(log_entry.entity_id)
            if c:
                title = f"Client {(c.name or '').strip()}: {title}".strip()
                url = f"/app/customers/{c.id}"

        items.append(
            ActivityItem(
                id=log_entry.id,
                at=log_entry.created_at,
                actor=actor,
                entity=log_entry.entity,
                entity_id=log_entry.entity_id,
                action=log_entry.action,
                title=title,
                subtitle=subtitle,
                url=url,
            )
        )
    return ActivityResponse(items=items)
