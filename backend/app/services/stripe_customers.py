from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..models import Tenant


def _customer_id(customer: Any) -> str | None:
    if isinstance(customer, dict):
        return str(customer.get("id") or "").strip() or None
    return str(getattr(customer, "id", "") or "").strip() or None


def _stripe_customer_payload(tenant: Tenant, user: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"metadata": {"tenant_id": tenant.id}}
    name = str(getattr(tenant, "name", "") or "").strip()
    email = str(getattr(tenant, "email_reply_to", "") or getattr(user, "email", "") or "").strip()
    if name:
        payload["name"] = name
    if email:
        payload["email"] = email
    return payload


def sync_stripe_customer_for_tenant(stripe_api: Any, db: Session, tenant: Tenant, user: Any) -> str:
    payload = _stripe_customer_payload(tenant, user)
    customer_id = str(getattr(tenant, "stripe_customer_id", "") or "").strip()
    if customer_id:
        stripe_api.Customer.modify(customer_id, **payload)
        return customer_id

    customer = stripe_api.Customer.create(
        **payload,
        idempotency_key=f"tenant-stripe-customer:{tenant.id}",
    )
    customer_id = _customer_id(customer)
    if not customer_id:
        raise RuntimeError("Stripe customer creation did not return an id")
    tenant.stripe_customer_id = customer_id
    db.add(tenant)
    db.flush()
    return customer_id
