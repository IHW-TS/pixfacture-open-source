"""Collateral accounting for provider-side transmission tokens.

Customer ``TokenWallet`` rows describe what PixFacture owes its customers.
They are deliberately not treated as proof that the upstream provider has
enough credits.  This module maintains a separate, provider-scoped inventory
whose movements are balanced and append-only.

All mutating functions flush but never commit.  The caller must commit the
provider movement and its related customer-wallet/business mutation in the
same database transaction.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    ProviderTokenAllocation,
    ProviderTokenAllocationMovement,
    ProviderTokenInventory,
    ProviderTokenLedgerEntry,
    ProviderTokenLedgerEvent,
    ProviderTokenReservation,
    Tenant,
    TokenLedger,
    TokenWallet,
)


SEQINO_PROVIDER_SLUG = "seqino"
DEFAULT_WARNING_THRESHOLD = 1000
DEFAULT_CRITICAL_THRESHOLD = 250
DEFAULT_RESERVATION_TTL_SECONDS = 30 * 60
MAX_RESERVATION_TTL_SECONDS = 8 * 24 * 60 * 60
# Stripe requires Checkout expiry to be at least 30 minutes after Stripe
# receives the request.  Use 35 minutes to tolerate clock/network delay and
# retain an unbound ambiguous request beyond Stripe's live webhook retry window.
# Once a Checkout session is bound, only an explicit terminal Stripe event may
# release it; the local expiry monitor deliberately skips it.
CHECKOUT_SESSION_TTL_SECONDS = 35 * 60
CHECKOUT_RESERVATION_TTL_SECONDS = 7 * 24 * 60 * 60

ACCOUNT_PURCHASED = "purchased"
ACCOUNT_AVAILABLE = "available"
ACCOUNT_RESERVED = "reserved"
ACCOUNT_ALLOCATED = "allocated"
ACCOUNT_CONSUMED = "consumed"


class ProviderTokenInventoryError(RuntimeError):
    """Base error for fail-closed provider inventory operations."""


class ProviderTokenInventoryNotInitialized(ProviderTokenInventoryError):
    pass


class ProviderTokenInventoryInconsistent(ProviderTokenInventoryError):
    pass


class ProviderTokenIdempotencyConflict(ProviderTokenInventoryError):
    pass


class InsufficientProviderTokens(ProviderTokenInventoryError):
    def __init__(self, *, requested: int, sellable: int) -> None:
        super().__init__("Stock fournisseur insuffisant pour garantir cette opération.")
        self.requested = requested
        self.sellable = sellable


class ProviderTokenReservationStateError(ProviderTokenInventoryError):
    pass


class ProviderTokenReservationLimitExceeded(ProviderTokenInventoryError):
    """A tenant already owns a live Checkout hold.

    Checkout holds are deliberately exclusive per tenant.  Without that
    invariant, repeatedly opening unpaid Stripe sessions could immobilise the
    shared supplier stock until the expiry job runs.
    """

    pass


@dataclass(frozen=True)
class ProviderInventoryStatus:
    provider_slug: str
    state: str
    purchased_tokens: int
    available_tokens: int
    reserved_tokens: int
    allocated_tokens: int
    consumed_tokens: int
    warning_threshold: int
    critical_threshold: int
    sellable_tokens: int
    customer_wallet_tokens: int
    pending_welcome_bonus_tokens: int
    pending_welcome_bonus_tenants: int
    customer_liability_tokens: int
    allocation_available_tokens: int
    coverage_gap_tokens: int
    active_reservation_tokens: int
    allocation_consumed_tokens: int
    allocation_released_tokens: int
    invalid_ledger_events: int
    ledger_matches_inventory: bool
    invariant_valid: bool
    safe_to_sell: bool

    def as_dict(self) -> dict[str, int | str | bool]:
        return {
            "provider_slug": self.provider_slug,
            "state": self.state,
            "purchased_tokens": self.purchased_tokens,
            "available_tokens": self.available_tokens,
            "reserved_tokens": self.reserved_tokens,
            "allocated_tokens": self.allocated_tokens,
            "consumed_tokens": self.consumed_tokens,
            "warning_threshold": self.warning_threshold,
            "critical_threshold": self.critical_threshold,
            "sellable_tokens": self.sellable_tokens,
            "customer_wallet_tokens": self.customer_wallet_tokens,
            "pending_welcome_bonus_tokens": self.pending_welcome_bonus_tokens,
            "pending_welcome_bonus_tenants": self.pending_welcome_bonus_tenants,
            "customer_liability_tokens": self.customer_liability_tokens,
            "allocation_available_tokens": self.allocation_available_tokens,
            "coverage_gap_tokens": self.coverage_gap_tokens,
            "active_reservation_tokens": self.active_reservation_tokens,
            "allocation_consumed_tokens": self.allocation_consumed_tokens,
            "allocation_released_tokens": self.allocation_released_tokens,
            "invalid_ledger_events": self.invalid_ledger_events,
            "ledger_matches_inventory": self.ledger_matches_inventory,
            "invariant_valid": self.invariant_valid,
            "safe_to_sell": self.safe_to_sell,
        }


@dataclass(frozen=True)
class ProviderPurchaseResult:
    inventory: ProviderTokenInventory
    applied: bool
    pledged_tokens: int
    pledged_tenants: int
    credited_bonus_tokens: int
    credited_bonus_tenants: int


@dataclass(frozen=True)
class ProviderLiabilityBackfillResult:
    inventory: ProviderTokenInventory
    applied: bool
    pledged_tokens: int
    pledged_tenants: int
    credited_bonus_tokens: int
    credited_bonus_tenants: int


@dataclass(frozen=True)
class _TenantTokenLiability:
    tenant_id: str
    wallet: TokenWallet | None
    wallet_tokens: int
    pending_welcome_bonus_tokens: int
    allocated_tokens: int
    coverage_gap_tokens: int


@dataclass(frozen=True)
class _TokenLiabilitySnapshot:
    liabilities: tuple[_TenantTokenLiability, ...]
    customer_wallet_tokens: int
    pending_welcome_bonus_tokens: int
    pending_welcome_bonus_tenants: int
    customer_liability_tokens: int
    allocation_available_tokens: int
    coverage_gap_tokens: int


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _positive_quantity(value: int) -> int:
    quantity = int(value)
    if quantity <= 0:
        raise ValueError("Le nombre de jetons doit être strictement positif.")
    return quantity


def _normalise_key(value: str, *, label: str) -> str:
    normalised = (value or "").strip()
    if not normalised:
        raise ValueError(f"{label} est obligatoire.")
    if len(normalised) > 255:
        raise ValueError(f"{label} est trop long.")
    return normalised


def _normalise_provider_slug(value: str) -> str:
    return _normalise_key(value, label="provider_slug").lower()


def _validate_thresholds(*, warning_threshold: int, critical_threshold: int) -> tuple[int, int]:
    warning = int(warning_threshold)
    critical = int(critical_threshold)
    if critical < 0 or warning < critical:
        raise ValueError("Les seuils fournisseur sont invalides.")
    return warning, critical


def _inventory_values(inventory: ProviderTokenInventory) -> tuple[int, int, int, int, int]:
    return (
        int(inventory.purchased_tokens or 0),
        int(inventory.available_tokens or 0),
        int(inventory.reserved_tokens or 0),
        int(inventory.allocated_tokens or 0),
        int(inventory.consumed_tokens or 0),
    )


def _assert_inventory_conservation(inventory: ProviderTokenInventory) -> None:
    purchased, available, reserved, allocated, consumed = _inventory_values(inventory)
    if min(purchased, available, reserved, allocated, consumed) < 0:
        raise ProviderTokenInventoryInconsistent("Un compte fournisseur est négatif.")
    if purchased != available + reserved + allocated + consumed:
        raise ProviderTokenInventoryInconsistent("L'invariant du stock fournisseur est rompu.")


def _inventory_for_update(db: Session, provider_slug: str) -> ProviderTokenInventory:
    inventory = db.execute(
        select(ProviderTokenInventory)
        .where(ProviderTokenInventory.provider_slug == _normalise_provider_slug(provider_slug))
        .with_for_update()
    ).scalar_one_or_none()
    if inventory is None:
        raise ProviderTokenInventoryNotInitialized("Le stock fournisseur n'est pas initialisé.")
    _assert_inventory_conservation(inventory)
    return inventory


def _lock_provider_creation(db: Session, provider_slug: str) -> None:
    """Serialize first-purchase creation where no inventory row exists yet."""

    bind = db.get_bind()
    if bind.dialect.name == "postgresql":
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
            {"lock_key": f"pixfacture-provider-token-inventory:{provider_slug}"},
        )


def _existing_event(
    db: Session,
    inventory_id: str,
    idempotency_key: str,
) -> ProviderTokenLedgerEvent | None:
    return db.execute(
        select(ProviderTokenLedgerEvent).where(
            ProviderTokenLedgerEvent.inventory_id == inventory_id,
            ProviderTokenLedgerEvent.idempotency_key == idempotency_key,
        )
    ).scalar_one_or_none()


def _assert_replay_matches(
    event: ProviderTokenLedgerEvent,
    *,
    event_type: str,
    quantity: int,
    tenant_id: str | None,
    allocation_id: str | None,
    reversal_of_event_id: str | None,
    reference_type: str | None,
    reference_id: str | None,
) -> None:
    actual = (
        event.event_type,
        int(event.quantity or 0),
        event.tenant_id,
        event.allocation_id,
        event.reversal_of_event_id,
        event.reference_type,
        event.reference_id,
    )
    expected = (
        event_type,
        quantity,
        tenant_id,
        allocation_id,
        reversal_of_event_id,
        reference_type,
        reference_id,
    )
    if actual != expected:
        raise ProviderTokenIdempotencyConflict("La clé d'idempotence fournisseur est déjà liée à une autre opération.")


def _append_balanced_event(
    db: Session,
    inventory: ProviderTokenInventory,
    *,
    event_type: str,
    idempotency_key: str,
    quantity: int,
    source_account: str,
    destination_account: str,
    tenant_id: str | None = None,
    allocation_id: str | None = None,
    reversal_of_event_id: str | None = None,
    reference_type: str | None = None,
    reference_id: str | None = None,
) -> tuple[ProviderTokenLedgerEvent, bool]:
    key = _normalise_key(idempotency_key, label="idempotency_key")
    units = _positive_quantity(quantity)
    existing = _existing_event(db, str(inventory.id), key)
    if existing is not None:
        _assert_replay_matches(
            existing,
            event_type=event_type,
            quantity=units,
            tenant_id=tenant_id,
            allocation_id=allocation_id,
            reversal_of_event_id=reversal_of_event_id,
            reference_type=reference_type,
            reference_id=reference_id,
        )
        return existing, False
    if source_account == destination_account:
        raise ValueError("Les comptes source et destination doivent être distincts.")

    now = _utcnow()
    event = ProviderTokenLedgerEvent(
        inventory_id=inventory.id,
        tenant_id=tenant_id,
        allocation_id=allocation_id,
        reversal_of_event_id=reversal_of_event_id,
        event_type=event_type,
        idempotency_key=key,
        quantity=units,
        reference_type=reference_type,
        reference_id=reference_id,
        created_at=now,
    )
    db.add(event)
    db.flush()
    db.add_all(
        [
            ProviderTokenLedgerEntry(
                event_id=event.id,
                inventory_id=inventory.id,
                entry_index=1,
                account=source_account,
                delta=-units,
                created_at=now,
            ),
            ProviderTokenLedgerEntry(
                event_id=event.id,
                inventory_id=inventory.id,
                entry_index=2,
                account=destination_account,
                delta=units,
                created_at=now,
            ),
        ]
    )
    return event, True


def _add_allocation_movement(
    db: Session,
    *,
    event: ProviderTokenLedgerEvent,
    allocation: ProviderTokenAllocation,
    movement_index: int,
    available_delta: int,
    consumed_delta: int,
    released_delta: int = 0,
) -> None:
    if available_delta + consumed_delta + released_delta != 0:
        raise ProviderTokenInventoryInconsistent("Une ventilation d'allocation n'est pas équilibrée.")
    db.add(
        ProviderTokenAllocationMovement(
            event_id=event.id,
            allocation_id=allocation.id,
            movement_index=movement_index,
            available_delta=available_delta,
            consumed_delta=consumed_delta,
            released_delta=released_delta,
            created_at=_utcnow(),
        )
    )


def _welcome_bonus_units() -> int:
    return max(int(getattr(settings, "SEQINO_WELCOME_TOKENS_PRO", 0) or 0), 0)


def _token_liability_snapshot(
    db: Session,
    *,
    inventory_id: str | None,
    lock: bool = False,
    defer_welcome_bonus_for_tenant_id: str | None = None,
) -> _TokenLiabilitySnapshot:
    """Return every currently outstanding customer-token obligation.

    A legacy active Pro tenant may predate the atomic welcome-bonus flow and
    therefore have neither a wallet nor ``welcome_bonus_granted_at``.  The
    promised bonus is still a liability and must reduce sellable stock before
    it is credited.  Deleted tenants do not acquire a new welcome entitlement;
    any positive wallet they retain remains covered like every other wallet.
    """

    active_pro_statement = (
        select(Tenant)
        .where(
            Tenant.deleted_at.is_(None),
            func.lower(func.trim(func.coalesce(Tenant.plan, ""))) == "pro",
            func.lower(func.trim(func.coalesce(Tenant.subscription_status, ""))) == "active",
        )
        .order_by(Tenant.id)
    )
    if lock:
        active_pro_statement = active_pro_statement.with_for_update()
    active_pro_tenants = list(db.execute(active_pro_statement).scalars())
    active_pro_ids = {str(tenant.id) for tenant in active_pro_tenants}

    wallet_filter = TokenWallet.balance > 0
    if active_pro_ids:
        wallet_filter = or_(wallet_filter, TokenWallet.tenant_id.in_(active_pro_ids))
    wallet_statement = select(TokenWallet).where(wallet_filter).order_by(TokenWallet.tenant_id)
    if lock:
        wallet_statement = wallet_statement.with_for_update()
    wallets = list(db.execute(wallet_statement).scalars())
    wallet_by_tenant = {str(wallet.tenant_id): wallet for wallet in wallets}

    allocations: list[ProviderTokenAllocation] = []
    if inventory_id is not None:
        allocation_statement = (
            select(ProviderTokenAllocation)
            .where(ProviderTokenAllocation.inventory_id == inventory_id)
            .order_by(ProviderTokenAllocation.tenant_id, ProviderTokenAllocation.created_at)
        )
        if lock:
            allocation_statement = allocation_statement.with_for_update()
        allocations = list(db.execute(allocation_statement).scalars())
    allocated_by_tenant: dict[str, int] = {}
    for allocation in allocations:
        tenant_id = str(allocation.tenant_id)
        allocated_by_tenant[tenant_id] = allocated_by_tenant.get(tenant_id, 0) + max(
            int(allocation.available_tokens or 0),
            0,
        )

    welcome_units = _welcome_bonus_units()
    tenant_ids = sorted(set(wallet_by_tenant) | active_pro_ids)
    liabilities: list[_TenantTokenLiability] = []
    customer_wallet_tokens = 0
    pending_welcome_bonus_tokens = 0
    pending_welcome_bonus_tenants = 0
    coverage_gap_tokens = 0
    for tenant_id in tenant_ids:
        wallet = wallet_by_tenant.get(tenant_id)
        wallet_tokens = max(int(wallet.balance or 0), 0) if wallet is not None else 0
        pending_bonus = (
            welcome_units
            if tenant_id in active_pro_ids
            and tenant_id != defer_welcome_bonus_for_tenant_id
            and welcome_units > 0
            and (wallet is None or wallet.welcome_bonus_granted_at is None)
            else 0
        )
        allocated_tokens = allocated_by_tenant.get(tenant_id, 0)
        coverage_gap = max(wallet_tokens + pending_bonus - allocated_tokens, 0)
        liabilities.append(
            _TenantTokenLiability(
                tenant_id=tenant_id,
                wallet=wallet,
                wallet_tokens=wallet_tokens,
                pending_welcome_bonus_tokens=pending_bonus,
                allocated_tokens=allocated_tokens,
                coverage_gap_tokens=coverage_gap,
            )
        )
        customer_wallet_tokens += wallet_tokens
        pending_welcome_bonus_tokens += pending_bonus
        pending_welcome_bonus_tenants += int(pending_bonus > 0)
        coverage_gap_tokens += coverage_gap

    return _TokenLiabilitySnapshot(
        liabilities=tuple(liabilities),
        customer_wallet_tokens=customer_wallet_tokens,
        pending_welcome_bonus_tokens=pending_welcome_bonus_tokens,
        pending_welcome_bonus_tenants=pending_welcome_bonus_tenants,
        customer_liability_tokens=customer_wallet_tokens + pending_welcome_bonus_tokens,
        allocation_available_tokens=sum(allocated_by_tenant.values()),
        coverage_gap_tokens=coverage_gap_tokens,
    )


def _reconcile_token_liabilities(
    db: Session,
    inventory: ProviderTokenInventory,
    *,
    reconciliation_reference: str,
    defer_welcome_bonus_for_tenant_id: str | None = None,
) -> ProviderLiabilityBackfillResult:
    """Pledge existing stock and credit missed Pro bonuses atomically."""

    reference = _normalise_key(
        reconciliation_reference,
        label="reconciliation_reference",
    )
    snapshot = _token_liability_snapshot(
        db,
        inventory_id=str(inventory.id),
        lock=True,
        defer_welcome_bonus_for_tenant_id=defer_welcome_bonus_for_tenant_id,
    )
    available = int(inventory.available_tokens or 0)
    if snapshot.coverage_gap_tokens > available:
        raise InsufficientProviderTokens(
            requested=snapshot.coverage_gap_tokens,
            sellable=available,
        )

    now = _utcnow()
    pledged_tokens = 0
    pledged_tenants = 0
    credited_bonus_tokens = 0
    credited_bonus_tenants = 0
    for liability in snapshot.liabilities:
        tenant_id = liability.tenant_id
        gap = liability.coverage_gap_tokens
        if gap:
            allocation = ProviderTokenAllocation(
                inventory_id=inventory.id,
                tenant_id=tenant_id,
                reservation_id=None,
                idempotency_key=f"liability-coverage:{reference}:{tenant_id}",
                quantity=gap,
                available_tokens=gap,
                consumed_tokens=0,
                released_tokens=0,
                created_at=now,
                updated_at=now,
            )
            db.add(allocation)
            db.flush()
            _event, applied = _append_balanced_event(
                db,
                inventory,
                event_type="token_liability_pledge",
                idempotency_key=f"token-liability-pledge:{reference}:{tenant_id}",
                quantity=gap,
                source_account=ACCOUNT_AVAILABLE,
                destination_account=ACCOUNT_ALLOCATED,
                tenant_id=tenant_id,
                allocation_id=str(allocation.id),
                reference_type="token_liability_reconciliation",
                reference_id=reference,
            )
            if not applied:
                raise ProviderTokenInventoryInconsistent("Ce rapprochement de passif fournisseur a déjà été appliqué.")
            inventory.available_tokens = int(inventory.available_tokens or 0) - gap
            inventory.allocated_tokens = int(inventory.allocated_tokens or 0) + gap
            pledged_tokens += gap
            pledged_tenants += 1

        bonus = liability.pending_welcome_bonus_tokens
        if bonus:
            ledger_reference = f"legacy-pro:{reference}"
            existing_bonus_ledger = db.execute(
                select(TokenLedger.id).where(
                    TokenLedger.tenant_id == tenant_id,
                    TokenLedger.reference_type == "welcome_bonus",
                    TokenLedger.reference_id == ledger_reference,
                )
            ).scalar_one_or_none()
            if existing_bonus_ledger is not None:
                raise ProviderTokenInventoryInconsistent(
                    "Le rapprochement du bonus Pro est incohérent avec le portefeuille client."
                )
            wallet = liability.wallet
            if wallet is None:
                wallet = TokenWallet(
                    tenant_id=tenant_id,
                    balance=0,
                    welcome_bonus_granted_at=None,
                    created_at=now,
                    updated_at=now,
                )
                db.add(wallet)
            wallet.balance = int(wallet.balance or 0) + bonus
            wallet.welcome_bonus_granted_at = now
            wallet.updated_at = now
            db.add(
                TokenLedger(
                    tenant_id=tenant_id,
                    delta=bonus,
                    type="welcome_bonus",
                    reference_type="welcome_bonus",
                    reference_id=ledger_reference,
                    created_at=now,
                )
            )
            credited_bonus_tokens += bonus
            credited_bonus_tenants += 1

    inventory.updated_at = now
    _assert_inventory_conservation(inventory)
    db.flush()
    return ProviderLiabilityBackfillResult(
        inventory=inventory,
        applied=bool(pledged_tokens or credited_bonus_tokens),
        pledged_tokens=pledged_tokens,
        pledged_tenants=pledged_tenants,
        credited_bonus_tokens=credited_bonus_tokens,
        credited_bonus_tenants=credited_bonus_tenants,
    )


def _ledger_audit(
    db: Session,
    inventory_id: str,
) -> tuple[int, dict[str, int]]:
    rows = db.execute(
        select(
            ProviderTokenLedgerEvent.id,
            ProviderTokenLedgerEvent.quantity,
            ProviderTokenLedgerEntry.inventory_id,
            ProviderTokenLedgerEntry.account,
            ProviderTokenLedgerEntry.delta,
        )
        .outerjoin(
            ProviderTokenLedgerEntry,
            ProviderTokenLedgerEntry.event_id == ProviderTokenLedgerEvent.id,
        )
        .where(ProviderTokenLedgerEvent.inventory_id == inventory_id)
    ).all()
    events: dict[str, tuple[int, list[tuple[str | None, str | None, int]]]] = {}
    account_balances: dict[str, int] = {}
    for event_id, quantity, entry_inventory_id, account, delta in rows:
        event_key = str(event_id)
        expected_quantity, entries = events.setdefault(
            event_key,
            (int(quantity or 0), []),
        )
        if account is None or delta is None:
            continue
        units = int(delta)
        entries.append((entry_inventory_id, account, units))
        account_balances[str(account)] = account_balances.get(str(account), 0) + units
        events[event_key] = (expected_quantity, entries)

    invalid = 0
    for expected_quantity, entries in events.values():
        if (
            len(entries) != 2
            or sum(delta for _entry_inventory_id, _account, delta in entries) != 0
            or len({account for _entry_inventory_id, account, _delta in entries}) != 2
            or any(abs(delta) != expected_quantity for _entry_inventory_id, _account, delta in entries)
            or any(str(entry_inventory_id) != inventory_id for entry_inventory_id, _account, _delta in entries)
        ):
            invalid += 1
    return invalid, account_balances


def get_inventory_status(
    db: Session,
    *,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
) -> ProviderInventoryStatus:
    slug = _normalise_provider_slug(provider_slug)
    inventory = db.execute(
        select(ProviderTokenInventory).where(ProviderTokenInventory.provider_slug == slug)
    ).scalar_one_or_none()
    if inventory is None:
        liabilities = _token_liability_snapshot(db, inventory_id=None)
        return ProviderInventoryStatus(
            provider_slug=slug,
            state="uninitialized",
            purchased_tokens=0,
            available_tokens=0,
            reserved_tokens=0,
            allocated_tokens=0,
            consumed_tokens=0,
            warning_threshold=DEFAULT_WARNING_THRESHOLD,
            critical_threshold=DEFAULT_CRITICAL_THRESHOLD,
            sellable_tokens=0,
            customer_wallet_tokens=liabilities.customer_wallet_tokens,
            pending_welcome_bonus_tokens=liabilities.pending_welcome_bonus_tokens,
            pending_welcome_bonus_tenants=liabilities.pending_welcome_bonus_tenants,
            customer_liability_tokens=liabilities.customer_liability_tokens,
            allocation_available_tokens=0,
            coverage_gap_tokens=liabilities.coverage_gap_tokens,
            active_reservation_tokens=0,
            allocation_consumed_tokens=0,
            allocation_released_tokens=0,
            invalid_ledger_events=0,
            ledger_matches_inventory=False,
            invariant_valid=False,
            safe_to_sell=False,
        )

    purchased, available, reserved, allocated, consumed = _inventory_values(inventory)
    warning = int(inventory.warning_threshold or 0)
    critical = int(inventory.critical_threshold or 0)
    liabilities = _token_liability_snapshot(
        db,
        inventory_id=str(inventory.id),
    )
    active_reservations = int(
        db.execute(
            select(func.coalesce(func.sum(ProviderTokenReservation.quantity), 0)).where(
                ProviderTokenReservation.inventory_id == inventory.id,
                ProviderTokenReservation.status == "reserved",
            )
        ).scalar_one()
        or 0
    )
    allocation_consumed = int(
        db.execute(
            select(func.coalesce(func.sum(ProviderTokenAllocation.consumed_tokens), 0)).where(
                ProviderTokenAllocation.inventory_id == inventory.id
            )
        ).scalar_one()
        or 0
    )
    allocation_released = int(
        db.execute(
            select(func.coalesce(func.sum(ProviderTokenAllocation.released_tokens), 0)).where(
                ProviderTokenAllocation.inventory_id == inventory.id
            )
        ).scalar_one()
        or 0
    )
    invalid_ledger_events, ledger_accounts = _ledger_audit(db, str(inventory.id))
    # Zero-value accounts may legitimately have no ledger row yet.
    ledger_matches_inventory = all(
        ledger_accounts.get(account, 0) == expected
        for account, expected in {
            ACCOUNT_PURCHASED: -purchased,
            ACCOUNT_AVAILABLE: available,
            ACCOUNT_RESERVED: reserved,
            ACCOUNT_ALLOCATED: allocated,
            ACCOUNT_CONSUMED: consumed,
        }.items()
    )
    invariant_valid = (
        min(purchased, available, reserved, allocated, consumed) >= 0
        and purchased == available + reserved + allocated + consumed
        and active_reservations == reserved
        and liabilities.allocation_available_tokens == allocated
        and allocation_consumed == consumed
        and liabilities.coverage_gap_tokens == 0
        and invalid_ledger_events == 0
        and ledger_matches_inventory
    )
    sellable = max(available - critical, 0) if invariant_valid else 0
    if not invariant_valid:
        state = "inconsistent"
    elif available == 0:
        state = "depleted"
    elif available <= critical:
        state = "critical"
    elif available <= warning:
        state = "warning"
    else:
        state = "healthy"
    return ProviderInventoryStatus(
        provider_slug=slug,
        state=state,
        purchased_tokens=purchased,
        available_tokens=available,
        reserved_tokens=reserved,
        allocated_tokens=allocated,
        consumed_tokens=consumed,
        warning_threshold=warning,
        critical_threshold=critical,
        sellable_tokens=sellable,
        customer_wallet_tokens=liabilities.customer_wallet_tokens,
        pending_welcome_bonus_tokens=liabilities.pending_welcome_bonus_tokens,
        pending_welcome_bonus_tenants=liabilities.pending_welcome_bonus_tenants,
        customer_liability_tokens=liabilities.customer_liability_tokens,
        allocation_available_tokens=liabilities.allocation_available_tokens,
        coverage_gap_tokens=liabilities.coverage_gap_tokens,
        active_reservation_tokens=active_reservations,
        allocation_consumed_tokens=allocation_consumed,
        allocation_released_tokens=allocation_released,
        invalid_ledger_events=invalid_ledger_events,
        ledger_matches_inventory=ledger_matches_inventory,
        invariant_valid=invariant_valid,
        safe_to_sell=invariant_valid and sellable > 0,
    )


def _status_valid_except_liability_coverage(status: ProviderInventoryStatus) -> bool:
    return (
        min(
            status.purchased_tokens,
            status.available_tokens,
            status.reserved_tokens,
            status.allocated_tokens,
            status.consumed_tokens,
        )
        >= 0
        and status.purchased_tokens
        == (status.available_tokens + status.reserved_tokens + status.allocated_tokens + status.consumed_tokens)
        and status.active_reservation_tokens == status.reserved_tokens
        and status.allocation_available_tokens == status.allocated_tokens
        and status.allocation_consumed_tokens == status.consumed_tokens
        and status.invalid_ledger_events == 0
        and status.ledger_matches_inventory
    )


def _welcome_reservation_closes_only_remaining_gap(
    db: Session,
    inventory: ProviderTokenInventory,
    *,
    status: ProviderInventoryStatus,
    tenant_id: str,
    quantity: int,
) -> bool:
    if not _status_valid_except_liability_coverage(status):
        return False
    if status.coverage_gap_tokens != quantity:
        return False
    snapshot = _token_liability_snapshot(
        db,
        inventory_id=str(inventory.id),
        lock=True,
    )
    target = next(
        (liability for liability in snapshot.liabilities if liability.tenant_id == tenant_id),
        None,
    )
    return bool(
        target is not None
        and target.pending_welcome_bonus_tokens == quantity
        and target.coverage_gap_tokens == quantity
    )


def record_provider_purchase(
    db: Session,
    *,
    quantity: int,
    purchase_reference: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
    warning_threshold: int = DEFAULT_WARNING_THRESHOLD,
    critical_threshold: int = DEFAULT_CRITICAL_THRESHOLD,
) -> ProviderPurchaseResult:
    """Record verified upstream stock and reconcile every legacy liability.

    This function never buys anything from the provider.  The purchase event,
    provider allocations and any missed active-Pro welcome credits are merely
    persisted together after the operator has independently verified the
    supplier order.
    """

    units = _positive_quantity(quantity)
    reference = _normalise_key(purchase_reference, label="purchase_reference")
    slug = _normalise_provider_slug(provider_slug)
    warning, critical = _validate_thresholds(
        warning_threshold=warning_threshold,
        critical_threshold=critical_threshold,
    )
    _lock_provider_creation(db, slug)
    inventory = db.execute(
        select(ProviderTokenInventory).where(ProviderTokenInventory.provider_slug == slug).with_for_update()
    ).scalar_one_or_none()
    if inventory is None:
        inventory = ProviderTokenInventory(
            provider_slug=slug,
            purchased_tokens=0,
            available_tokens=0,
            reserved_tokens=0,
            allocated_tokens=0,
            consumed_tokens=0,
            warning_threshold=warning,
            critical_threshold=critical,
            created_at=_utcnow(),
            updated_at=_utcnow(),
        )
        db.add(inventory)
        db.flush()
    _assert_inventory_conservation(inventory)

    event_key = f"supplier-purchase:{reference}"
    existing_event = _existing_event(db, str(inventory.id), event_key)
    if existing_event is not None:
        _assert_replay_matches(
            existing_event,
            event_type="supplier_purchase",
            quantity=units,
            tenant_id=None,
            allocation_id=None,
            reversal_of_event_id=None,
            reference_type="supplier_purchase",
            reference_id=reference,
        )
        return ProviderPurchaseResult(
            inventory=inventory,
            applied=False,
            pledged_tokens=0,
            pledged_tenants=0,
            credited_bonus_tokens=0,
            credited_bonus_tenants=0,
        )

    liabilities = _token_liability_snapshot(
        db,
        inventory_id=str(inventory.id),
        lock=True,
    )
    available_after_purchase = int(inventory.available_tokens or 0) + units
    if liabilities.coverage_gap_tokens > available_after_purchase:
        raise InsufficientProviderTokens(
            requested=liabilities.coverage_gap_tokens,
            sellable=available_after_purchase,
        )
    _event, applied = _append_balanced_event(
        db,
        inventory,
        event_type="supplier_purchase",
        idempotency_key=event_key,
        quantity=units,
        source_account=ACCOUNT_PURCHASED,
        destination_account=ACCOUNT_AVAILABLE,
        reference_type="supplier_purchase",
        reference_id=reference,
    )
    if not applied:
        raise ProviderTokenInventoryInconsistent("L'achat fournisseur a été rejoué pendant son enregistrement.")

    inventory.purchased_tokens = int(inventory.purchased_tokens or 0) + units
    inventory.available_tokens = int(inventory.available_tokens or 0) + units
    inventory.updated_at = _utcnow()

    reconciliation = _reconcile_token_liabilities(
        db,
        inventory,
        reconciliation_reference=reference,
    )
    return ProviderPurchaseResult(
        inventory=inventory,
        applied=True,
        pledged_tokens=reconciliation.pledged_tokens,
        pledged_tenants=reconciliation.pledged_tenants,
        credited_bonus_tokens=reconciliation.credited_bonus_tokens,
        credited_bonus_tenants=reconciliation.credited_bonus_tenants,
    )


def backfill_provider_token_liabilities(
    db: Session,
    *,
    reconciliation_reference: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
) -> ProviderLiabilityBackfillResult:
    """Cover legacy wallets/Pro bonuses from already verified provider stock.

    No supplier-purchase event is created and ``purchased_tokens`` is never
    increased.  The caller must commit; on any error the complete backfill can
    be rolled back without a partial wallet credit or provider allocation.
    """

    inventory = _inventory_for_update(db, provider_slug)
    return _reconcile_token_liabilities(
        db,
        inventory,
        reconciliation_reference=reconciliation_reference,
    )


def reserve_tokens(
    db: Session,
    *,
    tenant_id: str,
    quantity: int,
    idempotency_key: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
    ttl_seconds: int = DEFAULT_RESERVATION_TTL_SECONDS,
    exclusive_checkout_scope: str | None = None,
) -> ProviderTokenReservation:
    """Hold sellable stock for a customer purchase without committing."""

    units = _positive_quantity(quantity)
    key = _normalise_key(idempotency_key, label="idempotency_key")
    ttl = int(ttl_seconds)
    if ttl <= 0 or ttl > MAX_RESERVATION_TTL_SECONDS:
        raise ValueError("La durée de réservation doit être comprise entre 1 seconde et 24 heures.")
    inventory = _inventory_for_update(db, provider_slug)
    existing = db.execute(
        select(ProviderTokenReservation).where(
            ProviderTokenReservation.inventory_id == inventory.id,
            ProviderTokenReservation.tenant_id == tenant_id,
            ProviderTokenReservation.idempotency_key == key,
        )
    ).scalar_one_or_none()
    if existing is not None:
        if int(existing.quantity or 0) != units:
            raise ProviderTokenIdempotencyConflict("La réservation existe déjà avec une quantité différente.")
        if (
            existing.status == "reserved"
            and existing.expires_at is not None
            and existing.expires_at <= _utcnow()
            and not existing.stripe_checkout_session_id
        ):
            raise ProviderTokenReservationStateError(
                "Cette demande de réservation a expiré. Une nouvelle demande est requise."
            )
        if existing.status not in {"reserved", "finalized"}:
            raise ProviderTokenReservationStateError(
                "Cette demande de réservation a expiré. Une nouvelle demande est requise."
            )
        return existing

    now = _utcnow()
    if exclusive_checkout_scope:
        scope = _normalise_key(
            exclusive_checkout_scope,
            label="exclusive_checkout_scope",
        )
        # The inventory row is already locked, so concurrent requests for the
        # same (or another) tenant cannot both pass this check and create
        # parallel holds.  Expired holds are released in this transaction so a
        # missed Stripe expiry webhook cannot block a legitimate retry.
        expired = (
            db.execute(
                select(ProviderTokenReservation)
                .where(
                    ProviderTokenReservation.inventory_id == inventory.id,
                    ProviderTokenReservation.tenant_id == tenant_id,
                    ProviderTokenReservation.status == "reserved",
                    ProviderTokenReservation.expires_at <= now,
                    ProviderTokenReservation.stripe_checkout_session_id.is_(None),
                )
                .order_by(ProviderTokenReservation.expires_at, ProviderTokenReservation.id)
                .with_for_update()
            )
            .scalars()
            .all()
        )
        for stale in expired:
            _release_locked_reservation(
                db,
                inventory,
                stale,
                expired=True,
                now=now,
            )
        if expired:
            # ``autoflush`` is disabled for application sessions.  Persist the
            # released status before the aggregate invariant check below, or
            # the database would still count the stale hold as reserved while
            # the locked inventory row already exposes the released balance.
            db.flush()

        active = (
            db.execute(
                select(ProviderTokenReservation)
                .where(
                    ProviderTokenReservation.inventory_id == inventory.id,
                    ProviderTokenReservation.tenant_id == tenant_id,
                    ProviderTokenReservation.status == "reserved",
                    or_(
                        ProviderTokenReservation.expires_at > now,
                        ProviderTokenReservation.stripe_checkout_session_id.is_not(None),
                    ),
                )
                .order_by(ProviderTokenReservation.created_at, ProviderTokenReservation.id)
                .with_for_update()
            )
            .scalars()
            .all()
        )
        if len(active) == 1:
            active_reservation = active[0]
            active_key = str(active_reservation.idempotency_key or "")
            if active_key.startswith(f"{scope}:") and int(active_reservation.quantity or 0) == units:
                # Reuse the backing hold.  Callers also key the Stripe request
                # on this reservation id, so a refreshed page receives the
                # same Checkout session instead of consuming more stock.
                return active_reservation
        if active:
            raise ProviderTokenReservationLimitExceeded(
                "Une demande de paiement est déjà en cours pour cette entreprise."
            )

    status = get_inventory_status(db, provider_slug=provider_slug)
    direct_welcome_grant = key.startswith("welcome-bonus:")
    if (
        not status.invariant_valid
        and status.coverage_gap_tokens > 0
        and _status_valid_except_liability_coverage(status)
    ):
        reconciliation_digest = hashlib.sha256(f"{provider_slug}:{key}".encode("utf-8")).hexdigest()[:32]
        _reconcile_token_liabilities(
            db,
            inventory,
            reconciliation_reference=f"auto:{reconciliation_digest}",
            defer_welcome_bonus_for_tenant_id=(str(tenant_id) if direct_welcome_grant else None),
        )
        status = get_inventory_status(db, provider_slug=provider_slug)

    welcome_reservation_closes_gap = direct_welcome_grant and (
        _welcome_reservation_closes_only_remaining_gap(
            db,
            inventory,
            status=status,
            tenant_id=str(tenant_id),
            quantity=units,
        )
    )
    if not status.invariant_valid and not welcome_reservation_closes_gap:
        raise ProviderTokenInventoryInconsistent("Le stock fournisseur ne passe pas le contrôle de cohérence.")
    sellable_tokens = (
        status.sellable_tokens
        if status.invariant_valid
        else max(status.available_tokens - status.critical_threshold, 0)
    )
    if units > sellable_tokens:
        raise InsufficientProviderTokens(requested=units, sellable=sellable_tokens)

    reservation = ProviderTokenReservation(
        inventory_id=inventory.id,
        tenant_id=tenant_id,
        idempotency_key=key,
        quantity=units,
        status="reserved",
        expires_at=now + timedelta(seconds=ttl),
        created_at=now,
        updated_at=now,
    )
    db.add(reservation)
    db.flush()
    _append_balanced_event(
        db,
        inventory,
        event_type="reservation_created",
        idempotency_key=f"reservation-created:{reservation.id}",
        quantity=units,
        source_account=ACCOUNT_AVAILABLE,
        destination_account=ACCOUNT_RESERVED,
        tenant_id=tenant_id,
        reference_type="provider_token_reservation",
        reference_id=reservation.id,
    )
    inventory.available_tokens = int(inventory.available_tokens or 0) - units
    inventory.reserved_tokens = int(inventory.reserved_tokens or 0) + units
    inventory.updated_at = now
    _assert_inventory_conservation(inventory)
    db.flush()
    return reservation


def bind_reservation_to_stripe_checkout(
    db: Session,
    *,
    reservation_id: str,
    stripe_checkout_session_id: str,
    checkout_kind: str,
    checkout_expires_at: datetime | int | float | None = None,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
) -> ProviderTokenReservation:
    """Bind a supplier hold to Stripe so TTL cleanup can never race payment."""

    session_id = _normalise_key(
        stripe_checkout_session_id,
        label="stripe_checkout_session_id",
    )
    kind = _normalise_key(checkout_kind, label="checkout_kind")
    inventory = _inventory_for_update(db, provider_slug)
    reservation = db.execute(
        select(ProviderTokenReservation)
        .where(
            ProviderTokenReservation.id == reservation_id,
            ProviderTokenReservation.inventory_id == inventory.id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if reservation is None:
        raise ProviderTokenReservationStateError("Réservation fournisseur introuvable.")
    if reservation.status not in {"reserved", "finalized"}:
        raise ProviderTokenReservationStateError("Cette réservation ne peut plus être liée au paiement.")
    existing_session_id = str(reservation.stripe_checkout_session_id or "").strip()
    if existing_session_id and existing_session_id != session_id:
        raise ProviderTokenIdempotencyConflict("Cette réservation est déjà liée à une autre session de paiement.")
    now = _utcnow()
    reservation.stripe_checkout_session_id = session_id
    reservation.stripe_checkout_kind = kind
    reservation.stripe_checkout_bound_at = reservation.stripe_checkout_bound_at or now
    if checkout_expires_at is not None:
        if isinstance(checkout_expires_at, datetime):
            remote_expiry = checkout_expires_at
            if remote_expiry.tzinfo is not None:
                remote_expiry = remote_expiry.astimezone(timezone.utc).replace(tzinfo=None)
        else:
            remote_expiry = datetime.fromtimestamp(
                float(checkout_expires_at),
                tz=timezone.utc,
            ).replace(tzinfo=None)
        # This is a reconciliation due date, not an automatic release. The
        # monitor must read Stripe and may release only a verified expired,
        # unpaid Session. Keep a grace period for terminal webhook delivery.
        reservation.expires_at = max(remote_expiry, now) + timedelta(minutes=15)
    reservation.updated_at = now
    db.add(reservation)
    db.flush()
    return reservation


def finalize_reservation(
    db: Session,
    *,
    reservation_id: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
    now: datetime | None = None,
) -> ProviderTokenAllocation:
    """Convert a paid hold into tenant backing; never credits the wallet itself."""

    inventory = _inventory_for_update(db, provider_slug)
    reservation = db.execute(
        select(ProviderTokenReservation)
        .where(
            ProviderTokenReservation.id == reservation_id,
            ProviderTokenReservation.inventory_id == inventory.id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if reservation is None:
        raise ProviderTokenReservationStateError("Réservation fournisseur introuvable.")
    if reservation.status == "finalized":
        allocation = db.execute(
            select(ProviderTokenAllocation).where(ProviderTokenAllocation.reservation_id == reservation.id)
        ).scalar_one_or_none()
        if allocation is None:
            raise ProviderTokenInventoryInconsistent("La réservation finalisée n'a pas d'allocation.")
        return allocation
    if reservation.status != "reserved":
        raise ProviderTokenReservationStateError("Cette réservation ne peut plus être finalisée.")
    instant = now or _utcnow()
    expires_at = reservation.expires_at
    if expires_at is None:
        raise ProviderTokenInventoryInconsistent("La réservation fournisseur n'a pas d'échéance.")
    if expires_at <= instant and not reservation.stripe_checkout_session_id:
        raise ProviderTokenReservationStateError(
            "La réservation fournisseur a expiré et doit être rapprochée avant crédit client."
        )

    units = int(reservation.quantity or 0)
    allocation = ProviderTokenAllocation(
        inventory_id=inventory.id,
        tenant_id=reservation.tenant_id,
        reservation_id=reservation.id,
        idempotency_key=f"reservation:{reservation.id}",
        quantity=units,
        available_tokens=units,
        consumed_tokens=0,
        released_tokens=0,
        created_at=instant,
        updated_at=instant,
    )
    db.add(allocation)
    _append_balanced_event(
        db,
        inventory,
        event_type="reservation_finalized",
        idempotency_key=f"reservation-finalized:{reservation.id}",
        quantity=units,
        source_account=ACCOUNT_RESERVED,
        destination_account=ACCOUNT_ALLOCATED,
        tenant_id=str(reservation.tenant_id),
        reference_type="provider_token_reservation",
        reference_id=reservation.id,
    )
    reservation.status = "finalized"
    reservation.finalized_at = instant
    reservation.updated_at = instant
    inventory.reserved_tokens = int(inventory.reserved_tokens or 0) - units
    inventory.allocated_tokens = int(inventory.allocated_tokens or 0) + units
    inventory.updated_at = instant
    _assert_inventory_conservation(inventory)
    db.flush()
    return allocation


def _release_locked_reservation(
    db: Session,
    inventory: ProviderTokenInventory,
    reservation: ProviderTokenReservation,
    *,
    expired: bool,
    now: datetime,
) -> bool:
    if reservation.status in {"released", "expired"}:
        return False
    if reservation.status != "reserved":
        raise ProviderTokenReservationStateError("Une allocation finalisée ne peut pas être libérée.")
    units = int(reservation.quantity or 0)
    status = "expired" if expired else "released"
    _append_balanced_event(
        db,
        inventory,
        event_type=f"reservation_{status}",
        idempotency_key=f"reservation-{status}:{reservation.id}",
        quantity=units,
        source_account=ACCOUNT_RESERVED,
        destination_account=ACCOUNT_AVAILABLE,
        tenant_id=str(reservation.tenant_id),
        reference_type="provider_token_reservation",
        reference_id=reservation.id,
    )
    reservation.status = status
    reservation.released_at = now
    reservation.updated_at = now
    inventory.reserved_tokens = int(inventory.reserved_tokens or 0) - units
    inventory.available_tokens = int(inventory.available_tokens or 0) + units
    inventory.updated_at = now
    _assert_inventory_conservation(inventory)
    return True


def release_reservation(
    db: Session,
    *,
    reservation_id: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
) -> bool:
    inventory = _inventory_for_update(db, provider_slug)
    reservation = db.execute(
        select(ProviderTokenReservation)
        .where(
            ProviderTokenReservation.id == reservation_id,
            ProviderTokenReservation.inventory_id == inventory.id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if reservation is None:
        raise ProviderTokenReservationStateError("Réservation fournisseur introuvable.")
    applied = _release_locked_reservation(
        db,
        inventory,
        reservation,
        expired=False,
        now=_utcnow(),
    )
    db.flush()
    return applied


def expire_reservations(
    db: Session,
    *,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
    now: datetime | None = None,
    limit: int = 500,
) -> int:
    """Release expired holds in one caller-controlled transaction."""

    inventory = _inventory_for_update(db, provider_slug)
    instant = now or _utcnow()
    batch_size = max(1, min(int(limit), 5000))
    reservations = (
        db.execute(
            select(ProviderTokenReservation)
            .where(
                ProviderTokenReservation.inventory_id == inventory.id,
                ProviderTokenReservation.status == "reserved",
                ProviderTokenReservation.expires_at <= instant,
                ProviderTokenReservation.stripe_checkout_session_id.is_(None),
            )
            .order_by(ProviderTokenReservation.expires_at, ProviderTokenReservation.id)
            .limit(batch_size)
            .with_for_update()
        )
        .scalars()
        .all()
    )
    released = 0
    for reservation in reservations:
        if _release_locked_reservation(
            db,
            inventory,
            reservation,
            expired=True,
            now=instant,
        ):
            released += 1
    db.flush()
    return released


def consume_allocation(
    db: Session,
    *,
    allocation_id: str,
    quantity: int,
    idempotency_key: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
    reference_type: str | None = None,
    reference_id: str | None = None,
) -> ProviderTokenLedgerEvent:
    """Settle provider usage against one tenant allocation, without commit."""

    units = _positive_quantity(quantity)
    key = _normalise_key(idempotency_key, label="idempotency_key")
    inventory = _inventory_for_update(db, provider_slug)
    existing = _existing_event(db, str(inventory.id), key)
    if existing is not None:
        allocation = db.get(ProviderTokenAllocation, allocation_id)
        tenant_id = str(allocation.tenant_id) if allocation is not None else None
        _assert_replay_matches(
            existing,
            event_type="allocation_consumed",
            quantity=units,
            tenant_id=tenant_id,
            allocation_id=allocation_id,
            reversal_of_event_id=None,
            reference_type=reference_type,
            reference_id=reference_id,
        )
        return existing
    allocation = db.execute(
        select(ProviderTokenAllocation)
        .where(
            ProviderTokenAllocation.id == allocation_id,
            ProviderTokenAllocation.inventory_id == inventory.id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if allocation is None:
        raise ProviderTokenInventoryError("Allocation fournisseur introuvable.")
    remaining = int(allocation.available_tokens or 0)
    if units > remaining:
        raise InsufficientProviderTokens(requested=units, sellable=remaining)
    event, _applied = _append_balanced_event(
        db,
        inventory,
        event_type="allocation_consumed",
        idempotency_key=key,
        quantity=units,
        source_account=ACCOUNT_ALLOCATED,
        destination_account=ACCOUNT_CONSUMED,
        tenant_id=str(allocation.tenant_id),
        allocation_id=allocation.id,
        reference_type=reference_type,
        reference_id=reference_id,
    )
    _add_allocation_movement(
        db,
        event=event,
        allocation=allocation,
        movement_index=1,
        available_delta=-units,
        consumed_delta=units,
    )
    allocation.available_tokens = remaining - units
    allocation.consumed_tokens = int(allocation.consumed_tokens or 0) + units
    allocation.updated_at = _utcnow()
    inventory.allocated_tokens = int(inventory.allocated_tokens or 0) - units
    inventory.consumed_tokens = int(inventory.consumed_tokens or 0) + units
    inventory.updated_at = _utcnow()
    _assert_inventory_conservation(inventory)
    db.flush()
    return event


def refund_allocation(
    db: Session,
    *,
    allocation_id: str,
    quantity: int,
    idempotency_key: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
    reference_type: str | None = None,
    reference_id: str | None = None,
) -> ProviderTokenLedgerEvent:
    """Append a compensating entry for provider usage that was reversed."""

    units = _positive_quantity(quantity)
    key = _normalise_key(idempotency_key, label="idempotency_key")
    inventory = _inventory_for_update(db, provider_slug)
    existing = _existing_event(db, str(inventory.id), key)
    if existing is not None:
        allocation = db.get(ProviderTokenAllocation, allocation_id)
        tenant_id = str(allocation.tenant_id) if allocation is not None else None
        _assert_replay_matches(
            existing,
            event_type="allocation_refunded",
            quantity=units,
            tenant_id=tenant_id,
            allocation_id=allocation_id,
            reversal_of_event_id=None,
            reference_type=reference_type,
            reference_id=reference_id,
        )
        return existing
    allocation = db.execute(
        select(ProviderTokenAllocation)
        .where(
            ProviderTokenAllocation.id == allocation_id,
            ProviderTokenAllocation.inventory_id == inventory.id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if allocation is None:
        raise ProviderTokenInventoryError("Allocation fournisseur introuvable.")
    consumed = int(allocation.consumed_tokens or 0)
    if units > consumed:
        raise ProviderTokenInventoryError("Le remboursement dépasse les jetons consommés de l'allocation.")
    event, _applied = _append_balanced_event(
        db,
        inventory,
        event_type="allocation_refunded",
        idempotency_key=key,
        quantity=units,
        source_account=ACCOUNT_CONSUMED,
        destination_account=ACCOUNT_ALLOCATED,
        tenant_id=str(allocation.tenant_id),
        allocation_id=allocation.id,
        reference_type=reference_type,
        reference_id=reference_id,
    )
    _add_allocation_movement(
        db,
        event=event,
        allocation=allocation,
        movement_index=1,
        available_delta=units,
        consumed_delta=-units,
    )
    allocation.available_tokens = int(allocation.available_tokens or 0) + units
    allocation.consumed_tokens = consumed - units
    allocation.updated_at = _utcnow()
    inventory.allocated_tokens = int(inventory.allocated_tokens or 0) + units
    inventory.consumed_tokens = int(inventory.consumed_tokens or 0) - units
    inventory.updated_at = _utcnow()
    _assert_inventory_conservation(inventory)
    db.flush()
    return event


def release_allocation_tokens(
    db: Session,
    *,
    allocation_id: str,
    quantity: int,
    idempotency_key: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
    reference_type: str | None = None,
    reference_id: str | None = None,
) -> ProviderTokenLedgerEvent:
    """Return unused customer backing to sellable stock after a reversal.

    The caller must reduce the corresponding customer wallet in the same
    transaction. Consumed tokens cannot be released through this operation.
    """

    units = _positive_quantity(quantity)
    key = _normalise_key(idempotency_key, label="idempotency_key")
    inventory = _inventory_for_update(db, provider_slug)
    existing = _existing_event(db, str(inventory.id), key)
    if existing is not None:
        allocation = db.get(ProviderTokenAllocation, allocation_id)
        tenant_id = str(allocation.tenant_id) if allocation is not None else None
        _assert_replay_matches(
            existing,
            event_type="allocation_released",
            quantity=units,
            tenant_id=tenant_id,
            allocation_id=allocation_id,
            reversal_of_event_id=None,
            reference_type=reference_type,
            reference_id=reference_id,
        )
        return existing
    allocation = db.execute(
        select(ProviderTokenAllocation)
        .where(
            ProviderTokenAllocation.id == allocation_id,
            ProviderTokenAllocation.inventory_id == inventory.id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if allocation is None:
        raise ProviderTokenInventoryError("Allocation fournisseur introuvable.")
    available = int(allocation.available_tokens or 0)
    if units > available:
        raise ProviderTokenInventoryError("La libération dépasse les jetons non consommés de l'allocation.")
    event, _applied = _append_balanced_event(
        db,
        inventory,
        event_type="allocation_released",
        idempotency_key=key,
        quantity=units,
        source_account=ACCOUNT_ALLOCATED,
        destination_account=ACCOUNT_AVAILABLE,
        tenant_id=str(allocation.tenant_id),
        allocation_id=allocation.id,
        reference_type=reference_type,
        reference_id=reference_id,
    )
    _add_allocation_movement(
        db,
        event=event,
        allocation=allocation,
        movement_index=1,
        available_delta=-units,
        consumed_delta=0,
        released_delta=units,
    )
    allocation.available_tokens = available - units
    allocation.released_tokens = int(allocation.released_tokens or 0) + units
    allocation.updated_at = _utcnow()
    inventory.allocated_tokens = int(inventory.allocated_tokens or 0) - units
    inventory.available_tokens = int(inventory.available_tokens or 0) + units
    inventory.updated_at = _utcnow()
    _assert_inventory_conservation(inventory)
    db.flush()
    return event


def consume_tenant_allocations(
    db: Session,
    *,
    tenant_id: str,
    quantity: int,
    idempotency_key: str,
    reference_type: str,
    reference_id: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
) -> ProviderTokenLedgerEvent:
    """Consume tenant backing FIFO across as many allocations as necessary."""

    units = _positive_quantity(quantity)
    key = _normalise_key(idempotency_key, label="idempotency_key")
    ref_type = _normalise_key(reference_type, label="reference_type")
    ref_id = _normalise_key(reference_id, label="reference_id")
    inventory = _inventory_for_update(db, provider_slug)
    existing = _existing_event(db, str(inventory.id), key)
    if existing is not None:
        _assert_replay_matches(
            existing,
            event_type="tenant_allocations_consumed",
            quantity=units,
            tenant_id=tenant_id,
            allocation_id=None,
            reversal_of_event_id=None,
            reference_type=ref_type,
            reference_id=ref_id,
        )
        return existing

    allocations = (
        db.execute(
            select(ProviderTokenAllocation)
            .where(
                ProviderTokenAllocation.inventory_id == inventory.id,
                ProviderTokenAllocation.tenant_id == tenant_id,
                ProviderTokenAllocation.available_tokens > 0,
            )
            .order_by(ProviderTokenAllocation.created_at, ProviderTokenAllocation.id)
            .with_for_update()
        )
        .scalars()
        .all()
    )
    tenant_available = sum(int(allocation.available_tokens or 0) for allocation in allocations)
    if units > tenant_available:
        raise InsufficientProviderTokens(requested=units, sellable=tenant_available)

    event, _applied = _append_balanced_event(
        db,
        inventory,
        event_type="tenant_allocations_consumed",
        idempotency_key=key,
        quantity=units,
        source_account=ACCOUNT_ALLOCATED,
        destination_account=ACCOUNT_CONSUMED,
        tenant_id=tenant_id,
        reference_type=ref_type,
        reference_id=ref_id,
    )
    remaining = units
    movement_index = 1
    for allocation in allocations:
        if remaining <= 0:
            break
        available = int(allocation.available_tokens or 0)
        consumed_now = min(available, remaining)
        if consumed_now <= 0:
            continue
        _add_allocation_movement(
            db,
            event=event,
            allocation=allocation,
            movement_index=movement_index,
            available_delta=-consumed_now,
            consumed_delta=consumed_now,
        )
        allocation.available_tokens = available - consumed_now
        allocation.consumed_tokens = int(allocation.consumed_tokens or 0) + consumed_now
        allocation.updated_at = _utcnow()
        remaining -= consumed_now
        movement_index += 1

    if remaining != 0:
        raise ProviderTokenInventoryInconsistent("La ventilation FIFO de la consommation est incomplète.")
    inventory.allocated_tokens = int(inventory.allocated_tokens or 0) - units
    inventory.consumed_tokens = int(inventory.consumed_tokens or 0) + units
    inventory.updated_at = _utcnow()
    _assert_inventory_conservation(inventory)
    db.flush()
    return event


def refund_tenant_consumption(
    db: Session,
    *,
    tenant_id: str,
    quantity: int,
    original_reference_type: str,
    original_reference_id: str,
    idempotency_key: str,
    provider_slug: str = SEQINO_PROVIDER_SLUG,
    refund_reference_type: str | None = None,
    refund_reference_id: str | None = None,
) -> ProviderTokenLedgerEvent:
    """Refund a FIFO tenant consumption using its immutable allocation split."""

    units = _positive_quantity(quantity)
    key = _normalise_key(idempotency_key, label="idempotency_key")
    original_ref_type = _normalise_key(
        original_reference_type,
        label="original_reference_type",
    )
    original_ref_id = _normalise_key(
        original_reference_id,
        label="original_reference_id",
    )
    refund_ref_type = (
        _normalise_key(refund_reference_type, label="refund_reference_type")
        if refund_reference_type is not None
        else f"{original_ref_type}_refund"
    )
    refund_ref_id = (
        _normalise_key(refund_reference_id, label="refund_reference_id")
        if refund_reference_id is not None
        else original_ref_id
    )
    inventory = _inventory_for_update(db, provider_slug)
    original_events = (
        db.execute(
            select(ProviderTokenLedgerEvent)
            .where(
                ProviderTokenLedgerEvent.inventory_id == inventory.id,
                ProviderTokenLedgerEvent.tenant_id == tenant_id,
                ProviderTokenLedgerEvent.event_type == "tenant_allocations_consumed",
                ProviderTokenLedgerEvent.reference_type == original_ref_type,
                ProviderTokenLedgerEvent.reference_id == original_ref_id,
            )
            .with_for_update()
        )
        .scalars()
        .all()
    )
    if not original_events:
        raise ProviderTokenInventoryError("Consommation fournisseur d'origine introuvable.")
    if len(original_events) != 1:
        raise ProviderTokenInventoryInconsistent(
            "La référence d'origine correspond à plusieurs consommations fournisseur."
        )
    original_event = original_events[0]

    existing = _existing_event(db, str(inventory.id), key)
    if existing is not None:
        _assert_replay_matches(
            existing,
            event_type="tenant_consumption_refunded",
            quantity=units,
            tenant_id=tenant_id,
            allocation_id=None,
            reversal_of_event_id=str(original_event.id),
            reference_type=refund_ref_type,
            reference_id=refund_ref_id,
        )
        return existing

    already_refunded = int(
        db.execute(
            select(func.coalesce(func.sum(ProviderTokenLedgerEvent.quantity), 0)).where(
                ProviderTokenLedgerEvent.inventory_id == inventory.id,
                ProviderTokenLedgerEvent.reversal_of_event_id == original_event.id,
                ProviderTokenLedgerEvent.event_type == "tenant_consumption_refunded",
            )
        ).scalar_one()
        or 0
    )
    refundable = int(original_event.quantity or 0) - already_refunded
    if units > refundable:
        raise ProviderTokenInventoryError("Le remboursement dépasse la consommation fournisseur encore remboursable.")

    original_movements = (
        db.execute(
            select(ProviderTokenAllocationMovement)
            .where(ProviderTokenAllocationMovement.event_id == original_event.id)
            .order_by(ProviderTokenAllocationMovement.movement_index)
        )
        .scalars()
        .all()
    )
    if not original_movements:
        raise ProviderTokenInventoryInconsistent("La consommation fournisseur d'origine n'a pas de ventilation.")
    prior_rows = db.execute(
        select(
            ProviderTokenAllocationMovement.allocation_id,
            func.coalesce(func.sum(ProviderTokenAllocationMovement.available_delta), 0),
        )
        .join(
            ProviderTokenLedgerEvent,
            ProviderTokenLedgerEvent.id == ProviderTokenAllocationMovement.event_id,
        )
        .where(
            ProviderTokenLedgerEvent.inventory_id == inventory.id,
            ProviderTokenLedgerEvent.reversal_of_event_id == original_event.id,
            ProviderTokenLedgerEvent.event_type == "tenant_consumption_refunded",
        )
        .group_by(ProviderTokenAllocationMovement.allocation_id)
    ).all()
    prior_by_allocation = {str(allocation_id): int(refunded or 0) for allocation_id, refunded in prior_rows}
    allocation_ids = [str(movement.allocation_id) for movement in original_movements]
    allocations = (
        db.execute(
            select(ProviderTokenAllocation)
            .where(
                ProviderTokenAllocation.inventory_id == inventory.id,
                ProviderTokenAllocation.tenant_id == tenant_id,
                ProviderTokenAllocation.id.in_(allocation_ids),
            )
            .order_by(ProviderTokenAllocation.id)
            .with_for_update()
        )
        .scalars()
        .all()
    )
    allocation_by_id = {str(allocation.id): allocation for allocation in allocations}
    if len(allocation_by_id) != len(set(allocation_ids)):
        raise ProviderTokenInventoryInconsistent("Une allocation d'origine est introuvable.")

    event, _applied = _append_balanced_event(
        db,
        inventory,
        event_type="tenant_consumption_refunded",
        idempotency_key=key,
        quantity=units,
        source_account=ACCOUNT_CONSUMED,
        destination_account=ACCOUNT_ALLOCATED,
        tenant_id=tenant_id,
        reversal_of_event_id=str(original_event.id),
        reference_type=refund_ref_type,
        reference_id=refund_ref_id,
    )
    remaining = units
    movement_index = 1
    for original_movement in original_movements:
        if remaining <= 0:
            break
        allocation_id = str(original_movement.allocation_id)
        originally_consumed = max(int(original_movement.consumed_delta or 0), 0)
        refundable_on_allocation = max(
            originally_consumed - prior_by_allocation.get(allocation_id, 0),
            0,
        )
        refunded_now = min(refundable_on_allocation, remaining)
        if refunded_now <= 0:
            continue
        allocation = allocation_by_id[allocation_id]
        if refunded_now > int(allocation.consumed_tokens or 0):
            raise ProviderTokenInventoryInconsistent(
                "Une allocation ne contient plus assez de jetons consommés à rembourser."
            )
        _add_allocation_movement(
            db,
            event=event,
            allocation=allocation,
            movement_index=movement_index,
            available_delta=refunded_now,
            consumed_delta=-refunded_now,
        )
        allocation.available_tokens = int(allocation.available_tokens or 0) + refunded_now
        allocation.consumed_tokens = int(allocation.consumed_tokens or 0) - refunded_now
        allocation.updated_at = _utcnow()
        remaining -= refunded_now
        movement_index += 1

    if remaining != 0:
        raise ProviderTokenInventoryInconsistent("La ventilation FIFO du remboursement est incomplète.")
    inventory.allocated_tokens = int(inventory.allocated_tokens or 0) + units
    inventory.consumed_tokens = int(inventory.consumed_tokens or 0) - units
    inventory.updated_at = _utcnow()
    _assert_inventory_conservation(inventory)
    db.flush()
    return event
