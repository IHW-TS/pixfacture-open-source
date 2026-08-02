from __future__ import annotations

import re
from typing import Iterable

from sqlalchemy.orm import Session

from ..models import Customer, CustomerContact


_EMAIL_SEP_RE = re.compile(r"[\s,;]+")


def parse_emails(raw: str | None) -> list[str]:
    """Parse une chaîne d'emails (séparés par virgule/point-virgule/espace)."""
    text = (raw or "").strip()
    if not text:
        return []
    parts = [p.strip() for p in _EMAIL_SEP_RE.split(text) if p and p.strip()]
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        email = p.strip().lower()
        if not email:
            continue
        # validation légère (la lib email-validator est déjà utilisée côté Pydantic)
        if "@" not in email or "." not in email.split("@")[-1]:
            continue
        if email in seen:
            continue
        seen.add(email)
        out.append(email)
    return out


def _sorted_contacts(contacts: list[CustomerContact]) -> list[CustomerContact]:
    # primary d'abord, ensuite par created_at.
    return sorted(
        contacts,
        key=lambda c: (
            0 if bool(getattr(c, "is_primary", False)) else 1,
            getattr(c, "created_at", None) or 0,
        ),
    )


def resolve_customer_recipients(
    db: Session,
    *,
    customer: Customer,
    kind: str,
    explicit_to: str | None = None,
) -> list[str]:
    """Résout les destinataires email pour un document.

    kind: "invoice" | "quote" | "followup"
    - Si explicit_to non vide -> liste parse_emails(explicit_to)
    - Sinon -> CustomerContact flags (send_invoices/send_quotes)
    - Fallback -> customer.email (historique)
    """

    explicit = parse_emails(explicit_to)
    if explicit:
        return explicit

    tenant_id = getattr(customer, "tenant_id", None)
    if not tenant_id:
        return []

    contacts = (
        db.query(CustomerContact)
        .filter(CustomerContact.tenant_id == tenant_id, CustomerContact.customer_id == customer.id)
        .all()
    )

    filtered: list[CustomerContact] = []
    for c in contacts:
        if kind in {"invoice", "followup"}:
            if bool(getattr(c, "send_invoices", False)):
                filtered.append(c)
        elif kind == "quote":
            if bool(getattr(c, "send_quotes", False)):
                filtered.append(c)
        else:
            # par défaut, même logique que invoice
            if bool(getattr(c, "send_invoices", False)):
                filtered.append(c)

    emails = [
        (getattr(c, "email", "") or "").strip().lower()
        for c in _sorted_contacts(filtered)
        if (getattr(c, "email", "") or "").strip()
    ]

    # fallback: email principal
    if not emails:
        fallback = (getattr(customer, "email", "") or "").strip().lower()
        if fallback:
            emails = [fallback]

    # dédoublonnage (au cas où)
    dedup: list[str] = []
    seen: set[str] = set()
    for e in emails:
        if not e or e in seen:
            continue
        seen.add(e)
        dedup.append(e)
    return dedup


def join_emails(emails: Iterable[str]) -> str:
    return ", ".join([e for e in emails if e])
