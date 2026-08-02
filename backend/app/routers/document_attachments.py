from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import (
    AuthUser,
    require_accountant_or_admin,
    require_commercial_user,
    require_paid_subscription_or_trial,
    require_viewer_or_admin,
)
from ..models import DocumentAttachment, Invoice, Quote, Tenant
from ..schemas import DocumentAttachmentOut, DocumentAttachmentPatch
from ..services.document_attachments import (
    ALLOWED_CONTENT_TYPES,
    build_storage_key,
    detect_content_type,
    get_document_attachment_count,
    get_purchase_attachment_unknown_size_count,
    get_used_bytes,
    resolve_limits_for_tenant,
    sanitize_filename,
    sha256_hex,
)
from ..services.storage import delete_object, get_object_stream, parse_range_header, put_object

router = APIRouter(tags=["attachments"])

_ATTACHMENT_FALLBACK_MAX_BYTES = 25 * 1024 * 1024


async def _read_upload_with_limit(file: UploadFile, max_file_bytes: int) -> tuple[bytes, int]:
    max_bytes = int(max_file_bytes or _ATTACHMENT_FALLBACK_MAX_BYTES)
    raw = await file.read(max_bytes + 1)
    size = len(raw or b"")
    if not raw or size <= 0:
        raise HTTPException(400, detail={"code": "attachments_empty", "message": "Fichier vide."})
    if size > max_bytes:
        raise HTTPException(
            413,
            detail={
                "code": "attachments_file_too_large",
                "message": f"Fichier trop volumineux (max {max_bytes // (1024 * 1024)}MB).",
            },
        )
    return raw, size


def _stream_storage_key(
    *,
    storage_key: str,
    request: Request,
    content_type: str,
    filename: str,
    inline: bool,
) -> StreamingResponse:
    stream = get_object_stream(storage_key)
    if not stream:
        raise HTTPException(404, "Fichier introuvable")

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

    disp = "inline" if inline else "attachment"
    safe = sanitize_filename(filename)
    headers["Content-Disposition"] = f'{disp}; filename="{safe}"'

    return StreamingResponse(
        stream.body, media_type=content_type or "application/octet-stream", headers=headers, status_code=status_code
    )


def _ensure_invoice(db: Session, tenant_id: str, invoice_id: str) -> Invoice:
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != tenant_id:
        raise HTTPException(404, "Facture introuvable")
    return inv


def _ensure_quote(db: Session, tenant_id: str, quote_id: str) -> Quote:
    q = db.get(Quote, quote_id)
    if not q or q.tenant_id != tenant_id:
        raise HTTPException(404, "Devis introuvable")
    return q


def _ensure_quote_attachments_mutable(quote: Quote) -> None:
    if (
        quote.status != "draft"
        or quote.sent_at
        or quote.accepted_at
        or quote.rejected_at
        or quote.invoice_id
        or quote.public_enabled
    ):
        raise HTTPException(
            409,
            detail={
                "code": "quote_attachments_locked",
                "message": "Les pièces jointes d'un devis envoyé ou figé ne sont plus modifiables. Créez une copie modifiable du devis.",
            },
        )


def _load_attachment(
    db: Session,
    *,
    tenant_id: str,
    attachment_id: str,
    invoice_id: str | None = None,
    quote_id: str | None = None,
) -> DocumentAttachment:
    query = db.query(DocumentAttachment).filter(DocumentAttachment.id == attachment_id)
    query = query.filter(DocumentAttachment.tenant_id == tenant_id)
    query = query.filter(DocumentAttachment.deleted_at.is_(None))
    if invoice_id:
        query = query.filter(DocumentAttachment.invoice_id == invoice_id)
    if quote_id:
        query = query.filter(DocumentAttachment.quote_id == quote_id)
    att = query.first()
    if not att:
        raise HTTPException(404, "Pièce jointe introuvable")
    return att


@router.get("/api/invoices/{invoice_id}/attachments", response_model=list[DocumentAttachmentOut])
def list_invoice_attachments(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    _ensure_invoice(db, user.tenant_id, invoice_id)
    rows = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.tenant_id == user.tenant_id)
        .filter(DocumentAttachment.invoice_id == invoice_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .order_by(DocumentAttachment.created_at.asc())
        .all()
    )
    return rows


@router.post("/api/invoices/{invoice_id}/attachments", response_model=DocumentAttachmentOut)
async def upload_invoice_attachment(
    invoice_id: str,
    file: UploadFile = File(...),
    label: str | None = Form(None),
    public_visible: bool = Form(False),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _ensure_invoice(db, user.tenant_id, invoice_id)
    tenant = db.get(Tenant, user.tenant_id)
    limits = resolve_limits_for_tenant(tenant)

    raw, size = await _read_upload_with_limit(file, limits.max_file_bytes)

    unknown_purchase_sizes = get_purchase_attachment_unknown_size_count(db, user.tenant_id)
    if unknown_purchase_sizes:
        raise HTTPException(
            409,
            detail={
                "code": "purchase_attachment_size_backfill_required",
                "message": "Stockage pièces jointes à recalculer avant nouvel upload.",
                "unknown_size_count": unknown_purchase_sizes,
            },
        )
    used = get_used_bytes(db, user.tenant_id)
    if limits.quota_bytes and (used + size) > limits.quota_bytes:
        raise HTTPException(
            400,
            detail={
                "code": "attachments_quota_exceeded",
                "message": "Quota pièces jointes dépassé. Supprimez des fichiers ou changez de plan.",
                "used_bytes": used,
                "quota_bytes": limits.quota_bytes,
            },
        )

    count = get_document_attachment_count(db, tenant_id=user.tenant_id, invoice_id=invoice_id)
    if limits.max_per_document and count >= limits.max_per_document:
        raise HTTPException(
            400,
            detail={
                "code": "attachments_doc_limit",
                "message": f"Limite atteinte: {limits.max_per_document} pièces jointes / facture.",
            },
        )

    detected = detect_content_type(raw, file.content_type)
    if not detected or detected not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            400,
            detail={
                "code": "attachments_invalid_type",
                "message": "Format non supporté. Autorisés: PDF, PNG, JPG, WEBP.",
            },
        )

    safe_name = sanitize_filename(file.filename)
    required_ext = ALLOWED_CONTENT_TYPES.get(detected)
    if required_ext and not safe_name.lower().endswith(required_ext):
        root_name, _ext = os.path.splitext(safe_name)
        safe_name = (root_name or "piece_jointe") + required_ext

    attachment_id = uuid.uuid4().hex
    storage_key = build_storage_key(
        tenant_id=user.tenant_id,
        parent_kind="invoice",
        parent_id=invoice_id,
        attachment_id=attachment_id,
        filename=safe_name,
    )

    try:
        put_object(storage_key, raw, content_type=detected)
    except Exception:
        raise HTTPException(500, "Stockage indisponible")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    att = DocumentAttachment(
        id=attachment_id,
        tenant_id=user.tenant_id,
        invoice_id=invoice_id,
        quote_id=None,
        filename=safe_name,
        label=(label or "").strip() or None,
        content_type=detected,
        size_bytes=size,
        sha256=sha256_hex(raw),
        storage_key=storage_key,
        public_visible=bool(public_visible),
        created_at=now,
        created_by=user.id,
        updated_at=now,
        updated_by=user.id,
    )
    db.add(att)
    try:
        db.commit()
    except Exception:
        db.rollback()
        try:
            delete_object(storage_key)
        except Exception:
            pass
        raise
    db.refresh(att)
    return att


@router.patch("/api/invoices/{invoice_id}/attachments/{attachment_id}", response_model=DocumentAttachmentOut)
def patch_invoice_attachment(
    invoice_id: str,
    attachment_id: str,
    body: DocumentAttachmentPatch,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _ensure_invoice(db, user.tenant_id, invoice_id)
    att = _load_attachment(db, tenant_id=user.tenant_id, attachment_id=attachment_id, invoice_id=invoice_id)
    updates = body.model_dump(exclude_unset=True)
    if "label" in updates:
        att.label = (updates.get("label") or "").strip() or None
    if "public_visible" in updates and updates.get("public_visible") is not None:
        att.public_visible = bool(updates.get("public_visible"))
    att.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    att.updated_by = user.id
    db.add(att)
    db.commit()
    db.refresh(att)
    return att


@router.delete("/api/invoices/{invoice_id}/attachments/{attachment_id}")
def delete_invoice_attachment(
    invoice_id: str,
    attachment_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _ensure_invoice(db, user.tenant_id, invoice_id)
    att = _load_attachment(db, tenant_id=user.tenant_id, attachment_id=attachment_id, invoice_id=invoice_id)
    att.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    att.deleted_by = user.id
    db.add(att)
    db.commit()
    # Best-effort: delete blob to free quota
    try:
        if att.storage_key:
            delete_object(att.storage_key)
    except Exception:
        pass
    return {"ok": True}


@router.get("/api/invoices/{invoice_id}/attachments/{attachment_id}/file")
def get_invoice_attachment_file(
    invoice_id: str,
    attachment_id: str,
    request: Request,
    download: bool = False,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    _ensure_invoice(db, user.tenant_id, invoice_id)
    att = _load_attachment(db, tenant_id=user.tenant_id, attachment_id=attachment_id, invoice_id=invoice_id)
    return _stream_storage_key(
        storage_key=att.storage_key,
        request=request,
        content_type=att.content_type or "application/octet-stream",
        filename=att.filename,
        inline=not bool(download),
    )


@router.get("/api/quotes/{quote_id}/attachments", response_model=list[DocumentAttachmentOut])
def list_quote_attachments(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    _ensure_quote(db, user.tenant_id, quote_id)
    rows = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.tenant_id == user.tenant_id)
        .filter(DocumentAttachment.quote_id == quote_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .order_by(DocumentAttachment.created_at.asc())
        .all()
    )
    return rows


@router.post("/api/quotes/{quote_id}/attachments", response_model=DocumentAttachmentOut)
async def upload_quote_attachment(
    quote_id: str,
    file: UploadFile = File(...),
    label: str | None = Form(None),
    public_visible: bool = Form(False),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_user),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = _ensure_quote(db, user.tenant_id, quote_id)
    _ensure_quote_attachments_mutable(quote)
    tenant = db.get(Tenant, user.tenant_id)
    limits = resolve_limits_for_tenant(tenant)

    raw, size = await _read_upload_with_limit(file, limits.max_file_bytes)

    unknown_purchase_sizes = get_purchase_attachment_unknown_size_count(db, user.tenant_id)
    if unknown_purchase_sizes:
        raise HTTPException(
            409,
            detail={
                "code": "purchase_attachment_size_backfill_required",
                "message": "Stockage pièces jointes à recalculer avant nouvel upload.",
                "unknown_size_count": unknown_purchase_sizes,
            },
        )
    used = get_used_bytes(db, user.tenant_id)
    if limits.quota_bytes and (used + size) > limits.quota_bytes:
        raise HTTPException(
            400,
            detail={
                "code": "attachments_quota_exceeded",
                "message": "Quota pièces jointes dépassé. Supprimez des fichiers ou changez de plan.",
                "used_bytes": used,
                "quota_bytes": limits.quota_bytes,
            },
        )

    count = get_document_attachment_count(db, tenant_id=user.tenant_id, quote_id=quote_id)
    if limits.max_per_document and count >= limits.max_per_document:
        raise HTTPException(
            400,
            detail={
                "code": "attachments_doc_limit",
                "message": f"Limite atteinte: {limits.max_per_document} pièces jointes / devis.",
            },
        )

    detected = detect_content_type(raw, file.content_type)
    if not detected or detected not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            400,
            detail={
                "code": "attachments_invalid_type",
                "message": "Format non supporté. Autorisés: PDF, PNG, JPG, WEBP.",
            },
        )

    safe_name = sanitize_filename(file.filename)
    required_ext = ALLOWED_CONTENT_TYPES.get(detected)
    if required_ext and not safe_name.lower().endswith(required_ext):
        root_name, _ext = os.path.splitext(safe_name)
        safe_name = (root_name or "piece_jointe") + required_ext

    attachment_id = uuid.uuid4().hex
    storage_key = build_storage_key(
        tenant_id=user.tenant_id,
        parent_kind="quote",
        parent_id=quote_id,
        attachment_id=attachment_id,
        filename=safe_name,
    )

    try:
        put_object(storage_key, raw, content_type=detected)
    except Exception:
        raise HTTPException(500, "Stockage indisponible")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    att = DocumentAttachment(
        id=attachment_id,
        tenant_id=user.tenant_id,
        invoice_id=None,
        quote_id=quote_id,
        filename=safe_name,
        label=(label or "").strip() or None,
        content_type=detected,
        size_bytes=size,
        sha256=sha256_hex(raw),
        storage_key=storage_key,
        public_visible=bool(public_visible),
        created_at=now,
        created_by=user.id,
        updated_at=now,
        updated_by=user.id,
    )
    db.add(att)
    try:
        db.commit()
    except Exception:
        db.rollback()
        try:
            delete_object(storage_key)
        except Exception:
            pass
        raise
    db.refresh(att)
    return att


@router.patch("/api/quotes/{quote_id}/attachments/{attachment_id}", response_model=DocumentAttachmentOut)
def patch_quote_attachment(
    quote_id: str,
    attachment_id: str,
    body: DocumentAttachmentPatch,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_user),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = _ensure_quote(db, user.tenant_id, quote_id)
    _ensure_quote_attachments_mutable(quote)
    att = _load_attachment(db, tenant_id=user.tenant_id, attachment_id=attachment_id, quote_id=quote_id)
    updates = body.model_dump(exclude_unset=True)
    if "label" in updates:
        att.label = (updates.get("label") or "").strip() or None
    if "public_visible" in updates and updates.get("public_visible") is not None:
        att.public_visible = bool(updates.get("public_visible"))
    att.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    att.updated_by = user.id
    db.add(att)
    db.commit()
    db.refresh(att)
    return att


@router.delete("/api/quotes/{quote_id}/attachments/{attachment_id}")
def delete_quote_attachment(
    quote_id: str,
    attachment_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_user),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = _ensure_quote(db, user.tenant_id, quote_id)
    _ensure_quote_attachments_mutable(quote)
    att = _load_attachment(db, tenant_id=user.tenant_id, attachment_id=attachment_id, quote_id=quote_id)
    att.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    att.deleted_by = user.id
    db.add(att)
    db.commit()
    try:
        if att.storage_key:
            delete_object(att.storage_key)
    except Exception:
        pass
    return {"ok": True}


@router.get("/api/quotes/{quote_id}/attachments/{attachment_id}/file")
def get_quote_attachment_file(
    quote_id: str,
    attachment_id: str,
    request: Request,
    download: bool = False,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    _ensure_quote(db, user.tenant_id, quote_id)
    att = _load_attachment(db, tenant_id=user.tenant_id, attachment_id=attachment_id, quote_id=quote_id)
    return _stream_storage_key(
        storage_key=att.storage_key,
        request=request,
        content_type=att.content_type or "application/octet-stream",
        filename=att.filename,
        inline=not bool(download),
    )
