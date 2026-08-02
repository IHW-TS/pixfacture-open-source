from __future__ import annotations

import hashlib
import json
import logging
import os
import zipfile
from datetime import datetime, timezone
from tempfile import NamedTemporaryFile
from typing import Any, Iterable

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..models import DocumentAttachment
from ..services.document_attachments import sanitize_filename
from ..services.product_capabilities import is_product_feature_enabled
from ..services.storage import get_object_bytes, head_object


logger = logging.getLogger(__name__)


def _invoice_router():
    # Lazy import to avoid circular deps at import time.
    from app.routers import invoices as invoices_router

    return invoices_router


def _quotes_router():
    from app.routers import quotes as quotes_router

    return quotes_router


def _iter_file(path: str, chunk_size: int = 1024 * 1024) -> Iterable[bytes]:
    """Stream a file and delete it afterwards."""
    try:
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(chunk_size)
                if not chunk:
                    break
                yield chunk
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


def _sha256_bytes(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def _reraise_artifact_integrity_error(exc: Exception) -> None:
    if not isinstance(exc, HTTPException):
        return
    detail = exc.detail
    if isinstance(detail, dict) and detail.get("code") == "artifact_integrity_error":
        raise exc


def _invoice_status_for_bundle(inv: Any, *, payment_tracking_enabled: bool) -> str:
    status = str(getattr(inv, "status", None) or "issued").strip().lower() or "issued"
    if payment_tracking_enabled:
        return status
    if status in {"paid", "partial", "overdue", "pending", "refunded", "partially_refunded"}:
        return "sent" if getattr(inv, "sent_at", None) else "issued"
    return status


def _invoice_context_for_bundle(inv_router: Any, db: Session, inv: Any, *, payment_tracking_enabled: bool) -> dict:
    ctx = inv_router._ctx(db, inv)
    if payment_tracking_enabled:
        return ctx
    invoice_ctx = ctx.get("invoice") if isinstance(ctx, dict) else None
    if isinstance(invoice_ctx, dict):
        ctx["invoice"] = {
            **invoice_ctx,
            "status": _invoice_status_for_bundle(inv, payment_tracking_enabled=False),
            "balance_due": None,
        }
    totals_ctx = ctx.get("totals") if isinstance(ctx, dict) else None
    if isinstance(totals_ctx, dict):
        ctx["totals"] = {**totals_ctx, "prepaid": 0}
    return ctx


def stream_zip_file(path: str, filename: str) -> StreamingResponse:
    headers = {
        "Content-Disposition": f'attachment; filename="{sanitize_filename(filename)}"',
        "Cache-Control": "private, max-age=0, no-store",
        "X-Content-Type-Options": "nosniff",
    }
    return StreamingResponse(_iter_file(path), media_type="application/zip", headers=headers)


def _attachment_zip_name(att: DocumentAttachment, seen: set[str]) -> str:
    """Avoid collisions inside the zip."""
    base = sanitize_filename(att.filename)
    prefix = (att.id or "")[:6] or "att"
    name = f"{prefix}_{base}"
    if name not in seen:
        seen.add(name)
        return name
    root, ext = os.path.splitext(name)
    i = 2
    while True:
        candidate = f"{root}_{i}{ext}"
        if candidate not in seen:
            seen.add(candidate)
            return candidate
        i += 1


def build_invoice_bundle_zip(
    db: Session,
    *,
    invoice_id: str,
    tenant_id: str,
    include_private_attachments: bool,
) -> tuple[str, str]:
    """Build a ZIP bundle for an invoice.

    Contents:
    - facture.pdf
    - facturx.pdf / facturx.xml (best-effort)
    - pieces_jointes/*
    - meta.json (inventory + warnings)
    """
    inv_router = _invoice_router()
    inv = db.get(inv_router.Invoice, invoice_id)
    if not inv or inv.tenant_id != tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(inv_router.Tenant, inv.tenant_id)
    customer = db.get(inv_router.Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")

    warnings: list[dict[str, Any]] = []
    payment_tracking_enabled = is_product_feature_enabled(tenant, "payments_enabled")

    # PDF (always)
    pdf_bytes: bytes | None = None
    try:
        if payment_tracking_enabled and inv_router._is_invoice_immutable(inv):
            artifact = inv_router.ensure_invoice_artifact(db, inv, "pdf")
            inv_router._ensure_invoice_artifact_integrity(db, inv, artifact, "pdf")
            pdf_bytes = inv_router._load_invoice_artifact(inv, "pdf")
        if pdf_bytes is None:
            pdf_bytes = inv_router.invoice_pdf(
                _invoice_context_for_bundle(
                    inv_router,
                    db,
                    inv,
                    payment_tracking_enabled=payment_tracking_enabled,
                )
            )
        if not pdf_bytes:
            raise RuntimeError("pdf_empty")
    except Exception as exc:
        _reraise_artifact_integrity_error(exc)
        logger.warning(
            "invoice_bundle_pdf_failed",
            extra={"invoice_id": str(inv.id), "error_type": exc.__class__.__name__},
        )
        warnings.append({"code": "pdf_failed", "message": "Impossible de générer le PDF."})
        pdf_bytes = None

    # Factur-X (best-effort)
    facturx_pdf: bytes | None = None
    facturx_xml: bytes | None = None
    missing_fields: list[str] | None = None
    structured_artifacts_enabled = is_product_feature_enabled(tenant, "einvoicing_enabled")
    if structured_artifacts_enabled:
        try:
            missing_fields = inv_router.validate_fr_b2b_invoice_ready(inv, customer, tenant)
        except Exception:
            missing_fields = None
    can_facturx = structured_artifacts_enabled and not (missing_fields or [])

    if can_facturx:
        try:
            if inv_router._is_invoice_immutable(inv):
                artifact = inv_router.ensure_invoice_artifact(db, inv, "facturx")
                inv_router._ensure_invoice_artifact_integrity(db, inv, artifact, "facturx")
                facturx_pdf = inv_router._load_invoice_artifact(inv, "facturx")
                artifact = inv_router.ensure_invoice_artifact(db, inv, "cii")
                inv_router._ensure_invoice_artifact_integrity(db, inv, artifact, "cii")
                facturx_xml = inv_router._load_invoice_artifact(inv, "cii")
            if facturx_pdf is None:
                ctx = inv_router._ctx(db, inv)
                fx_pdf, _status, _report = inv_router.facturx_pdf_with_meta(ctx)
                facturx_pdf = fx_pdf
                try:
                    facturx_xml = inv_router.cii_invoice_xml(ctx)
                except Exception:
                    facturx_xml = None
        except Exception as exc:
            _reraise_artifact_integrity_error(exc)
            logger.warning(
                "invoice_bundle_facturx_failed",
                extra={"invoice_id": str(inv.id), "error_type": exc.__class__.__name__},
            )
            warnings.append(
                {
                    "code": "facturx_failed",
                    "message": "Factur-X non disponible pour cette facture (champs manquants ou validation échouée).",
                }
            )
            facturx_pdf = None
            facturx_xml = None
    else:
        if structured_artifacts_enabled and missing_fields:
            warnings.append(
                {
                    "code": "facturx_missing_fields",
                    "message": "Factur-X non généré : champs FR B2B manquants.",
                    "fields": missing_fields,
                }
            )

    q = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.tenant_id == tenant_id)
        .filter(DocumentAttachment.invoice_id == inv.id)
        .filter(DocumentAttachment.deleted_at.is_(None))
    )
    if not include_private_attachments:
        q = q.filter(DocumentAttachment.public_visible.is_(True))
    attachments = q.order_by(DocumentAttachment.created_at.asc()).all()

    tmp = NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()

    seen_names: set[str] = set()
    included: list[dict[str, Any]] = []

    with zipfile.ZipFile(tmp_path, mode="w", compression=zipfile.ZIP_DEFLATED) as z:
        if pdf_bytes:
            z.writestr("facture.pdf", pdf_bytes)
            included.append(
                {
                    "path": "facture.pdf",
                    "kind": "pdf",
                    "size_bytes": len(pdf_bytes),
                    "sha256": _sha256_bytes(pdf_bytes),
                }
            )
        if facturx_pdf:
            z.writestr("facturx.pdf", facturx_pdf)
            included.append(
                {
                    "path": "facturx.pdf",
                    "kind": "facturx_pdf",
                    "size_bytes": len(facturx_pdf),
                    "sha256": _sha256_bytes(facturx_pdf),
                }
            )
        if facturx_xml:
            z.writestr("facturx.xml", facturx_xml)
            included.append(
                {
                    "path": "facturx.xml",
                    "kind": "facturx_xml",
                    "size_bytes": len(facturx_xml),
                    "sha256": _sha256_bytes(facturx_xml),
                }
            )

        att_entries: list[dict[str, Any]] = []
        for att in attachments:
            if not att.storage_key:
                continue
            if not head_object(att.storage_key):
                warnings.append(
                    {"code": "attachment_missing_blob", "message": "Blob manquant pour une pièce jointe.", "attachment_id": att.id}
                )
                continue
            payload = get_object_bytes(att.storage_key)
            if payload is None:
                warnings.append({"code": "attachment_read_failed", "message": "Lecture stockage impossible.", "attachment_id": att.id})
                continue
            name = _attachment_zip_name(att, seen_names)
            zip_path = f"pieces_jointes/{name}"
            z.writestr(zip_path, payload)
            entry = {
                "id": att.id,
                "path": zip_path,
                "filename": att.filename,
                "label": att.label,
                "content_type": att.content_type,
                "size_bytes": int(att.size_bytes or len(payload) or 0),
                "sha256": att.sha256,
                "public_visible": bool(att.public_visible),
                "created_at": att.created_at.isoformat() if getattr(att, "created_at", None) else None,
            }
            att_entries.append(entry)
            included.append({"path": zip_path, "kind": "attachment", "size_bytes": len(payload), "sha256": att.sha256})

        meta: dict[str, Any] = {
            "exported_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
            "kind": "invoice_bundle",
            "tenant_id": tenant_id,
            "payment_tracking_included": payment_tracking_enabled,
            "invoice": {
                "id": inv.id,
                "number": inv.number,
                "status": _invoice_status_for_bundle(
                    inv,
                    payment_tracking_enabled=payment_tracking_enabled,
                ),
                "issue_date": inv.issue_date.isoformat() if getattr(inv, "issue_date", None) else None,
                "currency": inv.currency,
                "total_inc_vat": str(getattr(inv, "total_inc_vat", "")),
            },
            "customer": {
                "id": customer.id,
                "name": customer.name,
                "siret": getattr(customer, "siret", None) or getattr(customer, "siren", None),
            },
            "attachments": att_entries,
            "included": included,
            "warnings": warnings,
        }
        z.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=2))

    filename = f"dossier-facture-{(inv.number or inv.id)[:32]}.zip"
    return tmp_path, filename


def build_quote_bundle_zip(
    db: Session,
    *,
    quote_id: str,
    tenant_id: str,
    include_private_attachments: bool,
    include_proof: bool = True,
) -> tuple[str, str]:
    """Build a ZIP bundle for a quote (devis)."""
    q_router = _quotes_router()
    quote = db.get(q_router.Quote, quote_id)
    if not quote or quote.tenant_id != tenant_id:
        raise HTTPException(404, "Not found")

    tenant = db.get(q_router.Tenant, quote.tenant_id)
    customer = db.get(q_router.Customer, quote.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")

    warnings: list[dict[str, Any]] = []

    pdf_bytes: bytes | None = None
    try:
        ctx = q_router._quote_ctx(db, quote)
        if not include_proof:
            ctx["proof"] = None
        pdf_bytes = q_router.invoice_pdf(ctx)
        if not pdf_bytes:
            raise RuntimeError("pdf_empty")
    except Exception as exc:
        logger.warning(
            "quote_bundle_pdf_failed",
            extra={"quote_id": str(quote.id), "error_type": exc.__class__.__name__},
        )
        warnings.append({"code": "pdf_failed", "message": "Impossible de générer le PDF."})
        pdf_bytes = None

    q = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.tenant_id == tenant_id)
        .filter(DocumentAttachment.quote_id == quote.id)
        .filter(DocumentAttachment.deleted_at.is_(None))
    )
    if not include_private_attachments:
        q = q.filter(DocumentAttachment.public_visible.is_(True))
    attachments = q.order_by(DocumentAttachment.created_at.asc()).all()

    tmp = NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()

    seen_names: set[str] = set()
    included: list[dict[str, Any]] = []

    with zipfile.ZipFile(tmp_path, mode="w", compression=zipfile.ZIP_DEFLATED) as z:
        if pdf_bytes:
            z.writestr("devis.pdf", pdf_bytes)
            included.append({"path": "devis.pdf", "kind": "pdf", "size_bytes": len(pdf_bytes), "sha256": _sha256_bytes(pdf_bytes)})

        att_entries: list[dict[str, Any]] = []
        for att in attachments:
            if not att.storage_key:
                continue
            if not head_object(att.storage_key):
                warnings.append(
                    {"code": "attachment_missing_blob", "message": "Blob manquant pour une pièce jointe.", "attachment_id": att.id}
                )
                continue
            payload = get_object_bytes(att.storage_key)
            if payload is None:
                warnings.append({"code": "attachment_read_failed", "message": "Lecture stockage impossible.", "attachment_id": att.id})
                continue
            name = _attachment_zip_name(att, seen_names)
            zip_path = f"pieces_jointes/{name}"
            z.writestr(zip_path, payload)
            entry = {
                "id": att.id,
                "path": zip_path,
                "filename": att.filename,
                "label": att.label,
                "content_type": att.content_type,
                "size_bytes": int(att.size_bytes or len(payload) or 0),
                "sha256": att.sha256,
                "public_visible": bool(att.public_visible),
                "created_at": att.created_at.isoformat() if getattr(att, "created_at", None) else None,
            }
            att_entries.append(entry)
            included.append({"path": zip_path, "kind": "attachment", "size_bytes": len(payload), "sha256": att.sha256})

        meta: dict[str, Any] = {
            "exported_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
            "kind": "quote_bundle",
            "tenant_id": tenant_id,
            "quote": {
                "id": quote.id,
                "number": quote.number,
                "status": quote.status,
                "issue_date": quote.issue_date.isoformat() if getattr(quote, "issue_date", None) else None,
                "valid_until": quote.valid_until.isoformat() if getattr(quote, "valid_until", None) else None,
                "currency": quote.currency,
                "total_inc_vat": str(getattr(quote, "total_inc_vat", "")),
            },
            "customer": {
                "id": customer.id,
                "name": customer.name,
                "siret": getattr(customer, "siret", None) or getattr(customer, "siren", None),
            },
            "attachments": att_entries,
            "included": included,
            "warnings": warnings,
        }
        z.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=2))

    filename = f"dossier-devis-{(quote.number or quote.id)[:32]}.zip"
    return tmp_path, filename
