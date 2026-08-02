from __future__ import annotations

from typing import Any
from urllib.parse import urlparse, urlunparse
import time

import httpx

from ..config import settings
from ..utils.seqino_http import (
    SeqinoHttpError,
    seqino_error_from_exception,
    seqino_error_from_response,
    seqino_request_checked,
)
from ..utils.seqino_auth import normalize_seqino_authorization
from ..utils.ssrf import validate_outbound_url

_HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=5.0)
SEQINO_WEBHOOK_EVENT_TYPES = frozenset(
    {
        "webhook.test",
        "invoice.created",
        "invoice.received",
        "invoice.status_updated",
        "mandate.activated",
        "mandate.created",
        "mandate.expired",
        "mandate.failed",
        "mandate.revoked",
    }
)


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    return raw or None


def _raw_base_url() -> str:
    base_url = (settings.SEQINO_BASE_URL or "").strip().rstrip("/")
    if not base_url:
        raise ValueError("SEQINO_BASE_URL manquant.")
    return base_url


def _demo_mode() -> bool:
    return bool(getattr(settings, "SEQINO_DEMO_MODE", False))


def _seqino_root() -> str:
    base_url = _raw_base_url().rstrip("/")
    return validate_outbound_url(base_url)


def normalize_onboarding_url(raw_url: Any) -> str | None:
    url = _normalize_text(raw_url)
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return url
    if (parsed.hostname or "").lower() != "pdp.seqino.com":
        return url

    base = urlparse(_raw_base_url())
    base_host = (base.hostname or "").lower()
    if not base_host.endswith(".seqino.dev"):
        return url

    replacement_netloc = "pdp.seqino.dev" if base_host.startswith("pdp-api") else base.netloc
    return urlunparse((base.scheme or parsed.scheme, replacement_netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))


def seqino_access_token() -> str:
    raw = (settings.SEQINO_ACCESS_TOKEN or settings.SEQINO_API_KEY or "").strip()
    if not raw:
        raise ValueError("SEQINO_ACCESS_TOKEN manquant.")
    return raw


def seqino_sponsor_id() -> str | None:
    return _normalize_text(settings.SEQINO_SPONSOR_ID)


def normalize_onboarding_status(raw: Any) -> str | None:
    value = _normalize_text(raw)
    if not value:
        return None
    key = value.upper()
    if key in {"ACTIVE", "APPROVED", "COMPLETED", "VALIDATED"}:
        return "ACTIVE"
    if key in {"PENDING", "IN_PROGRESS", "WAITING", "CREATED", "CASE_CREATED"}:
        return "PENDING"
    return key


def _json_payload(resp: httpx.Response) -> Any:
    if resp.headers.get("content-type", "").startswith("application/json"):
        return resp.json()
    return None


def _extract_id(data: dict[str, Any] | None, keys: tuple[str, ...]) -> str | None:
    if not data:
        return None
    for key in keys:
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


def _validated_webhook_events(events: list[str] | tuple[str, ...] | None) -> list[str] | None:
    if events is None:
        return None
    normalized = [str(event).strip().lower() for event in events if str(event).strip()]
    unknown = sorted(set(normalized) - SEQINO_WEBHOOK_EVENT_TYPES)
    if unknown:
        raise ValueError(f"Types webhook Seqino inconnus: {', '.join(unknown)}")
    if not normalized:
        raise ValueError("Au moins un type d'evenement webhook Seqino est requis.")
    return list(dict.fromkeys(normalized))


def _validated_webhook_url(value: str) -> str:
    url = _normalize_text(value)
    if not url:
        raise ValueError("URL webhook Seqino requise.")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("URL webhook Seqino invalide.")
    if parsed.fragment:
        raise ValueError("L'URL webhook Seqino ne doit pas contenir de fragment.")
    env = (settings.APP_ENV or "").strip().lower()
    if env in {"prod", "production", "staging"} and parsed.scheme != "https":
        raise ValueError("L'URL webhook Seqino doit utiliser HTTPS en production.")
    return url


class SeqinoClient:
    def __init__(self, base_url: str, access_token: str, *, sponsor_id: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.access_token = access_token
        self.sponsor_id = sponsor_id

    @classmethod
    def from_settings(cls) -> "SeqinoClient":
        return cls(_seqino_root(), seqino_access_token(), sponsor_id=seqino_sponsor_id())

    @classmethod
    def from_credentials(
        cls,
        *,
        access_token: str,
        sponsor_id: str | None = None,
        base_url: str | None = None,
    ) -> "SeqinoClient":
        if base_url and base_url.strip():
            root = validate_outbound_url(base_url.strip().rstrip("/"))
        else:
            root = _seqino_root()
        return cls(root, access_token, sponsor_id=sponsor_id)

    def _endpoint(self, path: str) -> str:
        url = f"{self.base_url}/{path.lstrip('/')}"
        return validate_outbound_url(url)

    def _headers(self, client_id: str | None = None) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Authorization": normalize_seqino_authorization(self.access_token),
        }
        if client_id:
            headers["X-PDP-Client-Id"] = client_id
        if self.sponsor_id:
            headers["X-PDP-Sponsor-Id"] = self.sponsor_id
        return headers

    async def list_clients(self, *, tenant_id: str | None = None) -> list[dict[str, Any]]:
        url = self._endpoint("clients")
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "GET",
                url,
                headers=self._headers(),
                tenant_id=tenant_id,
                provider="seqino",
                raise_for_status=False,
            )
        if resp.status_code == 404:
            return []
        if resp.status_code >= 400:
            raise seqino_error_from_response(resp)
        payload = _json_payload(resp)
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            items = payload.get("items") or payload.get("clients") or payload.get("data")
            if isinstance(items, list):
                return items
        return []

    async def create_client(
        self,
        *,
        organization_name: str,
        contact_email: str,
        external_ref: str,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        url = self._endpoint("clients")
        payload = {
            "organization_name": organization_name,
            "contact_email": contact_email,
            "external_ref": external_ref,
        }
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "POST",
                url,
                json=payload,
                headers=self._headers(),
                tenant_id=tenant_id,
                provider="seqino",
            )
        data = _json_payload(resp)
        client_id = _extract_id(data if isinstance(data, dict) else None, ("client_id", "id"))
        if not client_id:
            raise ValueError("client_id manquant dans la reponse plateforme partenaire.")
        return {"client_id": client_id, "payload": data if isinstance(data, dict) else None}

    async def get_webhook(self, *, tenant_id: str | None = None) -> dict[str, Any] | None:
        url = self._endpoint("webhooks")
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "GET",
                url,
                headers=self._headers(),
                tenant_id=tenant_id,
                provider="seqino",
                raise_for_status=False,
            )
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            raise seqino_error_from_response(resp)
        data = _json_payload(resp)
        if not isinstance(data, dict):
            raise ValueError("Reponse de configuration webhook Seqino invalide.")
        return data

    async def create_webhook(
        self,
        *,
        webhook_url: str,
        events: list[str] | tuple[str, ...] | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"url": _validated_webhook_url(webhook_url)}
        normalized_events = _validated_webhook_events(events)
        if normalized_events is not None:
            payload["events"] = normalized_events
        url = self._endpoint("webhooks")
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "POST",
                url,
                json=payload,
                headers=self._headers(),
                tenant_id=tenant_id,
                provider="seqino",
                raise_for_status=False,
            )
        if resp.status_code >= 400:
            raise seqino_error_from_response(resp)
        data = _json_payload(resp)
        if not isinstance(data, dict) or not _normalize_text(data.get("secret")):
            raise ValueError("Secret absent de la reponse de creation webhook Seqino.")
        return data

    async def update_webhook(
        self,
        *,
        webhook_url: str | None = None,
        events: list[str] | tuple[str, ...] | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if webhook_url is not None:
            payload["url"] = _validated_webhook_url(webhook_url)
        if events is not None:
            payload["events"] = _validated_webhook_events(events)
        if not payload:
            raise ValueError("Aucune modification webhook Seqino fournie.")
        url = self._endpoint("webhooks")
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "PATCH",
                url,
                json=payload,
                headers=self._headers(),
                tenant_id=tenant_id,
                provider="seqino",
                raise_for_status=False,
            )
        if resp.status_code >= 400:
            raise seqino_error_from_response(resp)
        data = _json_payload(resp)
        if not isinstance(data, dict):
            raise ValueError("Reponse de mise a jour webhook Seqino invalide.")
        return data

    async def delete_webhook(self, *, tenant_id: str | None = None) -> bool:
        url = self._endpoint("webhooks")
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "DELETE",
                url,
                headers=self._headers(),
                tenant_id=tenant_id,
                provider="seqino",
                raise_for_status=False,
            )
        if resp.status_code == 404:
            return False
        if resp.status_code >= 400:
            raise seqino_error_from_response(resp)
        return True

    async def test_webhook(self, *, tenant_id: str | None = None) -> dict[str, Any]:
        url = self._endpoint("webhooks/test")
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "POST",
                url,
                headers=self._headers(),
                tenant_id=tenant_id,
                provider="seqino",
                raise_for_status=False,
            )
        if resp.status_code >= 400:
            raise seqino_error_from_response(resp)
        data = _json_payload(resp)
        return data if isinstance(data, dict) else {"ok": True}

    async def create_onboarding_link(
        self,
        *,
        client_id: str,
        mandate_id: str,
        callback_url: str | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        mandate = _normalize_text(mandate_id)
        if not mandate:
            raise ValueError("mandate_id requis pour generer le lien d'onboarding Seqino.")
        url = self._endpoint("clients/onboarding-link")
        _ = callback_url
        payload = {"mandate_id": mandate}
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "POST",
                url,
                json=payload,
                headers=self._headers(client_id=client_id),
                tenant_id=tenant_id,
                provider="seqino",
            )
        data = _json_payload(resp)
        link_id = _extract_id(data if isinstance(data, dict) else None, ("mandate_id", "mandateId", "id"))
        if not link_id:
            link_id = _extract_id(data if isinstance(data, dict) else None, ("link_id", "onboarding_link_id"))
        onboarding_url = None
        expires_at = None
        if isinstance(data, dict):
            onboarding_url = data.get("onboarding_url") or data.get("url")
            expires_at = data.get("expires_at") or data.get("expiresAt")
        if not link_id:
            raise ValueError("mandate_id manquant dans la reponse plateforme partenaire.")
        if not onboarding_url:
            raise ValueError("onboarding_url manquante dans la reponse plateforme partenaire.")
        return {
            "link_id": link_id,
            "mandate_id": link_id,
            "onboarding_url": str(normalize_onboarding_url(onboarding_url) or onboarding_url),
            "expires_at": str(expires_at) if expires_at else None,
            "payload": data if isinstance(data, dict) else None,
        }

    async def get_onboarding_status(
        self,
        *,
        client_id: str,
        mandate_id: str | None = None,
        link_id: str | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        mandate = _normalize_text(mandate_id or link_id)
        if not mandate:
            raise ValueError("mandate_id requis pour recuperer le statut d'onboarding Seqino.")
        url = self._endpoint("clients/onboarding-link/status")
        params = {"mandate_id": mandate}
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "GET",
                url,
                params=params,
                headers=self._headers(client_id=client_id),
                tenant_id=tenant_id,
                provider="seqino",
            )
        data = _json_payload(resp)
        status = None
        if isinstance(data, dict):
            status = data.get("status") or data.get("state")
        return {
            "status": normalize_onboarding_status(status),
            "payload": data if isinstance(data, dict) else None,
        }

    async def ping(self, *, tenant_id: str | None = None) -> dict[str, Any]:
        if _demo_mode():
            return {"ok": True, "latency_ms": 0, "demo": True}
        candidates = ("health", "version")
        last_error = None
        for path in candidates:
            url = self._endpoint(path)
            started = time.monotonic()
            try:
                async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
                    resp = await seqino_request_checked(
                        client,
                        "GET",
                        url,
                        headers=self._headers(),
                        tenant_id=tenant_id,
                        provider="seqino",
                        raise_for_status=False,
                    )
                latency_ms = int((time.monotonic() - started) * 1000)
            except SeqinoHttpError as exc:
                return {
                    "ok": False,
                    "latency_ms": int((time.monotonic() - started) * 1000),
                    "error": str(exc),
                    "code": exc.code,
                }
            except httpx.RequestError as exc:
                err = seqino_error_from_exception(exc)
                return {
                    "ok": False,
                    "latency_ms": int((time.monotonic() - started) * 1000),
                    "error": str(err),
                    "code": err.code,
                }

            status_code = resp.status_code
            if status_code == 404:
                last_error = "Service de la plateforme agréée indisponible."
                continue
            if status_code in {401, 403}:
                err = seqino_error_from_response(resp)
                return {"ok": False, "latency_ms": latency_ms, "error": str(err), "code": err.code}
            if status_code >= 400:
                err = seqino_error_from_response(resp)
                return {"ok": False, "latency_ms": latency_ms, "error": str(err), "code": err.code}
            return {
                "ok": True,
                "latency_ms": latency_ms,
            }
        return {
            "ok": False,
            "error": last_error or "Service de la plateforme agréée indisponible.",
            "code": "seqino_not_ready",
        }
