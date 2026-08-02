from __future__ import annotations


def normalize_seqino_authorization(raw: str) -> str:
    value = (raw or "").strip()
    if value.lower().startswith("bearer "):
        return value
    return value
