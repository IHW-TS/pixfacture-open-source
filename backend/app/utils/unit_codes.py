from __future__ import annotations

import re
import unicodedata

DEFAULT_UNIT_CODE = "C62"

_UNIT_CODE_RE = re.compile(r"^[A-Z0-9]{2,3}$")

_HUMAN_UNIT_ALIASES = {
    "": DEFAULT_UNIT_CODE,
    "U": DEFAULT_UNIT_CODE,
    "UN": DEFAULT_UNIT_CODE,
    "UNIT": DEFAULT_UNIT_CODE,
    "UNITE": DEFAULT_UNIT_CODE,
    "UNITES": DEFAULT_UNIT_CODE,
    "PIECE": DEFAULT_UNIT_CODE,
    "PIECES": DEFAULT_UNIT_CODE,
    "PC": DEFAULT_UNIT_CODE,
    "PCS": DEFAULT_UNIT_CODE,
    "H": "HUR",
    "HEURE": "HUR",
    "HEURES": "HUR",
    "HOUR": "HUR",
    "HOURS": "HUR",
    "J": "DAY",
    "JR": "DAY",
    "JOUR": "DAY",
    "JOURS": "DAY",
    "DAY": "DAY",
    "DAYS": "DAY",
    "MOIS": "MON",
    "MONTH": "MON",
    "MONTHS": "MON",
    "AN": "ANN",
    "ANS": "ANN",
    "ANNEE": "ANN",
    "ANNEES": "ANN",
    "YEAR": "ANN",
    "YEARS": "ANN",
    "KG": "KGM",
    "KILO": "KGM",
    "KILOS": "KGM",
    "KILOGRAMME": "KGM",
    "KILOGRAMMES": "KGM",
    "G": "GRM",
    "GRAMME": "GRM",
    "GRAMMES": "GRM",
    "L": "LTR",
    "LITRE": "LTR",
    "LITRES": "LTR",
    "ML": "MLT",
    "METRE": "MTR",
    "METRES": "MTR",
    "M": "MTR",
    "M2": "MTK",
    "M²": "MTK",
    "M3": "MTQ",
    "M³": "MTQ",
    "LOT": "SET",
    "LOTS": "SET",
}


def _ascii_unit(value: object | None) -> str:
    text = str(value or "").strip().upper()
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch)).strip()


def normalize_unit_code(value: object | None) -> str:
    """Return a safe UN/ECE unit code for XML exports.

    The app mostly invoices services, so C62 (unit/piece) is the safest fallback
    for blank, human, or obviously invalid values imported from catalogues.
    """

    raw = _ascii_unit(value).replace(" ", "").replace("-", "")
    if raw in _HUMAN_UNIT_ALIASES:
        return _HUMAN_UNIT_ALIASES[raw]
    if raw.isdigit():
        return DEFAULT_UNIT_CODE
    if not _UNIT_CODE_RE.fullmatch(raw):
        return DEFAULT_UNIT_CODE
    return raw


def unit_code_was_normalized(value: object | None) -> bool:
    return normalize_unit_code(value) != _ascii_unit(value).replace(" ", "").replace("-", "")
