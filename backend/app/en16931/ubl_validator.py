from __future__ import annotations

from pathlib import Path
from typing import List
import logging
import re

from ..services.ubl import ubl_document_xml
from ..utils.xml_security import parse_xml_bytes

try:
    from saxonche import PySaxonProcessor
except Exception:  # pragma: no cover - optional dependency
    PySaxonProcessor = None


logger = logging.getLogger(__name__)
_UBL_UNAVAILABLE_MESSAGE = (
    "Le controle UBL EN16931 est temporairement indisponible. "
    "Vous pouvez reessayer ou contacter le support si le probleme persiste."
)

_XSLT_PATH = (
    Path(__file__).resolve().parent
    / "xslt"
    / "EN16931-UBL-validation.xslt"
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


def is_ubl_validator_available() -> bool:
    return _get_xslt_exec() is not None


def get_ubl_validator_metadata() -> dict[str, str] | None:
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


def get_ubl_validator_version() -> str | None:
    meta = get_ubl_validator_metadata()
    if not meta:
        return None
    return meta.get("version")


def _svrl_errors(svrl_xml: str) -> List[str]:
    ns = {"svrl": "http://purl.oclc.org/dsdl/svrl"}
    root = parse_xml_bytes(svrl_xml)
    errors: List[str] = []
    for node in root.findall(".//svrl:failed-assert", namespaces=ns):
        text_node = node.find("svrl:text", namespaces=ns)
        text = "".join(text_node.itertext()).strip() if text_node is not None else ""
        location = node.get("location")
        flag = node.get("flag")
        msg = text or "Regle EN16931 non satisfaite."
        if flag:
            msg = f"[{flag}] {msg}"
        if location:
            msg = f"{msg} (location: {location})"
        errors.append(msg)
    return errors


def validate_ubl_xml(xml_bytes: bytes) -> List[str]:
    xslt_exec = _get_xslt_exec()
    if xslt_exec is None or _SAXON is None:
        return [
            _UBL_UNAVAILABLE_MESSAGE,
        ]
    try:
        xml_text = xml_bytes.decode("utf-8")
        xdm = _SAXON.parse_xml(xml_text=xml_text)
        svrl = xslt_exec.transform_to_string(xdm_node=xdm)
    except Exception:
        logger.exception("Controle UBL EN16931 echoue")
        return [
            _UBL_UNAVAILABLE_MESSAGE,
        ]
    if not svrl:
        return [
            _UBL_UNAVAILABLE_MESSAGE,
        ]
    return _svrl_errors(svrl)


def validate_ubl_ctx(ctx: dict) -> List[str]:
    return validate_ubl_xml(ubl_document_xml(ctx))
