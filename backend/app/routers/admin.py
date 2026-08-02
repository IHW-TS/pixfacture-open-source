import csv
import io
import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from sqlalchemy.inspection import inspect as sa_inspect
from ..db import get_db
from ..models import (
    ActionLog,
    ApiKey,
    AuthSession,
    BillableEvent,
    Customer,
    EInvoiceTransmission,
    EInvoicingTransmission,
    EReportingEvent,
    EReportingReport,
    InboundInvoice,
    InboundInvoiceAttachment,
    InboundInvoiceEvent,
    Invoice,
    InvoiceLine,
    Membership,
    Payment,
    Product,
    PurchasePayment,
    PurchaseEmployeePayer,
    PurchaseSupplier,
    Quote,
    Tenant,
    TenantSettings,
    TokenLedger,
    UsageMetric,
    User,
)
from ..config import settings
from ..schemas import EReportingEventCreate, EReportingEventOut
from ..services.ereporting import ensure_ereporting_allowed, payload_hash_from_fields, resolve_provider_slug
from ..deps import require_platform_admin, AuthUser
from ..services.platform_admin import promote_platform_admin
from ..services.action_logs import log_action
from ..services.subscription_entitlements import grant_subscription_entitlements
from ..services.provider_token_inventory import ProviderTokenInventoryError
from ..services.document_attachments import get_used_bytes
from ..services.demo_invitations import DemoInvitationError, create_demo_invitation
from ..utils.public_errors import sanitize_public_error_message
from .customers import _find_duplicates

router = APIRouter(prefix="/api/admin", tags=["admin"])

_EXPORT_EXCLUDE_FIELDS = {
    "customers": {"portal_token"},
    "invoices": {"public_token"},
    "quotes": {"public_token", "accepted_ip", "accepted_user_agent"},
    "users": {
        "password_hash",
        "totp_secret",
        "mfa_secret",
        "mfa_recovery_codes",
        "reset_token",
        "reset_token_expires_at",
    },
}

_ACTIVE_SUBSCRIPTION_STATUSES = {"active", "trialing"}
_PLAN_MRR_CENTS = {
    "starter": 2900,
    "pro": 5900,
}


def _serialize_model(obj: object, exclude: set[str] | None = None) -> dict:
    mapper = sa_inspect(obj).mapper
    out: dict[str, object] = {}
    exclude = exclude or set()
    for col in mapper.column_attrs:
        key = col.key
        if key in exclude:
            continue
        value = getattr(obj, key)
        if isinstance(value, datetime):
            out[key] = value.isoformat()
        elif isinstance(value, date):
            out[key] = value.isoformat()
        elif isinstance(value, Decimal):
            out[key] = str(value)
        else:
            out[key] = value
    return out


def _export_payload(db: Session, tenant_id: str) -> dict[str, list[dict]]:
    specs = [
        ("tenant", db.query(Tenant).filter(Tenant.id == tenant_id), None),
        (
            "users",
            db.query(User).join(Membership, Membership.user_id == User.id).filter(Membership.tenant_id == tenant_id),
            _EXPORT_EXCLUDE_FIELDS.get("users"),
        ),
        ("memberships", db.query(Membership).filter(Membership.tenant_id == tenant_id), None),
        ("tenant_settings", db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id), None),
        (
            "customers",
            db.query(Customer).filter(Customer.tenant_id == tenant_id),
            _EXPORT_EXCLUDE_FIELDS.get("customers"),
        ),
        ("products", db.query(Product).filter(Product.tenant_id == tenant_id), None),
        ("invoices", db.query(Invoice).filter(Invoice.tenant_id == tenant_id), _EXPORT_EXCLUDE_FIELDS.get("invoices")),
        (
            "invoice_lines",
            db.query(InvoiceLine)
            .join(Invoice, InvoiceLine.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == tenant_id),
            None,
        ),
        (
            "payments",
            db.query(Payment).join(Invoice, Payment.invoice_id == Invoice.id).filter(Invoice.tenant_id == tenant_id),
            None,
        ),
        ("purchases", db.query(InboundInvoice).filter(InboundInvoice.tenant_id == tenant_id), None),
        (
            "purchase_payments",
            db.query(PurchasePayment)
            .join(InboundInvoice, PurchasePayment.inbound_invoice_id == InboundInvoice.id)
            .filter(InboundInvoice.tenant_id == tenant_id, PurchasePayment.tenant_id == tenant_id),
            None,
        ),
        ("purchase_suppliers", db.query(PurchaseSupplier).filter(PurchaseSupplier.tenant_id == tenant_id), None),
        (
            "purchase_employee_payers",
            db.query(PurchaseEmployeePayer).filter(PurchaseEmployeePayer.tenant_id == tenant_id),
            None,
        ),
        (
            "purchase_attachments",
            db.query(InboundInvoiceAttachment)
            .join(InboundInvoice, InboundInvoiceAttachment.inbound_invoice_id == InboundInvoice.id)
            .filter(InboundInvoice.tenant_id == tenant_id),
            None,
        ),
        (
            "purchase_events",
            db.query(InboundInvoiceEvent)
            .join(InboundInvoice, InboundInvoiceEvent.inbound_invoice_id == InboundInvoice.id)
            .filter(InboundInvoice.tenant_id == tenant_id),
            None,
        ),
        ("action_logs", db.query(ActionLog).filter(ActionLog.tenant_id == tenant_id), None),
        (
            "einvoicing_transmissions",
            db.query(EInvoicingTransmission)
            .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == tenant_id),
            None,
        ),
        ("ereporting_events", db.query(EReportingEvent).filter(EReportingEvent.tenant_id == tenant_id), None),
        ("ereporting_reports", db.query(EReportingReport).filter(EReportingReport.tenant_id == tenant_id), None),
    ]
    payload: dict[str, list[dict]] = {}
    for name, query, exclude in specs:
        rows = query.all()
        payload[name] = [_serialize_model(row, exclude) for row in rows]
    return payload


class TenantDeleteRequest(BaseModel):
    reason: str | None = None


class AdminPromoteRequest(BaseModel):
    email: EmailStr


class AdminDemoInvitationCreateRequest(BaseModel):
    email: EmailStr
    preset: str = "services"
    expires_in_hours: int = Field(default=72, ge=1, le=24 * 30)


class AdminSubscriptionUpdateRequest(BaseModel):
    plan: str
    subscription_status: str
    reason: str | None = None


def _normalize_period(value: str | None) -> str:
    raw = (value or "").strip()
    if raw:
        text = raw[:7]
        if len(text) == 7 and text[4] == "-" and text[:4].isdigit() and text[5:7].isdigit():
            year = int(text[:4])
            month = int(text[5:7])
            if 1 <= month <= 12 and year >= 2000:
                return f"{year:04d}-{month:02d}"
        raise ValueError("Période invalide (format attendu : AAAA-MM).")
    today = date.today()
    first_day = today.replace(day=1)
    prev_month = first_day - timedelta(days=1)
    return prev_month.strftime("%Y-%m")


def _as_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _extract_count(metrics: dict, keys: tuple[str, ...]) -> int:
    for key in keys:
        raw = metrics.get(key)
        if raw is None:
            continue
        if isinstance(raw, dict):
            for nested in ("count", "total", "items", "value"):
                if nested in raw:
                    return _as_int(raw.get(nested))
            continue
        return _as_int(raw)
    return 0


def _log(db: Session, tenant_id: str, actor_id: str | None, action: str, payload: dict | None = None):
    log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=actor_id,
        action_type=action,
        object_type="admin",
        object_id=tenant_id,
        metadata=payload,
    )


def _duplicate_count(db: Session, tenant_id: str) -> int:
    email_dup = (
        db.query(func.count(Customer.id))
        .filter(Customer.tenant_id == tenant_id)
        .filter(Customer.email.isnot(None), Customer.email != "")
        .group_by(func.lower(Customer.email))
        .having(func.count(Customer.id) > 1)
        .count()
    )
    siret_dup = (
        db.query(func.count(Customer.id))
        .filter(Customer.tenant_id == tenant_id)
        .filter(Customer.siret.isnot(None), Customer.siret != "")
        .group_by(func.lower(Customer.siret))
        .having(func.count(Customer.id) > 1)
        .count()
    )
    vat_dup = (
        db.query(func.count(Customer.id))
        .filter(Customer.tenant_id == tenant_id)
        .filter(Customer.vat_number.isnot(None), Customer.vat_number != "")
        .group_by(func.lower(Customer.vat_number))
        .having(func.count(Customer.id) > 1)
        .count()
    )
    return email_dup + siret_dup + vat_dup


def _distinct_tenant_ids(rows: list[tuple[str | None]]) -> set[str]:
    return {tenant_id for (tenant_id,) in rows if tenant_id}


@router.get("/business-metrics")
def admin_business_metrics(
    db: Session = Depends(get_db),
    _: AuthUser = Depends(require_platform_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    window_start = now - timedelta(days=30)

    tenants = db.query(Tenant).all()
    total_tenants = len(tenants)
    deleted_tenants = len([tenant for tenant in tenants if tenant.deleted_at is not None])
    current_tenants = [tenant for tenant in tenants if tenant.deleted_at is None]
    active_tenants = [
        tenant
        for tenant in current_tenants
        if (tenant.subscription_status or "").strip().lower() in _ACTIVE_SUBSCRIPTION_STATUSES
    ]
    mature_tenants = [tenant for tenant in tenants if (tenant.created_at or now) <= window_start]
    churned_30d_tenants = [
        tenant
        for tenant in tenants
        if tenant.deleted_at is not None
        and tenant.deleted_at >= window_start
        and (tenant.created_at or now) < window_start
    ]

    recent_activity_tenants = set()
    recent_activity_tenants |= _distinct_tenant_ids(
        db.query(Invoice.tenant_id)
        .filter(or_(Invoice.created_at >= window_start, Invoice.updated_at >= window_start))
        .distinct()
        .all()
    )
    recent_activity_tenants |= _distinct_tenant_ids(
        db.query(Quote.tenant_id)
        .filter(or_(Quote.created_at >= window_start, Quote.updated_at >= window_start))
        .distinct()
        .all()
    )
    recent_activity_tenants |= _distinct_tenant_ids(
        db.query(ActionLog.tenant_id).filter(ActionLog.created_at >= window_start).distinct().all()
    )
    recent_activity_tenants |= _distinct_tenant_ids(
        db.query(AuthSession.tenant_id)
        .filter(AuthSession.last_used_at.isnot(None), AuthSession.last_used_at >= window_start)
        .distinct()
        .all()
    )

    retained_30d_tenants = [
        tenant for tenant in mature_tenants if tenant.deleted_at is None and tenant.id in recent_activity_tenants
    ]

    connected_tenants_30d = set()
    connected_tenants_30d |= _distinct_tenant_ids(
        db.query(BillableEvent.tenant_id).filter(BillableEvent.occurred_at >= window_start).distinct().all()
    )
    connected_tenants_30d |= _distinct_tenant_ids(
        db.query(EInvoiceTransmission.tenant_id)
        .filter(EInvoiceTransmission.created_at >= window_start)
        .distinct()
        .all()
    )
    connected_tenants_30d |= _distinct_tenant_ids(
        db.query(Invoice.tenant_id)
        .join(EInvoicingTransmission, EInvoicingTransmission.invoice_id == Invoice.id)
        .filter(EInvoicingTransmission.created_at >= window_start)
        .distinct()
        .all()
    )

    token_active_tenants_30d = _distinct_tenant_ids(
        db.query(TokenLedger.tenant_id).filter(TokenLedger.created_at >= window_start).distinct().all()
    )
    api_active_tenants_30d = _distinct_tenant_ids(
        db.query(ApiKey.tenant_id)
        .filter(ApiKey.last_used_at.isnot(None), ApiKey.last_used_at >= window_start)
        .distinct()
        .all()
    )

    plan_counts = {
        "starter": len(
            [tenant for tenant in current_tenants if (tenant.plan or "starter").strip().lower() == "starter"]
        ),
        "pro": len([tenant for tenant in current_tenants if (tenant.plan or "starter").strip().lower() == "pro"]),
        "enterprise": len(
            [tenant for tenant in current_tenants if (tenant.plan or "starter").strip().lower() == "enterprise"]
        ),
    }
    active_plan_tenants = [
        tenant
        for tenant in current_tenants
        if (tenant.subscription_status or "").strip().lower() in _ACTIVE_SUBSCRIPTION_STATUSES
    ]
    active_starter = len(
        [tenant for tenant in active_plan_tenants if (tenant.plan or "starter").strip().lower() == "starter"]
    )
    active_pro = len([tenant for tenant in active_plan_tenants if (tenant.plan or "starter").strip().lower() == "pro"])
    active_enterprise = len(
        [tenant for tenant in active_plan_tenants if (tenant.plan or "starter").strip().lower() == "enterprise"]
    )

    mrr_estimate_cents = sum(
        _PLAN_MRR_CENTS.get((tenant.plan or "starter").strip().lower(), 0) for tenant in active_plan_tenants
    )
    starter_and_up = active_starter + active_pro + active_enterprise
    pro_conversion_rate = round(((active_pro + active_enterprise) / starter_and_up) * 100, 1) if starter_and_up else 0.0
    retention_30d_rate = round((len(retained_30d_tenants) / len(mature_tenants)) * 100, 1) if mature_tenants else 0.0
    churn_logo_30d_rate = round((len(churned_30d_tenants) / len(mature_tenants)) * 100, 1) if mature_tenants else 0.0

    providers_used_30d = int(
        db.query(func.count(func.distinct(BillableEvent.provider_slug)))
        .filter(BillableEvent.occurred_at >= window_start, BillableEvent.provider_slug.isnot(None))
        .scalar()
        or 0
    )
    transmissions_30d = int(
        db.query(func.count(EInvoiceTransmission.id)).filter(EInvoiceTransmission.created_at >= window_start).scalar()
        or 0
    ) + int(
        db.query(func.count(EInvoicingTransmission.id))
        .filter(EInvoicingTransmission.created_at >= window_start)
        .scalar()
        or 0
    )

    return {
        "generated_at": now.isoformat(),
        "window_start": window_start.isoformat(),
        "portfolio": {
            "tenants_total": total_tenants,
            "current_tenants": len(current_tenants),
            "deleted_tenants": deleted_tenants,
            "active_tenants": len(active_tenants),
            "mature_tenants": len(mature_tenants),
            "retained_30d_tenants": len(retained_30d_tenants),
            "retention_30d_rate": retention_30d_rate,
            "churned_30d_tenants": len(churned_30d_tenants),
            "churn_logo_30d_rate": churn_logo_30d_rate,
        },
        "plans": {
            "starter": plan_counts["starter"],
            "pro": plan_counts["pro"],
            "enterprise": plan_counts["enterprise"],
            "active_starter": active_starter,
            "active_pro": active_pro,
            "active_enterprise": active_enterprise,
            "conversion_starter_to_pro_rate": pro_conversion_rate,
            "mrr_estimate_cents": mrr_estimate_cents,
            "mrr_estimate_eur": float(Decimal(mrr_estimate_cents) / Decimal("100")),
            "mrr_estimate_scope": "starter_pro_only",
        },
        "connected": {
            "active_tenants_30d": len(connected_tenants_30d),
            "activation_rate_30d": round((len(connected_tenants_30d) / len(current_tenants)) * 100, 1)
            if current_tenants
            else 0.0,
            "providers_used_30d": providers_used_30d,
            "transmissions_30d": transmissions_30d,
        },
        "usage": {
            "active_tenants_30d": len(recent_activity_tenants),
            "token_active_tenants_30d": len(token_active_tenants_30d),
            "api_active_tenants_30d": len(api_active_tenants_30d),
        },
    }


@router.get("/tenants")
def list_tenants(db: Session = Depends(get_db), admin: AuthUser = Depends(require_platform_admin)):
    rows = (
        db.query(
            Tenant.id,
            Tenant.name,
            Tenant.plan,
            Tenant.subscription_status,
            Tenant.deleted_at,
            Tenant.created_at,
            func.count(func.distinct(Membership.id)).label("user_count"),
            func.count(func.distinct(Invoice.id)).label("invoice_count"),
        )
        .outerjoin(Membership, Membership.tenant_id == Tenant.id)
        .outerjoin(Invoice, Invoice.tenant_id == Tenant.id)
        .group_by(Tenant.id)
        .order_by(Tenant.created_at.desc())
        .all()
    )
    dup_counts = {}
    for r in rows:
        dup_counts[r.id] = _duplicate_count(db, r.id)
    return [
        {
            "id": r.id,
            "name": r.name,
            "plan": r.plan,
            "subscription_status": r.subscription_status,
            "deleted_at": r.deleted_at,
            "created_at": r.created_at,
            "user_count": r.user_count,
            "invoice_count": r.invoice_count,
            "duplicate_count": dup_counts.get(r.id, 0),
        }
        for r in rows
    ]


@router.post("/promote")
def promote_user(
    body: AdminPromoteRequest,
    db: Session = Depends(get_db),
    _: AuthUser = Depends(require_platform_admin),
):
    user = promote_platform_admin(db, body.email)
    if not user:
        raise HTTPException(status_code=404, detail={"code": "user_not_found", "message": "Utilisateur introuvable."})
    return {"ok": True, "user_id": user.id, "email": user.email, "is_admin": True}


@router.post("/demo-invitations")
def issue_demo_invitation(
    body: AdminDemoInvitationCreateRequest,
    response: Response,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_platform_admin),
):
    response.headers["Cache-Control"] = "no-store"
    try:
        issued = create_demo_invitation(
            db,
            email=str(body.email),
            preset=body.preset,
            ttl_hours=body.expires_in_hours,
            created_by_user_id=admin.id,
        )
        log_action(
            db,
            tenant_id=admin.tenant_id,
            actor_user_id=admin.id,
            action_type="demo_invitation_issued",
            object_type="demo_invitation",
            object_id=issued.invitation.id,
            metadata={
                "preset": issued.invitation.preset,
                "expires_at": issued.invitation.expires_at.isoformat(),
            },
        )
        db.commit()
        db.refresh(issued.invitation)
    except DemoInvitationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    return {
        "id": issued.invitation.id,
        "email": issued.invitation.email,
        "preset": issued.invitation.preset,
        "expires_at": issued.invitation.expires_at,
        "registration_url": issued.registration_url,
    }


@router.get("/tenants/{tenant_id}")
def tenant_detail(tenant_id: str, db: Session = Depends(get_db), admin: AuthUser = Depends(require_platform_admin)):
    t = db.get(Tenant, tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable.")
    user_count = db.query(func.count(Membership.id)).filter(Membership.tenant_id == tenant_id).scalar() or 0
    invoice_count = db.query(func.count(Invoice.id)).filter(Invoice.tenant_id == tenant_id).scalar() or 0
    return {
        "id": t.id,
        "name": t.name,
        "plan": t.plan,
        "subscription_status": t.subscription_status,
        "deleted_at": t.deleted_at,
        "created_at": t.created_at,
        "user_count": user_count,
        "invoice_count": invoice_count,
    }


@router.post("/tenants/{tenant_id}/subscription")
def update_tenant_subscription(
    tenant_id: str,
    payload: AdminSubscriptionUpdateRequest,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_platform_admin),
):
    t = db.get(Tenant, tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable.")
    plan = (payload.plan or "").strip().lower()
    status = (payload.subscription_status or "").strip().lower()
    if plan != "pro":
        raise HTTPException(400, "Le plan Pro est requis pour cette activation.")
    if status != "active":
        raise HTTPException(400, "Statut d’abonnement invalide : l’état actif est requis.")
    reason = (payload.reason or "").strip()
    old = {"plan": t.plan, "subscription_status": t.subscription_status}
    t.plan = plan
    t.subscription_status = status
    db.add(t)
    _log(
        db,
        tenant_id,
        admin.id,
        "tenant_subscription_update",
        {
            "old": old,
            "new": {"plan": plan, "subscription_status": status},
            "reason": reason or None,
        },
    )
    try:
        welcome_bonus_granted = grant_subscription_entitlements(
            db,
            t,
            require_welcome_grant=True,
        )
        db.commit()
    except ProviderTokenInventoryError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "pro_welcome_stock_unavailable",
                "message": (
                    "L'activation Pro est temporairement indisponible : "
                    "le bonus de bienvenue ne peut pas encore être garanti."
                ),
            },
        ) from exc
    return {
        "ok": True,
        "tenant_id": t.id,
        "plan": t.plan,
        "subscription_status": t.subscription_status,
        "welcome_bonus_granted": welcome_bonus_granted,
    }


@router.get("/tenants/{tenant_id}/export")
def export_tenant_data(
    tenant_id: str,
    format: str = Query(default="json"),
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_platform_admin),
):
    t = db.get(Tenant, tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable.")
    format = (format or "json").strip().lower()
    _log(db, tenant_id, admin.id, "tenant_export", {"format": format})
    db.commit()
    payload = _export_payload(db, tenant_id)
    filename = f"tenant-{tenant_id}-export.{format}"
    if format == "json":
        content = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str)
        return Response(
            content=content,
            media_type="application/json",
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )
    if format == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["entity", "id", "payload"])
        for entity, rows in payload.items():
            for row in rows:
                writer.writerow([entity, row.get("id", ""), json.dumps(row, ensure_ascii=True, default=str)])
        return Response(
            content=buffer.getvalue(),
            media_type="text/csv",
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )
    raise HTTPException(400, "Format d’export invalide. Choisissez JSON ou CSV.")


@router.post("/tenants/{tenant_id}/delete")
def delete_tenant(
    tenant_id: str,
    payload: TenantDeleteRequest | None = None,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_platform_admin),
):
    t = db.get(Tenant, tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable.")

    stripe_subscription_status = (t.subscription_status or "").strip().lower()
    stripe_subscription_linked = bool((t.stripe_subscription_id or "").strip())
    stripe_subscription_closed = stripe_subscription_status in {"canceled", "cancelled"}
    if not t.deleted_at and stripe_subscription_linked and not stripe_subscription_closed:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stripe_subscription_cancellation_required",
                "message": (
                    "Résiliez d’abord l’abonnement Stripe, attendez sa confirmation, "
                    "puis relancez la suppression. Aucun appel Stripe automatique n’a été effectué."
                ),
                "stripe_action_required": True,
                "stripe_cancellation_performed": False,
            },
        )

    reason = (payload.reason or "").strip() if payload else ""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    already_deleted = t.deleted_at is not None
    if not already_deleted:
        t.deleted_at = now
        t.deleted_reason = reason or None
    if (t.subscription_status or "").lower() != "inactive":
        t.subscription_status = "inactive"
    db.add(t)

    owned_users = (
        db.query(User)
        .filter(User.tenant_id == tenant_id)
        .with_for_update()
        .all()
    )
    owned_user_ids = [user.id for user in owned_users if user.id]
    users_disabled = 0
    token_versions_rotated = 0
    for user in owned_users:
        was_enabled = (user.status or "active").strip().lower() != "disabled"
        if not already_deleted or was_enabled:
            user.token_version = int(user.token_version or 0) + 1
            token_versions_rotated += 1
        if was_enabled:
            user.status = "disabled"
            users_disabled += 1
        db.add(user)

    session_filters = [AuthSession.tenant_id == tenant_id]
    if owned_user_ids:
        session_filters.append(AuthSession.user_id.in_(owned_user_ids))
    sessions_revoked = (
        db.query(AuthSession)
        .filter(or_(*session_filters), AuthSession.revoked_at.is_(None))
        .update({AuthSession.revoked_at: now}, synchronize_session=False)
    )
    api_keys_revoked = (
        db.query(ApiKey)
        .filter(ApiKey.tenant_id == tenant_id, ApiKey.revoked_at.is_(None))
        .update({ApiKey.revoked_at: now}, synchronize_session=False)
    )
    stripe_action_required = bool(stripe_subscription_linked and not stripe_subscription_closed)
    _log(
        db,
        tenant_id,
        admin.id,
        "tenant_soft_delete",
        {
            "deleted_at": t.deleted_at.isoformat(),
            "reason": reason,
            "already_deleted": already_deleted,
            "users_disabled": users_disabled,
            "token_versions_rotated": token_versions_rotated,
            "sessions_revoked": int(sessions_revoked or 0),
            "api_keys_revoked": int(api_keys_revoked or 0),
            "stripe_action_required": stripe_action_required,
            "stripe_cancellation_performed": False,
        },
    )
    db.commit()
    return {
        "ok": True,
        "tenant_id": t.id,
        "deleted_at": t.deleted_at.isoformat(),
        "already_deleted": already_deleted,
        "users_disabled": users_disabled,
        "token_versions_rotated": token_versions_rotated,
        "sessions_revoked": int(sessions_revoked or 0),
        "api_keys_revoked": int(api_keys_revoked or 0),
        "stripe_action_required": stripe_action_required,
        "stripe_cancellation_performed": False,
    }


@router.get("/tenants/{tenant_id}/customers/duplicates")
def admin_list_duplicates(
    tenant_id: str, db: Session = Depends(get_db), admin: AuthUser = Depends(require_platform_admin)
):
    t = db.get(Tenant, tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable.")
    return _find_duplicates(db, tenant_id)


@router.post("/tenants/{tenant_id}/customers/deduplicate")
def admin_deduplicate_customers(
    tenant_id: str, db: Session = Depends(get_db), admin: AuthUser = Depends(require_platform_admin)
):
    t = db.get(Tenant, tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable.")
    clusters = _find_duplicates(db, tenant_id)
    removed = []
    skipped = []
    for cluster in clusters:
        for cid in cluster.get("remove", []):
            has_invoice = (
                db.query(Invoice.id).filter(Invoice.customer_id == cid, Invoice.tenant_id == tenant_id).first()
            )
            if has_invoice:
                skipped.append({"id": cid, "reason": "linked_invoices"})
                continue
            db.query(Customer).filter(Customer.id == cid, Customer.tenant_id == tenant_id).delete()
            removed.append(cid)
    if removed:
        db.commit()
    new_count = _duplicate_count(db, tenant_id)
    _log(db, tenant_id, admin.id, "deduplicate", {"removed": removed, "skipped": skipped, "remaining": new_count})
    db.commit()
    return {"removed": removed, "skipped": skipped, "clusters": clusters, "duplicate_count": new_count}


@router.post("/ereporting/events", response_model=EReportingEventOut)
def admin_create_ereporting_event(
    payload: EReportingEventCreate,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_platform_admin),
):
    tenant = db.get(Tenant, payload.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")
    try:
        ensure_ereporting_allowed(
            client_country=payload.client_country,
            client_type=payload.client_type,
            client_vat_number=payload.client_vat_number,
        )
    except ValueError as exc:
        raise HTTPException(
            400,
            sanitize_public_error_message(
                exc,
                status_code=400,
                fallback="Cet événement ne peut pas être enregistré avec ces informations.",
            ),
        ) from exc
    try:
        provider_slug = resolve_provider_slug(db, payload.tenant_id, payload.provider_slug)
    except ValueError as exc:
        raise HTTPException(
            400,
            sanitize_public_error_message(
                exc,
                status_code=400,
                fallback="La plateforme agréée sélectionnée est indisponible.",
            ),
        ) from exc
    event = EReportingEvent(
        tenant_id=payload.tenant_id,
        provider_slug=provider_slug,
        type=payload.type,
        amounts=payload.amounts,
        payment_date=payload.payment_date,
        country=payload.country,
        client_country=payload.client_country,
        client_vat_number=payload.client_vat_number,
        client_type=payload.client_type,
        payload_hash=payload_hash_from_fields(
            event_type=payload.type,
            amounts=payload.amounts,
            payment_date=payload.payment_date,
            country=payload.country,
            client_country=payload.client_country,
            client_vat_number=payload.client_vat_number,
            client_type=payload.client_type,
        ),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.get("/ereporting/events", response_model=list[EReportingEventOut])
def admin_list_ereporting_events(
    tenant_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_platform_admin),
):
    limit = max(1, min(limit, 200))
    offset = max(offset, 0)
    query = db.query(EReportingEvent)
    if tenant_id:
        query = query.filter(EReportingEvent.tenant_id == tenant_id)
    events = query.order_by(EReportingEvent.created_at.desc()).offset(offset).limit(limit).all()
    return events


@router.get("/tenants/{tenant_id}/usage")
def tenant_usage(tenant_id: str, db: Session = Depends(get_db), admin: AuthUser = Depends(require_platform_admin)):
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")
    invoice_count = db.query(func.count(Invoice.id)).filter(Invoice.tenant_id == tenant_id).scalar()
    total_bytes = int(get_used_bytes(db, tenant_id))
    total_gib = total_bytes / (1024**3) if total_bytes else 0.0
    cost_per_gib = float(getattr(settings, "STORAGE_COST_PER_GIB_EUR", 0.0) or 0.0)
    estimated_cost = total_gib * cost_per_gib
    return {
        "tenant_id": tenant_id,
        "invoice_count": int(invoice_count or 0),
        "total_bytes": total_bytes,
        "total_gib": round(total_gib, 6),
        "cost_per_gib_eur": cost_per_gib,
        "estimated_cost_eur": round(estimated_cost, 6),
    }


@router.get("/usage/seqino")
def seqino_usage_summary(
    period: str | None = None,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_platform_admin),
):
    try:
        normalized_period = _normalize_period(period)
    except ValueError as exc:
        raise HTTPException(
            400,
            {
                "code": "period_invalid",
                "message": sanitize_public_error_message(
                    exc,
                    status_code=400,
                    fallback="La période doit être saisie au format AAAA-MM.",
                ),
            },
        ) from exc

    cost_invoice = float(getattr(settings, "SEQINO_USAGE_COST_INVOICE_EUR", 0.0) or 0.0)
    cost_reporting = float(getattr(settings, "SEQINO_USAGE_COST_REPORTING_EUR", 0.0) or 0.0)
    rows = (
        db.query(UsageMetric, Tenant)
        .join(Tenant, UsageMetric.tenant_id == Tenant.id)
        .filter(UsageMetric.period == normalized_period)
        .order_by(Tenant.name.asc())
        .all()
    )
    items = []
    for metric, tenant in rows:
        metrics = metric.metrics_json if isinstance(metric.metrics_json, dict) else {"raw": metric.metrics_json}
        invoice_count = _extract_count(metrics, ("invoices_count", "invoice_count", "invoiceCount", "invoices"))
        reporting_count = _extract_count(
            metrics,
            ("reporting_count", "reportingCount", "reports_count", "report_count", "reporting", "reports"),
        )
        estimated_cost = (invoice_count * cost_invoice) + (reporting_count * cost_reporting)
        items.append(
            {
                "tenant_id": tenant.id,
                "tenant_name": tenant.name,
                "period": normalized_period,
                "invoice_count": invoice_count,
                "reporting_count": reporting_count,
                "estimated_cost_eur": round(estimated_cost, 6),
                "metrics": metrics,
            }
        )
    return {
        "period": normalized_period,
        "cost_per_invoice_eur": cost_invoice,
        "cost_per_reporting_eur": cost_reporting,
        "items": items,
    }
