from __future__ import annotations

import hashlib
import time
from datetime import datetime, timezone
from typing import Any

from .base import EInvoicingConnector
from .utils import normalize_status


class DummyPdpConnector(EInvoicingConnector):
    slug = "dummy"

    @classmethod
    def credential_fields(cls) -> list[dict[str, Any]]:
        return []

    def _make_submission_id(self, invoice: Any) -> str:
        now = int(time.time())
        seed = f"{getattr(invoice, 'id', '')}:{getattr(invoice, 'number', '')}:{now}"
        digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12]
        outcome = "a" if int(digest[-1], 16) % 2 == 0 else "r"
        return f"dummy-{now}-{digest}-{outcome}"

    def _decode_submission_id(self, submission_id: str) -> tuple[int, str]:
        parts = (submission_id or "").split("-")
        if len(parts) >= 4 and parts[0] == "dummy" and parts[1].isdigit():
            created_at = int(parts[1])
            outcome = "accepted" if parts[3] == "a" else "rejected"
            return created_at, outcome
        return int(time.time()), "accepted"

    async def submit(self, invoice: Any, ctx: dict | None = None) -> str:
        return self._make_submission_id(invoice)

    async def get_status(self, submission_id: str) -> str:
        created_at, final_status = self._decode_submission_id(submission_id)
        now = int(time.time())
        delta = max(0, now - created_at)
        if delta < 10:
            return normalize_status("submitted")
        if delta < 45:
            return normalize_status("processing")
        return normalize_status(final_status)

    async def list_events(self, submission_id: str) -> list[dict[str, Any]]:
        created_at, final_status = self._decode_submission_id(submission_id)
        now = int(time.time())
        events: list[dict[str, Any]] = []
        timeline = [
            (created_at, "submitted", "Soumission recue"),
            (created_at + 10, "processing", "Traitement en cours"),
            (created_at + 45, final_status, "Statut final simule"),
        ]
        for ts, status, message in timeline:
            if ts <= now:
                events.append(
                    {
                        "at": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
                        "status": normalize_status(status),
                        "message": message,
                    }
                )
        return events

    async def test_connection(self) -> dict[str, Any]:
        return {"ok": True, "message": "Connexion dummy OK."}
