import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..jobs.directory import enqueue_directory_refresh_all
from ..models import ActionLog, EInvoicingTransmission, Invoice, PdpAccount, PdpConnection
from ..services.einvoicing.lifecycle import FINAL_STATUSES, LifecycleStatus
from ..services.pdp import PdpProvider, get_provider
from ..services.pdp.service import update_transmission_status
from ..services.integration_secrets import enrich_credentials_with_secrets
from ..services.connected_mode import connected_mode_decision
from ..utils.crypto import decrypt_payload

logger = logging.getLogger(__name__)

PENDING_STATUSES = {status.value for status in LifecycleStatus if status.value not in FINAL_STATUSES}
LEGAL_EVIDENCE_ACTION_LOG_ENTITIES = {"invoice", "credit_note"}


def _normalize_retention_days(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if parsed <= 0:
        return None
    return parsed


def purge_action_logs(retention_days: int | None = None, dry_run: bool = False, db: Session | None = None) -> dict:
    days = _normalize_retention_days(retention_days)
    if days is None:
        days = _normalize_retention_days(getattr(settings, "ACTION_LOG_RETENTION_DAYS", 365))
    if days is None:
        skip_summary: dict[str, bool | int | str | None] = {
            "ok": True,
            "skipped": True,
            "deleted": 0,
            "cutoff": None,
        }
        logger.info(json.dumps({"event": "action_log_purge_skip", "summary": skip_summary}))
        return skip_summary
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    summary: dict[str, bool | int | str | None] = {
        "ok": True,
        "deleted": 0,
        "cutoff": cutoff.isoformat(),
        "dry_run": dry_run,
    }

    def _run(target_db: Session) -> None:
        q = target_db.query(ActionLog).filter(ActionLog.created_at < cutoff)
        q = q.filter(~ActionLog.entity.in_(LEGAL_EVIDENCE_ACTION_LOG_ENTITIES))
        total = q.count()
        summary["deleted"] = total
        if dry_run:
            return
        q.delete(synchronize_session=False)
        target_db.commit()

    if db is not None:
        _run(db)
    else:
        with SessionLocal() as session:
            _run(session)
    logger.info(json.dumps({"event": "action_log_purge_done", "summary": summary}))
    return summary


def purge_pdp_account_raw_json(
    retention_days: int | None = None,
    dry_run: bool = False,
    db: Session | None = None,
) -> dict:
    days = _normalize_retention_days(retention_days)
    if days is None:
        days = _normalize_retention_days(getattr(settings, "PDP_RAW_JSON_RETENTION_DAYS", 7))
    if days is None:
        skip_summary: dict[str, bool | int | str | None] = {
            "ok": True,
            "skipped": True,
            "cleared": 0,
            "cutoff": None,
        }
        logger.info(json.dumps({"event": "pdp_raw_json_purge_skip", "summary": skip_summary}))
        return skip_summary
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    summary: dict[str, bool | int | str | None] = {
        "ok": True,
        "cleared": 0,
        "cutoff": cutoff.isoformat(),
        "dry_run": dry_run,
    }

    def _run(target_db: Session) -> None:
        q = target_db.query(PdpAccount).filter(PdpAccount.raw_json.isnot(None))
        q = q.filter(PdpAccount.updated_at < cutoff)
        total = q.count()
        summary["cleared"] = total
        if dry_run:
            return
        q.update({PdpAccount.raw_json: None}, synchronize_session=False)
        target_db.commit()

    if db is not None:
        _run(db)
    else:
        with SessionLocal() as session:
            _run(session)
    logger.info(json.dumps({"event": "pdp_raw_json_purge_done", "summary": summary}))
    return summary


def _resolve_connector(db: Session, tenant_id: str, connector_slug: str) -> tuple[PdpProvider | None, str | None]:
    connector_slug = (connector_slug or "").strip().lower()
    access = connected_mode_decision(db, tenant_id, connector_slug)
    if not access.allowed:
        return None, access.code or "connected_mode_not_operational"
    if connector_slug in {"chorus", "choruspro"}:
        try:
            creds = enrich_credentials_with_secrets(db, tenant_id, {"_tenant_id": tenant_id})
            provider = get_provider("choruspro", creds)
            missing_config_fn = getattr(provider, "missing_server_config", None)
            missing_config = missing_config_fn() if callable(missing_config_fn) else []
            if missing_config:
                return None, "connector_config_missing"
            return provider, None
        except Exception:
            return None, "connector_unknown"
    if connector_slug == "dummy":
        try:
            return get_provider(connector_slug, {}), None
        except Exception:
            return None, "connector_unknown"
    conn = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.provider_slug == connector_slug)
        .first()
    )
    if not conn:
        return None, "connection_missing"
    if (conn.status or "").lower() != "connected":
        return None, "connection_inactive"
    try:
        creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
    except Exception:
        return None, "credentials_invalid"
    if not isinstance(creds, dict):
        return None, "credentials_invalid"
    try:
        typed_creds: dict[str, Any] = dict(creds)
        typed_creds["_tenant_id"] = tenant_id
        typed_creds = enrich_credentials_with_secrets(db, tenant_id, typed_creds)
        return get_provider(connector_slug, typed_creds), None
    except Exception:
        return None, "connector_unknown"


async def sync_pending_transmissions(limit: int = 200) -> dict:
    summary = {"ok": True, "checked": 0, "updated": 0, "skipped": 0, "errors": 0}
    with SessionLocal() as db:
        rows = (
            db.query(EInvoicingTransmission, Invoice)
            .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
            .filter(EInvoicingTransmission.status.in_(PENDING_STATUSES))
            .order_by(EInvoicingTransmission.updated_at.asc(), EInvoicingTransmission.created_at.asc())
            .limit(limit)
            .all()
        )
        for tx, inv in rows:
            summary["checked"] += 1
            if not tx.external_id:
                summary["skipped"] += 1
                continue
            connector_slug = (tx.channel or "").strip().lower()
            if not connector_slug:
                summary["skipped"] += 1
                continue
            connector, error_code = _resolve_connector(db, inv.tenant_id, connector_slug)
            if not connector:
                summary["skipped"] += 1
                logger.info(
                    json.dumps(
                        {
                            "event": "einvoicing_sync_skip",
                            "connector": connector_slug,
                            "reason": error_code or "unknown",
                        }
                    )
                )
                continue
            try:
                status_result = await connector.poll_transmission_status(tx.external_id)
            except Exception:
                summary["errors"] += 1
                logger.info(
                    json.dumps(
                        {
                            "event": "einvoicing_sync_error",
                            "connector": connector_slug,
                        }
                    )
                )
                continue
            if status_result.status and status_result.status != tx.status:
                update_transmission_status(
                    db,
                    tx=tx,
                    tenant_id=inv.tenant_id,
                    status_result=status_result,
                    source="pdp_sync",
                    actor_user_id=None,
                )
                db.add(tx)
                db.commit()
                summary["updated"] += 1
            else:
                summary["skipped"] += 1
    logger.info(json.dumps({"event": "einvoicing_sync_done", "summary": summary}))
    return summary


def run_sync_pending_transmissions(limit: int = 200) -> dict:
    return asyncio.run(sync_pending_transmissions(limit=limit))


def run_directory_refresh_once(limit: int | None = None) -> dict:
    summary = {"ok": True, "enqueued": 0, "skipped": 0}
    with SessionLocal() as db:
        try:
            summary = enqueue_directory_refresh_all(db, limit=limit)
        except Exception:
            logger.exception("ppf_directory_refresh_enqueue_failed")
            return {
                "ok": False,
                "error": {"code": "ppf_directory_enqueue_failed", "message": "Echec enqueue annuaire PPF."},
            }
    logger.info(json.dumps({"event": "ppf_directory_refresh_enqueued", "summary": summary}))
    return summary


def run() -> int:
    from app.cli.run_periodic_jobs import main

    return main()
