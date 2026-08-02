from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    BackgroundJob,
    Customer,
    EmailEvent,
    EInvoiceTransmission,
    InboundInvoice,
    Invoice,
    Quote,
    Tenant,
    User,
)
from .storage import storage_integrity_info


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _count(query) -> int:
    return int(query.scalar() or 0)


def build_tenant_health(db: Session, tenant_id: str) -> dict[str, Any]:
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        return {"found": False}
    since = _utcnow() - timedelta(days=7)
    users_total = _count(db.query(func.count(User.id)).filter(User.tenant_id == tenant_id))
    admins_without_mfa = 0
    if settings.MFA_ENFORCE_PLATFORM_ADMINS:
        admins_without_mfa = _count(
            db.query(func.count(User.id)).filter(
                User.tenant_id == tenant_id,
                or_(User.is_admin.is_(True), User.is_platform_admin.is_(True)),
                User.mfa_enabled.is_(False),
            )
        )
    invoice_failures = _count(
        db.query(func.count(EInvoiceTransmission.id)).filter(
            EInvoiceTransmission.tenant_id == tenant_id,
            EInvoiceTransmission.status.in_(["failed", "rejected", "error"]),
            EInvoiceTransmission.created_at >= since,
        )
    )
    email_failures = _count(
        db.query(func.count(EmailEvent.id)).filter(
            EmailEvent.tenant_id == tenant_id,
            EmailEvent.status.in_(["failed", "bounced", "rejected"]),
            EmailEvent.created_at >= since,
        )
    )
    failed_jobs = _count(
        db.query(func.count(BackgroundJob.id)).filter(
            BackgroundJob.tenant_id == tenant_id,
            BackgroundJob.status == "failed",
            BackgroundJob.created_at >= since,
        )
    )
    open_invoices = _count(
        db.query(func.count(Invoice.id)).filter(
            Invoice.tenant_id == tenant_id,
            Invoice.status.in_(["sent", "overdue"]),
        )
    )
    draft_invoices = _count(db.query(func.count(Invoice.id)).filter(Invoice.tenant_id == tenant_id, Invoice.status == "draft"))
    pending_quotes = _count(
        db.query(func.count(Quote.id)).filter(Quote.tenant_id == tenant_id, Quote.status.in_(["draft", "sent", "accepted"]))
    )
    purchases_to_complete = _count(
        db.query(func.count(InboundInvoice.id)).filter(
            InboundInvoice.tenant_id == tenant_id,
            InboundInvoice.status.in_(["received", "draft", "to_complete"]),
        )
    )
    customers_without_siret = _count(
        db.query(func.count(Customer.id)).filter(
            Customer.tenant_id == tenant_id,
            Customer.client_type.in_(["business", "public"]),
            Customer.siret.is_(None),
        )
    )
    blockers: list[dict[str, Any]] = []
    if admins_without_mfa:
        blockers.append(
            {
                "code": "admins_without_mfa",
                "count": admins_without_mfa,
                "label": "Administrateurs plateforme sans MFA",
            }
        )
    if invoice_failures:
        blockers.append({"code": "einvoicing_failures_7d", "count": invoice_failures, "label": "Transmissions en échec sur 7 jours"})
    if email_failures:
        blockers.append({"code": "email_failures_7d", "count": email_failures, "label": "Emails en échec sur 7 jours"})
    if failed_jobs:
        blockers.append({"code": "failed_jobs_7d", "count": failed_jobs, "label": "Jobs échoués sur 7 jours"})
    return {
        "found": True,
        "tenant": {
            "id": tenant.id,
            "name": tenant.name,
            "plan": tenant.plan,
            "subscription_status": tenant.subscription_status,
            "created_at": tenant.created_at.isoformat() if tenant.created_at else None,
        },
        "users": {"total": users_total, "admins_without_mfa": admins_without_mfa},
        "documents": {
            "open_invoices": open_invoices,
            "draft_invoices": draft_invoices,
            "pending_quotes": pending_quotes,
            "purchases_to_complete": purchases_to_complete,
            "customers_without_siret": customers_without_siret,
        },
        "operations_7d": {
            "einvoicing_failures": invoice_failures,
            "email_failures": email_failures,
            "failed_jobs": failed_jobs,
        },
        "storage": storage_integrity_info(),
        "blockers": blockers,
        "status": "attention_required" if blockers else "ok",
    }
