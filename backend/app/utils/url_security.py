from __future__ import annotations

from .ssrf import validate_outbound_url


def parse_and_validate_outbound_url(url: str) -> str:
    return validate_outbound_url(url)
