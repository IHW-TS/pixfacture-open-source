from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading

from lxml import etree

from .cii import FACTURX_GUIDELINES, NS
from .document_attachments import sanitize_filename
from .facturx import facturx_from_pdf_xml
from ..utils.pdp_errors import PdpPreSubmitError, PdpProviderError


CHORUS_FSO1117A_EN16931_GUIDELINE = "urn:cen.eu:en16931:2017"
FACTURX_EN16931_GUIDELINE = FACTURX_GUIDELINES["en16931"]
_CHORUS_FACTURX_MAX_WORKERS = 2
_CHORUS_FACTURX_MAX_IN_FLIGHT = 4
_CHORUS_FACTURX_EXECUTOR = ThreadPoolExecutor(
    max_workers=_CHORUS_FACTURX_MAX_WORKERS,
    thread_name_prefix="chorus-facturx",
)
_CHORUS_FACTURX_SLOTS = threading.BoundedSemaphore(_CHORUS_FACTURX_MAX_IN_FLIGHT)


def chorus_invoice_filename(invoice_number: object | None) -> str:
    """Return the bounded ASCII filename sent to Chorus."""

    raw = str(invoice_number or "").strip()
    safe = sanitize_filename(raw) if raw else "invoice"
    if safe.lower().endswith(".pdf"):
        safe = safe[:-4]
    safe = safe.strip("._-")
    if not safe or not any(char.isalnum() for char in safe):
        safe = "invoice"
    return sanitize_filename(f"{safe}.pdf")


def chorus_fso1117a_xml(xml_bytes: bytes) -> bytes:
    """Return a Chorus FSO1117A-specific copy of an EN 16931 CII payload.

    Chorus Pro EDI specification V4.23 (rule S2.20) currently expects the
    short ``urn:cen.eu:en16931:2017`` guideline for the EN 16931 profile.  The
    canonical Factur-X artifact keeps the standard FNFE guideline everywhere
    else; only the copy packaged for Chorus is adapted here.
    """

    try:
        parser = etree.XMLParser(
            resolve_entities=False,
            no_network=True,
            recover=False,
            huge_tree=False,
        )
        root = etree.fromstring(xml_bytes, parser=parser)
    except (etree.XMLSyntaxError, TypeError, ValueError) as exc:
        raise PdpProviderError(
            "Le document Factur-X ne peut pas être préparé pour le canal public.",
            code="chorus_facturx_invalid",
            retryable=False,
        ) from exc

    expected_root = f"{{{NS['rsm']}}}CrossIndustryInvoice"
    if root.tag != expected_root:
        raise PdpProviderError(
            "Le document Factur-X ne peut pas être préparé pour le canal public.",
            code="chorus_facturx_invalid",
            retryable=False,
        )

    guideline_nodes = root.xpath(
        "./rsm:ExchangedDocumentContext/"
        "ram:GuidelineSpecifiedDocumentContextParameter/ram:ID",
        namespaces=NS,
    )
    if len(guideline_nodes) != 1:
        raise PdpProviderError(
            "Le profil Factur-X du document est absent ou ambigu.",
            code="chorus_facturx_profile_invalid",
            retryable=False,
        )

    guideline = guideline_nodes[0]
    current = str(guideline.text or "").strip()
    if current == CHORUS_FSO1117A_EN16931_GUIDELINE:
        return bytes(xml_bytes)
    if current != FACTURX_EN16931_GUIDELINE:
        raise PdpProviderError(
            "Le profil Factur-X de cette facture n'est pas compatible avec le dépôt Chorus configuré.",
            code="chorus_facturx_profile_unsupported",
            retryable=False,
        )

    guideline.text = CHORUS_FSO1117A_EN16931_GUIDELINE
    return etree.tostring(root, encoding="UTF-8", xml_declaration=True)


def chorus_fso1117a_pdf(pdf_bytes: bytes, xml_bytes: bytes) -> bytes:
    """Package an immutable invoice copy for the Chorus FSO1117A channel."""

    chorus_xml = chorus_fso1117a_xml(xml_bytes)
    return facturx_from_pdf_xml(pdf_bytes, chorus_xml, "en16931")


async def chorus_fso1117a_pdf_async(pdf_bytes: bytes, xml_bytes: bytes) -> bytes:
    """Package the Chorus copy off-loop with bounded process-wide capacity."""

    loop = asyncio.get_running_loop()
    if not _CHORUS_FACTURX_SLOTS.acquire(blocking=False):
        raise PdpPreSubmitError(
            "La préparation du document Chorus est momentanément occupée. Réessayez dans un instant.",
            code="chorus_facturx_busy",
            retryable=True,
        )
    try:
        concurrent_future = _CHORUS_FACTURX_EXECUTOR.submit(
            chorus_fso1117a_pdf,
            pdf_bytes,
            xml_bytes,
        )
    except RuntimeError as exc:
        _CHORUS_FACTURX_SLOTS.release()
        raise PdpPreSubmitError(
            "La préparation du document Chorus est momentanément indisponible.",
            code="chorus_facturx_busy",
            retryable=True,
        ) from exc

    # Release capacity when the real worker finishes, not when an awaiting
    # request is cancelled. This prevents cancelled requests from filling the
    # executor's otherwise-unbounded internal queue.
    concurrent_future.add_done_callback(lambda _future: _CHORUS_FACTURX_SLOTS.release())
    future = asyncio.wrap_future(concurrent_future, loop=loop)
    return await asyncio.shield(future)
