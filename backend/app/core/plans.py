from enum import Enum
from fastapi import HTTPException
from ..models import Tenant


class Plan(str, Enum):
    STARTER = "starter"
    PRO = "pro"
    ENTERPRISE = "enterprise"

# Pricing alignment (product truth):
# - CSV export + Stripe portal: accessible to all paid plans (Starter/Pro/Enterprise).
# - API keys + SSO metadata: accessible from Pro upward (commercial option on Pro).


PLAN_LIMITS: dict[Plan, dict[str, int | None]] = {
    Plan.STARTER: {
        "max_users": 1,
        "max_accountants": 0,
        "max_companies": 1,
        "max_invoices_per_month": None,
    },
    Plan.PRO: {
        "max_users": 3,
        "max_accountants": 1,
        # Multi-company self-service is not implemented. Keep the commercial
        # limit aligned with the single tenant workspace actually delivered.
        "max_companies": 1,
        "max_invoices_per_month": None,
    },
    Plan.ENTERPRISE: {
        "max_users": None,
        "max_accountants": None,
        "max_companies": None,
        "max_invoices_per_month": None,
    },
}


def _normalize_plan(value: str | None) -> Plan:
    raw = (value or "").lower()
    for p in Plan:
        if p.value == raw:
            return p
    return Plan.STARTER


def get_plan_limits(tenant: Tenant) -> dict[str, int | None]:
    plan = _normalize_plan(getattr(tenant, "plan", None))
    return PLAN_LIMITS.get(plan, PLAN_LIMITS[Plan.STARTER])


def _limit_error(message: str) -> HTTPException:
    return HTTPException(
        status_code=403,
        detail={"code": "plan_limit_reached", "message": message},
    )


def enforce_user_limit(tenant: Tenant, current_user_count: int) -> None:
    limits = get_plan_limits(tenant)
    max_users = limits.get("max_users")
    if max_users is not None and current_user_count >= max_users:
        if max_users == 1:
            raise _limit_error("Votre plan Starter permet 1 utilisateur maximum. Passez au plan Pro pour en ajouter davantage.")
        raise _limit_error(f"Limite d'utilisateurs atteinte ({max_users}). Passez au plan supérieur pour en ajouter davantage.")


def enforce_accountant_limit(tenant: Tenant, current_accountant_count: int) -> None:
    limits = get_plan_limits(tenant)
    max_accountants = limits.get("max_accountants")
    if max_accountants is not None and current_accountant_count >= max_accountants:
        if max_accountants <= 0:
            raise _limit_error("Votre plan actuel ne permet pas d'ajouter un accès comptable.")
        raise _limit_error(
            f"Limite d'accès comptable atteinte ({max_accountants}). Supprimez un comptable ou passez au plan supérieur."
        )


def enforce_company_limit(tenant: Tenant, current_company_count: int) -> None:
    limits = get_plan_limits(tenant)
    max_companies = limits.get("max_companies")
    if max_companies is not None and current_company_count >= max_companies:
        if max_companies == 1:
            raise _limit_error(
                "Votre offre actuelle permet une seule entreprise. Contactez-nous pour un besoin multi-entreprises."
            )
        raise _limit_error(f"Limite d'entreprises atteinte ({max_companies}). Passez au plan supérieur pour ajouter d'autres entités.")


def require_plan_at_least(tenant: Tenant, minimum: Plan) -> None:
    current = _normalize_plan(getattr(tenant, "plan", None))
    order = [Plan.STARTER, Plan.PRO, Plan.ENTERPRISE]
    if order.index(current) < order.index(minimum):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "plan_upgrade_required",
                "message": f"Fonctionnalité réservée au plan {minimum.value.capitalize()}. Passez au plan supérieur pour y accéder.",
            },
        )


def require_pro_or_enterprise(tenant: Tenant) -> None:
    require_plan_at_least(tenant, Plan.PRO)


def require_enterprise(tenant: Tenant) -> None:
    require_plan_at_least(tenant, Plan.ENTERPRISE)
