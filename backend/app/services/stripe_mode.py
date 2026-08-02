from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def expected_livemode_for_secret(secret: str | None) -> bool | None:
    value = (secret or "").strip()
    if value.startswith("sk_live_"):
        return True
    if value.startswith("sk_test_"):
        return False
    return None


def read_attr(value: object, key: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(key)
    getter = getattr(value, "get", None)
    if callable(getter):
        try:
            return getter(key)
        except Exception:
            pass
    return getattr(value, key, None)


def livemode_validation_reason(value: object, secret: str | None) -> str | None:
    expected = expected_livemode_for_secret(secret)
    if expected is None:
        return None
    actual = read_attr(value, "livemode")
    if actual is None:
        return None
    if bool(actual) != expected:
        return "stripe_livemode_mismatch"
    return None
