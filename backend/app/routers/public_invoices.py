from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..config import settings

from ..db import get_db
from ..models import Customer, Invoice, Tenant, Payment, DocumentAttachment
from ..schemas import (
    PublicInvoiceLine,
    PublicInvoiceOut,
    PublicInvoicePaymentInfo,
    PublicInvoiceTotals,
    PublicPaymentSummary,
    PublicParty,
    PublicDocumentAttachmentOut,
)
from ..services.pdf import invoice_html, invoice_pdf
from ..services.document_pdf_context import document_vat_labels
from ..services.document_notes import visible_document_note
from ..services.invoice_public_artifacts import has_stored_facturx_artifact
from ..services.logo_storage import get_logo_url
from ..services.portal_settings import get_portal_settings
from ..services.product_capabilities import is_product_feature_enabled
from ..services.public_links import (
    invoice_public_link_days_left,
    invoice_public_link_expired_message,
    invoice_public_link_expires_at,
    is_invoice_public_link_expired,
)
from ..services.public_rate_limits import enforce_public_rate_limit
from ..services.document_attachments import sanitize_filename
from ..services.storage import get_object_stream, parse_range_header


router = APIRouter(prefix="/api/public/invoices", tags=["public_invoices"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _tenant_id_or_raise(tenant: Tenant | Invoice) -> str:
    tenant_id = tenant.tenant_id if isinstance(tenant, Invoice) else tenant.id
    if not tenant_id:
        raise HTTPException(404, "Not found")
    return tenant_id


def _invoice_id_or_raise(inv: Invoice) -> str:
    invoice_id = inv.id
    if not invoice_id:
        raise HTTPException(404, "Not found")
    return invoice_id


def _token_last4(token: str | None) -> str:
    clean = str(token or "").strip()
    return clean[-4:] if clean else ""


def _required_text(value: str | None, fallback: str) -> str:
    text = (value or "").strip()
    return text or fallback


def _derive_siren(value: str | None) -> str | None:
    digits = re.sub(r"\D+", "", value or "")
    if len(digits) >= 9:
        return digits[:9]
    return None


def _legal_rate_label(value: object | None) -> str:
    raw = str(value or "10").strip().replace("%", "") or "10"
    lowered = raw.lower()
    if "taux" in lowered or "bce" in lowered:
        return raw
    return f"{raw} %"


def _supplier_legal_mentions_is_default(value: str | None) -> bool:
    text = (value or "").strip().lower()
    return bool(
        text
        and "recouvrement" in text
        and ("escompte" in text or "paiement anticip" in text)
        and (
            "pénalités de retard" in text
            or "penalites de retard" in text
            or "pénalités au taux" in text
            or "penalites au taux" in text
            or "retard de paiement" in text
        )
    )


def _append_legal_extras(notice: str, template_options: dict, supplier_snapshot: dict, tenant: Tenant) -> str:
    extras: list[str] = []
    for value in (
        supplier_snapshot.get("legal_mentions"),
        getattr(tenant, "legal_mentions", None),
    ):
        text = str(value or "").strip()
        if text and text not in extras and text not in notice and not _supplier_legal_mentions_is_default(text):
            extras.append(text)
    if extras:
        return f"{notice}\n\n" + "\n\n".join(extras)
    return notice


def _invoice_legal_notice(template_options: dict, supplier_snapshot: dict, tenant: Tenant, lines: list | None = None) -> str:
    legal_footer = str(template_options.get("legal_footer_text") or "").strip()
    if legal_footer:
        return _append_legal_extras(legal_footer, template_options, supplier_snapshot, tenant)
    vat_label = document_vat_labels(supplier_snapshot or tenant, lines=lines or [], is_english=False).get("legal") or ""
    vat_sentence = vat_label if vat_label.endswith((".", "!", "?")) else (f"{vat_label}." if vat_label else "")
    raw_payment_block = supplier_snapshot.get("payment_terms_block") if isinstance(supplier_snapshot, dict) else {}
    payment_block = raw_payment_block if isinstance(raw_payment_block, dict) else {}
    penalty_rate = _legal_rate_label(
        template_options.get("legal_penalty_rate")
        or (payment_block or {}).get("late_payment_interest")
        or getattr(tenant, "late_payment_interest", None)
    )
    recovery_fee = str(
        template_options.get("legal_recovery_fee")
        or (payment_block or {}).get("recovery_fee_eur")
        or getattr(tenant, "recovery_fee_eur", None)
        or "40"
    ).strip()
    notice = (
        f"{vat_sentence + ' ' if vat_sentence else ''}Aucun escompte n'est accordé en cas de paiement anticipé. "
        f"En cas de retard de paiement, des pénalités au taux de {penalty_rate} seront dues à compter du lendemain "
        f"de l'échéance, ainsi qu'une indemnité forfaitaire de {recovery_fee} € pour frais de recouvrement."
    )
    return _append_legal_extras(notice, template_options, supplier_snapshot, tenant)


def _get_invoice_by_token(db: Session, token: str, request: Request | None = None) -> Invoice:
    if not token or len(token.strip()) < 16:
        raise HTTPException(404, "Not found")
    normalized_token = token.strip()
    enforce_public_rate_limit(
        token_key=f"public-invoice:{normalized_token}",
        token_limit=int(getattr(settings, "INVOICE_PUBLIC_RATE_LIMIT_PER_MINUTE", 120) or 120),
        ip_key_prefix="public-invoice",
        ip_limit=int(getattr(settings, "INVOICE_PUBLIC_IP_RATE_LIMIT_PER_MINUTE", 600) or 600),
        window_seconds=60,
        request=request,
        detail={
            "code": "rate_limited",
            "message": "Trop de consultations de cette facture. Réessayez dans un instant.",
        },
    )
    inv = db.query(Invoice).filter(Invoice.public_token == normalized_token).first()
    if not inv:
        raise HTTPException(404, "Not found")
    if not inv.public_enabled:
        raise HTTPException(404, "Not found")
    if is_invoice_public_link_expired(inv):
        inv.public_enabled = False
        db.add(inv)
        db.commit()
        raise HTTPException(
            status_code=410,
            detail={"code": "public_link_expired", "message": invoice_public_link_expired_message(inv)},
        )
    return inv


def _public_party_from_tenant(
    t: Tenant,
    *,
    snapshot: dict | None = None,
    payment_terms_block: dict | None = None,
) -> PublicParty:
    portal = get_portal_settings(t)
    source = dict(snapshot or {})
    logo = None
    snapshot_logo = (source.get("logo_url") or "").strip() or None
    if snapshot_logo:
        logo = snapshot_logo
    elif t.logo_storage_key:
        try:
            logo = get_logo_url(_tenant_id_or_raise(t), t.logo_storage_key)
        except Exception:
            logo = None
    if not logo:
        logo = t.logo_url or None
    address = str(source.get("address") or "").strip() or (t.address or "").strip() or None
    siret = str(source.get("siret") or source.get("legal_id") or "").strip() or (t.siret or None)
    siren = str(source.get("siren") or "").strip() or _derive_siren(siret)
    email = str(source.get("email") or source.get("email_reply_to") or "").strip() or (
        getattr(t, "email_reply_to", None) or None
    )
    support_email = portal.get("support_email") or (getattr(t, "email_reply_to", None) or None)
    footer_note = portal.get("footer_note") or None
    payment_block = payment_terms_block or source.get("payment_terms_block") or {}
    return PublicParty(
        name=(str(source.get("name") or "").strip() or (t.name or "").strip() or "Entreprise"),
        address=address,
        siren=siren,
        siret=siret,
        vat_number=(str(source.get("vat_number") or "").strip() or (t.vat_number or None)),
        vat_regime=(str(source.get("vat_regime") or "").strip() or (getattr(t, "vat_regime", None) or None)),
        vat_exemption_notice=(
            str(source.get("vat_exemption_notice") or "").strip()
            or (getattr(t, "vat_exemption_notice", None) or None)
        ),
        naf_code=(str(source.get("naf_code") or "").strip() or (getattr(t, "naf_code", None) or None)),
        logo_url=logo,
        email=email,
        phone=(str(source.get("phone") or "").strip() or (getattr(t, "phone", None) or None)),
        legal_form=(str(source.get("legal_form") or "").strip() or (getattr(t, "legal_form", None) or None)),
        share_capital=(str(source.get("share_capital") or "").strip() or (getattr(t, "share_capital", None) or None)),
        rcs=(str(source.get("rcs") or "").strip() or (getattr(t, "rcs", None) or None)),
        vat_on_debits=bool(
            source.get("vat_on_debits") if "vat_on_debits" in source else getattr(t, "vat_on_debits", False)
        ),
        late_payment_interest=(
            str(payment_block.get("late_payment_interest") or "").strip()
            or (getattr(t, "late_payment_interest", None) or None)
        ),
        recovery_fee_eur=float(payment_block.get("recovery_fee_eur"))
        if payment_block.get("recovery_fee_eur") is not None
        else (float(t.recovery_fee_eur) if t.recovery_fee_eur is not None else 40.0),
        discount_terms=(
            str(payment_block.get("discount_terms") or "").strip() or (getattr(t, "discount_terms", None) or None)
        ),
        portal_theme=str(portal.get("theme") or "blue"),
        portal_support_email=support_email,
        portal_footer_note=footer_note,
    )


def _public_party_from_customer(c: Customer, *, snapshot: dict | None = None) -> PublicParty:
    source = dict(snapshot or {})
    address = str(source.get("address") or "").strip() or (c.address or "").strip() or None
    siret = str(source.get("siret") or source.get("legal_id") or "").strip() or (c.siret or None)
    siren = str(source.get("siren") or "").strip() or (c.siren or None) or _derive_siren(siret)
    client_type = str(source.get("client_type") or getattr(c, "client_type", None) or "").strip() or None
    return PublicParty(
        name=(str(source.get("name") or "").strip() or (c.name or "").strip() or "Client"),
        address=address,
        client_type=client_type,
        siren=siren,
        siret=siret or siren,
        vat_number=(str(source.get("vat_number") or "").strip() or (c.vat_number or None)),
        email=(str(source.get("email") or "").strip() or (c.email or None)),
        phone=(str(source.get("phone") or "").strip() or (c.phone or None)),
        logo_url=None,
    )


def _bump_public_view(db: Session, inv: Invoice, *, source: str = "view") -> None:
    """Increment view count with a coarse time window (avoids write storms)."""

    window_seconds = int(getattr(settings, "INVOICE_PUBLIC_VIEW_WINDOW_SECONDS", 600) or 600)
    now = _utcnow()
    last = getattr(inv, "public_last_viewed_at", None)
    if last and (now - last).total_seconds() < window_seconds:
        return
    inv.public_view_count = int(getattr(inv, "public_view_count", 0) or 0) + 1
    if not getattr(inv, "public_first_viewed_at", None):
        inv.public_first_viewed_at = now
    inv.public_last_viewed_at = now
    db.add(inv)
    try:
        from ..services.action_logs import safe_log_action

        tenant_id = _tenant_id_or_raise(inv)
        invoice_id = _invoice_id_or_raise(inv)
        safe_log_action(
            db,
            tenant_id=tenant_id,
            actor_user_id=None,
            action_type="public_view",
            object_type="invoice",
            object_id=invoice_id,
            metadata={"source": source, "public_view_count": inv.public_view_count},
            commit=False,
        )
    except Exception:
        pass
    db.commit()


def _is_tenant_pro(tenant: Tenant | None) -> bool:
    return is_product_feature_enabled(tenant, "einvoicing_enabled")


def _payment_tracking_enabled(tenant: Tenant | None) -> bool:
    return is_product_feature_enabled(tenant, "payments_enabled")


def _invoice_status_for_public_view(inv: Invoice, *, payment_tracking_enabled: bool) -> str:
    status = str(inv.status or "issued").strip().lower() or "issued"
    if payment_tracking_enabled:
        return status
    if status in {"paid", "partial", "overdue", "pending", "refunded", "partially_refunded"}:
        return "sent" if getattr(inv, "sent_at", None) else "issued"
    return status


def _mask_document_context_payment_tracking(ctx: dict, inv: Invoice, *, payment_tracking_enabled: bool) -> dict:
    if payment_tracking_enabled:
        return ctx
    invoice_ctx = ctx.get("invoice") if isinstance(ctx, dict) else None
    if isinstance(invoice_ctx, dict):
        ctx["invoice"] = {
            **invoice_ctx,
            "status": _invoice_status_for_public_view(inv, payment_tracking_enabled=False),
            "balance_due": None,
        }
    totals_ctx = ctx.get("totals") if isinstance(ctx, dict) else None
    if isinstance(totals_ctx, dict):
        ctx["totals"] = {**totals_ctx, "prepaid": 0}
    return ctx


def _stripe_invoice_payments_enabled(tenant: Tenant | None) -> bool:
    """Customer invoice card payments are intentionally disabled.

    Stripe is kept for SaaS billing and token packs only. Collecting invoice
    payments for customer tenants would require a connected-account flow.
    """
    return False


def _public_invoice_out(db: Session, inv: Invoice) -> PublicInvoiceOut:
    tenant_id = _tenant_id_or_raise(inv)
    tenant = db.get(Tenant, tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    # Reuse router logic for due date + outstanding.
    from .invoices import _compute_due_date_no_write, _ctx, _snapshot_customer, _snapshot_supplier

    ctx = _ctx(db, inv, allow_missing_identifiers=True)
    template_options = ctx.get("template_options") if isinstance(ctx.get("template_options"), dict) else {}
    ctx_totals = ctx.get("totals") if isinstance(ctx.get("totals"), dict) else {}
    ctx_lines = ctx.get("lines") if isinstance(ctx.get("lines"), list) else []
    due_date = _compute_due_date_no_write(inv)
    payment_tracking_enabled = _payment_tracking_enabled(tenant)
    balance_due = (
        float(Decimal(str((ctx.get("invoice") or {}).get("balance_due", 0))))
        if payment_tracking_enabled
        else 0.0
    )
    supplier_snapshot_source = inv.seller_snapshot if isinstance(inv.seller_snapshot, dict) else None
    if not supplier_snapshot_source and isinstance(getattr(inv, "supplier_snapshot", None), dict):
        supplier_snapshot_source = inv.supplier_snapshot
    supplier_snapshot = _snapshot_supplier(tenant, supplier_snapshot_source or {}, inv)
    customer_snapshot = _snapshot_customer(customer, inv.buyer_snapshot if isinstance(inv.buyer_snapshot, dict) else {})
    payment_terms_block = supplier_snapshot.get("payment_terms_block") if isinstance(supplier_snapshot, dict) else None

    has_facturx = bool(_is_tenant_pro(tenant) and has_stored_facturx_artifact(db, inv))

    card_payment_enabled = bool(
        _stripe_invoice_payments_enabled(tenant)
        and inv.type == "invoice"
        and inv.status not in {"draft", "canceled", "paid"}
        and balance_due > 0
        and (inv.currency or "EUR").strip().upper() == "EUR"
    )

    payment = None
    iban = str(supplier_snapshot.get("iban") or "").strip() or None
    bic = str(supplier_snapshot.get("bic") or "").strip() or None
    if iban or bic:
        payment = PublicInvoicePaymentInfo(
            iban=iban,
            bic=bic,
            payment_reference=(inv.number or None),
        )

    payments = (
        db.query(Payment).filter(Payment.invoice_id == inv.id).order_by(Payment.date.desc()).limit(5).all()
        if payment_tracking_enabled
        else []
    )
    payments_out = [
        PublicPaymentSummary(
            date=p.date or _utcnow(),
            method=p.method,
            amount=float(p.amount or 0),
            provider=getattr(p, "provider", None),
            receipt_url=getattr(p, "receipt_url", None),
            card_brand=getattr(p, "card_brand", None),
            card_last4=getattr(p, "card_last4", None),
        )
        for p in payments
    ]

    attachments = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.invoice_id == inv.id)
        .filter(DocumentAttachment.tenant_id == inv.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .filter(DocumentAttachment.public_visible.is_(True))
        .order_by(DocumentAttachment.created_at.asc())
        .all()
    )
    attachments_out = [
        PublicDocumentAttachmentOut(
            id=_required_text(a.id, f"attachment-{index}"),
            filename=_required_text(a.filename, f"attachment-{index}.bin"),
            label=a.label,
            content_type=_required_text(a.content_type, "application/octet-stream"),
            size_bytes=int(a.size_bytes or 0),
        )
        for index, a in enumerate(attachments, 1)
    ]

    return PublicInvoiceOut(
        number=inv.number,
        type=getattr(inv, "type", None),
        currency=_required_text(inv.currency, "EUR"),
        status=_invoice_status_for_public_view(
            inv,
            payment_tracking_enabled=payment_tracking_enabled,
        ),
        issue_date=inv.issue_date or _utcnow(),
        service_date=getattr(inv, "service_date", None),
        due_date=due_date,
        payment_terms=getattr(inv, "payment_terms", None),
        delivery_address=getattr(inv, "delivery_address", None),
        delivery_address_differs=bool(getattr(inv, "delivery_address_differs", False)),
        operation_nature=getattr(inv, "operation_nature", None),
        purchase_order_number=getattr(inv, "purchase_order_number", None),
        note=visible_document_note(
            inv.note,
            template_options.get("document_title"),
            template_options.get("legal_mentions_text"),
        ),
        legal_notice=_invoice_legal_notice(template_options, supplier_snapshot, tenant, ctx_lines),
        supplier=_public_party_from_tenant(tenant, snapshot=supplier_snapshot, payment_terms_block=payment_terms_block),
        customer=_public_party_from_customer(customer, snapshot=customer_snapshot),
        totals=PublicInvoiceTotals(
            total_ex_vat=float(ctx_totals.get("ht") or 0),
            total_vat=float(ctx_totals.get("vat") or 0),
            total_inc_vat=float(ctx_totals.get("ttc") or 0),
            balance_due=balance_due,
            allowance=float(ctx_totals.get("allowance") or 0),
            prepaid=float(ctx_totals.get("prepaid") or 0) if payment_tracking_enabled else 0.0,
        ),
        lines=[
            PublicInvoiceLine(
                line_type=str(invoice_line.get("line_type") or "item"),
                display_number=invoice_line.get("display_number"),
                reference=invoice_line.get("reference"),
                product_name=_required_text(str(invoice_line.get("product_name") or ""), "Ligne"),
                detail=invoice_line.get("detail"),
                quantity=float(invoice_line.get("quantity") or 0),
                unit_price=float(invoice_line.get("unit_price") or 0),
                vat_rate=float(invoice_line.get("vat_rate") or 0),
                vat_category=invoice_line.get("vat_category"),
                unit_code=invoice_line.get("unit_code"),
                exemption_reason_code=invoice_line.get("exemption_reason_code"),
                line_total=float(invoice_line.get("line_total") or 0),
            )
            for invoice_line in ctx_lines
        ],
        attachments=attachments_out,
        payment=payment,
        payments=payments_out,
        payment_tracking_enabled=payment_tracking_enabled,
        has_facturx=has_facturx,
        card_payment_enabled=card_payment_enabled,
        public_expires_at=invoice_public_link_expires_at(inv),
        public_expires_in_days=invoice_public_link_days_left(inv),
    )


@router.get("/{token}", response_model=PublicInvoiceOut)
def get_public_invoice(token: str, request: Request, db: Session = Depends(get_db)):
    inv = _get_invoice_by_token(db, token, request)
    _bump_public_view(db, inv, source="view")
    return _public_invoice_out(db, inv)


@router.get("/{token}/attachments", response_model=list[PublicDocumentAttachmentOut])
def list_public_invoice_attachments(token: str, request: Request, db: Session = Depends(get_db)):
    inv = _get_invoice_by_token(db, token, request)
    _bump_public_view(db, inv, source="attachments")
    rows = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.invoice_id == inv.id)
        .filter(DocumentAttachment.tenant_id == inv.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .filter(DocumentAttachment.public_visible.is_(True))
        .order_by(DocumentAttachment.created_at.asc())
        .all()
    )
    return [
        PublicDocumentAttachmentOut(
            id=_required_text(a.id, f"attachment-{index}"),
            filename=_required_text(a.filename, f"attachment-{index}.bin"),
            label=a.label,
            content_type=_required_text(a.content_type, "application/octet-stream"),
            size_bytes=int(a.size_bytes or 0),
        )
        for index, a in enumerate(rows, 1)
    ]


@router.get("/{token}/attachments/{attachment_id}/file")
def get_public_invoice_attachment_file(
    token: str, attachment_id: str, request: Request, download: bool = False, db: Session = Depends(get_db)
):
    inv = _get_invoice_by_token(db, token, request)
    _bump_public_view(db, inv, source="attachment_file")
    att = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.id == attachment_id)
        .filter(DocumentAttachment.invoice_id == inv.id)
        .filter(DocumentAttachment.tenant_id == inv.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .filter(DocumentAttachment.public_visible.is_(True))
        .first()
    )
    if not att:
        raise HTTPException(404, "Not found")

    storage_key = att.storage_key
    if not storage_key:
        raise HTTPException(404, "Not found")

    stream = get_object_stream(storage_key)
    if not stream:
        raise HTTPException(404, "Not found")

    status_code = 200
    headers: dict[str, str] = {
        "Cache-Control": "private, max-age=0, no-store",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
    }

    range_header = request.headers.get("range")
    if range_header:
        byte_range = parse_range_header(range_header, stream.total_size)
        if byte_range:
            start, end = byte_range
            ranged = get_object_stream(storage_key, byte_range=byte_range)
            if ranged:
                stream = ranged
                status_code = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{stream.total_size}"

    if stream.content_length:
        headers["Content-Length"] = str(stream.content_length)
    if stream.etag:
        headers["ETag"] = stream.etag

    disp = "attachment" if bool(download) else "inline"
    headers["Content-Disposition"] = f'{disp}; filename="{sanitize_filename(att.filename)}"'

    return StreamingResponse(
        stream.body, media_type=att.content_type or "application/octet-stream", headers=headers, status_code=status_code
    )


@router.get("/{token}/pdf")
def get_public_invoice_pdf(token: str, request: Request, db: Session = Depends(get_db)):
    inv = _get_invoice_by_token(db, token, request)
    _bump_public_view(db, inv, source="pdf")
    from .invoices import (
        _artifact_storage_key_for_kind,
        _ctx,
        _ensure_invoice_artifact_integrity,
        _is_invoice_immutable,
        _safe_filename,
        _stream_invoice_artifact,
        ensure_invoice_artifact,
    )

    filename = _safe_filename("facture", inv.number, "pdf")
    tenant = db.get(Tenant, inv.tenant_id)
    payment_tracking_enabled = _payment_tracking_enabled(tenant)
    if payment_tracking_enabled and _is_invoice_immutable(inv):
        artifact = ensure_invoice_artifact(db, inv, "pdf")
        _ensure_invoice_artifact_integrity(db, inv, artifact, "pdf")
        storage_key = _artifact_storage_key_for_kind(inv, "PDF", artifact)
        if not storage_key:
            raise HTTPException(404, "Not found")
        db.commit()
        return _stream_invoice_artifact(
            request,
            storage_key,
            artifact.content_type,
            filename,
            disposition="inline",
        )

    ctx = _mask_document_context_payment_tracking(
        _ctx(db, inv),
        inv,
        payment_tracking_enabled=payment_tracking_enabled,
    )
    content = invoice_pdf(ctx)
    return Response(
        content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=0, no-store",
        },
    )


@router.get("/{token}/preview.html")
def get_public_invoice_preview_html(token: str, request: Request, db: Session = Depends(get_db)):
    inv = _get_invoice_by_token(db, token, request)
    _bump_public_view(db, inv, source="preview")
    from .invoices import _ctx

    tenant = db.get(Tenant, inv.tenant_id)
    ctx = _mask_document_context_payment_tracking(
        _ctx(db, inv, allow_missing_identifiers=True),
        inv,
        payment_tracking_enabled=_payment_tracking_enabled(tenant),
    )
    html = invoice_html(ctx)
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "private, max-age=0, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline';",
        },
    )


@router.get("/{token}/facturx")
def get_public_invoice_facturx(token: str, request: Request, db: Session = Depends(get_db)):
    inv = _get_invoice_by_token(db, token, request)
    _bump_public_view(db, inv, source="facturx")
    tenant = db.get(Tenant, inv.tenant_id)
    if not _is_tenant_pro(tenant) or not has_stored_facturx_artifact(db, inv):
        raise HTTPException(403, "Factur-X réservé au plan Pro")
    from ..services.invoices import export as invoice_export_service

    # On réutilise la même logique d'export que l'app (génération/validation/stockage)
    fake_user = type("_U", (), {"tenant_id": inv.tenant_id})()
    # Export service construit un Response avec attachment; on conserve.
    return invoice_export_service.export_facturx(_invoice_id_or_raise(inv), request, db, fake_user)


@router.post("/{token}/pay/checkout")
def create_public_invoice_checkout(token: str, request: Request, db: Session = Depends(get_db)):
    """Crée une session Stripe Checkout pour régler la facture (sans compte)."""
    inv = _get_invoice_by_token(db, token, request)
    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not _payment_tracking_enabled(tenant) or not _stripe_invoice_payments_enabled(tenant):
        raise HTTPException(404, "Not found")
    if inv.type != "invoice":
        raise HTTPException(400, "Paiement carte non disponible pour ce document")
    if inv.status in {"draft", "canceled"}:
        raise HTTPException(400, "Facture non émise")
    if (inv.currency or "EUR").strip().upper() != "EUR":
        raise HTTPException(400, "Paiement carte disponible uniquement en EUR")

    # Outstanding
    from .invoices import _outstanding

    amount = _outstanding(db, inv)
    if amount <= 0:
        raise HTTPException(400, "Facture déjà soldée")

    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
    if not base:
        raise HTTPException(500, detail={"code": "payment_setup_unavailable", "message": "Le paiement par carte est momentanément indisponible."})

    # Stripe Checkout
    import stripe

    stripe.api_key = settings.STRIPE_SECRET_KEY

    tenant_id = _tenant_id_or_raise(inv)
    invoice_id = _invoice_id_or_raise(inv)
    customer_email = ((customer.email or "").strip() or None) if customer else None
    cents = int((amount * Decimal("100")).quantize(Decimal("1")))
    if cents <= 0:
        raise HTTPException(400, "Montant invalide")

    label = f"Facture {inv.number}" if inv.number else "Facture"
    success_url = f"{base}/i/{token}?payment=success&session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{base}/i/{token}?payment=cancel"
    payment_version = db.query(Payment).filter(Payment.invoice_id == inv.id).count()

    checkout_payload = {
        "mode": "payment",
        "payment_method_types": ["card"],
        "line_items": [
            {
                "price_data": {
                    "currency": "eur",
                    "product_data": {"name": label},
                    "unit_amount": cents,
                },
                "quantity": 1,
            }
        ],
        "success_url": success_url,
        "cancel_url": cancel_url,
        "metadata": {
            "kind": "invoice_payment",
            "tenant_id": tenant_id,
            "invoice_id": invoice_id,
            "public_token_last4": _token_last4(token),
            "invoice_number": (inv.number or ""),
        },
        "client_reference_id": tenant_id,
        "idempotency_key": f"invoice-payment:{invoice_id}:{cents}:v{payment_version}",
    }
    if customer_email:
        checkout_payload["customer_email"] = customer_email
    session = stripe.checkout.Session.create(**checkout_payload)
    return {"url": session.url}


@router.get("/{token}/facturx.pdf")
def get_public_invoice_facturx_pdf(token: str, request: Request, db: Session = Depends(get_db)):
    # Alias pour compatibilité front
    return get_public_invoice_facturx(token, request, db)


@router.get("/{token}/bundle.zip")
def get_public_invoice_bundle_zip(token: str, request: Request, db: Session = Depends(get_db)):
    """Export ZIP (portail) : PDF + Factur-X (si dispo) + pièces jointes visibles client."""
    inv = _get_invoice_by_token(db, token, request)
    _bump_public_view(db, inv, source="bundle")
    from ..services.bundles import build_invoice_bundle_zip, stream_zip_file

    path, filename = build_invoice_bundle_zip(
        db,
        invoice_id=_invoice_id_or_raise(inv),
        tenant_id=_tenant_id_or_raise(inv),
        include_private_attachments=False,
    )
    return stream_zip_file(path, filename)
