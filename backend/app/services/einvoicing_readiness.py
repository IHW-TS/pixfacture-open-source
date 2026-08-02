from __future__ import annotations

from typing import Any, Literal

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Customer, EInvoicingTransmission, Invoice, PdpAccount, Tenant
from ..services.pdp.service import is_fr_b2b
from ..utils.pdp_accounts import get_pdp_account_metadata


PREREQUISITES = [
    "SIRET de l'emetteur",
    "SIREN des clients (a partir du SIRET)",
    "Categorie d'operation (biens/services/mixte)",
    "Adresse de livraison si differente",
]

_PDP_OK_STATUSES = {"ACTIVE", "CONNECTED", "APPROVED", "COMPLETED", "VALIDATED"}
_PDP_ERROR_STATUSES = {"FAILED", "ERROR", "REJECTED"}
_PDP_PENDING_STATUSES = {"PENDING", "IN_PROGRESS", "CREATED", "WAITING"}

_SANDBOX_CHANNELS = {"dummy", "mock"}
_SANDBOX_OK = {"accepted", "available", "paid"}
_SANDBOX_ERROR = {"failed", "rejected", "refused"}


def _digits(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value if ch.isdigit())


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _company_profile_check(tenant: Tenant) -> dict[str, Any]:
    missing: list[str] = []
    if not _text(tenant.name):
        missing.append("name")
    siret_digits = _digits(tenant.siret)
    if len(siret_digits) != 14:
        missing.append("siret")
    if not _text(tenant.address or tenant.address_line1):
        missing.append("address")
    if not _text(tenant.postal_code):
        missing.append("postal_code")
    if not _text(tenant.city):
        missing.append("city")
    country = _text(tenant.country or tenant.country_code)
    if not country:
        missing.append("country")
    if country.upper() == "FR" and not (_text(tenant.vat_number) or _text(tenant.vat_exemption_notice)):
        missing.append("vat_number")
    if not _text(tenant.late_payment_interest):
        missing.append("late_payment_interest")
    status = "missing" if missing else "ok"
    return {
        "id": "company_profile",
        "status": status,
        "missing_fields": missing,
        "action_url": "/app/company",
    }


def _pdp_status_value(account: PdpAccount) -> str:
    metadata = get_pdp_account_metadata(account)
    for key in ("status", "onboarding_status"):
        raw = metadata.get(key)
        if raw:
            return _text(raw).upper()
    if account.status:
        return _text(account.status).upper()
    return ""


def _pdp_status_bucket(status_value: str) -> str:
    if status_value in _PDP_OK_STATUSES:
        return "ok"
    if status_value in _PDP_ERROR_STATUSES:
        return "error"
    if status_value in _PDP_PENDING_STATUSES:
        return "missing"
    if "ERROR" in status_value or "FAILED" in status_value or "REJECT" in status_value:
        return "error"
    return "missing"


def _pdp_connection_check(db: Session, tenant_id: str) -> dict[str, Any]:
    accounts = (
        db.query(PdpAccount)
        .filter(PdpAccount.tenant_id == tenant_id)
        .order_by(PdpAccount.updated_at.desc())
        .all()
    )
    if not accounts:
        return {
            "id": "pdp_connection",
            "status": "missing",
            "action_url": "/app/einvoicing",
        }
    selected = accounts[0]
    selected_status = _pdp_status_value(selected)
    selected_provider = _text(get_pdp_account_metadata(selected).get("provider_slug") or selected.provider) or None
    for account in accounts:
        status_value = _pdp_status_value(account)
        if _pdp_status_bucket(status_value) == "ok":
            selected = account
            selected_status = status_value
            selected_provider = _text(
                get_pdp_account_metadata(account).get("provider_slug") or account.provider
            ) or None
            break
    return {
        "id": "pdp_connection",
        "status": _pdp_status_bucket(selected_status),
        "provider": selected_provider,
        "action_url": "/app/einvoicing",
    }


def _sandbox_test_check(db: Session, tenant_id: str) -> dict[str, Any]:
    tx = (
        db.query(EInvoicingTransmission)
        .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
        .filter(Invoice.tenant_id == tenant_id)
        .filter(EInvoicingTransmission.channel.in_(_SANDBOX_CHANNELS))
        .order_by(EInvoicingTransmission.created_at.desc())
        .first()
    )
    if not tx:
        return {
            "id": "sandbox_test",
            "status": "todo",
            "action_url": "/app/b2b-einvoicing",
        }
    status = (tx.status or "").strip().lower()
    if status in _SANDBOX_ERROR:
        bucket = "error"
    elif status in _SANDBOX_OK:
        bucket = "ok"
    else:
        bucket = "todo"
    return {
        "id": "sandbox_test",
        "status": bucket,
        "last_status": tx.status,
        "action_url": "/app/b2b-einvoicing",
    }


def _ereporting_check(db: Session, tenant: Tenant, customers: list[Customer]) -> dict[str, Any]:
    if getattr(settings, "EINVOICING_EXPORT_ONLY", False):
        return {
            "id": "e_reporting",
            "status": "roadmap",
            "action_url": "/app/e-reporting",
            "required": False,
        }
    tenant_country = _text(tenant.country or tenant.country_code).upper() or "FR"
    ereporting_required = False
    if tenant_country == "FR":
        for customer in customers:
            if not is_fr_b2b(tenant_country, customer.country, customer.client_type):
                ereporting_required = True
                break
    missing: list[str] = []
    if ereporting_required:
        if tenant.payments_reporting_enabled is False:
            missing.append("payments_reporting_enabled")
        if not _text(tenant.transaction_periodicity):
            missing.append("transaction_periodicity")
        if tenant.payments_reporting_enabled and not _text(tenant.payment_periodicity):
            missing.append("payment_periodicity")
    status = "ok"
    if ereporting_required and missing:
        status = "todo"
    return {
        "id": "e_reporting",
        "status": status,
        "missing_fields": missing,
        "action_url": "/app/e-reporting",
        "required": ereporting_required,
    }


def _overall_status(checks: list[dict[str, Any]]) -> str:
    statuses = [check.get("status") for check in checks]
    if any(status in {"missing", "error", "todo"} for status in statuses):
        return "not_ready"
    if any(status in {"todo", "roadmap"} for status in statuses):
        return "partial"
    return "ready"


def build_einvoicing_readiness(
    db: Session,
    tenant_id: str,
    mode: Literal["export", "connected"] = "connected",
) -> dict[str, Any]:
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise ValueError("Entreprise introuvable.")
    customers = (
        db.query(Customer)
        .filter(Customer.tenant_id == tenant_id)
        .order_by(Customer.created_at.asc())
        .all()
    )
    checks = [
        _company_profile_check(tenant),
        _pdp_connection_check(db, tenant_id),
        _sandbox_test_check(db, tenant_id),
        _ereporting_check(db, tenant, customers),
    ]
    ereporting_required = False
    for check in checks:
        if check.get("id") == "e_reporting" and check.get("required"):
            ereporting_required = True
            break

    required_ids = {"company_profile"}
    if mode == "connected":
        required_ids.update({"pdp_connection", "sandbox_test"})
        if ereporting_required:
            required_ids.add("e_reporting")

    mode_checks: list[dict[str, Any]] = []
    for check in checks:
        if check.get("id") not in required_ids:
            adjusted = dict(check)
            adjusted["status"] = "na"
            mode_checks.append(adjusted)
        else:
            mode_checks.append(check)
    required_checks = [check for check in mode_checks if check.get("id") in required_ids]
    return {
        "overall_status": _overall_status(required_checks),
        "checks": mode_checks,
        "prerequisites": PREREQUISITES,
    }
