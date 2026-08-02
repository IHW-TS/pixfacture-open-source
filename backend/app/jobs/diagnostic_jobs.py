from __future__ import annotations

from datetime import datetime, timezone


def ping(tenant_id: str, requested_by: str | None = None) -> dict:
    """Small job used to validate queue/worker wiring in production."""
    return {
        "ok": True,
        "tenant_id": tenant_id,
        "requested_by": requested_by,
        "ran_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
    }
