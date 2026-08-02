from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..core.plans import Plan
from ..models import IntegrationSecret, PdpConnection, Tenant
from .action_logs import log_action
from .chorus import ChorusClient, chorus_cpro_account_is_valid
from .integration_secrets import (
    CHORUS_CPRO_ACCOUNT_KEY,
    resolve_chorus_cpro_account,
    upsert_integration_secret,
)
from .product_capabilities import normalize_plan


_SIRET_RE = re.compile(r"^[0-9]{14}$")
_ACTIVE_SUBSCRIPTION_STATUS = "active"
_ELIGIBLE_PLANS = frozenset({Plan.PRO, Plan.ENTERPRISE})


class ChorusTenantMigrationError(RuntimeError):
    """Expected, redacted failure from the one-shot Chorus migration."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ChorusTenantMigrationResult:
    tenant_slug: str
    applied: bool
    changed: bool
    structure_count: int
    rebind_required: bool

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "ok": True,
            "mode": "apply" if self.applied else "dry-run",
            "tenant_slug": self.tenant_slug,
            "verified": True,
            "changed": self.changed,
            "status": "verified",
            "structure_count": self.structure_count,
            "rebind_required": self.rebind_required,
        }


def _fail(code: str, message: str) -> ChorusTenantMigrationError:
    return ChorusTenantMigrationError(code, message)


def _load_exact_tenant(
    db: Session,
    tenant_slug: str,
    expected_tenant_id: str,
    *,
    for_update: bool = False,
) -> Tenant:
    normalized_slug = (tenant_slug or "").strip()
    normalized_id = (expected_tenant_id or "").strip()
    if not normalized_slug or not normalized_id:
        raise _fail(
            "tenant_identity_required",
            "Le slug et l'identifiant exacts du tenant sont requis.",
        )
    query = db.query(Tenant).filter(
        Tenant.tenant_slug == normalized_slug,
        Tenant.id == normalized_id,
        Tenant.deleted_at.is_(None),
    )
    if for_update:
        query = query.populate_existing().with_for_update()
    tenants = query.limit(2).all()
    if len(tenants) != 1:
        raise _fail(
            "tenant_identity_mismatch",
            "Le slug et l'identifiant ne désignent pas le même tenant interne.",
        )
    return tenants[0]


def _load_chorus_connections(
    db: Session,
    tenant_id: str,
    *,
    for_update: bool = False,
) -> list[PdpConnection]:
    query = db.query(PdpConnection).filter(
        PdpConnection.tenant_id == tenant_id,
        PdpConnection.provider_slug.in_({"chorus", "choruspro"}),
    )
    if for_update:
        query = query.populate_existing().with_for_update()
    return query.order_by(PdpConnection.updated_at.desc(), PdpConnection.id.asc()).all()


def _validate_current_siret(value: str | None, *, field_name: str) -> str | None:
    if value is None:
        return None
    if not _SIRET_RE.fullmatch(value):
        raise _fail(
            "tenant_identity_invalid",
            f"Migration refusée : {field_name} doit être absent ou contenir exactement 14 chiffres.",
        )
    return value


def _validate_tenant_state(
    tenant: Tenant,
    *,
    expected_current_siret: str | None,
) -> None:
    if normalize_plan(tenant.plan) not in _ELIGIBLE_PLANS:
        raise _fail(
            "active_pro_required",
            "Migration refusée : un tenant Pro ou Enterprise actif est requis.",
        )
    if (tenant.subscription_status or "").strip().lower() != _ACTIVE_SUBSCRIPTION_STATUS:
        raise _fail(
            "active_pro_required",
            "Migration refusée : un tenant Pro ou Enterprise actif est requis.",
        )
    current_siret = (tenant.siret or "").strip() or None
    if current_siret != expected_current_siret:
        raise _fail(
            "tenant_identity_changed",
            "Migration refusée : le SIRET courant du tenant ne correspond plus à la confirmation opérateur.",
        )


def _ensure_tenant_secret_is_compatible(
    db: Session,
    *,
    tenant_id: str,
    source_account: str,
    for_update: bool = False,
) -> None:
    query = db.query(IntegrationSecret).filter(
        IntegrationSecret.tenant_id == tenant_id,
        IntegrationSecret.secret_key == CHORUS_CPRO_ACCOUNT_KEY,
    )
    if for_update:
        query = query.populate_existing().with_for_update()
    secret_row = query.one_or_none()
    if secret_row is None:
        return
    tenant_account = resolve_chorus_cpro_account(db, tenant_id)
    if not tenant_account or not secrets.compare_digest(tenant_account, source_account):
        raise _fail(
            "tenant_secret_conflict",
            "Migration refusée : ce tenant possède déjà un autre compte technique Chorus.",
        )


def _binding_requires_confirmation(
    *,
    current_siret: str | None,
    target_siret: str,
    target_structure_id: str,
    connections: list[PdpConnection],
) -> bool:
    if current_siret is not None and current_siret != target_siret:
        return True
    return any(
        (connection.status or "").strip().lower() == "connected"
        or connection.encrypted_credentials is not None
        or bool(connection.verified_siret and connection.verified_siret != target_siret)
        or bool(connection.verified_structure_id and str(connection.verified_structure_id) != target_structure_id)
        for connection in connections
    )


def _rebind_confirmation_is_valid(
    *,
    tenant_id: str,
    current_siret: str | None,
    target_siret: str,
    provided: str | None,
) -> bool:
    expected = f"{tenant_id}:{current_siret or 'none'}:{target_siret}"
    return bool(provided and secrets.compare_digest(provided, expected))


def _current_state_is_target(
    db: Session,
    *,
    tenant: Tenant,
    siret: str,
    structure_id: str,
    source_account: str,
    connections: list[PdpConnection],
) -> bool:
    tenant_id = tenant.id
    if not tenant_id:
        return False
    canonical = next((row for row in connections if row.provider_slug == "choruspro"), None)
    if canonical is None:
        return False
    if any(
        row is not canonical
        and (
            row.status != "revoked"
            or row.encrypted_credentials is not None
            or row.verified_siret is not None
            or row.verified_structure_id is not None
            or row.verified_at is not None
        )
        for row in connections
    ):
        return False
    tenant_account = resolve_chorus_cpro_account(db, tenant_id)
    secret_matches = bool(tenant_account and secrets.compare_digest(tenant_account, source_account))
    return bool(
        secret_matches
        and tenant.siret == siret
        and canonical.auth_type == "oauth"
        and canonical.encrypted_credentials is None
        and canonical.status == "verified"
        and canonical.verified_siret == siret
        and canonical.verified_structure_id == structure_id
        and canonical.verified_at is not None
    )


def _apply_verified_binding(
    db: Session,
    *,
    tenant: Tenant,
    siret: str,
    structure_id: str,
    source_account: str,
    connections: list[PdpConnection],
) -> PdpConnection:
    tenant_id = tenant.id
    if not tenant_id:
        raise RuntimeError("Tenant Chorus sans identifiant persistant.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    canonical = next((row for row in connections if row.provider_slug == "choruspro"), None)
    if canonical is None:
        canonical = next((row for row in connections if row.provider_slug == "chorus"), None)
    if canonical is None:
        canonical = PdpConnection(
            tenant_id=tenant_id,
            provider_slug="choruspro",
            auth_type="oauth",
            status="verified",
            created_at=now,
            updated_at=now,
        )

    for connection in connections:
        if connection is canonical:
            continue
        connection.status = "revoked"
        connection.encrypted_credentials = None
        connection.verified_siret = None
        connection.verified_structure_id = None
        connection.verified_at = None
        connection.updated_at = now
        db.add(connection)

    tenant.siret = siret
    db.add(tenant)
    upsert_integration_secret(
        db,
        tenant_id=tenant_id,
        secret_key=CHORUS_CPRO_ACCOUNT_KEY,
        secret_value=source_account,
    )

    canonical.provider_slug = "choruspro"
    canonical.auth_type = "oauth"
    canonical.encrypted_credentials = None
    # This command only qualifies the tenant account. It never enables the
    # connected/transmission mode, including when it replaces a legacy row.
    canonical.status = "verified"
    canonical.verified_siret = siret
    canonical.verified_structure_id = structure_id
    canonical.verified_at = now
    canonical.updated_at = now
    db.add(canonical)
    db.flush()
    connection_id = canonical.id
    if not connection_id:
        raise RuntimeError("Connexion Chorus sans identifiant persistant.")
    log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=None,
        action_type="chorus_cpro_account_migrated_verified",
        object_type="pdp_connection",
        object_id=connection_id,
        metadata={
            "provider_slug": "choruspro",
            "status": "verified",
            "source": "global_env_migration",
        },
    )
    return canonical


async def migrate_global_chorus_account_to_tenant(
    db: Session,
    *,
    tenant_slug: str,
    expected_tenant_id: str,
    expected_current_siret: str | None,
    siret: str,
    apply: bool = False,
    rebind_confirmation: str | None = None,
) -> ChorusTenantMigrationResult:
    """Verify then optionally migrate the legacy global Chorus account.

    The global value is used only as the explicit source of this one-shot
    operation. Runtime resolution remains tenant-only. The sole provider call
    is ``get_account_attachment_summary``; no connection is activated and no
    invoice can be transmitted from this function.
    """

    if settings.EINVOICING_EXPORT_ONLY is not True:
        raise _fail(
            "export_only_required",
            "Migration refusée : EINVOICING_EXPORT_ONLY doit être activé.",
        )
    if not _SIRET_RE.fullmatch(siret or ""):
        raise _fail(
            "siret_invalid",
            "Migration refusée : le SIRET doit contenir exactement 14 chiffres.",
        )
    expected_current_siret = _validate_current_siret(
        expected_current_siret,
        field_name="le SIRET courant attendu",
    )

    with db.no_autoflush:
        tenant = _load_exact_tenant(db, tenant_slug, expected_tenant_id)
        _validate_tenant_state(tenant, expected_current_siret=expected_current_siret)

        source_account = (settings.CHORUS_CPRO_ACCOUNT or "").strip()
        if not chorus_cpro_account_is_valid(source_account):
            raise _fail(
                "global_cpro_account_invalid",
                "Migration refusée : le compte technique Chorus global est absent ou invalide.",
            )
        tenant_id = tenant.id
        if not tenant_id:
            raise _fail("tenant_identity_mismatch", "Le tenant interne demandé est introuvable.")
        _ensure_tenant_secret_is_compatible(
            db,
            tenant_id=tenant_id,
            source_account=source_account,
        )

        client = ChorusClient(
            client_id=settings.PISTE_CLIENT_ID,
            client_secret=settings.PISTE_CLIENT_SECRET,
            token_url=settings.PISTE_TOKEN_URL,
            api_base=settings.CHORUS_API_BASE,
            cpro_account=source_account,
        )
        try:
            summary = await client.get_account_attachment_summary(expected_siret=siret)
        except Exception:
            raise _fail(
                "chorus_verification_failed",
                "Migration refusée : la vérification en lecture seule Chorus a échoué.",
            ) from None

        structure_id_value = summary.get("matched_structure_id") if isinstance(summary, dict) else None
        structure_id = str(structure_id_value).strip() if structure_id_value is not None else ""
        if not isinstance(summary, dict) or summary.get("expected_siret_attached") is not True or not structure_id:
            raise _fail(
                "siret_not_attached",
                "Migration refusée : le SIRET n'est pas rattaché au compte technique Chorus.",
            )
        try:
            structure_count = max(0, int(summary.get("structure_count") or 0))
        except (TypeError, ValueError):
            structure_count = 0

        connections = _load_chorus_connections(db, tenant_id)
        rebind_required = _binding_requires_confirmation(
            current_siret=expected_current_siret,
            target_siret=siret,
            target_structure_id=structure_id,
            connections=connections,
        )
        if (
            apply
            and rebind_required
            and not _rebind_confirmation_is_valid(
                tenant_id=tenant_id,
                current_siret=expected_current_siret,
                target_siret=siret,
                provided=rebind_confirmation,
            )
        ):
            raise _fail(
                "rebind_confirmation_required",
                "Migration refusée : le remplacement du binding existant exige une confirmation explicite.",
            )
        already_applied = _current_state_is_target(
            db,
            tenant=tenant,
            siret=siret,
            structure_id=structure_id,
            source_account=source_account,
            connections=connections,
        )

    changed = not already_applied
    if apply:
        # The provider check may take several seconds. Reload and lock the
        # identity/binding rows so a concurrent plan, profile or connector
        # update cannot be overwritten from the stale preflight snapshot.
        with db.no_autoflush:
            tenant = _load_exact_tenant(
                db,
                tenant_slug,
                expected_tenant_id,
                for_update=True,
            )
            _validate_tenant_state(tenant, expected_current_siret=expected_current_siret)
            tenant_id = tenant.id
            if not tenant_id:
                raise _fail("tenant_identity_mismatch", "Le tenant interne demandé est introuvable.")
            current_source = (settings.CHORUS_CPRO_ACCOUNT or "").strip()
            if not current_source or not secrets.compare_digest(current_source, source_account):
                raise _fail(
                    "global_cpro_account_changed",
                    "Migration refusée : la source Chorus a changé pendant la vérification.",
                )
            _ensure_tenant_secret_is_compatible(
                db,
                tenant_id=tenant_id,
                source_account=source_account,
                for_update=True,
            )
            connections = _load_chorus_connections(db, tenant_id, for_update=True)
            rebind_required = _binding_requires_confirmation(
                current_siret=expected_current_siret,
                target_siret=siret,
                target_structure_id=structure_id,
                connections=connections,
            )
            if rebind_required and not _rebind_confirmation_is_valid(
                tenant_id=tenant_id,
                current_siret=expected_current_siret,
                target_siret=siret,
                provided=rebind_confirmation,
            ):
                raise _fail(
                    "rebind_confirmation_required",
                    "Migration refusée : le remplacement du binding existant exige une confirmation explicite.",
                )
            already_applied = _current_state_is_target(
                db,
                tenant=tenant,
                siret=siret,
                structure_id=structure_id,
                source_account=source_account,
                connections=connections,
            )
            changed = not already_applied

    if apply and changed:
        try:
            _apply_verified_binding(
                db,
                tenant=tenant,
                siret=siret,
                structure_id=structure_id,
                source_account=source_account,
                connections=connections,
            )
        except Exception:
            db.rollback()
            raise _fail(
                "migration_apply_failed",
                "Migration refusée : l'écriture atomique du binding Chorus a échoué.",
            ) from None

    return ChorusTenantMigrationResult(
        tenant_slug=tenant.tenant_slug,
        applied=apply,
        changed=changed,
        structure_count=structure_count,
        rebind_required=rebind_required,
    )
