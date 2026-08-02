from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from uuid import uuid4

import jwt
from email_validator import EmailNotValidError, validate_email
from jwt.exceptions import InvalidTokenError
from sqlalchemy.orm import Session

from ..config import settings
from ..models import DemoInvitation


DEMO_INVITATION_TOKEN_TYPE = "demo_invitation"
DEMO_INVITATION_DEFAULT_TTL_HOURS = 72
DEMO_INVITATION_MAX_TTL_HOURS = 24 * 30
DEMO_INVITATION_PRESETS = frozenset(
    {"services", "retail", "construction", "public_sector", "health"}
)


class DemoInvitationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class IssuedDemoInvitation:
    invitation: DemoInvitation
    token: str
    registration_url: str


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _normalize_email(value: str) -> str:
    try:
        result = validate_email((value or "").strip(), check_deliverability=False)
    except EmailNotValidError as exc:
        raise DemoInvitationError("demo_invitation_email_invalid", "Adresse e-mail invalide.") from exc
    return result.normalized.lower()


def _normalize_preset(value: str | None) -> str:
    preset = (value or "services").strip().lower() or "services"
    if preset not in DEMO_INVITATION_PRESETS:
        raise DemoInvitationError("demo_invitation_preset_invalid", "Scénario de démo invalide.")
    return preset


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _registration_base_url() -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
    if not base:
        raise DemoInvitationError(
            "demo_invitation_public_url_missing",
            "URL publique de l'application non configurée.",
        )
    return base


def build_demo_registration_url(token: str) -> str:
    # A fragment is intentionally used so the bearer token is not sent in HTTP
    # access logs or Referer headers when the prospect opens the registration page.
    fragment = urlencode({"demo_invitation": token})
    return f"{_registration_base_url()}/app/register#{fragment}"


def create_demo_invitation(
    db: Session,
    *,
    email: str,
    preset: str = "services",
    ttl_hours: int = DEMO_INVITATION_DEFAULT_TTL_HOURS,
    created_by_user_id: str | None = None,
    now: datetime | None = None,
) -> IssuedDemoInvitation:
    normalized_email = _normalize_email(email)
    normalized_preset = _normalize_preset(preset)
    try:
        normalized_ttl = int(ttl_hours)
    except (TypeError, ValueError) as exc:
        raise DemoInvitationError("demo_invitation_ttl_invalid", "Durée d'invitation invalide.") from exc
    if normalized_ttl < 1 or normalized_ttl > DEMO_INVITATION_MAX_TTL_HOURS:
        raise DemoInvitationError(
            "demo_invitation_ttl_invalid",
            "La durée d'invitation doit être comprise entre 1 heure et 30 jours.",
        )

    issued_at = now or _utcnow()
    expires_at = issued_at + timedelta(hours=normalized_ttl)
    invitation_id = str(uuid4())
    claims = {
        "type": DEMO_INVITATION_TOKEN_TYPE,
        "jti": invitation_id,
        "email": normalized_email,
        "preset": normalized_preset,
        "iat": int(issued_at.replace(tzinfo=timezone.utc).timestamp()),
        "exp": int(expires_at.replace(tzinfo=timezone.utc).timestamp()),
    }
    token = jwt.encode(claims, settings.SECRET_KEY, algorithm="HS256")

    # A newly issued invitation replaces any still-active invitation for the
    # same prospect. Previously shared links immediately stop working.
    (
        db.query(DemoInvitation)
        .filter(
            DemoInvitation.email == normalized_email,
            DemoInvitation.consumed_at.is_(None),
            DemoInvitation.revoked_at.is_(None),
            DemoInvitation.expires_at > issued_at,
        )
        .update({DemoInvitation.revoked_at: issued_at}, synchronize_session=False)
    )
    invitation = DemoInvitation(
        id=invitation_id,
        email=normalized_email,
        preset=normalized_preset,
        token_hash=_token_hash(token),
        created_by_user_id=created_by_user_id,
        created_at=issued_at,
        expires_at=expires_at,
    )
    db.add(invitation)
    db.flush()
    return IssuedDemoInvitation(
        invitation=invitation,
        token=token,
        registration_url=build_demo_registration_url(token),
    )


def _invalid_invitation() -> DemoInvitationError:
    return DemoInvitationError(
        "demo_invitation_invalid",
        "Invitation de démo invalide ou expirée. Demandez un nouveau lien.",
    )


def inspect_demo_invitation(
    db: Session,
    token: str,
    *,
    lock_for_update: bool = False,
    now: datetime | None = None,
) -> DemoInvitation:
    raw_token = (token or "").strip()
    if not raw_token:
        raise _invalid_invitation()
    try:
        claims = jwt.decode(
            raw_token,
            settings.SECRET_KEY,
            algorithms=["HS256"],
            options={"require": ["type", "jti", "email", "preset", "iat", "exp"]},
        )
    except InvalidTokenError as exc:
        raise _invalid_invitation() from exc
    if claims.get("type") != DEMO_INVITATION_TOKEN_TYPE:
        raise _invalid_invitation()

    invitation_id = str(claims.get("jti") or "").strip()
    if not invitation_id:
        raise _invalid_invitation()
    query = db.query(DemoInvitation).filter(DemoInvitation.id == invitation_id)
    if lock_for_update:
        query = query.with_for_update()
    invitation = query.populate_existing().one_or_none()
    if invitation is None:
        raise _invalid_invitation()

    expected_hash = _token_hash(raw_token)
    if not secrets.compare_digest(str(invitation.token_hash or ""), expected_hash):
        raise _invalid_invitation()
    if invitation.email != str(claims.get("email") or "").strip().lower():
        raise _invalid_invitation()
    if invitation.preset != str(claims.get("preset") or "").strip().lower():
        raise _invalid_invitation()

    checked_at = now or _utcnow()
    if invitation.expires_at <= checked_at or invitation.revoked_at is not None:
        raise _invalid_invitation()
    if invitation.consumed_at is not None:
        raise DemoInvitationError(
            "demo_invitation_consumed",
            "Cette invitation de démo a déjà été utilisée. Demandez un nouveau lien.",
        )
    return invitation


def consume_demo_invitation(
    db: Session,
    *,
    token: str,
    email: str,
    consumed_by_user_id: str,
    now: datetime | None = None,
) -> DemoInvitation:
    invitation = inspect_demo_invitation(db, token, lock_for_update=True, now=now)
    normalized_email = _normalize_email(email)
    if not secrets.compare_digest(invitation.email, normalized_email):
        raise DemoInvitationError(
            "demo_invitation_email_mismatch",
            "Cette invitation est liée à une autre adresse e-mail.",
        )
    invitation.consumed_at = now or _utcnow()
    invitation.consumed_by_user_id = consumed_by_user_id
    db.add(invitation)
    return invitation
