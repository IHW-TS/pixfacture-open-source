from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_viewer_or_admin
from ..models import LegalAcceptance
from ..services.legal_acceptance import (
    DPA_ACCEPTOR_ROLES,
    LEGAL_DOC_SLUGS,
    accepted_rows_for_user,
    build_acceptance_snapshot,
    get_doc_sha256,
    get_doc_version,
    normalize_tenant_role,
    public_signup_legal_readiness,
    required_docs_for_ui,
)


router = APIRouter(prefix="/api/legal", tags=["legal"])


class LegalAcceptPayload(BaseModel):
    slug: str
    version: str


def _normalize_slug(slug: str) -> str:
    return (slug or "").strip().lower()


@router.get("/required")
def legal_required(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    required = required_docs_for_ui()
    if not required:
        return {"required": [], "alreadyAccepted": []}
    slugs = [doc["slug"] for doc in required]
    accepted_rows = accepted_rows_for_user(
        db,
        tenant_id=user.tenant_id,
        user_id=user.id,
        slugs=slugs,
    )
    accepted_lookup: dict[tuple[str, str, str], LegalAcceptance] = {}
    for row in accepted_rows:
        accepted_lookup.setdefault(
            (
                str(row.doc_slug or ""),
                str(row.doc_version or ""),
                str(row.document_sha256 or ""),
            ),
            row,
        )
    already = []
    annotated_required = []
    can_accept_dpa = normalize_tenant_role(user.role) in DPA_ACCEPTOR_ROLES
    for raw_doc in required:
        doc = dict(raw_doc)
        doc["acceptance_scope"] = "tenant" if doc["slug"] == "dpa" else "user"
        doc["can_accept"] = can_accept_dpa if doc["slug"] == "dpa" else True
        annotated_required.append(doc)
        accepted_row = accepted_lookup.get(
            (doc["slug"], doc["version"], doc["document_sha256"])
        )
        if accepted_row:
            already.append(
                {
                    "slug": doc["slug"],
                    "version": doc["version"],
                    "accepted_at": (
                        accepted_row.accepted_at.isoformat()
                        if accepted_row.accepted_at
                        else None
                    ),
                    "acceptance_scope": doc["acceptance_scope"],
                    "document_sha256": accepted_row.document_sha256,
                }
            )
    return {"required": annotated_required, "alreadyAccepted": already}


@router.get("/public-required")
def legal_public_required(response: Response):
    """Expose only current required legal document versions for unauthenticated signup."""
    # Readiness changes atomically when a legal document is adopted. Never let
    # a browser, proxy or CDN retain the previous open/closed signup state.
    response.headers["Cache-Control"] = "no-store"
    signup_ready, message = public_signup_legal_readiness()
    return {
        "required": required_docs_for_ui() if signup_ready else [],
        "signupReady": signup_ready,
        "message": message,
    }


def _find_existing_acceptance(
    db: Session,
    *,
    tenant_id: str,
    user_id: str,
    slug: str,
    version: str,
    document_sha256: str,
) -> LegalAcceptance | None:
    return next(
        (
            row
            for row in accepted_rows_for_user(
                db,
                tenant_id=tenant_id,
                user_id=user_id,
                slugs=[slug],
            )
            if row.doc_version == version
            and (row.document_sha256 or "").strip().lower() == document_sha256
        ),
        None,
    )


@router.post("/accept")
def legal_accept(
    body: LegalAcceptPayload,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    slug = _normalize_slug(body.slug)
    version = (body.version or "").strip()
    if slug not in LEGAL_DOC_SLUGS:
        raise HTTPException(
            status_code=400,
            detail={"code": "legal_slug_invalid", "message": "Document legal inconnu."},
        )
    if not version:
        raise HTTPException(
            status_code=400,
            detail={"code": "legal_version_missing", "message": "Version manquante."},
        )
    current_version = get_doc_version(slug)
    current_hash = get_doc_sha256(slug)
    if not current_version or not current_hash:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "legal_document_unavailable",
                "message": "Ce document légal n'est pas disponible pour acceptation.",
            },
        )
    if version != current_version:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "legal_version_mismatch",
                "message": "Version du document non valide.",
            },
        )
    accepted_role = normalize_tenant_role(user.role)
    if slug == "dpa" and accepted_role not in DPA_ACCEPTOR_ROLES:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "legal_admin_acceptance_required",
                "message": "Le DPA doit être accepté par un propriétaire ou administrateur de l'espace.",
            },
        )
    existing = _find_existing_acceptance(
        db,
        tenant_id=user.tenant_id,
        user_id=user.id,
        slug=slug,
        version=version,
        document_sha256=current_hash,
    )
    if existing:
        return {
            "status": "ok",
            "slug": slug,
            "version": version,
            "accepted_at": existing.accepted_at.isoformat() if existing.accepted_at else None,
        }
    ip = request.client.host if request.client else None
    if not ip:
        forwarded_for = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        ip = forwarded_for or None
    user_agent = request.headers.get("user-agent")
    snapshot = build_acceptance_snapshot(slug=slug, accepted_role=accepted_role)
    acceptance = LegalAcceptance(
        tenant_id=user.tenant_id,
        user_id=user.id,
        doc_slug=slug,
        doc_version=version,
        **snapshot,
        accepted_at=datetime.now(timezone.utc).replace(tzinfo=None),
        ip=ip,
        user_agent=user_agent,
    )
    db.add(acceptance)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = _find_existing_acceptance(
            db,
            tenant_id=user.tenant_id,
            user_id=user.id,
            slug=slug,
            version=version,
            document_sha256=current_hash,
        )
        if existing:
            return {
                "status": "ok",
                "slug": slug,
                "version": version,
                "accepted_at": existing.accepted_at.isoformat() if existing.accepted_at else None,
            }
        raise
    return {
        "status": "ok",
        "slug": slug,
        "version": version,
        "accepted_at": acceptance.accepted_at.isoformat() if acceptance.accepted_at else None,
    }
