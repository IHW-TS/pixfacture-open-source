from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Request, Response


router = APIRouter(prefix="/api/security", tags=["security"])

logger = logging.getLogger("security.csp")

MAX_REPORT_BYTES = 16 * 1024
MAX_FIELD_LEN = 500
DEDUPE_WINDOW_SECONDS = 60
BUCKET_TTL_SECONDS = 10 * 60
MAX_BUCKETS = 500

_CSP_BUCKETS: dict[str, dict[str, float | int]] = {}


def _trim(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip()
    return text[:MAX_FIELD_LEN] if len(text) > MAX_FIELD_LEN else text


def _sanitize_origin(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip()
    try:
        parsed = urlparse(text)
    except Exception:
        return _trim(text)
    if not parsed.scheme or not parsed.netloc:
        return _trim(text)
    return _trim(f"{parsed.scheme}://{parsed.netloc}")


def _classify_uri(value: str | None) -> dict[str, str | None]:
    if not value:
        return {"kind": None, "origin": None, "display": None}
    text = value.strip()
    lowered = text.lower()
    if lowered in {"inline", "eval", "self", "unsafe-inline", "unsafe-eval"}:
        return {"kind": lowered, "origin": None, "display": _trim(lowered)}
    if lowered.startswith("data:"):
        return {"kind": "data", "origin": None, "display": "data:"}
    if lowered.startswith("blob:"):
        return {"kind": "blob", "origin": None, "display": "blob:"}
    if lowered.startswith("filesystem:"):
        return {"kind": "filesystem", "origin": None, "display": "filesystem:"}
    if lowered.startswith("about:"):
        return {"kind": "about", "origin": None, "display": "about:"}
    try:
        parsed = urlparse(text)
    except Exception:
        return {"kind": None, "origin": None, "display": _trim(text)}
    if parsed.scheme and parsed.netloc:
        origin = _trim(f"{parsed.scheme}://{parsed.netloc}")
        return {"kind": parsed.scheme, "origin": origin, "display": origin}
    return {"kind": None, "origin": None, "display": _trim(text)}


def _dict_optional_str(payload: dict[str, object], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) else None


def _extract_report(payload: object) -> dict | None:
    if not isinstance(payload, dict):
        return None
    report = payload.get("csp-report")
    if isinstance(report, dict):
        return report
    return payload


def _fingerprint(*parts: str | None) -> str:
    clean = [part or "" for part in parts]
    raw = json.dumps(clean, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _prune_buckets(now: float) -> None:
    cutoff = now - BUCKET_TTL_SECONDS
    stale = [key for key, meta in _CSP_BUCKETS.items() if meta.get("last_seen", 0) < cutoff]
    for key in stale:
        _CSP_BUCKETS.pop(key, None)
    if len(_CSP_BUCKETS) <= MAX_BUCKETS:
        return
    ordered = sorted(_CSP_BUCKETS.items(), key=lambda item: item[1].get("last_seen", 0))
    overflow = len(_CSP_BUCKETS) - MAX_BUCKETS
    for key, _meta in ordered[:overflow]:
        _CSP_BUCKETS.pop(key, None)


@router.post("/csp-report")
async def csp_report(request: Request) -> Response:
    raw = await request.body()
    truncated = False
    if raw and len(raw) > MAX_REPORT_BYTES:
        raw = raw[:MAX_REPORT_BYTES]
        truncated = True
    payload = None
    if raw:
        try:
            payload = json.loads(raw)
        except Exception:
            payload = None
    report = _extract_report(payload)
    if isinstance(report, dict):
        blocked = _classify_uri(report.get("blocked-uri") or report.get("blockedURI"))
        doc_origin = _sanitize_origin(report.get("document-uri") or report.get("documentURI"))
        source_origin = _sanitize_origin(report.get("source-file") or report.get("sourceFile"))
        directive = _trim(report.get("effective-directive") or report.get("violated-directive"))
        logged = {
            "event": "csp_report",
            "violated_directive": _trim(report.get("violated-directive")),
            "effective_directive": _trim(report.get("effective-directive")),
            "directive": directive,
            "blocked_uri": blocked.get("display"),
            "blocked_uri_origin": blocked.get("origin"),
            "blocked_uri_kind": blocked.get("kind"),
            "document_uri": doc_origin,
            "source_file": source_origin,
            "line_number": report.get("line-number") or report.get("lineNumber"),
            "column_number": report.get("column-number") or report.get("columnNumber"),
            "disposition": _trim(report.get("disposition")),
            "status_code": report.get("status-code") or report.get("statusCode"),
            "truncated": truncated,
        }
        group_id = _fingerprint(
            _dict_optional_str(logged, "directive"),
            _dict_optional_str(logged, "blocked_uri_kind"),
            _dict_optional_str(logged, "blocked_uri_origin"),
            _dict_optional_str(logged, "document_uri"),
            _dict_optional_str(logged, "disposition"),
        )
        now = time.time()
        bucket = _CSP_BUCKETS.get(group_id)
        if not bucket:
            bucket = {"count": 0, "first_seen": now, "last_seen": now, "last_log": 0}
        bucket["count"] = int(bucket.get("count", 0)) + 1
        bucket["last_seen"] = now
        last_log = float(bucket.get("last_log", 0))
        if now - last_log >= DEDUPE_WINDOW_SECONDS:
            logged["group_id"] = group_id
            logged["count"] = bucket.get("count", 1)
            logged["first_seen"] = _iso(float(bucket.get("first_seen", now)))
            logged["last_seen"] = _iso(float(bucket.get("last_seen", now)))
            logged["dedupe_window_s"] = DEDUPE_WINDOW_SECONDS
            logger.warning(json.dumps(logged, separators=(",", ":"), ensure_ascii=True))
            bucket["count"] = 0
            bucket["last_log"] = now
        _CSP_BUCKETS[group_id] = bucket
        _prune_buckets(now)
    else:
        logger.warning(json.dumps({"event": "csp_report", "parse": "invalid", "truncated": truncated}))
    return Response(status_code=204)
