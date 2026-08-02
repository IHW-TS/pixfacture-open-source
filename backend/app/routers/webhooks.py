from __future__ import annotations

import logging
from datetime import datetime, timezone
from urllib.parse import urlparse
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import WebhookEndpoint
from ..deps import require_paid_subscription, require_product_feature, require_tenant_admin, AuthUser
from ..services.action_logs import log_action
from ..services.webhooks import normalize_webhook_events, DEFAULT_WEBHOOK_EVENTS
from ..jobs.webhooks import collect_webhook_outbox_summary
from ..utils.crypto import encrypt_payload
from ..utils.public_provider_messages import sanitize_public_provider_message
from ..utils.customer_webhook_security import (
    CustomerWebhookResolutionError,
    validate_customer_webhook_url,
)

logger = logging.getLogger("webhooks.router")

router = APIRouter(
    prefix="/api/webhooks",
    tags=["webhooks"],
    dependencies=[Depends(require_product_feature("einvoicing_enabled"))],
)


class WebhookCreate(BaseModel):
    url: str
    events: list[str] | None = None
    secret: str | None = None
    status: str | None = None


class WebhookUpdate(BaseModel):
    url: str | None = None
    events: list[str] | None = None
    secret: str | None = None
    status: str | None = None


def _normalize_status(value: str | None) -> str:
    normalized = (value or "active").strip().lower()
    if normalized not in {"active", "disabled"}:
        raise HTTPException(400, "status invalide (active/disabled).")
    return normalized


def _encode_secret(value: str | None) -> bytes | None:
    secret = (value or "").strip()
    if not secret:
        return None
    return encrypt_payload({"secret": secret})


def _validated_webhook_url(value: str) -> str:
    try:
        return validate_customer_webhook_url(value)
    except CustomerWebhookResolutionError as exc:
        logger.info(
            "webhook_dns_unavailable",
            extra={"error_type": exc.__class__.__name__},
        )
        raise HTTPException(
            422,
            detail={
                "code": "webhook_dns_unavailable",
                "message": "Le nom de domaine du webhook ne peut pas être vérifié pour le moment.",
            },
        ) from exc
    except Exception as exc:
        logger.info("webhook_url_rejected", extra={"error_type": exc.__class__.__name__})
        raise HTTPException(
            400,
            detail={
                "code": "webhook_url_invalid",
                "message": "L'adresse du webhook n'est pas autorisée.",
            },
        ) from exc


def _serialize(endpoint: WebhookEndpoint) -> dict[str, Any]:
    last_error_message = None
    if endpoint.last_error_message:
        last_error_message = sanitize_public_provider_message(
            endpoint.last_error_message,
            fallback="Le dernier envoi du webhook a échoué.",
            max_chars=240,
        )
    return {
        "id": endpoint.id,
        "url": endpoint.url,
        "status": endpoint.status,
        "events": endpoint.events or list(DEFAULT_WEBHOOK_EVENTS),
        "last_status_code": endpoint.last_status_code,
        "last_success_at": endpoint.last_success_at.isoformat() if endpoint.last_success_at else None,
        "last_failure_at": endpoint.last_failure_at.isoformat() if endpoint.last_failure_at else None,
        "last_error_message": last_error_message,
        "created_at": endpoint.created_at.isoformat() if endpoint.created_at else None,
        "updated_at": endpoint.updated_at.isoformat() if endpoint.updated_at else None,
    }


def _url_host(value: str | None) -> str:
    if not value:
        return ""
    parsed = urlparse(value)
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    if parsed.scheme and host:
        return f"{parsed.scheme}://{host}"
    return host


@router.get("")
def list_webhooks(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    rows = (
        db.query(WebhookEndpoint)
        .filter(WebhookEndpoint.tenant_id == user.tenant_id)
        .order_by(WebhookEndpoint.created_at.desc())
        .all()
    )
    return [_serialize(row) for row in rows]


@router.get("/outbox/summary")
def webhook_outbox_summary(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    return collect_webhook_outbox_summary(db, tenant_id=user.tenant_id)


@router.post("")
def create_webhook(
    body: WebhookCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_paid_subscription),
):
    url = _validated_webhook_url(body.url)
    try:
        events = normalize_webhook_events(body.events)
    except ValueError as exc:
        raise HTTPException(
            400,
            detail={
                "code": "webhook_events_invalid",
                "message": sanitize_public_provider_message(
                    exc,
                    fallback="La liste des événements du webhook est invalide.",
                ),
            },
        ) from exc
    status = _normalize_status(body.status)
    endpoint = WebhookEndpoint(
        tenant_id=user.tenant_id,
        url=url,
        status=status,
        events=events,
        encrypted_secret=_encode_secret(body.secret),
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        updated_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(endpoint)
    db.flush()
    log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="webhook_create",
        object_type="webhook",
        object_id=str(endpoint.id),
        metadata={
            "url_host": _url_host(url),
            "status": status,
            "event_count": len(events),
            "events": events,
            "secret_set": bool(body.secret),
        },
    )
    db.commit()
    db.refresh(endpoint)
    return _serialize(endpoint)


@router.patch("/{endpoint_id}")
def update_webhook(
    endpoint_id: str,
    body: WebhookUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_paid_subscription),
):
    endpoint = db.get(WebhookEndpoint, endpoint_id)
    if not endpoint or endpoint.tenant_id != user.tenant_id:
        raise HTTPException(404, "Webhook introuvable.")
    payload = body.model_dump(exclude_unset=True)
    if "url" in payload:
        endpoint.url = _validated_webhook_url(payload["url"])
    if "events" in payload:
        try:
            endpoint.events = normalize_webhook_events(payload["events"])
        except ValueError as exc:
            raise HTTPException(
                400,
                detail={
                    "code": "webhook_events_invalid",
                    "message": sanitize_public_provider_message(
                        exc,
                        fallback="La liste des événements du webhook est invalide.",
                    ),
                },
            ) from exc
    if "status" in payload:
        endpoint.status = _normalize_status(payload["status"])
    if "secret" in payload:
        endpoint.encrypted_secret = _encode_secret(payload["secret"])
    endpoint.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(endpoint)
    log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="webhook_update",
        object_type="webhook",
        object_id=str(endpoint.id),
        metadata={
            "updated_fields": list(payload.keys()),
            "url_host": _url_host(endpoint.url),
            "status": endpoint.status,
            "event_count": len(endpoint.events or []),
            "events": endpoint.events or [],
            "secret_set": "secret" in payload and bool(payload.get("secret")),
        },
    )
    db.commit()
    db.refresh(endpoint)
    return _serialize(endpoint)


@router.delete("/{endpoint_id}")
def delete_webhook(
    endpoint_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    endpoint = db.get(WebhookEndpoint, endpoint_id)
    if not endpoint or endpoint.tenant_id != user.tenant_id:
        raise HTTPException(404, "Webhook introuvable.")
    log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="webhook_delete",
        object_type="webhook",
        object_id=str(endpoint.id),
        metadata={"url_host": _url_host(endpoint.url), "status": endpoint.status},
    )
    db.delete(endpoint)
    db.commit()
    return {"ok": True}
