from __future__ import annotations

import asyncio
import calendar
import json
import logging
from datetime import date, datetime
from typing import Any, cast

from redis import Redis
from sqlalchemy.orm import Session

from ..config import settings
from ..models import BillableEvent, PdpAccount, PdpConnection, Tenant
from ..services import seqino_usage
from ..services.connected_mode import is_connected_mode_operational
from ..services.seqino_mandates import seqino_has_active_mandate
from .integration_secrets import resolve_seqino_credentials
from ..utils.crypto import decrypt_payload
from ..utils.pdp_accounts import get_pdp_account_metadata


logger = logging.getLogger(__name__)

_ENTERPRISE_INCLUDED_FLOWS = 10**9
_CACHE_TTL_SECONDS = 60
_redis_client: Redis | None = None


class UsageQuotaExceeded(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _current_period() -> str:
    return date.today().strftime("%Y-%m")


def _period_bounds(period: str) -> tuple[datetime, datetime]:
    try:
        year_str, month_str = (period or "").split("-", 1)
        year = int(year_str)
        month = int(month_str)
    except (ValueError, TypeError):
        year = date.today().year
        month = date.today().month
    month = max(1, min(month, 12))
    last_day = calendar.monthrange(year, month)[1]
    start = datetime(year, month, 1)
    end = datetime(year, month, last_day, 23, 59, 59, 999999)
    return start, end


def _period_start_date(period: str) -> date:
    start, _ = _period_bounds(period)
    return date(start.year, start.month, 1)


def _count_billable_events(db: Session, tenant_id: str, period: str) -> int:
    start, end = _period_bounds(period)
    return (
        db.query(BillableEvent)
        .filter(
            BillableEvent.tenant_id == tenant_id,
            BillableEvent.occurred_at >= start,
            BillableEvent.occurred_at <= end,
        )
        .count()
    )


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _extract_count(metrics: dict, keys: tuple[str, ...]) -> int:
    for key in keys:
        raw = metrics.get(key)
        if raw is None:
            continue
        if isinstance(raw, dict):
            for nested in ("count", "total", "items", "value"):
                if nested in raw:
                    return _as_int(raw.get(nested))
            continue
        return _as_int(raw)
    return 0


def _sum_flows(metrics: dict) -> int:
    invoice_count = _extract_count(metrics, ("invoices_count", "invoice_count", "invoiceCount", "invoices"))
    reporting_count = _extract_count(
        metrics,
        ("reporting_count", "reportingCount", "reports_count", "report_count", "reporting", "reports"),
    )
    return invoice_count + reporting_count


def _normalize_plan(value: str | None) -> str:
    raw = (value or "").strip().lower()
    if raw in {"starter", "pro", "enterprise"}:
        return raw
    return "starter"


def _seqino_connection_enabled(conn: PdpConnection | None) -> bool:
    if not conn:
        return False
    status = (conn.status or "").strip().lower()
    if not status:
        return True
    return status in {"connected", "active"}


def _normalize_seqino_client_id(raw: Any) -> str | None:
    if isinstance(raw, dict):
        raw = raw.get("id") or raw.get("client_id") or raw.get("clientId")
    if raw is None:
        return None
    value = str(raw).strip()
    return value or None


def _seqino_connection_client_id(conn: PdpConnection | None) -> str | None:
    if not conn or not conn.encrypted_credentials:
        return None
    try:
        creds = decrypt_payload(conn.encrypted_credentials)
    except Exception:
        return None
    if not isinstance(creds, dict):
        return None
    return _normalize_seqino_client_id(creds.get("seqino_client_id") or creds.get("client_id"))


def _seqino_account_client_id(account: PdpAccount | None) -> str | None:
    if not account:
        return None
    return _normalize_seqino_client_id(account.provider_client_id)


def _seqino_account_enabled(account: PdpAccount | None) -> bool:
    if not account:
        return False
    metadata = get_pdp_account_metadata(account)
    for value in (account.status, metadata.get("status"), metadata.get("onboarding_status")):
        status = str(value).strip().lower() if value is not None else ""
        if status in {"connected", "active"}:
            return True
    return False


def _seqino_configured(access_token: str | None, sponsor_id: str | None) -> bool:
    return bool((access_token or "").strip() and (sponsor_id or "").strip())


def _get_redis() -> Redis | None:
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    redis_url = (settings.REDIS_URL or "").strip()
    if not redis_url:
        return None
    try:
        _redis_client = Redis.from_url(redis_url, decode_responses=True)
    except Exception:
        _redis_client = None
    return _redis_client


def invalidate_usage_cache(tenant_id: str, period: str | None = None) -> None:
    redis = _get_redis()
    if not redis:
        return
    period = period or _current_period()
    cache_key = f"usage:{tenant_id}:{period}"
    try:
        redis.delete(cache_key)
    except Exception:
        pass


async def get_monthly_usage(
    db: Session,
    *,
    tenant_id: str,
    period: str | None = None,
) -> dict:
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise ValueError("Tenant introuvable.")
    assert tenant.id is not None
    tenant_id_value = tenant.id
    period = period or _current_period()
    assert period is not None
    plan = _normalize_plan(tenant.plan)
    used_flows = 0
    policy = "wallet"

    cache_key = f"usage:{tenant_id_value}:{period}"
    redis = _get_redis()
    if redis:
        try:
            cached = redis.get(cache_key)
            if cached:
                cached_text: str | None
                if isinstance(cached, (bytes, bytearray)):
                    cached_text = cached.decode()
                elif isinstance(cached, str):
                    cached_text = cached
                else:
                    cached_text = None
                if cached_text:
                    return json.loads(cached_text)
        except Exception:
            pass

    billable_count = _count_billable_events(db, tenant_id_value, period)
    used_flows = billable_count

    if billable_count == 0 and is_connected_mode_operational(db, tenant_id_value, "seqino"):
        conn = (
            db.query(PdpConnection)
            .filter(PdpConnection.tenant_id == tenant_id_value, PdpConnection.provider_slug == "seqino")
            .first()
        )
        account = (
            db.query(PdpAccount)
            .filter(PdpAccount.tenant_id == tenant_id_value, PdpAccount.provider == "seqino")
            .order_by(PdpAccount.updated_at.desc())
            .first()
        )
        client_id = _seqino_connection_client_id(conn) or _seqino_account_client_id(account)
        access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id_value)
        seqino_ready = (
            _seqino_connection_enabled(conn)
            or _seqino_account_enabled(account)
            or seqino_has_active_mandate(tenant_id_value, db=db)
        )
        if seqino_ready and client_id and _seqino_configured(access_token, sponsor_id):
            try:
                items = await asyncio.wait_for(
                    seqino_usage.fetch_usage_summary(
                        access_token=cast(str, access_token),
                        sponsor_id=cast(str, sponsor_id),
                        client_id=client_id,
                        period=period,
                    ),
                    timeout=4.0,
                )
            except Exception:
                items = []
            for item in items:
                metrics = item.get("metrics") if isinstance(item.get("metrics"), dict) else item
                if isinstance(metrics, dict):
                    if not client_id or seqino_usage.extract_client_id(item) == client_id:
                        used_flows = _sum_flows(metrics)
                        break

    topup_flows = 0
    included_flows = None
    overage_flows = 0
    overage_amount_eur = 0.0
    payload = {
        "period": period,
        "plan": plan,
        "used_flows": used_flows,
        "included_flows": included_flows,
        "topup_flows": topup_flows,
        "overage_flows": overage_flows,
        "overage_amount_eur": overage_amount_eur,
        "policy": policy,
    }
    if redis:
        try:
            redis.set(cache_key, json.dumps(payload, ensure_ascii=True), ex=_CACHE_TTL_SECONDS)
        except Exception:
            pass
    return payload


async def get_usage_summary(
    db: Session,
    *,
    tenant_id: str,
    period: str | None = None,
) -> dict:
    usage = await get_monthly_usage(db, tenant_id=tenant_id, period=period)
    included = usage.get("included_flows")
    used = _as_int(usage.get("used_flows"))
    remaining = None if included is None else max(0, _as_int(included) - used)
    overage_rate = 0.0
    seqino_mandate_active = seqino_has_active_mandate(tenant_id, db)
    return {
        "period": usage.get("period"),
        "plan": usage.get("plan"),
        "included_flows": included,
        "topup_flows": _as_int(usage.get("topup_flows")),
        "used_flows": used,
        "remaining": remaining,
        "overage_rate_eur": overage_rate,
        "seqino_mandate_active": seqino_mandate_active,
    }


async def enforce_usage_quota_or_raise(db: Session, tenant_id: str) -> dict:
    return await get_monthly_usage(db, tenant_id=tenant_id)
