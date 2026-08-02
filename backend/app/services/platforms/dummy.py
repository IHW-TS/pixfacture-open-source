from __future__ import annotations

import hashlib
from typing import Any

from .base import PlatformConnector
from ..storage import get_object_bytes


class DummyPlatform(PlatformConnector):
    slug = "dummy"
    label = "B2B (PA) — Dummy"
    description = "Simulateur de statuts pour developpement."
    kind = "b2b"
    auth_type = "api_key"
    credential_fields: list[dict[str, Any]] = []

    async def submit_invoice(self, invoice: Any, ctx: dict | None = None) -> str:
        pdf_key = getattr(invoice, "pdf_key", None)
        xml_key = getattr(invoice, "xml_key", None)
        pdf_bytes = get_object_bytes(pdf_key) if pdf_key else None
        xml_bytes = get_object_bytes(xml_key) if xml_key else None
        if not pdf_bytes or not xml_bytes:
            raise ValueError("Artefacts d'emission manquants.")
        payload = pdf_bytes + b"::" + xml_bytes
        digest = hashlib.sha256(payload).hexdigest()[:20]
        return f"dummy-{digest}"

    async def get_status(self, external_id: str) -> str:
        return "accepted"
