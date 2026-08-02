from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..core.plans import Plan
from ..models import PdpConnection, PdpMandate, Tenant, User
from ..services import seqino_mandates
from ..services.connected_mode import ensure_connected_mode_operational
from ..services.integration_secrets import resolve_seqino_credentials
from ..services.seqino_onboarding import get_or_create_client
from ..utils.crypto import decrypt_payload, encrypt_payload

logger = logging.getLogger(__name__)

_EFFECTIVE_SUBSCRIPTION_STATUSES = {"active", "trialing"}
_ACTIVE_MANDATE_STATUSES = {"ACTIVE"}


def _demo_mode() -> bool:
    return bool(getattr(settings, "SEQINO_DEMO_MODE", False))


def _has_effective_pro_subscription(tenant: Tenant | None) -> bool:
    if not tenant:
        return False
    plan = (getattr(tenant, "plan", None) or "").strip().lower()
    status = (getattr(tenant, "subscription_status", None) or "").strip().lower()
    return plan == Plan.PRO.value and status in _EFFECTIVE_SUBSCRIPTION_STATUSES


def _digits_only(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _tenant_default_directory_entry(tenant: Tenant) -> dict[str, str]:
    siret_digits = _digits_only(tenant.siret)
    siren = siret_digits[:9] if len(siret_digits) >= 9 else ""
    name = (tenant.name or "").strip()
    if not name:
        raise ValueError("company_name_missing")
    if len(siren) != 9:
        raise ValueError("company_siren_missing")
    entry: dict[str, str] = {"siren": siren, "name": name}
    if len(siret_digits) == 14:
        entry["siret"] = siret_digits
    return entry


def _tenant_contact_email(db: Session, tenant_id: str) -> str | None:
    row = (
        db.query(User.email)
        .filter(User.tenant_id == tenant_id, User.status == "active")
        .order_by(User.is_admin.desc(), User.created_at.asc())
        .first()
    )
    if not row:
        return None
    email = str(row[0] or "").strip()
    return email or None


def _is_active_mandate_status(status: str | None) -> bool:
    return (status or "").strip().upper() in _ACTIVE_MANDATE_STATUSES


def _seqino_connection(db: Session, tenant_id: str) -> PdpConnection | None:
    return (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.provider_slug == "seqino")
        .order_by(PdpConnection.updated_at.desc())
        .first()
    )


def _seqino_active_mandate_count(db: Session, tenant_id: str) -> int:
    rows = (
        db.query(PdpMandate.status)
        .filter(PdpMandate.tenant_id == tenant_id, PdpMandate.provider_slug == "seqino")
        .all()
    )
    return sum(1 for (status,) in rows if _is_active_mandate_status(status))


def _apply_seqino_connection_status(
    db: Session,
    tenant_id: str,
    *,
    conn: PdpConnection | None = None,
    active_count: int | None = None,
) -> int:
    db.flush()
    connection = conn or _seqino_connection(db, tenant_id)
    count = _seqino_active_mandate_count(db, tenant_id) if active_count is None else active_count
    if connection and count > 0 and (connection.status or "").lower() != "connected":
        connection.status = "connected"
        connection.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(connection)
    return count


def _upsert_pdp_mandate(db: Session, tenant_id: str, data: dict[str, Any]) -> PdpMandate | None:
    mandate_id = str(data.get("mandate_id") or "").strip()
    if not mandate_id:
        return None
    mandate = (
        db.query(PdpMandate)
        .filter(PdpMandate.tenant_id == tenant_id, PdpMandate.mandate_id == mandate_id)
        .first()
    )
    if not mandate:
        mandate = PdpMandate(tenant_id=tenant_id, provider_slug="seqino", mandate_id=mandate_id)
        db.add(mandate)
    for field in ("siren", "siret", "suffix", "routing_identifier", "name", "start_date", "status", "file_attachment"):
        value = data.get(field)
        if value is not None:
            setattr(mandate, field, value)
    return mandate


async def _sync_seqino_mandates_from_remote(db: Session, tenant_id: str) -> int:
    conn = _seqino_connection(db, tenant_id)
    if not conn:
        return 0
    creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
    access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id)
    if _demo_mode():
        access_token = access_token or "demo"
        sponsor_id = sponsor_id or "demo"
    client_id = creds.get("client_id") or creds.get("seqino_client_id")
    if not access_token or not client_id:
        return _seqino_active_mandate_count(db, tenant_id)
    items = await seqino_mandates.list_mandates(
        access_token=access_token,
        client_id=str(client_id),
        sponsor_id=sponsor_id,
        tenant_id=tenant_id,
    )
    remote_active_count = 0
    for item in items:
        normalized = seqino_mandates.normalize_mandate_item(item)
        if _is_active_mandate_status(normalized.get("status")):
            remote_active_count += 1
        _upsert_pdp_mandate(db, tenant_id, normalized)
    return _apply_seqino_connection_status(db, tenant_id, active_count=remote_active_count)


async def ensure_default_seqino_activation(
    db: Session,
    tenant: Tenant,
    *,
    contact_email: str | None = None,
) -> dict[str, Any]:
    if not _has_effective_pro_subscription(tenant):
        return {"ok": False, "skipped": "not_pro"}

    tenant_id = str(tenant.id)
    ensure_connected_mode_operational(db, tenant_id, "seqino")
    entry_payload = _tenant_default_directory_entry(tenant)
    contact = (contact_email or _tenant_contact_email(db, tenant_id) or "").strip()
    if not contact:
        raise ValueError("tenant_contact_email_missing")

    conn = _seqino_connection(db, tenant_id)
    creds = decrypt_payload(conn.encrypted_credentials) if conn and conn.encrypted_credentials else {}
    access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id)
    if _demo_mode():
        access_token = access_token or "demo"
        sponsor_id = sponsor_id or "demo"
    if not access_token:
        raise ValueError("seqino_token_missing")
    if not sponsor_id:
        raise ValueError("seqino_sponsor_missing")

    existing_client_id = str(creds.get("client_id") or creds.get("seqino_client_id") or "").strip() or None
    if existing_client_id and await _sync_seqino_mandates_from_remote(db, tenant_id) > 0:
        db.commit()
        return {"ok": True, "connected": True, "reused": True}

    client_result = await get_or_create_client(
        tenant,
        access_token=access_token,
        contact_email=contact,
        sponsor_id=sponsor_id,
        existing_client_id=existing_client_id,
    )
    client_id = str(client_result.get("client_id") or "").strip()
    if not client_id:
        raise ValueError("seqino_client_missing")

    for key in ("access_token", "token", "api_key", "authorization", "sponsor_id", "pdp_sponsor_id"):
        creds.pop(key, None)
    creds["client_id"] = client_id
    creds["seqino_client_id"] = client_id
    creds.setdefault("seqino_onboarding_status", "MANDATE_PENDING")

    if not conn:
        conn = PdpConnection(tenant_id=tenant_id, provider_slug="seqino", auth_type="api_key")
    conn.auth_type = conn.auth_type or "api_key"
    conn.encrypted_credentials = encrypt_payload(creds)
    conn.status = "pending"
    conn.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(conn)
    db.flush()

    today = datetime.now(timezone.utc).date()
    start_dt = datetime(today.year, today.month, today.day, tzinfo=timezone.utc)
    mandate_payload: dict[str, Any] = {
        "directory_entry": entry_payload,
        "start_date": start_dt.isoformat(),
    }
    result = await seqino_mandates.create_mandate(
        mandate_payload,
        access_token=access_token,
        client_id=client_id,
        sponsor_id=sponsor_id,
        tenant_id=tenant_id,
    )
    raw_payload = result.get("payload") if isinstance(result, dict) else None
    merged_payload = dict(mandate_payload)
    if isinstance(raw_payload, dict):
        merged_payload.update(raw_payload)
        if isinstance(mandate_payload.get("directory_entry"), dict) and isinstance(raw_payload.get("directory_entry"), dict):
            merged_payload["directory_entry"] = {
                **mandate_payload["directory_entry"],
                **raw_payload["directory_entry"],
            }
    normalized = seqino_mandates.normalize_mandate_item(merged_payload)
    if not normalized.get("mandate_id"):
        normalized["mandate_id"] = result.get("mandate_id")
    mandate = _upsert_pdp_mandate(db, tenant_id, normalized)
    if not mandate:
        raise ValueError("seqino_mandate_missing")

    active_count = _apply_seqino_connection_status(db, tenant_id, conn=conn)
    try:
        active_count = max(active_count, await _sync_seqino_mandates_from_remote(db, tenant_id))
    except Exception:
        active_count = max(active_count, _seqino_active_mandate_count(db, tenant_id))
    creds["seqino_mandate_id"] = mandate.mandate_id
    if active_count > 0:
        creds["seqino_onboarding_status"] = "ACTIVE"
    conn.encrypted_credentials = encrypt_payload(creds)
    db.add(conn)
    db.commit()
    return {
        "ok": True,
        "connected": (conn.status or "").lower() == "connected",
        "client_id": client_id,
        "mandate_active_count": active_count,
    }


async def auto_activate_seqino_for_tenant(tenant_id: str, contact_email: str | None = None) -> None:
    if not tenant_id:
        return
    _ = contact_email
    logger.info("seqino_auto_activation_skipped tenant_id=%s reason=explicit_mandate_required", tenant_id)
