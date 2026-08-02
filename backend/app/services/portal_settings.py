from __future__ import annotations

from typing import Any, Dict, Literal

from ..models import Tenant

PortalTheme = Literal["blue", "indigo", "emerald", "orange", "rose", "slate", "violet"]
QuoteConvertMode = Literal["auto_issue", "create_draft", "disabled"]

ALLOWED_PORTAL_THEMES = {"blue", "indigo", "emerald", "orange", "rose", "slate", "violet"}
ALLOWED_CONVERT_MODES = {"auto_issue", "create_draft", "disabled"}


def get_portal_settings(tenant: Tenant | None) -> Dict[str, Any]:
    """Return portal settings for a tenant (sanitized + with defaults).

    Stored in tenant.settings.features.portal (JSON).
    We sanitize here because these settings are used by public endpoints.
    """
    defaults: Dict[str, Any] = {
        "theme": "blue",
        "card_payments": False,
        "show_credit_notes": True,
        "show_all_documents": False,
        "quote_convert_mode": "disabled",
        "support_email": None,
        "footer_note": None,
    }
    if not tenant:
        return dict(defaults)

    features = None
    try:
        features = getattr(getattr(tenant, "settings", None), "features", None)
    except Exception:
        features = None

    portal: Any = None
    if isinstance(features, dict):
        portal = features.get("portal")

    merged = dict(defaults)
    if isinstance(portal, dict):
        merged.update(portal)

    theme = str(merged.get("theme") or defaults["theme"]).strip().lower()
    if theme not in ALLOWED_PORTAL_THEMES:
        theme = defaults["theme"]
    merged["theme"] = theme

    merged["card_payments"] = False
    merged["show_credit_notes"] = bool(merged.get("show_credit_notes", defaults["show_credit_notes"]))
    merged["show_all_documents"] = bool(merged.get("show_all_documents", defaults["show_all_documents"]))

    mode = str(merged.get("quote_convert_mode") or defaults["quote_convert_mode"]).strip().lower()
    if mode not in ALLOWED_CONVERT_MODES:
        mode = defaults["quote_convert_mode"]
    if mode == "auto_issue":
        mode = "create_draft"
    merged["quote_convert_mode"] = mode

    support_email = (merged.get("support_email") or "").strip().lower() or None
    merged["support_email"] = support_email

    footer_note = (merged.get("footer_note") or "").strip() or None
    merged["footer_note"] = footer_note

    return merged
