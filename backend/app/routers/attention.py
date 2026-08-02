from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import API_SCOPE_READ_INVOICES, AuthUser, require_viewer_or_admin_or_api_key
from ..models import Tenant
from ..services.attention.next_actions import action_counts, today_actions
from ..services.product_capabilities import is_product_feature_enabled


router = APIRouter(prefix="/api/attention", tags=["attention"])


@router.get("/today")
def get_today_attention(
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    tenant = db.get(Tenant, user.tenant_id)
    return {
        "items": today_actions(
            db,
            user.tenant_id,
            limit=limit,
            include_payments=is_product_feature_enabled(tenant, "payments_enabled"),
            include_purchases=is_product_feature_enabled(tenant, "purchases_enabled"),
        )
    }


@router.get("/counts")
def get_attention_counts(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    tenant = db.get(Tenant, user.tenant_id)
    return action_counts(
        db,
        user.tenant_id,
        include_payments=is_product_feature_enabled(tenant, "payments_enabled"),
        include_purchases=is_product_feature_enabled(tenant, "purchases_enabled"),
    )
