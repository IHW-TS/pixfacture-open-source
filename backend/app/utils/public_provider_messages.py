from __future__ import annotations

import re
from typing import Any


_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]+")
_ERROR_CODE_ONLY = re.compile(r"^[a-z][a-z0-9_:-]{2,}$", re.IGNORECASE)
_TECHNICAL_PROVIDER_TEXT = re.compile(
    r"(?:[a-z][a-z0-9+.-]*://)"
    r"|(?:^|[\s(\"'])(?:/(?:app|etc|home|opt|srv|tmp|usr|var)/|[a-z]:\\)"
    r"|\b(?:traceback|stack(?:\s+trace)?|internal\s+server\s+error|sqlstate|sqlalchemy|"
    r"operationalerror|integrityerror|programmingerror|databaseerror|validationerror|pydantic|"
    r"exception|socketerror|connection\s+(?:refused|reset|aborted)|connexion\s+refus[eé]e|"
    r"econnrefused|econnreset|errno\s*\d+|endpoint|payload|request[_ -]?id|correlation[_ -]?id|"
    r"client[_ -]?secret|api[_ -]?key|authorization|bearer)\b"
    r"|\b(?:SEQINO|PISTE|CHORUS|DATABASE|REDIS|POSTGRES|PLATFORM|STRIPE|AWS|S3)_[A-Z0-9_]+\b"
    r"|\b(?:password|passwd|secret|token)\s*[:=]",
    re.IGNORECASE,
)


def sanitize_public_provider_message(
    value: Any,
    *,
    fallback: str | None = None,
    max_chars: int = 300,
) -> str | None:
    """Keep business rejection reasons while dropping provider internals."""

    if value is None:
        return fallback
    text = _CONTROL_CHARS.sub(" ", str(value))
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return fallback
    if _ERROR_CODE_ONLY.fullmatch(text) and any(separator in text for separator in ("_", ":")):
        return fallback
    if _TECHNICAL_PROVIDER_TEXT.search(text):
        return fallback
    limit = max(1, int(max_chars))
    return text[:limit]
