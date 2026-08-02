from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import (
    AuthUser,
    require_accountant_or_admin,
    require_legacy_einvoicing_api,
    require_paid_subscription,
    require_product_feature,
    require_viewer_or_admin,
)
from ..models import Customer, EInvoicingTransmission, Invoice
from ..schemas import PdpSubmitRequest
from ..services.connected_mode import ensure_connected_mode_operational
from . import einvoicing as einvoicing_router
from . import platforms as platforms_router

router = APIRouter(prefix="/api/e-invoicing/pdp", tags=["einvoicing"])


@router.post("/submit/{invoice_id}")
async def submit_pdp(
    invoice_id: str,
    payload: PdpSubmitRequest | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription),
    __: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
    ___: None = Depends(require_legacy_einvoicing_api),
):
    payload = payload or PdpSubmitRequest()
    provider_slug = (payload.provider_slug or "").strip().lower() or None
    if provider_slug is None:
        invoice = db.get(Invoice, invoice_id)
        customer = db.get(Customer, invoice.customer_id) if invoice and invoice.customer_id else None
        provider_slug = "choruspro" if platforms_router._is_public_customer(customer) else "seqino"
    ensure_connected_mode_operational(db, user.tenant_id, provider_slug)
    send_payload = einvoicing_router.EinvoicingSendRequest(
        invoice_id=invoice_id,
        provider_slug=payload.provider_slug,
    )
    result = await einvoicing_router.send_einvoicing(send_payload, db, user)
    tx = db.get(EInvoicingTransmission, result.get("transmission_id"))
    if not tx:
        raise HTTPException(404, "Transmission introuvable")
    inv = db.get(Invoice, tx.invoice_id)
    if inv:
        platforms_router._record_submission(db, inv, tx.channel, tx)
    return {
        "ok": True,
        "channel": tx.channel,
        "status": tx.status,
        "external_id": tx.external_id,
        "transmission_id": tx.id,
    }


@router.get("/status/{external_id}")
async def get_pdp_status(
    external_id: str,
    provider_slug: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
    __: AuthUser = Depends(require_paid_subscription),
    ___: None = Depends(require_legacy_einvoicing_api),
):
    return await platforms_router.get_status_impl(external_id, provider_slug, db, user)
