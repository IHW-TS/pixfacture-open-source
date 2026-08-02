from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date
from typing import Any


@dataclass
class TransmissionResult:
    external_id: str | None
    status: str
    raw_status: str | None = None
    message: str | None = None
    errors: list[str] | None = None
    payload_hash: str | None = None
    events: list[dict[str, Any]] | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class StatusResult:
    status: str
    raw_status: str | None = None
    message: str | None = None
    errors: list[str] | None = None
    events: list[dict[str, Any]] | None = None


@dataclass
class InboundMessage:
    message_id: str
    payload: dict[str, Any] | None = None
    received_at: str | None = None
    raw: dict[str, Any] | None = None
    source: str | None = None
    cursor: str | None = None


@dataclass
class EReportingEvent:
    event_type: str
    amounts: dict[str, Any] | None = None
    payment_date: date | None = None
    country: str | None = None
    client_country: str | None = None
    client_vat_number: str | None = None
    client_type: str | None = None
    metadata: dict[str, Any] | None = None

@dataclass
class EReportingLinePayload:
    line_id: str | None
    event_type: str
    amounts: dict[str, Any] | None = None
    payment_date: date | None = None
    country: str | None = None
    client_country: str | None = None
    client_vat_number: str | None = None
    client_type: str | None = None
    source_type: str | None = None
    source_id: str | None = None
    metadata: dict[str, Any] | None = None

@dataclass
class EReportingReportPayload:
    report_id: str | None
    report_type: str
    period_start: date
    period_end: date
    lines: list[EReportingLinePayload]
    idempotency_key: str | None = None
    metadata: dict[str, Any] | None = None


class PdpProvider(ABC):
    slug: str = ""
    label: str = ""
    description: str | None = None
    kind: str = "b2b"
    auth_type: str = "api_key"
    credential_fields: list[dict[str, Any]] = []
    requires_sanity_checks: bool = False

    def __init__(self, credentials: dict | None = None) -> None:
        self.credentials = credentials or {}

    @classmethod
    def metadata(cls) -> dict[str, Any]:
        return {
            "slug": cls.slug,
            "label": cls.label,
            "description": cls.description,
            "kind": cls.kind,
            "auth_type": cls.auth_type,
            "credential_fields": cls.credential_fields,
        }

    def missing_server_config(self) -> list[str]:
        return []

    async def test_connection(self) -> dict[str, Any]:
        return {"ok": True, "message": "Connexion OK."}

    @abstractmethod
    async def send_invoice(self, invoice: Any, ctx: dict | None = None) -> TransmissionResult:
        raise NotImplementedError

    @abstractmethod
    async def poll_status(self, transmission_id: str) -> StatusResult:
        raise NotImplementedError

    async def get_status(self, transmission_id: str) -> StatusResult:
        return await self.poll_status(transmission_id)

    async def handle_webhook(self, payload: bytes, headers: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def send_einvoice(self, invoice: Any, ctx: dict | None = None) -> TransmissionResult:
        return await self.send_invoice(invoice, ctx)

    async def poll_transmission_status(self, transmission_id: str) -> StatusResult:
        return await self.poll_status(transmission_id)

    async def fetch_inbox(self, since_cursor: str | None = None) -> list[InboundMessage]:
        raise NotImplementedError

    async def receive_invoices(self, since_cursor: str | None = None) -> list[InboundMessage]:
        return await self.fetch_inbox(since_cursor=since_cursor)

    async def ack_inbox(self, message_id: str) -> None:
        raise NotImplementedError

    async def send_inbox_status(self, message_id: str, action: str) -> None:
        raise NotImplementedError

    async def mark_invoice_cashed(self, invoice_id: str) -> None:
        raise NotImplementedError

    async def send_ereporting(
        self,
        report: EReportingReportPayload | list[EReportingEvent],
    ) -> list[TransmissionResult]:
        raise NotImplementedError
