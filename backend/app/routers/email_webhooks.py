from __future__ import annotations

import base64
import binascii
import json
import logging
import re
import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import EmailEvent
from ..utils.public_provider_messages import sanitize_public_provider_message

logger = logging.getLogger("email.webhooks")

router = APIRouter(prefix="/api/webhooks/email", tags=["email-webhooks"])

_EVENT_STATUS_MAP = {
    "request": "sent",
    "sent": "sent",
    "delivered": "delivered",
    "opened": "opened",
    "unique_opened": "opened",
    "proxy_open": "opened",
    "click": "clicked",
    "clicked": "clicked",
    "soft_bounce": "soft_bounce",
    "hard_bounce": "hard_bounce",
    "invalid": "failed",
    "invalid_email": "failed",
    "blocked": "blocked",
    "deferred": "deferred",
    "error": "failed",
    "dropped": "failed",
    "spam": "complaint",
    "complaint": "complaint",
    "unsubscribed": "unsubscribed",
}
_FAILURE_STATUSES = {"blocked", "complaint", "failed", "hard_bounce", "soft_bounce"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _truncate(value: str | None, limit: int = 500) -> str | None:
    cleaned = _clean(value)
    if not cleaned:
        return None
    return cleaned[:limit]


def _case_get(payload: dict[str, Any], key: str) -> Any:
    if key in payload:
        return payload[key]
    needle = key.lower()
    for raw_key, value in payload.items():
        if str(raw_key).lower() == needle:
            return value
    return None


def _configured_for_auth() -> bool:
    return bool(
        _clean(settings.BREVO_WEBHOOK_TOKEN)
        or (_clean(settings.BREVO_WEBHOOK_USERNAME) and _clean(settings.BREVO_WEBHOOK_PASSWORD))
    )


def _extract_basic_credentials(auth_header: str) -> tuple[str, str] | None:
    if not auth_header.lower().startswith("basic "):
        return None
    encoded = auth_header.split(" ", 1)[1].strip()
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    username, separator, password = decoded.partition(":")
    if not separator:
        return None
    return username, password


def _authorized(request: Request) -> bool:
    if not _configured_for_auth():
        raise HTTPException(
            status_code=503,
            detail={"code": "brevo_webhook_not_configured", "message": "Webhook Brevo non configuré."},
        )

    token = _clean(settings.BREVO_WEBHOOK_TOKEN)
    auth_header = _clean(request.headers.get("authorization"))
    token_candidates: list[str] = []

    direct_secret = _clean(
        request.headers.get("x-brevo-webhook-secret")
        or request.headers.get("x-brevo-signature")
        or request.headers.get("x-webhook-token")
    )
    if direct_secret:
        token_candidates.append(direct_secret)

    lower_auth = auth_header.lower()
    if lower_auth.startswith("bearer "):
        token_candidates.append(auth_header.split(" ", 1)[1].strip())
    elif lower_auth.startswith("token "):
        token_candidates.append(auth_header.split(" ", 1)[1].strip())
    elif auth_header and not lower_auth.startswith("basic "):
        token_candidates.append(auth_header)

    if token and any(secrets.compare_digest(token, candidate) for candidate in token_candidates if candidate):
        return True

    credentials = _extract_basic_credentials(auth_header)
    if credentials is not None:
        expected_user = _clean(settings.BREVO_WEBHOOK_USERNAME)
        expected_password = _clean(settings.BREVO_WEBHOOK_PASSWORD)
        username, password = credentials
        if expected_user and expected_password:
            return secrets.compare_digest(expected_user, username) and secrets.compare_digest(expected_password, password)

    return False


def _payload_events(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("events", "items", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return [payload]


def _event_name(payload: dict[str, Any]) -> str:
    raw = _case_get(payload, "event") or _case_get(payload, "type") or _case_get(payload, "status")
    return re.sub(r"[\s.-]+", "_", _clean(raw).lower())


def _mapped_status(payload: dict[str, Any]) -> str:
    event_name = _event_name(payload)
    return _EVENT_STATUS_MAP.get(event_name, event_name or "provider_event")


def _parse_event_time(payload: dict[str, Any]) -> datetime:
    for key in ("ts_event", "ts", "timestamp", "date"):
        raw = _case_get(payload, key)
        if raw is None or raw == "":
            continue
        if isinstance(raw, int | float) or str(raw).strip().isdigit():
            timestamp = float(raw)
            if timestamp > 10_000_000_000:
                timestamp = timestamp / 1000
            return datetime.fromtimestamp(timestamp, tz=timezone.utc).replace(tzinfo=None)
        text = str(raw).strip()
        for candidate in (text, text.replace("Z", "+00:00")):
            try:
                parsed = datetime.fromisoformat(candidate)
                if parsed.tzinfo is not None:
                    parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
                return parsed
            except ValueError:
                continue
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(text, fmt)
            except ValueError:
                continue
    return _utcnow()


def _message_id(payload: dict[str, Any]) -> str | None:
    for key in ("message-id", "message_id", "messageId", "messageIdHeader", "uuid"):
        value = _clean(_case_get(payload, key))
        if value:
            return value[:255]
    return None


def _email(payload: dict[str, Any]) -> str | None:
    for key in ("email", "recipient", "to"):
        value = _clean(_case_get(payload, key)).lower()
        if value:
            return value[:255]
    return None


def _custom_candidates(payload: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    for key in ("email_event_id", "event_id", "X-Mailin-custom", "x-mailin-custom", "X-Mailin-Custom", "tag"):
        value = _case_get(payload, key)
        if value:
            candidates.append(str(value))

    headers = _case_get(payload, "headers")
    if isinstance(headers, dict):
        for key in ("email_event_id", "X-Mailin-custom", "x-mailin-custom", "X-Mailin-Custom"):
            value = _case_get(headers, key)
            if value:
                candidates.append(str(value))
    elif isinstance(headers, list):
        for item in headers:
            if isinstance(item, dict):
                candidates.extend(_custom_candidates(item))

    tags = _case_get(payload, "tags")
    if isinstance(tags, list):
        candidates.extend(str(item) for item in tags if item)
    elif isinstance(tags, dict):
        candidates.extend(f"{key}:{value}" for key, value in tags.items() if value)
    elif tags:
        candidates.append(str(tags))
    return candidates


def _email_event_id(payload: dict[str, Any]) -> str | None:
    for candidate in _custom_candidates(payload):
        match = re.search(r"(?:^|[|,;\s])email_event_id\s*[:=]\s*([A-Za-z0-9_.:-]+)", candidate)
        if match:
            return match.group(1)[:64]
        direct = candidate.strip()
        if re.fullmatch(r"[A-Za-z0-9_.:-]{20,64}", direct):
            return direct[:64]
    return None


def _provider_event_id(payload: dict[str, Any], message_id: str | None, event_name: str, event_at: datetime) -> str | None:
    for key in ("id", "event_id", "eventId"):
        value = _clean(_case_get(payload, key))
        if value:
            return value[:255]
    if message_id or event_name:
        return _truncate(f"{message_id or 'unknown'}:{event_name or 'event'}:{event_at.isoformat()}", 255)
    return None


def _reason(payload: dict[str, Any], mapped_status: str) -> str | None:
    if mapped_status not in _FAILURE_STATUSES:
        return None
    pieces = []
    for key in ("reason", "message", "error", "description", "subject"):
        value = _clean(_case_get(payload, key))
        if value:
            public_value = sanitize_public_provider_message(value, max_chars=200)
            if public_value:
                pieces.append(public_value)
    if not pieces:
        pieces.append(_event_name(payload) or mapped_status)
    return _truncate(" | ".join(dict.fromkeys(pieces)))


def _find_event(db: Session, payload: dict[str, Any], message_id: str | None) -> EmailEvent | None:
    custom_event_id = _email_event_id(payload)
    if custom_event_id:
        event = db.get(EmailEvent, custom_event_id)
        if event is not None:
            return event

    if message_id:
        event = (
            db.query(EmailEvent)
            .filter(EmailEvent.provider_message_id == message_id)
            .order_by(EmailEvent.created_at.desc(), EmailEvent.id.desc())
            .first()
        )
        if event is not None:
            return event

    return None


def _apply_payload(db: Session, payload: dict[str, Any]) -> bool:
    event_name = _event_name(payload)
    mapped_status = _mapped_status(payload)
    event_at = _parse_event_time(payload)
    message_id = _message_id(payload)
    event = _find_event(db, payload, message_id)
    if event is None:
        logger.info("brevo_webhook_unmatched", extra={"provider_event": event_name})
        return False

    event.provider = "brevo"
    if message_id:
        event.provider_message_id = message_id
    event.provider_event_id = _provider_event_id(payload, message_id, event_name, event_at)
    event.provider_status = event_name or mapped_status
    event.provider_event_at = event_at
    event.status = mapped_status
    if mapped_status in _FAILURE_STATUSES:
        event.error = _reason(payload, mapped_status)
        if mapped_status == "failed":
            event.sent_at = None
    elif mapped_status in {"sent", "delivered", "opened", "clicked"}:
        event.error = None
        if event.sent_at is None:
            event.sent_at = event_at
    db.add(event)
    return True


@router.post("/brevo")
async def brevo_transactional_webhook(request: Request, db: Session = Depends(get_db)):
    if not _authorized(request):
        raise HTTPException(
            status_code=401,
            detail={"code": "brevo_webhook_unauthorized", "message": "Authentification webhook Brevo invalide."},
        )

    body = await request.body()
    max_bytes = int(getattr(settings, "BREVO_WEBHOOK_MAX_BYTES", 262144) or 0)
    if max_bytes > 0 and len(body) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail={"code": "brevo_webhook_too_large", "message": "Payload Brevo trop volumineux."},
        )

    try:
        payload = json.loads(body or b"null")
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "brevo_webhook_invalid_json", "message": "Payload Brevo invalide."},
        ) from exc

    events = _payload_events(payload)
    max_events = int(getattr(settings, "BREVO_WEBHOOK_MAX_EVENTS", 100) or 0)
    if max_events > 0 and len(events) > max_events:
        raise HTTPException(
            status_code=400,
            detail={"code": "brevo_webhook_too_many_events", "message": "Trop d'événements Brevo dans le même webhook."},
        )
    if not events:
        raise HTTPException(
            status_code=400,
            detail={"code": "brevo_webhook_empty", "message": "Aucun événement Brevo exploitable."},
        )

    matched = 0
    for event_payload in events:
        if _apply_payload(db, event_payload):
            matched += 1
    db.commit()
    return {"ok": True, "processed": len(events), "matched": matched, "unmatched": len(events) - matched}
