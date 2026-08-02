from __future__ import annotations

import asyncio
import math
import random
from typing import Any, Awaitable, Callable

import httpx

from ..einvoicing.utils import normalize_status
from ...utils.pdp_errors import (
    PdpPreSubmitCancelled,
    PdpPreSubmitError,
    PdpProviderError,
    PdpRetryableError,
)

__all__ = [
    "PdpProviderError",
    "PdpRetryableError",
    "PdpPreSubmitError",
    "PdpPreSubmitCancelled",
    "is_retryable_error",
    "retry_async",
    "normalize_status",
]


def is_retryable_error(exc: BaseException) -> bool:
    if isinstance(exc, PdpProviderError):
        return bool(exc.retryable)
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status in {408, 425, 429, 500, 502, 503, 504}
    if isinstance(exc, httpx.TransportError):
        return True
    return False


def _backoff_delay(
    attempt: int,
    base_delay: float,
    max_delay: float,
    jitter_ratio: float,
) -> float:
    delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
    normalized_jitter = max(0.0, min(float(jitter_ratio), 1.0))
    if normalized_jitter:
        delay *= random.uniform(1.0 - normalized_jitter, 1.0 + normalized_jitter)
    return max(0.0, delay)


async def retry_async(
    action: Callable[[], Awaitable[Any]],
    *,
    attempts: int = 3,
    base_delay: float = 0.2,
    max_delay: float = 2.0,
    jitter_ratio: float = 0.2,
    max_retry_after_delay: float = 60.0,
    on_retry: Callable[[BaseException, int, float], None] | None = None,
) -> Any:
    last_exc: BaseException | None = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            return await action()
        except Exception as exc:
            last_exc = exc
            if attempt >= attempts or not is_retryable_error(exc):
                raise
            delay = _backoff_delay(attempt, base_delay, max_delay, jitter_ratio)
            retry_after = getattr(exc, "retry_after_seconds", None)
            try:
                retry_after_delay = float(retry_after) if retry_after is not None else None
            except (TypeError, ValueError):
                retry_after_delay = None
            if retry_after_delay is not None and math.isfinite(retry_after_delay):
                retry_after_delay = max(0.0, retry_after_delay)
                if retry_after_delay > max_retry_after_delay:
                    # Do not retry earlier than requested and do not pin a worker
                    # for an unbounded provider-controlled duration.
                    raise
                delay = max(delay, retry_after_delay)
            if on_retry:
                on_retry(exc, attempt, delay)
            await asyncio.sleep(delay)
    if last_exc:
        raise last_exc
    raise RuntimeError("retry_async exhausted")
