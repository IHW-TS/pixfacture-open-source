from __future__ import annotations

from typing import Any, cast

from ...platforms.base import PlatformConnector
from ...platforms.chorus import ChorusProPlatform
from ...platforms.dummy import DummyPlatform
from ..base import EReportingEvent, EReportingReportPayload, InboundMessage, PdpProvider, StatusResult, TransmissionResult
from ..utils import normalize_status


class PlatformAdapterProvider(PdpProvider):
    platform_cls: type[PlatformConnector] = cast(type[PlatformConnector], PlatformConnector)

    def __init__(self, credentials: dict | None = None) -> None:
        super().__init__(credentials)
        self._platform = self.platform_cls(credentials or {})

    def missing_server_config(self) -> list[str]:
        fn = getattr(self._platform, "missing_server_config", None)
        if callable(fn):
            return fn()
        return []

    async def test_connection(self) -> dict[str, Any]:
        fn = getattr(self._platform, "test_connection", None)
        if callable(fn):
            return await fn()
        return {"ok": True, "message": "Connexion OK."}

    async def send_invoice(self, invoice: Any, ctx: dict | None = None) -> TransmissionResult:
        external_id = await self._platform.submit_invoice(invoice, ctx)
        return TransmissionResult(
            external_id=external_id or "",
            status="submitted",
            events=[
                {
                    "event_type": "submit",
                    "status": "submitted",
                    "message": "Soumission enregistree",
                    "payload": {"external_id": external_id},
                }
            ],
        )

    async def poll_status(self, transmission_id: str) -> StatusResult:
        raw_status = await self._platform.get_status(transmission_id)
        status = normalize_status(str(raw_status) if raw_status is not None else None)
        return StatusResult(
            status=status,
            raw_status=str(raw_status) if raw_status is not None else None,
            events=[
                {
                    "event_type": "status_update",
                    "status": status,
                    "raw_status": str(raw_status) if raw_status is not None else None,
                    "message": "Statut synchronise",
                }
            ],
        )

    async def fetch_inbox(self, since_cursor: str | None = None) -> list[InboundMessage]:
        raise NotImplementedError

    async def ack_inbox(self, message_id: str) -> None:
        raise NotImplementedError

    async def send_ereporting(
        self,
        report: EReportingReportPayload | list[EReportingEvent],
    ) -> list[TransmissionResult]:
        raise NotImplementedError


class ChorusPlatformProvider(PlatformAdapterProvider):
    platform_cls = ChorusProPlatform
    slug = ChorusProPlatform.slug
    label = ChorusProPlatform.label
    description = ChorusProPlatform.description
    kind = ChorusProPlatform.kind
    auth_type = ChorusProPlatform.auth_type
    credential_fields = ChorusProPlatform.credential_fields
    requires_sanity_checks = getattr(ChorusProPlatform, "requires_sanity_checks", False)

    async def poll_status(self, transmission_id: str) -> StatusResult:
        get_details = getattr(self._platform, "get_status_details", None)
        if not callable(get_details):
            return await super().poll_status(transmission_id)
        details = await get_details(transmission_id)
        status = str(details.get("status") or "unknown")
        raw_status = details.get("raw_status")
        errors = details.get("errors") if isinstance(details.get("errors"), list) else []
        message = details.get("message")
        return StatusResult(
            status=status,
            raw_status=str(raw_status) if raw_status is not None else None,
            message=str(message) if message else None,
            errors=[str(item)[:300] for item in errors[:10]],
            events=[
                {
                    "event_type": "chorus_flow_status",
                    "status": status,
                    "raw_status": str(raw_status) if raw_status is not None else None,
                    "message": str(message) if message else "Statut de flux Chorus synchronisé.",
                    "errors": [str(item)[:300] for item in errors[:10]],
                }
            ],
        )


class DummyPlatformProvider(PlatformAdapterProvider):
    platform_cls = DummyPlatform
    slug = DummyPlatform.slug
    label = DummyPlatform.label
    description = DummyPlatform.description
    kind = DummyPlatform.kind
    auth_type = DummyPlatform.auth_type
    credential_fields = DummyPlatform.credential_fields
    requires_sanity_checks = getattr(DummyPlatform, "requires_sanity_checks", False)

    async def send_inbox_status(self, message_id: str, action: str) -> None:
        return None

    async def send_ereporting(
        self,
        report: EReportingReportPayload | list[EReportingEvent],
    ) -> list[TransmissionResult]:
        if isinstance(report, list):
            return [
                TransmissionResult(external_id=f"dummy-{idx}", status="accepted", metadata={"index": idx})
                for idx, _ in enumerate(report)
            ]
        return [
            TransmissionResult(
                external_id=f"dummy-{idx}",
                status="accepted",
                metadata={"line_id": line.line_id} if line.line_id else None,
            )
            for idx, line in enumerate(report.lines)
        ]
