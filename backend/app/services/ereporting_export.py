from __future__ import annotations

import csv
import hashlib
import io
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..models import EReportingEvent
from ..services.action_logs import log_action
from ..services.storage import put_object


EXPORT_SCHEMA_VERSION = "2024-01"
CSV_INJECTION_PREFIXES = ("=", "+", "-", "@")


@dataclass
class EReportingExport:
    content: bytes
    content_type: str
    checksum: str
    storage_key: str
    filename: str
    record_count: int
    period_start: date
    period_end: date


def _default_period(today: date | None = None) -> tuple[date, date]:
    current = today or date.today()
    start = current.replace(day=1)
    next_month = (start + timedelta(days=32)).replace(day=1)
    end = next_month - timedelta(days=1)
    return start, end


def _period_bounds(period_start: date, period_end: date) -> tuple[datetime, datetime]:
    start_dt = datetime.combine(period_start, datetime.min.time())
    end_dt = datetime.combine(period_end, datetime.max.time())
    return start_dt, end_dt


def _export_key(tenant_id: str, period_start: date, period_end: date, fmt: str, generated_at: datetime) -> str:
    stamp = generated_at.strftime("%Y%m%dT%H%M%SZ")
    return (
        f"ereporting/exports/{tenant_id}/{period_start.isoformat()}_{period_end.isoformat()}/ereporting_{stamp}.{fmt}"
    )


def _event_payload(event: EReportingEvent) -> dict[str, Any]:
    return {
        "event_id": event.id,
        "type": event.type,
        "status": event.status,
        "amounts": event.amounts,
        "payment_date": event.payment_date.isoformat() if event.payment_date else None,
        "country": event.country,
        "client_country": event.client_country,
        "client_vat_number": event.client_vat_number,
        "client_type": event.client_type,
        "provider_slug": event.provider_slug,
        "created_at": event.created_at.isoformat() if event.created_at else None,
    }


def _csv_safe(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    first_meaningful = text.lstrip(" \t\r\n\ufeff")
    if first_meaningful and first_meaningful[0] in CSV_INJECTION_PREFIXES:
        return "'" + text
    return text


def _build_json_payload(
    *,
    tenant_id: str,
    period_start: date,
    period_end: date,
    events: list[EReportingEvent],
    generated_at: datetime,
) -> dict[str, Any]:
    return {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "generated_at": generated_at.isoformat() + "Z",
        "tenant_id": tenant_id,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "events": [_event_payload(event) for event in events],
    }


def _build_csv_payload(events: list[EReportingEvent]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(
        [
            "event_id",
            "type",
            "status",
            "payment_date",
            "country",
            "client_country",
            "client_vat_number",
            "client_type",
            "amounts",
            "provider_slug",
            "created_at",
        ]
    )
    for event in events:
        amounts = event.amounts or {}
        amounts_raw = json.dumps(amounts, ensure_ascii=True, separators=(",", ":"), default=str) if amounts else ""
        writer.writerow(
            [
                _csv_safe(event.id),
                _csv_safe(event.type),
                _csv_safe(event.status),
                _csv_safe(event.payment_date.isoformat() if event.payment_date else ""),
                _csv_safe(event.country or ""),
                _csv_safe(event.client_country or ""),
                _csv_safe(event.client_vat_number or ""),
                _csv_safe(event.client_type or ""),
                _csv_safe(amounts_raw),
                _csv_safe(event.provider_slug or ""),
                _csv_safe(event.created_at.isoformat() if event.created_at else ""),
            ]
        )
    return "\ufeff" + buf.getvalue()


def build_ereporting_export(
    db: Session,
    *,
    tenant_id: str,
    period_start: date | None,
    period_end: date | None,
    export_format: str,
    user_id: str | None = None,
) -> EReportingExport:
    if period_start and period_end and period_end < period_start:
        raise ValueError("Periode invalide.")
    if (period_start is None) ^ (period_end is None):
        raise ValueError("Periode invalide.")
    if not period_start or not period_end:
        period_start, period_end = _default_period()
    fmt = (export_format or "json").strip().lower()
    if fmt not in {"json", "csv"}:
        raise ValueError("Format export invalide.")

    start_dt, end_dt = _period_bounds(period_start, period_end)
    events = (
        db.query(EReportingEvent)
        .filter(EReportingEvent.tenant_id == tenant_id)
        .filter(EReportingEvent.created_at >= start_dt, EReportingEvent.created_at <= end_dt)
        .order_by(EReportingEvent.created_at.asc())
        .all()
    )
    generated_at = datetime.now(timezone.utc).replace(tzinfo=None).replace(microsecond=0)

    if fmt == "csv":
        content_text = _build_csv_payload(events)
        content = content_text.encode("utf-8")
        content_type = "text/csv"
    else:
        payload = _build_json_payload(
            tenant_id=tenant_id,
            period_start=period_start,
            period_end=period_end,
            events=events,
            generated_at=generated_at,
        )
        content = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str).encode("utf-8")
        content_type = "application/json"

    checksum = hashlib.sha256(content).hexdigest()
    storage_key = _export_key(tenant_id, period_start, period_end, fmt, generated_at)
    put_object(storage_key, content, content_type=content_type)

    payload = {
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "format": fmt,
        "record_count": len(events),
        "export_key": storage_key,
        "checksum": checksum,
    }
    log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=user_id,
        action_type="export",
        object_type="ereporting_export",
        object_id=storage_key,
        metadata=payload,
    )
    db.commit()

    filename = f"ereporting-export-{period_start.isoformat()}-{period_end.isoformat()}.{fmt}"
    return EReportingExport(
        content=content,
        content_type=content_type,
        checksum=checksum,
        storage_key=storage_key,
        filename=filename,
        record_count=len(events),
        period_start=period_start,
        period_end=period_end,
    )
