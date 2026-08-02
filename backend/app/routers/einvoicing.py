from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import (
    AuthUser,
    require_accountant_or_admin,
    require_legacy_einvoicing_api,
    require_paid_subscription,
    require_product_feature,
    require_tenant_admin,
)
from ..jobs.inbox import poll_inbox_for_tenant
from ..models import Customer, Invoice, Tenant
from ..services.pdp import get_provider
from ..services.pdp.service import resolve_connection, resolve_provider, select_connection_for_customer, submit_einvoice
from ..services.integration_secrets import enrich_credentials_with_secrets
from ..services.facturx import FacturxValidationError
from ..services.pdp.utils import PdpProviderError
from ..services.usage import UsageQuotaExceeded
from ..services.einvoicing_readiness import build_einvoicing_readiness
from ..utils.public_errors import sanitize_public_error_message
from ..utils.seqino_http import SeqinoHttpError, seqino_http_status


class EinvoicingSendRequest(BaseModel):
    invoice_id: str
    provider_slug: str | None = None


class EinvoicingInboxRequest(BaseModel):
    provider_slug: str | None = None
    limit: int | None = None


class EinvoicingReadinessCheck(BaseModel):
    id: str
    status: str
    action_url: str | None = None
    missing_fields: list[str] | None = None
    provider: str | None = None
    last_status: str | None = None


class EinvoicingReadinessResponse(BaseModel):
    overall_status: str
    checks: list[EinvoicingReadinessCheck]
    prerequisites: list[str]


router = APIRouter(prefix="/api/einvoicing", tags=["einvoicing"])

PUBLIC_CLIENT_TYPES = {"public", "public_sector", "government", "state", "b2g"}


def _provider_error_status(exc: PdpProviderError) -> int:
    if isinstance(exc, SeqinoHttpError):
        return exc.status_code
    return seqino_http_status(exc.code)


def _normalize_client_type(customer: Customer) -> str:
    return (customer.client_type or "business").strip().lower()


def _is_public_customer(customer: Customer) -> bool:
    return _normalize_client_type(customer) in PUBLIC_CLIENT_TYPES


@router.post("/send")
async def send_einvoicing(
    payload: EinvoicingSendRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription),
    __: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
    ___: None = Depends(require_legacy_einvoicing_api),
):
    inv = db.get(Invoice, payload.invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if settings.EINVOICING_EXPORT_ONLY:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "export_only",
                "message": "Mode export uniquement : transmission à la plateforme agréée désactivée.",
            },
        )
    if inv.status not in {"issued", "sent", "paid", "overdue", "partial"}:
        raise HTTPException(400, "La facture doit être émise avant sa transmission.")
    if not inv.pdf_key or not inv.xml_key:
        raise HTTPException(400, "Les fichiers de la facture émise sont incomplets. Émettez de nouveau la facture.")

    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")

    client_type = _normalize_client_type(customer)
    if client_type == "individual":
        raise HTTPException(400, "Ce type de client n’est pas concerné par la facturation électronique B2B.")

    provider_slug = (payload.provider_slug or "").strip().lower() or None
    provider = None
    channel = None
    env = (settings.APP_ENV or "").strip().lower()
    prod_like = env in {"prod", "production", "staging"}

    if provider_slug in {"chorus", "choruspro"}:
        creds = enrich_credentials_with_secrets(db, inv.tenant_id, {"_tenant_id": inv.tenant_id})
        provider = get_provider("choruspro", creds)
        channel = "choruspro"
    elif provider_slug in {"dummy", "mock"}:
        if provider_slug == "dummy" and prod_like and not settings.ALLOW_DUMMY_IN_PROD:
            raise HTTPException(400, "Le connecteur de test n’est pas disponible dans cet environnement.")
        if provider_slug == "mock" and prod_like:
            raise HTTPException(400, "Le simulateur de transmission n’est pas disponible dans cet environnement.")
        provider = get_provider(provider_slug, {})
        channel = provider_slug
    elif provider_slug:
        try:
            conn = resolve_connection(db, inv.tenant_id, provider_slug)
        except ValueError as exc:
            raise HTTPException(
                400,
                sanitize_public_error_message(
                    exc,
                    status_code=400,
                    fallback="La plateforme agréée sélectionnée est introuvable.",
                ),
            ) from exc
        if (conn.status or "").lower() != "connected":
            raise HTTPException(400, "Connexion plateforme agréée inactive.")
        provider, _provider_creds = resolve_provider(conn, db)
        channel = conn.provider_slug
    elif _is_public_customer(customer):
        creds = enrich_credentials_with_secrets(db, inv.tenant_id, {"_tenant_id": inv.tenant_id})
        provider = get_provider("choruspro", creds)
        channel = "choruspro"
    else:
        if client_type != "business":
            raise HTTPException(400, "Ce type de client n’est pas concerné par la facturation électronique B2B.")
        siren = (customer.siren or "").replace(" ", "") or None
        siret = (customer.siret or "").replace(" ", "") or None
        selected_conn = select_connection_for_customer(db, inv.tenant_id, siren, siret)
        if not selected_conn:
            raise HTTPException(400, "Connexion plateforme agréée introuvable.")
        provider, _provider_creds = resolve_provider(selected_conn, db)
        channel = selected_conn.provider_slug

    if not provider or not channel:
        raise HTTPException(400, "Aucune plateforme agréée compatible n’a été trouvée.")

    provider_kind = (getattr(provider, "kind", "") or "").strip().lower()
    if _is_public_customer(customer) and provider_kind and provider_kind != "b2g":
        raise HTTPException(400, "La plateforme sélectionnée ne prend pas en charge les clients publics.")
    if client_type == "business" and provider_kind and provider_kind != "b2b":
        raise HTTPException(400, "La plateforme sélectionnée ne prend pas en charge les clients professionnels.")

    from .invoices import _ctx as build_ctx

    ctx = build_ctx(db, inv)

    try:
        tx = await submit_einvoice(
            db,
            provider=provider,
            invoice=inv,
            tenant_id=inv.tenant_id,
            channel=channel,
            ctx=ctx,
            poll_status=True,
            raise_on_error=True,
            source="einvoicing_send",
            actor_user_id=user.id,
        )
    except UsageQuotaExceeded:
        raise
    except FacturxValidationError as exc:
        public_message = sanitize_public_error_message(
            exc,
            status_code=422,
            fallback="Le document Factur-X ne respecte pas les règles de conformité attendues.",
        )
        raise HTTPException(
            status_code=422,
            detail={
                "code": exc.code,
                "message": public_message,
                "issues": getattr(exc, "issues", []),
                "doc_url": getattr(exc, "issues", [{}])[0].get("doc_url") if getattr(exc, "issues", None) else None,
            },
        )
    except ValueError as exc:
        raise HTTPException(
            400,
            sanitize_public_error_message(
                exc,
                status_code=400,
                fallback="La facture ne peut pas être transmise dans son état actuel.",
            ),
        ) from exc
    except PdpProviderError as exc:
        status_code = _provider_error_status(exc)
        detail = {
            "code": exc.code or "pdp_submit_failed",
            "message": sanitize_public_error_message(
                exc,
                status_code=status_code,
                fallback="La plateforme agréée n’a pas pu traiter la facture. Réessayez plus tard.",
            ),
        }
        if exc.code in {
            "token_balance_insufficient",
            "trial_einvoicing_transmissions_disabled",
            "trial_seqino_transmissions_disabled",
        }:
            detail["remediation_url"] = "/app/billing"
        raise HTTPException(status_code=status_code, detail=detail)
    except Exception:
        raise HTTPException(502, "Erreur lors de la soumission plateforme.")
    return {"ok": True, "transmission_id": tx.id, "channel": tx.channel, "status": tx.status}


@router.post("/inbox")
async def poll_einvoicing_inbox(
    payload: EinvoicingInboxRequest | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
    __: AuthUser = Depends(require_paid_subscription),
    ___: None = Depends(require_legacy_einvoicing_api),
):
    payload = payload or EinvoicingInboxRequest()
    provider_slug = (payload.provider_slug or "").strip().lower() or None
    summary = await poll_inbox_for_tenant(
        db,
        user.tenant_id,
        provider_slug=provider_slug,
        limit=payload.limit,
    )
    return summary


@router.get(
    "/readiness",
    response_model=EinvoicingReadinessResponse,
    summary="Checklist de preparation e-invoicing (B2B)",
)
def get_einvoicing_readiness(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _feature_user: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
    mode: Literal["export", "connected"] = Query("connected"),
):
    try:
        return build_einvoicing_readiness(db, user.tenant_id, mode=mode)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Profil d’entreprise introuvable.") from exc
