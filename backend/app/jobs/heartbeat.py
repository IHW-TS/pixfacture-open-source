from __future__ import annotations

import logging
from datetime import datetime, timezone

from redis import Redis

from ..config import settings


logger = logging.getLogger(__name__)
_redis_client: Redis | None = None
MAX_HEARTBEAT_FUTURE_SKEW_SECONDS = 60


def _normalize_mode(mode: str) -> str:
    return (mode or "").strip().lower()


def _heartbeat_key(mode: str) -> str:
    return f"periodic:{mode}:heartbeat"


def _get_redis_connection() -> Redis:
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    redis_url = (settings.REDIS_URL or "").strip()
    if not redis_url:
        raise RuntimeError("REDIS_URL requis pour le heartbeat periodic.")
    _redis_client = Redis.from_url(redis_url, decode_responses=True)
    return _redis_client


def _interval_seconds_for_mode(mode: str) -> int | None:
    if mode == "retention":
        return 24 * 60 * 60
    if mode == "einvoicing_sync":
        return int(getattr(settings, "EINVOICING_SYNC_INTERVAL_SECONDS", 300) or 300)
    if mode == "inbox_poll":
        return int(getattr(settings, "INBOX_POLL_INTERVAL_SECONDS", 300) or 300)
    if mode == "ereporting_retry":
        return int(getattr(settings, "EREPORTING_RETRY_INTERVAL_SECONDS", 300) or 300)
    if mode == "ereporting_report_retry":
        return int(getattr(settings, "EREPORTING_RETRY_INTERVAL_SECONDS", 300) or 300)
    if mode == "ereporting_generate":
        return int(getattr(settings, "EREPORTING_GENERATE_INTERVAL_SECONDS", 86400) or 86400)
    if mode == "directory_refresh":
        return int(getattr(settings, "DIRECTORY_SYNC_INTERVAL_SECONDS", 86400) or 86400)
    if mode == "seqino_usage":
        return int(getattr(settings, "SEQINO_USAGE_INTERVAL_SECONDS", 2592000) or 2592000)
    if mode == "seqino_token_inventory":
        return int(
            getattr(settings, "SEQINO_TOKEN_INVENTORY_INTERVAL_SECONDS", 300) or 300
        )
    if mode == "quote_followups":
        return int(getattr(settings, "QUOTE_FOLLOWUP_INTERVAL_SECONDS", 3600) or 3600)
    if mode == "invoice_followups":
        return int(getattr(settings, "INVOICE_FOLLOWUP_INTERVAL_SECONDS", 3600) or 3600)
    if mode == "webhook_outbox":
        return int(getattr(settings, "WEBHOOK_OUTBOX_SWEEP_INTERVAL_SECONDS", 30) or 30)
    return None


def expected_heartbeat_ttl_seconds(mode: str, interval_seconds: int | None = None) -> int:
    min_ttl = int(getattr(settings, "PERIODIC_HEARTBEAT_MIN_TTL_SECONDS", 600) or 600)
    interval = interval_seconds or _interval_seconds_for_mode(_normalize_mode(mode))
    if not interval:
        return min_ttl
    return max(int(interval) * 2, min_ttl)


def set_periodic_heartbeat(
    mode: str,
    ts: datetime | None = None,
    *,
    ttl_seconds: int | None = None,
    interval_seconds: int | None = None,
) -> None:
    normalized = _normalize_mode(mode)
    if not normalized:
        raise ValueError("mode de heartbeat manquant")
    timestamp = ts or datetime.now(timezone.utc)
    ttl = ttl_seconds or expected_heartbeat_ttl_seconds(normalized, interval_seconds)
    try:
        redis_conn = _get_redis_connection()
        redis_conn.set(_heartbeat_key(normalized), int(timestamp.timestamp()), ex=int(ttl))
    except Exception as exc:
        logger.warning("heartbeat_set_failed", extra={"mode": normalized, "error": str(exc)})


def get_periodic_heartbeat(mode: str) -> datetime | None:
    normalized = _normalize_mode(mode)
    if not normalized:
        return None
    try:
        redis_conn = _get_redis_connection()
    except Exception:
        return None
    try:
        raw = redis_conn.get(_heartbeat_key(normalized))
    except Exception as exc:
        logger.warning("heartbeat_get_failed", extra={"mode": normalized, "error": str(exc)})
        return None
    if raw is None:
        return None
    try:
        ts = int(str(raw).strip())
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    except Exception:
        try:
            parsed = datetime.fromisoformat(str(raw))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except Exception:
            return None


def collect_periodic_heartbeat_status(
    modes: list[str],
    *,
    now: datetime | None = None,
    not_before: datetime | None = None,
) -> dict[str, object]:
    checked_at = now or datetime.now(timezone.utc)
    normalized_modes = list(
        dict.fromkeys(normalized for item in modes if (normalized := _normalize_mode(item)))
    )
    results: list[dict[str, object]] = []
    unhealthy_modes: list[str] = []
    for mode in normalized_modes:
        heartbeat_at = get_periodic_heartbeat(mode)
        ttl_seconds = expected_heartbeat_ttl_seconds(mode)
        age_seconds = (
            int((checked_at - heartbeat_at).total_seconds())
            if heartbeat_at is not None
            else None
        )
        future_dated = (
            age_seconds is not None
            and age_seconds < -MAX_HEARTBEAT_FUTURE_SKEW_SECONDS
        )
        predates_required_start = (
            heartbeat_at is not None
            and not_before is not None
            and heartbeat_at < not_before
        )
        stale = (
            heartbeat_at is None
            or future_dated
            or predates_required_start
            or (age_seconds is not None and age_seconds > ttl_seconds)
        )
        if stale:
            unhealthy_modes.append(mode)
        results.append(
            {
                "mode": mode,
                "heartbeat_present": heartbeat_at is not None,
                "last_heartbeat_at": heartbeat_at.isoformat() if heartbeat_at else None,
                "age_seconds": age_seconds,
                "expected_ttl_seconds": ttl_seconds,
                "future_dated": future_dated,
                "predates_required_start": predates_required_start,
                "healthy": not stale,
            }
        )
    return {
        "status": "ok" if normalized_modes and not unhealthy_modes else "error",
        "checked_at": checked_at.isoformat(),
        "not_before": not_before.isoformat() if not_before else None,
        "required_modes": normalized_modes,
        "unhealthy_modes": unhealthy_modes,
        "modes": results,
    }


def reset_redis_connection() -> None:
    global _redis_client
    _redis_client = None
