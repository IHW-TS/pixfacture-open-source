from __future__ import annotations

import asyncio
import logging
import re
from types import SimpleNamespace
from datetime import datetime, timezone

from fastapi import HTTPException, Response
from fastapi.responses import JSONResponse
from rq import get_current_job
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app import metrics
from app.config import settings
from app.db import SessionLocal
from app.deps import AuthUser, ensure_active_subscription
from app.jobs.queue import enqueue_job, is_sync_mode
from app.services.product_capabilities import is_product_feature_enabled
from app.utils.public_errors import sanitize_public_error_message


logger = logging.getLogger("invoices.issue")
validation_logger = logging.getLogger("invoices.validation")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _router():
    from app.routers import invoices as invoices_router

    return invoices_router


def _issue_job_error(
    code: str,
    message: str,
    status_code: int,
    errors: list | None = None,
    fields: list[str] | None = None,
) -> dict:
    safe_status = status_code if 400 <= status_code <= 599 else 400
    safe_code = code if re.fullmatch(r"[a-z][a-z0-9_.:-]{1,79}", str(code or "")) else f"HTTP_{safe_status}"
    payload = {
        "code": safe_code,
        "message": sanitize_public_error_message(
            message,
            status_code=safe_status,
            fallback="La facture ne peut pas être émise avec les informations actuelles.",
        ),
        "status_code": safe_status,
    }
    if errors is not None:
        payload["errors"] = [
            sanitize_public_error_message(
                error,
                status_code=safe_status,
                fallback="Une donnée de la facture doit être corrigée.",
                max_chars=500,
            )
            for error in errors[:100]
            if isinstance(error, str)
        ]
    if fields is not None:
        payload["fields"] = [
            field for field in fields[:100] if isinstance(field, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", field)
        ]
    return {"ok": False, "error": payload}


def _issue_error_from_exception(exc: HTTPException) -> dict:
    detail = exc.detail
    code = None
    message = None
    errors = None
    fields = None
    if isinstance(detail, dict):
        code = detail.get("code") or None
        message = detail.get("message") or detail.get("detail")
        errors = detail.get("errors")
        fields = detail.get("fields")
    elif isinstance(detail, str):
        message = detail
    return _issue_job_error(code or f"HTTP_{exc.status_code}", message or "Erreur", exc.status_code, errors, fields)


def _fr_einvoicing_error_payload(fields: list[str], errors: list | None = None) -> dict:
    router = _router()
    payload = router.fr_einvoicing_error(fields)
    raw_errors = errors if errors is not None else fields
    payload["errors"] = [
        sanitize_public_error_message(
            error,
            status_code=422,
            fallback="Une donnée de la facture doit être corrigée.",
            max_chars=500,
        )
        for error in raw_errors[:100]
        if isinstance(error, str)
    ]
    return payload


def _fr_einvoicing_missing_response(fields: list[str], errors: list | None = None) -> JSONResponse:
    return JSONResponse(status_code=422, content=_fr_einvoicing_error_payload(fields, errors))


def _snapshot_issue_fields(inv) -> tuple[str | None, datetime | None, datetime | None]:
    return inv.number, inv.issue_date, inv.due_date


def _restore_issue_fields(inv, snapshot: tuple[str | None, datetime | None, datetime | None]) -> None:
    number, issue_date, due_date = snapshot
    inv.number = number
    inv.issue_date = issue_date
    inv.due_date = due_date


def _apply_issue_defaults(router, db: Session, inv) -> None:
    if inv.status == "draft":
        inv.issue_date = _utcnow()
        if not inv.due_date_manual:
            inv.due_date = router._compute_due_date(inv.issue_date, inv.payment_terms, inv.due_days)
    else:
        if not inv.issue_date:
            inv.issue_date = _utcnow()
        if not inv.due_date:
            inv.due_date = router._compute_due_date(inv.issue_date, inv.payment_terms, inv.due_days)
    if not inv.number:
        # Dry-run preflight only needs a non-empty reference to run the same validators
        # before we enqueue the real async job that will allocate the final numbering.
        inv.number = "__issue_preflight__"


def _preflight_issue_validation(inv, db: Session, tenant, customer) -> dict | None:
    router = _router()
    lines = db.query(router.InvoiceLine).filter(router.InvoiceLine.invoice_id == inv.id).all()
    fr_min_errors: list[str] = []
    if router.is_fr_b2b(tenant.country, customer.country, customer.client_type):
        fr_min_errors.extend(router.validate_fr_invoice_minimum_2026(tenant, customer, inv, lines))
        fr_min_errors.extend(router.validate_fr_invoice_minimum_2027(tenant, customer, inv, lines))
    if fr_min_errors:
        return _issue_job_error(
            "fr_invoice_minimum",
            "Facture B2B France : des informations sont manquantes ou incohérentes.",
            422,
            fr_min_errors,
        )

    snapshot = _snapshot_issue_fields(inv)
    try:
        _apply_issue_defaults(router, db, inv)

        required_fields = router.validate_invoice_required_fields(inv, tenant, customer, lines)
        if required_fields:
            return _issue_job_error(
                "fr_invoice_missing_fields",
                "Des informations obligatoires manquent pour émettre la facture.",
                422,
                required_fields,
                required_fields,
            )

        ctx = router._ctx(db, inv)
        errors = router.validate_invoice_ctx(ctx)
        if errors:
            return _issue_job_error(
                "sanity_checks_failed",
                "Le document contient des informations à corriger avant émission.",
                422,
                errors,
            )

        if router._ubl_export_enabled():
            ubl_errors = router.validate_ubl_ctx(ctx)
            if ubl_errors:
                is_unavailable = any("indisponible" in err.lower() for err in ubl_errors)
                return _issue_job_error(
                    "ubl_validation_unavailable" if is_unavailable else "ubl_en16931_invalid",
                    (
                        "Le contrôle de conformité UBL EN 16931 est temporairement indisponible."
                        if is_unavailable
                        else "Le document structuré UBL contient des informations à corriger avant l’émission."
                    ),
                    503 if is_unavailable else 422,
                    ubl_errors,
                )
        return None
    finally:
        _restore_issue_fields(inv, snapshot)
        db.rollback()


def issue_invoice_job(invoice_id: str, tenant_id: str, user_id: str | None) -> dict:
    router = _router()
    job = get_current_job()

    def _set_progress(step: str) -> None:
        if not job:
            return
        job.meta["progress"] = step
        job.save_meta()

    with SessionLocal() as db:
        try:
            try:
                inv = db.query(router.Invoice).filter(router.Invoice.id == invoice_id).with_for_update().first()
            except OperationalError:
                logger.warning(
                    "invoice_issue_locked",
                    extra={"invoice_id": invoice_id, "tenant_id": tenant_id},
                )
                return _issue_job_error(
                    "invoice_locked",
                    "Facture en cours de traitement, réessayez dans un instant.",
                    429,
                )
            if not inv or inv.tenant_id != tenant_id:
                return _issue_job_error("not_found", "Not found", 404)
            tenant = db.get(router.Tenant, inv.tenant_id)
            customer = db.get(router.Customer, inv.customer_id)
            if not tenant or not customer:
                return _issue_job_error("not_found", "Not found", 404)
            ensure_active_subscription(tenant, db)
            if (tenant.subscription_status or "").strip().lower() == "trialing":
                return _issue_job_error(
                    "trial_invoice_issue_disabled",
                    (
                        "L’émission définitive est désactivée pendant l’essai de 7 jours. "
                        "Vous pouvez préparer et prévisualiser vos documents, puis choisir un abonnement "
                        "pour leur attribuer un numéro définitif et les envoyer."
                    ),
                    402,
                )
            # Public/self-service flows can issue invoices without an authenticated back-office user.
            # Keep a lightweight actor object so router helpers can safely set updated_by=None and log system actions.
            user_ref = SimpleNamespace(id=user_id, is_api_key=False)
            structured_artifacts_enabled = is_product_feature_enabled(tenant, "einvoicing_enabled")

            fr_checks = router.validate_fr_einvoicing_fields(inv, tenant, customer)
            fr_missing_fields = router.validate_fr_b2b_invoice_ready(inv, customer, tenant)
            if fr_missing_fields:
                return _issue_job_error(
                    "fr_einvoicing_missing_fields",
                    "Informations manquantes pour une facture B2B France.",
                    422,
                    fr_checks,
                    fr_missing_fields,
                )
            lines = db.query(router.InvoiceLine).filter(router.InvoiceLine.invoice_id == inv.id).all()
            fr_min_errors: list[str] = []
            if router.is_fr_b2b(tenant.country, customer.country, customer.client_type):
                fr_min_errors.extend(router.validate_fr_invoice_minimum_2026(tenant, customer, inv, lines))
                fr_min_errors.extend(router.validate_fr_invoice_minimum_2027(tenant, customer, inv, lines))
            if fr_min_errors:
                return _issue_job_error(
                    "fr_invoice_minimum",
                    "Facture B2B France : des informations sont manquantes ou incohérentes.",
                    422,
                    fr_min_errors,
                )

            if inv.status in router.IMMUTABLE_STATUSES and (
                inv.issued_at or inv.pdf_key or inv.xml_key or inv.facturx_key
            ):
                return _issue_job_error("already_issued", "Facture déjà émise.", 409)

            if inv.type == "credit_note":
                router.validate_credit_note_before_issue(db, inv)

            original_number = inv.number
            original_issue_date = inv.issue_date
            original_due_date = inv.due_date
            if inv.status == "draft":
                inv.issue_date = _utcnow()
                if not inv.due_date_manual:
                    inv.due_date = router._compute_due_date(inv.issue_date, inv.payment_terms, inv.due_days)
            else:
                if not inv.issue_date:
                    inv.issue_date = _utcnow()
                if not inv.due_date:
                    inv.due_date = router._compute_due_date(inv.issue_date, inv.payment_terms, inv.due_days)
            if not inv.number:
                issue_year = inv.issue_date.year if inv.issue_date else _utcnow().year
                inv.number = router._next_number(db, inv.tenant_id, inv.type, year=issue_year)

            required_fields = router.validate_invoice_required_fields(inv, tenant, customer, lines)
            if required_fields:
                inv.number = original_number
                inv.issue_date = original_issue_date
                inv.due_date = original_due_date
                db.rollback()
                return _issue_job_error(
                    "fr_invoice_missing_fields",
                    "Des informations obligatoires manquent pour émettre la facture.",
                    422,
                    required_fields,
                    required_fields,
                )

            _set_progress("validation")
            ctx = router._ctx(db, inv)
            errors = router.validate_invoice_ctx(ctx)
            if errors:
                inv.number = original_number
                inv.issue_date = original_issue_date
                inv.due_date = original_due_date
                db.rollback()
                return _issue_job_error(
                    "sanity_checks_failed",
                    "Le document contient des informations à corriger avant émission.",
                    422,
                    errors,
                )
            if router._ubl_export_enabled():
                ubl_errors = router.validate_ubl_ctx(ctx)
                if ubl_errors:
                    is_unavailable = any("indisponible" in err.lower() for err in ubl_errors)
                    if is_unavailable:
                        validation_logger.warning(
                            "UBL validation unavailable for invoice %s: %s",
                            inv.id,
                            ubl_errors[:3],
                        )
                        return _issue_job_error(
                            "ubl_validation_unavailable",
                            "Le contrôle de conformité UBL EN 16931 est temporairement indisponible.",
                            503,
                            ubl_errors,
                        )
                    validation_logger.warning(
                        "UBL validation failed for invoice %s: %s",
                        inv.id,
                        ubl_errors[:3],
                    )
                    return _issue_job_error(
                        "ubl_en16931_invalid",
                        "Le document structuré UBL contient des informations à corriger avant l’émission.",
                        422,
                        ubl_errors,
                    )

            if inv.status not in router.IMMUTABLE_STATUSES:
                if inv.status != "issued":
                    router._transition(inv, "issued", db, user_ref)

            # Best-effort: only final/standard invoices close the quote lifecycle.
            if getattr(inv, "invoice_kind", None) != "deposit":
                try:
                    from app.models import Quote  # local import to avoid circular deps

                    q = db.get(Quote, inv.quote_id) if getattr(inv, "quote_id", None) else None
                    if not q:
                        q = db.query(Quote).filter(Quote.invoice_id == inv.id).first()
                    if q and q.tenant_id == inv.tenant_id:
                        if not getattr(q, "invoice_id", None):
                            q.invoice_id = inv.id
                        if q.status != "invoiced":
                            q.status = "invoiced"
                        db.add(q)
                except Exception:
                    pass

            _set_progress("generation")
            if structured_artifacts_enabled:
                inv.issued_profile = router._facturx_profile(inv.issued_profile, tenant, customer)
            router.ensure_invoice_snapshot(db, inv)
            ctx = router._ctx(db, inv)
            router.ensure_invoice_artifact(db, inv, "pdf", ctx)
            pdf_bytes = router._load_invoice_artifact(inv, "pdf")
            if not pdf_bytes:
                pdf_bytes = router.invoice_pdf(ctx)
                router._store_invoice_artifact(inv, "pdf", pdf_bytes, "application/pdf")
            xml_bytes = None
            facturx_bytes = None
            if structured_artifacts_enabled:
                router.ensure_invoice_artifact(db, inv, "cii", ctx)
                router.ensure_invoice_artifact(db, inv, "facturx", ctx)
                xml_bytes = router._load_invoice_artifact(inv, "xml")
                if not xml_bytes:
                    xml_bytes = router.cii_invoice_xml(ctx)
                    router._store_invoice_artifact(inv, "xml", xml_bytes, "application/xml")
                facturx_bytes = router._load_invoice_artifact(inv, "facturx")
                if not facturx_bytes:
                    try:
                        facturx_bytes, pdfa_status, pdfa_report = router.facturx_from_pdf_xml_with_meta(
                            pdf_bytes,
                            xml_bytes,
                            inv.issued_profile,
                        )
                    except router.FacturxXsdValidationError as exc:
                        router._raise_facturx_xsd_error(exc)
                    except router.FacturxSchematronValidationError as exc:
                        router._raise_facturx_schematron_error(exc)
                    except router.FacturxEmbedError as exc:
                        router._raise_facturx_embed_error(exc)
                    except router.FacturxPdfa3Error as exc:
                        router._raise_facturx_pdfa_error(exc)
                    router._store_facturx_result(inv, facturx_bytes, pdfa_status, pdfa_report)

            _set_progress("finalize")
            if not inv.issued_at:
                inv.issued_at = inv.issue_date or _utcnow()
            hashes, hashes_changed = router._ensure_invoice_hashes(inv, pdf_bytes, xml_bytes, facturx_bytes)
            if hashes_changed:
                db.add(inv)
            audit_payload = {key: value for key, value in hashes.items() if value}
            if audit_payload:
                router._log_action(db, user_ref, inv.tenant_id, "invoice", inv.id, "issue_evidence", audit_payload)
            db.commit()

            auto_submit = {
                "attempted": False,
                "result": "skipped_no_connection",
                "message": "Transmission automatique non lancée (aucune plateforme partenaire active).",
            }
            if not structured_artifacts_enabled and router.is_fr_b2b(
                tenant.country, customer.country, customer.client_type
            ):
                auto_submit["result"] = "skipped_plan_feature"
                auto_submit["message"] = "Transmission automatique non lancée (e-facturation non incluse dans ce plan)."
            if (
                structured_artifacts_enabled
                and router.is_fr_b2b(tenant.country, customer.country, customer.client_type)
                and settings.EINVOICING_EXPORT_ONLY
            ):
                auto_submit["result"] = "skipped_export_only"
                auto_submit["message"] = "Transmission automatique non lancée (mode export uniquement actif)."
            elif structured_artifacts_enabled and router.is_fr_b2b(
                tenant.country, customer.country, customer.client_type
            ):
                siren = (customer.siren or "").replace(" ", "") or None
                siret = (customer.siret or "").replace(" ", "") or None
                conn = router.select_connection_for_customer(db, tenant.id, siren, siret)
                if conn:
                    auto_submit["attempted"] = True
                    try:
                        provider, _ = router.resolve_provider(conn, db)
                        if getattr(provider, "kind", "b2b") == "b2b":
                            submit_ctx = ctx or router._ctx(db, inv)
                            tx = asyncio.run(
                                router.submit_einvoice(
                                    db,
                                    provider=provider,
                                    invoice=inv,
                                    tenant_id=tenant.id,
                                    channel=conn.provider_slug,
                                    ctx=submit_ctx,
                                    poll_status=False,
                                    raise_on_error=False,
                                    source="invoice_issue",
                                    actor_user_id=user_ref.id if user_ref else None,
                                )
                            )
                            if router._pdp_status_blocks_invoice_sent(tx):
                                auto_submit["result"] = "error"
                                auto_submit["message"] = "Transmission automatique en échec. Consultez le statut."
                            else:
                                router._mark_invoice_sent_after_pdp_submission(
                                    db,
                                    inv,
                                    tx,
                                    user_ref,
                                    provider_slug=conn.provider_slug,
                                    reason="pdp_auto_submission",
                                )
                                db.commit()
                                auto_submit["result"] = "success"
                                auto_submit["message"] = "Transmission automatique lancée."
                        else:
                            auto_submit["attempted"] = False
                            auto_submit["result"] = "skipped_no_connection"
                            auto_submit["message"] = "Transmission automatique non lancée (connexion incompatible)."
                    except router.UsageQuotaExceeded:
                        logger.warning(
                            "pdp_auto_submit_quota_exceeded",
                            extra={"invoice_id": inv.id, "tenant_id": tenant.id, "provider": conn.provider_slug},
                        )
                        auto_submit["result"] = "quota_exceeded"
                        auto_submit["message"] = "Transmission automatique bloquée : solde de jetons insuffisant."
                        router._log_action(
                            db,
                            user_ref,
                            inv.tenant_id,
                            "invoice",
                            inv.id,
                            "pdp_auto_submit_failed",
                            {
                                "result": auto_submit["result"],
                                "message": auto_submit["message"],
                                "provider": conn.provider_slug,
                            },
                        )
                    except router.PdpProviderError as exc:
                        if exc.code == "seqino_mandate_missing":
                            auto_submit["result"] = "mandate_missing"
                            auto_submit["message"] = "Transmission automatique bloquée : mandat actif requis."
                        else:
                            auto_submit["result"] = "error"
                            auto_submit["message"] = sanitize_public_error_message(
                                exc,
                                status_code=router._provider_error_status(exc),
                                fallback="La plateforme agréée n’a pas pu traiter la transmission automatique.",
                            )
                        router._log_action(
                            db,
                            user_ref,
                            inv.tenant_id,
                            "invoice",
                            inv.id,
                            "pdp_auto_submit_failed",
                            {
                                "result": auto_submit["result"],
                                "message": auto_submit["message"],
                                "provider": conn.provider_slug,
                                "code": exc.code,
                            },
                        )
                    except Exception:
                        logger.exception(
                            "pdp_auto_submit_failed",
                            extra={"invoice_id": inv.id, "tenant_id": tenant.id, "provider": conn.provider_slug},
                        )
                        auto_submit["result"] = "error"
                        auto_submit["message"] = "Erreur lors de la transmission automatique."
                        router._log_action(
                            db,
                            user_ref,
                            inv.tenant_id,
                            "invoice",
                            inv.id,
                            "pdp_auto_submit_failed",
                            {
                                "result": auto_submit["result"],
                                "message": auto_submit["message"],
                                "provider": conn.provider_slug,
                            },
                        )

            return {
                "ok": True,
                "invoice_id": inv.id,
                "status": inv.status,
                "due_date": inv.due_date.isoformat() if inv.due_date else None,
                "auto_submit": auto_submit,
            }
        except HTTPException as exc:
            db.rollback()
            return _issue_error_from_exception(exc)
        except Exception:
            db.rollback()
            metrics.inc_operational_event("invoice_issue_failure")
            logger.exception("invoice_issue_failure", extra={"invoice_id": invoice_id, "tenant_id": tenant_id})
            raise


def issue_sync_response(result: dict) -> Response:
    if result.get("ok"):
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "status": result.get("status"),
                "due_date": result.get("due_date"),
                "auto_submit": result.get("auto_submit"),
            },
        )
    error = result.get("error") or {}
    code = error.get("code")
    message = error.get("message") or "Cette action n'a pas pu être réalisée."
    status_code = int(error.get("status_code") or 400)
    errors = error.get("errors") or []
    fields = error.get("fields") or []
    if code == "fr_einvoicing_missing_fields":
        return JSONResponse(
            status_code=status_code,
            content=_fr_einvoicing_error_payload(fields or [], errors),
        )
    if code == "fr_invoice_missing_fields":
        if not errors and fields:
            errors = fields
        return JSONResponse(
            status_code=status_code,
            content={
                "error": {"code": code, "message": message},
                "errors": errors,
                "fields": fields,
            },
        )
    if code == "fr_invoice_minimum":
        return JSONResponse(
            status_code=status_code,
            content={
                "error": {"code": code, "message": message},
                "errors": errors,
            },
        )
    if code == "sanity_checks_failed":
        return JSONResponse(
            status_code=status_code,
            content={
                "code": code,
                "message": message,
                "errors": errors,
            },
        )
    if code in {"ubl_en16931_invalid", "ubl_validation_unavailable"}:
        return JSONResponse(
            status_code=status_code,
            content={
                "code": code,
                "message": message,
                "errors": errors,
            },
        )
    detail = {"code": code, "message": message} if code else message
    raise HTTPException(status_code=status_code, detail=detail)


def issue_invoice(invoice_id: str, db: Session, user: AuthUser) -> Response:
    router = _router()
    inv = db.get(router.Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(router.Tenant, inv.tenant_id)
    customer = db.get(router.Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    fr_checks = router.validate_fr_einvoicing_fields(inv, tenant, customer)
    fr_missing_fields = router.validate_fr_b2b_invoice_ready(inv, customer, tenant)
    if fr_missing_fields:
        return _fr_einvoicing_missing_response(fr_missing_fields, fr_checks)
    if inv.status in router.IMMUTABLE_STATUSES and (inv.issued_at or inv.pdf_key or inv.xml_key or inv.facturx_key):
        raise HTTPException(409, "Facture déjà émise.")
    preflight_error = _preflight_issue_validation(inv, db, tenant, customer)
    if preflight_error:
        return issue_sync_response(preflight_error)
    if is_sync_mode():
        result = issue_invoice_job(invoice_id, user.tenant_id, user.id)
        return issue_sync_response(result)
    job = enqueue_job(
        issue_invoice_job,
        invoice_id,
        user.tenant_id,
        user.id,
        meta={"tenant_id": user.tenant_id, "invoice_id": invoice_id, "kind": "invoice_issue"},
        at_front=True,
    )
    payload = {"job_id": job.get("job_id"), "status": job.get("status")}
    if job.get("result") is not None:
        payload["result"] = job.get("result")
    if job.get("error") is not None:
        payload["error"] = job.get("error")
    return JSONResponse(status_code=202, content=payload)
