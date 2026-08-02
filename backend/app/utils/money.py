from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

TWOPLACES = Decimal("0.01")
MAX_LINE_QUANTITY = Decimal("99999999.99")
MAX_DOCUMENT_AMOUNT = Decimal("999999999999999.99")


def _normalize_decimal_text(value: str) -> str:
    return (
        value.strip()
        .replace("\u00a0", "")
        .replace("\u202f", "")
        .replace(" ", "")
        .replace(",", ".")
    )


def _format_decimal_fr(value: Decimal) -> str:
    integer, _, cents = f"{value:.2f}".partition(".")
    groups: list[str] = []
    while integer:
        groups.append(integer[-3:])
        integer = integer[:-3]
    return f"{' '.join(reversed(groups))},{cents}"


def to_decimal(value) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if value is None:
        return Decimal("0")
    raw = _normalize_decimal_text(value) if isinstance(value, str) else str(value)
    return Decimal(raw)


def ensure_max_abs(value, max_abs: Decimal, label: str) -> Decimal:
    try:
        amount = to_decimal(value)
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"{label} invalide.")
    if not amount.is_finite():
        raise ValueError(f"{label} invalide.")
    if abs(amount) > max_abs:
        raise ValueError(f"{label} trop élevé. Maximum autorisé : {_format_decimal_fr(max_abs)}.")
    return amount


def quantize_amount(value) -> Decimal:
    return to_decimal(value).quantize(TWOPLACES, rounding=ROUND_HALF_UP)


def calc_line_total(quantity, unit_price) -> Decimal:
    return quantize_amount(to_decimal(quantity) * to_decimal(unit_price))


def calc_tax_amount(base, rate) -> Decimal:
    return quantize_amount(to_decimal(base) * to_decimal(rate) / Decimal("100"))
