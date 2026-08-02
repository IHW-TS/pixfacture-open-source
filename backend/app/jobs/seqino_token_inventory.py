"""Supervision for the Seqino provider-token inventory.

This job never calls Seqino and never creates supplier purchases. It may read
Stripe Checkout state to release a bound hold only after Stripe confirms that
the Session expired unpaid. Paid or ambiguous Sessions remain reserved and
raise an operational reconciliation error.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import stripe

from ..config import settings
from ..db import SessionLocal
from ..models import ProviderTokenReservation
from ..services.provider_token_inventory import (
    expire_reservations,
    get_inventory_status,
    release_reservation,
)
from ..services.stripe_mode import livemode_validation_reason


logger = logging.getLogger("jobs.seqino_token_inventory")


def _read(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _retrieve_checkout_session(session_id: str) -> Any:
    secret = (settings.STRIPE_SECRET_KEY or "").strip()
    if not secret:
        raise RuntimeError("stripe_secret_missing")
    return stripe.checkout.Session.retrieve(session_id, api_key=secret)


def _reconcile_due_bound_checkouts(db, *, limit: int) -> dict[str, int]:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    reservations = (
        db.query(ProviderTokenReservation)
        .filter(
            ProviderTokenReservation.status == "reserved",
            ProviderTokenReservation.stripe_checkout_session_id.is_not(None),
            ProviderTokenReservation.expires_at <= now,
        )
        .order_by(ProviderTokenReservation.expires_at, ProviderTokenReservation.id)
        .limit(max(1, min(int(limit), 5000)))
        .all()
    )
    result = {"checked": 0, "released": 0, "paid_pending": 0, "errors": 0}
    for reservation in reservations:
        result["checked"] += 1
        session_id = str(reservation.stripe_checkout_session_id or "").strip()
        try:
            session = _retrieve_checkout_session(session_id)
            if livemode_validation_reason(session, settings.STRIPE_SECRET_KEY):
                raise RuntimeError("stripe_livemode_mismatch")
            metadata = _read(session, "metadata") or {}
            reservation_metadata_id = str(
                _read(metadata, "provider_token_reservation_id")
                or _read(metadata, "provider_welcome_reservation_id")
                or ""
            ).strip()
            if reservation_metadata_id != str(reservation.id):
                raise RuntimeError("stripe_reservation_metadata_mismatch")
            remote_status = str(_read(session, "status") or "").strip().lower()
            payment_status = str(_read(session, "payment_status") or "").strip().lower()
            if remote_status == "expired" and payment_status != "paid":
                if release_reservation(db, reservation_id=str(reservation.id)):
                    result["released"] += 1
                    db.commit()
                continue
            if remote_status == "complete" and payment_status == "paid":
                result["paid_pending"] += 1
                continue
            if remote_status == "open":
                continue
            result["errors"] += 1
        except Exception:
            db.rollback()
            result["errors"] += 1
            logger.exception(
                "stripe_checkout_reservation_reconciliation_failed",
                extra={"reservation_id": str(reservation.id)},
            )
    return result


def _summary_payload(*, expired_reservations: int, status: Any) -> dict[str, object]:
    return {
        "ok": bool(status.invariant_valid),
        "initialized": True,
        "expired_reservations": expired_reservations,
        "state": status.state,
        "invariant_valid": bool(status.invariant_valid),
        "safe_to_sell": bool(status.safe_to_sell),
        "purchased_tokens": int(status.purchased_tokens),
        "available_tokens": int(status.available_tokens),
        "reserved_tokens": int(status.reserved_tokens),
        "allocated_tokens": int(status.allocated_tokens),
        "consumed_tokens": int(status.consumed_tokens),
        "sellable_tokens": int(status.sellable_tokens),
        "warning_threshold": int(status.warning_threshold),
        "critical_threshold": int(status.critical_threshold),
        "customer_liability_tokens": int(status.customer_liability_tokens),
        "pending_welcome_bonus_tokens": int(status.pending_welcome_bonus_tokens),
        "pending_welcome_bonus_tenants": int(status.pending_welcome_bonus_tenants),
        "coverage_gap_tokens": int(status.coverage_gap_tokens),
        "invalid_ledger_events": int(status.invalid_ledger_events),
        "ledger_matches_inventory": bool(status.ledger_matches_inventory),
    }


def _log_summary(summary: dict[str, object]) -> None:
    state = str(summary.get("state") or "unknown")
    payload = json.dumps(
        {"event": "seqino_token_inventory_checked", "summary": summary},
        ensure_ascii=False,
        sort_keys=True,
    )
    if state in {"inconsistent", "critical", "depleted", "reconciliation_required"}:
        logger.critical(payload)
    elif state == "warning":
        logger.warning(payload)
    else:
        logger.info(payload)


def run_seqino_token_inventory_monitor_once() -> dict[str, object]:
    """Expire local holds and report the Seqino collateral status once."""

    expiry_limit = int(getattr(settings, "SEQINO_TOKEN_INVENTORY_EXPIRY_BATCH_SIZE", 500) or 500)
    with SessionLocal() as db:
        status_before = get_inventory_status(db)
        if status_before.state == "uninitialized":
            inventory_required = bool(
                getattr(settings, "REQUIRE_SEQINO_IN_PROD", False)
                and not getattr(settings, "EINVOICING_EXPORT_ONLY", True)
            )
            summary: dict[str, object] = {
                "ok": not inventory_required,
                "initialized": False,
                "skipped": True,
                "reason": "inventory_uninitialized",
                "expired_reservations": 0,
                "state": "uninitialized",
                "invariant_valid": False,
                "safe_to_sell": False,
                "customer_liability_tokens": int(status_before.customer_liability_tokens),
                "pending_welcome_bonus_tokens": int(status_before.pending_welcome_bonus_tokens),
                "pending_welcome_bonus_tenants": int(status_before.pending_welcome_bonus_tenants),
                "coverage_gap_tokens": int(status_before.coverage_gap_tokens),
            }
            log_payload = json.dumps(
                {"event": "seqino_token_inventory_uninitialized", "summary": summary},
                ensure_ascii=False,
                sort_keys=True,
            )
            (logger.critical if inventory_required else logger.info)(log_payload)
            return summary

        if not status_before.invariant_valid:
            summary = _summary_payload(expired_reservations=0, status=status_before)
            _log_summary(summary)
            return summary

        bound = _reconcile_due_bound_checkouts(db, limit=expiry_limit)
        expired = expire_reservations(db, limit=expiry_limit)
        db.commit()
        status_after = get_inventory_status(db)
        summary = _summary_payload(expired_reservations=expired, status=status_after)
        summary.update(
            {
                "bound_sessions_checked": bound["checked"],
                "bound_sessions_released": bound["released"],
                "bound_paid_pending": bound["paid_pending"],
                "bound_reconciliation_errors": bound["errors"],
            }
        )
        if bound["paid_pending"] or bound["errors"]:
            summary["ok"] = False
            summary["state"] = "reconciliation_required"
        _log_summary(summary)
        return summary
