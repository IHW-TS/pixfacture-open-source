from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Mapping


@dataclass
class WebhookEvent:
    external_id: str
    status: str
    raw_status: str | None = None
    message: str | None = None
    event_id: str | None = None
    occurred_at: str | None = None
    idempotency_key: str | None = None
    source: str | None = None

    def to_event(self) -> dict[str, Any]:
        return {
            "id": self.event_id,
            "key": self.idempotency_key,
            "status": self.status,
            "raw_status": self.raw_status,
            "message": self.message,
            "at": self.occurred_at,
            "source": self.source,
        }


class EInvoicingConnector(ABC):
    slug: str = ""

    def __init__(self, credentials: dict | None = None) -> None:
        self.credentials = credentials or {}

    @classmethod
    def credential_fields(cls) -> list[dict[str, Any]]:
        return []

    @abstractmethod
    async def submit(self, invoice: Any, ctx: dict | None = None) -> str:
        """Soumet une facture et retourne un identifiant de soumission."""
        raise NotImplementedError

    @abstractmethod
    async def get_status(self, submission_id: str) -> str:
        """Retourne un statut normalise pour la soumission."""
        raise NotImplementedError

    @abstractmethod
    async def list_events(self, submission_id: str) -> list[dict[str, Any]]:
        """Retourne une timeline d'evenements normalisee."""
        raise NotImplementedError

    async def test_connection(self) -> dict[str, Any]:
        """Teste la connexion du connecteur sans fuite de secrets."""
        return {"ok": True}


class EInvoicingProvider(ABC):
    slug: str = ""

    def __init__(self, credentials: dict | None = None) -> None:
        self.credentials = credentials or {}

    @abstractmethod
    async def submitInvoice(self, invoice: Any, ctx: dict | None = None) -> dict[str, Any]:
        """Soumet une facture et retourne un payload normalise (external_id, status, events...)."""
        raise NotImplementedError

    @abstractmethod
    async def getStatus(self, external_id: str) -> dict[str, Any]:
        """Retourne un statut normalise + events optionnels."""
        raise NotImplementedError

    @abstractmethod
    def handleWebhook(self, payload: bytes, headers: Mapping[str, str]) -> WebhookEvent:
        """Valide la signature et normalise le webhook en WebhookEvent."""
        raise NotImplementedError
