from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_viewer_or_admin_or_api_key, API_SCOPE_READ_JOBS
from ..jobs.queue import get_job_status
from ..services.background_jobs import get_job_for_tenant, list_jobs_for_tenant, serialize_background_job


router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _pagination_headers(request: Request, response: Response, *, total: int, limit: int, offset: int) -> None:
    response.headers["X-Total-Count"] = str(total)
    links: list[str] = []
    if offset + limit < total:
        links.append(f"<{request.url.include_query_params(limit=limit, offset=offset + limit)}>; rel=\"next\"")
    if offset > 0:
        links.append(f"<{request.url.include_query_params(limit=limit, offset=max(0, offset - limit))}>; rel=\"prev\"")
    if links:
        response.headers["Link"] = ", ".join(links)


@router.get("")
def list_jobs(
    request: Request,
    response: Response,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    type: str | None = Query(None),
    status: str | None = Query(None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_JOBS})),
):
    total, jobs = list_jobs_for_tenant(
        db,
        tenant_id=user.tenant_id,
        limit=limit,
        offset=offset,
        job_type=(type or None),
        status=(status or None),
    )
    _pagination_headers(request, response, total=total, limit=limit, offset=offset)
    return [serialize_background_job(job) for job in jobs]


@router.get("/{job_id}")
def job_status(
    job_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_JOBS})),
):
    persisted = get_job_for_tenant(db, tenant_id=user.tenant_id, job_id=job_id)
    if persisted:
        return serialize_background_job(persisted)
    job = get_job_status(job_id)
    if not job:
        raise HTTPException(404, "Not found")
    tenant_id = (job.get("meta") or {}).get("tenant_id")
    if not tenant_id or tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    job.pop("meta", None)
    return job
