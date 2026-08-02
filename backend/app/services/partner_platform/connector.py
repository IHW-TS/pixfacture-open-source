from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class PartnerSendResult:
    external_id: str | None
    status: str
    events: list[dict[str, Any]] | None = None
    error_code: str | None = None
    error_message: str | None = None


@dataclass(frozen=True)
class PartnerStatusResult:
    status: str
    events: list[dict[str, Any]] | None = None
    error_code: str | None = None
    error_message: str | None = None


class PartnerConnector(Protocol):
    platform: str

    async def send_invoice(self, invoice: Any, ctx: dict[str, Any]) -> PartnerSendResult:
        ...

    async def get_status(self, external_id: str) -> PartnerStatusResult:
        ...

    async def list_events(self, external_id: str) -> list[dict[str, Any]]:
        ...

    async def submit_ereporting(self, payload: dict[str, Any]) -> PartnerSendResult:
        ...
