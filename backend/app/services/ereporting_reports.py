from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Customer,
    EReportingLine,
    EReportingReport,
    Invoice,
    InvoiceLine,
    Payment,
    PdpConnection,
    Tenant,
)
from ..services.einvoicing.utils import normalize_status
from ..services.pdp import EReportingLinePayload, EReportingReportPayload, TransmissionResult
from ..services.pdp.service import resolve_connection, resolve_provider
from ..services.pdp.utils import PdpProviderError, is_retryable_error
from ..services.seqino_tokens import (
    consume_seqino_tokens_or_raise,
    refund_seqino_tokens_after_certain_failure,
)
from ..services.connected_mode import connected_mode_decision
from ..services.seqino_mandates import seqino_has_active_mandate_for_tenant_issuer
from ..utils.public_provider_messages import sanitize_public_provider_message
from .seqino_invoice_draft import build_seqino_invoice_draft

logger = logging.getLogger(__name__)


def _public_provider_error(exc: Exception) -> str:
    return sanitize_public_provider_message(
        exc,
        fallback="La plateforme agréée n’a pas pu traiter cet envoi.",
        max_chars=300,
    ) or "La plateforme agréée n’a pas pu traiter cet envoi."


def _is_certain_provider_failure(exc: Exception) -> bool:
    if not isinstance(exc, PdpProviderError) or is_retryable_error(exc):
        return False
    # A conflict can mean the provider already accepted the same business
    # object. It must be reconciled, not reimbursed automatically.
    return (getattr(exc, "code", None) or "").strip().lower() != "seqino_conflict"


def _refund_seqino_report_token(db: Session, tenant_id: str, report_id: str) -> None:
    try:
        refund_seqino_tokens_after_certain_failure(
            db,
            tenant_id,
            reference_type="seqino_ereporting_report",
            reference_id=report_id,
        )
    except Exception:
        logger.exception(
            "seqino_ereporting_report_token_refund_failed",
            extra={"tenant_id": tenant_id, "report_id": report_id},
        )


REPORT_PENDING_STATUSES = {"pending", "failed"}
LINE_PENDING_STATUSES = {"pending", "failed"}
DEFAULT_REPORT_BATCH_LIMIT = 50
DEFAULT_LINE_BATCH_LIMIT = 200
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_RETRY_BASE_SECONDS = 60
DEFAULT_RETRY_MAX_SECONDS = 3600


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _normalize_status(value: str | None, raw_status: str | None = None) -> str:
    base = value or raw_status
    if base and str(base).strip().lower() == "reconciliation_required":
        return "reconciliation_required"
    if base and str(base).strip().lower() in {"skipped", "ignored"}:
        return "skipped"
    normalized = normalize_status(base)
    if normalized == "unknown":
        return "submitted"
    return normalized


def _error_message(message: str | None, errors: list[str] | None) -> str | None:
    parts: list[str] = []
    if message:
        parts.append(message)
    if errors:
        parts.extend([err for err in errors if err])
    if not parts:
        return None
    combined = " | ".join(parts)
    return combined[:500]


def _backoff_delay(attempt: int, base_seconds: int, max_seconds: int) -> int:
    return min(int(base_seconds * (2 ** max(0, attempt - 1))), max_seconds)


def _schedule_retry(report: EReportingReport, now: datetime) -> None:
    max_attempts = int(getattr(settings, "EREPORTING_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS) or DEFAULT_MAX_ATTEMPTS)
    if report.attempts >= max_attempts:
        report.next_retry_at = None
        return
    base_seconds = int(
        getattr(settings, "EREPORTING_RETRY_BASE_SECONDS", DEFAULT_RETRY_BASE_SECONDS) or DEFAULT_RETRY_BASE_SECONDS
    )
    max_seconds = int(
        getattr(settings, "EREPORTING_RETRY_MAX_SECONDS", DEFAULT_RETRY_MAX_SECONDS) or DEFAULT_RETRY_MAX_SECONDS
    )
    delay = _backoff_delay(report.attempts, base_seconds, max_seconds)
    report.next_retry_at = now + timedelta(seconds=delay)


def _as_line_payload(line: EReportingLine, *, metadata: dict | None = None) -> EReportingLinePayload:
    base_metadata: dict[str, Any] = {}
    if line.id:
        base_metadata["line_id"] = line.id
    if metadata:
        base_metadata.update(metadata)
    return EReportingLinePayload(
        line_id=line.id,
        event_type=line.event_type,
        amounts=line.amounts,
        payment_date=line.payment_date,
        country=line.country,
        client_country=line.client_country,
        client_vat_number=line.client_vat_number,
        client_type=line.client_type,
        source_type=line.source_type,
        source_id=line.source_id,
        metadata=base_metadata or None,
    )


def _as_report_payload(
    report: EReportingReport,
    lines: list[EReportingLine],
    *,
    line_metadata: dict[str, dict] | None = None,
) -> EReportingReportPayload:
    return EReportingReportPayload(
        report_id=report.id,
        report_type=report.report_type,
        period_start=report.period_start,
        period_end=report.period_end,
        idempotency_key=report.idempotency_hash,
        lines=[_as_line_payload(line, metadata=(line_metadata or {}).get(line.id)) for line in lines],
        metadata={"report_id": report.id} if report.id else None,
    )


def _build_line_metadata(
    db: Session,
    *,
    tenant_id: str,
    lines: list[EReportingLine],
) -> dict[str, dict]:
    if not lines:
        return {}
    invoice_ids = {
        line.source_id for line in lines if line.source_type in {"invoice", "credit_note"} and line.source_id
    }
    payment_ids = {line.source_id for line in lines if line.source_type == "payment" and line.source_id}
    invoices = {}
    if invoice_ids:
        invoices = {invoice.id: invoice for invoice in db.query(Invoice).filter(Invoice.id.in_(invoice_ids)).all()}
    payments = {}
    if payment_ids:
        payments = {payment.id: payment for payment in db.query(Payment).filter(Payment.id.in_(payment_ids)).all()}

    international_invoice_ids = {
        line.source_id
        for line in lines
        if line.source_type in {"invoice", "credit_note"} and line.source_id and line.event_type == "international_sale"
    }
    drafts_by_invoice: dict[str, dict] = {}
    if international_invoice_ids:
        invoice_lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id.in_(international_invoice_ids)).all()
        lines_by_invoice: dict[str, list[InvoiceLine]] = {}
        for item in invoice_lines:
            lines_by_invoice.setdefault(item.invoice_id, []).append(item)

        customer_ids = {
            invoices[inv_id].customer_id
            for inv_id in international_invoice_ids
            if inv_id in invoices and invoices[inv_id].customer_id
        }
        customers = {}
        if customer_ids:
            customers = {
                customer.id: customer for customer in db.query(Customer).filter(Customer.id.in_(customer_ids)).all()
            }
        tenant = db.get(Tenant, tenant_id)
        for inv_id in international_invoice_ids:
            invoice = invoices.get(inv_id)
            if not invoice:
                continue
            customer = customers.get(invoice.customer_id) if invoice.customer_id else None
            draft = build_seqino_invoice_draft(
                invoice,
                customer,
                lines_by_invoice.get(inv_id, []),
                tenant,
            )
            if draft:
                drafts_by_invoice[inv_id] = draft

    metadata: dict[str, dict] = {}
    for line in lines:
        if not line.id:
            continue
        meta: dict[str, Any] = {}
        if line.source_type in {"invoice", "credit_note"}:
            invoice = invoices.get(line.source_id or "")
            if invoice and invoice.issue_date:
                meta["event_date"] = invoice.issue_date.date().isoformat()
            invoice_draft = drafts_by_invoice.get(line.source_id or "")
            if invoice_draft:
                meta["invoice_draft"] = invoice_draft
        elif line.source_type == "payment":
            payment = payments.get(line.source_id or "")
            if payment and payment.date:
                meta["event_date"] = payment.date.date().isoformat()
            if line.source_id:
                meta["payment_id"] = line.source_id
        if meta:
            metadata[line.id] = meta
    return metadata


def _align_results(results: list[TransmissionResult], expected: int) -> list[TransmissionResult]:
    if expected <= 0:
        return []
    if not results:
        return [
            TransmissionResult(
                external_id=None,
                status="reconciliation_required",
                message="Réponse de transmission incomplète : rapprochement manuel requis.",
            )
            for _ in range(expected)
        ]
    if len(results) < expected:
        padding = [
            TransmissionResult(
                external_id=None,
                status="reconciliation_required",
                message="Réponse de transmission incomplète : rapprochement manuel requis.",
            )
            for _ in range(expected - len(results))
        ]
        return results + padding
    return results[:expected]


def _match_results(
    lines: list[EReportingLine],
    results: list[TransmissionResult],
) -> list[TransmissionResult]:
    by_id = {
        (res.metadata or {}).get("line_id"): res for res in results if res.metadata and (res.metadata.get("line_id"))
    }
    if by_id:
        return [
            by_id.get(line.id)
            or TransmissionResult(
                external_id=None,
                status="reconciliation_required",
                message="Réponse de transmission incomplète : rapprochement manuel requis.",
                metadata={"line_id": line.id},
            )
            for line in lines
        ]
    return _align_results(results, len(lines))


def _apply_line_result(line: EReportingLine, result: TransmissionResult, now: datetime) -> None:
    normalized = _normalize_status(result.status, result.raw_status)
    line.status = normalized
    if result.external_id:
        line.external_id = result.external_id
    if result.payload_hash:
        line.payload_hash = result.payload_hash
    if normalized == "reconciliation_required":
        line.error_message = _error_message(result.message, result.errors) or (
            "Résultat de transmission ambigu : rapprochement manuel requis avant tout nouvel envoi."
        )
    elif normalized in {"failed", "rejected"}:
        line.error_message = _error_message(result.message, result.errors) or "Transmission rejetée."
    else:
        line.error_message = None
    line.updated_at = now


def _apply_report_status(report: EReportingReport, lines: list[EReportingLine], now: datetime) -> None:
    statuses = {line.status for line in lines}
    if not statuses:
        return
    if "reconciliation_required" in statuses:
        report.status = "reconciliation_required"
        report.error_message = next(
            (line.error_message for line in lines if line.status == "reconciliation_required"),
            "Résultat Seqino ambigu : rapprochement manuel requis.",
        )
        report.next_retry_at = None
        return
    if any(status in {"failed", "rejected"} for status in statuses):
        report.status = "failed"
        report.error_message = next(
            (line.error_message for line in lines if line.error_message), "Échec de la transmission."
        )
        return
    if statuses.issubset({"accepted", "skipped"}):
        report.status = "accepted"
    elif statuses.intersection({"processing", "submitted", "unknown"}):
        report.status = "submitted"
    else:
        report.status = "submitted"
    report.error_message = None
    report.sent_at = report.sent_at or now
    report.next_retry_at = None


def _resolve_active_connection(db: Session, tenant_id: str, provider_slug: str) -> PdpConnection:
    conn = resolve_connection(db, tenant_id, provider_slug)
    if (conn.status or "").lower() != "connected":
        raise ValueError("Connexion plateforme agréée inactive.")
    return conn


def _chunked(lines: list[EReportingLine], batch_size: int) -> list[list[EReportingLine]]:
    if batch_size <= 0:
        return [lines]
    return [lines[i : i + batch_size] for i in range(0, len(lines), batch_size)]


def _select_reports(
    db: Session,
    *,
    tenant_id: str,
    provider_slug: str | None,
    report_ids: list[str] | None,
    limit: int,
    now: datetime,
) -> list[EReportingReport]:
    query = db.query(EReportingReport).filter(EReportingReport.tenant_id == tenant_id)
    if report_ids:
        query = query.filter(EReportingReport.id.in_(report_ids))
    else:
        query = query.filter(EReportingReport.status.in_(REPORT_PENDING_STATUSES))
        query = query.filter(or_(EReportingReport.next_retry_at.is_(None), EReportingReport.next_retry_at <= now))
    if provider_slug:
        query = query.filter(
            or_(EReportingReport.provider_slug == provider_slug, EReportingReport.provider_slug.is_(None))
        )
    return query.order_by(EReportingReport.created_at.asc()).limit(limit).all()


async def send_ereporting_reports(
    db: Session,
    *,
    tenant_id: str,
    provider_slug: str | None = None,
    report_ids: list[str] | None = None,
    limit: int | None = None,
) -> dict:
    summary = {"ok": True, "checked": 0, "sent": 0, "failed": 0, "skipped": 0, "errors": 0}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    provider_slug = _clean(provider_slug)
    limit_value = (
        limit
        or getattr(settings, "EREPORTING_REPORT_BATCH_SIZE", DEFAULT_REPORT_BATCH_LIMIT)
        or DEFAULT_REPORT_BATCH_LIMIT
    )
    limit_value = max(1, min(int(limit_value), 200))
    line_batch = int(
        getattr(settings, "EREPORTING_REPORT_LINE_BATCH_SIZE", DEFAULT_LINE_BATCH_LIMIT) or DEFAULT_LINE_BATCH_LIMIT
    )
    line_batch = max(1, min(line_batch, 500))

    reports = _select_reports(
        db,
        tenant_id=tenant_id,
        provider_slug=provider_slug,
        report_ids=report_ids,
        limit=limit_value,
        now=now,
    )
    summary["checked"] = len(reports)
    if not reports:
        return summary
    access = connected_mode_decision(db, tenant_id, provider_slug)
    if not access.allowed and (provider_slug is not None or access.code != "connected_mode_not_operational"):
        summary["skipped"] = len(reports)
        return summary

    default_slug = provider_slug
    if not default_slug and any(report.provider_slug is None for report in reports):
        try:
            default_conn = resolve_connection(db, tenant_id)
            if (default_conn.status or "").lower() != "connected":
                raise ValueError("Connexion plateforme agréée inactive.")
            default_slug = default_conn.provider_slug
        except Exception:
            for report in reports:
                if report.provider_slug:
                    continue
                report.status = "failed"
                report.error_message = "Connexion plateforme agréée manquante."
                report.updated_at = now
                summary["failed"] += 1
            db.commit()
            reports = [report for report in reports if report.provider_slug]

    grouped: dict[str, list[EReportingReport]] = {}
    for report in reports:
        if not report.provider_slug and default_slug:
            report.provider_slug = default_slug
        slug = _clean(report.provider_slug)
        if not slug:
            summary["skipped"] += 1
            continue
        grouped.setdefault(slug, []).append(report)

    for slug, slug_reports in grouped.items():
        access = connected_mode_decision(db, tenant_id, slug)
        if not access.allowed:
            summary["skipped"] += len(slug_reports)
            continue
        if slug.strip().lower() == "seqino" and not seqino_has_active_mandate_for_tenant_issuer(
            tenant_id,
            db=db,
        ):
            # Revocation after enqueue invalidates the whole pending batch.
            # Leave it pending and do not resolve the provider or debit stock.
            summary["skipped"] += len(slug_reports)
            continue
        try:
            conn = _resolve_active_connection(db, tenant_id, slug)
        except Exception:
            for report in slug_reports:
                report.status = "failed"
                report.error_message = "Connexion plateforme agréée introuvable."
                report.updated_at = now
                summary["failed"] += 1
            summary["errors"] += 1
            continue

        try:
            provider, _ = resolve_provider(conn, db)
        except Exception:
            for report in slug_reports:
                report.status = "failed"
                report.error_message = "Plateforme agréée indisponible."
                report.updated_at = now
                summary["failed"] += 1
            summary["errors"] += 1
            continue
        for report in slug_reports:
            if (report.status or "").strip().lower() == "reconciliation_required":
                report.next_retry_at = None
                summary["skipped"] += 1
                continue
            lines = (
                db.query(EReportingLine)
                .filter(EReportingLine.report_id == report.id)
                .order_by(EReportingLine.created_at.asc())
                .all()
            )
            lines_to_send = [line for line in lines if line.status in LINE_PENDING_STATUSES]
            if not lines_to_send:
                _apply_report_status(report, lines, now)
                summary["skipped"] += 1
                continue

            report.attempts = (report.attempts or 0) + 1
            report.last_attempt_at = now
            report.updated_at = now

            if (slug or "").strip().lower() == "seqino":
                if not seqino_has_active_mandate_for_tenant_issuer(tenant_id, db=db):
                    summary["skipped"] += 1
                    continue
                try:
                    consume_seqino_tokens_or_raise(
                        db,
                        tenant_id,
                        reference_type="seqino_ereporting_report",
                        reference_id=report.id,
                    )
                except PdpProviderError as exc:
                    message = _public_provider_error(exc)
                    report.status = "failed"
                    report.error_message = message
                    report.next_retry_at = None
                    report.updated_at = now
                    for line in lines_to_send:
                        line.status = "failed"
                        line.error_message = message
                        line.updated_at = now
                    summary["failed"] += 1
                    continue

                if not seqino_has_active_mandate_for_tenant_issuer(tenant_id, db=db):
                    # The debit helper commits; compensate a revocation that
                    # raced the first check and never call the provider.
                    _refund_seqino_report_token(db, tenant_id, str(report.id))
                    report.attempts = max(0, int(report.attempts or 0) - 1)
                    report.error_message = "Mandat Seqino actif requis avant envoi."
                    report.next_retry_at = None
                    report.updated_at = now
                    for line in lines_to_send:
                        line.error_message = report.error_message
                        line.updated_at = now
                        db.add(line)
                    db.add(report)
                    db.commit()
                    summary["skipped"] += 1
                    continue

            failed = False
            remote_or_ambiguous_result = False
            processed_line_ids: set[str] = set()
            for chunk in _chunked(lines_to_send, line_batch):
                line_metadata = _build_line_metadata(db, tenant_id=tenant_id, lines=chunk)
                payload = _as_report_payload(report, chunk, line_metadata=line_metadata)
                try:
                    results = await provider.send_ereporting(payload)
                except NotImplementedError:
                    if (slug or "").strip().lower() == "seqino" and not remote_or_ambiguous_result:
                        _refund_seqino_report_token(db, tenant_id, str(report.id))
                    if remote_or_ambiguous_result:
                        message = "Résultat partiel : rapprochement manuel requis avant tout nouvel envoi."
                        report.status = "reconciliation_required"
                    else:
                        message = "Export requis (envoi direct non disponible)."
                        report.status = "exported_pending_send"
                    report.error_message = message
                    report.next_retry_at = None
                    report.updated_at = now
                    for line in lines_to_send:
                        if line.id in processed_line_ids:
                            continue
                        line.status = (
                            "reconciliation_required" if remote_or_ambiguous_result else "exported_pending_send"
                        )
                        line.error_message = message
                        line.updated_at = now
                    summary["skipped"] += 1
                    failed = True
                    break
                except Exception as exc:
                    retryable = is_retryable_error(exc)
                    certain_failure = _is_certain_provider_failure(exc)
                    seqino_ambiguous = (slug or "").strip().lower() == "seqino" and not certain_failure
                    message = _public_provider_error(exc)
                    if seqino_ambiguous:
                        report.status = "reconciliation_required"
                        report.error_message = (
                            "Résultat de transmission ambigu : rapprochement manuel requis avant tout nouvel envoi."
                        )
                        report.next_retry_at = None
                    else:
                        report.status = "failed"
                        report.error_message = message[:500]
                    if retryable:
                        if not seqino_ambiguous:
                            _schedule_retry(report, now)
                        summary["errors"] += 1
                    elif seqino_ambiguous:
                        summary["errors"] += 1
                    else:
                        report.next_retry_at = None
                    for line in chunk:
                        line.status = "reconciliation_required" if seqino_ambiguous else "failed"
                        line.error_message = report.error_message
                        line.updated_at = now
                    summary["failed"] += 1
                    if certain_failure and not remote_or_ambiguous_result and (slug or "").strip().lower() == "seqino":
                        _refund_seqino_report_token(db, tenant_id, str(report.id))
                    failed = True
                    break

                aligned = _match_results(chunk, results or [])
                for line, result in zip(chunk, aligned):
                    _apply_line_result(line, result, now)
                    processed_line_ids.add(str(line.id))
                    if line.status not in {"failed", "rejected", "skipped"}:
                        remote_or_ambiguous_result = True
                if any(line.status == "reconciliation_required" for line in chunk):
                    break

            if failed:
                continue

            _apply_report_status(report, lines, now)
            if (
                (slug or "").strip().lower() == "seqino"
                and not remote_or_ambiguous_result
                and all(line.status in {"failed", "rejected", "skipped"} for line in lines_to_send)
            ):
                _refund_seqino_report_token(db, tenant_id, str(report.id))
            if report.status == "failed":
                _schedule_retry(report, now)
                summary["failed"] += 1
            elif report.status == "reconciliation_required":
                summary["failed"] += 1
            else:
                summary["sent"] += 1

    db.commit()
    return summary
