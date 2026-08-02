from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse, unquote
import ipaddress

from ..config import settings

TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "templates"
STATIC_DIR = TEMPLATE_DIR / "static"
LOGO_DIR = STATIC_DIR / "logos"


def ensure_static_dirs() -> None:
    LOGO_DIR.mkdir(parents=True, exist_ok=True)


def _normalize_host(value: str | None) -> str:
    return (value or "").strip().lower().strip(".")


def is_private_host(host: str) -> bool:
    normalized = _normalize_host(host)
    if not normalized:
        return True
    if normalized in {"localhost", "localhost.localdomain"}:
        return True
    try:
        ip = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
    )


def allowed_cdn_hosts() -> set[str]:
    hosts: set[str] = set()
    cdn = _normalize_host(getattr(settings, "ASSET_CDN_HOST", None))
    if cdn:
        hosts.add(cdn)
    public_base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    if public_base:
        parsed = urlparse(public_base)
        host = _normalize_host(parsed.hostname)
        if host:
            hosts.add(host)
    return hosts


def resolve_static_path(url_path: str) -> Path | None:
    raw_path = unquote(url_path or "")
    if raw_path.startswith("/static/"):
        rel = raw_path[len("/static/"):]
    elif raw_path.startswith("static/"):
        rel = raw_path[len("static/"):]
    elif raw_path.startswith("/api/static/"):
        rel = raw_path[len("/api/static/"):]
    elif raw_path.startswith("api/static/"):
        rel = raw_path[len("api/static/"):]
    else:
        return None
    candidate = (STATIC_DIR / rel).resolve()
    if _is_within(STATIC_DIR, candidate):
        return candidate
    return None


def _is_within(base: Path, target: Path) -> bool:
    try:
        target.relative_to(base.resolve())
        return True
    except ValueError:
        return False
