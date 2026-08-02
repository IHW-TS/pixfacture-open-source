from fastapi import APIRouter

from ..config import settings

router = APIRouter(tags=["features"])


@router.get("/api/features")
def get_features():
    return {
        "enable_pdp_integration": bool(settings.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION),
        "enable_ppf_directory": bool(settings.NEXT_PUBLIC_ENABLE_PPF_DIRECTORY),
        "enable_einvoicing_pages": bool(settings.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES),
    }
