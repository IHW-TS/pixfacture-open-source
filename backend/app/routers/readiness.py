from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_product_feature, require_viewer_or_admin
from ..routers.settings import build_public_settings_payload
from ..services.bundles import stream_zip_file
from ..services.compliance_report import (
    build_readiness_checklist,
    build_readiness_proof_bundle_zip,
    build_readiness_proof_export,
)

router = APIRouter(
    prefix="/api/readiness",
    tags=["readiness"],
    dependencies=[Depends(require_product_feature("einvoicing_enabled"))],
)


@router.get("")
def get_readiness(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    try:
        return build_readiness_checklist(db, user.tenant_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Profil d’entreprise introuvable.") from exc


@router.get("/export.json")
def export_readiness(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    try:
        payload = build_readiness_proof_export(
            db,
            user.tenant_id,
            public_settings=build_public_settings_payload(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Profil d’entreprise introuvable.") from exc
    return JSONResponse(
        payload,
        headers={"Content-Disposition": 'attachment; filename="readiness-proof.json"'},
    )


@router.get("/export.zip")
def export_readiness_bundle(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    try:
        path, filename = build_readiness_proof_bundle_zip(
            db,
            user.tenant_id,
            public_settings=build_public_settings_payload(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Profil d’entreprise introuvable.") from exc
    return stream_zip_file(path, filename)
