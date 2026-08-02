from __future__ import annotations

import copy
import csv
import io
import threading
from time import monotonic
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Response
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_accountant_or_admin, require_paid_subscription_or_trial, require_viewer_or_admin
from ..models import (
    Customer,
    EmailEvent,
    InboundInvoice,
    Invoice,
    InvoiceLine,
    Payment,
    Product,
    PurchaseSupplier,
    Quote,
    QuoteLine,
    Tenant,
    TenantSettings,
)
from ..services.sales_assist import suggest_document_defaults
from ..services.invoices.deposits import invoice_vat_effect_for_period
from ..services.product_capabilities import is_product_feature_enabled
from ..utils.money import calc_tax_amount, quantize_amount
from .activity import recent_activity
from .collections import cash_dashboard
from .company import get_profile
from .customers import customer_summary, get_customer, get_customer_portal
from .invoices import get_invoice, get_invoice_share_link
from .invoices import metrics_endpoint
from .ops import (
    _filter_entitled_rows,
    _ops_feature_access,
    _ops_module_allowed,
    action_center,
    _read_tasks,
    _task_out,
    _task_summary,
    _team_lookup,
)
from .ops_alerts import _notifications_payload
from .ops_outbox import _board_payload
from .ops_portfolio import _portfolio_payload, customer_portfolio_detail
from .ops_scheduler import _control_payload
from .quotes import get_quote, get_quote_share_link, quote_timeline
from .workspace import workspace_summary

router = APIRouter(prefix="/api/cockpit", tags=["cockpit"])

VAT_VALIDATION_JOURNAL_KEY = "vat_validation_journal"
VAT_VALIDATION_JOURNAL_LIMIT = 50
COCKPIT_OVERVIEW_CACHE_SECONDS = 5.0
_cockpit_overview_cache_guard = threading.Lock()
_cockpit_overview_cache: dict[tuple[str, str, bool, bool], tuple[float, dict[str, Any]]] = {}
_cockpit_overview_locks: dict[tuple[str, str, bool, bool], threading.Lock] = {}


def _can_manage_customer_portal(user: AuthUser) -> bool:
    role = (user.role or "").strip().lower()
    return bool(user.is_admin or role in {"owner", "admin", "accountant"})


def _customer_portal_status_for_role(customer: Customer, user: AuthUser) -> dict[str, Any]:
    enabled = bool(getattr(customer, "portal_enabled", False))
    payload: dict[str, Any] = {
        "enabled": enabled,
        "view_count": int(getattr(customer, "portal_view_count", 0) or 0),
        "first_viewed_at": getattr(customer, "portal_first_viewed_at", None),
        "last_viewed_at": getattr(customer, "portal_last_viewed_at", None),
        "created_at": getattr(customer, "portal_created_at", None),
    }
    if not _can_manage_customer_portal(user):
        payload["redacted"] = True
    return payload


class VatValidationCreate(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    cabinet_comment: str | None = Field(default=None, max_length=2000)


def _safe_load(name: str, loader: Any, fallback: Any, warnings: list[str]) -> Any:
    try:
        return loader()
    except Exception:
        warnings.append(name)
        return fallback


def _cockpit_overview_cache_get(key: tuple[str, str, bool, bool]) -> dict[str, Any] | None:
    now = monotonic()
    with _cockpit_overview_cache_guard:
        cached = _cockpit_overview_cache.get(key)
        if not cached:
            return None
        expires_at, payload = cached
        if expires_at <= now:
            _cockpit_overview_cache.pop(key, None)
            return None
        return copy.deepcopy(payload)


def _cockpit_overview_cache_set(key: tuple[str, str, bool, bool], payload: dict[str, Any]) -> None:
    with _cockpit_overview_cache_guard:
        _cockpit_overview_cache[key] = (monotonic() + COCKPIT_OVERVIEW_CACHE_SECONDS, copy.deepcopy(payload))
        if len(_cockpit_overview_cache) > 256:
            now = monotonic()
            for stale_key, (expires_at, _) in list(_cockpit_overview_cache.items()):
                if expires_at <= now:
                    _cockpit_overview_cache.pop(stale_key, None)


def _cockpit_overview_lock(key: tuple[str, str, bool, bool]) -> threading.Lock:
    with _cockpit_overview_cache_guard:
        return _cockpit_overview_locks.setdefault(key, threading.Lock())


def _invoice_status_for_access(invoice: Invoice, *, payments_enabled: bool) -> str:
    status = str(invoice.status or "draft").strip().lower() or "draft"
    if payments_enabled or status not in {"paid", "partial", "overdue", "refunded"}:
        return status
    return "sent" if invoice.sent_at else "issued"


def _recent_invoice_docs(
    db: Session,
    tenant_id: str,
    limit: int = 5,
    *,
    payments_enabled: bool = True,
) -> list[dict[str, Any]]:
    rows = (
        db.query(Invoice, Customer)
        .join(Customer, Customer.id == Invoice.customer_id)
        .filter(Invoice.tenant_id == tenant_id, Invoice.type == "invoice")
        .order_by(Invoice.issue_date.desc(), Invoice.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": invoice.id,
            "number": invoice.number,
            "customer_name": customer.name if customer else None,
            "status": _invoice_status_for_access(invoice, payments_enabled=payments_enabled),
            "total_inc_vat": invoice.total_inc_vat,
            "currency": invoice.currency,
            "issue_date": invoice.issue_date,
            "href": f"/app/invoices/{invoice.id}",
        }
        for invoice, customer in rows
    ]


def _recent_quote_docs(db: Session, tenant_id: str, limit: int = 5) -> list[dict[str, Any]]:
    rows = (
        db.query(Quote, Customer)
        .join(Customer, Customer.id == Quote.customer_id)
        .filter(Quote.tenant_id == tenant_id)
        .order_by(Quote.issue_date.desc(), Quote.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": quote.id,
            "number": quote.number,
            "customer_name": customer.name if customer else None,
            "status": quote.status,
            "total_inc_vat": quote.total_inc_vat,
            "currency": quote.currency,
            "issue_date": quote.issue_date,
            "href": f"/app/quotes/{quote.id}",
        }
        for quote, customer in rows
    ]


def _document_seed_customer(customer: Customer | None) -> dict[str, Any] | None:
    if not customer:
        return None
    return {
        "id": customer.id,
        "name": customer.name,
        "email": customer.email,
        "siren": customer.siren,
        "siret": customer.siret,
        "vat_number": customer.vat_number,
    }


def _document_seed_item(product: Product | None) -> dict[str, Any] | None:
    if not product:
        return None
    return {
        "id": product.id,
        "name": product.name,
        "description": product.description,
        "unit_price": float(product.unit_price or 0),
        "vat_rate": float(product.vat_rate or 0),
        "unit_code": product.unit_code,
    }


def _document_seed_from_invoice(
    invoice: Invoice,
    line: InvoiceLine,
    customer: Customer,
    product: Product | None,
) -> dict[str, Any]:
    return {
        "source": "invoice_history",
        "reason": "recent",
        "customer": _document_seed_customer(customer),
        "item": _document_seed_item(product),
        "document": {
            "type": "invoice",
            "id": invoice.id,
            "number": invoice.number,
            "date": invoice.issue_date,
            "line_label": line.product_name,
        },
    }


def _document_seed_from_quote(
    quote: Quote,
    line: QuoteLine,
    customer: Customer,
    product: Product | None,
) -> dict[str, Any]:
    return {
        "source": "quote_history",
        "reason": "recent",
        "customer": _document_seed_customer(customer),
        "item": _document_seed_item(product),
        "document": {
            "type": "quote",
            "id": quote.id,
            "number": quote.number,
            "date": quote.issue_date,
            "line_label": line.product_name,
        },
    }


def _recent_invoice_document_seeds(db: Session, tenant_id: str, limit: int = 8) -> list[dict[str, Any]]:
    rows = (
        db.query(Invoice, InvoiceLine, Customer, Product)
        .join(InvoiceLine, InvoiceLine.invoice_id == Invoice.id)
        .join(Customer, Customer.id == Invoice.customer_id)
        .outerjoin(
            Product,
            and_(
                Product.id == InvoiceLine.item_id,
                Product.tenant_id == tenant_id,
                Product.active.is_(True),
            ),
        )
        .filter(
            Invoice.tenant_id == tenant_id,
            Invoice.type == "invoice",
            InvoiceLine.line_type == "item",
        )
        .order_by(
            Invoice.issue_date.desc().nullslast(),
            Invoice.created_at.desc().nullslast(),
            InvoiceLine.id.asc(),
        )
        .limit(max(1, limit) * 3)
        .all()
    )
    return [_document_seed_from_invoice(invoice, line, customer, product) for invoice, line, customer, product in rows]


def _latest_invoice_document_seed(db: Session, tenant_id: str) -> dict[str, Any] | None:
    seeds = _recent_invoice_document_seeds(db, tenant_id, limit=1)
    return seeds[0] if seeds else None


def _recent_quote_document_seeds(db: Session, tenant_id: str, limit: int = 8) -> list[dict[str, Any]]:
    rows = (
        db.query(Quote, QuoteLine, Customer, Product)
        .join(QuoteLine, QuoteLine.quote_id == Quote.id)
        .join(Customer, Customer.id == Quote.customer_id)
        .outerjoin(
            Product,
            and_(
                Product.id == QuoteLine.item_id,
                Product.tenant_id == tenant_id,
                Product.active.is_(True),
            ),
        )
        .filter(
            Quote.tenant_id == tenant_id,
            QuoteLine.line_type == "item",
        )
        .order_by(
            Quote.issue_date.desc().nullslast(),
            Quote.created_at.desc().nullslast(),
            QuoteLine.id.asc(),
        )
        .limit(max(1, limit) * 3)
        .all()
    )
    return [_document_seed_from_quote(quote, line, customer, product) for quote, line, customer, product in rows]


def _latest_quote_document_seed(db: Session, tenant_id: str) -> dict[str, Any] | None:
    seeds = _recent_quote_document_seeds(db, tenant_id, limit=1)
    return seeds[0] if seeds else None


def _document_seed_sort_value(seed: dict[str, Any]) -> datetime:
    document = seed.get("document") if isinstance(seed.get("document"), dict) else {}
    value = document.get("date") if isinstance(document, dict) else None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    return datetime.min


def _document_seed_suggestions(db: Session, tenant_id: str, limit: int = 4) -> list[dict[str, Any]]:
    candidates = [
        *_recent_invoice_document_seeds(db, tenant_id, limit=max(20, limit * 10)),
        *_recent_quote_document_seeds(db, tenant_id, limit=max(20, limit * 10)),
    ]
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for seed in candidates:
        customer = seed.get("customer") if isinstance(seed.get("customer"), dict) else None
        item = seed.get("item") if isinstance(seed.get("item"), dict) else None
        customer_id = str(customer.get("id") or "") if customer else ""
        item_id = str(item.get("id") or "") if item else ""
        if not customer_id or not item_id:
            continue
        key = (customer_id, item_id)
        used_at = _document_seed_sort_value(seed)
        entry = grouped.get(key)
        if not entry:
            grouped[key] = {
                "seed": seed,
                "usage_count": 1,
                "last_used_at": used_at,
            }
            continue
        entry["usage_count"] += 1
        if used_at > entry["last_used_at"]:
            entry["seed"] = seed
            entry["last_used_at"] = used_at

    ranked = sorted(
        grouped.values(),
        key=lambda entry: (int(entry["usage_count"]), entry["last_used_at"]),
        reverse=True,
    )
    suggestions: list[dict[str, Any]] = []
    for entry in ranked[:limit]:
        seed = dict(entry["seed"])
        usage_count = int(entry["usage_count"])
        seed["reason"] = "favorite" if usage_count > 1 else "recent"
        seed["usage_count"] = usage_count
        seed["last_used_at"] = entry["last_used_at"]
        suggestions.append(seed)
    return suggestions


def _fallback_document_seed(db: Session, tenant_id: str) -> dict[str, Any]:
    customer = (
        db.query(Customer)
        .filter(Customer.tenant_id == tenant_id)
        .order_by(Customer.created_at.desc().nullslast())
        .first()
    )
    product = (
        db.query(Product)
        .filter(Product.tenant_id == tenant_id, Product.active.is_(True))
        .order_by(Product.created_at.desc().nullslast())
        .first()
    )
    return {
        "source": "fallback",
        "customer": _document_seed_customer(customer),
        "item": _document_seed_item(product),
        "document": None,
    }


def _recent_customer_invoices(
    db: Session,
    tenant_id: str,
    customer_id: str,
    limit: int = 5,
    *,
    payments_enabled: bool = True,
) -> list[dict[str, Any]]:
    rows = (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == tenant_id,
            Invoice.customer_id == customer_id,
            Invoice.type == "invoice",
        )
        .order_by(Invoice.issue_date.desc(), Invoice.created_at.desc())
        .limit(limit)
        .all()
    )
    payload: list[dict[str, Any]] = []
    for row in rows:
        item = {
            "id": row.id,
            "number": row.number,
            "type": row.type,
            "invoice_kind": row.invoice_kind,
            "status": _invoice_status_for_access(row, payments_enabled=payments_enabled),
            "currency": row.currency,
            "total_ex_vat": row.total_ex_vat,
            "total_vat": row.total_vat,
            "total_inc_vat": row.total_inc_vat,
            "issue_date": row.issue_date,
            "due_date": row.due_date,
            "href": f"/app/invoices/{row.id}",
        }
        if payments_enabled:
            item.update(
                {
                    "paid_at": row.paid_at,
                    "reminder_count": int(row.reminder_count or 0),
                    "last_reminder_at": row.last_reminder_at,
                }
            )
        payload.append(item)
    return payload


def _recent_customer_quotes(db: Session, tenant_id: str, customer_id: str, limit: int = 5) -> list[dict[str, Any]]:
    rows = (
        db.query(Quote)
        .filter(Quote.tenant_id == tenant_id, Quote.customer_id == customer_id)
        .order_by(Quote.issue_date.desc(), Quote.created_at.desc())
        .limit(limit)
        .all()
    )
    return [jsonable_encoder(row) for row in rows]


def _dump_model(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "dict"):
        return value.dict()
    return jsonable_encoder(value)


def _decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _money_float(value: Decimal | int | float | None) -> float:
    return float((_decimal(value)).quantize(Decimal("0.01")))


DASHBOARD_PERIODS = ("weekly", "monthly", "quarterly", "semester")
DASHBOARD_INVOICE_FLOW_STATUSES = {"issued", "sent", "partial", "paid", "overdue", "pending"}
DASHBOARD_QUOTE_FLOW_EXCLUDED_STATUSES = {"rejected", "expired", "canceled"}


def _start_of_week(value: datetime) -> datetime:
    start = datetime(value.year, value.month, value.day)
    return start - timedelta(days=start.isoweekday() - 1)


def _dashboard_month_label(value: datetime) -> str:
    labels = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"]
    return labels[value.month - 1]


def _dashboard_period_key(value: datetime, period: str) -> str:
    if period == "weekly":
        iso = value.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    if period == "quarterly":
        return f"{value.year}-Q{((value.month - 1) // 3) + 1}"
    if period == "semester":
        return f"{value.year}-S{1 if value.month <= 6 else 2}"
    return f"{value.year}-{value.month:02d}"


def _dashboard_period_label(value: datetime, period: str) -> str:
    if period == "weekly":
        return f"S{value.isocalendar().week}"
    short_year = str(value.year)[-2:]
    if period == "quarterly":
        return f"T{((value.month - 1) // 3) + 1} {short_year}"
    if period == "semester":
        return f"S{1 if value.month <= 6 else 2} {short_year}"
    return _dashboard_month_label(value)


def _dashboard_period_bucket_starts(period: str, now: datetime) -> list[datetime]:
    count = 8 if period == "weekly" else 6 if period == "monthly" else 4
    if period == "weekly":
        current = _start_of_week(now)
        return [current - timedelta(days=7 * offset) for offset in range(count - 1, -1, -1)]
    if period == "quarterly":
        quarter_start_month = ((now.month - 1) // 3) * 3 + 1
        starts = []
        for offset in range(count - 1, -1, -1):
            raw_month = quarter_start_month - 3 * offset
            starts.append(datetime(now.year + ((raw_month - 1) // 12), ((raw_month - 1) % 12) + 1, 1))
        return starts
    if period == "semester":
        semester_start_month = 1 if now.month <= 6 else 7
        starts = []
        for offset in range(count - 1, -1, -1):
            raw_month = semester_start_month - 6 * offset
            starts.append(datetime(now.year + ((raw_month - 1) // 12), ((raw_month - 1) % 12) + 1, 1))
        return starts
    return [
        datetime(now.year + ((now.month - offset - 1) // 12), ((now.month - offset - 1) % 12) + 1, 1)
        for offset in range(count - 1, -1, -1)
    ]


def _dashboard_period_buckets(now: datetime) -> dict[str, list[dict[str, Any]]]:
    payload: dict[str, list[dict[str, Any]]] = {}
    for period in DASHBOARD_PERIODS:
        payload[period] = [
            {
                "key": _dashboard_period_key(start, period),
                "label": _dashboard_period_label(start, period),
                "start": start,
                "factures": 0.0,
                "devis": 0.0,
                "encaissements": 0.0,
            }
            for start in _dashboard_period_bucket_starts(period, now)
        ]
    return payload


def _dashboard_add_amount(
    buckets_by_period: dict[str, list[dict[str, Any]]],
    maps_by_period: dict[str, dict[str, dict[str, Any]]],
    value_date: datetime | date | None,
    field: str,
    amount: Decimal | int | float | None,
) -> None:
    if not value_date:
        return
    if isinstance(value_date, date) and not isinstance(value_date, datetime):
        dt = datetime.combine(value_date, datetime.min.time())
    else:
        dt = value_date
    for period in buckets_by_period:
        bucket = maps_by_period[period].get(_dashboard_period_key(dt, period))
        if bucket is not None:
            bucket[field] = _money_float(_decimal(bucket.get(field)) + _decimal(amount))


def _dashboard_period_series(
    db: Session,
    tenant_id: str,
    now: datetime,
    *,
    payments_enabled: bool,
) -> dict[str, list[dict[str, Any]]]:
    buckets_by_period = _dashboard_period_buckets(now)
    maps_by_period = {
        period: {str(bucket["key"]): bucket for bucket in buckets}
        for period, buckets in buckets_by_period.items()
    }
    window_start = min(bucket["start"] for buckets in buckets_by_period.values() for bucket in buckets)

    invoice_rows = (
        db.query(Invoice.issue_date, Invoice.total_inc_vat)
        .filter(
            Invoice.tenant_id == tenant_id,
            Invoice.type == "invoice",
            Invoice.status.in_(DASHBOARD_INVOICE_FLOW_STATUSES),
            Invoice.issue_date >= window_start,
        )
        .all()
    )
    quote_rows = (
        db.query(Quote.issue_date, Quote.total_inc_vat)
        .filter(
            Quote.tenant_id == tenant_id,
            ~Quote.status.in_(DASHBOARD_QUOTE_FLOW_EXCLUDED_STATUSES),
            Quote.issue_date >= window_start,
        )
        .all()
    )
    payment_rows = []
    if payments_enabled:
        payment_rows = (
            db.query(Payment.date, Payment.amount)
            .join(Invoice, Invoice.id == Payment.invoice_id)
            .filter(
                Invoice.tenant_id == tenant_id,
                Invoice.type == "invoice",
                Payment.date >= window_start,
            )
            .all()
        )

    for issued_at, total in invoice_rows:
        _dashboard_add_amount(buckets_by_period, maps_by_period, issued_at, "factures", total)
    for issued_at, total in quote_rows:
        _dashboard_add_amount(buckets_by_period, maps_by_period, issued_at, "devis", total)
    for paid_at, amount in payment_rows:
        _dashboard_add_amount(buckets_by_period, maps_by_period, paid_at, "encaissements", amount)

    return {
        period: [
            {key: value for key, value in bucket.items() if key != "start"}
            for bucket in buckets
        ]
        for period, buckets in buckets_by_period.items()
    }


def _dashboard_invoice_status(
    db: Session,
    tenant_id: str,
    *,
    payments_enabled: bool,
) -> dict[str, Any]:
    status_rows = (
        db.query(Invoice.status, func.count(Invoice.id))
        .filter(Invoice.tenant_id == tenant_id, Invoice.type == "invoice")
        .group_by(Invoice.status)
        .all()
    )
    stored_counts = {str(status or "unknown").lower(): int(count or 0) for status, count in status_rows}
    counts = dict(stored_counts)
    if not payments_enabled:
        retained_payment_states = sum(
            int(counts.pop(key, 0) or 0)
            for key in ("paid", "partial", "overdue", "refunded")
        )
        if retained_payment_states:
            counts["issued"] = int(counts.get("issued", 0) or 0) + retained_payment_states
    draft = counts.get("draft", 0)
    issued = counts.get("issued", 0) + counts.get("sent", 0)
    paid = counts.get("paid", 0) + counts.get("partial", 0) if payments_enabled else 0
    overdue = counts.get("overdue", 0) if payments_enabled else 0
    known = draft + issued + paid + overdue
    total = sum(counts.values())
    rows = [
        {"key": "draft", "name": "Brouillons", "value": draft, "color": "#94a3b8"},
        {"key": "issued", "name": "Émises", "value": issued, "color": "#2563eb"},
        {"key": "paid", "name": "Payées", "value": paid, "color": "#16a34a"},
        {"key": "overdue", "name": "En retard", "value": overdue, "color": "#ef4444"},
    ]
    if total > known:
        rows.append({"key": "other", "name": "Autres", "value": total - known, "color": "#f59e0b"})
    return {
        "total": total,
        "raw": counts,
        "rows": [row for row in rows if int(row["value"]) > 0],
    }


def _dashboard_accepted_quotes(db: Session, tenant_id: str) -> dict[str, Any]:
    rows = (
        db.query(Quote.id, Quote.total_inc_vat)
        .filter(
            Quote.tenant_id == tenant_id,
            Quote.status == "accepted",
            Quote.invoice_id.is_(None),
        )
        .all()
    )
    count = len(rows)
    if not rows:
        return {"count": 0, "amount": 0.0, "truncated": False}

    stored_amounts = {quote_id: quantize_amount(total or 0) for quote_id, total in rows}
    line_amounts: dict[str, Decimal] = {}
    line_counts: dict[str, int] = {}
    quote_ids = list(stored_amounts)
    for quote_id, line_total, vat_rate in (
        db.query(QuoteLine.quote_id, QuoteLine.line_total, QuoteLine.vat_rate)
        .filter(QuoteLine.quote_id.in_(quote_ids), QuoteLine.line_type == "item")
        .all()
    ):
        ht = quantize_amount(line_total or 0)
        line_amounts[quote_id] = line_amounts.get(quote_id, Decimal("0")) + ht + calc_tax_amount(ht, vat_rate or 0)
        line_counts[quote_id] = line_counts.get(quote_id, 0) + 1

    amount = Decimal("0")
    for quote_id, stored_amount in stored_amounts.items():
        amount += quantize_amount(line_amounts.get(quote_id, stored_amount) if line_counts.get(quote_id) else stored_amount)
    return {"count": count, "amount": _money_float(amount), "truncated": False}


def _clean_digits(value: str | None) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _normalize_reference_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _normalize_purchase_nature(value: str | None) -> str | None:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return None
    aliases = {"produit": "product", "products": "product", "service": "service", "services": "service"}
    normalized = aliases.get(normalized, normalized)
    return normalized if normalized in {"product", "service"} else None


def _purchase_supplier_reference(db: Session, tenant_id: str, row: InboundInvoice) -> PurchaseSupplier | None:
    clean_siret = _clean_digits(row.supplier_siret)
    clean_siren = _clean_digits(row.supplier_siren)
    normalized_name = _normalize_reference_name(row.supplier_name)
    base_filters = [PurchaseSupplier.tenant_id == tenant_id, PurchaseSupplier.is_active.is_(True)]
    if clean_siret:
        ref = db.query(PurchaseSupplier).filter(*base_filters, PurchaseSupplier.siret == clean_siret).first()
        if ref:
            return ref
    if clean_siren:
        ref = db.query(PurchaseSupplier).filter(*base_filters, PurchaseSupplier.siren == clean_siren).first()
        if ref:
            return ref
    if normalized_name:
        return db.query(PurchaseSupplier).filter(*base_filters, PurchaseSupplier.normalized_name == normalized_name).first()
    return None


def _purchase_supplier_vat_rule_match(
    supplier: PurchaseSupplier,
    *,
    accounting_account: str | None,
    purchase_nature: str | None,
) -> tuple[Decimal | None, dict[str, Any] | None]:
    account = str(accounting_account or "").strip()
    nature = _normalize_purchase_nature(purchase_nature)
    best_rate: Decimal | None = None
    best_rule: dict[str, Any] | None = None
    best_score = -1
    for raw in supplier.vat_rules or []:
        if not isinstance(raw, dict):
            continue
        rule_account = str(raw.get("accounting_account") or "").strip()
        rule_nature = _normalize_purchase_nature(raw.get("purchase_nature"))
        if not rule_account and not rule_nature:
            continue
        if rule_account and rule_account != account:
            continue
        if rule_nature and rule_nature != nature:
            continue
        raw_rate = raw.get("vat_rate")
        if raw_rate is None:
            continue
        rate = _decimal(raw_rate).quantize(Decimal("0.01"))
        if rate < 0 or rate > 100:
            continue
        score = (2 if rule_account else 0) + (1 if rule_nature else 0)
        if score > best_score:
            best_score = score
            best_rate = rate
            best_rule = {
                "accounting_account": rule_account,
                "purchase_nature": rule_nature,
                "vat_rate": float(rate),
            }
    return best_rate, best_rule


def _purchase_supplier_vat_rate(db: Session, tenant_id: str, row: InboundInvoice) -> tuple[Decimal | None, str | None, dict[str, Any] | None]:
    ref = _purchase_supplier_reference(db, tenant_id, row)
    if not ref:
        return None, None, None
    rule_rate, rule = _purchase_supplier_vat_rule_match(
        ref,
        accounting_account=row.accounting_account,
        purchase_nature=row.purchase_nature,
    )
    if rule_rate is not None:
        return rule_rate, "supplier_exception", rule
    if ref.default_vat_rate is None:
        return None, None, None
    return _decimal(ref.default_vat_rate).quantize(Decimal("0.01")), "supplier_rule", None


def _month_bounds(today: date | None = None) -> tuple[date, date]:
    current = today or datetime.now(timezone.utc).date()
    start = current.replace(day=1)
    if start.month == 12:
        end = date(start.year + 1, 1, 1) - timedelta(days=1)
    else:
        end = date(start.year, start.month + 1, 1) - timedelta(days=1)
    return start, end


def _date_range(start_date: date | None, end_date: date | None) -> tuple[date, date, datetime, datetime]:
    default_start, default_end = _month_bounds()
    start = start_date or default_start
    end = end_date or default_end
    if end < start:
        start, end = end, start
    start_dt = datetime.combine(start, datetime.min.time())
    end_exclusive = datetime.combine(end + timedelta(days=1), datetime.min.time())
    return start, end, start_dt, end_exclusive


def _document_date(value: date | datetime | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    return value.isoformat()


def _vat_purchase_exclusion_reason(row: InboundInvoice) -> str | None:
    completion_status = str(row.completion_status or "").lower()
    status = str(row.status or "").lower()
    validation_status = str(row.validation_status or "").lower()
    if completion_status != "completed":
        return "Achat incomplet"
    if status in {"rejected", "duplicate", "canceled"}:
        return "Achat rejeté, doublon ou annulé"
    if validation_status in {"invalid", "failed"}:
        return "Validation invalide"
    if _decimal(row.total_vat) <= 0:
        return "TVA non renseignée ou nulle"
    return None


def _vat_csv_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "oui" if value else "non"
    if isinstance(value, (int, float, Decimal)):
        return value
    text = str(value)
    first_meaningful = text.lstrip(" \t\r\n\ufeff")
    if first_meaningful and first_meaningful[0] in {"=", "+", "-", "@"}:
        return f"'{text}"
    return text


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean_vat_validation_comment(value: str | None) -> str | None:
    cleaned = str(value or "").strip()
    return cleaned[:2000] or None


def _get_or_create_tenant_settings(db: Session, tenant_id: str) -> TenantSettings:
    settings = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if settings:
        return settings
    settings = TenantSettings(tenant_id=tenant_id)
    db.add(settings)
    db.flush()
    return settings


def _vat_validation_journal(settings: TenantSettings | None) -> list[dict[str, Any]]:
    features = settings.features if settings and isinstance(settings.features, dict) else {}
    raw_items = features.get(VAT_VALIDATION_JOURNAL_KEY)
    if not isinstance(raw_items, list):
        return []
    return [item for item in raw_items if isinstance(item, dict)]


def _latest_vat_validation_for_period(
    db: Session,
    *,
    tenant_id: str,
    start: date,
    end: date,
) -> dict[str, Any] | None:
    settings = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    start_iso = start.isoformat()
    end_iso = end.isoformat()
    for item in _vat_validation_journal(settings):
        if item.get("start_date") == start_iso and item.get("end_date") == end_iso:
            return item
    return None


def _vat_validation_item_from_summary(
    summary: dict[str, Any],
    *,
    user: AuthUser,
    comment: str | None,
) -> dict[str, Any]:
    period = summary.get("period") if isinstance(summary.get("period"), dict) else {}
    documents = summary.get("documents") if isinstance(summary.get("documents"), dict) else {}
    collected = summary.get("collected") if isinstance(summary.get("collected"), dict) else {}
    deductible = summary.get("deductible") if isinstance(summary.get("deductible"), dict) else {}
    anomalies = summary.get("anomalies") if isinstance(summary.get("anomalies"), list) else []
    anomaly_items = summary.get("anomaly_items") if isinstance(summary.get("anomaly_items"), list) else []
    return {
        "id": str(uuid4()),
        "status": "validated",
        "start_date": period.get("start_date"),
        "end_date": period.get("end_date"),
        "validated_at": _utcnow().isoformat(),
        "validated_by": user.id,
        "validated_by_email": getattr(user, "email", None),
        "cabinet_comment": _clean_vat_validation_comment(comment) or "",
        "collected_vat": summary.get("collected", {}).get("vat") if isinstance(summary.get("collected"), dict) else 0,
        "deductible_vat": summary.get("deductible", {}).get("vat") if isinstance(summary.get("deductible"), dict) else 0,
        "net_vat": summary.get("net_vat"),
        "collected_document_count": collected.get("document_count") or 0,
        "deductible_document_count": deductible.get("document_count") or 0,
        "documents_total_count": documents.get("total_count") or 0,
        "documents_included_count": documents.get("included_count") or 0,
        "documents_excluded_count": documents.get("excluded_count") or 0,
        "anomaly_count": len(anomalies),
        "anomaly_item_count": len(anomaly_items),
        "notice": "Revue de pilotage TVA, hors télédeclaration.",
    }


def _store_vat_validation(
    db: Session,
    *,
    tenant_id: str,
    item: dict[str, Any],
) -> list[dict[str, Any]]:
    settings = _get_or_create_tenant_settings(db, tenant_id)
    features = dict(settings.features or {})
    previous = _vat_validation_journal(settings)
    filtered = [
        row
        for row in previous
        if not (row.get("start_date") == item.get("start_date") and row.get("end_date") == item.get("end_date"))
    ]
    journal = [item, *filtered][:VAT_VALIDATION_JOURNAL_LIMIT]
    features[VAT_VALIDATION_JOURNAL_KEY] = journal
    settings.features = features
    settings.updated_at = _utcnow()
    db.add(settings)
    db.commit()
    return journal


def _focus(
    tone: str,
    label: str,
    title: str,
    description: str,
    href: str,
    cta: str,
) -> dict[str, str]:
    return {
        "tone": tone,
        "label": label,
        "title": title,
        "description": description,
        "href": href,
        "cta": cta,
    }


def _vat_action(label: str, href: str, description: str) -> dict[str, str]:
    return {"label": label, "href": href, "description": description}


def _vat_purchase_missing_fields(row: InboundInvoice) -> list[str]:
    missing: list[str] = []
    if not (row.supplier_name or "").strip():
        missing.append("supplier_name")
    if not (row.invoice_number or "").strip():
        missing.append("invoice_number")
    if not row.issue_date:
        missing.append("issue_date")
    if not row.total_ttc or _decimal(row.total_ttc) <= 0:
        missing.append("total_ttc")
    return missing


def _vat_rate_candidates(total_ttc: Decimal, preferred_rate: Decimal | None = None) -> list[dict[str, float]]:
    candidates: list[dict[str, float]] = []
    if total_ttc <= 0:
        return candidates
    rates: list[Decimal] = []
    if preferred_rate is not None:
        rates.append(preferred_rate.quantize(Decimal("0.01")))
    for raw_rate in (Decimal("20"), Decimal("10"), Decimal("5.5"), Decimal("2.1")):
        normalized_rate = raw_rate.quantize(Decimal("0.01"))
        if normalized_rate not in rates:
            rates.append(normalized_rate)
    for raw_rate in rates:
        total_ex_vat = total_ttc / (Decimal("1") + raw_rate / Decimal("100"))
        total_vat = total_ttc - total_ex_vat
        candidates.append(
            {
                "vat_rate": float(raw_rate),
                "total_ex_vat": _money_float(total_ex_vat),
                "total_vat": _money_float(total_vat),
                "total_ttc": _money_float(total_ttc),
            }
        )
    return candidates


def _vat_purchase_suggestion(db: Session, tenant_id: str, row: InboundInvoice, code: str) -> dict[str, Any] | None:
    total_ex_vat = _decimal(row.total_ex_vat)
    total_vat = _decimal(row.total_vat)
    total_ttc = _decimal(row.total_ttc)
    if code == "purchase_incomplete":
        return {
            "kind": "complete_purchase",
            "message": "Compléter les champs obligatoires puis valider l'achat avant de retenir la TVA.",
            "missing_fields": _vat_purchase_missing_fields(row),
            "suggested_patch": {},
            "requires_cabinet_review": False,
        }
    if code == "purchase_totals_inconsistent":
        return {
            "kind": "fix_purchase_totals",
            "message": "Aligner les totaux achat avant validation TVA.",
            "suggested_patch": {"total_ttc": _money_float(total_ex_vat + total_vat)},
            "requires_cabinet_review": True,
        }
    if code == "purchase_vat_missing":
        suggestion: dict[str, Any] = {
            "kind": "add_purchase_vat",
            "message": "Renseigner la TVA déductible ou confirmer une exonération avec le cabinet.",
            "suggested_patch": {},
            "rate_candidates": _vat_rate_candidates(total_ttc),
            "requires_cabinet_review": True,
        }
        supplier_rate, supplier_rate_source, supplier_rule = _purchase_supplier_vat_rate(db, tenant_id, row)
        if supplier_rate is not None:
            suggestion["supplier_rule"] = {"vat_rate": float(supplier_rate), "source": supplier_rate_source}
            if supplier_rule:
                suggestion["supplier_rule"]["rule"] = supplier_rule
            suggestion["rate_candidates"] = _vat_rate_candidates(total_ttc, supplier_rate)
            suggestion["message"] = (
                "Appliquer l'exception TVA du fournisseur ou confirmer une exonération avec le cabinet."
                if supplier_rate_source == "supplier_exception"
                else "Appliquer la règle TVA du fournisseur ou confirmer une exonération avec le cabinet."
            )
            suggested_ht = total_ttc / (Decimal("1") + supplier_rate / Decimal("100"))
            suggested_vat = total_ttc - suggested_ht
            suggestion["suggested_patch"] = {
                "total_ex_vat": _money_float(suggested_ht),
                "total_vat": _money_float(suggested_vat),
                "vat_rate": float(supplier_rate),
            }
        elif total_ex_vat > 0 and total_ttc > total_ex_vat:
            suggested_vat = total_ttc - total_ex_vat
            suggestion["suggested_patch"] = {
                "total_vat": _money_float(suggested_vat),
                "vat_rate": _money_float((suggested_vat / total_ex_vat) * Decimal("100")),
            }
        return suggestion
    if code == "purchase_excluded":
        return {
            "kind": "review_purchase_status",
            "message": "Contrôler le statut achat ou la validation fournisseur avant reprise TVA.",
            "suggested_patch": {},
            "requires_cabinet_review": True,
        }
    return None


def _vat_anomaly_action(code: str) -> dict[str, str] | None:
    actions = {
        "seller_vat_number_missing": _vat_action(
            "Renseigner la TVA",
            "/app/company",
            "Ajoutez le numéro de TVA ou le motif d'exonération dans le dossier entreprise.",
        ),
        "purchase_vat_missing": _vat_action(
            "Corriger les achats",
            "/app/purchases?filter=vat_corrections",
            "Ouvrez les achats concernés et renseignez la TVA déductible ou l'exonération.",
        ),
        "purchase_incomplete": _vat_action(
            "Compléter les achats",
            "/app/purchases?filter=vat_corrections",
            "Complétez fournisseur, date, totaux et TVA avant de retenir ces achats.",
        ),
        "purchase_totals_inconsistent": _vat_action(
            "Vérifier les totaux",
            "/app/purchases?filter=vat_corrections",
            "Corrigez les lignes dont HT + TVA ne correspond pas au TTC.",
        ),
        "credit_notes": _vat_action(
            "Voir les avoirs",
            "/app/invoices?filter=vat_corrections",
            "Vérifiez que les avoirs déduits correspondent aux factures d'origine.",
        ),
        "mixed_currency": _vat_action(
            "Contrôler les devises",
            "/app/invoices?filter=vat_corrections",
            "Vérifiez les documents en devise avec le cabinet avant déclaration.",
        ),
    }
    return actions.get(code)


def _vat_purchase_action(row: InboundInvoice, *, included: bool, inconsistent: bool) -> dict[str, str] | None:
    href = f"/app/purchases/{row.id}"
    if str(row.completion_status or "").lower() != "completed":
        return _vat_action("Compléter", href, "Renseignez les champs manquants pour rendre la TVA déductible.")
    if inconsistent:
        return _vat_action("Corriger les totaux", href, "Ajustez HT, TVA ou TTC pour retrouver une somme cohérente.")
    if _decimal(row.total_ttc) > 0 and _decimal(row.total_vat) <= 0 and not bool(row.completion_validated_at):
        return _vat_action("Ajouter la TVA", href, "Indiquez la TVA déductible ou confirmez une exonération.")
    if _decimal(row.total_ttc) > 0 and _decimal(row.total_vat) <= 0 and bool(row.completion_validated_at):
        return None
    if not included:
        return _vat_action("Vérifier", href, "Contrôlez le statut ou la validation de cet achat.")
    return None


def _vat_anomaly_item(
    *,
    code: str,
    severity: str,
    message: str,
    correction_href: str,
    action_label: str,
    direction: str,
    kind: str,
    field: str,
    document_id: str | None = None,
    number: str | None = None,
    party: str | None = None,
    current_value: Any = None,
    correction_endpoint: str | None = None,
    suggestion: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "code": code,
        "severity": severity,
        "document_id": document_id,
        "direction": direction,
        "kind": kind,
        "number": number,
        "party": party,
        "field": field,
        "current_value": current_value,
        "message": message,
        "correction_href": correction_href,
        "correction_endpoint": correction_endpoint,
        "action_label": action_label,
        "suggestion": suggestion,
    }


@router.get("/vat")
def cockpit_vat(
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    include_documents: bool = Query(False),
    document_limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    return _build_cockpit_vat_payload(
        db,
        user,
        start_date=start_date,
        end_date=end_date,
        include_documents=include_documents,
        document_limit=document_limit,
    )


@router.post("/vat/validations")
def validate_cockpit_vat_period(
    payload: VatValidationCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    purchases_enabled, payments_enabled = _ops_feature_access(db, user)
    start, end, _, _ = _date_range(payload.start_date, payload.end_date)
    summary = _build_cockpit_vat_payload(
        db,
        user,
        start_date=start,
        end_date=end,
        include_documents=True,
        document_limit=10000,
    )
    item = _vat_validation_item_from_summary(
        summary,
        user=user,
        comment=payload.cabinet_comment,
    )
    journal = _store_vat_validation(db, tenant_id=user.tenant_id, item=item)
    visible_journal = journal[:10] if purchases_enabled and payments_enabled else [item]
    return {"latest_validation": item, "items": visible_journal}


@router.get("/vat/export.csv")
def cockpit_vat_export_csv(
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    payload = _build_cockpit_vat_payload(
        db,
        user,
        start_date=start_date,
        end_date=end_date,
        include_documents=True,
        document_limit=10000,
    )
    output = io.StringIO(newline="")
    fieldnames = [
        "sens",
        "type",
        "inclus",
        "raison",
        "date",
        "numero",
        "tiers",
        "statut",
        "devise",
        "total_ht",
        "tva",
        "total_ttc",
        "montant_paye",
        "effet_tva",
        "lien",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in payload.get("documents", {}).get("rows", []):
        writer.writerow(
            {
                "sens": _vat_csv_cell(row.get("direction")),
                "type": _vat_csv_cell(row.get("kind")),
                "inclus": _vat_csv_cell(row.get("included")),
                "raison": _vat_csv_cell(row.get("reason")),
                "date": _vat_csv_cell(row.get("date")),
                "numero": _vat_csv_cell(row.get("number")),
                "tiers": _vat_csv_cell(row.get("party")),
                "statut": _vat_csv_cell(row.get("status")),
                "devise": _vat_csv_cell(row.get("currency")),
                "total_ht": _vat_csv_cell(row.get("total_ex_vat")),
                "tva": _vat_csv_cell(row.get("total_vat")),
                "total_ttc": _vat_csv_cell(row.get("total_inc_vat")),
                "montant_paye": _vat_csv_cell(row.get("amount_paid")),
                "effet_tva": _vat_csv_cell(row.get("vat_effect")),
                "lien": _vat_csv_cell(row.get("href")),
            }
        )
    period = payload.get("period", {})
    filename = f"justificatif_tva_{period.get('start_date', 'debut')}_{period.get('end_date', 'fin')}.csv"
    return Response(
        content=f"\ufeff{output.getvalue()}",
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _build_cockpit_vat_payload(
    db: Session,
    user: AuthUser,
    *,
    start_date: date | None,
    end_date: date | None,
    include_documents: bool = False,
    document_limit: int = 50,
) -> dict[str, Any]:
    tenant = db.get(Tenant, user.tenant_id)
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    purchases_enabled = is_product_feature_enabled(tenant, "purchases_enabled")
    start, end, start_dt, end_exclusive = _date_range(start_date, end_date)
    vat_on_debits = bool(getattr(tenant, "vat_on_debits", False)) if tenant else False
    sales_statuses = {"issued", "sent", "partial", "paid", "overdue", "pending"}

    sales_rows = (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == user.tenant_id,
            Invoice.issue_date >= start_dt,
            Invoice.issue_date < end_exclusive,
            Invoice.status.in_(sales_statuses),
        )
        .all()
    )
    sales_invoices = [row for row in sales_rows if row.type == "invoice"]
    credit_notes = [row for row in sales_rows if row.type == "credit_note"]
    payment_rows: list[tuple[Payment, Invoice]] = []
    sales_vat_effects: dict[str, dict[str, Any]] = {}

    if vat_on_debits:
        sales_vat_effects = {
            row.id: invoice_vat_effect_for_period(db, row, period_start=start_dt, period_end=end_exclusive)
            for row in sales_rows
        }
        collected_vat = sum(
            (
                _decimal(effect.get("vat_effect"))
                for effect in sales_vat_effects.values()
                if bool(effect.get("included"))
            ),
            Decimal("0"),
        )
        collected_basis = "Factures émises"
    elif payments_enabled:
        payment_rows = (
            db.query(Payment, Invoice)
            .join(Invoice, Invoice.id == Payment.invoice_id)
            .filter(
                Invoice.tenant_id == user.tenant_id,
                Invoice.type == "invoice",
                Invoice.status.in_(sales_statuses),
                Payment.date >= start_dt,
                Payment.date < end_exclusive,
            )
            .all()
        )
        collected_vat = Decimal("0")
        for payment, invoice in payment_rows:
            total_ttc = _decimal(invoice.total_inc_vat)
            if total_ttc <= 0:
                continue
            ratio = max(Decimal("0"), min(Decimal("1"), _decimal(payment.amount) / total_ttc))
            collected_vat += _decimal(invoice.total_vat) * ratio
        collected_basis = "Paiements reçus"
    else:
        collected_vat = Decimal("0")
        collected_basis = "Suivi des paiements réservé au plan Pro"
    collected_document_count = len(sales_invoices) if vat_on_debits else len(payment_rows)

    credit_note_vat = sum((abs(_decimal(row.total_vat)) for row in credit_notes), Decimal("0"))
    if not vat_on_debits:
        collected_vat = max(Decimal("0"), collected_vat - credit_note_vat)

    purchase_rows = []
    if purchases_enabled:
        purchase_rows = (
            db.query(InboundInvoice)
            .filter(InboundInvoice.tenant_id == user.tenant_id)
            .filter(
                or_(
                    InboundInvoice.issue_date.between(start, end),
                    and_(
                        InboundInvoice.issue_date.is_(None),
                        InboundInvoice.received_at >= start_dt,
                        InboundInvoice.received_at < end_exclusive,
                    ),
                )
            )
            .all()
        )
    eligible_purchases = [
        row
        for row in purchase_rows
        if str(row.completion_status or "").lower() == "completed"
        and str(row.status or "").lower() not in {"rejected", "duplicate", "canceled"}
        and str(row.validation_status or "").lower() not in {"invalid", "failed"}
    ]
    deductible_rows = [row for row in eligible_purchases if _decimal(row.total_vat) > 0]
    deductible_vat = sum((_decimal(row.total_vat) for row in deductible_rows), Decimal("0"))

    inconsistent_purchases = [
        row
        for row in purchase_rows
        if row.total_ex_vat is not None
        and row.total_vat is not None
        and row.total_ttc is not None
        and abs((_decimal(row.total_ex_vat) + _decimal(row.total_vat)) - _decimal(row.total_ttc)) > Decimal("0.02")
    ]
    purchases_missing_vat = [
        row
        for row in eligible_purchases
        if _decimal(row.total_ttc) > 0 and _decimal(row.total_vat) <= 0 and not bool(row.completion_validated_at)
    ]
    purchases_incomplete = [row for row in purchase_rows if str(row.completion_status or "").lower() != "completed"]
    mixed_currency_count = len([row for row in sales_rows if (row.currency or "EUR") != "EUR"]) + len(
        [row for row in purchase_rows if (row.currency or "EUR") != "EUR"]
    )

    anomalies: list[dict[str, Any]] = []
    if collected_vat > 0 and tenant and not (tenant.vat_number or "").strip():
        anomalies.append(
            {
                "code": "seller_vat_number_missing",
                "label": "Numéro de TVA entreprise manquant alors que de la TVA est collectée.",
                "count": 1,
                "severity": "warning",
                "action": _vat_anomaly_action("seller_vat_number_missing"),
            }
        )
    if purchases_missing_vat:
        anomalies.append(
            {
                "code": "purchase_vat_missing",
                "label": "Achats complétés sans TVA déductible renseignée.",
                "count": len(purchases_missing_vat),
                "severity": "info",
                "action": _vat_anomaly_action("purchase_vat_missing"),
            }
        )
    if purchases_incomplete:
        anomalies.append(
            {
                "code": "purchase_incomplete",
                "label": "Achats exclus car incomplets.",
                "count": len(purchases_incomplete),
                "severity": "warning",
                "action": _vat_anomaly_action("purchase_incomplete"),
            }
        )
    if inconsistent_purchases:
        anomalies.append(
            {
                "code": "purchase_totals_inconsistent",
                "label": "Achats avec HT + TVA différent du TTC.",
                "count": len(inconsistent_purchases),
                "severity": "danger",
                "action": _vat_anomaly_action("purchase_totals_inconsistent"),
            }
        )
    if credit_notes:
        anomalies.append(
            {
                "code": "credit_notes",
                "label": "Avoirs déduits de la TVA collectée.",
                "count": len(credit_notes),
                "severity": "info",
                "action": _vat_anomaly_action("credit_notes"),
            }
        )
    if mixed_currency_count:
        anomalies.append(
            {
                "code": "mixed_currency",
                "label": "Documents en devise non EUR à vérifier avec le cabinet.",
                "count": mixed_currency_count,
                "severity": "warning",
                "action": _vat_anomaly_action("mixed_currency"),
            }
        )

    net_vat = collected_vat - deductible_vat
    payload: dict[str, Any] = {
        "period": {"start_date": start.isoformat(), "end_date": end.isoformat()},
        "regime": {
            "key": "debits" if vat_on_debits else "payments",
            "label": "TVA sur les débits" if vat_on_debits else "TVA sur les encaissements",
            "basis": collected_basis,
        },
        "collected": {
            "vat": _money_float(collected_vat),
            "document_count": collected_document_count,
            "credit_note_vat": _money_float(credit_note_vat),
        },
        "deductible": {
            "vat": _money_float(deductible_vat),
            "document_count": len(deductible_rows),
            "excluded_count": len(purchase_rows) - len(deductible_rows),
        },
        "net_vat": _money_float(net_vat),
        "anomalies": anomalies,
        "notice": "Estimation de pilotage, hors télédeclaration. À valider avec le cabinet.",
    }
    payload["latest_validation"] = (
        _latest_vat_validation_for_period(
            db,
            tenant_id=user.tenant_id,
            start=start,
            end=end,
        )
        if purchases_enabled and payments_enabled
        else None
    )
    if not include_documents:
        return payload

    customer_ids = sorted({row.customer_id for row in sales_rows if row.customer_id})
    customer_names_by_id = {}
    if customer_ids:
        customer_names_by_id = {
            customer_id: name
            for customer_id, name in db.query(Customer.id, Customer.name).filter(Customer.id.in_(customer_ids)).all()
        }
    deductible_ids = {row.id for row in deductible_rows}
    document_rows: list[dict[str, Any]] = []
    anomaly_items: list[dict[str, Any]] = []
    if collected_vat > 0 and tenant and not (tenant.vat_number or "").strip():
        anomaly_items.append(
            _vat_anomaly_item(
                code="seller_vat_number_missing",
                severity="warning",
                message="De la TVA est collectée mais le numéro de TVA entreprise n'est pas renseigné.",
                correction_href="/app/company",
                correction_endpoint="/api/company/profile",
                action_label="Renseigner la TVA",
                direction="company",
                kind="tenant_profile",
                field="vat_number",
                current_value=getattr(tenant, "vat_number", None),
                party=getattr(tenant, "name", None),
            )
        )
    if vat_on_debits:
        for row in sales_invoices:
            effect = sales_vat_effects.get(row.id) or invoice_vat_effect_for_period(
                db, row, period_start=start_dt, period_end=end_exclusive
            )
            if not bool(effect.get("included")):
                continue
            document_rows.append(
                {
                    "id": row.id,
                    "direction": "sale",
                    "kind": "invoice",
                    "invoice_kind": row.invoice_kind or "standard",
                    "included": True,
                    "reason": effect.get("reason") or "TVA collectée sur facture émise",
                    "date": _document_date(row.issue_date),
                    "number": row.number,
                    "party": customer_names_by_id.get(row.customer_id) or "Client",
                    "status": _invoice_status_for_access(row, payments_enabled=payments_enabled),
                    "currency": row.currency or "EUR",
                    "total_ex_vat": _money_float(row.total_ex_vat),
                    "total_vat": _money_float(row.total_vat),
                    "total_inc_vat": _money_float(row.total_inc_vat),
                    "amount_paid": None,
                    "vat_effect": _money_float(effect.get("vat_effect")),
                    "deposit_vat_deducted": _money_float(effect.get("deposit_vat_deducted")),
                    "deposit_invoice_ids": effect.get("deposit_invoice_ids") or [],
                    "href": f"/app/invoices/{row.id}",
                }
            )
    else:
        for payment, invoice in payment_rows:
            total_ttc = _decimal(invoice.total_inc_vat)
            if total_ttc <= 0:
                continue
            ratio = max(Decimal("0"), min(Decimal("1"), _decimal(payment.amount) / total_ttc))
            vat_effect = _decimal(invoice.total_vat) * ratio
            document_rows.append(
                {
                    "id": payment.id,
                    "direction": "sale",
                    "kind": "payment",
                    "included": True,
                    "reason": "TVA collectée au prorata du paiement reçu",
                    "date": _document_date(payment.date),
                    "number": invoice.number,
                    "party": customer_names_by_id.get(invoice.customer_id) or "Client",
                    "status": _invoice_status_for_access(invoice, payments_enabled=payments_enabled),
                    "currency": invoice.currency or "EUR",
                    "total_ex_vat": _money_float(invoice.total_ex_vat),
                    "total_vat": _money_float(invoice.total_vat),
                    "total_inc_vat": _money_float(invoice.total_inc_vat),
                    "amount_paid": _money_float(payment.amount),
                    "vat_effect": _money_float(vat_effect),
                    "href": f"/app/invoices/{invoice.id}",
                }
            )
    for row in credit_notes:
        effect = sales_vat_effects.get(row.id) if vat_on_debits else None
        document_rows.append(
            {
                "id": row.id,
                "direction": "sale",
                "kind": "credit_note",
                "invoice_kind": row.invoice_kind or "standard",
                "included": True,
                "reason": (effect or {}).get("reason") or "Avoir déduit de la TVA collectée",
                "date": _document_date(row.issue_date),
                "number": row.number,
                "party": customer_names_by_id.get(row.customer_id) or "Client",
                "status": _invoice_status_for_access(row, payments_enabled=payments_enabled),
                "currency": row.currency or "EUR",
                "total_ex_vat": _money_float(row.total_ex_vat),
                "total_vat": _money_float(row.total_vat),
                "total_inc_vat": _money_float(row.total_inc_vat),
                "amount_paid": None,
                "vat_effect": _money_float((effect or {}).get("vat_effect"))
                if effect
                else -_money_float(abs(_decimal(row.total_vat))),
                "deposit_vat_deducted": 0,
                "deposit_invoice_ids": [],
                "href": f"/app/invoices/{row.id}",
            }
        )
    for row in purchase_rows:
        included = row.id in deductible_ids
        inconsistent = row in inconsistent_purchases
        reason = "TVA déductible retenue" if included else (_vat_purchase_exclusion_reason(row) or "Achat exclu")
        action = _vat_purchase_action(row, included=included, inconsistent=inconsistent)
        if action and (not included or inconsistent):
            if str(row.completion_status or "").lower() != "completed":
                code = "purchase_incomplete"
                field = "completion_status"
                message = "Cet achat est exclu du calcul TVA car il est incomplet."
            elif inconsistent:
                code = "purchase_totals_inconsistent"
                field = "total_ttc"
                message = "Cet achat a des totaux incohérents: HT + TVA ne correspond pas au TTC."
            elif _decimal(row.total_ttc) > 0 and _decimal(row.total_vat) <= 0 and not bool(row.completion_validated_at):
                code = "purchase_vat_missing"
                field = "total_vat"
                message = "Cet achat est complété mais aucune TVA déductible n'est renseignée."
            else:
                code = "purchase_excluded"
                field = "status"
                message = reason
            anomaly_items.append(
                _vat_anomaly_item(
                    code=code,
                    severity="danger" if code == "purchase_totals_inconsistent" else "warning",
                    message=message,
                    correction_href=f"/app/purchases/{row.id}",
                    correction_endpoint=f"/api/inbox/{row.id}/completion",
                    action_label=action["label"],
                    direction="purchase",
                    kind="purchase",
                    document_id=row.id,
                    number=row.invoice_number,
                    party=row.supplier_name or "Fournisseur",
                    field=field,
                    current_value=_money_float(getattr(row, field, None))
                    if field in {"total_ttc", "total_vat"}
                    else getattr(row, field, None),
                    suggestion=_vat_purchase_suggestion(db, user.tenant_id, row, code),
                )
            )
        document_rows.append(
            {
                "id": row.id,
                "direction": "purchase",
                "kind": "purchase",
                "included": included,
                "reason": reason,
                "date": _document_date(row.issue_date) or _document_date(row.received_at),
                "number": row.invoice_number,
                "party": row.supplier_name or "Fournisseur",
                "status": row.status,
                "currency": row.currency or "EUR",
                "total_ex_vat": _money_float(row.total_ex_vat),
                "total_vat": _money_float(row.total_vat),
                "total_inc_vat": _money_float(row.total_ttc),
                "amount_paid": None,
                "vat_effect": -_money_float(row.total_vat) if included else 0,
                "href": f"/app/purchases/{row.id}",
                "action": action,
                "warnings": ["HT + TVA différent du TTC"] if inconsistent else [],
            }
        )

    document_rows.sort(key=lambda item: (item.get("date") or "", item.get("number") or ""))
    limit = max(1, int(document_limit or 50))
    payload["documents"] = {
        "rows": document_rows[:limit],
        "total_count": len(document_rows),
        "included_count": len([row for row in document_rows if row["included"]]),
        "excluded_count": len([row for row in document_rows if not row["included"]]),
        "truncated": len(document_rows) > limit,
    }
    payload["anomaly_items"] = anomaly_items[:limit]
    return payload


def _customer_module_summary(
    db: Session,
    tenant_id: str,
    portfolio_summary: dict[str, Any],
    *,
    payments_enabled: bool,
) -> dict[str, Any]:
    total_count = int(
        db.query(func.count(Customer.id))
        .filter(Customer.tenant_id == tenant_id)
        .scalar()
        or 0
    )
    with_email_count = int(
        db.query(func.count(Customer.id))
        .filter(
            Customer.tenant_id == tenant_id,
            Customer.email.isnot(None),
            Customer.email != "",
        )
        .scalar()
        or 0
    )
    with_business_ids_count = int(
        db.query(func.count(Customer.id))
        .filter(
            Customer.tenant_id == tenant_id,
            or_(
                Customer.siret.isnot(None),
                Customer.vat_number.isnot(None),
            ),
        )
        .filter(
            or_(
                Customer.siret != "",
                Customer.vat_number != "",
            ),
        )
        .scalar()
        or 0
    )
    french_count = int(
        db.query(func.count(Customer.id))
        .filter(
            Customer.tenant_id == tenant_id,
            func.upper(func.coalesce(Customer.country, "")) == "FR",
        )
        .scalar()
        or 0
    )
    active_count = int(portfolio_summary.get("active_customers") or total_count)
    top_accounts_count = int(portfolio_summary.get("top_accounts_count") or 0)
    at_risk_count = int(portfolio_summary.get("at_risk_count") or 0)
    watchlist_count = int(portfolio_summary.get("watchlist_count") or 0)
    risk_count = at_risk_count + watchlist_count

    if total_count <= 0:
        focus = _focus(
            "info",
            "Amorçage CRM",
            "Créer un premier client",
            "Ajoute une fiche client exploitable pour lancer devis, factures et suivi commercial.",
            "/app/customers/new",
            "Nouveau client",
        )
    elif with_business_ids_count < total_count:
        missing_count = total_count - with_business_ids_count
        focus = _focus(
            "warn",
            "Conformité client",
            "Compléter les identifiants légaux",
            f"{missing_count} client(s) n'ont pas encore de SIRET ou de TVA. Priorise-les avant la montée en charge e-invoicing.",
            "/app/customers",
            "Compléter la base",
        )
    elif risk_count > 0:
        focus = _focus(
            "danger",
            "Portefeuille",
            "Traiter les comptes à surveiller",
            f"{risk_count} client(s) sont en watchlist ou à risque. Reprends le portefeuille avant que la dette ne s'installe.",
            "/app/portfolio",
            "Ouvrir le portefeuille",
        )
    elif with_email_count < total_count:
        missing_count = total_count - with_email_count
        focus = _focus(
            "info",
            "Joignabilité",
            "Compléter les emails opérationnels",
            f"{missing_count} client(s) restent difficiles à joindre. Renseigne les emails pour sécuriser devis, factures et relances.",
            "/app/customers",
            "Vérifier les contacts",
        )
    else:
        focus = _focus(
            "ok",
            "Base saine",
            "Base clients opérationnelle" if not payments_enabled else "Base clients prête à encaisser",
            (
                "La base est exploitable pour préparer les devis et factures."
                if not payments_enabled
                else "La base est exploitable: contacts présents, conformité mieux couverte et peu de comptes fragiles."
            ),
            "/app/customers",
            "Voir les clients",
        )

    return {
        "summary": {
            "total_count": total_count,
            "active_count": active_count,
            "with_email_count": with_email_count,
            "with_business_ids_count": with_business_ids_count,
            "french_count": french_count,
            "top_accounts_count": top_accounts_count,
            "at_risk_count": at_risk_count,
            "watchlist_count": watchlist_count,
            "risk_count": risk_count,
        },
        "focus": focus,
    }


def _quote_module_summary(db: Session, tenant_id: str) -> dict[str, Any]:
    status_rows = (
        db.query(Quote.status, func.count(Quote.id))
        .filter(Quote.tenant_id == tenant_id)
        .group_by(Quote.status)
        .all()
    )
    counts = {str(status or "unknown"): int(count or 0) for status, count in status_rows}
    total_count = sum(counts.values())
    draft_count = counts.get("draft", 0)
    sent_count = counts.get("sent", 0)
    accepted_count = counts.get("accepted", 0)
    rejected_count = counts.get("rejected", 0)
    invoiced_count = counts.get("invoiced", 0)
    expired_count = counts.get("expired", 0)
    pipeline_amount = (
        db.query(func.coalesce(func.sum(Quote.total_inc_vat), 0))
        .filter(Quote.tenant_id == tenant_id, Quote.status.in_(["draft", "sent", "accepted"]))
        .scalar()
        or 0
    )

    if total_count <= 0:
        focus = _focus(
            "info",
            "Pipeline à lancer",
            "Créer un premier devis",
            "Le pipeline commercial est vide. Crée un devis type pour enclencher ton cycle vente -> facture.",
            "/app/quotes/new",
            "Nouveau devis",
        )
    elif accepted_count > 0:
        focus = _focus(
            "ok",
            "Conversion",
            "Facturer les devis acceptés",
            f"{accepted_count} devis accepté(s) peuvent être transformés en factures sans attendre.",
            "/app/quotes",
            "Voir les devis acceptés",
        )
    elif sent_count > 0:
        focus = _focus(
            "warn",
            "Relance commerciale",
            "Reprendre les devis envoyés",
            f"{sent_count} devis envoyé(s) attendent encore une décision. Priorise les relances avant qu'ils ne refroidissent.",
            "/app/quotes",
            "Relancer le pipeline",
        )
    elif draft_count > 0:
        focus = _focus(
            "info",
            "Préparation",
            "Finaliser les brouillons de devis",
            f"{draft_count} brouillon(s) restent à structurer ou envoyer pour alimenter l'activité.",
            "/app/quotes",
            "Reprendre les brouillons",
        )
    else:
        focus = _focus(
            "ok",
            "Pipeline propre",
            "Tunnel commercial sous contrôle",
            "Le pipeline est propre: peu de brouillons dormants et les derniers devis ont été traités.",
            "/app/quotes",
            "Ouvrir les devis",
        )

    return {
        "summary": {
            "total_count": total_count,
            "draft_count": draft_count,
            "sent_count": sent_count,
            "accepted_count": accepted_count,
            "rejected_count": rejected_count,
            "expired_count": expired_count,
            "invoiced_count": invoiced_count,
            "pipeline_amount": pipeline_amount,
        },
        "focus": focus,
    }


def _invoice_module_summary(
    db: Session,
    tenant_id: str,
    metrics: dict[str, Any],
    cash_summary: dict[str, Any] | None,
    *,
    payments_enabled: bool,
) -> dict[str, Any]:
    status_rows = (
        db.query(Invoice.status, func.count(Invoice.id))
        .filter(Invoice.tenant_id == tenant_id)
        .group_by(Invoice.status)
        .all()
    )
    counts = {str(status or "unknown"): int(count or 0) for status, count in status_rows}
    total_count = sum(counts.values())
    draft_count = counts.get("draft", 0)
    issued_count = counts.get("issued", 0)
    sent_count = counts.get("sent", 0)
    retained_payment_states = sum(
        int(counts.get(key, 0) or 0)
        for key in ("paid", "partial", "overdue", "refunded")
    )
    if not payments_enabled:
        issued_count += retained_payment_states
    partial_count = counts.get("partial", 0) if payments_enabled else 0
    paid_count = counts.get("paid", 0) if payments_enabled else 0
    overdue_count = (
        int((metrics or {}).get("overdue_count") or counts.get("overdue", 0) or 0)
        if payments_enabled
        else 0
    )
    pending_count = (
        int((metrics or {}).get("pending_count") or (issued_count + sent_count + partial_count))
        if payments_enabled
        else 0
    )
    overdue_amount = (
        (metrics or {}).get("overdue_amount") or (cash_summary or {}).get("overdue_balance_due") or 0
        if payments_enabled
        else 0
    )
    open_balance_due = ((cash_summary or {}).get("open_balance_due") or 0) if payments_enabled else 0
    invoiced_month = (metrics or {}).get("invoiced_month") or 0
    paid_month = ((metrics or {}).get("paid_month") or 0) if payments_enabled else 0

    if payments_enabled and overdue_count > 0:
        focus = _focus(
            "danger",
            "Recouvrement",
            "Traiter les retards de paiement",
            f"{overdue_count} facture(s) sont déjà en retard. Reprends les échéances et les relances avant d'empiler de nouveaux flux.",
            "/app/receivables",
            "Ouvrir le recouvrement",
        )
    elif draft_count > 0:
        focus = _focus(
            "warn",
            "Émission",
            "Sortir les brouillons en attente",
            f"{draft_count} brouillon(s) bloquent du chiffre non émis. Priorise l'émission avant la fin de période.",
            "/app/invoices",
            "Reprendre les factures",
        )
    elif payments_enabled and pending_count > 0:
        focus = _focus(
            "info",
            "Encaissement",
            "Suivre les factures ouvertes",
            f"{pending_count} facture(s) sont encore ouvertes. Contrôle les échéances et les moyens de paiement pour accélérer l'encaissement.",
            "/app/payments",
            "Suivre les paiements",
        )
    elif total_count <= 0:
        focus = _focus(
            "info",
            "Facturation",
            "Créer une première facture",
            "L'espace n'a pas encore de facture. Démarre par un document simple pour mettre en route le cycle cash.",
            "/app/invoices/new",
            "Nouvelle facture",
        )
    elif not payments_enabled:
        focus = _focus(
            "ok",
            "Facturation classique",
            "Documents de vente disponibles",
            "Les factures restent disponibles sans suivi des règlements ni relances automatiques.",
            "/app/invoices",
            "Ouvrir les factures",
        )
    else:
        focus = _focus(
            "ok",
            "Cycle maîtrisé",
            "Facturation sous contrôle",
            "Le cycle est propre: peu d'encours critique et les documents en circulation restent suivis.",
            "/app/invoices",
            "Ouvrir les factures",
        )

    return {
        "summary": {
            "total_count": total_count,
            "draft_count": draft_count,
            "issued_count": issued_count,
            "sent_count": sent_count,
            "partial_count": partial_count,
            "paid_count": paid_count,
            "pending_count": pending_count,
            "overdue_count": overdue_count,
            "overdue_amount": overdue_amount,
            "open_balance_due": open_balance_due,
            "invoiced_month": invoiced_month,
            "paid_month": paid_month,
        },
        "focus": focus,
    }


def _cash_module_summary(
    cash_summary: dict[str, Any] | None,
    *,
    available: bool = True,
) -> dict[str, Any]:
    cash_summary = cash_summary or {}
    overdue_count = int(cash_summary.get("overdue_count") or 0)
    due_next_14_days = cash_summary.get("due_next_14_days") or 0
    collection_ratio = cash_summary.get("collection_ratio_last_90_days")

    if not available:
        focus = _focus(
            "info",
            "Module Pro",
            "Suivi des paiements non activé",
            "Le plan actuel conserve les devis et factures sans afficher les règlements ni les relances.",
            "/app/billing",
            "Voir le plan Pro",
        )
    elif overdue_count > 0:
        focus = _focus(
            "danger",
            "Tension cash",
            "Sécuriser l'encours en retard",
            f"{overdue_count} facture(s) en retard menacent déjà la trésorerie. Reprends les priorités de recouvrement avant le reste.",
            "/app/receivables",
            "Traiter les retards",
        )
    elif due_next_14_days:
        focus = _focus(
            "warn",
            "Court terme",
            "Anticiper les 14 prochains jours",
            "Des échéances importantes arrivent vite. Vérifie les moyens de paiement et les relances planifiées pour lisser l'encaissement.",
            "/app/invoices",
            "Voir les échéances",
        )
    elif collection_ratio is not None and float(collection_ratio) < 60:
        focus = _focus(
            "info",
            "Performance",
            "Améliorer la vitesse de collecte",
            f"Le taux de collecte 90 jours reste à {float(collection_ratio):.1f} %. Il faut reprendre les réglages et le suivi des paiements.",
            "/app/payments",
            "Ouvrir les paiements",
        )
    else:
        focus = _focus(
            "ok",
            "Cash stable",
            "Trésorerie sous contrôle",
            "L'encours et le rythme d'encaissement restent contenus. Le sujet est surtout de garder la discipline d'exécution.",
            "/app/payments",
            "Voir les paiements",
        )

    return {
        "available": available,
        "summary": {
            "collected_last_30_days": cash_summary.get("collected_last_30_days") or 0,
            "collected_this_month": cash_summary.get("collected_this_month") or 0,
            "average_days_to_pay": cash_summary.get("average_days_to_pay"),
            "collection_ratio_last_90_days": collection_ratio,
            "due_next_14_days": due_next_14_days,
            "overdue_balance_due": cash_summary.get("overdue_balance_due") or 0,
            "open_balance_due": cash_summary.get("open_balance_due") or 0,
            "overdue_count": overdue_count,
        },
        "focus": focus,
    }


@router.get("/dashboard")
def cockpit_dashboard(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    """Agrégats exacts du tableau de bord.

    Le front garde les listes légères pour les derniers documents, mais les compteurs,
    statuts et séries ne dépendent plus d'un échantillon paginé.
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _, payments_enabled = _ops_feature_access(db, user)
    return {
        "generated_at": now.isoformat(),
        "invoice_status": _dashboard_invoice_status(
            db,
            user.tenant_id,
            payments_enabled=payments_enabled,
        ),
        "accepted_quotes": _dashboard_accepted_quotes(db, user.tenant_id),
        "periods": _dashboard_period_series(
            db,
            user.tenant_id,
            now,
            payments_enabled=payments_enabled,
        ),
        "recent_invoices": _recent_invoice_docs(
            db,
            user.tenant_id,
            payments_enabled=payments_enabled,
        ),
        "recent_quotes": _recent_quote_docs(db, user.tenant_id),
    }


@router.get("/overview")
def cockpit_overview(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    purchases_enabled, payments_enabled = _ops_feature_access(db, user)
    cache_key = (str(user.tenant_id), str(user.id), purchases_enabled, payments_enabled)
    cached = _cockpit_overview_cache_get(cache_key)
    if cached is not None:
        return cached

    lock = _cockpit_overview_lock(cache_key)
    with lock:
        cached = _cockpit_overview_cache_get(cache_key)
        if cached is not None:
            return cached
        payload = _cockpit_overview_payload(
            db,
            user,
            purchases_enabled=purchases_enabled,
            payments_enabled=payments_enabled,
        )
        _cockpit_overview_cache_set(cache_key, payload)
        return payload


def _cockpit_overview_payload(
    db: Session,
    user: AuthUser,
    *,
    purchases_enabled: bool | None = None,
    payments_enabled: bool | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if purchases_enabled is None or payments_enabled is None:
        purchases_enabled, payments_enabled = _ops_feature_access(db, user)
    purchases_enabled = bool(purchases_enabled)
    payments_enabled = bool(payments_enabled)
    warnings: list[str] = []
    settings_row = (
        db.query(TenantSettings)
        .filter(TenantSettings.tenant_id == user.tenant_id)
        .first()
    )

    workspace = _safe_load(
        "workspace",
        lambda: workspace_summary(db=db, user=user),
        {},
        warnings,
    )
    metrics = _safe_load(
        "metrics",
        lambda: metrics_endpoint(db=db, user=user),
        {},
        warnings,
    )
    activity = _safe_load(
        "activity",
        lambda: recent_activity(limit=5, db=db, user=user),
        None,
        warnings,
    )
    notifications = _safe_load(
        "notifications",
        lambda: _notifications_payload(db, user, settings_row=settings_row, persist=True, now=now),
        None,
        warnings,
    )
    action_data = _safe_load(
        "action_center",
        lambda: action_center(db=db, user=user),
        None,
        warnings,
    )
    portfolio = (
        _safe_load(
            "portfolio",
            lambda: _portfolio_payload(db, user, now=now),
            None,
            warnings,
        )
        if payments_enabled
        else None
    )
    scheduler = (
        _safe_load(
            "scheduler",
            lambda: _control_payload(db, user, settings_row=settings_row, now=now)[1],
            None,
            warnings,
        )
        if payments_enabled
        else None
    )
    outbox = (
        _safe_load(
            "outbox",
            lambda: _board_payload(db, user, settings_row=settings_row, now=now),
            None,
            warnings,
        )
        if payments_enabled
        else None
    )
    cash = (
        _safe_load(
            "cash",
            lambda: cash_dashboard(db=db, user=user),
            None,
            warnings,
        )
        if payments_enabled
        else None
    )

    inbox_total = 0
    if purchases_enabled:
        inbox_total = int(
            db.query(func.count(InboundInvoice.id))
            .filter(InboundInvoice.tenant_id == user.tenant_id)
            .scalar()
            or 0
        )

    team_lookup = _team_lookup(db, user)
    entitled_task_rows = _filter_entitled_rows(
        _read_tasks(settings_row),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    task_rows = [_task_out(item, team_lookup) for item in entitled_task_rows]
    tasks_summary = _task_summary(task_rows, now)

    urgent_count = 0
    if action_data:
        urgent_count = int(action_data.summary.critical_count or 0) + int(action_data.summary.high_count or 0)

    notifications_unread = 0
    notification_payload = None
    if notifications:
        notification_payload = _dump_model(notifications)
        visible_notifications = [
            item
            for item in list(notification_payload.get("items") or [])
            if _ops_module_allowed(
                item.get("module"),
                purchases_enabled=purchases_enabled,
                payments_enabled=payments_enabled,
            )
        ]
        notification_payload["items"] = visible_notifications[:8]
        notifications_unread = sum(1 for item in visible_notifications if not bool(item.get("read")))
        notification_summary = notification_payload.get("summary")
        if isinstance(notification_summary, dict):
            module_counts: dict[str, int] = {}
            for item in visible_notifications:
                module = str(item.get("module") or "setup")
                module_counts[module] = module_counts.get(module, 0) + 1
            notification_summary["total_count"] = len(visible_notifications)
            notification_summary["unread_count"] = notifications_unread
            notification_summary["modules"] = module_counts

    portfolio_risk_count = 0
    portfolio_summary = {}
    if portfolio:
        portfolio_summary = _dump_model(portfolio.summary)
        portfolio_risk_count = int(portfolio.summary.at_risk_count or 0) + int(portfolio.summary.watchlist_count or 0)

    scheduler_summary = _dump_model(scheduler.summary) if scheduler else {}
    scheduler_alerts_count = 0
    if scheduler:
        scheduler_alerts_count = (
            int(scheduler.summary.warning_jobs or 0)
            + int(scheduler.summary.error_jobs or 0)
            + (1 if scheduler.summary.heartbeat_stale else 0)
            + (1 if scheduler.summary.lock_stale else 0)
        )

    outbox_summary = _dump_model(outbox.summary) if outbox else {}
    outbox_pending_count = 0
    if outbox:
        outbox_pending_count = int(outbox.summary.ready_count or 0) + int(outbox.summary.blocked_count or 0)

    cash_summary = None
    if cash:
        cash_summary = {
            "collected_last_30_days": cash.collected_last_30_days,
            "collected_this_month": cash.collected_this_month,
            "average_days_to_pay": cash.average_days_to_pay,
            "collection_ratio_last_90_days": cash.collection_ratio_last_90_days,
            "due_next_14_days": cash.due_next_14_days,
            "open_balance_due": cash.open_balance_due,
            "overdue_balance_due": cash.overdue_balance_due,
            "overdue_count": cash.overdue_count,
        }

    workspace_invoices = (workspace or {}).get("invoices") or {}
    badge_invoices_total = int(workspace_invoices.get("count") or 0)
    badge_overdue_count = int((metrics or {}).get("overdue_count") or workspace_invoices.get("overdue_count") or 0)

    action_payload = None
    if action_data:
        action_payload = _dump_model(action_data)
        action_payload["items"] = list(action_payload.get("items") or [])[:6]

    activity_items = []
    if activity:
        activity_items = [_dump_model(item) for item in activity.items]

    modules = {
        "customers": _customer_module_summary(
            db,
            user.tenant_id,
            portfolio_summary,
            payments_enabled=payments_enabled,
        ),
        "quotes": _quote_module_summary(db, user.tenant_id),
        "invoices": _invoice_module_summary(
            db,
            user.tenant_id,
            metrics or {},
            cash_summary,
            payments_enabled=payments_enabled,
        ),
        "cash": _cash_module_summary(cash_summary, available=payments_enabled),
    }

    return {
        "generated_at": now.isoformat(),
        "partial": bool(warnings),
        "warnings": warnings,
        "workspace": workspace,
        "notifications": notification_payload,
        "modules": modules,
        "badges": {
            "invoices_total": badge_invoices_total,
            "overdue_count": badge_overdue_count,
            "inbox_total": inbox_total,
            "urgent_count": urgent_count,
            "tasks_open_count": int(tasks_summary.open_count or 0),
            "notifications_unread_count": notifications_unread,
            "portfolio_risk_count": portfolio_risk_count,
            "outbox_pending_count": outbox_pending_count,
            "scheduler_alerts_count": scheduler_alerts_count,
        },
        "dashboard": {
            "metrics": metrics,
            "cash": cash_summary,
            "portfolio_summary": portfolio_summary,
            "tasks_summary": _dump_model(tasks_summary),
            "scheduler_summary": scheduler_summary,
            "outbox_summary": outbox_summary,
            "action_center": action_payload,
            "activity": activity_items,
            "recent_invoices": _recent_invoice_docs(
                db,
                user.tenant_id,
                payments_enabled=payments_enabled,
            ),
            "recent_quotes": _recent_quote_docs(db, user.tenant_id),
        },
    }


@router.get("/document-seed")
def cockpit_document_seed(
    customer_id: str | None = Query(None),
    document_type: str = Query("invoice", pattern="^(invoice|quote)$"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    invoice_seed = _latest_invoice_document_seed(db, user.tenant_id)
    quote_seed = _latest_quote_document_seed(db, user.tenant_id)
    suggestions = _document_seed_suggestions(db, user.tenant_id)

    def with_sales_defaults(seed: dict[str, Any]) -> dict[str, Any]:
        selected_customer = customer_id
        if not selected_customer:
            customer = seed.get("customer") if isinstance(seed.get("customer"), dict) else None
            selected_customer = str(customer.get("id") or "") if customer else ""
        if not selected_customer:
            return seed
        defaults = suggest_document_defaults(db, user.tenant_id, selected_customer, document_type)
        return {
            **seed,
            "sales_defaults": defaults,
            "suggested_payment_terms": defaults.get("suggested_payment_terms"),
            "suggested_due_days": defaults.get("suggested_due_days"),
            "suggested_valid_until_days": defaults.get("suggested_valid_until_days"),
            "suggested_lines": defaults.get("suggested_lines"),
            "reason": seed.get("reason") or defaults.get("reason"),
            "confidence": max(float(seed.get("confidence") or 0), float(defaults.get("confidence") or 0)),
        }

    candidates = [seed for seed in (invoice_seed, quote_seed) if seed]
    if candidates:
        candidates.sort(key=_document_seed_sort_value, reverse=True)
        selected = candidates[0]
        if selected.get("item"):
            return with_sales_defaults({**selected, "suggestions": suggestions})

    fallback = _fallback_document_seed(db, user.tenant_id)
    if candidates:
        selected = candidates[0]
        return with_sales_defaults({
            **selected,
            "item": selected.get("item") or fallback.get("item"),
            "suggestions": suggestions,
        })
    return with_sales_defaults({**fallback, "suggestions": suggestions})


@router.get("/customers/{customer_id}")
def cockpit_customer_detail(
    customer_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _, payments_enabled = _ops_feature_access(db, user)
    customer = get_customer(customer_id, db=db, user=user)
    customer_record = db.get(Customer, customer_id)
    assert customer_record is not None
    summary = customer_summary(customer_id, db=db, user=user)
    portal = (
        get_customer_portal(customer_id, db=db, user=user)
        if _can_manage_customer_portal(user)
        else _customer_portal_status_for_role(customer_record, user)
    )
    portfolio = customer_portfolio_detail(customer_id, db=db, user=user) if payments_enabled else None

    return {
        "generated_at": now.isoformat(),
        "customer": _dump_model(customer),
        "summary": _dump_model(summary),
        "portal": _dump_model(portal),
        "portfolio": _dump_model(portfolio),
        "recent_invoices": _recent_customer_invoices(
            db,
            user.tenant_id,
            customer_id,
            payments_enabled=payments_enabled,
        ),
        "recent_quotes": _recent_customer_quotes(db, user.tenant_id, customer_id),
    }


@router.get("/quotes/{quote_id}")
def cockpit_quote_detail(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    quote = get_quote(quote_id, db=db, user=user)
    share = get_quote_share_link(quote_id, db=db, user=user)
    timeline = quote_timeline(quote_id, db=db, user=user)
    email_events = (
        db.query(EmailEvent)
        .filter(EmailEvent.quote_id == quote_id, EmailEvent.tenant_id == user.tenant_id)
        .order_by(EmailEvent.created_at.desc())
        .limit(10)
        .all()
    )

    return {
        "generated_at": now.isoformat(),
        "quote": _dump_model(quote),
        "share": _dump_model(share),
        "timeline": _dump_model(timeline),
        "email_events": _dump_model(email_events),
    }


@router.get("/invoices/{invoice_id}")
def cockpit_invoice_detail(
    invoice_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    invoice = get_invoice(invoice_id, db=db, user=user)
    company = get_profile(db=db, user=user)
    customer_id = invoice.get("customer_id") if isinstance(invoice, dict) else getattr(invoice, "customer_id", None)
    customer = db.get(Customer, customer_id) if customer_id else None
    share = get_invoice_share_link(invoice_id, db=db, user=user)

    return {
        "generated_at": now.isoformat(),
        "invoice": _dump_model(invoice),
        "company": _dump_model(company),
        "customer": _dump_model(customer) if customer and customer.tenant_id == user.tenant_id else None,
        "share": _dump_model(share),
    }
