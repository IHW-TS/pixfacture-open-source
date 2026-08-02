from __future__ import annotations

import csv
import io
import uuid

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import (
    AuthUser,
    API_SCOPE_READ_INVOICES,
    require_accountant_or_admin,
    require_accountant_or_admin_or_api_key,
    require_product_feature,
)
from ..models import (
    CreditNoteRefund,
    Customer,
    EmailEvent,
    InboundInvoice,
    Invoice,
    Payment,
    PurchasePayment,
    PurchaseWorkflowState,
    Tenant,
    TenantSettings,
)
from ..services.invoices.followup_decision import (
    INVOICE_FOLLOWUP_MISSING_RECIPIENT,
    invoice_followup_decision,
)
from ..services.accounting_exports import accounting_period_lock_payload, find_delivered_accounting_period_lock
from ..services.dunning_settings import get_dunning_settings
from ..services.invoices.amounts import invoice_advance_payments_total_ttc
from ..services.invoices.deposits import invoice_effective_template_options
from ..config import settings


router = APIRouter(
    prefix="/api/collections",
    tags=["collections"],
    dependencies=[Depends(require_product_feature("payments_enabled"))],
)

CSV_INJECTION_PREFIXES = ("=", "+", "-", "@")


class ReceivableInvoiceOut(BaseModel):
    id: str
    number: str | None = None
    status: str
    currency: str = "EUR"
    customer_id: str
    customer_name: str | None = None
    due_date: datetime | None = None
    total_inc_vat: Decimal = Decimal("0")
    balance_due: Decimal = Decimal("0")
    days_overdue: int = 0
    reminder_count: int = 0
    last_reminder_at: datetime | None = None
    next_followup_at: datetime | None = None
    next_followup_offset: int | None = None
    followup_state: str | None = None  # eligible_now | scheduled | none
    followup_block_reason: str | None = None
    public_enabled: bool = False
    public_token: str | None = None
    public_path: str | None = None
    can_followup: bool = False
    last_email_status: str | None = None
    last_email_delivery_mode: str | None = None
    last_email_provider: str | None = None
    last_email_provider_status: str | None = None
    last_email_provider_event_at: datetime | None = None
    last_email_at: datetime | None = None
    last_email_error: str | None = None


class ReceivablesSummary(BaseModel):
    total_balance_due: Decimal = Decimal("0")
    overdue_balance_due: Decimal = Decimal("0")
    due_soon_balance_due: Decimal = Decimal("0")
    open_balance_due: Decimal = Decimal("0")
    count_total: int = 0
    count_overdue: int = 0
    count_due_soon: int = 0
    count_open: int = 0


class ReceivablesOut(BaseModel):
    items: list[ReceivableInvoiceOut]
    summary: ReceivablesSummary
    now: datetime


class ReceivablesQueueOut(BaseModel):
    eligible_followup_count: int = 0
    scheduled_followup_count: int = 0
    overdue_7_count: int = 0
    overdue_30_count: int = 0
    no_recipient_count: int = 0


class ReceivablesTopDebtorOut(BaseModel):
    customer_id: str
    customer_name: str | None = None
    balance_due: Decimal = Decimal("0")
    overdue_balance_due: Decimal = Decimal("0")
    invoice_count: int = 0
    overdue_count: int = 0
    oldest_due_date: datetime | None = None
    last_reminder_at: datetime | None = None


class ReceivablesRecentPaymentOut(BaseModel):
    payment_id: str
    invoice_id: str
    invoice_number: str | None = None
    customer_id: str
    customer_name: str | None = None
    amount: Decimal = Decimal("0")
    currency: str = "EUR"
    method: str | None = None
    reference: str | None = None
    settlement_mode: str | None = None
    accounting_category: str | None = None
    receipt_label: str | None = None
    receipt_url: str | None = None
    date: datetime | None = None


class ReceivablesDashboardOut(BaseModel):
    summary: ReceivablesSummary
    queue: ReceivablesQueueOut
    top_debtors: list[ReceivablesTopDebtorOut]
    recent_payments: list[ReceivablesRecentPaymentOut]
    now: datetime


class CashMethodBreakdownOut(BaseModel):
    method: str
    label: str
    payment_count: int = 0
    total_amount: Decimal = Decimal("0")


class CashDueBucketOut(BaseModel):
    bucket: str
    label: str
    invoice_count: int = 0
    amount: Decimal = Decimal("0")


class CashPurchaseBucketOut(BaseModel):
    state: str
    label: str
    invoice_count: int = 0
    amount: Decimal = Decimal("0")


class CashSupplierDocumentOut(BaseModel):
    invoice_id: str
    invoice_number: str | None = None
    supplier_name: str | None = None
    currency: str = "EUR"
    amount: Decimal = Decimal("0")
    received_at: datetime | None = None
    planned_payment_date: date | None = None
    workflow_state: str
    workflow_label: str
    href: str


class ManualBankTransactionIn(BaseModel):
    id: str | None = None
    date: str | None = None
    label: str = ""
    amount: Decimal = Decimal("0")
    currency: str = "EUR"


class ManualBankTransactionJustifyRequest(BaseModel):
    target_type: str = "manual"
    target_id: str | None = None
    note: str | None = None


class ManualBankTransactionOut(BaseModel):
    id: str
    date: str | None = None
    label: str
    amount: Decimal = Decimal("0")
    currency: str = "EUR"
    status: str = "to_review"
    target_type: str | None = None
    target_id: str | None = None
    target_label: str | None = None
    note: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ManualBankTransactionImportRequest(BaseModel):
    rows: list[ManualBankTransactionIn] = []


class ManualBankTransactionImportOut(BaseModel):
    imported_count: int = 0
    items: list[ManualBankTransactionOut] = []


class CashPeriodOut(BaseModel):
    key: str
    label: str
    start_date: datetime | None = None
    end_date: datetime | None = None


class CashOutstandingInvoiceOut(BaseModel):
    invoice_id: str
    invoice_number: str | None = None
    customer_id: str
    customer_name: str | None = None
    currency: str = "EUR"
    due_date: datetime | None = None
    balance_due: Decimal = Decimal("0")
    days_overdue: int = 0
    status: str
    can_followup: bool = False
    followup_state: str | None = None
    followup_block_reason: str | None = None
    public_path: str | None = None
    last_email_status: str | None = None
    last_email_delivery_mode: str | None = None
    last_email_provider: str | None = None
    last_email_provider_status: str | None = None
    last_email_provider_event_at: datetime | None = None
    last_email_at: datetime | None = None
    last_email_error: str | None = None


class CashDashboardOut(BaseModel):
    mode: str = "manual"
    period: CashPeriodOut | None = None
    collected_period: Decimal = Decimal("0")
    supplier_paid_period: Decimal = Decimal("0")
    manual_net_period: Decimal = Decimal("0")
    collected_last_30_days: Decimal = Decimal("0")
    collected_this_month: Decimal = Decimal("0")
    average_days_to_pay: float | None = None
    collection_ratio_last_90_days: float | None = None
    due_next_14_days: Decimal = Decimal("0")
    overdue_balance_due: Decimal = Decimal("0")
    open_balance_due: Decimal = Decimal("0")
    overdue_count: int = 0
    supplier_to_review_amount: Decimal = Decimal("0")
    supplier_ready_to_pay_amount: Decimal = Decimal("0")
    supplier_planned_outflow: Decimal = Decimal("0")
    supplier_booked_last_30_days: Decimal = Decimal("0")
    purchase_document_count: int = 0
    manual_net_next_14_days: Decimal = Decimal("0")
    manual_net_last_30_days: Decimal = Decimal("0")
    payment_methods: list[CashMethodBreakdownOut] = []
    due_buckets: list[CashDueBucketOut] = []
    purchase_buckets: list[CashPurchaseBucketOut] = []
    recent_payments: list[ReceivablesRecentPaymentOut] = []
    outstanding_invoices: list[CashOutstandingInvoiceOut] = []
    supplier_documents: list[CashSupplierDocumentOut] = []
    manual_bank_transactions: list[ManualBankTransactionOut] = []
    now: datetime


class PaymentOpsSummaryOut(BaseModel):
    collected_last_30_days: Decimal = Decimal("0")
    payments_count_last_30_days: int = 0
    open_balance_due: Decimal = Decimal("0")
    open_invoice_count: int = 0
    partial_invoice_count: int = 0
    missing_reference_count: int = 0
    missing_method_count: int = 0
    missing_justification_count: int = 0
    overdue_without_public_link_count: int = 0


class PaymentOpsIssueOut(BaseModel):
    payment_id: str
    invoice_id: str
    invoice_number: str | None = None
    customer_id: str
    customer_name: str | None = None
    date: datetime | None = None
    amount: Decimal = Decimal("0")
    currency: str = "EUR"
    method: str | None = None
    reference: str | None = None
    settlement_mode: str | None = None
    accounting_category: str | None = None
    receipt_label: str | None = None
    receipt_url: str | None = None
    quality_state: str
    quality_label: str


class PaymentOpsActionOut(BaseModel):
    invoice_id: str
    invoice_number: str | None = None
    customer_id: str
    customer_name: str | None = None
    currency: str = "EUR"
    status: str
    due_date: datetime | None = None
    balance_due: Decimal = Decimal("0")
    days_overdue: int = 0
    payment_count: int = 0
    last_payment_at: datetime | None = None
    public_enabled: bool = False
    public_path: str | None = None
    followup_state: str | None = None
    followup_block_reason: str | None = None
    can_followup: bool = False
    last_email_status: str | None = None
    last_email_delivery_mode: str | None = None
    last_email_provider: str | None = None
    last_email_provider_status: str | None = None
    last_email_provider_event_at: datetime | None = None
    last_email_at: datetime | None = None
    last_email_error: str | None = None
    next_step: str


class PaymentOpsCustomerOut(BaseModel):
    customer_id: str
    customer_name: str | None = None
    outstanding_balance: Decimal = Decimal("0")
    collected_last_90_days: Decimal = Decimal("0")
    payment_count: int = 0
    average_days_to_pay: float | None = None


class PaymentsDashboardOut(BaseModel):
    summary: PaymentOpsSummaryOut
    recent_payments: list[ReceivablesRecentPaymentOut] = []
    quality_issues: list[PaymentOpsIssueOut] = []
    action_queue: list[PaymentOpsActionOut] = []
    top_customers: list[PaymentOpsCustomerOut] = []
    now: datetime


def _parse_bucket(bucket: str | None) -> str:
    b = (bucket or "").strip().lower()
    if b in {"overdue", "due_soon", "open", "all"}:
        return b
    return "all"


def _fmt_decimal(v: Any) -> Decimal:
    try:
        return Decimal(str(v or 0))
    except Exception:
        return Decimal("0")


def _csv_safe(value: str | None) -> str:
    v = (value or "").strip()
    first_meaningful = v.lstrip(" \t\r\n\ufeff")
    if first_meaningful and first_meaningful[0] in CSV_INJECTION_PREFIXES:
        return "'" + v
    return v


def _payment_method_label(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    labels = {
        "card": "Carte",
        "cb": "Carte",
        "stripe": "Carte",
        "sepa": "SEPA",
        "virement": "Virement",
        "wire": "Virement",
        "transfer": "Virement",
        "prelevement": "Prélèvement",
        "direct_debit": "Prélèvement",
        "check": "Chèque",
        "cheque": "Chèque",
        "cash": "Espèces",
        "manual": "Manuel",
    }
    return labels.get(normalized, normalized.replace("_", " ").strip().title() or "Non renseigné")


_PURCHASE_WORKFLOW_STORE_KEY = "purchase_workflow_states"
_PURCHASE_STATES = {"new", "reviewing", "awaiting_supplier", "approved", "ready_to_pay", "booked"}
_PURCHASE_LABELS = {
    "new": "À traiter",
    "reviewing": "En revue",
    "awaiting_supplier": "Attente fournisseur",
    "approved": "Validé",
    "ready_to_pay": "À payer",
    "booked": "Payé",
}
_BANK_TRANSACTION_STORE_KEY = "manual_bank_transactions"
_BANK_TRANSACTION_LIMIT = 500
_BANK_TRANSACTION_STATUSES = {"to_review", "matched"}
_RECEIVABLES_CSV_EXPORT_LIMIT = 5000


def _normalize_purchase_state_for_cash(value: str | None) -> str:
    normalized = (value or "new").strip().lower()
    aliases = {
        "todo": "new",
        "review": "reviewing",
        "en_revue": "reviewing",
        "awaiting": "awaiting_supplier",
        "supplier": "awaiting_supplier",
        "ok": "approved",
        "ready": "ready_to_pay",
        "paid": "booked",
        "done": "booked",
    }
    normalized = aliases.get(normalized, normalized)
    return normalized if normalized in _PURCHASE_STATES else "new"


def _default_purchase_state_for_cash(row: InboundInvoice) -> str:
    status = (row.status or "").strip().lower()
    validation = (row.validation_status or "").strip().lower()
    if status in {"paid"}:
        return "booked"
    if status in {"correction_requested", "rejected"} or validation == "invalid":
        return "awaiting_supplier"
    if status in {"accepted", "available"}:
        return "approved"
    if status == "acknowledged" or validation == "warning":
        return "reviewing"
    return "new"


def _purchase_workflow_states_for_tenant(db: Session, tenant_id: str) -> dict[str, dict[str, Any]]:
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    states: dict[str, dict[str, Any]] = {}
    if settings_row and isinstance(settings_row.features, dict):
        raw = settings_row.features.get(_PURCHASE_WORKFLOW_STORE_KEY)
        if isinstance(raw, dict):
            states.update(
                {
                    str(invoice_id): payload
                    for invoice_id, payload in raw.items()
                    if invoice_id and isinstance(payload, dict)
                }
            )
    rows = db.query(PurchaseWorkflowState).filter(PurchaseWorkflowState.tenant_id == tenant_id).all()
    for row in rows:
        states[row.inbound_invoice_id] = {
            "invoice_id": row.inbound_invoice_id,
            "state": row.state,
            "owner_role": row.owner_role,
            "note": row.note,
            "updated_at": row.updated_at,
        }
    return states


def _purchase_state_for_cash(row: InboundInvoice, workflow_states: dict[str, dict[str, Any]]) -> str:
    stored = workflow_states.get(row.id) or {}
    return _normalize_purchase_state_for_cash(stored.get("state") or _default_purchase_state_for_cash(row))


def _purchase_amount(row: InboundInvoice) -> Decimal:
    amount = _fmt_decimal(row.total_ttc)
    if amount == 0:
        amount = _fmt_decimal(row.total_ex_vat) + _fmt_decimal(row.total_vat)
    if amount < 0:
        return abs(amount)
    return amount


def _purchase_cash_datetime(row: InboundInvoice) -> datetime | None:
    planned = row.planned_payment_date or row.employee_reimbursement_due_date
    if planned:
        return datetime.combine(planned, datetime.min.time())
    return _naive_datetime(row.received_at) or _naive_datetime(row.created_at)


def _purchase_payment_total(db: Session, tenant_id: str, purchase_id: str) -> Decimal:
    return Decimal(
        str(
            db.query(func.coalesce(func.sum(PurchasePayment.amount), 0))
            .filter(PurchasePayment.tenant_id == tenant_id, PurchasePayment.inbound_invoice_id == purchase_id)
            .scalar()
            or 0
        )
    ).quantize(Decimal("0.01"))


def _purchase_payment_remaining(db: Session, tenant_id: str, purchase: InboundInvoice) -> Decimal:
    return max(_purchase_amount(purchase) - _purchase_payment_total(db, tenant_id, purchase.id), Decimal("0.00"))


def _purchase_line_decimal(raw: dict[str, Any], key: str) -> Decimal:
    try:
        return Decimal(str(raw.get(key) or 0)).quantize(Decimal("0.01"))
    except Exception:
        return Decimal("0.00")


def _purchase_line_zero_vat_has_reason(raw: dict[str, Any]) -> bool:
    category = str(raw.get("vat_category") or "").strip().upper()
    return bool(
        category in {"AE", "E", "O", "Z", "G", "K"}
        or str(raw.get("exemption_reason_code") or "").strip()
        or str(raw.get("vat_exemption_reason") or "").strip()
        or str(raw.get("vat_zero_reason") or "").strip()
        or raw.get("vat_reverse_charge")
    )


def _purchase_zero_vat_missing_reason(purchase: InboundInvoice) -> bool:
    if _purchase_amount(purchase) <= Decimal("0.00"):
        return False
    if Decimal(str(purchase.total_vat or 0)).quantize(Decimal("0.01")) > Decimal("0.00"):
        return False
    lines = purchase.purchase_lines if isinstance(purchase.purchase_lines, list) else []
    meaningful_lines = [
        raw for raw in lines if isinstance(raw, dict) and _purchase_line_decimal(raw, "total_ex_vat") > Decimal("0.00")
    ]
    if not meaningful_lines:
        return True
    return any(
        _purchase_line_decimal(raw, "total_vat") <= Decimal("0.00") and not _purchase_line_zero_vat_has_reason(raw)
        for raw in meaningful_lines
    )


def _ensure_purchase_completed_for_supplier_payment(purchase: InboundInvoice) -> None:
    if str(purchase.completion_status or "").strip().lower() == "completed" and not _purchase_zero_vat_missing_reason(
        purchase
    ):
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "purchase_completion_required",
            "message": "Valide la qualification de cet achat avant de rapprocher un règlement fournisseur.",
        },
    )


def _ensure_accounting_period_unlocked(
    db: Session,
    *,
    tenant_id: str,
    period_date: datetime | str | None,
    message: str,
) -> None:
    if not period_date:
        return
    if isinstance(period_date, str):
        try:
            period_date = datetime.fromisoformat(period_date[:10])
        except ValueError:
            return
    check_date = period_date.date() if isinstance(period_date, datetime) else period_date
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=tenant_id,
        period_start=check_date,
        period_end=check_date,
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


def _tenant_features(settings_row: TenantSettings | None) -> dict[str, Any]:
    if settings_row and isinstance(settings_row.features, dict):
        return dict(settings_row.features)
    return {}


def _ensure_tenant_settings(db: Session, tenant_id: str) -> TenantSettings:
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if settings_row:
        return settings_row
    settings_row = TenantSettings(tenant_id=tenant_id)
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _normalize_bank_transaction_status(value: str | None) -> str:
    normalized = (value or "to_review").strip().lower()
    return normalized if normalized in _BANK_TRANSACTION_STATUSES else "to_review"


def _normalize_bank_transaction_date(value: str | None) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    candidates = [raw[:10] if len(raw) >= 10 else raw]
    if len(raw) >= 10 and "/" in raw:
        candidates.append(raw[:10])
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate:
            continue
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                return datetime.strptime(candidate, fmt).date().isoformat()
            except ValueError:
                continue
    if len(raw) >= 10:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
        except ValueError:
            pass
    return None


def _read_manual_bank_transactions(settings_row: TenantSettings | None) -> list[dict[str, Any]]:
    raw = _tenant_features(settings_row).get(_BANK_TRANSACTION_STORE_KEY)
    if not isinstance(raw, list):
        return []
    clean: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        transaction_id = str(item.get("id") or "").strip()
        if not transaction_id:
            continue
        clean.append(
            {
                "id": transaction_id,
                "date": _normalize_bank_transaction_date(str(item.get("date") or "")),
                "label": str(item.get("label") or "Mouvement bancaire").strip()[:240],
                "amount": str(_fmt_decimal(item.get("amount"))),
                "currency": str(item.get("currency") or "EUR").strip().upper()[:8] or "EUR",
                "status": _normalize_bank_transaction_status(item.get("status")),
                "target_type": item.get("target_type") or None,
                "target_id": item.get("target_id") or None,
                "target_label": item.get("target_label") or None,
                "note": item.get("note") or None,
                "created_at": item.get("created_at") or None,
                "updated_at": item.get("updated_at") or None,
            }
        )
    return clean[-_BANK_TRANSACTION_LIMIT:]


def _write_manual_bank_transactions(
    db: Session,
    settings_row: TenantSettings,
    rows: list[dict[str, Any]],
    *,
    features: dict[str, Any] | None = None,
) -> TenantSettings:
    next_features = features if features is not None else _tenant_features(settings_row)
    next_features[_BANK_TRANSACTION_STORE_KEY] = rows[-_BANK_TRANSACTION_LIMIT:]
    settings_row.features = next_features
    db.add(settings_row)
    db.commit()
    db.refresh(settings_row)
    return settings_row


def _set_purchase_workflow_state(
    features: dict[str, Any],
    *,
    invoice_id: str,
    state: str,
    note: str,
    updated_at: str,
    db: Session | None = None,
    tenant_id: str | None = None,
) -> dict[str, Any]:
    purchase_states = features.get(_PURCHASE_WORKFLOW_STORE_KEY)
    if not isinstance(purchase_states, dict):
        purchase_states = {}
    next_states = dict(purchase_states)
    next_states[invoice_id] = {
        "invoice_id": invoice_id,
        "state": state,
        "owner_role": "accountant",
        "note": note,
        "updated_at": updated_at,
    }
    features[_PURCHASE_WORKFLOW_STORE_KEY] = next_states
    if db is not None and tenant_id:
        _write_purchase_workflow_state_row(
            db,
            tenant_id=tenant_id,
            invoice_id=invoice_id,
            state=state,
            note=note,
            updated_at=updated_at,
        )
    return features


def _write_purchase_workflow_state_row(
    db: Session,
    *,
    tenant_id: str,
    invoice_id: str,
    state: str,
    note: str,
    updated_at: str,
) -> None:
    updated_dt = _parse_optional_datetime(updated_at) or datetime.now(timezone.utc).replace(tzinfo=None)
    updated_dt = _naive_datetime(updated_dt) or datetime.now(timezone.utc).replace(tzinfo=None)
    row = (
        db.query(PurchaseWorkflowState)
        .filter(PurchaseWorkflowState.tenant_id == tenant_id, PurchaseWorkflowState.inbound_invoice_id == invoice_id)
        .with_for_update()
        .first()
    )
    if not row:
        row = PurchaseWorkflowState(tenant_id=tenant_id, inbound_invoice_id=invoice_id, created_at=updated_dt)
    row.state = state
    row.owner_role = "accountant"
    row.note = note
    row.updated_at = updated_dt
    db.add(row)


def _remove_purchase_payments_for_bank_transaction(
    db: Session,
    *,
    tenant_id: str,
    transaction_id: str,
    linked_purchase_id: str | None,
    features: dict[str, Any],
    updated_at: str,
) -> dict[str, Any]:
    if not linked_purchase_id:
        return features
    linked_payments = (
        db.query(PurchasePayment)
        .filter(
            PurchasePayment.tenant_id == tenant_id,
            PurchasePayment.inbound_invoice_id == linked_purchase_id,
            PurchasePayment.reference == transaction_id,
        )
        .all()
    )
    touched_purchases: dict[str, InboundInvoice] = {}
    for payment in linked_payments:
        purchase = payment.inbound_invoice or db.get(InboundInvoice, payment.inbound_invoice_id)
        if not purchase or purchase.tenant_id != tenant_id:
            continue
        purchase_period_date = purchase.issue_date or (purchase.received_at.date() if purchase.received_at else None)
        _ensure_accounting_period_unlocked(
            db,
            tenant_id=tenant_id,
            period_date=purchase_period_date,
            message="Cet achat appartient à une période déjà remise au cabinet.",
        )
        _ensure_accounting_period_unlocked(
            db,
            tenant_id=tenant_id,
            period_date=payment.date,
            message="Ce règlement fournisseur appartient à une période déjà remise au cabinet.",
        )
        touched_purchases[purchase.id] = purchase
        db.delete(payment)
    if linked_payments:
        db.flush()
    for purchase in touched_purchases.values():
        remaining = _purchase_payment_remaining(db, tenant_id, purchase)
        features = _set_purchase_workflow_state(
            features,
            invoice_id=purchase.id,
            state="booked" if remaining <= Decimal("0.00") else "ready_to_pay",
            note="Rapprochement bancaire retiré."
            if remaining > Decimal("0.00")
            else "Règlement fournisseur toujours soldé.",
            updated_at=updated_at,
            db=db,
            tenant_id=tenant_id,
        )
    return features


def _linked_purchase_id_from_bank_transaction(row: dict[str, Any] | None) -> str | None:
    if not isinstance(row, dict):
        return None
    if str(row.get("target_type") or "").strip().lower() != "purchase":
        return None
    value = str(row.get("target_id") or "").strip()
    return value or None


def _bank_transaction_out(row: dict[str, Any]) -> ManualBankTransactionOut:
    return ManualBankTransactionOut(
        id=str(row.get("id") or ""),
        date=_normalize_bank_transaction_date(str(row.get("date") or "")),
        label=str(row.get("label") or "Mouvement bancaire"),
        amount=_fmt_decimal(row.get("amount")),
        currency=str(row.get("currency") or "EUR"),
        status=_normalize_bank_transaction_status(row.get("status")),
        target_type=row.get("target_type") or None,
        target_id=row.get("target_id") or None,
        target_label=row.get("target_label") or None,
        note=row.get("note") or None,
        created_at=_naive_datetime(_parse_optional_datetime(row.get("created_at"))),
        updated_at=_naive_datetime(_parse_optional_datetime(row.get("updated_at"))),
    )


def _parse_optional_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _purchase_target_label(row: InboundInvoice) -> str:
    parts = [row.supplier_name or "Fournisseur"]
    if row.invoice_number:
        parts.append(f"Achat {row.invoice_number}")
    amount = _purchase_amount(row)
    parts.append(f"{amount:.2f} {row.currency or 'EUR'}")
    return " · ".join(parts)


def _naive_datetime(value: datetime | None) -> datetime | None:
    if not value:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _compute_next_followup(
    *,
    inv: Invoice,
    tenant: Tenant,
    customer: Customer,
    balance_due: Decimal,
    now: datetime,
    has_recipients: bool,
) -> tuple[datetime | None, int | None, str | None, bool]:
    """Calcule la prochaine relance recommandée selon la même logique que le job auto.

    On n'envoie rien ici. On renvoie:
    - next_followup_at : date/heure recommandée (now si éligible immédiatement)
    - next_followup_offset : offset (jours) par rapport à due_date
    - followup_state : eligible_now | scheduled | none
    - can_followup : True si dunning enabled + recipients + balance_due>0
    """
    if balance_due <= 0:
        return None, None, None, False
    if not bool(getattr(settings, "INVOICE_FOLLOWUP_AUTOMATIC_ENABLED", False)):
        return None, None, None, False
    dunning = get_dunning_settings(tenant)
    if not bool(dunning.get("enabled")):
        return None, None, None, False

    _has_recipients = bool(has_recipients)

    due = inv.due_date
    if not due:
        return None, None, None, False
    schedule = list(dunning.get("schedule_days") or [])
    if not schedule:
        schedule = [-2, 3, 10]

    # Cap global optionnel (si défini), sinon longueur schedule.
    max_reminders_global = int(getattr(settings, "INVOICE_FOLLOWUP_MAX_REMINDERS", 0) or 0)
    max_reminders = max_reminders_global or len(schedule)
    schedule_eff = schedule[:max_reminders]

    rc = int(getattr(inv, "reminder_count", 0) or 0)

    # Même logique "rattrapage" que le job.
    next_index: int | None = None
    for i in range(rc, len(schedule_eff)):
        offset = int(schedule_eff[i])
        trigger = due + timedelta(days=offset)
        if offset < 0:
            if now < trigger:
                continue
            if now > due:
                continue
            next_index = i
            break
        else:
            # post-due: éligible dès trigger
            if now >= trigger:
                next_index = i
                break
            # scheduled dans le futur -> c'est la prochaine
            next_index = i
            break

    if next_index is None:
        return None, None, "none", _has_recipients

    offset = int(schedule_eff[next_index])
    trigger = due + timedelta(days=offset)
    if offset < 0:
        # pre-due: on est forcément entre trigger et due ici
        return now, offset, "eligible_now", _has_recipients
    if now >= trigger:
        return now, offset, "eligible_now", _has_recipients
    return trigger, offset, "scheduled", _has_recipients


def _can_send_manual_followup(inv: Invoice, *, balance_due: Decimal, has_recipients: bool) -> bool:
    if balance_due <= 0 or not has_recipients:
        return False
    return str(inv.status or "").lower() not in {"draft", "canceled"}


def _public_invoice_path(inv: Invoice) -> str | None:
    if not bool(getattr(inv, "public_enabled", False)):
        return None
    token = str(getattr(inv, "public_token", "") or "").strip()
    return f"/i/{token}" if token else None


def _public_invoice_token(inv: Invoice) -> str | None:
    if not bool(getattr(inv, "public_enabled", False)):
        return None
    token = str(getattr(inv, "public_token", "") or "").strip()
    return token or None


def _payments_by_invoice(db: Session, invoice_ids: list[str]) -> dict[str, Decimal]:
    if not invoice_ids:
        return {}
    rows = (
        db.query(Payment.invoice_id, func.sum(Payment.amount))
        .filter(Payment.invoice_id.in_(invoice_ids))
        .group_by(Payment.invoice_id)
        .all()
    )
    return {iid: _fmt_decimal(total) for iid, total in rows}


def _credits_by_invoice(db: Session, invoice_ids: list[str]) -> dict[str, Decimal]:
    if not invoice_ids:
        return {}
    rows = (
        db.query(Invoice.related_invoice_id, func.sum(func.abs(Invoice.total_inc_vat)))
        .filter(Invoice.type == "credit_note")
        .filter(Invoice.status.notin_(["draft", "canceled"]))
        .filter(Invoice.related_invoice_id.in_(invoice_ids))
        .group_by(Invoice.related_invoice_id)
        .all()
    )
    return {iid: _fmt_decimal(total) for iid, total in rows}


def _latest_email_events_by_invoice(
    db: Session,
    *,
    tenant_id: str,
    invoice_ids: list[str],
    reminder_at_by_invoice: dict[str, datetime | None] | None = None,
) -> dict[str, EmailEvent]:
    if not invoice_ids:
        return {}
    reminder_at_by_invoice = reminder_at_by_invoice or {}
    rows = (
        db.query(EmailEvent)
        .filter(EmailEvent.tenant_id == tenant_id)
        .filter(EmailEvent.invoice_id.in_(invoice_ids))
        .order_by(EmailEvent.created_at.desc(), EmailEvent.id.desc())
        .all()
    )
    latest_typed: dict[str, EmailEvent] = {}
    latest_near_reminder: dict[str, EmailEvent] = {}
    for event in rows:
        invoice_id = event.invoice_id
        if not invoice_id:
            continue
        if event.type == "invoice_followup":
            latest_typed.setdefault(invoice_id, event)
            continue
        latest_typed.setdefault(invoice_id, event)
        if invoice_id in latest_near_reminder:
            continue
        reminder_at = _naive_datetime(reminder_at_by_invoice.get(invoice_id))
        created_at = _naive_datetime(event.created_at)
        if reminder_at and created_at and created_at >= reminder_at - timedelta(minutes=10):
            latest_near_reminder[invoice_id] = event
    return {
        invoice_id: event
        for invoice_id in invoice_ids
        if (event := latest_typed.get(invoice_id) or latest_near_reminder.get(invoice_id)) is not None
    }


def _email_event_fields(event: EmailEvent | None) -> dict[str, Any]:
    if event is None:
        return {
            "last_email_status": None,
            "last_email_delivery_mode": None,
            "last_email_provider": None,
            "last_email_provider_status": None,
            "last_email_provider_event_at": None,
            "last_email_at": None,
            "last_email_error": None,
        }
    return {
        "last_email_status": event.status,
        "last_email_delivery_mode": getattr(event, "delivery_mode", None) or "smtp",
        "last_email_provider": getattr(event, "provider", None),
        "last_email_provider_status": getattr(event, "provider_status", None),
        "last_email_provider_event_at": _naive_datetime(getattr(event, "provider_event_at", None)),
        "last_email_at": _naive_datetime(event.sent_at or event.created_at),
        "last_email_error": event.error,
    }


def _open_receivable_rows(db: Session, tenant_id: str):
    return (
        db.query(Invoice, Customer, Tenant)
        .join(Customer, Customer.id == Invoice.customer_id)
        .join(Tenant, Tenant.id == Invoice.tenant_id)
        .filter(Invoice.tenant_id == tenant_id)
        .filter(Invoice.type == "invoice")
        .filter(Invoice.status.in_(["issued", "sent", "overdue", "partial"]))
        .filter(Invoice.due_date.isnot(None))
        .all()
    )


@router.get("/receivables", response_model=ReceivablesOut)
def list_receivables(
    bucket: str | None = Query(None, description="all|overdue|due_soon|open"),
    q: str | None = Query(None, description="Recherche (client, numéro facture, PO)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=10000),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    """Vue recouvrement: liste des factures non soldées avec échéance + relances."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    b = _parse_bucket(bucket)

    base = (
        db.query(Invoice, Customer, Tenant)
        .join(Customer, Customer.id == Invoice.customer_id)
        .join(Tenant, Tenant.id == Invoice.tenant_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Invoice.type == "invoice")
        .filter(Invoice.status.in_(["issued", "sent", "overdue", "partial"]))
        .filter(Invoice.due_date.isnot(None))
    )

    if q and q.strip():
        term = f"%{q.strip().lower()}%"
        base = base.filter(
            or_(
                func.lower(Customer.name).like(term),
                func.lower(Customer.email).like(term),
                func.lower(Invoice.number).like(term),
                func.lower(Invoice.purchase_order_number).like(term),
            )
        )

    # Bucket filter (par due_date)
    due_soon_days = 7
    if b == "overdue":
        base = base.filter(Invoice.due_date < now)
    elif b == "due_soon":
        base = base.filter(Invoice.due_date >= now).filter(Invoice.due_date <= (now + timedelta(days=due_soon_days)))
    elif b == "open":
        base = base.filter(Invoice.due_date > (now + timedelta(days=due_soon_days)))

    total_rows = base.order_by(Invoice.due_date.asc()).offset(offset).limit(limit).all()

    invoice_ids = [inv.id for inv, _, _ in total_rows]
    if not invoice_ids:
        return ReceivablesOut(items=[], summary=ReceivablesSummary(), now=now)

    # Precompute payments sums
    pay_rows = (
        db.query(Payment.invoice_id, func.sum(Payment.amount))
        .filter(Payment.invoice_id.in_(invoice_ids))
        .group_by(Payment.invoice_id)
        .all()
    )
    paid_by = {iid: _fmt_decimal(total) for iid, total in pay_rows}

    # Precompute credit notes sums
    credit_rows = (
        db.query(Invoice.related_invoice_id, func.sum(func.abs(Invoice.total_inc_vat)))
        .filter(Invoice.type == "credit_note")
        .filter(Invoice.status.notin_(["draft", "canceled"]))
        .filter(Invoice.related_invoice_id.in_(invoice_ids))
        .group_by(Invoice.related_invoice_id)
        .all()
    )
    credits_by = {iid: _fmt_decimal(total) for iid, total in credit_rows}
    latest_email_by = _latest_email_events_by_invoice(
        db,
        tenant_id=user.tenant_id,
        invoice_ids=invoice_ids,
        reminder_at_by_invoice={inv.id: getattr(inv, "last_reminder_at", None) for inv, _, _ in total_rows},
    )

    items: list[ReceivableInvoiceOut] = []

    summary = ReceivablesSummary()
    summary.count_total = 0

    for inv, customer, tenant in total_rows:
        total = _fmt_decimal(inv.total_inc_vat)
        prepaid = invoice_advance_payments_total_ttc(invoice_effective_template_options(db, inv))
        credits = credits_by.get(inv.id, Decimal("0"))
        paid = paid_by.get(inv.id, Decimal("0"))
        balance = total - prepaid - credits - paid
        # clamp
        if balance < 0:
            balance = Decimal("0")

        if balance <= 0:
            # ignore soldées
            continue

        due = inv.due_date
        days_overdue = 0
        if due and due < now:
            days_overdue = (now.date() - due.date()).days

        followup_decision = invoice_followup_decision(
            db,
            inv=inv,
            tenant=tenant,
            customer=customer,
            balance_due=balance,
            now=now,
            due_date=inv.due_date,
        )

        out = ReceivableInvoiceOut(
            id=inv.id,
            number=inv.number,
            status=inv.status,
            currency=inv.currency or "EUR",
            customer_id=customer.id,
            customer_name=customer.name,
            due_date=inv.due_date,
            total_inc_vat=total,
            balance_due=balance,
            days_overdue=days_overdue,
            reminder_count=int(getattr(inv, "reminder_count", 0) or 0),
            last_reminder_at=getattr(inv, "last_reminder_at", None),
            next_followup_at=followup_decision.next_followup_at,
            next_followup_offset=followup_decision.next_followup_offset,
            followup_state=followup_decision.followup_state,
            followup_block_reason=followup_decision.followup_block_reason,
            public_enabled=bool(inv.public_enabled),
            public_token=_public_invoice_token(inv),
            public_path=_public_invoice_path(inv),
            can_followup=followup_decision.can_followup,
            **_email_event_fields(latest_email_by.get(inv.id)),
        )
        items.append(out)

        # Summary buckets
        summary.count_total += 1
        summary.total_balance_due += balance
        if days_overdue > 0:
            summary.count_overdue += 1
            summary.overdue_balance_due += balance
        elif due and due <= (now + timedelta(days=due_soon_days)):
            summary.count_due_soon += 1
            summary.due_soon_balance_due += balance
        else:
            summary.count_open += 1
            summary.open_balance_due += balance

    return ReceivablesOut(items=items, summary=summary, now=now)


@router.get("/dashboard", response_model=ReceivablesDashboardOut)
def receivables_dashboard(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    due_soon_days = 7
    rows = _open_receivable_rows(db, user.tenant_id)
    invoice_ids = [inv.id for inv, _, _ in rows]
    if not invoice_ids:
        return ReceivablesDashboardOut(
            summary=ReceivablesSummary(),
            queue=ReceivablesQueueOut(),
            top_debtors=[],
            recent_payments=[],
            now=now,
        )

    paid_by = _payments_by_invoice(db, invoice_ids)
    credits_by = _credits_by_invoice(db, invoice_ids)

    summary = ReceivablesSummary()
    queue = ReceivablesQueueOut()
    debtors: dict[str, dict[str, Any]] = {}

    for inv, customer, tenant in rows:
        total = _fmt_decimal(inv.total_inc_vat)
        prepaid = invoice_advance_payments_total_ttc(invoice_effective_template_options(db, inv))
        credits = credits_by.get(inv.id, Decimal("0"))
        paid = paid_by.get(inv.id, Decimal("0"))
        balance = total - prepaid - credits - paid
        if balance < 0:
            balance = Decimal("0")
        if balance <= 0:
            continue

        due = inv.due_date
        days_overdue = 0
        if due and due < now:
            days_overdue = (now.date() - due.date()).days

        followup_decision = invoice_followup_decision(
            db,
            inv=inv,
            tenant=tenant,
            customer=customer,
            balance_due=balance,
            now=now,
            due_date=inv.due_date,
        )

        summary.count_total += 1
        summary.total_balance_due += balance
        if days_overdue > 0:
            summary.count_overdue += 1
            summary.overdue_balance_due += balance
        elif due and due <= (now + timedelta(days=due_soon_days)):
            summary.count_due_soon += 1
            summary.due_soon_balance_due += balance
        else:
            summary.count_open += 1
            summary.open_balance_due += balance

        if followup_decision.followup_state == "eligible_now" and followup_decision.can_followup:
            queue.eligible_followup_count += 1
        if followup_decision.followup_state == "scheduled" and followup_decision.can_followup:
            queue.scheduled_followup_count += 1
        if followup_decision.followup_block_reason == INVOICE_FOLLOWUP_MISSING_RECIPIENT:
            queue.no_recipient_count += 1
        if days_overdue >= 7:
            queue.overdue_7_count += 1
        if days_overdue >= 30:
            queue.overdue_30_count += 1

        debtor = debtors.setdefault(
            customer.id,
            {
                "customer_id": customer.id,
                "customer_name": customer.name,
                "balance_due": Decimal("0"),
                "overdue_balance_due": Decimal("0"),
                "invoice_count": 0,
                "overdue_count": 0,
                "oldest_due_date": None,
                "last_reminder_at": None,
            },
        )
        debtor["balance_due"] += balance
        debtor["invoice_count"] += 1
        if days_overdue > 0:
            debtor["overdue_balance_due"] += balance
            debtor["overdue_count"] += 1
        if due and (debtor["oldest_due_date"] is None or due < debtor["oldest_due_date"]):
            debtor["oldest_due_date"] = due
        last_reminder_at = getattr(inv, "last_reminder_at", None)
        if last_reminder_at and (debtor["last_reminder_at"] is None or last_reminder_at > debtor["last_reminder_at"]):
            debtor["last_reminder_at"] = last_reminder_at

    top_debtors = sorted(
        debtors.values(),
        key=lambda item: (item["overdue_balance_due"], item["balance_due"], item["invoice_count"]),
        reverse=True,
    )[:6]

    payment_rows = (
        db.query(Payment, Invoice, Customer)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .join(Customer, Customer.id == Invoice.customer_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .order_by(Payment.date.desc())
        .limit(8)
        .all()
    )
    recent_payments = [
        ReceivablesRecentPaymentOut(
            payment_id=payment.id,
            invoice_id=invoice.id,
            invoice_number=invoice.number,
            customer_id=customer.id,
            customer_name=customer.name,
            amount=_fmt_decimal(payment.amount),
            currency=invoice.currency or "EUR",
            method=payment.method,
            reference=payment.reference,
            settlement_mode=payment.settlement_mode,
            accounting_category=payment.accounting_category,
            receipt_label=payment.receipt_label,
            receipt_url=payment.receipt_url,
            date=payment.date,
        )
        for payment, invoice, customer in payment_rows
    ]

    return ReceivablesDashboardOut(
        summary=summary,
        queue=queue,
        top_debtors=[ReceivablesTopDebtorOut(**item) for item in top_debtors],
        recent_payments=recent_payments,
        now=now,
    )


@router.get("/bank-transactions", response_model=list[ManualBankTransactionOut])
def list_bank_transactions(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    return [_bank_transaction_out(row) for row in _read_manual_bank_transactions(settings_row)]


@router.post("/bank-transactions/import", response_model=ManualBankTransactionImportOut)
def import_bank_transactions(
    payload: ManualBankTransactionImportRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    if len(payload.rows) > _BANK_TRANSACTION_LIMIT:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Import bancaire trop volumineux : limitez le fichier à {_BANK_TRANSACTION_LIMIT} mouvements "
                "pour éviter un rapprochement incomplet."
            ),
        )
    settings_row = _ensure_tenant_settings(db, user.tenant_id)
    current = _read_manual_bank_transactions(settings_row)
    existing_ids = {str(row.get("id")) for row in current}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    now_iso = now.replace(microsecond=0).isoformat()
    imported: list[dict[str, Any]] = []

    for row in payload.rows:
        amount = _fmt_decimal(row.amount)
        label = (row.label or "").strip()[:240] or "Mouvement bancaire"
        if amount == 0:
            continue
        transaction_id = (row.id or "").strip()
        if not transaction_id or transaction_id in existing_ids:
            transaction_id = f"bank-{uuid.uuid4().hex}"
        existing_ids.add(transaction_id)
        imported.append(
            {
                "id": transaction_id,
                "date": _normalize_bank_transaction_date(row.date),
                "label": label,
                "amount": str(amount),
                "currency": (row.currency or "EUR").strip().upper()[:8] or "EUR",
                "status": "to_review",
                "target_type": None,
                "target_id": None,
                "target_label": None,
                "note": None,
                "created_at": now_iso,
                "updated_at": now_iso,
            }
        )

    if not imported:
        return ManualBankTransactionImportOut(imported_count=0, items=[_bank_transaction_out(row) for row in current])

    next_rows = (imported + current)[-_BANK_TRANSACTION_LIMIT:]
    settings_row = _write_manual_bank_transactions(db, settings_row, next_rows)
    items = [_bank_transaction_out(row) for row in _read_manual_bank_transactions(settings_row)]
    return ManualBankTransactionImportOut(imported_count=len(imported), items=items)


@router.post("/bank-transactions/{transaction_id}/justify", response_model=ManualBankTransactionOut)
def justify_bank_transaction(
    transaction_id: str,
    payload: ManualBankTransactionJustifyRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_tenant_settings(db, user.tenant_id)
    rows = _read_manual_bank_transactions(settings_row)
    index = next((idx for idx, row in enumerate(rows) if row.get("id") == transaction_id), None)
    if index is None:
        raise HTTPException(404, "Mouvement bancaire introuvable.")

    target_type = (payload.target_type or "manual").strip().lower()
    if target_type not in {"manual", "purchase", "payment"}:
        raise HTTPException(400, "Type de rapprochement invalide.")

    target_id = (payload.target_id or "").strip() or None
    target_label = "Justifié manuellement"
    note = (payload.note or "").strip()[:500] or None
    features = _tenant_features(settings_row)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    now_iso = now.replace(microsecond=0).isoformat()
    features = _remove_purchase_payments_for_bank_transaction(
        db,
        tenant_id=user.tenant_id,
        transaction_id=transaction_id,
        linked_purchase_id=_linked_purchase_id_from_bank_transaction(rows[index]),
        features=features,
        updated_at=now_iso,
    )

    if target_type == "purchase":
        if not target_id:
            raise HTTPException(400, "Achat à rapprocher manquant.")
        transaction_amount_raw = Decimal(str(rows[index].get("amount") or 0)).quantize(Decimal("0.01"))
        if transaction_amount_raw >= 0:
            raise HTTPException(400, "Un règlement fournisseur doit être une sortie bancaire.")
        purchase = (
            db.query(InboundInvoice)
            .filter(InboundInvoice.id == target_id, InboundInvoice.tenant_id == user.tenant_id)
            .with_for_update()
            .first()
        )
        if not purchase:
            raise HTTPException(404, "Achat introuvable.")
        _ensure_purchase_completed_for_supplier_payment(purchase)
        purchase_period_date = purchase.issue_date or (purchase.received_at.date() if purchase.received_at else None)
        _ensure_accounting_period_unlocked(
            db,
            tenant_id=user.tenant_id,
            period_date=purchase_period_date,
            message="Cet achat appartient à une période déjà remise au cabinet.",
        )
        _ensure_accounting_period_unlocked(
            db,
            tenant_id=user.tenant_id,
            period_date=rows[index].get("date"),
            message="Ce règlement fournisseur appartient à une période déjà remise au cabinet.",
        )
        transaction_amount = abs(transaction_amount_raw).quantize(Decimal("0.01"))
        remaining = _purchase_payment_remaining(db, user.tenant_id, purchase)
        if transaction_amount > 0 and remaining > 0:
            payment_amount = min(transaction_amount, remaining)
            existing_reference = (
                db.query(PurchasePayment.id)
                .filter(
                    PurchasePayment.tenant_id == user.tenant_id,
                    PurchasePayment.inbound_invoice_id == purchase.id,
                    PurchasePayment.reference == transaction_id,
                )
                .first()
            )
            if not existing_reference:
                db.add(
                    PurchasePayment(
                        tenant_id=user.tenant_id,
                        inbound_invoice_id=purchase.id,
                        date=datetime.fromisoformat(str(rows[index].get("date"))) if rows[index].get("date") else now,
                        amount=payment_amount,
                        method="Virement bancaire",
                        reference=transaction_id,
                        settlement_mode="bank",
                        accounting_category="512",
                        receipt_label=rows[index].get("label") or "Mouvement bancaire rapproché",
                        created_by=user.id,
                        created_at=now,
                        updated_at=now,
                    )
                )
        db.flush()
        next_remaining = _purchase_payment_remaining(db, user.tenant_id, purchase)
        features = _set_purchase_workflow_state(
            features,
            invoice_id=purchase.id,
            state="booked" if next_remaining <= Decimal("0.00") else "ready_to_pay",
            note=note
            or (
                f"Rapproché banque : {rows[index].get('label') or 'mouvement bancaire'}"
                if next_remaining <= Decimal("0.00")
                else f"Règlement partiel rapproché. Reste {next_remaining}."
            ),
            updated_at=now_iso,
            db=db,
            tenant_id=user.tenant_id,
        )
        target_label = _purchase_target_label(purchase)
    elif target_type == "payment":
        if not target_id:
            raise HTTPException(400, "Paiement à rapprocher manquant.")
        payment_row = (
            db.query(Payment, Invoice)
            .join(Invoice, Invoice.id == Payment.invoice_id)
            .filter(Payment.id == target_id)
            .filter(Invoice.tenant_id == user.tenant_id)
            .first()
        )
        if not payment_row:
            raise HTTPException(404, "Paiement introuvable.")
        payment, invoice = payment_row
        target_label = f"Paiement {invoice.number or invoice.id} · {payment.amount} {invoice.currency or 'EUR'}"
    else:
        target_label = "Classé manuellement · à valider en comptabilité"

    rows[index] = {
        **rows[index],
        "status": "to_review" if target_type == "manual" else "matched",
        "target_type": target_type,
        "target_id": target_id,
        "target_label": target_label,
        "note": note,
        "updated_at": now_iso,
    }
    _write_manual_bank_transactions(db, settings_row, rows, features=features)
    return _bank_transaction_out(rows[index])


@router.delete("/bank-transactions/{transaction_id}", response_model=dict[str, int])
def delete_bank_transaction(
    transaction_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_tenant_settings(db, user.tenant_id)
    rows = _read_manual_bank_transactions(settings_row)
    removed_rows = [row for row in rows if row.get("id") == transaction_id]
    features = _tenant_features(settings_row)
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).replace(tzinfo=None).isoformat()
    for row in removed_rows:
        features = _remove_purchase_payments_for_bank_transaction(
            db,
            tenant_id=user.tenant_id,
            transaction_id=str(row.get("id") or transaction_id),
            linked_purchase_id=_linked_purchase_id_from_bank_transaction(row),
            features=features,
            updated_at=now_iso,
        )
    next_rows = [row for row in rows if row.get("id") != transaction_id]
    _write_manual_bank_transactions(db, settings_row, next_rows, features=features)
    return {"deleted": len(rows) - len(next_rows)}


@router.delete("/bank-transactions", response_model=dict[str, int])
def clear_bank_transactions(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    settings_row = _ensure_tenant_settings(db, user.tenant_id)
    rows = _read_manual_bank_transactions(settings_row)
    features = _tenant_features(settings_row)
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).replace(tzinfo=None).isoformat()
    for row in rows:
        features = _remove_purchase_payments_for_bank_transaction(
            db,
            tenant_id=user.tenant_id,
            transaction_id=str(row.get("id") or ""),
            linked_purchase_id=_linked_purchase_id_from_bank_transaction(row),
            features=features,
            updated_at=now_iso,
        )
    _write_manual_bank_transactions(db, settings_row, [], features=features)
    return {"deleted": len(rows)}


def _cash_period(period: str | None, now: datetime) -> CashPeriodOut:
    key = (period or "30").strip().lower()
    if key not in {"today", "7", "30", "month", "90", "all"}:
        key = "30"

    if key == "all":
        return CashPeriodOut(key="all", label="tout l'historique", start_date=None, end_date=now)
    if key == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return CashPeriodOut(key=key, label="aujourd'hui", start_date=start, end_date=now)
    if key == "month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return CashPeriodOut(key=key, label="mois en cours", start_date=start, end_date=now)

    days = 7 if key == "7" else 90 if key == "90" else 30
    start = now - timedelta(days=days)
    return CashPeriodOut(key=key, label=f"{days} derniers jours", start_date=start, end_date=now)


def _apply_period(query, column, period: CashPeriodOut):
    if period.start_date is not None:
        query = query.filter(column >= period.start_date)
    if period.end_date is not None:
        query = query.filter(column <= period.end_date)
    return query


@router.get("/cash-dashboard", response_model=CashDashboardOut)
def cash_dashboard(
    period: str | None = Query(default="30"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    active_period = _cash_period(period, now)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    window_30 = now - timedelta(days=30)
    window_90 = now - timedelta(days=90)
    due_next_window = now + timedelta(days=14)

    receivable_rows = _open_receivable_rows(db, user.tenant_id)
    invoice_ids = [inv.id for inv, _, _ in receivable_rows]
    paid_by = _payments_by_invoice(db, invoice_ids)
    credits_by = _credits_by_invoice(db, invoice_ids)
    latest_email_by = _latest_email_events_by_invoice(
        db,
        tenant_id=user.tenant_id,
        invoice_ids=invoice_ids,
        reminder_at_by_invoice={inv.id: getattr(inv, "last_reminder_at", None) for inv, _, _ in receivable_rows},
    )

    overdue_balance_due = Decimal("0")
    open_balance_due = Decimal("0")
    overdue_count = 0
    due_next_14_days = Decimal("0")
    outstanding_invoices: list[CashOutstandingInvoiceOut] = []
    bucket_map: dict[str, dict[str, Any]] = {
        "current": {"bucket": "current", "label": "À l'heure / à venir", "invoice_count": 0, "amount": Decimal("0")},
        "1_7": {"bucket": "1_7", "label": "Retard 1–7j", "invoice_count": 0, "amount": Decimal("0")},
        "8_30": {"bucket": "8_30", "label": "Retard 8–30j", "invoice_count": 0, "amount": Decimal("0")},
        "31_plus": {"bucket": "31_plus", "label": "Retard 31j+", "invoice_count": 0, "amount": Decimal("0")},
    }

    for inv, customer, tenant in receivable_rows:
        total = _fmt_decimal(inv.total_inc_vat)
        prepaid = invoice_advance_payments_total_ttc(invoice_effective_template_options(db, inv))
        credits = credits_by.get(inv.id, Decimal("0"))
        paid = paid_by.get(inv.id, Decimal("0"))
        balance = total - prepaid - credits - paid
        if balance < 0:
            balance = Decimal("0")
        if balance <= 0:
            continue

        open_balance_due += balance
        due = inv.due_date
        days_overdue = 0
        if due and due < now:
            days_overdue = (now.date() - due.date()).days
            overdue_balance_due += balance
            overdue_count += 1
        if due and now <= due <= due_next_window:
            due_next_14_days += balance

        if days_overdue >= 31:
            bucket_key = "31_plus"
        elif days_overdue >= 8:
            bucket_key = "8_30"
        elif days_overdue >= 1:
            bucket_key = "1_7"
        else:
            bucket_key = "current"
        bucket_map[bucket_key]["invoice_count"] += 1
        bucket_map[bucket_key]["amount"] += balance

        followup_decision = invoice_followup_decision(
            db,
            inv=inv,
            tenant=tenant,
            customer=customer,
            balance_due=balance,
            now=now,
            due_date=inv.due_date,
        )
        outstanding_invoices.append(
            CashOutstandingInvoiceOut(
                invoice_id=inv.id,
                invoice_number=inv.number,
                customer_id=customer.id,
                customer_name=customer.name,
                currency=inv.currency or "EUR",
                due_date=inv.due_date,
                balance_due=balance,
                days_overdue=days_overdue,
                status=inv.status,
                can_followup=followup_decision.can_followup,
                followup_state=followup_decision.followup_state,
                followup_block_reason=followup_decision.followup_block_reason,
                public_path=_public_invoice_path(inv),
                **_email_event_fields(latest_email_by.get(inv.id)),
            )
        )

    outstanding_invoices.sort(
        key=lambda item: (item.days_overdue > 0, item.days_overdue, item.balance_due),
        reverse=True,
    )

    collected_last_30_days = _fmt_decimal(
        db.query(func.coalesce(func.sum(Payment.amount), 0))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Payment.date >= window_30)
        .scalar()
    )
    collected_this_month = _fmt_decimal(
        db.query(func.coalesce(func.sum(Payment.amount), 0))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Payment.date >= month_start)
        .scalar()
    )
    collected_period_query = (
        db.query(func.coalesce(func.sum(Payment.amount), 0))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
    )
    collected_period = _fmt_decimal(_apply_period(collected_period_query, Payment.date, active_period).scalar())
    supplier_paid_period_query = (
        db.query(func.coalesce(func.sum(PurchasePayment.amount), 0))
        .join(InboundInvoice, InboundInvoice.id == PurchasePayment.inbound_invoice_id)
        .filter(PurchasePayment.tenant_id == user.tenant_id)
        .filter(InboundInvoice.tenant_id == user.tenant_id)
    )
    supplier_paid_period = _fmt_decimal(
        _apply_period(supplier_paid_period_query, PurchasePayment.date, active_period).scalar()
    )
    credit_note_refund_period_query = (
        db.query(func.coalesce(func.sum(CreditNoteRefund.amount), 0))
        .join(Invoice, Invoice.id == CreditNoteRefund.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Invoice.type == "credit_note")
    )
    credit_note_refund_period = _fmt_decimal(
        _apply_period(credit_note_refund_period_query, CreditNoteRefund.date, active_period).scalar()
    )
    credit_note_refund_last_30_days = _fmt_decimal(
        db.query(func.coalesce(func.sum(CreditNoteRefund.amount), 0))
        .join(Invoice, Invoice.id == CreditNoteRefund.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Invoice.type == "credit_note")
        .filter(CreditNoteRefund.date >= window_30)
        .scalar()
    )

    delay_rows = (
        db.query(Payment.date, Invoice.issue_date)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Payment.date >= window_90)
        .filter(Invoice.issue_date.isnot(None))
        .all()
    )
    delays = [
        max(0, (payment_date.date() - issue_date.date()).days)
        for payment_date, issue_date in delay_rows
        if payment_date and issue_date
    ]
    average_days_to_pay = round(sum(delays) / len(delays), 1) if delays else None

    invoices_90 = (
        db.query(Invoice.id, Invoice.total_inc_vat)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Invoice.type == "invoice")
        .filter(Invoice.status.notin_(["draft", "canceled"]))
        .filter(Invoice.issue_date >= window_90)
        .all()
    )
    invoice_ids_90 = [invoice_id for invoice_id, _total in invoices_90]
    total_issued_90 = sum((_fmt_decimal(total) for _invoice_id, total in invoices_90), Decimal("0"))
    total_paid_90 = (
        sum(_payments_by_invoice(db, invoice_ids_90).values(), Decimal("0")) if invoice_ids_90 else Decimal("0")
    )
    collection_ratio_last_90_days = None
    if total_issued_90 > 0:
        ratio = (total_paid_90 / total_issued_90) * Decimal("100")
        collection_ratio_last_90_days = round(float(min(ratio, Decimal("100"))), 1)

    method_rows = (
        db.query(
            func.coalesce(Payment.method, "manual").label("method"),
            func.count(Payment.id).label("payment_count"),
            func.coalesce(func.sum(Payment.amount), 0).label("total_amount"),
        )
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Payment.date >= window_90)
        .group_by(func.coalesce(Payment.method, "manual"))
        .order_by(func.coalesce(func.sum(Payment.amount), 0).desc())
        .all()
    )
    payment_methods = [
        CashMethodBreakdownOut(
            method=str(method or "manual"),
            label=_payment_method_label(method),
            payment_count=int(payment_count or 0),
            total_amount=_fmt_decimal(total_amount),
        )
        for method, payment_count, total_amount in method_rows
    ]

    payment_rows_query = (
        db.query(Payment, Invoice, Customer)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .join(Customer, Customer.id == Invoice.customer_id)
        .filter(Invoice.tenant_id == user.tenant_id)
    )
    payment_rows = (
        _apply_period(payment_rows_query, Payment.date, active_period).order_by(Payment.date.desc()).limit(200).all()
    )
    recent_payments: list[ReceivablesRecentPaymentOut] = [
        ReceivablesRecentPaymentOut(
            payment_id=payment.id,
            invoice_id=invoice.id,
            invoice_number=invoice.number,
            customer_id=customer.id,
            customer_name=customer.name,
            amount=_fmt_decimal(payment.amount),
            currency=invoice.currency or "EUR",
            method=payment.method,
            reference=payment.reference,
            settlement_mode=payment.settlement_mode,
            accounting_category=payment.accounting_category,
            receipt_label=payment.receipt_label,
            receipt_url=payment.receipt_url,
            date=payment.date,
        )
        for payment, invoice, customer in payment_rows
    ]
    credit_note_refund_rows_query = (
        db.query(CreditNoteRefund, Invoice, Customer)
        .join(Invoice, Invoice.id == CreditNoteRefund.invoice_id)
        .join(Customer, Customer.id == Invoice.customer_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Invoice.type == "credit_note")
    )
    credit_note_refund_rows = (
        _apply_period(credit_note_refund_rows_query, CreditNoteRefund.date, active_period)
        .order_by(CreditNoteRefund.date.desc())
        .limit(200)
        .all()
    )
    recent_payments.extend(
        ReceivablesRecentPaymentOut(
            payment_id=f"refund-{refund.id}",
            invoice_id=invoice.id,
            invoice_number=invoice.number,
            customer_id=customer.id,
            customer_name=customer.name,
            amount=-abs(_fmt_decimal(refund.amount)),
            currency=invoice.currency or "EUR",
            method=refund.method,
            reference=refund.reference,
            settlement_mode="refund",
            accounting_category=None,
            receipt_label="Remboursement d'avoir",
            receipt_url=None,
            date=refund.date,
        )
        for refund, invoice, customer in credit_note_refund_rows
    )
    recent_payments.sort(key=lambda item: _naive_datetime(item.date) or datetime.min, reverse=True)
    recent_payments = recent_payments[:200]

    due_buckets = [CashDueBucketOut(**bucket_map[key]) for key in ["current", "1_7", "8_30", "31_plus"]]
    purchase_bucket_map: dict[str, dict[str, Any]] = {
        "new": {"state": "new", "label": _PURCHASE_LABELS["new"], "invoice_count": 0, "amount": Decimal("0")},
        "reviewing": {
            "state": "reviewing",
            "label": _PURCHASE_LABELS["reviewing"],
            "invoice_count": 0,
            "amount": Decimal("0"),
        },
        "awaiting_supplier": {
            "state": "awaiting_supplier",
            "label": _PURCHASE_LABELS["awaiting_supplier"],
            "invoice_count": 0,
            "amount": Decimal("0"),
        },
        "approved": {
            "state": "approved",
            "label": _PURCHASE_LABELS["approved"],
            "invoice_count": 0,
            "amount": Decimal("0"),
        },
        "ready_to_pay": {
            "state": "ready_to_pay",
            "label": _PURCHASE_LABELS["ready_to_pay"],
            "invoice_count": 0,
            "amount": Decimal("0"),
        },
        "booked": {"state": "booked", "label": _PURCHASE_LABELS["booked"], "invoice_count": 0, "amount": Decimal("0")},
    }
    purchase_rows = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.tenant_id == user.tenant_id)
        .order_by(InboundInvoice.received_at.desc(), InboundInvoice.created_at.desc())
        .limit(200)
        .all()
    )
    workflow_states = _purchase_workflow_states_for_tenant(db, user.tenant_id)
    supplier_to_review_amount = Decimal("0")
    supplier_ready_to_pay_amount = Decimal("0")
    supplier_planned_outflow = Decimal("0")
    supplier_booked_last_30_days = Decimal("0")
    supplier_documents: list[CashSupplierDocumentOut] = []
    priority_rank = {
        "ready_to_pay": 0,
        "approved": 1,
        "reviewing": 2,
        "new": 3,
        "awaiting_supplier": 4,
        "booked": 5,
    }
    supplier_candidates: list[tuple[int, datetime, Decimal, CashSupplierDocumentOut]] = []

    for purchase in purchase_rows:
        state = _purchase_state_for_cash(purchase, workflow_states)
        amount = _purchase_amount(purchase)
        paid_amount = _purchase_payment_total(db, user.tenant_id, purchase.id)
        if amount > Decimal("0.00") and paid_amount >= amount - Decimal("0.01"):
            state = "booked"
        remaining_amount = max(amount - paid_amount, Decimal("0.00"))
        dashboard_amount = amount if state == "booked" else remaining_amount
        purchase_bucket_map[state]["invoice_count"] += 1
        purchase_bucket_map[state]["amount"] += dashboard_amount

        if state in {"new", "reviewing", "awaiting_supplier"}:
            supplier_to_review_amount += dashboard_amount
        if state in {"approved", "ready_to_pay"}:
            supplier_planned_outflow += dashboard_amount
        if state == "ready_to_pay":
            supplier_ready_to_pay_amount += dashboard_amount

        received_at = _naive_datetime(purchase.received_at) or _naive_datetime(purchase.created_at)
        cash_at = _purchase_cash_datetime(purchase) or received_at
        if state == "booked" and received_at and received_at >= window_30:
            supplier_booked_last_30_days += amount
        if (
            state == "booked"
            and paid_amount <= Decimal("0.00")
            and received_at
            and (active_period.start_date is None or received_at >= active_period.start_date)
            and (active_period.end_date is None or received_at <= active_period.end_date)
        ):
            supplier_paid_period += amount

        if state != "booked":
            if active_period.start_date is not None and cash_at and cash_at < active_period.start_date:
                continue
            if active_period.end_date is not None and cash_at and cash_at > active_period.end_date:
                continue
            supplier_doc = CashSupplierDocumentOut(
                invoice_id=purchase.id,
                invoice_number=purchase.invoice_number,
                supplier_name=purchase.supplier_name,
                currency=purchase.currency or "EUR",
                amount=dashboard_amount,
                received_at=received_at,
                planned_payment_date=purchase.planned_payment_date or purchase.employee_reimbursement_due_date,
                workflow_state=state,
                workflow_label=_PURCHASE_LABELS.get(state, "À qualifier"),
                href=f"/app/purchases/{purchase.id}",
            )
            supplier_candidates.append(
                (
                    priority_rank.get(state, 9),
                    cash_at or now,
                    dashboard_amount,
                    supplier_doc,
                )
            )

    supplier_candidates.sort(key=lambda item: (item[0], -item[1].timestamp(), -float(item[2] or 0)))
    supplier_documents = [item[3] for item in supplier_candidates[:200]]
    paid_outflows_period = supplier_paid_period + credit_note_refund_period
    paid_outflows_last_30_days = supplier_booked_last_30_days + credit_note_refund_last_30_days
    manual_net_next_14_days = due_next_14_days - supplier_planned_outflow
    manual_net_last_30_days = collected_last_30_days - paid_outflows_last_30_days
    manual_net_period = collected_period - paid_outflows_period
    purchase_buckets = [
        CashPurchaseBucketOut(**purchase_bucket_map[key])
        for key in ["ready_to_pay", "approved", "reviewing", "new", "awaiting_supplier", "booked"]
    ]
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == user.tenant_id).first()
    manual_bank_transactions = [_bank_transaction_out(row) for row in _read_manual_bank_transactions(settings_row)]

    return CashDashboardOut(
        mode="manual",
        period=active_period,
        collected_period=collected_period,
        supplier_paid_period=paid_outflows_period,
        manual_net_period=manual_net_period,
        collected_last_30_days=collected_last_30_days,
        collected_this_month=collected_this_month,
        average_days_to_pay=average_days_to_pay,
        collection_ratio_last_90_days=collection_ratio_last_90_days,
        due_next_14_days=due_next_14_days,
        overdue_balance_due=overdue_balance_due,
        open_balance_due=open_balance_due,
        overdue_count=overdue_count,
        supplier_to_review_amount=supplier_to_review_amount,
        supplier_ready_to_pay_amount=supplier_ready_to_pay_amount,
        supplier_planned_outflow=supplier_planned_outflow,
        supplier_booked_last_30_days=paid_outflows_last_30_days,
        purchase_document_count=len(purchase_rows),
        manual_net_next_14_days=manual_net_next_14_days,
        manual_net_last_30_days=manual_net_last_30_days,
        payment_methods=payment_methods,
        due_buckets=due_buckets,
        purchase_buckets=purchase_buckets,
        recent_payments=recent_payments,
        outstanding_invoices=outstanding_invoices[:8],
        supplier_documents=supplier_documents,
        manual_bank_transactions=manual_bank_transactions,
        now=now,
    )


@router.get("/payments-dashboard", response_model=PaymentsDashboardOut)
def payments_dashboard(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    window_30 = now - timedelta(days=30)
    window_90 = now - timedelta(days=90)

    collected_last_30_days = _fmt_decimal(
        db.query(func.coalesce(func.sum(Payment.amount), 0))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Payment.date >= window_30)
        .scalar()
    )
    payments_count_last_30_days = int(
        db.query(func.count(Payment.id))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Payment.date >= window_30)
        .scalar()
        or 0
    )
    missing_reference_count = int(
        db.query(func.count(Payment.id))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(or_(Payment.settlement_mode.is_(None), Payment.settlement_mode != "manual"))
        .filter(or_(Payment.reference.is_(None), Payment.reference == ""))
        .scalar()
        or 0
    )
    missing_method_count = int(
        db.query(func.count(Payment.id))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(or_(Payment.method.is_(None), Payment.method == ""))
        .scalar()
        or 0
    )
    missing_justification_count = int(
        db.query(func.count(Payment.id))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(
            or_(
                Payment.settlement_mode.is_(None),
                Payment.settlement_mode == "",
                Payment.accounting_category.is_(None),
                Payment.accounting_category == "",
            )
        )
        .scalar()
        or 0
    )

    rows = _open_receivable_rows(db, user.tenant_id)
    invoice_ids = [inv.id for inv, _customer, _tenant in rows]
    paid_by = _payments_by_invoice(db, invoice_ids)
    credits_by = _credits_by_invoice(db, invoice_ids)
    payment_meta_rows = (
        db.query(Payment.invoice_id, func.count(Payment.id), func.max(Payment.date))
        .filter(Payment.invoice_id.in_(invoice_ids or ["__none__"]))
        .group_by(Payment.invoice_id)
        .all()
    )
    payment_count_by = {invoice_id: int(count or 0) for invoice_id, count, _last_date in payment_meta_rows}
    payment_last_by = {invoice_id: last_date for invoice_id, _count, last_date in payment_meta_rows}
    latest_email_by = _latest_email_events_by_invoice(
        db,
        tenant_id=user.tenant_id,
        invoice_ids=invoice_ids,
        reminder_at_by_invoice={inv.id: getattr(inv, "last_reminder_at", None) for inv, _customer, _tenant in rows},
    )

    summary = PaymentOpsSummaryOut(
        collected_last_30_days=collected_last_30_days,
        payments_count_last_30_days=payments_count_last_30_days,
        missing_reference_count=missing_reference_count,
        missing_method_count=missing_method_count,
        missing_justification_count=missing_justification_count,
    )
    action_queue: list[PaymentOpsActionOut] = []
    outstanding_by_customer: dict[str, dict[str, Any]] = {}

    for inv, customer, tenant in rows:
        total = _fmt_decimal(inv.total_inc_vat)
        prepaid = invoice_advance_payments_total_ttc(invoice_effective_template_options(db, inv))
        credits = credits_by.get(inv.id, Decimal("0"))
        paid = paid_by.get(inv.id, Decimal("0"))
        balance = total - prepaid - credits - paid
        if balance < 0:
            balance = Decimal("0")
        if balance <= 0:
            continue

        summary.open_invoice_count += 1
        summary.open_balance_due += balance
        if paid > 0:
            summary.partial_invoice_count += 1

        due = inv.due_date
        days_overdue = 0
        if due and due < now:
            days_overdue = (now.date() - due.date()).days
            if not bool(inv.public_enabled):
                summary.overdue_without_public_link_count += 1

        followup_decision = invoice_followup_decision(
            db,
            inv=inv,
            tenant=tenant,
            customer=customer,
            balance_due=balance,
            now=now,
        )

        if days_overdue > 0:
            if not bool(inv.public_enabled):
                next_step = "Activer le lien public"
            elif paid > 0 and balance > 0:
                next_step = "Compléter le règlement"
            elif followup_decision.can_followup:
                next_step = "Relance prête"
            elif followup_decision.followup_block_reason == INVOICE_FOLLOWUP_MISSING_RECIPIENT:
                next_step = "Ajouter un destinataire"
            else:
                next_step = "Relancer ou enregistrer"

            action_queue.append(
                PaymentOpsActionOut(
                    invoice_id=inv.id,
                    invoice_number=inv.number,
                    customer_id=customer.id,
                    customer_name=customer.name,
                    currency=inv.currency or "EUR",
                    status=inv.status,
                    due_date=inv.due_date,
                    balance_due=balance,
                    days_overdue=days_overdue,
                    payment_count=payment_count_by.get(inv.id, 0),
                    last_payment_at=payment_last_by.get(inv.id),
                    public_enabled=bool(inv.public_enabled),
                    public_path=_public_invoice_path(inv),
                    followup_state=followup_decision.followup_state,
                    followup_block_reason=followup_decision.followup_block_reason,
                    can_followup=followup_decision.can_followup,
                    **_email_event_fields(latest_email_by.get(inv.id)),
                    next_step=next_step,
                )
            )

        bucket = outstanding_by_customer.setdefault(
            customer.id,
            {
                "customer_id": customer.id,
                "customer_name": customer.name,
                "outstanding_balance": Decimal("0"),
                "collected_last_90_days": Decimal("0"),
                "payment_count": 0,
                "delay_samples": [],
            },
        )
        bucket["outstanding_balance"] += balance

    recent_rows = (
        db.query(Payment, Invoice, Customer)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .join(Customer, Customer.id == Invoice.customer_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .order_by(Payment.date.desc())
        .limit(12)
        .all()
    )
    recent_payments = [
        ReceivablesRecentPaymentOut(
            payment_id=payment.id,
            invoice_id=invoice.id,
            invoice_number=invoice.number,
            customer_id=customer.id,
            customer_name=customer.name,
            amount=_fmt_decimal(payment.amount),
            currency=invoice.currency or "EUR",
            method=payment.method,
            reference=payment.reference,
            settlement_mode=payment.settlement_mode,
            accounting_category=payment.accounting_category,
            receipt_label=payment.receipt_label,
            receipt_url=payment.receipt_url,
            date=payment.date,
        )
        for payment, invoice, customer in recent_rows
    ]

    quality_rows = (
        db.query(Payment, Invoice, Customer)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .join(Customer, Customer.id == Invoice.customer_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(
            or_(
                and_(
                    or_(Payment.settlement_mode.is_(None), Payment.settlement_mode != "manual"),
                    or_(Payment.reference.is_(None), Payment.reference == ""),
                ),
                Payment.method.is_(None),
                Payment.method == "",
                Payment.settlement_mode.is_(None),
                Payment.settlement_mode == "",
                Payment.accounting_category.is_(None),
                Payment.accounting_category == "",
            )
        )
        .order_by(Payment.date.desc())
        .limit(12)
        .all()
    )
    quality_issues: list[PaymentOpsIssueOut] = []
    for payment, invoice, customer in quality_rows:
        settlement_mode = (payment.settlement_mode or "").strip()
        missing_justification = not bool(settlement_mode)
        missing_category = not bool((payment.accounting_category or "").strip())
        missing_reference = settlement_mode != "manual" and not bool((payment.reference or "").strip())
        missing_method = not bool((payment.method or "").strip())
        if missing_justification:
            state = "missing_justification"
            label = "Justif. à compléter"
        elif missing_category:
            state = "missing_category"
            label = "Catégorie à compléter"
        elif missing_reference and missing_method:
            state = "missing_metadata"
            label = "Mode + réf. manquants"
        elif missing_reference:
            state = "missing_reference"
            label = "Réf. à compléter"
        else:
            state = "missing_method"
            label = "Mode à préciser"
        quality_issues.append(
            PaymentOpsIssueOut(
                payment_id=payment.id,
                invoice_id=invoice.id,
                invoice_number=invoice.number,
                customer_id=customer.id,
                customer_name=customer.name,
                date=payment.date,
                amount=_fmt_decimal(payment.amount),
                currency=invoice.currency or "EUR",
                method=payment.method,
                reference=payment.reference,
                settlement_mode=payment.settlement_mode,
                accounting_category=payment.accounting_category,
                receipt_label=payment.receipt_label,
                receipt_url=payment.receipt_url,
                quality_state=state,
                quality_label=label,
            )
        )

    customer_payment_rows = (
        db.query(Payment, Invoice, Customer)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .join(Customer, Customer.id == Invoice.customer_id)
        .filter(Invoice.tenant_id == user.tenant_id)
        .filter(Payment.date >= window_90)
        .all()
    )
    for payment, invoice, customer in customer_payment_rows:
        bucket = outstanding_by_customer.setdefault(
            customer.id,
            {
                "customer_id": customer.id,
                "customer_name": customer.name,
                "outstanding_balance": Decimal("0"),
                "collected_last_90_days": Decimal("0"),
                "payment_count": 0,
                "delay_samples": [],
            },
        )
        bucket["collected_last_90_days"] += _fmt_decimal(payment.amount)
        bucket["payment_count"] += 1
        if payment.date and invoice.issue_date:
            bucket["delay_samples"].append(max(0, (payment.date.date() - invoice.issue_date.date()).days))

    top_customers = []
    for entry in outstanding_by_customer.values():
        samples = entry.pop("delay_samples", [])
        avg_delay = round(sum(samples) / len(samples), 1) if samples else None
        top_customers.append(
            PaymentOpsCustomerOut(
                customer_id=entry["customer_id"],
                customer_name=entry["customer_name"],
                outstanding_balance=entry["outstanding_balance"],
                collected_last_90_days=entry["collected_last_90_days"],
                payment_count=int(entry["payment_count"] or 0),
                average_days_to_pay=avg_delay,
            )
        )
    top_customers = sorted(
        top_customers,
        key=lambda item: (item.outstanding_balance, item.collected_last_90_days, item.payment_count),
        reverse=True,
    )[:6]
    action_queue = sorted(
        action_queue,
        key=lambda item: (item.days_overdue, item.balance_due, item.payment_count == 0),
        reverse=True,
    )[:10]

    return PaymentsDashboardOut(
        summary=summary,
        recent_payments=recent_payments,
        quality_issues=quality_issues,
        action_queue=action_queue,
        top_customers=top_customers,
        now=now,
    )


@router.get("/receivables.csv")
def export_receivables_csv(
    bucket: str | None = Query(None, description="all|overdue|due_soon|open"),
    q: str | None = Query(None, description="Recherche (client, numéro facture, PO)"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
):
    """Export CSV de la vue recouvrement (safe pour Excel)."""
    payload = list_receivables(bucket=bucket, q=q, limit=_RECEIVABLES_CSV_EXPORT_LIMIT, offset=0, db=db, user=user)
    # FastAPI/Pydantic peut retourner un model; on normalise.
    items = getattr(payload, "items", None) or payload.get("items", [])
    truncated = len(items) >= _RECEIVABLES_CSV_EXPORT_LIMIT
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(
        [
            "invoice_number",
            "customer",
            "status",
            "due_date",
            "total_inc_vat",
            "balance_due",
            "days_overdue",
            "reminder_count",
            "last_reminder_at",
            "next_followup_at",
            "last_email_status",
            "last_email_delivery_mode",
            "last_email_provider",
            "last_email_provider_status",
            "last_email_provider_event_at",
            "last_email_at",
            "last_email_error",
            "public_url",
        ]
    )
    for it in items:
        # it peut être un dict ou un Pydantic model
        get = (lambda k: getattr(it, k, None)) if not isinstance(it, dict) else (lambda k: it.get(k))
        inv_number = _csv_safe(str(get("number") or ""))
        cust = _csv_safe(str(get("customer_name") or ""))
        status = str(get("status") or "")
        due = str(get("due_date") or "")
        total = str(get("total_inc_vat") or "0")
        bal = str(get("balance_due") or "0")
        days = str(get("days_overdue") or "0")
        rc = str(get("reminder_count") or "0")
        last = str(get("last_reminder_at") or "")
        nxt = str(get("next_followup_at") or "")
        email_status = str(get("last_email_status") or "")
        email_mode = str(get("last_email_delivery_mode") or "")
        email_provider = str(get("last_email_provider") or "")
        email_provider_status = str(get("last_email_provider_status") or "")
        email_provider_at = str(get("last_email_provider_event_at") or "")
        email_at = str(get("last_email_at") or "")
        email_error = _csv_safe(str(get("last_email_error") or ""))
        public_path = str(get("public_path") or "")
        w.writerow(
            [
                inv_number,
                cust,
                status,
                due,
                total,
                bal,
                days,
                rc,
                last,
                nxt,
                email_status,
                email_mode,
                email_provider,
                email_provider_status,
                email_provider_at,
                email_at,
                email_error,
                public_path,
            ]
        )

    filename = "recouvrement.csv"
    return Response(
        content=out.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "X-Export-Row-Limit": str(_RECEIVABLES_CSV_EXPORT_LIMIT),
            "X-Export-Truncated": "true" if truncated else "false",
        },
    )
