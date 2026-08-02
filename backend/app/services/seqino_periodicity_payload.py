from fastapi import HTTPException

from ..models import Tenant


_SEQINO_VAT_REGIMES = {
    "real_normal_monthly",
    "real_normal_quarterly",
    "simplified",
    "franchise",
}
_SEQINO_TRANSACTION_PERIODICITIES = {"monthly", "decade"}
_SEQINO_PAYMENT_PERIODICITIES = {"monthly", "bimonthly"}
_VAT_REGIME_ALIASES = {
    "reel_normal": "real_normal_monthly",
    "real_normal": "real_normal_monthly",
    "real_normal_monthly": "real_normal_monthly",
    "reel_normal_monthly": "real_normal_monthly",
    "real_normal_quarterly": "real_normal_quarterly",
    "reel_normal_quarterly": "real_normal_quarterly",
    "reel_simplifie": "simplified",
    "simplifie": "simplified",
    "simplifie_agricole": "simplified",
    "simplified": "simplified",
    "franchise": "franchise",
    "franchise_base": "franchise",
    "franchise_en_base": "franchise",
    "franchise-en-base": "franchise",
    "micro": "franchise",
    "micro_entreprise": "franchise",
    "micro-entreprise": "franchise",
    "microentreprise": "franchise",
    "auto_entrepreneur": "franchise",
    "auto-entrepreneur": "franchise",
    "autoentrepreneur": "franchise",
}
_PERIODICITY_ALIASES = {
    "decade": "decade",
    "decadal": "decade",
    "decade_days": "decade",
    "decade_10": "decade",
    "decade10": "decade",
    "decade_10j": "decade",
    "decade_10jours": "decade",
    "mois": "monthly",
    "month": "monthly",
    "monthly": "monthly",
    "bimonth": "bimonthly",
    "bimonthly": "bimonthly",
    "bimestre": "bimonthly",
    "bimestriel": "bimonthly",
}


def _canonical_vat_regime(value: str | None) -> str | None:
    if value is None:
        return None
    key = value.strip().lower()
    if not key:
        return None
    return _VAT_REGIME_ALIASES.get(key, key)


def is_vat_franchise_regime(value: str | None) -> bool:
    return _canonical_vat_regime(value) == "franchise"


def _normalize_vat_regime(value: str | None) -> str:
    normalized = _canonical_vat_regime(value)
    if not normalized:
        raise HTTPException(
            400,
            detail={
                "code": "vat_regime_invalid",
                "message": (
                    "Regime TVA invalide (attendu: franchise, simplified, "
                    "real_normal_monthly, real_normal_quarterly)."
                ),
            },
        )
    if normalized not in _SEQINO_VAT_REGIMES:
        raise HTTPException(
            400,
            detail={
                "code": "vat_regime_invalid",
                "message": (
                    "Regime TVA invalide (attendu: franchise, simplified, "
                    "real_normal_monthly, real_normal_quarterly)."
                ),
            },
        )
    return normalized


def _canonical_periodicity(value: str | None) -> str | None:
    if value is None:
        return None
    key = value.strip().lower()
    if not key:
        return None
    return _PERIODICITY_ALIASES.get(key)


def _normalize_periodicity(value: str | None, *, allowed: set[str], label: str) -> str | None:
    if value is None:
        return None
    normalized = _canonical_periodicity(value)
    if not normalized or normalized not in allowed:
        allowed_list = ", ".join(sorted(allowed))
        raise HTTPException(
            400,
            detail={
                "code": "periodicity_invalid",
                "message": f"Periodicite {label} invalide (attendu: {allowed_list}).",
            },
        )
    return normalized


def _normalize_transaction_periodicity(value: str | None) -> str | None:
    return _normalize_periodicity(
        value,
        allowed=_SEQINO_TRANSACTION_PERIODICITIES,
        label="transaction",
    )


def _normalize_payment_periodicity(value: str | None) -> str | None:
    return _normalize_periodicity(
        value,
        allowed=_SEQINO_PAYMENT_PERIODICITIES,
        label="paiement",
    )


def _default_periodicities_for_regime(regime: str | None) -> tuple[str, str]:
    normalized = _canonical_vat_regime(regime)
    defaults: dict[str, tuple[str, str]] = {
        "real_normal_monthly": ("decade", "monthly"),
        "real_normal_quarterly": ("monthly", "monthly"),
        "simplified": ("monthly", "monthly"),
        "franchise": ("monthly", "bimonthly"),
    }
    if not normalized:
        return ("monthly", "monthly")
    return defaults.get(normalized, ("monthly", "monthly"))


def _build_seqino_periodicity_payload(tenant: Tenant) -> dict[str, str]:
    vat_regime = _normalize_vat_regime(getattr(tenant, "vat_regime", None))
    transaction_periodicity = _normalize_transaction_periodicity(
        getattr(tenant, "transaction_periodicity", None)
    )
    payment_periodicity = _normalize_payment_periodicity(
        getattr(tenant, "payment_periodicity", None)
    )
    default_tx, default_pay = _default_periodicities_for_regime(vat_regime)
    return {
        "vat_regime": vat_regime,
        "transaction_periodicity": transaction_periodicity or default_tx,
        "payment_periodicity": payment_periodicity or default_pay,
    }
