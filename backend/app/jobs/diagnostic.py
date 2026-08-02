from __future__ import annotations

import logging
from typing import Any

from redis import Redis
from rq import Queue, Worker

from ..config import settings
from .queue import get_worker_queue_names


logger = logging.getLogger(__name__)

_PROD_ENVS = {"prod", "production", "staging"}


def _workers_required() -> bool:
    env = (settings.APP_ENV or "").strip().lower()
    return env in _PROD_ENVS and not settings.JOBS_SYNC


def _queue_length(queue: Queue) -> int:
    count_attr = getattr(queue, "count", None)
    if callable(count_attr):
        try:
            return int(count_attr())
        except Exception:
            return 0
    if isinstance(count_attr, int):
        return count_attr
    try:
        return int(queue.connection.llen(queue.key))
    except Exception:
        return 0


def collect_jobs_diagnostic() -> dict:
    required = _workers_required()
    result: dict[str, Any] = {
        "redis_ok": False,
        "queues": {},
        "workers": [],
        "workers_count": 0,
        "required": required,
        "mode": "sync" if settings.JOBS_SYNC else "async",
    }
    redis_url = (settings.REDIS_URL or "").strip()
    if not redis_url:
        result["status"] = "error" if required else "warn"
        result["error"] = "REDIS_URL manquant."
        if required:
            result["alert"] = "worker RQ requis"
        return result

    try:
        redis_conn = Redis.from_url(
            redis_url,
            socket_connect_timeout=0.3,
            socket_timeout=0.3,
            decode_responses=False,
        )
        redis_conn.ping()
        result["redis_ok"] = True
    except Exception as exc:
        logger.warning("Redis ping failed in jobs diagnostic: %s", exc)
        result["status"] = "error" if required else "warn"
        result["error"] = "Connexion Redis impossible."
        if required:
            result["alert"] = "worker RQ requis"
        return result

    for queue_name in get_worker_queue_names():
        queue = Queue(name=queue_name, connection=redis_conn)
        result["queues"][queue_name] = _queue_length(queue)

    workers = Worker.all(connection=redis_conn)
    items = []
    for worker in workers:
        try:
            state = worker.get_state()
        except Exception:
            state = getattr(worker, "state", None)
        queues = []
        for q in getattr(worker, "queues", []) or []:
            name = getattr(q, "name", None)
            if name:
                queues.append(name)
        items.append(
            {
                "name": worker.name,
                "state": state,
                "queues": queues,
            }
        )
    result["workers"] = items
    result["workers_count"] = len(items)

    if required and not items:
        result["status"] = "error"
        result["alert"] = "worker RQ requis"
    else:
        result["status"] = "ok"
    return result
