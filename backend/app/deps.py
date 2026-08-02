import json
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session
import jwt
from jwt.exceptions import ExpiredSignatureError, InvalidTokenError as JWTError
from .config import settings, auth_cookie_mode_enabled
from .db import get_db
from .models import User, Tenant, Membership, ApiKey, AuthSession
from .core.plans import Plan, require_plan_at_least
from .utils.request_context import set_request_actor
from .services import rate_limit
from .services.legal_acceptance import (
    accepted_rows_for_tenant,
    accepted_rows_for_user,
    resolve_required_docs,
    should_enforce_acceptance,
)
from .services.product_capabilities import ensure_product_feature, billing_enabled
import contextlib

bearer = HTTPBearer(auto_error=False)
logger = logging.getLogger("auth")
csrf_logger = logging.getLogger("security.csrf")
legal_logger = logging.getLogger("legal.acceptance")

API_SCOPE_READ_INVOICES = "read:invoices"
API_SCOPE_WRITE_INVOICES = "write:invoices"
API_SCOPE_READ_CUSTOMERS = "read:customers"
API_SCOPE_WRITE_CUSTOMERS = "write:customers"
API_SCOPE_READ_JOBS = "read:jobs"

API_KEY_ALLOWED_SCOPES = {
    API_SCOPE_READ_INVOICES,
    API_SCOPE_WRITE_INVOICES,
    API_SCOPE_READ_CUSTOMERS,
    API_SCOPE_WRITE_CUSTOMERS,
    API_SCOPE_READ_JOBS,
}

API_KEY_DEFAULT_SCOPES = (
    API_SCOPE_READ_INVOICES,
    API_SCOPE_READ_CUSTOMERS,
    API_SCOPE_READ_JOBS,
)

API_KEY_LEGACY_SCOPES = (
    API_SCOPE_READ_INVOICES,
    API_SCOPE_READ_CUSTOMERS,
    API_SCOPE_READ_JOBS,
)

MFA_SETUP_ALLOWED_PATHS = {
    "/api/auth/csrf",
    "/api/auth/logout",
    "/api/auth/mfa/status",
    "/api/auth/mfa/setup",
    "/api/auth/mfa/verify",
}
OPS_PREFLIGHT_ALLOWED_PATHS = {"/api/diagnostic/preflight"}
@dataclass
class AuthUser:
    id: str
    email: str
    tenant_id: str
    role: str
    is_admin: bool
    is_support: bool
    mfa_enabled: bool = False
    scopes: set[str] = field(default_factory=set)
    is_api_key: bool = False


def _normalize_api_key_scopes(raw: object) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        items = [item.strip() for item in raw.split(",")]
    elif isinstance(raw, (list, tuple, set)):
        items = [str(item).strip() for item in raw if item is not None]
    else:
        return []
    seen: set[str] = set()
    normalized: list[str] = []
    for item in items:
        if not item:
            continue
        scope = item.lower()
        if scope in seen:
            continue
        seen.add(scope)
        normalized.append(scope)
    return normalized


def validate_api_key_scopes(raw: object) -> list[str]:
    scopes = _normalize_api_key_scopes(raw)
    unknown = sorted(set(scopes) - API_KEY_ALLOWED_SCOPES)
    if unknown:
        raise HTTPException(400, f"Scopes invalides: {', '.join(unknown)}")
    return scopes


def resolve_api_key_scopes(raw: object, fallback: tuple[str, ...]) -> list[str]:
    scopes = _normalize_api_key_scopes(raw)
    if not scopes:
        scopes = list(fallback)
    return [scope for scope in scopes if scope in API_KEY_ALLOWED_SCOPES]


def _api_key_has_scope(scopes: set[str], required: str) -> bool:
    return required in scopes


def _require_api_key_scopes(user: AuthUser, required_scopes: set[str]) -> None:
    if not required_scopes:
        raise HTTPException(403, "Scopes requis pour une API key.")
    if not any(_api_key_has_scope(user.scopes, scope) for scope in required_scopes):
        raise HTTPException(403, "Accès refusé (scopes insuffisants).")


def _platform_admin_flag(user: object) -> bool:
    if not getattr(settings, "PLATFORM_ADMIN_ENABLED", True):
        return False
    return bool(getattr(user, "is_admin", False))


def platform_admin_requires_mfa(user: object) -> bool:
    """Return whether the account must enroll in MFA under platform policy.

    Tenant roles deliberately do not participate in this decision: MFA remains
    optional for every customer account, including tenant owners and admins.
    The legacy ``is_platform_admin`` flag is checked alongside ``is_admin`` so
    an account cannot bypass enrollment during flag migration/backfill.
    """
    return bool(
        getattr(settings, "MFA_ENFORCE_PLATFORM_ADMINS", False)
        and (
            bool(getattr(user, "is_admin", False))
            or bool(getattr(user, "is_platform_admin", False))
        )
    )


def _backfill_admin_flag(db: Session, user: User) -> None:
    if getattr(user, "is_admin", False):
        return
    if not getattr(user, "is_platform_admin", False):
        return
    user.is_admin = True
    db.add(user)
    with contextlib.suppress(Exception):
        db.commit()


def _user_is_active(user: User) -> bool:
    return (getattr(user, "status", None) or "active").strip().lower() == "active"


def _unauthorized(code: str, message: str, hint: str | None = None) -> HTTPException:
    detail = {"code": code, "message": message}
    if hint:
        detail["hint"] = hint
    return HTTPException(status_code=401, detail=detail)

SESSION_EXPIRED_CODES = {"token_invalid", "invalid_token", "expired_token", "token_missing", "tenant_missing"}
SESSION_EXPIRED_MESSAGE = "Session expirée."


def _cookie_hint(request: Request) -> str | None:
    if not auth_cookie_mode_enabled():
        return None
    if not getattr(settings, "STRICT_COOKIE_CONFIG", False):
        return None
    if request.cookies.get("access_token") or request.cookies.get("refresh_token") or request.cookies.get("auth_session"):
        return None
    return "Autorisez les cookies nécessaires, puis reconnectez-vous. Si le problème persiste, contactez le support."

def _cookie_missing_with_origin_hint(request: Request) -> str | None:
    if not auth_cookie_mode_enabled():
        return None
    origin = (request.headers.get("origin") or "").strip()
    referer = (request.headers.get("referer") or "").strip()
    if not origin and not referer:
        return None
    if request.cookies.get("access_token") or request.cookies.get("refresh_token") or request.cookies.get("auth_session"):
        return None
    return "Autorisez les cookies nécessaires, puis reconnectez-vous. Si le problème persiste, contactez le support."

def _log_auth_failure(request: Request, reason: str, used_cookie: bool) -> None:
    auth_header_present = bool((request.headers.get("authorization") or "").strip())
    token_source = "cookie" if used_cookie else ("header" if auth_header_present else "none")
    payload = {
        "event": "auth_unauthorized",
        "reason": reason,
        "path": request.url.path,
        "method": request.method,
        "token_source": token_source,
        "auth_header_present": auth_header_present,
        "access_cookie_present": bool(request.cookies.get("access_token")),
        "refresh_cookie_present": bool(request.cookies.get("refresh_token")),
        "csrf_cookie_present": bool(request.cookies.get("csrf_token")),
        "session_cookie_present": bool(request.cookies.get("auth_session")),
    }
    logger.warning(json.dumps(payload, separators=(",", ":")))

def _log_csrf_invalid(request: Request, source: str) -> None:
    payload = {
        "event": "csrf_rejected",
        "code": "csrf_invalid",
        "source": source,
        "path": request.url.path,
        "method": request.method,
        "csrf_header_present": bool((request.headers.get("X-CSRF-Token") or "").strip()),
        "csrf_cookie_present": bool(request.cookies.get("csrf_token")),
    }
    csrf_logger.warning(json.dumps(payload, separators=(",", ":")))

def _reject_auth(
    request: Request,
    reason: str,
    used_cookie: bool,
    code: str = "invalid_token",
    message: str = "Token invalide ou expiré",
) -> None:
    _log_auth_failure(request, reason, used_cookie)
    hint = _cookie_hint(request) if used_cookie else None
    if code in SESSION_EXPIRED_CODES:
        code = "session_expired"
        message = SESSION_EXPIRED_MESSAGE
    raise _unauthorized(code, message, hint=hint)

def _require_csrf(request: Request) -> None:
    csrf_header = request.headers.get("X-CSRF-Token") or ""
    csrf_cookie = request.cookies.get("csrf_token") or ""
    if not csrf_header or not csrf_cookie or csrf_header != csrf_cookie:
        _log_csrf_invalid(request, "deps")
        raise HTTPException(
            status_code=403,
            detail={
                "code": "csrf_failed",
                "message": "Votre session n’est plus valide. Actualisez la page puis réessayez.",
            },
        )


def _extract_token(request: Request, creds: HTTPAuthorizationCredentials | None) -> tuple[str | None, bool]:
    if creds is not None and (creds.scheme or "").lower() == "bearer":
        return creds.credentials, False
    cookie_token = request.cookies.get("access_token")
    if cookie_token:
        return cookie_token, True
    return None, False


def current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
) -> AuthUser:
    token, used_cookie = _extract_token(request, creds)
    if not token:
        _log_auth_failure(request, "missing_cookie", False)
        hint = _cookie_missing_with_origin_hint(request)
        if hint:
            raise _unauthorized("cookie_config_issue", "Cookies non envoyés.", hint=hint)
        raise _unauthorized("session_expired", SESSION_EXPIRED_MESSAGE)

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except ExpiredSignatureError:
        _reject_auth(request, "expired_token", used_cookie)
    except JWTError:
        _reject_auth(request, "invalid_token", used_cookie)

    if payload.get("type") != "access":
        _reject_auth(request, "invalid_token", used_cookie)
    token_purpose = payload.get("purpose")
    if token_purpose and token_purpose not in {"mfa_setup", "ops_preflight"}:
        _reject_auth(request, "invalid_token", used_cookie)
    if token_purpose == "mfa_setup" and request.url.path not in MFA_SETUP_ALLOWED_PATHS:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "mfa_setup_required",
                "message": "Activez l'authentification à deux facteurs pour continuer.",
            },
        )
    if token_purpose == "ops_preflight" and request.url.path not in OPS_PREFLIGHT_ALLOWED_PATHS:
        _reject_auth(request, "invalid_token", used_cookie)

    uid = payload.get("sub")
    u = db.get(User, uid)
    if not u:
        _reject_auth(request, "invalid_token", used_cookie)
    if token_purpose == "ops_preflight" and not (bool(u.is_admin) or bool(u.is_support)):
        _reject_auth(request, "invalid_token", used_cookie)
    if not _user_is_active(u):
        _reject_auth(
            request,
            "user_inactive",
            used_cookie,
            code="account_inactive",
            message="Compte désactivé ou non vérifié.",
        )
    _backfill_admin_flag(db, u)
    if payload.get("tv") != (u.token_version or 0):
        _reject_auth(request, "invalid_token", used_cookie)

    session_id = payload.get("sid")
    if session_id:
        session = db.get(AuthSession, session_id)
        if not session or session.user_id != u.id or session.revoked_at is not None:
            _reject_auth(
                request,
                "revoked_session",
                used_cookie,
                code="session_expired",
                message=SESSION_EXPIRED_MESSAGE,
            )

    tenant_id = payload.get("tenant") or u.tenant_id
    if not tenant_id:
        _reject_auth(request, "invalid_token", used_cookie, code="tenant_missing", message="Tenant manquant")
    tenant = db.get(Tenant, tenant_id)
    if not tenant or tenant.deleted_at is not None:
        _reject_auth(
            request,
            "tenant_deleted",
            used_cookie,
            code="account_inactive",
            message="Cet espace a été désactivé.",
        )
    membership = (
        db.query(Membership)
        .filter(Membership.user_id == u.id, Membership.tenant_id == tenant_id)
        .first()
    )
    if not membership:
        raise HTTPException(403, "Vous n’avez pas accès à cet espace.")
    if (
        platform_admin_requires_mfa(u)
        and not bool(getattr(u, "mfa_enabled", False))
        and token_purpose != "ops_preflight"
        and request.url.path not in MFA_SETUP_ALLOWED_PATHS
    ):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "mfa_setup_required",
                "message": "Authentification à deux facteurs obligatoire. Activez-la pour continuer.",
                "setup_allowed": True,
            },
        )
    if used_cookie and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        _require_csrf(request)
    # Contexte Sentry (si activé)
    with contextlib.suppress(Exception):
        import sentry_sdk
        user_ctx = {"id": u.id}
        sentry_sdk.set_user(user_ctx)
        sentry_sdk.set_tag("tenant_id", tenant_id or "unknown")
    request.state.tenant_id = tenant_id
    request.state.user_id = u.id
    request.state.auth_purpose = token_purpose
    set_request_actor(tenant_id=tenant_id, user_id=u.id)
    return AuthUser(
        id=u.id,
        email=u.email,
        tenant_id=tenant_id,
        role=membership.role,
        is_admin=_platform_admin_flag(u),
        is_support=bool(u.is_support),
        mfa_enabled=bool(getattr(u, "mfa_enabled", False)),
        scopes=set(),
        is_api_key=False,
    )


def _log_api_key_failure(request: Request, reason: str) -> None:
    payload = {
        "event": "auth_unauthorized",
        "reason": reason,
        "path": request.url.path,
        "method": request.method,
        "token_source": "api_key",
        "api_key_present": bool((request.headers.get("X-API-Key") or "").strip()),
    }
    logger.warning(json.dumps(payload, separators=(",", ":")))


def _reject_api_key(request: Request, reason: str) -> None:
    _log_api_key_failure(request, reason)
    raise _unauthorized("api_key_invalid", "API key invalide")


def _resolve_api_key_membership(db: Session, tenant_id: str) -> Membership | None:
    for role in ("owner", "admin", "accountant", "viewer"):
        membership = (
            db.query(Membership)
            .filter(Membership.tenant_id == tenant_id, Membership.role == role)
            .order_by(Membership.created_at.asc())
            .first()
        )
        if membership:
            return membership
    return None


def _api_key_tenant_allowed(db: Session, tenant_id: str) -> bool:
    tenant = db.get(Tenant, tenant_id)
    if not tenant or tenant.deleted_at is not None:
        return False
    try:
        require_plan_at_least(tenant, Plan.PRO)
    except HTTPException:
        return False
    status = (tenant.subscription_status or "").strip().lower()
    # API keys are an automation surface: unlike the interactive workspace,
    # they must never turn a free trial into an unattended integration path.
    if status == "trialing":
        return False
    if not billing_enabled():
        return True
    return status == "active"


def _enforce_api_key_rate_limit(api_key: ApiKey) -> None:
    limit = int(getattr(settings, "MAX_API_REQUESTS_PER_MINUTE", 300) or 0)
    if limit <= 0:
        return
    key = f"api-key:{api_key.id}:minute"
    try:
        limited = rate_limit.hit(key, limit=limit, window_seconds=60)
    except Exception as exc:
        logger.exception("api_key_rate_limit_unavailable", extra={"api_key_id": api_key.id})
        raise HTTPException(
            status_code=503,
            detail={
                "code": "rate_limit_unavailable",
                "message": "Protection de trafic indisponible. Réessayez dans quelques instants.",
            },
        ) from exc
    if limited:
        logger.warning("api_key_rate_limited", extra={"api_key_id": api_key.id, "tenant_id": api_key.tenant_id})
        raise HTTPException(
            status_code=429,
            detail={
                "code": "api_key_rate_limited",
                "message": "Trop de requêtes API. Réessayez dans quelques instants.",
            },
        )


def _api_key_auth(request: Request, db: Session) -> AuthUser | None:
    raw = request.headers.get("X-API-Key")
    if raw is None:
        return None
    token = raw.strip()
    if not token:
        _reject_api_key(request, "missing_api_key")
    token_hash = ApiKey.hash_token(token)
    api_key = (
        db.query(ApiKey)
        .filter(ApiKey.token_hash == token_hash, ApiKey.revoked_at.is_(None))
        .first()
    )
    if not api_key:
        _reject_api_key(request, "invalid_api_key")
    if not _api_key_tenant_allowed(db, api_key.tenant_id):
        _reject_api_key(request, "api_key_subscription_inactive")
    membership = _resolve_api_key_membership(db, api_key.tenant_id)
    if not membership:
        _reject_api_key(request, "missing_membership")
    assert membership is not None
    user = db.get(User, membership.user_id)
    if not user:
        _reject_api_key(request, "missing_user")
    assert user is not None
    if not _user_is_active(user):
        _reject_api_key(request, "user_inactive")
    ensure_tenant_legal_acceptance(api_key.tenant_id, db)
    _enforce_api_key_rate_limit(api_key)
    _backfill_admin_flag(db, user)
    api_key.last_used_at = _utcnow()
    db.add(api_key)
    with contextlib.suppress(Exception):
        db.flush()
    with contextlib.suppress(Exception):
        import sentry_sdk
        user_ctx = {"id": user.id}
        sentry_sdk.set_user(user_ctx)
        sentry_sdk.set_tag("tenant_id", api_key.tenant_id or "unknown")
    request.state.tenant_id = api_key.tenant_id
    request.state.user_id = user.id
    set_request_actor(tenant_id=api_key.tenant_id, user_id=user.id)
    scopes = set(resolve_api_key_scopes(api_key.scopes, API_KEY_LEGACY_SCOPES))
    return AuthUser(
        id=user.id,
        email=user.email,
        tenant_id=api_key.tenant_id,
        role="api_key",
        is_admin=False,
        is_support=False,
        mfa_enabled=False,
        scopes=scopes,
        is_api_key=True,
    )


def require_api_key_or_user(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
) -> AuthUser:
    if creds is not None or any(
        request.cookies.get(name) for name in ("access_token", "refresh_token", "auth_session")
    ):
        return current_user(request, creds, db)
    api_user = _api_key_auth(request, db)
    if api_user:
        return api_user
    return current_user(request, creds, db)


def is_platform_admin(user: AuthUser) -> bool:
    return bool(user.is_admin)


def require_platform_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    if not is_platform_admin(user):
        raise HTTPException(403, "Accès réservé à l'administrateur de la plateforme.")
    return user


def deny_client_portal(user: AuthUser) -> None:
    if (user.role or "").lower() == "client":
        raise HTTPException(403, "Accès interdit pour un compte client.")


def require_tenant_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    role = (user.role or "").lower()
    if role not in {"owner", "admin"} or not user.tenant_id:
        raise HTTPException(403, "Accès réservé à l'administrateur de l'espace.")
    return user


def require_accountant_or_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    role = (user.role or "").lower()
    if role not in {"owner","admin","accountant"} and not user.is_admin:
        raise HTTPException(403, "Accès réservé à l'équipe comptable.")
    return user


def require_viewer_or_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    role = (user.role or "").lower()
    if role in {"owner","admin","accountant","sales","viewer"} or user.is_admin:
        return user
    raise HTTPException(403, "Lecture réservée aux membres de l'équipe.")


def require_viewer_or_admin_or_api_key(required_scopes: set[str]):
    def _dep(user: AuthUser = Depends(require_api_key_or_user)) -> AuthUser:
        if user.is_api_key:
            _require_api_key_scopes(user, required_scopes)
            return user
        role = (user.role or "").lower()
        if role in {"owner", "admin", "accountant", "sales", "viewer"} or user.is_admin:
            return user
        raise HTTPException(403, "Lecture réservée aux membres de l'équipe.")
    return _dep


def require_accountant_or_admin_or_api_key(required_scopes: set[str]):
    def _dep(user: AuthUser = Depends(require_api_key_or_user)) -> AuthUser:
        if user.is_api_key:
            _require_api_key_scopes(user, required_scopes)
            return user
        role = (user.role or "").lower()
        if role not in {"owner", "admin", "accountant"} and not user.is_admin:
            raise HTTPException(403, "Accès réservé à l'équipe comptable.")
        return user
    return _dep

COMMERCIAL_ROLES = {"owner", "admin", "accountant", "sales"}
CUSTOMER_MANAGER_ROLES = {"owner", "admin", "sales"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def require_commercial_user(user: AuthUser = Depends(current_user)) -> AuthUser:
    """Role 'sales' (commercial) : peut créer/modifier clients, articles et devis, sans émettre de factures."""
    role = (user.role or "").lower()
    if role in COMMERCIAL_ROLES or user.is_admin:
        return user
    raise HTTPException(403, "Accès réservé à l'équipe commerciale.")


def require_commercial_or_api_key(required_scopes: set[str]):
    """Autorise l'API key si scopes ok, sinon autorise les rôles commerciaux."""
    def _dep(user: AuthUser = Depends(require_api_key_or_user)) -> AuthUser:
        if user.is_api_key:
            _require_api_key_scopes(user, required_scopes)
            return user
        role = (user.role or "").lower()
        if role in COMMERCIAL_ROLES or user.is_admin:
            return user
        raise HTTPException(403, "Accès réservé à l'équipe commerciale.")
    return _dep


def require_customer_manager_or_api_key(required_scopes: set[str]):
    """Autorise les mutations client aux admins/commerciaux, ou aux API keys scopées."""
    def _dep(user: AuthUser = Depends(require_api_key_or_user)) -> AuthUser:
        if user.is_api_key:
            _require_api_key_scopes(user, required_scopes)
            return user
        role = (user.role or "").lower()
        if role in CUSTOMER_MANAGER_ROLES or user.is_admin:
            return user
        raise HTTPException(403, "Modification client réservée aux administrateurs ou commerciaux.")
    return _dep



def _maybe_expire_trial(db: Session, tenant: Tenant) -> None:
    status = (tenant.subscription_status or "").strip().lower()
    if status != "trialing":
        return
    trial_end = getattr(tenant, "trial_end", None)
    if not trial_end:
        return
    if _utcnow() <= trial_end:
        return
    tenant.subscription_status = "inactive"
    db.add(tenant)
    db.commit()


def _ensure_active_subscription(tenant: Tenant, db: Session | None = None) -> None:
    if not settings.SUBSCRIPTION_REQUIRED:
        return
    if db is not None:
        _maybe_expire_trial(db, tenant)
    status = (tenant.subscription_status or "").strip().lower()
    if status not in {"active", "trialing"}:
        raise HTTPException(
            status_code=402,
            detail={
                "code": "subscription_inactive",
                "message": "Abonnement inactif : activez ou réglez votre abonnement pour enregistrer vos factures.",
                "action": "billing",
            },
        )


def ensure_active_subscription(tenant: Tenant, db: Session | None = None) -> None:
    _ensure_active_subscription(tenant, db)


def ensure_legal_acceptance(user: AuthUser, db: Session) -> None:
    if user.is_api_key:
        ensure_tenant_legal_acceptance(user.tenant_id, db)
        return
    required_docs = resolve_required_docs()
    if not required_docs:
        return
    rows = accepted_rows_for_user(
        db,
        tenant_id=user.tenant_id,
        user_id=user.id,
        slugs=[doc["slug"] for doc in required_docs],
    )
    accepted = {(row.doc_slug, row.doc_version) for row in rows}
    missing = [doc for doc in required_docs if (doc["slug"], doc["version"]) not in accepted]
    if not missing:
        return
    if should_enforce_acceptance():
        raise HTTPException(
            status_code=403,
            detail={
                "code": "legal_acceptance_required",
                "message": "Acceptation des documents legaux requise avant de continuer.",
                "required": [{"slug": doc["slug"], "version": doc["version"]} for doc in missing],
            },
        )
    legal_logger.warning(
        "legal_acceptance_missing",
        extra={
            "tenant_id": user.tenant_id,
            "user_id": user.id,
            "missing": [{"slug": doc["slug"], "version": doc["version"]} for doc in missing],
        },
    )


def ensure_tenant_legal_acceptance(tenant_id: str, db: Session) -> None:
    required_docs = resolve_required_docs()
    if not required_docs:
        return
    rows = accepted_rows_for_tenant(
        db,
        tenant_id=tenant_id,
        slugs=[doc["slug"] for doc in required_docs],
    )
    accepted = {(row.doc_slug, row.doc_version) for row in rows}
    missing = [doc for doc in required_docs if (doc["slug"], doc["version"]) not in accepted]
    if not missing:
        return
    if should_enforce_acceptance():
        raise HTTPException(
            status_code=403,
            detail={
                "code": "legal_acceptance_required",
                "message": "Acceptation des documents legaux requise avant de continuer.",
                "required": [{"slug": doc["slug"], "version": doc["version"]} for doc in missing],
            },
        )
    legal_logger.warning(
        "tenant_legal_acceptance_missing",
        extra={
            "tenant_id": tenant_id,
            "missing": [{"slug": doc["slug"], "version": doc["version"]} for doc in missing],
        },
    )


def require_active_subscription(
    user: AuthUser = Depends(require_accountant_or_admin),
    db: Session = Depends(get_db),
) -> AuthUser:
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _ensure_active_subscription(tenant, db)
    return user


def require_active_subscription_or_api_key(
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    db: Session = Depends(get_db),
) -> AuthUser:
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _ensure_active_subscription(tenant, db)
    return user


def require_subscription_active(
    user: AuthUser = Depends(current_user),
    db: Session = Depends(get_db),
) -> AuthUser:
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _ensure_active_subscription(tenant, db)
    return user


def _require_subscription_status(
    user: AuthUser,
    db: Session,
    allowed_statuses: set[str],
    message: str,
) -> AuthUser:
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _maybe_expire_trial(db, tenant)
    status = (tenant.subscription_status or "").strip().lower()
    # A free trial must remain isolated even if billing is temporarily disabled
    # in a maintenance/test configuration. Active-only dependencies protect
    # irreversible actions and provider/customer network I/O.
    if not settings.SUBSCRIPTION_REQUIRED and not (
        status == "trialing" and "trialing" not in allowed_statuses
    ):
        return user
    if status not in allowed_statuses:
        raise HTTPException(
            status_code=402,
            detail={
                "code": "payment_required",
                "message": message,
                "cta": "/app/billing",
            },
        )
    return user


def require_paid_subscription(
    user: AuthUser = Depends(current_user),
    db: Session = Depends(get_db),
) -> AuthUser:
    return _require_subscription_status(
        user,
        db,
        {"active"},
        "Abonnement actif requis pour émettre ou transmettre des factures.",
    )


def require_paid_subscription_or_api_key(
    user: AuthUser = Depends(require_api_key_or_user),
    db: Session = Depends(get_db),
) -> AuthUser:
    """Require a paid tenant while preserving explicitly scoped API access."""
    return _require_subscription_status(
        user,
        db,
        {"active"},
        "Abonnement actif requis pour émettre, envoyer ou partager des documents.",
    )


def require_paid_subscription_or_trial(
    user: AuthUser = Depends(require_api_key_or_user),
    db: Session = Depends(get_db),
) -> AuthUser:
    return _require_subscription_status(
        user,
        db,
        {"active", "trialing"},
        "Abonnement actif requis pour utiliser cette fonctionnalité.",
    )


def ensure_paid_subscription_or_trial(user: AuthUser, db: Session) -> AuthUser:
    return _require_subscription_status(
        user,
        db,
        {"active", "trialing"},
        "Abonnement actif requis pour utiliser cette fonctionnalité.",
    )


def require_plan(minimum: str):
    normalized = (minimum or "").strip().lower()
    try:
        minimum_plan = Plan(normalized)
    except ValueError as exc:
        raise RuntimeError(f"Plan minimum invalide: {minimum}") from exc

    def _dep(
        user: AuthUser = Depends(current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        tenant = db.get(Tenant, user.tenant_id)
        if not tenant:
            raise HTTPException(404, "Entreprise introuvable")
        _ensure_active_subscription(tenant, db)
        require_plan_at_least(tenant, minimum_plan)
        return user

    return _dep


def require_plan_only(minimum: str):
    normalized = (minimum or "").strip().lower()
    try:
        minimum_plan = Plan(normalized)
    except ValueError as exc:
        raise RuntimeError(f"Plan minimum invalide: {minimum}") from exc

    def _dep(
        user: AuthUser = Depends(current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        tenant = db.get(Tenant, user.tenant_id)
        if not tenant:
            raise HTTPException(404, "Entreprise introuvable")
        require_plan_at_least(tenant, minimum_plan)
        return user

    return _dep


def _legacy_einvoicing_api_enabled() -> bool:
    flag = settings.ENABLE_LEGACY_EINVOICING_API
    if flag is None:
        env = (settings.APP_ENV or "").strip().lower()
        return env not in {"prod", "production", "staging"}
    return bool(flag)


def require_legacy_einvoicing_api() -> None:
    if _legacy_einvoicing_api_enabled():
        return
    raise HTTPException(
        status_code=404,
        detail={
            "code": "legacy_api_disabled",
            "message": "API e-invoicing legacy désactivée.",
        },
    )


def require_pro_plan(
    user: AuthUser = Depends(require_tenant_admin),
    db: Session = Depends(get_db),
) -> AuthUser:
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _ensure_active_subscription(tenant, db)
    require_plan_at_least(tenant, Plan.PRO)
    return user


def require_product_feature(feature: str):
    def _dep(
        user: AuthUser = Depends(current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        tenant = db.get(Tenant, user.tenant_id)
        if not tenant:
            raise HTTPException(404, "Entreprise introuvable")
        _require_subscription_status(
            user,
            db,
            {"active", "trialing"},
            "Abonnement actif requis pour utiliser cette fonctionnalité.",
        )
        ensure_product_feature(tenant, feature)
        return user

    return _dep


def require_product_capability(feature: str):
    """Require a product capability with one structured 403 contract.

    Product surfaces that must distinguish an upgrade from a subscription
    reactivation use this dependency instead of the legacy 402 subscription
    pre-check. ``ensure_product_feature`` already accounts for both the plan
    and the current subscription status when billing is enabled.
    """

    def _dep(
        user: AuthUser = Depends(current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        tenant = db.get(Tenant, user.tenant_id)
        if not tenant:
            raise HTTPException(404, "Entreprise introuvable")
        ensure_product_feature(tenant, feature)
        return user

    return _dep


def require_support(user: AuthUser = Depends(current_user)) -> AuthUser:
    if not user.is_support:
        raise HTTPException(403, "Support requis")
    return user


def require_internal_user(user: AuthUser = Depends(current_user)) -> AuthUser:
    if user.is_admin or user.is_support:
        return user
    raise HTTPException(
        status_code=403,
        detail={"code": "forbidden", "message": "Accès réservé au support."},
    )
