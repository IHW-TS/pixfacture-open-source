from __future__ import annotations

import hashlib
import json
from typing import Any

from ..config import settings
from .pii import redact_pii_payload

_SENSITIVE_KEY_TOKENS = (
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "client_secret",
    "api_key",
    "apikey",
    "bearer",
    "jwt",
)


def _should_drop_key(key: str) -> bool:
    lowered = key.lower()
    return any(token in lowered for token in _SENSITIVE_KEY_TOKENS)


def _strip_sensitive_keys(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            if key is None:
                continue
            key_str = str(key)
            if _should_drop_key(key_str):
                continue
            cleaned[key_str] = _strip_sensitive_keys(item)
        return cleaned
    if isinstance(value, list):
        return [_strip_sensitive_keys(item) for item in value]
    if isinstance(value, tuple):
        return [_strip_sensitive_keys(item) for item in value]
    return value


def _serialize_payload(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str)


def _truncate_payload(payload: dict) -> dict:
    max_bytes = int(getattr(settings, "PDP_RAW_JSON_MAX_BYTES", 0) or 0)
    if max_bytes <= 0:
        return {"_truncated": True}
    serialized = _serialize_payload(payload)
    if len(serialized) <= max_bytes:
        return payload
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    wrapper = {
        "_truncated": True,
        "payload_sha256": digest,
        "payload_bytes": len(serialized),
    }
    empty_preview = _serialize_payload({**wrapper, "payload_preview": ""})
    available = max_bytes - len(empty_preview)
    if available <= 0:
        return wrapper
    preview = serialized[: min(512, available)]
    wrapper["payload_preview"] = preview
    final = _serialize_payload(wrapper)
    if len(final) > max_bytes:
        wrapper.pop("payload_preview", None)
    return wrapper


def sanitize_provider_payload(payload: dict | None) -> dict:
    if not isinstance(payload, dict):
        return {}
    stripped = _strip_sensitive_keys(payload)
    redacted = redact_pii_payload(stripped)
    if not isinstance(redacted, dict):
        return {}
    return _truncate_payload(redacted)
