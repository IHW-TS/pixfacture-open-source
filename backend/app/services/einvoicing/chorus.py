from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx

from .base import EInvoicingConnector
from .utils import normalize_status
from ..chorus import ChorusClient, extract_chorus_external_id
from ..chorus_facturx import chorus_fso1117a_pdf_async, chorus_invoice_filename
from ..storage import get_object_bytes
from ...utils.pdp_errors import PdpPreSubmitCancelled, PdpProviderError


class ChorusProConnector(EInvoicingConnector):
    slug = "choruspro"

    @classmethod
    def credential_fields(cls) -> list[dict[str, Any]]:
        return []

    async def submit(self, invoice: Any, ctx: dict | None = None) -> str:
        if invoice is None:
            raise ValueError("invoice manquante")

        pdf_bytes = None
        facturx_key = getattr(invoice, "facturx_key", None)
        issued_facturx = get_object_bytes(facturx_key) if facturx_key else None
        pdf_key = getattr(invoice, "pdf_key", None)
        xml_key = getattr(invoice, "xml_key", None)
        issued_pdf = get_object_bytes(pdf_key) if pdf_key else None
        issued_xml = get_object_bytes(xml_key) if xml_key else None
        if issued_facturx and issued_pdf and issued_xml:
            try:
                pdf_bytes = await chorus_fso1117a_pdf_async(issued_pdf, issued_xml)
            except asyncio.CancelledError as exc:
                raise PdpPreSubmitCancelled from exc
        if not pdf_bytes:
            raise ValueError("Artefacts d'émission requis pour préparer le dépôt Chorus.")

        client = ChorusClient()
        filename = chorus_invoice_filename(getattr(invoice, "number", None))
        res = await client.submit_multipart(
            file_bytes=pdf_bytes,
            filename=filename,
            content_type="application/pdf",
        )

        external_id = extract_chorus_external_id(res)
        if external_id:
            return external_id

        raise PdpProviderError(
            "Chorus a accepté la requête mais n'a pas retourné d'identifiant de flux exploitable.",
            code="chorus_external_id_missing",
            retryable=False,
            submission_outcome="unknown",
        )

    async def get_status(self, submission_id: str) -> str:
        client = ChorusClient()
        raw = await client.get_status(submission_id)
        status_value = None
        if isinstance(raw, dict):
            status_value = (
                raw.get("status")
                or raw.get("etat")
                or raw.get("state")
                or raw.get("statut")
                or raw.get("codeEtat")
            )
        elif isinstance(raw, str):
            status_value = raw
        return normalize_status(str(status_value) if status_value is not None else None)

    async def list_events(self, submission_id: str) -> list[dict[str, Any]]:
        status = await self.get_status(submission_id)
        now = datetime.now(timezone.utc).isoformat()
        return [
            {
                "at": now,
                "status": status,
                "message": "Statut Chorus consolide",
            }
        ]

    async def test_connection(self) -> dict[str, Any]:
        client = ChorusClient()
        if not client.client_id or not client.client_secret or not client.token_url:
            return {
                "ok": False,
                "message": "Cette connexion Chorus Pro n’est pas encore configurée. Contactez l’assistance.",
            }
        try:
            await client._token()
        except httpx.HTTPStatusError as exc:
            return {
                "ok": False,
                "message": f"Echec authentification PISTE (HTTP {exc.response.status_code}).",
            }
        except Exception:
            return {
                "ok": False,
                "message": "Echec authentification PISTE.",
            }
        return {"ok": True, "message": "Authentification PISTE OK."}
