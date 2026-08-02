import json
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import Base, SessionLocal
from ..models import (
    ActionLog,
    AuthSession,
    DemoInvitation,
    EmailEvent,
    Invoice,
    LegalAcceptance,
    Membership,
    Tenant,
    TenantSettings,
    User,
)
from ..services.action_logs import log_action
from ..services.demo_seed import purge_tenant_demo_data, verify_self_service_demo_seed_proof
from ..services.storage import delete_object, invoice_artifact_key
from ..utils.passwords import pwd
from .email_jobs import EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION, TRIAL_LIFECYCLE_EMAIL_TYPES


logger = logging.getLogger(__name__)

IMMUTABLE_STATUSES = {"issued", "sent", "paid", "overdue", "partial"}

# Toute table tenant-scoped absente de cette allowlist bloque automatiquement
# l'anonymisation. Ce comportement fail-closed protege aussi les futurs modeles
# metier qui seraient ajoutes sans mise a jour explicite de cette politique.
_TRIAL_LIFECYCLE_ALLOWED_TABLES = frozenset(
    {
        "action_logs",
        "auth_sessions",
        "email_events",
        "legal_acceptances",
        "memberships",
        "numbering",
        "tenant_settings",
        "users",
    }
)
_TRIAL_LIFECYCLE_ALLOWED_ACTIONS = frozenset({"trial_expired"})
_TRIAL_LIFECYCLE_AUTH_ACTIONS = frozenset(
    {
        "login",
        "logout",
        "password_changed",
        "mfa_enabled",
        "mfa_disabled",
        "mfa_reset",
        "mfa_recovery_codes_regenerated",
        "session_created",
        "session_refreshed",
        "session_revoked",
    }
)
_TRIAL_LIFECYCLE_ALLOWED_EMAIL_TYPES = frozenset({"verification", *TRIAL_LIFECYCLE_EMAIL_TYPES})
_TRIAL_LIFECYCLE_INTACT_DEMO_TABLES = frozenset(
    {"customers", "products", "quotes", "quote_numbering", "invoices"}
)
_TRIAL_ANONYMIZED_DOMAIN = "invalid.local"
_TRIAL_PASSWORD_CONTEXT = pwd


def _setting_days(name: str, default: int) -> int:
    value = int(getattr(settings, name, default) or default)
    return max(1, value)


def _trial_cleanup_excluded_tenant_ids() -> set[str]:
    raw = str(getattr(settings, "TRIAL_CLEANUP_EXCLUDED_TENANT_IDS", "") or "")
    return {item.strip() for item in raw.split(",") if item.strip()}


def _flag_enabled(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _utc_naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _tenant_has_legal_hold(settings_row: TenantSettings | None) -> bool:
    features = settings_row.features if settings_row and isinstance(settings_row.features, dict) else {}
    lifecycle = features.get("lifecycle") if isinstance(features, dict) else None
    candidates = [
        features.get("legal_hold") if isinstance(features, dict) else None,
        features.get("retention_hold") if isinstance(features, dict) else None,
        lifecycle.get("legal_hold") if isinstance(lifecycle, dict) else None,
    ]
    return any(_flag_enabled(value) for value in candidates)


def _tenant_scoped_data_blockers(db: Session, tenant_id: str) -> list[str]:
    blockers: list[str] = []
    for table_name, table in sorted(Base.metadata.tables.items()):
        if "tenant_id" not in table.c or table_name in _TRIAL_LIFECYCLE_ALLOWED_TABLES:
            continue
        exists = db.execute(
            select(table.c.tenant_id).where(table.c.tenant_id == tenant_id).limit(1)
        ).first()
        if exists is not None:
            blockers.append(f"tenant_data:{table_name}")
    return blockers


def _trial_cleanup_blockers(
    db: Session,
    tenant: Tenant,
    *,
    category: str,
    activity_cutoff: datetime,
    intact_demo_seed: bool = False,
    require_pre_anonymization_notice: bool = True,
    policy_now: datetime | None = None,
) -> list[str]:
    blockers: list[str] = []
    tenant_id = str(tenant.id)
    status = (tenant.subscription_status or "").strip().lower()

    if tenant.deleted_at is not None:
        blockers.append("already_deleted")
    if tenant.trial_end is None:
        blockers.append("trial_end_missing")
    if category == "unverified":
        if status not in {"trialing", "inactive"}:
            blockers.append("subscription_status_not_trial")
    elif status != "inactive":
        blockers.append("subscription_status_not_inactive")

    stripe_fields = (
        tenant.stripe_customer_id,
        tenant.stripe_subscription_id,
        tenant.stripe_checkout_session_id,
        tenant.stripe_checkout_request_key,
    )
    if any(str(value or "").strip() for value in stripe_fields):
        blockers.append("stripe_state_present")
    if str(tenant.logo_storage_key or "").strip():
        blockers.append("stored_logo_present")
    if tenant_id in _trial_cleanup_excluded_tenant_ids():
        blockers.append("tenant_excluded")

    settings_row = db.get(TenantSettings, tenant_id)
    if _tenant_has_legal_hold(settings_row):
        blockers.append("legal_hold")

    users = (
        db.query(User)
        .filter(User.tenant_id == tenant_id)
        .with_for_update()
        .all()
    )
    if len(users) != 1:
        blockers.append("user_count_not_one")
    if any(bool(user.is_admin or user.is_platform_admin or user.is_support) for user in users):
        blockers.append("privileged_user_present")
    if category == "unverified" and any((user.status or "active").strip().lower() != "pending" for user in users):
        blockers.append("verified_user_present")

    user_ids = [str(user.id) for user in users if user.id]
    if user_ids:
        external_membership = (
            db.query(Membership.id)
            .filter(Membership.user_id.in_(user_ids), Membership.tenant_id != tenant_id)
            .first()
        )
        if external_membership is not None:
            blockers.append("external_membership_present")

    sessions_query = db.query(AuthSession).filter(AuthSession.tenant_id == tenant_id)
    if user_ids:
        sessions_query = sessions_query.filter(AuthSession.user_id.in_(user_ids))
    if category == "unverified":
        if sessions_query.first() is not None:
            blockers.append("auth_session_present")
    else:
        recent_session = sessions_query.filter(
            func.coalesce(AuthSession.last_used_at, AuthSession.created_at) >= activity_cutoff
        ).first()
        if recent_session is not None:
            blockers.append("recent_auth_activity")

    if not intact_demo_seed:
        recent_auth_action = False
        business_actions: set[str] = set()
        action_rows = db.query(ActionLog.action, ActionLog.created_at).filter(ActionLog.tenant_id == tenant_id).all()
        for action_value, created_at in action_rows:
            action = str(action_value or "").strip().lower()
            if action in _TRIAL_LIFECYCLE_ALLOWED_ACTIONS:
                continue
            if action in _TRIAL_LIFECYCLE_AUTH_ACTIONS:
                action_at = _utc_naive(created_at)
                if category == "unverified" or action_at is None or action_at >= activity_cutoff:
                    recent_auth_action = True
                continue
            business_actions.add(action or "unknown")
        if recent_auth_action:
            blockers.append("recent_auth_activity")
        if business_actions:
            blockers.append("business_action_log_present")

    email_rows = (
        db.query(EmailEvent.type, EmailEvent.invoice_id, EmailEvent.quote_id)
        .filter(EmailEvent.tenant_id == tenant_id)
        .all()
    )
    if any(
        str(email_type or "") not in _TRIAL_LIFECYCLE_ALLOWED_EMAIL_TYPES or invoice_id or quote_id
        for email_type, invoice_id, quote_id in email_rows
    ):
        blockers.append("non_verification_email_present")

    if (
        category == "inactive"
        and require_pre_anonymization_notice
        and bool(getattr(settings, "TRIAL_LIFECYCLE_NOTIFICATIONS_ENABLED", False))
    ):
        notice = (
            db.query(EmailEvent)
            .filter(
                EmailEvent.tenant_id == tenant_id,
                EmailEvent.type == EMAIL_TYPE_TRIAL_PRE_ANONYMIZATION,
            )
            .order_by(EmailEvent.created_at.desc(), EmailEvent.id.desc())
            .first()
        )
        failed_provider_statuses = {
            "blocked",
            "complaint",
            "failed",
            "hard_bounce",
            "soft_bounce",
            "spam",
            "unsubscribed",
        }
        successful_delivery_statuses = {"sent", "delivered", "opened", "clicked"}
        notice_status = str(notice.status or "").strip().lower() if notice is not None else ""
        provider_status = str(notice.provider_status or "").strip().lower() if notice is not None else ""
        if notice is None:
            blockers.append("pre_anonymization_notice_missing")
        elif notice_status in failed_provider_statuses or provider_status in failed_provider_statuses:
            blockers.append("pre_anonymization_notice_delivery_failed")
        elif notice_status not in successful_delivery_statuses or notice.sent_at is None:
            blockers.append("pre_anonymization_notice_pending")
        else:
            notice_days = _setting_days("TRIAL_PRE_ANONYMIZATION_NOTICE_DAYS", 7)
            inactive_days = _setting_days("TRIAL_INACTIVE_ANONYMIZE_DAYS", 30)
            notice_days = min(notice_days, max(1, inactive_days - 1))
            notice_sent_at = _utc_naive(notice.sent_at)
            effective_now = _utc_naive(policy_now) or datetime.now(timezone.utc).replace(tzinfo=None)
            if notice_sent_at is None or notice_sent_at + timedelta(days=notice_days) > effective_now:
                blockers.append("pre_anonymization_notice_grace_period")

    data_blockers = _tenant_scoped_data_blockers(db, tenant_id)
    if intact_demo_seed:
        data_blockers = [
            blocker
            for blocker in data_blockers
            if blocker.removeprefix("tenant_data:") not in _TRIAL_LIFECYCLE_INTACT_DEMO_TABLES
        ]
    blockers.extend(data_blockers)
    return sorted(set(blockers))


def _anonymous_email(tenant_id: str, user_id: str) -> str:
    digest = hashlib.sha256(f"{tenant_id}:{user_id}".encode("utf-8")).hexdigest()[:32]
    return f"deleted-{digest}@{_TRIAL_ANONYMIZED_DOMAIN}"


def _anonymous_tenant_slug(tenant_id: str) -> str:
    digest = hashlib.sha256(tenant_id.encode("utf-8")).hexdigest()[:24]
    return f"deleted-trial-{digest}"


_TENANT_PERSONAL_FIELDS = (
    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_subscription_event_created",
    "stripe_subscription_event_id",
    "stripe_checkout_session_id",
    "stripe_checkout_request_key",
    "stripe_checkout_pending_until",
    "stripe_checkout_plan",
    "stripe_checkout_period",
    "professional_use_confirmed_at",
    "professional_use_confirmed_by",
    "siret",
    "rcs",
    "naf_code",
    "legal_form",
    "share_capital",
    "address",
    "address_line1",
    "address_line2",
    "postal_code",
    "city",
    "phone",
    "vat_number",
    "iban",
    "bic",
    "logo_url",
    "logo_storage_key",
    "legal_mentions",
    "vat_exemption_notice",
    "email_subject_default",
    "email_body_default",
    "reminder_subject_default",
    "reminder_body_default",
    "quote_email_subject_default",
    "quote_email_body_default",
    "quote_followup_subject_default",
    "quote_followup_body_default",
    "quote_terms_url",
    "quote_otp_subject_default",
    "quote_otp_body_default",
    "email_reply_to",
)


def _anonymize_trial_tenant(
    db: Session,
    tenant: Tenant,
    *,
    category: str,
    now: datetime,
    policy_days: int,
    demo_purge_stats: dict[str, int] | None = None,
) -> None:
    tenant_id = str(tenant.id)
    users = db.query(User).filter(User.tenant_id == tenant_id).with_for_update().all()
    user = users[0]
    anonymous_email = _anonymous_email(tenant_id, str(user.id))
    demo_invitations_purged = (
        db.query(DemoInvitation)
        .filter(DemoInvitation.consumed_by_user_id == user.id)
        .delete(synchronize_session=False)
    )

    log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=None,
        action_type="trial_account_anonymized",
        object_type="tenant",
        object_id=tenant_id,
        metadata={
            "policy_version": 1,
            "category": category,
            "policy_days": policy_days,
            "tenant_created_at": tenant.created_at,
            "trial_end": tenant.trial_end,
            "anonymized_at": now,
            "demo_purge_stats": demo_purge_stats or None,
            "demo_invitations_purged": demo_invitations_purged,
        },
    )

    db.query(AuthSession).filter(AuthSession.tenant_id == tenant_id).delete(synchronize_session=False)
    db.query(LegalAcceptance).filter(LegalAcceptance.tenant_id == tenant_id).update(
        {LegalAcceptance.ip: None, LegalAcceptance.user_agent: None},
        synchronize_session=False,
    )
    db.query(EmailEvent).filter(EmailEvent.tenant_id == tenant_id).update(
        {
            EmailEvent.to: anonymous_email,
            EmailEvent.error: None,
            EmailEvent.provider_message_id: None,
            EmailEvent.provider_event_id: None,
        },
        synchronize_session=False,
    )

    user.email = anonymous_email
    user.password_hash = _TRIAL_PASSWORD_CONTEXT.hash(secrets.token_urlsafe(48))
    user.role = "viewer"
    user.is_admin = False
    user.is_platform_admin = False
    user.is_support = False
    user.status = "disabled"
    user.token_version = int(user.token_version or 0) + 1
    user.mfa_enabled = False
    user.mfa_secret = None
    user.mfa_enrolled_at = None
    db.add(user)

    settings_row = db.get(TenantSettings, tenant_id)
    if settings_row is not None:
        settings_row.preset = "standard"
        settings_row.onboarding_completed = False
        settings_row.features = {
            "lifecycle": {
                "state": "anonymized",
                "category": category,
                "anonymized_at": now.isoformat(),
            }
        }
        db.add(settings_row)

    tenant.name = "Compte d'essai anonymise"
    tenant.tenant_slug = _anonymous_tenant_slug(tenant_id)
    tenant.plan = "starter"
    tenant.subscription_status = "inactive"
    tenant.deleted_at = now
    tenant.deleted_reason = f"trial_lifecycle:{category}"
    for field_name in _TENANT_PERSONAL_FIELDS:
        setattr(tenant, field_name, None)
    db.add(tenant)


def _trial_cleanup_candidate_ids(
    db: Session,
    *,
    now: datetime,
    tenant_id: str | None,
    batch_size: int,
) -> list[tuple[str, str]]:
    unverified_cutoff = now - timedelta(days=_setting_days("TRIAL_UNVERIFIED_PURGE_DAYS", 7))
    inactive_cutoff = now - timedelta(days=_setting_days("TRIAL_INACTIVE_ANONYMIZE_DAYS", 30))

    unverified_query = (
        db.query(Tenant.id)
        .join(User, User.tenant_id == Tenant.id)
        .filter(
            Tenant.deleted_at.is_(None),
            Tenant.created_at < unverified_cutoff,
            Tenant.trial_end.is_not(None),
            func.lower(func.trim(func.coalesce(Tenant.subscription_status, ""))).in_(("trialing", "inactive")),
            func.lower(func.trim(func.coalesce(User.status, "active"))) == "pending",
        )
        .group_by(Tenant.id, Tenant.created_at)
        .order_by(Tenant.created_at.asc(), Tenant.id.asc())
    )
    if tenant_id:
        unverified_query = unverified_query.filter(Tenant.id == tenant_id)
    unverified_ids = [str(row[0]) for row in unverified_query.limit(batch_size).all()]

    remaining = max(0, batch_size - len(unverified_ids))
    inactive_ids: list[str] = []
    if remaining:
        inactive_query = db.query(Tenant.id).filter(
            Tenant.deleted_at.is_(None),
            Tenant.trial_end.is_not(None),
            Tenant.trial_end < inactive_cutoff,
            func.lower(func.trim(func.coalesce(Tenant.subscription_status, ""))) == "inactive",
        )
        if tenant_id:
            inactive_query = inactive_query.filter(Tenant.id == tenant_id)
        if unverified_ids:
            inactive_query = inactive_query.filter(Tenant.id.notin_(unverified_ids))
        inactive_ids = [
            str(row[0])
            for row in inactive_query.order_by(Tenant.trial_end.asc(), Tenant.id.asc()).limit(remaining).all()
        ]

    return [(item, "unverified") for item in unverified_ids] + [(item, "inactive") for item in inactive_ids]


def run_trial_lifecycle_cleanup(
    *,
    dry_run: bool = False,
    now: datetime | None = None,
    tenant_id: str | None = None,
) -> dict[str, object]:
    """Anonymize stale trial accounts only when no retention blocker exists.

    Dry-run evaluates the policy even when automatic cleanup is disabled. An
    actual run is opt-in through ``TRIAL_LIFECYCLE_CLEANUP_ENABLED``.
    """

    cutoff_now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    enabled = bool(getattr(settings, "TRIAL_LIFECYCLE_CLEANUP_ENABLED", False))
    batch_size = int(getattr(settings, "TRIAL_LIFECYCLE_CLEANUP_BATCH_SIZE", 100) or 100)
    batch_size = min(1000, max(1, batch_size))
    unverified_days = _setting_days("TRIAL_UNVERIFIED_PURGE_DAYS", 7)
    inactive_days = _setting_days("TRIAL_INACTIVE_ANONYMIZE_DAYS", 30)
    summary: dict[str, object] = {
        "ok": True,
        "enabled": enabled,
        "evaluated": bool(enabled or dry_run),
        "dry_run": dry_run,
        "unverified_purge_days": unverified_days,
        "inactive_anonymize_days": inactive_days,
        "batch_size": batch_size,
        "candidates": 0,
        "eligible": 0,
        "would_anonymize": 0,
        "anonymized": 0,
        "intact_demo_candidates": 0,
        "demo_datasets_purged": 0,
        "blocked": 0,
        "errors": 0,
        "by_category": {
            "unverified": {"candidates": 0, "eligible": 0, "anonymized": 0, "blocked": 0},
            "inactive": {"candidates": 0, "eligible": 0, "anonymized": 0, "blocked": 0},
        },
        "blocked_reasons": {},
    }
    if not enabled and not dry_run:
        logger.info(json.dumps({"event": "trial_lifecycle_cleanup_disabled"}))
        return summary

    with SessionLocal() as db:
        candidates = _trial_cleanup_candidate_ids(
            db,
            now=cutoff_now,
            tenant_id=tenant_id,
            batch_size=batch_size,
        )
        summary["candidates"] = len(candidates)
        for candidate_tenant_id, category in candidates:
            category_summary = summary["by_category"][category]  # type: ignore[index]
            category_summary["candidates"] += 1
            policy_days = unverified_days if category == "unverified" else inactive_days
            activity_cutoff = cutoff_now - timedelta(days=inactive_days)
            try:
                tenant = (
                    db.query(Tenant)
                    .filter(Tenant.id == candidate_tenant_id, Tenant.deleted_at.is_(None))
                    .with_for_update(skip_locked=True)
                    .one_or_none()
                )
                if tenant is None:
                    db.rollback()
                    continue
                intact_demo_seed, demo_proof_status = verify_self_service_demo_seed_proof(
                    db,
                    candidate_tenant_id,
                )
                if intact_demo_seed:
                    summary["intact_demo_candidates"] = int(summary["intact_demo_candidates"]) + 1
                blockers = _trial_cleanup_blockers(
                    db,
                    tenant,
                    category=category,
                    activity_cutoff=activity_cutoff,
                    intact_demo_seed=intact_demo_seed,
                    policy_now=cutoff_now,
                )
                if blockers:
                    summary["blocked"] = int(summary["blocked"]) + 1
                    category_summary["blocked"] += 1
                    reason_counts = summary["blocked_reasons"]
                    for reason in blockers:
                        reason_counts[reason] = int(reason_counts.get(reason, 0)) + 1
                    logger.info(
                        json.dumps(
                            {
                                "event": "trial_lifecycle_cleanup_blocked",
                                "tenant_id": candidate_tenant_id,
                                "category": category,
                                "reasons": blockers,
                                "demo_proof_status": demo_proof_status,
                                "dry_run": dry_run,
                            }
                        )
                    )
                    db.rollback()
                    continue

                if dry_run:
                    summary["eligible"] = int(summary["eligible"]) + 1
                    category_summary["eligible"] += 1
                    summary["would_anonymize"] = int(summary["would_anonymize"]) + 1
                    logger.info(
                        json.dumps(
                            {
                                "event": "trial_lifecycle_cleanup_candidate",
                                "tenant_id": candidate_tenant_id,
                                "category": category,
                                "dry_run": True,
                            }
                        )
                    )
                    db.rollback()
                    continue

                demo_purge_stats: dict[str, int] | None = None
                if intact_demo_seed:
                    demo_purge_stats = purge_tenant_demo_data(
                        db,
                        candidate_tenant_id,
                        commit=False,
                        purge_numbering=True,
                    )
                    db.query(ActionLog).filter(
                        ActionLog.tenant_id == candidate_tenant_id,
                        ActionLog.action.notin_(_TRIAL_LIFECYCLE_ALLOWED_ACTIONS),
                    ).delete(synchronize_session=False)
                    post_purge_blockers = _trial_cleanup_blockers(
                        db,
                        tenant,
                        category=category,
                        activity_cutoff=activity_cutoff,
                        policy_now=cutoff_now,
                    )
                    if post_purge_blockers:
                        db.rollback()
                        summary["errors"] = int(summary["errors"]) + 1
                        summary["ok"] = False
                        logger.error(
                            json.dumps(
                                {
                                    "event": "trial_demo_purge_incomplete",
                                    "tenant_id": candidate_tenant_id,
                                    "category": category,
                                    "reasons": post_purge_blockers,
                                }
                            )
                        )
                        continue

                summary["eligible"] = int(summary["eligible"]) + 1
                category_summary["eligible"] += 1
                _anonymize_trial_tenant(
                    db,
                    tenant,
                    category=category,
                    now=cutoff_now,
                    policy_days=policy_days,
                    demo_purge_stats=demo_purge_stats,
                )
                db.commit()
                summary["anonymized"] = int(summary["anonymized"]) + 1
                category_summary["anonymized"] += 1
                if demo_purge_stats is not None:
                    summary["demo_datasets_purged"] = int(summary["demo_datasets_purged"]) + 1
                logger.info(
                    json.dumps(
                        {
                            "event": "trial_lifecycle_cleanup_applied",
                            "tenant_id": candidate_tenant_id,
                            "category": category,
                        }
                    )
                )
            except Exception:
                db.rollback()
                summary["errors"] = int(summary["errors"]) + 1
                summary["ok"] = False
                logger.exception(
                    "trial_lifecycle_cleanup_failed",
                    extra={"tenant_id": candidate_tenant_id, "category": category},
                )
    return summary


def purge_stale_demo_invitations(
    *,
    dry_run: bool = False,
    now: datetime | None = None,
) -> dict[str, int | bool]:
    """Delete only unconsumed invitations stale beyond the configured margin."""

    cutoff_now = _utc_naive(now) or datetime.now(timezone.utc).replace(tzinfo=None)
    retention_days = _setting_days("DEMO_INVITATION_RETENTION_DAYS", 30)
    cutoff = cutoff_now - timedelta(days=retention_days)
    batch_size = int(getattr(settings, "TRIAL_LIFECYCLE_CLEANUP_BATCH_SIZE", 100) or 100)
    batch_size = min(1000, max(1, batch_size))
    summary: dict[str, int | bool] = {
        "ok": True,
        "dry_run": dry_run,
        "retention_days": retention_days,
        "candidates": 0,
        "would_purge": 0,
        "purged": 0,
    }
    with SessionLocal() as db:
        candidate_ids = [
            str(row[0])
            for row in (
                db.query(DemoInvitation.id)
                .filter(
                    DemoInvitation.consumed_at.is_(None),
                    DemoInvitation.consumed_by_user_id.is_(None),
                    or_(
                        DemoInvitation.expires_at < cutoff,
                        and_(
                            DemoInvitation.revoked_at.is_not(None),
                            DemoInvitation.revoked_at < cutoff,
                        ),
                    ),
                )
                .order_by(DemoInvitation.expires_at.asc(), DemoInvitation.id.asc())
                .limit(batch_size)
                .all()
            )
        ]
        summary["candidates"] = len(candidate_ids)
        if dry_run:
            summary["would_purge"] = len(candidate_ids)
            return summary
        if candidate_ids:
            summary["purged"] = int(
                db.query(DemoInvitation)
                .filter(
                    DemoInvitation.id.in_(candidate_ids),
                    DemoInvitation.consumed_at.is_(None),
                    DemoInvitation.consumed_by_user_id.is_(None),
                    or_(
                        DemoInvitation.expires_at < cutoff,
                        and_(
                            DemoInvitation.revoked_at.is_not(None),
                            DemoInvitation.revoked_at < cutoff,
                        ),
                    ),
                )
                .delete(synchronize_session=False)
            )
            db.commit()
    return summary


def expire_ended_trials(*, dry_run: bool = False, now: datetime | None = None) -> dict[str, int | bool]:
    """Proactively close ended trials while preserving login and billing access.

    Trial data is not deleted here: accounting retention and a possible paid
    conversion require a separate, explicit lifecycle policy. Marking the
    subscription inactive is enough for the existing write and export guards
    to fail closed while keeping the subscription recovery path available.
    """

    cutoff = now or datetime.now(timezone.utc).replace(tzinfo=None)
    summary: dict[str, int | bool] = {"ok": True, "dry_run": dry_run, "candidates": 0, "expired": 0}
    with SessionLocal() as db:
        trials = (
            db.query(Tenant)
            .filter(
                func.lower(func.trim(func.coalesce(Tenant.subscription_status, ""))) == "trialing",
                Tenant.trial_end.is_not(None),
                Tenant.trial_end < cutoff,
                Tenant.deleted_at.is_(None),
            )
            .with_for_update(skip_locked=True)
            .all()
        )
        summary["candidates"] = len(trials)
        if dry_run:
            return summary
        for tenant in trials:
            tenant.subscription_status = "inactive"
            db.add(tenant)
            log_action(
                db,
                tenant_id=tenant.id,
                actor_user_id=None,
                action_type="trial_expired",
                object_type="tenant",
                object_id=tenant.id,
                metadata={"trial_end": tenant.trial_end, "expired_at": cutoff},
            )
            summary["expired"] = int(summary["expired"]) + 1
        db.commit()
    return summary


def _normalize_years(value: int | None) -> int:
    if value is None or value < 1:
        return int(getattr(settings, "RETENTION_DEFAULT_YEARS", 10) or 10)
    return int(value)


def _retention_years_for_tenant(tenant: Tenant) -> tuple[int, bool]:
    raw_years = tenant.retention_years
    years = raw_years or 10
    adjusted = False
    if tenant.country == "FR":
        adjusted_years = max(years, 10)
        if adjusted_years != years:
            adjusted = True
        years = adjusted_years
    if years != raw_years:
        adjusted = True
    return years, adjusted


def _normalize_days(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if parsed <= 0:
        return None
    return parsed


def _cutoff_from_days(now: datetime, days: int | None, fallback_years: int) -> datetime:
    if days is None:
        days = fallback_years * 365
    return now - timedelta(days=days)


def _cutoff_from_years(now: datetime, years: int) -> datetime:
    return _add_years(now, -years)


def _add_years(value: datetime, years: int) -> datetime:
    try:
        return value.replace(year=value.year + years)
    except ValueError:
        # 29 février -> 28 février quand l'année cible n'est pas bissextile.
        return value.replace(month=2, day=28, year=value.year + years)


def _issued_retention_reference(invoice: Invoice, tenant: Tenant) -> datetime:
    ref = invoice.issued_at or invoice.issue_date or invoice.created_at
    if tenant.country == "FR":
        # Les factures sont des pièces justificatives à conserver depuis la
        # clôture de l'exercice, pas seulement depuis la date d'émission.
        return datetime(ref.year, 12, 31, 23, 59, 59)
    return ref


def _issued_invoice_is_purgeable(invoice: Invoice, tenant: Tenant, now: datetime, retention_years: int) -> bool:
    deadline = _add_years(_issued_retention_reference(invoice, tenant), retention_years)
    return now > deadline


def _delete_artifacts(invoice: Invoice) -> list[str]:
    errors: list[str] = []
    for key in (invoice.pdf_key, invoice.xml_key, invoice.facturx_key):
        if not key:
            continue
        try:
            delete_object(key)
        except Exception:
            logger.exception("retention_delete_object_failed", extra={"invoice_id": invoice.id, "key": key})
            errors.append("La suppression d’un fichier archivé n’a pas pu être terminée.")
    for kind in ("compliance_report_json", "compliance_report_pdf"):
        key = invoice_artifact_key(invoice.id, kind)
        try:
            delete_object(key)
        except Exception:
            logger.exception("retention_delete_object_failed", extra={"invoice_id": invoice.id, "key": key})
            errors.append("La suppression d’un fichier archivé n’a pas pu être terminée.")
    return errors


def _log_retention_action(db, tenant_id: str, invoice: Invoice, retention_years: int, policy: str) -> None:
    payload = {
        "status": invoice.status,
        "number": invoice.number,
        "issued_at": invoice.issued_at,
        "issue_date": invoice.issue_date,
        "retention_years": retention_years,
        "policy": policy,
    }
    log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=None,
        action_type="retention_purge",
        object_type="invoice",
        object_id=invoice.id,
        metadata=payload,
    )


def run_retention_purge(tenant_id: str | None = None, dry_run: bool = False) -> dict:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    summary: dict = {"ok": True, "dry_run": dry_run, "tenants": []}
    with SessionLocal() as db:
        tenants_query = db.query(Tenant)
        if tenant_id:
            tenants_query = tenants_query.filter(Tenant.id == tenant_id)
        tenants = tenants_query.all()
        for tenant in tenants:
            tenant_summary = {
                "tenant_id": tenant.id,
                "retention_years": None,
                "draft_days": None,
                "canceled_days": None,
                "candidates": 0,
                "deleted": 0,
                "skipped": 0,
                "errors": 0,
            }
            try:
                retention_years, retention_adjusted = _retention_years_for_tenant(tenant)
                if retention_adjusted:
                    logger.info(
                        json.dumps(
                            {
                                "event": "retention_adjusted",
                                "tenant_id": tenant.id,
                                "country": tenant.country,
                                "original_retention_years": tenant.retention_years,
                                "retention_years": retention_years,
                            }
                        )
                    )
                draft_days = _normalize_days(settings.RETENTION_DRAFT_DAYS)
                canceled_days = _normalize_days(settings.RETENTION_CANCELED_DAYS)
                draft_cutoff = _cutoff_from_days(now, draft_days, retention_years)
                canceled_cutoff = _cutoff_from_days(now, canceled_days, retention_years)
                tenant_summary.update(
                    {
                        "retention_years": retention_years,
                        "draft_days": draft_days,
                        "canceled_days": canceled_days,
                    }
                )

                issued_query = (
                    db.query(Invoice)
                    .filter(
                        Invoice.tenant_id == tenant.id,
                        Invoice.status.in_(IMMUTABLE_STATUSES),
                    )
                )
                draft_query = (
                    db.query(Invoice)
                    .filter(
                        Invoice.tenant_id == tenant.id,
                        Invoice.status == "draft",
                        func.coalesce(Invoice.updated_at, Invoice.created_at) < draft_cutoff,
                    )
                )
                canceled_query = (
                    db.query(Invoice)
                    .filter(
                        Invoice.tenant_id == tenant.id,
                        Invoice.status == "canceled",
                        func.coalesce(Invoice.updated_at, Invoice.created_at) < canceled_cutoff,
                    )
                )

                candidates: list[Invoice] = []
                candidates.extend(
                    [
                        invoice
                        for invoice in issued_query
                        if _issued_invoice_is_purgeable(invoice, tenant, now, retention_years)
                    ]
                )
                candidates.extend(list(draft_query))
                candidates.extend(list(canceled_query))
                tenant_summary["candidates"] = len(candidates)

                for inv in candidates:
                    if dry_run:
                        tenant_summary["deleted"] += 1
                        continue
                    errors = _delete_artifacts(inv)
                    if errors:
                        tenant_summary["errors"] += 1
                        tenant_summary["skipped"] += 1
                        continue
                    policy = "issued" if inv.status in IMMUTABLE_STATUSES else inv.status
                    _log_retention_action(db, tenant.id, inv, retention_years, policy)
                    db.delete(inv)
                    tenant_summary["deleted"] += 1

                if not dry_run:
                    db.commit()
            except Exception:
                db.rollback()
                tenant_summary["errors"] += 1
                logger.exception("retention_purge_failed", extra={"tenant_id": tenant.id})
            summary["tenants"].append(tenant_summary)
    return summary
