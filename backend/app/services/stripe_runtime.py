from __future__ import annotations

from time import time
from typing import Any, TypedDict

import stripe

from ..config import settings


_CACHE_TTL_SECONDS = 300
_STRIPE_ERRORS: Any = getattr(stripe, "error", None)


class StripeRuntimeStatus(TypedDict):
    secret_configured: bool
    ready: bool
    reason: str | None


_CACHE: dict[str, Any] = {"ts": 0.0, "secret": None, "status": None}


def _reason_from_error(exc: Exception) -> str:
    if _STRIPE_ERRORS and isinstance(exc, _STRIPE_ERRORS.AuthenticationError):
        return "stripe_auth_failed"
    if _STRIPE_ERRORS and isinstance(exc, _STRIPE_ERRORS.PermissionError):
        return "stripe_permission_denied"
    if _STRIPE_ERRORS and isinstance(exc, _STRIPE_ERRORS.RateLimitError):
        return "stripe_rate_limited"
    if _STRIPE_ERRORS and isinstance(exc, _STRIPE_ERRORS.APIConnectionError):
        return "stripe_unreachable"
    if _STRIPE_ERRORS and isinstance(exc, _STRIPE_ERRORS.InvalidRequestError):
        return "stripe_invalid_request"
    if _STRIPE_ERRORS and isinstance(exc, _STRIPE_ERRORS.StripeError):
        return "stripe_unavailable"
    return "stripe_unavailable"


def stripe_checkout_error_is_definite(exc: Exception) -> bool:
    """True only when Stripe could not have created the Checkout Session."""

    if not _STRIPE_ERRORS:
        return False
    definite_types = tuple(
        error_type
        for error_type in (
            getattr(_STRIPE_ERRORS, "AuthenticationError", None),
            getattr(_STRIPE_ERRORS, "PermissionError", None),
            getattr(_STRIPE_ERRORS, "InvalidRequestError", None),
        )
        if isinstance(error_type, type)
    )
    return bool(definite_types and isinstance(exc, definite_types))


def get_stripe_runtime_status(secret: str | None) -> StripeRuntimeStatus:
    normalized = (secret or "").strip()
    if not normalized:
        return {
            "secret_configured": False,
            "ready": False,
            "reason": "stripe_not_configured",
        }

    ts = float(_CACHE.get("ts") or 0.0)
    cached_secret = _CACHE.get("secret")
    cached_status = _CACHE.get("status")
    if cached_secret == normalized and cached_status and (time() - ts) < _CACHE_TTL_SECONDS:
        return {
            "secret_configured": bool(cached_status.get("secret_configured")),
            "ready": bool(cached_status.get("ready")),
            "reason": cached_status.get("reason"),
        }

    stripe.api_key = normalized
    stripe.api_base = (settings.STRIPE_API_BASE or "https://api.stripe.com").strip().rstrip("/")
    try:
        stripe.Account.retrieve()
        status: StripeRuntimeStatus = {
            "secret_configured": True,
            "ready": True,
            "reason": None,
        }
    except Exception as exc:
        status = {
            "secret_configured": True,
            "ready": False,
            "reason": _reason_from_error(exc),
        }

    _CACHE["ts"] = time()
    _CACHE["secret"] = normalized
    _CACHE["status"] = dict(status)
    return status
