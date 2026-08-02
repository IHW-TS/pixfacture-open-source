from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services.inbox_cii_parser import parse_cii_xml  # noqa: E402
from app.services.inbox_facturx import parse_facturx_xml  # noqa: E402
from app.services.inbox_ubl_parser import parse_ubl_xml  # noqa: E402
from app.services.inbox_xml_detect import detect_invoice_xml_kind  # noqa: E402


FIXTURES = {
    "facturx": ("facturx_cii_minimal.xml", "facturx_cii"),
    "cii": ("cii_invoice_minimal.xml", "cii"),
    "ubl": ("ubl_invoice_minimal.xml", "ubl"),
}


def _load_fixture(name: str) -> bytes:
    path = ROOT / "tests" / "fixtures" / name
    return path.read_bytes()


def _assert_parsed(label: str, parsed, expected_format: str) -> None:
    missing = []
    if not parsed.invoice_number:
        missing.append("invoice_number")
    if not parsed.issue_date:
        missing.append("issue_date")
    if parsed.total_ex_vat is None:
        missing.append("total_ex_vat")
    if parsed.total_vat is None:
        missing.append("total_vat")
    if parsed.total_ttc is None:
        missing.append("total_ttc")
    if not parsed.currency:
        missing.append("currency")
    if missing:
        raise SystemExit(f"[{label}] champs manquants: {', '.join(missing)}")
    if parsed.validation_status == "invalid":
        raise SystemExit(f"[{label}] validation_status=invalid")
    if parsed.format != expected_format:
        raise SystemExit(f"[{label}] format inattendu: {parsed.format}")


def main() -> int:
    for label, (filename, expected_kind) in FIXTURES.items():
        xml_bytes = _load_fixture(filename)
        kind = detect_invoice_xml_kind(xml_bytes)
        if kind != expected_kind:
            raise SystemExit(f"[{label}] kind inattendu: {kind} (attendu {expected_kind})")
        if kind == "facturx_cii":
            parsed = parse_facturx_xml(xml_bytes)
            _assert_parsed(label, parsed, "facturx")
        elif kind == "cii":
            parsed = parse_cii_xml(xml_bytes)
            _assert_parsed(label, parsed, "cii")
        elif kind == "ubl":
            parsed = parse_ubl_xml(xml_bytes)
            _assert_parsed(label, parsed, "ubl")
        else:
            raise SystemExit(f"[{label}] format non supporte: {kind}")
    print("Conformance fixtures: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
