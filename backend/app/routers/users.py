import hashlib
import logging
import secrets
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from time import time

from fastapi import APIRouter, Depends, HTTPException, Request
from redis import Redis
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import settings
from ..core.plans import enforce_accountant_limit, enforce_user_limit, require_pro_or_enterprise
from ..db import get_db
from ..deps import require_tenant_admin, AuthUser, ensure_active_subscription
from ..models import AuthSession, Tenant, User, UserInvite, Membership, Customer, CustomerUserLink, EmailEvent
from ..schemas import InviteAccept, InviteRevoke, MembershipRoleUpdate, UserInviteCreate
from ..services.email import send_email, assert_smtp_ready_or_raise
from ..jobs.email_jobs import workspace_invitation_subject
from ..services.action_logs import safe_log_action
from ..utils.pii import mask_email
from ..utils.passwords import pwd

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/users", tags=["users"])

INVITE_TOKEN_TTL_HOURS = 72
INVITE_ACTIVE_LIMIT = 50
INVITE_RATE_LIMIT_WINDOW_SECONDS = 60 * 60
INVITE_RATE_LIMIT_MAX = 20
INVITE_EMAIL_FAILURE_MESSAGE = "L’invitation n’a pas pu être envoyée. Réessayez plus tard."
_invite_attempts: dict[str, deque[float]] = defaultdict(deque)
_redis_client: Redis | None = None

ROLE_ORDER = {
    "client": 0,
    "viewer": 1,
    "sales": 2,
    "accountant": 3,
    "admin": 4,
    "owner": 5,
}



def _get_redis() -> Redis | None:
    global _redis_client
    if not settings.REDIS_URL:
        return None
    if _redis_client:
        return _redis_client
    try:
        _redis_client = Redis.from_url(settings.REDIS_URL, decode_responses=False)
    except Exception:
        _redis_client = None
    return _redis_client


def _invite_error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _throttle_invites(request: Request, admin: AuthUser) -> None:
    if getattr(settings, "DISABLE_RATE_LIMITS", False):
        return
    ip = request.client.host if request.client else "unknown"
    key = f"invite:tenant:{admin.tenant_id}:admin:{admin.id}:ip:{ip}"
    r = _get_redis()
    if r:
        try:
            cnt = r.incr(key)
            if cnt == 1:
                r.expire(key, INVITE_RATE_LIMIT_WINDOW_SECONDS)
            if cnt > INVITE_RATE_LIMIT_MAX:
                raise _invite_error(429, "invite_rate_limited", "Trop d'invitations envoyées. Réessayez plus tard.")
            return
        except HTTPException:
            raise
        except Exception:
            pass
    attempts = _invite_attempts[key]
    now = time()
    while attempts and now - attempts[0] > INVITE_RATE_LIMIT_WINDOW_SECONDS:
        attempts.popleft()
    if len(attempts) >= INVITE_RATE_LIMIT_MAX:
        raise _invite_error(429, "invite_rate_limited", "Trop d'invitations envoyées. Réessayez plus tard.")
    attempts.append(now)


def _expires_label(hours: int) -> str:
    if hours % 24 == 0:
        days = hours // 24
        return f"{days} jour" + ("s" if days > 1 else "")
    return f"{hours} heures"


def _record_invite_email_event(
    db: Session,
    *,
    tenant_id: str,
    user_id: str | None,
    to: str,
    smtp_ready: bool,
) -> EmailEvent:
    event = EmailEvent(
        tenant_id=tenant_id,
        user_id=user_id,
        type="invitation",
        to=to,
        status="queued" if smtp_ready else "log_only",
        delivery_mode="smtp" if smtp_ready else "log_only",
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


def _mark_invite_email_sent(db: Session, event: EmailEvent) -> None:
    event.status = "sent"
    event.sent_at = datetime.now(timezone.utc).replace(tzinfo=None)
    event.error = None
    db.add(event)
    db.commit()


def _mark_invite_email_failed(db: Session, event: EmailEvent) -> None:
    event.status = "failed"
    event.sent_at = None
    event.error = INVITE_EMAIL_FAILURE_MESSAGE
    db.add(event)
    db.flush()


def _should_upgrade_role(current: str, invited: str) -> bool:
    return ROLE_ORDER.get(invited, 0) > ROLE_ORDER.get(current, 0)


def _allowed_invite_roles(inviter: AuthUser) -> set[str]:
    is_owner = (inviter.role or "").lower() == "owner"
    if is_owner or inviter.is_admin:
        return {"accountant", "sales", "viewer", "client", "admin"}
    return {"accountant", "sales", "viewer", "client"}


def _allowed_member_roles(admin: AuthUser) -> set[str]:
    roles = {"accountant", "sales", "viewer"}
    if (admin.role or "").lower() == "owner" or admin.is_admin:
        roles.add("admin")
    return roles


def _tenant_membership_or_404(db: Session, *, tenant_id: str, user_id: str) -> Membership:
    membership = (
        db.query(Membership)
        .filter(Membership.user_id == user_id, Membership.tenant_id == tenant_id)
        .first()
    )
    if not membership:
        raise _invite_error(404, "member_not_found", "Membre introuvable dans cet espace.")
    return membership


def _tenant_owner_count(db: Session, tenant_id: str) -> int:
    return (
        db.query(Membership)
        .filter(Membership.tenant_id == tenant_id, func.lower(Membership.role) == "owner")
        .count()
    )


def _active_accountant_invite_count(
    db: Session,
    tenant_id: str,
    now: datetime,
    *,
    exclude_invite_id: str | None = None,
) -> int:
    query = (
        db.query(UserInvite)
        .filter(
            UserInvite.tenant_id == tenant_id,
            func.lower(UserInvite.role) == "accountant",
            UserInvite.accepted_at.is_(None),
            UserInvite.revoked_at.is_(None),
            UserInvite.expires_at > now,
        )
    )
    if exclude_invite_id:
        query = query.filter(UserInvite.id != exclude_invite_id)
    return query.count()


def _accountant_member_count(db: Session, tenant_id: str, *, exclude_user_id: str | None = None) -> int:
    query = db.query(Membership).filter(
        Membership.tenant_id == tenant_id,
        func.lower(Membership.role) == "accountant",
    )
    if exclude_user_id:
        query = query.filter(Membership.user_id != exclude_user_id)
    return query.count()


def _enforce_accountant_capacity(
    db: Session,
    tenant: Tenant,
    tenant_id: str,
    *,
    now: datetime,
    exclude_user_id: str | None = None,
    exclude_invite_id: str | None = None,
) -> None:
    current_accountants = _accountant_member_count(db, tenant_id, exclude_user_id=exclude_user_id)
    pending_accountant_invites = _active_accountant_invite_count(
        db,
        tenant_id,
        now,
        exclude_invite_id=exclude_invite_id,
    )
    enforce_accountant_limit(tenant, current_accountants + pending_accountant_invites)


def _require_customer_for_client(
    db: Session,
    tenant_id: str,
    role: str,
    customer_id: str | None,
) -> Customer | None:
    if role != "client":
        return None
    if not customer_id:
        raise _invite_error(400, "customer_required", "Client obligatoire pour un compte client.")
    customer = db.get(Customer, customer_id)
    if not customer or customer.tenant_id != tenant_id:
        raise _invite_error(400, "customer_not_found", "Client introuvable.")
    return customer


def _ensure_client_membership(membership: Membership, role: str) -> None:
    if role != "client":
        return
    if (membership.role or "").lower() != "client":
        raise _invite_error(409, "role_conflict", "Utilisateur déjà membre avec un rôle interne.")


def _upsert_client_link(db: Session, tenant_id: str, user_id: str, customer_id: str) -> None:
    link = (
        db.query(CustomerUserLink)
        .filter(
            CustomerUserLink.user_id == user_id,
            CustomerUserLink.tenant_id == tenant_id,
        )
        .first()
    )
    if link:
        if link.customer_id != customer_id:
            link.customer_id = customer_id
            db.add(link)
        return
    db.add(
        CustomerUserLink(
            tenant_id=tenant_id,
            user_id=user_id,
            customer_id=customer_id,
        )
    )


@router.get("")
def list_users(db: Session = Depends(get_db), user: AuthUser = Depends(require_tenant_admin)):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    ensure_active_subscription(tenant, db)
    last_session = (
        db.query(
            AuthSession.user_id.label("user_id"),
            func.max(AuthSession.last_used_at).label("last_login_at"),
        )
        .filter(AuthSession.tenant_id == user.tenant_id, AuthSession.revoked_at.is_(None))
        .group_by(AuthSession.user_id)
        .subquery()
    )
    rows = (
        db.query(User, Membership, last_session.c.last_login_at)
        .join(Membership, Membership.user_id == User.id)
        .outerjoin(last_session, last_session.c.user_id == User.id)
        .filter(Membership.tenant_id == user.tenant_id)
        .order_by(User.email.asc())
        .all()
    )
    return [
        {
            "id": u.id,
            "email": u.email,
            "role": m.role,
            "is_admin": bool(u.is_admin),
            "status": u.status,
            "mfa_enabled": bool(u.mfa_enabled),
            "mfa_enrolled_at": u.mfa_enrolled_at.isoformat() if u.mfa_enrolled_at else None,
            "last_login_at": last_login_at.isoformat() if last_login_at else None,
        }
        for u, m, last_login_at in rows
    ]


@router.patch("/{member_user_id}")
def update_member_role(
    member_user_id: str,
    body: MembershipRoleUpdate,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_tenant_admin),
):
    role = (body.role or "").strip().lower()
    allowed = _allowed_member_roles(admin)
    if role not in allowed:
        raise _invite_error(400, "invalid_role", f"Rôle invalide. Choisir parmi {', '.join(sorted(allowed))}.")
    if member_user_id == admin.id:
        raise _invite_error(400, "self_role_change_forbidden", "Modifiez votre propre rôle depuis un autre compte administrateur.")
    membership = _tenant_membership_or_404(db, tenant_id=admin.tenant_id, user_id=member_user_id)
    previous_role = (membership.role or "").lower()
    if previous_role == "owner":
        raise _invite_error(400, "owner_role_locked", "Le rôle propriétaire ne peut pas être modifié depuis cette page.")
    tenant = db.get(Tenant, admin.tenant_id)
    if role == "accountant" and previous_role != "accountant":
        if not tenant:
            raise HTTPException(404, "Entreprise introuvable")
        _enforce_accountant_capacity(
            db,
            tenant,
            admin.tenant_id,
            now=datetime.now(timezone.utc).replace(tzinfo=None),
            exclude_user_id=member_user_id,
        )
    membership.role = role
    target = db.get(User, member_user_id)
    if target and target.tenant_id == admin.tenant_id:
        target.role = role
        db.add(target)
    db.add(membership)
    safe_log_action(
        db,
        tenant_id=admin.tenant_id,
        actor_user_id=admin.id,
        action_type="member_role_update",
        object_type="membership",
        object_id=membership.id,
        metadata={"target_user_id": member_user_id, "before": previous_role, "after": role},
    )
    db.commit()
    return {"ok": True, "role": role}


@router.delete("/{member_user_id}")
def remove_member_access(
    member_user_id: str,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_tenant_admin),
):
    if member_user_id == admin.id:
        raise _invite_error(400, "self_remove_forbidden", "Vous ne pouvez pas retirer votre propre accès.")
    membership = _tenant_membership_or_404(db, tenant_id=admin.tenant_id, user_id=member_user_id)
    previous_role = (membership.role or "").lower()
    if previous_role == "owner" and _tenant_owner_count(db, admin.tenant_id) <= 1:
        raise _invite_error(400, "last_owner_forbidden", "Impossible de retirer le dernier propriétaire de l'espace.")
    target = db.get(User, member_user_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    remaining_membership = (
        db.query(Membership)
        .filter(Membership.user_id == member_user_id, Membership.tenant_id != admin.tenant_id)
        .order_by(Membership.created_at.asc())
        .first()
    )
    db.query(AuthSession).filter(
        AuthSession.user_id == member_user_id,
        AuthSession.tenant_id == admin.tenant_id,
        AuthSession.revoked_at.is_(None),
    ).update({AuthSession.revoked_at: now}, synchronize_session=False)
    db.delete(membership)
    if target and target.tenant_id == admin.tenant_id:
        target.token_version = int(target.token_version or 0) + 1
        if remaining_membership:
            target.tenant_id = remaining_membership.tenant_id
            target.role = remaining_membership.role
        else:
            target.status = "disabled"
        db.add(target)
    safe_log_action(
        db,
        tenant_id=admin.tenant_id,
        actor_user_id=admin.id,
        action_type="member_access_remove",
        object_type="membership",
        object_id=membership.id,
        metadata={"target_user_id": member_user_id, "role": previous_role},
    )
    db.commit()
    return {"ok": True}


@router.post("/invites")
def create_invite(
    body: UserInviteCreate,
    request: Request,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_tenant_admin),
):
    role = (body.role or "accountant").lower()
    if role == "client" and not getattr(settings, "FEATURE_CLIENT_PORTAL", False):
        raise _invite_error(400, "role_not_enabled", "Le role client n'est pas encore actif.")
    allowed = _allowed_invite_roles(admin)
    if role not in allowed:
        raise _invite_error(400, "invalid_role", f"Rôle invalide. Choisir parmi {', '.join(sorted(allowed))}.")
    customer = _require_customer_for_client(db, admin.tenant_id, role, getattr(body, "customer_id", None))
    tenant = db.get(Tenant, admin.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    ensure_active_subscription(tenant, db)
    require_pro_or_enterprise(tenant)
    _throttle_invites(request, admin)

    norm_email = (body.email or "").strip().lower()
    if not norm_email:
        raise _invite_error(400, "invalid_email", "Email obligatoire.")

    existing_user = db.query(User).filter(func.lower(User.email) == norm_email).first()
    if existing_user:
        membership = (
            db.query(Membership)
            .filter(Membership.user_id == existing_user.id, Membership.tenant_id == admin.tenant_id)
            .first()
        )
        if membership:
            _ensure_client_membership(membership, role)
            changed = False
            if role == "client" and customer:
                _upsert_client_link(db, admin.tenant_id, existing_user.id, customer.id)
                db.commit()
                changed = True
            elif _should_upgrade_role((membership.role or "").lower(), role):
                if role == "accountant" and (membership.role or "").lower() != "accountant":
                    _enforce_accountant_capacity(
                        db,
                        tenant,
                        admin.tenant_id,
                        now=datetime.now(timezone.utc).replace(tzinfo=None),
                        exclude_user_id=existing_user.id,
                    )
                membership.role = role
                db.add(membership)
                db.commit()
                changed = True
            return {
                "ok": True,
                "email_sent": False,
                "delivery": "role_updated" if changed else "already_member",
            }

    smtp_ready = assert_smtp_ready_or_raise("invite")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    stale_invites = (
        db.query(UserInvite)
        .filter(
            UserInvite.tenant_id == admin.tenant_id,
            func.lower(UserInvite.email) == norm_email,
            UserInvite.accepted_at.is_(None),
            UserInvite.revoked_at.is_(None),
        )
        .all()
    )
    for inv in stale_invites:
        inv.revoked_at = now
        db.add(inv)
    db.flush()

    if role == "accountant":
        _enforce_accountant_capacity(db, tenant, admin.tenant_id, now=now)

    active_invites = (
        db.query(UserInvite)
        .filter(
            UserInvite.tenant_id == admin.tenant_id,
            UserInvite.accepted_at.is_(None),
            UserInvite.revoked_at.is_(None),
            UserInvite.expires_at > now,
        )
        .count()
    )
    if active_invites >= INVITE_ACTIVE_LIMIT:
        raise _invite_error(400, "invite_limit_reached", "Limite d'invitations actives atteinte.")

    current_count = db.query(Membership).filter(Membership.tenant_id == admin.tenant_id).count()
    enforce_user_limit(tenant, current_count + active_invites)

    token = secrets.token_urlsafe(32)
    invite = UserInvite(
        tenant_id=admin.tenant_id,
        email=norm_email,
        role=role,
        token_hash=_hash_token(token),
        invited_by_user_id=admin.id,
        expires_at=now + timedelta(hours=INVITE_TOKEN_TTL_HOURS),
        customer_id=customer.id if customer else None,
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)

    base = settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "https://example.com"
    invite_url = f"{base}/app/invite#token={token}"
    should_log = bool(getattr(settings, "INVITE_LOG_LINK", False)) or (not smtp_ready)
    if should_log:
        logger.info("Invite email ready tenant_id=%s email=%s", admin.tenant_id, mask_email(norm_email))

    email_event: EmailEvent | None = None
    try:
        email_event = _record_invite_email_event(
            db,
            tenant_id=admin.tenant_id,
            user_id=admin.id,
            to=norm_email,
            smtp_ready=smtp_ready,
        )
        if smtp_ready:
            send_email(
                norm_email,
                workspace_invitation_subject(tenant.name),
                text="",
                template="invitation.html",
                context={
                    "invite_url": invite_url,
                    "inviter_name": admin.email,
                    "company_name": tenant.name,
                    "expires_in": _expires_label(INVITE_TOKEN_TTL_HOURS),
                    "brand_name": "PixFacture",
                    "product_name": "PixFacture",
                    "heading": "PixFacture · Invitation à rejoindre votre espace",
                    "intro_line": f"{admin.email} vous invite à rejoindre l’espace de facturation {tenant.name} sur PixFacture.",
                    "detail_line": "Vous recevrez l’accès correspondant à votre rôle dans cet espace PixFacture.",
                    "action_label": "Rejoindre l’espace",
                },
                headers={"X-Mailin-custom": f"email_event_id:{email_event.id}"},
            )
            _mark_invite_email_sent(db, email_event)
        else:
            logger.warning("SMTP not configured -> invite email not sent.")
    except Exception as exc:
        logger.error(
            "invite_email_send_failed",
            extra={
                "target_tenant_id": str(admin.tenant_id),
                "recipient": mask_email(norm_email),
                "error_type": type(exc).__name__,
            },
        )
        if email_event:
            _mark_invite_email_failed(db, email_event)
        invite.revoked_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(invite)
        db.commit()
        raise _invite_error(500, "invite_send_failed", "Envoi impossible. Réessayez plus tard.")

    return {
        "ok": True,
        "email_sent": smtp_ready,
        "delivery": "log_only" if not smtp_ready else "smtp",
        "email_event_id": email_event.id if email_event else None,
    }


@router.post("/invite")
def invite_user(
    body: UserInviteCreate,
    request: Request,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_tenant_admin),
):
    return create_invite(body, request, db, admin)


@router.post("/invites/accept")
def accept_invite(body: InviteAccept, db: Session = Depends(get_db)):
    token = (body.token or "").strip()
    if not token:
        raise _invite_error(400, "invalid_token", "Jeton invalide ou expiré.")
    if not (body.password or "").strip():
        raise _invite_error(400, "invalid_password", "Mot de passe obligatoire.")
    token_hash = _hash_token(token)
    invite = (
        db.query(UserInvite)
        .filter(UserInvite.token_hash == token_hash)
        .with_for_update()
        .first()
    )
    if not invite:
        raise _invite_error(400, "invalid_token", "Jeton invalide ou expiré.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if invite.revoked_at:
        raise _invite_error(400, "invite_revoked", "Invitation révoquée.")
    if invite.accepted_at:
        raise _invite_error(400, "invite_used", "Invitation déjà utilisée.")
    if invite.expires_at and invite.expires_at < now:
        raise _invite_error(400, "invite_expired", "Invitation expirée.")

    tenant = db.get(Tenant, invite.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    ensure_active_subscription(tenant, db)
    require_pro_or_enterprise(tenant)
    customer = None
    if invite.role == "client":
        if not invite.customer_id:
            raise _invite_error(400, "customer_required", "Client obligatoire pour un compte client.")
        customer = db.get(Customer, invite.customer_id)
        if not customer or customer.tenant_id != invite.tenant_id:
            raise _invite_error(400, "customer_not_found", "Client introuvable.")

    email_lower = invite.email.lower()
    user = db.query(User).filter(func.lower(User.email) == email_lower).first()
    if user:
        membership = (
            db.query(Membership)
            .filter(Membership.user_id == user.id, Membership.tenant_id == invite.tenant_id)
            .first()
        )
        if membership:
            _ensure_client_membership(membership, invite.role)
            if _should_upgrade_role((membership.role or "").lower(), invite.role):
                if invite.role == "accountant" and (membership.role or "").lower() != "accountant":
                    _enforce_accountant_capacity(
                        db,
                        tenant,
                        invite.tenant_id,
                        now=now,
                        exclude_user_id=user.id,
                        exclude_invite_id=invite.id,
                    )
                membership.role = invite.role
                db.add(membership)
        else:
            had_other_membership = (
                db.query(Membership.id)
                .filter(Membership.user_id == user.id)
                .first()
                is not None
            )
            current_count = db.query(Membership).filter(Membership.tenant_id == invite.tenant_id).count()
            enforce_user_limit(tenant, current_count)
            if invite.role == "accountant":
                _enforce_accountant_capacity(
                    db,
                    tenant,
                    invite.tenant_id,
                    now=now,
                    exclude_invite_id=invite.id,
                )
            db.add(Membership(user_id=user.id, tenant_id=invite.tenant_id, role=invite.role))
            if not had_other_membership:
                # A member removed from their last workspace is deliberately
                # disabled by remove_member_access(). Accepting a fresh,
                # email-bound invitation restores that same account and makes
                # the invited workspace its valid default context again.
                user.tenant_id = invite.tenant_id
                user.role = invite.role
                if (user.status or "active").strip().lower() == "disabled":
                    user.status = "active"
                    user.token_version = int(user.token_version or 0) + 1
        db.add(user)
        invite.accepted_by_user_id = user.id
    else:
        current_count = db.query(Membership).filter(Membership.tenant_id == invite.tenant_id).count()
        enforce_user_limit(tenant, current_count)
        if invite.role == "accountant":
            _enforce_accountant_capacity(
                db,
                tenant,
                invite.tenant_id,
                now=now,
                exclude_invite_id=invite.id,
            )
        user = User(
            tenant_id=invite.tenant_id,
            email=invite.email,
            password_hash=pwd.hash(body.password),
            role=invite.role,
            is_admin=False,
        )
        db.add(user)
        db.flush()
        db.add(Membership(user_id=user.id, tenant_id=invite.tenant_id, role=invite.role))
        invite.accepted_by_user_id = user.id

    if invite.role == "client" and customer:
        _upsert_client_link(db, invite.tenant_id, user.id, customer.id)

    db.delete(invite)
    db.commit()
    return {"ok": True}


@router.post("/invite/accept")
def accept_invite_alias(body: InviteAccept, db: Session = Depends(get_db)):
    return accept_invite(body, db)


@router.post("/invites/revoke")
def revoke_invite(
    body: InviteRevoke,
    db: Session = Depends(get_db),
    admin: AuthUser = Depends(require_tenant_admin),
):
    if not body.invite_id and not body.email:
        raise _invite_error(400, "invalid_request", "invite_id ou email requis.")

    q = db.query(UserInvite).filter(UserInvite.tenant_id == admin.tenant_id)
    if body.invite_id:
        q = q.filter(UserInvite.id == body.invite_id)
    if body.email:
        q = q.filter(func.lower(UserInvite.email) == body.email.lower())

    invites = q.all()
    if not invites:
        raise _invite_error(404, "invite_not_found", "Invitation introuvable.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    revoked = 0
    for inv in invites:
        if inv.accepted_at:
            continue
        if not inv.revoked_at:
            inv.revoked_at = now
            db.add(inv)
            revoked += 1
    db.commit()
    return {"ok": True, "revoked": revoked}
