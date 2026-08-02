from __future__ import annotations

from ..core.plans import Plan
from ..models import Tenant
from .provider_token_inventory import ProviderTokenInventoryError
from .tokens import grant_pro_welcome_tokens_once

_ENTITLEMENT_SUBSCRIPTION_STATUSES = {"active"}


def has_effective_pro_subscription(tenant: Tenant | None) -> bool:
    if not tenant:
        return False
    plan = (getattr(tenant, "plan", None) or "").strip().lower()
    status = (getattr(tenant, "subscription_status", None) or "").strip().lower()
    return plan == Plan.PRO.value and status in _ENTITLEMENT_SUBSCRIPTION_STATUSES


def grant_subscription_entitlements(
    db,
    tenant: Tenant | None,
    *,
    provider_welcome_reservation_id: str | None = None,
    require_welcome_grant: bool = False,
) -> bool:
    tenant_id = getattr(tenant, "id", None) if tenant else None
    if not tenant_id:
        return False
    if not has_effective_pro_subscription(tenant):
        return False
    result = grant_pro_welcome_tokens_once(
        db,
        str(tenant_id),
        provider_reservation_id=provider_welcome_reservation_id,
    )
    if require_welcome_grant and result.get("reason") == "provider_stock_unavailable":
        raise ProviderTokenInventoryError(
            "La réservation du bonus Pro doit être rapprochée avant activation."
        )
    return bool(result.get("granted"))
