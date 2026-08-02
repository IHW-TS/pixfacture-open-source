from __future__ import annotations

import asyncio
import re
import unicodedata
from typing import Any

import httpx

from .base import PlatformConnector
from ..einvoicing.lifecycle import LifecycleStatus
from ..chorus import (
    ChorusClient,
    chorus_cpro_account_is_valid,
    configured_syntaxe_flux,
    extract_chorus_external_id,
)
from ..chorus_facturx import chorus_fso1117a_pdf_async, chorus_invoice_filename
from ..storage import get_object_bytes
from ...utils.pdp_errors import PdpPreSubmitCancelled, PdpProviderError


_STATUS_MAP = {
    # consulterCR / consulterCRDetaille report the *technical flow* state.
    # Do not turn invoice business states (mandated, booked, put in payment,
    # service performed) into an accepted invoice lifecycle state.
    "integre": LifecycleStatus.AVAILABLE.value,
    "in_integre": LifecycleStatus.AVAILABLE.value,
    "integration_reussie": LifecycleStatus.AVAILABLE.value,
    "integre_partiel": LifecycleStatus.PROCESSING.value,
    "integre_partiellement": LifecycleStatus.PROCESSING.value,
    "in_integre_partiel": LifecycleStatus.PROCESSING.value,
    "processing": LifecycleStatus.PROCESSING.value,
    "pending": LifecycleStatus.PROCESSING.value,
    "en_cours": LifecycleStatus.PROCESSING.value,
    "en_cours_d_integration": LifecycleStatus.PROCESSING.value,
    "in_en_cours": LifecycleStatus.PROCESSING.value,
    "in_en_cours_integration": LifecycleStatus.PROCESSING.value,
    "depose": LifecycleStatus.SUBMITTED.value,
    "deposee": LifecycleStatus.SUBMITTED.value,
    "recu": LifecycleStatus.SUBMITTED.value,
    "in_recu": LifecycleStatus.SUBMITTED.value,
    "in_traite_se_cpp": LifecycleStatus.PROCESSING.value,
    "in_en_attente_traitement_cpp": LifecycleStatus.PROCESSING.value,
    "in_en_cours_traitement_cpp": LifecycleStatus.PROCESSING.value,
    "in_en_attente_retraitement_cpp": LifecycleStatus.PROCESSING.value,
    "in_incidente": LifecycleStatus.FAILED.value,
    "rejete": LifecycleStatus.REJECTED.value,
    "rejetee": LifecycleStatus.REJECTED.value,
    "in_rejete": LifecycleStatus.REJECTED.value,
    "error": LifecycleStatus.FAILED.value,
    "failed": LifecycleStatus.FAILED.value,
    "erreur": LifecycleStatus.FAILED.value,
}


def _status_key(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "_", ascii_value.lower()).strip("_")


def _normalize_status(value: str | None) -> str:
    if not value:
        return LifecycleStatus.UNKNOWN.value
    return _STATUS_MAP.get(_status_key(value), LifecycleStatus.UNKNOWN.value)


class ChorusProPlatform(PlatformConnector):
    slug = "choruspro"
    label = "B2G (canal public)"
    description = "Connecteur canal public via PISTE."
    kind = "b2g"
    auth_type = "oauth"
    credential_fields: list[dict[str, Any]] = []
    requires_sanity_checks = True

    def _client(self) -> ChorusClient:
        creds = self.credentials or {}
        return ChorusClient(
            client_id=creds.get("piste_client_id"),
            client_secret=creds.get("piste_client_secret"),
            token_url=creds.get("piste_token_url"),
            api_base=creds.get("chorus_api_base"),
            submit_path=creds.get("chorus_submit_path"),
            status_path=creds.get("chorus_status_path"),
            cpro_account=creds.get("chorus_cpro_account"),
        )

    async def submit_invoice(self, invoice: Any, ctx: dict | None = None) -> str:
        facturx_key = getattr(invoice, "facturx_key", None)
        issued_facturx = get_object_bytes(facturx_key) if facturx_key else None
        pdf_key = getattr(invoice, "pdf_key", None)
        xml_key = getattr(invoice, "xml_key", None)
        issued_pdf = get_object_bytes(pdf_key) if pdf_key else None
        issued_xml = get_object_bytes(xml_key) if xml_key else None
        if not issued_facturx or not issued_pdf or not issued_xml:
            raise PdpProviderError(
                "Artefact Factur-X émis introuvable. Régénérez les artefacts avant transmission.",
                code="artifact_integrity_error",
                retryable=False,
            )
        try:
            pdf_bytes = await chorus_fso1117a_pdf_async(issued_pdf, issued_xml)
        except asyncio.CancelledError as exc:
            # The unsafe Chorus POST is strictly after packaging.
            raise PdpPreSubmitCancelled from exc

        client = self._client()
        filename = chorus_invoice_filename(getattr(invoice, "number", None))
        res = await client.submit_multipart(
            file_bytes=pdf_bytes,
            filename=filename,
            content_type="application/pdf",
            idempotency_key=(ctx or {}).get("idempotency_key"),
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

    async def get_status(self, external_id: str) -> str:
        client = self._client()
        try:
            raw = await client.get_status(external_id)
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code == 403:
                raise PdpProviderError(
                    "Statut Chorus interdit: droits insuffisants ou identifiant hors périmètre.",
                    code="chorus_status_forbidden",
                ) from exc
            if status_code == 404:
                raise PdpProviderError(
                    "Statut Chorus introuvable pour cette transmission.",
                    code="chorus_status_not_found",
                ) from exc
            retryable = status_code in {408, 425, 429, 500, 502, 503, 504}
            raise PdpProviderError(
                f"Erreur statut Chorus (HTTP {status_code or 'inconnu'}).",
                code="chorus_status_failed",
                retryable=retryable,
            ) from exc
        status_value = raw.get("etatCourantDepotFlux") if isinstance(raw, dict) else raw
        return _normalize_status(str(status_value) if status_value is not None else None)

    async def get_status_details(self, external_id: str) -> dict[str, Any]:
        """Return a normalized flow report without raw Chorus payload data."""

        raw = await self._client().get_status(external_id)
        raw_status = raw.get("etatCourantDepotFlux") if isinstance(raw, dict) else None
        errors = raw.get("errors") if isinstance(raw, dict) else None
        return {
            "status": _normalize_status(str(raw_status) if raw_status is not None else None),
            "raw_status": str(raw_status) if raw_status is not None else None,
            "errors": [str(item)[:300] for item in errors[:10]] if isinstance(errors, list) else [],
            "message": (str(errors[0])[:300] if isinstance(errors, list) and errors else "Statut de flux Chorus synchronisé."),
        }

    @staticmethod
    def _missing_server_config(client: ChorusClient) -> list[str]:
        missing: list[str] = []
        if not client.client_id.strip():
            missing.append("PISTE_CLIENT_ID")
        if not client.client_secret.strip():
            missing.append("PISTE_CLIENT_SECRET")
        if not client.token_url.strip():
            missing.append("PISTE_TOKEN_URL")
        if not client.api_base.strip():
            missing.append("CHORUS_API_BASE")
        if not client.submit_path.strip():
            missing.append("CHORUS_SUBMIT_PATH")
        if not client.status_path.strip():
            missing.append("CHORUS_STATUS_PATH")
        if not chorus_cpro_account_is_valid(client.cpro_account):
            missing.append("CHORUS_CPRO_ACCOUNT")
        if not configured_syntaxe_flux():
            missing.append("CHORUS_SUBMIT_EXTRA_JSON.syntaxeFlux")
        return missing

    def missing_server_config(self) -> list[str]:
        client = self._client()
        return self._missing_server_config(client)

    async def test_connection(self) -> dict[str, Any]:
        client = self._client()
        missing = self._missing_server_config(client)
        if missing:
            return {
                "ok": False,
                "message": "Cette connexion n’est pas encore configurée. Contactez l’assistance.",
            }
        try:
            await client._token()
        except httpx.HTTPStatusError as exc:
            return {
                "ok": False,
                "message": f"Echec authentification PISTE (HTTP {exc.response.status_code}).",
            }
        except PdpProviderError as exc:
            return {"ok": False, "message": str(exc), "code": exc.code}
        except Exception:
            return {"ok": False, "message": "Echec authentification PISTE."}
        return {"ok": True, "message": "Authentification PISTE OK."}
