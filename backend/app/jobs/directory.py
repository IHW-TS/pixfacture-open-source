import logging
from datetime import datetime, timedelta, timezone

from redis import Redis
from rq.job import Job
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..jobs.queue import enqueue_job, get_queue_name, is_sync_mode
from ..models import Customer, DirectorySyncRun
from ..services.directory import DirectoryLookupInput, sync_bulk, is_ppf_configured
from ..services.connected_mode import connected_mode_decision

logger = logging.getLogger(__name__)


def _normalize_digits(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _build_inputs(customers: list[Customer]) -> list[DirectoryLookupInput]:
    inputs: list[DirectoryLookupInput] = []
    seen: set[tuple[str, str | None]] = set()
    for customer in customers:
        siret = _normalize_digits(customer.siret) if customer.siret else None
        siren = _normalize_digits(customer.siren) or (siret[:9] if siret else None)
        if not siren:
            continue
        key = (siren, siret or None)
        if key in seen:
            continue
        seen.add(key)
        inputs.append(DirectoryLookupInput(siren=siren, siret=siret or None))
    return inputs


def refresh_directory_entries(tenant_id: str) -> dict:
    started_at = datetime.now(timezone.utc).replace(tzinfo=None)
    summary: dict = {"ok": False, "requested": 0, "found": 0, "created": 0, "updated": 0, "skipped": 0, "errors": 0}
    with SessionLocal() as db:
        access = connected_mode_decision(db, tenant_id, "ppf")
        if not access.allowed:
            return {
                "ok": True,
                "requested": 0,
                "found": 0,
                "created": 0,
                "updated": 0,
                "skipped": 1,
                "errors": 0,
                "blocked_reason": access.code or "connected_mode_not_operational",
            }
        run = DirectorySyncRun(
            tenant_id=tenant_id,
            source="ppf",
            status="running",
            started_at=started_at,
            created_at=started_at,
        )
        db.add(run)
        db.commit()
        db.refresh(run)

        try:
            if not is_ppf_configured():
                summary = {
                    "ok": False,
                    "error": {"code": "ppf_not_configured", "message": "Annuaire PPF non configure."},
                }
                run.status = "failed"
            else:
                customers = (
                    db.query(Customer)
                    .filter(Customer.tenant_id == tenant_id)
                    .order_by(Customer.created_at.desc())
                    .all()
                )
                inputs = _build_inputs(customers)
                summary = sync_bulk(db, tenant_id, inputs)
                if summary.get("ok") and summary.get("errors", 0) == 0:
                    run.status = "success"
                elif summary.get("ok"):
                    run.status = "partial"
                else:
                    run.status = "failed"
        except Exception:
            logger.exception("ppf_directory_refresh_failed", extra={"tenant_id": tenant_id})
            run.status = "failed"
            summary = {"ok": False, "error": {"code": "ppf_refresh_failed", "message": "Synchro annuaire PPF echouee."}}

        run.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
        if summary.get("ok"):
            run.total_requested = int(summary.get("requested", 0) or 0)
            run.total_found = int(summary.get("found", 0) or 0)
            run.total_created = int(summary.get("created", 0) or 0)
            run.total_updated = int(summary.get("updated", 0) or 0)
            run.total_skipped = int(summary.get("skipped", 0) or 0)
            run.total_errors = int(summary.get("errors", 0) or 0)
        else:
            error = summary.get("error") or {}
            run.error_message = error.get("message")
            run.total_errors = int(summary.get("errors", 1) or 1)
        db.add(run)
        db.commit()
    return summary


def enqueue_directory_refresh(tenant_id: str) -> dict:
    return enqueue_job(
        refresh_directory_entries,
        tenant_id,
        meta={"tenant_id": tenant_id, "job": "ppf_directory_refresh"},
    )


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _directory_refresh_interval_seconds() -> int:
    raw_interval = getattr(settings, "DIRECTORY_SYNC_INTERVAL_SECONDS", 86400) or 86400
    try:
        interval = int(raw_interval)
    except (TypeError, ValueError):
        interval = 86400
    return max(interval, 60)


def _run_timestamp(run: DirectorySyncRun | None) -> datetime | None:
    if not run:
        return None
    return run.finished_at or run.started_at or run.created_at


def _directory_refresh_skip_reason(db: Session, tenant_id: str) -> str | None:
    interval_seconds = _directory_refresh_interval_seconds()
    now = _utcnow_naive()
    running_cutoff = now - timedelta(
        seconds=max(interval_seconds, int(getattr(settings, "JOBS_TIMEOUT_SECONDS", 900) or 900))
    )
    recent_cutoff = now - timedelta(seconds=interval_seconds)

    running = (
        db.query(DirectorySyncRun)
        .filter(
            DirectorySyncRun.tenant_id == tenant_id,
            DirectorySyncRun.source == "ppf",
            DirectorySyncRun.status == "running",
        )
        .order_by(DirectorySyncRun.started_at.desc())
        .first()
    )
    running_at = _run_timestamp(running)
    if running_at and running_at >= running_cutoff:
        return "inflight"

    completed = (
        db.query(DirectorySyncRun)
        .filter(
            DirectorySyncRun.tenant_id == tenant_id,
            DirectorySyncRun.source == "ppf",
            DirectorySyncRun.status.in_(("success", "partial", "failed")),
        )
        .order_by(DirectorySyncRun.finished_at.desc(), DirectorySyncRun.started_at.desc())
        .first()
    )
    completed_at = _run_timestamp(completed)
    if completed_at and completed_at >= recent_cutoff:
        return "recent"
    return None


def _queued_directory_refresh_tenant_ids() -> set[str]:
    redis_url = (settings.REDIS_URL or "").strip()
    if is_sync_mode() or not redis_url:
        return set()
    try:
        redis_conn = Redis.from_url(redis_url, decode_responses=False)
        raw_job_ids = redis_conn.lrange(f"rq:queue:{get_queue_name()}", 0, -1)
        tenant_ids: set[str] = set()
        for raw_job_id in raw_job_ids:
            job_id = raw_job_id.decode("utf-8") if isinstance(raw_job_id, bytes) else str(raw_job_id)
            try:
                job = Job.fetch(job_id, connection=redis_conn)
            except Exception:
                continue
            meta = job.meta or {}
            if meta.get("job") != "ppf_directory_refresh":
                continue
            tenant_id = str(meta.get("tenant_id") or "").strip()
            if tenant_id:
                tenant_ids.add(tenant_id)
        return tenant_ids
    except Exception:
        logger.warning("ppf_directory_queue_inspection_failed", exc_info=True)
        return set()


def enqueue_directory_refresh_all(db: Session, limit: int | None = None) -> dict:
    summary = {
        "ok": True,
        "enqueued": 0,
        "skipped": 0,
        "skipped_recent": 0,
        "skipped_inflight": 0,
        "skipped_queued": 0,
        "skipped_not_configured": 0,
        "skipped_not_operational": 0,
    }
    if not is_ppf_configured():
        summary["skipped_not_configured"] = 1
        return summary
    queued_tenant_ids = _queued_directory_refresh_tenant_ids()
    query = (
        db.query(Customer.tenant_id)
        .filter(Customer.siren.isnot(None) | Customer.siret.isnot(None))
        .group_by(Customer.tenant_id)
    )
    if limit:
        query = query.limit(limit)
    tenants = query.all()
    for (tenant_id,) in tenants:
        if not tenant_id:
            summary["skipped"] += 1
            continue
        if not connected_mode_decision(db, tenant_id, "ppf").allowed:
            summary["skipped"] += 1
            summary["skipped_not_operational"] += 1
            continue
        if tenant_id in queued_tenant_ids:
            summary["skipped"] += 1
            summary["skipped_queued"] += 1
            continue
        skip_reason = _directory_refresh_skip_reason(db, tenant_id)
        if skip_reason == "recent":
            summary["skipped"] += 1
            summary["skipped_recent"] += 1
            continue
        if skip_reason == "inflight":
            summary["skipped"] += 1
            summary["skipped_inflight"] += 1
            continue
        enqueue_directory_refresh(tenant_id)
        summary["enqueued"] += 1
    return summary
