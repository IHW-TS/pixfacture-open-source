from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class PlatformConnector(ABC):
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

    async def lookup_recipient(self, *args, **kwargs) -> dict[str, Any]:
        return {}

    @abstractmethod
    async def submit_invoice(self, invoice: Any, ctx: dict | None = None) -> str:
        raise NotImplementedError

    @abstractmethod
    async def get_status(self, external_id: str) -> str:
        raise NotImplementedError

    async def test_connection(self) -> dict[str, Any]:
        return {"ok": True, "message": "Connexion OK."}
