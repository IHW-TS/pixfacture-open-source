from __future__ import annotations

from datetime import datetime, timezone
import uuid

from .connector import PartnerConnector, PartnerSendResult, PartnerStatusResult


class MockPartnerConnector:
    platform = "mock"

    async def send_invoice(self, invoice, ctx) -> PartnerSendResult:
        now = datetime.now(timezone.utc).replace(tzinfo=None).replace(microsecond=0).isoformat() + "Z"
        suffix = uuid.uuid4().hex[:8]
        external_id = f"mock-{getattr(invoice, 'id', 'inv')[:8]}-{suffix}"
        events = [
            {"at": now, "type": "submit", "status": "submitted", "message": "Soumission mock"}
        ]
        return PartnerSendResult(external_id=external_id, status="submitted", events=events)

    async def get_status(self, external_id: str) -> PartnerStatusResult:
        now = datetime.now(timezone.utc).replace(tzinfo=None).replace(microsecond=0).isoformat() + "Z"
        events = [
            {"at": now, "type": "status", "status": "accepted", "message": "Statut mock"}
        ]
        return PartnerStatusResult(status="accepted", events=events)

    async def list_events(self, external_id: str) -> list[dict[str, object]]:
        now = datetime.now(timezone.utc).replace(tzinfo=None).replace(microsecond=0).isoformat() + "Z"
        return [
            {"at": now, "type": "status", "status": "accepted", "message": "Statut mock"}
        ]

    async def submit_ereporting(self, payload: dict[str, object]) -> PartnerSendResult:
        now = datetime.now(timezone.utc).replace(tzinfo=None).replace(microsecond=0).isoformat() + "Z"
        external_id = f"mock-ereporting-{uuid.uuid4().hex[:10]}"
        events = [
            {"at": now, "type": "submit", "status": "submitted", "message": "E-reporting mock"}
        ]
        return PartnerSendResult(external_id=external_id, status="submitted", events=events)


def get_partner_connector(platform: str) -> PartnerConnector | None:
    key = (platform or "").strip().lower()
    if key in {"mock", "demo", "fake"}:
        return MockPartnerConnector()
    return None
