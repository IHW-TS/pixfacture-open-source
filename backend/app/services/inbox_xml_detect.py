from __future__ import annotations

from lxml import etree

from ..services.cii import NS
from ..utils.xml_security import parse_xml_bytes


_FACTURX_GUIDELINE_HINTS = (
    "factur-x",
    "facturx",
    "urn:factur-x",
    "factur-x.eu",
    "extended-ctc-fr",
    "cpro.gouv.fr:1p0:extended-ctc-fr",
)


def detect_invoice_xml_kind(xml_bytes: bytes) -> str:
    try:
        root = parse_xml_bytes(xml_bytes)
    except Exception:
        return "unknown"
    qname = etree.QName(root)
    local = (qname.localname or "").lower()
    ns = (qname.namespace or "").lower()
    if local == "invoice":
        if "oasis" in ns or "ubl" in ns:
            return "ubl"
    if local == "crossindustryinvoice":
        guideline = root.find(
            ".//ram:GuidelineSpecifiedDocumentContextParameter/ram:ID",
            namespaces=NS,
        )
        guideline_value = "".join(guideline.itertext()).strip().lower() if guideline is not None else ""
        if guideline_value and any(hint in guideline_value for hint in _FACTURX_GUIDELINE_HINTS):
            return "facturx_cii"
        return "cii"
    return "unknown"
