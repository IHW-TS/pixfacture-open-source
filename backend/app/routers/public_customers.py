from __future__ import annotations

import hashlib
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import or_
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import ensure_active_subscription, ensure_tenant_legal_acceptance
from ..models import (
    ActionLog,
    CreditNoteRefund,
    Customer,
    Invoice,
    Payment,
    Quote,
    QuoteLine,
    Tenant,
    DocumentAttachment,
)
from ..schemas import (
    PublicCustomerPortalDoc,
    PublicCustomerPortalOut,
    PublicCustomerInvoiceDetailOut,
    PublicCustomerQuoteDetailOut,
    PublicCustomerTimelineEvent,
    PublicInvoiceLine,
    PublicInvoicePaymentInfo,
    PublicInvoiceTotals,
    PublicParty,
    PublicPaymentSummary,
    PublicQuoteAcceptRequest,
    PublicQuoteOtpRequest,
    PublicQuoteRejectRequest,
    PublicQuoteLine,
    PublicQuoteTotals,
    PublicDocumentAttachmentOut,
    InvoiceCreate,
    InvoiceLineIn,
)
from ..jobs.email_jobs import enqueue_quote_otp_email
from ..services import rate_limit
from ..services.action_logs import log_action
from ..services.document_attachments import sanitize_filename
from ..services.email import assert_smtp_ready_or_raise
from ..services.email_reply_to import resolve_document_reply_to
from ..services.invoice_public_artifacts import has_stored_facturx_artifact
from ..services.logo_storage import get_logo_url
from ..services.portal_settings import get_portal_settings
from ..services.product_capabilities import is_product_feature_enabled
from ..services.document_notes import visible_document_note
from ..services.document_pdf_context import document_vat_labels
from ..services.pdf import invoice_html, invoice_pdf
from ..services.public_links import is_invoice_public_link_expired, is_quote_public_link_expired
from ..services.public_rate_limits import enforce_public_rate_limit
from ..services.quote_recipients import quote_email_is_allowed
from ..services.quote_advances import invoice_template_options_from_quote, requested_quote_advance_summary
from ..services.quote_proof import ensure_quote_sealed
from ..services.trial_document_email import ensure_public_quote_otp_delivery_allowed
from ..services.storage import get_object_stream, parse_range_header


router = APIRouter(prefix="/api/public/customers", tags=["public_customers"])


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


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


def _token_last4(token: str | None) -> str:
    clean = str(token or "").strip()
    return clean[-4:] if clean else ""


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


def _legal_rate_label(value: object | None) -> str:
    raw = str(value or "10").strip().replace("%", "") or "10"
    lowered = raw.lower()
    if "taux" in lowered or "bce" in lowered:
        return raw
    return f"{raw} %"


def _supplier_legal_mentions_is_default(value: str | None) -> bool:
    text = (value or "").strip().lower()
    return bool(
        text
        and "recouvrement" in text
        and ("escompte" in text or "paiement anticip" in text)
        and (
            "pénalités de retard" in text
            or "penalites de retard" in text
            or "pénalités au taux" in text
            or "penalites au taux" in text
            or "retard de paiement" in text
        )
    )


def _append_legal_extras(notice: str, template_options: dict, supplier_snapshot: dict, tenant: Tenant) -> str:
    extras: list[str] = []
    for value in (
        supplier_snapshot.get("legal_mentions"),
        getattr(tenant, "legal_mentions", None),
    ):
        text = str(value or "").strip()
        if text and text not in extras and text not in notice and not _supplier_legal_mentions_is_default(text):
            extras.append(text)
    if extras:
        return f"{notice}\n\n" + "\n\n".join(extras)
    return notice


def _invoice_legal_notice(
    template_options: dict, supplier_snapshot: dict, tenant: Tenant, lines: list | None = None
) -> str:
    legal_footer = str(template_options.get("legal_footer_text") or "").strip()
    if legal_footer:
        return _append_legal_extras(legal_footer, template_options, supplier_snapshot, tenant)
    vat_label = document_vat_labels(supplier_snapshot or tenant, lines=lines or [], is_english=False).get("legal") or ""
    vat_sentence = vat_label if vat_label.endswith((".", "!", "?")) else (f"{vat_label}." if vat_label else "")
    raw_payment_block = supplier_snapshot.get("payment_terms_block") if isinstance(supplier_snapshot, dict) else {}
    payment_block = raw_payment_block if isinstance(raw_payment_block, dict) else {}
    penalty_rate = _legal_rate_label(
        template_options.get("legal_penalty_rate")
        or (payment_block or {}).get("late_payment_interest")
        or getattr(tenant, "late_payment_interest", None)
    )
    recovery_fee = str(
        template_options.get("legal_recovery_fee")
        or (payment_block or {}).get("recovery_fee_eur")
        or getattr(tenant, "recovery_fee_eur", None)
        or "40"
    ).strip()
    notice = (
        f"{vat_sentence + ' ' if vat_sentence else ''}Aucun escompte n'est accordé en cas de paiement anticipé. "
        f"En cas de retard de paiement, des pénalités au taux de {penalty_rate} seront dues à compter du lendemain "
        f"de l'échéance, ainsi qu'une indemnité forfaitaire de {recovery_fee} € pour frais de recouvrement."
    )
    return _append_legal_extras(notice, template_options, supplier_snapshot, tenant)


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


def _legal_notice_with_quote_extra(notice: str, template_options: dict) -> str:
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
        return _legal_notice_with_quote_extra(legal_notice, template_options)
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
    return _legal_notice_with_quote_extra(notice, template_options)


def _quote_delivery(template_options: dict, quote: Quote) -> tuple[str | None, bool]:
    address = str(template_options.get("delivery_address") or getattr(quote, "delivery_address", None) or "").strip()
    differs = bool(
        template_options.get("delivery_address_differs") or getattr(quote, "delivery_address_differs", False)
    )
    return address or None, differs


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
    """PBKDF2 hash (slow) to reduce offline brute-force if DB leaks."""
    pepper = (settings.SECRET_KEY or "").encode("utf-8")
    salt = f"{quote_id}:{email}".encode("utf-8")
    dk = hashlib.pbkdf2_hmac(
        "sha256",
        code.encode("utf-8"),
        pepper + b":" + salt,
        200_000,
    )
    return dk.hex()


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


def _get_customer_by_token(db: Session, token: str, request: Request | None = None) -> Customer:
    if not token or len(token.strip()) < 16:
        raise HTTPException(404, "Not found")
    normalized_token = token.strip()
    enforce_public_rate_limit(
        token_key=f"public-customer-portal:{normalized_token}",
        token_limit=int(getattr(settings, "CUSTOMER_PORTAL_RATE_LIMIT_PER_MINUTE", 120) or 120),
        ip_key_prefix="public-customer-portal",
        ip_limit=int(getattr(settings, "CUSTOMER_PORTAL_IP_RATE_LIMIT_PER_MINUTE", 600) or 600),
        window_seconds=60,
        request=request,
        detail={
            "code": "rate_limited",
            "message": "Trop de requêtes sur ce portail. Réessayez dans quelques instants.",
        },
    )
    c = (
        db.query(Customer)
        .filter(Customer.portal_token == normalized_token)
        .filter(Customer.portal_enabled.is_(True))
        .first()
    )
    if not c:
        raise HTTPException(404, "Not found")
    ttl_days = int(getattr(settings, "CUSTOMER_PORTAL_LINK_TTL_DAYS", 30) or 30)
    created_at = getattr(c, "portal_created_at", None)
    now = _utcnow()
    if ttl_days > 0 and created_at and now >= created_at + timedelta(days=ttl_days):
        c.portal_enabled = False
        db.add(c)
        db.commit()
        raise HTTPException(
            status_code=410,
            detail={"code": "customer_portal_expired", "message": "Ce lien de portail client a expiré."},
        )
    if ttl_days > 0 and not created_at:
        c.portal_created_at = now
        db.add(c)
        db.commit()
        db.refresh(c)
    return c


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
        naf_code=(str(source.get("naf_code") or "").strip() or (getattr(t, "naf_code", None) or None)),
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


def _bump_portal_view(db: Session, cust: Customer, *, source: str = "view", commit: bool = True) -> None:
    """Increment view count with a coarse time window (avoids write storms)."""
    window_seconds = int(getattr(settings, "CUSTOMER_PORTAL_VIEW_WINDOW_SECONDS", 600) or 600)
    now = _utcnow()
    last = getattr(cust, "portal_last_viewed_at", None)
    if last and (now - last).total_seconds() < window_seconds:
        return
    cust.portal_view_count = int(getattr(cust, "portal_view_count", 0) or 0) + 1
    if not getattr(cust, "portal_first_viewed_at", None):
        cust.portal_first_viewed_at = now
    cust.portal_last_viewed_at = now
    db.add(cust)
    try:
        from ..services.action_logs import safe_log_action

        safe_log_action(
            db,
            tenant_id=cust.tenant_id,
            actor_user_id=None,
            action_type="public_view",
            object_type="customer_portal",
            object_id=cust.id,
            metadata={"source": source, "portal_view_count": cust.portal_view_count},
            commit=False,
        )
    except Exception:
        pass
    if commit:
        db.commit()


def _portal_document_visible(portal: dict, document: object) -> bool:
    if (
        isinstance(document, Quote)
        and bool(getattr(document, "public_enabled", False))
        and getattr(document, "public_token", None)
        and is_quote_public_link_expired(document)
    ):
        return False
    if bool(portal.get("show_all_documents", False)):
        return True
    if isinstance(document, Invoice) and is_invoice_public_link_expired(document):
        return False
    return bool(getattr(document, "public_enabled", False) and getattr(document, "public_token", None))


def _is_tenant_pro(tenant: Tenant | None) -> bool:
    return is_product_feature_enabled(tenant, "einvoicing_enabled")


def _stripe_invoice_payments_enabled(tenant: Tenant | None) -> bool:
    """Customer invoice card payments are intentionally disabled.

    Stripe is kept for SaaS billing and token packs only. Collecting invoice
    payments for customer tenants would require a connected-account flow.
    """
    return False


def _payment_tracking_enabled(tenant: Tenant | None) -> bool:
    return is_product_feature_enabled(tenant, "payments_enabled")


def _invoice_status_for_customer_portal(inv: Invoice, *, payment_tracking_enabled: bool) -> str:
    status = str(inv.status or "issued").strip().lower() or "issued"
    if payment_tracking_enabled:
        return status
    if status in {"paid", "partial", "overdue", "refunded", "partially_refunded"}:
        return "sent" if getattr(inv, "sent_at", None) else "issued"
    return status


def _quote_status_for_portal(q: Quote) -> str:
    # Détection simple de l'expiration (sans write)
    if q.valid_until and date.today() > q.valid_until and q.status in {"draft", "sent"}:
        return "expired"
    return q.status


def _last_payment_summary(db: Session, inv: Invoice) -> PublicPaymentSummary | None:
    p = db.query(Payment).filter(Payment.invoice_id == inv.id).order_by(Payment.date.desc()).first()
    if not p:
        return None
    return PublicPaymentSummary(
        date=p.date,
        method=p.method,
        amount=float(p.amount or 0),
        provider=getattr(p, "provider", None),
        receipt_url=getattr(p, "receipt_url", None),
        card_brand=getattr(p, "card_brand", None),
        card_last4=getattr(p, "card_last4", None),
    )


def _timeline_sort(events: list[PublicCustomerTimelineEvent]) -> list[PublicCustomerTimelineEvent]:
    try:
        return sorted(events, key=lambda e: e.at)
    except Exception:
        return events


def _invoice_action_events(
    db: Session,
    inv: Invoice,
    *,
    payment_tracking_enabled: bool = True,
) -> list[PublicCustomerTimelineEvent]:
    """Safe, PII-free timeline events derived from ActionLog.

    IMPORTANT: some invoice actions include recipient emails in metadata.
    We never expose metadata here: we only convert action names to high level
    events + timestamps.
    """
    allowed = {"email": ("email", "Email envoyé")}
    if payment_tracking_enabled:
        allowed.update(
            {
                "followup_email": ("followup", "Relance envoyée"),
                "remind": ("followup", "Relance enregistrée"),
                "stripe_checkout": ("payment", "Paiement initié"),
            }
        )
    logs = (
        db.query(ActionLog)
        .filter(ActionLog.tenant_id == inv.tenant_id)
        .filter(ActionLog.entity == "invoice")
        .filter(ActionLog.entity_id == inv.id)
        .filter(ActionLog.action.in_(list(allowed.keys())))
        .order_by(ActionLog.created_at.asc())
        .limit(50)
        .all()
    )
    out: list[PublicCustomerTimelineEvent] = []
    for row in logs:
        kind, label = allowed.get(row.action) or ("event", row.action)
        out.append(PublicCustomerTimelineEvent(kind=kind, label=label, at=row.created_at))
    return out


def _quote_action_events(db: Session, q: Quote) -> list[PublicCustomerTimelineEvent]:
    allowed = {
        "send_email": ("email", "Email envoyé"),
        "followup_email": ("followup", "Relance envoyée"),
        "otp_sent": ("otp", "Code de validation envoyé"),
        "customer_accept": ("accept", "Devis accepté"),
        "customer_reject": ("reject", "Devis refusé"),
        "convert": ("convert", "Converti en facture"),
        "public_view": ("view", "Consulté"),
    }
    logs = (
        db.query(ActionLog)
        .filter(ActionLog.tenant_id == q.tenant_id)
        .filter(ActionLog.entity == "quote")
        .filter(ActionLog.entity_id == q.id)
        .filter(ActionLog.action.in_(list(allowed.keys())))
        .order_by(ActionLog.created_at.asc())
        .limit(80)
        .all()
    )
    out: list[PublicCustomerTimelineEvent] = []
    for row in logs:
        kind, label = allowed.get(row.action) or ("event", row.action)
        out.append(PublicCustomerTimelineEvent(kind=kind, label=label, at=row.created_at))
    return out


@router.get("/{token}", response_model=PublicCustomerPortalOut)
def get_public_customer_portal(token: str, request: Request, db: Session = Depends(get_db)):
    cust = _get_customer_by_token(db, token, request)
    tenant = db.get(Tenant, cust.tenant_id)
    if not tenant:
        raise HTTPException(404, "Not found")

    _bump_portal_view(db, cust, source="view")

    portal = get_portal_settings(tenant)
    payment_tracking_enabled = _payment_tracking_enabled(tenant)

    documents: list[PublicCustomerPortalDoc] = []

    # Quotes (non-draft)
    quotes = (
        db.query(Quote)
        .filter(Quote.tenant_id == cust.tenant_id)
        .filter(Quote.customer_id == cust.id)
        .filter(Quote.status != "draft")
        .order_by(Quote.issue_date.desc())
        .limit(50)
        .all()
    )
    for q in quotes:
        if not _portal_document_visible(portal, q):
            continue
        portal_path = None
        if getattr(q, "public_enabled", False) and getattr(q, "public_token", None):
            portal_path = f"/q/{q.public_token}"
        documents.append(
            PublicCustomerPortalDoc(
                kind="quote",
                id=q.id,
                number=q.number,
                currency=(q.currency or "EUR"),
                status=_quote_status_for_portal(q),
                issue_date=q.issue_date,
                valid_until=q.valid_until,
                total_inc_vat=float(q.total_inc_vat or 0),
                portal_path=portal_path,
                pdf_path=f"/api/public/customers/{token}/quotes/{q.id}/pdf",
            )
        )

    # Invoices + credit notes (non-draft/canceled)
    invoices = (
        db.query(Invoice)
        .filter(Invoice.tenant_id == cust.tenant_id)
        .filter(Invoice.customer_id == cust.id)
        .filter(Invoice.status.notin_(["draft", "canceled"]))
        .order_by(Invoice.issue_date.desc())
        .limit(80)
        .all()
    )

    from .invoices import _compute_due_date_no_write, _outstanding, _refunds_total

    for inv in invoices:
        if not _portal_document_visible(portal, inv):
            continue
        due_date = _compute_due_date_no_write(inv)
        is_credit = (inv.type or "invoice") == "credit_note"
        if is_credit and not bool(portal.get("show_credit_notes", True)):
            continue

        balance_due: float | None = None
        if payment_tracking_enabled:
            # invoices => reste dû, credit notes => reste à rembourser (refunds)
            if is_credit:
                # credit notes are stored as negative totals; the refundable amount is abs(total_inc_vat)
                total = abs(Decimal(str(inv.total_inc_vat or 0)))
                refunded = _refunds_total(db, inv)
                balance_due = float(max(total - refunded, Decimal("0")))
            else:
                balance_due = float(max(_outstanding(db, inv), Decimal("0")))

        # can pay by card
        can_pay = bool(
            _stripe_invoice_payments_enabled(tenant)
            and payment_tracking_enabled
            and not is_credit
            and inv.status not in {"paid"}
            and bool(balance_due and balance_due > 0)
            and (inv.currency or "EUR").strip().upper() == "EUR"
        )

        portal_path = None
        if getattr(inv, "public_enabled", False) and getattr(inv, "public_token", None):
            portal_path = f"/i/{inv.public_token}"

        facturx_path = None
        if _is_tenant_pro(tenant) and has_stored_facturx_artifact(db, inv):
            facturx_path = f"/api/public/customers/{token}/invoices/{inv.id}/facturx"

        documents.append(
            PublicCustomerPortalDoc(
                kind="credit_note" if is_credit else "invoice",
                id=inv.id,
                number=inv.number,
                currency=(inv.currency or "EUR"),
                status=_invoice_status_for_customer_portal(
                    inv,
                    payment_tracking_enabled=payment_tracking_enabled,
                ),
                issue_date=inv.issue_date,
                due_date=due_date,
                total_inc_vat=float(inv.total_inc_vat or 0),
                balance_due=balance_due,
                portal_path=portal_path,
                pdf_path=f"/api/public/customers/{token}/invoices/{inv.id}/pdf",
                facturx_path=facturx_path,
                can_pay_by_card=can_pay,
                last_payment=_last_payment_summary(db, inv) if payment_tracking_enabled else None,
            )
        )

    # Tri global (issue_date desc)
    documents.sort(key=lambda d: d.issue_date or datetime.min, reverse=True)

    return PublicCustomerPortalOut(
        supplier=_public_party_from_tenant(tenant),
        customer=_public_party_from_customer(cust),
        documents=documents,
        payment_tracking_enabled=payment_tracking_enabled,
    )


def _get_invoice_for_customer_portal(
    db: Session, token: str, invoice_id: str, request: Request | None = None
) -> tuple[Customer, Invoice, Tenant]:
    cust = _get_customer_by_token(db, token, request)
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.tenant_id != cust.tenant_id or inv.customer_id != cust.id:
        raise HTTPException(404, "Not found")
    if inv.status in {"draft", "canceled"}:
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, cust.tenant_id)
    if not tenant:
        raise HTTPException(404, "Not found")
    portal = get_portal_settings(tenant)
    if not _portal_document_visible(portal, inv):
        raise HTTPException(404, "Not found")
    return cust, inv, tenant


def _get_quote_for_customer_portal(
    db: Session, token: str, quote_id: str, request: Request | None = None
) -> tuple[Customer, Quote, Tenant]:
    cust = _get_customer_by_token(db, token, request)
    q = db.get(Quote, quote_id)
    if not q or q.tenant_id != cust.tenant_id or q.customer_id != cust.id:
        raise HTTPException(404, "Not found")
    if q.status == "draft":
        raise HTTPException(404, "Not found")
    tenant = db.get(Tenant, cust.tenant_id)
    if not tenant:
        raise HTTPException(404, "Not found")
    portal = get_portal_settings(tenant)
    if not _portal_document_visible(portal, q):
        raise HTTPException(404, "Not found")
    return cust, q, tenant


def _public_customer_invoice_detail_out(
    db: Session, token: str, cust: Customer, inv: Invoice, tenant: Tenant
) -> PublicCustomerInvoiceDetailOut:
    from .invoices import (
        _compute_due_date_no_write,
        _ctx,
        _outstanding,
        _refunds_total,
        _snapshot_customer,
        _snapshot_supplier,
    )

    is_credit = (inv.type or "invoice") == "credit_note"
    ctx = _ctx(db, inv, allow_missing_identifiers=True)
    ctx_totals = ctx.get("totals") if isinstance(ctx.get("totals"), dict) else {}
    ctx_lines = ctx.get("lines") if isinstance(ctx.get("lines"), list) else []
    template_options = ctx.get("template_options") if isinstance(ctx.get("template_options"), dict) else {}
    supplier_snapshot_source = inv.seller_snapshot if isinstance(inv.seller_snapshot, dict) else None
    if not supplier_snapshot_source and isinstance(getattr(inv, "supplier_snapshot", None), dict):
        supplier_snapshot_source = inv.supplier_snapshot
    supplier_snapshot = _snapshot_supplier(tenant, supplier_snapshot_source or {}, inv)
    customer_snapshot = _snapshot_customer(cust, inv.buyer_snapshot if isinstance(inv.buyer_snapshot, dict) else {})
    payment_terms_block = supplier_snapshot.get("payment_terms_block") if isinstance(supplier_snapshot, dict) else None
    due_date = _compute_due_date_no_write(inv)
    payment_tracking_enabled = _payment_tracking_enabled(tenant)
    balance_due = 0.0
    if payment_tracking_enabled:
        if is_credit:
            total_credit = abs(Decimal(str(inv.total_inc_vat or 0)))
            refunded = _refunds_total(db, inv)
            balance_due = float(max(total_credit - refunded, Decimal("0")))
        else:
            balance_due = float(max(_outstanding(db, inv), Decimal("0")))

    has_facturx = bool(_is_tenant_pro(tenant) and has_stored_facturx_artifact(db, inv))
    card_payment_enabled = bool(
        _stripe_invoice_payments_enabled(tenant)
        and payment_tracking_enabled
        and not is_credit
        and inv.status not in {"draft", "canceled", "paid"}
        and balance_due > 0
        and (inv.currency or "EUR").strip().upper() == "EUR"
    )

    iban = str(supplier_snapshot.get("iban") or "").strip() or None
    bic = str(supplier_snapshot.get("bic") or "").strip() or None
    payment_info = None
    if iban or bic:
        payment_info = PublicInvoicePaymentInfo(
            iban=iban,
            bic=bic,
            payment_reference=(inv.number or None),
        )

    payments = (
        db.query(Payment).filter(Payment.invoice_id == inv.id).order_by(Payment.date.desc()).limit(50).all()
        if payment_tracking_enabled
        else []
    )
    payments_out = [
        PublicPaymentSummary(
            date=p.date,
            method=p.method,
            amount=float(p.amount or 0),
            provider=getattr(p, "provider", None),
            receipt_url=getattr(p, "receipt_url", None),
            card_brand=getattr(p, "card_brand", None),
            card_last4=getattr(p, "card_last4", None),
        )
        for p in payments
    ]

    refunds: list[CreditNoteRefund] = []
    if is_credit and payment_tracking_enabled:
        refunds = (
            db.query(CreditNoteRefund)
            .filter(CreditNoteRefund.invoice_id == inv.id)
            .order_by(CreditNoteRefund.date.desc())
            .limit(50)
            .all()
        )

    # Timeline (PII-free)
    events: list[PublicCustomerTimelineEvent] = []
    base_issue = inv.issued_at or inv.issue_date
    if base_issue:
        events.append(PublicCustomerTimelineEvent(kind="issued", label="Émise", at=base_issue))
    if inv.sent_at:
        events.append(PublicCustomerTimelineEvent(kind="sent", label="Envoyée", at=inv.sent_at))
    if due_date:
        events.append(PublicCustomerTimelineEvent(kind="due", label="Échéance", at=due_date))
    if payment_tracking_enabled and inv.paid_at:
        events.append(PublicCustomerTimelineEvent(kind="paid", label="Soldée", at=inv.paid_at))
    events.extend(
        _invoice_action_events(
            db,
            inv,
            payment_tracking_enabled=payment_tracking_enabled,
        )
    )
    for p in payments:
        method_label = "Paiement reçu"
        method_lower = str(p.method or "").lower()
        if "refund" in method_lower:
            method_label = "Remboursement"
        elif "chargeback" in method_lower or "dispute" in method_lower:
            method_label = "Contestation carte"
        events.append(
            PublicCustomerTimelineEvent(
                kind="payment",
                label=method_label,
                at=p.date,
                amount=float(p.amount or 0),
                method=(p.method or None),
                status=None,
            )
        )
    for r in refunds:
        events.append(
            PublicCustomerTimelineEvent(
                kind="refund",
                label="Remboursement",
                at=r.date,
                amount=float(r.amount or 0),
                method=(r.method or None),
                status=None,
            )
        )
    events = _timeline_sort(events)

    facturx_path = None
    if _is_tenant_pro(tenant) and has_facturx:
        facturx_path = f"/api/public/customers/{token}/invoices/{inv.id}/facturx"

    attachments = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.invoice_id == inv.id)
        .filter(DocumentAttachment.tenant_id == inv.tenant_id)
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

    return PublicCustomerInvoiceDetailOut(
        id=inv.id,
        payment_tracking_enabled=payment_tracking_enabled,
        number=inv.number,
        type=getattr(inv, "type", None),
        currency=(inv.currency or "EUR"),
        status=_invoice_status_for_customer_portal(
            inv,
            payment_tracking_enabled=payment_tracking_enabled,
        ),
        issue_date=inv.issue_date,
        service_date=getattr(inv, "service_date", None),
        due_date=due_date,
        payment_terms=getattr(inv, "payment_terms", None),
        delivery_address=getattr(inv, "delivery_address", None),
        delivery_address_differs=bool(getattr(inv, "delivery_address_differs", False)),
        operation_nature=getattr(inv, "operation_nature", None),
        purchase_order_number=getattr(inv, "purchase_order_number", None),
        note=visible_document_note(
            inv.note,
            template_options.get("document_title"),
            template_options.get("legal_mentions_text"),
        ),
        legal_notice=_invoice_legal_notice(template_options, supplier_snapshot, tenant, ctx_lines),
        supplier=_public_party_from_tenant(tenant, snapshot=supplier_snapshot, payment_terms_block=payment_terms_block),
        customer=_public_party_from_customer(cust, snapshot=customer_snapshot),
        totals=PublicInvoiceTotals(
            total_ex_vat=float(ctx_totals.get("ht") or 0),
            total_vat=float(ctx_totals.get("vat") or 0),
            total_inc_vat=float(ctx_totals.get("ttc") or 0),
            balance_due=balance_due,
            allowance=float(ctx_totals.get("allowance") or 0),
            prepaid=float(ctx_totals.get("prepaid") or 0),
        ),
        lines=[
            PublicInvoiceLine(
                line_type=str(line.get("line_type") or "item"),
                display_number=line.get("display_number"),
                reference=line.get("reference"),
                product_name=str(line.get("product_name") or "Ligne"),
                detail=line.get("detail"),
                quantity=float(line.get("quantity") or 0),
                unit_price=float(line.get("unit_price") or 0),
                vat_rate=float(line.get("vat_rate") or 0),
                vat_category=line.get("vat_category"),
                unit_code=line.get("unit_code"),
                exemption_reason_code=line.get("exemption_reason_code"),
                line_total=float(line.get("line_total") or 0),
            )
            for line in ctx_lines
        ],
        attachments=attachments_out,
        payment=payment_info,
        payments=payments_out,
        has_facturx=has_facturx,
        card_payment_enabled=card_payment_enabled,
        reminder_count=int(getattr(inv, "reminder_count", 0) or 0) if payment_tracking_enabled else 0,
        last_reminder_at=getattr(inv, "last_reminder_at", None) if payment_tracking_enabled else None,
        sent_at=getattr(inv, "sent_at", None),
        issued_at=getattr(inv, "issued_at", None),
        paid_at=getattr(inv, "paid_at", None) if payment_tracking_enabled else None,
        pdf_path=f"/api/public/customers/{token}/invoices/{inv.id}/pdf",
        facturx_path=facturx_path,
        events=events,
    )


def _public_customer_quote_detail_out(
    db: Session, token: str, cust: Customer, q: Quote, tenant: Tenant
) -> PublicCustomerQuoteDetailOut:
    status = _quote_status_for_portal(q)
    acceptance_mode = (getattr(tenant, "quote_acceptance_mode", None) or "simple").strip().lower() or "simple"
    terms_url, terms_required = _quote_terms_policy(tenant)
    use_sealed_snapshot = q.status != "draft"
    supplier_snapshot = (
        q.supplier_snapshot if use_sealed_snapshot and isinstance(getattr(q, "supplier_snapshot", None), dict) else {}
    )
    customer_snapshot = (
        q.buyer_snapshot if use_sealed_snapshot and isinstance(getattr(q, "buyer_snapshot", None), dict) else {}
    )
    payment_terms_block = (
        supplier_snapshot.get("payment_terms_block")
        if isinstance(supplier_snapshot.get("payment_terms_block"), dict)
        else None
    )
    lines_snapshot = getattr(q, "lines_snapshot", None) if use_sealed_snapshot else None
    totals_snapshot = getattr(q, "totals_snapshot", None) if use_sealed_snapshot else None

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
        lines = db.query(QuoteLine).filter(QuoteLine.quote_id == q.id).order_by(QuoteLine.id.asc()).all()
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

    invoice_number = None
    invoice_status = None
    if getattr(q, "invoice_id", None):
        inv = db.get(Invoice, q.invoice_id)
        if inv and inv.tenant_id == q.tenant_id:
            invoice_number = inv.number
            invoice_status = inv.status

    portal = get_portal_settings(tenant)
    convert_mode = str(portal.get("quote_convert_mode") or "disabled").strip().lower()
    can_convert = bool(status == "accepted" and not getattr(q, "invoice_id", None) and convert_mode != "disabled")
    if status == "expired":
        can_convert = False

    events: list[PublicCustomerTimelineEvent] = []
    if q.issue_date:
        events.append(PublicCustomerTimelineEvent(kind="issued", label="Émis", at=q.issue_date))
    if getattr(q, "sent_at", None):
        events.append(PublicCustomerTimelineEvent(kind="sent", label="Envoyé", at=q.sent_at))
    if getattr(q, "accepted_at", None):
        events.append(PublicCustomerTimelineEvent(kind="accept", label="Accepté", at=q.accepted_at))
    if getattr(q, "rejected_at", None):
        events.append(PublicCustomerTimelineEvent(kind="reject", label="Refusé", at=q.rejected_at))
    events.extend(_quote_action_events(db, q))
    events = _timeline_sort(events)

    quote_attachments = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.quote_id == q.id)
        .filter(DocumentAttachment.tenant_id == q.tenant_id)
        .filter(DocumentAttachment.deleted_at.is_(None))
        .filter(DocumentAttachment.public_visible.is_(True))
        .order_by(DocumentAttachment.created_at.asc())
        .all()
    )
    quote_attachments_out = [
        PublicDocumentAttachmentOut(
            id=a.id,
            filename=a.filename,
            label=a.label,
            content_type=a.content_type,
            size_bytes=int(a.size_bytes or 0),
        )
        for a in quote_attachments
    ]

    template_options = _quote_template_options(q)
    operation_nature = str(template_options.get("operation_nature") or "services").strip().lower()
    legal_notice = _quote_legal_notice(
        template_options,
        supplier=supplier_snapshot or tenant,
        lines=lines_out,
        payment_terms=getattr(q, "payment_terms", None),
        valid_until=q.valid_until,
    )
    payment_iban, payment_bic = _quote_payment_bank_account(template_options, tenant, supplier_snapshot)
    delivery_address, delivery_address_differs = _quote_delivery(template_options, q)

    return PublicCustomerQuoteDetailOut(
        id=q.id,
        invoice_id=getattr(q, "invoice_id", None),
        invoice_number=invoice_number,
        invoice_status=invoice_status,
        number=q.number,
        currency=(q.currency or "EUR"),
        status=status,
        issue_date=q.issue_date,
        service_date=getattr(q, "service_date", None),
        valid_until=q.valid_until,
        payment_terms=getattr(q, "payment_terms", None),
        delivery_address=delivery_address,
        delivery_address_differs=delivery_address_differs,
        operation_nature=operation_nature,
        purchase_order_number=getattr(q, "purchase_order_number", None),
        note=visible_document_note(
            q.note,
            template_options.get("document_title"),
            template_options.get("legal_mentions_text"),
        ),
        legal_notice=legal_notice or None,
        payment_iban=payment_iban,
        payment_bic=payment_bic,
        supplier=_public_party_from_tenant(tenant, snapshot=supplier_snapshot, payment_terms_block=payment_terms_block),
        customer=_public_party_from_customer(cust, snapshot=customer_snapshot),
        totals=PublicQuoteTotals(
            total_ex_vat=_parse_amount(
                totals_snapshot.get("total_ex_vat") if isinstance(totals_snapshot, dict) else q.total_ex_vat
            ),
            total_vat=_parse_amount(
                totals_snapshot.get("total_vat") if isinstance(totals_snapshot, dict) else q.total_vat
            ),
            total_inc_vat=_parse_amount(
                totals_snapshot.get("total_inc_vat") if isinstance(totals_snapshot, dict) else q.total_inc_vat
            ),
        ),
        requested_advance=requested_quote_advance_summary(template_options),
        lines=lines_out,
        attachments=quote_attachments_out,
        acceptance_mode=acceptance_mode,
        terms_url=terms_url,
        terms_required=terms_required,
        seal_hash=None,
        seal_created_at=None,
        accepted_at=getattr(q, "accepted_at", None),
        accepted_name=getattr(q, "accepted_name", None),
        accepted_email=None,
        accepted_terms_url=None,
        accepted_terms_at=getattr(q, "accepted_terms_at", None),
        rejected_at=getattr(q, "rejected_at", None),
        rejected_reason=getattr(q, "rejected_reason", None),
        reminder_count=int(getattr(q, "reminder_count", 0) or 0),
        last_reminder_at=getattr(q, "last_reminder_at", None),
        sent_at=getattr(q, "sent_at", None),
        pdf_path=f"/api/public/customers/{token}/quotes/{q.id}/pdf",
        can_convert=can_convert,
        quote_convert_mode=convert_mode,
        events=events,
    )


@router.get("/{token}/invoices/{invoice_id}", response_model=PublicCustomerInvoiceDetailOut)
def get_customer_portal_invoice_detail(token: str, invoice_id: str, request: Request, db: Session = Depends(get_db)):
    cust, inv, tenant = _get_invoice_for_customer_portal(db, token, invoice_id, request)
    _bump_portal_view(db, cust, source="invoice_detail")
    return _public_customer_invoice_detail_out(db, token, cust, inv, tenant)


@router.get("/{token}/quotes/{quote_id}", response_model=PublicCustomerQuoteDetailOut)
def get_customer_portal_quote_detail(token: str, quote_id: str, request: Request, db: Session = Depends(get_db)):
    cust, q, tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    _bump_portal_view(db, cust, source="quote_detail")
    return _public_customer_quote_detail_out(db, token, cust, q, tenant)


@router.get("/{token}/invoices/{invoice_id}/attachments", response_model=list[PublicDocumentAttachmentOut])
def list_customer_portal_invoice_attachments(
    token: str, invoice_id: str, request: Request, db: Session = Depends(get_db)
):
    cust, inv, tenant = _get_invoice_for_customer_portal(db, token, invoice_id, request)
    _bump_portal_view(db, cust, source="invoice_attachments")
    rows = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.invoice_id == inv.id)
        .filter(DocumentAttachment.tenant_id == inv.tenant_id)
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


@router.get("/{token}/invoices/{invoice_id}/attachments/{attachment_id}/file")
def get_customer_portal_invoice_attachment_file(
    token: str,
    invoice_id: str,
    attachment_id: str,
    request: Request,
    download: bool = False,
    db: Session = Depends(get_db),
):
    cust, inv, tenant = _get_invoice_for_customer_portal(db, token, invoice_id, request)
    _bump_portal_view(db, cust, source="invoice_attachment_file")
    att = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.id == attachment_id)
        .filter(DocumentAttachment.invoice_id == inv.id)
        .filter(DocumentAttachment.tenant_id == inv.tenant_id)
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


@router.get("/{token}/quotes/{quote_id}/attachments", response_model=list[PublicDocumentAttachmentOut])
def list_customer_portal_quote_attachments(token: str, quote_id: str, request: Request, db: Session = Depends(get_db)):
    cust, q, tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    _bump_portal_view(db, cust, source="quote_attachments")
    rows = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.quote_id == q.id)
        .filter(DocumentAttachment.tenant_id == q.tenant_id)
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


@router.get("/{token}/quotes/{quote_id}/attachments/{attachment_id}/file")
def get_customer_portal_quote_attachment_file(
    token: str,
    quote_id: str,
    attachment_id: str,
    request: Request,
    download: bool = False,
    db: Session = Depends(get_db),
):
    cust, q, tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    _bump_portal_view(db, cust, source="quote_attachment_file")
    att = (
        db.query(DocumentAttachment)
        .filter(DocumentAttachment.id == attachment_id)
        .filter(DocumentAttachment.quote_id == q.id)
        .filter(DocumentAttachment.tenant_id == q.tenant_id)
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


@router.post("/{token}/quotes/{quote_id}/otp")
def request_customer_portal_quote_otp(
    token: str, quote_id: str, body: PublicQuoteOtpRequest, request: Request, db: Session = Depends(get_db)
):
    """Send an OTP to validate quote acceptance from the unified customer portal."""
    cust, quote, tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    _bump_portal_view(db, cust, source="quote_otp")

    mode = (getattr(tenant, "quote_acceptance_mode", None) or "simple").strip().lower() or "simple"
    if mode != "otp":
        raise HTTPException(
            400, detail={"code": "otp_not_enabled", "message": "Code de confirmation non activé pour cette entreprise."}
        )
    ensure_public_quote_otp_delivery_allowed(tenant)

    if quote.status in {"accepted", "rejected", "invoiced", "expired"}:
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
            429, detail={"code": "otp_too_soon", "message": "Veuillez patienter avant de redemander un code."}
        )

    per_hour = int(getattr(settings, "QUOTE_OTP_RATE_LIMIT_PER_HOUR", 6) or 6)
    key = f"otp:quote:{quote.tenant_id}:{quote.id}:{now.strftime('%Y%m%d%H')}"
    if rate_limit.hit(key, limit=per_hour, window_seconds=3600):
        raise HTTPException(
            429, detail={"code": "otp_rate_limited", "message": "Trop de demandes de code. Réessayez plus tard."}
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


@router.post("/{token}/quotes/{quote_id}/accept", response_model=PublicCustomerQuoteDetailOut)
def accept_customer_portal_quote(
    token: str, quote_id: str, payload: PublicQuoteAcceptRequest, request: Request, db: Session = Depends(get_db)
):
    cust, quote, tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    locked_quote = _quote_for_update(db, quote.id)
    if not locked_quote or locked_quote.tenant_id != cust.tenant_id or locked_quote.customer_id != cust.id:
        raise HTTPException(404, "Not found")
    quote = locked_quote
    _bump_portal_view(db, cust, source="quote_accept", commit=False)

    if quote.status in {"draft", "rejected", "invoiced", "expired"}:
        raise HTTPException(400, detail={"code": "quote_not_acceptable", "message": "Devis non acceptable."})
    if quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(400, detail={"code": "quote_expired", "message": "Devis expiré."})
    if quote.status == "accepted":
        return _public_customer_quote_detail_out(db, token, cust, quote, tenant)

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

    if terms_required or bool(payload.terms_accepted):
        quote.accepted_terms_url = terms_url
        quote.accepted_terms_at = now

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
    return _public_customer_quote_detail_out(db, token, cust, quote, tenant)


@router.post("/{token}/quotes/{quote_id}/reject", response_model=PublicCustomerQuoteDetailOut)
def reject_customer_portal_quote(
    token: str, quote_id: str, payload: PublicQuoteRejectRequest, request: Request, db: Session = Depends(get_db)
):
    cust, quote, tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    locked_quote = _quote_for_update(db, quote.id)
    if not locked_quote or locked_quote.tenant_id != cust.tenant_id or locked_quote.customer_id != cust.id:
        raise HTTPException(404, "Not found")
    quote = locked_quote
    _bump_portal_view(db, cust, source="quote_reject", commit=False)

    if quote.status == "draft":
        raise HTTPException(400, detail={"code": "quote_not_rejectable", "message": "Devis non refusé."})
    if quote.status in {"accepted", "invoiced", "expired"}:
        raise HTTPException(
            400, detail={"code": "quote_not_rejectable", "message": "Devis non refusé (déjà accepté ou facturé)."}
        )
    if quote.status == "rejected":
        return _public_customer_quote_detail_out(db, token, cust, quote, tenant)

    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, detail={"code": "name_required", "message": "Nom requis pour refuser."})
    reason = (payload.reason or "").strip()

    was_draft = quote.status == "draft"
    quote.status = "rejected"
    quote.rejected_at = quote.rejected_at or _utcnow()
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
    return _public_customer_quote_detail_out(db, token, cust, quote, tenant)


@router.post("/{token}/quotes/{quote_id}/convert")
def convert_customer_portal_quote(token: str, quote_id: str, request: Request, db: Session = Depends(get_db)):
    """Convert an accepted quote into an invoice, from the unified customer portal.

    Behavior depends on tenant_settings.features.portal.quote_convert_mode:
    - create_draft: create invoice draft (requires internal validation)
    - disabled: conversion not available (404)
    """
    cust, quote, tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    locked_quote = _quote_for_update(db, quote.id)
    if not locked_quote or locked_quote.tenant_id != quote.tenant_id or locked_quote.customer_id != cust.id:
        raise HTTPException(404, "Not found")
    quote = locked_quote
    _bump_portal_view(db, cust, source="quote_convert", commit=False)

    portal = get_portal_settings(tenant)
    convert_mode = str(portal.get("quote_convert_mode") or "disabled").strip().lower()

    if convert_mode == "disabled":
        raise HTTPException(404, "Not found")

    if getattr(quote, "invoice_id", None):
        inv = db.get(Invoice, quote.invoice_id)
        pending = bool(inv and inv.status == "draft")
        return {
            "ok": True,
            "invoice_id": quote.invoice_id,
            "quote_id": quote.id,
            "already_converted": True,
            "invoice_status": getattr(inv, "status", None),
            "pending": pending,
            "mode": convert_mode,
        }

    existing_invoice = (
        db.query(Invoice)
        .filter(
            Invoice.tenant_id == quote.tenant_id,
            Invoice.customer_id == quote.customer_id,
            Invoice.quote_id == quote.id,
            Invoice.type == "invoice",
            Invoice.status != "canceled",
            or_(Invoice.invoice_kind.is_(None), Invoice.invoice_kind != "deposit"),
        )
        .order_by(Invoice.created_at.asc())
        .first()
    )
    if existing_invoice:
        quote.invoice_id = existing_invoice.id
        if quote.status != "invoiced" and getattr(existing_invoice, "invoice_kind", None) != "deposit":
            quote.status = "invoiced"
        quote.updated_by = None
        db.add(quote)
        db.commit()
        return {
            "ok": True,
            "invoice_id": existing_invoice.id,
            "quote_id": quote.id,
            "already_converted": True,
            "invoice_status": getattr(existing_invoice, "status", None),
            "pending": bool(existing_invoice.status == "draft"),
            "mode": convert_mode,
        }

    if quote.status == "rejected":
        raise HTTPException(
            400, detail={"code": "quote_rejected", "message": "Devis refusé : impossible de convertir."}
        )
    if quote.status != "accepted":
        raise HTTPException(
            400, detail={"code": "quote_not_accepted", "message": "Le devis doit être accepté avant conversion."}
        )
    if quote.valid_until and date.today() > quote.valid_until:
        raise HTTPException(400, detail={"code": "quote_expired", "message": "Devis expiré : impossible de convertir."})

    ensure_active_subscription(tenant, db)
    ensure_tenant_legal_acceptance(tenant.id, db)
    ensure_quote_sealed(db, quote)

    lines = db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).order_by(QuoteLine.id.asc()).all()
    if not lines:
        raise HTTPException(400, detail={"code": "quote_no_lines", "message": "Devis vide : aucune ligne à convertir."})

    invoice_lines = [
        InvoiceLineIn(
            line_type=getattr(line, "line_type", None) or "item",
            display_number=getattr(line, "display_number", None),
            reference=getattr(line, "reference", None),
            product_name=line.product_name,
            detail=getattr(line, "detail", None),
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

    note = (quote.note or "").strip()

    has_deposit_invoices = (
        db.query(Invoice.id)
        .filter(
            Invoice.tenant_id == quote.tenant_id,
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
        quote_id=quote.id,
        template_key=getattr(quote, "template_key", None),
        template_options=template_options,
        operation_nature=str(template_options.get("operation_nature") or "services").strip().lower(),
        payment_terms=quote.payment_terms,
        purchase_order_number=quote.purchase_order_number,
        service_date=quote.service_date,
        invoice_kind="final" if has_deposit_invoices else "standard",
        delivery_address=delivery_address,
        delivery_address_differs=delivery_address_differs,
        lines=invoice_lines,
    )

    from ..routers import invoices as invoices_router

    resp = Response()
    inv = invoices_router._create_invoice_record(
        inv_payload,
        resp,
        db,
        tenant_id=quote.tenant_id,
        actor=None,
        commit=False,
    )
    invoice_id = inv.id

    issue_result = None
    pending = True
    quote.invoice_id = invoice_id
    quote.status = "invoiced"
    quote.updated_by = None
    db.add(quote)

    try:
        log_action(
            db,
            tenant_id=quote.tenant_id,
            actor_user_id=None,
            action_type="invoice_request",
            object_type="quote",
            object_id=quote.id,
            metadata={"invoice_id": invoice_id, "mode": convert_mode},
        )
    except Exception:
        pass

    db.add(quote)
    db.commit()
    db.refresh(quote)

    return {
        "ok": True,
        "quote_id": quote.id,
        "invoice_id": invoice_id,
        "invoice_status": getattr(inv, "status", None),
        "mode": convert_mode,
        "pending": pending,
        "invoice_issue": issue_result,
    }


@router.get("/{token}/invoices/{invoice_id}/pdf")
def get_customer_portal_invoice_pdf(token: str, invoice_id: str, request: Request, db: Session = Depends(get_db)):
    cust, inv, _tenant = _get_invoice_for_customer_portal(db, token, invoice_id, request)
    _bump_portal_view(db, cust, source="invoice_pdf")

    from .invoices import (
        _artifact_storage_key_for_kind,
        _ctx,
        _ensure_invoice_artifact_integrity,
        _is_invoice_immutable,
        _safe_filename,
        _stream_invoice_artifact,
        ensure_invoice_artifact,
    )

    filename = _safe_filename("facture", inv.number, "pdf")
    if _is_invoice_immutable(inv):
        artifact = ensure_invoice_artifact(db, inv, "pdf")
        _ensure_invoice_artifact_integrity(db, inv, artifact, "pdf")
        storage_key = _artifact_storage_key_for_kind(inv, "PDF", artifact)
        if not storage_key:
            raise HTTPException(404, "Not found")
        db.commit()
        return _stream_invoice_artifact(
            request,
            storage_key,
            artifact.content_type,
            filename,
            disposition="inline",
        )

    content = invoice_pdf(_ctx(db, inv))
    return Response(
        content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=0, no-store",
        },
    )


@router.get("/{token}/invoices/{invoice_id}/preview.html")
def get_customer_portal_invoice_preview_html(
    token: str, invoice_id: str, request: Request, db: Session = Depends(get_db)
):
    cust, inv, tenant = _get_invoice_for_customer_portal(db, token, invoice_id, request)
    _bump_portal_view(db, cust, source="invoice_preview")
    from .invoices import _ctx

    ctx = _ctx(db, inv, allow_missing_identifiers=True)
    if not _payment_tracking_enabled(tenant):
        invoice_ctx = ctx.get("invoice") if isinstance(ctx, dict) else None
        if isinstance(invoice_ctx, dict):
            ctx["invoice"] = {
                **invoice_ctx,
                "status": _invoice_status_for_customer_portal(
                    inv,
                    payment_tracking_enabled=False,
                ),
                "balance_due": None,
            }
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


@router.get("/{token}/invoices/{invoice_id}/bundle.zip")
def get_customer_portal_invoice_bundle_zip(
    token: str, invoice_id: str, request: Request, db: Session = Depends(get_db)
):
    """Export ZIP (portail client) : PDF + Factur-X (si dispo) + pièces jointes visibles client."""
    cust, inv, _tenant = _get_invoice_for_customer_portal(db, token, invoice_id, request)
    _bump_portal_view(db, cust, source="invoice_bundle")
    from ..services.bundles import build_invoice_bundle_zip, stream_zip_file

    path, filename = build_invoice_bundle_zip(
        db,
        invoice_id=inv.id,
        tenant_id=inv.tenant_id,
        include_private_attachments=False,
    )
    return stream_zip_file(path, filename)


@router.get("/{token}/invoices/{invoice_id}/facturx")
def get_customer_portal_invoice_facturx(token: str, invoice_id: str, request: Request, db: Session = Depends(get_db)):
    cust, inv, tenant = _get_invoice_for_customer_portal(db, token, invoice_id, request)
    _bump_portal_view(db, cust, source="invoice_facturx")
    if not _is_tenant_pro(tenant) or not has_stored_facturx_artifact(db, inv):
        raise HTTPException(403, "Factur-X réservé au plan Pro")
    from ..services.invoices import export as invoice_export_service

    fake_user = type("_U", (), {"tenant_id": inv.tenant_id})()
    return invoice_export_service.export_facturx(inv.id, request, db, fake_user)


@router.get("/{token}/invoices/{invoice_id}/facturx.pdf")
def get_customer_portal_invoice_facturx_pdf(
    token: str, invoice_id: str, request: Request, db: Session = Depends(get_db)
):
    return get_customer_portal_invoice_facturx(token, invoice_id, request, db)


@router.get("/{token}/quotes/{quote_id}/pdf")
def get_customer_portal_quote_pdf(token: str, quote_id: str, request: Request, db: Session = Depends(get_db)):
    cust, quote, _tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    _bump_portal_view(db, cust, source="quote_pdf")
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


@router.get("/{token}/quotes/{quote_id}/preview.html")
def get_customer_portal_quote_preview_html(token: str, quote_id: str, request: Request, db: Session = Depends(get_db)):
    cust, quote, _tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    _bump_portal_view(db, cust, source="quote_preview")
    from .quotes import _quote_ctx

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


@router.get("/{token}/quotes/{quote_id}/bundle.zip")
def get_customer_portal_quote_bundle_zip(token: str, quote_id: str, request: Request, db: Session = Depends(get_db)):
    """Export ZIP (portail client) : PDF du devis + PJ visibles client + meta.json."""
    cust, quote, _tenant = _get_quote_for_customer_portal(db, token, quote_id, request)
    _bump_portal_view(db, cust, source="quote_bundle")
    from ..services.bundles import build_quote_bundle_zip, stream_zip_file

    path, filename = build_quote_bundle_zip(
        db,
        quote_id=quote.id,
        tenant_id=quote.tenant_id,
        include_private_attachments=False,
        include_proof=False,
    )
    return stream_zip_file(path, filename)


@router.post("/{token}/invoices/{invoice_id}/pay/checkout")
def create_customer_portal_invoice_checkout(
    token: str, invoice_id: str, request: Request, db: Session = Depends(get_db)
):
    """Crée une session Stripe Checkout pour régler une facture depuis le portail client unifié."""
    cust, inv, tenant = _get_invoice_for_customer_portal(db, token, invoice_id, request)

    if not _stripe_invoice_payments_enabled(tenant):
        raise HTTPException(404, "Not found")
    if (inv.type or "invoice") != "invoice":
        raise HTTPException(400, "Paiement carte non disponible pour ce document")
    if inv.status in {"draft", "canceled"}:
        raise HTTPException(400, "Facture non émise")
    if (inv.currency or "EUR").strip().upper() != "EUR":
        raise HTTPException(400, "Paiement carte disponible uniquement en EUR")

    from .invoices import _outstanding

    amount = _outstanding(db, inv)
    if amount <= 0:
        raise HTTPException(400, "Facture déjà soldée")

    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
    if not base:
        raise HTTPException(
            500,
            detail={
                "code": "payment_setup_unavailable",
                "message": "Le paiement par carte est momentanément indisponible.",
            },
        )

    import stripe

    stripe.api_key = settings.STRIPE_SECRET_KEY

    cents = int((amount * Decimal("100")).quantize(Decimal("1")))
    if cents <= 0:
        raise HTTPException(400, "Montant invalide")

    label = f"Facture {inv.number}" if inv.number else "Facture"
    # UX: return to the invoice detail page (not the list), so users see the updated status immediately.
    success_url = f"{base}/c/{token}/invoices/{inv.id}?payment=success&session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{base}/c/{token}/invoices/{inv.id}?payment=cancel"

    payment_version = db.query(Payment).filter(Payment.invoice_id == inv.id).count()
    session = stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card"],
        line_items=[
            {
                "price_data": {
                    "currency": "eur",
                    "product_data": {"name": label},
                    "unit_amount": cents,
                },
                "quantity": 1,
            }
        ],
        success_url=success_url,
        cancel_url=cancel_url,
        customer_email=((cust.email or "").strip() or None),
        metadata={
            "kind": "invoice_payment",
            "tenant_id": inv.tenant_id,
            "invoice_id": inv.id,
            "customer_id": cust.id,
            "customer_portal_token_last4": _token_last4(token),
            "invoice_number": (inv.number or ""),
        },
        client_reference_id=inv.tenant_id,
        idempotency_key=f"customer-portal-invoice-payment:{inv.id}:{cents}:v{payment_version}",
    )
    return {"url": session.url}
