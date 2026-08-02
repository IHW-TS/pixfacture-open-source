from __future__ import annotations

import hashlib
import hmac
import logging

from fastapi import HTTPException, Request

from .. import metrics
from ..config import settings
from . import rate_limit

logger = logging.getLogger(__name__)


def _client_identity(request: Request | None) -> str:
    if request and request.client and request.client.host:
        return request.client.host.strip() or "unknown"
    return "unknown"


def _effective_public_limit(limit: int) -> int:
    generic_limit = int(getattr(settings, "MAX_PUBLIC_DOWNLOADS_PER_MINUTE", 120) or 0)
    if limit <= 0:
        return limit
    if generic_limit <= 0:
        return limit
    return min(limit, generic_limit)


def _record_public_quota_exceeded(scope: str) -> None:
    metrics.inc_operational_event("quota_exceeded")
    logger.warning("quota_exceeded", extra={"scope": scope})


def _public_token_bucket(token_key: str) -> str:
    prefix, sep, token = (token_key or "").partition(":")
    if not sep or not token:
        return token_key
    secret = (settings.SECRET_KEY or "pixfacture-public-rate-limit").encode("utf-8")
    digest = hmac.new(secret, token.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    return f"{prefix}:{digest}"


def enforce_public_rate_limit(
    *,
    token_key: str,
    token_limit: int,
    ip_key_prefix: str,
    ip_limit: int,
    window_seconds: int,
    request: Request | None,
    detail: dict[str, str],
) -> None:
    if rate_limit.hit(
        _public_token_bucket(token_key),
        limit=_effective_public_limit(token_limit),
        window_seconds=window_seconds,
    ):
        _record_public_quota_exceeded(ip_key_prefix)
        raise HTTPException(status_code=429, detail=detail)
    if ip_limit <= 0:
        return
    client_identity = _client_identity(request)
    if rate_limit.hit(
        f"{ip_key_prefix}:ip:{client_identity}",
        limit=_effective_public_limit(ip_limit),
        window_seconds=window_seconds,
    ):
        _record_public_quota_exceeded(f"{ip_key_prefix}:ip")
        raise HTTPException(status_code=429, detail=detail)
