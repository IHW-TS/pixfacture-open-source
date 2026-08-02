import hashlib
import json
import logging
import re
from typing import Any


def mask_email(email: str | None) -> str:
    if not email:
        return ""
    parts = email.split("@")
    if len(parts) != 2:
        return "***"
    local, domain = parts
    local_mask = (local[:1] + "***") if local else "*"
    domain_parts = domain.split(".")
    if len(domain_parts) > 1:
        dom = domain_parts[0]
        dom_mask = (dom[:1] + "***") if dom else "*"
        domain_mask = dom_mask + "." + ".".join(domain_parts[1:])
    else:
        domain_mask = (domain[:1] + "***") if domain else "*"
    return f"{local_mask}@{domain_mask}"


def hash_email(email: str | None) -> str:
    if not email:
        return ""
    norm = email.strip().lower().encode("utf-8")
    return hashlib.sha256(norm).hexdigest()


_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_SIRET_RE = re.compile(r"\b(?:\d[ -]?){13}\d\b")
_SIREN_RE = re.compile(r"\b(?:\d[ -]?){8}\d\b")
_VAT_RE = re.compile(r"\b(?=[A-Z0-9]{6,16}\b)(?=[A-Z0-9]*\d)[A-Z]{2}[A-Z0-9]{4,14}\b", re.IGNORECASE)
_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?:[A-Z0-9][ -]?){11,30}\b", re.IGNORECASE)
_BIC_RE = re.compile(r"\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?\b", re.IGNORECASE)
_BEARER_RE = re.compile(r"(?i)(bearer\s+)([A-Za-z0-9._-]{8,})")
_TOKEN_KV_RE = re.compile(r"(?i)\b(token|secret|api[_-]?key|authorization)\b(\s*[:=]\s*)([A-Za-z0-9._-]{8,})")
_COMPOSED_SECRET_KV_RE = re.compile(
    r"(?i)\b("
    r"[a-z0-9_.-]*(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret)"
    r")\b(\s*[:=]\s*)(['\"]?)([^\s&#;,<>\"']+)(\3)"
)
_PUBLIC_URL_TOKEN_RE = re.compile(
    r"((?:https?://[^\s'\"<>]+)?/(?:i|q|c)/)[A-Za-z0-9_-]{20,}"
    r"|((?:https?://[^\s'\"<>]+)?/api/public/(?:invoices|quotes|customers)/)[A-Za-z0-9_-]{20,}"
)
_PUBLIC_URL_TOKEN_PLACEHOLDER = "[redacted]"
_PUBLIC_URL_TOKEN_SENTINEL = "[__PUBLIC_URL_TOKEN_REDACTED__]"
_PUBLIC_URL_REDACTED_SEGMENT_RE = re.compile(
    r"(?:https?://[^\s'\"<>]+)?/(?:i|q|c)/\[redacted\]"
    r"|(?:https?://[^\s'\"<>]+)?/api/public/(?:invoices|quotes|customers)/\[redacted\]"
)
_PUBLIC_URL_REDACTED_SEGMENT_SENTINEL_PREFIX = "[__PUBLIC_URL_REDACTED_SEGMENT_"
_INTERNAL_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_SENSITIVE_KEY_TOKENS = (
    "email",
    "siret",
    "siren",
    "vat",
    "tva",
    "iban",
    "bic",
)
_TOKEN_KEY_TOKENS = (
    "token",
    "secret",
    "api_key",
    "apikey",
    "authorization",
    "access_key",
)


def _mask_identifier(value: str | None, *, keep: int = 4) -> str:
    if not value:
        return ""
    raw = str(value)
    digits = "".join(ch for ch in raw if ch.isalnum())
    if not digits:
        return "***"
    keep = max(0, min(keep, len(digits)))
    masked = "*" * (len(digits) - keep) + digits[-keep:]
    return masked


def redact_public_url_tokens(text: str | None) -> str:
    if text is None:
        return ""
    return _PUBLIC_URL_TOKEN_RE.sub(lambda m: f"{m.group(1) or m.group(2)}[redacted]", str(text))


def redact_pii_text(text: str | None) -> str:
    if text is None:
        return ""
    raw = str(text)
    raw = redact_public_url_tokens(raw)
    protected_public_urls: list[str] = []

    def _protect_public_url(match: re.Match[str]) -> str:
        protected_public_urls.append(match.group(0))
        return f"{_PUBLIC_URL_REDACTED_SEGMENT_SENTINEL_PREFIX}{len(protected_public_urls) - 1}__]"

    raw = _PUBLIC_URL_REDACTED_SEGMENT_RE.sub(_protect_public_url, raw)
    raw = raw.replace(_PUBLIC_URL_TOKEN_PLACEHOLDER, _PUBLIC_URL_TOKEN_SENTINEL)
    trimmed = raw.strip()
    if trimmed.startswith("{") or trimmed.startswith("["):
        try:
            parsed = json.loads(trimmed)
        except Exception:
            parsed = None
        if parsed is not None:
            redacted = redact_pii_payload(parsed)
            return json.dumps(redacted, ensure_ascii=True, separators=(",", ":"), default=str)
    redacted = _BEARER_RE.sub(lambda m: f"{m.group(1)}***", raw)
    redacted = _COMPOSED_SECRET_KV_RE.sub(
        lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}***{m.group(5)}",
        redacted,
    )
    redacted = _TOKEN_KV_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}***", redacted)
    redacted = _EMAIL_RE.sub(lambda m: mask_email(m.group(0)), redacted)
    redacted = _SIRET_RE.sub(lambda m: _mask_identifier(m.group(0)), redacted)
    redacted = _SIREN_RE.sub(lambda m: _mask_identifier(m.group(0)), redacted)
    redacted = _VAT_RE.sub(lambda m: _mask_identifier(m.group(0)), redacted)
    redacted = _IBAN_RE.sub(lambda m: _mask_identifier(m.group(0)), redacted)
    redacted = _BIC_RE.sub(lambda m: _mask_identifier(m.group(0)), redacted)
    redacted = redacted.replace(_PUBLIC_URL_TOKEN_SENTINEL, _PUBLIC_URL_TOKEN_PLACEHOLDER)
    for index, public_url in enumerate(protected_public_urls):
        redacted = redacted.replace(
            f"{_PUBLIC_URL_REDACTED_SEGMENT_SENTINEL_PREFIX}{index}__]",
            public_url,
        )
    return redacted


def _should_redact_key(key: str) -> bool:
    lowered = key.lower()
    if "hash" in lowered:
        return False
    return any(token in lowered for token in _SENSITIVE_KEY_TOKENS)


def _is_token_key(key: str) -> bool:
    lowered = key.lower()
    if "hash" in lowered:
        return False
    return any(token in lowered for token in _TOKEN_KEY_TOKENS)


def redact_pii_payload(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            if key is None:
                continue
            key_str = str(key)
            if _is_token_key(key_str):
                sanitized[key_str] = "***"
                continue
            # UUID primary/foreign keys are operational correlation values,
            # not French legal identifiers.  Preserve them under explicit
            # ``*_id`` keys so an internal incident log still points to the
            # exact record.  Free text, Stripe IDs and public access tokens
            # continue through the normal redaction path.
            if key_str.lower().endswith("_id") and isinstance(item, str) and _INTERNAL_UUID_RE.fullmatch(item):
                sanitized[key_str] = item
                continue
            if _should_redact_key(key_str):
                if "email" in key_str.lower():
                    sanitized[key_str] = mask_email(str(item) if item is not None else "")
                else:
                    sanitized[key_str] = _mask_identifier(item)
                continue
            sanitized[key_str] = redact_pii_payload(item)
        return sanitized
    if isinstance(value, list):
        return [redact_pii_payload(item) for item in value]
    if isinstance(value, tuple):
        return [redact_pii_payload(item) for item in value]
    if isinstance(value, str):
        return redact_pii_text(value)
    return value


class PiiRedactionFilter(logging.Filter):
    def filter(self, record) -> bool:
        try:
            if str(record.name).startswith("uvicorn.access"):
                args = record.args
                if isinstance(args, (list, tuple)):
                    record.args = tuple(
                        redact_pii_text(item) if isinstance(item, str) else item
                        for item in args
                    )
            else:
                message = record.getMessage()
                record.msg = redact_pii_text(message)
                record.args = ()
        except Exception:
            return True
        default_fields = {
            "name",
            "msg",
            "args",
            "levelname",
            "levelno",
            "pathname",
            "filename",
            "module",
            "exc_info",
            "exc_text",
            "stack_info",
            "lineno",
            "funcName",
            "created",
            "msecs",
            "relativeCreated",
            "thread",
            "threadName",
            "processName",
            "process",
        }
        for key, item in list(record.__dict__.items()):
            if key in default_fields:
                continue
            if isinstance(item, str):
                # Structured log fields must follow the same key-aware policy as
                # JSON payloads.  In particular, an internal UUID under a
                # ``*_id`` key is an operational correlation value and must not
                # be mistaken for a BIC merely because one UUID segment happens
                # to match the BIC character pattern.  Conversely, a scalar
                # secret under an explicit token/secret key must be redacted even
                # when the value itself has no ``key=value`` prefix.
                redacted_field = redact_pii_payload({key: item})
                record.__dict__[key] = redacted_field.get(key, "***")
            elif isinstance(item, (dict, list, tuple)):
                record.__dict__[key] = redact_pii_payload(item)
        return True
