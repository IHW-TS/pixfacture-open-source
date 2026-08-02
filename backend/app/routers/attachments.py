from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_tenant_admin
from ..models import DocumentAttachment, Tenant
from ..schemas import AttachmentsUsageOut
from ..services.document_attachments import ALLOWED_CONTENT_TYPES, get_usage_breakdown, resolve_limits_for_tenant
from ..services.storage import delete_object

router = APIRouter(prefix="/api/attachments", tags=["attachments"])


@router.get("/usage", response_model=AttachmentsUsageOut)
def get_usage(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    limits = resolve_limits_for_tenant(tenant)
    usage = get_usage_breakdown(db, user.tenant_id)
    used = int(usage["total_bytes"])
    plan = (getattr(tenant, "plan", None) or "starter").strip().lower() if tenant else "starter"
    remaining = max(int(limits.quota_bytes or 0) - used, 0) if limits.quota_bytes else 0
    return {
        "used_bytes": used,
        "quota_bytes": limits.quota_bytes,
        "remaining_bytes": remaining,
        "document_attachments_bytes": usage["document_attachments_bytes"],
        "purchase_attachments_bytes": usage["purchase_attachments_bytes"],
        "invoice_artifacts_bytes": usage["invoice_artifacts_bytes"],
        "legacy_invoice_artifacts_bytes": usage["legacy_invoice_artifacts_bytes"],
        "plan": plan,
        "max_file_bytes": limits.max_file_bytes,
        "max_per_document": limits.max_per_document,
        "allowed_content_types": sorted(list(ALLOWED_CONTENT_TYPES.keys())),
    }


@router.get("/recent")
def list_recent(
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    rows = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.tenant_id == user.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .order_by(DocumentAttachment.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "invoice_id": r.invoice_id,
            "quote_id": r.quote_id,
            "filename": r.filename,
            "label": r.label,
            "content_type": r.content_type,
            "size_bytes": int(r.size_bytes or 0),
            "public_visible": bool(r.public_visible),
            "created_at": r.created_at,
        }
        for r in rows
    ]


@router.delete("/{attachment_id}")
def delete_attachment(
    attachment_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    att = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.id == attachment_id)
        .filter(DocumentAttachment.tenant_id == user.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .first()
    )
    if not att:
        raise HTTPException(404, "Pièce jointe introuvable")
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
