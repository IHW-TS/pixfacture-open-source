from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from datetime import datetime, timezone
from typing import Any

from redis import Redis

from ..config import settings


class SeqinoWebhookError(ValueError):
    def __init__(self, message: str, *, code: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


_MEMORY_REPLAYS: dict[str, float] = {}
_MEMORY_REPLAY_LOCK = threading.Lock()
_REDIS_CLIENT: Redis | None = None


def _signature_digest(signature: str | None) -> str:
    raw = str(signature or "").strip()
    if raw.lower().startswith("sha256="):
        raw = raw.split("=", 1)[1].strip()
    if len(raw) != 64 or any(character not in "0123456789abcdefABCDEF" for character in raw):
        raise SeqinoWebhookError(
            "Signature webhook plateforme partenaire invalide.",
            code="seqino_webhook_signature_invalid",
            status_code=401,
        )
    return raw.lower()


def verify_webhook_payload(
    payload: bytes,
    signature: str | None,
    *,
    secret: str,
    expected_sponsor_id: str,
    now: datetime | None = None,
    max_age_seconds: int | None = None,
) -> dict[str, Any]:
    if not payload:
        raise SeqinoWebhookError(
            "Payload webhook vide.",
            code="seqino_webhook_payload_invalid",
            status_code=400,
        )
    provided_digest = _signature_digest(signature)
    expected_digest = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided_digest, expected_digest):
        raise SeqinoWebhookError(
            "Signature webhook plateforme partenaire invalide.",
            code="seqino_webhook_signature_invalid",
            status_code=401,
        )
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SeqinoWebhookError(
            "Payload webhook plateforme partenaire invalide.",
            code="seqino_webhook_payload_invalid",
            status_code=400,
        ) from exc
    if not isinstance(decoded, dict):
        raise SeqinoWebhookError(
            "Payload webhook plateforme partenaire invalide.",
            code="seqino_webhook_payload_invalid",
            status_code=400,
        )
    event_id = str(decoded.get("event_id") or "").strip()
    event_type = str(decoded.get("event_type") or "").strip()
    sponsor_id = str(decoded.get("sponsor_id") or "").strip()
    timestamp_raw = str(decoded.get("timestamp") or "").strip()
    data = decoded.get("data")
    if not event_id or not event_type or not sponsor_id or not timestamp_raw or not isinstance(data, dict):
        raise SeqinoWebhookError(
            "Champs webhook plateforme partenaire incomplets.",
            code="seqino_webhook_payload_invalid",
            status_code=400,
        )
    if not hmac.compare_digest(sponsor_id, str(expected_sponsor_id or "").strip()):
        raise SeqinoWebhookError(
            "Sponsor webhook plateforme partenaire invalide.",
            code="seqino_webhook_sponsor_invalid",
            status_code=401,
        )
    try:
        occurred_at = datetime.fromisoformat(timestamp_raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SeqinoWebhookError(
            "Horodatage webhook plateforme partenaire invalide.",
            code="seqino_webhook_timestamp_invalid",
            status_code=400,
        ) from exc
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    window = int(max_age_seconds or settings.SEQINO_WEBHOOK_MAX_AGE_SECONDS or 300)
    if abs((current.astimezone(timezone.utc) - occurred_at.astimezone(timezone.utc)).total_seconds()) > window:
        raise SeqinoWebhookError(
            "Webhook plateforme partenaire expire.",
            code="seqino_webhook_expired",
            status_code=401,
        )
    return decoded


def _replay_key(sponsor_id: str, event_id: str) -> str:
    digest = hashlib.sha256(f"{sponsor_id}:{event_id}".encode("utf-8")).hexdigest()
    return f"seqino:webhook:event:{digest}"


def _redis() -> Redis | None:
    global _REDIS_CLIENT
    if _REDIS_CLIENT is not None:
        return _REDIS_CLIENT
    redis_url = str(settings.REDIS_URL or "").strip()
    if not redis_url:
        return None
    _REDIS_CLIENT = Redis.from_url(redis_url, decode_responses=False)
    return _REDIS_CLIENT


def claim_webhook_event(sponsor_id: str, event_id: str, *, ttl_seconds: int = 172800) -> str:
    key = _replay_key(sponsor_id, event_id)
    redis = _redis()
    if redis is not None:
        try:
            claimed = redis.set(key, b"1", nx=True, ex=max(60, int(ttl_seconds)))
        except Exception as exc:
            raise SeqinoWebhookError(
                "Protection anti-rejeu webhook indisponible.",
                code="seqino_webhook_replay_store_unavailable",
                status_code=503,
            ) from exc
        if not claimed:
            raise SeqinoWebhookError(
                "Evenement webhook deja traite.",
                code="seqino_webhook_replayed",
                status_code=409,
            )
        return key

    if str(settings.APP_ENV or "").strip().lower() in {"prod", "production", "staging"}:
        raise SeqinoWebhookError(
            "Protection anti-rejeu webhook non configuree.",
            code="seqino_webhook_replay_store_unavailable",
            status_code=503,
        )
    now = time.monotonic()
    expires_at = now + max(60, int(ttl_seconds))
    with _MEMORY_REPLAY_LOCK:
        expired = [stored_key for stored_key, expiry in _MEMORY_REPLAYS.items() if expiry <= now]
        for stored_key in expired:
            _MEMORY_REPLAYS.pop(stored_key, None)
        if key in _MEMORY_REPLAYS:
            raise SeqinoWebhookError(
                "Evenement webhook deja traite.",
                code="seqino_webhook_replayed",
                status_code=409,
            )
        _MEMORY_REPLAYS[key] = expires_at
    return key


def release_webhook_event(key: str) -> None:
    redis = _redis()
    if redis is not None:
        try:
            redis.delete(key)
        except Exception:
            return
        return
    with _MEMORY_REPLAY_LOCK:
        _MEMORY_REPLAYS.pop(key, None)


def reset_webhook_replay_state() -> None:
    global _REDIS_CLIENT
    _REDIS_CLIENT = None
    with _MEMORY_REPLAY_LOCK:
        _MEMORY_REPLAYS.clear()
