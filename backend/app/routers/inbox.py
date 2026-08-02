from __future__ import annotations

import csv
import hashlib
import io
import logging
import math
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import String, and_, case, cast, exists, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import AuthUser, require_active_subscription, require_accountant_or_admin, require_product_feature
from ..models import (
    Customer,
    InboundInvoice,
    InboundInvoiceAttachment,
    InboundInvoiceEvent,
    EInvoicingActionOutbox,
    PdpConnection,
    PurchasePayment,
    PurchaseWorkflowState,
    PurchaseEmployeePayer,
    PurchaseSupplier,
    Tenant,
    TenantSettings,
)
from ..schemas import (
    InboundInvoiceAttachmentOut,
    InboundInvoiceListResponse,
    InboundInvoiceOut,
    InboundInvoiceStatusRequest,
)
from ..services.inbox_cii_parser import parse_cii_xml
from ..services.inbox_facturx import parse_facturx_xml
from ..services.inbox_parsers import InvoiceParseResult
from ..services.inbox_ubl_parser import parse_ubl_xml
from ..services.inbox import _extract_facturx_xml_from_pdf, ingest_inbound_message
from ..services.inbox_xml_detect import detect_invoice_xml_kind
from ..services.pdp import get_provider, list_providers
from ..services.pdp.service import execute_idempotent_provider_action, resolve_provider
from ..services.document_attachments import (
    get_purchase_attachment_unknown_size_count,
    get_used_bytes,
    resolve_limits_for_tenant,
)
from ..services.accounting_categories import account_needs_completion, suggest_settlement_category_from_mode
from ..services.accounting_readiness import purchase_accounting_readiness
from ..services.accounting_exports import accounting_period_lock_payload, find_delivered_accounting_period_lock
from ..services.purchase_accounting_assist import apply_purchase_accounting_patch
from ..services.seqino_mandates import (
    seqino_has_active_mandate,
    seqino_has_active_mandate_for_tenant_issuer,
)
from ..services.integration_secrets import enrich_credentials_with_secrets
from ..services.connected_mode import ensure_connected_mode_operational, is_connected_mode_operational
from ..services.pdp.utils import PdpProviderError
from ..services.storage import delete_object, get_object_stream, head_object, parse_range_header, put_object
from ..utils.crypto import decrypt_payload
from ..utils.seqino_http import seqino_http_status
from ..utils.xml_security import parse_xml_bytes

router = APIRouter(
    prefix="/api/inbox",
    tags=["inbox"],
    dependencies=[Depends(require_product_feature("purchases_enabled"))],
)
logger = logging.getLogger(__name__)
_MAX_IMPORT_BYTES = 10 * 1024 * 1024
_MAX_PURCHASE_ATTACHMENT_BYTES = 10 * 1024 * 1024
_MAX_PURCHASE_ATTACHMENTS_PER_INVOICE = 10
_MAX_SYNC_EXPORT_ROWS = 5000
_PURCHASE_WORKFLOW_STORE_KEY = "purchase_workflow_states"
_PURCHASE_WORKFLOW_LABELS = {
    "new": "Nouveau",
    "reviewing": "En revue",
    "awaiting_supplier": "En attente fournisseur",
    "approved": "À payer",
    "ready_to_pay": "À payer",
    "booked": "Payé",
}
_PURCHASE_WORKFLOW_TONES = {
    "new": "info",
    "reviewing": "warn",
    "awaiting_supplier": "danger",
    "approved": "purple",
    "ready_to_pay": "purple",
    "booked": "ok",
}
CSV_INJECTION_PREFIXES = ("=", "+", "-", "@")
_PURCHASE_ATTACHMENT_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "xml": "application/xml",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}


def _sanitize_csv_cell(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    if not text:
        return ""
    first_meaningful = text.lstrip(" \t\r\n\ufeff")
    if first_meaningful and first_meaningful[0] in CSV_INJECTION_PREFIXES:
        return "'" + text
    return text


def _ensure_sync_export_limit(query, *, label: str, limit: int = _MAX_SYNC_EXPORT_ROWS) -> None:
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


class PurchaseLineRequest(BaseModel):
    label: str | None = Field(default=None, max_length=180)
    total_ex_vat: Decimal = Field(default=Decimal("0"), ge=0)
    vat_rate: Decimal | None = Field(default=None, ge=0, le=100)
    total_vat: Decimal | None = Field(default=None, ge=0)
    accounting_account: str | None = Field(default=None, max_length=32)
    purchase_nature: str | None = Field(default=None, max_length=20)
    vat_category: str | None = Field(default=None, max_length=8)
    exemption_reason_code: str | None = Field(default=None, max_length=64)
    vat_exemption_reason: str | None = Field(default=None, max_length=240)
    vat_zero_reason: str | None = Field(default=None, max_length=240)
    vat_reverse_charge: bool = False
    source: str | None = Field(default=None, max_length=64)


class ManualPurchaseRequest(BaseModel):
    kind: str = Field(default="expense_report", max_length=32)
    supplier_name: str = Field(min_length=1, max_length=160)
    invoice_number: str | None = Field(default=None, max_length=80)
    issue_date: date | None = None
    total_ex_vat: Decimal | None = Field(default=None, ge=0)
    total_vat: Decimal | None = Field(default=None, ge=0)
    total_ttc: Decimal | None = Field(default=None, ge=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    accounting_account: str | None = Field(default=None, max_length=32)
    note: str | None = Field(default=None, max_length=500)
    purchase_lines: list[PurchaseLineRequest] | None = Field(default=None, max_length=40)


class PurchaseCompletionRequest(BaseModel):
    supplier_name: str | None = Field(default=None, max_length=160)
    supplier_siren: str | None = Field(default=None, max_length=14)
    supplier_siret: str | None = Field(default=None, max_length=20)
    invoice_number: str | None = Field(default=None, max_length=80)
    issue_date: date | None = None
    total_ex_vat: Decimal | None = Field(default=None, ge=0)
    total_vat: Decimal | None = Field(default=None, ge=0)
    total_ttc: Decimal | None = Field(default=None, ge=0)
    currency: str | None = Field(default="EUR", min_length=3, max_length=3)
    purchase_nature: str | None = Field(default=None, max_length=20)
    accounting_account: str | None = Field(default=None, max_length=32)
    accountant_note: str | None = Field(default=None, max_length=1000)
    planned_payment_date: date | None = None
    paid_by_employee: bool = False
    employee_payer_name: str | None = Field(default=None, max_length=160)
    employee_payer_role: str | None = Field(default=None, max_length=24)
    employee_reimbursement_amount: Decimal | None = Field(default=None, ge=0)
    employee_reimbursement_due_date: date | None = None
    employee_reimbursement_method: str | None = Field(default=None, max_length=32)
    employee_reimbursement_status: str | None = Field(default=None, max_length=32)
    purchase_tags: list[str] | None = Field(default=None, max_length=20)
    purchase_lines: list[PurchaseLineRequest] | None = Field(default=None, max_length=40)
    validate_: bool = Field(default=False, alias="validate")


class PurchaseVatBulkCorrectionRequest(BaseModel):
    invoice_ids: list[str] = Field(min_length=1, max_length=200)
    vat_rate: Decimal | None = Field(default=None, ge=Decimal("0"), le=Decimal("100"))
    use_supplier_rules: bool = False
    apply_to_purchase_lines: bool = False


class PurchaseVatBulkValidationRequest(BaseModel):
    invoice_ids: list[str] = Field(min_length=1, max_length=200)
    cabinet_comment: str | None = Field(default=None, max_length=500)


class PurchasePaymentRequest(BaseModel):
    date: datetime | None = None
    method: str | None = Field(default=None, max_length=80)
    amount: Decimal = Field(gt=0)
    reference: str | None = Field(default=None, max_length=160)
    settlement_mode: str | None = Field(default="bank", max_length=32)
    accounting_category: str | None = Field(default=None, max_length=32)
    receipt_label: str | None = Field(default=None, max_length=160)
    receipt_url: str | None = Field(default=None, max_length=500)


class PurchasePaymentOut(BaseModel):
    id: str
    inbound_invoice_id: str
    date: datetime
    method: str | None = None
    amount: float
    reference: str | None = None
    settlement_mode: str | None = None
    accounting_category: str | None = None
    receipt_label: str | None = None
    receipt_url: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class PurchaseSupplierVatRuleRequest(BaseModel):
    accounting_account: str | None = Field(default=None, max_length=32)
    purchase_nature: str | None = Field(default=None, max_length=20)
    vat_rate: Decimal = Field(ge=Decimal("0"), le=Decimal("100"))


class PurchaseSupplierUpsertRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    supplier_siren: str | None = Field(default=None, max_length=14)
    supplier_siret: str | None = Field(default=None, max_length=20)
    vat_number: str | None = Field(default=None, max_length=32)
    accounting_account: str | None = Field(default=None, max_length=32)
    payment_delay_days: int | None = Field(default=None, ge=0, le=365)
    purchase_nature: str | None = Field(default=None, max_length=20)
    vat_rate: Decimal | None = Field(default=None, ge=Decimal("0"), le=Decimal("100"))
    vat_rules: list[PurchaseSupplierVatRuleRequest] | None = Field(default=None, max_length=20)
    notes: str | None = Field(default=None, max_length=1000)


class PurchaseSupplierUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    supplier_siren: str | None = Field(default=None, max_length=14)
    supplier_siret: str | None = Field(default=None, max_length=20)
    vat_number: str | None = Field(default=None, max_length=32)
    accounting_account: str | None = Field(default=None, max_length=32)
    payment_delay_days: int | None = Field(default=None, ge=0, le=365)
    purchase_nature: str | None = Field(default=None, max_length=20)
    vat_rate: Decimal | None = Field(default=None, ge=Decimal("0"), le=Decimal("100"))
    vat_rules: list[PurchaseSupplierVatRuleRequest] | None = Field(default=None, max_length=20)
    notes: str | None = Field(default=None, max_length=1000)


class PurchaseSupplierDuplicateConsolidateRequest(BaseModel):
    keep_id: str = Field(min_length=1, max_length=80)
    remove_ids: list[str] = Field(default_factory=list, min_length=1, max_length=20)


class PurchaseEmployeePayerUpsertRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    role: str | None = Field(default=None, max_length=24)
    user_label: str | None = Field(default=None, max_length=160)
    accounting_account: str | None = Field(default=None, max_length=32)
    reimbursement_method: str | None = Field(default=None, max_length=32)
    vehicle_type: str | None = Field(default=None, max_length=40)
    fiscal_power: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=1000)


class PurchaseEmployeePayerUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    role: str | None = Field(default=None, max_length=24)
    user_label: str | None = Field(default=None, max_length=160)
    accounting_account: str | None = Field(default=None, max_length=32)
    reimbursement_method: str | None = Field(default=None, max_length=32)
    vehicle_type: str | None = Field(default=None, max_length=40)
    fiscal_power: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=1000)


def _reject_non_conforming_import(message: str, hint: str | None = None) -> None:
    detail: dict[str, str] = {
        "code": "purchase_import_not_conforming",
        "message": message,
    }
    if hint:
        detail["hint"] = hint
    raise HTTPException(status_code=422, detail=detail)


def _parse_supported_import_xml(xml_payload: bytes) -> InvoiceParseResult:
    kind = detect_invoice_xml_kind(xml_payload)
    if kind == "facturx_cii":
        parsed_invoice = parse_facturx_xml(xml_payload)
    elif kind == "cii":
        parsed_invoice = parse_cii_xml(xml_payload)
    elif kind == "ubl":
        parsed_invoice = parse_ubl_xml(xml_payload)
    else:
        _reject_non_conforming_import(
            "Fichier non conforme : XML de facture non reconnu.",
            "Importez une facture Factur-X, CII ou UBL. Le workflow achat démarre seulement après un fichier exploitable.",
        )

    return parsed_invoice


def _ensure_seqino_mandate_for_inbox(db: Session, tenant_id: str) -> None:
    conn = (
        db.query(PdpConnection.id)
        .filter(
            PdpConnection.tenant_id == tenant_id,
            PdpConnection.provider_slug == "seqino",
            PdpConnection.status == "connected",
        )
        .first()
    )
    if not conn:
        return
    if not seqino_has_active_mandate(tenant_id, db=db):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "seqino_mandate_missing",
                "message": "Mandat de plateforme agréée actif requis pour la réception.",
            },
        )


def _ensure_seqino_mandate_for_provider(db: Session, tenant_id: str, provider_slug: str | None) -> None:
    if (provider_slug or "").strip().lower() != "seqino":
        return
    if not seqino_has_active_mandate(tenant_id, db=db):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "seqino_mandate_missing",
                "message": "Mandat de plateforme agréée actif requis pour la réception.",
            },
        )


def _stream_attachment(request: Request, key: str, content_type: str, filename: str):
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
    disposition = (
        "inline" if str(request.query_params.get("inline", "")).lower() in {"1", "true", "yes"} else "attachment"
    )
    headers = {
        "Content-Disposition": f'{disposition}; filename="{filename}"',
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


def _purchase_attachment_content_type(kind: str | None) -> str:
    return _PURCHASE_ATTACHMENT_CONTENT_TYPES.get((kind or "").strip().lower(), "application/octet-stream")


def _detect_purchase_attachment(raw: bytes, filename: str | None, content_type: str | None) -> tuple[str, str]:
    head = raw[:16]
    if head.startswith(b"%PDF-"):
        return "pdf", "application/pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if len(raw) >= 12 and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "webp", "image/webp"
    try:
        parse_xml_bytes(raw)
    except Exception:
        pass
    else:
        return "xml", "application/xml"
    raise HTTPException(400, "Format non supporté : joignez un PDF, XML, PNG, JPG ou WebP.")


def _clear_purchase_workflow_state(db: Session, tenant_id: str, invoice_id: str) -> None:
    db.query(PurchaseWorkflowState).filter(
        PurchaseWorkflowState.tenant_id == tenant_id,
        PurchaseWorkflowState.inbound_invoice_id == invoice_id,
    ).delete(synchronize_session=False)
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if not settings_row:
        return
    features = settings_row.features if isinstance(settings_row.features, dict) else {}
    purchase_states = features.get(_PURCHASE_WORKFLOW_STORE_KEY)
    if not isinstance(purchase_states, dict) or invoice_id not in purchase_states:
        return
    updated_states = dict(purchase_states)
    updated_states.pop(invoice_id, None)
    updated_features = dict(features)
    if updated_states:
        updated_features[_PURCHASE_WORKFLOW_STORE_KEY] = updated_states
    else:
        updated_features.pop(_PURCHASE_WORKFLOW_STORE_KEY, None)
    settings_row.features = updated_features
    db.add(settings_row)


def _ensure_tenant_settings(db: Session, tenant_id: str) -> TenantSettings:
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if settings_row:
        return settings_row
    settings_row = TenantSettings(tenant_id=tenant_id, features={})
    db.add(settings_row)
    db.flush()
    return settings_row


def _read_purchase_workflow_states(db: Session, tenant_id: str) -> dict[str, dict]:
    rows = db.query(PurchaseWorkflowState).filter(PurchaseWorkflowState.tenant_id == tenant_id).all()
    states = {
        row.inbound_invoice_id: {
            "invoice_id": row.inbound_invoice_id,
            "state": row.state,
            "owner_role": row.owner_role,
            "note": row.note,
            "updated_at": row.updated_at.replace(microsecond=0).isoformat() if row.updated_at else None,
        }
        for row in rows
    }
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    features = settings_row.features if settings_row and isinstance(settings_row.features, dict) else {}
    raw = features.get(_PURCHASE_WORKFLOW_STORE_KEY)
    if isinstance(raw, dict):
        for invoice_id, payload in raw.items():
            if str(invoice_id) not in states and isinstance(payload, dict):
                states[str(invoice_id)] = payload
    return states


def _legacy_purchase_workflow_invoice_ids(db: Session, tenant_id: str, states: set[str]) -> list[str]:
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    features = settings_row.features if settings_row and isinstance(settings_row.features, dict) else {}
    raw = features.get(_PURCHASE_WORKFLOW_STORE_KEY)
    if not isinstance(raw, dict):
        return []
    legacy_ids = [
        str(invoice_id)
        for invoice_id, payload in raw.items()
        if isinstance(payload, dict) and str(payload.get("state") or "").strip().lower() in states
    ]
    if not legacy_ids:
        return []
    table_ids = {
        str(invoice_id)
        for (invoice_id,) in db.query(PurchaseWorkflowState.inbound_invoice_id)
        .filter(PurchaseWorkflowState.tenant_id == tenant_id)
        .filter(PurchaseWorkflowState.inbound_invoice_id.in_(legacy_ids))
        .all()
    }
    return [invoice_id for invoice_id in legacy_ids if invoice_id not in table_ids]


def _purchase_workflow_exists(tenant_id: str, states: set[str]):
    return exists().where(
        PurchaseWorkflowState.tenant_id == tenant_id,
        PurchaseWorkflowState.inbound_invoice_id == InboundInvoice.id,
        PurchaseWorkflowState.state.in_(states),
    )


def _write_purchase_workflow_state(
    db: Session,
    *,
    tenant_id: str,
    invoice_id: str,
    state: str,
    note: str | None = None,
) -> None:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = (
        db.query(PurchaseWorkflowState)
        .filter(PurchaseWorkflowState.tenant_id == tenant_id, PurchaseWorkflowState.inbound_invoice_id == invoice_id)
        .with_for_update()
        .first()
    )
    if not row:
        row = PurchaseWorkflowState(
            tenant_id=tenant_id,
            inbound_invoice_id=invoice_id,
            created_at=now,
        )
    row.state = state
    row.owner_role = "accountant"
    row.note = note
    row.updated_at = now
    db.add(row)


def _purchase_workflow_state_for_export(inv: InboundInvoice, workflow_states: dict[str, dict]) -> tuple[str, str]:
    stored = workflow_states.get(inv.id) or {}
    state = str(stored.get("state") or "").strip().lower()
    if not state:
        if inv.completion_status == "validated" or inv.validated_at:
            state = "reviewing"
        else:
            state = "new"
    return state, _PURCHASE_WORKFLOW_LABELS.get(state, state.replace("_", " ").title())


def _default_purchase_workflow_state(inv: InboundInvoice) -> str:
    status = (inv.status or "").strip().lower()
    validation = (inv.validation_status or "").strip().lower()
    if status in {"correction_requested", "rejected"} or validation == "invalid":
        return "awaiting_supplier"
    if status == "accepted":
        return "approved"
    if status == "acknowledged" or validation == "warning":
        return "reviewing"
    return "new"


def _purchase_workflow_payload_for_row(inv: InboundInvoice, workflow_states: dict[str, dict]) -> dict[str, Any]:
    stored = workflow_states.get(inv.id) or {}
    state = str(stored.get("state") or "").strip().lower() or _default_purchase_workflow_state(inv)
    if state not in _PURCHASE_WORKFLOW_LABELS:
        state = _default_purchase_workflow_state(inv)
    updated_at = stored.get("updated_at")
    if isinstance(updated_at, datetime):
        updated_at = updated_at.replace(microsecond=0).isoformat()
    return {
        "invoice_id": inv.id,
        "state": state,
        "state_label": _PURCHASE_WORKFLOW_LABELS.get(state, state.replace("_", " ").title()),
        "tone": _PURCHASE_WORKFLOW_TONES.get(state, "muted"),
        "owner_role": (str(stored.get("owner_role") or "").strip() or None),
        "note": (str(stored.get("note") or "").strip() or None),
        "updated_at": updated_at,
    }


def _purchase_vat_export_summary(inv: InboundInvoice) -> tuple[str, str, str]:
    categories: list[str] = []
    reason_codes: list[str] = []
    reverse_charge = False
    for raw in inv.purchase_lines if isinstance(inv.purchase_lines, list) else []:
        if not isinstance(raw, dict):
            continue
        category = _clean_text(raw.get("vat_category"), upper=True)
        code = _clean_text(raw.get("exemption_reason_code"), upper=True)
        if category and category not in categories:
            categories.append(category)
        if code and code not in reason_codes:
            reason_codes.append(code)
        reverse_charge = reverse_charge or bool(raw.get("vat_reverse_charge"))
    return "|".join(categories), "|".join(reason_codes), "yes" if reverse_charge else ""


def _purchase_accounting_period_date(inv: InboundInvoice) -> date | None:
    if inv.issue_date:
        return inv.issue_date
    if inv.received_at:
        return inv.received_at.date()
    return None


def _ensure_purchase_accounting_period_unlocked(db: Session, inv: InboundInvoice) -> None:
    period_date = _purchase_accounting_period_date(inv)
    if not period_date:
        return
    _ensure_purchase_period_date_unlocked(
        db,
        tenant_id=inv.tenant_id,
        period_date=period_date,
        message="Cet achat appartient à une période déjà remise au cabinet.",
    )


def _ensure_purchase_period_date_unlocked(
    db: Session,
    *,
    tenant_id: str,
    period_date: date | datetime | None,
    message: str,
) -> None:
    if not period_date:
        return
    if isinstance(period_date, datetime):
        period_date = period_date.date()
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=tenant_id,
        period_start=period_date,
        period_end=period_date,
    )
    if lock:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "accounting_period_locked",
                "message": message,
                "lock": accounting_period_lock_payload(lock),
            },
        )


def _purchase_payment_total(db: Session, inv: InboundInvoice, *, exclude_payment_id: str | None = None) -> Decimal:
    query = db.query(func.coalesce(func.sum(PurchasePayment.amount), 0)).filter(
        PurchasePayment.tenant_id == inv.tenant_id,
        PurchasePayment.inbound_invoice_id == inv.id,
    )
    if exclude_payment_id:
        query = query.filter(PurchasePayment.id != exclude_payment_id)
    return Decimal(str(query.scalar() or 0)).quantize(Decimal("0.01"))


def _purchase_payment_remaining(db: Session, inv: InboundInvoice, *, exclude_payment_id: str | None = None) -> Decimal:
    total_ttc = Decimal(str(inv.total_ttc or 0)).quantize(Decimal("0.01"))
    paid = _purchase_payment_total(db, inv, exclude_payment_id=exclude_payment_id)
    return max(total_ttc - paid, Decimal("0.00"))


def _purchase_payment_totals_for_rows(db: Session, rows: list[InboundInvoice]) -> dict[str, Decimal]:
    invoice_ids = [row.id for row in rows if row.id]
    if not invoice_ids:
        return {}
    tenant_ids = {row.tenant_id for row in rows if row.tenant_id}
    query = db.query(PurchasePayment.inbound_invoice_id, func.coalesce(func.sum(PurchasePayment.amount), 0)).filter(
        PurchasePayment.inbound_invoice_id.in_(invoice_ids)
    )
    if tenant_ids:
        query = query.filter(PurchasePayment.tenant_id.in_(tenant_ids))
    totals = query.group_by(PurchasePayment.inbound_invoice_id).all()
    return {str(invoice_id): Decimal(str(total or 0)).quantize(Decimal("0.01")) for invoice_id, total in totals}


def _annotate_purchase_rows(db: Session, rows: list[InboundInvoice]) -> None:
    paid_totals = _purchase_payment_totals_for_rows(db, rows)
    tenant_ids = {row.tenant_id for row in rows if row.tenant_id}
    workflow_states_by_tenant = {tenant_id: _read_purchase_workflow_states(db, tenant_id) for tenant_id in tenant_ids}
    for row in rows:
        paid_total = paid_totals.get(row.id, Decimal("0.00"))
        total_ttc = Decimal(str(row.total_ttc or 0)).quantize(Decimal("0.01"))
        setattr(row, "purchase_paid_total", float(paid_total))
        setattr(row, "purchase_remaining_ttc", float(max(total_ttc - paid_total, Decimal("0.00"))))
        setattr(row, "accounting_readiness", purchase_accounting_readiness(row))
        setattr(
            row,
            "purchase_workflow",
            _purchase_workflow_payload_for_row(row, workflow_states_by_tenant.get(row.tenant_id, {})),
        )


def _clean_purchase_payment_text(value: str | None, *, upper: bool = False, limit: int = 512) -> str | None:
    cleaned = str(value or "").strip()
    if upper:
        cleaned = cleaned.upper()
    return cleaned[:limit] or None


def _normalize_purchase_payment_payload(payload: PurchasePaymentRequest) -> dict[str, Any]:
    settlement_mode = _clean_purchase_payment_text(payload.settlement_mode, limit=32)
    if settlement_mode and settlement_mode not in {"bank", "cash", "manual", "card", "other"}:
        raise HTTPException(400, "Mode de règlement fournisseur invalide.")
    receipt_url = _clean_purchase_payment_text(payload.receipt_url, limit=500)
    if receipt_url and not receipt_url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "Lien justificatif invalide.")
    accounting_category = _clean_purchase_payment_text(payload.accounting_category, upper=True, limit=32)
    if not accounting_category:
        suggestion = suggest_settlement_category_from_mode(settlement_mode or "bank")
        accounting_category = str(suggestion["code"]) if suggestion else None
    return {
        "date": payload.date or datetime.now(timezone.utc).replace(tzinfo=None),
        "method": _clean_purchase_payment_text(payload.method, limit=80),
        "amount": Decimal(str(payload.amount)).quantize(Decimal("0.01")),
        "reference": _clean_purchase_payment_text(payload.reference, limit=160),
        "settlement_mode": settlement_mode or "bank",
        "accounting_category": accounting_category,
        "receipt_label": _clean_purchase_payment_text(payload.receipt_label, limit=160),
        "receipt_url": receipt_url,
    }


def _ensure_purchase_payment_reference_available(
    db: Session,
    *,
    tenant_id: str,
    invoice_id: str,
    reference: str | None,
    exclude_payment_id: str | None = None,
) -> None:
    if not reference:
        return
    query = db.query(PurchasePayment.id).filter(
        PurchasePayment.tenant_id == tenant_id,
        PurchasePayment.inbound_invoice_id == invoice_id,
        PurchasePayment.reference == reference,
    )
    if exclude_payment_id:
        query = query.filter(PurchasePayment.id != exclude_payment_id)
    if query.first():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "purchase_payment_duplicate_reference",
                "message": "Ce règlement fournisseur existe déjà pour cet achat.",
            },
        )


def _ensure_purchase_completed_for_payment(inv: InboundInvoice) -> None:
    if str(inv.completion_status or "").strip().lower() == "completed" and not _purchase_zero_vat_missing_reason(inv):
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "purchase_completion_required",
            "message": "Valide la qualification de cet achat avant d'enregistrer un règlement fournisseur.",
        },
    )


def _ensure_purchase_amounts_coherent_for_payment(inv: InboundInvoice) -> None:
    if _purchase_amounts_inconsistent(inv):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "purchase_amounts_inconsistent",
                "message": "Corrige les totaux de l'achat avant d'enregistrer un règlement fournisseur.",
                "fields": ["totaux"],
            },
        )


def _ensure_purchase_total_covers_payments(db: Session, inv: InboundInvoice) -> None:
    paid_total = _purchase_payment_total(db, inv)
    if paid_total <= Decimal("0.00"):
        return
    total_ttc = _round_amount(Decimal(str(inv.total_ttc or 0)))
    if total_ttc >= paid_total:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "purchase_total_below_paid",
            "message": "Le montant TTC de l'achat est inférieur aux règlements fournisseur déjà saisis.",
            "paid_total": float(paid_total),
            "total_ttc": float(total_ttc),
        },
    )


def _ensure_seqino_paid_action_mutable(db: Session, inv: InboundInvoice) -> None:
    if (inv.provider_slug or "").strip().lower() != "seqino" or not inv.external_message_id:
        return
    outbox = (
        db.query(EInvoicingActionOutbox)
        .filter(
            EInvoicingActionOutbox.tenant_id == inv.tenant_id,
            EInvoicingActionOutbox.provider_slug == "seqino",
            EInvoicingActionOutbox.external_id == inv.external_message_id,
            EInvoicingActionOutbox.action == "mark_as_paid",
            EInvoicingActionOutbox.state.in_({"completed", "reconciliation_required", "submitting"}),
        )
        .order_by(EInvoicingActionOutbox.created_at.desc())
        .first()
    )
    if not outbox:
        return
    state = str(outbox.state or "").strip().lower()
    if state == "reconciliation_required":
        code = "seqino_paid_reconciliation_required"
        message = (
            "Le statut réglementaire de paiement est incertain. "
            "Contactez le support avant de modifier les règlements fournisseur."
        )
    elif state == "submitting":
        code = "seqino_paid_action_in_progress"
        message = "La déclaration réglementaire de paiement est en cours."
    else:
        code = "seqino_paid_payment_locked"
        message = (
            "Le paiement a déjà été transmis à la plateforme partenaire. "
            "Les règlements fournisseur associés ne peuvent plus être modifiés ou supprimés."
        )
    raise HTTPException(409, detail={"code": code, "message": message})


async def _sync_seqino_paid_action(
    db: Session,
    *,
    inv: InboundInvoice,
    payment_id: str,
) -> str | None:
    if (inv.provider_slug or "").strip().lower() != "seqino" or not inv.external_message_id:
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
    provider, _credentials = resolve_provider(connection, db)
    # A queued/local payment must not outlive the tenant issuer's mandate.
    # Re-check immediately before any outbox mutation or provider callback.
    if not seqino_has_active_mandate_for_tenant_issuer(inv.tenant_id, db=db):
        return None
    try:
        outbox = await execute_idempotent_provider_action(
            db,
            tenant_id=inv.tenant_id,
            provider_slug="seqino",
            external_id=inv.external_message_id,
            action="mark_as_paid",
            callback=lambda: provider.send_inbox_status(inv.external_message_id, "mark_as_paid"),
            reference_id=payment_id,
        )
        return str(outbox.state or "").strip().lower() or None
    except PdpProviderError as exc:
        logger.warning(
            "seqino_mark_as_paid_not_confirmed",
            extra={
                "tenant_id": inv.tenant_id,
                "inbound_invoice_id": inv.id,
                "code": exc.code,
            },
        )
        return exc.code or "failed"
    except Exception:
        logger.exception(
            "seqino_mark_as_paid_failed",
            extra={"tenant_id": inv.tenant_id, "inbound_invoice_id": inv.id},
        )
        return "failed"


def _apply_inbox_filters(
    q,
    *,
    db: Session,
    tenant_id: str,
    q_text: str | None,
    status: str | None,
    validation_status: str | None,
    received_from: date | None,
    received_to: date | None,
    issue_from: date | None,
    issue_to: date | None,
    vat_correction: bool = False,
    purchase_board: str | None = None,
    purchase_kind: str | None = None,
    amount_min: Decimal | None = None,
    amount_max: Decimal | None = None,
):
    if q_text and q_text.strip():
        raw_text = q_text.strip()
        term = f"%{raw_text.lower()}%"
        date_candidates: list[date] = []
        for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
            try:
                date_candidates.append(datetime.strptime(raw_text, fmt).date())
            except ValueError:
                pass
        search_clauses = [
            func.lower(func.coalesce(InboundInvoice.supplier_name, "")).like(term),
            func.lower(func.coalesce(InboundInvoice.invoice_number, "")).like(term),
            func.lower(func.coalesce(InboundInvoice.supplier_siren, "")).like(term),
            func.lower(func.coalesce(InboundInvoice.supplier_siret, "")).like(term),
            func.lower(func.coalesce(InboundInvoice.accounting_account, "")).like(term),
            func.lower(func.coalesce(InboundInvoice.accountant_note, "")).like(term),
            func.lower(func.coalesce(InboundInvoice.employee_payer_name, "")).like(term),
            func.lower(func.coalesce(InboundInvoice.employee_reimbursement_status, "")).like(term),
            func.lower(cast(InboundInvoice.total_ex_vat, String)).like(term),
            func.lower(cast(InboundInvoice.total_vat, String)).like(term),
            func.lower(cast(InboundInvoice.total_ttc, String)).like(term),
            func.lower(cast(InboundInvoice.issue_date, String)).like(term),
            func.lower(cast(InboundInvoice.planned_payment_date, String)).like(term),
        ]
        if date_candidates:
            search_clauses.append(InboundInvoice.issue_date.in_(date_candidates))
        q = q.filter(
            or_(
                *search_clauses,
            )
        )
    if status:
        q = q.filter(InboundInvoice.status == status)
    if validation_status:
        q = q.filter(InboundInvoice.validation_status == validation_status)
    if received_from:
        q = q.filter(InboundInvoice.received_at >= datetime.combine(received_from, time.min))
    if received_to:
        q = q.filter(InboundInvoice.received_at <= datetime.combine(received_to, time.max))
    if issue_from:
        q = q.filter(InboundInvoice.issue_date >= issue_from)
    if issue_to:
        q = q.filter(InboundInvoice.issue_date <= issue_to)
    kind = (purchase_kind or "").strip().lower()
    if kind:
        format_key = func.lower(func.coalesce(InboundInvoice.format, "invoice"))
        if kind == "invoice":
            q = q.filter(format_key.notin_(["expense_report", "mileage"]))
        elif kind in {"expense_report", "mileage"}:
            q = q.filter(format_key == kind)
    total_ht = func.coalesce(InboundInvoice.total_ex_vat, 0)
    if amount_min is not None:
        q = q.filter(total_ht >= amount_min)
    if amount_max is not None:
        q = q.filter(total_ht <= amount_max)
    if vat_correction:
        total_vat = func.coalesce(InboundInvoice.total_vat, 0)
        total_ttc = func.coalesce(InboundInvoice.total_ttc, 0)
        status_key = func.lower(func.coalesce(InboundInvoice.status, ""))
        validation_key = func.lower(func.coalesce(InboundInvoice.validation_status, ""))
        completion_key = func.lower(func.coalesce(InboundInvoice.completion_status, ""))
        currency_key = func.upper(func.coalesce(InboundInvoice.currency, "EUR"))
        q = q.filter(
            or_(
                completion_key != "completed",
                and_(total_ttc > 0, total_vat <= 0, InboundInvoice.completion_validated_at.is_(None)),
                func.abs((total_ht + total_vat) - total_ttc) > Decimal("0.02"),
                status_key.in_(["rejected", "duplicate", "canceled"]),
                validation_key.in_(["invalid", "failed", "unavailable", "warning"]),
                currency_key != "EUR",
            )
        )
    board = (purchase_board or "").strip().lower()
    total_ht = func.coalesce(InboundInvoice.total_ex_vat, 0)
    total_vat = func.coalesce(InboundInvoice.total_vat, 0)
    total_ttc = func.coalesce(InboundInvoice.total_ttc, 0)
    amounts_inconsistent = func.abs((total_ht + total_vat) - total_ttc) > Decimal("0.02")
    if board == "to_complete":
        completion_key = func.lower(func.coalesce(InboundInvoice.completion_status, ""))
        validation_key = func.lower(func.coalesce(InboundInvoice.validation_status, ""))
        format_key = func.lower(func.coalesce(InboundInvoice.format, "invoice"))
        account_key = func.upper(func.replace(func.coalesce(InboundInvoice.accounting_account, ""), " ", ""))
        q = q.filter(
            and_(
                completion_key != "completed",
                or_(
                    func.length(func.trim(func.coalesce(InboundInvoice.supplier_name, ""))) == 0,
                    and_(
                        InboundInvoice.paid_by_employee.is_(True),
                        func.lower(func.coalesce(InboundInvoice.employee_reimbursement_status, "")) != "not_reimbursed",
                        func.length(func.trim(func.coalesce(InboundInvoice.employee_payer_name, ""))) == 0,
                    ),
                    and_(
                        format_key.notin_(["expense_report", "mileage"]),
                        func.length(func.trim(func.coalesce(InboundInvoice.invoice_number, ""))) == 0,
                    ),
                    InboundInvoice.issue_date.is_(None),
                    InboundInvoice.total_ttc.is_(None),
                    InboundInvoice.total_ttc < 0,
                    amounts_inconsistent,
                    func.length(func.trim(func.coalesce(InboundInvoice.accounting_account, ""))) == 0,
                    account_key.like("471%"),
                    validation_key.in_(["invalid", "warning", "unavailable"]),
                    and_(format_key.notin_(["expense_report", "mileage"]), validation_key == "skipped"),
                ),
            )
        )
    elif board in {"ready_to_pay", "paid"}:
        ready_workflow_filter = _purchase_workflow_exists(tenant_id, {"approved", "ready_to_pay"})
        booked_workflow_filter = _purchase_workflow_exists(tenant_id, {"booked"})
        legacy_ready_ids = _legacy_purchase_workflow_invoice_ids(
            db=db,
            tenant_id=tenant_id,
            states={"approved", "ready_to_pay"},
        )
        legacy_booked_ids = _legacy_purchase_workflow_invoice_ids(db=db, tenant_id=tenant_id, states={"booked"})
        if legacy_ready_ids:
            ready_workflow_filter = or_(ready_workflow_filter, InboundInvoice.id.in_(legacy_ready_ids))
        if legacy_booked_ids:
            booked_workflow_filter = or_(booked_workflow_filter, InboundInvoice.id.in_(legacy_booked_ids))
        if board == "ready_to_pay":
            completion_key = func.lower(func.coalesce(InboundInvoice.completion_status, ""))
            q = q.filter(
                or_(
                    ready_workflow_filter,
                    and_(
                        func.lower(func.coalesce(InboundInvoice.status, "")) == "accepted",
                        completion_key == "completed",
                        ~amounts_inconsistent,
                        ~booked_workflow_filter,
                    ),
                )
            )
        else:
            q = q.filter(booked_workflow_filter)
    return q


def _clean_text(value: str | None, *, upper: bool = False) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    return text.upper() if upper else text


def _normalize_reference_name(value: str | None) -> str:
    return " ".join((value or "").strip().lower().split())


def _clean_digits(value: str | None) -> str | None:
    text = "".join(ch for ch in str(value or "") if ch.isdigit())
    return text or None


def _normalize_purchase_nature(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    if not normalized:
        return None
    aliases = {"produit": "product", "products": "product", "service": "service", "services": "service"}
    normalized = aliases.get(normalized, normalized)
    if normalized not in {"product", "service"}:
        raise HTTPException(400, "Nature d'achat invalide.")
    return normalized


def _normalize_purchase_tags(values: list[str] | None) -> list[str] | None:
    tags: list[str] = []
    for raw in values or []:
        tag = str(raw or "").strip()
        if tag and tag not in tags:
            tags.append(tag[:40])
    return tags or None


def _round_amount(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"))


def _normalize_purchase_vat_rate(value: Decimal | int | float | str | None) -> Decimal | None:
    if value is None:
        return None
    rate = _round_amount(Decimal(str(value)))
    if rate < 0 or rate > 100:
        raise HTTPException(400, "Taux TVA fournisseur invalide.")
    return rate


def _normalize_purchase_supplier_vat_rules(
    values: list[PurchaseSupplierVatRuleRequest] | list[dict] | None,
) -> list[dict] | None:
    rules_by_key: dict[tuple[str, str], dict] = {}
    for raw in values or []:
        if isinstance(raw, dict):
            accounting_account = raw.get("accounting_account")
            purchase_nature = raw.get("purchase_nature")
            vat_rate = raw.get("vat_rate")
        else:
            accounting_account = raw.accounting_account
            purchase_nature = raw.purchase_nature
            vat_rate = raw.vat_rate
        account = _clean_text(accounting_account)
        nature = _normalize_purchase_nature(purchase_nature) if purchase_nature else None
        if not account and not nature:
            continue
        rate = _normalize_purchase_vat_rate(vat_rate)
        if rate is None:
            continue
        key = (account or "", nature or "")
        rules_by_key[key] = {
            "accounting_account": account,
            "purchase_nature": nature,
            "vat_rate": float(rate),
        }
    rules = list(rules_by_key.values())
    return rules or None


def _purchase_supplier_vat_rule_match(
    row: PurchaseSupplier,
    *,
    accounting_account: str | None,
    purchase_nature: str | None,
) -> tuple[Decimal | None, dict | None]:
    account = _clean_text(accounting_account)
    nature = _normalize_purchase_nature(purchase_nature) if purchase_nature else None
    best_rate: Decimal | None = None
    best_rule: dict | None = None
    best_score = -1
    for raw in row.vat_rules or []:
        if not isinstance(raw, dict):
            continue
        rule_account = _clean_text(raw.get("accounting_account"))
        try:
            rule_nature = _normalize_purchase_nature(raw.get("purchase_nature")) if raw.get("purchase_nature") else None
            rule_rate = _normalize_purchase_vat_rate(raw.get("vat_rate"))
        except HTTPException:
            continue
        if rule_rate is None or (not rule_account and not rule_nature):
            continue
        if rule_account and rule_account != account:
            continue
        if rule_nature and rule_nature != nature:
            continue
        score = (2 if rule_account else 0) + (1 if rule_nature else 0)
        if score > best_score:
            best_score = score
            best_rate = rule_rate
            best_rule = {
                "accounting_account": rule_account,
                "purchase_nature": rule_nature,
                "vat_rate": float(rule_rate),
            }
    return best_rate, best_rule


def _purchase_supplier_vat_rate_for_invoice(
    row: PurchaseSupplier,
    inv: InboundInvoice,
    *,
    accounting_account: str | None = None,
    purchase_nature: str | None = None,
) -> tuple[Decimal | None, str, dict | None]:
    rule_rate, rule = _purchase_supplier_vat_rule_match(
        row,
        accounting_account=accounting_account if accounting_account is not None else inv.accounting_account,
        purchase_nature=purchase_nature if purchase_nature is not None else inv.purchase_nature,
    )
    if rule_rate is not None:
        return rule_rate, "supplier_exception", rule
    default_rate = _normalize_purchase_vat_rate(row.default_vat_rate)
    if default_rate is not None:
        return default_rate, "supplier_rule", None
    return None, "supplier_rule", None


def _purchase_line_decimal(raw: dict, key: str) -> Decimal:
    return _round_amount(Decimal(str(raw.get(key) or 0)))


def _apply_purchase_vat_rate_to_lines(
    *,
    inv: InboundInvoice,
    supplier_ref: PurchaseSupplier | None,
    explicit_rate: Decimal | None,
    use_supplier_rules: bool,
) -> tuple[bool, str | None, list[dict], Decimal | None, str | None, dict | None]:
    lines = [dict(raw) for raw in inv.purchase_lines or [] if isinstance(raw, dict)]
    if not lines:
        return False, "ventilation détaillée absente", [], None, None, None

    updated_lines: list[dict] = []
    changed_count = 0
    total_ex_vat = Decimal("0")
    total_vat = Decimal("0")
    first_rate: Decimal | None = None
    first_rate_source: str | None = None
    first_rule: dict | None = None

    for index, raw in enumerate(lines, start=1):
        line_ht = _purchase_line_decimal(raw, "total_ex_vat")
        if line_ht <= 0:
            updated_lines.append(raw)
            continue
        current_vat = _purchase_line_decimal(raw, "total_vat")
        if current_vat <= 0 and _purchase_line_zero_vat_has_reason(raw):
            line = {
                **raw,
                "label": _clean_text(raw.get("label")) or f"Ligne {index}",
                "total_ex_vat": float(line_ht),
                "vat_rate": float(_normalize_purchase_vat_rate(raw.get("vat_rate")) or Decimal("0.00")),
                "total_vat": 0.0,
                "total_ttc": float(line_ht),
                "accounting_account": _clean_text(raw.get("accounting_account")),
                "purchase_nature": _normalize_purchase_nature(raw.get("purchase_nature"))
                if raw.get("purchase_nature")
                else None,
            }
            updated_lines.append(line)
            total_ex_vat += line_ht
            continue
        line = {
            **raw,
            "label": _clean_text(raw.get("label")) or f"Ligne {index}",
            "total_ex_vat": float(line_ht),
            "accounting_account": _clean_text(raw.get("accounting_account")),
            "purchase_nature": _normalize_purchase_nature(raw.get("purchase_nature"))
            if raw.get("purchase_nature")
            else None,
        }
        if current_vat > 0:
            rate = _normalize_purchase_vat_rate(raw.get("vat_rate")) or Decimal("0.00")
            line["vat_rate"] = float(rate)
            line["total_vat"] = float(current_vat)
            line["total_ttc"] = float(_round_amount(line_ht + current_vat))
            updated_lines.append(line)
            total_ex_vat += line_ht
            total_vat += current_vat
            continue

        rate = explicit_rate
        rate_source = "manual"
        matched_rule = None
        if use_supplier_rules:
            if not supplier_ref:
                return False, "règle TVA fournisseur absente", [], None, None, None
            rate, rate_source, matched_rule = _purchase_supplier_vat_rate_for_invoice(
                supplier_ref,
                inv,
                accounting_account=line["accounting_account"],
                purchase_nature=line["purchase_nature"],
            )
        if rate is None:
            return False, "taux TVA manquant sur une ligne", [], None, None, None

        line_vat = _round_amount(line_ht * rate / Decimal("100"))
        line["vat_rate"] = float(rate)
        line["total_vat"] = float(line_vat)
        line["total_ttc"] = float(_round_amount(line_ht + line_vat))
        updated_lines.append(line)
        total_ex_vat += line_ht
        total_vat += line_vat
        changed_count += 1
        if first_rate is None:
            first_rate = rate
            first_rate_source = rate_source
            first_rule = matched_rule

    if changed_count <= 0:
        return False, "TVA déjà renseignée sur les lignes", [], None, None, None
    inv.purchase_lines = updated_lines
    inv.total_ex_vat = _round_amount(total_ex_vat)
    inv.total_vat = _round_amount(total_vat)
    inv.total_ttc = _round_amount(total_ex_vat + total_vat)
    return True, None, updated_lines, first_rate, first_rate_source, first_rule


def _normalize_purchase_lines(
    values: list[PurchaseLineRequest] | None,
) -> tuple[list[dict] | None, Decimal, Decimal, Decimal]:
    lines: list[dict] = []
    total_ex_vat = Decimal("0")
    total_vat = Decimal("0")
    for index, raw in enumerate(values or [], start=1):
        line_ht = _round_amount(raw.total_ex_vat or Decimal("0"))
        if line_ht <= 0:
            continue
        line_vat = raw.total_vat
        if raw.vat_rate is not None:
            vat_rate = _round_amount(raw.vat_rate)
        elif line_vat is not None:
            vat_rate = _round_amount((line_vat or Decimal("0")) * Decimal("100") / line_ht)
        elif (
            raw.vat_category
            or raw.exemption_reason_code
            or raw.vat_exemption_reason
            or raw.vat_zero_reason
            or raw.vat_reverse_charge
        ):
            vat_rate = Decimal("0")
        else:
            vat_rate = Decimal("20")
        if raw.vat_rate is not None:
            line_vat = _round_amount(line_ht * vat_rate / Decimal("100"))
        elif line_vat is None:
            line_vat = _round_amount(line_ht * vat_rate / Decimal("100"))
        else:
            line_vat = _round_amount(line_vat)
        nature = _normalize_purchase_nature(raw.purchase_nature) if raw.purchase_nature else None
        account = _clean_text(raw.accounting_account)
        label = _clean_text(raw.label) or f"Ligne {index}"
        vat_category = _clean_text(raw.vat_category, upper=True) or ("S" if vat_rate > 0 else None)
        exemption_reason_code = _clean_text(raw.exemption_reason_code, upper=True)
        vat_exemption_reason = _clean_text(raw.vat_exemption_reason)
        vat_zero_reason = _clean_text(raw.vat_zero_reason)
        source = _clean_text(raw.source)
        lines.append(
            {
                "label": label,
                "total_ex_vat": float(line_ht),
                "vat_rate": float(vat_rate),
                "total_vat": float(line_vat),
                "total_ttc": float(_round_amount(line_ht + line_vat)),
                "accounting_account": account,
                "purchase_nature": nature,
                "vat_category": vat_category,
                "exemption_reason_code": exemption_reason_code,
                "vat_exemption_reason": vat_exemption_reason,
                "vat_zero_reason": vat_zero_reason,
                "vat_reverse_charge": bool(raw.vat_reverse_charge),
                "source": source,
            }
        )
        total_ex_vat += line_ht
        total_vat += line_vat
    if not lines:
        return None, Decimal("0"), Decimal("0"), Decimal("0")
    total_ex_vat = _round_amount(total_ex_vat)
    total_vat = _round_amount(total_vat)
    return lines, total_ex_vat, total_vat, _round_amount(total_ex_vat + total_vat)


def _purchase_default_vat_rate_from_invoice(inv: InboundInvoice) -> Decimal | None:
    if inv.purchase_lines:
        rates: set[Decimal] = set()
        has_deductible_vat = False
        for raw in inv.purchase_lines or []:
            if not isinstance(raw, dict):
                continue
            total_ex_vat = _round_amount(Decimal(str(raw.get("total_ex_vat") or 0)))
            if total_ex_vat <= 0:
                continue
            total_vat = _round_amount(Decimal(str(raw.get("total_vat") or 0)))
            if total_vat > 0:
                has_deductible_vat = True
            rates.add(_round_amount(Decimal(str(raw.get("vat_rate") or 0))))
        if has_deductible_vat and len(rates) == 1:
            return next(iter(rates))
        return None

    total_ex_vat = _round_amount(Decimal(str(inv.total_ex_vat or 0)))
    total_vat = _round_amount(Decimal(str(inv.total_vat or 0)))
    if total_ex_vat <= 0 or total_vat <= 0:
        return None
    return _normalize_purchase_vat_rate((total_vat / total_ex_vat) * Decimal("100"))


def _normalize_employee_payer_role(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    if not normalized:
        return None
    aliases = {
        "salarié": "employee",
        "salarie": "employee",
        "employee": "employee",
        "dirigeant": "manager",
        "manager": "manager",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized not in {"employee", "manager"}:
        raise HTTPException(400, "Rôle du payeur invalide.")
    return normalized


def _normalize_employee_reimbursement_method(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    if not normalized:
        return None
    aliases = {
        "virement": "bank_transfer",
        "bank": "bank_transfer",
        "bank_transfer": "bank_transfer",
        "espèces": "cash",
        "especes": "cash",
        "cash": "cash",
        "note": "expense_report",
        "expense_report": "expense_report",
        "autre": "other",
        "other": "other",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized not in {"bank_transfer", "cash", "expense_report", "other"}:
        raise HTTPException(400, "Mode de remboursement invalide.")
    return normalized


def _normalize_employee_reimbursement_status(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    if not normalized:
        return None
    aliases = {
        "à rembourser": "to_reimburse",
        "a rembourser": "to_reimburse",
        "pending": "to_reimburse",
        "to_reimburse": "to_reimburse",
        "remboursé": "reimbursed",
        "rembourse": "reimbursed",
        "reimbursed": "reimbursed",
        "non remboursable": "not_reimbursed",
        "not_reimbursed": "not_reimbursed",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized not in {"to_reimburse", "reimbursed", "not_reimbursed"}:
        raise HTTPException(400, "Statut de remboursement invalide.")
    return normalized


def _purchase_supplier_customer_match(
    db: Session,
    tenant_id: str,
    *,
    name: str | None = None,
    siren: str | None = None,
    siret: str | None = None,
    vat_number: str | None = None,
) -> dict | None:
    clean_siret = _clean_digits(siret)
    clean_siren = _clean_digits(siren)
    clean_vat = (_clean_text(vat_number, upper=True) or "").replace(" ", "")
    normalized_name = _normalize_reference_name(name)
    checks = []
    if clean_siret:
        checks.append((Customer.siret == clean_siret, "siret"))
    if clean_vat:
        checks.append((func.upper(func.coalesce(Customer.vat_number, "")) == clean_vat, "vat_number"))
    if clean_siren:
        checks.append((Customer.siren == clean_siren, "siren"))
    if normalized_name:
        checks.append((func.lower(func.coalesce(Customer.name, "")) == normalized_name, "name"))
    for condition, reason in checks:
        row = (
            db.query(Customer)
            .filter(Customer.tenant_id == tenant_id, condition)
            .order_by(Customer.created_at.desc())
            .first()
        )
        if row:
            return {"id": row.id, "name": row.name, "reason": reason}
    return None


def _purchase_supplier_payload(
    row: PurchaseSupplier,
    *,
    invoice_count: int = 0,
    last_received_at=None,
    customer_match: dict | None = None,
) -> dict:
    return {
        "id": row.id,
        "supplier_name": row.name,
        "supplier_siren": row.siren,
        "supplier_siret": row.siret,
        "vat_number": row.vat_number,
        "default_accounting_account": row.default_accounting_account,
        "default_purchase_nature": row.default_purchase_nature,
        "default_payment_delay_days": row.default_payment_delay_days,
        "default_vat_rate": float(row.default_vat_rate) if row.default_vat_rate is not None else None,
        "vat_rules": _normalize_purchase_supplier_vat_rules(row.vat_rules),
        "notes": row.notes,
        "invoice_count": int(invoice_count or 0),
        "last_received_at": last_received_at,
        "last_used_at": row.last_used_at,
        "customer_match": customer_match,
        "source": "reference",
    }


def _purchase_supplier_duplicate_values(row: PurchaseSupplier) -> dict[str, str]:
    return {
        "siret": _clean_digits(row.siret) or "",
        "siren": _clean_digits(row.siren) or "",
        "vat_number": (_clean_text(row.vat_number, upper=True) or "").replace(" ", ""),
        "name": _normalize_reference_name(row.name) or "",
    }


def _purchase_supplier_shared_duplicate_keys(left: PurchaseSupplier, right: PurchaseSupplier) -> set[tuple[str, str]]:
    left_values = _purchase_supplier_duplicate_values(left)
    right_values = _purchase_supplier_duplicate_values(right)
    return {(field, value) for field, value in left_values.items() if value and right_values.get(field) == value}


def _purchase_employee_payer_payload(row: PurchaseEmployeePayer) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "role": row.role,
        "user_label": row.user_label,
        "default_accounting_account": row.default_accounting_account,
        "reimbursement_method": row.reimbursement_method,
        "vehicle_type": row.vehicle_type,
        "fiscal_power": row.fiscal_power,
        "notes": row.notes,
        "last_used_at": row.last_used_at,
        "source": "reference",
    }


def _upsert_purchase_supplier(
    db: Session,
    tenant_id: str,
    *,
    name: str | None,
    supplier_siren: str | None = None,
    supplier_siret: str | None = None,
    vat_number: str | None = None,
    accounting_account: str | None = None,
    payment_delay_days: int | None = None,
    purchase_nature: str | None = None,
    vat_rate: Decimal | int | float | str | None = None,
    vat_rules: list[PurchaseSupplierVatRuleRequest] | list[dict] | None = None,
    replace_vat_rules: bool = False,
    notes: str | None = None,
) -> PurchaseSupplier | None:
    clean_name = _clean_text(name)
    normalized_name = _normalize_reference_name(clean_name)
    if not clean_name or not normalized_name:
        return None
    clean_siren = _clean_digits(supplier_siren)
    clean_siret = _clean_digits(supplier_siret)
    clean_vat = (_clean_text(vat_number, upper=True) or "").replace(" ", "") or None
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = None
    if clean_siret:
        row = (
            db.query(PurchaseSupplier)
            .filter(PurchaseSupplier.tenant_id == tenant_id, PurchaseSupplier.siret == clean_siret)
            .first()
        )
    if not row and clean_siren:
        row = (
            db.query(PurchaseSupplier)
            .filter(PurchaseSupplier.tenant_id == tenant_id, PurchaseSupplier.siren == clean_siren)
            .first()
        )
    if not row and clean_vat:
        row = (
            db.query(PurchaseSupplier)
            .filter(
                PurchaseSupplier.tenant_id == tenant_id,
                func.upper(func.coalesce(PurchaseSupplier.vat_number, "")) == clean_vat,
            )
            .first()
        )
    if not row:
        row = (
            db.query(PurchaseSupplier)
            .filter(PurchaseSupplier.tenant_id == tenant_id, PurchaseSupplier.normalized_name == normalized_name)
            .first()
        )
    if not row:
        row = PurchaseSupplier(
            tenant_id=tenant_id,
            name=clean_name,
            normalized_name=normalized_name,
            created_at=now,
            updated_at=now,
        )
    if row.normalized_name == normalized_name:
        row.name = clean_name
    row.is_active = True
    row.last_used_at = now
    row.updated_at = now
    row.siren = clean_siren or row.siren
    row.siret = clean_siret or row.siret
    row.vat_number = clean_vat or row.vat_number
    row.default_accounting_account = _clean_text(accounting_account) or row.default_accounting_account
    normalized_nature = _normalize_purchase_nature(purchase_nature) if purchase_nature else None
    row.default_purchase_nature = normalized_nature or row.default_purchase_nature
    normalized_vat_rate = _normalize_purchase_vat_rate(vat_rate)
    row.default_vat_rate = normalized_vat_rate if normalized_vat_rate is not None else row.default_vat_rate
    if replace_vat_rules:
        row.vat_rules = _normalize_purchase_supplier_vat_rules(vat_rules)
    if payment_delay_days is not None:
        row.default_payment_delay_days = max(0, min(int(payment_delay_days), 365))
    row.notes = _clean_text(notes) or row.notes
    db.add(row)
    return row


def _purchase_supplier_reference_for_invoice(
    db: Session,
    tenant_id: str,
    inv: InboundInvoice,
) -> PurchaseSupplier | None:
    clean_siret = _clean_digits(inv.supplier_siret)
    clean_siren = _clean_digits(inv.supplier_siren)
    normalized_name = _normalize_reference_name(inv.supplier_name)
    base_filters = [PurchaseSupplier.tenant_id == tenant_id, PurchaseSupplier.is_active.is_(True)]
    if clean_siret:
        row = db.query(PurchaseSupplier).filter(*base_filters, PurchaseSupplier.siret == clean_siret).first()
        if row:
            return row
    if clean_siren:
        row = db.query(PurchaseSupplier).filter(*base_filters, PurchaseSupplier.siren == clean_siren).first()
        if row:
            return row
    if normalized_name:
        return (
            db.query(PurchaseSupplier)
            .filter(*base_filters, PurchaseSupplier.normalized_name == normalized_name)
            .first()
        )
    return None


def _upsert_purchase_employee_payer(
    db: Session,
    tenant_id: str,
    *,
    name: str | None,
    role: str | None = None,
    user_label: str | None = None,
    accounting_account: str | None = None,
    reimbursement_method: str | None = None,
    vehicle_type: str | None = None,
    fiscal_power: str | None = None,
    notes: str | None = None,
) -> PurchaseEmployeePayer | None:
    clean_name = _clean_text(name)
    normalized_name = _normalize_reference_name(clean_name)
    if not clean_name or not normalized_name:
        return None
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = (
        db.query(PurchaseEmployeePayer)
        .filter(PurchaseEmployeePayer.tenant_id == tenant_id, PurchaseEmployeePayer.normalized_name == normalized_name)
        .first()
    )
    if not row:
        row = PurchaseEmployeePayer(
            tenant_id=tenant_id,
            name=clean_name,
            normalized_name=normalized_name,
            role="manager",
            created_at=now,
            updated_at=now,
        )
    row.name = clean_name
    row.role = _normalize_employee_payer_role(role) or row.role or "manager"
    row.user_label = _clean_text(user_label) or row.user_label
    row.default_accounting_account = _clean_text(accounting_account) or row.default_accounting_account
    row.reimbursement_method = (
        _normalize_employee_reimbursement_method(reimbursement_method) or row.reimbursement_method
    )
    row.vehicle_type = _clean_text(vehicle_type) or row.vehicle_type
    row.fiscal_power = _clean_text(fiscal_power) or row.fiscal_power
    row.notes = _clean_text(notes) or row.notes
    row.is_active = True
    row.last_used_at = now
    row.updated_at = now
    db.add(row)
    return row


def _purchase_payment_delay_days(issue_date: date | None, planned_payment_date: date | None) -> int | None:
    if not issue_date or not planned_payment_date:
        return None
    days = (planned_payment_date - issue_date).days
    return days if days >= 0 else None


def _purchase_completion_missing_fields(row: InboundInvoice, *, require_accounting_account: bool = False) -> list[str]:
    def _account_missing_or_temporary(value: object) -> bool:
        return account_needs_completion(value)

    missing: list[str] = []
    if not (row.supplier_name or "").strip():
        missing.append("fournisseur")
    if not (row.invoice_number or "").strip():
        missing.append("numéro de facture")
    if not row.issue_date:
        missing.append("date de facture")
    if row.total_ttc is None or row.total_ttc < 0:
        missing.append("montant TTC")
    if require_accounting_account:
        lines = row.purchase_lines if isinstance(row.purchase_lines, list) else []
        meaningful_lines = []
        for raw in lines:
            if not isinstance(raw, dict):
                continue
            try:
                amount = Decimal(str(raw.get("total_ex_vat") or 0))
            except Exception:
                amount = Decimal("0")
            if amount:
                meaningful_lines.append(raw)
        if meaningful_lines:
            fallback_account = _clean_text(row.accounting_account)
            missing_line_accounts = [
                str(idx)
                for idx, raw in enumerate(meaningful_lines, start=1)
                if _account_missing_or_temporary(_clean_text(raw.get("accounting_account")) or fallback_account)
            ]
            if missing_line_accounts:
                missing.append(f"compte comptable ligne {', '.join(missing_line_accounts)}")
        elif _account_missing_or_temporary(row.accounting_account):
            missing.append("compte comptable")
    return missing


def _purchase_vat_reviewed(row: InboundInvoice) -> bool:
    return bool(row.completion_validated_at)


def _purchase_line_zero_vat_has_reason(raw: dict) -> bool:
    category = _clean_text(raw.get("vat_category"), upper=True)
    return bool(
        category in {"AE", "E", "O", "Z", "G", "K"}
        or _clean_text(raw.get("exemption_reason_code"), upper=True)
        or _clean_text(raw.get("vat_exemption_reason"))
        or _clean_text(raw.get("vat_zero_reason"))
        or raw.get("vat_reverse_charge")
    )


def _purchase_zero_vat_missing_reason(row: InboundInvoice) -> bool:
    if _round_amount(Decimal(str(row.total_ttc or 0))) <= 0:
        return False
    if _round_amount(Decimal(str(row.total_vat or 0))) > 0:
        return False
    lines = row.purchase_lines if isinstance(row.purchase_lines, list) else []
    meaningful_lines = [
        raw for raw in lines if isinstance(raw, dict) and _purchase_line_decimal(raw, "total_ex_vat") > Decimal("0")
    ]
    if not meaningful_lines:
        return True
    for raw in meaningful_lines:
        if _purchase_line_decimal(raw, "total_vat") <= Decimal("0") and not _purchase_line_zero_vat_has_reason(raw):
            return True
    return False


def _purchase_amounts_inconsistent(row: InboundInvoice) -> bool:
    if row.total_ex_vat is None or row.total_vat is None or row.total_ttc is None:
        return False
    return abs(
        _round_amount(Decimal(str(row.total_ex_vat or 0)))
        + _round_amount(Decimal(str(row.total_vat or 0)))
        - _round_amount(Decimal(str(row.total_ttc or 0)))
    ) > Decimal("0.02")


def _find_purchase_duplicate(db: Session, row: InboundInvoice) -> str | None:
    if not row.invoice_number or not row.issue_date or row.total_ttc is None:
        return None
    query = db.query(InboundInvoice.id).filter(
        InboundInvoice.tenant_id == row.tenant_id,
        InboundInvoice.id != row.id,
        InboundInvoice.invoice_number == row.invoice_number,
        InboundInvoice.issue_date == row.issue_date,
        InboundInvoice.total_ttc == row.total_ttc,
    )
    if row.supplier_siret:
        query = query.filter(InboundInvoice.supplier_siret == row.supplier_siret)
    elif row.supplier_siren:
        query = query.filter(InboundInvoice.supplier_siren == row.supplier_siren)
    elif row.supplier_name:
        query = query.filter(func.lower(func.coalesce(InboundInvoice.supplier_name, "")) == row.supplier_name.lower())
    else:
        return None
    duplicate = query.first()
    return duplicate[0] if duplicate else None


@router.get("", response_model=InboundInvoiceListResponse)
def list_inbox(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    q: str | None = Query(default=None, max_length=120),
    status: str | None = Query(default=None),
    validation_status: str | None = Query(default=None),
    received_from: date | None = Query(default=None),
    received_to: date | None = Query(default=None),
    issue_from: date | None = Query(default=None),
    issue_to: date | None = Query(default=None),
    vat_correction: bool = Query(False, description="Limiter aux achats à corriger pour la TVA"),
    purchase_board: str | None = Query(default=None, max_length=32),
    purchase_kind: str | None = Query(default=None, max_length=32),
    amount_min: Decimal | None = Query(default=None),
    amount_max: Decimal | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    _ensure_seqino_mandate_for_inbox(db, user.tenant_id)
    board = (purchase_board or "").strip().lower()
    query = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == user.tenant_id)
    query = _apply_inbox_filters(
        query,
        db=db,
        tenant_id=user.tenant_id,
        q_text=q,
        status=status,
        validation_status=validation_status,
        received_from=received_from,
        received_to=received_to,
        issue_from=issue_from,
        issue_to=issue_to,
        vat_correction=vat_correction,
        purchase_board=board,
        purchase_kind=purchase_kind,
        amount_min=amount_min,
        amount_max=amount_max,
    )
    total = query.count()
    rows = (
        query.order_by(InboundInvoice.received_at.desc(), InboundInvoice.created_at.desc(), InboundInvoice.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    _annotate_purchase_rows(db, rows)
    pages = math.ceil(total / page_size) if page_size else 1
    return {"items": rows, "page": page, "page_size": page_size, "total": total, "pages": pages}


@router.get("/export")
def export_inbox_csv(
    q: str | None = Query(default=None, max_length=120),
    status: str | None = Query(default=None),
    validation_status: str | None = Query(default=None),
    received_from: date | None = Query(default=None),
    received_to: date | None = Query(default=None),
    issue_from: date | None = Query(default=None),
    issue_to: date | None = Query(default=None),
    vat_correction: bool = Query(False, description="Limiter aux achats à corriger pour la TVA"),
    purchase_board: str | None = Query(default=None, max_length=32),
    purchase_kind: str | None = Query(default=None, max_length=32),
    amount_min: Decimal | None = Query(default=None),
    amount_max: Decimal | None = Query(default=None),
    ids: list[str] | None = Query(default=None, description="Limiter l'export aux achats sélectionnés"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    _ensure_seqino_mandate_for_inbox(db, user.tenant_id)
    board = (purchase_board or "").strip().lower()
    query = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == user.tenant_id)
    query = _apply_inbox_filters(
        query,
        db=db,
        tenant_id=user.tenant_id,
        q_text=q,
        status=status,
        validation_status=validation_status,
        received_from=received_from,
        received_to=received_to,
        issue_from=issue_from,
        issue_to=issue_to,
        vat_correction=vat_correction,
        purchase_board=board,
        purchase_kind=purchase_kind,
        amount_min=amount_min,
        amount_max=amount_max,
    )
    selected_ids = [str(value).strip() for value in ids or [] if str(value or "").strip()]
    if selected_ids:
        if len(selected_ids) > 500:
            raise HTTPException(400, "Export limité à 500 achats sélectionnés.")
        query = query.filter(InboundInvoice.id.in_(selected_ids))
    _ensure_sync_export_limit(query, label="achats")
    rows = query.order_by(
        InboundInvoice.received_at.desc(), InboundInvoice.created_at.desc(), InboundInvoice.id.desc()
    ).all()
    workflow_states = _read_purchase_workflow_states(db, user.tenant_id)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "received_at",
            "issue_date",
            "supplier_name",
            "supplier_siren",
            "supplier_siret",
            "invoice_number",
            "total_ex_vat",
            "total_vat",
            "total_ttc",
            "currency",
            "status",
            "workflow_state",
            "workflow_label",
            "planned_payment_date",
            "accounting_account",
            "completion_status",
            "format",
            "vat_categories",
            "vat_exemption_reason_codes",
            "reverse_charge",
        ]
    )
    for inv in rows:
        workflow_state, workflow_label = _purchase_workflow_state_for_export(inv, workflow_states)
        vat_categories, vat_reason_codes, reverse_charge = _purchase_vat_export_summary(inv)
        writer.writerow(
            [
                inv.received_at.isoformat() if inv.received_at else "",
                inv.issue_date.isoformat() if inv.issue_date else "",
                _sanitize_csv_cell(inv.supplier_name),
                _sanitize_csv_cell(inv.supplier_siren),
                _sanitize_csv_cell(inv.supplier_siret),
                _sanitize_csv_cell(inv.invoice_number),
                str(inv.total_ex_vat or ""),
                str(inv.total_vat or ""),
                str(inv.total_ttc or ""),
                _sanitize_csv_cell(inv.currency),
                _sanitize_csv_cell(inv.status),
                _sanitize_csv_cell(workflow_state),
                _sanitize_csv_cell(workflow_label),
                inv.planned_payment_date.isoformat() if inv.planned_payment_date else "",
                _sanitize_csv_cell(inv.accounting_account),
                _sanitize_csv_cell(inv.completion_status),
                _sanitize_csv_cell(inv.format),
                _sanitize_csv_cell(vat_categories),
                _sanitize_csv_cell(vat_reason_codes),
                _sanitize_csv_cell(reverse_charge),
            ]
        )
    filename = "achats_fournisseurs.csv"
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/summary")
def inbox_summary(
    q: str | None = Query(default=None, max_length=120),
    status: str | None = Query(default=None),
    validation_status: str | None = Query(default=None),
    received_from: date | None = Query(default=None),
    received_to: date | None = Query(default=None),
    issue_from: date | None = Query(default=None),
    issue_to: date | None = Query(default=None),
    vat_correction: bool = Query(False, description="Limiter aux achats à corriger pour la TVA"),
    purchase_board: str | None = Query(default=None, max_length=32),
    purchase_kind: str | None = Query(default=None, max_length=32),
    amount_min: Decimal | None = Query(default=None),
    amount_max: Decimal | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    _ensure_seqino_mandate_for_inbox(db, user.tenant_id)
    board = (purchase_board or "").strip().lower()
    base = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == user.tenant_id)
    base = _apply_inbox_filters(
        base,
        db=db,
        tenant_id=user.tenant_id,
        q_text=q,
        status=status,
        validation_status=validation_status,
        received_from=received_from,
        received_to=received_to,
        issue_from=issue_from,
        issue_to=issue_to,
        vat_correction=vat_correction,
        purchase_board=board,
        purchase_kind=purchase_kind,
        amount_min=amount_min,
        amount_max=amount_max,
    )

    window_start = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=30)
    total_count = base.count()
    total_ttc = base.with_entities(func.coalesce(func.sum(InboundInvoice.total_ttc), 0)).scalar() or 0
    total_ex_vat = base.with_entities(func.coalesce(func.sum(InboundInvoice.total_ex_vat), 0)).scalar() or 0
    total_vat = base.with_entities(func.coalesce(func.sum(InboundInvoice.total_vat), 0)).scalar() or 0
    recent_count = base.filter(InboundInvoice.received_at >= window_start).count()
    recent_ttc = (
        base.filter(InboundInvoice.received_at >= window_start)
        .with_entities(func.coalesce(func.sum(InboundInvoice.total_ttc), 0))
        .scalar()
        or 0
    )
    distinct_suppliers = (
        base.with_entities(
            func.count(
                func.distinct(
                    func.coalesce(
                        InboundInvoice.supplier_siret, InboundInvoice.supplier_siren, InboundInvoice.supplier_name, ""
                    )
                )
            )
        ).scalar()
        or 0
    )

    status_rows = (
        base.with_entities(InboundInvoice.status, func.count(InboundInvoice.id)).group_by(InboundInvoice.status).all()
    )
    validation_rows = (
        base.with_entities(func.coalesce(InboundInvoice.validation_status, "skipped"), func.count(InboundInvoice.id))
        .group_by(func.coalesce(InboundInvoice.validation_status, "skipped"))
        .all()
    )
    top_supplier_rows = (
        base.with_entities(
            func.coalesce(InboundInvoice.supplier_name, "Fournisseur inconnu").label("supplier_name"),
            func.coalesce(InboundInvoice.supplier_siret, InboundInvoice.supplier_siren, "").label("legal_id"),
            func.count(InboundInvoice.id).label("invoice_count"),
            func.coalesce(func.sum(InboundInvoice.total_ttc), 0).label("total_ttc"),
            func.max(InboundInvoice.received_at).label("last_received_at"),
        )
        .group_by(
            func.coalesce(InboundInvoice.supplier_name, "Fournisseur inconnu"),
            func.coalesce(InboundInvoice.supplier_siret, InboundInvoice.supplier_siren, ""),
        )
        .order_by(func.count(InboundInvoice.id).desc(), func.max(InboundInvoice.received_at).desc())
        .limit(6)
        .all()
    )

    latest_received_at = base.with_entities(func.max(InboundInvoice.received_at)).scalar()

    def _purchase_board_count(*, board_value: str | None = None, vat_only: bool = False) -> int:
        count_query = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == user.tenant_id)
        count_query = _apply_inbox_filters(
            count_query,
            db=db,
            tenant_id=user.tenant_id,
            q_text=q,
            status=status,
            validation_status=validation_status,
            received_from=received_from,
            received_to=received_to,
            issue_from=issue_from,
            issue_to=issue_to,
            vat_correction=vat_only,
            purchase_board=board_value,
            purchase_kind=purchase_kind,
            amount_min=amount_min,
            amount_max=amount_max,
        )
        return int(count_query.count() or 0)

    paid_totals_subquery = (
        db.query(
            PurchasePayment.inbound_invoice_id.label("invoice_id"),
            func.coalesce(func.sum(PurchasePayment.amount), 0).label("paid_amount"),
        )
        .filter(PurchasePayment.tenant_id == user.tenant_id)
        .group_by(PurchasePayment.inbound_invoice_id)
        .subquery()
    )

    def _purchase_board_amount(*, board_value: str, remaining_due: bool = False) -> Decimal:
        amount_query = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == user.tenant_id)
        amount_query = _apply_inbox_filters(
            amount_query,
            db=db,
            tenant_id=user.tenant_id,
            q_text=q,
            status=status,
            validation_status=validation_status,
            received_from=received_from,
            received_to=received_to,
            issue_from=issue_from,
            issue_to=issue_to,
            vat_correction=vat_correction,
            purchase_board=board_value,
            purchase_kind=purchase_kind,
            amount_min=amount_min,
            amount_max=amount_max,
        )
        amount_query = amount_query.outerjoin(
            paid_totals_subquery,
            paid_totals_subquery.c.invoice_id == InboundInvoice.id,
        )
        total_ttc_expr = func.coalesce(InboundInvoice.total_ttc, 0)
        if remaining_due:
            remaining_expr = total_ttc_expr - func.coalesce(paid_totals_subquery.c.paid_amount, 0)
            amount_expr = case((remaining_expr > 0, remaining_expr), else_=0)
        else:
            amount_expr = total_ttc_expr
        return Decimal(str(amount_query.with_entities(func.coalesce(func.sum(amount_expr), 0)).scalar() or 0))

    purchase_board_counts = {
        "all": _purchase_board_count(),
        "vat_corrections": _purchase_board_count(vat_only=True),
        "to_complete": _purchase_board_count(board_value="to_complete"),
        "ready_to_pay": _purchase_board_count(board_value="ready_to_pay"),
        "paid": _purchase_board_count(board_value="paid"),
    }
    purchase_board_amounts = {
        "ready_to_pay": float(_purchase_board_amount(board_value="ready_to_pay", remaining_due=True)),
        "paid": float(_purchase_board_amount(board_value="paid")),
    }

    return {
        "totals": {
            "count": int(total_count or 0),
            "total_ttc": float(total_ttc or 0),
            "total_ex_vat": float(total_ex_vat or 0),
            "total_vat": float(total_vat or 0),
            "last_30_days_count": int(recent_count or 0),
            "last_30_days_ttc": float(recent_ttc or 0),
            "distinct_suppliers": int(distinct_suppliers or 0),
            "latest_received_at": latest_received_at,
        },
        "status_counts": {str(status or "received"): int(count or 0) for status, count in status_rows},
        "validation_counts": {str(status or "skipped"): int(count or 0) for status, count in validation_rows},
        "purchase_board_counts": purchase_board_counts,
        "purchase_board_amounts": purchase_board_amounts,
        "top_suppliers": [
            {
                "supplier_name": supplier_name,
                "legal_id": legal_id or None,
                "invoice_count": int(invoice_count or 0),
                "total_ttc": float(total_ttc_value or 0),
                "last_received_at": last_received_at,
            }
            for supplier_name, legal_id, invoice_count, total_ttc_value, last_received_at in top_supplier_rows
        ],
        "window_days": 30,
    }


@router.post("/import", response_model=InboundInvoiceOut)
async def import_inbound_invoice(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    raw = await file.read(_MAX_IMPORT_BYTES + 1)
    if not raw:
        raise HTTPException(400, "Fichier vide.")
    if len(raw) > _MAX_IMPORT_BYTES:
        raise HTTPException(413, "Fichier trop volumineux.")

    filename = (file.filename or "").strip().lower()
    content_type = (file.content_type or "").strip().lower()
    is_pdf = content_type == "application/pdf" or filename.endswith(".pdf") or raw.startswith(b"%PDF")
    is_xml = (
        content_type in {"application/xml", "text/xml"}
        or filename.endswith(".xml")
        or raw.lstrip().startswith(b"<?xml")
    )
    if not is_pdf and not is_xml:
        raise HTTPException(400, "Format non supporté : importez une facture PDF Factur-X ou un XML CII/UBL.")

    attachments: list[dict[str, object]] = []
    xml_payload: bytes | None = None
    if is_pdf:
        attachments.append({"kind": "pdf", "content": raw})
        xml_payload = _extract_facturx_xml_from_pdf(raw)
        if not xml_payload:
            _reject_non_conforming_import(
                "Fichier non conforme : ce PDF ne contient pas de XML Factur-X exploitable.",
                "Importez une facture Factur-X PDF/A-3 ou demandez au fournisseur un export XML CII/UBL.",
            )
        if xml_payload:
            attachments.append({"kind": "xml", "content": xml_payload})
    if is_xml:
        attachments.append({"kind": "xml", "content": raw})
        xml_payload = raw
    if not xml_payload:
        _reject_non_conforming_import(
            "Fichier non conforme : aucune facture électronique exploitable n'a été trouvée.",
            "Le fichier doit être un PDF Factur-X contenant un XML ou un XML CII/UBL.",
        )
    parsed_import = _parse_supported_import_xml(xml_payload)

    payload = {
        "invoice": {"format": parsed_import.format},
        "attachments": attachments,
    }
    fingerprint = hashlib.sha256(raw).hexdigest()
    message = {
        "id": f"upload-{fingerprint}",
        "received_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        "payload": payload,
    }
    inv = ingest_inbound_message(
        db,
        tenant_id=user.tenant_id,
        provider_slug="manual_import",
        message=message,
    )
    return inv


@router.post("/manual-purchase", response_model=InboundInvoiceOut)
def create_manual_purchase(
    payload: ManualPurchaseRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    kind = (payload.kind or "expense_report").strip().lower()
    if kind not in {"expense_report", "mileage"}:
        raise HTTPException(400, "Type d'achat manuel invalide.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    issue_date = payload.issue_date or now.date()
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=user.tenant_id,
        period_start=issue_date,
        period_end=issue_date,
    )
    if lock:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "accounting_period_locked",
                "message": "Cette date appartient à une période déjà remise au cabinet.",
                "lock": accounting_period_lock_payload(lock),
            },
        )
    purchase_lines, lines_total_ht, lines_total_vat, lines_total_ttc = _normalize_purchase_lines(payload.purchase_lines)
    if purchase_lines:
        total_ex_vat = lines_total_ht
        total_vat = lines_total_vat
        total_ttc = lines_total_ttc
    else:
        total_vat = payload.total_vat or Decimal("0")
        if payload.total_ttc is not None:
            total_ttc = payload.total_ttc
            total_ex_vat = (
                payload.total_ex_vat if payload.total_ex_vat is not None else max(total_ttc - total_vat, Decimal("0"))
            )
        else:
            total_ex_vat = payload.total_ex_vat or Decimal("0")
            total_ttc = total_ex_vat + total_vat

    if total_ttc < 0:
        raise HTTPException(400, "Montant TTC invalide.")
    if abs(_round_amount(total_ex_vat) + _round_amount(total_vat) - _round_amount(total_ttc)) > Decimal("0.02"):
        raise HTTPException(400, "Montants incohérents : HT + TVA doit correspondre au TTC.")

    prefix = "IK" if kind == "mileage" else "NDF"
    invoice_number = (
        payload.invoice_number or ""
    ).strip() or f"{prefix}-{now.strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
    supplier_name = payload.supplier_name.strip()
    note_hash_source = f"{kind}:{supplier_name}:{invoice_number}:{payload.note or ''}:{uuid.uuid4().hex}"
    inv = InboundInvoice(
        tenant_id=user.tenant_id,
        provider_slug="manual_import",
        supplier_name=supplier_name,
        invoice_number=invoice_number,
        issue_date=issue_date,
        total_ex_vat=total_ex_vat,
        total_vat=total_vat,
        total_ttc=total_ttc,
        currency=(payload.currency or "EUR").strip().upper(),
        received_at=now,
        format=kind,
        external_message_id=f"manual-{kind}-{uuid.uuid4().hex}",
        status="imported",
        validation_status="skipped",
        validation_warnings=["Achat saisi manuellement, sans contrôle Factur-X/XML."],
        validated_at=None,
        purchase_nature="service" if kind == "expense_report" else None,
        accounting_account=_clean_text(payload.accounting_account),
        accountant_note=payload.note or None,
        purchase_lines=purchase_lines,
        completion_status="draft",
        completion_validated_at=None,
    )
    apply_purchase_accounting_patch(db, user.tenant_id, inv, user_id=user.id)
    if not _purchase_completion_missing_fields(
        inv, require_accounting_account=True
    ) and not _purchase_zero_vat_missing_reason(inv):
        inv.completion_status = "completed"
        inv.completion_validated_at = now
    db.add(inv)
    db.flush()
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type="manual_purchase_created",
            payload_hash=hashlib.sha256(note_hash_source.encode("utf-8")).hexdigest(),
        )
    )
    db.commit()
    db.refresh(inv)
    return inv


@router.get("/suppliers")
def list_purchase_suppliers(
    q: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=20, ge=1, le=50),
    include_history: bool = Query(True, description="Inclure les fournisseurs trouvés uniquement dans l'historique"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    search = (q or "").strip()
    normalized_search = _normalize_reference_name(search)

    ref_query = db.query(PurchaseSupplier).filter(
        PurchaseSupplier.tenant_id == user.tenant_id,
        PurchaseSupplier.is_active.is_(True),
    )
    if normalized_search:
        term = f"%{normalized_search}%"
        raw_term = f"%{search.lower()}%"
        ref_query = ref_query.filter(
            or_(
                PurchaseSupplier.normalized_name.like(term),
                func.lower(func.coalesce(PurchaseSupplier.siren, "")).like(raw_term),
                func.lower(func.coalesce(PurchaseSupplier.siret, "")).like(raw_term),
            )
        )
    refs = (
        ref_query.order_by(PurchaseSupplier.last_used_at.desc().nullslast(), PurchaseSupplier.updated_at.desc())
        .limit(limit)
        .all()
    )

    stats: dict[str, dict] = {}
    if include_history:
        query = db.query(
            InboundInvoice.supplier_name,
            InboundInvoice.supplier_siren,
            InboundInvoice.supplier_siret,
            func.count(InboundInvoice.id).label("invoice_count"),
            func.max(InboundInvoice.received_at).label("last_received_at"),
        ).filter(
            InboundInvoice.tenant_id == user.tenant_id,
            InboundInvoice.supplier_name.isnot(None),
        )
        if search:
            term = f"%{search.lower()}%"
            query = query.filter(
                or_(
                    func.lower(func.coalesce(InboundInvoice.supplier_name, "")).like(term),
                    func.lower(func.coalesce(InboundInvoice.supplier_siren, "")).like(term),
                    func.lower(func.coalesce(InboundInvoice.supplier_siret, "")).like(term),
                )
            )
        rows = (
            query.group_by(InboundInvoice.supplier_name, InboundInvoice.supplier_siren, InboundInvoice.supplier_siret)
            .order_by(func.max(InboundInvoice.received_at).desc())
            .limit(limit)
            .all()
        )
        for supplier_name, supplier_siren, supplier_siret, invoice_count, last_received_at in rows:
            if not (supplier_name or "").strip():
                continue
            key = _normalize_reference_name(supplier_name)
            stats.setdefault(
                key,
                {
                    "supplier_name": supplier_name,
                    "supplier_siren": supplier_siren,
                    "supplier_siret": supplier_siret,
                    "invoice_count": int(invoice_count or 0),
                    "last_received_at": last_received_at,
                },
            )
    items = []
    for ref in refs:
        stat = stats.pop(ref.normalized_name, {})
        items.append(
            _purchase_supplier_payload(
                ref,
                invoice_count=stat.get("invoice_count", 0),
                last_received_at=stat.get("last_received_at"),
                customer_match=_purchase_supplier_customer_match(
                    db,
                    user.tenant_id,
                    name=ref.name,
                    siren=ref.siren,
                    siret=ref.siret,
                    vat_number=ref.vat_number,
                ),
            )
        )
    for stat in stats.values():
        items.append(
            {
                "id": None,
                "supplier_name": stat["supplier_name"],
                "supplier_siren": stat["supplier_siren"],
                "supplier_siret": stat["supplier_siret"],
                "vat_number": None,
                "default_accounting_account": None,
                "default_purchase_nature": None,
                "default_payment_delay_days": None,
                "notes": None,
                "invoice_count": stat["invoice_count"],
                "last_received_at": stat["last_received_at"],
                "last_used_at": None,
                "customer_match": _purchase_supplier_customer_match(
                    db,
                    user.tenant_id,
                    name=stat["supplier_name"],
                    siren=stat["supplier_siren"],
                    siret=stat["supplier_siret"],
                    vat_number=None,
                ),
                "source": "history",
            }
        )
    items.sort(key=lambda row: str(row.get("last_used_at") or row.get("last_received_at") or ""), reverse=True)
    return {"items": items[:limit]}


@router.get("/suppliers/duplicates")
def list_purchase_supplier_duplicates(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    rows = (
        db.query(PurchaseSupplier)
        .filter(PurchaseSupplier.tenant_id == user.tenant_id, PurchaseSupplier.is_active.is_(True))
        .order_by(PurchaseSupplier.updated_at.desc())
        .all()
    )
    groups: dict[tuple[str, str], list[PurchaseSupplier]] = {}
    for row in rows:
        values = _purchase_supplier_duplicate_values(row)
        for field, value in values.items():
            if value:
                groups.setdefault((field, value), []).append(row)
    duplicates = []
    for (field, value), items in groups.items():
        if len(items) <= 1:
            continue
        ids = [item.id for item in items]
        duplicates.append(
            {
                "field": field,
                "value": value,
                "ids": ids,
                "keep": ids[0],
                "remove": ids[1:],
                "items": [
                    _purchase_supplier_payload(
                        item,
                        customer_match=_purchase_supplier_customer_match(
                            db,
                            user.tenant_id,
                            name=item.name,
                            siren=item.siren,
                            siret=item.siret,
                            vat_number=item.vat_number,
                        ),
                    )
                    for item in items
                ],
            }
        )
    return {"items": duplicates}


@router.post("/suppliers/duplicates/consolidate")
def consolidate_purchase_supplier_duplicate(
    payload: PurchaseSupplierDuplicateConsolidateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    keep_id = str(payload.keep_id or "").strip()
    remove_ids = sorted({str(value or "").strip() for value in payload.remove_ids if str(value or "").strip()})
    remove_ids = [value for value in remove_ids if value != keep_id]
    if not keep_id or not remove_ids:
        raise HTTPException(400, "Sélection de consolidation invalide.")

    keep = (
        db.query(PurchaseSupplier)
        .filter(
            PurchaseSupplier.tenant_id == user.tenant_id,
            PurchaseSupplier.id == keep_id,
            PurchaseSupplier.is_active.is_(True),
        )
        .first()
    )
    if not keep:
        raise HTTPException(404, "Fournisseur à conserver introuvable.")

    rows = (
        db.query(PurchaseSupplier)
        .filter(
            PurchaseSupplier.tenant_id == user.tenant_id,
            PurchaseSupplier.id.in_(remove_ids),
            PurchaseSupplier.is_active.is_(True),
        )
        .all()
    )
    if len(rows) != len(remove_ids):
        raise HTTPException(404, "Une fiche fournisseur à consolider est introuvable.")

    for row in rows:
        if not _purchase_supplier_shared_duplicate_keys(keep, row):
            raise HTTPException(409, "Ces fiches ne partagent pas de SIREN, SIRET, TVA ou nom identique.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    merged_notes: list[str] = []
    if keep.notes:
        merged_notes.append(keep.notes)
    for row in rows:
        keep.siren = keep.siren or row.siren
        keep.siret = keep.siret or row.siret
        keep.vat_number = keep.vat_number or row.vat_number
        keep.default_accounting_account = keep.default_accounting_account or row.default_accounting_account
        keep.default_purchase_nature = keep.default_purchase_nature or row.default_purchase_nature
        keep.default_payment_delay_days = keep.default_payment_delay_days or row.default_payment_delay_days
        keep.default_vat_rate = keep.default_vat_rate if keep.default_vat_rate is not None else row.default_vat_rate
        keep.vat_rules = _normalize_purchase_supplier_vat_rules([*(keep.vat_rules or []), *(row.vat_rules or [])])
        if row.last_used_at and (not keep.last_used_at or row.last_used_at > keep.last_used_at):
            keep.last_used_at = row.last_used_at
        if row.notes and row.notes not in merged_notes:
            merged_notes.append(row.notes)
        row.is_active = False
        row.updated_at = now
        db.add(row)

    keep.notes = "\n".join(merged_notes)[:1000] if merged_notes else keep.notes
    keep.updated_at = now
    db.add(keep)
    db.commit()
    db.refresh(keep)
    return {
        "ok": True,
        "removed_count": len(rows),
        "item": _purchase_supplier_payload(
            keep,
            customer_match=_purchase_supplier_customer_match(
                db,
                user.tenant_id,
                name=keep.name,
                siren=keep.siren,
                siret=keep.siret,
                vat_number=keep.vat_number,
            ),
        ),
    }


@router.post("/suppliers")
def upsert_purchase_supplier(
    payload: PurchaseSupplierUpsertRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    row = _upsert_purchase_supplier(
        db,
        user.tenant_id,
        name=payload.name,
        supplier_siren=payload.supplier_siren,
        supplier_siret=payload.supplier_siret,
        vat_number=payload.vat_number,
        accounting_account=payload.accounting_account,
        payment_delay_days=payload.payment_delay_days,
        purchase_nature=payload.purchase_nature,
        vat_rate=payload.vat_rate,
        vat_rules=payload.vat_rules,
        replace_vat_rules=payload.vat_rules is not None,
        notes=payload.notes,
    )
    if not row:
        raise HTTPException(400, "Fournisseur invalide.")
    db.commit()
    db.refresh(row)
    return {
        "item": _purchase_supplier_payload(
            row,
            customer_match=_purchase_supplier_customer_match(
                db,
                user.tenant_id,
                name=row.name,
                siren=row.siren,
                siret=row.siret,
                vat_number=row.vat_number,
            ),
        )
    }


@router.patch("/suppliers/{supplier_id}")
def update_purchase_supplier(
    supplier_id: str,
    payload: PurchaseSupplierUpdateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    row = (
        db.query(PurchaseSupplier)
        .filter(
            PurchaseSupplier.tenant_id == user.tenant_id,
            PurchaseSupplier.id == supplier_id,
            PurchaseSupplier.is_active.is_(True),
        )
        .first()
    )
    if not row:
        raise HTTPException(404, "Fournisseur introuvable.")

    fields_set = payload.model_fields_set
    if "name" in fields_set:
        clean_name = _clean_text(payload.name)
        normalized_name = _normalize_reference_name(clean_name)
        if not clean_name or not normalized_name:
            raise HTTPException(400, "Nom du fournisseur obligatoire.")
        duplicate = (
            db.query(PurchaseSupplier.id)
            .filter(
                PurchaseSupplier.tenant_id == user.tenant_id,
                PurchaseSupplier.normalized_name == normalized_name,
                PurchaseSupplier.id != supplier_id,
            )
            .first()
        )
        if duplicate:
            raise HTTPException(409, "Une fiche fournisseur existe déjà avec ce nom.")
        row.name = clean_name
        row.normalized_name = normalized_name
    if "supplier_siren" in fields_set:
        clean_siren = _clean_digits(payload.supplier_siren)
        if clean_siren:
            duplicate = (
                db.query(PurchaseSupplier.id)
                .filter(
                    PurchaseSupplier.tenant_id == user.tenant_id,
                    PurchaseSupplier.siren == clean_siren,
                    PurchaseSupplier.id != supplier_id,
                )
                .first()
            )
            if duplicate:
                raise HTTPException(409, "Une fiche fournisseur existe déjà avec ce SIREN.")
        row.siren = clean_siren
    if "supplier_siret" in fields_set:
        clean_siret = _clean_digits(payload.supplier_siret)
        if clean_siret:
            duplicate = (
                db.query(PurchaseSupplier.id)
                .filter(
                    PurchaseSupplier.tenant_id == user.tenant_id,
                    PurchaseSupplier.siret == clean_siret,
                    PurchaseSupplier.id != supplier_id,
                )
                .first()
            )
            if duplicate:
                raise HTTPException(409, "Une fiche fournisseur existe déjà avec ce SIRET.")
        row.siret = clean_siret
    if "vat_number" in fields_set:
        clean_vat = (_clean_text(payload.vat_number, upper=True) or "").replace(" ", "") or None
        if clean_vat:
            duplicate = (
                db.query(PurchaseSupplier.id)
                .filter(
                    PurchaseSupplier.tenant_id == user.tenant_id,
                    func.upper(func.coalesce(PurchaseSupplier.vat_number, "")) == clean_vat,
                    PurchaseSupplier.id != supplier_id,
                )
                .first()
            )
            if duplicate:
                raise HTTPException(409, "Une fiche fournisseur existe déjà avec cette TVA.")
        row.vat_number = clean_vat
    if "accounting_account" in fields_set:
        row.default_accounting_account = _clean_text(payload.accounting_account)
    if "payment_delay_days" in fields_set:
        row.default_payment_delay_days = (
            None if payload.payment_delay_days is None else max(0, min(int(payload.payment_delay_days), 365))
        )
    if "purchase_nature" in fields_set:
        row.default_purchase_nature = (
            _normalize_purchase_nature(payload.purchase_nature) if payload.purchase_nature else None
        )
    if "vat_rate" in fields_set:
        row.default_vat_rate = _normalize_purchase_vat_rate(payload.vat_rate)
    if "vat_rules" in fields_set:
        row.vat_rules = _normalize_purchase_supplier_vat_rules(payload.vat_rules)
    if "notes" in fields_set:
        row.notes = _clean_text(payload.notes)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row.updated_at = now
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "item": _purchase_supplier_payload(
            row,
            customer_match=_purchase_supplier_customer_match(
                db,
                user.tenant_id,
                name=row.name,
                siren=row.siren,
                siret=row.siret,
                vat_number=row.vat_number,
            ),
        )
    }


@router.delete("/suppliers/{supplier_id}")
def delete_purchase_supplier(
    supplier_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    row = (
        db.query(PurchaseSupplier)
        .filter(
            PurchaseSupplier.tenant_id == user.tenant_id,
            PurchaseSupplier.id == supplier_id,
            PurchaseSupplier.is_active.is_(True),
        )
        .first()
    )
    if not row:
        raise HTTPException(404, "Fournisseur introuvable.")
    row.is_active = False
    row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(row)
    db.commit()
    return {"ok": True}


@router.get("/employee-payers")
def list_purchase_employee_payers(
    q: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=20, ge=1, le=50),
    include_history: bool = Query(True, description="Inclure les personnes trouvées uniquement dans l'historique"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    search = (q or "").strip()
    normalized_search = _normalize_reference_name(search)
    ref_query = db.query(PurchaseEmployeePayer).filter(
        PurchaseEmployeePayer.tenant_id == user.tenant_id,
        PurchaseEmployeePayer.is_active.is_(True),
    )
    if normalized_search:
        ref_query = ref_query.filter(PurchaseEmployeePayer.normalized_name.like(f"%{normalized_search}%"))
    refs = (
        ref_query.order_by(
            PurchaseEmployeePayer.last_used_at.desc().nullslast(), PurchaseEmployeePayer.updated_at.desc()
        )
        .limit(limit)
        .all()
    )

    history: dict[str, dict] = {}
    if include_history:
        history_query = db.query(
            InboundInvoice.employee_payer_name,
            InboundInvoice.employee_payer_role,
            InboundInvoice.employee_reimbursement_method,
            func.max(InboundInvoice.updated_at).label("last_used_at"),
        ).filter(
            InboundInvoice.tenant_id == user.tenant_id,
            InboundInvoice.employee_payer_name.isnot(None),
        )
        if search:
            history_query = history_query.filter(
                func.lower(func.coalesce(InboundInvoice.employee_payer_name, "")).like(f"%{search.lower()}%")
            )
        history_rows = (
            history_query.group_by(
                InboundInvoice.employee_payer_name,
                InboundInvoice.employee_payer_role,
                InboundInvoice.employee_reimbursement_method,
            )
            .order_by(func.max(InboundInvoice.updated_at).desc())
            .limit(limit)
            .all()
        )
        for name, role, method, last_used_at in history_rows:
            key = _normalize_reference_name(name)
            if key:
                history.setdefault(
                    key,
                    {"name": name, "role": role, "reimbursement_method": method, "last_used_at": last_used_at},
                )
    items = []
    for ref in refs:
        history.pop(ref.normalized_name, None)
        items.append(_purchase_employee_payer_payload(ref))
    for row in history.values():
        items.append(
            {
                "id": None,
                "name": row["name"],
                "role": row["role"] or "manager",
                "user_label": None,
                "default_accounting_account": None,
                "reimbursement_method": row["reimbursement_method"],
                "vehicle_type": None,
                "fiscal_power": None,
                "notes": None,
                "last_used_at": row["last_used_at"],
                "source": "history",
            }
        )
    items.sort(key=lambda row: str(row.get("last_used_at") or ""), reverse=True)
    return {"items": items[:limit]}


@router.post("/employee-payers")
def upsert_purchase_employee_payer(
    payload: PurchaseEmployeePayerUpsertRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    row = _upsert_purchase_employee_payer(
        db,
        user.tenant_id,
        name=payload.name,
        role=payload.role,
        user_label=payload.user_label,
        accounting_account=payload.accounting_account,
        reimbursement_method=payload.reimbursement_method,
        vehicle_type=payload.vehicle_type,
        fiscal_power=payload.fiscal_power,
        notes=payload.notes,
    )
    if not row:
        raise HTTPException(400, "Salarié ou dirigeant invalide.")
    db.commit()
    db.refresh(row)
    return {"item": _purchase_employee_payer_payload(row)}


@router.patch("/employee-payers/{payer_id}")
def update_purchase_employee_payer(
    payer_id: str,
    payload: PurchaseEmployeePayerUpdateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    row = (
        db.query(PurchaseEmployeePayer)
        .filter(
            PurchaseEmployeePayer.tenant_id == user.tenant_id,
            PurchaseEmployeePayer.id == payer_id,
            PurchaseEmployeePayer.is_active.is_(True),
        )
        .first()
    )
    if not row:
        raise HTTPException(404, "Personne introuvable.")

    fields_set = payload.model_fields_set
    if "name" in fields_set:
        clean_name = _clean_text(payload.name)
        normalized_name = _normalize_reference_name(clean_name)
        if not clean_name or not normalized_name:
            raise HTTPException(400, "Nom de la personne obligatoire.")
        duplicate = (
            db.query(PurchaseEmployeePayer.id)
            .filter(
                PurchaseEmployeePayer.tenant_id == user.tenant_id,
                PurchaseEmployeePayer.normalized_name == normalized_name,
                PurchaseEmployeePayer.id != payer_id,
            )
            .first()
        )
        if duplicate:
            raise HTTPException(409, "Une personne à rembourser existe déjà avec ce nom.")
        row.name = clean_name
        row.normalized_name = normalized_name
    if "role" in fields_set:
        row.role = _normalize_employee_payer_role(payload.role) or "manager"
    if "user_label" in fields_set:
        row.user_label = _clean_text(payload.user_label)
    if "accounting_account" in fields_set:
        row.default_accounting_account = _clean_text(payload.accounting_account)
    if "reimbursement_method" in fields_set:
        row.reimbursement_method = _normalize_employee_reimbursement_method(payload.reimbursement_method)
    if "vehicle_type" in fields_set:
        row.vehicle_type = _clean_text(payload.vehicle_type)
    if "fiscal_power" in fields_set:
        row.fiscal_power = _clean_text(payload.fiscal_power)
    if "notes" in fields_set:
        row.notes = _clean_text(payload.notes)

    row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"item": _purchase_employee_payer_payload(row)}


@router.delete("/employee-payers/{payer_id}")
def delete_purchase_employee_payer(
    payer_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    row = (
        db.query(PurchaseEmployeePayer)
        .filter(
            PurchaseEmployeePayer.tenant_id == user.tenant_id,
            PurchaseEmployeePayer.id == payer_id,
            PurchaseEmployeePayer.is_active.is_(True),
        )
        .first()
    )
    if not row:
        raise HTTPException(404, "Personne introuvable.")
    row.is_active = False
    row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(row)
    db.commit()
    return {"ok": True}


@router.get("/connection")
def inbox_connection_status(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    seqino_active = seqino_has_active_mandate(user.tenant_id, db=db)
    conns = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == user.tenant_id, PdpConnection.status == "connected")
        .all()
    )
    labels = {provider.slug: provider.label for provider in list_providers()}
    providers: list[dict[str, str]] = []
    seen: set[str] = set()
    for conn in conns:
        slug = (conn.provider_slug or "").strip().lower()
        if not slug or slug in seen:
            continue
        if slug == "seqino" and not seqino_active:
            continue
        seen.add(slug)
        label = labels.get(slug, slug)
        providers.append({"slug": slug, "label": label})
    return {"active": bool(providers), "providers": providers}


@router.post("/vat-corrections/bulk-apply")
def bulk_apply_purchase_vat_corrections(
    payload: PurchaseVatBulkCorrectionRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    invoice_ids = list(
        dict.fromkeys(str(item or "").strip() for item in payload.invoice_ids if str(item or "").strip())
    )
    if not invoice_ids:
        raise HTTPException(400, "Aucun achat sélectionné.")

    rows = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.tenant_id == user.tenant_id, InboundInvoice.id.in_(invoice_ids))
        .all()
    )
    rows_by_id = {row.id: row for row in rows}
    explicit_rate = _normalize_purchase_vat_rate(payload.vat_rate)
    if explicit_rate is None and not payload.use_supplier_rules:
        explicit_rate = None
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    updated: list[dict[str, object]] = []
    skipped: list[dict[str, str]] = []

    for invoice_id in invoice_ids:
        inv = rows_by_id.get(invoice_id)
        if not inv:
            skipped.append({"id": invoice_id, "reason": "introuvable"})
            continue
        try:
            _ensure_purchase_accounting_period_unlocked(db, inv)
        except HTTPException:
            skipped.append({"id": invoice_id, "reason": "période remise au cabinet"})
            continue
        if (inv.currency or "EUR").upper() != "EUR":
            skipped.append({"id": invoice_id, "reason": "devise non EUR"})
            continue
        supplier_ref: PurchaseSupplier | None = None
        if payload.use_supplier_rules:
            supplier_ref = _purchase_supplier_reference_for_invoice(db, user.tenant_id, inv)
        if inv.purchase_lines:
            if not payload.apply_to_purchase_lines:
                skipped.append({"id": invoice_id, "reason": "ventilation détaillée existante"})
                continue
            changed, line_reason, _lines, rate, rate_source, matched_rule = _apply_purchase_vat_rate_to_lines(
                inv=inv,
                supplier_ref=supplier_ref,
                explicit_rate=explicit_rate,
                use_supplier_rules=payload.use_supplier_rules,
            )
            if not changed:
                skipped.append({"id": invoice_id, "reason": line_reason or "lignes non éligibles"})
                continue
            if _purchase_zero_vat_missing_reason(inv):
                skipped.append({"id": invoice_id, "reason": "motif TVA 0 manquant"})
                db.expire(inv)
                continue
            if not _purchase_completion_missing_fields(inv):
                inv.completion_status = "completed"
            inv.duplicate_of_id = _find_purchase_duplicate(db, inv)
            inv.updated_at = now
            db.add(inv)
            db.flush()
            db.add(
                InboundInvoiceEvent(
                    inbound_invoice_id=inv.id,
                    type="purchase_vat_correction_saved",
                    payload_hash=hashlib.sha256(
                        f"{inv.id}:bulk-vat-lines:{rate}:{inv.total_ex_vat}:{inv.total_vat}:{now.isoformat()}".encode(
                            "utf-8"
                        )
                    ).hexdigest(),
                    created_at=now,
                )
            )
            updated.append(
                {
                    "id": inv.id,
                    "invoice_number": inv.invoice_number,
                    "total_ex_vat": float(_round_amount(Decimal(str(inv.total_ex_vat or 0)))),
                    "total_vat": float(_round_amount(Decimal(str(inv.total_vat or 0)))),
                    "total_ttc": float(_round_amount(Decimal(str(inv.total_ttc or 0)))),
                    "vat_rate": float(rate) if rate is not None else None,
                    "vat_rate_source": rate_source or ("supplier_rule" if payload.use_supplier_rules else "manual"),
                    "supplier_vat_rule": matched_rule,
                    "purchase_lines_updated": True,
                }
            )
            continue
        total_ttc = _round_amount(Decimal(str(inv.total_ttc or 0)))
        if total_ttc <= 0:
            skipped.append({"id": invoice_id, "reason": "TTC manquant"})
            continue
        if _round_amount(Decimal(str(inv.total_vat or 0))) > 0:
            skipped.append({"id": invoice_id, "reason": "TVA déjà renseignée"})
            continue

        rate_source = "manual"
        rate = explicit_rate
        matched_rule = None
        if payload.use_supplier_rules:
            if supplier_ref:
                rate, rate_source, matched_rule = _purchase_supplier_vat_rate_for_invoice(supplier_ref, inv)
            else:
                rate = None
                rate_source = "supplier_rule"
            if rate is None:
                skipped.append({"id": invoice_id, "reason": "règle TVA fournisseur absente"})
                continue
        if rate is None:
            skipped.append({"id": invoice_id, "reason": "taux TVA manquant"})
            continue
        if rate == 0:
            skipped.append({"id": invoice_id, "reason": "motif TVA 0 manquant"})
            continue

        divisor = Decimal("1") + (rate / Decimal("100"))
        total_ex_vat = total_ttc if rate == 0 else _round_amount(total_ttc / divisor)
        total_vat = _round_amount(total_ttc - total_ex_vat)
        inv.total_ex_vat = total_ex_vat
        inv.total_vat = total_vat
        if not _purchase_completion_missing_fields(inv) and not _purchase_zero_vat_missing_reason(inv):
            inv.completion_status = "completed"
        inv.duplicate_of_id = _find_purchase_duplicate(db, inv)
        inv.updated_at = now
        db.add(inv)
        db.flush()
        db.add(
            InboundInvoiceEvent(
                inbound_invoice_id=inv.id,
                type="purchase_vat_correction_saved",
                payload_hash=hashlib.sha256(
                    f"{inv.id}:bulk-vat:{rate}:{total_ex_vat}:{total_vat}:{now.isoformat()}".encode("utf-8")
                ).hexdigest(),
                created_at=now,
            )
        )
        _upsert_purchase_supplier(
            db,
            user.tenant_id,
            name=inv.supplier_name,
            supplier_siren=inv.supplier_siren,
            supplier_siret=inv.supplier_siret,
            accounting_account=inv.accounting_account,
            payment_delay_days=_purchase_payment_delay_days(inv.issue_date, inv.planned_payment_date),
            purchase_nature=inv.purchase_nature,
            vat_rate=rate if rate_source == "supplier_rule" else None,
        )
        updated.append(
            {
                "id": inv.id,
                "invoice_number": inv.invoice_number,
                "total_ex_vat": float(total_ex_vat),
                "total_vat": float(total_vat),
                "total_ttc": float(total_ttc),
                "vat_rate": float(rate),
                "vat_rate_source": rate_source,
                "supplier_vat_rule": matched_rule,
            }
        )

    db.commit()
    return {
        "ok": True,
        "updated_count": len(updated),
        "skipped_count": len(skipped),
        "updated": updated,
        "skipped": skipped,
    }


@router.post("/vat-corrections/bulk-validate")
def bulk_validate_purchase_vat_corrections(
    payload: PurchaseVatBulkValidationRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    invoice_ids = list(
        dict.fromkeys(str(item or "").strip() for item in payload.invoice_ids if str(item or "").strip())
    )
    if not invoice_ids:
        raise HTTPException(400, "Aucun achat sélectionné.")

    rows = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.tenant_id == user.tenant_id, InboundInvoice.id.in_(invoice_ids))
        .all()
    )
    rows_by_id = {row.id: row for row in rows}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    comment = _clean_text(payload.cabinet_comment)
    validated: list[dict[str, object]] = []
    skipped: list[dict[str, str]] = []

    for invoice_id in invoice_ids:
        inv = rows_by_id.get(invoice_id)
        if not inv:
            skipped.append({"id": invoice_id, "reason": "introuvable"})
            continue
        try:
            _ensure_purchase_accounting_period_unlocked(db, inv)
        except HTTPException:
            skipped.append({"id": invoice_id, "reason": "période remise au cabinet"})
            continue
        status = str(inv.status or "").lower()
        validation_status = str(inv.validation_status or "").lower()
        if status in {"rejected", "duplicate", "canceled"}:
            skipped.append({"id": invoice_id, "reason": "statut achat non validable"})
            continue
        if validation_status in {"invalid", "failed", "unavailable"}:
            skipped.append({"id": invoice_id, "reason": "validation fournisseur à revoir"})
            continue
        if (inv.currency or "EUR").upper() != "EUR":
            skipped.append({"id": invoice_id, "reason": "devise non EUR"})
            continue
        missing = _purchase_completion_missing_fields(inv)
        if missing:
            skipped.append({"id": invoice_id, "reason": f"champs manquants: {', '.join(missing)}"})
            continue
        if _purchase_amounts_inconsistent(inv):
            skipped.append({"id": invoice_id, "reason": "totaux incohérents"})
            continue
        if _purchase_zero_vat_missing_reason(inv):
            skipped.append({"id": invoice_id, "reason": "motif TVA 0 manquant"})
            continue

        inv.completion_status = "completed"
        inv.completion_validated_at = now
        inv.updated_at = now
        if comment:
            existing_note = _clean_text(inv.accountant_note) or ""
            marker = f"Revue TVA cabinet: {comment}"
            if marker not in existing_note:
                inv.accountant_note = f"{existing_note}\n{marker}".strip()[:1000] if existing_note else marker[:1000]
        db.add(inv)
        db.flush()
        db.add(
            InboundInvoiceEvent(
                inbound_invoice_id=inv.id,
                type="purchase_vat_correction_validated",
                payload_hash=hashlib.sha256(
                    f"{inv.id}:bulk-vat-validate:{inv.total_ttc}:{inv.total_vat}:{comment or ''}:{now.isoformat()}".encode(
                        "utf-8"
                    )
                ).hexdigest(),
                created_at=now,
            )
        )
        validated.append(
            {
                "id": inv.id,
                "invoice_number": inv.invoice_number,
                "total_vat": float(_round_amount(Decimal(str(inv.total_vat or 0)))),
                "validated_at": now.isoformat(),
            }
        )

    db.commit()
    return {
        "ok": True,
        "validated_count": len(validated),
        "skipped_count": len(skipped),
        "validated": validated,
        "skipped": skipped,
    }


@router.patch("/{invoice_id}/completion", response_model=InboundInvoiceOut)
def update_purchase_completion(
    invoice_id: str,
    payload: PurchaseCompletionRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = db.get(InboundInvoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)

    fields_set = payload.model_fields_set
    if "supplier_name" in fields_set:
        inv.supplier_name = _clean_text(payload.supplier_name)
    if "supplier_siren" in fields_set:
        inv.supplier_siren = _clean_text(payload.supplier_siren, upper=True)
    if "supplier_siret" in fields_set:
        inv.supplier_siret = _clean_text(payload.supplier_siret, upper=True)
    if "invoice_number" in fields_set:
        inv.invoice_number = _clean_text(payload.invoice_number, upper=True)
    if "issue_date" in fields_set:
        inv.issue_date = payload.issue_date
    if "total_ttc" in fields_set:
        inv.total_ttc = payload.total_ttc
    if "total_vat" in fields_set:
        inv.total_vat = payload.total_vat
    if "total_ex_vat" in fields_set:
        inv.total_ex_vat = payload.total_ex_vat
    elif (
        "total_ttc" in fields_set
        and "total_vat" in fields_set
        and payload.total_ttc is not None
        and payload.total_vat is not None
    ):
        inv.total_ex_vat = max(payload.total_ttc - payload.total_vat, Decimal("0"))
    if "purchase_lines" in fields_set:
        purchase_lines, lines_total_ht, lines_total_vat, lines_total_ttc = _normalize_purchase_lines(
            payload.purchase_lines
        )
        inv.purchase_lines = purchase_lines
        if purchase_lines:
            inv.total_ex_vat = lines_total_ht
            inv.total_vat = lines_total_vat
            inv.total_ttc = lines_total_ttc
    if "currency" in fields_set:
        inv.currency = _clean_text(payload.currency, upper=True) or "EUR"
    if "purchase_nature" in fields_set:
        inv.purchase_nature = _normalize_purchase_nature(payload.purchase_nature)
    if "accounting_account" in fields_set:
        inv.accounting_account = _clean_text(payload.accounting_account)
    if "accountant_note" in fields_set:
        inv.accountant_note = _clean_text(payload.accountant_note)
    if "planned_payment_date" in fields_set:
        inv.planned_payment_date = payload.planned_payment_date
    if "paid_by_employee" in fields_set:
        inv.paid_by_employee = bool(payload.paid_by_employee)
        if not inv.paid_by_employee:
            inv.employee_payer_name = None
            inv.employee_payer_role = None
            inv.employee_reimbursement_amount = None
            inv.employee_reimbursement_due_date = None
            inv.employee_reimbursement_method = None
            inv.employee_reimbursement_status = None
    if "employee_payer_name" in fields_set:
        inv.employee_payer_name = _clean_text(payload.employee_payer_name)
    if "employee_payer_role" in fields_set:
        inv.employee_payer_role = _normalize_employee_payer_role(payload.employee_payer_role)
    if "employee_reimbursement_amount" in fields_set:
        inv.employee_reimbursement_amount = payload.employee_reimbursement_amount
    if "employee_reimbursement_due_date" in fields_set:
        inv.employee_reimbursement_due_date = payload.employee_reimbursement_due_date
    if "employee_reimbursement_method" in fields_set:
        inv.employee_reimbursement_method = _normalize_employee_reimbursement_method(
            payload.employee_reimbursement_method
        )
    if "employee_reimbursement_status" in fields_set:
        inv.employee_reimbursement_status = _normalize_employee_reimbursement_status(
            payload.employee_reimbursement_status
        )
    if inv.paid_by_employee:
        if inv.employee_reimbursement_amount is None and inv.total_ttc is not None:
            inv.employee_reimbursement_amount = inv.total_ttc
        if not inv.employee_reimbursement_status:
            inv.employee_reimbursement_status = "to_reimburse"
    if "purchase_tags" in fields_set:
        inv.purchase_tags = _normalize_purchase_tags(payload.purchase_tags)

    _ensure_purchase_accounting_period_unlocked(db, inv)
    _ensure_purchase_total_covers_payments(db, inv)
    skip_auto_fields = {
        field
        for field in ("planned_payment_date",)
        if field in fields_set and getattr(payload, field, None) in {None, ""}
    }
    apply_purchase_accounting_patch(db, user.tenant_id, inv, user_id=user.id, skip_fields=skip_auto_fields)

    _upsert_purchase_supplier(
        db,
        user.tenant_id,
        name=inv.supplier_name,
        supplier_siren=inv.supplier_siren,
        supplier_siret=inv.supplier_siret,
        accounting_account=inv.accounting_account,
        payment_delay_days=_purchase_payment_delay_days(inv.issue_date, inv.planned_payment_date),
        purchase_nature=inv.purchase_nature,
        vat_rate=_purchase_default_vat_rate_from_invoice(inv),
    )
    if inv.paid_by_employee:
        _upsert_purchase_employee_payer(
            db,
            user.tenant_id,
            name=inv.employee_payer_name,
            role=inv.employee_payer_role,
            accounting_account=inv.accounting_account,
            reimbursement_method=inv.employee_reimbursement_method,
        )

    inv.duplicate_of_id = _find_purchase_duplicate(db, inv)
    missing = _purchase_completion_missing_fields(inv, require_accounting_account=bool(payload.validate_))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    vat_correction_fields = {
        "total_ttc",
        "total_vat",
        "total_ex_vat",
        "purchase_lines",
        "purchase_nature",
        "accounting_account",
    }
    has_vat_correction = bool(fields_set & vat_correction_fields)
    amounts_inconsistent = _purchase_amounts_inconsistent(inv)
    if payload.validate_:
        if missing:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "purchase_completion_missing_fields",
                    "message": "Complète les champs obligatoires avant de valider l'achat.",
                    "fields": missing,
                },
            )
        if amounts_inconsistent:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "purchase_amounts_inconsistent",
                    "message": "Corrige les totaux : HT + TVA doit correspondre au TTC.",
                    "fields": ["totaux"],
                },
            )
        if _purchase_zero_vat_missing_reason(inv):
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "purchase_vat_zero_reason_missing",
                    "message": "Renseigne le motif de TVA 0 avant de valider l'achat.",
                    "fields": ["motif TVA 0"],
                },
            )
        inv.completion_status = "completed"
        inv.completion_validated_at = now
    else:
        inv.completion_status = (
            "completed"
            if not missing and not amounts_inconsistent and not _purchase_zero_vat_missing_reason(inv)
            else "draft"
        )
    if inv.completion_status != "completed" or amounts_inconsistent:
        _clear_purchase_workflow_state(db, user.tenant_id, inv.id)
    inv.updated_at = now

    event_type = "purchase_completion_validated" if payload.validate_ else "purchase_completion_saved"
    if has_vat_correction:
        event_type = "purchase_vat_correction_validated" if payload.validate_ else "purchase_vat_correction_saved"
    db.add(inv)
    db.flush()
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type=event_type,
            payload_hash=hashlib.sha256(
                f"{inv.id}:{inv.invoice_number}:{inv.total_ttc}:{inv.completion_status}:{now.isoformat()}".encode(
                    "utf-8"
                )
            ).hexdigest(),
            created_at=now,
        )
    )
    db.commit()
    db.refresh(inv)
    inv.attachments = (
        db.query(InboundInvoiceAttachment)
        .filter(InboundInvoiceAttachment.inbound_invoice_id == inv.id)
        .order_by(InboundInvoiceAttachment.created_at.asc())
        .all()
    )
    inv.events = (
        db.query(InboundInvoiceEvent)
        .filter(InboundInvoiceEvent.inbound_invoice_id == inv.id)
        .order_by(InboundInvoiceEvent.created_at.desc())
        .all()
    )
    paid_total = _purchase_payment_total(db, inv)
    setattr(inv, "purchase_paid_total", float(paid_total))
    setattr(inv, "purchase_remaining_ttc", float(_purchase_payment_remaining(db, inv)))
    setattr(inv, "accounting_readiness", purchase_accounting_readiness(inv))
    setattr(
        inv,
        "purchase_workflow",
        _purchase_workflow_payload_for_row(inv, _read_purchase_workflow_states(db, user.tenant_id)),
    )
    return inv


@router.post("/{invoice_id}/accounting/auto-classify")
def auto_classify_purchase_accounting(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.id == invoice_id, InboundInvoice.tenant_id == user.tenant_id)
        .with_for_update()
        .first()
    )
    if not inv:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)
    result = apply_purchase_accounting_patch(db, user.tenant_id, inv, user_id=user.id)
    changes = result.get("changes") if isinstance(result, dict) else []
    message = result.get("message") if isinstance(result, dict) else None
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if changes:
        inv.updated_at = now
        _upsert_purchase_supplier(
            db,
            user.tenant_id,
            name=inv.supplier_name,
            supplier_siren=inv.supplier_siren,
            supplier_siret=inv.supplier_siret,
            accounting_account=inv.accounting_account,
            payment_delay_days=_purchase_payment_delay_days(inv.issue_date, inv.planned_payment_date),
            purchase_nature=inv.purchase_nature,
            vat_rate=_purchase_default_vat_rate_from_invoice(inv),
        )
        db.add(inv)
        db.flush()
        db.add(
            InboundInvoiceEvent(
                inbound_invoice_id=inv.id,
                type="purchase_accounting_auto_classified",
                payload_hash=hashlib.sha256(f"{inv.id}:{len(changes)}:{now.isoformat()}".encode("utf-8")).hexdigest(),
                created_at=now,
            )
        )
        db.commit()
        db.refresh(inv)
    else:
        db.rollback()
    inv.attachments = (
        db.query(InboundInvoiceAttachment)
        .filter(InboundInvoiceAttachment.inbound_invoice_id == inv.id)
        .order_by(InboundInvoiceAttachment.created_at.asc())
        .all()
    )
    inv.events = (
        db.query(InboundInvoiceEvent)
        .filter(InboundInvoiceEvent.inbound_invoice_id == inv.id)
        .order_by(InboundInvoiceEvent.created_at.desc())
        .all()
    )
    paid_total = _purchase_payment_total(db, inv)
    setattr(inv, "purchase_paid_total", float(paid_total))
    setattr(inv, "purchase_remaining_ttc", float(_purchase_payment_remaining(db, inv)))
    setattr(inv, "accounting_readiness", purchase_accounting_readiness(inv))
    return {
        "purchase": InboundInvoiceOut.model_validate(inv).model_dump(mode="json"),
        "changes": changes or [],
        "message": message
        or ("Achat catégorisé automatiquement." if changes else "Aucune catégorie sûre à appliquer."),
    }


@router.get("/{invoice_id}/payments", response_model=list[PurchasePaymentOut])
def list_purchase_payments(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    inv = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.id == invoice_id, InboundInvoice.tenant_id == user.tenant_id)
        .with_for_update()
        .first()
    )
    if not inv:
        raise HTTPException(404, "Not found")
    return (
        db.query(PurchasePayment)
        .filter(PurchasePayment.tenant_id == user.tenant_id, PurchasePayment.inbound_invoice_id == inv.id)
        .order_by(PurchasePayment.date.desc(), PurchasePayment.created_at.desc())
        .all()
    )


@router.post("/{invoice_id}/payments", response_model=PurchasePaymentOut)
async def create_purchase_payment(
    invoice_id: str,
    payload: PurchasePaymentRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.id == invoice_id, InboundInvoice.tenant_id == user.tenant_id)
        .with_for_update()
        .first()
    )
    if not inv:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)
    _ensure_purchase_completed_for_payment(inv)
    _ensure_purchase_amounts_coherent_for_payment(inv)
    payment_data = _normalize_purchase_payment_payload(payload)
    _ensure_purchase_period_date_unlocked(
        db,
        tenant_id=user.tenant_id,
        period_date=payment_data["date"],
        message="Ce règlement fournisseur appartient à une période déjà remise au cabinet.",
    )
    remaining = _purchase_payment_remaining(db, inv)
    if payment_data["amount"] > remaining:
        raise HTTPException(400, f"Le règlement dépasse le solde fournisseur restant ({remaining}).")
    _ensure_purchase_payment_reference_available(
        db,
        tenant_id=user.tenant_id,
        invoice_id=inv.id,
        reference=payment_data.get("reference"),
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = PurchasePayment(
        tenant_id=user.tenant_id,
        inbound_invoice_id=inv.id,
        created_by=user.id,
        created_at=now,
        updated_at=now,
        **payment_data,
    )
    db.add(row)
    db.flush()
    paid_total = _purchase_payment_total(db, inv)
    total_ttc = Decimal(str(inv.total_ttc or 0)).quantize(Decimal("0.01"))
    if total_ttc > 0 and paid_total > total_ttc:
        db.rollback()
        raise HTTPException(409, f"Le règlement dépasse le solde fournisseur restant ({remaining}).")
    next_remaining = _purchase_payment_remaining(db, inv)
    if next_remaining <= Decimal("0.00"):
        _write_purchase_workflow_state(
            db,
            tenant_id=user.tenant_id,
            invoice_id=inv.id,
            state="booked",
            note=payment_data.get("reference") or "Règlement fournisseur enregistré.",
        )
    else:
        _write_purchase_workflow_state(
            db,
            tenant_id=user.tenant_id,
            invoice_id=inv.id,
            state="ready_to_pay",
            note=f"Règlement partiel enregistré. Reste {next_remaining}.",
        )
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type="purchase_payment_created",
            payload_hash=hashlib.sha256(
                f"{inv.id}:{row.id}:{row.amount}:{now.isoformat()}".encode("utf-8")
            ).hexdigest(),
            created_at=now,
        )
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "purchase_payment_duplicate_reference",
                "message": "Ce règlement fournisseur existe déjà pour cet achat.",
            },
        ) from exc
    db.refresh(row)
    if next_remaining <= Decimal("0.00"):
        await _sync_seqino_paid_action(db, inv=inv, payment_id=row.id)
    return row


@router.patch("/{invoice_id}/payments/{payment_id}", response_model=PurchasePaymentOut)
async def update_purchase_payment(
    invoice_id: str,
    payment_id: str,
    payload: PurchasePaymentRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.id == invoice_id, InboundInvoice.tenant_id == user.tenant_id)
        .with_for_update()
        .first()
    )
    if not inv:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)
    row = (
        db.query(PurchasePayment)
        .filter(
            PurchasePayment.id == payment_id,
            PurchasePayment.tenant_id == user.tenant_id,
            PurchasePayment.inbound_invoice_id == inv.id,
        )
        .with_for_update()
        .first()
    )
    if not row:
        raise HTTPException(404, "Règlement fournisseur introuvable.")
    _ensure_seqino_paid_action_mutable(db, inv)
    _ensure_purchase_completed_for_payment(inv)
    _ensure_purchase_amounts_coherent_for_payment(inv)
    payment_data = _normalize_purchase_payment_payload(payload)
    _ensure_purchase_period_date_unlocked(
        db,
        tenant_id=user.tenant_id,
        period_date=row.date,
        message="Ce règlement fournisseur appartient à une période déjà remise au cabinet.",
    )
    _ensure_purchase_period_date_unlocked(
        db,
        tenant_id=user.tenant_id,
        period_date=payment_data["date"],
        message="Ce règlement fournisseur appartient à une période déjà remise au cabinet.",
    )
    remaining = _purchase_payment_remaining(db, inv, exclude_payment_id=row.id)
    if payment_data["amount"] > remaining:
        raise HTTPException(400, f"Le règlement dépasse le solde fournisseur restant ({remaining}).")
    _ensure_purchase_payment_reference_available(
        db,
        tenant_id=user.tenant_id,
        invoice_id=inv.id,
        reference=payment_data.get("reference"),
        exclude_payment_id=row.id,
    )
    for key, value in payment_data.items():
        setattr(row, key, value)
    row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(row)
    db.flush()
    paid_total = _purchase_payment_total(db, inv)
    total_ttc = Decimal(str(inv.total_ttc or 0)).quantize(Decimal("0.01"))
    if total_ttc > 0 and paid_total > total_ttc:
        db.rollback()
        raise HTTPException(409, f"Le règlement dépasse le solde fournisseur restant ({remaining}).")
    next_remaining = _purchase_payment_remaining(db, inv)
    if next_remaining <= Decimal("0.00"):
        _write_purchase_workflow_state(
            db,
            tenant_id=user.tenant_id,
            invoice_id=inv.id,
            state="booked",
            note=row.reference or "Règlement fournisseur enregistré.",
        )
    else:
        _write_purchase_workflow_state(
            db,
            tenant_id=user.tenant_id,
            invoice_id=inv.id,
            state="ready_to_pay",
            note=f"Règlement partiel enregistré. Reste {next_remaining}.",
        )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "purchase_payment_duplicate_reference",
                "message": "Ce règlement fournisseur existe déjà pour cet achat.",
            },
        ) from exc
    db.refresh(row)
    if next_remaining <= Decimal("0.00"):
        await _sync_seqino_paid_action(db, inv=inv, payment_id=row.id)
    return row


@router.delete("/{invoice_id}/payments/{payment_id}")
def delete_purchase_payment(
    invoice_id: str,
    payment_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = db.get(InboundInvoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)
    row = (
        db.query(PurchasePayment)
        .filter(
            PurchasePayment.id == payment_id,
            PurchasePayment.tenant_id == user.tenant_id,
            PurchasePayment.inbound_invoice_id == inv.id,
        )
        .first()
    )
    if not row:
        raise HTTPException(404, "Règlement fournisseur introuvable.")
    _ensure_seqino_paid_action_mutable(db, inv)
    _ensure_purchase_period_date_unlocked(
        db,
        tenant_id=user.tenant_id,
        period_date=row.date,
        message="Ce règlement fournisseur appartient à une période déjà remise au cabinet.",
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type="purchase_payment_deleted",
            payload_hash=hashlib.sha256(
                f"{inv.id}:{row.id}:{row.amount}:{now.isoformat()}".encode("utf-8")
            ).hexdigest(),
            created_at=now,
        )
    )
    db.delete(row)
    db.flush()
    _write_purchase_workflow_state(
        db,
        tenant_id=user.tenant_id,
        invoice_id=inv.id,
        state="ready_to_pay",
        note="Règlement fournisseur supprimé.",
    )
    db.commit()
    return {"ok": True}


@router.get("/{invoice_id}", response_model=InboundInvoiceOut)
def get_inbound_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    inv = db.get(InboundInvoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    inv.attachments = (
        db.query(InboundInvoiceAttachment)
        .filter(InboundInvoiceAttachment.inbound_invoice_id == inv.id)
        .order_by(InboundInvoiceAttachment.created_at.asc())
        .all()
    )
    inv.events = (
        db.query(InboundInvoiceEvent)
        .filter(InboundInvoiceEvent.inbound_invoice_id == inv.id)
        .order_by(InboundInvoiceEvent.created_at.desc())
        .all()
    )
    paid_total = _purchase_payment_total(db, inv)
    setattr(inv, "purchase_paid_total", float(paid_total))
    setattr(inv, "purchase_remaining_ttc", float(_purchase_payment_remaining(db, inv)))
    setattr(inv, "accounting_readiness", purchase_accounting_readiness(inv))
    setattr(
        inv,
        "purchase_workflow",
        _purchase_workflow_payload_for_row(inv, _read_purchase_workflow_states(db, user.tenant_id)),
    )
    return inv


@router.post("/{invoice_id}/attachments", response_model=InboundInvoiceAttachmentOut)
async def upload_inbound_attachment(
    invoice_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.id == invoice_id, InboundInvoice.tenant_id == user.tenant_id)
        .with_for_update()
        .first()
    )
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)
    tenant = db.query(Tenant).filter(Tenant.id == user.tenant_id).with_for_update().first()

    limits = resolve_limits_for_tenant(tenant)
    max_file_bytes = _MAX_PURCHASE_ATTACHMENT_BYTES
    if limits.max_file_bytes:
        max_file_bytes = min(max_file_bytes, limits.max_file_bytes)
    max_count = (
        limits.max_per_document if limits.max_per_document is not None else _MAX_PURCHASE_ATTACHMENTS_PER_INVOICE
    )
    attachment_count = (
        db.query(func.count(InboundInvoiceAttachment.id))
        .filter(InboundInvoiceAttachment.inbound_invoice_id == inv.id)
        .scalar()
    )
    if max_count and int(attachment_count or 0) >= max_count:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "purchase_attachment_limit_reached",
                "message": f"Limite atteinte : {max_count} justificatifs par achat.",
            },
        )

    raw = await file.read(max_file_bytes + 1)
    if not raw:
        raise HTTPException(400, "Fichier vide.")
    if len(raw) > max_file_bytes:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "purchase_attachment_too_large",
                "message": f"Fichier trop volumineux (max {max_file_bytes // (1024 * 1024)}MB).",
            },
        )
    if limits.quota_bytes:
        unknown_size_count = get_purchase_attachment_unknown_size_count(db, user.tenant_id)
        if unknown_size_count:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "purchase_attachment_size_backfill_required",
                    "message": "Stockage pièces jointes à recalculer avant nouvel upload achat.",
                    "unknown_size_count": unknown_size_count,
                },
            )
        used_bytes = get_used_bytes(db, user.tenant_id)
        if used_bytes + len(raw) > limits.quota_bytes:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "purchase_attachment_quota_exceeded",
                    "message": "Quota de stockage des justificatifs atteint.",
                    "quota_bytes": limits.quota_bytes,
                    "used_bytes": used_bytes,
                },
            )
    kind, content_type = _detect_purchase_attachment(raw, file.filename, file.content_type)
    attachment_id = uuid.uuid4().hex
    storage_key = f"inbox/{inv.id}/attachments/{attachment_id}.{kind}"
    put_object(storage_key, raw, content_type=content_type)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = InboundInvoiceAttachment(
        id=attachment_id,
        inbound_invoice_id=inv.id,
        kind=kind,
        storage_key=storage_key,
        sha256=hashlib.sha256(raw).hexdigest(),
        size_bytes=len(raw),
        created_at=now,
    )
    db.add(row)
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type="purchase_attachment_uploaded",
            payload_hash=hashlib.sha256(f"{inv.id}:{attachment_id}:{row.sha256}".encode("utf-8")).hexdigest(),
            created_at=now,
        )
    )
    inv.updated_at = now
    db.add(inv)
    try:
        db.commit()
    except Exception:
        db.rollback()
        delete_object(storage_key)
        raise
    db.refresh(row)
    return row


@router.put("/{invoice_id}/attachments/{attachment_id}", response_model=InboundInvoiceAttachmentOut)
async def replace_inbound_attachment(
    invoice_id: str,
    attachment_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.id == invoice_id, InboundInvoice.tenant_id == user.tenant_id)
        .with_for_update()
        .first()
    )
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)
    att = (
        db.query(InboundInvoiceAttachment)
        .filter(InboundInvoiceAttachment.id == attachment_id, InboundInvoiceAttachment.inbound_invoice_id == inv.id)
        .with_for_update()
        .first()
    )
    if not att:
        raise HTTPException(404, "Not found")

    tenant = db.query(Tenant).filter(Tenant.id == user.tenant_id).with_for_update().first()
    limits = resolve_limits_for_tenant(tenant)
    max_file_bytes = _MAX_PURCHASE_ATTACHMENT_BYTES
    if limits.max_file_bytes:
        max_file_bytes = min(max_file_bytes, limits.max_file_bytes)

    raw = await file.read(max_file_bytes + 1)
    if not raw:
        raise HTTPException(400, "Fichier vide.")
    if len(raw) > max_file_bytes:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "purchase_attachment_too_large",
                "message": f"Fichier trop volumineux (max {max_file_bytes // (1024 * 1024)}MB).",
            },
        )
    if limits.quota_bytes:
        unknown_size_count = get_purchase_attachment_unknown_size_count(db, user.tenant_id)
        current_unknown = 1 if getattr(att, "size_bytes", None) is None else 0
        if unknown_size_count and unknown_size_count > current_unknown:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "purchase_attachment_size_backfill_required",
                    "message": "Stockage pièces jointes à recalculer avant remplacement achat.",
                    "unknown_size_count": unknown_size_count,
                },
            )
        used_bytes = get_used_bytes(db, user.tenant_id)
        previous_size = int(att.size_bytes or 0)
        if max(0, used_bytes - previous_size) + len(raw) > limits.quota_bytes:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "purchase_attachment_quota_exceeded",
                    "message": "Quota de stockage des justificatifs atteint.",
                    "quota_bytes": limits.quota_bytes,
                    "used_bytes": used_bytes,
                },
            )

    kind, content_type = _detect_purchase_attachment(raw, file.filename, file.content_type)
    previous_storage_key = att.storage_key
    storage_key = f"inbox/{inv.id}/attachments/{attachment_id}-{uuid.uuid4().hex}.{kind}"
    put_object(storage_key, raw, content_type=content_type)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    att.kind = kind
    att.storage_key = storage_key
    att.sha256 = hashlib.sha256(raw).hexdigest()
    att.size_bytes = len(raw)
    att.created_at = now
    db.add(att)
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type="purchase_attachment_replaced",
            payload_hash=hashlib.sha256(f"{inv.id}:{attachment_id}:{att.sha256}".encode("utf-8")).hexdigest(),
            created_at=now,
        )
    )
    inv.updated_at = now
    db.add(inv)
    try:
        db.commit()
    except Exception:
        db.rollback()
        delete_object(storage_key)
        raise

    if previous_storage_key and previous_storage_key != storage_key:
        try:
            delete_object(previous_storage_key)
        except Exception:
            logger.warning(
                "purchase_attachment_replace_old_object_delete_failed",
                extra={
                    "tenant_id": user.tenant_id,
                    "inbound_invoice_id": invoice_id,
                    "storage_key": previous_storage_key,
                },
                exc_info=True,
            )

    db.refresh(att)
    return att


@router.get("/{invoice_id}/attachments/{attachment_id}")
def download_inbound_attachment(
    invoice_id: str,
    attachment_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    inv = db.get(InboundInvoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    att = db.get(InboundInvoiceAttachment, attachment_id)
    if not att or att.inbound_invoice_id != inv.id:
        raise HTTPException(404, "Not found")
    kind = (att.kind or "").lower()
    content_type = _purchase_attachment_content_type(kind)
    raw_name = inv.invoice_number or inv.id
    safe_name = "".join(ch for ch in str(raw_name) if ch.isalnum() or ch in {"-", "_"})
    filename = f"{safe_name or inv.id}.{kind or 'bin'}"
    return _stream_attachment(request, att.storage_key, content_type, filename)


@router.delete("/{invoice_id}/attachments/{attachment_id}")
def delete_inbound_attachment(
    invoice_id: str,
    attachment_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = db.get(InboundInvoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)
    att = db.get(InboundInvoiceAttachment, attachment_id)
    if not att or att.inbound_invoice_id != inv.id:
        raise HTTPException(404, "Not found")

    storage_key = att.storage_key
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.delete(att)
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type="purchase_attachment_deleted",
            payload_hash=hashlib.sha256(f"{inv.id}:{attachment_id}:deleted".encode("utf-8")).hexdigest(),
            created_at=now,
        )
    )
    inv.updated_at = now
    db.add(inv)
    db.commit()

    if storage_key:
        try:
            delete_object(storage_key)
        except Exception:
            logger.warning(
                "purchase_attachment_delete_object_failed",
                extra={"tenant_id": user.tenant_id, "inbound_invoice_id": invoice_id, "storage_key": storage_key},
                exc_info=True,
            )

    return {"ok": True}


@router.delete("/{invoice_id}")
def delete_inbound_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = db.get(InboundInvoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_purchase_accounting_period_unlocked(db, inv)

    provider_slug = (inv.provider_slug or "").strip().lower()
    if provider_slug not in {"manual_import", "mock", "dummy"}:
        raise HTTPException(409, "Seuls les documents importés manuellement peuvent être supprimés.")
    has_payment = (
        db.query(PurchasePayment.id)
        .filter(PurchasePayment.tenant_id == user.tenant_id, PurchasePayment.inbound_invoice_id == inv.id)
        .first()
    )
    if has_payment:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "purchase_has_supplier_payments",
                "message": "Supprime d'abord les règlements fournisseur associés avant de supprimer cet achat.",
            },
        )

    attachment_keys = [
        key
        for (key,) in db.query(InboundInvoiceAttachment.storage_key)
        .filter(InboundInvoiceAttachment.inbound_invoice_id == inv.id)
        .all()
        if key
    ]

    _clear_purchase_workflow_state(db, inv.tenant_id, inv.id)
    db.delete(inv)
    db.commit()

    for key in attachment_keys:
        try:
            delete_object(key)
        except Exception:
            logger.warning(
                "purchase_attachment_cleanup_failed",
                extra={"tenant_id": user.tenant_id, "inbound_invoice_id": invoice_id, "storage_key": key},
                exc_info=True,
            )

    return {"ok": True}


@router.post("/{invoice_id}/ack")
async def acknowledge_inbound_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = db.get(InboundInvoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_seqino_mandate_for_provider(db, inv.tenant_id, inv.provider_slug)
    if inv.status == "acknowledged":
        return {"ok": True, "status": inv.status}
    if not inv.external_message_id:
        raise HTTPException(400, "Message externe manquant.")
    if not inv.provider_slug:
        raise HTTPException(400, "Sélectionnez une plateforme agréée pour confirmer la réception.")

    conn = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == inv.tenant_id, PdpConnection.provider_slug == inv.provider_slug)
        .first()
    )
    if not conn or (conn.status or "").lower() != "connected":
        raise HTTPException(400, "Connexion plateforme agréée inactive.")
    ensure_connected_mode_operational(db, inv.tenant_id, conn.provider_slug)
    creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
    creds["_tenant_id"] = inv.tenant_id
    creds = enrich_credentials_with_secrets(db, inv.tenant_id, creds)
    try:
        provider = get_provider(conn.provider_slug, creds)
    except Exception:
        raise HTTPException(400, "Cette plateforme agréée n’est pas prise en charge.")

    try:
        await provider.ack_inbox(inv.external_message_id)
    except NotImplementedError:
        raise HTTPException(501, "Acquittement non supporte par le provider.")
    except PdpProviderError as exc:
        raise HTTPException(
            status_code=seqino_http_status(exc.code),
            detail={
                "code": exc.code or "pdp_inbox_action_failed",
                "message": "L'acquittement n'a pas ete confirme par la plateforme partenaire.",
            },
        ) from exc
    inv.status = "acknowledged"
    inv.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type="acknowledged",
            payload_hash=hashlib.sha256(inv.external_message_id.encode("utf-8")).hexdigest(),
        )
    )
    db.add(inv)
    db.commit()
    return {"ok": True, "status": inv.status}


@router.post("/{invoice_id}/status")
async def update_inbound_status(
    invoice_id: str,
    payload: InboundInvoiceStatusRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    inv = db.get(InboundInvoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_seqino_mandate_for_provider(db, inv.tenant_id, inv.provider_slug)
    action = (payload.action or "").strip().lower()
    if action not in {"accept", "reject", "request_correction", "mark_as_paid"}:
        raise HTTPException(400, "Action invalide.")
    if not inv.external_message_id:
        raise HTTPException(400, "Message externe manquant.")
    if not inv.provider_slug:
        raise HTTPException(400, "Sélectionnez une plateforme agréée pour répondre.")

    conn = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == inv.tenant_id, PdpConnection.provider_slug == inv.provider_slug)
        .first()
    )
    if not conn or (conn.status or "").lower() != "connected":
        raise HTTPException(400, "Connexion plateforme agréée inactive.")
    ensure_connected_mode_operational(db, inv.tenant_id, conn.provider_slug)
    creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
    creds["_tenant_id"] = inv.tenant_id
    creds = enrich_credentials_with_secrets(db, inv.tenant_id, creds)
    try:
        provider = get_provider(conn.provider_slug, creds)
    except Exception:
        raise HTTPException(400, "Cette plateforme agréée n’est pas prise en charge.")

    async def perform_provider_action() -> None:
        try:
            await provider.send_inbox_status(inv.external_message_id, action)
        except NotImplementedError:
            if action != "accept":
                raise
            await provider.ack_inbox(inv.external_message_id)

    try:
        if action == "request_correction":
            await perform_provider_action()
        else:
            outbox = await execute_idempotent_provider_action(
                db,
                tenant_id=inv.tenant_id,
                provider_slug=inv.provider_slug,
                external_id=inv.external_message_id,
                action={"reject": "refuse"}.get(action, action),
                callback=perform_provider_action,
                reference_id=inv.id,
            )
            if str(outbox.state or "").strip().lower() != "completed":
                raise HTTPException(
                    409,
                    detail={
                        "code": "einvoicing_action_in_progress",
                        "message": "Action plateforme partenaire déjà en cours de traitement.",
                    },
                )
    except NotImplementedError as exc:
        raise HTTPException(501, "Action non supportee par le provider.") from exc
    except PdpProviderError as exc:
        raise HTTPException(
            status_code=seqino_http_status(exc.code),
            detail={
                "code": exc.code or "pdp_inbox_action_failed",
                "message": "L'action n'a pas ete confirmee par la plateforme partenaire.",
            },
        ) from exc

    inv.status = {
        "accept": "accepted",
        "reject": "rejected",
        "request_correction": "correction_requested",
        "mark_as_paid": "paid",
    }[action]
    inv.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(
        InboundInvoiceEvent(
            inbound_invoice_id=inv.id,
            type=inv.status,
            payload_hash=hashlib.sha256(f"{inv.external_message_id}:{action}".encode("utf-8")).hexdigest(),
        )
    )
    db.add(inv)
    db.commit()
    return {"ok": True, "status": inv.status}


@router.post("/mock", response_model=InboundInvoiceOut)
def create_mock_inbound(
    payload: dict,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    env = (settings.APP_ENV or "").lower()
    if env in {"prod", "production"}:
        raise HTTPException(404, "Not found")
    inv = ingest_inbound_message(
        db,
        tenant_id=user.tenant_id,
        provider_slug=payload.get("provider_slug") or "http_generic",
        message=payload,
    )
    return inv
