from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import AccountingExport

ACCOUNTING_EXPORT_DELIVERED_STATUS = "delivered_to_accountant"
ACCOUNTING_EXPORT_LOCKING_FORMATS = {"csv", "fec", "edi_ubl", "edi_cii", "archive_zip", "cabinet_zip"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def parse_export_date(raw: str | date | datetime | None) -> date | None:
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    cleaned = str(raw or "").strip()
    if not cleaned:
        return None
    try:
        return datetime.fromisoformat(cleaned).date()
    except ValueError:
        try:
            return date.fromisoformat(cleaned[:10])
        except ValueError:
            return None


def record_accounting_export(
    db: Session,
    *,
    tenant_id: str,
    export_format: str,
    created_by: str | None,
    period_start: str | date | datetime | None = None,
    period_end: str | date | datetime | None = None,
    customer_id: str | None = None,
    record_count: int = 0,
    filters: dict[str, Any] | None = None,
    commit: bool = False,
) -> AccountingExport:
    row = AccountingExport(
        tenant_id=tenant_id,
        format=export_format,
        period_start=parse_export_date(period_start),
        period_end=parse_export_date(period_end),
        customer_id=customer_id or None,
        record_count=max(0, int(record_count or 0)),
        filters_json=filters or {},
        status="generated",
        created_by=created_by,
        created_at=_utcnow(),
    )
    db.add(row)
    if commit:
        db.commit()
        db.refresh(row)
    else:
        db.flush()
    return row


def clean_accounting_export_comment(value: str | None) -> str | None:
    cleaned = str(value or "").strip()
    if not cleaned:
        return None
    return cleaned[:2000]


def find_delivered_accounting_period_lock(
    db: Session,
    *,
    tenant_id: str,
    period_start: str | date | datetime | None = None,
    period_end: str | date | datetime | None = None,
    customer_id: str | None = None,
    exclude_export_id: str | None = None,
) -> AccountingExport | None:
    """Return a delivered export whose transferred period overlaps the requested scope."""
    requested_start = parse_export_date(period_start)
    requested_end = parse_export_date(period_end)

    query = db.query(AccountingExport).filter(
        AccountingExport.tenant_id == tenant_id,
        AccountingExport.status == ACCOUNTING_EXPORT_DELIVERED_STATUS,
        AccountingExport.format.in_(ACCOUNTING_EXPORT_LOCKING_FORMATS),
    )
    if exclude_export_id:
        query = query.filter(AccountingExport.id != exclude_export_id)
    if customer_id:
        query = query.filter(or_(AccountingExport.customer_id.is_(None), AccountingExport.customer_id == customer_id))
    if requested_end:
        query = query.filter(or_(AccountingExport.period_start.is_(None), AccountingExport.period_start <= requested_end))
    if requested_start:
        query = query.filter(or_(AccountingExport.period_end.is_(None), AccountingExport.period_end >= requested_start))

    return query.order_by(AccountingExport.delivered_to_accountant_at.desc(), AccountingExport.created_at.desc()).first()


def accounting_period_lock_payload(row: AccountingExport | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row.id,
        "format": row.format,
        "period_start": row.period_start.isoformat() if row.period_start else None,
        "period_end": row.period_end.isoformat() if row.period_end else None,
        "customer_id": row.customer_id,
        "status": row.status,
        "cabinet_validation_status": row.cabinet_validation_status or "pending_review",
        "cabinet_reviewed_at": row.cabinet_reviewed_at.isoformat() if row.cabinet_reviewed_at else None,
        "cabinet_comment": row.cabinet_comment or "",
        "delivered_to_accountant_at": row.delivered_to_accountant_at.isoformat()
        if row.delivered_to_accountant_at
        else None,
    }
