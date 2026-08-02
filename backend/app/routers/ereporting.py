import math
from datetime import date
from typing import Any
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import AuthUser, require_active_subscription, require_product_feature
from ..jobs.ereporting import generate_ereporting_reports_job, send_ereporting_job, send_ereporting_reports_job
from ..jobs.queue import enqueue_job
from ..models import EReportingEvent, EReportingLine, EReportingReport
from ..schemas import (
    EReportingEventCreateRequest,
    EReportingEventListResponse,
    EReportingEventOut,
    EReportingEventSendRequest,
    EReportingLineOut,
    EReportingReportDetailResponse,
    EReportingReportGenerateRequest,
    EReportingReportListResponse,
    EReportingReportOut,
)
from ..services.ereporting_export import build_ereporting_export
from ..services.ereporting import ensure_ereporting_allowed, payload_hash_from_fields, resolve_provider_slug
from ..services.pdp.utils import PdpProviderError
from ..services.connected_mode import connected_mode_decision
from ..services.seqino_tokens import ensure_seqino_tokens_available_or_raise
from ..utils.public_errors import sanitize_public_error_message

router = APIRouter(
    prefix="/api/e-reporting",
    tags=["e-reporting"],
    dependencies=[Depends(require_product_feature("einvoicing_enabled"))],
)
export_router = APIRouter(
    prefix="/api/ereporting",
    tags=["e-reporting"],
    dependencies=[Depends(require_product_feature("einvoicing_enabled"))],
)


_PROVIDER_OPERATIONAL_CAPABILITY = {
    "seqino": "seqino_operational",
    "chorus": "chorus_operational",
    "choruspro": "chorus_operational",
}


def _ensure_ereporting_transmission_operational(
    db: Session,
    *,
    tenant_id: str,
    provider_slug: str | None,
) -> None:
    if settings.EINVOICING_EXPORT_ONLY:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "export_only",
                "message": "Mode export uniquement : transmission e-reporting désactivée.",
            },
        )

    normalized_slug = (provider_slug or "").strip().lower()
    capability = _PROVIDER_OPERATIONAL_CAPABILITY.get(normalized_slug)
    if not capability:
        return

    decision = connected_mode_decision(db, tenant_id, normalized_slug)
    if decision.allowed:
        return
    provider_label = {"seqino": "Seqino", "chorus": "Chorus Pro", "choruspro": "Chorus Pro"}.get(
        normalized_slug,
        "la plateforme agréée",
    )

    raise HTTPException(
        status_code=409,
        detail={
            "code": "ereporting_provider_not_operational",
            "provider": normalized_slug,
            "capability": capability,
            "message": (
                f"La connexion à {provider_label} n’est pas opérationnelle pour transmettre l’e-reporting. "
                "Vérifiez sa configuration avant de relancer l'envoi."
            ),
            "remediation_url": "/app/integrations",
        },
    )


def _raise_ereporting_provider_not_operational(provider_slug: str | None, message: Any) -> None:
    normalized_slug = (provider_slug or "").strip().lower() or None
    raise HTTPException(
        status_code=409,
        detail={
            "code": "ereporting_provider_not_operational",
            "provider": normalized_slug,
            "message": sanitize_public_error_message(
                message,
                status_code=409,
                fallback=(
                    "La plateforme agréée n’est pas disponible pour cette transmission. "
                    "Vérifiez sa configuration avant de réessayer."
                ),
            ),
            "remediation_url": "/app/integrations",
        },
    )


@router.post("", response_model=EReportingEventOut)
def create_ereporting_event(
    payload: EReportingEventCreateRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    try:
        ensure_ereporting_allowed(
            client_country=payload.client_country,
            client_type=payload.client_type,
            client_vat_number=payload.client_vat_number,
        )
    except ValueError as exc:
        raise HTTPException(
            400,
            sanitize_public_error_message(
                exc,
                status_code=400,
                fallback="Cet événement ne peut pas être enregistré avec ces informations.",
            ),
        ) from exc

    try:
        provider_slug = resolve_provider_slug(db, user.tenant_id, payload.provider_slug)
    except ValueError as exc:
        raise HTTPException(
            400,
            sanitize_public_error_message(
                exc,
                status_code=400,
                fallback="La plateforme agréée sélectionnée est indisponible.",
            ),
        ) from exc

    event = EReportingEvent(
        tenant_id=user.tenant_id,
        provider_slug=provider_slug,
        type=payload.type,
        amounts=payload.amounts,
        payment_date=payload.payment_date,
        country=payload.country,
        client_country=payload.client_country,
        client_vat_number=payload.client_vat_number,
        client_type=payload.client_type,
        payload_hash=payload_hash_from_fields(
            event_type=payload.type,
            amounts=payload.amounts,
            payment_date=payload.payment_date,
            country=payload.country,
            client_country=payload.client_country,
            client_vat_number=payload.client_vat_number,
            client_type=payload.client_type,
        ),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.get("", response_model=EReportingEventListResponse)
def list_ereporting_events(
    page: int = 1,
    page_size: int = 50,
    status: str | None = None,
    event_type: str | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    page = max(page, 1)
    page_size = max(1, min(page_size, 200))
    query = db.query(EReportingEvent).filter(EReportingEvent.tenant_id == user.tenant_id)
    if status:
        query = query.filter(EReportingEvent.status == status)
    if event_type:
        query = query.filter(EReportingEvent.type == event_type)
    total = query.count()
    items = query.order_by(EReportingEvent.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    pages = math.ceil(total / page_size) if page_size else 1
    return EReportingEventListResponse(items=items, page=page, page_size=page_size, total=total, pages=pages)


@router.post("/send")
def send_ereporting_events(
    payload: EReportingEventSendRequest | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    payload = payload or EReportingEventSendRequest()
    ids: list[str] | None = None
    _ensure_ereporting_transmission_operational(
        db,
        tenant_id=user.tenant_id,
        provider_slug=None,
    )
    try:
        resolved_slug = resolve_provider_slug(db, user.tenant_id, payload.provider_slug)
    except ValueError as exc:
        _raise_ereporting_provider_not_operational(payload.provider_slug, exc)

    if payload.event_ids:
        ids = list({eid for eid in payload.event_ids if eid})
        if ids:
            count = (
                db.query(EReportingEvent.id)
                .filter(EReportingEvent.tenant_id == user.tenant_id, EReportingEvent.id.in_(ids))
                .count()
            )
            if count != len(ids):
                raise HTTPException(404, "Not found")

    provider_slugs = {(resolved_slug or "").strip().lower()} if resolved_slug else set()
    if not resolved_slug:
        provider_query = db.query(EReportingEvent.provider_slug).filter(
            EReportingEvent.tenant_id == user.tenant_id,
            EReportingEvent.provider_slug.is_not(None),
        )
        if ids:
            provider_query = provider_query.filter(EReportingEvent.id.in_(ids))
        else:
            provider_query = provider_query.filter(EReportingEvent.status.in_(("pending", "failed")))
        provider_slugs.update(
            str(provider_slug).strip().lower()
            for (provider_slug,) in provider_query.distinct().all()
            if str(provider_slug or "").strip()
        )

    if not provider_slugs:
        _raise_ereporting_provider_not_operational(
            None,
            "Aucune connexion plateforme agréée active et non ambiguë n'est disponible pour cet envoi e-reporting.",
        )
    for provider_slug in provider_slugs:
        try:
            resolve_provider_slug(db, user.tenant_id, provider_slug)
        except ValueError as exc:
            _raise_ereporting_provider_not_operational(provider_slug, exc)
        _ensure_ereporting_transmission_operational(
            db,
            tenant_id=user.tenant_id,
            provider_slug=provider_slug,
        )
    if "seqino" in provider_slugs:
        try:
            ensure_seqino_tokens_available_or_raise(db, user.tenant_id)
        except PdpProviderError as exc:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": exc.code or "token_balance_insufficient",
                    "message": sanitize_public_error_message(
                        exc,
                        status_code=409,
                        fallback="Vous ne disposez pas d’assez de jetons pour cette transmission.",
                    ),
                    "remediation_url": "/app/billing",
                },
            ) from exc

    job_info = enqueue_job(
        send_ereporting_job,
        tenant_id=user.tenant_id,
        provider_slug=payload.provider_slug,
        event_ids=ids,
        limit=payload.limit,
        meta={"tenant_id": user.tenant_id},
    )
    return job_info


@router.post("/reports/generate")
def generate_reports(
    payload: EReportingReportGenerateRequest | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    payload = payload or EReportingReportGenerateRequest()
    if payload.report_type and payload.report_type not in {"transaction", "payment"}:
        raise HTTPException(400, "Type de rapport invalide.")
    if payload.period_start and payload.period_end and payload.period_end < payload.period_start:
        raise HTTPException(400, "La fin de période doit être postérieure au début de période.")
    if payload.provider_slug:
        try:
            resolve_provider_slug(db, user.tenant_id, payload.provider_slug)
        except ValueError as exc:
            raise HTTPException(
                400,
                sanitize_public_error_message(
                    exc,
                    status_code=400,
                    fallback="La plateforme agréée sélectionnée est indisponible.",
                ),
            ) from exc

    job_info = enqueue_job(
        generate_ereporting_reports_job,
        tenant_id=user.tenant_id,
        period_start=payload.period_start,
        period_end=payload.period_end,
        report_type=payload.report_type,
        provider_slug=payload.provider_slug,
        meta={"tenant_id": user.tenant_id},
    )
    return job_info


@router.get("/reports", response_model=EReportingReportListResponse)
def list_reports(
    page: int = 1,
    page_size: int = 50,
    status: str | None = None,
    report_type: str | None = None,
    period_start: date | None = Query(default=None),
    period_end: date | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    page = max(page, 1)
    page_size = max(1, min(page_size, 200))
    query = db.query(EReportingReport).filter(EReportingReport.tenant_id == user.tenant_id)
    if status:
        query = query.filter(EReportingReport.status == status)
    if report_type:
        query = query.filter(EReportingReport.report_type == report_type)
    if period_start:
        query = query.filter(EReportingReport.period_start >= period_start)
    if period_end:
        query = query.filter(EReportingReport.period_end <= period_end)
    total = query.count()
    items = query.order_by(EReportingReport.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    pages = math.ceil(total / page_size) if page_size else 1
    return EReportingReportListResponse(items=items, page=page, page_size=page_size, total=total, pages=pages)


@router.get("/reports/{report_id}", response_model=EReportingReportDetailResponse)
def report_detail(
    report_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    report = db.get(EReportingReport, report_id)
    if not report or report.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    lines = (
        db.query(EReportingLine)
        .filter(EReportingLine.report_id == report.id)
        .order_by(EReportingLine.created_at.asc())
        .all()
    )
    return EReportingReportDetailResponse(report=report, lines=lines)


@router.post("/reports/{report_id}/send")
def send_report(
    report_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    report = db.get(EReportingReport, report_id)
    if not report or report.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    _ensure_ereporting_transmission_operational(
        db,
        tenant_id=user.tenant_id,
        provider_slug=None,
    )
    resolved_slug = (report.provider_slug or "").strip().lower() or None
    try:
        if resolved_slug:
            resolved_slug = resolve_provider_slug(db, user.tenant_id, resolved_slug)
        else:
            resolved_slug = resolve_provider_slug(db, user.tenant_id, None)
    except ValueError as exc:
        _raise_ereporting_provider_not_operational(resolved_slug, exc)
    if not resolved_slug:
        _raise_ereporting_provider_not_operational(
            None,
            "Aucune connexion plateforme agréée active et non ambiguë n'est disponible pour ce rapport e-reporting.",
        )
    _ensure_ereporting_transmission_operational(
        db,
        tenant_id=user.tenant_id,
        provider_slug=resolved_slug,
    )
    if (resolved_slug or "").strip().lower() == "seqino":
        try:
            ensure_seqino_tokens_available_or_raise(db, user.tenant_id)
        except PdpProviderError as exc:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": exc.code or "token_balance_insufficient",
                    "message": sanitize_public_error_message(
                        exc,
                        status_code=409,
                        fallback="Vous ne disposez pas d’assez de jetons pour cette transmission.",
                    ),
                    "remediation_url": "/app/billing",
                },
            ) from exc
    job_info = enqueue_job(
        send_ereporting_reports_job,
        tenant_id=user.tenant_id,
        provider_slug=report.provider_slug,
        report_ids=[report_id],
        meta={"tenant_id": user.tenant_id},
    )
    return job_info


@router.get("/reports/{report_id}/export")
def export_report(
    report_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    report = db.get(EReportingReport, report_id)
    if not report or report.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    lines = (
        db.query(EReportingLine)
        .filter(EReportingLine.report_id == report.id)
        .order_by(EReportingLine.created_at.asc())
        .all()
    )
    payload = {
        "report": EReportingReportOut.model_validate(report).model_dump(mode="json"),
        "lines": [EReportingLineOut.model_validate(line).model_dump(mode="json") for line in lines],
    }
    filename = f"ereporting-{report.report_type}-{report.period_start.isoformat()}-{report.id}.json"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return JSONResponse(payload, headers=headers)


@router.get("/export")
@export_router.get("/export")
def export_ereporting(
    period_start: date | None = Query(default=None),
    period_end: date | None = Query(default=None),
    export_format: str = Query(default="json", alias="format"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    try:
        export = build_ereporting_export(
            db,
            tenant_id=user.tenant_id,
            period_start=period_start,
            period_end=period_end,
            export_format=export_format,
            user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(
            400,
            sanitize_public_error_message(
                exc,
                status_code=400,
                fallback="Impossible de préparer cet export avec les critères demandés.",
            ),
        ) from exc
    headers = {
        "Content-Disposition": f'attachment; filename="{export.filename}"',
        "X-Checksum": export.checksum,
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
    }
    return Response(content=export.content, media_type=export.content_type, headers=headers)


@router.get("/{event_id}", response_model=EReportingEventOut)
def ereporting_detail(
    event_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_active_subscription),
):
    event = db.get(EReportingEvent, event_id)
    if not event or event.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    return event
