from __future__ import annotations

from fastapi import HTTPException

from ..models import Tenant


DOCUMENT_EMAIL_TYPES = frozenset(
    {
        "invoice",
        "invoice_followup",
        "quote",
        "quote_followup",
        "quote_otp",
    }
)

TRIAL_DOCUMENT_EMAIL_ERROR = {
    "code": "trial_document_email_disabled",
    "message": (
        "L’envoi d’e-mails de devis et de factures est désactivé pendant la période d’essai. "
        "Vous pouvez continuer à préparer, prévisualiser et télécharger vos documents. "
        "Activez un abonnement pour les envoyer à vos clients."
    ),
    "remediation_url": "/app/billing",
}

TRIAL_QUOTE_OTP_ERROR = {
    "code": "trial_quote_otp_disabled",
    "message": (
        "La validation par code e-mail n’est pas disponible pendant la période d’essai de l’émetteur. "
        "Contactez l’émetteur du devis pour poursuivre."
    ),
}


def is_trialing_tenant(tenant: Tenant | None) -> bool:
    status = str(getattr(tenant, "subscription_status", None) or "").strip().lower()
    return status == "trialing"


def is_document_email_type(event_type: str | None) -> bool:
    return str(event_type or "").strip().lower() in DOCUMENT_EMAIL_TYPES


def ensure_document_email_delivery_allowed(tenant: Tenant | None) -> None:
    if not is_trialing_tenant(tenant):
        return
    raise HTTPException(status_code=403, detail=dict(TRIAL_DOCUMENT_EMAIL_ERROR))


def ensure_public_quote_otp_delivery_allowed(tenant: Tenant | None) -> None:
    if not is_trialing_tenant(tenant):
        return
    raise HTTPException(status_code=403, detail=dict(TRIAL_QUOTE_OTP_ERROR))
