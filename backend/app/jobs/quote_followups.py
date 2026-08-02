from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import Customer, Quote, Tenant
from ..jobs.email_jobs import enqueue_quote_followup_email
from ..services.email import smtp_diagnostic_payload
from ..services.email_reply_to import resolve_document_reply_to
from ..services.action_logs import log_action
from ..services.document_email import build_document_email_context, normalize_document_email_body_text
from ..services.public_links import is_quote_public_link_expired
from ..services.quote_proof import ensure_quote_sealed


logger = logging.getLogger("jobs.quote_followups")


_QUOTE_ACCEPTANCE_INSTRUCTION = (
    "Pour accepter ou signer ce devis, cliquez sur le bouton « Voir le devis », "
    "puis validez-le depuis le portail sécurisé. Tant que cette validation n'est pas faite, "
    "le devis reste en attente."
)


def _ensure_quote_acceptance_instruction(text: str) -> str:
    value = (text or "").strip()
    normalized = value.lower()
    has_button_instruction = "voir le devis" in normalized and (
        "accepter" in normalized or "signer" in normalized or "validez" in normalized
    )
    if has_button_instruction:
        return value
    return f"{value}\n\n{_QUOTE_ACCEPTANCE_INSTRUCTION}".strip()


def _frontend_base_url() -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    return base.rstrip("/")


def _quote_public_url(token: str) -> str:
    base = _frontend_base_url()
    path = f"/q/{token}"
    return f"{base}{path}" if base else path


def _fmt_date(d) -> str:
    if not d:
        return ""
    try:
        if isinstance(d, datetime):
            d = d.date()
        return d.strftime("%d/%m/%Y")
    except Exception:
        return str(d)


def _fmt_amount(v) -> str:
    if v is None:
        return ""
    try:
        return f"{Decimal(str(v)):.2f}"
    except Exception:
        try:
            return f"{float(v):.2f}"
        except Exception:
            return str(v)


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


def _ensure_public_token(db: Session, quote: Quote) -> str:
    # Réutilise la génération/commit côté router (simple re-impl) pour éviter un import circulaire.
    if quote.public_token and quote.public_enabled and not is_quote_public_link_expired(quote):
        return quote.public_token
    import secrets

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for _ in range(8):
        candidate = secrets.token_urlsafe(32)
        exists = db.query(Quote.id).filter(Quote.public_token == candidate).first()
        if not exists:
            quote.public_token = candidate
            break
    if not quote.public_token:
        raise RuntimeError("Impossible de générer un token public")
    quote.public_enabled = True
    quote.public_created_at = now
    db.add(quote)
    return quote.public_token


def run_quote_followups_once(limit: int = 200) -> dict:
    """Envoie des relances automatiques pour devis.

    Règles (par défaut) :
    - relance #1 : J+QUOTE_FOLLOWUP_AFTER_DAYS après sent_at
    - relance #2 : J-QUOTE_FOLLOWUP_BEFORE_EXPIRY_DAYS avant valid_until
    - max QUOTE_FOLLOWUP_MAX_REMINDERS
    """

    diag = smtp_diagnostic_payload()
    if not diag.get("smtp_configured"):
        # Ne pas planter : en prod on veut un observability signal + pas de spam.
        logger.warning("quote_followups: smtp_not_configured")
        return {"ok": True, "smtp_configured": False, "expired_marked": 0, "reminders_sent": 0}

    after_days = int(getattr(settings, "QUOTE_FOLLOWUP_AFTER_DAYS", 3) or 3)
    before_days = int(getattr(settings, "QUOTE_FOLLOWUP_BEFORE_EXPIRY_DAYS", 2) or 2)
    max_reminders = int(getattr(settings, "QUOTE_FOLLOWUP_MAX_REMINDERS", 2) or 2)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today = date.today()
    sent_before = now - timedelta(days=after_days)
    valid_until_max = today + timedelta(days=before_days)

    expired_marked = 0
    reminders_sent = 0
    skipped_no_email = 0
    skipped_no_tenant = 0
    skipped_no_customer = 0

    with SessionLocal() as db:
        # 1) Marquer expirés (draft/sent) lorsque valid_until dépassé
        try:
            expired = (
                db.query(Quote)
                .filter(Quote.status.in_(["draft", "sent"]))
                .filter(Quote.valid_until.isnot(None))
                .filter(Quote.valid_until < today)
                .all()
            )
            for q in expired:
                q.status = "expired"
                q.updated_by = None
                db.add(q)
            if expired:
                expired_marked = len(expired)
                db.commit()
        except Exception:
            db.rollback()

        if max_reminders <= 0:
            return {
                "ok": True,
                "smtp_configured": True,
                "expired_marked": expired_marked,
                "reminders_sent": 0,
            }

        # 2) Relance #1 (reminder_count==0, sent_at <= threshold)
        q1_rows = (
            db.query(Quote, Tenant, Customer)
            .join(Tenant, Tenant.id == Quote.tenant_id)
            .join(Customer, Customer.id == Quote.customer_id)
            .filter(Quote.status == "sent")
            .filter(Quote.reminder_count == 0)
            .filter(Quote.sent_at.isnot(None))
            .filter(Quote.sent_at <= sent_before)
            .filter(Customer.email.isnot(None))
            .filter(Customer.email != "")
            .limit(limit)
            .all()
        )

        # 3) Relance #2 (reminder_count==1, valid_until dans [today, today+before_days])
        q2_rows = []
        if max_reminders >= 2:
            q2_rows = (
                db.query(Quote, Tenant, Customer)
                .join(Tenant, Tenant.id == Quote.tenant_id)
                .join(Customer, Customer.id == Quote.customer_id)
                .filter(Quote.status == "sent")
                .filter(Quote.reminder_count == 1)
                .filter(Quote.valid_until.isnot(None))
                .filter(Quote.valid_until >= today)
                .filter(Quote.valid_until <= valid_until_max)
                .filter(Customer.email.isnot(None))
                .filter(Customer.email != "")
                .limit(max(0, limit - len(q1_rows)))
                .all()
            )

        rows = q1_rows + q2_rows
        for quote, tenant, customer in rows:
            try:
                if not tenant:
                    skipped_no_tenant += 1
                    continue
                if not customer:
                    skipped_no_customer += 1
                    continue
                to_email = (customer.email or "").strip()
                if not to_email:
                    skipped_no_email += 1
                    continue

                token = _ensure_public_token(db, quote)
                # Sceller le devis si ce n'est pas déjà fait (preuve)
                ensure_quote_sealed(db, quote)
                link = _quote_public_url(token)

                subject_template = tenant.quote_followup_subject_default or "Relance - devis {number}"
                body_template = (
                    tenant.quote_followup_body_default
                    or "Bonjour {client},\n\nNous revenons vers vous au sujet du devis {number}, toujours en attente de votre retour.\n\nIl reste consultable depuis le portail sécurisé. Nous restons disponibles si vous souhaitez une précision ou un ajustement."
                )
                reply_to = resolve_document_reply_to(db, tenant)
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
                text = _ensure_quote_acceptance_instruction(text)
                text = normalize_document_email_body_text(tenant=tenant, body_text=text, contact_email=reply_to)
                meta_rows = [
                    ("Numéro", (quote.number or "").strip()),
                    ("Valable jusqu'au", _fmt_date(quote.valid_until)),
                    ("Total TTC", f"{_fmt_amount(quote.total_inc_vat)} {quote.currency}".strip()),
                ]
                email_ctx = build_document_email_context(
                    tenant=tenant,
                    customer=customer,
                    title=subject or "Relance devis",
                    body_text=text,
                    button_url=link or None,
                    button_label="Voir le devis",
                    meta=meta_rows,
                    recipient_email=to_email,
                    contact_email=reply_to,
                )

                event = enqueue_quote_followup_email(
                    tenant_id=tenant.id,
                    quote_id=quote.id,
                    user_id=None,
                    to=to_email,
                    subject=subject or "Relance devis",
                    body=text,
                    attachments=None,
                    reply_to=reply_to,
                    template="document.html",
                    context=email_ctx,
                )

                quote.reminder_count = int(getattr(quote, "reminder_count", 0) or 0) + 1
                quote.last_reminder_at = datetime.now(timezone.utc).replace(tzinfo=None)
                quote.updated_by = None
                db.add(quote)
                try:
                    log_action(
                        db,
                        tenant_id=tenant.id,
                        actor_user_id=None,
                        action_type="followup_email_auto",
                        object_type="quote",
                        object_id=quote.id,
                        metadata={"event_id": event.id, "to": to_email},
                    )
                except Exception:
                    pass
                db.commit()
                reminders_sent += 1
            except Exception:
                db.rollback()
                logger.exception("quote_followup_failed", extra={"quote_id": getattr(quote, "id", None)})
                continue

    return {
        "ok": True,
        "smtp_configured": True,
        "expired_marked": expired_marked,
        "reminders_sent": reminders_sent,
        "skipped_no_email": skipped_no_email,
        "skipped_no_tenant": skipped_no_tenant,
        "skipped_no_customer": skipped_no_customer,
    }
