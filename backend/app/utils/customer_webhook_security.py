from __future__ import annotations

import ipaddress
import math
import os
import re
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit

from ..config import settings


_DEV_APP_ENVS = frozenset({"dev", "local", "test"})
_DEFAULT_PORTS = {"http": 80, "https": 443}
_METADATA_IPS = frozenset(
    {
        ipaddress.ip_address("169.254.169.254"),
        ipaddress.ip_address("100.100.100.200"),
    }
)
_WELL_KNOWN_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_LOCAL_USE_NAT64 = ipaddress.ip_network("64:ff9b:1::/48")
_DNS_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_DNS_MAX_IN_FLIGHT = 4
_DNS_EXECUTOR = ThreadPoolExecutor(
    max_workers=_DNS_MAX_IN_FLIGHT,
    thread_name_prefix="customer-webhook-dns",
)
_DNS_SLOTS = threading.BoundedSemaphore(_DNS_MAX_IN_FLIGHT)


class CustomerWebhookSecurityError(ValueError):
    """Base error kept internal and sanitized by API/job callers."""


class CustomerWebhookURLRejected(CustomerWebhookSecurityError):
    """The URL or its resolved destination violates the outbound policy."""


class CustomerWebhookResolutionError(CustomerWebhookSecurityError):
    """The DNS result could not be obtained within the bounded window."""


@dataclass(frozen=True, slots=True)
class CustomerWebhookTarget:
    """A customer webhook URL bound to the exact validated socket target."""

    url: str
    connect_url: str
    host_header: str
    sni_hostname: str
    resolved_ip: str


@dataclass(frozen=True, slots=True)
class _ParsedCustomerWebhookURL:
    scheme: str
    host: str
    port: int
    explicit_port: bool
    path: str
    query: str


def _configured_host_policy() -> list[str]:
    raw = str(getattr(settings, "CUSTOMER_WEBHOOK_ALLOWED_HOSTS", None) or "").strip()
    if not raw:
        raw = os.getenv("CUSTOMER_WEBHOOK_ALLOWED_HOSTS", "").strip()
    return [item.strip().lower().rstrip(".") for item in raw.split(",") if item.strip()]


def _dns_timeout_seconds() -> float:
    try:
        value = float(getattr(settings, "WEBHOOK_DNS_TIMEOUT_SECONDS", 3.0) or 3.0)
    except (TypeError, ValueError):
        value = 3.0
    if not math.isfinite(value):
        value = 3.0
    return max(0.1, min(value, 10.0))


def _ascii_dns_host(value: str) -> str:
    host = value.strip().lower().rstrip(".")
    if not host or "%" in host:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: hote invalide.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        try:
            host = host.encode("idna").decode("ascii")
        except (UnicodeError, UnicodeDecodeError) as exc:
            raise CustomerWebhookURLRejected("customer_webhook_blocked: hote invalide.") from exc
        if len(host) > 253 or any(not _DNS_LABEL_RE.fullmatch(label) for label in host.split(".")):
            raise CustomerWebhookURLRejected("customer_webhook_blocked: hote invalide.")
    return host


def _matches_customer_host_policy(host: str, policy: list[str]) -> bool:
    if not policy:
        return True
    for raw_pattern in policy:
        wildcard = raw_pattern.startswith("*.")
        pattern = raw_pattern[2:] if wildcard else raw_pattern
        if not pattern or "*" in pattern or "://" in pattern or any(marker in pattern for marker in ("/", "@", "?")):
            raise CustomerWebhookURLRejected("customer_webhook_blocked: allowlist client invalide.")
        normalized = _ascii_dns_host(pattern)
        if wildcard:
            if host != normalized and host.endswith(f".{normalized}"):
                return True
        elif host == normalized:
            return True
    return False


def _parse_customer_webhook_url(value: str) -> _ParsedCustomerWebhookURL:
    raw = str(value or "").strip()
    if not raw:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: url manquante.")
    if "\\" in raw or any(ord(character) <= 32 or ord(character) == 127 for character in raw):
        raise CustomerWebhookURLRejected("customer_webhook_blocked: url invalide.")
    try:
        parsed: SplitResult = urlsplit(raw)
        username = parsed.username
        password = parsed.password
        parsed_port = parsed.port
    except (UnicodeError, ValueError) as exc:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: url invalide.") from exc

    scheme = parsed.scheme.lower()
    if scheme not in _DEFAULT_PORTS:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: schema non supporte.")
    app_env = str(getattr(settings, "APP_ENV", "") or "").strip().lower()
    if scheme == "http" and app_env not in _DEV_APP_ENVS:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: https requis.")
    if username is not None or password is not None:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: informations utilisateur interdites.")
    if parsed.fragment:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: fragment interdit.")
    if not parsed.netloc or parsed.hostname is None:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: hote manquant.")

    host = _ascii_dns_host(parsed.hostname)
    if host == "localhost":
        raise CustomerWebhookURLRejected("customer_webhook_blocked: localhost interdit.")
    policy = _configured_host_policy()
    if not _matches_customer_host_policy(host, policy):
        raise CustomerWebhookURLRejected("customer_webhook_blocked: hote non autorise.")

    port = parsed_port or _DEFAULT_PORTS[scheme]
    if not 1 <= port <= 65535:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: port invalide.")
    return _ParsedCustomerWebhookURL(
        scheme=scheme,
        host=host,
        port=port,
        explicit_port=parsed_port is not None,
        path=parsed.path,
        query=parsed.query,
    )


def _embedded_ipv4_addresses(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> tuple[ipaddress.IPv4Address, ...]:
    if isinstance(address, ipaddress.IPv4Address):
        return (address,)
    embedded: list[ipaddress.IPv4Address] = []
    if address.ipv4_mapped is not None:
        embedded.append(address.ipv4_mapped)
    if address.sixtofour is not None:
        embedded.append(address.sixtofour)
    if address.teredo is not None:
        embedded.extend(address.teredo)
    if address in _WELL_KNOWN_NAT64 or address in _LOCAL_USE_NAT64:
        embedded.append(ipaddress.IPv4Address(address.packed[-4:]))
    return tuple(embedded)


def _require_public_ip(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> None:
    if address in _METADATA_IPS or not address.is_global:
        raise CustomerWebhookURLRejected("customer_webhook_blocked: destination non publique.")
    for embedded in _embedded_ipv4_addresses(address):
        if embedded in _METADATA_IPS or not embedded.is_global:
            raise CustomerWebhookURLRejected("customer_webhook_blocked: destination non publique.")


def _bounded_getaddrinfo(host: str, port: int) -> list[tuple]:
    timeout = _dns_timeout_seconds()
    deadline = time.monotonic() + timeout
    if not _DNS_SLOTS.acquire(timeout=timeout):
        raise CustomerWebhookResolutionError("customer_webhook_dns_unavailable")
    if time.monotonic() >= deadline:
        _DNS_SLOTS.release()
        raise CustomerWebhookResolutionError("customer_webhook_dns_unavailable")
    try:
        future = _DNS_EXECUTOR.submit(
            socket.getaddrinfo,
            host,
            port,
            family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
    except Exception as exc:
        _DNS_SLOTS.release()
        raise CustomerWebhookResolutionError("customer_webhook_dns_unavailable") from exc

    # A running libc resolver cannot be force-killed safely. Keep at most four
    # in flight and release its slot only when it really finishes.
    future.add_done_callback(lambda _future: _DNS_SLOTS.release())
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            future.cancel()
            raise CustomerWebhookResolutionError("customer_webhook_dns_unavailable")
        answers = future.result(timeout=remaining)
    except FutureTimeoutError as exc:
        future.cancel()
        raise CustomerWebhookResolutionError("customer_webhook_dns_unavailable") from exc
    except OSError as exc:
        raise CustomerWebhookResolutionError("customer_webhook_dns_unavailable") from exc
    return list(answers)


def _resolve_public_ips(
    parsed: _ParsedCustomerWebhookURL,
) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]:
    try:
        literal = ipaddress.ip_address(parsed.host)
    except ValueError:
        answers = _bounded_getaddrinfo(parsed.host, parsed.port)
        resolved: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
        for _family, _socktype, _proto, _canonname, sockaddr in answers:
            if not sockaddr:
                continue
            try:
                address = ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0])
            except ValueError:
                continue
            if address not in resolved:
                resolved.append(address)
    else:
        resolved = [literal]

    if not resolved:
        raise CustomerWebhookResolutionError("customer_webhook_dns_unavailable")
    for address in resolved:
        # Reject the whole DNS answer when it mixes public and non-public
        # targets. Selecting only the public answer would leave failover and
        # later retries open to an unsafe address.
        _require_public_ip(address)
    return tuple(resolved)


def _authority(host: str, port: int, *, include_port: bool) -> str:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        rendered_host = host
    else:
        rendered_host = f"[{host}]" if isinstance(address, ipaddress.IPv6Address) else host
    return f"{rendered_host}:{port}" if include_port else rendered_host


def resolve_customer_webhook_target(value: str) -> CustomerWebhookTarget:
    """Validate once and pin the actual connection to a public resolved IP."""

    parsed = _parse_customer_webhook_url(value)
    addresses = _resolve_public_ips(parsed)
    selected = addresses[0]
    original_authority = _authority(
        parsed.host,
        parsed.port,
        include_port=parsed.explicit_port,
    )
    pinned_authority = _authority(str(selected), parsed.port, include_port=True)
    canonical_url = urlunsplit((parsed.scheme, original_authority, parsed.path, parsed.query, ""))
    connect_url = urlunsplit((parsed.scheme, pinned_authority, parsed.path, parsed.query, ""))
    return CustomerWebhookTarget(
        url=canonical_url,
        connect_url=connect_url,
        host_header=original_authority,
        sni_hostname=parsed.host,
        resolved_ip=str(selected),
    )


def validate_customer_webhook_url(value: str) -> str:
    """Validate a stored endpoint without coupling it to provider allowlists."""

    return resolve_customer_webhook_target(value).url
