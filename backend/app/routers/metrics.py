import secrets

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import PlainTextResponse

from .. import metrics
from ..config import settings

router = APIRouter(tags=["metrics"])


@router.get("/metrics", response_class=PlainTextResponse)
def get_metrics(authorization: str | None = Header(default=None)):
    env = (settings.APP_ENV or "").strip().lower()
    token = (settings.METRICS_BEARER_TOKEN or "").strip()
    if not token and env in {"prod", "production", "staging"}:
        raise HTTPException(status_code=404, detail="Not Found")
    if token:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Unauthorized")
        provided = authorization.split(" ", 1)[1].strip()
        if not secrets.compare_digest(provided, token):
            raise HTTPException(status_code=401, detail="Unauthorized")
    payload = metrics.render_prometheus()
    return PlainTextResponse(payload, media_type="text/plain; version=0.0.4")
