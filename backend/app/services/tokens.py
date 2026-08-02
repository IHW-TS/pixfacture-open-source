from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Customer,
    EInvoiceTransmission,
    EInvoicingTransmission,
    EReportingEvent,
    EReportingReport,
    Invoice,
    ProviderTokenReservation,
    TokenLedger,
    TokenTopup,
    TokenWallet,
)
from ..utils.money import quantize_amount, to_decimal
from .provider_token_inventory import (
    ProviderTokenInventoryError,
    finalize_reservation,
    reserve_tokens,
)

LEDGER_TYPE_WELCOME_BONUS = "welcome_bonus"
LEDGER_TYPE_PURCHASE = "purchase"
LEDGER_TYPE_USAGE = "usage"
LEDGER_TYPE_ADJUSTMENT = "adjustment"
LEDGER_TYPE_REFUND = "refund"
_ALLOWED_LEDGER_TYPES = {
    LEDGER_TYPE_WELCOME_BONUS,
    LEDGER_TYPE_PURCHASE,
    LEDGER_TYPE_USAGE,
    LEDGER_TYPE_ADJUSTMENT,
    LEDGER_TYPE_REFUND,
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class InsufficientTokens(Exception):
    def __init__(
        self,
        message: str = "Solde de jetons insuffisant.",
        *,
        balance: int | None = None,
        required_tokens: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.balance = balance
        self.required_tokens = required_tokens


def get_or_create_wallet(db: Session, tenant_id: str) -> TokenWallet:
    wallet = db.get(TokenWallet, tenant_id)
    if wallet:
        return wallet
    wallet = TokenWallet(tenant_id=tenant_id, balance=0, welcome_bonus_granted_at=None)
    db.add(wallet)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        wallet = db.get(TokenWallet, tenant_id)
        if wallet:
            return wallet
        raise
    db.refresh(wallet)
    return wallet


def get_balance(db: Session, tenant_id: str) -> int:
    wallet = db.get(TokenWallet, tenant_id)
    if not wallet:
        wallet = get_or_create_wallet(db, tenant_id)
    return int(wallet.balance or 0)


def _get_wallet_for_update(db: Session, tenant_id: str) -> TokenWallet:
    wallet = db.execute(
        select(TokenWallet)
        .where(TokenWallet.tenant_id == tenant_id)
        .with_for_update()
    ).scalar_one_or_none()
    if wallet:
        return wallet
    wallet = TokenWallet(tenant_id=tenant_id, balance=0, welcome_bonus_granted_at=None)
    db.add(wallet)
    db.flush()
    return wallet


def _to_amount(value: Decimal | int | float | str) -> Decimal:
    return quantize_amount(to_decimal(value))


def _ensure_ledger_type(entry_type: str) -> str:
    normalized = (entry_type or "").strip().lower()
    if normalized not in _ALLOWED_LEDGER_TYPES:
        raise ValueError("Type de ledger invalide.")
    return normalized


def _invoice_detail(db: Session, tenant_id: str, invoice_id: str | None) -> dict[str, Any] | None:
    if not invoice_id:
        return None
    invoice = db.get(Invoice, invoice_id)
    if not invoice or invoice.tenant_id != tenant_id:
        return None
    customer = db.get(Customer, invoice.customer_id) if invoice.customer_id else None
    invoice_pk = str(invoice.id or "")
    invoice_number = invoice.number or invoice_pk[:8]
    detail: dict[str, Any] = {
        "kind": "invoice",
        "label": f"Facture {invoice_number}",
        "document_id": invoice.id,
        "document_number": invoice.number,
        "customer_name": customer.name if customer else None,
        "issue_date": invoice.issue_date.isoformat() if invoice.issue_date else None,
        "amount_ttc": str(quantize_amount(invoice.total_inc_vat or 0)),
        "currency": invoice.currency or "EUR",
        "href": f"/app/invoices/{invoice.id}",
    }
    return detail


def _invoice_id_from_seqino_reference(db: Session, tenant_id: str, reference_id: str | None) -> str | None:
    parts = (reference_id or "").split(":")
    if len(parts) >= 2 and parts[0] == "invoice":
        return parts[1]
    if len(parts) >= 2 and parts[0] == "invoice_retry":
        transmission_id = parts[1]
        partner_tx = db.get(EInvoiceTransmission, transmission_id)
        if partner_tx and partner_tx.tenant_id == tenant_id:
            return partner_tx.invoice_id
        legacy_tx = db.get(EInvoicingTransmission, transmission_id)
        if legacy_tx:
            invoice = db.get(Invoice, legacy_tx.invoice_id)
            if invoice and invoice.tenant_id == tenant_id:
                return invoice.id
    return None


def _ledger_detail(db: Session, entry: TokenLedger) -> dict[str, Any] | None:
    tenant_id = str(entry.tenant_id or "")
    if not tenant_id:
        return None
    reference_type = (entry.reference_type or "").strip().lower()
    reference_id = entry.reference_id
    if reference_type in {"seqino_invoice_flow", "chorus_invoice_flow"}:
        invoice_id = _invoice_id_from_seqino_reference(db, tenant_id, reference_id)
        detail = _invoice_detail(db, tenant_id, invoice_id)
        if detail:
            prefix = "Transmission Chorus" if reference_type == "chorus_invoice_flow" else "Transmission PA"
            detail["label"] = f"{prefix} · {detail['label']}"
            return detail
    if reference_type == "seqino_ereporting_event":
        event = db.get(EReportingEvent, reference_id)
        if event and event.tenant_id == tenant_id:
            return {
                "kind": "ereporting_event",
                "label": "Transmission e-reporting",
                "event_type": event.type,
                "document_id": event.id,
                "status": event.status,
                "issue_date": event.payment_date.isoformat() if event.payment_date else event.created_at.isoformat() if event.created_at else None,
                "href": "/app/e-reporting",
            }
    if reference_type == "seqino_ereporting_report":
        report = db.get(EReportingReport, reference_id)
        if report and report.tenant_id == tenant_id:
            period_label = None
            if report.period_start and report.period_end:
                period_label = f"{report.period_start.isoformat()} au {report.period_end.isoformat()}"
            return {
                "kind": "ereporting_report",
                "label": "Transmission e-reporting",
                "period_label": period_label,
                "document_id": report.id,
                "status": report.status,
                "issue_date": report.created_at.isoformat() if report.created_at else None,
                "href": "/app/e-reporting",
            }
    if reference_type == "stripe_topup":
        topup = (
            db.query(TokenTopup)
            .filter(TokenTopup.tenant_id == tenant_id, TokenTopup.stripe_session_id == reference_id)
            .first()
        )
        if topup:
            amount = quantize_amount(topup.amount_eur or 0)
            return {
                "kind": "token_topup",
                "label": f"Achat Stripe · {topup.tokens} jetons",
                "document_id": topup.id,
                "status": topup.status,
                "amount_ttc": str(amount),
                "currency": (topup.currency or "EUR").upper(),
                "issue_date": topup.created_at.isoformat() if topup.created_at else None,
                "href": "/app/billing",
            }
    return None


def _serialize_ledger_entry(db: Session, entry: TokenLedger) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": entry.id,
        "delta": int(entry.delta or 0),
        "type": (entry.type or "").strip().lower(),
        "reference_type": entry.reference_type,
        "reference_id": entry.reference_id,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
    }
    detail = _ledger_detail(db, entry)
    if detail:
        payload["detail"] = detail
    return payload


def get_history(db: Session, tenant_id: str, *, limit: int = 10) -> list[dict[str, Any]]:
    size = max(1, min(int(limit or 10), 100))
    rows = (
        db.query(TokenLedger)
        .filter(TokenLedger.tenant_id == tenant_id)
        .order_by(TokenLedger.created_at.desc(), TokenLedger.id.desc())
        .limit(size)
        .all()
    )
    return [_serialize_ledger_entry(db, row) for row in rows]


def get_token_state(db: Session, tenant_id: str, *, history_limit: int = 10) -> dict[str, Any]:
    wallet = db.get(TokenWallet, tenant_id)
    if not wallet:
        wallet = get_or_create_wallet(db, tenant_id)
    welcome_bonus_granted_at = wallet.welcome_bonus_granted_at
    return {
        "balance": int(wallet.balance or 0),
        "welcome_bonus_granted": bool(welcome_bonus_granted_at),
        "welcome_bonus_granted_at": welcome_bonus_granted_at.isoformat() if welcome_bonus_granted_at else None,
        "welcome_bonus_tokens": int(getattr(settings, "SEQINO_WELCOME_TOKENS_PRO", 0) or 0),
        "history": get_history(db, tenant_id, limit=history_limit),
        "topup_cta": "/app/billing",
    }


def _credit_wallet_with_ledger(
    db: Session,
    tenant_id: str,
    units: int,
    *,
    entry_type: str,
    reference_type: str,
    reference_id: str,
    grant_welcome_bonus: bool = False,
    commit: bool = True,
) -> tuple[int, bool]:
    units = int(units)
    if units <= 0:
        raise ValueError("Nombre de jetons invalide.")
    entry_type = _ensure_ledger_type(entry_type)
    try:
        wallet = _get_wallet_for_update(db, tenant_id)
        if grant_welcome_bonus and wallet.welcome_bonus_granted_at:
            db.rollback()
            return get_balance(db, tenant_id), False
        wallet.balance = int(wallet.balance or 0) + units
        if grant_welcome_bonus:
            wallet.welcome_bonus_granted_at = _utcnow()
        ledger = TokenLedger(
            tenant_id=tenant_id,
            delta=units,
            type=entry_type,
            reference_type=reference_type,
            reference_id=reference_id,
            created_at=_utcnow(),
        )
        db.add(ledger)
        if commit:
            db.commit()
            db.refresh(wallet)
        else:
            db.flush()
        return int(wallet.balance or 0), True
    except IntegrityError:
        db.rollback()
        return get_balance(db, tenant_id), False


def grant_pro_welcome_tokens_once(
    db: Session,
    tenant_id: str,
    *,
    reference_id: str = "first_pro_activation",
    provider_reservation_id: str | None = None,
) -> dict[str, Any]:
    welcome_tokens = int(getattr(settings, "SEQINO_WELCOME_TOKENS_PRO", 0) or 0)
    if welcome_tokens <= 0:
        return {
            "granted": False,
            "balance": get_balance(db, tenant_id),
            "tokens": 0,
        }
    # Check optimistically, then always lock provider inventory before the
    # wallet below. Consumption follows the same order and cannot deadlock.
    wallet = db.get(TokenWallet, tenant_id)
    if wallet is not None and wallet.welcome_bonus_granted_at:
        return {
            "granted": False,
            "balance": get_balance(db, tenant_id),
            "tokens": welcome_tokens,
            "reason": "already_granted",
        }
    try:
        if provider_reservation_id:
            reservation = db.get(ProviderTokenReservation, provider_reservation_id)
            if (
                reservation is None
                or str(reservation.tenant_id) != str(tenant_id)
                or int(reservation.quantity or 0) != welcome_tokens
            ):
                raise ProviderTokenInventoryError(
                    "La réservation du bonus Pro ne correspond pas à l'entreprise."
                )
        else:
            reservation = reserve_tokens(
                db,
                tenant_id=tenant_id,
                quantity=welcome_tokens,
                idempotency_key=f"welcome-bonus:{reference_id}",
            )
        finalize_reservation(db, reservation_id=str(reservation.id))
        balance, granted = _credit_wallet_with_ledger(
            db,
            tenant_id,
            welcome_tokens,
            entry_type=LEDGER_TYPE_WELCOME_BONUS,
            reference_type=LEDGER_TYPE_WELCOME_BONUS,
            reference_id=reference_id,
            grant_welcome_bonus=True,
            commit=False,
        )
        if not granted:
            current_wallet = db.get(TokenWallet, tenant_id)
            if current_wallet is None or not current_wallet.welcome_bonus_granted_at:
                raise ProviderTokenInventoryError(
                    "Le bonus Pro n'a pas pu être crédité de façon atomique."
                )
        db.commit()
    except ProviderTokenInventoryError:
        db.rollback()
        return {
            "granted": False,
            "balance": get_balance(db, tenant_id),
            "tokens": welcome_tokens,
            "reason": "provider_stock_unavailable",
        }
    return {
        "granted": granted,
        "balance": balance,
        "tokens": welcome_tokens,
    }


def credit_from_stripe_session(
    db: Session,
    tenant_id: str,
    session_id: str,
    payment_intent_id: str | None,
    tokens: int,
    amount_eur: Decimal | int | float | str,
    currency: str | None,
    *,
    provider_token_reservation_id: str | None = None,
    provider_token_allocation_id: str | None = None,
    commit: bool = True,
) -> int:
    if not session_id:
        raise ValueError("session_id manquant.")
    tokens = int(tokens)
    if tokens <= 0:
        raise ValueError("Nombre de jetons invalide.")
    try:
        wallet = _get_wallet_for_update(db, tenant_id)
        topup = TokenTopup(
            tenant_id=tenant_id,
            stripe_session_id=session_id,
            stripe_payment_intent_id=payment_intent_id,
            tokens=tokens,
            amount_eur=cast(Any, _to_amount(amount_eur)),
            currency=(currency or "eur").lower(),
            status="paid",
            provider_token_reservation_id=provider_token_reservation_id,
            provider_token_allocation_id=provider_token_allocation_id,
        )
        db.add(topup)
        db.flush()
        wallet.balance = int(wallet.balance or 0) + tokens
        ledger = TokenLedger(
            tenant_id=tenant_id,
            delta=tokens,
            type=LEDGER_TYPE_PURCHASE,
            reference_type="stripe_topup",
            reference_id=session_id,
            created_at=_utcnow(),
        )
        db.add(ledger)
        if commit:
            db.commit()
            db.refresh(wallet)
        else:
            db.flush()
        return int(wallet.balance or 0)
    except IntegrityError:
        db.rollback()
        existing = (
            db.query(TokenTopup)
            .filter(TokenTopup.stripe_session_id == session_id)
            .first()
        )
        existing_ledger = (
            db.query(TokenLedger)
            .filter(
                TokenLedger.tenant_id == tenant_id,
                TokenLedger.reference_type == "stripe_topup",
                TokenLedger.reference_id == session_id,
                TokenLedger.delta == tokens,
            )
            .first()
        )
        expected_amount = _to_amount(amount_eur)
        replay_matches = bool(
            existing
            and existing_ledger
            and str(existing.tenant_id) == str(tenant_id)
            and int(existing.tokens or 0) == tokens
            and _to_amount(existing.amount_eur if existing.amount_eur is not None else 0)
            == expected_amount
            and (existing.currency or "").strip().lower() == (currency or "eur").strip().lower()
            and (existing.stripe_payment_intent_id or None) == (payment_intent_id or None)
            and (existing.provider_token_reservation_id or None) == (provider_token_reservation_id or None)
            and (existing.provider_token_allocation_id or None) == (provider_token_allocation_id or None)
        )
        if not replay_matches:
            raise
        return get_balance(db, tenant_id)


def credit_from_stripe(
    db: Session,
    tenant_id: str,
    session_id: str,
    payment_intent_id: str | None,
    tokens: int,
    amount_eur: Decimal | int | float | str,
    currency: str | None,
) -> int:
    return credit_from_stripe_session(
        db,
        tenant_id,
        session_id,
        payment_intent_id,
        tokens,
        amount_eur,
        currency,
    )


def consume(
    db: Session,
    tenant_id: str,
    units: int,
    ref_type: str,
    ref_id: str,
    *,
    entry_type: str = LEDGER_TYPE_USAGE,
    commit: bool = True,
) -> int:
    units = int(units)
    if units <= 0:
        raise ValueError("Nombre de jetons invalide.")
    entry_type = _ensure_ledger_type(entry_type)
    stmt = (
        update(TokenWallet)
        .where(TokenWallet.tenant_id == tenant_id)
        .where(TokenWallet.balance >= units)
        .values(balance=TokenWallet.balance - units, updated_at=_utcnow())
        .returning(TokenWallet.balance)
    )
    result = db.execute(stmt).first()
    if not result:
        db.rollback()
        raise InsufficientTokens(
            "Solde de jetons insuffisant.",
            balance=get_balance(db, tenant_id),
            required_tokens=units,
        )
    new_balance = int(result[0] or 0)
    ledger = TokenLedger(
        tenant_id=tenant_id,
        delta=-units,
        type=entry_type,
        reference_type=ref_type,
        reference_id=ref_id,
        created_at=_utcnow(),
    )
    db.add(ledger)
    try:
        if commit:
            db.commit()
        else:
            db.flush()
    except IntegrityError:
        db.rollback()
        existing = (
            db.query(TokenLedger)
            .filter(
                TokenLedger.tenant_id == tenant_id,
                TokenLedger.reference_type == ref_type,
                TokenLedger.reference_id == ref_id,
            )
            .first()
        )
        if existing:
            return get_balance(db, tenant_id)
        raise
    return new_balance


def apply_adjustment(
    db: Session,
    tenant_id: str,
    units: int,
    *,
    reference_type: str,
    reference_id: str,
) -> int:
    balance, _ = _credit_wallet_with_ledger(
        db,
        tenant_id,
        units,
        entry_type=LEDGER_TYPE_ADJUSTMENT,
        reference_type=reference_type,
        reference_id=reference_id,
    )
    return balance


def apply_refund(
    db: Session,
    tenant_id: str,
    units: int,
    *,
    reference_type: str,
    reference_id: str,
    commit: bool = True,
) -> int:
    balance, _ = _credit_wallet_with_ledger(
        db,
        tenant_id,
        units,
        entry_type=LEDGER_TYPE_REFUND,
        reference_type=reference_type,
        reference_id=reference_id,
        commit=commit,
    )
    return balance
