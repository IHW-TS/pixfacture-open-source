from __future__ import annotations

import base64
from typing import Any

import httpx

from .base import PlatformConnector
from ..storage import get_object_bytes
from ...utils.pdp_outbound import httpx_request_with_log, tenant_id_from_credentials
from ...utils.ssrf import validate_outbound_url


_STATUS_MAP = {
    "accepted": "accepted",
    "delivered": "accepted",
    "done": "accepted",
    "ok": "accepted",
    "rejected": "rejected",
    "refused": "rejected",
    "error": "failed",
    "failed": "failed",
    "processing": "processing",
    "pending": "processing",
    "queued": "submitted",
    "submitted": "submitted",
}

_HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=5.0)


def _normalize_status(value: str | None) -> str:
    if not value:
        return "unknown"
    key = value.strip().lower()
    return _STATUS_MAP.get(key, "unknown")


def _extract_external_id(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    for key in ("external_id", "id", "submission_id", "uuid", "reference"):
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


class HttpGenericPlatform(PlatformConnector):
    slug = "http_generic"
    label = "B2B (PA)"
    description = "Connecteur HTTP generique pour plateforme agréée (PA)."
    kind = "b2b"
    auth_type = "api_key"
    credential_fields = [
        {
            "key": "base_url",
            "label": "URL base",
            "required": True,
            "placeholder": "https://api.example.com",
        },
        {
            "key": "api_key",
            "label": "Clé API",
            "required": False,
            "secret": True,
            "placeholder": "...",
        },
        {
            "key": "api_key_header",
            "label": "Header clé API",
            "required": False,
            "placeholder": "X-API-Key",
        },
        {
            "key": "submit_path",
            "label": "Chemin submit",
            "required": False,
            "placeholder": "submit",
        },
        {
            "key": "status_path",
            "label": "Chemin status",
            "required": False,
            "placeholder": "status/{external_id}",
        },
    ]

    def _base_url(self) -> str:
        base_url = (self.credentials.get("base_url") or "").rstrip("/")
        if not base_url:
            raise ValueError("base_url manquant pour le connecteur http_generic")
        return validate_outbound_url(base_url)

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        api_key = self.credentials.get("api_key")
        if api_key:
            header_name = str(self.credentials.get("api_key_header") or "X-API-Key")
            header_value = str(api_key)
            if header_name.lower() == "authorization" and not header_value.lower().startswith("bearer "):
                header_value = f"Bearer {header_value}"
            headers[header_name] = header_value
        return headers

    async def submit_invoice(self, invoice: Any, ctx: dict | None = None) -> str:
        pdf_key = getattr(invoice, "pdf_key", None)
        xml_key = getattr(invoice, "xml_key", None)
        pdf_bytes = get_object_bytes(pdf_key) if pdf_key else None
        xml_bytes = get_object_bytes(xml_key) if xml_key else None
        if not pdf_bytes or not xml_bytes:
            raise ValueError("Artefacts d'emission manquants.")

        submit_path = (self.credentials.get("submit_path") or "submit").lstrip("/")
        url = f"{self._base_url()}/{submit_path}"
        url = validate_outbound_url(url)
        tenant_id = tenant_id_from_credentials(self.credentials)
        correlation_id = getattr(invoice, "id", None)
        payload = {
            "pdf": base64.b64encode(pdf_bytes).decode("ascii"),
            "xml": base64.b64encode(xml_bytes).decode("ascii"),
            "metadata": {
                "invoice_id": getattr(invoice, "id", None),
                "invoice_number": getattr(invoice, "number", None),
            },
        }
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await httpx_request_with_log(
                client,
                "POST",
                url,
                json=payload,
                headers=self._headers(),
                tenant_id=tenant_id,
                correlation_id=correlation_id,
                provider=self.slug,
            )
        resp.raise_for_status()
        try:
            data = resp.json()
        except Exception:
            data = None
        external_id = _extract_external_id(data)
        return external_id or ""

    async def get_status(self, external_id: str) -> str:
        status_path = (self.credentials.get("status_path") or "status/{external_id}").lstrip("/")
        path = status_path.replace("{external_id}", external_id)
        url = f"{self._base_url()}/{path}"
        url = validate_outbound_url(url)
        tenant_id = tenant_id_from_credentials(self.credentials)
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await httpx_request_with_log(
                client,
                "GET",
                url,
                headers=self._headers(),
                tenant_id=tenant_id,
                correlation_id=external_id,
                provider=self.slug,
            )
        resp.raise_for_status()
        try:
            data = resp.json()
        except Exception:
            data = None
        status_value = None
        if isinstance(data, dict):
            status_value = data.get("status") or data.get("state") or data.get("result") or data.get("message")
        elif isinstance(data, str):
            status_value = data
        return _normalize_status(str(status_value) if status_value is not None else None)
