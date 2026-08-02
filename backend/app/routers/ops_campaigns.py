from __future__ import annotations

import copy
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_product_capability, require_viewer_or_admin
from ..models import TenantSettings
from . import ops as ops_base
from . import ops_portfolio as portfolio_base

router = APIRouter(
    prefix="/api/ops",
    tags=["ops"],
    dependencies=[Depends(require_product_capability("payments_enabled"))],
)

_PORTFOLIO_CAMPAIGN_TEMPLATE_STORE_KEY = "ops_portfolio_campaign_templates"
_PORTFOLIO_CAMPAIGN_RUN_STORE_KEY = "ops_portfolio_campaign_runs"
_TEMPLATE_DT_KEYS = {"created_at", "updated_at"}
_RUN_DT_KEYS = {"started_at", "finished_at"}
_ALLOWED_DISPATCH_MODES = {"email_preview", "task_push", "hybrid"}
_DISPATCH_MODE_LABELS = {
    "email_preview": "Emailing preview",
    "task_push": "Tâche opérateur",
    "hybrid": "Preview + tâche",
}
_RUN_STATUS_META = {
    "done": ("Traitée", "ok"),
    "partial": ("Partielle", "warn"),
    "skipped": ("Ignorée", "muted"),
}

_DEFAULT_TEMPLATE_SPECS: dict[str, dict[str, Any]] = {
    "dunning_call": {
        "name": "Relance du paiement portefeuille",
        "description": "Prépare un emailing de relance du paiement ciblé puis ouvre un suivi opérateur unique pour traiter la campagne.",
        "dispatch_mode": "hybrid",
        "owner_role": "accountant",
        "subject_template": "{campaign_name} · {recipient_count} client(s) · {overdue_balance} € en retard",
        "body_template": (
            "Bonjour,\n\n"
            "La campagne \"{campaign_name}\" cible {recipient_count} client(s) : {customer_names}.\n"
            "Retard portefeuille : {overdue_balance} € · Encours total : {open_balance} €.\n"
            "Segments : {segments}.\n\n"
            "Objectif : sécuriser une date de règlement ou un prochain point de contact.\n"
            "Préparation opérateur : {assignee_label}."
        ),
    },
    "payment_review": {
        "name": "Fiabilisation paiements",
        "description": "Prépare une campagne simple pour revoir références, modalités ou étapes de paiement sur les comptes ciblés.",
        "dispatch_mode": "email_preview",
        "owner_role": "accountant",
        "subject_template": "Paiements à fiabiliser · {recipient_count} client(s) · {open_balance} € ouverts",
        "body_template": (
            "Campagne {campaign_name}.\n\n"
            "Clients ciblés : {customer_names}.\n"
            "Encours ouvert : {open_balance} € · Retard : {overdue_balance} €.\n"
            "Le message doit clarifier la référence de paiement, le moyen attendu et la prochaine étape."
        ),
    },
    "account_review": {
        "name": "Revue comptes clés",
        "description": "Oriente l'équipe sur les comptes clés à suivre avant qu'une friction de facturation ou d'encaissement apparaisse.",
        "dispatch_mode": "task_push",
        "owner_role": "owner",
        "subject_template": "Comptes clés à revoir · {recipient_count} client(s)",
        "body_template": (
            "Revue portefeuille : {customer_names}.\n"
            "Segments : {segments}.\n"
            "Encours total : {open_balance} € · santé à préserver.\n"
            "Préparer une note courte avec la prochaine action par compte."
        ),
    },
    "reactivation": {
        "name": "Réactivation clients dormants",
        "description": "Prépare un message de réactivation simple avec un suivi opérateur pour les comptes dormants.",
        "dispatch_mode": "hybrid",
        "owner_role": "owner",
        "subject_template": "Réactivation portefeuille · {recipient_count} client(s) à relancer",
        "body_template": (
            "Campagne {campaign_name}.\n\n"
            "Clients à relancer : {customer_names}.\n"
            "Objectif : reprendre contact, proposer une prochaine étape et éviter la sortie complète du cycle."
        ),
    },
    "onboarding_check": {
        "name": "Suivi nouveaux clients",
        "description": "Cadre un brief d'onboarding pour les nouveaux clients du portefeuille et crée une action de validation interne.",
        "dispatch_mode": "hybrid",
        "owner_role": "accountant",
        "subject_template": "Nouveaux clients à consolider · {recipient_count} compte(s)",
        "body_template": (
            "Clients ciblés : {customer_names}.\n"
            "Encours : {open_balance} €.\n"
            "Vérifier le premier cycle, la qualité de paiement et la prochaine facture attendue."
        ),
    },
    "customer_review": {
        "name": "Revue santé portefeuille",
        "description": "Une trame légère pour faire une revue de santé par portefeuille sans multiplier les écrans.",
        "dispatch_mode": "task_push",
        "owner_role": "accountant",
        "subject_template": "Revue santé portefeuille · {recipient_count} client(s)",
        "body_template": (
            "Portefeuille ciblé : {customer_names}.\n"
            "Segments : {segments}.\n"
            "Encours : {open_balance} € · Retard : {overdue_balance} €.\n"
            "Préparer une prochaine action utile et un commentaire opérateur par client."
        ),
    },
}


def _portfolio_action_owner_role(action_key: str) -> str:
    spec = portfolio_base._ACTION_SPECS.get(action_key)
    return spec["owner_role"] if spec is not None else "accountant"


def _portfolio_action_priority(action_key: str) -> str:
    spec = portfolio_base._ACTION_SPECS.get(action_key)
    return spec["priority"] if spec is not None else "medium"


class PortfolioCampaignTemplateOut(BaseModel):
    id: str
    name: str
    action_key: str
    action_label: str
    description: str | None = None
    dispatch_mode: str
    dispatch_mode_label: str
    owner_role: str
    active: bool = True
    subject_template: str
    body_template: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PortfolioCampaignTemplateCreateRequest(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    action_key: str = Field(min_length=3, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    dispatch_mode: str = Field(default="email_preview", min_length=3, max_length=32)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    active: bool = True
    subject_template: str = Field(min_length=3, max_length=200)
    body_template: str = Field(min_length=3, max_length=4000)


class PortfolioCampaignTemplatePatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=3, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    dispatch_mode: str | None = Field(default=None, min_length=3, max_length=32)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    active: bool | None = None
    subject_template: str | None = Field(default=None, min_length=3, max_length=200)
    body_template: str | None = Field(default=None, min_length=3, max_length=4000)


class PortfolioCampaignRunOut(BaseModel):
    id: str
    campaign_id: str
    campaign_name: str
    action_key: str
    action_label: str
    trigger: str
    trigger_label: str
    status: str
    status_label: str
    tone: str
    template_id: str | None = None
    template_name: str | None = None
    dispatch_mode: str
    dispatch_mode_label: str
    recipients_count: int = 0
    email_ready_count: int = 0
    missing_email_count: int = 0
    tasks_created: int = 0
    notes: list[str] = Field(default_factory=list)
    preview_subject: str | None = None
    preview_excerpt: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    href: str = "/app/campaigns"


class PortfolioCampaignWorkbenchItemOut(BaseModel):
    campaign: portfolio_base.PortfolioCampaignOut
    template: PortfolioCampaignTemplateOut | None = None
    preview_subject: str | None = None
    preview_excerpt: str | None = None
    email_ready_count: int = 0
    missing_email_count: int = 0
    due_now: bool = False
    last_run_at: datetime | None = None
    last_run_status: str | None = None
    last_run_label: str | None = None


class PortfolioCampaignWorkbenchSummaryOut(BaseModel):
    total_campaigns: int = 0
    active_count: int = 0
    due_count: int = 0
    scheduled_count: int = 0
    templates_active_count: int = 0
    email_ready_count: int = 0
    recent_runs_count: int = 0
    tasks_created_7d: int = 0


class PortfolioCampaignWorkbenchOut(BaseModel):
    summary: PortfolioCampaignWorkbenchSummaryOut = Field(default_factory=PortfolioCampaignWorkbenchSummaryOut)
    campaigns: list[PortfolioCampaignWorkbenchItemOut] = Field(default_factory=list)
    templates: list[PortfolioCampaignTemplateOut] = Field(default_factory=list)
    recent_runs: list[PortfolioCampaignRunOut] = Field(default_factory=list)
    generated_at: datetime


class PortfolioCampaignRunBatchOut(BaseModel):
    processed_count: int = 0
    skipped_count: int = 0
    tasks_created: int = 0
    runs: list[PortfolioCampaignRunOut] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    generated_at: datetime


class DeleteResponse(BaseModel):
    ok: bool = True


PortfolioCampaignWorkbenchItemOut.model_rebuild()
PortfolioCampaignWorkbenchOut.model_rebuild()


def _write_campaign_features(
    db: Session,
    settings_row: TenantSettings,
    *,
    templates: list[dict[str, Any]] | None = None,
    runs: list[dict[str, Any]] | None = None,
) -> TenantSettings:
    features = ops_base._features(settings_row)
    if templates is not None:
        features[_PORTFOLIO_CAMPAIGN_TEMPLATE_STORE_KEY] = templates
    if runs is not None:
        features[_PORTFOLIO_CAMPAIGN_RUN_STORE_KEY] = runs
    settings_row.features = features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _read_campaign_templates(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = ops_base._features(settings_row).get(_PORTFOLIO_CAMPAIGN_TEMPLATE_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _read_campaign_runs(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = ops_base._features(settings_row).get(_PORTFOLIO_CAMPAIGN_RUN_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _normalize_dispatch_mode(value: str | None) -> str:
    normalized = (value or "email_preview").strip().lower()
    if normalized not in _ALLOWED_DISPATCH_MODES:
        raise HTTPException(400, "Mode de diffusion invalide.")
    return normalized


def _default_template_entry(action_key: str, *, now: datetime) -> dict[str, Any]:
    spec = _DEFAULT_TEMPLATE_SPECS.get(action_key)
    if spec is None:
        action = portfolio_base._ACTION_SPECS.get(action_key)
        if action is None:
            raise HTTPException(400, "Action de campagne invalide.")
        return {
            "id": f"pct_{uuid.uuid4().hex[:10]}",
            "name": str(action.get("label") or "Template portefeuille"),
            "action_key": action_key,
            "description": str(action.get("description") or ""),
            "dispatch_mode": "task_push",
            "owner_role": str(action.get("owner_role") or "accountant"),
            "active": True,
            "subject_template": "{campaign_name} · {recipient_count} client(s)",
            "body_template": "Clients ciblés : {customer_names}. Encours : {open_balance} €.",
            "created_at": now,
            "updated_at": now,
        }
    return {
        "id": f"pct_{uuid.uuid4().hex[:10]}",
        "name": str(spec["name"]),
        "action_key": action_key,
        "description": str(spec.get("description") or ""),
        "dispatch_mode": str(spec.get("dispatch_mode") or "email_preview"),
        "owner_role": str(spec.get("owner_role") or _portfolio_action_owner_role(action_key)),
        "active": True,
        "subject_template": str(spec.get("subject_template") or "{campaign_name}"),
        "body_template": str(spec.get("body_template") or "{customer_names}"),
        "created_at": now,
        "updated_at": now,
    }


def _ensure_seeded_templates(
    db: Session,
    settings_row: TenantSettings,
    *,
    now: datetime,
) -> tuple[TenantSettings, list[dict[str, Any]]]:
    existing = _read_campaign_templates(settings_row)
    if existing:
        return settings_row, existing
    seeded = [ops_base._serialize_dt_dict(_default_template_entry(action_key, now=now), _TEMPLATE_DT_KEYS) for action_key in portfolio_base._ACTION_SPECS.keys()]
    settings_row = _write_campaign_features(db, settings_row, templates=seeded)
    return settings_row, _read_campaign_templates(settings_row)


def _template_out(payload: dict[str, Any]) -> PortfolioCampaignTemplateOut:
    row = ops_base._hydrate_dt_dict(payload, _TEMPLATE_DT_KEYS)
    action_key = str(row.get("action_key") or "customer_review").strip()
    if action_key not in portfolio_base._ACTION_SPECS:
        action_key = "customer_review"
    action = portfolio_base._ACTION_SPECS[action_key]
    dispatch_mode = _normalize_dispatch_mode(str(row.get("dispatch_mode") or "email_preview"))
    return PortfolioCampaignTemplateOut(
        id=str(row.get("id") or f"pct_{uuid.uuid4().hex[:10]}"),
        name=(str(row.get("name") or "").strip() or str(action.get("label") or "Template portefeuille")),
        action_key=action_key,
        action_label=str(action.get("label") or action_key),
        description=(str(row.get("description") or "").strip() or None),
        dispatch_mode=dispatch_mode,
        dispatch_mode_label=_DISPATCH_MODE_LABELS.get(dispatch_mode, dispatch_mode),
        owner_role=ops_base._normalize_owner_role(str(row.get("owner_role") or action.get("owner_role") or "accountant")),
        active=bool(row.get("active", True)),
        subject_template=(str(row.get("subject_template") or "").strip() or "{campaign_name}"),
        body_template=(str(row.get("body_template") or "").strip() or "{customer_names}"),
        created_at=ops_base._as_dt(row.get("created_at")),
        updated_at=ops_base._as_dt(row.get("updated_at")),
    )


def _templates_out(settings_row: TenantSettings | None) -> list[PortfolioCampaignTemplateOut]:
    items = []
    for row in _read_campaign_templates(settings_row):
        try:
            items.append(_template_out(row))
        except HTTPException:
            continue
    items.sort(key=lambda item: (item.action_label.lower(), item.name.lower(), item.created_at or datetime.min))
    return items


def _resolve_template(action_key: str, templates: list[PortfolioCampaignTemplateOut]) -> PortfolioCampaignTemplateOut | None:
    same_action = [item for item in templates if item.action_key == action_key and item.active]
    if same_action:
        same_action.sort(key=lambda item: ((item.updated_at or item.created_at or datetime.min), item.name.lower()), reverse=True)
        return same_action[0]
    fallback = [item for item in templates if item.action_key == action_key]
    if fallback:
        fallback.sort(key=lambda item: ((item.updated_at or item.created_at or datetime.min), item.name.lower()), reverse=True)
        return fallback[0]
    return None


def _render_text(template: str, context: dict[str, Any]) -> str:
    out = str(template or "")
    for key, value in context.items():
        out = out.replace("{" + key + "}", str(value or ""))
    return out.strip()


def _campaign_preview(
    campaign: portfolio_base.PortfolioCampaignOut,
    template: PortfolioCampaignTemplateOut | None,
) -> tuple[str | None, str | None, int, int]:
    email_ready_count = int(campaign.customers_with_email or 0)
    missing_email_count = max(int(campaign.customer_count or 0) - email_ready_count, 0)
    preview_names = [item.customer_name for item in campaign.recipient_preview[:3] if item.customer_name]
    customer_names = ", ".join(preview_names)
    if int(campaign.customer_count or 0) > len(preview_names):
        customer_names = f"{customer_names}…" if customer_names else f"{campaign.customer_count} clients"
    if not customer_names:
        customer_names = f"{campaign.customer_count} clients"
    context = {
        "campaign_name": campaign.name,
        "action_label": campaign.action_label,
        "recipient_count": int(campaign.customer_count or 0),
        "customer_names": customer_names,
        "open_balance": int(campaign.open_balance or 0),
        "overdue_balance": int(campaign.overdue_balance or 0),
        "segments": ", ".join(campaign.segment_labels[:3]) or "Portefeuille ciblé",
        "assignee_label": campaign.assignee_label or campaign.assignee_email or ops_base._MODULE_LABELS.get(campaign.module, "Équipe"),
        "scheduled_for": ops_base._to_iso(campaign.scheduled_for) or "",
    }
    if template is None:
        subject = f"{campaign.name} · {campaign.customer_count or 0} client(s)"
        body = f"Clients ciblés : {customer_names}. Encours {int(campaign.open_balance or 0)} € · retard {int(campaign.overdue_balance or 0)} €."
    else:
        subject = _render_text(template.subject_template, context)
        body = _render_text(template.body_template, context)
    excerpt = body[:260] + ("…" if len(body) > 260 else "")
    return subject or None, excerpt or None, email_ready_count, missing_email_count


def _run_out(payload: dict[str, Any]) -> PortfolioCampaignRunOut:
    row = ops_base._hydrate_dt_dict(payload, _RUN_DT_KEYS)
    action_key = str(row.get("action_key") or "customer_review")
    action = portfolio_base._ACTION_SPECS.get(action_key, portfolio_base._ACTION_SPECS["customer_review"])
    status = str(row.get("status") or "done")
    if status not in _RUN_STATUS_META:
        status = "done"
    status_label, tone = _RUN_STATUS_META[status]
    trigger = str(row.get("trigger") or "manual")
    trigger_label = "Automatique" if trigger == "scheduler" else "Manuel"
    dispatch_mode = _normalize_dispatch_mode(str(row.get("dispatch_mode") or "email_preview"))
    notes = [str(item).strip() for item in row.get("notes") or [] if str(item).strip()]
    return PortfolioCampaignRunOut(
        id=str(row.get("id") or f"pcr_{uuid.uuid4().hex[:10]}"),
        campaign_id=str(row.get("campaign_id") or ""),
        campaign_name=str(row.get("campaign_name") or "Campagne portefeuille"),
        action_key=action_key,
        action_label=str(action.get("label") or action_key),
        trigger=trigger,
        trigger_label=trigger_label,
        status=status,
        status_label=status_label,
        tone=tone,
        template_id=(str(row.get("template_id") or "").strip() or None),
        template_name=(str(row.get("template_name") or "").strip() or None),
        dispatch_mode=dispatch_mode,
        dispatch_mode_label=_DISPATCH_MODE_LABELS.get(dispatch_mode, dispatch_mode),
        recipients_count=int(row.get("recipients_count") or 0),
        email_ready_count=int(row.get("email_ready_count") or 0),
        missing_email_count=int(row.get("missing_email_count") or 0),
        tasks_created=int(row.get("tasks_created") or 0),
        notes=notes,
        preview_subject=(str(row.get("preview_subject") or "").strip() or None),
        preview_excerpt=(str(row.get("preview_excerpt") or "").strip() or None),
        started_at=ops_base._as_dt(row.get("started_at")),
        finished_at=ops_base._as_dt(row.get("finished_at")),
        href=(str(row.get("href") or "").strip() or "/app/campaigns"),
    )


def _runs_out(settings_row: TenantSettings | None) -> list[PortfolioCampaignRunOut]:
    runs = []
    for row in _read_campaign_runs(settings_row):
        try:
            runs.append(_run_out(row))
        except HTTPException:
            continue
    runs.sort(key=lambda item: (item.finished_at or item.started_at or datetime.min), reverse=True)
    return runs


def _workbench_payload(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
) -> tuple[TenantSettings, PortfolioCampaignWorkbenchOut]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    settings_row, _ = _ensure_seeded_templates(db, settings_row, now=now)
    templates = _templates_out(settings_row)
    portfolio = portfolio_base._portfolio_payload(db, user, now=now)
    runs = _runs_out(settings_row)
    last_runs_by_campaign: dict[str, PortfolioCampaignRunOut] = {}
    for run in runs:
        if run.campaign_id and run.campaign_id not in last_runs_by_campaign:
            last_runs_by_campaign[run.campaign_id] = run

    campaign_items: list[PortfolioCampaignWorkbenchItemOut] = []
    summary = PortfolioCampaignWorkbenchSummaryOut(
        total_campaigns=len(portfolio.campaigns),
        templates_active_count=sum(1 for item in templates if item.active),
        recent_runs_count=len(runs[:10]),
    )
    seven_day_floor = now.timestamp() - (7 * 24 * 3600)
    for run in runs:
        finished = run.finished_at or run.started_at
        if finished and finished.timestamp() >= seven_day_floor:
            summary.tasks_created_7d += int(run.tasks_created or 0)

    for campaign in portfolio.campaigns:
        template = _resolve_template(campaign.action_key, templates)
        preview_subject, preview_excerpt, email_ready_count, missing_email_count = _campaign_preview(campaign, template)
        due_now = bool(campaign.status == "scheduled" and campaign.scheduled_for and campaign.scheduled_for <= now)
        last_run = last_runs_by_campaign.get(campaign.id)
        campaign_items.append(
            PortfolioCampaignWorkbenchItemOut(
                campaign=campaign,
                template=template,
                preview_subject=preview_subject,
                preview_excerpt=preview_excerpt,
                email_ready_count=email_ready_count,
                missing_email_count=missing_email_count,
                due_now=due_now,
                last_run_at=last_run.finished_at if last_run else None,
                last_run_status=last_run.status if last_run else None,
                last_run_label=last_run.status_label if last_run else None,
            )
        )
        if campaign.status in {"ready", "scheduled", "running"}:
            summary.active_count += 1
        if campaign.status == "scheduled":
            summary.scheduled_count += 1
        if due_now:
            summary.due_count += 1
        summary.email_ready_count += email_ready_count

    campaign_items.sort(
        key=lambda item: (
            0 if item.due_now else 1,
            {"running": 0, "scheduled": 1, "ready": 2, "draft": 3, "paused": 4, "done": 5}.get(item.campaign.status, 9),
            -((item.campaign.scheduled_for or item.campaign.updated_at or item.campaign.created_at or datetime.min).timestamp()),
            item.campaign.name.lower(),
        )
    )
    return settings_row, PortfolioCampaignWorkbenchOut(
        summary=summary,
        campaigns=campaign_items,
        templates=templates,
        recent_runs=runs[:8],
        generated_at=now,
    )


def _campaign_task_title(campaign: portfolio_base.PortfolioCampaignOut, template: PortfolioCampaignTemplateOut | None) -> str:
    if template and template.dispatch_mode == "email_preview":
        return f"Valider emailing portefeuille · {campaign.name}"
    if template and template.dispatch_mode == "hybrid":
        return f"Valider campagne portefeuille · {campaign.name}"
    return f"Traiter campagne portefeuille · {campaign.name}"


def _campaign_task_description(
    campaign: portfolio_base.PortfolioCampaignOut,
    template: PortfolioCampaignTemplateOut | None,
    *,
    preview_subject: str | None,
    preview_excerpt: str | None,
    email_ready_count: int,
    missing_email_count: int,
) -> str:
    lines = [
        f"Campagne : {campaign.name}",
        f"Action : {campaign.action_label}",
        f"Ciblage : {campaign.customer_count} client(s) · {int(campaign.open_balance or 0)} € ouverts · {int(campaign.overdue_balance or 0)} € en retard",
    ]
    if preview_subject:
        lines.append(f"Objet preview : {preview_subject}")
    if preview_excerpt:
        lines.append(f"Résumé message : {preview_excerpt}")
    lines.append(f"Emails exploitables : {email_ready_count} · sans email : {missing_email_count}")
    if template:
        lines.append(f"Mode : {template.dispatch_mode_label}")
    if campaign.segment_labels:
        lines.append(f"Segments : {', '.join(campaign.segment_labels[:4])}")
    names = [item.customer_name for item in campaign.recipient_preview[:4] if item.customer_name]
    if names:
        lines.append(f"Aperçu clients : {', '.join(names)}")
    if campaign.notes:
        lines.append(f"Note campagne : {campaign.notes}")
    lines.append("Ouvre /app/campaigns pour revoir le brief, les templates et l'historique d'exécution.")
    return "\n".join(lines)


def _run_campaign_internal(
    campaign_id: str,
    *,
    trigger: str,
    db: Session,
    user: AuthUser,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
) -> tuple[TenantSettings, PortfolioCampaignRunOut, list[str]]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    settings_row, workbench = _workbench_payload(db, user, settings_row=settings_row, now=now)
    item = next((entry for entry in workbench.campaigns if entry.campaign.id == campaign_id), None)
    if item is None:
        raise HTTPException(404, "Campagne portefeuille introuvable.")

    campaign = item.campaign
    template = item.template
    preview_subject = item.preview_subject
    preview_excerpt = item.preview_excerpt
    email_ready_count = int(item.email_ready_count or 0)
    missing_email_count = int(item.missing_email_count or 0)
    notes: list[str] = []
    run_status = "done"

    tasks_raw = ops_base._read_tasks(settings_row)
    team_lookup = ops_base._team_lookup(db, user)
    task_source_ref = f"campaign:{campaign.id}"
    open_task_exists = False
    for row in tasks_raw:
        hydrated = ops_base._hydrate_dt_dict(row, ops_base._TASK_DT_KEYS)
        if (
            str(hydrated.get("source_kind") or "") == "portfolio_campaign"
            and str(hydrated.get("source_ref") or "") == task_source_ref
            and str(hydrated.get("status") or "todo") != "done"
        ):
            open_task_exists = True
            break

    created_task_count = 0
    if open_task_exists:
        notes.append("Suivi déjà ouvert pour cette campagne.")
        run_status = "partial" if email_ready_count > 0 else "skipped"
    else:
        owner_role = ops_base._normalize_owner_role(campaign.owner_role or (template.owner_role if template else "accountant"))
        assignee_user_id = campaign.assignee_user_id
        if assignee_user_id and assignee_user_id not in team_lookup:
            assignee_user_id = None
        if assignee_user_id is None:
            assignee = ops_base._pick_assignee_for_role(team_lookup, owner_role)
            assignee_user_id = assignee.id if assignee else None
        priority = ops_base._normalize_task_priority(_portfolio_action_priority(campaign.action_key))
        task_payload = {
            "id": f"tsk_{uuid.uuid4().hex[:10]}",
            "title": _campaign_task_title(campaign, template),
            "description": _campaign_task_description(
                campaign,
                template,
                preview_subject=preview_subject,
                preview_excerpt=preview_excerpt,
                email_ready_count=email_ready_count,
                missing_email_count=missing_email_count,
            ),
            "module": campaign.module if campaign.module in ops_base._MODULE_LABELS else "tasks",
            "status": "todo",
            "priority": priority,
            "href": "/app/campaigns",
            "owner_role": owner_role,
            "assignee_user_id": assignee_user_id,
            "due_at": campaign.scheduled_for or now,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "source_kind": "portfolio_campaign",
            "source_ref": task_source_ref,
        }
        tasks_raw.append(ops_base._serialize_dt_dict(task_payload, ops_base._TASK_DT_KEYS))
        settings_row = ops_base._write_features(db, settings_row, tasks=tasks_raw)
        created_task_count = 1
        notes.append("Tâche opérateur créée.")

    if email_ready_count > 0:
        notes.append(f"{email_ready_count} client(s) ont un email exploitable pour la preview.")
    if missing_email_count > 0:
        notes.append(f"{missing_email_count} client(s) restent sans email exploitable.")
    if email_ready_count == 0:
        run_status = "partial" if created_task_count > 0 else "skipped"

    campaigns_raw = portfolio_base._read_portfolio_campaigns(settings_row)
    next_campaign_rows: list[dict[str, Any]] = []
    found_campaign = False
    for row in campaigns_raw:
        hydrated = ops_base._hydrate_dt_dict(row, portfolio_base._PORTFOLIO_CAMPAIGN_DT_KEYS)
        if str(hydrated.get("id") or "") != campaign.id:
            next_campaign_rows.append(row)
            continue
        found_campaign = True
        hydrated["status"] = "done"
        hydrated["started_at"] = hydrated.get("started_at") or now
        hydrated["completed_at"] = now
        hydrated["updated_at"] = now
        next_campaign_rows.append(ops_base._serialize_dt_dict(hydrated, portfolio_base._PORTFOLIO_CAMPAIGN_DT_KEYS))
    if not found_campaign:
        raise HTTPException(404, "Campagne portefeuille introuvable en stockage.")
    settings_row = portfolio_base._write_portfolio_campaigns(db, settings_row, next_campaign_rows)

    runs_raw = _read_campaign_runs(settings_row)
    run_entry = {
        "id": f"pcr_{uuid.uuid4().hex[:10]}",
        "campaign_id": campaign.id,
        "campaign_name": campaign.name,
        "action_key": campaign.action_key,
        "trigger": "scheduler" if trigger == "scheduler" else "manual",
        "status": run_status,
        "template_id": template.id if template else None,
        "template_name": template.name if template else None,
        "dispatch_mode": template.dispatch_mode if template else "email_preview",
        "recipients_count": int(campaign.customer_count or 0),
        "email_ready_count": email_ready_count,
        "missing_email_count": missing_email_count,
        "tasks_created": created_task_count,
        "notes": notes,
        "preview_subject": preview_subject,
        "preview_excerpt": preview_excerpt,
        "started_at": now,
        "finished_at": now,
        "href": "/app/campaigns",
    }
    from . import ops_outbox as outbox_base

    settings_row, prepared_count, blocked_count, outbox_notes = outbox_base._ensure_campaign_outbox_for_run(
        db,
        user,
        settings_row=settings_row,
        campaign=campaign,
        run_entry=run_entry,
        template=template,
        now=now,
    )
    if prepared_count > 0:
        notes.append(f"Outbox généré : {prepared_count} ligne(s).")
    if blocked_count > 0:
        notes.append(f"{blocked_count} ligne(s) d'outbox restent bloquées faute d'email.")
    for entry in outbox_notes[:2]:
        if entry and entry not in notes:
            notes.append(entry)
    run_entry["notes"] = notes

    runs_raw.insert(0, ops_base._serialize_dt_dict(run_entry, _RUN_DT_KEYS))
    runs_raw = runs_raw[:40]
    settings_row = _write_campaign_features(db, settings_row, runs=runs_raw)
    return settings_row, _run_out(run_entry), notes


@router.get("/portfolio-campaign-workbench", response_model=PortfolioCampaignWorkbenchOut)
def portfolio_campaign_workbench(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    _, payload = _workbench_payload(db, user, settings_row=settings_row)
    return payload


@router.get("/portfolio-campaign-templates", response_model=list[PortfolioCampaignTemplateOut])
def portfolio_campaign_templates(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    settings_row, _ = _ensure_seeded_templates(db, settings_row, now=now)
    return _templates_out(settings_row)


@router.post("/portfolio-campaign-templates", response_model=PortfolioCampaignTemplateOut)
def create_portfolio_campaign_template(
    payload: PortfolioCampaignTemplateCreateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    if payload.action_key not in portfolio_base._ACTION_SPECS:
        raise HTTPException(400, "Action de campagne invalide.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    settings_row, templates_raw = _ensure_seeded_templates(db, settings_row, now=now)
    entry = {
        "id": f"pct_{uuid.uuid4().hex[:10]}",
        "name": payload.name.strip(),
        "action_key": payload.action_key,
        "description": (payload.description or "").strip() or None,
        "dispatch_mode": _normalize_dispatch_mode(payload.dispatch_mode),
        "owner_role": ops_base._normalize_owner_role(payload.owner_role or portfolio_base._ACTION_SPECS[payload.action_key].get("owner_role") or "accountant"),
        "active": bool(payload.active),
        "subject_template": payload.subject_template.strip(),
        "body_template": payload.body_template.strip(),
        "created_at": now,
        "updated_at": now,
    }
    templates_raw.append(ops_base._serialize_dt_dict(entry, _TEMPLATE_DT_KEYS))
    settings_row = _write_campaign_features(db, settings_row, templates=templates_raw)
    stored = next((row for row in _read_campaign_templates(settings_row) if str(row.get("id") or "") == entry["id"]), None)
    if stored is None:
        raise HTTPException(500, "Template introuvable après création.")
    return _template_out(stored)


@router.patch("/portfolio-campaign-templates/{template_id}", response_model=PortfolioCampaignTemplateOut)
def update_portfolio_campaign_template(
    template_id: str,
    payload: PortfolioCampaignTemplatePatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    settings_row, templates_raw = _ensure_seeded_templates(db, settings_row, now=now)
    fields_set = set(getattr(payload, "model_fields_set", getattr(payload, "__fields_set__", set())))
    found = False
    next_rows: list[dict[str, Any]] = []
    for row in templates_raw:
        hydrated = ops_base._hydrate_dt_dict(row, _TEMPLATE_DT_KEYS)
        if str(hydrated.get("id") or "") != template_id:
            next_rows.append(row)
            continue
        found = True
        if "name" in fields_set:
            name = (payload.name or "").strip()
            if not name:
                raise HTTPException(400, "Le nom du template ne peut pas être vide.")
            hydrated["name"] = name
        if "description" in fields_set:
            hydrated["description"] = (payload.description or "").strip() or None
        if "dispatch_mode" in fields_set:
            hydrated["dispatch_mode"] = _normalize_dispatch_mode(payload.dispatch_mode)
        if "owner_role" in fields_set:
            hydrated["owner_role"] = ops_base._normalize_owner_role(payload.owner_role or hydrated.get("owner_role") or "accountant")
        if "active" in fields_set:
            hydrated["active"] = bool(payload.active)
        if "subject_template" in fields_set:
            subject = (payload.subject_template or "").strip()
            if not subject:
                raise HTTPException(400, "L'objet du template ne peut pas être vide.")
            hydrated["subject_template"] = subject
        if "body_template" in fields_set:
            body = (payload.body_template or "").strip()
            if not body:
                raise HTTPException(400, "Le corps du template ne peut pas être vide.")
            hydrated["body_template"] = body
        hydrated["updated_at"] = now
        next_rows.append(ops_base._serialize_dt_dict(hydrated, _TEMPLATE_DT_KEYS))
    if not found:
        raise HTTPException(404, "Template introuvable.")
    settings_row = _write_campaign_features(db, settings_row, templates=next_rows)
    stored = next((row for row in _read_campaign_templates(settings_row) if str(row.get("id") or "") == template_id), None)
    if stored is None:
        raise HTTPException(500, "Template introuvable après mise à jour.")
    return _template_out(stored)


@router.delete("/portfolio-campaign-templates/{template_id}", response_model=DeleteResponse)
def delete_portfolio_campaign_template(
    template_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    templates_raw = _read_campaign_templates(settings_row)
    next_rows = [row for row in templates_raw if str(row.get("id") or "") != template_id]
    if len(next_rows) == len(templates_raw):
        raise HTTPException(404, "Template introuvable.")
    _write_campaign_features(db, settings_row, templates=next_rows)
    return DeleteResponse(ok=True)


@router.post("/portfolio-campaigns/{campaign_id}/run", response_model=PortfolioCampaignRunOut)
def run_portfolio_campaign(
    campaign_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    _, run, _ = _run_campaign_internal(campaign_id, trigger="manual", db=db, user=user, settings_row=settings_row)
    return run


@router.post("/portfolio-campaigns/run-due", response_model=PortfolioCampaignRunBatchOut)
def run_due_portfolio_campaigns(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    settings_row, payload = _workbench_payload(db, user, settings_row=settings_row, now=now)
    due_items = [item for item in payload.campaigns if item.due_now]
    processed: list[PortfolioCampaignRunOut] = []
    notes: list[str] = []
    tasks_created = 0
    skipped_count = 0
    for item in due_items[:20]:
        try:
            settings_row, run, run_notes = _run_campaign_internal(item.campaign.id, trigger="scheduler", db=db, user=user, settings_row=settings_row, now=now)
            processed.append(run)
            tasks_created += int(run.tasks_created or 0)
            notes.extend(run_notes[:3])
        except HTTPException as exc:
            skipped_count += 1
            notes.append(f"Campagne ignorée · {item.campaign.name} · {exc.detail}")
    if not due_items:
        notes.append("Aucune campagne programmée à exécuter maintenant.")
    return PortfolioCampaignRunBatchOut(
        processed_count=len(processed),
        skipped_count=skipped_count,
        tasks_created=tasks_created,
        runs=processed,
        notes=notes[:8],
        generated_at=now,
    )
