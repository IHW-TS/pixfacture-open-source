from __future__ import annotations

import json

from ..config import settings


_CLAIM_LEVELS = ("export_only", "compatible", "partnered")


def _has_value(value: object | None) -> bool:
    if value is None:
        return False
    return bool(str(value).strip())


def _seqino_configured() -> bool:
    return bool(
        _has_value(settings.SEQINO_BASE_URL)
        and _has_value(settings.SEQINO_SPONSOR_ID)
        and (_has_value(settings.SEQINO_ACCESS_TOKEN) or _has_value(settings.SEQINO_API_KEY))
    )


def _chorus_configured() -> bool:
    if not (
        _has_value(settings.PISTE_CLIENT_ID)
        and _has_value(settings.PISTE_CLIENT_SECRET)
        and _has_value(settings.PISTE_TOKEN_URL)
        and _has_value(settings.CHORUS_API_BASE)
        and _has_value(settings.CHORUS_SUBMIT_PATH)
        and _has_value(settings.CHORUS_STATUS_PATH)
        and _has_value(settings.CHORUS_SUBMIT_EXTRA_JSON)
    ):
        return False
    try:
        extra = json.loads(settings.CHORUS_SUBMIT_EXTRA_JSON or "{}")
    except Exception:
        return False
    if not isinstance(extra, dict):
        return False
    return bool(str(extra.get("syntaxeFlux") or extra.get("syntaxe_flux") or "").strip())


def build_compliance_claims() -> dict:
    pdp_integration_enabled = bool(
        settings.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION and settings.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
    )
    export_only = bool(settings.EINVOICING_EXPORT_ONLY)
    seqino_enabled = pdp_integration_enabled and _seqino_configured()
    chorus_enabled = pdp_integration_enabled and _chorus_configured()
    # Chorus Pro is the B2G public-sector channel. It must not be treated as a
    # B2B plateforme agréée / PA signal for reform claims.
    platform_agreed = bool(seqino_enabled)
    allowed_claims = ["export_only"]
    if not export_only and pdp_integration_enabled and seqino_enabled:
        allowed_claims.append("compatible")
    if not export_only and seqino_enabled:
        allowed_claims.append("partnered")
    partnered = bool(not export_only and seqino_enabled)
    # Les validateurs 2027 contiennent encore des contrôles déclarés partiels.
    # Ne jamais publier un claim "prêt 2027" tant que cette surface n'est pas complète.
    fr_2027_status = "partial"
    return {
        "allowed_claims": [level for level in _CLAIM_LEVELS if level in allowed_claims],
        "pdp_integration_enabled": pdp_integration_enabled,
        "seqino_enabled": seqino_enabled,
        "chorus_enabled": chorus_enabled,
        "platform_agreed": platform_agreed,
        "partnered": partnered,
        "mandate_required": bool(seqino_enabled),
        "fr_2027_status": fr_2027_status,
        "ubl_export_enabled": bool(settings.UBL_EXPORT_ENABLED),
        "facturx_pdfa_mode": (settings.FACTURX_PDFA_MODE or "best_effort"),
    }
