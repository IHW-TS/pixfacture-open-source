from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any
import unicodedata


@dataclass(frozen=True)
class AccountingCategory:
    code: str
    user_label: str
    expert_label: str


PURCHASE_CATEGORIES: tuple[AccountingCategory, ...] = (
    AccountingCategory("604", "Études / prestations achetées", "604 Achats d'études et prestations"),
    AccountingCategory("606", "Fournitures", "606 Fournitures"),
    AccountingCategory("607", "Marchandises", "607 Achats de marchandises"),
    AccountingCategory("611", "Sous-traitance", "611 Sous-traitance générale"),
    AccountingCategory("613", "Location", "613 Locations"),
    AccountingCategory("615", "Entretien / maintenance", "615 Entretien et réparations"),
    AccountingCategory("622", "Honoraires", "622 Honoraires"),
    AccountingCategory("623", "Publicité", "623 Publicité et relations publiques"),
    AccountingCategory("625", "Déplacements / repas", "625 Déplacements et missions"),
    AccountingCategory("626", "Hébergement / télécom", "626 Frais postaux et télécoms"),
    AccountingCategory("627", "Frais bancaires", "627 Services bancaires"),
    AccountingCategory("471", "Je ne sais pas / demander au comptable", "471 Compte d’attente temporaire"),
)

SETTLEMENT_CATEGORIES: tuple[AccountingCategory, ...] = (
    AccountingCategory("512", "Banque", "512 Banque"),
    AccountingCategory("531", "Espèces / caisse", "531 Caisse"),
)

_CATEGORY_BY_CODE = {category.code: category for category in (*PURCHASE_CATEGORIES, *SETTLEMENT_CATEGORIES)}
_TEMPORARY_CODES = {"", "471", "MANUAL", "CUSTOM"}


def normalize_account_code(value: object) -> str:
    return "".join(ch for ch in str(value or "").strip().upper() if ch.isalnum())


def is_temporary_account(value: object) -> bool:
    code = normalize_account_code(value)
    return code in _TEMPORARY_CODES or code.startswith("471")


def account_needs_completion(value: object) -> bool:
    return is_temporary_account(value)


def label_for_account(value: object, audience: str = "user") -> str:
    code = normalize_account_code(value)
    if account_needs_completion(code):
        category = _CATEGORY_BY_CODE["471"]
        return category.expert_label if audience == "expert" else category.user_label
    category = _CATEGORY_BY_CODE.get(code)
    if category:
        return category.expert_label if audience == "expert" else category.user_label
    return str(value or "").strip() or _CATEGORY_BY_CODE["471"].user_label


def list_purchase_categories() -> list[dict[str, str]]:
    return [asdict(category) for category in PURCHASE_CATEGORIES]


def list_settlement_categories() -> list[dict[str, str]]:
    return [asdict(category) for category in SETTLEMENT_CATEGORIES]


def _plain_text(value: object) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or "").lower())
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def _suggestion(code: str, *, source: str, confidence: float, reason: str) -> dict[str, Any]:
    category = _CATEGORY_BY_CODE[code]
    return {
        "code": code,
        "user_label": category.user_label,
        "expert_label": category.expert_label,
        "source": source,
        "confidence": max(0.0, min(float(confidence), 1.0)),
        "reason": reason,
    }


_PURCHASE_KEYWORDS: tuple[tuple[str, tuple[str, ...], str, float, str], ...] = (
    (
        "626",
        ("ovh", "scaleway", "aws", "google cloud", "azure", "hebergement", "hosting", "telecom", "internet"),
        "Le fournisseur ou libellé ressemble à de l’hébergement, du cloud ou des télécoms.",
        0.78,
        "keyword",
    ),
    (
        "627",
        ("stripe", "paypal", "banque", "frais bancaire", "commission bancaire"),
        "Le libellé ressemble à des frais bancaires ou de paiement.",
        0.78,
        "keyword",
    ),
    (
        "625",
        ("sncf", "train", "uber", "taxi", "hotel", "restaurant", "repas", "deplacement"),
        "Le libellé ressemble à un déplacement, repas ou hébergement de mission.",
        0.74,
        "keyword",
    ),
    (
        "622",
        ("avocat", "expert-comptable", "comptable", "conseil", "audit", "honoraires"),
        "Le libellé ressemble à des honoraires ou prestations de conseil.",
        0.76,
        "keyword",
    ),
    (
        "611",
        ("freelance", "sous-traitant", "sous traitant", "sous-traitance", "prestation externe"),
        "Le libellé ressemble à de la sous-traitance.",
        0.73,
        "keyword",
    ),
    (
        "606",
        ("fournitures", "bureau", "papeterie", "cartouche", "materiel de bureau"),
        "Le libellé ressemble à des fournitures.",
        0.72,
        "keyword",
    ),
    (
        "613",
        ("location", "loyer", "bail", "coworking"),
        "Le libellé ressemble à une location.",
        0.72,
        "keyword",
    ),
)


def suggest_purchase_category_from_text(text: object) -> dict[str, Any] | None:
    plain = _plain_text(text)
    if not plain.strip():
        return None
    for code, keywords, reason, confidence, source in _PURCHASE_KEYWORDS:
        if any(keyword in plain for keyword in keywords):
            return _suggestion(code, source=source, confidence=confidence, reason=reason)
    return None


def suggest_settlement_category_from_mode(mode: object) -> dict[str, Any] | None:
    plain = _plain_text(mode).replace("_", " ").strip()
    if not plain:
        return None
    if any(token in plain for token in ("cash", "caisse", "espece", "espèces")):
        return _suggestion("531", source="mode", confidence=0.9, reason="Le paiement est indiqué en espèces ou caisse.")
    if any(token in plain for token in ("bank", "banque", "virement", "card", "carte", "cheque", "stripe", "paypal")):
        return _suggestion("512", source="mode", confidence=0.86, reason="Le paiement passe par la banque.")
    return None
