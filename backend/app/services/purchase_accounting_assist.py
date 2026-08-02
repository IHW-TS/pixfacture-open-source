from __future__ import annotations

from copy import deepcopy
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..models import InboundInvoice, PurchaseSupplier
from .accounting_categories import account_needs_completion, label_for_account, normalize_account_code, suggest_purchase_category_from_text


def _clean_text(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _clean_digits(value: object) -> str | None:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    return digits or None


def _normalize_name(value: object) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _safe_decimal(value: object) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except Exception:
        return Decimal("0")


def _definitive_account(value: object) -> str | None:
    code = normalize_account_code(value)
    return code if code and not account_needs_completion(code) else None


def _purchase_supplier_for_invoice(db: Session, tenant_id: str, purchase: InboundInvoice) -> PurchaseSupplier | None:
    clean_siret = _clean_digits(purchase.supplier_siret)
    clean_siren = _clean_digits(purchase.supplier_siren)
    normalized_name = _normalize_name(purchase.supplier_name)
    base_filters = [PurchaseSupplier.tenant_id == tenant_id, PurchaseSupplier.is_active.is_(True)]
    if clean_siret:
        row = db.query(PurchaseSupplier).filter(*base_filters, PurchaseSupplier.siret == clean_siret).first()
        if row:
            return row
    if clean_siren:
        row = db.query(PurchaseSupplier).filter(*base_filters, PurchaseSupplier.siren == clean_siren).first()
        if row:
            return row
    if normalized_name:
        return db.query(PurchaseSupplier).filter(*base_filters, PurchaseSupplier.normalized_name == normalized_name).first()
    return None


def _history_filters(tenant_id: str, purchase: InboundInvoice) -> list[Any]:
    filters: list[Any] = []
    clean_siret = _clean_digits(purchase.supplier_siret)
    clean_siren = _clean_digits(purchase.supplier_siren)
    normalized_name = _normalize_name(purchase.supplier_name)
    if clean_siret:
        filters.append(InboundInvoice.supplier_siret == clean_siret)
    if clean_siren:
        filters.append(InboundInvoice.supplier_siren == clean_siren)
    if normalized_name:
        filters.append(func.lower(func.coalesce(InboundInvoice.supplier_name, "")) == normalized_name)
    return [InboundInvoice.tenant_id == tenant_id, InboundInvoice.id != purchase.id, or_(*filters)] if filters else []


def _history_account(db: Session, tenant_id: str, purchase: InboundInvoice) -> str | None:
    filters = _history_filters(tenant_id, purchase)
    if not filters:
        return None
    rows = (
        db.query(InboundInvoice)
        .filter(*filters)
        .order_by(InboundInvoice.updated_at.desc(), InboundInvoice.created_at.desc())
        .limit(20)
        .all()
    )
    for row in rows:
        account = _definitive_account(row.accounting_account)
        if account:
            return account
        for raw_line in row.purchase_lines if isinstance(row.purchase_lines, list) else []:
            line = raw_line if isinstance(raw_line, dict) else {}
            account = _definitive_account(line.get("accounting_account"))
            if account:
                return account
    return None


def _history_purchase_nature(db: Session, tenant_id: str, purchase: InboundInvoice) -> str | None:
    filters = _history_filters(tenant_id, purchase)
    if not filters:
        return None
    row = (
        db.query(InboundInvoice)
        .filter(*filters, InboundInvoice.purchase_nature.in_(("service", "product")))
        .order_by(InboundInvoice.updated_at.desc(), InboundInvoice.created_at.desc())
        .first()
    )
    return row.purchase_nature if row else None


def _suggestion_change(
    *,
    field: str,
    before: object,
    after: object,
    source: str,
    confidence: float,
    reason: str,
) -> dict[str, Any]:
    return {
        "field": field,
        "before": before,
        "after": after,
        "source": source,
        "confidence": max(0.0, min(float(confidence), 1.0)),
        "reason": reason,
    }


def _account_change(field: str, before: object, account: str, *, source: str, confidence: float, reason: str) -> dict[str, Any]:
    return _suggestion_change(
        field=field,
        before=before,
        after=account,
        source=source,
        confidence=confidence,
        reason=f"{reason} Catégorie proposée : {label_for_account(account)}.",
    )


def _purchase_text(purchase: InboundInvoice) -> str:
    line_labels = [
        str((raw if isinstance(raw, dict) else {}).get("label") or "")
        for raw in (purchase.purchase_lines if isinstance(purchase.purchase_lines, list) else [])
    ]
    return " ".join(
        [
            str(purchase.supplier_name or ""),
            str(purchase.invoice_number or ""),
            str(purchase.accountant_note or ""),
            *line_labels,
        ]
    )


def _suggest_account(db: Session, tenant_id: str, purchase: InboundInvoice, supplier: PurchaseSupplier | None) -> dict[str, Any] | None:
    supplier_account = _definitive_account(supplier.default_accounting_account if supplier else None)
    if supplier_account:
        return {
            "code": supplier_account,
            "source": "supplier_default",
            "confidence": 0.95,
            "reason": "Le fournisseur a une catégorie compta par défaut.",
        }
    history_account = _history_account(db, tenant_id, purchase)
    if history_account:
        return {
            "code": history_account,
            "source": "tenant_history",
            "confidence": 0.86,
            "reason": "Un achat précédent du même fournisseur utilisait cette catégorie.",
        }
    keyword = suggest_purchase_category_from_text(_purchase_text(purchase))
    if keyword:
        return {
            "code": keyword["code"],
            "source": keyword["source"],
            "confidence": keyword["confidence"],
            "reason": keyword["reason"],
        }
    return None


def _nature_from_account(account: str | None) -> str | None:
    if account in {"606", "607"}:
        return "product"
    if account:
        return "service"
    return None


def propose_purchase_accounting_patch(
    db: Session,
    tenant_id: str,
    purchase: InboundInvoice,
    *,
    skip_fields: set[str] | None = None,
) -> dict[str, Any]:
    skip_fields = skip_fields or set()
    supplier = _purchase_supplier_for_invoice(db, tenant_id, purchase)
    fields: dict[str, Any] = {}
    changes: list[dict[str, Any]] = []

    account_suggestion = _suggest_account(db, tenant_id, purchase, supplier)
    account = account_suggestion["code"] if account_suggestion else None
    if "accounting_account" not in skip_fields and account and account_needs_completion(purchase.accounting_account):
        fields["accounting_account"] = account
        changes.append(
            _account_change(
                field="accounting_account",
                before=purchase.accounting_account,
                account=account,
                source=account_suggestion["source"],
                confidence=account_suggestion["confidence"],
                reason=account_suggestion["reason"],
            )
        )

    if "purchase_nature" not in skip_fields and not _clean_text(purchase.purchase_nature):
        nature = supplier.default_purchase_nature if supplier and supplier.default_purchase_nature in {"service", "product"} else None
        nature = nature or _history_purchase_nature(db, tenant_id, purchase) or _nature_from_account(account)
        if nature:
            fields["purchase_nature"] = nature
            changes.append(
                _suggestion_change(
                    field="purchase_nature",
                    before=purchase.purchase_nature,
                    after=nature,
                    source="supplier_default" if supplier and supplier.default_purchase_nature == nature else "tenant_history" if not account else account_suggestion["source"],
                    confidence=0.82,
                    reason="La nature est déduite de la catégorie ou des habitudes fournisseur.",
                )
            )

    if (
        "planned_payment_date" not in skip_fields
        and not purchase.planned_payment_date
        and purchase.issue_date
        and supplier
        and supplier.default_payment_delay_days is not None
    ):
        planned = purchase.issue_date + timedelta(days=max(0, min(int(supplier.default_payment_delay_days), 365)))
        fields["planned_payment_date"] = planned
        changes.append(
            _suggestion_change(
                field="planned_payment_date",
                before=None,
                after=planned.isoformat(),
                source="supplier_default",
                confidence=0.9,
                reason="Le fournisseur a un délai de paiement habituel.",
            )
        )

    raw_lines = purchase.purchase_lines if isinstance(purchase.purchase_lines, list) else []
    updated_lines = deepcopy(raw_lines)
    line_changed = False
    for index, raw_line in enumerate(updated_lines):
        if not isinstance(raw_line, dict):
            continue
        if _safe_decimal(raw_line.get("total_ex_vat")).copy_abs() <= Decimal("0.0001"):
            continue
        line_account = raw_line.get("accounting_account") or purchase.accounting_account
        if account and account_needs_completion(line_account):
            before = raw_line.get("accounting_account")
            raw_line["accounting_account"] = account
            line_changed = True
            changes.append(
                _account_change(
                    field=f"purchase_lines[{index}].accounting_account",
                    before=before,
                    account=account,
                    source=account_suggestion["source"],
                    confidence=account_suggestion["confidence"],
                    reason=account_suggestion["reason"],
                )
            )
        if fields.get("purchase_nature") and not _clean_text(raw_line.get("purchase_nature")):
            raw_line["purchase_nature"] = fields["purchase_nature"]
            line_changed = True
    if line_changed:
        fields["purchase_lines"] = updated_lines

    return {"fields": fields, "changes": changes}


def apply_purchase_accounting_patch(
    db: Session,
    tenant_id: str,
    purchase: InboundInvoice,
    user_id: str | None = None,
    *,
    skip_fields: set[str] | None = None,
) -> dict[str, Any]:
    proposal = propose_purchase_accounting_patch(db, tenant_id, purchase, skip_fields=skip_fields)
    fields = proposal.get("fields") if isinstance(proposal, dict) else {}
    changes = proposal.get("changes") if isinstance(proposal, dict) else []
    for field, value in (fields or {}).items():
        if field == "purchase_lines":
            purchase.purchase_lines = value
        elif hasattr(purchase, field):
            setattr(purchase, field, value)
    return {
        "changes": changes or [],
        "message": "Achat catégorisé automatiquement." if changes else "Aucune catégorie sûre à appliquer.",
    }
