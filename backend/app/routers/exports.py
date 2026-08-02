from __future__ import annotations

import csv
import copy
import io
import json
import logging
import zipfile
from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, inspect as sa_inspect, or_
from sqlalchemy.orm import Session

from .. import metrics
from ..config import settings, _is_prod_env
from ..db import get_db
from ..deps import (
    AuthUser,
    ensure_paid_subscription_or_trial,
    require_accountant_or_admin,
    require_paid_subscription_or_trial,
    require_tenant_admin,
)
from ..jobs.queue import enqueue_job
from ..models import (
    AccountingExport,
    Customer,
    CustomerContact,
    InboundInvoice,
    InboundInvoiceAttachment,
    InboundInvoiceEvent,
    Invoice,
    InvoiceDepositApplication,
    InvoiceLine,
    Membership,
    Payment,
    PurchasePayment,
    PurchaseEmployeePayer,
    PurchaseSupplier,
    CreditNoteRefund,
    Product,
    Quote,
    QuoteLine,
    Tenant,
    TenantSettings,
    User,
    BackgroundJob,
)
from ..services.invoices.amounts import invoice_advance_payments_total_ttc, invoice_balance_due_amount
from ..services.product_capabilities import ensure_product_feature, is_product_feature_enabled
from ..services.invoices.deposits import (
    deposit_application_effective_amounts,
    final_invoice_applied_deposit_totals,
    invoice_effective_template_options,
)
from ..services.background_jobs import create_job, get_job_for_tenant, mark_failed, serialize_background_job
from ..services.document_attachments import sanitize_filename
from ..services.storage import get_object_stream, parse_range_header
from ..services.accounting_exports import (
    ACCOUNTING_EXPORT_LOCKING_FORMATS,
    accounting_period_lock_payload,
    clean_accounting_export_comment,
    find_delivered_accounting_period_lock,
    parse_export_date,
    record_accounting_export,
)

router = APIRouter(prefix="/api/exports", tags=["exports"])
logger = logging.getLogger(__name__)

ACCOUNTING_EXPORT_STATUSES = {"generated", "delivered_to_accountant"}
ACCOUNTING_EXPORT_CABINET_VALIDATION_STATUSES = {"pending_review", "validated", "changes_requested"}
CSV_INJECTION_PREFIXES = ("=", "+", "-", "@")
ACCOUNTING_EXPORT_EXCLUDED_INVOICE_STATUSES = ("draft", "canceled", "cancelled")
PAYMENT_TRACKING_INVOICE_STATUSES = {
    "paid",
    "partial",
    "overdue",
    "pending",
    "refunded",
    "partially_refunded",
}
PAYMENT_TRACKING_FILTER_FIELDS = {
    "paid_start_date",
    "paid_end_date",
    "payment_start_date",
    "payment_end_date",
}
TENANT_EXPORT_EXCLUDE_FIELDS = {
    "customers": {"portal_token"},
    "invoices": {"public_token"},
    "quotes": {"public_token", "accepted_ip", "accepted_user_agent"},
    "users": {
        "password_hash",
        "totp_secret",
        "mfa_secret",
        "mfa_recovery_codes",
        "reset_token",
        "reset_token_expires_at",
    },
}


def _accounting_invoice_exportable_clause():
    return or_(
        Invoice.status.is_(None),
        Invoice.status.notin_(ACCOUNTING_EXPORT_EXCLUDED_INVOICE_STATUSES),
    )


def _invoice_status_for_export(invoice: Invoice, *, payments_enabled: bool) -> str:
    status = str(invoice.status or "issued").strip().lower() or "issued"
    if payments_enabled:
        return status
    if status in PAYMENT_TRACKING_INVOICE_STATUSES:
        return "sent" if getattr(invoice, "sent_at", None) else "issued"
    return status


def _reject_unavailable_payment_export_filters(tenant: Tenant, filters: dict[str, Any]) -> None:
    if is_product_feature_enabled(tenant, "payments_enabled"):
        return
    requested_status = str(filters.get("status") or "").strip().lower()
    has_payment_date_filter = any(str(filters.get(field) or "").strip() for field in PAYMENT_TRACKING_FILTER_FIELDS)
    if requested_status in PAYMENT_TRACKING_INVOICE_STATUSES or has_payment_date_filter:
        ensure_product_feature(tenant, "payments_enabled")


class AccountingExportStatusUpdate(BaseModel):
    status: str | None = None
    cabinet_validation_status: str | None = None
    cabinet_comment: str | None = None


class ExportJobCreate(BaseModel):
    format: str = "tenant_zip"
    estimated_rows: int | None = None
    filters: dict[str, Any] | None = None


def _storage_provider() -> str:
    return (getattr(settings, "STORAGE_PROVIDER", "local") or "local").strip().lower()


def _object_storage_ready_for_heavy_exports() -> bool:
    return _storage_provider() in {"s3", "minio"}


def _require_heavy_export_storage() -> None:
    if _is_prod_env() and not _object_storage_ready_for_heavy_exports():
        metrics.inc_operational_event("export_failure")
        logger.warning(
            "export_failure",
            extra={"code": "object_storage_required", "storage_provider": _storage_provider()},
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "object_storage_required",
                "message": "Export lourd indisponible tant que le stockage objet n’est pas configuré.",
            },
        )


def _enforce_daily_export_quota(db: Session, tenant_id: str) -> None:
    max_exports = int(getattr(settings, "MAX_EXPORTS_PER_DAY", 20) or 0)
    if max_exports <= 0:
        return
    start = datetime.now(timezone.utc).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)
    count = int(
        db.query(func.count(BackgroundJob.id))
        .filter(
            BackgroundJob.tenant_id == tenant_id,
            BackgroundJob.type == "export",
            BackgroundJob.created_at >= start,
        )
        .scalar()
        or 0
    )
    if count >= max_exports:
        metrics.inc_operational_event("quota_exceeded")
        logger.warning("quota_exceeded", extra={"scope": "exports", "tenant_id": tenant_id})
        raise HTTPException(
            status_code=429,
            detail={
                "code": "daily_export_quota_exceeded",
                "message": f"Limite de {max_exports} exports lourds atteinte aujourd’hui. Réessayez demain ou réduisez le périmètre.",
            },
        )


def _count_query(query) -> int:
    try:
        return int(query.scalar() or 0)
    except Exception:
        return 0


def _tenant_export_record_counts(db: Session, tenant_id: str) -> dict[str, int]:
    """Cheap count snapshot before building the synchronous tenant ZIP in RAM."""
    tenant_settings_count = 1 if db.get(TenantSettings, tenant_id) else 0
    return {
        "customers": _count_query(db.query(func.count(Customer.id)).filter(Customer.tenant_id == tenant_id)),
        "customer_contacts": _count_query(
            db.query(func.count(CustomerContact.id)).filter(CustomerContact.tenant_id == tenant_id)
        ),
        "items": _count_query(db.query(func.count(Product.id)).filter(Product.tenant_id == tenant_id)),
        "invoices": _count_query(db.query(func.count(Invoice.id)).filter(Invoice.tenant_id == tenant_id)),
        "invoice_lines": _count_query(
            db.query(func.count(InvoiceLine.id))
            .join(Invoice, InvoiceLine.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == tenant_id)
        ),
        "payments": _count_query(
            db.query(func.count(Payment.id))
            .join(Invoice, Payment.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == tenant_id)
        ),
        "credit_note_refunds": _count_query(
            db.query(func.count(CreditNoteRefund.id))
            .join(Invoice, CreditNoteRefund.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == tenant_id)
        ),
        "purchases": _count_query(db.query(func.count(InboundInvoice.id)).filter(InboundInvoice.tenant_id == tenant_id)),
        "purchase_payments": _count_query(
            db.query(func.count(PurchasePayment.id)).filter(PurchasePayment.tenant_id == tenant_id)
        ),
        "purchase_suppliers": _count_query(
            db.query(func.count(PurchaseSupplier.id)).filter(PurchaseSupplier.tenant_id == tenant_id)
        ),
        "purchase_employee_payers": _count_query(
            db.query(func.count(PurchaseEmployeePayer.id)).filter(PurchaseEmployeePayer.tenant_id == tenant_id)
        ),
        "purchase_attachments": _count_query(
            db.query(func.count(InboundInvoiceAttachment.id))
            .join(InboundInvoice, InboundInvoiceAttachment.inbound_invoice_id == InboundInvoice.id)
            .filter(InboundInvoice.tenant_id == tenant_id)
        ),
        "purchase_events": _count_query(
            db.query(func.count(InboundInvoiceEvent.id))
            .join(InboundInvoice, InboundInvoiceEvent.inbound_invoice_id == InboundInvoice.id)
            .filter(InboundInvoice.tenant_id == tenant_id)
        ),
        "tenant_settings": tenant_settings_count,
        "quotes": _count_query(db.query(func.count(Quote.id)).filter(Quote.tenant_id == tenant_id)),
        "quote_lines": _count_query(
            db.query(func.count(QuoteLine.id))
            .join(Quote, QuoteLine.quote_id == Quote.id)
            .filter(Quote.tenant_id == tenant_id)
        ),
        "users": _count_query(
            db.query(func.count(func.distinct(User.id)))
            .join(Membership, Membership.user_id == User.id)
            .filter(Membership.tenant_id == tenant_id)
        ),
    }


def _enforce_tenant_sync_export_limit(db: Session, tenant_id: str) -> dict[str, int]:
    counts = _tenant_export_record_counts(db, tenant_id)
    total = sum(int(value or 0) for value in counts.values())
    max_records = int(getattr(settings, "MAX_SYNC_EXPORT_ROWS", 5_000) or 0)
    if max_records > 0 and total > max_records:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "tenant_export_too_large",
                "message": (
                    "Export complet trop volumineux pour un téléchargement immédiat. "
                    "Lancez un export lourd asynchrone ou réduisez le périmètre."
                ),
                "record_count": total,
                "max_records": max_records,
                "counts": counts,
                "async_endpoint": "/api/exports/jobs",
            },
        )
    return counts


@router.post("/jobs")
def create_export_job(
    payload: ExportJobCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    export_format = (payload.format or "tenant_zip").strip().lower()
    if export_format not in {"tenant_zip", "cabinet_zip", "archive_zip", "edi_ubl", "edi_cii"}:
        raise HTTPException(400, {"code": "invalid_export_format", "message": "Format d’export non pris en charge."})
    if export_format in {"edi_ubl", "edi_cii"}:
        raise HTTPException(
            400,
            {
                "code": "async_export_format_not_supported",
                "message": "Cet export EDI se télécharge depuis l'écran Factures. Utilisez tenant_zip, cabinet_zip ou archive_zip pour les exports lourds.",
            },
        )
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    export_filters = payload.filters or {}
    _reject_unavailable_payment_export_filters(tenant, export_filters)
    _require_heavy_export_storage()
    _enforce_daily_export_quota(db, user.tenant_id)
    input_payload = {
        "format": export_format,
        "estimated_rows": payload.estimated_rows,
        "filters": export_filters,
    }
    job = create_job(
        db,
        tenant_id=user.tenant_id,
        user_id=None if user.is_api_key else user.id,
        job_type="export",
        queue=getattr(settings, "JOBS_QUEUE_EXPORTS", "exports"),
        input_payload=input_payload,
    )
    db.commit()
    db.refresh(job)
    try:
        from ..jobs.export_jobs import process_export_job

        rq_job = enqueue_job(
            process_export_job,
            job.id,
            input_payload,
            meta={"tenant_id": user.tenant_id, "background_job_id": job.id, "type": "export"},
            queue_name=getattr(settings, "JOBS_QUEUE_EXPORTS", "exports"),
            description=f"export:{export_format}:{job.id}",
        )
    except Exception as exc:
        mark_failed(
            job,
            code="export_enqueue_failed",
            message="L’export n’a pas pu être planifié. Réessayez dans quelques instants.",
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        raise HTTPException(
            status_code=503,
            detail={"code": "export_enqueue_failed", "message": "Impossible de planifier l'export lourd."},
        ) from exc
    rq_job_id = str(rq_job.get("job_id") or "").strip()
    if rq_job_id:
        job.rq_job_id = rq_job_id
        db.add(job)
        db.commit()
        db.refresh(job)
    return serialize_background_job(job)


@router.get("/jobs/{job_id}")
def get_export_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    job = get_job_for_tenant(db, tenant_id=user.tenant_id, job_id=job_id)
    if not job or job.type != "export":
        raise HTTPException(404, "Not found")
    return serialize_background_job(job)


def _export_job_result_from_ref(result_ref: str, *, tenant_id: str) -> tuple[str, str, str]:
    raw = (result_ref or "").strip()
    payload: dict[str, Any] = {}
    if raw.startswith("{"):
        try:
            loaded = json.loads(raw)
            if isinstance(loaded, dict):
                payload = loaded
        except json.JSONDecodeError:
            payload = {}
    key = str(payload.get("storage_key") or payload.get("key") or raw).strip()
    if key.startswith("storage:"):
        key = key.split(":", 1)[1].strip()
    if key.startswith("/"):
        key = key.lstrip("/")
    expected_prefix = f"exports/{tenant_id}/"
    if not key or "\\" in key or ".." in key.split("/") or not key.startswith(expected_prefix):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "export_result_invalid",
                "message": "Référence d'export invalide. Relancez l'export.",
            },
        )
    filename = sanitize_filename(str(payload.get("filename") or key.rsplit("/", 1)[-1] or "export.zip"))
    if not filename.lower().endswith(".zip"):
        filename = f"{filename}.zip"
    content_type = str(payload.get("content_type") or "application/zip").strip() or "application/zip"
    return key, filename, content_type


def _stream_export_result(
    *,
    request: Request,
    storage_key: str,
    filename: str,
    content_type: str,
) -> StreamingResponse | Response:
    stream = get_object_stream(storage_key)
    if not stream:
        raise HTTPException(
            status_code=410,
            detail={
                "code": "export_result_missing",
                "message": "Le fichier d'export n'est plus disponible. Relancez l'export.",
            },
        )
    status_code = 200
    range_header = request.headers.get("range")
    if range_header:
        byte_range = parse_range_header(range_header, stream.total_size)
        if byte_range is None:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{stream.total_size}"})
        ranged = get_object_stream(storage_key, byte_range=byte_range)
        if ranged:
            stream = ranged
            status_code = 206

    headers = _export_attachment_headers(filename)
    headers["Accept-Ranges"] = "bytes"
    headers["Content-Length"] = str(stream.content_length)
    if status_code == 206 and byte_range:
        start, end = byte_range
        headers["Content-Range"] = f"bytes {start}-{end}/{stream.total_size}"
    if stream.etag:
        headers["ETag"] = stream.etag
    return StreamingResponse(stream.body, media_type=content_type, headers=headers, status_code=status_code)


@router.get("/jobs/{job_id}/download")
def download_export_job(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    job = get_job_for_tenant(db, tenant_id=user.tenant_id, job_id=job_id)
    if not job or job.type != "export":
        raise HTTPException(404, "Not found")
    if job.status != "succeeded" or not job.result_ref:
        raise HTTPException(
            status_code=409,
            detail={"code": "export_not_ready", "message": "L’export n’est pas encore prêt au téléchargement."},
        )
    storage_key, filename, content_type = _export_job_result_from_ref(job.result_ref, tenant_id=user.tenant_id)
    return _stream_export_result(request=request, storage_key=storage_key, filename=filename, content_type=content_type)


def _sanitize_csv_cell(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    if not text:
        return ""
    first_meaningful = text.lstrip(" \t\r\n\ufeff")
    if first_meaningful and first_meaningful[0] in CSV_INJECTION_PREFIXES:
        return "'" + text
    return text


def _export_attachment_headers(filename: str) -> dict[str, str]:
    return {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
    }


def _export_label(export_format: str) -> str:
    labels = {
        "csv": "CSV comptable",
        "fec": "Journal des ventes",
        "edi_ubl": "Archive EDI UBL",
        "edi_cii": "Archive EDI CII",
        "archive_zip": "Archive documents",
        "tenant_zip": "Portabilité complète du compte",
        "cabinet_zip": "Dossier de contrôle compta ZIP",
    }
    return labels.get(export_format, export_format.upper())


def _accounting_export_item(
    row: AccountingExport,
    *,
    customer_name: str | None = None,
    created_by_email: str | None = None,
    delivered_by_email: str | None = None,
    reviewed_by_email: str | None = None,
    purchases_enabled: bool = True,
    payments_enabled: bool = True,
) -> dict[str, Any]:
    validation_status = row.cabinet_validation_status or "pending_review"
    filters = _accounting_filters_for_capabilities(
        row.filters_json if isinstance(row.filters_json, dict) else {},
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )
    quality_checks = filters.get("quality_checks") if isinstance(filters.get("quality_checks"), dict) else None
    return {
        "id": row.id,
        "format": row.format,
        "label": _export_label(row.format),
        "period_start": row.period_start.isoformat() if row.period_start else None,
        "period_end": row.period_end.isoformat() if row.period_end else None,
        "customer_id": row.customer_id,
        "customer_name": customer_name,
        "record_count": int(row.record_count or 0),
        "filters": filters,
        "quality_checks": quality_checks,
        "status": row.status,
        "locked": row.status == "delivered_to_accountant",
        "cabinet_validation_status": validation_status,
        "cabinet_reviewed_at": row.cabinet_reviewed_at.isoformat() if row.cabinet_reviewed_at else None,
        "cabinet_reviewed_by": reviewed_by_email,
        "cabinet_comment": row.cabinet_comment or "",
        "delivered_to_accountant_at": row.delivered_to_accountant_at.isoformat()
        if row.delivered_to_accountant_at
        else None,
        "delivered_to_accountant_by": delivered_by_email,
        "created_by": created_by_email,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _accounting_filters_for_capabilities(
    filters: dict[str, Any],
    *,
    purchases_enabled: bool,
    payments_enabled: bool,
) -> dict[str, Any]:
    """Mask retained Pro module details from Starter accounting-history surfaces."""
    cleaned = copy.deepcopy(filters)
    counts = cleaned.get("counts")
    if isinstance(counts, dict):
        hidden_count_keys: set[str] = set()
        if not purchases_enabled:
            hidden_count_keys.update(
                {
                    "purchases",
                    "undated_purchases",
                    "purchase_lines",
                    "purchase_suppliers",
                    "purchase_employee_payers",
                    "purchase_payments",
                    "purchase_attachments",
                    "purchase_events",
                    "employee_reimbursements",
                }
            )
        if not payments_enabled:
            hidden_count_keys.update(
                {"payments", "credit_note_refunds", "purchase_payments", "employee_reimbursements"}
            )
        cleaned["counts"] = {key: value for key, value in counts.items() if key not in hidden_count_keys}

    quality_checks = cleaned.get("quality_checks")
    if isinstance(quality_checks, dict):
        warnings = quality_checks.get("warnings")
        if isinstance(warnings, list):
            allowed_warnings = [
                warning
                for warning in warnings
                if isinstance(warning, dict)
                and (purchases_enabled or warning.get("scope") != "purchases")
                and (payments_enabled or warning.get("scope") != "payments")
            ]
            cleaned["quality_checks"] = {
                **quality_checks,
                "status": "needs_review" if allowed_warnings else "ready",
                "warnings_count": len(allowed_warnings),
                "warnings": allowed_warnings,
            }
    if not purchases_enabled:
        cleaned.pop("purchase_scope", None)
    if not payments_enabled:
        for field in PAYMENT_TRACKING_FILTER_FIELDS:
            cleaned.pop(field, None)
        if str(cleaned.get("status") or "").strip().lower() in PAYMENT_TRACKING_INVOICE_STATUSES:
            cleaned.pop("status", None)
    return cleaned


def _json_default(obj: Any):
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        # preserve exact value
        return str(obj)
    return str(obj)


def _model_to_dict(obj: Any, exclude: set[str] | None = None) -> dict[str, Any]:
    exclude = exclude or set()
    mapper = sa_inspect(obj.__class__)
    data: dict[str, Any] = {}
    for col in mapper.columns:
        name = col.name
        if name in exclude:
            continue
        data[name] = getattr(obj, name)
    return data


def _parse_accounting_query_date(raw: str | None, field: str) -> date | None:
    parsed = parse_export_date(raw)
    if raw and not parsed:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_export_filter",
                "field": field,
                "message": f"Filtre {field} invalide.",
            },
        )
    return parsed


def _accounting_datetime_bounds(start: date | None, end: date | None) -> tuple[datetime | None, datetime | None]:
    if start and end and start > end:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_export_filter",
                "field": "end_date",
                "message": "La date de fin doit être postérieure ou égale à la date de début.",
            },
        )
    return (
        datetime.combine(start, time.min) if start else None,
        datetime.combine(end, time.max) if end else None,
    )


def _csv_text(headers: list[str], rows: list[list[object]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(headers)
    for row in rows:
        writer.writerow([_sanitize_csv_cell(value) for value in row])
    return "\ufeff" + buf.getvalue()


def _safe_company_payload(tenant: Tenant) -> dict[str, Any]:
    return {
        "name": tenant.name,
        "siret": tenant.siret,
        "rcs": tenant.rcs,
        "naf_code": tenant.naf_code,
        "legal_form": tenant.legal_form,
        "share_capital": tenant.share_capital,
        "address": tenant.address,
        "address_line1": tenant.address_line1,
        "address_line2": tenant.address_line2,
        "postal_code": tenant.postal_code,
        "city": tenant.city,
        "country": tenant.country,
        "country_code": tenant.country_code,
        "phone": tenant.phone,
        "vat_number": tenant.vat_number,
        "vat_regime": tenant.vat_regime,
        "vat_on_debits": bool(tenant.vat_on_debits),
        "transaction_periodicity": tenant.transaction_periodicity,
        "payment_periodicity": tenant.payment_periodicity,
        "vat_exemption_notice": tenant.vat_exemption_notice,
        "fec_journal_code": tenant.fec_journal_code,
        "fec_journal_label": tenant.fec_journal_label,
        "fec_account_customer": tenant.fec_account_customer,
        "fec_account_revenue": tenant.fec_account_revenue,
        "fec_account_vat": tenant.fec_account_vat,
        "iban": tenant.iban,
        "bic": tenant.bic,
        "retention_years": tenant.retention_years,
    }


def _history_rows(
    db: Session,
    *,
    tenant_id: str,
    start: date | None,
    end: date | None,
    customer_id: str | None,
    limit: int = 500,
) -> list[AccountingExport]:
    query = db.query(AccountingExport).filter(AccountingExport.tenant_id == tenant_id)
    if customer_id:
        query = query.filter(AccountingExport.customer_id == customer_id)
    if start:
        query = query.filter((AccountingExport.period_end.is_(None)) | (AccountingExport.period_end >= start))
    if end:
        query = query.filter((AccountingExport.period_start.is_(None)) | (AccountingExport.period_start <= end))
    return query.order_by(AccountingExport.created_at.desc()).limit(limit).all()


def _can_override_accounting_lock(user: AuthUser) -> bool:
    role = (user.role or "").lower()
    return bool(user.is_admin or role in {"owner", "admin"})


def _ensure_accounting_lock_override_allowed(user: AuthUser) -> None:
    if _can_override_accounting_lock(user):
        return
    raise HTTPException(
        status_code=403,
        detail={
            "code": "accounting_lock_override_forbidden",
            "message": "Seul un administrateur peut forcer ou déverrouiller une période remise au cabinet.",
        },
    )


def _normalize_lookup_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _purchase_issue_date_filters(start: date | None, end: date | None):
    filters = [InboundInvoice.issue_date.isnot(None)]
    if start:
        filters.append(InboundInvoice.issue_date >= start)
    if end:
        filters.append(InboundInvoice.issue_date <= end)
    return filters


def _undated_purchase_received_filters(start: date | None, end: date | None):
    filters = [InboundInvoice.issue_date.is_(None)]
    if start:
        filters.append(InboundInvoice.received_at >= datetime.combine(start, time.min))
    if end:
        filters.append(InboundInvoice.received_at <= datetime.combine(end, time.max))
    return filters


def _purchase_line_rows(purchases: list[InboundInvoice]) -> list[list[object]]:
    rows: list[list[object]] = []
    for purchase in purchases:
        raw_lines = purchase.purchase_lines if isinstance(purchase.purchase_lines, list) else []
        for index, line in enumerate(raw_lines, start=1):
            line_dict = line if isinstance(line, dict) else {}
            rows.append(
                [
                    purchase.id,
                    purchase.invoice_number,
                    index,
                    line_dict.get("label") or f"Ligne {index}",
                    line_dict.get("total_ex_vat"),
                    line_dict.get("vat_rate"),
                    line_dict.get("total_vat"),
                    line_dict.get("total_ttc"),
                    line_dict.get("accounting_account") or purchase.accounting_account,
                    line_dict.get("purchase_nature") or purchase.purchase_nature,
                    line_dict.get("vat_category"),
                    line_dict.get("exemption_reason_code"),
                    line_dict.get("vat_exemption_reason"),
                    line_dict.get("vat_zero_reason"),
                    "yes" if line_dict.get("vat_reverse_charge") else "",
                    line_dict.get("source") or "purchase_lines",
                ]
            )
    return rows


def _purchase_payment_rows(payments: list[PurchasePayment]) -> list[list[object]]:
    rows: list[list[object]] = []
    for payment in payments:
        purchase = payment.inbound_invoice
        rows.append(
            [
                payment.id,
                payment.inbound_invoice_id,
                purchase.invoice_number if purchase else "",
                purchase.supplier_name if purchase else "",
                purchase.supplier_siren if purchase else "",
                purchase.supplier_siret if purchase else "",
                purchase.issue_date.isoformat() if purchase and purchase.issue_date else "",
                purchase.total_ttc if purchase else "",
                purchase.currency if purchase else "",
                payment.date.isoformat() if payment.date else "",
                payment.amount,
                payment.method,
                payment.reference,
                payment.settlement_mode,
                payment.accounting_category,
                payment.receipt_label,
                payment.receipt_url,
            ]
        )
    return rows


def _purchase_supplier_rows(db: Session, *, tenant_id: str, purchases: list[InboundInvoice]) -> list[list[object]]:
    supplier_refs: dict[str, PurchaseSupplier] = {}
    normalized_names = {
        _normalize_lookup_name(purchase.supplier_name) for purchase in purchases if purchase.supplier_name
    }
    sirets = {purchase.supplier_siret for purchase in purchases if purchase.supplier_siret}
    sirens = {purchase.supplier_siren for purchase in purchases if purchase.supplier_siren}
    ref_filters = []
    if normalized_names:
        ref_filters.append(PurchaseSupplier.normalized_name.in_(normalized_names))
    if sirets:
        ref_filters.append(PurchaseSupplier.siret.in_(sirets))
    if sirens:
        ref_filters.append(PurchaseSupplier.siren.in_(sirens))
    refs = (
        db.query(PurchaseSupplier)
        .filter(PurchaseSupplier.tenant_id == tenant_id, PurchaseSupplier.is_active.is_(True), or_(*ref_filters))
        .all()
        if ref_filters
        else []
    )
    for ref in refs:
        if ref.siret:
            supplier_refs[f"siret:{ref.siret}"] = ref
        if ref.siren:
            supplier_refs[f"siren:{ref.siren}"] = ref
        supplier_refs[f"name:{ref.normalized_name}"] = ref

    suppliers: dict[str, tuple[InboundInvoice, PurchaseSupplier | None]] = {}
    for purchase in purchases:
        key = (
            purchase.supplier_siret
            or purchase.supplier_siren
            or (purchase.supplier_name or "").strip().lower()
            or purchase.id
        )
        ref = None
        if purchase.supplier_siret:
            ref = supplier_refs.get(f"siret:{purchase.supplier_siret}")
        if not ref and purchase.supplier_siren:
            ref = supplier_refs.get(f"siren:{purchase.supplier_siren}")
        if not ref:
            ref = supplier_refs.get(f"name:{_normalize_lookup_name(purchase.supplier_name)}")
        suppliers.setdefault(key, (purchase, ref))
    return [
        [
            key,
            ref.name if ref else purchase.supplier_name,
            ref.siren if ref else purchase.supplier_siren,
            ref.siret if ref else purchase.supplier_siret,
            ref.vat_number if ref else "",
            ref.default_accounting_account if ref else purchase.accounting_account,
            ref.default_purchase_nature if ref else purchase.purchase_nature,
            ref.default_payment_delay_days if ref else "",
            ref.last_used_at.isoformat() if ref and ref.last_used_at else "",
            "reference" if ref else "purchase",
        ]
        for key, (purchase, ref) in sorted(suppliers.items(), key=lambda item: str(item[0]))
    ]


def _purchase_employee_payer_rows(
    db: Session, *, tenant_id: str, purchases: list[InboundInvoice]
) -> list[list[object]]:
    names = {
        _normalize_lookup_name(purchase.employee_payer_name) for purchase in purchases if purchase.employee_payer_name
    }
    refs = (
        db.query(PurchaseEmployeePayer)
        .filter(
            PurchaseEmployeePayer.tenant_id == tenant_id,
            PurchaseEmployeePayer.is_active.is_(True),
            PurchaseEmployeePayer.normalized_name.in_(names),
        )
        .all()
        if names
        else []
    )
    refs_by_name = {ref.normalized_name: ref for ref in refs}
    rows: dict[str, list[object]] = {}
    for purchase in purchases:
        normalized_name = _normalize_lookup_name(purchase.employee_payer_name)
        if not normalized_name:
            continue
        ref = refs_by_name.get(normalized_name)
        rows.setdefault(
            normalized_name,
            [
                ref.name if ref else purchase.employee_payer_name,
                ref.role if ref else purchase.employee_payer_role,
                ref.default_accounting_account if ref else purchase.accounting_account,
                ref.reimbursement_method if ref else purchase.employee_reimbursement_method,
                ref.vehicle_type if ref else "",
                ref.fiscal_power if ref else "",
                ref.last_used_at.isoformat() if ref and ref.last_used_at else "",
                "reference" if ref else "purchase",
            ],
        )
    return [rows[key] for key in sorted(rows)]


def _purchase_csv_rows(purchases: list[InboundInvoice]) -> list[list[object]]:
    return [
        [
            purchase.id,
            purchase.received_at.isoformat() if purchase.received_at else "",
            purchase.issue_date.isoformat() if purchase.issue_date else "",
            purchase.supplier_name,
            purchase.supplier_siren,
            purchase.supplier_siret,
            purchase.invoice_number,
            purchase.total_ex_vat,
            purchase.total_vat,
            purchase.total_ttc,
            purchase.currency,
            purchase.status,
            purchase.validation_status,
            purchase.completion_status,
            purchase.completion_validated_at.isoformat() if purchase.completion_validated_at else "",
            purchase.format,
            purchase.facturx_profile,
            purchase.purchase_nature,
            purchase.accounting_account,
            purchase.planned_payment_date.isoformat() if purchase.planned_payment_date else "",
            bool(purchase.paid_by_employee),
            purchase.employee_payer_name,
            purchase.employee_payer_role,
            purchase.employee_reimbursement_amount,
            purchase.employee_reimbursement_due_date.isoformat() if purchase.employee_reimbursement_due_date else "",
            purchase.employee_reimbursement_method,
            purchase.employee_reimbursement_status,
            json.dumps(purchase.purchase_tags or [], ensure_ascii=False, default=_json_default),
            purchase.duplicate_of_id,
            purchase.accountant_note,
            purchase.provider_slug,
        ]
        for purchase in purchases
    ]


def _is_blank(value: object) -> bool:
    return not str(value or "").strip()


def _money_is_nonzero(value: object) -> bool:
    try:
        return Decimal(str(value or 0)) != Decimal("0")
    except Exception:
        return True


def _limited_examples(values: list[str], limit: int = 8) -> list[str]:
    seen: list[str] = []
    for value in values:
        clean = str(value or "").strip()
        if clean and clean not in seen:
            seen.append(clean)
        if len(seen) >= limit:
            break
    return seen


def _accounting_warning(
    *,
    code: str,
    scope: str,
    label: str,
    count: int,
    examples: list[str],
    action: str,
) -> dict[str, Any] | None:
    if count <= 0:
        return None
    return {
        "code": code,
        "scope": scope,
        "label": label,
        "count": count,
        "examples": _limited_examples(examples),
        "action": action,
    }


def _purchase_line_effective_account(purchase: InboundInvoice, line: dict[str, Any]) -> str:
    return str(line.get("accounting_account") or purchase.accounting_account or "").strip()


def _accounting_account_code(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def _accounting_account_compact(value: object) -> str:
    return "".join(ch for ch in str(value or "").strip().upper() if ch.isalnum())


def _is_temporary_account_value(value: object) -> bool:
    return _accounting_account_compact(value).startswith("471")


def _is_placeholder_account_value(value: object) -> bool:
    return _accounting_account_compact(value) in {"MANUAL", "CUSTOM"}


def _accounting_account_needs_completion(value: object) -> bool:
    return (
        not _accounting_account_code(value)
        or _is_temporary_account_value(value)
        or _is_placeholder_account_value(value)
    )


def _accounting_account_label(code: str) -> str:
    compact = "".join(ch for ch in code if ch.isalnum()).upper()
    if compact.startswith("471"):
        return "Compte d'attente à corriger"
    if compact.startswith("706"):
        return "Prestations de services"
    if compact.startswith("707"):
        return "Ventes de marchandises"
    if compact.startswith("70"):
        return "Produits de vente"
    if compact.startswith("60"):
        return "Achats et charges externes"
    if compact.startswith("625"):
        return "Déplacements et réceptions"
    if compact.startswith("62"):
        return "Services extérieurs"
    if compact.startswith("44571"):
        return "TVA collectée"
    if compact.startswith("44566") or compact.startswith("4456"):
        return "TVA déductible"
    if compact.startswith("411"):
        return "Clients"
    if compact.startswith("401"):
        return "Fournisseurs"
    if compact.startswith("467"):
        return "Collaborateurs / notes de frais"
    if compact.startswith("512"):
        return "Banque"
    if compact.startswith("53"):
        return "Caisse"
    return "Compte utilisé dans les exports"


def _blank_account_filter(column: Any):
    return or_(column.is_(None), func.trim(column) == "")


def _not_blank_account_filter(column: Any):
    return column.isnot(None), func.trim(column) != ""


def _temporary_account_filter(column: Any):
    return func.upper(func.trim(column)).like("471%")


def _account_needs_completion_filter(column: Any):
    return or_(
        _blank_account_filter(column),
        _temporary_account_filter(column),
        func.upper(func.trim(column)).in_(["MANUAL", "CUSTOM"]),
    )


def _exportable_account_filter(column: Any):
    return (
        column.isnot(None),
        func.trim(column) != "",
        ~_temporary_account_filter(column),
        ~func.upper(func.trim(column)).in_(["MANUAL", "CUSTOM"]),
    )


def _decimal_amount(value: object) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except Exception:
        return Decimal("0")


def _add_account_usage(
    bucket: dict[str, dict[str, Any]],
    *,
    account: object,
    count: int = 1,
    amount: object = None,
    source: str,
) -> None:
    code = _accounting_account_code(account)
    if not code or _is_temporary_account_value(code):
        return
    item = bucket.setdefault(
        code,
        {
            "code": code,
            "label": _accounting_account_label(code),
            "count": 0,
            "amount": Decimal("0"),
            "sources": set(),
        },
    )
    item["count"] += int(count or 0)
    item["amount"] += _decimal_amount(amount)
    item["sources"].add(source)


def _account_usage_payload(bucket: dict[str, dict[str, Any]], *, limit: int = 6) -> list[dict[str, Any]]:
    rows = sorted(
        bucket.values(),
        key=lambda item: (abs(item["amount"]), item["count"], item["code"]),
        reverse=True,
    )
    return [
        {
            "code": item["code"],
            "label": item["label"],
            "count": int(item["count"]),
            "amount": str(item["amount"].quantize(Decimal("0.01"))),
            "sources": sorted(item["sources"]),
        }
        for item in rows[:limit]
    ]


def _accounting_quality_checks(
    *,
    invoices: list[Invoice],
    invoice_lines: list[InvoiceLine],
    payments: list[tuple[Payment, Invoice]],
    purchases: list[InboundInvoice],
    undated_purchases: list[InboundInvoice],
    purchase_payments: list[PurchasePayment],
) -> dict[str, Any]:
    invoice_by_id = {invoice.id: invoice for invoice in invoices}
    invoice_line_examples: list[str] = []
    invoice_line_count = 0
    for line in invoice_lines:
        if not _money_is_nonzero(line.line_total) or not _accounting_account_needs_completion(line.accounting_account):
            continue
        invoice = invoice_by_id.get(line.invoice_id)
        invoice_line_count += 1
        invoice_line_examples.append(f"{invoice.number if invoice else line.invoice_id} - {line.product_name}")

    payment_category_examples: list[str] = []
    payment_category_count = 0
    payment_mode_examples: list[str] = []
    payment_mode_count = 0
    for payment, invoice in payments:
        label = f"{invoice.number or invoice.id} - {payment.amount} {invoice.currency or 'EUR'}"
        if _accounting_account_needs_completion(payment.accounting_category):
            payment_category_count += 1
            payment_category_examples.append(label)
        if _is_blank(payment.settlement_mode):
            payment_mode_count += 1
            payment_mode_examples.append(label)

    purchase_payment_category_examples: list[str] = []
    purchase_payment_category_count = 0
    purchase_payment_mode_examples: list[str] = []
    purchase_payment_mode_count = 0
    for payment in purchase_payments:
        purchase = payment.inbound_invoice
        label = f"{purchase.invoice_number if purchase else payment.inbound_invoice_id} - {payment.amount} EUR"
        if _accounting_account_needs_completion(payment.accounting_category):
            purchase_payment_category_count += 1
            purchase_payment_category_examples.append(label)
        if _is_blank(payment.settlement_mode):
            purchase_payment_mode_count += 1
            purchase_payment_mode_examples.append(label)

    purchase_account_examples: list[str] = []
    purchase_account_count = 0
    purchase_completion_examples: list[str] = []
    purchase_completion_count = 0
    purchase_line_account_examples: list[str] = []
    purchase_line_account_count = 0
    purchase_validation_examples: list[str] = []
    purchase_validation_count = 0
    for purchase in purchases:
        purchase_label = purchase.invoice_number or purchase.supplier_name or purchase.id
        if str(purchase.validation_status or "").lower() in {"invalid", "failed", "unavailable"}:
            purchase_validation_count += 1
            purchase_validation_examples.append(str(purchase_label))
        if str(purchase.completion_status or "").lower() != "completed":
            purchase_completion_count += 1
            purchase_completion_examples.append(str(purchase_label))
        raw_lines = purchase.purchase_lines if isinstance(purchase.purchase_lines, list) else []
        if raw_lines:
            for index, raw_line in enumerate(raw_lines, start=1):
                line = raw_line if isinstance(raw_line, dict) else {}
                if _money_is_nonzero(line.get("total_ex_vat")) and _accounting_account_needs_completion(
                    _purchase_line_effective_account(purchase, line)
                ):
                    purchase_line_account_count += 1
                    purchase_line_account_examples.append(f"{purchase_label} - ligne {index}")
        elif _accounting_account_needs_completion(purchase.accounting_account):
            purchase_account_count += 1
            purchase_account_examples.append(str(purchase_label))

    warnings = [
        _accounting_warning(
            code="invoice_lines_missing_account",
            scope="sales",
            label="Catégorie compta à compléter sur des lignes de vente",
            count=invoice_line_count,
            examples=invoice_line_examples,
            action="Choisir la catégorie compta adaptée. La catégorie d'attente 471 doit être corrigée avant export.",
        ),
        _accounting_warning(
            code="payments_missing_category",
            scope="payments",
            label="Paiements sans compte de règlement",
            count=payment_category_count,
            examples=payment_category_examples,
            action="Renseigner le compte ou la catégorie de règlement du paiement.",
        ),
        _accounting_warning(
            code="payments_missing_mode",
            scope="payments",
            label="Paiements sans mode de règlement",
            count=payment_mode_count,
            examples=payment_mode_examples,
            action="Indiquer manuel, caisse ou banque quand le rapprochement bancaire sera traité.",
        ),
        _accounting_warning(
            code="purchase_payments_missing_category",
            scope="purchases",
            label="Règlements fournisseurs sans compte de règlement",
            count=purchase_payment_category_count,
            examples=purchase_payment_category_examples,
            action="Renseigner le compte banque/caisse du règlement fournisseur.",
        ),
        _accounting_warning(
            code="purchase_payments_missing_mode",
            scope="purchases",
            label="Règlements fournisseurs sans mode de règlement",
            count=purchase_payment_mode_count,
            examples=purchase_payment_mode_examples,
            action="Indiquer virement, carte, caisse ou autre mode exploitable par le cabinet.",
        ),
        _accounting_warning(
            code="purchases_not_completed",
            scope="purchases",
            label="Achats non finalisés",
            count=purchase_completion_count,
            examples=purchase_completion_examples,
            action="Valider la fiche achat ou isoler le document avant export cabinet.",
        ),
        _accounting_warning(
            code="purchase_document_validation",
            scope="purchases",
            label="Justificatifs fournisseurs à corriger",
            count=purchase_validation_count,
            examples=purchase_validation_examples,
            action=(
                "Remplacer les pièces qui ne passent pas les contrôles Factur-X/XML "
                "ou les isoler avant export comptable strict."
            ),
        ),
        _accounting_warning(
            code="purchases_missing_account",
            scope="purchases",
            label="Achats sans catégorie compta",
            count=purchase_account_count,
            examples=purchase_account_examples,
            action="Choisir la catégorie d'achat ou ventiler les lignes. La catégorie d'attente 471 est temporaire.",
        ),
        _accounting_warning(
            code="purchase_lines_missing_account",
            scope="purchases",
            label="Catégorie compta à compléter sur une ou plusieurs lignes d’achat",
            count=purchase_line_account_count,
            examples=purchase_line_account_examples,
            action="Compléter les catégories ligne par ligne ou via la règle fournisseur. La catégorie d'attente 471 est temporaire.",
        ),
        _accounting_warning(
            code="purchases_missing_issue_date",
            scope="purchases",
            label="Achats sans date d'émission",
            count=len(undated_purchases),
            examples=[
                purchase.invoice_number or purchase.supplier_name or purchase.id for purchase in undated_purchases
            ],
            action="Ajouter la date de facture fournisseur pour une période comptable nette.",
        ),
    ]
    filtered_warnings = [warning for warning in warnings if warning]
    return {
        "status": "needs_review" if filtered_warnings else "ready",
        "warnings_count": len(filtered_warnings),
        "warnings": filtered_warnings,
    }


def _accounting_quality_rows(quality_checks: dict[str, Any]) -> list[list[object]]:
    return [
        [
            warning.get("code"),
            warning.get("scope"),
            warning.get("label"),
            warning.get("count"),
            " | ".join(warning.get("examples") or []),
            warning.get("action"),
        ]
        for warning in quality_checks.get("warnings", [])
        if isinstance(warning, dict)
    ]


def _build_cabinet_package(
    db: Session,
    *,
    tenant: Tenant,
    user: AuthUser,
    start: date | None,
    end: date | None,
    customer_id: str | None,
) -> tuple[bytes, dict[str, int], dict[str, Any]]:
    purchases_enabled = is_product_feature_enabled(tenant, "purchases_enabled")
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    start_dt, end_dt = _accounting_datetime_bounds(start, end)
    invoice_query = db.query(Invoice).filter(
        Invoice.tenant_id == tenant.id,
        _accounting_invoice_exportable_clause(),
    )
    if customer_id:
        invoice_query = invoice_query.filter(Invoice.customer_id == customer_id)
    if start_dt:
        invoice_query = invoice_query.filter(Invoice.issue_date >= start_dt)
    if end_dt:
        invoice_query = invoice_query.filter(Invoice.issue_date <= end_dt)
    invoices = invoice_query.order_by(Invoice.issue_date.asc(), Invoice.number.asc()).all()
    customer_ids = {invoice.customer_id for invoice in invoices if invoice.customer_id}
    if customer_id:
        customer_ids.add(customer_id)
    payments: list[tuple[Payment, Invoice]] = []
    if payments_enabled:
        payment_query = (
            db.query(Payment, Invoice)
            .join(Invoice, Payment.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == tenant.id, _accounting_invoice_exportable_clause())
        )
        if customer_id:
            payment_query = payment_query.filter(Invoice.customer_id == customer_id)
        if start_dt:
            payment_query = payment_query.filter(Payment.date >= start_dt)
        if end_dt:
            payment_query = payment_query.filter(Payment.date <= end_dt)
        payments = payment_query.order_by(Payment.date.asc()).all()
    for _, invoice in payments:
        if invoice.customer_id:
            customer_ids.add(invoice.customer_id)
    refunds: list[tuple[CreditNoteRefund, Invoice]] = []
    if payments_enabled:
        refund_query = (
            db.query(CreditNoteRefund, Invoice)
            .join(Invoice, CreditNoteRefund.invoice_id == Invoice.id)
            .filter(Invoice.tenant_id == tenant.id, _accounting_invoice_exportable_clause())
        )
        if customer_id:
            refund_query = refund_query.filter(Invoice.customer_id == customer_id)
        if start_dt:
            refund_query = refund_query.filter(CreditNoteRefund.date >= start_dt)
        if end_dt:
            refund_query = refund_query.filter(CreditNoteRefund.date <= end_dt)
        refunds = refund_query.order_by(CreditNoteRefund.date.asc()).all()
    for _, invoice in refunds:
        if invoice.customer_id:
            customer_ids.add(invoice.customer_id)
    purchase_query = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == tenant.id)
    undated_purchase_query = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == tenant.id)
    purchases: list[InboundInvoice] = []
    undated_purchases: list[InboundInvoice] = []
    if purchases_enabled and not customer_id:
        for period_filter in _purchase_issue_date_filters(start, end):
            purchase_query = purchase_query.filter(period_filter)
        for period_filter in _undated_purchase_received_filters(start, end):
            undated_purchase_query = undated_purchase_query.filter(period_filter)
        purchases = purchase_query.order_by(InboundInvoice.issue_date.asc(), InboundInvoice.received_at.asc()).all()
        undated_purchases = undated_purchase_query.order_by(
            InboundInvoice.received_at.asc(), InboundInvoice.created_at.asc()
        ).all()
    purchase_payments: list[PurchasePayment] = []
    if purchases_enabled and payments_enabled:
        purchase_payment_query = (
            db.query(PurchasePayment)
            .join(InboundInvoice, PurchasePayment.inbound_invoice_id == InboundInvoice.id)
            .filter(PurchasePayment.tenant_id == tenant.id, InboundInvoice.tenant_id == tenant.id)
        )
        if customer_id:
            purchase_payment_query = purchase_payment_query.filter(
                PurchasePayment.id == "__excluded_by_customer_filter__"
            )
        if start_dt:
            purchase_payment_query = purchase_payment_query.filter(PurchasePayment.date >= start_dt)
        if end_dt:
            purchase_payment_query = purchase_payment_query.filter(PurchasePayment.date <= end_dt)
        purchase_payments = purchase_payment_query.order_by(PurchasePayment.date.asc()).all()
    purchases_by_id = {purchase.id: purchase for purchase in purchases + undated_purchases}
    for payment in purchase_payments:
        linked_purchase = payment.inbound_invoice
        if linked_purchase and linked_purchase.tenant_id == tenant.id and linked_purchase.id not in purchases_by_id:
            purchases_by_id[linked_purchase.id] = linked_purchase
            if linked_purchase.issue_date:
                purchases.append(linked_purchase)
            else:
                undated_purchases.append(linked_purchase)
    all_period_purchases = sorted(
        purchases_by_id.values(),
        key=lambda purchase: (
            purchase.issue_date or (purchase.received_at.date() if purchase.received_at else date.min),
            purchase.invoice_number or purchase.id,
        ),
    )
    purchase_line_rows = _purchase_line_rows(all_period_purchases)
    purchase_supplier_rows = _purchase_supplier_rows(db, tenant_id=tenant.id, purchases=all_period_purchases)
    purchase_employee_payer_rows = _purchase_employee_payer_rows(
        db, tenant_id=tenant.id, purchases=all_period_purchases
    )
    employee_reimbursements = [
        purchase
        for purchase in all_period_purchases
        if purchase.paid_by_employee or purchase.employee_reimbursement_amount is not None
    ]
    invoices_by_id = {invoice.id: invoice for invoice in invoices}
    for _, invoice in payments:
        invoices_by_id[invoice.id] = invoice
    for _, invoice in refunds:
        invoices_by_id[invoice.id] = invoice
    invoices = sorted(
        invoices_by_id.values(),
        key=lambda invoice: (invoice.issue_date or datetime.min, invoice.number or invoice.id),
    )
    invoice_ids = [invoice.id for invoice in invoices]
    invoice_lines = (
        db.query(InvoiceLine)
        .filter(InvoiceLine.invoice_id.in_(invoice_ids))
        .order_by(InvoiceLine.invoice_id.asc(), InvoiceLine.id.asc())
        .all()
        if invoice_ids
        else []
    )
    deposit_applications = (
        db.query(InvoiceDepositApplication)
        .filter(
            InvoiceDepositApplication.tenant_id == tenant.id,
            InvoiceDepositApplication.final_invoice_id.in_(invoice_ids),
        )
        .order_by(InvoiceDepositApplication.final_invoice_id.asc(), InvoiceDepositApplication.created_at.asc())
        .all()
        if invoice_ids
        else []
    )
    all_payment_totals = (
        {
            row[0]: _decimal_amount(row[1])
            for row in db.query(Payment.invoice_id, func.sum(Payment.amount))
            .filter(Payment.invoice_id.in_(invoice_ids))
            .group_by(Payment.invoice_id)
            .all()
        }
        if invoice_ids and payments_enabled
        else {}
    )
    all_credit_totals = (
        {
            row[0]: _decimal_amount(row[1])
            for row in db.query(Invoice.related_invoice_id, func.sum(func.abs(Invoice.total_inc_vat)))
            .filter(
                Invoice.tenant_id == tenant.id,
                Invoice.type == "credit_note",
                Invoice.status.notin_(ACCOUNTING_EXPORT_EXCLUDED_INVOICE_STATUSES),
                Invoice.related_invoice_id.in_(invoice_ids),
            )
            .group_by(Invoice.related_invoice_id)
            .all()
        }
        if invoice_ids
        else {}
    )
    effective_options_by_id = {invoice.id: invoice_effective_template_options(db, invoice) for invoice in invoices}
    advance_totals_by_id = {
        invoice.id: invoice_advance_payments_total_ttc(effective_options_by_id.get(invoice.id)) for invoice in invoices
    }
    deposit_totals_by_id = {
        invoice.id: final_invoice_applied_deposit_totals(db, invoice)
        for invoice in invoices
        if (invoice.invoice_kind or "standard") == "final"
    }
    balance_due_by_id = {
        invoice.id: invoice_balance_due_amount(
            invoice.total_inc_vat,
            effective_options_by_id.get(invoice.id),
            credits=all_credit_totals.get(invoice.id, Decimal("0")),
            paid=all_payment_totals.get(invoice.id, Decimal("0")),
        )
        for invoice in invoices
        if (invoice.type or "invoice") == "invoice"
    }
    customers = (
        {
            customer.id: customer
            for customer in db.query(Customer)
            .filter(Customer.tenant_id == tenant.id, Customer.id.in_(customer_ids))
            .order_by(Customer.name.asc())
            .all()
        }
        if customer_ids
        else {}
    )
    history = _history_rows(db, tenant_id=tenant.id, start=start, end=end, customer_id=customer_id)
    quality_checks = _accounting_quality_checks(
        invoices=invoices,
        invoice_lines=invoice_lines,
        payments=payments,
        purchases=purchases,
        undated_purchases=undated_purchases,
        purchase_payments=purchase_payments,
    )

    counts = {
        "customers": len(customers),
        "invoices": len(invoices),
        "invoice_lines": len(invoice_lines),
        "deposit_applications": len(deposit_applications),
        "payments": len(payments),
        "credit_note_refunds": len(refunds),
        "purchase_suppliers": len(purchase_supplier_rows),
        "purchase_employee_payers": len(purchase_employee_payer_rows),
        "purchases": len(purchases),
        "undated_purchases": len(undated_purchases),
        "purchase_lines": len(purchase_line_rows),
        "purchase_payments": len(purchase_payments),
        "employee_reimbursements": len(employee_reimbursements),
        "accounting_exports": len(history),
        "quality_warnings": int(quality_checks["warnings_count"]),
    }
    generated_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    manifest = {
        "generated_at": generated_at,
        "tenant_id": tenant.id,
        "format": "cabinet_zip",
        "source": "pixfacture/accounting-cabinet-package",
        "version": "1",
        "period_start": start.isoformat() if start else None,
        "period_end": end.isoformat() if end else None,
        "customer_id": customer_id,
        "purchase_scope": (
            "not_in_plan" if not purchases_enabled else "excluded_by_customer_filter" if customer_id else "period"
        ),
        "generated_by": None if user.is_api_key else user.email,
        "counts": counts,
        "quality_checks": quality_checks,
        "notice": "Dossier de travail cabinet: export hors télédéclaration et à valider par le cabinet.",
    }
    customer_name = customers.get(customer_id).name if customer_id and customer_id in customers else None
    readme_content = [
        "- manifest.json: résumé technique du paquet.",
        "- entreprise.json: paramètres d'entreprise utiles au contrôle.",
        "- clients.csv: clients concernés.",
        "- ventes/factures.csv: factures et avoirs sur la période.",
        "- ventes/lignes_factures.csv: lignes de factures liées.",
        "- ventes/acompte_applications.csv: acomptes déduits des factures finales, nets des avoirs.",
    ]
    if payments_enabled:
        readme_content.extend(
            [
                "- ventes/paiements.csv: paiements reçus sur la période.",
                "- ventes/remboursements_avoirs.csv: remboursements d'avoirs sur la période.",
            ]
        )
    if purchases_enabled:
        readme_content.extend(
            [
                "- achats/fournisseurs.csv: fournisseurs concernés par les achats de la période.",
                "- achats/payeurs_employes.csv: payeurs collaborateurs référencés sur les achats.",
                "- achats/factures_fournisseurs.csv: factures fournisseurs et notes/frais saisis.",
                "- achats/lignes_achats.csv: ventilation achat HT/TVA/compte et qualification TVA importée quand disponible.",
                "- achats/achats_sans_date_emission.csv: achats sans date d'émission, isolés par date de réception.",
            ]
        )
        if payments_enabled:
            readme_content.extend(
                [
                    "- achats/reglements_fournisseurs.csv: paiements fournisseurs enregistrés sur la période.",
                    "- achats/remboursements_collaborateurs.csv: achats payés par collaborateur à rembourser.",
                ]
            )
    readme_content.extend(
        [
            "- controles/points_a_corriger.csv: points comptables à corriger avant remise définitive.",
            "- exports/historique_exports.csv: historique des exports comptables liés à la période.",
        ]
    )
    readme_notes = [f"Contrôles comptables: {quality_checks['warnings_count']} point(s) à corriger."]
    if not purchases_enabled:
        readme_notes.append("Le module Achats n'est pas inclus dans le plan actif et ne figure pas dans ce paquet.")
    elif customer_id:
        readme_notes.append(
            "Les achats sont exclus lorsque le dossier est filtré sur un client de vente, "
            "car ils ne sont pas rattachés à un client."
        )
    if not payments_enabled:
        readme_notes.append("Le module Paiements n'est pas inclus dans le plan actif et ne figure pas dans ce paquet.")
    readme_notes.append("Ce paquet ne constitue pas une télédéclaration et ne remplace pas la validation du cabinet.")
    readme = "\n".join(
        [
            "Dossier de contrôle compta",
            "===========================",
            "",
            f"Généré le: {generated_at}",
            f"Entreprise: {tenant.name}",
            f"Période: {start.isoformat() if start else 'début libre'} -> {end.isoformat() if end else 'fin libre'}",
            f"Client: {customer_name or 'tous les clients'}",
            "",
            "Contenu:",
            *readme_content,
            "",
            *readme_notes,
        ]
    )
    invoice_customer_names = {customer_id: customer.name for customer_id, customer in customers.items()}
    invoice_number_by_id = {invoice.id: invoice.number or invoice.id for invoice in invoices}

    purchase_headers = [
        "id",
        "received_at",
        "issue_date",
        "supplier_name",
        "supplier_siren",
        "supplier_siret",
        "invoice_number",
        "total_ex_vat",
        "total_vat",
        "total_ttc",
        "currency",
        "status",
        "validation_status",
        "completion_status",
        "completion_validated_at",
        "format",
        "facturx_profile",
        "purchase_nature",
        "accounting_account",
        "planned_payment_date",
        "paid_by_employee",
        "employee_payer_name",
        "employee_payer_role",
        "employee_reimbursement_amount",
        "employee_reimbursement_due_date",
        "employee_reimbursement_method",
        "employee_reimbursement_status",
        "purchase_tags",
        "duplicate_of_id",
        "accountant_note",
        "provider_slug",
    ]

    mem = io.BytesIO()
    with zipfile.ZipFile(mem, mode="w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("README-cabinet.txt", readme)
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2, default=_json_default))
        z.writestr(
            "entreprise.json",
            json.dumps(_safe_company_payload(tenant), ensure_ascii=False, indent=2, default=_json_default),
        )
        z.writestr(
            "clients.csv",
            _csv_text(
                [
                    "id",
                    "name",
                    "email",
                    "siren",
                    "siret",
                    "vat_number",
                    "country",
                    "address_line1",
                    "address_line2",
                    "postal_code",
                    "city",
                    "phone",
                ],
                [
                    [
                        customer.id,
                        customer.name,
                        customer.email,
                        customer.siren,
                        customer.siret,
                        customer.vat_number,
                        customer.country,
                        customer.address_line1 or customer.address,
                        customer.address_line2,
                        customer.postal_code,
                        customer.city,
                        customer.phone,
                    ]
                    for customer in customers.values()
                ],
            ),
        )
        z.writestr(
            "ventes/factures.csv",
            _csv_text(
                [
                    "id",
                    "number",
                    "type",
                    "invoice_kind",
                    "quote_id",
                    "status",
                    "issue_date",
                    "due_date",
                    "customer",
                    "purchase_order_number",
                    "total_ex_vat",
                    "total_vat",
                    "total_inc_vat",
                    "advance_total_ttc",
                    "balance_due",
                    "deposit_invoice_ids",
                    "currency",
                    "payment_terms",
                ],
                [
                    [
                        invoice.id,
                        invoice.number,
                        invoice.type,
                        invoice.invoice_kind,
                        invoice.quote_id,
                        _invoice_status_for_export(invoice, payments_enabled=payments_enabled),
                        invoice.issue_date.isoformat() if invoice.issue_date else "",
                        invoice.due_date.isoformat() if invoice.due_date else "",
                        invoice_customer_names.get(invoice.customer_id, invoice.customer_id),
                        invoice.purchase_order_number,
                        invoice.total_ex_vat,
                        invoice.total_vat,
                        invoice.total_inc_vat,
                        advance_totals_by_id.get(invoice.id, Decimal("0")),
                        balance_due_by_id.get(invoice.id, Decimal("0"))
                        if payments_enabled and invoice.type == "invoice"
                        else "",
                        "|".join(deposit_totals_by_id.get(invoice.id, {}).get("deposit_invoice_ids", [])),
                        invoice.currency,
                        invoice.payment_terms,
                    ]
                    for invoice in invoices
                ],
            ),
        )
        z.writestr(
            "ventes/lignes_factures.csv",
            _csv_text(
                [
                    "invoice_id",
                    "invoice_number",
                    "line_type",
                    "reference",
                    "product_name",
                    "detail",
                    "quantity",
                    "unit_price",
                    "vat_rate",
                    "vat_category",
                    "exemption_reason_code",
                    "unit_code",
                    "accounting_account",
                    "line_total",
                ],
                [
                    [
                        line.invoice_id,
                        invoice_number_by_id.get(line.invoice_id, line.invoice_id),
                        line.line_type,
                        line.reference,
                        line.product_name,
                        line.detail,
                        line.quantity,
                        line.unit_price,
                        line.vat_rate,
                        line.vat_category,
                        line.exemption_reason_code,
                        line.unit_code,
                        line.accounting_account,
                        line.line_total,
                    ]
                    for line in invoice_lines
                ],
            ),
        )
        z.writestr(
            "ventes/acompte_applications.csv",
            _csv_text(
                [
                    "application_id",
                    "quote_id",
                    "final_invoice_id",
                    "final_invoice_number",
                    "deposit_invoice_id",
                    "deposit_invoice_number",
                    "deposit_issue_date",
                    "amount_ht",
                    "amount_vat",
                    "amount_ttc",
                    "credited_ht",
                    "credited_vat",
                    "credited_ttc",
                    "net_amount_ht",
                    "net_amount_vat",
                    "net_amount_ttc",
                    "vat_rate",
                ],
                [
                    [
                        app.id,
                        app.quote_id,
                        app.final_invoice_id,
                        invoice_number_by_id.get(app.final_invoice_id, app.final_invoice_id),
                        app.deposit_invoice_id,
                        app.deposit_number or invoice_number_by_id.get(app.deposit_invoice_id, app.deposit_invoice_id),
                        app.deposit_issue_date.isoformat() if app.deposit_issue_date else "",
                        app.amount_ht,
                        app.amount_vat,
                        app.amount_ttc,
                        deposit_application_effective_amounts(db, app)["credited_ht"],
                        deposit_application_effective_amounts(db, app)["credited_vat"],
                        deposit_application_effective_amounts(db, app)["credited_ttc"],
                        deposit_application_effective_amounts(db, app)["net_ht"],
                        deposit_application_effective_amounts(db, app)["net_vat"],
                        deposit_application_effective_amounts(db, app)["net_ttc"],
                        deposit_application_effective_amounts(db, app)["vat_rate"] or "",
                    ]
                    for app in deposit_applications
                ],
            ),
        )
        if payments_enabled:
            z.writestr(
                "ventes/paiements.csv",
                _csv_text(
                    [
                        "payment_id",
                        "invoice_id",
                        "invoice_number",
                        "date",
                        "method",
                        "settlement_mode",
                        "accounting_category",
                        "amount",
                        "reference",
                        "provider",
                        "receipt_label",
                    ],
                    [
                        [
                            payment.id,
                            invoice.id,
                            invoice.number,
                            payment.date.isoformat() if payment.date else "",
                            payment.method,
                            payment.settlement_mode,
                            payment.accounting_category,
                            payment.amount,
                            payment.reference,
                            payment.provider,
                            payment.receipt_label,
                        ]
                        for payment, invoice in payments
                    ],
                ),
            )
            z.writestr(
                "ventes/remboursements_avoirs.csv",
                _csv_text(
                    ["refund_id", "credit_note_id", "credit_note_number", "date", "method", "amount", "reference"],
                    [
                        [
                            refund.id,
                            invoice.id,
                            invoice.number,
                            refund.date.isoformat() if refund.date else "",
                            refund.method,
                            refund.amount,
                            refund.reference,
                        ]
                        for refund, invoice in refunds
                    ],
                ),
            )
        if purchases_enabled:
            z.writestr(
                "achats/fournisseurs.csv",
                _csv_text(
                    [
                        "supplier_key",
                        "name",
                        "siren",
                        "siret",
                        "vat_number",
                        "default_accounting_account",
                        "default_purchase_nature",
                        "default_payment_delay_days",
                        "last_used_at",
                        "source",
                    ],
                    purchase_supplier_rows,
                ),
            )
            z.writestr(
                "achats/payeurs_employes.csv",
                _csv_text(
                    [
                        "name",
                        "role",
                        "default_accounting_account",
                        "reimbursement_method",
                        "vehicle_type",
                        "fiscal_power",
                        "last_used_at",
                        "source",
                    ],
                    purchase_employee_payer_rows,
                ),
            )
            z.writestr(
                "achats/factures_fournisseurs.csv",
                _csv_text(purchase_headers, _purchase_csv_rows(purchases)),
            )
            z.writestr(
                "achats/lignes_achats.csv",
                _csv_text(
                    [
                        "purchase_id",
                        "invoice_number",
                        "line_index",
                        "label",
                        "total_ex_vat",
                        "vat_rate",
                        "total_vat",
                        "total_ttc",
                        "accounting_account",
                        "purchase_nature",
                        "vat_category",
                        "exemption_reason_code",
                        "vat_exemption_reason",
                        "vat_zero_reason",
                        "vat_reverse_charge",
                        "line_source",
                    ],
                    purchase_line_rows,
                ),
            )
            z.writestr(
                "achats/achats_sans_date_emission.csv",
                _csv_text(purchase_headers, _purchase_csv_rows(undated_purchases)),
            )
            if payments_enabled:
                z.writestr(
                    "achats/reglements_fournisseurs.csv",
                    _csv_text(
                        [
                            "payment_id",
                            "purchase_id",
                            "invoice_number",
                            "supplier_name",
                            "supplier_siren",
                            "supplier_siret",
                            "invoice_issue_date",
                            "invoice_total_ttc",
                            "currency",
                            "date",
                            "amount",
                            "method",
                            "reference",
                            "settlement_mode",
                            "accounting_category",
                            "receipt_label",
                            "receipt_url",
                        ],
                        _purchase_payment_rows(purchase_payments),
                    ),
                )
                z.writestr(
                    "achats/remboursements_collaborateurs.csv",
                    _csv_text(
                        [
                            "purchase_id",
                            "invoice_number",
                            "employee_payer_name",
                            "employee_payer_role",
                            "reimbursement_amount",
                            "reimbursement_due_date",
                            "reimbursement_method",
                            "reimbursement_status",
                            "paid_by_employee",
                            "planned_payment_date",
                            "total_ttc",
                            "currency",
                            "accounting_account",
                        ],
                        [
                            [
                                purchase.id,
                                purchase.invoice_number,
                                purchase.employee_payer_name,
                                purchase.employee_payer_role,
                                purchase.employee_reimbursement_amount,
                                purchase.employee_reimbursement_due_date.isoformat()
                                if purchase.employee_reimbursement_due_date
                                else "",
                                purchase.employee_reimbursement_method,
                                purchase.employee_reimbursement_status,
                                bool(purchase.paid_by_employee),
                                purchase.planned_payment_date.isoformat()
                                if purchase.planned_payment_date
                                else "",
                                purchase.total_ttc,
                                purchase.currency,
                                purchase.accounting_account,
                            ]
                            for purchase in employee_reimbursements
                        ],
                    ),
                )
        z.writestr(
            "controles/points_a_corriger.csv",
            _csv_text(
                ["code", "scope", "label", "count", "examples", "action"],
                _accounting_quality_rows(quality_checks),
            ),
        )
        z.writestr(
            "exports/historique_exports.csv",
            _csv_text(
                [
                    "created_at",
                    "format",
                    "label",
                    "status",
                    "cabinet_validation_status",
                    "cabinet_reviewed_at",
                    "period_start",
                    "period_end",
                    "customer_id",
                    "record_count",
                    "delivered_to_accountant_at",
                    "cabinet_comment",
                    "filters",
                ],
                [
                    [
                        row.created_at.isoformat() if row.created_at else "",
                        row.format,
                        _export_label(row.format),
                        row.status,
                        row.cabinet_validation_status or "pending_review",
                        row.cabinet_reviewed_at.isoformat() if row.cabinet_reviewed_at else "",
                        row.period_start.isoformat() if row.period_start else "",
                        row.period_end.isoformat() if row.period_end else "",
                        row.customer_id,
                        row.record_count,
                        row.delivered_to_accountant_at.isoformat() if row.delivered_to_accountant_at else "",
                        row.cabinet_comment,
                        json.dumps(
                            _accounting_filters_for_capabilities(
                                row.filters_json if isinstance(row.filters_json, dict) else {},
                                purchases_enabled=purchases_enabled,
                                payments_enabled=payments_enabled,
                            ),
                            ensure_ascii=False,
                            default=_json_default,
                        ),
                    ]
                    for row in history
                ],
            ),
        )
    mem.seek(0)
    return mem.getvalue(), counts, quality_checks


def _accounting_quality_ready(quality_checks: dict[str, Any]) -> bool:
    return (
        str(quality_checks.get("status") or "").lower() == "ready"
        and int(quality_checks.get("warnings_count") or 0) == 0
    )


def _accounting_quality_block_detail(quality_checks: dict[str, Any]) -> dict[str, Any]:
    warnings_count = int(quality_checks.get("warnings_count") or 0)
    return {
        "code": "accounting_quality_checks_failed",
        "message": (
            f"Export strict bloqué: {warnings_count} point(s) comptable(s) restent à corriger. "
            "Corrigez-les ou exportez le dossier de contrôle compta en mode brouillon."
        ),
        "quality_checks": quality_checks,
    }


@router.get("/accounting/cabinet.zip")
def download_accounting_cabinet_package(
    start_date: str | None = Query(None, description="Début de période à remettre au cabinet (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="Fin de période à remettre au cabinet (YYYY-MM-DD)"),
    customer_id: str | None = Query(None, description="Client à isoler dans le dossier de contrôle compta"),
    force_export: bool = Query(False, description="Forcer l'export malgré une période déjà remise"),
    strict_quality: bool = Query(
        True,
        description="Bloquer l'export si des contrôles comptables restent à corriger. Désactivez explicitement pour un brouillon.",
    ),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_paid_subscription_or_trial(user, db)
    _require_heavy_export_storage()
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    start = _parse_accounting_query_date(start_date, "start_date")
    end = _parse_accounting_query_date(end_date, "end_date")
    _accounting_datetime_bounds(start, end)
    if force_export:
        _ensure_accounting_lock_override_allowed(user)
    if customer_id:
        exists = db.query(Customer.id).filter(Customer.tenant_id == user.tenant_id, Customer.id == customer_id).first()
        if not exists:
            raise HTTPException(status_code=404, detail="Client introuvable")
    if not force_export:
        lock = find_delivered_accounting_period_lock(
            db,
            tenant_id=user.tenant_id,
            period_start=start,
            period_end=end,
            customer_id=customer_id,
        )
        if lock:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "accounting_period_locked",
                    "message": (
                        "Cette période a déjà été marquée remise au cabinet. "
                        "Déverrouillez l'export dans l'historique avant de régénérer le dossier de contrôle compta."
                    ),
                    "lock": accounting_period_lock_payload(lock),
                },
            )
    content, counts, quality_checks = _build_cabinet_package(
        db,
        tenant=tenant,
        user=user,
        start=start,
        end=end,
        customer_id=customer_id,
    )
    if strict_quality and not _accounting_quality_ready(quality_checks):
        raise HTTPException(status_code=409, detail=_accounting_quality_block_detail(quality_checks))
    record_count = sum(int(value or 0) for value in counts.values())
    record_accounting_export(
        db,
        tenant_id=user.tenant_id,
        export_format="cabinet_zip",
        created_by=None if user.is_api_key else user.id,
        period_start=start,
        period_end=end,
        customer_id=customer_id,
        record_count=record_count,
        filters={
            "format": "cabinet_zip",
            "version": "1",
            "start_date": start.isoformat() if start else None,
            "end_date": end.isoformat() if end else None,
            "customer_id": customer_id,
            "counts": counts,
            "quality_checks": quality_checks,
            "strict_quality": bool(strict_quality),
        },
        commit=True,
    )
    filename = f"dossier-controle-compta-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.zip"
    return Response(
        content=content,
        media_type="application/zip",
        headers=_export_attachment_headers(filename),
    )


@router.get("/accounting/cabinet/preflight")
def preflight_accounting_cabinet_package(
    start_date: str | None = Query(None, description="Début de période à contrôler (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="Fin de période à contrôler (YYYY-MM-DD)"),
    customer_id: str | None = Query(None, description="Client à isoler dans le contrôle cabinet"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_paid_subscription_or_trial(user, db)
    _require_heavy_export_storage()
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    start = _parse_accounting_query_date(start_date, "start_date")
    end = _parse_accounting_query_date(end_date, "end_date")
    _accounting_datetime_bounds(start, end)
    if customer_id:
        exists = db.query(Customer.id).filter(Customer.tenant_id == user.tenant_id, Customer.id == customer_id).first()
        if not exists:
            raise HTTPException(status_code=404, detail="Client introuvable")
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=user.tenant_id,
        period_start=start,
        period_end=end,
        customer_id=customer_id,
    )
    _, counts, quality_checks = _build_cabinet_package(
        db,
        tenant=tenant,
        user=user,
        start=start,
        end=end,
        customer_id=customer_id,
    )
    ready = _accounting_quality_ready(quality_checks)
    return {
        "status": "ready" if ready else "needs_review",
        "strict_export_allowed": ready,
        "counts": counts,
        "quality_checks": quality_checks,
        "period_lock": accounting_period_lock_payload(lock) if lock else None,
    }


@router.get("/accounting/chart-summary")
def accounting_chart_summary(
    start_date: str | None = Query(None, description="Début de période à contrôler (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="Fin de période à contrôler (YYYY-MM-DD)"),
    customer_id: str | None = Query(None, description="Client à isoler dans le contrôle cabinet"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_paid_subscription_or_trial(user, db)
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    purchases_enabled = is_product_feature_enabled(tenant, "purchases_enabled")
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    start = _parse_accounting_query_date(start_date, "start_date")
    end = _parse_accounting_query_date(end_date, "end_date")
    start_dt, end_dt = _accounting_datetime_bounds(start, end)
    if customer_id:
        exists = db.query(Customer.id).filter(Customer.tenant_id == user.tenant_id, Customer.id == customer_id).first()
        if not exists:
            raise HTTPException(status_code=404, detail="Client introuvable")

    invoice_lines = (
        db.query(
            InvoiceLine.accounting_account,
            func.count(InvoiceLine.id),
            func.coalesce(func.sum(InvoiceLine.line_total), 0),
        )
        .join(Invoice, InvoiceLine.invoice_id == Invoice.id)
        .filter(Invoice.tenant_id == tenant.id, InvoiceLine.line_total != 0)
    )
    invoice_missing = (
        db.query(InvoiceLine.id)
        .join(Invoice, InvoiceLine.invoice_id == Invoice.id)
        .filter(
            Invoice.tenant_id == tenant.id,
            InvoiceLine.line_total != 0,
            _account_needs_completion_filter(InvoiceLine.accounting_account),
        )
    )
    invoice_source_count = (
        db.query(InvoiceLine.id)
        .join(Invoice, InvoiceLine.invoice_id == Invoice.id)
        .filter(
            Invoice.tenant_id == tenant.id,
            InvoiceLine.line_total != 0,
        )
    )
    if customer_id:
        invoice_lines = invoice_lines.filter(Invoice.customer_id == customer_id)
        invoice_missing = invoice_missing.filter(Invoice.customer_id == customer_id)
        invoice_source_count = invoice_source_count.filter(Invoice.customer_id == customer_id)
    if start_dt:
        invoice_lines = invoice_lines.filter(Invoice.issue_date >= start_dt)
        invoice_missing = invoice_missing.filter(Invoice.issue_date >= start_dt)
        invoice_source_count = invoice_source_count.filter(Invoice.issue_date >= start_dt)
    if end_dt:
        invoice_lines = invoice_lines.filter(Invoice.issue_date <= end_dt)
        invoice_missing = invoice_missing.filter(Invoice.issue_date <= end_dt)
        invoice_source_count = invoice_source_count.filter(Invoice.issue_date <= end_dt)

    sales_accounts: dict[str, dict[str, Any]] = {}
    for account, count, amount in (
        invoice_lines.filter(*_exportable_account_filter(InvoiceLine.accounting_account))
        .group_by(InvoiceLine.accounting_account)
        .all()
    ):
        _add_account_usage(sales_accounts, account=account, count=count, amount=amount, source="factures")

    quote_accounts: dict[str, dict[str, Any]] = {}
    quote_lines = (
        db.query(
            QuoteLine.accounting_account,
            func.count(QuoteLine.id),
            func.coalesce(func.sum(QuoteLine.line_total), 0),
        )
        .join(Quote, QuoteLine.quote_id == Quote.id)
        .filter(Quote.tenant_id == tenant.id, QuoteLine.line_total != 0)
    )
    quote_missing = (
        db.query(QuoteLine.id)
        .join(Quote, QuoteLine.quote_id == Quote.id)
        .filter(
            Quote.tenant_id == tenant.id,
            QuoteLine.line_total != 0,
            _account_needs_completion_filter(QuoteLine.accounting_account),
        )
    )
    quote_source_count = (
        db.query(QuoteLine.id)
        .join(Quote, QuoteLine.quote_id == Quote.id)
        .filter(
            Quote.tenant_id == tenant.id,
            QuoteLine.line_total != 0,
        )
    )
    if customer_id:
        quote_lines = quote_lines.filter(Quote.customer_id == customer_id)
        quote_missing = quote_missing.filter(Quote.customer_id == customer_id)
        quote_source_count = quote_source_count.filter(Quote.customer_id == customer_id)
    if start_dt:
        quote_lines = quote_lines.filter(Quote.issue_date >= start_dt)
        quote_missing = quote_missing.filter(Quote.issue_date >= start_dt)
        quote_source_count = quote_source_count.filter(Quote.issue_date >= start_dt)
    if end_dt:
        quote_lines = quote_lines.filter(Quote.issue_date <= end_dt)
        quote_missing = quote_missing.filter(Quote.issue_date <= end_dt)
        quote_source_count = quote_source_count.filter(Quote.issue_date <= end_dt)
    for account, count, amount in (
        quote_lines.filter(*_exportable_account_filter(QuoteLine.accounting_account))
        .group_by(QuoteLine.accounting_account)
        .all()
    ):
        _add_account_usage(quote_accounts, account=account, count=count, amount=amount, source="devis")

    payments = db.query(Payment).join(Invoice, Payment.invoice_id == Invoice.id).filter(Invoice.tenant_id == tenant.id)
    payment_categories = (
        db.query(Payment.accounting_category, func.count(Payment.id), func.coalesce(func.sum(Payment.amount), 0))
        .join(Invoice, Payment.invoice_id == Invoice.id)
        .filter(Invoice.tenant_id == tenant.id)
    )
    if not payments_enabled:
        payments = payments.filter(Payment.id == "__plan_feature_disabled__")
        payment_categories = payment_categories.filter(Payment.id == "__plan_feature_disabled__")
    if customer_id:
        payments = payments.filter(Invoice.customer_id == customer_id)
        payment_categories = payment_categories.filter(Invoice.customer_id == customer_id)
    if start_dt:
        payments = payments.filter(Payment.date >= start_dt)
        payment_categories = payment_categories.filter(Payment.date >= start_dt)
    if end_dt:
        payments = payments.filter(Payment.date <= end_dt)
        payment_categories = payment_categories.filter(Payment.date <= end_dt)

    payment_accounts: dict[str, dict[str, Any]] = {}
    for category, count, amount in (
        payment_categories.filter(*_exportable_account_filter(Payment.accounting_category))
        .group_by(Payment.accounting_category)
        .all()
    ):
        _add_account_usage(payment_accounts, account=category, count=count, amount=amount, source="paiements")
    purchase_payments = (
        db.query(PurchasePayment)
        .join(InboundInvoice, PurchasePayment.inbound_invoice_id == InboundInvoice.id)
        .filter(
            PurchasePayment.tenant_id == tenant.id,
            InboundInvoice.tenant_id == tenant.id,
        )
    )
    purchase_payment_categories = (
        db.query(
            PurchasePayment.accounting_category,
            func.count(PurchasePayment.id),
            func.coalesce(func.sum(PurchasePayment.amount), 0),
        )
        .join(InboundInvoice, PurchasePayment.inbound_invoice_id == InboundInvoice.id)
        .filter(PurchasePayment.tenant_id == tenant.id, InboundInvoice.tenant_id == tenant.id)
    )
    if not purchases_enabled or not payments_enabled:
        purchase_payments = purchase_payments.filter(PurchasePayment.id == "__plan_feature_disabled__")
        purchase_payment_categories = purchase_payment_categories.filter(
            PurchasePayment.id == "__plan_feature_disabled__"
        )
    if customer_id:
        purchase_payments = purchase_payments.filter(PurchasePayment.id == "__excluded_by_customer_filter__")
        purchase_payment_categories = purchase_payment_categories.filter(
            PurchasePayment.id == "__excluded_by_customer_filter__"
        )
    if start_dt:
        purchase_payments = purchase_payments.filter(PurchasePayment.date >= start_dt)
        purchase_payment_categories = purchase_payment_categories.filter(PurchasePayment.date >= start_dt)
    if end_dt:
        purchase_payments = purchase_payments.filter(PurchasePayment.date <= end_dt)
        purchase_payment_categories = purchase_payment_categories.filter(PurchasePayment.date <= end_dt)
    for category, count, amount in (
        purchase_payment_categories.filter(*_exportable_account_filter(PurchasePayment.accounting_category))
        .group_by(PurchasePayment.accounting_category)
        .all()
    ):
        _add_account_usage(
            payment_accounts, account=category, count=count, amount=amount, source="règlements fournisseurs"
        )

    purchase_accounts: dict[str, dict[str, Any]] = {}
    purchases: list[InboundInvoice] = []
    if purchases_enabled and not customer_id:
        purchase_query = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == tenant.id)
        undated_purchase_query = db.query(InboundInvoice).filter(InboundInvoice.tenant_id == tenant.id)
        for period_filter in _purchase_issue_date_filters(start, end):
            purchase_query = purchase_query.filter(period_filter)
        for period_filter in _undated_purchase_received_filters(start, end):
            undated_purchase_query = undated_purchase_query.filter(period_filter)
        purchases = purchase_query.all() + undated_purchase_query.all()

    purchase_missing_account_count = 0
    purchase_not_completed_count = 0
    purchase_missing_issue_date_count = 0
    purchase_source_count = 0
    for purchase in purchases:
        if str(purchase.completion_status or "").lower() != "completed":
            purchase_not_completed_count += 1
        if purchase.issue_date is None:
            purchase_missing_issue_date_count += 1
        raw_lines = purchase.purchase_lines if isinstance(purchase.purchase_lines, list) else []
        if raw_lines:
            for raw_line in raw_lines:
                line = raw_line if isinstance(raw_line, dict) else {}
                amount = line.get("total_ex_vat")
                if not _money_is_nonzero(amount):
                    continue
                purchase_source_count += 1
                account = _purchase_line_effective_account(purchase, line)
                if _accounting_account_needs_completion(account):
                    purchase_missing_account_count += 1
                else:
                    _add_account_usage(purchase_accounts, account=account, amount=amount, source="achats")
        elif _money_is_nonzero(purchase.total_ex_vat):
            purchase_source_count += 1
            if _accounting_account_needs_completion(purchase.accounting_account):
                purchase_missing_account_count += 1
            else:
                _add_account_usage(
                    purchase_accounts,
                    account=purchase.accounting_account,
                    amount=purchase.total_ex_vat,
                    source="achats",
                )

    third_party_accounts: dict[str, dict[str, Any]] = {}
    supplier_base = db.query(PurchaseSupplier).filter(
        PurchaseSupplier.tenant_id == tenant.id,
        PurchaseSupplier.is_active.is_(True),
    )
    payer_base = db.query(PurchaseEmployeePayer).filter(
        PurchaseEmployeePayer.tenant_id == tenant.id,
        PurchaseEmployeePayer.is_active.is_(True),
    )
    if not purchases_enabled:
        supplier_base = supplier_base.filter(PurchaseSupplier.id == "__plan_feature_disabled__")
        payer_base = payer_base.filter(PurchaseEmployeePayer.id == "__plan_feature_disabled__")
    if customer_id:
        supplier_missing_count = 0
        payer_missing_count = 0
        supplier_source_count = 0
        payer_source_count = 0
    else:
        supplier_missing_count = supplier_base.filter(
            _account_needs_completion_filter(PurchaseSupplier.default_accounting_account)
        ).count()
        supplier_defaults = db.query(
            PurchaseSupplier.default_accounting_account, func.count(PurchaseSupplier.id)
        ).filter(PurchaseSupplier.tenant_id == tenant.id, PurchaseSupplier.is_active.is_(True))
        if not purchases_enabled:
            supplier_defaults = supplier_defaults.filter(PurchaseSupplier.id == "__plan_feature_disabled__")
        for account, count in (
            supplier_defaults.filter(*_exportable_account_filter(PurchaseSupplier.default_accounting_account))
            .group_by(PurchaseSupplier.default_accounting_account)
            .all()
        ):
            _add_account_usage(third_party_accounts, account=account, count=count, source="fournisseurs")

        payer_missing_count = payer_base.filter(
            _account_needs_completion_filter(PurchaseEmployeePayer.default_accounting_account)
        ).count()
        payer_defaults = db.query(
            PurchaseEmployeePayer.default_accounting_account, func.count(PurchaseEmployeePayer.id)
        ).filter(PurchaseEmployeePayer.tenant_id == tenant.id, PurchaseEmployeePayer.is_active.is_(True))
        if not purchases_enabled:
            payer_defaults = payer_defaults.filter(PurchaseEmployeePayer.id == "__plan_feature_disabled__")
        for account, count in (
            payer_defaults.filter(*_exportable_account_filter(PurchaseEmployeePayer.default_accounting_account))
            .group_by(PurchaseEmployeePayer.default_accounting_account)
            .all()
        ):
            _add_account_usage(third_party_accounts, account=account, count=count, source="références")
        supplier_source_count = supplier_base.count()
        payer_source_count = payer_base.count()

    missing_sales_count = invoice_missing.count()
    missing_quote_count = quote_missing.count()
    missing_payment_count = (
        payments.filter(_account_needs_completion_filter(Payment.accounting_category)).count()
        + payments.filter(_blank_account_filter(Payment.settlement_mode)).count()
        + purchase_payments.filter(_account_needs_completion_filter(PurchasePayment.accounting_category)).count()
        + purchase_payments.filter(_blank_account_filter(PurchasePayment.settlement_mode)).count()
    )
    missing_purchase_count = (
        purchase_missing_account_count + purchase_not_completed_count + purchase_missing_issue_date_count
    )
    missing_third_party_count = supplier_missing_count + payer_missing_count
    missing_total = (
        missing_sales_count
        + missing_quote_count
        + missing_payment_count
        + missing_purchase_count
        + missing_third_party_count
    )

    return {
        "status": "ready" if missing_total == 0 else "needs_review",
        "missing_total": missing_total,
        "scope": {
            "period_start": start.isoformat() if start else None,
            "period_end": end.isoformat() if end else None,
            "customer_id": customer_id,
            "purchase_scope": (
                "not_in_plan" if not purchases_enabled else "excluded_by_customer_filter" if customer_id else "period"
            ),
        },
        "sections": [
            section
            for section in [
                {
                    "key": "sales",
                    "label": "Ventes",
                    "accounts": _account_usage_payload(sales_accounts),
                    "source_count": invoice_source_count.count(),
                    "missing_count": missing_sales_count,
                    "help": "Comptes utilisés sur les lignes de factures, bloquants pour le journal des ventes.",
                },
                {
                    "key": "quotes",
                    "label": "Devis",
                    "accounts": _account_usage_payload(quote_accounts),
                    "source_count": quote_source_count.count(),
                    "missing_count": missing_quote_count,
                    "help": "Comptes utilisés sur les lignes de devis, utiles pour le dossier de contrôle compta mais non bloquants pour le journal des ventes.",
                },
                {
                    "key": "purchases",
                    "label": "Achats",
                    "accounts": _account_usage_payload(purchase_accounts),
                    "source_count": purchase_source_count,
                    "missing_count": missing_purchase_count,
                    "help": "Comptes issus des achats, lignes ventilées et pièces sans date.",
                },
                {
                    "key": "payments",
                    "label": "Règlements",
                    "accounts": _account_usage_payload(payment_accounts),
                    "source_count": payments.count() + purchase_payments.count(),
                    "missing_count": missing_payment_count,
                    "help": "Comptes de règlement et modes de règlement à retrouver dans l'export.",
                },
                {
                    "key": "third_parties",
                    "label": "Références",
                    "accounts": _account_usage_payload(third_party_accounts),
                    "source_count": supplier_source_count + payer_source_count,
                    "missing_count": missing_third_party_count,
                    "help": "Comptes par défaut fournisseurs et payeurs de notes de frais.",
                },
            ]
            if (purchases_enabled or section["key"] not in {"purchases", "third_parties"})
            and (payments_enabled or section["key"] != "payments")
        ],
    }


@router.get("/accounting")
def list_accounting_exports(
    limit: int = Query(20, ge=1, le=100),
    start_date: str | None = Query(None, description="Début de période à contrôler (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="Fin de période à contrôler (YYYY-MM-DD)"),
    customer_id: str | None = Query(None, description="Client à contrôler"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_paid_subscription_or_trial(user, db)
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    purchases_enabled = is_product_feature_enabled(tenant, "purchases_enabled")
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    start = _parse_accounting_query_date(start_date, "start_date")
    end = _parse_accounting_query_date(end_date, "end_date")
    _accounting_datetime_bounds(start, end)
    lock = find_delivered_accounting_period_lock(
        db,
        tenant_id=user.tenant_id,
        period_start=start,
        period_end=end,
        customer_id=customer_id,
    )
    rows = _history_rows(db, tenant_id=user.tenant_id, start=start, end=end, customer_id=customer_id, limit=limit)
    customer_ids = {row.customer_id for row in rows if row.customer_id}
    if lock and lock.customer_id:
        customer_ids.add(lock.customer_id)
    user_ids = (
        {row.created_by for row in rows if row.created_by}
        | {row.delivered_to_accountant_by for row in rows if row.delivered_to_accountant_by}
        | {row.cabinet_reviewed_by for row in rows if row.cabinet_reviewed_by}
    )
    if lock and lock.created_by:
        user_ids.add(lock.created_by)
    if lock and lock.delivered_to_accountant_by:
        user_ids.add(lock.delivered_to_accountant_by)
    if lock and lock.cabinet_reviewed_by:
        user_ids.add(lock.cabinet_reviewed_by)
    customers = (
        {
            customer.id: customer.name
            for customer in db.query(Customer)
            .filter(Customer.tenant_id == user.tenant_id, Customer.id.in_(customer_ids))
            .all()
        }
        if customer_ids
        else {}
    )
    users = {u.id: u.email for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    return {
        "period_lock": _accounting_export_item(
            lock,
            customer_name=customers.get(lock.customer_id or "") if lock else None,
            created_by_email=users.get(lock.created_by or "") if lock else None,
            delivered_by_email=users.get(lock.delivered_to_accountant_by or "") if lock else None,
            reviewed_by_email=users.get(lock.cabinet_reviewed_by or "") if lock else None,
            purchases_enabled=purchases_enabled,
            payments_enabled=payments_enabled,
        )
        if lock
        else None,
        "items": [
            _accounting_export_item(
                row,
                customer_name=customers.get(row.customer_id or ""),
                created_by_email=users.get(row.created_by or ""),
                delivered_by_email=users.get(row.delivered_to_accountant_by or ""),
                reviewed_by_email=users.get(row.cabinet_reviewed_by or ""),
                purchases_enabled=purchases_enabled,
                payments_enabled=payments_enabled,
            )
            for row in rows
        ],
    }


@router.get("/accounting/history.csv")
def download_accounting_export_history(
    limit: int = Query(1000, ge=1, le=5000),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_paid_subscription_or_trial(user, db)
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    purchases_enabled = is_product_feature_enabled(tenant, "purchases_enabled")
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    rows = (
        db.query(AccountingExport)
        .filter(AccountingExport.tenant_id == user.tenant_id)
        .order_by(AccountingExport.created_at.desc())
        .limit(limit)
        .all()
    )
    customer_ids = {row.customer_id for row in rows if row.customer_id}
    user_ids = (
        {row.created_by for row in rows if row.created_by}
        | {row.delivered_to_accountant_by for row in rows if row.delivered_to_accountant_by}
        | {row.cabinet_reviewed_by for row in rows if row.cabinet_reviewed_by}
    )
    customers = (
        {
            customer.id: customer.name
            for customer in db.query(Customer)
            .filter(Customer.tenant_id == user.tenant_id, Customer.id.in_(customer_ids))
            .all()
        }
        if customer_ids
        else {}
    )
    users = {u.id: u.email for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(
        [
            "created_at",
            "format",
            "label",
            "status",
            "cabinet_validation_status",
            "cabinet_reviewed_at",
            "cabinet_reviewed_by",
            "period_start",
            "period_end",
            "customer",
            "record_count",
            "created_by",
            "delivered_to_accountant_at",
            "delivered_to_accountant_by",
            "cabinet_comment",
            "filters",
        ]
    )
    for row in rows:
        visible_filters = _accounting_filters_for_capabilities(
            row.filters_json if isinstance(row.filters_json, dict) else {},
            purchases_enabled=purchases_enabled,
            payments_enabled=payments_enabled,
        )
        writer.writerow(
            [
                row.created_at.isoformat() if row.created_at else "",
                _sanitize_csv_cell(row.format),
                _sanitize_csv_cell(_export_label(row.format)),
                _sanitize_csv_cell(row.status),
                _sanitize_csv_cell(row.cabinet_validation_status or "pending_review"),
                row.cabinet_reviewed_at.isoformat() if row.cabinet_reviewed_at else "",
                _sanitize_csv_cell(users.get(row.cabinet_reviewed_by or "", "")),
                row.period_start.isoformat() if row.period_start else "",
                row.period_end.isoformat() if row.period_end else "",
                _sanitize_csv_cell(customers.get(row.customer_id or "", "")),
                int(row.record_count or 0),
                _sanitize_csv_cell(users.get(row.created_by or "", "")),
                row.delivered_to_accountant_at.isoformat() if row.delivered_to_accountant_at else "",
                _sanitize_csv_cell(users.get(row.delivered_to_accountant_by or "", "")),
                _sanitize_csv_cell(row.cabinet_comment or ""),
                _sanitize_csv_cell(json.dumps(visible_filters, ensure_ascii=False, default=_json_default)),
            ]
        )
    return Response(
        content="\ufeff" + buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers=_export_attachment_headers("historique-exports-comptables.csv"),
    )


@router.patch("/accounting/{export_id}")
def update_accounting_export_status(
    export_id: str,
    payload: AccountingExportStatusUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    ensure_paid_subscription_or_trial(user, db)
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    purchases_enabled = is_product_feature_enabled(tenant, "purchases_enabled")
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    updates = payload.model_dump(exclude_unset=True)
    status = (updates.get("status") or "").strip().lower() if "status" in updates else None
    validation_status = (
        (updates.get("cabinet_validation_status") or "").strip().lower()
        if "cabinet_validation_status" in updates
        else None
    )
    if status is not None and status not in ACCOUNTING_EXPORT_STATUSES:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_export_status",
                "message": "Statut export invalide.",
            },
        )
    if validation_status is not None and validation_status not in ACCOUNTING_EXPORT_CABINET_VALIDATION_STATUSES:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_cabinet_validation_status",
                "message": "Statut de validation cabinet invalide.",
            },
        )
    row = db.get(AccountingExport, export_id)
    if not row or row.tenant_id != user.tenant_id:
        raise HTTPException(status_code=404, detail="Export introuvable")
    if "cabinet_comment" in updates:
        row.cabinet_comment = clean_accounting_export_comment(updates.get("cabinet_comment"))
    if status is not None:
        if row.status == "delivered_to_accountant" and status != "delivered_to_accountant":
            _ensure_accounting_lock_override_allowed(user)
        if status == "delivered_to_accountant" and row.format in ACCOUNTING_EXPORT_LOCKING_FORMATS:
            lock = find_delivered_accounting_period_lock(
                db,
                tenant_id=user.tenant_id,
                period_start=row.period_start,
                period_end=row.period_end,
                customer_id=row.customer_id,
                exclude_export_id=row.id,
            )
            if lock:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "accounting_period_locked",
                        "message": "Une remise cabinet couvre déjà cette période.",
                        "lock": accounting_period_lock_payload(lock),
                    },
                )
        row.status = status
        if status == "delivered_to_accountant":
            row.delivered_to_accountant_at = datetime.now(timezone.utc).replace(tzinfo=None)
            row.delivered_to_accountant_by = user.id
        else:
            row.delivered_to_accountant_at = None
            row.delivered_to_accountant_by = None
    if validation_status is not None:
        row.cabinet_validation_status = validation_status
        if validation_status == "pending_review":
            row.cabinet_reviewed_at = None
            row.cabinet_reviewed_by = None
        else:
            row.cabinet_reviewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            row.cabinet_reviewed_by = user.id
    db.add(row)
    db.commit()
    db.refresh(row)
    user_ids = {value for value in (row.created_by, row.delivered_to_accountant_by, row.cabinet_reviewed_by) if value}
    users = {u.id: u.email for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    return _accounting_export_item(
        row,
        created_by_email=users.get(row.created_by or ""),
        delivered_by_email=users.get(row.delivered_to_accountant_by or ""),
        reviewed_by_email=users.get(row.cabinet_reviewed_by or ""),
        purchases_enabled=purchases_enabled,
        payments_enabled=payments_enabled,
    )


@router.get("/tenant")
def export_tenant_data_zip(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    """Export ZIP (JSON) du tenant courant.

    Objectif:
    - Réversibilité / portabilité (argument commercial B2B)
    - Support / debug
    - Faciliter la migration vers une autre solution

    Sécurité:
    - Réservé aux admins/owners (tenant) ou platform admin.
    - Exclut les hashes de mots de passe / secrets.
    """
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Entreprise introuvable")
    tenant_settings = db.get(TenantSettings, user.tenant_id)
    _enforce_tenant_sync_export_limit(db, user.tenant_id)

    # Core data
    customers = (
        db.query(Customer).filter(Customer.tenant_id == user.tenant_id).order_by(Customer.created_at.asc()).all()
    )
    customer_contacts = (
        db.query(CustomerContact)
        .filter(CustomerContact.tenant_id == user.tenant_id)
        .order_by(CustomerContact.customer_id.asc(), CustomerContact.created_at.asc())
        .all()
    )
    items = db.query(Product).filter(Product.tenant_id == user.tenant_id).order_by(Product.created_at.asc()).all()
    invoices = db.query(Invoice).filter(Invoice.tenant_id == user.tenant_id).order_by(Invoice.issue_date.asc()).all()
    invoice_ids = [inv.id for inv in invoices]
    invoice_lines = (
        db.query(InvoiceLine)
        .filter(InvoiceLine.invoice_id.in_(invoice_ids))
        .order_by(InvoiceLine.invoice_id.asc(), InvoiceLine.id.asc())
        .all()
        if invoice_ids
        else []
    )
    # Payment does not have tenant_id; derive from invoice_id set.
    payments = (
        db.query(Payment).filter(Payment.invoice_id.in_(invoice_ids)).order_by(Payment.created_at.asc()).all()
        if invoice_ids
        else []
    )

    purchases = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.tenant_id == user.tenant_id)
        .order_by(
            InboundInvoice.issue_date.asc().nullslast(),
            InboundInvoice.received_at.asc(),
        )
        .all()
    )
    purchase_ids = [purchase.id for purchase in purchases]
    purchase_payments = (
        db.query(PurchasePayment)
        .filter(PurchasePayment.tenant_id == user.tenant_id, PurchasePayment.inbound_invoice_id.in_(purchase_ids))
        .order_by(PurchasePayment.date.asc(), PurchasePayment.created_at.asc())
        .all()
        if purchase_ids
        else []
    )
    purchase_suppliers = (
        db.query(PurchaseSupplier)
        .filter(PurchaseSupplier.tenant_id == user.tenant_id)
        .order_by(PurchaseSupplier.name.asc())
        .all()
    )
    purchase_employee_payers = (
        db.query(PurchaseEmployeePayer)
        .filter(PurchaseEmployeePayer.tenant_id == user.tenant_id)
        .order_by(PurchaseEmployeePayer.name.asc())
        .all()
    )
    purchase_attachments = (
        db.query(InboundInvoiceAttachment)
        .filter(InboundInvoiceAttachment.inbound_invoice_id.in_(purchase_ids))
        .order_by(InboundInvoiceAttachment.inbound_invoice_id.asc(), InboundInvoiceAttachment.created_at.asc())
        .all()
        if purchase_ids
        else []
    )
    purchase_events = (
        db.query(InboundInvoiceEvent)
        .filter(InboundInvoiceEvent.inbound_invoice_id.in_(purchase_ids))
        .order_by(InboundInvoiceEvent.inbound_invoice_id.asc(), InboundInvoiceEvent.created_at.asc())
        .all()
        if purchase_ids
        else []
    )

    credit_note_refunds = (
        db.query(CreditNoteRefund)
        .filter(CreditNoteRefund.invoice_id.in_(invoice_ids))
        .order_by(CreditNoteRefund.created_at.asc())
        .all()
        if invoice_ids
        else []
    )

    quotes = db.query(Quote).filter(Quote.tenant_id == user.tenant_id).order_by(Quote.issue_date.asc()).all()
    quote_ids = [q.id for q in quotes]
    quote_lines = (
        db.query(QuoteLine)
        .filter(QuoteLine.quote_id.in_(quote_ids))
        .order_by(QuoteLine.quote_id.asc(), QuoteLine.id.asc())
        .all()
        if quote_ids
        else []
    )

    users = (
        db.query(User)
        .join(Membership, Membership.user_id == User.id)
        .filter(Membership.tenant_id == user.tenant_id)
        .order_by(User.created_at.asc())
        .all()
    )

    meta = {
        "exported_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        "tenant_id": user.tenant_id,
        "format": "json",
        "version": "1",
        "purpose": "account_portability",
        "scope": "complete_tenant_history_including_inactive_plan_modules",
        "complete_history_included": True,
        "access": "tenant_admin_only",
        "warning": (
            "Archive confidentielle de portabilité: elle contient l'historique complet du compte, "
            "y compris les modules actuellement inactifs. À conserver et transmettre de manière sécurisée."
        ),
        "counts": {
            "customers": len(customers),
            "customer_contacts": len(customer_contacts),
            "items": len(items),
            "invoices": len(invoices),
            "invoice_lines": len(invoice_lines),
            "payments": len(payments),
            "credit_note_refunds": len(credit_note_refunds),
            "purchases": len(purchases),
            "purchase_payments": len(purchase_payments),
            "purchase_suppliers": len(purchase_suppliers),
            "purchase_employee_payers": len(purchase_employee_payers),
            "purchase_attachments": len(purchase_attachments),
            "purchase_events": len(purchase_events),
            "tenant_settings": 1 if tenant_settings else 0,
            "quotes": len(quotes),
            "quote_lines": len(quote_lines),
            "users": len(users),
        },
    }

    filename = f"export-tenant-{user.tenant_id[:8]}-{datetime.now(timezone.utc).replace(tzinfo=None).strftime('%Y%m%d-%H%M%S')}.zip"

    mem = io.BytesIO()
    with zipfile.ZipFile(mem, mode="w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "README-portabilite.txt",
            "\n".join(
                [
                    "Export de portabilité complète du compte PixFacture",
                    "===================================================",
                    "",
                    "Cette archive est réservée aux administrateurs du compte.",
                    "Elle contient l'historique complet, y compris les données de modules désormais inactifs",
                    "(achats, paiements et remboursements lorsqu'ils existent), afin de permettre la réversibilité.",
                    "Elle ne correspond pas à un export métier limité aux fonctionnalités du plan actif.",
                    "Le fichier contient des données confidentielles et doit être protégé pendant son stockage et son transfert.",
                ]
            ),
        )
        z.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=2, default=_json_default))
        z.writestr(
            "tenant.json",
            json.dumps(_model_to_dict(tenant), ensure_ascii=False, indent=2, default=_json_default),
        )
        z.writestr(
            "tenant_settings.json",
            json.dumps(
                _model_to_dict(tenant_settings) if tenant_settings else {},
                ensure_ascii=False,
                indent=2,
                default=_json_default,
            ),
        )
        z.writestr(
            "customers.json",
            json.dumps(
                [_model_to_dict(c, TENANT_EXPORT_EXCLUDE_FIELDS["customers"]) for c in customers],
                ensure_ascii=False,
                indent=2,
                default=_json_default,
            ),
        )
        z.writestr(
            "customer_contacts.json",
            json.dumps(
                [_model_to_dict(c) for c in customer_contacts], ensure_ascii=False, indent=2, default=_json_default
            ),
        )
        z.writestr(
            "items.json",
            json.dumps([_model_to_dict(p) for p in items], ensure_ascii=False, indent=2, default=_json_default),
        )
        z.writestr(
            "invoices.json",
            json.dumps(
                [_model_to_dict(i, TENANT_EXPORT_EXCLUDE_FIELDS["invoices"]) for i in invoices],
                ensure_ascii=False,
                indent=2,
                default=_json_default,
            ),
        )
        z.writestr(
            "invoice_lines.json",
            json.dumps(
                [_model_to_dict(line) for line in invoice_lines], ensure_ascii=False, indent=2, default=_json_default
            ),
        )
        z.writestr(
            "payments.json",
            json.dumps([_model_to_dict(p) for p in payments], ensure_ascii=False, indent=2, default=_json_default),
        )

        z.writestr(
            "credit_note_refunds.json",
            json.dumps(
                [_model_to_dict(r) for r in credit_note_refunds], ensure_ascii=False, indent=2, default=_json_default
            ),
        )
        z.writestr(
            "purchases.json",
            json.dumps([_model_to_dict(p) for p in purchases], ensure_ascii=False, indent=2, default=_json_default),
        )
        z.writestr(
            "purchase_payments.json",
            json.dumps(
                [_model_to_dict(p) for p in purchase_payments], ensure_ascii=False, indent=2, default=_json_default
            ),
        )
        z.writestr(
            "purchase_suppliers.json",
            json.dumps(
                [_model_to_dict(p) for p in purchase_suppliers], ensure_ascii=False, indent=2, default=_json_default
            ),
        )
        z.writestr(
            "purchase_employee_payers.json",
            json.dumps(
                [_model_to_dict(p) for p in purchase_employee_payers],
                ensure_ascii=False,
                indent=2,
                default=_json_default,
            ),
        )
        z.writestr(
            "purchase_attachments.json",
            json.dumps(
                [_model_to_dict(p) for p in purchase_attachments], ensure_ascii=False, indent=2, default=_json_default
            ),
        )
        z.writestr(
            "purchase_events.json",
            json.dumps(
                [_model_to_dict(p) for p in purchase_events], ensure_ascii=False, indent=2, default=_json_default
            ),
        )
        z.writestr(
            "quotes.json",
            json.dumps(
                [_model_to_dict(q, TENANT_EXPORT_EXCLUDE_FIELDS["quotes"]) for q in quotes],
                ensure_ascii=False,
                indent=2,
                default=_json_default,
            ),
        )
        z.writestr(
            "quote_lines.json",
            json.dumps(
                [_model_to_dict(line) for line in quote_lines], ensure_ascii=False, indent=2, default=_json_default
            ),
        )
        # Users: exclude sensitive fields
        z.writestr(
            "users.json",
            json.dumps(
                [
                    _model_to_dict(
                        u,
                        exclude=TENANT_EXPORT_EXCLUDE_FIELDS["users"],
                    )
                    for u in users
                ],
                ensure_ascii=False,
                indent=2,
                default=_json_default,
            ),
        )

    record_accounting_export(
        db,
        tenant_id=user.tenant_id,
        export_format="tenant_zip",
        created_by=None if user.is_api_key else user.id,
        record_count=sum(int(value or 0) for value in meta["counts"].values()),
        filters={"format": "tenant_zip", "version": meta["version"], "counts": meta["counts"]},
        commit=True,
    )

    mem.seek(0)
    return Response(
        content=mem.getvalue(),
        media_type="application/zip",
        headers={
            **_export_attachment_headers(filename),
            "X-PixFacture-Export-Purpose": "account-portability",
        },
    )
