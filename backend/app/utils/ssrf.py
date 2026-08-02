from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urlparse

from ..config import settings, _is_prod_env


_BLOCKED_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]

_METADATA_IPS = {
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("100.100.100.200"),
}


def _allow_http_in_dev() -> bool:
    env = (settings.APP_ENV or "").strip().lower()
    return env in {"dev", "local", "test"}


def _allow_http_outbound() -> bool:
    return _allow_http_in_dev() or bool(getattr(settings, "ALLOW_HTTP_OUTBOUND", False))


def _allow_private_outbound() -> bool:
    requested = bool(getattr(settings, "ALLOW_PRIVATE_OUTBOUND", False))
    if requested and _is_prod_env():
        raise ValueError("ssrf_blocked: ALLOW_PRIVATE_OUTBOUND interdit en prod/staging.")
    return requested


def _parse_allowlist() -> list[str]:
    raw = (settings.PLATFORM_ALLOWED_HOSTS or "").strip()
    if not raw:
        raw = os.getenv("PLATFORM_ALLOWED_HOSTS", "")
    return [item.strip().lower() for item in raw.split(",") if item.strip()]


def _matches_allowlist(host: str, allowlist: list[str]) -> bool:
    if not allowlist:
        return True
    host = host.lower()
    for pattern in allowlist:
        if not pattern:
            continue
        if pattern.startswith("*."):
            suffix = pattern[2:]
            if suffix and host.endswith(f".{suffix}") and host != suffix:
                return True
        elif host == pattern:
            return True
    return False


def _is_blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    if ip in _METADATA_IPS:
        return True
    return any(ip in net for net in _BLOCKED_NETS)


def _resolve_ips(host: str, scheme: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        ip = ipaddress.ip_address(host)
        return [ip]
    except ValueError:
        pass
    port = 443 if scheme == "https" else 80
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"ssrf_blocked: resolution dns impossible pour {host}.") from exc
    ips: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for _, _, _, _, sockaddr in infos:
        if not sockaddr:
            continue
        ip_str = sockaddr[0]
        try:
            ips.append(ipaddress.ip_address(ip_str))
        except ValueError:
            continue
    if not ips:
        raise ValueError(f"ssrf_blocked: aucune adresse ip resolue pour {host}.")
    return ips


def validate_outbound_url(url: str) -> str:
    if not url or not str(url).strip():
        raise ValueError("ssrf_blocked: url sortante manquante.")
    raw = str(url).strip()
    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    if not scheme:
        raise ValueError("ssrf_blocked: schema url obligatoire (https).")
    if scheme not in {"https", "http"}:
        raise ValueError("ssrf_blocked: schema url non supporte.")
    if scheme == "http" and not _allow_http_outbound():
        raise ValueError("ssrf_blocked: schema http interdit hors dev.")
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise ValueError("ssrf_blocked: hote url manquant.")
    if host == "localhost":
        raise ValueError("ssrf_blocked: hote localhost interdit.")
    allowlist = _parse_allowlist()
    if _is_prod_env() and not allowlist:
        raise ValueError("ssrf_blocked: PLATFORM_ALLOWED_HOSTS requis en prod.")
    if allowlist and not _matches_allowlist(host, allowlist):
        raise ValueError("ssrf_blocked: hote non autorise par allowlist.")

    ips = _resolve_ips(host, scheme)
    allow_private = _allow_private_outbound()
    for ip in ips:
        if ip.is_loopback:
            raise ValueError("ssrf_blocked: adresse ip locale interdite.")
        if ip.is_link_local or ip in _METADATA_IPS:
            raise ValueError("ssrf_blocked: adresse ip privee ou locale interdite.")
        if not allow_private and _is_blocked_ip(ip):
            raise ValueError("ssrf_blocked: adresse ip privee ou locale interdite.")
    return raw
