from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from ...config import settings
from ...models import Customer, Invoice, Tenant
from ...services.dunning_settings import get_dunning_settings
from ...services.recipients import resolve_customer_recipients

INVOICE_FOLLOWUP_MISSING_RECIPIENT = "invoice_followup_missing_recipient"
INVOICE_FOLLOWUP_NO_BALANCE = "invoice_followup_no_balance"
INVOICE_FOLLOWUP_NOT_DUE = "invoice_followup_not_due"
INVOICE_FOLLOWUP_CREDIT_NOTE = "invoice_followup_credit_note"
INVOICE_FOLLOWUP_LIMIT = "invoice_followup_limit"
INVOICE_FOLLOWUP_TOO_SOON = "invoice_followup_too_soon"


@dataclass(frozen=True)
class InvoiceFollowupDecision:
    can_followup: bool
    followup_state: str | None = None
    followup_block_reason: str | None = None
    next_followup_at: datetime | None = None
    next_followup_offset: int | None = None
    followup_schedule: list[dict[str, Any]] = field(default_factory=list)
    recipients: list[str] = field(default_factory=list)
    min_interval_until: datetime | None = None

    def as_payload(self, *, include_schedule: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "can_followup": self.can_followup,
            "followup_state": self.followup_state,
            "followup_block_reason": self.followup_block_reason,
            "next_followup_at": self.next_followup_at,
            "next_followup_offset": self.next_followup_offset,
        }
        if include_schedule:
            payload["followup_schedule"] = self.followup_schedule
        return payload


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def invoice_followup_error_message(code: str | None) -> str:
    if code == INVOICE_FOLLOWUP_MISSING_RECIPIENT:
        return "Aucun destinataire : ajoutez un email au client ou un contact facturation."
    if code == INVOICE_FOLLOWUP_NO_BALANCE:
        return "Relance impossible : cette facture ne présente aucun solde à régler."
    if code == INVOICE_FOLLOWUP_CREDIT_NOTE:
        return "Relance non applicable aux avoirs."
    if code == INVOICE_FOLLOWUP_LIMIT:
        return "Limite de relances atteinte."
    if code == INVOICE_FOLLOWUP_TOO_SOON:
        return "Relance envoyée trop récemment. Réessayez plus tard."
    return "Relance impossible : la facture n'est pas encore relançable."


def _followup_offset_label(offset: int) -> str:
    if offset < 0:
        return f"{abs(offset)} jour{'s' if abs(offset) > 1 else ''} avant échéance"
    if offset == 0:
        return "À l'échéance"
    return f"{offset} jour{'s' if offset > 1 else ''} après échéance"


def _effective_due_date(inv: Invoice, due_date: datetime | None) -> datetime | None:
    return _naive(due_date or getattr(inv, "due_date", None))


def invoice_followup_decision(
    db: Session,
    *,
    inv: Invoice,
    tenant: Tenant | None,
    customer: Customer | None,
    balance_due: Decimal,
    now: datetime | None = None,
    due_date: datetime | None = None,
    explicit_to: str | None = None,
) -> InvoiceFollowupDecision:
    now_value = _naive(now) or _utcnow()
    status = str(getattr(inv, "status", "") or "").lower()
    invoice_type = str(getattr(inv, "type", "invoice") or "invoice").lower()
    due = _effective_due_date(inv, due_date)
    balance = Decimal(str(balance_due or 0))

    recipients = (
        resolve_customer_recipients(db, customer=customer, kind="followup", explicit_to=explicit_to)
        if customer is not None
        else []
    )
    has_recipients = bool(recipients)

    dunning = get_dunning_settings(tenant) if tenant is not None else {}
    schedule = list(dunning.get("schedule_days") or [])
    if not schedule:
        schedule = [-2, 3, 10]
    max_reminders_global = int(getattr(settings, "INVOICE_FOLLOWUP_MAX_REMINDERS", 0) or 0)
    max_reminders = max_reminders_global or len(schedule)
    schedule_eff = schedule[:max_reminders]
    reminder_count = max(0, int(getattr(inv, "reminder_count", 0) or 0))
    automatic_enabled = bool(getattr(settings, "INVOICE_FOLLOWUP_AUTOMATIC_ENABLED", False)) and bool(
        dunning.get("enabled")
    )
    min_interval_hours = int(
        dunning.get("min_interval_hours")
        or getattr(settings, "INVOICE_FOLLOWUP_MIN_INTERVAL_HOURS", 24)
        or 24
    )
    min_interval_hours = max(1, min(24 * 30, min_interval_hours))

    block_reason: str | None = None
    if invoice_type != "invoice":
        block_reason = INVOICE_FOLLOWUP_CREDIT_NOTE
    elif status in {"draft", "canceled"}:
        block_reason = INVOICE_FOLLOWUP_NOT_DUE
    elif status == "paid" or balance <= Decimal("0.00"):
        block_reason = INVOICE_FOLLOWUP_NO_BALANCE
    elif not has_recipients:
        block_reason = INVOICE_FOLLOWUP_MISSING_RECIPIENT
    elif max_reminders > 0 and reminder_count >= max_reminders:
        block_reason = INVOICE_FOLLOWUP_LIMIT
    else:
        last_reminder_at = _naive(getattr(inv, "last_reminder_at", None))
        if last_reminder_at:
            min_until = last_reminder_at + timedelta(hours=min_interval_hours)
            if min_until > now_value:
                block_reason = INVOICE_FOLLOWUP_TOO_SOON

    items: list[dict[str, Any]] = []
    next_at: datetime | None = None
    next_offset: int | None = None
    followup_state: str | None = None
    for index, raw_offset in enumerate(schedule_eff):
        offset = int(raw_offset)
        scheduled_at = due + timedelta(days=offset) if due else None
        item_status = "planned"
        if index < reminder_count:
            item_status = "sent"
        elif block_reason == INVOICE_FOLLOWUP_NO_BALANCE:
            item_status = "settled"
        elif block_reason in {
            INVOICE_FOLLOWUP_CREDIT_NOTE,
            INVOICE_FOLLOWUP_NOT_DUE,
            INVOICE_FOLLOWUP_LIMIT,
            INVOICE_FOLLOWUP_TOO_SOON,
        }:
            item_status = "blocked"
        elif block_reason == INVOICE_FOLLOWUP_MISSING_RECIPIENT:
            item_status = "missing_recipient"
        elif not scheduled_at:
            item_status = "blocked"
        elif offset < 0 and due and now_value > due:
            item_status = "missed"
        elif scheduled_at <= now_value:
            item_status = "ready" if automatic_enabled else "manual"
            if next_at is None:
                next_at = now_value
                next_offset = offset
                followup_state = "eligible_now"
        else:
            item_status = "planned"
            if next_at is None:
                next_at = scheduled_at
                next_offset = offset
                followup_state = "scheduled"
        items.append(
            {
                "index": index + 1,
                "offset": offset,
                "label": _followup_offset_label(offset),
                "scheduled_at": scheduled_at,
                "status": item_status,
            }
        )

    if block_reason == INVOICE_FOLLOWUP_MISSING_RECIPIENT:
        followup_state = "missing_recipient"
    elif block_reason in {INVOICE_FOLLOWUP_LIMIT, INVOICE_FOLLOWUP_TOO_SOON}:
        followup_state = "blocked"
    elif block_reason:
        followup_state = "none"
    elif not automatic_enabled and followup_state is None:
        followup_state = "manual"
    elif followup_state is None:
        followup_state = "none"

    return InvoiceFollowupDecision(
        can_followup=block_reason is None,
        followup_state=followup_state,
        followup_block_reason=block_reason,
        next_followup_at=next_at,
        next_followup_offset=next_offset,
        followup_schedule=items,
        recipients=recipients,
        min_interval_until=(
            _naive(getattr(inv, "last_reminder_at", None)) + timedelta(hours=min_interval_hours)
            if block_reason == INVOICE_FOLLOWUP_TOO_SOON and _naive(getattr(inv, "last_reminder_at", None))
            else None
        ),
    )
