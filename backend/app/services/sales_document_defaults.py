from __future__ import annotations

import calendar
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from ..config import settings
from ..models import Customer, Invoice, InvoiceLine, Quote, QuoteLine, Tenant
from ..schemas import PAYMENT_METHOD_OPTION_IDS
from ..utils.money import quantize_amount, to_decimal

DEFAULT_PAYMENT_TERMS = "30 jours date de facture"
DEFAULT_PAYMENT_METHODS = ["bank_transfer", "cheque", "card"]


def _blank(value: object) -> bool:
    return not str(value or "").strip()


def _clean_account(value: object | None) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().upper())[:20]


def _account_needs_default(value: object | None) -> bool:
    account = _clean_account(value)
    return not account or account.startswith("471")


def default_sales_accounting_account(tenant: Tenant | None, operation_nature: str | None = None) -> str:
    configured = _clean_account(getattr(tenant, "fec_account_revenue", None) or getattr(settings, "FEC_ACCOUNT_REVENUE", "706"))
    nature = str(operation_nature or "").strip().lower()
    if nature == "goods" and (not configured or configured == "706"):
        return "707"
    return configured or "706"


def sales_payment_terms(value: str | None, customer: Customer | None) -> str:
    explicit = str(value or "").strip()
    if explicit:
        return explicit
    customer_default = str(getattr(customer, "payment_terms_default", None) or "").strip()
    return customer_default or DEFAULT_PAYMENT_TERMS


def due_days_from_terms(payment_terms: str | None, fallback: int | None = 30) -> int:
    value = str(payment_terms or "").strip().lower()
    if any(keyword in value for keyword in ("comptant", "immédiat", "immediat", "réception", "reception")):
        return 0
    match = re.search(r"(\d+)", value)
    if match:
        try:
            return max(0, int(match.group(1)))
        except Exception:
            pass
    return max(0, int(fallback if fallback is not None else 30))


def compute_due_datetime(issue_date: datetime | None, payment_terms: str | None, due_days: int | None) -> datetime:
    base = issue_date or datetime.now(timezone.utc).replace(tzinfo=None)
    days = due_days_from_terms(payment_terms, due_days if due_days is not None else 30)
    due = base + timedelta(days=days)
    if payment_terms and ("fin de mois" in payment_terms.lower() or "fdm" in payment_terms.lower()):
        last_day = calendar.monthrange(due.year, due.month)[1]
        due = due.replace(day=last_day)
    return due


def default_quote_valid_until(issue_date: datetime | date | None, payment_terms: str | None) -> date:
    if isinstance(issue_date, datetime):
        base = issue_date.date()
    elif isinstance(issue_date, date):
        base = issue_date
    else:
        base = date.today()
    return base + timedelta(days=due_days_from_terms(payment_terms, 30))


def _normalize_payment_method(value: object | None) -> str | None:
    raw = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    aliases = {
        "virement": "bank_transfer",
        "virement_bancaire": "bank_transfer",
        "bank": "bank_transfer",
        "bank_transfer": "bank_transfer",
        "transfer": "bank_transfer",
        "cheque": "cheque",
        "chèque": "cheque",
        "check": "cheque",
        "carte": "card",
        "carte_bancaire": "card",
        "cb": "card",
        "card": "card",
        "cash": "cash",
        "espèces": "cash",
        "especes": "cash",
        "prélèvement": "direct_debit",
        "prelevement": "direct_debit",
        "direct_debit": "direct_debit",
    }
    method = aliases.get(raw, raw)
    return method if method in PAYMENT_METHOD_OPTION_IDS else None


def payment_methods_for_customer(customer: Customer | None) -> list[str]:
    method = _normalize_payment_method(getattr(customer, "payment_method_default", None))
    return [method] if method else list(DEFAULT_PAYMENT_METHODS)


def _payment_bank_account_from_tenant(tenant: Tenant | None) -> dict[str, str] | None:
    iban = str(getattr(tenant, "iban", None) or "").strip()
    bic = str(getattr(tenant, "bic", None) or "").strip()
    if not iban and not bic:
        return None
    account: dict[str, str] = {"label": "RIB émetteur"}
    if iban:
        account["iban"] = iban
    if bic:
        account["bic"] = bic
    return account


def apply_template_option_defaults(
    options: dict[str, Any] | None,
    *,
    tenant: Tenant | None,
    customer: Customer | None,
    operation_nature: str | None = None,
    prefer_customer_payment_method: bool = False,
) -> tuple[dict[str, Any], list[str]]:
    next_options = dict(options or {})
    fixes: list[str] = []

    if not isinstance(next_options.get("payment_methods"), list) or not next_options.get("payment_methods"):
        next_options["payment_methods"] = payment_methods_for_customer(customer)
        fixes.append("payment_methods")
    elif prefer_customer_payment_method:
        customer_methods = payment_methods_for_customer(customer)
        if customer_methods != DEFAULT_PAYMENT_METHODS:
            next_options["payment_methods"] = customer_methods
            fixes.append("payment_methods")

    if not isinstance(next_options.get("payment_bank_account"), dict) or not (
        str((next_options.get("payment_bank_account") or {}).get("iban") or "").strip()
        or str((next_options.get("payment_bank_account") or {}).get("bic") or "").strip()
    ):
        bank_account = _payment_bank_account_from_tenant(tenant)
        if bank_account:
            next_options["payment_bank_account"] = bank_account
            fixes.append("payment_bank_account")

    if operation_nature and _blank(next_options.get("operation_nature")):
        next_options["operation_nature"] = operation_nature
        fixes.append("operation_nature")

    return next_options, fixes


def line_accounting_account(
    value: str | None,
    *,
    tenant: Tenant | None,
    operation_nature: str | None,
) -> tuple[str | None, bool]:
    if not _account_needs_default(value):
        return _clean_account(value), False
    return default_sales_accounting_account(tenant, operation_nature), True


def apply_invoice_smart_defaults(
    invoice: Invoice,
    *,
    lines: list[InvoiceLine],
    tenant: Tenant | None,
    customer: Customer | None,
) -> list[str]:
    fixes: list[str] = []
    payment_terms = sales_payment_terms(invoice.payment_terms, customer)
    if payment_terms != (invoice.payment_terms or ""):
        invoice.payment_terms = payment_terms
        fixes.append("payment_terms")

    if invoice.due_days is None:
        invoice.due_days = due_days_from_terms(invoice.payment_terms, 30)
        fixes.append("due_days")

    if not invoice.due_date_manual:
        computed_due_date = compute_due_datetime(invoice.issue_date, invoice.payment_terms, invoice.due_days)
        if not invoice.due_date or invoice.due_date.replace(tzinfo=None) != computed_due_date.replace(tzinfo=None):
            invoice.due_date = computed_due_date
            fixes.append("due_date")

    options, option_fixes = apply_template_option_defaults(
        invoice.template_options if isinstance(invoice.template_options, dict) else {},
        tenant=tenant,
        customer=customer,
        operation_nature=invoice.operation_nature,
    )
    if option_fixes:
        invoice.template_options = options
        fixes.extend(option_fixes)

    default_account = default_sales_accounting_account(tenant, invoice.operation_nature)
    line_fixes = 0
    for line in lines:
        if str(getattr(line, "line_type", "item") or "item") != "item":
            continue
        if not _line_has_amount(line):
            continue
        account, changed = line_accounting_account(line.accounting_account, tenant=tenant, operation_nature=invoice.operation_nature)
        if changed and account:
            line.accounting_account = account or default_account
            line_fixes += 1
    if line_fixes:
        fixes.append("line_accounting_account")

    return fixes


def apply_quote_smart_defaults(
    quote: Quote,
    *,
    lines: list[QuoteLine],
    tenant: Tenant | None,
    customer: Customer | None,
) -> list[str]:
    fixes: list[str] = []
    payment_terms = sales_payment_terms(quote.payment_terms, customer)
    if payment_terms != (quote.payment_terms or ""):
        quote.payment_terms = payment_terms
        fixes.append("payment_terms")

    if not quote.valid_until:
        quote.valid_until = default_quote_valid_until(quote.issue_date, quote.payment_terms)
        fixes.append("valid_until")

    options, option_fixes = apply_template_option_defaults(
        quote.template_options if isinstance(quote.template_options, dict) else {},
        tenant=tenant,
        customer=customer,
        operation_nature=(quote.template_options or {}).get("operation_nature") if isinstance(quote.template_options, dict) else None,
    )
    if option_fixes:
        quote.template_options = options
        fixes.extend(option_fixes)

    quote_options = quote.template_options if isinstance(quote.template_options, dict) else {}
    operation_nature = str(quote_options.get("operation_nature") or "services")
    default_account = default_sales_accounting_account(tenant, operation_nature)
    line_fixes = 0
    for line in lines:
        if str(getattr(line, "line_type", "item") or "item") != "item":
            continue
        if not _line_has_amount(line):
            continue
        account, changed = line_accounting_account(line.accounting_account, tenant=tenant, operation_nature=operation_nature)
        if changed and account:
            line.accounting_account = account or default_account
            line_fixes += 1
    if line_fixes:
        fixes.append("line_accounting_account")

    return fixes


def _line_has_amount(line: InvoiceLine | QuoteLine) -> bool:
    try:
        return quantize_amount(to_decimal(getattr(line, "line_total", 0) or 0)).copy_abs() > Decimal("0.00")
    except Exception:
        return False
