from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..models import BackgroundJob
from ..utils.public_errors import sanitize_public_error_message

JOB_STATUS_QUEUED = "queued"
JOB_STATUS_RUNNING = "running"
JOB_STATUS_SUCCEEDED = "succeeded"
JOB_STATUS_FAILED = "failed"
JOB_STATUS_CANCELLED = "cancelled"
TERMINAL_STATUSES = {JOB_STATUS_SUCCEEDED, JOB_STATUS_FAILED, JOB_STATUS_CANCELLED}


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def input_hash(payload: Any | None) -> str | None:
    if payload is None:
        return None
    raw = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def create_job(
    db: Session,
    *,
    tenant_id: str,
    user_id: str | None,
    job_type: str,
    queue: str,
    input_payload: Any | None = None,
    status: str = JOB_STATUS_QUEUED,
    result_ref: str | None = None,
    expires_in: timedelta | None = None,
    rq_job_id: str | None = None,
) -> BackgroundJob:
    job = BackgroundJob(
        tenant_id=tenant_id,
        user_id=user_id,
        type=job_type,
        status=status,
        queue=queue,
        progress=0,
        input_hash=input_hash(input_payload),
        result_ref=result_ref,
        rq_job_id=rq_job_id,
        expires_at=(utcnow() + expires_in) if expires_in else None,
    )
    db.add(job)
    return job


def get_job_for_tenant(db: Session, *, tenant_id: str, job_id: str) -> BackgroundJob | None:
    return db.query(BackgroundJob).filter(BackgroundJob.id == job_id, BackgroundJob.tenant_id == tenant_id).first()


def list_jobs_for_tenant(
    db: Session,
    *,
    tenant_id: str,
    limit: int = 50,
    offset: int = 0,
    job_type: str | None = None,
    status: str | None = None,
) -> tuple[int, list[BackgroundJob]]:
    query = db.query(BackgroundJob).filter(BackgroundJob.tenant_id == tenant_id)
    if job_type:
        query = query.filter(BackgroundJob.type == job_type)
    if status:
        query = query.filter(BackgroundJob.status == status)
    total = int(query.count() or 0)
    jobs = query.order_by(BackgroundJob.created_at.desc(), BackgroundJob.id.asc()).offset(offset).limit(limit).all()
    return total, jobs


def mark_running(job: BackgroundJob, *, rq_job_id: str | None = None) -> BackgroundJob:
    job.status = JOB_STATUS_RUNNING
    job.started_at = job.started_at or utcnow()
    job.attempts = int(job.attempts or 0) + 1
    if rq_job_id:
        job.rq_job_id = rq_job_id
    return job


def mark_succeeded(job: BackgroundJob, *, result_ref: str | None = None, progress: int = 100) -> BackgroundJob:
    job.status = JOB_STATUS_SUCCEEDED
    job.completed_at = utcnow()
    job.progress = max(0, min(int(progress), 100))
    if result_ref is not None:
        job.result_ref = result_ref
    job.error_code = None
    job.error_message = None
    return job


def mark_failed(
    job: BackgroundJob, *, code: str = "job_failed", message: str = "Le traitement a échoué."
) -> BackgroundJob:
    job.status = JOB_STATUS_FAILED
    job.completed_at = utcnow()
    normalized_code = str(code or "").strip()
    job.error_code = normalized_code if re.fullmatch(r"[a-z][a-z0-9_.:-]{1,79}", normalized_code) else "job_failed"
    job.error_message = sanitize_public_error_message(
        message,
        status_code=500,
        fallback="Le traitement n’a pas pu aboutir. Réessayez dans quelques instants.",
        max_chars=500,
    )
    return job


def update_progress(job: BackgroundJob, progress: int) -> BackgroundJob:
    job.progress = max(0, min(int(progress), 100))
    return job


def serialize_background_job(job: BackgroundJob) -> dict[str, Any]:
    error = None
    if job.error_code or job.error_message:
        error = {
            "code": (
                job.error_code if re.fullmatch(r"[a-z][a-z0-9_.:-]{1,79}", str(job.error_code or "")) else "job_failed"
            ),
            "message": sanitize_public_error_message(
                job.error_message,
                status_code=500,
                fallback="Le traitement n’a pas pu aboutir. Réessayez dans quelques instants.",
                max_chars=500,
            ),
        }
    return {
        "id": job.id,
        "type": job.type,
        "status": job.status,
        "queue": job.queue,
        "progress": int(job.progress or 0),
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "expires_at": job.expires_at.isoformat() if job.expires_at else None,
        "result_available": bool(job.result_ref),
        "error": error,
    }
