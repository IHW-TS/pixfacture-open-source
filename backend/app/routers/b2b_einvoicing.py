from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import AuthUser, require_product_feature, require_tenant_admin
from ..models import EInvoiceTransmission, Invoice
from ..routers.invoices import _ctx as build_ctx
from ..routers.invoices import ensure_invoice_artifact
from ..validators.invoice_sanity_checks import validate_invoice_ctx
from ..services.partner_platform.mock import get_partner_connector


router = APIRouter(prefix="/api/b2b/einvoicing", tags=["b2b-einvoicing"], dependencies=[Depends(require_product_feature("einvoicing_enabled"))])
logger = logging.getLogger(__name__)

ALLOWED_STATUSES = {"issued", "sent", "paid", "overdue", "partial"}
PROD_LIKE_ENVS = {"prod", "production", "staging"}
LOCAL_ENVS = {"local", "dev", "test"}
FAKE_PARTNER_PLATFORMS = {"mock", "demo", "fake"}


class PartnerSendPayload(BaseModel):
    platform: str | None = None


class WebhookPayload(BaseModel):
    payload: dict[str, Any] | None = None


def _event_timestamp(events: list[dict[str, Any]] | None) -> datetime | None:
    if not events:
        return None
    raw = events[-1].get("at")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        return None


def _normalize_platform(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().lower()
    return cleaned or None


def _require_legacy_send_allowed(platform: str | None) -> None:
    env = (settings.APP_ENV or "").strip().lower()
    if env in PROD_LIKE_ENVS or bool(settings.EINVOICING_EXPORT_ONLY):
        raise HTTPException(
            status_code=410,
            detail={
                "code": "legacy_einvoicing_api_disabled",
                "message": (
                    "La transmission e-facturation directe legacy est desactivee. "
                    "Utilisez Seqino ou l'export structure."
                ),
            },
        )
    if _normalize_platform(platform) in FAKE_PARTNER_PLATFORMS and env not in LOCAL_ENVS:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "legacy_einvoicing_fake_platform_forbidden",
                "message": "La plateforme de test ne peut pas etre utilisee hors environnement local ou test.",
            },
        )


@router.get("/transmissions")
def list_transmissions(
    limit: int = 50,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    limit = max(1, min(limit, 200))
    rows = (
        db.query(EInvoiceTransmission, Invoice)
        .join(Invoice, EInvoiceTransmission.invoice_id == Invoice.id)
        .filter(EInvoiceTransmission.tenant_id == user.tenant_id)
        .order_by(EInvoiceTransmission.created_at.desc())
        .limit(limit)
        .all()
    )
    items: list[dict[str, Any]] = []
    for tx, inv in rows:
        items.append(
            {
                "id": tx.id,
                "invoice_id": tx.invoice_id,
                "invoice_number": inv.number,
                "status": tx.status,
                "platform": tx.platform,
                "direction": tx.direction,
                "external_id": tx.external_id,
                "error_code": tx.error_code,
                "error_message": tx.error_message,
                "created_at": tx.created_at.isoformat() if tx.created_at else None,
                "updated_at": tx.updated_at.isoformat() if tx.updated_at else None,
                "last_event_at": tx.last_event_at.isoformat() if tx.last_event_at else None,
            }
        )
    return items


@router.post("/send/{invoice_id}")
async def send_invoice(
    invoice_id: str,
    payload: PartnerSendPayload | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status not in ALLOWED_STATUSES:
        raise HTTPException(400, "La facture doit etre emise avant envoi.")

    platform = _normalize_platform((payload.platform if payload else None) or settings.PARTNER_PLATFORM)
    _require_legacy_send_allowed(platform)
    if not platform:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "partner_platform_unconfigured",
                "message": "Plateforme partenaire non configuree.",
            },
        )

    connector = get_partner_connector(platform)
    if connector is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "partner_platform_unknown",
                "message": "Plateforme partenaire inconnue.",
            },
        )

    ctx = build_ctx(db, inv)
    errors = validate_invoice_ctx(ctx)
    if errors:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "sanity_checks_failed",
                "message": "Le document contient des informations a corriger avant transmission.",
                "errors": errors,
            },
        )

    ensure_invoice_artifact(db, inv, "pdf", ctx)
    ensure_invoice_artifact(db, inv, "cii", ctx)
    ensure_invoice_artifact(db, inv, "facturx", ctx)

    try:
        result = await connector.send_invoice(inv, ctx)
    except HTTPException:
        raise
    except Exception:
        logger.exception(
            "legacy_partner_invoice_send_failed",
            extra={"tenant_id": inv.tenant_id, "invoice_id": inv.id, "platform": platform},
        )
        tx = EInvoiceTransmission(
            tenant_id=inv.tenant_id,
            invoice_id=inv.id,
            direction="OUT",
            platform=platform,
            status="failed",
            error_code="send_failed",
            error_message="La plateforme partenaire n’a pas pu traiter l’envoi.",
            raw_events=None,
            last_event_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(tx)
        db.commit()
        raise HTTPException(
            status_code=502,
            detail={
                "code": "partner_send_failed",
                "message": "Erreur lors de l'envoi vers la plateforme partenaire.",
                "transmission_id": tx.id,
            },
        )

    status = result.status
    if result.error_code:
        status = "failed"
    events = result.events or []
    tx = EInvoiceTransmission(
        tenant_id=inv.tenant_id,
        invoice_id=inv.id,
        direction="OUT",
        platform=platform,
        status=status,
        external_id=result.external_id,
        error_code=result.error_code,
        error_message=result.error_message,
        raw_events=events,
        last_event_at=_event_timestamp(events) or datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(tx)
    db.commit()

    return {
        "ok": True,
        "transmission_id": tx.id,
        "platform": tx.platform,
        "status": tx.status,
        "external_id": tx.external_id,
    }


@router.get("/status/{transmission_id}")
async def get_status(
    transmission_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tx = db.get(EInvoiceTransmission, transmission_id)
    if not tx or tx.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")

    connector = get_partner_connector(tx.platform)
    if connector and tx.external_id:
        result = await connector.get_status(tx.external_id)
        new_events = result.events or []
        if new_events:
            history = list(tx.raw_events or [])
            history.extend(new_events)
            tx.raw_events = history
            tx.last_event_at = _event_timestamp(new_events) or datetime.now(timezone.utc).replace(tzinfo=None)
        if result.status:
            tx.status = result.status
        tx.error_code = result.error_code
        tx.error_message = result.error_message
        db.add(tx)
        db.commit()

    return {
        "id": tx.id,
        "invoice_id": tx.invoice_id,
        "platform": tx.platform,
        "status": tx.status,
        "external_id": tx.external_id,
        "error_code": tx.error_code,
        "error_message": tx.error_message,
        "events": tx.raw_events or [],
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
        "updated_at": tx.updated_at.isoformat() if tx.updated_at else None,
        "last_event_at": tx.last_event_at.isoformat() if tx.last_event_at else None,
    }


@router.post("/webhook/{platform}")
async def webhook(
    platform: str,
    body: WebhookPayload | None = None,
    user: AuthUser = Depends(require_tenant_admin),
):
    _ = platform
    _ = body
    return {"ok": True}
