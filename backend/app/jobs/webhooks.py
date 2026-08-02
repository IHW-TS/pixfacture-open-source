from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import httpx
from rq import Queue
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from .. import metrics
from ..config import settings
from ..db import SessionLocal
from ..models import Tenant, WebhookDeliveryOutbox, WebhookEndpoint
from ..services.product_capabilities import billing_enabled
from ..services.action_logs import log_action
from ..utils.crypto import decrypt_payload
from ..utils.customer_webhook_security import (
    CustomerWebhookResolutionError,
    resolve_customer_webhook_target,
)
from .queue import (
    _get_redis_connection,
    enqueue_job,
    is_sync_mode,
    queue_name_for,
)

logger = logging.getLogger("webhooks.delivery")

TERMINAL_STATUSES = frozenset({"delivered", "failed", "cancelled"})
RETRYABLE_HTTP_STATUSES = frozenset({408, 425, 429})


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _bounded_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(getattr(settings, name, default) or default)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


def _decode_secret(encrypted: bytes | None) -> str | None:
    if not encrypted:
        return None
    payload = decrypt_payload(encrypted)
    secret = payload.get("secret")
    if not secret:
        return None
    return str(secret)


def _build_signature(secret: str, payload: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _endpoint_accepts_event(endpoint: WebhookEndpoint, event_type: str) -> bool:
    events = endpoint.events or []
    return isinstance(events, list) and event_type in events


def _retry_delay_seconds(delivery_id: str, attempt_count: int) -> int:
    base = _bounded_setting("WEBHOOK_RETRY_BASE_SECONDS", 30, 1, 3600)
    maximum = _bounded_setting("WEBHOOK_RETRY_MAX_SECONDS", 3600, base, 86400)
    exponential = min(base * (2 ** max(0, attempt_count - 1)), maximum)
    # Stable bounded jitter avoids synchronized retry bursts while keeping
    # tests and incident reconstruction deterministic.
    digest = hashlib.sha256(f"{delivery_id}:{attempt_count}".encode("utf-8")).digest()
    jitter_cap = max(1, min(base, exponential) // 4)
    jitter = int.from_bytes(digest[:2], "big") % (jitter_cap + 1)
    return min(exponential + jitter, maximum)


def _lock_ttl_seconds() -> int:
    configured = _bounded_setting(
        "WEBHOOK_OUTBOX_LOCK_TTL_SECONDS",
        300,
        30,
        3600,
    )
    request_timeout = _bounded_setting("WEBHOOK_TIMEOUT_SECONDS", 8, 1, 30)
    return max(configured, (request_timeout * 2) + 30)


def _retry_after_seconds(response: httpx.Response) -> int | None:
    value = str(response.headers.get("Retry-After") or "").strip()
    if not value or not value.isdigit():
        return None
    return max(1, min(int(value), 86400))


def _delivery_metadata(
    delivery: WebhookDeliveryOutbox,
    *,
    outcome: str,
    status_code: int | None,
    error_code: str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = (
        delivery.payload if isinstance(delivery.payload, dict) else {}
    )
    raw_data: object = payload.get("data")
    data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else {}
    metadata: dict[str, Any] = {
        "delivery_id": delivery.id,
        "event_id": delivery.event_id,
        "event_type": delivery.event_type,
        "attempt_count": int(delivery.attempt_count or 0),
        "outcome": outcome,
        "status_code": status_code,
        "invoice_id": data.get("invoice_id"),
        "transmission_id": data.get("transmission_id"),
        "channel": data.get("channel"),
        "status": data.get("status"),
    }
    if error_code:
        metadata["error_code"] = error_code
    return metadata


def _claim_delivery(
    db: Session,
    delivery_id: str,
    *,
    now: datetime,
) -> tuple[WebhookDeliveryOutbox, WebhookEndpoint, str] | None:
    lock_ttl = _lock_ttl_seconds()
    stale_before = now - timedelta(seconds=lock_ttl)
    lock_token = uuid4().hex
    eligible = or_(
        and_(
            WebhookDeliveryOutbox.status.in_(("pending", "retry")),
            WebhookDeliveryOutbox.next_attempt_at <= now,
        ),
        WebhookDeliveryOutbox.status == "queued",
        and_(
            WebhookDeliveryOutbox.status == "processing",
            WebhookDeliveryOutbox.locked_at.is_not(None),
            WebhookDeliveryOutbox.locked_at <= stale_before,
        ),
    )
    claimed = (
        db.query(WebhookDeliveryOutbox)
        .filter(
            WebhookDeliveryOutbox.id == delivery_id,
            WebhookDeliveryOutbox.attempt_count < WebhookDeliveryOutbox.max_attempts,
            eligible,
        )
        .update(
            {
                WebhookDeliveryOutbox.status: "processing",
                WebhookDeliveryOutbox.attempt_count: WebhookDeliveryOutbox.attempt_count + 1,
                WebhookDeliveryOutbox.locked_at: now,
                WebhookDeliveryOutbox.lock_token: lock_token,
                WebhookDeliveryOutbox.last_attempt_at: now,
                WebhookDeliveryOutbox.updated_at: now,
            },
            synchronize_session=False,
        )
    )
    db.commit()
    if not claimed:
        return None
    delivery = (
        db.query(WebhookDeliveryOutbox)
        .filter(
            WebhookDeliveryOutbox.id == delivery_id,
            WebhookDeliveryOutbox.lock_token == lock_token,
            WebhookDeliveryOutbox.status == "processing",
        )
        .first()
    )
    if delivery is None:
        return None
    endpoint = db.get(WebhookEndpoint, delivery.endpoint_id) if delivery.endpoint_id else None
    if endpoint is None:
        _finish_delivery(
            db,
            delivery=delivery,
            endpoint=None,
            lock_token=lock_token,
            status="cancelled",
            status_code=None,
            error_code="webhook_endpoint_missing",
            error_message="Le webhook n’existe plus ; l’envoi a été annulé.",
            next_attempt_at=None,
        )
        return None
    if endpoint.tenant_id != delivery.tenant_id:
        _finish_delivery(
            db,
            delivery=delivery,
            endpoint=None,
            lock_token=lock_token,
            status="cancelled",
            status_code=None,
            error_code="webhook_tenant_mismatch",
            error_message="L’envoi a été annulé par le contrôle d’isolation.",
            next_attempt_at=None,
        )
        metrics.inc_operational_event("webhook_tenant_guard_failure")
        logger.error(
            "webhook_tenant_guard_failure",
            extra={"delivery_id": delivery.id, "endpoint_id": delivery.endpoint_id},
        )
        return None
    tenant = db.get(Tenant, delivery.tenant_id)
    subscription_status = (
        str(getattr(tenant, "subscription_status", None) or "").strip().lower()
        if tenant is not None
        else ""
    )
    if tenant is None or subscription_status == "trialing" or (
        billing_enabled() and subscription_status != "active"
    ):
        _finish_delivery(
            db,
            delivery=delivery,
            endpoint=endpoint,
            lock_token=lock_token,
            status="cancelled",
            status_code=None,
            error_code="webhook_paid_subscription_required",
            error_message="L’envoi a été annulé car aucun abonnement payant actif ne l’autorise.",
            next_attempt_at=None,
        )
        return None
    event_type = str(delivery.event_type or "")
    if endpoint.status != "active" or not _endpoint_accepts_event(endpoint, event_type):
        _finish_delivery(
            db,
            delivery=delivery,
            endpoint=endpoint,
            lock_token=lock_token,
            status="cancelled",
            status_code=None,
            error_code="webhook_disabled",
            error_message="Le webhook n’est plus actif ; l’envoi a été annulé.",
            next_attempt_at=None,
        )
        return None
    return delivery, endpoint, lock_token


def _finish_delivery(
    db: Session,
    *,
    delivery: WebhookDeliveryOutbox,
    endpoint: WebhookEndpoint | None,
    lock_token: str,
    status: str,
    status_code: int | None,
    error_code: str | None,
    error_message: str | None,
    next_attempt_at: datetime | None,
) -> bool:
    now = _utcnow()
    owned = (
        db.query(WebhookDeliveryOutbox)
        .filter(
            WebhookDeliveryOutbox.id == delivery.id,
            WebhookDeliveryOutbox.status == "processing",
            WebhookDeliveryOutbox.lock_token == lock_token,
        )
        .first()
    )
    if owned is None:
        db.rollback()
        return False
    owned.status = status
    owned.next_attempt_at = next_attempt_at or now
    owned.locked_at = None
    owned.lock_token = None
    owned.last_status_code = status_code
    owned.last_error_code = error_code
    owned.last_error_message = error_message
    owned.updated_at = now
    if status == "delivered":
        owned.delivered_at = now
        owned.last_error_code = None
        owned.last_error_message = None

    if endpoint is not None and endpoint.tenant_id == owned.tenant_id:
        endpoint.last_status_code = status_code
        if status == "delivered":
            endpoint.last_success_at = now
            endpoint.last_error_message = None
        elif status in {"retry", "failed"}:
            endpoint.last_failure_at = now
            endpoint.last_error_message = error_message
        endpoint.updated_at = now
        db.add(endpoint)

    log_action(
        db,
        tenant_id=str(owned.tenant_id),
        actor_user_id=None,
        action_type="webhook_delivery",
        object_type="webhook_delivery",
        object_id=str(owned.id),
        metadata=_delivery_metadata(
            owned,
            outcome=status,
            status_code=status_code,
            error_code=error_code,
        ),
    )
    db.add(owned)
    db.commit()
    return True


def _finish_after_io(
    delivery_id: str,
    *,
    endpoint_id: str,
    lock_token: str,
    status: str,
    status_code: int | None,
    error_code: str | None,
    error_message: str | None,
    next_attempt_at: datetime | None,
) -> bool:
    with SessionLocal() as db:
        delivery = db.get(WebhookDeliveryOutbox, delivery_id)
        if delivery is None:
            return False
        endpoint = db.get(WebhookEndpoint, endpoint_id)
        if endpoint is not None and endpoint.tenant_id != delivery.tenant_id:
            endpoint = None
        return _finish_delivery(
            db,
            delivery=delivery,
            endpoint=endpoint,
            lock_token=lock_token,
            status=status,
            status_code=status_code,
            error_code=error_code,
            error_message=error_message,
            next_attempt_at=next_attempt_at,
        )


def deliver_webhook_event(delivery_id: str) -> dict[str, Any]:
    now = _utcnow()
    with SessionLocal() as db:
        claimed = _claim_delivery(db, delivery_id, now=now)
        if claimed is None:
            return {"ok": True, "skipped": True}
        delivery, endpoint, lock_token = claimed
        endpoint_id = str(endpoint.id)
        endpoint_url = str(endpoint.url or "")
        encrypted_secret = endpoint.encrypted_secret
        event_type = str(delivery.event_type)
        event_id = str(delivery.event_id)
        attempt_count = int(delivery.attempt_count or 0)
        max_attempts = int(delivery.max_attempts or 1)
        payload = delivery.payload if isinstance(delivery.payload, dict) else {}

    try:
        target = resolve_customer_webhook_target(endpoint_url)
    except CustomerWebhookResolutionError:
        retry = attempt_count < max_attempts
        delay = _retry_delay_seconds(delivery_id, attempt_count)
        _finish_after_io(
            delivery_id,
            endpoint_id=endpoint_id,
            lock_token=lock_token,
            status="retry" if retry else "failed",
            status_code=None,
            error_code="webhook_dns_unavailable",
            error_message=(
                "Résolution DNS temporairement indisponible ; une nouvelle tentative est programmée."
                if retry
                else "Le nom de domaine du webhook n’a pas pu être résolu après plusieurs tentatives."
            ),
            next_attempt_at=now + timedelta(seconds=delay) if retry else None,
        )
        metrics.inc_operational_event(
            "webhook_delivery_retry" if retry else "webhook_delivery_failed"
        )
        logger.warning(
            "webhook_delivery_dns_unavailable",
            extra={"delivery_id": delivery_id, "attempt_count": attempt_count},
        )
        return {
            "ok": False,
            "retry": retry,
            "error": {"code": "webhook_dns_unavailable"},
        }
    except Exception:
        _finish_after_io(
            delivery_id,
            endpoint_id=endpoint_id,
            lock_token=lock_token,
            status="failed",
            status_code=None,
            error_code="webhook_url_invalid",
            error_message="L’adresse du webhook n’est plus autorisée.",
            next_attempt_at=None,
        )
        metrics.inc_operational_event("webhook_delivery_failed")
        return {"ok": False, "error": {"code": "webhook_url_invalid"}}

    body = json.dumps(
        payload,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    ).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "pixfacture-webhook/1.0",
        "X-Webhook-Event": event_type,
        "X-Webhook-Id": event_id,
        "X-Webhook-Delivery": delivery_id,
        "X-Webhook-Timestamp": str(int(time.time())),
    }
    error_code: str | None
    try:
        secret = _decode_secret(encrypted_secret)
    except Exception:
        secret = None
        error_code = "webhook_secret_invalid"
    else:
        error_code = None
    if error_code is not None:
        retry = attempt_count < max_attempts
        delay = _retry_delay_seconds(delivery_id, attempt_count)
        _finish_after_io(
            delivery_id,
            endpoint_id=endpoint_id,
            lock_token=lock_token,
            status="retry" if retry else "failed",
            status_code=None,
            error_code=error_code,
            error_message=(
                "La signature n’a pas pu être préparée ; une nouvelle tentative est programmée."
                if retry
                else "La signature du webhook n’a pas pu être préparée."
            ),
            next_attempt_at=now + timedelta(seconds=delay) if retry else None,
        )
        metrics.inc_operational_event(
            "webhook_delivery_retry" if retry else "webhook_delivery_failed"
        )
        return {"ok": False, "retry": retry, "error": {"code": error_code}}
    if secret:
        headers["X-Webhook-Signature"] = _build_signature(secret, body)

    timeout_seconds = float(_bounded_setting("WEBHOOK_TIMEOUT_SECONDS", 8, 1, 30))
    request_timeout = httpx.Timeout(
        timeout_seconds,
        connect=timeout_seconds,
        read=timeout_seconds,
        write=timeout_seconds,
        pool=timeout_seconds,
    )
    try:
        with httpx.Client(
            timeout=request_timeout,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            request = client.build_request(
                "POST",
                target.connect_url,
                content=body,
                headers={**headers, "Host": target.host_header},
                extensions={"sni_hostname": target.sni_hostname},
            )
            # The request URL contains the validated IP, so httpcore opens the
            # socket without another DNS lookup. Host and TLS SNI retain the
            # customer hostname. Redirects remain fail-closed.
            response = client.send(
                request,
                stream=True,
                follow_redirects=False,
            )
            try:
                status_code = int(response.status_code)
                retry_after_hint = _retry_after_seconds(response)
            finally:
                response.close()
    except Exception:
        retry = attempt_count < max_attempts
        delay = _retry_delay_seconds(delivery_id, attempt_count)
        _finish_after_io(
            delivery_id,
            endpoint_id=endpoint_id,
            lock_token=lock_token,
            status="retry" if retry else "failed",
            status_code=None,
            error_code="webhook_network_error",
            error_message=(
                "Échec temporaire ; une nouvelle tentative est programmée."
                if retry
                else "Le webhook n’a pas pu être joint après plusieurs tentatives."
            ),
            next_attempt_at=now + timedelta(seconds=delay) if retry else None,
        )
        metrics.inc_operational_event(
            "webhook_delivery_retry" if retry else "webhook_delivery_failed"
        )
        logger.warning(
            "webhook_delivery_network_error",
            extra={"delivery_id": delivery_id, "attempt_count": attempt_count},
        )
        return {
            "ok": False,
            "retry": retry,
            "error": {"code": "webhook_network_error"},
        }

    if 200 <= status_code < 300:
        _finish_after_io(
            delivery_id,
            endpoint_id=endpoint_id,
            lock_token=lock_token,
            status="delivered",
            status_code=status_code,
            error_code=None,
            error_message=None,
            next_attempt_at=None,
        )
        metrics.inc_operational_event("webhook_delivery_success")
        logger.info(
            "webhook_delivery_success",
            extra={
                "delivery_id": delivery_id,
                "attempt_count": attempt_count,
                "status_code": status_code,
            },
        )
        return {"ok": True, "status_code": status_code}

    retryable = status_code in RETRYABLE_HTTP_STATUSES or status_code >= 500
    retry = retryable and attempt_count < max_attempts
    retry_after = retry_after_hint if retry else None
    delay = retry_after or _retry_delay_seconds(delivery_id, attempt_count)
    _finish_after_io(
        delivery_id,
        endpoint_id=endpoint_id,
        lock_token=lock_token,
        status="retry" if retry else "failed",
        status_code=status_code,
        error_code="webhook_http_error",
        error_message=(
            "Réponse temporaire du webhook ; une nouvelle tentative est programmée."
            if retry
            else f"Le webhook a refusé l’envoi (HTTP {status_code})."
        ),
        next_attempt_at=now + timedelta(seconds=delay) if retry else None,
    )
    metrics.inc_operational_event(
        "webhook_delivery_retry" if retry else "webhook_delivery_failed"
    )
    logger.warning(
        "webhook_delivery_http_error",
        extra={
            "delivery_id": delivery_id,
            "attempt_count": attempt_count,
            "status_code": status_code,
            "retry": retry,
        },
    )
    return {
        "ok": False,
        "status_code": status_code,
        "retry": retry,
        "error": {"code": "webhook_http_error"},
    }


def _mark_exhausted_orphans(db: Session, *, now: datetime) -> int:
    lock_ttl = _lock_ttl_seconds()
    stale_before = now - timedelta(seconds=lock_ttl)
    updated = (
        db.query(WebhookDeliveryOutbox)
        .filter(
            WebhookDeliveryOutbox.attempt_count >= WebhookDeliveryOutbox.max_attempts,
            or_(
                WebhookDeliveryOutbox.status == "retry",
                and_(
                    WebhookDeliveryOutbox.status == "processing",
                    WebhookDeliveryOutbox.locked_at <= stale_before,
                ),
            ),
        )
        .update(
            {
                WebhookDeliveryOutbox.status: "failed",
                WebhookDeliveryOutbox.locked_at: None,
                WebhookDeliveryOutbox.lock_token: None,
                WebhookDeliveryOutbox.last_error_code: "webhook_attempts_exhausted",
                WebhookDeliveryOutbox.last_error_message: (
                    "Le webhook n’a pas pu être livré après plusieurs tentatives."
                ),
                WebhookDeliveryOutbox.updated_at: now,
            },
            synchronize_session=False,
        )
    )
    if updated:
        db.commit()
    return int(updated or 0)


def enqueue_due_webhook_deliveries(limit: int | None = None) -> dict[str, int | bool]:
    now = _utcnow()
    batch_size = limit or _bounded_setting("WEBHOOK_OUTBOX_BATCH_SIZE", 100, 1, 1000)
    batch_size = max(1, min(int(batch_size), 1000))
    summary: dict[str, int | bool] = {
        "ok": True,
        "due": 0,
        "enqueued": 0,
        "enqueue_errors": 0,
        "claim_skipped": 0,
        "exhausted": 0,
    }
    with SessionLocal() as db:
        summary["exhausted"] = _mark_exhausted_orphans(db, now=now)
        lock_ttl = _lock_ttl_seconds()
        stale_before = now - timedelta(seconds=lock_ttl)
        due_filter = or_(
            and_(
                WebhookDeliveryOutbox.status.in_(("pending", "retry")),
                WebhookDeliveryOutbox.next_attempt_at <= now,
            ),
            and_(
                WebhookDeliveryOutbox.status == "processing",
                WebhookDeliveryOutbox.locked_at <= stale_before,
            ),
            and_(
                WebhookDeliveryOutbox.status == "queued",
                WebhookDeliveryOutbox.locked_at <= stale_before,
            ),
        )
        rows = (
            db.query(
                WebhookDeliveryOutbox.id,
                WebhookDeliveryOutbox.tenant_id,
            )
            .filter(
                WebhookDeliveryOutbox.attempt_count < WebhookDeliveryOutbox.max_attempts,
                due_filter,
            )
            .order_by(
                WebhookDeliveryOutbox.next_attempt_at.asc(),
                WebhookDeliveryOutbox.created_at.asc(),
            )
            .limit(batch_size)
            .all()
        )
    summary["due"] = len(rows)
    for delivery_id, tenant_id in rows:
        schedule_token = uuid4().hex
        with SessionLocal() as db:
            claimed = (
                db.query(WebhookDeliveryOutbox)
                .filter(
                    WebhookDeliveryOutbox.id == delivery_id,
                    WebhookDeliveryOutbox.attempt_count
                    < WebhookDeliveryOutbox.max_attempts,
                    or_(
                        and_(
                            WebhookDeliveryOutbox.status.in_(("pending", "retry")),
                            WebhookDeliveryOutbox.next_attempt_at <= now,
                        ),
                        and_(
                            WebhookDeliveryOutbox.status.in_(("queued", "processing")),
                            WebhookDeliveryOutbox.locked_at <= stale_before,
                        ),
                    ),
                )
                .update(
                    {
                        WebhookDeliveryOutbox.status: "queued",
                        WebhookDeliveryOutbox.locked_at: now,
                        WebhookDeliveryOutbox.lock_token: schedule_token,
                        WebhookDeliveryOutbox.updated_at: now,
                    },
                    synchronize_session=False,
                )
            )
            db.commit()
        if not claimed:
            summary["claim_skipped"] = int(summary["claim_skipped"]) + 1
            continue
        try:
            enqueue_job(
                deliver_webhook_event,
                str(delivery_id),
                queue_name="integrations",
                meta={
                    "tenant_id": str(tenant_id),
                    "webhook_delivery_id": str(delivery_id),
                    "job": "customer_webhook_delivery",
                },
                job_timeout=60,
                description=f"customer-webhook-delivery:{delivery_id}",
            )
            summary["enqueued"] = int(summary["enqueued"]) + 1
        except Exception:
            summary["enqueue_errors"] = int(summary["enqueue_errors"]) + 1
            with SessionLocal() as db:
                (
                    db.query(WebhookDeliveryOutbox)
                    .filter(
                        WebhookDeliveryOutbox.id == delivery_id,
                        WebhookDeliveryOutbox.status == "queued",
                        WebhookDeliveryOutbox.lock_token == schedule_token,
                    )
                    .update(
                        {
                            WebhookDeliveryOutbox.status: "retry",
                            WebhookDeliveryOutbox.next_attempt_at: now,
                            WebhookDeliveryOutbox.locked_at: None,
                            WebhookDeliveryOutbox.lock_token: None,
                            WebhookDeliveryOutbox.last_error_code: (
                                "webhook_enqueue_failed"
                            ),
                            WebhookDeliveryOutbox.last_error_message: (
                                "L’envoi n’a pas pu être planifié ; une nouvelle tentative est prévue."
                            ),
                            WebhookDeliveryOutbox.updated_at: now,
                        },
                        synchronize_session=False,
                    )
                )
                db.commit()
            logger.exception(
                "webhook_delivery_enqueue_failed",
                extra={"delivery_id": delivery_id},
            )
    summary["ok"] = int(summary["enqueue_errors"]) == 0
    logger.info(json.dumps({"event": "webhook_outbox_sweep", "summary": summary}))
    return summary


def _schedule_sweep(
    *,
    delay_seconds: int,
    force: bool = False,
    force_next: bool = False,
) -> bool:
    if is_sync_mode():
        return False
    interval = _bounded_setting("WEBHOOK_OUTBOX_SWEEP_INTERVAL_SECONDS", 30, 10, 300)
    delay = max(0, int(delay_seconds))
    target_epoch = int(time.time()) + delay
    bucket = target_epoch // interval
    redis_conn = _get_redis_connection()
    lock_key = f"webhook-outbox:sweep-scheduled:{bucket}"
    lock_ttl = max(120, interval * 4)
    if force:
        # Worker bootstrap is the recovery path after a hard kill. It may
        # cause one harmless duplicate sweep, but the database queue lease
        # prevents duplicate delivery jobs and the next bucket converges back
        # to a single chain.
        redis_conn.delete(lock_key)
    if not redis_conn.set(lock_key, "1", nx=True, ex=lock_ttl):
        return False
    queue = Queue(
        name=queue_name_for("integrations"),
        connection=redis_conn,
        is_async=True,
    )
    try:
        kwargs = {
            "job_id": (
                f"webhook-outbox-sweep-bootstrap-{uuid4().hex}"
                if force
                else f"webhook-outbox-sweep-{bucket}"
            ),
            "job_timeout": 120,
            "result_ttl": max(120, interval * 4),
            "description": "customer-webhook-outbox-sweep",
        }
        if delay:
            queue.enqueue_in(
                timedelta(seconds=delay),
                sweep_webhook_outbox_job,
                force_next,
                **kwargs,
            )
        else:
            queue.enqueue(sweep_webhook_outbox_job, force_next, **kwargs)
    except Exception:
        redis_conn.delete(lock_key)
        raise
    return True


def ensure_webhook_outbox_sweeper() -> bool:
    """Seed the self-rescheduling sweep whenever an RQ worker starts."""

    return _schedule_sweep(delay_seconds=0, force=True, force_next=True)


def sweep_webhook_outbox_job(force_next: bool = False) -> dict[str, int | bool]:
    interval = _bounded_setting("WEBHOOK_OUTBOX_SWEEP_INTERVAL_SECONDS", 30, 10, 300)
    try:
        return enqueue_due_webhook_deliveries()
    finally:
        try:
            _schedule_sweep(delay_seconds=interval, force=force_next)
        except Exception:
            logger.exception("webhook_outbox_reschedule_failed")


def collect_webhook_outbox_summary(
    db: Session,
    *,
    tenant_id: str,
) -> dict[str, Any]:
    now = _utcnow()
    rows = (
        db.query(WebhookDeliveryOutbox.status, func.count(WebhookDeliveryOutbox.id))
        .filter(WebhookDeliveryOutbox.tenant_id == tenant_id)
        .group_by(WebhookDeliveryOutbox.status)
        .all()
    )
    counts = {str(status): int(count) for status, count in rows}
    oldest_due = (
        db.query(func.min(WebhookDeliveryOutbox.next_attempt_at))
        .filter(
            WebhookDeliveryOutbox.tenant_id == tenant_id,
            WebhookDeliveryOutbox.status.in_(("pending", "retry")),
            WebhookDeliveryOutbox.next_attempt_at <= now,
        )
        .scalar()
    )
    due_count = (
        db.query(func.count(WebhookDeliveryOutbox.id))
        .filter(
            WebhookDeliveryOutbox.tenant_id == tenant_id,
            WebhookDeliveryOutbox.status.in_(("pending", "retry")),
            WebhookDeliveryOutbox.next_attempt_at <= now,
        )
        .scalar()
    )
    last_delivered = (
        db.query(func.max(WebhookDeliveryOutbox.delivered_at))
        .filter(
            WebhookDeliveryOutbox.tenant_id == tenant_id,
            WebhookDeliveryOutbox.status == "delivered",
        )
        .scalar()
    )
    return {
        "counts": {status: counts.get(status, 0) for status in (
            "pending",
            "queued",
            "processing",
            "retry",
            "delivered",
            "failed",
            "cancelled",
        )},
        "due_count": int(due_count or 0),
        "oldest_due_at": oldest_due.isoformat() if oldest_due else None,
        "last_delivered_at": last_delivered.isoformat() if last_delivered else None,
    }


def purge_webhook_outbox(
    *,
    retention_days: int | None = None,
    dry_run: bool = False,
    db: Session | None = None,
) -> dict[str, Any]:
    configured = retention_days
    if configured is None:
        configured = _bounded_setting("WEBHOOK_OUTBOX_RETENTION_DAYS", 90, 30, 3650)
    days = max(30, min(int(configured), 3650))
    cutoff = _utcnow() - timedelta(days=days)

    def _run(session: Session) -> int:
        query = session.query(WebhookDeliveryOutbox).filter(
            WebhookDeliveryOutbox.status.in_(tuple(TERMINAL_STATUSES)),
            WebhookDeliveryOutbox.updated_at < cutoff,
        )
        count = query.count()
        if not dry_run and count:
            query.delete(synchronize_session=False)
            session.commit()
        return int(count)

    deleted = _run(db) if db is not None else 0
    if db is None:
        with SessionLocal() as session:
            deleted = _run(session)
    summary = {
        "ok": True,
        "deleted": deleted,
        "dry_run": dry_run,
        "cutoff": cutoff.isoformat(),
    }
    logger.info(json.dumps({"event": "webhook_outbox_retention", "summary": summary}))
    return summary
