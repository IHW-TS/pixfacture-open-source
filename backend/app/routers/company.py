import json
import hashlib
import logging
import os
import tempfile
import zipfile
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AuthUser, require_tenant_admin, require_viewer_or_admin
from ..jobs.queue import enqueue_job
from ..jobs.seqino_periodicity import sync_seqino_periodicity
from ..services.billable_events import record_billable_event
from ..services.accounting_exports import (
    accounting_period_lock_payload,
    find_delivered_accounting_period_lock,
    record_accounting_export,
)
from ..services.logo_storage import detect_logo_content_type, get_logo_url, save_logo
from ..services.product_capabilities import ensure_product_feature, is_product_feature_enabled
from ..services.connected_mode import is_connected_mode_operational
from ..services.seqino_periodicity_payload import (
    _build_seqino_periodicity_payload,
    _normalize_payment_periodicity,
    _normalize_transaction_periodicity,
    _normalize_vat_regime,
    is_vat_franchise_regime,
)
from ..services.email import email_delivery_status_payload
from ..services.action_logs import log_action
from ..services.storage import delete_object, get_object_stream
from ..models import Customer, Invoice, Numbering, PdpConnection, Quote, QuoteNumbering, Tenant, TenantBankAccount
from ..schemas import (
    CompanyBankAccountCreate,
    CompanyBankAccountOut,
    CompanyBankAccountUpdate,
    CompanyProfile,
    CompanyProfileUpdate,
)
from ..utils.asset_security import allowed_cdn_hosts, is_private_host, resolve_static_path

router = APIRouter(prefix="/api/company", tags=["company"])
logger = logging.getLogger(__name__)

_LOGO_CONTENT_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
}
_LOGO_EXTENSIONS = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}
_MAX_LOGO_BYTES = 2_000_000
VAT_FRANCHISE_NOTICE = "TVA non applicable, art. 293 B du CGI"


class CompanyNumberingUpdate(BaseModel):
    invoice_prefix: str | None = Field(default=None, max_length=16)
    invoice_year: int | None = Field(default=None, ge=2000, le=2100)
    invoice_next_number: int | None = Field(default=None, ge=1, le=999_999)
    quote_prefix: str | None = Field(default=None, max_length=16)
    quote_year: int | None = Field(default=None, ge=2000, le=2100)
    quote_next_number: int | None = Field(default=None, ge=1, le=999_999)


def _normalize_company_phone(value: str | None) -> str | None:
    cleaned = "".join(ch for ch in str(value or "") if ch.isdigit() or ch in "+().- ")
    cleaned = " ".join(cleaned.split())
    return cleaned[:24] or None


def _has_professional_identifier(tenant: Tenant) -> bool:
    country = (tenant.country_code or tenant.country or "FR").strip().upper()
    siret_digits = re.sub(r"\D", "", tenant.siret or "")
    rcs_digits = re.sub(r"\D", "", tenant.rcs or "")
    vat_number = re.sub(r"[\s.\-]", "", tenant.vat_number or "").upper()
    if country == "FR":
        return len(siret_digits) in {9, 14} or len(rcs_digits) in {9, 14}
    return bool(siret_digits or rcs_digits or vat_number)


def _normalize_logo_url(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    parsed = urlparse(cleaned)
    scheme = (parsed.scheme or "").lower()
    if not scheme:
        if cleaned.startswith("/static/"):
            local_path = resolve_static_path(parsed.path or cleaned)
            if not local_path or not local_path.exists():
                raise HTTPException(
                    400, detail={"code": "logo_url_invalid", "message": "Logo introuvable sur /static."}
                )
            return cleaned
        if cleaned.startswith("/api/company/logo") or cleaned.startswith("api/company/logo"):
            return cleaned
        raise HTTPException(400, detail={"code": "logo_url_invalid", "message": "Logo interne uniquement."})
    if scheme == "https":
        host = (parsed.hostname or "").strip().lower()
        if not host or is_private_host(host):
            raise HTTPException(400, detail={"code": "logo_url_invalid", "message": "Hôte logo interdit."})
        if host not in allowed_cdn_hosts():
            raise HTTPException(400, detail={"code": "logo_url_invalid", "message": "Logo externe interdit."})
        return cleaned
    raise HTTPException(400, detail={"code": "logo_url_invalid", "message": "Logo externe interdit."})


def _write_stream_to_zip(zip_handle: zipfile.ZipFile, zip_path: str, stream) -> tuple[int, str]:
    digest = hashlib.sha256()
    size_bytes = 0
    with zip_handle.open(zip_path, "w") as dest:
        for chunk in stream.body:
            dest.write(chunk)
            digest.update(chunk)
            size_bytes += len(chunk)
    return size_bytes, digest.hexdigest()


def _safe_zip_basename(key: str) -> str:
    base = os.path.basename((key or "").replace("\\", "/"))
    return base or "artifact.bin"


def _cleanup_temp_file(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        return


def _tenant_id_or_raise(tenant: Tenant) -> str:
    tenant_id = tenant.id
    if not tenant_id:
        raise HTTPException(500, "Entreprise invalide")
    return tenant_id


def _normalize_numbering_prefix(value: str | None, fallback: str) -> str:
    cleaned = "".join(ch for ch in str(value or "").strip().upper() if ch.isalnum() or ch in "-_/")
    if not cleaned:
        cleaned = fallback
    if len(cleaned) > 16:
        raise HTTPException(
            400,
            detail={"code": "numbering_prefix_invalid", "message": "Préfixe de numérotation trop long."},
        )
    return cleaned


def _current_year() -> int:
    return datetime.now(timezone.utc).year


def _get_or_create_invoice_numbering(db: Session, tenant_id: str, *, lock: bool = False) -> Numbering:
    query = db.query(Numbering).filter(Numbering.tenant_id == tenant_id)
    if lock:
        query = query.with_for_update()
    numbering = query.first()
    if numbering:
        return numbering
    numbering = Numbering(tenant_id=tenant_id, prefix="F-", last_index=0, year=_current_year())
    db.add(numbering)
    db.flush()
    return numbering


def _get_or_create_quote_numbering(db: Session, tenant_id: str, *, lock: bool = False) -> QuoteNumbering:
    query = db.query(QuoteNumbering).filter(QuoteNumbering.tenant_id == tenant_id)
    if lock:
        query = query.with_for_update()
    numbering = query.first()
    if numbering:
        return numbering
    numbering = QuoteNumbering(tenant_id=tenant_id, prefix="D-", last_index=0, year=_current_year())
    db.add(numbering)
    db.flush()
    return numbering


def _numbering_payload(invoice_numbering: Numbering, quote_numbering: QuoteNumbering) -> dict[str, Any]:
    return {
        "invoice_prefix": invoice_numbering.prefix or "F-",
        "invoice_year": int(invoice_numbering.year or _current_year()),
        "invoice_last_number": int(invoice_numbering.last_index or 0),
        "invoice_next_number": int(invoice_numbering.last_index or 0) + 1,
        "quote_prefix": quote_numbering.prefix or "D-",
        "quote_year": int(quote_numbering.year or _current_year()),
        "quote_last_number": int(quote_numbering.last_index or 0),
        "quote_next_number": int(quote_numbering.last_index or 0) + 1,
    }


def _max_document_index_for_series(db: Session, model: Any, tenant_id: str, prefix: str, year: int) -> int:
    series_prefix = f"{prefix}{year}-"
    rows = (
        db.query(model.number)
        .filter(model.tenant_id == tenant_id, model.number.isnot(None), model.number.like(f"{series_prefix}%"))
        .all()
    )
    max_index = 0
    for row in rows:
        number = str(row[0] or "")
        if not number.startswith(series_prefix):
            continue
        suffix = number[len(series_prefix) :]
        if suffix.isdigit():
            max_index = max(max_index, int(suffix))
    return max_index


def _apply_numbering_update(
    numbering: Numbering | QuoteNumbering,
    *,
    prefix: str | None,
    fallback_prefix: str,
    year: int | None,
    next_number: int | None,
    label: str,
    existing_last_index: int = 0,
) -> None:
    if prefix is not None:
        numbering.prefix = _normalize_numbering_prefix(prefix, fallback_prefix)
    year_changed = year is not None and year != numbering.year
    if year_changed:
        numbering.year = year
        numbering.last_index = 0
    current_last_index = int(numbering.last_index or 0)
    minimum_last_index = max(current_last_index, int(existing_last_index or 0))
    requested_next_number = next_number if next_number is not None else current_last_index + 1
    if requested_next_number <= minimum_last_index:
        raise HTTPException(
            400,
            detail={
                "code": "numbering_next_too_low",
                "message": (
                    f"Le prochain numéro {label} doit être supérieur au dernier numéro déjà utilisé pour cette série."
                ),
            },
        )
    if next_number is not None:
        numbering.last_index = next_number - 1


def _bank_accounts(db: Session, tenant_id: str) -> list[TenantBankAccount]:
    return (
        db.query(TenantBankAccount)
        .filter(TenantBankAccount.tenant_id == tenant_id)
        .order_by(TenantBankAccount.is_default.desc(), TenantBankAccount.created_at.asc())
        .all()
    )


def _sync_tenant_default_bank(db: Session, tenant: Tenant, account: TenantBankAccount | None) -> None:
    tenant.iban = account.iban if account else None
    tenant.bic = account.bic if account else None
    db.add(tenant)


def _clear_other_default_bank_accounts(db: Session, tenant_id: str, account_id: str) -> None:
    (
        db.query(TenantBankAccount)
        .filter(TenantBankAccount.tenant_id == tenant_id, TenantBankAccount.id != account_id)
        .update({TenantBankAccount.is_default: False}, synchronize_session=False)
    )


def _ensure_default_bank_account(db: Session, tenant: Tenant) -> None:
    tenant_id = _tenant_id_or_raise(tenant)
    existing = _bank_accounts(db, tenant_id)
    if existing:
        default = next((account for account in existing if account.is_default), None)
        if not default:
            existing[0].is_default = True
            _sync_tenant_default_bank(db, tenant, existing[0])
            db.add(existing[0])
            db.flush()
        return
    if not ((tenant.iban or "").strip() or (tenant.bic or "").strip()):
        return
    account = TenantBankAccount(
        id=str(uuid4()),
        tenant_id=tenant_id,
        label="RIB principal",
        iban=tenant.iban,
        bic=tenant.bic,
        is_default=True,
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(account)
    db.flush()


def _sync_default_bank_account_from_tenant_update(db: Session, tenant: Tenant) -> None:
    tenant_id = _tenant_id_or_raise(tenant)
    if not ((tenant.iban or "").strip() or (tenant.bic or "").strip()):
        (db.query(TenantBankAccount).filter(TenantBankAccount.tenant_id == tenant_id).delete(synchronize_session=False))
        return
    _ensure_default_bank_account(db, tenant)
    default = (
        db.query(TenantBankAccount)
        .filter(TenantBankAccount.tenant_id == tenant_id, TenantBankAccount.is_default.is_(True))
        .order_by(TenantBankAccount.created_at.asc())
        .first()
    )
    if not default:
        return
    default.iban = tenant.iban
    default.bic = tenant.bic
    default.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(default)


@router.get("/profile", response_model=CompanyProfile)
def get_profile(db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    t = db.get(Tenant, user.tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = _tenant_id_or_raise(t)
    if t.logo_storage_key:
        t.logo_url = get_logo_url(tenant_id, t.logo_storage_key) or t.logo_url
    return t


@router.get("/numbering")
def get_numbering(db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = _tenant_id_or_raise(tenant)
    invoice_numbering = _get_or_create_invoice_numbering(db, tenant_id)
    quote_numbering = _get_or_create_quote_numbering(db, tenant_id)
    db.commit()
    return _numbering_payload(invoice_numbering, quote_numbering)


@router.patch("/numbering")
def update_numbering(
    body: CompanyNumberingUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = _tenant_id_or_raise(tenant)
    invoice_numbering = _get_or_create_invoice_numbering(db, tenant_id, lock=True)
    quote_numbering = _get_or_create_quote_numbering(db, tenant_id, lock=True)
    invoice_prefix = (
        _normalize_numbering_prefix(body.invoice_prefix, "F-")
        if body.invoice_prefix is not None
        else invoice_numbering.prefix or "F-"
    )
    invoice_year = int(body.invoice_year or invoice_numbering.year or _current_year())
    quote_prefix = (
        _normalize_numbering_prefix(body.quote_prefix, "D-")
        if body.quote_prefix is not None
        else quote_numbering.prefix or "D-"
    )
    quote_year = int(body.quote_year or quote_numbering.year or _current_year())
    invoice_existing_last = max(
        _max_document_index_for_series(db, Invoice, tenant_id, invoice_prefix, invoice_year),
        _max_document_index_for_series(db, Invoice, tenant_id, "AV-", invoice_year),
    )
    quote_existing_last = _max_document_index_for_series(db, Quote, tenant_id, quote_prefix, quote_year)
    _apply_numbering_update(
        invoice_numbering,
        prefix=body.invoice_prefix,
        fallback_prefix="F-",
        year=body.invoice_year,
        next_number=body.invoice_next_number,
        label="facture",
        existing_last_index=invoice_existing_last,
    )
    _apply_numbering_update(
        quote_numbering,
        prefix=body.quote_prefix,
        fallback_prefix="D-",
        year=body.quote_year,
        next_number=body.quote_next_number,
        label="devis",
        existing_last_index=quote_existing_last,
    )
    db.add(invoice_numbering)
    db.add(quote_numbering)
    db.commit()
    db.refresh(invoice_numbering)
    db.refresh(quote_numbering)
    return _numbering_payload(invoice_numbering, quote_numbering)


@router.get("/email-delivery-status")
def get_email_delivery_status(db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    return email_delivery_status_payload(reply_to=tenant.email_reply_to)


@router.put("/profile", response_model=CompanyProfile)
@router.patch("/profile", response_model=CompanyProfile)
def update_profile(
    body: CompanyProfileUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    t = db.get(Tenant, user.tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = _tenant_id_or_raise(t)
    previous_siret = re.sub(r"\D", "", t.siret or "")
    allowed_fields = {
        "name",
        "siret",
        "rcs",
        "naf_code",
        "legal_form",
        "share_capital",
        "address",
        "address_line1",
        "address_line2",
        "postal_code",
        "city",
        "country_code",
        "country",
        "phone",
        "vat_number",
        "iban",
        "bic",
        "logo_url",
        "legal_mentions",
        "vat_exemption_notice",
        "vat_regime",
        "default_sales_vat_rate",
        "transaction_periodicity",
        "payment_periodicity",
        "payments_reporting_enabled",
        "email_subject_default",
        "email_body_default",
        "reminder_subject_default",
        "reminder_body_default",
        "quote_email_subject_default",
        "quote_email_body_default",
        "quote_followup_subject_default",
        "quote_followup_body_default",
        "quote_acceptance_mode",
        "quote_terms_url",
        "quote_terms_required",
        "quote_otp_subject_default",
        "quote_otp_body_default",
        "email_reply_to",
        "fec_journal_code",
        "fec_journal_label",
        "fec_account_customer",
        "fec_account_revenue",
        "fec_account_vat",
        "retention_years",
        "vat_on_debits",
        "late_payment_interest",
        "recovery_fee_eur",
        "discount_terms",
    }
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k in allowed_fields}
    periodicity_keys = {"vat_regime", "transaction_periodicity", "payment_periodicity"}
    periodicity_payload: dict[str, str | None] = {}
    if "quote_terms_url" in updates:
        updates["quote_terms_url"] = (updates.get("quote_terms_url") or "").strip() or None
    if "phone" in updates:
        updates["phone"] = _normalize_company_phone(updates.get("phone"))
    if "country_code" in updates and updates.get("country_code") is not None:
        updates["country_code"] = (updates["country_code"] or "").strip().upper() or None
        if "country" not in updates and updates["country_code"]:
            updates["country"] = updates["country_code"]
    if "logo_url" in updates:
        normalized_logo = _normalize_logo_url(updates.get("logo_url"))
        updates["logo_url"] = normalized_logo
        updates["logo_storage_key"] = None
        if normalized_logo != t.logo_url and t.logo_storage_key:
            try:
                delete_object(t.logo_storage_key)
            except Exception:
                pass
    if "retention_years" in updates and updates.get("retention_years") is not None:
        country = (updates.get("country") or t.country or "").strip().upper()
        if country == "FR" and int(updates["retention_years"]) < 10:
            raise HTTPException(
                400,
                detail={
                    "code": "retention_years_minimum_fr",
                    "message": "En France, la conservation comptable minimale est de 10 ans.",
                },
            )
    if "vat_regime" in updates and updates.get("vat_regime") is not None:
        updates["vat_regime"] = _normalize_vat_regime(updates["vat_regime"])
    effective_vat_regime = updates.get("vat_regime", t.vat_regime)
    if "default_sales_vat_rate" in updates and updates.get("default_sales_vat_rate") is not None:
        try:
            rate = Decimal(str(updates["default_sales_vat_rate"])).quantize(Decimal("0.01"))
        except (InvalidOperation, ValueError):
            raise HTTPException(
                400,
                detail={"code": "default_sales_vat_rate_invalid", "message": "Taux TVA ventes invalide."},
            )
        if rate < 0 or rate > 100:
            raise HTTPException(
                400,
                detail={"code": "default_sales_vat_rate_invalid", "message": "Taux TVA ventes entre 0 et 100 requis."},
            )
        updates["default_sales_vat_rate"] = rate
    if is_vat_franchise_regime(effective_vat_regime):
        updates["vat_on_debits"] = False
        updates["default_sales_vat_rate"] = Decimal("0.00")
        if "vat_exemption_notice" in updates:
            if not str(updates.get("vat_exemption_notice") or "").strip():
                updates["vat_exemption_notice"] = VAT_FRANCHISE_NOTICE
        elif not str(t.vat_exemption_notice or "").strip():
            updates["vat_exemption_notice"] = VAT_FRANCHISE_NOTICE
    if "transaction_periodicity" in updates and updates.get("transaction_periodicity") is not None:
        updates["transaction_periodicity"] = _normalize_transaction_periodicity(updates["transaction_periodicity"])
    if "payment_periodicity" in updates and updates.get("payment_periodicity") is not None:
        updates["payment_periodicity"] = _normalize_payment_periodicity(updates["payment_periodicity"])
    periodicity_payload = {k: updates[k] for k in periodicity_keys if k in updates}
    for k, v in updates.items():
        setattr(t, k, v)
    current_siret = re.sub(r"\D", "", t.siret or "")
    if "siret" in updates and current_siret != previous_siret:
        chorus_connections = (
            db.query(PdpConnection)
            .filter(
                PdpConnection.tenant_id == tenant_id,
                PdpConnection.provider_slug.in_({"chorus", "choruspro"}),
            )
            .all()
        )
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        for connection in chorus_connections:
            connection.status = "configured"
            connection.verified_siret = None
            connection.verified_structure_id = None
            connection.verified_at = None
            connection.updated_at = now
            db.add(connection)
        if chorus_connections:
            log_action(
                db,
                tenant_id=tenant_id,
                actor_user_id=user.id,
                action_type="chorus_connection_demoted_siret_change",
                object_type="pdp_connection",
                object_id=chorus_connections[0].id,
                metadata={"provider_slug": "choruspro", "status": "configured"},
            )
    if body.professional_use_confirmed is True and not t.professional_use_confirmed_at:
        if not _has_professional_identifier(t):
            raise HTTPException(
                400,
                detail={
                    "code": "professional_identifier_required",
                    "message": "Renseignez un SIRET ou un identifiant professionnel avant de confirmer l'usage professionnel.",
                    "field": "siret",
                },
            )
        t.professional_use_confirmed_at = datetime.now(timezone.utc).replace(tzinfo=None)
        t.professional_use_confirmed_by = user.id
    if "iban" in updates or "bic" in updates:
        _sync_default_bank_account_from_tenant_update(db, t)
    periodicity_sync_required = False
    if periodicity_payload:
        _build_seqino_periodicity_payload(t)
        periodicity_sync_required = is_connected_mode_operational(db, tenant_id, "seqino")
        t.seqino_last_periodicity_sync_status = (
            "sync_pending" if periodicity_sync_required else "skipped_not_operational"
        )
        t.seqino_last_periodicity_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)

    db.add(t)
    db.commit()
    db.refresh(t)

    if periodicity_sync_required:
        enqueue_job(
            sync_seqino_periodicity,
            tenant_id,
            meta={"tenant_id": tenant_id, "job": "seqino_periodicity_sync"},
        )

    if t.logo_storage_key:
        t.logo_url = get_logo_url(tenant_id, t.logo_storage_key) or t.logo_url
    return t


@router.get("/bank-accounts", response_model=list[CompanyBankAccountOut])
def list_bank_accounts(db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    _ensure_default_bank_account(db, tenant)
    db.commit()
    return _bank_accounts(db, _tenant_id_or_raise(tenant))


@router.post("/bank-accounts", response_model=CompanyBankAccountOut)
def create_bank_account(
    body: CompanyBankAccountCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = _tenant_id_or_raise(tenant)
    existing = _bank_accounts(db, tenant_id)
    make_default = bool(body.is_default) or not any(account.is_default for account in existing)
    account = TenantBankAccount(
        id=str(uuid4()),
        tenant_id=tenant_id,
        label=body.label,
        iban=body.iban,
        bic=body.bic,
        is_default=make_default,
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(account)
    db.flush()
    if make_default:
        _clear_other_default_bank_accounts(db, tenant_id, account.id)
        _sync_tenant_default_bank(db, tenant, account)
    db.commit()
    db.refresh(account)
    return account


@router.patch("/bank-accounts/{account_id}", response_model=CompanyBankAccountOut)
def update_bank_account(
    account_id: str,
    body: CompanyBankAccountUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    account = db.get(TenantBankAccount, account_id)
    if not account or account.tenant_id != user.tenant_id:
        raise HTTPException(404, "RIB introuvable")
    updates = body.model_dump(exclude_unset=True)
    for field in ("label", "iban", "bic"):
        if field in updates:
            setattr(account, field, updates[field])
    if not ((account.iban or "").strip() or (account.bic or "").strip()):
        raise HTTPException(
            400, detail={"code": "bank_account_empty", "message": "Renseignez au moins un IBAN ou un BIC."}
        )
    if updates.get("is_default") is True:
        account.is_default = True
        _clear_other_default_bank_accounts(db, user.tenant_id, account.id)
    elif updates.get("is_default") is False and account.is_default:
        raise HTTPException(
            400,
            detail={
                "code": "default_bank_account_required",
                "message": "Choisissez un autre RIB par défaut avant de retirer celui-ci.",
            },
        )
    account.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(account)
    if account.is_default:
        _sync_tenant_default_bank(db, tenant, account)
    db.commit()
    db.refresh(account)
    return account


@router.delete("/bank-accounts/{account_id}", response_model=dict)
def delete_bank_account(
    account_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    account = db.get(TenantBankAccount, account_id)
    if not account or account.tenant_id != user.tenant_id:
        raise HTTPException(404, "RIB introuvable")
    was_default = bool(account.is_default)
    db.delete(account)
    db.flush()
    if was_default:
        next_default = (
            db.query(TenantBankAccount)
            .filter(TenantBankAccount.tenant_id == user.tenant_id)
            .order_by(TenantBankAccount.created_at.asc())
            .first()
        )
        if next_default:
            next_default.is_default = True
            next_default.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.add(next_default)
        _sync_tenant_default_bank(db, tenant, next_default)
    db.commit()
    return {"ok": True}


@router.post("/logo")
async def upload_logo(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    raw = await file.read()
    if len(raw) > _MAX_LOGO_BYTES:
        raise HTTPException(400, detail={"code": "logo_too_large", "message": "Logo trop volumineux (max 2MB)."})
    detected_content_type = detect_logo_content_type(raw)
    declared_content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if not detected_content_type or (declared_content_type and declared_content_type != detected_content_type):
        raise HTTPException(400, detail={"code": "logo_invalid_format", "message": "Format logo non supporté."})
    t = db.get(Tenant, user.tenant_id)
    if not t:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = _tenant_id_or_raise(t)
    storage_key, logo_url = save_logo(tenant_id, raw, detected_content_type)
    previous_key = t.logo_storage_key
    t.logo_storage_key = storage_key
    t.logo_url = logo_url
    db.add(t)
    db.commit()
    db.refresh(t)
    if previous_key and previous_key != storage_key:
        try:
            delete_object(previous_key)
        except Exception:
            pass
    return {"logo_url": t.logo_url}


@router.get("/logo")
def get_logo(
    key: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
):
    if key.startswith("/") or ".." in key or not key.startswith("logos/"):
        raise HTTPException(400, detail={"code": "logo_key_invalid", "message": "Clé logo invalide."})
    tenant = db.query(Tenant).filter(Tenant.logo_storage_key == key).first()
    if not tenant:
        raise HTTPException(404, "Logo introuvable")
    stream = get_object_stream(key)
    if not stream:
        raise HTTPException(404, "Logo introuvable")
    ext = os.path.splitext(key)[1].lower()
    content_type = stream.content_type or _LOGO_EXTENSIONS.get(ext, "application/octet-stream")
    headers = {"Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff"}
    if stream.content_length:
        headers["Content-Length"] = str(stream.content_length)
    if stream.etag:
        headers["ETag"] = stream.etag
    return StreamingResponse(stream.body, media_type=content_type, headers=headers)


def _parse_archive_bound(raw_date: str | None, *, end: bool = False) -> datetime | None:
    if not raw_date:
        return None
    cleaned = raw_date.strip()
    if not cleaned:
        return None
    try:
        value = datetime.fromisoformat(cleaned)
    except Exception:
        return None
    if end and len(cleaned) <= 10:
        return value + timedelta(days=1)
    return value


def _normalize_archive_invoice_ids(invoice_ids: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for item in invoice_ids or []:
        for part in str(item or "").split(","):
            cleaned = part.strip()
            if cleaned and cleaned not in normalized:
                normalized.append(cleaned)
    return normalized


@router.get("/archive.zip")
def export_archive(
    background_tasks: BackgroundTasks,
    start_date: str | None = None,
    end_date: str | None = None,
    invoice_ids: list[str] | None = Query(None),
    q: str | None = Query(None, description="Recherche facture (numéro, commande, client)"),
    customer_id: str | None = None,
    status: str | None = Query(None, description="draft|issued|sent|paid|overdue|canceled"),
    force_export: bool = Query(False, description="Forcer l'export malgré une période déjà remise"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    tenant_id = _tenant_id_or_raise(tenant)
    structured_artifacts_enabled = is_product_feature_enabled(tenant, "einvoicing_enabled")
    payments_enabled = is_product_feature_enabled(tenant, "payments_enabled")
    if (status or "").strip().lower() in {"pending", "paid", "partial", "overdue"} and not payments_enabled:
        ensure_product_feature(tenant, "payments_enabled")
    query = db.query(Invoice).filter(Invoice.tenant_id == tenant_id)
    selected_ids = _normalize_archive_invoice_ids(invoice_ids)
    if selected_ids:
        query = query.filter(Invoice.id.in_(selected_ids))
    if status and status != "all":
        query = query.filter(Invoice.status == status)
    if customer_id:
        query = query.filter(Invoice.customer_id == customer_id)
    start = _parse_archive_bound(start_date)
    end = _parse_archive_bound(end_date, end=True)
    if start:
        query = query.filter(Invoice.issue_date >= start)
    if end:
        query = query.filter(Invoice.issue_date < end)
    if start and end and start >= end:
        query = query.filter(False)
    search = (q or "").strip()
    if search:
        like = f"%{search}%"
        query = query.join(Customer, Customer.id == Invoice.customer_id).filter(
            or_(
                Invoice.number.ilike(like),
                Invoice.purchase_order_number.ilike(like),
                Customer.name.ilike(like),
            )
        )
    invoices = query.order_by(Invoice.issue_date.desc()).all()
    if not force_export:
        lock = find_delivered_accounting_period_lock(
            db,
            tenant_id=tenant_id,
            period_start=start_date,
            period_end=end_date,
            customer_id=customer_id,
        )
        if lock:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "accounting_period_locked",
                    "message": (
                        "Cette période a déjà été marquée remise au cabinet. "
                        "Déverrouillez l'export dans Paramètres > Exports avant de régénérer l'archive."
                    ),
                    "lock": accounting_period_lock_payload(lock),
                },
            )
    temp = tempfile.NamedTemporaryFile(prefix=f"archive-{tenant_id}-", suffix=".zip", delete=False)
    temp_path = temp.name
    temp.close()
    manifest_invoices: list[dict[str, Any]] = []
    manifest: dict[str, Any] = {
        "tenant_id": tenant_id,
        "tenant_name": tenant.name,
        "created_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        "invoice_count": len(invoices),
        "structured_artifacts_included": structured_artifacts_enabled,
        "payment_tracking_included": payments_enabled,
        "invoices": manifest_invoices,
    }
    with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for inv in invoices:
            entry_artifacts: list[dict[str, Any]] = []
            entry_missing: list[str] = []
            entry: dict[str, Any] = {
                "invoice_id": inv.id,
                "number": inv.number,
                "status": (
                    inv.status
                    if payments_enabled
                    else "sent"
                    if str(inv.status or "").strip().lower() in {"paid", "partial", "overdue"} and inv.sent_at
                    else "issued"
                    if str(inv.status or "").strip().lower() in {"paid", "partial", "overdue"}
                    else inv.status
                ),
                "issue_date": inv.issue_date.isoformat() if inv.issue_date else None,
                "artifacts": entry_artifacts,
                "missing": entry_missing,
            }
            artifact_keys = [inv.pdf_key]
            if structured_artifacts_enabled:
                artifact_keys.extend([inv.xml_key, inv.facturx_key])
            for key in artifact_keys:
                if not key:
                    continue
                stream = get_object_stream(key)
                if not stream:
                    entry_missing.append(key)
                    continue
                base_name = _safe_zip_basename(key)
                zip_path = f"invoices/{inv.id}/{base_name}"
                size_bytes, sha256 = _write_stream_to_zip(archive, zip_path, stream)
                entry_artifacts.append(
                    {
                        "key": key,
                        "path": zip_path,
                        "size": size_bytes,
                        "sha256": sha256,
                    }
                )
            manifest_invoices.append(entry)
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=True, indent=2))
    safe_slug = (tenant.tenant_slug or tenant_id).replace("/", "_")
    filename = f"archive-{safe_slug}.zip"
    background_tasks.add_task(_cleanup_temp_file, temp_path)
    record_billable_event(
        db,
        tenant_id=tenant_id,
        event_type="archive_export",
        provider_slug=None,
        invoice_id=None,
        status="exported",
        source_type="archive_export",
        source_id=str(uuid4()),
    )
    record_accounting_export(
        db,
        tenant_id=tenant_id,
        export_format="archive_zip",
        created_by=user.id,
        period_start=start_date,
        period_end=end_date,
        customer_id=customer_id,
        record_count=len(invoices),
        filters={
            "format": "archive_zip",
            "record_count": len(invoices),
            "start_date": start_date,
            "end_date": end_date,
            "invoice_ids": selected_ids,
            "q": q,
            "customer_id": customer_id,
            "status": status,
        },
        commit=True,
    )
    return FileResponse(
        temp_path,
        media_type="application/zip",
        filename=filename,
        headers={
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )
