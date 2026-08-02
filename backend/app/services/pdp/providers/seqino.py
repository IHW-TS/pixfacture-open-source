from __future__ import annotations

import base64
import hashlib
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, TypeGuard, cast
from urllib.parse import urlparse

import httpx
from lxml import etree

from ....config import settings
from ....db import SessionLocal
from ...cii import cii_invoice_xml
from ...facturx import facturx_from_pdf_xml, facturx_pdf
from ....models import Tenant
from ...storage import get_object_bytes
from ....utils.seqino_auth import normalize_seqino_authorization
from ....utils.pdp_outbound import log_pdp_outbound_call, tenant_id_from_credentials
from ....utils.seqino_http import (
    SeqinoHttpError,
    new_correlation_id,
    seqino_error_from_exception,
    seqino_error_from_response,
    seqino_raise_for_status,
    seqino_request_checked,
)
from ....utils.xml_security import parse_xml_bytes
from ....utils.ssrf import validate_outbound_url
from ...seqino_invoice_draft import validate_seqino_invoice_draft
from ..base import (
    EReportingEvent,
    EReportingLinePayload,
    EReportingReportPayload,
    InboundMessage,
    PdpProvider,
    StatusResult,
    TransmissionResult,
)
from ..utils import PdpProviderError, normalize_status


_HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=5.0)
logger = logging.getLogger(__name__)

_SEQINO_EREPORTING_4XX_ERROR_CODE = "seqino_http_4xx"
_SEQINO_CII_GUIDELINE_ID = "urn:cen.eu:en16931:2017"
_SEQINO_INBOX_PAGE_SIZE = 100
_SEQINO_INBOX_MAX_PAGES = 1000
_SEQINO_INBOUND_FILE_MAX_BYTES = 10 * 1024 * 1024
_CII_NS = {
    "rsm": "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
    "ram": "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
}
_SEQINO_STATUS_CODE_MAP = {
    "invoicelifecyclestatus.deposited": "submitted",
    "invoicelifecyclestatus.transmitted_by_platform": "processing",
    "invoicelifecyclestatus.received_by_platform": "processing",
    "invoicelifecyclestatus.made_available": "available",
    "invoicelifecyclestatus.acknowledged": "processing",
    "invoicelifecyclestatus.approved": "accepted",
    "invoicelifecyclestatus.partially_approved": "accepted",
    "invoicelifecyclestatus.in_dispute": "processing",
    "invoicelifecyclestatus.suspended": "processing",
    "invoicelifecyclestatus.completed": "accepted",
    "invoicelifecyclestatus.refused": "refused",
    "invoicelifecyclestatus.payment_transmitted": "paid",
    "invoicelifecyclestatus.collected": "cashed",
    "invoicelifecyclestatus.rejected": "rejected",
    "deposited": "submitted",
    "processing": "processing",
    "processed": "processing",
    "pending": "processing",
    "in_progress": "processing",
    "submitted": "submitted",
    "created": "submitted",
    "queued": "submitted",
    "made_available": "available",
    "received": "processing",
    "accepted": "accepted",
    "approved": "accepted",
    "available": "available",
    "delivered": "available",
    "done": "accepted",
    "ok": "accepted",
    "rejected": "rejected",
    "refused": "refused",
    "paid": "paid",
    "payment_transmitted": "paid",
    "cashed": "cashed",
    "collected": "cashed",
    "invalid": "rejected",
    "failed": "rejected",
    "error": "rejected",
    "cancelled": "rejected",
    "canceled": "rejected",
}


def _extract_external_id(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    for key in (
        "invoice_id",
        "payment_id",
        "external_id",
        "id",
        "object_id",
        "submission_id",
        "uuid",
        "reference",
    ):
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


def _extract_status_value(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    for key in (
        "status",
        "state",
        "status_code",
        "code",
        "result",
        "new_status",
        "target_status",
    ):
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


def _extract_status_code(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    for key in ("status_code", "statusCode"):
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


def _map_lifecycle_status(status_code: str | None, raw_status: str | None = None) -> str:
    value = status_code or raw_status
    if not value:
        return "unknown"
    key = str(value).strip().lower()
    mapped = _SEQINO_STATUS_CODE_MAP.get(key)
    if mapped:
        return mapped
    normalized = normalize_status(str(value))
    if normalized in {"submitted", "processing", "available", "accepted", "refused", "rejected", "paid", "cashed"}:
        return normalized
    return normalized


_SEQINO_ERROR_KEYS = (
    "errors",
    "error",
    "detail",
    "details",
    "validation_errors",
    "validationErrors",
    "issues",
    "violations",
    "reasons",
)
_SEQINO_MESSAGE_KEYS = (
    "rejection_reason",
    "rejectionReason",
    "reject_reason",
    "rejectReason",
    "refusal_reason",
    "refusalReason",
    "reason",
    "reason_code",
    "reasonCode",
    "status_reason",
    "statusReason",
    "error_message",
    "errorMessage",
    "message",
    "label",
    "description",
)


def _stringify_seqino_error(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        for key in _SEQINO_MESSAGE_KEYS:
            text = _stringify_seqino_error(raw.get(key))
            if text:
                return text
        code = raw.get("code") or raw.get("status_code") or raw.get("statusCode")
        field = raw.get("field") or raw.get("path")
        if code and field:
            return f"{field}: {code}"
        if code:
            return str(code)
        return None
    if isinstance(raw, list):
        parts = []
        for item in raw:
            text = _stringify_seqino_error(item)
            if text:
                parts.append(text)
            if len(parts) >= 3:
                break
        return " ; ".join(parts) if parts else None
    text = str(raw).strip()
    return text or None


def _extract_status_message(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    for key in _SEQINO_MESSAGE_KEYS:
        text = _stringify_seqino_error(data.get(key))
        if text:
            return text
    for key in _SEQINO_ERROR_KEYS:
        text = _stringify_seqino_error(data.get(key))
        if text:
            return text
    return None


def _extract_errors(data: dict[str, Any] | None) -> list[str] | None:
    if not data:
        return None
    errors: list[str] = []
    for key in _SEQINO_ERROR_KEYS:
        text = _stringify_seqino_error(data.get(key))
        if text:
            errors.append(text)
    if not errors:
        text = _extract_status_message(data)
        if text:
            errors.append(text)
    return errors or None


def _extract_event_id(data: dict[str, Any] | None) -> str | None:
    if not data:
        return None
    for key in ("event_id", "eventId", "event", "id", "uuid", "reference"):
        raw = data.get(key)
        if raw:
            return str(raw)
    return None


def _status_result_from_invoice_lookup(data: dict[str, Any] | None, correlation_id: str) -> StatusResult | None:
    if not data:
        return None
    raw_status = _extract_status_value(data)
    if not raw_status:
        return None
    status = _map_lifecycle_status(None, raw_status)
    message = _extract_status_message(data)
    event = {
        "event_type": "status_lookup",
        "status": status,
        "raw_status": raw_status,
        "message": message,
        "payload": {
            "invoice_id": _extract_external_id(data),
            "status": raw_status,
            "direction": data.get("direction"),
            "updated_at": data.get("updated_at"),
        },
        "occurred_at": _parse_timestamp(data.get("updated_at") or data.get("generated_at") or data.get("created_at")),
        "event_id": _extract_event_id(data),
        "source": "seqino_invoice_lookup",
        "correlation_id": correlation_id,
    }
    return StatusResult(status=status, raw_status=raw_status, errors=_extract_errors(data), events=[event])


def _prepare_seqino_cii_xml(xml_bytes: bytes) -> bytes:
    root = parse_xml_bytes(xml_bytes)
    for node in root.xpath(".//ram:GuidelineSpecifiedDocumentContextParameter/ram:ID", namespaces=_CII_NS):
        node.text = _SEQINO_CII_GUIDELINE_ID
    for party_path in (".//ram:SellerTradeParty", ".//ram:BuyerTradeParty"):
        parties = root.xpath(party_path, namespaces=_CII_NS)
        for party in parties:
            if party.xpath("./ram:URIUniversalCommunication", namespaces=_CII_NS):
                continue
            legal_ids = party.xpath("./ram:SpecifiedLegalOrganization/ram:ID/text()", namespaces=_CII_NS)
            legal_id = (str(legal_ids[0]).strip() if legal_ids else "")
            if not legal_id:
                continue
            communication = etree.Element(f"{{{_CII_NS['ram']}}}URIUniversalCommunication")
            uri_id = etree.SubElement(communication, f"{{{_CII_NS['ram']}}}URIID")
            uri_id.set("schemeID", "0225")
            uri_id.text = legal_id
            tax_registration = party.find(f"{{{_CII_NS['ram']}}}SpecifiedTaxRegistration")
            if tax_registration is not None:
                party.insert(list(party).index(tax_registration), communication)
            else:
                party.append(communication)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8")


def _has_invoice_generation_context(ctx: dict | None) -> TypeGuard[dict[str, Any]]:
    return isinstance(ctx, dict) and isinstance(ctx.get("invoice"), dict)


def _parse_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 10_000_000_000:
            ts = ts / 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
        except ValueError:
            return None
    return None


def _format_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        raw = value.strip()
        return raw or None
    return str(value)


def _coerce_iso_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
        except ValueError:
            try:
                return date.fromisoformat(raw).isoformat()
            except ValueError:
                return None
    return None


def _normalize_country_code(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    return raw.upper()


def _amount_value(amounts: dict[str, Any] | None, keys: tuple[str, ...]) -> Any:
    if not amounts:
        return None
    for key in keys:
        if key in amounts and amounts[key] is not None:
            return amounts[key]
    return None


def _metadata_value(metadata: dict[str, Any] | None, keys: tuple[str, ...]) -> str | None:
    if not metadata:
        return None
    for key in keys:
        raw = metadata.get(key)
        if raw is not None:
            value = str(raw).strip()
            if value:
                return value
    return None


def _normalize_seqino_mode(value: str | None) -> str | None:
    if value is None:
        return None
    raw = str(value).strip().lower()
    if not raw:
        return None
    return raw.replace("-", "_")


def _event_type_key(event_type: str | None) -> str:
    return (event_type or "").strip().lower()


def _is_payment_event(event_type: str | None) -> bool:
    return "payment" in _event_type_key(event_type)


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _coerce_decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        amount = value if isinstance(value, Decimal) else Decimal(str(value).strip())
    except (InvalidOperation, TypeError, ValueError):
        return None
    return amount if amount.is_finite() else None


def _decimal_json_amount(value: Decimal) -> float:
    """Round monetary aggregates deterministically before JSON encoding."""

    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _payment_date_value(payment_date: Any, metadata: dict[str, Any] | None) -> str | None:
    if metadata:
        raw = metadata.get("payment_date") or metadata.get("event_date") or metadata.get("date")
        if raw is not None:
            return _coerce_iso_date(raw)
    return _coerce_iso_date(payment_date)


def _build_payment_payload_v2(
    *,
    amounts: dict[str, Any] | None,
    payment_date: Any,
    metadata: dict[str, Any] | None,
    tenant_siren: str | None,
) -> tuple[dict[str, Any], list[str]]:
    amount = _amount_value(amounts, ("amount", "total_ttc", "total_amount", "total_inc_vat", "total"))
    currency = _amount_value(amounts, ("currency", "currency_code"))
    if currency is None:
        currency = _metadata_value(metadata, ("currency", "currency_code"))
    invoice_number = _metadata_value(metadata, ("invoice_number", "invoiceNumber"))
    payload = {
        "client_siren": _metadata_value(metadata, ("client_siren", "siren")) or tenant_siren,
        "payment_date": _payment_date_value(payment_date, metadata),
        "amount": amount,
        "currency": currency,
        "invoice_number": invoice_number,
    }
    missing = _missing_fields(payload, ("client_siren", "payment_date", "amount"))
    return {key: value for key, value in payload.items() if value is not None}, missing


def _event_date_value(metadata: dict[str, Any] | None, fallback: Any = None) -> str | None:
    if metadata:
        raw = (
            metadata.get("event_date")
            or metadata.get("transaction_date")
            or metadata.get("date")
        )
        if raw is not None:
            return _coerce_iso_date(raw)
    if fallback is not None:
        return _coerce_iso_date(fallback)
    return None


def _amount_excl_tax(amounts: dict[str, Any] | None) -> Decimal | None:
    raw = _amount_value(amounts, ("total_ht", "total_ex_vat", "amount_excl_tax", "net_amount"))
    explicit = _coerce_decimal(raw)
    if explicit is not None:
        return explicit
    # A TTC value is never itself an HT value. Derive HT only when the tax
    # amount is explicit; otherwise fail closed and request complete data.
    total_incl_tax = _coerce_decimal(
        _amount_value(amounts, ("total_ttc", "total_amount", "total_inc_vat", "amount"))
    )
    tax_amount = _coerce_decimal(_amount_value(amounts, ("tax_amount", "vat_amount", "total_vat")))
    if total_incl_tax is None or tax_amount is None:
        return None
    return total_incl_tax - tax_amount


def _vat_rate_from_amounts(
    amounts: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
) -> float | None:
    raw = _amount_value(amounts, ("vat_rate", "tax_rate"))
    if raw is None and metadata:
        raw = metadata.get("vat_rate") or metadata.get("tax_rate")
    rate = _coerce_float(raw)
    if rate is not None:
        return rate
    total_ht = _coerce_float(_amount_value(amounts, ("total_ht", "total_ex_vat", "amount_excl_tax")))
    tax_amount = _coerce_float(_amount_value(amounts, ("tax_amount", "vat_amount", "total_vat")))
    if total_ht and tax_amount is not None:
        try:
            return round((tax_amount / total_ht) * 100.0, 4)
        except ZeroDivisionError:
            return 0.0
    return None


def _sale_kind(metadata: dict[str, Any] | None) -> str:
    if metadata:
        raw = (
            metadata.get("sale_kind")
            or metadata.get("operation_nature")
            or metadata.get("item_type")
            or metadata.get("line_kind")
        )
        if isinstance(raw, bool):
            return "services" if raw else "goods"
        if isinstance(raw, str):
            key = raw.strip().lower()
            if key in {"service", "services"}:
                return "services"
            if key in {"goods", "product", "products"}:
                return "goods"
    return "goods"


def _merge_sales_map(
    target: dict[float, Decimal],
    vat_rate: float | None,
    amount: Decimal | None,
) -> bool:
    if amount is None:
        return False
    rate_key = vat_rate if vat_rate is not None else 0.0
    target[rate_key] = target.get(rate_key, Decimal("0")) + amount
    return True


def _merge_sales_list(
    target: dict[float, Decimal],
    raw_items: Any,
    tax_target: dict[float, Decimal] | None = None,
) -> bool:
    if not isinstance(raw_items, list):
        return False
    added = False
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        rate = _coerce_float(item.get("vat_rate") or item.get("rate"))
        amount = _coerce_decimal(item.get("amount") if item.get("amount") is not None else item.get("total"))
        if _merge_sales_map(target, rate, amount):
            rate_key = rate if rate is not None else 0.0
            tax_amount = _coerce_decimal(
                item.get("tax_amount") if item.get("tax_amount") is not None else item.get("vat_amount")
            )
            if tax_amount is None and amount is not None:
                tax_amount = amount * Decimal(str(rate_key)) / Decimal("100")
            if tax_target is not None and tax_amount is not None:
                tax_target[rate_key] = tax_target.get(rate_key, Decimal("0")) + tax_amount
            added = True
    return added


def _build_exempt_invoice_payload(
    *,
    amounts: dict[str, Any] | None,
    country: str | None,
    client_country: str | None,
    metadata: dict[str, Any] | None,
    event_type: str | None,
) -> tuple[dict[str, Any], list[str]]:
    model = None
    if metadata:
        for key in ("invoice_draft", "invoice_model", "model", "invoice"):
            value = metadata.get(key)
            if isinstance(value, dict):
                model = value
                break
    payload = {
        "direction": _metadata_value(metadata, ("direction",)) or _direction_from_event_type(event_type),
        "country_code": _normalize_country_code(
            _metadata_value(metadata, ("country_code", "country")) or client_country or country
        ),
        "model": model if isinstance(model, dict) else None,
    }
    missing = _missing_fields(payload, ("country_code",))
    if not isinstance(model, dict) or not model:
        missing.append("model")
    else:
        model_missing = validate_seqino_invoice_draft(model)
        missing.extend([f"model.{field}" for field in model_missing])
    return {key: value for key, value in payload.items() if value is not None}, missing


def _reporting_route(event_type: str | None) -> str:
    if not event_type:
        raise ValueError("Type d'e-reporting manquant pour la plateforme partenaire.")
    key = event_type.strip().lower()
    if key == "international_sale":
        return "/reporting/exempt-invoices"
    if key == "b2c_sale":
        return "/reporting/b2c-transactions"
    if key.endswith("_payment"):
        return "/reporting/payments"
    raise ValueError(f"Type d'e-reporting non supporte: {event_type}")


def _build_payment_payload(
    *,
    amounts: dict[str, Any] | None,
    payment_date: Any,
    metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    amount = _amount_value(amounts, ("amount", "total_ttc", "total_amount", "total_inc_vat", "total"))
    currency = _amount_value(amounts, ("currency", "currency_code"))
    payload = {
        "client_siren": _metadata_value(metadata, ("client_siren", "siren")),
        "payment_date": _format_date(payment_date),
        "amount": amount,
        "currency": currency,
    }
    if payload["payment_date"] is None or payload["amount"] is None:
        raise ValueError("payment_date/amount requis pour l'e-reporting paiement.")
    return {key: value for key, value in payload.items() if value is not None}


def _build_b2c_payload(
    *,
    amounts: dict[str, Any] | None,
    country: str | None,
    client_country: str | None,
    metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    amount = _amount_value(amounts, ("amount", "total_ttc", "total_amount", "total_inc_vat", "total"))
    currency = _amount_value(amounts, ("currency", "currency_code"))
    tax_amount = _amount_value(amounts, ("tax_amount", "vat_amount", "total_vat"))
    amount_excl_tax = _amount_value(amounts, ("total_ht", "amount_excl_tax", "total_ex_vat"))
    country_code = _normalize_country_code(
        _metadata_value(metadata, ("country_code", "country")) or client_country or country
    )
    payload = {
        "direction": _metadata_value(metadata, ("direction",)) or "outgoing",
        "country_code": country_code,
        "amount": amount,
        "currency": currency,
        "tax_amount": tax_amount,
        "amount_excl_tax": amount_excl_tax,
    }
    if payload["country_code"] is None or payload["amount"] is None:
        raise ValueError("country_code/amount requis pour l'e-reporting B2C.")
    return {key: value for key, value in payload.items() if value is not None}


def _build_exempt_payload(
    *,
    amounts: dict[str, Any] | None,
    country: str | None,
    client_country: str | None,
    metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    amount = _amount_value(amounts, ("amount", "total_ttc", "total_amount", "total_inc_vat", "total"))
    currency = _amount_value(amounts, ("currency", "currency_code"))
    country_code = _normalize_country_code(
        _metadata_value(metadata, ("country_code", "country")) or client_country or country
    )
    payload = {
        "direction": _metadata_value(metadata, ("direction",)) or "outgoing",
        "country_code": country_code,
        "model": _metadata_value(metadata, ("model", "exempt_model")) or "export",
        "amount": amount,
        "currency": currency,
    }
    if payload["country_code"] is None or payload["model"] is None:
        raise ValueError("country_code/model requis pour l'e-reporting exempt.")
    return {key: value for key, value in payload.items() if value is not None}


def _seqino_ereporting_payload(
    *,
    event_type: str,
    amounts: dict[str, Any] | None,
    payment_date: Any,
    country: str | None,
    client_country: str | None,
    metadata: dict[str, Any] | None,
) -> tuple[str, dict[str, Any]]:
    path = _reporting_route(event_type)
    if path == "/reporting/payments":
        return path, _build_payment_payload(amounts=amounts, payment_date=payment_date, metadata=metadata)
    if path == "/reporting/exempt-invoices":
        return path, _build_exempt_payload(
            amounts=amounts,
            country=country,
            client_country=client_country,
            metadata=metadata,
        )
    if path == "/reporting/b2c-transactions":
        return path, _build_b2c_payload(
            amounts=amounts,
            country=country,
            client_country=client_country,
            metadata=metadata,
        )
    raise ValueError(f"Type d'e-reporting non supporte: {event_type}")


def _seqino_ereporting_mode(credentials: dict | None) -> str:
    env_raw = os.environ.get("EREPORTING_SEQINO_MODE")
    env_mode = _normalize_seqino_mode(env_raw) if env_raw is not None else None
    if env_mode:
        return env_mode
    if credentials:
        for key in ("ereporting_mode", "seqino_ereporting_mode"):
            raw = _normalize_seqino_mode(credentials.get(key))
            if raw:
                return raw
    env_default = _normalize_seqino_mode(getattr(settings, "EREPORTING_SEQINO_MODE", None))
    if env_default:
        return env_default
    return "payments_only"


def _seqino_v1_route(event_type: str | None) -> str | None:
    if not event_type:
        return None
    key = event_type.strip().lower()
    if "payment" in key:
        return "/reporting/payments"
    if "b2c" in key:
        return "/reporting/b2c-transactions"
    if "international" in key or "exempt" in key:
        return "/reporting/exempt-invoices"
    return None


def _direction_from_event_type(event_type: str | None) -> str | None:
    if not event_type:
        return None
    key = event_type.strip().lower()
    if "sale" in key:
        return "outgoing"
    if "purchase" in key:
        return "incoming"
    return None


def _missing_fields(payload: dict[str, Any], required: tuple[str, ...]) -> list[str]:
    missing: list[str] = []
    for field in required:
        value = payload.get(field)
        if value is None:
            missing.append(field)
        elif isinstance(value, str) and not value.strip():
            missing.append(field)
    return missing


def _seqino_v1_payment_date(payment_date: Any, metadata: dict[str, Any] | None) -> str | None:
    if metadata:
        raw = metadata.get("event_date") or metadata.get("payment_date") or metadata.get("date")
        if raw is not None:
            return _coerce_iso_date(raw)
    return _coerce_iso_date(payment_date)


def _seqino_v1_payload(
    *,
    event_type: str | None,
    amounts: dict[str, Any] | None,
    payment_date: Any,
    country: str | None,
    client_country: str | None,
    metadata: dict[str, Any] | None,
    tenant_siren: str | None,
) -> tuple[str | None, dict[str, Any], list[str]]:
    path = _seqino_v1_route(event_type)
    if not path:
        return None, {}, ["event_type"]

    if path == "/reporting/payments":
        payload: dict[str, Any] = {
            "client_siren": tenant_siren,
            "payment_date": _seqino_v1_payment_date(payment_date, metadata),
            "amount": _amount_value(amounts, ("total_ttc",)),
            "currency": _amount_value(amounts, ("currency",)),
        }
        invoice_number = _metadata_value(metadata, ("invoice_number", "invoiceNumber", "invoice_no"))
        if invoice_number:
            payload["invoice_number"] = invoice_number
        missing = _missing_fields(payload, ("client_siren", "payment_date", "amount", "currency"))
        return path, {key: value for key, value in payload.items() if value is not None}, missing

    if path == "/reporting/b2c-transactions":
        payload = {
            "direction": _metadata_value(metadata, ("direction",)) or _direction_from_event_type(event_type),
            "country_code": _normalize_country_code(
                _metadata_value(metadata, ("country_code", "country")) or client_country or country
            ),
            "amount": _amount_value(amounts, ("total_ttc",)),
            "currency": _amount_value(amounts, ("currency",)),
        }
        missing = _missing_fields(payload, ("country_code", "amount", "currency"))
        return path, {key: value for key, value in payload.items() if value is not None}, missing

    payload = {
        "direction": _metadata_value(metadata, ("direction",)) or _direction_from_event_type(event_type),
        "country_code": _normalize_country_code(
            _metadata_value(metadata, ("country_code", "country")) or client_country or country
        ),
        "model": _metadata_value(metadata, ("model", "exempt_model")),
    }
    missing = _missing_fields(payload, ("direction", "country_code", "model"))
    return path, {key: value for key, value in payload.items() if value is not None}, missing


def _build_b2c_requests(
    items: list[tuple[int, dict[str, Any]]],
    results: list[TransmissionResult | None],
) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str | None], dict[str, Any]] = {}
    item_by_index = {idx: item for idx, item in items}
    requests: list[dict[str, Any]] = []

    for idx, item in items:
        metadata = item.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}
        transaction_date = _event_date_value(metadata)
        if not transaction_date:
            results[idx] = _seqino_incomplete_result(
                metadata,
                event_type=item.get("event_type"),
                missing=["transaction_date"],
            )
            continue
        currency = _amount_value(item.get("amounts"), ("currency", "currency_code")) or _metadata_value(
            metadata, ("currency", "currency_code")
        )
        if not currency:
            results[idx] = _seqino_incomplete_result(
                metadata,
                event_type=item.get("event_type"),
                missing=["currency"],
            )
            continue
        store_location = _metadata_value(
            metadata,
            ("store_location", "store", "location", "shop", "shop_id", "store_id"),
        )

        goods_sales: dict[float, Decimal] = {}
        services_sales: dict[float, Decimal] = {}
        goods_taxes: dict[float, Decimal] = {}
        services_taxes: dict[float, Decimal] = {}
        added = False
        if _merge_sales_list(goods_sales, metadata.get("goods_sales"), goods_taxes):
            added = True
        if _merge_sales_list(services_sales, metadata.get("services_sales"), services_taxes):
            added = True
        if not added:
            amount = _amount_excl_tax(item.get("amounts"))
            if amount is None:
                results[idx] = _seqino_incomplete_result(
                    metadata,
                    event_type=item.get("event_type"),
                    missing=["amount"],
                )
                continue
            vat_rate = _vat_rate_from_amounts(item.get("amounts"), metadata)
            rate_key = vat_rate if vat_rate is not None else 0.0
            tax_amount = _coerce_decimal(
                _amount_value(item.get("amounts"), ("tax_amount", "vat_amount", "total_vat"))
            )
            if tax_amount is None:
                tax_amount = amount * Decimal(str(rate_key)) / Decimal("100")
            if _sale_kind(metadata) == "services":
                added = _merge_sales_map(services_sales, vat_rate, amount)
                if added:
                    services_taxes[rate_key] = services_taxes.get(rate_key, Decimal("0")) + tax_amount
            else:
                added = _merge_sales_map(goods_sales, vat_rate, amount)
                if added:
                    goods_taxes[rate_key] = goods_taxes.get(rate_key, Decimal("0")) + tax_amount
        if not added:
            results[idx] = _seqino_incomplete_result(
                metadata,
                event_type=item.get("event_type"),
                missing=["sales"],
            )
            continue

        group_key = (transaction_date, str(currency), store_location)
        group = groups.setdefault(
            group_key,
            {
                "indices": [],
                "transaction_date": transaction_date,
                "currency": str(currency),
                "store_location": store_location,
                "goods_sales": {},
                "services_sales": {},
                "goods_taxes": {},
                "services_taxes": {},
                "goods_counts": {},
                "services_counts": {},
                "rate_indices": {},
                "correlation_id": item.get("correlation_id"),
            },
        )
        group["indices"].append(idx)
        if not group.get("correlation_id") and item.get("correlation_id"):
            group["correlation_id"] = item.get("correlation_id")
        for rate, amount in goods_sales.items():
            group["goods_sales"][rate] = group["goods_sales"].get(rate, Decimal("0")) + amount
            group["goods_taxes"][rate] = group["goods_taxes"].get(rate, Decimal("0")) + goods_taxes.get(
                rate, Decimal("0")
            )
            group["goods_counts"][rate] = group["goods_counts"].get(rate, 0) + 1
            group["rate_indices"].setdefault(rate, set()).add(idx)
        for rate, amount in services_sales.items():
            group["services_sales"][rate] = group["services_sales"].get(rate, Decimal("0")) + amount
            group["services_taxes"][rate] = group["services_taxes"].get(rate, Decimal("0")) + services_taxes.get(
                rate, Decimal("0")
            )
            group["services_counts"][rate] = group["services_counts"].get(rate, 0) + 1
            group["rate_indices"].setdefault(rate, set()).add(idx)

    for group in groups.values():
        goods_sales = group["goods_sales"]
        services_sales = group["services_sales"]
        if not goods_sales and not services_sales:
            for idx in group["indices"]:
                item = item_by_index.get(idx) or {}
                if results[idx] is None:
                    results[idx] = _seqino_incomplete_result(
                        (item.get("metadata") if isinstance(item, dict) else None),
                        event_type=item.get("event_type") if isinstance(item, dict) else None,
                        missing=["sales"],
                    )
            continue
        # The public 0.25.11 example accepts one object per category and VAT
        # rate, not the former list/services_sales shape. The public contract
        # also documents no idempotency/reconciliation key for several POSTs
        # representing one daily aggregate. Fail closed for multi-rate days
        # until the provider has qualified that flow in writing and sandbox;
        # otherwise a timeout/retry could duplicate only part of the day.
        rates = sorted(set(goods_sales) | set(services_sales))
        if len(rates) > 1:
            for idx in group["indices"]:
                item = item_by_index.get(idx) or {}
                results[idx] = _seqino_incomplete_result(
                    item.get("metadata") if isinstance(item, dict) else None,
                    event_type=item.get("event_type") if isinstance(item, dict) else None,
                    missing=["b2c_multi_rate_provider_qualification"],
                )
            continue
        for rate in rates:
            payload: dict[str, Any] = {
                "transaction_date": group["transaction_date"],
                "currency": group["currency"],
            }
            if group.get("store_location"):
                payload["store_location"] = group["store_location"]
            goods_amount = goods_sales.get(rate)
            if goods_amount is not None:
                payload["goods_sales"] = {
                    "tax_exclusive_amount": _decimal_json_amount(goods_amount),
                    "tax_amount": _decimal_json_amount(group["goods_taxes"].get(rate, Decimal("0"))),
                    "tax_rate": rate,
                    "transaction_count": int(group["goods_counts"].get(rate, 0)),
                }
            services_amount = services_sales.get(rate)
            if services_amount is not None:
                payload["services"] = {
                    "tax_exclusive_amount": _decimal_json_amount(services_amount),
                    "tax_amount": _decimal_json_amount(group["services_taxes"].get(rate, Decimal("0"))),
                    "tax_rate": rate,
                    "transaction_count": int(group["services_counts"].get(rate, 0)),
                }
            requests.append(
                {
                    "indices": sorted(group["rate_indices"].get(rate) or group["indices"]),
                    "path": "/reporting/b2c-transactions",
                    "payload": payload,
                    "correlation_id": group.get("correlation_id"),
                }
            )
    return requests


def _prepare_seqino_requests(
    *,
    mode: str,
    items: list[dict[str, Any]],
    tenant_siren: str | None,
    results: list[TransmissionResult | None],
) -> list[dict[str, Any]]:
    requests: list[dict[str, Any]] = []

    if mode == "payments_only":
        for idx, item in enumerate(items):
            event_type = item.get("event_type")
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else None
            if not _is_payment_event(event_type):
                results[idx] = _seqino_skipped_result(
                    metadata,
                    event_type=event_type,
                    reason="payments_only",
                )
                continue
            payload, missing = _build_payment_payload_v2(
                amounts=item.get("amounts"),
                payment_date=item.get("payment_date"),
                metadata=metadata,
                tenant_siren=tenant_siren,
            )
            if missing:
                results[idx] = _seqino_incomplete_result(
                    metadata,
                    event_type=event_type,
                    missing=missing,
                )
                continue
            requests.append(
                {
                    "indices": [idx],
                    "path": "/reporting/payments",
                    "payload": payload,
                    "correlation_id": item.get("correlation_id"),
                }
            )
        return requests

    if mode == "full":
        b2c_items: list[tuple[int, dict[str, Any]]] = []
        for idx, item in enumerate(items):
            event_type = item.get("event_type")
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else None
            key = _event_type_key(event_type)
            if _is_payment_event(key):
                payload, missing = _build_payment_payload_v2(
                    amounts=item.get("amounts"),
                    payment_date=item.get("payment_date"),
                    metadata=metadata,
                    tenant_siren=tenant_siren,
                )
                if missing:
                    results[idx] = _seqino_incomplete_result(
                        metadata,
                        event_type=event_type,
                        missing=missing,
                    )
                    continue
                requests.append(
                    {
                        "indices": [idx],
                        "path": "/reporting/payments",
                        "payload": payload,
                        "correlation_id": item.get("correlation_id"),
                    }
                )
                continue
            if key == "b2c_sale":
                b2c_items.append((idx, item))
                continue
            if key == "international_sale":
                payload, missing = _build_exempt_invoice_payload(
                    amounts=item.get("amounts"),
                    country=item.get("country"),
                    client_country=item.get("client_country"),
                    metadata=metadata,
                    event_type=event_type,
                )
                if missing:
                    results[idx] = _seqino_incomplete_result(
                        metadata,
                        event_type=event_type,
                        missing=missing,
                    )
                    continue
                requests.append(
                    {
                        "indices": [idx],
                        "path": "/reporting/exempt-invoices",
                        "payload": payload,
                        "correlation_id": item.get("correlation_id"),
                    }
                )
                continue
            results[idx] = _seqino_incomplete_result(
                metadata,
                event_type=event_type,
                missing=["event_type"],
            )

        requests.extend(_build_b2c_requests(b2c_items, results))
        return requests

    return requests


def _event_payload(event: EReportingEvent) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": event.event_type}
    if event.amounts is not None:
        payload["amounts"] = event.amounts
    if event.payment_date is not None:
        payload["payment_date"] = event.payment_date.isoformat()
    if event.country is not None:
        payload["country"] = event.country
    if event.client_country is not None:
        payload["client_country"] = event.client_country
    if event.client_vat_number is not None:
        payload["client_vat_number"] = event.client_vat_number
    if event.client_type is not None:
        payload["client_type"] = event.client_type
    if event.metadata:
        payload["metadata"] = event.metadata
    return payload


def _line_payload(line: EReportingLinePayload) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": line.event_type}
    if line.line_id is not None:
        payload["id"] = line.line_id
    if line.amounts is not None:
        payload["amounts"] = line.amounts
    if line.payment_date is not None:
        payload["payment_date"] = line.payment_date.isoformat()
    if line.country is not None:
        payload["country"] = line.country
    if line.client_country is not None:
        payload["client_country"] = line.client_country
    if line.client_vat_number is not None:
        payload["client_vat_number"] = line.client_vat_number
    if line.client_type is not None:
        payload["client_type"] = line.client_type
    if line.metadata:
        payload["metadata"] = line.metadata
    return payload


def _result_items(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict):
        results_raw = data.get("results")
        if isinstance(results_raw, list):
            return [item for item in results_raw if isinstance(item, dict)]
        items_raw = data.get("items")
        if isinstance(items_raw, list):
            return [item for item in items_raw if isinstance(item, dict)]
        data_raw = data.get("data")
        if isinstance(data_raw, list):
            return [item for item in data_raw if isinstance(item, dict)]
        return [data]
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


def _normalize_digits(value: Any) -> str | None:
    if value is None:
        return None
    raw = "".join(ch for ch in str(value) if ch.isdigit())
    return raw or None


def _resolve_tenant_siren(tenant_id: str | None) -> str | None:
    if not tenant_id:
        return None
    with SessionLocal() as db:
        tenant = db.get(Tenant, tenant_id)
    if not tenant:
        return None
    siret = _normalize_digits(tenant.siret)
    if not siret or len(siret) < 9:
        return None
    return siret[:9]


def _parse_since_cursor(cursor: str | None) -> str | None:
    if not cursor:
        return None
    raw = str(cursor).strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc) - timedelta(seconds=1)
        return parsed.isoformat().replace("+00:00", "Z")
    except ValueError:
        pass
    try:
        parsed_date = date.fromisoformat(raw)
        parsed = datetime.combine(parsed_date, datetime.min.time(), tzinfo=timezone.utc)
        return parsed.isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def _extract_invoice_items(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict):
        for key in ("items", "invoices", "results", "data"):
            raw_items = data.get(key)
            if isinstance(raw_items, list):
                return [item for item in raw_items if isinstance(item, dict)]
        if any(k in data for k in ("invoice_id", "id", "uuid")):
            return [data]
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


def _infer_file_kind(item: dict[str, Any]) -> str | None:
    raw = item.get("kind") or item.get("type") or item.get("format") or item.get("file_type")
    if isinstance(raw, str):
        key = raw.strip().lower()
        if key in {"pdf", "facturx", "invoice_pdf"}:
            return "pdf"
        if key in {"xml", "cii", "ubl"}:
            return "xml"
    filename = ""
    for name_key in ("filename", "name", "file_name"):
        value = item.get(name_key)
        if isinstance(value, str):
            filename = value.lower()
            break
    if filename.endswith(".pdf"):
        return "pdf"
    if filename.endswith(".xml"):
        return "xml"
    content_type = item.get("content_type") or item.get("mime_type")
    if isinstance(content_type, str):
        lowered = content_type.lower()
        if "pdf" in lowered:
            return "pdf"
        if "xml" in lowered:
            return "xml"
    url = item.get("url") or item.get("href") or item.get("download_url")
    if isinstance(url, str):
        lowered = url.lower()
        if lowered.endswith(".pdf"):
            return "pdf"
        if lowered.endswith(".xml"):
            return "xml"
    return None


def _extract_file_links(data: Any) -> list[tuple[str, str]]:
    links: list[tuple[str, str]] = []
    if isinstance(data, dict):
        for key in ("files", "attachments", "documents"):
            raw_items = data.get(key)
            if isinstance(raw_items, list):
                for item in raw_items:
                    if not isinstance(item, dict):
                        continue
                    url = item.get("url") or item.get("href") or item.get("download_url") or item.get("link")
                    if not isinstance(url, str):
                        continue
                    kind = _infer_file_kind(item)
                    if kind:
                        links.append((kind, url))
        for key, kind in (("pdf_url", "pdf"), ("xml_url", "xml"), ("facturx_url", "pdf")):
            value = data.get(key)
            if isinstance(value, str):
                links.append((kind, value))
    elif isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            url = item.get("url") or item.get("href") or item.get("download_url") or item.get("link")
            if not isinstance(url, str):
                continue
            kind = _infer_file_kind(item)
            if kind:
                links.append((kind, url))
    return links


def _extract_file_url(item: dict[str, Any]) -> str | None:
    for key in ("url", "href", "download_url", "link"):
        value = item.get(key)
        if isinstance(value, str):
            url = value.strip()
            if url:
                return url
    return None


def _is_facturx_format(value: Any) -> bool:
    if not value:
        return False
    key = str(value).strip().lower().replace("-", "").replace("_", "")
    return key == "facturx"


def _filename_from_url(url: str) -> str | None:
    try:
        path = urlparse(url).path
    except Exception:
        path = url
    name = path.rsplit("/", 1)[-1].strip()
    return name or None


def _normalize_hostname(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(str(url).strip())
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    return host or None


def _same_hostname(left: str | None, right: str | None) -> bool:
    left_host = _normalize_hostname(left)
    right_host = _normalize_hostname(right)
    return bool(left_host and right_host and left_host == right_host)


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    return raw or None


def _extract_invoice_download(
    data: Any,
) -> tuple[str | None, str | None, str | None, int | None, str | None]:
    if isinstance(data, dict):
        for key in ("facturx_url", "facturxUrl"):
            value = data.get(key)
            if isinstance(value, str):
                url = value.strip()
                if url:
                    return url, None, None, None, "facturx"

    items: list[dict[str, Any]] = []
    if isinstance(data, dict):
        for key in ("available_formats", "files", "attachments", "documents", "items", "results", "data"):
            raw_items = data.get(key)
            if isinstance(raw_items, list):
                items.extend(item for item in raw_items if isinstance(item, dict))
        if _extract_file_url(data):
            items.append(data)
    elif isinstance(data, list):
        items = [item for item in data if isinstance(item, dict)]

    def priority(item: dict[str, Any]) -> int:
        raw_format = item.get("format") or item.get("type") or item.get("kind") or item.get("file_type")
        normalized = str(raw_format or "").strip().lower().replace("-", "").replace("_", "")
        return {"facturx": 0, "cii": 1, "ubl": 2}.get(normalized, 10)

    for item in sorted(items, key=priority):
        raw_format = item.get("format") or item.get("type") or item.get("kind") or item.get("file_type")
        normalized_format = str(raw_format or "").strip().lower().replace("-", "").replace("_", "")
        if normalized_format not in {"facturx", "cii", "ubl"}:
            continue
        file_url = _extract_file_url(item)
        if not file_url:
            continue
        filename = _normalize_text(item.get("filename") or item.get("name") or item.get("file_name"))
        if not filename:
            filename = _filename_from_url(file_url)
        content_type = _normalize_text(
            item.get("content_type") or item.get("mime_type") or item.get("contentType")
        )
        raw_size = item.get("file_size")
        try:
            file_size = int(raw_size) if raw_size is not None else None
        except (TypeError, ValueError):
            file_size = None
        return file_url, filename, content_type, file_size, normalized_format
    return None, None, None, None, None


def _ensure_inbound_file_size(size: int | None) -> None:
    if size is not None and size > _SEQINO_INBOUND_FILE_MAX_BYTES:
        raise PdpProviderError(
            "Fichier entrant plateforme partenaire trop volumineux.",
            code="seqino_inbound_file_too_large",
            retryable=False,
        )


async def _download_inbound_file(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: dict[str, str],
    tenant_id: str | None,
    provider: str,
) -> tuple[bytes, httpx.Headers]:
    """Download an inbound document without buffering beyond the hard limit."""
    stream = getattr(client, "stream", None)
    if not callable(stream):
        # Lightweight test doubles may only implement request(). Production
        # httpx clients always take the streaming branch below.
        response = await seqino_request_checked(
            client,
            "GET",
            url,
            headers=headers,
            tenant_id=tenant_id,
            provider=provider,
        )
        content_length = response.headers.get("content-length")
        try:
            response_size = int(content_length) if content_length is not None else None
        except (TypeError, ValueError):
            response_size = None
        _ensure_inbound_file_size(response_size)
        _ensure_inbound_file_size(len(response.content))
        return response.content, response.headers

    correlation_id = new_correlation_id()
    started_at = time.perf_counter()
    status_code: int | None = None
    error: str | None = None
    try:
        async with stream("GET", url, headers=headers) as response:
            status_code = response.status_code
            response.extensions["correlation_id"] = correlation_id
            content_length = response.headers.get("content-length")
            try:
                response_size = int(content_length) if content_length is not None else None
            except (TypeError, ValueError):
                response_size = None
            _ensure_inbound_file_size(response_size)

            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                _ensure_inbound_file_size(len(content))

            payload = bytes(content)
            if status_code >= 400:
                buffered_response = httpx.Response(
                    status_code,
                    content=payload,
                    headers=response.headers,
                    request=response.request,
                    extensions={"correlation_id": correlation_id},
                )
                seqino_raise_for_status(buffered_response)
            return payload, response.headers
    except httpx.RequestError as exc:
        error = exc.__class__.__name__
        raise seqino_error_from_exception(exc) from exc
    except Exception as exc:
        error = exc.__class__.__name__
        raise
    finally:
        log_pdp_outbound_call(
            endpoint=url,
            method="GET",
            tenant_id=tenant_id,
            correlation_id=correlation_id,
            status_code=status_code,
            latency_ms=(time.perf_counter() - started_at) * 1000.0,
            provider=provider,
            error=error,
        )


def _coerce_invoice_payload(details: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    data = details or {}
    fallback = summary or {}
    fallback_seller_raw = fallback.get("seller")
    fallback_seller_block = (
        cast(dict[str, Any], fallback_seller_raw)
        if isinstance(fallback_seller_raw, dict)
        else {}
    )
    supplier_block: dict[str, Any] = {}
    seller_block: dict[str, Any] = {}
    issuer_block: dict[str, Any] = {}
    supplier_raw = data.get("supplier")
    if isinstance(supplier_raw, dict):
        supplier_block = cast(dict[str, Any], supplier_raw)
    seller_raw = data.get("seller")
    if isinstance(seller_raw, dict):
        seller_block = cast(dict[str, Any], seller_raw)
    issuer_raw = data.get("issuer")
    if isinstance(issuer_raw, dict):
        issuer_block = cast(dict[str, Any], issuer_raw)
    totals_raw = data.get("document_totals")
    totals_block = cast(dict[str, Any], totals_raw) if isinstance(totals_raw, dict) else {}

    def registration_digits(*values: Any) -> str | None:
        for value in values:
            digits = _normalize_digits(value)
            if digits and len(digits) in {9, 14}:
                return digits
        return None

    seller_identifier = None
    seller_identifier_scheme = _normalize_text(
        seller_block.get("seller_identifier_scheme")
        or seller_block.get("party_identifier_scheme")
        or fallback.get("seller_identifier_scheme")
    )
    if seller_identifier_scheme in {"0009", "0225"}:
        seller_identifier = (
            seller_block.get("seller_identifier")
            or seller_block.get("party_identifier")
            or fallback.get("seller_identifier")
        )
    seller_registration = registration_digits(
        seller_block.get("seller_tax_registration_identifier"),
        seller_identifier,
    )
    supplier_name = _normalize_text(
        data.get("supplier_name")
        or supplier_block.get("name")
        or seller_block.get("name")
        or issuer_block.get("name")
        or fallback.get("supplier_name")
        or fallback_seller_block.get("name")
        or fallback.get("supplier")
    )
    supplier_siren = _normalize_digits(
        data.get("supplier_siren")
        or supplier_block.get("siren")
        or seller_block.get("siren")
        or issuer_block.get("siren")
        or fallback.get("supplier_siren")
        or (seller_registration[:9] if seller_registration else None)
    )
    supplier_siret = _normalize_digits(
        data.get("supplier_siret")
        or supplier_block.get("siret")
        or seller_block.get("siret")
        or issuer_block.get("siret")
        or fallback.get("supplier_siret")
        or (seller_registration if seller_registration and len(seller_registration) == 14 else None)
    )
    invoice_number = _normalize_text(
        data.get("invoice_number")
        or data.get("number")
        or data.get("reference")
        or fallback.get("invoice_number")
        or fallback.get("number")
    )
    issue_date = _normalize_text(data.get("issue_date") or data.get("date") or fallback.get("issue_date"))
    total_ttc = (
        data.get("total_ttc")
        or data.get("total_inc_vat")
        or data.get("total_amount")
        or totals_block.get("invoice_total_with_vat")
        or fallback.get("total_ttc")
        or fallback.get("total_inc_vat")
        or fallback.get("total_amount")
    )
    currency = _normalize_text(
        data.get("currency")
        or data.get("currency_code")
        or fallback.get("currency")
        or fallback.get("currency_code")
    )
    payload = {
        "supplier_name": supplier_name,
        "supplier_siren": supplier_siren,
        "supplier_siret": supplier_siret,
        "invoice_number": invoice_number,
        "issue_date": issue_date,
        "total_ttc": total_ttc,
        "currency": currency,
    }
    return {key: value for key, value in payload.items() if value is not None}

def _result_from_item(item: dict[str, Any] | None, metadata: dict[str, Any] | None) -> TransmissionResult:
    status_raw = _extract_status_value(item) if item else None
    status = _map_lifecycle_status(None, status_raw)
    if status == "unknown":
        status = "submitted"
    return TransmissionResult(
        external_id=_extract_external_id(item) if item else None,
        status=status,
        raw_status=status_raw,
        errors=_extract_errors(item) if item else None,
        metadata=metadata,
    )


def _seqino_incomplete_result(
    metadata: dict[str, Any] | None,
    *,
    event_type: str | None,
    missing: list[str],
) -> TransmissionResult:
    identifier = _metadata_value(metadata, ("event_id", "line_id", "report_id"))
    logger.warning(
        "Seqino e-reporting payload incomplete (event_type=%s id=%s missing=%s)",
        event_type,
        identifier,
        ",".join(missing),
    )
    return TransmissionResult(
        external_id=None,
        status="failed",
        message="seqino_payload_incomplete",
        errors=["seqino_payload_incomplete"],
        metadata=metadata,
    )


def _seqino_skipped_result(
    metadata: dict[str, Any] | None,
    *,
    event_type: str | None,
    reason: str,
) -> TransmissionResult:
    identifier = _metadata_value(metadata, ("event_id", "line_id", "report_id"))
    logger.info(
        "Seqino e-reporting skipped (event_type=%s id=%s reason=%s)",
        event_type,
        identifier,
        reason,
    )
    return TransmissionResult(
        external_id=None,
        status="skipped",
        message=reason,
        metadata=metadata,
    )


def _log_seqino_ereporting_4xx(
    *,
    path: str,
    status_code: int,
    count: int,
    event_type: str | None = None,
) -> None:
    logger.warning(
        "Seqino e-reporting client error (status=%s path=%s count=%s event_type=%s error_code=%s)",
        status_code,
        path,
        count,
        event_type,
        _SEQINO_EREPORTING_4XX_ERROR_CODE,
    )


def _seqino_http_4xx_result(metadata: dict[str, Any] | None) -> TransmissionResult:
    return TransmissionResult(
        external_id=None,
        status="failed",
        message=_SEQINO_EREPORTING_4XX_ERROR_CODE,
        metadata=metadata,
    )


class SeqinoPdpProvider(PdpProvider):
    slug = "seqino"
    label = "Plateforme partenaire"
    description = "Connecteur plateforme partenaire via API."
    kind = "b2b"
    auth_type = "server_managed"
    credential_fields: list[dict[str, Any]] = []

    def _raw_access_token(self) -> str:
        raw = (
            self.credentials.get("access_token")
            or self.credentials.get("authorization")
            or self.credentials.get("seqino_access_token")
            or self.credentials.get("api_key")
            or self.credentials.get("token")
            or settings.SEQINO_ACCESS_TOKEN
            or settings.SEQINO_API_KEY
        )
        return (str(raw) if raw is not None else "").strip()

    def _raw_sponsor_id(self) -> str:
        raw = (
            self.credentials.get("sponsor_id")
            or self.credentials.get("pdp_sponsor_id")
            or self.credentials.get("seqino_sponsor_id")
            or settings.SEQINO_SPONSOR_ID
        )
        return (str(raw) if raw is not None else "").strip()

    def missing_server_config(self) -> list[str]:
        missing: list[str] = []
        if not (settings.SEQINO_BASE_URL or "").strip():
            missing.append("SEQINO_BASE_URL")
        if not self._raw_access_token():
            missing.append("SEQINO_ACCESS_TOKEN")
        if not self._raw_sponsor_id():
            missing.append("SEQINO_SPONSOR_ID")
        return missing

    def _base_url(self) -> str:
        base_url = (settings.SEQINO_BASE_URL or "").strip().rstrip("/")
        if not base_url:
            raise PdpProviderError(
                "SEQINO_BASE_URL manquant pour le connecteur plateforme partenaire.",
                code="seqino_config_missing",
            )
        return validate_outbound_url(base_url)

    def _endpoint(self, path: str) -> str:
        url = f"{self._base_url()}/{path.lstrip('/')}"
        return validate_outbound_url(url)

    def _authorization(self) -> str:
        token = self._raw_access_token()
        if not token:
            raise PdpProviderError(
                "Token plateforme partenaire manquant.",
                code="seqino_token_missing",
            )
        return normalize_seqino_authorization(token)

    def _client_id(self) -> str:
        raw = self.credentials.get("client_id") or self.credentials.get("seqino_client_id") or self.credentials.get("pdp_client_id")
        client_id = (str(raw) if raw is not None else "").strip()
        if not client_id:
            raise PdpProviderError(
                "client_id manquant pour le connecteur plateforme partenaire.",
                code="seqino_client_missing",
            )
        return client_id

    def _sponsor_id(self) -> str | None:
        value = self._raw_sponsor_id()
        return value or None

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Authorization": self._authorization(),
            "X-PDP-Client-Id": self._client_id(),
        }
        sponsor_id = self._sponsor_id()
        if sponsor_id:
            headers["X-PDP-Sponsor-Id"] = sponsor_id
        return headers

    async def _ping(self) -> dict[str, Any]:
        candidates = ("/health", "/version")
        last_error = None
        for path in candidates:
            url = self._endpoint(path)
            started = time.monotonic()
            try:
                async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
                    resp = await seqino_request_checked(
                        client,
                        "GET",
                        url,
                        headers=self._headers(),
                        tenant_id=tenant_id_from_credentials(self.credentials),
                        provider=self.slug,
                        raise_for_status=False,
                    )
            except SeqinoHttpError as exc:
                return {"ok": False, "message": str(exc), "code": exc.code}
            latency_ms = int((time.monotonic() - started) * 1000)
            if resp.status_code == 404:
                last_error = "Service de la plateforme agréée indisponible."
                continue
            if resp.status_code >= 400:
                err = seqino_error_from_response(resp)
                return {
                    "ok": False,
                    "latency_ms": latency_ms,
                    "message": str(err),
                    "code": err.code,
                }
            return {"ok": True, "latency_ms": latency_ms}
        return {
            "ok": False,
            "message": last_error or "Endpoint de ping plateforme partenaire indisponible.",
            "code": "seqino_not_ready",
        }

    def _facturx_pdf_bytes(self, invoice: Any, ctx: dict | None = None) -> bytes:
        facturx_key = getattr(invoice, "facturx_key", None)
        if facturx_key:
            facturx_bytes = get_object_bytes(facturx_key)
            if facturx_bytes:
                return facturx_bytes
        pdf_key = getattr(invoice, "pdf_key", None)
        xml_key = getattr(invoice, "xml_key", None)
        if pdf_key and xml_key:
            issued_pdf = get_object_bytes(pdf_key)
            issued_xml = get_object_bytes(xml_key)
            if issued_pdf and issued_xml:
                return facturx_from_pdf_xml(
                    issued_pdf,
                    issued_xml,
                    getattr(invoice, "issued_profile", None),
                )
        if _has_invoice_generation_context(ctx):
            return facturx_pdf(ctx)
        raise ValueError("PDF Factur-X indisponible pour la soumission.")

    def _invoice_file(self, invoice: Any, ctx: dict | None = None) -> tuple[str, bytes, str]:
        xml_key = getattr(invoice, "xml_key", None)
        xml_bytes = get_object_bytes(xml_key) if xml_key else None
        if not xml_bytes and _has_invoice_generation_context(ctx):
            xml_bytes = cii_invoice_xml(ctx)
        if xml_bytes:
            filename = f"{getattr(invoice, 'number', 'invoice')}.xml"
            return filename, _prepare_seqino_cii_xml(xml_bytes), "application/xml"
        filename = f"{getattr(invoice, 'number', 'invoice')}.pdf"
        return filename, self._facturx_pdf_bytes(invoice, ctx), "application/pdf"

    async def test_connection(self) -> dict[str, Any]:
        missing = self.missing_server_config()
        if missing:
            return {
                "ok": False,
                "message": "Cette connexion n’est pas encore configurée. Contactez l’assistance.",
            }
        try:
            self._base_url()
            self._headers()
        except (PdpProviderError, ValueError) as exc:
            return {"ok": False, "message": str(exc)}
        try:
            ping_result = await self._ping()
        except Exception:
            return {
                "ok": False,
                "message": "Le test de connexion est temporairement indisponible.",
            }
        if not isinstance(ping_result, dict):
            return {"ok": False, "message": "Ping plateforme partenaire invalide."}
        ok = bool(ping_result.get("ok"))
        message = ping_result.get("message") or ("Ping plateforme partenaire OK." if ok else "Ping plateforme partenaire en échec.")
        result = {"ok": ok, "message": message}
        if ping_result.get("latency_ms") is not None:
            result["latency_ms"] = ping_result.get("latency_ms")
        return result

    async def send_invoice(self, invoice: Any, ctx: dict | None = None) -> TransmissionResult:
        filename, invoice_bytes, content_type = self._invoice_file(invoice, ctx)
        payload_hash = hashlib.sha256(invoice_bytes).hexdigest()
        tenant_id = tenant_id_from_credentials(self.credentials)
        correlation_id = new_correlation_id()
        headers = self._headers()
        if ctx:
            idempotency_key = ctx.get("idempotency_key")
            if idempotency_key:
                headers = dict(headers)
                headers["Idempotency-Key"] = str(idempotency_key)
                headers["X-Idempotency-Key"] = str(idempotency_key)

        validate_url = self._endpoint("/invoicing/files/validate")
        submit_url = self._endpoint("/invoicing/files/submit")
        files = {"file": (filename, invoice_bytes, content_type)}
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            validate_resp = await seqino_request_checked(
                client,
                "POST",
                validate_url,
                headers=headers,
                files=files,
                tenant_id=tenant_id,
                correlation_id=correlation_id,
                provider=self.slug,
            )
            try:
                validation_data = validate_resp.json()
            except Exception:
                validation_data = None
            if isinstance(validation_data, dict) and validation_data.get("is_valid") is False:
                errors = _extract_errors(validation_data) or []
                issues = validation_data.get("issues")
                if isinstance(issues, list):
                    errors.extend(str(issue) for issue in issues if issue is not None)
                message = "; ".join(errors[:3]) if errors else "Validation Seqino echouee."
                raise PdpProviderError(message, code="seqino_validation_failed", retryable=False)

            submit_resp = await seqino_request_checked(
                client,
                "POST",
                submit_url,
                headers=headers,
                files=files,
                tenant_id=tenant_id,
                correlation_id=correlation_id,
                provider=self.slug,
            )
        try:
            data = submit_resp.json()
        except Exception:
            data = None

        external_id = _extract_external_id(data if isinstance(data, dict) else None)
        if not external_id:
            raise ValueError("invoice_id manquant dans la reponse plateforme partenaire.")
        status_raw = _extract_status_value(data if isinstance(data, dict) else None)
        status = _map_lifecycle_status(None, status_raw)
        if status == "unknown":
            status = "submitted"
        submit_errors: list[str] | None = _extract_errors(data if isinstance(data, dict) else None)

        return TransmissionResult(
            external_id=external_id,
            status=status,
            raw_status=status_raw,
            errors=submit_errors,
            payload_hash=payload_hash,
            events=[
                {
                    "event_type": "submit",
                    "status": status,
                    "raw_status": status_raw,
                    "message": "Soumission enregistree",
                    "errors": submit_errors,
                    "payload": (
                        {
                            "invoice_id": external_id,
                            "status": status_raw,
                        }
                        if isinstance(data, dict)
                        else None
                    ),
                    "occurred_at": datetime.now(timezone.utc).isoformat(),
                    "source": "seqino_submit",
                    "correlation_id": correlation_id,
                }
            ],
        )

    async def poll_status(self, transmission_id: str) -> StatusResult:
        url = self._endpoint("/lifecycle-events")
        params = {"object_type": "invoice", "object_id": transmission_id}
        tenant_id = tenant_id_from_credentials(self.credentials)
        correlation_id = new_correlation_id()
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "GET",
                url,
                headers=self._headers(),
                params=params,
                tenant_id=tenant_id,
                correlation_id=correlation_id,
                provider=self.slug,
            )
        try:
            data = resp.json()
        except Exception:
            data = None

        items: list[dict[str, Any]] = []
        if isinstance(data, dict):
            raw_items = data.get("items") or data.get("events") or data.get("results") or data.get("data")
            if isinstance(raw_items, list):
                items = [item for item in raw_items if isinstance(item, dict)]
        elif isinstance(data, list):
            items = [item for item in data if isinstance(item, dict)]

        events: list[dict[str, Any]] = []
        for item in items:
            status_code = _extract_status_code(item)
            raw_status = status_code or _extract_status_value(item)
            status = _map_lifecycle_status(status_code, raw_status)
            message = _extract_status_message(item)
            occurred_at = _parse_timestamp(
                item.get("occurred_at")
                or item.get("timestamp")
                or item.get("created_at")
                or item.get("date")
            )
            event_id = _extract_event_id(item)
            events.append(
                {
                    "event_type": "status_update",
                    "status": status,
                    "raw_status": raw_status,
                    "message": message,
                    "payload": item,
                    "occurred_at": occurred_at,
                    "event_id": event_id,
                    "source": "seqino_poll",
                    "correlation_id": correlation_id,
                }
            )

        events.sort(
            key=lambda event: (
                str(event.get("occurred_at") or ""),
                str(event.get("event_id") or ""),
            )
        )

        status_raw = None
        status = "unknown"
        known_events = [event for event in events if event.get("status") != "unknown"]
        if known_events:
            last_event = known_events[-1]
            status_raw = last_event.get("raw_status")
            status = last_event.get("status") or "unknown"
        elif isinstance(data, dict):
            status_code = _extract_status_code(data)
            status_raw = status_code or _extract_status_value(data)
            status = _map_lifecycle_status(status_code, status_raw)

        if status != "unknown":
            return StatusResult(
                status=status,
                raw_status=status_raw,
                errors=_extract_errors(data if isinstance(data, dict) else None),
                events=events or None,
            )

        details_url = self._endpoint(f"/invoicing/invoices/{transmission_id}")
        try:
            async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
                details_resp = await seqino_request_checked(
                    client,
                    "GET",
                    details_url,
                    headers=self._headers(),
                    tenant_id=tenant_id,
                    correlation_id=correlation_id,
                    provider=self.slug,
                )
            try:
                details_data = details_resp.json()
            except Exception:
                details_data = None
            lookup_result = _status_result_from_invoice_lookup(
                details_data if isinstance(details_data, dict) else None,
                correlation_id,
            )
            if lookup_result:
                return lookup_result
        except Exception:
            logger.debug(
                "seqino_invoice_lookup_failed",
                extra={"transmission_id": transmission_id, "provider": self.slug},
                exc_info=True,
            )

        return StatusResult(
            status=status,
            raw_status=status_raw,
            errors=_extract_errors(data if isinstance(data, dict) else None),
            events=events or None,
        )

    async def _post_invoice_action(self, invoice_id: str, action: str) -> dict[str, Any] | None:
        normalized_invoice_id = str(invoice_id or "").strip()
        if not normalized_invoice_id:
            raise PdpProviderError(
                "invoice_id plateforme partenaire manquant.",
                code="seqino_invoice_id_missing",
                retryable=False,
            )
        allowed = {"accept", "refuse", "mark_as_paid", "mark_as_cashed"}
        if action not in allowed:
            raise NotImplementedError(f"Action Seqino non supportee: {action}")
        url = self._endpoint(f"/invoicing/invoices/{normalized_invoice_id}/{action}")
        tenant_id = tenant_id_from_credentials(self.credentials)
        correlation_id = new_correlation_id()
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "POST",
                url,
                headers=self._headers(),
                tenant_id=tenant_id,
                correlation_id=correlation_id,
                provider=self.slug,
            )
        try:
            data = resp.json()
        except Exception:
            data = None
        return data if isinstance(data, dict) else None

    async def send_inbox_status(self, message_id: str, action: str) -> None:
        action_key = str(action or "").strip().lower()
        route_action = {
            "accept": "accept",
            "reject": "refuse",
            "refuse": "refuse",
            "mark_as_paid": "mark_as_paid",
            "paid": "mark_as_paid",
        }.get(action_key)
        if not route_action:
            raise NotImplementedError(f"Action inbox Seqino non supportee: {action_key}")
        await self._post_invoice_action(message_id, route_action)

    async def mark_invoice_cashed(self, invoice_id: str) -> None:
        await self._post_invoice_action(invoice_id, "mark_as_cashed")

    async def lookup_directory(self, siren: str) -> list[dict[str, Any]]:
        normalized_siren = _normalize_digits(siren)
        if not normalized_siren or len(normalized_siren) != 9:
            raise PdpProviderError(
                "SIREN invalide pour l'annuaire plateforme partenaire.",
                code="seqino_directory_siren_invalid",
                retryable=False,
            )
        url = self._endpoint(f"/directory/{normalized_siren}")
        tenant_id = tenant_id_from_credentials(self.credentials)
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            resp = await seqino_request_checked(
                client,
                "GET",
                url,
                headers=self._headers(),
                tenant_id=tenant_id,
                provider=self.slug,
            )
        try:
            data = resp.json()
        except Exception as exc:
            raise PdpProviderError(
                "Réponse annuaire plateforme partenaire invalide.",
                code="seqino_directory_response_invalid",
                retryable=True,
            ) from exc
        if not isinstance(data, list):
            raise PdpProviderError(
                "Réponse annuaire plateforme partenaire invalide.",
                code="seqino_directory_response_invalid",
                retryable=True,
            )
        return [item for item in data if isinstance(item, dict)]

    async def fetch_inbox(self, since_cursor: str | None = None) -> list[InboundMessage]:
        url = self._endpoint("/invoicing/invoices")
        base_params: dict[str, Any] = {
            "direction": "incoming",
            "limit": _SEQINO_INBOX_PAGE_SIZE,
        }
        updated_after = _parse_since_cursor(since_cursor)
        if updated_after:
            base_params["updated_after"] = updated_after
        tenant_id = tenant_id_from_credentials(self.credentials)
        messages: list[InboundMessage] = []
        seen_invoice_ids: set[str] = set()
        offset = 0
        page_count = 0

        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            while True:
                page_count += 1
                if page_count > _SEQINO_INBOX_MAX_PAGES:
                    raise PdpProviderError(
                        "Pagination inbox plateforme partenaire anormalement volumineuse.",
                        code="seqino_inbox_pagination_limit",
                        retryable=True,
                    )
                params = {**base_params, "offset": offset}
                resp = await seqino_request_checked(
                    client,
                    "GET",
                    url,
                    headers=self._headers(),
                    params=params,
                    tenant_id=tenant_id,
                    provider=self.slug,
                )
                try:
                    data = resp.json()
                except Exception:
                    data = None

                items = _extract_invoice_items(data)
                total_count = data.get("total_count") if isinstance(data, dict) else None
                try:
                    normalized_total = int(total_count) if total_count is not None else None
                except (TypeError, ValueError):
                    normalized_total = None

                for item in items:
                    invoice_id = _extract_external_id(item)
                    if not invoice_id or invoice_id in seen_invoice_ids:
                        continue
                    seen_invoice_ids.add(invoice_id)
                    received_at = _parse_timestamp(
                        item.get("received_at")
                        or item.get("created_at")
                        or item.get("issue_date")
                        or item.get("date")
                    )

                    details_url = self._endpoint(f"/invoicing/invoice_data/{invoice_id}")
                    details_resp = await seqino_request_checked(
                        client,
                        "GET",
                        details_url,
                        headers=self._headers(),
                        tenant_id=tenant_id,
                        provider=self.slug,
                    )
                    try:
                        details = details_resp.json()
                    except Exception:
                        details = None

                    files_url = self._endpoint(f"/invoicing/invoices/{invoice_id}")
                    files_resp = await seqino_request_checked(
                        client,
                        "GET",
                        files_url,
                        headers=self._headers(),
                        tenant_id=tenant_id,
                        provider=self.slug,
                    )
                    try:
                        files_data = files_resp.json()
                    except Exception:
                        files_data = None

                    attachments: list[dict[str, Any]] = []
                    file_url, file_name, file_content_type, declared_size, file_format = (
                        _extract_invoice_download(files_data)
                    )
                    if file_url:
                        _ensure_inbound_file_size(declared_size)
                        parsed_file_url = urlparse(file_url)
                        is_absolute = (parsed_file_url.scheme or "").lower() in {"http", "https"}
                        if not is_absolute:
                            file_url = f"{self._base_url()}/{file_url.lstrip('/')}"
                        file_url = validate_outbound_url(file_url)
                        headers = self._headers()
                        if is_absolute and not _same_hostname(settings.SEQINO_BASE_URL, file_url):
                            for sensitive_header in (
                                "Authorization",
                                "X-PDP-Client-Id",
                                "X-PDP-Sponsor-Id",
                            ):
                                headers.pop(sensitive_header, None)
                        file_content, file_headers = await _download_inbound_file(
                            client,
                            file_url,
                            headers=headers,
                            tenant_id=tenant_id,
                            provider=self.slug,
                        )
                        content_type = (
                            file_content_type
                            or _normalize_text(file_headers.get("content-type"))
                            or ("application/pdf" if file_format == "facturx" else "application/xml")
                        )
                        filename = (
                            file_name
                            or _filename_from_url(file_url)
                            or f"{invoice_id}.{'pdf' if file_format == 'facturx' else 'xml'}"
                        )
                        attachments.append(
                            {
                                "kind": "pdf" if file_format == "facturx" else "xml",
                                "filename": filename,
                                "content_type": content_type,
                                "content_base64": base64.b64encode(file_content).decode("ascii"),
                            }
                        )

                    invoice_payload = _coerce_invoice_payload(
                        details if isinstance(details, dict) else {},
                        item,
                    )
                    if attachments and not invoice_payload.get("format"):
                        invoice_payload["format"] = file_format or "facturx"

                    payload = {
                        "invoice": invoice_payload,
                        "attachments": attachments,
                        "seqino": {
                            "summary": item,
                            "invoice_data": details if isinstance(details, dict) else None,
                            "files": files_data if isinstance(files_data, dict) else None,
                        },
                    }
                    messages.append(
                        InboundMessage(
                            message_id=str(invoice_id),
                            payload=payload,
                            received_at=received_at,
                            raw={
                                "summary": item,
                                "invoice_data": details if isinstance(details, dict) else None,
                                "files": files_data if isinstance(files_data, dict) else None,
                            },
                            source="seqino",
                            cursor=_parse_timestamp(
                                item.get("updated_at")
                                or item.get("received_at")
                                or item.get("created_at")
                            ),
                        )
                    )

                if normalized_total is not None and offset + len(items) >= normalized_total:
                    break
                if len(items) < _SEQINO_INBOX_PAGE_SIZE:
                    break
                if not items:
                    break
                offset += len(items)
        return messages

    async def send_ereporting(
        self,
        report: EReportingReportPayload | list[EReportingEvent],
    ) -> list[TransmissionResult]:
        mode = _seqino_ereporting_mode(self.credentials)
        if mode not in {"seqino_v1", "payments_only", "full"}:
            logger.warning("Seqino e-reporting mode unsupported, fallback to payments_only (mode=%s)", mode)
            mode = "payments_only"
        tenant_id = tenant_id_from_credentials(self.credentials)
        tenant_siren = (
            _resolve_tenant_siren(tenant_id)
            if mode in {"seqino_v1", "payments_only", "full"}
            else None
        )
        if isinstance(report, list):
            events = report
            results: list[TransmissionResult | None] = [None] * len(events)
            if mode == "seqino_v1":
                async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
                    for idx, event in enumerate(events):
                        metadata = event.metadata if event.metadata else {"event_id": getattr(event, "event_id", None)}
                        path, payload, missing = _seqino_v1_payload(
                            event_type=event.event_type,
                            amounts=event.amounts,
                            payment_date=event.payment_date,
                            country=event.country,
                            client_country=event.client_country,
                            metadata=metadata,
                            tenant_siren=tenant_siren,
                        )
                        if missing:
                            results[idx] = _seqino_incomplete_result(
                                metadata,
                                event_type=event.event_type,
                                missing=missing,
                            )
                            continue
                        if not path:
                            results[idx] = _seqino_incomplete_result(
                                metadata,
                                event_type=event.event_type,
                                missing=["event_type"],
                            )
                            continue
                        url = self._endpoint(path)
                        resp = await seqino_request_checked(
                            client,
                            "POST",
                            url,
                            json=payload,
                            headers=self._headers(),
                            tenant_id=tenant_id,
                            provider=self.slug,
                            raise_for_status=False,
                        )
                        status_code = resp.status_code
                        if 400 <= status_code < 500 and status_code not in {401, 403}:
                            _log_seqino_ereporting_4xx(
                                path=path,
                                status_code=status_code,
                                count=1,
                                event_type=event.event_type,
                            )
                            results[idx] = _seqino_http_4xx_result(metadata)
                            continue
                        seqino_raise_for_status(resp)
                        try:
                            data = resp.json()
                        except Exception:
                            data = None
                        item = None
                        result_items = _result_items(data)
                        if result_items:
                            item = result_items[0]
                        elif isinstance(data, dict):
                            item = data
                        results[idx] = _result_from_item(item, metadata)
                return [result or TransmissionResult(external_id=None, status="submitted") for result in results]

            event_items: list[dict[str, Any]] = []
            for event in events:
                metadata = event.metadata if event.metadata else {"event_id": getattr(event, "event_id", None)}
                event_items.append(
                    {
                        "event_type": event.event_type,
                        "amounts": event.amounts,
                        "payment_date": event.payment_date,
                        "country": event.country,
                        "client_country": event.client_country,
                        "metadata": metadata,
                        "correlation_id": None,
                    }
                )
            requests = _prepare_seqino_requests(
                mode=mode,
                items=event_items,
                tenant_siren=tenant_siren,
                results=results,
            )
            async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
                for request in requests:
                    url = self._endpoint(request["path"])
                    resp = await seqino_request_checked(
                        client,
                        "POST",
                        url,
                        json=request["payload"],
                        headers=self._headers(),
                        tenant_id=tenant_id,
                        provider=self.slug,
                        raise_for_status=False,
                    )
                    status_code = resp.status_code
                    if 400 <= status_code < 500 and status_code not in {401, 403}:
                        indices = request.get("indices") or []
                        event_type = None
                        if indices:
                            item = event_items[indices[0]]
                            event_type = item.get("event_type")
                        _log_seqino_ereporting_4xx(
                            path=request["path"],
                            status_code=status_code,
                            count=len(indices),
                            event_type=event_type,
                        )
                        for idx in indices:
                            results[idx] = _seqino_http_4xx_result(event_items[idx].get("metadata"))
                        continue
                    seqino_raise_for_status(resp)
                    try:
                        data = resp.json()
                    except Exception:
                        data = None
                    item = None
                    items_data = _result_items(data)
                    if items_data:
                        item = items_data[0]
                    elif isinstance(data, dict):
                        item = data
                    for idx in request["indices"]:
                        results[idx] = _result_from_item(item, event_items[idx].get("metadata"))
            return [result or TransmissionResult(external_id=None, status="submitted") for result in results]

        report_payload = report
        lines = list(report_payload.lines or [])
        line_results: list[TransmissionResult | None] = [None] * len(lines)

        if mode == "seqino_v1":
            async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
                for idx, line in enumerate(lines):
                    metadata = line.metadata if line.metadata else {"line_id": line.line_id}
                    path, payload, missing = _seqino_v1_payload(
                        event_type=line.event_type,
                        amounts=line.amounts,
                        payment_date=line.payment_date,
                        country=line.country,
                        client_country=line.client_country,
                        metadata=metadata,
                        tenant_siren=tenant_siren,
                    )
                    if missing:
                        line_results[idx] = _seqino_incomplete_result(
                            metadata,
                            event_type=line.event_type,
                            missing=missing,
                        )
                        continue
                    if not path:
                        line_results[idx] = _seqino_incomplete_result(
                            metadata,
                            event_type=line.event_type,
                            missing=["event_type"],
                        )
                        continue
                    url = self._endpoint(path)
                    resp = await seqino_request_checked(
                        client,
                        "POST",
                        url,
                        json=payload,
                        headers=self._headers(),
                        tenant_id=tenant_id,
                        provider=self.slug,
                        raise_for_status=False,
                    )
                    status_code = resp.status_code
                    if 400 <= status_code < 500 and status_code not in {401, 403}:
                        _log_seqino_ereporting_4xx(
                            path=path,
                            status_code=status_code,
                            count=1,
                            event_type=line.event_type,
                        )
                        line_results[idx] = _seqino_http_4xx_result(metadata)
                        continue
                    seqino_raise_for_status(resp)
                    try:
                        data = resp.json()
                    except Exception:
                        data = None
                    item = None
                    items_data = _result_items(data)
                    if items_data:
                        item = items_data[0]
                    elif isinstance(data, dict):
                        item = data
                    line_results[idx] = _result_from_item(item, metadata)
            return [result or TransmissionResult(external_id=None, status="submitted") for result in line_results]

        line_items: list[dict[str, Any]] = []
        for line in lines:
            metadata = line.metadata if line.metadata else {"line_id": line.line_id}
            line_items.append(
                {
                    "event_type": line.event_type,
                    "amounts": line.amounts,
                    "payment_date": line.payment_date,
                    "country": line.country,
                    "client_country": line.client_country,
                    "metadata": metadata,
                    "correlation_id": report_payload.report_id or line.line_id,
                }
            )
        requests = _prepare_seqino_requests(
            mode=mode,
            items=line_items,
            tenant_siren=tenant_siren,
            results=line_results,
        )
        async with httpx.AsyncClient(timeout=_HTTPX_TIMEOUT, follow_redirects=False) as client:
            for request in requests:
                url = self._endpoint(request["path"])
                resp = await seqino_request_checked(
                    client,
                    "POST",
                    url,
                    json=request["payload"],
                    headers=self._headers(),
                    tenant_id=tenant_id,
                    provider=self.slug,
                    raise_for_status=False,
                )
                status_code = resp.status_code
                if 400 <= status_code < 500 and status_code not in {401, 403}:
                    indices = request.get("indices") or []
                    event_type = None
                    if indices:
                        item = line_items[indices[0]]
                        event_type = item.get("event_type")
                    _log_seqino_ereporting_4xx(
                        path=request["path"],
                        status_code=status_code,
                        count=len(indices),
                        event_type=event_type,
                    )
                    for idx in indices:
                        line_results[idx] = _seqino_http_4xx_result(line_items[idx].get("metadata"))
                    continue
                seqino_raise_for_status(resp)
                try:
                    data = resp.json()
                except Exception:
                    data = None
                item = None
                items_data = _result_items(data)
                if items_data:
                    item = items_data[0]
                elif isinstance(data, dict):
                    item = data
                for idx in request["indices"]:
                    line_results[idx] = _result_from_item(item, line_items[idx].get("metadata"))

        return [result or TransmissionResult(external_id=None, status="submitted") for result in line_results]
