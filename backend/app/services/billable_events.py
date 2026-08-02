from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import BillableEvent


def record_billable_event(
    db: Session,
    *,
    tenant_id: str,
    event_type: str,
    source_type: str,
    source_id: str,
    provider_slug: str | None = None,
    invoice_id: str | None = None,
    status: str | None = None,
    occurred_at: datetime | None = None,
    commit: bool = True,
) -> BillableEvent:
    event = BillableEvent(
        tenant_id=tenant_id,
        invoice_id=invoice_id,
        event_type=event_type,
        provider_slug=provider_slug,
        status=status,
        source_type=source_type,
        source_id=source_id,
        occurred_at=occurred_at or datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(event)
    try:
        if commit:
            db.commit()
            db.refresh(event)
        else:
            db.flush()
    except IntegrityError:
        db.rollback()
        existing = (
            db.query(BillableEvent)
            .filter(
                BillableEvent.tenant_id == tenant_id,
                BillableEvent.source_type == source_type,
                BillableEvent.source_id == source_id,
            )
            .first()
        )
        if existing:
            return existing
        raise
    return event
