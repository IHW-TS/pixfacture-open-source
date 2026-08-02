import asyncio
import shutil
import smtplib
import ssl
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Response, HTTPException
from pydantic import BaseModel, EmailStr
from redis import Redis
import stripe
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import (
    settings,
    _is_prod_env,
    is_prod_like,
    auth_cookie_mode_enabled,
    _cookie_domain_allows_host,
    _is_secure_cookie_env,
    _is_secret_key_strong,
    _normalize_host,
    parse_connected_mode_allowed_tenant_ids,
    _registrable_domain,
    _storage_local_root_value,
    _validate_local_storage_root,
)
from ..db import get_db
from ..deps import require_internal_user, require_platform_admin, AuthUser
from ..jobs.diagnostic import collect_jobs_diagnostic
from ..jobs.queue import enqueue_job
from ..jobs.diagnostic_jobs import ping as ping_job
from ..jobs.heartbeat import expected_heartbeat_ttl_seconds, get_periodic_heartbeat
from ..validators.invoice_sanity_checks import get_invoice_sanity_checks_version
from ..services.facturx import _pdfa_policy, _resolve_srgb_icc_path
from ..services.compliance_claims import build_compliance_claims
from ..services.storage import object_lock_status, run_storage_diagnostic, storage_provider
from ..services.email import smtp_diagnostic_payload, assert_smtp_ready_or_raise, send_email
from ..services.seqino import SeqinoClient


router = APIRouter(
    prefix="/api/diagnostic",
    tags=["diagnostic"],
    dependencies=[Depends(require_internal_user)],
)

_PROD_ENVS = {"prod", "production", "staging"}


def _check_db(db: Session) -> dict:
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception:
        return {
            "status": "error",
            "recommendation": "Vérifier DATABASE_URL et l'accès à la base.",
        }


def _check_redis() -> dict:
    redis_url = (settings.REDIS_URL or "").strip()
    if not redis_url:
        status = "error" if _is_prod_env() else "warn"
        return {
            "status": status,
            "recommendation": "Configurer REDIS_URL pour les files/jobs et la limitation.",
        }
    try:
        Redis.from_url(
            redis_url,
            socket_connect_timeout=0.3,
            socket_timeout=0.3,
            decode_responses=False,
        ).ping()
        return {"status": "ok"}
    except Exception:
        return {
            "status": "error",
            "recommendation": "Connexion Redis impossible. Vérifier REDIS_URL et le réseau.",
        }


def _check_storage() -> dict:
    provider = storage_provider()
    ok, latency_ms, error = run_storage_diagnostic(prefix="diagnostic/")
    bucket = (settings.STORAGE_BUCKET or settings.S3_BUCKET or "").strip() or None
    endpoint = (settings.S3_ENDPOINT or "").strip() or None
    if ok:
        return {
            "status": "ok",
            "provider": provider,
            "latency_ms": latency_ms,
            "bucket": bucket,
            "endpoint": endpoint,
        }
    return {
        "status": "error",
        "provider": provider,
        "latency_ms": latency_ms,
        "bucket": bucket,
        "endpoint": endpoint,
        "error": error,
        "recommendation": "Vérifier le bucket/endpoint/credentials et les droits d'accès.",
    }


def _check_smtp_deployment() -> dict:
    if not settings.SMTP_ENABLED:
        return {"status": "warn", "recommendation": "SMTP désactivé (SMTP_ENABLED=false)."}
    host = (settings.SMTP_HOST or "").strip()
    port = int(settings.SMTP_PORT or 0)
    if not host or not port:
        return {
            "status": "error",
            "recommendation": "SMTP_HOST/SMTP_PORT manquants.",
        }
    try:
        with smtplib.SMTP(host, port, timeout=2) as server:
            server.ehlo()
            if settings.SMTP_STARTTLS:
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
            if settings.SMTP_USERNAME and settings.SMTP_PASSWORD:
                server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            server.noop()
        return {"status": "ok"}
    except smtplib.SMTPAuthenticationError:
        return {
            "status": "error",
            "recommendation": "Authentification SMTP échouée (user/pwd).",
        }
    except Exception:
        return {
            "status": "error",
            "recommendation": "Connexion SMTP impossible. Vérifier SMTP_HOST/PORT/STARTTLS.",
        }


def _check_stripe() -> dict:
    billing_enabled = bool(settings.BILLING_ENABLED or settings.SUBSCRIPTION_REQUIRED)
    if not billing_enabled:
        return {"status": "warn", "recommendation": "Billing désactivé (pas de Stripe requis)."}
    secret_key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not secret_key:
        return {
            "status": "error",
            "recommendation": "STRIPE_SECRET_KEY manquant.",
        }
    price_ids = settings.stripe_subscription_prices()
    missing_prices = settings.missing_stripe_subscription_prices()
    if missing_prices:
        return {
            "status": "error",
            "missing_subscription_prices": missing_prices,
            "recommendation": "Configurer les 4 prix d'abonnement Stripe: Starter mensuel/annuel et Pro mensuel/annuel.",
        }
    price_id = price_ids["starter_monthly"]
    assert price_id is not None
    stripe.api_key = secret_key
    try:
        price = stripe.Price.retrieve(price_id)
    except stripe.error.StripeError as exc:
        return {
            "status": "error",
            "error_type": exc.__class__.__name__,
            "recommendation": "Vérifier STRIPE_SECRET_KEY et les STRIPE_PRICE_STARTER/PRO_(MONTHLY|YEARLY) dans le même compte Stripe.",
        }
    unit_amount = price.get("unit_amount") if isinstance(price, dict) else getattr(price, "unit_amount", None)
    currency = price.get("currency") if isinstance(price, dict) else getattr(price, "currency", None)
    return {
        "status": "ok",
        "price_id": price_id,
        "price_currency": (currency or "eur").lower(),
        "price_amount": unit_amount,
        "token_packs_configured": sorted(settings.stripe_token_prices().keys()),
    }


def _check_pdfa() -> dict:
    policy = _pdfa_policy()
    mode = policy.mode
    prod_like = is_prod_like()
    result: dict[str, object] = {
        "status": "ok",
        "mode": mode,
        "strict": policy.strict,
        "pdfa_recommended_for_prod": prod_like,
    }

    def _add_recommendation(message: str) -> None:
        if not message:
            return
        current = result.get("recommendation")
        if current:
            result["recommendation"] = f"{current} {message}"
        else:
            result["recommendation"] = message

    def _finalize() -> dict:
        if prod_like and mode != "strict":
            if result["status"] == "ok":
                result["status"] = "warn"
            _add_recommendation(
                "Recommandation: utiliser FACTURX_PDFA_MODE=strict en production si vous vendez conformite."
            )
        return result

    if mode == "off":
        result["status"] = "warn"
        _add_recommendation("PDF/A-3 désactivé (mode off).")
        return _finalize()
    if policy.convert:
        if not shutil.which("gs"):
            result["status"] = "error"
            _add_recommendation("Installer Ghostscript (gs) pour la conversion PDF/A-3.")
            return _finalize()
        try:
            _resolve_srgb_icc_path()
        except Exception:
            result["status"] = "error"
            _add_recommendation("Installer un profil ICC sRGB (icc-profiles-free).")
            return _finalize()
    if policy.validate and not shutil.which("verapdf"):
        if policy.strict:
            result["status"] = "error"
            _add_recommendation("Installer veraPDF pour la validation PDF/A-3.")
            return _finalize()
        result["status"] = "warn"
        _add_recommendation("veraPDF absent : validation PDF/A-3 non disponible.")
        return _finalize()
    return _finalize()


def _sanitize_origin(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if raw == "*":
        return "*"
    parsed = urlparse(raw)
    if parsed.scheme and parsed.netloc:
        host = parsed.hostname or parsed.netloc
        if not host:
            return raw
        port = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{host}{port}"
    return raw.split("/")[0]


def _normalize_origin(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if parsed.scheme and parsed.netloc:
        host = parsed.hostname or parsed.netloc
        if not host:
            return raw
        port = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{host}{port}"
    return raw.rstrip("/")


def _has_value(value: str | None) -> bool:
    return bool((value or "").strip())


_LEVEL_PRIORITY = {"ok": 0, "warn": 1, "fail": 2}


def _bump_level(current: str, candidate: str) -> str:
    return candidate if _LEVEL_PRIORITY[candidate] > _LEVEL_PRIORITY[current] else current


def _is_prod_env_check() -> bool:
    return (settings.APP_ENV or "").strip().lower() in _PROD_ENVS


def _check_env_sanity() -> dict:
    app_env = (settings.APP_ENV or "").strip()
    public_base = (settings.PUBLIC_BASE_URL or "").strip()
    prod_like = is_prod_like()
    details = {
        "app_env": app_env or None,
        "public_base_url": public_base or None,
        "prod_like": prod_like,
    }
    if prod_like and app_env.lower() in {"dev", "local", "test"}:
        return {
            "id": "env_sanity",
            "level": "fail",
            "message": "APP_ENV non-prod detecte sur un domaine public https.",
            "details": details,
            "recommendation": (
                "Passez APP_ENV=prod|production|staging pour un domaine public, "
                "ou utilisez un PUBLIC_BASE_URL local (localhost/127.0.0.1)."
            ),
        }
    return {
        "id": "env_sanity",
        "level": "ok",
        "message": "Environnement coherent.",
        "details": details,
    }


def _check_base_urls() -> dict:
    env_is_prod = _is_prod_env_check()
    public_base = (settings.PUBLIC_BASE_URL or "").strip()
    frontend_base = (settings.FRONTEND_BASE_URL or "").strip()
    issues: list[tuple[str, str]] = []
    level = "ok"
    details: dict[str, object] = {
        "public_base_url": public_base or None,
        "frontend_base_url": frontend_base or None,
    }

    if not public_base:
        issues.append(("fail" if env_is_prod else "warn", "PUBLIC_BASE_URL manquant."))
    else:
        public_scheme = urlparse(public_base).scheme
        details["public_https"] = public_scheme == "https"
        if env_is_prod and public_scheme != "https":
            issues.append(("fail", "PUBLIC_BASE_URL doit être en https en prod/staging."))
        elif public_scheme and public_scheme != "https":
            issues.append(("warn", "PUBLIC_BASE_URL n'est pas en https."))

    if frontend_base:
        front_scheme = urlparse(frontend_base).scheme
        details["frontend_https"] = front_scheme == "https"
        if env_is_prod and front_scheme != "https":
            issues.append(("fail", "FRONTEND_BASE_URL doit être en https en prod/staging."))
        elif front_scheme and front_scheme != "https":
            issues.append(("warn", "FRONTEND_BASE_URL n'est pas en https."))
        public_host = _normalize_host(public_base) if public_base else None
        frontend_host = _normalize_host(frontend_base)
        public_reg = _registrable_domain(public_host) if public_host else None
        front_reg = _registrable_domain(frontend_host) if frontend_host else None
        details["registrable_domain_match"] = bool(public_reg and front_reg and public_reg == front_reg)
        if public_reg and front_reg and public_reg != front_reg:
            issues.append(("warn", "FRONTEND_BASE_URL et PUBLIC_BASE_URL ne partagent pas le même domaine registrable."))

    if not issues:
        return {
            "id": "base_urls",
            "level": "ok",
            "message": "URLs publiques configurées.",
            "details": details,
        }
    for issue_level, _ in issues:
        level = _bump_level(level, issue_level)
    return {
        "id": "base_urls",
        "level": level,
        "message": " ".join([msg for _, msg in issues]),
        "details": details,
    }


def _check_cors() -> dict:
    env_is_prod = _is_prod_env_check()
    origins = [o.strip() for o in (settings.CORS_ORIGINS or "").split(",") if o.strip()]
    normalized = [_normalize_origin(o) for o in origins]
    expected_base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    expected_origin = _normalize_origin(expected_base)
    details = {
        "expected_origin": expected_origin or None,
        "cors_origins": normalized,
    }
    if not origins:
        level = "fail" if env_is_prod else "warn"
        return {
            "id": "cors_origins",
            "level": level,
            "message": "CORS_ORIGINS manquant ou vide.",
            "details": details,
        }
    if expected_origin and expected_origin not in normalized:
        level = "fail" if env_is_prod else "warn"
        return {
            "id": "cors_origins",
            "level": level,
            "message": "CORS_ORIGINS n'inclut pas l'origine publique attendue.",
            "details": details,
        }
    return {
        "id": "cors_origins",
        "level": "ok",
        "message": "CORS_ORIGINS inclut l'origine publique.",
        "details": details,
    }


def _check_cookie_secure() -> dict:
    env_is_prod = _is_prod_env_check()
    secure = _is_secure_cookie_env()
    public_base = (settings.PUBLIC_BASE_URL or "").strip()
    frontend_base = (settings.FRONTEND_BASE_URL or "").strip()
    public_host = _normalize_host(public_base) if public_base else None
    frontend_host = _normalize_host(frontend_base) if frontend_base else None
    cookie_domain = _normalize_host(settings.COOKIE_DOMAIN)
    samesite = (settings.COOKIE_SAMESITE or "lax").strip().lower()
    details = {
        "cookie_secure": settings.COOKIE_SECURE,
        "derived_secure": secure,
        "cookie_domain": cookie_domain or None,
        "cookie_samesite": samesite,
        "public_base_url": public_base or None,
        "frontend_base_url": frontend_base or None,
    }
    issues: list[tuple[str, str]] = []
    if not secure:
        issues.append(("fail" if env_is_prod else "warn", "Cookies non sécurisés (Secure=false)."))
    if cookie_domain and public_host and not _cookie_domain_allows_host(public_host, cookie_domain):
        issues.append(("fail" if env_is_prod else "warn", "COOKIE_DOMAIN ne correspond pas au domaine PUBLIC_BASE_URL."))
    if samesite == "none" and not secure:
        issues.append(("fail" if env_is_prod else "warn", "COOKIE_SAMESITE=none requiert Secure=true."))
    if samesite != "none" and public_host and frontend_host and public_host != frontend_host:
        issues.append((
            "fail" if env_is_prod else "warn",
            "COOKIE_SAMESITE doit être 'none' si le front est sur un autre domaine.",
        ))
    if not issues:
        return {
            "id": "cookie_secure",
            "level": "ok",
            "message": "Cookies configurés correctement.",
            "details": details,
        }
    level = "ok"
    for issue_level, _ in issues:
        level = _bump_level(level, issue_level)
    return {
        "id": "cookie_secure",
        "level": level,
        "message": " ".join([msg for _, msg in issues]),
        "details": details,
    }


def _check_secret_key() -> dict:
    env_is_prod = _is_prod_env_check()
    secret = (settings.SECRET_KEY or "").strip()
    strong = _is_secret_key_strong(secret)
    details = {
        "present": bool(secret),
        "length": len(secret),
        "strong": strong,
    }
    if not strong:
        level = "fail" if env_is_prod else "warn"
        return {
            "id": "secret_key",
            "level": level,
            "message": "SECRET_KEY trop faible ou par défaut.",
            "details": details,
        }
    return {
        "id": "secret_key",
        "level": "ok",
        "message": "SECRET_KEY robuste.",
        "details": details,
    }


def _check_seqino() -> dict:
    if not settings.REQUIRE_SEQINO_IN_PROD:
        return {
            "id": "seqino_config",
            "level": "ok",
            "message": "Plateforme partenaire non requise par la configuration.",
            "details": {"required": False},
        }
    missing: list[str] = []
    if not _has_value(settings.SEQINO_BASE_URL):
        missing.append("SEQINO_BASE_URL")
    if not _has_value(settings.SEQINO_ACCESS_TOKEN):
        missing.append("SEQINO_ACCESS_TOKEN")
    if not _has_value(settings.SEQINO_SPONSOR_ID):
        missing.append("SEQINO_SPONSOR_ID")
    if missing:
        return {
            "id": "seqino_config",
            "level": "fail",
            "message": "Configuration plateforme partenaire incomplète.",
            "details": {"required": True, "missing": missing},
        }
    return {
        "id": "seqino_config",
        "level": "ok",
        "message": "Configuration plateforme partenaire complète.",
        "details": {"required": True},
    }


def _check_smtp_preflight() -> dict:
    verification_required = bool(getattr(settings, "REQUIRE_EMAIL_VERIFICATION", False))
    if not settings.SMTP_ENABLED:
        if verification_required:
            return {
                "id": "smtp_config",
                "level": "fail",
                "message": "SMTP désactivé alors que la vérification email est requise.",
                "details": {"enabled": False, "verification_required": True},
            }
        return {
            "id": "smtp_config",
            "level": "warn",
            "message": "SMTP désactivé.",
            "details": {"enabled": False, "verification_required": verification_required},
        }
    missing = []
    if not _has_value(settings.SMTP_HOST):
        missing.append("SMTP_HOST")
    if not _has_value(settings.SMTP_USERNAME):
        missing.append("SMTP_USERNAME")
    if not _has_value(settings.SMTP_PASSWORD):
        missing.append("SMTP_PASSWORD")
    if missing:
        return {
            "id": "smtp_config",
            "level": "fail",
            "message": "SMTP activé mais configuration incomplète.",
            "details": {"enabled": True, "missing": missing, "verification_required": verification_required},
        }
    return {
        "id": "smtp_config",
        "level": "ok",
        "message": "SMTP configuré.",
        "details": {"enabled": True, "verification_required": verification_required},
    }


def _check_stripe_preflight() -> dict:
    billing_required = bool(settings.BILLING_ENABLED or settings.SUBSCRIPTION_REQUIRED)
    if not billing_required:
        return {
            "id": "stripe_config",
            "level": "warn",
            "message": "Stripe non requis (billing désactivé).",
            "details": {"billing_required": False},
        }
    missing = []
    if not _has_value(settings.STRIPE_SECRET_KEY):
        missing.append("STRIPE_SECRET_KEY")
    success_url = (settings.STRIPE_SUCCESS_URL or "").strip()
    cancel_url = (settings.STRIPE_CANCEL_URL or "").strip()
    success_https = False
    cancel_https = False
    if success_url:
        parsed = urlparse(success_url)
        success_https = parsed.scheme == "https" and bool(parsed.netloc)
    else:
        missing.append("STRIPE_SUCCESS_URL")
    if cancel_url:
        parsed = urlparse(cancel_url)
        cancel_https = parsed.scheme == "https" and bool(parsed.netloc)
    else:
        missing.append("STRIPE_CANCEL_URL")
    details = {
        "billing_required": True,
        "secret_present": _has_value(settings.STRIPE_SECRET_KEY),
        "success_url_https": success_https,
        "cancel_url_https": cancel_https,
    }
    if missing or not (success_https and cancel_https):
        return {
            "id": "stripe_config",
            "level": "fail",
            "message": "Configuration Stripe incomplète ou URLs invalides.",
            "details": {**details, "missing": missing},
        }
    return {
        "id": "stripe_config",
        "level": "ok",
        "message": "Stripe configuré.",
        "details": details,
    }


def _check_storage_preflight() -> dict:
    env_is_prod = _is_prod_env_check()
    provider = storage_provider()
    bucket = (settings.STORAGE_BUCKET or settings.S3_BUCKET or "").strip() or None
    endpoint = (settings.S3_ENDPOINT or "").strip() or None
    ok, latency_ms, error = run_storage_diagnostic(prefix="diagnostic/")
    details = {
        "provider": provider,
        "bucket": bucket,
        "endpoint": endpoint,
        "latency_ms": latency_ms,
    }
    if env_is_prod and provider in {"local", "filesystem"}:
        details["local_root"] = _storage_local_root_value() or None
        if not settings.ALLOW_LOCAL_STORAGE_IN_PROD:
            return {
                "id": "storage",
                "level": "fail",
                "message": "STORAGE_PROVIDER=local interdit en prod/staging.",
                "details": details,
                "recommendation": "Configurer STORAGE_PROVIDER=s3 et un bucket valide.",
            }
        try:
            _validate_local_storage_root()
        except Exception:
            return {
                "id": "storage",
                "level": "fail",
                "message": "Le stockage local persistant n’est pas correctement configuré.",
                "details": details,
                "recommendation": "Monter un volume persistant partagé ou basculer vers S3/MinIO.",
            }
        return {
            "id": "storage",
            "level": "warn",
            "message": "Stockage local persistant autorisé, mais S3/MinIO reste recommandé.",
            "details": details,
            "recommendation": "Préparer /opt/facturation/env/storage.env puis lancer ops/storage_migrate.py avant la bascule.",
        }
    if ok:
        return {
            "id": "storage",
            "level": "ok",
            "message": "Stockage accessible.",
            "details": details,
        }
    return {
        "id": "storage",
        "level": "fail" if env_is_prod else "warn",
        "message": "Diagnostic stockage en échec.",
        "details": {**details, "error": error},
        "recommendation": "Vérifier les credentials/endpoint/bucket S3.",
    }


def _check_redis_preflight(jobs_diagnostic: dict) -> dict:
    env_is_prod = _is_prod_env_check()
    required = bool(jobs_diagnostic.get("required"))
    redis_ok = bool(jobs_diagnostic.get("redis_ok"))
    redis_url = (settings.REDIS_URL or "").strip()
    details = {
        "required": required,
        "redis_url_present": bool(redis_url),
        "redis_ok": redis_ok,
        "mode": jobs_diagnostic.get("mode"),
    }
    if not redis_url:
        level = "fail" if required or env_is_prod else "warn"
        return {
            "id": "redis",
            "level": level,
            "message": "REDIS_URL manquant.",
            "details": details,
            "recommendation": "Définir REDIS_URL pour activer les files et la limitation.",
        }
    if not redis_ok:
        level = "fail" if required else "warn"
        return {
            "id": "redis",
            "level": level,
            "message": "Connexion Redis impossible.",
            "details": details,
            "recommendation": "Vérifier REDIS_URL et l'accès réseau.",
        }
    return {
        "id": "redis",
        "level": "ok",
        "message": "Redis accessible.",
        "details": details,
    }


def _check_workers_preflight(jobs_diagnostic: dict) -> dict:
    required = bool(jobs_diagnostic.get("required"))
    workers_count = int(jobs_diagnostic.get("workers_count") or 0)
    details = {
        "required": required,
        "workers_count": workers_count,
        "mode": jobs_diagnostic.get("mode"),
        "queues": jobs_diagnostic.get("queues"),
    }
    if required and workers_count == 0:
        return {
            "id": "workers",
            "level": "fail",
            "message": "Aucun worker RQ détecté.",
            "details": details,
            "recommendation": "Démarrer au moins un worker RQ (rq worker).",
        }
    if not required:
        return {
            "id": "workers",
            "level": "ok",
            "message": "Workers non requis pour cet environnement.",
            "details": details,
        }
    return {
        "id": "workers",
        "level": "ok",
        "message": "Workers RQ actifs.",
        "details": details,
    }


def _parse_periodic_modes(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _format_periodic_action(mode: str) -> str:
    if mode == "retention":
        return "scheduler (mode retention)"
    if mode == "einvoicing_sync":
        return "einvoicing-sync (mode einvoicing_sync)"
    return f"scheduler (mode {mode})"


def _collect_periodic_jobs_diagnostic() -> dict:
    env_is_prod = _is_prod_env_check()
    required_modes = _parse_periodic_modes(settings.PERIODIC_JOBS_REQUIRED_MODES)
    required = env_is_prod and bool(required_modes)
    now = datetime.now(timezone.utc)
    modes_payload = []
    overall = "ok"
    stale_modes: list[str] = []
    for mode in required_modes:
        heartbeat_at = get_periodic_heartbeat(mode)
        ttl_seconds = expected_heartbeat_ttl_seconds(mode)
        age_seconds = None
        if heartbeat_at:
            age_seconds = int((now - heartbeat_at).total_seconds())
        stale = heartbeat_at is None or (age_seconds is not None and age_seconds > ttl_seconds)
        if stale:
            stale_modes.append(mode)
            if required:
                overall = "error"
            elif overall == "ok":
                overall = "warn"
        modes_payload.append(
            {
                "mode": mode,
                "heartbeat_present": heartbeat_at is not None,
                "last_heartbeat_at": heartbeat_at.isoformat() if heartbeat_at else None,
                "age_seconds": age_seconds,
                "expected_ttl_seconds": ttl_seconds,
                "stale": stale,
            }
        )
    message = None
    if required and stale_modes:
        formatted = " et ".join(_format_periodic_action(mode) for mode in stale_modes)
        message = f"Démarrer le service {formatted}."
    elif not required:
        message = "Boucles périodiques non requises pour cet environnement."
    return {
        "status": overall,
        "required": required,
        "required_modes": required_modes,
        "modes": modes_payload,
        "message": message,
    }


def _check_periodic_jobs_preflight(periodic_diag: dict) -> dict:
    required = bool(periodic_diag.get("required"))
    status = (periodic_diag.get("status") or "ok").lower()
    if required and status == "error":
        level = "fail"
        message = periodic_diag.get("message") or "Boucles périodiques absentes."
    elif status == "warn":
        level = "warn"
        message = periodic_diag.get("message") or "Boucles périodiques à vérifier."
    else:
        level = "ok"
        message = periodic_diag.get("message") or "Boucles périodiques actives."
    return {
        "id": "periodic_jobs",
        "level": level,
        "message": message,
        "details": {
            "required": periodic_diag.get("required"),
            "required_modes": periodic_diag.get("required_modes"),
            "modes": periodic_diag.get("modes"),
        },
    }


def _check_jobs_deployment(jobs_diagnostic: dict) -> dict:
    required = bool(jobs_diagnostic.get("required"))
    workers_count = int(jobs_diagnostic.get("workers_count") or 0)
    status = "ok"
    message = "Workers RQ actifs."
    if required and workers_count == 0:
        status = "error"
        message = "Aucun worker RQ détecté."
    elif not required:
        message = "Workers non requis pour cet environnement."
    return {
        "status": status,
        "required": required,
        "workers_count": workers_count,
        "queues": jobs_diagnostic.get("queues"),
        "mode": jobs_diagnostic.get("mode"),
        "message": message,
    }


def _check_compliance_claims() -> dict:
    env_is_prod = _is_prod_env_check()
    claims = build_compliance_claims()
    allowed = claims.get("allowed_claims") or []
    configured = (settings.NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL or "export_only").strip().lower() or "export_only"
    details = {
        "configured_level": configured,
        "allowed_claims": allowed,
        "pdp_integration_enabled": claims.get("pdp_integration_enabled"),
        "seqino_enabled": claims.get("seqino_enabled"),
        "chorus_enabled": claims.get("chorus_enabled"),
        "mandate_required": claims.get("mandate_required"),
    }
    if configured not in allowed:
        level = "fail" if env_is_prod else "warn"
        return {
            "id": "compliance_claims",
            "level": level,
            "message": "Claim compliance non autorisé par le backend.",
            "details": details,
            "recommendation": (
                "Ajuster NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL "
                "ou activer un connecteur plateforme agréée."
            ),
        }
    return {
        "id": "compliance_claims",
        "level": "ok",
        "message": "Claim compliance cohérent avec le backend.",
        "details": details,
    }


def _summarize_preflight(checks: list[dict]) -> str:
    overall = "ok"
    for check in checks:
        level = (check.get("level") or "ok").lower()
        if level == "fail":
            return "fail"
        if level == "warn" and overall == "ok":
            overall = "warn"
    return overall


def _summarize_issues(default_message: str, details: dict, issues: list[tuple[str, str, str | None]]) -> dict:
    if not issues:
        return {
            "status": "ok",
            "message": default_message,
            "details": details,
        }
    status = "ok"
    messages: list[str] = []
    recommendation: str | None = None
    for level, message, recommendation_hint in issues:
        status = _bump_level(status, level)
        messages.append(message)
        if recommendation is None and recommendation_hint:
            recommendation = recommendation_hint
    payload = {
        "status": status,
        "message": " ".join(messages),
        "details": details,
    }
    if recommendation:
        payload["recommendation"] = recommendation
    return payload


def _summarize_readiness(checks: list[dict]) -> str:
    overall = "ok"
    for check in checks:
        status = (check.get("status") or "ok").lower()
        if status == "fail":
            return "fail"
        if status == "warn" and overall == "ok":
            overall = "warn"
    return overall


def _check_smtp_readiness() -> dict:
    verification_required = bool(getattr(settings, "REQUIRE_EMAIL_VERIFICATION", False))
    smtp_enabled = bool(settings.SMTP_ENABLED)
    host_present = _has_value(settings.SMTP_HOST)
    port_present = bool(settings.SMTP_PORT)
    details = {
        "smtp_enabled": smtp_enabled,
        "host_present": host_present,
        "port_present": port_present,
        "verification_required": verification_required,
    }
    issues: list[tuple[str, str, str | None]] = []
    if not smtp_enabled:
        level = "fail" if verification_required else "warn"
        issues.append(
            (
                level,
                "SMTP désactivé.",
                "Activer SMTP (SMTP_ENABLED=true) pour l'envoi des emails.",
            )
        )
    elif not host_present or not port_present:
        issues.append(
            (
                "fail",
                "Configuration SMTP incomplète.",
                "Renseigner SMTP_HOST/SMTP_PORT.",
            )
        )
    return _summarize_issues("SMTP opérationnel.", details, issues)


def _check_storage_readiness() -> dict:
    env_is_prod = _is_prod_env_check()
    provider = storage_provider()
    ok, latency_ms, _ = run_storage_diagnostic(prefix="diagnostic/")
    lock_report = object_lock_status()
    lock_payload = {
        "enabled": lock_report.get("enabled"),
        "ok": lock_report.get("ok"),
        "mode": lock_report.get("mode"),
        "retention_days": lock_report.get("retention_days"),
        "bucket_default_mode": lock_report.get("bucket_default_mode"),
        "bucket_default_retention_days": lock_report.get("bucket_default_retention_days"),
    }
    details = {
        "provider": provider,
        "access_ok": ok,
        "latency_ms": latency_ms,
        "kms_enabled": bool(settings.S3_KMS_KEY_ID),
        "object_lock": lock_payload,
    }
    issues: list[tuple[str, str, str | None]] = []
    if provider in {"local", "filesystem"}:
        details["local_root"] = _storage_local_root_value() or None
        if env_is_prod and not settings.ALLOW_LOCAL_STORAGE_IN_PROD:
            issues.append(
                (
                    "fail",
                    "Stockage local non autorisé en prod/staging.",
                    "Configurer STORAGE_PROVIDER=s3 ou minio pour la prod.",
                )
            )
        else:
            try:
                _validate_local_storage_root()
            except Exception:
                issues.append(
                    (
                        "fail" if env_is_prod else "warn",
                        "Le stockage local persistant n’est pas correctement configuré.",
                        "Monter un volume persistant partagé.",
                    )
                )
            else:
                issues.append(
                    (
                        "warn",
                        "Stockage local persistant configuré.",
                        "Préférer S3/MinIO + Object Lock avant ouverture publique.",
                    )
                )
    if not ok:
        issues.append(
            (
                "fail" if env_is_prod else "warn",
                "Accès au stockage indisponible.",
                "Vérifier les credentials/bucket/endpoint S3.",
            )
        )
    if provider in {"s3", "minio"}:
        if not lock_report.get("enabled"):
            issues.append(
                (
                    "warn",
                    "Object lock désactivé.",
                    "Activer l'object lock pour l'immutabilité des pièces.",
                )
            )
        elif lock_report.get("ok") is False:
            issues.append(
                (
                    "fail" if env_is_prod else "warn",
                    "Object lock actif mais non opérationnel.",
                    "Vérifier la configuration object lock du bucket.",
                )
            )
        if not settings.S3_KMS_KEY_ID:
            issues.append(
                (
                    "warn",
                    "Chiffrement KMS non configuré.",
                    "Renseigner S3_KMS_KEY_ID pour activer le chiffrement côté serveur.",
                )
            )
    return _summarize_issues("Stockage configuré.", details, issues)


async def _check_seqino_readiness() -> dict:
    required = bool(settings.REQUIRE_SEQINO_IN_PROD)
    enabled = bool(settings.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION)
    rollout_configured = bool(parse_connected_mode_allowed_tenant_ids())
    configured = _has_value(settings.SEQINO_BASE_URL) and _has_value(
        settings.SEQINO_API_KEY or settings.SEQINO_ACCESS_TOKEN
    ) and _has_value(settings.SEQINO_SPONSOR_ID)
    details = {
        "required": required,
        "enabled": enabled,
        "configured": configured,
        "rollout_configured": rollout_configured,
        "ping_ok": None,
    }
    issues: list[tuple[str, str, str | None]] = []
    if not configured:
        issues.append(
            (
                "fail" if required else "warn",
                "Configuration plateforme partenaire incomplète.",
                "Renseigner les identifiants plateforme partenaire requis (base URL, sponsor, clé).",
            )
        )
        return _summarize_issues("Plateforme partenaire configurée.", details, issues)
    if settings.EINVOICING_EXPORT_ONLY or not rollout_configured:
        issues.append(
            (
                "warn",
                "Ping plateforme partenaire ignoré tant que le rollout connecté est fermé.",
                "Configurer un tenant pilote exact puis désactiver le mode export-only avant la vérification distante.",
            )
        )
        return _summarize_issues("Plateforme partenaire configurée.", details, issues)
    ping_ok = False
    latency_ms = None
    try:
        result = await asyncio.wait_for(SeqinoClient.from_settings().ping(), timeout=2.5)
        ping_ok = bool(result.get("ok"))
        latency_ms = result.get("latency_ms")
    except asyncio.TimeoutError:
        ping_ok = False
    except Exception:
        ping_ok = False
    details["ping_ok"] = ping_ok
    if latency_ms is not None:
        details["latency_ms"] = latency_ms
    if not ping_ok:
        issues.append(
            (
                "fail" if required else "warn",
                "Ping plateforme partenaire en échec.",
                "Vérifier l'accès réseau plateforme partenaire et la clé API.",
            )
        )
    return _summarize_issues("Plateforme partenaire opérationnelle.", details, issues)


def _check_auth_readiness() -> dict:
    cookie_mode = auth_cookie_mode_enabled()
    cookie_domain = (settings.COOKIE_DOMAIN or "").strip() or None
    public_host = _normalize_host(settings.PUBLIC_BASE_URL) if _has_value(settings.PUBLIC_BASE_URL) else None
    cookie_domain_valid = _cookie_domain_allows_host(public_host, cookie_domain)
    origins = [o.strip() for o in (settings.CORS_ORIGINS or "").split(",") if o.strip()]
    sanitized_origins = [_sanitize_origin(o) for o in origins]
    cors_has_wildcard = "*" in origins
    details = {
        "auth_cookie_mode": cookie_mode,
        "cookie_domain_present": bool(cookie_domain),
        "cookie_domain_valid": cookie_domain_valid,
        "cors_origins_count": len(sanitized_origins),
        "cors_origins": sanitized_origins,
        "cors_has_wildcard": cors_has_wildcard,
    }
    issues: list[tuple[str, str, str | None]] = []
    if cookie_mode:
        if not origins:
            issues.append(
                (
                    "fail",
                    "CORS_ORIGINS manquant.",
                    "Configurer CORS_ORIGINS avec l'origine front.",
                )
            )
        if cors_has_wildcard:
            issues.append(
                (
                    "fail",
                    "CORS_ORIGINS contient un wildcard.",
                    "Remplacer * par l'origine exacte du front.",
                )
            )
        if not cookie_domain_valid:
            issues.append(
                (
                    "warn",
                    "COOKIE_DOMAIN ne correspond pas au domaine public.",
                    "Ajuster COOKIE_DOMAIN pour le domaine public.",
                )
            )
    default_message = "Mode cookie actif." if cookie_mode else "Mode cookie désactivé."
    return _summarize_issues(default_message, details, issues)


@router.get("/config")
def diagnostic_config(response: Response):
    response.headers["X-CSRF-Required"] = "true" if auth_cookie_mode_enabled() else "false"
    origins = [o.strip() for o in (settings.CORS_ORIGINS or "").split(",") if o.strip()]
    sanitized_origins = [_sanitize_origin(o) for o in origins]
    return {
        "app_env": (settings.APP_ENV or "").strip() or None,
        "public_base_url": (settings.PUBLIC_BASE_URL or "").strip() or None,
        "frontend_base_url": (settings.FRONTEND_BASE_URL or "").strip() or None,
        "cookie_domain": (settings.COOKIE_DOMAIN or "").strip() or None,
        "cookie_secure": settings.COOKIE_SECURE,
        "cookie_samesite": (settings.COOKIE_SAMESITE or "").strip() or None,
        "allow_credentials": True,
        "cors_origins": sanitized_origins,
        "facturx_spec_version": settings.FACTURX_SPEC_VERSION,
        "invoice_sanity_checks_version": get_invoice_sanity_checks_version(),
    }


@router.get("/smtp")
def diagnostic_smtp():
    return smtp_diagnostic_payload()


@router.get("/storage")
def diagnostic_storage():
    return _check_storage()


@router.get("/stripe")
def diagnostic_stripe():
    return _check_stripe()


@router.get("/preflight")
def diagnostic_preflight():
    jobs_diagnostic = collect_jobs_diagnostic()
    periodic_diag = _collect_periodic_jobs_diagnostic()
    checks = [
        _check_env_sanity(),
        _check_base_urls(),
        _check_cookie_secure(),
        _check_cors(),
        _check_redis_preflight(jobs_diagnostic),
        _check_workers_preflight(jobs_diagnostic),
        _check_periodic_jobs_preflight(periodic_diag),
        _check_storage_preflight(),
        _check_smtp_preflight(),
        _check_stripe_preflight(),
        _check_compliance_claims(),
        _check_secret_key(),
        _check_seqino(),
    ]
    return {
        "status": _summarize_preflight(checks),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
    }


@router.get("/jobs")
def diagnostic_jobs():
    return collect_jobs_diagnostic()


@router.get("/deployment")
def diagnostic_deployment(db: Session = Depends(get_db)):
    jobs_diagnostic = collect_jobs_diagnostic()
    periodic_diag = _collect_periodic_jobs_diagnostic()
    checks = {
        "db": _check_db(db),
        "redis": _check_redis(),
        "storage": _check_storage(),
        "smtp": _check_smtp_deployment(),
        "stripe": _check_stripe(),
        "pdfa": _check_pdfa(),
        "jobs": _check_jobs_deployment(jobs_diagnostic),
        "periodic_jobs": periodic_diag,
    }
    statuses = [c.get("status") for c in checks.values()]
    if "error" in statuses:
        overall = "error"
    elif "warn" in statuses or "warning" in statuses:
        overall = "warn"
    else:
        overall = "ok"
    return {
        "status": overall,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
    }


@router.get("/readiness", dependencies=[Depends(require_platform_admin)])
async def diagnostic_readiness():
    smtp_check = _check_smtp_readiness()
    storage_check = _check_storage_readiness()
    seqino_check = await _check_seqino_readiness()
    auth_check = _check_auth_readiness()
    checks = {
        "smtp": smtp_check,
        "storage": storage_check,
        "seqino": seqino_check,
        "auth": auth_check,
    }
    overall = _summarize_readiness(list(checks.values()))
    return {
        "status": overall,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
    }


class TestEmailRequest(BaseModel):
    to: EmailStr | None = None
    subject: str | None = None


@router.post("/test-email")
def send_test_email(
    payload: TestEmailRequest | None = None,
    user: AuthUser = Depends(require_internal_user),
):
    """Send a real email to validate SMTP wiring and deliverability."""
    assert_smtp_ready_or_raise(action="test_email")
    to = (payload.to if payload else None) or user.email
    subject = (payload.subject if payload else None) or "Test email (diagnostic)"
    send_email(
        to=to,
        subject=subject,
        text=(
            "Ceci est un email de test envoyé depuis l'endpoint /api/diagnostic/test-email.\n"
            f"Tenant: {user.tenant_id}\n"
            f"Envoyé le: {datetime.now(timezone.utc).replace(tzinfo=None).isoformat()}Z\n"
        ),
    )
    return {"ok": True, "to": to}


@router.post("/test-job")
def enqueue_test_job(
    user: AuthUser = Depends(require_internal_user),
):
    """Enqueue a tiny job to validate worker/queue wiring."""
    try:
        job_info = enqueue_job(
            ping_job,
            tenant_id=user.tenant_id,
            requested_by=user.id,
            meta={"tenant_id": user.tenant_id, "job": "diagnostic_ping"},
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "job_enqueue_failed",
                "message": "Le test n’a pas pu être lancé. Réessayez dans quelques instants.",
            },
        ) from exc
    status = job_info.get("status")
    result = job_info.get("result")
    return {"ok": True, "job_id": job_info.get("job_id"), "status": status, "result": result}
