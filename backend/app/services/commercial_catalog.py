from __future__ import annotations

from typing import Final


SUBSCRIPTION_PLANS: Final[tuple[str, ...]] = ("starter", "pro")
BILLING_PERIODS: Final[tuple[str, ...]] = ("monthly", "yearly")

SUBSCRIPTION_PLAN_PRICES_CENTS: Final[dict[str, dict[str, int]]] = {
    "starter": {"monthly": 2900, "yearly": 29000},
    "pro": {"monthly": 5900, "yearly": 59000},
}

SUBSCRIPTION_PLAN_COPY: Final[dict[tuple[str, str], dict[str, str]]] = {
    ("starter", "monthly"): {
        "display_name": "Starter",
        "tagline": "Facturation",
        "description": "Solution de facturation classique pour TPE/PME : clients, devis, factures PDF et branding de base. L'e-facturation, les achats et le suivi des paiements restent réservés au plan Pro.",
    },
    ("starter", "yearly"): {
        "display_name": "Starter annuel",
        "tagline": "Facturation",
        "description": "Version annuelle du plan Starter : clients, devis, factures PDF et branding de base. L'e-facturation, les achats et le suivi des paiements restent réservés au plan Pro.",
    },
    ("pro", "monthly"): {
        "display_name": "Pro",
        "tagline": "Préparation e-facturation",
        "description": "Tout Starter, plus achats, suivi des paiements et préparation e-facturation selon mandat, contrat PA et configuration. L’abonnement seul ne crée pas le mandat. Les 50 jetons sont réservés à la souscription, puis crédités une seule fois après activation et disponibilité du stock ; ils sont utilisables avec un connecteur opérationnel.",
    },
    ("pro", "yearly"): {
        "display_name": "Pro annuel",
        "tagline": "Préparation e-facturation",
        "description": "Version annuelle du plan Pro : tout Starter, achats, suivi des paiements et préparation e-facturation selon mandat, contrat PA et configuration. L’abonnement seul ne crée pas le mandat. Les 50 jetons sont réservés à la souscription, puis crédités une seule fois après activation et disponibilité du stock ; ils sont utilisables avec un connecteur opérationnel.",
    },
}

TOKEN_PACK_OFFERS: Final[dict[int, dict[str, object]]] = {
    100: {
        "name": "Pack 100 jetons",
        "description": "Achat ponctuel de 100 jetons pour vos transmissions connectées. 1 jeton = 1 transmission d'émission, de réception ou d'e-reporting. Réservé au plan Pro avec connecteur opérationnel.",
        "unit_amount": 2900,
    },
    500: {
        "name": "Pack 500 jetons",
        "description": "Achat ponctuel de 500 jetons pour vos transmissions connectées. 1 jeton = 1 transmission d'émission, de réception ou d'e-reporting. Réservé au plan Pro avec connecteur opérationnel.",
        "unit_amount": 12900,
    },
    1000: {
        "name": "Pack 1000 jetons",
        "description": "Achat ponctuel de 1000 jetons pour vos transmissions connectées. 1 jeton = 1 transmission d'émission, de réception ou d'e-reporting. Réservé au plan Pro avec connecteur opérationnel.",
        "unit_amount": 24900,
    },
    5000: {
        "name": "Pack 5000 jetons",
        "description": "Achat ponctuel de 5000 jetons pour vos transmissions connectées. 1 jeton = 1 transmission d'émission, de réception ou d'e-reporting. Réservé au plan Pro avec connecteur opérationnel.",
        "unit_amount": 119900,
    },
}


def subscription_plan_price_cents(plan: str, period: str) -> int:
    return SUBSCRIPTION_PLAN_PRICES_CENTS[plan][period]


def subscription_plan_copy(plan: str, period: str) -> dict[str, str]:
    return dict(SUBSCRIPTION_PLAN_COPY.get((plan, period), {}))


def token_pack_tokens() -> tuple[int, ...]:
    return tuple(sorted(TOKEN_PACK_OFFERS))
