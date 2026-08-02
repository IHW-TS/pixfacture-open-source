import csv
import io
import re
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, Response, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.exc import SQLAlchemyError, IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..config import settings
from ..models import (
    Customer,
    CustomerContact,
    CustomerSupplierRelation,
    CustomerUserLink,
    InboundInvoice,
    Invoice,
    Payment,
    PurchaseSupplier,
    Quote,
    Tenant,
)
from ..schemas import (
    CustomerCreate,
    CustomerUpdate,
    CustomerListOut,
    CustomerContactCreate,
    CustomerContactUpdate,
    CustomerContactOut,
)
from ..deps import (
    require_accountant_or_admin,
    require_viewer_or_admin,
    require_tenant_admin,
    AuthUser,
    require_viewer_or_admin_or_api_key,
    require_customer_manager_or_api_key,
    require_paid_subscription_or_trial,
    require_paid_subscription,
    API_SCOPE_READ_CUSTOMERS,
    API_SCOPE_WRITE_CUSTOMERS,
)
from ..services.directory import lookup_directory_entry
from ..services.product_capabilities import ensure_product_feature, is_product_feature_enabled
from ..services.sirene import (
    lookup_company,
    SireneLookupError,
    SireneNotConfigured,
    SireneNotFound,
)

router = APIRouter(prefix="/api/customers", tags=["customers"])

SIRET_RE = re.compile(r"^\d{14}$")
SIREN_RE = re.compile(r"^\d{9}$")
VAT_FR_RE = re.compile(r"^FR[0-9A-Z]{2}[0-9]{9}$")
ALLOWED_CLIENT_TYPES = {"business", "individual", "public"}
PUBLIC_CLIENT_TYPES = {"public", "public_sector", "government", "state", "b2g"}
CSV_INJECTION_PREFIXES = ("=", "+", "-", "@")
CUSTOMER_IMPORT_ALLOWED_EXTENSIONS = (".csv",)
CUSTOMER_IMPORT_ALLOWED_CONTENT_TYPES = {
    "",
    "application/csv",
    "application/octet-stream",
    "application/vnd.ms-excel",
    "text/csv",
    "text/plain",
}
CUSTOMER_IMPORT_DUPLICATE_REASONS = {"duplicate_email", "duplicate_siret", "duplicate_siren", "duplicate_vat_number"}
CUSTOMER_IMPORT_HEADER_ALIASES = {
    "adresse": "address",
    "adresse_email": "email",
    "adresse mail": "email",
    "adresse_mail": "email",
    "adresse postale": "address",
    "address": "address",
    "client": "name",
    "client_type": "client_type",
    "country": "country",
    "courriel": "email",
    "e-mail": "email",
    "email": "email",
    "mail": "email",
    "name": "name",
    "nom": "name",
    "nom client": "name",
    "nom_client": "name",
    "pays": "country",
    "phone": "phone",
    "raison sociale": "name",
    "raison_sociale": "name",
    "siren": "siren",
    "siret": "siret",
    "societe": "name",
    "société": "name",
    "telephone": "phone",
    "téléphone": "phone",
    "type": "client_type",
    "tva": "vat_number",
    "vat": "vat_number",
    "vat_number": "vat_number",
}
CUSTOMER_SUPPLIER_SYNC_FIELDS = {"name", "siren", "siret", "vat_number"}
CUSTOMER_SUPPLIER_SYNC_DIRECTIONS = {"supplier_to_customer", "customer_to_supplier", "keep"}
CUSTOMER_EINVOICING_FIELDS = frozenset(
    {
        "endpoint_id",
        "pdp_name",
        "public_service_code",
        "public_commitment_reference",
        "chorus_service_code_required",
        "chorus_commitment_required",
        "chorus_billing_address_active",
    }
)
CUSTOMER_PROVIDER_QUALIFICATION_FIELDS = frozenset(
    {
        "chorus_service_code_required",
        "chorus_commitment_required",
        "chorus_billing_address_active",
    }
)
CUSTOMER_PRIVATE_FIELDS = frozenset({"portal_token"})


class CustomerSupplierHarmonizeAction(BaseModel):
    field: str = Field(..., min_length=1, max_length=40)
    direction: str = Field(..., min_length=1, max_length=40)


class CustomerSupplierHarmonizeRequest(BaseModel):
    actions: list[CustomerSupplierHarmonizeAction] = Field(default_factory=list, max_length=12)


class CustomerSupplierRelationConfirmRequest(BaseModel):
    notes: str | None = Field(default=None, max_length=500)


def _bad_request(code: str, message: str, field: str | None = None, fields: list[str] | None = None):
    detail: dict[str, object] = {"code": code, "message": message}
    if field:
        detail["field"] = field
    if fields:
        detail["fields"] = fields
    raise HTTPException(status_code=400, detail=detail)


def _build_pagination_link(request: Request, limit: int, offset: int) -> str:
    parsed = urlparse(str(request.url))
    query = parse_qs(parsed.query)
    query["limit"] = [str(limit)]
    query["offset"] = [str(offset)]
    new_query = urlencode(query, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


def _set_pagination_headers(response: Response, request: Request, total: int, limit: int, offset: int) -> None:
    response.headers["X-Total-Count"] = str(total)
    if limit <= 0:
        return
    links: list[str] = []
    last_offset = max(((total - 1) // limit) * limit, 0) if total > 0 else 0
    links.append(f'<{_build_pagination_link(request, limit, 0)}>; rel="first"')
    links.append(f'<{_build_pagination_link(request, limit, last_offset)}>; rel="last"')
    if offset + limit < total:
        links.append(f'<{_build_pagination_link(request, limit, offset + limit)}>; rel="next"')
    if offset > 0:
        prev_offset = max(offset - limit, 0)
        links.append(f'<{_build_pagination_link(request, limit, prev_offset)}>; rel="prev"')
    if links:
        response.headers["Link"] = ", ".join(links)


def _customer_einvoicing_enabled(db: Session, tenant_id: str) -> bool:
    return is_product_feature_enabled(db.get(Tenant, tenant_id), "einvoicing_enabled")


def _customer_response(customer: Customer, *, einvoicing_enabled: bool) -> dict:
    excluded_fields = set(CUSTOMER_PRIVATE_FIELDS)
    if not einvoicing_enabled:
        excluded_fields.update(CUSTOMER_EINVOICING_FIELDS)
    return jsonable_encoder(customer, exclude=excluded_fields)


def _customer_list_response(
    customers: list[Customer],
    *,
    response: Response,
    einvoicing_enabled: bool,
) -> list[Customer] | JSONResponse:
    if einvoicing_enabled:
        return customers
    payload = [
        CustomerListOut.model_validate(customer).model_dump(
            mode="json",
            exclude=CUSTOMER_EINVOICING_FIELDS,
        )
        for customer in customers
    ]
    result = JSONResponse(content=payload)
    for name in ("X-Total-Count", "Link"):
        if name in response.headers:
            result.headers[name] = response.headers[name]
    return result


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


def _customer_import_error(
    code: str,
    message: str,
    errors: list[dict] | None = None,
    *,
    status_code: int = 400,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {"code": code, "message": message},
            "errors": errors or [{"row": 0, "reason": code}],
        },
    )


def _normalize_customer_import_header(value: object) -> str:
    key = str(value or "").strip().lstrip("\ufeff").lower()
    key = re.sub(r"\s+", " ", key.replace("-", " ").replace("_", " "))
    if key in CUSTOMER_IMPORT_HEADER_ALIASES:
        return CUSTOMER_IMPORT_HEADER_ALIASES[key]
    compact_key = key.replace(" ", "_")
    return CUSTOMER_IMPORT_HEADER_ALIASES.get(compact_key, compact_key)


def _normalize_customer_import_row(row: dict) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for raw_key, raw_value in row.items():
        if raw_key is None:
            continue
        key = _normalize_customer_import_header(raw_key)
        if not key:
            continue
        value = str(raw_value or "").strip()
        if key not in normalized or value:
            normalized[key] = value
    return normalized


def _looks_like_binary_file(raw: bytes) -> bool:
    sample = raw[:4096]
    if not sample:
        return False
    if b"\x00" in sample:
        return True
    control_chars = sum(1 for byte in sample if byte < 32 and byte not in (9, 10, 13))
    return (control_chars / len(sample)) > 0.05


def _decode_customer_import(raw: bytes) -> str | None:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return None


def _customer_import_dialect(content: str):
    sample = "\n".join(content.splitlines()[:10])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel()
        first_line = sample.splitlines()[0] if sample.splitlines() else ""
        if first_line.count(";") > first_line.count(","):
            dialect.delimiter = ";"
        elif first_line.count("\t") > first_line.count(","):
            dialect.delimiter = "\t"
        return dialect


def _normalize_country(country: str | None) -> str:
    val = (country or "FR").strip().upper()
    return val or "FR"


def _normalize_client_type(value: str | None) -> str:
    val = (value or "business").strip().lower()
    if val in PUBLIC_CLIENT_TYPES:
        return "public"
    if val not in ALLOWED_CLIENT_TYPES:
        _bad_request(
            "invalid_client_type",
            "client_type invalide (business, individual ou public).",
            field="client_type",
        )
    return val


def _has_address(address: str | None, line1: str | None, city: str | None, postal_code: str | None) -> bool:
    return (
        bool((address or "").strip())
        or bool((line1 or "").strip())
        or bool((city or "").strip())
        or bool((postal_code or "").strip())
    )


def _has_contact_info(
    email: str | None,
    address: str | None,
    line1: str | None,
    city: str | None,
    postal_code: str | None,
) -> bool:
    return bool((email or "").strip()) or _has_address(address, line1, city, postal_code)


def _infer_client_type(
    value: str | None,
    *,
    email: str | None,
    address: str | None,
    line1: str | None,
    city: str | None,
    postal_code: str | None,
    siret: str | None,
    siren: str | None,
    vat_number: str | None,
    endpoint_id: str | None,
    pdp_name: str | None,
) -> str:
    raw = (value or "").strip()
    if raw:
        return _normalize_client_type(raw)
    if any((siret, siren, vat_number, endpoint_id, pdp_name)):
        return "business"
    if _has_contact_info(email, address, line1, city, postal_code):
        return "individual"
    return "business"


def _digits_only(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _validate_siret(siret: str | None) -> str | None:
    val = _digits_only((siret or "").strip())
    if not val:
        return None
    if not SIRET_RE.fullmatch(val):
        _bad_request("invalid_siret", "SIRET invalide (14 chiffres).", field="siret")
    return val


def _validate_siren(siren: str | None) -> str | None:
    val = _digits_only((siren or "").strip())
    if not val:
        return None
    if not SIREN_RE.fullmatch(val):
        _bad_request("invalid_siren", "SIREN invalide (9 chiffres).", field="siren")
    return val


def _validate_vat(vat: str | None, country: str | None) -> str | None:
    if not vat:
        return None
    val = vat.strip().replace(" ", "").upper()
    if _normalize_country(country) == "FR" and not VAT_FR_RE.fullmatch(val):
        _bad_request("invalid_vat_number", "TVA invalide (FRxx...).", field="vat_number")
    return val


def _normalize_customer_name(value: str | None) -> str:
    raw = (value or "").strip().lower()
    raw = re.sub(r"\b(sas|sasu|sarl|eurl|sa|sci|scop|association|asso|ei|eirl)\b", " ", raw)
    raw = re.sub(r"[^a-z0-9]+", " ", raw)
    return re.sub(r"\s+", " ", raw).strip()


def _normalize_party_lookup_name(value: str | None) -> str:
    return " ".join((value or "").strip().lower().split())


def _customer_duplicate_payload(customer: Customer, reason: str, field: str, score: float = 1.0) -> dict:
    return {
        "id": customer.id,
        "name": customer.name,
        "email": customer.email,
        "siren": customer.siren,
        "siret": customer.siret,
        "vat_number": customer.vat_number,
        "reason": reason,
        "field": field,
        "score": score,
    }


def _customer_duplicate_candidates(
    db: Session,
    tenant_id: str,
    *,
    email: str | None = None,
    siret: str | None = None,
    siren: str | None = None,
    vat_number: str | None = None,
    name: str | None = None,
    exclude_id: str | None = None,
    limit: int = 5,
) -> list[dict]:
    seen: set[str] = set()
    candidates: list[dict] = []

    def add(customer: Customer | None, reason: str, field: str, score: float = 1.0) -> None:
        if not customer or customer.id in seen:
            return
        seen.add(customer.id)
        candidates.append(_customer_duplicate_payload(customer, reason, field, score))

    base = db.query(Customer).filter(Customer.tenant_id == tenant_id)
    if exclude_id:
        base = base.filter(Customer.id != exclude_id)

    norm_email = (email or "").strip().lower()
    norm_siret = _digits_only(siret)
    norm_siren = _digits_only(siren)
    norm_vat = (vat_number or "").strip().replace(" ", "").upper()
    norm_name = _normalize_customer_name(name)

    exact_filters = []
    if norm_email:
        exact_filters.append((func.lower(Customer.email) == norm_email, "email_identique", "email"))
    if norm_siret:
        exact_filters.append((Customer.siret == norm_siret, "siret_identique", "siret"))
    if norm_vat:
        exact_filters.append((func.upper(Customer.vat_number) == norm_vat, "tva_identique", "vat_number"))
    if norm_siren:
        exact_filters.append((Customer.siren == norm_siren, "siren_identique", "siren"))

    for condition, reason, field in exact_filters:
        for row in base.filter(condition).order_by(Customer.created_at.desc()).limit(limit).all():
            add(row, reason, field, 1.0)

    if norm_name and len(norm_name) >= 4 and len(candidates) < limit:
        rows = (
            base.filter(Customer.name.ilike(f"%{norm_name.split()[0]}%"))
            .order_by(Customer.created_at.desc())
            .limit(30)
            .all()
        )
        for row in rows:
            row_name = _normalize_customer_name(row.name)
            if not row_name:
                continue
            same_name = row_name == norm_name
            contained_name = len(norm_name) >= 6 and (norm_name in row_name or row_name in norm_name)
            if same_name or contained_name:
                add(row, "nom_proche", "name", 0.82 if contained_name and not same_name else 0.92)
            if len(candidates) >= limit:
                break

    return candidates[:limit]


def _find_duplicates(db: Session, tenant_id: str):
    clusters = []
    for field in ("email", "siret", "siren", "vat_number"):
        col = getattr(Customer, field)
        dup_values = (
            db.query(col, func.count(Customer.id))
            .filter(Customer.tenant_id == tenant_id, col.isnot(None), col != "")
            .group_by(col)
            .having(func.count(Customer.id) > 1)
            .all()
        )
        for value, _ in dup_values:
            items = (
                db.query(Customer)
                .filter(Customer.tenant_id == tenant_id, col == value)
                .order_by(Customer.created_at.desc())
                .all()
            )
            ids = [c.id for c in items]
            clusters.append(
                {
                    "field": field,
                    "value": value,
                    "ids": ids,
                    "keep": ids[0],
                    "remove": ids[1:],
                }
            )
    name_rows = db.query(Customer.id, Customer.name, Customer.created_at).filter(Customer.tenant_id == tenant_id).all()
    by_name: dict[str, list[tuple[str, datetime | None]]] = {}
    for customer_id, name, created_at in name_rows:
        normalized = _normalize_customer_name(name)
        if normalized:
            by_name.setdefault(normalized, []).append((customer_id, created_at))
    for normalized, rows in by_name.items():
        if len(rows) <= 1:
            continue
        rows.sort(key=lambda item: item[1] or datetime.min, reverse=True)
        ids = [customer_id for customer_id, _ in rows]
        clusters.append({"field": "name", "value": normalized, "ids": ids, "keep": ids[0], "remove": ids[1:]})
    return clusters


def _dedupe_blockers(db: Session, customer: Customer) -> list[str]:
    blockers: list[str] = []
    if db.query(Invoice.id).filter(Invoice.customer_id == customer.id, Invoice.tenant_id == customer.tenant_id).first():
        blockers.append("linked_invoices")
    if db.query(Quote.id).filter(Quote.customer_id == customer.id, Quote.tenant_id == customer.tenant_id).first():
        blockers.append("linked_quotes")
    if db.query(CustomerContact.id).filter(CustomerContact.customer_id == customer.id).first():
        blockers.append("linked_contacts")
    if (
        db.query(CustomerUserLink.id)
        .filter(CustomerUserLink.customer_id == customer.id, CustomerUserLink.tenant_id == customer.tenant_id)
        .first()
    ):
        blockers.append("linked_portal_users")
    if getattr(customer, "portal_enabled", False) or getattr(customer, "portal_token", None):
        blockers.append("portal_enabled")
    return blockers


@router.get("", response_model=list[CustomerListOut])
def list_customers(
    response: Response,
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None, description="Recherche client (nom, email, SIREN, SIRET, TVA)"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_CUSTOMERS})),
):
    query = db.query(Customer).filter(Customer.tenant_id == user.tenant_id)
    search = (q or "").strip()
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                Customer.name.ilike(like),
                Customer.email.ilike(like),
                Customer.siren.ilike(like),
                Customer.siret.ilike(like),
                Customer.vat_number.ilike(like),
            )
        )
    total = query.count()
    _set_pagination_headers(response, request, total, limit, offset)
    customers = query.order_by(Customer.created_at.desc()).offset(offset).limit(limit).all()
    return _customer_list_response(
        customers,
        response=response,
        einvoicing_enabled=_customer_einvoicing_enabled(db, user.tenant_id),
    )


@router.get("/export.csv")
def export_customers_csv(
    page: int = Query(1, ge=1),
    page_size: int = Query(10000, ge=1, le=50000),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    base_query = db.query(Customer).filter(Customer.tenant_id == user.tenant_id)
    total = base_query.count()
    rows = base_query.order_by(Customer.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, delimiter=",", quotechar='"', quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(
        [
            "name",
            "email",
            "phone",
            "contact_name",
            "address",
            "siret",
            "siren",
            "vat_number",
            "client_type",
            "country",
            "payment_terms_default",
            "payment_method_default",
            "default_vat_rate",
            "created_at",
        ]
    )
    for c in rows:
        writer.writerow(
            [
                _sanitize_csv_cell(c.name),
                _sanitize_csv_cell(c.email),
                _sanitize_csv_cell(c.phone),
                _sanitize_csv_cell(c.contact_name),
                _sanitize_csv_cell(c.address),
                _sanitize_csv_cell(c.siret),
                _sanitize_csv_cell(c.siren),
                _sanitize_csv_cell(c.vat_number),
                _sanitize_csv_cell(c.client_type),
                _sanitize_csv_cell(c.country),
                _sanitize_csv_cell(c.payment_terms_default),
                _sanitize_csv_cell(c.payment_method_default),
                _sanitize_csv_cell(c.default_vat_rate),
                _sanitize_csv_cell(c.created_at.isoformat() if c.created_at else ""),
            ]
        )
    headers = {
        "X-Total-Count": str(total),
        "X-Page": str(page),
        "X-Page-Size": str(page_size),
        "Content-Disposition": 'attachment; filename="clients.csv"',
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
    }
    return Response(content=buf.getvalue(), media_type="text/csv; charset=utf-8", headers=headers)


@router.get("/company-lookup")
def company_lookup(
    siren: str | None = Query(default=None),
    siret: str | None = Query(default=None),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    if not siren and not siret:
        raise HTTPException(
            status_code=400,
            detail={"code": "sirene_missing", "message": "SIREN ou SIRET requis pour la recherche."},
        )
    try:
        payload = lookup_company(siren, siret)
    except SireneNotConfigured:
        raise HTTPException(
            status_code=503,
            detail={"code": "sirene_not_configured", "message": "Lookup SIRENE non configure."},
        )
    except SireneNotFound:
        raise HTTPException(
            status_code=404,
            detail={"code": "sirene_not_found", "message": "Aucune entreprise trouvee."},
        )
    except ValueError as exc:
        code = str(exc) or "sirene_invalid"
        message = "Identifiant SIRENE invalide."
        if code == "siren_invalid":
            message = "SIREN invalide (9 chiffres)."
        elif code == "siret_invalid":
            message = "SIRET invalide (14 chiffres)."
        elif code == "siren_missing":
            message = "SIREN requis pour la recherche."
        raise HTTPException(status_code=400, detail={"code": code, "message": message})
    except SireneLookupError:
        raise HTTPException(
            status_code=502,
            detail={"code": "sirene_lookup_failed", "message": "Recherche SIRENE en erreur."},
        )
    return payload


@router.get("/duplicate-check")
def customer_duplicate_check(
    name: str | None = Query(default=None, max_length=160),
    email: str | None = Query(default=None, max_length=320),
    siret: str | None = Query(default=None, max_length=20),
    siren: str | None = Query(default=None, max_length=14),
    vat_number: str | None = Query(default=None, max_length=32),
    exclude_id: str | None = Query(default=None, max_length=80),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_CUSTOMERS})),
):
    candidates = _customer_duplicate_candidates(
        db,
        user.tenant_id,
        name=name,
        email=email,
        siret=siret,
        siren=siren,
        vat_number=vat_number,
        exclude_id=exclude_id,
        limit=5,
    )
    return {
        "items": candidates,
        "blocking_count": len([item for item in candidates if item.get("field") != "name"]),
        "suggestion_count": len([item for item in candidates if item.get("field") == "name"]),
    }


@router.post("")
def create_customer(
    body: CustomerCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    einvoicing_enabled = _customer_einvoicing_enabled(db, user.tenant_id)
    country = _normalize_country(body.country)
    email = (body.email or "").strip()
    siret = _validate_siret(body.siret)
    siren = _validate_siren(body.siren)
    if siret:
        derived_siren = siret[:9]
        if siren and siren != derived_siren:
            _bad_request("siren_mismatch", "SIREN incohérent avec le SIRET.", field="siren")
        siren = derived_siren
    vat = _validate_vat(body.vat_number, country)
    address = (body.address or "").strip()
    address_line1 = (body.address_line1 or "").strip() or None
    address_line2 = (body.address_line2 or "").strip() or None
    postal_code = (body.postal_code or "").strip() or None
    city = (body.city or "").strip() or None
    country_code = (body.country_code or "").strip().upper() or country
    client_type = _infer_client_type(
        body.client_type,
        email=email,
        address=address,
        line1=address_line1,
        city=city,
        postal_code=postal_code,
        siret=siret,
        siren=siren,
        vat_number=vat,
        endpoint_id=body.endpoint_id if einvoicing_enabled else None,
        pdp_name=body.pdp_name if einvoicing_enabled else None,
    )
    if client_type == "individual":
        if not _has_contact_info(email, address, address_line1, city, postal_code):
            _bad_request(
                "missing_contact",
                "Email ou adresse obligatoire pour un client particulier.",
                fields=["email", "address"],
            )
    elif country == "FR":
        if not siret and not siren:
            _bad_request(
                "missing_siret_or_siren",
                "SIRET ou SIREN obligatoire pour un client entreprise en France.",
                fields=["siret", "siren"],
            )
    else:
        if not vat:
            _bad_request(
                "missing_vat_number",
                "Numéro de TVA obligatoire pour ce type de client.",
                field="vat_number",
            )
        if not _has_address(address, address_line1, city, postal_code):
            _bad_request(
                "missing_address",
                "Adresse obligatoire pour ce type de client.",
                field="address",
            )
    norm_email = (body.email or "").strip().lower()
    duplicate_candidates = _customer_duplicate_candidates(
        db,
        user.tenant_id,
        name=None,
        email=norm_email,
        siret=siret,
        siren=siren,
        vat_number=vat,
    )
    exact_duplicates = [item for item in duplicate_candidates if item.get("field") != "name"]
    if exact_duplicates:
        field_labels = {"email": "email", "siret": "SIRET", "siren": "SIREN", "vat_number": "TVA"}
        field_keys = sorted({str(item.get("field")) for item in exact_duplicates})
        fields = " et ".join(field_labels.get(key, key) for key in field_keys)
        _bad_request(
            "customer_conflict",
            f"Client déjà existant ({fields}). Ouvrez-le plutôt que de le recréer.",
            fields=field_keys or None,
        )
    endpoint_id = body.endpoint_id if einvoicing_enabled else None
    pdp_name = body.pdp_name if einvoicing_enabled else None
    directory_entry = None
    if (
        einvoicing_enabled
        and (not endpoint_id or not pdp_name)
        and country == "FR"
        and client_type in {"business", "public"}
        and (siret or siren)
    ):
        entry = lookup_directory_entry(
            db,
            user.tenant_id,
            siren=siren,
            siret=siret,
            allow_remote=not settings.EINVOICING_EXPORT_ONLY,
        )
        if entry:
            directory_entry = entry
            if not endpoint_id:
                endpoint_id = entry.billing_address
            if not pdp_name:
                pdp_name = entry.platform_slug
    try:
        c = Customer(
            tenant_id=user.tenant_id,
            name=body.name,
            email=body.email,
            phone=body.phone,
            contact_name=body.contact_name,
            address=address or None,
            address_line1=address_line1,
            address_line2=address_line2,
            postal_code=postal_code,
            city=city,
            country_code=country_code,
            siret=siret,
            siren=siren,
            vat_number=vat,
            endpoint_id=endpoint_id,
            pdp_name=pdp_name,
            public_service_code=(
                (body.public_service_code or "").strip() or None if einvoicing_enabled else None
            ),
            public_commitment_reference=(
                (body.public_commitment_reference or "").strip() or None if einvoicing_enabled else None
            ),
            chorus_service_code_required=(getattr(directory_entry, "service_code_required", None))
            if einvoicing_enabled
            else None,
            chorus_commitment_required=(getattr(directory_entry, "commitment_required", None))
            if einvoicing_enabled
            else None,
            chorus_billing_address_active=(getattr(directory_entry, "billing_address_active", None))
            if einvoicing_enabled
            else None,
            country=country,
            client_type=client_type,
            payment_terms_default=body.payment_terms_default,
            payment_method_default=body.payment_method_default,
            default_vat_rate=body.default_vat_rate,
            iban=body.iban,
            bic=body.bic,
            internal_note=(body.internal_note or "").strip() or None,
        )
        db.add(c)
        db.commit()
        db.refresh(c)
        return _customer_response(c, einvoicing_enabled=einvoicing_enabled)
    except IntegrityError:
        db.rollback()
        _bad_request(
            "customer_conflict",
            "Client déjà existant (email, SIREN, SIRET ou TVA). Modifiez-le plutôt que de le recréer.",
            fields=["email", "siren", "siret", "vat_number"],
        )
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        db.rollback()
        _bad_request("customer_create_failed", f"Impossible de créer le client: {e.__class__.__name__}")


@router.get("/duplicates")
def list_duplicates(db: Session = Depends(get_db), user: AuthUser = Depends(require_tenant_admin)):
    """
    Retourne les groupes de doublons (email, SIRET ou TVA) pour le tenant courant.
    """
    return _find_duplicates(db, user.tenant_id)


@router.get("/{cid}")
def get_customer(
    cid: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_CUSTOMERS})),
):
    c = db.get(Customer, cid)
    if not c or c.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    return _customer_response(
        c,
        einvoicing_enabled=_customer_einvoicing_enabled(db, user.tenant_id),
    )


# --- Contacts client (multi-destinataires) ---

_ALLOWED_CONTACT_ROLES = {"billing", "cc", "other"}


def _normalize_contact_role(role: str | None) -> str:
    val = (role or "billing").strip().lower()
    if val not in _ALLOWED_CONTACT_ROLES:
        _bad_request(
            "invalid_contact_role",
            "role invalide (billing, cc, other).",
            field="role",
        )
    return val


@router.get("/{customer_id}/contacts", response_model=list[CustomerContactOut])
def list_customer_contacts(
    customer_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin_or_api_key({API_SCOPE_READ_CUSTOMERS})),
):
    customer = db.get(Customer, customer_id)
    if not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    rows = (
        db.query(CustomerContact)
        .filter(CustomerContact.tenant_id == user.tenant_id, CustomerContact.customer_id == customer_id)
        .order_by(CustomerContact.is_primary.desc(), CustomerContact.created_at.asc())
        .all()
    )
    return rows


@router.post("/{customer_id}/contacts", response_model=CustomerContactOut)
def create_customer_contact(
    customer_id: str,
    body: CustomerContactCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    customer = db.get(Customer, customer_id)
    if not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")

    email = (str(body.email) or "").strip().lower()
    if not email:
        _bad_request("email_missing", "Email requis.", field="email")
    role = _normalize_contact_role(body.role)
    name = (body.name or "").strip() or None

    # Un seul primary par customer.
    if bool(body.is_primary):
        (
            db.query(CustomerContact)
            .filter(CustomerContact.customer_id == customer_id, CustomerContact.tenant_id == user.tenant_id)
            .update({CustomerContact.is_primary: False})
        )

    contact = CustomerContact(
        tenant_id=user.tenant_id,
        customer_id=customer_id,
        name=name,
        email=email,
        role=role,
        send_invoices=bool(body.send_invoices),
        send_quotes=bool(body.send_quotes),
        is_primary=bool(body.is_primary),
    )
    db.add(contact)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        _bad_request(
            "customer_contact_conflict",
            "Ce contact (email) existe déjà pour ce client.",
            fields=["email"],
        )
    db.refresh(contact)
    return contact


@router.patch("/{customer_id}/contacts/{contact_id}", response_model=CustomerContactOut)
def update_customer_contact(
    customer_id: str,
    contact_id: str,
    body: CustomerContactUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    customer = db.get(Customer, customer_id)
    if not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    contact = db.get(CustomerContact, contact_id)
    if not contact or contact.tenant_id != user.tenant_id or contact.customer_id != customer_id:
        raise HTTPException(404, "Not found")

    updates = body.model_dump(exclude_unset=True)
    if "email" in updates and updates.get("email") is not None:
        contact.email = (str(updates["email"]) or "").strip().lower() or contact.email
    if "name" in updates:
        contact.name = (updates.get("name") or "").strip() or None
    if "role" in updates and updates.get("role") is not None:
        contact.role = _normalize_contact_role(updates.get("role"))
    if "send_invoices" in updates and updates.get("send_invoices") is not None:
        contact.send_invoices = bool(updates.get("send_invoices"))
    if "send_quotes" in updates and updates.get("send_quotes") is not None:
        contact.send_quotes = bool(updates.get("send_quotes"))
    if "is_primary" in updates and updates.get("is_primary") is not None:
        make_primary = bool(updates.get("is_primary"))
        if make_primary:
            (
                db.query(CustomerContact)
                .filter(CustomerContact.customer_id == customer_id, CustomerContact.tenant_id == user.tenant_id)
                .update({CustomerContact.is_primary: False})
            )
        contact.is_primary = make_primary

    db.add(contact)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        _bad_request(
            "customer_contact_conflict",
            "Ce contact (email) existe déjà pour ce client.",
            fields=["email"],
        )
    db.refresh(contact)
    return contact


@router.delete("/{customer_id}/contacts/{contact_id}")
def delete_customer_contact(
    customer_id: str,
    contact_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    customer = db.get(Customer, customer_id)
    if not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    contact = db.get(CustomerContact, contact_id)
    if not contact or contact.tenant_id != user.tenant_id or contact.customer_id != customer_id:
        raise HTTPException(404, "Not found")
    db.delete(contact)
    db.commit()
    return {"ok": True}


@router.post("/backfill-contacts")
def backfill_customer_contacts(
    dry_run: bool = Query(False, description="Si true, ne crée rien (simulation)."),
    limit: int = Query(0, ge=0, le=20000, description="Limite de clients à traiter (0 = tous)."),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    """Crée automatiquement des contacts (CustomerContact) à partir de Customer.email.

    Objectif:
    - rendre la fonctionnalité multi-contacts utilisable immédiatement sur un parc existant.
    - éviter de perdre des relances / emails parce que 'email vide' dans les modales.

    Règles:
    - pour chaque customer avec email non vide
      - si aucun contact avec ce même email n'existe pour ce customer => on crée un contact billing
      - si aucun contact existant => is_primary=True, sinon is_primary=False
    - idempotent (peut être relancé)
    """
    q = db.query(Customer).filter(Customer.tenant_id == user.tenant_id).order_by(Customer.created_at.asc())
    if limit and limit > 0:
        q = q.limit(limit)
    customers = q.all()

    created = 0
    skipped = 0
    processed = 0

    for c in customers:
        processed += 1
        email = (c.email or "").strip().lower()
        if not email:
            skipped += 1
            continue

        existing_same = (
            db.query(CustomerContact)
            .filter(
                CustomerContact.tenant_id == user.tenant_id,
                CustomerContact.customer_id == c.id,
                func.lower(CustomerContact.email) == email,
            )
            .first()
        )
        if existing_same:
            skipped += 1
            continue

        has_any_contact = (
            db.query(CustomerContact)
            .filter(CustomerContact.tenant_id == user.tenant_id, CustomerContact.customer_id == c.id)
            .first()
        )
        contact = CustomerContact(
            tenant_id=user.tenant_id,
            customer_id=c.id,
            email=email,
            name=None,
            role="billing",
            send_invoices=True,
            send_quotes=True,
            is_primary=(has_any_contact is None),
        )
        if not dry_run:
            db.add(contact)
        created += 1

    if not dry_run:
        db.commit()

    return {
        "ok": True,
        "dry_run": bool(dry_run),
        "processed": processed,
        "created": created,
        "skipped": skipped,
    }


@router.patch("/{cid}")
def update_customer(
    cid: str,
    body: CustomerUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    c = db.get(Customer, cid)
    if not c or c.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    einvoicing_enabled = _customer_einvoicing_enabled(db, user.tenant_id)
    updates = body.model_dump(exclude_unset=True)
    for field in CUSTOMER_PROVIDER_QUALIFICATION_FIELDS:
        updates.pop(field, None)
    if not einvoicing_enabled:
        for field in CUSTOMER_EINVOICING_FIELDS:
            updates.pop(field, None)
    if not updates:
        return _customer_response(c, einvoicing_enabled=einvoicing_enabled)
    if set(updates.keys()) <= {"internal_note"}:
        c.internal_note = (updates.get("internal_note") or "").strip() or None
        db.add(c)
        try:
            db.commit()
            db.refresh(c)
        except SQLAlchemyError as e:
            db.rollback()
            _bad_request("customer_update_failed", f"Impossible de mettre à jour le client: {e.__class__.__name__}")
        return _customer_response(c, einvoicing_enabled=einvoicing_enabled)
    country = _normalize_country(updates.get("country", c.country))
    email = (updates.get("email", c.email) or "").strip()
    has_siren = "siren" in updates
    siret = _validate_siret(updates.get("siret", c.siret))
    siren = _validate_siren(updates.get("siren", c.siren))
    if siret:
        derived_siren = siret[:9]
        if has_siren and siren and siren != derived_siren:
            _bad_request("siren_mismatch", "SIREN incohérent avec le SIRET.", field="siren")
        siren = derived_siren
    vat = _validate_vat(updates.get("vat_number", c.vat_number), country)
    address = (updates.get("address", c.address) or "").strip()
    address_line1 = (updates.get("address_line1", c.address_line1) or "").strip() or None
    address_line2 = (updates.get("address_line2", c.address_line2) or "").strip() or None
    postal_code = (updates.get("postal_code", c.postal_code) or "").strip() or None
    city = (updates.get("city", c.city) or "").strip() or None
    country_code = (updates.get("country_code", c.country_code) or "").strip().upper() or country
    client_type = _infer_client_type(
        updates.get("client_type", c.client_type),
        email=email,
        address=address,
        line1=address_line1,
        city=city,
        postal_code=postal_code,
        siret=siret,
        siren=siren,
        vat_number=vat,
        endpoint_id=updates.get("endpoint_id", c.endpoint_id) if einvoicing_enabled else None,
        pdp_name=updates.get("pdp_name", c.pdp_name) if einvoicing_enabled else None,
    )
    if client_type == "individual":
        if not _has_contact_info(email, address, address_line1, city, postal_code):
            _bad_request(
                "missing_contact",
                "Email ou adresse obligatoire pour un client particulier.",
                fields=["email", "address"],
            )
    elif country == "FR":
        if not siret and not siren:
            _bad_request(
                "missing_siret_or_siren",
                "SIRET ou SIREN obligatoire pour un client entreprise en France.",
                fields=["siret", "siren"],
            )
    else:
        if not vat:
            _bad_request(
                "missing_vat_number",
                "Numéro de TVA obligatoire pour ce type de client.",
                field="vat_number",
            )
        if not _has_address(address, address_line1, city, postal_code):
            _bad_request(
                "missing_address",
                "Adresse obligatoire pour ce type de client.",
                field="address",
            )
    norm_email = (updates.get("email", c.email) or "").strip().lower()
    duplicate_candidates = _customer_duplicate_candidates(
        db,
        user.tenant_id,
        name=None,
        email=norm_email,
        siret=siret,
        siren=siren,
        vat_number=vat,
        exclude_id=cid,
    )
    exact_duplicates = [item for item in duplicate_candidates if item.get("field") != "name"]
    if exact_duplicates:
        field_labels = {"email": "email", "siret": "SIRET", "siren": "SIREN", "vat_number": "TVA"}
        field_keys = sorted({str(item.get("field")) for item in exact_duplicates})
        fields = " et ".join(field_labels.get(key, key) for key in field_keys)
        _bad_request(
            "customer_conflict",
            f"Client déjà existant ({fields}). Modifiez le client existant.",
            fields=field_keys or None,
        )
    endpoint_id = (updates.get("endpoint_id", c.endpoint_id) or "").strip() or None
    pdp_name = (updates.get("pdp_name", c.pdp_name) or "").strip() or None
    directory_entry = None
    should_refresh_directory = (
        einvoicing_enabled
        and country == "FR"
        and client_type in {"business", "public"}
        and (siret or siren)
        and ("siret" in updates or "siren" in updates or "client_type" in updates or not endpoint_id or not pdp_name)
    )
    if should_refresh_directory:
        directory_entry = lookup_directory_entry(
            db,
            user.tenant_id,
            siren=siren,
            siret=siret,
            allow_remote=not settings.EINVOICING_EXPORT_ONLY,
        )
        if directory_entry:
            if not endpoint_id or "siret" in updates or "siren" in updates:
                endpoint_id = directory_entry.billing_address
            if not pdp_name or "siret" in updates or "siren" in updates:
                pdp_name = directory_entry.platform_slug
    for k, v in updates.items():
        setattr(c, k, v)
    c.country = country
    c.client_type = client_type
    c.siret = siret
    c.vat_number = vat
    c.siren = siren
    if einvoicing_enabled:
        c.endpoint_id = endpoint_id
        c.pdp_name = pdp_name
        c.public_service_code = (updates.get("public_service_code", c.public_service_code) or "").strip() or None
        c.public_commitment_reference = (
            updates.get("public_commitment_reference", c.public_commitment_reference) or ""
        ).strip() or None
        if directory_entry is not None:
            c.chorus_service_code_required = directory_entry.service_code_required
        if directory_entry is not None:
            c.chorus_commitment_required = directory_entry.commitment_required
        if directory_entry is not None:
            c.chorus_billing_address_active = directory_entry.billing_address_active
    c.address = address or None
    c.address_line1 = address_line1
    c.address_line2 = address_line2
    c.postal_code = postal_code
    c.city = city
    c.country_code = country_code
    db.add(c)
    try:
        db.commit()
        db.refresh(c)
    except SQLAlchemyError as e:
        db.rollback()
        _bad_request("customer_update_failed", f"Impossible de mettre à jour le client: {e.__class__.__name__}")
    return _customer_response(c, einvoicing_enabled=einvoicing_enabled)


@router.delete("/{cid}")
def delete_customer(
    cid: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    c = db.get(Customer, cid)
    if not c or c.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    has_invoice = db.query(Invoice.id).filter(Invoice.tenant_id == user.tenant_id, Invoice.customer_id == c.id).first()
    if has_invoice:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "customer_has_invoices",
                "message": "Impossible de supprimer un client avec des factures. Annulez ou supprimez les factures liees, ou conservez ce client.",
            },
        )
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.get("/{cid}/summary")
def customer_summary(cid: str, db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)):
    c = db.get(Customer, cid)
    if not c or c.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")
    invoices = db.query(Invoice).filter(Invoice.customer_id == cid, Invoice.tenant_id == user.tenant_id).all()
    total = sum(Decimal(str(i.total_inc_vat or 0)) for i in invoices)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    start_12 = now - timedelta(days=365)
    total_12 = sum(Decimal(str(i.total_inc_vat or 0)) for i in invoices if i.issue_date and i.issue_date >= start_12)
    overdue_amount = Decimal("0")
    tenant = db.get(Tenant, user.tenant_id)
    if is_product_feature_enabled(tenant, "payments_enabled"):
        for inv in invoices:
            payment_query = db.query(Payment).filter(Payment.invoice_id == inv.id)
            # Payment ne porte pas tenant_id; inv.id provient deja du scope tenant.
            paid = sum(Decimal(str(p.amount or 0)) for p in payment_query)
            credits = sum(
                abs(Decimal(str(other.total_inc_vat or 0)))
                for other in db.query(Invoice).filter(
                    Invoice.related_invoice_id == inv.id,
                    Invoice.type == "credit_note",
                    Invoice.tenant_id == user.tenant_id,
                )
            )
            outstanding = Decimal(str(inv.total_inc_vat or 0)) - paid - credits
            if outstanding > 0 and inv.status == "overdue":
                overdue_amount += outstanding
    customer_payload = _customer_response(
        c,
        einvoicing_enabled=is_product_feature_enabled(tenant, "einvoicing_enabled"),
    )
    return {
        "customer": customer_payload,
        "stats": {
            "total_revenue": float(total),
            "total_revenue_12m": float(total_12),
            "overdue_amount": float(overdue_amount),
            "invoice_count": len(invoices),
        },
    }


def _customer_supplier_missing_fields(customer: Customer, supplier: PurchaseSupplier | None) -> list[str]:
    missing: list[str] = []
    customer_siren = _digits_only(customer.siren) or _digits_only(customer.siret)[:9]
    if supplier:
        if supplier.siren and not customer_siren:
            missing.append("siren_client")
        if supplier.siret and not customer.siret:
            missing.append("siret_client")
        if supplier.vat_number and not customer.vat_number:
            missing.append("tva_client")
        if supplier.default_accounting_account is None:
            missing.append("compte_achat_fournisseur")
        if supplier.default_purchase_nature is None:
            missing.append("nature_achat_fournisseur")
    return missing


def _supplier_match_reason(
    customer: Customer, supplier: PurchaseSupplier | None, purchase: InboundInvoice | None = None
) -> str:
    customer_siren = _digits_only(customer.siren) or _digits_only(customer.siret)[:9]
    if supplier:
        if customer.siret and supplier.siret == customer.siret:
            return "siret"
        if customer.vat_number and supplier.vat_number and supplier.vat_number.upper() == customer.vat_number.upper():
            return "vat_number"
        if customer_siren and supplier.siren == customer_siren:
            return "siren"
        if _normalize_party_lookup_name(customer.name) == _normalize_party_lookup_name(supplier.name):
            return "name"
    if purchase:
        if customer.siret and purchase.supplier_siret == customer.siret:
            return "siret"
        if customer_siren and purchase.supplier_siren == customer_siren:
            return "siren"
        if _normalize_party_lookup_name(customer.name) == _normalize_party_lookup_name(purchase.supplier_name):
            return "name"
    return "possible_match"


def _customer_supplier_field_value(
    customer: Customer, supplier: PurchaseSupplier, field: str, source: str
) -> str | None:
    obj = customer if source == "customer" else supplier
    value = getattr(obj, field, None)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _customer_supplier_recommendation(customer_value: str | None, supplier_value: str | None) -> str:
    if not customer_value and supplier_value:
        return "supplier_to_customer"
    if customer_value and not supplier_value:
        return "customer_to_supplier"
    return "keep"


def _customer_supplier_preview_payload(customer: Customer, supplier: PurchaseSupplier) -> dict:
    establishment_warning = _same_siren_different_siret(customer, supplier)
    warnings = [
        "Cette harmonisation ne transfère pas l'historique des factures ou achats.",
        "Les champs en conflit restent inchangés tant qu'aucun choix manuel n'est appliqué.",
    ]
    if establishment_warning:
        warnings.append(
            "Même SIREN mais SIRET différent: vérifiez l'établissement avant de reprendre l'adresse ou le SIRET."
        )
    fields: list[dict] = []
    for field in ("name", "siren", "siret", "vat_number"):
        customer_value = _customer_supplier_field_value(customer, supplier, field, "customer")
        supplier_value = _customer_supplier_field_value(customer, supplier, field, "supplier")
        customer_norm = customer_value.upper() if field == "vat_number" and customer_value else customer_value
        supplier_norm = supplier_value.upper() if field == "vat_number" and supplier_value else supplier_value
        conflict = bool(customer_norm and supplier_norm and customer_norm != supplier_norm)
        fields.append(
            {
                "field": field,
                "label": {
                    "name": "Nom",
                    "siren": "SIREN",
                    "siret": "SIRET",
                    "vat_number": "N° TVA",
                }[field],
                "customer_value": customer_value,
                "supplier_value": supplier_value,
                "conflict": conflict,
                "recommended_direction": _customer_supplier_recommendation(customer_value, supplier_value),
            }
        )
    return {
        "customer": {
            "id": customer.id,
            "name": customer.name,
            "siren": customer.siren,
            "siret": customer.siret,
            "vat_number": customer.vat_number,
        },
        "supplier": {
            "id": supplier.id,
            "name": supplier.name,
            "siren": supplier.siren,
            "siret": supplier.siret,
            "vat_number": supplier.vat_number,
            "default_accounting_account": supplier.default_accounting_account,
            "default_purchase_nature": supplier.default_purchase_nature,
        },
        "fields": fields,
        "establishment_warning": establishment_warning,
        "warnings": warnings,
    }


def _customer_supplier_relation_payload(row: CustomerSupplierRelation | None) -> dict | None:
    if not row:
        return None
    return {
        "id": row.id,
        "status": row.status,
        "relation_type": row.relation_type,
        "reason": row.reason,
        "notes": row.notes,
        "confirmed_by_user_id": row.confirmed_by_user_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _customer_supplier_normalized_value(field: str, value: str | None, country: str | None) -> str | None:
    if field == "name":
        text = (value or "").strip()
        if not text:
            _bad_request("customer_supplier_empty_name", "Le nom ne peut pas être vide.", field="name")
        return text
    if field == "siret":
        return _validate_siret(value)
    if field == "siren":
        return _validate_siren(value)
    if field == "vat_number":
        return _validate_vat(value, country)
    _bad_request("customer_supplier_invalid_field", "Champ non synchronisable.", field=field)
    return None


def _ensure_customer_sync_unique(db: Session, tenant_id: str, customer_id: str, field: str, value: str | None) -> None:
    if not value:
        return
    query = db.query(Customer.id).filter(Customer.tenant_id == tenant_id, Customer.id != customer_id)
    if field == "email":
        query = query.filter(func.lower(Customer.email) == value.lower())
    elif field == "vat_number":
        query = query.filter(func.upper(Customer.vat_number) == value.upper())
    elif field == "siret":
        query = query.filter(Customer.siret == value)
    elif field == "siren":
        query = query.filter(Customer.siren == value)
    else:
        return
    if query.first():
        labels = {"siret": "SIRET", "siren": "SIREN", "vat_number": "TVA", "email": "email"}
        _bad_request(
            "customer_sync_conflict",
            f"Un autre client utilise déjà ce {labels.get(field, field)}.",
            field=field,
        )


def _ensure_customer_supplier_identifier_consistency(updates: dict[str, str | None], current: object) -> None:
    siret = updates.get("siret", getattr(current, "siret", None))
    siren = updates.get("siren", getattr(current, "siren", None))
    if siret and siren and not str(siret).startswith(str(siren)):
        _bad_request(
            "customer_supplier_identifier_mismatch",
            "SIREN incohérent avec le SIRET choisi.",
            fields=["siren", "siret"],
        )


def _same_siren_different_siret(customer: Customer, party: PurchaseSupplier | InboundInvoice | None) -> bool:
    if not party:
        return False
    customer_siren = _digits_only(customer.siren) or _digits_only(customer.siret)[:9]
    customer_siret = _digits_only(customer.siret)
    party_siren = _digits_only(getattr(party, "siren", None) or getattr(party, "supplier_siren", None))
    party_siret = _digits_only(getattr(party, "siret", None) or getattr(party, "supplier_siret", None))
    if not party_siren and party_siret:
        party_siren = party_siret[:9]
    return bool(
        customer_siren
        and party_siren
        and customer_siren == party_siren
        and customer_siret
        and party_siret
        and customer_siret != party_siret
    )


def _load_customer_supplier_pair(
    db: Session, tenant_id: str, customer_id: str, supplier_id: str
) -> tuple[Customer, PurchaseSupplier]:
    customer = db.get(Customer, customer_id)
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(404, "Not found")
    supplier = db.get(PurchaseSupplier, supplier_id)
    if not supplier or supplier.tenant_id != tenant_id or not supplier.is_active:
        raise HTTPException(404, "Supplier not found")
    return customer, supplier


def _ensure_purchases_enabled(db: Session, user: AuthUser) -> None:
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable")
    ensure_product_feature(tenant, "purchases_enabled")


@router.get("/{cid}/supplier-relation/{supplier_id}/merge-preview")
def customer_supplier_merge_preview(
    cid: str,
    supplier_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    _ensure_purchases_enabled(db, user)
    customer, supplier = _load_customer_supplier_pair(db, user.tenant_id, cid, supplier_id)
    return _customer_supplier_preview_payload(customer, supplier)


@router.post("/{cid}/supplier-relation/{supplier_id}/harmonize")
def customer_supplier_harmonize(
    cid: str,
    supplier_id: str,
    body: CustomerSupplierHarmonizeRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _ensure_purchases_enabled(db, user)
    customer, supplier = _load_customer_supplier_pair(db, user.tenant_id, cid, supplier_id)
    customer_updates: dict[str, str | None] = {}
    supplier_updates: dict[str, str | None] = {}
    seen_actions: set[tuple[str, str]] = set()

    for action in body.actions:
        field = action.field.strip()
        direction = action.direction.strip()
        if field not in CUSTOMER_SUPPLIER_SYNC_FIELDS:
            _bad_request("customer_supplier_invalid_field", "Champ non synchronisable.", field=field)
        if direction not in CUSTOMER_SUPPLIER_SYNC_DIRECTIONS:
            _bad_request("customer_supplier_invalid_direction", "Action de fusion invalide.", field="direction")
        key = (field, direction)
        if key in seen_actions or direction == "keep":
            continue
        seen_actions.add(key)
        if direction == "supplier_to_customer":
            value = _customer_supplier_normalized_value(field, getattr(supplier, field, None), customer.country)
            if not value:
                _bad_request("customer_supplier_empty_source", "La valeur fournisseur est vide.", field=field)
            customer_updates[field] = value
            if field == "siret" and value:
                customer_updates["siren"] = value[:9]
        elif direction == "customer_to_supplier":
            value = _customer_supplier_normalized_value(field, getattr(customer, field, None), customer.country)
            if not value:
                _bad_request("customer_supplier_empty_source", "La valeur client est vide.", field=field)
            supplier_updates[field] = value
            if field == "siret" and value:
                supplier_updates["siren"] = value[:9]

    _ensure_customer_supplier_identifier_consistency(customer_updates, customer)
    _ensure_customer_supplier_identifier_consistency(supplier_updates, supplier)

    for field, value in customer_updates.items():
        _ensure_customer_sync_unique(db, user.tenant_id, customer.id, field, value)
        setattr(customer, field, value)
    for field, value in supplier_updates.items():
        setattr(supplier, field, value)
        if field == "name" and value:
            supplier.normalized_name = _normalize_party_lookup_name(value)

    if not customer_updates and not supplier_updates:
        return {
            "ok": True,
            "changed": False,
            "customer_updates": {},
            "supplier_updates": {},
            "preview": _customer_supplier_preview_payload(customer, supplier),
        }

    db.add(customer)
    db.add(supplier)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        _bad_request(
            "customer_supplier_sync_conflict",
            "Une fiche utilise déjà une des valeurs choisies. Gardez la valeur existante ou modifiez la fiche concernée.",
            fields=["name", "siren", "siret", "vat_number"],
        )
    db.refresh(customer)
    db.refresh(supplier)
    return {
        "ok": True,
        "changed": True,
        "customer_updates": sorted(customer_updates),
        "supplier_updates": sorted(supplier_updates),
        "preview": _customer_supplier_preview_payload(customer, supplier),
    }


@router.post("/{cid}/supplier-relation/{supplier_id}/confirm")
def customer_supplier_relation_confirm(
    cid: str,
    supplier_id: str,
    body: CustomerSupplierRelationConfirmRequest | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _ensure_purchases_enabled(db, user)
    customer, supplier = _load_customer_supplier_pair(db, user.tenant_id, cid, supplier_id)
    relation = (
        db.query(CustomerSupplierRelation)
        .filter(
            CustomerSupplierRelation.tenant_id == user.tenant_id,
            CustomerSupplierRelation.customer_id == customer.id,
            CustomerSupplierRelation.supplier_id == supplier.id,
        )
        .first()
    )
    if relation is None:
        relation = CustomerSupplierRelation(
            tenant_id=user.tenant_id,
            customer_id=customer.id,
            supplier_id=supplier.id,
            relation_type="same_party",
            status="confirmed",
        )
    relation.status = "confirmed"
    relation.reason = _supplier_match_reason(customer, supplier)
    relation.notes = (body.notes.strip() if body and body.notes else None) or relation.notes
    relation.confirmed_by_user_id = None if user.is_api_key else user.id
    db.add(relation)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        _bad_request("customer_supplier_relation_conflict", "Cette relation client/fournisseur existe déjà.")
    db.refresh(relation)
    return {
        "ok": True,
        "relation": _customer_supplier_relation_payload(relation),
        "preview": _customer_supplier_preview_payload(customer, supplier),
    }


@router.get("/{cid}/supplier-relation")
def customer_supplier_relation(
    cid: str, db: Session = Depends(get_db), user: AuthUser = Depends(require_viewer_or_admin)
):
    _ensure_purchases_enabled(db, user)
    customer = db.get(Customer, cid)
    if not customer or customer.tenant_id != user.tenant_id:
        raise HTTPException(404, "Not found")

    explicit_relations = (
        db.query(CustomerSupplierRelation)
        .filter(
            CustomerSupplierRelation.tenant_id == user.tenant_id,
            CustomerSupplierRelation.customer_id == customer.id,
            CustomerSupplierRelation.status == "confirmed",
        )
        .all()
    )
    explicit_supplier_ids = {relation.supplier_id for relation in explicit_relations}
    explicit_by_supplier_id = {relation.supplier_id: relation for relation in explicit_relations}

    clean_siret = _digits_only(customer.siret)
    clean_siren = _digits_only(customer.siren) or clean_siret[:9]
    clean_vat = (customer.vat_number or "").strip().replace(" ", "").upper()
    normalized_name = _normalize_party_lookup_name(customer.name)

    supplier_filters = []
    if clean_siret:
        supplier_filters.append(PurchaseSupplier.siret == clean_siret)
    if clean_siren:
        supplier_filters.append(PurchaseSupplier.siren == clean_siren)
    if clean_vat:
        supplier_filters.append(func.upper(func.coalesce(PurchaseSupplier.vat_number, "")) == clean_vat)
    if normalized_name:
        supplier_filters.append(PurchaseSupplier.normalized_name == normalized_name)
    if explicit_supplier_ids:
        supplier_filters.append(PurchaseSupplier.id.in_(explicit_supplier_ids))
    suppliers = (
        db.query(PurchaseSupplier)
        .filter(
            PurchaseSupplier.tenant_id == user.tenant_id, PurchaseSupplier.is_active.is_(True), or_(*supplier_filters)
        )
        .order_by(PurchaseSupplier.last_used_at.desc().nullslast(), PurchaseSupplier.updated_at.desc())
        .all()
        if supplier_filters
        else []
    )

    names = {normalized_name} if normalized_name else set()
    sirets = {clean_siret} if clean_siret else set()
    sirens = {clean_siren} if clean_siren else set()
    for supplier in suppliers:
        if supplier.siret:
            sirets.add(supplier.siret)
        if supplier.siren:
            sirens.add(supplier.siren)
        if supplier.name:
            names.add(_normalize_party_lookup_name(supplier.name))

    purchase_filters = []
    if sirets:
        purchase_filters.append(InboundInvoice.supplier_siret.in_(sirets))
    if sirens:
        purchase_filters.append(InboundInvoice.supplier_siren.in_(sirens))
    if names:
        purchase_filters.append(func.lower(func.coalesce(InboundInvoice.supplier_name, "")).in_(names))
    purchases = (
        db.query(InboundInvoice)
        .filter(InboundInvoice.tenant_id == user.tenant_id, or_(*purchase_filters))
        .order_by(InboundInvoice.received_at.desc().nullslast(), InboundInvoice.issue_date.desc().nullslast())
        .all()
        if purchase_filters
        else []
    )

    suppliers_by_key: dict[str, PurchaseSupplier] = {}
    for supplier in suppliers:
        if supplier.siret:
            suppliers_by_key[f"siret:{supplier.siret}"] = supplier
        if supplier.siren:
            suppliers_by_key[f"siren:{supplier.siren}"] = supplier
        if supplier.vat_number:
            suppliers_by_key[f"vat:{supplier.vat_number.upper()}"] = supplier
        suppliers_by_key[f"name:{_normalize_party_lookup_name(supplier.name)}"] = supplier

    stats_by_supplier: dict[str, dict] = {}
    history_without_reference: dict[str, dict] = {}
    for purchase in purchases:
        supplier = None
        if purchase.supplier_siret:
            supplier = suppliers_by_key.get(f"siret:{purchase.supplier_siret}")
        if not supplier and purchase.supplier_siren:
            supplier = suppliers_by_key.get(f"siren:{purchase.supplier_siren}")
        if not supplier:
            supplier = suppliers_by_key.get(f"name:{_normalize_party_lookup_name(purchase.supplier_name)}")
        key = (
            supplier.id
            if supplier
            else f"history:{purchase.supplier_siret or purchase.supplier_siren or _normalize_party_lookup_name(purchase.supplier_name) or purchase.id}"
        )
        target = (
            stats_by_supplier.setdefault(key, {"purchases": [], "supplier": supplier})
            if supplier
            else history_without_reference.setdefault(
                key,
                {
                    "purchases": [],
                    "supplier": None,
                    "name": purchase.supplier_name,
                    "siren": purchase.supplier_siren,
                    "siret": purchase.supplier_siret,
                },
            )
        )
        target["purchases"].append(purchase)

    for supplier in suppliers:
        stats_by_supplier.setdefault(supplier.id, {"purchases": [], "supplier": supplier})

    def item_payload(key: str, bucket: dict) -> dict:
        supplier: PurchaseSupplier | None = bucket.get("supplier")
        bucket_purchases: list[InboundInvoice] = bucket.get("purchases") or []
        total_ttc = sum(Decimal(str(purchase.total_ttc or 0)) for purchase in bucket_purchases)
        total_vat = sum(Decimal(str(purchase.total_vat or 0)) for purchase in bucket_purchases)
        latest = bucket_purchases[0] if bucket_purchases else None
        return {
            "id": supplier.id if supplier else None,
            "source": "reference" if supplier else "history",
            "supplier_name": supplier.name if supplier else bucket.get("name"),
            "supplier_siren": supplier.siren if supplier else bucket.get("siren"),
            "supplier_siret": supplier.siret if supplier else bucket.get("siret"),
            "vat_number": supplier.vat_number if supplier else None,
            "default_accounting_account": supplier.default_accounting_account if supplier else None,
            "default_purchase_nature": supplier.default_purchase_nature if supplier else None,
            "default_payment_delay_days": supplier.default_payment_delay_days if supplier else None,
            "invoice_count": len(bucket_purchases),
            "total_ttc": float(total_ttc),
            "total_vat": float(total_vat),
            "last_received_at": latest.received_at.isoformat() if latest and latest.received_at else None,
            "last_issue_date": latest.issue_date.isoformat() if latest and latest.issue_date else None,
            "match_reason": _supplier_match_reason(customer, supplier, latest),
            "relation_status": "confirmed" if supplier and supplier.id in explicit_by_supplier_id else "inferred",
            "explicit_relation": _customer_supplier_relation_payload(explicit_by_supplier_id.get(supplier.id))
            if supplier
            else None,
            "establishment_warning": _same_siren_different_siret(customer, supplier or latest),
            "missing_fields": _customer_supplier_missing_fields(customer, supplier),
        }

    items = [item_payload(key, bucket) for key, bucket in stats_by_supplier.items()]
    items.extend(item_payload(key, bucket) for key, bucket in history_without_reference.items())
    items.sort(
        key=lambda row: (
            row.get("last_received_at") or row.get("last_issue_date") or "",
            row.get("supplier_name") or "",
        ),
        reverse=True,
    )

    return {
        "customer_id": customer.id,
        "summary": {
            "supplier_count": len(items),
            "invoice_count": sum(int(item.get("invoice_count") or 0) for item in items),
            "total_ttc": float(sum(Decimal(str(item.get("total_ttc") or 0)) for item in items)),
            "total_vat": float(sum(Decimal(str(item.get("total_vat") or 0)) for item in items)),
            "needs_review_count": sum(1 for item in items if item.get("missing_fields")),
            "confirmed_supplier_count": sum(1 for item in items if item.get("relation_status") == "confirmed"),
            "latest_purchase_at": next(
                (
                    item.get("last_received_at") or item.get("last_issue_date")
                    for item in items
                    if item.get("last_received_at") or item.get("last_issue_date")
                ),
                None,
            ),
        },
        "items": items,
    }


@router.post("/import")
async def import_customers(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_customer_manager_or_api_key({API_SCOPE_WRITE_CUSTOMERS})),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    filename = (file.filename or "").strip()
    if not filename.lower().endswith(CUSTOMER_IMPORT_ALLOWED_EXTENSIONS):
        return _customer_import_error(
            "invalid_format",
            "Format non supporté : sélectionnez un fichier .csv.",
            [{"row": 0, "reason": "invalid_format", "value": filename or "sans nom"}],
        )
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if content_type not in CUSTOMER_IMPORT_ALLOWED_CONTENT_TYPES:
        return _customer_import_error(
            "invalid_format",
            "Format non supporté : sélectionnez un fichier CSV texte.",
            [{"row": 0, "reason": "invalid_format", "value": file.content_type or ""}],
        )
    raw = await file.read()
    if not raw or not raw.strip():
        return _customer_import_error(
            "empty_file",
            "Fichier CSV vide.",
            [{"row": 0, "reason": "empty_file"}],
        )
    if len(raw) > 2_000_000:
        return _customer_import_error(
            "file_too_large",
            "Fichier trop volumineux (max 2MB).",
            [{"row": 0, "reason": "file_too_large", "value": str(len(raw))}],
        )
    if _looks_like_binary_file(raw):
        return _customer_import_error(
            "invalid_content",
            "Le fichier ne ressemble pas à un CSV texte.",
            [{"row": 0, "reason": "invalid_content"}],
        )
    content = _decode_customer_import(raw)
    if content is None:
        return _customer_import_error(
            "invalid_encoding",
            "Encodage CSV illisible. Utilisez UTF-8 ou Windows-1252.",
            [{"row": 0, "reason": "invalid_encoding"}],
        )
    reader = csv.DictReader(io.StringIO(content), dialect=_customer_import_dialect(content))
    fieldnames = {_normalize_customer_import_header(f) for f in (reader.fieldnames or []) if (f or "").strip()}
    if not fieldnames:
        return _customer_import_error(
            "missing_headers",
            "En-têtes CSV manquants.",
            [{"row": 0, "reason": "missing_headers"}],
        )
    if "name" not in fieldnames:
        return _customer_import_error(
            "missing_required_columns",
            "Colonne 'name' ou 'nom' obligatoire.",
            [{"row": 0, "reason": "missing_required_columns", "value": "name"}],
        )
    if not fieldnames.intersection({"siret", "siren", "vat_number", "email", "address"}):
        return _customer_import_error(
            "missing_required_columns",
            "Colonne 'siret', 'siren', 'vat_number', 'email' ou 'address' obligatoire.",
            [{"row": 0, "reason": "missing_required_columns", "value": "siret|siren|vat_number|email|address"}],
        )
    max_rows = 5000
    imported = 0
    skipped = 0
    data_rows = 0
    errors: list[dict] = []
    existing_emails = {
        (c.email or "").lower(): c.id for c in db.query(Customer).filter(Customer.tenant_id == user.tenant_id)
    }
    existing_sirets = {
        (c.siret or "").lower(): c.id for c in db.query(Customer).filter(Customer.tenant_id == user.tenant_id)
    }
    existing_sirens = {
        (c.siren or "").lower(): c.id for c in db.query(Customer).filter(Customer.tenant_id == user.tenant_id)
    }
    existing_vats = {
        (c.vat_number or "").lower(): c.id for c in db.query(Customer).filter(Customer.tenant_id == user.tenant_id)
    }
    seen_emails: set[str] = set(k for k in existing_emails.keys() if k)
    seen_sirets: set[str] = set(k for k in existing_sirets.keys() if k)
    seen_sirens: set[str] = set(k for k in existing_sirens.keys() if k)
    seen_vats: set[str] = set(k for k in existing_vats.keys() if k)
    for idx, row in enumerate(reader, start=1):
        normalized_row = _normalize_customer_import_row(row)
        if not any(normalized_row.values()):
            continue
        data_rows += 1
        if idx > max_rows:
            db.rollback()
            return _customer_import_error(
                "max_rows_exceeded",
                "Import limité à 5000 lignes.",
                [{"row": idx, "reason": "max_rows_exceeded", "value": str(max_rows)}],
            )
        name = normalized_row.get("name")
        if not name:
            skipped += 1
            errors.append({"row": idx, "reason": "missing_name"})
            continue
        email = normalized_row.get("email")
        if email and "@" not in email:
            skipped += 1
            errors.append({"row": idx, "reason": "invalid_email", "value": email})
            continue
        raw_siret = normalized_row.get("siret")
        raw_siren = normalized_row.get("siren")
        vat = normalized_row.get("vat_number")
        address = normalized_row.get("address")
        phone = normalized_row.get("phone")
        country = _normalize_country(normalized_row.get("country"))
        norm_email = email.lower().strip() if email else None
        norm_siret = _digits_only(raw_siret)
        norm_siren = _digits_only(raw_siren)
        norm_vat = vat.replace(" ", "").upper() if vat else None
        norm_address = (address or "").strip()
        try:
            client_type = _infer_client_type(
                normalized_row.get("client_type"),
                email=norm_email,
                address=norm_address,
                line1=None,
                city=None,
                postal_code=None,
                siret=norm_siret,
                siren=norm_siren,
                vat_number=norm_vat,
                endpoint_id=None,
                pdp_name=None,
            )
        except HTTPException:
            skipped += 1
            errors.append({"row": idx, "reason": "invalid_client_type", "value": normalized_row.get("client_type")})
            continue
        if norm_email and norm_email in seen_emails:
            skipped += 1
            errors.append({"row": idx, "reason": "duplicate_email", "value": norm_email})
            continue
        if norm_siret and not SIRET_RE.fullmatch(norm_siret):
            skipped += 1
            errors.append({"row": idx, "reason": "invalid_siret", "value": norm_siret})
            continue
        if norm_siren and not SIREN_RE.fullmatch(norm_siren):
            skipped += 1
            errors.append({"row": idx, "reason": "invalid_siren", "value": norm_siren})
            continue
        if not norm_siret and not norm_siren and norm_vat and SIRET_RE.fullmatch(norm_vat):
            norm_siret = norm_vat
            norm_vat = None
        if norm_siret:
            derived_siren = norm_siret[:9]
            if norm_siren and norm_siren != derived_siren:
                skipped += 1
                errors.append({"row": idx, "reason": "siren_mismatch", "value": norm_siren})
                continue
            norm_siren = derived_siren
        if client_type == "individual":
            if not _has_contact_info(norm_email, norm_address, None, None, None):
                skipped += 1
                errors.append({"row": idx, "reason": "missing_contact"})
                continue
        elif country == "FR":
            if not norm_siret and not norm_siren:
                skipped += 1
                errors.append({"row": idx, "reason": "missing_siret_or_siren"})
                continue
        else:
            if not norm_vat:
                skipped += 1
                errors.append({"row": idx, "reason": "missing_vat_number"})
                continue
            if not norm_address:
                skipped += 1
                errors.append({"row": idx, "reason": "missing_address"})
                continue
        if norm_siret and norm_siret.lower() in seen_sirets:
            skipped += 1
            errors.append({"row": idx, "reason": "duplicate_siret", "value": norm_siret})
            continue
        if norm_siren and norm_siren.lower() in seen_sirens:
            skipped += 1
            errors.append({"row": idx, "reason": "duplicate_siren", "value": norm_siren})
            continue
        if norm_vat and norm_vat.lower() in seen_vats:
            skipped += 1
            errors.append({"row": idx, "reason": "duplicate_vat_number", "value": norm_vat})
            continue
        if norm_vat and country == "FR" and not VAT_FR_RE.fullmatch(norm_vat.upper()):
            skipped += 1
            errors.append({"row": idx, "reason": "invalid_vat_number", "value": norm_vat})
            continue
        siren = norm_siren or (norm_siret[:9] if norm_siret else None)
        c = Customer(
            tenant_id=user.tenant_id,
            name=name.strip(),
            email=email,
            siret=norm_siret or None,
            siren=siren,
            vat_number=norm_vat.upper() if norm_vat else None,
            address=norm_address or None,
            phone=phone or None,
            country=country,
            client_type=client_type,
        )
        db.add(c)
        imported += 1
        if norm_email:
            seen_emails.add(norm_email)
        if norm_siret:
            seen_sirets.add(norm_siret.lower())
        if siren:
            seen_sirens.add(siren.lower())
        if norm_vat:
            seen_vats.add(norm_vat.lower())
    if data_rows == 0:
        db.rollback()
        return _customer_import_error(
            "no_rows",
            "Aucune ligne client à importer.",
            [{"row": 0, "reason": "no_rows"}],
        )
    if imported == 0 and any(error.get("reason") not in CUSTOMER_IMPORT_DUPLICATE_REASONS for error in errors):
        db.rollback()
        return _customer_import_error(
            "no_valid_rows",
            "Aucun client valide détecté dans ce fichier CSV.",
            errors[:50] or [{"row": 0, "reason": "no_valid_rows"}],
        )
    db.commit()
    return {"imported": imported, "created": imported, "updated": 0, "skipped": skipped, "errors": errors}


@router.post("/deduplicate")
def deduplicate_customers(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    """
    Supprime automatiquement les doublons sans facture, en conservant l'entrée la plus récente.
    """
    clusters = _find_duplicates(db, user.tenant_id)
    removed = []
    skipped = []
    for cluster in clusters:
        for cid in cluster.get("remove", []):
            customer = db.query(Customer).filter(Customer.id == cid, Customer.tenant_id == user.tenant_id).first()
            if not customer:
                skipped.append({"id": cid, "reason": "not_found"})
                continue
            blockers = _dedupe_blockers(db, customer)
            if blockers:
                skipped.append({"id": cid, "reason": blockers[0], "blockers": blockers})
                continue
            db.query(Customer).filter(Customer.id == cid, Customer.tenant_id == user.tenant_id).delete()
            removed.append(cid)
    if removed:
        db.commit()
    return {"removed": removed, "skipped": skipped, "clusters": clusters}


def _customer_portal_url(token: str) -> str:
    base = (settings.FRONTEND_BASE_URL or settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
    if base:
        return f"{base}/c/{token}"
    return f"/c/{token}"


@router.get("/{customer_id}/portal")
def get_customer_portal(
    customer_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
):
    c = db.query(Customer).filter(Customer.id == customer_id).filter(Customer.tenant_id == user.tenant_id).first()
    if not c:
        raise HTTPException(404, "Client introuvable")
    token = getattr(c, "portal_token", None)
    enabled = bool(getattr(c, "portal_enabled", False))
    url = _customer_portal_url(token) if (enabled and token) else None
    return {
        "enabled": enabled,
        "url": url,
        "token": token if enabled else None,
        "view_count": int(getattr(c, "portal_view_count", 0) or 0),
        "first_viewed_at": getattr(c, "portal_first_viewed_at", None),
        "last_viewed_at": getattr(c, "portal_last_viewed_at", None),
        "created_at": getattr(c, "portal_created_at", None),
    }


@router.post("/{customer_id}/portal")
def enable_customer_portal(
    customer_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription),
):
    c = db.query(Customer).filter(Customer.id == customer_id).filter(Customer.tenant_id == user.tenant_id).first()
    if not c:
        raise HTTPException(404, "Client introuvable")

    # Génère un token si absent
    if not getattr(c, "portal_token", None):
        c.portal_token = secrets.token_urlsafe(32)
    c.portal_enabled = True
    c.portal_created_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(c)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # rare collision: regenerate once
        c.portal_token = secrets.token_urlsafe(40)
        c.portal_enabled = True
        c.portal_created_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(c)
        db.commit()

    try:
        from ..services.action_logs import safe_log_action

        safe_log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=user.id if user else None,
            action_type="customer_portal_enable",
            object_type="customer",
            object_id=c.id,
            metadata={"enabled": True},
            commit=True,
        )
    except Exception:
        pass

    return {
        "enabled": True,
        "token": c.portal_token,
        "url": _customer_portal_url(c.portal_token),
    }


@router.post("/{customer_id}/portal/rotate")
def rotate_customer_portal(
    customer_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription),
):
    c = db.query(Customer).filter(Customer.id == customer_id).filter(Customer.tenant_id == user.tenant_id).first()
    if not c:
        raise HTTPException(404, "Client introuvable")

    c.portal_token = secrets.token_urlsafe(40)
    c.portal_enabled = True
    c.portal_created_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(c)
    db.commit()

    try:
        from ..services.action_logs import safe_log_action

        safe_log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=user.id if user else None,
            action_type="customer_portal_rotate",
            object_type="customer",
            object_id=c.id,
            metadata={},
            commit=True,
        )
    except Exception:
        pass

    return {
        "enabled": True,
        "token": c.portal_token,
        "url": _customer_portal_url(c.portal_token),
    }


@router.post("/{customer_id}/portal/disable")
def disable_customer_portal(
    customer_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    c = db.query(Customer).filter(Customer.id == customer_id).filter(Customer.tenant_id == user.tenant_id).first()
    if not c:
        raise HTTPException(404, "Client introuvable")

    c.portal_enabled = False
    db.add(c)
    db.commit()

    try:
        from ..services.action_logs import safe_log_action

        safe_log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=user.id if user else None,
            action_type="customer_portal_disable",
            object_type="customer",
            object_id=c.id,
            metadata={"enabled": False},
            commit=True,
        )
    except Exception:
        pass

    return {"enabled": False}
