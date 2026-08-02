from __future__ import annotations

import hashlib
import json
import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from ..models import Customer, EReportingLine, EReportingReport, Invoice, Payment, Tenant
from ..services.billable_events import record_billable_event
from ..services.ereporting import ensure_ereporting_allowed, payload_hash_from_fields
from ..services.pdp.service import is_fr_b2b

logger = logging.getLogger(__name__)

ALLOWED_INVOICE_STATUSES = {"issued", "sent", "paid", "overdue", "partial"}
PERIODICITY_DECADE = "decade"
PERIODICITY_MONTH = "month"
PERIODICITY_BIMONTH = "bimonth"
SUPPORTED_PERIODICITIES = {PERIODICITY_DECADE, PERIODICITY_MONTH, PERIODICITY_BIMONTH}


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _normalize_country(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip().upper() or None


def _normalize_client_type(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip().lower() or None


def _amount(value: Decimal | float | int | str | None) -> float | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (float, int)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _period_bounds(period_start: date, period_end: date) -> tuple[datetime, datetime]:
    start_dt = datetime.combine(period_start, datetime.min.time())
    end_dt = datetime.combine(period_end, datetime.max.time())
    return start_dt, end_dt


def _default_period(today: date | None = None) -> tuple[date, date]:
    current = today or date.today()
    start = current.replace(day=1)
    next_month = (start + timedelta(days=32)).replace(day=1)
    end = next_month - timedelta(days=1)
    return start, end


def _month_end(current: date) -> date:
    start = current.replace(day=1)
    next_month = (start + timedelta(days=32)).replace(day=1)
    return next_month - timedelta(days=1)


def _add_months(current: date, months: int) -> date:
    index = (current.month - 1) + months
    year = current.year + index // 12
    month = (index % 12) + 1
    day = min(current.day, _month_end(date(year, month, 1)).day)
    return date(year, month, day)


def _normalize_periodicity(value: str | None) -> str | None:
    if not value:
        return None
    key = value.strip().lower()
    mapping = {
        "decade": PERIODICITY_DECADE,
        "decadal": PERIODICITY_DECADE,
        "decade_days": PERIODICITY_DECADE,
        "decade_10": PERIODICITY_DECADE,
        "decade10": PERIODICITY_DECADE,
        "decade_10j": PERIODICITY_DECADE,
        "decade_10jours": PERIODICITY_DECADE,
        "mois": PERIODICITY_MONTH,
        "month": PERIODICITY_MONTH,
        "monthly": PERIODICITY_MONTH,
        "bimonth": PERIODICITY_BIMONTH,
        "bimonthly": PERIODICITY_BIMONTH,
        "bimestre": PERIODICITY_BIMONTH,
        "bimestriel": PERIODICITY_BIMONTH,
    }
    normalized = mapping.get(key, key)
    if normalized in SUPPORTED_PERIODICITIES:
        return normalized
    return None


def _normalize_vat_regime(regime: str | None) -> str | None:
    if not regime:
        return None
    key = regime.strip().lower()
    mapping = {
        "reel_normal": "real_normal_monthly",
        "real_normal": "real_normal_monthly",
        "real_normal_monthly": "real_normal_monthly",
        "reel_normal_monthly": "real_normal_monthly",
        "real_normal_quarterly": "real_normal_quarterly",
        "reel_normal_quarterly": "real_normal_quarterly",
        "reel_simplifie": "simplified",
        "simplifie": "simplified",
        "simplifie_agricole": "simplified",
        "simplified": "simplified",
        "franchise": "franchise",
        "franchise_base": "franchise",
        "franchise_en_base": "franchise",
        "franchise-en-base": "franchise",
        "micro": "franchise",
        "micro_entreprise": "franchise",
        "micro-entreprise": "franchise",
        "microentreprise": "franchise",
        "auto_entrepreneur": "franchise",
        "auto-entrepreneur": "franchise",
        "autoentrepreneur": "franchise",
    }
    return mapping.get(key, key)


def _default_periodicities_from_regime(regime: str | None) -> tuple[str, str]:
    normalized = _normalize_vat_regime(regime)
    mapping = {
        "real_normal_monthly": (PERIODICITY_DECADE, PERIODICITY_MONTH),
        "real_normal_quarterly": (PERIODICITY_MONTH, PERIODICITY_MONTH),
        "simplified": (PERIODICITY_MONTH, PERIODICITY_MONTH),
        "franchise": (PERIODICITY_MONTH, PERIODICITY_BIMONTH),
    }
    return mapping.get(normalized or "", (PERIODICITY_MONTH, PERIODICITY_MONTH))


def _resolve_periodicity(tenant: Tenant, report_type: str) -> str:
    if report_type == "payment":
        raw = _normalize_periodicity(getattr(tenant, "payment_periodicity", None))
        if raw in {PERIODICITY_MONTH, PERIODICITY_BIMONTH}:
            return raw
        _, fallback = _default_periodicities_from_regime(getattr(tenant, "vat_regime", None))
        return fallback
    else:
        raw = _normalize_periodicity(getattr(tenant, "transaction_periodicity", None))
        if raw in {PERIODICITY_MONTH, PERIODICITY_DECADE}:
            return raw
        fallback, _ = _default_periodicities_from_regime(getattr(tenant, "vat_regime", None))
        return fallback


def _period_for_date(periodicity: str, current: date) -> tuple[date, date]:
    if periodicity == PERIODICITY_DECADE:
        if current.day <= 10:
            start = current.replace(day=1)
            end = current.replace(day=10)
        elif current.day <= 20:
            start = current.replace(day=11)
            end = current.replace(day=20)
        else:
            start = current.replace(day=21)
            end = _month_end(current)
        return start, end
    if periodicity == PERIODICITY_BIMONTH:
        start_month = current.month if current.month % 2 == 1 else current.month - 1
        start = date(current.year, start_month, 1)
        end_month = start_month + 1
        end_year = current.year
        if end_month > 12:
            end_month = 1
            end_year += 1
        end = _month_end(date(end_year, end_month, 1))
        return start, end
    start = current.replace(day=1)
    end = _month_end(current)
    return start, end


def _previous_period(periodicity: str, period_start: date) -> tuple[date, date]:
    if periodicity == PERIODICITY_DECADE:
        if period_start.day == 1:
            prev_month = _add_months(period_start, -1)
            start = date(prev_month.year, prev_month.month, 21)
            end = _month_end(prev_month)
            return start, end
        if period_start.day == 11:
            return period_start.replace(day=1), period_start.replace(day=10)
        return period_start.replace(day=11), period_start.replace(day=20)
    if periodicity == PERIODICITY_BIMONTH:
        prev_start_month = _add_months(period_start, -2)
        start = date(prev_start_month.year, prev_start_month.month, 1)
        end = _month_end(_add_months(start, 1))
        return start, end
    prev_start_month = _add_months(period_start, -1)
    start = date(prev_start_month.year, prev_start_month.month, 1)
    end = _month_end(start)
    return start, end


def _next_period(periodicity: str, period_start: date) -> tuple[date, date]:
    if periodicity == PERIODICITY_DECADE:
        if period_start.day == 1:
            return period_start.replace(day=11), period_start.replace(day=20)
        if period_start.day == 11:
            start = period_start.replace(day=21)
            return start, _month_end(start)
        next_month = _add_months(period_start, 1)
        start = date(next_month.year, next_month.month, 1)
        return start, start.replace(day=10)
    if periodicity == PERIODICITY_BIMONTH:
        next_start_month = _add_months(period_start, 2)
        start = date(next_start_month.year, next_start_month.month, 1)
        end = _month_end(_add_months(start, 1))
        return start, end
    next_start_month = _add_months(period_start, 1)
    start = date(next_start_month.year, next_start_month.month, 1)
    end = _month_end(start)
    return start, end


def _last_completed_period(periodicity: str, today: date) -> tuple[date, date]:
    current_start, _ = _period_for_date(periodicity, today)
    return _previous_period(periodicity, current_start)


def _payments_enabled(tenant: Tenant) -> bool:
    flag = getattr(tenant, "payments_reporting_enabled", True)
    return bool(flag) if flag is not None else True


def _periods_to_generate(
    db: Session,
    tenant: Tenant,
    report_type: str,
    today: date,
) -> list[tuple[date, date]]:
    if report_type == "payment" and not _payments_enabled(tenant):
        return []
    periodicity = _resolve_periodicity(tenant, report_type)
    last_start, last_end = _last_completed_period(periodicity, today)

    last_report = (
        db.query(EReportingReport)
        .filter(EReportingReport.tenant_id == tenant.id, EReportingReport.report_type == report_type)
        .order_by(EReportingReport.period_end.desc())
        .first()
    )
    if not last_report:
        return [(last_start, last_end)]
    if last_report.period_end >= last_end:
        return []

    periods: list[tuple[date, date]] = []
    next_start, next_end = _next_period(periodicity, last_report.period_start)
    guard = 0
    while next_end <= last_end and guard < 36:
        periods.append((next_start, next_end))
        next_start, next_end = _next_period(periodicity, next_start)
        guard += 1
    return periods


def _derive_event_type(
    *,
    tenant_country: str | None,
    client_country: str | None,
    client_type: str | None,
    client_vat_number: str | None,
    kind: str,
) -> str | None:
    try:
        ensure_ereporting_allowed(
            client_country=client_country,
            client_type=client_type,
            client_vat_number=client_vat_number,
        )
    except ValueError:
        return None
    if is_fr_b2b(tenant_country, client_country, client_type):
        return None
    tenant = (_normalize_country(tenant_country) or "FR")
    client = (_normalize_country(client_country) or "FR")
    is_international = tenant != "FR" or client != "FR"
    if kind == "payment":
        return "international_payment" if is_international else "b2c_payment"
    return "international_sale" if is_international else "b2c_sale"


def _build_amounts_for_invoice(invoice: Invoice) -> dict[str, float | str]:
    amounts: dict[str, float | str] = {}
    total_ttc = _amount(invoice.total_inc_vat)
    total_ht = _amount(invoice.total_ex_vat)
    total_vat = _amount(invoice.total_vat)
    if total_ttc is not None:
        amounts["total_ttc"] = total_ttc
    if total_ht is not None:
        amounts["total_ht"] = total_ht
    if total_vat is not None:
        amounts["tax_amount"] = total_vat
    if invoice.currency:
        amounts["currency"] = invoice.currency
    return amounts


def _build_amounts_for_payment(payment: Payment, invoice: Invoice) -> dict[str, float | str]:
    amounts: dict[str, float | str] = {}
    paid = _amount(payment.amount)
    if paid is not None:
        amounts["total_ttc"] = paid
    if invoice.currency:
        amounts["currency"] = invoice.currency
    return amounts


def _line_payload_hash(
    *,
    event_type: str,
    amounts: dict | None,
    payment_date,
    country: str | None,
    client_country: str | None,
    client_vat_number: str | None,
    client_type: str | None,
) -> str:
    return payload_hash_from_fields(
        event_type=event_type,
        amounts=amounts,
        payment_date=payment_date,
        country=country,
        client_country=client_country,
        client_vat_number=client_vat_number,
        client_type=client_type,
    )


def _report_idempotency_hash(
    *,
    report_type: str,
    period_start: date,
    period_end: date,
    line_hashes: list[str],
) -> str:
    payload = {
        "type": report_type,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "lines": sorted(line_hashes),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _safe_vat_number(client_type: str | None, vat_number: str | None) -> str | None:
    normalized = _normalize_client_type(client_type)
    if normalized not in {"business", "company", "b2b", "professional"}:
        return None
    return _clean(vat_number)


def build_report(
    db: Session,
    *,
    tenant_id: str,
    report_type: str,
    period_start: date | None = None,
    period_end: date | None = None,
    provider_slug: str | None = None,
) -> EReportingReport | None:
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        return None
    start_date, end_date = _default_period() if not period_start or not period_end else (period_start, period_end)
    start_dt, end_dt = _period_bounds(start_date, end_date)

    lines: list[EReportingLine] = []
    line_hashes: list[str] = []
    tenant_country = tenant.country or "FR"

    if report_type == "transaction":
        rows = (
            db.query(Invoice, Customer)
            .join(Customer, Invoice.customer_id == Customer.id)
            .filter(Invoice.tenant_id == tenant_id)
            .filter(Invoice.type.in_(("invoice", "credit_note")))
            .filter(Invoice.status.in_(ALLOWED_INVOICE_STATUSES))
            .filter(Invoice.issue_date >= start_dt, Invoice.issue_date <= end_dt)
            .all()
        )
        for invoice, customer in rows:
            event_type = _derive_event_type(
                tenant_country=tenant_country,
                client_country=customer.country,
                client_type=customer.client_type,
                client_vat_number=customer.vat_number,
                kind="transaction",
            )
            if not event_type:
                continue
            amounts = _build_amounts_for_invoice(invoice)
            line_hash = _line_payload_hash(
                event_type=event_type,
                amounts=amounts or None,
                payment_date=None,
                country=tenant_country,
                client_country=customer.country,
                client_vat_number=_safe_vat_number(customer.client_type, customer.vat_number),
                client_type=customer.client_type,
            )
            line_hashes.append(line_hash)
            lines.append(
                EReportingLine(
                    source_type="credit_note" if invoice.type == "credit_note" else "invoice",
                    source_id=invoice.id,
                    event_type=event_type,
                    status="pending",
                    payload_hash=line_hash,
                    amounts=amounts or None,
                    payment_date=None,
                    country=_normalize_country(tenant_country),
                    client_country=_normalize_country(customer.country),
                    client_vat_number=_safe_vat_number(customer.client_type, customer.vat_number),
                    client_type=_normalize_client_type(customer.client_type),
                )
            )
    elif report_type == "payment":
        rows = (
            db.query(Payment, Invoice, Customer)
            .join(Invoice, Payment.invoice_id == Invoice.id)
            .join(Customer, Invoice.customer_id == Customer.id)
            .filter(Invoice.tenant_id == tenant_id)
            .filter(Payment.date >= start_dt, Payment.date <= end_dt)
            .all()
        )
        for payment, invoice, customer in rows:
            event_type = _derive_event_type(
                tenant_country=tenant_country,
                client_country=customer.country,
                client_type=customer.client_type,
                client_vat_number=customer.vat_number,
                kind="payment",
            )
            if not event_type:
                continue
            amounts = _build_amounts_for_payment(payment, invoice)
            line_hash = _line_payload_hash(
                event_type=event_type,
                amounts=amounts or None,
                payment_date=payment.date.date() if payment.date else None,
                country=tenant_country,
                client_country=customer.country,
                client_vat_number=_safe_vat_number(customer.client_type, customer.vat_number),
                client_type=customer.client_type,
            )
            line_hashes.append(line_hash)
            lines.append(
                EReportingLine(
                    source_type="payment",
                    source_id=payment.id,
                    event_type=event_type,
                    status="pending",
                    payload_hash=line_hash,
                    amounts=amounts or None,
                    payment_date=payment.date.date() if payment.date else None,
                    country=_normalize_country(tenant_country),
                    client_country=_normalize_country(customer.country),
                    client_vat_number=_safe_vat_number(customer.client_type, customer.vat_number),
                    client_type=_normalize_client_type(customer.client_type),
                )
            )
    else:
        return None

    if not lines:
        logger.info(
            json.dumps(
                {
                    "event": "ereporting_report_skip",
                    "tenant_id": tenant_id,
                    "report_type": report_type,
                    "period_start": start_date.isoformat(),
                    "period_end": end_date.isoformat(),
                    "reason": "no_lines",
                }
            )
        )
        return None

    idempotency_hash = _report_idempotency_hash(
        report_type=report_type,
        period_start=start_date,
        period_end=end_date,
        line_hashes=line_hashes,
    )
    existing = (
        db.query(EReportingReport)
        .filter(
            EReportingReport.tenant_id == tenant_id,
            EReportingReport.report_type == report_type,
            EReportingReport.period_start == start_date,
            EReportingReport.period_end == end_date,
            EReportingReport.idempotency_hash == idempotency_hash,
        )
        .first()
    )
    if existing:
        db.refresh(existing)
        db.expunge(existing)
        return existing

    report = EReportingReport(
        tenant_id=tenant_id,
        provider_slug=_clean(provider_slug),
        report_type=report_type,
        period_start=start_date,
        period_end=end_date,
        status="pending",
        idempotency_hash=idempotency_hash,
        payload_hash=idempotency_hash,
        line_count=len(lines),
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        updated_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(report)
    db.flush()
    for line in lines:
        line.report_id = report.id
        db.add(line)
    db.commit()
    db.refresh(report)
    db.expunge(report)
    logger.info(
        json.dumps(
            {
                "event": "ereporting_report_created",
                "tenant_id": tenant_id,
                "report_id": report.id,
                "report_type": report_type,
                "period_start": start_date.isoformat(),
                "period_end": end_date.isoformat(),
                "line_count": report.line_count,
            }
        )
    )
    try:
        record_billable_event(
            db,
            tenant_id=tenant_id,
            event_type="ereporting_generate",
            provider_slug=report.provider_slug,
            invoice_id=None,
            status=report.status,
            source_type="ereporting_report",
            source_id=report.id,
            occurred_at=report.created_at,
            commit=True,
        )
    except Exception:
        logger.warning(
            "billable_event_ereporting_failed",
            extra={"tenant_id": tenant_id, "report_id": report.id},
        )
    return report


def build_reports(
    db: Session,
    *,
    tenant_id: str,
    period_start: date | None = None,
    period_end: date | None = None,
    report_type: str | None = None,
    provider_slug: str | None = None,
    today: date | None = None,
) -> list[EReportingReport]:
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        return []
    types = [report_type] if report_type else ["transaction", "payment"]
    reports: list[EReportingReport] = []
    for typ in types:
        if typ == "payment" and not _payments_enabled(tenant):
            continue
        periods: list[tuple[date, date]] = []
        if period_start and period_end:
            periods = [(period_start, period_end)]
        else:
            periods = _periods_to_generate(db, tenant, typ, today or date.today())
        for start_date, end_date in periods:
            report = build_report(
                db,
                tenant_id=tenant_id,
                report_type=typ,
                period_start=start_date,
                period_end=end_date,
                provider_slug=provider_slug,
            )
            if report:
                reports.append(report)
    return reports
