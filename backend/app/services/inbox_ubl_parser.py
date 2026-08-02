from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from ..en16931.ubl_validator import validate_ubl_xml
from ..services.inbox_parsers import InvoiceParseResult
from ..services.inbox_tax_lines import parse_ubl_purchase_lines
from ..utils.xml_security import parse_xml_bytes

NS = {
    "ubl": "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
}


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
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except Exception:
        return None


def _normalize_digits(value: str | None) -> str | None:
    if not value:
        return None
    digits = "".join(ch for ch in value if ch.isdigit())
    return digits or None


def _detect_profile(customization_id: str | None, profile_id: str | None) -> str | None:
    raw = " ".join(part for part in (customization_id, profile_id) if part)
    lowered = raw.lower()
    if "en16931" in lowered:
        return "en16931"
    if "peppol" in lowered:
        return "peppol"
    return None


def _collect_supplier_ids(root) -> tuple[str | None, str | None]:
    siren = None
    siret = None
    id_nodes = root.findall(
        ".//cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID",
        namespaces=NS,
    )
    id_nodes += root.findall(
        ".//cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:CompanyID",
        namespaces=NS,
    )
    for node in id_nodes:
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


def _validate_ubl(xml_bytes: bytes) -> tuple[str, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    schematron_errors = validate_ubl_xml(xml_bytes)
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


def parse_ubl_xml(xml_bytes: bytes) -> InvoiceParseResult:
    try:
        root = parse_xml_bytes(xml_bytes)
    except Exception:
        return InvoiceParseResult(
            format="ubl",
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
            validation_errors=["XML UBL illisible."],
            validation_warnings=[],
        )

    invoice_number = _xpath_text(root, "./cbc:ID")
    issue_date = _parse_issue_date(_xpath_text(root, "./cbc:IssueDate"))
    customization_id = _xpath_text(root, "./cbc:CustomizationID")
    profile_id = _xpath_text(root, "./cbc:ProfileID")
    profile = _detect_profile(customization_id, profile_id)

    supplier_name = _xpath_text(
        root,
        ".//cac:AccountingSupplierParty/cac:Party/cac:PartyName/cbc:Name",
    ) or _xpath_text(
        root,
        ".//cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName",
    )
    supplier_siren, supplier_siret = _collect_supplier_ids(root)

    total_ex_vat = _parse_decimal(
        _xpath_text(
            root,
            ".//cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount",
        )
    )
    total_ttc = _parse_decimal(
        _xpath_text(
            root,
            ".//cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount",
        )
    )
    total_vat = _parse_decimal(
        _xpath_text(
            root,
            "./cac:TaxTotal/cbc:TaxAmount",
        )
    )
    currency = _xpath_text(root, "./cbc:DocumentCurrencyCode")
    purchase_lines = parse_ubl_purchase_lines(root, NS)

    validation_status, validation_errors, validation_warnings = _validate_ubl(xml_bytes)
    return InvoiceParseResult(
        format="ubl",
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
