import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import or_

from ..db import SessionLocal
from ..models import EReportingEvent, EReportingReport, Tenant
from ..services.ereporting import PENDING_STATUSES, send_ereporting_events
from ..services.ereporting_builder import build_reports
from ..services.ereporting_reports import REPORT_PENDING_STATUSES, send_ereporting_reports
from ..services.connected_mode import connected_mode_decision

logger = logging.getLogger(__name__)


def _connected_mode_skip(code: str | None) -> dict:
    return {
        "ok": True,
        "checked": 0,
        "sent": 0,
        "failed": 0,
        "skipped": 1,
        "errors": 0,
        "blocked_reason": code or "connected_mode_not_operational",
    }


async def send_ereporting_for_tenant(
    tenant_id: str,
    provider_slug: str | None = None,
    event_ids: list[str] | None = None,
    limit: int | None = None,
) -> dict:
    with SessionLocal() as db:
        access = connected_mode_decision(db, tenant_id, provider_slug)
        if not access.allowed and (provider_slug is not None or access.code != "connected_mode_not_operational"):
            return _connected_mode_skip(access.code)
        return await send_ereporting_events(
            db,
            tenant_id=tenant_id,
            provider_slug=provider_slug,
            event_ids=event_ids,
            limit=limit,
        )


async def process_due_ereporting(limit_per_tenant: int | None = None) -> dict:
    summary = {"ok": True, "tenants": 0, "checked": 0, "sent": 0, "failed": 0, "skipped": 0, "errors": 0}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with SessionLocal() as db:
        tenant_ids = (
            db.query(EReportingEvent.tenant_id)
            .filter(EReportingEvent.status.in_(PENDING_STATUSES))
            .filter(or_(EReportingEvent.next_retry_at.is_(None), EReportingEvent.next_retry_at <= now))
            .distinct()
            .all()
        )
        for (tenant_id,) in tenant_ids:
            summary["tenants"] += 1
            # Re-evaluate the tenant's paid/connected-mode status at execution
            # time. A queued retry must not survive a transition to trial.
            result = await send_ereporting_for_tenant(
                tenant_id=tenant_id,
                limit=limit_per_tenant,
            )
            for key in ("checked", "sent", "failed", "skipped", "errors"):
                summary[key] += int(result.get(key, 0) or 0)
    logger.info(json.dumps({"event": "ereporting_retry_done", "summary": summary}))
    return summary


def run_process_due_ereporting(limit_per_tenant: int | None = None) -> dict:
    return asyncio.run(process_due_ereporting(limit_per_tenant=limit_per_tenant))


def run_send_ereporting_for_tenant(
    tenant_id: str,
    provider_slug: str | None = None,
    event_ids: list[str] | None = None,
    limit: int | None = None,
) -> dict:
    return asyncio.run(
        send_ereporting_for_tenant(
            tenant_id=tenant_id,
            provider_slug=provider_slug,
            event_ids=event_ids,
            limit=limit,
        )
    )


def send_ereporting_job(
    tenant_id: str,
    provider_slug: str | None = None,
    event_ids: list[str] | None = None,
    limit: int | None = None,
) -> dict:
    return run_send_ereporting_for_tenant(
        tenant_id=tenant_id,
        provider_slug=provider_slug,
        event_ids=event_ids,
        limit=limit,
    )


async def generate_ereporting_reports_for_tenant(
    tenant_id: str,
    period_start=None,
    period_end=None,
    report_type: str | None = None,
    provider_slug: str | None = None,
    today=None,
) -> dict:
    with SessionLocal() as db:
        reports = build_reports(
            db,
            tenant_id=tenant_id,
            period_start=period_start,
            period_end=period_end,
            report_type=report_type,
            provider_slug=provider_slug,
            today=today,
        )
        return {"ok": True, "created": len(reports), "report_ids": [r.id for r in reports]}


async def process_ereporting_generation(
    period_start=None,
    period_end=None,
    report_type: str | None = None,
    limit_per_tenant: int | None = None,
) -> dict:
    summary = {"ok": True, "tenants": 0, "created": 0}
    today = datetime.now(timezone.utc).replace(tzinfo=None).date()
    with SessionLocal() as db:
        tenant_ids = db.query(Tenant.id).limit(limit_per_tenant or 1000).all()
        for (tenant_id,) in tenant_ids:
            summary["tenants"] += 1
            result = await generate_ereporting_reports_for_tenant(
                tenant_id=tenant_id,
                period_start=period_start,
                period_end=period_end,
                report_type=report_type,
                today=today,
            )
            summary["created"] += int(result.get("created", 0) or 0)
    logger.info(json.dumps({"event": "ereporting_generation_done", "summary": summary}))
    return summary


async def send_ereporting_reports_for_tenant(
    tenant_id: str,
    provider_slug: str | None = None,
    report_ids: list[str] | None = None,
    limit: int | None = None,
) -> dict:
    with SessionLocal() as db:
        access = connected_mode_decision(db, tenant_id, provider_slug)
        if not access.allowed and (provider_slug is not None or access.code != "connected_mode_not_operational"):
            return _connected_mode_skip(access.code)
        return await send_ereporting_reports(
            db,
            tenant_id=tenant_id,
            provider_slug=provider_slug,
            report_ids=report_ids,
            limit=limit,
        )


async def process_due_ereporting_reports(limit_per_tenant: int | None = None) -> dict:
    summary = {"ok": True, "tenants": 0, "checked": 0, "sent": 0, "failed": 0, "skipped": 0, "errors": 0}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with SessionLocal() as db:
        tenant_ids = (
            db.query(EReportingReport.tenant_id)
            .filter(EReportingReport.status.in_(REPORT_PENDING_STATUSES))
            .filter(or_(EReportingReport.next_retry_at.is_(None), EReportingReport.next_retry_at <= now))
            .distinct()
            .all()
        )
        for (tenant_id,) in tenant_ids:
            summary["tenants"] += 1
            result = await send_ereporting_reports_for_tenant(
                tenant_id=tenant_id,
                limit=limit_per_tenant,
            )
            for key in ("checked", "sent", "failed", "skipped", "errors"):
                summary[key] += int(result.get(key, 0) or 0)
    logger.info(json.dumps({"event": "ereporting_report_retry_done", "summary": summary}))
    return summary


def run_process_due_ereporting_reports(limit_per_tenant: int | None = None) -> dict:
    return asyncio.run(process_due_ereporting_reports(limit_per_tenant=limit_per_tenant))


def run_generate_ereporting_reports(
    period_start=None,
    period_end=None,
    report_type: str | None = None,
    limit_per_tenant: int | None = None,
) -> dict:
    return asyncio.run(
        process_ereporting_generation(
            period_start=period_start,
            period_end=period_end,
            report_type=report_type,
            limit_per_tenant=limit_per_tenant,
        )
    )


def send_ereporting_reports_job(
    tenant_id: str,
    provider_slug: str | None = None,
    report_ids: list[str] | None = None,
    limit: int | None = None,
) -> dict:
    return asyncio.run(
        send_ereporting_reports_for_tenant(
            tenant_id=tenant_id,
            provider_slug=provider_slug,
            report_ids=report_ids,
            limit=limit,
        )
    )


def generate_ereporting_reports_job(
    tenant_id: str,
    period_start=None,
    period_end=None,
    report_type: str | None = None,
    provider_slug: str | None = None,
) -> dict:
    return asyncio.run(
        generate_ereporting_reports_for_tenant(
            tenant_id=tenant_id,
            period_start=period_start,
            period_end=period_end,
            report_type=report_type,
            provider_slug=provider_slug,
        )
    )
