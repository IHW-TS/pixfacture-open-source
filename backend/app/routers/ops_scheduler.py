from __future__ import annotations

import copy
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import deps as deps_base
from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_product_capability, require_viewer_or_admin
from ..models import TenantSettings
from ..utils.public_errors import sanitize_public_error_message
from . import ops as ops_base

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/ops",
    tags=["ops"],
    dependencies=[Depends(require_product_capability("payments_enabled"))],
)

_ENGINE_CONFIG_STORE_KEY = "ops_scheduler_engine_config"
_ENGINE_RUN_STORE_KEY = "ops_scheduler_engine_runs"
_ENGINE_HEARTBEAT_STORE_KEY = "ops_scheduler_engine_heartbeat"
_ENGINE_LOCK_STORE_KEY = "ops_scheduler_engine_lock"
_ENGINE_RUN_DT_KEYS = {"started_at", "finished_at", "generated_at"}
_ENGINE_HEARTBEAT_DT_KEYS = {"last_seen_at", "generated_at"}
_ENGINE_LOCK_DT_KEYS = {"locked_at", "expires_at", "released_at", "generated_at"}
_DEFAULT_HEARTBEAT_STALE_AFTER_MINUTES = 15
_DEFAULT_LOCK_TTL_MINUTES = 20
_MAX_ENGINE_RUNS = 30

_JOB_SPECS: dict[str, dict[str, Any]] = {
    "playbooks": {
        "label": "Playbooks équipe",
        "module": "tasks",
        "module_label": "Playbooks",
        "description": "Cadence les routines opérateur et crée les tâches issues des playbooks.",
        "href": "/app/automations",
        "default_interval_minutes": 60,
    },
    "recurring": {
        "label": "Récurrence factures",
        "module": "recurring",
        "module_label": "Récurrence",
        "description": "Génère les brouillons de factures dus et surveille la charge des prochains cycles.",
        "href": "/app/recurring",
        "default_interval_minutes": 180,
    },
    "campaigns": {
        "label": "Campagnes portefeuille",
        "module": "campaigns",
        "module_label": "Campagnes",
        "description": "Exécute les campagnes dues, prépare les previews et alimente la file opérateur.",
        "href": "/app/campaigns",
        "default_interval_minutes": 180,
    },
    "outbox": {
        "label": "Outbox & delivery",
        "module": "campaigns",
        "module_label": "Outbox",
        "description": "Promeut les brouillons, déclenche les diffusions prêtes et suit les tentatives d'envoi.",
        "href": "/app/outbox",
        "default_interval_minutes": 60,
    },
    "sla": {
        "label": "Alertes SLA",
        "module": "tasks",
        "module_label": "SLA",
        "description": "Recalcule les risques, met à jour les escalades et nourrit les alertes persistantes.",
        "href": "/app/notifications",
        "default_interval_minutes": 120,
    },
    "digest": {
        "label": "Digest & auto-tâches",
        "module": "setup",
        "module_label": "Digest",
        "description": "Prépare le digest opérateur, applique les règles matchées et pousse les auto-tâches utiles.",
        "href": "/app/notifications",
        "default_interval_minutes": 240,
    },
}
_ALLOWED_JOB_KEYS = set(_JOB_SPECS.keys())
_STATUS_META = {
    "ok": ("Sain", "ok"),
    "warn": ("À surveiller", "warn"),
    "error": ("Erreur", "danger"),
    "paused": ("En pause", "muted"),
    "running": ("En cours", "info"),
    "idle": ("Jamais exécuté", "info"),
}


class SchedulerQueueSnapshotOut(BaseModel):
    playbooks_due_count: int = 0
    recurring_due_count: int = 0
    campaigns_due_count: int = 0
    outbox_ready_due_count: int = 0
    outbox_blocked_count: int = 0
    outbox_failed_count: int = 0
    notifications_unread_count: int = 0
    critical_unread_count: int = 0
    sla_breached_count: int = 0
    digest_urgent_count: int = 0


class SchedulerControlSummaryOut(BaseModel):
    total_jobs: int = 0
    active_jobs: int = 0
    paused_jobs: int = 0
    due_jobs: int = 0
    stale_jobs: int = 0
    queue_pressure: int = 0
    recent_runs_count: int = 0
    warnings_count: int = 0
    healthy_jobs: int = 0
    warning_jobs: int = 0
    error_jobs: int = 0
    heartbeat_stale: bool = False
    lock_active: bool = False
    lock_stale: bool = False


class SchedulerHeartbeatOut(BaseModel):
    status: str = "idle"
    status_label: str = "Aucun heartbeat"
    tone: str = "info"
    source: str = "console"
    runner_label: str | None = None
    note: str | None = None
    last_seen_at: datetime | None = None
    stale_after_minutes: int = _DEFAULT_HEARTBEAT_STALE_AFTER_MINUTES
    age_minutes: int | None = None


class SchedulerLockOut(BaseModel):
    active: bool = False
    stale: bool = False
    status: str = "ok"
    status_label: str = "Libre"
    tone: str = "ok"
    run_id: str | None = None
    trigger: str | None = None
    runner_label: str | None = None
    job_keys: list[str] = Field(default_factory=list)
    locked_at: datetime | None = None
    expires_at: datetime | None = None
    released_at: datetime | None = None
    age_minutes: int | None = None
    ttl_minutes: int | None = None
    notes: list[str] = Field(default_factory=list)


class SchedulerSupervisionRunsOut(BaseModel):
    total_count: int = 0
    ok_count: int = 0
    warn_count: int = 0
    error_count: int = 0
    running_count: int = 0
    success_rate: int = 0
    average_duration_seconds: int = 0
    last_success_at: datetime | None = None
    last_error_at: datetime | None = None


class SchedulerSupervisionOut(BaseModel):
    heartbeat: SchedulerHeartbeatOut = Field(default_factory=SchedulerHeartbeatOut)
    lock: SchedulerLockOut = Field(default_factory=SchedulerLockOut)
    runs: SchedulerSupervisionRunsOut = Field(default_factory=SchedulerSupervisionRunsOut)
    incidents: list[str] = Field(default_factory=list)


class SchedulerEngineJobOut(BaseModel):
    key: str
    label: str
    description: str
    module: str
    module_label: str
    href: str
    active: bool = True
    interval_minutes: int = 60
    due_now: bool = False
    stale: bool = False
    due_count: int = 0
    backlog_count: int = 0
    blocked_count: int = 0
    last_run_at: datetime | None = None
    next_run_at: datetime | None = None
    last_status: str = "idle"
    last_status_label: str = "Jamais exécuté"
    tone: str = "info"
    notes: list[str] = Field(default_factory=list)


class SchedulerEngineRunJobOut(BaseModel):
    key: str
    label: str
    status: str = "ok"
    status_label: str = "Sain"
    tone: str = "ok"
    processed_count: int = 0
    created_count: int = 0
    blocked_count: int = 0
    notes: list[str] = Field(default_factory=list)


class SchedulerEngineRunOut(BaseModel):
    id: str
    trigger: str = "manual"
    status: str = "ok"
    status_label: str = "Sain"
    tone: str = "ok"
    job_keys: list[str] = Field(default_factory=list)
    jobs: list[SchedulerEngineRunJobOut] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    generated_at: datetime | None = None


class SchedulerControlOut(BaseModel):
    summary: SchedulerControlSummaryOut = Field(default_factory=SchedulerControlSummaryOut)
    queues: SchedulerQueueSnapshotOut = Field(default_factory=SchedulerQueueSnapshotOut)
    supervision: SchedulerSupervisionOut = Field(default_factory=SchedulerSupervisionOut)
    jobs: list[SchedulerEngineJobOut] = Field(default_factory=list)
    recent_runs: list[SchedulerEngineRunOut] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    generated_at: datetime


class SchedulerJobPatchRequest(BaseModel):
    active: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=15, le=1440)


class SchedulerHeartbeatRequest(BaseModel):
    source: str = Field(default="console", min_length=3, max_length=32)
    runner_label: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=240)
    stale_after_minutes: int | None = Field(default=None, ge=5, le=240)


class SchedulerForceUnlockRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=240)


class SchedulerControlRunRequest(BaseModel):
    job_keys: list[str] = Field(default_factory=list)
    include_paused: bool = False
    force: bool = False
    trigger: str = Field(default="manual", min_length=3, max_length=32)
    runner_label: str | None = Field(default=None, max_length=120)


class SchedulerControlRunBatchOut(BaseModel):
    run: SchedulerEngineRunOut
    board: SchedulerControlOut


SchedulerControlOut.model_rebuild()


def _features(settings_row: TenantSettings | None) -> dict[str, Any]:
    return ops_base._features(settings_row)


def _normalize_interval(key: str, value: Any) -> int:
    default = int(_JOB_SPECS[key]["default_interval_minutes"])
    try:
        candidate = int(value or default)
    except Exception:
        candidate = default
    return max(15, min(candidate, 1440))


def _normalize_job_key(value: str | None) -> str:
    key = str(value or "").strip().lower()
    if key not in _ALLOWED_JOB_KEYS:
        raise HTTPException(400, "Job scheduler invalide.")
    return key


def _read_controls(settings_row: TenantSettings | None) -> dict[str, dict[str, Any]]:
    raw = _features(settings_row).get(_ENGINE_CONFIG_STORE_KEY)
    if not isinstance(raw, dict):
        raw = {}
    controls: dict[str, dict[str, Any]] = {}
    for key in _JOB_SPECS:
        raw_item = raw.get(key)
        item: dict[str, Any] = raw_item if isinstance(raw_item, dict) else {}
        controls[key] = {
            "active": bool(item.get("active", True)),
            "interval_minutes": _normalize_interval(key, item.get("interval_minutes")),
        }
    return controls


def _read_engine_runs(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_ENGINE_RUN_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [copy.deepcopy(item) for item in raw if isinstance(item, dict)]


def _read_heartbeat(settings_row: TenantSettings | None) -> dict[str, Any]:
    raw = _features(settings_row).get(_ENGINE_HEARTBEAT_STORE_KEY)
    return copy.deepcopy(raw) if isinstance(raw, dict) else {}


def _read_lock(settings_row: TenantSettings | None) -> dict[str, Any]:
    raw = _features(settings_row).get(_ENGINE_LOCK_STORE_KEY)
    return copy.deepcopy(raw) if isinstance(raw, dict) else {}


def _write_engine_features(
    db: Session,
    settings_row: TenantSettings,
    *,
    controls: dict[str, dict[str, Any]] | None = None,
    runs: list[dict[str, Any]] | None = None,
    heartbeat: dict[str, Any] | None = None,
    lock: dict[str, Any] | None = None,
) -> TenantSettings:
    features = _features(settings_row)
    if controls is not None:
        features[_ENGINE_CONFIG_STORE_KEY] = controls
    if runs is not None:
        features[_ENGINE_RUN_STORE_KEY] = runs[:_MAX_ENGINE_RUNS]
    if heartbeat is not None:
        features[_ENGINE_HEARTBEAT_STORE_KEY] = heartbeat
    if lock is not None:
        features[_ENGINE_LOCK_STORE_KEY] = lock
    settings_row.features = features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _sanitize_runner_label(value: Any, fallback: str = "Console pilotage") -> str:
    text = str(value or "").strip()
    return text[:120] if text else fallback


def _heartbeat_payload(payload: dict[str, Any] | None, *, now: datetime) -> SchedulerHeartbeatOut:
    row = ops_base._hydrate_dt_dict(payload or {}, _ENGINE_HEARTBEAT_DT_KEYS)
    source = str(row.get("source") or "console").strip().lower() or "console"
    runner_label = str(row.get("runner_label") or "").strip() or None
    note = str(row.get("note") or "").strip() or None
    last_seen_at = ops_base._as_dt(row.get("last_seen_at"))
    try:
        stale_after_minutes = int(row.get("stale_after_minutes") or _DEFAULT_HEARTBEAT_STALE_AFTER_MINUTES)
    except Exception:
        stale_after_minutes = _DEFAULT_HEARTBEAT_STALE_AFTER_MINUTES
    stale_after_minutes = max(5, min(stale_after_minutes, 240))
    age_minutes = None
    if last_seen_at is not None:
        age_minutes = max(0, int((now - last_seen_at).total_seconds() // 60))
    if last_seen_at is None:
        status, status_label, tone = "idle", "Aucun heartbeat", "info"
    elif age_minutes is not None and age_minutes <= stale_after_minutes:
        status, status_label, tone = "ok", "Runner joignable", "ok"
    elif age_minutes is not None and age_minutes <= stale_after_minutes * 2:
        status, status_label, tone = "warn", "Heartbeat ancien", "warn"
    else:
        status, status_label, tone = "error", "Heartbeat manquant", "danger"
    return SchedulerHeartbeatOut(
        status=status,
        status_label=status_label,
        tone=tone,
        source=source,
        runner_label=runner_label,
        note=note,
        last_seen_at=last_seen_at,
        stale_after_minutes=stale_after_minutes,
        age_minutes=age_minutes,
    )


def _lock_payload(payload: dict[str, Any] | None, *, now: datetime) -> SchedulerLockOut:
    row = ops_base._hydrate_dt_dict(payload or {}, _ENGINE_LOCK_DT_KEYS)
    active = bool(row.get("active"))
    locked_at = ops_base._as_dt(row.get("locked_at"))
    expires_at = ops_base._as_dt(row.get("expires_at"))
    released_at = ops_base._as_dt(row.get("released_at"))
    age_minutes = None
    ttl_minutes = None
    if locked_at is not None:
        age_minutes = max(0, int((now - locked_at).total_seconds() // 60))
    if locked_at is not None and expires_at is not None and expires_at >= locked_at:
        ttl_minutes = max(1, int((expires_at - locked_at).total_seconds() // 60))
    stale = bool(active and expires_at and expires_at <= now)
    notes = [str(item).strip() for item in row.get("notes") or [] if str(item).strip()]
    if active and stale:
        status, status_label, tone = "error", "Verrou bloqué", "danger"
    elif active:
        status, status_label, tone = "running", "Run en cours", "info"
    elif locked_at or released_at:
        status, status_label, tone = "ok", "Libre", "ok"
    else:
        status, status_label, tone = "ok", "Libre", "ok"
    return SchedulerLockOut(
        active=active,
        stale=stale,
        status=status,
        status_label=status_label,
        tone=tone,
        run_id=(str(row.get("run_id") or "").strip() or None),
        trigger=(str(row.get("trigger") or "").strip() or None),
        runner_label=(str(row.get("runner_label") or "").strip() or None),
        job_keys=[str(item).strip() for item in row.get("job_keys") or [] if str(item).strip()],
        locked_at=locked_at,
        expires_at=expires_at,
        released_at=released_at,
        age_minutes=age_minutes,
        ttl_minutes=ttl_minutes,
        notes=notes[:6],
    )


def _supervision_runs_payload(runs: list[SchedulerEngineRunOut], *, now: datetime) -> SchedulerSupervisionRunsOut:
    window_start = now - timedelta(days=7)
    scoped = [
        item
        for item in runs
        if (item.finished_at or item.generated_at or item.started_at or datetime.min) >= window_start
    ]
    ok_count = sum(1 for item in scoped if item.status == "ok")
    warn_count = sum(1 for item in scoped if item.status == "warn")
    error_count = sum(1 for item in scoped if item.status == "error")
    running_count = sum(1 for item in scoped if item.status == "running")
    durations = [
        int((item.finished_at - item.started_at).total_seconds())
        for item in scoped
        if item.started_at and item.finished_at and item.finished_at >= item.started_at
    ]
    total_count = len(scoped)
    success_rate = int(round((ok_count / total_count) * 100)) if total_count else 100
    last_success_at = next((item.finished_at or item.generated_at or item.started_at for item in scoped if item.status == "ok"), None)
    last_error_at = next((item.finished_at or item.generated_at or item.started_at for item in scoped if item.status == "error"), None)
    return SchedulerSupervisionRunsOut(
        total_count=total_count,
        ok_count=ok_count,
        warn_count=warn_count,
        error_count=error_count,
        running_count=running_count,
        success_rate=success_rate,
        average_duration_seconds=int(sum(durations) / len(durations)) if durations else 0,
        last_success_at=last_success_at,
        last_error_at=last_error_at,
    )


def _serialize_heartbeat(value: dict[str, Any]) -> dict[str, Any]:
    return ops_base._serialize_dt_dict(value, _ENGINE_HEARTBEAT_DT_KEYS)


def _serialize_lock(value: dict[str, Any]) -> dict[str, Any]:
    return ops_base._serialize_dt_dict(value, _ENGINE_LOCK_DT_KEYS)


def _heartbeat_entry(*, now: datetime, source: str = "console", runner_label: str | None = None, note: str | None = None, stale_after_minutes: int | None = None) -> dict[str, Any]:
    return {
        "source": str(source or "console").strip().lower() or "console",
        "runner_label": _sanitize_runner_label(runner_label),
        "note": (str(note or "").strip() or None),
        "last_seen_at": now,
        "generated_at": now,
        "stale_after_minutes": max(5, min(int(stale_after_minutes or _DEFAULT_HEARTBEAT_STALE_AFTER_MINUTES), 240)),
    }


def _lock_ttl_minutes(job_keys: list[str]) -> int:
    return max(_DEFAULT_LOCK_TTL_MINUTES, min(120, 10 + (max(1, len(job_keys)) * 5)))


def _acquire_lock(
    db: Session,
    settings_row: TenantSettings,
    *,
    now: datetime,
    job_keys: list[str],
    trigger: str,
    runner_label: str | None,
    force: bool,
) -> tuple[TenantSettings, dict[str, Any], SchedulerLockOut | None]:
    current_raw = _read_lock(settings_row)
    current = _lock_payload(current_raw, now=now) if current_raw else None
    if current and current.active and not current.stale and not force:
        age = f" depuis {current.age_minutes} min" if current.age_minutes is not None else ""
        raise HTTPException(409, f"Un run scheduler est déjà en cours{age}.")
    ttl_minutes = _lock_ttl_minutes(job_keys)
    lock_entry = {
        "run_id": str(uuid.uuid4()),
        "trigger": str(trigger or "manual").strip().lower() or "manual",
        "runner_label": _sanitize_runner_label(runner_label),
        "job_keys": job_keys,
        "active": True,
        "locked_at": now,
        "expires_at": now + timedelta(minutes=ttl_minutes),
        "released_at": None,
        "generated_at": now,
        "notes": (["Verrou précédent forcé depuis le centre de contrôle."] if current and current.active and force else []),
    }
    settings_row = _write_engine_features(db, settings_row, lock=_serialize_lock(lock_entry))
    return settings_row, lock_entry, current


def _release_lock(
    db: Session,
    settings_row: TenantSettings,
    *,
    now: datetime,
    lock_entry: dict[str, Any] | None,
    note: str | None = None,
) -> TenantSettings:
    raw = copy.deepcopy(lock_entry or _read_lock(settings_row) or {})
    if not raw:
        return settings_row
    notes = [str(item).strip() for item in raw.get("notes") or [] if str(item).strip()]
    if note:
        notes.insert(0, str(note).strip())
    raw.update({
        "active": False,
        "released_at": now,
        "generated_at": now,
        "notes": notes[:6],
    })
    return _write_engine_features(db, settings_row, lock=_serialize_lock(raw))


def _status_payload(status: str | None) -> tuple[str, str, str]:
    key = str(status or "idle").strip().lower()
    if key not in _STATUS_META:
        key = "idle"
    label, tone = _STATUS_META[key]
    return key, label, tone


def _engine_run_job_out(payload: dict[str, Any]) -> SchedulerEngineRunJobOut:
    row = ops_base._hydrate_dt_dict(payload, set())
    status, status_label, tone = _status_payload(str(row.get("status") or "idle"))
    raw_notes = row.get("notes")
    notes: list[Any] = raw_notes if isinstance(raw_notes, list) else []
    return SchedulerEngineRunJobOut(
        key=str(row.get("key") or "job"),
        label=str(row.get("label") or "Job"),
        status=status,
        status_label=status_label,
        tone=tone,
        processed_count=int(row.get("processed_count") or 0),
        created_count=int(row.get("created_count") or 0),
        blocked_count=int(row.get("blocked_count") or 0),
        notes=[str(item).strip() for item in notes if str(item).strip()][:6],
    )


def _engine_run_out(payload: dict[str, Any]) -> SchedulerEngineRunOut:
    row = ops_base._hydrate_dt_dict(payload, _ENGINE_RUN_DT_KEYS)
    status, status_label, tone = _status_payload(str(row.get("status") or "idle"))
    raw_notes = row.get("notes")
    notes: list[Any] = raw_notes if isinstance(raw_notes, list) else []
    raw_jobs = row.get("jobs")
    jobs: list[Any] = raw_jobs if isinstance(raw_jobs, list) else []
    raw_job_keys = row.get("job_keys")
    job_keys: list[Any] = raw_job_keys if isinstance(raw_job_keys, list) else []
    return SchedulerEngineRunOut(
        id=str(row.get("id") or f"ser_{uuid.uuid4().hex[:10]}"),
        trigger=str(row.get("trigger") or "manual"),
        status=status,
        status_label=status_label,
        tone=tone,
        job_keys=[str(item).strip() for item in job_keys if str(item).strip()],
        jobs=[_engine_run_job_out(item) for item in jobs if isinstance(item, dict)],
        notes=[str(item).strip() for item in notes if str(item).strip()][:8],
        started_at=ops_base._as_dt(row.get("started_at")),
        finished_at=ops_base._as_dt(row.get("finished_at")),
        generated_at=ops_base._as_dt(row.get("generated_at")),
    )


def _latest_engine_job_run(runs: list[SchedulerEngineRunOut], key: str) -> SchedulerEngineRunJobOut | None:
    for run in runs:
        for job in run.jobs:
            if job.key == key:
                return job
    return None


def _latest_engine_run_at(runs: list[SchedulerEngineRunOut], key: str) -> datetime | None:
    for run in runs:
        if key in run.job_keys:
            return run.finished_at or run.generated_at or run.started_at
    return None


def _job_out(
    key: str,
    *,
    controls: dict[str, dict[str, Any]],
    due_count: int = 0,
    backlog_count: int = 0,
    blocked_count: int = 0,
    last_run_at: datetime | None = None,
    last_status: str = "idle",
    notes: list[str] | None = None,
    now: datetime,
) -> SchedulerEngineJobOut:
    spec = _JOB_SPECS[key]
    control = controls[key]
    active = bool(control.get("active", True))
    interval_minutes = _normalize_interval(key, control.get("interval_minutes"))
    next_run_at = None if not active else ((last_run_at + timedelta(minutes=interval_minutes)) if last_run_at else now)
    scheduled_due = bool(active and next_run_at and next_run_at <= now)
    due_now = bool(due_count > 0 or scheduled_due)
    stale = bool(active and due_now and last_run_at and last_run_at <= (now - timedelta(minutes=max(interval_minutes * 2, interval_minutes + 15))))

    if not active:
        status = "paused"
    elif last_status == "error" or blocked_count > 0 and key == "outbox":
        status = "error" if blocked_count > 0 and key == "outbox" else "warn"
    elif stale:
        status = "warn"
    elif due_now or blocked_count > 0:
        status = "warn"
    elif last_run_at is None:
        status = "idle"
    else:
        status = "ok"
    status, status_label, tone = _status_payload(status)
    cleaned_notes = [str(item).strip() for item in (notes or []) if str(item).strip()]
    if stale:
        cleaned_notes.insert(0, "Cadence dépassée : ce job doit être relancé.")
    return SchedulerEngineJobOut(
        key=key,
        label=str(spec["label"]),
        description=str(spec["description"]),
        module=str(spec["module"]),
        module_label=str(spec["module_label"]),
        href=str(spec["href"]),
        active=active,
        interval_minutes=interval_minutes,
        due_now=due_now,
        stale=stale,
        due_count=max(0, int(due_count or 0)),
        backlog_count=max(0, int(backlog_count or 0)),
        blocked_count=max(0, int(blocked_count or 0)),
        last_run_at=last_run_at,
        next_run_at=next_run_at,
        last_status=status,
        last_status_label=status_label,
        tone=tone,
        notes=cleaned_notes[:4],
    )


def _control_payload(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
) -> tuple[TenantSettings, SchedulerControlOut]:
    from . import recurring as recurring_base
    from . import ops_alerts as alerts_base
    from . import ops_campaigns as campaigns_base
    from . import ops_comms as comms_base
    from . import ops_outbox as outbox_base

    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    controls = _read_controls(settings_row)
    engine_runs = sorted((_engine_run_out(item) for item in _read_engine_runs(settings_row)), key=lambda item: item.finished_at or item.generated_at or item.started_at or datetime.min, reverse=True)[:10]

    team_lookup = ops_base._team_lookup(db, user)
    purchases_enabled, payments_enabled = ops_base._ops_feature_access(db, user)
    if not (purchases_enabled and payments_enabled):
        # A historical playbook engine run may contain restricted module
        # names in its notes, without per-note entitlement metadata.
        engine_runs = [run for run in engine_runs if "playbooks" not in run.job_keys]
    task_rows = ops_base._filter_entitled_rows(
        ops_base._read_tasks(settings_row),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    tasks = [ops_base._task_out(item, team_lookup) for item in task_rows]
    scheduler_preview = ops_base._scheduler_preview_payload(
        settings_row,
        tasks,
        now,
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )

    recurring_profiles = [recurring_base._hydrate_profile(item) for item in recurring_base._read_profiles(settings_row)]
    recurring_runs = [recurring_base._run_out(item) for item in recurring_base._read_runs(settings_row)]
    recurring_last_run = recurring_runs[0] if recurring_runs else None
    recurring_due_count = sum(
        1
        for item in recurring_profiles
        if bool(item.get("active", True)) and (recurring_base._as_dt(item.get("next_run_at")) or datetime.max) <= now
    )
    recurring_next_count = sum(
        1
        for item in recurring_profiles
        if bool(item.get("active", True)) and now < (recurring_base._as_dt(item.get("next_run_at")) or datetime.max) <= (now + timedelta(days=7))
    )
    recurring_error_count = sum(1 for item in recurring_profiles if str(item.get("last_run_status") or "").lower() in {"error", "failed"})

    settings_row, campaign_workbench = campaigns_base._workbench_payload(db, user, settings_row=settings_row, now=now)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    campaign_last_run = campaign_workbench.recent_runs[0] if campaign_workbench.recent_runs else None
    campaign_missing_email_count = sum(int(item.missing_email_count or 0) for item in campaign_workbench.campaigns if item.due_now)

    outbox_board = outbox_base._board_payload(db, user, settings_row=settings_row, now=now)
    outbox_last_run_at = None
    if outbox_board.scheduler_runs:
        outbox_last_run_at = outbox_board.scheduler_runs[0].generated_at
    elif outbox_board.recent_dispatches:
        outbox_last_run_at = outbox_board.recent_dispatches[0].generated_at

    notifications = alerts_base._notifications_payload(db, user, settings_row=settings_row, persist=True, now=now)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    sla_dashboard = alerts_base._sla_dashboard_payload(db, user, settings_row=settings_row, notifications=notifications.items, now=now)
    settings_row, digest_payload, _ = comms_base._digest_payload(db, user, settings_row=settings_row, now=now)
    digest_last_run = digest_payload.recent_runs[0] if digest_payload.recent_runs else None

    queues = SchedulerQueueSnapshotOut(
        playbooks_due_count=int(scheduler_preview.summary.due_playbooks_count or 0),
        recurring_due_count=int(recurring_due_count),
        campaigns_due_count=int(campaign_workbench.summary.due_count or 0),
        outbox_ready_due_count=int(outbox_board.summary.due_ready_count or 0),
        outbox_blocked_count=int(outbox_board.summary.blocked_count or 0),
        outbox_failed_count=int(outbox_board.summary.failed_count or 0),
        notifications_unread_count=int(notifications.summary.unread_count or 0),
        critical_unread_count=int(notifications.summary.critical_unread_count or 0),
        sla_breached_count=int(sla_dashboard.summary.breached_count or 0),
        digest_urgent_count=int(digest_payload.summary.urgent_count or 0),
    )

    latest_playbooks_run = _latest_engine_job_run(engine_runs, "playbooks")
    latest_recurring_run = _latest_engine_job_run(engine_runs, "recurring")
    latest_campaigns_run = _latest_engine_job_run(engine_runs, "campaigns")
    latest_outbox_run = _latest_engine_job_run(engine_runs, "outbox")
    latest_sla_run = _latest_engine_job_run(engine_runs, "sla")
    latest_digest_run = _latest_engine_job_run(engine_runs, "digest")

    jobs = [
        _job_out(
            "playbooks",
            controls=controls,
            due_count=int(scheduler_preview.summary.due_playbooks_count or 0),
            backlog_count=int(scheduler_preview.summary.open_tasks_count or 0),
            blocked_count=int(scheduler_preview.summary.blocked_tasks_count or 0),
            last_run_at=(scheduler_preview.recent_runs[0].finished_at or scheduler_preview.recent_runs[0].started_at) if scheduler_preview.recent_runs else _latest_engine_run_at(engine_runs, "playbooks"),
            last_status=(scheduler_preview.recent_runs[0].status if scheduler_preview.recent_runs else (latest_playbooks_run.status if latest_playbooks_run else "idle")),
            notes=[
                f"{int(scheduler_preview.summary.manual_playbooks_count or 0)} playbook(s) manuel(s) restent pilotés à la main.",
                f"{int(scheduler_preview.summary.overdue_tasks_count or 0)} tâche(s) en retard déjà ouvertes.",
            ] + ([scheduler_preview.recent_runs[0].notes[0]] if scheduler_preview.recent_runs and scheduler_preview.recent_runs[0].notes else []),
            now=now,
        ),
        _job_out(
            "recurring",
            controls=controls,
            due_count=recurring_due_count,
            backlog_count=recurring_next_count,
            blocked_count=recurring_error_count,
            last_run_at=(recurring_last_run.finished_at or recurring_last_run.started_at) if recurring_last_run else _latest_engine_run_at(engine_runs, "recurring"),
            last_status=("warn" if recurring_last_run and int(recurring_last_run.error_count or 0) > 0 else "ok") if recurring_last_run else (latest_recurring_run.status if latest_recurring_run else "idle"),
            notes=[
                f"{sum(1 for item in recurring_profiles if bool(item.get('active', True)))} plan(s) actif(s) surveillés.",
                f"{recurring_next_count} génération(s) prévues dans les 7 prochains jours.",
            ],
            now=now,
        ),
        _job_out(
            "campaigns",
            controls=controls,
            due_count=int(campaign_workbench.summary.due_count or 0),
            backlog_count=int(campaign_workbench.summary.active_count or 0),
            blocked_count=campaign_missing_email_count,
            last_run_at=(campaign_last_run.finished_at or campaign_last_run.started_at) if campaign_last_run else _latest_engine_run_at(engine_runs, "campaigns"),
            last_status=("warn" if campaign_last_run and campaign_last_run.status != "done" else "ok") if campaign_last_run else (latest_campaigns_run.status if latest_campaigns_run else "idle"),
            notes=[
                f"{int(campaign_workbench.summary.templates_active_count or 0)} template(s) active(s).",
                f"{campaign_missing_email_count} destinataire(s) de campagnes dues sans email exploitable.",
            ],
            now=now,
        ),
        _job_out(
            "outbox",
            controls=controls,
            due_count=int(outbox_board.summary.due_ready_count or 0),
            backlog_count=int(outbox_board.summary.pending_count or 0),
            blocked_count=int(outbox_board.summary.blocked_count or 0) + int(outbox_board.summary.failed_count or 0),
            last_run_at=outbox_last_run_at or _latest_engine_run_at(engine_runs, "outbox"),
            last_status=("error" if int(outbox_board.summary.failed_count or 0) > 0 else "warn" if int(outbox_board.summary.blocked_count or 0) > 0 else "ok") if outbox_last_run_at else (latest_outbox_run.status if latest_outbox_run else "idle"),
            notes=list(outbox_board.delivery.warnings or [])[:2] + [f"{int(outbox_board.summary.sent_smtp_count or 0)} SMTP · {int(outbox_board.summary.sent_log_only_count or 0)} log-only."],
            now=now,
        ),
        _job_out(
            "sla",
            controls=controls,
            due_count=int(sla_dashboard.summary.due_next_24h_count or 0),
            backlog_count=int(sla_dashboard.summary.tasks_considered or 0),
            blocked_count=int(sla_dashboard.summary.breached_count or 0),
            last_run_at=_latest_engine_run_at(engine_runs, "sla"),
            last_status=("warn" if int(sla_dashboard.summary.breached_count or 0) > 0 else "ok") if (sla_dashboard.summary.tasks_considered or 0) > 0 else (latest_sla_run.status if latest_sla_run else "idle"),
            notes=[
                f"{int(sla_dashboard.summary.escalated_count or 0)} escalade(s) actives.",
                f"{int(sla_dashboard.summary.blocked_count or 0)} tâche(s) bloquée(s) dans le radar SLA.",
            ],
            now=now,
        ),
        _job_out(
            "digest",
            controls=controls,
            due_count=int(digest_payload.summary.urgent_count or 0),
            backlog_count=int(digest_payload.summary.matched_items_count or 0),
            blocked_count=0,
            last_run_at=(digest_last_run.generated_at if digest_last_run else _latest_engine_run_at(engine_runs, "digest")),
            last_status=("warn" if int(digest_payload.summary.urgent_count or 0) > 0 else "ok") if digest_payload.sections else (latest_digest_run.status if latest_digest_run else "idle"),
            notes=[
                digest_payload.headline,
                f"{int(digest_payload.summary.matched_rules_count or 0)} règle(s) matchée(s) · {int(digest_payload.summary.recent_auto_tasks_created or 0)} auto-tâche(s) récente(s).",
            ],
            now=now,
        ),
    ]

    heartbeat = _heartbeat_payload(_read_heartbeat(settings_row), now=now)
    coordination_lock = _lock_payload(_read_lock(settings_row), now=now)
    runs_supervision = _supervision_runs_payload(engine_runs, now=now)

    incidents: list[str] = []
    if heartbeat.status == "idle":
        incidents.append("Aucun heartbeat scheduler n’a encore été envoyé depuis le centre de contrôle ou un runner externe.")
    elif heartbeat.status in {"warn", "error"}:
        incidents.append(f"Le heartbeat scheduler date de {heartbeat.age_minutes or 0} minute(s) : la supervision doit être relancée.")
    if coordination_lock.active and coordination_lock.stale:
        incidents.append("Un verrou scheduler est resté actif au-delà de sa fenêtre de sécurité : un déverrouillage manuel est conseillé.")
    elif coordination_lock.active:
        incidents.append("Un run scheduler est actuellement en cours : les relances concurrentes sont bloquées.")
    if runs_supervision.error_count > 0:
        incidents.append(f"{runs_supervision.error_count} run(s) orchestrés ont fini en erreur sur les 7 derniers jours.")
    if runs_supervision.success_rate < 80:
        incidents.append(f"Le taux de réussite du scheduler est tombé à {runs_supervision.success_rate}% sur les 7 derniers jours.")

    supervision = SchedulerSupervisionOut(
        heartbeat=heartbeat,
        lock=coordination_lock,
        runs=runs_supervision,
        incidents=incidents[:8],
    )

    warnings: list[str] = []
    paused_due = [job.label for job in jobs if (not job.active) and (job.due_count > 0 or job.blocked_count > 0)]
    if paused_due:
        warnings.append(f"Job(s) en pause avec du travail en attente : {', '.join(paused_due[:3])}.")
    if queues.outbox_failed_count > 0:
        warnings.append(f"{queues.outbox_failed_count} tentative(s) de delivery ont échoué récemment.")
    if queues.critical_unread_count > 0:
        warnings.append(f"{queues.critical_unread_count} notification(s) critiques restent non lues.")
    if queues.sla_breached_count > 0:
        warnings.append(f"{queues.sla_breached_count} tâche(s) ont déjà dépassé leur SLA.")
    if queues.playbooks_due_count + queues.recurring_due_count + queues.campaigns_due_count >= 5:
        warnings.append("Le volume de jobs dus augmente : pense à relancer le scheduler métier.")
    if heartbeat.status == "idle":
        warnings.append("Aucun heartbeat scheduler enregistré pour l’instant.")
    elif heartbeat.status in {"warn", "error"}:
        warnings.append(f"Heartbeat ancien : dernier signal il y a {heartbeat.age_minutes or 0} minute(s).")
    if coordination_lock.active and coordination_lock.stale:
        warnings.append("Le verrou scheduler est bloqué : déverrouillage manuel recommandé avant un nouveau batch.")
    elif coordination_lock.active:
        warnings.append("Un run scheduler est en cours : la protection anti-concurrence est active.")
    if runs_supervision.error_count > 0:
        warnings.append(f"{runs_supervision.error_count} run(s) orchestrés en erreur sur les 7 derniers jours.")
    for item in outbox_board.delivery.warnings[:2]:
        if item not in warnings:
            warnings.append(item)

    summary = SchedulerControlSummaryOut(
        total_jobs=len(jobs),
        active_jobs=sum(1 for item in jobs if item.active),
        paused_jobs=sum(1 for item in jobs if not item.active),
        due_jobs=sum(1 for item in jobs if item.due_now),
        stale_jobs=sum(1 for item in jobs if item.stale),
        queue_pressure=int(
            queues.playbooks_due_count
            + queues.recurring_due_count
            + queues.campaigns_due_count
            + queues.outbox_ready_due_count
            + queues.outbox_blocked_count
            + queues.outbox_failed_count
            + queues.sla_breached_count
            + queues.digest_urgent_count
        ),
        recent_runs_count=len(engine_runs),
        warnings_count=len(warnings),
        healthy_jobs=sum(1 for item in jobs if item.last_status == "ok"),
        warning_jobs=sum(1 for item in jobs if item.last_status == "warn"),
        error_jobs=sum(1 for item in jobs if item.last_status == "error"),
        heartbeat_stale=heartbeat.status in {"warn", "error"},
        lock_active=coordination_lock.active,
        lock_stale=coordination_lock.stale,
    )
    return settings_row, SchedulerControlOut(
        summary=summary,
        queues=queues,
        supervision=supervision,
        jobs=jobs,
        recent_runs=engine_runs,
        warnings=warnings[:8],
        generated_at=now,
    )


def _run_playbooks_job(db: Session, user: AuthUser) -> SchedulerEngineRunJobOut:
    preview = ops_base.scheduler_run(db=db, user=user)
    latest = preview.recent_runs[0] if preview.recent_runs else None
    status = latest.status if latest else ("warn" if int(preview.summary.due_playbooks_count or 0) > 0 else "ok")
    status, status_label, tone = _status_payload(status)
    notes = latest.notes[:4] if latest else []
    return SchedulerEngineRunJobOut(
        key="playbooks",
        label=str(_JOB_SPECS["playbooks"]["label"]),
        status=status,
        status_label=status_label,
        tone=tone,
        processed_count=int(latest.updated_playbooks or 0) if latest else 0,
        created_count=int(latest.created_tasks or 0) if latest else 0,
        blocked_count=int(preview.summary.blocked_tasks_count or 0),
        notes=notes or [f"{int(preview.summary.due_playbooks_count or 0)} playbook(s) restent dus après ce run."],
    )


def _run_recurring_job(db: Session, user: AuthUser) -> SchedulerEngineRunJobOut:
    from . import recurring as recurring_base

    deps_base.require_paid_subscription_or_trial(user=user, db=db)
    result = recurring_base.run_due_profiles(payload=recurring_base.RecurringRunDueRequest(limit=20), db=db, user=user, _=user)
    run = result.run
    status = "warn" if int(run.error_count or 0) > 0 else "ok"
    status, status_label, tone = _status_payload(status)
    notes = []
    if int(run.generated_count or 0) > 0:
        notes.append(f"{int(run.generated_count or 0)} brouillon(s) généré(s) automatiquement.")
    if int(run.skipped_count or 0) > 0:
        notes.append(f"{int(run.skipped_count or 0)} profil(s) dus ont été laissés pour plus tard.")
    for item in run.items[:2]:
        if item.message:
            notes.append(str(item.message))
    return SchedulerEngineRunJobOut(
        key="recurring",
        label=str(_JOB_SPECS["recurring"]["label"]),
        status=status,
        status_label=status_label,
        tone=tone,
        processed_count=int(run.processed_count or 0),
        created_count=int(run.generated_count or 0),
        blocked_count=int(run.error_count or 0),
        notes=notes[:6] or ["Aucun profil récurrent à générer maintenant."],
    )


def _run_campaigns_job(db: Session, user: AuthUser) -> SchedulerEngineRunJobOut:
    from . import ops_campaigns as campaigns_base

    result = campaigns_base.run_due_portfolio_campaigns(db=db, user=user)
    status = "warn" if int(result.skipped_count or 0) > 0 else "ok"
    status, status_label, tone = _status_payload(status)
    return SchedulerEngineRunJobOut(
        key="campaigns",
        label=str(_JOB_SPECS["campaigns"]["label"]),
        status=status,
        status_label=status_label,
        tone=tone,
        processed_count=int(result.processed_count or 0),
        created_count=int(result.tasks_created or 0),
        blocked_count=int(result.skipped_count or 0),
        notes=[str(item) for item in (result.notes or []) if str(item).strip()][:6] or ["Aucune campagne due à exécuter."],
    )


def _run_outbox_job(db: Session, user: AuthUser) -> SchedulerEngineRunJobOut:
    from . import ops_outbox as outbox_base

    result = outbox_base.run_outbox_pipeline(db=db, user=user)
    status = "error" if int(result.failed_count or 0) > 0 else "ok"
    status, status_label, tone = _status_payload(status)
    return SchedulerEngineRunJobOut(
        key="outbox",
        label=str(_JOB_SPECS["outbox"]["label"]),
        status=status,
        status_label=status_label,
        tone=tone,
        processed_count=int(result.campaigns_processed or 0),
        created_count=int(result.sent_count or 0),
        blocked_count=int(result.failed_count or 0),
        notes=[str(item) for item in (result.notes or []) if str(item).strip()][:6] or ["Pipeline outbox traité."],
    )


def _run_sla_job(db: Session, user: AuthUser) -> SchedulerEngineRunJobOut:
    from . import ops_alerts as alerts_base

    result = alerts_base.run_sla_refresh(db=db, user=user)
    status = "warn" if int(result.summary.breached_count or 0) > 0 else "ok"
    status, status_label, tone = _status_payload(status)
    return SchedulerEngineRunJobOut(
        key="sla",
        label=str(_JOB_SPECS["sla"]["label"]),
        status=status,
        status_label=status_label,
        tone=tone,
        processed_count=int(result.summary.tasks_considered or 0),
        created_count=int(result.summary.due_next_24h_count or 0),
        blocked_count=int(result.summary.breached_count or 0),
        notes=[
            f"{int(result.summary.due_next_24h_count or 0)} tâche(s) à surveiller dans les 24h.",
            f"{int(result.summary.escalated_count or 0)} escalade(s) actives.",
        ],
    )


def _run_digest_job(db: Session, user: AuthUser) -> SchedulerEngineRunJobOut:
    from . import ops_comms as comms_base

    result = comms_base.run_digest(db=db, user=user)
    latest = result.recent_runs[0] if result.recent_runs else None
    status = "warn" if int(result.summary.urgent_count or 0) > 0 else "ok"
    status, status_label, tone = _status_payload(status)
    return SchedulerEngineRunJobOut(
        key="digest",
        label=str(_JOB_SPECS["digest"]["label"]),
        status=status,
        status_label=status_label,
        tone=tone,
        processed_count=int(result.summary.matched_items_count or 0),
        created_count=int(latest.auto_tasks_created or 0) if latest else int(result.summary.recent_auto_tasks_created or 0),
        blocked_count=0,
        notes=[
            result.headline,
            f"{int(result.summary.matched_rules_count or 0)} règle(s) matchée(s) · {int(result.summary.urgent_count or 0)} urgent(s).",
        ],
    )


def _execute_job(job_key: str, *, db: Session, user: AuthUser) -> SchedulerEngineRunJobOut:
    key = _normalize_job_key(job_key)
    if key == "playbooks":
        return _run_playbooks_job(db, user)
    if key == "recurring":
        return _run_recurring_job(db, user)
    if key == "campaigns":
        return _run_campaigns_job(db, user)
    if key == "outbox":
        return _run_outbox_job(db, user)
    if key == "sla":
        return _run_sla_job(db, user)
    if key == "digest":
        return _run_digest_job(db, user)
    raise HTTPException(400, "Job scheduler invalide.")


@router.get("/scheduler/control", response_model=SchedulerControlOut)
def scheduler_control(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    _, payload = _control_payload(db, user)
    return payload


@router.post("/scheduler/control/heartbeat", response_model=SchedulerControlOut)
def scheduler_control_heartbeat(
    payload: SchedulerHeartbeatRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    heartbeat = _heartbeat_entry(
        now=now,
        source=payload.source,
        runner_label=payload.runner_label or user.email,
        note=payload.note or "Heartbeat envoyé depuis le centre de contrôle.",
        stale_after_minutes=payload.stale_after_minutes,
    )
    settings_row = _write_engine_features(db, settings_row, heartbeat=_serialize_heartbeat(heartbeat))
    _, board = _control_payload(db, user, settings_row=settings_row, now=now)
    return board


@router.post("/scheduler/control/unlock", response_model=SchedulerControlOut)
def unlock_scheduler_control(
    payload: SchedulerForceUnlockRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    lock_entry = _read_lock(settings_row)
    if lock_entry:
        notes = [str(item).strip() for item in lock_entry.get("notes") or [] if str(item).strip()]
        reason = str(payload.reason or "").strip() or "Déverrouillage manuel depuis le centre de contrôle."
        notes.insert(0, reason)
        lock_entry.update({
            "active": False,
            "released_at": now,
            "generated_at": now,
            "notes": notes[:6],
        })
        heartbeat = _heartbeat_entry(
            now=now,
            source="console",
            runner_label=user.email,
            note=reason,
        )
        settings_row = _write_engine_features(
            db,
            settings_row,
            lock=_serialize_lock(lock_entry),
            heartbeat=_serialize_heartbeat(heartbeat),
        )
    _, board = _control_payload(db, user, settings_row=settings_row, now=now)
    return board


@router.patch("/scheduler/control/jobs/{job_key}", response_model=SchedulerEngineJobOut)
def update_scheduler_job(
    job_key: str,
    payload: SchedulerJobPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    key = _normalize_job_key(job_key)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    controls = _read_controls(settings_row)
    current = controls[key]
    if payload.active is not None:
        current["active"] = bool(payload.active)
    if payload.interval_minutes is not None:
        current["interval_minutes"] = _normalize_interval(key, payload.interval_minutes)
    controls[key] = current
    settings_row = _write_engine_features(db, settings_row, controls=controls)
    _, board = _control_payload(db, user, settings_row=settings_row)
    job = next((item for item in board.jobs if item.key == key), None)
    if not job:
        raise HTTPException(404, "Job scheduler introuvable après mise à jour.")
    return job


@router.post("/scheduler/control/run", response_model=SchedulerControlRunBatchOut)
def run_scheduler_control(
    payload: SchedulerControlRunRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    started_at = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    controls = _read_controls(settings_row)

    requested = [_normalize_job_key(item) for item in (payload.job_keys or [])]
    if not requested:
        requested = [key for key, config in controls.items() if bool(config.get("active", True))]
    requested = list(dict.fromkeys(requested))

    heartbeat_start = _heartbeat_entry(
        now=started_at,
        source="console",
        runner_label=payload.runner_label or user.email,
        note="Run orchestré démarré depuis le centre de contrôle.",
    )
    settings_row = _write_engine_features(db, settings_row, heartbeat=_serialize_heartbeat(heartbeat_start))
    settings_row, lock_entry, previous_lock = _acquire_lock(
        db,
        settings_row,
        now=started_at,
        job_keys=requested,
        trigger=payload.trigger,
        runner_label=payload.runner_label or user.email,
        force=bool(payload.force),
    )

    results: list[SchedulerEngineRunJobOut] = []
    notes: list[str] = []
    finished_at = started_at
    run_status = "ok"

    try:
        for key in requested:
            if not controls[key].get("active", True) and not payload.include_paused:
                status, status_label, tone = _status_payload("paused")
                result = SchedulerEngineRunJobOut(
                    key=key,
                    label=str(_JOB_SPECS[key]["label"]),
                    status=status,
                    status_label=status_label,
                    tone=tone,
                    notes=["Job en pause : relance manuelle ignorée tant que include_paused=false."],
                )
                results.append(result)
                notes.append(f"{_JOB_SPECS[key]['label']} est en pause.")
                continue
            try:
                result = _execute_job(key, db=db, user=user)
            except HTTPException as exc:
                status, status_label, tone = _status_payload("error")
                detail = exc.detail
                raw_message = detail.get("message") if isinstance(detail, dict) else detail
                result = SchedulerEngineRunJobOut(
                    key=key,
                    label=str(_JOB_SPECS[key]["label"]),
                    status=status,
                    status_label=status_label,
                    tone=tone,
                    notes=[sanitize_public_error_message(raw_message, status_code=exc.status_code)],
                )
            except Exception:
                logger.exception("scheduler_job_execution_failed", extra={"job_key": key})
                status, status_label, tone = _status_payload("error")
                result = SchedulerEngineRunJobOut(
                    key=key,
                    label=str(_JOB_SPECS[key]["label"]),
                    status=status,
                    status_label=status_label,
                    tone=tone,
                    notes=["Cette tâche n’a pas pu être exécutée. Réessayez ou consultez le journal interne."],
                )
            results.append(result)
            if result.notes:
                notes.append(f"{result.label} · {result.notes[0]}")

        if any(item.status == "error" for item in results):
            run_status = "error"
        elif any(item.status in {"warn", "paused"} for item in results):
            run_status = "warn"
        else:
            run_status = "ok"
        finished_at = datetime.now(timezone.utc).replace(tzinfo=None)

        if previous_lock and previous_lock.active and payload.force:
            notes.insert(0, "Run forcé : un verrou précédent a été remplacé.")

        status, status_label, tone = _status_payload(run_status)
        run_entry = {
            "id": str(lock_entry.get("run_id") or uuid.uuid4()),
            "trigger": str(payload.trigger or "manual").strip().lower() or "manual",
            "status": status,
            "job_keys": requested,
            "jobs": [item.model_dump() for item in results],
            "notes": notes[:8],
            "started_at": started_at,
            "finished_at": finished_at,
            "generated_at": finished_at,
        }
        engine_runs = [ops_base._serialize_dt_dict(run_entry, _ENGINE_RUN_DT_KEYS), *_read_engine_runs(settings_row)]
        heartbeat_end = _heartbeat_entry(
            now=finished_at,
            source="console",
            runner_label=payload.runner_label or user.email,
            note=f"Run {status_label.lower()} terminé sur {len(requested)} job(s).",
        )
        settings_row = _write_engine_features(
            db,
            settings_row,
            runs=engine_runs,
            heartbeat=_serialize_heartbeat(heartbeat_end),
        )
        settings_row = _release_lock(db, settings_row, now=finished_at, lock_entry=lock_entry, note=f"Run {status_label.lower()} terminé.")
        try:
            from . import ops_supervision as supervision_base

            settings_row = supervision_base.record_scheduler_run_feedback(
                db,
                settings_row,
                run=SchedulerEngineRunOut(
                    id=str(run_entry["id"]),
                    trigger=str(run_entry["trigger"]),
                    status=status,
                    status_label=status_label,
                    tone=tone,
                    job_keys=requested,
                    jobs=results,
                    notes=notes[:8],
                    started_at=started_at,
                    finished_at=finished_at,
                    generated_at=finished_at,
                ),
                now=finished_at,
            )
        except Exception:
            pass
        _, board = _control_payload(db, user, settings_row=settings_row, now=finished_at)
        return SchedulerControlRunBatchOut(
            run=SchedulerEngineRunOut(
                id=str(run_entry["id"]),
                trigger=str(run_entry["trigger"]),
                status=status,
                status_label=status_label,
                tone=tone,
                job_keys=requested,
                jobs=results,
                notes=notes[:8],
                started_at=started_at,
                finished_at=finished_at,
                generated_at=finished_at,
            ),
            board=board,
        )
    except Exception:
        finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
        heartbeat_end = _heartbeat_entry(
            now=finished_at,
            source="console",
            runner_label=payload.runner_label or user.email,
            note="Run interrompu : voir l’historique pour le détail.",
        )
        settings_row = _write_engine_features(db, settings_row, heartbeat=_serialize_heartbeat(heartbeat_end))
        _release_lock(db, settings_row, now=finished_at, lock_entry=lock_entry, note="Run interrompu avant finalisation.")
        raise
