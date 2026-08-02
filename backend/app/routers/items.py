import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Response
from fastapi.responses import JSONResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Product
from ..schemas import ProductCreate, ProductUpdate, ProductOut
from ..deps import require_viewer_or_admin, require_commercial_user, require_paid_subscription_or_trial, AuthUser
from ..utils.unit_codes import normalize_unit_code

router = APIRouter(prefix="/api/items", tags=["items"])


@router.get("", response_model=list[ProductOut])
def list_items(
    q: str | None = Query(None),
    include_inactive: bool = False,
    active: bool | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
):
    query = db.query(Product).filter(Product.tenant_id == user.tenant_id)
    if active is not None:
        query = query.filter(Product.active.is_(active))
    elif not include_inactive:
        query = query.filter(Product.active)
    raw_query = (q or "").strip()
    if raw_query:
        term = f"%{raw_query}%"
        query = query.filter(
            or_(
                Product.name.ilike(term),
                Product.description.ilike(term),
                Product.unit_code.ilike(term),
            )
        )
    return query.order_by(Product.name.asc()).all()


@router.post("", response_model=ProductOut)
def create_item(
    body: ProductCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_user),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    p = Product(tenant_id=user.tenant_id, **body.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@router.put("/{item_id}", response_model=ProductOut)
def update_item(
    item_id: str,
    body: ProductUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_user),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    p = db.get(Product, item_id)
    if not p or p.tenant_id != user.tenant_id:
        raise HTTPException(404, "Article introuvable")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(p, key, value)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@router.delete("/{item_id}")
def archive_item(
    item_id: str,
    permanent: bool = Query(False),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_user),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    p = db.get(Product, item_id)
    if not p or p.tenant_id != user.tenant_id:
        raise HTTPException(404, "Article introuvable")
    if permanent:
        db.delete(p)
        db.commit()
        return {"ok": True, "deleted": True}
    p.active = False
    db.add(p)
    db.commit()
    return {"ok": True, "archived": True}


CSV_INJECTION_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _sanitize_csv_cell(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    if not text:
        return ""
    probe = text.lstrip(" \t\r\n\ufeff")
    if probe and probe[0] in CSV_INJECTION_PREFIXES:
        return "'" + text
    return text


def _parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    # Support French decimal comma
    raw = raw.replace(" ", "").replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


def _parse_bool(value: str | None, default: bool | None = None) -> bool | None:
    if value is None:
        return default
    raw = str(value).strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "vrai", "yes", "y", "oui"}:
        return True
    if raw in {"0", "false", "faux", "no", "n", "non"}:
        return False
    return default


@router.get("/export.csv")
def export_items_csv(
    page: int = Query(1, ge=1),
    page_size: int = Query(10000, ge=1, le=50000),
    q: str | None = Query(None, max_length=120),
    include_inactive: bool = False,
    active: bool | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_user),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    base_query = db.query(Product).filter(Product.tenant_id == user.tenant_id)
    if active is not None:
        base_query = base_query.filter(Product.active.is_(active))
    elif not include_inactive:
        base_query = base_query.filter(Product.active)
    raw_query = (q or "").strip()
    if raw_query:
        term = f"%{raw_query}%"
        base_query = base_query.filter(
            or_(
                Product.name.ilike(term),
                Product.description.ilike(term),
                Product.unit_code.ilike(term),
            )
        )
    total = base_query.count()
    rows = (
        base_query.order_by(Product.name.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, delimiter=",", quotechar='"', quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(["id", "name", "description", "unit_price", "vat_rate", "unit_code", "active", "created_at"])
    for p in rows:
        writer.writerow(
            [
                _sanitize_csv_cell(p.id),
                _sanitize_csv_cell(p.name),
                _sanitize_csv_cell(p.description),
                _sanitize_csv_cell(p.unit_price),
                _sanitize_csv_cell(p.vat_rate),
                _sanitize_csv_cell(p.unit_code),
                _sanitize_csv_cell("true" if p.active else "false"),
                _sanitize_csv_cell(p.created_at.isoformat() if getattr(p, "created_at", None) else ""),
            ]
        )
    csv_bytes = buf.getvalue().encode("utf-8")
    headers = {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="articles.csv"',
        "X-Total-Count": str(total),
    }
    return Response(content=csv_bytes, headers=headers, media_type="text/csv")


@router.post("/import")
async def import_items(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_commercial_user),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    if file.content_type not in {"text/csv", "application/vnd.ms-excel", "application/csv", "text/plain"}:
        return JSONResponse(
            status_code=400,
            content={
                "error": {"code": "invalid_format", "message": "Format non supporté (CSV uniquement)."},
                "errors": [{"row": 0, "reason": "invalid_format", "value": file.content_type}],
            },
        )
    raw = await file.read()
    if len(raw) > 2_000_000:
        return JSONResponse(
            status_code=400,
            content={
                "error": {"code": "file_too_large", "message": "Fichier trop volumineux (max 2MB)."},
                "errors": [{"row": 0, "reason": "file_too_large", "value": str(len(raw))}],
            },
        )
    text = raw.decode("utf-8", errors="ignore")

    reader = csv.DictReader(io.StringIO(text))
    fieldnames = {(f or "").strip().lower() for f in (reader.fieldnames or []) if (f or "").strip()}
    if not fieldnames:
        return JSONResponse(
            status_code=400,
            content={
                "error": {"code": "missing_headers", "message": "En-têtes CSV manquants."},
                "errors": [{"row": 0, "reason": "missing_headers"}],
            },
        )
    if "name" not in fieldnames and "nom" not in fieldnames:
        return JSONResponse(
            status_code=400,
            content={
                "error": {"code": "missing_required_columns", "message": "Colonne 'name' obligatoire."},
                "errors": [{"row": 0, "reason": "missing_required_columns", "value": "name"}],
            },
        )

    max_rows = 5000
    created = 0
    updated = 0
    skipped = 0
    errors: list[dict] = []

    # index existing by id and by name (first match)
    existing_by_id = {p.id: p for p in db.query(Product).filter(Product.tenant_id == user.tenant_id).all()}
    existing_by_name: dict[str, Product] = {}
    for p in existing_by_id.values():
        key = (p.name or "").strip().lower()
        if key and key not in existing_by_name:
            existing_by_name[key] = p

    for idx, row in enumerate(reader, start=1):
        if idx > max_rows:
            db.rollback()
            return JSONResponse(
                status_code=400,
                content={
                    "error": {"code": "max_rows_exceeded", "message": "Import limité à 5000 lignes."},
                    "errors": [{"row": idx, "reason": "max_rows_exceeded", "value": str(max_rows)}],
                },
            )
        name = (row.get("name") or row.get("nom") or row.get("Name") or "").strip()
        if not name:
            skipped += 1
            errors.append({"row": idx, "reason": "missing_name"})
            continue

        raw_id = (row.get("id") or row.get("ID") or "").strip()
        description = (row.get("description") or row.get("desc") or row.get("Description") or "").strip() or None
        unit_price = _parse_float(row.get("unit_price") or row.get("prix") or row.get("prix_unitaire") or row.get("price"))
        vat_rate = _parse_float(row.get("vat_rate") or row.get("tva") or row.get("taux_tva") or row.get("vat"))
        unit_code = (row.get("unit_code") or row.get("unite") or row.get("unit") or "").strip() or None
        active = _parse_bool(row.get("active"), default=True)

        if unit_price is None:
            unit_price = 0.0
        if vat_rate is None:
            vat_rate = 20.0
        unit_code = normalize_unit_code(unit_code)

        target: Product | None = None
        if raw_id and raw_id in existing_by_id:
            target = existing_by_id[raw_id]
        else:
            target = existing_by_name.get(name.strip().lower())

        if target:
            target.name = name
            target.description = description
            target.unit_price = unit_price
            target.vat_rate = vat_rate
            target.unit_code = unit_code
            target.active = True if active is None else bool(active)
            db.add(target)
            updated += 1
        else:
            p = Product(
                tenant_id=user.tenant_id,
                name=name,
                description=description,
                unit_price=unit_price,
                vat_rate=vat_rate,
                unit_code=unit_code,
                active=True if active is None else bool(active),
            )
            db.add(p)
            created += 1

    db.commit()
    return {
        "ok": True,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
    }
