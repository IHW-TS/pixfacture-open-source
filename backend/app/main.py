import json
import ipaddress
import logging
import mimetypes
import re
import shutil
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, cast

from fastapi import Depends, FastAPI, Request, Response
import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from fastapi.responses import JSONResponse
from fastapi.openapi.utils import get_openapi
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.orm import Session
from urllib.parse import urlparse
from redis import Redis

from .config import (
    settings,
    _allowed_hosts_value,
    _is_prod_env,
    _parse_hosts,
    auth_cookie_mode_enabled,
    enforce_http_generic_allowlist_sanity,
    enforce_runtime_env_sanity,
    sentry_send_default_pii_enabled,
    validate_cookie_cors,
    validate_prod_config,
    ensure_facturx_spec_supported,
)
from .db import get_db
from . import auth, metrics
from .routers import email_webhooks
from .routers import seqino_webhooks
from .routers import invoices, quotes, public_quotes, public_invoices, public_customers, platforms, customers, users, billing, company, support, items, admin, api_access, audit, settings as settings_router, einvoicing, einvoicing_pdp, jobs, diagnostic, directory, client, compliance, inbox, ereporting, usage, readiness, tokens, exports, pdp_seqino, b2b_einvoicing, security, features, legal, webhooks, metrics as metrics_router, leads, lookup, sandbox, collections, search, activity, document_attachments, attachments, workspace, recurring, ops, ops_alerts, ops_comms, ops_portfolio, ops_campaigns, ops_outbox, ops_scheduler, ops_supervision, cockpit, attention
from .jobs.diagnostic import collect_jobs_diagnostic
from .services.facturx import ensure_pdfa_validator_available, _pdfa_policy, _resolve_srgb_icc_path
from .services.storage import run_storage_readiness_check
from .services.usage import UsageQuotaExceeded
from .utils.asset_security import STATIC_DIR, ensure_static_dirs
from .utils.pii import PiiRedactionFilter, redact_pii_payload, redact_pii_text, redact_public_url_tokens
from .utils.public_errors import (
    friendly_validation_message,
    public_error_fallback,
    sanitize_public_error_message,
)
from .utils.request_context import RequestContextFilter, RequestContextMiddleware
from .middleware.trusted_proxy_headers import TrustedProxyHeadersMiddleware



# Logging de base (lisible et parsable)
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format='{"ts":"%(asctime)s","lvl":"%(levelname)s","logger":"%(name)s","request_id":"%(request_id)s","tenant_id":"%(tenant_id)s","user_id":"%(user_id)s","msg":"%(message)s"}',
)
for handler in logging.getLogger().handlers:
    handler.addFilter(PiiRedactionFilter())
    handler.addFilter(RequestContextFilter())
for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    for handler in logging.getLogger(logger_name).handlers:
        handler.addFilter(PiiRedactionFilter())
        handler.addFilter(RequestContextFilter())
csrf_logger = logging.getLogger("security.csrf")
_READYZ_STORAGE_CACHE: dict[str, object] = {"checked_at": 0.0, "ok": False, "latency_ms": None, "error": None}
_READYZ_STORAGE_TTL_SECONDS = 30.0
_READYZ_RESPONSE_HEADERS = {"Cache-Control": "no-store"}

SENTRY_SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-csrf-token",
    "x-xsrf-token",
    "x-forwarded-for",
    "x-real-ip",
    "x-client-ip",
}
SENTRY_BODY_PREVIEW_ALLOWLIST = (
    "/api/health",
    "/api/healthz",
    "/api/readyz",
    "/api/security/csp-report",
)
SENTRY_SENSITIVE_BODY_KEYS = {
    "email",
    "siret",
    "siren",
    "vat_number",
    "vat",
    "tva",
    "tax",
    "iban",
    "bic",
    "swift",
    "address",
    "address_line1",
    "address_line2",
    "postal_code",
    "postcode",
    "zip",
    "zipcode",
    "city",
    "country",
    "phone",
    "mobile",
    "contact",
    "contact_name",
    "first_name",
    "last_name",
    "company_name",
    "customer_name",
    "lines",
    "line_items",
    "items",
    "description",
    "note",
    "notes",
    "password",
    "secret",
    "token",
}
SENTRY_SENSITIVE_BODY_KEY_TOKENS = (
    "address",
    "postal",
    "postcode",
    "zip",
    "city",
    "country",
    "iban",
    "bic",
    "swift",
    "phone",
    "mobile",
    "contact",
    "name",
    "line",
    "item",
    "description",
    "note",
    "siret",
    "siren",
    "vat",
    "tva",
    "tax",
    "password",
    "secret",
    "token",
)
SENTRY_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

def _is_body_preview_allowed(path: str | None) -> bool:
    if not path:
        return False
    for allowed in SENTRY_BODY_PREVIEW_ALLOWLIST:
        if path == allowed or path.startswith(f"{allowed}/"):
            return True
    return False

def _is_sensitive_key(key_str: str) -> bool:
    if key_str in SENTRY_SENSITIVE_BODY_KEYS:
        return True
    return any(token in key_str for token in SENTRY_SENSITIVE_BODY_KEY_TOKENS)

def _contains_sensitive_body(value: Any, *, path: str | None = None) -> bool:
    if not _is_body_preview_allowed(path):
        return True
    if isinstance(value, dict):
        for key, item in value.items():
            key_str = str(key).lower()
            if _is_sensitive_key(key_str):
                return True
            if _contains_sensitive_body(item, path=path):
                return True
        return False
    if isinstance(value, (list, tuple)):
        return any(_contains_sensitive_body(item, path=path) for item in value)
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return False
        if trimmed.startswith("{") or trimmed.startswith("["):
            try:
                parsed = json.loads(trimmed)
            except Exception:
                parsed = None
            if parsed is not None:
                return _contains_sensitive_body(parsed, path=path)
        lowered = trimmed.lower()
        if any(token in lowered for token in SENTRY_SENSITIVE_BODY_KEYS):
            return True
        return bool(SENTRY_EMAIL_RE.search(trimmed))
    return False

def _scrub_headers(headers: Any) -> Any:
    if isinstance(headers, dict):
        scrubbed: dict[str, Any] = {}
        for key, value in headers.items():
            if str(key).lower() in SENTRY_SENSITIVE_HEADERS:
                continue
            scrubbed[key] = value
        return scrubbed
    if isinstance(headers, (list, tuple)):
        scrubbed_list: list[tuple[Any, Any]] = []
        for item in headers:
            if not item or len(item) < 2:
                continue
            key, value = item[0], item[1]
            if str(key).lower() in SENTRY_SENSITIVE_HEADERS:
                continue
            scrubbed_list.append((key, value))
        return scrubbed_list
    return headers

def _scrub_sentry_url(value: str | None) -> str | None:
    if not value:
        return value
    redacted = redact_public_url_tokens(value)
    parsed = urlparse(redacted)
    if parsed.scheme and parsed.netloc:
        path = redact_pii_text(parsed.path or "/")
        return parsed._replace(path=path, params="", query="", fragment="").geturl()
    return redact_pii_text(redacted.split("?", 1)[0].split("#", 1)[0])


def _scrub_sentry_event(event: dict[str, Any], hint: Any) -> dict[str, Any]:
    request = event.get("request") or {}
    request_path = None
    if isinstance(request.get("url"), str):
        request_path = urlparse(request["url"]).path or request.get("url")
    elif isinstance(request.get("path"), str):
        request_path = request.get("path")
    if isinstance(request.get("url"), str):
        request["url"] = _scrub_sentry_url(request.get("url"))
    if isinstance(request.get("path"), str):
        request["path"] = _scrub_sentry_url(request.get("path"))
    request.pop("query_string", None)
    request.pop("fragment", None)
    headers = request.get("headers")
    if headers is not None:
        request["headers"] = _scrub_headers(headers)
    request.pop("cookies", None)
    request.pop("client_ip", None)
    env = request.get("env")
    if isinstance(env, dict):
        for key in ("REMOTE_ADDR", "HTTP_X_FORWARDED_FOR", "HTTP_X_REAL_IP", "REMOTE_HOST"):
            env.pop(key, None)
        request["env"] = env
    for body_key in ("data", "body", "json"):
        if body_key in request and _contains_sensitive_body(request.get(body_key), path=request_path):
            request.pop(body_key, None)
    event["request"] = request
    user = event.get("user")
    if isinstance(user, dict):
        user.pop("email", None)
        user.pop("username", None)
        user.pop("ip_address", None)
        event["user"] = user
    return cast(dict[str, Any], redact_pii_payload(event))

# Sentry pour les erreurs 500 et la perf
if settings.SENTRY_DSN:
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.APP_ENV,
        integrations=[FastApiIntegration()],
        traces_sample_rate=float(getattr(settings, "SENTRY_TRACES_SAMPLE_RATE", 0.1) or 0.1),
        send_default_pii=bool(sentry_send_default_pii_enabled()),
        before_send=cast(Any, _scrub_sentry_event),
    )


@asynccontextmanager
async def app_lifespan(_: FastAPI) -> AsyncIterator[None]:
    startup_checks()
    yield


_docs_enabled = not _is_prod_env()

app = FastAPI(
    title="PixFacture — API FINAL",
    version="7.0.0",
    openapi_url="/api/openapi.json" if _docs_enabled else None,  # important pour Traefik
    docs_url="/api/docs" if _docs_enabled else None,
    redoc_url="/api/redoc" if _docs_enabled else None,
    lifespan=app_lifespan,
)


@app.middleware("http")
async def block_chunked_delete_options(request: Request, call_next):
    transfer_encoding = (request.headers.get("transfer-encoding") or "").lower()
    is_chunked = any(part.strip() == "chunked" for part in transfer_encoding.split(","))
    if request.method.upper() in {"DELETE", "OPTIONS"} and is_chunked:
        payload = _serialize_error(
            {"code": "chunked_request_blocked", "message": "Chunked DELETE/OPTIONS blocked on API routes."},
            400,
        )
        return JSONResponse(status_code=400, content=payload)
    return await call_next(request)

def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    description = (
        "API Key Auth: utilisez l'en-tete X-API-Key pour les integrations server-to-server "
        "(en complement de l'auth cookie/JWT). Contrat lisible expose via /api/api-access/contract."
    )
    openapi_schema = get_openapi(
        title=app.title,
        version=app.version,
        description=description,
        routes=app.routes,
    )
    components = openapi_schema.setdefault("components", {})
    security = components.setdefault("securitySchemes", {})
    security["ApiKeyAuth"] = {
        "type": "apiKey",
        "in": "header",
        "name": "X-API-Key",
        "description": "API Key Auth pour integrations server-to-server.",
    }
    openapi_schema["externalDocs"] = {
        "description": "Contrat d'integration et reference webhook",
        "url": "/api/api-access/contract",
    }
    app.openapi_schema = openapi_schema
    return app.openapi_schema

# FastAPI autorise la surcharge de `openapi`; `setattr` evite un faux positif mypy
setattr(app, "openapi", custom_openapi)

ensure_static_dirs()
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")
mimetypes.add_type("font/woff2", ".woff2")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/api/static", StaticFiles(directory=str(STATIC_DIR)), name="api-static")

def _log_pdfa_status() -> None:
    policy = _pdfa_policy()
    gs_present = bool(shutil.which("gs"))
    verapdf_present = bool(shutil.which("verapdf"))
    try:
        _resolve_srgb_icc_path()
        icc_present = True
    except Exception:
        icc_present = False
    logger = logging.getLogger("startup.pdfa")
    logger.info(
        "PDF/A-3 config: mode=%s convert=%s validate=%s strict=%s gs=%s verapdf=%s icc=%s",
        policy.mode,
        "ON" if policy.convert else "OFF",
        "ON" if policy.validate else "OFF",
        "YES" if policy.strict else "NO",
        "YES" if gs_present else "NO",
        "YES" if verapdf_present else "NO",
        "YES" if icc_present else "NO",
    )
    if policy.mode != "off":
        missing: list[str] = []
        if policy.convert and not gs_present:
            missing.append("ghostscript (gs)")
        if policy.convert and not icc_present:
            missing.append("icc-profiles-free (sRGB)")
        if policy.validate and not verapdf_present:
            missing.append("veraPDF (verapdf)")
        if missing:
            if policy.strict:
                logger.error(
                    "PDF/A-3 prerequisites missing for mode=%s: %s",
                    policy.mode,
                    ", ".join(missing),
                )
            else:
                logger.warning(
                    "PDF/A-3 prerequisites missing for mode=%s: %s",
                    policy.mode,
                    ", ".join(missing),
                )


def _log_jobs_worker_status() -> None:
    diagnostic = collect_jobs_diagnostic()
    if not diagnostic.get("required"):
        return
    if diagnostic.get("status") == "ok":
        return
    logger = logging.getLogger("startup.jobs")
    redis_ok = diagnostic.get("redis_ok")
    workers_count = diagnostic.get("workers_count")
    logger.error(
        "worker RQ requis (redis_ok=%s workers=%s).",
        "yes" if redis_ok else "no",
        workers_count,
    )

def startup_checks() -> None:
    enforce_runtime_env_sanity()
    enforce_http_generic_allowlist_sanity()
    _log_pdfa_status()
    _log_jobs_worker_status()
    if _is_prod_env() and settings.FACTURX_STRICT:
        try:
            ensure_facturx_spec_supported()
        except Exception as exc:
            logger = logging.getLogger("startup.facturx")
            logger.error("Factur-X startup check failed: %s", exc)
            raise
    try:
        ensure_pdfa_validator_available()
    except Exception as exc:
        logger = logging.getLogger("startup.pdfa")
        logger.error("PDF/A-3 startup check failed: %s", exc)
        raise

@app.middleware("http")
async def sentry_context_middleware(request, call_next):
    try:
        import sentry_sdk
        with sentry_sdk.configure_scope() as scope:
            scope.set_tag("path", request.url.path)
            scope.set_tag("method", request.method)
            auth = request.headers.get("authorization") or ""
            scope.set_extra("auth_header_present", bool(auth))
    except Exception:
        pass
    response = await call_next(request)
    return response

_SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


def _is_inline_pdf_response(request: Request, response: Response) -> bool:
    inline = str(request.query_params.get("inline", "")).strip().lower() in {"1", "true", "yes"}
    content_type = (response.headers.get("content-type") or "").strip().lower()
    return inline and content_type.startswith("application/pdf")


@app.middleware("http")
async def security_headers_middleware(request, call_next):
    response = await call_next(request)
    if _is_inline_pdf_response(request, response):
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
    for key, value in _SECURITY_HEADERS.items():
        if key not in response.headers:
            response.headers[key] = value
    if _is_prod_env() and "Strict-Transport-Security" not in response.headers:
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"
    return response

_CSRF_EXEMPT_PATHS = (
    "/api/billing/webhook",
    "/api/webhooks/seqino",
    "/api/health",
    "/health",
    "/healthz",
    "/readyz",
    "/api/security/csp-report",
)

_CSRF_TOKEN_EXEMPT_PATHS = (
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/password-reset",
    "/api/auth/password-reset/confirm",
    "/api/auth/google",
    "/api/users/invites/accept",
    "/api/users/invite/accept",
    "/api/billing/webhook",
    "/api/webhooks/seqino",
    "/api/security/csp-report",
)

def _normalize_origin(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return None

def _expected_origin() -> str | None:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    if not base:
        return None
    return _normalize_origin(base)

def _csrf_allowed_origins() -> tuple[list[str], bool]:
    raw_origins = settings.CORS_ORIGINS or ""
    allow_any = False
    origins: list[str] = []
    base = _expected_origin()
    if base:
        origins.append(base)
    for origin in raw_origins.split(","):
        origin = origin.strip()
        if not origin:
            continue
        if origin == "*":
            allow_any = True
            continue
        normalized = _normalize_origin(origin)
        if normalized:
            origins.append(normalized)
    deduped: list[str] = []
    seen: set[str] = set()
    for origin in origins:
        if origin in seen:
            continue
        seen.add(origin)
        deduped.append(origin)
    return deduped, allow_any

def _log_csrf_event(request: Request, code: str, **extra: Any) -> None:
    payload = {
        "event": "csrf_rejected",
        "code": code,
        "path": request.url.path,
        "method": request.method,
        **extra,
    }
    csrf_logger.warning(json.dumps(payload, separators=(",", ":")))

def _is_bearer_request(request: Request) -> bool:
    auth = (request.headers.get("authorization") or "").strip()
    return auth.lower().startswith("bearer ")

def _has_auth_cookie(request: Request) -> bool:
    return bool(
        request.cookies.get(auth.ACCESS_COOKIE)
        or request.cookies.get(auth.SESSION_COOKIE)
    )

def _cookie_auth_required(request: Request) -> bool:
    header_mode = (request.headers.get("x-auth-mode") or "").strip().lower()
    if header_mode == "cookie":
        return True
    required = (request.headers.get("x-cookie-auth-required") or "").strip().lower()
    return required in {"1", "true", "yes"}

def _should_apply_csrf(request: Request) -> bool:
    if not auth_cookie_mode_enabled():
        return False
    if request.headers.get("x-api-key") is not None:
        return False
    if _is_bearer_request(request):
        return False
    if _has_auth_cookie(request):
        return True
    if _cookie_auth_required(request):
        return True
    return False

@app.middleware("http")
async def csrf_origin_middleware(request: Request, call_next):
    if request.method.upper() not in {"POST", "PUT", "PATCH", "DELETE"}:
        return await call_next(request)
    if not auth_cookie_mode_enabled():
        return await call_next(request)
    if request.headers.get("x-api-key") is not None:
        return await call_next(request)
    if _is_bearer_request(request):
        return await call_next(request)
    if any(request.url.path.startswith(p) for p in _CSRF_EXEMPT_PATHS):
        return await call_next(request)
    allowed_origins, allow_any = _csrf_allowed_origins()
    if allow_any and not _is_prod_env():
        return await call_next(request)
    if not allowed_origins:
        return await call_next(request)
    raw_origin = (request.headers.get("origin") or request.headers.get("referer") or "").strip()
    if not raw_origin and not _has_auth_cookie(request) and not _cookie_auth_required(request):
        return await call_next(request)
    actual = _normalize_origin(raw_origin)
    if not actual or actual not in allowed_origins:
        _log_csrf_event(
            request,
            "csrf_origin_invalid",
            origin=actual,
            origin_present=bool(actual),
            allowed_origins=allowed_origins,
        )
        payload = _serialize_error(
            {"code": "csrf_origin_invalid", "message": "Origine de requête invalide."},
            403,
        )
        return JSONResponse(status_code=403, content=payload)
    return await call_next(request)

@app.middleware("http")
async def csrf_token_middleware(request: Request, call_next):
    if not auth_cookie_mode_enabled():
        return await call_next(request)
    if request.method.upper() not in {"POST", "PUT", "PATCH", "DELETE"}:
        return await call_next(request)
    if not _should_apply_csrf(request):
        return await call_next(request)
    if any(request.url.path.startswith(p) for p in _CSRF_TOKEN_EXEMPT_PATHS):
        return await call_next(request)
    csrf_header = request.headers.get("X-CSRF-Token") or ""
    csrf_cookie = request.cookies.get("csrf_token") or ""
    if not csrf_header or not csrf_cookie or csrf_header != csrf_cookie:
        csrf_header_present = bool(csrf_header.strip())
        csrf_cookie_present = bool(csrf_cookie)
        if not csrf_header_present or not csrf_cookie_present:
            code = "csrf_missing"
            message = "Votre session n’est plus valide. Actualisez la page puis réessayez."
        else:
            code = "csrf_invalid"
            message = "Votre session n’est plus valide. Actualisez la page puis réessayez."
        _log_csrf_event(
            request,
            code,
            csrf_header_present=csrf_header_present,
            csrf_cookie_present=csrf_cookie_present,
        )
        payload = _serialize_error({"code": code, "message": message}, 403)
        return JSONResponse(status_code=403, content=payload)
    return await call_next(request)

raw_origins = settings.CORS_ORIGINS or ""
origins = [o.strip() for o in raw_origins.split(",") if o.strip()]
# En dev on accepte le wildcard, mais en prod on force un domaine explicite
if not origins and not _is_prod_env() and not auth_cookie_mode_enabled():
    origins = ["*"]
validate_cookie_cors(origins)
validate_prod_config(origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-CSRF-Required", "Content-Disposition"],
)

allowed_hosts = _parse_hosts(_allowed_hosts_value())
if allowed_hosts:
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=allowed_hosts,
    )
app.add_middleware(RequestContextMiddleware)
app.add_middleware(
    TrustedProxyHeadersMiddleware,
    trusted_cidrs=settings.TRUSTED_PROXY_CIDRS,
    trust_all=settings.TRUSTED_PROXY_ALWAYS,
)

_PUBLIC_ERROR_CODE = re.compile(r"^[a-z][a-z0-9_.:-]{1,79}$")
_PUBLIC_ERROR_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_PUBLIC_URL_KEYS = {"doc_url", "remediation_url", "contact_url", "async_endpoint"}
_PUBLIC_MACHINE_TEXT_KEYS = {
    "action",
    "artifact_kind",
    "code",
    "field",
    "fields",
    "kind",
    "level",
    "source",
    "status",
}
_PUBLIC_EXTRA_KEY = re.compile(r"^[a-z][a-z0-9_.:-]{0,79}$")
_PUBLIC_SENSITIVE_TOKEN = re.compile(r"(?:secret|password|passwd|authorization|api[_-]?key|access[_-]?token)", re.I)


def _safe_public_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate or any(char in candidate for char in ("\r", "\n", "\\")):
        return None
    parsed = urlparse(candidate)
    if candidate.startswith("/") and not candidate.startswith("//"):
        return parsed._replace(query="", fragment="").geturl()[:500]
    hostname = (parsed.hostname or "").lower()
    try:
        host_is_ip = bool(ipaddress.ip_address(hostname))
    except ValueError:
        host_is_ip = False
    host_is_private = (
        host_is_ip
        or hostname in {"localhost", "127.0.0.1", "::1"}
        or hostname.endswith((".local", ".internal", ".localhost"))
        or "." not in hostname
    )
    if (
        parsed.scheme == "https"
        and parsed.netloc
        and not parsed.username
        and not parsed.password
        and not host_is_private
    ):
        return parsed._replace(query="", fragment="").geturl()[:500]
    return None


def _sanitize_public_extra(value: Any, *, status_code: int, key: str | None = None, depth: int = 0) -> Any:
    if depth > 4:
        return None
    if key in _PUBLIC_URL_KEYS:
        return _safe_public_url(value)
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for raw_key, raw_value in list(value.items())[:50]:
            item_key = str(raw_key).strip()[:80]
            if not _PUBLIC_EXTRA_KEY.fullmatch(item_key) or _PUBLIC_SENSITIVE_TOKEN.search(item_key):
                continue
            sanitized = _sanitize_public_extra(raw_value, status_code=status_code, key=item_key, depth=depth + 1)
            if sanitized is not None:
                result[item_key] = sanitized
        return result
    if isinstance(value, (list, tuple)):
        return [
            sanitized
            for item in list(value)[:100]
            if (sanitized := _sanitize_public_extra(item, status_code=status_code, key=key, depth=depth + 1))
            is not None
        ]
    if isinstance(value, str):
        if (
            key in _PUBLIC_MACHINE_TEXT_KEYS
            and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", value.strip())
            and not _PUBLIC_SENSITIVE_TOKEN.search(value)
        ):
            return value.strip()
        return sanitize_public_error_message(
            value,
            status_code=status_code,
            fallback=public_error_fallback(status_code),
        )
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return None


def _serialize_error(detail: str | dict | None, status_code: int) -> dict:
    """
    Normalise les erreurs API pour éviter d'afficher des objets JSON bruts côté front.
    """
    fallback_code = f"HTTP_{status_code}"
    code = fallback_code
    message: Any = None
    error_id = None
    hint = None
    try:
        import sentry_sdk
        error_id = sentry_sdk.last_event_id() or None
    except Exception:
        error_id = None
    extra: dict[str, Any] = {}
    if isinstance(detail, dict):
        candidate_code = str(detail.get("code") or "").strip()
        if _PUBLIC_ERROR_CODE.fullmatch(candidate_code):
            code = candidate_code
        message = detail.get("message") or detail.get("detail")
        hint = detail.get("hint")
        if not error_id:
            error_id = detail.get("error_id")
        for key in (
            "issues",
            "doc_url",
            "field",
            "fields",
            "errors",
            "lock",
            "quality_checks",
            "artifact_kind",
            "required",
            "remediation_url",
            "contact_url",
            "action",
            "record_count",
            "max_records",
            "counts",
            "async_endpoint",
        ):
            if key in detail and detail[key] is not None:
                sanitized = _sanitize_public_extra(detail[key], status_code=status_code, key=key)
                if sanitized is not None:
                    extra[key] = sanitized
    elif isinstance(detail, str):
        message = detail
    if status_code >= 500:
        # HTTPException details may contain infrastructure URLs, credentials,
        # filesystem paths or raw dependency errors. Keep the stable error code
        # and correlation id for support, never the raw text in a 5xx response.
        message = public_error_fallback(status_code)
        hint = None
        extra = {}
    else:
        message = sanitize_public_error_message(message, status_code=status_code)
        if isinstance(hint, str):
            sanitized_hint = sanitize_public_error_message(hint, status_code=status_code)
            hint = None if sanitized_hint == public_error_fallback(status_code) else sanitized_hint
        else:
            hint = None
    if not message:
        message = public_error_fallback(status_code)
    err = {"code": code, "message": message}
    if hint:
        err["hint"] = hint
    if error_id and _PUBLIC_ERROR_ID.fullmatch(str(error_id)):
        err["error_id"] = str(error_id)
    if extra:
        err.update(extra)
    return {"error": err}


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request, exc: StarletteHTTPException):
    payload = _serialize_error(exc.detail, exc.status_code)
    safe_header_names = {"allow", "retry-after", "www-authenticate"}
    headers = {
        str(name): str(value)
        for name, value in (exc.headers or {}).items()
        if str(name).strip().lower() in safe_header_names
    }
    return JSONResponse(status_code=exc.status_code, content=payload, headers=headers)

@app.exception_handler(UsageQuotaExceeded)
async def usage_quota_handler(request: Request, exc: UsageQuotaExceeded):
    metrics.inc_operational_event("quota_exceeded")
    return JSONResponse(
        status_code=402,
        content={
            "error": "quota_exceeded",
            "message": sanitize_public_error_message(
                exc,
                status_code=402,
                fallback="Votre quota est atteint. Consultez votre abonnement pour continuer.",
            ),
        },
    )

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request, exc: RequestValidationError):
    message = friendly_validation_message(exc.errors())
    payload = _serialize_error({"code": "validation_error", "message": message}, 422)
    return JSONResponse(status_code=422, content=payload)


@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/health")
def health_root():
    return {"status": "ok"}

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.get("/api/healthz")
def healthz_api():
    return {"status": "ok"}

def _readyz_json(content: dict[str, Any], *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=content,
        headers=_READYZ_RESPONSE_HEADERS,
    )


def _readyz_response(db: Session) -> JSONResponse:
    checks: dict[str, str] = {}
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        checks["db"] = "down"
        return _readyz_json({"status": "error"}, status_code=503)
    checks["db"] = "ok"
    if _is_prod_env():
        redis_ok = True
        try:
            redis_url = (settings.REDIS_URL or "").strip()
            if not redis_url:
                redis_ok = False
            else:
                Redis.from_url(
                    redis_url,
                    socket_connect_timeout=0.2,
                    socket_timeout=0.2,
                    decode_responses=False,
                ).ping()
        except Exception:
            redis_ok = False
        if not redis_ok:
            checks["redis"] = "down"
            return _readyz_json({"status": "degraded", "checks": checks}, status_code=503)
        checks["redis"] = "ok"
        env = (settings.APP_ENV or "").strip().lower()
        workers_required = env in {"prod", "production", "staging"} and not settings.JOBS_SYNC
        if workers_required:
            diagnostic = collect_jobs_diagnostic()
            workers_count = int(diagnostic.get("workers_count") or 0)
            if workers_count == 0:
                checks["rq_workers"] = "down"
                return _readyz_json({"status": "degraded", "checks": checks}, status_code=503)
            checks["rq_workers"] = "ok"
        storage_ok = True
        storage_latency_ms: int | None = None
        storage_error: str | None = None
        now = time.monotonic()
        cache_age = now - float(_READYZ_STORAGE_CACHE.get("checked_at") or 0.0)
        if cache_age > _READYZ_STORAGE_TTL_SECONDS:
            storage_ok, storage_latency_ms, storage_error = run_storage_readiness_check(prefix="diagnostic/readyz/")
            _READYZ_STORAGE_CACHE.update(
                {
                    "checked_at": now,
                    "ok": storage_ok,
                    "latency_ms": storage_latency_ms,
                    "error": storage_error,
                }
            )
        else:
            storage_ok = bool(_READYZ_STORAGE_CACHE.get("ok"))
            cached_latency = _READYZ_STORAGE_CACHE.get("latency_ms")
            storage_latency_ms = int(cached_latency) if cached_latency is not None else None
            cached_error = _READYZ_STORAGE_CACHE.get("error")
            storage_error = str(cached_error) if cached_error else None
        if not storage_ok:
            checks["storage"] = "down"
            if storage_error:
                logging.getLogger("readiness").error("storage_readiness_failed")
            return _readyz_json({"status": "degraded", "checks": checks}, status_code=503)
        checks["storage"] = "ok"
        if storage_latency_ms is not None:
            checks["storage_latency_ms"] = str(storage_latency_ms)
        return _readyz_json({"status": "ok", "checks": checks})
    return _readyz_json({"status": "ok"})

@app.get("/readyz")
def readyz(db: Session = Depends(get_db)):
    return _readyz_response(db)

@app.get("/api/readyz")
def readyz_api(db: Session = Depends(get_db)):
    return _readyz_response(db)


# Routes principales
app.include_router(auth.router)
app.include_router(customers.router)
app.include_router(lookup.router)
app.include_router(users.router)
app.include_router(invoices.router)
app.include_router(quotes.router)
app.include_router(document_attachments.router)
app.include_router(public_quotes.router)
app.include_router(public_invoices.router)
app.include_router(public_customers.router)
app.include_router(client.router)
app.include_router(platforms.router, prefix="/api/platforms")
app.include_router(platforms.admin_router, prefix="/api/platforms")
app.include_router(platforms.onboarding_router, prefix="/api/platforms")
app.include_router(pdp_seqino.router)
app.include_router(directory.router)
app.include_router(inbox.router)
app.include_router(billing.router)
app.include_router(tokens.router)
app.include_router(company.router)
app.include_router(settings_router.router)
app.include_router(attachments.router)
app.include_router(webhooks.router)
app.include_router(seqino_webhooks.router)
app.include_router(email_webhooks.router)
app.include_router(support.router)
app.include_router(leads.router)
app.include_router(items.router)
app.include_router(collections.router)
app.include_router(search.router)
app.include_router(activity.router)
app.include_router(exports.router)
app.include_router(sandbox.router)
app.include_router(admin.router)
app.include_router(api_access.router)
app.include_router(audit.router)
app.include_router(einvoicing.router)
app.include_router(einvoicing_pdp.router)
app.include_router(ereporting.router)
app.include_router(ereporting.export_router)
app.include_router(jobs.router)
app.include_router(diagnostic.router)
app.include_router(compliance.router)
app.include_router(legal.router)
app.include_router(usage.router)
app.include_router(readiness.router)
app.include_router(b2b_einvoicing.router)
app.include_router(security.router)
app.include_router(features.router)
app.include_router(workspace.router)
app.include_router(cockpit.router)
app.include_router(attention.router)
app.include_router(recurring.router)
app.include_router(ops.router)
app.include_router(ops_alerts.router)
app.include_router(ops_comms.router)
app.include_router(ops_portfolio.router)
app.include_router(ops_campaigns.router)
app.include_router(ops_outbox.router)
app.include_router(ops_scheduler.router)
app.include_router(ops_supervision.router)
app.include_router(metrics_router.router)
