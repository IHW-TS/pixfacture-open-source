import logging
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import (
    require_tenant_admin,
    AuthUser,
    API_KEY_ALLOWED_SCOPES,
    API_KEY_DEFAULT_SCOPES,
    API_KEY_LEGACY_SCOPES,
    API_SCOPE_READ_CUSTOMERS,
    API_SCOPE_READ_INVOICES,
    API_SCOPE_READ_JOBS,
    API_SCOPE_WRITE_CUSTOMERS,
    API_SCOPE_WRITE_INVOICES,
    resolve_api_key_scopes,
    validate_api_key_scopes,
)
from ..models import Tenant, ApiKey
from ..schemas import ApiKeyCreate
from ..core.plans import require_pro_or_enterprise
from ..services.product_capabilities import billing_enabled
from ..services.webhooks import DEFAULT_WEBHOOK_EVENTS
from ..config import settings
from .. import metrics

router = APIRouter(prefix="/api/api-access", tags=["api-access"])
logger = logging.getLogger(__name__)


_SCOPE_DESCRIPTIONS = {
    API_SCOPE_READ_INVOICES: "Lister, consulter et télécharger les factures et leurs artefacts.",
    API_SCOPE_WRITE_INVOICES: "Créer et mettre à jour les factures depuis un SI ou un ERP.",
    API_SCOPE_READ_CUSTOMERS: "Consulter les clients, leurs identifiants FR et leur synthèse.",
    API_SCOPE_WRITE_CUSTOMERS: "Créer et enrichir les clients côté référentiel tiers.",
    API_SCOPE_READ_JOBS: "Suivre les jobs asynchrones et leur statut d’exécution.",
}

_REFERENCE_ENDPOINTS = [
    {
        "method": "GET",
        "path": "/api/customers",
        "label": "Lister les clients",
        "required_scopes": [API_SCOPE_READ_CUSTOMERS],
    },
    {
        "method": "POST",
        "path": "/api/customers",
        "label": "Créer un client",
        "required_scopes": [API_SCOPE_WRITE_CUSTOMERS],
    },
    {
        "method": "GET",
        "path": "/api/invoices",
        "label": "Lister les factures",
        "required_scopes": [API_SCOPE_READ_INVOICES],
    },
    {
        "method": "POST",
        "path": "/api/invoices",
        "label": "Créer une facture",
        "required_scopes": [API_SCOPE_WRITE_INVOICES],
    },
    {
        "method": "GET",
        "path": "/api/jobs/{job_id}",
        "label": "Suivre un job",
        "required_scopes": [API_SCOPE_READ_JOBS],
    },
    {
        "method": "POST",
        "path": "/api/webhooks",
        "label": "Créer un endpoint webhook",
        "required_scopes": [],
    },
]


def _docs_enabled() -> bool:
    env = (getattr(settings, "APP_ENV", "") or "").strip().lower()
    return env not in {"prod", "production"}


def _base_url() -> str:
    return str(getattr(settings, "PUBLIC_BASE_URL", "") or "").rstrip("/")


def _require_active_api_access(tenant: Tenant) -> None:
    require_pro_or_enterprise(tenant)
    status = (tenant.subscription_status or "").strip().lower()
    if status == "trialing":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "subscription_active_required",
                "message": "Abonnement Pro actif requis pour utiliser les clés API.",
                "cta": "/app/billing",
            },
        )
    if not billing_enabled():
        return
    if status == "active":
        return
    raise HTTPException(
        status_code=403,
        detail={
            "code": "subscription_active_required",
            "message": "Abonnement Pro actif requis pour utiliser les clés API.",
            "cta": "/app/billing",
        },
    )


def _contract_response() -> dict:
    docs_enabled = _docs_enabled()
    base_url = _base_url()
    scope_items = [
        {
            "key": scope,
            "description": _SCOPE_DESCRIPTIONS.get(scope, scope),
            "default_enabled": scope in API_KEY_DEFAULT_SCOPES,
        }
        for scope in sorted(API_KEY_ALLOWED_SCOPES)
    ]
    webhook_headers = [
        {"name": "Content-Type", "value": "application/json"},
        {"name": "User-Agent", "value": "facturation-webhook/1.0"},
        {"name": "X-Webhook-Event", "value": "invoice.einvoicing.accepted"},
        {"name": "X-Webhook-Id", "value": "evt_demo_123"},
        {"name": "X-Webhook-Delivery", "value": "delivery_demo_123"},
        {"name": "X-Webhook-Timestamp", "value": "1712140800"},
        {"name": "X-Webhook-Signature", "value": "sha256=<hmac_hex>"},
    ]
    sample_payload = {
        "id": "evt_demo_123",
        "type": "invoice.einvoicing.accepted",
        "created_at": "2026-04-03T10:15:00Z",
        "data": {
            "invoice_id": "inv_demo_123",
            "invoice_number": "F-2026-0012",
            "transmission_id": "tx_demo_123",
            "channel": "pdp",
            "status": "accepted",
            "external_id": "seqino_123",
            "event": {
                "code": "accepted",
                "message": "Flux accepte par la plateforme.",
            },
        },
    }
    return {
        "version": "2026-04-contract",
        "base_url": base_url,
        "auth": {
            "api_key_header": "X-API-Key",
            "bearer_supported": bool(getattr(settings, "BEARER_MODE", False)),
            "openapi_url": f"{base_url}/api/openapi.json" if docs_enabled and base_url else ("/api/openapi.json" if docs_enabled else None),
            "docs_url": f"{base_url}/api/docs" if docs_enabled and base_url else ("/api/docs" if docs_enabled else None),
            "redoc_url": f"{base_url}/api/redoc" if docs_enabled and base_url else ("/api/redoc" if docs_enabled else None),
        },
        "scopes": scope_items,
        "reference_endpoints": _REFERENCE_ENDPOINTS,
        "webhooks": {
            "events": list(DEFAULT_WEBHOOK_EVENTS),
            "delivery_headers": webhook_headers,
            "signature_header": "X-Webhook-Signature",
            "signature_format": "sha256=<hmac_hex_du_corps_brut>",
            "sample_payload": sample_payload,
        },
    }


@router.get("/keys")
def list_keys(db: Session = Depends(get_db), user: AuthUser = Depends(require_tenant_admin)):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _require_active_api_access(tenant)
    keys = db.query(ApiKey).filter(ApiKey.tenant_id == tenant.id).order_by(ApiKey.created_at.desc()).all()
    return [
        {
            "id": k.id,
            "name": k.name,
            "created_at": k.created_at,
            "last_used_at": k.last_used_at,
            "scopes": resolve_api_key_scopes(k.scopes, API_KEY_LEGACY_SCOPES),
        }
        for k in keys
    ]


@router.get("/contract")
def api_contract(_user: AuthUser = Depends(require_tenant_admin)):
    return _contract_response()


@router.post("/keys")
def create_key(
    payload: ApiKeyCreate | None = None,
    name: str | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _require_active_api_access(tenant)
    max_keys = int(getattr(settings, "MAX_API_KEYS_PER_TENANT", 10) or 0)
    if max_keys > 0:
        active_count = int(
            db.query(func.count(ApiKey.id))
            .filter(ApiKey.tenant_id == tenant.id, ApiKey.revoked_at.is_(None))
            .scalar()
            or 0
        )
        if active_count >= max_keys:
            metrics.inc_operational_event("quota_exceeded")
            logger.warning("quota_exceeded", extra={"scope": "api_keys", "tenant_id": tenant.id})
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "api_key_quota_exceeded",
                    "message": f"Limite de {max_keys} clés API actives atteinte. Révoquez une clé avant d’en créer une nouvelle.",
                },
            )
    requested_scopes = validate_api_key_scopes(getattr(payload, "scopes", None))
    if not requested_scopes:
        requested_scopes = list(API_KEY_DEFAULT_SCOPES)
    token = secrets.token_urlsafe(32)
    hashed = ApiKey.hash_token(token)
    api_key = ApiKey(
        tenant_id=tenant.id,
        name=(payload.name if payload and payload.name is not None else name),
        token_hash=hashed,
        scopes=requested_scopes,
    )
    db.add(api_key)
    db.commit()
    db.refresh(api_key)
    return {
        "id": api_key.id,
        "token": token,
        "scopes": requested_scopes,
        "note": "Conservez ce jeton, il ne sera pas réaffiché.",
    }


@router.delete("/keys/{key_id}")
def delete_key(key_id: str, db: Session = Depends(get_db), user: AuthUser = Depends(require_tenant_admin)):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    # Revocation stays available after an expiry/downgrade so an owner can
    # always remove credentials that were created while the plan was active.
    require_pro_or_enterprise(tenant)
    api_key = (
        db.query(ApiKey)
        .filter(ApiKey.id == key_id, ApiKey.tenant_id == tenant.id, ApiKey.revoked_at.is_(None))
        .first()
    )
    if api_key:
        api_key.revoked_at = datetime.now(timezone.utc)
        db.add(api_key)
        db.commit()
    return {"deleted": bool(api_key)}


@router.get("/sso/metadata")
def sso_metadata(db: Session = Depends(get_db), user: AuthUser = Depends(require_tenant_admin)):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _require_active_api_access(tenant)
    return {
        "sso": "on-demand",
        "status": "contact_required",
        "message": "Le SSO n'est pas inclus dans le plan Pro standard. Contactez le support pour une offre sur devis.",
    }
