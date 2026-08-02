from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin
from ..models import Tenant, User
from ..services.demo_seed import list_demo_presets, seed_tenant_demo_data


router = APIRouter(prefix="/api/sandbox", tags=["sandbox"])


def _ensure_sandbox_enabled() -> None:
    # Hidden-by-default: if the env var isn't on, pretend it doesn't exist.
    if not getattr(settings, "DEMO_MODE_ENABLED", False):
        raise HTTPException(status_code=404, detail="Not found")
    # Hard safety: never allow in *prod* (but staging is ok for demos).
    env = (getattr(settings, "APP_ENV", "") or "").strip().lower()
    if env in ("prod", "production"):
        raise HTTPException(status_code=403, detail="Sandbox désactivé en production.")


@router.post("/seed")
def seed_demo_data(
    force: bool = Query(False, description="Force purge+seed si déjà présent (nécessite DEMO_MODE_ALLOW_RESET)."),
    generate_artifacts: bool = Query(True, description="Tente de générer PDF/Factur-X (best-effort)."),
    preset: str | None = Query(default=None, description="Scenario démo sectoriel (services, retail, construction, public_sector, health)."),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    """Seed demo data inside the current tenant (staging/sandbox only)."""
    _ensure_sandbox_enabled()

    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Tenant introuvable")

    actor = db.get(User, user.id)
    if not actor:
        raise HTTPException(404, "User introuvable")

    if force and not getattr(settings, "DEMO_MODE_ALLOW_RESET", False):
        raise HTTPException(403, "Reset interdit. Activez DEMO_MODE_ALLOW_RESET=true")

    result = seed_tenant_demo_data(
        db,
        tenant=tenant,
        user=actor,
        force=bool(force),
        generate_artifacts=bool(generate_artifacts),
        preset=preset,
    )

    return {
        "ok": result.ok,
        "seeded": result.seeded,
        "message": result.message,
        "preset": preset or "services",
        "counts": result.counts.__dict__,
        "warnings": result.warnings,
        "created_ids": result.created_ids,
        "issued_invoice_ids": result.issued_invoice_ids,
    }


@router.get("/presets")
def sandbox_presets(_user: AuthUser = Depends(require_accountant_or_admin)):
    _ensure_sandbox_enabled()
    return {"items": list_demo_presets()}
