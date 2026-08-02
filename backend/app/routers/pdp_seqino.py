from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
import time
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import (
    AuthUser,
    require_legacy_einvoicing_api,
    require_paid_subscription,
    require_product_feature,
    require_tenant_admin,
)
from ..models import PdpAccount, PdpConnection, PdpMandate, Tenant
from ..services.seqino import SeqinoClient, normalize_onboarding_status, normalize_onboarding_url
from ..services import seqino_mandates
from ..services.connected_mode import ensure_connected_mode_operational
from ..services.seqino_mandates import seqino_has_active_mandate
from ..services.integration_secrets import resolve_seqino_credentials
from ..services.pdp.utils import PdpProviderError
from ..utils.pdp_accounts import get_pdp_account_metadata, update_pdp_account_payload
from ..utils.public_provider_messages import sanitize_public_provider_message
from ..utils.seqino_http import SeqinoHttpError, seqino_http_status

router = APIRouter(
    prefix="/api/pdp/seqino",
    tags=["pdp"],
    dependencies=[Depends(require_product_feature("seqino_enabled"))],
)


def _export_hint_for_code(code: str | None) -> str | None:
    normalized = (code or "").strip().lower()
    if normalized in {"seqino_mandate_missing", "seqino_not_ready"}:
        return "Vous pouvez continuer en mode export sans plateforme."
    return None


def _error(status_code: int, code: str, message: str, *, hint: str | None = None) -> HTTPException:
    detail = {"code": code, "message": message}
    final_hint = hint or _export_hint_for_code(code)
    if final_hint:
        detail["hint"] = final_hint
    return HTTPException(status_code=status_code, detail=detail)


def _provider_error_status(exc: PdpProviderError) -> int:
    if isinstance(exc, SeqinoHttpError):
        return exc.status_code
    return seqino_http_status(exc.code)


def _require_legacy_onboarding_nonprod() -> None:
    if (settings.APP_ENV or "").strip().lower() in {"prod", "production", "staging"}:
        raise HTTPException(
            status_code=410,
            detail={
                "code": "legacy_seqino_onboarding_retired",
                "message": "Utilisez le parcours d'activation Seqino avec consentement explicite.",
                "remediation_url": "/app/settings/platforms",
            },
        )
    require_legacy_einvoicing_api()


def _infer_environment() -> str | None:
    base = (settings.SEQINO_BASE_URL or "").strip().lower()
    if not base:
        return None
    if "sandbox" in base or "test" in base or ".seqino.dev" in base:
        return "sandbox"
    return "prod"


def _extract_metadata_updates(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    updates: dict[str, Any] = {}
    org_id = payload.get("organization_id") or payload.get("organisation_id")
    if org_id:
        updates["organization_id"] = str(org_id)
    scopes = payload.get("scopes") or payload.get("scope")
    if scopes:
        updates["scopes"] = scopes
    env = payload.get("environment") or payload.get("env") or payload.get("mode")
    if env:
        updates["environment"] = str(env)
    return updates


def _seqino_client(db: Session, tenant_id: str) -> SeqinoClient:
    access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id)
    if not access_token:
        raise ValueError("SEQINO_ACCESS_TOKEN manquant.")
    return SeqinoClient.from_credentials(
        access_token=access_token,
        sponsor_id=sponsor_id,
    )


def _callback_url() -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    if not base:
        raise ValueError("PUBLIC_BASE_URL ou FRONTEND_BASE_URL requis pour le callback PDP.")
    return f"{base.rstrip('/')}/app/pdp"


def _status_fallback(account: PdpAccount | None) -> str:
    if not account:
        return "NOT_CONNECTED"
    return normalize_onboarding_status(account.status) or (account.status or "NOT_CONNECTED")


def _payload(account: PdpAccount | None, status: str, raw: dict[str, Any] | None = None) -> dict[str, Any]:
    data = dict(raw if raw is not None else get_pdp_account_metadata(account))
    normalized_url = normalize_onboarding_url(data.get("onboarding_url"))
    if normalized_url:
        data["onboarding_url"] = normalized_url
    return {
        "status": status,
        "client_id": account.provider_client_id if account else None,
        "link_id": data.get("onboarding_link_id") or data.get("mandate_id") or data.get("link_id"),
        "mandate_id": data.get("mandate_id") or data.get("onboarding_mandate_id"),
        "onboarding_url": data.get("onboarding_url"),
    }


def _extract_client_id(item: Any) -> str | None:
    if not isinstance(item, dict):
        return None
    for key in ("client_id", "id"):
        value = item.get(key)
        if value:
            return str(value)
    return None


def _digits_only(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _tenant_default_directory_entry(tenant: Tenant) -> dict[str, str]:
    siret_digits = _digits_only(tenant.siret)
    siren = siret_digits[:9] if len(siret_digits) >= 9 else ""
    name = (tenant.name or "").strip()
    if not name:
        raise _error(422, "company_name_missing", "Renseignez le nom de l'entreprise avant d'activer Seqino.")
    if len(siren) != 9:
        raise _error(422, "company_siren_missing", "Renseignez un SIRET valide dans Mon entreprise avant d'activer Seqino.")
    entry: dict[str, str] = {"siren": siren, "name": name}
    if len(siret_digits) == 14:
        entry["siret"] = siret_digits
    return entry


def _upsert_pdp_mandate(db: Session, tenant_id: str, data: dict[str, Any]) -> PdpMandate | None:
    mandate_id = str(data.get("mandate_id") or "").strip()
    if not mandate_id:
        return None
    mandate = (
        db.query(PdpMandate)
        .filter(PdpMandate.tenant_id == tenant_id, PdpMandate.mandate_id == mandate_id)
        .first()
    )
    if not mandate:
        mandate = PdpMandate(tenant_id=tenant_id, provider_slug="seqino", mandate_id=mandate_id)
        db.add(mandate)
    for field in ("siren", "siret", "suffix", "routing_identifier", "name", "start_date", "status", "file_attachment"):
        value = data.get(field)
        if value is not None:
            setattr(mandate, field, value)
    return mandate


def _latest_mandate_for_entry(
    db: Session,
    tenant_id: str,
    entry_payload: dict[str, str],
    mandate_id: str | None = None,
) -> PdpMandate | None:
    if mandate_id:
        existing = (
            db.query(PdpMandate)
            .filter(
                PdpMandate.tenant_id == tenant_id,
                PdpMandate.provider_slug == "seqino",
                PdpMandate.mandate_id == mandate_id,
            )
            .first()
        )
        if existing:
            return existing
    query = db.query(PdpMandate).filter(
        PdpMandate.tenant_id == tenant_id,
        PdpMandate.provider_slug == "seqino",
        PdpMandate.siren == entry_payload["siren"],
    )
    if entry_payload.get("siret"):
        query = query.filter(PdpMandate.siret == entry_payload["siret"])
    return query.order_by(PdpMandate.updated_at.desc()).first()


async def _ensure_default_mandate(
    db: Session,
    tenant: Tenant,
    *,
    client: SeqinoClient,
    client_id: str,
    existing_mandate_id: str | None = None,
) -> PdpMandate:
    entry_payload = _tenant_default_directory_entry(tenant)
    existing = _latest_mandate_for_entry(db, tenant.id, entry_payload, existing_mandate_id)
    if existing:
        return existing
    utc_today = datetime.now(timezone.utc).date()
    mandate_payload: dict[str, Any] = {
        "directory_entry": entry_payload,
        "start_date": datetime(utc_today.year, utc_today.month, utc_today.day, tzinfo=timezone.utc).isoformat(),
    }
    result = await seqino_mandates.create_mandate(
        mandate_payload,
        access_token=client.access_token,
        client_id=client_id,
        sponsor_id=client.sponsor_id,
        tenant_id=tenant.id,
    )
    raw_payload = result.get("payload") if isinstance(result, dict) else None
    merged_payload = dict(mandate_payload)
    if isinstance(raw_payload, dict):
        merged_payload.update(raw_payload)
        if isinstance(raw_payload.get("directory_entry"), dict):
            merged_payload["directory_entry"] = {
                **mandate_payload["directory_entry"],
                **raw_payload["directory_entry"],
            }
    normalized = seqino_mandates.normalize_mandate_item(merged_payload)
    if not normalized.get("mandate_id"):
        normalized["mandate_id"] = result.get("mandate_id")
    mandate = _upsert_pdp_mandate(db, tenant.id, normalized)
    if not mandate:
        raise ValueError("mandate_id manquant dans la reponse plateforme partenaire.")
    return mandate


def _matches_external_ref(item: Any, tenant_id: str) -> bool:
    if not isinstance(item, dict):
        return False
    for key in ("external_ref", "external_reference", "external_id"):
        value = item.get(key)
        if value and str(value) == tenant_id:
            return True
    return False


def _get_account(db: Session, tenant_id: str) -> PdpAccount | None:
    return db.query(PdpAccount).filter(PdpAccount.tenant_id == tenant_id, PdpAccount.provider == "seqino").first()


def _ensure_account(db: Session, tenant_id: str) -> PdpAccount:
    account = _get_account(db, tenant_id)
    if account:
        return account
    account = PdpAccount(tenant_id=tenant_id, provider="seqino", status="NOT_CONNECTED")
    db.add(account)
    db.flush()
    return account


async def _ensure_client_id(
    db: Session,
    account: PdpAccount,
    tenant: Tenant,
    user: AuthUser,
    client: SeqinoClient,
) -> tuple[str, dict[str, Any]]:
    tenant_id = tenant.id
    if not tenant_id:
        raise _error(500, "tenant_invalid", "Tenant invalide.")
    metadata = get_pdp_account_metadata(account)
    if account.provider_client_id:
        return account.provider_client_id, metadata

    client_id: str | None = None
    client_payload: dict[str, Any] | None = None
    try:
        items = await client.list_clients(tenant_id=user.tenant_id)
        for item in items:
            if _matches_external_ref(item, tenant_id):
                client_id = _extract_client_id(item)
                client_payload = item if isinstance(item, dict) else None
                break
    except PdpProviderError as exc:
        status_code = _provider_error_status(exc)
        raise _error(status_code, exc.code or "seqino_lookup_failed", str(exc))
    except Exception:
        raise _error(502, "seqino_lookup_failed", "Erreur lors de la recherche du client PDP.")

    if not client_id:
        organization_name = (tenant.name or "").strip()
        contact_email = (user.email or "").strip().lower()
        if not organization_name:
            raise _error(400, "seqino_invalid", "Nom d'entreprise manquant pour la plateforme partenaire.")
        if not contact_email:
            raise _error(400, "seqino_invalid", "Email de contact manquant pour la plateforme partenaire.")
        try:
            result = await client.create_client(
                organization_name=organization_name,
                contact_email=contact_email,
                external_ref=tenant_id,
                tenant_id=user.tenant_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_invalid", str(exc))
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "seqino_failed", str(exc))
        except Exception:
            raise _error(502, "seqino_failed", "Erreur lors de la creation du client PDP.")
        client_id = result["client_id"]
        client_payload = result.get("payload") if isinstance(result, dict) else None

    account.provider_client_id = client_id
    account.status = account.status or "NOT_CONNECTED"
    metadata_updates = _extract_metadata_updates(client_payload)
    update_pdp_account_payload(
        account,
        provider_payload=client_payload,
        metadata_updates=metadata_updates,
        status=account.status,
        environment=_infer_environment(),
    )
    db.add(account)
    db.flush()
    return client_id, get_pdp_account_metadata(account)


@router.post("/connect")
async def seqino_connect(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _paid_user: AuthUser = Depends(require_paid_subscription),
):
    ensure_connected_mode_operational(db, user.tenant_id, "seqino")
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise _error(404, "tenant_missing", "Tenant introuvable.")
    account = _ensure_account(db, user.tenant_id)
    if account.provider_client_id:
        status = _status_fallback(account)
        return _payload(account, status)

    try:
        client = _seqino_client(db, user.tenant_id)
    except ValueError as exc:
        raise _error(400, "seqino_config_missing", str(exc))

    await _ensure_client_id(db, account, tenant, user, client)
    db.commit()
    db.refresh(account)
    return _payload(account, _status_fallback(account))


@router.post("/onboarding-link")
async def seqino_onboarding_link(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _paid_user: AuthUser = Depends(require_paid_subscription),
    _legacy_nonprod: None = Depends(_require_legacy_onboarding_nonprod),
):
    ensure_connected_mode_operational(db, user.tenant_id, "seqino")
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise _error(404, "tenant_missing", "Tenant introuvable.")
    account = _ensure_account(db, user.tenant_id)
    metadata = get_pdp_account_metadata(account)
    normalized_existing_url = normalize_onboarding_url(metadata.get("onboarding_url"))
    if normalized_existing_url and normalized_existing_url != metadata.get("onboarding_url"):
        metadata["onboarding_url"] = normalized_existing_url
        update_pdp_account_payload(
            account,
            metadata_updates={"onboarding_url": normalized_existing_url},
            status=account.status,
            environment=_infer_environment(),
        )
        db.add(account)
        db.commit()
        db.refresh(account)
        metadata = get_pdp_account_metadata(account)
    existing_mandate_id = metadata.get("mandate_id") or metadata.get("onboarding_mandate_id")
    if account.status and normalize_onboarding_status(account.status) == "ACTIVE" and metadata.get("onboarding_url"):
        return _payload(account, "ACTIVE", metadata)
    if metadata.get("onboarding_url") and existing_mandate_id:
        status = normalize_onboarding_status(account.status) or "PENDING"
        return _payload(account, status, metadata)

    try:
        client = _seqino_client(db, user.tenant_id)
    except ValueError as exc:
        raise _error(400, "seqino_config_missing", str(exc))

    client_id, _client_metadata = await _ensure_client_id(db, account, tenant, user, client)
    try:
        mandate = await _ensure_default_mandate(
            db,
            tenant,
            client=client,
            client_id=client_id,
            existing_mandate_id=str(existing_mandate_id) if existing_mandate_id else None,
        )
        result = await client.create_onboarding_link(
            client_id=client_id,
            mandate_id=mandate.mandate_id,
            callback_url=_callback_url(),
            tenant_id=user.tenant_id,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise _error(400, "seqino_invalid", str(exc))
    except PdpProviderError as exc:
        status_code = _provider_error_status(exc)
        raise _error(status_code, exc.code or "seqino_failed", str(exc))
    except Exception:
        raise _error(502, "seqino_failed", "Erreur lors de la creation du lien PDP.")

    account.status = "PENDING"
    metadata_updates = _extract_metadata_updates(result.get("payload"))
    metadata_updates.update(
        {
            "onboarding_link_id": result["link_id"],
            "mandate_id": result.get("mandate_id") or result["link_id"],
            "onboarding_url": result["onboarding_url"],
            "onboarding_expires_at": result.get("expires_at"),
            "onboarding_status": "PENDING",
        }
    )
    update_pdp_account_payload(
        account,
        provider_payload=result.get("payload"),
        metadata_updates=metadata_updates,
        status=account.status,
        environment=_infer_environment(),
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return _payload(account, "PENDING", get_pdp_account_metadata(account))


@router.get("/status")
async def seqino_status(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_paid_subscription),
):
    ensure_connected_mode_operational(db, user.tenant_id, "seqino")
    account = _get_account(db, user.tenant_id)
    if not account or not account.provider_client_id:
        return _payload(account, "NOT_CONNECTED")

    metadata = get_pdp_account_metadata(account)
    mandate_id = metadata.get("mandate_id") or metadata.get("onboarding_mandate_id") or metadata.get("onboarding_link_id")
    if not mandate_id:
        status = _status_fallback(account)
        return _payload(account, status, metadata)

    try:
        client = _seqino_client(db, user.tenant_id)
    except ValueError as exc:
        raise _error(400, "seqino_config_missing", str(exc))

    try:
        result = await client.get_onboarding_status(
            client_id=account.provider_client_id,
            mandate_id=str(mandate_id),
            tenant_id=user.tenant_id,
        )
    except ValueError as exc:
        raise _error(400, "seqino_invalid", str(exc))
    except PdpProviderError as exc:
        status_code = _provider_error_status(exc)
        raise _error(status_code, exc.code or "seqino_failed", str(exc))
    except Exception:
        raise _error(502, "seqino_failed", "Erreur lors de la recuperation du statut PDP.")

    status = normalize_onboarding_status(result.get("status")) or _status_fallback(account)
    account.status = status
    metadata_updates = _extract_metadata_updates(result.get("payload"))
    metadata_updates["onboarding_status"] = status
    update_pdp_account_payload(
        account,
        provider_payload=result.get("payload"),
        metadata_updates=metadata_updates,
        status=account.status,
        environment=_infer_environment(),
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return _payload(account, status, get_pdp_account_metadata(account))


@router.get("/ping")
async def seqino_ping(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_paid_subscription),
):
    ensure_connected_mode_operational(db, user.tenant_id, "seqino")
    access_token, sponsor_id = resolve_seqino_credentials(db, user.tenant_id)
    try:
        if not access_token:
            raise ValueError("missing_access")
        client = SeqinoClient.from_credentials(
            access_token=access_token,
            sponsor_id=sponsor_id,
        )
    except ValueError:
        return {
            "ok": False,
            "latency_ms": None,
            "error": "Cette connexion n’est pas encore configurée. Contactez l’assistance.",
        }
    started = time.monotonic()
    result = await client.ping(tenant_id=user.tenant_id)
    latency_ms = result.get("latency_ms")
    if latency_ms is None:
        latency_ms = int((time.monotonic() - started) * 1000)
    return {
        "ok": bool(result.get("ok")),
        "latency_ms": latency_ms,
        "error": sanitize_public_provider_message(
            result.get("error"),
            fallback="La vérification de la plateforme agréée a échoué." if not result.get("ok") else None,
        ),
    }


@router.get("/mandate-check")
def seqino_mandate_check(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    ensure_connected_mode_operational(db, user.tenant_id, "seqino")
    account = _get_account(db, user.tenant_id)
    connection = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == user.tenant_id, PdpConnection.provider_slug == "seqino")
        .first()
    )
    connection_active = False
    if connection:
        status = (connection.status or "").strip().lower()
        connection_active = status in {"connected", "active"} or not status
    account_active = bool(account and account.provider_client_id)
    has_connection = bool(connection_active or account_active)
    has_active_mandate = seqino_has_active_mandate(user.tenant_id, db=db)
    if not has_connection:
        next_step = "Valider et activer"
    elif not has_active_mandate:
        next_step = "Vérifier la configuration PA"
    else:
        next_step = "OK"
    return {
        "has_connection": has_connection,
        "has_active_mandate": has_active_mandate,
        "recommended_next_step": next_step,
    }
