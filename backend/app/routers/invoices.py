import calendar
import csv
import hashlib
import io
import json
import logging
import re
import secrets
import shutil
import uuid
import zipfile
from pathlib import Path
from tempfile import NamedTemporaryFile
from time import time

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from fastapi import APIRouter, Body, Depends, HTTPException, Response, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from redis import Redis
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, aliased
from sqlalchemy.orm.attributes import set_committed_value
from urllib.parse import urlencode, urlparse, parse_qs, urlunparse

from .. import metrics
from ..config import settings
from ..db import get_db
from ..deps import (
    require_active_subscription,
    require_viewer_or_admin,
    require_accountant_or_admin,
    require_accountant_or_admin_or_api_key,
    require_product_feature,
    AuthUser,
    require_viewer_or_admin_or_api_key,
    require_paid_subscription,
    require_paid_subscription_or_api_key,
    require_paid_subscription_or_trial,
    ensure_legal_acceptance,
    _maybe_expire_trial,
    API_SCOPE_READ_INVOICES,
    API_SCOPE_WRITE_INVOICES,
)
from ..services.product_capabilities import ensure_product_feature, is_product_feature_enabled
from ..services.connected_mode import ensure_connected_mode_operational, is_connected_mode_operational
from ..services.invoice_public_artifacts import has_stored_facturx_artifact
from ..services.seqino_periodicity_payload import is_vat_franchise_regime
from ..services.seqino_mandates import seqino_has_active_mandate_for_tenant_issuer
from ..models import (
    Invoice,
    InvoiceArtifact,
    InvoiceDepositApplication,
    InvoiceLine,
    Customer,
    Quote,
    Numbering,
    Submission,
    Tenant,
    TenantSettings,
    Payment,
    CreditNoteRefund,
    ActionLog,
    PdpConnection,
    EInvoicingTransmission,
    EInvoicingActionOutbox,
    EInvoiceTransmission,
    TransmissionEvent,
    EmailEvent,
)

from ..schemas import (
    AccountingLinesUpdate,
    ComplianceReportArchiveItem,
    InvoiceCreate,
    InvoiceLineIn,
    InvoiceUpdate,
    InvoiceOut,
    InvoiceListOut,
    InvoiceDetailOut,
    PaymentCreate,
    PaymentOut,
    CreditNoteCreateFromInvoice,
    CreditNoteRefundCreate,
    CreditNoteRefundOut,
    PdpSubmitRequest,
    PdpStatusResponse,
    InvoiceShareOut,
    InvoiceFollowupRequest,
)
from ..services.action_logs import log_action, safe_log_action
from ..services.invoices.amounts import invoice_balance_due_amount
from ..services.pdf import invoice_html, invoice_pdf
from ..services.storage import delete_object
from ..services.ubl import ubl_document_xml
from ..services.cii import cii_invoice_xml, normalize_facturx_profile, resolve_facturx_profile
from ..services.facturx import (
    facturx_pdf_with_meta,  # noqa: F401 - re-exported for invoice export/bundle services
    facturx_from_pdf_xml_with_meta,
    validate_facturx_xml_issues,
    FacturxXsdValidationError,
    FacturxSchematronValidationError,
    FacturxEmbedError,
    FacturxPdfa3Error,
    _run_verapdf,
    public_verapdf_result,
    sanitize_public_pdfa_report,
)
from ..services.compliance_report import (
    COMPLIANCE_REPORT_JSON_KIND,
    COMPLIANCE_REPORT_PDF_KIND,
    build_compliance_report,
    render_compliance_report_pdf,
    store_compliance_report_json,
    store_compliance_report_pdf,
)
from ..services.logo_storage import get_logo_url
from ..services.pdp import get_provider
from ..services.pdp.service import (
    execute_idempotent_provider_action,
    resolve_provider as _resolve_provider,
    select_connection_for_customer as _select_connection_for_customer,
    submit_einvoice,
)
from ..services.pdp.utils import PdpProviderError
from ..services.einvoicing.lifecycle import BLOCKING_STATUSES
from ..services.usage import UsageQuotaExceeded
from ..services.email import assert_smtp_ready_or_raise, render_email_template
from ..services.email_reply_to import clean_document_reply_email, resolve_document_reply_to
from ..services.recipients import join_emails, parse_emails, resolve_customer_recipients
from ..services.document_email import build_document_email_context, normalize_document_email_body_text
from ..services.sales_email_assist import build_invoice_email_draft
from ..services.trial_document_email import ensure_document_email_delivery_allowed
from ..services.document_pdf_context import (
    attach_discount_display_metadata,
    classify_negative_adjustment_line,
    global_discount_vat_breakdown_error,
)
from ..services.document_notes import visible_document_note
from ..services.branding_settings import get_branding_settings
from ..services.public_links import (
    invoice_public_link_days_left,
    invoice_public_link_expires_at,
    invoice_public_link_notice,
    invoice_public_link_ttl_days,
    is_invoice_public_link_expired,
)
from ..services.storage import (
    invoice_artifact_key,
    put_object,
    get_object_bytes,
    get_object_stream,
    head_object,
    parse_range_header,
    storage_integrity_info,
)
from ..services.invoices import query as invoice_query_service
from ..services.invoices import issue as invoice_issue_service
from ..services.invoices import export as invoice_export_service
from ..services.invoices.followup_decision import (
    invoice_followup_decision,
    invoice_followup_error_message,
)
from ..services.invoices.deposits import (
    deposit_application_entry as net_deposit_application_entry,
    deposit_invoice_net_amounts,
    final_invoice_deposit_entries,
    invoice_effective_template_options,
)
from ..services.accounting_exports import (
    accounting_period_lock_payload,
    find_delivered_accounting_period_lock,
    record_accounting_export,
)
from ..services.accounting_readiness import invoice_accounting_readiness
from ..services.sales_document_defaults import (
    apply_template_option_defaults,
    due_days_from_terms,
    line_accounting_account,
    sales_payment_terms,
)
from ..services.sales_document_readiness import invoice_readiness
from ..jobs.email_jobs import enqueue_invoice_email, record_invoice_email_log_only
from ..utils.audit import redact_audit_payload
from ..utils.pii import mask_email
from ..utils.public_errors import sanitize_public_error_message
from ..utils.public_provider_messages import sanitize_public_provider_message
from ..utils.money import (
    MAX_DOCUMENT_AMOUNT,
    calc_line_total,
    calc_tax_amount,
    ensure_max_abs,
    quantize_amount,
    to_decimal,
)
from ..utils.seqino_http import SeqinoHttpError, seqino_http_status
from ..validators.invoice_sanity_checks import validate_invoice_ctx
from ..validators.invoice_required_fields import (
    validate_invoice_required_fields as _validate_invoice_required_fields,
)
from ..validators.fr_einvoicing import (
    fr_einvoicing_error,
    validate_fr_b2b_invoice_ready as _validate_fr_b2b_invoice_ready,
)
from ..en16931.ubl_validator import (
    validate_ubl_ctx,
    validate_ubl_xml as _validate_ubl_xml,
)
from ..compliance.fr_2026 import validate_fr_einvoicing_fields
from ..compliance.fr_data_dictionary import (
    validate_fr_invoice_minimum_2026 as _validate_fr_invoice_minimum_2026,
    validate_fr_invoice_minimum_2027 as _validate_fr_invoice_minimum_2027,
)
from ..compliance.normative_validator import (
    validate_xml_with_schematron,
    validate_xml_with_xsd,
)
from ..services.pdp.service import is_fr_b2b as _is_fr_b2b


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _issue_date_datetime(value: date | datetime | None) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    return _utcnow()


def _query_date_bounds(start: date | None, end: date | None) -> tuple[datetime | None, datetime | None]:
    if start and end and end < start:
        raise HTTPException(status_code=400, detail="La date de fin doit être après la date de début.")
    start_dt = datetime.combine(start, datetime.min.time()) if start else None
    end_dt = datetime.combine(end + timedelta(days=1), datetime.min.time()) if end else None
    return start_dt, end_dt


router = APIRouter(prefix="/api/invoices", tags=["invoices"])
MAX_SYNC_EXPORT_ROWS = 5000

SIRET_RE = re.compile(r"^\d{14}$")
SIREN_RE = re.compile(r"^\d{9}$")
IMMUTABLE_STATUSES = {"issued", "sent", "paid", "overdue", "partial"}
PDP_SENT_STATUSES = {"submitted", "processing", "accepted", "available", "paid"}
PDP_FAILED_STATUSES = {"failed", "rejected", "refused", "blocked", "cancelled", "canceled", "invalid", "error"}
CSV_INJECTION_PREFIXES = ("=", "+", "-", "@")


def _sanitize_csv_cell(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    if not text:
        return ""
    # Spreadsheet apps can evaluate formulas even after leading whitespace/BOM.
    first_meaningful = text.lstrip(" \t\r\n\ufeff")
    if first_meaningful and first_meaningful[0] in CSV_INJECTION_PREFIXES:
        return "'" + text
    return text


def _export_attachment_headers(filename: str) -> dict[str, str]:
    return {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
    }


def _ordered_invoice_line_id(invoice_id: str, index: int) -> str:
    return f"{invoice_id}-{index:04d}-{uuid.uuid4().hex[:8]}"


INVOICE_ARTIFACT_KIND_ALIASES = {
    "pdf": "PDF",
    "facturx": "FACTURX",
    "ubl": "UBL",
    "cii": "CII",
    "xml": "CII",
}
INVOICE_ARTIFACT_CONTENT_TYPES = {
    "PDF": "application/pdf",
    "FACTURX": "application/pdf",
    "UBL": "application/xml",
    "CII": "application/xml",
}
DEFAULT_INVOICE_TEMPLATE_KEY = "classic"
DEFAULT_INVOICE_TEMPLATE_OPTIONS = {
    "show_delivery_address": True,
    "show_purchase_order_number": True,
    "show_note": True,
    "show_supplier_email": True,
    "show_supplier_phone": True,
    "document_title": "",
    "document_language": "fr",
    "document_tags": [],
    "custom_fields": [],
    "payment_methods": ["bank_transfer", "cheque", "card"],
    "payment_bank_account": None,
    "legal_terms_default": True,
    "legal_mentions_text": "",
    "legal_footer_text": "",
    "legal_penalty_prefix": "",
    "legal_recovery_prefix": "",
    "legal_discount_text": "",
    "legal_penalty_rate": "10",
    "legal_recovery_fee": "40",
    "line_columns": {
        "lineNumber": False,
        "reference": False,
        "quantity": True,
        "unit": False,
        "unitPrice": True,
        "vat": True,
        "discount": False,
        "baseTotal": True,
        "discountedTotal": False,
    },
    "document_discount_input_mode": "percent",
    "document_discount_amount_ht": "",
    "global_vat_enabled": False,
    "global_vat_draft": {
        "vat_rate": "20",
        "vat_category": "S",
        "exemption_reason_code": "",
        "unit_code": "C62",
    },
    "advance_payments": [],
    "requested_advance": None,
}


def _provider_error_status(exc: PdpProviderError) -> int:
    if isinstance(exc, SeqinoHttpError):
        return exc.status_code
    if (exc.code or "").strip().lower() == "artifact_integrity_error":
        return 409
    return seqino_http_status(exc.code)


def _resolve_template_key(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    return normalized or DEFAULT_INVOICE_TEMPLATE_KEY


def _merge_template_options(base: dict | None, overrides: dict | None) -> dict:
    merged = dict(base or {})
    if isinstance(overrides, dict):
        for key, default_value in DEFAULT_INVOICE_TEMPLATE_OPTIONS.items():
            if key not in overrides:
                continue
            raw = overrides[key]
            if isinstance(default_value, bool):
                merged[key] = bool(raw)
            elif isinstance(default_value, dict):
                if isinstance(raw, dict):
                    nested = dict(default_value)
                    for nested_key, nested_default in default_value.items():
                        if nested_key in raw:
                            nested[nested_key] = (
                                bool(raw[nested_key]) if isinstance(nested_default, bool) else raw[nested_key]
                            )
                    merged[key] = nested
                else:
                    merged[key] = dict(default_value)
            elif isinstance(default_value, list):
                merged[key] = raw if isinstance(raw, list) else list(default_value)
            elif isinstance(default_value, str):
                merged[key] = str(raw or default_value)
            elif default_value is None:
                merged[key] = raw if isinstance(raw, dict) or raw is None else default_value
    return merged


def _issuer_payment_bank_account(template_options: dict | None) -> dict | None:
    account = template_options.get("payment_bank_account") if isinstance(template_options, dict) else None
    if not isinstance(account, dict):
        return None
    account_id = str(account.get("id") or "").strip()
    label = str(account.get("label") or "").strip().lower()
    if account_id.startswith("customer:") or label == "rib client":
        return None
    return account


def _decimal_from_any(value: object) -> Decimal:
    return quantize_amount(value or 0)


def _line_total_from_ctx_line(line: dict[str, object]) -> Decimal:
    raw_total = line.get("line_total")
    if raw_total is not None:
        return _decimal_from_any(raw_total)
    return calc_line_total(line.get("quantity", 0), line.get("unit_price", 0))


def _is_negative_item_adjustment(line: dict[str, object]) -> bool:
    if str(line.get("line_type") or "item").strip().lower() != "item":
        return False
    return _decimal_from_any(line.get("unit_price", 0)) < 0


def _is_advance_payment_label(value: object) -> bool:
    return bool(re.match(r"^\s*acompt[eé]\b", str(value or ""), flags=re.IGNORECASE))


def _json_amount(value: object) -> float:
    return float(quantize_amount(value or 0))


def _normalize_advance_payments(options: dict | None) -> list[dict[str, object]]:
    raw = options.get("advance_payments") if isinstance(options, dict) else None
    if not isinstance(raw, list):
        return []
    payments: list[dict[str, object]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        amount_ht = _decimal_from_any(entry.get("amount_ht"))
        amount_vat = _decimal_from_any(entry.get("amount_vat"))
        amount_ttc = _decimal_from_any(entry.get("amount_ttc"))
        vat_rate = _decimal_from_any(entry.get("vat_rate"))
        if amount_ttc <= 0 and amount_ht <= 0:
            continue
        if amount_ttc <= 0:
            amount_ttc = quantize_amount(amount_ht + amount_vat)
        payment = {
            "reference": str(entry.get("reference") or "").strip(),
            "label": str(entry.get("label") or "Acompte").strip(),
            "source": str(entry.get("source") or "advance_payment").strip(),
            "amount_ht": _json_amount(amount_ht),
            "amount_vat": _json_amount(amount_vat),
            "amount_ttc": _json_amount(amount_ttc),
            "vat_rate": _json_amount(vat_rate),
        }
        percent = _decimal_from_any(entry.get("percent"))
        if Decimal("0") < percent <= Decimal("100"):
            payment["percent"] = _json_amount(percent)
        invoice_id = str(entry.get("invoice_id") or "").strip()[:80]
        invoice_number = str(entry.get("invoice_number") or entry.get("number") or payment["reference"] or "").strip()[
            :80
        ]
        issue_date = str(entry.get("issue_date") or entry.get("date") or "").strip()[:40]
        quote_id = str(entry.get("quote_id") or "").strip()[:80]
        if invoice_id:
            payment["invoice_id"] = invoice_id
        if invoice_number:
            payment["invoice_number"] = invoice_number
        if issue_date:
            payment["issue_date"] = issue_date
        if quote_id:
            payment["quote_id"] = quote_id
        payments.append(payment)
    return payments


def _advance_payments_total_ttc(options: dict | None) -> Decimal:
    return quantize_amount(
        sum(
            (
                _decimal_from_any(entry.get("amount_ttc"))
                for entry in _normalize_advance_payments(options)
                if str(entry.get("source") or "").strip() != "requested_advance"
            ),
            Decimal("0"),
        )
    )


def _advance_payment_entry_from_legacy_line(line: InvoiceLineIn, line_total: Decimal, line_tax: Decimal) -> dict:
    label = str(getattr(line, "product_name", None) or "Acompte déjà facturé").strip()
    reference = ""
    ref_match = re.search(r"[-–—]\s*(.+)$", label)
    if ref_match:
        reference = ref_match.group(1).strip()
    amount_ht = quantize_amount(abs(line_total))
    amount_vat = quantize_amount(abs(line_tax))
    amount_ttc = quantize_amount(amount_ht + amount_vat)
    return {
        "reference": reference[:80],
        "label": label[:120],
        "source": "legacy_negative_line",
        "amount_ht": float(amount_ht),
        "amount_vat": float(amount_vat),
        "amount_ttc": float(amount_ttc),
        "vat_rate": float(quantize_amount(getattr(line, "vat_rate", 0) or 0)),
    }


def _merge_advance_payment_entries(template_options: dict | None, entries: list[dict]) -> dict:
    merged = dict(template_options or {})
    current = merged.get("advance_payments")
    if not isinstance(current, list):
        current = []
    if entries:
        current = [
            entry
            for entry in current
            if not (isinstance(entry, dict) and entry.get("source") == "legacy_negative_line")
        ]
        merged["advance_payments"] = [*current, *entries]
    return merged


def _validate_advance_payments_do_not_exceed_total(template_options: dict | None, total_inc_vat: Decimal) -> None:
    prepaid = _advance_payments_total_ttc(template_options)
    total = quantize_amount(total_inc_vat)
    if prepaid > max(total, Decimal("0.00")) + Decimal("0.01"):
        raise HTTPException(400, "Le montant des acomptes ne peut pas dépasser le total TTC du document.")


def _validate_global_discount_vat_breakdown(lines: list[InvoiceLineIn]) -> None:
    error = global_discount_vat_breakdown_error(lines)
    if error:
        raise HTTPException(
            400,
            {
                "code": "multi_vat_discount_requires_breakdown",
                "message": error,
            },
        )


def _validate_sales_amount(label: str, value) -> None:
    try:
        ensure_max_abs(value, MAX_DOCUMENT_AMOUNT, label)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "amount_too_large",
                "message": sanitize_public_error_message(
                    exc,
                    status_code=422,
                    fallback=f"{label} dépasse la limite autorisée.",
                ),
            },
        )


def _invoice_kind_from_payload(payload: InvoiceCreate | InvoiceUpdate, template_options: dict | None = None) -> str:
    raw = getattr(payload, "invoice_kind", None)
    if not raw and isinstance(template_options, dict):
        raw = template_options.get("kind") or template_options.get("invoice_kind")
    value = str(raw or "standard").strip().lower()
    if value in {"advance", "acompte"}:
        value = "deposit"
    if value not in {"standard", "deposit", "final"}:
        raise HTTPException(400, "Type métier de facture invalide.")
    return value


def _quote_id_from_payload(
    payload: InvoiceCreate | InvoiceUpdate,
    template_options: dict | None = None,
    existing_quote_id: str | None = None,
) -> str | None:
    raw = getattr(payload, "quote_id", None)
    if raw is None and isinstance(template_options, dict):
        raw = template_options.get("source_quote_id") or template_options.get("quote_id")
    if raw is None:
        raw = existing_quote_id
    value = str(raw or "").strip()
    return value or None


def _validate_quote_link(
    db: Session,
    tenant_id: str,
    quote_id: str | None,
    customer_id: str,
    invoice_kind: str,
    *,
    current_invoice_id: str | None = None,
) -> Quote | None:
    if not quote_id:
        if invoice_kind in {"deposit", "final"}:
            raise HTTPException(400, "Une facture d'acompte ou finale doit être liée à un devis.")
        return None
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != tenant_id:
        raise HTTPException(404, "Devis source introuvable.")
    if quote.customer_id != customer_id:
        raise HTTPException(400, "Le devis source ne correspond pas au client de la facture.")
    linked_to_current_invoice = bool(current_invoice_id and getattr(quote, "invoice_id", None) == current_invoice_id)
    if quote.status != "accepted" and not (linked_to_current_invoice and quote.status == "invoiced"):
        raise HTTPException(
            400,
            detail={
                "code": "quote_not_accepted",
                "message": "Le devis source doit être accepté avant de créer une facture liée.",
            },
        )
    if not linked_to_current_invoice and quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(400, detail={"code": "quote_expired", "message": "Devis expiré : impossible de facturer."})
    if invoice_kind != "deposit":
        existing = db.query(Invoice.id).filter(
            Invoice.tenant_id == tenant_id,
            Invoice.quote_id == quote.id,
            Invoice.type == "invoice",
            Invoice.status != "canceled",
            or_(Invoice.invoice_kind.is_(None), Invoice.invoice_kind != "deposit"),
        )
        if current_invoice_id:
            existing = existing.filter(Invoice.id != current_invoice_id)
        if existing.first():
            raise HTTPException(
                409,
                detail={
                    "code": "quote_already_invoiced",
                    "message": "Une facture existe déjà pour ce devis.",
                },
            )
    return quote


def _deposit_vat_rate(inv: Invoice) -> Decimal | None:
    ht = quantize_amount(inv.total_ex_vat or 0)
    vat = quantize_amount(inv.total_vat or 0)
    if ht == 0:
        return None
    return quantize_amount((vat / ht) * Decimal("100"))


def _deposit_application_entry(app: InvoiceDepositApplication) -> dict[str, object]:
    number = str(app.deposit_number or "").strip()
    issue_date = app.deposit_issue_date.date().isoformat() if app.deposit_issue_date else ""
    return {
        "reference": number,
        "label": f"Acompte facture {number}" if number else "Acompte facture",
        "source": "deposit_invoice",
        "invoice_id": app.deposit_invoice_id,
        "invoice_number": number,
        "issue_date": issue_date,
        "quote_id": app.quote_id,
        "amount_ht": _json_amount(app.amount_ht),
        "amount_vat": _json_amount(app.amount_vat),
        "amount_ttc": _json_amount(app.amount_ttc),
        "vat_rate": _json_amount(app.vat_rate),
    }


def _invoice_deposit_entries(db: Session, inv: Invoice) -> list[dict[str, object]]:
    return final_invoice_deposit_entries(db, inv)


def _auto_deposit_invoice_ids_for_final(db: Session, inv: Invoice) -> list[str]:
    if not inv.quote_id:
        return []
    final_invoice = aliased(Invoice)
    used = (
        db.query(InvoiceDepositApplication.deposit_invoice_id)
        .join(final_invoice, final_invoice.id == InvoiceDepositApplication.final_invoice_id)
        .filter(
            InvoiceDepositApplication.tenant_id == inv.tenant_id,
            final_invoice.status.notin_(["canceled", "cancelled"]),
        )
    )
    deposits = (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == inv.tenant_id,
            Invoice.quote_id == inv.quote_id,
            Invoice.customer_id == inv.customer_id,
            Invoice.type == "invoice",
            Invoice.invoice_kind == "deposit",
            Invoice.id != inv.id,
            Invoice.status.notin_(["draft", "canceled", "cancelled"]),
            Invoice.id.notin_(used),
        )
        .order_by(Invoice.issue_date.asc(), Invoice.created_at.asc())
        .all()
    )
    return [
        deposit.id
        for deposit in deposits
        if quantize_amount(deposit_invoice_net_amounts(db, deposit)["net_ttc"]) > Decimal("0.01")
    ]


def _manual_advance_entries(template_options: dict | None) -> list[dict[str, object]]:
    entries = []
    for entry in _normalize_advance_payments(template_options):
        source = str(entry.get("source") or "").strip()
        if source == "deposit_invoice":
            continue
        entries.append(entry)
    return entries


def _sync_deposit_applications(
    db: Session,
    inv: Invoice,
    *,
    deposit_invoice_ids: list[str] | None,
    actor: AuthUser | None,
) -> None:
    if inv.invoice_kind != "final" or inv.type == "credit_note":
        db.query(InvoiceDepositApplication).filter(
            InvoiceDepositApplication.tenant_id == inv.tenant_id,
            InvoiceDepositApplication.final_invoice_id == inv.id,
        ).delete(synchronize_session=False)
        options = dict(inv.template_options or {})
        manual_entries = _manual_advance_entries(options)
        if manual_entries:
            options["advance_payments"] = manual_entries
        else:
            options.pop("advance_payments", None)
        if inv.invoice_kind != "final":
            options["kind"] = inv.invoice_kind or "standard"
        inv.template_options = options
        return
    if not inv.quote_id:
        raise HTTPException(400, "Une facture finale doit être liée à un devis.")

    if deposit_invoice_ids is None:
        current_ids = [
            row[0]
            for row in db.query(InvoiceDepositApplication.deposit_invoice_id)
            .filter(
                InvoiceDepositApplication.tenant_id == inv.tenant_id,
                InvoiceDepositApplication.final_invoice_id == inv.id,
            )
            .order_by(InvoiceDepositApplication.created_at.asc(), InvoiceDepositApplication.id.asc())
            .all()
        ]
        ids = current_ids or _auto_deposit_invoice_ids_for_final(db, inv)
    else:
        ids = list(deposit_invoice_ids)
    ids = list(dict.fromkeys([str(item).strip() for item in ids if str(item or "").strip()]))

    entries: list[dict[str, object]] = []
    total_ttc = Decimal("0")
    apps: list[InvoiceDepositApplication] = []
    for deposit_id in ids:
        deposit = db.get(Invoice, deposit_id)
        if not deposit or deposit.tenant_id != inv.tenant_id:
            raise HTTPException(400, "Facture d'acompte introuvable.")
        if deposit.id == inv.id:
            raise HTTPException(400, "Une facture finale ne peut pas déduire elle-même son acompte.")
        if deposit.type != "invoice" or deposit.invoice_kind != "deposit":
            raise HTTPException(400, "Le document sélectionné n'est pas une facture d'acompte.")
        if deposit.quote_id != inv.quote_id:
            raise HTTPException(400, "La facture d'acompte n'est pas liée au même devis.")
        if deposit.customer_id != inv.customer_id:
            raise HTTPException(400, "La facture d'acompte n'est pas liée au même client.")
        if deposit.currency != inv.currency:
            raise HTTPException(400, "La facture d'acompte n'utilise pas la même devise.")
        if deposit.status in {"draft", "canceled", "cancelled"}:
            raise HTTPException(400, "La facture d'acompte doit être émise avant d'être déduite.")
        if deposit.issue_date and inv.issue_date and deposit.issue_date > inv.issue_date:
            raise HTTPException(
                400,
                "La facture d'acompte doit être émise avant ou le même jour que la facture finale.",
            )
        amounts = deposit_invoice_net_amounts(db, deposit)
        if quantize_amount(amounts["net_ttc"]) <= Decimal("0.01"):
            continue
        final_invoice = aliased(Invoice)
        existing = (
            db.query(InvoiceDepositApplication)
            .join(final_invoice, final_invoice.id == InvoiceDepositApplication.final_invoice_id)
            .filter(
                InvoiceDepositApplication.tenant_id == inv.tenant_id,
                InvoiceDepositApplication.deposit_invoice_id == deposit.id,
                InvoiceDepositApplication.final_invoice_id != inv.id,
                final_invoice.status.notin_(["canceled", "cancelled"]),
            )
            .first()
        )
        if existing:
            raise HTTPException(400, "Cette facture d'acompte est déjà déduite sur une facture finale.")
        app = InvoiceDepositApplication(
            id=str(uuid.uuid4()),
            tenant_id=inv.tenant_id,
            quote_id=inv.quote_id,
            final_invoice_id=inv.id,
            deposit_invoice_id=deposit.id,
            amount_ht=quantize_amount(amounts["net_ht"]),
            amount_vat=quantize_amount(amounts["net_vat"]),
            amount_ttc=quantize_amount(amounts["net_ttc"]),
            vat_rate=quantize_amount(amounts["vat_rate"]) if amounts["vat_rate"] is not None else None,
            deposit_number=deposit.number,
            deposit_issue_date=deposit.issue_date,
            created_at=_utcnow(),
            created_by=_mutable_actor_id(actor),
        )
        total_ttc += quantize_amount(app.amount_ttc or 0)
        apps.append(app)
        entry = net_deposit_application_entry(db, app)
        if entry is None:
            entry = _deposit_application_entry(app)
        entries.append(entry)

    if total_ttc > max(quantize_amount(inv.total_inc_vat or 0), Decimal("0.00")) + Decimal("0.01"):
        raise HTTPException(400, "Le total des acomptes déduits dépasse le total TTC de la facture finale.")
    quote = db.get(Quote, inv.quote_id)
    if quote:
        quote_total = quantize_amount(quote.total_inc_vat or 0)
        final_total = quantize_amount(inv.total_inc_vat or 0)
        expected_balance = quantize_amount(quote_total - total_ttc)
        if total_ttc > Decimal("0.00") and abs(final_total - expected_balance) <= Decimal("0.01"):
            raise HTTPException(
                400,
                "La facture finale semble déjà saisie au solde après acompte. "
                "Saisissez le total complet du devis : PixFacture déduira ensuite l'acompte automatiquement.",
            )

    db.query(InvoiceDepositApplication).filter(
        InvoiceDepositApplication.tenant_id == inv.tenant_id,
        InvoiceDepositApplication.final_invoice_id == inv.id,
    ).delete(synchronize_session=False)
    for app in apps:
        db.add(app)

    manual_entries = _manual_advance_entries(inv.template_options)
    options = dict(inv.template_options or {})
    options["advance_payments"] = [*manual_entries, *entries]
    options["kind"] = "final"
    options["source_quote_id"] = inv.quote_id
    inv.template_options = options


def _validate_deposit_invoice_total(db: Session, inv: Invoice, quote: Quote | None) -> None:
    if inv.invoice_kind != "deposit" or not quote:
        return
    quote_total = quantize_amount(quote.total_inc_vat or 0)
    current = quantize_amount(inv.total_inc_vat or 0)
    other_deposits = (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == inv.tenant_id,
            Invoice.quote_id == quote.id,
            Invoice.invoice_kind == "deposit",
            Invoice.type == "invoice",
            Invoice.id != inv.id,
            Invoice.status.notin_(["canceled", "cancelled"]),
        )
        .all()
    )
    other_total = quantize_amount(
        sum((quantize_amount(deposit_invoice_net_amounts(db, row)["net_ttc"]) for row in other_deposits), Decimal("0"))
    )
    if quote_total > 0 and other_total + current > quote_total + Decimal("0.01"):
        raise HTTPException(400, "Le cumul des factures d'acompte dépasse le total du devis.")


# --- Portail public factures (URL partageable) ---


def _frontend_base_url() -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    return base.rstrip("/")


def _invoice_public_url(token: str) -> str:
    base = _frontend_base_url()
    path = f"/i/{token}"
    return f"{base}{path}" if base else path


def _generate_public_token() -> str:
    # ~43 chars URL-safe. Suffisant pour éviter toute énumération.
    return secrets.token_urlsafe(32)


def _ensure_invoice_public_link(db: Session, inv: Invoice) -> str:
    if inv.public_token and inv.public_enabled and not is_invoice_public_link_expired(inv):
        return inv.public_token
    needs_new_token = not inv.public_token or is_invoice_public_link_expired(inv)
    if needs_new_token:
        # Éviter les collisions (très improbable, mais on reste safe)
        assigned = False
        for _ in range(8):
            candidate = _generate_public_token()
            exists = db.query(Invoice.id).filter(Invoice.public_token == candidate).first()
            if not exists:
                inv.public_token = candidate
                assigned = True
                break
        if not assigned:
            raise HTTPException(500, "Impossible de générer un lien public")
    inv.public_enabled = True
    if needs_new_token or not inv.public_created_at:
        inv.public_created_at = _utcnow()
    db.add(inv)
    return inv.public_token


def _invoice_share_out(inv: Invoice, *, public_url: str | None = None, expired: bool | None = None) -> InvoiceShareOut:
    expires_at = invoice_public_link_expires_at(inv)
    expired_value = is_invoice_public_link_expired(inv) if expired is None else bool(expired)
    enabled = bool(inv.public_enabled and inv.public_token and not expired_value)
    visible_expires_at = expires_at if (enabled or expired_value) else None
    url = public_url if enabled else None
    if enabled and url is None and inv.public_token:
        url = _invoice_public_url(inv.public_token)
    message = invoice_public_link_notice(inv) if enabled else None
    if expired_value and expires_at:
        message = "Lien expiré. Régénérez-le pour redonner accès au client."
    return InvoiceShareOut(
        enabled=enabled,
        public_url=url,
        expires_at=visible_expires_at,
        expires_in_days=invoice_public_link_days_left(inv) if visible_expires_at else None,
        validity_days=invoice_public_link_ttl_days(),
        expired=expired_value,
        message=message,
    )


def _disable_expired_invoice_public_link(db: Session, inv: Invoice) -> bool:
    if not is_invoice_public_link_expired(inv):
        return False
    if inv.public_enabled:
        inv.public_enabled = False
        db.add(inv)
        db.commit()
    return True


def _rotate_invoice_public_link(db: Session, inv: Invoice) -> str:
    for _ in range(8):
        candidate = _generate_public_token()
        exists = db.query(Invoice.id).filter(Invoice.public_token == candidate).first()
        if not exists:
            inv.public_token = candidate
            break
    if not inv.public_token:
        raise HTTPException(500, "Impossible de générer un nouveau lien public")
    inv.public_enabled = True
    inv.public_created_at = _utcnow()
    db.add(inv)
    return inv.public_token


def _disable_invoice_public_link(db: Session, inv: Invoice) -> None:
    inv.public_enabled = False
    db.add(inv)


logger = logging.getLogger("invoices.email")
validation_logger = logging.getLogger("invoices.validation")
security_logger = logging.getLogger("security.artifact")
POSTAL_CITY_RE = re.compile(r"(?P<street>.*?)(?P<postal>\d{4,6})\s+(?P<city>.+)")
_email_rate_redis: Redis | None = None
_email_rate_fallback: dict[str, tuple[int, float]] = {}


def _is_invoice_immutable(inv: Invoice) -> bool:
    return bool(inv.issued_at) or inv.status in IMMUTABLE_STATUSES


def _default_invoice_email_attachment_format(tenant: Tenant | None) -> str:
    return "pdf"


def _invoice_link_meta(inv: Invoice, invoice_link: str | None) -> list[tuple[str, str]]:
    if not invoice_link:
        return []
    if "apercu-client" in invoice_link:
        return []
    expires_at = invoice_public_link_expires_at(inv)
    if not expires_at:
        return []
    return [("Lien valable jusqu'au", expires_at.strftime("%d/%m/%Y"))]


def _invoice_supplier_bank_meta(ctx: dict) -> list[tuple[str, str]]:
    supplier = ctx.get("supplier") if isinstance(ctx, dict) else {}
    supplier = supplier if isinstance(supplier, dict) else {}
    iban = str(supplier.get("iban") or "").strip()
    bic = str(supplier.get("bic") or "").strip()
    rows: list[tuple[str, str]] = []
    if iban:
        rows.append(("IBAN", iban))
    if bic:
        rows.append(("BIC", bic))
    return rows


def _invoice_followup_decision_or_raise(
    db: Session,
    inv: Invoice,
    *,
    tenant: Tenant | None,
    customer: Customer | None,
    explicit_to: str | None = None,
):
    decision = invoice_followup_decision(
        db,
        inv=inv,
        tenant=tenant,
        customer=customer,
        balance_due=max(_outstanding(db, inv), Decimal("0")),
        now=_utcnow(),
        due_date=_compute_due_date_no_write(inv),
        explicit_to=explicit_to,
    )
    if not decision.can_followup:
        code = decision.followup_block_reason or "invoice_followup_not_due"
        raise HTTPException(
            400,
            detail={
                "code": code,
                "message": invoice_followup_error_message(code),
            },
        )
    return decision


def _strict_compliance_enabled(tenant_settings: TenantSettings | None) -> bool:
    if getattr(settings, "INVOICE_COMPLIANCE_STRICT", False):
        return True
    if tenant_settings and isinstance(tenant_settings.features, dict):
        return bool(tenant_settings.features.get("compliance_strict") or tenant_settings.features.get("invoice_strict"))
    return False


def _get_rate_limit_redis() -> Redis | None:
    global _email_rate_redis
    if not settings.REDIS_URL:
        return None
    if _email_rate_redis:
        return _email_rate_redis
    try:
        _email_rate_redis = Redis.from_url(settings.REDIS_URL, decode_responses=False)
    except Exception:
        _email_rate_redis = None
    return _email_rate_redis


def _local_rate_increment(key: str, ttl_seconds: int) -> int:
    now = time()
    stored = _email_rate_fallback.get(key)
    if stored:
        count, expires_at = stored
        if expires_at > now:
            count += 1
            _email_rate_fallback[key] = (count, expires_at)
            return count
    _email_rate_fallback[key] = (1, now + ttl_seconds)
    return 1


def _enforce_invoice_email_rate_limit(tenant_id: str) -> None:
    if getattr(settings, "DISABLE_RATE_LIMITS", False):
        return
    hourly_limit = int(getattr(settings, "INVOICE_EMAIL_RATE_LIMIT_PER_HOUR", 30) or 0)
    generic_hourly_limit = int(getattr(settings, "MAX_EMAILS_PER_HOUR", 60) or 0)
    if hourly_limit > 0 and generic_hourly_limit > 0:
        hourly_limit = min(hourly_limit, generic_hourly_limit)
    elif generic_hourly_limit > 0:
        hourly_limit = generic_hourly_limit
    daily_limit = int(getattr(settings, "INVOICE_EMAIL_RATE_LIMIT_PER_DAY", 200) or 0)
    if hourly_limit <= 0 and daily_limit <= 0:
        return
    now = _utcnow()
    hour_key = f"rate:invoice_email:{tenant_id}:hour:{now:%Y%m%d%H}"
    day_key = f"rate:invoice_email:{tenant_id}:day:{now:%Y%m%d}"
    hour_count = 0
    day_count = 0
    r = _get_rate_limit_redis()
    if r:
        try:
            pipe = r.pipeline()
            pipe.incr(hour_key)
            pipe.expire(hour_key, 60 * 60 * 2)
            pipe.incr(day_key)
            pipe.expire(day_key, 60 * 60 * 25)
            results = pipe.execute()
            hour_count = int(results[0])
            day_count = int(results[2])
        except Exception:
            hour_count = _local_rate_increment(hour_key, 60 * 60 * 2)
            day_count = _local_rate_increment(day_key, 60 * 60 * 25)
    else:
        hour_count = _local_rate_increment(hour_key, 60 * 60 * 2)
        day_count = _local_rate_increment(day_key, 60 * 60 * 25)

    over_hour = hourly_limit > 0 and hour_count > hourly_limit
    over_day = daily_limit > 0 and day_count > daily_limit
    if over_hour or over_day:
        metrics.inc_operational_event("quota_exceeded")
        logger.warning("quota_exceeded", extra={"scope": "invoice_email", "tenant_id": tenant_id})
        limits = []
        if hourly_limit > 0:
            limits.append(f"{hourly_limit} par heure")
        if daily_limit > 0:
            limits.append(f"{daily_limit} par jour")
        limits_label = f" (max {', '.join(limits)})" if limits else ""
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"Limite d'envoi d'emails atteinte{limits_label}. Réessayez plus tard.",
            },
        )


def _require_fr_business_identifier(
    siret: str | None,
    siren: str | None,
    who: str,
    country: str | None = None,
    client_type: str | None = None,
    vat_number: str | None = None,
    warn_international: bool = True,
) -> str | None:
    cleaned_siret = (siret or "").replace(" ", "")
    cleaned_siren = (siren or "").replace(" ", "")
    normalized_country = (country or "").strip().upper()
    normalized_client_type = (client_type or "").strip().lower()
    if normalized_client_type == "individual":
        candidate = cleaned_siret or cleaned_siren
        if candidate and not (SIRET_RE.fullmatch(candidate) or SIREN_RE.fullmatch(candidate)):
            if normalized_country and normalized_country != "FR" and warn_international:
                validation_logger.warning("%s: identifiant local invalide pour le pays %s.", who, normalized_country)
            return None
        return candidate or None

    candidate = cleaned_siret or cleaned_siren
    if candidate:
        if SIRET_RE.fullmatch(candidate):
            return candidate
        if SIREN_RE.fullmatch(candidate):
            if normalized_country == "FR":
                validation_logger.warning("%s: SIREN fourni sans SIRET (SIRET recommandé).", who)
                return candidate
        if normalized_country and normalized_country != "FR":
            if warn_international:
                validation_logger.warning("%s: identifiant local invalide pour le pays %s.", who, normalized_country)
            return None
        raise HTTPException(
            status_code=400,
            detail=f"{who} doit renseigner un SIREN ou SIRET valide (9 ou 14 chiffres) pour la France.",
        )
    if normalized_country == "FR":
        raise HTTPException(
            status_code=400,
            detail=f"{who} doit renseigner un SIREN ou SIRET valide (9 ou 14 chiffres) pour la France.",
        )
    if warn_international and not (vat_number or "").strip():
        validation_logger.warning("%s: identifiant manquant pour le pays %s.", who, normalized_country or "?")
    return None


def _raise_facturx_xsd_error(exc: FacturxXsdValidationError) -> None:
    status_code = 400 if settings.FACTURX_STRICT else 422
    public_message = sanitize_public_error_message(
        exc,
        status_code=status_code,
        fallback="Le document Factur-X ne respecte pas les règles de conformité attendues.",
    )
    issues = getattr(exc, "issues", []) or []
    if not issues:
        issues = [
            {
                "code": exc.code,
                "message": public_message,
                "doc_url": "https://www.factur-x.eu/en/factur-x/",
                "source": "xsd",
                "level": "error",
            }
        ]
    raise HTTPException(
        status_code=status_code,
        detail={
            "code": exc.code,
            "message": public_message,
            "issues": issues,
            "doc_url": issues[0].get("doc_url") if issues else None,
        },
    )


def _raise_facturx_schematron_error(exc: FacturxSchematronValidationError) -> None:
    public_message = sanitize_public_error_message(
        exc,
        status_code=422,
        fallback="Le document Factur-X ne respecte pas les règles métier attendues.",
    )
    issues = getattr(exc, "issues", []) or []
    if not issues:
        issues = [
            {
                "code": exc.code,
                "message": public_message,
                "doc_url": "https://www.factur-x.eu/en/factur-x/",
                "source": "schematron",
                "level": "error",
            }
        ]
    raise HTTPException(
        status_code=422,
        detail={
            "code": exc.code,
            "message": public_message,
            "issues": issues,
            "doc_url": issues[0].get("doc_url") if issues else None,
        },
    )


def _raise_facturx_embed_error(exc: FacturxEmbedError) -> None:
    raise HTTPException(
        status_code=422,
        detail={
            "code": exc.code,
            "message": sanitize_public_error_message(
                exc,
                status_code=422,
                fallback="Impossible d’intégrer les données structurées dans le PDF de la facture.",
            ),
        },
    )


def _raise_facturx_pdfa_error(exc: FacturxPdfa3Error) -> None:
    raise HTTPException(
        status_code=422,
        detail={
            "code": exc.code,
            "message": sanitize_public_error_message(
                exc,
                status_code=422,
                fallback="Le PDF de la facture ne respecte pas le format d’archivage attendu.",
            ),
        },
    )


def _normalize_address(address: str | None, country_code: str | None) -> dict:
    normalized_country = (country_code or "").strip().upper() or None
    if not address:
        return {
            "street": None,
            "city": None,
            "postal_code": None,
            "country_code": normalized_country,
        }
    raw_lines = [line.strip() for line in re.split(r"[\r\n]+", address) if line.strip()]
    if len(raw_lines) == 1 and "," in raw_lines[0]:
        parts = [part.strip() for part in raw_lines[0].split(",") if part.strip()]
        lines = parts
    else:
        lines = raw_lines
    if lines:
        last = lines[-1].replace(" ", "")
        if len(last) in (2, 3) and last.isalpha():
            if not normalized_country:
                normalized_country = last.upper()
            lines = lines[:-1]
    street = lines[0] if lines else None
    postal_code = None
    city = None
    if lines:
        candidate = lines[-1]
        match = POSTAL_CITY_RE.match(candidate)
        if match:
            postal_code = match.group("postal")
            city = match.group("city").strip()
            street_part = match.group("street").strip(" ,")
            if street_part and (not street or street == candidate):
                street = street_part
        elif len(lines) >= 2:
            city = candidate
    return {
        "street": street,
        "city": city,
        "postal_code": postal_code,
        "country_code": normalized_country,
    }


def _compose_address_text(
    line1: str | None,
    line2: str | None,
    postal_code: str | None,
    city: str | None,
    country_code: str | None,
) -> str | None:
    parts = []
    if line1:
        parts.append(line1)
    if line2:
        parts.append(line2)
    city_line = " ".join(part for part in [postal_code, city] if part)
    if city_line:
        parts.append(city_line)
    if country_code:
        parts.append(country_code)
    return "\n".join(parts) if parts else None


def _resolve_structured_address(
    address_raw: str | None,
    line1: str | None,
    line2: str | None,
    postal_code: str | None,
    city: str | None,
    country_code: str | None,
    fallback_country: str | None,
) -> tuple[str | None, dict]:
    raw = (address_raw or "").strip() or None
    line1 = (line1 or "").strip() or None
    line2 = (line2 or "").strip() or None
    postal_code = (postal_code or "").strip() or None
    city = (city or "").strip() or None
    country = (country_code or "").strip().upper() or None
    if not country:
        country = (fallback_country or "").strip().upper() or None
    if not raw:
        raw = _compose_address_text(line1, line2, postal_code, city, country)
    if line1 or line2 or postal_code or city or country:
        street = line1
        if line2:
            street = f"{line1} {line2}".strip() if line1 else line2
        return raw, {
            "street": street,
            "city": city,
            "postal_code": postal_code,
            "country_code": country,
        }
    return raw, _normalize_address(raw, country)


def _build_address_struct(
    address_raw: str | None,
    line1: str | None,
    line2: str | None,
    postal_code: str | None,
    city: str | None,
    country_code: str | None,
) -> dict | None:
    struct = {
        "line1": (line1 or "").strip() or None,
        "line2": (line2 or "").strip() or None,
        "postal_code": (postal_code or "").strip() or None,
        "city": (city or "").strip() or None,
        "country_code": (country_code or "").strip() or None,
    }
    if any(struct.values()):
        return struct
    raw = (address_raw or "").strip()
    if not raw:
        return None
    lines = [line.strip() for line in re.split(r"[\r\n]+", raw) if line.strip()]
    if not lines:
        return None
    return {
        "line1": lines[0],
        "line2": None,
        "postal_code": None,
        "city": None,
        "country_code": None,
    }


def _tenant_is_vat_liable(tenant: Tenant) -> bool:
    return bool((tenant.vat_number or "").strip())


def _is_b2b_customer(customer: Customer) -> bool:
    return (customer.client_type or "business").strip().lower() == "business"


def _fr_invoice_missing_fields(inv: Invoice, tenant: Tenant, customer: Customer) -> list[str]:
    checks = validate_fr_einvoicing_fields(inv, tenant, customer)
    missing_fields: list[str] = []
    for check in checks:
        field = check.get("field")
        if check.get("status") == "missing" and isinstance(field, str) and field:
            missing_fields.append(field)
    return missing_fields


def validate_fr_b2b_invoice_ready(inv: Invoice, customer: Customer, tenant: Tenant) -> list[str]:
    return _validate_fr_b2b_invoice_ready(inv, customer, tenant)


def is_fr_b2b(tenant_country: str | None, customer_country: str | None, client_type: str | None) -> bool:
    return _is_fr_b2b(tenant_country, customer_country, client_type)


def validate_fr_invoice_minimum_2026(
    tenant: Tenant,
    customer: Customer,
    invoice: Invoice,
    lines: list[InvoiceLine],
) -> list[str]:
    return _validate_fr_invoice_minimum_2026(tenant, customer, invoice, lines)


def validate_fr_invoice_minimum_2027(
    tenant: Tenant,
    customer: Customer,
    invoice: Invoice,
    lines: list[InvoiceLine],
) -> list[str]:
    return _validate_fr_invoice_minimum_2027(tenant, customer, invoice, lines)


def validate_invoice_required_fields(
    invoice: Invoice,
    tenant: Tenant,
    customer: Customer,
    lines: list[InvoiceLine] | None,
) -> list[str]:
    return _validate_invoice_required_fields(invoice, tenant, customer, lines)


def validate_ubl_xml(xml_bytes: bytes) -> list[str]:
    return _validate_ubl_xml(xml_bytes)


def select_connection_for_customer(
    db: Session,
    tenant_id: str,
    siren: str | None,
    siret: str | None,
) -> PdpConnection | None:
    return _select_connection_for_customer(db, tenant_id, siren, siret)


def resolve_provider(conn: PdpConnection, db: Session | None = None):
    return _resolve_provider(conn, db)


def _document_line_type(line: object) -> str:
    line_type = str(getattr(line, "line_type", None) or "item").strip().lower()
    return line_type if line_type in {"item", "title", "comment"} else "item"


def _ensure_document_line_quota(lines: list[object], label: str) -> None:
    max_lines = int(getattr(settings, "MAX_INVOICE_LINES", 200) or 0)
    if max_lines > 0 and len(lines) > max_lines:
        metrics.inc_operational_event("quota_exceeded")
        logger.warning("quota_exceeded", extra={"scope": "invoice_lines", "line_count": len(lines)})
        raise HTTPException(
            status_code=400,
            detail={
                "code": "document_lines_quota_exceeded",
                "message": f"{label} limité à {max_lines} lignes. Scindez le document ou utilisez un export dédié.",
            },
        )


def _line_is_item(line: object) -> bool:
    return _document_line_type(line) == "item"


VAT_FRANCHISE_REASON_CODE = "VATEX-FR-FRANCHISE"
VAT_FRANCHISE_ERROR = {
    "code": "tenant_vat_franchise_requires_zero_vat",
    "message": "Votre entreprise est en franchise en base : appliquez une TVA à 0 % avec la mention TVA non applicable, art. 293 B du CGI.",
}


def _tenant_uses_vat_franchise(tenant: Tenant | None) -> bool:
    return is_vat_franchise_regime(getattr(tenant, "vat_regime", None))


def _enforce_tenant_vat_franchise(tenant: Tenant, lines: list[InvoiceLineIn]) -> None:
    if not _tenant_uses_vat_franchise(tenant):
        return
    for line in lines:
        if not _line_is_item(line):
            continue
        rate = quantize_amount(getattr(line, "vat_rate", 0) or 0)
        if rate > Decimal("0"):
            raise HTTPException(400, detail=VAT_FRANCHISE_ERROR)
        setattr(line, "vat_rate", Decimal("0"))
        current_category = str(getattr(line, "vat_category", "") or "").strip().upper()
        if not current_category or current_category == "S":
            setattr(line, "vat_category", "E")
        if not str(getattr(line, "exemption_reason_code", "") or "").strip():
            setattr(line, "exemption_reason_code", VAT_FRANCHISE_REASON_CODE)


_PUBLIC_CLIENT_TYPES = frozenset({"public", "public_sector", "government", "state", "b2g"})


def _facturx_profile(profile: str | None = None, tenant: Tenant | None = None, customer: Customer | None = None) -> str:
    if tenant and customer:
        if (customer.client_type or "business").strip().lower() in _PUBLIC_CLIENT_TYPES:
            # Chorus FSO1117A is qualified with the EN 16931 Factur-X profile.
            # Existing immutable documents using another profile remain blocked
            # by the provider-specific packager rather than being rewritten.
            return "en16931"
        ctx = {
            "supplier": {"country": tenant.country},
            "customer": {
                "country": customer.country,
                "client_type": customer.client_type or "business",
            },
        }
        return resolve_facturx_profile(ctx, profile)
    return normalize_facturx_profile(profile)


def _ubl_export_enabled() -> bool:
    return bool(settings.UBL_EXPORT_ENABLED)


def _validation_status(errors: list[str]) -> dict[str, object]:
    if not errors:
        return {"status": "ok", "errors": []}
    status = "unavailable" if any("indisponible" in err.lower() for err in errors) else "error"
    return {"status": status, "errors": errors}


def _iso(value: object) -> str | None:
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return str(isoformat())
    return str(value)


def _decimal_str(value: object) -> str | None:
    if value is None:
        return None
    return str(value)


def _sanitize_text(value: object | None, limit: int = 500) -> str | None:
    return sanitize_public_provider_message(value, max_chars=limit)


def _sanitize_errors(errors: list | None, limit: int = 500) -> list[str]:
    if not errors:
        return []
    cleaned: list[str] = []
    for err in errors:
        if isinstance(err, str):
            cleaned.append(_sanitize_text(err, limit) or "")
        else:
            cleaned.append(_sanitize_text(str(err), limit) or "")
    return [item for item in cleaned if item]


def _issued_hash(pdf: bytes | None, xml: bytes | None) -> str | None:
    if not pdf or not xml:
        return None
    return hashlib.sha256(pdf + xml).hexdigest()


def _sha256_bytes(payload: bytes | None) -> str | None:
    if not payload:
        return None
    return hashlib.sha256(payload).hexdigest()


def _normalize_artifact_kind(kind: str) -> str:
    normalized = (kind or "").strip().lower()
    if normalized in INVOICE_ARTIFACT_KIND_ALIASES:
        return INVOICE_ARTIFACT_KIND_ALIASES[normalized]
    upper = (kind or "").strip().upper()
    if upper in INVOICE_ARTIFACT_CONTENT_TYPES:
        return upper
    raise ValueError("Type de fichier de facture inconnu.")


def _artifact_content_type(kind: str) -> str:
    return INVOICE_ARTIFACT_CONTENT_TYPES[kind]


def _get_invoice_artifact(db: Session, inv: Invoice, kind: str) -> InvoiceArtifact | None:
    return (
        db.query(InvoiceArtifact)
        .filter(
            InvoiceArtifact.invoice_id == inv.id,
            InvoiceArtifact.tenant_id == inv.tenant_id,
            InvoiceArtifact.kind == kind,
        )
        .first()
    )


def _store_invoice_artifact_record(
    db: Session,
    inv: Invoice,
    kind: str,
    content_type: str,
    *,
    payload: bytes | None = None,
    storage_key: str | None = None,
    sha256: str | None = None,
    size_bytes: int | None = None,
) -> InvoiceArtifact:
    if payload is not None:
        sha256 = sha256 or hashlib.sha256(payload).hexdigest()
        size_bytes = len(payload) if size_bytes is None else size_bytes
    if sha256 is None or size_bytes is None:
        raise ValueError("Les informations du fichier de facture sont incomplètes.")
    artifact = InvoiceArtifact(
        tenant_id=inv.tenant_id,
        invoice_id=inv.id,
        kind=kind,
        storage_key=storage_key,
        sha256=sha256,
        content_type=content_type,
        size_bytes=size_bytes,
        data=None,
    )
    db.add(artifact)
    db.flush()
    return artifact


def _store_invoice_artifact_payload(
    inv: Invoice,
    normalized_kind: str,
    payload: bytes,
    content_type: str,
    *,
    allow_locked_existing_payload: bool = False,
) -> str:
    if normalized_kind == "PDF":
        _store_invoice_artifact(
            inv,
            "pdf",
            payload,
            content_type,
            allow_locked_existing_payload=allow_locked_existing_payload,
        )
        return inv.pdf_key or ""
    if normalized_kind == "CII":
        _store_invoice_artifact(
            inv,
            "xml",
            payload,
            content_type,
            allow_locked_existing_payload=allow_locked_existing_payload,
        )
        return inv.xml_key or ""
    if normalized_kind == "FACTURX":
        _store_invoice_artifact(
            inv,
            "facturx",
            payload,
            content_type,
            allow_locked_existing_payload=allow_locked_existing_payload,
        )
        return inv.facturx_key or ""
    if normalized_kind == "UBL":
        key = invoice_artifact_key(inv.id, "ubl")
        put_object(key, payload, content_type, legal_archive=True, retain_until=_invoice_artifact_retain_until(inv))
        return key
    raise ValueError("Type de fichier de facture inconnu.")


def _upsert_invoice_artifact_record(
    db: Session,
    inv: Invoice,
    kind: str,
    payload: bytes,
    content_type: str,
    *,
    artifact: InvoiceArtifact | None = None,
    storage_key: str | None = None,
) -> InvoiceArtifact:
    sha256 = hashlib.sha256(payload).hexdigest()
    size_bytes = len(payload)
    storage_key = storage_key or _artifact_storage_key_for_kind(inv, kind, artifact)
    if artifact:
        changed = _update_invoice_artifact_metadata(
            artifact,
            storage_key=storage_key,
            sha256=sha256,
            size_bytes=size_bytes,
            content_type=content_type,
            clear_data=True,
        )
        if changed:
            db.add(artifact)
        return artifact
    return _store_invoice_artifact_record(
        db,
        inv,
        kind,
        content_type,
        payload=payload,
        storage_key=storage_key,
        sha256=sha256,
        size_bytes=size_bytes,
    )


def _ensure_invoice_hashes(
    inv: Invoice,
    pdf_bytes: bytes | None = None,
    xml_bytes: bytes | None = None,
    facturx_bytes: bytes | None = None,
) -> tuple[dict[str, str | None], bool]:
    changed = False
    if inv.pdf_key and not inv.pdf_checksum:
        pdf_bytes = pdf_bytes or _load_invoice_artifact(inv, "pdf")
        checksum = _sha256_bytes(pdf_bytes)
        if checksum:
            inv.pdf_checksum = checksum
            changed = True
    if inv.xml_key and not inv.xml_checksum:
        xml_bytes = xml_bytes or _load_invoice_artifact(inv, "xml")
        checksum = _sha256_bytes(xml_bytes)
        if checksum:
            inv.xml_checksum = checksum
            changed = True
    if inv.facturx_key and not inv.facturx_checksum:
        facturx_bytes = facturx_bytes or _load_invoice_artifact(inv, "facturx")
        checksum = _sha256_bytes(facturx_bytes)
        if checksum:
            inv.facturx_checksum = checksum
            changed = True
    if not inv.issued_hash:
        if pdf_bytes is None and inv.pdf_key:
            pdf_bytes = _load_invoice_artifact(inv, "pdf")
        if xml_bytes is None and inv.xml_key:
            xml_bytes = _load_invoice_artifact(inv, "xml")
        issued = _issued_hash(pdf_bytes, xml_bytes)
        if issued:
            inv.issued_hash = issued
            changed = True
    return (
        {
            "pdf_sha256": inv.pdf_checksum,
            "xml_sha256": inv.xml_checksum,
            "facturx_sha256": inv.facturx_checksum,
            "issued_hash": inv.issued_hash,
        },
        changed,
    )


def _artifact_expected_checksum(inv: Invoice, kind: str) -> str | None:
    normalized = (kind or "").strip().lower()
    if normalized == "pdf":
        return inv.pdf_checksum
    if normalized in {"xml", "cii"}:
        return inv.xml_checksum
    if normalized == "facturx":
        return inv.facturx_checksum
    return None


def _artifact_storage_key_for_kind(
    inv: Invoice,
    kind: str,
    artifact: InvoiceArtifact | None = None,
) -> str | None:
    if artifact and artifact.storage_key:
        return artifact.storage_key
    normalized = (kind or "").strip().upper()
    if normalized == "PDF":
        return inv.pdf_key or invoice_artifact_key(inv.id, "pdf")
    if normalized == "CII":
        return inv.xml_key or invoice_artifact_key(inv.id, "xml")
    if normalized == "FACTURX":
        return inv.facturx_key or invoice_artifact_key(inv.id, "facturx")
    if normalized == "UBL":
        return invoice_artifact_key(inv.id, "ubl")
    return None


def _artifact_invoice_metadata(inv: Invoice, kind: str) -> tuple[str | None, int | None]:
    normalized = (kind or "").strip().upper()
    if normalized == "PDF":
        return inv.pdf_checksum, inv.pdf_size
    if normalized == "CII":
        return inv.xml_checksum, inv.xml_size
    if normalized == "FACTURX":
        return inv.facturx_checksum, inv.facturx_size
    return None, None


def _raise_invoice_artifact_integrity_error(inv: Invoice, kind: str, reason: str = "integrity") -> None:
    security_logger.warning(
        "artifact_integrity_error invoice_id=%s tenant_id=%s kind=%s reason=%s",
        inv.id,
        inv.tenant_id,
        kind,
        reason,
    )
    raise HTTPException(
        status_code=409,
        detail={
            "code": "artifact_integrity_error",
            "message": "L’intégrité du fichier de facture ne peut pas être confirmée.",
            "artifact_kind": kind,
        },
    )


def _invoice_artifact_metadata_locked(
    inv: Invoice,
    kind: str,
    artifact: InvoiceArtifact | None = None,
) -> bool:
    if not _is_invoice_immutable(inv):
        return False
    if artifact and (artifact.sha256 or artifact.storage_key or artifact.size_bytes is not None):
        return True
    checksum, size_bytes = _artifact_invoice_metadata(inv, kind)
    if checksum or size_bytes is not None:
        return True
    normalized = (kind or "").strip().upper()
    if normalized == "PDF":
        return bool(inv.pdf_key)
    if normalized == "CII":
        return bool(inv.xml_key)
    if normalized == "FACTURX":
        return bool(inv.facturx_key)
    return False


def _update_invoice_artifact_metadata(
    artifact: InvoiceArtifact,
    *,
    storage_key: str | None = None,
    sha256: str | None = None,
    size_bytes: int | None = None,
    content_type: str | None = None,
    clear_data: bool = False,
) -> bool:
    changed = False
    if storage_key and artifact.storage_key != storage_key:
        artifact.storage_key = storage_key
        changed = True
    if sha256 and artifact.sha256 != sha256:
        artifact.sha256 = sha256
        changed = True
    if size_bytes is not None and artifact.size_bytes != size_bytes:
        artifact.size_bytes = size_bytes
        changed = True
    if content_type and artifact.content_type != content_type:
        artifact.content_type = content_type
        changed = True
    if clear_data and artifact.data is not None:
        artifact.data = None
        changed = True
    return changed


def _reload_invoice_artifact_from_storage(
    inv: Invoice,
    artifact: InvoiceArtifact,
    kind: str,
    expected_checksum: str,
) -> bytes | None:
    key = _artifact_storage_key_for_kind(inv, kind, artifact)
    if not key:
        return None
    if not head_object(key):
        security_logger.warning(
            "artifact_storage_missing invoice_id=%s tenant_id=%s kind=%s key=%s",
            inv.id,
            inv.tenant_id,
            kind,
            key,
        )
        return None
    payload = get_object_bytes(key)
    if not payload:
        security_logger.warning(
            "artifact_storage_empty invoice_id=%s tenant_id=%s kind=%s key=%s",
            inv.id,
            inv.tenant_id,
            kind,
            key,
        )
        return None
    actual = _sha256_bytes(payload)
    if actual != expected_checksum:
        security_logger.warning(
            "artifact_storage_checksum_mismatch invoice_id=%s tenant_id=%s kind=%s expected=%s actual=%s key=%s",
            inv.id,
            inv.tenant_id,
            kind,
            expected_checksum,
            actual,
            key,
        )
        return None
    _update_invoice_artifact_metadata(
        artifact,
        storage_key=key,
        sha256=actual or "",
        size_bytes=len(payload),
        clear_data=True,
    )
    return payload


def _ensure_invoice_artifact_integrity(
    db: Session,
    inv: Invoice,
    artifact: InvoiceArtifact,
    kind: str,
) -> None:
    expected = _artifact_expected_checksum(inv, kind)
    if not expected:
        _, hashes_changed = _ensure_invoice_hashes(inv)
        if hashes_changed:
            db.add(inv)
        expected = _artifact_expected_checksum(inv, kind)
    if not expected:
        return None
    if artifact.sha256 == expected:
        key = _artifact_storage_key_for_kind(inv, kind, artifact)
        if key and head_object(key):
            return None
        if artifact.data:
            payload = bytes(artifact.data)
            if _sha256_bytes(payload) == expected:
                storage_key = _store_invoice_artifact_payload(
                    inv,
                    _normalize_artifact_kind(kind),
                    payload,
                    artifact.content_type or _artifact_content_type(kind),
                    allow_locked_existing_payload=True,
                )
                _update_invoice_artifact_metadata(
                    artifact,
                    storage_key=storage_key,
                    sha256=expected,
                    size_bytes=len(payload),
                    clear_data=True,
                )
                db.add(inv)
                db.add(artifact)
                return None
        refreshed = _reload_invoice_artifact_from_storage(inv, artifact, kind, expected)
        if refreshed is not None:
            db.add(artifact)
            return None
        _raise_invoice_artifact_integrity_error(inv, kind, "storage_missing")
        return None
    security_logger.warning(
        "artifact_checksum_mismatch invoice_id=%s tenant_id=%s kind=%s expected=%s actual=%s",
        inv.id,
        inv.tenant_id,
        kind,
        expected,
        artifact.sha256,
    )
    refreshed = _reload_invoice_artifact_from_storage(inv, artifact, kind, expected)
    if refreshed is not None:
        db.add(artifact)
        return None
    _raise_invoice_artifact_integrity_error(inv, kind, "checksum_mismatch")


def _invoice_artifact_retain_until(inv: Invoice) -> datetime:
    source_date = inv.issue_date or inv.issued_at or datetime.now(timezone.utc)
    if isinstance(source_date, datetime):
        issued_at = source_date
    elif isinstance(source_date, date):
        issued_at = datetime(source_date.year, source_date.month, source_date.day, tzinfo=timezone.utc)
    else:
        issued_at = datetime.now(timezone.utc)
    if issued_at.tzinfo is None:
        issued_at = issued_at.replace(tzinfo=timezone.utc)
    issued_at = issued_at.astimezone(timezone.utc)
    retention_years = settings.INVOICES_RETENTION_YEARS
    if retention_years is None or retention_years <= 0:
        retention_years = settings.RETENTION_DEFAULT_YEARS or 10
    return datetime(int(issued_at.year) + int(retention_years), 12, 31, 23, 59, 59, tzinfo=timezone.utc)


def _store_invoice_artifact(
    inv: Invoice,
    kind: str,
    payload: bytes,
    content_type: str,
    *,
    allow_locked_existing_payload: bool = False,
) -> None:
    normalized_kind = _normalize_artifact_kind(kind)
    if _invoice_artifact_metadata_locked(inv, normalized_kind) and not allow_locked_existing_payload:
        _raise_invoice_artifact_integrity_error(inv, normalized_kind, "locked_metadata_rewrite")
    key = invoice_artifact_key(inv.id, kind)
    put_object(key, payload, content_type, legal_archive=True, retain_until=_invoice_artifact_retain_until(inv))
    checksum = hashlib.sha256(payload).hexdigest()
    size = len(payload)
    if kind == "pdf":
        inv.pdf_key = key
        inv.pdf_checksum = checksum
        inv.pdf_size = size
        return
    if kind == "xml":
        inv.xml_key = key
        inv.xml_checksum = checksum
        inv.xml_size = size
        return
    if kind == "facturx":
        inv.facturx_key = key
        inv.facturx_checksum = checksum
        inv.facturx_size = size
        return
    raise ValueError("Type de fichier de facture inconnu.")


def _store_facturx_result(inv: Invoice, payload: bytes, pdfa_status: str | None, pdfa_report: str | None) -> None:
    _store_invoice_artifact(inv, "facturx", payload, "application/pdf")
    inv.pdfa3_status = pdfa_status
    inv.pdfa3_report = sanitize_public_pdfa_report(pdfa_report, pdfa_status)
    inv.facturx_spec_version = settings.FACTURX_SPEC_VERSION


def _load_invoice_artifact(inv: Invoice, kind: str) -> bytes | None:
    key = None
    if kind == "pdf":
        key = inv.pdf_key or invoice_artifact_key(inv.id, "pdf")
    elif kind in {"xml", "cii"}:
        key = inv.xml_key or invoice_artifact_key(inv.id, "xml")
    elif kind == "facturx":
        key = inv.facturx_key or invoice_artifact_key(inv.id, "facturx")
    elif kind == "ubl":
        key = invoice_artifact_key(inv.id, "ubl")
    if not key:
        return None
    return get_object_bytes(key)


def ensure_invoice_artifact(
    db: Session,
    inv: Invoice,
    kind: str,
    ctx: dict | None = None,
) -> InvoiceArtifact:
    normalized_kind = _normalize_artifact_kind(kind)
    artifact = _get_invoice_artifact(db, inv, normalized_kind)
    content_type = _artifact_content_type(normalized_kind)
    storage_key = _artifact_storage_key_for_kind(inv, normalized_kind, artifact)
    storage_exists = bool(storage_key and head_object(storage_key))

    if artifact:
        if storage_exists:
            changed = _update_invoice_artifact_metadata(
                artifact,
                storage_key=storage_key,
                content_type=content_type,
                clear_data=True,
            )
            if changed:
                db.add(artifact)
            return artifact
        if _invoice_artifact_metadata_locked(inv, normalized_kind, artifact):
            if not artifact.data:
                _raise_invoice_artifact_integrity_error(inv, normalized_kind, "stored_artifact_missing")
        if artifact.data:
            expected = _artifact_expected_checksum(inv, normalized_kind)
            if not expected:
                _, hashes_changed = _ensure_invoice_hashes(inv)
                if hashes_changed:
                    db.add(inv)
                expected = _artifact_expected_checksum(inv, normalized_kind)
            payload = bytes(artifact.data)
            payload_sha256 = _sha256_bytes(payload)
            if _is_invoice_immutable(inv):
                if expected and payload_sha256 != expected:
                    _raise_invoice_artifact_integrity_error(inv, normalized_kind, "stored_data_checksum_mismatch")
                if artifact.sha256 and payload_sha256 != artifact.sha256:
                    _raise_invoice_artifact_integrity_error(inv, normalized_kind, "stored_data_metadata_mismatch")
            elif expected and artifact.sha256 and artifact.sha256 != expected:
                return artifact
            storage_key = _store_invoice_artifact_payload(
                inv,
                normalized_kind,
                payload,
                content_type,
                allow_locked_existing_payload=_is_invoice_immutable(inv),
            )
            return _upsert_invoice_artifact_record(
                db,
                inv,
                normalized_kind,
                payload,
                content_type,
                artifact=artifact,
                storage_key=storage_key,
            )

    if storage_exists:
        sha256, size_bytes = _artifact_invoice_metadata(inv, normalized_kind)
        if not sha256 or size_bytes is None:
            stored_payload = get_object_bytes(storage_key)
            if stored_payload:
                sha256 = hashlib.sha256(stored_payload).hexdigest()
                size_bytes = len(stored_payload)
        if sha256 and size_bytes is not None:
            return _store_invoice_artifact_record(
                db,
                inv,
                normalized_kind,
                content_type,
                storage_key=storage_key,
                sha256=sha256,
                size_bytes=size_bytes,
            )

    if _invoice_artifact_metadata_locked(inv, normalized_kind, artifact):
        _raise_invoice_artifact_integrity_error(inv, normalized_kind, "expected_artifact_missing")

    snapshot_changed = ensure_invoice_snapshot(db, inv)
    if ctx is None or snapshot_changed:
        ctx = _ctx(db, inv)

    if normalized_kind == "PDF":
        pdf_bytes = invoice_pdf(ctx)
        _store_invoice_artifact(inv, "pdf", pdf_bytes, "application/pdf")
        return _upsert_invoice_artifact_record(
            db,
            inv,
            normalized_kind,
            pdf_bytes,
            content_type,
            artifact=artifact,
            storage_key=inv.pdf_key,
        )
    if normalized_kind == "CII":
        xml_bytes = cii_invoice_xml(ctx, False)
        _store_invoice_artifact(inv, "xml", xml_bytes, "application/xml")
        return _upsert_invoice_artifact_record(
            db,
            inv,
            normalized_kind,
            xml_bytes,
            content_type,
            artifact=artifact,
            storage_key=inv.xml_key,
        )
    if normalized_kind == "UBL":
        xml_bytes = ubl_document_xml(ctx)
        storage_key = _store_invoice_artifact_payload(inv, normalized_kind, xml_bytes, content_type)
        return _upsert_invoice_artifact_record(
            db,
            inv,
            normalized_kind,
            xml_bytes,
            content_type,
            artifact=artifact,
            storage_key=storage_key,
        )
    if normalized_kind == "FACTURX":
        ensure_invoice_artifact(db, inv, "pdf", ctx)
        ensure_invoice_artifact(db, inv, "cii", ctx)
        stored_pdf_bytes = _load_invoice_artifact(inv, "pdf")
        xml_bytes = cii_invoice_xml(ctx, False)
        if not stored_pdf_bytes:
            raise HTTPException(409, "Les fichiers PDF et XML de la facture sont manquants.")
        try:
            facturx_bytes, pdfa_status, pdfa_report = facturx_from_pdf_xml_with_meta(
                stored_pdf_bytes,
                xml_bytes,
                inv.issued_profile,
            )
        except FacturxXsdValidationError as exc:
            _raise_facturx_xsd_error(exc)
        except FacturxSchematronValidationError as exc:
            _raise_facturx_schematron_error(exc)
        except FacturxEmbedError as exc:
            _raise_facturx_embed_error(exc)
        except FacturxPdfa3Error as exc:
            _raise_facturx_pdfa_error(exc)
        _store_facturx_result(inv, facturx_bytes, pdfa_status, pdfa_report)
        return _upsert_invoice_artifact_record(
            db,
            inv,
            normalized_kind,
            facturx_bytes,
            content_type,
            artifact=artifact,
            storage_key=inv.facturx_key,
        )
    raise ValueError("Type de fichier de facture inconnu.")


def _stream_invoice_artifact(
    request: Request,
    key: str,
    content_type: str,
    filename: str,
    *,
    disposition: str = "attachment",
):
    meta = head_object(key)
    if not meta:
        raise HTTPException(404, "Not found")
    range_header = request.headers.get("range")
    byte_range = parse_range_header(range_header, meta.size) if range_header else None
    if range_header and byte_range is None:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{meta.size}"})
    stream = get_object_stream(key, byte_range)
    if not stream:
        raise HTTPException(404, "Not found")
    safe_disposition = "inline" if disposition == "inline" else "attachment"
    headers = {
        "Content-Disposition": f'{safe_disposition}; filename="{filename}"',
        "Accept-Ranges": "bytes",
        "Content-Length": str(stream.content_length),
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
    }
    if byte_range:
        start, end = byte_range
        headers["Content-Range"] = f"bytes {start}-{end}/{stream.total_size}"
    if stream.etag:
        headers["ETag"] = stream.etag
    return StreamingResponse(
        stream.body,
        media_type=content_type,
        headers=headers,
        status_code=206 if byte_range else 200,
    )


def _compute_due_date(issue_date: datetime, payment_terms: str | None, due_days: int | None) -> datetime | None:
    days = due_days if due_days is not None else 30
    if payment_terms:
        import re as _re

        match = _re.search(r"(\d+)", payment_terms)
        if match:
            try:
                days = int(match.group(1))
            except Exception:
                pass
    due = issue_date + timedelta(days=days)
    if payment_terms and ("fin de mois" in payment_terms.lower() or "fdm" in payment_terms.lower()):
        last_day = calendar.monthrange(due.year, due.month)[1]
        due = due.replace(day=last_day)
    return due


def _due_date_is_manual(payload_due_date: datetime | None, computed_due_date: datetime | None) -> bool:
    if payload_due_date is None:
        return False
    if computed_due_date is None:
        return True
    return payload_due_date.replace(tzinfo=None) != computed_due_date.replace(tzinfo=None)


def _mark_overdue(inv: Invoice, db: Session):
    changed = False
    if not inv.due_date:
        inv.due_date = _compute_due_date(inv.issue_date or _utcnow(), inv.payment_terms, inv.due_days)
        db.add(inv)
        changed = True
    if inv.status not in {"issued", "sent", "partial", "overdue"}:
        return changed
    if inv.due_date and inv.due_date < _utcnow() and _outstanding(db, inv) > 0:
        inv.status = "overdue"
        db.add(inv)
        changed = True
    return changed


def _compute_due_date_no_write(inv: Invoice) -> datetime | None:
    if inv.due_date:
        return inv.due_date
    issue_date = inv.issue_date or _utcnow()
    return _compute_due_date(issue_date, inv.payment_terms, inv.due_days)


def _is_overdue(inv: Invoice, db: Session, now: datetime | None = None) -> bool:
    if inv.status in {"paid", "canceled"}:
        return False
    check_time = now or _utcnow()
    due_date = _compute_due_date_no_write(inv)
    if not due_date or due_date >= check_time:
        return False
    return _outstanding(db, inv) > 0


_CREDIT_NOTE_CANCELED_STATUSES = ("canceled", "cancelled")
_CREDIT_NOTE_INACTIVE_STATUSES = ("draft", *_CREDIT_NOTE_CANCELED_STATUSES)


def _credit_notes_total(
    db: Session,
    inv: Invoice,
    *,
    include_drafts: bool = False,
    exclude_invoice_id: str | None = None,
) -> Decimal:
    excluded_statuses = _CREDIT_NOTE_CANCELED_STATUSES if include_drafts else _CREDIT_NOTE_INACTIVE_STATUSES
    query = db.query(Invoice).filter(
        Invoice.related_invoice_id == inv.id,
        Invoice.tenant_id == inv.tenant_id,
        Invoice.type == "credit_note",
        Invoice.status.notin_(excluded_statuses),
    )
    if exclude_invoice_id:
        query = query.filter(Invoice.id != exclude_invoice_id)
    notes = query.all()
    return sum((abs(Decimal(str(n.total_inc_vat or 0))) for n in notes), Decimal("0"))


def _credit_notes_breakdown(notes: list[Invoice]) -> dict[str, Decimal]:
    issued = Decimal("0")
    draft = Decimal("0")
    canceled = Decimal("0")
    for note in notes:
        amount = abs(Decimal(str(note.total_inc_vat or 0)))
        status = str(note.status or "").strip().lower()
        if status == "draft":
            draft += amount
        elif status in _CREDIT_NOTE_CANCELED_STATUSES:
            canceled += amount
        else:
            issued += amount
    return {
        "issued": issued,
        "draft": draft,
        "canceled": canceled,
        "all": issued + draft + canceled,
    }


def _validate_credit_note_source(related: Invoice) -> None:
    if related.type != "invoice":
        raise HTTPException(400, "Impossible de créer un avoir à partir d'un avoir.")
    status = str(related.status or "").strip().lower()
    if status == "draft":
        raise HTTPException(409, "Émettez la facture avant de créer un avoir.")
    if status in _CREDIT_NOTE_CANCELED_STATUSES:
        raise HTTPException(400, "Impossible de créer un avoir sur une facture annulée.")


def _validate_credit_note_amount(
    db: Session,
    credit_note: Invoice,
    related: Invoice | None = None,
    *,
    include_drafts: bool = False,
) -> None:
    if credit_note.type != "credit_note":
        return
    if related is None and credit_note.related_invoice_id:
        related = db.get(Invoice, credit_note.related_invoice_id)
    if not related or related.tenant_id != credit_note.tenant_id:
        raise HTTPException(404, "Facture d'origine introuvable pour créer un avoir.")
    _validate_credit_note_source(related)
    original_total = abs(Decimal(str(related.total_inc_vat or 0)))
    if original_total <= Decimal("0"):
        raise HTTPException(400, "Impossible de créer un avoir sur une facture sans montant positif.")
    existing_credits = _credit_notes_total(
        db,
        related,
        include_drafts=include_drafts,
        exclude_invoice_id=credit_note.id,
    )
    remaining_credit = original_total - Decimal(str(existing_credits or 0))
    if remaining_credit < Decimal("0"):
        remaining_credit = Decimal("0")
    if abs(Decimal(str(credit_note.total_inc_vat or 0))) > (remaining_credit + Decimal("0.01")):
        raise HTTPException(400, "Montant de l'avoir supérieur au montant restant à avoir sur cette facture.")


def validate_credit_note_before_issue(db: Session, credit_note: Invoice) -> None:
    _validate_credit_note_amount(db, credit_note, include_drafts=False)


def _payments_total(inv: Invoice) -> Decimal:
    return sum((Decimal(str(p.amount or 0)) for p in inv.payments or []), Decimal("0"))


def _refunds_total(db: Session, inv: Invoice) -> Decimal:
    refunds = db.query(CreditNoteRefund).filter(CreditNoteRefund.invoice_id == inv.id).all()
    return sum((Decimal(str(r.amount or 0)) for r in refunds), Decimal("0"))


def _outstanding(db: Session, inv: Invoice) -> Decimal:
    credits = _credit_notes_total(db, inv)
    paid = _payments_total(inv)
    return invoice_balance_due_amount(
        inv.total_inc_vat,
        invoice_effective_template_options(db, inv),
        credits=credits,
        paid=paid,
    )


def _followup_offset_label(offset: int) -> str:
    if offset < 0:
        return f"{abs(offset)} jour{'s' if abs(offset) > 1 else ''} avant échéance"
    if offset == 0:
        return "À l'échéance"
    return f"{offset} jour{'s' if offset > 1 else ''} après échéance"


def _invoice_followup_plan(
    db: Session,
    *,
    inv: Invoice,
    tenant: Tenant | None,
    customer: Customer | None,
    balance_due: Decimal,
    now: datetime,
) -> dict[str, object]:
    return invoice_followup_decision(
        db,
        inv=inv,
        tenant=tenant,
        customer=customer,
        balance_due=balance_due,
        now=now,
        due_date=_compute_due_date_no_write(inv),
    ).as_payload(include_schedule=True)


def _log_action(
    db: Session,
    user: AuthUser | None,
    tenant_id: str,
    entity: str,
    entity_id: str,
    action: str,
    payload: dict | None = None,
):
    log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=user.id if user else None,
        action_type=action,
        object_type=entity,
        object_id=entity_id,
        metadata=payload or {},
    )


def _safe_log_export_action(
    db: Session,
    user: AuthUser | None,
    tenant_id: str,
    action: str,
    payload: dict | None = None,
) -> None:
    safe_log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=user.id if user else None,
        action_type=action,
        object_type="tenant",
        object_id=tenant_id,
        metadata=payload or {},
        commit=True,
    )


def _require_role_accountant(user: AuthUser):
    if user.is_api_key:
        if API_SCOPE_WRITE_INVOICES in user.scopes:
            return
        raise HTTPException(403, "Droits comptables requis.")
    role = (user.role or "").lower()
    if role not in {"owner", "admin", "accountant"} and not user.is_admin:
        raise HTTPException(403, "Droits comptables requis.")


def _mutable_actor_id(user: AuthUser | None) -> str | None:
    if not user or user.is_api_key:
        return None
    return user.id


def _resolve_pdp_connection(db: Session, tenant_id: str, provider_slug: str | None) -> PdpConnection:
    slug = (provider_slug or "").strip().lower()
    q = db.query(PdpConnection).filter(PdpConnection.tenant_id == tenant_id)
    if slug:
        conn = q.filter(PdpConnection.provider_slug == slug).first()
        if not conn:
            raise HTTPException(400, "Connexion plateforme agréée introuvable.")
        return conn
    conns = q.order_by(PdpConnection.updated_at.desc(), PdpConnection.created_at.desc()).all()
    if not conns:
        raise HTTPException(400, "Aucune connexion plateforme agréée configurée.")
    if len(conns) > 1:
        raise HTTPException(400, "Plusieurs plateformes agréées sont disponibles. Sélectionnez celle à utiliser.")
    return conns[0]


def can_transition(old_status: str, new_status: str) -> bool:
    if old_status == new_status:
        return True
    allowed = {
        "draft": {"issued", "sent", "paid", "partial", "canceled"},
        "issued": {"sent", "paid", "partial", "overdue", "canceled"},
        "sent": {"paid", "partial", "overdue", "canceled"},
        "partial": {"paid", "overdue", "canceled"},
        "overdue": {"paid", "partial", "canceled"},
        "canceled": set(),
        "paid": set(),
    }
    return new_status in allowed.get(old_status, set())


def _format_template(
    template: str,
    inv: Invoice,
    customer: Customer,
    tenant: Tenant,
    totals: dict,
    *,
    invoice_link: str | None = None,
    reply_to: str | None = None,
):
    def _fmt_date(d: datetime | None) -> str:
        if not d:
            return ""
        try:
            return d.strftime("%d/%m/%Y")
        except Exception:
            return str(d)

    def _fmt_amount(v) -> str:
        try:
            return f"{Decimal(str(v)):.2f}"
        except Exception:
            try:
                return f"{float(v):.2f}"
            except Exception:
                return str(v)

    link = invoice_link
    if link is None:
        if inv.public_enabled and inv.public_token:
            link = _invoice_public_url(inv.public_token)
        else:
            link = ""

    replacements = {
        "{client}": (customer.name or "").strip(),
        "{company}": (tenant.name or "").strip(),
        "{number}": (inv.number or "").strip(),
        "{issue_date}": _fmt_date(inv.issue_date),
        "{due_date}": _fmt_date(inv.due_date),
        "{total_ht}": _fmt_amount(totals.get("ht", inv.total_ex_vat)),
        "{total_tva}": _fmt_amount(totals.get("tva", inv.total_vat)),
        "{total_ttc}": _fmt_amount(totals.get("ttc", inv.total_inc_vat)),
        "{currency}": (inv.currency or "EUR").strip(),
        "{invoice_link}": link or "",
        "{reply_to}": (reply_to or "").strip(),
        "{invoice_link_expires_at}": invoice_public_link_expires_at(inv).strftime("%d/%m/%Y")
        if invoice_public_link_expires_at(inv)
        else "",
        "{invoice_link_expires_in_days}": str(invoice_public_link_days_left(inv))
        if invoice_public_link_days_left(inv) is not None
        else "",
        "{invoice_link_validity_days}": str(invoice_public_link_ttl_days()),
    }
    out = template or ""
    for k, v in replacements.items():
        out = out.replace(k, v)
    return out


def _append_invoice_link_notice(body: str, template: str, inv: Invoice, invoice_link: str) -> str:
    if not invoice_link:
        return body
    notice = invoice_public_link_notice(inv)
    if not notice:
        return body
    if "{invoice_link_expires" in (template or "") or notice in body:
        return body
    return body.rstrip() + f"\n\n{notice}\n"


def _recalculate_invoice_status_after_payment_change(
    db: Session,
    inv: Invoice,
    user: AuthUser,
    *,
    reason: str,
    reference_date: datetime | None = None,
) -> None:
    payments = db.query(Payment).filter(Payment.invoice_id == inv.id).order_by(Payment.date.desc()).all()
    setattr(inv, "payments", payments)

    credits = _credit_notes_total(db, inv)
    paid = _payments_total(inv)
    remaining = invoice_balance_due_amount(
        inv.total_inc_vat,
        invoice_effective_template_options(db, inv),
        credits=credits,
        paid=paid,
    )
    now = reference_date or _utcnow()

    if remaining <= Decimal("0.01"):
        target_status = "paid"
        latest_payment_date = None
        for payment in payments:
            if payment.date and (latest_payment_date is None or payment.date > latest_payment_date):
                latest_payment_date = payment.date
        inv.paid_at = latest_payment_date or now
    else:
        inv.paid_at = None
        if inv.due_date and inv.due_date < now:
            target_status = "overdue"
        elif paid > 0:
            target_status = "partial"
        else:
            target_status = "sent" if inv.sent_at else "issued"

    if inv.status != target_status:
        old_status = inv.status
        inv.status = target_status
        inv.updated_by = user.id
        db.add(inv)
        _log_action(
            db,
            user,
            inv.tenant_id,
            "invoice",
            inv.id,
            "sync_status_after_payment_change",
            {"from": old_status, "to": target_status, "reason": reason},
        )
    else:
        db.add(inv)


def _transition(inv: Invoice, new_status: str, db: Session, user: AuthUser, payload: dict | None = None):
    if inv.status == new_status:
        return
    if not can_transition(inv.status, new_status):
        raise HTTPException(400, f"Transition {inv.status} -> {new_status} non autorisée.")
    old = inv.status
    inv.status = new_status
    inv.updated_by = user.id
    db.add(inv)
    _log_action(
        db, user, inv.tenant_id, "invoice", inv.id, "update_status", {"from": old, "to": new_status, **(payload or {})}
    )


def _pdp_status_allows_invoice_sent(tx: EInvoicingTransmission | None) -> bool:
    status = str(getattr(tx, "status", "") or "").strip().lower()
    return status in PDP_SENT_STATUSES


def _pdp_status_blocks_invoice_sent(tx: EInvoicingTransmission | None) -> bool:
    status = str(getattr(tx, "status", "") or "").strip().lower()
    return status in PDP_FAILED_STATUSES or status not in PDP_SENT_STATUSES


def _mark_invoice_sent_after_pdp_submission(
    db: Session,
    inv: Invoice,
    tx: EInvoicingTransmission,
    user: AuthUser | None,
    *,
    provider_slug: str | None = None,
    reason: str = "pdp_submission",
) -> None:
    if _pdp_status_blocks_invoice_sent(tx):
        return
    invoice = db.get(Invoice, inv.id)
    if not invoice:
        return
    user_tenant_id = getattr(user, "tenant_id", invoice.tenant_id) if user else invoice.tenant_id
    if user and invoice.tenant_id != user_tenant_id:
        return
    changed = False
    if not invoice.sent_at:
        invoice.sent_at = _utcnow()
        changed = True
    if invoice.status == "issued":
        if user:
            _transition(
                invoice,
                "sent",
                db,
                user,
                {"reason": reason, "transmission_id": tx.id, "provider_slug": provider_slug or tx.channel},
            )
            return
        invoice.status = "sent"
        db.add(invoice)
        _log_action(
            db,
            None,
            invoice.tenant_id,
            "invoice",
            invoice.id,
            "update_status",
            {
                "from": "issued",
                "to": "sent",
                "reason": reason,
                "transmission_id": tx.id,
                "provider_slug": provider_slug or tx.channel,
            },
        )
        return
    if changed:
        db.add(invoice)
        _log_action(
            db,
            user,
            invoice.tenant_id,
            "invoice",
            invoice.id,
            "mark_sent",
            {"reason": reason, "transmission_id": tx.id, "provider_slug": provider_slug or tx.channel},
        )


def _has_active_einvoicing_transmission(db: Session, invoice_id: str) -> bool:
    return (
        db.query(EInvoicingTransmission.id)
        .filter(EInvoicingTransmission.invoice_id == invoice_id)
        .filter(~EInvoicingTransmission.status.in_(BLOCKING_STATUSES))
        .first()
        is not None
    )


def _next_number(db: Session, tenant_id: str, doc_type: str = "invoice", year: int | None = None) -> str:
    try:
        n = db.query(Numbering).filter(Numbering.tenant_id == tenant_id).with_for_update().first()
    except OperationalError:
        raise HTTPException(429, "Numérotation en cours d'utilisation, réessayez dans un instant.")
    if not n:
        n = Numbering(tenant_id=tenant_id, prefix="F-", last_index=0)
        db.add(n)
        db.flush()
    issue_year = year or _utcnow().year
    if not n.year or n.year != issue_year:
        n.year = issue_year
        n.last_index = 0
    n.last_index += 1
    db.add(n)
    prefix = "AV-" if doc_type == "credit_note" else n.prefix
    return f"{prefix}{n.year}-{n.last_index:04d}"


def _safe_filename(prefix: str, number: str | None, ext: str) -> str:
    base = (number or "").strip() or "document"
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", base)
    return f"{prefix}-{cleaned}.{ext}"


def _invoice_for_update(db: Session, invoice_id: str) -> Invoice | None:
    try:
        return db.query(Invoice).filter(Invoice.id == invoice_id).with_for_update().first()
    except OperationalError as exc:
        raise HTTPException(429, "Document en cours de traitement, réessayez dans un instant.") from exc


def _invoice_for_read(db: Session, invoice_id: str) -> Invoice | None:
    return db.query(Invoice).filter(Invoice.id == invoice_id).first()


def _email_attachment_filename(number: str | None, kind: str) -> str:
    base = (number or "").strip() or "document"
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", base)
    if kind == "facturx":
        return f"{cleaned}.facturx.pdf"
    return f"{cleaned}.pdf"


def _build_pagination_link(request: Request, limit: int, offset: int) -> str:
    parsed = urlparse(str(request.url))
    query = parse_qs(parsed.query)
    query["limit"] = [str(limit)]
    query["offset"] = [str(offset)]
    new_query = urlencode(query, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


def _set_pagination_headers(response: Response, request: Request, total: int, limit: int, offset: int) -> None:
    response.headers["X-Total-Count"] = str(total)
    if limit <= 0:
        return
    links: list[str] = []
    last_offset = max(((total - 1) // limit) * limit, 0) if total > 0 else 0
    links.append(f'<{_build_pagination_link(request, limit, 0)}>; rel="first"')
    links.append(f'<{_build_pagination_link(request, limit, last_offset)}>; rel="last"')
    if offset + limit < total:
        links.append(f'<{_build_pagination_link(request, limit, offset + limit)}>; rel="next"')
    if offset > 0:
        prev_offset = max(offset - limit, 0)
        links.append(f'<{_build_pagination_link(request, limit, prev_offset)}>; rel="prev"')
    if links:
        response.headers["Link"] = ", ".join(links)


@router.get("", response_model=list[InvoiceListOut])
def list_invoices(
    response: Response,
    request: Request,
    status: str | None = Query(None, description="draft|issued|sent|pending|partial|paid|overdue|canceled"),
    customer_id: str | None = None,
    period: str | None = Query(None, description="month:YYYY-MM ou year:YYYY"),
    month: int | None = None,
    year: int | None = None,
    q: str | None = Query(None, description="Recherche facture (numéro, commande, client)"),
    start_date: str | None = Query(None, description="Date d'émission début (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="Date d'émission fin (YYYY-MM-DD inclus)"),
    min_total_ht: str | None = Query(None, description="Montant HT minimum"),
    max_total_ht: str | None = Query(None, description="Montant HT maximum"),
    paid_start_date: str | None = Query(None, description="Date de paiement début (YYYY-MM-DD)"),
    paid_end_date: str | None = Query(None, description="Date de paiement fin (YYYY-MM-DD inclus)"),
    quote_id: str | None = Query(None, description="Filtrer les factures liées à un devis"),
    invoice_kind: str | None = Query(None, description="standard|deposit|final"),
    document_type: str | None = Query(None, description="invoice|credit_note|all"),
    deposit_state: str | None = Query(None, description="unapplied|applied"),
    vat_correction: bool = Query(False, description="Documents à vérifier pour le pilotage TVA"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    return invoice_query_service.list_invoices(
        response,
        request,
        status=status,
        customer_id=customer_id,
        period=period,
        month=month,
        year=year,
        q=q,
        start_date=start_date,
        end_date=end_date,
        min_total_ht=min_total_ht,
        max_total_ht=max_total_ht,
        paid_start_date=paid_start_date,
        paid_end_date=paid_end_date,
        quote_id=quote_id,
        invoice_kind=invoice_kind,
        document_type=document_type,
        deposit_state=deposit_state,
        vat_correction=vat_correction,
        limit=limit,
        offset=offset,
        db=db,
        tenant_id=user.tenant_id,
    )


@router.delete("/{invoice_id}")
def delete_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Facture introuvable.")
    if (
        inv.status != "draft"
        or inv.issued_at
        or inv.sent_at
        or inv.paid_at
        or inv.number
        or inv.public_enabled
        or inv.pdf_key
        or inv.xml_key
        or inv.facturx_key
    ):
        raise HTTPException(
            409,
            detail={
                "code": "invoice_delete_only_draft",
                "message": "Seules les factures brouillons non émises peuvent être supprimées.",
            },
        )
    if inv.quote_id and inv.invoice_kind != "deposit":
        raise HTTPException(
            409,
            detail={
                "code": "invoice_delete_linked_quote_draft",
                "message": "Cette facture brouillon est liée à un devis. Annulez la conversion plutôt que de la supprimer.",
            },
        )

    attachment_keys = [att.storage_key for att in (inv.attachments or []) if getattr(att, "storage_key", None)]
    safe_log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="deleted",
        object_type="invoice",
        object_id=inv.id,
        metadata={"number": inv.number, "status": inv.status, "attachment_count": len(attachment_keys)},
    )
    db.delete(inv)
    db.commit()
    for storage_key in attachment_keys:
        try:
            delete_object(storage_key)
        except Exception:
            logger.warning(
                "invoice_attachment_delete_failed",
                extra={"invoice_id": invoice_id, "storage_key": storage_key},
            )
    return {"ok": True, "deleted": 1}


@router.get("/compliance-reports", response_model=list[ComplianceReportArchiveItem])
def list_compliance_reports(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    ensure_product_feature(db.get(Tenant, user.tenant_id), "einvoicing_enabled")
    q = (
        db.query(Invoice)
        .filter(Invoice.tenant_id == user.tenant_id)
        .order_by(Invoice.issue_date.desc())
        .offset(offset)
        .limit(limit)
    )
    invoices = q.all()
    if not invoices:
        return []
    customers = {c.id: c.name for c in db.query(Customer).filter(Customer.tenant_id == user.tenant_id)}
    invoice_ids = [inv.id for inv in invoices]
    latest_tx_by_invoice: dict[str, EInvoicingTransmission] = {}
    transmissions = (
        db.query(EInvoicingTransmission)
        .filter(EInvoicingTransmission.invoice_id.in_(invoice_ids))
        .order_by(
            EInvoicingTransmission.invoice_id.asc(),
            EInvoicingTransmission.updated_at.desc(),
            EInvoicingTransmission.created_at.desc(),
        )
        .all()
    )
    for tx in transmissions:
        if tx.invoice_id not in latest_tx_by_invoice:
            latest_tx_by_invoice[tx.invoice_id] = tx

    items: list[ComplianceReportArchiveItem] = []
    for inv in invoices:
        report_key = invoice_artifact_key(inv.id, COMPLIANCE_REPORT_JSON_KIND)
        pdf_key = invoice_artifact_key(inv.id, COMPLIANCE_REPORT_PDF_KIND)
        json_available = head_object(report_key) is not None
        pdf_available = head_object(pdf_key) is not None
        report_status = None
        report_generated_at = None
        report_version = None
        transmission_status = None
        transmission_channel = None
        transmission_updated_at = None
        if json_available:
            raw = get_object_bytes(report_key)
            if raw:
                try:
                    payload = json.loads(raw)
                    summary = payload.get("summary") or {}
                    transmission = payload.get("transmission") or {}
                    report_status = summary.get("status")
                    report_generated_at = payload.get("generated_at")
                    report_version = payload.get("schema_version") or payload.get("version")
                    transmission_status = transmission.get("status")
                    transmission_channel = transmission.get("channel")
                    transmission_updated_at = transmission.get("updated_at")
                except Exception:
                    report_status = None
        if not transmission_status:
            latest_tx = latest_tx_by_invoice.get(inv.id)
            if latest_tx:
                transmission_status = latest_tx.status
                transmission_channel = latest_tx.channel
                transmission_updated_at = latest_tx.updated_at.isoformat() if latest_tx.updated_at else None
        items.append(
            ComplianceReportArchiveItem(
                invoice_id=inv.id,
                invoice_number=inv.number,
                invoice_issue_date=inv.issue_date,
                invoice_status=inv.status,
                customer_name=customers.get(inv.customer_id),
                report_status=report_status,
                report_generated_at=report_generated_at,
                report_version=report_version,
                json_available=json_available,
                pdf_available=pdf_available,
                transmission_status=transmission_status,
                transmission_channel=transmission_channel,
                transmission_updated_at=transmission_updated_at,
            )
        )
    return items


@router.get("/metrics")
def metrics_endpoint(
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = _utcnow()
    tenant = db.get(Tenant, user.tenant_id)
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    start_month = datetime(now.year, now.month, 1)
    next_month = (start_month + timedelta(days=32)).replace(day=1)
    period_start, period_end = _query_date_bounds(start_date, end_date)
    has_period = period_start is not None or period_end is not None

    invoice_filters = [Invoice.tenant_id == user.tenant_id]
    if has_period:
        if period_start is not None:
            invoice_filters.append(Invoice.issue_date >= period_start)
        if period_end is not None:
            invoice_filters.append(Invoice.issue_date < period_end)

    status_rows = (
        db.query(Invoice.status, func.count(Invoice.id)).filter(*invoice_filters).group_by(Invoice.status).all()
    )
    status_counts = {str(status or "unknown"): int(count or 0) for status, count in status_rows}
    total_count = sum(status_counts.values())
    total_ttc = db.query(func.coalesce(func.sum(Invoice.total_inc_vat), 0)).filter(*invoice_filters).scalar() or 0
    draft_count = status_counts.get("draft", 0)
    issued_count = status_counts.get("issued", 0)
    sent_count = status_counts.get("sent", 0)
    partial_count = status_counts.get("partial", 0)
    paid_count = status_counts.get("paid", 0)
    canceled_count = status_counts.get("canceled", 0)
    pending_candidates = (
        db.query(Invoice).filter(*invoice_filters).filter(Invoice.status.in_(["issued", "sent", "partial"])).all()
    )
    pending_count = (
        sum(1 for inv in pending_candidates if not _is_overdue(inv, db, now))
        if payments_enabled
        else len(pending_candidates)
    )
    invoiced_filters = list(invoice_filters)
    paid_filters = [Invoice.tenant_id == user.tenant_id]
    if has_period:
        if period_start is not None:
            paid_filters.append(Payment.date >= period_start)
        if period_end is not None:
            paid_filters.append(Payment.date < period_end)
    else:
        invoiced_filters.extend([Invoice.issue_date >= start_month, Invoice.issue_date < next_month])
        paid_filters.extend([Payment.date >= start_month, Payment.date < next_month])
    invoiced_month = db.query(func.coalesce(func.sum(Invoice.total_inc_vat), 0)).filter(*invoiced_filters).scalar() or 0
    paid_month = 0
    if payments_enabled:
        paid_month = (
            db.query(func.coalesce(func.sum(Payment.amount), 0))
            .join(Invoice, Payment.invoice_id == Invoice.id)
            .filter(*paid_filters)
            .scalar()
            or 0
        )
    overdue_filters = [
        Invoice.tenant_id == user.tenant_id,
        Invoice.status.notin_(["paid", "canceled"]),
        (Invoice.due_date.is_(None)) | (Invoice.due_date < now),
    ]
    if has_period:
        if period_start is not None:
            overdue_filters.append(Invoice.issue_date >= period_start)
        if period_end is not None:
            overdue_filters.append(Invoice.issue_date < period_end)
    overdue_candidates = db.query(Invoice).filter(*overdue_filters)
    overdue_amount = 0.0
    overdue_count = 0
    if payments_enabled:
        for inv in overdue_candidates:
            if _is_overdue(inv, db, now):
                overdue_count += 1
                overdue_amount += float(_outstanding(db, inv))
    return {
        "total_count": total_count,
        "draft_count": draft_count,
        "issued_count": issued_count,
        "sent_count": sent_count,
        "partial_count": partial_count if payments_enabled else 0,
        "total_ttc": total_ttc,
        "paid_count": paid_count if payments_enabled else 0,
        "canceled_count": canceled_count,
        "pending_count": pending_count if payments_enabled else 0,
        "invoiced_month": invoiced_month,
        "paid_month": paid_month,
        "invoiced_period": invoiced_month,
        "paid_period": paid_month,
        "period_start": start_date.isoformat() if start_date else None,
        "period_end": end_date.isoformat() if end_date else None,
        "overdue_amount": overdue_amount,
        "overdue_count": overdue_count,
    }


def _invalid_export_filter(field: str, message: str) -> None:
    raise HTTPException(
        status_code=422,
        detail={
            "code": "invalid_export_filter",
            "field": field,
            "message": message,
        },
    )


def _parse_export_bound(raw_date: str | None, *, field: str, end: bool = False) -> datetime | None:
    if not raw_date:
        return None
    cleaned = raw_date.strip()
    if not cleaned:
        return None
    try:
        value = datetime.fromisoformat(cleaned)
    except Exception:
        _invalid_export_filter(field, "Date invalide.")
    if end and len(cleaned) <= 10:
        return value + timedelta(days=1)
    return value


def _parse_export_decimal(raw_amount: str | None, *, field: str) -> Decimal | None:
    if not raw_amount:
        return None
    cleaned = raw_amount.strip().replace(" ", "").replace(",", ".")
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except Exception:
        _invalid_export_filter(field, "Montant invalide.")


def _normalize_export_invoice_ids(invoice_ids: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for item in invoice_ids or []:
        for part in str(item or "").split(","):
            cleaned = part.strip()
            if cleaned and cleaned not in normalized:
                normalized.append(cleaned)
    return normalized


def _invoice_export_query(
    db: Session,
    *,
    tenant_id: str,
    invoice_ids: list[str] | None = None,
    q: str | None = None,
    customer_id: str | None = None,
    status: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    min_total_ht: str | None = None,
    max_total_ht: str | None = None,
    paid_start_date: str | None = None,
    paid_end_date: str | None = None,
    vat_correction: bool = False,
    include_drafts: bool = True,
):
    query = db.query(Invoice).filter(Invoice.tenant_id == tenant_id)
    selected_ids = _normalize_export_invoice_ids(invoice_ids)
    if selected_ids:
        query = query.filter(Invoice.id.in_(selected_ids))
    if not include_drafts:
        query = query.filter(Invoice.status.notin_(["draft", "canceled"]))
    requested_status = (status or "").strip().lower()
    if requested_status and requested_status != "all":
        if requested_status == "pending":
            query = query.filter(Invoice.status.in_(["issued", "sent", "partial"]))
        elif requested_status == "overdue":
            query = query.filter(Invoice.status.notin_(["paid", "canceled"]))
            query = query.filter(or_(Invoice.due_date.is_(None), Invoice.due_date < _utcnow()))
        else:
            query = query.filter(Invoice.status == requested_status)
    if customer_id:
        query = query.filter(Invoice.customer_id == customer_id)
    start = _parse_export_bound(start_date, field="start_date")
    end = _parse_export_bound(end_date, field="end_date", end=True)
    if start:
        query = query.filter(Invoice.issue_date >= start)
    if end:
        query = query.filter(Invoice.issue_date < end)
    if start and end and start >= end:
        query = query.filter(False)
    min_ht = _parse_export_decimal(min_total_ht, field="min_total_ht")
    max_ht = _parse_export_decimal(max_total_ht, field="max_total_ht")
    if min_ht is not None:
        query = query.filter(Invoice.total_ex_vat >= min_ht)
    if max_ht is not None:
        query = query.filter(Invoice.total_ex_vat <= max_ht)
    if min_ht is not None and max_ht is not None and min_ht > max_ht:
        query = query.filter(False)
    if vat_correction:
        currency = func.upper(func.coalesce(Invoice.currency, "EUR"))
        total_ht = func.coalesce(Invoice.total_ex_vat, 0)
        total_vat = func.coalesce(Invoice.total_vat, 0)
        query = query.filter(
            or_(
                Invoice.type == "credit_note",
                currency != "EUR",
                and_(Invoice.status.notin_(["draft", "canceled"]), total_ht > 0, total_vat <= 0),
            )
        )
    paid_start = _parse_export_bound(paid_start_date, field="paid_start_date")
    paid_end = _parse_export_bound(paid_end_date, field="paid_end_date", end=True)
    if paid_start or paid_end:
        payment_query = (
            db.query(Payment.invoice_id)
            .join(Invoice, Payment.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == tenant_id)
        )
        if paid_start:
            payment_query = payment_query.filter(Payment.date >= paid_start)
        if paid_end:
            payment_query = payment_query.filter(Payment.date < paid_end)
        if paid_start and paid_end and paid_start >= paid_end:
            query = query.filter(False)
        else:
            query = query.filter(Invoice.id.in_(payment_query))
    search = (q or "").strip()
    if search:
        like = f"%{search}%"
        query = query.join(Customer, Customer.id == Invoice.customer_id).filter(
            or_(
                Invoice.number.ilike(like),
                Invoice.purchase_order_number.ilike(like),
                Customer.name.ilike(like),
            )
        )
    return query


def _ensure_accounting_period_exportable(
    db: Session,
    *,
    user: AuthUser,
    tenant_id: str,
    start_date: str | None,
    end_date: str | None,
    customer_id: str | None,
    force_export: bool,
) -> None:
    if force_export:
        role = (user.role or "").lower()
        if not (user.is_admin or role in {"owner", "admin"}):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "accounting_lock_override_forbidden",
                    "message": "Seul un administrateur peut forcer une période remise au cabinet.",
                },
            )
        return
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=tenant_id,
        period_start=start_date,
        period_end=end_date,
        customer_id=customer_id,
    )
    if lock:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "accounting_period_locked",
                "message": (
                    "Cette période a déjà été marquée remise au cabinet. "
                    "Déverrouillez l'export dans Paramètres > Exports avant de régénérer un fichier."
                ),
                "lock": accounting_period_lock_payload(lock),
            },
        )


def _ensure_invoice_accounting_period_unlocked(
    db: Session,
    inv: Invoice,
    *,
    action: str,
) -> None:
    period_date = inv.issue_date or inv.created_at or inv.due_date
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=inv.tenant_id,
        period_start=period_date,
        period_end=period_date,
        customer_id=inv.customer_id,
    )
    if lock:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "accounting_period_locked",
                "message": (
                    "Ce document appartient à une période déjà remise au cabinet. "
                    "Utilisez une correction dédiée ou un avoir au lieu de modifier le document."
                ),
                "action": action,
                "lock": accounting_period_lock_payload(lock),
            },
        )


def _ensure_invoice_financial_movement_period_unlocked(
    db: Session,
    inv: Invoice,
    *,
    movement_date: datetime | date | None,
    action: str,
) -> None:
    if not movement_date:
        return
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=inv.tenant_id,
        period_start=movement_date,
        period_end=movement_date,
        customer_id=inv.customer_id,
    )
    if lock:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "accounting_period_locked",
                "message": (
                    "Ce règlement appartient à une période déjà remise au cabinet. "
                    "Déverrouillez l'export comptable ou utilisez une correction dédiée."
                ),
                "action": action,
                "lock": accounting_period_lock_payload(lock),
            },
        )


def _validate_invoice_export_customer(db: Session, *, tenant_id: str, customer_id: str | None) -> None:
    if not customer_id:
        return
    exists = db.query(Customer.id).filter(Customer.id == customer_id, Customer.tenant_id == tenant_id).first()
    if not exists:
        raise HTTPException(
            status_code=404,
            detail={"code": "customer_not_found", "message": "Client introuvable dans cet espace."},
        )


def _ensure_sync_export_limit(query, *, label: str, limit: int = MAX_SYNC_EXPORT_ROWS) -> None:
    total = query.count()
    if total > limit:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "sync_export_too_large",
                "message": (
                    f"Export trop volumineux ({total} {label}). "
                    f"Limitez la période ou le filtre à {limit} lignes maximum."
                ),
                "total": total,
                "limit": limit,
            },
        )


_PAYMENT_EXPORT_STATUSES = {"pending", "paid", "partial", "overdue"}


def _ensure_payment_export_filters_allowed(
    tenant: Tenant,
    *,
    status: str | None,
    paid_start_date: str | None,
    paid_end_date: str | None,
) -> bool:
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    if payments_enabled:
        return True
    requested_status = (status or "").strip().lower()
    payment_filter_requested = requested_status in _PAYMENT_EXPORT_STATUSES or bool(
        (paid_start_date or "").strip() or (paid_end_date or "").strip()
    )
    if payment_filter_requested:
        ensure_product_feature(tenant, "payments_enabled")
    return False


def _invoice_status_for_export(invoice: Invoice, *, payments_enabled: bool) -> str | None:
    status = (invoice.status or "").strip().lower()
    if payments_enabled or status not in {"paid", "partial", "overdue"}:
        return invoice.status
    return "sent" if invoice.sent_at else "issued"


def _fec_account_needs_completion(value: object) -> bool:
    raw = str(value or "").strip()
    compact = re.sub(r"[^0-9A-Z]", "", raw.upper())
    return not raw or compact.startswith("471") or compact in {"MANUAL", "CUSTOM"}


@router.get("/export.csv")
def export_csv(
    start_date: str | None = None,
    end_date: str | None = None,
    min_total_ht: str | None = None,
    max_total_ht: str | None = None,
    paid_start_date: str | None = None,
    paid_end_date: str | None = None,
    invoice_ids: list[str] | None = Query(None),
    q: str | None = Query(None, description="Recherche facture (numéro, commande, client)"),
    customer_id: str | None = None,
    status: str | None = Query(None, description="draft|issued|sent|pending|paid|overdue|canceled"),
    vat_correction: bool = Query(False, description="Limiter aux factures à vérifier pour la TVA"),
    force_export: bool = Query(False, description="Forcer l'export malgré une période déjà remise"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")
    payments_enabled = _ensure_payment_export_filters_allowed(
        tenant,
        status=status,
        paid_start_date=paid_start_date,
        paid_end_date=paid_end_date,
    )
    include_drafts = False
    _validate_invoice_export_customer(db, tenant_id=user.tenant_id, customer_id=customer_id)
    query = _invoice_export_query(
        db,
        tenant_id=user.tenant_id,
        invoice_ids=invoice_ids,
        q=q,
        customer_id=customer_id,
        status=status,
        start_date=start_date,
        end_date=end_date,
        min_total_ht=min_total_ht,
        max_total_ht=max_total_ht,
        paid_start_date=paid_start_date,
        paid_end_date=paid_end_date,
        vat_correction=vat_correction,
        include_drafts=include_drafts,
    )
    _ensure_sync_export_limit(query, label="factures")
    rows = query.order_by(Invoice.issue_date.desc()).all()
    _ensure_accounting_period_exportable(
        db,
        user=user,
        tenant_id=user.tenant_id,
        start_date=start_date,
        end_date=end_date,
        customer_id=customer_id,
        force_export=force_export,
    )
    customers = {customer.id: customer for customer in db.query(Customer).filter(Customer.tenant_id == user.tenant_id)}
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(
        [
            "number",
            "date",
            "due_date",
            "status",
            "type",
            "customer_name",
            "total_ht",
            "total_tva",
            "total_ttc",
            "currency",
            "payment_terms",
            "ventilation_comptable",
        ]
    )
    for f in rows:
        cust = customers.get(f.customer_id)
        accounting_breakdown = []
        for line in f.lines or []:
            account = (line.accounting_account or "").strip()
            if account and Decimal(str(line.line_total or 0)):
                accounting_breakdown.append(f"{account}:{Decimal(str(line.line_total or 0)):.2f}")
        w.writerow(
            [
                _sanitize_csv_cell(f.number),
                f.issue_date.isoformat() if f.issue_date else "",
                f.due_date.isoformat() if f.due_date else "",
                _sanitize_csv_cell(_invoice_status_for_export(f, payments_enabled=payments_enabled)),
                _sanitize_csv_cell(f.type),
                _sanitize_csv_cell(cust.name if cust else f.customer_id),
                f.total_ex_vat,
                f.total_vat,
                f.total_inc_vat,
                _sanitize_csv_cell(f.currency),
                _sanitize_csv_cell(f.payment_terms or ""),
                _sanitize_csv_cell(" | ".join(accounting_breakdown)),
            ]
        )
    content = "\ufeff" + buf.getvalue()
    metrics.inc_invoice_export()
    export_filters = {
        "format": "csv",
        "record_count": len(rows),
        "start_date": start_date,
        "end_date": end_date,
        "min_total_ht": min_total_ht,
        "max_total_ht": max_total_ht,
        "paid_start_date": paid_start_date,
        "paid_end_date": paid_end_date,
        "invoice_ids": _normalize_export_invoice_ids(invoice_ids),
        "q": q,
        "customer_id": customer_id,
        "status": status,
        "vat_correction": vat_correction,
        "include_drafts": include_drafts,
    }
    record_accounting_export(
        db,
        tenant_id=user.tenant_id,
        export_format="csv",
        created_by=None if user.is_api_key else user.id,
        period_start=start_date,
        period_end=end_date,
        customer_id=customer_id,
        record_count=len(rows),
        filters=export_filters,
    )
    _safe_log_export_action(
        db,
        user,
        user.tenant_id,
        "export_csv",
        export_filters,
    )
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers=_export_attachment_headers("factures.csv"),
    )


@router.get("/export.fec")
def export_fec(
    start_date: str | None = None,
    end_date: str | None = None,
    min_total_ht: str | None = None,
    max_total_ht: str | None = None,
    paid_start_date: str | None = None,
    paid_end_date: str | None = None,
    invoice_ids: list[str] | None = Query(None),
    q: str | None = Query(None, description="Recherche facture (numéro, commande, client)"),
    customer_id: str | None = None,
    status: str | None = Query(None, description="issued|sent|pending|paid|overdue|partial"),
    vat_correction: bool = Query(False, description="Limiter aux factures à vérifier pour la TVA"),
    strict_quality: bool = Query(True, description="Bloquer le FEC si des comptes de vente restent à compléter"),
    force_export: bool = Query(False, description="Forcer l'export malgré une période déjà remise"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")
    _ensure_payment_export_filters_allowed(
        tenant,
        status=status,
        paid_start_date=paid_start_date,
        paid_end_date=paid_end_date,
    )
    _validate_invoice_export_customer(db, tenant_id=user.tenant_id, customer_id=customer_id)
    query = _invoice_export_query(
        db,
        tenant_id=user.tenant_id,
        invoice_ids=invoice_ids,
        q=q,
        customer_id=customer_id,
        status=status,
        start_date=start_date,
        end_date=end_date,
        min_total_ht=min_total_ht,
        max_total_ht=max_total_ht,
        paid_start_date=paid_start_date,
        paid_end_date=paid_end_date,
        vat_correction=vat_correction,
        include_drafts=False,
    )
    _ensure_sync_export_limit(query, label="factures")
    rows = query.order_by(Invoice.issue_date.asc()).all()
    _ensure_accounting_period_exportable(
        db,
        user=user,
        tenant_id=user.tenant_id,
        start_date=start_date,
        end_date=end_date,
        customer_id=customer_id,
        force_export=force_export,
    )
    customers = {c.id: c for c in db.query(Customer).filter(Customer.tenant_id == user.tenant_id)}
    journal_code = (getattr(tenant, "fec_journal_code", None) or settings.FEC_JOURNAL_CODE or "VE").strip() or "VE"
    journal_label = (
        getattr(tenant, "fec_journal_label", None) or settings.FEC_JOURNAL_LABEL or "Ventes"
    ).strip() or "Ventes"
    account_customer = (
        getattr(tenant, "fec_account_customer", None) or settings.FEC_ACCOUNT_CUSTOMER or "411"
    ).strip() or "411"
    account_revenue = (
        getattr(tenant, "fec_account_revenue", None) or settings.FEC_ACCOUNT_REVENUE or "706"
    ).strip() or "706"
    account_vat = (getattr(tenant, "fec_account_vat", None) or settings.FEC_ACCOUNT_VAT or "44571").strip() or "44571"

    unresolved_account_examples: list[str] = []
    if strict_quality:
        for inv in rows:
            for line in inv.lines or []:
                line_amount = Decimal(str(line.line_total or 0))
                if line_amount and _fec_account_needs_completion(line.accounting_account):
                    label = str(line.product_name or getattr(line, "description", None) or "ligne").strip()
                    unresolved_account_examples.append(f"{inv.number or inv.id} - {label}")
    if unresolved_account_examples:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "accounting_account_required",
                "message": "Complétez les comptes comptables des ventes avant de générer le FEC.",
                "examples": unresolved_account_examples[:5],
            },
        )

    buf = io.StringIO()
    w = csv.writer(buf, delimiter="|", lineterminator="\n")
    w.writerow(
        [
            "JournalCode",
            "JournalLib",
            "EcritureNum",
            "EcritureDate",
            "CompteNum",
            "CompteLib",
            "CompAuxNum",
            "CompAuxLib",
            "PieceRef",
            "PieceDate",
            "EcritureLib",
            "Debit",
            "Credit",
            "EcritureLet",
            "DateLet",
            "ValidDate",
            "MontantDevise",
            "Idevise",
        ]
    )

    def _fmt_date(value: datetime | None) -> str:
        if not value:
            return ""
        return value.strftime("%Y%m%d")

    def _split_amount(value: float | Decimal) -> tuple[str, str]:
        if value >= 0:
            return (f"{value:.2f}", "")
        return ("", f"{abs(value):.2f}")

    def _fec_text(value: object) -> str:
        return _sanitize_csv_cell(value)

    for inv in rows:
        cust = customers.get(inv.customer_id)
        issue_date = inv.issue_date
        piece_ref = inv.number or inv.id
        ecriture_num = piece_ref
        ecriture_date = _fmt_date(issue_date)
        piece_date = _fmt_date(issue_date)
        lib = f"{'Avoir' if inv.type == 'credit_note' else 'Facture'} {piece_ref}"
        amount_ht = float(inv.total_ex_vat or 0)
        amount_vat = float(inv.total_vat or 0)
        amount_ttc = float(inv.total_inc_vat or 0)
        currency = (inv.currency or "EUR").upper()
        comp_aux_num = (
            (getattr(cust, "siret", None) or getattr(cust, "siren", None) or (cust.id if cust else "")) if cust else ""
        )
        comp_aux_lib = cust.name if cust else ""

        debit, credit = _split_amount(amount_ttc)
        montant_devise = f"{abs(amount_ttc):.2f}" if currency != "EUR" else ""
        idevise = currency if currency != "EUR" else ""
        w.writerow(
            [
                _fec_text(journal_code),
                _fec_text(journal_label),
                _fec_text(ecriture_num),
                ecriture_date,
                _fec_text(account_customer),
                _fec_text(comp_aux_lib or "Client"),
                _fec_text(comp_aux_num),
                _fec_text(comp_aux_lib),
                _fec_text(piece_ref),
                piece_date,
                _fec_text(lib),
                debit,
                credit,
                "",
                "",
                "",
                montant_devise,
                idevise,
            ]
        )

        revenue_by_account: dict[str, Decimal] = {}
        for line in inv.lines or []:
            line_amount = Decimal(str(line.line_total or 0))
            if not line_amount:
                continue
            line_account = (line.accounting_account or account_revenue).strip() or account_revenue
            revenue_by_account[line_account] = revenue_by_account.get(line_account, Decimal("0")) + line_amount
        if not revenue_by_account and amount_ht:
            revenue_by_account[account_revenue] = Decimal(str(inv.total_ex_vat or 0))

        for revenue_account, revenue_amount in revenue_by_account.items():
            if not revenue_amount:
                continue
            rev_debit, rev_credit = _split_amount(-revenue_amount)
            rev_montant_devise = f"{abs(revenue_amount):.2f}" if currency != "EUR" else ""
            w.writerow(
                [
                    _fec_text(journal_code),
                    _fec_text(journal_label),
                    _fec_text(ecriture_num),
                    ecriture_date,
                    _fec_text(revenue_account),
                    _fec_text("Ventes"),
                    "",
                    "",
                    _fec_text(piece_ref),
                    piece_date,
                    _fec_text(lib),
                    rev_debit,
                    rev_credit,
                    "",
                    "",
                    "",
                    rev_montant_devise,
                    idevise,
                ]
            )

        if amount_vat:
            vat_debit, vat_credit = _split_amount(-amount_vat)
            vat_montant_devise = f"{abs(amount_vat):.2f}" if currency != "EUR" else ""
            w.writerow(
                [
                    _fec_text(journal_code),
                    _fec_text(journal_label),
                    _fec_text(ecriture_num),
                    ecriture_date,
                    _fec_text(account_vat),
                    _fec_text("TVA collectee"),
                    "",
                    "",
                    _fec_text(piece_ref),
                    piece_date,
                    _fec_text(lib),
                    vat_debit,
                    vat_credit,
                    "",
                    "",
                    "",
                    vat_montant_devise,
                    idevise,
                ]
            )
    metrics.inc_invoice_export()
    export_filters = {
        "format": "fec",
        "record_count": len(rows),
        "start_date": start_date,
        "end_date": end_date,
        "min_total_ht": min_total_ht,
        "max_total_ht": max_total_ht,
        "paid_start_date": paid_start_date,
        "paid_end_date": paid_end_date,
        "invoice_ids": _normalize_export_invoice_ids(invoice_ids),
        "q": q,
        "customer_id": customer_id,
        "status": status,
        "vat_correction": vat_correction,
        "strict_quality": strict_quality,
    }
    record_accounting_export(
        db,
        tenant_id=user.tenant_id,
        export_format="fec",
        created_by=None if user.is_api_key else user.id,
        period_start=start_date,
        period_end=end_date,
        customer_id=customer_id,
        record_count=len(rows),
        filters=export_filters,
    )
    _safe_log_export_action(
        db,
        user,
        user.tenant_id,
        "export_fec",
        export_filters,
    )
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers=_export_attachment_headers("factures.fec"),
    )


@router.get("/export.edi.zip")
def export_edi_zip(
    format: str = Query("ubl", description="Format export (ubl|cii)"),
    start_date: str | None = None,
    end_date: str | None = None,
    min_total_ht: str | None = None,
    max_total_ht: str | None = None,
    paid_start_date: str | None = None,
    paid_end_date: str | None = None,
    invoice_ids: list[str] | None = Query(None),
    q: str | None = Query(None, description="Recherche facture (numéro, commande, client)"),
    customer_id: str | None = None,
    status: str | None = Query(None, description="issued|sent|paid|overdue|partial"),
    vat_correction: bool = Query(False, description="Limiter aux factures à vérifier pour la TVA"),
    force_export: bool = Query(False, description="Forcer l'export malgré une période déjà remise"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
    __: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    fmt = (format or "ubl").strip().lower()
    if fmt not in {"ubl", "cii"}:
        raise HTTPException(400, "Format d’export invalide. Choisissez UBL ou CII.")
    if fmt == "ubl" and not _ubl_export_enabled():
        raise HTTPException(
            status_code=403,
            detail={"code": "ubl_export_disabled", "message": "Export UBL désactivé."},
        )
    _validate_invoice_export_customer(db, tenant_id=user.tenant_id, customer_id=customer_id)
    query = _invoice_export_query(
        db,
        tenant_id=user.tenant_id,
        invoice_ids=invoice_ids,
        q=q,
        customer_id=customer_id,
        status=status,
        start_date=start_date,
        end_date=end_date,
        min_total_ht=min_total_ht,
        max_total_ht=max_total_ht,
        paid_start_date=paid_start_date,
        paid_end_date=paid_end_date,
        vat_correction=vat_correction,
        include_drafts=False,
    )
    _ensure_sync_export_limit(query, label="factures EDI")
    rows = query.order_by(Invoice.issue_date.asc()).all()
    _ensure_accounting_period_exportable(
        db,
        user=user,
        tenant_id=user.tenant_id,
        start_date=start_date,
        end_date=end_date,
        customer_id=customer_id,
        force_export=force_export,
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for inv in rows:
            if _is_invoice_immutable(inv):
                artifact = ensure_invoice_artifact(db, inv, fmt)
                _ensure_invoice_artifact_integrity(db, inv, artifact, fmt)
                xml_bytes = _load_invoice_artifact(inv, fmt)
                if not xml_bytes:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "invoice_artifact_missing",
                            "message": "Le fichier électronique structuré de la facture émise est manquant.",
                        },
                    )
            else:
                ctx = _ctx(db, inv)
                if fmt == "ubl":
                    xml_bytes = ubl_document_xml(ctx)
                    ubl_errors = validate_ubl_xml(xml_bytes)
                    if ubl_errors:
                        is_unavailable = any("indisponible" in err.lower() for err in ubl_errors)
                        raise HTTPException(
                            status_code=503 if is_unavailable else 422,
                            detail={
                                "code": "ubl_validation_unavailable" if is_unavailable else "ubl_en16931_invalid",
                                "message": (
                                    "Le contrôle de conformité UBL EN 16931 est temporairement indisponible."
                                    if is_unavailable
                                    else "Le document structuré UBL contient des informations à corriger avant l’export."
                                ),
                                "invoice_id": inv.id,
                                "errors": ubl_errors,
                            },
                        )
                else:
                    tenant = db.get(Tenant, inv.tenant_id)
                    customer = db.get(Customer, inv.customer_id)
                    if not tenant or not customer:
                        raise HTTPException(404, "Not found")
                    fr_missing_fields = validate_fr_b2b_invoice_ready(inv, customer, tenant)
                    if fr_missing_fields:
                        fr_checks = validate_fr_einvoicing_fields(inv, tenant, customer)
                        raise HTTPException(
                            status_code=422,
                            detail={
                                "code": "fr_einvoicing_missing_fields",
                                "message": "Informations manquantes pour l'export CII.",
                                "invoice_id": inv.id,
                                "fields": fr_missing_fields,
                                "errors": fr_checks,
                            },
                        )
                    xml_bytes = cii_invoice_xml(ctx)
            filename = _safe_filename(fmt, inv.number, "xml")
            zf.writestr(filename, xml_bytes)
    buffer.seek(0)
    label = f"export-edi-{fmt}.zip"
    metrics.inc_invoice_export()
    export_filters = {
        "format": fmt,
        "record_count": len(rows),
        "start_date": start_date,
        "end_date": end_date,
        "invoice_ids": _normalize_export_invoice_ids(invoice_ids),
        "q": q,
        "customer_id": customer_id,
        "status": status,
        "vat_correction": vat_correction,
    }
    record_accounting_export(
        db,
        tenant_id=user.tenant_id,
        export_format=f"edi_{fmt}",
        created_by=None if user.is_api_key else user.id,
        period_start=start_date,
        period_end=end_date,
        customer_id=customer_id,
        record_count=len(rows),
        filters=export_filters,
    )
    _safe_log_export_action(
        db,
        user,
        user.tenant_id,
        "export_edi",
        export_filters,
    )
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers=_export_attachment_headers(label),
    )


@router.get("/{invoice_id}/readiness")
def get_invoice_readiness(
    invoice_id: str,
    intent: str = Query("issue", description="save|send|issue|email|share|followup|credit_note"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    tenant = db.get(Tenant, user.tenant_id)
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    if intent == "followup" and not payments_enabled:
        ensure_product_feature(tenant, "payments_enabled")
    payload = invoice_readiness(db, user.tenant_id, invoice_id, intent)
    next_action = payload.get("next_action") if isinstance(payload, dict) else None
    if not payments_enabled and isinstance(next_action, dict):
        action_key = str(next_action.get("key") or "")
        if action_key in {"none_paid", "followup", "record_payment"}:
            payload["next_action"] = {
                "key": "view_document",
                "label": "Voir la facture",
                "description": "Le document reste disponible dans la liste des factures.",
                "danger_level": "none",
            }
    return payload


@router.get("/{invoice_id}", response_model=InvoiceDetailOut)
def get_invoice(invoice_id: str, db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    inv = _invoice_for_read(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, user.tenant_id)
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    structured_artifacts_enabled = is_product_feature_enabled(tenant, "einvoicing_enabled")
    # Important: allow viewing draft/canceled invoices in backoffice.
    # Blocking on (draft/canceled) or missing number breaks DX and prevents users
    # from editing/issuing documents.
    payments = []
    if payments_enabled:
        payments = db.query(Payment).filter(Payment.invoice_id == inv.id).order_by(Payment.date.desc()).all()
        setattr(inv, "payments", payments)
    else:
        # A downgrade must not expose retained Pro payment/refund rows. Mark
        # both relationships as loaded-empty without recording ORM deletions.
        set_committed_value(inv, "payments", [])
        set_committed_value(inv, "refunds", [])
    cust = db.get(Customer, inv.customer_id)
    if cust:
        setattr(inv, "customer_name", cust.name)
    balance_due_decimal = Decimal("0")
    notes = []
    credit_total = 0.0
    refunds = []
    refunds_total = Decimal("0")
    refund_balance = Decimal("0")

    if inv.type == "invoice":
        notes = (
            db.query(Invoice)
            .filter(
                Invoice.related_invoice_id == inv.id,
                Invoice.tenant_id == user.tenant_id,
                Invoice.type == "credit_note",
            )
            .order_by(Invoice.issue_date.desc())
            .all()
        )
        credit_breakdown = _credit_notes_breakdown(notes)
        credit_total = float(credit_breakdown["issued"])
        setattr(inv, "credit_notes", notes)
        setattr(inv, "credit_notes_total", credit_total)
        setattr(inv, "credit_notes_total_issued", float(credit_breakdown["issued"]))
        setattr(inv, "credit_notes_total_draft", float(credit_breakdown["draft"]))
        setattr(inv, "credit_notes_total_canceled", float(credit_breakdown["canceled"]))
        setattr(inv, "credit_notes_total_all", float(credit_breakdown["all"]))

        balance_due_decimal = _outstanding(db, inv) if payments_enabled else Decimal("0")
        balance = float(balance_due_decimal)
        setattr(inv, "balance_due", balance)
    else:
        # credit_note
        refunds = []
        refunds_total = Decimal("0")
        refund_balance = Decimal("0")
        if payments_enabled:
            refunds = (
                db.query(CreditNoteRefund)
                .filter(CreditNoteRefund.invoice_id == inv.id)
                .order_by(CreditNoteRefund.date.desc())
                .all()
            )
            refunds_total = sum((Decimal(str(r.amount or 0)) for r in refunds), Decimal("0"))
            total_credit = abs(Decimal(str(inv.total_inc_vat or 0)))
            refund_balance = total_credit - refunds_total
            if refund_balance < Decimal("0"):
                refund_balance = Decimal("0")
        setattr(inv, "refunds", refunds)
        setattr(inv, "refunds_total", float(refunds_total))
        setattr(inv, "refund_balance", float(refund_balance))
        # balance_due negatif = reste à rembourser (utilisé par l'UI)
        setattr(inv, "balance_due", float(-refund_balance))

        related_invoice = None
        if inv.related_invoice_id:
            related_invoice = (
                db.query(Invoice)
                .filter(
                    Invoice.id == inv.related_invoice_id,
                    Invoice.tenant_id == user.tenant_id,
                    Invoice.type == "invoice",
                )
                .first()
            )
        setattr(inv, "related_invoice_number", related_invoice.number if related_invoice else None)
        setattr(inv, "related_invoice_issue_date", related_invoice.issue_date if related_invoice else None)
        setattr(
            inv,
            "related_invoice_total_inc_vat",
            float(related_invoice.total_inc_vat or 0) if related_invoice else None,
        )
        setattr(inv, "credit_notes", [])
        setattr(inv, "credit_notes_total", 0.0)
        setattr(inv, "credit_notes_total_issued", 0.0)
        setattr(inv, "credit_notes_total_draft", 0.0)
        setattr(inv, "credit_notes_total_canceled", 0.0)
        setattr(inv, "credit_notes_total_all", 0.0)
    events_query = db.query(EmailEvent).filter(EmailEvent.invoice_id == inv.id)
    if not payments_enabled:
        events_query = events_query.filter(EmailEvent.type != "invoice_followup")
    events = events_query.order_by(EmailEvent.created_at.desc()).limit(5).all()
    setattr(inv, "email_events", events)
    detail_lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == inv.id).order_by(InvoiceLine.id.asc()).all()
    setattr(inv, "lines", detail_lines)
    setattr(inv, "accounting_readiness", invoice_accounting_readiness(inv, lines=detail_lines, payments=payments))
    computed_overdue = (
        payments_enabled and inv.type == "invoice" and inv.status not in {"draft", "canceled"} and _is_overdue(inv, db)
    )
    data = InvoiceDetailOut.model_validate(inv, from_attributes=True).model_dump()
    if not payments_enabled:
        data.update(
            {
                "status": "sent"
                if str(inv.status or "").lower() in {"paid", "partial", "overdue"} and inv.sent_at
                else "issued"
                if str(inv.status or "").lower() in {"paid", "partial", "overdue"}
                else data.get("status"),
                "paid_at": None,
                "reminder_count": 0,
                "last_reminder_at": None,
                "payments": [],
                "refunds": [],
                "refunds_total": 0.0,
                "refund_balance": 0.0,
                "balance_due": 0.0,
            }
        )
    if not structured_artifacts_enabled:
        data.update(
            {
                "pdfa3_status": None,
                "pdfa3_report": None,
                "facturx_spec_version": None,
                "facturx_profile": None,
                "has_facturx": False,
            }
        )
    else:
        data["has_facturx"] = has_stored_facturx_artifact(db, inv)
        data["pdfa3_report"] = sanitize_public_pdfa_report(inv.pdfa3_report, inv.pdfa3_status)
    card_payment_enabled, card_payment_reason = _invoice_card_payment_state(
        tenant=tenant,
        invoice=inv,
        balance_due=data.get("balance_due"),
    )
    data["card_payment_enabled"] = card_payment_enabled
    data["card_payment_reason"] = card_payment_reason
    detail_template_options = _merge_template_options(
        DEFAULT_INVOICE_TEMPLATE_OPTIONS, data.get("template_options") or {}
    )
    data["note"] = visible_document_note(
        data.get("note"),
        detail_template_options.get("document_title"),
        detail_template_options.get("legal_mentions_text"),
    )
    if computed_overdue:
        data["status"] = "overdue"
    if not data.get("due_date"):
        data["due_date"] = _compute_due_date_no_write(inv)
    if payments_enabled:
        data.update(
            _invoice_followup_plan(
                db,
                inv=inv,
                tenant=tenant,
                customer=cust,
                balance_due=max(balance_due_decimal, Decimal("0")),
                now=_utcnow(),
            )
        )
    else:
        data.update(
            {
                "days_overdue": 0,
                "next_followup_at": None,
                "next_followup_offset": None,
                "followup_state": None,
                "followup_block_reason": None,
                "followup_schedule": [],
                "can_followup": False,
            }
        )
    return data


@router.post("", response_model=InvoiceOut)
def create_invoice(
    payload: InvoiceCreate,
    response: Response,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
    issue: bool = Query(False, description="Créer puis émettre dans la même opération."),
):
    _require_role_accountant(user)
    ensure_legal_acceptance(user, db)
    inv = _create_invoice_record(payload, response, db, tenant_id=user.tenant_id, actor=user)
    if not issue:
        return inv

    issue_result = invoice_issue_service.issue_invoice_job(inv.id, user.tenant_id, user.id)
    if not issue_result.get("ok"):
        _delete_invoice_created_for_failed_issue(db, inv.id, user.tenant_id)
        return _issue_sync_response(issue_result)

    db.expire_all()
    issued_invoice = db.get(Invoice, inv.id)
    if not issued_invoice or issued_invoice.tenant_id != user.tenant_id:
        raise HTTPException(
            500,
            detail={"code": "issue_state_missing", "message": "Facture émise introuvable."},
        )
    return issued_invoice


def _delete_invoice_created_for_failed_issue(db: Session, invoice_id: str, tenant_id: str) -> None:
    db.rollback()
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != tenant_id:
        return
    db.query(InvoiceArtifact).filter(
        InvoiceArtifact.invoice_id == invoice_id,
        InvoiceArtifact.tenant_id == tenant_id,
    ).delete(synchronize_session=False)
    db.query(Submission).filter(Submission.invoice_id == invoice_id).delete(synchronize_session=False)
    db.query(EInvoiceTransmission).filter(
        EInvoiceTransmission.invoice_id == invoice_id,
        EInvoiceTransmission.tenant_id == tenant_id,
    ).delete(synchronize_session=False)
    db.query(EmailEvent).filter(
        EmailEvent.invoice_id == invoice_id,
        EmailEvent.tenant_id == tenant_id,
    ).update({EmailEvent.invoice_id: None}, synchronize_session=False)
    db.delete(inv)
    db.commit()


def _create_invoice_record(
    payload: InvoiceCreate,
    response: Response,
    db: Session,
    *,
    tenant_id: str,
    actor: AuthUser | None,
    commit: bool = True,
):
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")
    _maybe_expire_trial(db, tenant)
    tenant_settings = db.get(TenantSettings, tenant.id)
    strict_compliance = _strict_compliance_enabled(tenant_settings)
    warnings: list[str] = []
    missing_profile: list[str] = []
    if not getattr(tenant, "siret", None):
        missing_profile.append("SIRET")
    related = None
    if payload.type == "credit_note":
        if not payload.related_invoice_id:
            raise HTTPException(400, "Un avoir doit référencer une facture d'origine.")
        related = _invoice_for_update(db, payload.related_invoice_id)
        if not related or related.tenant_id != tenant_id:
            raise HTTPException(404, "Facture d'origine introuvable pour créer un avoir.")
        _validate_credit_note_source(related)
        # Autoriser un avoir même si la facture est soldée (cas courant : remboursement / correction après paiement).
        # On empêche seulement de dépasser le montant total de la facture déjà crédité ou en brouillon.
        original_total = abs(Decimal(str(related.total_inc_vat or 0)))
        existing_credits = _credit_notes_total(db, related, include_drafts=True)
        if original_total > 0 and existing_credits >= (original_total - Decimal("0.01")):
            raise HTTPException(400, "Cette facture a déjà été intégralement créditée.")
    target_customer_id = related.customer_id if related else payload.customer_id
    customer = db.get(Customer, target_customer_id)
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(404, "Client introuvable.")
    if not payload.lines:
        raise HTTPException(400, "Ajoutez au moins une ligne de facturation.")
    _ensure_document_line_quota(payload.lines, "Facture")
    if not any(_line_is_item(line) for line in payload.lines):
        raise HTTPException(400, "Ajoutez au moins une ligne produit ou service.")
    _enforce_tenant_vat_franchise(tenant, payload.lines)
    _validate_global_discount_vat_breakdown(payload.lines)
    vat_has_positive_rate = any(to_decimal(getattr(line, "vat_rate", 0)) > 0 for line in payload.lines)
    if not tenant.vat_number:
        if vat_has_positive_rate:
            warnings.append("Numéro de TVA manquant : taux de TVA > 0 détecté (vérifiez votre régime).")
            if strict_compliance:
                raise HTTPException(
                    400,
                    "Numéro de TVA manquant : appliquez un taux de TVA à 0 ou renseignez un numéro de TVA.",
                )
        if not tenant.vat_exemption_notice:
            invalid_lines = [
                line
                for line in payload.lines
                if (to_decimal(getattr(line, "vat_rate", 0)) != 0)
                or (getattr(line, "vat_category", "S") == "S")
                or not getattr(line, "exemption_reason_code", None)
            ]
            if invalid_lines:
                warnings.append(
                    "TVA non applicable : ajoutez une mention d'exonération de TVA ou un code d'exonération par ligne."
                )
                if strict_compliance:
                    raise HTTPException(
                        400,
                        "TVA non applicable : ajoutez une mention d'exonération de TVA sur l'entreprise "
                        "ou indiquez un code d'exonération sur chaque ligne (TVA=0, catégorie non 'S').",
                    )
    if not (tenant.iban or "").strip():
        warnings.append("IBAN manquant : renseignez un moyen de paiement si nécessaire.")
    if missing_profile:
        missing_str = ", ".join(missing_profile)
        raise HTTPException(
            400,
            {
                "code": "profile_incomplete",
                "message": (
                    f"Profil entreprise incomplet ({missing_str}). "
                    "Complétez le profil entreprise avant de créer une facture."
                ),
            },
        )

    if warnings:
        response.headers["X-Invoice-Warnings"] = json.dumps(warnings, ensure_ascii=True, separators=(",", ":"))

    issue_date = _issue_date_datetime(payload.issue_date)
    payment_terms = sales_payment_terms(payload.payment_terms, customer)
    due_days = (
        max(0, int(payload.due_days))
        if payload.due_days is not None
        else due_days_from_terms(payment_terms, related.due_days if related else 30)
    )
    computed_due_date = _compute_due_date(issue_date, payment_terms, due_days)
    due_date_manual = _due_date_is_manual(payload.due_date, computed_due_date)
    due_date = payload.due_date if due_date_manual else computed_due_date
    template_key = _resolve_template_key(getattr(payload, "template_key", None))
    raw_template_options = getattr(payload, "template_options", None)
    raw_template_options_dict = raw_template_options if isinstance(raw_template_options, dict) else {}
    template_options = _merge_template_options(DEFAULT_INVOICE_TEMPLATE_OPTIONS, raw_template_options)
    template_options, _smart_template_fixes = apply_template_option_defaults(
        template_options,
        tenant=tenant,
        customer=customer,
        operation_nature=payload.operation_nature,
        prefer_customer_payment_method=not bool(raw_template_options_dict.get("payment_methods")),
    )
    invoice_kind = (
        "standard" if payload.type == "credit_note" else _invoice_kind_from_payload(payload, template_options)
    )
    quote_id = None if payload.type == "credit_note" else _quote_id_from_payload(payload, template_options)
    quote = _validate_quote_link(db, tenant_id, quote_id, customer.id, invoice_kind)
    if payload.deposit_invoice_ids and invoice_kind != "final":
        raise HTTPException(400, "Les acomptes déduits ne sont disponibles que sur une facture finale.")
    template_options["kind"] = invoice_kind
    if quote:
        template_options["source_quote_id"] = quote.id
    else:
        template_options.pop("source_quote_id", None)
        template_options.pop("quote_id", None)
    template_options["_chorus_service_code_explicit"] = "public_service_code" in payload.model_fields_set
    template_options["_chorus_commitment_explicit"] = "purchase_order_number" in payload.model_fields_set
    public_service_code = (
        payload.public_service_code
        if "public_service_code" in payload.model_fields_set
        else (customer.public_service_code or "").strip() or None
    )
    purchase_order_number = payload.purchase_order_number
    if "purchase_order_number" not in payload.model_fields_set:
        purchase_order_number = (customer.public_commitment_reference or "").strip() or None
    inv = Invoice(
        tenant_id=tenant_id,
        customer_id=customer.id,
        number=None,
        currency=payload.currency,
        status="draft",
        payment_terms=payment_terms,
        note=payload.note,
        template_key=template_key,
        template_options=template_options,
        purchase_order_number=purchase_order_number,
        public_service_code=public_service_code,
        service_date=payload.service_date,
        delivery_address=payload.delivery_address,
        delivery_address_differs=bool(payload.delivery_address_differs),
        operation_nature=payload.operation_nature,
        due_days=due_days,
        due_date=due_date,
        due_date_manual=due_date_manual,
        type=payload.type,
        invoice_kind=invoice_kind,
        quote_id=quote.id if quote else None,
        related_invoice_id=related.id if related else payload.related_invoice_id,
        issue_date=issue_date,
        created_by=_mutable_actor_id(actor),
        updated_by=_mutable_actor_id(actor),
        issued_profile=_facturx_profile(getattr(payload, "facturx_profile", None), tenant, customer),
    )
    if inv.type == "credit_note" and not inv.note and related:
        inv.note = f"Avoir relatif à la facture {related.number}"
    db.add(inv)
    db.flush()
    if quote and invoice_kind != "deposit":
        quote.invoice_id = inv.id
        quote.status = "invoiced"
        quote.updated_by = _mutable_actor_id(actor)
        db.add(quote)
    total_ht = Decimal("0")
    total_tva = Decimal("0")
    legacy_advance_entries: list[dict] = []
    stored_line_index = 0
    for _index, line in enumerate(payload.lines, start=1):
        line_type = _document_line_type(line)
        if line_type == "item":
            qty = quantize_amount(line.quantity)
        else:
            qty = Decimal("0")
        if line_type == "item" and qty <= 0:
            raise HTTPException(400, f"La ligne '{line.product_name}' a une quantité invalide.")
        if line_type == "item" and line.vat_rate is None:
            raise HTTPException(400, f"Taux de TVA manquant pour la ligne {line.product_name}.")
        unit = quantize_amount(line.unit_price) if line_type == "item" else Decimal("0")
        rate = quantize_amount(line.vat_rate) if line_type == "item" else Decimal("0")
        if line_type == "item" and payload.type == "credit_note" and qty > 0:
            qty = -qty
        line_total = calc_line_total(qty, unit) if line_type == "item" else Decimal("0")
        line_tax = calc_tax_amount(line_total, rate) if line_type == "item" else Decimal("0")
        if line_type == "item":
            _validate_sales_amount(f"Total HT de la ligne {_index}", line_total)
            _validate_sales_amount(f"TVA de la ligne {_index}", line_tax)
        if (
            line_type == "item"
            and payload.type != "credit_note"
            and unit < 0
            and _is_advance_payment_label(getattr(line, "product_name", None))
        ):
            legacy_advance_entries.append(_advance_payment_entry_from_legacy_line(line, line_total, line_tax))
            continue
        stored_line_index += 1
        db.add(
            InvoiceLine(
                id=_ordered_invoice_line_id(inv.id, stored_line_index),
                invoice_id=inv.id,
                line_type=line_type,
                display_number=getattr(line, "display_number", None),
                reference=getattr(line, "reference", None),
                source_line_id=getattr(line, "source_line_id", None),
                product_name=line.product_name,
                detail=getattr(line, "detail", None),
                quantity=qty,
                unit_price=unit,
                vat_rate=rate,
                vat_category=line.vat_category,
                exemption_reason_code=line.exemption_reason_code,
                unit_code=line.unit_code,
                item_id=line.item_id,
                accounting_account=line_accounting_account(
                    line.accounting_account,
                    tenant=tenant,
                    operation_nature=payload.operation_nature,
                )[0],
                line_total=line_total,
            )
        )
        total_ht += line_total
        total_tva += line_tax
    total_ht = quantize_amount(total_ht)
    total_tva = quantize_amount(total_tva)
    inv.total_ex_vat = total_ht
    inv.total_vat = total_tva
    inv.total_inc_vat = quantize_amount(total_ht + total_tva)
    _validate_sales_amount("Total HT de la facture", inv.total_ex_vat)
    _validate_sales_amount("TVA de la facture", inv.total_vat)
    _validate_sales_amount("Total TTC de la facture", inv.total_inc_vat)
    if legacy_advance_entries:
        inv.template_options = _merge_advance_payment_entries(inv.template_options, legacy_advance_entries)
    _validate_deposit_invoice_total(db, inv, quote)
    if inv.invoice_kind == "final":
        _sync_deposit_applications(db, inv, deposit_invoice_ids=payload.deposit_invoice_ids, actor=actor)
    if inv.type != "credit_note":
        _validate_advance_payments_do_not_exceed_total(inv.template_options, inv.total_inc_vat)
    if inv.type == "credit_note" and related:
        # Autoriser un avoir même si la facture est déjà payée, mais pas au-delà
        # du montant TTC restant, brouillons d'avoirs inclus.
        _validate_credit_note_amount(db, inv, related, include_drafts=True)
    _log_action(
        db,
        actor,
        tenant_id,
        "credit_note" if inv.type == "credit_note" else "invoice",
        inv.id,
        "create",
        {"number": inv.number, "type": inv.type},
    )
    if commit:
        db.commit()
        db.refresh(inv)
    else:
        db.flush()
    return inv


@router.patch("/{invoice_id}", response_model=InvoiceOut)
def update_invoice(
    invoice_id: str,
    payload: InvoiceUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.issued_at or inv.status != "draft":
        raise HTTPException(409, "Impossible de modifier une facture déjà émise.")
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")

    target_customer_id = payload.customer_id if payload.customer_id is not None else inv.customer_id
    customer = db.get(Customer, target_customer_id)
    if not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Client introuvable.")

    changed: dict[str, object] = {}
    updates = payload.model_dump(exclude_unset=True)

    if payload.customer_id is not None and payload.customer_id != inv.customer_id:
        inv.customer_id = payload.customer_id
        changed["customer_id"] = True
    if payload.currency is not None and payload.currency != inv.currency:
        inv.currency = payload.currency
        changed["currency"] = True
    if payload.note is not None and payload.note != inv.note:
        inv.note = payload.note
        changed["note"] = True
    if payload.payment_terms is not None and payload.payment_terms != inv.payment_terms:
        inv.payment_terms = payload.payment_terms
        changed["payment_terms"] = True
    if payload.due_days is not None and int(payload.due_days) != int(inv.due_days or 0):
        inv.due_days = max(0, int(payload.due_days))
        inv.due_date_manual = False
        changed["due_days"] = True
    if "issue_date" in updates and payload.issue_date is not None:
        next_issue_date = _issue_date_datetime(payload.issue_date)
        if next_issue_date != inv.issue_date:
            inv.issue_date = next_issue_date
            changed["issue_date"] = True
    if "due_date" in updates:
        computed_due_date = _compute_due_date(inv.issue_date or _utcnow(), inv.payment_terms, inv.due_days)
        next_due_date_manual = _due_date_is_manual(payload.due_date, computed_due_date)
        next_due_date = payload.due_date if next_due_date_manual else computed_due_date
        if next_due_date != inv.due_date:
            inv.due_date = next_due_date
            changed["due_date"] = True
        inv.due_date_manual = next_due_date_manual
    if payload.service_date is not None and payload.service_date != inv.service_date:
        inv.service_date = payload.service_date
        changed["service_date"] = True
    if "purchase_order_number" in updates:
        next_purchase_order_number = (payload.purchase_order_number or "").strip() or None
        if next_purchase_order_number != inv.purchase_order_number:
            inv.purchase_order_number = next_purchase_order_number
            changed["purchase_order_number"] = True
        next_options = dict(inv.template_options or {})
        next_options["_chorus_commitment_explicit"] = True
        inv.template_options = next_options
    if "public_service_code" in updates:
        next_public_service_code = (payload.public_service_code or "").strip() or None
        if next_public_service_code != inv.public_service_code:
            inv.public_service_code = next_public_service_code
            changed["public_service_code"] = True
        next_options = dict(inv.template_options or {})
        next_options["_chorus_service_code_explicit"] = True
        inv.template_options = next_options
    elif "customer_id" in changed:
        next_public_service_code = (customer.public_service_code or "").strip() or None
        if next_public_service_code != inv.public_service_code:
            inv.public_service_code = next_public_service_code
            changed["public_service_code"] = True
    if "customer_id" in changed and "purchase_order_number" not in updates:
        next_commitment = (customer.public_commitment_reference or "").strip() or None
        if next_commitment != inv.purchase_order_number:
            inv.purchase_order_number = next_commitment
            changed["purchase_order_number"] = True
    if "delivery_address" in updates and payload.delivery_address != inv.delivery_address:
        inv.delivery_address = payload.delivery_address
        changed["delivery_address"] = True
    if payload.operation_nature is not None and payload.operation_nature != inv.operation_nature:
        inv.operation_nature = payload.operation_nature
        changed["operation_nature"] = True
    if (
        payload.delivery_address_differs is not None
        and payload.delivery_address_differs != inv.delivery_address_differs
    ):
        inv.delivery_address_differs = payload.delivery_address_differs
        changed["delivery_address_differs"] = True
    if payload.facturx_profile is not None or "customer_id" in changed:
        requested_profile = payload.facturx_profile if payload.facturx_profile is not None else inv.issued_profile
        next_profile = _facturx_profile(requested_profile, tenant, customer)
        if next_profile != inv.issued_profile:
            inv.issued_profile = next_profile
            changed["facturx_profile"] = True

    if "template_key" in updates:
        next_template_key = _resolve_template_key(updates.get("template_key"))
        if next_template_key != inv.template_key:
            inv.template_key = next_template_key
            changed["template_key"] = True
    if "template_options" in updates:
        incoming = updates.get("template_options")
        if incoming is None:
            next_template_options = dict(DEFAULT_INVOICE_TEMPLATE_OPTIONS)
        else:
            base = _merge_template_options(DEFAULT_INVOICE_TEMPLATE_OPTIONS, inv.template_options or {})
            next_template_options = _merge_template_options(base, incoming)
        if next_template_options != (inv.template_options or {}):
            inv.template_options = next_template_options
            changed["template_options"] = True

    if "invoice_kind" in updates:
        next_invoice_kind = (
            "standard" if inv.type == "credit_note" else _invoice_kind_from_payload(payload, inv.template_options or {})
        )
        if next_invoice_kind != inv.invoice_kind:
            inv.invoice_kind = next_invoice_kind
            changed["invoice_kind"] = True
    if {"quote_id", "invoice_kind", "template_options", "customer_id"} & set(updates.keys()) or {
        "customer_id",
        "invoice_kind",
        "template_options",
    } & set(changed.keys()):
        next_quote_id = (
            None
            if inv.type == "credit_note"
            else _quote_id_from_payload(payload, inv.template_options or {}, inv.quote_id)
        )
        quote = _validate_quote_link(
            db,
            user.tenant_id,
            next_quote_id,
            inv.customer_id,
            inv.invoice_kind,
            current_invoice_id=inv.id,
        )
        next_quote_id = quote.id if quote else None
        if next_quote_id != inv.quote_id:
            inv.quote_id = next_quote_id
            changed["quote_id"] = True
    else:
        quote = _validate_quote_link(
            db,
            user.tenant_id,
            inv.quote_id,
            inv.customer_id,
            inv.invoice_kind,
            current_invoice_id=inv.id,
        )
    options = dict(inv.template_options or {})
    options["kind"] = inv.invoice_kind or "standard"
    if quote:
        options["source_quote_id"] = quote.id
    else:
        options.pop("source_quote_id", None)
        options.pop("quote_id", None)
    if options != (inv.template_options or {}):
        inv.template_options = options
        changed["template_options"] = True
    if "deposit_invoice_ids" in updates and payload.deposit_invoice_ids and inv.invoice_kind != "final":
        raise HTTPException(400, "Les acomptes déduits ne sont disponibles que sur une facture finale.")

    if payload.lines is not None:
        if not payload.lines:
            raise HTTPException(400, "Ajoutez au moins une ligne de facturation.")
        _ensure_document_line_quota(payload.lines, "Facture")
        if not any(_line_is_item(line) for line in payload.lines):
            raise HTTPException(400, "Ajoutez au moins une ligne produit ou service.")
        _enforce_tenant_vat_franchise(tenant, payload.lines)
        _validate_global_discount_vat_breakdown(payload.lines)
        db.query(InvoiceLine).filter(InvoiceLine.invoice_id == inv.id).delete()
        total_ht = Decimal("0")
        total_tva = Decimal("0")
        legacy_advance_entries: list[dict] = []
        stored_line_index = 0
        for _index, line in enumerate(payload.lines, start=1):
            line_type = _document_line_type(line)
            if line_type == "item":
                qty = quantize_amount(line.quantity)
            else:
                qty = Decimal("0")
            if line_type == "item" and qty <= 0:
                raise HTTPException(400, f"La ligne '{line.product_name}' a une quantité invalide.")
            unit = quantize_amount(line.unit_price) if line_type == "item" else Decimal("0")
            rate = quantize_amount(line.vat_rate) if line_type == "item" else Decimal("0")
            line_total = calc_line_total(qty, unit) if line_type == "item" else Decimal("0")
            line_tax = calc_tax_amount(line_total, rate) if line_type == "item" else Decimal("0")
            if line_type == "item":
                _validate_sales_amount(f"Total HT de la ligne {_index}", line_total)
                _validate_sales_amount(f"TVA de la ligne {_index}", line_tax)
            if (
                line_type == "item"
                and inv.type != "credit_note"
                and unit < 0
                and _is_advance_payment_label(getattr(line, "product_name", None))
            ):
                legacy_advance_entries.append(_advance_payment_entry_from_legacy_line(line, line_total, line_tax))
                continue
            stored_line_index += 1
            db.add(
                InvoiceLine(
                    id=_ordered_invoice_line_id(inv.id, stored_line_index),
                    invoice_id=inv.id,
                    line_type=line_type,
                    display_number=getattr(line, "display_number", None),
                    reference=getattr(line, "reference", None),
                    product_name=line.product_name,
                    detail=getattr(line, "detail", None),
                    quantity=qty,
                    unit_price=unit,
                    vat_rate=rate,
                    vat_category=line.vat_category,
                    exemption_reason_code=line.exemption_reason_code,
                    unit_code=line.unit_code,
                    item_id=line.item_id,
                    accounting_account=line_accounting_account(
                        line.accounting_account,
                        tenant=tenant,
                        operation_nature=inv.operation_nature,
                    )[0],
                    line_total=line_total,
                )
            )
            total_ht += line_total
            total_tva += line_tax
        total_ht = quantize_amount(total_ht)
        total_tva = quantize_amount(total_tva)
        inv.total_ex_vat = total_ht
        inv.total_vat = total_tva
        inv.total_inc_vat = quantize_amount(total_ht + total_tva)
        _validate_sales_amount("Total HT de la facture", inv.total_ex_vat)
        _validate_sales_amount("TVA de la facture", inv.total_vat)
        _validate_sales_amount("Total TTC de la facture", inv.total_inc_vat)
        if legacy_advance_entries:
            inv.template_options = _merge_advance_payment_entries(inv.template_options, legacy_advance_entries)
            changed["template_options"] = True
        changed["lines"] = True

    _validate_deposit_invoice_total(db, inv, quote)
    if inv.invoice_kind == "final":
        _sync_deposit_applications(
            db,
            inv,
            deposit_invoice_ids=payload.deposit_invoice_ids if "deposit_invoice_ids" in updates else None,
            actor=user,
        )
        changed["deposit_applications"] = True
    else:
        _sync_deposit_applications(db, inv, deposit_invoice_ids=None, actor=user)
        if "invoice_kind" in changed or "quote_id" in changed:
            changed["deposit_applications"] = True
    if inv.type != "credit_note":
        _validate_advance_payments_do_not_exceed_total(inv.template_options, quantize_amount(inv.total_inc_vat or 0))

    if (
        payload.payment_terms is not None or payload.due_days is not None or "issue_date" in changed
    ) and not inv.due_date_manual:
        inv.due_date = _compute_due_date(inv.issue_date, inv.payment_terms, inv.due_days)

    if changed:
        if {
            "customer_id",
            "currency",
            "payment_terms",
            "due_days",
            "issue_date",
            "due_date",
            "service_date",
            "purchase_order_number",
            "operation_nature",
            "facturx_profile",
            "template_key",
            "template_options",
            "invoice_kind",
            "quote_id",
            "deposit_applications",
            "lines",
        } & set(changed.keys()):
            inv.pdfa3_status = None
            inv.pdfa3_report = None
            inv.facturx_spec_version = None
        inv.updated_by = user.id
        db.add(inv)
        _log_action(db, user, inv.tenant_id, "invoice", inv.id, "update", changed)
        db.commit()
        db.refresh(inv)
    return inv


def _is_final_accounting_account(value: str | None) -> bool:
    code = "".join(ch for ch in str(value or "").strip().upper() if ch.isalnum())
    return len(code) >= 3 and not code.startswith("471")


@router.patch("/{invoice_id}/accounting-lines")
def update_invoice_accounting_lines(
    invoice_id: str,
    payload: AccountingLinesUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")

    db_lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == inv.id).all()
    lines_by_id = {line.id: line for line in db_lines}
    changed: list[dict[str, str | None]] = []

    for item in payload.lines:
        line = lines_by_id.get(item.id)
        if not line:
            raise HTTPException(404, "Ligne de facture introuvable.")
        account = item.accounting_account
        if not _is_final_accounting_account(account):
            raise HTTPException(422, "Choisissez un compte comptable définitif. Le 471 est temporaire avant export.")
        if line.accounting_account != account:
            changed.append({"line_id": line.id, "before": line.accounting_account, "after": account})
            line.accounting_account = account

    if changed:
        _log_action(
            db,
            user,
            inv.tenant_id,
            "invoice",
            inv.id,
            "update_accounting_lines",
            {
                "invoice_id": inv.id,
                "status": inv.status,
                "changed_lines": changed,
                "legal_document_unchanged": True,
            },
        )
        db.commit()

    return {"status": "ok", "updated": len(changed)}


@router.post("/{invoice_id}/duplicate", response_model=InvoiceOut)
def duplicate_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    """Duplicate an invoice into a new draft.

    Pragmatic first step for recurring billing and quick reuse without a full subscription engine.
    We intentionally reset numbering, status, issue artifacts, payments, and public links.
    """
    _require_role_accountant(user)
    ensure_legal_acceptance(user, db)
    src = db.get(Invoice, invoice_id)
    if not src or src.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if src.type != "invoice":
        raise HTTPException(400, "La duplication n'est disponible que pour les factures.")

    tenant = db.get(Tenant, user.tenant_id)
    customer = db.get(Customer, src.customer_id)
    if not tenant or not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Client introuvable.")

    src_lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == src.id).order_by(InvoiceLine.id.asc()).all()
    if not src_lines:
        raise HTTPException(400, "Impossible de dupliquer une facture sans lignes.")

    issue_date = _utcnow()
    due_days = src.due_days
    due_date_manual = bool(src.due_date_manual and src.due_date)
    due_date = src.due_date if due_date_manual else _compute_due_date(issue_date, src.payment_terms, due_days)
    template_key = _resolve_template_key(src.template_key)
    template_options = _merge_template_options(DEFAULT_INVOICE_TEMPLATE_OPTIONS, src.template_options or {})
    manual_entries = _manual_advance_entries(template_options)
    if manual_entries:
        template_options["advance_payments"] = manual_entries
    else:
        template_options.pop("advance_payments", None)
    template_options["kind"] = "standard"
    template_options.pop("source_quote_id", None)
    template_options.pop("quote_id", None)

    new_inv = Invoice(
        tenant_id=user.tenant_id,
        customer_id=src.customer_id,
        number=None,
        currency=src.currency,
        status="draft",
        payment_terms=src.payment_terms,
        note=src.note,
        template_key=template_key,
        template_options=template_options,
        purchase_order_number=src.purchase_order_number,
        service_date=src.service_date,
        delivery_address=src.delivery_address,
        delivery_address_differs=bool(src.delivery_address_differs),
        operation_nature=src.operation_nature,
        due_days=due_days,
        due_date=due_date,
        due_date_manual=due_date_manual,
        type="invoice",
        invoice_kind="standard",
        quote_id=None,
        related_invoice_id=None,
        issue_date=issue_date,
        created_by=None if user.is_api_key else user.id,
        updated_by=None if user.is_api_key else user.id,
        issued_profile=_facturx_profile(getattr(src, "facturx_profile", None), tenant, customer),
    )
    db.add(new_inv)
    db.flush()

    total_ht = Decimal("0")
    total_tva = Decimal("0")
    for index, line in enumerate(src_lines, start=1):
        line_type = _document_line_type(line)
        qty = quantize_amount(line.quantity) if line_type == "item" else Decimal("0")
        unit = quantize_amount(line.unit_price) if line_type == "item" else Decimal("0")
        rate = quantize_amount(line.vat_rate) if line_type == "item" else Decimal("0")
        line_total = calc_line_total(qty, unit) if line_type == "item" else Decimal("0")
        line_tax = calc_tax_amount(line_total, rate) if line_type == "item" else Decimal("0")
        if line_type == "item":
            _validate_sales_amount(f"Total HT de la ligne {index}", line_total)
            _validate_sales_amount(f"TVA de la ligne {index}", line_tax)
        db.add(
            InvoiceLine(
                id=_ordered_invoice_line_id(new_inv.id, index),
                invoice_id=new_inv.id,
                line_type=line_type,
                display_number=getattr(line, "display_number", None),
                reference=getattr(line, "reference", None),
                product_name=line.product_name,
                detail=line.detail,
                quantity=qty,
                unit_price=unit,
                vat_rate=rate,
                vat_category=line.vat_category,
                exemption_reason_code=line.exemption_reason_code,
                unit_code=line.unit_code,
                item_id=line.item_id,
                accounting_account=line.accounting_account,
                line_total=line_total,
            )
        )
        total_ht += line_total
        total_tva += line_tax

    new_inv.total_ex_vat = quantize_amount(total_ht)
    new_inv.total_vat = quantize_amount(total_tva)
    new_inv.total_inc_vat = quantize_amount(total_ht + total_tva)
    _validate_sales_amount("Total HT de la facture", new_inv.total_ex_vat)
    _validate_sales_amount("TVA de la facture", new_inv.total_vat)
    _validate_sales_amount("Total TTC de la facture", new_inv.total_inc_vat)

    _log_action(
        db,
        user,
        user.tenant_id,
        "invoice",
        src.id,
        "duplicate",
        {"new_invoice_id": new_inv.id, "source_number": src.number},
    )
    _log_action(
        db,
        user,
        user.tenant_id,
        "invoice",
        new_inv.id,
        "duplicate_from",
        {"source_invoice_id": src.id, "source_number": src.number},
    )
    db.commit()
    db.refresh(new_inv)
    setattr(new_inv, "customer_name", customer.name if customer else None)
    return new_inv


@router.post("/{invoice_id}/credit-note", response_model=InvoiceOut)
def credit_note(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    original = db.get(Invoice, invoice_id)
    if not original or original.tenant_id != user.tenant_id:
        raise HTTPException(404, "Facture introuvable pour créer un avoir.")
    if original.type != "invoice":
        raise HTTPException(400, "Impossible de créer un avoir à partir d'un avoir.")
    if original.status == "draft":
        raise HTTPException(409, "Émettez la facture avant de créer un avoir.")
    lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == original.id).all()
    payload = InvoiceCreate(
        customer_id=original.customer_id,
        currency=original.currency,
        payment_terms=original.payment_terms or "Avoir immédiat",
        due_days=original.due_days,
        type="credit_note",
        related_invoice_id=original.id,
        note=f"Avoir de la facture {original.number}",
        lines=[
            {
                "line_type": line.line_type or "item",
                "display_number": line.display_number,
                "reference": line.reference,
                "product_name": line.product_name,
                "detail": line.detail,
                "quantity": float(abs(line.quantity)) if str(line.line_type or "item").lower() == "item" else 0,
                "unit_price": float(line.unit_price) if str(line.line_type or "item").lower() == "item" else 0,
                "vat_rate": float(line.vat_rate) if str(line.line_type or "item").lower() == "item" else 0,
                "vat_category": line.vat_category or "S",
                "exemption_reason_code": line.exemption_reason_code,
                "unit_code": line.unit_code or "C62",
                "item_id": line.item_id,
                "accounting_account": line.accounting_account,
            }
            for line in lines
        ],
    )
    return create_invoice(payload, Response(), db, user)


@router.post("/{invoice_id}/credit-note/from-lines", response_model=InvoiceOut)
def credit_note_from_lines(
    invoice_id: str,
    payload: CreditNoteCreateFromInvoice,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    """Créer un avoir partiel à partir d'une facture.

    Permet de sélectionner des lignes et des quantités à créditer (UX B2B indispensable).

    Règles:
    - La facture d'origine doit exister, appartenir au tenant, et ne pas être en brouillon.
    - Les quantités sont bornées par les quantités de la facture.
    - L'avoir reste limité par le montant total déjà crédité (contrôle côté create_invoice).
    """
    _require_role_accountant(user)
    original = db.get(Invoice, invoice_id)
    if not original or original.tenant_id != user.tenant_id:
        raise HTTPException(404, "Facture introuvable pour créer un avoir.")
    if original.type != "invoice":
        raise HTTPException(400, "Impossible de créer un avoir à partir d'un avoir.")
    if original.status == "draft":
        raise HTTPException(409, "Émettez la facture avant de créer un avoir.")

    requested = payload.model_dump()
    selections = requested.get("lines") or []
    line_ids = [str(s.get("line_id")) for s in selections if s.get("line_id")]
    if not line_ids:
        raise HTTPException(400, "Sélectionnez au moins une ligne.")

    db_lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == original.id).all()
    by_id = {line.id: line for line in db_lines}
    reference_counts: dict[str, int] = {}
    for line in db_lines:
        ref = str(line.reference or "").strip()
        if ref:
            reference_counts[ref] = reference_counts.get(ref, 0) + 1

    credit_lines = (
        db.query(InvoiceLine, Invoice)
        .join(Invoice, InvoiceLine.invoice_id == Invoice.id)
        .filter(
            Invoice.tenant_id == user.tenant_id,
            Invoice.type == "credit_note",
            Invoice.related_invoice_id == original.id,
            Invoice.status != "canceled",
        )
        .all()
    )
    already_credited_by_source_line: dict[str, Decimal] = {}
    for credit_line, _credit_invoice in credit_lines:
        qty = abs(quantize_amount(credit_line.quantity or 0))
        source_line_id = str(getattr(credit_line, "source_line_id", None) or "").strip()
        if source_line_id:
            already_credited_by_source_line[source_line_id] = (
                already_credited_by_source_line.get(source_line_id, Decimal("0")) + qty
            )
            continue
        legacy_reference = str(credit_line.reference or "").strip()
        if not legacy_reference:
            continue
        legacy_matches = [
            line
            for line in db_lines
            if line.id in line_ids
            and str(line.reference or "").strip() == legacy_reference
            and reference_counts.get(legacy_reference, 0) == 1
        ]
        if len(legacy_matches) == 1:
            source_id = legacy_matches[0].id
            already_credited_by_source_line[source_id] = (
                already_credited_by_source_line.get(source_id, Decimal("0")) + qty
            )

    lines_payload = []
    selected_quantities: dict[str, float] = {}
    for sel in selections:
        lid = str(sel.get("line_id"))
        if lid not in by_id:
            raise HTTPException(400, "Une ligne sélectionnée est introuvable sur cette facture.")
        src = by_id[lid]
        max_qty = abs(float(src.quantity or 0))
        qty = float(sel.get("quantity") or 0)
        if max_qty <= 0:
            raise HTTPException(400, "Impossible de créditer une ligne avec quantité nulle.")
        if qty <= 0:
            raise HTTPException(400, "La quantité à créditer doit être > 0.")
        if qty > max_qty + 1e-9:
            raise HTTPException(400, f"Quantité à créditer ({qty}) supérieure à la quantité facturée ({max_qty}).")
        already_credited = already_credited_by_source_line.get(lid, Decimal("0"))
        remaining_qty = Decimal(str(max_qty)) - already_credited
        if remaining_qty < Decimal("0"):
            remaining_qty = Decimal("0")
        if Decimal(str(qty)) > remaining_qty + Decimal("0.000000001"):
            raise HTTPException(
                400,
                f"Quantité à créditer ({qty}) supérieure à la quantité restante à avoir ({float(remaining_qty)}).",
            )
        selected_quantities[lid] = qty
        lines_payload.append(
            {
                "display_number": src.display_number,
                "reference": src.reference,
                "source_line_id": src.id,
                "product_name": src.product_name,
                "detail": src.detail,
                "quantity": qty,
                "unit_price": float(src.unit_price or 0),
                "vat_rate": float(src.vat_rate or 0),
                "vat_category": src.vat_category or "S",
                "exemption_reason_code": src.exemption_reason_code,
                "unit_code": src.unit_code or "C62",
                "item_id": src.item_id,
                "accounting_account": src.accounting_account,
            }
        )

    creditable_lines = [line for line in db_lines if abs(float(line.quantity or 0)) > 0]
    is_full_credit = bool(creditable_lines) and all(
        abs(selected_quantities.get(line.id, 0.0) - abs(float(line.quantity or 0))) <= 1e-9 for line in creditable_lines
    )
    original_ref = original.number or original.id
    note_kind = "Avoir total" if is_full_credit else "Avoir partiel"
    generated_notes = {
        f"Avoir total de la facture {original_ref}",
        f"Avoir partiel de la facture {original_ref}",
        "Avoir total",
        "Avoir partiel",
    }
    raw_note = (payload.note or "").strip()
    note = f"{note_kind} de la facture {original_ref}" if not raw_note or raw_note in generated_notes else raw_note
    ic = InvoiceCreate(
        customer_id=original.customer_id,
        currency=original.currency,
        payment_terms=original.payment_terms or "Avoir immédiat",
        due_days=original.due_days,
        type="credit_note",
        related_invoice_id=original.id,
        note=note,
        lines=lines_payload,
    )
    return create_invoice(ic, Response(), db, user)


def _resolve_supplier_snapshot(inv: Invoice) -> dict | None:
    if isinstance(inv.supplier_snapshot, dict) and inv.supplier_snapshot:
        return inv.supplier_snapshot
    if isinstance(inv.seller_snapshot, dict) and inv.seller_snapshot:
        return inv.seller_snapshot
    return None


def _invoice_card_payment_state(
    *,
    tenant: Tenant | None,
    invoice: Invoice | None,
    balance_due: Decimal | float | int | None,
) -> tuple[bool, str | None]:
    return False, "card_payments_removed"


def _legal_recovery_fee_eur(tenant: Tenant) -> float:
    try:
        configured = Decimal(str(tenant.recovery_fee_eur))
    except Exception:
        configured = Decimal("40")
    if configured < Decimal("40"):
        configured = Decimal("40")
    return float(quantize_amount(configured))


def _ctx(db: Session, inv: Invoice, *, allow_missing_identifiers: bool = False):
    tenant = db.get(Tenant, inv.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable.")
    customer = db.get(Customer, inv.customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="Client introuvable.")

    supplier_snapshot = _resolve_supplier_snapshot(inv)
    buyer_snapshot = inv.buyer_snapshot if isinstance(inv.buyer_snapshot, dict) else None
    use_supplier_snapshot = inv.status in IMMUTABLE_STATUSES and supplier_snapshot
    use_buyer_snapshot = inv.status in IMMUTABLE_STATUSES and buyer_snapshot
    seller_snapshot = supplier_snapshot if use_supplier_snapshot else {}
    buyer_snapshot = buyer_snapshot if use_buyer_snapshot else {}

    def _snap_value(snapshot: dict[str, object] | None, key: str, fallback: object = None) -> object:
        if not isinstance(snapshot, dict):
            return fallback
        value = snapshot.get(key)
        if value is None:
            return fallback
        if isinstance(value, str) and not value.strip():
            return fallback
        return value

    def _snap_text(snapshot: dict[str, object] | None, key: str, fallback: str | None = None) -> str | None:
        value = _snap_value(snapshot, key, fallback)
        if value is None:
            return None
        text = str(value).strip()
        return text or fallback

    branding = get_branding_settings(tenant)
    template_key = _resolve_template_key(inv.template_key or branding.get("pdf_template"))
    effective_template_options = invoice_effective_template_options(db, inv)
    template_options = _merge_template_options(
        DEFAULT_INVOICE_TEMPLATE_OPTIONS,
        effective_template_options if isinstance(effective_template_options, dict) else inv.template_options or {},
    )
    display_note = visible_document_note(
        inv.note,
        template_options.get("document_title"),
        template_options.get("legal_mentions_text"),
    )
    payment_bank_account = _issuer_payment_bank_account(template_options)

    lines_snapshot = (
        inv.lines_snapshot if inv.status in IMMUTABLE_STATUSES and isinstance(inv.lines_snapshot, list) else None
    )
    line_items: list[dict[str, object]] = []
    if lines_snapshot:
        for raw in lines_snapshot:
            if not isinstance(raw, dict):
                continue
            quantity = quantize_amount(_snap_value(raw, "quantity", 0))
            unit_price = quantize_amount(_snap_value(raw, "unit_price", 0))
            vat_rate = quantize_amount(_snap_value(raw, "vat_rate", 0))
            line_total = _snap_value(raw, "line_total", None)
            if line_total is None:
                line_total = calc_line_total(quantity, unit_price)
            else:
                line_total = quantize_amount(line_total)
            line_items.append(
                {
                    "line_type": raw.get("line_type") or "item",
                    "display_number": raw.get("display_number"),
                    "reference": raw.get("reference"),
                    "product_name": raw.get("product_name") or "",
                    "detail": raw.get("detail"),
                    "quantity": quantity,
                    "unit_price": unit_price,
                    "vat_rate": vat_rate,
                    "vat_category": raw.get("vat_category") or "S",
                    "exemption_reason_code": raw.get("exemption_reason_code"),
                    "unit_code": raw.get("unit_code") or "C62",
                    "item_id": raw.get("item_id"),
                    "accounting_account": raw.get("accounting_account"),
                    "line_total": line_total,
                }
            )
    else:
        lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == inv.id).order_by(InvoiceLine.id.asc()).all()
        line_items = [
            {
                "line_type": line.line_type or "item",
                "display_number": line.display_number,
                "reference": line.reference,
                "product_name": line.product_name,
                "detail": line.detail,
                "quantity": quantize_amount(line.quantity),
                "unit_price": quantize_amount(line.unit_price),
                "vat_rate": quantize_amount(line.vat_rate),
                "vat_category": line.vat_category,
                "exemption_reason_code": line.exemption_reason_code,
                "unit_code": line.unit_code,
                "item_id": line.item_id,
                "accounting_account": line.accounting_account,
                "line_total": quantize_amount(line.line_total),
            }
            for line in lines
        ]

    advance_payments = _normalize_advance_payments(template_options)
    if (inv.invoice_kind or "standard") == "final":
        durable_deposit_entries = _invoice_deposit_entries(db, inv)
        if durable_deposit_entries:
            advance_payments = [
                *_manual_advance_entries({"advance_payments": advance_payments}),
                *durable_deposit_entries,
            ]
    header_allowances: list[dict[str, object]] = []
    regular_line_items: list[dict[str, object]] = []
    for line in line_items:
        adjustment_kind = classify_negative_adjustment_line(line)
        if adjustment_kind in {"regular", "other"}:
            regular_line_items.append(line)
            continue
        amount_ht = abs(_line_total_from_ctx_line(line))
        rate = _decimal_from_any(line.get("vat_rate"))
        amount_vat = abs(calc_tax_amount(-amount_ht, rate))
        amount_ttc = quantize_amount(amount_ht + amount_vat)
        if adjustment_kind == "advance_payment":
            advance_payments.append(
                {
                    "reference": str(line.get("product_name") or "").strip(),
                    "label": str(line.get("product_name") or "Acompte").strip(),
                    "source": "legacy_negative_line",
                    "amount_ht": amount_ht,
                    "amount_vat": amount_vat,
                    "amount_ttc": amount_ttc,
                    "vat_rate": rate,
                    "adjustment_kind": adjustment_kind,
                }
            )
        else:
            header_allowances.append(
                {
                    "label": str(line.get("product_name") or "Remise").strip(),
                    "amount_ht": amount_ht,
                    "amount_vat": amount_vat,
                    "amount_ttc": amount_ttc,
                    "vat_rate": rate,
                    "vat_category": line.get("vat_category") or "S",
                    "exemption_reason_code": line.get("exemption_reason_code"),
                    "adjustment_kind": adjustment_kind,
                }
            )
    line_items = attach_discount_display_metadata(regular_line_items, header_allowances)

    totals_snapshot = (
        inv.totals_snapshot if inv.status in IMMUTABLE_STATUSES and isinstance(inv.totals_snapshot, dict) else None
    )
    totals_ht = quantize_amount(_snap_value(totals_snapshot or {}, "ht", inv.total_ex_vat))
    totals_vat = quantize_amount(_snap_value(totals_snapshot or {}, "vat", inv.total_vat))
    totals_ttc = quantize_amount(_snap_value(totals_snapshot or {}, "ttc", inv.total_inc_vat))
    if line_items:
        line_ht_total = Decimal("0")
        vat_groups: dict[tuple[str, Decimal, str | None], Decimal] = {}
        for line in line_items:
            if str(line.get("line_type") or "item").strip().lower() != "item":
                continue
            line_total = _line_total_from_ctx_line(line)
            line_ht_total += line_total
            rate = _decimal_from_any(line.get("vat_rate"))
            category = str(line.get("vat_category") or "S")
            exemption_code = line.get("exemption_reason_code") or None
            key = (category, rate, str(exemption_code) if exemption_code else None)
            vat_groups[key] = vat_groups.get(key, Decimal("0")) + line_total
        allowance_ht_total = Decimal("0")
        for allowance in header_allowances:
            amount_ht = _decimal_from_any(allowance.get("amount_ht"))
            allowance_ht_total += amount_ht
            rate = _decimal_from_any(allowance.get("vat_rate"))
            category = str(allowance.get("vat_category") or "S")
            exemption_code = allowance.get("exemption_reason_code") or None
            key = (category, rate, str(exemption_code) if exemption_code else None)
            vat_groups[key] = vat_groups.get(key, Decimal("0")) - amount_ht
        totals_ht = quantize_amount(line_ht_total - allowance_ht_total)
        totals_vat = quantize_amount(
            sum(
                (calc_tax_amount(base, rate) for (_category, rate, _exemption), base in vat_groups.items()),
                Decimal("0"),
            )
        )
        totals_ttc = quantize_amount(totals_ht + totals_vat)
    allowance_total_ht = quantize_amount(
        sum((_decimal_from_any(item.get("amount_ht")) for item in header_allowances), Decimal("0"))
    )
    prepaid_total_ttc = _advance_payments_total_ttc({"advance_payments": advance_payments})

    # Identifiants FR (SIRET/SIREN) avec tolérance internationale
    supplier_country = _snap_text(seller_snapshot, "country", tenant.country or "FR")
    customer_country = _snap_text(buyer_snapshot, "country", customer.country or "FR")
    supplier_vat_number = _snap_text(seller_snapshot, "vat_number", tenant.vat_number)
    customer_vat_number = _snap_text(buyer_snapshot, "vat_number", customer.vat_number)
    customer_client_type = _snap_text(buyer_snapshot, "client_type", customer.client_type or "business")
    supplier_legal_id = _snap_text(seller_snapshot, "siret", None) or _snap_text(seller_snapshot, "legal_id", None)
    raw_supplier_siret = ((supplier_legal_id or tenant.siret or settings.SUPPLIER_SIRET or "").replace(" ", "")) or None
    raw_supplier_siren = ((_snap_text(seller_snapshot, "siren", None) or "").replace(" ", "")) or None
    try:
        supplier_id = _require_fr_business_identifier(
            raw_supplier_siret,
            raw_supplier_siren,
            "Votre entreprise",
            country=supplier_country,
            client_type="business",
            vat_number=supplier_vat_number,
        )
    except HTTPException:
        if not allow_missing_identifiers:
            raise
        supplier_id = None
    snapshot_customer_siret = _snap_text(buyer_snapshot, "siret", None) or _snap_text(buyer_snapshot, "legal_id", None)
    raw_customer_siret = ((snapshot_customer_siret or customer.siret or "").replace(" ", "")) or None
    raw_customer_siren = ((_snap_text(buyer_snapshot, "siren", None) or customer.siren or "").replace(" ", "")) or None
    try:
        customer_id = _require_fr_business_identifier(
            raw_customer_siret,
            raw_customer_siren,
            "Ce client",
            country=customer_country,
            client_type=customer_client_type,
            vat_number=customer_vat_number,
        )
    except HTTPException:
        if not allow_missing_identifiers:
            raise
        customer_id = None
    supplier_siret = raw_supplier_siret if raw_supplier_siret and SIRET_RE.fullmatch(raw_supplier_siret) else None
    if not supplier_siret and supplier_id and SIRET_RE.fullmatch(supplier_id):
        supplier_siret = supplier_id
    supplier_siren = raw_supplier_siren if raw_supplier_siren and SIREN_RE.fullmatch(raw_supplier_siren) else None
    if not supplier_siren:
        if supplier_siret and len(supplier_siret) >= 9:
            supplier_siren = supplier_siret[:9]
        elif supplier_id and SIREN_RE.fullmatch(supplier_id):
            supplier_siren = supplier_id
    customer_siret = raw_customer_siret if raw_customer_siret and SIRET_RE.fullmatch(raw_customer_siret) else None
    if not customer_siret and customer_id and SIRET_RE.fullmatch(customer_id):
        customer_siret = customer_id
    customer_siren = raw_customer_siren if raw_customer_siren and SIREN_RE.fullmatch(raw_customer_siren) else None
    if not customer_siren:
        if customer_siret and len(customer_siret) >= 9:
            customer_siren = customer_siret[:9]
        elif customer_id and SIREN_RE.fullmatch(customer_id):
            customer_siren = customer_id
    related_number = str(getattr(inv, "related_number", None) or "").strip() or None
    if inv.related_invoice_id:
        rel = db.get(Invoice, inv.related_invoice_id)
        related_number = related_number or (rel.number if rel else None)
    invoice_type = inv.type or "invoice"
    if invoice_type not in {"invoice", "credit_note"}:
        invoice_type = "invoice"
    type_code = "381" if invoice_type == "credit_note" else "380"

    payment_block = _snap_value(seller_snapshot, "payment_terms_block", None)
    supplier_payment_block = (
        payment_block
        if isinstance(payment_block, dict)
        else {
            "payment_terms": inv.payment_terms,
            "late_payment_interest": tenant.late_payment_interest,
            "recovery_fee_eur": _legal_recovery_fee_eur(tenant),
            "discount_terms": tenant.discount_terms or "Néant",
        }
    )

    supplier_address_raw = _snap_text(seller_snapshot, "address", tenant.address)
    customer_address_raw = _snap_text(buyer_snapshot, "address", customer.address)
    supplier_address_line1 = _snap_text(seller_snapshot, "address_line1", tenant.address_line1)
    supplier_address_line2 = _snap_text(seller_snapshot, "address_line2", tenant.address_line2)
    supplier_postal_code = _snap_text(seller_snapshot, "postal_code", tenant.postal_code)
    supplier_city = _snap_text(seller_snapshot, "city", tenant.city)
    supplier_country_code = _snap_text(seller_snapshot, "country_code", tenant.country_code)
    customer_address_line1 = _snap_text(buyer_snapshot, "address_line1", customer.address_line1)
    customer_address_line2 = _snap_text(buyer_snapshot, "address_line2", customer.address_line2)
    customer_postal_code = _snap_text(buyer_snapshot, "postal_code", customer.postal_code)
    customer_city = _snap_text(buyer_snapshot, "city", customer.city)
    customer_country_code = _snap_text(buyer_snapshot, "country_code", customer.country_code)
    supplier_address_raw, supplier_address = _resolve_structured_address(
        supplier_address_raw,
        supplier_address_line1,
        supplier_address_line2,
        supplier_postal_code,
        supplier_city,
        supplier_country_code,
        supplier_country or "FR",
    )
    customer_address_raw, customer_address = _resolve_structured_address(
        customer_address_raw,
        customer_address_line1,
        customer_address_line2,
        customer_postal_code,
        customer_city,
        customer_country_code,
        customer_country or "FR",
    )
    supplier_address_struct = _build_address_struct(
        supplier_address_raw,
        supplier_address_line1,
        supplier_address_line2,
        supplier_postal_code,
        supplier_city,
        supplier_country_code,
    )
    customer_address_struct = _build_address_struct(
        customer_address_raw,
        customer_address_line1,
        customer_address_line2,
        customer_postal_code,
        customer_city,
        customer_country_code,
    )

    supplier_logo_url = None
    if tenant.logo_storage_key:
        try:
            supplier_logo_url = get_logo_url(tenant.id, tenant.logo_storage_key)
        except Exception:
            supplier_logo_url = None
    if not supplier_logo_url:
        supplier_logo_url = tenant.logo_url
    supplier_email = (
        _snap_value(seller_snapshot, "email", None)
        or _snap_value(seller_snapshot, "email_reply_to", None)
        or getattr(tenant, "email_reply_to", None)
        or settings.SUPPLIER_EMAIL
        or settings.NEXT_PUBLIC_LEGAL_COMPANY_EMAIL
        or settings.NEXT_PUBLIC_LEGAL_EMAIL
        or settings.NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL
        or settings.SMTP_FROM
    )
    supplier_phone = _snap_value(seller_snapshot, "phone", None) or getattr(tenant, "phone", None)
    raw_balance_due = _outstanding(db, inv)
    if invoice_type != "credit_note":
        raw_balance_due = max(raw_balance_due, Decimal("0"))
    balance_due = quantize_amount(raw_balance_due)

    return {
        "invoice": {
            "number": inv.number or "",
            "currency": inv.currency,
            "status": inv.status,
            "issue_date": inv.issue_date.strftime("%Y-%m-%d"),
            "service_date": inv.service_date.strftime("%Y-%m-%d") if inv.service_date else None,
            "due_date": inv.due_date.strftime("%Y-%m-%d") if inv.due_date else None,
            "payment_terms": inv.payment_terms,
            "delivery_address": inv.delivery_address,
            "delivery_address_differs": bool(getattr(inv, "delivery_address_differs", False)),
            "operation_nature": inv.operation_nature,
            "type": invoice_type,
            "invoice_kind": inv.invoice_kind or "standard",
            "quote_id": inv.quote_id,
            "type_code": type_code,
            "related_number": related_number,
            "note": display_note,
            "purchase_order_number": inv.purchase_order_number,
            "public_service_code": inv.public_service_code,
            "balance_due": balance_due,
            "facturx_profile": inv.issued_profile,
        },
        "supplier": {
            "name": _snap_value(seller_snapshot, "name", tenant.name or settings.SUPPLIER_NAME),
            "legal_id": supplier_siret,
            "siren": supplier_siren,
            "vat_number": supplier_vat_number,
            "naf_code": _snap_value(seller_snapshot, "naf_code", getattr(tenant, "naf_code", None)),
            "address": supplier_address_raw,
            "address_struct": supplier_address_struct,
            "street": supplier_address["street"],
            "city": supplier_address["city"],
            "postal_code": supplier_address["postal_code"],
            "country_code": supplier_address["country_code"],
            "country": supplier_country or "FR",
            "email": supplier_email,
            "phone": supplier_phone,
            "logo_url": supplier_logo_url,
            "iban": _snap_value(
                seller_snapshot,
                "iban",
                payment_bank_account.get("iban") if payment_bank_account else tenant.iban,
            ),
            "bic": _snap_value(
                seller_snapshot,
                "bic",
                payment_bank_account.get("bic") if payment_bank_account else tenant.bic,
            ),
            "bank_account_label": _snap_value(
                seller_snapshot,
                "bank_account_label",
                payment_bank_account.get("label") if payment_bank_account else "RIB émetteur",
            ),
            "legal_mentions": _snap_value(seller_snapshot, "legal_mentions", tenant.legal_mentions),
            "vat_exemption_notice": _snap_value(seller_snapshot, "vat_exemption_notice", tenant.vat_exemption_notice),
            "vat_regime": _snap_value(seller_snapshot, "vat_regime", getattr(tenant, "vat_regime", None)),
            "legal_form": _snap_value(seller_snapshot, "legal_form", tenant.legal_form),
            "share_capital": _snap_value(seller_snapshot, "share_capital", tenant.share_capital),
            "rcs": _snap_value(seller_snapshot, "rcs", tenant.rcs),
            "payment_terms_block": supplier_payment_block,
            "vat_on_debits": bool(
                _snap_value(seller_snapshot, "vat_on_debits", getattr(tenant, "vat_on_debits", False))
            ),
        },
        "customer": {
            "name": _snap_value(buyer_snapshot, "name", customer.name),
            "email": _snap_value(buyer_snapshot, "email", customer.email),
            "phone": _snap_value(buyer_snapshot, "phone", customer.phone),
            "client_type": _snap_value(buyer_snapshot, "client_type", customer.client_type or "business"),
            "address": customer_address_raw,
            "address_struct": customer_address_struct,
            "street": customer_address["street"],
            "city": customer_address["city"],
            "postal_code": customer_address["postal_code"],
            "country_code": customer_address["country_code"],
            "country": customer_country or "FR",
            "vat_number": customer_vat_number,
            "legal_id": customer_siret or customer_siren,
            "siret": customer_siret,
            "siren": customer_siren,
            "payment_method_default": _snap_value(
                buyer_snapshot, "payment_method_default", customer.payment_method_default
            ),
        },
        "lines": line_items,
        "totals": {
            "ht": totals_ht,
            "vat": totals_vat,
            "ttc": totals_ttc,
            "allowance": allowance_total_ht,
            "prepaid": prepaid_total_ttc,
            "due": balance_due,
        },
        "allowances": header_allowances,
        "advance_payments": advance_payments,
        "facturx_profile": inv.issued_profile,
        "buyer_siren": customer_siren,
        "buyer_siret": customer_siret,
        "note": display_note,
        "template_key": template_key,
        "template_options": template_options,
    }


def _snapshot_supplier(tenant: Tenant, supplier_ctx: dict, inv: Invoice) -> dict:
    snapshot = dict(supplier_ctx or {})
    template_options = _merge_template_options(DEFAULT_INVOICE_TEMPLATE_OPTIONS, inv.template_options or {})
    payment_bank_account = _issuer_payment_bank_account(template_options)
    siret = snapshot.get("siret") or snapshot.get("legal_id") or tenant.siret or settings.SUPPLIER_SIRET
    if siret:
        snapshot.setdefault("siret", siret)
        snapshot.setdefault("legal_id", siret)
        if len(siret) >= 9:
            snapshot.setdefault("siren", siret[:9])
    snapshot.setdefault("name", tenant.name or settings.SUPPLIER_NAME)
    snapshot.setdefault("vat_number", tenant.vat_number)
    snapshot.setdefault("naf_code", getattr(tenant, "naf_code", None))
    snapshot.setdefault("address", tenant.address)
    snapshot.setdefault("address_line1", tenant.address_line1)
    snapshot.setdefault("address_line2", tenant.address_line2)
    snapshot.setdefault("postal_code", tenant.postal_code)
    snapshot.setdefault("city", tenant.city)
    snapshot.setdefault("country_code", tenant.country_code or tenant.country)
    snapshot.setdefault("country", getattr(tenant, "country", None) or "FR")
    supplier_phone = snapshot.get("phone") or getattr(tenant, "phone", None)
    if supplier_phone:
        snapshot.setdefault("phone", supplier_phone)
    supplier_email = (
        snapshot.get("email")
        or snapshot.get("email_reply_to")
        or tenant.email_reply_to
        or settings.SUPPLIER_EMAIL
        or settings.NEXT_PUBLIC_LEGAL_COMPANY_EMAIL
        or settings.NEXT_PUBLIC_LEGAL_EMAIL
        or settings.NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL
        or settings.SMTP_FROM
    )
    if supplier_email:
        snapshot.setdefault("email", supplier_email)
        snapshot.setdefault("email_reply_to", supplier_email)
    if payment_bank_account:
        snapshot.setdefault("iban", payment_bank_account.get("iban"))
        snapshot.setdefault("bic", payment_bank_account.get("bic"))
    else:
        snapshot.setdefault("iban", tenant.iban)
        snapshot.setdefault("bic", tenant.bic)
    if payment_bank_account and payment_bank_account.get("label"):
        snapshot.setdefault("bank_account_label", payment_bank_account.get("label"))
    snapshot.setdefault("legal_mentions", tenant.legal_mentions)
    snapshot.setdefault("vat_exemption_notice", tenant.vat_exemption_notice)
    snapshot.setdefault("vat_regime", getattr(tenant, "vat_regime", None))
    snapshot.setdefault("legal_form", tenant.legal_form)
    snapshot.setdefault("share_capital", tenant.share_capital)
    snapshot.setdefault("rcs", tenant.rcs)
    logo_url = tenant.logo_url
    if tenant.logo_storage_key:
        logo_url = get_logo_url(tenant.id, tenant.logo_storage_key) or logo_url
    snapshot.setdefault("logo_url", logo_url)
    snapshot.setdefault("email_reply_to", tenant.email_reply_to)
    snapshot.setdefault("vat_on_debits", bool(getattr(tenant, "vat_on_debits", False)))
    snapshot.setdefault(
        "payment_terms_block",
        {
            "payment_terms": inv.payment_terms,
            "late_payment_interest": tenant.late_payment_interest,
            "recovery_fee_eur": _legal_recovery_fee_eur(tenant),
            "discount_terms": tenant.discount_terms or "Néant",
        },
    )
    return snapshot


def _snapshot_customer(customer: Customer, customer_ctx: dict) -> dict:
    snapshot = dict(customer_ctx or {})
    legal_id = snapshot.get("legal_id") or customer.siret or customer.siren
    if legal_id:
        snapshot.setdefault("legal_id", legal_id)
        if SIRET_RE.fullmatch(legal_id):
            snapshot.setdefault("siret", legal_id)
    snapshot.setdefault("name", customer.name)
    snapshot.setdefault("email", customer.email)
    snapshot.setdefault("phone", customer.phone)
    snapshot.setdefault("contact_name", customer.contact_name)
    snapshot.setdefault("client_type", customer.client_type or "business")
    snapshot.setdefault("address", customer.address)
    snapshot.setdefault("address_line1", customer.address_line1)
    snapshot.setdefault("address_line2", customer.address_line2)
    snapshot.setdefault("postal_code", customer.postal_code)
    snapshot.setdefault("city", customer.city)
    snapshot.setdefault("country_code", customer.country_code or customer.country)
    snapshot.setdefault("vat_number", customer.vat_number)
    siren = snapshot.get("siren") or customer.siren
    if not siren and legal_id and len(legal_id) >= 9:
        siren = legal_id[:9]
    if siren:
        snapshot.setdefault("siren", siren)
    snapshot.setdefault("endpoint_id", customer.endpoint_id)
    snapshot.setdefault("pdp_name", customer.pdp_name)
    snapshot.setdefault("country", customer.country)
    snapshot.setdefault("payment_terms_default", customer.payment_terms_default)
    snapshot.setdefault("payment_method_default", customer.payment_method_default)
    return snapshot


def _snapshot_lines(lines: list[InvoiceLine]) -> list[dict[str, object]]:
    snapshot_lines: list[dict[str, object]] = []
    for line in lines:
        snapshot_lines.append(
            {
                "line_type": line.line_type or "item",
                "display_number": line.display_number,
                "reference": line.reference,
                "product_name": line.product_name,
                "detail": line.detail,
                "quantity": _decimal_str(quantize_amount(line.quantity)),
                "unit_price": _decimal_str(quantize_amount(line.unit_price)),
                "vat_rate": _decimal_str(quantize_amount(line.vat_rate)),
                "vat_category": line.vat_category,
                "exemption_reason_code": line.exemption_reason_code,
                "unit_code": line.unit_code,
                "item_id": line.item_id,
                "accounting_account": line.accounting_account,
                "line_total": _decimal_str(quantize_amount(line.line_total)),
            }
        )
    return snapshot_lines


def _snapshot_totals(inv: Invoice) -> dict[str, object]:
    return {
        "ht": _decimal_str(quantize_amount(inv.total_ex_vat)),
        "vat": _decimal_str(quantize_amount(inv.total_vat)),
        "ttc": _decimal_str(quantize_amount(inv.total_inc_vat)),
    }


def ensure_invoice_snapshot(db: Session, inv: Invoice) -> bool:
    changed = False
    tenant = None
    customer = db.get(Customer, inv.customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="Client introuvable.")
    options = inv.template_options if isinstance(inv.template_options, dict) else {}
    can_apply_issue_defaults = not any(
        (
            inv.issued_at,
            inv.pdf_key,
            inv.xml_key,
            inv.facturx_key,
            inv.pdf_checksum,
            inv.xml_checksum,
            inv.facturx_checksum,
        )
    )
    if can_apply_issue_defaults and options.get("_chorus_service_code_explicit") is not True:
        default_service_code = (customer.public_service_code or "").strip() or None
        if default_service_code != inv.public_service_code:
            inv.public_service_code = default_service_code
            changed = True
    if can_apply_issue_defaults and options.get("_chorus_commitment_explicit") is not True:
        default_commitment = (customer.public_commitment_reference or "").strip() or None
        if default_commitment != inv.purchase_order_number:
            inv.purchase_order_number = default_commitment
            changed = True
    if not inv.supplier_snapshot and not inv.seller_snapshot:
        tenant = tenant or db.get(Tenant, inv.tenant_id)
        if not tenant:
            raise HTTPException(status_code=404, detail="Entreprise introuvable.")
        supplier_snapshot = _snapshot_supplier(tenant, {}, inv)
        inv.supplier_snapshot = supplier_snapshot
        inv.seller_snapshot = supplier_snapshot
        changed = True
    elif not inv.supplier_snapshot and isinstance(inv.seller_snapshot, dict):
        inv.supplier_snapshot = inv.seller_snapshot
        changed = True
    elif not inv.seller_snapshot and isinstance(inv.supplier_snapshot, dict):
        inv.seller_snapshot = inv.supplier_snapshot
        changed = True

    if not inv.buyer_snapshot:
        inv.buyer_snapshot = _snapshot_customer(customer, {})
        changed = True

    if not isinstance(inv.lines_snapshot, list):
        lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == inv.id).order_by(InvoiceLine.id.asc()).all()
        inv.lines_snapshot = _snapshot_lines(lines)
        changed = True

    if not isinstance(inv.totals_snapshot, dict):
        inv.totals_snapshot = _snapshot_totals(inv)
        changed = True

    if inv.status in IMMUTABLE_STATUSES and not inv.issued_at:
        inv.issued_at = inv.issue_date or _utcnow()
        changed = True

    if changed:
        db.add(inv)
    return changed


def _sanity_checks_validation(invoice_id: str, db: Session, user: AuthUser):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == inv.id).order_by(InvoiceLine.id.asc()).all()
    original_number = inv.number
    original_issue_date = inv.issue_date
    original_due_date = inv.due_date
    try:
        if inv.status == "draft":
            inv.issue_date = inv.issue_date or _utcnow()
            if not inv.due_date_manual:
                inv.due_date = inv.due_date or _compute_due_date(inv.issue_date, inv.payment_terms, inv.due_days)
        if not inv.number:
            inv.number = f"DRAFT-{inv.id[:8]}"
        required_errors = validate_invoice_required_fields(inv, tenant, customer, lines)
        ctx = _ctx(db, inv)
        sanity_errors = validate_invoice_ctx(ctx)
    finally:
        inv.number = original_number
        inv.issue_date = original_issue_date
        inv.due_date = original_due_date
    errors = sorted(set(required_errors + sanity_errors))
    return {"errors": errors, "missing_fields": required_errors}


@router.get("/{invoice_id}/validate")
def validate(invoice_id: str, db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    return _sanity_checks_validation(invoice_id, db, user)


@router.get("/{invoice_id}/checks", deprecated=True)
def checks(invoice_id: str, db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    return _sanity_checks_validation(invoice_id, db, user)


@router.get("/{invoice_id}/validate-normative")
def validate_normative(
    invoice_id: str,
    format: str = Query(default="cii"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    base_dir = (settings.COMPLIANCE_ARTIFACTS_DIR or "").strip()
    if not base_dir:
        return JSONResponse(
            status_code=501,
            content={
                "configured": False,
                "issues": [],
                "message": "Validation normative non configurée.",
            },
        )
    fmt = (format or "cii").strip().lower()
    if fmt not in {"cii", "ubl"}:
        raise HTTPException(400, "Format invalide.")
    base_path = Path(base_dir)
    if fmt == "cii":
        xsd_path = base_path / "cii" / "cii.xsd"
        sch_path = base_path / "cii" / "cii.sch"
        xml_bytes = cii_invoice_xml(_ctx(db, inv))
    else:
        xsd_path = base_path / "ubl" / "ubl.xsd"
        sch_path = base_path / "ubl" / "ubl.sch"
        xml_bytes = ubl_document_xml(_ctx(db, inv))
    missing = [str(path) for path in (xsd_path, sch_path) if not path.exists()]
    if missing:
        logger.error(
            "normative_validation_artifacts_missing",
            extra={"format": fmt, "missing_count": len(missing)},
        )
        return JSONResponse(
            status_code=500,
            content={
                "configured": False,
                "issues": [],
                "message": "Les preuves de validation du document sont manquantes.",
            },
        )
    issues = []
    issues.extend(validate_xml_with_xsd(xml_bytes, xsd_path))
    issues.extend(validate_xml_with_schematron(xml_bytes, sch_path))
    return {"configured": True, "issues": [issue.to_dict() for issue in issues]}


@router.get("/{invoice_id}/pdf")
def get_pdf(
    invoice_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    return invoice_export_service.export_pdf(invoice_id, request, db, user)


@router.get("/{invoice_id}/preview.html")
def get_preview_html(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    inv = _invoice_for_read(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    html = invoice_html(_ctx(db, inv, allow_missing_identifiers=True))
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline';",
        },
    )


@router.get("/{invoice_id}/bundle.zip")
def get_bundle_zip(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    """Export ZIP (backoffice) : PDF + Factur-X (si dispo) + pièces jointes + meta.json."""
    from ..services.bundles import build_invoice_bundle_zip, stream_zip_file

    path, filename = build_invoice_bundle_zip(
        db,
        invoice_id=invoice_id,
        tenant_id=user.tenant_id,
        include_private_attachments=True,
    )
    return stream_zip_file(path, filename)


@router.get("/{invoice_id}/ubl.xml")
def get_ubl(
    invoice_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
    __: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    return invoice_export_service.export_ubl(invoice_id, request, db, user)


@router.get("/{invoice_id}/validation-report")
def get_validation_report(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    ensure_product_feature(tenant, "einvoicing_enabled")
    ctx = _ctx(db, inv, allow_missing_identifiers=True)

    cii_errors = validate_invoice_ctx(ctx)
    cii_report = _validation_status(cii_errors)

    ubl_report: dict[str, object] = {"status": "skipped", "errors": [], "enabled": False}
    if _ubl_export_enabled():
        ubl_errors = validate_ubl_ctx(ctx)
        ubl_report = _validation_status(ubl_errors)
        ubl_report["enabled"] = True

    fr_checks = validate_fr_einvoicing_fields(inv, tenant, customer)

    pdfa_proof: dict[str, object] = {
        "available": False,
        "sha256": None,
        "stored_status": inv.pdfa3_status,
        "stored_report": sanitize_public_pdfa_report(inv.pdfa3_report, inv.pdfa3_status),
        "verapdf": public_verapdf_result(available=False, ok=None),
    }
    pdf_bytes = None
    if inv.facturx_key and head_object(inv.facturx_key):
        pdf_bytes = get_object_bytes(inv.facturx_key)
    if pdf_bytes:
        pdfa_proof["available"] = True
        pdfa_proof["sha256"] = hashlib.sha256(pdf_bytes).hexdigest()
        if shutil.which("verapdf"):
            with NamedTemporaryFile(suffix=".pdf") as tmp_pdf:
                tmp_pdf.write(pdf_bytes)
                tmp_pdf.flush()
                ok, output = _run_verapdf(tmp_pdf.name)
            if not ok:
                validation_logger.warning(
                    "invoice_verapdf_validation_failed",
                    extra={
                        "invoice_id": inv.id,
                        "validator_output": output[:8000] if output else None,
                        "validator_output_truncated": bool(output and len(output) > 8000),
                    },
                )
            pdfa_proof["verapdf"] = public_verapdf_result(available=True, ok=ok)
    else:
        pdfa_proof["reason"] = "PDF Factur-X indisponible."

    return {
        "invoice_id": inv.id,
        "cii_sanity_checks": cii_report,
        "ubl_en16931": ubl_report,
        "fr_checks": fr_checks,
        "pdfa": pdfa_proof,
    }


@router.get("/{invoice_id}/compliance-report")
def get_compliance_report(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    ensure_product_feature(tenant, "einvoicing_enabled")
    ctx = _ctx(db, inv, allow_missing_identifiers=True)
    transmissions = (
        db.query(EInvoicingTransmission)
        .filter(EInvoicingTransmission.invoice_id == inv.id)
        .order_by(EInvoicingTransmission.updated_at.desc(), EInvoicingTransmission.created_at.desc())
        .all()
    )
    report = build_compliance_report(inv, tenant, customer, ctx, transmissions)
    store_compliance_report_json(inv.id, report, retain_until=_invoice_artifact_retain_until(inv))
    return report


@router.get("/{invoice_id}/compliance-report.pdf")
def get_compliance_report_pdf(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    ensure_product_feature(tenant, "einvoicing_enabled")
    ctx = _ctx(db, inv, allow_missing_identifiers=True)
    transmissions = (
        db.query(EInvoicingTransmission)
        .filter(EInvoicingTransmission.invoice_id == inv.id)
        .order_by(EInvoicingTransmission.updated_at.desc(), EInvoicingTransmission.created_at.desc())
        .all()
    )
    report = build_compliance_report(inv, tenant, customer, ctx, transmissions)
    retain_until = _invoice_artifact_retain_until(inv)
    store_compliance_report_json(inv.id, report, retain_until=retain_until)
    pdf_bytes = render_compliance_report_pdf(report)
    store_compliance_report_pdf(inv.id, pdf_bytes, retain_until=retain_until)
    filename = _safe_filename("rapport-conformite", inv.number, "pdf")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers=_export_attachment_headers(filename),
    )


@router.get("/{invoice_id}/evidence")
def get_invoice_evidence(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    ensure_product_feature(tenant, "einvoicing_enabled")

    hashes, hashes_changed = _ensure_invoice_hashes(inv)
    if hashes_changed:
        db.add(inv)
        db.commit()
        db.refresh(inv)

    transmissions = (
        db.query(EInvoicingTransmission)
        .filter(EInvoicingTransmission.invoice_id == inv.id)
        .order_by(EInvoicingTransmission.created_at.asc(), EInvoicingTransmission.updated_at.asc())
        .all()
    )
    tx_ids = [tx.id for tx in transmissions]
    events_by_tx: dict[str, list[dict[str, object]]] = {}
    if tx_ids:
        events = (
            db.query(TransmissionEvent)
            .filter(TransmissionEvent.transmission_id.in_(tx_ids))
            .order_by(TransmissionEvent.occurred_at.asc(), TransmissionEvent.created_at.asc())
            .all()
        )
        for ev in events:
            payload = ev.payload_raw if isinstance(ev.payload_raw, dict) else {}
            events_by_tx.setdefault(ev.transmission_id, []).append(
                {
                    "id": ev.id,
                    "event_type": ev.event_type,
                    "status": ev.status_code_norme,
                    "message": _sanitize_text(payload.get("message")),
                    "raw_status": _sanitize_text(payload.get("raw_status")),
                    "errors": _sanitize_errors(payload.get("errors")),
                    "source": _sanitize_text(payload.get("source")),
                    "occurred_at": _iso(ev.occurred_at),
                }
            )

    transmission_items: list[dict[str, object]] = []
    for tx in transmissions:
        transmission_items.append(
            {
                "id": tx.id,
                "channel": tx.channel,
                "external_id": tx.external_id,
                "status": tx.status,
                "payload_hash": tx.payload_hash,
                "created_at": _iso(tx.created_at),
                "updated_at": _iso(tx.updated_at),
                "events": events_by_tx.get(tx.id, []),
            }
        )

    audit_rows = (
        db.query(ActionLog)
        .filter(
            ActionLog.tenant_id == user.tenant_id,
            ActionLog.entity == "invoice",
            ActionLog.entity_id == inv.id,
        )
        .order_by(ActionLog.created_at.asc())
        .all()
    )
    audit_items: list[dict[str, object]] = []
    for log in audit_rows:
        audit_items.append(
            {
                "id": log.id,
                "created_at": _iso(log.created_at),
                "action": log.action,
                "actor_id": log.user_id,
                "payload": redact_audit_payload(log.payload),
            }
        )

    report = {
        "schema_version": "2026-01",
        "kind": "invoice_evidence",
        "generated_at": _utcnow().replace(microsecond=0).isoformat() + "Z",
        "invoice": {
            "id": inv.id,
            "number": inv.number,
            "status": inv.status,
            "type": inv.type,
            "currency": inv.currency,
            "total_ex_vat": _decimal_str(inv.total_ex_vat),
            "total_vat": _decimal_str(inv.total_vat),
            "total_inc_vat": _decimal_str(inv.total_inc_vat),
            "tenant_id": inv.tenant_id,
            "customer_id": inv.customer_id,
        },
        "timestamps": {
            "created_at": _iso(inv.created_at),
            "issued_at": _iso(inv.issued_at),
            "sent_at": _iso(inv.sent_at),
            "paid_at": _iso(inv.paid_at),
        },
        "hashes": hashes,
        "artifacts": {
            "pdf": {"available": bool(inv.pdf_key)},
            "cii_xml": {"available": bool(inv.xml_key)},
            "facturx_pdf": {"available": bool(inv.facturx_key)},
        },
        "transmissions": transmission_items,
        "audit_log": audit_items,
        "storage": storage_integrity_info(),
    }
    filename = _safe_filename("dossier-preuve", inv.number, "json")
    return JSONResponse(
        status_code=200,
        content=report,
        headers=_export_attachment_headers(filename),
    )


@router.get("/{invoice_id}/cii.xml")
def get_cii(
    invoice_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
    __: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    return invoice_export_service.export_cii(invoice_id, request, db, user)


@router.get("/{invoice_id}/facturx.pdf")
def get_facturx(
    invoice_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _paid: AuthUser = Depends(require_paid_subscription_or_trial),
    __: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    return invoice_export_service.export_facturx(invoice_id, request, db, user)


@router.get("/{invoice_id}/facturx/validate")
def validate_facturx(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
    __: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    ctx = None
    xml_bytes = None
    if inv.xml_key and head_object(inv.xml_key):
        xml_bytes = _load_invoice_artifact(inv, "xml")
    if not xml_bytes:
        ctx = _ctx(db, inv)
        xml_bytes = cii_invoice_xml(ctx)
    if ctx is None:
        ctx = _ctx(db, inv)
    profile = resolve_facturx_profile(ctx, inv.issued_profile)
    issues = validate_facturx_xml_issues(xml_bytes, profile)
    errors = [issue for issue in issues if issue.get("level") != "warning"]
    warnings = [issue for issue in issues if issue.get("level") == "warning"]
    return {
        "invoice_id": inv.id,
        "status": "ok" if not errors else "error",
        "errors": [issue.get("message") for issue in errors if issue.get("message")],
        "warnings": [issue.get("message") for issue in warnings if issue.get("message")],
        "issues": issues,
        "facturx_profile": normalize_facturx_profile(profile),
        "facturx_spec_version": settings.FACTURX_SPEC_VERSION,
    }


@router.post("/{invoice_id}/facturx/rebuild")
def rebuild_facturx(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status not in IMMUTABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail={"code": "facturx_not_issued", "message": "Facture non émise."},
        )
    if _invoice_artifact_metadata_locked(inv, "FACTURX"):
        facturx_artifact = _get_invoice_artifact(db, inv, "FACTURX")
        if facturx_artifact:
            _ensure_invoice_artifact_integrity(db, inv, facturx_artifact, "facturx")
        _raise_invoice_artifact_integrity_error(inv, "FACTURX", "rebuild_existing_facturx")
    ctx = _ctx(db, inv)
    pdf_artifact = ensure_invoice_artifact(db, inv, "pdf", ctx)
    _ensure_invoice_artifact_integrity(db, inv, pdf_artifact, "pdf")
    xml_artifact = ensure_invoice_artifact(db, inv, "cii", ctx)
    _ensure_invoice_artifact_integrity(db, inv, xml_artifact, "cii")
    pdf_bytes = _load_invoice_artifact(inv, "pdf")
    xml_bytes = _load_invoice_artifact(inv, "xml")
    if not pdf_bytes or not xml_bytes:
        _raise_invoice_artifact_integrity_error(inv, "FACTURX", "rebuild_source_missing")
    try:
        pdf_fx, pdfa_status, pdfa_report = facturx_from_pdf_xml_with_meta(
            pdf_bytes,
            xml_bytes,
            inv.issued_profile,
        )
    except FacturxXsdValidationError as exc:
        _raise_facturx_xsd_error(exc)
    except FacturxSchematronValidationError as exc:
        _raise_facturx_schematron_error(exc)
    except FacturxEmbedError as exc:
        _raise_facturx_embed_error(exc)
    except FacturxPdfa3Error as exc:
        _raise_facturx_pdfa_error(exc)
    _store_facturx_result(inv, pdf_fx, pdfa_status, pdfa_report)
    db.add(inv)
    db.commit()
    return {
        "ok": True,
        "pdfa3_status": inv.pdfa3_status,
        "pdfa3_report": sanitize_public_pdfa_report(inv.pdfa3_report, inv.pdfa3_status),
        "facturx_spec_version": inv.facturx_spec_version,
    }


@router.get("/{invoice_id}/payments", response_model=list[PaymentOut])
def list_payments(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    return db.query(Payment).filter(Payment.invoice_id == inv.id).order_by(Payment.date.desc()).all()


def _infer_payment_settlement_mode(payload: PaymentCreate) -> str | None:
    if payload.settlement_mode:
        return payload.settlement_mode
    method = (payload.method or "").strip().lower()
    if method in {"especes", "espèces", "cash"}:
        return "cash"
    if method in {"manuel", "manual", "sans_transaction", "sans transaction"}:
        return "manual"
    if method:
        return "bank"
    return None


def _payment_audit_payload(payment: Payment) -> dict[str, object]:
    return {
        "amount": float(payment.amount or 0),
        "method": payment.method,
        "reference": payment.reference,
        "settlement_mode": payment.settlement_mode,
        "accounting_category": payment.accounting_category,
        "receipt_label": payment.receipt_label,
        "receipt_url": payment.receipt_url,
        "date": payment.date.isoformat() if payment.date else None,
    }


def _latest_seqino_transmission(db: Session, invoice_id: str) -> EInvoicingTransmission | None:
    return (
        db.query(EInvoicingTransmission)
        .filter(
            EInvoicingTransmission.invoice_id == invoice_id,
            EInvoicingTransmission.channel == "seqino",
            EInvoicingTransmission.external_id.isnot(None),
        )
        .order_by(EInvoicingTransmission.created_at.desc())
        .first()
    )


def _ensure_seqino_cashed_action_mutable(db: Session, inv: Invoice) -> None:
    transmission = _latest_seqino_transmission(db, inv.id)
    if not transmission:
        return
    outbox = (
        db.query(EInvoicingActionOutbox)
        .filter(
            EInvoicingActionOutbox.tenant_id == inv.tenant_id,
            EInvoicingActionOutbox.transmission_id == transmission.id,
            EInvoicingActionOutbox.provider_slug == "seqino",
            EInvoicingActionOutbox.action == "mark_as_cashed",
            EInvoicingActionOutbox.state.in_({"completed", "reconciliation_required", "submitting"}),
        )
        .order_by(EInvoicingActionOutbox.created_at.desc())
        .first()
    )
    if not outbox:
        return
    state = str(outbox.state or "").strip().lower()
    if state == "reconciliation_required":
        code = "seqino_cashed_reconciliation_required"
        message = (
            "Le statut réglementaire d'encaissement est incertain. "
            "Contactez le support avant de modifier les règlements."
        )
    elif state == "submitting":
        code = "seqino_cashed_action_in_progress"
        message = "La déclaration réglementaire d'encaissement est en cours."
    else:
        code = "seqino_cashed_payment_locked"
        message = (
            "L'encaissement a déjà été transmis à la plateforme partenaire. "
            "Les règlements associés ne peuvent plus être modifiés ou supprimés."
        )
    raise HTTPException(409, detail={"code": code, "message": message})


async def _sync_seqino_cashed_action(
    db: Session,
    *,
    inv: Invoice,
    payment_id: str,
) -> str | None:
    transmission = _latest_seqino_transmission(db, inv.id)
    if not transmission or not transmission.external_id:
        return None
    if not is_connected_mode_operational(db, inv.tenant_id, "seqino"):
        return None
    if not seqino_has_active_mandate_for_tenant_issuer(inv.tenant_id, db=db):
        return None
    connection = (
        db.query(PdpConnection)
        .filter(
            PdpConnection.tenant_id == inv.tenant_id,
            PdpConnection.provider_slug == "seqino",
            PdpConnection.status == "connected",
        )
        .first()
    )
    if not connection:
        return None
    provider, _credentials = _resolve_provider(connection, db)
    # The mandate can be revoked after the payment was committed or while the
    # connector was being resolved.  Re-check immediately before creating an
    # outbox row or invoking the remote callback.
    if not seqino_has_active_mandate_for_tenant_issuer(inv.tenant_id, db=db):
        return None
    try:
        outbox = await execute_idempotent_provider_action(
            db,
            tenant_id=inv.tenant_id,
            provider_slug="seqino",
            external_id=transmission.external_id,
            action="mark_as_cashed",
            callback=lambda: provider.mark_invoice_cashed(transmission.external_id),
            transmission_id=transmission.id,
            reference_id=payment_id,
        )
        return str(outbox.state or "").strip().lower() or None
    except PdpProviderError as exc:
        logger.warning(
            "seqino_mark_as_cashed_not_confirmed",
            extra={
                "tenant_id": inv.tenant_id,
                "invoice_id": inv.id,
                "transmission_id": transmission.id,
                "code": exc.code,
            },
        )
        return exc.code or "failed"
    except Exception:
        logger.exception(
            "seqino_mark_as_cashed_failed",
            extra={
                "tenant_id": inv.tenant_id,
                "invoice_id": inv.id,
                "transmission_id": transmission.id,
            },
        )
        return "failed"


@router.post("/{invoice_id}/payments", response_model=PaymentOut)
async def add_payment(
    invoice_id: str,
    payload: PaymentCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status in {"draft", "canceled"}:
        raise HTTPException(400, "Cette facture est encore en brouillon ou a été annulée.")
    if not inv.number:
        raise HTTPException(400, "Numéro manquant : émettez la facture avant envoi.")
    if payload.amount is None or payload.amount <= 0:
        raise HTTPException(400, "Le montant du règlement doit être positif.")
    if inv.type == "credit_note":
        raise HTTPException(400, "Un avoir ne peut pas recevoir de paiement.")
    _ensure_invoice_accounting_period_unlocked(db, inv, action="add_payment")
    payment_date = payload.date or _utcnow()
    _ensure_invoice_financial_movement_period_unlocked(
        db,
        inv,
        movement_date=payment_date,
        action="add_payment",
    )
    outstanding_before_payment = _outstanding(db, inv)
    if outstanding_before_payment <= 0:
        raise HTTPException(400, "Cette facture est déjà soldée.")
    payment_amount = Decimal(str(payload.amount))
    if payment_amount > outstanding_before_payment:
        raise HTTPException(400, "Le montant dépasse le reste dû.")
    duplicate_query = db.query(Payment).filter(Payment.invoice_id == inv.id, Payment.amount == payload.amount)
    reference = (payload.reference or "").strip()
    if reference:
        duplicate_query = duplicate_query.filter(Payment.reference == reference)
    recent_candidates = duplicate_query.order_by(Payment.date.desc()).limit(10).all()
    for candidate in recent_candidates:
        candidate_date = candidate.date or candidate.created_at
        if not candidate_date:
            continue
        delta = abs((candidate_date.replace(tzinfo=None) - payment_date.replace(tzinfo=None)).total_seconds())
        if delta <= 300:
            raise HTTPException(
                409,
                detail={
                    "code": "duplicate_payment_suspected",
                    "message": "Un règlement identique vient déjà d'être enregistré sur cette facture.",
                    "payment_id": candidate.id,
                },
            )
    payment = Payment(
        invoice_id=inv.id,
        amount=payload.amount,
        method=payload.method,
        reference=payload.reference,
        settlement_mode=_infer_payment_settlement_mode(payload),
        accounting_category=payload.accounting_category,
        receipt_label=payload.receipt_label,
        receipt_url=payload.receipt_url,
        date=payment_date,
        created_by=user.id,
    )
    db.add(payment)
    db.flush()
    remaining = outstanding_before_payment - payment_amount
    now = _utcnow()
    if remaining <= Decimal("0.01"):
        inv.paid_at = payment.date or now
        _transition(inv, "paid", db, user)
    else:
        if inv.due_date and inv.due_date < now:
            _transition(inv, "overdue", db, user)
        else:
            _transition(inv, "partial", db, user)
    _log_action(
        db,
        user,
        inv.tenant_id,
        "payment",
        payment.id,
        "add_payment",
        {"invoice_id": inv.id, **_payment_audit_payload(payment)},
    )
    db.commit()
    db.refresh(payment)
    if remaining <= Decimal("0.01"):
        await _sync_seqino_cashed_action(db, inv=inv, payment_id=payment.id)
    return payment


@router.patch("/{invoice_id}/payments/{payment_id}", response_model=PaymentOut)
async def update_payment(
    invoice_id: str,
    payment_id: str,
    payload: PaymentCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.type == "credit_note":
        raise HTTPException(400, "Un avoir ne peut pas recevoir de paiement.")
    payment = db.get(Payment, payment_id)
    if not payment or payment.invoice_id != inv.id:
        raise HTTPException(404, "Paiement introuvable.")
    _ensure_seqino_cashed_action_mutable(db, inv)
    if payload.amount is None or payload.amount <= 0:
        raise HTTPException(400, "Le montant du règlement doit être positif.")
    _ensure_invoice_accounting_period_unlocked(db, inv, action="update_payment")
    _ensure_invoice_financial_movement_period_unlocked(
        db,
        inv,
        movement_date=payment.date,
        action="update_payment",
    )
    if payload.date is not None and payload.date != payment.date:
        _ensure_invoice_financial_movement_period_unlocked(
            db,
            inv,
            movement_date=payload.date,
            action="update_payment",
        )

    other_total = (
        db.query(func.coalesce(func.sum(Payment.amount), 0))
        .filter(Payment.invoice_id == inv.id, Payment.id != payment.id)
        .scalar()
    )
    credits_total = _credit_notes_total(db, inv)
    max_amount = invoice_balance_due_amount(
        inv.total_inc_vat,
        invoice_effective_template_options(db, inv),
        credits=credits_total,
        paid=other_total or 0,
    )
    if max_amount <= Decimal("0"):
        raise HTTPException(400, "Aucun solde disponible pour ce règlement.")
    amount = Decimal(str(payload.amount))
    if amount > max_amount + Decimal("0.01"):
        raise HTTPException(400, "Le montant dépasse le reste dû une fois les autres règlements déduits.")

    before = _payment_audit_payload(payment)
    payment.amount = payload.amount
    payment.method = payload.method
    payment.reference = payload.reference
    payment.settlement_mode = _infer_payment_settlement_mode(payload)
    payment.accounting_category = payload.accounting_category
    payment.receipt_label = payload.receipt_label
    payment.receipt_url = payload.receipt_url
    if payload.date is not None:
        payment.date = payload.date
    db.add(payment)
    db.flush()
    _log_action(
        db,
        user,
        inv.tenant_id,
        "payment",
        payment.id,
        "update_payment",
        {
            "invoice_id": inv.id,
            "before": before,
            "after": _payment_audit_payload(payment),
        },
    )
    _recalculate_invoice_status_after_payment_change(
        db, inv, user, reason="payment_update", reference_date=payment.date
    )
    db.commit()
    db.refresh(payment)
    if _outstanding(db, inv) <= Decimal("0.01"):
        await _sync_seqino_cashed_action(db, inv=inv, payment_id=payment.id)
    return payment


@router.delete("/{invoice_id}/payments/{payment_id}")
def delete_payment(
    invoice_id: str,
    payment_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.type == "credit_note":
        raise HTTPException(400, "Un avoir ne peut pas recevoir de paiement.")
    payment = db.get(Payment, payment_id)
    if not payment or payment.invoice_id != inv.id:
        raise HTTPException(404, "Paiement introuvable.")
    _ensure_seqino_cashed_action_mutable(db, inv)
    _ensure_invoice_accounting_period_unlocked(db, inv, action="delete_payment")
    _ensure_invoice_financial_movement_period_unlocked(
        db,
        inv,
        movement_date=payment.date,
        action="delete_payment",
    )

    snapshot = _payment_audit_payload(payment)
    db.delete(payment)
    db.flush()
    _log_action(db, user, inv.tenant_id, "payment", payment_id, "delete_payment", {"invoice_id": inv.id, **snapshot})
    _recalculate_invoice_status_after_payment_change(db, inv, user, reason="payment_delete")
    db.commit()
    return {"ok": True, "invoice_status": inv.status, "invoice_id": inv.id}


@router.get("/{invoice_id}/refunds", response_model=list[CreditNoteRefundOut])
def list_credit_note_refunds(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.type != "credit_note":
        return []
    return (
        db.query(CreditNoteRefund)
        .filter(CreditNoteRefund.invoice_id == inv.id)
        .order_by(CreditNoteRefund.date.desc())
        .all()
    )


@router.post("/{invoice_id}/refunds", response_model=CreditNoteRefundOut)
def add_credit_note_refund(
    invoice_id: str,
    payload: CreditNoteRefundCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.type != "credit_note":
        raise HTTPException(400, "Ce document n'est pas un avoir.")
    if inv.status == "draft":
        raise HTTPException(409, "Émettez l'avoir avant d'enregistrer un remboursement.")
    if payload.amount is None or payload.amount <= 0:
        raise HTTPException(400, "Le montant du remboursement doit être positif.")
    _ensure_invoice_accounting_period_unlocked(db, inv, action="add_refund")
    refund_date = payload.date or _utcnow()
    _ensure_invoice_financial_movement_period_unlocked(
        db,
        inv,
        movement_date=refund_date,
        action="add_refund",
    )

    total_credit = abs(Decimal(str(inv.total_inc_vat or 0)))
    already_refunded = _refunds_total(db, inv)
    remaining = total_credit - already_refunded
    if remaining <= Decimal("0.01"):
        raise HTTPException(400, "Cet avoir est déjà remboursé.")
    amount = Decimal(str(payload.amount))
    if amount > remaining + Decimal("0.01"):
        raise HTTPException(400, "Le montant dépasse le reste à rembourser.")

    refund = CreditNoteRefund(
        invoice_id=inv.id,
        amount=payload.amount,
        method=payload.method,
        reference=payload.reference,
        date=refund_date,
        created_by=user.id,
    )
    db.add(refund)
    db.flush()

    new_total = already_refunded + amount
    now = _utcnow()
    if new_total >= total_credit - Decimal("0.01"):
        inv.paid_at = refund.date or now
        _transition(inv, "paid", db, user, {"refund_total": float(new_total)})
    else:
        _transition(inv, "partial", db, user, {"refund_total": float(new_total)})

    _log_action(
        db,
        user,
        inv.tenant_id,
        "credit_note_refund",
        refund.id,
        "add_refund",
        {"invoice_id": inv.id, "amount": float(payload.amount), "method": payload.method},
    )
    db.commit()
    db.refresh(refund)
    return refund


@router.post("/{invoice_id}/send")
def mark_sent(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _: AuthUser = Depends(require_paid_subscription),
):
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status in {"draft", "canceled"}:
        raise HTTPException(400, "Cette facture est encore en brouillon ou a été annulée.")
    if not inv.number:
        raise HTTPException(400, "Numéro manquant : émettez la facture avant envoi.")
    inv.sent_at = _utcnow()
    if not inv.due_date:
        inv.due_date = _compute_due_date(inv.issue_date or _utcnow(), inv.payment_terms, inv.due_days)
    _transition(inv, "sent", db, user)
    db.commit()
    return {"ok": True, "status": inv.status}


def _issue_job_error(
    code: str,
    message: str,
    status_code: int,
    errors: list | None = None,
    fields: list[str] | None = None,
) -> dict:
    safe_status = status_code if 400 <= status_code <= 599 else 400
    safe_code = code if re.fullmatch(r"[a-z][a-z0-9_.:-]{1,79}", str(code or "")) else f"HTTP_{safe_status}"
    payload = {
        "code": safe_code,
        "message": sanitize_public_error_message(
            message,
            status_code=safe_status,
            fallback="La facture ne peut pas être émise avec les informations actuelles.",
        ),
        "status_code": safe_status,
    }
    if errors is not None:
        payload["errors"] = [
            sanitize_public_error_message(
                error,
                status_code=safe_status,
                fallback="Une donnée de la facture doit être corrigée.",
                max_chars=500,
            )
            for error in errors[:100]
            if isinstance(error, str)
        ]
    if fields is not None:
        payload["fields"] = [
            field for field in fields[:100] if isinstance(field, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", field)
        ]
    return {"ok": False, "error": payload}


def _issue_error_from_exception(exc: HTTPException) -> dict:
    detail = exc.detail
    code = None
    message = None
    errors = None
    fields = None
    if isinstance(detail, dict):
        code = detail.get("code") or None
        message = detail.get("message") or detail.get("detail")
        errors = detail.get("errors")
        fields = detail.get("fields")
    elif isinstance(detail, str):
        message = detail
    return _issue_job_error(code or f"HTTP_{exc.status_code}", message or "Erreur", exc.status_code, errors, fields)


def _fr_einvoicing_error_payload(fields: list[str], errors: list | None = None) -> dict:
    payload = fr_einvoicing_error(fields)
    raw_errors = errors if errors is not None else fields
    payload["errors"] = [
        sanitize_public_error_message(
            error,
            status_code=422,
            fallback="Une donnée de la facture doit être corrigée.",
            max_chars=500,
        )
        for error in raw_errors[:100]
        if isinstance(error, str)
    ]
    return payload


def _fr_einvoicing_missing_response(fields: list[str], errors: list | None = None) -> JSONResponse:
    return JSONResponse(status_code=422, content=_fr_einvoicing_error_payload(fields, errors))


def issue_invoice_job(invoice_id: str, tenant_id: str, user_id: str | None) -> dict:
    return invoice_issue_service.issue_invoice_job(invoice_id, tenant_id, user_id)


def _issue_sync_response(result: dict) -> Response:
    if result.get("ok"):
        raw_auto_submit = result.get("auto_submit")
        auto_submit = None
        if isinstance(raw_auto_submit, dict):
            result_code = str(raw_auto_submit.get("result") or "").strip().lower()
            auto_submit = {
                "attempted": bool(raw_auto_submit.get("attempted")),
                "result": (
                    result_code if re.fullmatch(r"[a-z][a-z0-9_.:-]{1,79}", result_code) else "unknown"
                ),
                "message": sanitize_public_error_message(
                    raw_auto_submit.get("message"),
                    status_code=409,
                    fallback="La transmission automatique n’a pas pu être confirmée.",
                ),
            }
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "status": result.get("status"),
                "due_date": result.get("due_date"),
                "auto_submit": auto_submit,
            },
        )
    error = result.get("error") or {}
    code = error.get("code")
    try:
        status_code = int(error.get("status_code") or 400)
    except (TypeError, ValueError):
        status_code = 400
    if status_code < 400 or status_code > 599:
        status_code = 400
    message = sanitize_public_error_message(
        error.get("message"),
        status_code=status_code,
        fallback="La facture ne peut pas être émise avec les informations actuelles.",
    )
    raw_errors = error.get("errors") or []
    if not isinstance(raw_errors, (list, tuple)):
        raw_errors = []
    errors = [
        sanitize_public_error_message(
            item,
            status_code=status_code,
            fallback="Une donnée de la facture doit être corrigée.",
            max_chars=500,
        )
        for item in raw_errors[:100]
        if isinstance(item, str)
    ]
    raw_fields = error.get("fields") or []
    if not isinstance(raw_fields, (list, tuple)):
        raw_fields = []
    fields = [
        field for field in raw_fields[:100] if isinstance(field, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", field)
    ]
    if code == "fr_einvoicing_missing_fields":
        return JSONResponse(
            status_code=status_code,
            content=_fr_einvoicing_error_payload(fields or [], errors),
        )
    if code == "fr_invoice_missing_fields":
        if not errors and fields:
            errors = fields
        return JSONResponse(
            status_code=status_code,
            content={
                "error": {"code": code, "message": message},
                "errors": errors,
                "fields": fields,
            },
        )
    if code == "sanity_checks_failed":
        return JSONResponse(
            status_code=status_code,
            content={
                "code": code,
                "message": message,
                "errors": errors,
            },
        )
    if code in {"ubl_en16931_invalid", "ubl_validation_unavailable"}:
        return JSONResponse(
            status_code=status_code,
            content={
                "code": code,
                "message": message,
                "errors": errors,
            },
        )
    detail = {"code": code, "message": message} if code else message
    raise HTTPException(status_code=status_code, detail=detail)


@router.post("/{invoice_id}/issue")
def mark_issued(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription),
):
    _require_role_accountant(user)
    return invoice_issue_service.issue_invoice(invoice_id, db, user)


@router.post("/{invoice_id}/submit-pdp")
async def submit_pdp(
    invoice_id: str,
    payload: PdpSubmitRequest | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _: AuthUser = Depends(require_paid_subscription),
    __: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status not in IMMUTABLE_STATUSES:
        raise HTTPException(400, "La facture doit être émise avant soumission à une plateforme agréée.")
    if not inv.pdf_key or not inv.xml_key:
        raise HTTPException(400, "Les fichiers de la facture émise sont incomplets. Émettez de nouveau la facture.")
    provider_slug = payload.provider_slug if payload else None
    conn = _resolve_pdp_connection(db, inv.tenant_id, provider_slug)
    if (conn.status or "").lower() != "connected":
        raise HTTPException(400, "Connexion plateforme agréée inactive.")
    ensure_connected_mode_operational(db, inv.tenant_id, conn.provider_slug)
    from ..utils.crypto import decrypt_payload

    creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
    creds["_tenant_id"] = inv.tenant_id
    try:
        platform = get_provider(conn.provider_slug, creds)
    except Exception:
        raise HTTPException(400, "La plateforme agréée sélectionnée est inconnue.")
    if getattr(platform, "kind", "b2b") != "b2b":
        raise HTTPException(400, "Cette plateforme n’est pas compatible avec la facturation électronique B2B.")
    ctx = _ctx(db, inv)
    try:
        tx = await submit_einvoice(
            db,
            provider=platform,
            invoice=inv,
            tenant_id=inv.tenant_id,
            channel=conn.provider_slug,
            ctx=ctx,
            poll_status=True,
            raise_on_error=True,
            source="invoice_submit",
            actor_user_id=user.id,
        )
    except UsageQuotaExceeded:
        raise
    except ValueError as exc:
        raise HTTPException(
            400,
            sanitize_public_error_message(
                exc,
                status_code=400,
                fallback="La facture ne peut pas être transmise dans son état actuel.",
            ),
        ) from exc
    except PdpProviderError as exc:
        status_code = _provider_error_status(exc)
        detail = {
            "code": exc.code or "pdp_submit_failed",
            "message": sanitize_public_error_message(
                exc,
                status_code=status_code,
                fallback="La plateforme agréée n’a pas pu traiter la facture. Réessayez plus tard.",
            ),
        }
        if exc.code in {
            "token_balance_insufficient",
            "trial_einvoicing_transmissions_disabled",
            "trial_seqino_transmissions_disabled",
        }:
            detail["remediation_url"] = "/app/billing"
        raise HTTPException(status_code=status_code, detail=detail)
    except Exception:
        raise HTTPException(502, "Erreur lors de la soumission plateforme.")
    if _pdp_status_blocks_invoice_sent(tx):
        db.commit()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "pdp_submission_not_sent",
                "message": "La plateforme n'a pas accepté la transmission. La facture n'est pas marquée comme envoyée.",
                "status": tx.status,
                "transmission_id": tx.id,
            },
        )
    _mark_invoice_sent_after_pdp_submission(db, inv, tx, user, provider_slug=conn.provider_slug)
    db.commit()
    return {"ok": True, "provider_slug": conn.provider_slug, "transmission_id": tx.id}


@router.get("/{invoice_id}/pdp-status", response_model=PdpStatusResponse)
async def pdp_status(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _feature_user: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    transmissions = (
        db.query(EInvoicingTransmission)
        .filter(EInvoicingTransmission.invoice_id == inv.id)
        .order_by(EInvoicingTransmission.created_at.desc())
        .all()
    )
    items = []
    for tx in transmissions:
        message = None
        events = tx.events if isinstance(tx.events, list) else None
        safe_events: list[dict[str, object]] = []
        if events:
            for event in events[-20:]:
                if not isinstance(event, dict):
                    continue
                safe_event: dict[str, object] = {}
                event_type = str(event.get("event_type") or "").strip()[:80]
                event_status = str(event.get("status") or "").strip()[:80]
                event_message = sanitize_public_provider_message(event.get("message"), max_chars=500)
                raw_event_errors = event.get("errors")
                event_errors = []
                if isinstance(raw_event_errors, list):
                    event_errors = [
                        safe
                        for error in raw_event_errors[:10]
                        if (safe := sanitize_public_provider_message(error, max_chars=300))
                    ]
                if event_type:
                    safe_event["event_type"] = event_type
                if event_status:
                    safe_event["status"] = event_status
                if event_message:
                    safe_event["message"] = event_message
                if event_errors:
                    safe_event["errors"] = event_errors
                if safe_event:
                    safe_events.append(safe_event)
            last = events[-1]
            if isinstance(last, dict):
                errors = last.get("errors")
                if isinstance(errors, list) and errors:
                    safe_errors = [
                        safe for error in errors if (safe := sanitize_public_provider_message(error, max_chars=500))
                    ]
                    message = " ; ".join(safe_errors)[:500] if safe_errors else None
                elif isinstance(errors, str) and errors.strip():
                    message = sanitize_public_provider_message(errors, max_chars=500)
                fallback_message = sanitize_public_provider_message(
                    last.get("message") or last.get("raw_status") or last.get("status"),
                    max_chars=500,
                )
                if fallback_message and fallback_message.strip().lower() not in {
                    "blocked",
                    "error",
                    "failed",
                    "invalid",
                    "refused",
                    "rejected",
                    "statut synchronise",
                    "statut synchronisé",
                    "unknown",
                }:
                    message = message or fallback_message
        if not message and (tx.status or "").strip().lower() in {
            "blocked",
            "error",
            "failed",
            "invalid",
            "refused",
            "rejected",
        }:
            message = "Motif non fourni par la plateforme."
        items.append(
            {
                "id": tx.id,
                "provider_slug": tx.channel,
                "external_id": tx.external_id,
                "status": tx.status,
                "delivery_state": tx.delivery_state or "pending",
                "attempt_count": int(tx.attempt_count or 0),
                "events": safe_events or None,
                "message": message,
                "created_at": tx.created_at,
                "updated_at": tx.updated_at,
            }
        )
    latest = items[0] if items else None
    return {"latest": latest, "history": items}


@router.post("/{invoice_id}/pay")
async def mark_paid(
    invoice_id: str,
    amount: float | None = Query(None, description="Montant du règlement optionnel"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status in {"draft", "canceled"}:
        raise HTTPException(400, "Cette facture est encore en brouillon ou a été annulée.")
    if not inv.number:
        raise HTTPException(400, "Numéro manquant : émettez la facture avant envoi.")
    if inv.type == "credit_note":
        raise HTTPException(400, "Un avoir n'est pas payable.")
    _ensure_invoice_accounting_period_unlocked(db, inv, action="mark_paid")
    now = _utcnow()
    _ensure_invoice_financial_movement_period_unlocked(
        db,
        inv,
        movement_date=now,
        action="mark_paid",
    )
    outstanding = _outstanding(db, inv)
    if outstanding <= 0:
        raise HTTPException(400, "Cette facture est déjà soldée.")
    if amount is not None and Decimal(str(amount)) < outstanding:
        raise HTTPException(400, "Montant insuffisant pour solder la facture. Utilisez l'ajout de règlement partiel.")
    to_record = Decimal(str(amount if amount is not None else outstanding))
    if to_record > outstanding:
        raise HTTPException(400, "Montant supérieur au reste dû.")
    payment = None
    if to_record > 0:
        payment = Payment(
            invoice_id=inv.id,
            amount=to_record,
            method="manuel",
            date=now,
            reference="marqué payé",
            created_by=user.id,
        )
        db.add(payment)
        db.flush()
    inv.paid_at = now
    _transition(inv, "paid", db, user)
    db.commit()
    if payment:
        await _sync_seqino_cashed_action(db, inv=inv, payment_id=payment.id)
    return {"ok": True, "paid_at": inv.paid_at}


@router.post("/{invoice_id}/cancel")
def mark_canceled(
    invoice_id: str, db: Session = Depends(get_db), user: AuthUser = Depends(require_active_subscription)
):
    _require_role_accountant(user)
    inv = _invoice_for_update(db, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if _has_active_einvoicing_transmission(db, inv.id):
        raise HTTPException(
            400,
            "Impossible d'annuler directement une facture transmise. Émettez un avoir ou une facture rectificative.",
        )
    if _is_invoice_immutable(inv) or inv.number or inv.status in {"sent", "paid", "overdue", "partial"}:
        raise HTTPException(400, "Impossible d'annuler une facture déjà émise. Émettez un avoir.")
    _ensure_invoice_accounting_period_unlocked(db, inv, action="cancel_invoice")
    if (inv.invoice_kind or "standard") == "final":
        db.query(InvoiceDepositApplication).filter(
            InvoiceDepositApplication.tenant_id == inv.tenant_id,
            InvoiceDepositApplication.final_invoice_id == inv.id,
        ).delete(synchronize_session=False)
        if inv.quote_id:
            quote = db.get(Quote, inv.quote_id)
            if quote and quote.tenant_id == inv.tenant_id and quote.invoice_id == inv.id:
                quote.invoice_id = None
                if quote.status == "invoiced":
                    quote.status = "accepted"
                db.add(quote)
        options = dict(inv.template_options or {}) if isinstance(inv.template_options, dict) else {}
        manual_entries = _manual_advance_entries(options)
        if manual_entries:
            options["advance_payments"] = manual_entries
        else:
            options.pop("advance_payments", None)
        inv.template_options = options
    inv.paid_at = None
    inv.sent_at = None
    _transition(inv, "canceled", db, user)
    db.commit()
    return {"ok": True}


@router.post("/{invoice_id}/remind")
def remind(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.type != "invoice" or inv.status in {"draft", "canceled"} or not inv.number:
        raise HTTPException(400, "Seule une facture émise peut être relancée.")
    _mark_overdue(inv, db)
    inv.reminder_count = (inv.reminder_count or 0) + 1
    inv.last_reminder_at = _utcnow()
    db.add(inv)
    _log_action(
        db,
        user,
        inv.tenant_id,
        "invoice",
        inv.id,
        "remind",
        {"count": inv.reminder_count, "email_sent": False, "delivery": "manual_log"},
    )
    db.commit()
    return {"ok": True, "email_sent": False, "delivery": "manual_log", "reminders": inv.reminder_count}


@router.get("/{invoice_id}/share", response_model=InvoiceShareOut)
def get_invoice_share_link(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    expired = _disable_expired_invoice_public_link(db, inv)
    if not inv.public_enabled or not inv.public_token:
        return _invoice_share_out(inv, expired=expired)
    return _invoice_share_out(inv)


@router.post("/{invoice_id}/share", response_model=InvoiceShareOut)
def enable_invoice_share_link(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_api_key),
):
    ensure_legal_acceptance(user, db)
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status == "draft":
        raise HTTPException(400, "Émettez la facture avant de partager un lien public.")
    if inv.status == "canceled":
        raise HTTPException(400, "Impossible de partager une facture annulée.")
    token = _ensure_invoice_public_link(db, inv)
    inv.updated_by = None if user.is_api_key else user.id
    _log_action(db, user, inv.tenant_id, "invoice", inv.id, "share", {"enabled": True})
    db.commit()
    return _invoice_share_out(inv, public_url=_invoice_public_url(token))


@router.post("/{invoice_id}/share/rotate", response_model=InvoiceShareOut)
def rotate_invoice_share_link(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_api_key),
):
    ensure_legal_acceptance(user, db)
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status == "draft":
        raise HTTPException(400, "Émettez la facture avant de tourner le lien.")
    if inv.status == "canceled":
        raise HTTPException(400, "Impossible de tourner le lien d'une facture annulée.")
    token = _rotate_invoice_public_link(db, inv)
    inv.updated_by = None if user.is_api_key else user.id
    _log_action(db, user, inv.tenant_id, "invoice", inv.id, "share_rotate", {})
    db.commit()
    return _invoice_share_out(inv, public_url=_invoice_public_url(token))


@router.post("/{invoice_id}/share/disable", response_model=InvoiceShareOut)
def disable_invoice_share_link(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _disable_invoice_public_link(db, inv)
    inv.updated_by = None if user.is_api_key else user.id
    _log_action(db, user, inv.tenant_id, "invoice", inv.id, "share_disable", {})
    db.commit()
    return _invoice_share_out(inv, expired=False)


@router.post("/{invoice_id}/pay/checkout")
def create_invoice_checkout_session(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    """Route conservée pour compatibilité, mais le paiement carte client est retiré."""
    ensure_legal_acceptance(user, db)
    _require_role_accountant(user)
    raise HTTPException(
        status_code=410,
        detail={
            "code": "customer_invoice_card_payments_removed",
            "message": "Le paiement par carte des factures clients n'est pas proposé dans ce produit.",
        },
    )


def _build_invoice_followup_email_payload(
    *,
    ctx: dict,
    inv: Invoice,
    tenant: Tenant,
    customer: Customer,
    payload: InvoiceFollowupRequest,
    invoice_link: str,
    recipient_email: str | None = None,
    reply_to: str | None = None,
) -> tuple[dict, dict]:
    default_subject = f"Rappel - facture {inv.number or ''}".strip()
    subject_tpl = payload.subject or getattr(tenant, "reminder_subject_default", None) or default_subject
    default_body_tpl = (
        tenant.reminder_body_default
        or "Bonjour {client},\n\nSauf erreur de notre part, la facture {number}, échue le {due_date}, reste à régler.\n\nSi le paiement a déjà été effectué, merci de transmettre la référence du règlement à votre contact habituel. À défaut, merci d'indiquer la date de paiement prévue."
    )
    body_tpl = payload.body or default_body_tpl

    subject = _format_template(
        subject_tpl,
        inv,
        customer,
        tenant,
        ctx["totals"],
        invoice_link=invoice_link,
        reply_to=reply_to,
    )
    body = _format_template(
        body_tpl,
        inv,
        customer,
        tenant,
        ctx["totals"],
        invoice_link=invoice_link,
        reply_to=reply_to,
    )
    body = normalize_document_email_body_text(tenant=tenant, body_text=body, contact_email=reply_to)

    meta_rows = [
        ("Numéro", (inv.number or "").strip()),
        ("Échéance", _format_template("{due_date}", inv, customer, tenant, ctx["totals"], invoice_link=invoice_link)),
        (
            "Total TTC",
            f"{_format_template('{total_ttc}', inv, customer, tenant, ctx['totals'], invoice_link=invoice_link)} {inv.currency}".strip(),
        ),
    ]
    meta_rows.extend(_invoice_supplier_bank_meta(ctx))
    meta_rows.extend(_invoice_link_meta(inv, invoice_link))
    email_ctx = build_document_email_context(
        tenant=tenant,
        customer=customer,
        title=subject or default_subject,
        body_text=body or "",
        button_url=invoice_link or None,
        button_label="Ouvrir la facture",
        meta=meta_rows,
        recipient_email=recipient_email,
        contact_email=reply_to,
    )
    attachments = (
        [
            {
                "filename": _safe_filename("facture", inv.number, "pdf"),
                "content_type": "application/pdf",
                "kind": "pdf",
            }
        ]
        if payload.include_pdf
        else []
    )
    return (
        {
            "subject": subject or default_subject,
            "body": body or "",
            "html": render_email_template("document.html", email_ctx),
            "reply_to": reply_to,
            "include_link": bool(payload.include_link),
            "button_url": invoice_link or None,
            "attachments": attachments,
        },
        email_ctx,
    )


@router.post("/{invoice_id}/followup/preview")
def preview_invoice_followup(
    invoice_id: str,
    payload: InvoiceFollowupRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    ensure_legal_acceptance(user, db)
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")

    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")

    followup_decision = _invoice_followup_decision_or_raise(
        db,
        inv,
        tenant=tenant,
        customer=customer,
        explicit_to=payload.to,
    )
    recipients = followup_decision.recipients

    ctx = _ctx(db, inv)
    invoice_link = _invoice_preview_link(inv, bool(payload.include_link))
    preview, _email_ctx = _build_invoice_followup_email_payload(
        ctx=ctx,
        inv=inv,
        tenant=tenant,
        customer=customer,
        payload=payload,
        invoice_link=invoice_link,
        recipient_email=join_emails(recipients),
        reply_to=_document_reply_to_from_payload(payload.reply_to, db, tenant, user),
    )
    draft = build_invoice_email_draft(db, inv, "followup")
    preview.setdefault("reason", draft.get("reason"))
    preview.setdefault("warnings", draft.get("warnings") or [])
    preview["to"] = recipients
    return preview


@router.post("/{invoice_id}/followup")
def send_invoice_followup(
    invoice_id: str,
    payload: InvoiceFollowupRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
    _feature_user: AuthUser = Depends(require_product_feature("payments_enabled")),
):
    """Relance manuelle (envoi email) d'une facture impayée.

    - Incrémente reminder_count / last_reminder_at
    - Peut inclure un lien portail public (/i/{token})
    """
    ensure_legal_acceptance(user, db)
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")

    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    ensure_document_email_delivery_allowed(tenant)

    followup_decision = _invoice_followup_decision_or_raise(
        db,
        inv,
        tenant=tenant,
        customer=customer,
        explicit_to=payload.to,
    )
    recipients = followup_decision.recipients
    if _save_invoice_followup_defaults(tenant, payload):
        db.add(tenant)

    smtp_ready = assert_smtp_ready_or_raise("invoice_followup")
    if not smtp_ready:
        now = _utcnow()
        _mark_overdue(inv, db)
        inv.reminder_count = int(getattr(inv, "reminder_count", 0) or 0) + 1
        inv.last_reminder_at = now
        db.add(inv)
        events = [
            record_invoice_email_log_only(
                tenant_id=inv.tenant_id,
                invoice_id=inv.id,
                user_id=user.id,
                to=dest,
                followup=True,
            )
            for dest in recipients
        ]
        primary_event = events[0]
        _log_action(
            db,
            user,
            inv.tenant_id,
            "invoice",
            inv.id,
            "followup_email_log_only",
            {
                "delivery": "log_only",
                "to_count": len(recipients),
                "to_masked": [mask_email(r) for r in recipients],
                "event_id": primary_event.id,
                "event_ids": [e.id for e in events],
            },
        )
        db.commit()
        return {
            "ok": True,
            "email_sent": False,
            "delivery": "log_only",
            "email_event_id": primary_event.id,
            "email_event_ids": [e.id for e in events],
            "status": primary_event.status,
            "reminders": inv.reminder_count,
            "to_count": len(recipients),
        }

    _enforce_invoice_email_rate_limit(inv.tenant_id)

    # S'assure que la facture est marquée 'sent' si on envoie une relance.
    if inv.status == "issued":
        inv.sent_at = inv.sent_at or _utcnow()
        try:
            _transition(inv, "sent", db, user)
        except Exception:
            pass

    _mark_overdue(inv, db)
    ctx = _ctx(db, inv)

    invoice_link = ""
    if payload.include_link:
        token = _ensure_invoice_public_link(db, inv)
        invoice_link = _invoice_public_url(token)

    email_payload, email_ctx = _build_invoice_followup_email_payload(
        ctx=ctx,
        inv=inv,
        tenant=tenant,
        customer=customer,
        payload=payload,
        invoice_link=invoice_link,
        recipient_email=join_emails(recipients),
        reply_to=_document_reply_to_from_payload(payload.reply_to, db, tenant, user),
    )

    attachments: list[tuple[str, bytes, str]] = []
    if payload.include_pdf:
        # PDF simple (pas de Factur-X pour éviter la complexité côté relance)
        try:
            pdf_bytes = invoice_pdf(ctx)
            filename = _safe_filename("facture", inv.number, "pdf")
            attachments.append((filename, pdf_bytes, "application/pdf"))
        except Exception:
            logger.exception("invoice_followup_pdf_failed", extra={"invoice_id": inv.id})

    events = []
    try:
        for dest in recipients:
            ev = enqueue_invoice_email(
                tenant_id=inv.tenant_id,
                invoice_id=inv.id,
                user_id=user.id,
                to=dest,
                subject=email_payload["subject"],
                body=email_payload["body"],
                attachments=attachments,
                reply_to=email_payload["reply_to"],
                template="document.html",
                context=email_ctx,
                followup=True,
            )
            events.append(ev)
    except Exception:
        logger.exception("invoice_followup_enqueue_failed", extra={"invoice_id": inv.id, "tenant_id": inv.tenant_id})
        raise HTTPException(502, "Echec lors de l'envoi de la relance.")

    inv.reminder_count = int(getattr(inv, "reminder_count", 0) or 0) + 1
    inv.last_reminder_at = _utcnow()
    db.add(inv)
    primary_event = events[0]
    _log_action(
        db,
        user,
        inv.tenant_id,
        "invoice",
        inv.id,
        "followup_email",
        {
            "to_count": len(recipients),
            "to_masked": [mask_email(r) for r in recipients],
            "event_id": primary_event.id,
            "event_ids": [e.id for e in events],
        },
    )
    db.commit()
    return {
        "ok": True,
        "email_event_id": primary_event.id,
        "email_event_ids": [e.id for e in events],
        "status": primary_event.status,
        "reminders": inv.reminder_count,
        "to_count": len(recipients),
    }


class InvoiceEmailSendRequest(BaseModel):
    to: str | None = None
    cc: str | None = None
    bcc: str | None = None
    reply_to: str | None = None
    subject: str | None = None
    body: str | None = None
    format: str | None = None
    include_link: bool | None = True
    attach_invoice: bool | None = True
    copy_sender: bool | None = True
    save_as_default: bool | None = False
    save_subject_template: str | None = None
    save_body_template: str | None = None


def _clean_email_template_value(value: str | None) -> str | None:
    clean = (value or "").strip()
    return clean or None


def _document_reply_to(db: Session | None, tenant: Tenant | None, user: AuthUser | None = None) -> str | None:
    return resolve_document_reply_to(db, tenant, user=user)


def _document_reply_to_from_payload(
    value: str | None,
    db: Session | None,
    tenant: Tenant | None,
    user: AuthUser | None = None,
) -> str | None:
    raw = (value or "").strip()
    if raw:
        parsed = parse_emails(raw)
        if len(parsed) != 1:
            raise HTTPException(400, "Adresse e-mail de contact invalide.")
        cleaned = clean_document_reply_email(parsed[0])
        if cleaned:
            return cleaned
    return _document_reply_to(db, tenant, user)


def _save_invoice_email_defaults(tenant: Tenant, payload: InvoiceEmailSendRequest | None) -> bool:
    if not payload or not payload.save_as_default:
        return False
    subject = _clean_email_template_value(payload.save_subject_template or payload.subject)
    body = _clean_email_template_value(payload.save_body_template or payload.body)
    if subject:
        tenant.email_subject_default = subject
    if body:
        tenant.email_body_default = body
    return bool(subject or body)


def _save_invoice_followup_defaults(tenant: Tenant, payload: InvoiceFollowupRequest | None) -> bool:
    if not payload or not payload.save_as_default:
        return False
    subject = _clean_email_template_value(payload.save_subject_template or payload.subject)
    body = _clean_email_template_value(payload.save_body_template or payload.body)
    if subject:
        tenant.reminder_subject_default = subject
    if body:
        tenant.reminder_body_default = body
    return bool(subject or body)


def _invoice_preview_link(inv: Invoice, include_link: bool) -> str:
    if not include_link:
        return ""
    if inv.public_token and inv.public_enabled and not is_invoice_public_link_expired(inv):
        return _invoice_public_url(inv.public_token)
    return _invoice_public_url("apercu-client")


def _build_invoice_email_preview_payload(
    *,
    db: Session,
    inv: Invoice,
    tenant: Tenant,
    customer: Customer,
    payload: InvoiceEmailSendRequest | None,
    explicit_to: str | None,
    format_value: str,
    include_link_default: bool,
    reply_to: str | None = None,
) -> dict:
    recipients = resolve_customer_recipients(db, customer=customer, kind="invoice", explicit_to=explicit_to)
    if not recipients:
        raise HTTPException(400, "Aucun destinataire : ajoutez un email au client ou des contacts facturation.")

    cc_recipients = parse_emails(payload.cc if payload else None)
    bcc_recipients = parse_emails(payload.bcc if payload else None)
    include_link_value = (
        include_link_default if payload is None or payload.include_link is None else bool(payload.include_link)
    )
    invoice_link = _invoice_preview_link(inv, include_link_value)
    attachment_format = (
        (
            (payload.format if payload and payload.format else format_value)
            or _default_invoice_email_attachment_format(tenant)
        )
        .strip()
        .lower()
    )
    if attachment_format not in {"facturx", "pdf", "both"}:
        raise HTTPException(400, "Format invalide.")
    if attachment_format in {"facturx", "both"}:
        ensure_product_feature(tenant, "einvoicing_enabled")
    attach_invoice = True if payload is None or payload.attach_invoice is None else bool(payload.attach_invoice)

    ctx = _ctx(db, inv)
    label = "Avoir" if inv.type == "credit_note" else "Facture"
    label_lower = "avoir" if inv.type == "credit_note" else "facture"
    due_sentence = (
        "Échéance indiquée : {due_date}."
        if inv.type == "credit_note"
        else "Elle est à régler au plus tard le {due_date}."
    )
    subject_tpl = tenant.email_subject_default or f"Votre {label_lower} {{number}}"
    body_tpl = tenant.email_body_default or (
        f"Bonjour {{client}},\n\n"
        f"Votre {label_lower} {{number}} est disponible. Date d'émission : {{issue_date}}. "
        "Montant TTC : {total_ttc} {currency}.\n"
        f"{due_sentence}\n\n"
        "Vous pouvez la consulter et la télécharger depuis le portail sécurisé. "
        "Le PDF est joint à cet email pour vos dossiers.\n\n"
        "Les informations de règlement figurent dans la facture. Si une correction est nécessaire, répondez à cet email avant paiement."
    )
    if not subject_tpl.strip() or not body_tpl.strip():
        raise HTTPException(400, "Sujet ou contenu d'email vide. Configurez vos modèles dans Entreprise.")
    subject_override = (payload.subject or "").strip() if payload and payload.subject is not None else ""
    body_override = (payload.body or "").strip() if payload and payload.body is not None else ""
    subject = _format_template(
        subject_override or subject_tpl,
        inv,
        customer,
        tenant,
        ctx["totals"],
        invoice_link=invoice_link,
        reply_to=reply_to,
    )
    body = _format_template(
        body_override or body_tpl,
        inv,
        customer,
        tenant,
        ctx["totals"],
        invoice_link=invoice_link,
        reply_to=reply_to,
    )
    body = normalize_document_email_body_text(tenant=tenant, body_text=body, contact_email=reply_to)

    total_email = f"{_format_template('{total_ttc}', inv, customer, tenant, ctx['totals'], invoice_link=invoice_link)} {inv.currency}".strip()
    if inv.type == "credit_note":
        total_email = total_email.replace("-", "", 1)
    meta_rows = [
        ("Numéro", (inv.number or "").strip()),
        ("Échéance", _format_template("{due_date}", inv, customer, tenant, ctx["totals"], invoice_link=invoice_link)),
        ("Montant de l'avoir" if inv.type == "credit_note" else "Total TTC", total_email),
    ]
    meta_rows.extend(_invoice_supplier_bank_meta(ctx))
    meta_rows.extend(_invoice_link_meta(inv, invoice_link))
    email_ctx = build_document_email_context(
        tenant=tenant,
        customer=customer,
        title=subject or f"{label} {inv.number}",
        body_text=body,
        button_url=invoice_link or None,
        button_label="Voir l'avoir" if inv.type == "credit_note" else "Voir la facture",
        meta=meta_rows,
        recipient_email=join_emails(recipients),
        contact_email=reply_to,
    )
    attachments = []
    if attach_invoice:
        if attachment_format in {"facturx", "both"}:
            attachments.append(
                {
                    "filename": _email_attachment_filename(inv.number, "facturx"),
                    "content_type": "application/pdf",
                    "kind": "facturx",
                }
            )
        if attachment_format in {"pdf", "both"}:
            attachments.append(
                {
                    "filename": _email_attachment_filename(inv.number, "pdf"),
                    "content_type": "application/pdf",
                    "kind": "pdf",
                }
            )

    return {
        "subject": subject or f"{label} {inv.number}",
        "body": body,
        "html": render_email_template("document.html", email_ctx),
        "to": recipients,
        "cc": cc_recipients,
        "bcc": bcc_recipients,
        "reply_to": reply_to,
        "include_link": include_link_value,
        "button_url": invoice_link or None,
        "attachments": attachments,
    }


@router.post("/{invoice_id}/email/preview")
def preview_invoice_email(
    invoice_id: str,
    payload: InvoiceEmailSendRequest | None = Body(None),
    to: str | None = Query(None, description="Destinataire (optionnel : si vide, contacts facturation du client)"),
    format: str | None = Query(None, description="Format de la pièce jointe (facturx|pdf|both)"),
    include_link: bool = Query(True, description="Afficher le lien portail public dans l'aperçu"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status in {"draft", "canceled"}:
        raise HTTPException(400, "Cette facture est encore en brouillon ou a été annulée.")
    if not inv.number:
        raise HTTPException(400, "Numéro manquant : émettez la facture avant envoi.")
    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    explicit_to = (payload.to if payload else None) or to
    preview = _build_invoice_email_preview_payload(
        db=db,
        inv=inv,
        tenant=tenant,
        customer=customer,
        payload=payload,
        explicit_to=explicit_to,
        format_value=format,
        include_link_default=include_link,
        reply_to=_document_reply_to_from_payload(payload.reply_to if payload else None, db, tenant, user),
    )
    draft = build_invoice_email_draft(db, inv, "credit_note_send" if inv.type == "credit_note" else "send")
    preview.setdefault("reason", draft.get("reason"))
    preview.setdefault("warnings", draft.get("warnings") or [])
    return preview


@router.post("/{invoice_id}/email")
def email_invoice(
    invoice_id: str,
    payload: InvoiceEmailSendRequest | None = Body(None),
    to: str | None = Query(None, description="Destinataire (optionnel : si vide, contacts facturation du client)"),
    format: str | None = Query(None, description="Format de la pièce jointe (facturx|pdf|both)"),
    include_link: bool = Query(True, description="Ajouter un lien portail public dans l'email"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if inv.status in {"draft", "canceled"}:
        raise HTTPException(400, "Cette facture est encore en brouillon ou a été annulée.")
    if not inv.number:
        raise HTTPException(400, "Numéro manquant : émettez la facture avant envoi.")
    tenant = db.get(Tenant, inv.tenant_id)
    customer = db.get(Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    ensure_document_email_delivery_allowed(tenant)

    explicit_to = (payload.to if payload else None) or to
    recipients = resolve_customer_recipients(db, customer=customer, kind="invoice", explicit_to=explicit_to)
    if not recipients:
        raise HTTPException(400, "Aucun destinataire : ajoutez un email au client ou des contacts facturation.")
    if _save_invoice_email_defaults(tenant, payload):
        db.add(tenant)

    cc_recipients = parse_emails(payload.cc if payload else None)
    bcc_recipients = parse_emails(payload.bcc if payload else None)
    if payload is not None and payload.copy_sender:
        sender_copy = (getattr(user, "email", "") or "").strip().lower()
        all_known = set(recipients + cc_recipients + bcc_recipients)
        if sender_copy and sender_copy not in all_known:
            bcc_recipients.append(sender_copy)

    send_targets = (
        [join_emails(recipients)]
        if payload and (len(recipients) > 1 or cc_recipients or bcc_recipients)
        else recipients
    )
    smtp_ready = assert_smtp_ready_or_raise("invoice_email")
    if not smtp_ready:
        events = [
            record_invoice_email_log_only(
                tenant_id=inv.tenant_id,
                invoice_id=inv.id,
                user_id=user.id,
                to=dest,
            )
            for dest in send_targets
        ]
        primary_event = events[0]
        _log_action(
            db,
            user,
            inv.tenant_id,
            "invoice",
            inv.id,
            "email_log_only",
            {
                "delivery": "log_only",
                "to_count": len(recipients),
                "cc_count": len(cc_recipients),
                "bcc_count": len(bcc_recipients),
                "to_masked": [mask_email(r) for r in recipients],
                "event_id": primary_event.id,
                "event_ids": [e.id for e in events],
            },
        )
        db.commit()
        return {
            "ok": True,
            "email_sent": False,
            "delivery": "log_only",
            "email_event_id": primary_event.id,
            "email_event_ids": [e.id for e in events],
            "status": primary_event.status,
            "to_count": len(recipients),
            "cc_count": len(cc_recipients),
            "bcc_count": len(bcc_recipients),
        }

    _enforce_invoice_email_rate_limit(inv.tenant_id)
    # Marquer comme envoyée si nécessaire
    now = _utcnow()
    if inv.status == "issued":
        inv.sent_at = inv.sent_at or now
        try:
            _transition(inv, "sent", db, user)
        except Exception:
            pass

    _mark_overdue(inv, db)

    ctx = _ctx(db, inv)
    invoice_link = ""
    include_link_value = include_link if payload is None or payload.include_link is None else bool(payload.include_link)
    if include_link_value:
        token = _ensure_invoice_public_link(db, inv)
        invoice_link = _invoice_public_url(token)
    attachment_format = (
        ((payload.format if payload and payload.format else format) or _default_invoice_email_attachment_format(tenant))
        .strip()
        .lower()
    )
    if attachment_format not in {"facturx", "pdf", "both"}:
        raise HTTPException(400, "Format invalide.")
    if attachment_format in {"facturx", "both"}:
        ensure_product_feature(tenant, "einvoicing_enabled")
    attach_invoice = True if payload is None or payload.attach_invoice is None else bool(payload.attach_invoice)

    def _load_pdf_bytes() -> bytes:
        if _is_invoice_immutable(inv):
            artifact = ensure_invoice_artifact(db, inv, "pdf", ctx)
            _ensure_invoice_artifact_integrity(db, inv, artifact, "pdf")
            pdf_bytes = _load_invoice_artifact(inv, "pdf")
            if pdf_bytes:
                return pdf_bytes
            _raise_invoice_artifact_integrity_error(inv, "PDF", "email_pdf_missing")
        return invoice_pdf(ctx)

    def _load_facturx_bytes() -> bytes | None:
        if _is_invoice_immutable(inv):
            artifact = ensure_invoice_artifact(db, inv, "facturx", ctx)
            _ensure_invoice_artifact_integrity(db, inv, artifact, "facturx")
            facturx_bytes = _load_invoice_artifact(inv, "facturx")
            if facturx_bytes:
                return facturx_bytes
            _raise_invoice_artifact_integrity_error(inv, "FACTURX", "email_facturx_missing")
        if inv.facturx_key:
            facturx_bytes = get_object_bytes(inv.facturx_key)
            if facturx_bytes:
                return facturx_bytes
        return None

    facturx_bytes = None
    pdf_bytes = None
    if attach_invoice:
        if attachment_format in {"facturx", "both"}:
            facturx_bytes = _load_facturx_bytes()
        if attachment_format in {"pdf", "both"} or (attachment_format == "facturx" and not facturx_bytes):
            pdf_bytes = _load_pdf_bytes()
    label = "Avoir" if inv.type == "credit_note" else "Facture"
    label_lower = "avoir" if inv.type == "credit_note" else "facture"
    due_sentence = (
        "Échéance indiquée : {due_date}."
        if inv.type == "credit_note"
        else "Elle est à régler au plus tard le {due_date}."
    )
    subject_tpl = (
        (tenant.email_subject_default or f"Votre {label_lower} {{number}}") if tenant else f"Votre {label_lower}"
    )
    reply_to = _document_reply_to_from_payload(payload.reply_to if payload else None, db, tenant, user)
    body_tpl = tenant.email_body_default or (
        f"Bonjour {{client}},\n\n"
        f"Votre {label_lower} {{number}} est disponible. Date d'émission : {{issue_date}}. "
        "Montant TTC : {total_ttc} {currency}.\n"
        f"{due_sentence}\n\n"
        "Vous pouvez la consulter et la télécharger depuis le portail sécurisé. "
        "Le PDF est joint à cet email pour vos dossiers.\n\n"
        "Les informations de règlement figurent dans la facture. Si une correction est nécessaire, répondez à cet email avant paiement."
    )
    if not subject_tpl.strip() or not body_tpl.strip():
        raise HTTPException(400, "Sujet ou contenu d'email vide. Configurez vos modèles dans Entreprise.")
    subject_override = (payload.subject or "").strip() if payload and payload.subject is not None else ""
    body_override = (payload.body or "").strip() if payload and payload.body is not None else ""
    subject = _format_template(
        subject_override or subject_tpl,
        inv,
        customer,
        tenant,
        ctx["totals"],
        invoice_link=invoice_link,
        reply_to=reply_to,
    )
    body = _format_template(
        body_override or body_tpl,
        inv,
        customer,
        tenant,
        ctx["totals"],
        invoice_link=invoice_link,
        reply_to=reply_to,
    )
    body = normalize_document_email_body_text(tenant=tenant, body_text=body, contact_email=reply_to)
    attachments: list[tuple[str, bytes, str]] = []
    if attach_invoice:
        if attachment_format == "pdf":
            if not pdf_bytes:
                raise HTTPException(500, "PDF indisponible")
            attachments = [(_email_attachment_filename(inv.number, "pdf"), pdf_bytes, "application/pdf")]
        elif attachment_format == "both":
            if facturx_bytes:
                attachments.append(
                    (_email_attachment_filename(inv.number, "facturx"), facturx_bytes, "application/pdf")
                )
            if pdf_bytes:
                attachments.append((_email_attachment_filename(inv.number, "pdf"), pdf_bytes, "application/pdf"))
        else:
            attachment_payload = facturx_bytes or pdf_bytes
            if not attachment_payload:
                raise HTTPException(500, "Pièce jointe indisponible")
            payload_kind = "facturx" if facturx_bytes else "pdf"
            attachments = [
                (_email_attachment_filename(inv.number, payload_kind), attachment_payload, "application/pdf")
            ]
    # Email brandé (HTML) + envoi à 1..N destinataires.
    total_email = f"{_format_template('{total_ttc}', inv, customer, tenant, ctx['totals'], invoice_link=invoice_link)} {inv.currency}".strip()
    if inv.type == "credit_note":
        total_email = total_email.replace("-", "", 1)
    meta_rows = [
        ("Numéro", (inv.number or "").strip()),
        ("Échéance", _format_template("{due_date}", inv, customer, tenant, ctx["totals"], invoice_link=invoice_link)),
        ("Montant de l'avoir" if inv.type == "credit_note" else "Total TTC", total_email),
    ]
    meta_rows.extend(_invoice_supplier_bank_meta(ctx))
    meta_rows.extend(_invoice_link_meta(inv, invoice_link))
    email_ctx = build_document_email_context(
        tenant=tenant,
        customer=customer,
        title=subject or f"{label} {inv.number}",
        body_text=body,
        button_url=invoice_link or None,
        button_label="Voir l'avoir" if inv.type == "credit_note" else "Voir la facture",
        meta=meta_rows,
        recipient_email=join_emails(recipients),
        contact_email=reply_to,
    )

    events = []
    try:
        for dest in send_targets:
            ev = enqueue_invoice_email(
                tenant_id=inv.tenant_id,
                invoice_id=inv.id,
                user_id=user.id,
                to=dest,
                subject=subject or f"{label} {inv.number}",
                body=body,
                attachments=attachments,
                reply_to=reply_to,
                template="document.html",
                context=email_ctx,
                cc=cc_recipients,
                bcc=bcc_recipients,
            )
            events.append(ev)
    except Exception:
        logger.exception("invoice_email_enqueue_failed", extra={"invoice_id": inv.id, "tenant_id": inv.tenant_id})
        raise HTTPException(502, "Echec lors de la mise en file d'attente de l'email.")

    primary_event = events[0]
    _log_action(
        db,
        user,
        inv.tenant_id,
        "invoice",
        inv.id,
        "email",
        {
            "to_count": len(recipients),
            "cc_count": len(cc_recipients),
            "bcc_count": len(bcc_recipients),
            "to_masked": [mask_email(r) for r in recipients],
            "format": attachment_format,
            "include_link": include_link_value,
            "attach_invoice": attach_invoice,
            "event_id": primary_event.id,
            "event_ids": [e.id for e in events],
        },
    )
    db.add(inv)
    db.commit()
    return {
        "ok": True,
        "email_event_id": primary_event.id,
        "email_event_ids": [e.id for e in events],
        "status": primary_event.status,
        "to_count": len(recipients),
        "cc_count": len(cc_recipients),
        "bcc_count": len(bcc_recipients),
    }
