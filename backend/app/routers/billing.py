from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
from time import time
import json
import logging
import re
from typing import Any, cast

import stripe
from sqlalchemy.exc import IntegrityError, OperationalError

from ..config import settings, enforce_stripe_signature, _clean_stripe_config_value
from ..core.plans import Plan
from ..db import get_db
from ..deps import require_subscription_active, require_tenant_admin, AuthUser, require_product_feature
from ..models import (
    ActionLog,
    Invoice,
    Payment,
    ProviderTokenAllocation,
    ProviderTokenInventory,
    ProviderTokenLedgerEvent,
    ProviderTokenReservation,
    StripeEvent,
    Tenant,
    TokenLedger,
    TokenTopup,
    TokenWallet,
)
from ..services.action_logs import safe_log_action
from ..services.legal_acceptance import accepted_rows_for_user, required_docs_for_ui
from ..services.invoices.amounts import invoice_balance_due_amount
from ..services.product_capabilities import build_product_capabilities
from ..services.stripe_mode import livemode_validation_reason, read_attr
from ..services.stripe_runtime import (
    get_stripe_runtime_status,
    stripe_checkout_error_is_definite,
)
from ..services.subscription_entitlements import grant_subscription_entitlements
from ..services.commercial_catalog import SUBSCRIPTION_PLAN_PRICES_CENTS, subscription_plan_copy
from ..services.token_packs import expected_token_pack_amount, token_pack_price_validation_reason
from ..services.tokens import credit_from_stripe_session
from ..services.provider_token_inventory import (
    CHECKOUT_RESERVATION_TTL_SECONDS,
    CHECKOUT_SESSION_TTL_SECONDS,
    InsufficientProviderTokens,
    ProviderTokenInventoryError,
    ProviderTokenReservationLimitExceeded,
    ProviderTokenReservationStateError,
    bind_reservation_to_stripe_checkout,
    finalize_reservation,
    get_inventory_status,
    release_allocation_tokens,
    release_reservation,
    reserve_tokens,
)
from ..services.stripe_customers import sync_stripe_customer_for_tenant

router = APIRouter(prefix="/api/billing", tags=["billing"])
logger = logging.getLogger("billing.plans")
_STRIPE_ERRORS: Any = getattr(stripe, "error", None)

_PLANS_CACHE_TTL_SECONDS = 600
_PLANS_CACHE: dict[str, Any] = {"ts": 0.0, "payload": None, "key": None}
_PROD_ENVS = {"prod", "production", "staging"}
_FALLBACK_PRICES_CENTS = SUBSCRIPTION_PLAN_PRICES_CENTS


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _require_tenant(tenant: Tenant | None, tenant_id: str) -> Tenant:
    if tenant is None:
        raise HTTPException(404, "Entreprise introuvable.")
    return tenant


def _is_non_prod_env() -> bool:
    return (settings.APP_ENV or "").strip().lower() not in _PROD_ENVS


def _professional_profile_is_complete(tenant: Tenant) -> bool:
    enforce_in_disposable_test = (
        (settings.APP_ENV or "").strip().lower() == "test"
        and bool(getattr(settings, "BILLING_PROFILE_TEST_MODE", False))
    )
    if _is_non_prod_env() and not enforce_in_disposable_test:
        return True
    if not tenant.professional_use_confirmed_at or not tenant.professional_use_confirmed_by:
        return False
    country = (tenant.country_code or tenant.country or "FR").strip().upper()
    siret_digits = re.sub(r"\D", "", tenant.siret or "")
    rcs_digits = re.sub(r"\D", "", tenant.rcs or "")
    vat_number = re.sub(r"[\s.\-]", "", tenant.vat_number or "").upper()
    if country == "FR":
        return len(siret_digits) in {9, 14} or len(rcs_digits) in {9, 14}
    return bool(siret_digits or rcs_digits or vat_number)


def _plans_cache_key(
    *, billing_enabled: bool, stripe_secret: str, price_ids: dict[str, str | None]
) -> tuple[object, ...]:
    return (
        bool(billing_enabled),
        bool(stripe_secret),
        bool(_subscription_redirect_urls_configured()),
        tuple(sorted((key, value or "") for key, value in price_ids.items())),
    )


def _get_plans_cache(cache_key: tuple[object, ...]):
    ts = _PLANS_CACHE.get("ts") or 0.0
    payload = _PLANS_CACHE.get("payload")
    key = _PLANS_CACHE.get("key")
    if payload and key == cache_key and (time() - float(ts)) < _PLANS_CACHE_TTL_SECONDS:
        return payload
    return None


def _set_plans_cache(cache_key: tuple[object, ...], payload: object) -> None:
    _PLANS_CACHE["ts"] = time()
    _PLANS_CACHE["key"] = cache_key
    _PLANS_CACHE["payload"] = payload


def _stripe():
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(400, "Stripe non configuré")
    stripe.api_key = settings.STRIPE_SECRET_KEY
    stripe.api_base = (settings.STRIPE_API_BASE or "https://api.stripe.com").strip().rstrip("/")
    return stripe


def _stripe_mode(secret: str | None) -> str | None:
    key = (secret or "").strip()
    if not key:
        return None
    if key.startswith("sk_live_"):
        return "live"
    if key.startswith("sk_test_"):
        return "test"
    if key.startswith("stripe_live_"):
        return "live"
    if key.startswith("stripe_test_"):
        return "test"
    return None


def _stripe_price_ids() -> tuple[dict[str, str | None], list[str]]:
    price_ids = settings.stripe_subscription_prices()
    missing = settings.missing_stripe_subscription_prices()
    return price_ids, missing


def _stripe_redirect_urls() -> tuple[str, str]:
    success_url = (settings.STRIPE_SUCCESS_URL or "").strip()
    cancel_url = (settings.STRIPE_CANCEL_URL or "").strip()
    if not success_url or not cancel_url:
        raise HTTPException(
            status_code=500,
            detail={
                "code": "stripe_redirect_url_missing",
                "message": "STRIPE_SUCCESS_URL et STRIPE_CANCEL_URL doivent être configurés.",
            },
        )
    return success_url, cancel_url


def _stripe_return_url() -> str:
    return_url = (settings.STRIPE_CUSTOMER_PORTAL_RETURN_URL or settings.STRIPE_SUCCESS_URL or "").strip()
    if not return_url:
        raise HTTPException(
            status_code=500,
            detail={
                "code": "stripe_redirect_url_missing",
                "message": "STRIPE_CUSTOMER_PORTAL_RETURN_URL ou STRIPE_SUCCESS_URL doit être configuré.",
            },
        )
    return return_url


def _normalize_billing_period(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    if normalized in {"monthly", "month"}:
        return "monthly"
    if normalized in {"yearly", "annual", "year"}:
        return "yearly"
    raise HTTPException(400, "Période de facturation inconnue")


BLOCKING_STRIPE_SUBSCRIPTION_STATUSES = {
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "paused",
    "pending",
    "incomplete",
}


def _has_existing_stripe_subscription(tenant: Tenant) -> bool:
    status = (tenant.subscription_status or "").strip().lower()
    return bool(tenant.stripe_subscription_id and status in BLOCKING_STRIPE_SUBSCRIPTION_STATUSES)


def _claim_subscription_checkout(
    db: Session,
    *,
    tenant_id: str,
    request_key: str,
    plan: str,
    period: str,
) -> Tenant:
    """Claim one durable Checkout lease per tenant before calling Stripe."""

    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).with_for_update().one_or_none()
    tenant = _require_tenant(tenant, tenant_id)
    if _has_existing_stripe_subscription(tenant):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "subscription_already_active",
                "message": (
                    "Un abonnement est déjà actif ou en cours d'activation pour ce compte. "
                    "Contactez-nous pour changer de formule sans créer un second abonnement."
                ),
                "cta": "/contact",
                "remediation_url": "/contact",
            },
        )
    now = _utcnow()
    pending_until = tenant.stripe_checkout_pending_until
    lease_active = bool(pending_until and pending_until > now)
    current_key = str(tenant.stripe_checkout_request_key or "").strip()
    if lease_active and current_key and current_key != request_key:
        if (
            str(tenant.stripe_checkout_plan or "").strip() == plan
            and str(tenant.stripe_checkout_period or "").strip() == period
        ):
            # A browser refresh generates a new UUID. Preserve the original
            # Stripe idempotency key and let the retry retrieve/create the very
            # same Checkout instead of blocking the customer for the lease TTL.
            return tenant
        raise HTTPException(
            status_code=409,
            detail={
                "code": "checkout_already_in_progress",
                "message": (
                    "Un paiement d'abonnement est déjà ouvert pour cette entreprise. "
                    "Terminez-le ou contactez l'assistance s'il n'est plus accessible."
                ),
                "contact_url": "/contact",
            },
        )
    tenant.stripe_checkout_request_key = request_key
    tenant.stripe_checkout_pending_until = now + timedelta(seconds=CHECKOUT_RESERVATION_TTL_SECONDS)
    tenant.stripe_checkout_plan = plan
    tenant.stripe_checkout_period = period
    if not lease_active:
        tenant.stripe_checkout_session_id = None
    db.add(tenant)
    db.commit()
    return tenant


def _record_subscription_checkout_session(
    db: Session,
    *,
    tenant_id: str,
    request_key: str,
    session_id: str,
) -> None:
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).with_for_update().one_or_none()
    if tenant is None or tenant.stripe_checkout_request_key != request_key:
        raise RuntimeError("Le verrou du paiement d'abonnement a changé.")
    existing_session = str(tenant.stripe_checkout_session_id or "").strip()
    if existing_session and existing_session != session_id:
        raise RuntimeError("Le paiement d'abonnement est déjà lié à une autre session.")
    tenant.stripe_checkout_session_id = session_id
    db.add(tenant)
    db.commit()


def _clear_subscription_checkout(
    db: Session,
    *,
    tenant_id: str,
    session_id: str | None = None,
) -> bool:
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).with_for_update().one_or_none()
    if tenant is None:
        return False
    current_session = str(tenant.stripe_checkout_session_id or "").strip()
    incoming_session = str(session_id or "").strip()
    if current_session and incoming_session and current_session != incoming_session:
        return False
    tenant.stripe_checkout_session_id = None
    tenant.stripe_checkout_request_key = None
    tenant.stripe_checkout_pending_until = None
    tenant.stripe_checkout_plan = None
    tenant.stripe_checkout_period = None
    db.add(tenant)
    db.flush()
    return True


_TERMINAL_LOCAL_SUBSCRIPTION_STATUSES = {
    "canceled",
    "cancelled",
    "inactive",
    "incomplete_expired",
}


def _strict_subscription_tenant(
    db: Session,
    *,
    subscription_id: str | None,
    customer_id: str | None,
    metadata_tenant_id: str | None,
) -> Tenant | None:
    """Resolve Stripe subscription ownership without customer-only reassignment."""

    sub_id = str(subscription_id or "").strip()
    cust_id = str(customer_id or "").strip()
    meta_tenant_id = str(metadata_tenant_id or "").strip()
    exact = db.query(Tenant).filter(Tenant.stripe_subscription_id == sub_id).first() if sub_id else None
    if exact is not None:
        if meta_tenant_id and str(exact.id) != meta_tenant_id:
            return None
        existing_customer = str(exact.stripe_customer_id or "").strip()
        if cust_id and existing_customer and existing_customer != cust_id:
            return None
        return exact
    if not meta_tenant_id:
        return None
    candidate = db.get(Tenant, meta_tenant_id)
    if candidate is None:
        return None
    existing_customer = str(candidate.stripe_customer_id or "").strip()
    if cust_id and existing_customer and existing_customer != cust_id:
        return None
    current_subscription = str(candidate.stripe_subscription_id or "").strip()
    current_status = str(candidate.subscription_status or "").strip().lower()
    if (
        sub_id
        and current_subscription
        and current_subscription != sub_id
        and current_status not in _TERMINAL_LOCAL_SUBSCRIPTION_STATUSES
    ):
        return None
    return candidate


def _stripe_collection_data(value: object) -> list[Any]:
    data = read_attr(value, "data") or []
    return list(data) if isinstance(data, (list, tuple)) else []


def _preflight_remote_subscription_checkout(
    stripe_client: Any,
    *,
    tenant: Tenant,
    selected_plan: Plan,
    period: str,
    welcome_reservation_id: str | None,
) -> Any | None:
    """Fail closed on unmapped subscriptions or open remote Checkouts."""

    customer_id = str(tenant.stripe_customer_id or "").strip()
    if not customer_id:
        raise HTTPException(
            503,
            detail={
                "code": "stripe_customer_reconciliation_pending",
                "message": "Le compte de paiement est en attente de rapprochement.",
            },
        )
    try:
        subscriptions = stripe_client.Subscription.list(
            customer=customer_id,
            status="all",
            limit=10,
        )
        checkout_sessions = stripe_client.checkout.Session.list(
            customer=customer_id,
            status="open",
            limit=10,
        )
    except Exception as exc:
        raise HTTPException(
            503,
            detail={
                "code": "stripe_subscription_preflight_unavailable",
                "message": "La vérification du paiement est temporairement indisponible.",
            },
        ) from exc

    for subscription in _stripe_collection_data(subscriptions):
        remote_status = str(read_attr(subscription, "status") or "").strip().lower()
        if remote_status not in BLOCKING_STRIPE_SUBSCRIPTION_STATUSES:
            continue
        remote_id = str(read_attr(subscription, "id") or "").strip()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "remote_subscription_reconciliation_required",
                "message": (
                    "Un abonnement existe déjà chez le prestataire de paiement. "
                    "Contactez l'assistance avant toute nouvelle souscription."
                ),
                "contact_url": "/contact",
                "matched_local_subscription": bool(
                    remote_id and remote_id == str(tenant.stripe_subscription_id or "").strip()
                ),
            },
        )

    matches: list[Any] = []
    for session in _stripe_collection_data(checkout_sessions):
        if str(read_attr(session, "mode") or "").strip().lower() != "subscription":
            continue
        if livemode_validation_reason(session, settings.STRIPE_SECRET_KEY):
            raise HTTPException(
                409,
                detail={
                    "code": "stripe_livemode_mismatch",
                    "message": "Mode Stripe incompatible avec la configuration.",
                },
            )
        metadata = read_attr(session, "metadata") or {}
        if str(read_attr(metadata, "tenant_id") or "").strip() != str(tenant.id):
            raise HTTPException(
                409,
                detail={
                    "code": "remote_checkout_reconciliation_required",
                    "message": "Un paiement ouvert doit être rapproché par l'assistance.",
                    "contact_url": "/contact",
                },
            )
        if (
            str(read_attr(metadata, "plan") or "").strip().lower() != selected_plan.value
            or str(read_attr(metadata, "billing_period") or "").strip().lower() != period
        ):
            raise HTTPException(
                409,
                detail={
                    "code": "checkout_already_in_progress",
                    "message": "Un paiement pour une autre formule est déjà ouvert.",
                    "contact_url": "/contact",
                },
            )
        remote_reservation_id = str(read_attr(metadata, "provider_welcome_reservation_id") or "").strip()
        if selected_plan == Plan.PRO and remote_reservation_id != str(welcome_reservation_id or "").strip():
            raise HTTPException(
                409,
                detail={
                    "code": "remote_checkout_stock_reconciliation_required",
                    "message": "Le paiement Pro est en attente de rapprochement du stock.",
                    "contact_url": "/contact",
                },
            )
        matches.append(session)
    if len(matches) > 1:
        raise HTTPException(
            409,
            detail={
                "code": "multiple_remote_checkouts_reconciliation_required",
                "message": "Plusieurs paiements ouverts doivent être rapprochés par l'assistance.",
                "contact_url": "/contact",
            },
        )
    return matches[0] if matches else None


def _checkout_idempotency_suffix(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        return "server"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _price_id_set(*values: str | None) -> set[str]:
    cleaned = set()
    for value in values:
        val = _clean_stripe_config_value(value)
        if val:
            cleaned.add(val)
    return cleaned


def _plan_from_price(price_id: str | None) -> Plan | None:
    if not price_id:
        return None
    if price_id in _price_id_set(
        settings.STRIPE_PRICE_STARTER,
        settings.STRIPE_PRICE_STARTER_MONTHLY,
        settings.STRIPE_PRICE_STARTER_YEARLY,
    ):
        return Plan.STARTER
    if price_id in _price_id_set(
        settings.STRIPE_PRICE_PRO,
        settings.STRIPE_PRICE_PRO_MONTHLY,
        settings.STRIPE_PRICE_PRO_YEARLY,
    ):
        return Plan.PRO
    if price_id == settings.STRIPE_PRICE_ENTERPRISE:
        return Plan.ENTERPRISE
    return None


def _safe_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _amount_display_from_cents(cents: int | None) -> str:
    if cents is None:
        return "0"
    amount = (Decimal(cents) / Decimal("100")).quantize(Decimal("0.01"))
    formatted = format(amount, "f")
    if "." in formatted:
        formatted = formatted.rstrip("0").rstrip(".")
    return formatted or "0"


def _plan_capabilities(plan: str) -> dict[str, object]:
    tenant = Tenant(plan=(plan or "").strip().lower() or "starter", subscription_status="active")
    capabilities = build_product_capabilities(tenant)
    einvoicing_available = bool(capabilities.get("einvoicing_available_by_plan"))
    chorus_available = bool(capabilities.get("chorus_available_by_plan"))
    seqino_available = bool(capabilities.get("seqino_available_by_plan"))
    token_topup_available = bool(capabilities.get("token_topup_available_by_plan"))
    purchases_available = bool(capabilities.get("purchases_available_by_plan"))
    payments_available = bool(capabilities.get("payments_available_by_plan"))
    return {
        "billing_enabled": bool(capabilities.get("billing_enabled")),
        "einvoicing_available_by_plan": einvoicing_available,
        "chorus_available_by_plan": chorus_available,
        "seqino_available_by_plan": seqino_available,
        "token_topup_available_by_plan": token_topup_available,
        "purchases_available_by_plan": purchases_available,
        "payments_available_by_plan": payments_available,
        "einvoicing_enabled": einvoicing_available,
        "chorus_enabled": chorus_available,
        "seqino_enabled": seqino_available,
        "token_topup_enabled": token_topup_available,
        "purchases_enabled": purchases_available,
        "payments_enabled": payments_available,
    }


def _read_attr(obj: object, key: str):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    getter = getattr(obj, "get", None)
    if callable(getter):
        try:
            return getter(key)
        except Exception:
            pass
    return getattr(obj, key, None)


def _log_stripe_price_error(price_id: str, error: Exception) -> None:
    payload = {
        "event": "stripe_price_retrieve_error",
        "price_id": price_id,
        "error_type": error.__class__.__name__,
        "error_code": getattr(error, "code", None),
        "app_env": (settings.APP_ENV or "").lower(),
    }
    try:
        logger.warning(json.dumps(payload))
    except Exception:
        pass


def _normalize_fallback_plan(plan: str, period: str, unit_amount: int) -> dict[str, object]:
    interval = "month" if period == "monthly" else "year"
    copy = subscription_plan_copy(plan, period)
    return {
        "plan": plan,
        "period": period,
        "display_name": copy.get("display_name") or plan.title(),
        "tagline": copy.get("tagline") or "",
        "description": copy.get("description") or "",
        "currency": "eur",
        "unit_amount": unit_amount,
        "unit_amount_decimal": str(unit_amount),
        "amount_display": _amount_display_from_cents(unit_amount),
        "interval": interval,
        "features": _plan_capabilities(plan),
        "pricing_source": "fallback",
    }


def _with_checkout_state(
    row: dict[str, object],
    *,
    price_configured: bool,
    checkout_enabled: bool,
    reason: str | None,
) -> dict[str, object]:
    row = dict(row)
    row["price_configured"] = price_configured
    row["checkout_enabled"] = checkout_enabled
    row["availability"] = "checkout" if checkout_enabled else _plan_availability(reason)
    row["reason"] = reason
    row["message"] = None if checkout_enabled else _plan_message(reason)
    return row


def _subscription_redirect_urls_configured() -> bool:
    return bool((settings.STRIPE_SUCCESS_URL or "").strip()) and bool((settings.STRIPE_CANCEL_URL or "").strip())


def _portal_return_url_configured() -> bool:
    return bool((settings.STRIPE_CUSTOMER_PORTAL_RETURN_URL or settings.STRIPE_SUCCESS_URL or "").strip())


def _portal_configuration_id() -> str:
    return _clean_stripe_config_value(getattr(settings, "STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID", None)) or ""


def _portal_configuration_id_configured() -> bool:
    return _portal_configuration_id().startswith("bpc_")


def _token_redirect_urls_configured() -> bool:
    success_url = (settings.STRIPE_TOKENS_SUCCESS_URL or settings.STRIPE_SUCCESS_URL or "").strip()
    cancel_url = (settings.STRIPE_TOKENS_CANCEL_URL or settings.STRIPE_CANCEL_URL or "").strip()
    return bool(success_url and cancel_url)


def _plan_availability(reason: str | None) -> str:
    if reason in {"billing_disabled", "stripe_not_configured", "price_not_configured", "stripe_redirect_url_missing"}:
        return "contact"
    return "unavailable"


def _plan_message(reason: str | None) -> str:
    if reason == "pro_welcome_stock_unavailable":
        return "La formule Pro est temporairement indisponible. La formule Starter reste accessible."
    if reason in {"billing_disabled", "stripe_not_configured"}:
        return "Souscription en ligne bientôt disponible."
    if reason in {"price_not_configured", "stripe_redirect_url_missing"}:
        return "La souscription en ligne n'est pas encore activée pour cette formule."
    if reason in {"price_amount_mismatch", "price_currency_mismatch", "price_interval_mismatch", "price_inactive"}:
        return "Le paiement de cette formule est temporairement indisponible. Contactez l'assistance."
    if reason in {
        "stripe_auth_failed",
        "stripe_permission_denied",
        "stripe_rate_limited",
        "stripe_unreachable",
        "stripe_invalid_request",
        "stripe_unavailable",
        "price_lookup_failed",
    }:
        return "Paiement temporairement indisponible."
    return "Paiement en ligne indisponible pour le moment."


def _apply_pro_welcome_stock_gate(
    rows: list[dict[str, object]],
    db: Session,
) -> list[dict[str, object]]:
    welcome_tokens = int(getattr(settings, "SEQINO_WELCOME_TOKENS_PRO", 0) or 0)
    if welcome_tokens <= 0:
        return [dict(row) for row in rows]
    status = get_inventory_status(db)
    stock_ready = status.invariant_valid and status.sellable_tokens >= welcome_tokens
    gated: list[dict[str, object]] = []
    for source in rows:
        row = dict(source)
        if row.get("plan") == Plan.PRO.value and row.get("checkout_enabled") is True and not stock_ready:
            row = _with_checkout_state(
                row,
                price_configured=bool(row.get("price_configured")),
                checkout_enabled=False,
                reason="pro_welcome_stock_unavailable",
            )
        gated.append(row)
    return gated


def _subscription_status_payload(
    *,
    billing_enabled: bool,
    stripe_runtime: dict[str, object],
    price_ids: dict[str, str | None],
    missing: list[str],
) -> dict[str, object]:
    stripe_ready = bool(stripe_runtime.get("ready"))
    reason = stripe_runtime.get("reason")
    redirects_ready = _subscription_redirect_urls_configured()
    configured_count = sum(1 for value in price_ids.values() if _clean_stripe_config_value(value))
    any_checkout = billing_enabled and stripe_ready and redirects_ready and configured_count > 0
    if not billing_enabled:
        return {
            "status": "disabled",
            "reason": "billing_disabled",
            "message": "Souscription en ligne bientôt disponible.",
            "checkout_enabled": False,
        }
    if not stripe_runtime.get("secret_configured"):
        return {
            "status": "contact",
            "reason": "stripe_not_configured",
            "message": "Souscription en ligne bientôt disponible.",
            "checkout_enabled": False,
        }
    if not stripe_ready:
        return {
            "status": "unavailable",
            "reason": reason or "stripe_unavailable",
            "message": "Paiement temporairement indisponible.",
            "checkout_enabled": False,
        }
    if not redirects_ready:
        return {
            "status": "contact",
            "reason": "stripe_redirect_url_missing",
            "message": "Souscription en ligne bientôt disponible.",
            "checkout_enabled": False,
        }
    if missing:
        return {
            "status": "partial",
            "reason": "subscription_prices_missing",
            "message": "Certaines formules ne sont pas encore disponibles à la souscription en ligne.",
            "checkout_enabled": any_checkout,
        }
    return {
        "status": "enabled",
        "reason": None,
        "message": "Souscription en ligne disponible.",
        "checkout_enabled": True,
    }


def _customer_portal_status_payload(*, stripe_runtime: dict[str, object]) -> dict[str, object]:
    stripe_ready = bool(stripe_runtime.get("ready"))
    reason = stripe_runtime.get("reason")
    if not stripe_runtime.get("secret_configured"):
        return {
            "status": "disabled",
            "reason": "stripe_not_configured",
            "message": "Portail client bientôt disponible.",
            "enabled": False,
        }
    if not stripe_ready:
        return {
            "status": "unavailable",
            "reason": reason or "stripe_unavailable",
            "message": "Portail client temporairement indisponible.",
            "enabled": False,
        }
    if not _portal_return_url_configured():
        return {
            "status": "disabled",
            "reason": "stripe_return_url_missing",
            "message": "Portail client bientôt disponible.",
            "enabled": False,
        }
    if not _portal_configuration_id_configured():
        return {
            "status": "disabled",
            "reason": "stripe_portal_configuration_missing",
            "message": "Portail client bientôt disponible.",
            "enabled": False,
        }
    return {
        "status": "enabled",
        "reason": None,
        "message": "Portail client disponible.",
        "enabled": True,
    }


def _token_topup_status_payload(
    *,
    stripe_runtime: dict[str, object],
    token_prices: dict[int, str],
    missing_token_pack_prices: list[str],
    transmissions_operational: bool,
) -> dict[str, object]:
    stripe_ready = bool(stripe_runtime.get("ready"))
    reason = stripe_runtime.get("reason")
    redirects_ready = _token_redirect_urls_configured()
    any_checkout = stripe_ready and redirects_ready and bool(token_prices)
    if not transmissions_operational:
        return {
            "status": "disabled",
            "reason": "transmissions_not_operational",
            "message": "Recharges indisponibles tant que la transmission Seqino n'est pas activée.",
            "enabled": False,
        }
    if not stripe_runtime.get("secret_configured"):
        return {
            "status": "disabled",
            "reason": "stripe_not_configured",
            "message": "Recharges de jetons bientôt disponibles.",
            "enabled": False,
        }
    if not stripe_ready:
        return {
            "status": "unavailable",
            "reason": reason or "stripe_unavailable",
            "message": "Recharges de jetons temporairement indisponibles.",
            "enabled": False,
        }
    if not redirects_ready:
        return {
            "status": "disabled",
            "reason": "stripe_redirect_url_missing",
            "message": "Recharges de jetons bientôt disponibles.",
            "enabled": False,
        }
    if missing_token_pack_prices:
        return {
            "status": "partial",
            "reason": "token_pack_prices_missing",
            "message": "Certains packs de jetons ne sont pas encore disponibles à l'achat.",
            "enabled": any_checkout,
        }
    return {
        "status": "enabled",
        "reason": None,
        "message": "Recharges de jetons disponibles.",
        "enabled": bool(token_prices),
    }


def _fallback_plan_row(
    plan: str,
    period: str,
    *,
    price_configured: bool,
    checkout_enabled: bool,
    reason: str | None,
) -> dict[str, object]:
    unit_amount = _FALLBACK_PRICES_CENTS[plan][period]
    return _with_checkout_state(
        _normalize_fallback_plan(plan, period, unit_amount),
        price_configured=price_configured,
        checkout_enabled=checkout_enabled,
        reason=reason,
    )


def _subscription_price_validation_reason(plan: str, period: str, price: object) -> str | None:
    expected_amount = _FALLBACK_PRICES_CENTS.get(plan, {}).get(period)
    if _read_attr(price, "active") is False:
        return "price_inactive"
    livemode_reason = livemode_validation_reason(price, settings.STRIPE_SECRET_KEY)
    if livemode_reason:
        return livemode_reason
    unit_amount = _safe_int(_read_attr(price, "unit_amount"))
    currency = str(_read_attr(price, "currency") or "").strip().lower()
    recurring = _read_attr(price, "recurring") or {}
    interval = str(_read_attr(recurring, "interval") or "").strip().lower()
    expected_interval = "month" if period == "monthly" else "year"
    if unit_amount != expected_amount:
        return "price_amount_mismatch"
    if currency != "eur":
        return "price_currency_mismatch"
    if interval != expected_interval:
        return "price_interval_mismatch"
    return None


def _price_validation_error_detail(plan: str, period: str, reason: str) -> dict[str, object]:
    return {
        "code": reason,
        "message": "Le prix configuré ne correspond pas à la grille tarifaire publiée.",
        "contact_url": "/contact",
        "plan": plan,
        "billing_period": period,
    }


@router.get("/status")
def billing_status():
    billing_enabled = bool(settings.BILLING_ENABLED or settings.SUBSCRIPTION_REQUIRED)
    subscription_required = bool(settings.SUBSCRIPTION_REQUIRED)
    stripe_secret = (settings.STRIPE_SECRET_KEY or "").strip()
    price_ids, missing = _stripe_price_ids()
    stripe_runtime = get_stripe_runtime_status(stripe_secret)
    stripe_ready = bool(stripe_runtime.get("ready"))
    stripe_configured = stripe_ready
    subscription_state = _subscription_status_payload(
        billing_enabled=billing_enabled,
        stripe_runtime=stripe_runtime,
        price_ids=price_ids,
        missing=missing,
    )
    customer_portal_state = _customer_portal_status_payload(stripe_runtime=stripe_runtime)
    token_prices = settings.stripe_token_prices()
    missing_token_pack_prices = [
        str(tokens) for tokens in settings.stripe_token_pack_sizes() if tokens not in token_prices
    ]
    token_topup_state = _token_topup_status_payload(
        stripe_runtime=stripe_runtime,
        token_prices=token_prices,
        missing_token_pack_prices=missing_token_pack_prices,
        transmissions_operational=bool(
            build_product_capabilities(Tenant(plan="pro", subscription_status="active")).get("seqino_operational")
        ),
    )
    return {
        "billing_enabled": billing_enabled,
        "subscription_required": subscription_required,
        "stripe_configured": stripe_configured,
        "stripe_secret_configured": bool(stripe_runtime.get("secret_configured")),
        "stripe_reason": stripe_runtime.get("reason"),
        "stripe_ready": stripe_ready,
        "subscription_status": subscription_state["status"],
        "subscription_reason": subscription_state["reason"],
        "subscription_message": subscription_state["message"],
        "subscription_checkout_enabled": subscription_state["checkout_enabled"],
        "customer_portal_status": customer_portal_state["status"],
        "customer_portal_reason": customer_portal_state["reason"],
        "customer_portal_message": customer_portal_state["message"],
        "customer_portal_enabled": customer_portal_state["enabled"],
        "plans_configured": {
            "starter": {
                "monthly": bool(price_ids.get("starter_monthly")),
                "yearly": bool(price_ids.get("starter_yearly")),
            },
            "pro": {
                "monthly": bool(price_ids.get("pro_monthly")),
                "yearly": bool(price_ids.get("pro_yearly")),
            },
        },
        "missing_subscription_prices": missing,
        "token_topup_status": token_topup_state["status"],
        "token_topup_reason": token_topup_state["reason"],
        "token_topup_message": token_topup_state["message"],
        "token_topup_configured": token_topup_state["enabled"],
        "token_packs_configured": sorted(token_prices.keys()),
        "missing_token_pack_prices": missing_token_pack_prices,
        "mode": _stripe_mode(stripe_secret),
    }


@router.get("/plans")
def billing_plans(db: Session = Depends(get_db)):
    billing_enabled = bool(settings.BILLING_ENABLED or settings.SUBSCRIPTION_REQUIRED)
    stripe_secret = (settings.STRIPE_SECRET_KEY or "").strip()
    price_ids, _ = _stripe_price_ids()
    stripe_runtime = get_stripe_runtime_status(stripe_secret)
    stripe_reason = stripe_runtime.get("reason")
    stripe_ready = bool(stripe_runtime.get("ready"))
    redirects_ready = _subscription_redirect_urls_configured()
    cache_key = _plans_cache_key(
        billing_enabled=billing_enabled,
        stripe_secret=stripe_secret,
        price_ids=price_ids,
    )

    cached = _get_plans_cache(cache_key)
    if cached is not None:
        return _apply_pro_welcome_stock_gate(cached, db)

    s = _stripe() if billing_enabled and stripe_ready else None
    prices_by_id: dict[str, object] = {}

    def _get_price(price_id: str):
        if price_id not in prices_by_id:
            try:
                assert s is not None
                prices_by_id[price_id] = s.Price.retrieve(price_id)
            except Exception as exc:
                if _STRIPE_ERRORS and isinstance(exc, _STRIPE_ERRORS.StripeError):
                    _log_stripe_price_error(price_id, exc)
                raise
        return prices_by_id[price_id]

    def _normalize(plan: str, period: str, price: object):
        unit_amount = _safe_int(_read_attr(price, "unit_amount"))
        unit_amount_decimal = _read_attr(price, "unit_amount_decimal")
        currency = (_read_attr(price, "currency") or "eur").lower()
        recurring = _read_attr(price, "recurring") or {}
        interval = _read_attr(recurring, "interval") or ("month" if period == "monthly" else "year")
        copy = subscription_plan_copy(plan, period)
        return {
            "plan": plan,
            "period": period,
            "display_name": copy.get("display_name") or plan.title(),
            "tagline": copy.get("tagline") or "",
            "description": copy.get("description") or "",
            "currency": currency,
            "unit_amount": unit_amount or 0,
            "unit_amount_decimal": str(unit_amount_decimal or unit_amount or 0),
            "amount_display": _amount_display_from_cents(unit_amount),
            "interval": interval,
            "features": _plan_capabilities(plan),
            "pricing_source": "stripe",
        }

    payload: list[dict[str, object]] = []
    for plan in ("starter", "pro"):
        for period in ("monthly", "yearly"):
            key = f"{plan}_{period}"
            price_id = price_ids.get(key)
            if not billing_enabled:
                payload.append(
                    _fallback_plan_row(
                        plan,
                        period,
                        price_configured=bool(price_id),
                        checkout_enabled=False,
                        reason="billing_disabled",
                    )
                )
                continue
            if not stripe_secret:
                payload.append(
                    _fallback_plan_row(
                        plan,
                        period,
                        price_configured=bool(price_id),
                        checkout_enabled=False,
                        reason="stripe_not_configured",
                    )
                )
                continue
            if not stripe_ready:
                payload.append(
                    _fallback_plan_row(
                        plan,
                        period,
                        price_configured=bool(price_id),
                        checkout_enabled=False,
                        reason=str(stripe_reason or "stripe_unavailable"),
                    )
                )
                continue
            if not redirects_ready:
                payload.append(
                    _fallback_plan_row(
                        plan,
                        period,
                        price_configured=bool(price_id),
                        checkout_enabled=False,
                        reason="stripe_redirect_url_missing",
                    )
                )
                continue
            if not price_id:
                payload.append(
                    _fallback_plan_row(
                        plan,
                        period,
                        price_configured=False,
                        checkout_enabled=False,
                        reason="price_not_configured",
                    )
                )
                continue
            try:
                price = _get_price(price_id)
                validation_reason = _subscription_price_validation_reason(plan, period, price)
                if validation_reason:
                    payload.append(
                        _fallback_plan_row(
                            plan,
                            period,
                            price_configured=True,
                            checkout_enabled=False,
                            reason=validation_reason,
                        )
                    )
                else:
                    payload.append(
                        _with_checkout_state(
                            _normalize(plan, period, price),
                            price_configured=True,
                            checkout_enabled=True,
                            reason=None,
                        )
                    )
            except stripe.StripeError:
                payload.append(
                    _fallback_plan_row(
                        plan,
                        period,
                        price_configured=True,
                        checkout_enabled=False,
                        reason="price_lookup_failed",
                    )
                )
    _set_plans_cache(cache_key, payload)
    return _apply_pro_welcome_stock_gate(payload, db)


@router.post("/checkout")
def create_checkout(
    plan: str,
    billing_period: str = "monthly",
    checkout_request_id: str | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    billing_enabled = bool(settings.BILLING_ENABLED or settings.SUBSCRIPTION_REQUIRED)
    if not billing_enabled:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "billing_disabled",
                "message": "La souscription en ligne n'est pas disponible pour le moment.",
                "contact_url": "/contact",
            },
        )
    if not (settings.STRIPE_SECRET_KEY or "").strip():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stripe_not_configured",
                "message": "La souscription en ligne n'est pas disponible pour le moment.",
                "contact_url": "/contact",
            },
        )
    stripe_runtime = get_stripe_runtime_status(settings.STRIPE_SECRET_KEY)
    if not stripe_runtime.get("ready"):
        raise HTTPException(
            status_code=409,
            detail={
                "code": stripe_runtime.get("reason") or "stripe_unavailable",
                "message": "Le paiement en ligne est temporairement indisponible.",
                "contact_url": "/contact",
            },
        )
    if not _subscription_redirect_urls_configured():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stripe_redirect_url_missing",
                "message": "La souscription en ligne est temporairement indisponible.",
                "contact_url": "/contact",
            },
        )
    required_docs = required_docs_for_ui()
    if required_docs:
        slugs = [doc["slug"] for doc in required_docs]
        accepted_rows = accepted_rows_for_user(
            db,
            tenant_id=user.tenant_id,
            user_id=user.id,
            slugs=slugs,
        )
        accepted = {(row.doc_slug, row.doc_version) for row in accepted_rows}
        missing = [doc for doc in required_docs if (doc["slug"], doc["version"]) not in accepted]
        if missing:
            return JSONResponse(
                status_code=409,
                content={
                    "code": "legal_not_accepted",
                    "message": "Acceptation des documents legaux requise avant paiement.",
                    "required": missing,
                },
            )
    tenant = _require_tenant(db.get(Tenant, user.tenant_id), user.tenant_id)
    if not _professional_profile_is_complete(tenant):
        return JSONResponse(
            status_code=409,
            content={
                "code": "professional_profile_required",
                "message": "Complétez et confirmez l'identité professionnelle de votre entreprise avant le paiement.",
                "action_url": "/app/company",
            },
        )
    s = _stripe()
    normalized = (plan or "").lower()
    try:
        selected_plan = Plan(normalized)
    except ValueError:
        raise HTTPException(400, "Plan inconnu.")

    period = _normalize_billing_period(billing_period)
    price_ids, _ = _stripe_price_ids()
    enterprise_price = _clean_stripe_config_value(settings.STRIPE_PRICE_ENTERPRISE)

    if selected_plan == Plan.STARTER:
        price_id = price_ids["starter_yearly"] if period == "yearly" else price_ids["starter_monthly"]
    elif selected_plan == Plan.PRO:
        price_id = price_ids["pro_yearly"] if period == "yearly" else price_ids["pro_monthly"]
    elif selected_plan == Plan.ENTERPRISE:
        if period == "yearly":
            raise HTTPException(
                400,
                "L’offre Volume est sur devis. Contactez-nous pour une proposition annuelle.",
            )
        price_id = enterprise_price
    else:
        price_id = None
    if not price_id:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "plan_price_unavailable",
                "message": "Cette formule ne peut pas être souscrite en ligne pour le moment.",
                "contact_url": "/contact",
                "plan": selected_plan.value,
                "billing_period": period,
            },
        )
    if selected_plan in {Plan.STARTER, Plan.PRO}:
        try:
            price = s.Price.retrieve(price_id)
        except Exception as exc:
            if _STRIPE_ERRORS and isinstance(exc, _STRIPE_ERRORS.StripeError):
                _log_stripe_price_error(price_id, exc)
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "price_lookup_failed",
                    "message": "Le paiement de cette formule ne peut pas être vérifié pour le moment.",
                    "contact_url": "/contact",
                    "plan": selected_plan.value,
                    "billing_period": period,
                },
            ) from exc
        validation_reason = _subscription_price_validation_reason(selected_plan.value, period, price)
        if validation_reason:
            raise HTTPException(
                status_code=409,
                detail=_price_validation_error_detail(selected_plan.value, period, validation_reason),
            )
    success_url, cancel_url = _stripe_redirect_urls()
    if not str(checkout_request_id or "").strip():
        raise HTTPException(
            status_code=400,
            detail={
                "code": "checkout_request_id_required",
                "message": "Actualisez la page puis relancez la souscription.",
            },
        )
    checkout_suffix = _checkout_idempotency_suffix(checkout_request_id)
    checkout_request_key = f"{selected_plan.value}:{period}:{checkout_suffix}"
    tenant = _claim_subscription_checkout(
        db,
        tenant_id=user.tenant_id,
        request_key=checkout_request_key,
        plan=selected_plan.value,
        period=period,
    )
    checkout_request_key = str(tenant.stripe_checkout_request_key or checkout_request_key)
    checkout_suffix = checkout_request_key.rsplit(":", 1)[-1]
    welcome_reservation_id: str | None = None
    welcome_tokens = int(getattr(settings, "SEQINO_WELCOME_TOKENS_PRO", 0) or 0)
    wallet = db.get(TokenWallet, tenant.id)
    if selected_plan == Plan.PRO and welcome_tokens > 0 and not getattr(wallet, "welcome_bonus_granted_at", None):
        try:
            reservation_scope = f"subscription-welcome:{selected_plan.value}:{period}"
            welcome_reservation = reserve_tokens(
                db,
                tenant_id=str(tenant.id),
                quantity=welcome_tokens,
                idempotency_key=f"{reservation_scope}:{checkout_suffix}",
                ttl_seconds=CHECKOUT_RESERVATION_TTL_SECONDS,
                exclusive_checkout_scope=reservation_scope,
            )
            db.commit()
            welcome_reservation_id = str(welcome_reservation.id)
        except ProviderTokenReservationLimitExceeded as exc:
            db.rollback()
            _clear_subscription_checkout(db, tenant_id=tenant.id)
            db.commit()
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "checkout_already_in_progress",
                    "message": (
                        "Un paiement est déjà ouvert pour cette entreprise. "
                        "Terminez-le ou contactez l'assistance s'il n'est plus accessible."
                    ),
                },
            ) from exc
        except (InsufficientProviderTokens, ProviderTokenInventoryError) as exc:
            db.rollback()
            _clear_subscription_checkout(db, tenant_id=tenant.id)
            db.commit()
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "pro_welcome_stock_unavailable",
                    "message": (
                        "La formule Pro est temporairement indisponible à la souscription. "
                        "La formule Starter reste disponible."
                    ),
                    "contact_url": "/contact",
                },
            ) from exc
    metadata = {
        "kind": "subscription",
        "tenant_id": tenant.id,
        "plan": selected_plan.value,
        "billing_period": period,
    }
    if welcome_reservation_id:
        metadata["provider_welcome_reservation_id"] = welcome_reservation_id
    session_payload = {
        "mode": "subscription",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "line_items": [{"price": price_id, "quantity": 1}],
        "allow_promotion_codes": True,
        "payment_method_types": ["card"],
        "expires_at": int(time()) + CHECKOUT_SESSION_TTL_SECONDS,
        "metadata": metadata,
        "subscription_data": {"metadata": metadata},
        "idempotency_key": (
            f"subscription-checkout:{tenant.id}:{welcome_reservation_id}"
            if welcome_reservation_id
            else f"subscription-checkout:{tenant.id}:{selected_plan.value}:{period}:{checkout_suffix}"
        ),
    }
    session_payload["customer"] = sync_stripe_customer_for_tenant(s, db, tenant, user)
    # Persist the stable Customer id before opening Checkout.  Retries reuse
    # both this id and the reservation-based Stripe idempotency key.
    db.commit()
    session = _preflight_remote_subscription_checkout(
        s,
        tenant=tenant,
        selected_plan=selected_plan,
        period=period,
        welcome_reservation_id=welcome_reservation_id,
    )
    if session is None:
        try:
            session = s.checkout.Session.create(**session_payload)
        except Exception as exc:
            if stripe_checkout_error_is_definite(exc):
                db.rollback()
                if welcome_reservation_id:
                    try:
                        release_reservation(db, reservation_id=welcome_reservation_id)
                    except ProviderTokenReservationStateError:
                        db.rollback()
                _clear_subscription_checkout(db, tenant_id=tenant.id)
                db.commit()
            # A transport failure can be ambiguous. Keep the lease and retry
            # the same Stripe idempotency key on the next click.
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "subscription_checkout_temporarily_unavailable",
                    "message": "Le paiement sécurisé n'a pas pu être ouvert. Réessayez dans quelques instants.",
                },
            ) from exc
    stripe_checkout_session_id = str(read_attr(session, "id") or "").strip()
    if not stripe_checkout_session_id:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "subscription_checkout_session_missing",
                "message": "Le paiement sécurisé n'a pas pu être confirmé. Réessayez dans quelques instants.",
            },
        )
    try:
        _record_subscription_checkout_session(
            db,
            tenant_id=tenant.id,
            request_key=checkout_request_key,
            session_id=stripe_checkout_session_id,
        )
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={
                "code": "subscription_checkout_reconciliation_pending",
                "message": "Le paiement sécurisé est en cours de rapprochement. Réessayez dans quelques instants.",
            },
        ) from exc
    if welcome_reservation_id:
        try:
            bind_reservation_to_stripe_checkout(
                db,
                reservation_id=welcome_reservation_id,
                stripe_checkout_session_id=stripe_checkout_session_id,
                checkout_kind="subscription",
                checkout_expires_at=read_attr(session, "expires_at"),
            )
            db.commit()
        except ProviderTokenInventoryError as exc:
            db.rollback()
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "subscription_checkout_reconciliation_pending",
                    "message": "Le paiement sécurisé est en cours de rapprochement. Réessayez dans quelques instants.",
                },
            ) from exc
    session_url = str(read_attr(session, "url") or "").strip()
    if not session_url:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "subscription_checkout_url_missing",
                "message": "Le paiement sécurisé n'a pas pu être ouvert. Réessayez dans quelques instants.",
            },
        )
    return {"url": session_url}


class FlowTopupCheckoutPayload(BaseModel):
    quantity: int | None = None
    amount: int | None = None


@router.post("/flow-topups/checkout")
def create_flow_topup_checkout(
    payload: FlowTopupCheckoutPayload,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
    _: AuthUser = Depends(require_subscription_active),
):
    raise HTTPException(
        status_code=410,
        detail={
            "code": "flow_topups_retired",
            "message": "Les anciennes recharges mensuelles ne sont plus disponibles. Achetez un pack de jetons depuis Abonnement.",
            "remediation_url": "/app/billing",
        },
    )


def _portal_session(db: Session, user: AuthUser):
    stripe_runtime = get_stripe_runtime_status(settings.STRIPE_SECRET_KEY)
    if not stripe_runtime.get("ready"):
        raise HTTPException(
            status_code=409,
            detail={
                "code": stripe_runtime.get("reason") or "stripe_unavailable",
                "message": "Le portail de paiement est temporairement indisponible.",
                "contact_url": "/contact",
            },
        )
    if not _portal_return_url_configured():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stripe_return_url_missing",
                "message": "Le portail de paiement n'est pas encore activé.",
                "contact_url": "/contact",
            },
        )
    s = _stripe()
    tenant = _require_tenant(db.get(Tenant, user.tenant_id), user.tenant_id)
    if not tenant.stripe_customer_id:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "stripe_customer_missing",
                "message": "Aucun abonnement en ligne n'est encore lié à ce compte.",
                "cta": "/app/billing",
            },
        )
    sync_stripe_customer_for_tenant(s, db, tenant, user)
    db.commit()
    return_url = _stripe_return_url()
    configuration_id = _portal_configuration_id()
    if not _portal_configuration_id_configured():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stripe_portal_configuration_missing",
                "message": "Le portail de paiement n'est pas encore activé.",
                "contact_url": "/contact",
            },
        )
    try:
        configuration = s.billing_portal.Configuration.retrieve(configuration_id)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "stripe_portal_configuration_unavailable",
                "message": "Le portail de paiement est temporairement indisponible.",
            },
        ) from exc
    features = read_attr(configuration, "features")
    subscription_update = read_attr(features, "subscription_update")
    subscription_cancel = read_attr(features, "subscription_cancel")
    configuration_safe = (
        read_attr(configuration, "active") is True
        and read_attr(subscription_update, "enabled") is False
        and read_attr(subscription_cancel, "enabled") is True
        and read_attr(subscription_cancel, "mode") == "at_period_end"
        and livemode_validation_reason(configuration, settings.STRIPE_SECRET_KEY) is None
    )
    if not configuration_safe:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stripe_portal_configuration_unsafe",
                "message": "Le portail de paiement est temporairement indisponible.",
                "contact_url": "/contact",
            },
        )
    session = s.billing_portal.Session.create(
        customer=tenant.stripe_customer_id,
        return_url=return_url,
        configuration=configuration_id,
    )
    return {"url": session.url}


@router.get("/portal")
def portal(db: Session = Depends(get_db), user: AuthUser = Depends(require_tenant_admin)):
    return _portal_session(db, user)


@router.post("/portal")
def portal_post(db: Session = Depends(get_db), user: AuthUser = Depends(require_tenant_admin)):
    return _portal_session(db, user)


async def _read_stripe_webhook_body(request: Request) -> bytes:
    max_bytes = max(1, int(getattr(settings, "STRIPE_WEBHOOK_MAX_BYTES", 262144) or 262144))
    declared = request.headers.get("content-length")
    if declared:
        try:
            if int(declared) > max_bytes:
                raise HTTPException(413, "Événement Stripe trop volumineux.")
        except ValueError as exc:
            raise HTTPException(400, "En-tête Content-Length invalide.") from exc
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > max_bytes:
            raise HTTPException(413, "Événement Stripe trop volumineux.")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/webhook")
async def webhook(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    s = _stripe()
    payload = await _read_stripe_webhook_body(request)
    sig = request.headers.get("stripe-signature")
    env = (settings.APP_ENV or "").lower()
    is_strict_env = env in {"prod", "production", "staging"}
    enforce_signature = enforce_stripe_signature() or is_strict_env
    secret = (settings.STRIPE_WEBHOOK_SECRET or "").strip()
    allow_insecure = bool(settings.ALLOW_INSECURE_STRIPE_WEBHOOK)
    if not secret:
        if enforce_signature or is_strict_env or not allow_insecure:
            raise HTTPException(
                status_code=500,
                detail={"code": "stripe_webhook_not_configured", "message": "Stripe webhook secret manquant."},
            )
        event = json.loads(payload)
    else:
        if enforce_signature:
            if not sig:
                raise HTTPException(400, "Signature Stripe manquante.")
            try:
                event = s.Webhook.construct_event(payload, sig, secret)
            except Exception as exc:
                raise HTTPException(400, "Signature Stripe invalide.") from exc
        else:
            if sig:
                try:
                    event = s.Webhook.construct_event(payload, sig, secret)
                except Exception as exc:
                    raise HTTPException(400, "Signature Stripe invalide.") from exc
            else:
                event = json.loads(payload)
    event_type = event.get("type")
    data = (event.get("data") or {}).get("object") or {}
    event_id = event.get("id")
    event_created = _safe_int(event.get("created"))
    if not event_id:
        raise HTTPException(400, "ID d'événement manquant")
    if livemode_validation_reason(event, settings.STRIPE_SECRET_KEY):
        raise HTTPException(
            status_code=400,
            detail={"code": "stripe_livemode_mismatch", "message": "Mode Stripe incompatible avec la configuration."},
        )
    stripe_event_row: StripeEvent | None = None
    try:
        stripe_event_row = StripeEvent(event_id=event_id, received_at=_utcnow())
        db.add(stripe_event_row)
        db.commit()
    except IntegrityError:
        db.rollback()
        stripe_event_row = db.query(StripeEvent).filter(StripeEvent.event_id == event_id).first()
        if stripe_event_row and stripe_event_row.processed_at is not None:
            return {"received": True, "duplicate": True}
        # If a previous attempt crashed before processed_at, do not drop the
        # paid event. Re-process it; Stripe delivery is idempotent downstream.
    import logging

    logger = logging.getLogger("billing.webhook")

    def _retry_webhook(status_code: int, code: str, message: str) -> None:
        db.rollback()
        retry_row = db.query(StripeEvent).filter(StripeEvent.event_id == event_id).first()
        if retry_row and retry_row.processed_at is None:
            try:
                db.delete(retry_row)
                db.commit()
            except Exception:
                db.rollback()
        raise HTTPException(status_code=status_code, detail={"code": code, "message": message})

    def _mask_stripe_id(value: str | None) -> str | None:
        raw = (value or "").strip()
        if len(raw) <= 12:
            return raw or None
        return f"{raw[:8]}…{raw[-4:]}"

    def _retry_paid_invoice_reconciliation(
        *,
        tenant_id: str | None,
        invoice_id: str | None,
        session_id: str | None,
        reason: str,
        amount_eur: Decimal | None = None,
        currency: str | None = None,
    ) -> None:
        """Persist a paid-but-unapplied incident, then ask Stripe to retry."""

        if tenant_id and session_id and db.get(Tenant, tenant_id) is not None:
            existing_incident = (
                db.query(ActionLog.id)
                .filter(
                    ActionLog.tenant_id == tenant_id,
                    ActionLog.action == "stripe_invoice_payment_reconciliation_required",
                    ActionLog.entity == "stripe_checkout_session",
                    ActionLog.entity_id == session_id,
                )
                .first()
            )
            if existing_incident is None:
                safe_log_action(
                    db,
                    tenant_id=tenant_id,
                    actor_user_id=None,
                    action_type="stripe_invoice_payment_reconciliation_required",
                    object_type="stripe_checkout_session",
                    object_id=session_id,
                    metadata={
                        "invoice_id": invoice_id,
                        "reason": reason,
                        "amount_eur": str(amount_eur) if amount_eur is not None else None,
                        "currency": currency,
                    },
                    commit=False,
                )
                db.commit()
        _retry_webhook(
            409,
            "invoice_payment_reconciliation_required",
            "Le paiement reçu est en attente de rapprochement. Aucun montant n'a été perdu.",
        )

    def _update_tenant(
        t: Tenant,
        plan: Plan | None,
        customer_id: str | None,
        subscription_id: str | None,
        status: str | None,
        *,
        provider_welcome_reservation_id: str | None = None,
        subscription_lifecycle_event: bool = False,
    ) -> bool:
        locked_tenant = db.query(Tenant).filter(Tenant.id == t.id).with_for_update().one_or_none()
        if locked_tenant is None:
            return False
        t = locked_tenant
        if subscription_lifecycle_event and event_created is not None:
            previous_created = getattr(t, "stripe_subscription_event_created", None)
            previous_event_id = (getattr(t, "stripe_subscription_event_id", None) or "").strip()
            current_status = (t.subscription_status or "").strip().lower()
            incoming_status = (status or "").strip().lower()
            if previous_created is not None and event_created < int(previous_created):
                return False
            if previous_created is not None and event_created == int(previous_created):
                if previous_event_id == event_id:
                    return False
                status_precedence = {
                    "canceled": 100,
                    "cancelled": 100,
                    "unpaid": 90,
                    "past_due": 80,
                    "incomplete": 70,
                    "pending": 60,
                    "paused": 55,
                    "active": 50,
                    "trialing": 40,
                }
                if status_precedence.get(incoming_status, 0) < status_precedence.get(
                    current_status,
                    0,
                ):
                    return False
                if status_precedence.get(incoming_status, 0) == status_precedence.get(
                    current_status,
                    0,
                ):
                    plan_precedence = {
                        Plan.STARTER.value: 0,
                        Plan.PRO.value: 1,
                        Plan.ENTERPRISE.value: 2,
                    }
                    current_plan_rank = plan_precedence.get(
                        str(t.plan or "").strip().lower(),
                        0,
                    )
                    incoming_plan_rank = (
                        plan_precedence.get(plan.value, current_plan_rank) if plan is not None else current_plan_rank
                    )
                    # Same-second ordering is not supplied by Stripe. Resolve
                    # it commutatively and fail closed: the lower privilege
                    # wins regardless of delivery order; equal states use the
                    # event id only as a stable total-order tiebreaker.
                    if incoming_plan_rank > current_plan_rank:
                        return False
                    if incoming_plan_rank == current_plan_rank and event_id <= previous_event_id:
                        return False
                if current_status in {"canceled", "cancelled"} and incoming_status not in {
                    "canceled",
                    "cancelled",
                }:
                    return False
        current_wallet = db.get(TokenWallet, t.id)
        welcome_tokens = int(getattr(settings, "SEQINO_WELCOME_TOKENS_PRO", 0) or 0)
        needs_welcome_reservation = bool(
            plan == Plan.PRO
            and status == "active"
            and welcome_tokens > 0
            and not getattr(current_wallet, "welcome_bonus_granted_at", None)
        )
        if needs_welcome_reservation and not provider_welcome_reservation_id:
            raise ProviderTokenInventoryError("Une activation Pro sans réservation du bonus doit être rapprochée.")
        if plan:
            t.plan = plan.value
        if customer_id:
            t.stripe_customer_id = customer_id
        if subscription_id:
            t.stripe_subscription_id = subscription_id
            t.stripe_checkout_session_id = None
            t.stripe_checkout_request_key = None
            t.stripe_checkout_pending_until = None
            t.stripe_checkout_plan = None
            t.stripe_checkout_period = None
        if status:
            t.subscription_status = status
        if subscription_lifecycle_event and event_created is not None:
            t.stripe_subscription_event_created = event_created
            t.stripe_subscription_event_id = event_id
        db.add(t)
        db.flush()
        granted = grant_subscription_entitlements(
            db,
            t,
            provider_welcome_reservation_id=provider_welcome_reservation_id,
            require_welcome_grant=True,
        )
        db.commit()
        try:
            logger.info(
                json.dumps(
                    {
                        "event": event_type,
                        "tenant_id": t.id,
                        "plan": t.plan,
                        "status": t.subscription_status,
                        "stripe_customer": _mask_stripe_id(t.stripe_customer_id),
                        "stripe_subscription": _mask_stripe_id(t.stripe_subscription_id),
                        "welcome_bonus_granted": granted,
                        "pdp_activation": "requires_explicit_mandate_consent",
                    }
                )
            )
        except Exception:
            pass
        return True

    def _amount_eur_from_cents(value: object) -> Decimal:
        cents = _safe_int(value) or 0
        return (Decimal(cents) / Decimal("100")).quantize(Decimal("0.01"))

    def _get_stripe_value(obj: Any, key: str) -> Any:
        if obj is None:
            return None
        if isinstance(obj, dict):
            return obj.get(key)
        getter = getattr(obj, "get", None)
        if callable(getter):
            try:
                return getter(key)
            except Exception:
                pass
        try:
            return getattr(obj, key)
        except Exception:
            pass
        try:
            return obj[key]
        except Exception:
            return None

    def _invoice_credit_total(inv: Invoice) -> Decimal:
        credits = (
            db.query(Invoice)
            .filter(Invoice.related_invoice_id == inv.id)
            .filter(Invoice.tenant_id == inv.tenant_id)
            .filter(Invoice.type == "credit_note")
            .filter(Invoice.status.notin_(["draft", "canceled"]))
            .all()
        )
        return sum(
            (abs(Decimal(str(n.total_inc_vat or 0))) for n in credits),
            start=Decimal("0"),
        )

    def _recompute_invoice_payment_status(inv: Invoice) -> None:
        credit_total = _invoice_credit_total(inv)
        paid_total = db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(Payment.invoice_id == inv.id).scalar()
        outstanding = invoice_balance_due_amount(
            inv.total_inc_vat,
            inv.template_options if isinstance(inv.template_options, dict) else None,
            credits=credit_total,
            paid=paid_total or 0,
        )
        now = _utcnow()
        if outstanding <= 0:
            inv.status = "paid"
            inv.paid_at = inv.paid_at or now
        elif Decimal(str(paid_total or 0)) > 0:
            inv.status = "partial"
            inv.paid_at = None
        elif inv.status in {"paid", "partial"}:
            inv.status = "overdue" if inv.due_date and inv.due_date.date() < now.date() else "sent"
            inv.paid_at = None
        inv.updated_by = None
        db.add(inv)

    charge_cache: dict[str, Any] = {}

    def _retrieve_stripe_charge(charge_id: str | None) -> Any:
        if not charge_id:
            return None
        if charge_id in charge_cache:
            return charge_cache[charge_id]
        try:
            charge_obj = s.Charge.retrieve(charge_id)
        except Exception:
            _retry_webhook(
                502,
                "stripe_charge_lookup_pending",
                "Le rapprochement du paiement est temporairement indisponible.",
            )
            raise AssertionError("unreachable")
        charge_cache[charge_id] = charge_obj
        return charge_obj

    def _retrieve_charge_payment_intent(charge_id: str | None) -> str | None:
        charge_obj = _retrieve_stripe_charge(charge_id)
        payment_intent_id = (_get_stripe_value(charge_obj, "payment_intent") or "").strip() or None
        if charge_id and not payment_intent_id:
            _retry_webhook(
                409,
                "stripe_charge_payment_pending",
                "Le paiement source est en attente de rapprochement.",
            )
        return payment_intent_id

    def _subscription_tenant_for_charge(
        charge_id: str | None,
    ) -> tuple[Tenant, str | None, str | None] | None:
        """Resolve a SaaS subscription charge without confusing it with a customer invoice."""

        charge_obj = _retrieve_stripe_charge(charge_id)
        invoice_value = _get_stripe_value(charge_obj, "invoice")
        if not invoice_value:
            return None
        if isinstance(invoice_value, str):
            try:
                stripe_invoice = s.Invoice.retrieve(invoice_value)
            except Exception:
                _retry_webhook(
                    502,
                    "stripe_subscription_invoice_lookup_pending",
                    "Le litige d'abonnement est en attente de rapprochement.",
                )
                raise AssertionError("unreachable")
        else:
            stripe_invoice = invoice_value
        subscription_value = _get_stripe_value(stripe_invoice, "subscription")
        raw_customer_id = _get_stripe_value(stripe_invoice, "customer")
        customer_id = str(raw_customer_id).strip() or None if raw_customer_id is not None else None
        subscription_id: str | None = None
        subscription_status: str | None = None
        if isinstance(subscription_value, str):
            subscription_id = subscription_value.strip() or None
            if subscription_id:
                try:
                    subscription_obj = s.Subscription.retrieve(subscription_id)
                except Exception:
                    _retry_webhook(
                        502,
                        "stripe_subscription_lookup_pending",
                        "Le litige d'abonnement est en attente de rapprochement.",
                    )
                    raise AssertionError("unreachable")
                raw_subscription_status = _get_stripe_value(subscription_obj, "status")
                subscription_status = (
                    str(raw_subscription_status).strip() or None if raw_subscription_status is not None else None
                )
                raw_subscription_customer = _get_stripe_value(subscription_obj, "customer")
                customer_id = (
                    str(raw_subscription_customer).strip() or customer_id
                    if raw_subscription_customer is not None
                    else customer_id
                )
        elif subscription_value is not None:
            raw_subscription_id = _get_stripe_value(subscription_value, "id")
            subscription_id = str(raw_subscription_id).strip() or None if raw_subscription_id is not None else None
            raw_subscription_status = _get_stripe_value(subscription_value, "status")
            subscription_status = (
                str(raw_subscription_status).strip() or None if raw_subscription_status is not None else None
            )
            raw_subscription_customer = _get_stripe_value(subscription_value, "customer")
            customer_id = (
                str(raw_subscription_customer).strip() or customer_id
                if raw_subscription_customer is not None
                else customer_id
            )
        tenant = None
        if subscription_id:
            tenant = db.query(Tenant).filter(Tenant.stripe_subscription_id == subscription_id).first()
        if tenant is None:
            return None
        tenant_customer_id = str(tenant.stripe_customer_id or "").strip()
        if customer_id and tenant_customer_id and customer_id != tenant_customer_id:
            return None
        return tenant, subscription_id, subscription_status

    def _cumulative_refunded_cents(charge_id: str | None) -> int:
        if event_type == "charge.refunded" and (data.get("id") or "").strip() == (charge_id or "").strip():
            amount_refunded = data.get("amount_refunded")
        else:
            charge_obj = _retrieve_stripe_charge(charge_id)
            amount_refunded = _get_stripe_value(charge_obj, "amount_refunded")
        parsed = _safe_int(amount_refunded)
        if parsed is None or parsed < 0:
            _retry_webhook(
                502,
                "stripe_refund_total_pending",
                "Le montant cumulé du remboursement est temporairement indisponible.",
            )
        return max(0, int(parsed or 0))

    def _find_stripe_invoice_payment(
        *,
        payment_intent_id: str | None = None,
        charge_id: str | None = None,
        session_id: str | None = None,
    ) -> Payment | None:
        pi_id = (payment_intent_id or "").strip() or _retrieve_charge_payment_intent((charge_id or "").strip() or None)
        query = db.query(Payment).filter(Payment.provider == "stripe")
        if pi_id:
            payment = query.filter(Payment.provider_id == pi_id).first()
            if payment:
                return payment
        if session_id:
            payment = query.filter(Payment.reference == f"stripe:checkout_session:{session_id}").first()
            if payment:
                return payment
        return None

    def _add_stripe_invoice_adjustment(
        inv: Invoice,
        *,
        amount: Decimal,
        reference: str,
        provider_id: str,
        method: str,
    ) -> bool:
        existing = db.query(Payment).filter(Payment.invoice_id == inv.id).filter(Payment.reference == reference).first()
        if existing:
            return False
        pay = Payment(
            invoice_id=inv.id,
            date=_utcnow(),
            method=method,
            amount=cast(Any, amount),
            reference=reference,
            provider="stripe",
            provider_id=provider_id,
            created_by=None,
        )
        db.add(pay)
        db.flush()
        _recompute_invoice_payment_status(inv)
        return True

    def _find_stripe_token_topup(
        *,
        payment_intent_id: str | None = None,
        charge_id: str | None = None,
    ) -> TokenTopup | None:
        pi_id = (payment_intent_id or "").strip() or _retrieve_charge_payment_intent((charge_id or "").strip() or None)
        if not pi_id:
            return None
        return db.query(TokenTopup).filter(TokenTopup.stripe_payment_intent_id == pi_id).first()

    def _token_topup_paid_cents(topup: TokenTopup) -> int:
        return int((Decimal(str(topup.amount_eur or 0)) * Decimal("100")).quantize(Decimal("1")))

    def _token_units_for_reversed_amount(topup: TokenTopup, amount_cents: int) -> int:
        """Convert a Stripe amount to tokens, rounding against PixFacture."""

        units = max(0, int(topup.tokens or 0))
        paid_cents = _token_topup_paid_cents(topup)
        reversed_cents = max(0, int(amount_cents or 0))
        if units <= 0 or paid_cents <= 0 or reversed_cents <= 0:
            return 0
        if reversed_cents >= paid_cents:
            return units
        return min(units, max(1, (reversed_cents * units + paid_cents - 1) // paid_cents))

    def _token_refund_reference_type(topup: TokenTopup) -> str:
        return f"stripe_token_refund:{topup.id}"

    def _already_refunded_token_units(topup: TokenTopup) -> int:
        total = (
            db.query(func.coalesce(func.sum(TokenLedger.delta), 0))
            .filter(
                TokenLedger.tenant_id == topup.tenant_id,
                TokenLedger.reference_type == _token_refund_reference_type(topup),
                TokenLedger.delta < 0,
            )
            .scalar()
        )
        return max(0, -int(total or 0))

    def _lock_token_reconciliation_rows(
        topup: TokenTopup,
    ) -> tuple[TokenTopup, ProviderTokenInventory | None, ProviderTokenAllocation | None, TokenWallet | None]:
        locked_topup = (
            db.query(TokenTopup).filter(TokenTopup.id == topup.id).populate_existing().with_for_update().first()
        )
        if locked_topup is None:
            return topup, None, None, None
        allocation_id = (locked_topup.provider_token_allocation_id or "").strip()
        allocation_hint = db.get(ProviderTokenAllocation, allocation_id) if allocation_id else None
        if allocation_hint is None:
            return locked_topup, None, None, None
        inventory = (
            db.query(ProviderTokenInventory)
            .filter(ProviderTokenInventory.id == allocation_hint.inventory_id)
            .populate_existing()
            .with_for_update()
            .first()
        )
        allocation = (
            db.query(ProviderTokenAllocation)
            .filter(
                ProviderTokenAllocation.id == allocation_id,
                ProviderTokenAllocation.tenant_id == locked_topup.tenant_id,
            )
            .populate_existing()
            .with_for_update()
            .first()
        )
        wallet = (
            db.query(TokenWallet)
            .filter(TokenWallet.tenant_id == locked_topup.tenant_id)
            .populate_existing()
            .with_for_update()
            .first()
        )
        return locked_topup, inventory, allocation, wallet

    def _provider_release_event(
        inventory_id: str,
        idempotency_key: str,
    ) -> ProviderTokenLedgerEvent | None:
        return (
            db.query(ProviderTokenLedgerEvent)
            .filter(
                ProviderTokenLedgerEvent.inventory_id == inventory_id,
                ProviderTokenLedgerEvent.idempotency_key == idempotency_key,
            )
            .first()
        )

    def _log_token_reconciliation(
        *,
        action: str,
        topup: TokenTopup,
        stripe_object_id: str,
        requested: int,
        debited: int,
        released: int,
        shortfall: int,
    ) -> None:
        payload = {
            "event": event_type,
            "action": action,
            "tenant_id": topup.tenant_id,
            "topup_id": topup.id,
            "stripe_object": _mask_stripe_id(stripe_object_id),
            "requested_tokens": requested,
            "debited_tokens": debited,
            "released_tokens": released,
            "shortfall_tokens": shortfall,
        }
        try:
            (logger.warning if shortfall else logger.info)(json.dumps(payload))
        except Exception:
            pass

    def _debit_token_topup(
        topup: TokenTopup,
        *,
        desired_units: int,
        stripe_object_id: str,
        ledger_reference_type: str,
        release_key_prefix: str | None,
        success_status: str,
        shortfall_status: str,
        reconciliation_required_status: str,
        action: str,
        target_total_units: int | None = None,
    ) -> tuple[int, int, int]:
        """Debit unused customer tokens and optionally release their backing.

        Provider inventory, allocation, wallet, ledger and topup status are
        committed together. A repeated Stripe business identifier is a no-op.
        """

        desired = max(0, int(desired_units or 0))
        locked_topup, inventory, allocation, wallet = _lock_token_reconciliation_rows(topup)
        refunded_total = 0
        if target_total_units is not None:
            refunded_total = (
                db.query(func.coalesce(func.sum(TokenLedger.delta), 0))
                .filter(
                    TokenLedger.tenant_id == locked_topup.tenant_id,
                    TokenLedger.reference_type == ledger_reference_type,
                    TokenLedger.delta < 0,
                )
                .scalar()
            )
            refunded_total = max(0, -int(refunded_total or 0))
            desired = max(0, int(target_total_units) - refunded_total)
        existing = (
            db.query(TokenLedger)
            .filter(
                TokenLedger.tenant_id == locked_topup.tenant_id,
                TokenLedger.reference_type == ledger_reference_type,
                TokenLedger.reference_id == stripe_object_id,
            )
            .first()
        )
        reinstated_before_withdrawal = None
        if ledger_reference_type == "stripe_token_dispute" and release_key_prefix is None:
            reinstated_before_withdrawal = (
                db.query(TokenLedger)
                .filter(
                    TokenLedger.tenant_id == locked_topup.tenant_id,
                    TokenLedger.reference_type == "stripe_token_dispute_reinstated",
                    TokenLedger.reference_id == stripe_object_id,
                )
                .first()
            )
        if reinstated_before_withdrawal is not None:
            locked_topup.status = "paid"
            db.add(locked_topup)
            db.commit()
            _log_token_reconciliation(
                action="token_dispute_withdrawal_ignored_after_reinstatement",
                topup=locked_topup,
                stripe_object_id=stripe_object_id,
                requested=desired,
                debited=0,
                released=0,
                shortfall=0,
            )
            return 0, 0, 0
        if existing is not None and ledger_reference_type.startswith("stripe_token_refund:"):
            debited = max(0, -int(existing.delta or 0))
            _log_token_reconciliation(
                action="token_refund_duplicate",
                topup=locked_topup,
                stripe_object_id=stripe_object_id,
                requested=desired,
                debited=debited,
                released=0,
                shortfall=max(0, int(target_total_units or 0) - refunded_total),
            )
            db.rollback()
            return debited, 0, 0
        if desired > 0 and existing is None and (inventory is None or allocation is None or wallet is None):
            locked_topup.status = reconciliation_required_status
            db.add(locked_topup)
            db.commit()
            raise ProviderTokenInventoryError(
                "La recharge historique n'a pas d'allocation fournisseur rapprochable automatiquement."
            )
        if existing is not None and ledger_reference_type == "stripe_token_dispute" and release_key_prefix is None:
            reinstated = (
                db.query(TokenLedger)
                .filter(
                    TokenLedger.tenant_id == locked_topup.tenant_id,
                    TokenLedger.reference_type == "stripe_token_dispute_reinstated",
                    TokenLedger.reference_id == stripe_object_id,
                )
                .first()
            )
            lost_release = (
                _provider_release_event(
                    str(inventory.id),
                    f"stripe-token-dispute-lost:{stripe_object_id}",
                )
                if inventory is not None
                else None
            )
            if reinstated is not None or lost_release is not None:
                debited = max(0, -int(existing.delta or 0))
                _log_token_reconciliation(
                    action="token_dispute_duplicate_after_close",
                    topup=locked_topup,
                    stripe_object_id=stripe_object_id,
                    requested=desired,
                    debited=debited,
                    released=int(lost_release.quantity or 0) if lost_release is not None else 0,
                    shortfall=0,
                )
                db.rollback()
                return debited, 0, 0
        if existing is not None:
            debited = max(0, -int(existing.delta or 0))
        elif inventory is None or allocation is None or wallet is None:
            debited = 0
        else:
            debited = min(
                desired,
                max(0, int(wallet.balance or 0)),
                max(0, int(allocation.available_tokens or 0)),
            )

        released = 0
        if release_key_prefix and inventory is not None and allocation is not None and debited > 0:
            release_key = f"{release_key_prefix}:{stripe_object_id}"
            release_event = _provider_release_event(str(inventory.id), release_key)
            if release_event is not None:
                released = int(release_event.quantity or 0)
            else:
                release_units = min(debited, max(0, int(allocation.available_tokens or 0)))
                if release_units > 0:
                    release_event = release_allocation_tokens(
                        db,
                        allocation_id=str(allocation.id),
                        quantity=release_units,
                        idempotency_key=release_key,
                        provider_slug=str(inventory.provider_slug),
                        reference_type=ledger_reference_type,
                        reference_id=stripe_object_id,
                    )
                    released = int(release_event.quantity or 0)

        if existing is None and debited > 0:
            assert wallet is not None
            wallet.balance = max(0, int(wallet.balance or 0) - debited)
            wallet.updated_at = _utcnow()
            db.add(
                TokenLedger(
                    tenant_id=locked_topup.tenant_id,
                    delta=-debited,
                    type="adjustment",
                    reference_type=ledger_reference_type,
                    reference_id=stripe_object_id,
                    created_at=_utcnow(),
                )
            )

        reconciled = min(debited, released) if release_key_prefix else debited
        shortfall = max(0, desired - reconciled)
        locked_topup.status = shortfall_status if shortfall else success_status
        db.add(locked_topup)
        db.commit()
        _log_token_reconciliation(
            action=action,
            topup=locked_topup,
            stripe_object_id=stripe_object_id,
            requested=desired,
            debited=debited,
            released=released,
            shortfall=shortfall,
        )
        return debited, released, shortfall

    def _reinstate_disputed_tokens(
        topup: TokenTopup,
        *,
        dispute_id: str,
    ) -> int:
        locked_topup, inventory, _allocation, wallet = _lock_token_reconciliation_rows(topup)
        hold = (
            db.query(TokenLedger)
            .filter(
                TokenLedger.tenant_id == locked_topup.tenant_id,
                TokenLedger.reference_type == "stripe_token_dispute",
                TokenLedger.reference_id == dispute_id,
            )
            .first()
        )
        existing = (
            db.query(TokenLedger)
            .filter(
                TokenLedger.tenant_id == locked_topup.tenant_id,
                TokenLedger.reference_type == "stripe_token_dispute_reinstated",
                TokenLedger.reference_id == dispute_id,
            )
            .first()
        )
        lost_release = (
            _provider_release_event(
                str(inventory.id),
                f"stripe-token-dispute-lost:{dispute_id}",
            )
            if inventory is not None
            else None
        )
        restored = 0
        if existing is not None:
            restored = max(0, int(existing.delta or 0))
        elif hold is not None and wallet is not None and lost_release is None:
            restored = max(0, -int(hold.delta or 0))
            if restored > 0:
                wallet.balance = int(wallet.balance or 0) + restored
                wallet.updated_at = _utcnow()
                db.add(
                    TokenLedger(
                        tenant_id=locked_topup.tenant_id,
                        delta=restored,
                        type="refund",
                        reference_type="stripe_token_dispute_reinstated",
                        reference_id=dispute_id,
                        created_at=_utcnow(),
                    )
                )
        elif hold is None and lost_release is None:
            # Stripe can deliver the reinstatement before the withdrawal.
            # Persist a zero-delta tombstone so a late withdrawal cannot debit
            # the customer's wallet.
            db.add(
                TokenLedger(
                    tenant_id=locked_topup.tenant_id,
                    delta=0,
                    type="refund",
                    reference_type="stripe_token_dispute_reinstated",
                    reference_id=dispute_id,
                    created_at=_utcnow(),
                )
            )
        if lost_release is None and (hold is None or restored > 0):
            locked_topup.status = "paid"
        db.add(locked_topup)
        db.commit()
        _log_token_reconciliation(
            action="token_dispute_reinstated",
            topup=locked_topup,
            stripe_object_id=dispute_id,
            requested=max(0, -int(hold.delta or 0)) if hold is not None else 0,
            debited=0,
            released=0,
            shortfall=0 if restored else (max(0, -int(hold.delta or 0)) if hold is not None else 0),
        )
        return restored

    if event_type in {"checkout.session.completed", "checkout.session.async_payment_succeeded"}:
        sub_id = data.get("subscription")
        cust_id = data.get("customer")
        meta = data.get("metadata") or {}
        mode = (data.get("mode") or "").strip().lower()
        kind = (meta.get("kind") or meta.get("type") or "").strip().lower()
        payment_status = (data.get("payment_status") or "").strip().lower()
        checkout_session_id = str(data.get("id") or "").strip()
        backing_reservation_id = (
            (meta.get("provider_token_reservation_id") or "").strip()
            or (meta.get("provider_welcome_reservation_id") or "").strip()
            or None
        )
        if backing_reservation_id and checkout_session_id:
            try:
                bind_reservation_to_stripe_checkout(
                    db,
                    reservation_id=backing_reservation_id,
                    stripe_checkout_session_id=checkout_session_id,
                    checkout_kind=kind or "checkout",
                    checkout_expires_at=data.get("expires_at"),
                )
                db.commit()
            except ProviderTokenInventoryError as exc:
                db.rollback()
                _retry_webhook(
                    409,
                    "provider_reservation_reconciliation_pending",
                    "Le paiement est en attente de rapprochement du stock.",
                )
                raise AssertionError("unreachable") from exc

        if mode == "payment":
            if kind == "token_topup":
                if payment_status != "paid":
                    try:
                        logger.info(json.dumps({"event": event_type, "action": "skip", "reason": "unpaid"}))
                    except Exception:
                        pass
                else:
                    pack = (meta.get("pack") or "").strip()
                    skip_reason = None
                    tenant_id = (meta.get("tenant_id") or "").strip() or None
                    if not tenant_id:
                        tenant_id = (data.get("client_reference_id") or "").strip() or None
                    if not tenant_id:
                        skip_reason = "tenant_id_missing"
                    t = db.get(Tenant, tenant_id) if tenant_id else None
                    if not t and not skip_reason:
                        skip_reason = "tenant_not_found"
                    session_id = data.get("id")
                    payment_intent_id = data.get("payment_intent")
                    reservation_id = (meta.get("provider_token_reservation_id") or "").strip() or None
                    if not session_id and not skip_reason:
                        skip_reason = "missing_session_id"
                    if not reservation_id and not skip_reason:
                        skip_reason = "provider_reservation_missing"
                    line_items = None
                    if not skip_reason:
                        try:
                            line_items = s.checkout.Session.list_line_items(session_id, limit=10)
                        except Exception:
                            _retry_webhook(
                                502,
                                "stripe_line_items_unavailable",
                                "Lecture des lignes Stripe impossible. Stripe retentera le webhook.",
                            )
                    items = _get_stripe_value(line_items, "data") or []
                    if not skip_reason and len(items) != 1:
                        skip_reason = "line_items_count"
                    item = items[0] if items else {}
                    quantity = _safe_int(_get_stripe_value(item, "quantity"))
                    if not skip_reason and quantity != 1:
                        skip_reason = "line_item_quantity"
                    price = _get_stripe_value(item, "price")
                    price_id = (_get_stripe_value(price, "id") or "").strip()
                    if not price_id:
                        price_id = (str(price or "")).strip()
                    tokens_expected = settings.tokens_for_price_id(price_id)
                    if not skip_reason and not tokens_expected:
                        skip_reason = "price_not_whitelisted"
                    pack_tokens = _safe_int(pack)
                    if not skip_reason and pack_tokens and tokens_expected and pack_tokens != tokens_expected:
                        skip_reason = "pack_mismatch"
                    if not skip_reason and tokens_expected:
                        validation_reason = token_pack_price_validation_reason(
                            tokens_expected, price, quantity=quantity
                        )
                        if validation_reason:
                            skip_reason = validation_reason
                    if skip_reason:
                        log_payload = {"event": event_type, "action": "skip", "reason": skip_reason}
                        if skip_reason in {"line_items_count", "line_item_quantity"}:
                            log_payload["count"] = len(items)
                            log_payload["quantity"] = quantity
                        try:
                            logger.warning(json.dumps(log_payload))
                        except Exception:
                            pass
                        _retry_webhook(
                            409,
                            "token_topup_validation_pending",
                            "La recharge payée est en attente de rapprochement. Aucun jeton non couvert n'a été crédité.",
                        )
                    else:
                        assert t is not None
                        assert session_id is not None
                        amount_total = data.get("amount_total")
                        currency = (data.get("currency") or "").strip().lower()
                        if amount_total is None or not currency:
                            try:
                                session_details = s.checkout.Session.retrieve(session_id)
                                if amount_total is None:
                                    amount_total = _get_stripe_value(session_details, "amount_total")
                                if not currency:
                                    currency = (_get_stripe_value(session_details, "currency") or "eur").lower()
                            except Exception:
                                pass
                        amount_eur = _amount_eur_from_cents(amount_total)
                        if not currency:
                            currency = "eur"
                        assert tokens_expected is not None
                        expected_amount_total = expected_token_pack_amount(tokens_expected)
                        amount_total_cents = _safe_int(amount_total)
                        amount_valid = (
                            expected_amount_total is not None
                            and amount_total_cents == expected_amount_total
                            and currency == "eur"
                        )
                        if not amount_valid:
                            try:
                                logger.warning(
                                    json.dumps(
                                        {
                                            "event": event_type,
                                            "action": "skip",
                                            "reason": "session_amount_mismatch",
                                            "tokens": tokens_expected,
                                            "currency": currency,
                                        }
                                    )
                                )
                            except Exception:
                                pass
                            _retry_webhook(
                                409,
                                "token_topup_amount_mismatch",
                                "La recharge payée est en attente de rapprochement. Aucun jeton non couvert n'a été crédité.",
                            )
                        else:
                            assert reservation_id is not None
                            reservation = db.get(ProviderTokenReservation, reservation_id)
                            if (
                                reservation is None
                                or str(reservation.tenant_id) != str(t.id)
                                or int(reservation.quantity or 0) != int(tokens_expected)
                            ):
                                _retry_webhook(
                                    409,
                                    "token_topup_backing_mismatch",
                                    "La recharge payée est en attente de rapprochement du stock fournisseur.",
                                )
                            try:
                                allocation = finalize_reservation(
                                    db,
                                    reservation_id=reservation_id,
                                )
                            except (ProviderTokenInventoryError, ProviderTokenReservationStateError) as exc:
                                _retry_webhook(
                                    409,
                                    "token_topup_backing_pending",
                                    "La recharge payée est en attente de rapprochement du stock fournisseur.",
                                )
                                raise AssertionError("unreachable") from exc
                            if str(allocation.tenant_id) != str(t.id) or int(allocation.quantity or 0) != int(
                                tokens_expected
                            ):
                                _retry_webhook(
                                    409,
                                    "token_topup_backing_mismatch",
                                    "La recharge payée est en attente de rapprochement du stock fournisseur.",
                                )
                            balance = credit_from_stripe_session(
                                db,
                                _require_tenant(t, tenant_id or "").id or "",
                                session_id,
                                payment_intent_id,
                                tokens_expected,
                                amount_eur,
                                currency,
                                provider_token_reservation_id=reservation_id,
                                provider_token_allocation_id=str(allocation.id),
                                commit=False,
                            )
                            if cust_id and not t.stripe_customer_id:
                                t.stripe_customer_id = cust_id
                                db.add(t)
                            db.commit()
                            try:
                                logger.info(
                                    json.dumps(
                                        {
                                            "event": event_type,
                                            "tenant_id": t.id,
                                            "pack": pack,
                                            "tokens": tokens_expected,
                                            "session_id": session_id,
                                            "balance": balance,
                                        }
                                    )
                                )
                            except Exception:
                                pass
            elif kind == "flow_topup":
                try:
                    logger.warning(
                        json.dumps(
                            {
                                "event": event_type,
                                "action": "skip",
                                "reason": "flow_topups_retired",
                                "session_id": (data.get("id") or "").strip() or None,
                            }
                        )
                    )
                except Exception:
                    pass
            elif kind == "invoice_payment":
                # Paiement d'une facture via Stripe Checkout (portail client)
                if payment_status != "paid":
                    try:
                        logger.info(
                            json.dumps({"event": event_type, "action": "skip", "reason": "unpaid_invoice_payment"})
                        )
                    except Exception:
                        pass
                else:
                    tenant_id = (meta.get("tenant_id") or "").strip() or None
                    invoice_id = (meta.get("invoice_id") or "").strip() or None
                    session_id = (data.get("id") or "").strip() or None
                    if not tenant_id:
                        tenant_id = (data.get("client_reference_id") or "").strip() or None
                    if not invoice_id or not tenant_id or not session_id:
                        try:
                            logger.warning(
                                json.dumps(
                                    {"event": event_type, "action": "skip", "reason": "missing_invoice_metadata"}
                                )
                            )
                        except Exception:
                            pass
                        _retry_paid_invoice_reconciliation(
                            tenant_id=tenant_id,
                            invoice_id=invoice_id,
                            session_id=session_id,
                            reason="missing_invoice_metadata",
                        )
                    else:
                        try:
                            inv = db.query(Invoice).filter(Invoice.id == invoice_id).with_for_update().first()
                        except OperationalError:
                            logger.warning(
                                json.dumps(
                                    {
                                        "event": event_type,
                                        "action": "retry",
                                        "reason": "invoice_locked",
                                        "invoice_id": invoice_id,
                                    }
                                )
                            )
                            raise
                        if not inv or inv.tenant_id != tenant_id:
                            try:
                                logger.warning(
                                    json.dumps({"event": event_type, "action": "skip", "reason": "invoice_not_found"})
                                )
                            except Exception:
                                pass
                            _retry_paid_invoice_reconciliation(
                                tenant_id=tenant_id,
                                invoice_id=invoice_id,
                                session_id=session_id,
                                reason="invoice_not_found",
                            )
                        else:
                            # Idempotence par session_id
                            ref = f"stripe:checkout_session:{session_id}"
                            existing = (
                                db.query(Payment)
                                .filter(Payment.invoice_id == inv.id)
                                .filter(Payment.reference == ref)
                                .first()
                            )
                            if existing:
                                try:
                                    logger.info(
                                        json.dumps({"event": event_type, "action": "duplicate", "invoice_id": inv.id})
                                    )
                                except Exception:
                                    pass
                            else:
                                amount_total = data.get("amount_total")
                                currency = (data.get("currency") or "").strip().lower()
                                if not currency:
                                    currency = "eur"
                                amount_eur = _amount_eur_from_cents(amount_total)
                                if currency != "eur":
                                    # on ne traite que EUR pour éviter ambiguïtés
                                    try:
                                        logger.warning(
                                            json.dumps(
                                                {
                                                    "event": event_type,
                                                    "action": "skip",
                                                    "reason": "unsupported_currency",
                                                    "currency": currency,
                                                }
                                            )
                                        )
                                    except Exception:
                                        pass
                                    _retry_paid_invoice_reconciliation(
                                        tenant_id=tenant_id,
                                        invoice_id=invoice_id,
                                        session_id=session_id,
                                        reason="unsupported_currency",
                                        amount_eur=amount_eur,
                                        currency=currency,
                                    )
                                else:
                                    credit_total = _invoice_credit_total(inv)
                                    paid_before = (
                                        db.query(func.coalesce(func.sum(Payment.amount), 0))
                                        .filter(Payment.invoice_id == inv.id)
                                        .scalar()
                                    )
                                    outstanding_before = invoice_balance_due_amount(
                                        inv.total_inc_vat,
                                        inv.template_options if isinstance(inv.template_options, dict) else None,
                                        credits=credit_total,
                                        paid=paid_before or 0,
                                    )
                                    amount_matches_invoice = (
                                        amount_eur > 0 and amount_eur <= outstanding_before + Decimal("0.01")
                                    )
                                    if not amount_matches_invoice:
                                        try:
                                            logger.warning(
                                                json.dumps(
                                                    {
                                                        "event": event_type,
                                                        "action": "skip",
                                                        "reason": "invoice_payment_amount_mismatch",
                                                        "invoice_id": inv.id,
                                                        "amount_eur": str(amount_eur),
                                                        "outstanding": str(outstanding_before),
                                                    }
                                                )
                                            )
                                        except Exception:
                                            pass
                                        _retry_paid_invoice_reconciliation(
                                            tenant_id=tenant_id,
                                            invoice_id=invoice_id,
                                            session_id=session_id,
                                            reason="invoice_payment_amount_mismatch",
                                            amount_eur=amount_eur,
                                            currency=currency,
                                        )
                                    else:
                                        # Best-effort Stripe receipt/card details (for portal proof)
                                        receipt_url = None
                                        card_brand = None
                                        card_last4 = None
                                        provider_id = None
                                        payment_intent_id = (data.get("payment_intent") or "").strip() or None
                                        provider_id = payment_intent_id or session_id
                                        try:
                                            if payment_intent_id and (settings.STRIPE_SECRET_KEY or "").strip():
                                                import stripe as _stripe_mod

                                                _stripe_mod.api_key = settings.STRIPE_SECRET_KEY
                                                pi_obj = _stripe_mod.PaymentIntent.retrieve(
                                                    payment_intent_id,
                                                    expand=[
                                                        "latest_charge",
                                                        "charges.data.payment_method_details",
                                                    ],
                                                )
                                                latest_charge = _get_stripe_value(pi_obj, "latest_charge")
                                                ch = (
                                                    latest_charge
                                                    if latest_charge and not isinstance(latest_charge, str)
                                                    else None
                                                )
                                                if not ch:
                                                    charges_obj = _get_stripe_value(pi_obj, "charges") or {}
                                                    charges = _get_stripe_value(charges_obj, "data") or []
                                                    if charges:
                                                        ch = charges[0]
                                                if ch:
                                                    receipt_url = _get_stripe_value(ch, "receipt_url")
                                                    details = _get_stripe_value(ch, "payment_method_details") or {}
                                                    card = _get_stripe_value(details, "card") or {}
                                                    card_brand = _get_stripe_value(card, "brand")
                                                    card_last4 = _get_stripe_value(card, "last4")
                                        except Exception:
                                            # Ne pas bloquer le traitement webhook si Stripe est indisponible
                                            receipt_url = receipt_url
                                        pay = Payment(
                                            invoice_id=inv.id,
                                            date=_utcnow(),
                                            method="card",
                                            amount=cast(Any, amount_eur),
                                            reference=ref,
                                            provider="stripe",
                                            provider_id=provider_id,
                                            receipt_url=receipt_url,
                                            card_brand=card_brand,
                                            card_last4=card_last4,
                                            created_by=None,
                                        )
                                        db.add(pay)
                                        db.flush()
                                        _recompute_invoice_payment_status(inv)
                                        try:
                                            safe_log_action(
                                                db,
                                                tenant_id=inv.tenant_id,
                                                actor_user_id=None,
                                                action_type="payment_stripe",
                                                object_type="invoice",
                                                object_id=str(inv.id or ""),
                                                metadata={
                                                    "session_id": session_id,
                                                    "amount": str(amount_eur),
                                                    "payment_intent_id": payment_intent_id,
                                                    "receipt_url": receipt_url,
                                                },
                                                commit=False,
                                            )
                                        except Exception:
                                            pass
                                        db.commit()
                                        try:
                                            logger.info(
                                                json.dumps(
                                                    {
                                                        "event": event_type,
                                                        "invoice_id": inv.id,
                                                        "amount": str(amount_eur),
                                                        "status": inv.status,
                                                    }
                                                )
                                            )
                                        except Exception:
                                            pass

        elif mode == "subscription" or sub_id:
            tenant_id = str(meta.get("tenant_id") or "").strip() or None
            t = _strict_subscription_tenant(
                db,
                subscription_id=str(sub_id or "").strip() or None,
                customer_id=str(cust_id or "").strip() or None,
                metadata_tenant_id=tenant_id,
            )

            if t:
                current_status = (t.subscription_status or "").strip().lower()
                checkout_link_status = (
                    "pending" if current_status in {"", "inactive", "incomplete", "pending"} else None
                )
                _update_tenant(
                    t,
                    None,
                    cust_id,
                    sub_id,
                    checkout_link_status,
                    provider_welcome_reservation_id=(
                        (meta.get("provider_welcome_reservation_id") or "").strip() or None
                    ),
                )
            elif tenant_id:
                _retry_webhook(
                    409,
                    "subscription_owner_reconciliation_pending",
                    "L'abonnement payé est en attente de rapprochement.",
                )

    elif event_type in {"refund.created", "refund.updated", "refund.failed", "charge.refunded"}:
        refund_items: list[dict[str, Any]]
        if event_type == "charge.refunded":
            charge_id = (data.get("id") or "").strip() or None
            refunds_obj = data.get("refunds") or {}
            refund_items = list(refunds_obj.get("data") or [])
            if not refund_items and data.get("amount_refunded"):
                refund_items = [
                    {
                        "id": f"charge_refunded_{charge_id}",
                        "charge": charge_id,
                        "payment_intent": data.get("payment_intent"),
                        "amount": data.get("amount_refunded"),
                        "currency": data.get("currency"),
                        "status": "succeeded",
                    }
                ]
        else:
            refund_items = [data]
        for refund in refund_items:
            refund_id = (refund.get("id") or "").strip()
            charge_id = (refund.get("charge") or "").strip() or None
            payment_intent_id = (refund.get("payment_intent") or "").strip() or None
            currency = (refund.get("currency") or "eur").strip().lower()
            status = (refund.get("status") or "").strip().lower()
            if not refund_id or currency != "eur":
                raise HTTPException(
                    409, detail={"code": "source_payment_pending", "message": "Paiement source en attente."}
                )
            token_topup = _find_stripe_token_topup(
                payment_intent_id=payment_intent_id,
                charge_id=charge_id,
            )
            if token_topup is not None:
                if event_type == "refund.failed" or status in {"failed", "canceled", "cancelled"}:
                    continue
                if status not in {"succeeded", "success"}:
                    try:
                        logger.info(
                            json.dumps(
                                {
                                    "event": event_type,
                                    "action": "token_refund_pending",
                                    "topup_id": token_topup.id,
                                    "refund": _mask_stripe_id(refund_id),
                                    "status": status or "pending",
                                }
                            )
                        )
                    except Exception:
                        pass
                    continue
                cumulative_refunded_cents = _cumulative_refunded_cents(charge_id)
                target_units = _token_units_for_reversed_amount(
                    token_topup,
                    cumulative_refunded_cents,
                )
                refund_reference_type = _token_refund_reference_type(token_topup)
                existing_refund = (
                    db.query(TokenLedger)
                    .filter(
                        TokenLedger.tenant_id == token_topup.tenant_id,
                        TokenLedger.reference_type == refund_reference_type,
                        TokenLedger.reference_id == refund_id,
                    )
                    .first()
                )
                if existing_refund is not None:
                    continue
                already_refunded_units = _already_refunded_token_units(token_topup)
                desired_units = max(0, target_units - already_refunded_units)
                success_status = (
                    "refunded"
                    if cumulative_refunded_cents >= _token_topup_paid_cents(token_topup)
                    else "partially_refunded"
                )
                try:
                    _debit_token_topup(
                        token_topup,
                        desired_units=desired_units,
                        stripe_object_id=refund_id,
                        ledger_reference_type=refund_reference_type,
                        release_key_prefix="stripe-token-refund",
                        success_status=success_status,
                        shortfall_status="refund_shortfall",
                        reconciliation_required_status="refund_reconciliation_required",
                        action="token_refund",
                        target_total_units=target_units,
                    )
                except ProviderTokenInventoryError as exc:
                    db.rollback()
                    try:
                        logger.exception(
                            "token_refund_reconciliation_failed",
                            extra={"topup_id": token_topup.id, "refund": _mask_stripe_id(refund_id)},
                        )
                    except Exception:
                        pass
                    _retry_webhook(
                        409,
                        "token_refund_reconciliation_pending",
                        "Le remboursement est en attente de rapprochement des jetons.",
                    )
                    raise AssertionError("unreachable") from exc
                continue
            source_payment = _find_stripe_invoice_payment(payment_intent_id=payment_intent_id, charge_id=charge_id)
            if not source_payment:
                subscription_match = _subscription_tenant_for_charge(charge_id)
                if subscription_match is not None:
                    try:
                        logger.info(
                            json.dumps(
                                {
                                    "event": event_type,
                                    "action": "subscription_refund_observed",
                                    "tenant_id": subscription_match[0].id,
                                    "refund": _mask_stripe_id(refund_id),
                                }
                            )
                        )
                    except Exception:
                        pass
                    continue
                try:
                    logger.warning(
                        json.dumps(
                            {
                                "event": event_type,
                                "action": "skip",
                                "reason": "invoice_payment_not_found",
                                "refund": _mask_stripe_id(refund_id),
                                "payment_intent": _mask_stripe_id(payment_intent_id),
                            }
                        )
                    )
                except Exception:
                    pass
                _retry_webhook(
                    409,
                    "source_payment_pending",
                    "Le remboursement est en attente de rapprochement du paiement source.",
                )
            inv = db.query(Invoice).filter(Invoice.id == source_payment.invoice_id).with_for_update().first()
            if not inv:
                _retry_webhook(
                    409,
                    "source_invoice_pending",
                    "Le remboursement est en attente de rapprochement de la facture.",
                )
            amount_eur = _amount_eur_from_cents(refund.get("amount"))
            if amount_eur <= 0:
                continue
            refund_reference = f"stripe:refund:{refund_id}"
            failed_reference = f"stripe:refund_failed:{refund_id}"
            if event_type == "refund.failed" or status == "failed":
                original = (
                    db.query(Payment)
                    .filter(Payment.invoice_id == inv.id)
                    .filter(Payment.reference == refund_reference)
                    .first()
                )
                if original:
                    created = _add_stripe_invoice_adjustment(
                        inv,
                        amount=amount_eur,
                        reference=failed_reference,
                        provider_id=refund_id,
                        method="card_refund_failed",
                    )
                else:
                    created = _add_stripe_invoice_adjustment(
                        inv,
                        amount=Decimal("0"),
                        reference=failed_reference,
                        provider_id=refund_id,
                        method="card_refund_failed_tombstone",
                    )
                if created:
                    db.commit()
                continue
            if status in {"canceled", "cancelled"}:
                continue
            failed_tombstone = (
                db.query(Payment)
                .filter(Payment.invoice_id == inv.id)
                .filter(Payment.reference == failed_reference)
                .first()
            )
            if failed_tombstone is not None:
                continue
            if status not in {"succeeded", "success"}:
                try:
                    logger.info(
                        json.dumps(
                            {
                                "event": event_type,
                                "action": "invoice_refund_pending",
                                "refund": _mask_stripe_id(refund_id),
                                "status": status or "pending",
                            }
                        )
                    )
                except Exception:
                    pass
                continue
            created = _add_stripe_invoice_adjustment(
                inv,
                amount=-amount_eur,
                reference=refund_reference,
                provider_id=refund_id,
                method="card_refund",
            )
            if created:
                db.commit()

    elif event_type in {
        "charge.dispute.funds_withdrawn",
        "charge.dispute.closed",
        "charge.dispute.funds_reinstated",
    }:
        dispute_id = (data.get("id") or "").strip()
        charge_id = (data.get("charge") or "").strip() or None
        payment_intent_id = (data.get("payment_intent") or "").strip() or None
        currency = (data.get("currency") or "eur").strip().lower()
        status = (data.get("status") or "").strip().lower()
        if dispute_id and currency == "eur":
            token_topup = _find_stripe_token_topup(
                payment_intent_id=payment_intent_id,
                charge_id=charge_id,
            )
            handled_token_topup = token_topup is not None
            if token_topup is not None:
                desired_units = _token_units_for_reversed_amount(
                    token_topup,
                    _safe_int(data.get("amount")) or 0,
                )
                try:
                    if event_type == "charge.dispute.funds_withdrawn":
                        _debit_token_topup(
                            token_topup,
                            desired_units=desired_units,
                            stripe_object_id=dispute_id,
                            ledger_reference_type="stripe_token_dispute",
                            release_key_prefix=None,
                            success_status="disputed",
                            shortfall_status="dispute_shortfall",
                            reconciliation_required_status="chargeback_reconciliation_required",
                            action="token_dispute_withdrawn",
                        )
                    elif event_type == "charge.dispute.funds_reinstated" or status == "won":
                        _reinstate_disputed_tokens(token_topup, dispute_id=dispute_id)
                    elif event_type == "charge.dispute.closed" and status == "lost":
                        _debit_token_topup(
                            token_topup,
                            desired_units=desired_units,
                            stripe_object_id=dispute_id,
                            ledger_reference_type="stripe_token_dispute",
                            release_key_prefix="stripe-token-dispute-lost",
                            success_status="chargeback_lost",
                            shortfall_status="chargeback_shortfall",
                            reconciliation_required_status="chargeback_reconciliation_required",
                            action="token_dispute_lost",
                        )
                except ProviderTokenInventoryError as exc:
                    db.rollback()
                    try:
                        logger.exception(
                            "token_dispute_reconciliation_failed",
                            extra={"topup_id": token_topup.id, "dispute": _mask_stripe_id(dispute_id)},
                        )
                    except Exception:
                        pass
                    _retry_webhook(
                        409,
                        "token_dispute_reconciliation_pending",
                        "Le litige est en attente de rapprochement des jetons.",
                    )
                    raise AssertionError("unreachable") from exc
            if not handled_token_topup:
                source_payment = _find_stripe_invoice_payment(payment_intent_id=payment_intent_id, charge_id=charge_id)
                if not source_payment:
                    subscription_match = _subscription_tenant_for_charge(charge_id)
                    if subscription_match is None:
                        _retry_webhook(
                            409,
                            "source_payment_pending",
                            "Le litige est en attente de rapprochement du paiement source.",
                        )
                    subscription_tenant, subscription_id, remote_subscription_status = subscription_match
                    if event_type == "charge.dispute.funds_withdrawn" or status == "lost":
                        target_status = "past_due"
                    elif event_type == "charge.dispute.funds_reinstated" or status == "won":
                        target_status = (
                            remote_subscription_status if remote_subscription_status in {"active", "trialing"} else None
                        )
                    else:
                        target_status = None
                    if target_status:
                        _update_tenant(
                            subscription_tenant,
                            None,
                            subscription_tenant.stripe_customer_id,
                            subscription_id,
                            target_status,
                            subscription_lifecycle_event=True,
                        )
                    try:
                        logger.warning(
                            json.dumps(
                                {
                                    "event": event_type,
                                    "action": "subscription_dispute_reconciled",
                                    "tenant_id": subscription_tenant.id,
                                    "subscription": _mask_stripe_id(subscription_id),
                                    "dispute": _mask_stripe_id(dispute_id),
                                    "status": target_status or "unchanged",
                                }
                            )
                        )
                    except Exception:
                        pass
                else:
                    inv = db.query(Invoice).filter(Invoice.id == source_payment.invoice_id).with_for_update().first()
                    amount_eur = _amount_eur_from_cents(data.get("amount"))
                    if inv and amount_eur > 0:
                        dispute_reference = f"stripe:dispute:{dispute_id}"
                        reinstated_reference = f"stripe:dispute_reinstated:{dispute_id}"
                        reinstated = (
                            db.query(Payment)
                            .filter(Payment.invoice_id == inv.id)
                            .filter(Payment.reference == reinstated_reference)
                            .first()
                        )
                        if event_type == "charge.dispute.funds_withdrawn" or status == "lost":
                            if reinstated is None:
                                created = _add_stripe_invoice_adjustment(
                                    inv,
                                    amount=-amount_eur,
                                    reference=dispute_reference,
                                    provider_id=dispute_id,
                                    method="chargeback",
                                )
                                if created:
                                    db.commit()
                        elif event_type == "charge.dispute.funds_reinstated" or status == "won":
                            original = (
                                db.query(Payment)
                                .filter(Payment.invoice_id == inv.id)
                                .filter(Payment.reference == dispute_reference)
                                .first()
                            )
                            if original:
                                created = _add_stripe_invoice_adjustment(
                                    inv,
                                    amount=amount_eur,
                                    reference=reinstated_reference,
                                    provider_id=dispute_id,
                                    method="chargeback_reinstated",
                                )
                            else:
                                # A won/reinstated event may arrive first. Keep
                                # a zero-value tombstone so a late withdrawal
                                # cannot reopen the invoice incorrectly.
                                created = _add_stripe_invoice_adjustment(
                                    inv,
                                    amount=Decimal("0"),
                                    reference=reinstated_reference,
                                    provider_id=dispute_id,
                                    method="chargeback_reinstated_tombstone",
                                )
                            if created:
                                db.commit()

    elif event_type in {"customer.subscription.updated", "customer.subscription.created"}:
        sub = data
        status = sub.get("status")
        sub_id = sub.get("id")
        cust_id = sub.get("customer")
        items = (sub.get("items") or {}).get("data") or []
        if len(items) != 1:
            _retry_webhook(
                409,
                "subscription_items_reconciliation_pending",
                "La composition de l'abonnement est en attente de rapprochement.",
            )
        item_quantity = _safe_int(items[0].get("quantity"))
        if item_quantity not in {None, 1}:
            _retry_webhook(
                409,
                "subscription_quantity_reconciliation_pending",
                "La quantité de l'abonnement est en attente de rapprochement.",
            )
        price_id = (items[0].get("price") or {}).get("id")
        plan_val = _plan_from_price(price_id)
        if plan_val is None:
            _retry_webhook(
                409,
                "subscription_price_reconciliation_pending",
                "Le tarif de l'abonnement est en attente de rapprochement.",
            )

        sub_meta = sub.get("metadata") or {}
        metadata_tenant_id = (sub_meta.get("tenant_id") or "").strip() or None
        t = _strict_subscription_tenant(
            db,
            subscription_id=str(sub_id or "").strip() or None,
            customer_id=str(cust_id or "").strip() or None,
            metadata_tenant_id=metadata_tenant_id,
        )
        if t:
            try:
                _update_tenant(
                    t,
                    plan_val,
                    cust_id,
                    sub_id,
                    status,
                    provider_welcome_reservation_id=(
                        (sub_meta.get("provider_welcome_reservation_id") or "").strip() or None
                    ),
                    subscription_lifecycle_event=True,
                )
            except ProviderTokenInventoryError as exc:
                try:
                    logger.exception(
                        "subscription_entitlement_reconciliation_pending",
                        extra={"tenant_id": str(t.id), "subscription": _mask_stripe_id(sub_id)},
                    )
                except Exception:
                    pass
                _retry_webhook(
                    409,
                    "subscription_entitlement_reconciliation_pending",
                    "L'activation de l'abonnement est en attente de rapprochement.",
                )
                raise AssertionError("unreachable") from exc
        elif metadata_tenant_id:
            _retry_webhook(
                409,
                "subscription_owner_reconciliation_pending",
                "L'abonnement est en attente de rapprochement.",
            )

    elif event_type == "customer.subscription.deleted":
        sub = data
        t = db.query(Tenant).filter(Tenant.stripe_subscription_id == sub.get("id")).first()
        if t:
            _update_tenant(
                t,
                None,
                None,
                sub.get("id"),
                "canceled",
                subscription_lifecycle_event=True,
            )

    elif event_type in {"invoice.payment_failed", "invoice.payment_action_required"}:
        subscription_id = (data.get("subscription") or "").strip() or None
        customer_id = (data.get("customer") or "").strip() or None
        t = None
        if subscription_id:
            t = db.query(Tenant).filter(Tenant.stripe_subscription_id == subscription_id).first()
        if not t and customer_id:
            customer_tenant = db.query(Tenant).filter(Tenant.stripe_customer_id == customer_id).first()
            if customer_tenant and not str(customer_tenant.stripe_subscription_id or "").strip():
                t = customer_tenant
        if t:
            _update_tenant(
                t,
                None,
                customer_id,
                subscription_id,
                "past_due",
                subscription_lifecycle_event=True,
            )
        try:
            logger.warning(
                json.dumps(
                    {
                        "event": event_type,
                        "tenant_id": getattr(t, "id", None),
                        "stripe_customer": _mask_stripe_id(customer_id),
                        "stripe_subscription": _mask_stripe_id(subscription_id),
                    }
                )
            )
        except Exception:
            pass

    elif event_type in {"checkout.session.async_payment_failed", "checkout.session.expired"}:
        meta = data.get("metadata") or {}
        kind = (meta.get("kind") or meta.get("type") or "").strip().lower()
        tenant_id = (meta.get("tenant_id") or "").strip() or None
        checkout_session_id = (data.get("id") or "").strip() or None
        reservation_id = (
            (meta.get("provider_token_reservation_id") or "").strip()
            or (meta.get("provider_welcome_reservation_id") or "").strip()
            or None
        )
        if kind in {"token_topup", "subscription"} and reservation_id:
            try:
                release_reservation(db, reservation_id=reservation_id)
                db.commit()
            except ProviderTokenReservationStateError:
                db.rollback()
        if kind == "subscription" and tenant_id:
            _clear_subscription_checkout(
                db,
                tenant_id=tenant_id,
                session_id=checkout_session_id,
            )
            db.commit()
        try:
            logger.warning(
                json.dumps(
                    {
                        "event": event_type,
                        "tenant_id": meta.get("tenant_id"),
                        "kind": meta.get("kind") or meta.get("type"),
                    }
                )
            )
        except Exception:
            pass
    se = db.query(StripeEvent).filter(StripeEvent.event_id == event_id).first()
    if se:
        se.processed_at = _utcnow()
        db.add(se)
        db.commit()
    return {"received": True, "duplicate": False}
