from __future__ import annotations

import re
from typing import Any, Iterable

from ..models import Customer, Tenant
from .branding_settings import get_branding_settings
from .email_reply_to import clean_document_reply_email

_CONTACT_SENTENCE_PREFIX = "Vous pouvez contacter l'émetteur à cette adresse :"
_CONTACT_LINE_RE = re.compile(
    r"^\s*Vous pouvez contacter l[’']émetteur à cette adresse\s*:\s*.+\s*$",
    re.IGNORECASE,
)


def _split_lines(text: str | None) -> list[str]:
    raw = (text or "").strip()
    if not raw:
        return []
    # conserve la mise en forme basique
    lines = [line.rstrip() for line in raw.splitlines()]
    # trim lignes vides excessives
    out: list[str] = []
    empty_run = 0
    for line in lines:
        if not line.strip():
            empty_run += 1
            if empty_run > 1:
                continue
            out.append("")
        else:
            empty_run = 0
            out.append(line)
    return out


def _normalize_footer_note(text: str | None) -> str:
    value = (text or "").strip()
    if not value:
        return ""
    compact = " ".join(value.upper().split())
    if ("IMLPRIMER" in compact or "IMPRIMER" in compact) and ("ECOLOGIE" in compact or "ÉCOLOGIE" in compact):
        return "Pensez à l'environnement avant d'imprimer cet e-mail."
    return value


def _normalize_document_body(text: str | None, *, company_name: str = "") -> str:
    value = (text or "").strip()
    if not value:
        return ""
    replacements = {
        "Pour toute question, répondez directement à cet email.": "",
        "Pour toute question, repondez directement a cet email.": "",
        "Vous pouvez le consulter et l'accepter depuis le portail sécurisé.": "Pour accepter ou signer ce devis, cliquez sur le bouton « Voir le devis », puis validez-le depuis le portail sécurisé.",
        "Si le paiement a déjà été effectué, répondez simplement à cet email avec la référence du règlement. À défaut, merci de nous indiquer la date de paiement prévue.": "Si le paiement a déjà été effectué, merci de transmettre la référence du règlement à votre contact habituel. À défaut, merci d'indiquer la date de paiement prévue.",
        "Si le paiement a deja ete effectue, repondez simplement a cet email avec la reference du reglement. A defaut, merci de nous indiquer la date de paiement prevue.": "Si le paiement a déjà été effectué, merci de transmettre la référence du règlement à votre contact habituel. À défaut, merci d'indiquer la date de paiement prévue.",
    }
    for source, replacement in replacements.items():
        value = value.replace(source, replacement)
    lines = [line.rstrip() for line in value.splitlines()]
    company_candidates = {
        company_name.strip().casefold(),
        "votre entreprise",
        "entreprise-exemple",
    }
    last = len(lines) - 1
    while last >= 0 and not lines[last].strip():
        last -= 1
    if last >= 0:
        last_value = lines[last].strip().casefold()
        previous = last - 1
        while previous >= 0 and not lines[previous].strip():
            previous -= 1
        previous_value = lines[previous].strip().casefold().rstrip(",") if previous >= 0 else ""
        if last_value in company_candidates and previous_value == "merci":
            lines = lines[:previous]
        elif last_value.rstrip(",") == "merci":
            lines = lines[:last]
    return "\n".join(lines).strip()


def normalize_document_email_body_text(*, tenant: Tenant, body_text: str, contact_email: str | None = None) -> str:
    """Return the exact body text used for document emails.

    It removes legacy automatic signatures and keeps the visible reply address
    current without relying on the technical SMTP From address.
    """

    company_name = (getattr(tenant, "name", None) or "").strip() or "Votre entreprise"
    contact = (
        clean_document_reply_email(contact_email)
        or clean_document_reply_email(getattr(tenant, "email_reply_to", None))
        or clean_document_reply_email(getattr(tenant, "email", None))
    )
    normalized = _normalize_document_body(body_text, company_name=company_name)
    lines = [line for line in _split_lines(normalized) if not _CONTACT_LINE_RE.match(line.strip())]
    if contact:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"{_CONTACT_SENTENCE_PREFIX} {contact}")
    return "\n".join(lines).strip()


def build_document_email_context(
    *,
    tenant: Tenant,
    customer: Customer | None,
    title: str,
    body_text: str,
    button_url: str | None = None,
    button_label: str | None = None,
    meta: Iterable[tuple[str, str]] | None = None,
    recipient_email: str | None = None,
    contact_email: str | None = None,
) -> dict[str, Any]:
    """Contexte standard pour email "document" (devis/facture/relance).

    Le rendu HTML est centralisé dans templates/email/document.html.
    """

    branding = get_branding_settings(tenant)
    company_name = (getattr(tenant, "name", None) or "").strip() or "Votre entreprise"
    customer_name = (getattr(customer, "name", None) or "").strip() if customer else ""
    logo_url = (getattr(tenant, "logo_url", None) or "").strip() or None
    contact_email = (
        clean_document_reply_email(contact_email)
        or clean_document_reply_email(getattr(tenant, "email_reply_to", None))
        or clean_document_reply_email(getattr(tenant, "email", None))
    )
    recipient_email = (recipient_email or "").strip() or None

    # Les emails document restent transactionnels : l'adresse affichee doit
    # rester métier (destinataire ou entreprise), jamais une adresse technique
    # de plateforme.
    signature_lines: list[str] = []
    footer_note = _normalize_footer_note(branding.get("email_footer_note") or branding.get("portal_footer_note") or "")
    if not footer_note:
        footer_note = "Pensez à l'environnement avant d'imprimer cet e-mail."
    meta_rows = []
    for k, v in meta or []:
        label = (k or "").strip()
        value = (v or "").strip()
        if not label or not value:
            continue
        meta_rows.append({"label": label, "value": value})

    normalized_body = normalize_document_email_body_text(
        tenant=tenant,
        body_text=body_text,
        contact_email=contact_email,
    )
    body_lines = _split_lines(normalized_body)

    return {
        "accent_color": branding.get("email_accent"),
        "logo_url": logo_url,
        "company_name": company_name,
        "contact_email": contact_email,
        "sender_email": contact_email,
        "recipient_email": recipient_email,
        "customer_name": customer_name,
        "title": title,
        "body_lines": body_lines,
        "button_url": button_url,
        "button_label": button_label or "Ouvrir",
        "meta": meta_rows,
        "signature_lines": signature_lines,
        "footer_note": footer_note,
    }
