from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from ..validators.invoice_sanity_checks import validate_invoice_xml
from ..services.cii import NS
from ..services.inbox_parsers import InvoiceParseResult
from ..services.inbox_tax_lines import parse_cii_purchase_lines
from ..utils.xml_security import parse_xml_bytes


def _text(node) -> str | None:
    if node is None:
        return None
    text = "".join(node.itertext()).strip()
    return text or None


def _xpath_text(root, path: str) -> str | None:
    node = root.find(path, namespaces=NS)
    return _text(node)


def _parse_decimal(value: str | None) -> Decimal | None:
    if not value:
        return None
    try:
        return Decimal(value)
    except (InvalidOperation, ValueError):
        return None


def _parse_issue_date(value: str | None) -> date | None:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    if len(raw) == 8 and raw.isdigit():
        try:
            return datetime.strptime(raw, "%Y%m%d").date()
        except Exception:
            return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except Exception:
        return None


def _normalize_digits(value: str | None) -> str | None:
    if not value:
        return None
    digits = "".join(ch for ch in value if ch.isdigit())
    return digits or None


def _detect_profile(guideline_id: str | None) -> str | None:
    if not guideline_id:
        return None
    lowered = guideline_id.lower()
    if "extended-ctc-fr" in lowered:
        return "extended-ctc-fr"
    if "factur-x" in lowered or "facturx" in lowered:
        if "basicwl" in lowered or "basic-wl" in lowered:
            return "basic"
        if "extended" in lowered:
            return "extended"
        if "basic" in lowered:
            return "basic"
        if "minimum" in lowered:
            return "minimum"
    if "en16931" in lowered:
        return "en16931"
    return None


def _collect_seller_ids(root) -> tuple[str | None, str | None]:
    siren = None
    siret = None
    ids = root.findall(
        ".//ram:ApplicableHeaderTradeAgreement/ram:SellerTradeParty/ram:SpecifiedLegalOrganization/ram:ID",
        namespaces=NS,
    )
    for node in ids:
        value = _text(node)
        if not value:
            continue
        scheme = (node.get("schemeID") or "").strip()
        digits = _normalize_digits(value)
        if scheme == "0009" or (digits and len(digits) == 14):
            siret = siret or digits
        elif scheme == "0002" or (digits and len(digits) == 9):
            siren = siren or digits
    return siren, siret


def _validate_cii(xml_bytes: bytes) -> tuple[str, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    schematron_errors = validate_invoice_xml(xml_bytes)
    if schematron_errors:
        if len(schematron_errors) == 1 and "indisponible" in schematron_errors[0].lower():
            warnings.append(schematron_errors[0])
        else:
            errors.extend(schematron_errors)
    if errors:
        return "invalid", errors, warnings
    if warnings:
        return "unavailable", errors, warnings
    return "valid", errors, warnings


def parse_cii_xml(xml_bytes: bytes) -> InvoiceParseResult:
    try:
        root = parse_xml_bytes(xml_bytes)
    except Exception:
        return InvoiceParseResult(
            format="cii",
            profile=None,
            invoice_number=None,
            issue_date=None,
            supplier_name=None,
            supplier_siren=None,
            supplier_siret=None,
            total_ex_vat=None,
            total_vat=None,
            total_ttc=None,
            currency=None,
            validation_status="invalid",
            validation_errors=["XML CII illisible."],
            validation_warnings=[],
        )

    guideline = _xpath_text(
        root,
        ".//rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID",
    )
    profile = _detect_profile(guideline)

    invoice_number = _xpath_text(root, ".//rsm:ExchangedDocument/ram:ID")
    issue_raw = _xpath_text(root, ".//rsm:ExchangedDocument/ram:IssueDateTime/udt:DateTimeString")
    issue_date = _parse_issue_date(issue_raw)

    supplier_name = _xpath_text(
        root,
        ".//ram:ApplicableHeaderTradeAgreement/ram:SellerTradeParty/ram:Name",
    )
    supplier_siren, supplier_siret = _collect_seller_ids(root)

    total_ttc = _parse_decimal(
        _xpath_text(
            root,
            ".//ram:ApplicableHeaderTradeSettlement/ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:GrandTotalAmount",
        )
    )
    total_ex_vat = _parse_decimal(
        _xpath_text(
            root,
            ".//ram:ApplicableHeaderTradeSettlement/ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:LineTotalAmount",
        )
    )
    total_vat = _parse_decimal(
        _xpath_text(
            root,
            ".//ram:ApplicableHeaderTradeSettlement/ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:TaxTotalAmount",
        )
    )
    currency = _xpath_text(root, ".//ram:ApplicableHeaderTradeSettlement/ram:InvoiceCurrencyCode")
    purchase_lines = parse_cii_purchase_lines(root)

    validation_status, validation_errors, validation_warnings = _validate_cii(xml_bytes)
    return InvoiceParseResult(
        format="cii",
        profile=profile,
        invoice_number=invoice_number,
        issue_date=issue_date,
        supplier_name=supplier_name,
        supplier_siren=supplier_siren,
        supplier_siret=supplier_siret,
        total_ex_vat=total_ex_vat,
        total_vat=total_vat,
        total_ttc=total_ttc,
        currency=currency,
        validation_status=validation_status,
        validation_errors=validation_errors,
        validation_warnings=validation_warnings,
        purchase_lines=purchase_lines or None,
    )
