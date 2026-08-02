from __future__ import annotations

import calendar
from datetime import date
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
        raise ValueError("SEQINO_BASE_URL manquant pour l'usage plateforme partenaire.")
    return validate_outbound_url(base_url)


def _endpoint(path: str) -> str:
    url = f"{_base_url()}/{path.lstrip('/')}"
    return validate_outbound_url(url)


def _headers(access_token: str, *, sponsor_id: str, client_id: str | None = None) -> dict[str, str]:
    token = (access_token or "").strip()
    if not token:
        raise ValueError("Token plateforme partenaire manquant.")
    sponsor = (sponsor_id or "").strip()
    if not sponsor:
        raise ValueError("Sponsor plateforme partenaire manquant.")
    headers = {
        "Accept": "application/json",
        "Authorization": normalize_seqino_authorization(token),
        "X-PDP-Sponsor-Id": sponsor,
    }
    if client_id:
        headers["X-PDP-Client-Id"] = client_id
    return headers


def _month_bounds(period: str) -> tuple[str, str]:
    year_str, month_str = period.split("-", 1)
    year = int(year_str)
    month = int(month_str)
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, 1).isoformat(), date(year, month, last_day).isoformat()


def _usage_metrics_params(period: str | None) -> dict[str, str]:
    raw = (period or "").strip()
    if not raw:
        return {"period": "monthly"}
    if raw in {"daily", "weekly", "monthly", "yearly"}:
        return {"period": raw}
    if len(raw) >= 7 and raw[4] == "-" and raw[:4].isdigit() and raw[5:7].isdigit():
        start_date, end_date = _month_bounds(raw[:7])
        return {"period": "monthly", "start_date": start_date, "end_date": end_date}
    return {"period": raw}


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    return raw or None


def extract_client_id(item: dict[str, Any]) -> str | None:
    raw = (
        item.get("client_id")
        or item.get("clientId")
        or item.get("company_id")
        or item.get("companyId")
        or item.get("client")
        or item.get("id")
    )
    if isinstance(raw, dict):
        raw = raw.get("id") or raw.get("client_id") or raw.get("clientId")
    return _normalize_text(raw)


def _extract_items(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict):
        for key in ("items", "clients", "usage", "results", "data"):
            raw_items = data.get(key)
            if isinstance(raw_items, list):
                return [item for item in raw_items if isinstance(item, dict)]
        if extract_client_id(data):
            return [data]
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


async def fetch_usage_summary(
    *,
    access_token: str,
    sponsor_id: str,
    client_id: str | None = None,
    period: str | None = None,
) -> list[dict[str, Any]]:
    client_id_value = _normalize_text(client_id)
    if not client_id_value:
        raise ValueError("Client plateforme partenaire manquant pour l'usage.")
    url = _endpoint("/usage/metrics")
    params = _usage_metrics_params(period)
    async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
        resp = await seqino_request_checked(
            client,
            "GET",
            url,
            params=params,
            headers=_headers(access_token, sponsor_id=sponsor_id, client_id=client_id_value),
            tenant_id=None,
            provider="seqino",
        )
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else None
    items = _extract_items(data)
    for item in items:
        item.setdefault("client_id", client_id_value)
    return items
