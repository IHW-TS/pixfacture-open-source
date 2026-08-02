from __future__ import annotations

from datetime import date, datetime
from typing import Any

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session
from uuid import uuid4

from ..config import settings
from ..db import SessionLocal
from ..models import PdpMandate, Tenant
from ..utils.seqino_http import seqino_request_checked
from ..utils.seqino_auth import normalize_seqino_authorization
from ..utils.ssrf import validate_outbound_url


_HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=5.0)
_ACTIVE_MANDATE_STATUSES = {"ACTIVE"}


def _digits_only(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _normalize_siren_siret(siren: str | None = None, siret: str | None = None) -> tuple[str | None, str | None]:
    siren_digits = _digits_only(siren)
    siret_digits = _digits_only(siret)
    if not siren_digits and len(siret_digits) >= 9:
        siren_digits = siret_digits[:9]
    return (siren_digits or None), (siret_digits or None)


def _demo_mode() -> bool:
    return bool(getattr(settings, "SEQINO_DEMO_MODE", False))


def _demo_id(prefix: str) -> str:
    return f"demo-{prefix}-{uuid4().hex[:8]}"


def seqino_has_active_mandate(tenant_id: str, db: Session | None = None) -> bool:
    if not tenant_id:
        return False

    def _query(session: Session) -> bool:
        return (
            session.query(PdpMandate.id)
            .filter(
                PdpMandate.tenant_id == tenant_id,
                PdpMandate.provider_slug == "seqino",
                func.upper(PdpMandate.status).in_(_ACTIVE_MANDATE_STATUSES),
            )
            .first()
            is not None
        )

    if db is not None:
        return _query(db)
    with SessionLocal() as session:
        return _query(session)


def seqino_has_active_mandate_for_issuer(
    tenant_id: str,
    *,
    siren: str | None = None,
    siret: str | None = None,
    db: Session | None = None,
) -> bool:
    if not tenant_id:
        return False
    siren_norm, siret_norm = _normalize_siren_siret(siren, siret)
    if not siren_norm:
        return False

    def _query(session: Session) -> bool:
        query = session.query(PdpMandate.id).filter(
            PdpMandate.tenant_id == tenant_id,
            PdpMandate.provider_slug == "seqino",
            func.upper(PdpMandate.status).in_(_ACTIVE_MANDATE_STATUSES),
            PdpMandate.siren == siren_norm,
        )
        if siret_norm:
            query = query.filter(PdpMandate.siret == siret_norm)
        return query.first() is not None

    if db is not None:
        return _query(db)
    with SessionLocal() as session:
        return _query(session)


def seqino_has_active_mandate_for_tenant_issuer(
    tenant_id: str,
    *,
    db: Session | None = None,
) -> bool:
    """Check the active mandate for this tenant's exact issuing entity."""

    if not tenant_id:
        return False

    def _check(session: Session) -> bool:
        tenant = session.get(Tenant, tenant_id)
        if tenant is None:
            return False
        digits = _digits_only(tenant.siret)
        siren = digits[:9] if len(digits) >= 9 else None
        siret = digits if len(digits) == 14 else None
        return seqino_has_active_mandate_for_issuer(
            tenant_id,
            siren=siren,
            siret=siret,
            db=session,
        )

    if db is not None:
        return _check(db)
    with SessionLocal() as session:
        return _check(session)


def _base_url() -> str:
    base_url = (settings.SEQINO_BASE_URL or "").strip().rstrip("/")
    if not base_url:
        raise ValueError("SEQINO_BASE_URL manquant pour les mandats PDP.")
    return validate_outbound_url(base_url)


def _endpoint(path: str) -> str:
    url = f"{_base_url()}/{path.lstrip('/')}"
    return validate_outbound_url(url)


def _headers(
    access_token: str,
    *,
    client_id: str,
    sponsor_id: str | None = None,
) -> dict[str, str]:
    raw = (access_token or "").strip()
    if not raw:
        raise ValueError("Token plateforme partenaire manquant.")
    client = (client_id or "").strip()
    if not client:
        raise ValueError("client_id plateforme partenaire manquant.")
    sponsor = (sponsor_id or "").strip()
    if not sponsor:
        raise ValueError("Sponsor plateforme partenaire manquant.")
    headers = {
        "Accept": "application/json",
        "Authorization": normalize_seqino_authorization(raw),
        "X-PDP-Client-Id": client,
        "X-PDP-Sponsor-Id": sponsor,
    }
    return headers


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    return raw or None


def _parse_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            return date.fromisoformat(raw)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                return parsed.date()
            except ValueError:
                return None
    return None


def _normalize_attachment(value: Any) -> Any | None:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    text = _normalize_text(value)
    return text


def _extract_mandate_id(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    for key in ("mandate_id", "mandateId", "id", "uuid", "reference"):
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


def _extract_items(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict):
        for key in ("items", "mandates", "results", "data"):
            raw_items = data.get(key)
            if isinstance(raw_items, list):
                return [item for item in raw_items if isinstance(item, dict)]
        if _extract_mandate_id(data):
            return [data]
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


def normalize_mandate_item(item: dict[str, Any]) -> dict[str, Any]:
    entry = item.get("directory_entry")
    entry_dict = entry if isinstance(entry, dict) else None
    siren = _normalize_text(entry_dict.get("siren")) if entry_dict else None
    siret = _normalize_text(entry_dict.get("siret")) if entry_dict else None
    suffix = _normalize_text(entry_dict.get("suffix")) if entry_dict else None
    routing_identifier = _normalize_text(entry_dict.get("routing_identifier")) if entry_dict else None
    name = _normalize_text(entry_dict.get("name")) if entry_dict else None
    file_attachment = item.get("file_attachment")
    if file_attachment is None:
        file_attachment = item.get("fileAttachment")
    return {
        "mandate_id": _normalize_text(
            item.get("mandate_id") or item.get("mandateId") or item.get("id") or item.get("uuid")
        ),
        "siren": siren or _normalize_text(item.get("siren") or item.get("company_siren") or item.get("supplier_siren")),
        "siret": siret or _normalize_text(item.get("siret") or item.get("company_siret") or item.get("supplier_siret")),
        "suffix": suffix or _normalize_text(item.get("suffix") or item.get("suffix_code") or item.get("suffixCode")),
        "routing_identifier": routing_identifier
        or _normalize_text(item.get("routing_identifier") or item.get("routingIdentifier") or item.get("routing_id")),
        "name": name
        or _normalize_text(item.get("name") or item.get("company_name") or item.get("companyName") or item.get("label")),
        "start_date": _parse_date(
            item.get("start_date") or item.get("startDate") or item.get("valid_from") or item.get("validFrom")
        ),
        "status": _normalize_text(item.get("status") or item.get("state") or item.get("status_code")),
        "file_attachment": _normalize_attachment(file_attachment),
    }


async def list_mandates(
    *,
    access_token: str,
    client_id: str,
    sponsor_id: str | None = None,
    tenant_id: str | None = None,
) -> list[dict[str, Any]]:
    if _demo_mode():
        if not tenant_id:
            return []
        with SessionLocal() as session:
            mandates = (
                session.query(PdpMandate)
                .filter(PdpMandate.tenant_id == tenant_id, PdpMandate.provider_slug == "seqino")
                .all()
            )
        return [
            {
                "mandate_id": mandate.mandate_id,
                "siren": mandate.siren,
                "siret": mandate.siret,
                "suffix": mandate.suffix,
                "routing_identifier": mandate.routing_identifier,
                "name": mandate.name,
                "status": mandate.status,
            }
            for mandate in mandates
        ]
    url = _endpoint("/mandates")
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "GET",
            url,
            headers=_headers(access_token, client_id=client_id, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
        )
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else None
    return _extract_items(data)


async def create_mandate(
    payload: dict[str, Any],
    *,
    access_token: str,
    client_id: str,
    sponsor_id: str | None = None,
    tenant_id: str | None = None,
) -> dict[str, Any]:
    if _demo_mode():
        mandate_id = _demo_id("mandate")
        demo_payload = dict(payload)
        demo_payload["mandate_id"] = mandate_id
        demo_payload["status"] = "ACTIVE"
        return {"mandate_id": mandate_id, "payload": demo_payload}
    url = _endpoint("/mandates")
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "POST",
            url,
            json=payload,
            headers=_headers(access_token, client_id=client_id, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
        )
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else None
    mandate_data = None
    if isinstance(data, dict):
        if isinstance(data.get("mandate"), dict):
            mandate_data = data.get("mandate")
        else:
            mandate_data = data
    mandate_id_value = _extract_mandate_id(mandate_data if isinstance(mandate_data, dict) else None)
    if not mandate_id_value:
        raise ValueError("mandate_id manquant dans la reponse plateforme partenaire.")
    return {"mandate_id": mandate_id_value, "payload": mandate_data if isinstance(mandate_data, dict) else None}


async def delete_mandate(
    mandate_id: str,
    *,
    access_token: str,
    client_id: str,
    sponsor_id: str | None = None,
    tenant_id: str | None = None,
) -> dict[str, Any] | None:
    if _demo_mode():
        return {"mandate_id": mandate_id, "status": "deleted", "demo": True}
    url = _endpoint(f"/mandates/{mandate_id}")
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "DELETE",
            url,
            headers=_headers(access_token, client_id=client_id, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
        )
    if resp.headers.get("content-type", "").startswith("application/json"):
        try:
            return resp.json()
        except Exception:
            return None
    return None
