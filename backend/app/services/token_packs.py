from __future__ import annotations

from typing import Any

from .commercial_catalog import TOKEN_PACK_OFFERS


def read_attr(obj: object, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    getter = getattr(obj, "get", None)
    if callable(getter):
        try:
            return getter(key)
        except Exception:
            pass
    return getattr(obj, key, None)


def safe_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def expected_token_pack_amount(tokens: int | None) -> int | None:
    if tokens is None:
        return None
    offer = TOKEN_PACK_OFFERS.get(int(tokens))
    if not offer:
        return None
    return safe_int(offer.get("unit_amount"))


def token_pack_price_validation_reason(tokens: int | None, price: object, *, quantity: int | None = 1) -> str | None:
    expected_amount = expected_token_pack_amount(tokens)
    if read_attr(price, "active") is False:
        return "price_inactive"
    unit_amount = safe_int(read_attr(price, "unit_amount"))
    currency = str(read_attr(price, "currency") or "").strip().lower()
    if quantity != 1:
        return "line_item_quantity"
    if expected_amount is None or unit_amount != expected_amount:
        return "price_amount_mismatch"
    if currency != "eur":
        return "price_currency_mismatch"
    return None


def token_pack_checkout_error_detail(tokens: int, reason: str) -> dict[str, object]:
    return {
        "code": reason,
        "message": "Le paiement de ce pack est temporairement indisponible. Aucun montant ne sera débité.",
        "pack": str(tokens),
        "tokens": tokens,
        "contact_url": "/contact",
    }
