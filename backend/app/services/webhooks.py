from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    EInvoicingTransmission,
    Invoice,
    WebhookDeliveryOutbox,
    WebhookEndpoint,
)

logger = logging.getLogger("webhooks")

WEBHOOK_EVENT_EINVOICE_ACCEPTED = "invoice.einvoicing.accepted"
WEBHOOK_EVENT_EINVOICE_REFUSED = "invoice.einvoicing.refused"
WEBHOOK_EVENT_EINVOICE_REJECTED = "invoice.einvoicing.rejected"

ALLOWED_WEBHOOK_EVENTS = {
    WEBHOOK_EVENT_EINVOICE_ACCEPTED,
    WEBHOOK_EVENT_EINVOICE_REFUSED,
    WEBHOOK_EVENT_EINVOICE_REJECTED,
}

DEFAULT_WEBHOOK_EVENTS = [
    WEBHOOK_EVENT_EINVOICE_ACCEPTED,
    WEBHOOK_EVENT_EINVOICE_REFUSED,
    WEBHOOK_EVENT_EINVOICE_REJECTED,
]

_STATUS_EVENT_MAP = {
    "accepted": WEBHOOK_EVENT_EINVOICE_ACCEPTED,
    "refused": WEBHOOK_EVENT_EINVOICE_REFUSED,
    "rejected": WEBHOOK_EVENT_EINVOICE_REJECTED,
}


def normalize_webhook_events(values: list[str] | None) -> list[str]:
    if not values:
        return list(DEFAULT_WEBHOOK_EVENTS)
    normalized: list[str] = []
    for raw in values:
        item = (raw or "").strip().lower()
        if not item:
            continue
        if item not in ALLOWED_WEBHOOK_EVENTS:
            raise ValueError(f"webhook_event_invalid:{item}")
        if item not in normalized:
            normalized.append(item)
    return normalized


def _endpoint_accepts_event(endpoint: WebhookEndpoint, event_type: str) -> bool:
    events = endpoint.events or []
    if not isinstance(events, list):
        return False
    return event_type in events


def _canonical_json(value: object) -> object:
    """Return a JSON-safe value with deterministic string conversion."""

    return json.loads(
        json.dumps(
            value,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
            default=str,
        )
    )


def _stable_event_id(*, tenant_id: str, transmission_id: str, event_type: str) -> str:
    fingerprint = f"{tenant_id}|{transmission_id}|{event_type}"
    return "evt_" + hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()


def _delivery_identity(*, endpoint_id: str, event_id: str) -> tuple[str, str]:
    idempotency_key = "webhook:" + hashlib.sha256(
        f"{endpoint_id}|{event_id}".encode("utf-8")
    ).hexdigest()
    delivery_id = str(
        uuid5(NAMESPACE_URL, f"pixfacture:customer-webhook:{idempotency_key}")
    )
    return delivery_id, idempotency_key


def _max_attempts() -> int:
    configured = int(getattr(settings, "WEBHOOK_DELIVERY_MAX_ATTEMPTS", 8) or 8)
    return max(1, min(configured, 20))


def _persist_delivery_once(
    db: Session,
    *,
    endpoint: WebhookEndpoint,
    tenant_id: str,
    event_id: str,
    event_type: str,
    payload: dict,
    now: datetime,
) -> WebhookDeliveryOutbox:
    delivery_id, idempotency_key = _delivery_identity(
        endpoint_id=str(endpoint.id),
        event_id=event_id,
    )
    existing = (
        db.query(WebhookDeliveryOutbox)
        .filter(WebhookDeliveryOutbox.idempotency_key == idempotency_key)
        .first()
    )
    if existing is not None:
        if existing.tenant_id != tenant_id or existing.endpoint_id != endpoint.id:
            raise RuntimeError("Collision de clé d'idempotence webhook.")
        return existing

    values: dict[str, Any] = {
        "id": delivery_id,
        "tenant_id": tenant_id,
        "endpoint_id": endpoint.id,
        "event_id": event_id,
        "event_type": event_type,
        "payload": payload,
        "idempotency_key": idempotency_key,
        "status": "pending",
        "attempt_count": 0,
        "max_attempts": _max_attempts(),
        "next_attempt_at": now,
        "created_at": now,
        "updated_at": now,
    }
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        pg_statement = postgresql_insert(WebhookDeliveryOutbox).values(**values)
        pg_statement = pg_statement.on_conflict_do_nothing(
            index_elements=[WebhookDeliveryOutbox.idempotency_key]
        )
        db.execute(pg_statement)
    elif dialect == "sqlite":
        sqlite_statement = sqlite_insert(WebhookDeliveryOutbox).values(**values)
        sqlite_statement = sqlite_statement.on_conflict_do_nothing(
            index_elements=[WebhookDeliveryOutbox.idempotency_key]
        )
        db.execute(sqlite_statement)
    else:
        # Supported production and test dialects use atomic ON CONFLICT above.
        # The generic fallback retains the unique database guard.
        db.add(
            WebhookDeliveryOutbox(
                id=delivery_id,
                tenant_id=tenant_id,
                endpoint_id=endpoint.id,
                event_id=event_id,
                event_type=event_type,
                payload=payload,
                idempotency_key=idempotency_key,
                status="pending",
                attempt_count=0,
                max_attempts=_max_attempts(),
                next_attempt_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        db.flush()

    persisted = db.get(WebhookDeliveryOutbox, delivery_id)
    if persisted is None:
        persisted = (
            db.query(WebhookDeliveryOutbox)
            .filter(WebhookDeliveryOutbox.idempotency_key == idempotency_key)
            .first()
        )
    if persisted is None:
        raise RuntimeError("Événement webhook introuvable après écriture de l'outbox.")
    if persisted.tenant_id != tenant_id or persisted.endpoint_id != endpoint.id:
        raise RuntimeError("Collision de clé d'idempotence webhook.")
    return persisted


def enqueue_einvoicing_webhooks(
    db: Session,
    *,
    tx: EInvoicingTransmission,
    event: dict | None = None,
) -> list[WebhookDeliveryOutbox]:
    """Persist customer webhook deliveries in the caller's transaction.

    Redis is intentionally not touched here. The database row is the source of
    truth and the worker sweeper dispatches committed rows independently.
    """

    status = (tx.status or "").strip().lower()
    event_type = _STATUS_EVENT_MAP.get(status)
    if not event_type:
        return []
    invoice = db.get(Invoice, tx.invoice_id)
    if not invoice:
        return []
    endpoints = (
        db.query(WebhookEndpoint)
        .filter(WebhookEndpoint.tenant_id == invoice.tenant_id, WebhookEndpoint.status == "active")
        .order_by(WebhookEndpoint.created_at.asc())
        .all()
    )
    if not endpoints:
        return []
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    created_at = now.replace(microsecond=0).isoformat() + "Z"
    event_id = _stable_event_id(
        tenant_id=str(invoice.tenant_id),
        transmission_id=str(tx.id),
        event_type=event_type,
    )
    base_payload = {
        "id": event_id,
        "type": event_type,
        "created_at": created_at,
        "data": {
            "invoice_id": invoice.id,
            "invoice_number": invoice.number,
            "transmission_id": tx.id,
            "channel": tx.channel,
            "status": tx.status,
            "external_id": tx.external_id,
            "event": _canonical_json(event or {}),
        },
    }
    canonical_payload = _canonical_json(base_payload)
    if not isinstance(canonical_payload, dict):
        raise RuntimeError("Payload webhook invalide.")
    deliveries: list[WebhookDeliveryOutbox] = []
    for endpoint in endpoints:
        if not _endpoint_accepts_event(endpoint, event_type):
            continue
        delivery = _persist_delivery_once(
            db,
            endpoint=endpoint,
            tenant_id=str(invoice.tenant_id),
            event_id=event_id,
            event_type=event_type,
            payload=canonical_payload,
            now=now,
        )
        deliveries.append(delivery)
    if deliveries:
        logger.info(
            "webhook_outbox_persisted",
            extra={
                "event_type": event_type,
                "transmission_id": tx.id,
                "delivery_count": len(deliveries),
            },
        )
    return deliveries
