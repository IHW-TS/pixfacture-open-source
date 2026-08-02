from __future__ import annotations

import hashlib

from ..models import Tenant
from ..services.pdp.utils import PdpProviderError
from .subscription_entitlements import grant_subscription_entitlements
from .provider_token_inventory import (
    ProviderTokenInventoryError,
    consume_tenant_allocations,
    get_inventory_status,
    refund_tenant_consumption,
)
from .tokens import InsufficientTokens, apply_refund, consume, get_balance


def _insufficient_tokens_message(balance: int, required_tokens: int) -> str:
    return (
        "Solde de jetons insuffisant pour une transmission connectée. "
        f"Jetons disponibles: {balance}. "
        f"Jetons requis: {required_tokens}. "
        "Rechargez un pack depuis Abonnement."
    )


def _provider_stock_message() -> str:
    return (
        "Les transmissions sont temporairement indisponibles. "
        "Vos jetons restent acquis ; réessayez plus tard ou contactez l'assistance."
    )


def _provider_idempotency_key(prefix: str, tenant_id: str, reference_type: str, reference_id: str) -> str:
    digest = hashlib.sha256(
        f"{tenant_id}:{reference_type}:{reference_id}".encode("utf-8")
    ).hexdigest()
    return f"{prefix}:{digest}"


def _trial_transmission_message() -> str:
    return (
        "Les transmissions Seqino réelles sont désactivées pendant l'essai 7 jours. "
        "Vous pouvez préparer vos documents ; l'envoi exige ensuite un abonnement Pro finalisé, un contrat, "
        "un mandat et une configuration opérationnelle."
    )


def _tenant_for_seqino_tokens(db, tenant_id: str) -> Tenant | None:
    return db.get(Tenant, tenant_id)


def _raise_if_trialing(tenant: Tenant | None) -> None:
    status = (getattr(tenant, "subscription_status", None) or "").strip().lower()
    if status == "trialing":
        raise PdpProviderError(
            _trial_transmission_message(),
            code="trial_seqino_transmissions_disabled",
        )


def _ensure_existing_pro_entitlements(db, tenant_id: str) -> None:
    tenant = _tenant_for_seqino_tokens(db, tenant_id)
    if tenant:
        grant_subscription_entitlements(db, tenant)


def ensure_seqino_tokens_available_or_raise(
    db,
    tenant_id: str,
    *,
    units: int = 1,
    provider_slug: str = "seqino",
) -> int:
    _raise_if_trialing(_tenant_for_seqino_tokens(db, tenant_id))
    _ensure_existing_pro_entitlements(db, tenant_id)
    required_tokens = max(1, int(units or 1))
    balance = get_balance(db, tenant_id)
    if balance < required_tokens:
        raise PdpProviderError(
            _insufficient_tokens_message(balance, required_tokens),
            code="token_balance_insufficient",
        )
    inventory = get_inventory_status(db, provider_slug=provider_slug)
    if not inventory.invariant_valid or inventory.coverage_gap_tokens > 0:
        raise PdpProviderError(
            _provider_stock_message(),
            code="provider_token_stock_unavailable",
        )
    return balance


def consume_seqino_tokens_or_raise(
    db,
    tenant_id: str,
    *,
    reference_type: str,
    reference_id: str,
    units: int = 1,
    provider_slug: str = "seqino",
) -> int:
    _raise_if_trialing(_tenant_for_seqino_tokens(db, tenant_id))
    _ensure_existing_pro_entitlements(db, tenant_id)
    quantity = max(1, int(units or 1))
    try:
        consume_tenant_allocations(
            db,
            tenant_id=tenant_id,
            quantity=quantity,
            idempotency_key=_provider_idempotency_key(
                "provider-consume",
                tenant_id,
                reference_type,
                reference_id,
            ),
            reference_type=reference_type,
            reference_id=reference_id,
            provider_slug=provider_slug,
        )
        balance = consume(
            db,
            tenant_id,
            quantity,
            reference_type,
            reference_id,
            commit=False,
        )
        db.commit()
        return balance
    except ProviderTokenInventoryError as exc:
        db.rollback()
        raise PdpProviderError(
            _provider_stock_message(),
            code="provider_token_stock_unavailable",
        ) from exc
    except InsufficientTokens as exc:
        balance = int(exc.balance or 0)
        required_tokens = int(exc.required_tokens or max(1, int(units or 1)))
        raise PdpProviderError(
            _insufficient_tokens_message(balance, required_tokens),
            code="token_balance_insufficient",
        ) from exc


def refund_seqino_tokens_after_certain_failure(
    db,
    tenant_id: str,
    *,
    reference_type: str,
    reference_id: str,
    units: int = 1,
    provider_slug: str = "seqino",
) -> int:
    """Refund wallet and provider backing atomically after a certain failure."""

    quantity = max(1, int(units or 1))
    refund_reference_type = f"{reference_type}_refund"
    refund_key = _provider_idempotency_key(
        "provider-refund",
        tenant_id,
        reference_type,
        reference_id,
    )
    try:
        refund_tenant_consumption(
            db,
            tenant_id=tenant_id,
            quantity=quantity,
            original_reference_type=reference_type,
            original_reference_id=reference_id,
            idempotency_key=refund_key,
            provider_slug=provider_slug,
            refund_reference_type=refund_reference_type,
            refund_reference_id=reference_id,
        )
        balance = apply_refund(
            db,
            tenant_id,
            quantity,
            reference_type=refund_reference_type,
            reference_id=reference_id,
            commit=False,
        )
        db.commit()
        return balance
    except Exception:
        db.rollback()
        raise
