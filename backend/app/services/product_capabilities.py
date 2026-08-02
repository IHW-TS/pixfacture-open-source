from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException

from ..config import _has_placeholder, settings
from ..core.plans import Plan
from ..models import Tenant
_PLAN_ORDER = [Plan.STARTER, Plan.PRO, Plan.ENTERPRISE]
_FEATURE_MINIMUM_PLAN: dict[str, Plan] = {
    "einvoicing_enabled": Plan.PRO,
    "chorus_enabled": Plan.PRO,
    "seqino_enabled": Plan.PRO,
    "token_topup_enabled": Plan.PRO,
    "purchases_enabled": Plan.PRO,
    "payments_enabled": Plan.PRO,
    "card_payments": Plan.PRO,
}
_FEATURE_LABELS = {
    "billing_enabled": "gestion des abonnements",
    "einvoicing_enabled": "e-facturation",
    "chorus_enabled": "Chorus",
    "seqino_enabled": "plateforme partenaire",
    "token_topup_enabled": "jetons de transmission",
    "purchases_enabled": "gestion des achats",
    "payments_enabled": "suivi des paiements",
    "card_payments": "paiement carte des factures",
}


def normalize_plan(value: str | None) -> Plan:
    raw = (value or "").strip().lower()
    for plan in Plan:
        if plan.value == raw:
            return plan
    return Plan.STARTER


def _plan_at_least(current: Plan, minimum: Plan) -> bool:
    return _PLAN_ORDER.index(current) >= _PLAN_ORDER.index(minimum)


def billing_enabled() -> bool:
    return bool(settings.BILLING_ENABLED or settings.SUBSCRIPTION_REQUIRED)


def _has_value(value: object | None) -> bool:
    if value is None:
        return False
    return bool(str(value).strip())


def _is_configured(value: object | None) -> bool:
    return _has_value(value) and not _has_placeholder(str(value))


def _seqino_configured() -> bool:
    return bool(
        _is_configured(settings.SEQINO_BASE_URL)
        and _is_configured(settings.SEQINO_SPONSOR_ID)
        and (_is_configured(settings.SEQINO_ACCESS_TOKEN) or _is_configured(settings.SEQINO_API_KEY))
    )


def _chorus_configured() -> bool:
    if not (
        _is_configured(settings.PISTE_CLIENT_ID)
        and _is_configured(settings.PISTE_CLIENT_SECRET)
        and _is_configured(settings.PISTE_TOKEN_URL)
        and _is_configured(settings.CHORUS_API_BASE)
        and _is_configured(settings.CHORUS_SUBMIT_PATH)
        and _is_configured(settings.CHORUS_STATUS_PATH)
        and _is_configured(settings.CHORUS_SUBMIT_EXTRA_JSON)
    ):
        return False
    try:
        extra = json.loads(settings.CHORUS_SUBMIT_EXTRA_JSON or "{}")
    except Exception:
        return False
    if not isinstance(extra, dict):
        return False
    return _is_configured(extra.get("syntaxeFlux") or extra.get("syntaxe_flux"))


def build_product_capabilities(tenant: Tenant | None) -> dict[str, Any]:
    plan = normalize_plan(getattr(tenant, "plan", None))
    subscription_status = (getattr(tenant, "subscription_status", None) or "").strip().lower()
    has_active_subscription = subscription_status in {"active", "trialing"}
    features_allowed = (not billing_enabled()) or has_active_subscription
    pro_plan = _plan_at_least(plan, Plan.PRO)
    pro_features_available = features_allowed and pro_plan
    # This plan-only serializer has no database session and therefore cannot
    # prove a tenant connection, issuer mandate or Chorus technical account.
    # Never label a remote connector "operational" from global env alone;
    # connected_mode_decision() is the tenant-aware authority before I/O.
    seqino_operational = False
    chorus_operational = False
    einvoicing_operational = seqino_operational or chorus_operational
    return {
        "plan": plan.value,
        "billing_enabled": billing_enabled(),
        "einvoicing_available_by_plan": pro_plan,
        "chorus_available_by_plan": pro_plan,
        "seqino_available_by_plan": pro_plan,
        "token_topup_available_by_plan": pro_plan,
        "purchases_available_by_plan": pro_plan,
        "payments_available_by_plan": pro_plan,
        "einvoicing_operational": einvoicing_operational,
        "chorus_operational": chorus_operational,
        "seqino_operational": seqino_operational,
        # Backward-compatible names used by existing plan guards.
        # Use the *_operational fields when the UI needs to know whether a
        # connector is actually configured and usable.
        "einvoicing_enabled": pro_features_available,
        "chorus_enabled": pro_features_available,
        "seqino_enabled": pro_features_available,
        "token_topup_enabled": pro_features_available,
        "purchases_enabled": pro_features_available,
        "payments_enabled": pro_features_available,
        "card_payments": False,
        "upgrade_plan": Plan.PRO.value,
    }


def is_product_feature_enabled(tenant: Tenant | None, feature: str) -> bool:
    capabilities = build_product_capabilities(tenant)
    if feature not in capabilities:
        raise RuntimeError(f"Feature produit inconnue: {feature}")
    return bool(capabilities[feature])


def build_feature_access_error(feature: str, tenant: Tenant | None = None) -> HTTPException:
    label = _FEATURE_LABELS.get(feature, "cette fonctionnalité")
    message_label = label[:1].upper() + label[1:] if label else "Cette fonctionnalité"
    required_plan = _FEATURE_MINIMUM_PLAN.get(feature, Plan.PRO)
    current_plan = normalize_plan(getattr(tenant, "plan", None))
    needs_reactivation = billing_enabled() and _plan_at_least(current_plan, required_plan)
    return HTTPException(
        status_code=403,
        detail={
            "code": "subscription_reactivation_required" if needs_reactivation else "plan_upgrade_required",
            "feature": feature,
            "required_plan": required_plan.value,
            "cta": "/app/billing",
            "message": (
                f"{message_label} nécessite la réactivation de votre abonnement {current_plan.value.title()}."
                if needs_reactivation
                else f"{message_label} est disponible à partir du plan Pro. Passez au plan Pro pour l'activer."
            ),
        },
    )


def ensure_product_feature(tenant: Tenant | None, feature: str) -> None:
    if is_product_feature_enabled(tenant, feature):
        return
    raise build_feature_access_error(feature, tenant)
