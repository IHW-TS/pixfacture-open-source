from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks
from fastapi.responses import Response

from ..db import SessionLocal
from ..deps import AuthUser
from ..models import BackgroundJob, Membership, User
from ..services.background_jobs import mark_failed, mark_running, mark_succeeded, update_progress
from ..services.document_attachments import sanitize_filename
from ..services.storage import put_object

logger = logging.getLogger(__name__)


def _job_user(db, job: BackgroundJob) -> User | None:
    if job.user_id:
        user = db.get(User, job.user_id)
        if user:
            return user
    row = (
        db.query(Membership, User)
        .join(User, User.id == Membership.user_id)
        .filter(Membership.tenant_id == job.tenant_id, Membership.role.in_(("owner", "admin")))
        .order_by(Membership.role.desc(), User.created_at.asc())
        .first()
    )
    return row[1] if row else None


def _auth_user_for_job(db, job: BackgroundJob) -> AuthUser:
    user = _job_user(db, job)
    if not user:
        raise RuntimeError("Utilisateur export introuvable.")
    role = "owner"
    membership = (
        db.query(Membership)
        .filter(Membership.tenant_id == job.tenant_id, Membership.user_id == user.id)
        .order_by(Membership.role.desc())
        .first()
    )
    if membership and membership.role:
        role = membership.role
    return AuthUser(
        id=str(user.id),
        email=str(user.email),
        tenant_id=str(job.tenant_id),
        role=role,
        is_admin=bool(user.is_admin),
        is_support=bool(user.is_support),
        mfa_enabled=bool(user.mfa_enabled),
    )


def _filename_from_response(response: Response, fallback: str) -> str:
    disposition = response.headers.get("content-disposition") or ""
    match = re.search(r'filename="?([^";]+)"?', disposition)
    return sanitize_filename(match.group(1) if match else fallback)


def _response_bytes(response: Response) -> bytes:
    body = getattr(response, "body", None)
    if isinstance(body, bytes):
        return body
    path = getattr(response, "path", None)
    if path:
        return Path(path).read_bytes()
    raise RuntimeError("Réponse export non matérialisée.")


def _cleanup_response_file(response: Response) -> None:
    path = getattr(response, "path", None)
    if not path:
        return
    try:
        Path(path).unlink(missing_ok=True)
    except Exception:
        logger.warning("export_temp_cleanup_failed", extra={"path": str(path)})


def _build_export_response(db, user: AuthUser, payload: dict[str, Any]) -> tuple[Response, str]:
    export_format = str(payload.get("format") or "tenant_zip").strip().lower()
    filters = payload.get("filters") if isinstance(payload.get("filters"), dict) else {}
    if export_format == "tenant_zip":
        from ..routers.exports import export_tenant_data_zip

        return export_tenant_data_zip(db=db, user=user), "export-tenant.zip"
    if export_format == "cabinet_zip":
        from ..routers.exports import download_accounting_cabinet_package

        response = download_accounting_cabinet_package(
            start_date=filters.get("start_date"),
            end_date=filters.get("end_date"),
            customer_id=filters.get("customer_id"),
            force_export=bool(filters.get("force_export")),
            strict_quality=bool(filters.get("strict_quality", True)),
            db=db,
            user=user,
            _=user,
        )
        return response, "dossier-controle-compta.zip"
    if export_format == "archive_zip":
        from ..routers.company import export_archive

        response = export_archive(
            background_tasks=BackgroundTasks(),
            start_date=filters.get("start_date"),
            end_date=filters.get("end_date"),
            invoice_ids=filters.get("invoice_ids"),
            q=filters.get("q"),
            customer_id=filters.get("customer_id"),
            status=filters.get("status"),
            force_export=bool(filters.get("force_export")),
            db=db,
            user=user,
        )
        return response, "archive.zip"
    raise RuntimeError(f"Format d'export asynchrone non pris en charge: {export_format}.")


def process_export_job(job_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    with SessionLocal() as db:
        job = db.get(BackgroundJob, job_id)
        if not job or job.type != "export":
            return {"ok": False, "error": {"code": "export_job_not_found", "message": "Export introuvable."}}
        try:
            mark_running(job)
            update_progress(job, 5)
            db.add(job)
            db.commit()
            db.refresh(job)

            user = _auth_user_for_job(db, job)
            response, fallback_filename = _build_export_response(db, user, payload)
            try:
                content = _response_bytes(response)
            finally:
                _cleanup_response_file(response)
            if not content:
                raise RuntimeError("Export vide.")
            filename = _filename_from_response(response, fallback_filename)
            content_type = response.headers.get("content-type") or getattr(response, "media_type", None) or "application/zip"
            storage_key = f"exports/{job.tenant_id}/{job.id}/{filename}"
            put_object(storage_key, content, str(content_type).split(";", 1)[0] or "application/zip")

            result_ref = json.dumps(
                {
                    "storage_key": storage_key,
                    "filename": filename,
                    "content_type": str(content_type).split(";", 1)[0] or "application/zip",
                    "size": len(content),
                },
                separators=(",", ":"),
            )
            mark_succeeded(job, result_ref=result_ref)
            db.add(job)
            db.commit()
            return {"ok": True, "job_id": job.id, "storage_key": storage_key}
        except Exception:
            db.rollback()
            public_message = "L’export n’a pas pu être généré. Réessayez dans quelques instants."
            job = db.get(BackgroundJob, job_id)
            if job:
                mark_failed(job, code="export_job_failed", message=public_message)
                db.add(job)
                db.commit()
            logger.exception("export_job_failed", extra={"job_id": job_id})
            return {"ok": False, "error": {"code": "export_job_failed", "message": public_message}}
