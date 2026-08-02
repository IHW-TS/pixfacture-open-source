from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Customer, CustomerContact, Quote


def normalize_email(value: str | None) -> str:
    return (value or "").strip().lower()


def allowed_quote_recipient_emails(db: Session, quote: Quote) -> set[str]:
    """Emails allowed to receive/validate a public quote OTP.

    Keep this deliberately narrow: the public link holder must prove control of
    an email already attached to the customer dossier.
    """
    emails: set[str] = set()
    customer_id = getattr(quote, "customer_id", None)
    tenant_id = getattr(quote, "tenant_id", None)
    if not customer_id or not tenant_id:
        return emails

    customer = (
        db.query(Customer)
        .filter(Customer.id == customer_id, Customer.tenant_id == tenant_id)
        .first()
    )
    if customer:
        email = normalize_email(getattr(customer, "email", None))
        if email:
            emails.add(email)

    contacts = (
        db.query(CustomerContact)
        .filter(CustomerContact.customer_id == customer_id, CustomerContact.tenant_id == tenant_id)
        .filter(CustomerContact.send_quotes.is_(True))
        .all()
    )
    for contact in contacts:
        email = normalize_email(getattr(contact, "email", None))
        if email:
            emails.add(email)
    return emails


def quote_email_is_allowed(db: Session, quote: Quote, email: str | None) -> bool:
    normalized = normalize_email(email)
    if not normalized:
        return False
    return normalized in allowed_quote_recipient_emails(db, quote)
