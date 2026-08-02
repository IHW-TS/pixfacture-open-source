from __future__ import annotations

import copy
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_product_capability, require_viewer_or_admin
from ..models import TenantSettings
from ..services.email import send_email, smtp_diagnostic_payload
from . import ops as ops_base
from . import ops_portfolio as portfolio_base

router = APIRouter(
    prefix="/api/ops",
    tags=["ops"],
    dependencies=[Depends(require_product_capability("payments_enabled"))],
)
logger = logging.getLogger(__name__)

_OUTBOX_STORE_KEY = "ops_campaign_outbox"
_DISPATCH_RUN_STORE_KEY = "ops_campaign_dispatch_runs"
_SCHEDULER_RUN_STORE_KEY = "ops_campaign_delivery_scheduler_runs"
_OUTBOX_DT_KEYS = {"created_at", "updated_at", "scheduled_for", "approved_at", "sent_at", "last_attempt_at"}
_DISPATCH_DT_KEYS = {"generated_at"}
_SCHEDULER_DT_KEYS = {"generated_at"}
_ALLOWED_OUTBOX_STATES = {"draft", "ready", "sent", "skipped", "blocked"}
_OUTBOX_STATE_META = {
    "draft": ("Brouillon", "info"),
    "ready": ("Prêt", "purple"),
    "sent": ("Diffusé", "ok"),
    "skipped": ("Ignoré", "muted"),
    "blocked": ("Bloqué", "danger"),
}
_DELIVERY_MODE_LABELS = {
    "smtp": "SMTP réel",
    "log_only": "Journal opérateur",
}
_ATTEMPT_STATUS_LABELS = {
    "sent": "Envoyé",
    "logged": "Journalisé",
    "failed": "Échec",
    "skipped": "Ignoré",
    "blocked": "Bloqué",
}


class CampaignOutboxItemOut(BaseModel):
    id: str
    run_id: str
    campaign_id: str
    campaign_name: str
    customer_id: str
    customer_name: str
    customer_email: str | None = None
    segment_label: str | None = None
    risk_label: str | None = None
    state: str
    state_label: str
    tone: str
    subject: str
    body_preview: str | None = None
    owner_role: str
    assignee_user_id: str | None = None
    assignee_email: str | None = None
    assignee_label: str | None = None
    notes: str | None = None
    last_error: str | None = None
    delivery_mode: str | None = None
    delivery_mode_label: str | None = None
    attempt_count: int = 0
    last_attempt_at: datetime | None = None
    last_attempt_status: str | None = None
    last_attempt_label: str | None = None
    href: str = "/app/outbox"
    customer_href: str | None = None
    scheduled_for: datetime | None = None
    approved_at: datetime | None = None
    sent_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CampaignOutboxSummaryOut(BaseModel):
    total_count: int = 0
    draft_count: int = 0
    ready_count: int = 0
    sent_count: int = 0
    skipped_count: int = 0
    blocked_count: int = 0
    pending_count: int = 0
    coverage_rate: float | None = None
    recent_dispatches_count: int = 0
    due_ready_count: int = 0
    future_ready_count: int = 0
    failed_count: int = 0
    sent_smtp_count: int = 0
    sent_log_only_count: int = 0
    attempted_count: int = 0


class CampaignDeliveryHealthOut(BaseModel):
    smtp_ready: bool = False
    delivery_mode: str = "log_only"
    delivery_mode_label: str = "Journal opérateur"
    ready_due_count: int = 0
    ready_future_count: int = 0
    blocked_count: int = 0
    failed_count: int = 0
    sent_smtp_count: int = 0
    sent_log_only_count: int = 0
    last_dispatch_at: datetime | None = None
    next_scheduled_at: datetime | None = None
    warnings: list[str] = Field(default_factory=list)


class CampaignDispatchRunOut(BaseModel):
    id: str
    trigger: str
    trigger_label: str
    queued_count: int = 0
    sent_count: int = 0
    skipped_count: int = 0
    failed_count: int = 0
    log_only_count: int = 0
    smtp_count: int = 0
    campaign_count: int = 0
    delivery_mode: str = "log_only"
    delivery_mode_label: str = "Journal opérateur"
    notes: list[str] = Field(default_factory=list)
    generated_at: datetime | None = None
    href: str = "/app/outbox"


class CampaignDeliverySchedulerRunOut(BaseModel):
    id: str
    trigger: str
    trigger_label: str
    campaigns_processed: int = 0
    drafts_approved: int = 0
    sent_count: int = 0
    failed_count: int = 0
    log_only_count: int = 0
    notes: list[str] = Field(default_factory=list)
    generated_at: datetime | None = None
    href: str = "/app/outbox"


class CampaignOutboxBoardOut(BaseModel):
    summary: CampaignOutboxSummaryOut = Field(default_factory=CampaignOutboxSummaryOut)
    delivery: CampaignDeliveryHealthOut = Field(default_factory=CampaignDeliveryHealthOut)
    items: list[CampaignOutboxItemOut] = Field(default_factory=list)
    recent_dispatches: list[CampaignDispatchRunOut] = Field(default_factory=list)
    scheduler_runs: list[CampaignDeliverySchedulerRunOut] = Field(default_factory=list)
    generated_at: datetime


class CampaignOutboxPatchRequest(BaseModel):
    state: str | None = Field(default=None, min_length=3, max_length=32)
    assignee_user_id: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=600)


class CampaignOutboxBulkResultOut(BaseModel):
    updated_count: int = 0
    created_count: int = 0
    blocked_count: int = 0
    notes: list[str] = Field(default_factory=list)
    generated_at: datetime


class CampaignOutboxDispatchResultOut(BaseModel):
    queued_count: int = 0
    sent_count: int = 0
    failed_count: int = 0
    log_only_count: int = 0
    delivery_mode: str = "log_only"
    delivery_mode_label: str = "Journal opérateur"
    notes: list[str] = Field(default_factory=list)
    dispatch: CampaignDispatchRunOut | None = None
    generated_at: datetime


class CampaignOutboxItemSendResultOut(BaseModel):
    item: CampaignOutboxItemOut
    delivery_mode: str = "log_only"
    delivery_mode_label: str = "Journal opérateur"
    notes: list[str] = Field(default_factory=list)
    generated_at: datetime


class CampaignOutboxPipelineResultOut(BaseModel):
    campaigns_processed: int = 0
    drafts_approved: int = 0
    sent_count: int = 0
    failed_count: int = 0
    log_only_count: int = 0
    notes: list[str] = Field(default_factory=list)
    scheduler_run: CampaignDeliverySchedulerRunOut | None = None
    generated_at: datetime


class _RecipientContext(BaseModel):
    campaign: portfolio_base.PortfolioCampaignOut
    customer: portfolio_base.CustomerPortfolioItemOut
    assignee_label: str | None = None


CampaignOutboxBoardOut.model_rebuild()


def _features(settings_row: TenantSettings | None) -> dict[str, Any]:
    return ops_base._features(settings_row)


def _delivery_mode_label(value: str | None) -> str:
    return _DELIVERY_MODE_LABELS.get(str(value or "log_only").strip().lower(), "Journal opérateur")


def _attempt_status_label(value: str | None) -> str | None:
    key = str(value or "").strip().lower()
    if not key:
        return None
    return _ATTEMPT_STATUS_LABELS.get(key, key.replace("_", " ").capitalize())


def _smtp_mode(force_mode: str | None = None) -> tuple[str, str, bool, list[str]]:
    requested = str(force_mode or "auto").strip().lower()
    diagnostic = smtp_diagnostic_payload()
    smtp_ready = bool(diagnostic.get("smtp_configured"))
    warnings: list[str] = []
    if requested == "smtp":
        if not smtp_ready:
            raise HTTPException(503, "Canal email non configuré pour cet espace.")
        return "smtp", _delivery_mode_label("smtp"), True, warnings
    if requested == "log_only":
        if smtp_ready:
            warnings.append("Le canal email est prêt mais la diffusion reste volontairement en journal opérateur.")
        return "log_only", _delivery_mode_label("log_only"), smtp_ready, warnings
    if smtp_ready:
        return "smtp", _delivery_mode_label("smtp"), True, warnings
    warnings.append("Canal email non configuré : bascule automatique en journal opérateur.")
    return "log_only", _delivery_mode_label("log_only"), False, warnings


def _write_settings(
    db: Session,
    settings_row: TenantSettings,
    *,
    outbox: list[dict[str, Any]] | None = None,
    dispatch_runs: list[dict[str, Any]] | None = None,
    scheduler_runs: list[dict[str, Any]] | None = None,
) -> TenantSettings:
    features = _features(settings_row)
    if outbox is not None:
        features[_OUTBOX_STORE_KEY] = outbox
    if dispatch_runs is not None:
        features[_DISPATCH_RUN_STORE_KEY] = dispatch_runs
    if scheduler_runs is not None:
        features[_SCHEDULER_RUN_STORE_KEY] = scheduler_runs
    settings_row.features = features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _read_outbox_rows(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_OUTBOX_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _read_dispatch_runs(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_DISPATCH_RUN_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _read_scheduler_runs(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_SCHEDULER_RUN_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _normalize_outbox_state(value: str | None) -> str:
    normalized = str(value or "draft").strip().lower()
    if normalized not in _ALLOWED_OUTBOX_STATES:
        return "draft"
    return normalized


def _render_text(template: str, context: dict[str, Any]) -> str:
    out = str(template or "")
    for key, value in context.items():
        out = out.replace("{" + key + "}", str(value or ""))
    return out.strip()


def _build_recipient_context(ctx: _RecipientContext) -> dict[str, Any]:
    customer = ctx.customer
    campaign = ctx.campaign
    return {
        "campaign_name": campaign.name,
        "action_label": campaign.action_label,
        "recipient_count": int(campaign.customer_count or 0),
        "customer_name": customer.customer_name,
        "customer_names": customer.customer_name,
        "segment_label": customer.segment_label,
        "risk_label": customer.risk_label,
        "open_balance": int(customer.open_balance or 0),
        "overdue_balance": int(customer.overdue_balance or 0),
        "segments": ", ".join(campaign.segment_labels[:3]) or customer.segment_label,
        "assignee_label": ctx.assignee_label
        or campaign.assignee_label
        or campaign.assignee_email
        or ops_base._MODULE_LABELS.get(campaign.module, "Équipe"),
        "scheduled_for": ops_base._to_iso(campaign.scheduled_for) or "",
        "customer_email": customer.customer_email or "",
    }


def _outbox_item_out(payload: dict[str, Any]) -> CampaignOutboxItemOut:
    row = ops_base._hydrate_dt_dict(payload, _OUTBOX_DT_KEYS)
    state = _normalize_outbox_state(str(row.get("state") or "draft"))
    state_label, tone = _OUTBOX_STATE_META[state]
    delivery_mode = str(row.get("delivery_mode") or "").strip().lower() or None
    last_attempt_status = str(row.get("last_attempt_status") or "").strip().lower() or None
    return CampaignOutboxItemOut(
        id=str(row.get("id") or f"obox_{uuid.uuid4().hex[:10]}"),
        run_id=str(row.get("run_id") or ""),
        campaign_id=str(row.get("campaign_id") or ""),
        campaign_name=str(row.get("campaign_name") or "Campagne portefeuille"),
        customer_id=str(row.get("customer_id") or ""),
        customer_name=str(row.get("customer_name") or "Client"),
        customer_email=(str(row.get("customer_email") or "").strip() or None),
        segment_label=(str(row.get("segment_label") or "").strip() or None),
        risk_label=(str(row.get("risk_label") or "").strip() or None),
        state=state,
        state_label=state_label,
        tone=tone,
        subject=str(row.get("subject") or "Campagne portefeuille"),
        body_preview=(str(row.get("body_preview") or "").strip() or None),
        owner_role=ops_base._normalize_owner_role(str(row.get("owner_role") or "accountant")),
        assignee_user_id=(str(row.get("assignee_user_id") or "").strip() or None),
        assignee_email=(str(row.get("assignee_email") or "").strip() or None),
        assignee_label=(str(row.get("assignee_label") or "").strip() or None),
        notes=(str(row.get("notes") or "").strip() or None),
        last_error=(str(row.get("last_error") or "").strip() or None),
        delivery_mode=delivery_mode,
        delivery_mode_label=_delivery_mode_label(delivery_mode) if delivery_mode else None,
        attempt_count=max(0, int(row.get("attempt_count") or 0)),
        last_attempt_at=ops_base._as_dt(row.get("last_attempt_at")),
        last_attempt_status=last_attempt_status,
        last_attempt_label=_attempt_status_label(last_attempt_status),
        href=(str(row.get("href") or "").strip() or "/app/outbox"),
        customer_href=(str(row.get("customer_href") or "").strip() or None),
        scheduled_for=ops_base._as_dt(row.get("scheduled_for")),
        approved_at=ops_base._as_dt(row.get("approved_at")),
        sent_at=ops_base._as_dt(row.get("sent_at")),
        created_at=ops_base._as_dt(row.get("created_at")),
        updated_at=ops_base._as_dt(row.get("updated_at")),
    )


def _dispatch_run_out(payload: dict[str, Any]) -> CampaignDispatchRunOut:
    row = ops_base._hydrate_dt_dict(payload, _DISPATCH_DT_KEYS)
    trigger = str(row.get("trigger") or "manual").strip().lower() or "manual"
    delivery_mode = str(row.get("delivery_mode") or "log_only").strip().lower() or "log_only"
    return CampaignDispatchRunOut(
        id=str(row.get("id") or f"odr_{uuid.uuid4().hex[:10]}"),
        trigger=trigger,
        trigger_label="Automatique" if trigger == "scheduler" else "Manuel",
        queued_count=int(row.get("queued_count") or 0),
        sent_count=int(row.get("sent_count") or 0),
        skipped_count=int(row.get("skipped_count") or 0),
        failed_count=int(row.get("failed_count") or 0),
        log_only_count=int(row.get("log_only_count") or 0),
        smtp_count=int(row.get("smtp_count") or 0),
        campaign_count=int(row.get("campaign_count") or 0),
        delivery_mode=delivery_mode,
        delivery_mode_label=_delivery_mode_label(delivery_mode),
        notes=[str(item).strip() for item in row.get("notes") or [] if str(item).strip()],
        generated_at=ops_base._as_dt(row.get("generated_at")),
        href=(str(row.get("href") or "").strip() or "/app/outbox"),
    )


def _scheduler_run_out(payload: dict[str, Any]) -> CampaignDeliverySchedulerRunOut:
    row = ops_base._hydrate_dt_dict(payload, _SCHEDULER_DT_KEYS)
    trigger = str(row.get("trigger") or "manual").strip().lower() or "manual"
    return CampaignDeliverySchedulerRunOut(
        id=str(row.get("id") or f"ods_{uuid.uuid4().hex[:10]}"),
        trigger=trigger,
        trigger_label="Automatique" if trigger == "scheduler" else "Manuel",
        campaigns_processed=int(row.get("campaigns_processed") or 0),
        drafts_approved=int(row.get("drafts_approved") or 0),
        sent_count=int(row.get("sent_count") or 0),
        failed_count=int(row.get("failed_count") or 0),
        log_only_count=int(row.get("log_only_count") or 0),
        notes=[str(item).strip() for item in row.get("notes") or [] if str(item).strip()],
        generated_at=ops_base._as_dt(row.get("generated_at")),
        href=(str(row.get("href") or "").strip() or "/app/outbox"),
    )


def _outbox_sort_key(item: CampaignOutboxItemOut) -> tuple[Any, ...]:
    state_rank = {"ready": 0, "draft": 1, "blocked": 2, "sent": 3, "skipped": 4}.get(item.state, 9)
    when = (
        item.sent_at or item.last_attempt_at or item.scheduled_for or item.updated_at or item.created_at or datetime.min
    )
    return (state_rank, -when.timestamp(), item.campaign_name.lower(), item.customer_name.lower())


def _board_payload(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
) -> CampaignOutboxBoardOut:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    items = sorted((_outbox_item_out(row) for row in _read_outbox_rows(settings_row)), key=_outbox_sort_key)
    recent_dispatches = sorted(
        (_dispatch_run_out(row) for row in _read_dispatch_runs(settings_row)),
        key=lambda item: item.generated_at or datetime.min,
        reverse=True,
    )[:8]
    scheduler_runs = sorted(
        (_scheduler_run_out(row) for row in _read_scheduler_runs(settings_row)),
        key=lambda item: item.generated_at or datetime.min,
        reverse=True,
    )[:6]
    summary = CampaignOutboxSummaryOut(total_count=len(items), recent_dispatches_count=len(recent_dispatches))
    delivery_mode, delivery_mode_label, smtp_ready, warnings = _smtp_mode("auto")
    delivery = CampaignDeliveryHealthOut(
        smtp_ready=smtp_ready,
        delivery_mode=delivery_mode,
        delivery_mode_label=delivery_mode_label,
        warnings=warnings,
    )
    eligible_count = 0
    next_scheduled_at: datetime | None = None
    for item in items:
        if item.customer_email:
            eligible_count += 1
        if item.state == "draft":
            summary.draft_count += 1
        elif item.state == "ready":
            summary.ready_count += 1
            scheduled_for = item.scheduled_for or now
            if scheduled_for <= now:
                summary.due_ready_count += 1
                delivery.ready_due_count += 1
            else:
                summary.future_ready_count += 1
                delivery.ready_future_count += 1
                if next_scheduled_at is None or scheduled_for < next_scheduled_at:
                    next_scheduled_at = scheduled_for
        elif item.state == "sent":
            summary.sent_count += 1
            if item.delivery_mode == "smtp":
                summary.sent_smtp_count += 1
                delivery.sent_smtp_count += 1
            elif item.delivery_mode == "log_only":
                summary.sent_log_only_count += 1
                delivery.sent_log_only_count += 1
        elif item.state == "skipped":
            summary.skipped_count += 1
        elif item.state == "blocked":
            summary.blocked_count += 1
            delivery.blocked_count += 1
        if item.last_attempt_status:
            summary.attempted_count += 1
            if item.last_attempt_status == "failed":
                summary.failed_count += 1
                delivery.failed_count += 1
    summary.pending_count = summary.draft_count + summary.ready_count + summary.blocked_count
    if eligible_count > 0:
        summary.coverage_rate = round(
            ((summary.sent_count + summary.ready_count + summary.draft_count) / eligible_count) * 100, 1
        )
    delivery.next_scheduled_at = next_scheduled_at
    last_dispatch = next((row for row in recent_dispatches if row.generated_at is not None), None)
    delivery.last_dispatch_at = last_dispatch.generated_at if last_dispatch else None
    if not smtp_ready and summary.ready_count > 0:
        delivery.warnings.append("Des lignes prêtes seront journalisées tant que SMTP n'est pas configuré.")
    if summary.failed_count > 0:
        delivery.warnings.append("Certaines tentatives ont échoué : vérifie l'outbox avant de renvoyer.")
    return CampaignOutboxBoardOut(
        summary=summary,
        delivery=delivery,
        items=items,
        recent_dispatches=recent_dispatches,
        scheduler_runs=scheduler_runs,
        generated_at=now,
    )


def _campaign_recipients(
    db: Session,
    user: AuthUser,
    campaign: portfolio_base.PortfolioCampaignOut,
    *,
    now: datetime | None = None,
) -> tuple[list[portfolio_base.CustomerPortfolioItemOut], dict[str, ops_base.TeamMemberOptionOut]]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    portfolio = portfolio_base._portfolio_payload(db, user, now=now)
    items_by_id = {item.customer_id: item for item in portfolio.items}
    recipients = [items_by_id[cid] for cid in campaign.customer_ids if cid in items_by_id]
    team_lookup = ops_base._team_lookup(db, user)
    return recipients, team_lookup


def _ensure_campaign_outbox_for_run(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None,
    campaign: portfolio_base.PortfolioCampaignOut,
    run_entry: dict[str, Any],
    template: Any = None,
    now: datetime | None = None,
) -> tuple[TenantSettings, int, int, list[str]]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    rows = _read_outbox_rows(settings_row)
    existing_keys = {
        (str(item.get("run_id") or ""), str(item.get("customer_id") or ""))
        for item in rows
        if str(item.get("run_id") or "").strip() and str(item.get("customer_id") or "").strip()
    }
    recipients, team_lookup = _campaign_recipients(db, user, campaign, now=now)
    assignee = team_lookup.get(campaign.assignee_user_id or "") if campaign.assignee_user_id else None
    if assignee is None:
        assignee = ops_base._pick_assignee_for_role(team_lookup, ops_base._normalize_owner_role(campaign.owner_role))
    assignee_user_id = assignee.id if assignee else (campaign.assignee_user_id or None)
    assignee_label = assignee.label if assignee else (campaign.assignee_label or campaign.assignee_email or None)
    assignee_email = assignee.email if assignee else campaign.assignee_email

    subject_template = getattr(template, "subject_template", None)
    body_template = getattr(template, "body_template", None)
    fallback_subject = (
        str(run_entry.get("preview_subject") or campaign.name or "Campagne portefeuille").strip()
        or "Campagne portefeuille"
    )
    fallback_body = (
        str(run_entry.get("preview_excerpt") or "Prépare le message portefeuille depuis l'outbox.").strip()
        or "Prépare le message portefeuille depuis l'outbox."
    )
    created_count = 0
    blocked_count = 0
    notes: list[str] = []

    if not recipients:
        notes.append("Aucun destinataire portefeuille n'a été retrouvé pour cette campagne.")
        return settings_row, created_count, blocked_count, notes

    for customer in recipients:
        key = (str(run_entry.get("id") or ""), customer.customer_id)
        if key in existing_keys:
            continue
        context = _build_recipient_context(
            _RecipientContext(campaign=campaign, customer=customer, assignee_label=assignee_label)
        )
        subject = _render_text(subject_template, context) if subject_template else fallback_subject
        body = _render_text(body_template, context) if body_template else fallback_body
        state = "draft" if customer.customer_email else "blocked"
        last_error = None if customer.customer_email else "Aucun email exploitable sur la fiche client."
        if state == "blocked":
            blocked_count += 1
        entry = {
            "id": f"obox_{uuid.uuid4().hex[:10]}",
            "run_id": str(run_entry.get("id") or ""),
            "campaign_id": campaign.id,
            "campaign_name": campaign.name,
            "customer_id": customer.customer_id,
            "customer_name": customer.customer_name,
            "customer_email": customer.customer_email,
            "segment_label": customer.segment_label,
            "risk_label": customer.risk_label,
            "state": state,
            "subject": subject,
            "body_preview": body[:1000],
            "owner_role": ops_base._normalize_owner_role(campaign.owner_role),
            "assignee_user_id": assignee_user_id,
            "assignee_email": assignee_email,
            "assignee_label": assignee_label,
            "notes": campaign.notes,
            "last_error": last_error,
            "delivery_mode": None,
            "attempt_count": 0,
            "last_attempt_at": None,
            "last_attempt_status": None,
            "href": "/app/outbox",
            "customer_href": customer.href,
            "scheduled_for": campaign.scheduled_for or now,
            "approved_at": None,
            "sent_at": None,
            "created_at": now,
            "updated_at": now,
        }
        rows.append(ops_base._serialize_dt_dict(entry, _OUTBOX_DT_KEYS))
        created_count += 1

    if created_count > 0:
        settings_row = _write_settings(db, settings_row, outbox=rows)
        notes.append(f"Outbox préparé : {created_count} ligne(s) dont {blocked_count} bloquée(s).")
    else:
        notes.append("Outbox déjà synchronisé pour ce run.")
    return settings_row, created_count, blocked_count, notes


def _find_campaign_by_id(
    db: Session, user: AuthUser, settings_row: TenantSettings | None, campaign_id: str, *, now: datetime | None = None
):
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    portfolio = portfolio_base._portfolio_payload(db, user, now=now)
    team_lookup = ops_base._team_lookup(db, user)
    campaigns = portfolio_base._portfolio_campaigns_out(settings_row, portfolio.items, team_lookup)
    return next((campaign for campaign in campaigns if campaign.id == campaign_id), None)


def _bulk_result(
    updated_count: int = 0,
    created_count: int = 0,
    blocked_count: int = 0,
    notes: list[str] | None = None,
    now: datetime | None = None,
) -> CampaignOutboxBulkResultOut:
    return CampaignOutboxBulkResultOut(
        updated_count=updated_count,
        created_count=created_count,
        blocked_count=blocked_count,
        notes=[str(item).strip() for item in (notes or []) if str(item).strip()],
        generated_at=now or datetime.now(timezone.utc).replace(tzinfo=None),
    )


def _approve_drafts_internal(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
) -> tuple[TenantSettings, int]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    rows = _read_outbox_rows(settings_row)
    updated_count = 0
    updated_rows: list[dict[str, Any]] = []
    for row in rows:
        hydrated = ops_base._hydrate_dt_dict(row, _OUTBOX_DT_KEYS)
        state = _normalize_outbox_state(str(hydrated.get("state") or "draft"))
        if state == "draft" and str(hydrated.get("customer_email") or "").strip():
            hydrated["state"] = "ready"
            hydrated["approved_at"] = now
            hydrated["updated_at"] = now
            hydrated["last_error"] = None
            updated_count += 1
        updated_rows.append(ops_base._serialize_dt_dict(hydrated, _OUTBOX_DT_KEYS))
    if updated_count > 0:
        settings_row = _write_settings(db, settings_row, outbox=updated_rows)
    return settings_row, updated_count


def _compose_delivery_text(item: CampaignOutboxItemOut) -> str:
    lines = []
    if item.body_preview:
        lines.append(item.body_preview)
    lines.append("")
    lines.append(f"Client : {item.customer_name}")
    if item.segment_label:
        lines.append(f"Segment : {item.segment_label}")
    if item.risk_label:
        lines.append(f"Risque : {item.risk_label}")
    if item.notes:
        lines.append(f"Note opérateur : {item.notes}")
    return "\n".join(lines).strip()


def _send_item_payload(
    row: dict[str, Any], *, now: datetime, effective_mode: str
) -> tuple[dict[str, Any], bool, str | None]:
    hydrated = ops_base._hydrate_dt_dict(row, _OUTBOX_DT_KEYS)
    item = _outbox_item_out(hydrated)
    hydrated["attempt_count"] = max(0, int(hydrated.get("attempt_count") or 0)) + 1
    hydrated["last_attempt_at"] = now
    hydrated["updated_at"] = now
    hydrated["delivery_mode"] = effective_mode
    if item.customer_email in {None, ""}:
        hydrated["state"] = "blocked"
        hydrated["last_attempt_status"] = "blocked"
        hydrated["last_error"] = "Aucun email exploitable sur la fiche client."
        return hydrated, False, hydrated["last_error"]
    try:
        if effective_mode == "smtp":
            assert item.customer_email is not None
            send_email(
                to=item.customer_email,
                subject=item.subject,
                text=_compose_delivery_text(item),
            )
            hydrated["last_attempt_status"] = "sent"
            hydrated["last_error"] = None
        else:
            hydrated["last_attempt_status"] = "logged"
            hydrated["last_error"] = None
        hydrated["state"] = "sent"
        hydrated["sent_at"] = now
        hydrated["approved_at"] = hydrated.get("approved_at") or now
        return hydrated, True, None
    except Exception:  # pragma: no cover - best effort SMTP integration
        message = "L’e-mail n’a pas pu être envoyé. Vérifiez le canal puis réessayez."
        logger.exception("Outbox SMTP send failed for %s", item.id)
        hydrated["state"] = "blocked"
        hydrated["last_attempt_status"] = "failed"
        hydrated["last_error"] = message[:300]
        return hydrated, False, message[:300]


def _dispatch_ready_internal(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    trigger: str = "manual",
    due_only: bool = False,
    now: datetime | None = None,
    force_mode: str | None = None,
) -> tuple[TenantSettings, CampaignOutboxDispatchResultOut]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    effective_mode, mode_label, smtp_ready, warnings = _smtp_mode(force_mode)
    rows = _read_outbox_rows(settings_row)
    queued_count = 0
    sent_count = 0
    failed_count = 0
    log_only_count = 0
    smtp_count = 0
    skipped_count = 0
    campaigns: set[str] = set()
    updated_rows: list[dict[str, Any]] = []

    for row in rows:
        hydrated = ops_base._hydrate_dt_dict(row, _OUTBOX_DT_KEYS)
        state = _normalize_outbox_state(str(hydrated.get("state") or "draft"))
        scheduled_for = ops_base._as_dt(hydrated.get("scheduled_for")) or now
        if state != "ready":
            updated_rows.append(ops_base._serialize_dt_dict(hydrated, _OUTBOX_DT_KEYS))
            continue
        if due_only and scheduled_for > now:
            skipped_count += 1
            updated_rows.append(ops_base._serialize_dt_dict(hydrated, _OUTBOX_DT_KEYS))
            continue
        queued_count += 1
        hydrated, success, error = _send_item_payload(hydrated, now=now, effective_mode=effective_mode)
        if success:
            sent_count += 1
            if effective_mode == "smtp":
                smtp_count += 1
            else:
                log_only_count += 1
            campaign_name = str(hydrated.get("campaign_name") or "").strip()
            if campaign_name:
                campaigns.add(campaign_name)
        else:
            failed_count += 1
            if error:
                warnings.append(f"Échec diffusion · {hydrated.get('customer_name') or 'Client'} · {error}")
        updated_rows.append(ops_base._serialize_dt_dict(hydrated, _OUTBOX_DT_KEYS))

    if queued_count <= 0:
        note = "Aucune ligne prête à diffuser." if not due_only else "Aucune ligne prête et due à diffuser."
        return settings_row, CampaignOutboxDispatchResultOut(
            queued_count=0,
            sent_count=0,
            failed_count=0,
            log_only_count=0,
            delivery_mode=effective_mode,
            delivery_mode_label=mode_label,
            notes=[note],
            dispatch=None,
            generated_at=now,
        )

    settings_row = _write_settings(db, settings_row, outbox=updated_rows)
    dispatch_rows = _read_dispatch_runs(settings_row)
    notes: list[str] = []
    if effective_mode == "smtp":
        notes.append("Diffusion SMTP exécutée sur les lignes prêtes.")
    else:
        notes.append("Diffusion journalisée : aucun SMTP réel n'est appelé dans ce mode.")
    if due_only:
        notes.append("Le batch a limité l'envoi aux lignes déjà dues.")
    if failed_count > 0:
        notes.append(f"{failed_count} ligne(s) ont échoué et restent à vérifier.")
    if warnings:
        notes.extend(warnings[:3])
    entry = {
        "id": f"odr_{uuid.uuid4().hex[:10]}",
        "trigger": "scheduler" if trigger == "scheduler" else "manual",
        "queued_count": queued_count,
        "sent_count": sent_count,
        "skipped_count": skipped_count,
        "failed_count": failed_count,
        "log_only_count": log_only_count,
        "smtp_count": smtp_count,
        "campaign_count": len(campaigns),
        "delivery_mode": effective_mode,
        "notes": notes,
        "generated_at": now,
        "href": "/app/outbox",
    }
    dispatch_rows.insert(0, ops_base._serialize_dt_dict(entry, _DISPATCH_DT_KEYS))
    dispatch_rows = dispatch_rows[:40]
    settings_row = _write_settings(db, settings_row, dispatch_runs=dispatch_rows)
    return settings_row, CampaignOutboxDispatchResultOut(
        queued_count=queued_count,
        sent_count=sent_count,
        failed_count=failed_count,
        log_only_count=log_only_count,
        delivery_mode=effective_mode,
        delivery_mode_label=mode_label,
        notes=notes,
        dispatch=_dispatch_run_out(entry),
        generated_at=now,
    )


def _send_single_item_internal(
    item_id: str,
    *,
    db: Session,
    user: AuthUser,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
    force_mode: str | None = None,
) -> tuple[TenantSettings, CampaignOutboxItemSendResultOut]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    effective_mode, mode_label, _smtp_ready, warnings = _smtp_mode(force_mode)
    rows = _read_outbox_rows(settings_row)
    found: dict[str, Any] | None = None
    updated_rows: list[dict[str, Any]] = []
    notes: list[str] = []
    for row in rows:
        hydrated = ops_base._hydrate_dt_dict(row, _OUTBOX_DT_KEYS)
        if str(hydrated.get("id") or "") != item_id:
            updated_rows.append(ops_base._serialize_dt_dict(hydrated, _OUTBOX_DT_KEYS))
            continue
        state = _normalize_outbox_state(str(hydrated.get("state") or "draft"))
        if state == "skipped":
            hydrated["state"] = "ready"
        if hydrated.get("customer_email") in {None, ""}:
            hydrated["state"] = "blocked"
        if hydrated.get("state") == "draft" and str(hydrated.get("customer_email") or "").strip():
            hydrated["state"] = "ready"
            hydrated["approved_at"] = now
        hydrated, success, error = _send_item_payload(hydrated, now=now, effective_mode=effective_mode)
        if success:
            notes.append("Ligne diffusée.")
            if effective_mode == "smtp":
                notes.append("Envoi SMTP confirmé.")
            else:
                notes.append("Diffusion journalisée sans SMTP réel.")
        elif error:
            notes.append(f"Échec diffusion : {error}")
        if warnings:
            notes.extend(warnings[:1])
        found = ops_base._serialize_dt_dict(hydrated, _OUTBOX_DT_KEYS)
        updated_rows.append(found)
    if found is None:
        raise HTTPException(404, "Ligne d'outbox introuvable.")
    settings_row = _write_settings(db, settings_row, outbox=updated_rows)
    stored = next((row for row in _read_outbox_rows(settings_row) if str(row.get("id") or "") == item_id), None)
    if stored is None:
        raise HTTPException(500, "Ligne d'outbox introuvable après diffusion.")
    return settings_row, CampaignOutboxItemSendResultOut(
        item=_outbox_item_out(stored),
        delivery_mode=effective_mode,
        delivery_mode_label=mode_label,
        notes=notes,
        generated_at=now,
    )


def _run_pipeline_internal(
    *,
    db: Session,
    user: AuthUser,
    settings_row: TenantSettings | None = None,
    trigger: str = "manual",
    now: datetime | None = None,
) -> tuple[TenantSettings, CampaignOutboxPipelineResultOut]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    from . import ops_campaigns as campaigns_base

    settings_row, workbench = campaigns_base._workbench_payload(db, user, settings_row=settings_row, now=now)
    due_items = [item for item in workbench.campaigns if item.due_now]
    campaign_runs: list[Any] = []
    notes: list[str] = []
    for item in due_items[:20]:
        try:
            settings_row, run, run_notes = campaigns_base._run_campaign_internal(
                item.campaign.id, trigger="scheduler", db=db, user=user, settings_row=settings_row, now=now
            )
            campaign_runs.append(run)
            notes.extend(run_notes[:2])
        except HTTPException as exc:
            notes.append(f"Campagne ignorée · {item.campaign.name} · {exc.detail}")
    settings_row, drafts_approved = _approve_drafts_internal(db, user, settings_row=settings_row, now=now)
    settings_row, dispatch_result = _dispatch_ready_internal(
        db, user, settings_row=settings_row, trigger=trigger, due_only=True, now=now, force_mode="auto"
    )
    scheduler_rows = _read_scheduler_runs(settings_row)
    scheduler_entry = {
        "id": f"ods_{uuid.uuid4().hex[:10]}",
        "trigger": "scheduler" if trigger == "scheduler" else "manual",
        "campaigns_processed": len(campaign_runs),
        "drafts_approved": drafts_approved,
        "sent_count": int(dispatch_result.sent_count or 0),
        "failed_count": int(dispatch_result.failed_count or 0),
        "log_only_count": int(dispatch_result.log_only_count or 0),
        "notes": (
            [f"{len(campaign_runs)} campagne(s) traitée(s).", f"{drafts_approved} brouillon(s) promu(s)."]
            + dispatch_result.notes
            + notes
        )[:8],
        "generated_at": now,
        "href": "/app/outbox",
    }
    scheduler_rows.insert(0, ops_base._serialize_dt_dict(scheduler_entry, _SCHEDULER_DT_KEYS))
    scheduler_rows = scheduler_rows[:40]
    settings_row = _write_settings(db, settings_row, scheduler_runs=scheduler_rows)
    return settings_row, CampaignOutboxPipelineResultOut(
        campaigns_processed=len(campaign_runs),
        drafts_approved=drafts_approved,
        sent_count=int(dispatch_result.sent_count or 0),
        failed_count=int(dispatch_result.failed_count or 0),
        log_only_count=int(dispatch_result.log_only_count or 0),
        notes=scheduler_entry["notes"],
        scheduler_run=_scheduler_run_out(scheduler_entry),
        generated_at=now,
    )


@router.get("/outbox", response_model=CampaignOutboxBoardOut)
def campaign_outbox(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    return _board_payload(db, user, settings_row=settings_row)


@router.patch("/outbox/{item_id}", response_model=CampaignOutboxItemOut)
def update_outbox_item(
    item_id: str,
    payload: CampaignOutboxPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    team_lookup = ops_base._team_lookup(db, user)
    rows = _read_outbox_rows(settings_row)
    updated_rows: list[dict[str, Any]] = []
    found = None
    for row in rows:
        hydrated = ops_base._hydrate_dt_dict(row, _OUTBOX_DT_KEYS)
        if str(hydrated.get("id") or "") != item_id:
            updated_rows.append(ops_base._serialize_dt_dict(hydrated, _OUTBOX_DT_KEYS))
            continue
        if payload.assignee_user_id is not None:
            assignee_id = str(payload.assignee_user_id or "").strip() or None
            if assignee_id and assignee_id not in team_lookup:
                raise HTTPException(400, "Utilisateur d'assignation invalide.")
            assignee = team_lookup.get(assignee_id or "") if assignee_id else None
            hydrated["assignee_user_id"] = assignee_id
            hydrated["assignee_email"] = assignee.email if assignee else None
            hydrated["assignee_label"] = assignee.label if assignee else None
        if payload.notes is not None:
            hydrated["notes"] = (payload.notes or "").strip() or None
        if payload.state is not None:
            state = _normalize_outbox_state(payload.state)
            if hydrated.get("customer_email") in {None, ""} and state == "ready":
                raise HTTPException(400, "Impossible de préparer un envoi sans email client.")
            if state == "sent":
                raise HTTPException(400, "Utilise l'action de diffusion pour marquer un envoi comme traité.")
            hydrated["state"] = state
            hydrated["approved_at"] = now if state == "ready" else hydrated.get("approved_at")
            if state in {"draft", "ready", "skipped", "blocked"}:
                hydrated["sent_at"] = None
            if state != "blocked":
                hydrated["last_error"] = None
        hydrated["updated_at"] = now
        found = ops_base._serialize_dt_dict(hydrated, _OUTBOX_DT_KEYS)
        updated_rows.append(found)
    if found is None:
        raise HTTPException(404, "Ligne d'outbox introuvable.")
    settings_row = _write_settings(db, settings_row, outbox=updated_rows)
    stored = next((row for row in _read_outbox_rows(settings_row) if str(row.get("id") or "") == item_id), None)
    if stored is None:
        raise HTTPException(500, "Ligne d'outbox introuvable après mise à jour.")
    return _outbox_item_out(stored)


@router.post("/outbox/rebuild", response_model=CampaignOutboxBulkResultOut)
def rebuild_outbox_from_recent_runs(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    notes: list[str] = []
    created_count = 0
    blocked_count = 0
    from . import ops_campaigns as campaigns_base

    templates = campaigns_base._templates_out(settings_row)
    run_rows = campaigns_base._read_campaign_runs(settings_row)[:12]
    if not run_rows:
        return _bulk_result(
            created_count=0, blocked_count=0, notes=["Aucun run de campagne récent à synchroniser."], now=now
        )
    for raw in run_rows:
        hydrated = ops_base._hydrate_dt_dict(raw, campaigns_base._RUN_DT_KEYS)
        campaign_id = str(hydrated.get("campaign_id") or "").strip()
        if not campaign_id:
            continue
        campaign = _find_campaign_by_id(db, user, settings_row, campaign_id, now=now)
        if campaign is None:
            continue
        template = campaigns_base._resolve_template(campaign.action_key, templates)
        settings_row, local_created, local_blocked, local_notes = _ensure_campaign_outbox_for_run(
            db,
            user,
            settings_row=settings_row,
            campaign=campaign,
            run_entry=hydrated,
            template=template,
            now=now,
        )
        created_count += local_created
        blocked_count += local_blocked
        notes.extend(local_notes[:1])
    if created_count <= 0 and not notes:
        notes.append("Aucune nouvelle ligne d'outbox à créer depuis les runs récents.")
    return _bulk_result(created_count=created_count, blocked_count=blocked_count, notes=notes, now=now)


@router.post("/outbox/approve-drafts", response_model=CampaignOutboxBulkResultOut)
def approve_outbox_drafts(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    settings_row, updated_count = _approve_drafts_internal(db, user, settings_row=settings_row, now=now)
    return _bulk_result(
        updated_count=updated_count,
        notes=[f"{updated_count} brouillon(s) prêts à diffuser."]
        if updated_count > 0
        else ["Aucun brouillon exploitable à promouvoir."],
        now=now,
    )


@router.post("/outbox/dispatch-ready", response_model=CampaignOutboxDispatchResultOut)
def dispatch_ready_outbox(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    _, result = _dispatch_ready_internal(
        db, user, settings_row=settings_row, trigger="manual", due_only=False, now=now, force_mode="auto"
    )
    return result


@router.post("/outbox/run-pipeline", response_model=CampaignOutboxPipelineResultOut)
def run_outbox_pipeline(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    _, result = _run_pipeline_internal(db=db, user=user, settings_row=settings_row, trigger="manual", now=now)
    return result


@router.post("/outbox/{item_id}/send", response_model=CampaignOutboxItemSendResultOut)
def send_single_outbox_item(
    item_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    _, result = _send_single_item_internal(
        item_id, db=db, user=user, settings_row=settings_row, now=now, force_mode="auto"
    )
    return result
