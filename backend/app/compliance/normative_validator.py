from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path

from lxml import etree
from ..utils.xml_security import parse_xml_bytes

try:
    from lxml.isoschematron import Schematron
except Exception:  # pragma: no cover - optional dependency
    Schematron = None


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    source: str
    level: str = "error"
    line: int | None = None
    column: int | None = None
    path: str | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "code": self.code,
            "message": self.message,
            "source": self.source,
            "level": self.level,
        }
        if self.line is not None:
            payload["line"] = self.line
        if self.column is not None:
            payload["column"] = self.column
        if self.path:
            payload["path"] = self.path
        return payload


def _parse_xml(xml_bytes: bytes, source: str) -> tuple[etree._Element | None, list[Issue]]:
    try:
        root = parse_xml_bytes(xml_bytes)
    except Exception:
        logger.exception("normative_xml_parse_failed", extra={"source": source})
        return None, [Issue(code="xml_parse_error", message="Le document XML ne peut pas être lu.", source=source)]
    return root, []


def _schematron_issues(report) -> list[Issue]:
    if report is None:
        return [
            Issue(
                code="schematron_report_missing",
                message="Rapport Schematron manquant.",
                source="schematron",
            )
        ]
    root = report.getroot() if hasattr(report, "getroot") else report
    ns = {"svrl": "http://purl.oclc.org/dsdl/svrl"}
    issues: list[Issue] = []
    for node in root.findall(".//svrl:failed-assert", namespaces=ns):
        text_node = node.find("svrl:text", namespaces=ns)
        text = "".join(text_node.itertext()).strip() if text_node is not None else ""
        location = node.get("location")
        message = text or "Règle de validation non satisfaite."
        issues.append(
            Issue(
                code="schematron_failed_assert",
                message=message,
                source="schematron",
                path=location,
            )
        )
    return issues


def validate_xml_with_xsd(xml_bytes: bytes, xsd_path: str | Path) -> list[Issue]:
    path = Path(xsd_path)
    try:
        schema_doc = etree.parse(str(path))  # nosec B320
        schema = etree.XMLSchema(schema_doc)
    except Exception:
        logger.exception("xsd_load_failed", extra={"path": str(path)})
        return [
            Issue(
                code="xsd_load_error",
                message="Le contrôle de structure XML est temporairement indisponible.",
                source="xsd",
            )
        ]
    root, issues = _parse_xml(xml_bytes, "xsd")
    if issues:
        return issues
    if schema.validate(root):
        return []
    errors: list[Issue] = []
    for error in schema.error_log:
        errors.append(
            Issue(
                code="xsd_validation_error",
                message=error.message,
                source="xsd",
                line=getattr(error, "line", None),
                column=getattr(error, "column", None),
                path=getattr(error, "path", None),
            )
        )
    return errors


def validate_xml_with_schematron(xml_bytes: bytes, sch_path: str | Path) -> list[Issue]:
    if Schematron is None:
        return [
            Issue(
                code="schematron_unavailable",
                message="Le contrôle des règles métier est temporairement indisponible.",
                source="schematron",
            )
        ]
    path = Path(sch_path)
    try:
        sch_doc = etree.parse(str(path))  # nosec B320
        schematron = Schematron(sch_doc, store_report=True)
    except Exception:
        logger.exception("schematron_load_failed", extra={"path": str(path)})
        return [
            Issue(
                code="schematron_load_error",
                message="Le contrôle des règles métier est temporairement indisponible.",
                source="schematron",
            )
        ]
    root, issues = _parse_xml(xml_bytes, "schematron")
    if issues:
        return issues
    try:
        ok = schematron.validate(root)
    except Exception:
        logger.exception("schematron_validation_failed", extra={"path": str(path)})
        return [
            Issue(
                code="schematron_validation_error",
                message="Le contrôle des règles métier n’a pas pu être terminé.",
                source="schematron",
            )
        ]
    if ok:
        return []
    return _schematron_issues(schematron.validation_report)
