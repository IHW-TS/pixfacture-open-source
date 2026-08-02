from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Membership, Tenant, User


TECHNICAL_PUBLISHER_LOCALS = {"info", "no-reply"}
PUBLISHER_DOMAIN = "example.test"


def clean_document_reply_email(value: object | None) -> str | None:
    email = str(value or "").strip()
    if "@" not in email:
        return None
    local, _, domain = email.lower().partition("@")
    if domain == PUBLISHER_DOMAIN and local in TECHNICAL_PUBLISHER_LOCALS:
        return None
    return email


def resolve_document_reply_to(db: Session | None, tenant: Tenant | None, *, user: object | None = None) -> str | None:
    """Resolve the human address clients should reply to for document emails."""

    tenant_reply = clean_document_reply_email(getattr(tenant, "email_reply_to", None))
    if tenant_reply:
        return tenant_reply

    if user is not None and not bool(getattr(user, "is_api_key", False)):
        account_reply = clean_document_reply_email(getattr(user, "email", None))
        if account_reply:
            return account_reply

    tenant_id = str(getattr(tenant, "id", "") or "").strip()
    if not db or not tenant_id:
        return None

    membership_owner = (
        db.query(User.email)
        .join(Membership, Membership.user_id == User.id)
        .filter(Membership.tenant_id == tenant_id)
        .filter(Membership.role == "owner")
        .filter(User.status == "active")
        .order_by(User.created_at.asc())
        .first()
    )
    if membership_owner:
        owner_email = clean_document_reply_email(membership_owner[0])
        if owner_email:
            return owner_email

    legacy_owner = (
        db.query(User.email)
        .filter(User.tenant_id == tenant_id)
        .filter(User.role == "owner")
        .filter(User.status == "active")
        .order_by(User.created_at.asc())
        .first()
    )
    if legacy_owner:
        return clean_document_reply_email(legacy_owner[0])
    return None
