from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from lxml import etree

from .document_pdf_context import vat_zero_reason_label


def _text(node) -> str | None:
    if node is None:
        return None
    text = "".join(node.itertext()).strip()
    return text or None


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    cleaned = str(value).strip().replace(",", ".")
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return None


def _money(value: Decimal | None) -> float | None:
    if value is None:
        return None
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _rate(value: Decimal | None) -> float | None:
    if value is None:
        return None
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _clean(value: str | None) -> str | None:
    cleaned = str(value or "").strip()
    return cleaned or None


def _category(value: str | None) -> str | None:
    cleaned = _clean(value)
    return cleaned.upper() if cleaned else None


def _reverse_charge(category: str | None, code: str | None, reason: str | None) -> bool:
    raw = " ".join(part for part in (category, code, reason) if part).upper()
    return category == "AE" or "AUTOLIQ" in raw or "REVERSE" in raw or "VATEX-EU-AE" in raw


def _line_payload(
    *,
    label: str | None,
    total_ex_vat: Decimal | None,
    vat_rate: Decimal | None,
    total_vat: Decimal | None = None,
    vat_category: str | None = None,
    exemption_reason_code: str | None = None,
    exemption_reason: str | None = None,
    source: str,
) -> dict[str, Any] | None:
    if total_ex_vat is None or total_ex_vat <= 0:
        return None
    normalized_category = _category(vat_category) or "S"
    normalized_rate = vat_rate if vat_rate is not None else Decimal("0")
    if total_vat is None:
        total_vat = (total_ex_vat * normalized_rate / Decimal("100")).quantize(
            Decimal("0.01"),
            rounding=ROUND_HALF_UP,
        )
    total_ttc = total_ex_vat + total_vat
    reason = _clean(exemption_reason)
    reason_code = _clean(exemption_reason_code)
    zero_reason = reason or vat_zero_reason_label(normalized_category, reason_code, rate=normalized_rate)
    reverse_charge = _reverse_charge(normalized_category, reason_code, reason)
    return {
        "label": _clean(label),
        "total_ex_vat": _money(total_ex_vat),
        "vat_rate": _rate(normalized_rate),
        "total_vat": _money(total_vat),
        "total_ttc": _money(total_ttc),
        "vat_category": normalized_category,
        "exemption_reason_code": reason_code,
        "vat_exemption_reason": reason,
        "vat_zero_reason": zero_reason if _money(total_vat) == 0 else None,
        "vat_reverse_charge": reverse_charge,
        "source": source,
    }


def parse_cii_purchase_lines(root: etree._Element) -> list[dict[str, Any]]:
    ns = {key: value for key, value in root.nsmap.items() if key}
    ns.setdefault("ram", "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100")
    rows: list[dict[str, Any]] = []
    for index, node in enumerate(root.findall(".//ram:IncludedSupplyChainTradeLineItem", namespaces=ns), start=1):
        label = _text(node.find(".//ram:SpecifiedTradeProduct/ram:Name", namespaces=ns)) or f"Ligne {index}"
        settlement = node.find(".//ram:SpecifiedLineTradeSettlement", namespaces=ns)
        tax = settlement.find(".//ram:ApplicableTradeTax", namespaces=ns) if settlement is not None else None
        summation = (
            settlement.find(".//ram:SpecifiedTradeSettlementLineMonetarySummation", namespaces=ns)
            if settlement is not None
            else None
        )
        line = _line_payload(
            label=label,
            total_ex_vat=_decimal(_text(summation.find(".//ram:LineTotalAmount", namespaces=ns)) if summation is not None else None),
            vat_rate=_decimal(_text(tax.find(".//ram:RateApplicablePercent", namespaces=ns)) if tax is not None else None),
            total_vat=None,
            vat_category=_text(tax.find(".//ram:CategoryCode", namespaces=ns)) if tax is not None else None,
            exemption_reason_code=_text(tax.find(".//ram:ExemptionReasonCode", namespaces=ns)) if tax is not None else None,
            exemption_reason=_text(tax.find(".//ram:ExemptionReason", namespaces=ns)) if tax is not None else None,
            source="cii_xml",
        )
        if line:
            rows.append(line)
    return rows


def parse_ubl_purchase_lines(root: etree._Element, namespaces: dict[str, str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, node in enumerate(root.findall(".//cac:InvoiceLine", namespaces=namespaces), start=1):
        category = node.find(".//cac:Item/cac:ClassifiedTaxCategory", namespaces=namespaces)
        line_tax = node.find("./cac:TaxTotal/cbc:TaxAmount", namespaces=namespaces)
        line = _line_payload(
            label=_text(node.find(".//cac:Item/cbc:Name", namespaces=namespaces)) or f"Ligne {index}",
            total_ex_vat=_decimal(_text(node.find("./cbc:LineExtensionAmount", namespaces=namespaces))),
            vat_rate=_decimal(_text(category.find("./cbc:Percent", namespaces=namespaces)) if category is not None else None),
            total_vat=_decimal(_text(line_tax)) if line_tax is not None else None,
            vat_category=_text(category.find("./cbc:ID", namespaces=namespaces)) if category is not None else None,
            exemption_reason_code=_text(category.find("./cbc:TaxExemptionReasonCode", namespaces=namespaces)) if category is not None else None,
            exemption_reason=_text(category.find("./cbc:TaxExemptionReason", namespaces=namespaces)) if category is not None else None,
            source="ubl_xml",
        )
        if line:
            rows.append(line)
    return rows
