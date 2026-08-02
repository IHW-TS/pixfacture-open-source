from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
import hashlib
import time
import stripe

from ..config import settings
from ..db import get_db
from ..deps import (
    AuthUser,
    ensure_legal_acceptance,
    require_product_capability,
    require_product_feature,
    require_tenant_admin,
    require_viewer_or_admin,
)
from ..models import PdpConnection, Tenant
from ..services.connected_mode import connected_mode_decision
from ..services.token_packs import (
    TOKEN_PACK_OFFERS,
    token_pack_checkout_error_detail,
    token_pack_price_validation_reason,
)
from ..services.subscription_entitlements import grant_subscription_entitlements
from ..services.stripe_mode import livemode_validation_reason
from ..services.stripe_runtime import (
    get_stripe_runtime_status,
    stripe_checkout_error_is_definite,
)
from ..services.tokens import get_token_state
from ..services.seqino_mandates import seqino_has_active_mandate_for_issuer
from ..services.provider_token_inventory import (
    CHECKOUT_RESERVATION_TTL_SECONDS,
    CHECKOUT_SESSION_TTL_SECONDS,
    InsufficientProviderTokens,
    ProviderTokenInventoryError,
    ProviderTokenReservationLimitExceeded,
    bind_reservation_to_stripe_checkout,
    get_inventory_status,
    release_reservation,
    reserve_tokens,
)
from ..services.stripe_customers import sync_stripe_customer_for_tenant


router = APIRouter(prefix="/api/tokens", tags=["tokens"])


def _token_transmissions_operational() -> bool:
    return not bool(settings.EINVOICING_EXPORT_ONLY)


def _token_pack_catalog() -> tuple[int, ...]:
    return settings.stripe_token_pack_sizes()


def _tenant_seqino_ready(db: Session, tenant: Tenant) -> bool:
    """Allow a purchase only when this tenant can actually use Seqino."""

    tenant_id = str(tenant.id or "").strip()
    if not tenant_id or not connected_mode_decision(db, tenant_id, "seqino").allowed:
        return False
    connection = (
        db.query(PdpConnection.id)
        .filter(
            PdpConnection.tenant_id == tenant_id,
            PdpConnection.provider_slug == "seqino",
            PdpConnection.status.in_(["connected", "active"]),
        )
        .first()
    )
    if connection is None:
        return False
    siret = "".join(ch for ch in (tenant.siret or "") if ch.isdigit())
    siren = siret[:9] if len(siret) >= 9 else None
    return seqino_has_active_mandate_for_issuer(
        tenant_id,
        siren=siren,
        siret=siret if len(siret) == 14 else None,
        db=db,
    )


def _amount_display_from_cents(cents: int) -> str:
    euros = f"{max(int(cents or 0), 0) / 100:.2f}"
    return euros.rstrip("0").rstrip(".") or "0"


class TokenCheckoutPayload(BaseModel):
    pack: str
    checkout_request_id: str | None = None


def _stripe():
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(400, "Le paiement en ligne n'est pas disponible pour le moment.")
    stripe.api_key = settings.STRIPE_SECRET_KEY
    return stripe


def _stripe_tokens_redirect_urls() -> tuple[str, str]:
    success_url = (settings.STRIPE_TOKENS_SUCCESS_URL or settings.STRIPE_SUCCESS_URL or "").strip()
    cancel_url = (settings.STRIPE_TOKENS_CANCEL_URL or settings.STRIPE_CANCEL_URL or "").strip()
    if not success_url or not cancel_url:
        raise HTTPException(
            status_code=500,
            detail={
                "code": "stripe_redirect_url_missing",
                "message": "Le paiement en ligne n'est pas disponible pour le moment.",
            },
        )
    return success_url, cancel_url


def _token_redirect_urls_configured() -> bool:
    success_url = (settings.STRIPE_TOKENS_SUCCESS_URL or settings.STRIPE_SUCCESS_URL or "").strip()
    cancel_url = (settings.STRIPE_TOKENS_CANCEL_URL or settings.STRIPE_CANCEL_URL or "").strip()
    return bool(success_url and cancel_url)


def _pack_tokens(pack: str | None) -> int | None:
    if not pack:
        return None
    try:
        tokens = int(pack)
    except (TypeError, ValueError):
        return None
    return tokens if tokens > 0 else None


def _checkout_idempotency_suffix(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        return "server"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _pack_unavailable_message(reason: str | None) -> str:
    if reason == "transmissions_not_operational":
        return "Les packs seront disponibles quand la transmission Seqino sera réellement activée."
    if reason == "tenant_connector_not_ready":
        return "Finalisez l'activation et le mandat Seqino avant d'acheter des jetons."
    if reason in {"stripe_not_configured", "stripe_redirect_url_missing", "price_not_configured"}:
        return "Pack bientôt disponible."
    if reason in {"provider_stock_unavailable", "provider_stock_insufficient"}:
        return "Recharge temporairement indisponible. Vos jetons actuels restent utilisables."
    return "Pack temporairement indisponible."


def _token_pack_payload(db: Session, tenant: Tenant) -> list[dict[str, object]]:
    stripe_runtime = get_stripe_runtime_status(settings.STRIPE_SECRET_KEY)
    stripe_secret = bool(stripe_runtime.get("secret_configured"))
    stripe_ready = bool(stripe_runtime.get("ready"))
    redirects_ready = _token_redirect_urls_configured()
    configured = settings.stripe_token_prices()
    transmissions_operational = _token_transmissions_operational()
    tenant_ready = transmissions_operational and _tenant_seqino_ready(db, tenant)
    inventory = get_inventory_status(db)
    payload: list[dict[str, object]] = []
    for tokens in _token_pack_catalog():
        offer = TOKEN_PACK_OFFERS.get(tokens, {})
        raw_unit_amount = offer.get("unit_amount")
        unit_amount = int(raw_unit_amount) if isinstance(raw_unit_amount, int | float | str) else 0
        stock_ready = inventory.invariant_valid and inventory.sellable_tokens >= tokens
        checkout_enabled = tenant_ready and stripe_ready and redirects_ready and tokens in configured and stock_ready
        reason = None
        if not transmissions_operational:
            reason = "transmissions_not_operational"
        elif not tenant_ready:
            reason = "tenant_connector_not_ready"
        elif not stripe_secret:
            reason = "stripe_not_configured"
        elif not stripe_ready:
            reason = str(stripe_runtime.get("reason") or "stripe_unavailable")
        elif not redirects_ready:
            reason = "stripe_redirect_url_missing"
        elif tokens not in configured:
            reason = "price_not_configured"
        elif not inventory.invariant_valid:
            reason = "provider_stock_unavailable"
        elif inventory.sellable_tokens < tokens:
            reason = "provider_stock_insufficient"
        payload.append(
            {
                "pack": str(tokens),
                "tokens": tokens,
                "name": offer.get("name") or f"Pack {tokens} jetons",
                "description": offer.get("description")
                or f"Achat ponctuel de {tokens} jetons de transmission. Réservé au plan Pro.",
                "currency": "eur",
                "unit_amount": unit_amount,
                "unit_amount_decimal": str(unit_amount),
                "amount_display": _amount_display_from_cents(unit_amount),
                "pricing_source": "business_fallback",
                "required_plan": "pro",
                "price_configured": tokens in configured,
                "checkout_enabled": checkout_enabled,
                "availability": "checkout" if checkout_enabled else "unavailable",
                "reason": reason,
                "message": None if checkout_enabled else _pack_unavailable_message(reason),
            }
        )
    return payload


def _ensure_token_checkout_allowed(db: Session, tenant: Tenant) -> None:
    status = (tenant.subscription_status or "").strip().lower()
    if status == "trialing":
        raise HTTPException(
            status_code=402,
            detail={
                "code": "trial_token_topup_disabled",
                "message": (
                    "L'essai permet de préparer les documents sans acheter de transmissions réelles. "
                    "Les recharges exigent ensuite un abonnement Pro finalisé et un connecteur opérationnel."
                ),
                "remediation_url": "/app/billing",
            },
        )
    if not _token_transmissions_operational():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "transmissions_not_operational",
                "message": (
                    "Le connecteur de transmission n'est pas encore activé. "
                    "Les packs de jetons ne peuvent pas être achetés tant qu'ils ne sont pas utilisables."
                ),
                "remediation_url": "/app/einvoicing",
            },
        )
    if not _tenant_seqino_ready(db, tenant):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "tenant_connector_not_ready",
                "message": ("Finalisez l'activation du connecteur et du mandat Seqino avant d'acheter des jetons."),
                "remediation_url": "/app/einvoicing",
            },
        )


@router.get("/balance")
def balance(
    history_limit: int = Query(10, ge=1, le=100),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_product_capability("token_topup_enabled")),
):
    tenant = db.get(Tenant, user.tenant_id)
    grant_subscription_entitlements(db, tenant)
    return get_token_state(db, user.tenant_id, history_limit=history_limit)


@router.get("/state")
def state(
    history_limit: int = Query(10, ge=1, le=100),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_product_capability("token_topup_enabled")),
):
    tenant = db.get(Tenant, user.tenant_id)
    grant_subscription_entitlements(db, tenant)
    return get_token_state(db, user.tenant_id, history_limit=history_limit)


@router.get("/packs")
def packs(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_product_feature("token_topup_enabled")),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")
    return _token_pack_payload(db, tenant)


@router.post("/checkout")
def checkout(
    payload: TokenCheckoutPayload,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_product_feature("token_topup_enabled")),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")
    ensure_legal_acceptance(user, db)
    _ensure_token_checkout_allowed(db, tenant)
    pack = (payload.pack or "").strip()
    tokens = _pack_tokens(pack)
    if tokens not in _token_pack_catalog():
        raise HTTPException(
            status_code=400,
            detail={
                "code": "unsupported_token_pack",
                "message": "Pack de jetons non supporté.",
                "supported_packs": [str(value) for value in _token_pack_catalog()],
            },
        )
    if not (settings.STRIPE_SECRET_KEY or "").strip():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stripe_not_configured",
                "message": "Le paiement en ligne des recharges n'est pas disponible pour le moment.",
                "remediation_url": "/app/billing",
            },
        )
    stripe_runtime = get_stripe_runtime_status(settings.STRIPE_SECRET_KEY)
    if not stripe_runtime.get("ready"):
        raise HTTPException(
            status_code=409,
            detail={
                "code": stripe_runtime.get("reason") or "stripe_unavailable",
                "message": "Le paiement en ligne des recharges est temporairement indisponible.",
                "remediation_url": "/app/billing",
            },
        )
    if not _token_redirect_urls_configured():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stripe_redirect_url_missing",
                "message": "Les recharges de jetons ne sont pas disponibles pour le moment.",
                "remediation_url": "/app/billing",
            },
        )
    price_id = settings.stripe_token_prices().get(tokens)
    if not price_id:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "token_pack_unavailable",
                "message": "Ce pack de jetons n'est pas disponible pour le moment.",
                "pack": pack,
                "tokens": tokens,
                "remediation_url": "/app/billing",
            },
        )
    s = _stripe()
    try:
        price = s.Price.retrieve(price_id)
    except Exception as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "price_lookup_failed",
                "message": "Le prix de ce pack de jetons ne peut pas être vérifié pour le moment.",
                "pack": pack,
                "tokens": tokens,
                "contact_url": "/contact",
            },
        ) from exc
    validation_reason = token_pack_price_validation_reason(tokens, price, quantity=1)
    validation_reason = validation_reason or livemode_validation_reason(price, settings.STRIPE_SECRET_KEY)
    if validation_reason:
        raise HTTPException(
            status_code=409,
            detail=token_pack_checkout_error_detail(tokens, validation_reason),
        )
    checkout_request_id = (payload.checkout_request_id or "").strip()
    if not checkout_request_id:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "checkout_request_id_required",
                "message": "Actualisez la page puis relancez l'achat du pack.",
            },
        )
    success_url, cancel_url = _stripe_tokens_redirect_urls()
    customer_id = sync_stripe_customer_for_tenant(s, db, tenant, user)
    suffix = _checkout_idempotency_suffix(checkout_request_id)
    try:
        reservation_scope = f"stripe-token-checkout:{tokens}"
        reservation = reserve_tokens(
            db,
            tenant_id=str(tenant.id),
            quantity=tokens,
            idempotency_key=f"{reservation_scope}:{suffix}",
            # Unbound ambiguous requests live beyond Stripe's retry window.
            # Once bound to a Session, only a terminal Stripe event releases it.
            ttl_seconds=CHECKOUT_RESERVATION_TTL_SECONDS,
            exclusive_checkout_scope=reservation_scope,
        )
        db.commit()
    except ProviderTokenReservationLimitExceeded as exc:
        db.rollback()
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
    except InsufficientProviderTokens as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "provider_token_stock_insufficient",
                "message": "Cette recharge est temporairement indisponible. Vos jetons actuels restent utilisables.",
            },
        ) from exc
    except ProviderTokenInventoryError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "provider_token_stock_unavailable",
                "message": "Les recharges sont temporairement indisponibles. Réessayez plus tard.",
            },
        ) from exc
    metadata = {
        "kind": "token_topup",
        "tenant_id": tenant.id,
        "pack": pack,
        "provider_token_reservation_id": str(reservation.id),
    }
    session_payload = {
        "mode": "payment",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "line_items": [{"price": price_id, "quantity": 1}],
        "payment_method_types": ["card"],
        "expires_at": int(time.time()) + CHECKOUT_SESSION_TTL_SECONDS,
        "metadata": metadata,
        "client_reference_id": tenant.id,
        "idempotency_key": (f"token-topup-checkout:{tenant.id}:{reservation.id}"),
    }
    session_payload["customer"] = customer_id
    try:
        session = s.checkout.Session.create(**session_payload)
    except Exception as exc:
        if stripe_checkout_error_is_definite(exc):
            db.rollback()
            try:
                release_reservation(db, reservation_id=str(reservation.id))
                db.commit()
            except ProviderTokenInventoryError:
                db.rollback()
        # A transport error can be ambiguous: retain the reconciliation hold
        # beyond Stripe's webhook retry window so a possibly-created Session
        # can never oversell supplier stock.
        raise HTTPException(
            status_code=503,
            detail={
                "code": "token_checkout_temporarily_unavailable",
                "message": "Le paiement sécurisé n'a pas pu être ouvert. Réessayez dans quelques instants.",
            },
        ) from exc
    stripe_checkout_session_id = str(getattr(session, "id", None) or "").strip()
    if not stripe_checkout_session_id:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "token_checkout_session_missing",
                "message": "Le paiement sécurisé n'a pas pu être confirmé. Réessayez dans quelques instants.",
            },
        )
    try:
        bind_reservation_to_stripe_checkout(
            db,
            reservation_id=str(reservation.id),
            stripe_checkout_session_id=stripe_checkout_session_id,
            checkout_kind="token_topup",
            checkout_expires_at=getattr(session, "expires_at", None),
        )
        db.commit()
    except ProviderTokenInventoryError as exc:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={
                "code": "token_checkout_reconciliation_pending",
                "message": "Le paiement sécurisé est en cours de rapprochement. Réessayez dans quelques instants.",
            },
        ) from exc
    if not getattr(session, "url", None):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "token_checkout_url_missing",
                "message": "Le paiement sécurisé n'a pas pu être ouvert. Réessayez dans quelques instants.",
            },
        )
    return {"url": session.url}
