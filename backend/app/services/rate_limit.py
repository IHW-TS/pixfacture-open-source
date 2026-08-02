import logging
import os
from time import time
from typing import cast

from redis import Redis

from ..config import settings, _is_prod_env

logger = logging.getLogger("rate_limit")

_local_counters: dict[str, tuple[int, float]] = {}
_redis_client: Redis | None = None
_disable_logged = False


def _rate_limits_disabled() -> bool:
    global _disable_logged
    if not getattr(settings, "DISABLE_RATE_LIMITS", False):
        return False
    if _is_prod_env() and not getattr(settings, "RATE_LIMITS_BREAK_GLASS", False):
        raise RuntimeError("DISABLE_RATE_LIMITS=true interdit en production sans RATE_LIMITS_BREAK_GLASS=true.")
    if _is_prod_env() and not _disable_logged:
        logger.warning("Rate limiting desactive via DISABLE_RATE_LIMITS en %s.", settings.APP_ENV)
        _disable_logged = True
    return True


def _get_redis() -> Redis | None:
    global _redis_client
    if not settings.REDIS_URL:
        return None
    if _redis_client:
        return _redis_client
    try:
        _redis_client = Redis.from_url(settings.REDIS_URL, decode_responses=False)
    except Exception:
        _redis_client = None
    return _redis_client


def _is_test_context() -> bool:
    return bool(os.environ.get("PYTEST_CURRENT_TEST"))


def _hit_local(key: str, window_seconds: int) -> int:
    now = time()
    stored = _local_counters.get(key)
    if stored:
        count, expires_at = stored
        if expires_at > now:
            count += 1
            _local_counters[key] = (count, expires_at)
            return count
    _local_counters[key] = (1, now + window_seconds)
    return 1


def _limited_local(key: str, limit: int) -> bool:
    now = time()
    stored = _local_counters.get(key)
    if not stored:
        return False
    count, expires_at = stored
    if expires_at <= now:
        _local_counters.pop(key, None)
        return False
    return count >= limit


def limited(key: str, limit: int, window_seconds: int) -> bool:
    if _rate_limits_disabled():
        return False
    if limit <= 0 or window_seconds <= 0:
        return False
    r = _get_redis()
    if not r:
        if _is_prod_env() and not _is_test_context():
            raise RuntimeError("Redis requis pour le rate limiting en production.")
        return _limited_local(key, limit)
    try:
        raw_count = r.get(key)
    except Exception:
        if _is_prod_env():
            raise
        return _limited_local(key, limit)
    if raw_count is None:
        return False
    try:
        count = int(cast(bytes | str | int, raw_count))
    except (TypeError, ValueError):
        return False
    return count >= limit


def hit(key: str, limit: int, window_seconds: int) -> bool:
    if _rate_limits_disabled():
        return False
    if limit <= 0 or window_seconds <= 0:
        return False
    r = _get_redis()
    if not r:
        if _is_prod_env() and not _is_test_context():
            raise RuntimeError("Redis requis pour le rate limiting en production.")
        return _hit_local(key, window_seconds) > limit
    try:
        count = r.incr(key)
        if count == 1:
            r.expire(key, window_seconds)
    except Exception:
        if _is_prod_env():
            raise
        count = _hit_local(key, window_seconds)
    count_value = cast(int, count)
    return count_value > limit


def reset(key: str) -> None:
    r = _get_redis()
    if r:
        try:
            r.delete(key)
        except Exception:
            if _is_prod_env() and not _is_test_context():
                raise
    _local_counters.pop(key, None)
