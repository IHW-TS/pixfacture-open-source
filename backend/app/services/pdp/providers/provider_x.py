from __future__ import annotations

from typing import Any, NoReturn

from ..base import EReportingEvent, EReportingReportPayload, InboundMessage, PdpProvider, StatusResult, TransmissionResult
from ..utils import PdpProviderError


_TEMPLATE_ONLY_MESSAGE = (
    "ProviderX est un template d'integration interne. "
    "Ce connecteur n'est pas exploitable tant que le mapping et les endpoints cibles ne sont pas implementes."
)


class ProviderX(PdpProvider):
    slug = "provider_x"
    label = "Template connecteur B2B (interne)"
    description = "Template interne pour cadrer une future integration PDP/PA. Non exploitable tel quel."
    kind = "b2b"
    auth_type = "oauth"
    credential_fields = [
        {"key": "base_url", "label": "URL base", "required": True, "placeholder": "https://api.providerx.tld"},
        {"key": "client_id", "label": "Client ID", "required": True, "placeholder": "..."},
        {"key": "client_secret", "label": "Client secret", "required": True, "secret": True, "placeholder": "..."},
        {"key": "token_url", "label": "URL token", "required": False, "placeholder": "https://auth.providerx.tld/oauth/token"},
    ]

    @classmethod
    def metadata(cls) -> dict[str, Any]:
        data = super().metadata()
        data.update(
            {
                "availability": "template-only",
                "template_only": True,
                "implemented_capabilities": [],
                "message": _TEMPLATE_ONLY_MESSAGE,
            }
        )
        return data

    async def test_connection(self) -> dict[str, Any]:
        return {
            "ok": False,
            "code": "connector_template_only",
            "message": _TEMPLATE_ONLY_MESSAGE,
        }

    def _raise_template_only(self) -> NoReturn:
        raise PdpProviderError(
            _TEMPLATE_ONLY_MESSAGE,
            code="connector_template_only",
            retryable=False,
        )

    async def send_invoice(self, invoice: Any, ctx: dict | None = None) -> TransmissionResult:
        self._raise_template_only()

    async def poll_status(self, transmission_id: str) -> StatusResult:
        self._raise_template_only()

    async def fetch_inbox(self, since_cursor: str | None = None) -> list[InboundMessage]:
        self._raise_template_only()

    async def ack_inbox(self, message_id: str) -> None:
        self._raise_template_only()

    async def send_inbox_status(self, message_id: str, action: str) -> None:
        self._raise_template_only()

    async def send_ereporting(
        self,
        report: EReportingReportPayload | list[EReportingEvent],
    ) -> list[TransmissionResult]:
        self._raise_template_only()
