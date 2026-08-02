from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import AuthUser, current_user, require_product_feature
from ..models import (
    CustomerUserLink,
    EInvoiceTransmission,
    EInvoicingTransmission,
    Invoice,
    Tenant,
    TransmissionEvent,
)
from ..schemas import ClientInvoiceOut
from ..services.product_capabilities import is_product_feature_enabled
from ..utils.public_provider_messages import sanitize_public_provider_message
from .invoices import (
    _mark_overdue,
    _safe_filename,
    _stream_invoice_artifact,
    _artifact_storage_key_for_kind,
    ensure_invoice_artifact,
)

router = APIRouter(prefix="/api/client", tags=["client"])


def _require_client_link(db: Session, user: AuthUser) -> CustomerUserLink:
    if not getattr(settings, "FEATURE_CLIENT_PORTAL", False):
        raise HTTPException(
            status_code=403,
            detail={"code": "role_not_enabled", "message": "Portail client non activé."},
        )
    if (user.role or "").lower() != "client":
        raise HTTPException(status_code=403, detail="Accès réservé au portail client.")
    link = (
        db.query(CustomerUserLink)
        .filter(
            CustomerUserLink.user_id == user.id,
            CustomerUserLink.tenant_id == user.tenant_id,
        )
        .first()
    )
    if not link:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "client_not_linked",
                "message": "Aucun client associé à votre compte.",
            },
        )
    return link


def _get_client_invoice(db: Session, user: AuthUser, link: CustomerUserLink, invoice_id: str) -> Invoice:
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id or inv.customer_id != link.customer_id:
        raise HTTPException(404, "Not found")
    if inv.status == "draft":
        raise HTTPException(
            status_code=409,
            detail={"code": "invoice_not_issued", "message": "Facture non émise."},
        )
    return inv


def _iso(value: object | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    iso_method = getattr(value, "isoformat", None)
    if callable(iso_method):
        return str(iso_method())
    return str(value)


def _safe_text(value: object | None, limit: int = 240) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}…"


def _safe_provider_text(value: object | None, limit: int = 240) -> str | None:
    return sanitize_public_provider_message(value, max_chars=limit)


def _pdp_kind(channel: str | None) -> str:
    normalized = (channel or "").strip().lower()
    if normalized in {"chorus", "choruspro"}:
        return "chorus"
    return "pdp"


def _transmission_sort_key(item: dict[str, object]) -> str:
    updated_at = item.get("updated_at")
    if isinstance(updated_at, str) and updated_at:
        return updated_at
    created_at = item.get("created_at")
    if isinstance(created_at, str) and created_at:
        return created_at
    return ""


def _payment_neutral_status(inv: Invoice) -> str:
    status = str(inv.status or "unknown").strip().lower()
    if status in {"paid", "partial", "overdue"}:
        return "sent" if inv.sent_at else "issued"
    return status


@router.get("/invoices", response_model=list[ClientInvoiceOut])
def list_client_invoices(db: Session = Depends(get_db), user: AuthUser = Depends(current_user)):
    link = _require_client_link(db, user)
    tenant = db.get(Tenant, user.tenant_id)
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    q = (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == user.tenant_id,
            Invoice.customer_id == link.customer_id,
            Invoice.status != "draft",
        )
        .order_by(Invoice.issue_date.desc())
    )
    items = q.all()
    if payments_enabled:
        dirty = False
        for inv in items:
            if _mark_overdue(inv, db):
                dirty = True
        if dirty:
            db.commit()
        return items
    return [
        {
            "id": inv.id,
            "number": inv.number,
            "status": _payment_neutral_status(inv),
            "issue_date": inv.issue_date,
            "due_date": inv.due_date,
            "total_inc_vat": inv.total_inc_vat,
            "currency": inv.currency,
        }
        for inv in items
    ]


@router.get("/invoices/{invoice_id}/transmissions")
def get_client_transmissions(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
    _feature_user: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    link = _require_client_link(db, user)
    inv = _get_client_invoice(db, user, link, invoice_id)

    pdp_transmissions = (
        db.query(EInvoicingTransmission)
        .filter(EInvoicingTransmission.invoice_id == inv.id)
        .order_by(EInvoicingTransmission.updated_at.desc(), EInvoicingTransmission.created_at.desc())
        .all()
    )
    events_by_tx: dict[str, list[dict[str, object]]] = {}
    tx_ids = [tx.id for tx in pdp_transmissions]
    if tx_ids:
        rows = (
            db.query(TransmissionEvent)
            .filter(TransmissionEvent.transmission_id.in_(tx_ids))
            .order_by(TransmissionEvent.occurred_at.asc(), TransmissionEvent.created_at.asc())
            .all()
        )
        for ev in rows:
            transmission_id = ev.transmission_id
            if not transmission_id:
                continue
            payload = ev.payload_raw if isinstance(ev.payload_raw, dict) else {}
            events_by_tx.setdefault(transmission_id, []).append(
                {
                    "event_type": ev.event_type,
                    "status": ev.status_code_norme,
                    "message": _safe_provider_text(payload.get("message")),
                    "source": _safe_text(payload.get("source")),
                    "occurred_at": _iso(ev.occurred_at),
                }
            )

    items: list[dict[str, object]] = []
    for pdp_tx in pdp_transmissions:
        transmission_id = pdp_tx.id
        if not transmission_id:
            continue
        pdp_events = events_by_tx.get(transmission_id) or []
        if not pdp_events:
            pdp_events = [
                {
                    "event_type": "status",
                    "status": pdp_tx.status,
                    "message": None,
                    "source": None,
                    "occurred_at": _iso(pdp_tx.updated_at or pdp_tx.created_at),
                }
            ]
        items.append(
            {
                "id": transmission_id,
                "kind": _pdp_kind(pdp_tx.channel),
                "channel": pdp_tx.channel,
                "status": pdp_tx.status,
                "external_id": pdp_tx.external_id,
                "created_at": _iso(pdp_tx.created_at),
                "updated_at": _iso(pdp_tx.updated_at),
                "events": pdp_events,
            }
        )

    partner_rows = (
        db.query(EInvoiceTransmission)
        .filter(EInvoiceTransmission.invoice_id == inv.id, EInvoiceTransmission.tenant_id == inv.tenant_id)
        .order_by(EInvoiceTransmission.updated_at.desc(), EInvoiceTransmission.created_at.desc())
        .all()
    )
    for partner_tx in partner_rows:
        partner_events: list[dict[str, object]] = []
        raw_events = partner_tx.raw_events if isinstance(partner_tx.raw_events, list) else []
        for ev in raw_events:
            if not isinstance(ev, dict):
                continue
            partner_events.append(
                {
                    "event_type": _safe_text(ev.get("type") or "status"),
                    "status": _safe_text(ev.get("status") or partner_tx.status),
                    "message": _safe_provider_text(ev.get("message")),
                    "source": "partner",
                    "occurred_at": _safe_text(ev.get("at")),
                }
            )
        if not partner_events:
            partner_events = [
                {
                    "event_type": "status",
                    "status": partner_tx.status,
                    "message": _safe_provider_text(partner_tx.error_message),
                    "source": "partner",
                    "occurred_at": _iso(partner_tx.last_event_at or partner_tx.updated_at or partner_tx.created_at),
                }
            ]
        items.append(
            {
                "id": partner_tx.id,
                "kind": "partner",
                "channel": partner_tx.platform,
                "status": partner_tx.status,
                "external_id": partner_tx.external_id,
                "created_at": _iso(partner_tx.created_at),
                "updated_at": _iso(partner_tx.updated_at),
                "events": partner_events,
            }
        )

    items.sort(key=_transmission_sort_key, reverse=True)
    return {"invoice_id": inv.id, "transmissions": items}


@router.get("/invoices/{invoice_id}/pdf")
def get_client_pdf(
    invoice_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    link = _require_client_link(db, user)
    inv = _get_client_invoice(db, user, link, invoice_id)
    filename = _safe_filename("facture", inv.number, "pdf")
    artifact = ensure_invoice_artifact(db, inv, "pdf")
    storage_key = _artifact_storage_key_for_kind(inv, "PDF", artifact)
    if not storage_key:
        raise HTTPException(404, "Not found")
    resolved_storage_key = storage_key
    content_type = artifact.content_type or "application/pdf"
    db.commit()
    return _stream_invoice_artifact(
        request,
        resolved_storage_key,
        content_type,
        filename,
    )


@router.get("/invoices/{invoice_id}/facturx")
def get_client_facturx(
    invoice_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
    _feature_user: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    link = _require_client_link(db, user)
    inv = _get_client_invoice(db, user, link, invoice_id)
    filename = _safe_filename("facturx", inv.number, "pdf")
    artifact = ensure_invoice_artifact(db, inv, "facturx")
    storage_key = _artifact_storage_key_for_kind(inv, "FACTURX", artifact)
    if not storage_key:
        raise HTTPException(404, "Not found")
    resolved_storage_key = storage_key
    content_type = artifact.content_type or "application/pdf"
    db.commit()
    return _stream_invoice_artifact(
        request,
        resolved_storage_key,
        content_type,
        filename,
    )
