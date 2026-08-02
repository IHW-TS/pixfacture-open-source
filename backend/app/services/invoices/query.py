from __future__ import annotations

import calendar
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from fastapi import Request, Response
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, load_only

from app.models import Customer, EmailEvent, Invoice, InvoiceDepositApplication, Payment, Tenant
from app.schemas import InvoiceListOut
from app.services.invoices.amounts import invoice_balance_due_amount
from app.services.invoices.deposits import invoice_effective_template_options
from app.services.invoices.followup_decision import invoice_followup_decision
from app.services.product_capabilities import ensure_product_feature, is_product_feature_enabled


_PAYMENT_FILTER_STATUSES = {"pending", "paid", "partial", "overdue"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=None) if getattr(value, "tzinfo", None) is not None else value


def _latest_followup_email_events_by_invoice(
    db: Session,
    *,
    tenant_id: str,
    invoices: list[Invoice],
) -> dict[str, EmailEvent]:
    invoice_ids = [inv.id for inv in invoices if inv.id]
    if not invoice_ids:
        return {}

    reminder_at_by_invoice = {
        inv.id: _naive_datetime(getattr(inv, "last_reminder_at", None))
        for inv in invoices
        if inv.id and getattr(inv, "last_reminder_at", None)
    }
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
        if invoice_id in latest_near_reminder:
            continue
        reminder_at = reminder_at_by_invoice.get(invoice_id)
        created_at = _naive_datetime(event.created_at)
        if reminder_at and created_at and created_at >= reminder_at - timedelta(minutes=10):
            latest_near_reminder[invoice_id] = event
    return {
        invoice_id: event
        for invoice_id in invoice_ids
        if (event := latest_typed.get(invoice_id) or latest_near_reminder.get(invoice_id)) is not None
    }


def _email_event_fields(event: EmailEvent | None) -> dict[str, object]:
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


def _compute_due_date(issue_date: datetime, payment_terms: str | None, due_days: int | None) -> datetime:
    days = due_days or 0
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


def _compute_due_date_no_write(inv: Invoice) -> datetime | None:
    if inv.due_date:
        return inv.due_date
    issue_date = inv.issue_date or _utcnow()
    return _compute_due_date(issue_date, inv.payment_terms, inv.due_days)


def _credit_notes_total(db: Session, inv: Invoice) -> Decimal:
    notes = (
        db.query(Invoice)
        .filter(
            Invoice.related_invoice_id == inv.id,
            Invoice.tenant_id == inv.tenant_id,
            Invoice.type == "credit_note",
            Invoice.status.notin_(["draft", "canceled"]),
        )
        .all()
    )
    return sum((abs(Decimal(str(n.total_inc_vat or 0))) for n in notes), Decimal("0"))


def _payments_total(inv: Invoice) -> Decimal:
    return sum((Decimal(str(p.amount or 0)) for p in inv.payments or []), Decimal("0"))


def _outstanding(db: Session, inv: Invoice) -> Decimal:
    credits = _credit_notes_total(db, inv)
    paid = _payments_total(inv)
    return invoice_balance_due_amount(
        inv.total_inc_vat,
        invoice_effective_template_options(db, inv),
        credits=credits,
        paid=paid,
    )


def _is_overdue(inv: Invoice, db: Session, now: datetime | None = None) -> bool:
    if inv.status in {"paid", "canceled"}:
        return False
    check_time = now or _utcnow()
    due_date = _compute_due_date_no_write(inv)
    if not due_date or due_date >= check_time:
        return False
    return _outstanding(db, inv) > 0


def _effective_invoice_status(inv: Invoice, db: Session, now: datetime | None = None) -> str:
    if _is_overdue(inv, db, now):
        return "overdue"
    return str(inv.status or "unknown")


def _payment_neutral_invoice_status(inv: Invoice) -> str:
    status = str(inv.status or "unknown").strip().lower()
    if status in _PAYMENT_FILTER_STATUSES:
        return "sent" if inv.sent_at else "issued"
    return status


def _parse_bound(raw_date: str | None, *, end: bool = False) -> datetime | None:
    if not raw_date:
        return None
    cleaned = raw_date.strip()
    if not cleaned:
        return None
    try:
        value = datetime.fromisoformat(cleaned)
    except Exception:
        return None
    if end and len(cleaned) <= 10:
        return value + timedelta(days=1)
    return value


def _parse_decimal_bound(raw_amount: str | None) -> Decimal | None:
    if not raw_amount:
        return None
    cleaned = raw_amount.strip().replace(" ", "").replace(",", ".")
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return None


def _invoice_vat_correction_filter():
    currency = func.upper(func.coalesce(Invoice.currency, "EUR"))
    total_ht = func.coalesce(Invoice.total_ex_vat, 0)
    total_vat = func.coalesce(Invoice.total_vat, 0)
    return or_(
        Invoice.type == "credit_note",
        currency != "EUR",
        and_(Invoice.status.notin_(["draft", "canceled"]), total_ht > 0, total_vat <= 0),
    )


def list_invoices(
    response: Response,
    request: Request,
    *,
    status: str | None,
    customer_id: str | None,
    period: str | None,
    month: int | None,
    year: int | None,
    q: str | None,
    start_date: str | None = None,
    end_date: str | None = None,
    min_total_ht: str | None = None,
    max_total_ht: str | None = None,
    paid_start_date: str | None = None,
    paid_end_date: str | None = None,
    quote_id: str | None = None,
    invoice_kind: str | None = None,
    document_type: str | None = None,
    deposit_state: str | None = None,
    vat_correction: bool = False,
    limit: int,
    offset: int,
    db: Session,
    tenant_id: str,
) -> list[dict]:
    tenant = db.get(Tenant, tenant_id)
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    structured_artifacts_enabled = is_product_feature_enabled(tenant, "einvoicing_enabled")
    search = (q or "").strip()
    query = db.query(Invoice).filter(Invoice.tenant_id == tenant_id)
    requested_status = (status or "").strip().lower()
    paid_filter_requested = bool((paid_start_date or "").strip() or (paid_end_date or "").strip())
    if not payments_enabled and (requested_status in _PAYMENT_FILTER_STATUSES or paid_filter_requested):
        ensure_product_feature(tenant, "payments_enabled")
    effective_status_filter = requested_status if requested_status and requested_status != "all" else None
    post_filter_statuses: set[str] | None = None
    if effective_status_filter:
        if effective_status_filter == "overdue":
            query = query.filter(Invoice.status.notin_(["paid", "canceled"]))
            post_filter_statuses = {"overdue"}
        elif effective_status_filter == "pending":
            pending_statuses = ["issued", "sent", "partial"]
            if not payments_enabled:
                pending_statuses.append("overdue")
            query = query.filter(Invoice.status.in_(pending_statuses))
            post_filter_statuses = {"issued", "sent", "partial"} if payments_enabled else None
        else:
            query = query.filter(Invoice.status == effective_status_filter)
            post_filter_statuses = {effective_status_filter}
    if customer_id:
        query = query.filter(Invoice.customer_id == customer_id)
    if quote_id:
        query = query.filter(Invoice.quote_id == quote_id)
    if invoice_kind:
        normalized_kind = invoice_kind.strip().lower()
        if normalized_kind in {"standard", "deposit", "final"}:
            query = query.filter(Invoice.invoice_kind == normalized_kind)
        elif normalized_kind != "all":
            query = query.filter(False)
    if document_type:
        normalized_type = document_type.strip().lower()
        if normalized_type in {"invoice", "credit_note"}:
            query = query.filter(Invoice.type == normalized_type)
        elif normalized_type != "all":
            query = query.filter(False)
    if deposit_state:
        normalized_state = deposit_state.strip().lower()
        if normalized_state in {"unapplied", "non_applique", "non-applique"}:
            used_deposit_ids = db.query(InvoiceDepositApplication.deposit_invoice_id).filter(
                InvoiceDepositApplication.tenant_id == tenant_id
            )
            query = query.filter(
                Invoice.invoice_kind == "deposit",
                Invoice.status.notin_(["draft", "canceled"]),
                Invoice.id.notin_(used_deposit_ids),
            )
        elif normalized_state in {"applied", "applique"}:
            used_deposit_ids = db.query(InvoiceDepositApplication.deposit_invoice_id).filter(
                InvoiceDepositApplication.tenant_id == tenant_id
            )
            query = query.filter(Invoice.invoice_kind == "deposit", Invoice.id.in_(used_deposit_ids))
        elif normalized_state not in {"all", ""}:
            query = query.filter(False)

    if vat_correction:
        query = query.filter(_invoice_vat_correction_filter())

    start = end = None
    if period:
        if period.startswith("month:"):
            try:
                parts = period.split(":")[1].split("-")
                y, m = int(parts[0]), int(parts[1])
                start = datetime(y, m, 1)
                end = (start + timedelta(days=32)).replace(day=1)
            except Exception:
                pass
        elif period.startswith("year:"):
            try:
                y = int(period.split(":")[1])
                start = datetime(y, 1, 1)
                end = datetime(y + 1, 1, 1)
            except Exception:
                pass
    elif month and year:
        start = datetime(year, month, 1)
        end = (start + timedelta(days=32)).replace(day=1)

    explicit_start = _parse_bound(start_date)
    explicit_end = _parse_bound(end_date, end=True)
    if explicit_start:
        start = explicit_start
    if explicit_end:
        end = explicit_end

    if start:
        query = query.filter(Invoice.issue_date >= start)
    if end:
        query = query.filter(Invoice.issue_date < end)

    if start and end and start >= end:
        query = query.filter(False)

    min_ht = _parse_decimal_bound(min_total_ht)
    max_ht = _parse_decimal_bound(max_total_ht)
    if min_ht is not None:
        query = query.filter(Invoice.total_ex_vat >= min_ht)
    if max_ht is not None:
        query = query.filter(Invoice.total_ex_vat <= max_ht)
    if min_ht is not None and max_ht is not None and min_ht > max_ht:
        query = query.filter(False)

    paid_start = _parse_bound(paid_start_date)
    paid_end = _parse_bound(paid_end_date, end=True)
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

    if search:
        like = f"%{search}%"
        query = query.join(Customer, Customer.id == Invoice.customer_id).filter(
            or_(
                Invoice.number.ilike(like),
                Invoice.purchase_order_number.ilike(like),
                Customer.name.ilike(like),
            )
        )

    list_query = query.order_by(Invoice.issue_date.desc(), Invoice.created_at.desc(), Invoice.id.desc()).options(
        load_only(
            Invoice.id,
            Invoice.customer_id,
            Invoice.number,
            Invoice.currency,
            Invoice.status,
            Invoice.issue_date,
            Invoice.service_date,
            Invoice.due_date,
            Invoice.due_days,
            Invoice.payment_terms,
            Invoice.template_key,
            Invoice.template_options,
            Invoice.purchase_order_number,
            Invoice.total_ex_vat,
            Invoice.total_vat,
            Invoice.total_inc_vat,
            Invoice.sent_at,
            Invoice.paid_at,
            Invoice.reminder_count,
            Invoice.last_reminder_at,
            Invoice.public_enabled,
            Invoice.public_view_count,
            Invoice.public_first_viewed_at,
            Invoice.public_last_viewed_at,
            Invoice.type,
            Invoice.invoice_kind,
            Invoice.quote_id,
            Invoice.related_invoice_id,
            Invoice.pdfa3_status,
            Invoice.facturx_spec_version,
            Invoice.issued_profile,
        )
    )
    effective_status_by_id: dict[str, str] = {}
    now = _utcnow()
    if post_filter_statuses:
        candidates = list_query.all()
        filtered_items = []
        for inv in candidates:
            effective_status = _effective_invoice_status(inv, db, now)
            effective_status_by_id[inv.id] = effective_status
            if effective_status in post_filter_statuses:
                filtered_items.append(inv)
        total = len(filtered_items)
        items = filtered_items[offset : offset + limit]
    else:
        total = query.count()
        items = list_query.offset(offset).limit(limit).all()
    _set_pagination_headers(response, request, total, limit, offset)

    customer_names: dict[str, str] = {}
    customer_emails: dict[str, str] = {}
    customer_ids = {inv.customer_id for inv in items if inv.customer_id}
    customer_by_id: dict[str, Customer] = {}
    if customer_ids:
        customer_rows = db.query(Customer).filter(Customer.tenant_id == tenant_id, Customer.id.in_(customer_ids)).all()
        customer_by_id = {row.id: row for row in customer_rows}
        customer_names = {row.id: row.name for row in customer_rows}
        customer_emails = {row.id: row.email for row in customer_rows}
    latest_followup_email_by = (
        _latest_followup_email_events_by_invoice(db, tenant_id=tenant_id, invoices=list(items))
        if payments_enabled
        else {}
    )

    results: list[dict] = []
    for inv in items:
        effective_status = (
            effective_status_by_id.get(inv.id) or _effective_invoice_status(inv, db, now)
            if payments_enabled
            else _payment_neutral_invoice_status(inv)
        )
        data = InvoiceListOut.model_validate(inv, from_attributes=True).model_dump()
        customer_email = customer_emails.get(inv.customer_id or "")
        data["customer_name"] = customer_names.get(inv.customer_id or "")
        data["customer_email"] = customer_email
        data["status"] = effective_status
        if not structured_artifacts_enabled:
            data.update(
                {
                    "pdfa3_status": None,
                    "facturx_spec_version": None,
                    "facturx_profile": None,
                }
            )
        if not data.get("due_date"):
            data["due_date"] = _compute_due_date_no_write(inv)
        if not payments_enabled:
            data.update(
                {
                    "paid_at": None,
                    "reminder_count": 0,
                    "last_reminder_at": None,
                    "days_overdue": 0,
                    "next_followup_at": None,
                    "next_followup_offset": None,
                    "followup_state": None,
                    "followup_block_reason": None,
                    "followup_schedule": [],
                    "can_followup": False,
                    **_email_event_fields(None),
                }
            )
            results.append(data)
            continue
        due_date = data.get("due_date")
        days_overdue = 0
        if effective_status == "overdue" and due_date:
            try:
                days_overdue = max((now.date() - due_date.date()).days, 0)
            except Exception:
                days_overdue = 0
        data["days_overdue"] = days_overdue
        balance_due = _outstanding(db, inv) if inv.type == "invoice" else Decimal("0")
        followup_decision = invoice_followup_decision(
            db,
            inv=inv,
            tenant=tenant,
            customer=customer_by_id.get(inv.customer_id or ""),
            balance_due=max(balance_due, Decimal("0")),
            now=now,
            due_date=due_date,
        )
        data.update(followup_decision.as_payload(include_schedule=False))
        data.update(_email_event_fields(latest_followup_email_by.get(inv.id)))
        results.append(data)
    return results
