import asyncio
import hashlib
import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import InboundInvoice, PdpConnection
from ..services.inbox import ingest_inbound_message
from ..services.pdp import get_provider
from ..services.pdp.base import InboundMessage
from ..services.seqino_mandates import seqino_has_active_mandate
from ..utils.crypto import decrypt_payload
from ..services.integration_secrets import enrich_credentials_with_secrets
from ..services.connected_mode import connected_mode_decision
from .queue import enqueue_job

logger = logging.getLogger(__name__)


def _resolve_provider(db: Session, conn: PdpConnection):
    tenant_id = str(conn.tenant_id or "").strip()
    provider_slug = str(conn.provider_slug or "").strip()
    if not tenant_id or not provider_slug:
        raise ValueError("Connexion fournisseur incomplète.")
    creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
    creds["_tenant_id"] = tenant_id
    creds = enrich_credentials_with_secrets(db, tenant_id, creds)
    return get_provider(provider_slug, creds)


def _message_id(message: InboundMessage | dict) -> str | None:
    if isinstance(message, InboundMessage):
        return message.message_id
    if isinstance(message, dict):
        return message.get("message_id") or message.get("id") or message.get("external_message_id")
    return None


def _latest_received_at(db: Session, tenant_id: str, provider_slug: str | None) -> str | None:
    if not provider_slug:
        return None
    row = (
        db.query(InboundInvoice.received_at, InboundInvoice.created_at)
        .filter(InboundInvoice.tenant_id == tenant_id, InboundInvoice.provider_slug == provider_slug)
        .order_by(InboundInvoice.received_at.desc().nullslast(), InboundInvoice.created_at.desc())
        .first()
    )
    if not row:
        return None
    received_at = row[0] or row[1]
    if not received_at:
        return None
    return received_at.isoformat()


def _dedupe_key(tenant_id: str, message: InboundMessage | dict) -> str | None:
    message_id = None
    if isinstance(message, InboundMessage):
        message_id = message.message_id
    elif isinstance(message, dict):
        message_id = message.get("message_id") or message.get("id") or message.get("external_message_id")
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else None
        if payload and not message_id:
            message_id = payload.get("external_message_id") or payload.get("id")
    if not message_id:
        return None
    raw = f"{tenant_id}:{message_id}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def _poll_connection(db: Session, conn: PdpConnection) -> dict:
    tenant_id = str(conn.tenant_id or "").strip()
    provider_slug = str(conn.provider_slug or "").strip()
    summary: dict[str, Any] = {
        "tenant_id": tenant_id or None,
        "provider": provider_slug or None,
        "received": 0,
        "errors": 0,
        "skipped": 0,
    }
    if not tenant_id or not provider_slug:
        summary["skipped"] += 1
        return summary
    access = connected_mode_decision(db, tenant_id, provider_slug)
    if not access.allowed:
        summary["skipped"] += 1
        logger.info(
            json.dumps(
                {
                    "event": "pdp_inbox_poll_skip",
                    "provider": provider_slug,
                    "tenant_id": tenant_id,
                    "reason": access.code or "connected_mode_not_operational",
                }
            )
        )
        return summary
    if provider_slug.lower() == "seqino":
        if not seqino_has_active_mandate(tenant_id, db=db):
            summary["skipped"] += 1
            logger.info(
                json.dumps(
                    {
                        "event": "pdp_inbox_poll_skip",
                        "provider": "seqino",
                        "tenant_id": tenant_id,
                        "reason": "mandate_missing",
                    }
                )
            )
            return summary
    try:
        provider = _resolve_provider(db, conn)
    except Exception:
        summary["errors"] += 1
        return summary
    try:
        since_cursor = _latest_received_at(db, tenant_id, provider_slug)
        messages = await provider.fetch_inbox(since_cursor=since_cursor)
    except NotImplementedError:
        return summary
    except Exception:
        summary["errors"] += 1
        return summary
    message_ids = [msg_id for msg_id in (_message_id(msg) for msg in messages or []) if msg_id]
    existing_ids: set[str] = set()
    if message_ids:
        rows = (
            db.query(InboundInvoice.external_message_id)
            .filter(
                InboundInvoice.tenant_id == tenant_id,
                InboundInvoice.external_message_id.in_(message_ids),
            )
            .all()
        )
        existing_ids = {row[0] for row in rows if row[0]}

    seen: set[str] = set()
    for message in messages or []:
        message_id = _message_id(message)
        if message_id and message_id in existing_ids:
            summary["skipped"] += 1
            continue
        key = _dedupe_key(tenant_id, message)
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        try:
            ingest_inbound_message(
                db,
                tenant_id=tenant_id,
                provider_slug=provider_slug,
                message=message,
            )
            db.commit()
            summary["received"] += 1
        except Exception:
            db.rollback()
            summary["errors"] += 1
            continue
    return summary


async def poll_inbox(limit: int | None = None) -> dict:
    summary = {"ok": True, "connections": 0, "received": 0, "errors": 0, "skipped": 0}
    with SessionLocal() as db:
        q = db.query(PdpConnection).filter(PdpConnection.status == "connected")
        if limit:
            q = q.limit(limit)
        conns = q.all()
        for conn in conns:
            summary["connections"] += 1
            if not conn.provider_slug:
                summary["skipped"] += 1
                continue
            result = await _poll_connection(db, conn)
            summary["received"] += result.get("received", 0)
            summary["errors"] += result.get("errors", 0)
            summary["skipped"] += result.get("skipped", 0)
    logger.info(json.dumps({"event": "pdp_inbox_poll_done", "summary": summary}))
    return summary


def run_poll_inbox(limit: int | None = None) -> dict:
    return asyncio.run(poll_inbox(limit=limit))


def poll_inbox_job(limit: int | None = None) -> dict:
    return run_poll_inbox(limit=limit)


def poll_inbox_tenant_job(tenant_id: str, provider_slug: str = "seqino") -> dict:
    with SessionLocal() as db:
        return asyncio.run(
            poll_inbox_for_tenant(
                db,
                tenant_id,
                provider_slug=provider_slug,
            )
        )


def enqueue_inbox_poll_for_tenant(tenant_id: str, provider_slug: str = "seqino") -> dict:
    return enqueue_job(
        poll_inbox_tenant_job,
        tenant_id,
        provider_slug,
        queue_name="integrations",
        meta={"tenant_id": tenant_id, "provider": provider_slug, "source": "provider_webhook"},
        description=f"inbox-poll:{provider_slug}:{tenant_id}",
    )


async def poll_inbox_for_tenant(
    db: Session,
    tenant_id: str,
    provider_slug: str | None = None,
    limit: int | None = None,
) -> dict:
    summary = {"ok": True, "connections": 0, "received": 0, "errors": 0, "skipped": 0}
    q = db.query(PdpConnection).filter(
        PdpConnection.tenant_id == tenant_id,
        PdpConnection.status == "connected",
    )
    if provider_slug:
        q = q.filter(PdpConnection.provider_slug == provider_slug)
    if limit:
        q = q.limit(limit)
    conns = q.all()
    for conn in conns:
        summary["connections"] += 1
        result = await _poll_connection(db, conn)
        summary["received"] += result.get("received", 0)
        summary["errors"] += result.get("errors", 0)
        summary["skipped"] += result.get("skipped", 0)
    return summary
