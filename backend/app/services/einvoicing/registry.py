from __future__ import annotations

from .base import EInvoicingConnector
from .chorus import ChorusProConnector
from .dummy import DummyPdpConnector
from .partnerx import PartnerXConnector


def get_connector(slug: str | None, credentials: dict | None = None) -> EInvoicingConnector:
    key = (slug or "").strip().lower()
    if key in {"chorus", "choruspro", "chorus_pro"}:
        return ChorusProConnector(credentials)
    if key in {"dummy", "mock", "pdp_dummy"}:
        return DummyPdpConnector(credentials)
    if key in {"partnerx", "partner_x"}:
        return PartnerXConnector(credentials)
    raise ValueError(f"Connector inconnu: {slug}")
