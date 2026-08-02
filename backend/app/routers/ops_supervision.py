from __future__ import annotations

import copy
import csv
import hashlib
import hmac
import io
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_product_feature, require_viewer_or_admin
from ..models import Tenant, TenantSettings
from ..services.product_capabilities import is_product_feature_enabled
from ..utils.url_security import parse_and_validate_outbound_url
from . import ops as ops_base

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/ops",
    tags=["ops"],
    dependencies=[Depends(require_product_feature("payments_enabled"))],
)

_POLICY_STORE_KEY = "ops_scheduler_supervision_policies"
_INCIDENT_STORE_KEY = "ops_scheduler_supervision_incidents"
_ALERT_CHANNEL_STORE_KEY = "ops_scheduler_supervision_alert_channels"
_ALERT_DELIVERY_STORE_KEY = "ops_scheduler_supervision_alert_deliveries"
_AUDIT_STORE_KEY = "ops_scheduler_supervision_audit"

_POLICY_DT_KEYS = {"last_error_at", "last_success_at", "next_retry_at", "last_attempt_at", "updated_at", "created_at"}
_INCIDENT_DT_KEYS = {
    "first_seen_at",
    "last_seen_at",
    "resolved_at",
    "updated_at",
    "created_at",
    "acknowledged_at",
    "snoozed_until",
    "last_external_alert_at",
}
_CHANNEL_DT_KEYS = {"created_at", "updated_at", "last_test_at", "last_delivery_at", "last_digest_at"}
_DELIVERY_DT_KEYS = {"attempted_at", "generated_at"}
_AUDIT_DT_KEYS = {"created_at"}

_ALLOWED_SEVERITIES = {"low", "medium", "high", "critical"}
_ALLOWED_CHANNEL_KINDS = {"slack", "webhook"}
_ALLOWED_INCIDENT_SCOPES = {"single", "same_severity", "same_module", "all_open"}
_SEVERITY_RANK = {"low": 10, "medium": 20, "high": 30, "critical": 40}
_MAX_INCIDENTS = 60
_MAX_DELIVERIES = 60
_MAX_AUDIT = 120


class SchedulerPolicyOut(BaseModel):
    key: str
    label: str
    max_attempts: int = 2
    backoff_minutes: int = 30
    pause_after_failures: int = 3
    alert_on_error: bool = True
    failure_streak: int = 0
    auto_paused: bool = False
    last_run_status: str = "idle"
    last_error_at: datetime | None = None
    last_success_at: datetime | None = None
    last_attempt_at: datetime | None = None
    next_retry_at: datetime | None = None
    retry_due_now: bool = False
    note: str | None = None


class SchedulerPolicySummaryOut(BaseModel):
    total_jobs: int = 0
    failing_jobs_count: int = 0
    retry_due_count: int = 0
    auto_paused_count: int = 0
    alerting_jobs_count: int = 0


class SchedulerPolicyPatchRequest(BaseModel):
    max_attempts: int | None = Field(default=None, ge=0, le=8)
    backoff_minutes: int | None = Field(default=None, ge=5, le=1440)
    pause_after_failures: int | None = Field(default=None, ge=1, le=12)
    alert_on_error: bool | None = None
    note: str | None = Field(default=None, max_length=240)


class SchedulerIncidentOut(BaseModel):
    id: str
    issue_key: str
    title: str
    description: str
    severity: str = "medium"
    severity_label: str = "À surveiller"
    module: str = "scheduler"
    href: str = "/app/scheduler"
    status: str = "open"
    occurrences: int = 1
    source_kind: str | None = None
    source_ref: str | None = None
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None
    resolved_at: datetime | None = None
    acknowledged: bool = False
    acknowledged_at: datetime | None = None
    acknowledged_by_label: str | None = None
    snoozed_until: datetime | None = None
    snoozed_reason: str | None = None


class SchedulerIncidentSummaryOut(BaseModel):
    total_count: int = 0
    open_count: int = 0
    critical_open_count: int = 0
    high_open_count: int = 0
    acknowledged_count: int = 0
    snoozed_count: int = 0
    resolved_recent_count: int = 0


class SchedulerIncidentPatchRequest(BaseModel):
    acknowledged: bool | None = None
    snooze_hours: int | None = Field(default=None, ge=1, le=168)
    snooze_reason: str | None = Field(default=None, max_length=160)
    clear_snooze: bool | None = None
    scope: str | None = Field(default="single", max_length=32)
    action_reason: str | None = Field(default=None, max_length=180)


class SchedulerIncidentMutationOut(BaseModel):
    incident: SchedulerIncidentOut
    applied_count: int = 1
    scope: str = "single"


class SchedulerAlertChannelOut(BaseModel):
    id: str
    kind: str
    kind_label: str
    label: str
    masked_url: str
    enabled: bool = True
    min_severity: str = "high"
    min_severity_label: str = "À surveiller"
    mention: str | None = None
    include_digest: bool = False
    digest_min_urgent_count: int = 0
    route_modules: list[str] = Field(default_factory=list)
    route_module_labels: list[str] = Field(default_factory=list)
    route_source_kinds: list[str] = Field(default_factory=list)
    route_event_kinds: list[str] = Field(default_factory=list)
    route_summary: str = "Tous les signaux"
    min_occurrences: int = 1
    min_age_minutes: int = 0
    message_template: str | None = None
    payload_template: str | None = None
    template_summary: str = "Templates par défaut"
    signature_enabled: bool = False
    signature_header: str | None = None
    has_signing_secret: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None
    last_test_at: datetime | None = None
    last_delivery_at: datetime | None = None
    last_digest_at: datetime | None = None
    last_status: str = "idle"
    success_count: int = 0
    failure_count: int = 0
    last_error: str | None = None


class SchedulerAlertChannelCreateRequest(BaseModel):
    kind: str = Field(min_length=4, max_length=20)
    label: str = Field(min_length=3, max_length=120)
    url: str = Field(min_length=12, max_length=500)
    min_severity: str = Field(default="high", min_length=3, max_length=16)
    mention: str | None = Field(default=None, max_length=120)
    enabled: bool = True
    include_digest: bool = False
    digest_min_urgent_count: int = Field(default=0, ge=0, le=50)
    route_modules: list[str] = Field(default_factory=list)
    route_source_kinds: list[str] = Field(default_factory=list)
    route_event_kinds: list[str] = Field(default_factory=list)
    min_occurrences: int = Field(default=1, ge=1, le=20)
    min_age_minutes: int = Field(default=0, ge=0, le=10080)
    message_template: str | None = Field(default=None, max_length=1200)
    payload_template: str | None = Field(default=None, max_length=4000)
    sign_payload: bool = False
    signature_header: str | None = Field(default="X-Scheduler-Signature", max_length=80)
    signing_secret: str | None = Field(default=None, max_length=240)


class SchedulerAlertChannelPatchRequest(BaseModel):
    label: str | None = Field(default=None, min_length=3, max_length=120)
    url: str | None = Field(default=None, min_length=12, max_length=500)
    min_severity: str | None = Field(default=None, min_length=3, max_length=16)
    mention: str | None = Field(default=None, max_length=120)
    enabled: bool | None = None
    include_digest: bool | None = None
    digest_min_urgent_count: int | None = Field(default=None, ge=0, le=50)
    route_modules: list[str] | None = None
    route_source_kinds: list[str] | None = None
    route_event_kinds: list[str] | None = None
    min_occurrences: int | None = Field(default=None, ge=1, le=20)
    min_age_minutes: int | None = Field(default=None, ge=0, le=10080)
    message_template: str | None = Field(default=None, max_length=1200)
    payload_template: str | None = Field(default=None, max_length=4000)
    clear_message_template: bool | None = None
    clear_payload_template: bool | None = None
    sign_payload: bool | None = None
    signature_header: str | None = Field(default=None, max_length=80)
    signing_secret: str | None = Field(default=None, max_length=240)
    clear_signing_secret: bool | None = None


class SchedulerAlertDeliveryOut(BaseModel):
    id: str
    channel_id: str
    channel_label: str
    kind: str
    event_kind: str
    severity: str
    title: str
    status: str = "ok"
    status_label: str = "Envoyé"
    tone: str = "ok"
    attempted_at: datetime | None = None
    response_status: int | None = None
    error: str | None = None
    test: bool = False


class SchedulerAlertSummaryOut(BaseModel):
    total_channels: int = 0
    enabled_channels: int = 0
    failing_channels: int = 0
    digest_enabled_channels: int = 0
    success_24h_count: int = 0
    failure_24h_count: int = 0
    digest_delivery_24h_count: int = 0
    last_delivery_at: datetime | None = None


class SchedulerAuditEntryOut(BaseModel):
    id: str
    action_kind: str
    action_label: str
    actor_label: str | None = None
    target_kind: str
    target_label: str
    status: str = "ok"
    status_label: str = "Réussi"
    tone: str = "ok"
    summary: str
    details: str | None = None
    module: str = "scheduler"
    href: str = "/app/scheduler"
    created_at: datetime | None = None


class SchedulerAuditSummaryOut(BaseModel):
    total_count: int = 0
    filtered_count: int = 0
    actions_24h_count: int = 0
    delivery_failures_7d_count: int = 0
    external_dispatch_24h_count: int = 0
    incident_actions_7d_count: int = 0


class SchedulerAuditListOut(BaseModel):
    summary: SchedulerAuditSummaryOut = Field(default_factory=SchedulerAuditSummaryOut)
    items: list[SchedulerAuditEntryOut] = Field(default_factory=list)
    total_count: int = 0
    filtered_count: int = 0
    query: str | None = None
    action_kind: str | None = None
    status: str | None = None
    module: str | None = None
    days: int = 30


class SchedulerAlertPreviewRequest(BaseModel):
    kind: str = Field(default="webhook", min_length=4, max_length=20)
    label: str = Field(default="Preview channel", min_length=3, max_length=120)
    mention: str | None = Field(default=None, max_length=120)
    event_kind: str = Field(default="incident_opened", min_length=3, max_length=80)
    severity: str = Field(default="high", min_length=3, max_length=16)
    title: str = Field(default="Incident scheduler critique", min_length=3, max_length=200)
    message: str = Field(default="Le scheduler nécessite une intervention opérateur.", min_length=3, max_length=500)
    payload: dict[str, Any] = Field(default_factory=dict)
    message_template: str | None = Field(default=None, max_length=1200)
    payload_template: str | None = Field(default=None, max_length=4000)
    sign_payload: bool = False
    signature_header: str | None = Field(default="X-Scheduler-Signature", max_length=80)
    signing_secret: str | None = Field(default=None, max_length=240)


class SchedulerAlertPreviewOut(BaseModel):
    kind: str
    kind_label: str
    title: str
    message: str
    body_preview: Any
    body_preview_pretty: str
    headers_preview: dict[str, str] = Field(default_factory=dict)
    template_summary: str = "Templates par défaut"


class SchedulerSupervisionBoardOut(BaseModel):
    policy_summary: SchedulerPolicySummaryOut = Field(default_factory=SchedulerPolicySummaryOut)
    policies: list[SchedulerPolicyOut] = Field(default_factory=list)
    incident_summary: SchedulerIncidentSummaryOut = Field(default_factory=SchedulerIncidentSummaryOut)
    incidents: list[SchedulerIncidentOut] = Field(default_factory=list)
    alert_summary: SchedulerAlertSummaryOut = Field(default_factory=SchedulerAlertSummaryOut)
    channels: list[SchedulerAlertChannelOut] = Field(default_factory=list)
    recent_deliveries: list[SchedulerAlertDeliveryOut] = Field(default_factory=list)
    audit_summary: SchedulerAuditSummaryOut = Field(default_factory=SchedulerAuditSummaryOut)
    audit_trail: list[SchedulerAuditEntryOut] = Field(default_factory=list)
    generated_at: datetime


class SchedulerAlertChannelTestResultOut(BaseModel):
    channel: SchedulerAlertChannelOut
    delivery: SchedulerAlertDeliveryOut
    board: SchedulerSupervisionBoardOut


class DeleteResponse(BaseModel):
    ok: bool = True


SchedulerSupervisionBoardOut.model_rebuild()


def _features(settings_row: TenantSettings | None) -> dict[str, Any]:
    return ops_base._features(settings_row)


def _severity_label(value: str | None) -> str:
    normalized = str(value or "medium").strip().lower()
    return {
        "low": "Info",
        "medium": "À surveiller",
        "high": "Important",
        "critical": "Critique",
    }.get(normalized, "À surveiller")


def _tone_for_status(value: str | None) -> str:
    normalized = str(value or "idle").strip().lower()
    if normalized in {"ok", "success", "sent"}:
        return "ok"
    if normalized in {"warn", "warning"}:
        return "warn"
    if normalized in {"error", "failed", "blocked"}:
        return "danger"
    return "info"


def _status_label(value: str | None) -> str:
    normalized = str(value or "idle").strip().lower()
    return {
        "ok": "Envoyé",
        "success": "Envoyé",
        "warn": "À surveiller",
        "error": "Échec",
        "failed": "Échec",
        "idle": "Aucun envoi",
    }.get(normalized, "Aucun envoi")


def _normalize_severity(value: Any, *, default: str = "high") -> str:
    key = str(value or default).strip().lower()
    if key not in _ALLOWED_SEVERITIES:
        key = default
    return key


def _normalize_incident_scope(value: Any) -> str:
    key = str(value or "single").strip().lower()
    if key not in _ALLOWED_INCIDENT_SCOPES:
        key = "single"
    return key


def _normalize_slug_list(
    value: Any, *, allowed: set[str] | None = None, max_items: int = 12, max_length: int = 40
) -> list[str]:
    if value is None:
        return []
    raw_items: list[Any]
    if isinstance(value, (list, tuple, set)):
        raw_items = list(value)
    else:
        raw_items = str(value or "").split(",")
    seen: set[str] = set()
    rows: list[str] = []
    allowed_chars = set("abcdefghijklmnopqrstuvwxyz0123456789_-")
    for item in raw_items:
        key = str(item or "").strip().lower().replace(" ", "_")[:max_length]
        key = "".join(ch for ch in key if ch in allowed_chars)
        if not key or key in seen:
            continue
        if allowed is not None and key not in allowed:
            continue
        rows.append(key)
        seen.add(key)
        if len(rows) >= max_items:
            break
    return rows


def _clip_text(value: Any, *, max_length: int = 500) -> str | None:
    text = str(value or "").strip()
    return text[:max_length] or None


def _compact_text(value: Any, *, max_length: int = 160) -> str:
    text = " ".join(str(value or "").split())
    return text[:max_length]


def _flatten_template_context(payload: Any, *, prefix: str = "") -> dict[str, str]:
    context: dict[str, str] = {}
    if isinstance(payload, dict):
        for key, value in payload.items():
            safe_key = str(key or "").strip().lower().replace(" ", "_")
            if not safe_key:
                continue
            full_key = f"{prefix}{safe_key}" if prefix else safe_key
            if isinstance(value, dict):
                context.update(_flatten_template_context(value, prefix=f"{full_key}."))
            elif isinstance(value, list):
                try:
                    context[full_key] = json.dumps(value, ensure_ascii=False)
                except Exception:
                    context[full_key] = str(value)
            elif value is None:
                context[full_key] = ""
            else:
                context[full_key] = str(value)
    return context


def _render_template_string(template: Any, context: dict[str, str]) -> str | None:
    text = str(template or "")
    if not text.strip():
        return None
    rendered = text
    for key, value in context.items():
        rendered = rendered.replace(f"{{{{{key}}}}}", value)
    return rendered


def _build_render_context(
    channel: dict[str, Any],
    *,
    event_kind: str,
    severity: str,
    title: str,
    message: str,
    payload: dict[str, Any],
    now: datetime,
    test: bool = False,
) -> dict[str, str]:
    safe_payload = copy.deepcopy(payload) if isinstance(payload, dict) else {}
    context = {
        "event_kind": str(event_kind or "scheduler_run"),
        "severity": _normalize_severity(severity),
        "title": str(title or "Alerte scheduler"),
        "message": str(message or "Signal supervision"),
        "channel_label": str(channel.get("label") or "Canal"),
        "mention": str(channel.get("mention") or ""),
        "module": str(safe_payload.get("module") or "scheduler"),
        "source_kind": str(safe_payload.get("source_kind") or safe_payload.get("incident_type") or "scheduler"),
        "incident_type": str(safe_payload.get("incident_type") or safe_payload.get("source_kind") or "scheduler"),
        "issue_key": str(safe_payload.get("issue_key") or ""),
        "href": str(safe_payload.get("href") or "/app/scheduler"),
        "occurrences": str(int(safe_payload.get("occurrences") or 1)),
        "age_minutes": str(int(safe_payload.get("age_minutes") or 0)),
        "generated_at": now.isoformat(),
        "is_test": "1" if test else "0",
        "payload_json": json.dumps(safe_payload, ensure_ascii=False, default=str),
    }
    context.update(_flatten_template_context(safe_payload, prefix="payload."))
    return context


def _template_summary(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    if str(payload.get("message_template") or "").strip():
        parts.append("message custom")
    if str(payload.get("payload_template") or "").strip():
        parts.append("payload custom")
    min_occurrences = max(1, int(payload.get("min_occurrences") or 1))
    min_age_minutes = max(0, int(payload.get("min_age_minutes") or 0))
    if min_occurrences > 1:
        parts.append(f"≥{min_occurrences} occurrence(s)")
    if min_age_minutes > 0:
        parts.append(f"≥{min_age_minutes} min")
    return " · ".join(parts) if parts else "Templates par défaut"


def _render_alert_body(
    channel: dict[str, Any],
    *,
    event_kind: str,
    severity: str,
    title: str,
    message: str,
    payload: dict[str, Any],
    now: datetime,
    test: bool = False,
) -> tuple[Any, str, str]:
    kind = _normalize_channel_kind(channel.get("kind"))
    mention = str(channel.get("mention") or "").strip()
    context = _build_render_context(
        channel,
        event_kind=event_kind,
        severity=severity,
        title=title,
        message=message,
        payload=payload,
        now=now,
        test=test,
    )
    message_template = _render_template_string(channel.get("message_template"), context)
    payload_template = _render_template_string(channel.get("payload_template"), context)

    rendered_message = message_template or str(message or "Signal supervision")
    if kind == "slack":
        text_body = rendered_message
        if not message_template:
            text_body = f"[{_normalize_severity(severity).upper()}] {title}\n{message}"
        if mention:
            text_body = f"{mention} {text_body}".strip()
        body: Any = {"text": text_body}
    else:
        if payload_template:
            try:
                body = json.loads(payload_template)
            except Exception:
                body = {"text": payload_template}
        else:
            body = copy.deepcopy(payload)
        if mention and isinstance(body, dict) and not body.get("mention"):
            body["mention"] = mention
    return body, rendered_message, _template_summary(channel)


def _audit_summary_for_items(
    items: list[SchedulerAuditEntryOut], *, now: datetime, total_count: int | None = None
) -> SchedulerAuditSummaryOut:
    full_total = len(items) if total_count is None else int(total_count)
    return SchedulerAuditSummaryOut(
        total_count=full_total,
        filtered_count=len(items),
        actions_24h_count=sum(1 for item in items if (item.created_at or datetime.min) >= (now - timedelta(days=1))),
        delivery_failures_7d_count=sum(
            1
            for item in items
            if item.status == "error"
            and item.action_kind in {"external_delivery", "incident_delivery", "channel_test"}
            and (item.created_at or datetime.min) >= (now - timedelta(days=7))
        ),
        external_dispatch_24h_count=sum(
            1
            for item in items
            if item.action_kind in {"external_delivery", "incident_delivery", "channel_test"}
            and (item.created_at or datetime.min) >= (now - timedelta(days=1))
        ),
        incident_actions_7d_count=sum(
            1
            for item in items
            if item.action_kind.startswith("incident_")
            and (item.created_at or datetime.min) >= (now - timedelta(days=7))
        ),
    )


def _filter_audit_items(
    items: list[SchedulerAuditEntryOut],
    *,
    query: str | None = None,
    action_kind: str | None = None,
    status: str | None = None,
    module: str | None = None,
    days: int = 30,
    limit: int = 60,
) -> list[SchedulerAuditEntryOut]:
    needle = str(query or "").strip().lower()
    action_filter = str(action_kind or "").strip().lower()
    status_filter = str(status or "").strip().lower()
    module_filter = str(module or "").strip().lower()
    max_days = max(1, min(int(days or 30), 365))
    min_created_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max_days)
    filtered: list[SchedulerAuditEntryOut] = []
    for item in items:
        created_at = item.created_at or datetime.min
        if created_at < min_created_at:
            continue
        if action_filter and item.action_kind != action_filter:
            continue
        if status_filter and item.status != status_filter:
            continue
        if module_filter and item.module != module_filter:
            continue
        if needle:
            haystack = " ".join(
                [
                    item.action_kind or "",
                    item.action_label or "",
                    item.actor_label or "",
                    item.target_kind or "",
                    item.target_label or "",
                    item.summary or "",
                    item.details or "",
                    item.module or "",
                ]
            ).lower()
            if needle not in haystack:
                continue
        filtered.append(item)
        if len(filtered) >= max(1, min(int(limit or 60), 200)):
            break
    return filtered


def _route_summary(*, route_modules: list[str], route_source_kinds: list[str], route_event_kinds: list[str]) -> str:
    parts: list[str] = []
    if route_modules:
        labels = [ops_base._MODULE_LABELS.get(key, key.replace("_", " ").title()) for key in route_modules[:3]]
        parts.append(f"modules {', '.join(labels)}")
    if route_source_kinds:
        labels = [key.replace("_", " ") for key in route_source_kinds[:3]]
        parts.append(f"types {', '.join(labels)}")
    if route_event_kinds:
        labels = [key.replace("_", " ") for key in route_event_kinds[:3]]
        parts.append(f"événements {', '.join(labels)}")
    return " · ".join(parts) if parts else "Tous les signaux"


def _audit_action_label(value: Any) -> str:
    key = str(value or "update").strip().lower()
    return {
        "incident_ack": "Ack incident",
        "incident_snooze": "Snooze incident",
        "incident_unsnooze": "Réactivation incident",
        "incident_unack": "Retrait ack",
        "policy_update": "Politique retry",
        "channel_create": "Canal ajouté",
        "channel_update": "Canal mis à jour",
        "channel_delete": "Canal supprimé",
        "channel_test": "Test canal",
        "external_delivery": "Diffusion externe",
        "incident_delivery": "Diffusion incident",
    }.get(key, key.replace("_", " ").title())


def _normalize_channel_kind(value: Any) -> str:
    key = str(value or "webhook").strip().lower()
    if key not in _ALLOWED_CHANNEL_KINDS:
        raise HTTPException(400, "Type de canal invalide.")
    return key


def _validate_channel_url(value: Any) -> str:
    text = str(value or "").strip()
    try:
        return parse_and_validate_outbound_url(text)[:500]
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail={"code": "channel_url_invalid", "message": "URL du canal invalide."},
        )


def _mask_url(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return "—"
    parsed = urlparse(text)
    if not parsed.scheme or not parsed.netloc:
        return "URL masquée"
    path_tail = parsed.path[-10:] if parsed.path else ""
    return f"{parsed.scheme}://{parsed.netloc}/…{path_tail}" if path_tail else f"{parsed.scheme}://{parsed.netloc}/…"


def _normalize_signature_header(value: Any) -> str:
    header = str(value or "X-Scheduler-Signature").strip()[:80] or "X-Scheduler-Signature"
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-")
    if len(header) < 3 or any(char not in allowed for char in header):
        raise HTTPException(400, "Nom d'en-tête de signature invalide.")
    return header


def _payload_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")


def _signature_headers(
    channel: dict[str, Any], *, event_kind: str, payload_bytes: bytes, now: datetime, test: bool = False
) -> dict[str, str]:
    if _normalize_channel_kind(channel.get("kind")) != "webhook":
        return {}
    if not bool(channel.get("sign_payload")):
        return {}
    secret = str(channel.get("signing_secret") or "").strip()
    if not secret:
        return {}
    header_name = _normalize_signature_header(channel.get("signature_header"))
    timestamp = str(int(now.timestamp()))
    signed = hmac.new(
        secret.encode("utf-8"), timestamp.encode("utf-8") + b"." + payload_bytes, hashlib.sha256
    ).hexdigest()
    return {
        header_name: f"t={timestamp},v1={signed}",
        "X-Scheduler-Event": str(event_kind or "scheduler_run"),
        "X-Scheduler-Test": "1" if test else "0",
    }


def _job_specs() -> dict[str, dict[str, Any]]:
    from . import ops_scheduler as scheduler_base

    return scheduler_base._JOB_SPECS


def _default_policy_row(job_key: str, *, now: datetime) -> dict[str, Any]:
    backoff = 45 if job_key == "outbox" else 30 if job_key in {"campaigns", "recurring"} else 20
    return {
        "key": job_key,
        "max_attempts": 2,
        "backoff_minutes": backoff,
        "pause_after_failures": 3,
        "alert_on_error": True,
        "failure_streak": 0,
        "auto_paused": False,
        "last_run_status": "idle",
        "last_error_at": None,
        "last_success_at": None,
        "last_attempt_at": None,
        "next_retry_at": None,
        "note": None,
        "created_at": now,
        "updated_at": now,
    }


def _read_policies(settings_row: TenantSettings | None) -> dict[str, dict[str, Any]]:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    raw = _features(settings_row).get(_POLICY_STORE_KEY)
    raw = raw if isinstance(raw, dict) else {}
    rows: dict[str, dict[str, Any]] = {}
    for key in _job_specs().keys():
        base = _default_policy_row(key, now=now)
        raw_item = raw.get(key)
        item: dict[str, Any] = raw_item if isinstance(raw_item, dict) else {}
        hydrated = ops_base._hydrate_dt_dict(item, _POLICY_DT_KEYS)
        base.update(
            {
                "max_attempts": max(0, min(int(hydrated.get("max_attempts") or base["max_attempts"]), 8)),
                "backoff_minutes": max(5, min(int(hydrated.get("backoff_minutes") or base["backoff_minutes"]), 1440)),
                "pause_after_failures": max(
                    1, min(int(hydrated.get("pause_after_failures") or base["pause_after_failures"]), 12)
                ),
                "alert_on_error": bool(hydrated.get("alert_on_error", base["alert_on_error"])),
                "failure_streak": max(0, int(hydrated.get("failure_streak") or 0)),
                "auto_paused": bool(hydrated.get("auto_paused", False)),
                "last_run_status": str(hydrated.get("last_run_status") or "idle").strip().lower() or "idle",
                "last_error_at": ops_base._as_dt(hydrated.get("last_error_at")),
                "last_success_at": ops_base._as_dt(hydrated.get("last_success_at")),
                "last_attempt_at": ops_base._as_dt(hydrated.get("last_attempt_at")),
                "next_retry_at": ops_base._as_dt(hydrated.get("next_retry_at")),
                "note": str(hydrated.get("note") or "").strip() or None,
                "created_at": ops_base._as_dt(hydrated.get("created_at")) or base["created_at"],
                "updated_at": ops_base._as_dt(hydrated.get("updated_at")) or base["updated_at"],
            }
        )
        rows[key] = base
    return rows


def _serialize_policies(rows: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    payload: dict[str, dict[str, Any]] = {}
    for key, row in rows.items():
        payload[key] = ops_base._serialize_dt_dict(row, _POLICY_DT_KEYS)
    return payload


def _read_incident_rows(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_INCIDENT_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [ops_base._hydrate_dt_dict(item, _INCIDENT_DT_KEYS) for item in raw if isinstance(item, dict)]


def _serialize_incidents(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [ops_base._serialize_dt_dict(item, _INCIDENT_DT_KEYS) for item in rows[:_MAX_INCIDENTS]]


def _read_channel_rows(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_ALERT_CHANNEL_STORE_KEY)
    if not isinstance(raw, list):
        return []
    rows: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        hydrated = ops_base._hydrate_dt_dict(item, _CHANNEL_DT_KEYS)
        try:
            hydrated["kind"] = _normalize_channel_kind(hydrated.get("kind"))
        except HTTPException:
            continue
        hydrated["url"] = str(hydrated.get("url") or "").strip()
        hydrated["enabled"] = bool(hydrated.get("enabled", True))
        hydrated["min_severity"] = _normalize_severity(hydrated.get("min_severity"), default="high")
        hydrated["mention"] = str(hydrated.get("mention") or "").strip() or None
        hydrated["include_digest"] = bool(hydrated.get("include_digest", False))
        try:
            hydrated["digest_min_urgent_count"] = max(0, min(int(hydrated.get("digest_min_urgent_count") or 0), 50))
        except Exception:
            hydrated["digest_min_urgent_count"] = 0
        allowed_modules = set(ops_base._MODULE_LABELS.keys()) | {"digest", "scheduler"}
        hydrated["route_modules"] = _normalize_slug_list(hydrated.get("route_modules"), allowed=allowed_modules)
        hydrated["route_source_kinds"] = _normalize_slug_list(hydrated.get("route_source_kinds"), max_items=16)
        hydrated["route_event_kinds"] = _normalize_slug_list(hydrated.get("route_event_kinds"), max_items=12)
        try:
            hydrated["min_occurrences"] = max(1, min(int(hydrated.get("min_occurrences") or 1), 20))
        except Exception:
            hydrated["min_occurrences"] = 1
        try:
            hydrated["min_age_minutes"] = max(0, min(int(hydrated.get("min_age_minutes") or 0), 10080))
        except Exception:
            hydrated["min_age_minutes"] = 0
        hydrated["message_template"] = _clip_text(hydrated.get("message_template"), max_length=1200)
        hydrated["payload_template"] = _clip_text(hydrated.get("payload_template"), max_length=4000)
        hydrated["signing_secret"] = str(hydrated.get("signing_secret") or "").strip() or None
        hydrated["sign_payload"] = bool(hydrated.get("sign_payload", False) and hydrated.get("signing_secret"))
        header_source = hydrated.get("signature_header") or "X-Scheduler-Signature"
        try:
            hydrated["signature_header"] = _normalize_signature_header(header_source)
        except HTTPException:
            hydrated["signature_header"] = "X-Scheduler-Signature"
        rows.append(hydrated)
    return rows


def _serialize_channels(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [ops_base._serialize_dt_dict(item, _CHANNEL_DT_KEYS) for item in rows]


def _read_delivery_rows(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_ALERT_DELIVERY_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [ops_base._hydrate_dt_dict(item, _DELIVERY_DT_KEYS) for item in raw if isinstance(item, dict)]


def _serialize_deliveries(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [ops_base._serialize_dt_dict(item, _DELIVERY_DT_KEYS) for item in rows[:_MAX_DELIVERIES]]


def _read_audit_rows(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _features(settings_row).get(_AUDIT_STORE_KEY)
    if not isinstance(raw, list):
        return []
    return [ops_base._hydrate_dt_dict(item, _AUDIT_DT_KEYS) for item in raw if isinstance(item, dict)]


def _serialize_audit(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [ops_base._serialize_dt_dict(item, _AUDIT_DT_KEYS) for item in rows[:_MAX_AUDIT]]


def _append_audit_entries(
    db: Session,
    settings_row: TenantSettings,
    entries: list[dict[str, Any]],
) -> TenantSettings:
    rows = _read_audit_rows(settings_row)
    normalized = [entry for entry in entries if isinstance(entry, dict)]
    if not normalized:
        return settings_row
    rows = sorted(
        [*normalized, *rows], key=lambda item: ops_base._as_dt(item.get("created_at")) or datetime.min, reverse=True
    )[:_MAX_AUDIT]
    return _write_supervision_features(db, settings_row, audit=rows)


def _write_supervision_features(
    db: Session,
    settings_row: TenantSettings,
    *,
    policies: dict[str, dict[str, Any]] | None = None,
    incidents: list[dict[str, Any]] | None = None,
    channels: list[dict[str, Any]] | None = None,
    deliveries: list[dict[str, Any]] | None = None,
    audit: list[dict[str, Any]] | None = None,
) -> TenantSettings:
    features = _features(settings_row)
    if policies is not None:
        features[_POLICY_STORE_KEY] = _serialize_policies(policies)
    if incidents is not None:
        features[_INCIDENT_STORE_KEY] = _serialize_incidents(incidents)
    if channels is not None:
        features[_ALERT_CHANNEL_STORE_KEY] = _serialize_channels(channels)
    if deliveries is not None:
        features[_ALERT_DELIVERY_STORE_KEY] = _serialize_deliveries(deliveries)
    if audit is not None:
        features[_AUDIT_STORE_KEY] = _serialize_audit(audit)
    settings_row.features = features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _policy_out(job_key: str, payload: dict[str, Any], *, now: datetime) -> SchedulerPolicyOut:
    spec = _job_specs().get(job_key, {})
    next_retry_at = ops_base._as_dt(payload.get("next_retry_at"))
    return SchedulerPolicyOut(
        key=job_key,
        label=str(spec.get("label") or job_key),
        max_attempts=max(0, int(payload.get("max_attempts") or 0)),
        backoff_minutes=max(5, int(payload.get("backoff_minutes") or 5)),
        pause_after_failures=max(1, int(payload.get("pause_after_failures") or 1)),
        alert_on_error=bool(payload.get("alert_on_error", True)),
        failure_streak=max(0, int(payload.get("failure_streak") or 0)),
        auto_paused=bool(payload.get("auto_paused", False)),
        last_run_status=str(payload.get("last_run_status") or "idle"),
        last_error_at=ops_base._as_dt(payload.get("last_error_at")),
        last_success_at=ops_base._as_dt(payload.get("last_success_at")),
        last_attempt_at=ops_base._as_dt(payload.get("last_attempt_at")),
        next_retry_at=next_retry_at,
        retry_due_now=bool(next_retry_at and next_retry_at <= now),
        note=str(payload.get("note") or "").strip() or None,
    )


def _incident_out(payload: dict[str, Any]) -> SchedulerIncidentOut:
    severity = _normalize_severity(payload.get("severity"), default="medium")
    return SchedulerIncidentOut(
        id=str(payload.get("id") or f"inci_{uuid.uuid4().hex[:10]}"),
        issue_key=str(payload.get("issue_key") or "issue"),
        title=str(payload.get("title") or "Incident"),
        description=str(payload.get("description") or "Signal opérationnel à surveiller."),
        severity=severity,
        severity_label=_severity_label(severity),
        module=str(payload.get("module") or "scheduler"),
        href=str(payload.get("href") or "/app/scheduler"),
        status=str(payload.get("status") or "open"),
        occurrences=max(1, int(payload.get("occurrences") or 1)),
        source_kind=str(payload.get("source_kind") or "scheduler"),
        source_ref=(str(payload.get("source_ref") or "").strip() or None),
        first_seen_at=ops_base._as_dt(payload.get("first_seen_at")),
        last_seen_at=ops_base._as_dt(payload.get("last_seen_at")),
        resolved_at=ops_base._as_dt(payload.get("resolved_at")),
        acknowledged=bool(payload.get("acknowledged")),
        acknowledged_at=ops_base._as_dt(payload.get("acknowledged_at")),
        acknowledged_by_label=(str(payload.get("acknowledged_by_label") or "").strip() or None),
        snoozed_until=ops_base._as_dt(payload.get("snoozed_until")),
        snoozed_reason=(str(payload.get("snoozed_reason") or "").strip() or None),
    )


def _delivery_out(payload: dict[str, Any]) -> SchedulerAlertDeliveryOut:
    status = str(payload.get("status") or "idle").strip().lower() or "idle"
    tone = _tone_for_status(status)
    raw_response_status = payload.get("response_status")
    return SchedulerAlertDeliveryOut(
        id=str(payload.get("id") or f"del_{uuid.uuid4().hex[:10]}"),
        channel_id=str(payload.get("channel_id") or "channel"),
        channel_label=str(payload.get("channel_label") or "Canal"),
        kind=str(payload.get("kind") or "webhook"),
        event_kind=str(payload.get("event_kind") or "scheduler_run"),
        severity=_normalize_severity(payload.get("severity"), default="high"),
        title=str(payload.get("title") or "Alerte scheduler"),
        status=status,
        status_label=_status_label(status),
        tone=tone,
        attempted_at=ops_base._as_dt(payload.get("attempted_at")),
        response_status=(int(raw_response_status) if isinstance(raw_response_status, (int, float, str)) else None),
        error=str(payload.get("error") or "").strip() or None,
        test=bool(payload.get("test")),
    )


def _channel_out(payload: dict[str, Any], deliveries: list[dict[str, Any]]) -> SchedulerAlertChannelOut:
    kind = _normalize_channel_kind(payload.get("kind"))
    scoped = [item for item in deliveries if str(item.get("channel_id") or "") == str(payload.get("id") or "")]
    scoped_sorted = sorted(
        scoped, key=lambda row: ops_base._as_dt(row.get("attempted_at")) or datetime.min, reverse=True
    )
    latest = scoped_sorted[0] if scoped_sorted else None
    latest_digest = next(
        (item for item in scoped_sorted if str(item.get("event_kind") or "").lower() in {"digest", "ops_digest"}), None
    )
    success_count = sum(1 for item in scoped if str(item.get("status") or "").lower() in {"ok", "success"})
    failure_count = sum(1 for item in scoped if str(item.get("status") or "").lower() in {"error", "failed"})
    signing_secret = str(payload.get("signing_secret") or "").strip() or None
    signature_enabled = bool(payload.get("sign_payload") and signing_secret)
    route_modules = _normalize_slug_list(
        payload.get("route_modules"), allowed=set(ops_base._MODULE_LABELS.keys()) | {"digest", "scheduler"}
    )
    route_source_kinds = _normalize_slug_list(payload.get("route_source_kinds"), max_items=16)
    route_event_kinds = _normalize_slug_list(payload.get("route_event_kinds"), max_items=12)
    return SchedulerAlertChannelOut(
        id=str(payload.get("id") or f"chan_{uuid.uuid4().hex[:10]}"),
        kind=kind,
        kind_label="Slack" if kind == "slack" else "Webhook",
        label=str(payload.get("label") or "Canal"),
        masked_url=_mask_url(payload.get("url")),
        enabled=bool(payload.get("enabled", True)),
        min_severity=_normalize_severity(payload.get("min_severity"), default="high"),
        min_severity_label=_severity_label(payload.get("min_severity")),
        mention=str(payload.get("mention") or "").strip() or None,
        include_digest=bool(payload.get("include_digest", False)),
        digest_min_urgent_count=max(0, int(payload.get("digest_min_urgent_count") or 0)),
        route_modules=route_modules,
        route_module_labels=[ops_base._MODULE_LABELS.get(key, key.replace("_", " ").title()) for key in route_modules],
        route_source_kinds=route_source_kinds,
        route_event_kinds=route_event_kinds,
        route_summary=_route_summary(
            route_modules=route_modules, route_source_kinds=route_source_kinds, route_event_kinds=route_event_kinds
        ),
        min_occurrences=max(1, int(payload.get("min_occurrences") or 1)),
        min_age_minutes=max(0, int(payload.get("min_age_minutes") or 0)),
        message_template=_clip_text(payload.get("message_template"), max_length=1200),
        payload_template=_clip_text(payload.get("payload_template"), max_length=4000),
        template_summary=_template_summary(payload),
        signature_enabled=signature_enabled,
        signature_header=_normalize_signature_header(payload.get("signature_header")) if signature_enabled else None,
        has_signing_secret=bool(signing_secret),
        created_at=ops_base._as_dt(payload.get("created_at")),
        updated_at=ops_base._as_dt(payload.get("updated_at")),
        last_test_at=ops_base._as_dt(payload.get("last_test_at")),
        last_delivery_at=ops_base._as_dt(payload.get("last_delivery_at")),
        last_digest_at=(
            ops_base._as_dt(payload.get("last_digest_at"))
            or (ops_base._as_dt(latest_digest.get("attempted_at")) if latest_digest else None)
        ),
        last_status=str(latest.get("status") or "idle") if latest else "idle",
        success_count=success_count,
        failure_count=failure_count,
        last_error=(str(latest.get("error") or "").strip() or None) if latest else None,
    )


def _audit_out(payload: dict[str, Any]) -> SchedulerAuditEntryOut:
    status = str(payload.get("status") or "ok").strip().lower() or "ok"
    tone = _tone_for_status(status)
    return SchedulerAuditEntryOut(
        id=str(payload.get("id") or f"audit_{uuid.uuid4().hex[:10]}"),
        action_kind=str(payload.get("action_kind") or "update"),
        action_label=_audit_action_label(payload.get("action_kind")),
        actor_label=str(payload.get("actor_label") or "").strip() or None,
        target_kind=str(payload.get("target_kind") or "scheduler"),
        target_label=str(payload.get("target_label") or "Scheduler"),
        status=status,
        status_label=_status_label(status)
        if status in {"ok", "warn", "error", "failed"}
        else ("Ignoré" if status == "skipped" else status.title()),
        tone=tone,
        summary=str(payload.get("summary") or "Action supervision"),
        details=str(payload.get("details") or "").strip() or None,
        module=str(payload.get("module") or "scheduler"),
        href=str(payload.get("href") or "/app/scheduler"),
        created_at=ops_base._as_dt(payload.get("created_at")),
    )


def _audit_entry(
    action_kind: str,
    *,
    now: datetime,
    actor_label: str | None = None,
    target_kind: str = "scheduler",
    target_label: str = "Scheduler",
    status: str = "ok",
    summary: str,
    details: str | None = None,
    module: str = "scheduler",
    href: str = "/app/scheduler",
) -> dict[str, Any]:
    return {
        "id": f"audit_{uuid.uuid4().hex[:10]}",
        "action_kind": action_kind,
        "actor_label": actor_label,
        "target_kind": target_kind,
        "target_label": target_label,
        "status": status,
        "summary": summary,
        "details": details,
        "module": module,
        "href": href,
        "created_at": now,
    }


def _issue(
    issue_key: str,
    *,
    title: str,
    description: str,
    severity: str,
    module: str = "scheduler",
    href: str = "/app/scheduler",
    source_kind: str | None = None,
    source_ref: str | None = None,
) -> dict[str, Any]:
    return {
        "issue_key": issue_key,
        "title": title,
        "description": description,
        "severity": _normalize_severity(severity),
        "module": module,
        "href": href,
        "source_kind": source_kind or module,
        "source_ref": source_ref,
    }


def _sync_incident_journal(
    db: Session,
    settings_row: TenantSettings,
    *,
    now: datetime,
    issues: list[dict[str, Any]],
) -> tuple[TenantSettings, list[dict[str, Any]]]:
    rows = _read_incident_rows(settings_row)
    current_keys = {str(item.get("issue_key") or "") for item in issues}
    updated_rows: list[dict[str, Any]] = []
    pending_external: list[dict[str, Any]] = []

    for item in rows:
        key = str(item.get("issue_key") or "")
        item = copy.deepcopy(item)
        snoozed_until = ops_base._as_dt(item.get("snoozed_until"))
        if snoozed_until and snoozed_until <= now:
            item["snoozed_until"] = None
            item["snoozed_reason"] = None
        if str(item.get("status") or "open") == "open" and key not in current_keys:
            item["status"] = "resolved"
            item["resolved_at"] = now
            item["last_seen_at"] = now
        updated_rows.append(item)

    rows = updated_rows
    rows_by_key = {str(item.get("issue_key") or ""): item for item in rows}
    for issue in issues:
        key = str(issue.get("issue_key") or "")
        existing = rows_by_key.get(key)
        if existing is None:
            entry = {
                "id": f"inci_{uuid.uuid4().hex[:10]}",
                "issue_key": key,
                "title": issue["title"],
                "description": issue["description"],
                "severity": issue["severity"],
                "module": issue.get("module") or "scheduler",
                "href": issue.get("href") or "/app/scheduler",
                "status": "open",
                "occurrences": 1,
                "source_kind": issue.get("source_kind"),
                "source_ref": issue.get("source_ref"),
                "first_seen_at": now,
                "last_seen_at": now,
                "resolved_at": None,
                "acknowledged": False,
                "acknowledged_at": None,
                "acknowledged_by_label": None,
                "snoozed_until": None,
                "snoozed_reason": None,
                "last_external_alert_at": None,
                "created_at": now,
                "updated_at": now,
            }
            rows.append(entry)
            rows_by_key[key] = entry
            pending_external.append({**issue, "event_kind": "incident_opened"})
            continue
        existing = copy.deepcopy(existing)
        increment = False
        previous_seen = ops_base._as_dt(existing.get("last_seen_at"))
        if previous_seen is None or previous_seen <= (now - timedelta(minutes=30)):
            increment = True
        previous_status = str(existing.get("status") or "open")
        previous_severity = _normalize_severity(existing.get("severity"), default="medium")
        next_severity = _normalize_severity(issue.get("severity"), default=previous_severity)
        reopened = previous_status != "open"
        escalated = _SEVERITY_RANK[next_severity] > _SEVERITY_RANK[previous_severity]
        if reopened or escalated:
            existing["acknowledged"] = False
            existing["acknowledged_at"] = None
            existing["acknowledged_by_label"] = None
            existing["snoozed_until"] = None
            existing["snoozed_reason"] = None
            existing["last_external_alert_at"] = None
            pending_external.append({**issue, "event_kind": "incident_opened" if reopened else "incident_escalated"})
        existing.update(
            {
                "title": issue["title"],
                "description": issue["description"],
                "severity": next_severity,
                "module": issue.get("module") or existing.get("module") or "scheduler",
                "href": issue.get("href") or existing.get("href") or "/app/scheduler",
                "status": "open",
                "source_kind": issue.get("source_kind") or existing.get("source_kind"),
                "source_ref": issue.get("source_ref") or existing.get("source_ref"),
                "last_seen_at": now,
                "resolved_at": None,
                "updated_at": now,
                "occurrences": max(1, int(existing.get("occurrences") or 1) + (1 if increment else 0)),
            }
        )
        rows = [existing if str(item.get("issue_key") or "") == key else item for item in rows]
        rows_by_key[key] = existing

    rows = sorted(rows, key=lambda item: ops_base._as_dt(item.get("last_seen_at")) or datetime.min, reverse=True)[
        :_MAX_INCIDENTS
    ]
    settings_row = _write_supervision_features(db, settings_row, incidents=rows)
    return settings_row, pending_external


def _current_issues(
    control_board: Any,
    *,
    policies: dict[str, dict[str, Any]],
    deliveries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    heartbeat = control_board.supervision.heartbeat
    lock = control_board.supervision.lock
    runs = control_board.supervision.runs

    if heartbeat.status == "idle":
        issues.append(
            _issue(
                "heartbeat:idle",
                title="Heartbeat absent",
                description="Aucun heartbeat scheduler n’a encore été reçu depuis la console ou un runner.",
                severity="high",
                source_kind="scheduler_heartbeat",
                source_ref="heartbeat",
            )
        )
    elif heartbeat.status in {"warn", "error"}:
        issues.append(
            _issue(
                "heartbeat:stale",
                title="Heartbeat ancien",
                description=f"Le dernier heartbeat scheduler date de {heartbeat.age_minutes or 0} minute(s).",
                severity="critical" if heartbeat.status == "error" else "high",
                source_kind="scheduler_heartbeat",
                source_ref="heartbeat",
            )
        )

    if lock.active and lock.stale:
        issues.append(
            _issue(
                "lock:stale",
                title="Verrou scheduler bloqué",
                description="Le verrou anti-concurrence est resté actif au-delà de sa fenêtre de sécurité.",
                severity="critical",
                source_kind="scheduler_lock",
                source_ref=lock.run_id or "lock",
            )
        )

    if runs.error_count > 0:
        issues.append(
            _issue(
                "runs:error",
                title="Runs scheduler en erreur",
                description=f"{runs.error_count} run(s) orchestrés ont terminé en erreur sur les 7 derniers jours.",
                severity="high",
                source_kind="scheduler_runs",
                source_ref="7d",
            )
        )
    if runs.success_rate < 80:
        issues.append(
            _issue(
                "runs:success-rate",
                title="Taux de réussite en baisse",
                description=f"Le taux de réussite du scheduler est tombé à {runs.success_rate}% sur 7 jours.",
                severity="high",
                source_kind="scheduler_runs",
                source_ref="7d",
            )
        )

    for job in control_board.jobs:
        if str(job.last_status or "").lower() == "error":
            issues.append(
                _issue(
                    f"job:{job.key}:error",
                    title=f"{job.label} en erreur",
                    description=(
                        job.notes[0] if job.notes else "Le dernier run a fini en erreur et mérite un retry surveillé."
                    ),
                    severity="high",
                    href=job.href,
                    source_kind="scheduler_job",
                    source_ref=job.key,
                )
            )
        elif job.stale:
            issues.append(
                _issue(
                    f"job:{job.key}:stale",
                    title=f"{job.label} en retard",
                    description="La cadence du job a dépassé sa fenêtre normale et doit être relancée.",
                    severity="medium",
                    href=job.href,
                    source_kind="scheduler_job",
                    source_ref=job.key,
                )
            )

    for key, row in policies.items():
        failure_streak = int(row.get("failure_streak") or 0)
        next_retry_at = ops_base._as_dt(row.get("next_retry_at"))
        if failure_streak > 0:
            issues.append(
                _issue(
                    f"policy:{key}:retry",
                    title=f"Retry en attente · {_job_specs().get(key, {}).get('label', key)}",
                    description=(
                        f"{failure_streak} échec(s) consécutif(s) · prochain retry {next_retry_at.strftime('%d/%m %H:%M')}."
                        if next_retry_at
                        else f"{failure_streak} échec(s) consécutif(s) sans nouveau retry planifié."
                    ),
                    severity="high" if failure_streak >= int(row.get("pause_after_failures") or 3) else "medium",
                    href=str(_job_specs().get(key, {}).get("href") or "/app/scheduler"),
                    source_kind="scheduler_policy",
                    source_ref=key,
                )
            )

    recent_failed_deliveries = [
        item
        for item in deliveries
        if str(item.get("status") or "").lower() in {"error", "failed"}
        and (ops_base._as_dt(item.get("attempted_at")) or datetime.min)
        >= (datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1))
    ]
    failure_by_channel: dict[str, dict[str, Any]] = {}
    for item in recent_failed_deliveries:
        failure_by_channel[str(item.get("channel_id") or "channel")] = item
    for channel_id, item in failure_by_channel.items():
        issues.append(
            _issue(
                f"alert-channel:{channel_id}:failed",
                title=f"Canal externe en échec · {item.get('channel_label') or 'Canal'}",
                description=str(
                    item.get("error") or f"Dernier envoi externe échoué ({item.get('response_status') or 'sans code'})."
                ),
                severity="high",
                href="/app/scheduler",
                source_kind="alert_channel",
                source_ref=channel_id,
            )
        )
    return issues


def _send_channel_payload(
    channel: dict[str, Any],
    *,
    event_kind: str,
    severity: str,
    title: str,
    message: str,
    payload: dict[str, Any],
    now: datetime,
    test: bool = False,
) -> dict[str, Any]:
    try:
        url = parse_and_validate_outbound_url(str(channel.get("url") or "").strip())
    except ValueError:
        return {
            "id": f"adel_{uuid.uuid4().hex[:10]}",
            "channel_id": str(channel.get("id") or "channel"),
            "channel_label": str(channel.get("label") or "Canal"),
            "kind": _normalize_channel_kind(channel.get("kind")),
            "event_kind": event_kind,
            "severity": _normalize_severity(severity),
            "title": title,
            "status": "failed",
            "response_status": None,
            "error": "L’adresse du canal externe n’est pas autorisée.",
            "error_code": "outbound_url_not_allowed",
            "attempted_at": now,
            "generated_at": now,
            "test": bool(test),
        }
    kind = _normalize_channel_kind(channel.get("kind"))
    delivery: dict[str, Any] = {
        "id": f"adel_{uuid.uuid4().hex[:10]}",
        "channel_id": str(channel.get("id") or "channel"),
        "channel_label": str(channel.get("label") or "Canal"),
        "kind": kind,
        "event_kind": event_kind,
        "severity": _normalize_severity(severity),
        "title": title,
        "status": "idle",
        "response_status": None,
        "error": None,
        "error_code": None,
        "attempted_at": now,
        "generated_at": now,
        "test": bool(test),
    }
    try:
        body, rendered_message, _ = _render_alert_body(
            channel,
            event_kind=event_kind,
            severity=severity,
            title=title,
            message=message,
            payload=payload,
            now=now,
            test=test,
        )
        if kind == "slack" and isinstance(body, dict):
            delivery["title"] = _compact_text(body.get("text") or title, max_length=140) or str(title)
        elif rendered_message:
            delivery["title"] = _compact_text(rendered_message, max_length=140) or str(title)
        body_bytes = _payload_bytes(body)
        headers = _signature_headers(channel, event_kind=event_kind, payload_bytes=body_bytes, now=now, test=test)
        response = httpx.post(url, json=body, headers=headers or None, timeout=5.0)
        delivery["response_status"] = int(response.status_code)
        if 200 <= int(response.status_code) < 300:
            delivery["status"] = "ok"
        else:
            delivery["status"] = "error"
            delivery["error"] = "Le canal externe a refusé l’envoi."
            delivery["error_code"] = "remote_http_error"
    except Exception:  # pragma: no cover - dépend du réseau externe
        logger.exception("external_alert_delivery_failed", extra={"channel_id": delivery["channel_id"]})
        delivery["status"] = "error"
        delivery["error"] = "Le canal externe est temporairement injoignable."
        delivery["error_code"] = "external_channel_unavailable"
    return delivery


def _channel_matches_route(
    channel: dict[str, Any], *, event_kind: str, payload: dict[str, Any], digest_mode: bool = False
) -> bool:
    allowed_modules = set(ops_base._MODULE_LABELS.keys()) | {"digest", "scheduler"}
    route_event_kinds = _normalize_slug_list(channel.get("route_event_kinds"), max_items=12)
    route_modules = _normalize_slug_list(channel.get("route_modules"), allowed=allowed_modules)
    route_source_kinds = _normalize_slug_list(channel.get("route_source_kinds"), max_items=16)

    normalized_event = _normalize_slug_list([event_kind], max_items=1)
    current_event = normalized_event[0] if normalized_event else str(event_kind or "scheduler_run").strip().lower()
    payload_module_candidates = _normalize_slug_list([payload.get("module")], allowed=allowed_modules, max_items=1)
    payload_module = (
        payload_module_candidates[0] if payload_module_candidates else ("digest" if digest_mode else "scheduler")
    )
    source_candidates = _normalize_slug_list(
        [
            payload.get("source_kind"),
            payload.get("incident_type"),
            payload.get("event"),
        ],
        max_items=6,
    )

    if route_event_kinds and current_event not in route_event_kinds:
        return False
    if route_modules and payload_module not in route_modules:
        return False
    if route_source_kinds and not any(candidate in route_source_kinds for candidate in source_candidates):
        return False
    try:
        min_occurrences = max(1, min(int(channel.get("min_occurrences") or 1), 20))
    except Exception:
        min_occurrences = 1
    try:
        min_age_minutes = max(0, min(int(channel.get("min_age_minutes") or 0), 10080))
    except Exception:
        min_age_minutes = 0
    try:
        current_occurrences = max(1, int(payload.get("occurrences") or 1))
    except Exception:
        current_occurrences = 1
    try:
        current_age_minutes = max(0, int(payload.get("age_minutes") or 0))
    except Exception:
        current_age_minutes = 0
    if min_occurrences > 1 and current_occurrences < min_occurrences:
        return False
    if min_age_minutes > 0 and current_age_minutes < min_age_minutes:
        return False
    return True


def _dispatch_alert_channels(
    db: Session,
    settings_row: TenantSettings,
    *,
    event_kind: str,
    severity: str,
    title: str,
    message: str,
    payload: dict[str, Any],
    now: datetime,
    test_channel_id: str | None = None,
    digest_mode: bool = False,
    digest_urgent_count: int | None = None,
) -> tuple[TenantSettings, list[dict[str, Any]]]:
    tenant = db.get(Tenant, settings_row.tenant_id)
    if not is_product_feature_enabled(tenant, "payments_enabled"):
        return settings_row, []
    channels = _read_channel_rows(settings_row)
    deliveries = _read_delivery_rows(settings_row)
    created: list[dict[str, Any]] = []
    audit_rows: list[dict[str, Any]] = []
    for channel in channels:
        if test_channel_id and str(channel.get("id") or "") != test_channel_id:
            continue
        if not test_channel_id and not bool(channel.get("enabled", True)):
            continue
        if digest_mode and not test_channel_id:
            if not bool(channel.get("include_digest", False)):
                continue
            if int(digest_urgent_count or 0) < int(channel.get("digest_min_urgent_count") or 0):
                continue
        min_severity = _normalize_severity(channel.get("min_severity"), default="high")
        if (
            not test_channel_id
            and not digest_mode
            and _SEVERITY_RANK[_normalize_severity(severity)] < _SEVERITY_RANK[min_severity]
        ):
            continue
        if not test_channel_id and not _channel_matches_route(
            channel, event_kind=event_kind, payload=payload, digest_mode=digest_mode
        ):
            continue
        delivery = _send_channel_payload(
            channel,
            event_kind=event_kind,
            severity=severity,
            title=title,
            message=message,
            payload=payload,
            now=now,
            test=bool(test_channel_id),
        )
        created.append(delivery)
        channel["updated_at"] = now
        if test_channel_id:
            channel["last_test_at"] = now
        else:
            channel["last_delivery_at"] = now
            if digest_mode:
                channel["last_digest_at"] = now
        action_kind = (
            "channel_test"
            if test_channel_id
            else (
                "incident_delivery" if event_kind in {"incident_opened", "incident_escalated"} else "external_delivery"
            )
        )
        audit_rows.append(
            _audit_entry(
                action_kind,
                now=now,
                actor_label="Scheduler",
                target_kind="alert_channel",
                target_label=str(channel.get("label") or "Canal"),
                status=str(delivery.get("status") or "ok"),
                summary=f"{title} → {channel.get('label') or 'Canal'}",
                details=(
                    str(delivery.get("error") or f"{event_kind} · HTTP {delivery.get('response_status') or '200'}")[
                        :220
                    ]
                ),
                module="scheduler",
                href="/app/scheduler",
            )
        )
    if created:
        deliveries = sorted(
            [*created, *deliveries],
            key=lambda item: ops_base._as_dt(item.get("attempted_at")) or datetime.min,
            reverse=True,
        )[:_MAX_DELIVERIES]
        settings_row = _write_supervision_features(db, settings_row, channels=channels, deliveries=deliveries)
    if audit_rows:
        settings_row = _append_audit_entries(db, settings_row, audit_rows)
    return settings_row, created


def _dispatch_incident_alerts(
    db: Session,
    settings_row: TenantSettings,
    *,
    issues: list[dict[str, Any]],
    now: datetime,
) -> TenantSettings:
    if not issues:
        return settings_row
    incident_rows = _read_incident_rows(settings_row)
    incident_index = {str(item.get("issue_key") or ""): item for item in incident_rows}
    touched = False
    for issue in issues[:12]:
        event_kind = str(issue.get("event_kind") or "incident_opened")
        stored = incident_index.get(str(issue.get("issue_key") or ""), {})
        first_seen_at = ops_base._as_dt(stored.get("first_seen_at"))
        age_minutes = max(0, int((now - first_seen_at).total_seconds() // 60)) if first_seen_at else 0
        occurrences = max(1, int(stored.get("occurrences") or issue.get("occurrences") or 1))
        payload = {
            "event": "scheduler_incident",
            "module": str(issue.get("module") or "scheduler"),
            "source_kind": str(issue.get("source_kind") or "scheduler_incident"),
            "incident_type": str(issue.get("source_kind") or "scheduler_incident"),
            "issue_key": str(issue.get("issue_key") or "issue"),
            "href": str(issue.get("href") or "/app/scheduler"),
            "title": str(issue.get("title") or "Incident scheduler"),
            "description": str(issue.get("description") or "Signal supervision"),
            "occurrences": occurrences,
            "age_minutes": age_minutes,
            "first_seen_at": first_seen_at.isoformat() if first_seen_at else None,
            "generated_at": now.isoformat(),
        }
        message = f"{payload['title']} · {payload['description']}"
        settings_row, created = _dispatch_alert_channels(
            db,
            settings_row,
            event_kind=event_kind,
            severity=str(issue.get("severity") or "high"),
            title=str(issue.get("title") or "Incident scheduler"),
            message=message,
            payload=payload,
            now=now,
        )
        if created:
            touched = True
            for row in incident_rows:
                if str(row.get("issue_key") or "") == payload["issue_key"]:
                    row["last_external_alert_at"] = now
                    row["updated_at"] = now
    if touched:
        settings_row = _write_supervision_features(db, settings_row, incidents=incident_rows)
    return settings_row


def dispatch_digest_to_channels(
    db: Session,
    settings_row: TenantSettings,
    *,
    digest_payload: Any,
    now: datetime,
) -> tuple[TenantSettings, list[dict[str, Any]]]:
    sections_payload: list[dict[str, Any]] = []
    for section in list(getattr(digest_payload, "sections", []) or [])[:4]:
        items_payload: list[dict[str, Any]] = []
        for item in list(getattr(section, "items", []) or [])[:3]:
            items_payload.append(
                {
                    "title": str(getattr(item, "title", "Signal")),
                    "href": str(getattr(item, "href", "/app/dashboard")),
                    "severity": str(getattr(item, "severity", "medium")),
                    "amount": (str(getattr(item, "amount", "")) if getattr(item, "amount", None) is not None else None),
                    "age_days": getattr(item, "age_days", None),
                }
            )
        sections_payload.append(
            {
                "key": str(getattr(section, "key", "section")),
                "title": str(getattr(section, "title", "Section")),
                "count": int(getattr(section, "count", 0) or 0),
                "items": items_payload,
            }
        )
    urgent_count = int(getattr(getattr(digest_payload, "summary", None), "urgent_count", 0) or 0)
    total_items = sum(
        int(getattr(section, "count", 0) or 0) for section in list(getattr(digest_payload, "sections", []) or [])
    )
    matched_rules_count = int(getattr(getattr(digest_payload, "summary", None), "matched_rules_count", 0) or 0)
    message = f"{str(getattr(digest_payload, 'headline', 'Digest opérateur'))} · {urgent_count} urgence(s) · {total_items} signal(aux) · {matched_rules_count} règle(s) matchée(s)."
    payload = {
        "event": "ops_digest",
        "module": "digest",
        "source_kind": "ops_digest",
        "incident_type": "ops_digest",
        "headline": str(getattr(digest_payload, "headline", "Digest opérateur")),
        "summary": {
            "urgent_count": urgent_count,
            "matched_rules_count": matched_rules_count,
            "matched_items_count": int(
                getattr(getattr(digest_payload, "summary", None), "matched_items_count", 0) or 0
            ),
            "recommended_focus": getattr(getattr(digest_payload, "summary", None), "recommended_focus", None),
        },
        "sections": sections_payload,
        "generated_at": now.isoformat(),
    }
    return _dispatch_alert_channels(
        db,
        settings_row,
        event_kind="ops_digest",
        severity="high" if urgent_count > 0 else "medium",
        title="Digest opérateur externe",
        message=message,
        payload=payload,
        now=now,
        digest_mode=True,
        digest_urgent_count=urgent_count,
    )


def record_scheduler_run_feedback(
    db: Session,
    settings_row: TenantSettings,
    *,
    run: Any,
    now: datetime,
) -> TenantSettings:
    policies = _read_policies(settings_row)
    controls_written = False

    for job in list(getattr(run, "jobs", []) or []):
        key = str(getattr(job, "key", "") or "").strip()
        if key not in policies:
            continue
        row = copy.deepcopy(policies[key])
        row["last_attempt_at"] = now
        row["last_run_status"] = str(getattr(job, "status", "idle") or "idle").strip().lower() or "idle"
        if row["last_run_status"] == "ok":
            row["failure_streak"] = 0
            row["last_success_at"] = now
            row["next_retry_at"] = None
            row["auto_paused"] = False
        elif row["last_run_status"] == "error":
            row["failure_streak"] = max(0, int(row.get("failure_streak") or 0)) + 1
            row["last_error_at"] = now
            if int(row.get("failure_streak") or 0) <= int(row.get("max_attempts") or 0):
                row["next_retry_at"] = now + timedelta(minutes=int(row.get("backoff_minutes") or 30))
            else:
                row["next_retry_at"] = None
            if int(row.get("failure_streak") or 0) >= int(row.get("pause_after_failures") or 3):
                row["auto_paused"] = True
                try:
                    from . import ops_scheduler as scheduler_base

                    controls = scheduler_base._read_controls(settings_row)
                    if key in controls and bool(controls[key].get("active", True)):
                        controls[key]["active"] = False
                        settings_row = scheduler_base._write_engine_features(db, settings_row, controls=controls)
                        controls_written = True
                except Exception:
                    pass
        row["updated_at"] = now
        policies[key] = row

    if not controls_written:
        settings_row = _write_supervision_features(db, settings_row, policies=policies)
    else:
        settings_row = _write_supervision_features(db, settings_row, policies=policies)

    run_status = str(getattr(run, "status", "ok") or "ok").lower()
    if run_status in {"warn", "error"}:
        jobs = []
        for job in list(getattr(run, "jobs", []) or []):
            jobs.append(
                {
                    "key": str(getattr(job, "key", "") or ""),
                    "status": str(getattr(job, "status", "") or ""),
                    "processed_count": int(getattr(job, "processed_count", 0) or 0),
                    "created_count": int(getattr(job, "created_count", 0) or 0),
                    "blocked_count": int(getattr(job, "blocked_count", 0) or 0),
                }
            )
        severity = "critical" if run_status == "error" else "high"
        title = "Run scheduler en erreur" if run_status == "error" else "Run scheduler à surveiller"
        message = f"{len(jobs)} job(s) ont tourné · statut global {run_status}."
        payload = {
            "event": "scheduler_run",
            "module": "scheduler",
            "source_kind": "scheduler_run",
            "incident_type": "scheduler_run",
            "severity": severity,
            "title": title,
            "message": message,
            "run_id": str(getattr(run, "id", "") or ""),
            "job_keys": [item["key"] for item in jobs if item["key"]],
            "jobs": jobs,
            "generated_at": now.isoformat(),
        }
        settings_row, _ = _dispatch_alert_channels(
            db,
            settings_row,
            event_kind="scheduler_run",
            severity=severity,
            title=title,
            message=message,
            payload=payload,
            now=now,
        )
    return settings_row


def _board_payload(
    db: Session,
    user: AuthUser,
    *,
    settings_row: TenantSettings | None = None,
    now: datetime | None = None,
    persist: bool = True,
) -> tuple[TenantSettings, SchedulerSupervisionBoardOut]:
    from . import ops_scheduler as scheduler_base

    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = settings_row or ops_base._ensure_settings(db, user.tenant_id)
    _, control_board = scheduler_base._control_payload(db, user, settings_row=settings_row, now=now)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)

    policies = _read_policies(settings_row)
    policy_items = [_policy_out(key, row, now=now) for key, row in policies.items()]

    deliveries = _read_delivery_rows(settings_row)
    current_issues = _current_issues(control_board, policies=policies, deliveries=deliveries)
    if persist:
        settings_row, pending_external = _sync_incident_journal(db, settings_row, now=now, issues=current_issues)
        if pending_external:
            settings_row = _dispatch_incident_alerts(db, settings_row, issues=pending_external, now=now)
        settings_row = ops_base._ensure_settings(db, user.tenant_id)
        deliveries = _read_delivery_rows(settings_row)
    incident_items = [_incident_out(item) for item in _read_incident_rows(settings_row)]
    incident_items = sorted(incident_items, key=lambda item: item.last_seen_at or datetime.min, reverse=True)

    delivery_items = [_delivery_out(item) for item in deliveries]
    delivery_items = sorted(delivery_items, key=lambda item: item.attempted_at or datetime.min, reverse=True)
    channel_items = [_channel_out(item, deliveries) for item in _read_channel_rows(settings_row)]
    audit_items = [_audit_out(item) for item in _read_audit_rows(settings_row)]
    audit_items = sorted(audit_items, key=lambda item: item.created_at or datetime.min, reverse=True)

    incident_summary = SchedulerIncidentSummaryOut(
        total_count=len(incident_items),
        open_count=sum(1 for item in incident_items if item.status == "open"),
        critical_open_count=sum(1 for item in incident_items if item.status == "open" and item.severity == "critical"),
        high_open_count=sum(1 for item in incident_items if item.status == "open" and item.severity == "high"),
        acknowledged_count=sum(1 for item in incident_items if item.status == "open" and item.acknowledged),
        snoozed_count=sum(
            1 for item in incident_items if item.status == "open" and item.snoozed_until and item.snoozed_until > now
        ),
        resolved_recent_count=sum(
            1
            for item in incident_items
            if item.status == "resolved" and (item.resolved_at or datetime.min) >= (now - timedelta(days=7))
        ),
    )
    policy_summary = SchedulerPolicySummaryOut(
        total_jobs=len(policy_items),
        failing_jobs_count=sum(1 for item in policy_items if item.failure_streak > 0),
        retry_due_count=sum(1 for item in policy_items if item.retry_due_now),
        auto_paused_count=sum(1 for item in policy_items if item.auto_paused),
        alerting_jobs_count=sum(1 for item in policy_items if item.alert_on_error),
    )
    alert_summary = SchedulerAlertSummaryOut(
        total_channels=len(channel_items),
        enabled_channels=sum(1 for item in channel_items if item.enabled),
        failing_channels=sum(1 for item in channel_items if item.failure_count > 0),
        digest_enabled_channels=sum(1 for item in channel_items if item.enabled and item.include_digest),
        success_24h_count=sum(
            1
            for item in delivery_items
            if item.status == "ok" and (item.attempted_at or datetime.min) >= (now - timedelta(days=1))
        ),
        failure_24h_count=sum(
            1
            for item in delivery_items
            if item.status == "error" and (item.attempted_at or datetime.min) >= (now - timedelta(days=1))
        ),
        digest_delivery_24h_count=sum(
            1
            for item in delivery_items
            if item.status == "ok"
            and item.event_kind in {"digest", "ops_digest"}
            and (item.attempted_at or datetime.min) >= (now - timedelta(days=1))
        ),
        last_delivery_at=(delivery_items[0].attempted_at if delivery_items else None),
    )

    audit_summary = SchedulerAuditSummaryOut(
        total_count=len(audit_items),
        filtered_count=min(len(audit_items), 18),
        actions_24h_count=sum(
            1 for item in audit_items if (item.created_at or datetime.min) >= (now - timedelta(days=1))
        ),
        delivery_failures_7d_count=sum(
            1
            for item in audit_items
            if item.status == "error"
            and item.action_kind in {"external_delivery", "incident_delivery", "channel_test"}
            and (item.created_at or datetime.min) >= (now - timedelta(days=7))
        ),
        external_dispatch_24h_count=sum(
            1
            for item in audit_items
            if item.action_kind in {"external_delivery", "incident_delivery", "channel_test"}
            and (item.created_at or datetime.min) >= (now - timedelta(days=1))
        ),
        incident_actions_7d_count=sum(
            1
            for item in audit_items
            if item.action_kind.startswith("incident_")
            and (item.created_at or datetime.min) >= (now - timedelta(days=7))
        ),
    )

    return settings_row, SchedulerSupervisionBoardOut(
        policy_summary=policy_summary,
        policies=policy_items,
        incident_summary=incident_summary,
        incidents=incident_items[:20],
        alert_summary=alert_summary,
        channels=channel_items,
        recent_deliveries=delivery_items[:12],
        audit_summary=audit_summary,
        audit_trail=audit_items[:18],
        generated_at=now,
    )


@router.get("/scheduler/supervision", response_model=SchedulerSupervisionBoardOut)
def scheduler_supervision_board(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    _, board = _board_payload(db, user, persist=True)
    return board


@router.get("/scheduler/audit", response_model=SchedulerAuditListOut)
def scheduler_audit_list(
    query: str | None = Query(default=None, max_length=120),
    action_kind: str | None = Query(default=None, max_length=40),
    status: str | None = Query(default=None, max_length=20),
    module: str | None = Query(default=None, max_length=40),
    days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=60, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    items = [_audit_out(item) for item in _read_audit_rows(settings_row)]
    items = sorted(items, key=lambda item: item.created_at or datetime.min, reverse=True)
    filtered = _filter_audit_items(
        items, query=query, action_kind=action_kind, status=status, module=module, days=days, limit=limit
    )
    summary = _audit_summary_for_items(filtered, now=now, total_count=len(items))
    return SchedulerAuditListOut(
        summary=summary,
        items=filtered,
        total_count=len(items),
        filtered_count=len(filtered),
        query=str(query or "").strip() or None,
        action_kind=str(action_kind or "").strip().lower() or None,
        status=str(status or "").strip().lower() or None,
        module=str(module or "").strip().lower() or None,
        days=max(1, min(int(days or 30), 365)),
    )


@router.get("/scheduler/audit/export")
def export_scheduler_audit(
    format: str = Query(default="csv", pattern="^(csv|json)$"),
    query: str | None = Query(default=None, max_length=120),
    action_kind: str | None = Query(default=None, max_length=40),
    status: str | None = Query(default=None, max_length=20),
    module: str | None = Query(default=None, max_length=40),
    days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    items = [_audit_out(item) for item in _read_audit_rows(settings_row)]
    items = sorted(items, key=lambda item: item.created_at or datetime.min, reverse=True)
    filtered = _filter_audit_items(
        items, query=query, action_kind=action_kind, status=status, module=module, days=days, limit=limit
    )
    safe_stamp = now.strftime("%Y%m%d_%H%M")
    if format == "json":
        payload = {
            "generated_at": now.isoformat(),
            "filters": {
                "query": str(query or "").strip() or None,
                "action_kind": str(action_kind or "").strip().lower() or None,
                "status": str(status or "").strip().lower() or None,
                "module": str(module or "").strip().lower() or None,
                "days": max(1, min(int(days or 30), 365)),
            },
            "summary": _audit_summary_for_items(filtered, now=now, total_count=len(items)).model_dump(mode="json"),
            "items": [item.model_dump(mode="json") for item in filtered],
        }
        return JSONResponse(
            content=payload,
            headers={"Content-Disposition": f'attachment; filename="scheduler_audit_{safe_stamp}.json"'},
        )
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "created_at",
            "status",
            "action_kind",
            "action_label",
            "actor_label",
            "target_kind",
            "target_label",
            "module",
            "summary",
            "details",
            "href",
        ]
    )
    for item in filtered:
        writer.writerow(
            [
                item.created_at.isoformat() if item.created_at else "",
                item.status,
                item.action_kind,
                item.action_label,
                item.actor_label or "",
                item.target_kind,
                item.target_label,
                item.module,
                item.summary,
                item.details or "",
                item.href,
            ]
        )
    return PlainTextResponse(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="scheduler_audit_{safe_stamp}.csv"'},
    )


@router.patch("/scheduler/policies/{job_key}", response_model=SchedulerPolicyOut)
def update_scheduler_policy(
    job_key: str,
    payload: SchedulerPolicyPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    key = str(job_key or "").strip().lower()
    if key not in _job_specs():
        raise HTTPException(404, "Job scheduler introuvable.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    policies = _read_policies(settings_row)
    row = copy.deepcopy(policies[key])
    if payload.max_attempts is not None:
        row["max_attempts"] = int(payload.max_attempts)
    if payload.backoff_minutes is not None:
        row["backoff_minutes"] = int(payload.backoff_minutes)
    if payload.pause_after_failures is not None:
        row["pause_after_failures"] = int(payload.pause_after_failures)
    if payload.alert_on_error is not None:
        row["alert_on_error"] = bool(payload.alert_on_error)
    if payload.note is not None:
        row["note"] = str(payload.note or "").strip() or None
    row["updated_at"] = now
    policies[key] = row
    settings_row = _write_supervision_features(db, settings_row, policies=policies)
    actor_label = str(getattr(user, "email", None) or getattr(user, "user_id", None) or "Opérateur")
    settings_row = _append_audit_entries(
        db,
        settings_row,
        [
            _audit_entry(
                "policy_update",
                now=now,
                actor_label=actor_label,
                target_kind="scheduler_job",
                target_label=str(_job_specs().get(key, {}).get("label") or key),
                summary=f"Politique retry mise à jour · {str(_job_specs().get(key, {}).get('label') or key)}",
                details=f"{row['max_attempts']} retry max · backoff {row['backoff_minutes']} min · pause après {row['pause_after_failures']} échec(s).",
                module="scheduler",
                href="/app/scheduler",
            )
        ],
    )
    return _policy_out(key, policies[key], now=now)


@router.patch("/scheduler/incidents/{incident_id}", response_model=SchedulerIncidentMutationOut)
def update_scheduler_incident(
    incident_id: str,
    payload: SchedulerIncidentPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    incidents = _read_incident_rows(settings_row)
    actor_label = str(getattr(user, "email", None) or getattr(user, "user_id", None) or "Opérateur")
    base_row = next((row for row in incidents if str(row.get("id") or "") == incident_id), None)
    if base_row is None:
        raise HTTPException(404, "Incident scheduler introuvable.")
    scope = _normalize_incident_scope(payload.scope)

    def matches_scope(row: dict[str, Any]) -> bool:
        if str(row.get("status") or "open") != "open":
            return False
        if scope == "single":
            return str(row.get("id") or "") == incident_id
        if scope == "same_severity":
            return _normalize_severity(row.get("severity"), default="medium") == _normalize_severity(
                base_row.get("severity"), default="medium"
            )
        if scope == "same_module":
            return str(row.get("module") or "scheduler") == str(base_row.get("module") or "scheduler")
        return True

    applied_count = 0
    updated: dict[str, Any] | None = None
    next_rows: list[dict[str, Any]] = []
    for row in incidents:
        if not matches_scope(row):
            next_rows.append(row)
            continue
        row = copy.deepcopy(row)
        applied_count += 1
        if payload.acknowledged is not None:
            row["acknowledged"] = bool(payload.acknowledged)
            row["acknowledged_at"] = now if row["acknowledged"] else None
            row["acknowledged_by_label"] = actor_label if row["acknowledged"] else None
        if payload.clear_snooze:
            row["snoozed_until"] = None
            row["snoozed_reason"] = None
        elif payload.snooze_hours is not None:
            row["snoozed_until"] = now + timedelta(hours=int(payload.snooze_hours))
            row["snoozed_reason"] = str(payload.snooze_reason or row.get("snoozed_reason") or "").strip() or None
            row["acknowledged"] = True
            row["acknowledged_at"] = row.get("acknowledged_at") or now
            row["acknowledged_by_label"] = row.get("acknowledged_by_label") or actor_label
        elif payload.snooze_reason is not None and row.get("snoozed_until"):
            row["snoozed_reason"] = str(payload.snooze_reason or "").strip() or None
        row["updated_at"] = now
        if str(row.get("id") or "") == incident_id:
            updated = row
        next_rows.append(row)
    if updated is None:
        raise HTTPException(404, "Incident scheduler introuvable.")
    settings_row = _write_supervision_features(db, settings_row, incidents=next_rows)
    action_kind = (
        "incident_snooze"
        if payload.snooze_hours is not None
        else "incident_unsnooze"
        if payload.clear_snooze
        else "incident_ack"
        if bool(payload.acknowledged)
        else "incident_unack"
    )
    scope_label = {
        "single": "incident",
        "same_severity": "même gravité",
        "same_module": "même module",
        "all_open": "tous ouverts",
    }.get(scope, scope)
    details_parts = [f"Portée: {scope_label}", f"{applied_count} signal(aux) impacté(s)"]
    reason = str(payload.action_reason or payload.snooze_reason or "").strip()
    if reason:
        details_parts.append(reason)
    settings_row = _append_audit_entries(
        db,
        settings_row,
        [
            _audit_entry(
                action_kind,
                now=now,
                actor_label=actor_label,
                target_kind="incident",
                target_label=str(updated.get("title") or "Incident"),
                summary=f"{_audit_action_label(action_kind)} · {updated.get('title') or 'Incident'}",
                details=" · ".join(details_parts),
                module="scheduler",
                href=str(updated.get("href") or "/app/scheduler"),
            )
        ],
    )
    return SchedulerIncidentMutationOut(
        incident=_incident_out(updated), applied_count=max(1, applied_count), scope=scope
    )


@router.post("/scheduler/alert-channels", response_model=SchedulerAlertChannelOut)
def create_scheduler_alert_channel(
    payload: SchedulerAlertChannelCreateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    channels = _read_channel_rows(settings_row)
    kind = _normalize_channel_kind(payload.kind)
    signing_secret = str(payload.signing_secret or "").strip() or None
    sign_payload = bool(payload.sign_payload and signing_secret and kind == "webhook")
    if bool(payload.sign_payload) and kind == "webhook" and not signing_secret:
        raise HTTPException(400, "Ajoute un secret avant d'activer la signature webhook.")
    route_modules = _normalize_slug_list(
        payload.route_modules, allowed=set(ops_base._MODULE_LABELS.keys()) | {"digest", "scheduler"}
    )
    route_source_kinds = _normalize_slug_list(payload.route_source_kinds, max_items=16)
    route_event_kinds = _normalize_slug_list(payload.route_event_kinds, max_items=12)
    row = {
        "id": f"sac_{uuid.uuid4().hex[:10]}",
        "kind": kind,
        "label": str(payload.label).strip()[:120],
        "url": _validate_channel_url(payload.url),
        "min_severity": _normalize_severity(payload.min_severity, default="high"),
        "mention": str(payload.mention or "").strip() or None,
        "enabled": bool(payload.enabled),
        "include_digest": bool(payload.include_digest),
        "digest_min_urgent_count": max(0, min(int(payload.digest_min_urgent_count or 0), 50)),
        "route_modules": route_modules,
        "route_source_kinds": route_source_kinds,
        "route_event_kinds": route_event_kinds,
        "min_occurrences": max(1, min(int(payload.min_occurrences or 1), 20)),
        "min_age_minutes": max(0, min(int(payload.min_age_minutes or 0), 10080)),
        "message_template": _clip_text(payload.message_template, max_length=1200),
        "payload_template": _clip_text(payload.payload_template, max_length=4000),
        "sign_payload": sign_payload,
        "signature_header": _normalize_signature_header(payload.signature_header or "X-Scheduler-Signature"),
        "signing_secret": signing_secret,
        "created_at": now,
        "updated_at": now,
        "last_test_at": None,
        "last_delivery_at": None,
        "last_digest_at": None,
    }
    row_label = str(row["label"])
    channels.insert(0, row)
    settings_row = _write_supervision_features(db, settings_row, channels=channels)
    actor_label = str(getattr(user, "email", None) or getattr(user, "user_id", None) or "Opérateur")
    settings_row = _append_audit_entries(
        db,
        settings_row,
        [
            _audit_entry(
                "channel_create",
                now=now,
                actor_label=actor_label,
                target_kind="alert_channel",
                target_label=row_label,
                summary=f"Canal externe ajouté · {row_label}",
                details=f"{_route_summary(route_modules=route_modules, route_source_kinds=route_source_kinds, route_event_kinds=route_event_kinds)} · {_template_summary(row)}",
                module="scheduler",
                href="/app/scheduler",
            )
        ],
    )
    return _channel_out(row, _read_delivery_rows(settings_row))


@router.patch("/scheduler/alert-channels/{channel_id}", response_model=SchedulerAlertChannelOut)
def update_scheduler_alert_channel(
    channel_id: str,
    payload: SchedulerAlertChannelPatchRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    channels = _read_channel_rows(settings_row)
    updated: dict[str, Any] | None = None
    next_rows: list[dict[str, Any]] = []
    for row in channels:
        if str(row.get("id") or "") != channel_id:
            next_rows.append(row)
            continue
        row = copy.deepcopy(row)
        if payload.label is not None:
            row["label"] = str(payload.label).strip()[:120]
        if payload.url is not None:
            row["url"] = _validate_channel_url(payload.url)
        if payload.min_severity is not None:
            row["min_severity"] = _normalize_severity(payload.min_severity, default="high")
        if payload.mention is not None:
            row["mention"] = str(payload.mention or "").strip() or None
        if payload.enabled is not None:
            row["enabled"] = bool(payload.enabled)
        if payload.include_digest is not None:
            row["include_digest"] = bool(payload.include_digest)
        if payload.digest_min_urgent_count is not None:
            row["digest_min_urgent_count"] = max(0, min(int(payload.digest_min_urgent_count or 0), 50))
        if payload.route_modules is not None:
            row["route_modules"] = _normalize_slug_list(
                payload.route_modules, allowed=set(ops_base._MODULE_LABELS.keys()) | {"digest", "scheduler"}
            )
        if payload.route_source_kinds is not None:
            row["route_source_kinds"] = _normalize_slug_list(payload.route_source_kinds, max_items=16)
        if payload.route_event_kinds is not None:
            row["route_event_kinds"] = _normalize_slug_list(payload.route_event_kinds, max_items=12)
        if payload.min_occurrences is not None:
            row["min_occurrences"] = max(1, min(int(payload.min_occurrences or 1), 20))
        if payload.min_age_minutes is not None:
            row["min_age_minutes"] = max(0, min(int(payload.min_age_minutes or 0), 10080))
        if payload.message_template is not None:
            row["message_template"] = _clip_text(payload.message_template, max_length=1200)
        if payload.payload_template is not None:
            row["payload_template"] = _clip_text(payload.payload_template, max_length=4000)
        if payload.clear_message_template:
            row["message_template"] = None
        if payload.clear_payload_template:
            row["payload_template"] = None
        if payload.signature_header is not None:
            row["signature_header"] = _normalize_signature_header(payload.signature_header or "X-Scheduler-Signature")
        if payload.signing_secret is not None:
            row["signing_secret"] = str(payload.signing_secret or "").strip() or None
        if payload.clear_signing_secret:
            row["signing_secret"] = None
            row["sign_payload"] = False
        if payload.sign_payload is not None:
            if (
                bool(payload.sign_payload)
                and _normalize_channel_kind(row.get("kind")) == "webhook"
                and not str(row.get("signing_secret") or "").strip()
            ):
                raise HTTPException(400, "Ajoute un secret avant d'activer la signature webhook.")
            row["sign_payload"] = bool(payload.sign_payload and str(row.get("signing_secret") or "").strip())
        row["updated_at"] = now
        updated = row
        next_rows.append(row)
    if updated is None:
        raise HTTPException(404, "Canal externe introuvable.")
    settings_row = _write_supervision_features(db, settings_row, channels=next_rows)
    actor_label = str(getattr(user, "email", None) or getattr(user, "user_id", None) or "Opérateur")
    settings_row = _append_audit_entries(
        db,
        settings_row,
        [
            _audit_entry(
                "channel_update",
                now=now,
                actor_label=actor_label,
                target_kind="alert_channel",
                target_label=str(updated.get("label") or "Canal"),
                summary=f"Canal externe mis à jour · {updated.get('label') or 'Canal'}",
                details=f"{_route_summary(route_modules=_normalize_slug_list(updated.get('route_modules'), allowed=set(ops_base._MODULE_LABELS.keys()) | {'digest', 'scheduler'}), route_source_kinds=_normalize_slug_list(updated.get('route_source_kinds'), max_items=16), route_event_kinds=_normalize_slug_list(updated.get('route_event_kinds'), max_items=12))} · {_template_summary(updated)}",
                module="scheduler",
                href="/app/scheduler",
            )
        ],
    )
    return _channel_out(updated, _read_delivery_rows(settings_row))


@router.delete("/scheduler/alert-channels/{channel_id}", response_model=DeleteResponse)
def delete_scheduler_alert_channel(
    channel_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    channels = _read_channel_rows(settings_row)
    next_rows = [row for row in channels if str(row.get("id") or "") != channel_id]
    if len(next_rows) == len(channels):
        raise HTTPException(404, "Canal externe introuvable.")
    removed = next((row for row in channels if str(row.get("id") or "") == channel_id), None)
    settings_row = _write_supervision_features(db, settings_row, channels=next_rows)
    actor_label = str(getattr(user, "email", None) or getattr(user, "user_id", None) or "Opérateur")
    if removed is not None:
        settings_row = _append_audit_entries(
            db,
            settings_row,
            [
                _audit_entry(
                    "channel_delete",
                    now=datetime.now(timezone.utc).replace(tzinfo=None),
                    actor_label=actor_label,
                    target_kind="alert_channel",
                    target_label=str(removed.get("label") or "Canal"),
                    summary=f"Canal externe supprimé · {removed.get('label') or 'Canal'}",
                    details=_mask_url(removed.get("url")),
                    module="scheduler",
                    href="/app/scheduler",
                )
            ],
        )
    return DeleteResponse(ok=True)


@router.post("/scheduler/alert-channels/{channel_id}/test", response_model=SchedulerAlertChannelTestResultOut)
def test_scheduler_alert_channel(
    channel_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    settings_row = ops_base._ensure_settings(db, user.tenant_id)
    channels = _read_channel_rows(settings_row)
    channel = next((row for row in channels if str(row.get("id") or "") == channel_id), None)
    if channel is None:
        raise HTTPException(404, "Canal externe introuvable.")
    payload = {
        "event": "scheduler_alert_test",
        "module": "scheduler",
        "source_kind": "scheduler_test",
        "incident_type": "scheduler_test",
        "severity": "medium",
        "title": "Test canal supervision",
        "message": "Le canal externe est branché depuis le centre de supervision scheduler.",
        "generated_at": now.isoformat(),
    }
    settings_row, deliveries = _dispatch_alert_channels(
        db,
        settings_row,
        event_kind="test",
        severity="medium",
        title="Test canal supervision",
        message="Le canal externe est branché depuis le centre de supervision scheduler.",
        payload=payload,
        now=now,
        test_channel_id=channel_id,
    )
    if not deliveries:
        raise HTTPException(400, "Impossible de déclencher le test sur ce canal.")
    _, board = _board_payload(db, user, settings_row=settings_row, now=now, persist=True)
    refreshed_channel = next((item for item in board.channels if item.id == channel_id), None)
    if refreshed_channel is None:
        raise HTTPException(500, "Canal introuvable après test.")
    return SchedulerAlertChannelTestResultOut(
        channel=refreshed_channel,
        delivery=_delivery_out(deliveries[0]),
        board=board,
    )


@router.post("/scheduler/alert-channels/preview", response_model=SchedulerAlertPreviewOut)
def preview_scheduler_alert_channel(
    payload: SchedulerAlertPreviewRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    del db, user
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    channel = {
        "kind": _normalize_channel_kind(payload.kind),
        "label": str(payload.label).strip()[:120],
        "mention": _clip_text(payload.mention, max_length=120),
        "message_template": _clip_text(payload.message_template, max_length=1200),
        "payload_template": _clip_text(payload.payload_template, max_length=4000),
        "sign_payload": bool(payload.sign_payload and str(payload.signing_secret or "").strip()),
        "signature_header": _normalize_signature_header(payload.signature_header or "X-Scheduler-Signature"),
        "signing_secret": str(payload.signing_secret or "").strip() or None,
    }
    preview_body, rendered_message, template_summary = _render_alert_body(
        channel,
        event_kind=str(payload.event_kind or "incident_opened"),
        severity=_normalize_severity(payload.severity, default="high"),
        title=str(payload.title or "Alerte scheduler"),
        message=str(payload.message or "Signal supervision"),
        payload=copy.deepcopy(payload.payload or {}),
        now=now,
        test=True,
    )
    body_bytes = _payload_bytes(preview_body)
    headers_preview = _signature_headers(
        channel,
        event_kind=str(payload.event_kind or "incident_opened"),
        payload_bytes=body_bytes,
        now=now,
        test=True,
    )
    return SchedulerAlertPreviewOut(
        kind=channel["kind"],
        kind_label="Slack" if channel["kind"] == "slack" else "Webhook",
        title=str(payload.title or "Alerte scheduler"),
        message=rendered_message,
        body_preview=preview_body,
        body_preview_pretty=json.dumps(preview_body, ensure_ascii=False, indent=2, default=str),
        headers_preview=headers_preview,
        template_summary=template_summary,
    )
