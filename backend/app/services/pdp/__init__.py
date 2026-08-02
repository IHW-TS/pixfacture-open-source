from __future__ import annotations

from .base import (
    EReportingEvent,
    EReportingLinePayload,
    EReportingReportPayload,
    InboundMessage,
    PdpProvider,
    StatusResult,
    TransmissionResult,
)
from .providers.http_generic import HttpGenericProvider
from .providers.legacy_platform import ChorusPlatformProvider, DummyPlatformProvider
from .providers.mock import MockPdpProvider
from .providers.provider_x import ProviderX
from .providers.seqino import SeqinoPdpProvider
from ...config import settings

__all__ = [
    "EReportingEvent",
    "EReportingLinePayload",
    "EReportingReportPayload",
    "InboundMessage",
    "PdpProvider",
    "StatusResult",
    "TransmissionResult",
    "list_providers",
    "get_provider",
]


_PROVIDERS: list[type[PdpProvider]] = [
    ChorusPlatformProvider,
    SeqinoPdpProvider,
    HttpGenericProvider,
    DummyPlatformProvider,
    MockPdpProvider,
    ProviderX,
]

_PROVIDER_MAP: dict[str, type[PdpProvider]] = {
    "choruspro": ChorusPlatformProvider,
    "chorus": ChorusPlatformProvider,
    "seqino": SeqinoPdpProvider,
    "http_generic": HttpGenericProvider,
    "http": HttpGenericProvider,
    "generic": HttpGenericProvider,
    "dummy": DummyPlatformProvider,
    "mock": MockPdpProvider,
    "provider_x": ProviderX,
}


def _is_prod_like() -> bool:
    env = (settings.APP_ENV or "").strip().lower()
    return env in {"prod", "production", "staging"}


def _http_generic_enabled() -> bool:
    return bool(settings.ENABLE_HTTP_GENERIC_CONNECTOR)


def _provider_x_enabled() -> bool:
    return not _is_prod_like()


def _mock_enabled() -> bool:
    return not _is_prod_like()


def _dummy_enabled() -> bool:
    return not _is_prod_like() or bool(settings.ALLOW_DUMMY_IN_PROD)


def list_providers() -> list[type[PdpProvider]]:
    providers = list(_PROVIDERS)
    if not _http_generic_enabled():
        providers = [provider for provider in providers if provider is not HttpGenericProvider]
    if not _dummy_enabled():
        providers = [provider for provider in providers if provider is not DummyPlatformProvider]
    if not _mock_enabled():
        providers = [provider for provider in providers if provider is not MockPdpProvider]
    if not _provider_x_enabled():
        providers = [provider for provider in providers if provider is not ProviderX]
    return providers


def get_provider(slug: str, credentials: dict | None = None) -> PdpProvider:
    key = (slug or "").strip().lower()
    provider_cls = _PROVIDER_MAP.get(key)
    if not provider_cls:
        raise ValueError(f"Provider inconnu: {slug}")
    if provider_cls is HttpGenericProvider and not _http_generic_enabled():
        raise ValueError("Provider http_generic desactive par configuration.")
    if provider_cls is DummyPlatformProvider and not _dummy_enabled():
        raise ValueError("Provider non disponible en production.")
    if provider_cls is MockPdpProvider and not _mock_enabled():
        raise ValueError("Provider mock desactive en prod/staging.")
    if provider_cls is ProviderX and not _provider_x_enabled():
        raise ValueError("Provider provider_x desactive en prod/staging.")
    return provider_cls(credentials or {})
