from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..deps import require_viewer_or_admin, AuthUser
from ..services import rate_limit
from ..services.sirene import lookup_company, SireneLookupError, SireneNotConfigured, SireneNotFound


router = APIRouter(prefix="/api/lookup", tags=["lookup"])

SIRENE_RATE_LIMIT = 30
SIRENE_WINDOW_SECONDS = 60


def _sirene_rate_limit_key(user: AuthUser, request: Request) -> str:
    ip = request.client.host if request.client else "unknown"
    return f"sirene_lookup:{user.tenant_id}:{user.id}:{ip}"


@router.get("/sirene")
def sirene_lookup(
    request: Request,
    siren: str | None = Query(default=None),
    siret: str | None = Query(default=None),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    if rate_limit.hit(_sirene_rate_limit_key(user, request), SIRENE_RATE_LIMIT, SIRENE_WINDOW_SECONDS):
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "Trop de demandes, réessayez plus tard."},
        )
    if not siren and not siret:
        raise HTTPException(
            status_code=400,
            detail={"code": "sirene_missing", "message": "SIREN ou SIRET requis pour la recherche."},
        )
    try:
        payload = lookup_company(siren, siret)
    except SireneNotConfigured:
        raise HTTPException(
            status_code=503,
            detail={"code": "sirene_not_configured", "message": "Lookup SIRENE non configure."},
        )
    except SireneNotFound:
        raise HTTPException(
            status_code=404,
            detail={"code": "sirene_not_found", "message": "Aucune entreprise trouvee."},
        )
    except ValueError as exc:
        code = str(exc) or "sirene_invalid"
        message = "Identifiant SIRENE invalide."
        if code == "siren_invalid":
            message = "SIREN invalide (9 chiffres)."
        elif code == "siret_invalid":
            message = "SIRET invalide (14 chiffres)."
        elif code == "siren_missing":
            message = "SIREN requis pour la recherche."
        raise HTTPException(status_code=400, detail={"code": code, "message": message})
    except SireneLookupError:
        raise HTTPException(
            status_code=502,
            detail={"code": "sirene_lookup_failed", "message": "Recherche SIRENE en erreur."},
        )
    return payload
