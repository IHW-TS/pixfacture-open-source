from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

logger = logging.getLogger("pdp.outbound")


def _sanitize_url(url: str) -> str:
    try:
        parts = urlsplit(str(url))
        netloc = parts.netloc
        if "@" in netloc:
            netloc = netloc.split("@", 1)[1]
        return urlunsplit((parts.scheme, netloc, parts.path, "", ""))
    except Exception:
        return str(url)


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    return raw or None


def tenant_id_from_credentials(credentials: dict | None) -> str | None:
    if not credentials:
        return None
    for key in ("tenant_id", "_tenant_id"):
        raw = credentials.get(key)
        if raw:
            return _normalize_text(raw)
    return None


def log_pdp_outbound_call(
    *,
    endpoint: str,
    method: str,
    tenant_id: str | None,
    correlation_id: str | None,
    status_code: int | None,
    latency_ms: float | None,
    provider: str | None = None,
    error: str | None = None,
) -> None:
    payload = {
        "event": "pdp_outbound_call",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "endpoint": _sanitize_url(endpoint),
        "method": (method or "").upper(),
        "tenant_id": _normalize_text(tenant_id),
        "correlation_id": _normalize_text(correlation_id),
        "status_code": status_code,
        "latency_ms": int(round(latency_ms)) if latency_ms is not None else None,
        "provider": _normalize_text(provider),
        "error": _normalize_text(error),
    }
    logger.info(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))


async def httpx_request_with_log(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    tenant_id: str | None = None,
    correlation_id: str | None = None,
    provider: str | None = None,
    **kwargs: Any,
) -> httpx.Response:
    start = time.perf_counter()
    status_code: int | None = None
    error: str | None = None
    try:
        response = await client.request(method, url, **kwargs)
        status_code = response.status_code
        return response
    except Exception as exc:
        error = str(exc) or exc.__class__.__name__
        raise
    finally:
        latency_ms = (time.perf_counter() - start) * 1000.0
        log_pdp_outbound_call(
            endpoint=str(url),
            method=method,
            tenant_id=tenant_id,
            correlation_id=correlation_id,
            status_code=status_code,
            latency_ms=latency_ms,
            provider=provider,
            error=error,
        )
