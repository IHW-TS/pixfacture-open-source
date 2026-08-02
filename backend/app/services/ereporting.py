from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import settings
from ..models import EReportingEvent, PdpConnection
from ..services.einvoicing.utils import normalize_status
from ..services.pdp import EReportingEvent as PdpEvent
from ..services.pdp import TransmissionResult
from ..services.pdp.service import resolve_connection, resolve_provider
from ..services.pdp.utils import PdpProviderError, is_retryable_error
from ..services.seqino_tokens import (
    consume_seqino_tokens_or_raise,
    refund_seqino_tokens_after_certain_failure,
)
from ..services.connected_mode import connected_mode_decision
from ..services.seqino_mandates import seqino_has_active_mandate_for_tenant_issuer
from ..utils.public_provider_messages import sanitize_public_provider_message

PENDING_STATUSES = {"pending", "failed"}
DEFAULT_BATCH_LIMIT = 100
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_RETRY_BASE_SECONDS = 60
DEFAULT_RETRY_MAX_SECONDS = 3600
logger = logging.getLogger(__name__)


def _public_provider_error(exc: Exception) -> str:
    return sanitize_public_provider_message(
        exc,
        fallback="La plateforme agréée n’a pas pu traiter cet envoi.",
        max_chars=300,
    ) or "La plateforme agréée n’a pas pu traiter cet envoi."


def _is_certain_provider_failure(exc: Exception) -> bool:
    if not isinstance(exc, PdpProviderError) or is_retryable_error(exc):
        return False
    # A conflict can mean the provider already accepted the same business
    # object. It must be reconciled, not reimbursed automatically.
    return (getattr(exc, "code", None) or "").strip().lower() != "seqino_conflict"


def _refund_seqino_event_token(db: Session, tenant_id: str, event_id: str) -> None:
    try:
        refund_seqino_tokens_after_certain_failure(
            db,
            tenant_id,
            reference_type="seqino_ereporting_event",
            reference_id=event_id,
        )
    except Exception:
        logger.exception(
            "seqino_ereporting_token_refund_failed",
            extra={"tenant_id": tenant_id, "event_id": event_id},
        )


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _normalize_client_type(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip().lower() or None


def is_fr_vat_subject(
    client_country: str | None,
    client_type: str | None,
    client_vat_number: str | None,
) -> bool:
    country = (_clean(client_country) or "").upper()
    if country != "FR":
        return False
    normalized_type = _normalize_client_type(client_type)
    if normalized_type in {"individual", "consumer", "b2c"}:
        return False
    if _clean(client_vat_number):
        return True
    if normalized_type in {"business", "company", "b2b", "professional"}:
        return True
    return False


def ensure_ereporting_allowed(
    *,
    client_country: str | None,
    client_type: str | None,
    client_vat_number: str | None,
) -> None:
    if is_fr_vat_subject(client_country, client_type, client_vat_number):
        raise ValueError("Client FR assujetti TVA : utiliser l'e-invoicing.")


def _payload_dict(
    *,
    event_type: str,
    amounts: dict[str, Any] | None,
    payment_date,
    country: str | None,
    client_country: str | None,
    client_vat_number: str | None,
    client_type: str | None,
) -> dict[str, Any]:
    payment_value = None
    if payment_date:
        try:
            payment_value = payment_date.isoformat()
        except Exception:
            payment_value = str(payment_date)
    payload: dict[str, Any] = {
        "type": event_type,
        "amounts": amounts or None,
        "payment_date": payment_value,
        "country": _clean(country),
        "client_country": _clean(client_country),
        "client_vat_number": _clean(client_vat_number),
        "client_type": _normalize_client_type(client_type),
    }
    return {key: value for key, value in payload.items() if value is not None}


def payload_hash_from_fields(
    *,
    event_type: str,
    amounts: dict[str, Any] | None,
    payment_date,
    country: str | None,
    client_country: str | None,
    client_vat_number: str | None,
    client_type: str | None,
) -> str:
    payload = _payload_dict(
        event_type=event_type,
        amounts=amounts,
        payment_date=payment_date,
        country=country,
        client_country=client_country,
        client_vat_number=client_vat_number,
        client_type=client_type,
    )
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def payload_hash_from_event(event: EReportingEvent) -> str:
    return payload_hash_from_fields(
        event_type=event.type,
        amounts=event.amounts,
        payment_date=event.payment_date,
        country=event.country,
        client_country=event.client_country,
        client_vat_number=event.client_vat_number,
        client_type=event.client_type,
    )


def resolve_provider_slug(db: Session, tenant_id: str, provider_slug: str | None) -> str | None:
    slug = (provider_slug or "").strip().lower() or None
    if slug:
        conn = (
            db.query(PdpConnection)
            .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.provider_slug == slug)
            .first()
        )
        if not conn:
            raise ValueError("Connexion plateforme agréée introuvable.")
        if (conn.status or "").lower() != "connected":
            raise ValueError("Connexion plateforme agréée inactive.")
        return conn.provider_slug
    conns = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.status == "connected")
        .order_by(PdpConnection.updated_at.desc(), PdpConnection.created_at.desc())
        .all()
    )
    if len(conns) == 1:
        return conns[0].provider_slug
    return None


def _resolve_active_connection(db: Session, tenant_id: str, provider_slug: str) -> PdpConnection:
    conn = resolve_connection(db, tenant_id, provider_slug)
    if (conn.status or "").lower() != "connected":
        raise ValueError("Connexion plateforme agréée inactive.")
    return conn


def _normalize_status(value: str | None, raw_status: str | None = None) -> str:
    base = value or raw_status
    if base and str(base).strip().lower() == "reconciliation_required":
        return "reconciliation_required"
    if base and str(base).strip().lower() in {"skipped", "ignored"}:
        return "skipped"
    normalized = normalize_status(base)
    if normalized == "unknown":
        return "submitted"
    return normalized


def _error_message(message: str | None, errors: list[str] | None) -> str | None:
    pieces: list[str] = []
    if message:
        pieces.append(message)
    if errors:
        pieces.extend([err for err in errors if err])
    if not pieces:
        return None
    combined = " | ".join(pieces)
    return combined[:500]


def _backoff_delay(attempt: int, base_seconds: int, max_seconds: int) -> int:
    return min(int(base_seconds * (2 ** max(0, attempt - 1))), max_seconds)


def _schedule_retry(event: EReportingEvent, now: datetime) -> None:
    max_attempts = int(getattr(settings, "EREPORTING_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS) or DEFAULT_MAX_ATTEMPTS)
    if event.attempts >= max_attempts:
        event.next_retry_at = None
        return
    base_seconds = int(
        getattr(settings, "EREPORTING_RETRY_BASE_SECONDS", DEFAULT_RETRY_BASE_SECONDS) or DEFAULT_RETRY_BASE_SECONDS
    )
    max_seconds = int(
        getattr(settings, "EREPORTING_RETRY_MAX_SECONDS", DEFAULT_RETRY_MAX_SECONDS) or DEFAULT_RETRY_MAX_SECONDS
    )
    delay = _backoff_delay(event.attempts, base_seconds, max_seconds)
    event.next_retry_at = now + timedelta(seconds=delay)


def _as_pdp_event(event: EReportingEvent) -> PdpEvent:
    metadata: dict[str, Any] = {"event_id": event.id}
    if event.payment_date:
        metadata["event_date"] = event.payment_date.isoformat()
    elif event.created_at:
        metadata["event_date"] = event.created_at.date().isoformat()
    return PdpEvent(
        event_type=event.type,
        amounts=event.amounts,
        payment_date=event.payment_date,
        country=event.country,
        client_country=event.client_country,
        client_vat_number=event.client_vat_number,
        client_type=event.client_type,
        metadata=metadata,
    )


def _align_results(results: list[TransmissionResult], expected: int) -> list[TransmissionResult]:
    if expected <= 0:
        return []
    if not results:
        return [
            TransmissionResult(
                external_id=None,
                status="reconciliation_required",
                message="Réponse de transmission incomplète : rapprochement manuel requis.",
            )
            for _ in range(expected)
        ]
    if len(results) < expected:
        padding = [
            TransmissionResult(
                external_id=None,
                status="reconciliation_required",
                message="Réponse de transmission incomplète : rapprochement manuel requis.",
            )
            for _ in range(expected - len(results))
        ]
        return results + padding
    return results[:expected]


def _match_results(
    events: list[EReportingEvent],
    results: list[TransmissionResult],
) -> list[TransmissionResult]:
    by_id = {
        str(result.metadata.get("event_id")): result
        for result in results
        if result.metadata and result.metadata.get("event_id")
    }
    if by_id:
        return [
            by_id.get(str(event.id))
            or TransmissionResult(
                external_id=None,
                status="reconciliation_required",
                message="Réponse de transmission incomplète : rapprochement manuel requis.",
                metadata={"event_id": event.id},
            )
            for event in events
        ]
    return _align_results(results, len(events))


def _apply_send_failure(
    event: EReportingEvent,
    *,
    message: str,
    retryable: bool,
    now: datetime,
    reconciliation_required: bool = False,
) -> None:
    if reconciliation_required:
        event.status = "reconciliation_required"
        event.error_message = (
            "Résultat de transmission ambigu : un rapprochement manuel est requis avant tout nouvel envoi."
        )
        event.next_retry_at = None
        return
    event.status = "failed"
    event.error_message = message[:500]
    if retryable:
        _schedule_retry(event, now)
    else:
        event.next_retry_at = None


def _apply_result(event: EReportingEvent, result: TransmissionResult, now: datetime) -> None:
    normalized = _normalize_status(result.status, result.raw_status)
    event.status = normalized
    if result.external_id:
        event.external_id = result.external_id
    if result.payload_hash:
        event.payload_hash = result.payload_hash
    error_message = _error_message(result.message, result.errors)
    if normalized == "reconciliation_required":
        event.error_message = error_message or (
            "Résultat de transmission ambigu : rapprochement manuel requis avant tout nouvel envoi."
        )
    elif normalized in {"failed", "rejected"}:
        event.error_message = error_message or "Transmission rejetée."
    else:
        event.error_message = None
    if normalized in {"submitted", "processing", "accepted"}:
        event.sent_at = now
        event.next_retry_at = None
    elif normalized in {"failed", "rejected", "skipped", "reconciliation_required"}:
        event.next_retry_at = None


def _select_events(
    db: Session,
    *,
    tenant_id: str,
    provider_slug: str | None,
    event_ids: list[str] | None,
    limit: int,
    now: datetime,
) -> list[EReportingEvent]:
    query = db.query(EReportingEvent).filter(EReportingEvent.tenant_id == tenant_id)
    if event_ids:
        query = query.filter(EReportingEvent.id.in_(event_ids))
    else:
        query = query.filter(EReportingEvent.status.in_(PENDING_STATUSES))
        query = query.filter(or_(EReportingEvent.next_retry_at.is_(None), EReportingEvent.next_retry_at <= now))
    if provider_slug:
        query = query.filter(
            or_(EReportingEvent.provider_slug == provider_slug, EReportingEvent.provider_slug.is_(None))
        )
    return query.order_by(EReportingEvent.created_at.asc()).limit(limit).all()


async def send_ereporting_events(
    db: Session,
    *,
    tenant_id: str,
    provider_slug: str | None = None,
    event_ids: list[str] | None = None,
    limit: int | None = None,
) -> dict:
    summary = {"ok": True, "checked": 0, "sent": 0, "failed": 0, "skipped": 0, "errors": 0}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    provider_slug = _clean(provider_slug)
    limit_value = limit or getattr(settings, "EREPORTING_BATCH_SIZE", DEFAULT_BATCH_LIMIT) or DEFAULT_BATCH_LIMIT
    limit_value = max(1, min(int(limit_value), 200))

    events = _select_events(
        db,
        tenant_id=tenant_id,
        provider_slug=provider_slug,
        event_ids=event_ids,
        limit=limit_value,
        now=now,
    )
    summary["checked"] = len(events)
    if not events:
        return summary
    access = connected_mode_decision(db, tenant_id, provider_slug)
    if not access.allowed and (provider_slug is not None or access.code != "connected_mode_not_operational"):
        summary["skipped"] = len(events)
        return summary

    default_slug = provider_slug
    if not default_slug and any(event.provider_slug is None for event in events):
        try:
            default_conn = resolve_connection(db, tenant_id)
            if (default_conn.status or "").lower() != "connected":
                raise ValueError("Connexion plateforme agréée inactive.")
            default_slug = default_conn.provider_slug
        except Exception:
            for event in events:
                if event.provider_slug:
                    continue
                event.status = "failed"
                event.error_message = "Connexion plateforme agréée manquante."
                summary["failed"] += 1
            db.commit()
            events = [event for event in events if event.provider_slug]

    grouped: dict[str, list[EReportingEvent]] = {}
    for event in events:
        if not event.provider_slug and default_slug:
            event.provider_slug = default_slug
        slug = _clean(event.provider_slug)
        if not slug:
            summary["skipped"] += 1
            continue
        grouped.setdefault(slug, []).append(event)

    for slug, slug_events in grouped.items():
        access = connected_mode_decision(db, tenant_id, slug)
        if not access.allowed:
            summary["skipped"] += len(slug_events)
            continue
        if slug.strip().lower() == "seqino" and not seqino_has_active_mandate_for_tenant_issuer(
            tenant_id,
            db=db,
        ):
            # A queued event must not outlive the issuer's mandate.  Keep it
            # pending for a deliberate retry after a new mandate; do not
            # resolve the provider, consume a token or perform remote I/O.
            summary["skipped"] += len(slug_events)
            continue
        try:
            conn = _resolve_active_connection(db, tenant_id, slug)
        except Exception:
            for event in slug_events:
                event.status = "failed"
                event.error_message = "Connexion plateforme agréée introuvable."
                summary["failed"] += 1
            summary["errors"] += 1
            continue

        try:
            provider, _ = resolve_provider(conn, db)
        except Exception:
            for event in slug_events:
                event.status = "failed"
                event.error_message = "Plateforme agréée indisponible."
                summary["failed"] += 1
            summary["errors"] += 1
            continue

        to_send: list[EReportingEvent] = []
        for event in slug_events:
            if (event.status or "").strip().lower() == "reconciliation_required":
                event.next_retry_at = None
                summary["skipped"] += 1
                continue
            try:
                ensure_ereporting_allowed(
                    client_country=event.client_country,
                    client_type=event.client_type,
                    client_vat_number=event.client_vat_number,
                )
            except ValueError as exc:
                event.status = "failed"
                event.error_message = sanitize_public_provider_message(
                    exc,
                    fallback="Les informations de l’événement ne permettent pas cet envoi.",
                    max_chars=300,
                )
                summary["failed"] += 1
                continue
            if not event.payload_hash:
                event.payload_hash = payload_hash_from_event(event)
            event.attempts = (event.attempts or 0) + 1
            event.last_attempt_at = now
            to_send.append(event)

        if not to_send:
            continue

        sendable_events: list[EReportingEvent] = []
        if (slug or "").strip().lower() == "seqino":
            if not seqino_has_active_mandate_for_tenant_issuer(tenant_id, db=db):
                summary["skipped"] += len(to_send)
                continue
            for event in to_send:
                try:
                    consume_seqino_tokens_or_raise(
                        db,
                        tenant_id,
                        reference_type="seqino_ereporting_event",
                        reference_id=event.id,
                    )
                except PdpProviderError as exc:
                    event.status = "failed"
                    event.error_message = _public_provider_error(exc)
                    event.next_retry_at = None
                    summary["failed"] += 1
                    continue
                sendable_events.append(event)
        else:
            sendable_events = list(to_send)
        if not sendable_events:
            continue
        if (slug or "").strip().lower() == "seqino" and not seqino_has_active_mandate_for_tenant_issuer(
            tenant_id,
            db=db,
        ):
            # Token consumption commits. A revocation can land between the
            # first mandate check and that commit, so compensate every debit
            # and stop immediately before provider I/O.
            for event in sendable_events:
                _refund_seqino_event_token(db, tenant_id, str(event.id))
                event.attempts = max(0, int(event.attempts or 0) - 1)
                event.error_message = "Mandat Seqino actif requis avant envoi."
                event.next_retry_at = None
                db.add(event)
            db.commit()
            summary["skipped"] += len(sendable_events)
            continue
        pdp_events = [_as_pdp_event(event) for event in sendable_events]
        try:
            results = await provider.send_ereporting(pdp_events)
        except NotImplementedError:
            for event in sendable_events:
                if (slug or "").strip().lower() == "seqino":
                    _refund_seqino_event_token(db, tenant_id, str(event.id))
                event.status = "exported_pending_send"
                event.error_message = "Export requis (envoi direct non disponible)."
                event.next_retry_at = None
                event.sent_at = None
                summary["skipped"] += 1
            continue
        except Exception as exc:
            retryable = is_retryable_error(exc)
            certain_failure = _is_certain_provider_failure(exc)
            seqino_ambiguous = (slug or "").strip().lower() == "seqino" and not certain_failure
            message = _public_provider_error(exc)
            for event in sendable_events:
                if certain_failure and (slug or "").strip().lower() == "seqino":
                    _refund_seqino_event_token(db, tenant_id, str(event.id))
                _apply_send_failure(
                    event,
                    message=message,
                    retryable=retryable,
                    now=now,
                    reconciliation_required=seqino_ambiguous,
                )
                summary["failed"] += 1
            if retryable or seqino_ambiguous:
                summary["errors"] += 1
            continue

        aligned = _match_results(sendable_events, results or [])
        for event, result in zip(sendable_events, aligned):
            _apply_result(event, result, now)
            if event.status in {"failed", "rejected", "skipped"}:
                if (slug or "").strip().lower() == "seqino":
                    _refund_seqino_event_token(db, tenant_id, str(event.id))
                summary["skipped" if event.status == "skipped" else "failed"] += 1
            elif event.status == "reconciliation_required":
                summary["failed"] += 1
            else:
                summary["sent"] += 1

    db.commit()
    return summary
