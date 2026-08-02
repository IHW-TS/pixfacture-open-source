import copy
from importlib.metadata import PackageNotFoundError, version

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..config import settings as app_settings
from ..validators.invoice_sanity_checks import get_invoice_sanity_checks_version
from ..en16931.ubl_validator import get_ubl_validator_version, is_ubl_validator_available
from ..services.cii import normalize_facturx_profile
from ..models import Tenant, TenantSettings
from ..schemas import TENANT_FEATURE_KEYS, TenantSettingsOut, TenantSettingsPatch
from ..deps import require_tenant_admin, require_viewer_or_admin, AuthUser
from ..services.product_capabilities import ensure_product_feature, is_product_feature_enabled

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _deep_merge_dict(current: dict | None, updates: dict | None) -> dict:
    base = dict(current or {})
    for key, value in (updates or {}).items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = _deep_merge_dict(base.get(key), value)
        else:
            base[key] = value
    return base


def _sanitize_portal_feature_update(current_features: dict | None, update: dict | None) -> dict | None:
    if not isinstance(update, dict) or "portal" not in update:
        return update
    portal_update = update.get("portal")
    if not isinstance(portal_update, dict):
        return update
    if "card_payments" in portal_update:
        portal_update["card_payments"] = False

    current_portal = {}
    if isinstance(current_features, dict) and isinstance(current_features.get("portal"), dict):
        current_portal = current_features.get("portal") or {}

    confirm_show_all = bool(portal_update.pop("confirm_show_all_documents", False))
    wants_show_all = portal_update.get("show_all_documents") is True
    already_showing_all = bool(current_portal.get("show_all_documents", False))
    if wants_show_all and not already_showing_all and not confirm_show_all:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "portal_show_all_requires_confirmation",
                "message": (
                    "Confirmez explicitement l'exposition de tous les documents client "
                    "avant d'activer cette option."
                ),
            },
        )
    return update


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def build_public_settings_payload() -> dict[str, object]:
    return {
        "facturx_spec_version": app_settings.FACTURX_SPEC_VERSION,
        "facturx_lib_version": _package_version("factur-x"),
        "saxonche_version": _package_version("saxonche"),
        "pdfa_convert_enabled": bool(app_settings.FACTURX_PDFA_CONVERT),
        "facturx_profile": normalize_facturx_profile(app_settings.FACTURX_PROFILE),
        "invoice_sanity_checks_version": get_invoice_sanity_checks_version(),
        "ubl_export_enabled": app_settings.UBL_EXPORT_ENABLED,
        "ubl_validator_available": is_ubl_validator_available(),
        "ubl_validator_version": get_ubl_validator_version(),
    }


@router.get("")
def get_public_settings():
    return build_public_settings_payload()


@router.get("/public")
def get_public_settings_alias():
    return build_public_settings_payload()


def _get_or_create_settings(db: Session, tenant_id: str) -> TenantSettings:
    settings = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if settings:
        return settings
    settings = TenantSettings(tenant_id=tenant_id)
    db.add(settings)
    db.commit()
    db.refresh(settings)
    return settings


def _tenant_settings_payload(settings_row: TenantSettings, tenant: Tenant) -> dict[str, object]:
    """Expose only customer-editable settings, never internal feature stores."""

    raw_features = settings_row.features if isinstance(settings_row.features, dict) else {}
    features = {
        key: copy.deepcopy(raw_features[key])
        for key in TENANT_FEATURE_KEYS
        if key in raw_features
    }
    portal = features.get("portal")
    if isinstance(portal, dict):
        portal["card_payments"] = False
    if not is_product_feature_enabled(tenant, "payments_enabled"):
        if "dunning" in features:
            features["dunning"] = {
                "enabled": False,
                "schedule_days": [],
                "min_interval_hours": 24,
                "attach_pdf": False,
                "steps": {},
            }

    return {
        "tenant_id": settings_row.tenant_id,
        "preset": settings_row.preset,
        "features": features,
        "onboarding_completed": settings_row.onboarding_completed,
        "created_at": settings_row.created_at,
        "updated_at": settings_row.updated_at,
    }


@router.get("/tenant", response_model=TenantSettingsOut)
def get_tenant_settings(db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = tenant.id
    if not tenant_id:
        raise HTTPException(500, "Entreprise invalide")
    settings_row = _get_or_create_settings(db, tenant_id)
    return _tenant_settings_payload(settings_row, tenant)


@router.patch("/tenant", response_model=TenantSettingsOut)
def patch_tenant_settings(
    body: TenantSettingsPatch,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = tenant.id
    if not tenant_id:
        raise HTTPException(500, "Entreprise invalide")
    settings = _get_or_create_settings(db, tenant_id)
    updates = body.model_dump(exclude_unset=True)

    features_update = updates.pop("features", None)
    if features_update:
        if "dunning" in features_update:
            ensure_product_feature(tenant, "payments_enabled")
        current = settings.features or {}
        features_update = _sanitize_portal_feature_update(current, features_update)
        settings.features = _deep_merge_dict(current, features_update)

    for key, value in updates.items():
        if value is None:
            continue
        setattr(settings, key, value)

    db.add(settings)
    db.commit()
    db.refresh(settings)
    return _tenant_settings_payload(settings, tenant)
