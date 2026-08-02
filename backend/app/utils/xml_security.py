from __future__ import annotations

from lxml import etree


class UnsafeXmlError(ValueError):
    """Raised when XML input uses constructs rejected for user/provider XML."""


def _as_bytes(xml: bytes | str) -> bytes:
    return xml if isinstance(xml, bytes) else xml.encode("utf-8")


def reject_unsafe_xml(xml: bytes | str) -> None:
    payload = _as_bytes(xml).lower()
    if b"<!doctype" in payload:
        raise UnsafeXmlError("DOCTYPE is not allowed in XML inputs.")


def secure_xml_parser() -> etree.XMLParser:
    return etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)


def parse_xml_bytes(xml: bytes | str) -> etree._Element:
    reject_unsafe_xml(xml)
    return etree.fromstring(_as_bytes(xml), parser=secure_xml_parser())  # nosec B320
