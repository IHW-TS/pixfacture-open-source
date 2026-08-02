import json
import logging
import hashlib
import secrets
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, TypedDict
from uuid import uuid4

import pyotp
from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from google.auth.transport import requests
from google.oauth2 import id_token
import jwt
from jwt.exceptions import InvalidTokenError as JWTError
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import metrics
from .config import settings, _is_secure_cookie_env, auth_bearer_mode_enabled, auth_cookie_mode_enabled
from .db import get_db
from .deps import current_user, AuthUser, platform_admin_requires_mfa, _cookie_hint
from .jobs.email_jobs import enqueue_password_reset_email, enqueue_verification_email
from .models import (
    Tenant,
    TenantSettings,
    User,
    Numbering,
    Membership,
    AuthSession,
    LegalAcceptance,
    _default_tenant_features,
)
from .schemas import (
    RegisterPayload,
    LoginPayload,
    TokenOut,
    TokenRefreshRequest,
    PasswordResetRequest,
    PasswordResetConfirm,
    PasswordChangePayload,
    GoogleLoginPayload,
    SwitchTenantPayload,
)
from .services import rate_limit
from .services.action_logs import log_action, safe_log_action
from .services.compliance_status import build_capabilities as build_compliance_capabilities
from .services.connected_mode import build_tenant_product_capabilities
from .services.demo_seed import prepare_self_service_demo_tenant, seed_tenant_demo_data
from .services.demo_invitations import (
    DemoInvitationError,
    consume_demo_invitation,
    inspect_demo_invitation,
)
from .services.email import assert_smtp_ready_or_raise
from .services.legal_acceptance import (
    build_acceptance_snapshot,
    public_signup_legal_readiness,
    required_docs_for_ui,
)
from .utils.crypto import encrypt_payload, decrypt_payload
from .utils.passwords import pwd
from .utils.pii import mask_email, hash_email

logger = logging.getLogger(__name__)
csrf_logger = logging.getLogger("security.csrf")

router = APIRouter(prefix="/api/auth", tags=["auth"])
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_ATTEMPTS = 10
REGISTER_WINDOW_SECONDS = 15 * 60
REGISTER_MAX_ATTEMPTS = 10
REGISTER_DAILY_WINDOW_SECONDS = 24 * 60 * 60
REGISTER_DAILY_MAX_PER_IP = 5
REGISTER_DAILY_GLOBAL_MAX = 100
VERIFY_RESEND_WINDOW_SECONDS = 15 * 60
VERIFY_RESEND_MAX_ATTEMPTS = 5
SLUG_MAX_ATTEMPTS = 50
PASSWORD_RESET_WINDOW_SECONDS = 15 * 60
PASSWORD_RESET_MAX_ATTEMPTS = 5
ACCESS_COOKIE = "access_token"
REFRESH_COOKIE = "refresh_token"
CSRF_COOKIE = "csrf_token"
SESSION_COOKIE = "auth_session"
SESSION_COOKIE_VALUE = "1"
TRIAL_DAYS = 7
EMAIL_VERIFICATION_WINDOW_MINUTES = 60 * 24
GENERIC_EMAIL_NOTICE = "Si un compte existe, vous recevrez un email pour continuer."
MFA_SETUP_TOKEN_MINUTES = 15


class VerificationResendPayload(BaseModel):
    email: str


class DemoInvitationInspectPayload(BaseModel):
    token: str = Field(min_length=1, max_length=4096)


class MfaCodePayload(BaseModel):
    code: str


class SessionRevokePayload(BaseModel):
    sid: str | None = None
    all: bool | None = None


class CookieParams(TypedDict):
    httponly: bool
    secure: bool
    samesite: Literal["lax", "none", "strict"]
    max_age: int
    path: str
    domain: str | None


class VerifiedBillingIntent(TypedDict):
    plan: Literal["starter", "pro"]
    period: Literal["monthly", "yearly"]
    checkout_requested: bool
    destination: Literal["billing", "onboarding"]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _required_str(value: str | None, label: str) -> str:
    if not value:
        raise RuntimeError(f"Missing required value: {label}")
    return value


def _slugify(value: str) -> str:
    raw = (value or "").strip().lower()
    normalized = unicodedata.normalize("NFKD", raw)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-")
    return slug or "entreprise"


def _is_tenant_name_unique_violation(err: IntegrityError) -> bool:
    message = str(getattr(err, "orig", err)).lower()
    return (
        "tenants_name_key" in message
        or "tenants.name" in message
        or "unique constraint failed: tenants.name" in message
    )


def _is_user_email_unique_violation(err: IntegrityError) -> bool:
    message = str(getattr(err, "orig", err)).lower()
    return (
        "users_email_key" in message or "users.email" in message or "unique constraint failed: users.email" in message
    )


def _log_email_event(event: str, email: str, request: Request | None = None) -> None:
    if not email:
        return
    payload = {"event": event, "email_hash": hash_email(email)}
    if request is not None:
        payload["path"] = request.url.path
        payload["method"] = request.method
    logger.info(json.dumps(payload, separators=(",", ":"), ensure_ascii=True))


def _request_ip(request: Request) -> str | None:
    ip = request.client.host if request.client else None
    if not ip:
        forwarded_for = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        ip = forwarded_for or None
    return ip


def _request_user_agent(request: Request) -> str | None:
    value = (request.headers.get("user-agent") or "").strip()
    return value or None


def _accepted_legal_lookup(docs: list[dict[str, Any]] | None) -> set[tuple[str, str]]:
    accepted: set[tuple[str, str]] = set()
    for doc in docs or []:
        if not isinstance(doc, dict):
            continue
        slug = str(doc.get("slug") or "").strip().lower()
        version = str(doc.get("version") or "").strip()
        if slug and version:
            accepted.add((slug, version))
    return accepted


def _ensure_signup_legal_acceptance(
    accepted_docs: list[dict[str, Any]] | None,
    required_docs: list[dict[str, Any]],
) -> None:
    if not required_docs:
        return
    accepted = _accepted_legal_lookup(accepted_docs)
    missing = [
        doc
        for doc in required_docs
        if (str(doc.get("slug") or "").strip().lower(), str(doc.get("version") or "").strip()) not in accepted
    ]
    if not missing:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "legal_acceptance_required",
            "message": "Acceptez les documents légaux pour créer votre espace.",
            "required": required_docs,
        },
    )


def _ensure_professional_signup_confirmation(confirmed: bool) -> None:
    env = (settings.APP_ENV or "").strip().lower()
    if env not in {"prod", "production", "staging"} or confirmed:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "professional_use_confirmation_required",
            "message": "Confirmez que ce compte est créé pour une activité professionnelle.",
        },
    )


def _ensure_public_signup_legal_readiness() -> None:
    ready, message = public_signup_legal_readiness()
    if ready:
        return
    raise HTTPException(
        status_code=503,
        detail={
            "code": "signup_legal_update_in_progress",
            "message": message
            or "Les inscriptions sont temporairement indisponibles. Réessayez prochainement.",
        },
    )


def _add_signup_legal_acceptances(
    db: Session,
    *,
    tenant_id: str,
    user_id: str,
    accepted_role: str,
    required_docs: list[dict[str, Any]],
    request: Request,
) -> None:
    if not required_docs:
        return
    accepted_at = _utcnow()
    ip = _request_ip(request)
    user_agent = _request_user_agent(request)
    for doc in required_docs:
        db.add(
            LegalAcceptance(
                tenant_id=tenant_id,
                user_id=user_id,
                doc_slug=str(doc.get("slug") or "").strip().lower(),
                doc_version=str(doc.get("version") or "").strip(),
                **build_acceptance_snapshot(
                    slug=str(doc.get("slug") or "").strip().lower(),
                    accepted_role=accepted_role,
                ),
                accepted_at=accepted_at,
                ip=ip,
                user_agent=user_agent,
            )
        )


def _trial_end() -> datetime:
    return _utcnow() + timedelta(days=TRIAL_DAYS)


def _create_tenant_with_slug(db: Session, name: str, plan: str | None = None) -> Tenant:
    base = _slugify(name)
    slug = base
    suffix = 2
    for _ in range(SLUG_MAX_ATTEMPTS):
        if db.query(Tenant.id).filter(Tenant.tenant_slug == slug).first():
            slug = f"{base}-{suffix}"
            suffix += 1
            continue
        t = Tenant(
            name=name,
            tenant_slug=slug,
            subscription_status="trialing",
            trial_end=_trial_end(),
            plan=plan,
        )
        db.add(t)
        try:
            db.flush()
            return t
        except IntegrityError as exc:
            db.rollback()
            if _is_tenant_name_unique_violation(exc):
                raise HTTPException(status_code=409, detail={"code": "tenant_name_taken", "message": "Nom déjà pris."})
            slug = f"{base}-{suffix}"
            suffix += 1
    raise HTTPException(status_code=409, detail={"code": "tenant_name_taken", "message": "Nom déjà pris."})


def _billing_request_features(
    *,
    requested_plan: str | None,
    active_plan: str | None,
    requested_period: str | None,
    checkout_requested: bool,
) -> dict[str, Any]:
    requested = requested_plan if requested_plan in {"starter", "pro"} else active_plan
    active = active_plan if active_plan in {"starter", "pro"} else "starter"
    period = requested_period if requested_period in {"monthly", "yearly"} else None
    return {
        "requested_plan": requested,
        "active_plan": active,
        "requested_period": period,
        "checkout_requested": bool(checkout_requested),
        "requires_checkout": bool(requested == "pro" and active != "pro"),
    }


def _register_meta_payload(billing_request: dict[str, Any]) -> dict[str, Any]:
    return {
        "requested_plan": billing_request.get("requested_plan"),
        "actual_plan": billing_request.get("active_plan"),
        "requested_period": billing_request.get("requested_period"),
        "checkout_requested": bool(billing_request.get("checkout_requested")),
        "checkout_required": bool(billing_request.get("requires_checkout")),
    }


def _verified_billing_intent(db: Session, user: User) -> VerifiedBillingIntent | None:
    tenant_settings = db.get(TenantSettings, user.tenant_id)
    features = tenant_settings.features if tenant_settings and isinstance(tenant_settings.features, dict) else {}
    raw_intent = features.get("billing_request")
    if not isinstance(raw_intent, dict):
        return None
    plan = raw_intent.get("requested_plan")
    period = raw_intent.get("requested_period")
    if plan not in {"starter", "pro"} or period not in {"monthly", "yearly"}:
        return None
    checkout_requested = raw_intent.get("checkout_requested") is True
    return {
        "plan": plan,
        "period": period,
        "checkout_requested": checkout_requested,
        "destination": "billing" if checkout_requested else "onboarding",
    }


def _auth_rate_limit_hit(scope: str, key: str, limit: int, window_seconds: int) -> None:
    if not rate_limit.hit(key, limit, window_seconds):
        return
    _raise_auth_rate_limited(scope, limit, window_seconds)


def _auth_rate_limit_blocked(scope: str, key: str, limit: int, window_seconds: int) -> None:
    if not rate_limit.limited(key, limit, window_seconds):
        return
    _raise_auth_rate_limited(scope, limit, window_seconds)


def _raise_auth_rate_limited(scope: str, limit: int, window_seconds: int) -> None:
    logger.warning(
        "%s_rate_limited",
        scope,
        extra={
            "rate_limited": True,
            "scope": scope,
            "limit": limit,
            "window_seconds": window_seconds,
        },
    )
    retry_after_seconds = max(int(window_seconds), 1)
    retry_after_minutes = max((retry_after_seconds + 59) // 60, 1)
    raise HTTPException(
        status_code=429,
        detail={
            "code": f"{scope}_rate_limited",
            "message": (
                "Trop de tentatives. "
                f"Réessayez dans {retry_after_minutes} minute{'s' if retry_after_minutes > 1 else ''}."
            ),
        },
        headers={"Retry-After": str(retry_after_seconds)},
    )


def _email_rate_key(scope: str, email: str | None) -> str | None:
    email_hash = hash_email(email)
    if not email_hash:
        return None
    return f"{scope}:email:{email_hash}"


def _throttle_login(request: Request, email: str | None = None) -> None:
    _record_login_failure(request, email)


def _login_rate_keys(request: Request, email: str | None = None) -> list[str]:
    ip = request.client.host if request.client else "unknown"
    keys = [f"login:ip:{ip}"]
    email_key = _email_rate_key("login", email)
    if email_key:
        keys.append(email_key)
    return keys


def _check_login_rate_limits(request: Request, email: str | None = None) -> None:
    for key in _login_rate_keys(request, email):
        _auth_rate_limit_blocked("login", key, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS)


def _record_login_failure(request: Request, email: str | None = None) -> None:
    for key in _login_rate_keys(request, email):
        _auth_rate_limit_hit("login", key, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS)


def _reset_login_failures(request: Request, email: str | None = None) -> None:
    for key in _login_rate_keys(request, email):
        rate_limit.reset(key)


def _throttle_register(request: Request, email: str | None = None) -> None:
    ip = request.client.host if request.client else "unknown"
    _auth_rate_limit_hit("register", f"register:ip:{ip}", REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_SECONDS)
    email_key = _email_rate_key("register", email)
    if email_key:
        _auth_rate_limit_hit("register", email_key, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_SECONDS)
    daily_ip_limit = max(int(getattr(settings, "REGISTER_DAILY_MAX_PER_IP", 0) or 0), 0)
    daily_global_limit = max(int(getattr(settings, "REGISTER_DAILY_GLOBAL_MAX", 0) or 0), 0)
    daily_window = max(
        int(getattr(settings, "REGISTER_DAILY_WINDOW_SECONDS", REGISTER_DAILY_WINDOW_SECONDS) or 0),
        REGISTER_WINDOW_SECONDS,
    )
    if daily_ip_limit:
        _auth_rate_limit_hit(
            "register_daily",
            f"register:daily:ip:{ip}",
            daily_ip_limit,
            daily_window,
        )
    if daily_global_limit:
        _auth_rate_limit_hit(
            "register_daily_global",
            "register:daily:global",
            daily_global_limit,
            daily_window,
        )


def _throttle_password_reset(request: Request, email: str | None = None) -> None:
    ip = request.client.host if request.client else "unknown"
    _auth_rate_limit_hit(
        "password_reset",
        f"password-reset:ip:{ip}",
        PASSWORD_RESET_MAX_ATTEMPTS,
        PASSWORD_RESET_WINDOW_SECONDS,
    )
    email_key = _email_rate_key("password-reset", email)
    if email_key:
        _auth_rate_limit_hit(
            "password_reset",
            email_key,
            PASSWORD_RESET_MAX_ATTEMPTS,
            PASSWORD_RESET_WINDOW_SECONDS,
        )


def _throttle_verify_resend(request: Request, email: str | None = None) -> None:
    ip = request.client.host if request.client else "unknown"
    keys = [f"verify-resend:ip:{ip}"]
    email_key = _email_rate_key("verify-resend", email)
    if email_key:
        keys.append(email_key)
    for key in keys:
        if rate_limit.hit(key, VERIFY_RESEND_MAX_ATTEMPTS, VERIFY_RESEND_WINDOW_SECONDS):
            logger.warning(
                "verify_resend_rate_limited",
                extra={
                    "rate_limited": True,
                    "scope": "verify_resend",
                    "limit": VERIFY_RESEND_MAX_ATTEMPTS,
                    "window_seconds": VERIFY_RESEND_WINDOW_SECONDS,
                },
            )
            raise HTTPException(status_code=429, detail="Trop de tentatives, merci de patienter avant de réessayer.")


def _hash_jti(jti: str) -> str:
    return hashlib.sha256(jti.encode("utf-8")).hexdigest()


def _token(
    sub: str,
    tenant_id: str,
    role: str,
    minutes: int,
    token_type: str = "access",
    token_version: int = 0,
    extra_claims: dict | None = None,
) -> str:
    payload = {
        "sub": sub,
        "tenant": tenant_id,
        "role": role,
        "type": token_type,
        "tv": token_version,
        "exp": _utcnow() + timedelta(minutes=minutes),
    }
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(
        payload,
        settings.SECRET_KEY,
        algorithm="HS256",
    )


def _verification_link(token: str) -> str:
    frontend_base = (settings.FRONTEND_BASE_URL or "").strip()
    if frontend_base:
        return f"{frontend_base.rstrip('/')}/app/verify-email?token={token}"
    public_base = (settings.PUBLIC_BASE_URL or "").strip() or "https://example.com"
    return f"{public_base.rstrip('/')}/api/auth/verify?token={token}&redirect=1"


def _login_redirect_url(verified: bool) -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
    if verified:
        path = "/app/login?verified=1"
    else:
        path = "/app/login?verified=0&reason=invalid_or_expired"
    return f"{base}{path}" if base else path


def _send_verification_email(user: User, tenant: Tenant) -> bool:
    token = _token(
        _required_str(user.id, "user.id"),
        _required_str(tenant.id, "tenant.id"),
        _required_str(user.role, "user.role"),
        EMAIL_VERIFICATION_WINDOW_MINUTES,
        "verify",
        user.token_version or 0,
    )
    verify_url = _verification_link(token)
    try:
        smtp_ready = assert_smtp_ready_or_raise("email_verification")
    except HTTPException:
        logger.warning("SMTP not configured -> verification email not sent.")
        return False
    if not smtp_ready:
        logger.warning("SMTP not configured -> verification email not sent.")
        return False
    try:
        event = enqueue_verification_email(
            tenant_id=_required_str(tenant.id, "tenant.id"),
            user_id=_required_str(user.id, "user.id"),
            to=_required_str(user.email, "user.email"),
            verify_url=verify_url,
            company_name=_required_str(tenant.name, "tenant.name"),
        )
        return event.status != "failed"
    except Exception:
        logger.exception("Verification email enqueue failed email=%s", mask_email(user.email))
        return False


def _normalize_mfa_code(value: str | None) -> str:
    return (value or "").replace(" ", "").strip()


def _encode_mfa_secret(secret: str) -> bytes:
    return encrypt_payload({"secret": secret})


def _decode_mfa_secret(encrypted: bytes | None) -> str | None:
    if not encrypted:
        return None
    payload = decrypt_payload(encrypted)
    secret = payload.get("secret")
    if not secret:
        return None
    return str(secret)


def _verify_mfa_code(user: User, code: str) -> bool:
    secret = _decode_mfa_secret(user.mfa_secret)
    if not secret:
        return False
    try:
        totp = pyotp.TOTP(secret)
        return bool(totp.verify(code, valid_window=1))
    except Exception:
        return False


def _issue_tokens(
    user: User,
    tenant_id: str,
    role: str,
    *,
    session_id: str,
    refresh_jti: str,
) -> TokenOut:
    access_minutes = settings.ACCESS_TOKEN_EXPIRE_MINUTES or 60
    refresh_minutes = (settings.REFRESH_TOKEN_EXPIRE_DAYS or 7) * 24 * 60
    user_id = _required_str(user.id, "user.id")
    return TokenOut(
        access_token=_token(
            user_id,
            tenant_id,
            role,
            access_minutes,
            "access",
            user.token_version or 0,
            extra_claims={"sid": session_id},
        ),
        refresh_token=_token(
            user_id,
            tenant_id,
            role,
            refresh_minutes,
            "refresh",
            user.token_version or 0,
            extra_claims={"sid": session_id, "jti": refresh_jti},
        ),
    )


def _revoke_session_from_claims(db: Session, payload: dict | None) -> tuple[str | None, str | None, bool]:
    if not payload:
        return None, None, False
    user_id = payload.get("sub")
    tenant_id = payload.get("tenant")
    sid = payload.get("sid")
    if not user_id or not sid:
        return user_id, tenant_id, False
    session = db.query(AuthSession).filter(AuthSession.id == sid, AuthSession.user_id == user_id).first()
    if not session:
        return user_id, tenant_id, False
    if session.revoked_at is None:
        session.revoked_at = _utcnow()
        db.add(session)
        db.commit()
    return user_id, session.tenant_id or tenant_id, True


def _create_auth_session(
    db: Session,
    user: User,
    tenant_id: str,
    request: Request | None = None,
) -> tuple[AuthSession, str]:
    now = _utcnow()
    jti = str(uuid4())
    user_agent = request.headers.get("user-agent") if request else None
    ip = request.client.host if request and request.client else None
    session = AuthSession(
        user_id=user.id,
        tenant_id=tenant_id,
        refresh_jti_hash=_hash_jti(jti),
        created_at=now,
        last_used_at=now,
        user_agent=user_agent,
        ip=ip,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session, jti


def _ensure_membership(db: Session, user: User, tenant_id: str | None = None) -> Membership:
    def _ensure_tenant_available(candidate_tenant_id: str) -> None:
        tenant = db.get(Tenant, candidate_tenant_id)
        if not tenant or tenant.deleted_at is not None:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "account_inactive",
                    "message": "Cet espace a été désactivé.",
                },
            )

    if tenant_id:
        _ensure_tenant_available(tenant_id)
        membership = (
            db.query(Membership).filter(Membership.user_id == user.id, Membership.tenant_id == tenant_id).first()
        )
        if membership:
            return membership
        raise HTTPException(403, "Vous n’avez pas accès à cet espace.")
    if user.tenant_id:
        _ensure_tenant_available(user.tenant_id)
        membership = (
            db.query(Membership).filter(Membership.user_id == user.id, Membership.tenant_id == user.tenant_id).first()
        )
        if not membership:
            membership = Membership(
                user_id=user.id,
                tenant_id=user.tenant_id,
                role=user.role or "owner",
            )
            db.add(membership)
            db.commit()
            db.refresh(membership)
        return membership
    membership = (
        db.query(Membership).filter(Membership.user_id == user.id).order_by(Membership.created_at.asc()).first()
    )
    if not membership:
        raise HTTPException(403, "Vous n’avez accès à aucun espace.")
    _ensure_tenant_available(_required_str(membership.tenant_id, "membership.tenant_id"))
    return membership


def _cookie_params(
    max_age: int,
    http_only: bool,
    *,
    samesite: str | None = None,
    path: str | None = None,
) -> CookieParams:
    if settings.COOKIE_SECURE is not None:
        secure = bool(settings.COOKIE_SECURE)
    else:
        secure = _is_secure_cookie_env()
    raw_samesite = (samesite or settings.COOKIE_SAMESITE or "lax").strip().lower()
    if raw_samesite == "none":
        samesite_value: Literal["lax", "none", "strict"] = "none"
    elif raw_samesite == "strict":
        samesite_value = "strict"
    else:
        samesite_value = "lax"
    domain = (settings.COOKIE_DOMAIN or "").strip() or None
    return {
        "httponly": http_only,
        "secure": secure,
        "samesite": samesite_value,
        "max_age": max_age,
        "path": path or "/",
        "domain": domain,
    }


def _delete_cookie(
    response: Response,
    key: str,
    http_only: bool,
    *,
    samesite: str | None = None,
    path: str | None = None,
) -> None:
    params = _cookie_params(0, http_only, samesite=samesite, path=path)
    response.delete_cookie(
        key,
        path=params["path"],
        secure=params["secure"],
        httponly=params["httponly"],
        samesite=params["samesite"],
        domain=params["domain"],
    )


def _set_auth_cookies(response: Response, tokens: TokenOut) -> str:
    access_max_age = int((settings.ACCESS_TOKEN_EXPIRE_MINUTES or 60) * 60)
    refresh_max_age = int((settings.REFRESH_TOKEN_EXPIRE_DAYS or 7) * 24 * 60 * 60)
    response.set_cookie(
        ACCESS_COOKIE,
        tokens.access_token,
        **_cookie_params(access_max_age, True, path="/"),
    )
    if tokens.refresh_token:
        response.set_cookie(
            REFRESH_COOKIE,
            tokens.refresh_token,
            **_cookie_params(refresh_max_age, True, path="/"),
        )
    csrf_token = secrets.token_urlsafe(32)
    response.set_cookie(CSRF_COOKIE, csrf_token, **_cookie_params(refresh_max_age, False))
    response.set_cookie(SESSION_COOKIE, SESSION_COOKIE_VALUE, **_cookie_params(refresh_max_age, False))
    return csrf_token


def _set_mfa_setup_cookies(response: Response, user: User, tenant_id: str, role: str) -> str:
    _clear_auth_cookies(response)
    csrf_token = secrets.token_urlsafe(32)
    access_token = _token(
        _required_str(user.id, "user.id"),
        tenant_id,
        role,
        MFA_SETUP_TOKEN_MINUTES,
        "access",
        user.token_version or 0,
        extra_claims={"purpose": "mfa_setup"},
    )
    max_age = MFA_SETUP_TOKEN_MINUTES * 60
    response.set_cookie(ACCESS_COOKIE, access_token, **_cookie_params(max_age, True, path="/"))
    response.set_cookie(CSRF_COOKIE, csrf_token, **_cookie_params(max_age, False))
    response.set_cookie(SESSION_COOKIE, SESSION_COOKIE_VALUE, **_cookie_params(max_age, False))
    return csrf_token


def _mfa_setup_required_response(user: User, tenant_id: str, role: str) -> JSONResponse:
    payload = {
        "detail": {
            "code": "mfa_setup_required",
            "message": "Authentification à deux facteurs obligatoire. Activez-la pour continuer.",
            "setup_allowed": True,
            "expires_in": MFA_SETUP_TOKEN_MINUTES * 60,
        }
    }
    response = JSONResponse(status_code=403, content=payload)
    if auth_bearer_mode_enabled():
        response.headers["X-MFA-Setup-Token"] = _token(
            _required_str(user.id, "user.id"),
            tenant_id,
            role,
            MFA_SETUP_TOKEN_MINUTES,
            "access",
            user.token_version or 0,
            extra_claims={"purpose": "mfa_setup"},
        )
        return response
    _set_mfa_setup_cookies(response, user, tenant_id, role)
    return response


def _clear_auth_cookies(response: Response) -> None:
    _delete_cookie(response, ACCESS_COOKIE, True, path="/")
    _delete_cookie(response, REFRESH_COOKIE, True, path="/")
    _delete_cookie(response, CSRF_COOKIE, False)
    _delete_cookie(response, SESSION_COOKIE, False)


def _require_csrf(request: Request) -> None:
    csrf_header = request.headers.get("X-CSRF-Token") or ""
    csrf_cookie = request.cookies.get(CSRF_COOKIE) or ""
    if not csrf_header or not csrf_cookie or csrf_header != csrf_cookie:
        payload = {
            "event": "csrf_rejected",
            "code": "csrf_invalid",
            "source": "auth",
            "path": request.url.path,
            "method": request.method,
            "csrf_header_present": bool(csrf_header.strip()),
            "csrf_cookie_present": bool(csrf_cookie),
        }
        csrf_logger.warning(json.dumps(payload, separators=(",", ":")))
        raise HTTPException(
            status_code=403,
            detail={
                "code": "csrf_failed",
                "message": "Votre session n’est plus valide. Actualisez la page puis réessayez.",
            },
        )


def _auth_response(
    user: User,
    tenant_id: str,
    role: str,
    response: Response,
    db: Session,
    request: Request,
) -> dict | TokenOut:
    session, refresh_jti = _create_auth_session(db, user, tenant_id, request)
    tokens = _issue_tokens(
        user,
        tenant_id,
        role,
        session_id=_required_str(session.id, "session.id"),
        refresh_jti=refresh_jti,
    )
    if auth_bearer_mode_enabled():
        return tokens
    _set_auth_cookies(response, tokens)
    return {"ok": True}


def _pending_demo_request(db: Session, tenant_id: str) -> tuple[TenantSettings, str] | None:
    settings_row = db.get(TenantSettings, tenant_id)
    if not settings_row:
        return None
    features = dict(settings_row.features or {})
    request = features.get("demo_request")
    if not isinstance(request, dict) or request.get("status") != "pending":
        return None
    preset = str(request.get("preset") or "services").strip().lower() or "services"
    return settings_row, preset


def _seed_pending_verified_demo(db: Session, user: User, tenant: Tenant) -> bool:
    """Seed a requested demo only after the account is allowed to authenticate.

    The request lives in tenant settings so an unverified signup remains cheap and
    a transient seed failure can be retried safely by reopening the verification
    link. ``seed_tenant_demo_data`` is idempotent for an already seeded tenant.
    """

    pending = _pending_demo_request(db, _required_str(tenant.id, "tenant.id"))
    if not pending or _normalized_user_status(user) != "active":
        return False
    settings_row, preset = pending
    try:
        prepare_self_service_demo_tenant(db, tenant=tenant, trial_end=tenant.trial_end)
        result = seed_tenant_demo_data(
            db,
            tenant=tenant,
            user=user,
            force=False,
            generate_artifacts=False,
            preset=preset,
        )
        if not result.ok:
            return False
        features = dict(settings_row.features or {})
        features["demo_request"] = {"status": "seeded", "preset": preset}
        settings_row.features = features
        db.add(settings_row)
        db.commit()
        if result.warnings:
            logger.warning(
                "register_demo_seed_warnings",
                extra={
                    "tenant_id": tenant.id,
                    "user_id": user.id,
                    "warnings_count": len(result.warnings),
                },
            )
        return True
    except Exception:
        db.rollback()
        logger.exception(
            "register_demo_seed_failed",
            extra={"tenant_id": tenant.id, "user_id": user.id},
        )
        return False


def _raise_demo_invitation_error(exc: DemoInvitationError) -> None:
    status_code = 403 if exc.code in {"demo_invitation_email_mismatch", "demo_invitation_required"} else 400
    raise HTTPException(
        status_code=status_code,
        detail={"code": exc.code, "message": exc.message},
    ) from exc


@router.post("/demo-invitations/inspect")
def inspect_demo_invitation_endpoint(
    body: DemoInvitationInspectPayload,
    response: Response,
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    try:
        invitation = inspect_demo_invitation(db, body.token)
    except DemoInvitationError as exc:
        _raise_demo_invitation_error(exc)
    return {
        "ok": True,
        "email": invitation.email,
        "preset": invitation.preset,
        "expires_at": invitation.expires_at,
    }


@router.post("/register")
def register(body: RegisterPayload, request: Request, response: Response, db: Session = Depends(get_db)):
    email_norm = (body.email or "").strip().lower()
    _ensure_public_signup_legal_readiness()
    _throttle_register(request, email_norm)
    company = body.company_name.strip()
    invitation_token = (getattr(body, "demo_invitation_token", None) or "").strip()
    demo_requested = bool(invitation_token)
    existing = db.query(User).filter(User.email == email_norm).first()
    if existing:
        _log_email_event("register_existing_email", email_norm, request)
        if (existing.status or "active") == "pending":
            tenant = db.get(Tenant, existing.tenant_id)
            if tenant:
                _send_verification_email(existing, tenant)
        return {"ok": True, "notice": GENERIC_EMAIL_NOTICE}
    if bool(getattr(body, "demo_data", False)) and not invitation_token:
        _raise_demo_invitation_error(
            DemoInvitationError(
                "demo_invitation_required",
                "Les espaces de démo sont créés sur invitation. Demandez un lien de démo.",
            )
        )
    demo_invitation = None
    if invitation_token:
        try:
            demo_invitation = inspect_demo_invitation(db, invitation_token)
        except DemoInvitationError as exc:
            _raise_demo_invitation_error(exc)
        if demo_invitation.email != email_norm:
            _raise_demo_invitation_error(
                DemoInvitationError(
                    "demo_invitation_email_mismatch",
                    "Cette invitation est liée à une autre adresse e-mail.",
                )
            )
    required_legal_docs = required_docs_for_ui()
    _ensure_signup_legal_acceptance(body.accepted_legal_docs, required_legal_docs)
    _ensure_professional_signup_confirmation(bool(body.professional_use_confirmed))
    requested_plan = "pro" if demo_requested else body.plan
    # Every public self-service signup starts on the isolated 7-day Pro trial.
    # The plan exposes the product surfaces needed for evaluation, while the
    # ``trialing`` status independently blocks final invoice issuance, customer
    # document emails, token purchases and every real provider call. The paid
    # plan selected by the user remains a billing intent until Checkout succeeds.
    plan = "pro"
    billing_request = _billing_request_features(
        requested_plan=requested_plan,
        active_plan=plan,
        requested_period=body.billing_period,
        # Signup always opens the no-card trial first. Even a visitor arriving
        # from a pricing CTA completes the company profile before choosing and
        # paying for a subscription from the authenticated billing page.
        checkout_requested=False,
    )
    t = _create_tenant_with_slug(db, company, plan)
    tenant_id = _required_str(t.id, "tenant.id")
    require_verification = bool(getattr(settings, "REQUIRE_EMAIL_VERIFICATION", False))
    role = "owner"
    status = "pending" if require_verification else "active"
    u = User(
        tenant_id=tenant_id,
        email=email_norm,
        password_hash=pwd.hash(body.password),
        role=role,
        is_admin=False,
        status=status,
    )
    db.add(u)
    db.flush()
    user_id = _required_str(u.id, "user.id")
    if demo_requested:
        try:
            demo_invitation = consume_demo_invitation(
                db,
                token=invitation_token,
                email=email_norm,
                consumed_by_user_id=user_id,
            )
        except DemoInvitationError as exc:
            db.rollback()
            _raise_demo_invitation_error(exc)
    if body.professional_use_confirmed:
        t.professional_use_confirmed_at = _utcnow()
        t.professional_use_confirmed_by = user_id
        db.add(t)
    db.add(Numbering(tenant_id=tenant_id, prefix="F-", last_index=0))
    db.add(Membership(user_id=user_id, tenant_id=tenant_id, role=role))
    tenant_features = _default_tenant_features()
    tenant_features["billing_request"] = billing_request
    if demo_requested:
        tenant_features["demo_request"] = {
            "status": "pending",
            "preset": demo_invitation.preset if demo_invitation is not None else "services",
            "invitation_id": demo_invitation.id if demo_invitation is not None else None,
        }
    db.add(TenantSettings(tenant_id=tenant_id, features=tenant_features))
    _add_signup_legal_acceptances(
        db,
        tenant_id=tenant_id,
        user_id=user_id,
        accepted_role=role,
        required_docs=required_legal_docs,
        request=request,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if _is_user_email_unique_violation(exc):
            _log_email_event("register_existing_email", email_norm, request)
            return {"ok": True, "notice": GENERIC_EMAIL_NOTICE}
        raise
    db.refresh(t)
    db.refresh(u)

    demo_seeded = False
    if demo_requested and not require_verification:
        demo_seeded = _seed_pending_verified_demo(db, u, t)

    if require_verification:
        email_sent = _send_verification_email(u, t)
        return {
            "ok": True,
            "verification_required": True,
            "email_sent": email_sent,
            "demo_seeded": demo_seeded,
            **_register_meta_payload(billing_request),
        }

    payload = _auth_response(u, tenant_id, role, response, db, request)
    if isinstance(payload, dict):
        payload["demo_seeded"] = demo_seeded
        payload.update(_register_meta_payload(billing_request))
    return payload


def _verify_email_token(token: str, db: Session) -> VerifiedBillingIntent | None:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except JWTError:
        raise HTTPException(400, "Jeton invalide ou expiré")
    if payload.get("type") != "verify":
        raise HTTPException(400, "Jeton invalide ou expiré")
    user_id = payload.get("sub")
    try:
        token_version = int(payload.get("token_version", payload.get("tv", -1)))
    except (TypeError, ValueError):
        token_version = -1
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    if token_version != int(u.token_version or 0):
        raise HTTPException(400, "Jeton invalide ou expiré")
    status = _normalized_user_status(u)
    if status == "active":
        tenant = db.get(Tenant, u.tenant_id)
        if tenant:
            _seed_pending_verified_demo(db, u, tenant)
        return _verified_billing_intent(db, u)
    if status != "pending":
        raise HTTPException(
            status_code=403,
            detail={"code": "account_inactive", "message": "Ce compte n'est pas actif."},
        )
    if status != "active":
        u.status = "active"
        tenant = db.get(Tenant, u.tenant_id)
        if tenant and (tenant.subscription_status or "").strip().lower() == "trialing":
            # The public trial starts when the verified owner can actually use
            # the workspace, not while the account is still awaiting email
            # activation. A repeated verification is idempotent because an
            # already-active user returns above without extending the trial.
            tenant.trial_end = _trial_end()
            db.add(tenant)
        db.add(u)
        db.commit()
        db.refresh(u)
    tenant = db.get(Tenant, u.tenant_id)
    if tenant:
        _seed_pending_verified_demo(db, u, tenant)
    return _verified_billing_intent(db, u)


def _normalized_user_status(user: User) -> str:
    return (getattr(user, "status", None) or "active").strip().lower()


def _raise_if_user_cannot_authenticate(user: User) -> None:
    status = _normalized_user_status(user)
    if status == "active":
        return
    if status == "pending":
        metrics.inc_login_failure()
        raise HTTPException(
            status_code=403,
            detail={
                "code": "email_unverified",
                "message": "Email non vérifié. Vérifiez votre email avant de vous connecter.",
            },
        )
    metrics.inc_login_failure()
    raise HTTPException(
        status_code=403,
        detail={"code": "account_inactive", "message": "Compte désactivé. Contactez votre administrateur."},
    )


@router.get("/verify")
def verify_email(token: str, request: Request, db: Session = Depends(get_db), redirect: str | None = None):
    accept = (request.headers.get("accept") or "").lower()
    wants_redirect = "text/html" in accept or (redirect or "").lower() in {"1", "true", "yes"}
    if wants_redirect:
        try:
            _verify_email_token(token, db)
            return RedirectResponse(_login_redirect_url(True), status_code=303)
        except Exception:
            return RedirectResponse(_login_redirect_url(False), status_code=303)
    billing_intent = _verify_email_token(token, db)
    payload: dict[str, Any] = {"ok": True}
    if billing_intent:
        payload["billing_intent"] = billing_intent
    return payload


@router.post("/resend-verification")
def resend_verification(
    body: VerificationResendPayload,
    request: Request,
    db: Session = Depends(get_db),
):
    email_norm = (body.email or "").strip().lower()
    _throttle_verify_resend(request, email_norm)
    if not email_norm:
        return {"ok": True}
    _log_email_event("verification_resend_requested", email_norm, request)
    u = db.query(User).filter(User.email == email_norm).first()
    if not u:
        return {"ok": True}
    if (u.status or "active") != "pending":
        return {"ok": True}
    t = db.get(Tenant, u.tenant_id)
    if not t:
        return {"ok": True}
    _send_verification_email(u, t)
    return {"ok": True}


@router.post("/login")
def login(body: LoginPayload, request: Request, response: Response, db: Session = Depends(get_db)):
    email_norm = (body.email or "").strip().lower()
    _check_login_rate_limits(request, email_norm)
    u = db.query(User).filter(User.email == email_norm).first()
    password_valid = False
    upgraded_password_hash = None
    if u:
        password_valid, upgraded_password_hash = pwd.verify_and_update(body.password, u.password_hash)
    if not u or not password_valid:
        metrics.inc_login_failure()
        _record_login_failure(request, email_norm)
        raise HTTPException(401, "Identifiants invalides")
    _raise_if_user_cannot_authenticate(u)
    membership = _ensure_membership(db, u)
    membership_role = _required_str(membership.role, "membership.role")
    membership_tenant_id = _required_str(membership.tenant_id, "membership.tenant_id")
    if platform_admin_requires_mfa(u) and not u.mfa_enabled:
        return _mfa_setup_required_response(u, membership_tenant_id, membership_role)
    if u.mfa_enabled:
        code = _normalize_mfa_code(getattr(body, "mfa_code", None))
        if not code:
            raise HTTPException(
                status_code=401,
                detail={"code": "mfa_required", "message": "Code MFA requis."},
            )
        if not _verify_mfa_code(u, code):
            metrics.inc_login_failure()
            _record_login_failure(request, email_norm)
            raise HTTPException(
                status_code=401,
                detail={"code": "mfa_invalid", "message": "Code MFA invalide."},
            )
    if upgraded_password_hash:
        # Only persist a legacy bcrypt migration after every authentication
        # factor has succeeded. A failed/partial login must not mutate state.
        u.password_hash = upgraded_password_hash
        db.add(u)
        db.commit()
    metrics.inc_login_success()
    _reset_login_failures(request, email_norm)
    payload = _auth_response(u, membership_tenant_id, membership_role, response, db, request)
    safe_log_action(
        db,
        tenant_id=membership_tenant_id,
        actor_user_id=_required_str(u.id, "user.id"),
        action_type="login",
        object_type="user",
        object_id=_required_str(u.id, "user.id"),
        metadata={"method": "password", "status": "success"},
        commit=True,
    )
    return payload


@router.get("/mfa/status")
def mfa_status(user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    u = db.get(User, user.id)
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    return {
        "enabled": bool(u.mfa_enabled),
        "configured": bool(u.mfa_secret),
        "required": platform_admin_requires_mfa(u),
    }


@router.post("/mfa/setup")
def mfa_setup(
    body: MfaCodePayload | None = Body(default=None),
    user: AuthUser = Depends(current_user),
    db: Session = Depends(get_db),
):
    u = db.get(User, user.id)
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    if u.mfa_enabled:
        code = _normalize_mfa_code(getattr(body, "code", None))
        if not code:
            raise HTTPException(
                status_code=401,
                detail={"code": "mfa_required", "message": "Code MFA requis pour remplacer la configuration."},
            )
        if not _verify_mfa_code(u, code):
            raise HTTPException(400, detail={"code": "mfa_invalid", "message": "Code MFA invalide."})
    tenant = db.get(Tenant, user.tenant_id)
    issuer = (tenant.name if tenant else None) or "Facturation"
    secret = pyotp.random_base32()
    u.mfa_secret = _encode_mfa_secret(secret)
    u.mfa_enabled = False
    u.mfa_enrolled_at = None
    db.add(u)
    db.commit()
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=u.email, issuer_name=issuer)
    return {"secret": secret, "uri": uri, "issuer": issuer}


@router.post("/mfa/verify")
def mfa_verify(
    body: MfaCodePayload,
    request: Request,
    response: Response,
    user: AuthUser = Depends(current_user),
    db: Session = Depends(get_db),
):
    code = _normalize_mfa_code(body.code)
    if not code:
        raise HTTPException(400, detail={"code": "mfa_invalid", "message": "Code MFA invalide."})
    u = db.get(User, user.id)
    if not u or not u.mfa_secret:
        raise HTTPException(400, detail={"code": "mfa_not_configured", "message": "MFA non configuree."})
    if not _verify_mfa_code(u, code):
        raise HTTPException(400, detail={"code": "mfa_invalid", "message": "Code MFA invalide."})
    u.mfa_enabled = True
    u.mfa_enrolled_at = _utcnow()
    db.add(u)
    db.commit()
    if getattr(request.state, "auth_purpose", None) == "mfa_setup":
        membership = _ensure_membership(db, u, tenant_id=user.tenant_id)
        return _auth_response(
            u,
            _required_str(membership.tenant_id, "membership.tenant_id"),
            _required_str(membership.role, "membership.role"),
            response,
            db,
            request,
        )
    return {"ok": True}


@router.post("/mfa/disable")
def mfa_disable(
    body: MfaCodePayload,
    user: AuthUser = Depends(current_user),
    db: Session = Depends(get_db),
):
    code = _normalize_mfa_code(body.code)
    if not code:
        raise HTTPException(400, detail={"code": "mfa_invalid", "message": "Code MFA invalide."})
    u = db.get(User, user.id)
    if not u or not u.mfa_secret:
        raise HTTPException(400, detail={"code": "mfa_not_configured", "message": "MFA non configuree."})
    if not _verify_mfa_code(u, code):
        raise HTTPException(400, detail={"code": "mfa_invalid", "message": "Code MFA invalide."})
    if platform_admin_requires_mfa(u):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "mfa_required_by_policy",
                "message": "La double authentification est obligatoire pour les administrateurs de la plateforme.",
            },
        )
    u.mfa_enabled = False
    u.mfa_secret = None
    u.mfa_enrolled_at = None
    db.add(u)
    db.commit()
    return {"ok": True}


@router.post("/password-reset")
def password_reset(body: PasswordResetRequest, request: Request, db: Session = Depends(get_db)):
    email_norm = (body.email or "").strip().lower()
    _throttle_password_reset(request, email_norm)
    smtp_ready = assert_smtp_ready_or_raise("password_reset")
    u = db.query(User).filter(User.email == email_norm).first()
    if not u:
        _log_email_event("password_reset_unknown_email", email_norm, request)
        return {"ok": True, "delivery": "log_only" if not smtp_ready else "smtp"}  # ne pas révéler
    _log_email_event("password_reset_requested", email_norm, request)
    tok = _token(
        _required_str(u.id, "user.id"),
        _required_str(u.tenant_id, "user.tenant_id"),
        _required_str(u.role, "user.role"),
        minutes=120,
        token_type="reset",
        token_version=u.token_version or 0,
    )
    base = settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "https://example.com"
    link = f"{base}/app/password-reset/confirm#token={tok}"
    if getattr(settings, "PASSWORD_RESET_LOG_LINK", False):
        logger.info("Password reset link (dev) generated for %s", mask_email(u.email))
    if smtp_ready:
        try:
            enqueue_password_reset_email(
                tenant_id=_required_str(u.tenant_id, "user.tenant_id"),
                user_id=_required_str(u.id, "user.id"),
                to=_required_str(u.email, "user.email"),
                reset_url=link,
            )
        except Exception:
            # Anti-enumeration: on ne change pas la réponse API, mais on LOG l'erreur
            logger.exception(
                "Password reset email enqueue failed (SMTP_HOST=%r SMTP_PORT=%r to_masked=%s)",
                getattr(settings, "SMTP_HOST", None),
                getattr(settings, "SMTP_PORT", None),
                mask_email(u.email),
            )
    else:
        logger.warning("SMTP not configured -> password reset email not sent (log-only).")
    return {"ok": True, "delivery": "log_only" if not smtp_ready else "smtp"}


@router.post("/password-reset/confirm")
def password_reset_confirm(body: PasswordResetConfirm, db: Session = Depends(get_db)):
    try:
        payload = jwt.decode(body.token, settings.SECRET_KEY, algorithms=["HS256"])
    except JWTError:
        raise HTTPException(400, "Jeton invalide ou expiré")
    if payload.get("type") != "reset":
        raise HTTPException(400, "Lien de réinitialisation invalide ou expiré.")
    user_id = payload.get("sub")
    try:
        token_version = int(payload.get("token_version", payload.get("tv", -1)))
    except (TypeError, ValueError):
        token_version = -1
    u = db.query(User).filter(User.id == user_id).with_for_update().first()
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    if token_version != int(u.token_version or 0):
        raise HTTPException(400, "Ce lien de réinitialisation a déjà été utilisé ou n'est plus valide.")
    now = _utcnow()
    u.password_hash = pwd.hash(body.new_password)
    u.token_version = int(u.token_version or 0) + 1
    db.query(AuthSession).filter(AuthSession.user_id == u.id, AuthSession.revoked_at.is_(None)).update(
        {"revoked_at": now},
        synchronize_session=False,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return {"ok": True}


@router.post("/change-password")
def change_password(
    body: PasswordChangePayload,
    response: Response,
    user: AuthUser = Depends(current_user),
    db: Session = Depends(get_db),
):
    db_user = db.query(User).filter(User.id == user.id).with_for_update().first()
    if not db_user:
        raise HTTPException(status_code=404, detail={"code": "user_not_found", "message": "Utilisateur introuvable."})
    if not pwd.verify(body.current_password, db_user.password_hash):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_current_password", "message": "Mot de passe actuel incorrect."},
        )
    if pwd.verify(body.new_password, db_user.password_hash):
        raise HTTPException(
            status_code=400,
            detail={"code": "same_password", "message": "Choisissez un mot de passe différent de l'actuel."},
        )
    now = _utcnow()
    db_user.password_hash = pwd.hash(body.new_password)
    db_user.token_version = int(db_user.token_version or 0) + 1
    revoked = (
        db.query(AuthSession)
        .filter(AuthSession.user_id == db_user.id, AuthSession.revoked_at.is_(None))
        .update({"revoked_at": now}, synchronize_session=False)
    )
    db.add(db_user)
    db.commit()
    _clear_auth_cookies(response)
    safe_log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="password_changed",
        object_type="user",
        object_id=user.id,
        metadata={"revoked_sessions": int(revoked or 0)},
        commit=True,
    )
    return {"ok": True, "requires_login": True, "revoked_sessions": int(revoked or 0)}


@router.post("/refresh")
def refresh_tokens(
    request: Request,
    response: Response,
    body: TokenRefreshRequest | None = None,
    db: Session = Depends(get_db),
):
    refresh_token = (body.refresh_token if body else None) if auth_bearer_mode_enabled() else None
    if not refresh_token:
        refresh_token = request.cookies.get(REFRESH_COOKIE)
    if not refresh_token:
        hint = _cookie_hint(request)
        if hint:
            raise HTTPException(
                status_code=401,
                detail={"code": "cookie_config_issue", "message": "Cookies non envoyés.", "hint": hint},
            )
        raise HTTPException(status_code=401, detail={"code": "session_expired", "message": "Session expirée."})
    if auth_cookie_mode_enabled():
        _require_csrf(request)
    try:
        payload = jwt.decode(refresh_token, settings.SECRET_KEY, algorithms=["HS256"])
    except JWTError:
        raise HTTPException(status_code=401, detail={"code": "session_expired", "message": "Session expirée."})
    if payload.get("type") != "refresh":
        raise HTTPException(400, "Session invalide. Reconnectez-vous.")
    user = db.get(User, payload.get("sub"))
    if not user:
        raise HTTPException(404, "Utilisateur introuvable")
    if _normalized_user_status(user) != "active":
        raise HTTPException(status_code=401, detail={"code": "session_expired", "message": "Session expirée."})
    sid = payload.get("sid")
    jti = payload.get("jti")
    if not sid or not jti:
        raise HTTPException(status_code=401, detail={"code": "session_expired", "message": "Session expirée."})
    session = db.query(AuthSession).filter(AuthSession.id == sid).with_for_update().first()
    if not session or session.user_id != user.id or session.revoked_at is not None:
        raise HTTPException(status_code=401, detail={"code": "session_expired", "message": "Session expirée."})
    if payload.get("tv") != (user.token_version or 0):
        if session.revoked_at is None:
            session.revoked_at = _utcnow()
            db.add(session)
            db.commit()
        raise HTTPException(status_code=401, detail={"code": "session_expired", "message": "Session expirée."})
    if _hash_jti(str(jti)) != session.refresh_jti_hash:
        session.revoked_at = _utcnow()
        db.add(session)
        db.commit()
        raise HTTPException(status_code=401, detail={"code": "session_expired", "message": "Session expirée."})
    tenant_id = payload.get("tenant") or user.tenant_id
    membership = _ensure_membership(db, user, tenant_id=tenant_id)
    membership_tenant_id = _required_str(membership.tenant_id, "membership.tenant_id")
    membership_role = _required_str(membership.role, "membership.role")
    if platform_admin_requires_mfa(user) and not bool(user.mfa_enabled):
        session.revoked_at = _utcnow()
        db.add(session)
        db.commit()
        return _mfa_setup_required_response(
            user,
            membership_tenant_id,
            membership_role,
        )
    new_jti = str(uuid4())
    session.refresh_jti_hash = _hash_jti(new_jti)
    session.last_used_at = _utcnow()
    session.tenant_id = membership_tenant_id
    db.add(session)
    db.commit()
    tokens = _issue_tokens(
        user,
        membership_tenant_id,
        membership_role,
        session_id=_required_str(session.id, "session.id"),
        refresh_jti=new_jti,
    )
    if auth_bearer_mode_enabled():
        return tokens
    _set_auth_cookies(response, tokens)
    return {"ok": True}


@router.post("/google")
def login_google(
    body: GoogleLoginPayload,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    if not settings.GOOGLE_CLIENT_ID:
        metrics.inc_login_failure()
        raise HTTPException(400, "Google Sign-In non configuré")
    try:
        info = id_token.verify_oauth2_token(body.id_token, requests.Request(), settings.GOOGLE_CLIENT_ID)
    except Exception:
        metrics.inc_login_failure()
        raise HTTPException(401, "Connexion Google impossible. Réessayez ou utilisez votre email et mot de passe.")
    email = info.get("email")
    email_norm = (email or "").strip().lower()
    if not email_norm:
        metrics.inc_login_failure()
        raise HTTPException(400, "Email Google manquant")
    email_verified = info.get("email_verified")
    if email_verified is not None and str(email_verified).lower() not in {"true", "1"}:
        metrics.inc_login_failure()
        raise HTTPException(401, "Email Google non vérifié")
    user = db.query(User).filter(User.email == email_norm).first()
    if not user:
        _ensure_public_signup_legal_readiness()
        _throttle_register(request, email_norm)
        required_legal_docs = required_docs_for_ui()
        _ensure_signup_legal_acceptance(body.accepted_legal_docs, required_legal_docs)
        _ensure_professional_signup_confirmation(bool(body.professional_use_confirmed))
        # On crée un tenant + user automatiquement
        name = (body.company_name or email_norm.split("@")[0]).strip()
        t = _create_tenant_with_slug(db, name)
        tenant_id = _required_str(t.id, "tenant.id")
        user = User(
            tenant_id=tenant_id,
            email=email_norm,
            password_hash=pwd.hash(secrets.token_urlsafe(16)),
            role="owner",
            is_admin=False,
        )
        db.add(user)
        db.flush()
        user_id = _required_str(user.id, "user.id")
        if body.professional_use_confirmed:
            t.professional_use_confirmed_at = _utcnow()
            t.professional_use_confirmed_by = user_id
            db.add(t)
        db.add(Membership(user_id=user_id, tenant_id=tenant_id, role="owner"))
        db.add(Numbering(tenant_id=tenant_id, prefix="F-", last_index=0))
        _add_signup_legal_acceptances(
            db,
            tenant_id=tenant_id,
            user_id=user_id,
            accepted_role="owner",
            required_docs=required_legal_docs,
            request=request,
        )
        db.commit()
        db.refresh(user)
    else:
        _raise_if_user_cannot_authenticate(user)
    membership = _ensure_membership(db, user)
    membership_role = _required_str(membership.role, "membership.role")
    membership_tenant_id = _required_str(membership.tenant_id, "membership.tenant_id")
    if platform_admin_requires_mfa(user) and not user.mfa_enabled:
        return _mfa_setup_required_response(user, membership_tenant_id, membership_role)
    if user.mfa_enabled:
        code = _normalize_mfa_code(getattr(body, "mfa_code", None))
        if not code:
            raise HTTPException(
                status_code=401,
                detail={"code": "mfa_required", "message": "Code MFA requis."},
            )
        if not _verify_mfa_code(user, code):
            metrics.inc_login_failure()
            raise HTTPException(
                status_code=401,
                detail={"code": "mfa_invalid", "message": "Code MFA invalide."},
            )
    metrics.inc_login_success()
    payload = _auth_response(user, membership_tenant_id, membership_role, response, db, request)
    safe_log_action(
        db,
        tenant_id=membership_tenant_id,
        actor_user_id=_required_str(user.id, "user.id"),
        action_type="login",
        object_type="user",
        object_id=_required_str(user.id, "user.id"),
        metadata={"method": "google", "status": "success"},
        commit=True,
    )
    return payload


def _audit_logout(
    db: Session,
    *,
    actor_user_id: str,
    tenant_id: str,
    auth_method: str,
) -> None:
    """Record a logout only while its FK principals still exist.

    A correctly signed cookie can outlive a purged account.  In that case the
    logout itself must remain idempotent and must not turn the expected stale
    principal into an ``action_log_failed`` alert.
    """
    principal_fingerprint = hashlib.sha256(f"{tenant_id}:{actor_user_id}".encode()).hexdigest()[:16]

    def log_stale_session(*, tenant_exists: bool, actor_exists: bool, concurrent_purge: bool = False) -> None:
        logger.info(
            "logout_stale_session",
            extra={
                "auth_method": auth_method,
                "tenant_exists": tenant_exists,
                "actor_exists": actor_exists,
                "concurrent_purge": concurrent_purge,
                "principal_fingerprint": principal_fingerprint,
            },
        )

    try:
        tenant_exists = db.query(Tenant.id).filter(Tenant.id == tenant_id).one_or_none() is not None
        actor_exists = db.query(User.id).filter(User.id == actor_user_id).one_or_none() is not None
    except Exception:
        db.rollback()
        logger.exception("logout_audit_principal_check_failed")
        return

    if not tenant_exists or not actor_exists:
        db.rollback()
        log_stale_session(tenant_exists=tenant_exists, actor_exists=actor_exists)
        return

    try:
        log_action(
            db,
            tenant_id=tenant_id,
            actor_user_id=actor_user_id,
            action_type="logout",
            object_type="user",
            object_id=actor_user_id,
            metadata={"method": auth_method, "status": "success"},
            commit=True,
        )
    except IntegrityError as exc:
        db.rollback()
        sqlstate = getattr(getattr(exc, "orig", None), "sqlstate", None) or getattr(
            getattr(exc, "orig", None), "pgcode", None
        )
        foreign_key_violation = "foreign key constraint failed" in str(getattr(exc, "orig", exc)).lower()
        if sqlstate == "23503" or foreign_key_violation:
            log_stale_session(tenant_exists=True, actor_exists=True, concurrent_purge=True)
            return
        logger.exception("logout_audit_failed")
    except Exception:
        db.rollback()
        logger.exception("logout_audit_failed")


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    actor_user_id: str | None = None
    tenant_id: str | None = None
    auth_method = "cookie"
    if auth_cookie_mode_enabled() and (request.cookies.get(ACCESS_COOKIE) or request.cookies.get(REFRESH_COOKIE)):
        _require_csrf(request)
    refresh_token = request.cookies.get(REFRESH_COOKIE)
    if refresh_token:
        try:
            payload = jwt.decode(
                refresh_token,
                settings.SECRET_KEY,
                algorithms=["HS256"],
                options={"verify_exp": False},
            )
        except JWTError:
            payload = None
        if payload and payload.get("type") == "refresh":
            actor_user_id = payload.get("sub") or actor_user_id
            tenant_id = payload.get("tenant") or tenant_id
            try:
                actor_user_id, tenant_id, _ = _revoke_session_from_claims(db, payload)
            except Exception:
                db.rollback()
    else:
        auth_method = "bearer" if auth_bearer_mode_enabled() else "cookie"
        access_token = request.cookies.get(ACCESS_COOKIE)
        if not access_token:
            auth_header = (request.headers.get("Authorization") or "").strip()
            if auth_header.lower().startswith("bearer "):
                access_token = auth_header.split(" ", 1)[1].strip()
        if access_token:
            try:
                payload = jwt.decode(
                    access_token,
                    settings.SECRET_KEY,
                    algorithms=["HS256"],
                    options={"verify_exp": False},
                )
            except JWTError:
                payload = None
            if payload and payload.get("type") == "access":
                actor_user_id = payload.get("sub") or actor_user_id
                tenant_id = payload.get("tenant") or tenant_id
                try:
                    actor_user_id, tenant_id, _ = _revoke_session_from_claims(db, payload)
                except Exception:
                    db.rollback()
    _clear_auth_cookies(response)
    if actor_user_id and tenant_id:
        _audit_logout(
            db,
            auth_method=auth_method,
            tenant_id=tenant_id,
            actor_user_id=actor_user_id,
        )
    return {"ok": True}


@router.get("/sessions")
def list_sessions(user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(AuthSession).filter(AuthSession.user_id == user.id).order_by(AuthSession.created_at.desc()).all()
    return {
        "sessions": [
            {
                "sid": row.id,
                "created_at": row.created_at,
                "last_used_at": row.last_used_at,
                "revoked_at": row.revoked_at,
                "user_agent": row.user_agent,
                "ip": row.ip,
            }
            for row in rows
        ]
    }


@router.post("/sessions/revoke")
def revoke_sessions(
    body: SessionRevokePayload,
    user: AuthUser = Depends(current_user),
    db: Session = Depends(get_db),
):
    if body.sid and body.all:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_request", "message": "Choisissez une session ou toutes les sessions."},
        )
    now = _utcnow()
    if body.all:
        revoked = (
            db.query(AuthSession)
            .filter(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
            .update({"revoked_at": now}, synchronize_session=False)
        )
        db_user = db.query(User).filter(User.id == user.id).with_for_update().first()
        if db_user:
            db_user.token_version = int(db_user.token_version or 0) + 1
            db.add(db_user)
        db.commit()
        return {"ok": True, "revoked": revoked}
    if not body.sid:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_request", "message": "Sélectionnez la session à déconnecter."},
        )
    session = db.query(AuthSession).filter(AuthSession.id == body.sid, AuthSession.user_id == user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session introuvable")
    if session.revoked_at is None:
        session.revoked_at = now
        db.add(session)
        db.commit()
    return {"ok": True}


@router.get("/csrf")
def csrf_token(response: Response):
    token = secrets.token_urlsafe(32)
    max_age = int((settings.REFRESH_TOKEN_EXPIRE_DAYS or 7) * 24 * 60 * 60)
    response.set_cookie(CSRF_COOKIE, token, **_cookie_params(max_age, False))
    return {"csrf_token": token}


@router.get("/debug-cookies")
def debug_cookies(request: Request):
    env = (settings.APP_ENV or "").strip().lower()
    if env in {"prod", "production", "staging"}:
        raise HTTPException(status_code=404, detail="Not found")
    params = _cookie_params(0, True)
    return {
        "access_token": bool(request.cookies.get(ACCESS_COOKIE)),
        "refresh_token": bool(request.cookies.get(REFRESH_COOKIE)),
        "csrf_token": bool(request.cookies.get(CSRF_COOKIE)),
        "auth_session": bool(request.cookies.get(SESSION_COOKIE)),
        "samesite": params.get("samesite"),
        "secure": params.get("secure"),
    }


@router.post("/switch-tenant")
def switch_tenant(
    body: SwitchTenantPayload,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    membership = (
        db.query(Membership)
        .join(Tenant, Tenant.id == Membership.tenant_id)
        .filter(
            Membership.user_id == user.id,
            Membership.tenant_id == body.tenant_id,
            Tenant.deleted_at.is_(None),
        )
        .first()
    )
    if not membership:
        raise HTTPException(403, "Vous n’avez pas accès à cet espace.")
    membership_tenant_id = _required_str(membership.tenant_id, "membership.tenant_id")
    membership_role = _required_str(membership.role, "membership.role")
    db_user = db.get(User, user.id)
    if not db_user:
        raise HTTPException(404, "Utilisateur introuvable")
    if platform_admin_requires_mfa(db_user) and not bool(db_user.mfa_enabled):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "mfa_setup_required",
                "message": "Activez l'authentification à deux facteurs pour administrer la plateforme.",
                "setup_allowed": True,
            },
        )
    db_user.tenant_id = membership_tenant_id
    db_user.role = membership_role
    db.add(db_user)
    db.commit()
    refresh_payload = None
    refresh_token = request.cookies.get(REFRESH_COOKIE)
    if refresh_token:
        try:
            refresh_payload = jwt.decode(
                refresh_token,
                settings.SECRET_KEY,
                algorithms=["HS256"],
                options={"verify_exp": False},
            )
        except JWTError:
            refresh_payload = None
    session = None
    new_jti = None
    if refresh_payload and refresh_payload.get("type") == "refresh":
        sid = refresh_payload.get("sid")
        jti = refresh_payload.get("jti")
        if sid and jti:
            session = db.query(AuthSession).filter(AuthSession.id == sid, AuthSession.user_id == user.id).first()
            if session and session.revoked_at is None:
                if _hash_jti(str(jti)) == session.refresh_jti_hash:
                    new_jti = str(uuid4())
                    session.refresh_jti_hash = _hash_jti(new_jti)
                    session.last_used_at = _utcnow()
                    session.tenant_id = membership_tenant_id
                    db.add(session)
                    db.commit()
                else:
                    session.revoked_at = _utcnow()
                    db.add(session)
                    db.commit()
                    session = None
    if not session or not new_jti:
        session, new_jti = _create_auth_session(db, db_user, membership_tenant_id, request)
    tokens = _issue_tokens(
        db_user,
        membership_tenant_id,
        membership_role,
        session_id=_required_str(session.id, "session.id"),
        refresh_jti=new_jti,
    )
    if auth_bearer_mode_enabled():
        return tokens
    _set_auth_cookies(response, tokens)
    return {"ok": True, "tenant_id": membership_tenant_id, "role": membership_role}


@router.get("/tenants")
def list_user_tenants(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    rows = (
        db.query(Membership, Tenant)
        .join(Tenant, Tenant.id == Membership.tenant_id)
        .filter(Membership.user_id == user.id, Tenant.deleted_at.is_(None))
        .order_by(Tenant.name.asc())
        .all()
    )
    return {
        "current_tenant_id": user.tenant_id,
        "tenants": [
            {
                "id": tenant.id,
                "name": tenant.name,
                "slug": tenant.tenant_slug,
                "role": membership.role,
                "is_current": tenant.id == user.tenant_id,
            }
            for membership, tenant in rows
        ],
    }


@router.get("/me")
def me(user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    tenant_settings = db.get(TenantSettings, user.tenant_id)
    if not tenant_settings:
        tenant_settings = TenantSettings(tenant_id=user.tenant_id)
        db.add(tenant_settings)
        try:
            db.commit()
        except IntegrityError:
            # Concurrent request may have created settings first.
            db.rollback()
        tenant_settings = db.get(TenantSettings, user.tenant_id)
        if tenant_settings:
            db.refresh(tenant_settings)
    if tenant_settings is None:
        tenant_settings = TenantSettings(tenant_id=user.tenant_id)
    tenant = db.get(Tenant, user.tenant_id)
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "tenant_id": user.tenant_id,
        "is_admin": bool(user.is_admin),
        "is_support": bool(user.is_support),
        "mfa_enabled": bool(user.mfa_enabled),
        "plan": tenant.plan if tenant else None,
        "subscription_status": tenant.subscription_status if tenant else None,
        "trial_end": tenant.trial_end if tenant else None,
        "tenant_settings": {
            "preset": tenant_settings.preset,
            "features": tenant_settings.features,
            "onboarding_completed": tenant_settings.onboarding_completed,
        },
        "capabilities": {
            **build_compliance_capabilities(),
            **build_tenant_product_capabilities(db, tenant),
        },
    }
