from __future__ import annotations

import base64
import io
import hashlib
import json
import logging
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from fastapi import HTTPException
from sqlalchemy.orm import Session
import pikepdf

from .storage import inbound_attachment_key, put_object
from ..models import InboundInvoice, InboundInvoiceAttachment, InboundInvoiceEvent, Tenant
from ..services.document_attachments import (
    get_purchase_attachment_unknown_size_count,
    get_used_bytes,
    resolve_limits_for_tenant,
)
from ..services.inbox_facturx import parse_facturx_xml
from ..services.inbox_cii_parser import parse_cii_xml
from ..services.inbox_ubl_parser import parse_ubl_xml
from ..services.inbox_parsers import InvoiceParseResult
from ..services.inbox_xml_detect import detect_invoice_xml_kind
from ..services.pdp.base import InboundMessage
from ..utils.public_errors import sanitize_public_error_message


logger = logging.getLogger(__name__)


def _safe_persisted_validation_messages(
    values: list[str] | None,
    *,
    fallback: str,
) -> list[str]:
    """Keep inbox validation fields user-facing, including legacy parsers."""

    safe_messages: list[str] = []
    for value in (values or [])[:100]:
        raw = str(value or "").strip()
        if not raw:
            continue
        force_fallback = "location:" in raw.lower() or "failed-assert" in raw.lower()
        safe = fallback if force_fallback else sanitize_public_error_message(
            raw,
            status_code=422,
            fallback=fallback,
            max_chars=500,
        )
        if safe != raw:
            logger.warning(
                "inbound_validation_message_redacted",
                extra={"validation_message": raw[:2000], "message_truncated": len(raw) > 2000},
            )
        if safe not in safe_messages:
            safe_messages.append(safe)
    return safe_messages


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
        except Exception:
            return None
    return None


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time(), tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 10_000_000_000:
            ts = ts / 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except Exception:
            return None
    return None


def _parse_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_digits(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = "".join(ch for ch in value if ch.isdigit())
    return cleaned or None


def _hash_payload(payload: Any) -> str | None:
    try:
        raw = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str)
    except Exception:
        return None
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _decode_base64(value: str) -> bytes | None:
    try:
        return base64.b64decode(value, validate=True)
    except Exception:
        return None


def _read_filespec_stream(filespec) -> bytes | None:
    ef = filespec.get("/EF") if hasattr(filespec, "get") else None
    if not ef:
        return None
    stream = ef.get("/F") if hasattr(ef, "get") else None
    if not stream:
        return None
    return stream.read_bytes()


def _extract_facturx_xml_from_pdf(pdf_bytes: bytes) -> bytes | None:
    try:
        with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
            root = pdf.Root
            names = root.get("/Names")
            if names:
                embedded_files = names.get("/EmbeddedFiles")
                if embedded_files:
                    entries_obj = embedded_files.get("/Names")
                    entries: list[Any] = list(cast(Any, entries_obj)) if entries_obj is not None else []
                    if entries:
                        for idx in range(0, max(len(entries) - 1, 0), 2):
                            name = str(entries[idx]).lower()
                            if ("factur-x" in name or "facturx" in name) and name.endswith(".xml"):
                                xml_bytes = _read_filespec_stream(entries[idx + 1])
                                if xml_bytes:
                                    return xml_bytes
            af_obj = root.get("/AF")
            af_entries: list[Any] = list(cast(Any, af_obj)) if af_obj is not None else []
            for filespec in af_entries:
                if not hasattr(filespec, "get"):
                    continue
                name = str(filespec.get("/F") or filespec.get("/UF") or "").lower()
                if ("factur-x" in name or "facturx" in name) and name.endswith(".xml"):
                    xml_bytes = _read_filespec_stream(filespec)
                    if xml_bytes:
                        return xml_bytes
    except Exception:
        return None
    return None


def _extract_attachments(payload: dict[str, Any]) -> list[tuple[str, bytes]]:
    attachments: list[tuple[str, bytes]] = []

    raw_list = payload.get("attachments")
    if isinstance(raw_list, list):
        for item in raw_list:
            if not isinstance(item, dict):
                continue
            kind = (_text(item.get("kind")) or _text(item.get("type")) or "").lower()
            if kind not in {"pdf", "xml"}:
                filename = (_text(item.get("filename")) or "").lower()
                if filename.endswith(".pdf"):
                    kind = "pdf"
                elif filename.endswith(".xml"):
                    kind = "xml"
            content = None
            raw_content = item.get("content")
            content_base64 = item.get("content_base64")
            data_base64 = item.get("data")
            if isinstance(raw_content, bytes):
                content = raw_content
            elif isinstance(content_base64, str):
                content = _decode_base64(content_base64)
            elif isinstance(data_base64, str):
                content = _decode_base64(data_base64)
            if content and kind in {"pdf", "xml"}:
                attachments.append((kind, content))

    for kind in ("pdf", "xml"):
        raw_value = payload.get(kind)
        if isinstance(raw_value, str):
            content = _decode_base64(raw_value)
            if content:
                attachments.append((kind, content))
    return attachments


def _enforce_inbound_attachment_quota(
    db: Session,
    *,
    tenant_id: str,
    attachments: list[tuple[str, bytes]],
    existing_by_kind: dict[str, InboundInvoiceAttachment],
) -> None:
    if not attachments:
        return
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).with_for_update().first()
    limits = resolve_limits_for_tenant(tenant)
    if limits.max_file_bytes:
        oversized = [
            {"kind": kind, "size_bytes": len(content)}
            for kind, content in attachments
            if len(content) > limits.max_file_bytes
        ]
        if oversized:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "purchase_attachment_file_too_large",
                    "message": "Pièce jointe achat trop volumineuse.",
                    "max_file_bytes": limits.max_file_bytes,
                    "files": oversized,
                },
            )
    if not limits.quota_bytes:
        return
    unknown_size_count = get_purchase_attachment_unknown_size_count(db, tenant_id)
    current_unknown = sum(
        1 for kind, _content in attachments if kind in existing_by_kind and existing_by_kind[kind].size_bytes is None
    )
    if unknown_size_count and unknown_size_count > current_unknown:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "purchase_attachment_size_backfill_required",
                "message": "Stockage pièces jointes à recalculer avant nouvel import achat.",
                "unknown_size_count": unknown_size_count,
            },
        )

    delta_bytes = 0
    for kind, content in attachments:
        existing = existing_by_kind.get(kind)
        sha256 = hashlib.sha256(content).hexdigest()
        if existing and existing.sha256 == sha256:
            continue
        previous_size = int(existing.size_bytes or 0) if existing else 0
        delta_bytes += max(0, len(content) - previous_size)

    if not delta_bytes:
        return
    used_bytes = get_used_bytes(db, tenant_id)
    if used_bytes + delta_bytes > limits.quota_bytes:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "purchase_attachment_quota_exceeded",
                "message": "Quota de stockage des justificatifs atteint.",
                "quota_bytes": limits.quota_bytes,
                "used_bytes": used_bytes,
            },
        )


def _message_payload(message: InboundMessage | dict[str, Any]) -> dict[str, Any]:
    if isinstance(message, InboundMessage):
        payload = message.payload or {}
        return {
            "message_id": message.message_id,
            "payload": payload,
            "received_at": message.received_at,
            "raw": message.raw or payload,
        }
    raw_payload = message.get("payload")
    payload = raw_payload if isinstance(raw_payload, dict) else message
    return {
        "message_id": message.get("message_id") or message.get("id"),
        "payload": payload or {},
        "received_at": message.get("received_at") or message.get("timestamp"),
        "raw": message,
    }


def ingest_inbound_message(
    db: Session,
    *,
    tenant_id: str,
    provider_slug: str | None,
    message: InboundMessage | dict[str, Any],
) -> InboundInvoice:
    message_payload = _message_payload(message)
    payload_obj = message_payload.get("payload")
    payload: dict[str, Any] = payload_obj if isinstance(payload_obj, dict) else {}

    invoice_obj = payload.get("invoice")
    invoice_payload: dict[str, Any] = invoice_obj if isinstance(invoice_obj, dict) else payload
    message_id = message_payload.get("message_id") or payload.get("external_message_id")
    message_id = str(message_id) if message_id else None

    invoice = None
    if message_id:
        invoice = (
            db.query(InboundInvoice)
            .filter(InboundInvoice.tenant_id == tenant_id, InboundInvoice.external_message_id == message_id)
            .first()
        )

    supplier_raw = invoice_payload.get("supplier")
    supplier_block = supplier_raw if isinstance(supplier_raw, dict) else {}
    supplier_label = supplier_raw if isinstance(supplier_raw, str) else None
    supplier_name = _text(invoice_payload.get("supplier_name") or supplier_block.get("name") or supplier_label)
    supplier_siren = _normalize_digits(
        invoice_payload.get("supplier_siren") or supplier_block.get("siren") or invoice_payload.get("siren")
    )
    supplier_siret = _normalize_digits(
        invoice_payload.get("supplier_siret") or supplier_block.get("siret") or invoice_payload.get("siret")
    )
    invoice_number = _text(invoice_payload.get("invoice_number") or invoice_payload.get("number"))
    issue_date = _parse_date(invoice_payload.get("issue_date") or invoice_payload.get("date"))
    total_ttc = _parse_decimal(invoice_payload.get("total_ttc") or invoice_payload.get("total_inc_vat"))
    currency = _text(invoice_payload.get("currency"))
    invoice_format = _text(invoice_payload.get("format") or payload.get("format"))
    received_at = _parse_datetime(message_payload.get("received_at") or payload.get("received_at"))

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    created = False
    if not invoice:
        invoice = InboundInvoice(
            tenant_id=tenant_id,
            provider_slug=provider_slug,
            supplier_name=supplier_name,
            supplier_siren=supplier_siren,
            supplier_siret=supplier_siret,
            invoice_number=invoice_number,
            issue_date=issue_date,
            currency=currency or "EUR",
            received_at=received_at or now,
            format=invoice_format,
            external_message_id=message_id,
            status="received",
            created_at=now,
            updated_at=now,
        )
        db.add(invoice)
        if total_ttc is not None:
            setattr(invoice, "total_ttc", total_ttc)
        db.flush()
        created = True
    else:
        invoice.provider_slug = provider_slug or invoice.provider_slug
        invoice.supplier_name = supplier_name or invoice.supplier_name
        invoice.supplier_siren = supplier_siren or invoice.supplier_siren
        invoice.supplier_siret = supplier_siret or invoice.supplier_siret
        invoice.invoice_number = invoice_number or invoice.invoice_number
        invoice.issue_date = issue_date or invoice.issue_date
        if total_ttc is not None:
            setattr(invoice, "total_ttc", total_ttc)
        invoice.currency = currency or invoice.currency
        invoice.received_at = received_at or invoice.received_at
        invoice.format = invoice_format or invoice.format
        if invoice.status != "acknowledged":
            invoice.status = "received"
        invoice.updated_at = now

    attachments = _extract_attachments(payload)
    xml_payload: bytes | None = None
    if attachments:
        existing = (
            db.query(InboundInvoiceAttachment).filter(InboundInvoiceAttachment.inbound_invoice_id == invoice.id).all()
        )
        invoice_id = invoice.id
        if not invoice_id:
            raise ValueError("Inbound invoice id manquant")
        existing_by_kind = {att.kind: att for att in existing}
        _enforce_inbound_attachment_quota(
            db,
            tenant_id=tenant_id,
            attachments=attachments,
            existing_by_kind=existing_by_kind,
        )
        for kind, content in attachments:
            if kind == "xml" and not xml_payload:
                xml_payload = content
            sha256 = hashlib.sha256(content).hexdigest()
            if kind in existing_by_kind and existing_by_kind[kind].sha256 == sha256:
                continue
            key = inbound_attachment_key(invoice_id, kind)
            content_type = "application/pdf" if kind == "pdf" else "application/xml"
            put_object(key, content, content_type)
            if kind in existing_by_kind:
                existing_by_kind[kind].storage_key = key
                existing_by_kind[kind].sha256 = sha256
                existing_by_kind[kind].size_bytes = len(content)
                existing_by_kind[kind].created_at = now
            else:
                db.add(
                    InboundInvoiceAttachment(
                        inbound_invoice_id=invoice_id,
                        kind=kind,
                        storage_key=key,
                        sha256=sha256,
                        size_bytes=len(content),
                        created_at=now,
                    )
                )

    if xml_payload:
        kind = detect_invoice_xml_kind(xml_payload)
        if kind == "facturx_cii":
            parsed_invoice = parse_facturx_xml(xml_payload)
        elif kind == "cii":
            parsed_invoice = parse_cii_xml(xml_payload)
        elif kind == "ubl":
            parsed_invoice = parse_ubl_xml(xml_payload)
        else:
            parsed_invoice = InvoiceParseResult(
                format=None,
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
                validation_errors=["Format XML non reconnu."],
                validation_warnings=[],
            )
        invoice.format = parsed_invoice.format or invoice.format
        if parsed_invoice.invoice_number:
            invoice.invoice_number = parsed_invoice.invoice_number
        if parsed_invoice.issue_date:
            invoice.issue_date = parsed_invoice.issue_date
        if parsed_invoice.total_ttc is not None:
            setattr(invoice, "total_ttc", parsed_invoice.total_ttc)
        if parsed_invoice.total_ex_vat is not None:
            setattr(invoice, "total_ex_vat", parsed_invoice.total_ex_vat)
        if parsed_invoice.total_vat is not None:
            setattr(invoice, "total_vat", parsed_invoice.total_vat)
        if parsed_invoice.currency:
            invoice.currency = parsed_invoice.currency
        if parsed_invoice.supplier_name:
            invoice.supplier_name = parsed_invoice.supplier_name
        if parsed_invoice.supplier_siren:
            invoice.supplier_siren = parsed_invoice.supplier_siren
        if parsed_invoice.supplier_siret:
            invoice.supplier_siret = parsed_invoice.supplier_siret
        invoice.facturx_profile = parsed_invoice.profile or invoice.facturx_profile
        if parsed_invoice.purchase_lines and not invoice.purchase_lines:
            invoice.purchase_lines = parsed_invoice.purchase_lines
        public_validation_errors = _safe_persisted_validation_messages(
            parsed_invoice.validation_errors,
            fallback="Le document contient des informations à corriger avant de poursuivre.",
        )
        public_validation_warnings = _safe_persisted_validation_messages(
            parsed_invoice.validation_warnings,
            fallback="Un contrôle du document n’a pas pu être terminé. Réessayez plus tard.",
        )
        invoice.validation_status = parsed_invoice.validation_status
        invoice.validation_errors = public_validation_errors
        invoice.validation_warnings = public_validation_warnings
        invoice.validated_at = datetime.now(timezone.utc).replace(tzinfo=None)

        validation_payload = {
            "format": parsed_invoice.format,
            "profile": parsed_invoice.profile,
            "status": parsed_invoice.validation_status,
            "errors": public_validation_errors,
            "warnings": public_validation_warnings,
        }
        db.add(
            InboundInvoiceEvent(
                inbound_invoice_id=invoice.id,
                type="validation",
                payload_hash=_hash_payload(validation_payload),
                created_at=now,
            )
        )

    event_type = "ingested" if created else "updated"
    raw_payload = message_payload.get("raw")
    payload_hash = _hash_payload(raw_payload or payload)
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=invoice.id,
            type=event_type,
            payload_hash=payload_hash,
            created_at=now,
        )
    )

    db.commit()
    db.refresh(invoice)
    return invoice
