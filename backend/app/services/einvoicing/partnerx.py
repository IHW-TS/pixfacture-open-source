from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from .base import EInvoicingConnector
from .utils import normalize_status
from ..facturx import facturx_from_pdf_xml, facturx_pdf
from ..storage import get_object_bytes
from ...config import settings
from ...utils.ssrf import validate_outbound_url


class PartnerXConnector(EInvoicingConnector):
    slug = "partnerx"

    @classmethod
    def credential_fields(cls) -> list[dict[str, Any]]:
        return [
            {
                "key": "api_key",
                "label": "Clé API",
                "required": True,
                "secret": True,
                "placeholder": "...",
            }
        ]

    def _base_url(self) -> str:
        base_url = (settings.PARTNERX_BASE_URL or "").strip()
        return base_url.rstrip("/")

    def _endpoint_url(self, path: str) -> str:
        base_url = self._base_url()
        if not base_url:
            raise ValueError("PARTNERX_BASE_URL manquant.")
        return validate_outbound_url(f"{base_url}{path}")

    def _headers(self) -> dict[str, str]:
        api_key = (self.credentials or {}).get("api_key") or ""
        if not api_key:
            return {}
        return {"Authorization": f"Bearer {api_key}"}

    def _facturx_pdf_bytes(self, invoice: Any, ctx: dict | None = None) -> bytes:
        facturx_key = getattr(invoice, "facturx_key", None)
        if facturx_key:
            pdf_bytes = get_object_bytes(facturx_key)
            if pdf_bytes:
                return pdf_bytes
        pdf_key = getattr(invoice, "pdf_key", None)
        xml_key = getattr(invoice, "xml_key", None)
        if pdf_key and xml_key:
            issued_pdf = get_object_bytes(pdf_key)
            issued_xml = get_object_bytes(xml_key)
            if issued_pdf and issued_xml:
                return facturx_from_pdf_xml(
                    issued_pdf,
                    issued_xml,
                    getattr(invoice, "issued_profile", None),
                )
        if ctx is not None:
            return facturx_pdf(ctx)
        raise ValueError("PDF Factur-X indisponible pour la soumission.")

    async def test_connection(self) -> dict[str, Any]:
        base_url = self._base_url()
        if not base_url:
            return {"ok": False, "message": "PARTNERX_BASE_URL manquant."}
        try:
            url = self._endpoint_url("/ping")
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                res = await client.get(url, headers=self._headers())
            if 200 <= res.status_code < 300:
                return {"ok": True, "message": "Connexion PartnerX OK."}
            return {
                "ok": False,
                "message": f"Echec ping PartnerX (HTTP {res.status_code}).",
            }
        except Exception:
            return {"ok": False, "message": "Echec ping PartnerX."}

    async def submit(self, invoice: Any, ctx: dict | None = None) -> str:
        base_url = self._base_url()
        if not base_url:
            raise ValueError("PARTNERX_BASE_URL manquant.")

        pdf_bytes = self._facturx_pdf_bytes(invoice, ctx)
        url = self._endpoint_url("/invoices")
        metadata = {
            "invoice_number": getattr(invoice, "number", None),
            "seller_id": (ctx or {}).get("supplier", {}).get("legal_id"),
            "buyer_id": (ctx or {}).get("customer", {}).get("legal_id"),
        }
        files = {
            "file": (
                f"{getattr(invoice, 'number', 'invoice')}.pdf",
                pdf_bytes,
                "application/pdf",
            )
        }
        async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
            res = await client.post(
                url,
                headers=self._headers(),
                data={k: v for k, v in metadata.items() if v},
                files=files,
            )
        res.raise_for_status()
        data = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
        submission_id = (
            data.get("submission_id")
            or data.get("id")
            or data.get("uuid")
            or data.get("external_id")
        )
        if not submission_id:
            raise ValueError("PartnerX: submission_id manquant.")
        return str(submission_id)

    async def get_status(self, submission_id: str) -> str:
        base_url = self._base_url()
        if not base_url:
            return "unknown"
        safe_submission_id = quote(str(submission_id), safe="")
        url = self._endpoint_url(f"/invoices/{safe_submission_id}")
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            res = await client.get(url, headers=self._headers())
        res.raise_for_status()
        payload = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
        status_raw = payload.get("status") or payload.get("state") or payload.get("code")
        return normalize_status(str(status_raw) if status_raw is not None else None)

    async def list_events(self, submission_id: str) -> list[dict[str, Any]]:
        base_url = self._base_url()
        if base_url:
            safe_submission_id = quote(str(submission_id), safe="")
            url = self._endpoint_url(f"/invoices/{safe_submission_id}/events")
            try:
                async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                    res = await client.get(url, headers=self._headers())
                if 200 <= res.status_code < 300:
                    payload = res.json() if res.headers.get("content-type", "").startswith("application/json") else None
                    if isinstance(payload, list):
                        return payload
            except Exception:
                pass
        status = await self.get_status(submission_id)
        return [{"status": status, "message": "Statut consolide"}]
