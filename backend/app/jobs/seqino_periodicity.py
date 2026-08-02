import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import PdpAccount, PdpConnection, Tenant
from ..services.integration_secrets import resolve_seqino_credentials
from ..services import seqino_periodicity
from ..services.seqino_mandates import seqino_has_active_mandate
from ..services.seqino_periodicity_payload import _build_seqino_periodicity_payload
from ..services.connected_mode import connected_mode_decision
from ..utils.crypto import decrypt_payload
from ..utils.pdp_accounts import get_pdp_account_metadata

logger = logging.getLogger(__name__)


def _normalize_client_id(value: object | None) -> str | None:
    if isinstance(value, dict):
        value = value.get("id") or value.get("client_id") or value.get("clientId")
    raw = str(value).strip() if value is not None else ""
    return raw or None


def _status_is_onboarded(value: object | None) -> bool:
    status = str(value).strip().lower() if value is not None else ""
    return status in {"active", "connected"}


def _seqino_credentials(db: Session, tenant_id: str) -> tuple[str | None, str | None, str | None, bool]:
    conn = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.provider_slug == "seqino")
        .order_by(PdpConnection.updated_at.desc())
        .first()
    )
    account = (
        db.query(PdpAccount)
        .filter(PdpAccount.tenant_id == tenant_id, PdpAccount.provider == "seqino")
        .order_by(PdpAccount.updated_at.desc())
        .first()
    )
    if not conn and not account:
        return None, None, None, False
    try:
        creds = decrypt_payload(conn.encrypted_credentials) if conn and conn.encrypted_credentials else {}
    except Exception:
        logger.warning("Seqino periodicity sync skipped: credentials invalid", extra={"tenant_id": tenant_id})
        creds = {}
    access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id)
    account_metadata = get_pdp_account_metadata(account)
    client_id = _normalize_client_id(creds.get("seqino_client_id") or creds.get("client_id"))
    if not client_id and account:
        client_id = _normalize_client_id(account.provider_client_id)
    onboarded = any(
        _status_is_onboarded(value)
        for value in (
            creds.get("seqino_onboarding_status"),
            conn.status if conn else None,
            account.status if account else None,
            account_metadata.get("status"),
            account_metadata.get("onboarding_status"),
        )
    ) or seqino_has_active_mandate(tenant_id, db=db)
    return (access_token or None), (sponsor_id or None), client_id, onboarded


def sync_seqino_periodicity(tenant_id: str) -> dict:
    status = "failed"
    status_code = None
    ok = False
    with SessionLocal() as db:
        tenant = db.get(Tenant, tenant_id)
        if not tenant:
            logger.warning("Seqino periodicity sync skipped: tenant missing", extra={"tenant_id": tenant_id})
            return {"ok": False, "error": {"code": "tenant_not_found", "message": "Entreprise introuvable."}}
        access = connected_mode_decision(db, tenant_id, "seqino")
        if not access.allowed:
            tenant.seqino_last_periodicity_sync_status = "skipped"
            tenant.seqino_last_periodicity_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.add(tenant)
            db.commit()
            logger.info(
                "Seqino periodicity sync skipped: connected mode unavailable",
                extra={"tenant_id": tenant_id, "reason": access.code},
            )
            return {
                "ok": True,
                "status": "skipped",
                "blocked_reason": access.code or "connected_mode_not_operational",
            }
        access_token, sponsor_id, client_id, onboarded = _seqino_credentials(db, tenant_id)
        if not onboarded or not access_token or not client_id or not sponsor_id:
            logger.info(
                "skipped periodicity sync",
                extra={
                    "tenant_id": tenant_id,
                    "onboarded": onboarded,
                    "has_access_token": bool(access_token),
                    "has_client_id": bool(client_id),
                    "has_sponsor_id": bool(sponsor_id),
                },
            )
            status = "skipped"
            ok = True
        else:
            try:
                payload = _build_seqino_periodicity_payload(tenant)
                _, status_code = asyncio.run(
                    seqino_periodicity.sync_periodicity(
                        payload,
                        access_token=access_token,
                        sponsor_id=sponsor_id,
                        client_id=client_id,
                        tenant_id=tenant_id,
                    )
                )
                status = "synced"
                ok = True
                logger.info(
                    "Seqino periodicity sync succeeded",
                    extra={"tenant_id": tenant_id, "status_code": status_code},
                )
            except Exception as exc:
                response = getattr(exc, "response", None)
                status_code = getattr(response, "status_code", None)
                logger.warning(
                    "Seqino periodicity sync failed",
                    extra={"tenant_id": tenant_id, "status_code": status_code},
                    exc_info=True,
                )

        tenant.seqino_last_periodicity_sync_status = status
        tenant.seqino_last_periodicity_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(tenant)
        db.commit()

    result: dict[str, Any] = {"ok": ok, "status": status}
    if status_code is not None:
        result["status_code"] = status_code
    if not ok:
        result["error"] = {
            "code": "seqino_periodicity_sync_failed",
            "message": "La synchronisation de périodicité n’a pas pu être terminée.",
        }
    return result
