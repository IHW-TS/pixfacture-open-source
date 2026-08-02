import asyncio
import json
import logging
from datetime import date, timedelta
from typing import TypedDict

from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import PdpAccount, PdpConnection, UsageMetric
from ..services import seqino_usage
from ..services.seqino_mandates import seqino_has_active_mandate
from ..services.connected_mode import connected_mode_decision
from ..utils.crypto import decrypt_payload
from ..utils.pdp_accounts import get_pdp_account_metadata

logger = logging.getLogger(__name__)


class SeqinoUsageSummary(TypedDict):
    ok: bool
    period: str | None
    fetched: int
    stored: int
    skipped: int
    errors: int


def _default_period(now: date | None = None) -> str:
    if now is None:
        now = date.today()
    first_day = now.replace(day=1)
    prev_month = first_day - timedelta(days=1)
    return prev_month.strftime("%Y-%m")


def _normalize_period(value: str | None) -> str:
    raw = (value or "").strip()
    if raw:
        text = raw[:7]
        if len(text) == 7 and text[4] == "-" and text[:4].isdigit() and text[5:7].isdigit():
            year = int(text[:4])
            month = int(text[5:7])
            if 1 <= month <= 12 and year >= 2000:
                return f"{year:04d}-{month:02d}"
        raise ValueError("period invalide (format attendu YYYY-MM).")
    return _default_period()


def _normalize_client_id(value: object | None) -> str:
    if isinstance(value, dict):
        value = value.get("id") or value.get("client_id") or value.get("clientId")
    return str(value).strip() if value is not None else ""


def _remember_client(mapping: dict[str, str], *, client_id: str, tenant_id: str, source: str) -> None:
    if not client_id:
        return
    if client_id in mapping and mapping[client_id] != tenant_id:
        logger.warning(
            "Seqino usage: duplicate client id",
            extra={"client_id": client_id, "tenant_id": tenant_id, "source": source},
        )
        return
    mapping[client_id] = tenant_id


def _connection_is_syncable(conn: PdpConnection) -> bool:
    status = (conn.status or "").strip().lower()
    return not status or status in {"connected", "active"}


def _account_is_syncable(db: Session, account: PdpAccount) -> bool:
    status_values = [
        account.status,
        get_pdp_account_metadata(account).get("status"),
        get_pdp_account_metadata(account).get("onboarding_status"),
    ]
    if any(
        (str(value).strip().lower() if value is not None else "") in {"connected", "active"} for value in status_values
    ):
        return True
    return bool(account.tenant_id and seqino_has_active_mandate(account.tenant_id, db=db))


def _seqino_client_map(db: Session) -> dict[str, str]:
    mapping: dict[str, str] = {}
    conns = db.query(PdpConnection).filter(PdpConnection.provider_slug == "seqino").all()
    for conn in conns:
        tenant_id = str(conn.tenant_id or "").strip()
        if not tenant_id or not connected_mode_decision(db, tenant_id, "seqino").allowed:
            continue
        if not _connection_is_syncable(conn):
            continue
        try:
            creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
        except Exception:
            logger.warning("Seqino usage: credentials invalid", extra={"tenant_id": tenant_id})
            continue
        client_id = _normalize_client_id(creds.get("seqino_client_id") or creds.get("client_id"))
        _remember_client(mapping, client_id=client_id, tenant_id=tenant_id, source="pdp_connection")
    accounts = (
        db.query(PdpAccount).filter(PdpAccount.provider == "seqino", PdpAccount.provider_client_id.isnot(None)).all()
    )
    for account in accounts:
        tenant_id = str(account.tenant_id or "").strip()
        if not tenant_id or not connected_mode_decision(db, tenant_id, "seqino").allowed:
            continue
        if not _account_is_syncable(db, account):
            continue
        client_id = _normalize_client_id(account.provider_client_id)
        _remember_client(mapping, client_id=client_id, tenant_id=tenant_id, source="pdp_account")
    return mapping


async def _fetch_usage_for_clients(
    *,
    access_token: str,
    sponsor_id: str,
    client_ids: list[str],
    period: str,
) -> tuple[list[dict[str, object]], list[tuple[str, Exception]]]:
    items: list[dict[str, object]] = []
    errors: list[tuple[str, Exception]] = []
    for client_id in client_ids:
        try:
            client_items = await seqino_usage.fetch_usage_summary(
                access_token=access_token,
                sponsor_id=sponsor_id,
                client_id=client_id,
                period=period,
            )
        except Exception as exc:
            errors.append((client_id, exc))
            continue
        for item in client_items:
            item.setdefault("client_id", client_id)
            items.append(item)
    return items, errors


def sync_seqino_usage(period: str | None = None) -> dict[str, object]:
    summary: SeqinoUsageSummary = {"ok": True, "period": None, "fetched": 0, "stored": 0, "skipped": 0, "errors": 0}
    try:
        normalized_period = _normalize_period(period)
    except ValueError as exc:
        return {"ok": False, "error": {"code": "period_invalid", "message": str(exc)}}
    summary["period"] = normalized_period

    with SessionLocal() as db:
        mapping = _seqino_client_map(db)
    if not mapping:
        logger.info(json.dumps({"event": "seqino_usage_sync_done", "summary": summary}))
        return dict(summary)

    access_token = settings.SEQINO_ACCESS_TOKEN
    sponsor_id = settings.SEQINO_SPONSOR_ID
    if not (access_token or "").strip() or not (sponsor_id or "").strip():
        return {
            "ok": False,
            "error": {"code": "seqino_credentials_missing", "message": "Token/Sponsor Seqino manquant."},
        }
    access_token_value = (access_token or "").strip()
    sponsor_id_value = (sponsor_id or "").strip()

    items, fetch_errors = asyncio.run(
        _fetch_usage_for_clients(
            access_token=access_token_value,
            sponsor_id=sponsor_id_value,
            client_ids=sorted(mapping.keys()),
            period=normalized_period,
        )
    )
    summary["fetched"] = len(items)
    if fetch_errors:
        summary["errors"] += len(fetch_errors)
        logger.warning(
            "Seqino usage fetch partially failed",
            extra={"period": normalized_period, "errors": len(fetch_errors)},
        )

    with SessionLocal() as db:
        for item in items:
            client_id = seqino_usage.extract_client_id(item)
            if not client_id:
                summary["skipped"] += 1
                continue
            tenant_id = mapping.get(client_id)
            if not tenant_id:
                summary["skipped"] += 1
                continue
            metrics_payload = dict(item)
            metrics_payload["client_id"] = client_id
            metric = (
                db.query(UsageMetric)
                .filter(UsageMetric.tenant_id == tenant_id, UsageMetric.period == normalized_period)
                .first()
            )
            if not metric:
                metric = UsageMetric(
                    tenant_id=tenant_id,
                    period=normalized_period,
                    metrics_json=metrics_payload,
                )
                db.add(metric)
            else:
                metric.metrics_json = metrics_payload
            summary["stored"] += 1
        try:
            db.commit()
        except Exception:
            db.rollback()
            summary["ok"] = False
            summary["errors"] += 1
    if summary["errors"] and summary["stored"] == 0:
        summary["ok"] = False
    logger.info(json.dumps({"event": "seqino_usage_sync_done", "summary": summary}))
    return dict(summary)


def sync_seqino_usage_job(period: str | None = None) -> dict[str, object]:
    return sync_seqino_usage(period=period)
