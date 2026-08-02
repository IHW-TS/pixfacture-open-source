from __future__ import annotations

from .legacy_platform import DummyPlatformProvider


class MockPdpProvider(DummyPlatformProvider):
    slug = "mock"
    label = "Mock PA (dev/test)"
    description = "Simulateur plateforme agréée (PA) pour les environnements de test."
