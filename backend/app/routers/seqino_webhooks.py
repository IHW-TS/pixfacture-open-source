from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..jobs.inbox import enqueue_inbox_poll_for_tenant
from ..models import EInvoicingTransmission, InboundInvoice, Invoice, PdpAccount, PdpConnection, PdpMandate
from ..services.einvoicing.lifecycle import is_transition_allowed
from ..services.pdp.providers.seqino import _map_lifecycle_status
from ..services.connected_mode import connected_mode_decision, connected_mode_tenant_is_allowed
from ..services.seqino_webhooks import (
    SeqinoWebhookError,
    claim_webhook_event,
    release_webhook_event,
    verify_webhook_payload,
)
from ..utils.crypto import decrypt_payload


router = APIRouter(prefix="/api/webhooks/seqino", tags=["seqino-webhooks"])
_MAX_WEBHOOK_BYTES = 1024 * 1024
_SUPPORTED_EVENTS = {
    "webhook.test",
    "invoice.created",
    "invoice.received",
    "invoice.status_updated",
    "mandate.activated",
    "mandate.created",
    "mandate.expired",
    "mandate.failed",
    "mandate.revoked",
}
_ACTIVE_MANDATE_STATUSES = {"ACTIVE"}
_TERMINAL_MANDATE_STATUSES = {"REVOKED", "EXPIRED", "FAILED"}
_PENDING_MANDATE_STATUSES = {"PENDING_KYB"}


def _error(exc: SeqinoWebhookError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": str(exc)},
    )


def _tenant_for_client(db: Session, client_id: str) -> str:
    tenant_ids = {
        str(row[0])
        for row in db.query(PdpAccount.tenant_id)
        .filter(
            PdpAccount.provider == "seqino",
            PdpAccount.provider_client_id == client_id,
        )
        .all()
        if row[0]
    }
    if not tenant_ids:
        connections = db.query(PdpConnection).filter(PdpConnection.provider_slug == "seqino").all()
        for connection in connections:
            credentials = decrypt_payload(connection.encrypted_credentials) if connection.encrypted_credentials else {}
            stored_client_id = credentials.get("seqino_client_id") or credentials.get("client_id")
            if str(stored_client_id or "").strip() == client_id:
                tenant_ids.add(str(connection.tenant_id))
    if not tenant_ids:
        raise SeqinoWebhookError(
            "Client webhook plateforme partenaire inconnu.",
            code="seqino_webhook_client_unknown",
            status_code=404,
        )
    if len(tenant_ids) != 1:
        raise SeqinoWebhookError(
            "Client webhook plateforme partenaire ambigu.",
            code="seqino_webhook_client_ambiguous",
            status_code=409,
        )
    return next(iter(tenant_ids))


def _apply_invoice_status(
    db: Session,
    *,
    tenant_id: str,
    data: dict[str, Any],
    event_id: str,
    timestamp: str,
) -> int:
    invoice_id = str(data.get("invoice_id") or "").strip()
    raw_status = str(data.get("status") or "").strip()
    if not invoice_id or not raw_status:
        raise SeqinoWebhookError(
            "Statut webhook facture incomplet.",
            code="seqino_webhook_payload_invalid",
            status_code=400,
        )
    status = _map_lifecycle_status(None, raw_status)
    if status == "unknown":
        raise SeqinoWebhookError(
            "Statut webhook facture inconnu.",
            code="seqino_webhook_status_unknown",
            status_code=422,
        )
    updated = 0
    transmissions = (
        db.query(EInvoicingTransmission)
        .join(Invoice, Invoice.id == EInvoicingTransmission.invoice_id)
        .filter(
            Invoice.tenant_id == tenant_id,
            EInvoicingTransmission.channel == "seqino",
            EInvoicingTransmission.external_id == invoice_id,
        )
        .all()
    )
    for transmission in transmissions:
        history = list(transmission.events or []) if isinstance(transmission.events, list) else []
        history.append(
            {
                "event_type": "status_update",
                "event_id": event_id,
                "status": status,
                "raw_status": raw_status,
                "occurred_at": timestamp,
                "source": "seqino_webhook",
            }
        )
        transmission.events = history
        if is_transition_allowed(transmission.status, status):
            transmission.status = status
        transmission.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(transmission)
        updated += 1

    inbound = (
        db.query(InboundInvoice)
        .filter(
            InboundInvoice.tenant_id == tenant_id,
            InboundInvoice.provider_slug == "seqino",
            InboundInvoice.external_message_id == invoice_id,
        )
        .first()
    )
    if inbound:
        inbound.status = status
        inbound.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(inbound)
        updated += 1
    return updated


def _apply_mandate_status(
    db: Session,
    *,
    tenant_id: str,
    event_type: str,
    data: dict[str, Any],
) -> int:
    mandate_id = str(data.get("mandate_id") or "").strip()
    if not mandate_id:
        raise SeqinoWebhookError(
            "Mandat webhook plateforme partenaire incomplet.",
            code="seqino_webhook_payload_invalid",
            status_code=400,
        )
    status = {
        "mandate.created": "PENDING_KYB",
        "mandate.activated": "ACTIVE",
        "mandate.expired": "EXPIRED",
        "mandate.failed": "FAILED",
        "mandate.revoked": "REVOKED",
    }[event_type]
    # Lock the tenant connection first so mandate events for the same tenant are
    # serialized even when they concern different mandate ids.  The aggregate
    # connection status below must never be computed from two concurrent,
    # partially-applied lifecycle events.
    connection = (
        db.query(PdpConnection)
        .filter(
            PdpConnection.tenant_id == tenant_id,
            PdpConnection.provider_slug == "seqino",
        )
        .with_for_update()
        .first()
    )
    mandate = (
        db.query(PdpMandate)
        .filter(
            PdpMandate.tenant_id == tenant_id,
            PdpMandate.provider_slug == "seqino",
            PdpMandate.mandate_id == mandate_id,
        )
        .with_for_update()
        .first()
    )
    if not mandate:
        mandate = PdpMandate(
            tenant_id=tenant_id,
            provider_slug="seqino",
            mandate_id=mandate_id,
        )
    current_status = str(mandate.status or "").strip().upper()
    status_changed = False
    # A terminal provider decision is final for one mandate id.  A delayed
    # activation/creation webhook must not resurrect a revoked, expired or
    # failed authority.  ACTIVE also never regresses to a delayed creation
    # event; a new onboarding attempt must use a new mandate id.
    transition_allowed = current_status not in _TERMINAL_MANDATE_STATUSES and not (
        current_status in _ACTIVE_MANDATE_STATUSES and status in _PENDING_MANDATE_STATUSES
    )
    if transition_allowed and current_status != status:
        mandate.status = status
        mandate.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(mandate)
        status_changed = True

    db.flush()
    active_count = (
        db.query(func.count(PdpMandate.id))
        .filter(
            PdpMandate.tenant_id == tenant_id,
            PdpMandate.provider_slug == "seqino",
            func.upper(func.trim(func.coalesce(PdpMandate.status, ""))).in_(_ACTIVE_MANDATE_STATUSES),
        )
        .scalar()
        or 0
    )
    if connection:
        next_connection_status = "connected" if active_count > 0 else "pending"
        if (connection.status or "").strip().lower() != next_connection_status:
            connection.status = next_connection_status
            connection.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.add(connection)
    return int(status_changed)


@router.post("")
async def receive_seqino_webhook(request: Request, db: Session = Depends(get_db)):
    content_length = request.headers.get("content-length")
    try:
        declared_length = int(content_length) if content_length is not None else None
    except (TypeError, ValueError):
        declared_length = None
    if declared_length is not None and declared_length > _MAX_WEBHOOK_BYTES:
        raise HTTPException(413, detail={"code": "seqino_webhook_too_large", "message": "Webhook trop volumineux."})
    payload = await request.body()
    if len(payload) > _MAX_WEBHOOK_BYTES:
        raise HTTPException(413, detail={"code": "seqino_webhook_too_large", "message": "Webhook trop volumineux."})

    secret = str(settings.SEQINO_WEBHOOK_SECRET or "").strip()
    sponsor_id = str(settings.SEQINO_SPONSOR_ID or "").strip()
    if not secret or not sponsor_id:
        raise HTTPException(
            503,
            detail={
                "code": "seqino_webhook_config_missing",
                "message": "Reception webhook plateforme partenaire non configuree.",
            },
        )
    try:
        event = verify_webhook_payload(
            payload,
            request.headers.get("X-Webhook-Signature"),
            secret=secret,
            expected_sponsor_id=sponsor_id,
        )
        event_type = str(event["event_type"])
        if event_type not in _SUPPORTED_EVENTS:
            raise SeqinoWebhookError(
                "Type webhook plateforme partenaire non supporte.",
                code="seqino_webhook_event_unsupported",
                status_code=422,
            )
        data = event["data"]
        if event_type == "webhook.test":
            tenant_id = None
        else:
            client_id = str(data.get("client_id") or "").strip()
            if not client_id:
                raise SeqinoWebhookError(
                    "client_id webhook plateforme partenaire manquant.",
                    code="seqino_webhook_payload_invalid",
                    status_code=400,
                )
            tenant_id = _tenant_for_client(db, client_id)
        processing_skipped_reason = None
        if tenant_id:
            if settings.EINVOICING_EXPORT_ONLY:
                processing_skipped_reason = "export_only"
            elif not connected_mode_tenant_is_allowed(tenant_id):
                processing_skipped_reason = "connected_mode_tenant_not_allowed"
        replay_key = claim_webhook_event(str(event["sponsor_id"]), str(event["event_id"]))
    except SeqinoWebhookError as exc:
        raise _error(exc) from exc

    try:
        updated = 0
        job_id = None
        poll_skipped_reason = None
        if processing_skipped_reason:
            if event_type == "invoice.received":
                poll_skipped_reason = processing_skipped_reason
        elif event_type == "invoice.received" and tenant_id:
            access = connected_mode_decision(db, tenant_id, "seqino")
            if access.allowed:
                job = enqueue_inbox_poll_for_tenant(tenant_id, "seqino")
                job_id = job.get("job_id")
            else:
                poll_skipped_reason = access.code or "connected_mode_not_operational"
        elif event_type == "invoice.status_updated" and tenant_id:
            updated = _apply_invoice_status(
                db,
                tenant_id=tenant_id,
                data=data,
                event_id=str(event["event_id"]),
                timestamp=str(event["timestamp"]),
            )
        elif event_type.startswith("mandate.") and tenant_id:
            updated = _apply_mandate_status(
                db,
                tenant_id=tenant_id,
                event_type=event_type,
                data=data,
            )
        db.commit()
    except Exception:
        db.rollback()
        release_webhook_event(replay_key)
        raise HTTPException(
            503,
            detail={
                "code": "seqino_webhook_processing_failed",
                "message": "Traitement webhook plateforme partenaire indisponible.",
            },
        )

    return {
        "ok": True,
        "event_id": event["event_id"],
        "event_type": event_type,
        "updated": updated,
        "job_id": job_id,
        "poll_skipped_reason": poll_skipped_reason,
        "processing_skipped_reason": processing_skipped_reason,
    }
