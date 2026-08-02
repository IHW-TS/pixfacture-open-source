from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..services.compliance_status import build_compliance_status
from ..services.compliance_claims import build_compliance_claims

router = APIRouter(prefix="/api/compliance", tags=["compliance"])


@router.get("/status")
def compliance_status():
    return build_compliance_status()


@router.get("/claims")
def compliance_claims():
    payload = build_compliance_claims()
    headers = {"Cache-Control": "public, max-age=60"}
    return JSONResponse(content=payload, headers=headers)
