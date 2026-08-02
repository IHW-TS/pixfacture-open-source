from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_support
from ..models import Invoice, Tenant
from ..schemas import TenantSummary
from ..services.action_logs import safe_log_action
from ..services.support_health import build_tenant_health

router = APIRouter(prefix="/api/support", tags=["support"])


@router.get("/tenants", response_model=list[TenantSummary])
def list_tenants(
    request: Request,
    response: Response,
    limit: int = Query(100, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_support),
):
    total = int(db.query(func.count(Tenant.id)).scalar() or 0)
    tenants = (
        db.query(Tenant)
        .order_by(Tenant.created_at.desc(), Tenant.id.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    response.headers["X-Total-Count"] = str(total)
    links: list[str] = []
    if offset + limit < total:
        next_url = str(request.url.include_query_params(limit=limit, offset=offset + limit))
        links.append(f'<{next_url}>; rel="next"')
    if offset > 0:
        prev_offset = max(0, offset - limit)
        prev_url = str(request.url.include_query_params(limit=limit, offset=prev_offset))
        links.append(f'<{prev_url}>; rel="prev"')
    if links:
        response.headers["Link"] = ", ".join(links)
    safe_log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="support_list_tenants",
        object_type="support",
        object_id="tenants",
        metadata={"count": len(tenants), "total": total, "limit": limit, "offset": offset},
        commit=True,
    )
    # On calcule un compteur de factures par tenant pour la page courante uniquement.
    tenant_ids = [t.id for t in tenants if t.id]
    invoice_counts = {
        row[0]: row[1]
        for row in (
            db.query(Invoice.tenant_id, func.count(Invoice.id))
            .filter(Invoice.tenant_id.in_(tenant_ids))
            .group_by(Invoice.tenant_id)
        )
    } if tenant_ids else {}
    summaries: list[TenantSummary] = []
    for t in tenants:
        if not t.id or not t.name or not t.created_at:
            continue
        summaries.append(
            TenantSummary(
                id=t.id,
                name=t.name,
                plan=t.plan,
                subscription_status=t.subscription_status,
                trial_end=t.trial_end,
                created_at=t.created_at,
                invoice_count=invoice_counts.get(t.id, 0),
            )
        )
    return summaries


@router.get("/tenants/{tenant_id}/health")
def tenant_health(
    tenant_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_support),
):
    health = build_tenant_health(db, tenant_id)
    if not health.get("found"):
        return {"found": False, "status": "not_found"}
    safe_log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="support_tenant_health",
        object_type="tenant",
        object_id=tenant_id,
        metadata={"status": health.get("status")},
        commit=True,
    )
    return health
