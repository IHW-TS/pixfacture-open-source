from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

import httpx

from ...platforms.http_generic import HttpGenericPlatform as _LegacyHttpGeneric
from ... import rate_limit
from ..base import (
    EReportingEvent,
    EReportingLinePayload,
    EReportingReportPayload,
    InboundMessage,
    PdpProvider,
    StatusResult,
    TransmissionResult,
)
from ..utils import normalize_status
from ...storage import get_object_bytes
from ....config import settings
from ....utils.pdp_outbound import httpx_request_with_log, tenant_id_from_credentials
from ....utils.ssrf import validate_outbound_url


_HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=5.0)
_DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
_DEFAULT_RATE_LIMIT_COUNT = 60
_DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60


class HttpGenericPayloadTooLargeError(ValueError):
    code = "http_generic_payload_too_large"


class HttpGenericRateLimitError(ValueError):
    code = "http_generic_rate_limited"


def _max_payload_bytes() -> int:
    limit = int(getattr(settings, "HTTP_GENERIC_MAX_PAYLOAD_BYTES", 0) or 0)
    if limit <= 0:
        return _DEFAULT_MAX_PAYLOAD_BYTES
    return limit


def _rate_limit_settings() -> tuple[int, int]:
    limit = int(getattr(settings, "HTTP_GENERIC_RATE_LIMIT_COUNT", 0) or 0)
    window = int(getattr(settings, "HTTP_GENERIC_RATE_LIMIT_WINDOW_SECONDS", 0) or 0)
    if limit <= 0:
        limit = _DEFAULT_RATE_LIMIT_COUNT
    if window <= 0:
        window = _DEFAULT_RATE_LIMIT_WINDOW_SECONDS
    return limit, window


def _enforce_payload_limit(size_bytes: int) -> None:
    max_bytes = _max_payload_bytes()
    if size_bytes > max_bytes:
        raise HttpGenericPayloadTooLargeError(
            f"Payload trop volumineux pour http_generic (taille={size_bytes}, limite={max_bytes})."
        )


def _enforce_rate_limit(tenant_id: str | None) -> None:
    limit, window = _rate_limit_settings()
    key = f"pdp:http_generic:submit:{tenant_id or 'unknown'}"
    if rate_limit.hit(key, limit, window):
        raise HttpGenericRateLimitError(
            "Limite de soumissions depassee pour http_generic. Reessayez plus tard."
        )


def _estimate_payload_bytes(payload: dict[str, Any]) -> int:
    try:
        encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str).encode("utf-8")
    except Exception:
        return 0
    return len(encoded)


def _extract_external_id(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    for key in ("external_id", "id", "submission_id", "uuid", "reference"):
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


def _extract_status_value(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    return data.get("status") or data.get("state") or data.get("result") or data.get("message")


def _extract_errors(data: dict[str, Any] | None) -> list[str] | None:
    if not data:
        return None
    raw = data.get("errors") or data.get("error") or data.get("detail")
    if raw is None:
        return None
    if isinstance(raw, list):
        return [str(item) for item in raw if item is not None]
    return [str(raw)]


def _decode_messages(data: Any) -> list[InboundMessage]:
    messages: list[InboundMessage] = []
    if isinstance(data, dict):
        items = data.get("messages") or data.get("items") or []
    else:
        items = data if isinstance(data, list) else []
    for item in items:
        if not isinstance(item, dict):
            continue
        message_id = str(item.get("id") or item.get("message_id") or item.get("uuid") or "")
        if not message_id:
            continue
        messages.append(
            InboundMessage(
                message_id=message_id,
                payload=item.get("payload") if isinstance(item.get("payload"), dict) else None,
                received_at=item.get("received_at") or item.get("timestamp"),
                raw=item,
                source=item.get("source") if isinstance(item.get("source"), str) else None,
                cursor=item.get("cursor") if isinstance(item.get("cursor"), str) else None,
            )
        )
    return messages


def _event_payload(event: EReportingEvent) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": event.event_type}
    if event.amounts is not None:
        payload["amounts"] = event.amounts
    if event.payment_date is not None:
        payload["payment_date"] = event.payment_date.isoformat()
    if event.country is not None:
        payload["country"] = event.country
    if event.client_country is not None:
        payload["client_country"] = event.client_country
    if event.client_vat_number is not None:
        payload["client_vat_number"] = event.client_vat_number
    if event.client_type is not None:
        payload["client_type"] = event.client_type
    if event.metadata:
        payload["metadata"] = event.metadata
    return payload


def _line_payload(line: EReportingLinePayload) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": line.event_type}
    if line.line_id is not None:
        payload["id"] = line.line_id
    if line.amounts is not None:
        payload["amounts"] = line.amounts
    if line.payment_date is not None:
        payload["payment_date"] = line.payment_date.isoformat()
    if line.country is not None:
        payload["country"] = line.country
    if line.client_country is not None:
        payload["client_country"] = line.client_country
    if line.client_vat_number is not None:
        payload["client_vat_number"] = line.client_vat_number
    if line.client_type is not None:
        payload["client_type"] = line.client_type
    if line.source_type or line.source_id:
        payload["source"] = {"type": line.source_type, "id": line.source_id}
    if line.metadata:
        payload["metadata"] = line.metadata
    return payload


def _report_payload(report: EReportingReportPayload) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": report.report_type,
        "period_start": report.period_start.isoformat(),
        "period_end": report.period_end.isoformat(),
        "lines": [_line_payload(line) for line in report.lines],
    }
    if report.report_id is not None:
        payload["id"] = report.report_id
    if report.idempotency_key:
        payload["idempotency_key"] = report.idempotency_key
    if report.metadata:
        payload["metadata"] = report.metadata
    return payload


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on", "sandbox", "mock"}


def _build_event(
    *,
    event_type: str,
    status: str,
    raw_status: str | None = None,
    message: str | None = None,
    errors: list[str] | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "event_type": event_type,
        "status": status,
        "raw_status": raw_status,
        "message": message,
        "errors": errors,
        "payload": payload,
    }


class HttpGenericProvider(PdpProvider):
    slug = _LegacyHttpGeneric.slug
    label = _LegacyHttpGeneric.label
    description = _LegacyHttpGeneric.description
    kind = _LegacyHttpGeneric.kind
    auth_type = _LegacyHttpGeneric.auth_type
    credential_fields = list(_LegacyHttpGeneric.credential_fields) + [
        {
            "key": "inbox_path",
            "label": "Chemin inbox",
            "required": False,
            "placeholder": "inbox",
        },
        {
            "key": "ack_path",
            "label": "Chemin ack",
            "required": False,
            "placeholder": "inbox/{message_id}/ack",
        },
        {
            "key": "inbox_status_path",
            "label": "Chemin statut inbox",
            "required": False,
            "placeholder": "inbox/{message_id}/status",
        },
        {
            "key": "ereporting_path",
            "label": "Chemin e-reporting",
            "required": False,
            "placeholder": "ereporting",
        },
        {
            "key": "sandbox",
            "label": "Mode sandbox",
            "required": False,
            "placeholder": "true",
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

    async def send_invoice(self, invoice: Any, ctx: dict | None = None) -> TransmissionResult:
        pdf_key = getattr(invoice, "pdf_key", None)
        xml_key = getattr(invoice, "xml_key", None)
        pdf_bytes = get_object_bytes(pdf_key) if pdf_key else None
        xml_bytes = get_object_bytes(xml_key) if xml_key else None
        if not pdf_bytes or not xml_bytes:
            raise ValueError("Artefacts d'emission manquants.")

        tenant_id = tenant_id_from_credentials(self.credentials)
        _enforce_rate_limit(tenant_id)
        _enforce_payload_limit(len(pdf_bytes) + len(xml_bytes))

        submit_path = (self.credentials.get("submit_path") or "submit").lstrip("/")
        url = f"{self._base_url()}/{submit_path}"
        url = validate_outbound_url(url)
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

        external_id = _extract_external_id(data if isinstance(data, dict) else None) or ""
        status_raw = _extract_status_value(data if isinstance(data, dict) else None)
        status = normalize_status(str(status_raw) if status_raw is not None else None)
        if status == "unknown":
            status = "submitted"
        errors = _extract_errors(data if isinstance(data, dict) else None)
        payload_hash = hashlib.sha256(pdf_bytes + xml_bytes).hexdigest()
        return TransmissionResult(
            external_id=external_id,
            status=status,
            raw_status=str(status_raw) if status_raw is not None else None,
            message=None,
            errors=errors,
            payload_hash=payload_hash,
            events=[
                _build_event(
                    event_type="submit",
                    status=status,
                    raw_status=str(status_raw) if status_raw is not None else None,
                    message="Soumission enregistree",
                    errors=errors,
                    payload=data if isinstance(data, dict) else None,
                )
            ],
        )

    async def poll_status(self, transmission_id: str) -> StatusResult:
        status_path = (self.credentials.get("status_path") or "status/{external_id}").lstrip("/")
        path = status_path.replace("{external_id}", transmission_id)
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
                correlation_id=transmission_id,
                provider=self.slug,
            )
        resp.raise_for_status()
        try:
            data = resp.json()
        except Exception:
            data = None
        status_value = None
        if isinstance(data, dict):
            status_value = _extract_status_value(data)
        elif isinstance(data, str):
            status_value = data
        status = normalize_status(str(status_value) if status_value is not None else None)
        errors = _extract_errors(data if isinstance(data, dict) else None)
        return StatusResult(
            status=status,
            raw_status=str(status_value) if status_value is not None else None,
            errors=errors,
            events=[
                _build_event(
                    event_type="status_update",
                    status=status,
                    raw_status=str(status_value) if status_value is not None else None,
                    message="Statut synchronise",
                    errors=errors,
                    payload=data if isinstance(data, dict) else None,
                )
            ],
        )

    async def fetch_inbox(self, since_cursor: str | None = None) -> list[InboundMessage]:
        inbox_path = (self.credentials.get("inbox_path") or "inbox").lstrip("/")
        url = f"{self._base_url()}/{inbox_path}"
        url = validate_outbound_url(url)
        params = {"cursor": since_cursor} if since_cursor else None
        tenant_id = tenant_id_from_credentials(self.credentials)
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await httpx_request_with_log(
                client,
                "GET",
                url,
                headers=self._headers(),
                params=params,
                tenant_id=tenant_id,
                correlation_id=since_cursor,
                provider=self.slug,
            )
        resp.raise_for_status()
        try:
            data = resp.json()
        except Exception:
            data = None
        return _decode_messages(data)

    async def ack_inbox(self, message_id: str) -> None:
        ack_path = (self.credentials.get("ack_path") or "inbox/{message_id}/ack").lstrip("/")
        path = ack_path.replace("{message_id}", message_id)
        url = f"{self._base_url()}/{path}"
        url = validate_outbound_url(url)
        tenant_id = tenant_id_from_credentials(self.credentials)
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await httpx_request_with_log(
                client,
                "POST",
                url,
                headers=self._headers(),
                tenant_id=tenant_id,
                correlation_id=message_id,
                provider=self.slug,
            )
        resp.raise_for_status()

    async def send_inbox_status(self, message_id: str, action: str) -> None:
        status_path = (self.credentials.get("inbox_status_path") or "").lstrip("/")
        if not status_path:
            if action == "accept":
                await self.ack_inbox(message_id)
                return
            raise NotImplementedError("Inbox status path non configuré.")
        path = status_path.replace("{message_id}", message_id)
        url = f"{self._base_url()}/{path}"
        url = validate_outbound_url(url)
        payload = {"action": action}
        tenant_id = tenant_id_from_credentials(self.credentials)
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await httpx_request_with_log(
                client,
                "POST",
                url,
                json=payload,
                headers=self._headers(),
                tenant_id=tenant_id,
                correlation_id=message_id,
                provider=self.slug,
            )
        resp.raise_for_status()

    async def send_ereporting(
        self,
        report: EReportingReportPayload | list[EReportingEvent],
    ) -> list[TransmissionResult]:
        if _truthy(self.credentials.get("sandbox")) or _truthy(self.credentials.get("mock")):
            if isinstance(report, list):
                return [
                    TransmissionResult(external_id=f"sandbox-{idx}", status="accepted", metadata={"index": idx})
                    for idx, _ in enumerate(report)
                ]
            return [
                TransmissionResult(
                    external_id=f"sandbox-{idx}",
                    status="accepted",
                    metadata={"line_id": line.line_id} if line.line_id else None,
                )
                for idx, line in enumerate(report.lines)
            ]

        ereporting_path = (self.credentials.get("ereporting_path") or "ereporting").lstrip("/")
        url = f"{self._base_url()}/{ereporting_path}"
        url = validate_outbound_url(url)
        payload: dict[str, Any]
        if isinstance(report, list):
            payload = {"events": [_event_payload(event) for event in report]}
        else:
            payload = {"report": _report_payload(report)}
        tenant_id = tenant_id_from_credentials(self.credentials)
        _enforce_rate_limit(tenant_id)
        payload_size = _estimate_payload_bytes(payload)
        if payload_size:
            _enforce_payload_limit(payload_size)
        correlation_id = report.report_id if isinstance(report, EReportingReportPayload) else None
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

        results: list[TransmissionResult] = []
        items: list[dict[str, Any]] = []
        if isinstance(data, dict):
            results_raw = data.get("results")
            if isinstance(results_raw, list):
                items = [item for item in results_raw if isinstance(item, dict)]
            else:
                items = [data]

        for item in items:
            status_raw = _extract_status_value(item)
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else None
            results.append(
                TransmissionResult(
                    external_id=_extract_external_id(item),
                    status=normalize_status(str(status_raw) if status_raw is not None else None),
                    raw_status=str(status_raw) if status_raw is not None else None,
                    errors=_extract_errors(item),
                    metadata=metadata,
                )
            )
        return results
