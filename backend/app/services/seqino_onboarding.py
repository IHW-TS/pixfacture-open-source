from __future__ import annotations

from typing import Any
from urllib.parse import urlparse, urlunparse
from uuid import uuid4

import httpx

from ..config import settings
from ..utils.seqino_http import seqino_raise_for_status, seqino_request_checked
from ..utils.seqino_auth import normalize_seqino_authorization
from ..utils.ssrf import validate_outbound_url


_HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=5.0)


def _demo_mode() -> bool:
    return bool(getattr(settings, "SEQINO_DEMO_MODE", False))


def _demo_frontend_url() -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
    if base:
        return f"{base}/app/einvoicing"
    return "/app/einvoicing"


def _demo_id(prefix: str) -> str:
    return f"demo-{prefix}-{uuid4().hex[:8]}"


def _base_url() -> str:
    base_url = (settings.SEQINO_BASE_URL or "").strip().rstrip("/")
    if not base_url:
        raise ValueError("SEQINO_BASE_URL manquant pour l'onboarding plateforme partenaire.")
    return validate_outbound_url(base_url)


def _endpoint(path: str) -> str:
    url = f"{_base_url()}/{path.lstrip('/')}"
    return validate_outbound_url(url)


def normalize_onboarding_url(raw_url: Any) -> str | None:
    """Keep Seqino onboarding links on the configured sandbox host when needed.

    Seqino sandbox responses can contain the production-facing host
    `pdp.seqino.com`, which is not resolvable from our environment. When the API
    base is configured on a `seqino.dev` sandbox host, the user-facing onboarding
    link must use the same sandbox frontend host instead.
    """
    url = _normalize_text(raw_url)
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return url
    if (parsed.hostname or "").lower() != "pdp.seqino.com":
        return url

    base = urlparse(_base_url())
    base_host = (base.hostname or "").lower()
    if not base_host.endswith(".seqino.dev"):
        return url

    replacement_netloc = "pdp.seqino.dev" if base_host.startswith("pdp-api") else base.netloc
    return urlunparse((base.scheme or parsed.scheme, replacement_netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))


def _headers(access_token: str, *, client_id: str | None = None, sponsor_id: str | None = None) -> dict[str, str]:
    raw = (access_token or "").strip()
    if not raw:
        raise ValueError("Token plateforme partenaire manquant.")
    headers = {
        "Accept": "application/json",
        "Authorization": normalize_seqino_authorization(raw),
    }
    if client_id:
        headers["X-PDP-Client-Id"] = client_id
    if sponsor_id:
        headers["X-PDP-Sponsor-Id"] = sponsor_id
    return headers


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    return raw or None


def _callback_url() -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    if not base:
        raise ValueError("PUBLIC_BASE_URL ou FRONTEND_BASE_URL requis pour le callback PDP.")
    return f"{base.rstrip('/')}/app/einvoicing"


def _build_client_payload(tenant: Any, contact_email: str) -> dict[str, Any]:
    organization_name = _normalize_text(getattr(tenant, "name", None))
    external_ref = _normalize_text(getattr(tenant, "id", None))
    email = _normalize_text(contact_email)
    if not organization_name:
        raise ValueError("organization_name manquant pour l'onboarding plateforme partenaire.")
    if not email:
        raise ValueError("contact_email manquant pour l'onboarding plateforme partenaire.")
    if not external_ref:
        raise ValueError("external_ref manquant pour l'onboarding plateforme partenaire.")
    return {
        "organization_name": organization_name,
        "contact_email": email,
        "external_ref": external_ref,
    }


def _extract_id(data: dict[str, Any] | None, keys: tuple[str, ...]) -> str | None:
    if not data:
        return None
    for key in keys:
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


async def create_client(
    tenant: Any,
    *,
    access_token: str,
    contact_email: str,
    sponsor_id: str | None = None,
) -> dict[str, Any]:
    if _demo_mode():
        client_id = _demo_id("client")
        return {"client_id": client_id, "payload": {"client_id": client_id, "demo": True}}
    url = _endpoint("/clients")
    payload = _build_client_payload(tenant, contact_email)
    tenant_id = getattr(tenant, "id", None)
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "POST",
            url,
            json=payload,
            headers=_headers(access_token, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
        )
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    created_client_id = _extract_id(data if isinstance(data, dict) else None, ("client_id", "id"))
    if not created_client_id:
        raise ValueError("client_id manquant dans la reponse plateforme partenaire.")
    return {"client_id": created_client_id, "payload": data if isinstance(data, dict) else None}


async def get_client(
    *,
    access_token: str,
    client_id: str,
    sponsor_id: str | None = None,
    tenant_id: str | None = None,
) -> dict[str, Any]:
    normalized_client_id = _normalize_text(client_id)
    if not normalized_client_id:
        raise ValueError("client_id requis pour consulter le client plateforme partenaire.")
    if _demo_mode():
        return {"client_id": normalized_client_id, "status": "active", "demo": True}
    url = _endpoint(f"/clients/{normalized_client_id}")
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "GET",
            url,
            headers=_headers(access_token, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
        )
    data = _response_json_dict(resp)
    if not data:
        raise ValueError("Réponse client plateforme partenaire invalide.")
    return data


async def update_client(
    tenant: Any,
    *,
    access_token: str,
    client_id: str,
    contact_email: str,
    sponsor_id: str | None = None,
) -> dict[str, Any]:
    normalized_client_id = _normalize_text(client_id)
    if not normalized_client_id:
        raise ValueError("client_id requis pour synchroniser le client plateforme partenaire.")
    if _demo_mode():
        return {"client_id": normalized_client_id, "payload": {"client_id": normalized_client_id, "demo": True}}
    url = _endpoint(f"/clients/{normalized_client_id}")
    payload = _build_client_payload(tenant, contact_email)
    tenant_id = getattr(tenant, "id", None)
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "PUT",
            url,
            json=payload,
            headers=_headers(access_token, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
        )
    data = _response_json_dict(resp)
    returned_client_id = _extract_id(data, ("client_id", "id")) or normalized_client_id
    return {"client_id": returned_client_id, "payload": data or None}


async def delete_client(
    *,
    access_token: str,
    client_id: str,
    sponsor_id: str | None = None,
    tenant_id: str | None = None,
) -> None:
    normalized_client_id = _normalize_text(client_id)
    if not normalized_client_id:
        raise ValueError("client_id requis pour supprimer le client plateforme partenaire.")
    if _demo_mode():
        return
    url = _endpoint(f"/clients/{normalized_client_id}")
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        await seqino_request_checked(
            client,
            "DELETE",
            url,
            headers=_headers(access_token, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
        )


async def get_or_create_client(
    tenant: Any,
    *,
    access_token: str,
    contact_email: str,
    sponsor_id: str | None = None,
    existing_client_id: str | None = None,
) -> dict[str, Any]:
    client_id = _normalize_text(existing_client_id)
    if client_id:
        return {"client_id": client_id, "payload": None}
    existing = await find_client_by_external_ref(
        tenant,
        access_token=access_token,
        sponsor_id=sponsor_id,
    )
    if existing:
        return existing
    return await create_client(
        tenant,
        access_token=access_token,
        contact_email=contact_email,
        sponsor_id=sponsor_id,
    )


def _extract_link(data: dict[str, Any] | None) -> tuple[str | None, str | None, str | None]:
    if not data:
        return None, None, None
    mandate_id = _extract_id(data, ("mandate_id", "mandateId", "id"))
    link_id = mandate_id or _extract_id(data, ("link_id", "onboarding_link_id"))
    url = data.get("onboarding_url") or data.get("url")
    expires_at = _normalize_text(data.get("expires_at") or data.get("expiresAt"))
    return link_id, normalize_onboarding_url(url), expires_at


def _response_json(resp: httpx.Response) -> Any:
    if not resp.headers.get("content-type", "").startswith("application/json"):
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def _response_json_dict(resp: httpx.Response) -> dict[str, Any]:
    data = _response_json(resp)
    return data if isinstance(data, dict) else {}


async def find_client_by_external_ref(
    tenant: Any,
    *,
    access_token: str,
    sponsor_id: str | None = None,
) -> dict[str, Any] | None:
    if _demo_mode():
        return None
    external_ref = _normalize_text(getattr(tenant, "id", None))
    if not external_ref:
        raise ValueError("external_ref manquant pour l'onboarding plateforme partenaire.")
    url = _endpoint("/clients")
    tenant_id = getattr(tenant, "id", None)
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "GET",
            url,
            params={"external_ref": external_ref},
            headers=_headers(access_token, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
            raise_for_status=False,
        )
    if resp.status_code == 404:
        return None
    raw_data = _response_json(resp)
    candidates: list[dict[str, Any]] = []
    if isinstance(raw_data, list):
        candidates = [item for item in raw_data if isinstance(item, dict)]
    elif isinstance(raw_data, dict):
        nested = raw_data.get("clients") or raw_data.get("items") or raw_data.get("data")
        if isinstance(nested, list):
            candidates = [item for item in nested if isinstance(item, dict)]
        else:
            candidates = [raw_data]
    data = next(
        (
            item
            for item in candidates
            if _normalize_text(item.get("external_ref")) == external_ref
        ),
        candidates[0] if len(candidates) == 1 else None,
    )
    client_id = _extract_id(data, ("client_id", "id")) if data else None
    if resp.status_code >= 400 and not client_id:
        seqino_raise_for_status(resp)
    if not client_id:
        return None
    return {"client_id": client_id, "payload": data or None}


async def create_onboarding_link(
    *,
    tenant: Any,
    access_token: str,
    client_id: str,
    mandate_id: str,
    callback_url: str | None = None,
    sponsor_id: str | None = None,
) -> dict[str, Any]:
    mandate = _normalize_text(mandate_id)
    if not mandate:
        raise ValueError("mandate_id requis pour generer le lien d'onboarding Seqino.")
    if _demo_mode():
        return {
            "link_id": mandate,
            "mandate_id": mandate,
            "onboarding_url": _demo_frontend_url(),
            "payload": {"mandate_id": mandate, "demo": True},
        }
    url = _endpoint("/clients/onboarding-link")
    _ = callback_url
    payload = {"mandate_id": mandate}
    tenant_id = getattr(tenant, "id", None)
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "POST",
            url,
            json=payload,
            headers=_headers(access_token, client_id=client_id, sponsor_id=sponsor_id),
            tenant_id=tenant_id,
            provider="seqino",
            raise_for_status=False,
        )
    data = _response_json_dict(resp)
    onboarding_link_id, onboarding_url, expires_at = _extract_link(data)
    if resp.status_code >= 400 and not (onboarding_link_id and onboarding_url):
        seqino_raise_for_status(resp)
    if not onboarding_link_id:
        raise ValueError("mandate_id manquant dans la reponse plateforme partenaire.")
    if not onboarding_url:
        raise ValueError("onboarding_url manquante dans la reponse plateforme partenaire.")
    return {
        "link_id": onboarding_link_id,
        "mandate_id": onboarding_link_id,
        "onboarding_url": onboarding_url,
        "expires_at": expires_at,
        "payload": data or None,
    }


def _normalize_onboarding_status(raw: Any) -> str | None:
    value = _normalize_text(raw)
    if not value:
        return None
    key = value.upper()
    if key in {"ACTIVE", "APPROVED", "COMPLETED", "VALIDATED"}:
        return "ACTIVE"
    if key in {"PENDING", "IN_PROGRESS", "WAITING", "CREATED", "CASE_CREATED"}:
        return "PENDING"
    return key


async def fetch_onboarding_status(
    *,
    access_token: str,
    client_id: str,
    mandate_id: str | None = None,
    link_id: str | None = None,
    sponsor_id: str | None = None,
) -> dict[str, Any]:
    mandate = _normalize_text(mandate_id or link_id)
    if not mandate:
        raise ValueError("mandate_id requis pour recuperer le statut d'onboarding Seqino.")
    if _demo_mode():
        return {"status": "ACTIVE", "payload": {"status": "ACTIVE", "demo": True}}
    url = _endpoint("/clients/onboarding-link/status")
    params = {"mandate_id": mandate}
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "GET",
            url,
            params=params,
            headers=_headers(access_token, client_id=client_id, sponsor_id=sponsor_id),
            tenant_id=None,
            provider="seqino",
            raise_for_status=False,
        )
    data = _response_json_dict(resp)
    status = None
    if data:
        status = data.get("status") or data.get("state")
    normalized_status = _normalize_onboarding_status(status)
    if resp.status_code >= 400 and not normalized_status:
        seqino_raise_for_status(resp)
    return {
        "status": normalized_status,
        "payload": data or None,
    }


async def onboard_tenant(
    tenant: Any,
    *,
    access_token: str,
    contact_email: str,
    mandate_id: str,
    sponsor_id: str | None = None,
    existing_client_id: str | None = None,
    callback_url: str | None = None,
) -> dict[str, Any]:
    client_resp = await get_or_create_client(
        tenant,
        access_token=access_token,
        contact_email=contact_email,
        sponsor_id=sponsor_id,
        existing_client_id=existing_client_id,
    )
    client_id = client_resp["client_id"]
    client_payload = client_resp.get("payload")
    link_resp = await create_onboarding_link(
        tenant=tenant,
        access_token=access_token,
        client_id=client_id,
        mandate_id=mandate_id,
        sponsor_id=sponsor_id,
        callback_url=callback_url,
    )
    return {
        "client_id": client_id,
        "link_id": link_resp["link_id"],
        "mandate_id": link_resp["mandate_id"],
        "onboarding_url": link_resp["onboarding_url"],
        "expires_at": link_resp.get("expires_at"),
        "client_payload": client_payload,
        "link_payload": link_resp.get("payload"),
    }
