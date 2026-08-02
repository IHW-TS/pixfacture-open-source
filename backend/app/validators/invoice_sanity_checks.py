from __future__ import annotations

from pathlib import Path
from typing import Dict, List
import logging
import re
from decimal import Decimal

from ..utils.money import calc_line_total, calc_tax_amount, quantize_amount, to_decimal
from ..utils.xml_security import parse_xml_bytes
from ..compliance.normative_validator import Issue

try:
    from saxonche import PySaxonProcessor
except Exception:  # pragma: no cover - optional dependency
    PySaxonProcessor = None


logger = logging.getLogger(__name__)
_CHECK_UNAVAILABLE_MESSAGE = (
    "Le controle avance du document est temporairement indisponible. "
    "Vous pouvez reessayer ou contacter le support si le probleme persiste."
)

_XSLT_PATH = (
    Path(__file__).resolve().parents[1]
    / "en16931"
    / "xslt"
    / "EN16931-CII-validation.xslt"
)
_SAXON = None
_XSLT_EXEC = None
_VERSION_RE = re.compile(r"schematron version\s+([0-9.]+)\s*-\s*last update:\s*([0-9-]+)", re.IGNORECASE)


def _get_xslt_exec():
    global _SAXON, _XSLT_EXEC
    if _XSLT_EXEC is not None:
        return _XSLT_EXEC
    if PySaxonProcessor is None:
        return None
    if not _XSLT_PATH.exists():
        return None
    _SAXON = PySaxonProcessor(license=False)
    xslt_proc = _SAXON.new_xslt30_processor()
    _XSLT_EXEC = xslt_proc.compile_stylesheet(stylesheet_file=str(_XSLT_PATH))
    return _XSLT_EXEC


def get_invoice_sanity_checks_metadata() -> dict[str, str] | None:
    if not _XSLT_PATH.exists():
        return None
    try:
        with _XSLT_PATH.open("r", encoding="utf-8", errors="ignore") as handle:
            header = handle.read(4096)
    except Exception:
        return None
    match = _VERSION_RE.search(header)
    if not match:
        return None
    return {"version": match.group(1), "last_update": match.group(2)}


def get_invoice_sanity_checks_version() -> str | None:
    meta = get_invoice_sanity_checks_metadata()
    if not meta:
        return None
    return meta.get("version")


def _svrl_issues(svrl_xml: str) -> List[Issue]:
    ns = {"svrl": "http://purl.oclc.org/dsdl/svrl"}
    root = parse_xml_bytes(svrl_xml)
    issues: List[Issue] = []
    for node in root.findall(".//svrl:failed-assert", namespaces=ns):
        text_node = node.find("svrl:text", namespaces=ns)
        text = "".join(text_node.itertext()).strip() if text_node is not None else ""
        location = node.get("location")
        flag = node.get("flag")
        code = (flag or node.get("id") or "schematron_failed_assert").strip()
        msg = text or "Regle interne non satisfaite."
        if flag:
            msg = f"[{flag}] {msg}"
        if location:
            msg = f"{msg} (location: {location})"
        issues.append(
            Issue(
                code=code,
                message=msg,
                source="schematron",
                path=location,
            )
        )
    return issues


def _svrl_errors(svrl_xml: str) -> List[str]:
    return [issue.message for issue in _svrl_issues(svrl_xml)]


def validate_invoice_xml_issues(xml_bytes: bytes) -> List[Issue]:
    xslt_exec = _get_xslt_exec()
    if xslt_exec is None or _SAXON is None:
        return [
            Issue(
                code="schematron_unavailable",
                message=_CHECK_UNAVAILABLE_MESSAGE,
                source="schematron",
                level="warning",
            )
        ]
    try:
        xml_text = xml_bytes.decode("utf-8")
        xdm = _SAXON.parse_xml(xml_text=xml_text)
        svrl = xslt_exec.transform_to_string(xdm_node=xdm)
    except Exception:
        logger.exception("Controle avance du document echoue")
        return [
            Issue(
                code="schematron_validation_error",
                message=_CHECK_UNAVAILABLE_MESSAGE,
                source="schematron",
                level="warning",
            )
        ]
    if not svrl:
        return [
            Issue(
                code="schematron_report_missing",
                message=_CHECK_UNAVAILABLE_MESSAGE,
                source="schematron",
                level="warning",
            )
        ]
    return _svrl_issues(svrl)


def validate_invoice_xml(xml_bytes: bytes) -> List[str]:
    issues = validate_invoice_xml_issues(xml_bytes)
    return [issue.message for issue in issues]


def _validate_totals(ctx: Dict) -> List[str]:
    totals = ctx.get("totals") or {}
    if not isinstance(totals, dict):
        return []
    if not {"ht", "vat", "ttc"}.issubset(totals.keys()):
        return []
    ht_total = Decimal("0")
    vat_total = Decimal("0")
    for line in ctx.get("lines", []) or []:
        quantity = to_decimal(line.get("quantity", 0))
        unit_price = quantize_amount(line.get("unit_price", 0))
        provided_total = line.get("line_total")
        if provided_total is None:
            line_total = calc_line_total(quantity, unit_price)
        else:
            line_total = quantize_amount(provided_total)
        ht_total += line_total
        rate = quantize_amount(line.get("vat_rate", 0))
        vat_total += calc_tax_amount(line_total, rate)
    for allowance in ctx.get("allowances", []) or []:
        try:
            allowance_ht = quantize_amount(allowance.get("amount_ht", 0))
            allowance_rate = quantize_amount(allowance.get("vat_rate", 0))
        except Exception:
            continue
        ht_total -= allowance_ht
        vat_total -= calc_tax_amount(allowance_ht, allowance_rate)
    ttc_total = ht_total + vat_total
    expected_ht = quantize_amount(totals.get("ht"))
    expected_vat = quantize_amount(totals.get("vat"))
    expected_ttc = quantize_amount(totals.get("ttc"))

    errors: List[str] = []
    tolerance = Decimal("0.01")
    if (expected_ht - ht_total).copy_abs() > tolerance:
        errors.append(
            f"Total HT incoherent: lignes={ht_total:.2f}, total={expected_ht:.2f}."
        )
    if (expected_vat - vat_total).copy_abs() > tolerance:
        errors.append(
            f"Total TVA incoherent: lignes={vat_total:.2f}, total={expected_vat:.2f}."
        )
    if (expected_ttc - ttc_total).copy_abs() > tolerance:
        errors.append(
            f"Total TTC incoherent: lignes={ttc_total:.2f}, total={expected_ttc:.2f}."
        )
    return errors


def _validate_line_totals(ctx: Dict) -> List[str]:
    errors: List[str] = []
    tolerance = Decimal("0.01")
    for index, line in enumerate(ctx.get("lines", []) or [], start=1):
        line_type = str(line.get("line_type") or "item").strip().lower()
        if line_type != "item":
            continue
        if line.get("line_total") is None:
            continue
        try:
            quantity = to_decimal(line.get("quantity", 0))
            unit_price = quantize_amount(line.get("unit_price", 0))
            provided_total = quantize_amount(line.get("line_total"))
        except Exception:
            continue
        expected_total = calc_line_total(quantity, unit_price)
        if (provided_total - expected_total).copy_abs() <= tolerance:
            continue
        label = str(line.get("product_name") or f"Ligne {index}").strip()
        errors.append(
            "Total de ligne incoherent: "
            f"{label} indique {provided_total:.2f} EUR, "
            f"mais quantite x prix donne {expected_total:.2f} EUR. "
            "Reenregistrez la ligne pour recalculer les totaux avant emission."
        )
    return errors


def _resolve_type_code(ctx: Dict) -> str:
    invoice = ctx.get("invoice") or {}
    type_code = str(invoice.get("type_code") or "").strip()
    if type_code in {"380", "381"}:
        return type_code
    doc_type = (invoice.get("type") or "invoice").strip().lower()
    return "381" if doc_type == "credit_note" else "380"


def _validate_quantities(ctx: Dict) -> List[str]:
    if _resolve_type_code(ctx) == "381":
        return []
    errors: List[str] = []
    for line in ctx.get("lines", []) or []:
        try:
            quantity = to_decimal(line.get("quantity", 0))
        except Exception:
            continue
        if quantity < 0:
            label = line.get("product_name") or "Ligne"
            errors.append(f"Quantite negative interdite sur facture: {label}.")
    return errors


def validate_invoice_ctx(ctx: Dict) -> List[str]:
    from ..services.cii import cii_invoice_xml

    errors = _validate_quantities(ctx)
    errors.extend(_validate_line_totals(ctx))
    errors.extend(_validate_totals(ctx))
    if errors:
        return errors
    errors.extend(validate_invoice_xml(cii_invoice_xml(ctx)))
    return errors
