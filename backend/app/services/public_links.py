from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import settings


def utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def invoice_public_link_ttl_days() -> int:
    try:
        value = int(getattr(settings, "INVOICE_PUBLIC_LINK_TTL_DAYS", 30) or 30)
    except Exception:
        value = 30
    return max(1, value)


def quote_public_link_ttl_days() -> int:
    try:
        value = int(getattr(settings, "QUOTE_PUBLIC_LINK_TTL_DAYS", 30) or 30)
    except Exception:
        value = 30
    return max(1, value)


def invoice_public_link_expires_at(invoice: Any) -> datetime | None:
    created_at = getattr(invoice, "public_created_at", None)
    if not created_at:
        return None
    if getattr(created_at, "tzinfo", None) is not None:
        created_at = created_at.astimezone(timezone.utc).replace(tzinfo=None)
    return created_at + timedelta(days=invoice_public_link_ttl_days())


def quote_public_link_expires_at(quote: Any) -> datetime | None:
    created_at = getattr(quote, "public_created_at", None)
    if not created_at:
        return None
    if getattr(created_at, "tzinfo", None) is not None:
        created_at = created_at.astimezone(timezone.utc).replace(tzinfo=None)
    return created_at + timedelta(days=quote_public_link_ttl_days())


def is_invoice_public_link_expired(invoice: Any, *, now: datetime | None = None) -> bool:
    expires_at = invoice_public_link_expires_at(invoice)
    if not expires_at:
        return True
    reference = now or utcnow_naive()
    if getattr(reference, "tzinfo", None) is not None:
        reference = reference.astimezone(timezone.utc).replace(tzinfo=None)
    return reference >= expires_at


def is_quote_public_link_expired(quote: Any, *, now: datetime | None = None) -> bool:
    expires_at = quote_public_link_expires_at(quote)
    if not expires_at:
        return True
    reference = now or utcnow_naive()
    if getattr(reference, "tzinfo", None) is not None:
        reference = reference.astimezone(timezone.utc).replace(tzinfo=None)
    return reference >= expires_at


def invoice_public_link_days_left(invoice: Any, *, now: datetime | None = None) -> int | None:
    expires_at = invoice_public_link_expires_at(invoice)
    if not expires_at:
        return None
    reference = now or utcnow_naive()
    if getattr(reference, "tzinfo", None) is not None:
        reference = reference.astimezone(timezone.utc).replace(tzinfo=None)
    seconds_left = max(0.0, (expires_at - reference).total_seconds())
    return max(0, int(math.ceil(seconds_left / 86400)))


def quote_public_link_days_left(quote: Any, *, now: datetime | None = None) -> int | None:
    expires_at = quote_public_link_expires_at(quote)
    if not expires_at:
        return None
    reference = now or utcnow_naive()
    if getattr(reference, "tzinfo", None) is not None:
        reference = reference.astimezone(timezone.utc).replace(tzinfo=None)
    seconds_left = max(0.0, (expires_at - reference).total_seconds())
    return max(0, int(math.ceil(seconds_left / 86400)))


def format_fr_date(value: datetime | None) -> str:
    if not value:
        return ""
    return value.strftime("%d/%m/%Y")


def invoice_public_link_notice(invoice: Any) -> str | None:
    expires_at = invoice_public_link_expires_at(invoice)
    if not expires_at:
        return None
    days_left = invoice_public_link_days_left(invoice)
    expiry_label = format_fr_date(expires_at)
    if days_left is None:
        return f"Ce lien permet de consulter ou télécharger la facture jusqu'au {expiry_label}."
    if days_left <= 0:
        return f"Ce lien expire aujourd'hui. Vous pouvez consulter ou télécharger la facture jusqu'au {expiry_label}."
    return (
        f"Ce lien reste disponible {days_left} jour{'s' if days_left > 1 else ''}, "
        f"jusqu'au {expiry_label}, pour consulter ou télécharger la facture."
    )


def invoice_public_link_expired_message(invoice: Any | None = None) -> str:
    expires_at = invoice_public_link_expires_at(invoice) if invoice is not None else None
    expiry_label = format_fr_date(expires_at)
    if expiry_label:
        return (
            f"Ce lien de facture a expiré le {expiry_label}. "
            "Demandez un nouveau lien à l'entreprise pour consulter ou télécharger le document."
        )
    return "Ce lien de facture a expiré. Demandez un nouveau lien à l'entreprise pour consulter ou télécharger le document."


def quote_public_link_expired_message(quote: Any | None = None) -> str:
    expires_at = quote_public_link_expires_at(quote) if quote is not None else None
    expiry_label = format_fr_date(expires_at)
    if expiry_label:
        return (
            f"Ce lien de devis a expiré le {expiry_label}. "
            "Demandez un nouveau lien à l'entreprise pour consulter ou signer le document."
        )
    return "Ce lien de devis a expiré. Demandez un nouveau lien à l'entreprise pour consulter ou signer le document."
