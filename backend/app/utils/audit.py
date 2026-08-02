import hashlib
import json
import re
from typing import cast

from .pii import redact_pii_payload, redact_public_url_tokens

_PAYLOAD_ALLOWLIST = {
    "number",
    "type",
    "from",
    "to",
    "status",
    "count",
    "amount",
    "method",
    "invoice_id",
    "payment_id",
    "due_date",
    "to_masked",
    "pdf_sha256",
    "xml_sha256",
    "facturx_sha256",
    "issued_hash",
    "payload_hash",
    "transmission_id",
    "external_id",
    "channel",
    "tx_status",
    "period_start",
    "period_end",
    "format",
    "record_count",
    "export_key",
    "checksum",
    "event_type",
    "status_code",
    "ok",
    "error_code",
    "url_host",
    "updated_fields",
    "secret_set",
    "event_count",
    "events",
}

_TOKEN_KEYS = (
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "secret",
    "password",
    "authorization",
    "bearer",
    "jwt",
)

_ADDRESS_KEYS = (
    "address",
    "adresse",
    "street",
    "rue",
    "postal",
    "postcode",
    "zip",
    "city",
    "ville",
    "line1",
    "line2",
    "delivery_address",
)

_TOKEN_TEXT_RE = re.compile(
    r"(?i)\b(bearer|token|access_token|refresh_token|api_key|apikey|authorization)"
    r"(\s*[:=]\s*|\s+)([A-Za-z0-9._~+/=-]{6,})"
)
_JWT_TEXT_RE = re.compile(r"\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
_MAX_ACTION_LOG_BYTES = 4096


def _mask_value(value: object, keep: int = 4) -> str:
    raw = "" if value is None else str(value)
    if not raw:
        return "***"
    stripped = "".join(ch for ch in raw if ch.isalnum())
    if not stripped:
        return "***"
    keep = max(0, min(keep, len(stripped)))
    return ("*" * (len(stripped) - keep)) + stripped[-keep:]


def _is_sensitive_key(key: str) -> str | None:
    lowered = key.lower()
    if any(token in lowered for token in _TOKEN_KEYS):
        return "token"
    if any(token in lowered for token in _ADDRESS_KEYS):
        return "address"
    return None


def _mask_tokens_in_text(text: str) -> str:
    redacted = _TOKEN_TEXT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}***", text)
    redacted = _JWT_TEXT_RE.sub("***", redacted)
    return redact_public_url_tokens(redacted)


def _redact_sensitive_payload(value: object) -> object:
    if isinstance(value, dict):
        cleaned: dict[str, object] = {}
        for key, item in value.items():
            if key is None:
                continue
            key_str = str(key)
            kind = _is_sensitive_key(key_str)
            if kind == "address":
                cleaned[key_str] = _mask_value(item, keep=0)
            elif kind == "token":
                cleaned[key_str] = _mask_value(item, keep=4)
            else:
                cleaned[key_str] = _redact_sensitive_payload(item)
        return cleaned
    if isinstance(value, list):
        return [_redact_sensitive_payload(item) for item in value]
    if isinstance(value, tuple):
        return [_redact_sensitive_payload(item) for item in value]
    if isinstance(value, str):
        return _mask_tokens_in_text(value)
    return value


def _truncate_payload(serialized: str) -> str:
    if len(serialized) <= _MAX_ACTION_LOG_BYTES:
        return serialized
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    wrapper = {
        "truncated": True,
        "payload_sha256": digest,
        "payload_bytes": len(serialized),
    }
    empty_preview = {**wrapper, "payload_preview": ""}
    empty_dump = json.dumps(empty_preview, ensure_ascii=True, separators=(",", ":"), default=str)
    available = _MAX_ACTION_LOG_BYTES - len(empty_dump)
    if available <= 0:
        return json.dumps(wrapper, ensure_ascii=True, separators=(",", ":"), default=str)
    preview = serialized[: min(512, available)]
    wrapper["payload_preview"] = preview
    final = json.dumps(wrapper, ensure_ascii=True, separators=(",", ":"), default=str)
    if len(final) > _MAX_ACTION_LOG_BYTES:
        wrapper.pop("payload_preview", None)
        final = json.dumps(wrapper, ensure_ascii=True, separators=(",", ":"), default=str)
    return final


def redact_audit_payload(raw: str | dict | None) -> dict | None:
    if not raw:
        return None
    data = raw
    if not isinstance(data, dict):
        try:
            data = json.loads(cast(str, data))
        except Exception:
            return None
    if not isinstance(data, dict):
        return None
    cleaned: dict = {}
    for key in _PAYLOAD_ALLOWLIST:
        if key not in data:
            continue
        value = data.get(key)
        if isinstance(value, str):
            cleaned[key] = value[:200]
        elif isinstance(value, (int, float, bool)) or value is None:
            cleaned[key] = value
    return cleaned or None


def sanitize_action_log_payload(payload: dict | list | str | None) -> str | None:
    if payload is None:
        return None
    value = payload
    if isinstance(payload, str):
        try:
            value = json.loads(payload)
        except Exception:
            value = payload
    redacted = redact_pii_payload(value)
    redacted = _redact_sensitive_payload(redacted)
    try:
        serialized = json.dumps(redacted, ensure_ascii=True, separators=(",", ":"), default=str)
    except Exception:
        return None
    return _truncate_payload(serialized)


def sanitize_action_log_metadata(payload: dict | list | str | None) -> dict | list | str | None:
    serialized = sanitize_action_log_payload(payload)
    if not serialized:
        return None
    try:
        return json.loads(serialized)
    except Exception:
        return None
