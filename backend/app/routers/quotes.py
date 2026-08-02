from __future__ import annotations

import logging
import re
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from urllib.parse import urlencode, urlparse, parse_qs, urlunparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func, or_
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, load_only

from .. import metrics
from ..config import settings
from ..db import get_db
from ..deps import (
    API_SCOPE_READ_INVOICES,
    API_SCOPE_WRITE_INVOICES,
    AuthUser,
    ensure_legal_acceptance,
    require_accountant_or_admin_or_api_key,
    require_commercial_or_api_key,
    require_paid_subscription_or_trial,
    require_paid_subscription_or_api_key,
    require_viewer_or_admin_or_api_key,
)
from ..models import ActionLog, Customer, Invoice, Quote, QuoteLine, QuoteNumbering, Tenant, User
from ..schemas import (
    AccountingLinesUpdate,
    InvoiceCreate,
    InvoiceLineIn,
    QuoteCreate,
    QuoteEmailRequest,
    QuoteFollowupRequest,
    QuoteLineOut,
    QuoteOut,
    QuoteShareOut,
    QuoteTimelineEvent,
    QuoteUpdate,
)
from ..jobs.email_jobs import enqueue_quote_email, enqueue_quote_followup_email, record_quote_email_log_only
from ..services.action_logs import log_action
from ..services.email import assert_smtp_ready_or_raise, render_email_template
from ..services.document_email import build_document_email_context, normalize_document_email_body_text
from ..services.email_reply_to import clean_document_reply_email, resolve_document_reply_to
from ..services.accounting_readiness import quote_accounting_readiness
from ..services.sales_document_defaults import (
    apply_template_option_defaults,
    default_quote_valid_until,
    line_accounting_account,
    sales_payment_terms,
)
from ..services.sales_document_readiness import quote_readiness
from ..services.seqino_periodicity_payload import is_vat_franchise_regime
from ..services.recipients import join_emails, parse_emails, resolve_customer_recipients
from ..services.sales_email_assist import build_quote_email_draft
from ..services.trial_document_email import ensure_document_email_delivery_allowed
from ..services.public_links import (
    is_quote_public_link_expired,
    quote_public_link_days_left,
    quote_public_link_expires_at,
    quote_public_link_ttl_days,
)
from ..services.document_pdf_context import (
    attach_discount_display_metadata,
    global_discount_vat_breakdown_error,
    split_pdf_lines_and_adjustments,
    sum_pdf_amount,
)
from ..services.invoices.deposits import deposit_invoice_net_amounts
from ..services.document_notes import visible_document_note
from ..services.branding_settings import get_branding_settings
from ..services import rate_limit
from ..services.quote_proof import clear_quote_seal, ensure_quote_sealed
from ..services.pdf import invoice_html, invoice_pdf
from ..services.quote_advances import invoice_template_options_from_quote, requested_quote_advance_total_ttc
from ..services.storage import delete_object
from ..utils.money import MAX_DOCUMENT_AMOUNT, calc_line_total, calc_tax_amount, ensure_max_abs, quantize_amount
from ..utils.pii import mask_email


router = APIRouter(prefix="/api/quotes", tags=["quotes"])
logger = logging.getLogger("quotes.email")

QUOTE_STATUSES = {"draft", "sent", "accepted", "rejected", "invoiced", "expired"}
IMMUTABLE_QUOTE_STATUSES = {"sent", "accepted", "rejected", "invoiced", "expired"}


def _quote_for_update(db: Session, quote_id: str) -> Quote | None:
    try:
        return db.query(Quote).filter(Quote.id == quote_id).with_for_update().first()
    except OperationalError as exc:
        raise HTTPException(429, "Devis en cours de traitement, réessayez dans un instant.") from exc


def _ordered_quote_line_id(quote_id: str, index: int) -> str:
    return f"{quote_id}-{index:04d}-{uuid.uuid4().hex[:8]}"


def _document_line_type(line: object) -> str:
    line_type = str(getattr(line, "line_type", None) or "item").strip().lower()
    return line_type if line_type in {"item", "title", "comment"} else "item"


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
        if _document_line_type(line) != "item":
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


def _ensure_document_line_quota(lines: list[object], label: str) -> None:
    max_lines = int(getattr(settings, "MAX_INVOICE_LINES", 200) or 0)
    if max_lines > 0 and len(lines) > max_lines:
        metrics.inc_operational_event("quota_exceeded")
        logger.warning("quota_exceeded", extra={"scope": "quote_lines", "line_count": len(lines)})
        raise HTTPException(
            status_code=400,
            detail={
                "code": "document_lines_quota_exceeded",
                "message": f"{label} limité à {max_lines} lignes. Scindez le document ou utilisez un export dédié.",
            },
        )


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _digits(value: object | None) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _derive_siren(value: object | None) -> str:
    return _digits(value)[:9]


def _address_text(
    fallback: object | None,
    line1: object | None,
    line2: object | None,
    postal_code: object | None,
    city: object | None,
    country_code: object | None,
) -> str:
    structured = [
        str(line1 or "").strip(),
        str(line2 or "").strip(),
        " ".join(part for part in [str(postal_code or "").strip(), str(city or "").strip()] if part),
        str(country_code or "").strip(),
    ]
    text = "\n".join(part for part in structured if part)
    return text or str(fallback or "").strip()


def _require_role_accountant(user: AuthUser) -> None:
    if user.is_api_key:
        if API_SCOPE_WRITE_INVOICES in user.scopes:
            return
        raise HTTPException(403, "Droits comptables requis")
    if not user.is_admin and user.role not in {"owner", "admin", "accountant"}:
        raise HTTPException(403, "Droits comptables requis")


def _safe_filename(prefix: str, number: str | None, ext: str) -> str:
    base = (number or "").strip() or "document"
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", base)
    return f"{prefix}-{cleaned}.{ext}"


def _frontend_base_url() -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    return base.rstrip("/")


def _template_advance_total_ttc(options: dict | None) -> Decimal:
    return requested_quote_advance_total_ttc(options)


def _validate_quote_advances_do_not_exceed_total(template_options: dict | None, total_inc_vat: Decimal) -> None:
    requested = _template_advance_total_ttc(template_options)
    total = quantize_amount(total_inc_vat)
    if requested > max(total, Decimal("0.00")) + Decimal("0.01"):
        raise HTTPException(400, "Le montant de l'acompte demandé ne peut pas dépasser le total TTC du devis.")


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
            detail={"code": "amount_too_large", "message": str(exc)},
        )


def _quote_public_url(token: str) -> str:
    base = _frontend_base_url()
    path = f"/q/{token}"
    return f"{base}{path}" if base else path


def _generate_public_token() -> str:
    # ~43 chars URL-safe. Suffisant pour éviter toute énumération.
    return secrets.token_urlsafe(32)


def _ensure_quote_public_link(db: Session, quote: Quote) -> str:
    if quote.public_token and quote.public_enabled and not is_quote_public_link_expired(quote):
        return quote.public_token
    needs_new_token = not quote.public_token or is_quote_public_link_expired(quote)
    if needs_new_token:
        # Éviter les collisions (extrêmement improbables mais on reste safe)
        for _ in range(8):
            candidate = _generate_public_token()
            exists = db.query(Quote.id).filter(Quote.public_token == candidate).first()
            if not exists:
                quote.public_token = candidate
                break
        if not quote.public_token:
            raise HTTPException(500, "Impossible de générer un lien public")
        quote.public_created_at = _utcnow()
    quote.public_enabled = True
    if not quote.public_created_at:
        quote.public_created_at = _utcnow()
    db.add(quote)
    return quote.public_token


def _quote_preview_link(quote: Quote, include_link: bool) -> str:
    if not include_link:
        return ""
    if quote.public_token and quote.public_enabled and not is_quote_public_link_expired(quote):
        return _quote_public_url(quote.public_token)
    return _quote_public_url("apercu-client")


def _quote_share_out(quote: Quote, *, enabled: bool | None = None, public_url: str | None = None) -> QuoteShareOut:
    expired = is_quote_public_link_expired(quote)
    is_enabled = bool(quote.public_enabled and quote.public_token and not expired) if enabled is None else bool(enabled)
    if not is_enabled:
        public_url = None
    elif public_url is None and quote.public_token:
        public_url = _quote_public_url(quote.public_token)
    return QuoteShareOut(
        enabled=is_enabled,
        public_url=public_url,
        expires_at=quote_public_link_expires_at(quote) if is_enabled else None,
        expires_in_days=quote_public_link_days_left(quote) if is_enabled else None,
        validity_days=quote_public_link_ttl_days(),
        expired=expired,
    )


def _quote_link_meta(quote: Quote, quote_link: str | None) -> list[tuple[str, str]]:
    if not quote_link:
        return []
    if "apercu-client" in quote_link:
        return []
    expires_at = quote_public_link_expires_at(quote)
    if not expires_at:
        return []
    return [("Lien valable jusqu'au", expires_at.strftime("%d/%m/%Y"))]


def _quote_default_email_body(*, include_link: bool) -> str:
    if include_link:
        return (
            "Bonjour {client},\n\n"
            "Votre devis {number} est disponible. Montant TTC : {total_ttc} {currency}. "
            "Il est valable jusqu'au {valid_until}.\n\n"
            "Pour accepter ou signer ce devis, cliquez sur le bouton « Voir le devis », "
            "puis validez-le depuis le portail sécurisé. Tant que cette validation n'est pas faite, "
            "le devis reste en attente."
        )
    return (
        "Bonjour {client},\n\n"
        "Votre devis {number} est disponible. Montant TTC : {total_ttc} {currency}. "
        "Il est valable jusqu'au {valid_until}.\n\n"
        "Vous trouverez le devis en pièce jointe."
    )


_QUOTE_ACCEPTANCE_INSTRUCTION = (
    "Pour accepter ou signer ce devis, cliquez sur le bouton « Voir le devis », "
    "puis validez-le depuis le portail sécurisé. Tant que cette validation n'est pas faite, "
    "le devis reste en attente."
)


def _ensure_quote_acceptance_instruction(text: str, *, include_link: bool) -> str:
    value = (text or "").strip()
    if not include_link:
        return value
    normalized = value.lower()
    has_button_instruction = "voir le devis" in normalized and (
        "accepter" in normalized or "signer" in normalized or "validez" in normalized
    )
    if has_button_instruction:
        return value
    return f"{value}\n\n{_QUOTE_ACCEPTANCE_INSTRUCTION}".strip()


def _quote_bank_meta(tenant: Tenant, quote: Quote) -> list[tuple[str, str]]:
    template_options = quote.template_options if isinstance(quote.template_options, dict) else {}
    payment_account = template_options.get("payment_bank_account")
    payment_account = payment_account if isinstance(payment_account, dict) else {}
    supplier_snapshot = quote.supplier_snapshot if isinstance(quote.supplier_snapshot, dict) else {}
    iban = (
        str(payment_account.get("iban") or "").strip()
        or str(supplier_snapshot.get("iban") or "").strip()
        or str(getattr(tenant, "iban", "") or "").strip()
    )
    bic = (
        str(payment_account.get("bic") or "").strip()
        or str(supplier_snapshot.get("bic") or "").strip()
        or str(getattr(tenant, "bic", "") or "").strip()
    )
    rows: list[tuple[str, str]] = []
    if iban:
        rows.append(("IBAN", iban))
    if bic:
        rows.append(("BIC", bic))
    return rows


def _rotate_quote_public_link(db: Session, quote: Quote) -> str:
    """Rotate the public token (invalidate previous links)."""
    # Éviter les collisions (extrêmement improbables mais on reste safe)
    for _ in range(8):
        candidate = _generate_public_token()
        exists = db.query(Quote.id).filter(Quote.public_token == candidate).first()
        if not exists:
            quote.public_token = candidate
            break
    if not quote.public_token:
        raise HTTPException(500, "Impossible de générer un nouveau lien public")
    quote.public_enabled = True
    quote.public_created_at = _utcnow()
    db.add(quote)
    return quote.public_token


def _disable_quote_public_link(db: Session, quote: Quote) -> None:
    quote.public_enabled = False
    db.add(quote)


def _format_quote_template(
    template: str,
    *,
    quote: Quote,
    customer: Customer,
    tenant: Tenant,
    quote_link: str,
    reply_to: str | None = None,
) -> str:
    if not template:
        return ""

    def _fmt_date(d: date | datetime | None) -> str:
        if not d:
            return ""
        if isinstance(d, datetime):
            d = d.date()
        try:
            return d.strftime("%d/%m/%Y")
        except Exception:
            return str(d)

    def _fmt_amount(v: object | None) -> str:
        if v is None:
            return ""
        try:
            return f"{Decimal(str(v)):.2f}"
        except Exception:
            try:
                return f"{float(str(v)):.2f}"
            except Exception:
                return str(v)

    mapping = {
        "{client}": (customer.name or "").strip(),
        "{company}": (tenant.name or "").strip(),
        "{reply_to}": (reply_to or "").strip(),
        "{number}": (quote.number or "").strip(),
        "{quote_link}": quote_link,
        "{valid_until}": _fmt_date(quote.valid_until),
        "{issue_date}": _fmt_date(quote.issue_date),
        "{total_ttc}": _fmt_amount(quote.total_inc_vat),
        "{total_ht}": _fmt_amount(quote.total_ex_vat),
        "{total_tva}": _fmt_amount(quote.total_vat),
        "{currency}": (quote.currency or "EUR").strip(),
    }
    out = template
    for k, v in mapping.items():
        out = out.replace(k, v)
    return out


def _enforce_quote_email_rate_limits(tenant_id: str) -> None:
    if getattr(settings, "DISABLE_RATE_LIMITS", False):
        return
    now = _utcnow()
    per_hour = int(getattr(settings, "QUOTE_EMAIL_RATE_LIMIT_PER_HOUR", 30) or 30)
    generic_per_hour = int(getattr(settings, "MAX_EMAILS_PER_HOUR", 60) or 0)
    if per_hour > 0 and generic_per_hour > 0:
        per_hour = min(per_hour, generic_per_hour)
    elif generic_per_hour > 0:
        per_hour = generic_per_hour
    per_day = int(getattr(settings, "QUOTE_EMAIL_RATE_LIMIT_PER_DAY", 200) or 200)
    if rate_limit.hit(f"quote-email:{tenant_id}:{now.strftime('%Y%m%d%H')}", per_hour, 3600):
        metrics.inc_operational_event("quota_exceeded")
        logger.warning("quota_exceeded", extra={"scope": "quote_email", "tenant_id": tenant_id})
        raise HTTPException(
            429, detail={"code": "quote_email_rate_limited", "message": "Trop d'emails devis (limite horaire)."}
        )
    if rate_limit.hit(f"quote-email:{tenant_id}:{now.strftime('%Y%m%d')}", per_day, 86400):
        metrics.inc_operational_event("quota_exceeded")
        logger.warning("quota_exceeded", extra={"scope": "quote_email", "tenant_id": tenant_id})
        raise HTTPException(
            429, detail={"code": "quote_email_rate_limited", "message": "Trop d'emails devis (limite journalière)."}
        )


def _next_quote_number(db: Session, tenant_id: str, year: int | None = None) -> str:
    try:
        n = db.query(QuoteNumbering).filter(QuoteNumbering.tenant_id == tenant_id).with_for_update().first()
    except OperationalError:
        raise HTTPException(429, "Numérotation devis en cours d'utilisation, réessayez dans un instant.")
    if not n:
        n = QuoteNumbering(tenant_id=tenant_id, prefix="D-", last_index=0)
        db.add(n)
        db.flush()
    issue_year = year or _utcnow().year
    if not n.year or n.year != issue_year:
        n.year = issue_year
        n.last_index = 0
    n.last_index += 1
    db.add(n)
    prefix = (n.prefix or "D-").strip() or "D-"
    return f"{prefix}{n.year}-{n.last_index:04d}"


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


def _parse_amount_filter(raw_amount: str | None) -> Decimal | None:
    if not raw_amount:
        return None
    cleaned = raw_amount.strip().replace(" ", "").replace(",", ".")
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except Exception:
        return None


def _parse_date_bound(raw_date: str | None, *, end: bool = False) -> datetime | None:
    if not raw_date:
        return None
    cleaned = raw_date.strip()
    if not cleaned:
        return None
    try:
        parsed = date.fromisoformat(cleaned)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Date invalide: {cleaned}. Format attendu YYYY-MM-DD.")
    bound = datetime(parsed.year, parsed.month, parsed.day)
    return bound + timedelta(days=1) if end else bound


def _operation_nature_label(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip().lower()
    if v == "goods":
        return "Vente de biens"
    if v == "services":
        return "Prestations de services"
    if v == "mixed":
        return "Biens et services"
    return None


def _quote_out(
    quote: Quote,
    *,
    customer_name: str | None = None,
    customer_email: str | None = None,
    lines: list[QuoteLine] | None = None,
    accounting_readiness: dict | None = None,
    lineage: dict[str, str | None] | None = None,
) -> QuoteOut:
    template_options = getattr(quote, "template_options", None)
    template_options_dict = template_options if isinstance(template_options, dict) else {}
    document_title = template_options_dict.get("document_title")
    lineage = lineage or {}
    return QuoteOut(
        id=quote.id,
        customer_id=quote.customer_id,
        number=quote.number,
        currency=quote.currency,
        status=quote.status,
        issue_date=quote.issue_date,
        updated_at=getattr(quote, "updated_at", None),
        valid_until=quote.valid_until,
        service_date=quote.service_date,
        template_key=getattr(quote, "template_key", None),
        template_options=getattr(quote, "template_options", None),
        payment_terms=quote.payment_terms,
        purchase_order_number=quote.purchase_order_number,
        sent_at=quote.sent_at,
        accepted_at=quote.accepted_at,
        accepted_name=getattr(quote, "accepted_name", None),
        accepted_email=getattr(quote, "accepted_email", None),
        rejected_at=quote.rejected_at,
        rejected_reason=getattr(quote, "rejected_reason", None),
        public_enabled=getattr(quote, "public_enabled", None),
        public_view_count=getattr(quote, "public_view_count", None),
        public_first_viewed_at=getattr(quote, "public_first_viewed_at", None),
        public_last_viewed_at=getattr(quote, "public_last_viewed_at", None),
        seal_hash=getattr(quote, "seal_hash", None),
        seal_created_at=getattr(quote, "seal_created_at", None),
        accepted_terms_url=getattr(quote, "accepted_terms_url", None),
        accepted_terms_at=getattr(quote, "accepted_terms_at", None),
        reminder_count=getattr(quote, "reminder_count", None),
        last_reminder_at=getattr(quote, "last_reminder_at", None),
        total_ex_vat=float(quote.total_ex_vat or 0),
        total_vat=float(quote.total_vat or 0),
        total_inc_vat=float(quote.total_inc_vat or 0),
        note=visible_document_note(quote.note, document_title, template_options_dict.get("legal_mentions_text")),
        invoice_id=quote.invoice_id,
        duplicate_of_id=getattr(quote, "duplicate_of_id", None),
        duplicate_of_number=lineage.get("duplicate_of_number"),
        latest_duplicate_id=lineage.get("latest_duplicate_id"),
        latest_duplicate_number=lineage.get("latest_duplicate_number"),
        customer_name=customer_name,
        customer_email=customer_email,
        lines=[QuoteLineOut.model_validate(line) for line in lines] if lines is not None else None,
        accounting_readiness=accounting_readiness,
    )


def _quote_lineage(db: Session, quote: Quote) -> dict[str, str | None]:
    duplicate_of_number = None
    duplicate_of_id = str(getattr(quote, "duplicate_of_id", "") or "")
    if duplicate_of_id:
        source = (
            db.query(Quote)
            .options(load_only(Quote.id, Quote.tenant_id, Quote.number))
            .filter(Quote.id == duplicate_of_id, Quote.tenant_id == quote.tenant_id)
            .first()
        )
        duplicate_of_number = source.number if source else None

    latest = (
        db.query(Quote)
        .options(load_only(Quote.id, Quote.number, Quote.created_at))
        .filter(Quote.tenant_id == quote.tenant_id, Quote.duplicate_of_id == quote.id)
        .order_by(Quote.created_at.desc(), Quote.id.desc())
        .first()
    )
    return {
        "duplicate_of_number": duplicate_of_number,
        "latest_duplicate_id": latest.id if latest else None,
        "latest_duplicate_number": latest.number if latest else None,
    }


def _quote_ctx(db: Session, quote: Quote) -> dict:
    tenant = db.get(Tenant, quote.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    customer = db.get(Customer, quote.customer_id)
    if not customer:
        raise HTTPException(404, "Client introuvable")

    def _parse_amount(v: object | None) -> Decimal:
        if v is None:
            return Decimal("0")
        try:
            return quantize_amount(Decimal(str(v)))
        except Exception:
            return Decimal("0")

    # Les brouillons restent éditables: un ancien lien public ne doit pas figer
    # l'aperçu back-office sur un snapshot obsolète.
    use_sealed_snapshot = quote.status != "draft"
    supplier_snapshot = getattr(quote, "supplier_snapshot", None) if use_sealed_snapshot else None
    buyer_snapshot = getattr(quote, "buyer_snapshot", None) if use_sealed_snapshot else None
    lines_snapshot = getattr(quote, "lines_snapshot", None) if use_sealed_snapshot else None
    totals_snapshot = getattr(quote, "totals_snapshot", None) if use_sealed_snapshot else None

    template_options = getattr(quote, "template_options", None)
    if not isinstance(template_options, dict):
        template_options = {}

    supplier_source = supplier_snapshot if isinstance(supplier_snapshot, dict) else {}
    supplier_siret = supplier_source.get("siret") or supplier_source.get("legal_id") or tenant.siret
    supplier_address = _address_text(
        supplier_source.get("address") or tenant.address,
        supplier_source.get("address_line1") or tenant.address_line1,
        supplier_source.get("address_line2") or tenant.address_line2,
        supplier_source.get("postal_code") or tenant.postal_code,
        supplier_source.get("city") or tenant.city,
        supplier_source.get("country_code") or tenant.country_code or tenant.country,
    )
    supplier = {
        "name": supplier_source.get("name") or tenant.name,
        "legal_id": supplier_siret,
        "siret": supplier_siret,
        "siren": supplier_source.get("siren") or _derive_siren(supplier_siret),
        "vat_number": supplier_source.get("vat_number") or tenant.vat_number,
        "naf_code": supplier_source.get("naf_code") or getattr(tenant, "naf_code", None),
        "vat_exemption_notice": supplier_source.get("vat_exemption_notice") or tenant.vat_exemption_notice,
        "vat_regime": supplier_source.get("vat_regime") or getattr(tenant, "vat_regime", None),
        "legal_form": supplier_source.get("legal_form") or tenant.legal_form,
        "share_capital": supplier_source.get("share_capital") or tenant.share_capital,
        "rcs": supplier_source.get("rcs") or tenant.rcs,
        "address": supplier_address,
        "address_line1": supplier_source.get("address_line1") or tenant.address_line1,
        "address_line2": supplier_source.get("address_line2") or tenant.address_line2,
        "postal_code": supplier_source.get("postal_code") or tenant.postal_code,
        "city": supplier_source.get("city") or tenant.city,
        "country_code": supplier_source.get("country_code") or tenant.country_code or tenant.country,
        "country": supplier_source.get("country") or tenant.country or tenant.country_code,
        "email": supplier_source.get("email")
        or supplier_source.get("email_reply_to")
        or getattr(tenant, "email_reply_to", None),
        "phone": supplier_source.get("phone") or getattr(tenant, "phone", None),
        "iban": supplier_source.get("iban") or tenant.iban,
        "bic": supplier_source.get("bic") or tenant.bic,
        "logo_url": supplier_source.get("logo_url") or tenant.logo_url,
        "legal_mentions": supplier_source.get("legal_mentions") or tenant.legal_mentions,
        "vat_on_debits": bool(
            supplier_source.get("vat_on_debits") if "vat_on_debits" in supplier_source else bool(tenant.vat_on_debits)
        ),
        "payment_terms_block": supplier_source.get("payment_terms_block")
        or {
            "discount_terms": tenant.discount_terms,
            "late_payment_interest": tenant.late_payment_interest,
            "recovery_fee_eur": float(tenant.recovery_fee_eur) if tenant.recovery_fee_eur is not None else 40,
        },
    }
    payment_bank_account = template_options.get("payment_bank_account")
    if isinstance(payment_bank_account, dict):
        payment_iban = str(payment_bank_account.get("iban") or "").strip()
        payment_bic = str(payment_bank_account.get("bic") or "").strip()
        if payment_iban or payment_bic:
            supplier["iban"] = payment_iban or None
            supplier["bic"] = payment_bic or None

    customer_siren = getattr(customer, "siren", None) or ""

    buyer_source = buyer_snapshot if isinstance(buyer_snapshot, dict) else {}
    buyer_siret = buyer_source.get("siret") or customer.siret
    buyer_address = _address_text(
        buyer_source.get("address") or customer.address,
        buyer_source.get("address_line1") or customer.address_line1,
        buyer_source.get("address_line2") or customer.address_line2,
        buyer_source.get("postal_code") or customer.postal_code,
        buyer_source.get("city") or customer.city,
        buyer_source.get("country_code") or customer.country_code or customer.country,
    )
    customer_ctx = {
        "name": buyer_source.get("name") or customer.name,
        "siret": buyer_siret,
        "siren": buyer_source.get("siren") or getattr(customer, "siren", None) or _derive_siren(buyer_siret),
        "vat_number": buyer_source.get("vat_number") or customer.vat_number,
        "email": buyer_source.get("email") or customer.email,
        "phone": buyer_source.get("phone") or customer.phone,
        "address": buyer_address,
        "address_line1": buyer_source.get("address_line1") or customer.address_line1,
        "address_line2": buyer_source.get("address_line2") or customer.address_line2,
        "postal_code": buyer_source.get("postal_code") or customer.postal_code,
        "city": buyer_source.get("city") or customer.city,
        "country_code": buyer_source.get("country_code") or customer.country_code or customer.country,
        "country": buyer_source.get("country") or customer.country or customer.country_code,
    }
    if not customer_siren and (customer_ctx.get("siret") or ""):
        customer_siren = "".join(ch for ch in (customer_ctx.get("siret") or "") if ch.isdigit())[:9]

    template_options = getattr(quote, "template_options", None)
    if not isinstance(template_options, dict):
        template_options = {}
    quote_operation_nature = (
        str(template_options.get("operation_nature") or getattr(quote, "operation_nature", None) or "services")
        .strip()
        .lower()
    )
    quote_delivery_address = str(
        template_options.get("delivery_address") or getattr(quote, "delivery_address", None) or ""
    ).strip()
    quote_delivery_differs = bool(
        template_options.get("delivery_address_differs") or getattr(quote, "delivery_address_differs", False)
    )

    # On réutilise le template invoice.html en passant un objet "invoice" de type quote.
    invoice_like = {
        "number": quote.number,
        "type": "quote",
        "status": quote.status,
        "issue_date": quote.issue_date,
        "service_date": quote.service_date,
        # invoice.due_date est affichée dans le template ; on l'utilise pour la date de validité
        "due_date": quote.valid_until,
        "payment_terms": quote.payment_terms,
        "purchase_order_number": quote.purchase_order_number,
        "delivery_address": quote_delivery_address or None,
        "delivery_address_differs": quote_delivery_differs,
        "operation_nature": quote_operation_nature or "services",
        "related_number": None,
        "balance_due": None,
    }

    totals_source = totals_snapshot if isinstance(totals_snapshot, dict) else {}
    totals = SimpleNamespace(
        ht=_parse_amount(totals_source.get("total_ex_vat") if totals_source else quote.total_ex_vat or 0),
        vat=_parse_amount(totals_source.get("total_vat") if totals_source else quote.total_vat or 0),
        ttc=_parse_amount(totals_source.get("total_inc_vat") if totals_source else quote.total_inc_vat or 0),
    )

    if isinstance(lines_snapshot, list) and lines_snapshot:
        raw_lines: list[dict[str, object]] = []
        for raw in lines_snapshot:
            if not isinstance(raw, dict):
                continue
            raw_lines.append(
                {
                    "line_type": raw.get("line_type") or "item",
                    "display_number": raw.get("display_number"),
                    "reference": raw.get("reference"),
                    "product_name": raw.get("product_name") or "",
                    "detail": raw.get("detail"),
                    "quantity": _parse_amount(raw.get("quantity")),
                    "unit_price": _parse_amount(raw.get("unit_price")),
                    "vat_rate": _parse_amount(raw.get("vat_rate")),
                    "vat_category": raw.get("vat_category") or "S",
                    "exemption_reason_code": raw.get("exemption_reason_code"),
                    "unit_code": raw.get("unit_code") or "C62",
                    "item_id": raw.get("item_id"),
                    "line_total": _parse_amount(raw.get("line_total")),
                }
            )
    else:
        quote_lines = db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).order_by(QuoteLine.id.asc()).all()
        raw_lines = [
            {
                "line_type": line.line_type or "item",
                "display_number": line.display_number,
                "reference": line.reference,
                "product_name": line.product_name,
                "detail": line.detail,
                "quantity": line.quantity,
                "unit_price": line.unit_price,
                "vat_rate": line.vat_rate,
                "vat_category": line.vat_category,
                "exemption_reason_code": line.exemption_reason_code,
                "unit_code": line.unit_code,
                "item_id": line.item_id,
                "line_total": line.line_total,
            }
            for line in quote_lines
        ]

    regular_lines, header_allowances, advance_payments = split_pdf_lines_and_adjustments(raw_lines)
    lines = attach_discount_display_metadata(regular_lines, header_allowances)
    totals.allowance = sum_pdf_amount(header_allowances, "amount_ht")
    totals.prepaid = quantize_amount(
        sum_pdf_amount(advance_payments, "amount_ttc") + _template_advance_total_ttc(template_options)
    )

    operation_nature_value = (invoice_like.get("operation_nature") or "").strip().lower()
    operation_nature_raw = bool(operation_nature_value)
    operation_nature_label = _operation_nature_label(operation_nature_value)

    branding = get_branding_settings(tenant)
    template_key = (getattr(quote, "template_key", None) or branding.get("pdf_template") or "classic").strip().lower()
    template_options = getattr(quote, "template_options", None)
    if not isinstance(template_options, dict):
        template_options = {}
    display_note = visible_document_note(
        quote.note,
        template_options.get("document_title"),
        template_options.get("legal_mentions_text"),
    )

    return {
        "invoice": invoice_like,
        "supplier": supplier,
        "customer": customer_ctx,
        "customer_siren": customer_siren or None,
        "lines": lines,
        "totals": totals,
        "note": display_note,
        "show_note": True,
        "show_purchase_order_number": True,
        "show_delivery_address": bool(
            invoice_like.get("delivery_address") or invoice_like.get("delivery_address_differs")
        ),
        "operation_nature_raw": operation_nature_raw,
        "operation_nature_value": operation_nature_value,
        "operation_nature_label": operation_nature_label,
        "proof": {
            "seal_hash": getattr(quote, "seal_hash", None),
            "seal_created_at": getattr(quote, "seal_created_at", None),
            "accepted_at": getattr(quote, "accepted_at", None),
            "accepted_name": getattr(quote, "accepted_name", None),
            "accepted_email": getattr(quote, "accepted_email", None),
            "accepted_terms_url": getattr(quote, "accepted_terms_url", None),
            "accepted_terms_at": getattr(quote, "accepted_terms_at", None),
        },
        "template_key": template_key,
        "template_options": template_options,
    }


def _log(db: Session, user: AuthUser, quote: Quote, action: str, metadata: dict | None = None) -> None:
    try:
        log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=None if user.is_api_key else user.id,
            action_type=action,
            object_type="quote",
            object_id=quote.id,
            metadata=metadata or {},
        )
    except Exception:
        # Ne doit jamais bloquer un flux métier
        pass


@router.get("/metrics")
def quote_metrics(
    start_date: str | None = Query(None, description="Date d'émission début (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="Date d'émission fin (YYYY-MM-DD inclus)"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    base = db.query(Quote).filter(Quote.tenant_id == user.tenant_id)

    start = _parse_date_bound(start_date)
    end = _parse_date_bound(end_date, end=True)
    if start:
        base = base.filter(Quote.issue_date >= start)
    if end:
        base = base.filter(Quote.issue_date < end)
    if start and end and start >= end:
        return {
            "total_count": 0,
            "pipeline_amount": 0,
            "draft_count": 0,
            "sent_count": 0,
            "accepted_count": 0,
            "invoiced_count": 0,
            "rejected_count": 0,
            "expired_count": 0,
        }

    status_rows = base.with_entities(Quote.status, func.count(Quote.id)).group_by(Quote.status).all()
    counts = {str(status or "unknown").lower(): int(count or 0) for status, count in status_rows}
    pipeline_amount = base.with_entities(func.coalesce(func.sum(Quote.total_inc_vat), 0)).scalar() or 0
    total_count = sum(counts.values())

    return {
        "total_count": total_count,
        "pipeline_amount": float(pipeline_amount or 0),
        "draft_count": counts.get("draft", 0),
        "sent_count": counts.get("sent", 0),
        "accepted_count": counts.get("accepted", 0),
        "invoiced_count": counts.get("invoiced", 0),
        "rejected_count": counts.get("rejected", 0),
        "expired_count": counts.get("expired", 0),
    }


@router.get("", response_model=list[QuoteOut])
def list_quotes(
    request: Request,
    response: Response,
    q: str | None = Query(None, description="Recherche libre (numéro ou client)"),
    status: str | None = Query(None, description="Filtre statut"),
    customer_id: str | None = Query(None, description="Filtre client"),
    min_total_ht: str | None = Query(None, description="Montant HT minimum"),
    max_total_ht: str | None = Query(None, description="Montant HT maximum"),
    start_date: str | None = Query(None, description="Date d'émission début (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="Date d'émission fin (YYYY-MM-DD inclus)"),
    email: str | None = Query(None, description="Filtre email envoye"),
    signature: str | None = Query(None, description="Filtre signature"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    base = db.query(Quote).filter(Quote.tenant_id == user.tenant_id)

    if customer_id:
        base = base.filter(Quote.customer_id == customer_id)

    if status:
        s = status.strip().lower()
        if s and s != "all":
            base = base.filter(Quote.status == s)

    if q:
        needle = f"%{q.strip()}%"
        base = base.join(Customer, Customer.id == Quote.customer_id).filter(
            (Quote.number.ilike(needle))
            | (Customer.name.ilike(needle))
            | (Customer.email.ilike(needle))
            | (Quote.purchase_order_number.ilike(needle))
        )

    min_ht = _parse_amount_filter(min_total_ht)
    max_ht = _parse_amount_filter(max_total_ht)
    if min_ht is not None:
        base = base.filter(Quote.total_ex_vat >= min_ht)
    if max_ht is not None:
        base = base.filter(Quote.total_ex_vat <= max_ht)
    if min_ht is not None and max_ht is not None and min_ht > max_ht:
        base = base.filter(False)

    start = _parse_date_bound(start_date)
    end = _parse_date_bound(end_date, end=True)
    if start:
        base = base.filter(Quote.issue_date >= start)
    if end:
        base = base.filter(Quote.issue_date < end)
    if start and end and start >= end:
        base = base.filter(False)

    email_filter = (email or "").strip().lower()
    if email_filter == "sent":
        base = base.filter(
            or_(
                Quote.sent_at.is_not(None),
                Quote.status.in_(["sent", "accepted", "rejected", "invoiced", "expired"]),
            )
        )
    elif email_filter == "not_sent":
        base = base.filter(
            Quote.sent_at.is_(None),
            ~Quote.status.in_(["sent", "accepted", "rejected", "invoiced", "expired"]),
        )

    signature_filter = (signature or "").strip().lower()
    if signature_filter == "signed":
        base = base.filter(or_(Quote.accepted_at.is_not(None), Quote.status.in_(["accepted", "invoiced"])))
    elif signature_filter == "not_signed":
        base = base.filter(Quote.accepted_at.is_(None), ~Quote.status.in_(["accepted", "invoiced"]))

    total = base.count()
    items = (
        base.order_by(Quote.issue_date.desc(), Quote.created_at.desc(), Quote.id.desc())
        .limit(limit)
        .offset(offset)
        .all()
    )
    _set_pagination_headers(response, request, total, limit, offset)

    customer_ids = {it.customer_id for it in items}
    customers = (
        db.query(Customer)
        .options(load_only(Customer.id, Customer.name, Customer.email))
        .filter(Customer.id.in_(customer_ids))
        .all()
        if customer_ids
        else []
    )
    customer_map = {c.id: c for c in customers}

    out: list[QuoteOut] = []
    for it in items:
        customer = customer_map.get(it.customer_id)
        out.append(
            _quote_out(
                it,
                customer_name=customer.name if customer else None,
                customer_email=customer.email if customer else None,
                lines=None,
            )
        )
    return out


@router.post("", response_model=QuoteOut)
def create_quote(
    payload: QuoteCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)

    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")

    customer = db.get(Customer, payload.customer_id)
    if not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Client introuvable")

    if not payload.lines:
        raise HTTPException(400, "Ajoutez au moins une ligne au devis.")
    _ensure_document_line_quota(payload.lines, "Devis")
    _enforce_tenant_vat_franchise(tenant, payload.lines)
    _validate_global_discount_vat_breakdown(payload.lines)

    number = _next_quote_number(db, user.tenant_id)
    issue_date = _utcnow()
    payment_terms = sales_payment_terms(payload.payment_terms, customer)
    raw_template_options = payload.template_options if isinstance(payload.template_options, dict) else {}
    template_options, _smart_template_fixes = apply_template_option_defaults(
        payload.template_options,
        tenant=tenant,
        customer=customer,
        operation_nature=raw_template_options.get("operation_nature") or "services",
        prefer_customer_payment_method=not bool(raw_template_options.get("payment_methods")),
    )
    quote = Quote(
        tenant_id=user.tenant_id,
        customer_id=customer.id,
        number=number,
        currency=payload.currency,
        note=payload.note,
        template_key=payload.template_key,
        template_options=template_options,
        payment_terms=payment_terms,
        purchase_order_number=payload.purchase_order_number,
        service_date=payload.service_date,
        valid_until=payload.valid_until or default_quote_valid_until(issue_date, payment_terms),
        status="draft",
        issue_date=issue_date,
        created_by=None if user.is_api_key else user.id,
        updated_by=None if user.is_api_key else user.id,
    )
    db.add(quote)
    db.flush()

    total_ht = Decimal("0")
    total_tva = Decimal("0")
    if not any(_document_line_type(line) == "item" for line in payload.lines):
        raise HTTPException(400, "Ajoutez au moins une ligne produit ou service.")
    for index, line in enumerate(payload.lines, start=1):
        line_type = _document_line_type(line)
        qty = quantize_amount(line.quantity) if line_type == "item" else Decimal("0")
        if line_type == "item" and qty <= 0:
            raise HTTPException(400, f"La ligne '{line.product_name}' a une quantité invalide.")
        unit = quantize_amount(line.unit_price) if line_type == "item" else Decimal("0")
        rate = quantize_amount(line.vat_rate) if line_type == "item" else Decimal("0")
        line_total = calc_line_total(qty, unit) if line_type == "item" else Decimal("0")
        line_tax = calc_tax_amount(line_total, rate) if line_type == "item" else Decimal("0")
        if line_type == "item":
            _validate_sales_amount(f"Total HT de la ligne {index}", line_total)
            _validate_sales_amount(f"TVA de la ligne {index}", line_tax)
        db.add(
            QuoteLine(
                id=_ordered_quote_line_id(quote.id, index),
                quote_id=quote.id,
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
                    operation_nature=(template_options or {}).get("operation_nature") or "services",
                )[0],
                line_total=line_total,
            )
        )
        total_ht += line_total
        total_tva += line_tax

    total_ht = quantize_amount(total_ht)
    total_tva = quantize_amount(total_tva)
    quote.total_ex_vat = total_ht
    quote.total_vat = total_tva
    quote.total_inc_vat = quantize_amount(total_ht + total_tva)
    _validate_sales_amount("Total HT du devis", quote.total_ex_vat)
    _validate_sales_amount("TVA du devis", quote.total_vat)
    _validate_sales_amount("Total TTC du devis", quote.total_inc_vat)
    _validate_quote_advances_do_not_exceed_total(quote.template_options, quote.total_inc_vat)

    _log(db, user, quote, "create", {"number": quote.number})
    db.commit()
    db.refresh(quote)
    return _quote_out(quote, customer_name=customer.name, customer_email=customer.email, lines=None)


@router.delete("/{quote_id}")
def delete_quote(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = _quote_for_update(db, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Devis introuvable")
    if (
        quote.status != "draft"
        or quote.sent_at
        or quote.accepted_at
        or quote.rejected_at
        or quote.invoice_id
        or quote.public_enabled
    ):
        raise HTTPException(
            409,
            detail={
                "code": "quote_delete_only_draft",
                "message": "Seuls les devis brouillons non envoyés peuvent être supprimés.",
            },
        )

    attachment_keys = [att.storage_key for att in (quote.attachments or []) if getattr(att, "storage_key", None)]
    log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="deleted",
        object_type="quote",
        object_id=quote.id,
        metadata={"number": quote.number, "status": quote.status, "attachment_count": len(attachment_keys)},
    )
    db.delete(quote)
    db.commit()
    for storage_key in attachment_keys:
        try:
            delete_object(storage_key)
        except Exception:
            logger.warning("quote_attachment_delete_failed", extra={"quote_id": quote_id, "storage_key": storage_key})
    return {"ok": True, "deleted": 1}


@router.get("/{quote_id}", response_model=QuoteOut)
def get_quote(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = _quote_for_update(db, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    customer = db.get(Customer, quote.customer_id)
    if not customer:
        raise HTTPException(404, "Client introuvable")
    lines = db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).order_by(QuoteLine.id.asc()).all()
    return _quote_out(
        quote,
        customer_name=customer.name,
        customer_email=customer.email,
        lines=lines,
        accounting_readiness=quote_accounting_readiness(quote, lines=lines),
        lineage=_quote_lineage(db, quote),
    )


@router.get("/{quote_id}/readiness")
def get_quote_readiness(
    quote_id: str,
    intent: str = Query("convert", description="save|send|share|email|followup|convert"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    return quote_readiness(db, user.tenant_id, quote_id, intent)


@router.patch("/{quote_id}", response_model=QuoteOut)
def update_quote(
    quote_id: str,
    payload: QuoteUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)

    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    target_customer_id = payload.customer_id if payload.customer_id is not None else quote.customer_id
    customer_for_defaults = db.get(Customer, target_customer_id)
    if not customer_for_defaults or customer_for_defaults.tenant_id != user.tenant_id:
        raise HTTPException(404, "Client introuvable")

    if quote.status in IMMUTABLE_QUOTE_STATUSES:
        raise HTTPException(
            status_code=400,
            detail={"code": "quote_immutable", "message": "Ce devis est figé et ne peut plus être modifié."},
        )

    changed: dict[str, object] = {}
    updates = payload.model_dump(exclude_unset=True)
    if payload.customer_id is not None:
        quote.customer_id = customer_for_defaults.id
        changed["customer_id"] = True
    if payload.currency is not None:
        quote.currency = payload.currency or "EUR"
        changed["currency"] = True
    if payload.note is not None:
        quote.note = payload.note
        changed["note"] = True
    if payload.template_key is not None:
        quote.template_key = payload.template_key
        changed["template_key"] = True
    if payload.template_options is not None:
        current_options = quote.template_options if isinstance(quote.template_options, dict) else {}
        incoming_options = payload.template_options if isinstance(payload.template_options, dict) else {}
        merged_options = {**current_options, **incoming_options}
        quote.template_options = apply_template_option_defaults(
            merged_options,
            tenant=tenant,
            customer=customer_for_defaults,
            operation_nature=merged_options.get("operation_nature") or "services",
        )[0]
        changed["template_options"] = True
    if payload.payment_terms is not None:
        quote.payment_terms = sales_payment_terms(payload.payment_terms, customer_for_defaults)
        changed["payment_terms"] = True
    if "purchase_order_number" in updates:
        next_purchase_order_number = (payload.purchase_order_number or "").strip() or None
        if next_purchase_order_number != quote.purchase_order_number:
            quote.purchase_order_number = next_purchase_order_number
            changed["purchase_order_number"] = True
    if payload.service_date is not None:
        quote.service_date = payload.service_date
        changed["service_date"] = True
    if payload.valid_until is not None:
        quote.valid_until = payload.valid_until
        changed["valid_until"] = True
    elif not quote.valid_until and ("payment_terms" in changed or "customer_id" in changed):
        quote.valid_until = default_quote_valid_until(quote.issue_date, quote.payment_terms)
        changed["valid_until"] = True

    if payload.lines is not None:
        _ensure_document_line_quota(payload.lines, "Devis")
        if not any(_document_line_type(line) == "item" for line in payload.lines):
            raise HTTPException(400, "Ajoutez au moins une ligne produit ou service.")
        _enforce_tenant_vat_franchise(tenant, payload.lines)
        _validate_global_discount_vat_breakdown(payload.lines)
        db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).delete()
        total_ht = Decimal("0")
        total_tva = Decimal("0")
        for index, line in enumerate(payload.lines, start=1):
            line_type = _document_line_type(line)
            qty = quantize_amount(line.quantity) if line_type == "item" else Decimal("0")
            if line_type == "item" and qty <= 0:
                raise HTTPException(400, f"La ligne '{line.product_name}' a une quantité invalide.")
            unit = quantize_amount(line.unit_price) if line_type == "item" else Decimal("0")
            rate = quantize_amount(line.vat_rate) if line_type == "item" else Decimal("0")
            line_total = calc_line_total(qty, unit) if line_type == "item" else Decimal("0")
            line_tax = calc_tax_amount(line_total, rate) if line_type == "item" else Decimal("0")
            if line_type == "item":
                _validate_sales_amount(f"Total HT de la ligne {index}", line_total)
                _validate_sales_amount(f"TVA de la ligne {index}", line_tax)
            db.add(
                QuoteLine(
                    id=_ordered_quote_line_id(quote.id, index),
                    quote_id=quote.id,
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
                        operation_nature=((quote.template_options or {}).get("operation_nature") or "services")
                        if isinstance(quote.template_options, dict)
                        else "services",
                    )[0],
                    line_total=line_total,
                )
            )
            total_ht += line_total
            total_tva += line_tax
        total_ht = quantize_amount(total_ht)
        total_tva = quantize_amount(total_tva)
        quote.total_ex_vat = total_ht
        quote.total_vat = total_tva
        quote.total_inc_vat = quantize_amount(total_ht + total_tva)
        _validate_sales_amount("Total HT du devis", quote.total_ex_vat)
        _validate_sales_amount("TVA du devis", quote.total_vat)
        _validate_sales_amount("Total TTC du devis", quote.total_inc_vat)
        changed["lines"] = True

    _validate_quote_advances_do_not_exceed_total(quote.template_options, quote.total_inc_vat or Decimal("0"))

    if changed and quote.status == "draft":
        clear_quote_seal(quote)
    quote.updated_by = None if user.is_api_key else user.id
    _log(db, user, quote, "update", changed)
    db.add(quote)
    db.commit()
    db.refresh(quote)

    customer = db.get(Customer, quote.customer_id)
    lines = db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).order_by(QuoteLine.id.asc()).all()
    return _quote_out(
        quote,
        customer_name=customer.name if customer else None,
        customer_email=customer.email if customer else None,
        lines=lines,
    )


def _is_final_accounting_account(value: str | None) -> bool:
    code = "".join(ch for ch in str(value or "").strip().upper() if ch.isalnum())
    return len(code) >= 3 and not code.startswith("471")


@router.patch("/{quote_id}/accounting-lines")
def update_quote_accounting_lines(
    quote_id: str,
    payload: AccountingLinesUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")

    db_lines = db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).all()
    lines_by_id = {line.id: line for line in db_lines}
    changed: list[dict[str, str | None]] = []

    for item in payload.lines:
        line = lines_by_id.get(item.id)
        if not line:
            raise HTTPException(404, "Ligne de devis introuvable")
        account = item.accounting_account
        if not _is_final_accounting_account(account):
            raise HTTPException(422, "Choisissez un compte comptable définitif. Le 471 est temporaire avant export.")
        if line.accounting_account != account:
            changed.append({"line_id": line.id, "before": line.accounting_account, "after": account})
            line.accounting_account = account

    if changed:
        quote.updated_by = None if user.is_api_key else user.id
        _log(
            db,
            user,
            quote,
            "update_accounting_lines",
            {
                "changed_lines": changed,
                "client_document_unchanged": True,
            },
        )
        db.commit()

    return {"status": "ok", "updated": len(changed)}


@router.post("/{quote_id}/send", response_model=QuoteOut)
def mark_sent(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_api_key),
):
    ensure_legal_acceptance(user, db)

    quote = _quote_for_update(db, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status in {"rejected", "invoiced", "expired"}:
        raise HTTPException(400, "Impossible d'envoyer ce devis dans son état actuel.")
    was_draft = quote.status == "draft"
    if was_draft:
        quote.status = "sent"
    quote.sent_at = quote.sent_at or _utcnow()
    # Scelle le devis au moment de l'envoi (preuve)
    ensure_quote_sealed(db, quote, force=was_draft)
    quote.updated_by = None if user.is_api_key else user.id
    _log(db, user, quote, "send", {})
    db.commit()
    db.refresh(quote)
    customer = db.get(Customer, quote.customer_id)
    return _quote_out(
        quote,
        customer_name=customer.name if customer else None,
        customer_email=customer.email if customer else None,
        lines=None,
    )


@router.post("/{quote_id}/accept", response_model=QuoteOut)
def accept_quote(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_api_key),
):
    ensure_legal_acceptance(user, db)

    quote = _quote_for_update(db, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status == "accepted":
        customer = db.get(Customer, quote.customer_id)
        return _quote_out(
            quote,
            customer_name=customer.name if customer else None,
            customer_email=customer.email if customer else None,
            lines=None,
        )
    if quote.status in {"rejected", "invoiced", "expired"}:
        raise HTTPException(400, "Impossible d'accepter ce devis.")
    if quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "quote_expired",
                "message": "Devis expiré : mettez à jour la date de validité avant d'accepter.",
            },
        )
    was_draft = quote.status == "draft"
    quote.status = "accepted"
    quote.accepted_at = _utcnow()
    # S'assurer que le devis est scellé avant de le marquer accepté
    ensure_quote_sealed(db, quote, force=was_draft)
    quote.updated_by = None if user.is_api_key else user.id
    _log(db, user, quote, "accept", {})
    db.commit()
    db.refresh(quote)
    customer = db.get(Customer, quote.customer_id)
    return _quote_out(
        quote,
        customer_name=customer.name if customer else None,
        customer_email=customer.email if customer else None,
        lines=None,
    )


@router.post("/{quote_id}/reject", response_model=QuoteOut)
def reject_quote(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_api_key),
):
    ensure_legal_acceptance(user, db)

    quote = _quote_for_update(db, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status == "rejected":
        customer = db.get(Customer, quote.customer_id)
        return _quote_out(
            quote,
            customer_name=customer.name if customer else None,
            customer_email=customer.email if customer else None,
            lines=None,
        )
    if quote.status in {"accepted", "invoiced", "expired"}:
        raise HTTPException(400, "Ce devis est déjà figé. Créez une copie modifiable pour le retravailler.")
    was_draft = quote.status == "draft"
    quote.status = "rejected"
    quote.rejected_at = _utcnow()
    # S'assurer que le devis est scellé (preuve) avant de le figer
    ensure_quote_sealed(db, quote, force=was_draft)
    quote.updated_by = None if user.is_api_key else user.id
    _log(db, user, quote, "reject", {})
    db.commit()
    db.refresh(quote)
    customer = db.get(Customer, quote.customer_id)
    return _quote_out(
        quote,
        customer_name=customer.name if customer else None,
        customer_email=customer.email if customer else None,
        lines=None,
    )


@router.get("/{quote_id}/share", response_model=QuoteShareOut)
def get_quote_share_link(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.public_enabled and is_quote_public_link_expired(quote):
        quote.public_enabled = False
        db.add(quote)
        db.commit()
    return _quote_share_out(quote)


@router.post("/{quote_id}/share", response_model=QuoteShareOut)
def enable_quote_share_link(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_api_key),
):
    ensure_legal_acceptance(user, db)
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status == "draft":
        raise HTTPException(400, "Marquez ou envoyez le devis avant d'activer un lien client.")
    if quote.status in {"rejected", "invoiced", "expired"}:
        raise HTTPException(400, "Impossible de partager ce devis dans son état actuel.")
    ensure_quote_sealed(db, quote, force=quote.status == "draft")
    quote.updated_by = None if user.is_api_key else user.id
    token = _ensure_quote_public_link(db, quote)
    _log(db, user, quote, "share", {"enabled": True})
    db.commit()
    return _quote_share_out(quote, enabled=True, public_url=_quote_public_url(token))


@router.post("/{quote_id}/share/rotate", response_model=QuoteShareOut)
def rotate_quote_share_link(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_api_key),
):
    """Rotate the public link token, invalidating previous URLs."""
    ensure_legal_acceptance(user, db)
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status in {"draft", "rejected", "invoiced", "expired"}:
        raise HTTPException(400, "Impossible de tourner le lien dans cet état.")
    ensure_quote_sealed(db, quote, force=quote.status == "draft")
    quote.updated_by = None if user.is_api_key else user.id
    token = _rotate_quote_public_link(db, quote)
    _log(db, user, quote, "share_rotate", {})
    db.commit()
    return _quote_share_out(quote, enabled=True, public_url=_quote_public_url(token))


@router.post("/{quote_id}/share/disable", response_model=QuoteShareOut)
def disable_quote_share_link(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _disable_quote_public_link(db, quote)
    quote.updated_by = None if user.is_api_key else user.id
    _log(db, user, quote, "share_disable", {})
    db.commit()
    return _quote_share_out(quote, enabled=False, public_url=None)


@router.post("/{quote_id}/duplicate", response_model=QuoteOut)
def duplicate_quote(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    """Duplicate a quote into a new draft (best practice to edit after sending)."""
    ensure_legal_acceptance(user, db)
    src = db.get(Quote, quote_id)
    if not src or src.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    src_lines = db.query(QuoteLine).filter(QuoteLine.quote_id == src.id).order_by(QuoteLine.id.asc()).all()
    new_number = _next_quote_number(db, user.tenant_id)
    new_quote = Quote(
        tenant_id=user.tenant_id,
        customer_id=src.customer_id,
        duplicate_of_id=src.id,
        number=new_number,
        currency=src.currency,
        status="draft",
        issue_date=_utcnow(),
        service_date=src.service_date,
        valid_until=src.valid_until,
        note=src.note,
        template_key=getattr(src, "template_key", None),
        template_options=getattr(src, "template_options", None),
        payment_terms=src.payment_terms,
        purchase_order_number=src.purchase_order_number,
        created_by=None if user.is_api_key else user.id,
        updated_by=None if user.is_api_key else user.id,
    )
    db.add(new_quote)
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
            QuoteLine(
                id=_ordered_quote_line_id(new_quote.id, index),
                quote_id=new_quote.id,
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

    new_quote.total_ex_vat = quantize_amount(total_ht)
    new_quote.total_vat = quantize_amount(total_tva)
    new_quote.total_inc_vat = quantize_amount(total_ht + total_tva)
    _validate_sales_amount("Total HT du devis", new_quote.total_ex_vat)
    _validate_sales_amount("TVA du devis", new_quote.total_vat)
    _validate_sales_amount("Total TTC du devis", new_quote.total_inc_vat)

    _log(db, user, src, "duplicate", {"new_quote_id": new_quote.id, "new_number": new_number})
    _log(db, user, new_quote, "duplicate_from", {"source_quote_id": src.id, "source_number": src.number})
    db.commit()
    db.refresh(new_quote)
    customer = db.get(Customer, new_quote.customer_id)
    lines = db.query(QuoteLine).filter(QuoteLine.quote_id == new_quote.id).order_by(QuoteLine.id.asc()).all()
    return _quote_out(
        new_quote,
        customer_name=customer.name if customer else None,
        customer_email=customer.email if customer else None,
        lines=lines,
        lineage=_quote_lineage(db, new_quote),
    )


@router.get("/{quote_id}/timeline", response_model=list[QuoteTimelineEvent])
def quote_timeline(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    """Return an audit-friendly timeline of actions performed on the quote."""
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")

    rows = (
        db.query(ActionLog, User.email)
        .outerjoin(User, User.id == ActionLog.user_id)
        .filter(ActionLog.tenant_id == user.tenant_id)
        .filter(ActionLog.entity == "quote")
        .filter(ActionLog.entity_id == quote_id)
        .order_by(ActionLog.created_at.desc())
        .limit(200)
        .all()
    )
    out: list[QuoteTimelineEvent] = []
    for log, email in rows:
        out.append(
            QuoteTimelineEvent(
                id=log.id,
                created_at=log.created_at,
                action=log.action,
                actor_email=email,
                metadata=log.metadata_json if isinstance(log.metadata_json, dict) else None,
            )
        )
    return out


def _build_quote_email_preview_payload(
    *,
    quote: Quote,
    tenant: Tenant,
    customer: Customer,
    body: QuoteEmailRequest,
    recipient_email: str | None = None,
    reply_to: str | None = None,
) -> dict:
    link = _quote_preview_link(quote, bool(body.include_link))
    subject_template = body.subject or tenant.quote_email_subject_default or "Votre devis {number}"
    body_template = (
        body.body or tenant.quote_email_body_default or _quote_default_email_body(include_link=bool(body.include_link))
    )
    subject = _format_quote_template(
        subject_template,
        quote=quote,
        customer=customer,
        tenant=tenant,
        quote_link=link,
        reply_to=reply_to,
    )
    text = _format_quote_template(
        body_template,
        quote=quote,
        customer=customer,
        tenant=tenant,
        quote_link=link,
        reply_to=reply_to,
    )
    text = _ensure_quote_acceptance_instruction(text, include_link=bool(body.include_link))
    text = normalize_document_email_body_text(tenant=tenant, body_text=text, contact_email=reply_to)
    meta_rows = [
        ("Numéro", (quote.number or "").strip()),
        (
            "Valable jusqu'au",
            _format_quote_template("{valid_until}", quote=quote, customer=customer, tenant=tenant, quote_link=link),
        ),
        (
            "Total TTC",
            f"{_format_quote_template('{total_ttc}', quote=quote, customer=customer, tenant=tenant, quote_link=link)} {quote.currency}".strip(),
        ),
    ]
    meta_rows.extend(_quote_bank_meta(tenant, quote))
    meta_rows.extend(_quote_link_meta(quote, link))
    email_ctx = build_document_email_context(
        tenant=tenant,
        customer=customer,
        title=subject or "Votre devis",
        body_text=text,
        button_url=link or None,
        button_label="Voir le devis",
        meta=meta_rows,
        recipient_email=recipient_email,
        contact_email=reply_to,
    )
    attachments = (
        [
            {
                "filename": _safe_filename("devis", quote.number, "pdf"),
                "content_type": "application/pdf",
                "kind": "pdf",
            }
        ]
        if bool(body.include_pdf)
        else []
    )
    return {
        "subject": subject or "Votre devis",
        "body": text,
        "html": render_email_template("document.html", email_ctx),
        "cc": body.cc or "",
        "bcc": body.bcc or "",
        "reply_to": reply_to,
        "include_link": bool(body.include_link),
        "button_url": link or None,
        "attachments": attachments,
    }


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
            raise HTTPException(400, "Email de contact invalide.")
        cleaned = clean_document_reply_email(parsed[0])
        if cleaned:
            return cleaned
    return _document_reply_to(db, tenant, user)


def _save_quote_email_defaults(tenant: Tenant, body: QuoteEmailRequest | None) -> bool:
    if not body or not body.save_as_default:
        return False
    subject = _clean_email_template_value(body.save_subject_template or body.subject)
    message = _clean_email_template_value(body.save_body_template or body.body)
    if subject:
        tenant.quote_email_subject_default = subject
    if message:
        tenant.quote_email_body_default = message
    return bool(subject or message)


def _save_quote_followup_defaults(tenant: Tenant, body: QuoteFollowupRequest | None) -> bool:
    if not body or not body.save_as_default:
        return False
    subject = _clean_email_template_value(body.save_subject_template or body.subject)
    message = _clean_email_template_value(body.save_body_template or body.body)
    if subject:
        tenant.quote_followup_subject_default = subject
    if message:
        tenant.quote_followup_body_default = message
    return bool(subject or message)


@router.post("/{quote_id}/email/preview")
def preview_quote_email(
    quote_id: str,
    body: QuoteEmailRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status in {"rejected", "invoiced", "expired"}:
        raise HTTPException(400, "Impossible de préparer cet email dans l'état actuel du devis.")

    tenant = db.get(Tenant, user.tenant_id)
    customer = db.get(Customer, quote.customer_id)
    if not tenant or not customer:
        raise HTTPException(400, "Entreprise ou client introuvable")
    recipients = resolve_customer_recipients(db, customer=customer, kind="quote", explicit_to=body.to)
    if not recipients:
        raise HTTPException(
            400,
            detail={
                "code": "customer_email_missing",
                "message": "Aucun destinataire : ajoutez un email au client ou des contacts facturation.",
            },
        )
    payload = _build_quote_email_preview_payload(
        quote=quote,
        tenant=tenant,
        customer=customer,
        body=body,
        recipient_email=join_emails(recipients),
        reply_to=_document_reply_to_from_payload(body.reply_to, db, tenant, user),
    )
    draft = build_quote_email_draft(db, quote, "send")
    payload.setdefault("reason", draft.get("reason"))
    payload.setdefault("warnings", draft.get("warnings") or [])
    payload["to"] = recipients
    return payload


@router.post("/{quote_id}/email")
def send_quote_email(
    quote_id: str,
    body: QuoteEmailRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status in {"rejected", "invoiced", "expired"}:
        raise HTTPException(400, "Impossible d'envoyer ce devis dans son état actuel.")

    tenant = db.get(Tenant, user.tenant_id)
    customer = db.get(Customer, quote.customer_id)
    if not tenant or not customer:
        raise HTTPException(400, "Entreprise ou client introuvable")
    ensure_document_email_delivery_allowed(tenant)

    recipients = resolve_customer_recipients(db, customer=customer, kind="quote", explicit_to=body.to)
    if not recipients:
        raise HTTPException(
            400,
            detail={
                "code": "customer_email_missing",
                "message": "Aucun destinataire : ajoutez un email au client ou des contacts facturation.",
            },
        )
    if _save_quote_email_defaults(tenant, body):
        db.add(tenant)

    smtp_ready = assert_smtp_ready_or_raise("quote_email")
    if not smtp_ready:
        events = [
            record_quote_email_log_only(
                tenant_id=user.tenant_id,
                quote_id=quote.id,
                user_id=None if user.is_api_key else user.id,
                to=dest,
            )
            for dest in recipients
        ]
        primary_event = events[0]
        _log(
            db,
            user,
            quote,
            "send_email_log_only",
            {
                "delivery": "log_only",
                "event_id": primary_event.id,
                "event_ids": [e.id for e in events],
                "to_count": len(recipients),
                "to_masked": [mask_email(r) for r in recipients],
            },
        )
        db.commit()
        return {
            "ok": True,
            "email_sent": False,
            "delivery": "log_only",
            "event_id": primary_event.id,
            "event_ids": [e.id for e in events],
            "status": primary_event.status,
            "to_count": len(recipients),
            "quote_status": quote.status,
        }

    _enforce_quote_email_rate_limits(user.tenant_id)

    # Marquer envoyé + sceller le devis (preuve)
    was_draft = quote.status == "draft"
    if was_draft:
        quote.status = "sent"
    quote.sent_at = quote.sent_at or _utcnow()
    quote.updated_by = None if user.is_api_key else user.id
    ensure_quote_sealed(db, quote, force=was_draft)

    link = ""
    if bool(body.include_link):
        token = _ensure_quote_public_link(db, quote)
        link = _quote_public_url(token)
    else:
        db.add(quote)

    subject_template = body.subject or tenant.quote_email_subject_default or "Votre devis {number}"
    body_template = (
        body.body or tenant.quote_email_body_default or _quote_default_email_body(include_link=bool(body.include_link))
    )

    reply_to = _document_reply_to_from_payload(body.reply_to, db, tenant, user)
    subject = _format_quote_template(
        subject_template,
        quote=quote,
        customer=customer,
        tenant=tenant,
        quote_link=link,
        reply_to=reply_to,
    )
    text = _format_quote_template(
        body_template,
        quote=quote,
        customer=customer,
        tenant=tenant,
        quote_link=link,
        reply_to=reply_to,
    )
    text = _ensure_quote_acceptance_instruction(text, include_link=bool(body.include_link))
    text = normalize_document_email_body_text(tenant=tenant, body_text=text, contact_email=reply_to)

    attachments: list[tuple[str, bytes, str]] | None = None
    if bool(body.include_pdf):
        ctx = _quote_ctx(db, quote)
        pdf_bytes = invoice_pdf(ctx)
        attachments = [(_safe_filename("devis", quote.number, "pdf"), pdf_bytes, "application/pdf")]

    meta_rows = [
        ("Numéro", (quote.number or "").strip()),
        (
            "Valable jusqu'au",
            _format_quote_template("{valid_until}", quote=quote, customer=customer, tenant=tenant, quote_link=link),
        ),
        (
            "Total TTC",
            f"{_format_quote_template('{total_ttc}', quote=quote, customer=customer, tenant=tenant, quote_link=link)} {quote.currency}".strip(),
        ),
    ]
    meta_rows.extend(_quote_bank_meta(tenant, quote))
    meta_rows.extend(_quote_link_meta(quote, link))
    email_ctx = build_document_email_context(
        tenant=tenant,
        customer=customer,
        title=subject or "Votre devis",
        body_text=text,
        button_url=link or None,
        button_label="Voir le devis",
        meta=meta_rows,
        recipient_email=join_emails(recipients),
        contact_email=reply_to,
    )

    events = []
    try:
        for dest in recipients:
            ev = enqueue_quote_email(
                tenant_id=user.tenant_id,
                quote_id=quote.id,
                user_id=None if user.is_api_key else user.id,
                to=dest,
                subject=subject or "Votre devis",
                body=text,
                attachments=attachments,
                reply_to=reply_to,
                template="document.html",
                context=email_ctx,
                cc=body.cc,
                bcc=body.bcc,
            )
            events.append(ev)
    except Exception:
        logger.exception("quote_email_enqueue_failed", extra={"quote_id": quote.id, "tenant_id": user.tenant_id})
        raise HTTPException(502, "Echec lors de la mise en file d'attente de l'email.")

    primary_event = events[0]
    _log(
        db,
        user,
        quote,
        "send_email",
        {
            "event_id": primary_event.id,
            "event_ids": [e.id for e in events],
            "to_count": len(recipients),
            "to_masked": [mask_email(r) for r in recipients],
        },
    )
    db.commit()
    return {
        "ok": True,
        "email_sent": True,
        "delivery": "smtp",
        "status": primary_event.status,
        "event_id": primary_event.id,
        "event_ids": [e.id for e in events],
        "to_count": len(recipients),
        "quote_status": quote.status,
    }


def _build_quote_followup_email_payload(
    *,
    quote: Quote,
    tenant: Tenant,
    customer: Customer,
    body: QuoteFollowupRequest,
    quote_link: str,
    recipient_email: str | None = None,
    reply_to: str | None = None,
) -> tuple[dict, dict]:
    followup_subject_template = body.subject or tenant.quote_followup_subject_default or "Relance - devis {number}"
    followup_body_template = (
        body.body
        or tenant.quote_followup_body_default
        or "Bonjour {client},\n\nNous revenons vers vous au sujet du devis {number}, toujours en attente de votre retour.\n\nIl reste consultable depuis le portail sécurisé. Nous restons disponibles si vous souhaitez une précision ou un ajustement."
    )
    subject = _format_quote_template(
        followup_subject_template,
        quote=quote,
        customer=customer,
        tenant=tenant,
        quote_link=quote_link,
        reply_to=reply_to,
    )
    text = _format_quote_template(
        followup_body_template,
        quote=quote,
        customer=customer,
        tenant=tenant,
        quote_link=quote_link,
        reply_to=reply_to,
    )
    text = _ensure_quote_acceptance_instruction(text, include_link=bool(body.include_link))
    text = normalize_document_email_body_text(tenant=tenant, body_text=text, contact_email=reply_to)
    meta_rows = [
        ("Numéro", (quote.number or "").strip()),
        (
            "Valable jusqu'au",
            _format_quote_template(
                "{valid_until}", quote=quote, customer=customer, tenant=tenant, quote_link=quote_link
            ),
        ),
        (
            "Total TTC",
            f"{_format_quote_template('{total_ttc}', quote=quote, customer=customer, tenant=tenant, quote_link=quote_link)} {quote.currency}".strip(),
        ),
    ]
    meta_rows.extend(_quote_bank_meta(tenant, quote))
    meta_rows.extend(_quote_link_meta(quote, quote_link))
    email_ctx = build_document_email_context(
        tenant=tenant,
        customer=customer,
        title=subject or "Relance devis",
        body_text=text,
        button_url=quote_link or None,
        button_label="Voir le devis",
        meta=meta_rows,
        recipient_email=recipient_email,
        contact_email=reply_to,
    )
    attachments = (
        [
            {
                "filename": _safe_filename("devis", quote.number, "pdf"),
                "content_type": "application/pdf",
                "kind": "pdf",
            }
        ]
        if bool(body.include_pdf)
        else []
    )
    return (
        {
            "subject": subject or "Relance devis",
            "body": text,
            "html": render_email_template("document.html", email_ctx),
            "cc": body.cc or "",
            "bcc": body.bcc or "",
            "reply_to": reply_to,
            "include_link": bool(body.include_link),
            "button_url": quote_link or None,
            "attachments": attachments,
        },
        email_ctx,
    )


@router.post("/{quote_id}/followup/preview")
def preview_quote_followup_email(
    quote_id: str,
    body: QuoteFollowupRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status != "sent":
        raise HTTPException(400, "Relance possible uniquement pour un devis envoyé.")
    if quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(400, detail={"code": "quote_expired", "message": "Devis expiré."})

    max_reminders = int(getattr(settings, "QUOTE_FOLLOWUP_MAX_REMINDERS", 2) or 2)
    if int(getattr(quote, "reminder_count", 0) or 0) >= max_reminders:
        raise HTTPException(400, detail={"code": "quote_followup_limit", "message": "Limite de relances atteinte."})

    tenant = db.get(Tenant, user.tenant_id)
    customer = db.get(Customer, quote.customer_id)
    if not tenant or not customer:
        raise HTTPException(400, "Entreprise ou client introuvable")

    recipients = resolve_customer_recipients(db, customer=customer, kind="quote", explicit_to=body.to)
    if not recipients:
        raise HTTPException(
            400,
            detail={
                "code": "customer_email_missing",
                "message": "Aucun destinataire : ajoutez un email au client ou des contacts facturation.",
            },
        )

    quote_link = _quote_preview_link(quote, bool(body.include_link))
    preview, _email_ctx = _build_quote_followup_email_payload(
        quote=quote,
        tenant=tenant,
        customer=customer,
        body=body,
        quote_link=quote_link,
        recipient_email=join_emails(recipients),
        reply_to=_document_reply_to_from_payload(body.reply_to, db, tenant, user),
    )
    draft = build_quote_email_draft(db, quote, "followup")
    preview.setdefault("reason", draft.get("reason"))
    preview.setdefault("warnings", draft.get("warnings") or [])
    preview["to"] = recipients
    return preview


@router.post("/{quote_id}/followup")
def followup_quote_email(
    quote_id: str,
    body: QuoteFollowupRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_legal_acceptance(user, db)
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if quote.status != "sent":
        raise HTTPException(400, "Relance possible uniquement pour un devis envoyé.")
    if quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(400, detail={"code": "quote_expired", "message": "Devis expiré."})

    max_reminders = int(getattr(settings, "QUOTE_FOLLOWUP_MAX_REMINDERS", 2) or 2)
    if int(getattr(quote, "reminder_count", 0) or 0) >= max_reminders:
        raise HTTPException(400, detail={"code": "quote_followup_limit", "message": "Limite de relances atteinte."})

    tenant = db.get(Tenant, user.tenant_id)
    customer = db.get(Customer, quote.customer_id)
    if not tenant or not customer:
        raise HTTPException(400, "Entreprise ou client introuvable")
    ensure_document_email_delivery_allowed(tenant)

    recipients = resolve_customer_recipients(db, customer=customer, kind="quote", explicit_to=body.to)
    if not recipients:
        raise HTTPException(
            400,
            detail={
                "code": "customer_email_missing",
                "message": "Aucun destinataire : ajoutez un email au client ou des contacts facturation.",
            },
        )
    if _save_quote_followup_defaults(tenant, body):
        db.add(tenant)

    smtp_ready = assert_smtp_ready_or_raise("quote_followup")
    if not smtp_ready:
        quote.reminder_count = int(getattr(quote, "reminder_count", 0) or 0) + 1
        quote.last_reminder_at = _utcnow()
        quote.updated_by = None if user.is_api_key else user.id
        db.add(quote)
        events = [
            record_quote_email_log_only(
                tenant_id=user.tenant_id,
                quote_id=quote.id,
                user_id=None if user.is_api_key else user.id,
                to=dest,
                followup=True,
            )
            for dest in recipients
        ]
        primary_event = events[0]
        _log(
            db,
            user,
            quote,
            "followup_email_log_only",
            {
                "delivery": "log_only",
                "event_id": primary_event.id,
                "event_ids": [e.id for e in events],
                "to_count": len(recipients),
                "to_masked": [mask_email(r) for r in recipients],
            },
        )
        db.commit()
        return {
            "ok": True,
            "email_sent": False,
            "delivery": "log_only",
            "event_id": primary_event.id,
            "event_ids": [e.id for e in events],
            "status": primary_event.status,
            "to_count": len(recipients),
            "reminder_count": quote.reminder_count,
        }

    _enforce_quote_email_rate_limits(user.tenant_id)

    quote.updated_by = None if user.is_api_key else user.id
    ensure_quote_sealed(db, quote)
    link = ""
    if bool(body.include_link):
        token = _ensure_quote_public_link(db, quote)
        link = _quote_public_url(token)
    else:
        db.add(quote)

    email_payload, email_ctx = _build_quote_followup_email_payload(
        quote=quote,
        tenant=tenant,
        customer=customer,
        body=body,
        quote_link=link,
        recipient_email=join_emails(recipients),
        reply_to=_document_reply_to_from_payload(body.reply_to, db, tenant, user),
    )

    attachments: list[tuple[str, bytes, str]] | None = None
    if bool(body.include_pdf):
        ctx = _quote_ctx(db, quote)
        pdf_bytes = invoice_pdf(ctx)
        attachments = [(_safe_filename("devis", quote.number, "pdf"), pdf_bytes, "application/pdf")]

    events = []
    try:
        for dest in recipients:
            ev = enqueue_quote_followup_email(
                tenant_id=user.tenant_id,
                quote_id=quote.id,
                user_id=None if user.is_api_key else user.id,
                to=dest,
                subject=email_payload["subject"],
                body=email_payload["body"],
                attachments=attachments,
                reply_to=email_payload["reply_to"],
                template="document.html",
                context=email_ctx,
                cc=body.cc,
                bcc=body.bcc,
            )
            events.append(ev)
    except Exception:
        logger.exception("quote_followup_enqueue_failed", extra={"quote_id": quote.id, "tenant_id": user.tenant_id})
        raise HTTPException(502, "Echec lors de la mise en file d'attente de la relance.")

    quote.reminder_count = int(getattr(quote, "reminder_count", 0) or 0) + 1
    quote.last_reminder_at = _utcnow()
    db.add(quote)
    db.commit()

    primary_event = events[0]
    _log(
        db,
        user,
        quote,
        "followup_email",
        {
            "event_id": primary_event.id,
            "event_ids": [e.id for e in events],
            "to_count": len(recipients),
            "to_masked": [mask_email(r) for r in recipients],
        },
    )
    db.commit()
    return {
        "ok": True,
        "email_sent": True,
        "delivery": "smtp",
        "status": primary_event.status,
        "event_id": primary_event.id,
        "event_ids": [e.id for e in events],
        "to_count": len(recipients),
        "reminder_count": quote.reminder_count,
    }


def _dedupe_document_note_blocks(value: str) -> str:
    blocks = [block.strip() for block in str(value or "").split("\n\n") if block.strip()]
    deduped: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        key = " ".join(block.lower().split())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(block)
    return "\n\n".join(deduped).strip()


def _quote_conversion_preview_payload(db: Session, quote: Quote, tenant_id: str) -> dict:
    readiness = quote_readiness(db, tenant_id, quote.id, "convert")
    existing_invoice = None
    if quote.invoice_id:
        existing_invoice = db.get(Invoice, quote.invoice_id)
    if not existing_invoice:
        existing_invoice = (
            db.query(Invoice)
            .filter(
                Invoice.tenant_id == tenant_id,
                Invoice.quote_id == quote.id,
                Invoice.type == "invoice",
                Invoice.invoice_kind != "deposit",
                Invoice.status != "canceled",
            )
            .order_by(Invoice.created_at.asc())
            .first()
        )
    deposit_invoices = (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == tenant_id,
            Invoice.quote_id == quote.id,
            Invoice.customer_id == quote.customer_id,
            Invoice.type == "invoice",
            Invoice.invoice_kind == "deposit",
            Invoice.status.notin_(["draft", "canceled"]),
        )
        .order_by(Invoice.issue_date.asc(), Invoice.created_at.asc())
        .all()
    )
    lines_count = (
        db.query(func.count(QuoteLine.id))
        .filter(QuoteLine.quote_id == quote.id, QuoteLine.line_type == "item")
        .scalar()
        or 0
    )
    blocking = [check for check in readiness["checks"] if check.get("severity") == "blocking"]
    warnings = [check for check in readiness["checks"] if check.get("severity") == "warning"]
    recommended_kind = "final" if deposit_invoices else "standard"
    deposit_net_amounts = {invoice.id: deposit_invoice_net_amounts(db, invoice) for invoice in deposit_invoices}
    remaining_due = Decimal(str(quote.total_inc_vat or 0)) - sum(
        (Decimal(str(deposit_net_amounts[invoice.id]["net_ttc"] or 0)) for invoice in deposit_invoices),
        Decimal("0"),
    )
    if remaining_due < Decimal("0"):
        remaining_due = Decimal("0")

    if existing_invoice:
        status = "blocked"
        can_convert = False
        reason = "Une facture existe déjà pour ce devis."
    else:
        status = readiness["status"]
        can_convert = status != "blocked"
        reason = readiness.get("summary") or (
            "Devis prêt à convertir en facture." if can_convert else "Conversion impossible."
        )

    return {
        "can_convert": bool(can_convert),
        "status": status,
        "recommended_mode": recommended_kind,
        "invoice_kind": recommended_kind,
        "reason": reason,
        "warnings": warnings,
        "blocking": blocking,
        "quote": {
            "id": quote.id,
            "number": quote.number,
            "status": quote.status,
            "valid_until": quote.valid_until.isoformat() if quote.valid_until else None,
            "total_inc_vat": float(quote.total_inc_vat or 0),
        },
        "existing_invoice_id": existing_invoice.id if existing_invoice else None,
        "deposit_invoices": [
            {
                "id": invoice.id,
                "number": invoice.number,
                "status": invoice.status,
                "total_inc_vat": float(invoice.total_inc_vat or 0),
                "net_total_inc_vat": float(deposit_net_amounts[invoice.id]["net_ttc"] or 0),
                "credited_total_inc_vat": float(deposit_net_amounts[invoice.id]["credited_ttc"] or 0),
            }
            for invoice in deposit_invoices
        ],
        "remaining_due": float(remaining_due),
        "copy_attachments": True,
        "lines_count": int(lines_count),
        "readiness": readiness,
    }


@router.get("/{quote_id}/conversion-preview")
def quote_conversion_preview(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    return _quote_conversion_preview_payload(db, quote, user.tenant_id)


@router.post("/{quote_id}/convert")
def convert_quote_to_invoice(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin_or_api_key({API_SCOPE_WRITE_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    ensure_legal_acceptance(user, db)

    quote = _quote_for_update(db, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    conversion_preview = _quote_conversion_preview_payload(db, quote, user.tenant_id)
    if quote.invoice_id:
        return {"ok": True, "invoice_id": quote.invoice_id, "quote_id": quote.id, "already_converted": True}
    existing_invoice = (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == user.tenant_id,
            Invoice.quote_id == quote.id,
            Invoice.type == "invoice",
            Invoice.invoice_kind != "deposit",
            Invoice.status != "canceled",
        )
        .order_by(Invoice.created_at.asc())
        .first()
    )
    if existing_invoice:
        quote.invoice_id = existing_invoice.id
        quote.status = "invoiced"
        quote.updated_by = None if user.is_api_key else user.id
        db.add(quote)
        db.commit()
        return {"ok": True, "invoice_id": existing_invoice.id, "quote_id": quote.id, "already_converted": True}
    if not conversion_preview.get("can_convert"):
        first_block = (conversion_preview.get("blocking") or [{}])[0]
        raise HTTPException(
            400,
            {
                "code": first_block.get("code") or "quote_conversion_blocked",
                "message": first_block.get("message") or conversion_preview.get("reason") or "Conversion impossible.",
                "readiness": conversion_preview.get("readiness"),
            },
        )
    if quote.status == "rejected":
        raise HTTPException(400, {"code": "quote_rejected", "message": "Devis refusé : impossible de convertir."})
    if quote.status != "accepted":
        raise HTTPException(
            400,
            {
                "code": "quote_not_accepted",
                "message": "Le devis doit être accepté avant de pouvoir être converti en facture.",
            },
        )
    if quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(400, {"code": "quote_expired", "message": "Devis expiré : impossible de convertir."})

    ensure_quote_sealed(db, quote)

    lines = db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).order_by(QuoteLine.id.asc()).all()
    if not lines:
        raise HTTPException(400, {"code": "quote_no_lines", "message": "Devis vide : aucune ligne à convertir."})

    invoice_lines = [
        InvoiceLineIn(
            line_type=line.line_type or "item",
            display_number=line.display_number,
            reference=line.reference,
            product_name=line.product_name,
            detail=line.detail,
            quantity=float(line.quantity),
            unit_price=float(line.unit_price),
            vat_rate=float(line.vat_rate),
            vat_category=line.vat_category,
            exemption_reason_code=line.exemption_reason_code,
            unit_code=line.unit_code,
            item_id=line.item_id,
            accounting_account=line.accounting_account,
        )
        for line in lines
    ]
    note = _dedupe_document_note_blocks(quote.note or "")

    has_deposit_invoices = (
        db.query(Invoice.id)
        .filter(
            Invoice.tenant_id == user.tenant_id,
            Invoice.quote_id == quote.id,
            Invoice.customer_id == quote.customer_id,
            Invoice.type == "invoice",
            Invoice.invoice_kind == "deposit",
            Invoice.status.notin_(["draft", "canceled"]),
        )
        .first()
        is not None
    )
    template_options = invoice_template_options_from_quote(
        getattr(quote, "template_options", None),
        source_quote_id=quote.id,
        has_deposit_invoices=has_deposit_invoices,
    )
    delivery_address = (
        str(template_options.get("delivery_address") or getattr(quote, "delivery_address", None) or "").strip() or None
    )
    delivery_address_differs = bool(
        template_options.get("delivery_address_differs") or getattr(quote, "delivery_address_differs", False)
    )

    inv_payload = InvoiceCreate(
        customer_id=quote.customer_id,
        currency=quote.currency,
        note=note or None,
        template_key=getattr(quote, "template_key", None),
        template_options=template_options,
        operation_nature=str(template_options.get("operation_nature") or "services").strip().lower(),
        payment_terms=quote.payment_terms,
        purchase_order_number=quote.purchase_order_number,
        service_date=quote.service_date,
        quote_id=quote.id,
        invoice_kind="final" if has_deposit_invoices else "standard",
        delivery_address=delivery_address,
        delivery_address_differs=delivery_address_differs,
        lines=invoice_lines,
    )

    # Import ici pour éviter les imports circulaires au démarrage
    from ..routers import invoices as invoices_router

    resp = Response()
    inv = invoices_router._create_invoice_record(
        inv_payload,
        resp,
        db,
        tenant_id=user.tenant_id,
        actor=user,
        commit=False,
    )

    # Best-effort: copy quote attachments to the newly created invoice.
    # We keep the originals attached to the quote, and duplicate blobs to avoid coupling lifecycle.
    attachments_copied = 0
    attachments_skipped = 0
    try:
        from ..models import DocumentAttachment, Tenant
        from ..services.document_attachments import build_storage_key, get_used_bytes, resolve_limits_for_tenant
        from ..services.storage import copy_object, get_object_bytes, put_object
        from datetime import datetime as _dt
        import uuid

        tenant = db.get(Tenant, user.tenant_id)
        limits = resolve_limits_for_tenant(tenant)
        used_bytes = get_used_bytes(db, user.tenant_id)

        atts = (
            db.query(DocumentAttachment)
            .filter(DocumentAttachment.tenant_id == user.tenant_id)
            .filter(DocumentAttachment.quote_id == quote.id)
            .filter(DocumentAttachment.deleted_at.is_(None))
            .order_by(DocumentAttachment.created_at.asc())
            .all()
        )

        for att in atts:
            if not att.storage_key:
                attachments_skipped += 1
                continue
            size = int(att.size_bytes or 0)
            if limits.quota_bytes and (used_bytes + size) > limits.quota_bytes:
                # Do not block conversion: skip when quota would be exceeded.
                attachments_skipped += 1
                continue
            if limits.max_per_document and attachments_copied >= limits.max_per_document:
                attachments_skipped += 1
                continue

            new_id = uuid.uuid4().hex
            new_key = build_storage_key(
                tenant_id=user.tenant_id,
                parent_kind="invoice",
                parent_id=inv.id,
                attachment_id=new_id,
                filename=att.filename,
            )
            try:
                copy_object(att.storage_key, new_key, content_type=att.content_type)
            except Exception:
                payload = get_object_bytes(att.storage_key)
                if payload is None:
                    raise
                put_object(new_key, payload, content_type=att.content_type)

            now = _dt.utcnow()
            new_att = DocumentAttachment(
                id=new_id,
                tenant_id=user.tenant_id,
                invoice_id=inv.id,
                quote_id=None,
                filename=att.filename,
                label=att.label,
                content_type=att.content_type,
                size_bytes=size,
                sha256=att.sha256,
                storage_key=new_key,
                public_visible=bool(att.public_visible),
                created_at=now,
                created_by=None if user.is_api_key else user.id,
                updated_at=now,
                updated_by=None if user.is_api_key else user.id,
            )
            db.add(new_att)
            attachments_copied += 1
            used_bytes += size
    except Exception:
        # Keep conversion successful even if copy fails.
        attachments_skipped += 1

    quote.invoice_id = inv.id
    quote.status = "invoiced"
    quote.updated_by = None if user.is_api_key else user.id
    _log(
        db,
        user,
        quote,
        "convert",
        {
            "invoice_id": inv.id,
            "attachments_copied": attachments_copied,
            "attachments_skipped": attachments_skipped,
        },
    )
    db.add(quote)
    db.commit()
    return {
        "ok": True,
        "invoice_id": inv.id,
        "quote_id": quote.id,
        "attachments_copied": attachments_copied,
        "attachments_skipped": attachments_skipped,
    }


@router.get("/{quote_id}/pdf")
def quote_pdf(
    quote_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    filename = _safe_filename("devis", quote.number, "pdf")
    ctx = _quote_ctx(db, quote)
    content = invoice_pdf(ctx)
    disposition = (
        "inline" if str(request.query_params.get("inline", "")).lower() in {"1", "true", "yes"} else "attachment"
    )
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'{disposition}; filename="{filename}"',
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/{quote_id}/preview.html")
def quote_preview_html(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    html = invoice_html(_quote_ctx(db, quote))
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{quote_id}/bundle.zip")
def quote_bundle_zip(
    quote_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_INVOICES})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    """Export ZIP (backoffice) : PDF du devis + pièces jointes + meta.json."""
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    from ..services.bundles import build_quote_bundle_zip, stream_zip_file

    path, filename = build_quote_bundle_zip(
        db,
        quote_id=quote_id,
        tenant_id=user.tenant_id,
        include_private_attachments=True,
    )
    return stream_zip_file(path, filename)
