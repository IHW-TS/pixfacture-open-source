from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, TYPE_CHECKING

from ..config import settings
from .sanitize_provider_payload import sanitize_provider_payload

if TYPE_CHECKING:
    from ..models import PdpAccount


def _safe_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    return {}


def _filter_raw_metadata(raw: dict[str, Any]) -> dict[str, Any]:
    allowed_keys = (
        "onboarding_link_id",
        "mandate_id",
        "onboarding_mandate_id",
        "link_id",
        "onboarding_url",
        "onboarding_expires_at",
        "onboarding_status",
        "organization_id",
        "scopes",
        "environment",
    )
    return {key: raw[key] for key in allowed_keys if key in raw and raw[key] is not None}


def get_pdp_account_metadata(account: "PdpAccount | None") -> dict[str, Any]:
    if not account:
        return {}
    metadata = _safe_dict(account.provider_metadata)
    if metadata:
        return metadata
    raw = _safe_dict(account.raw_json)
    if not raw:
        return {}
    return _filter_raw_metadata(raw)


def update_pdp_account_payload(
    account: "PdpAccount",
    *,
    provider_payload: dict | None = None,
    metadata_updates: dict[str, Any] | None = None,
    status: str | None = None,
    environment: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    ts = now or datetime.now(timezone.utc).replace(tzinfo=None)
    metadata = _safe_dict(account.provider_metadata)
    if not metadata:
        raw = _safe_dict(account.raw_json)
        if raw:
            metadata.update(_filter_raw_metadata(raw))
    updates = metadata_updates or {}
    for key, value in updates.items():
        if value is None:
            continue
        metadata[key] = value
    provider_slug = (account.provider or "").strip()
    if provider_slug and not metadata.get("provider_slug"):
        metadata["provider_slug"] = provider_slug
    if status is not None:
        metadata["status"] = status
    if environment and not metadata.get("environment"):
        metadata["environment"] = environment
    if account.provider_client_id:
        metadata.setdefault("provider_account_id", account.provider_client_id)
    if not metadata.get("connected_at"):
        created_at = account.created_at or ts
        metadata["connected_at"] = created_at.isoformat()
    metadata["last_sync_at"] = ts.isoformat()
    account.provider_metadata = metadata

    if not getattr(settings, "PDP_STORE_RAW_JSON", False):
        account.raw_json = None
    elif provider_payload is not None:
        account.raw_json = sanitize_provider_payload(provider_payload)

    return metadata
