from __future__ import annotations

import hashlib
import json
import logging
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import or_
from sqlalchemy.inspection import inspect as sa_inspect
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    ActionLog,
    Customer,
    Invoice,
    InvoiceLine,
    LegalAcceptance,
    Membership,
    Product,
    Quote,
    QuoteLine,
    QuoteNumbering,
    Tenant,
    TenantSettings,
    User,
)
from ..services.legal_acceptance import (
    DPA_ACCEPTOR_ROLES,
    build_acceptance_snapshot,
    normalize_tenant_role,
    resolve_required_docs,
)
from ..services.quote_proof import ensure_quote_sealed
from ..utils.money import calc_line_total, calc_tax_amount, quantize_amount, to_decimal


logger = logging.getLogger("demo.seed")


@dataclass(frozen=True)
class DemoProductPreset:
    name: str
    price: Decimal
    vat_rate: Decimal
    description: str


@dataclass(frozen=True)
class DemoCustomerPreset:
    name: str
    client_type: str
    email: str
    contact_name: str
    address_line1: str
    postal_code: str
    city: str
    country: str
    siren: str
    siret: str
    vat_number: str


@dataclass(frozen=True)
class DemoPreset:
    slug: str
    label: str
    description: str
    highlights: tuple[str, ...]
    operation_nature: str
    products: tuple[DemoProductPreset, DemoProductPreset, DemoProductPreset]
    customers: tuple[DemoCustomerPreset, DemoCustomerPreset, DemoCustomerPreset]


_DEMO_PRESETS: dict[str, DemoPreset] = {
    "services": DemoPreset(
        slug="services",
        label="Services B2B",
        description="Scenario conseil / abonnement / onboarding pour une PME de services.",
        highlights=("abonnement", "onboarding", "support premium"),
        operation_nature="services",
        products=(
            DemoProductPreset(
                name="Abonnement SaaS Pro",
                price=Decimal("59.00"),
                vat_rate=Decimal("20.00"),
                description="Abonnement mensuel - facturation electronique et pilotage conformite.",
            ),
            DemoProductPreset(
                name="Mise en service / Onboarding",
                price=Decimal("250.00"),
                vat_rate=Decimal("20.00"),
                description="Parametrage initial, import des tiers et formation.",
            ),
            DemoProductPreset(
                name="Support premium",
                price=Decimal("90.00"),
                vat_rate=Decimal("20.00"),
                description="Support prioritaire et accompagnement finance.",
            ),
        ),
        customers=(
            DemoCustomerPreset(
                name="ACME Industrie",
                client_type="business",
                email="facturation@acme.example",
                contact_name="Jean Dupont",
                address_line1="12 Avenue des Tests",
                postal_code="69002",
                city="Lyon",
                country="FR",
                siren="552100554",
                siret="55210055400013",
                vat_number="FR15552100554",
            ),
            DemoCustomerPreset(
                name="Beta Consulting",
                client_type="business",
                email="compta@beta.example",
                contact_name="Sarah Martin",
                address_line1="5 Rue des Factures",
                postal_code="33000",
                city="Bordeaux",
                country="FR",
                siren="799999999",
                siret="79999999900015",
                vat_number="FR92799999999",
            ),
            DemoCustomerPreset(
                name="Mairie de DemoVille",
                client_type="public_sector",
                email="chorus@demoville.example",
                contact_name="Service Finances",
                address_line1="1 Place de la Republique",
                postal_code="44000",
                city="Nantes",
                country="FR",
                siren="200000000",
                siret="20000000000019",
                vat_number="FR20200000000",
            ),
        ),
    ),
    "retail": DemoPreset(
        slug="retail",
        label="Retail",
        description="Scenario distribution / points de vente / commandes recurrentes.",
        highlights=("catalogue", "multi-sites", "biens"),
        operation_nature="goods",
        products=(
            DemoProductPreset(
                name="Licence caisse omnicanale",
                price=Decimal("79.00"),
                vat_rate=Decimal("20.00"),
                description="Licence mensuelle pour ventes boutique et e-commerce.",
            ),
            DemoProductPreset(
                name="Import catalogue produits",
                price=Decimal("180.00"),
                vat_rate=Decimal("20.00"),
                description="Chargement initial du catalogue et TVA par famille.",
            ),
            DemoProductPreset(
                name="Support reseau boutiques",
                price=Decimal("120.00"),
                vat_rate=Decimal("20.00"),
                description="Support prioritaire pour plusieurs points de vente.",
            ),
        ),
        customers=(
            DemoCustomerPreset(
                name="Boutique Horizon",
                client_type="business",
                email="compta@horizon.example",
                contact_name="Claire Petit",
                address_line1="8 Rue du Commerce",
                postal_code="59000",
                city="Lille",
                country="FR",
                siren="518200111",
                siret="51820011100027",
                vat_number="FR21518200111",
            ),
            DemoCustomerPreset(
                name="Maison Auguste",
                client_type="business",
                email="achats@auguste.example",
                contact_name="Thomas Leroy",
                address_line1="22 Rue des Halles",
                postal_code="31000",
                city="Toulouse",
                country="FR",
                siren="401765432",
                siret="40176543200031",
                vat_number="FR84401765432",
            ),
            DemoCustomerPreset(
                name="Collectivite de DemoMarches",
                client_type="public_sector",
                email="marches@demomarches.example",
                contact_name="Commande publique",
                address_line1="4 Place du Marche",
                postal_code="21000",
                city="Dijon",
                country="FR",
                siren="200100100",
                siret="20010010000018",
                vat_number="FR62200100100",
            ),
        ),
    ),
    "construction": DemoPreset(
        slug="construction",
        label="BTP",
        description="Scenario chantiers, situations de travaux et prestations mixtes.",
        highlights=("situations", "chantier", "biens et services"),
        operation_nature="mixed",
        products=(
            DemoProductPreset(
                name="Situation de travaux mensuelle",
                price=Decimal("1450.00"),
                vat_rate=Decimal("20.00"),
                description="Facturation d'avancement chantier avec retenue et suivi.",
            ),
            DemoProductPreset(
                name="Mobilisation chantier",
                price=Decimal("600.00"),
                vat_rate=Decimal("20.00"),
                description="Mise en route et coordination chantier.",
            ),
            DemoProductPreset(
                name="Assistance DOE",
                price=Decimal("320.00"),
                vat_rate=Decimal("20.00"),
                description="Dossier des ouvrages executes et support fin de chantier.",
            ),
        ),
        customers=(
            DemoCustomerPreset(
                name="BTP Horizon",
                client_type="business",
                email="gestion@btp-horizon.example",
                contact_name="Antoine Morel",
                address_line1="15 Rue du Chantier",
                postal_code="13002",
                city="Marseille",
                country="FR",
                siren="489120345",
                siret="48912034500029",
                vat_number="FR02489120345",
            ),
            DemoCustomerPreset(
                name="Promoteur Delta",
                client_type="business",
                email="compta@delta.example",
                contact_name="Lucie Bernard",
                address_line1="27 Boulevard des Travaux",
                postal_code="35000",
                city="Rennes",
                country="FR",
                siren="512340678",
                siret="51234067800016",
                vat_number="FR14512340678",
            ),
            DemoCustomerPreset(
                name="Ville de DemoChantier",
                client_type="public_sector",
                email="travaux@demochantier.example",
                contact_name="Direction patrimoine",
                address_line1="9 Place de l'Hotel de Ville",
                postal_code="76000",
                city="Rouen",
                country="FR",
                siren="217605757",
                siret="21760575700011",
                vat_number="FR46217605757",
            ),
        ),
    ),
    "public_sector": DemoPreset(
        slug="public_sector",
        label="Secteur public",
        description="Scenario B2G avec Chorus Pro, collectivites et achats publics.",
        highlights=("chorus pro", "collectivites", "b2g"),
        operation_nature="services",
        products=(
            DemoProductPreset(
                name="Abonnement collectivites",
                price=Decimal("89.00"),
                vat_rate=Decimal("20.00"),
                description="Pilotage facturation B2G et suivi des flux publics.",
            ),
            DemoProductPreset(
                name="Parametrage Chorus Pro",
                price=Decimal("300.00"),
                vat_rate=Decimal("20.00"),
                description="Configuration references engagements et flux B2G.",
            ),
            DemoProductPreset(
                name="Support marches publics",
                price=Decimal("140.00"),
                vat_rate=Decimal("20.00"),
                description="Accompagnement des equipes finance et commande publique.",
            ),
        ),
        customers=(
            DemoCustomerPreset(
                name="Mairie de DemoVille",
                client_type="public_sector",
                email="finances@demoville.example",
                contact_name="Service finances",
                address_line1="1 Place de la Republique",
                postal_code="44000",
                city="Nantes",
                country="FR",
                siren="200000000",
                siret="20000000000019",
                vat_number="FR20200000000",
            ),
            DemoCustomerPreset(
                name="CCAS DemoVille",
                client_type="public_sector",
                email="ccas@demoville.example",
                contact_name="Commande publique",
                address_line1="2 Rue de l'Action Sociale",
                postal_code="44000",
                city="Nantes",
                country="FR",
                siren="264400987",
                siret="26440098700017",
                vat_number="FR10264400987",
            ),
            DemoCustomerPreset(
                name="Hopital DemoNord",
                client_type="public_sector",
                email="marches@demonord.example",
                contact_name="Cellule achats",
                address_line1="18 Avenue de l'Hopital",
                postal_code="59000",
                city="Lille",
                country="FR",
                siren="265900123",
                siret="26590012300014",
                vat_number="FR88265900123",
            ),
        ),
    ),
    "health": DemoPreset(
        slug="health",
        label="Sante",
        description="Scenario cabinets, cliniques et prestataires sante avec forte traçabilite.",
        highlights=("cabinet", "traçabilite", "services sante"),
        operation_nature="services",
        products=(
            DemoProductPreset(
                name="Abonnement cabinet sante",
                price=Decimal("69.00"),
                vat_rate=Decimal("20.00"),
                description="Pilotage facturation et conformite pour structures sante.",
            ),
            DemoProductPreset(
                name="Parametrage flux administratifs",
                price=Decimal("260.00"),
                vat_rate=Decimal("20.00"),
                description="Mise en route, annuaire tiers et profils de facturation.",
            ),
            DemoProductPreset(
                name="Support administratif renforce",
                price=Decimal("110.00"),
                vat_rate=Decimal("20.00"),
                description="Accompagnement de la coordination administrative et comptable.",
            ),
        ),
        customers=(
            DemoCustomerPreset(
                name="Clinique DemoSante",
                client_type="business",
                email="facturation@demosante.example",
                contact_name="Julie Perrin",
                address_line1="3 Avenue des Soins",
                postal_code="34000",
                city="Montpellier",
                country="FR",
                siren="533210987",
                siret="53321098700024",
                vat_number="FR64533210987",
            ),
            DemoCustomerPreset(
                name="Cabinet Horizon Medical",
                client_type="business",
                email="admin@horizon-medical.example",
                contact_name="Dr Martin",
                address_line1="11 Rue des Practiciens",
                postal_code="67000",
                city="Strasbourg",
                country="FR",
                siren="478650321",
                siret="47865032100020",
                vat_number="FR93478650321",
            ),
            DemoCustomerPreset(
                name="Mutuelle DemoVie",
                client_type="business",
                email="gestion@demovie.example",
                contact_name="Pascale Robin",
                address_line1="6 Rue des Assures",
                postal_code="75008",
                city="Paris",
                country="FR",
                siren="350220789",
                siret="35022078900038",
                vat_number="FR19350220789",
            ),
        ),
    ),
}


@dataclass
class SeedCounts:
    customers: int = 0
    products: int = 0
    quotes: int = 0
    quote_lines: int = 0
    invoices: int = 0
    invoice_lines: int = 0
    payments: int = 0


@dataclass
class SeedResult:
    ok: bool
    seeded: bool
    message: str
    counts: SeedCounts
    warnings: list[str]
    created_ids: dict[str, list[str]]
    issued_invoice_ids: list[str]


def list_demo_presets() -> list[dict[str, Any]]:
    return [
        {
            "slug": preset.slug,
            "label": preset.label,
            "description": preset.description,
            "highlights": list(preset.highlights),
            "operation_nature": preset.operation_nature,
        }
        for preset in _DEMO_PRESETS.values()
    ]


def _resolve_demo_preset(preset: str | None) -> DemoPreset:
    normalized = (preset or "services").strip().lower() or "services"
    return _DEMO_PRESETS.get(normalized, _DEMO_PRESETS["services"])


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _ts_tag() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y%m%d%H%M%S")


def _demo_prefix() -> str:
    return "[DEMO]"


_SELF_SERVICE_PROOF_EXCLUDED_ACTIONS = frozenset(
    {"trial_expired", "trial_account_anonymized"}
)


def _proof_value(value: object) -> object:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return value.hex()
    return value


def _proof_row(model: object) -> dict[str, object]:
    mapper = sa_inspect(type(model))
    return {
        column.key: _proof_value(getattr(model, column.key))
        for column in mapper.columns
    }


def _self_service_demo_dataset_snapshot(db: Session, tenant_id: str) -> dict[str, list[dict[str, object]]]:
    direct_models = (
        ("customers", Customer),
        ("products", Product),
        ("quotes", Quote),
        ("invoices", Invoice),
        ("quote_numbering", QuoteNumbering),
    )
    snapshot: dict[str, list[dict[str, object]]] = {}
    for name, model in direct_models:
        rows = db.query(model).filter(model.tenant_id == tenant_id).all()
        snapshot[name] = sorted((_proof_row(row) for row in rows), key=lambda row: str(row.get("id") or ""))

    quote_lines = (
        db.query(QuoteLine)
        .join(Quote, Quote.id == QuoteLine.quote_id)
        .filter(Quote.tenant_id == tenant_id)
        .all()
    )
    invoice_lines = (
        db.query(InvoiceLine)
        .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
        .filter(Invoice.tenant_id == tenant_id)
        .all()
    )
    actions = (
        db.query(ActionLog)
        .filter(
            ActionLog.tenant_id == tenant_id,
            ActionLog.action.notin_(_SELF_SERVICE_PROOF_EXCLUDED_ACTIONS),
        )
        .all()
    )
    snapshot["quote_lines"] = sorted(
        (_proof_row(row) for row in quote_lines),
        key=lambda row: str(row.get("id") or ""),
    )
    snapshot["invoice_lines"] = sorted(
        (_proof_row(row) for row in invoice_lines),
        key=lambda row: str(row.get("id") or ""),
    )
    snapshot["actions"] = sorted(
        (_proof_row(row) for row in actions),
        key=lambda row: str(row.get("id") or ""),
    )
    return snapshot


def _self_service_demo_dataset_fingerprint(db: Session, tenant_id: str) -> tuple[str, dict[str, int]]:
    snapshot = _self_service_demo_dataset_snapshot(db, tenant_id)
    serialized = json.dumps(snapshot, ensure_ascii=True, sort_keys=True, separators=(",", ":"), default=str)
    counts = {name: len(rows) for name, rows in snapshot.items()}
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest(), counts


def _record_self_service_demo_seed_proof(
    db: Session,
    *,
    tenant_id: str,
    preset: str,
) -> None:
    settings_row = db.get(TenantSettings, tenant_id)
    if settings_row is None:
        return
    fingerprint, counts = _self_service_demo_dataset_fingerprint(db, tenant_id)
    features = dict(settings_row.features or {})
    features["demo_seed_proof"] = {
        "version": 1,
        "source": "self_service",
        "preset": preset,
        "generated_artifacts": False,
        "fingerprint": fingerprint,
        "counts": counts,
        "seeded_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
    }
    settings_row.features = features
    db.add(settings_row)
    db.commit()


def verify_self_service_demo_seed_proof(db: Session, tenant_id: str) -> tuple[bool, str]:
    """Verify that a self-service demo dataset is still byte-for-byte intact."""

    settings_row = db.get(TenantSettings, tenant_id)
    features = settings_row.features if settings_row and isinstance(settings_row.features, dict) else {}
    demo_request = features.get("demo_request") if isinstance(features, dict) else None
    proof = features.get("demo_seed_proof") if isinstance(features, dict) else None
    if not isinstance(demo_request, dict) or demo_request.get("status") != "seeded":
        return False, "demo_request_not_seeded"
    if not isinstance(proof, dict):
        return False, "demo_seed_proof_missing"
    if proof.get("version") != 1 or proof.get("source") != "self_service":
        return False, "demo_seed_proof_invalid"
    if proof.get("generated_artifacts") is not False:
        return False, "demo_seed_artifacts_not_safe"
    expected = str(proof.get("fingerprint") or "")
    if len(expected) != 64:
        return False, "demo_seed_fingerprint_invalid"
    current, counts = _self_service_demo_dataset_fingerprint(db, tenant_id)
    if current != expected or proof.get("counts") != counts:
        return False, "demo_seed_fingerprint_mismatch"
    return True, "intact"


def _apply_demo_tenant_defaults(tenant: Tenant, *, name: str) -> None:
    tenant.name = name
    tenant.plan = "pro"
    tenant.subscription_status = "active"
    tenant.trial_end = None
    tenant.country = "FR"
    tenant.country_code = "FR"
    tenant.siret = "55210055400013"
    tenant.rcs = "Paris B 552 100 554"
    tenant.legal_form = "SARL"
    tenant.share_capital = "10 000 EUR"
    tenant.address_line1 = "10 Rue de la Demo"
    tenant.postal_code = "75002"
    tenant.city = "Paris"
    tenant.address = "10 Rue de la Demo\n75002 Paris\nFrance"
    tenant.vat_number = "FR15552100554"
    tenant.iban = "FR7630006000011234567890189"
    tenant.bic = "AGRIFRPPXXX"
    tenant.quote_acceptance_mode = "otp"
    tenant.quote_terms_url = (settings.PUBLIC_BASE_URL or "").rstrip("/") + "/legal/terms"
    tenant.quote_terms_required = True
    tenant.legal_mentions = (
        "Societe de demonstration - donnees fictives.\n"
        "RCS Paris B 552 100 554 - TVA FR15552100554."
    )
    tenant.late_payment_interest = "Taux legal en vigueur"
    tenant.recovery_fee_eur = Decimal("40.00")
    tenant.discount_terms = "Neant"


def prepare_self_service_demo_tenant(
    db: Session,
    *,
    tenant: Tenant,
    trial_end: datetime | None = None,
) -> None:
    """Prepare a newly registered trial tenant for an isolated product demo.

    This reuses the realistic demo identity defaults but keeps the subscription
    as a trial, so a public demo signup does not create a fake paid account.
    """
    current_name = (tenant.name or "Entreprise Démo").strip() or "Entreprise Démo"
    _apply_demo_tenant_defaults(tenant, name=current_name)
    tenant.plan = "pro"
    tenant.subscription_status = "trialing"
    tenant.trial_end = trial_end
    db.add(tenant)
    _ensure_tenant_settings(db, tenant.id)


def _ensure_legal_acceptance(db: Session, tenant_id: str, user_id: str) -> None:
    # Best-effort: if acceptance isn't required, noop. Otherwise seed acceptances so that
    # demo flows (conversion devis -> facture, émission, etc.) do not get blocked.
    required = resolve_required_docs()
    if not required:
        return
    membership = (
        db.query(Membership)
        .filter(
            Membership.tenant_id == tenant_id,
            Membership.user_id == user_id,
        )
        .first()
    )
    accepted_role = normalize_tenant_role(membership.role if membership else None)
    if not accepted_role:
        tenant_user = (
            db.query(User)
            .filter(User.id == user_id, User.tenant_id == tenant_id)
            .first()
        )
        accepted_role = normalize_tenant_role(tenant_user.role if tenant_user else None)
    if not accepted_role:
        logger.warning(
            "demo_legal_acceptance_skipped_missing_tenant_role",
            extra={"tenant_id": tenant_id, "user_id": user_id},
        )
        return
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for doc in required:
        slug = (doc.get("slug") or "").strip()
        version = (doc.get("version") or "").strip()
        if not slug or not version:
            continue
        if slug == "dpa" and accepted_role not in DPA_ACCEPTOR_ROLES:
            logger.warning(
                "demo_legal_acceptance_skipped_unauthorized_dpa",
                extra={"tenant_id": tenant_id, "user_id": user_id},
            )
            continue
        snapshot = build_acceptance_snapshot(slug=slug, accepted_role=accepted_role)
        exists = (
            db.query(LegalAcceptance)
            .filter(
                LegalAcceptance.tenant_id == tenant_id,
                LegalAcceptance.user_id == user_id,
                LegalAcceptance.doc_slug == slug,
                LegalAcceptance.doc_version == version,
                LegalAcceptance.document_sha256 == snapshot["document_sha256"],
            )
            .first()
        )
        if exists:
            continue
        row = LegalAcceptance(
            tenant_id=tenant_id,
            user_id=user_id,
            doc_slug=slug,
            doc_version=version,
            **snapshot,
            accepted_at=now,
            ip="127.0.0.1",
            user_agent="demo-seed",
        )
        db.add(row)


def soft_reset_demo_identity(db: Session, *, tenant_slug: str, admin_email: str) -> None:
    """Soft reset a demo tenant/user so we can recreate them with the same slug/email.

    We *do not* attempt to delete all rows (FK graph is complex). Instead we:
    - rename the tenant slug and mark deleted_at
    - rename the user email (global unique) so the original email can be reused
    """
    tenant_slug_norm = (tenant_slug or "").strip().lower()
    admin_email_norm = _normalize_email(admin_email)
    if tenant_slug_norm:
        tenant = db.query(Tenant).filter(Tenant.tenant_slug == tenant_slug_norm).first()
        if tenant:
            tag = _ts_tag()
            tenant.tenant_slug = f"{tenant_slug_norm}-old-{tag}"
            tenant.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
            tenant.deleted_reason = "demo_reset"
            db.add(tenant)

    if admin_email_norm:
        user = db.query(User).filter(User.email == admin_email_norm).first()
        if user:
            tag = _ts_tag()
            user.email = f"deleted+{tag}-{admin_email_norm}"
            user.status = "disabled"
            db.add(user)


def ensure_demo_tenant_and_owner(
    db: Session,
    *,
    tenant_slug: str,
    tenant_name: str,
    admin_email: str,
    admin_password: str,
    reset: bool = False,
) -> tuple[Tenant, User]:
    slug = (tenant_slug or "demo").strip().lower() or "demo"
    name = (tenant_name or "Entreprise Démo").strip() or "Entreprise Démo"
    email = _normalize_email(admin_email or "demo@example.com")
    password = (admin_password or "").strip()

    if reset:
        soft_reset_demo_identity(db, tenant_slug=slug, admin_email=email)
        db.commit()

    tenant = db.query(Tenant).filter(Tenant.tenant_slug == slug).first()
    if tenant:
        _apply_demo_tenant_defaults(tenant, name=name)
        db.add(tenant)
        # If tenant exists but reset wasn't requested, keep it.
        user = db.query(User).filter(User.email == email).first()
        if not user:
            raise RuntimeError("Demo tenant exists but demo user missing.")
        _ensure_tenant_settings(db, tenant.id)
        _ensure_legal_acceptance(db, tenant.id, user.id)
        # Optionally reset password when explicitly provided (CLI convenience).
        if password:
            from ..utils.passwords import pwd
            user.password_hash = pwd.hash(password)
            db.add(user)
            db.commit()
            setattr(user, "_demo_password", password)
        return tenant, user

    from ..utils.passwords import pwd

    if not password:
        password = secrets.token_urlsafe(16)

    tenant = Tenant(tenant_slug=slug)
    _apply_demo_tenant_defaults(tenant, name=name)
    db.add(tenant)
    db.flush()

    # Ensure tenant settings exist (skip onboarding in demo).
    ts = TenantSettings(tenant_id=tenant.id, preset="standard", onboarding_completed=True)
    db.add(ts)

    user = User(
        tenant_id=tenant.id,
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

    membership = Membership(user_id=user.id, tenant_id=tenant.id, role="owner")
    db.add(membership)

    _ensure_legal_acceptance(db, tenant.id, user.id)

    db.commit()
    db.refresh(tenant)
    db.refresh(user)
    # Attach the generated password as a transient attribute for CLI printing.
    setattr(user, "_demo_password", password)
    return tenant, user


def _ensure_tenant_settings(db: Session, tenant_id: str) -> None:
    settings_row = db.query(TenantSettings).filter(TenantSettings.tenant_id == tenant_id).first()
    if not settings_row:
        db.add(TenantSettings(tenant_id=tenant_id, preset="standard", onboarding_completed=True))
        return
    settings_row.onboarding_completed = True
    db.add(settings_row)


def _find_existing_seed(db: Session, tenant_id: str) -> bool:
    prefix = _demo_prefix()
    return (
        db.query(Customer)
        .filter(Customer.tenant_id == tenant_id, Customer.name.ilike(f"{prefix}%"))
        .first()
        is not None
    )


def _current_seed_counts(db: Session, tenant_id: str) -> SeedCounts:
    prefix = _demo_prefix()
    counts = SeedCounts()
    counts.customers = (
        db.query(Customer)
        .filter(Customer.tenant_id == tenant_id, Customer.name.ilike(f"{prefix}%"))
        .count()
    )
    counts.products = (
        db.query(Product)
        .filter(Product.tenant_id == tenant_id, Product.name.ilike(f"{prefix}%"))
        .count()
    )
    if counts.customers:
        customer_ids = [
            row[0]
            for row in db.query(Customer.id)
            .filter(Customer.tenant_id == tenant_id, Customer.name.ilike(f"{prefix}%"))
            .all()
        ]
        counts.quotes = (
            db.query(Quote)
            .filter(Quote.tenant_id == tenant_id, Quote.customer_id.in_(customer_ids))
            .count()
        )
        counts.invoices = (
            db.query(Invoice)
            .filter(Invoice.tenant_id == tenant_id, Invoice.customer_id.in_(customer_ids))
            .count()
        )
    return counts


def purge_tenant_demo_data(
    db: Session,
    tenant_id: str,
    *,
    commit: bool = True,
    purge_numbering: bool = False,
) -> dict[str, int]:
    """Delete previously seeded demo data for a tenant (best-effort).

    Scope: objects linked to demo customers/products (prefix [DEMO]).
    This avoids wiping legitimate data if a tenant contains real customers.
    """
    from ..models import (
        BillableEvent,
        EInvoicingEvent,
        EInvoicingTransmission,
        EInvoiceTransmission,
        EmailEvent,
        Invoice,
        InvoiceArtifact,
        InvoiceLine,
        Payment,
        Submission,
        TransmissionEvent,
    )


    prefix = _demo_prefix()
    stats: dict[str, int] = {
        "customers": 0,
        "products": 0,
        "quotes": 0,
        "quote_numbering": 0,
        "invoices": 0,
        "invoice_artifacts": 0,
        "invoice_lines": 0,
        "payments": 0,
        "emails": 0,
        "einvoicing_events": 0,
        "einvoicing_transmissions": 0,
        "partner_transmissions": 0,
        "submissions": 0,
    }

    demo_customers = (
        db.query(Customer)
        .filter(Customer.tenant_id == tenant_id, Customer.name.ilike(f"{prefix}%"))
        .all()
    )
    customer_ids = [c.id for c in demo_customers]

    demo_products = (
        db.query(Product)
        .filter(Product.tenant_id == tenant_id, Product.name.ilike(f"{prefix}%"))
        .all()
    )
    product_ids = [p.id for p in demo_products]

    if not customer_ids and not product_ids:
        return stats

    # Preload dependent document ids so we can clear email events before deletes.
    quote_ids: list[str] = []
    if customer_ids:
        quote_ids = [
            q.id
            for q in db.query(Quote.id)
            .filter(Quote.tenant_id == tenant_id, Quote.customer_id.in_(customer_ids))
            .all()
        ]
    invoice_ids: list[str] = []
    if customer_ids:
        invoice_ids = [
            i.id
            for i in db.query(Invoice.id)
            .filter(Invoice.tenant_id == tenant_id, Invoice.customer_id.in_(customer_ids))
            .all()
        ]

    if quote_ids or invoice_ids:
        email_filters = []
        if invoice_ids:
            email_filters.append(EmailEvent.invoice_id.in_(invoice_ids))
        if quote_ids:
            email_filters.append(EmailEvent.quote_id.in_(quote_ids))
        stats["emails"] += int(
            db.query(EmailEvent)
            .filter(or_(*email_filters))
            .delete(synchronize_session=False)
            or 0
        )

    # Quotes first (quotes can FK invoices via quote.invoice_id).
    if quote_ids:
        db.query(QuoteLine).filter(QuoteLine.quote_id.in_(quote_ids)).delete(synchronize_session=False)
        stats["quotes"] += int(
            db.query(Quote).filter(Quote.id.in_(quote_ids)).delete(synchronize_session=False) or 0
        )
    if purge_numbering:
        stats["quote_numbering"] += int(
            db.query(QuoteNumbering)
            .filter(QuoteNumbering.tenant_id == tenant_id)
            .delete(synchronize_session=False)
            or 0
        )

    # Invoices (children first)
    if invoice_ids:
        stats["invoice_artifacts"] += int(
            db.query(InvoiceArtifact)
            .filter(InvoiceArtifact.tenant_id == tenant_id, InvoiceArtifact.invoice_id.in_(invoice_ids))
            .delete(synchronize_session=False)
            or 0
        )

        stats["payments"] += int(
            db.query(Payment).filter(Payment.invoice_id.in_(invoice_ids)).delete(synchronize_session=False) or 0
        )

        stats["invoice_lines"] += int(
            db.query(InvoiceLine).filter(InvoiceLine.invoice_id.in_(invoice_ids)).delete(synchronize_session=False) or 0
        )

        stats["submissions"] += int(
            db.query(Submission).filter(Submission.invoice_id.in_(invoice_ids)).delete(synchronize_session=False) or 0
        )

        stats["partner_transmissions"] += int(
            db.query(EInvoiceTransmission)
            .filter(EInvoiceTransmission.invoice_id.in_(invoice_ids))
            .delete(synchronize_session=False)
            or 0
        )

        transmission_ids = [
            t.id
            for t in db.query(EInvoicingTransmission.id)
            .filter(EInvoicingTransmission.invoice_id.in_(invoice_ids))
            .all()
        ]
        if transmission_ids:
            db.query(TransmissionEvent).filter(TransmissionEvent.transmission_id.in_(transmission_ids)).delete(
                synchronize_session=False
            )
            stats["einvoicing_events"] += int(
                db.query(EInvoicingEvent)
                .filter(EInvoicingEvent.transmission_id.in_(transmission_ids))
                .delete(synchronize_session=False)
                or 0
            )
            stats["einvoicing_transmissions"] += int(
                db.query(EInvoicingTransmission)
                .filter(EInvoicingTransmission.id.in_(transmission_ids))
                .delete(synchronize_session=False)
                or 0
            )

        db.query(BillableEvent).filter(
            BillableEvent.tenant_id == tenant_id, BillableEvent.invoice_id.in_(invoice_ids)
        ).delete(synchronize_session=False)

        stats["invoices"] += int(
            db.query(Invoice).filter(Invoice.id.in_(invoice_ids)).delete(synchronize_session=False) or 0
        )

    # Customers + Products last
    if customer_ids:
        stats["customers"] += int(
            db.query(Customer).filter(Customer.id.in_(customer_ids)).delete(synchronize_session=False) or 0
        )
    if product_ids:
        stats["products"] += int(
            db.query(Product).filter(Product.id.in_(product_ids)).delete(synchronize_session=False) or 0
        )

    if commit:
        db.commit()
    else:
        db.flush()
    return stats



def _mk_product(db: Session, tenant_id: str, name: str, price: Decimal, vat_rate: Decimal, description: str) -> Product:
    p = Product(
        tenant_id=tenant_id,
        name=name,
        description=description,
        unit_price=price,
        vat_rate=vat_rate,
        unit_code="C62",
        active=True,
    )
    db.add(p)
    db.flush()
    return p


def _mk_customer(db: Session, tenant_id: str, **kwargs: Any) -> Customer:
    c = Customer(tenant_id=tenant_id, **kwargs)
    db.add(c)
    db.flush()
    return c


def seed_tenant_demo_data(
    db: Session,
    *,
    tenant: Tenant,
    user: User,
    force: bool = False,
    generate_artifacts: bool = True,
    preset: str | None = None,
) -> SeedResult:
    """Seed fake-but-realistic B2B data for demos inside an existing tenant.

    - Idempotent by default (does nothing if demo data already exists).
    - Can be used in staging environments to prepare a tenant for sales demos.
    """
    warnings: list[str] = []
    created_ids: dict[str, list[str]] = {"customers": [], "products": [], "quotes": [], "invoices": []}
    counts = SeedCounts()
    demo_preset = _resolve_demo_preset(preset)
    settings_at_start = db.get(TenantSettings, tenant.id)
    features_at_start = (
        settings_at_start.features
        if settings_at_start and isinstance(settings_at_start.features, dict)
        else {}
    )
    demo_request_at_start = features_at_start.get("demo_request")
    self_service_proof_requested = bool(
        not generate_artifacts
        and isinstance(demo_request_at_start, dict)
        and demo_request_at_start.get("status") == "pending"
        and str(demo_request_at_start.get("preset") or "services").strip().lower() == demo_preset.slug
    )

    already_seeded = _find_existing_seed(db, tenant.id)
    if already_seeded and not force:
        return SeedResult(
            ok=True,
            seeded=False,
            message=f"Données de démo déjà présentes ({demo_preset.label}, aucune action).",
            counts=counts,
            warnings=warnings,
            created_ids=created_ids,
            issued_invoice_ids=[],
        )
    if already_seeded and force:
        try:
            purge_stats = purge_tenant_demo_data(db, tenant.id)
            warnings.append(f"Données de démo existantes supprimées: {purge_stats}")
        except Exception as exc:
            db.rollback()
            warnings.append(f"Nettoyage des données de démo échoué (best-effort): {exc}")
            existing_counts = _current_seed_counts(db, tenant.id)
            if any(
                (
                    existing_counts.customers,
                    existing_counts.products,
                    existing_counts.quotes,
                    existing_counts.invoices,
                )
            ):
                return SeedResult(
                    ok=True,
                    seeded=False,
                    message=f"Données de démo déjà présentes ({demo_preset.label}, réutilisées après échec du nettoyage).",
                    counts=existing_counts,
                    warnings=warnings,
                    created_ids=created_ids,
                    issued_invoice_ids=[],
                )

    _ensure_legal_acceptance(db, tenant.id, user.id)
    db.commit()

    prefix = _demo_prefix()
    # ---- Products ----
    product_preset_1, product_preset_2, product_preset_3 = demo_preset.products
    p1 = _mk_product(
        db,
        tenant.id,
        f"{prefix} {product_preset_1.name}",
        product_preset_1.price,
        product_preset_1.vat_rate,
        product_preset_1.description,
    )
    p2 = _mk_product(
        db,
        tenant.id,
        f"{prefix} {product_preset_2.name}",
        product_preset_2.price,
        product_preset_2.vat_rate,
        product_preset_2.description,
    )
    p3 = _mk_product(
        db,
        tenant.id,
        f"{prefix} {product_preset_3.name}",
        product_preset_3.price,
        product_preset_3.vat_rate,
        product_preset_3.description,
    )
    counts.products += 3
    created_ids["products"].extend([p1.id, p2.id, p3.id])

    # ---- Customers ----
    customer_1, customer_2, customer_3 = demo_preset.customers
    c1 = _mk_customer(
        db,
        tenant.id,
        name=f"{prefix} {customer_1.name}",
        client_type=customer_1.client_type,
        email=customer_1.email,
        contact_name=customer_1.contact_name,
        address_line1=customer_1.address_line1,
        postal_code=customer_1.postal_code,
        city=customer_1.city,
        country=customer_1.country,
        siren=customer_1.siren,
        siret=customer_1.siret,
        vat_number=customer_1.vat_number,
    )
    c2 = _mk_customer(
        db,
        tenant.id,
        name=f"{prefix} {customer_2.name}",
        client_type=customer_2.client_type,
        email=customer_2.email,
        contact_name=customer_2.contact_name,
        address_line1=customer_2.address_line1,
        postal_code=customer_2.postal_code,
        city=customer_2.city,
        country=customer_2.country,
        siren=customer_2.siren,
        siret=customer_2.siret,
        vat_number=customer_2.vat_number,
    )
    c3 = _mk_customer(
        db,
        tenant.id,
        name=f"{prefix} {customer_3.name}",
        client_type=customer_3.client_type,
        email=customer_3.email,
        contact_name=customer_3.contact_name,
        address_line1=customer_3.address_line1,
        postal_code=customer_3.postal_code,
        city=customer_3.city,
        country=customer_3.country,
        siren=customer_3.siren,
        siret=customer_3.siret,
        vat_number=customer_3.vat_number,
    )
    counts.customers += 3
    created_ids["customers"].extend([c1.id, c2.id, c3.id])

    # ---- Quotes ----
    # We reuse router helpers for numbering to match the app behavior.
    from ..routers import quotes as quotes_router

    def quote_totals(lines: list[QuoteLine]) -> tuple[Decimal, Decimal, Decimal]:
        total_ex = Decimal("0")
        total_vat = Decimal("0")
        for line in lines:
            line_total = (
                to_decimal(line.line_total)
                if line.line_total is not None
                else calc_line_total(line.quantity or 0, line.unit_price or 0)
            )
            total_ex += line_total
            total_vat += calc_tax_amount(line_total, to_decimal(line.vat_rate or 0))
        total_ex = quantize_amount(total_ex)
        total_vat = quantize_amount(total_vat)
        return total_ex, total_vat, quantize_amount(total_ex + total_vat)

    now = datetime.now(timezone.utc).replace(tzinfo=None)

    q1 = Quote(
        tenant_id=tenant.id,
        customer_id=c1.id,
        number=quotes_router._next_quote_number(db, tenant.id, year=now.year),
        currency="EUR",
        status="draft",
        issue_date=now - timedelta(days=1),
        valid_until=date.today() + timedelta(days=15),
        payment_terms="30 jours fin de mois",
        note=f"Devis de démonstration {demo_preset.label.lower()} (modifiable).",
        created_by=user.id,
    )
    db.add(q1)
    db.flush()

    q1l1 = QuoteLine(
        quote_id=q1.id,
        product_name=p1.name,
        quantity=Decimal("1"),
        unit_price=p1.unit_price,
        line_total=calc_line_total(Decimal("1"), p1.unit_price),
        vat_rate=p1.vat_rate,
        vat_category="S",
        unit_code=p1.unit_code,
        item_id=p1.id,
    )
    q1l2 = QuoteLine(
        quote_id=q1.id,
        product_name=p2.name,
        quantity=Decimal("1"),
        unit_price=p2.unit_price,
        line_total=calc_line_total(Decimal("1"), p2.unit_price),
        vat_rate=p2.vat_rate,
        vat_category="S",
        unit_code=p2.unit_code,
        item_id=p2.id,
    )
    db.add_all([q1l1, q1l2])
    db.flush()
    ex, vat, ttc = quote_totals([q1l1, q1l2])
    q1.total_ex_vat = ex
    q1.total_vat = vat
    q1.total_inc_vat = ttc
    db.add(q1)

    q2 = Quote(
        tenant_id=tenant.id,
        customer_id=c2.id,
        number=quotes_router._next_quote_number(db, tenant.id, year=now.year),
        currency="EUR",
        status="sent",
        issue_date=now - timedelta(days=4),
        valid_until=date.today() + timedelta(days=10),
        payment_terms="30 jours",
        note=f"Devis {demo_preset.label.lower()} envoyé (portail client activé).",
        sent_at=now - timedelta(days=3),
        public_enabled=True,
        public_token=secrets.token_urlsafe(16),
        public_created_at=now - timedelta(days=3),
        public_view_count=2,
        public_first_viewed_at=now - timedelta(days=2),
        public_last_viewed_at=now - timedelta(days=1),
        created_by=user.id,
    )
    db.add(q2)
    db.flush()
    q2l1 = QuoteLine(
        quote_id=q2.id,
        product_name=p1.name,
        quantity=Decimal("3"),
        unit_price=p1.unit_price,
        line_total=calc_line_total(Decimal("3"), p1.unit_price),
        vat_rate=p1.vat_rate,
        vat_category="S",
        unit_code=p1.unit_code,
        item_id=p1.id,
    )
    db.add(q2l1)
    db.flush()
    ex, vat, ttc = quote_totals([q2l1])
    q2.total_ex_vat = ex
    q2.total_vat = vat
    q2.total_inc_vat = ttc
    ensure_quote_sealed(db, q2)
    db.add(q2)

    q3 = Quote(
        tenant_id=tenant.id,
        customer_id=c1.id,
        number=quotes_router._next_quote_number(db, tenant.id, year=now.year),
        currency="EUR",
        status="accepted",
        issue_date=now - timedelta(days=10),
        valid_until=date.today() + timedelta(days=5),
        payment_terms="30 jours",
        note=f"Devis {demo_preset.label.lower()} accepté (acceptation OTP + scellé).",
        sent_at=now - timedelta(days=9),
        accepted_at=now - timedelta(days=8),
        accepted_name="Jean Dupont",
        accepted_email="jean.dupont@acme.example",
        accepted_ip="127.0.0.1",
        accepted_user_agent="demo-seed",
        accepted_terms_url=tenant.quote_terms_url,
        accepted_terms_at=now - timedelta(days=9, hours=2),
        public_enabled=True,
        public_token=secrets.token_urlsafe(16),
        public_created_at=now - timedelta(days=9),
        public_view_count=4,
        public_first_viewed_at=now - timedelta(days=9),
        public_last_viewed_at=now - timedelta(days=8),
        created_by=user.id,
    )
    db.add(q3)
    db.flush()
    q3l1 = QuoteLine(
        quote_id=q3.id,
        product_name=p1.name,
        quantity=Decimal("12"),
        unit_price=p1.unit_price,
        line_total=calc_line_total(Decimal("12"), p1.unit_price),
        vat_rate=p1.vat_rate,
        vat_category="S",
        unit_code=p1.unit_code,
        item_id=p1.id,
    )
    q3l2 = QuoteLine(
        quote_id=q3.id,
        product_name=p3.name,
        quantity=Decimal("6"),
        unit_price=p3.unit_price,
        line_total=calc_line_total(Decimal("6"), p3.unit_price),
        vat_rate=p3.vat_rate,
        vat_category="S",
        unit_code=p3.unit_code,
        item_id=p3.id,
    )
    db.add_all([q3l1, q3l2])
    db.flush()
    ex, vat, ttc = quote_totals([q3l1, q3l2])
    q3.total_ex_vat = ex
    q3.total_vat = vat
    q3.total_inc_vat = ttc
    ensure_quote_sealed(db, q3)
    db.add(q3)

    counts.quotes += 3
    counts.quote_lines += 5
    created_ids["quotes"].extend([q1.id, q2.id, q3.id])

    db.commit()

    # ---- Convert accepted quote to invoice ----
    issued_invoice_ids: list[str] = []
    converted_invoice_id: str | None = None
    try:
        from ..deps import AuthUser
        from ..routers import quotes as quotes_router

        auth_user = AuthUser(
            id=user.id,
            email=user.email,
            tenant_id=tenant.id,
            role="owner",
            is_admin=False,
            is_support=False,
            mfa_enabled=False,
            scopes=set(),
            is_api_key=False,
        )
        payload = quotes_router.convert_quote_to_invoice(q3.id, db=db, user=auth_user)
        invoice_id = payload.get("invoice_id") if isinstance(payload, dict) else None
        if invoice_id:
            converted_invoice = db.get(Invoice, invoice_id)
            if converted_invoice:
                converted_invoice.operation_nature = demo_preset.operation_nature
                db.add(converted_invoice)
                db.flush()
            created_ids["invoices"].append(invoice_id)
            counts.invoices += 1
            converted_invoice_id = invoice_id
    except Exception as exc:
        warnings.append(f"Conversion devis->facture non réalisée: {exc}")

    # ---- Standalone invoices ----
    # Create 2 invoices (one draft, one paid) to showcase lifecycle.
    from ..models import InvoiceLine, Payment

    def inv_totals(lines: list[InvoiceLine]) -> tuple[Decimal, Decimal, Decimal]:
        total_ex = Decimal("0")
        total_vat = Decimal("0")
        for line in lines:
            line_total = (
                to_decimal(line.line_total)
                if line.line_total is not None
                else calc_line_total(line.quantity or 0, line.unit_price or 0)
            )
            total_ex += line_total
            total_vat += calc_tax_amount(line_total, to_decimal(line.vat_rate or 0))
        total_ex = quantize_amount(total_ex)
        total_vat = quantize_amount(total_vat)
        return total_ex, total_vat, quantize_amount(total_ex + total_vat)

    inv_draft = Invoice(
        tenant_id=tenant.id,
        customer_id=c3.id,
        currency="EUR",
        status="draft",
        issue_date=now,
        due_days=30,
        payment_terms="30 jours",
        operation_nature=demo_preset.operation_nature,
        note=f"{prefix} Exemple facture brouillon {demo_preset.label.lower()} (modifiable).",
        created_by=user.id,
    )
    db.add(inv_draft)
    db.flush()
    il1 = InvoiceLine(
        invoice_id=inv_draft.id,
        product_name=p2.name,
        quantity=Decimal("1"),
        unit_price=p2.unit_price,
        line_total=calc_line_total(Decimal("1"), p2.unit_price),
        vat_rate=p2.vat_rate,
        vat_category="S",
        unit_code=p2.unit_code,
        item_id=p2.id,
    )
    db.add(il1)
    db.flush()
    ex, vat, ttc = inv_totals([il1])
    inv_draft.total_ex_vat = ex
    inv_draft.total_vat = vat
    inv_draft.total_inc_vat = ttc
    db.add(inv_draft)

    inv_paid = Invoice(
        tenant_id=tenant.id,
        customer_id=c1.id,
        currency="EUR",
        status="draft",
        issue_date=now - timedelta(days=20),
        due_days=30,
        payment_terms="30 jours",
        operation_nature=demo_preset.operation_nature,
        note=f"{prefix} Exemple facture payée {demo_preset.label.lower()}.",
        created_by=user.id,
    )
    db.add(inv_paid)
    db.flush()
    il2 = InvoiceLine(
        invoice_id=inv_paid.id,
        product_name=p1.name,
        quantity=Decimal("6"),
        unit_price=p1.unit_price,
        line_total=calc_line_total(Decimal("6"), p1.unit_price),
        vat_rate=p1.vat_rate,
        vat_category="S",
        unit_code=p1.unit_code,
        item_id=p1.id,
    )
    il3 = InvoiceLine(
        invoice_id=inv_paid.id,
        product_name=p3.name,
        quantity=Decimal("2"),
        unit_price=p3.unit_price,
        line_total=calc_line_total(Decimal("2"), p3.unit_price),
        vat_rate=p3.vat_rate,
        vat_category="S",
        unit_code=p3.unit_code,
        item_id=p3.id,
    )
    db.add_all([il2, il3])
    db.flush()
    ex, vat, ttc = inv_totals([il2, il3])
    inv_paid.total_ex_vat = ex
    inv_paid.total_vat = vat
    inv_paid.total_inc_vat = ttc
    db.add(inv_paid)

    db.commit()
    created_ids["invoices"].extend([inv_draft.id, inv_paid.id])
    counts.invoices += 2
    counts.invoice_lines += 3

    # Issue + pay the paid invoice (best effort) so that PDF/Factur-X is ready.
    if generate_artifacts:
        try:
            from ..services.invoices.issue import issue_invoice_job

            result = issue_invoice_job(inv_paid.id, tenant.id, user.id)
            if isinstance(result, dict) and not result.get("ok", True):
                warnings.append(f"Émission facture démo échouée: {result.get('error')}")
            else:
                issued_invoice_ids.append(inv_paid.id)
            # Mark as paid with a payment entry in current session.
            payment = Payment(
                invoice_id=inv_paid.id,
                amount=float(inv_paid.total_inc_vat or 0),
                method="wire",
                reference="VIR-DEMO-0001",
                date=now - timedelta(days=15),
                created_by=user.id,
            )
            db.add(payment)
            counts.payments += 1
            counts.invoice_lines += 0
            # Update invoice status in current session.
            inv_paid_db = db.get(Invoice, inv_paid.id)
            if inv_paid_db:
                inv_paid_db.paid_at = payment.date
                inv_paid_db.status = "paid"
                inv_paid_db.sent_at = inv_paid_db.sent_at or (now - timedelta(days=19))
                db.add(inv_paid_db)
            # Optionally issue the invoice generated from the accepted quote.
            if converted_invoice_id:
                try:
                    r2 = issue_invoice_job(converted_invoice_id, tenant.id, user.id)
                    if isinstance(r2, dict) and not r2.get("ok", True):
                        warnings.append(f"Émission facture depuis devis échouée: {r2.get('error')}")
                    else:
                        issued_invoice_ids.append(converted_invoice_id)
                        inv2 = db.get(Invoice, converted_invoice_id)
                        if inv2:
                            try:
                                db.refresh(inv2)
                            except Exception:
                                pass
                        if inv2 and inv2.status == "issued":
                            inv2.status = "sent"
                            inv2.sent_at = inv2.sent_at or (now - timedelta(days=5))
                            db.add(inv2)
                            db.commit()
                except Exception as exc2:
                    warnings.append(f"Émission facture depuis devis (best-effort) échouée: {exc2}")

            db.commit()
        except Exception as exc:
            warnings.append(f"Génération PDF/Factur-X (best-effort) échouée: {exc}")

    if self_service_proof_requested:
        _record_self_service_demo_seed_proof(
            db,
            tenant_id=tenant.id,
            preset=demo_preset.slug,
        )

    return SeedResult(
        ok=True,
        seeded=True,
        message=f"Données de démo générées ({demo_preset.label}).",
        counts=counts,
        warnings=warnings,
        created_ids=created_ids,
        issued_invoice_ids=issued_invoice_ids,
    )
