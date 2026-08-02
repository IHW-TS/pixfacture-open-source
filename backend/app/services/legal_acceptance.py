import logging
import re
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..legal_documents import PUBLIC_PRO_TRIAL_TERMS_VERSION, is_adopted_legal_document
from ..models import LegalAcceptance

logger = logging.getLogger("legal.acceptance")

LEGAL_DOC_URLS = {
    "terms": "/legal/terms",
    "dpa": "/legal/dpa",
}

# Guard rail: keep a single hub for CGV/CGU acceptance.
if LEGAL_DOC_URLS.get("terms") != "/legal/terms":
    raise RuntimeError("LEGAL_DOC_URLS['terms'] doit pointer vers /legal/terms.")

LEGAL_DOC_SLUGS = set(LEGAL_DOC_URLS.keys())
DPA_ACCEPTOR_ROLES = frozenset({"owner", "admin"})
ACCEPTANCE_SCOPE_USER = "user"
ACCEPTANCE_SCOPE_TENANT = "tenant"
AUTHORITY_USER_SELF = "user_self"
AUTHORITY_TENANT_ROLE = "tenant_role"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _is_strict_env() -> bool:
    env = (settings.APP_ENV or "").strip().lower()
    return env in {"prod", "production", "staging"} or (
        env == "test" and bool(getattr(settings, "LEGAL_ACCEPTANCE_TEST_MODE", False))
    )


def _normalize_version(value: str | None) -> str:
    return (value or "").strip()


def _normalize_slug(value: str | None) -> str:
    return (value or "").strip().lower()


def normalize_tenant_role(value: str | None) -> str:
    return (value or "").strip().lower()


def get_doc_version(slug: str) -> str | None:
    normalized = _normalize_slug(slug)
    if normalized == "terms":
        return _normalize_version(settings.NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS)
    if normalized == "dpa":
        return _normalize_version(settings.NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA)
    return None


def get_doc_sha256(slug: str) -> str | None:
    """Return the configured lowercase SHA-256 only when it is well formed."""

    normalized = _normalize_slug(slug)
    if normalized == "terms":
        raw = settings.LEGAL_DOC_SHA256_TERMS
    elif normalized == "dpa":
        raw = settings.LEGAL_DOC_SHA256_DPA
    else:
        return None
    value = (raw or "").strip().lower()
    if not _SHA256_RE.fullmatch(value):
        return None
    env = (settings.APP_ENV or "").strip().lower()
    registry_required = env in {"prod", "production", "staging"} and not bool(
        getattr(settings, "LEGAL_ACCEPTANCE_TEST_MODE", False)
    )
    if registry_required and not is_adopted_legal_document(
        normalized,
        get_doc_version(normalized),
        value,
    ):
        logger.error("legal_acceptance_%s_unadopted_version_or_hash", normalized)
        return None
    return value


def public_signup_legal_readiness() -> tuple[bool, str | None]:
    """Fail closed when public signup and the adopted terms describe different trials."""

    env = (settings.APP_ENV or "").strip().lower()
    if env not in {"prod", "production", "staging"} or bool(
        getattr(settings, "LEGAL_ACCEPTANCE_TEST_MODE", False)
    ):
        return True, None
    message = (
        "Les inscriptions sont temporairement suspendues pendant la mise à jour "
        "de nos documents contractuels. Réessayez prochainement ou contactez le support."
    )
    if not bool(getattr(settings, "LEGAL_TERMS_ACCEPTANCE_REQUIRED", False)) or not bool(
        getattr(settings, "LEGAL_DPA_ACCEPTANCE_REQUIRED", False)
    ):
        return False, message
    terms_version = get_doc_version("terms")
    terms_hash = get_doc_sha256("terms")
    dpa_version = get_doc_version("dpa")
    dpa_hash = get_doc_sha256("dpa")
    if (
        terms_version != PUBLIC_PRO_TRIAL_TERMS_VERSION
        or not terms_hash
        or not dpa_version
        or not dpa_hash
    ):
        return False, message
    return True, None


def acceptance_scope_for_slug(slug: str) -> str:
    normalized = _normalize_slug(slug)
    if normalized not in LEGAL_DOC_SLUGS:
        raise ValueError(f"Document légal inconnu: {normalized or '<vide>'}.")
    return ACCEPTANCE_SCOPE_TENANT if normalized == "dpa" else ACCEPTANCE_SCOPE_USER


def build_acceptance_snapshot(*, slug: str, accepted_role: str) -> dict[str, str]:
    """Freeze the actor authority and the exact document at acceptance time."""

    normalized_slug = _normalize_slug(slug)
    role = normalize_tenant_role(accepted_role)
    if not role:
        raise ValueError("Le rôle tenant de l'acteur est requis pour enregistrer l'acceptation.")
    if normalized_slug == "dpa" and role not in DPA_ACCEPTOR_ROLES:
        raise ValueError("Le DPA requiert un rôle tenant owner ou admin.")
    document_sha256 = get_doc_sha256(normalized_slug)
    if not document_sha256:
        raise RuntimeError(
            f"Empreinte SHA-256 du document {normalized_slug or '<inconnu>'} absente ou invalide."
        )
    is_dpa = normalized_slug == "dpa"
    return {
        "acceptance_scope": ACCEPTANCE_SCOPE_TENANT if is_dpa else ACCEPTANCE_SCOPE_USER,
        "accepted_role": role,
        "authority_basis": AUTHORITY_TENANT_ROLE if is_dpa else AUTHORITY_USER_SELF,
        "document_sha256": document_sha256,
    }


def _missing_required_doc_config(slug: str, field_name: str) -> None:
    message = f"LEGAL_{slug.upper()}_ACCEPTANCE_REQUIRED=true sans {field_name}."
    if _is_strict_env():
        raise RuntimeError(message)
    logger.warning("legal_acceptance_%s_missing_%s", slug, field_name)


def resolve_required_docs() -> list[dict[str, Any]]:
    docs: list[dict[str, Any]] = []
    required_flags = (
        ("terms", bool(getattr(settings, "LEGAL_TERMS_ACCEPTANCE_REQUIRED", False))),
        ("dpa", bool(getattr(settings, "LEGAL_DPA_ACCEPTANCE_REQUIRED", False))),
    )
    for slug, required in required_flags:
        if not required:
            continue
        version = get_doc_version(slug)
        document_sha256 = get_doc_sha256(slug)
        if not version:
            _missing_required_doc_config(slug, "version documentaire")
            continue
        if not document_sha256:
            _missing_required_doc_config(slug, "empreinte SHA-256 documentaire valide")
            continue
        docs.append(
            {
                "slug": slug,
                "version": version,
                "url": LEGAL_DOC_URLS[slug],
                "document_sha256": document_sha256,
            }
        )
    return docs


def should_enforce_acceptance() -> bool:
    enabled = bool(getattr(settings, "LEGAL_TERMS_ACCEPTANCE_REQUIRED", False)) or bool(
        getattr(settings, "LEGAL_DPA_ACCEPTANCE_REQUIRED", False)
    )
    return enabled and _is_strict_env()


def required_docs_for_ui() -> list[dict[str, Any]]:
    if not should_enforce_acceptance():
        return []
    return resolve_required_docs()


def _row_matches_current_document(row: LegalAcceptance) -> bool:
    """Validate a stored proof without consulting the actor's current role.

    Rows created before the authority snapshot/hash migration intentionally do
    not count. They remain stored as historical evidence and the new uniqueness
    key allows a fresh acceptance for the same slug/version.
    """

    slug = _normalize_slug(row.doc_slug)
    expected_hash = get_doc_sha256(slug)
    stored_hash = (row.document_sha256 or "").strip().lower()
    if not expected_hash or stored_hash != expected_hash:
        return False
    role = normalize_tenant_role(row.accepted_role)
    if slug == "dpa":
        return (
            row.acceptance_scope == ACCEPTANCE_SCOPE_TENANT
            and row.authority_basis == AUTHORITY_TENANT_ROLE
            and role in DPA_ACCEPTOR_ROLES
        )
    return (
        slug in LEGAL_DOC_SLUGS
        and row.acceptance_scope == ACCEPTANCE_SCOPE_USER
        and row.authority_basis == AUTHORITY_USER_SELF
        and bool(role)
    )


def accepted_rows_for_user(
    db: Session,
    *,
    tenant_id: str,
    user_id: str,
    slugs: list[str],
) -> list[LegalAcceptance]:
    """Resolve user-scoped terms and tenant-scoped DPA from frozen proofs."""

    normalized_slugs = {_normalize_slug(slug) for slug in slugs} & LEGAL_DOC_SLUGS
    if not normalized_slugs:
        return []
    rows = (
        db.query(LegalAcceptance)
        .filter(
            LegalAcceptance.tenant_id == tenant_id,
            LegalAcceptance.doc_slug.in_(normalized_slugs),
        )
        .all()
    )
    return [
        row
        for row in rows
        if _row_matches_current_document(row)
        and (row.doc_slug == "dpa" or str(row.user_id) == str(user_id))
    ]


def accepted_rows_for_tenant(
    db: Session,
    *,
    tenant_id: str,
    slugs: list[str],
) -> list[LegalAcceptance]:
    """Return proofs made by a tenant representative at acceptance time."""

    normalized_slugs = {_normalize_slug(slug) for slug in slugs} & LEGAL_DOC_SLUGS
    if not normalized_slugs:
        return []
    rows = (
        db.query(LegalAcceptance)
        .filter(
            LegalAcceptance.tenant_id == tenant_id,
            LegalAcceptance.doc_slug.in_(normalized_slugs),
        )
        .all()
    )
    return [
        row
        for row in rows
        if _row_matches_current_document(row)
        and normalize_tenant_role(row.accepted_role) in DPA_ACCEPTOR_ROLES
    ]
