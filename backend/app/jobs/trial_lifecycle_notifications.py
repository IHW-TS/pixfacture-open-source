from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterator

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Query, Session

from ..config import settings
from ..db import SessionLocal
from ..models import EmailEvent, Tenant, User
from ..services.demo_seed import verify_self_service_demo_seed_proof
from ..services.email import smtp_diagnostic_payload
from .email_jobs import (
    EMAIL_BRAND_NAME,
    EMAIL_PRODUCT_NAME,
    EMAIL_STATUS_FAILED,
    EMAIL_TYPE_TRIAL_ENDING,
    EMAIL_TYPE_TRIAL_EXPIRED,
    EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION,
    EMAIL_TYPE_TRIAL_STARTED,
    enqueue_idempotent_email,
    idempotent_email_event_id,
)
from .retention import _setting_days, _trial_cleanup_blockers


logger = logging.getLogger(__name__)

_TRIAL_ENDING_NOTICE_WINDOW = timedelta(days=2)
_TRIAL_EXPIRED_NOTICE_WINDOW = timedelta(days=3)


@dataclass(frozen=True)
class _Milestone:
    event_type: str
    effective_anonymization_at: datetime | None = None


@dataclass(frozen=True)
class _EmailCopy:
    subject: str
    heading: str
    paragraphs: tuple[str, ...]
    action_label: str
    action_path: str


def _utc_naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _format_utc(value: datetime) -> str:
    return value.strftime("%d/%m/%Y à %H:%M UTC")


def _public_base_url() -> str:
    return str(settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip().rstrip("/")


def _delivery_unavailable_reason() -> str | None:
    environment = str(settings.APP_ENV or "").strip().lower()
    if environment in {"test", "testing"}:
        return "test_environment"
    if not _public_base_url():
        return "public_base_url_missing"
    if not smtp_diagnostic_payload().get("smtp_configured"):
        return "smtp_not_configured"
    return None


def _principal_user(db: Session, tenant_id: str) -> User | None:
    users = (
        db.query(User)
        .filter(
            User.tenant_id == tenant_id,
            func.lower(func.trim(func.coalesce(User.status, "active"))) == "active",
            User.is_platform_admin.is_(False),
            User.is_support.is_(False),
        )
        .all()
    )
    if not users:
        return None
    priority = {"owner": 0, "admin": 1, "accountant": 2, "viewer": 3}
    return min(
        users,
        key=lambda user: (
            priority.get(str(user.role or "").strip().lower(), 9),
            _utc_naive(user.created_at) or datetime.max,
            str(user.id),
        ),
    )


def _milestones(
    tenant: Tenant,
    *,
    now: datetime,
    inactive_days: int,
    notice_days: int,
) -> list[_Milestone]:
    trial_end = _utc_naive(tenant.trial_end)
    if trial_end is None:
        return []
    status = str(tenant.subscription_status or "").strip().lower()
    milestones: list[_Milestone] = []

    if status == "trialing" and trial_end > now + _TRIAL_ENDING_NOTICE_WINDOW:
        milestones.append(_Milestone(EMAIL_TYPE_TRIAL_STARTED))

    if status == "trialing" and now < trial_end <= now + _TRIAL_ENDING_NOTICE_WINDOW:
        milestones.append(_Milestone(EMAIL_TYPE_TRIAL_ENDING))

    if status in {"trialing", "inactive"} and trial_end <= now < trial_end + _TRIAL_EXPIRED_NOTICE_WINDOW:
        milestones.append(_Milestone(EMAIL_TYPE_TRIAL_EXPIRED))

    if status == "inactive":
        planned_anonymization_at = trial_end + timedelta(days=inactive_days)
        if now >= planned_anonymization_at - timedelta(days=notice_days):
            effective_at = max(planned_anonymization_at, now + timedelta(days=notice_days))
            milestones.append(
                _Milestone(
                    EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION,
                    effective_anonymization_at=effective_at,
                )
            )
    return milestones


def _pre_anonymization_is_eligible(db: Session, tenant: Tenant) -> bool:
    trial_end = _utc_naive(tenant.trial_end)
    if trial_end is None:
        return False
    intact_demo_seed, _proof_status = verify_self_service_demo_seed_proof(db, str(tenant.id))
    blockers = _trial_cleanup_blockers(
        db,
        tenant,
        category="inactive",
        activity_cutoff=trial_end,
        intact_demo_seed=intact_demo_seed,
        require_pre_anonymization_notice=False,
    )
    return not blockers


def _email_copy(
    event_type: str,
    *,
    trial_end: datetime,
    inactive_days: int,
    effective_anonymization_at: datetime | None,
) -> _EmailCopy:
    end_label = _format_utc(trial_end)
    planned_anonymization = effective_anonymization_at or trial_end + timedelta(days=inactive_days)
    anonymization_label = _format_utc(planned_anonymization)

    if event_type == EMAIL_TYPE_TRIAL_STARTED:
        return _EmailCopy(
            subject=f"{EMAIL_BRAND_NAME} · Votre essai est actif",
            heading="Votre espace d’essai est prêt",
            paragraphs=(
                f"Votre essai {EMAIL_PRODUCT_NAME} est actif jusqu’au {end_label}.",
                "À la fin de l’essai, les créations et modifications seront verrouillées. "
                "Vous pourrez encore vous connecter pour choisir un abonnement, mais les exports ne seront plus accessibles.",
                "Avant cette date, téléchargez les documents que vous souhaitez conserver sans abonnement.",
                f"Sans abonnement, le compte pourra être anonymisé au plus tôt le {anonymization_label}, "
                "uniquement si aucune donnée ni obligation de conservation ne s’y oppose.",
            ),
            action_label="Accéder à mon espace",
            action_path="/app/dashboard",
        )
    if event_type == EMAIL_TYPE_TRIAL_ENDING:
        return _EmailCopy(
            subject=f"{EMAIL_BRAND_NAME} · Votre essai se termine bientôt",
            heading="Votre essai se termine bientôt",
            paragraphs=(
                f"Votre essai {EMAIL_PRODUCT_NAME} se termine le {end_label}.",
                "Après cette échéance, les créations et modifications seront verrouillées tant qu’aucun abonnement n’est actif.",
                "Avant cette échéance, choisissez une offre ou téléchargez les documents que vous souhaitez conserver.",
            ),
            action_label="Voir les abonnements",
            action_path="/app/billing",
        )
    if event_type == EMAIL_TYPE_TRIAL_EXPIRED:
        return _EmailCopy(
            subject=f"{EMAIL_BRAND_NAME} · Votre essai est terminé",
            heading="Votre essai est maintenant verrouillé",
            paragraphs=(
                f"Votre essai {EMAIL_PRODUCT_NAME} a pris fin le {end_label}.",
                "Les créations, les modifications et les exports sont verrouillés. La connexion et la souscription restent accessibles.",
                f"Sans abonnement, le compte pourra être anonymisé au plus tôt le {anonymization_label}, "
                "sous réserve des obligations de conservation applicables.",
            ),
            action_label="Choisir un abonnement",
            action_path="/app/billing",
        )
    if event_type == EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION:
        return _EmailCopy(
            subject=f"{EMAIL_BRAND_NAME} · Anonymisation prochaine de votre compte d’essai",
            heading="Votre compte d’essai sera bientôt anonymisé",
            paragraphs=(
                f"En l’absence d’abonnement, l’anonymisation de votre compte d’essai pourra intervenir au plus tôt le {anonymization_label}.",
                "L’identité, les coordonnées et les secrets d’accès seront remplacés ou révoqués. "
                "Les données soumises à une obligation légale ou contractuelle de conservation ne sont pas supprimées par cette opération.",
                "Pour conserver l’accès, activez un abonnement avant cette date. Si vous n’envisagez pas de poursuivre, aucune action n’est nécessaire.",
            ),
            action_label="Conserver mon accès",
            action_path="/app/billing",
        )
    raise ValueError("Type de notification d’essai inconnu.")


def _text_version(copy: _EmailCopy, action_url: str) -> str:
    paragraphs = "\n\n".join(copy.paragraphs)
    return (
        f"Bonjour,\n\n{paragraphs}\n\n{copy.action_label} : {action_url}\n\n"
        "Ne partagez jamais vos identifiants. Chaque espace d’essai est personnel et isolé des autres entreprises.\n\n"
        f"Vous recevez cet email car un espace d’essai {EMAIL_PRODUCT_NAME} est associé à cette adresse."
    )


def _candidate_query(
    db: Session,
    *,
    event_type: str,
    now: datetime,
    inactive_days: int,
    notice_days: int,
    tenant_id: str | None,
) -> Query:
    trialing = func.lower(func.trim(func.coalesce(Tenant.subscription_status, ""))) == "trialing"
    inactive = func.lower(func.trim(func.coalesce(Tenant.subscription_status, ""))) == "inactive"
    query = db.query(Tenant).filter(
        Tenant.deleted_at.is_(None),
        Tenant.trial_end.is_not(None),
    )
    if event_type == EMAIL_TYPE_TRIAL_STARTED:
        query = query.filter(
            trialing,
            Tenant.trial_end > now + _TRIAL_ENDING_NOTICE_WINDOW,
        )
    elif event_type == EMAIL_TYPE_TRIAL_ENDING:
        query = query.filter(
            trialing,
            Tenant.trial_end > now,
            Tenant.trial_end <= now + _TRIAL_ENDING_NOTICE_WINDOW,
        )
    elif event_type == EMAIL_TYPE_TRIAL_EXPIRED:
        query = query.filter(
            or_(trialing, inactive),
            Tenant.trial_end <= now,
            Tenant.trial_end > now - _TRIAL_EXPIRED_NOTICE_WINDOW,
        )
    elif event_type == EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION:
        query = query.filter(
            inactive,
            Tenant.trial_end <= now - timedelta(days=inactive_days - notice_days),
        )
    else:
        raise ValueError("Type de notification d’essai inconnu.")
    if tenant_id:
        query = query.filter(Tenant.id == tenant_id)
    return query


def _candidate_tenants(
    db: Session,
    *,
    event_type: str,
    now: datetime,
    inactive_days: int,
    notice_days: int,
    tenant_id: str | None,
    batch_size: int,
) -> Iterator[Tenant]:
    """Page through a milestone until its quota is filled or rows are exhausted."""

    query = _candidate_query(
        db,
        event_type=event_type,
        now=now,
        inactive_days=inactive_days,
        notice_days=notice_days,
        tenant_id=tenant_id,
    )
    page_size = max(25, min(500, batch_size * 2))
    last_trial_end: datetime | None = None
    last_tenant_id: str | None = None
    while True:
        page_query = query
        if last_trial_end is not None and last_tenant_id is not None:
            page_query = page_query.filter(
                or_(
                    Tenant.trial_end > last_trial_end,
                    and_(Tenant.trial_end == last_trial_end, Tenant.id > last_tenant_id),
                )
            )
        page = (
            page_query.order_by(Tenant.trial_end.asc(), Tenant.id.asc())
            .limit(page_size)
            .all()
        )
        if not page:
            return
        for tenant in page:
            yield tenant
        last = page[-1]
        last_trial_end = _utc_naive(last.trial_end)
        last_tenant_id = str(last.id)
        if last_trial_end is None or len(page) < page_size:
            return


def _idempotency_key(tenant: Tenant, user: User, event_type: str, trial_end: datetime) -> str:
    return f"trial-lifecycle:{tenant.id}:{user.id}:{event_type}:{trial_end.isoformat()}"


def _event_can_be_enqueued(db: Session, idempotency_key: str) -> bool:
    event = db.get(EmailEvent, idempotent_email_event_id(idempotency_key))
    if event is None:
        return True
    return (
        str(event.status or "").strip().lower() == EMAIL_STATUS_FAILED
        and not str(event.provider_status or "").strip()
    )


def run_trial_lifecycle_notifications(
    *,
    dry_run: bool = False,
    now: datetime | None = None,
    tenant_id: str | None = None,
) -> dict[str, object]:
    """Notify trial milestones without ever logging recipient or company data."""

    cutoff_now = _utc_naive(now) or datetime.now(timezone.utc).replace(tzinfo=None)
    enabled = bool(getattr(settings, "TRIAL_LIFECYCLE_NOTIFICATIONS_ENABLED", False))
    inactive_days = _setting_days("TRIAL_INACTIVE_ANONYMIZE_DAYS", 30)
    requested_notice_days = _setting_days("TRIAL_PRE_ANONYMIZATION_NOTICE_DAYS", 7)
    notice_days = min(requested_notice_days, max(1, inactive_days - 1))
    batch_size = int(getattr(settings, "TRIAL_LIFECYCLE_CLEANUP_BATCH_SIZE", 100) or 100)
    batch_size = min(1000, max(1, batch_size))
    event_types = (
        EMAIL_TYPE_TRIAL_STARTED,
        EMAIL_TYPE_TRIAL_ENDING,
        EMAIL_TYPE_TRIAL_EXPIRED,
        EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION,
    )
    summary: dict[str, object] = {
        "ok": True,
        "enabled": enabled,
        "evaluated": bool(enabled or dry_run),
        "dry_run": dry_run,
        "inactive_anonymize_days": inactive_days,
        "pre_anonymization_notice_days": notice_days,
        "candidates": 0,
        "eligible": 0,
        "would_enqueue": 0,
        "enqueued": 0,
        "idempotent_skips": 0,
        "no_recipient": 0,
        "policy_blocked": 0,
        "errors": 0,
        "delivery_unavailable": None,
        "by_type": {
            event_type: {"eligible": 0, "enqueued": 0, "idempotent_skips": 0}
            for event_type in event_types
        },
    }
    if not enabled and not dry_run:
        logger.info(json.dumps({"event": "trial_lifecycle_notifications_disabled"}))
        return summary

    if not dry_run:
        unavailable_reason = _delivery_unavailable_reason()
        if unavailable_reason:
            summary["ok"] = False
            summary["errors"] = 1
            summary["delivery_unavailable"] = unavailable_reason
            logger.error(
                json.dumps(
                    {
                        "event": "trial_lifecycle_notifications_unavailable",
                        "reason": unavailable_reason,
                    }
                )
            )
            return summary

    with SessionLocal() as db:
        for event_type in event_types:
            selected = 0
            type_summary = summary["by_type"][event_type]  # type: ignore[index]
            for tenant in _candidate_tenants(
                db,
                event_type=event_type,
                now=cutoff_now,
                inactive_days=inactive_days,
                notice_days=notice_days,
                tenant_id=tenant_id,
                batch_size=batch_size,
            ):
                if selected >= batch_size:
                    break
                tenant_trial_end = _utc_naive(tenant.trial_end)
                if tenant_trial_end is None:
                    continue
                milestone = next(
                    (
                        item
                        for item in _milestones(
                            tenant,
                            now=cutoff_now,
                            inactive_days=inactive_days,
                            notice_days=notice_days,
                        )
                        if item.event_type == event_type
                    ),
                    None,
                )
                if milestone is None:
                    continue
                summary["candidates"] = int(summary["candidates"]) + 1
                user = _principal_user(db, str(tenant.id))
                if user is None:
                    summary["no_recipient"] = int(summary["no_recipient"]) + 1
                    continue
                idempotency_key = _idempotency_key(tenant, user, event_type, tenant_trial_end)
                if not _event_can_be_enqueued(db, idempotency_key):
                    summary["idempotent_skips"] = int(summary["idempotent_skips"]) + 1
                    type_summary["idempotent_skips"] += 1
                    continue
                if event_type == EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION and not _pre_anonymization_is_eligible(
                    db,
                    tenant,
                ):
                    summary["policy_blocked"] = int(summary["policy_blocked"]) + 1
                    continue

                selected += 1
                summary["eligible"] = int(summary["eligible"]) + 1
                type_summary["eligible"] += 1
                if dry_run:
                    summary["would_enqueue"] = int(summary["would_enqueue"]) + 1
                    continue

                copy = _email_copy(
                    event_type,
                    trial_end=tenant_trial_end,
                    inactive_days=inactive_days,
                    effective_anonymization_at=milestone.effective_anonymization_at,
                )
                action_url = f"{_public_base_url()}{copy.action_path}"
                try:
                    event, enqueued = enqueue_idempotent_email(
                        idempotency_key=idempotency_key,
                        tenant_id=str(tenant.id),
                        user_id=str(user.id),
                        event_type=event_type,
                        to=str(user.email),
                        subject=copy.subject,
                        text=_text_version(copy, action_url),
                        template="trial_lifecycle.html",
                        context={
                            "brand_name": EMAIL_BRAND_NAME,
                            "product_name": EMAIL_PRODUCT_NAME,
                            "heading": copy.heading,
                            "paragraphs": copy.paragraphs,
                            "action_label": copy.action_label,
                            "action_url": action_url,
                        },
                    )
                    if event.status == EMAIL_STATUS_FAILED:
                        summary["errors"] = int(summary["errors"]) + 1
                        summary["ok"] = False
                    elif enqueued:
                        summary["enqueued"] = int(summary["enqueued"]) + 1
                        type_summary["enqueued"] += 1
                    else:
                        summary["idempotent_skips"] = int(summary["idempotent_skips"]) + 1
                        type_summary["idempotent_skips"] += 1
                except Exception:
                    summary["errors"] = int(summary["errors"]) + 1
                    summary["ok"] = False
                    logger.exception(
                        "trial_lifecycle_notification_failed",
                        extra={"tenant_id": str(tenant.id), "event_type": event_type},
                    )
    return summary
