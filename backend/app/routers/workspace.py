from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_viewer_or_admin
from ..models import (
    ActionLog,
    ApiKey,
    AuthSession,
    BillableEvent,
    Customer,
    EInvoiceTransmission,
    EInvoicingTransmission,
    Invoice,
    PdpConnection,
    PdpMandate,
    Product,
    Quote,
    Tenant,
    TokenLedger,
    TokenWallet,
)
from ..services.product_capabilities import is_product_feature_enabled

router = APIRouter(prefix="/api/workspace", tags=["workspace"])

ACTIVE_CONNECTION_STATUSES = {"connected", "active", "ready", "enabled"}
ACTIVE_MANDATE_STATUSES = {"active"}
EXPORT_ACTIONS = (
    "export",
    "export_pdf",
    "export_ubl",
    "export_cii",
    "export_facturx",
    "export_csv",
    "export_fec",
    "export_edi",
)

COMPANY_CHECKS = (
    ("name", "Raison sociale", lambda tenant: bool((tenant.name or "").strip())),
    ("registration", "SIRET ou TVA", lambda tenant: bool((tenant.siret or "").strip() or (tenant.vat_number or "").strip())),
    ("address", "Adresse", lambda tenant: bool((tenant.address_line1 or tenant.address or "").strip())),
    ("postal_code", "Code postal", lambda tenant: bool((tenant.postal_code or "").strip())),
    ("city", "Ville", lambda tenant: bool((tenant.city or "").strip())),
    ("country", "Pays", lambda tenant: bool((tenant.country or tenant.country_code or "").strip())),
)


def _status_counts(rows: list[tuple[str | None, int]]) -> dict[str, int]:
    payload: dict[str, int] = {}
    for status, count in rows:
        key = (status or "unknown").strip().lower() or "unknown"
        payload[key] = int(count or 0)
    return payload


def _classic_invoice_status_counts(counts: dict[str, int], *, payments_enabled: bool) -> dict[str, int]:
    if payments_enabled:
        return dict(counts)
    visible = {
        key: value
        for key, value in counts.items()
        if key not in {"paid", "partial", "overdue", "refunded"}
    }
    retained_payment_states = sum(
        int(counts.get(key, 0) or 0)
        for key in ("paid", "partial", "overdue", "refunded")
    )
    if retained_payment_states:
        visible["issued"] = int(visible.get("issued", 0) or 0) + retained_payment_states
    return visible


def _iso_or_none(value: datetime | None) -> str | None:
    if not value:
        return None
    return value.isoformat()


def _min_datetime(*values: datetime | None) -> datetime | None:
    candidates = [value for value in values if value is not None]
    return min(candidates) if candidates else None


def _max_datetime(*values: datetime | None) -> datetime | None:
    candidates = [value for value in values if value is not None]
    return max(candidates) if candidates else None


def _elapsed_seconds(start: datetime | None, end: datetime | None) -> int | None:
    if not start or not end:
        return None
    seconds = int((end - start).total_seconds())
    return max(seconds, 0)


def _milestone_payload(
    *,
    label: str,
    href: str,
    occurred_at: datetime | None,
    baseline: datetime | None,
) -> dict[str, object]:
    elapsed_seconds = _elapsed_seconds(baseline, occurred_at)
    return {
        "available": True,
        "label": label,
        "href": href,
        "reached": occurred_at is not None,
        "occurred_at": _iso_or_none(occurred_at),
        "elapsed_seconds": elapsed_seconds,
        "elapsed_hours": round(elapsed_seconds / 3600, 1) if elapsed_seconds is not None else None,
        "elapsed_days": round(elapsed_seconds / 86400, 1) if elapsed_seconds is not None else None,
    }


def _unavailable_milestone(*, label: str, href: str) -> dict[str, object]:
    return {
        "available": False,
        "label": label,
        "href": href,
        "reached": False,
        "occurred_at": None,
        "elapsed_seconds": None,
        "elapsed_hours": None,
        "elapsed_days": None,
    }


@router.get("/summary")
def workspace_summary(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    einvoicing_enabled = is_product_feature_enabled(tenant, "einvoicing_enabled")

    checks = [
        {
            "key": key,
            "label": label,
            "done": bool(check(tenant)),
        }
        for key, label, check in COMPANY_CHECKS
    ]
    company_done_count = sum(1 for item in checks if item["done"])
    company_completion = round((company_done_count / len(checks)) * 100) if checks else 0
    company_missing = [str(item["label"]) for item in checks if not bool(item["done"])]
    company_complete = company_done_count == len(checks)

    customer_count = int(
        db.query(func.count(Customer.id)).filter(Customer.tenant_id == user.tenant_id).scalar() or 0
    )
    customer_portal_enabled_count = int(
        db.query(func.count(Customer.id))
        .filter(Customer.tenant_id == user.tenant_id, Customer.portal_enabled.is_(True))
        .scalar()
        or 0
    )
    customer_fr_ready_count = int(
        db.query(func.count(Customer.id))
        .filter(Customer.tenant_id == user.tenant_id)
        .filter(func.upper(func.coalesce(Customer.country, "FR")) == "FR")
        .filter(or_(Customer.siret.isnot(None), Customer.siren.isnot(None)))
        .scalar()
        or 0
    )

    item_count = int(
        db.query(func.count(Product.id))
        .filter(Product.tenant_id == user.tenant_id, Product.active.is_(True))
        .scalar()
        or 0
    )

    quote_count_rows = (
        db.query(Quote.status, func.count(Quote.id))
        .filter(Quote.tenant_id == user.tenant_id)
        .group_by(Quote.status)
        .all()
    )
    quote_counts = _status_counts(quote_count_rows)
    quote_total = int(sum(quote_counts.values()))

    invoice_count_rows = (
        db.query(Invoice.status, func.count(Invoice.id))
        .filter(Invoice.tenant_id == user.tenant_id, Invoice.type == "invoice")
        .group_by(Invoice.status)
        .all()
    )
    stored_invoice_counts = _status_counts(invoice_count_rows)
    invoice_counts = _classic_invoice_status_counts(stored_invoice_counts, payments_enabled=payments_enabled)
    invoice_total = int(sum(stored_invoice_counts.values()))

    connected_count = 0
    active_mandates = 0
    if einvoicing_enabled:
        connected_count = int(
            db.query(func.count(PdpConnection.id))
            .filter(PdpConnection.tenant_id == user.tenant_id)
            .filter(func.lower(func.coalesce(PdpConnection.status, "connected")).in_(ACTIVE_CONNECTION_STATUSES))
            .scalar()
            or 0
        )
        active_mandates = int(
            db.query(func.count(PdpMandate.id))
            .filter(PdpMandate.tenant_id == user.tenant_id)
            .filter(func.lower(func.coalesce(PdpMandate.status, "")).in_(ACTIVE_MANDATE_STATUSES))
            .scalar()
            or 0
        )

    setup_steps = [
        {
            "key": "company",
            "label": "Compléter l’entreprise",
            "href": "/app/company",
            "done": company_complete,
            "reason": f"Champs manquants : {', '.join(company_missing)}" if company_missing else None,
        },
        {
            "key": "customers",
            "label": "Créer un premier client",
            "href": "/app/customers/new",
            "done": customer_count > 0,
            "reason": "Aucun client n’a encore été créé." if customer_count == 0 else None,
        },
        {
            "key": "quotes",
            "label": "Envoyer un premier devis",
            "href": "/app/quotes/new",
            "done": quote_total > 0,
            "reason": "Aucun devis encore envoyé ou brouillonné." if quote_total == 0 else None,
        },
        {
            "key": "invoices",
            "label": "Émettre une première facture",
            "href": "/app/invoices/new",
            "done": invoice_total > 0,
            "reason": "Aucune facture émise dans le tenant." if invoice_total == 0 else None,
        },
    ]

    completed_steps = sum(1 for step in setup_steps if step["done"])
    setup_percent = round((completed_steps / len(setup_steps)) * 100) if setup_steps else 0

    next_actions: list[dict[str, object]] = []
    for step in setup_steps:
        if step["done"]:
            continue
        next_actions.append(
            {
                "key": step["key"],
                "label": step["label"],
                "href": step["href"],
                "reason": step["reason"],
                "priority": "high" if step["key"] in {"company", "customers"} else "medium",
            }
        )

    pilot_ready = bool(company_complete and customer_count > 0 and (quote_total > 0 or invoice_total > 0))
    wide_ready = bool(
        pilot_ready
        and (not einvoicing_enabled or (connected_count > 0 and active_mandates > 0))
    )

    return {
        "generated_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        "company": {
            "completion": company_completion,
            "complete": company_complete,
            "missing": company_missing,
            "checks": checks,
        },
        "customers": {
            "count": customer_count,
            "portal_enabled_count": customer_portal_enabled_count,
            "fr_business_ready_count": customer_fr_ready_count,
        },
        "items": {
            "count": item_count,
        },
        "quotes": {
            "count": quote_total,
            "accepted_count": int(quote_counts.get("accepted", 0)),
            "sent_count": int(quote_counts.get("sent", 0)),
            "draft_count": int(quote_counts.get("draft", 0)),
            "status_breakdown": quote_counts,
        },
        "invoices": {
            "count": invoice_total,
            "paid_count": int(stored_invoice_counts.get("paid", 0)) if payments_enabled else 0,
            "pending_count": int(
                stored_invoice_counts.get("sent", 0)
                + stored_invoice_counts.get("issued", 0)
                + stored_invoice_counts.get("partial", 0)
            )
            if payments_enabled
            else 0,
            "overdue_count": int(stored_invoice_counts.get("overdue", 0)) if payments_enabled else 0,
            "status_breakdown": invoice_counts,
        },
        "platforms": {
            "available": einvoicing_enabled,
            "connected_count": connected_count,
            "active_mandates": active_mandates,
            "ready": bool(einvoicing_enabled and connected_count > 0 and active_mandates > 0),
        },
        "setup": {
            "completed": completed_steps,
            "total": len(setup_steps),
            "percent": setup_percent,
            "steps": setup_steps,
        },
        "commercial": {
            "pilot_ready": pilot_ready,
            "wide_ready": wide_ready,
        },
        "next_actions": next_actions[:5],
    }


@router.get("/activation-metrics")
def workspace_activation_metrics(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    einvoicing_enabled = is_product_feature_enabled(tenant, "einvoicing_enabled")

    tenant_created_at = tenant.created_at
    first_customer_at = (
        db.query(func.min(Customer.created_at)).filter(Customer.tenant_id == user.tenant_id).scalar()
    )
    first_quote_at = db.query(func.min(Quote.created_at)).filter(Quote.tenant_id == user.tenant_id).scalar()
    first_invoice_at = (
        db.query(func.min(Invoice.created_at))
        .filter(Invoice.tenant_id == user.tenant_id, Invoice.type == "invoice")
        .scalar()
    )
    first_export_at = (
        db.query(func.min(ActionLog.created_at))
        .filter(ActionLog.tenant_id == user.tenant_id, ActionLog.action.in_(EXPORT_ACTIONS))
        .scalar()
    )
    first_outgoing_tx_at = None
    first_partner_tx_at = None
    if einvoicing_enabled:
        first_outgoing_tx_at = (
            db.query(func.min(EInvoicingTransmission.created_at))
            .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == user.tenant_id)
            .scalar()
        )
        first_partner_tx_at = (
            db.query(func.min(EInvoiceTransmission.created_at))
            .filter(EInvoiceTransmission.tenant_id == user.tenant_id)
            .scalar()
        )
    first_transmission_at = _min_datetime(first_outgoing_tx_at, first_partner_tx_at)
    first_value_at = _min_datetime(
        first_customer_at,
        first_quote_at,
        first_invoice_at,
        first_export_at,
        first_transmission_at,
    )
    export_count = int(
        db.query(func.count(ActionLog.id))
        .filter(ActionLog.tenant_id == user.tenant_id, ActionLog.action.in_(EXPORT_ACTIONS))
        .scalar()
        or 0
    )
    transmission_count = 0
    if einvoicing_enabled:
        transmission_count = int(
            db.query(func.count(EInvoiceTransmission.id))
            .filter(EInvoiceTransmission.tenant_id == user.tenant_id)
            .scalar()
            or 0
        ) + int(
            db.query(func.count(EInvoicingTransmission.id))
            .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == user.tenant_id)
            .scalar()
            or 0
        )

    milestones = {
        "first_customer": _milestone_payload(
            label="Premier client",
            href="/app/customers/new",
            occurred_at=first_customer_at,
            baseline=tenant_created_at,
        ),
        "first_invoice": _milestone_payload(
            label="Première facture",
            href="/app/invoices/new",
            occurred_at=first_invoice_at,
            baseline=tenant_created_at,
        ),
        "first_export": _milestone_payload(
            label="Premier export",
            href="/app/settings/export",
            occurred_at=first_export_at,
            baseline=tenant_created_at,
        ),
        "first_transmission": (
            _milestone_payload(
                label="Première transmission",
                href="/app/transmissions",
                occurred_at=first_transmission_at,
                baseline=tenant_created_at,
            )
            if einvoicing_enabled
            else _unavailable_milestone(label="Première transmission", href="/app/billing")
        ),
    }
    reached_count = sum(1 for item in milestones.values() if bool(item["reached"]))
    available_milestones = sum(1 for item in milestones.values() if bool(item["available"]))
    first_value_elapsed = _elapsed_seconds(tenant_created_at, first_value_at)

    return {
        "generated_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        "tenant_created_at": _iso_or_none(tenant_created_at),
        "milestones": milestones,
        "summary": {
            "reached_count": reached_count,
            "total": available_milestones,
            "first_value_at": _iso_or_none(first_value_at),
            "first_value_elapsed_seconds": first_value_elapsed,
            "first_value_elapsed_hours": round(first_value_elapsed / 3600, 1)
            if first_value_elapsed is not None
            else None,
            "first_value_elapsed_days": round(first_value_elapsed / 86400, 1)
            if first_value_elapsed is not None
            else None,
            "export_count": export_count,
            "transmission_count": transmission_count,
        },
    }


@router.get("/business-metrics")
def workspace_business_metrics(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    einvoicing_enabled = is_product_feature_enabled(tenant, "einvoicing_enabled")
    tokens_enabled = is_product_feature_enabled(tenant, "token_topup_enabled")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    window_start = now - timedelta(days=30)

    invoices_30d = int(
        db.query(func.count(Invoice.id))
        .filter(Invoice.tenant_id == user.tenant_id, Invoice.type == "invoice", Invoice.created_at >= window_start)
        .scalar()
        or 0
    )
    quotes_30d = int(
        db.query(func.count(Quote.id))
        .filter(Quote.tenant_id == user.tenant_id, Quote.created_at >= window_start)
        .scalar()
        or 0
    )
    exports_30d = int(
        db.query(func.count(ActionLog.id))
        .filter(
            ActionLog.tenant_id == user.tenant_id,
            ActionLog.action.in_(EXPORT_ACTIONS),
            ActionLog.created_at >= window_start,
        )
        .scalar()
        or 0
    )

    active_connections = 0
    active_mandates = 0
    providers_used_30d = 0
    transmissions_30d = 0
    if einvoicing_enabled:
        active_connections = int(
            db.query(func.count(PdpConnection.id))
            .filter(PdpConnection.tenant_id == user.tenant_id)
            .filter(func.lower(func.coalesce(PdpConnection.status, "connected")).in_(ACTIVE_CONNECTION_STATUSES))
            .scalar()
            or 0
        )
        active_mandates = int(
            db.query(func.count(PdpMandate.id))
            .filter(PdpMandate.tenant_id == user.tenant_id)
            .filter(func.lower(func.coalesce(PdpMandate.status, "")).in_(ACTIVE_MANDATE_STATUSES))
            .scalar()
            or 0
        )
        providers_used_30d = int(
            db.query(func.count(func.distinct(BillableEvent.provider_slug)))
            .filter(
                BillableEvent.tenant_id == user.tenant_id,
                BillableEvent.occurred_at >= window_start,
                BillableEvent.provider_slug.isnot(None),
            )
            .scalar()
            or 0
        )
        transmissions_30d = int(
            db.query(func.count(EInvoiceTransmission.id))
            .filter(
                EInvoiceTransmission.tenant_id == user.tenant_id,
                EInvoiceTransmission.created_at >= window_start,
            )
            .scalar()
            or 0
        ) + int(
            db.query(func.count(EInvoicingTransmission.id))
            .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == user.tenant_id, EInvoicingTransmission.created_at >= window_start)
            .scalar()
            or 0
        )

    api_keys_count = int(
        db.query(func.count(ApiKey.id))
        .filter(ApiKey.tenant_id == user.tenant_id, ApiKey.revoked_at.is_(None))
        .scalar()
        or 0
    )
    api_keys_used_30d = int(
        db.query(func.count(ApiKey.id))
        .filter(
            ApiKey.tenant_id == user.tenant_id,
            ApiKey.revoked_at.is_(None),
            ApiKey.last_used_at.isnot(None),
            ApiKey.last_used_at >= window_start,
        )
        .scalar()
        or 0
    )

    token_balance = 0
    tokens_used_30d_raw = 0
    tokens_purchased_30d_raw = 0
    if tokens_enabled:
        wallet = db.get(TokenWallet, user.tenant_id)
        token_balance = int(wallet.balance or 0) if wallet else 0
        tokens_used_30d_raw = (
            db.query(func.coalesce(func.sum(TokenLedger.delta), 0))
            .filter(
                TokenLedger.tenant_id == user.tenant_id,
                TokenLedger.type == "usage",
                TokenLedger.created_at >= window_start,
            )
            .scalar()
            or 0
        )
        tokens_purchased_30d_raw = (
            db.query(func.coalesce(func.sum(TokenLedger.delta), 0))
            .filter(
                TokenLedger.tenant_id == user.tenant_id,
                TokenLedger.type == "purchase",
                TokenLedger.created_at >= window_start,
            )
            .scalar()
            or 0
        )
    tokens_used_30d = abs(int(tokens_used_30d_raw))
    tokens_purchased_30d = max(int(tokens_purchased_30d_raw), 0)

    last_session_activity = (
        db.query(func.max(AuthSession.last_used_at)).filter(AuthSession.tenant_id == user.tenant_id).scalar()
    )
    last_audit_activity = db.query(func.max(ActionLog.created_at)).filter(ActionLog.tenant_id == user.tenant_id).scalar()
    last_invoice_activity = db.query(func.max(Invoice.updated_at)).filter(Invoice.tenant_id == user.tenant_id).scalar()
    last_quote_activity = db.query(func.max(Quote.updated_at)).filter(Quote.tenant_id == user.tenant_id).scalar()
    last_billable_activity = None
    if einvoicing_enabled:
        last_billable_activity = (
            db.query(func.max(BillableEvent.occurred_at))
            .filter(BillableEvent.tenant_id == user.tenant_id)
            .scalar()
        )
    last_token_activity = None
    if tokens_enabled:
        last_token_activity = (
            db.query(func.max(TokenLedger.created_at)).filter(TokenLedger.tenant_id == user.tenant_id).scalar()
        )
    last_activity_at = _max_datetime(
        last_session_activity,
        last_audit_activity,
        last_invoice_activity,
        last_quote_activity,
        last_billable_activity,
        last_token_activity,
    )
    last_activity_age_days = None
    if last_activity_at is not None:
        last_activity_age_days = max(round((now - last_activity_at).total_seconds() / 86400, 1), 0.0)

    subscription_status = (tenant.subscription_status or "").strip().lower() or None
    trial_end = tenant.trial_end

    return {
        "generated_at": now.isoformat(),
        "window_start": window_start.isoformat(),
        "subscription": {
            "plan": tenant.plan,
            "status": subscription_status,
            "trial_end": _iso_or_none(trial_end),
            "active": subscription_status in {"active", "trialing"},
            "trialing": subscription_status == "trialing",
        },
        "activity_30d": {
            "invoices": invoices_30d,
            "quotes": quotes_30d,
            "exports": exports_30d,
            "active_last_30d": bool(last_activity_at and last_activity_at >= window_start),
            "last_activity_at": _iso_or_none(last_activity_at),
            "last_activity_age_days": last_activity_age_days,
        },
        "connected": {
            "available": einvoicing_enabled,
            "connections": active_connections,
            "active_mandates": active_mandates,
            "providers_used_30d": providers_used_30d,
            "transmissions_30d": transmissions_30d,
            "ready": bool(einvoicing_enabled and active_connections > 0 and active_mandates > 0),
        },
        "api": {
            "keys_count": api_keys_count,
            "keys_used_30d": api_keys_used_30d,
        },
        "tokens": {
            "available": tokens_enabled,
            "balance": token_balance,
            "used_30d": tokens_used_30d,
            "purchased_30d": tokens_purchased_30d,
        },
    }
