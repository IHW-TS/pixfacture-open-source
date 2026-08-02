from __future__ import annotations

from .base import PlatformConnector
from .chorus import ChorusProPlatform
from .dummy import DummyPlatform
from .http_generic import HttpGenericPlatform
_PLATFORMS: list[type[PlatformConnector]] = [
    ChorusProPlatform,
    HttpGenericPlatform,
    DummyPlatform,
]

_PLATFORM_MAP: dict[str, type[PlatformConnector]] = {
    "choruspro": ChorusProPlatform,
    "chorus": ChorusProPlatform,
    "http_generic": HttpGenericPlatform,
    "http": HttpGenericPlatform,
    "generic": HttpGenericPlatform,
    "dummy": DummyPlatform,
}


def list_platforms() -> list[type[PlatformConnector]]:
    return list(_PLATFORMS)


def get_platform(slug: str, credentials: dict | None = None) -> PlatformConnector:
    key = (slug or "").strip().lower()
    platform_cls = _PLATFORM_MAP.get(key)
    if not platform_cls:
        raise ValueError(f"Platform inconnue: {slug}")
    return platform_cls(credentials or {})
