from __future__ import annotations

from fastapi import HTTPException, Request, Response

from ..action_logs import safe_log_action


def _router():
    from app.routers import invoices as invoices_router
    return invoices_router


def _log_invoice_export(db, *, user, inv, export_format: str, immutable: bool) -> None:
    safe_log_action(
        db,
        tenant_id=inv.tenant_id,
        actor_user_id=getattr(user, "id", None),
        action_type=f"export_{export_format}",
        object_type="invoice",
        object_id=inv.id,
        metadata={
            "format": export_format,
            "invoice_number": inv.number,
            "status": inv.status,
            "immutable": immutable,
        },
    )


def _download_headers(filename: str, *, disposition: str = "attachment") -> dict[str, str]:
    safe_disposition = "inline" if disposition == "inline" else "attachment"
    return {
        "Content-Disposition": f'{safe_disposition}; filename="{filename}"',
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
    }


def export_pdf(invoice_id: str, request: Request, db, user) -> Response:
    router = _router()
    inv = db.get(router.Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    immutable = router._is_invoice_immutable(inv)
    filename = router._safe_filename("facture", inv.number, "pdf")
    disposition = "inline" if str(request.query_params.get("inline", "")).lower() in {"1", "true", "yes"} else "attachment"
    if immutable:
        artifact = router.ensure_invoice_artifact(db, inv, "pdf")
        router._ensure_invoice_artifact_integrity(db, inv, artifact, "pdf")
        storage_key = router._artifact_storage_key_for_kind(inv, "PDF", artifact)
        if not storage_key:
            raise HTTPException(404, "Not found")
        _log_invoice_export(db, user=user, inv=inv, export_format="pdf", immutable=immutable)
        db.commit()
        return router._stream_invoice_artifact(
            request,
            storage_key,
            artifact.content_type,
            filename,
            disposition=disposition,
        )
    content = router.invoice_pdf(router._ctx(db, inv))
    _log_invoice_export(db, user=user, inv=inv, export_format="pdf", immutable=immutable)
    db.commit()
    return Response(
        content=content,
        media_type="application/pdf",
        headers=_download_headers(filename, disposition=disposition),
    )


def export_ubl(invoice_id: str, request: Request, db, user) -> Response:
    router = _router()
    inv = db.get(router.Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    if not router._ubl_export_enabled():
        raise HTTPException(
            status_code=403,
            detail={"code": "ubl_export_disabled", "message": "Export UBL désactivé."},
        )
    immutable = router._is_invoice_immutable(inv)
    filename = router._safe_filename("ubl", inv.number, "xml")
    if immutable:
        router.ensure_invoice_snapshot(db, inv)
        artifact = router._get_invoice_artifact(db, inv, "UBL")
        content_type = router._artifact_content_type("UBL")
        storage_key = router._artifact_storage_key_for_kind(inv, "UBL", artifact)
        if artifact and storage_key and router.head_object(storage_key):
            _log_invoice_export(db, user=user, inv=inv, export_format="ubl", immutable=immutable)
            db.commit()
            return router._stream_invoice_artifact(request, storage_key, content_type, filename)
        if artifact and artifact.data:
            payload = bytes(artifact.data)
            storage_key = router._store_invoice_artifact_payload(inv, "UBL", payload, content_type)
            router._upsert_invoice_artifact_record(
                db,
                inv,
                "UBL",
                payload,
                content_type,
                artifact=artifact,
                storage_key=storage_key,
            )
            _log_invoice_export(db, user=user, inv=inv, export_format="ubl", immutable=immutable)
            db.commit()
            return router._stream_invoice_artifact(request, storage_key, content_type, filename)
        ctx = router._ctx(db, inv)
        xml_bytes = router.ubl_document_xml(ctx)
        ubl_errors = router.validate_ubl_xml(xml_bytes)
        if ubl_errors:
            is_unavailable = any("indisponible" in err.lower() for err in ubl_errors)
            code = "ubl_validation_unavailable" if is_unavailable else "ubl_en16931_invalid"
            message = (
                "Le controle UBL EN16931 est temporairement indisponible."
                if is_unavailable
                else "Le document UBL contient des informations a corriger avant export."
            )
            raise HTTPException(
                status_code=503 if is_unavailable else 422,
                detail={"code": code, "message": message, "errors": ubl_errors},
            )
        storage_key = router._store_invoice_artifact_payload(inv, "UBL", xml_bytes, content_type)
        artifact = router._upsert_invoice_artifact_record(
            db,
            inv,
            "UBL",
            xml_bytes,
            content_type,
            artifact=artifact,
            storage_key=storage_key,
        )
        _log_invoice_export(db, user=user, inv=inv, export_format="ubl", immutable=immutable)
        db.commit()
        return router._stream_invoice_artifact(request, storage_key, artifact.content_type, filename)
    ctx = router._ctx(db, inv, allow_missing_identifiers=True)
    xml_bytes = router.ubl_document_xml(ctx)
    ubl_errors = router.validate_ubl_xml(xml_bytes)
    if ubl_errors:
        is_unavailable = any("indisponible" in err.lower() for err in ubl_errors)
        code = "ubl_validation_unavailable" if is_unavailable else "ubl_en16931_invalid"
        message = (
            "Le controle UBL EN16931 est temporairement indisponible."
            if is_unavailable
            else "Le document UBL contient des informations a corriger avant export."
        )
        raise HTTPException(
            status_code=503 if is_unavailable else 422,
            detail={"code": code, "message": message, "errors": ubl_errors},
        )
    _log_invoice_export(db, user=user, inv=inv, export_format="ubl", immutable=immutable)
    db.commit()
    return Response(
        content=xml_bytes,
        media_type="application/xml",
        headers=_download_headers(filename),
    )


def export_cii(invoice_id: str, request: Request, db, user) -> Response:
    router = _router()
    inv = db.get(router.Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(router.Tenant, inv.tenant_id)
    customer = db.get(router.Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    fr_missing_fields = router.validate_fr_b2b_invoice_ready(inv, customer, tenant)
    if fr_missing_fields:
        fr_checks = router.validate_fr_einvoicing_fields(inv, tenant, customer)
        return router._fr_einvoicing_missing_response(fr_missing_fields, fr_checks)
    immutable = router._is_invoice_immutable(inv)
    filename = router._safe_filename("cii", inv.number, "xml")
    if immutable:
        artifact = router.ensure_invoice_artifact(db, inv, "cii")
        router._ensure_invoice_artifact_integrity(db, inv, artifact, "cii")
        storage_key = router._artifact_storage_key_for_kind(inv, "CII", artifact)
        if not storage_key:
            raise HTTPException(404, "Not found")
        _log_invoice_export(db, user=user, inv=inv, export_format="cii", immutable=immutable)
        db.commit()
        return router._stream_invoice_artifact(request, storage_key, artifact.content_type, filename)
    content = router.cii_invoice_xml(router._ctx(db, inv))
    _log_invoice_export(db, user=user, inv=inv, export_format="cii", immutable=immutable)
    db.commit()
    return Response(
        content=content,
        media_type="application/xml",
        headers=_download_headers(filename),
    )


def export_facturx(invoice_id: str, request: Request, db, user) -> Response:
    router = _router()
    inv = db.get(router.Invoice, invoice_id)
    if not inv or inv.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    tenant = db.get(router.Tenant, inv.tenant_id)
    customer = db.get(router.Customer, inv.customer_id)
    if not tenant or not customer:
        raise HTTPException(404, "Not found")
    fr_missing_fields = router.validate_fr_b2b_invoice_ready(inv, customer, tenant)
    if fr_missing_fields:
        fr_checks = router.validate_fr_einvoicing_fields(inv, tenant, customer)
        return router._fr_einvoicing_missing_response(fr_missing_fields, fr_checks)
    immutable = router._is_invoice_immutable(inv)
    filename = router._safe_filename("facturx", inv.number, "pdf")
    if immutable:
        artifact = router.ensure_invoice_artifact(db, inv, "facturx")
        router._ensure_invoice_artifact_integrity(db, inv, artifact, "facturx")
        storage_key = router._artifact_storage_key_for_kind(inv, "FACTURX", artifact)
        if not storage_key:
            raise HTTPException(404, "Not found")
        _log_invoice_export(db, user=user, inv=inv, export_format="facturx", immutable=immutable)
        db.commit()
        return router._stream_invoice_artifact(request, storage_key, artifact.content_type, filename)
    ctx = router._ctx(db, inv)
    try:
        pdf_fx, pdfa_status, pdfa_report = router.facturx_pdf_with_meta(ctx)
    except router.FacturxXsdValidationError as exc:
        router._raise_facturx_xsd_error(exc)
    except router.FacturxSchematronValidationError as exc:
        router._raise_facturx_schematron_error(exc)
    except router.FacturxEmbedError as exc:
        router._raise_facturx_embed_error(exc)
    except router.FacturxPdfa3Error as exc:
        router._raise_facturx_pdfa_error(exc)
    inv.pdfa3_status = pdfa_status
    inv.pdfa3_report = router.sanitize_public_pdfa_report(pdfa_report, pdfa_status)
    inv.facturx_spec_version = router.settings.FACTURX_SPEC_VERSION
    db.add(inv)
    _log_invoice_export(db, user=user, inv=inv, export_format="facturx", immutable=immutable)
    db.commit()
    return Response(
        content=pdf_fx,
        media_type="application/pdf",
        headers=_download_headers(filename),
    )
