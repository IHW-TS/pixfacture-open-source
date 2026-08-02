from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, TypedDict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_product_feature, require_viewer_or_admin
from ..models import ActionLog, Customer, Invoice, Payment, Quote, TenantSettings
from . import ops as ops_base

router = APIRouter(
    prefix="/api/ops",
    tags=["ops"],
    dependencies=[Depends(require_product_feature("payments_enabled"))],
)

_SEGMENT_LABELS = {
    "top_accounts": "Comptes clés",
    "at_risk": "À risque",
    "watchlist": "Sous surveillance",
    "new_business": "Nouveaux clients",
    "dormant": "Dormants",
    "stable": "Stables",
}
_SEGMENT_TONES = {
    "top_accounts": "purple",
    "at_risk": "danger",
    "watchlist": "warn",
    "new_business": "info",
    "dormant": "muted",
    "stable": "ok",
}
_RISK_LABELS = {
    "critical": "Critique",
    "high": "Haute",
    "medium": "Modérée",
    "low": "Basse",
}
_RISK_TONES = {
    "critical": "danger",
    "high": "warn",
    "medium": "info",
    "low": "ok",
}
class _ActionSpec(TypedDict):
    label: str
    description: str
    module: str
    priority: str
    owner_role: str
    due_in_days: int
    applies_to_segments: list[str]


class _SegmentStats(TypedDict):
    count: int
    open_balance: Decimal
    overdue_balance: Decimal
    revenue_12m: Decimal
    scores: list[int]


_ACTION_SPECS: dict[str, _ActionSpec] = {
    "dunning_call": {
        "label": "Lancer la relance du paiement",
        "description": "Créer une action de recouvrement ciblée pour sécuriser une date de règlement et éviter que l'encours ne continue de dériver.",
        "module": "collections",
        "priority": "high",
        "owner_role": "accountant",
        "due_in_days": 1,
        "applies_to_segments": ["at_risk", "watchlist"],
    },
    "payment_review": {
        "label": "Fiabiliser le paiement",
        "description": "Préparer une revue des références, modalités de paiement ou prochaines relances pour rendre l'encaissement plus prévisible.",
        "module": "payments",
        "priority": "medium",
        "owner_role": "accountant",
        "due_in_days": 2,
        "applies_to_segments": ["at_risk", "watchlist", "new_business", "top_accounts"],
    },
    "account_review": {
        "label": "Revue compte clé",
        "description": "Organiser un suivi plus proactif du compte pour préserver la valeur créée et éviter les frictions de facturation ou d'encaissement.",
        "module": "tasks",
        "priority": "medium",
        "owner_role": "owner",
        "due_in_days": 5,
        "applies_to_segments": ["top_accounts", "stable"],
    },
    "reactivation": {
        "label": "Réactivation commerciale",
        "description": "Créer une tâche simple pour relancer un client dormant avant qu'il ne sorte complètement du cycle devis / facture.",
        "module": "tasks",
        "priority": "medium",
        "owner_role": "owner",
        "due_in_days": 5,
        "applies_to_segments": ["dormant"],
    },
    "onboarding_check": {
        "label": "Suivi nouveau client",
        "description": "Valider le démarrage : premier cycle, qualité de paiement, documents et prochaines étapes pour transformer l'essai.",
        "module": "tasks",
        "priority": "medium",
        "owner_role": "accountant",
        "due_in_days": 3,
        "applies_to_segments": ["new_business"],
    },
    "customer_review": {
        "label": "Revue santé client",
        "description": "Créer un rappel simple pour revoir la santé du compte et la prochaine action utile sans perdre le contexte du portefeuille.",
        "module": "tasks",
        "priority": "low",
        "owner_role": "accountant",
        "due_in_days": 7,
        "applies_to_segments": ["at_risk", "watchlist", "top_accounts", "new_business", "dormant", "stable"],
    },
}

_PORTFOLIO_CAMPAIGN_STORE_KEY = "ops_portfolio_campaigns"
_PORTFOLIO_CAMPAIGN_DT_KEYS = {"created_at", "updated_at", "scheduled_for", "started_at", "completed_at"}
_CAMPAIGN_STATUS_META = {
    "draft": ("Brouillon", "muted"),
    "ready": ("Prête", "info"),
    "scheduled": ("Programmée", "purple"),
    "running": ("En cours", "warn"),
    "done": ("Traitée", "ok"),
    "paused": ("En pause", "muted"),
}
_TIMELINE_KIND_META = {
    "customer": ("Client", "info"),
    "quote": ("Devis", "info"),
    "invoice": ("Facture", "info"),
    "payment": ("Paiement", "ok"),
    "overdue": ("Retard", "danger"),
    "task": ("Tâche", "purple"),
    "campaign": ("Campagne", "purple"),
    "portal": ("Portail", "info"),
    "followup": ("Relance", "warn"),
}


def _spec_due_in_days(spec: _ActionSpec) -> int | None:
    due_in_days = spec["due_in_days"]
    return due_in_days or None


class CustomerPortfolioItemOut(BaseModel):
    customer_id: str
    customer_name: str
    customer_email: str | None = None
    segment: str
    segment_label: str
    segment_tone: str
    risk_level: str
    risk_label: str
    risk_tone: str
    health_score: int = 0
    health_label: str
    lifetime_revenue: Decimal = Decimal("0")
    revenue_12m: Decimal = Decimal("0")
    open_balance: Decimal = Decimal("0")
    overdue_balance: Decimal = Decimal("0")
    overdue_invoice_count: int = 0
    unpaid_invoice_count: int = 0
    invoice_count_total: int = 0
    invoice_count_12m: int = 0
    payment_count_12m: int = 0
    average_days_to_pay: float | None = None
    max_overdue_days: int = 0
    days_since_last_invoice: int | None = None
    days_since_last_payment: int | None = None
    days_since_last_activity: int | None = None
    last_invoice_at: datetime | None = None
    last_payment_at: datetime | None = None
    last_activity_at: datetime | None = None
    next_step_title: str
    next_step_description: str | None = None
    href: str


class CustomerPortfolioSegmentOut(BaseModel):
    key: str
    label: str
    tone: str
    count: int = 0
    open_balance: Decimal = Decimal("0")
    overdue_balance: Decimal = Decimal("0")
    revenue_12m: Decimal = Decimal("0")
    average_health_score: float | None = None


class CustomerPortfolioSummaryOut(BaseModel):
    total_customers: int = 0
    active_customers: int = 0
    top_accounts_count: int = 0
    at_risk_count: int = 0
    watchlist_count: int = 0
    dormant_count: int = 0
    new_business_count: int = 0
    portfolio_health_score: float | None = None
    open_balance: Decimal = Decimal("0")
    overdue_balance: Decimal = Decimal("0")
    revenue_12m: Decimal = Decimal("0")
    customers_with_overdue: int = 0


class PortfolioTaskSummaryOut(BaseModel):
    open_count: int = 0
    overdue_count: int = 0
    due_this_week_count: int = 0
    unassigned_count: int = 0
    done_recent_count: int = 0


class PortfolioActionTemplateOut(BaseModel):
    key: str
    label: str
    description: str
    module: str
    module_label: str
    priority: str
    owner_role: str
    due_in_days: int | None = None
    href: str
    applies_to_segments: list[str] = Field(default_factory=list)


class CustomerPortfolioOut(BaseModel):
    summary: CustomerPortfolioSummaryOut = Field(default_factory=CustomerPortfolioSummaryOut)
    segments: list[CustomerPortfolioSegmentOut] = Field(default_factory=list)
    items: list[CustomerPortfolioItemOut] = Field(default_factory=list)
    top_risk: list[CustomerPortfolioItemOut] = Field(default_factory=list)
    top_accounts: list[CustomerPortfolioItemOut] = Field(default_factory=list)
    dormant_candidates: list[CustomerPortfolioItemOut] = Field(default_factory=list)
    action_templates: list[PortfolioActionTemplateOut] = Field(default_factory=list)
    campaign_summary: PortfolioCampaignSummaryOut = Field(default_factory=lambda: PortfolioCampaignSummaryOut())
    campaigns: list[PortfolioCampaignOut] = Field(default_factory=list)
    assignees: list[ops_base.TeamMemberOptionOut] = Field(default_factory=list)
    generated_at: datetime


class CustomerPortfolioDetailOut(BaseModel):
    item: CustomerPortfolioItemOut
    peer_items: list[CustomerPortfolioItemOut] = Field(default_factory=list)
    actions: list[PortfolioActionTemplateOut] = Field(default_factory=list)
    assignees: list[ops_base.TeamMemberOptionOut] = Field(default_factory=list)
    task_summary: PortfolioTaskSummaryOut = Field(default_factory=PortfolioTaskSummaryOut)
    active_tasks: list[ops_base.OpsTaskOut] = Field(default_factory=list)
    campaigns: list[PortfolioCampaignOut] = Field(default_factory=list)
    timeline: list[PortfolioTimelineEventOut] = Field(default_factory=list)
    generated_at: datetime


class PortfolioCampaignSummaryOut(BaseModel):
    total_count: int = 0
    active_count: int = 0
    scheduled_count: int = 0
    done_count: int = 0
    targeted_customers_count: int = 0
    open_balance: Decimal = Decimal("0")
    overdue_balance: Decimal = Decimal("0")


class PortfolioCampaignRecipientOut(BaseModel):
    customer_id: str
    customer_name: str
    customer_email: str | None = None
    segment_label: str
    risk_label: str
    open_balance: Decimal = Decimal("0")
    overdue_balance: Decimal = Decimal("0")
    href: str


class PortfolioCampaignOut(BaseModel):
    id: str
    name: str
    action_key: str
    action_label: str
    module: str
    module_label: str
    status: str
    status_label: str
    tone: str
    owner_role: str
    assignee_user_id: str | None = None
    assignee_email: str | None = None
    assignee_label: str | None = None
    notes: str | None = None
    scheduled_for: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    customer_count: int = 0
    customers_with_email: int = 0
    open_balance: Decimal = Decimal("0")
    overdue_balance: Decimal = Decimal("0")
    segment_labels: list[str] = Field(default_factory=list)
    customer_ids: list[str] = Field(default_factory=list)
    recipient_preview: list[PortfolioCampaignRecipientOut] = Field(default_factory=list)
    href: str = "/app/portfolio"


class PortfolioTimelineEventOut(BaseModel):
    id: str
    occurred_at: datetime
    kind: str
    kind_label: str
    tone: str
    title: str
    subtitle: str | None = None
    description: str | None = None
    href: str | None = None


class PortfolioCampaignCreateRequest(BaseModel):
    customer_ids: list[str] = Field(default_factory=list)
    action_key: str = Field(min_length=3, max_length=80)
    name: str | None = Field(default=None, max_length=140)
    status: str | None = Field(default=None, min_length=3, max_length=32)
    assignee_user_id: str | None = Field(default=None, max_length=64)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    scheduled_for: datetime | None = None
    notes: str | None = Field(default=None, max_length=500)


class PortfolioCampaignPatchRequest(BaseModel):
    name: str | None = Field(default=None, max_length=140)
    status: str | None = Field(default=None, min_length=3, max_length=32)
    assignee_user_id: str | None = Field(default=None, max_length=64)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    scheduled_for: datetime | None = None
    notes: str | None = Field(default=None, max_length=500)


class PortfolioTaskCreateRequest(BaseModel):
    customer_ids: list[str] = Field(default_factory=list)
    action_key: str = Field(min_length=3, max_length=80)
    assignee_user_id: str | None = Field(default=None, max_length=64)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    due_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=500)


class PortfolioTaskCreateResponse(BaseModel):
    created_count: int = 0
    skipped_count: int = 0
    tasks: list[ops_base.OpsTaskOut] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    generated_at: datetime


CustomerPortfolioOut.model_rebuild()
CustomerPortfolioDetailOut.model_rebuild()


def _fmt_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except Exception:
        return Decimal("0")


def _days_since(value: datetime | None, now: datetime) -> int | None:
    if not value:
        return None
    delta = now - value
    return max(int(delta.days), 0)


def _health_label(score: int) -> str:
    if score >= 85:
        return "Très sain"
    if score >= 70:
        return "Sain"
    if score >= 55:
        return "À suivre"
    if score >= 35:
        return "Fragile"
    return "Critique"


def _next_step(segment: str, *, overdue_invoice_count: int, unpaid_invoice_count: int, max_overdue_days: int) -> tuple[str, str | None]:
    if segment == "at_risk":
        if overdue_invoice_count > 0:
            return (
                f"Relancer {overdue_invoice_count} facture(s) en retard",
                f"Le compte cumule {max_overdue_days} jour(s) de retard max. Sécurise la date de règlement ou propose un plan d'action.",
            )
        return ("Sécuriser le compte", "Le portefeuille montre un risque fort malgré peu d'échéances échues visibles.")
    if segment == "watchlist":
        return (
            "Fiabiliser l'encours ouvert",
            f"{unpaid_invoice_count} facture(s) restent ouvertes. Vérifie le lien public, les références et la prochaine relance.",
        )
    if segment == "dormant":
        return ("Réactiver le compte", "Aucune activité récente détectée. Prévois une relance commerciale ou un check-in client.")
    if segment == "new_business":
        return ("Consolider le démarrage", "Premier cycle en cours : vérifie la qualité de paiement et sécurise le prochain document.")
    if segment == "top_accounts":
        return ("Préserver le compte clé", "Compte fort du portefeuille : garde une lecture simple de l'encours et du rythme de facturation.")
    return ("Continuer le suivi", "Le compte est sain. Garde une revue légère avec les autres priorités du portefeuille.")


def _action_template(key: str, *, href: str | None = None) -> PortfolioActionTemplateOut:
    spec = _ACTION_SPECS[key]
    module = str(spec["module"])
    return PortfolioActionTemplateOut(
        key=key,
        label=str(spec["label"]),
        description=str(spec["description"]),
        module=module,
        module_label=ops_base._MODULE_LABELS.get(module, "Tâches"),
        priority=str(spec["priority"]),
        owner_role=str(spec["owner_role"]),
        due_in_days=_spec_due_in_days(spec),
        href=href or ops_base._MODULE_DEFAULT_HREFS.get(module, "/app/tasks"),
        applies_to_segments=list(spec["applies_to_segments"]),
    )


def _default_action_templates() -> list[PortfolioActionTemplateOut]:
    ordered = [
        "dunning_call",
        "payment_review",
        "account_review",
        "reactivation",
        "onboarding_check",
        "customer_review",
    ]
    return [_action_template(key) for key in ordered]


def _actions_for_item(item: CustomerPortfolioItemOut) -> list[PortfolioActionTemplateOut]:
    keys: list[str] = []
    if item.segment == "at_risk":
        keys.extend(["dunning_call", "payment_review", "customer_review"])
    elif item.segment == "watchlist":
        keys.extend(["payment_review", "dunning_call", "customer_review"])
    elif item.segment == "top_accounts":
        keys.extend(["account_review", "payment_review", "customer_review"])
    elif item.segment == "dormant":
        keys.extend(["reactivation", "customer_review"])
    elif item.segment == "new_business":
        keys.extend(["onboarding_check", "payment_review", "customer_review"])
    else:
        keys.extend(["customer_review", "account_review"])

    if item.overdue_balance > 0 and "dunning_call" not in keys:
        keys.insert(0, "dunning_call")
    if item.open_balance > 0 and "payment_review" not in keys:
        keys.insert(min(1, len(keys)), "payment_review")

    seen: set[str] = set()
    href = item.href or f"/app/customers/{item.customer_id}"
    out: list[PortfolioActionTemplateOut] = []
    for key in keys:
        if key in seen or key not in _ACTION_SPECS:
            continue
        seen.add(key)
        out.append(_action_template(key, href=href))
    return out[:4]


def _task_relates_to_customer(payload: dict[str, Any], customer_id: str, *, href: str | None = None) -> bool:
    row = ops_base._hydrate_dt_dict(payload, ops_base._TASK_DT_KEYS)
    source_kind = str(row.get("source_kind") or "").strip()
    source_ref = str(row.get("source_ref") or "").strip()
    if source_kind == "portfolio_action" and source_ref.endswith(f":{customer_id}"):
        return True
    task_href = str(row.get("href") or "").strip()
    if href and task_href == href:
        return True
    return task_href.endswith(f"/app/customers/{customer_id}")


def _portfolio_task_summary(tasks: list[ops_base.OpsTaskOut], now: datetime) -> PortfolioTaskSummaryOut:
    summary = PortfolioTaskSummaryOut()
    recent_done_floor = now - timedelta(days=30)
    for task in tasks:
        if task.status == "done":
            if task.completed_at and task.completed_at >= recent_done_floor:
                summary.done_recent_count += 1
            continue
        summary.open_count += 1
        if not task.assignee_user_id:
            summary.unassigned_count += 1
        if task.due_at and task.due_at <= now:
            summary.overdue_count += 1
        if task.due_at and task.due_at <= (now + timedelta(days=7)):
            summary.due_this_week_count += 1
    return summary


def _customer_related_tasks(
    settings_row: TenantSettings | None,
    team_lookup: dict[str, ops_base.TeamMemberOptionOut],
    *,
    customer_id: str,
    href: str | None,
    now: datetime,
) -> tuple[PortfolioTaskSummaryOut, list[ops_base.OpsTaskOut]]:
    if settings_row is None:
        return PortfolioTaskSummaryOut(), []

    matched: list[ops_base.OpsTaskOut] = []
    for raw in ops_base._read_tasks(settings_row):
        if not _task_relates_to_customer(raw, customer_id, href=href):
            continue
        try:
            matched.append(ops_base._task_out(raw, team_lookup))
        except HTTPException:
            continue

    open_tasks = sorted([task for task in matched if task.status != "done"], key=lambda task: ops_base._task_sort_key(task, now))[:6]
    return _portfolio_task_summary(matched, now), open_tasks


def _task_copy_for_action(item: CustomerPortfolioItemOut, action_key: str) -> tuple[str, str, str, str, str, int | None]:
    if action_key not in _ACTION_SPECS:
        raise HTTPException(400, "Action portefeuille invalide.")
    spec = _ACTION_SPECS[action_key]
    if action_key == "dunning_call":
        title = f"Relance du paiement · {item.customer_name}"
        description = (
            f"Compte {item.segment_label.lower()} · {item.overdue_balance} € en retard · "
            f"{item.max_overdue_days} jour(s) de retard max. {item.next_step_description or ''}"
        ).strip()
    elif action_key == "payment_review":
        average = f"{item.average_days_to_pay} j" if item.average_days_to_pay is not None else "—"
        description = (
            f"Encours ouvert {item.open_balance} € · paiement moyen {average}. {item.next_step_description or ''}"
        ).strip()
        title = f"Fiabiliser l'encaissement · {item.customer_name}"
    elif action_key == "account_review":
        title = f"Revue compte clé · {item.customer_name}"
        description = f"CA 12 mois {item.revenue_12m} € · santé {item.health_score}/100. Préserver la qualité du compte et anticiper les frictions."
    elif action_key == "reactivation":
        delay = item.days_since_last_activity or item.days_since_last_invoice or 0
        title = f"Réactivation client · {item.customer_name}"
        description = f"Client dormant · environ {delay} jour(s) depuis la dernière activité visible. Préparer une relance commerciale simple."
    elif action_key == "onboarding_check":
        title = f"Suivi nouveau client · {item.customer_name}"
        description = (
            f"Démarrage à consolider · {item.invoice_count_total} facture(s) · santé {item.health_score}/100. "
            "Vérifier le prochain document et la qualité de paiement."
        )
    else:
        title = f"Revue santé client · {item.customer_name}"
        description = f"Segment {item.segment_label.lower()} · risque {item.risk_label.lower()} · prochaine étape : {item.next_step_title}."
    return (
        title,
        description,
        str(spec["module"]),
        str(spec["priority"]),
        str(spec["owner_role"]),
        _spec_due_in_days(spec),
    )


def _normalize_campaign_status(value: str | None) -> str:
    normalized = (value or "ready").strip().lower()
    if normalized not in _CAMPAIGN_STATUS_META:
        raise HTTPException(400, "Statut de campagne portefeuille invalide.")
    return normalized


def _read_portfolio_campaigns(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = ops_base._features(settings_row).get(_PORTFOLIO_CAMPAIGN_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _write_portfolio_campaigns(
    db: Session,
    settings_row: TenantSettings,
    campaigns: list[dict[str, Any]],
) -> TenantSettings:
    features = ops_base._features(settings_row)
    features[_PORTFOLIO_CAMPAIGN_STORE_KEY] = campaigns
    settings_row.features = features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _campaign_name_default(action_key: str, items: list[CustomerPortfolioItemOut]) -> str:
    spec = _ACTION_SPECS.get(action_key)
    label = spec["label"] if spec is not None else "Campagne portefeuille"
    if len(items) == 1:
        return f"{label} · {items[0].customer_name}"
    return f"{label} · {len(items)} clients"


def _campaign_out(
    payload: dict[str, Any],
    items_by_id: dict[str, CustomerPortfolioItemOut],
    team_lookup: dict[str, ops_base.TeamMemberOptionOut],
) -> PortfolioCampaignOut:
    row = ops_base._hydrate_dt_dict(payload, _PORTFOLIO_CAMPAIGN_DT_KEYS)
    action_key = str(row.get("action_key") or "customer_review")
    template = _action_template(action_key, href="/app/campaigns") if action_key in _ACTION_SPECS else _action_template("customer_review", href="/app/campaigns")
    status = _normalize_campaign_status(str(row.get("status") or ("scheduled" if row.get("scheduled_for") else "ready")))
    status_label, tone = _CAMPAIGN_STATUS_META[status]
    customer_ids = []
    for value in row.get("customer_ids") or []:
        cid = str(value or "").strip()
        if cid and cid not in customer_ids:
            customer_ids.append(cid)
    selected_items = [items_by_id[cid] for cid in customer_ids if cid in items_by_id]
    preview = [
        PortfolioCampaignRecipientOut(
            customer_id=item.customer_id,
            customer_name=item.customer_name,
            customer_email=item.customer_email,
            segment_label=item.segment_label,
            risk_label=item.risk_label,
            open_balance=item.open_balance,
            overdue_balance=item.overdue_balance,
            href=item.href,
        )
        for item in selected_items[:4]
    ]
    assignee_user_id = (str(row.get("assignee_user_id") or "").strip() or None)
    assignee = team_lookup.get(assignee_user_id) if assignee_user_id else None
    segment_labels = []
    for item in selected_items:
        if item.segment_label not in segment_labels:
            segment_labels.append(item.segment_label)
    return PortfolioCampaignOut(
        id=str(row.get("id") or f"pc_{uuid.uuid4().hex[:10]}"),
        name=(str(row.get("name") or "").strip() or _campaign_name_default(action_key, selected_items or list(items_by_id.values())[:1])),
        action_key=action_key,
        action_label=template.label,
        module=template.module,
        module_label=template.module_label,
        status=status,
        status_label=status_label,
        tone=tone,
        owner_role=ops_base._normalize_owner_role(str(row.get("owner_role") or template.owner_role)),
        assignee_user_id=assignee_user_id,
        assignee_email=assignee.email if assignee else None,
        assignee_label=assignee.label if assignee else None,
        notes=(str(row.get("notes") or "").strip() or None),
        scheduled_for=ops_base._as_dt(row.get("scheduled_for")),
        created_at=ops_base._as_dt(row.get("created_at")),
        updated_at=ops_base._as_dt(row.get("updated_at")),
        started_at=ops_base._as_dt(row.get("started_at")),
        completed_at=ops_base._as_dt(row.get("completed_at")),
        customer_count=len(selected_items),
        customers_with_email=sum(1 for item in selected_items if item.customer_email),
        open_balance=sum((item.open_balance for item in selected_items), Decimal("0")),
        overdue_balance=sum((item.overdue_balance for item in selected_items), Decimal("0")),
        segment_labels=segment_labels[:4],
        customer_ids=customer_ids,
        recipient_preview=preview,
        href="/app/campaigns",
    )


def _portfolio_campaigns_out(
    settings_row: TenantSettings | None,
    items: list[CustomerPortfolioItemOut],
    team_lookup: dict[str, ops_base.TeamMemberOptionOut],
) -> list[PortfolioCampaignOut]:
    items_by_id = {item.customer_id: item for item in items}
    campaigns: list[PortfolioCampaignOut] = []
    for raw in _read_portfolio_campaigns(settings_row):
        try:
            campaign = _campaign_out(raw, items_by_id, team_lookup)
        except HTTPException:
            continue
        if campaign.customer_count <= 0:
            continue
        campaigns.append(campaign)
    campaigns.sort(
        key=lambda row: (
            {"running": 0, "scheduled": 1, "ready": 2, "draft": 3, "paused": 4, "done": 5}.get(row.status, 9),
            -(row.scheduled_for or row.updated_at or row.created_at or datetime.min).timestamp(),
            row.name.lower(),
        )
    )
    return campaigns


def _campaign_summary(campaigns: list[PortfolioCampaignOut]) -> PortfolioCampaignSummaryOut:
    summary = PortfolioCampaignSummaryOut()
    targeted: set[str] = set()
    for campaign in campaigns:
        summary.total_count += 1
        if campaign.status in {"ready", "scheduled", "running"}:
            summary.active_count += 1
        if campaign.status == "scheduled":
            summary.scheduled_count += 1
        if campaign.status == "done":
            summary.done_count += 1
        summary.open_balance += campaign.open_balance
        summary.overdue_balance += campaign.overdue_balance
        for customer_id in campaign.customer_ids:
            targeted.add(customer_id)
    summary.targeted_customers_count = len(targeted)
    return summary


def _timeline_event(
    *,
    event_id: str,
    occurred_at: datetime | None,
    kind: str,
    title: str,
    subtitle: str | None = None,
    description: str | None = None,
    href: str | None = None,
) -> PortfolioTimelineEventOut | None:
    when = ops_base._as_dt(occurred_at)
    if when is None:
        return None
    kind_label, tone = _TIMELINE_KIND_META.get(kind, ("Événement", "muted"))
    return PortfolioTimelineEventOut(
        id=event_id,
        occurred_at=when,
        kind=kind,
        kind_label=kind_label,
        tone=tone,
        title=title,
        subtitle=subtitle,
        description=description,
        href=href,
    )


def _customer_timeline(
    db: Session,
    user: AuthUser,
    customer: Customer,
    item: CustomerPortfolioItemOut,
    settings_row: TenantSettings | None,
    team_lookup: dict[str, ops_base.TeamMemberOptionOut],
    campaigns: list[PortfolioCampaignOut],
    now: datetime,
) -> list[PortfolioTimelineEventOut]:
    events: list[PortfolioTimelineEventOut] = []

    def push(event: PortfolioTimelineEventOut | None) -> None:
        if event is not None:
            events.append(event)

    push(
        _timeline_event(
            event_id=f"customer-{customer.id}",
            occurred_at=customer.created_at,
            kind="customer",
            title="Client créé",
            subtitle=customer.name,
            description="La fiche client est entrée dans le portefeuille et sert de point de départ à la relation devis / facture / encaissement.",
            href=item.href,
        )
    )

    invoices = (
        db.query(Invoice)
        .filter(Invoice.tenant_id == user.tenant_id, Invoice.customer_id == customer.id)
        .order_by(Invoice.issue_date.desc(), Invoice.created_at.desc())
        .limit(16)
        .all()
    )
    invoice_lookup = {invoice.id: invoice for invoice in invoices}
    invoice_ids = list(invoice_lookup.keys())
    quotes = (
        db.query(Quote)
        .filter(Quote.tenant_id == user.tenant_id, Quote.customer_id == customer.id)
        .order_by(Quote.issue_date.desc(), Quote.created_at.desc())
        .limit(12)
        .all()
    )
    payments = (
        db.query(Payment)
        .filter(Payment.invoice_id.in_(invoice_ids))
        .order_by(Payment.date.desc(), Payment.created_at.desc())
        .limit(16)
        .all()
        if invoice_ids
        else []
    )

    for quote in quotes:
        quote_label = quote.number or quote.id
        push(
            _timeline_event(
                event_id=f"quote-create-{quote.id}",
                occurred_at=quote.issue_date or quote.created_at,
                kind="quote",
                title=f"Devis {quote_label}",
                subtitle=f"{quote.status or 'draft'} · {quote.total_inc_vat or 0} €",
                description="Le devis est visible dans l'historique client pour garder une lecture chronologique claire.",
                href=f"/app/quotes/{quote.id}",
            )
        )
        if quote.sent_at:
            push(
                _timeline_event(
                    event_id=f"quote-send-{quote.id}",
                    occurred_at=quote.sent_at,
                    kind="quote",
                    title=f"Devis envoyé · {quote_label}",
                    subtitle=customer.name,
                    description="Le devis a été marqué comme envoyé ou partagé, et le suivi commercial peut continuer sans changer d'écran.",
                    href=f"/app/quotes/{quote.id}",
                )
            )
        if quote.accepted_at:
            push(
                _timeline_event(
                    event_id=f"quote-accept-{quote.id}",
                    occurred_at=quote.accepted_at,
                    kind="quote",
                    title=f"Devis accepté · {quote_label}",
                    subtitle=customer.name,
                    description="Le devis a été validé et peut maintenant nourrir le cycle de facturation.",
                    href=f"/app/quotes/{quote.id}",
                )
            )

    for invoice in invoices:
        invoice_label = invoice.number or invoice.id
        outstanding = Decimal(str(invoice.total_inc_vat or 0)) - sum((Decimal(str(payment.amount or 0)) for payment in payments if payment.invoice_id == invoice.id), Decimal("0"))
        outstanding = max(outstanding, Decimal("0"))
        push(
            _timeline_event(
                event_id=f"invoice-create-{invoice.id}",
                occurred_at=invoice.issue_date or invoice.created_at,
                kind="invoice",
                title=f"Facture {invoice_label}",
                subtitle=f"{invoice.status or 'draft'} · {invoice.total_inc_vat or 0} €",
                description="La facture est entrée dans l'historique client pour garder une vue métier cohérente.",
                href=f"/app/invoices/{invoice.id}",
            )
        )
        if invoice.due_date and outstanding > 0 and ((invoice.status or "").lower() == "overdue" or invoice.due_date <= now):
            push(
                _timeline_event(
                    event_id=f"invoice-overdue-{invoice.id}",
                    occurred_at=invoice.due_date,
                    kind="overdue",
                    title=f"Échéance dépassée · {invoice_label}",
                    subtitle=f"{outstanding} € à encaisser",
                    description="Le portefeuille remonte ce point comme signal cash prioritaire.",
                    href=f"/app/invoices/{invoice.id}",
                )
            )

    for payment in payments:
        invoice = invoice_lookup.get(payment.invoice_id)
        invoice_label = invoice.number if invoice and invoice.number else payment.invoice_id
        details = " · ".join(part for part in [payment.method, payment.reference] if part)
        push(
            _timeline_event(
                event_id=f"payment-{payment.id}",
                occurred_at=payment.date or payment.created_at,
                kind="payment",
                title=f"Paiement reçu · {invoice_label}",
                subtitle=f"{payment.amount or 0} €",
                description=details or "Encaissement enregistré sur le compte client.",
                href=f"/app/invoices/{payment.invoice_id}",
            )
        )

    log_rows = (
        db.query(ActionLog)
        .filter(
            ActionLog.tenant_id == user.tenant_id,
            ActionLog.entity == "customer",
            ActionLog.entity_id == customer.id,
            ActionLog.action.in_(["customer_portal_enable", "customer_portal_rotate", "customer_portal_disable"]),
        )
        .order_by(ActionLog.created_at.desc())
        .limit(8)
        .all()
    )
    portal_titles = {
        "customer_portal_enable": "Portail client activé",
        "customer_portal_rotate": "Lien portail régénéré",
        "customer_portal_disable": "Portail client désactivé",
    }
    for log in log_rows:
        push(
            _timeline_event(
                event_id=f"portal-{log.id}",
                occurred_at=log.created_at,
                kind="portal",
                title=portal_titles.get(log.action, "Portail client"),
                subtitle=customer.name,
                description="Le portail public du client a été mis à jour depuis la fiche compte.",
                href=item.href,
            )
        )

    if invoice_ids:
        reminder_logs = (
            db.query(ActionLog)
            .filter(
                ActionLog.tenant_id == user.tenant_id,
                ActionLog.entity == "invoice",
                ActionLog.entity_id.in_(invoice_ids),
                ActionLog.action == "remind",
            )
            .order_by(ActionLog.created_at.desc())
            .limit(8)
            .all()
        )
        for log in reminder_logs:
            invoice = invoice_lookup.get(log.entity_id)
            invoice_label = invoice.number if invoice and invoice.number else log.entity_id
            push(
                _timeline_event(
                    event_id=f"followup-{log.id}",
                    occurred_at=log.created_at,
                    kind="followup",
                    title=f"Relance envoyée · {invoice_label}",
                    subtitle=customer.name,
                    description="Une relance a été journalisée sur une facture de ce client.",
                    href=f"/app/invoices/{log.entity_id}",
                )
            )

    if settings_row is not None:
        for raw in ops_base._read_tasks(settings_row):
            if not _task_relates_to_customer(raw, customer.id, href=item.href):
                continue
            try:
                task = ops_base._task_out(raw, team_lookup)
            except HTTPException:
                continue
            push(
                _timeline_event(
                    event_id=f"task-open-{task.id}",
                    occurred_at=task.created_at or task.updated_at,
                    kind="task",
                    title=task.title,
                    subtitle=f"{task.status_label} · {task.module_label}",
                    description=task.description,
                    href=task.href or "/app/tasks",
                )
            )
            if task.completed_at:
                push(
                    _timeline_event(
                        event_id=f"task-done-{task.id}",
                        occurred_at=task.completed_at,
                        kind="task",
                        title=f"Tâche clôturée · {task.title}",
                        subtitle=task.assignee_label or task.assignee_email or "Équipe",
                        description="Le suivi opérateur lié à ce client a été clôturé.",
                        href=task.href or "/app/tasks",
                    )
                )

    for campaign in campaigns:
        push(
            _timeline_event(
                event_id=f"campaign-{campaign.id}",
                occurred_at=campaign.created_at or campaign.updated_at,
                kind="campaign",
                title=campaign.name,
                subtitle=f"{campaign.status_label} · {campaign.action_label}",
                description=campaign.notes or f"Campagne portefeuille ciblant {campaign.customer_count} client(s).",
                href=campaign.href,
            )
        )
        if campaign.completed_at:
            push(
                _timeline_event(
                    event_id=f"campaign-done-{campaign.id}",
                    occurred_at=campaign.completed_at,
                    kind="campaign",
                    title=f"Campagne clôturée · {campaign.name}",
                    subtitle=campaign.action_label,
                    description="Le pilotage portefeuille garde aussi la trace des campagnes terminées.",
                    href=campaign.href,
                )
            )

    events.sort(key=lambda event: (event.occurred_at, event.title.lower()), reverse=True)
    return events[:18]


def _portfolio_payload(db: Session, user: AuthUser, now: datetime | None = None) -> CustomerPortfolioOut:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    window_12m = now - timedelta(days=365)

    customers = (
        db.query(Customer)
        .filter(Customer.tenant_id == user.tenant_id)
        .order_by(Customer.name.asc())
        .all()
    )
    invoices = (
        db.query(Invoice)
        .filter(Invoice.tenant_id == user.tenant_id, Invoice.type == "invoice")
        .all()
    )

    credit_rows = (
        db.query(Invoice.related_invoice_id, func.coalesce(func.sum(Invoice.total_inc_vat), 0))
        .filter(
            Invoice.tenant_id == user.tenant_id,
            Invoice.type == "credit_note",
            Invoice.related_invoice_id.isnot(None),
        )
        .group_by(Invoice.related_invoice_id)
        .all()
    )
    credits_by_invoice = {
        str(invoice_id): abs(_fmt_decimal(total or 0))
        for invoice_id, total in credit_rows
        if invoice_id
    }

    payment_rows = (
        db.query(Payment, Invoice.customer_id, Invoice.issue_date)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id, Invoice.type == "invoice")
        .all()
    )

    payments_by_invoice: dict[str, Decimal] = {}
    by_customer: dict[str, dict[str, Any]] = {}
    for customer in customers:
        by_customer[customer.id] = {
            "customer": customer,
            "lifetime_revenue": Decimal("0"),
            "revenue_12m": Decimal("0"),
            "open_balance": Decimal("0"),
            "overdue_balance": Decimal("0"),
            "overdue_invoice_count": 0,
            "unpaid_invoice_count": 0,
            "invoice_count_total": 0,
            "invoice_count_12m": 0,
            "payment_count_12m": 0,
            "last_invoice_at": None,
            "last_payment_at": None,
            "last_activity_at": customer.created_at,
            "delay_samples": [],
            "max_overdue_days": 0,
        }

    for payment, customer_id, issue_date in payment_rows:
        invoice_id = str(payment.invoice_id)
        amount = _fmt_decimal(payment.amount)
        payments_by_invoice[invoice_id] = payments_by_invoice.get(invoice_id, Decimal("0")) + amount
        bucket = by_customer.get(customer_id)
        if not bucket:
            continue
        if payment.date and payment.date >= window_12m:
            bucket["payment_count_12m"] += 1
        if payment.date and (bucket["last_payment_at"] is None or payment.date > bucket["last_payment_at"]):
            bucket["last_payment_at"] = payment.date
        if payment.date and (bucket["last_activity_at"] is None or payment.date > bucket["last_activity_at"]):
            bucket["last_activity_at"] = payment.date
        if payment.date and issue_date:
            bucket["delay_samples"].append(max(0, (payment.date.date() - issue_date.date()).days))

    for invoice in invoices:
        bucket = by_customer.get(invoice.customer_id)
        if not bucket:
            continue
        total = _fmt_decimal(invoice.total_inc_vat)
        balance = total - credits_by_invoice.get(invoice.id, Decimal("0")) - payments_by_invoice.get(invoice.id, Decimal("0"))
        if balance < 0:
            balance = Decimal("0")
        issue_at = invoice.issue_date or invoice.created_at
        bucket["invoice_count_total"] += 1
        bucket["lifetime_revenue"] += total
        if issue_at and issue_at >= window_12m:
            bucket["revenue_12m"] += total
            bucket["invoice_count_12m"] += 1
        if issue_at and (bucket["last_invoice_at"] is None or issue_at > bucket["last_invoice_at"]):
            bucket["last_invoice_at"] = issue_at
        if issue_at and (bucket["last_activity_at"] is None or issue_at > bucket["last_activity_at"]):
            bucket["last_activity_at"] = issue_at
        if balance > 0:
            bucket["open_balance"] += balance
            bucket["unpaid_invoice_count"] += 1
            updated_at = invoice.updated_at or issue_at
            if updated_at and (bucket["last_activity_at"] is None or updated_at > bucket["last_activity_at"]):
                bucket["last_activity_at"] = updated_at
        if balance > 0 and invoice.due_date and invoice.due_date < now:
            days_overdue = max((now.date() - invoice.due_date.date()).days, 0)
            bucket["overdue_balance"] += balance
            bucket["overdue_invoice_count"] += 1
            bucket["max_overdue_days"] = max(int(bucket["max_overdue_days"] or 0), days_overdue)

    revenue_candidates = [bucket for bucket in by_customer.values() if bucket["revenue_12m"] > 0]
    revenue_candidates.sort(
        key=lambda item: (item["revenue_12m"], item["lifetime_revenue"], item["invoice_count_total"]),
        reverse=True,
    )
    top_cutoff = max(1, min(8, int(len(revenue_candidates) * 0.2) or 1)) if revenue_candidates else 0
    top_account_ids = {bucket["customer"].id for bucket in revenue_candidates[:top_cutoff]}

    items: list[CustomerPortfolioItemOut] = []
    summary = CustomerPortfolioSummaryOut(total_customers=len(customers))
    segment_stats: dict[str, _SegmentStats] = {
        key: {
            "count": 0,
            "open_balance": Decimal("0"),
            "overdue_balance": Decimal("0"),
            "revenue_12m": Decimal("0"),
            "scores": [],
        }
        for key in _SEGMENT_LABELS
    }

    for bucket in by_customer.values():
        customer = bucket["customer"]
        last_invoice_at = bucket["last_invoice_at"]
        last_payment_at = bucket["last_payment_at"]
        last_activity_at = bucket["last_activity_at"]
        days_since_last_invoice = _days_since(last_invoice_at, now)
        days_since_last_payment = _days_since(last_payment_at, now)
        days_since_last_activity = _days_since(last_activity_at, now)
        average_days_to_pay = round(sum(bucket["delay_samples"]) / len(bucket["delay_samples"]), 1) if bucket["delay_samples"] else None

        created_days = _days_since(customer.created_at, now) if customer.created_at else None
        is_recent = (days_since_last_invoice is not None and days_since_last_invoice <= 60) or (created_days is not None and created_days <= 45 and bucket["invoice_count_total"] <= 2)
        is_dormant = (
            bucket["open_balance"] <= 0
            and (
                (days_since_last_invoice is not None and days_since_last_invoice >= 120)
                or (bucket["invoice_count_total"] == 0 and created_days is not None and created_days >= 45)
            )
        )
        is_at_risk = bucket["overdue_balance"] > 0 and (
            bucket["max_overdue_days"] >= 15
            or bucket["overdue_balance"] >= Decimal("1500")
            or bucket["overdue_invoice_count"] >= 2
        )
        is_watchlist = not is_at_risk and (
            bucket["overdue_balance"] > 0
            or (bucket["open_balance"] > 0 and bucket["unpaid_invoice_count"] >= 1)
        )

        if is_at_risk:
            segment = "at_risk"
        elif is_watchlist:
            segment = "watchlist"
        elif customer.id in top_account_ids:
            segment = "top_accounts"
        elif is_recent:
            segment = "new_business"
        elif is_dormant:
            segment = "dormant"
        else:
            segment = "stable"

        health_score = 88
        if customer.id in top_account_ids and bucket["overdue_balance"] <= 0:
            health_score += 8
        if segment == "new_business":
            health_score += 4
        if segment == "dormant":
            health_score -= 18
        if bucket["open_balance"] > 0:
            health_score -= min(22, int(bucket["open_balance"] / Decimal("900")) + bucket["unpaid_invoice_count"] * 6)
        if bucket["overdue_balance"] > 0:
            health_score -= min(50, int(bucket["overdue_balance"] / Decimal("450")) + bucket["overdue_invoice_count"] * 10 + int(bucket["max_overdue_days"] / 7) * 4)
        if average_days_to_pay is not None:
            if average_days_to_pay > 45:
                health_score -= 12
            elif average_days_to_pay <= 25:
                health_score += 5
        if days_since_last_invoice is not None and days_since_last_invoice > 180:
            health_score -= 15
        health_score = max(10, min(int(health_score), 99))

        if segment == "at_risk" or health_score < 35:
            risk_level = "critical" if bucket["max_overdue_days"] >= 30 or bucket["overdue_balance"] >= Decimal("3000") else "high"
        elif segment == "watchlist" or health_score < 55:
            risk_level = "high"
        elif segment in {"new_business", "dormant"} or health_score < 75:
            risk_level = "medium"
        else:
            risk_level = "low"

        next_step_title, next_step_description = _next_step(
            segment,
            overdue_invoice_count=bucket["overdue_invoice_count"],
            unpaid_invoice_count=bucket["unpaid_invoice_count"],
            max_overdue_days=bucket["max_overdue_days"],
        )

        item = CustomerPortfolioItemOut(
            customer_id=customer.id,
            customer_name=customer.name,
            customer_email=customer.email,
            segment=segment,
            segment_label=_SEGMENT_LABELS[segment],
            segment_tone=_SEGMENT_TONES[segment],
            risk_level=risk_level,
            risk_label=_RISK_LABELS[risk_level],
            risk_tone=_RISK_TONES[risk_level],
            health_score=health_score,
            health_label=_health_label(health_score),
            lifetime_revenue=bucket["lifetime_revenue"],
            revenue_12m=bucket["revenue_12m"],
            open_balance=bucket["open_balance"],
            overdue_balance=bucket["overdue_balance"],
            overdue_invoice_count=bucket["overdue_invoice_count"],
            unpaid_invoice_count=bucket["unpaid_invoice_count"],
            invoice_count_total=bucket["invoice_count_total"],
            invoice_count_12m=bucket["invoice_count_12m"],
            payment_count_12m=bucket["payment_count_12m"],
            average_days_to_pay=average_days_to_pay,
            max_overdue_days=int(bucket["max_overdue_days"] or 0),
            days_since_last_invoice=days_since_last_invoice,
            days_since_last_payment=days_since_last_payment,
            days_since_last_activity=days_since_last_activity,
            last_invoice_at=last_invoice_at,
            last_payment_at=last_payment_at,
            last_activity_at=last_activity_at,
            next_step_title=next_step_title,
            next_step_description=next_step_description,
            href=f"/app/customers/{customer.id}",
        )
        items.append(item)

        summary.open_balance += item.open_balance
        summary.overdue_balance += item.overdue_balance
        summary.revenue_12m += item.revenue_12m
        if item.invoice_count_total > 0:
            summary.active_customers += 1
        if item.overdue_balance > 0:
            summary.customers_with_overdue += 1
        if segment == "top_accounts":
            summary.top_accounts_count += 1
        elif segment == "at_risk":
            summary.at_risk_count += 1
        elif segment == "watchlist":
            summary.watchlist_count += 1
        elif segment == "dormant":
            summary.dormant_count += 1
        elif segment == "new_business":
            summary.new_business_count += 1

        stats = segment_stats[segment]
        stats["count"] += 1
        stats["open_balance"] += item.open_balance
        stats["overdue_balance"] += item.overdue_balance
        stats["revenue_12m"] += item.revenue_12m
        stats["scores"].append(item.health_score)

    items.sort(
        key=lambda row: (
            {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(row.risk_level, 9),
            -float(row.overdue_balance),
            -float(row.open_balance),
            row.customer_name.lower(),
        )
    )
    if items:
        summary.portfolio_health_score = round(sum(item.health_score for item in items) / len(items), 1)

    segments = []
    for key in ["at_risk", "watchlist", "top_accounts", "new_business", "dormant", "stable"]:
        scores = segment_stats[key]["scores"]
        segments.append(
            CustomerPortfolioSegmentOut(
                key=key,
                label=_SEGMENT_LABELS[key],
                tone=_SEGMENT_TONES[key],
                count=segment_stats[key]["count"],
                open_balance=segment_stats[key]["open_balance"],
                overdue_balance=segment_stats[key]["overdue_balance"],
                revenue_12m=segment_stats[key]["revenue_12m"],
                average_health_score=round(sum(scores) / len(scores), 1) if scores else None,
            )
        )

    top_risk = sorted(
        [item for item in items if item.segment in {"at_risk", "watchlist"}],
        key=lambda item: (
            {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(item.risk_level, 9),
            -float(item.overdue_balance),
            -float(item.open_balance),
            -(item.max_overdue_days or 0),
        ),
    )[:6]
    top_accounts = sorted(
        [item for item in items if item.segment == "top_accounts"],
        key=lambda item: (float(item.revenue_12m), float(item.lifetime_revenue), item.health_score),
        reverse=True,
    )[:6]
    dormant_candidates = sorted(
        [item for item in items if item.segment == "dormant"],
        key=lambda item: ((item.days_since_last_invoice or item.days_since_last_activity or 0), float(item.lifetime_revenue)),
        reverse=True,
    )[:6]

    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    team_options = ops_base._team_options(db, user)
    team_lookup = {row.id: row for row in team_options}
    campaigns = _portfolio_campaigns_out(settings_row, items, team_lookup)

    return CustomerPortfolioOut(
        summary=summary,
        segments=segments,
        items=items,
        top_risk=top_risk,
        top_accounts=top_accounts,
        dormant_candidates=dormant_candidates,
        action_templates=_default_action_templates(),
        campaign_summary=_campaign_summary(campaigns),
        campaigns=campaigns[:6],
        assignees=team_options,
        generated_at=now,
    )


@router.get("/customer-portfolio", response_model=CustomerPortfolioOut)
def customer_portfolio(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    return _portfolio_payload(db, user)


@router.get("/customer-portfolio/{customer_id}", response_model=CustomerPortfolioDetailOut)
def customer_portfolio_detail(
    customer_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    payload = _portfolio_payload(db, user, now=now)
    item = next((row for row in payload.items if row.customer_id == customer_id), None)
    if not item:
        raise HTTPException(404, "Client introuvable dans le portefeuille.")
    peer_items = [
        row
        for row in payload.items
        if row.customer_id != customer_id and (row.segment == item.segment or row.risk_level == item.risk_level)
    ]
    peer_items.sort(
        key=lambda row: (
            0 if row.segment == item.segment else 1,
            -float(row.overdue_balance),
            -float(row.revenue_12m),
            row.customer_name.lower(),
        )
    )
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    team_lookup = ops_base._team_lookup(db, user)
    task_summary, active_tasks = _customer_related_tasks(
        settings_row,
        team_lookup,
        customer_id=customer_id,
        href=item.href,
        now=now,
    )
    campaigns = [campaign for campaign in _portfolio_campaigns_out(settings_row, payload.items, team_lookup) if customer_id in campaign.customer_ids]
    customer = db.get(Customer, customer_id)
    if not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Client introuvable dans le portefeuille.")
    timeline = _customer_timeline(db, user, customer, item, settings_row, team_lookup, campaigns, now)
    return CustomerPortfolioDetailOut(
        item=item,
        peer_items=peer_items[:4],
        actions=_actions_for_item(item),
        assignees=list(team_lookup.values()),
        task_summary=task_summary,
        active_tasks=active_tasks,
        campaigns=campaigns,
        timeline=timeline,
        generated_at=payload.generated_at,
    )


@router.post("/customer-portfolio/tasks", response_model=PortfolioTaskCreateResponse)
def create_portfolio_tasks(
    payload: PortfolioTaskCreateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    customer_ids = [str(item).strip() for item in payload.customer_ids if str(item).strip()]
    if not customer_ids:
        raise HTTPException(400, "Sélectionne au moins un client.")
    if payload.action_key not in _ACTION_SPECS:
        raise HTTPException(400, "Action portefeuille invalide.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    portfolio = _portfolio_payload(db, user, now=now)
    items_by_id = {item.customer_id: item for item in portfolio.items}
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    tasks_raw = ops_base._read_tasks(settings_row)
    team_lookup = ops_base._team_lookup(db, user)
    assignee_user_id = (payload.assignee_user_id or "").strip() or None
    if assignee_user_id and assignee_user_id not in team_lookup:
        raise HTTPException(400, "Assignation invalide.")

    created_rows: list[dict[str, Any]] = []
    notes: list[str] = []
    created_count = 0
    skipped_count = 0

    for customer_id in customer_ids:
        item = items_by_id.get(customer_id)
        if not item:
            skipped_count += 1
            notes.append(f"Client ignoré · {customer_id}")
            continue

        source_ref = f"portfolio:{payload.action_key}:{item.customer_id}"
        already_open = False
        for row in tasks_raw:
            hydrated = ops_base._hydrate_dt_dict(row, ops_base._TASK_DT_KEYS)
            if (
                str(hydrated.get("source_kind") or "") == "portfolio_action"
                and str(hydrated.get("source_ref") or "") == source_ref
                and str(hydrated.get("status") or "todo") != "done"
            ):
                already_open = True
                break
        if already_open:
            skipped_count += 1
            notes.append(f"Déjà ouvert · {item.customer_name}")
            continue

        title, description, module, priority, owner_role, default_due_days = _task_copy_for_action(item, payload.action_key)
        if payload.notes:
            description = f"{description}\n\nNote opérateur : {payload.notes.strip()}"
        owner_role = ops_base._normalize_owner_role(payload.owner_role or owner_role)

        task_assignee_user_id = assignee_user_id
        if task_assignee_user_id is None:
            assignee = ops_base._pick_assignee_for_role(team_lookup, owner_role)
            task_assignee_user_id = assignee.id if assignee else None

        due_at = payload.due_at
        if due_at is None and default_due_days:
            due_at = now + timedelta(days=default_due_days)

        created = {
            "id": f"tsk_{uuid.uuid4().hex[:10]}",
            "title": title,
            "description": description,
            "module": module,
            "status": "todo",
            "priority": priority,
            "href": item.href or f"/app/customers/{item.customer_id}",
            "owner_role": owner_role,
            "assignee_user_id": task_assignee_user_id,
            "due_at": due_at,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "source_kind": "portfolio_action",
            "source_ref": source_ref,
        }
        tasks_raw.append(ops_base._serialize_dt_dict(created, ops_base._TASK_DT_KEYS))
        created_rows.append(created)
        created_count += 1
        notes.append(f"Tâche créée · {item.customer_name}")

    if created_rows:
        ops_base._write_features(db, settings_row, tasks=tasks_raw)
        tasks = [ops_base._task_out(row, team_lookup) for row in created_rows]
    else:
        tasks = []

    return PortfolioTaskCreateResponse(
        created_count=created_count,
        skipped_count=skipped_count,
        tasks=tasks,
        notes=notes,
        generated_at=now,
    )


@router.post("/portfolio-campaigns", response_model=PortfolioCampaignOut)
def create_portfolio_campaign(
    payload: PortfolioCampaignCreateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    customer_ids: list[str] = []
    for value in payload.customer_ids:
        cid = str(value or "").strip()
        if cid and cid not in customer_ids:
            customer_ids.append(cid)
    if not customer_ids:
        raise HTTPException(400, "Sélectionne au moins un client pour créer une campagne.")
    if payload.action_key not in _ACTION_SPECS:
        raise HTTPException(400, "Action portefeuille invalide.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    portfolio = _portfolio_payload(db, user, now=now)
    items_by_id = {item.customer_id: item for item in portfolio.items}
    selected_items = [items_by_id[cid] for cid in customer_ids if cid in items_by_id]
    if not selected_items:
        raise HTTPException(400, "Aucun client exploitable dans la sélection.")

    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    campaigns_raw = _read_portfolio_campaigns(settings_row)
    team_lookup = ops_base._team_lookup(db, user)
    assignee_user_id = (payload.assignee_user_id or "").strip() or None
    if assignee_user_id and assignee_user_id not in team_lookup:
        raise HTTPException(400, "Assignation invalide.")

    default_owner_role = str(_ACTION_SPECS[payload.action_key]["owner_role"])
    owner_role = ops_base._normalize_owner_role(payload.owner_role or default_owner_role)
    normalized_status = _normalize_campaign_status(payload.status or ("scheduled" if payload.scheduled_for else "ready"))
    name = (payload.name or "").strip() or _campaign_name_default(payload.action_key, selected_items)
    entry = {
        "id": f"pc_{uuid.uuid4().hex[:10]}",
        "name": name,
        "action_key": payload.action_key,
        "status": normalized_status,
        "owner_role": owner_role,
        "assignee_user_id": assignee_user_id,
        "notes": (payload.notes or "").strip() or None,
        "scheduled_for": payload.scheduled_for,
        "created_at": now,
        "updated_at": now,
        "started_at": now if normalized_status in {"running", "done"} else None,
        "completed_at": now if normalized_status == "done" else None,
        "customer_ids": customer_ids,
    }
    campaigns_raw.append(ops_base._serialize_dt_dict(entry, _PORTFOLIO_CAMPAIGN_DT_KEYS))
    settings_row = _write_portfolio_campaigns(db, settings_row, campaigns_raw)
    campaigns = _portfolio_campaigns_out(settings_row, portfolio.items, team_lookup)
    created = next((campaign for campaign in campaigns if campaign.id == entry["id"]), None)
    if created is None:
        raise HTTPException(500, "Campagne portefeuille introuvable après création.")
    return created


@router.patch("/portfolio-campaigns/{campaign_id}", response_model=PortfolioCampaignOut)
def update_portfolio_campaign(
    campaign_id: str,
    payload: PortfolioCampaignPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    campaigns_raw = _read_portfolio_campaigns(settings_row)
    team_lookup = ops_base._team_lookup(db, user)
    fields_set = set(getattr(payload, "model_fields_set", getattr(payload, "__fields_set__", set())))
    updated_rows: list[dict[str, Any]] = []
    found = False

    for row in campaigns_raw:
        hydrated = ops_base._hydrate_dt_dict(row, _PORTFOLIO_CAMPAIGN_DT_KEYS)
        if str(hydrated.get("id") or "") != campaign_id:
            updated_rows.append(row)
            continue
        found = True
        if "name" in fields_set:
            name = (payload.name or "").strip()
            if not name:
                raise HTTPException(400, "Le nom de campagne ne peut pas être vide.")
            hydrated["name"] = name
        if "notes" in fields_set:
            hydrated["notes"] = (payload.notes or "").strip() or None
        if "assignee_user_id" in fields_set:
            assignee_user_id = (payload.assignee_user_id or "").strip() or None
            if assignee_user_id and assignee_user_id not in team_lookup:
                raise HTTPException(400, "Assignation invalide.")
            hydrated["assignee_user_id"] = assignee_user_id
        if "owner_role" in fields_set:
            hydrated["owner_role"] = ops_base._normalize_owner_role(payload.owner_role or hydrated.get("owner_role") or "accountant")
        if "scheduled_for" in fields_set:
            hydrated["scheduled_for"] = payload.scheduled_for
        if "status" in fields_set:
            status = _normalize_campaign_status(payload.status)
            hydrated["status"] = status
            if status in {"running", "done"} and hydrated.get("started_at") is None:
                hydrated["started_at"] = now
            if status == "done":
                hydrated["completed_at"] = now
            elif status != "done":
                hydrated["completed_at"] = None
        hydrated["updated_at"] = now
        updated_rows.append(ops_base._serialize_dt_dict(hydrated, _PORTFOLIO_CAMPAIGN_DT_KEYS))

    if not found:
        raise HTTPException(404, "Campagne portefeuille introuvable.")

    settings_row = _write_portfolio_campaigns(db, settings_row, updated_rows)
    portfolio = _portfolio_payload(db, user, now=now)
    campaigns = _portfolio_campaigns_out(settings_row, portfolio.items, team_lookup)
    updated = next((campaign for campaign in campaigns if campaign.id == campaign_id), None)
    if updated is None:
        raise HTTPException(500, "Campagne portefeuille introuvable après mise à jour.")
    return updated
