from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_platform_admin, require_product_feature, require_viewer_or_admin, AuthUser
from ..services.usage import get_monthly_usage, get_usage_summary, invalidate_usage_cache


router = APIRouter(prefix="/api/usage", tags=["usage"])


def _month_start(value: date) -> date:
    return date(value.year, value.month, 1)


@router.get("/monthly")
async def monthly_usage(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    try:
        return await get_monthly_usage(db, tenant_id=user.tenant_id)
    except ValueError as exc:
        raise HTTPException(404, "Profil d’entreprise introuvable.") from exc


@router.get("/summary")
async def usage_summary(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    try:
        return await get_usage_summary(db, tenant_id=user.tenant_id)
    except ValueError as exc:
        raise HTTPException(404, "Profil d’entreprise introuvable.") from exc


@router.post("/topups")
def create_flow_topup(
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_platform_admin),
):
    if not admin.is_admin:
        raise HTTPException(403, "Accès réservé à l'administrateur de la plateforme.")
    invalidate_usage_cache(admin.tenant_id, _month_start(date.today()).strftime("%Y-%m"))
    raise HTTPException(
        status_code=410,
        detail={
            "code": "flow_topups_retired",
            "message": "Les anciennes recharges mensuelles ne sont plus disponibles. Utilisez les packs de jetons.",
            "remediation_url": "/app/billing",
        },
    )
