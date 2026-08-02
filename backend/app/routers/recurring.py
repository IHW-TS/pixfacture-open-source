from __future__ import annotations

import calendar
import copy
import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import (
    AuthUser,
    ensure_legal_acceptance,
    require_accountant_or_admin,
    require_paid_subscription_or_trial,
    require_product_capability,
)
from ..models import Customer, Invoice, InvoiceLine, Tenant, TenantSettings
from ..utils.money import calc_line_total, calc_tax_amount, quantize_amount
from .invoices import (
    DEFAULT_INVOICE_TEMPLATE_OPTIONS,
    _compute_due_date,
    _facturx_profile,
    _log_action,
    _merge_template_options,
    _require_role_accountant,
    _resolve_template_key,
)

router = APIRouter(
    prefix="/api/recurring",
    tags=["recurring"],
    dependencies=[Depends(require_product_capability("payments_enabled"))],
)
logger = logging.getLogger(__name__)

_ALLOWED_CADENCES = {"monthly", "quarterly", "yearly", "custom_days"}
_PROFILE_STORE_KEY = "recurring_profiles"
_RUN_STORE_KEY = "recurring_runs"
_MAX_RUN_HISTORY = 20
_PROFILE_DT_KEYS = ("next_run_at", "last_generated_at", "created_at", "updated_at", "last_run_at")
_RUN_DT_KEYS = ("started_at", "finished_at")
_RUN_ITEM_DT_KEYS = ("generated_at",)


class RecurringProfileCreate(BaseModel):
    source_invoice_id: str
    name: str | None = None
    cadence: str = "monthly"
    interval_days: int | None = None
    next_run_at: datetime | None = None
    active: bool = True
    note: str | None = None


class RecurringProfileUpdate(BaseModel):
    name: str | None = None
    cadence: str | None = None
    interval_days: int | None = None
    next_run_at: datetime | None = None
    active: bool | None = None
    note: str | None = None


class RecurringProfileOut(BaseModel):
    id: str
    name: str
    active: bool = True
    note: str | None = None
    cadence: str
    interval_days: int | None = None
    source_invoice_id: str
    source_invoice_number: str | None = None
    customer_id: str | None = None
    customer_name: str | None = None
    currency: str | None = None
    next_run_at: datetime | None = None
    last_generated_at: datetime | None = None
    last_generated_invoice_id: str | None = None
    last_generated_invoice_number: str | None = None
    last_generated_total: float | None = None
    last_run_status: str | None = None
    last_run_message: str | None = None
    last_run_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class RecurringSummaryOut(BaseModel):
    total_count: int = 0
    active_count: int = 0
    paused_count: int = 0
    due_now_count: int = 0
    next_7_days_count: int = 0
    generated_this_month_count: int = 0
    last_generated_at: datetime | None = None
    runs_count: int = 0
    last_batch_run_at: datetime | None = None
    last_batch_generated_count: int = 0


class RecurringProfilesResponse(BaseModel):
    items: list[RecurringProfileOut] = Field(default_factory=list)
    summary: RecurringSummaryOut = Field(default_factory=RecurringSummaryOut)
    now: datetime


class RecurringGenerateResponse(BaseModel):
    profile: RecurringProfileOut
    invoice_id: str
    invoice_number: str | None = None


class RecurringRunItemOut(BaseModel):
    profile_id: str
    profile_name: str | None = None
    status: str
    message: str | None = None
    invoice_id: str | None = None
    invoice_number: str | None = None
    generated_at: datetime | None = None


class RecurringRunOut(BaseModel):
    id: str
    mode: str = "due_batch"
    started_at: datetime
    finished_at: datetime | None = None
    processed_count: int = 0
    generated_count: int = 0
    error_count: int = 0
    skipped_count: int = 0
    items: list[RecurringRunItemOut] = Field(default_factory=list)


class RecurringRunsResponse(BaseModel):
    items: list[RecurringRunOut] = Field(default_factory=list)
    now: datetime


class RecurringRunDueRequest(BaseModel):
    limit: int = Field(default=25, ge=1, le=100)
    profile_ids: list[str] = Field(default_factory=list)


class RecurringRunDueResponse(BaseModel):
    run: RecurringRunOut
    profiles: list[RecurringProfileOut] = Field(default_factory=list)


def _get_or_create_settings(db: Session, tenant_id: str) -> TenantSettings:
    settings = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if settings:
        return settings
    settings = TenantSettings(tenant_id=tenant_id)
    db.add(settings)
    db.commit()
    db.refresh(settings)
    return settings


def _as_dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if value is None:
        return None
    try:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text)
    except Exception:
        return None


def _to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def _normalize_cadence(value: str | None) -> str:
    raw = (value or "monthly").strip().lower()
    aliases = {
        "month": "monthly",
        "mensuel": "monthly",
        "quarter": "quarterly",
        "quarterly": "quarterly",
        "trimestriel": "quarterly",
        "year": "yearly",
        "annual": "yearly",
        "annuel": "yearly",
        "custom": "custom_days",
        "days": "custom_days",
    }
    raw = aliases.get(raw, raw)
    if raw not in _ALLOWED_CADENCES:
        raise HTTPException(400, "Cadence invalide.")
    return raw


def _normalize_interval_days(cadence: str, value: int | None) -> int | None:
    if cadence != "custom_days":
        return None
    interval = int(value or 30)
    if interval < 1 or interval > 365:
        raise HTTPException(400, "interval_days doit être compris entre 1 et 365.")
    return interval


def _features(settings: TenantSettings) -> dict[str, Any]:
    if isinstance(settings.features, dict):
        return copy.deepcopy(settings.features)
    return {}


def _read_profiles(settings: TenantSettings) -> list[dict[str, Any]]:
    features = _features(settings)
    items = features.get(_PROFILE_STORE_KEY)
    if isinstance(items, list):
        return [copy.deepcopy(item) for item in items if isinstance(item, dict)]
    return []


def _read_runs(settings: TenantSettings) -> list[dict[str, Any]]:
    features = _features(settings)
    items = features.get(_RUN_STORE_KEY)
    if isinstance(items, list):
        return [copy.deepcopy(item) for item in items if isinstance(item, dict)]
    return []


def _write_features(
    db: Session,
    settings: TenantSettings,
    *,
    profiles: list[dict[str, Any]] | None = None,
    runs: list[dict[str, Any]] | None = None,
) -> TenantSettings:
    features = _features(settings)
    if profiles is not None:
        features[_PROFILE_STORE_KEY] = profiles
        features["recurring"] = bool(profiles)
    if runs is not None:
        features[_RUN_STORE_KEY] = runs[:_MAX_RUN_HISTORY]
    settings.features = features
    db.add(settings)
    db.commit()
    db.refresh(settings)
    return settings


def _write_profiles(db: Session, settings: TenantSettings, profiles: list[dict[str, Any]]) -> TenantSettings:
    return _write_features(db, settings, profiles=profiles)


def _write_runs(db: Session, settings: TenantSettings, runs: list[dict[str, Any]]) -> TenantSettings:
    return _write_features(db, settings, runs=runs)


def _add_months(base: datetime, months: int, preferred_day: int | None = None) -> datetime:
    year = base.year + (base.month - 1 + months) // 12
    month = (base.month - 1 + months) % 12 + 1
    day = preferred_day or base.day
    day = min(day, calendar.monthrange(year, month)[1])
    return base.replace(year=year, month=month, day=day)


def _compute_next_run(after: datetime, cadence: str, interval_days: int | None = None) -> datetime:
    if cadence == "monthly":
        return _add_months(after, 1)
    if cadence == "quarterly":
        return _add_months(after, 3)
    if cadence == "yearly":
        return _add_months(after, 12)
    if cadence == "custom_days":
        return after + timedelta(days=int(interval_days or 30))
    return after + timedelta(days=30)


def _serialize_profile(profile: dict[str, Any]) -> dict[str, Any]:
    data = copy.deepcopy(profile)
    for key in _PROFILE_DT_KEYS:
        data[key] = _to_iso(_as_dt(data.get(key)))
    return data


def _hydrate_profile(profile: dict[str, Any]) -> dict[str, Any]:
    data = copy.deepcopy(profile)
    for key in _PROFILE_DT_KEYS:
        data[key] = _as_dt(data.get(key))
    return data


def _serialize_run(run: dict[str, Any]) -> dict[str, Any]:
    data = copy.deepcopy(run)
    for key in _RUN_DT_KEYS:
        data[key] = _to_iso(_as_dt(data.get(key)))
    items = []
    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        normalized = copy.deepcopy(item)
        for key in _RUN_ITEM_DT_KEYS:
            normalized[key] = _to_iso(_as_dt(normalized.get(key)))
        items.append(normalized)
    data["items"] = items
    return data


def _hydrate_run(run: dict[str, Any]) -> dict[str, Any]:
    data = copy.deepcopy(run)
    for key in _RUN_DT_KEYS:
        data[key] = _as_dt(data.get(key))
    items = []
    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        normalized = copy.deepcopy(item)
        for key in _RUN_ITEM_DT_KEYS:
            normalized[key] = _as_dt(normalized.get(key))
        items.append(normalized)
    data["items"] = items
    return data


def _profile_out(profile: dict[str, Any]) -> RecurringProfileOut:
    return RecurringProfileOut.model_validate(_hydrate_profile(profile))


def _run_out(run: dict[str, Any]) -> RecurringRunOut:
    return RecurringRunOut.model_validate(_hydrate_run(run))


def _find_profile(profiles: list[dict[str, Any]], profile_id: str) -> tuple[int, dict[str, Any]]:
    for idx, profile in enumerate(profiles):
        if str(profile.get("id")) == profile_id:
            return idx, profile
    raise HTTPException(404, "Profil récurrent introuvable.")


def _load_source_invoice(db: Session, tenant_id: str, invoice_id: str) -> tuple[Invoice, Customer, Tenant, list[InvoiceLine]]:
    src = db.get(Invoice, invoice_id)
    if not src or src.tenant_id != tenant_id:
        raise HTTPException(404, "Facture source introuvable.")
    if src.type != "invoice":
        raise HTTPException(400, "Seules les factures peuvent servir de base récurrente.")
    customer = db.get(Customer, src.customer_id)
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(404, "Client introuvable.")
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise HTTPException(404, "Entreprise introuvable.")
    lines = (
        db.query(InvoiceLine)
        .filter(InvoiceLine.invoice_id == src.id)
        .order_by(InvoiceLine.id.asc())
        .all()
    )
    if not lines:
        raise HTTPException(400, "La facture source ne contient aucune ligne.")
    return src, customer, tenant, lines


def _duplicate_source_into_draft(
    *,
    db: Session,
    tenant_id: str,
    user: AuthUser,
    src: Invoice,
    customer: Customer,
    tenant: Tenant,
    src_lines: list[InvoiceLine],
) -> Invoice:
    issue_date = datetime.now(timezone.utc).replace(tzinfo=None)
    due_days = src.due_days
    due_date_manual = bool(src.due_date_manual and src.due_date)
    due_date = src.due_date if due_date_manual else _compute_due_date(issue_date, src.payment_terms, due_days)
    template_key = _resolve_template_key(src.template_key)
    template_options = _merge_template_options(DEFAULT_INVOICE_TEMPLATE_OPTIONS, src.template_options or {})

    new_inv = Invoice(
        tenant_id=tenant_id,
        customer_id=src.customer_id,
        number=None,
        currency=src.currency,
        status="draft",
        payment_terms=src.payment_terms,
        note=src.note,
        template_key=template_key,
        template_options=template_options,
        purchase_order_number=src.purchase_order_number,
        service_date=issue_date,
        delivery_address=src.delivery_address,
        delivery_address_differs=bool(src.delivery_address_differs),
        operation_nature=src.operation_nature,
        due_days=due_days,
        due_date=due_date,
        due_date_manual=due_date_manual,
        type="invoice",
        related_invoice_id=None,
        issue_date=issue_date,
        created_by=user.id,
        updated_by=user.id,
        issued_profile=_facturx_profile(getattr(src, "facturx_profile", None), tenant, customer),
    )
    db.add(new_inv)
    db.flush()

    total_ht = Decimal("0")
    total_tva = Decimal("0")
    for line in src_lines:
        qty = quantize_amount(line.quantity)
        unit = quantize_amount(line.unit_price)
        rate = quantize_amount(line.vat_rate)
        line_total = calc_line_total(qty, unit)
        line_tax = calc_tax_amount(line_total, rate)
        db.add(
            InvoiceLine(
                invoice_id=new_inv.id,
                product_name=line.product_name,
                quantity=qty,
                unit_price=unit,
                vat_rate=rate,
                vat_category=line.vat_category,
                exemption_reason_code=line.exemption_reason_code,
                unit_code=line.unit_code,
                item_id=line.item_id,
                line_total=line_total,
            )
        )
        total_ht += line_total
        total_tva += line_tax

    new_inv.total_ex_vat = quantize_amount(total_ht)
    new_inv.total_vat = quantize_amount(total_tva)
    new_inv.total_inc_vat = quantize_amount(total_ht + total_tva)
    db.add(new_inv)
    return new_inv


def _generate_profile_draft(
    *,
    db: Session,
    user: AuthUser,
    tenant_id: str,
    profile: dict[str, Any],
) -> tuple[dict[str, Any], Invoice, Invoice, Customer]:
    src, customer, tenant, lines = _load_source_invoice(db, tenant_id, str(profile.get("source_invoice_id") or ""))
    new_inv = _duplicate_source_into_draft(
        db=db,
        tenant_id=tenant_id,
        user=user,
        src=src,
        customer=customer,
        tenant=tenant,
        src_lines=lines,
    )
    db.commit()
    db.refresh(new_inv)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    cadence = _normalize_cadence(profile.get("cadence"))
    interval_days = _normalize_interval_days(cadence, profile.get("interval_days"))
    base_next = _as_dt(profile.get("next_run_at")) or now

    updated = copy.deepcopy(profile)
    updated["source_invoice_number"] = src.number
    updated["customer_id"] = customer.id
    updated["customer_name"] = customer.name
    updated["currency"] = src.currency or "EUR"
    updated["last_generated_at"] = _to_iso(now)
    updated["last_generated_invoice_id"] = new_inv.id
    updated["last_generated_invoice_number"] = new_inv.number
    updated["last_generated_total"] = float(new_inv.total_inc_vat or 0)
    updated["last_run_status"] = "success"
    updated["last_run_message"] = f"Brouillon généré depuis {src.number or 'la facture source'}."
    updated["last_run_at"] = _to_iso(now)
    updated["next_run_at"] = _to_iso(_compute_next_run(base_next if base_next > now else now, cadence, interval_days))
    updated["updated_at"] = _to_iso(now)
    return updated, new_inv, src, customer


@router.get("", response_model=RecurringProfilesResponse)
def list_profiles(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    settings = _get_or_create_settings(db, user.tenant_id)
    profiles = [_hydrate_profile(item) for item in _read_profiles(settings)]
    runs = [_hydrate_run(item) for item in _read_runs(settings)]
    profiles.sort(
        key=lambda item: (
            not bool(item.get("active", True)),
            _as_dt(item.get("next_run_at")) or datetime.max,
            str(item.get("name") or "").lower(),
        )
    )

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_run = runs[0] if runs else None
    generated_ats = [_as_dt(item.get("last_generated_at")) for item in profiles]
    generated_at_values = [value for value in generated_ats if value is not None]
    summary = RecurringSummaryOut(
        total_count=len(profiles),
        active_count=sum(1 for item in profiles if bool(item.get("active", True))),
        paused_count=sum(1 for item in profiles if not bool(item.get("active", True))),
        due_now_count=sum(
            1
            for item in profiles
            if bool(item.get("active", True)) and (_as_dt(item.get("next_run_at")) or datetime.max) <= now
        ),
        next_7_days_count=sum(
            1
            for item in profiles
            if bool(item.get("active", True)) and now < (_as_dt(item.get("next_run_at")) or datetime.max) <= (now + timedelta(days=7))
        ),
        generated_this_month_count=sum(
            1
            for item in profiles
            if (_as_dt(item.get("last_generated_at")) or datetime.min) >= month_start
        ),
        last_generated_at=max(generated_at_values) if generated_at_values else None,
        runs_count=len(runs),
        last_batch_run_at=_as_dt(last_run.get("finished_at") or last_run.get("started_at")) if last_run else None,
        last_batch_generated_count=int(last_run.get("generated_count") or 0) if last_run else 0,
    )
    return RecurringProfilesResponse(items=[_profile_out(item) for item in profiles], summary=summary, now=now)


@router.get("/runs", response_model=RecurringRunsResponse)
def list_runs(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    settings = _get_or_create_settings(db, user.tenant_id)
    runs = [_run_out(item) for item in _read_runs(settings)]
    return RecurringRunsResponse(items=runs, now=datetime.now(timezone.utc).replace(tzinfo=None))


@router.post("", response_model=RecurringProfileOut)
def create_profile(
    payload: RecurringProfileCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    ensure_legal_acceptance(user, db)
    cadence = _normalize_cadence(payload.cadence)
    interval_days = _normalize_interval_days(cadence, payload.interval_days)
    src, customer, _tenant, _src_lines = _load_source_invoice(db, user.tenant_id, payload.source_invoice_id)
    settings = _get_or_create_settings(db, user.tenant_id)
    profiles = _read_profiles(settings)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    next_run_at = payload.next_run_at or _compute_next_run(now, cadence, interval_days)
    profile = {
        "id": str(uuid.uuid4()),
        "name": (payload.name or f"{customer.name or 'Client'} · {src.number or 'facture récurrente'}").strip(),
        "active": bool(payload.active),
        "note": (payload.note or None),
        "cadence": cadence,
        "interval_days": interval_days,
        "source_invoice_id": src.id,
        "source_invoice_number": src.number,
        "customer_id": customer.id,
        "customer_name": customer.name,
        "currency": src.currency or "EUR",
        "next_run_at": _to_iso(next_run_at),
        "last_generated_at": None,
        "last_generated_invoice_id": None,
        "last_generated_invoice_number": None,
        "last_generated_total": None,
        "last_run_status": None,
        "last_run_message": None,
        "last_run_at": None,
        "created_at": _to_iso(now),
        "updated_at": _to_iso(now),
    }
    profiles.append(profile)
    _write_profiles(db, settings, [_serialize_profile(item) for item in profiles])
    _log_action(
        db,
        user,
        user.tenant_id,
        "recurring_profile",
        profile["id"],
        "create",
        {"source_invoice_id": src.id, "source_number": src.number, "cadence": cadence},
    )
    db.commit()
    return _profile_out(profile)


@router.patch("/{profile_id}", response_model=RecurringProfileOut)
def update_profile(
    profile_id: str,
    payload: RecurringProfileUpdate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    settings = _get_or_create_settings(db, user.tenant_id)
    profiles = _read_profiles(settings)
    idx, profile = _find_profile(profiles, profile_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    cadence = _normalize_cadence(payload.cadence or profile.get("cadence"))
    interval_days = _normalize_interval_days(cadence, payload.interval_days if payload.interval_days is not None else profile.get("interval_days"))

    if payload.name is not None:
        profile["name"] = payload.name.strip() or profile.get("name") or "Facture récurrente"
    if payload.note is not None:
        profile["note"] = payload.note or None
    if payload.active is not None:
        profile["active"] = bool(payload.active)
    profile["cadence"] = cadence
    profile["interval_days"] = interval_days
    if payload.next_run_at is not None:
        profile["next_run_at"] = _to_iso(payload.next_run_at)
    elif _as_dt(profile.get("next_run_at")) is None:
        profile["next_run_at"] = _to_iso(_compute_next_run(now, cadence, interval_days))
    profile["updated_at"] = _to_iso(now)
    profiles[idx] = profile
    _write_profiles(db, settings, [_serialize_profile(item) for item in profiles])
    _log_action(db, user, user.tenant_id, "recurring_profile", profile_id, "update", {"cadence": cadence, "active": profile.get("active")})
    db.commit()
    return _profile_out(profile)


@router.delete("/{profile_id}")
def delete_profile(
    profile_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    settings = _get_or_create_settings(db, user.tenant_id)
    profiles = _read_profiles(settings)
    idx, profile = _find_profile(profiles, profile_id)
    profiles.pop(idx)
    _write_profiles(db, settings, [_serialize_profile(item) for item in profiles])
    _log_action(db, user, user.tenant_id, "recurring_profile", profile_id, "delete", {"name": profile.get("name")})
    db.commit()
    return {"ok": True}


@router.post("/{profile_id}/generate", response_model=RecurringGenerateResponse)
def generate_from_profile(
    profile_id: str,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    ensure_legal_acceptance(user, db)
    settings = _get_or_create_settings(db, user.tenant_id)
    profiles = _read_profiles(settings)
    idx, profile = _find_profile(profiles, profile_id)

    updated_profile, new_inv, src, _customer = _generate_profile_draft(
        db=db,
        user=user,
        tenant_id=user.tenant_id,
        profile=profile,
    )
    profiles[idx] = _serialize_profile(updated_profile)

    _log_action(
        db,
        user,
        user.tenant_id,
        "recurring_profile",
        profile_id,
        "generate",
        {"invoice_id": new_inv.id, "source_invoice_id": src.id},
    )
    _log_action(
        db,
        user,
        user.tenant_id,
        "invoice",
        new_inv.id,
        "generated_from_recurring_profile",
        {"profile_id": profile_id, "profile_name": updated_profile.get("name")},
    )
    _write_profiles(db, settings, profiles)
    return RecurringGenerateResponse(profile=_profile_out(updated_profile), invoice_id=new_inv.id, invoice_number=new_inv.number)


@router.post("/run-due", response_model=RecurringRunDueResponse)
def run_due_profiles(
    payload: RecurringRunDueRequest,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_accountant_or_admin),
    _: AuthUser = Depends(require_paid_subscription_or_trial),
):
    _require_role_accountant(user)
    ensure_legal_acceptance(user, db)
    settings = _get_or_create_settings(db, user.tenant_id)
    profiles = _read_profiles(settings)
    existing_runs = [_hydrate_run(item) for item in _read_runs(settings)]
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    selected_ids = {item for item in (payload.profile_ids or []) if item}

    due_candidates: list[tuple[int, dict[str, Any]]] = []
    for idx, profile in enumerate(profiles):
        next_run = _as_dt(profile.get("next_run_at"))
        if not bool(profile.get("active", True)):
            continue
        if selected_ids and str(profile.get("id")) not in selected_ids:
            continue
        if (next_run or datetime.max) > now:
            continue
        due_candidates.append((idx, profile))

    due_candidates.sort(key=lambda item: (_as_dt(item[1].get("next_run_at")) or datetime.max, str(item[1].get("name") or "").lower()))
    to_process = due_candidates[: payload.limit]

    run: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "mode": "due_batch",
        "started_at": now,
        "finished_at": None,
        "processed_count": 0,
        "generated_count": 0,
        "error_count": 0,
        "skipped_count": max(0, len(due_candidates) - len(to_process)),
        "items": [],
    }

    for idx, profile in to_process:
        run["processed_count"] += 1
        try:
            updated_profile, new_inv, src, _customer = _generate_profile_draft(
                db=db,
                user=user,
                tenant_id=user.tenant_id,
                profile=profile,
            )
            profiles[idx] = _serialize_profile(updated_profile)
            run["generated_count"] += 1
            run["items"].append(
                {
                    "profile_id": str(updated_profile.get("id")),
                    "profile_name": updated_profile.get("name"),
                    "status": "success",
                    "message": updated_profile.get("last_run_message"),
                    "invoice_id": new_inv.id,
                    "invoice_number": new_inv.number,
                    "generated_at": datetime.now(timezone.utc).replace(tzinfo=None),
                }
            )
            _log_action(
                db,
                user,
                user.tenant_id,
                "recurring_profile",
                str(updated_profile.get("id")),
                "generate_batch",
                {"invoice_id": new_inv.id, "source_invoice_id": src.id, "run_id": run["id"]},
            )
            _log_action(
                db,
                user,
                user.tenant_id,
                "invoice",
                new_inv.id,
                "generated_from_recurring_batch",
                {"profile_id": str(updated_profile.get("id")), "run_id": run["id"]},
            )
        except HTTPException as exc:
            db.rollback()
            detail = exc.detail
            message = detail.get("message") if isinstance(detail, dict) else str(detail)
            failed = copy.deepcopy(profile)
            failed["last_run_status"] = "error"
            failed["last_run_message"] = message or "Génération impossible."
            failed["last_run_at"] = _to_iso(datetime.now(timezone.utc).replace(tzinfo=None))
            failed["updated_at"] = _to_iso(datetime.now(timezone.utc).replace(tzinfo=None))
            profiles[idx] = _serialize_profile(failed)
            run["error_count"] += 1
            run["items"].append(
                {
                    "profile_id": str(profile.get("id")),
                    "profile_name": profile.get("name"),
                    "status": "error",
                    "message": message or "Génération impossible.",
                    "invoice_id": None,
                    "invoice_number": None,
                    "generated_at": datetime.now(timezone.utc).replace(tzinfo=None),
                }
            )
        except Exception:  # pragma: no cover - best effort batch processing
            db.rollback()
            logger.exception("recurring_invoice_generation_failed", extra={"profile_id": str(profile.get("id"))})
            message = "La facture récurrente n’a pas pu être générée. Réessayez ou contactez l’assistance."
            failed = copy.deepcopy(profile)
            failed["last_run_status"] = "error"
            failed["last_run_message"] = message
            failed["last_run_at"] = _to_iso(datetime.now(timezone.utc).replace(tzinfo=None))
            failed["updated_at"] = _to_iso(datetime.now(timezone.utc).replace(tzinfo=None))
            profiles[idx] = _serialize_profile(failed)
            run["error_count"] += 1
            run["items"].append(
                {
                    "profile_id": str(profile.get("id")),
                    "profile_name": profile.get("name"),
                    "status": "error",
                    "message": message,
                    "invoice_id": None,
                    "invoice_number": None,
                    "generated_at": datetime.now(timezone.utc).replace(tzinfo=None),
                }
            )

    run["finished_at"] = datetime.now(timezone.utc).replace(tzinfo=None)
    existing_runs.insert(0, run)
    _write_features(
        db,
        settings,
        profiles=profiles,
        runs=[_serialize_run(item) for item in existing_runs[:_MAX_RUN_HISTORY]],
    )

    hydrated_profiles = [_hydrate_profile(item) for item in profiles]
    hydrated_profiles.sort(
        key=lambda item: (
            not bool(item.get("active", True)),
            _as_dt(item.get("next_run_at")) or datetime.max,
            str(item.get("name") or "").lower(),
        )
    )
    return RecurringRunDueResponse(
        run=_run_out(_serialize_run(run)),
        profiles=[_profile_out(item) for item in hydrated_profiles],
    )
