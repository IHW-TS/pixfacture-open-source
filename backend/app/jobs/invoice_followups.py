from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import Customer, Invoice, Tenant
from ..jobs.email_jobs import enqueue_invoice_email
from ..services.action_logs import log_action
from ..services.email import smtp_diagnostic_payload
from ..services.email_reply_to import resolve_document_reply_to
from ..services.dunning_settings import get_dunning_settings
from ..services.product_capabilities import is_product_feature_enabled
from ..services.recipients import join_emails, resolve_customer_recipients
from ..services.document_email import build_document_email_context, normalize_document_email_body_text
from ..utils.pii import mask_email


logger = logging.getLogger("jobs.invoice_followups")


def _frontend_base_url() -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip()
    return base.rstrip("/")


def _invoice_public_url(token: str) -> str:
    base = _frontend_base_url()
    path = f"/i/{token}"
    return f"{base}{path}" if base else path


def _fmt_date(d) -> str:
    if not d:
        return ""
    try:
        if isinstance(d, datetime):
            return d.strftime("%d/%m/%Y")
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


def _format_invoice_template(
    template: str,
    *,
    inv: Invoice,
    customer: Customer,
    tenant: Tenant,
    invoice_link: str,
    reply_to: str | None = None,
) -> str:
    if not template:
        return ""
    mapping = {
        "{client}": (customer.name or "").strip(),
        "{company}": (tenant.name or "").strip(),
        "{reply_to}": (reply_to or "").strip(),
        "{number}": (inv.number or "").strip(),
        "{invoice_link}": invoice_link,
        "{issue_date}": _fmt_date(inv.issue_date),
        "{due_date}": _fmt_date(inv.due_date),
        "{total_ttc}": _fmt_amount(inv.total_inc_vat),
        "{total_ht}": _fmt_amount(inv.total_ex_vat),
        "{total_tva}": _fmt_amount(inv.total_vat),
        "{currency}": (inv.currency or "EUR").strip(),
    }
    out = template
    for k, v in mapping.items():
        out = out.replace(k, v)
    return out


def _parse_schedule_days(value: str | None) -> list[int]:
    """Parse une liste d'offsets en jours relatifs à l'échéance.

    Ex: "-2,3,10" => [-2, 3, 10]
    """
    raw = (value or "").strip()
    if not raw:
        return []
    out: list[int] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        try:
            out.append(int(p))
        except Exception:
            continue
    # dédoublonne en conservant l'ordre
    seen: set[int] = set()
    unique: list[int] = []
    for x in out:
        if x in seen:
            continue
        seen.add(x)
        unique.append(x)
    return unique


def _ensure_public_token(db: Session, inv: Invoice) -> str:
    # Réimplémente la génération de token (évite import circulaire avec router).
    if inv.public_token:
        inv.public_enabled = True
        inv.public_created_at = inv.public_created_at or datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(inv)
        return inv.public_token
    import secrets

    for _ in range(8):
        candidate = secrets.token_urlsafe(32)
        exists = db.query(Invoice.id).filter(Invoice.public_token == candidate).first()
        if not exists:
            inv.public_token = candidate
            break
    if not inv.public_token:
        raise RuntimeError("Impossible de générer un token public")
    inv.public_enabled = True
    inv.public_created_at = inv.public_created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(inv)
    return inv.public_token


def _credit_notes_total(db: Session, inv: Invoice) -> Decimal:
    notes = (
        db.query(Invoice)
        .filter(Invoice.related_invoice_id == inv.id)
        .filter(Invoice.tenant_id == inv.tenant_id)
        .filter(Invoice.type == "credit_note")
        .filter(Invoice.status.notin_(["draft", "canceled"]))
        .all()
    )
    return sum((abs(Decimal(str(n.total_inc_vat or 0))) for n in notes), Decimal("0"))


def _payments_total(inv: Invoice) -> Decimal:
    # Relationship peut être lazy-loaded ; OK vu le volume limité.
    return sum((Decimal(str(p.amount or 0)) for p in (inv.payments or [])), Decimal("0"))


def _outstanding(db: Session, inv: Invoice) -> Decimal:
    total = Decimal(str(inv.total_inc_vat or 0))
    credits = _credit_notes_total(db, inv)
    paid = _payments_total(inv)
    return total - credits - paid


def run_invoice_followups_once(limit: int = 200) -> dict:
    """Envoie des relances automatiques pour factures quand le mode auto est explicitement activé.

    Règles (configurables) :
    - relance #1 : INVOICE_FOLLOWUP_BEFORE_DUE_DAYS jours avant échéance (reminder_count==0)
    - relance #2 : INVOICE_FOLLOWUP_AFTER_DUE_DAYS jours après échéance (reminder_count==1)
    - relance #3 : INVOICE_FOLLOWUP_SECOND_AFTER_DUE_DAYS jours après échéance (reminder_count==2)
    - max INVOICE_FOLLOWUP_MAX_REMINDERS
    """

    if not bool(getattr(settings, "INVOICE_FOLLOWUP_AUTOMATIC_ENABLED", False)):
        logger.info("invoice_followups: automatic_disabled")
        return {"ok": True, "automatic_enabled": False, "reminders_sent": 0}

    diag = smtp_diagnostic_payload()
    if not diag.get("smtp_configured"):
        logger.warning("invoice_followups: smtp_not_configured")
        return {"ok": True, "smtp_configured": False, "reminders_sent": 0}

    # Cap global (optionnel). Les détails (enabled/schedule/min_interval/attach_pdf) viennent du TenantSettings.
    max_reminders_global = int(getattr(settings, "INVOICE_FOLLOWUP_MAX_REMINDERS", 0) or 0)

    now = datetime.now(timezone.utc).replace(tzinfo=None)

    reminders_sent = 0
    marked_overdue = 0
    skipped_no_email = 0
    skipped_no_customer = 0
    skipped_no_tenant = 0

    with SessionLocal() as db:
        # Pré-sélection : factures ouvertes (pas payées/annulées), avec due_date.
        rows = (
            db.query(Invoice, Tenant, Customer)
            .join(Tenant, Tenant.id == Invoice.tenant_id)
            .join(Customer, Customer.id == Invoice.customer_id)
            .filter(Invoice.type == "invoice")
            .filter(Invoice.status.in_(["issued", "sent", "overdue", "partial"]))
            .filter(Invoice.due_date.isnot(None))
            .order_by(Invoice.due_date.asc())
            .limit(limit)
            .all()
        )

        for inv, tenant, customer in rows:
            try:
                if not tenant:
                    skipped_no_tenant += 1
                    continue
                if not customer:
                    skipped_no_customer += 1
                    continue
                if not is_product_feature_enabled(tenant, "payments_enabled"):
                    # Historical dunning settings may remain stored after a
                    # downgrade or subscription suspension. They must never
                    # reactivate SMTP sends or payment-status mutations.
                    continue
                dunning = get_dunning_settings(tenant)
                if not bool(dunning.get("enabled")):
                    continue

                recipients = resolve_customer_recipients(db, customer=customer, kind="followup", explicit_to=None)
                if not recipients:
                    skipped_no_email += 1
                    continue

                schedule = list(dunning.get("schedule_days") or [])
                if not schedule:
                    schedule = [-2, 3, 10]
                max_reminders = max_reminders_global or len(schedule)
                min_interval_hours = int(dunning.get("min_interval_hours") or 24)
                attach_pdf = bool(dunning.get("attach_pdf"))

                # Skip si déjà soldée
                if _outstanding(db, inv) <= 0:
                    continue

                # Marquer overdue si échéance passée
                if inv.status in {"issued", "sent", "partial"} and inv.due_date and inv.due_date < now:
                    inv.status = "overdue"
                    inv.updated_by = None
                    db.add(inv)
                    marked_overdue += 1

                # Déterminer si on doit relancer (smart schedule)
                due = inv.due_date
                if not due:
                    continue
                rc = int(getattr(inv, "reminder_count", 0) or 0)
                # Anti-spam : intervalle minimum entre relances
                last_sent = getattr(inv, "last_reminder_at", None)
                if last_sent:
                    try:
                        if (now - last_sent).total_seconds() < (min_interval_hours * 3600):
                            continue
                    except Exception:
                        pass

                # On cherche la prochaine relance éligible (rattrapage si on a raté la pré-échéance)
                schedule_eff = schedule[:max_reminders]
                next_index = None
                for i in range(rc, len(schedule_eff)):
                    offset = int(schedule_eff[i])
                    trigger = due + timedelta(days=offset)
                    if offset < 0:
                        # Relance avant échéance : seulement entre trigger et due
                        if now < trigger:
                            continue
                        if now > due:
                            # ratée (échéance passée)
                            continue
                        next_index = i
                        break
                    else:
                        if now >= trigger:
                            next_index = i
                            break
                if next_index is None:
                    continue

                token = _ensure_public_token(db, inv)
                link = _invoice_public_url(token)

                # Choix du template en fonction de l'offset.
                offset = int(schedule_eff[next_index])
                steps = dunning.get("steps")
                steps = steps if isinstance(steps, dict) else {}
                step = steps.get(str(offset))
                step = step if isinstance(step, dict) else {}

                subject_template = (
                    step.get("subject") or "Rappel - facture {number}"
                ).strip() or "Rappel - facture {number}"
                body_template = (
                    (step.get("body") or "").strip()
                    or tenant.reminder_body_default
                    or "Bonjour {client},\n\nSauf erreur de notre part, la facture {number}, échue le {due_date}, reste à régler.\n\nSi le paiement a déjà été effectué, merci de transmettre la référence du règlement à votre contact habituel. À défaut, merci d'indiquer la date de paiement prévue."
                )

                reply_to = resolve_document_reply_to(db, tenant)
                subject = _format_invoice_template(
                    subject_template,
                    inv=inv,
                    customer=customer,
                    tenant=tenant,
                    invoice_link=link,
                    reply_to=reply_to,
                )
                text = _format_invoice_template(
                    body_template,
                    inv=inv,
                    customer=customer,
                    tenant=tenant,
                    invoice_link=link,
                    reply_to=reply_to,
                )
                text = normalize_document_email_body_text(tenant=tenant, body_text=text, contact_email=reply_to)

                attachments: list[tuple[str, bytes, str]] = []
                if attach_pdf:
                    try:
                        # Génère un PDF simple sans stockage (best-effort)
                        from ..services.pdf import invoice_pdf
                        from ..routers.invoices import _ctx, _safe_filename

                        pdf_bytes = invoice_pdf(_ctx(db, inv))
                        filename = _safe_filename("facture", inv.number, "pdf")
                        attachments.append((filename, pdf_bytes, "application/pdf"))
                    except Exception:
                        logger.exception("invoice_followup_auto_pdf_failed", extra={"invoice_id": inv.id})

                meta_rows = [
                    ("Numéro", (inv.number or "").strip()),
                    ("Échéance", _fmt_date(inv.due_date)),
                    ("Total TTC", f"{_fmt_amount(inv.total_inc_vat)} {inv.currency}".strip()),
                ]
                email_ctx = build_document_email_context(
                    tenant=tenant,
                    customer=customer,
                    title=subject or "Relance facture",
                    body_text=text,
                    button_url=link or None,
                    button_label="Ouvrir la facture",
                    meta=meta_rows,
                    recipient_email=join_emails(recipients),
                    contact_email=reply_to,
                )

                events = []
                for dest in recipients:
                    ev = enqueue_invoice_email(
                        tenant_id=tenant.id,
                        invoice_id=inv.id,
                        user_id=None,
                        to=dest,
                        subject=subject or "Relance facture",
                        body=text,
                        attachments=attachments,
                        reply_to=reply_to,
                        template="document.html",
                        context=email_ctx,
                        followup=True,
                    )
                    events.append(ev)

                inv.reminder_count = int(next_index) + 1
                inv.last_reminder_at = datetime.now(timezone.utc).replace(tzinfo=None)
                inv.updated_by = None
                db.add(inv)
                try:
                    log_action(
                        db,
                        tenant_id=tenant.id,
                        actor_user_id=None,
                        action_type="followup_email_auto",
                        object_type="invoice",
                        object_id=inv.id,
                        metadata={
                            "event_id": events[0].id if events else None,
                            "event_ids": [e.id for e in events],
                            "to_count": len(recipients),
                            "to_masked": [mask_email(r) for r in recipients],
                            "schedule_offset": offset,
                        },
                    )
                except Exception:
                    pass
                db.commit()
                reminders_sent += 1
            except Exception:
                db.rollback()
                logger.exception("invoice_followup_failed", extra={"invoice_id": getattr(inv, "id", None)})
                continue

    return {
        "ok": True,
        "smtp_configured": True,
        "marked_overdue": marked_overdue,
        "reminders_sent": reminders_sent,
        "skipped_no_email": skipped_no_email,
        "skipped_no_tenant": skipped_no_tenant,
        "skipped_no_customer": skipped_no_customer,
    }
