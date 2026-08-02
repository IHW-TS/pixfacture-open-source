from __future__ import annotations

import hashlib
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Customer, Quote, QuoteLine, Tenant, DocumentAttachment
from ..schemas import (
    PublicParty,
    PublicQuoteAcceptRequest,
    PublicQuoteLine,
    PublicQuoteOut,
    PublicQuoteOtpRequest,
    PublicQuoteRejectRequest,
    PublicQuoteTotals,
    PublicDocumentAttachmentOut,
)
from ..jobs.email_jobs import enqueue_quote_otp_email
from ..services.action_logs import log_action
from ..services.email import assert_smtp_ready_or_raise
from ..services.email_reply_to import resolve_document_reply_to
from ..services.logo_storage import get_logo_url
from ..services.portal_settings import get_portal_settings
from ..services.document_pdf_context import document_vat_labels
from ..services.document_notes import visible_document_note
from ..services.public_links import is_quote_public_link_expired, quote_public_link_expired_message
from ..services.public_rate_limits import enforce_public_rate_limit
from ..services.quote_recipients import quote_email_is_allowed
from ..services.quote_advances import requested_quote_advance_summary
from ..services.quote_proof import ensure_quote_sealed
from ..services.trial_document_email import ensure_public_quote_otp_delivery_allowed
from ..services import rate_limit
from ..services.document_attachments import sanitize_filename
from ..services.pdf import invoice_html, invoice_pdf
from ..services.storage import get_object_stream, parse_range_header


router = APIRouter(prefix="/api/public/quotes", tags=["public_quotes"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _quote_for_update(db: Session, quote_id: str) -> Quote | None:
    try:
        return db.query(Quote).filter(Quote.id == quote_id).with_for_update().first()
    except OperationalError as exc:
        raise HTTPException(429, "Devis en cours de traitement, réessayez dans un instant.") from exc


def _derive_siren(value: str | None) -> str | None:
    digits = re.sub(r"\D+", "", value or "")
    if len(digits) >= 9:
        return digits[:9]
    return None


def _parse_amount(value: object | None) -> float:
    if value is None:
        return 0.0
    try:
        return float(Decimal(str(value)))
    except Exception:
        try:
            return float(value)
        except Exception:
            return 0.0


def _quote_template_options(quote: Quote) -> dict:
    template_options = getattr(quote, "template_options", None)
    return template_options if isinstance(template_options, dict) else {}


def _quote_payment_bank_account(
    template_options: dict, tenant: Tenant, supplier_snapshot: dict | None = None
) -> tuple[str | None, str | None]:
    bank = template_options.get("payment_bank_account") if isinstance(template_options, dict) else None
    if isinstance(bank, dict):
        iban = str(bank.get("iban") or "").strip()
        bic = str(bank.get("bic") or "").strip()
        if iban or bic:
            return iban or None, bic or None
    source = supplier_snapshot if isinstance(supplier_snapshot, dict) else {}
    return (
        str(source.get("iban") or "").strip() or (tenant.iban or None),
        str(source.get("bic") or "").strip() or (tenant.bic or None),
    )


def _quote_terms_policy(tenant: Tenant) -> tuple[str | None, bool]:
    configured_url = str(getattr(tenant, "quote_terms_url", None) or "").strip()
    required = bool(getattr(tenant, "quote_terms_required", False))
    if configured_url:
        return configured_url, required
    if not required:
        return None, False
    base_url = (getattr(settings, "FRONTEND_BASE_URL", "") or getattr(settings, "PUBLIC_BASE_URL", "") or "").strip()
    default_url = f"{base_url.rstrip('/')}/legal/terms" if base_url else "/legal/terms"
    return default_url, True


def _legal_rate_label(value: object, default: str = "10") -> str:
    raw = str(value or default).strip() or default
    cleaned = raw.replace("%", "").strip()
    lowered = cleaned.lower()
    return cleaned if ("taux" in lowered or "bce" in lowered) else f"{cleaned} %"


def _quote_legal_notice_with_extra(notice: str, template_options: dict) -> str:
    return notice


def _quote_discount_text(template_options: dict) -> str:
    legacy_defaults = {
        "pour frais de recouvrement. Signature précédée de la mention “Bon pour accord”.",
        'apply. Signature must be preceded by "Approved".',
    }
    configured = str(template_options.get("legal_discount_text") or "").strip()
    if configured and configured not in legacy_defaults:
        return configured
    return "pour frais de recouvrement. L’acceptation du devis vaut accord du client."


_NORMAL_VAT_LEGAL_LABELS = {
    "TVA sur les débits",
    "TVA sur les debits",
    "TVA sur les encaissements",
    "TVA acquittée d'après les débits",
    "TVA acquittée d’après les débits",
    "VAT on debits",
    "VAT payable according to debits",
    "VAT due on payments received",
    "Option pour le paiement de la taxe d'après les débits",
}


def _with_final_period(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return text
    return text if text.endswith((".", "!", "?")) else f"{text}."


def _quote_valid_until_label(value: date | datetime | None) -> str:
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")
    return "la date indiquée"


def _quote_legal_notice(
    template_options: dict,
    *,
    supplier: object | None = None,
    lines: list | None = None,
    payment_terms: object | None = None,
    valid_until: date | datetime | None = None,
) -> str:
    legal_notice = str(template_options.get("legal_footer_text") or "").strip()
    if legal_notice:
        return _quote_legal_notice_with_extra(legal_notice, template_options)
    legal_terms_default = template_options.get("legal_terms_default", True) is not False
    vat_label = document_vat_labels(supplier or {}, lines=lines or [], is_english=False).get("legal") or ""
    vat_on_debits = (
        bool((supplier or {}).get("vat_on_debits"))
        if isinstance(supplier, dict)
        else bool(getattr(supplier, "vat_on_debits", False))
    )
    vat_prefix = (
        f"{_with_final_period(vat_label)} "
        if vat_label and (vat_on_debits or vat_label not in _NORMAL_VAT_LEGAL_LABELS)
        else ""
    )
    default_prefix = (
        f"{vat_prefix}Devis valable jusqu'au {_quote_valid_until_label(valid_until)}. "
        f"Après acceptation du devis, le règlement intervient selon les conditions indiquées "
        f"({str(payment_terms or '30 jours').strip() or '30 jours'}). Aucun escompte n'est accordé en cas de paiement anticipé. "
        "En cas de retard sur une échéance de paiement convenue, des pénalités au taux de"
    )
    penalty_prefix = str(
        ("" if legal_terms_default else template_options.get("legal_penalty_prefix")) or default_prefix
    ).strip()
    recovery_prefix = str(
        ("" if legal_terms_default else template_options.get("legal_recovery_prefix"))
        or "seront dues à compter du lendemain de l'échéance, ainsi qu'une indemnité forfaitaire de"
    ).strip()
    discount_text = _quote_discount_text({} if legal_terms_default else template_options)
    penalty_rate = _legal_rate_label(template_options.get("legal_penalty_rate"))
    recovery_fee = str(template_options.get("legal_recovery_fee") or "40").strip() or "40"
    notice = f"{penalty_prefix} {penalty_rate} {recovery_prefix} {recovery_fee} € {discount_text}".strip()
    return _quote_legal_notice_with_extra(notice, template_options)


def _quote_delivery(template_options: dict, quote: Quote) -> tuple[str | None, bool]:
    address = str(template_options.get("delivery_address") or getattr(quote, "delivery_address", None) or "").strip()
    differs = bool(
        template_options.get("delivery_address_differs") or getattr(quote, "delivery_address_differs", False)
    )
    return address or None, differs


def _get_quote_by_token(db: Session, token: str, request: Request | None = None) -> Quote:
    if not token or len(token.strip()) < 16:
        raise HTTPException(404, "Not found")
    normalized_token = token.strip()
    enforce_public_rate_limit(
        token_key=f"public-quote:{normalized_token}",
        token_limit=int(getattr(settings, "QUOTE_PUBLIC_RATE_LIMIT_PER_MINUTE", 120) or 120),
        ip_key_prefix="public-quote",
        ip_limit=int(getattr(settings, "QUOTE_PUBLIC_IP_RATE_LIMIT_PER_MINUTE", 600) or 600),
        window_seconds=60,
        request=request,
        detail={"code": "rate_limited", "message": "Trop de consultations de ce devis. Réessayez dans un instant."},
    )
    q = db.query(Quote).filter(Quote.public_token == normalized_token).filter(Quote.public_enabled.is_(True)).first()
    if not q:
        raise HTTPException(404, "Not found")
    if q.status == "draft":
        q.public_enabled = False
        db.add(q)
        db.commit()
        raise HTTPException(404, "Not found")
    if is_quote_public_link_expired(q):
        q.public_enabled = False
        db.add(q)
        db.commit()
        raise HTTPException(
            status_code=410,
            detail={"code": "public_link_expired", "message": quote_public_link_expired_message(q)},
        )
    return q


def _public_party_from_tenant(
    t: Tenant,
    *,
    snapshot: dict | None = None,
    payment_terms_block: dict | None = None,
) -> PublicParty:
    portal = get_portal_settings(t)
    source = dict(snapshot or {})
    logo = None
    snapshot_logo = str(source.get("logo_url") or "").strip() or None
    if snapshot_logo:
        logo = snapshot_logo
    elif t.logo_storage_key:
        try:
            logo = get_logo_url(t.id, t.logo_storage_key)
        except Exception:
            logo = None
    if not logo:
        logo = t.logo_url or None
    address = str(source.get("address") or "").strip() or (t.address or "").strip() or None
    siret = str(source.get("siret") or source.get("legal_id") or "").strip() or (t.siret or None)
    siren = str(source.get("siren") or "").strip() or _derive_siren(siret)
    email = str(source.get("email") or source.get("email_reply_to") or "").strip() or (
        getattr(t, "email_reply_to", None) or None
    )
    support_email = portal.get("support_email") or (getattr(t, "email_reply_to", None) or None)
    footer_note = portal.get("footer_note") or None
    payment_block = payment_terms_block or source.get("payment_terms_block") or {}
    return PublicParty(
        name=(str(source.get("name") or "").strip() or (t.name or "").strip() or "Entreprise"),
        address=address,
        siren=siren,
        siret=siret,
        vat_number=(str(source.get("vat_number") or "").strip() or (t.vat_number or None)),
        vat_regime=(str(source.get("vat_regime") or "").strip() or (getattr(t, "vat_regime", None) or None)),
        vat_exemption_notice=(
            str(source.get("vat_exemption_notice") or "").strip() or (getattr(t, "vat_exemption_notice", None) or None)
        ),
        logo_url=logo,
        email=email,
        phone=(str(source.get("phone") or "").strip() or (getattr(t, "phone", None) or None)),
        legal_form=(str(source.get("legal_form") or "").strip() or (getattr(t, "legal_form", None) or None)),
        share_capital=(str(source.get("share_capital") or "").strip() or (getattr(t, "share_capital", None) or None)),
        rcs=(str(source.get("rcs") or "").strip() or (getattr(t, "rcs", None) or None)),
        vat_on_debits=bool(
            source.get("vat_on_debits") if "vat_on_debits" in source else getattr(t, "vat_on_debits", False)
        ),
        late_payment_interest=(
            str(payment_block.get("late_payment_interest") or "").strip()
            or (getattr(t, "late_payment_interest", None) or None)
        ),
        recovery_fee_eur=float(payment_block.get("recovery_fee_eur"))
        if payment_block.get("recovery_fee_eur") is not None
        else (float(t.recovery_fee_eur) if t.recovery_fee_eur is not None else 40.0),
        discount_terms=(
            str(payment_block.get("discount_terms") or "").strip() or (getattr(t, "discount_terms", None) or None)
        ),
        portal_theme=str(portal.get("theme") or "blue"),
        portal_support_email=support_email,
        portal_footer_note=footer_note,
    )


def _public_party_from_customer(c: Customer, *, snapshot: dict | None = None) -> PublicParty:
    source = dict(snapshot or {})
    address = str(source.get("address") or "").strip() or (c.address or "").strip() or None
    siret = str(source.get("siret") or source.get("legal_id") or "").strip() or (c.siret or None)
    siren = str(source.get("siren") or "").strip() or (c.siren or None) or _derive_siren(siret)
    client_type = str(source.get("client_type") or getattr(c, "client_type", None) or "").strip() or None
    return PublicParty(
        name=(str(source.get("name") or "").strip() or (c.name or "").strip() or "Client"),
        address=address,
        client_type=client_type,
        siren=siren,
        siret=siret or siren,
        vat_number=(str(source.get("vat_number") or "").strip() or (c.vat_number or None)),
        email=(str(source.get("email") or "").strip() or (c.email or None)),
        phone=(str(source.get("phone") or "").strip() or (c.phone or None)),
        logo_url=None,
    )


def _public_quote_out(db: Session, quote: Quote) -> PublicQuoteOut:
    tenant = db.get(Tenant, quote.tenant_id)
    customer = db.get(Customer, quote.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    use_sealed_snapshot = quote.status != "draft"
    supplier_snapshot = (
        quote.supplier_snapshot
        if use_sealed_snapshot and isinstance(getattr(quote, "supplier_snapshot", None), dict)
        else {}
    )
    customer_snapshot = (
        quote.buyer_snapshot if use_sealed_snapshot and isinstance(getattr(quote, "buyer_snapshot", None), dict) else {}
    )
    payment_terms_block = (
        supplier_snapshot.get("payment_terms_block")
        if isinstance(supplier_snapshot.get("payment_terms_block"), dict)
        else None
    )
    lines_snapshot = getattr(quote, "lines_snapshot", None) if use_sealed_snapshot else None
    totals_snapshot = getattr(quote, "totals_snapshot", None) if use_sealed_snapshot else None

    if isinstance(lines_snapshot, list) and lines_snapshot:
        lines_out = [
            PublicQuoteLine(
                line_type=str(raw.get("line_type") or "item"),
                display_number=raw.get("display_number"),
                reference=raw.get("reference"),
                product_name=str(raw.get("product_name") or "").strip() or "Ligne",
                detail=raw.get("detail"),
                quantity=_parse_amount(raw.get("quantity")),
                unit_price=_parse_amount(raw.get("unit_price")),
                vat_rate=_parse_amount(raw.get("vat_rate")),
                vat_category=raw.get("vat_category"),
                unit_code=raw.get("unit_code"),
                exemption_reason_code=raw.get("exemption_reason_code"),
                line_total=_parse_amount(raw.get("line_total")),
            )
            for raw in lines_snapshot
            if isinstance(raw, dict)
        ]
    else:
        lines = db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).order_by(QuoteLine.id.asc()).all()
        lines_out = [
            PublicQuoteLine(
                line_type=getattr(line, "line_type", None) or "item",
                display_number=getattr(line, "display_number", None),
                reference=getattr(line, "reference", None),
                product_name=line.product_name,
                detail=getattr(line, "detail", None),
                quantity=float(line.quantity or 0),
                unit_price=float(line.unit_price or 0),
                vat_rate=float(line.vat_rate or 0),
                vat_category=getattr(line, "vat_category", None),
                unit_code=getattr(line, "unit_code", None),
                exemption_reason_code=getattr(line, "exemption_reason_code", None),
                line_total=round(float(line.quantity or 0) * float(line.unit_price or 0), 2),
            )
            for line in lines
        ]
    today = date.today()
    status = quote.status
    if quote.valid_until and today > quote.valid_until and status in {"draft", "sent"}:
        status = "expired"
    acceptance_mode = (getattr(tenant, "quote_acceptance_mode", None) or "simple").strip().lower() or "simple"
    terms_url, terms_required = _quote_terms_policy(tenant)

    attachments = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.quote_id == quote.id)
        .filter(DocumentAttachment.tenant_id == quote.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .filter(DocumentAttachment.public_visible.is_(True))
        .order_by(DocumentAttachment.created_at.asc())
        .all()
    )
    attachments_out = [
        PublicDocumentAttachmentOut(
            id=a.id,
            filename=a.filename,
            label=a.label,
            content_type=a.content_type,
            size_bytes=int(a.size_bytes or 0),
        )
        for a in attachments
    ]

    template_options = _quote_template_options(quote)
    operation_nature = str(template_options.get("operation_nature") or "services").strip().lower()
    legal_notice = _quote_legal_notice(
        template_options,
        supplier=supplier_snapshot or tenant,
        lines=lines_out,
        payment_terms=getattr(quote, "payment_terms", None),
        valid_until=quote.valid_until,
    )
    payment_iban, payment_bic = _quote_payment_bank_account(template_options, tenant, supplier_snapshot)
    delivery_address, delivery_address_differs = _quote_delivery(template_options, quote)

    return PublicQuoteOut(
        number=quote.number,
        currency=quote.currency,
        status=status,
        issue_date=quote.issue_date,
        service_date=getattr(quote, "service_date", None),
        valid_until=quote.valid_until,
        payment_terms=getattr(quote, "payment_terms", None),
        delivery_address=delivery_address,
        delivery_address_differs=delivery_address_differs,
        operation_nature=operation_nature,
        purchase_order_number=getattr(quote, "purchase_order_number", None),
        note=visible_document_note(
            quote.note,
            template_options.get("document_title"),
            template_options.get("legal_mentions_text"),
        ),
        legal_notice=legal_notice or None,
        payment_iban=payment_iban,
        payment_bic=payment_bic,
        acceptance_mode=acceptance_mode,
        terms_url=terms_url,
        terms_required=terms_required,
        seal_hash=None,
        seal_created_at=None,
        supplier=_public_party_from_tenant(tenant, snapshot=supplier_snapshot, payment_terms_block=payment_terms_block),
        customer=_public_party_from_customer(customer, snapshot=customer_snapshot),
        totals=PublicQuoteTotals(
            total_ex_vat=_parse_amount(
                totals_snapshot.get("total_ex_vat") if isinstance(totals_snapshot, dict) else quote.total_ex_vat
            ),
            total_vat=_parse_amount(
                totals_snapshot.get("total_vat") if isinstance(totals_snapshot, dict) else quote.total_vat
            ),
            total_inc_vat=_parse_amount(
                totals_snapshot.get("total_inc_vat") if isinstance(totals_snapshot, dict) else quote.total_inc_vat
            ),
        ),
        requested_advance=requested_quote_advance_summary(template_options),
        lines=lines_out,
        attachments=attachments_out,
        accepted_at=quote.accepted_at,
        accepted_name=getattr(quote, "accepted_name", None),
        accepted_email=None,
        accepted_terms_url=None,
        accepted_terms_at=getattr(quote, "accepted_terms_at", None),
        rejected_at=quote.rejected_at,
        rejected_reason=getattr(quote, "rejected_reason", None),
    )


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalize_email(email: str | None) -> str:
    return (email or "").strip().lower()


def _is_valid_email(email: str) -> bool:
    return bool(email) and bool(_EMAIL_RE.match(email))


def _hash_pii(value: str | None) -> str | None:
    """Hash potential PII before storing it in DB (RGPD / minimisation)."""
    v = (value or "").strip()
    if not v:
        return None
    digest = hashlib.sha256(f"{settings.SECRET_KEY}:{v}".encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _otp_hash(code: str, *, quote_id: str, email: str) -> str:
    """PBKDF2 hash (slow) to reduce offline brute force if DB leaks."""
    pepper = (settings.SECRET_KEY or "").encode("utf-8")
    salt = f"{quote_id}:{email}".encode("utf-8")
    # 'pepper' is secret, salt is public; we combine both.
    dk = hashlib.pbkdf2_hmac(
        "sha256",
        code.encode("utf-8"),
        pepper + b":" + salt,
        200_000,
    )
    return dk.hex()


def _bump_public_view(db: Session, quote: Quote, *, source: str = "view") -> None:
    """Increment view count with a coarse time window (avoids write storm).

    Also writes a lightweight audit event to the action log (throttled by the
    same time window) so the supplier can see that the customer opened the link.
    """
    window_seconds = int(getattr(settings, "QUOTE_PUBLIC_VIEW_WINDOW_SECONDS", 600) or 600)
    now = _utcnow()
    last = getattr(quote, "public_last_viewed_at", None)
    if last and (now - last).total_seconds() < window_seconds:
        return
    quote.public_view_count = int(getattr(quote, "public_view_count", 0) or 0) + 1
    if not getattr(quote, "public_first_viewed_at", None):
        quote.public_first_viewed_at = now
    quote.public_last_viewed_at = now
    db.add(quote)
    try:
        # Public route: no authenticated user.
        from ..services.action_logs import safe_log_action

        safe_log_action(
            db,
            tenant_id=quote.tenant_id,
            actor_user_id=None,
            action_type="public_view",
            object_type="quote",
            object_id=quote.id,
            metadata={"source": source, "public_view_count": quote.public_view_count},
            commit=False,
        )
    except Exception:
        # Never block customer view.
        pass
    db.commit()


def _format_otp_template(template: str, *, tenant: Tenant, quote: Quote, otp_code: str, email: str) -> str:
    t = (template or "").strip()
    if not t:
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

    safe_company = (tenant.name or "").strip() or "Entreprise"
    return (
        t.replace("{company}", safe_company)
        .replace("{number}", (quote.number or "").strip())
        .replace("{otp_code}", otp_code)
        .replace("{email}", email)
        .replace("{valid_until}", _fmt_date(getattr(quote, "valid_until", None)))
    )


@router.get("/{token}", response_model=PublicQuoteOut)
def get_public_quote(token: str, request: Request, db: Session = Depends(get_db)):
    quote = _get_quote_by_token(db, token, request)
    _bump_public_view(db, quote, source="view")
    return _public_quote_out(db, quote)


@router.get("/{token}/attachments", response_model=list[PublicDocumentAttachmentOut])
def list_public_quote_attachments(token: str, request: Request, db: Session = Depends(get_db)):
    quote = _get_quote_by_token(db, token, request)
    _bump_public_view(db, quote, source="attachments")
    rows = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.quote_id == quote.id)
        .filter(DocumentAttachment.tenant_id == quote.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .filter(DocumentAttachment.public_visible.is_(True))
        .order_by(DocumentAttachment.created_at.asc())
        .all()
    )
    return [
        PublicDocumentAttachmentOut(
            id=a.id,
            filename=a.filename,
            label=a.label,
            content_type=a.content_type,
            size_bytes=int(a.size_bytes or 0),
        )
        for a in rows
    ]


@router.get("/{token}/attachments/{attachment_id}/file")
def get_public_quote_attachment_file(
    token: str, attachment_id: str, request: Request, download: bool = False, db: Session = Depends(get_db)
):
    quote = _get_quote_by_token(db, token, request)
    _bump_public_view(db, quote, source="attachment_file")
    att = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.id == attachment_id)
        .filter(DocumentAttachment.quote_id == quote.id)
        .filter(DocumentAttachment.tenant_id == quote.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .filter(DocumentAttachment.public_visible.is_(True))
        .first()
    )
    if not att:
        raise HTTPException(404, "Not found")

    stream = get_object_stream(att.storage_key)
    if not stream:
        raise HTTPException(404, "Not found")

    status_code = 200
    headers: dict[str, str] = {
        "Cache-Control": "private, max-age=0, no-store",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
    }

    range_header = request.headers.get("range")
    if range_header:
        byte_range = parse_range_header(range_header, stream.total_size)
        if byte_range:
            start, end = byte_range
            ranged = get_object_stream(att.storage_key, byte_range=byte_range)
            if ranged:
                stream = ranged
                status_code = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{stream.total_size}"

    if stream.content_length:
        headers["Content-Length"] = str(stream.content_length)
    if stream.etag:
        headers["ETag"] = stream.etag

    disp = "attachment" if bool(download) else "inline"
    headers["Content-Disposition"] = f'{disp}; filename="{sanitize_filename(att.filename)}"'

    return StreamingResponse(
        stream.body, media_type=att.content_type or "application/octet-stream", headers=headers, status_code=status_code
    )


@router.get("/{token}/pdf")
def get_public_quote_pdf(token: str, request: Request, db: Session = Depends(get_db)):
    quote = _get_quote_by_token(db, token, request)
    _bump_public_view(db, quote, source="pdf")
    from .quotes import _quote_ctx, _safe_filename  # local import to avoid circular import at startup

    filename = _safe_filename("devis", quote.number, "pdf")
    ctx = _quote_ctx(db, quote)
    ctx["proof"] = None
    content = invoice_pdf(ctx)
    return Response(
        content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=0, no-store",
        },
    )


@router.get("/{token}/preview.html")
def get_public_quote_preview_html(token: str, request: Request, db: Session = Depends(get_db)):
    quote = _get_quote_by_token(db, token, request)
    _bump_public_view(db, quote, source="preview")
    from .quotes import _quote_ctx  # local import to avoid circular import at startup

    ctx = _quote_ctx(db, quote)
    ctx["proof"] = None
    html = invoice_html(ctx)
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "private, max-age=0, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src data:; font-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self';",
        },
    )


@router.get("/{token}/bundle.zip")
def get_public_quote_bundle_zip(token: str, request: Request, db: Session = Depends(get_db)):
    """Export ZIP (portail) : PDF du devis + pièces jointes visibles client."""
    quote = _get_quote_by_token(db, token, request)
    _bump_public_view(db, quote, source="bundle")
    from ..services.bundles import build_quote_bundle_zip, stream_zip_file

    path, filename = build_quote_bundle_zip(
        db,
        quote_id=quote.id,
        tenant_id=quote.tenant_id,
        include_private_attachments=False,
        include_proof=False,
    )
    return stream_zip_file(path, filename)


@router.post("/{token}/otp")
def request_quote_otp(token: str, body: PublicQuoteOtpRequest, request: Request, db: Session = Depends(get_db)):
    """Send an OTP to validate acceptance (if enabled for the tenant)."""
    quote = _get_quote_by_token(db, token, request)
    tenant = db.get(Tenant, quote.tenant_id)
    if not tenant:
        raise HTTPException(404, "Not found")

    mode = (getattr(tenant, "quote_acceptance_mode", None) or "simple").strip().lower() or "simple"
    if mode != "otp":
        raise HTTPException(
            400, detail={"code": "otp_not_enabled", "message": "Code de confirmation non activé pour cette entreprise."}
        )
    ensure_public_quote_otp_delivery_allowed(tenant)

    # State checks
    if quote.status in {"draft", "accepted", "rejected", "invoiced", "expired"}:
        raise HTTPException(400, detail={"code": "quote_not_acceptable", "message": "Devis non acceptable."})
    if quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(400, detail={"code": "quote_expired", "message": "Devis expiré."})

    email = _normalize_email(body.email)
    if not _is_valid_email(email):
        raise HTTPException(400, detail={"code": "email_invalid", "message": "Email invalide."})
    if not quote_email_is_allowed(db, quote, email):
        raise HTTPException(
            403,
            detail={
                "code": "otp_email_not_allowed",
                "message": "Utilisez une adresse email déjà rattachée au client du devis.",
            },
        )

    # Mark as sent if needed, and seal as proof
    was_draft = quote.status == "draft"
    if was_draft:
        quote.status = "sent"
    quote.sent_at = quote.sent_at or _utcnow()
    ensure_quote_sealed(db, quote, force=was_draft)

    now = _utcnow()
    min_resend = int(getattr(settings, "QUOTE_OTP_MIN_RESEND_SECONDS", 60) or 60)
    last_sent = getattr(quote, "otp_last_sent_at", None)
    if last_sent and (now - last_sent).total_seconds() < min_resend:
        raise HTTPException(
            429,
            detail={
                "code": "otp_too_soon",
                "message": "Veuillez patienter avant de redemander un code.",
            },
        )

    per_hour = int(getattr(settings, "QUOTE_OTP_RATE_LIMIT_PER_HOUR", 6) or 6)
    key = f"otp:quote:{quote.tenant_id}:{quote.id}:{now.strftime('%Y%m%d%H')}"
    if rate_limit.hit(key, limit=per_hour, window_seconds=3600):
        raise HTTPException(
            429,
            detail={
                "code": "otp_rate_limited",
                "message": "Trop de demandes de code. Réessayez plus tard.",
            },
        )

    code = f"{secrets.randbelow(1_000_000):06d}"
    ttl = int(getattr(settings, "QUOTE_OTP_TTL_SECONDS", 600) or 600)

    quote.otp_email = email
    quote.otp_hash = _otp_hash(code, quote_id=quote.id, email=email)
    quote.otp_expires_at = now + timedelta(seconds=ttl)
    quote.otp_attempts = 0
    quote.otp_last_sent_at = now
    quote.updated_by = None
    db.add(quote)
    db.commit()
    db.refresh(quote)

    # SMTP: in prod-like, raises if not configured
    smtp_ready = assert_smtp_ready_or_raise("quote_otp")

    subject_tmpl = tenant.quote_otp_subject_default or "Code de validation - devis {number}"
    body_tmpl = (
        tenant.quote_otp_body_default
        or "Bonjour,\n\nVoici votre code de validation pour accepter le devis {number} : {otp_code}\n\nCe code expire dans quelques minutes. Ne le transmettez à personne.\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email."
    )
    subject = _format_otp_template(subject_tmpl, tenant=tenant, quote=quote, otp_code=code, email=email)
    text = _format_otp_template(body_tmpl, tenant=tenant, quote=quote, otp_code=code, email=email)

    if smtp_ready:
        event = enqueue_quote_otp_email(
            tenant_id=quote.tenant_id,
            quote_id=quote.id,
            user_id=None,
            to=email,
            subject=subject or "Code de validation devis",
            body=text or "",
            reply_to=resolve_document_reply_to(db, tenant),
        )
        try:
            log_action(
                db,
                tenant_id=quote.tenant_id,
                actor_user_id=None,
                action_type="otp_sent",
                object_type="quote",
                object_id=quote.id,
                metadata={"email_domain": (email.split("@")[-1] if "@" in email else None), "event_id": event.id},
            )
        except Exception:
            pass
        return {"ok": True, "delivery": "email", "expires_at": quote.otp_expires_at.isoformat()}

    # Log-only mode is useful for internal diagnostics, but public portal
    # responses must never expose the OTP value.
    return {"ok": True, "delivery": "log_only", "expires_at": quote.otp_expires_at.isoformat()}


@router.post("/{token}/accept", response_model=PublicQuoteOut)
def accept_public_quote(token: str, payload: PublicQuoteAcceptRequest, request: Request, db: Session = Depends(get_db)):
    quote = _get_quote_by_token(db, token, request)
    locked_quote = _quote_for_update(db, quote.id)
    if (
        not locked_quote
        or locked_quote.public_token != quote.public_token
        or not bool(locked_quote.public_enabled)
        or locked_quote.tenant_id != quote.tenant_id
    ):
        raise HTTPException(404, "Not found")
    quote = locked_quote
    tenant = db.get(Tenant, quote.tenant_id)
    if not tenant:
        raise HTTPException(404, "Not found")

    if quote.status == "draft":
        raise HTTPException(400, detail={"code": "quote_not_acceptable", "message": "Devis non acceptable."})
    if quote.status in {"rejected", "invoiced", "expired"}:
        raise HTTPException(400, detail={"code": "quote_not_acceptable", "message": "Devis non acceptable."})
    if quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(400, detail={"code": "quote_expired", "message": "Devis expiré."})
    if quote.status == "accepted":
        return _public_quote_out(db, quote)

    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, detail={"code": "name_required", "message": "Nom requis pour accepter."})

    email = _normalize_email(payload.email)
    if email and not _is_valid_email(email):
        raise HTTPException(400, detail={"code": "email_invalid", "message": "Email invalide."})

    mode = (getattr(tenant, "quote_acceptance_mode", None) or "simple").strip().lower() or "simple"
    terms_url, terms_required = _quote_terms_policy(tenant)

    if terms_required:
        if not bool(payload.terms_accepted):
            raise HTTPException(400, detail={"code": "terms_required", "message": "Vous devez accepter les CGV."})

    now = _utcnow()

    if mode == "otp":
        if not email:
            raise HTTPException(
                400,
                detail={
                    "code": "email_required",
                    "message": "Une adresse email est nécessaire pour recevoir le code de confirmation.",
                },
            )
        if not quote_email_is_allowed(db, quote, email):
            raise HTTPException(
                403,
                detail={
                    "code": "otp_email_not_allowed",
                    "message": "Utilisez une adresse email déjà rattachée au client du devis.",
                },
            )
        otp = (payload.otp_code or "").strip()
        if not (otp.isdigit() and len(otp) == 6):
            raise HTTPException(400, detail={"code": "otp_invalid", "message": "Code de confirmation invalide."})
        if not getattr(quote, "otp_hash", None) or not getattr(quote, "otp_expires_at", None):
            raise HTTPException(
                400, detail={"code": "otp_missing", "message": "Veuillez demander un code de confirmation."}
            )
        if quote.otp_expires_at and now > quote.otp_expires_at:
            raise HTTPException(400, detail={"code": "otp_expired", "message": "Code de confirmation expiré."})
        if getattr(quote, "otp_email", None) and _normalize_email(getattr(quote, "otp_email", None)) != email:
            raise HTTPException(
                400, detail={"code": "otp_email_mismatch", "message": "Email différent de la demande de code."}
            )
        max_attempts = int(getattr(settings, "QUOTE_OTP_MAX_ATTEMPTS", 5) or 5)
        if int(getattr(quote, "otp_attempts", 0) or 0) >= max_attempts:
            raise HTTPException(400, detail={"code": "otp_locked", "message": "Trop d'essais. Redemandez un code."})
        expected = _otp_hash(otp, quote_id=quote.id, email=email)
        if expected != getattr(quote, "otp_hash", None):
            quote.otp_attempts = int(getattr(quote, "otp_attempts", 0) or 0) + 1
            db.add(quote)
            db.commit()
            raise HTTPException(400, detail={"code": "otp_wrong", "message": "Code de confirmation incorrect."})

    # Mark sent + seal as proof
    was_draft = quote.status == "draft"
    if was_draft:
        quote.status = "sent"
    quote.sent_at = quote.sent_at or now
    ensure_quote_sealed(db, quote, force=was_draft)

    quote.status = "accepted"
    quote.accepted_at = quote.accepted_at or now
    quote.accepted_name = name
    quote.accepted_email = email or None
    quote.accepted_ip = _hash_pii(request.client.host if request.client else None)
    ua = (request.headers.get("user-agent") or "").strip()
    hashed_user_agent = _hash_pii(ua) if ua else None
    quote.accepted_user_agent = hashed_user_agent[:500] if hashed_user_agent else None

    # Terms proof
    if terms_required or bool(payload.terms_accepted):
        quote.accepted_terms_url = terms_url
        quote.accepted_terms_at = now

    # Clear OTP once used
    quote.otp_hash = None
    quote.otp_email = None
    quote.otp_expires_at = None
    quote.otp_attempts = 0
    quote.updated_by = None

    try:
        log_action(
            db,
            tenant_id=quote.tenant_id,
            actor_user_id=None,
            action_type="customer_accept",
            object_type="quote",
            object_id=quote.id,
            metadata={
                "accepted_name_present": bool(name),
                "accepted_contact_present": bool(email),
                "mode": mode,
                "terms_required": terms_required,
                "terms_accepted": bool(payload.terms_accepted),
            },
        )
    except Exception:
        pass
    db.add(quote)
    db.commit()
    db.refresh(quote)
    return _public_quote_out(db, quote)


@router.post("/{token}/reject", response_model=PublicQuoteOut)
def reject_public_quote(token: str, payload: PublicQuoteRejectRequest, request: Request, db: Session = Depends(get_db)):
    quote = _get_quote_by_token(db, token, request)
    locked_quote = _quote_for_update(db, quote.id)
    if (
        not locked_quote
        or locked_quote.public_token != quote.public_token
        or not bool(locked_quote.public_enabled)
        or locked_quote.tenant_id != quote.tenant_id
    ):
        raise HTTPException(404, "Not found")
    quote = locked_quote
    if quote.status == "draft":
        raise HTTPException(
            400,
            detail={
                "code": "quote_not_rejectable",
                "message": "Devis non refusé.",
            },
        )
    if quote.status in {"accepted", "invoiced", "expired"}:
        raise HTTPException(
            400,
            detail={
                "code": "quote_not_rejectable",
                "message": "Devis non refusé (déjà accepté ou facturé).",
            },
        )
    if quote.status == "rejected":
        return _public_quote_out(db, quote)

    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, detail={"code": "name_required", "message": "Nom requis pour refuser."})

    was_draft = quote.status == "draft"
    quote.status = "rejected"
    quote.rejected_at = quote.rejected_at or _utcnow()
    reason = (payload.reason or "").strip()
    quote.rejected_reason = reason or None
    quote.updated_by = None
    ensure_quote_sealed(db, quote, force=was_draft)
    try:
        log_action(
            db,
            tenant_id=quote.tenant_id,
            actor_user_id=None,
            action_type="customer_reject",
            object_type="quote",
            object_id=quote.id,
            metadata={"reason_present": bool(reason), "rejected_name_present": bool(name)},
        )
    except Exception:
        pass
    db.add(quote)
    db.commit()
    db.refresh(quote)
    return _public_quote_out(db, quote)
