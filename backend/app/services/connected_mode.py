from __future__ import annotations

from dataclasses import dataclass
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import (
    _has_placeholder,
    parse_connected_mode_allowed_providers,
    parse_connected_mode_allowed_tenant_ids,
    settings,
)
from ..models import PdpConnection, Tenant
from .chorus import chorus_cpro_account_is_valid
from .integration_secrets import enrich_credentials_with_secrets, resolve_seqino_credentials
from .product_capabilities import build_feature_access_error, build_product_capabilities


_PROVIDER_CAPABILITY = {
    "seqino": "seqino_operational",
    "chorus": "chorus_operational",
    "choruspro": "chorus_operational",
}
_PROVIDER_FEATURE = {
    "seqino": "seqino_enabled",
    "chorus": "chorus_enabled",
    "choruspro": "chorus_enabled",
    "ppf": "einvoicing_enabled",
}
_ROLLOUT_PROVIDERS = {None, "seqino", "chorus", "choruspro", "ppf"}


@dataclass(frozen=True)
class ConnectedModeDecision:
    allowed: bool
    code: str | None
    provider: str | None
    feature: str
    message: str


def _normalize_provider(provider_slug: str | None) -> str | None:
    normalized = (provider_slug or "").strip().lower().replace("-", "_")
    if normalized in {"chorus", "chorus_pro"}:
        return "choruspro"
    if normalized in {"partnerx", "pdp_partner", "pdp"}:
        return "seqino"
    return normalized or None


def _connected_mode_error(
    provider_slug: str | None,
    *,
    code: str | None = None,
    message: str | None = None,
) -> HTTPException:
    provider = _normalize_provider(provider_slug)
    if settings.EINVOICING_EXPORT_ONLY:
        return HTTPException(
            status_code=409,
            detail={
                "code": "export_only",
                "provider": provider,
                "message": "Mode export uniquement : les actions de plateforme agréée sont désactivées.",
            },
        )
    return HTTPException(
        status_code=409,
        detail={
            "code": code or "connected_mode_not_operational",
            "provider": provider,
            "message": message or "Le mode connecté n'est pas opérationnel pour ce fournisseur.",
        },
    )


def _has_value(value: object | None) -> bool:
    return value is not None and bool(str(value).strip())


def _is_configured(value: object | None) -> bool:
    return _has_value(value) and not _has_placeholder(str(value))


def connected_mode_tenant_is_allowed(tenant_id: str | None) -> bool:
    tenant_id_value = str(tenant_id or "").strip()
    allowed_tenant_ids = parse_connected_mode_allowed_tenant_ids()
    if not tenant_id_value or not allowed_tenant_ids:
        return False
    env = (settings.APP_ENV or "").strip().lower()
    if "*" in allowed_tenant_ids and env not in {"prod", "production", "staging"}:
        return True
    return tenant_id_value in allowed_tenant_ids


def connected_mode_provider_is_allowed(provider_slug: str | None) -> bool:
    provider = _normalize_provider(provider_slug)
    allowed_providers = parse_connected_mode_allowed_providers()
    if not allowed_providers:
        return False
    env = (settings.APP_ENV or "").strip().lower()
    if "*" in allowed_providers and env not in {"prod", "production", "staging"}:
        return True
    if provider is None:
        return bool(allowed_providers.intersection({"seqino", "choruspro", "ppf"}))
    return provider in allowed_providers


def ensure_connected_mode_rollout_allowed(
    db: Session,
    tenant_id: str,
    provider_slug: str | None = None,
) -> None:
    provider = _normalize_provider(provider_slug)
    if provider not in _ROLLOUT_PROVIDERS:
        return
    if db.get(Tenant, tenant_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "tenant_not_found", "message": "Entreprise introuvable pour l'appel fournisseur."},
        )
    if connected_mode_tenant_is_allowed(tenant_id) and connected_mode_provider_is_allowed(provider):
        return
    if connected_mode_tenant_is_allowed(tenant_id):
        raise _connected_mode_error(
            provider,
            code="connected_mode_provider_not_allowed",
            message="Ce fournisseur n'est pas activé pour le pilote de cet espace.",
        )
    raise _connected_mode_error(
        provider,
        code="connected_mode_tenant_not_allowed",
        message="Le mode connecté n'est pas encore activé pour cet espace.",
    )


def _seqino_configured_for_tenant(db: Session, tenant_id: str) -> bool:
    access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id)
    return bool(
        _is_configured(settings.SEQINO_BASE_URL)
        and _is_configured(access_token)
        and _is_configured(sponsor_id)
    )


def _chorus_configured_for_tenant(db: Session, tenant_id: str) -> bool:
    credentials = enrich_credentials_with_secrets(db, tenant_id, {})
    tenant = db.get(Tenant, tenant_id)
    tenant_siret = "".join(ch for ch in str(getattr(tenant, "siret", "") or "") if ch.isdigit())
    connection = (
        db.query(PdpConnection)
        .filter(
            PdpConnection.tenant_id == tenant_id,
            PdpConnection.provider_slug == "choruspro",
            PdpConnection.status == "connected",
        )
        .first()
    )
    try:
        extra = json.loads(settings.CHORUS_SUBMIT_EXTRA_JSON or "{}")
    except Exception:
        return False
    syntax = None
    if isinstance(extra, dict):
        syntax = extra.get("syntaxeFlux") or extra.get("syntaxe_flux")
    return bool(
        connection
        and len(tenant_siret) == 14
        and str(connection.verified_siret or "") == tenant_siret
        and bool(connection.verified_structure_id)
        and connection.verified_at is not None
        and _is_configured(credentials.get("piste_client_id"))
        and _is_configured(credentials.get("piste_client_secret"))
        and _is_configured(credentials.get("piste_token_url"))
        and _is_configured(credentials.get("chorus_api_base"))
        and _is_configured(settings.CHORUS_SUBMIT_PATH)
        and _is_configured(settings.CHORUS_STATUS_PATH)
        and chorus_cpro_account_is_valid(str(credentials.get("chorus_cpro_account") or ""))
        and _is_configured(syntax)
    )


def _ppf_configured() -> bool:
    return bool(
        _is_configured(settings.PPF_DIRECTORY_BASE_URL)
        and _is_configured(settings.PPF_DIRECTORY_CLIENT_ID)
        and _is_configured(settings.PPF_DIRECTORY_CLIENT_SECRET)
        and _is_configured(settings.PPF_DIRECTORY_TOKEN_URL)
    )


def connected_mode_decision(
    db: Session,
    tenant_id: str,
    provider_slug: str | None = None,
) -> ConnectedModeDecision:
    """Return the single fail-closed decision used before external provider I/O.

    The decision intentionally combines entitlement, subscription state,
    export-only policy and effective provider configuration. It performs no
    network call and never returns credentials.
    """

    provider = _normalize_provider(provider_slug)
    feature = _PROVIDER_FEATURE.get(provider or "", "einvoicing_enabled")
    tenant = db.get(Tenant, tenant_id)
    if tenant is None:
        return ConnectedModeDecision(
            allowed=False,
            code="tenant_not_found",
            provider=provider,
            feature=feature,
            message="Entreprise introuvable pour l'appel fournisseur.",
        )

    if (tenant.subscription_status or "").strip().lower() == "trialing":
        return ConnectedModeDecision(
            allowed=False,
            code="trial_connected_mode_disabled",
            provider=provider,
            feature=feature,
            message=(
                "Pendant l’essai de 7 jours, la préparation et les exports locaux restent disponibles, "
                "sans appel réel à une plateforme externe."
            ),
        )

    capabilities = build_product_capabilities(tenant)
    if not bool(capabilities.get(feature)):
        available_by_plan = bool(capabilities.get(feature.replace("_enabled", "_available_by_plan")))
        code = "subscription_reactivation_required" if available_by_plan else "plan_upgrade_required"
        return ConnectedModeDecision(
            allowed=False,
            code=code,
            provider=provider,
            feature=feature,
            message=(
                "L'abonnement Pro doit être réactivé avant tout appel fournisseur."
                if available_by_plan
                else "Le plan Pro est requis avant tout appel fournisseur."
            ),
        )

    if settings.EINVOICING_EXPORT_ONLY:
        return ConnectedModeDecision(
            allowed=False,
            code="export_only",
            provider=provider,
            feature=feature,
            message="Mode export uniquement : aucun appel fournisseur n'est autorisé.",
        )

    if provider in _ROLLOUT_PROVIDERS and not connected_mode_tenant_is_allowed(tenant_id):
        return ConnectedModeDecision(
            allowed=False,
            code="connected_mode_tenant_not_allowed",
            provider=provider,
            feature=feature,
            message="Le mode connecté n'est pas encore activé pour cet espace.",
        )

    if provider in _ROLLOUT_PROVIDERS and not connected_mode_provider_is_allowed(provider):
        return ConnectedModeDecision(
            allowed=False,
            code="connected_mode_provider_not_allowed",
            provider=provider,
            feature=feature,
            message="Ce fournisseur n'est pas activé pour le pilote de cet espace.",
        )

    # Test-only providers exercise the local connector pipeline without being
    # a customer-facing remote integration.
    env = (settings.APP_ENV or "").strip().lower()
    if provider in {"dummy", "mock"} and env not in {"prod", "production", "staging"}:
        return ConnectedModeDecision(True, None, provider, feature, "Connecteur local de test autorisé.")
    if provider not in {None, "seqino", "chorus", "choruspro", "ppf"} and env == "test":
        return ConnectedModeDecision(True, None, provider, feature, "Connecteur unitaire de test autorisé.")

    if provider == "seqino":
        configured = _seqino_configured_for_tenant(db, tenant_id)
    elif provider in {"chorus", "choruspro"}:
        configured = _chorus_configured_for_tenant(db, tenant_id)
    elif provider == "ppf":
        configured = _ppf_configured()
    elif provider is None:
        configured = bool(
            (
                connected_mode_provider_is_allowed("seqino")
                and _seqino_configured_for_tenant(db, tenant_id)
            )
            or (
                connected_mode_provider_is_allowed("choruspro")
                and _chorus_configured_for_tenant(db, tenant_id)
            )
            or (connected_mode_provider_is_allowed("ppf") and _ppf_configured())
        )
    else:
        capability = _PROVIDER_CAPABILITY.get(provider, "einvoicing_operational")
        configured = bool(capabilities.get(capability))

    if not configured:
        return ConnectedModeDecision(
            allowed=False,
            code="connected_mode_not_operational",
            provider=provider,
            feature=feature,
            message="Le mode connecté n'est pas opérationnel pour ce fournisseur.",
        )
    return ConnectedModeDecision(True, None, provider, feature, "Mode connecté opérationnel.")


def is_connected_mode_operational(
    db: Session,
    tenant_id: str,
    provider_slug: str | None = None,
) -> bool:
    return connected_mode_decision(db, tenant_id, provider_slug).allowed


def build_tenant_product_capabilities(db: Session, tenant: Tenant | None) -> dict[str, object]:
    """Serialize product capabilities with tenant-scoped connector readiness.

    The plan-only serializer deliberately reports every connector as
    non-operational. A session endpoint may call this DB-aware serializer, which
    reuses the exact fail-closed gate enforced before provider I/O. No global
    credential alone can make a connector appear operational.
    """

    capabilities: dict[str, object] = build_product_capabilities(tenant)
    tenant_id = str(getattr(tenant, "id", "") or "").strip()
    if not tenant_id:
        return capabilities
    seqino_connection = (
        db.query(PdpConnection.id)
        .filter(
            PdpConnection.tenant_id == tenant_id,
            PdpConnection.provider_slug == "seqino",
            PdpConnection.status == "connected",
        )
        .first()
    )
    seqino_operational = bool(
        seqino_connection and connected_mode_decision(db, tenant_id, "seqino").allowed
    )
    chorus_operational = connected_mode_decision(db, tenant_id, "choruspro").allowed
    capabilities["seqino_operational"] = seqino_operational
    capabilities["chorus_operational"] = chorus_operational
    capabilities["einvoicing_operational"] = seqino_operational or chorus_operational
    return capabilities


def ensure_connected_mode_operational(
    db: Session,
    tenant_id: str,
    provider_slug: str | None = None,
) -> None:
    """Fail closed before any connector mutation or provider call.

    This is safe to call both behind route-level product dependencies and from
    background jobs/services: it preserves the public plan/subscription error
    contract while also enforcing export-only and provider configuration.
    """

    decision = connected_mode_decision(db, tenant_id, provider_slug)
    if decision.allowed:
        return
    tenant = db.get(Tenant, tenant_id)
    if decision.code in {"plan_upgrade_required", "subscription_reactivation_required"}:
        raise build_feature_access_error(decision.feature, tenant)
    if decision.code == "tenant_not_found":
        raise HTTPException(status_code=404, detail={"code": decision.code, "message": decision.message})
    if decision.code == "trial_connected_mode_disabled":
        raise HTTPException(
            status_code=409,
            detail={
                "code": decision.code,
                "provider": decision.provider,
                "message": decision.message,
                "remediation_url": "/app/billing",
            },
        )
    raise _connected_mode_error(
        decision.provider,
        code=decision.code,
        message=decision.message,
    )
