from __future__ import annotations

import ipaddress
import logging
from typing import Iterable, Sequence

from starlette.datastructures import Headers


logger = logging.getLogger(__name__)


def _parse_ip(value: str | None) -> ipaddress._BaseAddress | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.lower() == "unknown":
        return None
    if raw.startswith("[") and "]" in raw:
        raw = raw[1:raw.index("]")]
    if ":" in raw and raw.count(":") == 1 and "." in raw:
        raw = raw.split(":", 1)[0]
    try:
        return ipaddress.ip_address(raw)
    except ValueError:
        return None


def parse_trusted_cidrs(values: str | Iterable[str] | None) -> list[ipaddress._BaseNetwork]:
    if values is None:
        return []
    items: list[str] = []
    if isinstance(values, str):
        items = [item.strip() for item in values.split(",") if item.strip()]
    else:
        items = [str(item).strip() for item in values if str(item).strip()]
    networks: list[ipaddress._BaseNetwork] = []
    for item in items:
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            logger.warning("trusted_proxy_cidr_invalid", extra={"cidr": item})
    return networks


def _is_trusted_ip(ip_value: str, networks: Sequence[ipaddress._BaseNetwork], trust_all: bool) -> bool:
    if trust_all:
        return _parse_ip(ip_value) is not None
    ip_addr = _parse_ip(ip_value)
    if ip_addr is None:
        return False
    return any(ip_addr in net for net in networks)


def resolve_client_ip(
    peer_ip: str | None,
    x_forwarded_for: str | None,
    trusted_networks: Sequence[ipaddress._BaseNetwork],
    *,
    trust_all: bool = False,
) -> str | None:
    if not peer_ip:
        return None
    if not _is_trusted_ip(peer_ip, trusted_networks, trust_all):
        return peer_ip
    if not x_forwarded_for:
        return peer_ip
    candidates: list[str] = []
    for part in x_forwarded_for.split(","):
        part = part.strip()
        if not part:
            continue
        if _parse_ip(part) is None:
            continue
        candidates.append(part)
    if not candidates:
        return peer_ip
    client_ip: str | None = None
    for ip_value in reversed(candidates):
        if not _is_trusted_ip(ip_value, trusted_networks, trust_all):
            client_ip = ip_value
            break
    if client_ip is None:
        client_ip = candidates[0]
    return client_ip or peer_ip


def resolve_scheme(x_forwarded_proto: str | None) -> str | None:
    if not x_forwarded_proto:
        return None
    raw = x_forwarded_proto.split(",", 1)[0].strip().lower()
    if raw in {"http", "https"}:
        return raw
    return None


class TrustedProxyHeadersMiddleware:
    def __init__(
        self,
        app,
        *,
        trusted_cidrs: str | Iterable[str] | None = None,
        trust_all: bool = False,
    ) -> None:
        self.app = app
        self.trust_all = bool(trust_all)
        self.trusted_networks = parse_trusted_cidrs(trusted_cidrs)

    async def __call__(self, scope, receive, send):
        if scope.get("type") not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        peer_ip = None
        peer_port = 0
        if client and isinstance(client, (list, tuple)) and len(client) >= 1:
            peer_ip = client[0]
            if len(client) > 1 and isinstance(client[1], int):
                peer_port = client[1]
        peer_addr = _parse_ip(peer_ip)
        if peer_addr is None:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        xff = headers.get("x-forwarded-for")
        xfp = headers.get("x-forwarded-proto")
        if _is_trusted_ip(peer_ip, self.trusted_networks, self.trust_all):
            resolved_scheme = resolve_scheme(xfp)
            if resolved_scheme:
                scope["scheme"] = resolved_scheme
            resolved_ip = resolve_client_ip(
                peer_ip,
                xff,
                self.trusted_networks,
                trust_all=self.trust_all,
            )
            if resolved_ip and resolved_ip != peer_ip:
                scope["client"] = (resolved_ip, peer_port)
        await self.app(scope, receive, send)
