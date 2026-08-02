from __future__ import annotations

import copy
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_viewer_or_admin
from ..models import TenantSettings
from . import ops as ops_base
from . import ops_alerts as alerts_base

router = APIRouter(prefix="/api/ops", tags=["ops"])

_RULES_STORE_KEY = "ops_digest_rules"
_PREFERENCES_STORE_KEY = "ops_digest_preferences"
_DIGEST_RUNS_STORE_KEY = "ops_digest_runs"
_RULE_DT_KEYS = {"created_at", "updated_at", "last_matched_at"}
_DIGEST_RUN_DT_KEYS = {"generated_at"}
_PREFERENCE_DT_KEYS = {"last_digest_sent_at"}
_ALLOWED_RULE_TRIGGERS = {
    "urgent_unread",
    "sla_breached",
    "due_today",
    "payment_gap",
    "purchase_waiting",
    "recurring_due",
}
_TRIGGER_LABELS = {
    "urgent_unread": "Alertes non lues",
    "sla_breached": "SLA dépassé",
    "due_today": "Échéance aujourd'hui",
    "payment_gap": "Paiement à fiabiliser",
    "purchase_waiting": "Achat à débloquer",
    "recurring_due": "Récurrence à exécuter",
}
_SEVERITY_LABELS = {
    "critical": "Critique",
    "high": "Haute",
    "medium": "Normale",
    "low": "Basse",
}
_ALLOWED_DIGEST_SCOPES = {"all", "urgent", "team"}
_DEFAULT_PREFERENCES = {
    "email_digest_enabled": True,
    "include_weekends": False,
    "digest_hour": 8,
    "digest_scope": "all",
    "critical_boost": True,
    "last_digest_sent_at": None,
}

_DEFAULT_DIGEST_HOUR = 8
_DEFAULT_DIGEST_SCOPE = "all"


class DigestRuleOut(BaseModel):
    id: str
    name: str
    module: str
    module_label: str
    trigger_type: str
    trigger_label: str
    min_severity: str
    min_severity_label: str
    owner_role: str
    notes: str | None = None
    active: bool = True
    include_in_digest: bool = True
    auto_task: bool = False
    min_amount: Decimal | None = None
    min_age_days: int | None = None
    keyword: str | None = None
    targeting_labels: list[str] = Field(default_factory=list)
    matched_count: int = 0
    sample_titles: list[str] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    last_matched_at: datetime | None = None


class DigestRulesSummaryOut(BaseModel):
    active_count: int = 0
    auto_task_count: int = 0
    digest_visible_count: int = 0
    matched_rules_count: int = 0
    matched_items_count: int = 0


class DigestRulesOut(BaseModel):
    summary: DigestRulesSummaryOut = Field(default_factory=DigestRulesSummaryOut)
    items: list[DigestRuleOut] = Field(default_factory=list)
    generated_at: datetime


class DigestRuleCreateRequest(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    module: str = Field(default="collections", min_length=3, max_length=32)
    trigger_type: str = Field(default="urgent_unread", min_length=3, max_length=40)
    min_severity: str = Field(default="high", min_length=2, max_length=16)
    owner_role: str = Field(default="accountant", min_length=3, max_length=32)
    notes: str | None = Field(default=None, max_length=500)
    active: bool = True
    include_in_digest: bool = True
    auto_task: bool = False
    min_amount: Decimal | None = Field(default=None, ge=0)
    min_age_days: int | None = Field(default=None, ge=0, le=3650)
    keyword: str | None = Field(default=None, max_length=80)


class DigestRulePatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=3, max_length=120)
    module: str | None = Field(default=None, min_length=3, max_length=32)
    trigger_type: str | None = Field(default=None, min_length=3, max_length=40)
    min_severity: str | None = Field(default=None, min_length=2, max_length=16)
    owner_role: str | None = Field(default=None, min_length=3, max_length=32)
    notes: str | None = Field(default=None, max_length=500)
    active: bool | None = None
    include_in_digest: bool | None = None
    auto_task: bool | None = None
    min_amount: Decimal | None = Field(default=None, ge=0)
    min_age_days: int | None = Field(default=None, ge=0, le=3650)
    keyword: str | None = Field(default=None, max_length=80)


class DigestPreferencesOut(BaseModel):
    email_digest_enabled: bool = True
    include_weekends: bool = False
    digest_hour: int = 8
    digest_scope: str = "all"
    critical_boost: bool = True
    delivery_mode: str = "preview"
    last_digest_sent_at: datetime | None = None


class DigestPreferencesPatchRequest(BaseModel):
    email_digest_enabled: bool | None = None
    include_weekends: bool | None = None
    digest_hour: int | None = Field(default=None, ge=0, le=23)
    digest_scope: str | None = Field(default=None, min_length=3, max_length=16)
    critical_boost: bool | None = None


class OpsDigestItemOut(BaseModel):
    id: str
    title: str
    subtitle: str | None = None
    description: str | None = None
    module: str
    module_label: str
    severity: str
    href: str
    due_at: datetime | None = None
    amount: Decimal | None = None
    age_days: int | None = None
    source_kind: str | None = None
    source_ref: str | None = None


class OpsDigestSectionOut(BaseModel):
    key: str
    title: str
    description: str | None = None
    count: int = 0
    items: list[OpsDigestItemOut] = Field(default_factory=list)


class OpsDigestRunOut(BaseModel):
    id: str
    trigger: str
    headline: str
    urgent_count: int = 0
    total_items: int = 0
    matched_rules_count: int = 0
    auto_tasks_created: int = 0
    generated_at: datetime | None = None
    notes: list[str] = Field(default_factory=list)


class OpsDigestSummaryOut(BaseModel):
    unread_count: int = 0
    urgent_count: int = 0
    due_today_count: int = 0
    sla_breached_count: int = 0
    matched_rules_count: int = 0
    matched_items_count: int = 0
    auto_task_rules_count: int = 0
    recent_auto_tasks_created: int = 0
    recommended_focus: str | None = None


class OpsDigestOut(BaseModel):
    headline: str
    summary: OpsDigestSummaryOut = Field(default_factory=OpsDigestSummaryOut)
    preferences: DigestPreferencesOut
    sections: list[OpsDigestSectionOut] = Field(default_factory=list)
    recent_runs: list[OpsDigestRunOut] = Field(default_factory=list)
    generated_at: datetime


class DeleteRuleResponse(BaseModel):
    ok: bool = True


class _RuleMatchContext(BaseModel):
    rule: DigestRuleOut
    matched_items: list[OpsDigestItemOut] = Field(default_factory=list)


def _features(settings_row: TenantSettings | None) -> dict[str, Any]:
    if settings_row and isinstance(settings_row.features, dict):
        return copy.deepcopy(settings_row.features)
    return {}


def _ensure_settings(db: Session, tenant_id: str) -> TenantSettings:
    return alerts_base._ensure_settings(db, tenant_id)


def _write_settings(
    db: Session,
    settings_row: TenantSettings,
    *,
    rules: list[dict[str, Any]] | None = None,
    preferences: dict[str, Any] | None = None,
    digest_runs: list[dict[str, Any]] | None = None,
) -> TenantSettings:
    features = _features(settings_row)
    if rules is not None:
        features[_RULES_STORE_KEY] = rules
    if preferences is not None:
        features[_PREFERENCES_STORE_KEY] = preferences
    if digest_runs is not None:
        features[_DIGEST_RUNS_STORE_KEY] = digest_runs
    settings_row.features = features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _read_rules(settings_row: TenantSettings | None) -> list[dict[str, Any]] | None:
    raw = _features(settings_row).get(_RULES_STORE_KEY)
    if raw is None:
        return None
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _read_preferences(settings_row: TenantSettings | None) -> dict[str, Any] | None:
    raw = _features(settings_row).get(_PREFERENCES_STORE_KEY)
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return {}
    return copy.deepcopy(raw)


def _read_digest_runs(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_DIGEST_RUNS_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _normalize_module(value: str | None) -> str:
    normalized = str(value or "setup").strip().lower()
    if normalized not in ops_base._MODULE_LABELS:
        raise HTTPException(400, "Module de règle invalide.")
    return normalized


def _normalize_severity(value: str | None) -> str:
    normalized = str(value or "medium").strip().lower()
    if normalized not in _SEVERITY_LABELS:
        raise HTTPException(400, "Niveau de sévérité invalide.")
    return normalized


def _normalize_rule_trigger(value: str | None) -> str:
    normalized = str(value or "urgent_unread").strip().lower()
    if normalized not in _ALLOWED_RULE_TRIGGERS:
        raise HTTPException(400, "Déclencheur de règle invalide.")
    return normalized


def _normalize_digest_scope(value: str | None) -> str:
    normalized = str(value or "all").strip().lower()
    if normalized not in _ALLOWED_DIGEST_SCOPES:
        raise HTTPException(400, "Portée de digest invalide.")
    return normalized


def _severity_rank(value: str | None) -> int:
    return {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(str(value or "medium").lower(), 9)


def _severity_at_least(actual: str | None, minimum: str | None) -> bool:
    return _severity_rank(actual) <= _severity_rank(minimum)


def _normalize_amount(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        text = str(value).strip().replace(",", ".")
        if not text:
            return None
        amount = Decimal(text)
    except Exception:
        raise HTTPException(400, "Montant minimal invalide.")
    if amount < 0:
        raise HTTPException(400, "Montant minimal invalide.")
    return amount


def _serialize_amount(value: Decimal | None) -> str | None:
    if value is None:
        return None
    normalized = value.quantize(Decimal("0.01")) if value == value else value
    return format(normalized, "f")


def _normalize_keyword(value: Any) -> str | None:
    keyword = str(value or "").strip()
    if not keyword:
        return None
    return keyword[:80]


def _normalize_age_days(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        age_days = int(value)
    except Exception:
        raise HTTPException(400, "Ancienneté minimale invalide.")
    if age_days < 0:
        raise HTTPException(400, "Ancienneté minimale invalide.")
    return age_days


def _age_days_from_due(due_at: datetime | None, now: datetime) -> int | None:
    due = ops_base._as_dt(due_at)
    if due is None:
        return None
    delta = now - due
    return max(int(delta.days), 0)


def _targeting_labels(row: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    amount = _normalize_amount(row.get("min_amount"))
    if amount is not None and amount > 0:
        labels.append(f"≥ {amount} €")
    age_days = _normalize_age_days(row.get("min_age_days"))
    if age_days is not None and age_days > 0:
        labels.append(f"≥ {age_days} j")
    keyword = _normalize_keyword(row.get("keyword"))
    if keyword:
        labels.append(f"Mot-clé · {keyword}")
    return labels


def _item_matches_targeting(item: OpsDigestItemOut, *, min_amount: Decimal | None, min_age_days: int | None, keyword: str | None) -> bool:
    if min_amount is not None and min_amount > 0:
        if item.amount is None or item.amount < min_amount:
            return False
    if min_age_days is not None and min_age_days > 0:
        if item.age_days is None or item.age_days < min_age_days:
            return False
    if keyword:
        haystack = " ".join(part for part in [item.title, item.subtitle, item.description, item.module_label] if part).lower()
        if keyword.lower() not in haystack:
            return False
    return True


def _normalize_preferences(raw: dict[str, Any] | None) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    try:
        digest_hour = int(source.get("digest_hour", _DEFAULT_DIGEST_HOUR))
    except Exception:
        digest_hour = _DEFAULT_DIGEST_HOUR
    digest_scope = source.get("digest_scope", _DEFAULT_DIGEST_SCOPE)
    try:
        digest_scope = _normalize_digest_scope(str(digest_scope))
    except HTTPException:
        digest_scope = _DEFAULT_DIGEST_SCOPE
    return {
        "email_digest_enabled": bool(source.get("email_digest_enabled", _DEFAULT_PREFERENCES["email_digest_enabled"])),
        "include_weekends": bool(source.get("include_weekends", _DEFAULT_PREFERENCES["include_weekends"])),
        "digest_hour": max(0, min(digest_hour, 23)),
        "digest_scope": digest_scope,
        "critical_boost": bool(source.get("critical_boost", _DEFAULT_PREFERENCES["critical_boost"])),
        "last_digest_sent_at": ops_base._as_dt(source.get("last_digest_sent_at")),
    }


def _preferences_out(raw: dict[str, Any] | None) -> DigestPreferencesOut:
    normalized = _normalize_preferences(raw)
    return DigestPreferencesOut(
        email_digest_enabled=bool(normalized.get("email_digest_enabled")),
        include_weekends=bool(normalized.get("include_weekends")),
        digest_hour=int(normalized.get("digest_hour") or 8),
        digest_scope=str(normalized.get("digest_scope") or "all"),
        critical_boost=bool(normalized.get("critical_boost")),
        delivery_mode="preview",
        last_digest_sent_at=normalized.get("last_digest_sent_at"),
    )


def _default_rules(now: datetime) -> list[dict[str, Any]]:
    defaults = [
        {
            "id": str(uuid.uuid4()),
            "name": "Escalades SLA critiques",
            "module": "tasks",
            "trigger_type": "sla_breached",
            "min_severity": "critical",
            "owner_role": "admin",
            "notes": "Remonte les tâches qui ont cassé une promesse opérateur et doivent être visibles au plus haut niveau.",
            "active": True,
            "include_in_digest": True,
            "auto_task": False,
            "created_at": now,
            "updated_at": now,
            "last_matched_at": None,
        },
        {
            "id": str(uuid.uuid4()),
            "name": "Recouvrement du matin",
            "module": "collections",
            "trigger_type": "urgent_unread",
            "min_severity": "high",
            "owner_role": "accountant",
            "notes": "Garde les impayés urgents visibles dans le digest quotidien.",
            "active": True,
            "include_in_digest": True,
            "auto_task": False,
            "created_at": now,
            "updated_at": now,
            "last_matched_at": None,
        },
        {
            "id": str(uuid.uuid4()),
            "name": "Qualité paiements",
            "module": "payments",
            "trigger_type": "payment_gap",
            "min_severity": "medium",
            "owner_role": "accountant",
            "notes": "Repère les références ou moyens de paiement manquants et ouvre une tâche si nécessaire.",
            "active": True,
            "include_in_digest": True,
            "auto_task": True,
            "created_at": now,
            "updated_at": now,
            "last_matched_at": None,
        },
        {
            "id": str(uuid.uuid4()),
            "name": "Achats en attente fournisseur",
            "module": "purchases",
            "trigger_type": "purchase_waiting",
            "min_severity": "medium",
            "owner_role": "accountant",
            "notes": "Met en avant les documents fournisseurs à débloquer côté équipe ou fournisseur.",
            "active": True,
            "include_in_digest": True,
            "auto_task": False,
            "created_at": now,
            "updated_at": now,
            "last_matched_at": None,
        },
        {
            "id": str(uuid.uuid4()),
            "name": "Récurrence à exécuter",
            "module": "recurring",
            "trigger_type": "recurring_due",
            "min_severity": "medium",
            "owner_role": "admin",
            "notes": "Surveille les plans récurrents dus pour éviter les oublis clients.",
            "active": True,
            "include_in_digest": True,
            "auto_task": True,
            "created_at": now,
            "updated_at": now,
            "last_matched_at": None,
        },
    ]
    return [ops_base._serialize_dt_dict(item, _RULE_DT_KEYS) for item in defaults]


def _ensure_seeded_rules(db: Session, settings_row: TenantSettings, now: datetime) -> tuple[TenantSettings, list[dict[str, Any]]]:
    rules = _read_rules(settings_row)
    if rules is not None:
        return settings_row, rules
    seeded = _default_rules(now)
    settings_row = _write_settings(db, settings_row, rules=seeded)
    return settings_row, _read_rules(settings_row) or []


def _ensure_preferences(settings_row: TenantSettings | None) -> dict[str, Any]:
    return _normalize_preferences(_read_preferences(settings_row))


def _rule_out(raw: dict[str, Any], matched_items: list[OpsDigestItemOut], now: datetime) -> DigestRuleOut:
    row = ops_base._hydrate_dt_dict(raw, _RULE_DT_KEYS)
    module = _normalize_module(row.get("module"))
    trigger_type = _normalize_rule_trigger(row.get("trigger_type"))
    min_severity = _normalize_severity(row.get("min_severity"))
    owner_role = ops_base._normalize_owner_role(row.get("owner_role") or "accountant")
    last_matched_at = row.get("last_matched_at")
    if matched_items:
        last_matched_at = last_matched_at or now
    return DigestRuleOut(
        id=str(row.get("id") or uuid.uuid4()),
        name=str(row.get("name") or "Règle digest"),
        module=module,
        module_label=ops_base._MODULE_LABELS.get(module, module),
        trigger_type=trigger_type,
        trigger_label=_TRIGGER_LABELS.get(trigger_type, trigger_type),
        min_severity=min_severity,
        min_severity_label=_SEVERITY_LABELS.get(min_severity, min_severity),
        owner_role=owner_role,
        notes=(str(row.get("notes") or "").strip() or None),
        active=bool(row.get("active", True)),
        include_in_digest=bool(row.get("include_in_digest", True)),
        auto_task=bool(row.get("auto_task", False)),
        min_amount=_normalize_amount(row.get("min_amount")),
        min_age_days=_normalize_age_days(row.get("min_age_days")),
        keyword=_normalize_keyword(row.get("keyword")),
        targeting_labels=_targeting_labels(row),
        matched_count=len(matched_items),
        sample_titles=[item.title for item in matched_items[:3]],
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
        last_matched_at=last_matched_at,
    )


def _digest_run_out(raw: dict[str, Any]) -> OpsDigestRunOut:
    row = ops_base._hydrate_dt_dict(raw, _DIGEST_RUN_DT_KEYS)
    raw_notes = row.get("notes")
    notes: list[Any] = raw_notes if isinstance(raw_notes, list) else []
    return OpsDigestRunOut(
        id=str(row.get("id") or uuid.uuid4()),
        trigger=str(row.get("trigger") or "manual"),
        headline=str(row.get("headline") or "Digest"),
        urgent_count=int(row.get("urgent_count") or 0),
        total_items=int(row.get("total_items") or 0),
        matched_rules_count=int(row.get("matched_rules_count") or 0),
        auto_tasks_created=int(row.get("auto_tasks_created") or 0),
        generated_at=row.get("generated_at"),
        notes=[str(item) for item in notes if str(item).strip()],
    )


def _notification_candidate(item: alerts_base.OpsNotificationOut) -> OpsDigestItemOut:
    due_at = ops_base._as_dt(item.due_at)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return OpsDigestItemOut(
        id=f"notif:{item.id}",
        title=item.title,
        subtitle=item.subtitle,
        description=item.description,
        module=item.module,
        module_label=item.module_label,
        severity=item.severity,
        href=item.href,
        due_at=due_at,
        amount=None,
        age_days=_age_days_from_due(due_at, now),
        source_kind=item.source_kind or "notification",
        source_ref=item.source_ref or item.id,
    )


def _sla_candidate(item: alerts_base.SlaTaskItemOut) -> OpsDigestItemOut:
    severity = item.priority
    if item.sla_state == "breached" and item.escalation_level in {"admin", "owner"}:
        severity = "critical"
    elif item.sla_state in {"breached", "blocked"} and severity in {"medium", "low"}:
        severity = "high"
    subtitle = " · ".join([part for part in [item.module_label, item.priority_label, item.assignee_label] if part]) or item.module_label
    due_at = ops_base._as_dt(item.target_at or item.due_at)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return OpsDigestItemOut(
        id=f"sla:{item.task_id}",
        title=item.title,
        subtitle=subtitle,
        description=item.sla_label,
        module=item.module,
        module_label=item.module_label,
        severity=severity,
        href=item.href or "/app/tasks",
        due_at=due_at,
        amount=None,
        age_days=_age_days_from_due(due_at, now),
        source_kind="sla_task",
        source_ref=item.task_id,
    )


def _action_candidate(item: ops_base.ActionCenterItemOut) -> OpsDigestItemOut:
    due_at = ops_base._as_dt(item.due_at)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    amount = item.amount if item.amount is not None else None
    return OpsDigestItemOut(
        id=f"action:{item.id}",
        title=item.title,
        subtitle=item.subtitle,
        description=item.description,
        module=item.module,
        module_label=item.module_label,
        severity=item.severity,
        href=item.href,
        due_at=due_at,
        amount=amount,
        age_days=_age_days_from_due(due_at, now),
        source_kind="action_center",
        source_ref=item.id,
    )


def _sort_digest_item(item: OpsDigestItemOut) -> tuple[Any, ...]:
    due = item.due_at or datetime.max
    return (_severity_rank(item.severity), due, item.title.lower())


def _dedupe_candidates(items: list[OpsDigestItemOut]) -> list[OpsDigestItemOut]:
    seen: set[str] = set()
    output: list[OpsDigestItemOut] = []
    for item in sorted(items, key=_sort_digest_item):
        if item.id in seen:
            continue
        seen.add(item.id)
        output.append(item)
    return output


def _context_bundle(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
) -> tuple[TenantSettings, alerts_base.OpsNotificationsOut, alerts_base.SlaDashboardOut, ops_base.ActionCenterOut]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or _ensure_settings(db, user.tenant_id)
    notifications = alerts_base._notifications_payload(db, user, settings_row=settings_row, persist=True, now=now)
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first() or _ensure_settings(db, user.tenant_id)
    sla_dashboard = alerts_base._sla_dashboard_payload(db, user, settings_row=settings_row, notifications=notifications.items, now=now)
    action_center = ops_base.action_center(db=db, user=user)
    return settings_row, notifications, sla_dashboard, action_center


def _match_rule_items(
    rule_row: dict[str, Any],
    *,
    notifications: alerts_base.OpsNotificationsOut,
    sla_dashboard: alerts_base.SlaDashboardOut,
    action_center: ops_base.ActionCenterOut,
    now: datetime,
) -> list[OpsDigestItemOut]:
    rule = ops_base._hydrate_dt_dict(rule_row, _RULE_DT_KEYS)
    if not bool(rule.get("active", True)):
        return []
    module = _normalize_module(rule.get("module"))
    trigger_type = _normalize_rule_trigger(rule.get("trigger_type"))
    min_severity = _normalize_severity(rule.get("min_severity"))

    pool: list[OpsDigestItemOut] = []
    notification_items = [_notification_candidate(item) for item in notifications.items]
    unread_notifications = [item for item in notification_items if not next((n for n in notifications.items if f"notif:{n.id}" == item.id and n.read), False)]
    if trigger_type == "urgent_unread":
        pool = [item for item in unread_notifications if item.module == module]
    elif trigger_type == "sla_breached":
        pool = [_sla_candidate(item) for item in sla_dashboard.items if item.sla_state in {"breached", "blocked"}]
        if module != "tasks":
            pool = [item for item in pool if item.module == module]
    elif trigger_type == "due_today":
        due_limit = now + timedelta(days=1)
        pool = [
            item
            for item in (notification_items + [_action_candidate(row) for row in action_center.items])
            if item.module == module and item.due_at and item.due_at <= due_limit
        ]
    elif trigger_type == "payment_gap":
        pool = [_action_candidate(item) for item in action_center.items if item.module == "payments"]
    elif trigger_type == "purchase_waiting":
        pool = [_action_candidate(item) for item in action_center.items if item.module == "purchases"]
    elif trigger_type == "recurring_due":
        pool = [_action_candidate(item) for item in action_center.items if item.module == "recurring"]
    else:
        pool = [_action_candidate(item) for item in action_center.items if item.module == module]

    min_amount = _normalize_amount(rule.get("min_amount"))
    min_age_days = _normalize_age_days(rule.get("min_age_days"))
    keyword = _normalize_keyword(rule.get("keyword"))
    filtered = [
        item
        for item in pool
        if _severity_at_least(item.severity, min_severity)
        and _item_matches_targeting(item, min_amount=min_amount, min_age_days=min_age_days, keyword=keyword)
    ]
    return _dedupe_candidates(filtered)[:8]


def _rules_payload(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
) -> tuple[TenantSettings, DigestRulesOut, list[_RuleMatchContext]]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or _ensure_settings(db, user.tenant_id)
    settings_row, raw_rules = _ensure_seeded_rules(db, settings_row, now)
    settings_row, notifications, sla_dashboard, action_center = _context_bundle(db, user, settings_row=settings_row, now=now)

    items: list[DigestRuleOut] = []
    contexts: list[_RuleMatchContext] = []
    summary = DigestRulesSummaryOut()
    for raw in raw_rules:
        matched_items = _match_rule_items(raw, notifications=notifications, sla_dashboard=sla_dashboard, action_center=action_center, now=now)
        item = _rule_out(raw, matched_items, now)
        contexts.append(_RuleMatchContext(rule=item, matched_items=matched_items))
        items.append(item)
        if item.active:
            summary.active_count += 1
        if item.auto_task:
            summary.auto_task_count += 1
        if item.include_in_digest:
            summary.digest_visible_count += 1
        if item.matched_count > 0:
            summary.matched_rules_count += 1
            summary.matched_items_count += item.matched_count
    items.sort(key=lambda row: (not row.active, _severity_rank(row.min_severity), row.module_label.lower(), row.name.lower()))
    return settings_row, DigestRulesOut(summary=summary, items=items, generated_at=now), contexts


def _recommended_focus(notifications: alerts_base.OpsNotificationsOut, sla_dashboard: alerts_base.SlaDashboardOut, action_center: ops_base.ActionCenterOut) -> str | None:
    if sla_dashboard.summary.breached_count > 0:
        return "Sécuriser les SLA dépassés"
    if notifications.summary.critical_unread_count > 0:
        return "Traiter les alertes critiques non lues"
    if action_center.summary.collections_count > 0:
        return "Avancer sur le recouvrement"
    if action_center.summary.payments_count > 0:
        return "Fiabiliser les paiements"
    if action_center.summary.purchases_count > 0:
        return "Débloquer les achats"
    if action_center.summary.recurring_count > 0:
        return "Vérifier la récurrence"
    return None


def _digest_sections(
    *,
    preferences: dict[str, Any],
    notifications: alerts_base.OpsNotificationsOut,
    sla_dashboard: alerts_base.SlaDashboardOut,
    action_center: ops_base.ActionCenterOut,
    rule_contexts: list[_RuleMatchContext],
    now: datetime,
) -> list[OpsDigestSectionOut]:
    urgent_items = _dedupe_candidates(
        [
            _notification_candidate(item)
            for item in notifications.items
            if not item.read and item.severity in ({"critical", "high"} if preferences.get("critical_boost") else {"critical"})
        ]
        + [
            _sla_candidate(item)
            for item in sla_dashboard.items
            if item.sla_state in {"breached", "blocked"}
        ]
    )[:6]

    due_limit = now + timedelta(days=1)
    due_today_items = _dedupe_candidates(
        [
            _action_candidate(item)
            for item in action_center.items
            if item.due_at and item.due_at <= due_limit and item.module != "tasks"
        ]
        + [
            _notification_candidate(item)
            for item in notifications.items
            if item.due_at and item.due_at <= due_limit and not item.read
        ]
    )[:6]

    rule_items = [
        OpsDigestItemOut(
            id=f"rule:{context.rule.id}",
            title=context.rule.name,
            subtitle=f"{context.rule.matched_count} signal(s) · {context.rule.module_label}",
            description=context.rule.sample_titles[0] if context.rule.sample_titles else context.rule.notes,
            module=context.rule.module,
            module_label=context.rule.module_label,
            severity=context.rule.min_severity,
            href="/app/notifications",
            due_at=context.matched_items[0].due_at if context.matched_items else None,
            source_kind="digest_rule",
            source_ref=context.rule.id,
        )
        for context in rule_contexts
        if context.rule.active and context.rule.include_in_digest and context.rule.matched_count > 0
    ]
    rule_items = _dedupe_candidates(rule_items)[:6]

    sections = [
        OpsDigestSectionOut(
            key="urgent",
            title="Urgences du moment",
            description="Les signaux qui méritent une lecture immédiate côté équipe ou management.",
            count=len(urgent_items),
            items=urgent_items,
        ),
        OpsDigestSectionOut(
            key="today",
            title="À traiter aujourd'hui",
            description="Actions dues ou proches de l'échéance sur le flux métier.",
            count=len(due_today_items),
            items=due_today_items,
        ),
        OpsDigestSectionOut(
            key="rules",
            title="Règles automatiques actives",
            description="Les règles qui remontent des signaux utiles dans ton digest et peuvent ouvrir des tâches.",
            count=len(rule_items),
            items=rule_items,
        ),
    ]
    scope = str(preferences.get("digest_scope") or "all")
    if scope == "urgent":
        return sections[:1] + [sections[2]]
    if scope == "team":
        return sections[1:]
    return sections


def _digest_payload(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
) -> tuple[TenantSettings, OpsDigestOut, list[_RuleMatchContext]]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or _ensure_settings(db, user.tenant_id)
    preferences = _ensure_preferences(settings_row)
    settings_row, notifications, sla_dashboard, action_center = _context_bundle(db, user, settings_row=settings_row, now=now)
    settings_row, rules_payload, rule_contexts = _rules_payload(db, user, settings_row=settings_row, now=now)
    preferences = _ensure_preferences(settings_row)
    recent_runs = sorted((_digest_run_out(item) for item in _read_digest_runs(settings_row)), key=lambda row: row.generated_at or datetime.min, reverse=True)[:6]
    sections = _digest_sections(
        preferences=preferences,
        notifications=notifications,
        sla_dashboard=sla_dashboard,
        action_center=action_center,
        rule_contexts=rule_contexts,
        now=now,
    )
    urgent_count = sum(section.count for section in sections if section.key == "urgent")
    due_today_count = sum(section.count for section in sections if section.key == "today")
    summary = OpsDigestSummaryOut(
        unread_count=notifications.summary.unread_count,
        urgent_count=urgent_count,
        due_today_count=due_today_count,
        sla_breached_count=sla_dashboard.summary.breached_count,
        matched_rules_count=rules_payload.summary.matched_rules_count,
        matched_items_count=rules_payload.summary.matched_items_count,
        auto_task_rules_count=rules_payload.summary.auto_task_count,
        recent_auto_tasks_created=recent_runs[0].auto_tasks_created if recent_runs else 0,
        recommended_focus=_recommended_focus(notifications, sla_dashboard, action_center),
    )
    headline = (
        f"{summary.urgent_count} urgence(s), {summary.sla_breached_count} SLA dépassé(s) et "
        f"{summary.unread_count} notification(s) non lue(s)."
    )
    return settings_row, OpsDigestOut(
        headline=headline,
        summary=summary,
        preferences=_preferences_out(preferences),
        sections=sections,
        recent_runs=recent_runs,
        generated_at=now,
    ), rule_contexts


def _create_auto_tasks_from_rules(
    db: Session,
    user: AuthUser,
    settings_row: TenantSettings,
    *,
    rule_contexts: list[_RuleMatchContext],
    now: datetime,
) -> tuple[TenantSettings, int, list[str], list[dict[str, Any]]]:
    tasks_raw = ops_base._read_tasks(settings_row)
    team_lookup = ops_base._team_lookup(db, user)
    existing_refs = {
        (str(item.get("source_kind") or ""), str(item.get("source_ref") or ""))
        for item in tasks_raw
        if ops_base._normalize_task_status(str(item.get("status") or "todo")) != "done"
    }
    created_count = 0
    notes: list[str] = []
    updated_rule_rows: list[dict[str, Any]] = []

    raw_rules = _read_rules(settings_row) or []
    for raw in raw_rules:
        rule_id = str(raw.get("id") or "")
        context = next((ctx for ctx in rule_contexts if ctx.rule.id == rule_id), None)
        if not context:
            updated_rule_rows.append(raw)
            continue
        if context.matched_items:
            hydrated_rule = ops_base._hydrate_dt_dict(raw, _RULE_DT_KEYS)
            hydrated_rule["last_matched_at"] = now
            hydrated_rule["updated_at"] = now
            raw = ops_base._serialize_dt_dict(hydrated_rule, _RULE_DT_KEYS)
        updated_rule_rows.append(raw)
        if not context.rule.active or not context.rule.auto_task:
            continue
        assignee = ops_base._pick_assignee_for_role(team_lookup, context.rule.owner_role)
        for item in context.matched_items[:3]:
            source_ref = f"{context.rule.id}:{item.id}"
            key = ("digest_rule", source_ref)
            if key in existing_refs:
                continue
            entry = {
                "id": str(uuid.uuid4()),
                "title": item.title,
                "description": f"Règle auto “{context.rule.name}” · {item.description or item.subtitle or context.rule.notes or 'Action issue du digest opérateur.'}",
                "module": item.module if item.module in ops_base._MODULE_LABELS else context.rule.module,
                "status": "todo",
                "priority": item.severity if item.severity in _SEVERITY_LABELS else context.rule.min_severity,
                "href": item.href or ops_base._MODULE_DEFAULT_HREFS.get(context.rule.module, "/app/tasks"),
                "owner_role": context.rule.owner_role,
                "assignee_user_id": assignee.id if assignee else None,
                "assignee_email": assignee.email if assignee else None,
                "due_at": item.due_at or (now + timedelta(days=1)),
                "created_at": now,
                "updated_at": now,
                "completed_at": None,
                "source_kind": "digest_rule",
                "source_ref": source_ref,
            }
            tasks_raw.append(ops_base._serialize_dt_dict(entry, ops_base._TASK_DT_KEYS))
            existing_refs.add(key)
            created_count += 1
            notes.append(f"Tâche créée · {context.rule.name} → {item.title}")
    if created_count > 0:
        settings_row = ops_base._write_features(db, settings_row, tasks=tasks_raw)
        settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first() or settings_row
    return settings_row, created_count, notes, updated_rule_rows


@router.get("/digest-rules", response_model=DigestRulesOut)
def list_digest_rules(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    _, payload, _ = _rules_payload(db, user, settings_row=settings_row)
    return payload


@router.post("/digest-rules", response_model=DigestRuleOut)
def create_digest_rule(
    payload: DigestRuleCreateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row, raw_rules = _ensure_seeded_rules(db, settings_row, now)
    entry = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "module": _normalize_module(payload.module),
        "trigger_type": _normalize_rule_trigger(payload.trigger_type),
        "min_severity": _normalize_severity(payload.min_severity),
        "owner_role": ops_base._normalize_owner_role(payload.owner_role),
        "notes": (payload.notes or "").strip() or None,
        "active": bool(payload.active),
        "include_in_digest": bool(payload.include_in_digest),
        "auto_task": bool(payload.auto_task),
        "min_amount": _serialize_amount(_normalize_amount(payload.min_amount)),
        "min_age_days": _normalize_age_days(payload.min_age_days),
        "keyword": _normalize_keyword(payload.keyword),
        "created_at": now,
        "updated_at": now,
        "last_matched_at": None,
    }
    raw_rules.append(ops_base._serialize_dt_dict(entry, _RULE_DT_KEYS))
    settings_row = _write_settings(db, settings_row, rules=raw_rules)
    return _rule_out(entry, [], now)


@router.patch("/digest-rules/{rule_id}", response_model=DigestRuleOut)
def update_digest_rule(
    rule_id: str,
    payload: DigestRulePatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row, raw_rules = _ensure_seeded_rules(db, settings_row, now)
    fields_set = set(getattr(payload, "model_fields_set", getattr(payload, "__fields_set__", set())))
    next_rows: list[dict[str, Any]] = []
    updated_row: dict[str, Any] | None = None
    for raw in raw_rules:
        hydrated = ops_base._hydrate_dt_dict(raw, _RULE_DT_KEYS)
        if str(hydrated.get("id") or "") != rule_id:
            next_rows.append(raw)
            continue
        if "name" in fields_set and payload.name is not None:
            hydrated["name"] = payload.name.strip()
        if "module" in fields_set and payload.module is not None:
            hydrated["module"] = _normalize_module(payload.module)
        if "trigger_type" in fields_set and payload.trigger_type is not None:
            hydrated["trigger_type"] = _normalize_rule_trigger(payload.trigger_type)
        if "min_severity" in fields_set and payload.min_severity is not None:
            hydrated["min_severity"] = _normalize_severity(payload.min_severity)
        if "owner_role" in fields_set and payload.owner_role is not None:
            hydrated["owner_role"] = ops_base._normalize_owner_role(payload.owner_role)
        if "notes" in fields_set:
            hydrated["notes"] = (payload.notes or "").strip() or None
        if "active" in fields_set:
            hydrated["active"] = bool(payload.active)
        if "include_in_digest" in fields_set:
            hydrated["include_in_digest"] = bool(payload.include_in_digest)
        if "auto_task" in fields_set:
            hydrated["auto_task"] = bool(payload.auto_task)
        if "min_amount" in fields_set:
            hydrated["min_amount"] = _serialize_amount(_normalize_amount(payload.min_amount))
        if "min_age_days" in fields_set:
            hydrated["min_age_days"] = _normalize_age_days(payload.min_age_days)
        if "keyword" in fields_set:
            hydrated["keyword"] = _normalize_keyword(payload.keyword)
        hydrated["updated_at"] = now
        updated_row = hydrated
        next_rows.append(ops_base._serialize_dt_dict(hydrated, _RULE_DT_KEYS))
    if updated_row is None:
        raise HTTPException(404, "Règle introuvable.")
    settings_row = _write_settings(db, settings_row, rules=next_rows)
    _, notifications, sla_dashboard, action_center = _context_bundle(db, user, settings_row=settings_row, now=now)
    matched_items = _match_rule_items(updated_row, notifications=notifications, sla_dashboard=sla_dashboard, action_center=action_center, now=now)
    return _rule_out(updated_row, matched_items, now)


@router.delete("/digest-rules/{rule_id}", response_model=DeleteRuleResponse)
def delete_digest_rule(
    rule_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row, raw_rules = _ensure_seeded_rules(db, settings_row, now)
    next_rows = [row for row in raw_rules if str(row.get("id") or "") != rule_id]
    if len(next_rows) == len(raw_rules):
        raise HTTPException(404, "Règle introuvable.")
    _write_settings(db, settings_row, rules=next_rows)
    return DeleteRuleResponse(ok=True)


@router.get("/digest-preferences", response_model=DigestPreferencesOut)
def get_digest_preferences(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    return _preferences_out(_ensure_preferences(settings_row))


@router.patch("/digest-preferences", response_model=DigestPreferencesOut)
def update_digest_preferences(
    payload: DigestPreferencesPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    current = _ensure_preferences(settings_row)
    if payload.email_digest_enabled is not None:
        current["email_digest_enabled"] = bool(payload.email_digest_enabled)
    if payload.include_weekends is not None:
        current["include_weekends"] = bool(payload.include_weekends)
    if payload.digest_hour is not None:
        current["digest_hour"] = max(0, min(int(payload.digest_hour), 23))
    if payload.digest_scope is not None:
        current["digest_scope"] = _normalize_digest_scope(payload.digest_scope)
    if payload.critical_boost is not None:
        current["critical_boost"] = bool(payload.critical_boost)
    serializable = dict(current)
    serializable["last_digest_sent_at"] = ops_base._to_iso(current.get("last_digest_sent_at"))
    settings_row = _write_settings(db, settings_row, preferences=serializable)
    return _preferences_out(current)


@router.get("/digest", response_model=OpsDigestOut)
def digest_preview(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    _, payload, _ = _digest_payload(db, user, settings_row=settings_row)
    return payload


@router.post("/digest/run", response_model=OpsDigestOut)
def run_digest(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = _ensure_settings(db, user.tenant_id)
    settings_row, digest_payload, rule_contexts = _digest_payload(db, user, settings_row=settings_row, now=now)
    settings_row, created_count, notes, updated_rule_rows = _create_auto_tasks_from_rules(
        db,
        user,
        settings_row,
        rule_contexts=rule_contexts,
        now=now,
    )

    external_delivery_notes: list[str] = []
    try:
        from . import ops_supervision as supervision_base

        settings_row, external_deliveries = supervision_base.dispatch_digest_to_channels(
            db,
            settings_row,
            digest_payload=digest_payload,
            now=now,
        )
        if external_deliveries:
            ok_count = sum(1 for item in external_deliveries if str(item.get("status") or "").lower() in {"ok", "success"})
            fail_count = sum(1 for item in external_deliveries if str(item.get("status") or "").lower() in {"error", "failed"})
            external_delivery_notes.append(f"Digest externe · {ok_count} canal(aux) OK")
            if fail_count > 0:
                external_delivery_notes.append(f"Digest externe · {fail_count} échec(s) canal")
    except Exception:
        pass

    digest_runs_raw = _read_digest_runs(settings_row)
    run_entry = {
        "id": str(uuid.uuid4()),
        "trigger": "manual",
        "headline": digest_payload.headline,
        "urgent_count": digest_payload.summary.urgent_count,
        "total_items": sum(section.count for section in digest_payload.sections),
        "matched_rules_count": digest_payload.summary.matched_rules_count,
        "auto_tasks_created": created_count,
        "generated_at": now,
        "notes": [*external_delivery_notes[:2], *notes[:6]][:6],
    }
    digest_runs_raw.insert(0, ops_base._serialize_dt_dict(run_entry, _DIGEST_RUN_DT_KEYS))
    digest_runs_raw = digest_runs_raw[:20]

    preferences = _ensure_preferences(settings_row)
    preferences["last_digest_sent_at"] = now
    serializable_prefs = dict(preferences)
    serializable_prefs["last_digest_sent_at"] = ops_base._to_iso(now)

    if updated_rule_rows:
        settings_row = _write_settings(db, settings_row, rules=updated_rule_rows, preferences=serializable_prefs, digest_runs=digest_runs_raw)
    else:
        settings_row = _write_settings(db, settings_row, preferences=serializable_prefs, digest_runs=digest_runs_raw)
    _, refreshed_payload, _ = _digest_payload(db, user, settings_row=settings_row, now=now)
    return refreshed_payload
