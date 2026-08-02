from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from importlib import import_module
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from rq import get_current_job
from sqlalchemy.exc import IntegrityError

from .. import metrics
from ..config import settings
from ..db import SessionLocal
from ..models import EmailEvent, Tenant
from ..services.action_logs import safe_log_action
from ..services.email import send_email
from ..services.trial_document_email import (
    ensure_document_email_delivery_allowed,
    is_document_email_type,
)
from ..utils.pii import mask_email, hash_email, redact_pii_text
from .queue import enqueue_job, get_email_queue_name, is_sync_mode


logger = logging.getLogger(__name__)

EMAIL_STATUS_QUEUED = "queued"
EMAIL_STATUS_SENT = "sent"
EMAIL_STATUS_FAILED = "failed"
EMAIL_STATUS_LOG_ONLY = "log_only"

EMAIL_DELIVERY_SMTP = "smtp"
EMAIL_DELIVERY_LOG_ONLY = "log_only"

EMAIL_TYPE_VERIFICATION = "verification"
EMAIL_TYPE_PASSWORD_RESET = "password_reset"
EMAIL_TYPE_INVOICE = "invoice"
EMAIL_TYPE_INVOICE_FOLLOWUP = "invoice_followup"
EMAIL_TYPE_QUOTE = "quote"
EMAIL_TYPE_QUOTE_FOLLOWUP = "quote_followup"
EMAIL_TYPE_QUOTE_OTP = "quote_otp"
EMAIL_TYPE_TRIAL_STARTED = "trial_started"
EMAIL_TYPE_TRIAL_ENDING = "trial_ending"
EMAIL_TYPE_TRIAL_EXPIRED = "trial_expired"
EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION = "trial_pre_anonymization"
TRIAL_LIFECYCLE_EMAIL_TYPES = frozenset(
    {
        EMAIL_TYPE_TRIAL_STARTED,
        EMAIL_TYPE_TRIAL_ENDING,
        EMAIL_TYPE_TRIAL_EXPIRED,
        EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION,
    }
)

EMAIL_BRAND_NAME = "PixFacture"
EMAIL_PRODUCT_NAME = "PixFacture"


def verification_email_subject() -> str:
    return f"{EMAIL_BRAND_NAME} · Vérification de votre adresse email"


def password_reset_email_subject() -> str:
    return f"{EMAIL_BRAND_NAME} · Réinitialisation du mot de passe"


def workspace_invitation_subject(company_name: str) -> str:
    return f"{EMAIL_BRAND_NAME} · Invitation à rejoindre l’espace {company_name}"


def workspace_access_setup_subject(company_name: str) -> str:
    return f"{EMAIL_BRAND_NAME} · Activez votre accès à l’espace {company_name}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _retry_intervals() -> list[int]:
    attempts = int(getattr(settings, "EMAIL_JOBS_MAX_ATTEMPTS", 4) or 4)
    attempts = max(1, attempts)
    base = int(getattr(settings, "EMAIL_JOBS_RETRY_BASE_SECONDS", 60) or 60)
    max_seconds = int(getattr(settings, "EMAIL_JOBS_RETRY_MAX_SECONDS", 900) or 900)
    retries = max(0, attempts - 1)
    intervals: list[int] = []
    for i in range(retries):
        delay = min(int(base * (2**i)), max_seconds)
        intervals.append(delay)
    return intervals


def _retry_policy() -> Any | None:
    intervals = _retry_intervals()
    if not intervals:
        return None
    try:
        retry_cls = getattr(import_module("rq"), "Retry")
    except AttributeError:
        retry_cls = getattr(import_module("rq.retry"), "Retry")
    return retry_cls(max=len(intervals), interval=intervals)


def _truncate_error(message: str | None) -> str | None:
    if not message:
        return None
    return redact_pii_text(message)[:500]


def _record_event_status(
    event_id: str, *, status: str, error: str | None = None, sent_at: datetime | None = None
) -> None:
    with SessionLocal() as db:
        event = db.get(EmailEvent, event_id)
        if not event:
            return
        event.status = status
        if status == EMAIL_STATUS_SENT:
            event.sent_at = sent_at or _utcnow()
            event.error = None
        else:
            if error is not None:
                event.error = _truncate_error(error)
            if status == EMAIL_STATUS_FAILED:
                event.sent_at = None
        db.add(event)
        db.commit()


def _log_invoice_action(tenant_id: str, invoice_id: str, user_id: str | None, to: str) -> None:
    with SessionLocal() as db:
        safe_log_action(
            db,
            tenant_id=tenant_id,
            actor_user_id=user_id,
            action_type="send_email",
            object_type="invoice",
            object_id=invoice_id,
            metadata={"to_masked": mask_email(to), "to_hash": hash_email(to)},
            commit=True,
        )


def _log_quote_action(tenant_id: str, quote_id: str, user_id: str | None, to: str) -> None:
    with SessionLocal() as db:
        safe_log_action(
            db,
            tenant_id=tenant_id,
            actor_user_id=user_id,
            action_type="send_email",
            object_type="quote",
            object_id=quote_id,
            metadata={"to_masked": mask_email(to), "to_hash": hash_email(to)},
            commit=True,
        )


def send_email_job(
    event_id: str,
    to: str,
    subject: str,
    text: str = "",
    attachments: list[tuple[str, bytes, str]] | None = None,
    reply_to: str | None = None,
    html: str | None = None,
    template: str | None = None,
    context: dict | None = None,
    tenant_id: str | None = None,
    user_id: str | None = None,
    invoice_id: str | None = None,
    quote_id: str | None = None,
    cc: list[str] | str | None = None,
    bcc: list[str] | str | None = None,
) -> dict:
    intervals = _retry_intervals()
    attempts = max(1, len(intervals) + 1)
    is_sync = is_sync_mode()

    def _attempt_send() -> None:
        provider_headers = {"X-Mailin-custom": f"email_event_id:{event_id}"}
        send_email(
            to,
            subject,
            text=text,
            attachments=attachments,
            reply_to=reply_to,
            cc=cc,
            bcc=bcc,
            html=html,
            template=template,
            context=context,
            headers=provider_headers,
        )

    if is_sync:
        last_exc: Exception | None = None
        for attempt in range(attempts):
            try:
                _attempt_send()
                _record_event_status(event_id, status=EMAIL_STATUS_SENT)
                if tenant_id and invoice_id:
                    _log_invoice_action(tenant_id, invoice_id, user_id, to)
                if tenant_id and quote_id:
                    _log_quote_action(tenant_id, quote_id, user_id, to)
                return {"ok": True}
            except Exception as exc:
                last_exc = exc
                if attempt < attempts - 1:
                    _record_event_status(
                        event_id,
                        status=EMAIL_STATUS_QUEUED,
                        error="L’envoi a échoué ; une nouvelle tentative est programmée.",
                    )
                    time.sleep(intervals[attempt] if attempt < len(intervals) else intervals[-1])
                    continue
                _record_event_status(
                    event_id,
                    status=EMAIL_STATUS_FAILED,
                    error="L’e-mail n’a pas pu être envoyé. Vérifiez l’adresse puis réessayez.",
                )
                metrics.inc_operational_event("email_failure")
                logger.exception("email_failure", extra={"event_id": event_id})
                raise
        if last_exc:
            raise last_exc

    try:
        _attempt_send()
        _record_event_status(event_id, status=EMAIL_STATUS_SENT)
        if tenant_id and invoice_id:
            _log_invoice_action(tenant_id, invoice_id, user_id, to)
        if tenant_id and quote_id:
            _log_quote_action(tenant_id, quote_id, user_id, to)
        return {"ok": True}
    except Exception:
        job = get_current_job()
        retries_left = getattr(job, "retries_left", 0) if job else 0
        status = EMAIL_STATUS_FAILED if int(retries_left or 0) <= 0 else EMAIL_STATUS_QUEUED
        error_message = (
            "L’e-mail n’a pas pu être envoyé. Vérifiez l’adresse puis réessayez."
            if status == EMAIL_STATUS_FAILED
            else "L’envoi a échoué ; une nouvelle tentative est programmée."
        )
        _record_event_status(event_id, status=status, error=error_message)
        if status == EMAIL_STATUS_FAILED:
            metrics.inc_operational_event("email_failure")
            logger.exception("email_failure", extra={"event_id": event_id})
        else:
            logger.exception("email_job_retry_queued", extra={"event_id": event_id})
        raise


def enqueue_email(
    *,
    tenant_id: str | None,
    user_id: str | None,
    invoice_id: str | None,
    quote_id: str | None,
    event_type: str,
    to: str,
    subject: str,
    text: str = "",
    attachments: list[tuple[str, bytes, str]] | None = None,
    reply_to: str | None = None,
    html: str | None = None,
    template: str | None = None,
    context: dict | None = None,
    cc: list[str] | str | None = None,
    bcc: list[str] | str | None = None,
) -> EmailEvent:
    if tenant_id and is_document_email_type(event_type):
        with SessionLocal() as db:
            ensure_document_email_delivery_allowed(db.get(Tenant, tenant_id))

    with SessionLocal() as db:
        event = EmailEvent(
            tenant_id=tenant_id,
            user_id=user_id,
            invoice_id=invoice_id,
            quote_id=quote_id,
            type=event_type,
            to=to,
            status=EMAIL_STATUS_QUEUED,
            delivery_mode=EMAIL_DELIVERY_SMTP,
            created_at=_utcnow(),
        )
        db.add(event)
        db.commit()
        db.refresh(event)
        assert event.id is not None

    meta = {"tenant_id": tenant_id, "email_event_id": event.id, "type": event_type}
    retry_policy = _retry_policy()
    try:
        enqueue_job(
            send_email_job,
            event.id,
            to,
            subject,
            text,
            attachments,
            reply_to,
            html,
            template,
            context,
            tenant_id,
            user_id,
            invoice_id,
            quote_id,
            cc=cc,
            bcc=bcc,
            meta=meta,
            queue_name=get_email_queue_name(),
            retry=retry_policy,
            job_timeout=int(getattr(settings, "EMAIL_JOBS_TIMEOUT_SECONDS", 300) or 300),
            description=f"send_email_job event={event.id} type={event_type}",
        )
    except Exception:
        _record_event_status(
            event.id,
            status=EMAIL_STATUS_FAILED,
            error="L’envoi n’a pas pu être planifié. Réessayez dans quelques instants.",
        )
        raise
    if is_sync_mode():
        with SessionLocal() as db:
            refreshed = db.get(EmailEvent, event.id)
            if refreshed is not None:
                event = refreshed
    return event


def idempotent_email_event_id(idempotency_key: str) -> str:
    key = str(idempotency_key or "").strip()
    if not key:
        raise ValueError("Une clé d'idempotence email est requise.")
    return str(uuid5(NAMESPACE_URL, f"pixfacture:transactional-email:{key}"))


def enqueue_idempotent_email(
    *,
    idempotency_key: str,
    tenant_id: str,
    user_id: str,
    event_type: str,
    to: str,
    subject: str,
    text: str,
    template: str | None = None,
    context: dict | None = None,
) -> tuple[EmailEvent, bool]:
    """Queue one transactional email at most once per logical milestone.

    The deterministic primary key is the database-level idempotency guard. A
    terminally failed event may be claimed again by a later scheduler run; an
    accepted or already queued event is never duplicated.
    """

    event_id = idempotent_email_event_id(idempotency_key)
    should_enqueue = False

    with SessionLocal() as db:
        event = db.get(EmailEvent, event_id)
        if event is None:
            event = EmailEvent(
                id=event_id,
                tenant_id=tenant_id,
                user_id=user_id,
                invoice_id=None,
                quote_id=None,
                type=event_type,
                to=to,
                status=EMAIL_STATUS_QUEUED,
                delivery_mode=EMAIL_DELIVERY_SMTP,
                created_at=_utcnow(),
            )
            db.add(event)
            try:
                db.commit()
            except IntegrityError:
                # A concurrent scheduler won the deterministic primary-key
                # insert. It owns the enqueue operation.
                db.rollback()
                event = db.get(EmailEvent, event_id)
                if event is None:
                    raise
            else:
                should_enqueue = True
        else:
            expected = (tenant_id, user_id, event_type)
            actual = (event.tenant_id, event.user_id, event.type)
            if actual != expected:
                raise RuntimeError("Collision de clé d'idempotence email.")
            # Retry only local/queue failures. A provider-level rejection must
            # not be resent automatically to the same address every day.
            if event.status == EMAIL_STATUS_FAILED and not str(event.provider_status or "").strip():
                claimed = (
                    db.query(EmailEvent)
                    .filter(
                        EmailEvent.id == event_id,
                        EmailEvent.status == EMAIL_STATUS_FAILED,
                    )
                    .update(
                        {
                            EmailEvent.status: EMAIL_STATUS_QUEUED,
                            EmailEvent.error: None,
                            EmailEvent.sent_at: None,
                        },
                        synchronize_session=False,
                    )
                )
                db.commit()
                should_enqueue = bool(claimed)

    if not should_enqueue:
        with SessionLocal() as db:
            existing = db.get(EmailEvent, event_id)
            if existing is None:
                raise RuntimeError("Événement email idempotent introuvable.")
            expected = (tenant_id, user_id, event_type)
            actual = (existing.tenant_id, existing.user_id, existing.type)
            if actual != expected:
                raise RuntimeError("Collision de clé d'idempotence email.")
            return existing, False

    meta = {"tenant_id": tenant_id, "email_event_id": event_id, "type": event_type}
    try:
        enqueue_job(
            send_email_job,
            event_id,
            to,
            subject,
            text,
            None,
            None,
            None,
            template,
            context,
            tenant_id,
            user_id,
            None,
            None,
            meta=meta,
            queue_name=get_email_queue_name(),
            retry=_retry_policy(),
            job_timeout=int(getattr(settings, "EMAIL_JOBS_TIMEOUT_SECONDS", 300) or 300),
            description=f"send_email_job event={event_id} type={event_type}",
        )
    except Exception:
        _record_event_status(
            event_id,
            status=EMAIL_STATUS_FAILED,
            error="L’envoi n’a pas pu être planifié. Réessayez dans quelques instants.",
        )
        raise

    with SessionLocal() as db:
        refreshed = db.get(EmailEvent, event_id)
        if refreshed is None:
            raise RuntimeError("Événement email idempotent introuvable après planification.")
        return refreshed, True


def record_log_only_email(
    *,
    tenant_id: str | None,
    user_id: str | None,
    invoice_id: str | None = None,
    quote_id: str | None = None,
    event_type: str,
    to: str,
) -> EmailEvent:
    with SessionLocal() as db:
        event = EmailEvent(
            tenant_id=tenant_id,
            user_id=user_id,
            invoice_id=invoice_id,
            quote_id=quote_id,
            type=event_type,
            to=to,
            status=EMAIL_STATUS_LOG_ONLY,
            delivery_mode=EMAIL_DELIVERY_LOG_ONLY,
            created_at=_utcnow(),
        )
        db.add(event)
        db.commit()
        db.refresh(event)
        return event


def record_invoice_email_log_only(
    *,
    tenant_id: str,
    invoice_id: str,
    user_id: str | None,
    to: str,
    followup: bool = False,
) -> EmailEvent:
    return record_log_only_email(
        tenant_id=tenant_id,
        user_id=user_id,
        invoice_id=invoice_id,
        event_type=EMAIL_TYPE_INVOICE_FOLLOWUP if followup else EMAIL_TYPE_INVOICE,
        to=to,
    )


def record_quote_email_log_only(
    *,
    tenant_id: str,
    quote_id: str,
    user_id: str | None,
    to: str,
    followup: bool = False,
) -> EmailEvent:
    return record_log_only_email(
        tenant_id=tenant_id,
        user_id=user_id,
        quote_id=quote_id,
        event_type=EMAIL_TYPE_QUOTE_FOLLOWUP if followup else EMAIL_TYPE_QUOTE,
        to=to,
    )


def enqueue_invoice_email(
    *,
    tenant_id: str,
    invoice_id: str,
    user_id: str | None,
    to: str,
    subject: str,
    body: str,
    attachments: list[tuple[str, bytes, str]],
    reply_to: str | None,
    template: str | None = None,
    context: dict | None = None,
    html: str | None = None,
    cc: list[str] | str | None = None,
    bcc: list[str] | str | None = None,
    followup: bool = False,
) -> EmailEvent:
    return enqueue_email(
        tenant_id=tenant_id,
        user_id=user_id,
        invoice_id=invoice_id,
        quote_id=None,
        event_type=EMAIL_TYPE_INVOICE_FOLLOWUP if followup else EMAIL_TYPE_INVOICE,
        to=to,
        subject=subject,
        text=body,
        attachments=attachments,
        reply_to=reply_to,
        template=template,
        context=context,
        html=html,
        cc=cc,
        bcc=bcc,
    )


def enqueue_quote_email(
    *,
    tenant_id: str,
    quote_id: str,
    user_id: str | None,
    to: str,
    subject: str,
    body: str,
    attachments: list[tuple[str, bytes, str]] | None,
    reply_to: str | None,
    template: str | None = None,
    context: dict | None = None,
    html: str | None = None,
    cc: list[str] | str | None = None,
    bcc: list[str] | str | None = None,
) -> EmailEvent:
    return enqueue_email(
        tenant_id=tenant_id,
        user_id=user_id,
        invoice_id=None,
        quote_id=quote_id,
        event_type=EMAIL_TYPE_QUOTE,
        to=to,
        subject=subject,
        text=body,
        attachments=attachments,
        reply_to=reply_to,
        template=template,
        context=context,
        html=html,
        cc=cc,
        bcc=bcc,
    )


def enqueue_quote_followup_email(
    *,
    tenant_id: str,
    quote_id: str,
    user_id: str | None,
    to: str,
    subject: str,
    body: str,
    attachments: list[tuple[str, bytes, str]] | None,
    reply_to: str | None,
    template: str | None = None,
    context: dict | None = None,
    html: str | None = None,
    cc: list[str] | str | None = None,
    bcc: list[str] | str | None = None,
) -> EmailEvent:
    return enqueue_email(
        tenant_id=tenant_id,
        user_id=user_id,
        invoice_id=None,
        quote_id=quote_id,
        event_type=EMAIL_TYPE_QUOTE_FOLLOWUP,
        to=to,
        subject=subject,
        text=body,
        attachments=attachments,
        reply_to=reply_to,
        template=template,
        context=context,
        html=html,
        cc=cc,
        bcc=bcc,
    )


def enqueue_quote_otp_email(
    *,
    tenant_id: str,
    quote_id: str,
    user_id: str | None,
    to: str,
    subject: str,
    body: str,
    reply_to: str | None,
) -> EmailEvent:
    """Envoi OTP pour acceptation devis via portail client."""
    return enqueue_email(
        tenant_id=tenant_id,
        user_id=user_id,
        invoice_id=None,
        quote_id=quote_id,
        event_type=EMAIL_TYPE_QUOTE_OTP,
        to=to,
        subject=subject,
        text=body,
        attachments=None,
        reply_to=reply_to,
    )


def enqueue_verification_email(
    *, tenant_id: str, user_id: str, to: str, verify_url: str, company_name: str
) -> EmailEvent:
    return enqueue_email(
        tenant_id=tenant_id,
        user_id=user_id,
        invoice_id=None,
        quote_id=None,
        event_type=EMAIL_TYPE_VERIFICATION,
        to=to,
        subject=verification_email_subject(),
        text=(
            "Bonjour,\n\n"
            f"Confirmez cette adresse email pour activer votre espace {company_name} sur {EMAIL_PRODUCT_NAME}.\n\n"
            "Cette vérification sécurise votre accès et permet de recevoir les notifications transactionnelles liées à votre compte.\n\n"
            f"Vérifier mon email : {verify_url}\n\n"
            "Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.\n\n"
            f"Vous recevez cet email car une vérification d’adresse a été demandée sur {EMAIL_PRODUCT_NAME}."
        ),
        template="verification.html",
        context={
            "verify_url": verify_url,
            "company_name": company_name,
            "brand_name": EMAIL_BRAND_NAME,
            "product_name": EMAIL_PRODUCT_NAME,
        },
    )


def enqueue_password_reset_email(*, tenant_id: str, user_id: str, to: str, reset_url: str) -> EmailEvent:
    return enqueue_email(
        tenant_id=tenant_id,
        user_id=user_id,
        invoice_id=None,
        quote_id=None,
        event_type=EMAIL_TYPE_PASSWORD_RESET,
        to=to,
        subject=password_reset_email_subject(),
        text=(
            "Bonjour,\n\n"
            f"Nous avons reçu une demande de réinitialisation du mot de passe pour votre accès {EMAIL_PRODUCT_NAME}.\n\n"
            f"Réinitialiser mon mot de passe : {reset_url}\n\n"
            "Ce lien est personnel, à usage unique et expire bientôt.\n\n"
            "Si vous n’êtes pas à l’origine de cette demande, ignorez cet email. "
            "Votre mot de passe actuel ne sera pas modifié.\n\n"
            f"Vous recevez cet email car une action de sécurité a été demandée sur votre compte {EMAIL_PRODUCT_NAME}."
        ),
        template="password_reset.html",
        context={
            "reset_url": reset_url,
            "brand_name": EMAIL_BRAND_NAME,
            "product_name": EMAIL_PRODUCT_NAME,
        },
    )
