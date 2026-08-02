from __future__ import annotations

import copy
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_product_feature, require_viewer_or_admin
from ..models import InboundInvoice, PurchasePayment, PurchaseWorkflowState, Tenant, TenantSettings, User
from ..services.accounting_exports import accounting_period_lock_payload, find_delivered_accounting_period_lock
from ..services.product_capabilities import ensure_product_feature, is_product_feature_enabled
from .collections import payments_dashboard
from .workspace import workspace_summary

router = APIRouter(prefix="/api/ops", tags=["ops"])

_PLAYBOOK_STORE_KEY = "ops_playbooks"
_PURCHASE_WORKFLOW_STORE_KEY = "purchase_workflow_states"
_TASK_STORE_KEY = "ops_tasks"
_SCHEDULER_RUN_STORE_KEY = "ops_scheduler_runs"
_ALLOWED_PLAYBOOK_MODULES = {"collections", "payments", "purchases", "recurring", "setup"}
_ALLOWED_PLAYBOOK_CADENCES = {"daily", "weekly", "monthly", "manual"}
_ALLOWED_PLAYBOOK_TRIGGERS = {
    "overdue_invoice",
    "payment_quality",
    "purchase_validation",
    "recurring_due",
    "setup_gap",
    "manual_review",
}
_ALLOWED_OWNER_ROLES = {"owner", "admin", "accountant", "viewer"}
_ALLOWED_PURCHASE_STATES = {
    "new",
    "reviewing",
    "awaiting_supplier",
    "approved",
    "ready_to_pay",
    "booked",
}
_PLAYBOOK_DT_KEYS = {"created_at", "updated_at", "last_triggered_at"}
_PURCHASE_DT_KEYS = {"updated_at"}
_TASK_DT_KEYS = {"created_at", "updated_at", "due_at", "completed_at"}
_SCHEDULER_DT_KEYS = {"started_at", "finished_at"}
_ALLOWED_TASK_STATUSES = {"todo", "in_progress", "blocked", "done"}
_ALLOWED_TASK_PRIORITIES = {"critical", "high", "medium", "low"}
_MODULE_FEATURES = {
    "collections": "payments_enabled",
    "payments": "payments_enabled",
    "purchases": "purchases_enabled",
}


def _ops_feature_access(db: Session, user: AuthUser) -> tuple[bool, bool]:
    tenant = db.get(Tenant, user.tenant_id)
    return (
        is_product_feature_enabled(tenant, "purchases_enabled"),
        is_product_feature_enabled(tenant, "payments_enabled"),
    )


def _ops_module_allowed(module: str | None, *, purchases_enabled: bool, payments_enabled: bool) -> bool:
    normalized = str(module or "setup").strip().lower()
    if normalized == "purchases":
        return purchases_enabled
    if normalized in {"collections", "payments"}:
        return payments_enabled
    return True


def _ensure_ops_module_access(db: Session, user: AuthUser, module: str | None) -> None:
    normalized = str(module or "setup").strip().lower()
    feature = _MODULE_FEATURES.get(normalized)
    if not feature:
        return
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    ensure_product_feature(tenant, feature)


def _filter_entitled_rows(
    rows: list[dict[str, Any]], *, purchases_enabled: bool, payments_enabled: bool
) -> list[dict[str, Any]]:
    return [
        row
        for row in rows
        if _ops_module_allowed(
            str(row.get("module") or "setup"),
            purchases_enabled=purchases_enabled,
            payments_enabled=payments_enabled,
        )
    ]


class ActionCenterItemOut(BaseModel):
    id: str
    module: str
    module_label: str
    severity: str
    title: str
    subtitle: str | None = None
    description: str | None = None
    href: str
    action_label: str | None = None
    amount: Decimal | None = None
    count: int | None = None
    due_at: datetime | None = None


class ActionCenterSummaryOut(BaseModel):
    total_count: int = 0
    critical_count: int = 0
    high_count: int = 0
    medium_count: int = 0
    low_count: int = 0
    due_today_count: int = 0
    collections_count: int = 0
    payments_count: int = 0
    purchases_count: int = 0
    recurring_count: int = 0
    tasks_count: int = 0
    setup_count: int = 0


class ActionCenterOut(BaseModel):
    summary: ActionCenterSummaryOut = Field(default_factory=ActionCenterSummaryOut)
    items: list[ActionCenterItemOut] = Field(default_factory=list)
    generated_at: datetime


class PlaybookTemplateOut(BaseModel):
    key: str
    name: str
    module: str
    module_label: str
    trigger_type: str
    cadence: str
    owner_role: str
    description: str


class PlaybookOut(BaseModel):
    id: str
    name: str
    module: str
    module_label: str
    trigger_type: str
    cadence: str
    owner_role: str
    description: str | None = None
    active: bool = True
    created_at: datetime | None = None
    updated_at: datetime | None = None
    last_triggered_at: datetime | None = None
    template_key: str | None = None


class PlaybookCreateRequest(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    module: str = Field(min_length=3, max_length=32)
    trigger_type: str = Field(min_length=3, max_length=40)
    cadence: str = Field(default="daily", min_length=3, max_length=32)
    owner_role: str = Field(default="accountant", min_length=3, max_length=32)
    description: str | None = Field(default=None, max_length=500)
    active: bool = True
    template_key: str | None = Field(default=None, max_length=80)


class PlaybookPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=3, max_length=120)
    cadence: str | None = Field(default=None, min_length=3, max_length=32)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    description: str | None = Field(default=None, max_length=500)
    active: bool | None = None
    last_triggered_at: datetime | None = None


class WorkbenchSuggestionOut(BaseModel):
    id: str
    title: str
    subtitle: str | None = None
    description: str
    module: str
    module_label: str
    severity: str
    href: str
    template_key: str | None = None
    action_label: str | None = None


class PurchaseWorkflowStateOut(BaseModel):
    invoice_id: str
    invoice_number: str | None = None
    supplier_name: str | None = None
    state: str
    state_label: str
    tone: str
    owner_role: str | None = None
    note: str | None = None
    updated_at: datetime | None = None
    next_step_title: str
    next_step_description: str


class PurchaseWorkflowPatchRequest(BaseModel):
    state: str = Field(min_length=2, max_length=32)
    owner_role: str | None = Field(default=None, max_length=32)
    note: str | None = Field(default=None, max_length=500)


class PurchaseWorkflowSummaryOut(BaseModel):
    total_count: int = 0
    states: dict[str, int] = Field(default_factory=dict)
    items_by_invoice: dict[str, PurchaseWorkflowStateOut] = Field(default_factory=dict)
    generated_at: datetime


class OpsWorkbenchSummaryOut(BaseModel):
    active_playbooks: int = 0
    covered_modules: int = 0
    recommended_count: int = 0
    purchases_in_review: int = 0
    ready_to_pay_count: int = 0
    dunning_enabled: bool = False


class OpsWorkbenchOut(BaseModel):
    summary: OpsWorkbenchSummaryOut = Field(default_factory=OpsWorkbenchSummaryOut)
    playbooks: list[PlaybookOut] = Field(default_factory=list)
    suggestions: list[WorkbenchSuggestionOut] = Field(default_factory=list)
    purchase_workflow: PurchaseWorkflowSummaryOut
    templates: list[PlaybookTemplateOut] = Field(default_factory=list)
    generated_at: datetime


class TeamMemberOptionOut(BaseModel):
    id: str
    email: str
    role: str
    label: str
    initials: str


class OpsTaskOut(BaseModel):
    id: str
    title: str
    description: str | None = None
    module: str
    module_label: str
    status: str
    status_label: str
    priority: str
    priority_label: str
    tone: str
    href: str
    owner_role: str
    assignee_user_id: str | None = None
    assignee_email: str | None = None
    assignee_label: str | None = None
    due_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None
    source_kind: str | None = None
    source_ref: str | None = None


class OpsTaskCreateRequest(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    description: str | None = Field(default=None, max_length=1000)
    module: str = Field(default="setup", min_length=3, max_length=32)
    status: str = Field(default="todo", min_length=2, max_length=32)
    priority: str = Field(default="medium", min_length=2, max_length=32)
    href: str | None = Field(default=None, max_length=240)
    owner_role: str = Field(default="accountant", min_length=3, max_length=32)
    assignee_user_id: str | None = Field(default=None, max_length=64)
    due_at: datetime | None = None
    source_kind: str | None = Field(default=None, max_length=40)
    source_ref: str | None = Field(default=None, max_length=120)


class OpsTaskPatchRequest(BaseModel):
    title: str | None = Field(default=None, min_length=3, max_length=160)
    description: str | None = Field(default=None, max_length=1000)
    module: str | None = Field(default=None, min_length=3, max_length=32)
    status: str | None = Field(default=None, min_length=2, max_length=32)
    priority: str | None = Field(default=None, min_length=2, max_length=32)
    href: str | None = Field(default=None, max_length=240)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    assignee_user_id: str | None = Field(default=None, max_length=64)
    due_at: datetime | None = None
    completed_at: datetime | None = None


class CreateTaskFromActionRequest(BaseModel):
    action_id: str = Field(min_length=3, max_length=160)
    assignee_user_id: str | None = Field(default=None, max_length=64)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    due_at: datetime | None = None


class OpsTasksSummaryOut(BaseModel):
    open_count: int = 0
    due_today_count: int = 0
    overdue_count: int = 0
    blocked_count: int = 0
    done_count: int = 0
    unassigned_count: int = 0


class SchedulerRunOut(BaseModel):
    id: str
    status: str
    trigger: str
    started_at: datetime | None = None
    finished_at: datetime | None = None
    updated_playbooks: int = 0
    created_tasks: int = 0
    notes: list[str] = Field(default_factory=list)


class SchedulerPlaybookDueOut(BaseModel):
    id: str
    name: str
    module: str
    module_label: str
    cadence: str
    owner_role: str
    next_run_at: datetime | None = None
    reason: str | None = None


class SchedulerPreviewSummaryOut(BaseModel):
    due_playbooks_count: int = 0
    manual_playbooks_count: int = 0
    overdue_tasks_count: int = 0
    blocked_tasks_count: int = 0
    open_tasks_count: int = 0
    recent_runs_count: int = 0


class SchedulerPreviewOut(BaseModel):
    summary: SchedulerPreviewSummaryOut = Field(default_factory=SchedulerPreviewSummaryOut)
    due_playbooks: list[SchedulerPlaybookDueOut] = Field(default_factory=list)
    recent_runs: list[SchedulerRunOut] = Field(default_factory=list)
    generated_at: datetime


class OpsTasksBoardOut(BaseModel):
    summary: OpsTasksSummaryOut = Field(default_factory=OpsTasksSummaryOut)
    tasks: list[OpsTaskOut] = Field(default_factory=list)
    assignees: list[TeamMemberOptionOut] = Field(default_factory=list)
    suggestions: list[ActionCenterItemOut] = Field(default_factory=list)
    scheduler: SchedulerPreviewOut
    generated_at: datetime


_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
_MODULE_ORDER = {
    "collections": 0,
    "payments": 1,
    "purchases": 2,
    "recurring": 3,
    "tasks": 4,
    "campaigns": 5,
    "scheduler": 6,
    "setup": 7,
}
_MODULE_LABELS = {
    "collections": "Recouvrement",
    "payments": "Paiements",
    "purchases": "Achats",
    "recurring": "Récurrence",
    "tasks": "Tâches",
    "campaigns": "Campagnes",
    "scheduler": "Scheduler",
    "setup": "Configuration",
}
_PURCHASE_STATE_META = {
    "new": ("Nouveau", "info"),
    "reviewing": ("En revue", "warn"),
    "awaiting_supplier": ("En attente fournisseur", "danger"),
    "approved": ("Validé achat", "purple"),
    "ready_to_pay": ("À payer", "purple"),
    "booked": ("Payé", "ok"),
}
_PLAYBOOK_TEMPLATES = {
    "collections-dunning": {
        "key": "collections-dunning",
        "name": "Relances encours",
        "module": "collections",
        "trigger_type": "overdue_invoice",
        "cadence": "daily",
        "owner_role": "accountant",
        "description": "Passe en revue les factures échues, prépare les relances et garde le recouvrement visible chaque matin.",
    },
    "payments-quality": {
        "key": "payments-quality",
        "name": "Qualité des paiements",
        "module": "payments",
        "trigger_type": "payment_quality",
        "cadence": "weekly",
        "owner_role": "accountant",
        "description": "Repère les paiements sans référence ou sans méthode pour fiabiliser le suivi des règlements et le reporting des paiements.",
    },
    "purchases-review": {
        "key": "purchases-review",
        "name": "Validation achats",
        "module": "purchases",
        "trigger_type": "purchase_validation",
        "cadence": "daily",
        "owner_role": "accountant",
        "description": "Orchestre la revue interne des factures fournisseurs avec un workflow clair entre revue, attente fournisseur et à payer.",
    },
    "recurring-check": {
        "key": "recurring-check",
        "name": "Contrôle récurrence",
        "module": "recurring",
        "trigger_type": "recurring_due",
        "cadence": "daily",
        "owner_role": "admin",
        "description": "Vérifie les échéances récurrentes à générer et les runs en erreur avant qu'ils ne se transforment en incident client.",
    },
    "setup-readiness": {
        "key": "setup-readiness",
        "name": "Readiness réforme",
        "module": "setup",
        "trigger_type": "setup_gap",
        "cadence": "weekly",
        "owner_role": "owner",
        "description": "Maintient un rythme de vérification des prérequis commerciaux et réglementaires avant montée en charge clients.",
    },
}
_TASK_STATUS_META = {
    "todo": ("À faire", "info"),
    "in_progress": ("En cours", "warn"),
    "blocked": ("Bloquée", "danger"),
    "done": ("Terminée", "ok"),
}
_TASK_PRIORITY_LABELS = {
    "critical": "Critique",
    "high": "Haute",
    "medium": "Normale",
    "low": "Basse",
}
_MODULE_DEFAULT_HREFS = {
    "collections": "/app/receivables",
    "payments": "/app/payments",
    "purchases": "/app/purchases",
    "recurring": "/app/recurring",
    "tasks": "/app/tasks",
    "campaigns": "/app/outbox",
    "scheduler": "/app/scheduler",
    "setup": "/app/settings",
}


def _fmt_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except Exception:
        return Decimal("0")


def _round_purchase_amount(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"))


def _purchase_line_decimal(raw: dict[str, Any], key: str) -> Decimal:
    try:
        return _round_purchase_amount(Decimal(str(raw.get(key) or 0)))
    except Exception:
        return Decimal("0.00")


def _purchase_clean_text(value: Any, *, upper: bool = False) -> str | None:
    text = str(value or "").strip()
    if upper:
        text = text.upper()
    return text or None


def _purchase_line_zero_vat_has_reason(raw: dict[str, Any]) -> bool:
    category = _purchase_clean_text(raw.get("vat_category"), upper=True)
    return bool(
        category in {"AE", "E", "O", "Z", "G", "K"}
        or _purchase_clean_text(raw.get("exemption_reason_code"), upper=True)
        or _purchase_clean_text(raw.get("vat_exemption_reason"))
        or _purchase_clean_text(raw.get("vat_zero_reason"))
        or raw.get("vat_reverse_charge")
    )


def _purchase_zero_vat_missing_reason(row: InboundInvoice) -> bool:
    if _round_purchase_amount(_fmt_decimal(row.total_ttc)) <= Decimal("0"):
        return False
    if _round_purchase_amount(_fmt_decimal(row.total_vat)) > Decimal("0"):
        return False
    lines = row.purchase_lines if isinstance(row.purchase_lines, list) else []
    meaningful_lines = [
        raw for raw in lines if isinstance(raw, dict) and _purchase_line_decimal(raw, "total_ex_vat") > Decimal("0")
    ]
    if not meaningful_lines:
        return True
    return any(
        _purchase_line_decimal(raw, "total_vat") <= Decimal("0") and not _purchase_line_zero_vat_has_reason(raw)
        for raw in meaningful_lines
    )


def _purchase_amounts_inconsistent(row: InboundInvoice) -> bool:
    if row.total_ex_vat is None or row.total_vat is None or row.total_ttc is None:
        return False
    return abs(
        _round_purchase_amount(_fmt_decimal(row.total_ex_vat))
        + _round_purchase_amount(_fmt_decimal(row.total_vat))
        - _round_purchase_amount(_fmt_decimal(row.total_ttc))
    ) > Decimal("0.02")


def _as_dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, time.min)
    if value is None:
        return None
    try:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is not None:
            return parsed.replace(tzinfo=None)
        return parsed
    except Exception:
        return None


def _to_iso(value: datetime | None) -> str | None:
    if not value:
        return None
    return value.replace(microsecond=0).isoformat()


def _features(settings_row: TenantSettings | None) -> dict[str, Any]:
    if settings_row and isinstance(settings_row.features, dict):
        return copy.deepcopy(settings_row.features)
    return {}


def _ensure_settings(db: Session, tenant_id: str) -> TenantSettings:
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if settings_row:
        return settings_row
    settings_row = TenantSettings(tenant_id=tenant_id)
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _write_features(
    db: Session,
    settings_row: TenantSettings,
    *,
    playbooks: list[dict[str, Any]] | None = None,
    purchase_states: dict[str, dict[str, Any]] | None = None,
    tasks: list[dict[str, Any]] | None = None,
    scheduler_runs: list[dict[str, Any]] | None = None,
) -> TenantSettings:
    features = _features(settings_row)
    if playbooks is not None:
        features[_PLAYBOOK_STORE_KEY] = playbooks
    if purchase_states is not None:
        features[_PURCHASE_WORKFLOW_STORE_KEY] = purchase_states
    if tasks is not None:
        features[_TASK_STORE_KEY] = tasks
    if scheduler_runs is not None:
        features[_SCHEDULER_RUN_STORE_KEY] = scheduler_runs
    settings_row.features = features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _read_playbooks(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    items = _features(settings_row).get(_PLAYBOOK_STORE_KEY)
    if isinstance(items, list):
        return [copy.deepcopy(item) for item in items if isinstance(item, dict)]
    return []


def _read_purchase_workflow_states(settings_row: TenantSettings | None) -> dict[str, dict[str, Any]]:
    raw = _features(settings_row).get(_PURCHASE_WORKFLOW_STORE_KEY)
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, dict[str, Any]] = {}
    for invoice_id, payload in raw.items():
        if not invoice_id or not isinstance(payload, dict):
            continue
        clean[str(invoice_id)] = copy.deepcopy(payload)
    return clean


def _purchase_workflow_row_payload(row: PurchaseWorkflowState | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "invoice_id": row.inbound_invoice_id,
        "state": row.state,
        "owner_role": row.owner_role,
        "note": row.note,
        "updated_at": row.updated_at,
    }


def _read_purchase_workflow_states_for_tenant(
    db: Session,
    tenant_id: str,
    settings_row: TenantSettings | None,
) -> dict[str, dict[str, Any]]:
    states = _read_purchase_workflow_states(settings_row)
    rows = db.query(PurchaseWorkflowState).filter(PurchaseWorkflowState.tenant_id == tenant_id).all()
    for row in rows:
        payload = _purchase_workflow_row_payload(row)
        if payload:
            states[row.inbound_invoice_id] = payload
    return states


def _get_purchase_workflow_payload(
    db: Session,
    tenant_id: str,
    invoice_id: str,
    settings_row: TenantSettings | None = None,
) -> dict[str, Any] | None:
    row = (
        db.query(PurchaseWorkflowState)
        .filter(PurchaseWorkflowState.tenant_id == tenant_id, PurchaseWorkflowState.inbound_invoice_id == invoice_id)
        .first()
    )
    payload = _purchase_workflow_row_payload(row)
    if payload:
        return payload
    if settings_row is None:
        settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    return _read_purchase_workflow_states(settings_row).get(invoice_id)


def _write_purchase_workflow_state_row(
    db: Session,
    *,
    tenant_id: str,
    invoice_id: str,
    state: str,
    owner_role: str | None,
    note: str | None,
) -> PurchaseWorkflowState:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = (
        db.query(PurchaseWorkflowState)
        .filter(PurchaseWorkflowState.tenant_id == tenant_id, PurchaseWorkflowState.inbound_invoice_id == invoice_id)
        .with_for_update()
        .first()
    )
    if not row:
        row = PurchaseWorkflowState(tenant_id=tenant_id, inbound_invoice_id=invoice_id, created_at=now)
    row.state = state
    row.owner_role = owner_role
    row.note = note
    row.updated_at = now
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        row = (
            db.query(PurchaseWorkflowState)
            .filter(
                PurchaseWorkflowState.tenant_id == tenant_id, PurchaseWorkflowState.inbound_invoice_id == invoice_id
            )
            .with_for_update()
            .one()
        )
        row.state = state
        row.owner_role = owner_role
        row.note = note
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(row)
        db.commit()
    db.refresh(row)
    return row


def _read_tasks(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_TASK_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _read_scheduler_runs(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_SCHEDULER_RUN_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _serialize_dt_dict(data: dict[str, Any], keys: set[str]) -> dict[str, Any]:
    clone = copy.deepcopy(data)
    for key in keys:
        clone[key] = _to_iso(_as_dt(clone.get(key)))
    return clone


def _hydrate_dt_dict(data: dict[str, Any], keys: set[str]) -> dict[str, Any]:
    clone = copy.deepcopy(data)
    for key in keys:
        clone[key] = _as_dt(clone.get(key))
    return clone


def _normalize_playbook_module(value: str | None) -> str:
    normalized = (value or "setup").strip().lower()
    if normalized not in _ALLOWED_PLAYBOOK_MODULES:
        raise HTTPException(400, "Module de playbook invalide.")
    return normalized


def _normalize_owner_role(value: str | None) -> str:
    normalized = (value or "accountant").strip().lower()
    if normalized not in _ALLOWED_OWNER_ROLES:
        raise HTTPException(400, "Rôle propriétaire invalide.")
    return normalized


def _normalize_playbook_cadence(value: str | None) -> str:
    normalized = (value or "daily").strip().lower()
    aliases = {"day": "daily", "week": "weekly", "month": "monthly", "manuel": "manual"}
    normalized = aliases.get(normalized, normalized)
    if normalized not in _ALLOWED_PLAYBOOK_CADENCES:
        raise HTTPException(400, "Cadence invalide.")
    return normalized


def _normalize_playbook_trigger(value: str | None) -> str:
    normalized = (value or "manual_review").strip().lower()
    if normalized not in _ALLOWED_PLAYBOOK_TRIGGERS:
        raise HTTPException(400, "Trigger de playbook invalide.")
    return normalized


def _normalize_purchase_state(value: str | None) -> str:
    normalized = (value or "new").strip().lower()
    aliases = {
        "todo": "new",
        "review": "reviewing",
        "en_revue": "reviewing",
        "awaiting": "awaiting_supplier",
        "supplier": "awaiting_supplier",
        "ok": "approved",
        "ready": "ready_to_pay",
        "paid": "booked",
        "done": "booked",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized not in _ALLOWED_PURCHASE_STATES:
        raise HTTPException(400, "Statut de workflow achat invalide.")
    return normalized


def _normalize_task_status(value: str | None) -> str:
    normalized = (value or "todo").strip().lower()
    aliases = {
        "open": "todo",
        "new": "todo",
        "progress": "in_progress",
        "doing": "in_progress",
        "blocked_waiting": "blocked",
        "completed": "done",
        "closed": "done",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized not in _ALLOWED_TASK_STATUSES:
        raise HTTPException(400, "Statut de tâche invalide.")
    return normalized


def _normalize_task_priority(value: str | None) -> str:
    normalized = (value or "medium").strip().lower()
    aliases = {
        "urgent": "critical",
        "normal": "medium",
        "standard": "medium",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized not in _ALLOWED_TASK_PRIORITIES:
        raise HTTPException(400, "Priorité de tâche invalide.")
    return normalized


def _purchase_state_meta(state: str | None) -> tuple[str, str]:
    normalized = _normalize_purchase_state(state)
    return _PURCHASE_STATE_META.get(normalized, (normalized, "muted"))


def _purchase_state_label(state: str | None) -> str:
    return _purchase_state_meta(state)[0]


def _purchase_state_tone(state: str | None) -> str:
    return _purchase_state_meta(state)[1]


def _task_status_meta(status: str | None) -> tuple[str, str]:
    normalized = _normalize_task_status(status)
    return _TASK_STATUS_META.get(normalized, (normalized, "muted"))


def _task_priority_label(priority: str | None) -> str:
    return _TASK_PRIORITY_LABELS.get(_normalize_task_priority(priority), "Normale")


def _playbook_out(payload: dict[str, Any]) -> PlaybookOut:
    row = _hydrate_dt_dict(payload, _PLAYBOOK_DT_KEYS)
    module = _normalize_playbook_module(str(row.get("module") or "setup"))
    return PlaybookOut(
        id=str(row.get("id") or uuid.uuid4()),
        name=str(row.get("name") or "Playbook"),
        module=module,
        module_label=_MODULE_LABELS[module],
        trigger_type=_normalize_playbook_trigger(str(row.get("trigger_type") or "manual_review")),
        cadence=_normalize_playbook_cadence(str(row.get("cadence") or "daily")),
        owner_role=_normalize_owner_role(str(row.get("owner_role") or "accountant")),
        description=(str(row.get("description") or "").strip() or None),
        active=bool(row.get("active", True)),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
        last_triggered_at=row.get("last_triggered_at"),
        template_key=(str(row.get("template_key") or "").strip() or None),
    )


def _playbook_templates_out() -> list[PlaybookTemplateOut]:
    rows: list[PlaybookTemplateOut] = []
    for payload in _PLAYBOOK_TEMPLATES.values():
        module = _normalize_playbook_module(payload.get("module"))
        rows.append(
            PlaybookTemplateOut(
                key=payload["key"],
                name=payload["name"],
                module=module,
                module_label=_MODULE_LABELS[module],
                trigger_type=payload["trigger_type"],
                cadence=payload["cadence"],
                owner_role=payload["owner_role"],
                description=payload["description"],
            )
        )
    return rows


def _default_purchase_state(row: InboundInvoice) -> str:
    status = (row.status or "").strip().lower()
    validation = (row.validation_status or "").strip().lower()
    if status in {"correction_requested", "rejected"} or validation == "invalid":
        return "awaiting_supplier"
    if status == "accepted":
        return "approved"
    if status == "acknowledged" or validation == "warning":
        return "reviewing"
    return "new"


def _purchase_next_step(row: InboundInvoice, state: str) -> tuple[str, str]:
    validation = (row.validation_status or "").strip().lower()
    status = (row.status or "").strip().lower()
    if state == "awaiting_supplier":
        if validation == "invalid":
            return (
                "Clarifier ou demander un document corrigé",
                "La structure reçue est insuffisante. Reviens vers le fournisseur avant validation ou mise en paiement.",
            )
        return (
            "Suivre le retour fournisseur",
            "Une demande de correction ou un rejet a déjà été émis. Conserve la trace et attends la prochaine version.",
        )
    if state == "reviewing":
        return (
            "Valider le contenu métier",
            "Compare la facture au bon de commande, à la prestation reçue et aux montants attendus avant d'approuver.",
        )
    if state == "approved":
        return (
            "Préparer le paiement",
            "Le document est validé côté achat. L'étape suivante consiste à le passer en étape À payer selon ton cycle interne.",
        )
    if state == "ready_to_pay":
        return (
            "Enregistrer le règlement fournisseur",
            "Le dossier est validé. Saisis le règlement fournisseur dès qu'il est payé ou rapproche-le depuis un import CSV.",
        )
    if state == "booked":
        return (
            "Paiement fournisseur enregistré",
            "La facture fournisseur est soldée côté suivi manuel. Conserve la pièce et la référence pour l'export comptable.",
        )
    if status == "accepted":
        return (
            "Préparer le paiement fournisseur",
            "Le document est accepté côté réception. Organise maintenant son ordonnancement ou son intégration comptable.",
        )
    return (
        "Analyser le document reçu",
        "Vérifie rapidement fournisseur, numéro, TVA et cohérence métier avant de décider validation, correction ou rejet.",
    )


def _purchase_workflow_out(row: InboundInvoice, stored: dict[str, Any] | None = None) -> PurchaseWorkflowStateOut:
    payload = _hydrate_dt_dict(stored or {}, _PURCHASE_DT_KEYS)
    state = _normalize_purchase_state(payload.get("state") or _default_purchase_state(row))
    state_label, tone = _purchase_state_meta(state)
    next_title, next_description = _purchase_next_step(row, state)
    return PurchaseWorkflowStateOut(
        invoice_id=row.id,
        invoice_number=row.invoice_number,
        supplier_name=row.supplier_name,
        state=state,
        state_label=state_label,
        tone=tone,
        owner_role=(str(payload.get("owner_role") or "").strip() or None),
        note=(str(payload.get("note") or "").strip() or None),
        updated_at=payload.get("updated_at"),
        next_step_title=next_title,
        next_step_description=next_description,
    )


def _purchase_workflow_summary(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    limit: int = 120,
) -> PurchaseWorkflowSummaryOut:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    stored_map = _read_purchase_workflow_states_for_tenant(db, user.tenant_id, settings_row)
    rows = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.tenant_id == user.tenant_id)
        .order_by(InboundInvoice.received_at.desc(), InboundInvoice.created_at.desc())
        .limit(limit)
        .all()
    )
    states: dict[str, int] = {key: 0 for key in _ALLOWED_PURCHASE_STATES}
    items_by_invoice: dict[str, PurchaseWorkflowStateOut] = {}
    for row in rows:
        workflow = _purchase_workflow_out(row, stored_map.get(row.id))
        states[workflow.state] = states.get(workflow.state, 0) + 1
        items_by_invoice[row.id] = workflow
    return PurchaseWorkflowSummaryOut(
        total_count=len(items_by_invoice),
        states=states,
        items_by_invoice=items_by_invoice,
        generated_at=now,
    )


def _role_label(role: str | None) -> str:
    normalized = _normalize_owner_role(role)
    if normalized == "owner":
        return "Owner"
    if normalized == "admin":
        return "Admin"
    if normalized == "viewer":
        return "Viewer"
    return "Compta"


def _pretty_local_name(email: str) -> tuple[str, str]:
    local = (email or "").split("@")[0] or "compte"
    parts = [part for part in local.replace("-", " ").replace("_", " ").split() if part]
    label = " ".join(part[:1].upper() + part[1:] for part in parts) or "Compte"
    initials = ("".join(part[:1].upper() for part in parts[:2]) or (label[:1].upper() if label else "U"))[:2]
    return label, initials


def _team_options(db: Session, user: AuthUser) -> list[TeamMemberOptionOut]:
    rows = db.query(User).filter(User.tenant_id == user.tenant_id).order_by(User.created_at.asc()).all()
    options: list[TeamMemberOptionOut] = []
    for row in rows:
        role = (row.role or "viewer").strip().lower()
        if role not in _ALLOWED_OWNER_ROLES:
            continue
        label, initials = _pretty_local_name(row.email or "")
        options.append(
            TeamMemberOptionOut(
                id=row.id,
                email=row.email,
                role=role,
                label=f"{label} · {_role_label(role)}",
                initials=initials,
            )
        )
    return options


def _team_lookup(db: Session, user: AuthUser) -> dict[str, TeamMemberOptionOut]:
    return {row.id: row for row in _team_options(db, user)}


def _normalize_task_module(value: str | None) -> str:
    normalized = (value or "setup").strip().lower()
    if normalized not in {"collections", "payments", "purchases", "recurring", "tasks", "setup"}:
        raise HTTPException(400, "Module de tâche invalide.")
    return normalized


def _task_out(payload: dict[str, Any], team_lookup: dict[str, TeamMemberOptionOut] | None = None) -> OpsTaskOut:
    row = _hydrate_dt_dict(payload, _TASK_DT_KEYS)
    module = _normalize_task_module(str(row.get("module") or "setup"))
    status = _normalize_task_status(str(row.get("status") or "todo"))
    priority = _normalize_task_priority(str(row.get("priority") or "medium"))
    status_label, tone = _task_status_meta(status)
    assignee_user_id = str(row.get("assignee_user_id") or "").strip() or None
    assignee = (team_lookup or {}).get(assignee_user_id or "") if assignee_user_id else None
    assignee_email = assignee.email if assignee else (str(row.get("assignee_email") or "").strip() or None)
    assignee_label = assignee.label if assignee else None
    return OpsTaskOut(
        id=str(row.get("id") or uuid.uuid4()),
        title=str(row.get("title") or "Tâche"),
        description=(str(row.get("description") or "").strip() or None),
        module=module,
        module_label=_MODULE_LABELS[module],
        status=status,
        status_label=status_label,
        priority=priority,
        priority_label=_task_priority_label(priority),
        tone=tone,
        href=(str(row.get("href") or "").strip() or _MODULE_DEFAULT_HREFS.get(module, "/app/tasks")),
        owner_role=_normalize_owner_role(str(row.get("owner_role") or "accountant")),
        assignee_user_id=assignee_user_id,
        assignee_email=assignee_email,
        assignee_label=assignee_label or assignee_email,
        due_at=row.get("due_at"),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
        completed_at=row.get("completed_at"),
        source_kind=(str(row.get("source_kind") or "").strip() or None),
        source_ref=(str(row.get("source_ref") or "").strip() or None),
    )


def _task_sort_key(task: OpsTaskOut, now: datetime) -> tuple[Any, ...]:
    status_order = {"blocked": 0, "todo": 1, "in_progress": 2, "done": 3}
    priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    due_dt = task.due_at or datetime.max
    overdue_sort = 0 if (task.status != "done" and task.due_at and task.due_at <= now) else 1
    return (
        status_order.get(task.status, 9),
        priority_order.get(task.priority, 9),
        overdue_sort,
        due_dt,
        task.title.lower(),
    )


def _task_summary(tasks: list[OpsTaskOut], now: datetime) -> OpsTasksSummaryOut:
    summary = OpsTasksSummaryOut()
    for task in tasks:
        if task.status == "done":
            summary.done_count += 1
            continue
        summary.open_count += 1
        if not task.assignee_user_id:
            summary.unassigned_count += 1
        if task.status == "blocked":
            summary.blocked_count += 1
        if task.due_at and task.due_at <= now:
            summary.overdue_count += 1
        if task.due_at and task.due_at <= (now + timedelta(days=1)):
            summary.due_today_count += 1
    return summary


def _scheduler_run_out(payload: dict[str, Any]) -> SchedulerRunOut:
    row = _hydrate_dt_dict(payload, _SCHEDULER_DT_KEYS)
    raw_notes = row.get("notes")
    notes_raw: list[Any] = raw_notes if isinstance(raw_notes, list) else []
    return SchedulerRunOut(
        id=str(row.get("id") or uuid.uuid4()),
        status=str(row.get("status") or "ok"),
        trigger=str(row.get("trigger") or "manual"),
        started_at=row.get("started_at"),
        finished_at=row.get("finished_at"),
        updated_playbooks=int(row.get("updated_playbooks") or 0),
        created_tasks=int(row.get("created_tasks") or 0),
        notes=[str(item) for item in notes_raw if str(item).strip()],
    )


def _playbook_delta(cadence: str) -> timedelta | None:
    normalized = _normalize_playbook_cadence(cadence)
    if normalized == "manual":
        return None
    if normalized == "weekly":
        return timedelta(days=7)
    if normalized == "monthly":
        return timedelta(days=30)
    return timedelta(days=1)


def _playbook_due_rows(
    settings_row: TenantSettings | None,
    now: datetime,
    *,
    purchases_enabled: bool = True,
    payments_enabled: bool = True,
) -> list[SchedulerPlaybookDueOut]:
    rows: list[SchedulerPlaybookDueOut] = []
    for raw in _read_playbooks(settings_row):
        playbook = _playbook_out(raw)
        if not _ops_module_allowed(
            playbook.module,
            purchases_enabled=purchases_enabled,
            payments_enabled=payments_enabled,
        ):
            continue
        if not playbook.active:
            continue
        delta = _playbook_delta(playbook.cadence)
        if delta is None:
            continue
        reference = playbook.last_triggered_at or playbook.updated_at or playbook.created_at
        if reference is None:
            next_run = now
            reason = "Jamais exécuté"
        else:
            next_run = reference + delta
            reason = "Cadence atteinte" if next_run <= now else "À venir"
        if next_run <= now:
            rows.append(
                SchedulerPlaybookDueOut(
                    id=playbook.id,
                    name=playbook.name,
                    module=playbook.module,
                    module_label=playbook.module_label,
                    cadence=playbook.cadence,
                    owner_role=playbook.owner_role,
                    next_run_at=next_run,
                    reason=reason,
                )
            )
    rows.sort(key=lambda row: (row.next_run_at or datetime.max, _MODULE_ORDER.get(row.module, 99), row.name.lower()))
    return rows


def _scheduler_preview_payload(
    settings_row: TenantSettings | None,
    tasks: list[OpsTaskOut],
    now: datetime,
    *,
    purchases_enabled: bool = True,
    payments_enabled: bool = True,
) -> SchedulerPreviewOut:
    due_playbooks = _playbook_due_rows(
        settings_row,
        now,
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    recent_runs = sorted(
        (_scheduler_run_out(item) for item in _read_scheduler_runs(settings_row)),
        key=lambda row: row.started_at or datetime.min,
        reverse=True,
    )[:6]
    if not (purchases_enabled and payments_enabled):
        # Historical runs aggregate all playbook modules and their notes do
        # not carry enough metadata to redact only a downgraded module.
        recent_runs = []
    summary = SchedulerPreviewSummaryOut(
        due_playbooks_count=len(due_playbooks),
        manual_playbooks_count=sum(
            1
            for item in _read_playbooks(settings_row)
            if _normalize_playbook_cadence(str(item.get("cadence") or "daily")) == "manual"
            and _ops_module_allowed(
                str(item.get("module") or "setup"),
                purchases_enabled=purchases_enabled,
                payments_enabled=payments_enabled,
            )
        ),
        overdue_tasks_count=sum(1 for task in tasks if task.status != "done" and task.due_at and task.due_at <= now),
        blocked_tasks_count=sum(1 for task in tasks if task.status == "blocked"),
        open_tasks_count=sum(1 for task in tasks if task.status != "done"),
        recent_runs_count=len(recent_runs),
    )
    return SchedulerPreviewOut(
        summary=summary, due_playbooks=due_playbooks[:8], recent_runs=recent_runs, generated_at=now
    )


def _pick_assignee_for_role(
    team_lookup: dict[str, TeamMemberOptionOut], role: str | None
) -> TeamMemberOptionOut | None:
    target = _normalize_owner_role(role)
    for item in team_lookup.values():
        if (item.role or "").lower() == target:
            return item
    return next(iter(team_lookup.values()), None) if team_lookup else None


def _recurring_profiles(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    if not settings_row or not isinstance(settings_row.features, dict):
        return []
    items = settings_row.features.get("recurring_profiles")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _purchase_priority(row: InboundInvoice, internal_state: str | None = None) -> tuple[str, int, str, str]:
    status = (row.status or "").strip().lower()
    validation = (row.validation_status or "").strip().lower()
    state = _normalize_purchase_state(internal_state or _default_purchase_state(row))
    if state == "booked":
        return (
            "low",
            5,
            "Traitement terminé",
            "Le document a déjà parcouru le workflow interne et ne doit plus consommer l'attention opérateur.",
        )
    if state == "ready_to_pay":
        return (
            "medium",
            55,
            "Enregistrer le règlement",
            "Le document est à payer. Le prochain geste utile est la saisie du règlement ou le passage comptable.",
        )
    if state == "approved":
        return (
            "low",
            35,
            "Programmer le paiement fournisseur",
            "L'achat est approuvé côté métier. Il reste un dernier pas pour le faire entrer dans la chaîne de paiement.",
        )
    if state == "awaiting_supplier":
        return (
            "critical" if validation == "invalid" else "medium",
            130 if validation == "invalid" else 65,
            "Demander une correction fournisseur" if validation == "invalid" else "Suivre le retour fournisseur",
            "Le document reçu n'est pas assez fiable pour une validation achat propre."
            if validation == "invalid"
            else "Une version corrigée ou une clarification est attendue côté fournisseur.",
        )
    if state == "reviewing":
        if validation == "warning":
            return (
                "high",
                100,
                "Valider avec contrôle renforcé",
                "Le contenu est exploitable mais des points doivent être vérifiés avant paiement.",
            )
        return (
            "high" if status == "acknowledged" else "medium",
            85,
            "Contrôler la facture fournisseur",
            "Le document est arrivé dans la file achats et attend une décision interne.",
        )
    if validation == "invalid":
        return (
            "critical",
            130,
            "Demander une correction fournisseur",
            "Le document reçu n'est pas assez fiable pour une validation achat propre.",
        )
    if validation == "warning":
        return (
            "high",
            100,
            "Valider avec contrôle renforcé",
            "Le contenu est exploitable mais des points doivent être vérifiés avant paiement.",
        )
    if status in {"received", "acknowledged", "imported"}:
        return (
            "high" if status == "acknowledged" else "medium",
            80,
            "Contrôler la facture fournisseur",
            "Le document est arrivé dans la file achats et attend une décision interne.",
        )
    if status in {"correction_requested", "rejected"}:
        return (
            "medium",
            60,
            "Suivre le retour fournisseur",
            "Une version corrigée ou une clarification est attendue côté fournisseur.",
        )
    return (
        "low",
        10,
        "Surveiller le traitement fournisseur",
        "Le document ne bloque pas le flux immédiatement mais mérite un suivi.",
    )


@router.get("/action-center", response_model=ActionCenterOut)
def action_center(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    purchases_enabled, payments_enabled = _ops_feature_access(db, user)
    items_with_sort: list[tuple[tuple[Any, ...], ActionCenterItemOut]] = []
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    purchase_state_map = (
        _read_purchase_workflow_states_for_tenant(db, user.tenant_id, settings_row) if purchases_enabled else {}
    )

    def push(
        *,
        item_id: str,
        module: str,
        severity: str,
        title: str,
        href: str,
        subtitle: str | None = None,
        description: str | None = None,
        action_label: str | None = None,
        amount: Decimal | None = None,
        count: int | None = None,
        due_at: datetime | None = None,
        rank: int | None = None,
    ) -> None:
        normalized_module = module if module in _MODULE_LABELS else "setup"
        normalized_severity = severity if severity in _SEVERITY_ORDER else "medium"
        due_dt = _as_dt(due_at)
        overdue_sort = 0 if (due_dt and due_dt <= now) else 1
        severity_sort = _SEVERITY_ORDER.get(normalized_severity, 2)
        module_sort = _MODULE_ORDER.get(normalized_module, 99)
        amount_sort = -float(amount or 0)
        rank_sort = -(rank or 0)
        due_sort = due_dt or datetime.max
        item = ActionCenterItemOut(
            id=item_id,
            module=normalized_module,
            module_label=_MODULE_LABELS[normalized_module],
            severity=normalized_severity,
            title=title,
            subtitle=subtitle,
            description=description,
            href=href,
            action_label=action_label,
            amount=amount,
            count=count,
            due_at=due_dt,
        )
        items_with_sort.append(
            ((severity_sort, overdue_sort, due_sort, module_sort, rank_sort, amount_sort, title.lower()), item)
        )

    try:
        workspace = workspace_summary(db=db, user=user)
        for index, action in enumerate((workspace or {}).get("next_actions") or []):
            push(
                item_id=f"setup-{index}-{action.get('key')}",
                module="setup",
                severity="high" if (action.get("priority") or "medium") == "high" else "medium",
                title=str(action.get("label") or "Configurer l'espace"),
                subtitle=str(action.get("reason") or ""),
                description="Pré-requis commercial ou réglementaire à compléter.",
                href=str(action.get("href") or "/app/settings"),
                action_label="Configurer",
                rank=100 - index,
            )
    except Exception:
        workspace = None

    try:
        payment_ops = payments_dashboard(db=db, user=user) if payments_enabled else None
        if payment_ops is None:
            raise LookupError("payments_feature_disabled")
        for row in list(payment_ops.action_queue or [])[:6]:
            amount = _fmt_decimal(getattr(row, "balance_due", 0))
            days_overdue = int(getattr(row, "days_overdue", 0) or 0)
            next_step = str(getattr(row, "next_step", "Suivre l'encaissement") or "Suivre l'encaissement")
            if days_overdue >= 30:
                severity = "critical"
            elif next_step in {"Activer le lien public", "Relance prête"} or days_overdue > 0:
                severity = "high"
            elif amount > 0:
                severity = "medium"
            else:
                severity = "low"
            subtitle = " · ".join(
                part for part in [getattr(row, "customer_name", None), getattr(row, "invoice_number", None)] if part
            ) or getattr(row, "invoice_id", "Facture")
            description = f"Encours {amount} {getattr(row, 'currency', 'EUR')}"
            if days_overdue > 0:
                description += f" · {days_overdue} jour(s) de retard"
            push(
                item_id=f"collection-{getattr(row, 'invoice_id', '')}",
                module="collections",
                severity=severity,
                title=next_step,
                subtitle=subtitle,
                description=description,
                href=f"/app/invoices/{getattr(row, 'invoice_id', '')}",
                action_label="Ouvrir",
                amount=amount,
                due_at=getattr(row, "due_date", None),
                rank=100 + days_overdue,
            )

        if int(getattr(payment_ops.summary, "missing_reference_count", 0) or 0) > 0:
            count = int(payment_ops.summary.missing_reference_count or 0)
            push(
                item_id="payments-missing-reference",
                module="payments",
                severity="high" if count >= 3 else "medium",
                title="Compléter les références de règlement",
                subtitle=f"{count} paiement(s) sans référence",
                description="Ajoute une référence bancaire ou un libellé clair pour fiabiliser la piste de paiement.",
                href="/app/payments",
                action_label="Voir les paiements",
                count=count,
                rank=90 + count,
            )
        if int(getattr(payment_ops.summary, "missing_method_count", 0) or 0) > 0:
            count = int(payment_ops.summary.missing_method_count or 0)
            push(
                item_id="payments-missing-method",
                module="payments",
                severity="medium",
                title="Renseigner le mode de paiement",
                subtitle=f"{count} paiement(s) sans méthode",
                description="Carte, virement, prélèvement ou chèque : la qualité de reporting sera meilleure si la méthode est renseignée.",
                href="/app/payments",
                action_label="Corriger",
                count=count,
                rank=70 + count,
            )
    except Exception:
        payment_ops = None

    purchase_rows = []
    if purchases_enabled:
        purchase_rows = (
            db.query(InboundInvoice)
            .filter(InboundInvoice.tenant_id == user.tenant_id)
            .order_by(InboundInvoice.received_at.desc(), InboundInvoice.created_at.desc())
            .limit(40)
            .all()
        )
    purchase_candidates: list[tuple[int, datetime, Decimal, InboundInvoice, str, str, str, str]] = []
    for row in purchase_rows:
        workflow_state = None
        stored_state = purchase_state_map.get(row.id) or {}
        if stored_state:
            workflow_state = stored_state.get("state")
        else:
            workflow_state = _default_purchase_state(row)
        if workflow_state == "booked":
            continue
        severity, priority, title, description = _purchase_priority(row, workflow_state)
        received_at = _as_dt(row.received_at) or now
        amount = _fmt_decimal(row.total_ttc)
        purchase_candidates.append(
            (priority, received_at, amount, row, severity, title, description, str(workflow_state or "new"))
        )

    purchase_candidates.sort(key=lambda entry: (-entry[0], -entry[1].timestamp(), -float(entry[2] or 0)))
    for priority, received_at, amount, row, severity, title, description, workflow_state in purchase_candidates[:6]:
        subtitle = " · ".join(
            part
            for part in [
                row.supplier_name or "Fournisseur",
                row.invoice_number or row.id,
                _purchase_state_label(workflow_state),
            ]
            if part
        )
        push(
            item_id=f"purchase-{row.id}",
            module="purchases",
            severity=severity,
            title=title,
            subtitle=subtitle,
            description=description,
            href=f"/app/purchases/{row.id}",
            action_label="Traiter",
            amount=amount,
            due_at=received_at,
            rank=priority,
        )

    recurring_profiles = _recurring_profiles(settings_row)
    for index, profile in enumerate(recurring_profiles[:20]):
        name = str(profile.get("name") or "Plan récurrent")
        active = bool(profile.get("active", True))
        next_run_at = _as_dt(profile.get("next_run_at"))
        last_status = str(profile.get("last_run_status") or "").strip().lower()
        if last_status in {"failed", "error"}:
            push(
                item_id=f"recurring-failed-{profile.get('id') or index}",
                module="recurring",
                severity="critical",
                title="Corriger un plan récurrent en échec",
                subtitle=name,
                description=str(profile.get("last_run_message") or "Le dernier run a échoué et demande une revue.")[
                    :220
                ],
                href="/app/recurring",
                action_label="Ouvrir la récurrence",
                due_at=_as_dt(profile.get("last_run_at")),
                rank=120 - index,
            )
            continue
        if active and next_run_at and next_run_at <= now:
            push(
                item_id=f"recurring-due-{profile.get('id') or index}",
                module="recurring",
                severity="high",
                title="Générer une échéance récurrente",
                subtitle=name,
                description="Une facture planifiée est arrivée à échéance et peut être générée maintenant.",
                href="/app/recurring",
                action_label="Générer",
                due_at=next_run_at,
                rank=100 - index,
            )
        elif active and next_run_at and next_run_at <= (now + timedelta(days=3)):
            push(
                item_id=f"recurring-soon-{profile.get('id') or index}",
                module="recurring",
                severity="medium",
                title="Anticiper une récurrence proche",
                subtitle=name,
                description="Le plan arrive bientôt et mérite une vérification avant génération.",
                href="/app/recurring",
                action_label="Vérifier",
                due_at=next_run_at,
                rank=80 - index,
            )

    team_lookup = _team_lookup(db, user)
    for task in sorted(
        (
            _task_out(item, team_lookup)
            for item in _filter_entitled_rows(
                _read_tasks(settings_row),
                purchases_enabled=purchases_enabled,
                payments_enabled=payments_enabled,
            )
        ),
        key=lambda row: _task_sort_key(row, now),
    )[:8]:
        if task.status == "done":
            continue
        severity = task.priority
        if task.status == "blocked" and severity in {"medium", "low"}:
            severity = "high"
        if task.due_at and task.due_at <= now and severity == "low":
            severity = "medium"
        subtitle_parts = [part for part in [task.assignee_label or "Non assignée", task.module_label] if part]
        if task.status == "blocked":
            title = f"Débloquer · {task.title}"
        elif task.status == "in_progress":
            title = f"Faire avancer · {task.title}"
        else:
            title = task.title
        push(
            item_id=f"task-{task.id}",
            module="tasks",
            severity=severity,
            title=title,
            subtitle=" · ".join(subtitle_parts) or task.module_label,
            description=task.description or f"Tâche assignée au rôle {task.owner_role}.",
            href="/app/tasks",
            action_label="Ouvrir les tâches",
            due_at=task.due_at,
            rank=120 - _SEVERITY_ORDER.get(severity, 2) * 10,
        )

    items_with_sort.sort(key=lambda entry: entry[0])
    items = [item for _sort, item in items_with_sort[:18]]

    summary = ActionCenterSummaryOut(total_count=len(items))
    for item in items:
        if item.severity == "critical":
            summary.critical_count += 1
        elif item.severity == "high":
            summary.high_count += 1
        elif item.severity == "medium":
            summary.medium_count += 1
        else:
            summary.low_count += 1
        if item.due_at and item.due_at <= (now + timedelta(days=1)):
            summary.due_today_count += 1
        if item.module == "collections":
            summary.collections_count += 1
        elif item.module == "payments":
            summary.payments_count += 1
        elif item.module == "purchases":
            summary.purchases_count += 1
        elif item.module == "recurring":
            summary.recurring_count += 1
        elif item.module == "tasks":
            summary.tasks_count += 1
        elif item.module == "setup":
            summary.setup_count += 1

    return ActionCenterOut(summary=summary, items=items, generated_at=now)


@router.get("/purchase-workflow-summary", response_model=PurchaseWorkflowSummaryOut)
def purchase_workflow_summary(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("purchases_enabled")),
):
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    return _purchase_workflow_summary(db, user, settings_row=settings_row)


@router.get("/purchase-workflow/{invoice_id}", response_model=PurchaseWorkflowStateOut)
def get_purchase_workflow(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("purchases_enabled")),
):
    row = db.get(InboundInvoice, invoice_id)
    if not row or row.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    stored = _get_purchase_workflow_payload(db, user.tenant_id, invoice_id, settings_row)
    return _purchase_workflow_out(row, stored)


def _ensure_purchase_workflow_period_unlocked(db: Session, row: InboundInvoice) -> None:
    period_date = row.issue_date or (row.received_at.date() if row.received_at else None)
    if not period_date:
        return
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=row.tenant_id,
        period_start=period_date,
        period_end=period_date,
    )
    if not lock:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "accounting_period_locked",
            "message": "Cet achat appartient à une période déjà remise au cabinet.",
            "lock": accounting_period_lock_payload(lock),
        },
    )


@router.post("/purchase-workflow/{invoice_id}", response_model=PurchaseWorkflowStateOut)
def set_purchase_workflow(
    invoice_id: str,
    payload: PurchaseWorkflowPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("purchases_enabled")),
):
    row = db.get(InboundInvoice, invoice_id)
    if not row or row.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_purchase_workflow_period_unlocked(db, row)
    state = _normalize_purchase_state(payload.state)
    if state in {"approved", "ready_to_pay", "booked"} and str(row.completion_status or "").lower() != "completed":
        raise HTTPException(
            status_code=400,
            detail={
                "code": "purchase_completion_required",
                "message": "Valide d'abord la fiche achat avant de la passer en paiement.",
            },
        )
    if state in {"approved", "ready_to_pay", "booked"} and _purchase_amounts_inconsistent(row):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "purchase_amounts_inconsistent",
                "message": "Corrige les totaux de l'achat avant de le passer en paiement.",
            },
        )
    if state in {"approved", "ready_to_pay", "booked"} and _purchase_zero_vat_missing_reason(row):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "purchase_vat_zero_reason_missing",
                "message": "Renseigne le motif de TVA à 0 % avant de passer cet achat en paiement.",
            },
        )
    if state == "booked":
        total_ttc = _fmt_decimal(row.total_ttc).quantize(Decimal("0.01"))
        paid_total = _fmt_decimal(
            db.query(func.coalesce(func.sum(PurchasePayment.amount), 0))
            .filter(PurchasePayment.tenant_id == user.tenant_id, PurchasePayment.inbound_invoice_id == row.id)
            .scalar()
        ).quantize(Decimal("0.01"))
        if total_ttc > 0 and paid_total < total_ttc:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "purchase_payment_required",
                    "message": "Enregistre d'abord le règlement fournisseur depuis le détail de l'achat.",
                    "paid_total": float(paid_total),
                    "total_ttc": float(total_ttc),
                },
            )
    owner_role = _normalize_owner_role(payload.owner_role) if payload.owner_role else None
    note = (payload.note or "").strip() or None
    stored_row = _write_purchase_workflow_state_row(
        db,
        tenant_id=user.tenant_id,
        invoice_id=invoice_id,
        state=state,
        owner_role=owner_role,
        note=note,
    )
    stored = _purchase_workflow_row_payload(stored_row)
    return _purchase_workflow_out(row, stored)


@router.get("/workbench", response_model=OpsWorkbenchOut)
def ops_workbench(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    purchases_enabled, payments_enabled = _ops_feature_access(db, user)
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    playbooks_raw = _filter_entitled_rows(
        _read_playbooks(settings_row),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    playbooks = [_playbook_out(item) for item in playbooks_raw]
    playbooks.sort(
        key=lambda row: (not row.active, _MODULE_ORDER.get(row.module, 99), -(row.updated_at or now).timestamp())
    )

    workflow_summary = (
        _purchase_workflow_summary(db, user, settings_row=settings_row)
        if purchases_enabled
        else PurchaseWorkflowSummaryOut(generated_at=now)
    )
    action_data = action_center(db=db, user=user)
    active_modules = {row.module for row in playbooks if row.active}
    suggestion_specs: list[dict[str, Any]] = []

    if action_data.summary.collections_count > 0 and "collections" not in active_modules:
        suggestion_specs.append(
            {
                "id": "suggest-collections-dunning",
                "title": "Mettre le recouvrement en cadence",
                "subtitle": f"{action_data.summary.collections_count} action(s) recouvrement visibles",
                "description": "Ajoute un playbook quotidien pour garder les factures échues et les relances dans un même rituel opérateur.",
                "module": "collections",
                "severity": "high" if action_data.summary.critical_count > 0 else "medium",
                "href": "/app/automations",
                "template_key": "collections-dunning",
                "action_label": "Ajouter le playbook",
            }
        )
    if action_data.summary.payments_count > 0 and "payments" not in active_modules:
        suggestion_specs.append(
            {
                "id": "suggest-payments-quality",
                "title": "Fiabiliser les paiements",
                "subtitle": f"{action_data.summary.payments_count} point(s) de qualité paiement",
                "description": "Un rituel hebdo évite l'accumulation de paiements sans référence ou sans méthode et améliore le suivi des règlements.",
                "module": "payments",
                "severity": "medium",
                "href": "/app/automations",
                "template_key": "payments-quality",
                "action_label": "Activer la routine",
            }
        )
    if action_data.summary.purchases_count > 0 and "purchases" not in active_modules:
        suggestion_specs.append(
            {
                "id": "suggest-purchases-review",
                "title": "Structurer le workflow achats",
                "subtitle": f"{workflow_summary.states.get('reviewing', 0) + workflow_summary.states.get('awaiting_supplier', 0)} document(s) en revue ou attente",
                "description": "Formalise un playbook pour éviter que les factures fournisseurs restent coincées entre validation métier et paiement.",
                "module": "purchases",
                "severity": "high" if workflow_summary.states.get("awaiting_supplier", 0) > 0 else "medium",
                "href": "/app/purchases",
                "template_key": "purchases-review",
                "action_label": "Voir les achats",
            }
        )
    if action_data.summary.recurring_count > 0 and "recurring" not in active_modules:
        suggestion_specs.append(
            {
                "id": "suggest-recurring-check",
                "title": "Sécuriser la récurrence",
                "subtitle": f"{action_data.summary.recurring_count} sujet(s) récurrence remontés",
                "description": "Un contrôle quotidien sur les échéances et les runs en échec réduit les incidents sur les abonnements facturés.",
                "module": "recurring",
                "severity": "medium",
                "href": "/app/recurring",
                "template_key": "recurring-check",
                "action_label": "Ouvrir la récurrence",
            }
        )
    if action_data.summary.setup_count > 0 and "setup" not in active_modules:
        suggestion_specs.append(
            {
                "id": "suggest-setup-readiness",
                "title": "Verrouiller les prérequis de vente",
                "subtitle": f"{action_data.summary.setup_count} point(s) readiness restants",
                "description": "Programme un point hebdomadaire pour garder la configuration e-invoicing, branding et conformité propre avant onboarding client.",
                "module": "setup",
                "severity": "medium",
                "href": "/app/settings",
                "template_key": "setup-readiness",
                "action_label": "Configurer",
            }
        )

    suggestions = [
        WorkbenchSuggestionOut(
            id=spec["id"],
            title=spec["title"],
            subtitle=spec.get("subtitle"),
            description=spec["description"],
            module=spec["module"],
            module_label=_MODULE_LABELS[spec["module"]],
            severity=spec.get("severity", "medium"),
            href=spec.get("href", "/app/automations"),
            template_key=spec.get("template_key"),
            action_label=spec.get("action_label"),
        )
        for spec in suggestion_specs[:6]
    ]
    dunning_enabled = (
        bool((_features(settings_row).get("dunning") or {}).get("enabled"))
        if settings_row and payments_enabled
        else False
    )
    summary = OpsWorkbenchSummaryOut(
        active_playbooks=sum(1 for row in playbooks if row.active),
        covered_modules=len({row.module for row in playbooks if row.active}),
        recommended_count=len(suggestions),
        purchases_in_review=int(workflow_summary.states.get("reviewing", 0) or 0),
        ready_to_pay_count=int(workflow_summary.states.get("ready_to_pay", 0) or 0),
        dunning_enabled=dunning_enabled,
    )
    return OpsWorkbenchOut(
        summary=summary,
        playbooks=playbooks,
        suggestions=suggestions,
        purchase_workflow=workflow_summary,
        templates=[
            template
            for template in _playbook_templates_out()
            if _ops_module_allowed(
                template.module,
                purchases_enabled=purchases_enabled,
                payments_enabled=payments_enabled,
            )
        ],
        generated_at=now,
    )


@router.post("/playbooks", response_model=PlaybookOut)
def create_playbook(
    payload: PlaybookCreateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    normalized_module = _normalize_playbook_module(payload.module)
    _ensure_ops_module_access(db, user, normalized_module)
    settings_row = _ensure_settings(db, user.tenant_id)
    playbooks = _read_playbooks(settings_row)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if payload.template_key:
        template = _PLAYBOOK_TEMPLATES.get(payload.template_key)
        if not template:
            raise HTTPException(400, "Template inconnu.")
    entry = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "module": normalized_module,
        "trigger_type": _normalize_playbook_trigger(payload.trigger_type),
        "cadence": _normalize_playbook_cadence(payload.cadence),
        "owner_role": _normalize_owner_role(payload.owner_role),
        "description": (payload.description or "").strip() or None,
        "active": bool(payload.active),
        "created_at": now,
        "updated_at": now,
        "last_triggered_at": None,
        "template_key": (payload.template_key or "").strip() or None,
    }
    playbooks.append(_serialize_dt_dict(entry, _PLAYBOOK_DT_KEYS))
    settings_row = _write_features(db, settings_row, playbooks=playbooks)
    stored = _read_playbooks(settings_row)
    created = next((row for row in stored if row.get("id") == entry["id"]), None)
    if not created:
        raise HTTPException(500, "Playbook non sauvegardé.")
    return _playbook_out(created)


@router.patch("/playbooks/{playbook_id}", response_model=PlaybookOut)
def update_playbook(
    playbook_id: str,
    payload: PlaybookPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    playbooks = _read_playbooks(settings_row)
    updated: dict[str, Any] | None = None
    next_rows: list[dict[str, Any]] = []
    for row in playbooks:
        if str(row.get("id")) != playbook_id:
            next_rows.append(row)
            continue
        hydrated = _hydrate_dt_dict(row, _PLAYBOOK_DT_KEYS)
        _ensure_ops_module_access(db, user, str(hydrated.get("module") or "setup"))
        if payload.name is not None:
            hydrated["name"] = payload.name.strip()
        if payload.cadence is not None:
            hydrated["cadence"] = _normalize_playbook_cadence(payload.cadence)
        if payload.owner_role is not None:
            hydrated["owner_role"] = _normalize_owner_role(payload.owner_role)
        if payload.description is not None:
            hydrated["description"] = payload.description.strip() or None
        if payload.active is not None:
            hydrated["active"] = bool(payload.active)
        if payload.last_triggered_at is not None:
            hydrated["last_triggered_at"] = payload.last_triggered_at
        hydrated["updated_at"] = datetime.now(timezone.utc).replace(tzinfo=None)
        updated = _serialize_dt_dict(hydrated, _PLAYBOOK_DT_KEYS)
        next_rows.append(updated)
    if not updated:
        raise HTTPException(404, "Playbook introuvable.")
    settings_row = _write_features(db, settings_row, playbooks=next_rows)
    stored = next((row for row in _read_playbooks(settings_row) if str(row.get("id")) == playbook_id), None)
    if not stored:
        raise HTTPException(404, "Playbook introuvable.")
    return _playbook_out(stored)


@router.delete("/playbooks/{playbook_id}")
def delete_playbook(
    playbook_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    playbooks = _read_playbooks(settings_row)
    existing = next((row for row in playbooks if str(row.get("id")) == playbook_id), None)
    if existing:
        _ensure_ops_module_access(db, user, str(existing.get("module") or "setup"))
    next_rows = [row for row in playbooks if str(row.get("id")) != playbook_id]
    if len(next_rows) == len(playbooks):
        raise HTTPException(404, "Playbook introuvable.")
    _write_features(db, settings_row, playbooks=next_rows)
    return {"ok": True}


@router.get("/tasks-board", response_model=OpsTasksBoardOut)
def tasks_board(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    purchases_enabled, payments_enabled = _ops_feature_access(db, user)
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    team_lookup = _team_lookup(db, user)
    entitled_task_rows = _filter_entitled_rows(
        _read_tasks(settings_row),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    tasks = sorted(
        [_task_out(item, team_lookup) for item in entitled_task_rows], key=lambda row: _task_sort_key(row, now)
    )
    scheduler = _scheduler_preview_payload(
        settings_row,
        tasks,
        now,
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    action_data = action_center(db=db, user=user)
    existing_action_refs = {
        task.source_ref
        for task in tasks
        if task.status != "done" and task.source_kind == "action_center" and task.source_ref
    }
    suggestions = [
        item for item in action_data.items if item.module != "tasks" and item.id not in existing_action_refs
    ][:8]
    return OpsTasksBoardOut(
        summary=_task_summary(tasks, now),
        tasks=tasks,
        assignees=list(team_lookup.values()),
        suggestions=suggestions,
        scheduler=scheduler,
        generated_at=now,
    )


@router.post("/tasks", response_model=OpsTaskOut)
def create_task(
    payload: OpsTaskCreateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    normalized_module = _normalize_task_module(payload.module)
    _ensure_ops_module_access(db, user, normalized_module)
    settings_row = _ensure_settings(db, user.tenant_id)
    team_lookup = _team_lookup(db, user)
    assignee_user_id = (payload.assignee_user_id or "").strip() or None
    if assignee_user_id and assignee_user_id not in team_lookup:
        raise HTTPException(400, "Assignation invalide.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    entry = {
        "id": str(uuid.uuid4()),
        "title": payload.title.strip(),
        "description": (payload.description or "").strip() or None,
        "module": normalized_module,
        "status": _normalize_task_status(payload.status),
        "priority": _normalize_task_priority(payload.priority),
        "href": (payload.href or "").strip() or None,
        "owner_role": _normalize_owner_role(payload.owner_role),
        "assignee_user_id": assignee_user_id,
        "assignee_email": team_lookup[assignee_user_id].email if assignee_user_id else None,
        "due_at": payload.due_at,
        "created_at": now,
        "updated_at": now,
        "completed_at": now if _normalize_task_status(payload.status) == "done" else None,
        "source_kind": (payload.source_kind or "manual").strip() or "manual",
        "source_ref": (payload.source_ref or "").strip() or None,
    }
    tasks_raw = _read_tasks(settings_row)
    tasks_raw.append(_serialize_dt_dict(entry, _TASK_DT_KEYS))
    settings_row = _write_features(db, settings_row, tasks=tasks_raw)
    created = next((row for row in _read_tasks(settings_row) if str(row.get("id")) == entry["id"]), None)
    if not created:
        raise HTTPException(500, "Tâche non sauvegardée.")
    return _task_out(created, team_lookup)


@router.post("/tasks/from-action-center", response_model=OpsTaskOut)
def create_task_from_action_center(
    payload: CreateTaskFromActionRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    team_lookup = _team_lookup(db, user)
    assignee_user_id = (payload.assignee_user_id or "").strip() or None
    if assignee_user_id and assignee_user_id not in team_lookup:
        raise HTTPException(400, "Assignation invalide.")
    action_data = action_center(db=db, user=user)
    source = next((item for item in action_data.items if item.id == payload.action_id), None)
    if not source or source.module == "tasks":
        raise HTTPException(404, "Action introuvable.")
    settings_row = _ensure_settings(db, user.tenant_id)
    tasks_raw = _read_tasks(settings_row)
    for existing in tasks_raw:
        if (
            str(existing.get("source_kind") or "") == "action_center"
            and str(existing.get("source_ref") or "") == source.id
            and _normalize_task_status(str(existing.get("status") or "todo")) != "done"
        ):
            raise HTTPException(409, "Une tâche existe déjà pour cette action.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    entry = {
        "id": str(uuid.uuid4()),
        "title": source.title,
        "description": source.description or source.subtitle,
        "module": _normalize_task_module(source.module),
        "status": "todo",
        "priority": _normalize_task_priority(source.severity),
        "href": source.href,
        "owner_role": _normalize_owner_role(payload.owner_role or "accountant"),
        "assignee_user_id": assignee_user_id,
        "assignee_email": team_lookup[assignee_user_id].email if assignee_user_id else None,
        "due_at": payload.due_at or source.due_at,
        "created_at": now,
        "updated_at": now,
        "completed_at": None,
        "source_kind": "action_center",
        "source_ref": source.id,
    }
    tasks_raw.append(_serialize_dt_dict(entry, _TASK_DT_KEYS))
    settings_row = _write_features(db, settings_row, tasks=tasks_raw)
    created = next((row for row in _read_tasks(settings_row) if str(row.get("id")) == entry["id"]), None)
    if not created:
        raise HTTPException(500, "Tâche non sauvegardée.")
    return _task_out(created, team_lookup)


@router.patch("/tasks/{task_id}", response_model=OpsTaskOut)
def update_task(
    task_id: str,
    payload: OpsTaskPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    team_lookup = _team_lookup(db, user)
    tasks_raw = _read_tasks(settings_row)
    next_rows: list[dict[str, Any]] = []
    updated: dict[str, Any] | None = None
    for row in tasks_raw:
        if str(row.get("id")) != task_id:
            next_rows.append(row)
            continue
        hydrated = _hydrate_dt_dict(row, _TASK_DT_KEYS)
        _ensure_ops_module_access(db, user, str(hydrated.get("module") or "setup"))
        if payload.title is not None:
            hydrated["title"] = payload.title.strip()
        if payload.description is not None:
            hydrated["description"] = payload.description.strip() or None
        if payload.module is not None:
            hydrated["module"] = _normalize_task_module(payload.module)
            _ensure_ops_module_access(db, user, str(hydrated["module"]))
        if payload.status is not None:
            hydrated["status"] = _normalize_task_status(payload.status)
        if payload.priority is not None:
            hydrated["priority"] = _normalize_task_priority(payload.priority)
        if payload.href is not None:
            hydrated["href"] = payload.href.strip() or None
        if payload.owner_role is not None:
            hydrated["owner_role"] = _normalize_owner_role(payload.owner_role)
        if payload.assignee_user_id is not None:
            assignee_user_id = payload.assignee_user_id.strip() or None
            if assignee_user_id and assignee_user_id not in team_lookup:
                raise HTTPException(400, "Assignation invalide.")
            hydrated["assignee_user_id"] = assignee_user_id
            hydrated["assignee_email"] = team_lookup[assignee_user_id].email if assignee_user_id else None
        if payload.due_at is not None:
            hydrated["due_at"] = payload.due_at
        if payload.completed_at is not None:
            hydrated["completed_at"] = payload.completed_at
        if str(hydrated.get("status") or "") == "done" and not hydrated.get("completed_at"):
            hydrated["completed_at"] = datetime.now(timezone.utc).replace(tzinfo=None)
        if str(hydrated.get("status") or "") != "done":
            hydrated["completed_at"] = None
        hydrated["updated_at"] = datetime.now(timezone.utc).replace(tzinfo=None)
        updated = _serialize_dt_dict(hydrated, _TASK_DT_KEYS)
        next_rows.append(updated)
    if not updated:
        raise HTTPException(404, "Tâche introuvable.")
    settings_row = _write_features(db, settings_row, tasks=next_rows)
    stored = next((row for row in _read_tasks(settings_row) if str(row.get("id")) == task_id), None)
    if not stored:
        raise HTTPException(404, "Tâche introuvable.")
    return _task_out(stored, team_lookup)


@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    tasks_raw = _read_tasks(settings_row)
    existing = next((row for row in tasks_raw if str(row.get("id")) == task_id), None)
    if existing:
        _ensure_ops_module_access(db, user, str(existing.get("module") or "setup"))
    next_rows = [row for row in tasks_raw if str(row.get("id")) != task_id]
    if len(next_rows) == len(tasks_raw):
        raise HTTPException(404, "Tâche introuvable.")
    _write_features(db, settings_row, tasks=next_rows)
    return {"ok": True}


@router.get("/scheduler-preview", response_model=SchedulerPreviewOut)
def scheduler_preview(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    purchases_enabled, payments_enabled = _ops_feature_access(db, user)
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    team_lookup = _team_lookup(db, user)
    task_rows = _filter_entitled_rows(
        _read_tasks(settings_row),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    tasks = [_task_out(item, team_lookup) for item in task_rows]
    return _scheduler_preview_payload(
        settings_row,
        tasks,
        now,
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )


@router.post("/scheduler/run", response_model=SchedulerPreviewOut)
def scheduler_run(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    purchases_enabled, payments_enabled = _ops_feature_access(db, user)
    settings_row = _ensure_settings(db, user.tenant_id)
    team_lookup = _team_lookup(db, user)
    tasks_raw = _read_tasks(settings_row)
    open_playbook_refs = {
        str(row.get("source_ref") or "")
        for row in tasks_raw
        if str(row.get("source_kind") or "") == "playbook"
        and _normalize_task_status(str(row.get("status") or "todo")) != "done"
    }
    playbooks_raw = _read_playbooks(settings_row)
    updated_playbooks: list[dict[str, Any]] = []
    created_tasks = 0
    touched_playbooks = 0
    notes: list[str] = []
    for row in playbooks_raw:
        playbook = _playbook_out(row)
        if not _ops_module_allowed(
            playbook.module,
            purchases_enabled=purchases_enabled,
            payments_enabled=payments_enabled,
        ):
            updated_playbooks.append(row)
            continue
        delta = _playbook_delta(playbook.cadence)
        if (not playbook.active) or delta is None:
            updated_playbooks.append(row)
            continue
        reference = playbook.last_triggered_at or playbook.updated_at or playbook.created_at
        next_run = reference + delta if reference else now
        if next_run > now:
            updated_playbooks.append(row)
            continue
        touched_playbooks += 1
        hydrated = _hydrate_dt_dict(row, _PLAYBOOK_DT_KEYS)
        hydrated["last_triggered_at"] = now
        hydrated["updated_at"] = now
        updated_playbooks.append(_serialize_dt_dict(hydrated, _PLAYBOOK_DT_KEYS))
        if playbook.id not in open_playbook_refs:
            assignee = _pick_assignee_for_role(team_lookup, playbook.owner_role)
            task_entry = {
                "id": str(uuid.uuid4()),
                "title": f"Exécuter le playbook · {playbook.name}",
                "description": playbook.description
                or f"Routine {playbook.module_label.lower()} à traiter aujourd'hui.",
                "module": playbook.module,
                "status": "todo",
                "priority": "high" if playbook.module in {"collections", "purchases"} else "medium",
                "href": _MODULE_DEFAULT_HREFS.get(playbook.module, "/app/automations"),
                "owner_role": playbook.owner_role,
                "assignee_user_id": assignee.id if assignee else None,
                "assignee_email": assignee.email if assignee else None,
                "due_at": now,
                "created_at": now,
                "updated_at": now,
                "completed_at": None,
                "source_kind": "playbook",
                "source_ref": playbook.id,
            }
            tasks_raw.append(_serialize_dt_dict(task_entry, _TASK_DT_KEYS))
            created_tasks += 1
            notes.append(f"Tâche créée pour {playbook.name}")
        else:
            notes.append(f"Playbook {playbook.name} déjà représenté dans les tâches")
    run_entry = _serialize_dt_dict(
        {
            "id": str(uuid.uuid4()),
            "status": "ok",
            "trigger": "manual",
            "started_at": now,
            "finished_at": datetime.now(timezone.utc).replace(tzinfo=None),
            "updated_playbooks": touched_playbooks,
            "created_tasks": created_tasks,
            "notes": notes[:8],
        },
        _SCHEDULER_DT_KEYS,
    )
    scheduler_runs = [run_entry, *_read_scheduler_runs(settings_row)]
    settings_row = _write_features(
        db, settings_row, playbooks=updated_playbooks, tasks=tasks_raw, scheduler_runs=scheduler_runs[:20]
    )
    task_rows = _filter_entitled_rows(
        _read_tasks(settings_row),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    tasks = [_task_out(item, team_lookup) for item in task_rows]
    return _scheduler_preview_payload(
        settings_row,
        tasks,
        datetime.now(timezone.utc).replace(tzinfo=None),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
