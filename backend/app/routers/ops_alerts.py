from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_viewer_or_admin
from ..models import TenantSettings
from . import ops as ops_base

router = APIRouter(prefix="/api/ops", tags=["ops"])

_NOTIFICATION_STORE_KEY = "ops_notifications"
_SLA_POLICY_STORE_KEY = "ops_sla_policy"
_NOTIFICATION_DT_KEYS = {"created_at", "updated_at", "read_at", "due_at"}
_DEFAULT_SLA_PRIORITY_HOURS = {
    "critical": 4,
    "high": 12,
    "medium": 24,
    "low": 48,
}
_DEFAULT_SLA_NOTIFY_BEFORE_HOURS = 6
_DEFAULT_SLA_ESCALATE_AFTER_HOURS = 8


class OpsNotificationOut(BaseModel):
    id: str
    title: str
    subtitle: str | None = None
    description: str | None = None
    module: str
    module_label: str
    severity: str
    href: str
    source_kind: str | None = None
    source_ref: str | None = None
    read: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None
    read_at: datetime | None = None
    due_at: datetime | None = None


class OpsNotificationsSummaryOut(BaseModel):
    total_count: int = 0
    unread_count: int = 0
    read_count: int = 0
    critical_unread_count: int = 0
    high_unread_count: int = 0
    due_today_count: int = 0
    modules: dict[str, int] = Field(default_factory=dict)


class OpsNotificationsOut(BaseModel):
    summary: OpsNotificationsSummaryOut = Field(default_factory=OpsNotificationsSummaryOut)
    items: list[OpsNotificationOut] = Field(default_factory=list)
    generated_at: datetime


class OpsNotificationPatchRequest(BaseModel):
    read: bool | None = None


class SlaPolicyOut(BaseModel):
    priority_hours: dict[str, int] = Field(default_factory=dict)
    notify_before_hours: int = _DEFAULT_SLA_NOTIFY_BEFORE_HOURS
    escalate_after_hours: int = _DEFAULT_SLA_ESCALATE_AFTER_HOURS


class SlaPolicyPatchRequest(BaseModel):
    priority_hours: dict[str, int] | None = None
    notify_before_hours: int | None = Field(default=None, ge=1, le=168)
    escalate_after_hours: int | None = Field(default=None, ge=1, le=336)


class SlaTaskItemOut(BaseModel):
    task_id: str
    title: str
    module: str
    module_label: str
    priority: str
    priority_label: str
    status: str
    status_label: str
    assignee_label: str | None = None
    href: str
    created_at: datetime | None = None
    due_at: datetime | None = None
    target_at: datetime | None = None
    minutes_remaining: int | None = None
    breach_minutes: int | None = None
    sla_state: str
    sla_label: str
    escalation_level: str | None = None


class SlaSummaryOut(BaseModel):
    tasks_considered: int = 0
    open_tasks_count: int = 0
    on_track_count: int = 0
    due_next_24h_count: int = 0
    breached_count: int = 0
    escalated_count: int = 0
    blocked_count: int = 0
    notifications_count: int = 0


class SlaDashboardOut(BaseModel):
    policy: SlaPolicyOut
    summary: SlaSummaryOut = Field(default_factory=SlaSummaryOut)
    items: list[SlaTaskItemOut] = Field(default_factory=list)
    generated_at: datetime


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



def _write_settings(
    db: Session,
    settings_row: TenantSettings,
    *,
    notifications: list[dict[str, Any]] | None = None,
    sla_policy: dict[str, Any] | None = None,
) -> TenantSettings:
    features = _features(settings_row)
    if notifications is not None:
        features[_NOTIFICATION_STORE_KEY] = notifications
    if sla_policy is not None:
        features[_SLA_POLICY_STORE_KEY] = sla_policy
    settings_row.features = features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row



def _read_notifications(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_NOTIFICATION_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]



def _normalize_sla_policy(value: dict[str, Any] | None) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    raw_priority = raw.get("priority_hours")
    priority_raw: dict[str, Any] = raw_priority if isinstance(raw_priority, dict) else {}
    priority_hours: dict[str, int] = {}
    for key, default in _DEFAULT_SLA_PRIORITY_HOURS.items():
        try:
            candidate = int(priority_raw.get(key, default))
        except Exception:
            candidate = default
        priority_hours[key] = max(1, min(candidate, 336))
    try:
        notify_before_hours = int(raw.get("notify_before_hours", _DEFAULT_SLA_NOTIFY_BEFORE_HOURS))
    except Exception:
        notify_before_hours = _DEFAULT_SLA_NOTIFY_BEFORE_HOURS
    try:
        escalate_after_hours = int(raw.get("escalate_after_hours", _DEFAULT_SLA_ESCALATE_AFTER_HOURS))
    except Exception:
        escalate_after_hours = _DEFAULT_SLA_ESCALATE_AFTER_HOURS
    return {
        "priority_hours": priority_hours,
        "notify_before_hours": max(1, min(notify_before_hours, 168)),
        "escalate_after_hours": max(1, min(escalate_after_hours, 336)),
    }



def _read_sla_policy(settings_row: TenantSettings | None) -> dict[str, Any]:
    raw = _features(settings_row).get(_SLA_POLICY_STORE_KEY)
    return _normalize_sla_policy(raw if isinstance(raw, dict) else None)



def _notification_out(payload: dict[str, Any]) -> OpsNotificationOut:
    row = ops_base._hydrate_dt_dict(payload, _NOTIFICATION_DT_KEYS)
    module = str(row.get("module") or "setup").strip().lower()
    if module not in ops_base._MODULE_LABELS:
        module = "setup"
    severity = str(row.get("severity") or "medium").strip().lower()
    if severity not in {"critical", "high", "medium", "low"}:
        severity = "medium"
    return OpsNotificationOut(
        id=str(row.get("id") or "notif"),
        title=str(row.get("title") or "Notification"),
        subtitle=(str(row.get("subtitle") or "").strip() or None),
        description=(str(row.get("description") or "").strip() or None),
        module=module,
        module_label=ops_base._MODULE_LABELS.get(module, module),
        severity=severity,
        href=(str(row.get("href") or "").strip() or ops_base._MODULE_DEFAULT_HREFS.get(module, "/app/dashboard")),
        source_kind=(str(row.get("source_kind") or "").strip() or None),
        source_ref=(str(row.get("source_ref") or "").strip() or None),
        read=bool(row.get("read") or row.get("read_at")),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
        read_at=row.get("read_at"),
        due_at=row.get("due_at"),
    )



def _notification_sort_key(item: OpsNotificationOut) -> tuple[Any, ...]:
    due = item.due_at or item.updated_at or item.created_at or datetime.min
    return (bool(item.read), ops_base._SEVERITY_ORDER.get(item.severity, 9), -due.timestamp(), item.title.lower())



def _task_target_at(task: ops_base.OpsTaskOut, policy: dict[str, Any]) -> datetime | None:
    reference = task.created_at or task.updated_at or None
    if reference is None:
        return task.due_at
    try:
        hours = int(policy.get("priority_hours", {}).get(task.priority, _DEFAULT_SLA_PRIORITY_HOURS.get(task.priority, 24)))
    except Exception:
        hours = _DEFAULT_SLA_PRIORITY_HOURS.get(task.priority, 24)
    target_at = reference + timedelta(hours=max(1, hours))
    if task.due_at and task.due_at < target_at:
        return task.due_at
    return target_at



def _task_escalation_level(task: ops_base.OpsTaskOut, breach_minutes: int, policy: dict[str, Any]) -> str | None:
    if breach_minutes <= 0:
        return None
    threshold_minutes = int(policy.get("escalate_after_hours", _DEFAULT_SLA_ESCALATE_AFTER_HOURS)) * 60
    if breach_minutes < threshold_minutes:
        return None
    if task.priority == "critical" or breach_minutes >= threshold_minutes * 3:
        return "owner"
    if task.priority == "high" or breach_minutes >= threshold_minutes * 2:
        return "admin"
    return "accountant"



def _sla_item(task: ops_base.OpsTaskOut, policy: dict[str, Any], now: datetime) -> SlaTaskItemOut | None:
    if task.status == "done":
        return None
    target_at = _task_target_at(task, policy)
    status_label = task.status_label or task.status
    assignee_label = task.assignee_label or task.assignee_email
    if target_at is None:
        return SlaTaskItemOut(
            task_id=task.id,
            title=task.title,
            module=task.module,
            module_label=task.module_label,
            priority=task.priority,
            priority_label=task.priority_label,
            status=task.status,
            status_label=status_label,
            assignee_label=assignee_label,
            href=task.href,
            created_at=task.created_at,
            due_at=task.due_at,
            target_at=None,
            minutes_remaining=None,
            breach_minutes=None,
            sla_state="no_target",
            sla_label="Sans cible SLA",
            escalation_level=None,
        )
    delta_minutes = int((target_at - now).total_seconds() // 60)
    notify_before_minutes = int(policy.get("notify_before_hours", _DEFAULT_SLA_NOTIFY_BEFORE_HOURS)) * 60
    breach_minutes = max(0, -delta_minutes)
    escalation_level = _task_escalation_level(task, breach_minutes, policy)
    if breach_minutes > 0:
        hours = round(breach_minutes / 60, 1)
        sla_state = "breached"
        sla_label = f"SLA dépassé · {hours} h"
    elif task.status == "blocked":
        sla_state = "blocked"
        remaining = max(0, delta_minutes)
        hours = round(remaining / 60, 1)
        sla_label = f"Bloquée · {hours} h restantes"
    elif delta_minutes <= notify_before_minutes:
        sla_state = "due_soon"
        hours = round(max(0, delta_minutes) / 60, 1)
        sla_label = f"À surveiller · {hours} h"
    else:
        sla_state = "on_track"
        hours = round(delta_minutes / 60, 1)
        sla_label = f"Dans les temps · {hours} h"
    return SlaTaskItemOut(
        task_id=task.id,
        title=task.title,
        module=task.module,
        module_label=task.module_label,
        priority=task.priority,
        priority_label=task.priority_label,
        status=task.status,
        status_label=status_label,
        assignee_label=assignee_label,
        href=task.href,
        created_at=task.created_at,
        due_at=task.due_at,
        target_at=target_at,
        minutes_remaining=delta_minutes if delta_minutes >= 0 else None,
        breach_minutes=breach_minutes if breach_minutes > 0 else None,
        sla_state=sla_state,
        sla_label=sla_label,
        escalation_level=escalation_level,
    )



def _sla_dashboard_payload(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    notifications: list[OpsNotificationOut] | None = None,
    now: datetime | None = None,
) -> SlaDashboardOut:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    policy = _read_sla_policy(settings_row)
    team_lookup = ops_base._team_lookup(db, user)
    purchases_enabled, payments_enabled = ops_base._ops_feature_access(db, user)
    entitled_task_rows = ops_base._filter_entitled_rows(
        ops_base._read_tasks(settings_row),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    tasks = [ops_base._task_out(item, team_lookup) for item in entitled_task_rows]
    sla_items = [item for item in (_sla_item(task, policy, now) for task in tasks) if item is not None]
    sla_items.sort(
        key=lambda item: (
            {"breached": 0, "blocked": 1, "due_soon": 2, "on_track": 3, "no_target": 4}.get(item.sla_state, 9),
            ops_base._SEVERITY_ORDER.get(item.priority, 9),
            (item.target_at or datetime.max),
            item.title.lower(),
        )
    )
    summary = SlaSummaryOut(
        tasks_considered=len(sla_items),
        open_tasks_count=len([item for item in sla_items if item.status != "done"]),
        on_track_count=len([item for item in sla_items if item.sla_state == "on_track"]),
        due_next_24h_count=len([item for item in sla_items if item.sla_state in {"due_soon", "blocked"}]),
        breached_count=len([item for item in sla_items if item.sla_state == "breached"]),
        escalated_count=len([item for item in sla_items if item.escalation_level is not None]),
        blocked_count=len([item for item in sla_items if item.status == "blocked"]),
        notifications_count=len(notifications or []),
    )
    return SlaDashboardOut(
        policy=SlaPolicyOut(**policy),
        summary=summary,
        items=sla_items[:20],
        generated_at=now,
    )



def _build_notification_candidates(
    db: Session,
    user: AuthUser,
    settings_row: TenantSettings | None,
    now: datetime,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    purchases_enabled, payments_enabled = ops_base._ops_feature_access(db, user)

    def push(entry: dict[str, Any]) -> None:
        item_id = str(entry.get("id") or "").strip()
        if not item_id or item_id in seen:
            return
        seen.add(item_id)
        candidates.append(entry)

    action_data = ops_base.action_center(db=db, user=user)
    for item in action_data.items[:16]:
        severity = str(item.severity or "medium").lower()
        include = severity in {"critical", "high"}
        if not include and item.due_at and item.due_at <= (now + timedelta(days=1)):
            include = True
        if not include:
            continue
        push(
            {
                "id": f"action:{item.id}",
                "title": item.title,
                "subtitle": item.subtitle or item.module_label,
                "description": item.description,
                "module": item.module,
                "severity": severity,
                "href": item.href,
                "source_kind": "action_center",
                "source_ref": item.id,
                "created_at": item.due_at or action_data.generated_at or now,
                "updated_at": now,
                "due_at": item.due_at,
            }
        )

    sla_dashboard = _sla_dashboard_payload(db, user, settings_row=settings_row, notifications=None, now=now)
    for item in sla_dashboard.items[:12]:
        if item.sla_state not in {"breached", "due_soon", "blocked"}:
            continue
        severity = "critical" if item.sla_state == "breached" and item.escalation_level in {"admin", "owner"} else "high"
        if item.sla_state == "due_soon" and item.priority in {"medium", "low"}:
            severity = "medium"
        description = item.sla_label
        if item.assignee_label:
            description = f"{item.sla_label} · {item.assignee_label}"
        push(
            {
                "id": f"sla:{item.task_id}",
                "title": f"SLA tâche · {item.title}",
                "subtitle": f"{item.module_label} · {item.priority_label}",
                "description": description,
                "module": item.module,
                "severity": severity,
                "href": "/app/tasks",
                "source_kind": "sla_task",
                "source_ref": item.task_id,
                "created_at": item.target_at or item.created_at or now,
                "updated_at": now,
                "due_at": item.target_at,
            }
        )

    if not payments_enabled:
        # Scheduler supervision, campaign delivery and outbox are all Pro
        # payment operations. Returning here also prevents retained rows from
        # being re-persisted as notifications after a downgrade/suspension.
        return candidates[:40]

    recent_runs = sorted(
        (ops_base._scheduler_run_out(item) for item in ops_base._read_scheduler_runs(settings_row)),
        key=lambda row: row.started_at or datetime.min,
        reverse=True,
    )[:3]
    if not (purchases_enabled and payments_enabled):
        recent_runs = []
    for run in recent_runs:
        started_at = run.started_at or now
        if started_at < (now - timedelta(days=2)):
            continue
        if (run.created_tasks or 0) <= 0 and (run.updated_playbooks or 0) <= 0:
            continue
        severity = "medium" if (run.created_tasks or 0) > 0 else "low"
        subtitle = f"{run.updated_playbooks or 0} playbook(s) · {run.created_tasks or 0} tâche(s)"
        description = " ; ".join(run.notes[:2]) if run.notes else "Le batch opérateur a tourné et mérite un coup d'œil rapide."
        push(
            {
                "id": f"scheduler:{run.id}",
                "title": "Batch opérateur exécuté",
                "subtitle": subtitle,
                "description": description,
                "module": "tasks",
                "severity": severity,
                "href": "/app/tasks",
                "source_kind": "scheduler_run",
                "source_ref": run.id,
                "created_at": started_at,
                "updated_at": now,
                "due_at": started_at,
            }
        )

    from . import ops_scheduler as scheduler_base

    heartbeat = scheduler_base._heartbeat_payload(scheduler_base._read_heartbeat(settings_row), now=now)
    coordination_lock = scheduler_base._lock_payload(scheduler_base._read_lock(settings_row), now=now)
    if heartbeat.status in {"warn", "error"}:
        push(
            {
                "id": "scheduler:heartbeat-stale",
                "title": "Heartbeat scheduler à relancer",
                "subtitle": f"Dernier signal il y a {heartbeat.age_minutes or 0} minute(s)",
                "description": "Le moteur métier n’a pas envoyé de signal récent. Vérifie la supervision ou relance le centre de contrôle.",
                "module": "scheduler",
                "severity": "critical" if heartbeat.status == "error" else "high",
                "href": "/app/scheduler",
                "source_kind": "scheduler_heartbeat",
                "source_ref": "heartbeat",
                "created_at": heartbeat.last_seen_at or now,
                "updated_at": now,
                "due_at": now,
            }
        )
    if coordination_lock.active and coordination_lock.stale:
        push(
            {
                "id": "scheduler:lock-stale",
                "title": "Verrou scheduler bloqué",
                "subtitle": f"Run en cours depuis {coordination_lock.age_minutes or 0} minute(s)",
                "description": "La protection anti-concurrence a laissé un verrou actif au-delà de sa fenêtre normale. Un déverrouillage manuel est recommandé.",
                "module": "scheduler",
                "severity": "critical",
                "href": "/app/scheduler",
                "source_kind": "scheduler_lock",
                "source_ref": coordination_lock.run_id or "lock",
                "created_at": coordination_lock.locked_at or now,
                "updated_at": now,
                "due_at": now,
            }
        )
    elif coordination_lock.active:
        push(
            {
                "id": "scheduler:running",
                "title": "Run scheduler en cours",
                "subtitle": f"{len(coordination_lock.job_keys or [])} job(s) verrouillé(s)",
                "description": "La protection anti-concurrence empêche un second batch tant que ce run n’est pas libéré.",
                "module": "scheduler",
                "severity": "medium",
                "href": "/app/scheduler",
                "source_kind": "scheduler_lock",
                "source_ref": coordination_lock.run_id or "lock",
                "created_at": coordination_lock.locked_at or now,
                "updated_at": now,
                "due_at": coordination_lock.expires_at,
            }
        )

    from . import ops_supervision as supervision_base

    supervision_incidents = [
        supervision_base._incident_out(item)
        for item in supervision_base._read_incident_rows(settings_row)
    ]
    for incident in supervision_incidents[:6]:
        if incident.status != "open":
            continue
        if incident.acknowledged:
            continue
        if incident.snoozed_until and incident.snoozed_until > now:
            continue
        push(
            {
                "id": f"scheduler-incident:{incident.id}",
                "title": incident.title,
                "subtitle": f"Journal incidents · {incident.severity_label}",
                "description": incident.description,
                "module": "scheduler",
                "severity": "critical" if incident.severity == "critical" else "high" if incident.severity == "high" else "medium",
                "href": incident.href or "/app/scheduler",
                "source_kind": incident.source_kind or "scheduler_incident",
                "source_ref": incident.source_ref or incident.id,
                "created_at": incident.first_seen_at or now,
                "updated_at": incident.last_seen_at or now,
                "due_at": incident.last_seen_at or now,
            }
        )
    supervision_deliveries = [
        supervision_base._delivery_out(item)
        for item in supervision_base._read_delivery_rows(settings_row)
    ]
    for delivery in supervision_deliveries[:4]:
        if delivery.status != "error":
            continue
        push(
            {
                "id": f"scheduler-delivery:{delivery.id}",
                "title": f"Canal externe en échec · {delivery.channel_label}",
                "subtitle": f"{delivery.kind.capitalize()} · {delivery.event_kind}",
                "description": delivery.error or "Le dernier envoi externe du scheduler a échoué.",
                "module": "scheduler",
                "severity": "high",
                "href": "/app/scheduler",
                "source_kind": "scheduler_alert_channel",
                "source_ref": delivery.channel_id,
                "created_at": delivery.attempted_at or now,
                "updated_at": delivery.attempted_at or now,
                "due_at": delivery.attempted_at or now,
            }
        )

    from . import ops_outbox as outbox_base

    outbox = outbox_base._board_payload(db, user, settings_row=settings_row, now=now)
    if outbox.summary.ready_count > 0:
        delivery_mode_label = outbox.delivery.delivery_mode_label or "delivery"
        push(
            {
                "id": "outbox:ready",
                "title": "Outbox prêt à diffuser",
                "subtitle": f"{outbox.summary.ready_count} ligne(s) prêtes · {delivery_mode_label}",
                "description": "Valide la diffusion ou laisse le pipeline traiter automatiquement les lignes déjà dues.",
                "module": "campaigns",
                "severity": "high" if outbox.delivery.smtp_ready else "medium",
                "href": "/app/outbox",
                "source_kind": "campaign_outbox",
                "source_ref": "ready",
                "created_at": now,
                "updated_at": now,
                "due_at": now,
            }
        )
    if outbox.summary.blocked_count > 0:
        push(
            {
                "id": "outbox:blocked",
                "title": "Emails manquants dans l'outbox",
                "subtitle": f"{outbox.summary.blocked_count} ligne(s) bloquée(s)",
                "description": "Complète les emails client avant diffusion ou bascule en suivi opérateur.",
                "module": "campaigns",
                "severity": "medium",
                "href": "/app/outbox",
                "source_kind": "campaign_outbox",
                "source_ref": "blocked",
                "created_at": now,
                "updated_at": now,
                "due_at": now,
            }
        )
    if outbox.summary.failed_count > 0:
        push(
            {
                "id": "outbox:failed",
                "title": "Échecs de diffusion à corriger",
                "subtitle": f"{outbox.summary.failed_count} tentative(s) en échec",
                "description": "Vérifie l'outbox : certaines lignes sont repassées en blocage après une tentative de diffusion.",
                "module": "campaigns",
                "severity": "high",
                "href": "/app/outbox",
                "source_kind": "campaign_outbox",
                "source_ref": "failed",
                "created_at": now,
                "updated_at": now,
                "due_at": now,
            }
        )
    recent_dispatch = next((row for row in outbox.recent_dispatches if row.generated_at and row.generated_at >= (now - timedelta(days=2)) and ((row.sent_count or 0) > 0 or (row.failed_count or 0) > 0)), None)
    if recent_dispatch is not None:
        description = "Le dispatch a été journalisé dans l'outbox campagnes."
        if recent_dispatch.delivery_mode == "smtp":
            description = "Une diffusion SMTP récente mérite une vérification rapide des résultats."
        elif recent_dispatch.log_only_count:
            description = "Le dernier dispatch est resté en journal opérateur : aucun email réel n'a été envoyé."
        push(
            {
                "id": f"outbox-dispatch:{recent_dispatch.id}",
                "title": "Diffusion outbox exécutée",
                "subtitle": f"{recent_dispatch.sent_count} ligne(s) traitée(s) · {recent_dispatch.delivery_mode_label}",
                "description": description,
                "module": "campaigns",
                "severity": "medium" if (recent_dispatch.failed_count or 0) > 0 else "low",
                "href": "/app/outbox",
                "source_kind": "campaign_dispatch",
                "source_ref": recent_dispatch.id,
                "created_at": recent_dispatch.generated_at,
                "updated_at": now,
                "due_at": recent_dispatch.generated_at,
            }
        )

    return candidates[:40]



def _sync_notifications(
    db: Session,
    user: AuthUser,
    settings_row: TenantSettings | None,
    *,
    persist: bool = True,
    now: datetime | None = None,
) -> tuple[TenantSettings, list[OpsNotificationOut]]:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or _ensure_settings(db, user.tenant_id)
    existing = {
        str(item.get("id") or ""): ops_base._hydrate_dt_dict(item, _NOTIFICATION_DT_KEYS)
        for item in _read_notifications(settings_row)
        if str(item.get("id") or "").strip()
    }
    candidates = _build_notification_candidates(db, user, settings_row, now)
    merged: list[dict[str, Any]] = []
    for entry in candidates:
        current = existing.get(str(entry.get("id") or ""))
        if current:
            entry["created_at"] = current.get("created_at") or entry.get("created_at") or now
            entry["read_at"] = current.get("read_at")
            entry["read"] = bool(current.get("read") or current.get("read_at"))
        else:
            entry["created_at"] = entry.get("created_at") or now
            entry["read_at"] = None
            entry["read"] = False
        entry["updated_at"] = now
        merged.append(ops_base._serialize_dt_dict(entry, _NOTIFICATION_DT_KEYS))

    if persist:
        settings_row = _ensure_settings(db, user.tenant_id)
        settings_row = _write_settings(db, settings_row, notifications=merged)
        rows = _read_notifications(settings_row)
    else:
        rows = merged
    items = sorted((_notification_out(row) for row in rows), key=_notification_sort_key)
    return settings_row, items



def _notifications_payload(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    persist: bool = True,
    now: datetime | None = None,
) -> OpsNotificationsOut:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row, items = _sync_notifications(db, user, settings_row, persist=persist, now=now)
    summary = OpsNotificationsSummaryOut(total_count=len(items), modules={})
    for item in items:
        summary.modules[item.module] = summary.modules.get(item.module, 0) + 1
        if item.read:
            summary.read_count += 1
        else:
            summary.unread_count += 1
            if item.severity == "critical":
                summary.critical_unread_count += 1
            elif item.severity == "high":
                summary.high_unread_count += 1
        if item.due_at and item.due_at <= (now + timedelta(days=1)):
            summary.due_today_count += 1
    return OpsNotificationsOut(summary=summary, items=items, generated_at=now)


@router.get("/notifications", response_model=OpsNotificationsOut)
def notifications_feed(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    return _notifications_payload(db, user, settings_row=settings_row, persist=True)


@router.patch("/notifications/{notification_id}", response_model=OpsNotificationOut)
def update_notification(
    notification_id: str,
    payload: OpsNotificationPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    settings_row, _ = _sync_notifications(db, user, settings_row, persist=True)
    rows = _read_notifications(settings_row)
    found = False
    next_rows: list[dict[str, Any]] = []
    for row in rows:
        hydrated = ops_base._hydrate_dt_dict(row, _NOTIFICATION_DT_KEYS)
        if str(hydrated.get("id") or "") != notification_id:
            next_rows.append(row)
            continue
        found = True
        if payload.read is not None:
            hydrated["read"] = bool(payload.read)
            hydrated["read_at"] = datetime.now(timezone.utc).replace(tzinfo=None) if payload.read else None
        hydrated["updated_at"] = datetime.now(timezone.utc).replace(tzinfo=None)
        next_rows.append(ops_base._serialize_dt_dict(hydrated, _NOTIFICATION_DT_KEYS))
    if not found:
        raise HTTPException(404, "Notification introuvable.")
    settings_row = _write_settings(db, settings_row, notifications=next_rows)
    stored = next((row for row in _read_notifications(settings_row) if str(row.get("id") or "") == notification_id), None)
    if not stored:
        raise HTTPException(404, "Notification introuvable.")
    return _notification_out(stored)


@router.post("/notifications/mark-all-read", response_model=OpsNotificationsOut)
def mark_all_notifications_read(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    settings_row, items = _sync_notifications(db, user, settings_row, persist=True)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = []
    for row in _read_notifications(settings_row):
        hydrated = ops_base._hydrate_dt_dict(row, _NOTIFICATION_DT_KEYS)
        hydrated["read"] = True
        hydrated["read_at"] = now
        hydrated["updated_at"] = now
        rows.append(ops_base._serialize_dt_dict(hydrated, _NOTIFICATION_DT_KEYS))
    settings_row = _write_settings(db, settings_row, notifications=rows)
    return _notifications_payload(db, user, settings_row=settings_row, persist=False, now=now)


@router.get("/sla-dashboard", response_model=SlaDashboardOut)
def sla_dashboard(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    notifications = _notifications_payload(db, user, settings_row=settings_row, persist=True)
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    return _sla_dashboard_payload(db, user, settings_row=settings_row, notifications=notifications.items)


@router.patch("/sla-policy", response_model=SlaPolicyOut)
def update_sla_policy(
    payload: SlaPolicyPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_settings(db, user.tenant_id)
    policy = _read_sla_policy(settings_row)
    if payload.priority_hours is not None:
        next_priority = dict(policy.get("priority_hours") or {})
        for key, value in payload.priority_hours.items():
            normalized = str(key or "").strip().lower()
            if normalized not in _DEFAULT_SLA_PRIORITY_HOURS:
                continue
            try:
                next_priority[normalized] = max(1, min(int(value), 336))
            except Exception:
                continue
        policy["priority_hours"] = next_priority
    if payload.notify_before_hours is not None:
        policy["notify_before_hours"] = payload.notify_before_hours
    if payload.escalate_after_hours is not None:
        policy["escalate_after_hours"] = payload.escalate_after_hours
    policy = _normalize_sla_policy(policy)
    settings_row = _write_settings(db, settings_row, sla_policy=policy)
    return SlaPolicyOut(**policy)


@router.post("/sla/run", response_model=SlaDashboardOut)
def run_sla_refresh(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    notifications = _notifications_payload(db, user, settings_row=settings_row, persist=True)
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    return _sla_dashboard_payload(db, user, settings_row=settings_row, notifications=notifications.items)
