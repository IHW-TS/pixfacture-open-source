import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..config import settings
from ..models import IntegrationSecret
from .crypto_keyring import decrypt_value, encrypt_value, KeyringError

logger = logging.getLogger(__name__)

SEQINO_ACCESS_TOKEN_KEY = "SEQINO_ACCESS_TOKEN"
SEQINO_SPONSOR_ID_KEY = "SEQINO_SPONSOR_ID"
PISTE_CLIENT_ID_KEY = "PISTE_CLIENT_ID"
PISTE_CLIENT_SECRET_KEY = "PISTE_CLIENT_SECRET"
PISTE_TOKEN_URL_KEY = "PISTE_TOKEN_URL"
CHORUS_API_BASE_KEY = "CHORUS_API_BASE"
CHORUS_CPRO_ACCOUNT_KEY = "CHORUS_CPRO_ACCOUNT"


def get_integration_secret(db: Session, tenant_id: str, secret_key: str) -> str | None:
    if not tenant_id or not secret_key:
        return None
    entry = (
        db.query(IntegrationSecret)
        .filter(IntegrationSecret.tenant_id == tenant_id, IntegrationSecret.secret_key == secret_key)
        .first()
    )
    if not entry:
        return None
    try:
        raw = decrypt_value(entry.encrypted_value, entry.kid)
    except KeyringError:
        logger.warning(
            "Integration secret decrypt failed",
            extra={"tenant_id": tenant_id, "secret_key": secret_key},
        )
        return None
    try:
        return raw.decode("utf-8")
    except Exception:
        return None


def resolve_integration_secret(db: Session, tenant_id: str, secret_key: str, fallback: str | None) -> str | None:
    value = get_integration_secret(db, tenant_id, secret_key)
    if value is not None:
        return value
    return fallback


def upsert_integration_secret(
    db: Session,
    *,
    tenant_id: str,
    secret_key: str,
    secret_value: str | None,
) -> IntegrationSecret | None:
    if not tenant_id or not secret_key:
        raise ValueError("tenant_id et secret_key requis")
    if not secret_value:
        row = (
            db.query(IntegrationSecret)
            .filter(IntegrationSecret.tenant_id == tenant_id, IntegrationSecret.secret_key == secret_key)
            .first()
        )
        if row:
            db.delete(row)
        return None
    kid, encrypted = encrypt_value(secret_value)
    row = (
        db.query(IntegrationSecret)
        .filter(IntegrationSecret.tenant_id == tenant_id, IntegrationSecret.secret_key == secret_key)
        .first()
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if not row:
        row = IntegrationSecret(
            tenant_id=tenant_id,
            secret_key=secret_key,
            encrypted_value=encrypted,
            kid=kid,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.encrypted_value = encrypted
        row.kid = kid
        row.updated_at = now
    return row


def resolve_seqino_credentials(db: Session, tenant_id: str) -> tuple[str | None, str | None]:
    fallback_token = settings.SEQINO_ACCESS_TOKEN or settings.SEQINO_API_KEY
    access_token = resolve_integration_secret(
        db,
        tenant_id,
        SEQINO_ACCESS_TOKEN_KEY,
        fallback_token,
    )
    sponsor_id = resolve_integration_secret(
        db,
        tenant_id,
        SEQINO_SPONSOR_ID_KEY,
        settings.SEQINO_SPONSOR_ID,
    )
    return (access_token or "").strip() or None, (sponsor_id or "").strip() or None


def resolve_chorus_cpro_account(db: Session, tenant_id: str) -> str | None:
    """Resolve the Chorus technical account scoped to one tenant.

    A global fallback is deliberately not used here: a ``cpro-account`` identifies
    the Chorus structure on whose behalf an API call is made. Reusing a process-wide
    value across tenants could submit or inspect a flow in the wrong structure.
    """

    value = get_integration_secret(db, tenant_id, CHORUS_CPRO_ACCOUNT_KEY)
    return (value or "").strip() or None


def enrich_credentials_with_secrets(db: Session, tenant_id: str, creds: dict) -> dict:
    if not tenant_id:
        return creds
    access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id)
    updated = dict(creds)
    if access_token and not updated.get("access_token") and not updated.get("authorization") and not updated.get("seqino_access_token"):
        updated["access_token"] = access_token
    if sponsor_id and not updated.get("sponsor_id") and not updated.get("pdp_sponsor_id") and not updated.get("seqino_sponsor_id"):
        updated["sponsor_id"] = sponsor_id
    piste_client_id = resolve_integration_secret(
        db,
        tenant_id,
        PISTE_CLIENT_ID_KEY,
        settings.PISTE_CLIENT_ID,
    )
    if piste_client_id and not updated.get("piste_client_id") and not updated.get("client_id"):
        updated["piste_client_id"] = piste_client_id
    piste_secret = resolve_integration_secret(
        db,
        tenant_id,
        PISTE_CLIENT_SECRET_KEY,
        settings.PISTE_CLIENT_SECRET,
    )
    if piste_secret and not updated.get("piste_client_secret") and not updated.get("client_secret"):
        updated["piste_client_secret"] = piste_secret
    piste_token_url = resolve_integration_secret(
        db,
        tenant_id,
        PISTE_TOKEN_URL_KEY,
        settings.PISTE_TOKEN_URL,
    )
    if piste_token_url and not updated.get("piste_token_url"):
        updated["piste_token_url"] = piste_token_url
    chorus_api_base = resolve_integration_secret(
        db,
        tenant_id,
        CHORUS_API_BASE_KEY,
        settings.CHORUS_API_BASE,
    )
    if chorus_api_base and not updated.get("chorus_api_base"):
        updated["chorus_api_base"] = chorus_api_base
    cpro_account = resolve_chorus_cpro_account(db, tenant_id)
    if cpro_account:
        # The per-tenant IntegrationSecret is authoritative even when stale
        # connection credentials contain an older technical account.
        updated["chorus_cpro_account"] = cpro_account
    return updated


def rotate_integration_secrets(db: Session, *, dry_run: bool = False) -> int:
    rows = db.query(IntegrationSecret).all()
    updated = 0
    for row in rows:
        if not row.encrypted_value:
            continue
        try:
            raw = decrypt_value(row.encrypted_value, row.kid)
        except KeyringError:
            logger.warning(
                "Integration secret rotation skipped (decrypt failed)",
                extra={"tenant_id": row.tenant_id, "secret_key": row.secret_key},
            )
            continue
        kid, encrypted = encrypt_value(raw)
        updated += 1
        if not dry_run:
            row.encrypted_value = encrypted
            row.kid = kid
            row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    return updated
