from __future__ import annotations

from contextvars import ContextVar
import json
import logging
import time
from uuid import uuid4

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
_tenant_id: ContextVar[str | None] = ContextVar("tenant_id", default=None)
_user_id: ContextVar[str | None] = ContextVar("user_id", default=None)


def set_request_id(value: str | None) -> None:
    _request_id.set(value)


def set_request_actor(*, tenant_id: str | None, user_id: str | None) -> None:
    if tenant_id is not None:
        _tenant_id.set(tenant_id)
    if user_id is not None:
        _user_id.set(user_id)


def clear_request_context() -> None:
    _request_id.set(None)
    _tenant_id.set(None)
    _user_id.set(None)


def get_request_id() -> str | None:
    return _request_id.get()


def get_tenant_id() -> str | None:
    return _tenant_id.get()


def get_user_id() -> str | None:
    return _user_id.get()


class RequestContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = get_request_id() or "-"
        record.tenant_id = get_tenant_id() or "-"
        record.user_id = get_user_id() or "-"
        return True


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        request_id = (headers.get("x-request-id") or "").strip() or uuid4().hex
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        set_request_id(request_id)

        started = time.monotonic()
        status_code = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", 500)
                raw_headers = list(message.get("headers", []))
                if not any(key.lower() == b"x-request-id" for key, _ in raw_headers):
                    raw_headers.append((b"x-request-id", request_id.encode("ascii")))
                message["headers"] = raw_headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_ms = int((time.monotonic() - started) * 1000)
            route = scope.get("route")
            route_path = getattr(route, "path", None) or scope.get("path", "")
            state = scope.get("state") or {}
            tenant_id = state.get("tenant_id")
            user_id = state.get("user_id")
            logging.getLogger("request").info(
                json.dumps(
                    {
                        "event": "request_completed",
                        "route": route_path,
                        "method": scope.get("method"),
                        "status_code": status_code,
                        "duration_ms": duration_ms,
                        "tenant_id": tenant_id,
                        "user_id": user_id,
                    },
                    separators=(",", ":"),
                )
            )
            clear_request_context()
