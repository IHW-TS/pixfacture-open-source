from __future__ import annotations

from typing import Any

from ..models import Tenant


_THEME_ACCENT = {
    "blue": "#2563eb",
    "indigo": "#4f46e5",
    "emerald": "#059669",
    "orange": "#ea580c",
    "rose": "#e11d48",
    "slate": "#334155",
    "violet": "#7c3aed",
}


def _get_features(tenant: Tenant) -> dict[str, Any]:
    settings = getattr(tenant, "settings", None)
    features = getattr(settings, "features", None) if settings else None
    return features if isinstance(features, dict) else {}


def _is_hex_color(value: str) -> bool:
    if not value:
        return False
    v = value.strip()
    if not v.startswith("#"):
        return False
    if len(v) not in {4, 7}:
        return False
    hexchars = "0123456789abcdefABCDEF"
    return all(ch in hexchars for ch in v[1:])


def get_branding_settings(tenant: Tenant) -> dict[str, Any]:
    """Retourne les réglages branding (emails/pdf).

    - pdf_template: classic | graphite | ivory
    - email_accent: couleur hex (ou None -> dérivée du thème du portail)
    - email_signature: texte/HTML (optionnel)
    - email_footer_note: texte (optionnel)
    """

    features = _get_features(tenant)
    branding = features.get("branding")
    branding = branding if isinstance(branding, dict) else {}

    portal = features.get("portal")
    portal = portal if isinstance(portal, dict) else {}
    theme = str(portal.get("theme") or "blue").strip().lower()

    pdf_template = str(branding.get("pdf_template") or "classic").strip().lower()
    if pdf_template not in {"classic", "graphite", "ivory"}:
        pdf_template = "classic"

    accent = branding.get("email_accent")
    accent = str(accent).strip() if accent is not None else ""
    if accent and not _is_hex_color(accent):
        accent = ""
    if not accent:
        accent = _THEME_ACCENT.get(theme, _THEME_ACCENT["blue"])

    signature = branding.get("email_signature")
    signature = str(signature).strip() if signature is not None else ""
    if not signature:
        signature = ""

    footer_note = branding.get("email_footer_note")
    footer_note = str(footer_note).strip() if footer_note is not None else ""
    if not footer_note:
        footer_note = ""
    portal_footer_note = portal.get("footer_note")
    portal_footer_note = str(portal_footer_note).strip() if portal_footer_note is not None else ""

    return {
        "pdf_template": pdf_template,
        "email_accent": accent,
        "email_signature": signature,
        "email_footer_note": footer_note,
        "portal_footer_note": portal_footer_note,
        "portal_theme": theme,
    }
