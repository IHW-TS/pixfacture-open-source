from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass

from sqlalchemy import and_, exists, func
from sqlalchemy.orm import Session

from ..config import settings
from ..models import DocumentAttachment, InboundInvoice, InboundInvoiceAttachment, Invoice, InvoiceArtifact, Tenant


# NOTE:
# - Les pièces jointes sont stockées dans STORAGE_PROVIDER (local / S3 / MinIO)
# - Par défaut elles ne sont PAS visibles sur le portail public (public_visible=False)
# - Quotas par tenant (plan) + limites par fichier + par document


ALLOWED_CONTENT_TYPES: dict[str, str] = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


@dataclass(frozen=True)
class AttachmentsLimits:
    quota_bytes: int
    max_file_bytes: int
    max_per_document: int


def sanitize_filename(filename: str | None) -> str:
    raw = (filename or "").strip()
    # basename to avoid path traversal
    raw = os.path.basename(raw)
    raw = raw.replace("\\", "/")
    raw = raw.split("/")[-1]
    raw = raw.strip()
    if not raw:
        return "piece_jointe"
    # Replace unsafe chars
    safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", raw)
    safe = re.sub(r"\s+", " ", safe).strip().replace(" ", "_")
    if not safe:
        safe = "piece_jointe"
    # Limit length, keep extension
    if len(safe) > 120:
        root, ext = os.path.splitext(safe)
        root = root[: (120 - len(ext))]
        safe = root + ext
    return safe


def sha256_hex(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def detect_content_type(data: bytes, fallback: str | None = None) -> str | None:
    """Best-effort detection for PDF/images.

    We keep it simple (magic bytes) to avoid pulling heavy deps.
    """
    if not data:
        return None
    head = data[:16]

    # PDF
    if head.startswith(b"%PDF-"):
        return "application/pdf"

    # PNG
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"

    # JPEG
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"

    # WEBP (RIFF....WEBP)
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"

    return None


def build_storage_key(
    *,
    tenant_id: str,
    parent_kind: str,
    parent_id: str,
    attachment_id: str,
    filename: str,
) -> str:
    safe_parent = (parent_kind or "").strip().lower()
    if safe_parent not in {"invoice", "quote"}:
        safe_parent = "doc"
    safe_filename = sanitize_filename(filename)
    return f"attachments/{tenant_id}/{safe_parent}/{parent_id}/{attachment_id}/{safe_filename}"


def resolve_limits_for_tenant(tenant: Tenant | None) -> AttachmentsLimits:
    plan = (getattr(tenant, "plan", None) or "starter").strip().lower() or "starter"

    # Defaults (peuvent être surchargés via env)
    max_file_bytes = int(getattr(settings, "ATTACHMENTS_MAX_FILE_BYTES", 25 * 1024 * 1024) or 0)
    generic_max_mb = int(getattr(settings, "MAX_ATTACHMENT_SIZE_MB", 25) or 0)
    if generic_max_mb > 0:
        generic_max_bytes = generic_max_mb * 1024 * 1024
        max_file_bytes = min(max_file_bytes, generic_max_bytes) if max_file_bytes > 0 else generic_max_bytes
    max_per_doc = int(getattr(settings, "ATTACHMENTS_MAX_PER_DOCUMENT", 10) or 0)

    starter_mb = int(getattr(settings, "ATTACHMENTS_QUOTA_STARTER_MB", 200) or 0)
    pro_mb = int(getattr(settings, "ATTACHMENTS_QUOTA_PRO_MB", 200) or 0)
    ent_mb = int(getattr(settings, "ATTACHMENTS_QUOTA_ENTERPRISE_MB", 0) or 0)

    if plan in {"enterprise", "scale"}:
        quota_bytes = ent_mb * 1024 * 1024
    elif plan in {"pro"}:
        quota_bytes = pro_mb * 1024 * 1024
    else:
        quota_bytes = starter_mb * 1024 * 1024

    return AttachmentsLimits(
        quota_bytes=max(quota_bytes, 0),
        max_file_bytes=max(max_file_bytes, 0),
        max_per_document=max(max_per_doc, 0),
    )


def get_used_bytes(db: Session, tenant_id: str) -> int:
    breakdown = get_usage_breakdown(db, tenant_id)
    return int(breakdown["total_bytes"])


def get_usage_breakdown(db: Session, tenant_id: str) -> dict[str, int]:
    if not tenant_id:
        return {
            "document_attachments_bytes": 0,
            "purchase_attachments_bytes": 0,
            "invoice_artifacts_bytes": 0,
            "legacy_invoice_artifacts_bytes": 0,
            "total_bytes": 0,
        }
    document_total = (
        db.query(func.coalesce(func.sum(DocumentAttachment.size_bytes), 0))
        .filter(DocumentAttachment.tenant_id == tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .scalar()
    )
    purchase_total = (
        db.query(func.coalesce(func.sum(InboundInvoiceAttachment.size_bytes), 0))
        .join(InboundInvoice, InboundInvoice.id == InboundInvoiceAttachment.inbound_invoice_id)
        .filter(InboundInvoice.tenant_id == tenant_id)
        .scalar()
    )
    artifact_total = (
        db.query(func.coalesce(func.sum(InvoiceArtifact.size_bytes), 0))
        .filter(InvoiceArtifact.tenant_id == tenant_id)
        .scalar()
    )
    pdf_artifact_exists = exists().where(
        and_(
            InvoiceArtifact.invoice_id == Invoice.id,
            InvoiceArtifact.tenant_id == tenant_id,
            InvoiceArtifact.kind == "PDF",
        )
    )
    cii_artifact_exists = exists().where(
        and_(
            InvoiceArtifact.invoice_id == Invoice.id,
            InvoiceArtifact.tenant_id == tenant_id,
            InvoiceArtifact.kind == "CII",
        )
    )
    facturx_artifact_exists = exists().where(
        and_(
            InvoiceArtifact.invoice_id == Invoice.id,
            InvoiceArtifact.tenant_id == tenant_id,
            InvoiceArtifact.kind == "FACTURX",
        )
    )
    legacy_pdf_total = (
        db.query(func.coalesce(func.sum(Invoice.pdf_size), 0))
        .filter(Invoice.tenant_id == tenant_id)
        .filter(~pdf_artifact_exists)
        .scalar()
    )
    legacy_xml_total = (
        db.query(func.coalesce(func.sum(Invoice.xml_size), 0))
        .filter(Invoice.tenant_id == tenant_id)
        .filter(~cii_artifact_exists)
        .scalar()
    )
    legacy_facturx_total = (
        db.query(func.coalesce(func.sum(Invoice.facturx_size), 0))
        .filter(Invoice.tenant_id == tenant_id)
        .filter(~facturx_artifact_exists)
        .scalar()
    )
    try:
        legacy_total = int(legacy_pdf_total or 0) + int(legacy_xml_total or 0) + int(legacy_facturx_total or 0)
        breakdown = {
            "document_attachments_bytes": int(document_total or 0),
            "purchase_attachments_bytes": int(purchase_total or 0),
            "invoice_artifacts_bytes": int(artifact_total or 0),
            "legacy_invoice_artifacts_bytes": legacy_total,
        }
        breakdown["total_bytes"] = sum(breakdown.values())
        return breakdown
    except Exception:
        return {
            "document_attachments_bytes": 0,
            "purchase_attachments_bytes": 0,
            "invoice_artifacts_bytes": 0,
            "legacy_invoice_artifacts_bytes": 0,
            "total_bytes": 0,
        }


def get_purchase_attachment_unknown_size_count(db: Session, tenant_id: str) -> int:
    if not tenant_id:
        return 0
    count = (
        db.query(func.count(InboundInvoiceAttachment.id))
        .join(InboundInvoice, InboundInvoice.id == InboundInvoiceAttachment.inbound_invoice_id)
        .filter(InboundInvoice.tenant_id == tenant_id)
        .filter(func.coalesce(InboundInvoiceAttachment.size_bytes, 0) <= 0)
        .scalar()
    )
    try:
        return int(count or 0)
    except Exception:
        return 0


def get_document_attachment_count(
    db: Session,
    *,
    tenant_id: str,
    invoice_id: str | None = None,
    quote_id: str | None = None,
) -> int:
    q = db.query(func.count(DocumentAttachment.id)).filter(DocumentAttachment.tenant_id == tenant_id)
    q = q.filter(DocumentAttachment.deleted_at.is_(None))
    if invoice_id:
        q = q.filter(DocumentAttachment.invoice_id == invoice_id)
    if quote_id:
        q = q.filter(DocumentAttachment.quote_id == quote_id)
    try:
        return int(q.scalar() or 0)
    except Exception:
        return 0


def is_allowed_content_type(content_type: str | None) -> bool:
    ct = (content_type or "").strip().lower()
    return ct in ALLOWED_CONTENT_TYPES


def allowed_extensions() -> list[str]:
    return sorted(set(ALLOWED_CONTENT_TYPES.values()))
