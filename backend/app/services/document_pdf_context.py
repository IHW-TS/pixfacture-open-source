from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

from .seqino_periodicity_payload import is_vat_franchise_regime


_CENT = Decimal("0.01")


_VAT_EXEMPTION_LABELS_FR = {
    "VATEX-FR-FRANCHISE": "TVA non applicable, art. 293 B du CGI",
    "VATEX-FR-CGI261-1": "Exonération de TVA",
    "VATEX-FR-CGI261-2": "Exonération de TVA",
    "VATEX-FR-CGI261-3": "Exonération de TVA",
    "VATEX-FR-CGI261-4": "Exonération de TVA",
    "VATEX-FR-CGI261-5": "Exonération de TVA",
    "VATEX-FR-CGI261-7": "Exonération de TVA",
    "VATEX-FR-CGI261-8": "Exonération de TVA",
    "VATEX-FR-EXO": "Exonération de TVA",
    "VATEX-EU-G": "Exonération de TVA, exportation",
    "VATEX-EU-IC": "Exonération TVA, livraison intracommunautaire",
    "VATEX-FR-AE": "Autoliquidation",
    "VATEX-EU-AE": "Autoliquidation",
    "AE": "Autoliquidation",
}

_VAT_EXEMPTION_LABELS_EN = {
    "VATEX-FR-FRANCHISE": "VAT not applicable, French CGI art. 293 B",
    "VATEX-FR-CGI261-1": "VAT exemption",
    "VATEX-FR-CGI261-2": "VAT exemption",
    "VATEX-FR-CGI261-3": "VAT exemption",
    "VATEX-FR-CGI261-4": "VAT exemption",
    "VATEX-FR-CGI261-5": "VAT exemption",
    "VATEX-FR-CGI261-7": "VAT exemption",
    "VATEX-FR-CGI261-8": "VAT exemption",
    "VATEX-FR-EXO": "VAT exemption",
    "VATEX-EU-G": "VAT exemption, export",
    "VATEX-EU-IC": "VAT exemption, intra-EU supply",
    "VATEX-FR-AE": "Reverse charge",
    "VATEX-EU-AE": "Reverse charge",
    "AE": "Reverse charge",
}

_VATEX_ALIAS_CODES = {
    "AE": "VATEX-EU-AE",
    "VATEX-FR-EXPORT": "VATEX-EU-G",
}

_SUPPORTED_EXACT_VATEX_CODES = {
    "VATEX-FR-FRANCHISE",
    "VATEX-FR-CNWVAT",
    "VATEX-FR-AE",
    "VATEX-EU-AE",
    "VATEX-EU-IC",
    "VATEX-EU-G",
    "VATEX-EU-O",
    "VATEX-EU-D",
    "VATEX-EU-F",
    "VATEX-EU-I",
    "VATEX-EU-J",
}

_FR_CGI_261_RE = re.compile(r"\b261\s*([A-E])?\s*(?:[-.]?\s*(\d+|BIS))?", re.IGNORECASE)


def _decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
    if value is None:
        return default
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return default


def _quantize(value: Any) -> Decimal:
    return _decimal(value).quantize(_CENT)


def _get(source: Any, key: str, default: Any = None) -> Any:
    if isinstance(source, dict):
        return source.get(key, default)
    return getattr(source, key, default)


def _normalize_code(value: Any) -> str:
    return str(value or "").strip().upper()


def canonical_vat_exemption_code(value: Any) -> str:
    code = _normalize_code(value)
    if not code:
        return ""
    code = _VATEX_ALIAS_CODES.get(code, code)
    if code == "VATEX-FR-EXO":
        return ""
    if code in _SUPPORTED_EXACT_VATEX_CODES:
        return code
    if code.startswith("VATEX-FR-CGI261") or code.startswith("VATEX-FR-CGI275"):
        return code
    if code.startswith("VATEX-FR-CGI277") or code.startswith("VATEX-FR-CGI295"):
        return code
    if code.startswith("VATEX-FR-298"):
        return code
    if code.startswith("VATEX-EU-") and code != "VATEX-EU-EXO":
        return code
    return ""


def _is_standard_taxable(category: Any, rate: Any) -> bool:
    return _normalize_code(category or "S") == "S" and _decimal(rate) != 0


def _notice_to_vatex_code(notice: str) -> str:
    normalized_notice = notice.strip()
    upper_notice = normalized_notice.upper()
    if not normalized_notice:
        return ""
    if "293" in upper_notice and "B" in upper_notice:
        return "VATEX-FR-FRANCHISE"
    if "FRANCHISE" in upper_notice:
        return "VATEX-FR-FRANCHISE"
    if "AUTOLIQ" in upper_notice or "REVERSE CHARGE" in upper_notice:
        return "VATEX-EU-AE"
    match = _FR_CGI_261_RE.search(normalized_notice)
    if match:
        suffix_letter = (match.group(1) or "").upper()
        suffix_number = (match.group(2) or "").upper()
        if suffix_letter:
            return canonical_vat_exemption_code(f"VATEX-FR-CGI261{suffix_letter}")
        if suffix_number:
            return canonical_vat_exemption_code(f"VATEX-FR-CGI261-{suffix_number}")
    return ""


def _supplier_franchise_label(supplier: Any, is_english: bool = False) -> str:
    vat_number = str(_get(supplier, "vat_number", "") or "").strip()
    exemption_notice = str(_get(supplier, "vat_exemption_notice", "") or "").strip()
    if is_vat_franchise_regime(_get(supplier, "vat_regime", None)) or (exemption_notice and not vat_number):
        if exemption_notice:
            return exemption_notice
        return "VAT not applicable, French CGI art. 293 B" if is_english else "TVA non applicable, art. 293 B du CGI"
    return ""


def supplier_vat_exemption_code(supplier: Any) -> str:
    vat_number = str(_get(supplier, "vat_number", "") or "").strip()
    exemption_notice = str(_get(supplier, "vat_exemption_notice", "") or "").strip()
    if is_vat_franchise_regime(_get(supplier, "vat_regime", None)):
        return "VATEX-FR-FRANCHISE"
    if exemption_notice and not vat_number:
        return _notice_to_vatex_code(exemption_notice)
    return ""


def resolved_vat_exemption_code(
    category: Any,
    exemption_reason_code: Any = None,
    *,
    supplier: Any = None,
    rate: Any = None,
) -> str:
    normalized_code = canonical_vat_exemption_code(exemption_reason_code)
    if normalized_code:
        return normalized_code
    if rate is not None and _is_standard_taxable(category, rate):
        return ""
    supplier_code = supplier_vat_exemption_code(supplier) if supplier else ""
    if supplier_code:
        return supplier_code
    normalized_category = _normalize_code(category)
    if normalized_category == "AE":
        return "VATEX-EU-AE"
    return ""


def vat_zero_reason_label(
    category: Any,
    exemption_reason_code: Any = None,
    *,
    is_english: bool = False,
    supplier: Any = None,
    rate: Any = None,
) -> str:
    if rate is not None and _is_standard_taxable(category, rate) and not exemption_reason_code:
        return ""

    normalized_category = _normalize_code(category) or "S"
    raw_code = _normalize_code(exemption_reason_code)
    normalized_code = resolved_vat_exemption_code(category, exemption_reason_code, supplier=None, rate=rate)
    labels = _VAT_EXEMPTION_LABELS_EN if is_english else _VAT_EXEMPTION_LABELS_FR
    label_code = normalized_code or raw_code
    supplier_label = _supplier_franchise_label(supplier, is_english=is_english) if supplier else ""
    if supplier_label and label_code == "VATEX-FR-FRANCHISE":
        return supplier_label
    if label_code in labels:
        return labels[label_code]
    if raw_code == "VATEX-FR-EXO":
        return labels["VATEX-FR-EXO"]
    if raw_code == "VATEX-FR-EXPORT":
        return labels["VATEX-EU-G"]
    if normalized_code in labels:
        return labels[normalized_code]
    if "293" in raw_code and "B" in raw_code:
        return labels["VATEX-FR-FRANCHISE"]
    if "AUTOLIQ" in raw_code or "REVERSE" in raw_code:
        return labels["AE"]
    if raw_code:
        if normalized_category == "AE":
            return labels["AE"]
        if normalized_category == "O":
            prefix = "VAT not applicable" if is_english else "TVA non applicable"
        elif normalized_category == "Z":
            prefix = "Zero-rated VAT" if is_english else "TVA à taux zéro"
        else:
            prefix = "VAT exemption" if is_english else "Exonération de TVA"
        return f"{prefix} - {raw_code}"

    if supplier_label:
        return supplier_label

    if normalized_category == "AE":
        return labels["AE"]
    if normalized_category == "O":
        return "VAT not applicable - outside scope" if is_english else "TVA non applicable - opération hors champ"
    if normalized_category == "Z":
        return "Zero-rated VAT" if is_english else "TVA à taux zéro"
    if normalized_category == "E":
        return "VAT exemption" if is_english else "Exonération de TVA"
    return ""


def line_vat_reason_label(line: Any, supplier: Any = None, is_english: bool = False) -> str:
    if _line_type(line) != "item":
        return ""
    rate = _decimal(_get(line, "vat_rate", 0))
    category = _get(line, "vat_category", "S") or "S"
    exemption_code = _get(line, "exemption_reason_code", None)
    if rate != 0 and _normalize_code(category) == "S" and not exemption_code:
        return ""
    return vat_zero_reason_label(category, exemption_code, is_english=is_english, supplier=supplier, rate=rate)


def document_has_special_vat_context(supplier: Any, lines: list[Any] | None = None) -> bool:
    if _supplier_franchise_label(supplier):
        item_lines = [line for line in lines or [] if _line_type(line) == "item"]
        return not any(_is_standard_taxable(_get(line, "vat_category", "S"), _get(line, "vat_rate", 0)) for line in item_lines)
    for line in lines or []:
        if _line_type(line) != "item":
            continue
        if line_vat_reason_label(line, supplier=None):
            return True
    return False


def document_vat_labels(supplier: Any, lines: list[Any] | None = None, is_english: bool = False) -> dict[str, str]:
    supplier_label = _supplier_franchise_label(supplier, is_english=is_english)
    item_lines = [line for line in lines or [] if _line_type(line) == "item"]
    has_standard_taxable = any(
        _is_standard_taxable(_get(line, "vat_category", "S"), _get(line, "vat_rate", 0)) for line in item_lines
    )
    reasons: list[str] = []
    for line in lines or []:
        if _line_type(line) != "item":
            continue
        label = line_vat_reason_label(line, supplier=supplier, is_english=is_english)
        if label and label not in reasons:
            reasons.append(label)

    if reasons:
        joined = ", ".join(reasons)
        return {"display": joined, "legal": joined}

    if supplier_label and not has_standard_taxable:
        return {"display": supplier_label, "legal": supplier_label}

    if bool(_get(supplier, "vat_on_debits", False)):
        return {
            "display": "VAT on debits" if is_english else "TVA sur les débits",
            "legal": "VAT payable according to debits"
            if is_english
            else "Option pour le paiement de la taxe d'après les débits",
        }
    return {"display": "", "legal": ""}


def _line_type(line: Any) -> str:
    value = str(_get(line, "line_type", "item") or "item").strip().lower()
    if value == "section":
        return "title"
    if value in {"item", "title", "comment"}:
        return value
    return "item"


def normalize_pdf_line(line: Any) -> dict[str, Any]:
    from ..utils.unit_codes import normalize_unit_code

    quantity = _quantize(_get(line, "quantity", 0))
    unit_price = _quantize(_get(line, "unit_price", 0))
    line_total = _get(line, "line_total", None)
    if line_total is None:
        line_total = quantity * unit_price
    return {
        "line_type": _line_type(line),
        "display_number": _get(line, "display_number"),
        "reference": _get(line, "reference"),
        "product_name": _get(line, "product_name", "") or "",
        "detail": _get(line, "detail"),
        "quantity": quantity,
        "unit_price": unit_price,
        "vat_rate": _quantize(_get(line, "vat_rate", 0)),
        "vat_category": _get(line, "vat_category", "S") or "S",
        "exemption_reason_code": _get(line, "exemption_reason_code"),
        "unit_code": normalize_unit_code(_get(line, "unit_code", "C62")),
        "item_id": _get(line, "item_id"),
        "accounting_account": _get(line, "accounting_account"),
        "line_total": _quantize(line_total),
    }


def _is_negative_item_adjustment(line: dict[str, Any]) -> bool:
    if _line_type(line) != "item":
        return False
    return _decimal(line.get("line_total")) < 0 or _decimal(line.get("unit_price")) < 0


def _is_advance_payment_label(label: Any) -> bool:
    text = str(label or "").lower()
    return "acompte" in text or "advance" in text


def classify_negative_adjustment_line(line: dict[str, Any]) -> str:
    if not _is_negative_item_adjustment(line):
        return "regular"
    label = str(line.get("product_name") or "").strip().lower()
    if _is_advance_payment_label(label):
        return "advance_payment"
    discount_markers = (
        "remise",
        "discount",
        "rabais",
        "ristourne",
        "escompte",
        "réduction",
        "reduction",
        "promo",
    )
    if any(marker in label for marker in discount_markers):
        return "discount"
    return "other"


def split_pdf_lines_and_adjustments(
    lines: list[Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    regular_lines: list[dict[str, Any]] = []
    allowances: list[dict[str, Any]] = []
    advance_payments: list[dict[str, Any]] = []

    for raw_line in lines:
        line = normalize_pdf_line(raw_line)
        adjustment_kind = classify_negative_adjustment_line(line)
        if adjustment_kind in {"regular", "other"}:
            regular_lines.append(line)
            continue

        amount_ht = abs(_decimal(line.get("line_total")))
        rate = _decimal(line.get("vat_rate"))
        amount_vat = abs((amount_ht * rate / Decimal("100")).quantize(_CENT))
        adjustment = {
            "label": str(line.get("product_name") or "Remise").strip(),
            "amount_ht": amount_ht,
            "amount_vat": amount_vat,
            "amount_ttc": (amount_ht + amount_vat).quantize(_CENT),
            "vat_rate": rate,
            "vat_category": line.get("vat_category") or "S",
            "exemption_reason_code": line.get("exemption_reason_code"),
            "adjustment_kind": adjustment_kind,
        }
        if adjustment_kind == "advance_payment":
            advance_payments.append(adjustment)
        else:
            allowances.append(adjustment)

    return regular_lines, allowances, advance_payments


def _discount_percent_from_label(label: str) -> Decimal | None:
    match = re.search(r"remise\s+([0-9]+(?:[,.][0-9]+)?)\s*%", label, flags=re.IGNORECASE)
    if not match:
        return None
    return _decimal(match.group(1).replace(",", "."), default=Decimal("-1"))


def _discount_target_from_label(label: str) -> str | None:
    if " - " not in label:
        return None
    target = label.split(" - ", 1)[1].strip()
    return target or None


def global_discount_vat_breakdown_error(lines: list[Any]) -> str | None:
    normalized = [normalize_pdf_line(line) for line in lines]
    positive_vat_keys: set[tuple[str, Decimal, str | None]] = set()
    global_discount_keys: set[tuple[str, Decimal, str | None]] = set()

    for line in normalized:
        if _line_type(line) != "item":
            continue
        kind = classify_negative_adjustment_line(line)
        key = (
            str(line.get("vat_category") or "S"),
            _decimal(line.get("vat_rate")),
            str(line.get("exemption_reason_code")) if line.get("exemption_reason_code") else None,
        )
        if kind == "regular" and _decimal(line.get("line_total")) > 0:
            positive_vat_keys.add(key)
        elif kind == "discount" and not _discount_target_from_label(str(line.get("product_name") or "")):
            global_discount_keys.add(key)

    if len(positive_vat_keys) <= 1 or not global_discount_keys:
        return None
    if global_discount_keys.issubset(positive_vat_keys) and positive_vat_keys.issubset(global_discount_keys):
        return None
    return (
        "Remise globale multi-taux TVA non ventilée : ciblez une ligne avec 'Remise - Nom de ligne' "
        "ou ajoutez une remise par taux de TVA."
    )


def attach_discount_display_metadata(
    lines: list[Any],
    allowances: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attach PDF display-only discount fields to the matching positive line.

    The app stores line discounts as negative adjustment lines for accounting
    compatibility. The visual document must still render them beside the source
    line, like the React preview does.
    """

    result = [normalize_pdf_line(line) for line in lines]
    if not allowances:
        return result

    for allowance in allowances:
        amount_ht = _decimal(allowance.get("amount_ht"))
        if amount_ht <= 0:
            continue
        label = str(allowance.get("label") or "")
        target_name = _discount_target_from_label(label)
        target_index: int | None = None

        if target_name:
            for index, line in enumerate(result):
                if str(line.get("product_name") or "").strip() == target_name:
                    target_index = index
                    break

        if target_index is None:
            continue

        line = result[target_index]
        base_total = _decimal(line.get("line_total"))
        current_discount = _decimal(line.get("pdf_discount_amount_ht"))
        next_discount = (current_discount + amount_ht).quantize(_CENT)
        percent = _discount_percent_from_label(label)
        if percent is None and base_total > 0:
            percent = (next_discount / base_total * Decimal("100")).quantize(_CENT)
        line["pdf_discount_amount_ht"] = next_discount
        line["pdf_discount_percent"] = percent if percent is not None and percent >= 0 else None
        line["pdf_discounted_total_ht"] = (base_total - next_discount).quantize(_CENT)

    return result


def sum_pdf_amount(items: list[dict[str, Any]], key: str) -> Decimal:
    return sum((_decimal(item.get(key)) for item in items), Decimal("0")).quantize(_CENT)
