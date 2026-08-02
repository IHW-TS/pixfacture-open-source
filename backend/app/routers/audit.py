import math

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_tenant_admin, AuthUser
from ..models import ActionLog, User
from ..schemas import AuditLogResponse
from ..utils.audit import redact_audit_payload
from ..utils.pii import mask_email

router = APIRouter(prefix="/api/audit", tags=["audit"])


@router.get("/logs", response_model=AuditLogResponse)
def list_audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    action: str | None = None,
    entity_type: str | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    q = (
        db.query(ActionLog, User.email)
        .outerjoin(User, ActionLog.user_id == User.id)
        .filter(ActionLog.tenant_id == user.tenant_id)
    )
    if action:
        q = q.filter(ActionLog.action == action)
    if entity_type:
        q = q.filter(ActionLog.entity == entity_type)
    total = q.count()
    rows = (
        q.order_by(ActionLog.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = []
    for log, email in rows:
        raw_payload = log.metadata_json if getattr(log, "metadata_json", None) is not None else log.payload
        items.append(
            {
                "id": log.id,
                "created_at": log.created_at,
                "action": log.action,
                "entity_type": log.entity,
                "entity_id": log.entity_id,
                "actor_email": mask_email(email) if email else None,
                "payload": redact_audit_payload(raw_payload),
            }
        )
    pages = math.ceil(total / page_size) if page_size else 1
    return {"items": items, "page": page, "page_size": page_size, "total": total, "pages": pages}
