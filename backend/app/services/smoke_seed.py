from __future__ import annotations

import secrets
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Membership,
    Numbering,
    PdpConnection,
    PdpMandate,
    QuoteNumbering,
    Tenant,
    TenantSettings,
    TokenLedger,
    TokenTopup,
    TokenWallet,
    User,
)
from ..utils.passwords import pwd
from .demo_seed import seed_tenant_demo_data
from .tokens import LEDGER_TYPE_WELCOME_BONUS, consume, get_token_state


@dataclass(frozen=True)
class SmokeTenantSpec:
    key: str
    tenant_name: str
    tenant_slug: str
    plan: str
    wallet_state: str
    identity_seed: int


@dataclass
class SmokeTenantResult:
    key: str
    tenant_id: str
    name: str
    slug: str
    plan: str
    subscription_status: str
    email: str
    password: str
    wallet_balance: int
    welcome_bonus_granted: bool
    connectors: dict[str, bool] = field(default_factory=dict)
    demo_counts: dict[str, int] = field(default_factory=dict)


@dataclass
class SmokeSeedResult:
    ok: bool
    password: str
    with_demo_data: bool
    with_connectors: bool
    connectors_seeded: bool
    connectors_skip_reason: str | None
    tenants: list[SmokeTenantResult] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_BASE_SCENARIOS: tuple[SmokeTenantSpec, ...] = (
    SmokeTenantSpec(
        key="starter",
        tenant_name="Smoke Starter",
        tenant_slug="smoke-starter",
        plan="starter",
        wallet_state="empty",
        identity_seed=552100000,
    ),
    SmokeTenantSpec(
        key="pro_bonus",
        tenant_name="Smoke Pro Bonus",
        tenant_slug="smoke-pro-bonus",
        plan="pro",
        wallet_state="welcome",
        identity_seed=732829000,
    ),
    SmokeTenantSpec(
        key="pro_empty",
        tenant_name="Smoke Pro Épuisé",
        tenant_slug="smoke-pro-empty",
        plan="pro",
        wallet_state="exhausted",
        identity_seed=784301000,
    ),
)

_CONNECTORS_SCENARIO = SmokeTenantSpec(
    key="pro_connectors",
    tenant_name="Smoke Pro Connecteurs",
    tenant_slug="smoke-pro-connectors",
    plan="pro",
    wallet_state="welcome",
    identity_seed=542065000,
)


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _default_password() -> str:
    return secrets.token_urlsafe(18)


def _email_for(key: str, email_domain: str) -> str:
    domain = (email_domain or "example.com").strip().lower() or "example.com"
    return _normalize_email(f"{key}.owner@{domain}")


def _luhn_valid(number: str) -> bool:
    digits = [int(char) for char in str(number) if char.isdigit()]
    checksum = 0
    parity = len(digits) % 2
    for index, digit in enumerate(digits):
        value = digit
        if index % 2 == parity:
            value *= 2
            if value > 9:
                value -= 9
        checksum += value
    return checksum % 10 == 0


def _valid_siren(seed: int) -> str:
    candidate = max(int(seed), 100_000_000)
    while candidate <= 999_999_999:
        text = f"{candidate:09d}"
        if _luhn_valid(text):
            return text
        candidate += 1
    raise RuntimeError("Impossible de générer un SIREN de test valide.")


def _valid_siret(siren: str, nic_seed: int = 1) -> str:
    nic = max(int(nic_seed), 1)
    while nic <= 99_999:
        siret = f"{siren}{nic:05d}"
        if _luhn_valid(siret):
            return siret
        nic += 1
    raise RuntimeError("Impossible de générer un SIRET de test valide.")


def _fr_vat_number(siren: str) -> str:
    siren_int = int(siren)
    key = (12 + 3 * (siren_int % 97)) % 97
    return f"FR{key:02d}{siren}"


def _identity_payload(spec: SmokeTenantSpec) -> dict[str, str]:
    siren = _valid_siren(spec.identity_seed)
    siret = _valid_siret(siren, nic_seed=(spec.identity_seed % 1000) + 1)
    return {
        "siren": siren,
        "siret": siret,
        "vat_number": _fr_vat_number(siren),
        "rcs": f"Paris B {siren}",
        "legal_form": "SARL",
        "share_capital": "10 000 EUR",
        "address_line1": "10 rue de la Démo",
        "postal_code": "75002",
        "city": "Paris",
        "country": "FR",
        "country_code": "FR",
        "address": "10 rue de la Démo\n75002 Paris\nFrance",
        "iban": "FR7630006000011234567890189",
        "bic": "AGRIFRPPXXX",
        "legal_mentions": f"{spec.tenant_name} — données de smoke test uniquement.",
        "late_payment_interest": "Taux legal en vigueur",
    }


def _ensure_tenant_settings(db: Session, tenant_id: str) -> None:
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if not settings_row:
        db.add(TenantSettings(tenant_id=tenant_id, preset="standard", onboarding_completed=True))
    else:
        settings_row.onboarding_completed = True
        db.add(settings_row)


def _ensure_numbering(db: Session, tenant_id: str) -> None:
    if not db.query(Numbering).filter(Numbering.tenant_id == tenant_id).first():
        db.add(Numbering(tenant_id=tenant_id, prefix="F-", last_index=0))
    if not db.query(QuoteNumbering).filter(QuoteNumbering.tenant_id == tenant_id).first():
        db.add(QuoteNumbering(tenant_id=tenant_id, prefix="D-", last_index=0))


def _ensure_owner_user(db: Session, *, tenant_id: str, email: str, password: str) -> User:
    user = db.query(User).filter(User.email == email).first()
    if user and user.tenant_id != tenant_id:
        raise RuntimeError(f"L'email {email} est déjà utilisé par un autre tenant.")
    if not user:
        user = User(
            tenant_id=tenant_id,
            email=email,
            password_hash=pwd.hash(password),
            role="owner",
            status="active",
            is_admin=False,
            is_platform_admin=False,
            is_support=False,
        )
        db.add(user)
        db.flush()
    else:
        user.tenant_id = tenant_id
        user.role = "owner"
        user.status = "active"
        user.password_hash = pwd.hash(password)
        user.is_admin = False
        user.is_platform_admin = False
        user.is_support = False
        db.add(user)
    membership = db.query(Membership).filter(Membership.user_id == user.id, Membership.tenant_id == tenant_id).first()
    if not membership:
        membership = Membership(user_id=user.id, tenant_id=tenant_id, role="owner")
    else:
        membership.role = "owner"
    db.add(membership)
    return user


def _ensure_tenant(db: Session, spec: SmokeTenantSpec) -> Tenant:
    tenant = db.query(Tenant).filter(Tenant.tenant_slug == spec.tenant_slug).first()
    identity = _identity_payload(spec)
    if not tenant:
        tenant = Tenant(
            name=spec.tenant_name,
            tenant_slug=spec.tenant_slug,
            plan=spec.plan,
            subscription_status="active",
            trial_end=None,
        )
        db.add(tenant)
        db.flush()
    tenant.name = spec.tenant_name
    tenant.plan = spec.plan
    tenant.subscription_status = "active"
    tenant.trial_end = None
    tenant.siret = identity["siret"]
    tenant.vat_number = identity["vat_number"]
    tenant.rcs = identity["rcs"]
    tenant.legal_form = identity["legal_form"]
    tenant.share_capital = identity["share_capital"]
    tenant.address_line1 = identity["address_line1"]
    tenant.postal_code = identity["postal_code"]
    tenant.city = identity["city"]
    tenant.country = identity["country"]
    tenant.country_code = identity["country_code"]
    tenant.address = identity["address"]
    tenant.iban = identity["iban"]
    tenant.bic = identity["bic"]
    tenant.legal_mentions = identity["legal_mentions"]
    tenant.late_payment_interest = identity["late_payment_interest"]
    db.add(tenant)
    _ensure_tenant_settings(db, tenant.id)
    _ensure_numbering(db, tenant.id)
    return tenant


def _reset_wallet_state(db: Session, tenant_id: str) -> None:
    db.query(TokenTopup).filter(TokenTopup.tenant_id == tenant_id).delete(synchronize_session=False)
    db.query(TokenLedger).filter(TokenLedger.tenant_id == tenant_id).delete(synchronize_session=False)
    db.query(TokenWallet).filter(TokenWallet.tenant_id == tenant_id).delete(synchronize_session=False)


def _reset_connector_state(db: Session, tenant_id: str) -> None:
    db.query(PdpMandate).filter(PdpMandate.tenant_id == tenant_id).delete(synchronize_session=False)
    db.query(PdpConnection).filter(PdpConnection.tenant_id == tenant_id).delete(synchronize_session=False)


def _seed_wallet_state(db: Session, spec: SmokeTenantSpec, tenant_id: str) -> dict[str, Any]:
    _reset_wallet_state(db, tenant_id)
    db.commit()
    if spec.plan != "pro":
        return get_token_state(db, tenant_id, history_limit=5)
    reference_id = f"smoke:{spec.tenant_slug}:welcome"
    # Smoke tenants are synthetic and must not create a fictitious supplier
    # purchase in the real Seqino inventory. Their wallet is deliberately
    # seeded as test data; connected calls remain fail-closed without backing.
    welcome_tokens = int(getattr(settings, "SEQINO_WELCOME_TOKENS_PRO", 0) or 0)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(
        TokenWallet(
            tenant_id=tenant_id,
            balance=welcome_tokens,
            welcome_bonus_granted_at=now,
        )
    )
    if welcome_tokens > 0:
        db.add(
            TokenLedger(
                tenant_id=tenant_id,
                delta=welcome_tokens,
                type=LEDGER_TYPE_WELCOME_BONUS,
                reference_type=LEDGER_TYPE_WELCOME_BONUS,
                reference_id=reference_id,
                created_at=now,
            )
        )
    db.commit()
    if spec.wallet_state == "exhausted":
        if welcome_tokens > 0:
            consume(
                db,
                tenant_id,
                welcome_tokens,
                "smoke_seed_usage",
                f"{spec.tenant_slug}:drain",
            )
    return get_token_state(db, tenant_id, history_limit=5)


def _server_seqino_ready() -> bool:
    if bool(getattr(settings, "SEQINO_DEMO_MODE", False)):
        return True
    base_url = (getattr(settings, "SEQINO_BASE_URL", "") or "").strip()
    sponsor_id = (getattr(settings, "SEQINO_SPONSOR_ID", "") or "").strip()
    access_token = (getattr(settings, "SEQINO_ACCESS_TOKEN", "") or "").strip()
    api_key = (getattr(settings, "SEQINO_API_KEY", "") or "").strip()
    return bool(base_url and sponsor_id and (access_token or api_key))


def _server_chorus_ready() -> bool:
    return all(
        (
            (getattr(settings, "PISTE_CLIENT_ID", "") or "").strip(),
            (getattr(settings, "PISTE_CLIENT_SECRET", "") or "").strip(),
            (getattr(settings, "PISTE_TOKEN_URL", "") or "").strip(),
            (getattr(settings, "CHORUS_API_BASE", "") or "").strip(),
        )
    )


def configured_connectors_available() -> tuple[bool, str | None]:
    missing: list[str] = []
    if not _server_seqino_ready():
        if not bool(getattr(settings, "SEQINO_DEMO_MODE", False)):
            missing.extend(["SEQINO_BASE_URL", "SEQINO_SPONSOR_ID", "SEQINO_ACCESS_TOKEN/SEQINO_API_KEY"])
        else:
            missing.append("SEQINO configuration")
    if not _server_chorus_ready():
        missing.extend(["PISTE_CLIENT_ID", "PISTE_CLIENT_SECRET", "PISTE_TOKEN_URL", "CHORUS_API_BASE"])
    if missing:
        return False, "Variables manquantes pour marquer Chorus/Seqino comme configurés: " + ", ".join(missing)
    return True, None


def _seed_configured_connectors(db: Session, tenant: Tenant) -> dict[str, bool]:
    _reset_connector_state(db, tenant.id)
    db.flush()
    seqino_conn = PdpConnection(
        tenant_id=tenant.id,
        provider_slug="seqino",
        auth_type="authToken",
        encrypted_credentials=None,
        status="connected",
    )
    chorus_conn = PdpConnection(
        tenant_id=tenant.id,
        provider_slug="chorus",
        auth_type="oauth2",
        encrypted_credentials=None,
        status="connected",
    )
    db.add(seqino_conn)
    db.add(chorus_conn)
    db.add(
        PdpMandate(
            tenant_id=tenant.id,
            provider_slug="seqino",
            mandate_id=f"smoke-mandate-{tenant.tenant_slug}",
            siren=(tenant.siret or "")[:9] or None,
            siret=tenant.siret,
            name=tenant.name,
            start_date=date.today(),
            status="ACTIVE",
            file_attachment={"filename": "smoke-mandate.pdf"},
        )
    )
    db.commit()
    return {"seqino": True, "chorus": True}


def seed_smoke_tenants(
    db: Session,
    *,
    reset: bool = False,
    include_demo_data: bool = False,
    with_connectors: bool = False,
    email_domain: str = "example.com",
    password: str | None = None,
) -> SmokeSeedResult:
    shared_password = (password or "").strip() or _default_password()
    result = SmokeSeedResult(
        ok=True,
        password=shared_password,
        with_demo_data=include_demo_data,
        with_connectors=with_connectors,
        connectors_seeded=False,
        connectors_skip_reason=None,
    )

    scenarios = list(_BASE_SCENARIOS)
    if with_connectors:
        ready, reason = configured_connectors_available()
        if ready:
            scenarios.append(_CONNECTORS_SCENARIO)
            result.connectors_seeded = True
        else:
            result.connectors_skip_reason = reason
            if reason:
                result.warnings.append(reason)

    for spec in scenarios:
        tenant = _ensure_tenant(db, spec)
        if reset:
            _reset_connector_state(db, tenant.id)
            db.commit()
        user = _ensure_owner_user(
            db,
            tenant_id=tenant.id,
            email=_email_for(spec.key, email_domain),
            password=shared_password,
        )
        db.commit()
        wallet_state = _seed_wallet_state(db, spec, tenant.id)

        connectors = {"seqino": False, "chorus": False}
        if spec.key == _CONNECTORS_SCENARIO.key and result.connectors_seeded:
            connectors = _seed_configured_connectors(db, tenant)

        demo_counts: dict[str, int] = {}
        if include_demo_data:
            demo_result = seed_tenant_demo_data(
                db,
                tenant=tenant,
                user=user,
                force=bool(reset),
                generate_artifacts=False,
            )
            demo_counts = {
                "customers": demo_result.counts.customers,
                "products": demo_result.counts.products,
                "quotes": demo_result.counts.quotes,
                "invoices": demo_result.counts.invoices,
                "payments": demo_result.counts.payments,
            }
            if demo_result.warnings:
                result.warnings.extend(demo_result.warnings)

        result.tenants.append(
            SmokeTenantResult(
                key=spec.key,
                tenant_id=tenant.id,
                name=tenant.name,
                slug=tenant.tenant_slug,
                plan=tenant.plan,
                subscription_status=tenant.subscription_status or "",
                email=user.email,
                password=shared_password,
                wallet_balance=int(wallet_state.get("balance", 0) or 0),
                welcome_bonus_granted=bool(wallet_state.get("welcome_bonus_granted")),
                connectors=connectors,
                demo_counts=demo_counts,
            )
        )

    return result
