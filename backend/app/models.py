from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, relationship, synonym

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _current_utc_year() -> int:
    return _utcnow().year


def _default_tenant_features():
    # NOTE: tenant_settings.features is used for feature-flags and for public portal behavior.
    # Keep values JSON-serializable.
    return {
        "po": True,
        "delivery_address": True,
        "recurring": False,
        "progress_invoices": False,
        "catalog_advanced": False,
        "attachments": True,
        # Safety / stricter business validations
        "compliance_strict": False,
        "invoice_strict": False,
        # Public portals (quote/invoice/customer)
        "portal": {
            "theme": "blue",
            # Paiement carte retiré du produit public. Le réglage reste dans
            # le schéma pour lire les anciens tenants, mais ne doit jamais
            # être activé par défaut ni exposé comme disponible.
            "card_payments": False,
            "show_credit_notes": True,
            "show_all_documents": False,
            "quote_convert_mode": "disabled",  # auto_issue | create_draft | disabled
            "support_email": None,
            "footer_note": None,
        },
        # Branding emails / PDFs (B2B feel, cohérence concurrent)
        "branding": {
            # classic | graphite | ivory (déjà supportés par les templates PDF)
            "pdf_template": "classic",
            # Couleur accent emails. Si None: dérivée du thème portail.
            "email_accent": None,
            # Signature HTML/texte (optionnelle)
            "email_signature": None,
            # Note footer (optionnelle)
            "email_footer_note": None,
        },
        # Modèles de mentions légales imprimées, séparés par type de document.
        "document_legal_templates": {
            "invoice": None,
            "quote": None,
        },
        # Commercial signup intent. This never grants paid features by itself.
        "billing_request": {
            "requested_plan": None,
            "active_plan": None,
            "requested_period": None,
            "checkout_requested": False,
            "requires_checkout": False,
        },
        # Relances automatiques (dunning) - activées par défaut en prod.
        "dunning": {
            "enabled": True,
            # Offsets en jours relatifs à l'échéance (due_date). Négatif = avant.
            "schedule_days": [-2, 3, 10],
            "min_interval_hours": 24,
            "attach_pdf": True,
            # Contenu par offset. Les clés sont des strings (JSON).
            "steps": {
                "-2": {
                    "subject": "Rappel : facture {number} bientôt à échéance",
                    "body": "Bonjour {client},\n\nPetit rappel : la facture {number} arrive à échéance le {due_date}.\n\nSi le règlement est déjà planifié ou effectué, merci d'ignorer ce message. Sinon, vous pouvez consulter la facture depuis le portail sécurisé.",
                },
                "3": {
                    "subject": "Rappel : facture {number} échue",
                    "body": "Bonjour {client},\n\nSauf erreur de notre part, la facture {number}, échue le {due_date}, reste à régler.\n\nSi le paiement a déjà été effectué, merci de transmettre la référence du règlement à votre contact habituel. À défaut, merci d'indiquer la date de paiement prévue.",
                },
                "10": {
                    "subject": "2e rappel : facture {number} en retard",
                    "body": "Bonjour {client},\n\nNous n’avons pas constaté le règlement de la facture {number}.\n\nMerci d'indiquer la date de paiement prévue ou de transmettre la référence du règlement à votre contact habituel si le paiement a déjà été effectué.",
                },
            },
        },
    }


class Tenant(Base):
    __tablename__ = "tenants"
    id = Column(String, primary_key=True, default=_uuid)
    name = Column(String, nullable=False)
    tenant_slug: Mapped[str] = Column(String, nullable=False, unique=True, index=True)
    plan = Column(String, default="starter")
    stripe_customer_id = Column(String, nullable=True)
    stripe_subscription_id = Column(String, nullable=True)
    subscription_status = Column(String, nullable=True)
    # Monotonic cursor for Stripe subscription lifecycle webhooks.  Stripe
    # does not guarantee delivery order; older status events must not revive a
    # canceled subscription or downgrade a newer active state.
    stripe_subscription_event_created = Column(Integer, nullable=True)
    stripe_subscription_event_id = Column(String, nullable=True)
    # Exclusive lease for an open Stripe subscription Checkout. It prevents
    # two tabs/requests from creating parallel subscriptions before webhooks
    # have populated ``stripe_subscription_id``.
    stripe_checkout_session_id = Column(String, nullable=True)
    stripe_checkout_request_key = Column(String, nullable=True)
    stripe_checkout_pending_until = Column(DateTime, nullable=True)
    stripe_checkout_plan = Column(String, nullable=True)
    stripe_checkout_period = Column(String, nullable=True)
    trial_end = Column(DateTime, nullable=True)
    professional_use_confirmed_at = Column(DateTime, nullable=True)
    professional_use_confirmed_by = Column(
        String,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    siret = Column(String, nullable=True)
    rcs = Column(String, nullable=True)
    naf_code = Column(String, nullable=True)
    legal_form = Column(String, nullable=True)
    share_capital = Column(String, nullable=True)
    address = Column(Text, nullable=True)
    address_line1 = Column(String, nullable=True)
    address_line2 = Column(String, nullable=True)
    postal_code = Column(String, nullable=True)
    city = Column(String, nullable=True)
    country_code = Column(String, nullable=True)
    country = Column(String, nullable=False, default="FR")
    phone = Column(String, nullable=True)
    vat_number = Column(String, nullable=True)
    vat_on_debits = Column(Boolean, default=False)
    default_sales_vat_rate = Column(Numeric(5, 2), nullable=True)
    vat_regime = Column(String, nullable=False, default="real_normal_monthly")
    transaction_periodicity = Column(String, nullable=True)
    payment_periodicity = Column(String, nullable=True)
    payments_reporting_enabled = Column(Boolean, default=True, nullable=False)
    ereporting_sync_status = Column(String, nullable=True)
    seqino_last_periodicity_sync_at = Column(DateTime, nullable=True)
    seqino_last_periodicity_sync_status = Column(String, nullable=True)
    iban = Column(String, nullable=True)
    bic = Column(String, nullable=True)
    logo_url = Column(String, nullable=True)
    logo_storage_key = Column(String, nullable=True)
    legal_mentions = Column(Text, nullable=True)
    vat_exemption_notice = Column(Text, nullable=True)
    late_payment_interest = Column(String, nullable=True)
    recovery_fee_eur = Column(Numeric(10, 2), nullable=True, default=40)
    discount_terms = Column(String, nullable=True, default="Néant")
    email_subject_default = Column(Text, nullable=True)
    email_body_default = Column(Text, nullable=True)
    reminder_subject_default = Column(Text, nullable=True)
    reminder_body_default = Column(Text, nullable=True)
    # Devis (quotes) - modèles d'email
    quote_email_subject_default = Column(Text, nullable=True)
    quote_email_body_default = Column(Text, nullable=True)
    quote_followup_subject_default = Column(Text, nullable=True)
    quote_followup_body_default = Column(Text, nullable=True)
    # Devis (quotes) - portail / acceptation
    quote_acceptance_mode = Column(String, nullable=False, default="simple")  # simple|otp
    quote_terms_url = Column(Text, nullable=True)
    quote_terms_required = Column(Boolean, default=False, nullable=False)
    quote_otp_subject_default = Column(Text, nullable=True)
    quote_otp_body_default = Column(Text, nullable=True)
    email_reply_to = Column(String, nullable=True)
    # FEC (export) - overrides per tenant
    fec_journal_code = Column(String, nullable=True)
    fec_journal_label = Column(String, nullable=True)
    fec_account_customer = Column(String, nullable=True)
    fec_account_revenue = Column(String, nullable=True)
    fec_account_vat = Column(String, nullable=True)
    retention_years = Column(Integer, nullable=False, default=10)
    deleted_at = Column(DateTime, nullable=True)
    deleted_reason = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    settings: Mapped["TenantSettings | None"] = relationship(
        "TenantSettings",
        uselist=False,
        cascade="all, delete-orphan",
        back_populates="tenant",
    )
    bank_accounts: Mapped[list["TenantBankAccount"]] = relationship(
        "TenantBankAccount",
        cascade="all, delete-orphan",
        back_populates="tenant",
    )

    @property
    def slug(self) -> str:
        assert self.tenant_slug is not None
        return self.tenant_slug


class TenantBankAccount(Base):
    __tablename__ = "tenant_bank_accounts"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    label = Column(String, nullable=False, default="RIB principal")
    iban = Column(String, nullable=True)
    bic = Column(String, nullable=True)
    is_default = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=True)

    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="bank_accounts")

    __table_args__ = (Index("ix_tenant_bank_accounts_tenant_default", "tenant_id", "is_default"),)


class TenantSettings(Base):
    __tablename__ = "tenant_settings"
    tenant_id = Column(String, ForeignKey("tenants.id"), primary_key=True)
    preset = Column(String, nullable=False, default="standard")
    features = Column(JSON, nullable=False, default=_default_tenant_features)
    onboarding_completed = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="settings")


class User(Base):
    __tablename__ = "users"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    # Emails are stored lowercase for case-insensitive uniqueness.
    email = Column(String, unique=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="owner")  # owner|admin|accountant|viewer
    is_admin = Column(Boolean, default=False)
    is_platform_admin = Column(Boolean, default=False)
    is_support = Column(Boolean, default=False)
    status = Column(String, default="active", nullable=False)
    token_version = Column(Integer, default=0)
    mfa_enabled = Column(Boolean, default=False)
    mfa_secret = Column(LargeBinary, nullable=True)
    mfa_enrolled_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    refresh_jti_hash = Column(String, nullable=False, index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    last_used_at = Column(DateTime, default=_utcnow, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    user_agent = Column(Text, nullable=True)
    ip = Column(String, nullable=True)


class Membership(Base):
    __tablename__ = "memberships"
    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    role = Column(String, nullable=False, default="viewer")
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    __table_args__ = (UniqueConstraint("user_id", "tenant_id", name="uniq_membership_user_tenant"),)


class UserInvite(Base):
    __tablename__ = "user_invites"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    email = Column(String, nullable=False, index=True)
    role = Column(String, nullable=False, default="accountant")
    token_hash = Column(String, nullable=False, unique=True)
    invited_by_user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    accepted_by_user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    customer_id = Column(String, ForeignKey("customers.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    accepted_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)


class DemoInvitation(Base):
    __tablename__ = "demo_invitations"
    id = Column(String, primary_key=True, default=_uuid)
    email = Column(String, nullable=False, index=True)
    preset = Column(String, nullable=False, default="services")
    token_hash = Column(String(64), nullable=False, unique=True)
    created_by_user_id = Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    consumed_by_user_id = Column(String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    consumed_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    __table_args__ = (
        CheckConstraint(
            "preset IN ('services', 'retail', 'construction', 'public_sector', 'health')",
            name="ck_demo_invitations_preset",
        ),
        CheckConstraint(
            "length(token_hash) = 64",
            name="ck_demo_invitations_token_hash_length",
        ),
        Index("ix_demo_invitations_email_state", "email", "consumed_at", "revoked_at", "expires_at"),
    )


class LegalAcceptance(Base):
    __tablename__ = "legal_acceptances"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    doc_slug = Column(String, nullable=False)
    doc_version = Column(String, nullable=False)
    # Nullable uniquement pour conserver les preuves historiques créées avant
    # la migration 20260815. Les nouvelles acceptations remplissent toujours
    # ces quatre champs via le service legal_acceptance.
    acceptance_scope = Column(String, nullable=True)
    accepted_role = Column(String, nullable=True)
    authority_basis = Column(String, nullable=True)
    document_sha256 = Column(String(64), nullable=True)
    accepted_at = Column(DateTime, default=_utcnow, nullable=False)
    ip = Column(String, nullable=True)
    user_agent = Column(Text, nullable=True)
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "user_id",
            "doc_slug",
            "doc_version",
            "document_sha256",
            name="uniq_legal_acceptance_document_hash",
        ),
        CheckConstraint(
            "acceptance_scope IS NULL OR acceptance_scope IN ('user', 'tenant')",
            name="ck_legal_acceptance_scope",
        ),
        CheckConstraint(
            "authority_basis IS NULL OR authority_basis IN ('user_self', 'tenant_role')",
            name="ck_legal_acceptance_authority_basis",
        ),
        CheckConstraint(
            "document_sha256 IS NULL OR length(document_sha256) = 64",
            name="ck_legal_acceptance_document_sha256_length",
        ),
        Index("ix_legal_acceptance_tenant_doc", "tenant_id", "doc_slug"),
    )


class Lead(Base):
    __tablename__ = "leads"
    id = Column(String, primary_key=True, default=_uuid)
    email = Column(String, nullable=True, index=True)
    company = Column(String, nullable=True)
    message = Column(Text, nullable=False)
    source = Column(String, nullable=True)
    utm_source = Column(String, nullable=True)
    utm_medium = Column(String, nullable=True)
    utm_campaign = Column(String, nullable=True)
    utm_term = Column(String, nullable=True)
    utm_content = Column(String, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False, index=True)
    ip = Column(String, nullable=True)
    user_agent = Column(Text, nullable=True)


class CustomerUserLink(Base):
    __tablename__ = "customer_user_links"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    customer_id = Column(String, ForeignKey("customers.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    __table_args__ = (UniqueConstraint("tenant_id", "user_id", name="uniq_customer_user_link"),)


class Customer(Base):
    __tablename__ = "customers"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    client_type = Column(String, nullable=True, default="business")
    email = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    contact_name = Column(String, nullable=True)
    address = Column(Text, nullable=True)
    address_line1 = Column(String, nullable=True)
    address_line2 = Column(String, nullable=True)
    postal_code = Column(String, nullable=True)
    city = Column(String, nullable=True)
    country_code = Column(String, nullable=True)
    siret = Column(String, nullable=True)
    siren = Column(String, nullable=True)
    vat_number = Column(String, nullable=True)  # TVA (FRxx...)
    endpoint_id = Column(String, nullable=True)
    pdp_name = Column(String, nullable=True)
    public_service_code = Column(String, nullable=True)
    public_commitment_reference = Column(String, nullable=True)
    chorus_service_code_required = Column(Boolean, nullable=True)
    chorus_commitment_required = Column(Boolean, nullable=True)
    chorus_billing_address_active = Column(Boolean, nullable=True)
    country = Column(String, nullable=True, default="FR")
    payment_terms_default = Column(Text, nullable=True)
    payment_method_default = Column(String, nullable=True)
    default_vat_rate = Column(Numeric(5, 2), nullable=True)
    iban = Column(String, nullable=True)
    bic = Column(String, nullable=True)
    internal_note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow, index=True)

    # Portail client unifié (lien partageable sans compte)
    portal_token = Column(String, nullable=True)
    portal_enabled = Column(Boolean, default=False, nullable=False)
    portal_created_at = Column(DateTime, nullable=True)

    # Tracking vues portail (sans stockage PII)
    portal_view_count = Column(Integer, nullable=False, default=0)
    portal_first_viewed_at = Column(DateTime, nullable=True)
    portal_last_viewed_at = Column(DateTime, nullable=True)

    # Contacts supplémentaires (B2B): destinataires factures/devis.
    # NOTE: on conserve Customer.email (contact principal historique) + on ajoute un carnet multi-contacts.
    contacts: Mapped[list["CustomerContact"]] = relationship(
        "CustomerContact",
        back_populates="customer",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    __table_args__ = (
        UniqueConstraint("tenant_id", "siret", name="uniq_customer_siret_per_tenant"),
        UniqueConstraint("tenant_id", "vat_number", name="uniq_customer_vat_per_tenant"),
        UniqueConstraint("tenant_id", "email", name="uniq_customer_email_per_tenant"),
        Index("ix_customers_portal_token", "portal_token", unique=True),
    )


class CustomerContact(Base):
    """Contact email lié à un client.

    Objectif: permettre l'envoi multi-destinataires (factures, devis) et gérer les rôles.
    On évite les CC visibles : chaque destinataire reçoit un email séparé.
    """

    __tablename__ = "customer_contacts"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    customer_id = Column(String, ForeignKey("customers.id"), nullable=False, index=True)

    name = Column(String, nullable=True)
    email = Column(String, nullable=False, index=True)

    # billing = facturation, cc = copie (envoi séparé), other = divers
    role = Column(String, nullable=False, default="billing")
    send_invoices = Column(Boolean, default=True, nullable=False)
    send_quotes = Column(Boolean, default=True, nullable=False)
    is_primary = Column(Boolean, default=False, nullable=False)

    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    customer: Mapped["Customer"] = relationship("Customer", back_populates="contacts")

    __table_args__ = (
        UniqueConstraint("customer_id", "email", name="uniq_customer_contact_email"),
        Index("ix_customer_contacts_tenant_email", "tenant_id", "email"),
        Index("ix_customer_contacts_customer_role", "customer_id", "role"),
    )


class Product(Base):
    __tablename__ = "products"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    unit_price = Column(Numeric(20, 2), nullable=False)
    vat_rate = Column(Numeric(5, 2), nullable=False, default=20.0)
    unit_code = Column(String, default="C62")
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_utcnow)


class Invoice(Base):
    __tablename__ = "invoices"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    customer_id = Column(String, ForeignKey("customers.id"), nullable=False, index=True)
    number = Column(String, nullable=True, index=True)
    currency = Column(String, default="EUR")
    note = Column(Text, nullable=True)
    template_key = Column(String, nullable=True)
    template_options = Column(JSON, nullable=True)
    purchase_order_number = Column(String, nullable=True)
    public_service_code = Column(String, nullable=True)
    payment_terms = Column(Text, nullable=True)
    due_date = Column(DateTime, nullable=True, index=True)
    due_date_manual = Column(Boolean, default=False, nullable=False)
    type = Column(String, default="invoice")  # invoice | credit_note
    invoice_kind = Column(String, default="standard", nullable=False, index=True)  # standard | deposit | final
    quote_id = Column(String, ForeignKey("quotes.id"), nullable=True, index=True)
    related_invoice_id = Column(String, ForeignKey("invoices.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    updated_by = Column(String, ForeignKey("users.id"), nullable=True)
    delivery_address = Column(Text, nullable=True)
    delivery_address_differs = Column(Boolean, default=False, nullable=False)
    operation_nature = Column(String, default="services")  # goods|services|mixed
    status = Column(String, default="draft")  # draft|sent|paid|overdue
    issue_date = Column(DateTime, default=_utcnow, index=True)
    service_date = Column(Date, nullable=True)
    due_days = Column(Integer, default=30)
    total_ex_vat = Column(Numeric(20, 2), default=0)
    total_vat = Column(Numeric(20, 2), default=0)
    total_inc_vat = Column(Numeric(20, 2), default=0)
    allowance_total = Column(Numeric(20, 2), default=0)
    charge_total = Column(Numeric(20, 2), default=0)
    seller_snapshot = Column(JSON, nullable=True)
    supplier_snapshot = Column(JSON, nullable=True)
    buyer_snapshot = Column(JSON, nullable=True)
    lines_snapshot = Column(JSON, nullable=True)
    totals_snapshot = Column(JSON, nullable=True)
    pdf_key = Column(String, nullable=True)
    pdf_size = Column(Integer, nullable=True)
    xml_key = Column(String, nullable=True)
    xml_size = Column(Integer, nullable=True)
    facturx_key = Column(String, nullable=True)
    facturx_size = Column(Integer, nullable=True)
    pdf_checksum = Column(String, nullable=True)
    xml_checksum = Column(String, nullable=True)
    facturx_checksum = Column(String, nullable=True)
    pdfa3_status = Column(String, nullable=True)
    pdfa3_report = Column(Text, nullable=True)
    facturx_spec_version = Column(String, nullable=True)
    issued_at = Column(DateTime, nullable=True)
    issued_hash = Column(String, nullable=True)
    issued_profile = Column(String, nullable=True)

    @property
    def facturx_profile(self) -> str | None:
        return self.issued_profile

    @facturx_profile.setter
    def facturx_profile(self, value: str | None) -> None:
        self.issued_profile = value

    sent_at = Column(DateTime, nullable=True)
    paid_at = Column(DateTime, nullable=True)
    reminder_count = Column(Integer, default=0)
    last_reminder_at = Column(DateTime, nullable=True)

    # Portail public (URL partageable pour le client, sans compte)
    public_token = Column(String, nullable=True)
    public_enabled = Column(Boolean, default=False, nullable=False)
    public_created_at = Column(DateTime, nullable=True)

    # Tracking vues portail (sans stockage PII)
    public_view_count = Column(Integer, nullable=False, default=0)
    public_first_viewed_at = Column(DateTime, nullable=True)
    public_last_viewed_at = Column(DateTime, nullable=True)
    lines: Mapped[list["InvoiceLine"]] = relationship(
        "InvoiceLine",
        back_populates="invoice",
        cascade="all, delete-orphan",
    )
    payments: Mapped[list["Payment"]] = relationship(
        "Payment",
        back_populates="invoice",
        cascade="all, delete-orphan",
    )

    refunds: Mapped[list["CreditNoteRefund"]] = relationship(
        "CreditNoteRefund",
        back_populates="invoice",
        cascade="all, delete-orphan",
    )

    applied_deposits: Mapped[list["InvoiceDepositApplication"]] = relationship(
        "InvoiceDepositApplication",
        back_populates="final_invoice",
        cascade="all, delete-orphan",
        foreign_keys="InvoiceDepositApplication.final_invoice_id",
    )

    used_as_deposit_in: Mapped[list["InvoiceDepositApplication"]] = relationship(
        "InvoiceDepositApplication",
        back_populates="deposit_invoice",
        foreign_keys="InvoiceDepositApplication.deposit_invoice_id",
    )

    attachments: Mapped[list["DocumentAttachment"]] = relationship(
        "DocumentAttachment",
        back_populates="invoice",
        cascade="all, delete-orphan",
    )
    einvoicing_transmissions: Mapped[list["EInvoicingTransmission"]] = relationship(
        "EInvoicingTransmission",
        back_populates="invoice",
        cascade="all, delete-orphan",
    )
    partner_transmissions: Mapped[list["EInvoiceTransmission"]] = relationship(
        "EInvoiceTransmission",
        back_populates="invoice",
        cascade="all, delete-orphan",
    )
    __table_args__ = (
        UniqueConstraint("tenant_id", "number", name="uq_invoices_tenant_number"),
        Index("ix_invoices_tenant_number", "tenant_id", "number"),
        Index("ix_invoices_tenant_quote_kind", "tenant_id", "quote_id", "invoice_kind"),
        Index("ix_invoices_tenant_status_due", "tenant_id", "status", "due_date"),
        Index("ix_invoices_public_token", "public_token", unique=True),
    )


class InvoiceDepositApplication(Base):
    __tablename__ = "invoice_deposit_applications"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    quote_id = Column(String, ForeignKey("quotes.id"), nullable=False, index=True)
    final_invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    deposit_invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    amount_ht = Column(Numeric(20, 2), nullable=False, default=0)
    amount_vat = Column(Numeric(20, 2), nullable=False, default=0)
    amount_ttc = Column(Numeric(20, 2), nullable=False, default=0)
    vat_rate = Column(Numeric(5, 2), nullable=True)
    deposit_number = Column(String, nullable=True)
    deposit_issue_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)

    final_invoice: Mapped["Invoice"] = relationship(
        "Invoice",
        back_populates="applied_deposits",
        foreign_keys=[final_invoice_id],
    )
    deposit_invoice: Mapped["Invoice"] = relationship(
        "Invoice",
        back_populates="used_as_deposit_in",
        foreign_keys=[deposit_invoice_id],
    )

    __table_args__ = (
        UniqueConstraint("deposit_invoice_id", name="uq_invoice_deposit_application_deposit"),
        Index("ix_invoice_deposit_applications_tenant_final", "tenant_id", "final_invoice_id"),
        Index("ix_invoice_deposit_applications_tenant_quote", "tenant_id", "quote_id"),
    )


class InvoiceLine(Base):
    __tablename__ = "invoice_lines"
    id = Column(String, primary_key=True, default=_uuid)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    line_type = Column(String, nullable=False, default="item")
    display_number = Column(String, nullable=True)
    reference = Column(String, nullable=True)
    source_line_id = Column(String, nullable=True, index=True)
    product_name = Column(String, nullable=False)
    detail = Column(Text, nullable=True)
    quantity = Column(Numeric(20, 2), nullable=False, default=1)
    unit_price = Column(Numeric(20, 2), nullable=False, default=0)
    vat_rate = Column(Numeric(5, 2), nullable=False, default=20.0)
    vat_category = Column(String, default="S")
    exemption_reason_code = Column(String, nullable=True)
    unit_code = Column(String, default="C62")
    item_id = Column(String, nullable=True)
    accounting_account = Column(String, nullable=True)
    line_total = Column(Numeric(20, 2), nullable=False, default=0)
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="lines")


class QuoteNumbering(Base):
    __tablename__ = "quote_numbering"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    prefix = Column(String, default="D-")
    last_index = Column(Integer, default=0)
    year = Column(Integer, default=_current_utc_year)
    __table_args__ = (UniqueConstraint("tenant_id", name="uniq_quote_numbering_per_tenant"),)


class Quote(Base):
    __tablename__ = "quotes"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    customer_id = Column(String, ForeignKey("customers.id"), nullable=False, index=True)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=True, index=True)
    duplicate_of_id = Column(String, nullable=True, index=True)

    number = Column(String, nullable=True, index=True)
    currency = Column(String, default="EUR")
    note = Column(Text, nullable=True)
    template_key = Column(String, nullable=True)
    template_options = Column(JSON, nullable=True)
    payment_terms = Column(Text, nullable=True)
    purchase_order_number = Column(String, nullable=True)

    status = Column(String, default="draft", index=True)  # draft|sent|accepted|rejected|invoiced|expired
    issue_date = Column(DateTime, default=_utcnow, index=True)
    service_date = Column(Date, nullable=True)
    valid_until = Column(Date, nullable=True, index=True)
    sent_at = Column(DateTime, nullable=True)
    accepted_at = Column(DateTime, nullable=True)
    accepted_name = Column(String, nullable=True)
    accepted_email = Column(String, nullable=True)
    accepted_ip = Column(String, nullable=True)
    accepted_user_agent = Column(Text, nullable=True)
    rejected_at = Column(DateTime, nullable=True)
    rejected_reason = Column(Text, nullable=True)

    # Portail client (URL publique)
    public_token = Column(String, nullable=True)
    public_enabled = Column(Boolean, default=False, nullable=False)
    public_created_at = Column(DateTime, nullable=True)

    # Tracking vues portail (sans stockage PII)
    public_view_count = Column(Integer, nullable=False, default=0)
    public_first_viewed_at = Column(DateTime, nullable=True)
    public_last_viewed_at = Column(DateTime, nullable=True)

    # Preuve / scellé (hash + snapshots)
    seal_hash = Column(String, nullable=True)
    seal_created_at = Column(DateTime, nullable=True)
    supplier_snapshot: Mapped[dict[str, Any] | None] = Column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    buyer_snapshot: Mapped[dict[str, Any] | None] = Column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    lines_snapshot: Mapped[list[Any] | None] = Column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    totals_snapshot: Mapped[dict[str, Any] | None] = Column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )

    # OTP (acceptation devis)
    otp_hash = Column(String, nullable=True)
    otp_email = Column(String, nullable=True)
    otp_expires_at = Column(DateTime, nullable=True)
    otp_attempts = Column(Integer, nullable=False, default=0)
    otp_last_sent_at = Column(DateTime, nullable=True)

    # CGV acceptées
    accepted_terms_url = Column(Text, nullable=True)
    accepted_terms_at = Column(DateTime, nullable=True)

    # Relances (devis envoyés)
    reminder_count = Column(Integer, default=0)
    last_reminder_at = Column(DateTime, nullable=True)

    total_ex_vat = Column(Numeric(20, 2), default=0)
    total_vat = Column(Numeric(20, 2), default=0)
    total_inc_vat = Column(Numeric(20, 2), default=0)

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    updated_by = Column(String, ForeignKey("users.id"), nullable=True)

    lines: Mapped[list["QuoteLine"]] = relationship(
        "QuoteLine",
        back_populates="quote",
        cascade="all, delete-orphan",
    )

    attachments: Mapped[list["DocumentAttachment"]] = relationship(
        "DocumentAttachment",
        back_populates="quote",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        UniqueConstraint("tenant_id", "number", name="uq_quotes_tenant_number"),
        Index("ix_quotes_tenant_number", "tenant_id", "number"),
        Index("ix_quotes_tenant_status_valid_until", "tenant_id", "status", "valid_until"),
        Index("ix_quotes_public_token", "public_token", unique=True),
    )


class QuoteLine(Base):
    __tablename__ = "quote_lines"
    id = Column(String, primary_key=True, default=_uuid)
    quote_id = Column(String, ForeignKey("quotes.id"), nullable=False, index=True)
    line_type = Column(String, nullable=False, default="item")
    display_number = Column(String, nullable=True)
    reference = Column(String, nullable=True)
    product_name = Column(String, nullable=False)
    detail = Column(Text, nullable=True)
    quantity = Column(Numeric(20, 2), nullable=False, default=1)
    unit_price = Column(Numeric(20, 2), nullable=False, default=0)
    vat_rate = Column(Numeric(5, 2), nullable=False, default=20.0)
    vat_category = Column(String, default="S")
    exemption_reason_code = Column(String, nullable=True)
    unit_code = Column(String, default="C62")
    item_id = Column(String, nullable=True)
    accounting_account = Column(String, nullable=True)
    line_total = Column(Numeric(20, 2), nullable=False, default=0)
    quote: Mapped["Quote"] = relationship("Quote", back_populates="lines")


class DocumentAttachment(Base):
    __tablename__ = "document_attachments"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)

    # Parent (exactement 1)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=True, index=True)
    quote_id = Column(String, ForeignKey("quotes.id"), nullable=True, index=True)

    filename = Column(String, nullable=False)
    label = Column(String, nullable=True)
    content_type = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False, default=0)
    sha256 = Column(String, nullable=True)

    storage_key = Column(String, nullable=False, index=True)

    # Visible sur le portail public (client) ?
    public_visible = Column(Boolean, nullable=False, default=False)

    created_at = Column(DateTime, default=_utcnow, nullable=False)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=True)
    updated_by = Column(String, ForeignKey("users.id"), nullable=True)

    deleted_at = Column(DateTime, nullable=True)
    deleted_by = Column(String, ForeignKey("users.id"), nullable=True)

    invoice: Mapped["Invoice | None"] = relationship("Invoice", back_populates="attachments")
    quote: Mapped["Quote | None"] = relationship("Quote", back_populates="attachments")

    __table_args__ = (
        CheckConstraint(
            "(invoice_id IS NOT NULL AND quote_id IS NULL) OR (invoice_id IS NULL AND quote_id IS NOT NULL)",
            name="ck_document_attachments_one_parent",
        ),
        Index("ix_document_attachments_tenant_created", "tenant_id", "created_at"),
        Index("ix_document_attachments_invoice_created", "invoice_id", "created_at"),
        Index("ix_document_attachments_quote_created", "quote_id", "created_at"),
    )


class InvoiceArtifact(Base):
    __tablename__ = "invoice_artifacts"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    kind = Column(String, nullable=False)
    storage_key = Column(String, nullable=True)
    sha256 = Column(String, nullable=False)
    content_type = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    data = Column(LargeBinary, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    __table_args__ = (
        UniqueConstraint("invoice_id", "kind", name="uniq_invoice_artifact_invoice_kind"),
        CheckConstraint("kind in ('PDF', 'FACTURX', 'UBL', 'CII')", name="ck_invoice_artifact_kind"),
    )


class Numbering(Base):
    __tablename__ = "numbering"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    prefix = Column(String, default="F-")
    last_index = Column(Integer, default=0)
    year = Column(Integer, default=_current_utc_year)
    __table_args__ = (UniqueConstraint("tenant_id", name="uniq_numbering_per_tenant"),)


class Payment(Base):
    __tablename__ = "payments"
    id = Column(String, primary_key=True, default=_uuid)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    date = Column(DateTime, default=_utcnow, nullable=False)
    method = Column(String, nullable=True)
    amount = Column(Numeric(20, 2), nullable=False, default=0)
    reference = Column(String, nullable=True)
    settlement_mode = Column(String, nullable=True)  # bank|cash|manual
    accounting_category = Column(String, nullable=True)
    receipt_label = Column(String, nullable=True)

    # Détails optionnels (ex: Stripe) pour preuves de paiement / reçus
    provider = Column(String, nullable=True)  # stripe|manual|...
    provider_id = Column(String, nullable=True)  # payment_intent, checkout_session, etc.
    receipt_url = Column(String, nullable=True)
    card_brand = Column(String, nullable=True)
    card_last4 = Column(String, nullable=True)

    created_at = Column(DateTime, default=_utcnow)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="payments")


class CreditNoteRefund(Base):
    __tablename__ = "credit_note_refunds"
    id = Column(String, primary_key=True, default=_uuid)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    date = Column(DateTime, default=_utcnow, nullable=False)
    method = Column(String, nullable=True)
    amount = Column(Numeric(20, 2), nullable=False, default=0)
    reference = Column(String, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="refunds")


class AccountingExport(Base):
    __tablename__ = "accounting_exports"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    format = Column(String, nullable=False, index=True)
    period_start = Column(Date, nullable=True)
    period_end = Column(Date, nullable=True)
    customer_id = Column(String, ForeignKey("customers.id"), nullable=True, index=True)
    record_count = Column(Integer, nullable=False, default=0)
    filters_json: Mapped[dict[str, Any] | None] = Column(
        "filters",
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    status = Column(String, nullable=False, default="generated", index=True)
    cabinet_comment = Column(Text, nullable=True)
    cabinet_validation_status = Column(String, nullable=False, default="pending_review", index=True)
    cabinet_reviewed_at = Column(DateTime, nullable=True)
    cabinet_reviewed_by = Column(String, ForeignKey("users.id"), nullable=True)
    delivered_to_accountant_at = Column(DateTime, nullable=True)
    delivered_to_accountant_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    __table_args__ = (
        Index("ix_accounting_exports_tenant_created", "tenant_id", "created_at"),
        Index("ix_accounting_exports_tenant_period", "tenant_id", "period_start", "period_end"),
        Index("ix_accounting_exports_tenant_status", "tenant_id", "status"),
        Index("ix_accounting_exports_tenant_validation", "tenant_id", "cabinet_validation_status"),
    )


class BackgroundJob(Base):
    __tablename__ = "background_jobs"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    type = Column(String, nullable=False, index=True)
    status = Column(String, nullable=False, default="queued", index=True)
    queue = Column(String, nullable=False, default="default", index=True)
    progress = Column(Integer, nullable=False, default=0)
    input_hash = Column(String, nullable=True, index=True)
    result_ref = Column(String, nullable=True)
    error_code = Column(String, nullable=True)
    error_message = Column(Text, nullable=True)
    attempts = Column(Integer, nullable=False, default=0)
    rq_job_id = Column(String, nullable=True, index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_background_jobs_tenant_status_created", "tenant_id", "status", "created_at"),
        Index("ix_background_jobs_tenant_type_created", "tenant_id", "type", "created_at"),
    )


class ActionLog(Base):
    __tablename__ = "action_logs"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    entity = Column(String, nullable=False)  # invoice | payment | credit_note
    entity_id = Column(String, nullable=False, index=True)
    action = Column(String, nullable=False)
    payload = Column(Text, nullable=True)
    metadata_json: Mapped[dict[str, Any] | list[Any] | str | None] = Column(
        "metadata",
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    actor_user_id: Mapped[str | None] = synonym("user_id")
    action_type: Mapped[str] = synonym("action")
    object_type: Mapped[str] = synonym("entity")
    object_id: Mapped[str] = synonym("entity_id")
    __table_args__ = (Index("ix_action_logs_tenant_entity_created", "tenant_id", "entity", "entity_id", "created_at"),)


class EmailEvent(Base):
    __tablename__ = "email_events"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=True, index=True)
    quote_id = Column(String, ForeignKey("quotes.id"), nullable=True, index=True)
    type = Column(String, nullable=False)
    to = Column(String, nullable=False)
    status = Column(String, nullable=False, default="queued")
    delivery_mode = Column(String, nullable=False, default="smtp")
    error = Column(Text, nullable=True)
    provider = Column(String, nullable=True, index=True)
    provider_message_id = Column(String, nullable=True, index=True)
    provider_event_id = Column(String, nullable=True, index=True)
    provider_status = Column(String, nullable=True)
    provider_event_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    sent_at = Column(DateTime, nullable=True)


class Submission(Base):
    __tablename__ = "submissions"
    id = Column(String, primary_key=True, default=_uuid)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    channel = Column(String, default="chorus")
    status = Column(String, default="pending")
    external_id = Column(String, nullable=True, index=True)
    message_id = Column(String, nullable=True, index=True)
    message = Column(Text, nullable=True)
    errors = Column(JSON, nullable=True)
    raw = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class ApiKey(Base):
    __tablename__ = "api_keys"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String, nullable=True)
    token_hash = Column(String, nullable=False, unique=True)
    scopes: Mapped[dict[str, Any] | list[Any] | None] = Column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    created_at = Column(DateTime, default=_utcnow)
    last_used_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()


class PdpConnection(Base):
    __tablename__ = "pdp_connections"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    provider_slug = Column(String, nullable=False)
    auth_type = Column(String, nullable=False)
    encrypted_credentials = Column(LargeBinary, nullable=True)
    status = Column(String, default="disconnected")
    verified_siret = Column(String, nullable=True)
    verified_structure_id = Column(String, nullable=True)
    verified_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    __table_args__ = (
        UniqueConstraint("tenant_id", "provider_slug", name="uniq_pdp_connection_per_tenant"),
        Index("ix_pdp_connections_tenant_provider", "tenant_id", "provider_slug"),
    )


class IntegrationSecret(Base):
    __tablename__ = "integration_secrets"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    secret_key = Column(String, nullable=False, index=True)
    encrypted_value = Column(LargeBinary, nullable=False)
    kid = Column(String, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("tenant_id", "secret_key", name="uniq_integration_secret"),
        Index("ix_integration_secrets_tenant_key", "tenant_id", "secret_key"),
    )


class PdpAccount(Base):
    __tablename__ = "pdp_accounts"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    provider = Column(String, nullable=False, default="seqino")
    provider_client_id = Column(String, nullable=True, index=True)
    status = Column(String, nullable=True)
    provider_metadata: Mapped[dict[str, Any] | list[Any] | None] = Column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    raw_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    __table_args__ = (
        UniqueConstraint("tenant_id", "provider", name="uniq_pdp_account_per_tenant"),
        Index("ix_pdp_accounts_updated_at", "updated_at"),
    )


class PdpMandate(Base):
    __tablename__ = "pdp_mandates"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    provider_slug = Column(String, nullable=False, default="seqino")
    mandate_id = Column(String, nullable=False, index=True)
    siren = Column(String, nullable=True)
    siret = Column(String, nullable=True)
    suffix = Column(String, nullable=True)
    routing_identifier = Column(String, nullable=True)
    name = Column(String, nullable=True)
    start_date = Column(Date, nullable=True)
    status = Column(String, nullable=True)
    file_attachment = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    __table_args__ = (
        UniqueConstraint("tenant_id", "mandate_id", name="uniq_pdp_mandate_per_tenant"),
        Index("ix_pdp_mandates_tenant_provider", "tenant_id", "provider_slug"),
    )


class RecipientDirectoryEntry(Base):
    __tablename__ = "recipient_directory_entries"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    siren = Column(String, nullable=False, index=True)
    siret = Column(String, nullable=True, index=True)
    platform_slug = Column(String, nullable=False)
    billing_address = Column(String, nullable=False)
    routing_code = Column(String, nullable=True)
    routing_identifier = Column(String, nullable=True)
    platform_attached = Column(Boolean, nullable=True)
    billing_address_active = Column(Boolean, nullable=True)
    service_code_required = Column(Boolean, nullable=True)
    commitment_required = Column(Boolean, nullable=True)
    service_or_commitment_required = Column(Boolean, nullable=True)
    public_entity = Column(Boolean, nullable=True)
    raw_payload = Column(JSON, nullable=True)
    source = Column(String, nullable=True)
    last_synced_at = Column(DateTime, nullable=True)
    ttl_seconds = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class DirectorySyncRun(Base):
    __tablename__ = "directory_sync_runs"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    source = Column(String, nullable=False, default="ppf")
    status = Column(String, nullable=False, default="running")
    started_at = Column(DateTime, default=_utcnow)
    finished_at = Column(DateTime, nullable=True)
    total_requested = Column(Integer, default=0)
    total_found = Column(Integer, default=0)
    total_created = Column(Integer, default=0)
    total_updated = Column(Integer, default=0)
    total_skipped = Column(Integer, default=0)
    total_errors = Column(Integer, default=0)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class EInvoicingTransmission(Base):
    __tablename__ = "einvoicing_transmissions"
    id = Column(String, primary_key=True, default=_uuid)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    channel = Column(String, nullable=False)
    external_id = Column(String, nullable=True, index=True)
    status = Column(String, nullable=False)
    payload_hash = Column(String, nullable=True)
    # Stable logical submission key. New submissions always set it before I/O;
    # the unique index prevents a second outbox row for the same artifact/channel.
    idempotency_key = Column(String, nullable=True)
    # Technical delivery state is deliberately separate from the invoice
    # lifecycle status above (pending/submitting/delivered/failed/reconciliation_required).
    delivery_state = Column(String, nullable=False, default="pending")
    attempt_count = Column(Integer, nullable=False, default=0)
    last_attempt_at = Column(DateTime, nullable=True)
    events = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="einvoicing_transmissions")
    event_entries: Mapped[list["EInvoicingEvent"]] = relationship(
        "EInvoicingEvent",
        back_populates="transmission",
        cascade="all, delete-orphan",
    )
    lifecycle_events: Mapped[list["TransmissionEvent"]] = relationship(
        "TransmissionEvent",
        back_populates="transmission",
        cascade="all, delete-orphan",
    )
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uniq_einvoicing_transmission_idempotency"),
        Index("ix_einvoicing_transmissions_delivery_state", "delivery_state", "updated_at"),
    )


class EInvoicingActionOutbox(Base):
    """Durable guard for unsafe provider lifecycle actions.

    Examples include Seqino ``mark_as_cashed`` and inbound ``mark_as_paid``.
    The row is committed before the provider POST and its unique key prevents a
    second action after an ambiguous timeout.
    """

    __tablename__ = "einvoicing_action_outbox"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    transmission_id = Column(String, ForeignKey("einvoicing_transmissions.id"), nullable=True, index=True)
    provider_slug = Column(String, nullable=False)
    external_id = Column(String, nullable=False)
    action = Column(String, nullable=False)
    idempotency_key = Column(String, nullable=False)
    state = Column(String, nullable=False, default="submitting")
    attempt_count = Column(Integer, nullable=False, default=0)
    error_code = Column(String, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uniq_einvoicing_action_idempotency"),
        Index("ix_einvoicing_action_outbox_tenant_state", "tenant_id", "state", "updated_at"),
    )


class EInvoiceTransmission(Base):
    __tablename__ = "einvoice_transmissions"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False, index=True)
    direction = Column(String, nullable=False, default="OUT")
    platform = Column(String, nullable=False, index=True)
    status = Column(String, nullable=False)
    external_id = Column(String, nullable=True, index=True)
    error_code = Column(String, nullable=True)
    error_message = Column(Text, nullable=True)
    raw_events = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    last_event_at = Column(DateTime, nullable=True)
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="partner_transmissions")


class TransmissionEvent(Base):
    __tablename__ = "transmission_events"
    id = Column(String, primary_key=True, default=_uuid)
    transmission_id = Column(String, ForeignKey("einvoicing_transmissions.id"), nullable=False, index=True)
    correlation_id = Column(String, nullable=True)
    provider_slug = Column(String, nullable=True)
    external_id = Column(String, nullable=True)
    event_type = Column(String, nullable=False)
    status_code_norme = Column(String, nullable=False)
    payload_raw = Column(JSON, nullable=True)
    occurred_at = Column(DateTime, nullable=False, default=_utcnow)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    transmission: Mapped["EInvoicingTransmission"] = relationship(
        "EInvoicingTransmission",
        back_populates="lifecycle_events",
    )


class EInvoicingEvent(Base):
    __tablename__ = "einvoicing_events"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    transmission_id = Column(String, ForeignKey("einvoicing_transmissions.id"), nullable=False, index=True)
    status = Column(String, nullable=False)
    message = Column(Text, nullable=True)
    raw_status = Column(String, nullable=True)
    errors = Column(JSON, nullable=True)
    source = Column(String, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    transmission: Mapped["EInvoicingTransmission"] = relationship(
        "EInvoicingTransmission",
        back_populates="event_entries",
    )


class InboundInvoice(Base):
    __tablename__ = "inbound_invoices"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    provider_slug = Column(String, nullable=True)
    supplier_name = Column(String, nullable=True)
    supplier_siren = Column(String, nullable=True, index=True)
    supplier_siret = Column(String, nullable=True, index=True)
    invoice_number = Column(String, nullable=True, index=True)
    issue_date = Column(Date, nullable=True)
    total_ex_vat = Column(Numeric(20, 2), nullable=True)
    total_vat = Column(Numeric(20, 2), nullable=True)
    total_ttc = Column(Numeric(20, 2), nullable=True)
    currency = Column(String, nullable=True, default="EUR")
    received_at = Column(DateTime, nullable=True)
    format = Column(String, nullable=True)
    external_message_id = Column(String, nullable=True, index=True)
    status = Column(String, nullable=False, default="received")
    facturx_profile = Column(String, nullable=True)
    validation_status = Column(String, nullable=True)
    validation_errors = Column(JSON, nullable=True)
    validation_warnings = Column(JSON, nullable=True)
    validated_at = Column(DateTime, nullable=True)
    purchase_nature = Column(String, nullable=True)
    accounting_account = Column(String, nullable=True)
    accountant_note = Column(Text, nullable=True)
    planned_payment_date = Column(Date, nullable=True)
    paid_by_employee = Column(Boolean, nullable=False, default=False)
    employee_payer_name = Column(String, nullable=True)
    employee_payer_role = Column(String, nullable=True)
    employee_reimbursement_amount = Column(Numeric(20, 2), nullable=True)
    employee_reimbursement_due_date = Column(Date, nullable=True)
    employee_reimbursement_method = Column(String, nullable=True)
    employee_reimbursement_status = Column(String, nullable=True)
    purchase_tags = Column(JSON, nullable=True)
    purchase_lines = Column(JSON, nullable=True)
    completion_status = Column(String, nullable=False, default="draft")
    completion_validated_at = Column(DateTime, nullable=True)
    duplicate_of_id = Column(String, nullable=True, index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    attachments: Mapped[list["InboundInvoiceAttachment"]] = relationship(
        "InboundInvoiceAttachment",
        back_populates="inbound_invoice",
        cascade="all, delete-orphan",
    )
    events: Mapped[list["InboundInvoiceEvent"]] = relationship(
        "InboundInvoiceEvent",
        back_populates="inbound_invoice",
        cascade="all, delete-orphan",
    )
    purchase_payments: Mapped[list["PurchasePayment"]] = relationship(
        "PurchasePayment",
        back_populates="inbound_invoice",
        cascade="all, delete-orphan",
    )
    __table_args__ = (
        UniqueConstraint("tenant_id", "external_message_id", name="uniq_inbound_message_per_tenant"),
        Index("ix_inbound_invoices_tenant_status_received", "tenant_id", "status", "received_at"),
    )


class PurchasePayment(Base):
    __tablename__ = "purchase_payments"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    inbound_invoice_id = Column(String, ForeignKey("inbound_invoices.id"), nullable=False, index=True)
    date = Column(DateTime, default=_utcnow, nullable=False)
    method = Column(String, nullable=True)
    amount = Column(Numeric(20, 2), nullable=False, default=0)
    reference = Column(String, nullable=True)
    settlement_mode = Column(String, nullable=True)
    accounting_category = Column(String, nullable=True)
    receipt_label = Column(String, nullable=True)
    receipt_url = Column(String, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
    created_by = Column(String, ForeignKey("users.id"), nullable=True)
    inbound_invoice: Mapped["InboundInvoice"] = relationship("InboundInvoice", back_populates="purchase_payments")
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "inbound_invoice_id", "reference", name="uniq_purchase_payment_invoice_reference"
        ),
        Index("ix_purchase_payments_tenant_invoice", "tenant_id", "inbound_invoice_id"),
        Index("ix_purchase_payments_tenant_date", "tenant_id", "date"),
    )


class PurchaseWorkflowState(Base):
    __tablename__ = "purchase_workflow_states"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    inbound_invoice_id = Column(String, ForeignKey("inbound_invoices.id"), nullable=False, index=True)
    state = Column(String, nullable=False, default="new")
    owner_role = Column(String, nullable=True)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("tenant_id", "inbound_invoice_id", name="uniq_purchase_workflow_invoice"),
        Index("ix_purchase_workflow_tenant_state", "tenant_id", "state"),
        Index("ix_purchase_workflow_tenant_updated", "tenant_id", "updated_at"),
    )


class PurchaseSupplier(Base):
    __tablename__ = "purchase_suppliers"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    normalized_name = Column(String, nullable=False)
    siren = Column(String, nullable=True, index=True)
    siret = Column(String, nullable=True, index=True)
    vat_number = Column(String, nullable=True)
    default_accounting_account = Column(String, nullable=True)
    default_purchase_nature = Column(String, nullable=True)
    default_payment_delay_days = Column(Integer, nullable=True)
    default_vat_rate = Column(Numeric(5, 2), nullable=True)
    vat_rules = Column(JSON, nullable=True)
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    last_used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("tenant_id", "normalized_name", name="uniq_purchase_suppliers_tenant_normalized_name"),
        Index("ix_purchase_suppliers_tenant_siret", "tenant_id", "siret"),
        Index("ix_purchase_suppliers_tenant_siren", "tenant_id", "siren"),
    )


class CustomerSupplierRelation(Base):
    __tablename__ = "customer_supplier_relations"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    customer_id = Column(String, ForeignKey("customers.id"), nullable=False, index=True)
    supplier_id = Column(String, ForeignKey("purchase_suppliers.id"), nullable=False, index=True)
    relation_type = Column(String, nullable=False, default="same_party")
    status = Column(String, nullable=False, default="confirmed")
    reason = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    confirmed_by_user_id = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("tenant_id", "customer_id", "supplier_id", name="uniq_customer_supplier_relation_pair"),
        Index("ix_customer_supplier_relations_tenant_customer", "tenant_id", "customer_id"),
        Index("ix_customer_supplier_relations_tenant_supplier", "tenant_id", "supplier_id"),
    )


class PurchaseEmployeePayer(Base):
    __tablename__ = "purchase_employee_payers"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    normalized_name = Column(String, nullable=False)
    role = Column(String, nullable=False, default="manager")
    user_label = Column(String, nullable=True)
    default_accounting_account = Column(String, nullable=True)
    reimbursement_method = Column(String, nullable=True)
    vehicle_type = Column(String, nullable=True)
    fiscal_power = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    last_used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("tenant_id", "normalized_name", name="uniq_purchase_employee_payers_tenant_normalized_name"),
    )


class InboundInvoiceAttachment(Base):
    __tablename__ = "inbound_invoice_attachments"
    id = Column(String, primary_key=True, default=_uuid)
    inbound_invoice_id = Column(String, ForeignKey("inbound_invoices.id"), nullable=False, index=True)
    kind = Column(String, nullable=False)
    storage_key = Column(String, nullable=False)
    sha256 = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    inbound_invoice: Mapped["InboundInvoice"] = relationship(
        "InboundInvoice",
        back_populates="attachments",
    )


class InboundInvoiceEvent(Base):
    __tablename__ = "inbound_invoice_events"
    id = Column(String, primary_key=True, default=_uuid)
    inbound_invoice_id = Column(String, ForeignKey("inbound_invoices.id"), nullable=False, index=True)
    type = Column(String, nullable=False)
    payload_hash = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    inbound_invoice: Mapped["InboundInvoice"] = relationship(
        "InboundInvoice",
        back_populates="events",
    )


class EReportingEvent(Base):
    __tablename__ = "ereporting_events"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    provider_slug = Column(String, nullable=True)
    type = Column(String, nullable=False)
    status = Column(String, nullable=False, default="pending")
    external_id = Column(String, nullable=True, index=True)
    payload_hash = Column(String, nullable=True)
    amounts = Column(JSON, nullable=True)
    payment_date = Column(Date, nullable=True)
    country = Column(String, nullable=True)
    client_country = Column(String, nullable=True)
    client_vat_number = Column(String, nullable=True)
    client_type = Column(String, nullable=True)
    attempts = Column(Integer, nullable=False, default=0)
    last_attempt_at = Column(DateTime, nullable=True)
    next_retry_at = Column(DateTime, nullable=True)
    sent_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class EReportingReport(Base):
    __tablename__ = "ereporting_reports"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    provider_slug = Column(String, nullable=True)
    report_type = Column(String, nullable=False)
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    status = Column(String, nullable=False, default="pending")
    external_id = Column(String, nullable=True, index=True)
    idempotency_hash = Column(String, nullable=False, index=True)
    payload_hash = Column(String, nullable=True)
    line_count = Column(Integer, nullable=False, default=0)
    attempts = Column(Integer, nullable=False, default=0)
    last_attempt_at = Column(DateTime, nullable=True)
    next_retry_at = Column(DateTime, nullable=True)
    sent_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    lines: Mapped[list["EReportingLine"]] = relationship(
        "EReportingLine",
        back_populates="report",
        cascade="all, delete-orphan",
    )
    __table_args__ = (Index("ix_ereporting_reports_tenant_period", "tenant_id", "period_start", "period_end"),)


class EReportingLine(Base):
    __tablename__ = "ereporting_lines"
    id = Column(String, primary_key=True, default=_uuid)
    report_id = Column(String, ForeignKey("ereporting_reports.id"), nullable=False, index=True)
    source_type = Column(String, nullable=False)
    source_id = Column(String, nullable=True, index=True)
    event_type = Column(String, nullable=False)
    status = Column(String, nullable=False, default="pending")
    external_id = Column(String, nullable=True)
    payload_hash = Column(String, nullable=True)
    amounts = Column(JSON, nullable=True)
    payment_date = Column(Date, nullable=True)
    country = Column(String, nullable=True)
    client_country = Column(String, nullable=True)
    client_vat_number = Column(String, nullable=True)
    client_type = Column(String, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    report: Mapped["EReportingReport"] = relationship("EReportingReport", back_populates="lines")


class UsageMetric(Base):
    __tablename__ = "usage_metrics"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    period = Column(String, nullable=False, index=True)
    metrics_json = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "period", name="uniq_usage_metric_per_tenant_period"),)


class FlowTopup(Base):
    __tablename__ = "flow_topups"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    stripe_session_id = Column(String, unique=True, nullable=True, index=True)
    period_start = Column(Date, nullable=False)
    quantity = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    __table_args__ = (Index("ix_flow_topups_tenant_period", "tenant_id", "period_start"),)


class BillableEvent(Base):
    __tablename__ = "billable_events"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=True, index=True)
    event_type = Column(String, nullable=False)
    provider_slug = Column(String, nullable=True)
    status = Column(String, nullable=True)
    source_type = Column(String, nullable=False)
    source_id = Column(String, nullable=False)
    occurred_at = Column(DateTime, default=_utcnow, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("tenant_id", "source_type", "source_id", name="uniq_billable_event_source"),
        Index("ix_billable_events_tenant_occurred", "tenant_id", "occurred_at"),
    )


class StripeEvent(Base):
    __tablename__ = "stripe_events"
    id = Column(String, primary_key=True, default=_uuid)
    event_id = Column(String, unique=True, nullable=False, index=True)
    received_at = Column(DateTime, default=_utcnow, nullable=False)
    processed_at = Column(DateTime, nullable=True)


class TokenWallet(Base):
    __tablename__ = "token_wallets"
    tenant_id = Column(String, ForeignKey("tenants.id"), primary_key=True)
    balance = Column(Integer, nullable=False, default=0)
    welcome_bonus_granted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class TokenTopup(Base):
    __tablename__ = "token_topups"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    stripe_session_id = Column(String, unique=True, nullable=False, index=True)
    stripe_payment_intent_id = Column(String, nullable=True, index=True)
    tokens = Column(Integer, nullable=False)
    amount_eur = Column(Numeric(10, 2), nullable=False)
    currency = Column(String, nullable=False, default="eur")
    status = Column(String, nullable=False, default="paid")
    provider_token_reservation_id = Column(
        String,
        ForeignKey("provider_token_reservations.id"),
        nullable=True,
        index=True,
    )
    provider_token_allocation_id = Column(
        String,
        ForeignKey("provider_token_allocations.id"),
        nullable=True,
        index=True,
    )
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class TokenLedger(Base):
    __tablename__ = "token_ledger"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    delta = Column(Integer, nullable=False)
    type = Column(String, nullable=False)
    reference_type = Column(String, nullable=False)
    reference_id = Column(String, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    __table_args__ = (UniqueConstraint("tenant_id", "reference_type", "reference_id", name="uniq_token_ledger_ref"),)


class ProviderTokenInventory(Base):
    """Provider-side collateral kept separate from customer token wallets."""

    __tablename__ = "provider_token_inventories"
    id = Column(String, primary_key=True, default=_uuid)
    provider_slug = Column(String, nullable=False)
    purchased_tokens = Column(Integer, nullable=False, default=0)
    available_tokens = Column(Integer, nullable=False, default=0)
    reserved_tokens = Column(Integer, nullable=False, default=0)
    allocated_tokens = Column(Integer, nullable=False, default=0)
    consumed_tokens = Column(Integer, nullable=False, default=0)
    warning_threshold = Column(Integer, nullable=False, default=1000)
    critical_threshold = Column(Integer, nullable=False, default=250)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    __table_args__ = (
        CheckConstraint("purchased_tokens >= 0", name="ck_provider_inventory_purchased_nonnegative"),
        CheckConstraint("available_tokens >= 0", name="ck_provider_inventory_available_nonnegative"),
        CheckConstraint("reserved_tokens >= 0", name="ck_provider_inventory_reserved_nonnegative"),
        CheckConstraint("allocated_tokens >= 0", name="ck_provider_inventory_allocated_nonnegative"),
        CheckConstraint("consumed_tokens >= 0", name="ck_provider_inventory_consumed_nonnegative"),
        CheckConstraint("critical_threshold >= 0", name="ck_provider_inventory_critical_nonnegative"),
        CheckConstraint(
            "warning_threshold >= critical_threshold",
            name="ck_provider_inventory_threshold_order",
        ),
        CheckConstraint(
            "purchased_tokens = available_tokens + reserved_tokens + allocated_tokens + consumed_tokens",
            name="ck_provider_inventory_conservation",
        ),
        UniqueConstraint(
            "provider_slug",
            name="uniq_provider_token_inventory_provider",
        ),
    )


class ProviderTokenReservation(Base):
    """Expiring, idempotent hold before customer tokens are credited."""

    __tablename__ = "provider_token_reservations"
    id = Column(String, primary_key=True, default=_uuid)
    inventory_id = Column(String, ForeignKey("provider_token_inventories.id"), nullable=False)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False)
    idempotency_key = Column(String, nullable=False)
    quantity = Column(Integer, nullable=False)
    status = Column(String, nullable=False, default="reserved")
    expires_at = Column(DateTime, nullable=False)
    stripe_checkout_session_id = Column(String, nullable=True)
    stripe_checkout_kind = Column(String, nullable=True)
    stripe_checkout_bound_at = Column(DateTime, nullable=True)
    finalized_at = Column(DateTime, nullable=True)
    released_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_provider_token_reservation_quantity"),
        CheckConstraint(
            "status IN ('reserved', 'finalized', 'released', 'expired')",
            name="ck_provider_token_reservation_status",
        ),
        UniqueConstraint(
            "inventory_id",
            "tenant_id",
            "idempotency_key",
            name="uniq_provider_token_reservation_idempotency",
        ),
        UniqueConstraint(
            "stripe_checkout_session_id",
            name="uniq_provider_token_reservation_checkout_session",
        ),
        Index(
            "ix_provider_token_reservations_expiry",
            "inventory_id",
            "status",
            "expires_at",
        ),
        Index(
            "ix_provider_token_reservations_tenant",
            "tenant_id",
            "status",
        ),
    )


class ProviderTokenAllocation(Base):
    """Provider tokens irrevocably earmarked for one tenant."""

    __tablename__ = "provider_token_allocations"
    id = Column(String, primary_key=True, default=_uuid)
    inventory_id = Column(String, ForeignKey("provider_token_inventories.id"), nullable=False)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False)
    reservation_id = Column(
        String,
        ForeignKey("provider_token_reservations.id"),
        nullable=True,
    )
    idempotency_key = Column(String, nullable=False)
    quantity = Column(Integer, nullable=False)
    available_tokens = Column(Integer, nullable=False)
    consumed_tokens = Column(Integer, nullable=False, default=0)
    released_tokens = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_provider_token_allocation_quantity"),
        CheckConstraint("available_tokens >= 0", name="ck_provider_token_allocation_available"),
        CheckConstraint("consumed_tokens >= 0", name="ck_provider_token_allocation_consumed"),
        CheckConstraint("released_tokens >= 0", name="ck_provider_token_allocation_released"),
        CheckConstraint(
            "quantity = available_tokens + consumed_tokens + released_tokens",
            name="ck_provider_token_allocation_conservation",
        ),
        UniqueConstraint(
            "reservation_id",
            name="uniq_provider_token_allocation_reservation",
        ),
        UniqueConstraint(
            "inventory_id",
            "tenant_id",
            "idempotency_key",
            name="uniq_provider_token_allocation_idempotency",
        ),
        Index(
            "ix_provider_token_allocations_tenant",
            "inventory_id",
            "tenant_id",
            "created_at",
        ),
    )


class ProviderTokenLedgerEvent(Base):
    """Immutable header for one balanced provider-token movement."""

    __tablename__ = "provider_token_ledger_events"
    id = Column(String, primary_key=True, default=_uuid)
    inventory_id = Column(String, ForeignKey("provider_token_inventories.id"), nullable=False)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=True)
    allocation_id = Column(String, ForeignKey("provider_token_allocations.id"), nullable=True)
    reversal_of_event_id = Column(
        String,
        ForeignKey("provider_token_ledger_events.id"),
        nullable=True,
    )
    event_type = Column(String, nullable=False)
    idempotency_key = Column(String, nullable=False)
    quantity = Column(Integer, nullable=False)
    reference_type = Column(String, nullable=True)
    reference_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_provider_token_ledger_event_quantity"),
        UniqueConstraint(
            "inventory_id",
            "idempotency_key",
            name="uniq_provider_token_ledger_event_idempotency",
        ),
        Index(
            "ix_provider_token_ledger_events_inventory_created",
            "inventory_id",
            "created_at",
        ),
        Index(
            "ix_provider_token_ledger_events_tenant_created",
            "tenant_id",
            "created_at",
        ),
        Index(
            "ix_provider_token_ledger_events_reversal",
            "reversal_of_event_id",
        ),
    )


class ProviderTokenLedgerEntry(Base):
    """One immutable debit/credit line; services always append exactly two."""

    __tablename__ = "provider_token_ledger_entries"
    id = Column(String, primary_key=True, default=_uuid)
    event_id = Column(
        String,
        ForeignKey("provider_token_ledger_events.id", ondelete="RESTRICT"),
        nullable=False,
    )
    inventory_id = Column(String, ForeignKey("provider_token_inventories.id"), nullable=False)
    entry_index = Column(Integer, nullable=False)
    account = Column(String, nullable=False)
    delta = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    __table_args__ = (
        CheckConstraint("entry_index IN (1, 2)", name="ck_provider_token_ledger_entry_index"),
        CheckConstraint(
            "account IN ('purchased', 'available', 'reserved', 'allocated', 'consumed')",
            name="ck_provider_token_ledger_entry_account",
        ),
        CheckConstraint("delta <> 0", name="ck_provider_token_ledger_entry_delta"),
        UniqueConstraint("event_id", "entry_index", name="uniq_provider_token_ledger_entry_index"),
        Index(
            "ix_provider_token_ledger_entries_inventory",
            "inventory_id",
            "created_at",
        ),
    )


class ProviderTokenAllocationMovement(Base):
    """Immutable per-allocation split for consume/refund/release events."""

    __tablename__ = "provider_token_allocation_movements"
    id = Column(String, primary_key=True, default=_uuid)
    event_id = Column(
        String,
        ForeignKey("provider_token_ledger_events.id", ondelete="RESTRICT"),
        nullable=False,
    )
    allocation_id = Column(
        String,
        ForeignKey("provider_token_allocations.id", ondelete="RESTRICT"),
        nullable=False,
    )
    movement_index = Column(Integer, nullable=False)
    available_delta = Column(Integer, nullable=False, default=0)
    consumed_delta = Column(Integer, nullable=False, default=0)
    released_delta = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    __table_args__ = (
        CheckConstraint("movement_index > 0", name="ck_provider_token_allocation_movement_index"),
        CheckConstraint(
            "available_delta + consumed_delta + released_delta = 0",
            name="ck_provider_token_allocation_movement_conservation",
        ),
        CheckConstraint(
            "available_delta <> 0 OR consumed_delta <> 0 OR released_delta <> 0",
            name="ck_provider_token_allocation_movement_nonzero",
        ),
        UniqueConstraint(
            "event_id",
            "movement_index",
            name="uniq_provider_token_allocation_movement_index",
        ),
        UniqueConstraint(
            "event_id",
            "allocation_id",
            name="uniq_provider_token_allocation_movement_allocation",
        ),
        Index(
            "ix_provider_token_allocation_movements_allocation",
            "allocation_id",
            "created_at",
        ),
    )


class WebhookEndpoint(Base):
    __tablename__ = "webhook_endpoints"
    id = Column(String, primary_key=True, default=_uuid)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    url = Column(Text, nullable=False)
    status = Column(String, nullable=False, default="active")
    events = Column(JSON, nullable=False, default=list)
    encrypted_secret = Column(LargeBinary, nullable=True)
    last_status_code = Column(Integer, nullable=True)
    last_success_at = Column(DateTime, nullable=True)
    last_failure_at = Column(DateTime, nullable=True)
    last_error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class WebhookDeliveryOutbox(Base):
    """Durable, tenant-scoped delivery state for customer webhooks.

    A stable ``id`` is reused across attempts so webhook consumers can dedupe
    the unavoidable at-least-once delivery window (HTTP success followed by a
    worker crash before the local commit).
    """

    __tablename__ = "webhook_delivery_outbox"
    id = Column(String, primary_key=True)
    tenant_id = Column(String, ForeignKey("tenants.id"), nullable=False, index=True)
    endpoint_id = Column(
        String,
        ForeignKey("webhook_endpoints.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    event_id = Column(String, nullable=False, index=True)
    event_type = Column(String, nullable=False)
    payload = Column(JSON, nullable=False)
    idempotency_key = Column(String, nullable=False)
    status = Column(String, nullable=False, default="pending")
    attempt_count = Column(Integer, nullable=False, default=0)
    max_attempts = Column(Integer, nullable=False, default=8)
    next_attempt_at = Column(DateTime, nullable=False, default=_utcnow)
    locked_at = Column(DateTime, nullable=True)
    lock_token = Column(String, nullable=True)
    last_attempt_at = Column(DateTime, nullable=True)
    delivered_at = Column(DateTime, nullable=True)
    last_status_code = Column(Integer, nullable=True)
    last_error_code = Column(String, nullable=True)
    last_error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uniq_webhook_delivery_idempotency"),
        CheckConstraint(
            "status IN ('pending', 'queued', 'processing', 'retry', 'delivered', 'failed', 'cancelled')",
            name="ck_webhook_delivery_status",
        ),
        CheckConstraint("attempt_count >= 0", name="ck_webhook_delivery_attempt_count"),
        CheckConstraint("max_attempts > 0", name="ck_webhook_delivery_max_attempts"),
        Index(
            "ix_webhook_delivery_due",
            "status",
            "next_attempt_at",
            "created_at",
        ),
        Index(
            "ix_webhook_delivery_tenant_status",
            "tenant_id",
            "status",
            "created_at",
        ),
    )
