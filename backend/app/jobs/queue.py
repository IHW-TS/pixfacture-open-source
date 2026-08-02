import logging
import re
from uuid import uuid4

from redis import Redis
from rq import Queue
from rq.exceptions import NoSuchJobError
from rq.job import Job

from ..config import settings, _is_prod_env
from ..utils.public_errors import public_error_fallback, sanitize_public_error_message


logger = logging.getLogger(__name__)
_redis_client: Redis | None = None
_local_jobs: dict[str, dict] = {}


def is_sync_mode() -> bool:
    if settings.JOBS_SYNC:
        return True
    if not (settings.REDIS_URL or "").strip() and not _is_prod_env():
        return True
    return False


QUEUE_KINDS = ("default", "critical", "emails", "pdf", "exports", "integrations", "low")


def get_queue_name() -> str:
    return (settings.JOBS_QUEUE_NAME or "default").strip() or "default"


def get_email_queue_name() -> str:
    return (
        getattr(settings, "EMAIL_JOBS_QUEUE_NAME", None) or getattr(settings, "JOBS_QUEUE_EMAILS", None) or "emails"
    ).strip() or "emails"


def queue_name_for(kind: str | None) -> str:
    key = (kind or "default").strip().lower()
    mapping = {
        "default": get_queue_name(),
        "critical": getattr(settings, "JOBS_QUEUE_CRITICAL", "critical"),
        "emails": get_email_queue_name(),
        "email": get_email_queue_name(),
        "pdf": getattr(settings, "JOBS_QUEUE_PDF", "pdf"),
        "exports": getattr(settings, "JOBS_QUEUE_EXPORTS", "exports"),
        "export": getattr(settings, "JOBS_QUEUE_EXPORTS", "exports"),
        "integrations": getattr(settings, "JOBS_QUEUE_INTEGRATIONS", "integrations"),
        "integration": getattr(settings, "JOBS_QUEUE_INTEGRATIONS", "integrations"),
        "low": getattr(settings, "JOBS_QUEUE_LOW", "low"),
    }
    return (mapping.get(key) or key or get_queue_name()).strip()


def get_worker_queue_names() -> list[str]:
    names: list[str] = []
    for kind in QUEUE_KINDS:
        queue = queue_name_for(kind)
        if queue and queue not in names:
            names.append(queue)
    return names


def _get_redis_connection() -> Redis:
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    redis_url = (settings.REDIS_URL or "").strip()
    if not redis_url:
        raise RuntimeError("REDIS_URL requis pour les jobs async.")
    _redis_client = Redis.from_url(redis_url, decode_responses=False)
    return _redis_client


def _public_job_error(value) -> dict:
    raw = value if isinstance(value, dict) else {}
    try:
        status_code = int(raw.get("status_code") or 500)
    except (TypeError, ValueError):
        status_code = 500
    if status_code < 400 or status_code > 599:
        status_code = 500
    raw_code = str(raw.get("code") or "job_failed").strip()
    code = raw_code if re.fullmatch(r"[a-z][a-z0-9_.:-]{1,79}", raw_code) else "job_failed"
    error: dict[str, object] = {
        "code": code,
        "message": sanitize_public_error_message(
            raw.get("message"),
            status_code=status_code,
            fallback=(
                "Le traitement n’a pas pu aboutir. Réessayez dans quelques instants."
                if status_code >= 500
                else public_error_fallback(status_code)
            ),
        ),
    }
    if "status_code" in raw:
        error["status_code"] = status_code
    raw_errors = raw.get("errors") or []
    if isinstance(raw_errors, (list, tuple)):
        errors = [
            sanitize_public_error_message(
                item,
                status_code=status_code,
                fallback="Une donnée doit être corrigée.",
                max_chars=500,
            )
            for item in raw_errors[:100]
            if isinstance(item, str)
        ]
        if errors:
            error["errors"] = errors
    raw_fields = raw.get("fields") or []
    if isinstance(raw_fields, (list, tuple)):
        fields = [
            field
            for field in raw_fields[:100]
            if isinstance(field, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", field)
        ]
        if fields:
            error["fields"] = fields
    return error


def _sanitize_failed_result(result):
    if not isinstance(result, dict) or result.get("ok") is not False:
        return result
    return {**result, "error": _public_job_error(result.get("error"))}


def _build_error(message: str) -> dict:
    return _public_job_error({"code": "job_failed", "message": message})


def enqueue_job(
    func,
    *args,
    meta: dict | None = None,
    queue_name: str | None = None,
    at_front: bool = False,
    retry=None,
    job_timeout: int | None = None,
    result_ttl: int | None = None,
    description: str | None = None,
    **kwargs,
) -> dict:
    job_meta = meta or {}
    if is_sync_mode():
        job_id = f"local-{uuid4().hex}"
        record = {
            "id": job_id,
            "status": "queued",
            "progress": None,
            "result": None,
            "error": None,
            "meta": job_meta,
        }
        _local_jobs[job_id] = record
        try:
            record["status"] = "started"
            result = _sanitize_failed_result(func(*args, **kwargs))
            record["result"] = result
            if isinstance(result, dict) and result.get("ok") is False:
                record["error"] = result.get("error")
            record["status"] = "finished"
        except Exception as exc:
            record["status"] = "failed"
            record["error"] = _build_error(str(exc))
        return {
            "job_id": job_id,
            "status": record["status"],
            "result": record["result"],
            "error": record["error"],
        }
    queue = Queue(
        name=queue_name_for(queue_name),
        connection=_get_redis_connection(),
        is_async=True,
    )
    timeout = int(job_timeout or getattr(settings, "JOBS_TIMEOUT_SECONDS", 900) or 900)
    ttl = int(result_ttl or getattr(settings, "JOBS_RESULT_TTL", 3600) or 3600)
    enqueue_kwargs = {
        "job_timeout": timeout,
        "result_ttl": ttl,
        "meta": job_meta,
    }
    if retry is not None:
        enqueue_kwargs["retry"] = retry
    if at_front:
        enqueue_kwargs["at_front"] = True
    if description:
        enqueue_kwargs["description"] = description
    job = queue.enqueue(
        func,
        *args,
        **kwargs,
        **enqueue_kwargs,
    )
    return {"job_id": job.id, "status": job.get_status()}


def get_job_status(job_id: str) -> dict | None:
    if job_id in _local_jobs:
        record = _local_jobs[job_id]
        error = record.get("error")
        result = record.get("result")
        if not error and isinstance(result, dict) and result.get("ok") is False:
            error = result.get("error")
        if error:
            error = _public_job_error(error)
        result = _sanitize_failed_result(result)
        return {
            "id": record["id"],
            "status": record["status"],
            "progress": record.get("progress"),
            "result": result,
            "error": error,
            "meta": record.get("meta") or {},
        }
    try:
        job = Job.fetch(job_id, connection=_get_redis_connection())
    except NoSuchJobError:
        return None
    except Exception:
        logger.exception("jobs_fetch_failed", extra={"job_id": job_id})
        return None
    status = job.get_status()
    meta = job.meta or {}
    result = job.result
    error = meta.get("error")
    if not error and isinstance(result, dict) and result.get("ok") is False:
        error = result.get("error")
    if status == "failed" and not error:
        error = _build_error("Le job a échoué.")
    if error:
        error = _public_job_error(error)
    result = _sanitize_failed_result(result)
    return {
        "id": job.id,
        "status": status,
        "progress": meta.get("progress"),
        "result": result,
        "error": error,
        "meta": meta,
    }


def reset_local_jobs() -> None:
    _local_jobs.clear()


def reset_redis_connection() -> None:
    global _redis_client
    _redis_client = None
