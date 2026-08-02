from __future__ import annotations

from typing import Any

import httpx

from ..config import settings
from ..utils.seqino_http import seqino_request_checked
from ..utils.seqino_auth import normalize_seqino_authorization
from ..utils.ssrf import validate_outbound_url


_HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=5.0)


def _base_url() -> str:
    base_url = (settings.SEQINO_BASE_URL or "").strip().rstrip("/")
    if not base_url:
        raise ValueError("SEQINO_BASE_URL manquant pour la periodicite plateforme partenaire.")
    return validate_outbound_url(base_url)


def _endpoint(path: str) -> str:
    url = f"{_base_url()}/{path.lstrip('/')}"
    return validate_outbound_url(url)


def _headers(access_token: str, *, sponsor_id: str, client_id: str) -> dict[str, str]:
    raw = (access_token or "").strip()
    if not raw:
        raise ValueError("Token plateforme partenaire manquant.")
    sponsor = (sponsor_id or "").strip()
    if not sponsor:
        raise ValueError("Sponsor plateforme partenaire manquant.")
    client = (client_id or "").strip()
    if not client:
        raise ValueError("client_id plateforme partenaire manquant.")
    headers = {
        "Accept": "application/json",
        "Authorization": normalize_seqino_authorization(raw),
        "X-PDP-Sponsor-Id": sponsor,
        "X-PDP-Client-Id": client,
    }
    return headers


def _normalize_payload(payload: dict[str, Any]) -> dict[str, str]:
    if not isinstance(payload, dict):
        raise ValueError("Payload de periodicite invalide.")
    normalized: dict[str, str] = {}
    missing: list[str] = []
    for key in ("vat_regime", "transaction_periodicity", "payment_periodicity"):
        raw = payload.get(key)
        value = (str(raw).strip() if raw is not None else "")
        if not value:
            missing.append(key)
            continue
        normalized[key] = value
    if missing:
        raise ValueError(f"Champs periodicite manquants: {', '.join(missing)}")
    return normalized


async def sync_periodicity(
    payload: dict[str, Any],
    *,
    access_token: str,
    sponsor_id: str,
    client_id: str,
    tenant_id: str | None = None,
) -> tuple[dict[str, Any] | None, int]:
    url = _endpoint("/settings/periodicity")
    normalized_payload = _normalize_payload(payload)
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "PUT",
            url,
            json=normalized_payload,
            headers=_headers(access_token, sponsor_id=sponsor_id, client_id=client_id),
            tenant_id=tenant_id,
            provider="seqino",
        )
    status_code = resp.status_code
    if resp.headers.get("content-type", "").startswith("application/json"):
        try:
            return resp.json(), status_code
        except Exception:
            return None, status_code
    return None, status_code
