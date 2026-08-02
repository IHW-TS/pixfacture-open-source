import ipaddress
import json
import logging
import os
import re
from datetime import date, datetime

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from urllib.parse import urlparse

from .legal_documents import is_adopted_legal_document

logger = logging.getLogger(__name__)


_ALLOWED_APP_ENVS = ("local", "dev", "test", "staging", "prod", "production")
_PROD_APP_ENVS = {"prod", "production", "staging"}
_STRIPE_TOKEN_PACK_SIZES = (100, 500, 1000, 5000)
_STRIPE_PLACEHOLDER_IDS = {"aaa", "bbb", "todo", "tbd", "change_me", "changeme", "placeholder"}
_CONFIG_PLACEHOLDER_TOKENS = (
    "changeme",
    "change-me",
    "change_me",
    "placeholder",
    "replace-me",
    "replace_me",
    "todo",
    "your_",
    "example.com",
    "example.test",
    "example.org",
    "<",
    ">",
)
_DEFAULT_DEMO_PASSWORD = "ChangeMeDemoPassword123!"


def _normalize_app_env(value: object | None) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip().lower()
    return str(value).strip().lower()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_ENV: str = "dev"
    SECRET_KEY: str = "changeme"
    PASSWORD_MIN_LENGTH: int = 12
    PASSWORD_MAX_LENGTH: int = 256
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    REDIS_URL: str | None = None
    DISABLE_RATE_LIMITS: bool = False
    RATE_LIMITS_BREAK_GLASS: bool = False
    REGISTER_DAILY_MAX_PER_IP: int = 0
    REGISTER_DAILY_GLOBAL_MAX: int = 0
    REGISTER_DAILY_WINDOW_SECONDS: int = 24 * 60 * 60
    DATABASE_URL: str = "postgresql+psycopg2://postgres:postgres@db:5432/sass_facturation"
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    DB_POOL_TIMEOUT_SECONDS: int = 30
    DB_POOL_RECYCLE_SECONDS: int = 1800
    DB_STATEMENT_TIMEOUT_MS: int = 30_000
    DB_LOCK_TIMEOUT_MS: int = 5_000
    DB_APPLICATION_NAME: str = "pixfacture-api"
    CORS_ORIGINS: str = "*"
    PUBLIC_BASE_URL: str | None = None
    FRONTEND_BASE_URL: str | None = None
    TRUSTED_HOSTS: str | None = None
    ALLOWED_HOSTS: str | None = None
    PLATFORM_ALLOWED_HOSTS: str | None = None
    # Optional customer-only restriction. Empty means any DNS host whose full
    # resolution is public; it never inherits PLATFORM_ALLOWED_HOSTS.
    CUSTOMER_WEBHOOK_ALLOWED_HOSTS: str | None = None
    ALLOW_HTTP_OUTBOUND: bool = False
    ALLOW_PRIVATE_OUTBOUND: bool = False
    TRUSTED_PROXY_CIDRS: str = "127.0.0.1/32,::1/128"
    TRUSTED_PROXY_ALWAYS: bool = False

    # PISTE/Chorus
    PISTE_CLIENT_ID: str | None = None
    PISTE_CLIENT_SECRET: str | None = None
    PISTE_TOKEN_URL: str | None = "https://sandbox-oauth.piste.gouv.fr/api/oauth/token"
    CHORUS_API_BASE: str | None = "https://sandbox-api.piste.gouv.fr"
    CHORUS_SUBMIT_PATH: str | None = None
    CHORUS_STATUS_PATH: str | None = None
    CHORUS_SUBMIT_EXTRA_JSON: str | None = None
    # Legacy input kept for configuration compatibility only. Runtime ignores
    # it: cpro-account is always resolved from the tenant IntegrationSecret.
    CHORUS_CPRO_ACCOUNT: str | None = None
    PARTNERX_BASE_URL: str | None = None
    PARTNER_PLATFORM: str | None = None
    SEQINO_BASE_URL: str | None = None
    SEQINO_API_KEY: str | None = None
    SEQINO_ACCESS_TOKEN: str | None = None
    SEQINO_SPONSOR_ID: str | None = None
    SEQINO_WEBHOOK_SECRET: str | None = None
    SEQINO_WEBHOOK_MAX_AGE_SECONDS: int = 300
    SEQINO_DEMO_MODE: bool = False

    # Demo / Sandbox (staging / demos)
    DEMO_MODE_ENABLED: bool = False
    DEMO_MODE_ALLOW_RESET: bool = False
    DEMO_MODE_TENANT_SLUG: str = "demo"
    DEMO_MODE_TENANT_NAME: str = "Entreprise Démo"
    DEMO_MODE_ADMIN_EMAIL: str = "demo@example.com"
    DEMO_MODE_ADMIN_PASSWORD: str = "ChangeMeDemoPassword123!"
    DEMO_MODE_DATASET: str = "default"

    REQUIRE_SEQINO_IN_PROD: bool = False
    SEQINO_USAGE_COST_INVOICE_EUR: float = 0.0
    SEQINO_USAGE_COST_REPORTING_EUR: float = 0.0
    SEQINO_USAGE_INTERVAL_SECONDS: int = 2592000

    # Annuaire PPF (B2B)
    PPF_DIRECTORY_BASE_URL: str | None = None
    PPF_DIRECTORY_CLIENT_ID: str | None = None
    PPF_DIRECTORY_CLIENT_SECRET: str | None = None
    PPF_DIRECTORY_TOKEN_URL: str | None = None
    PPF_DIRECTORY_AUDIENCE: str | None = None

    # SIRENE lookup (auto-remplissage entreprise)
    SIRENE_PROVIDER: str = "recherche"
    SIRENE_API_BASE_URL: str | None = None
    SIRENE_API_TOKEN: str | None = None
    INSEE_API_KEY: str | None = None
    SIRENE_LOOKUP_TIMEOUT_SECONDS: int = 8
    SIRENE_LOOKUP_CACHE_SECONDS: int = 86400
    WEBHOOK_TIMEOUT_SECONDS: int = 8
    WEBHOOK_DNS_TIMEOUT_SECONDS: float = 3.0
    WEBHOOK_DELIVERY_MAX_ATTEMPTS: int = 8
    WEBHOOK_RETRY_BASE_SECONDS: int = 30
    WEBHOOK_RETRY_MAX_SECONDS: int = 3600
    WEBHOOK_OUTBOX_SWEEP_INTERVAL_SECONDS: int = 30
    WEBHOOK_OUTBOX_BATCH_SIZE: int = 100
    WEBHOOK_OUTBOX_LOCK_TTL_SECONDS: int = 300
    WEBHOOK_OUTBOX_RETENTION_DAYS: int = 90

    # Stripe
    STRIPE_PUBLIC_KEY: str | None = None
    STRIPE_SECRET_KEY: str | None = None
    # Test-only override used by the disposable exact-image E2E stack. The
    # production validator below refuses any custom Stripe API endpoint.
    STRIPE_API_BASE: str | None = None
    STRIPE_PRICE_STARTER: str | None = None
    STRIPE_PRICE_STARTER_MONTHLY: str | None = None
    STRIPE_PRICE_STARTER_YEARLY: str | None = None
    STRIPE_PRICE_PRO: str | None = None
    STRIPE_PRICE_PRO_MONTHLY: str | None = None
    STRIPE_PRICE_PRO_YEARLY: str | None = None
    STRIPE_PRICE_ENTERPRISE: str | None = None
    STRIPE_PRICE_TOKENS_100: str | None = None
    STRIPE_PRICE_TOKENS_500: str | None = None
    STRIPE_PRICE_TOKENS_1000: str | None = None
    STRIPE_PRICE_TOKENS_5000: str | None = None
    # Deprecated: ancien topup de flux mensuels.
    STRIPE_PRICE_FLOW_TOPUP: str | None = None
    STRIPE_WEBHOOK_SECRET: str | None = None
    STRIPE_WEBHOOK_MAX_BYTES: int = 262144
    ENFORCE_STRIPE_SIGNATURE: bool | None = None
    STRIPE_SUCCESS_URL: str | None = None
    STRIPE_CANCEL_URL: str | None = None
    STRIPE_CUSTOMER_PORTAL_RETURN_URL: str | None = None
    # Dedicated Stripe Billing Portal configuration.  It must keep
    # subscription updates disabled so every upgrade to Pro goes through the
    # stock-reserving Checkout flow.
    STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID: str | None = None
    STRIPE_TOKENS_SUCCESS_URL: str | None = None
    STRIPE_TOKENS_CANCEL_URL: str | None = None
    # Paiement des factures (portail client) via Stripe Checkout
    STRIPE_INVOICE_PAYMENTS_ENABLED: bool = False

    BILLING_ENABLED: bool = False
    ALLOW_INSECURE_STRIPE_WEBHOOK: bool = False
    # Deprecated compatibility only: ancien modèle quota/overage, non utilisé par l'offre produit actuelle.
    BILLING_INCLUDED_FLOWS_STARTER: int = 0
    BILLING_INCLUDED_FLOWS_PRO: int = 0
    SEQINO_WELCOME_TOKENS_PRO: int = 50
    BILLING_OVERAGE_RATE_EUR: float = 0.25
    BILLING_OVERAGE_POLICY: str = "strict"
    SEQINO_COST_PER_FLOW_EUR: float | None = None

    # SMTP
    SMTP_ENABLED: bool = False
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_USERNAME: str | None = None
    SMTP_PASSWORD: str | None = None
    SMTP_FROM: str | None = None
    SMTP_STARTTLS: bool = True
    BREVO_WEBHOOK_TOKEN: str | None = None
    BREVO_WEBHOOK_USERNAME: str | None = None
    BREVO_WEBHOOK_PASSWORD: str | None = None
    BREVO_WEBHOOK_MAX_BYTES: int = 262144
    BREVO_WEBHOOK_MAX_EVENTS: int = 100
    SALES_EMAIL: str | None = None
    INVITE_LOG_LINK: bool = False
    INVOICE_EMAIL_RATE_LIMIT_PER_HOUR: int = 30
    # Relances automatiques factures (dunning).
    INVOICE_FOLLOWUP_AUTOMATIC_ENABLED: bool = True
    INVOICE_FOLLOWUP_SCHEDULE_DAYS: str | None = None  # ex: "-2,3,10" (jours relatifs à l'échéance)
    INVOICE_FOLLOWUP_MIN_INTERVAL_HOURS: int = 24
    INVOICE_FOLLOWUP_ATTACH_PDF: bool = True

    INVOICE_EMAIL_RATE_LIMIT_PER_DAY: int = 200
    QUOTE_EMAIL_RATE_LIMIT_PER_HOUR: int = 30
    QUOTE_EMAIL_RATE_LIMIT_PER_DAY: int = 200
    QUOTE_FOLLOWUP_INTERVAL_SECONDS: int = 3600
    QUOTE_FOLLOWUP_AFTER_DAYS: int = 3
    QUOTE_FOLLOWUP_BEFORE_EXPIRY_DAYS: int = 2
    QUOTE_FOLLOWUP_MAX_REMINDERS: int = 2
    # Portail devis
    QUOTE_PUBLIC_VIEW_WINDOW_SECONDS: int = 600  # 10 minutes
    QUOTE_PUBLIC_LINK_TTL_DAYS: int = 30
    QUOTE_PUBLIC_RATE_LIMIT_PER_MINUTE: int = 120
    QUOTE_PUBLIC_IP_RATE_LIMIT_PER_MINUTE: int = 600

    # Portail factures (public)
    INVOICE_PUBLIC_VIEW_WINDOW_SECONDS: int = 600  # 10 minutes
    INVOICE_PUBLIC_LINK_TTL_DAYS: int = 30
    INVOICE_PUBLIC_RATE_LIMIT_PER_MINUTE: int = 120
    INVOICE_PUBLIC_IP_RATE_LIMIT_PER_MINUTE: int = 600
    CUSTOMER_PORTAL_VIEW_WINDOW_SECONDS: int = 600  # 10 minutes
    CUSTOMER_PORTAL_LINK_TTL_DAYS: int = 30
    CUSTOMER_PORTAL_RATE_LIMIT_PER_MINUTE: int = 120
    CUSTOMER_PORTAL_IP_RATE_LIMIT_PER_MINUTE: int = 600

    # Relances automatiques factures (dunning) — optionnel mais utile en B2B
    INVOICE_FOLLOWUP_INTERVAL_SECONDS: int = 3600
    INVOICE_FOLLOWUP_BEFORE_DUE_DAYS: int = 2
    INVOICE_FOLLOWUP_AFTER_DUE_DAYS: int = 3
    INVOICE_FOLLOWUP_SECOND_AFTER_DUE_DAYS: int = 10
    INVOICE_FOLLOWUP_MAX_REMINDERS: int = 3
    # OTP (acceptation devis)
    QUOTE_OTP_TTL_SECONDS: int = 600
    QUOTE_OTP_MAX_ATTEMPTS: int = 5
    QUOTE_OTP_MIN_RESEND_SECONDS: int = 60
    QUOTE_OTP_RATE_LIMIT_PER_HOUR: int = 6
    # Customer accounts may opt in to MFA regardless of their tenant role.
    # Only platform administrators are required to enroll when this flag is on.
    MFA_ENFORCE_PLATFORM_ADMINS: bool = False

    # Identité fournisseur (Factur-X / Chorus)
    SUPPLIER_NAME: str = "Mon SaaS"
    SUPPLIER_SIRET: str | None = None
    SUPPLIER_PHONE: str | None = None
    SUPPLIER_EMAIL: str | None = None
    NEXT_PUBLIC_LEGAL_COMPANY_EMAIL: str | None = None
    NEXT_PUBLIC_LEGAL_EMAIL: str | None = None
    NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL: str | None = None
    NEXT_PUBLIC_LEGAL_COMPANY_PHONE: str | None = None
    NEXT_PUBLIC_CONTACT_PHONE: str | None = None
    FACTURX_PROFILE: str = "en16931"
    FACTURX_PDFA_MODE: str | None = None
    FACTURX_PDFA_VALIDATION: str = "warn"
    FACTURX_PDFA_CONVERT: bool = False
    FACTURX_VERSION: str = "1.0.8"
    FACTURX_SPEC_VERSION: str = "1.08"
    FACTURX_ALLOW_FALLBACK: bool = False
    FACTURX_STRICT: bool = False
    UBL_EXPORT_ENABLED: bool = False
    FR_DGFIP_SPEC_TARGET: str = "2026"
    FR_COMPLIANCE_2027_ENABLED: bool = False
    FR_2027_VALIDATION_COMPLETE: bool = False
    INVOICE_COMPLIANCE_STRICT: bool = False
    COMPLIANCE_ARTIFACTS_DIR: str | None = None
    EINVOICING_EXPORT_ONLY: bool = False
    # Exact tenant ids allowed to perform connected provider I/O. Empty is
    # deliberately fail-closed; ``*`` is accepted only in non-production tests.
    CONNECTED_MODE_ALLOWED_TENANT_IDS: str = ""
    # Exact provider slugs allowed during the connected rollout. This second
    # dimension prevents enabling (for example) Seqino merely because a tenant
    # was allowlisted for a Chorus pilot. Empty is deliberately fail-closed;
    # ``*`` is accepted only in non-production tests.
    CONNECTED_MODE_ALLOWED_PROVIDERS: str = ""
    ENABLE_LEGACY_EINVOICING_API: bool | None = None
    FEC_JOURNAL_CODE: str = "VE"
    FEC_JOURNAL_LABEL: str = "Ventes"
    FEC_ACCOUNT_CUSTOMER: str = "411"
    FEC_ACCOUNT_REVENUE: str = "706"
    FEC_ACCOUNT_VAT: str = "44571"

    # Observabilité
    SENTRY_DSN: str | None = None
    SENTRY_TRACES_SAMPLE_RATE: float = 0.1
    SENTRY_SEND_PII: bool = False
    SENTRY_SEND_DEFAULT_PII: bool = False
    LOG_LEVEL: str = "INFO"
    METRICS_BEARER_TOKEN: str | None = None

    # Abonnements
    SUBSCRIPTION_REQUIRED: bool = False
    FEATURE_CLIENT_PORTAL: bool = True
    ALLOW_DUMMY_IN_PROD: bool = False
    NEXT_PUBLIC_ENABLE_PDP_INTEGRATION: bool = False
    NEXT_PUBLIC_ENABLE_PPF_DIRECTORY: bool = False
    NEXT_PUBLIC_ENABLE_EINVOICING_PAGES: bool = False
    NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL: str = "export_only"
    NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS: str | None = None
    NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA: str | None = None
    LEGAL_DOC_SHA256_TERMS: str | None = None
    LEGAL_DOC_SHA256_DPA: str | None = None
    LEGAL_TERMS_ACCEPTANCE_REQUIRED: bool = False
    LEGAL_DPA_ACCEPTANCE_REQUIRED: bool = False
    # Test-harness only: exercise the same legal acceptance contract while
    # APP_ENV=test keeps every provider and database disposable.
    LEGAL_ACCEPTANCE_TEST_MODE: bool = False
    BILLING_PROFILE_TEST_MODE: bool = False

    # Auth sociale / plateforme
    GOOGLE_CLIENT_ID: str | None = None
    PLATFORM_ADMIN_ENABLED: bool = True
    AUTH_COOKIE_MODE: bool = False
    BEARER_MODE: bool = False
    REQUIRE_EMAIL_VERIFICATION: bool = False
    PDP_ENCRYPTION_KEY: str | None = None
    PDP_ENCRYPTION_KEYS: str | None = None
    PDP_ENCRYPTION_KID: str | None = None
    PDP_STORE_RAW_JSON: bool = False
    PDP_IDEMPOTENCY_KEY_ENABLED: bool = True
    PDP_RAW_JSON_RETENTION_DAYS: int = 7
    PDP_RAW_JSON_MAX_BYTES: int = 8192
    ENABLE_HTTP_GENERIC_CONNECTOR: bool = False
    ALLOW_TENANT_CONNECTORS: bool = False
    HTTP_GENERIC_MAX_PAYLOAD_BYTES: int = 10 * 1024 * 1024
    HTTP_GENERIC_RATE_LIMIT_COUNT: int = 60
    HTTP_GENERIC_RATE_LIMIT_WINDOW_SECONDS: int = 60
    JOBS_SYNC: bool = False
    JOBS_QUEUE_NAME: str = "default"
    JOBS_QUEUE_CRITICAL: str = "critical"
    JOBS_QUEUE_EMAILS: str = "emails"
    JOBS_QUEUE_PDF: str = "pdf"
    JOBS_QUEUE_EXPORTS: str = "exports"
    JOBS_QUEUE_INTEGRATIONS: str = "integrations"
    JOBS_QUEUE_LOW: str = "low"
    JOBS_TIMEOUT_SECONDS: int = 900
    JOBS_RESULT_TTL: int = 3600
    EMAIL_JOBS_QUEUE_NAME: str = "emails"
    EMAIL_JOBS_TIMEOUT_SECONDS: int = 300
    EMAIL_JOBS_MAX_ATTEMPTS: int = 4
    EMAIL_JOBS_RETRY_BASE_SECONDS: int = 60
    EMAIL_JOBS_RETRY_MAX_SECONDS: int = 900
    PERIODIC_JOBS_REQUIRED_MODES: str = ""
    PERIODIC_HEARTBEAT_MIN_TTL_SECONDS: int = 600
    SEQINO_TOKEN_INVENTORY_INTERVAL_SECONDS: int = 300
    SEQINO_TOKEN_INVENTORY_EXPIRY_BATCH_SIZE: int = 500
    EINVOICING_SYNC_INTERVAL_SECONDS: int = 300
    INBOX_POLL_INTERVAL_SECONDS: int = 300
    DIRECTORY_SYNC_INTERVAL_SECONDS: int = 86400
    EREPORTING_BATCH_SIZE: int = 100
    EREPORTING_MAX_ATTEMPTS: int = 5
    EREPORTING_RETRY_BASE_SECONDS: int = 60
    EREPORTING_RETRY_MAX_SECONDS: int = 3600
    EREPORTING_RETRY_INTERVAL_SECONDS: int = 300
    EREPORTING_REPORT_BATCH_SIZE: int = 50
    EREPORTING_REPORT_LINE_BATCH_SIZE: int = 200
    EREPORTING_GENERATE_INTERVAL_SECONDS: int = 86400
    EREPORTING_SEQINO_MODE: str | None = "payments_only"
    COOKIE_SAMESITE: str = "lax"
    COOKIE_DOMAIN: str | None = None
    COOKIE_SECURE: bool | None = None
    STRICT_COOKIE_CONFIG: bool = False
    ASSET_CDN_HOST: str | None = None
    STORAGE_PROVIDER: str = "local"
    ALLOW_LOCAL_STORAGE_IN_PROD: bool = False
    STORAGE_BUCKET: str | None = None
    S3_BUCKET: str | None = None
    S3_BUCKET_VERSIONING: bool = False
    S3_ENDPOINT: str | None = None
    S3_ENDPOINT_URL: str | None = None
    S3_REGION: str | None = None
    S3_ACCESS_KEY: str | None = None
    S3_ACCESS_KEY_ID: str | None = None
    S3_SECRET_KEY: str | None = None
    S3_SECRET_ACCESS_KEY: str | None = None
    S3_FORCE_PATH_STYLE: bool = False
    S3_KMS_KEY_ID: str | None = None
    S3_OBJECT_LOCK_ENABLED: bool = False
    S3_OBJECT_LOCK_MODE: str | None = None
    S3_OBJECT_LOCK_RETENTION_DAYS: int | None = None
    STORAGE_LOCAL_ROOT: str | None = None
    STORAGE_LOCAL_PATH: str = "./storage"
    STORAGE_COST_PER_GIB_EUR: float = 0.0
    INVOICES_RETENTION_YEARS: int | None = None
    ENABLE_LEGAL_ARCHIVE: bool = False
    LEGAL_ARCHIVE: bool = False
    RETENTION_DEFAULT_YEARS: int = 10
    RETENTION_DRAFT_DAYS: int | None = None
    RETENTION_CANCELED_DAYS: int | None = None
    ACTION_LOG_RETENTION_DAYS: int = 365
    # Lifecycle des comptes d'essai. L'expiration fonctionnelle a lieu a J+7
    # via ``trial_end``. L'anonymisation destructive reste opt-in et fail-closed.
    TRIAL_LIFECYCLE_CLEANUP_ENABLED: bool = False
    TRIAL_LIFECYCLE_NOTIFICATIONS_ENABLED: bool = False
    TRIAL_UNVERIFIED_PURGE_DAYS: int = 7
    TRIAL_INACTIVE_ANONYMIZE_DAYS: int = 30
    TRIAL_PRE_ANONYMIZATION_NOTICE_DAYS: int = 7
    DEMO_INVITATION_RETENTION_DAYS: int = 30
    TRIAL_LIFECYCLE_CLEANUP_BATCH_SIZE: int = 100
    TRIAL_CLEANUP_EXCLUDED_TENANT_IDS: str = ""

    # Quotas applicatifs. Ces limites restent backend-first pour eviter les abus
    # avant le branchement S3/Object Storage.
    MAX_INVOICE_LINES: int = 200
    MAX_ATTACHMENT_SIZE_MB: int = 25
    MAX_ATTACHMENTS_PER_DOCUMENT: int = 10
    MAX_EXPORTS_PER_DAY: int = 20
    MAX_SYNC_EXPORT_ROWS: int = 5_000
    MAX_SYNC_EXPORT_BYTES_ESTIMATE: int = 10 * 1024 * 1024
    MAX_EMAILS_PER_HOUR: int = 60
    MAX_REMINDERS_PER_DAY: int = 100
    MAX_PUBLIC_DOWNLOADS_PER_MINUTE: int = 120
    MAX_API_REQUESTS_PER_MINUTE: int = 300
    MAX_API_KEYS_PER_TENANT: int = 10
    MAX_CUSTOMERS_IMPORT_ROWS: int = 5_000
    MAX_PRODUCTS_IMPORT_ROWS: int = 5_000

    # Pièces jointes (devis/factures) — stockage (local / S3 / MinIO)
    ATTACHMENTS_MAX_FILE_BYTES: int = 25 * 1024 * 1024  # 25MB par fichier
    ATTACHMENTS_MAX_PER_DOCUMENT: int = 10  # pièces jointes max / document
    # Quota global par tenant (par plan)
    ATTACHMENTS_QUOTA_STARTER_MB: int = 200  # 200MB
    ATTACHMENTS_QUOTA_PRO_MB: int = 200  # 200MB
    ATTACHMENTS_QUOTA_ENTERPRISE_MB: int = 0  # 0 = sur mesure, pas de plafond fixe

    @field_validator("APP_ENV", mode="before")
    @classmethod
    def _validate_app_env(cls, value: object) -> str:
        normalized = _normalize_app_env(value)
        if not normalized:
            raise ValueError("APP_ENV invalide: valeur vide. Valeurs autorisées: " + ", ".join(_ALLOWED_APP_ENVS) + ".")
        if normalized not in _ALLOWED_APP_ENVS:
            raise ValueError(
                f"APP_ENV invalide: {normalized!r}. Valeurs autorisées: " + ", ".join(_ALLOWED_APP_ENVS) + "."
            )
        return normalized

    @field_validator(
        "TRIAL_UNVERIFIED_PURGE_DAYS",
        "TRIAL_INACTIVE_ANONYMIZE_DAYS",
        "TRIAL_PRE_ANONYMIZATION_NOTICE_DAYS",
        "DEMO_INVITATION_RETENTION_DAYS",
        mode="before",
    )
    @classmethod
    def _validate_trial_lifecycle_days(cls, value: object) -> int:
        try:
            parsed = int(str(value).strip())
        except (TypeError, ValueError) as exc:
            raise ValueError("Le delai de cycle de vie des essais doit etre un entier positif.") from exc
        if not 1 <= parsed <= 3650:
            raise ValueError("Le delai de cycle de vie des essais doit etre compris entre 1 et 3650 jours.")
        return parsed

    @field_validator("TRIAL_LIFECYCLE_CLEANUP_BATCH_SIZE", mode="before")
    @classmethod
    def _validate_trial_lifecycle_batch_size(cls, value: object) -> int:
        try:
            parsed = int(str(value).strip())
        except (TypeError, ValueError) as exc:
            raise ValueError("La taille de lot de nettoyage des essais doit etre un entier positif.") from exc
        if not 1 <= parsed <= 1000:
            raise ValueError("La taille de lot de nettoyage des essais doit etre comprise entre 1 et 1000.")
        return parsed

    def stripe_token_prices(self) -> dict[int, str]:
        mapping = {
            100: self.STRIPE_PRICE_TOKENS_100,
            500: self.STRIPE_PRICE_TOKENS_500,
            1000: self.STRIPE_PRICE_TOKENS_1000,
            5000: self.STRIPE_PRICE_TOKENS_5000,
        }
        cleaned: dict[int, str] = {}
        for tokens, price_id in mapping.items():
            normalized = _clean_stripe_config_value(price_id)
            if normalized:
                cleaned[tokens] = normalized
        return cleaned

    def tokens_for_price_id(self, price_id: str) -> int | None:
        if not _clean_stripe_config_value(price_id):
            return None
        needle = price_id.strip()
        for tokens, mapped_price in self.stripe_token_prices().items():
            if mapped_price == needle:
                return tokens
        return None

    def stripe_subscription_prices(self) -> dict[str, str | None]:
        return {
            "starter_monthly": _clean_stripe_config_value(
                self.STRIPE_PRICE_STARTER_MONTHLY or self.STRIPE_PRICE_STARTER
            ),
            "starter_yearly": _clean_stripe_config_value(self.STRIPE_PRICE_STARTER_YEARLY),
            "pro_monthly": _clean_stripe_config_value(self.STRIPE_PRICE_PRO_MONTHLY or self.STRIPE_PRICE_PRO),
            "pro_yearly": _clean_stripe_config_value(self.STRIPE_PRICE_PRO_YEARLY),
        }

    def missing_stripe_subscription_prices(self) -> list[str]:
        prices = self.stripe_subscription_prices()
        missing: list[str] = []
        for key in ("starter_monthly", "starter_yearly", "pro_monthly", "pro_yearly"):
            if not prices.get(key):
                missing.append(key)
        return missing

    def stripe_token_pack_sizes(self) -> tuple[int, ...]:
        return _STRIPE_TOKEN_PACK_SIZES


settings = Settings()


def _app_env_value() -> str:
    return _normalize_app_env(settings.APP_ENV)


def auth_cookie_mode_enabled() -> bool:
    if "AUTH_COOKIE_MODE" in os.environ:
        return settings.AUTH_COOKIE_MODE
    return not settings.BEARER_MODE


def auth_bearer_mode_enabled() -> bool:
    return not auth_cookie_mode_enabled()


def sentry_send_default_pii_enabled() -> bool:
    if "SENTRY_SEND_DEFAULT_PII" in os.environ:
        return settings.SENTRY_SEND_DEFAULT_PII
    return settings.SENTRY_SEND_PII


def _normalize_facturx_spec_version(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    if raw in {"1.08", "1.0.8", "1.0.08"}:
        return "1.0.8"
    if raw in {"1.0.7", "1.0.07", "1.07"}:
        return "1.0.07"
    return raw


def _raw_facturx_version() -> str:
    raw = _normalize_facturx_spec_version(os.environ.get("FACTURX_SPEC_VERSION"))
    if raw:
        return raw
    raw = _normalize_facturx_spec_version(os.environ.get("FACTURX_VERSION"))
    if raw:
        return raw
    raw = _normalize_facturx_spec_version(settings.FACTURX_SPEC_VERSION)
    if raw:
        return raw
    raw = _normalize_facturx_spec_version(settings.FACTURX_VERSION)
    if raw:
        return raw
    return "1.0.8"


def _facturx_supports_spec_version(version: str) -> bool:
    try:
        from facturx import facturx as facturx_lib

        xsd_map = getattr(facturx_lib, "FACTURX_LEVEL2xsd", None)
        if not xsd_map:
            return False
        variants = {version}
        if version == "1.0.8":
            variants.update({"1.0.08", "1.08"})
        if version == "1.0.07":
            variants.update({"1.0.7", "1.07"})
        for path in xsd_map.values():
            if any(variant in path for variant in variants):
                return True
    except Exception:
        return False
    return False


def ensure_facturx_spec_supported() -> None:
    requested = _normalize_facturx_spec_version(settings.FACTURX_SPEC_VERSION) or "1.0.8"
    if requested != "1.0.8":
        return
    if _facturx_supports_spec_version("1.0.8"):
        return
    raise RuntimeError("FACTURX_SPEC_VERSION=1.08 non supportée par la lib factur-x (XSD Factur-X 1.0.8 introuvable).")


def _is_prod_env() -> bool:
    return _app_env_value() in _PROD_APP_ENVS


def _resolve_facturx_version() -> str:
    requested = _raw_facturx_version()
    if requested != "1.0.8":
        return requested
    if _facturx_supports_spec_version("1.0.8"):
        return requested
    if _is_prod_env():
        raise RuntimeError(
            "FACTURX_SPEC_VERSION=1.08 non supportée par la lib factur-x en prod/staging. "
            "Mettez à jour la lib factur-x (>=3.15)."
        )
    if not bool(settings.FACTURX_ALLOW_FALLBACK):
        raise RuntimeError(
            "FACTURX_SPEC_VERSION=1.08 non supportée par la lib factur-x et FACTURX_ALLOW_FALLBACK=false."
        )
    logger.warning("FACTURX_SPEC_VERSION=1.08 non supportée par la lib factur-x; fallback 1.0.07.")
    return "1.0.07"


settings.FACTURX_VERSION = _resolve_facturx_version()
settings.FACTURX_SPEC_VERSION = settings.FACTURX_VERSION

_raw_facturx_pdfa_mode = os.environ.get("FACTURX_PDFA_MODE")
_raw_facturx_pdfa_convert = os.environ.get("FACTURX_PDFA_CONVERT")
_env = _app_env_value()
if (
    _env in _PROD_APP_ENVS
    and (_raw_facturx_pdfa_mode is None or _raw_facturx_pdfa_mode == "")
    and (_raw_facturx_pdfa_convert is None or _raw_facturx_pdfa_convert == "")
):
    settings.FACTURX_PDFA_CONVERT = True

_raw_http_generic = os.environ.get("ENABLE_HTTP_GENERIC_CONNECTOR")
if _raw_http_generic is None or _raw_http_generic.strip() == "":
    if _env in _PROD_APP_ENVS:
        settings.ENABLE_HTTP_GENERIC_CONNECTOR = False
    else:
        settings.ENABLE_HTTP_GENERIC_CONNECTOR = True


def _normalized_connected_provider_slugs(value: str | None) -> frozenset[str]:
    normalized: set[str] = set()
    for part in (value or "").split(","):
        slug = part.strip().lower().replace("-", "_")
        if slug in {"chorus", "chorus_pro"}:
            slug = "choruspro"
        elif slug in {"partnerx", "pdp_partner", "pdp"}:
            slug = "seqino"
        if slug:
            normalized.add(slug)
    return frozenset(normalized)


def parse_connected_mode_allowed_providers(value: str | None = None) -> frozenset[str]:
    raw = settings.CONNECTED_MODE_ALLOWED_PROVIDERS if value is None else value
    return _normalized_connected_provider_slugs(raw)


def _default_periodic_jobs_required_modes(
    export_only: bool,
    allowed_providers: str | None = None,
) -> str:
    local_modes = (
        "retention,seqino_token_inventory,webhook_outbox,"
        "quote_followups,invoice_followups"
    )
    if export_only:
        return local_modes
    providers = _normalized_connected_provider_slugs(
        settings.CONNECTED_MODE_ALLOWED_PROVIDERS if allowed_providers is None else allowed_providers
    )
    if providers == {"choruspro"}:
        # Chorus B2G submission is synchronous; only status reconciliation is
        # periodic. Do not start Seqino inbox, PPF directory or e-reporting jobs
        # for an isolated Chorus pilot.
        return f"{local_modes},einvoicing_sync"
    connector_modes = (
        "einvoicing_sync,inbox_poll,directory_refresh,ereporting_generate,"
        "ereporting_retry,ereporting_report_retry"
    )
    return f"{local_modes},{connector_modes}"


_raw_periodic_required = os.environ.get("PERIODIC_JOBS_REQUIRED_MODES")
if _raw_periodic_required is None or _raw_periodic_required.strip() == "":
    if _env in _PROD_APP_ENVS:
        settings.PERIODIC_JOBS_REQUIRED_MODES = _default_periodic_jobs_required_modes(settings.EINVOICING_EXPORT_ONLY)


def _has_value(value: str | None) -> bool:
    return bool((value or "").strip())


def _has_placeholder(value: str | None) -> bool:
    raw = (value or "").strip().lower()
    if not raw:
        return False
    return any(token in raw for token in _CONFIG_PLACEHOLDER_TOKENS)


def parse_connected_mode_allowed_tenant_ids(value: str | None = None) -> frozenset[str]:
    raw = settings.CONNECTED_MODE_ALLOWED_TENANT_IDS if value is None else value
    return frozenset(part.strip() for part in (raw or "").split(",") if part.strip())


def _validate_connected_mode_rollout_prod_config() -> None:
    if settings.EINVOICING_EXPORT_ONLY:
        return
    raw = settings.CONNECTED_MODE_ALLOWED_TENANT_IDS
    tenant_ids = parse_connected_mode_allowed_tenant_ids(raw)
    if not tenant_ids or _has_placeholder(raw):
        raise RuntimeError(
            "CONNECTED_MODE_ALLOWED_TENANT_IDS doit contenir au moins un tenant pilote exact "
            "quand EINVOICING_EXPORT_ONLY=false en prod/staging."
        )
    if "*" in tenant_ids:
        raise RuntimeError("CONNECTED_MODE_ALLOWED_TENANT_IDS interdit le wildcard '*' en prod/staging.")
    raw_providers = settings.CONNECTED_MODE_ALLOWED_PROVIDERS
    providers = parse_connected_mode_allowed_providers(raw_providers)
    if not providers or _has_placeholder(raw_providers):
        raise RuntimeError(
            "CONNECTED_MODE_ALLOWED_PROVIDERS doit contenir au moins un fournisseur pilote exact "
            "quand EINVOICING_EXPORT_ONLY=false en prod/staging."
        )
    if "*" in providers:
        raise RuntimeError("CONNECTED_MODE_ALLOWED_PROVIDERS interdit le wildcard '*' en prod/staging.")
    unsupported = providers.difference({"seqino", "choruspro", "ppf"})
    if unsupported:
        raise RuntimeError(
            "CONNECTED_MODE_ALLOWED_PROVIDERS contient un fournisseur non autorisé: "
            + ", ".join(sorted(unsupported))
            + "."
        )


def _looks_like_sandbox_url(value: str | None) -> bool:
    raw = (value or "").strip().lower()
    if not raw:
        return False
    return any(marker in raw for marker in ("sandbox", "recette", "qualif"))


def _looks_like_seqino_nonprod_url(value: str | None) -> bool:
    raw = (value or "").strip().lower()
    if not raw:
        return False
    return _looks_like_sandbox_url(raw) or ".seqino.dev" in raw or ".test" in raw or "://test." in raw


def _seqino_config_requested() -> bool:
    explicit_keys = (
        "SEQINO_BASE_URL",
        "SEQINO_API_KEY",
        "SEQINO_ACCESS_TOKEN",
        "SEQINO_SPONSOR_ID",
        "SEQINO_WEBHOOK_SECRET",
    )
    if any(os.environ.get(key) is not None and os.environ.get(key, "").strip() for key in explicit_keys):
        return True
    return any(
        _has_value(value)
        for value in (
            settings.SEQINO_BASE_URL,
            settings.SEQINO_API_KEY,
            settings.SEQINO_ACCESS_TOKEN,
            settings.SEQINO_SPONSOR_ID,
            settings.SEQINO_WEBHOOK_SECRET,
        )
    )


def _validate_seqino_prod_config() -> None:
    if not _seqino_config_requested() and not settings.REQUIRE_SEQINO_IN_PROD:
        return
    if _has_value(settings.SEQINO_BASE_URL) and _looks_like_seqino_nonprod_url(settings.SEQINO_BASE_URL):
        raise RuntimeError(
            "SEQINO_BASE_URL ne doit pas pointer vers un environnement sandbox/dev/test en prod/staging."
        )
    if not settings.REQUIRE_SEQINO_IN_PROD or settings.EINVOICING_EXPORT_ONLY:
        return
    missing = []
    if not _has_value(settings.SEQINO_BASE_URL) or _has_placeholder(settings.SEQINO_BASE_URL):
        missing.append("SEQINO_BASE_URL")
    if not (
        (_has_value(settings.SEQINO_ACCESS_TOKEN) and not _has_placeholder(settings.SEQINO_ACCESS_TOKEN))
        or (_has_value(settings.SEQINO_API_KEY) and not _has_placeholder(settings.SEQINO_API_KEY))
    ):
        missing.append("SEQINO_ACCESS_TOKEN ou SEQINO_API_KEY")
    if not _has_value(settings.SEQINO_SPONSOR_ID) or _has_placeholder(settings.SEQINO_SPONSOR_ID):
        missing.append("SEQINO_SPONSOR_ID")
    if not _has_value(settings.SEQINO_WEBHOOK_SECRET) or _has_placeholder(settings.SEQINO_WEBHOOK_SECRET):
        missing.append("SEQINO_WEBHOOK_SECRET")
    if not 60 <= int(settings.SEQINO_WEBHOOK_MAX_AGE_SECONDS or 0) <= 900:
        raise RuntimeError("SEQINO_WEBHOOK_MAX_AGE_SECONDS doit être compris entre 60 et 900 secondes.")
    if missing:
        raise RuntimeError("Configuration Seqino incomplète en prod/staging: " + ", ".join(missing) + ".")


def _chorus_config_requested() -> bool:
    # The example environment deliberately ships sandbox endpoint defaults and
    # placeholder secrets. Endpoints alone do not mean that Chorus is enabled:
    # only an operator-provided credential, path or payload does. The Chorus
    # technical account is deliberately tenant-scoped in IntegrationSecret and
    # must never be inferred from a process-wide setting.
    explicit_keys = (
        "PISTE_CLIENT_ID",
        "PISTE_CLIENT_SECRET",
        "CHORUS_SUBMIT_PATH",
        "CHORUS_STATUS_PATH",
        "CHORUS_SUBMIT_EXTRA_JSON",
    )
    if any(_has_value(os.environ.get(key)) and not _has_placeholder(os.environ.get(key)) for key in explicit_keys):
        return True
    return any(
        _has_value(value) and not _has_placeholder(value)
        for value in (
            settings.PISTE_CLIENT_ID,
            settings.PISTE_CLIENT_SECRET,
            settings.CHORUS_SUBMIT_PATH,
            settings.CHORUS_STATUS_PATH,
            settings.CHORUS_SUBMIT_EXTRA_JSON,
        )
    )


def _chorus_syntaxe_flux_configured() -> bool:
    raw = settings.CHORUS_SUBMIT_EXTRA_JSON or ""
    if not raw.strip():
        return False
    try:
        parsed = json.loads(raw)
    except Exception:
        return False
    if not isinstance(parsed, dict):
        return False
    syntax = str(parsed.get("syntaxeFlux") or parsed.get("syntaxe_flux") or "").strip()
    return bool(syntax and not _has_placeholder(syntax))


def _validate_chorus_prod_config() -> None:
    if not _chorus_config_requested():
        return
    # Staging credentials while export-only is active must not make a safe core
    # deployment unbootable. Still reject non-production/forbidden endpoints
    # immediately; require the complete server contract only when Chorus itself
    # is explicitly allowlisted for connected I/O.
    for name, value in (("PISTE_TOKEN_URL", settings.PISTE_TOKEN_URL), ("CHORUS_API_BASE", settings.CHORUS_API_BASE)):
        if _has_value(value) and not _has_placeholder(value):
            if _looks_like_sandbox_url(value):
                raise RuntimeError(f"{name} ne doit pas pointer vers un environnement sandbox/recette en prod/staging.")
            _validate_platform_url_allowlist(name, value)
    if settings.EINVOICING_EXPORT_ONLY or "choruspro" not in parse_connected_mode_allowed_providers():
        return
    required = {
        "PISTE_CLIENT_ID": settings.PISTE_CLIENT_ID,
        "PISTE_CLIENT_SECRET": settings.PISTE_CLIENT_SECRET,
        "PISTE_TOKEN_URL": settings.PISTE_TOKEN_URL,
        "CHORUS_API_BASE": settings.CHORUS_API_BASE,
        "CHORUS_SUBMIT_PATH": settings.CHORUS_SUBMIT_PATH,
        "CHORUS_STATUS_PATH": settings.CHORUS_STATUS_PATH,
        "CHORUS_SUBMIT_EXTRA_JSON": settings.CHORUS_SUBMIT_EXTRA_JSON,
    }
    missing = [
        name
        for name, value in required.items()
        if not _has_value(value) or _has_placeholder(value)
    ]
    if missing:
        raise RuntimeError("Configuration Chorus incomplète en prod/staging: " + ", ".join(missing) + ".")
    if not _chorus_syntaxe_flux_configured():
        raise RuntimeError("CHORUS_SUBMIT_EXTRA_JSON.syntaxeFlux doit être configuré en prod/staging pour Chorus.")


def _clean_stripe_config_value(value: str | None) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    lower = raw.lower()
    if raw.startswith("<<") or raw.endswith(">>"):
        return None
    if lower in _STRIPE_PLACEHOLDER_IDS or _has_placeholder(raw):
        return None
    if "price_id_" in lower:
        return None
    return raw


def enforce_stripe_signature() -> bool:
    if "ENFORCE_STRIPE_SIGNATURE" in os.environ:
        return bool(settings.ENFORCE_STRIPE_SIGNATURE)
    return _has_value(settings.STRIPE_WEBHOOK_SECRET)


def facturx_profile_forced() -> bool:
    raw = os.environ.get("FACTURX_PROFILE")
    return _has_value(raw)


_FR_DGFIP_SPEC_TARGETS = {"2026", "2027"}
FR_DGFIP_SPEC_2027_START = date(2027, 9, 1)


def _normalize_fr_dgfip_spec_target(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    if raw in _FR_DGFIP_SPEC_TARGETS:
        return raw
    lowered = raw.lower()
    if lowered in _FR_DGFIP_SPEC_TARGETS:
        return lowered
    return None


def fr_dgfip_spec_target() -> str:
    raw_env = os.environ.get("FR_DGFIP_SPEC_TARGET")
    if raw_env is not None and raw_env.strip():
        return _normalize_fr_dgfip_spec_target(raw_env) or "2026"
    if settings.FR_COMPLIANCE_2027_ENABLED:
        return "2027"
    normalized = _normalize_fr_dgfip_spec_target(settings.FR_DGFIP_SPEC_TARGET)
    return normalized or "2026"


def _as_date(value: object | None) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        head = raw.split("T", 1)[0].split(" ", 1)[0]
        try:
            return date.fromisoformat(head)
        except ValueError:
            return None
    return None


def fr_dgfip_spec_target_for_issue_date(issue_date: object | None) -> str:
    target = fr_dgfip_spec_target()
    if target == "2027":
        return "2027"
    parsed = _as_date(issue_date)
    if parsed and parsed >= FR_DGFIP_SPEC_2027_START:
        return "2027"
    return "2026"


def _storage_provider() -> str:
    return (settings.STORAGE_PROVIDER or "local").strip().lower() or "local"


def _storage_local_root_env() -> str | None:
    for key in ("STORAGE_LOCAL_ROOT", "STORAGE_LOCAL_PATH"):
        raw = os.environ.get(key)
        if raw is not None and raw.strip():
            return raw.strip()
    return None


def _storage_local_root_value() -> str:
    env_value = _storage_local_root_env()
    if env_value:
        return env_value
    return (settings.STORAGE_LOCAL_ROOT or settings.STORAGE_LOCAL_PATH or "").strip()


def _storage_local_root_explicit() -> bool:
    if _storage_local_root_env() is not None:
        return True
    return _has_value(settings.STORAGE_LOCAL_ROOT)


def _storage_local_root_resolved() -> str:
    raw = _storage_local_root_value().strip() or "./storage"
    return os.path.abspath(os.path.expanduser(raw))


def _storage_local_root_is_unsafe_for_prod() -> bool:
    resolved = _storage_local_root_resolved()
    ephemeral_roots = ("/tmp", "/var/tmp", "/dev/shm", "/run", "/run/shm")
    return any(resolved == root or resolved.startswith(f"{root}{os.sep}") for root in ephemeral_roots)


def _validate_local_storage_root() -> None:
    raw_root = _storage_local_root_value().strip()
    if not _storage_local_root_explicit():
        raise RuntimeError("STORAGE_LOCAL_PATH explicite requis en prod/staging quand STORAGE_PROVIDER=local.")
    expanded_root = os.path.expanduser(raw_root)
    if not os.path.isabs(expanded_root):
        raise RuntimeError(
            "STORAGE_LOCAL_PATH doit être un chemin absolu en prod/staging quand STORAGE_PROVIDER=local."
        )
    if _storage_local_root_is_unsafe_for_prod():
        raise RuntimeError(
            "STORAGE_LOCAL_PATH ne doit pas pointer vers un répertoire éphémère "
            "(/tmp, /var/tmp, /dev/shm, /run) en prod/staging."
        )


def _s3_bucket_value() -> str:
    return (settings.S3_BUCKET or settings.STORAGE_BUCKET or "").strip()


def _s3_endpoint_value() -> str:
    return (settings.S3_ENDPOINT or settings.S3_ENDPOINT_URL or "").strip()


def _s3_access_key_value() -> str:
    return (settings.S3_ACCESS_KEY or settings.S3_ACCESS_KEY_ID or "").strip()


def _s3_secret_key_value() -> str:
    return (settings.S3_SECRET_KEY or settings.S3_SECRET_ACCESS_KEY or "").strip()


def _has_iam_role() -> bool:
    if os.environ.get("AWS_ROLE_ARN") and os.environ.get("AWS_WEB_IDENTITY_TOKEN_FILE"):
        return True
    if os.environ.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") or os.environ.get("AWS_CONTAINER_CREDENTIALS_FULL_URI"):
        return True
    return False


def _legal_archive_required() -> bool:
    retention_years = settings.INVOICES_RETENTION_YEARS
    if retention_years is None:
        retention_years = 0
    if retention_years >= 6:
        return True
    return bool(settings.ENABLE_LEGAL_ARCHIVE or settings.LEGAL_ARCHIVE)


def _parse_pdp_encryption_keys(raw: str | None) -> tuple[list[tuple[str, str]], list[str]]:
    entries: list[tuple[str, str]] = []
    invalid: list[str] = []
    for part in (raw or "").split(","):
        item = part.strip()
        if not item:
            continue
        if ":" not in item:
            invalid.append(item)
            continue
        kid, secret = item.split(":", 1)
        kid = kid.strip()
        secret = secret.strip()
        if not kid or not secret:
            invalid.append(item)
            continue
        entries.append((kid, secret))
    return entries, invalid


def _normalize_host(value: str | None) -> str | None:
    if not _has_value(value):
        return None
    assert value is not None
    raw = value.strip()
    candidate = raw
    if "://" in raw:
        parsed = urlparse(raw)
        if parsed.hostname:
            return parsed.hostname.lower()
        candidate = parsed.netloc or raw
    candidate = candidate.split("/")[0]
    candidate = candidate.split(":")[0]
    candidate = candidate.lstrip(".").lower()
    return candidate or None


_LOCALHOST_HOSTS = {"localhost", "localhost.localdomain", "127.0.0.1", "::1"}


def _is_localhost_host(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.strip().lower().strip(".")
    if normalized in _LOCALHOST_HOSTS:
        return True
    if normalized.endswith(".localhost"):
        return True
    return False


def is_prod_like() -> bool:
    public_base = (settings.PUBLIC_BASE_URL or "").strip()
    if not public_base:
        return False
    parsed = urlparse(public_base)
    if parsed.scheme != "https":
        return False
    host = parsed.hostname or _normalize_host(public_base)
    if not host:
        return False
    return not _is_localhost_host(host)


_KNOWN_MULTI_PART_TLDS = {
    "ac.uk",
    "co.uk",
    "gov.uk",
    "org.uk",
    "sch.uk",
    "com.au",
    "net.au",
    "org.au",
    "edu.au",
    "gov.au",
    "id.au",
    "co.nz",
    "org.nz",
    "govt.nz",
    "ac.nz",
    "co.jp",
    "ne.jp",
    "or.jp",
    "go.jp",
    "co.kr",
    "or.kr",
    "go.kr",
    "com.br",
    "com.ar",
    "com.mx",
    "com.co",
    "com.sg",
    "com.hk",
    "com.tw",
    "com.cn",
    "com.tr",
    "com.sa",
    "com.ru",
    "com.ua",
    "com.pl",
    "co.in",
    "firm.in",
    "net.in",
    "org.in",
    "gen.in",
    "ind.in",
    "co.za",
    "org.za",
    "gov.za",
    "net.za",
}


def _registrable_domain(host: str | None) -> str | None:
    if not host:
        return None
    normalized = host.strip().lower().strip(".")
    if not normalized:
        return None
    if normalized in {"localhost", "localhost.localdomain"}:
        return normalized
    if normalized.endswith(".localhost"):
        return "localhost"
    try:
        ipaddress.ip_address(normalized)
        return normalized
    except ValueError:
        pass
    labels = [label for label in normalized.split(".") if label]
    if len(labels) <= 2:
        return normalized
    suffix = ".".join(labels[-2:])
    if suffix in _KNOWN_MULTI_PART_TLDS:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _cookie_domain_allows_host(public_host: str | None, cookie_domain: str | None) -> bool:
    if not public_host or not cookie_domain:
        return True
    if public_host == cookie_domain:
        return True
    return public_host.endswith(f".{cookie_domain}")


def _allowed_hosts_value() -> str | None:
    if _has_value(settings.ALLOWED_HOSTS):
        return settings.ALLOWED_HOSTS
    return settings.TRUSTED_HOSTS


def _parse_hosts(value: str | None) -> list[str]:
    hosts = [h.strip() for h in (value or "").split(",") if h.strip()]
    # Keep local tooling/probes and the frontend-to-backend Compose hop functional
    # even with strict TrustedHostMiddleware. This is an exact internal hostname,
    # never a wildcard or a suffix match.
    defaults = ["localhost", "127.0.0.1", "::1", "backend"]
    for item in defaults:
        if item not in hosts:
            hosts.append(item)
    return hosts


def _host_matches_allowlist(target: str | None, allowed_hosts: list[str]) -> bool:
    target_host = _normalize_host(target)
    if not target_host:
        return False
    for host in allowed_hosts:
        normalized = _normalize_host(host)
        if not normalized:
            continue
        if target_host == normalized or target_host.endswith(f".{normalized}"):
            return True
    return False


def _validate_platform_url_allowlist(name: str, value: str | None) -> None:
    if not _has_value(settings.PLATFORM_ALLOWED_HOSTS):
        return
    target_host = _normalize_host(value)
    if not target_host:
        raise RuntimeError(f"{name} invalide: hôte manquant.")
    allowed_hosts = _parse_hosts(settings.PLATFORM_ALLOWED_HOSTS)
    if not _host_matches_allowlist(target_host, allowed_hosts):
        raise RuntimeError(f"PLATFORM_ALLOWED_HOSTS doit inclure {target_host} (ou son domaine parent) pour {name}.")


def _contains_weak_secret_token(secret: str) -> bool:
    lowered = secret.lower()
    for token in ("changeme", "change-me", "change", "demo", "password", "secret"):
        if token in lowered:
            return True
    return False


def _is_secret_key_strong(secret: str | None) -> bool:
    if not secret:
        return False
    normalized = secret.strip()
    if not normalized:
        return False
    if len(normalized) < 32:
        return False
    if _contains_weak_secret_token(normalized):
        return False
    return True


def _is_secure_cookie_env() -> bool:
    if settings.COOKIE_SECURE is not None:
        return bool(settings.COOKIE_SECURE)
    env = (settings.APP_ENV or "").strip().lower()
    if env == "staging":
        return True
    base = (settings.PUBLIC_BASE_URL or "").strip()
    if base:
        parsed = urlparse(base)
        if parsed.scheme == "https":
            return True
        if parsed.scheme == "http":
            return False
    if env in {"prod", "production"}:
        return True
    return False


def _validate_stripe_redirect_url(value: str | None, label: str) -> None:
    if not _has_value(value):
        raise RuntimeError(f"{label} doit être défini en prod/staging.")
    assert value is not None
    raw = value.strip()
    parsed = urlparse(raw)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError(f"{label} doit être une URL https valide.")
    if "example.com" in raw.lower():
        raise RuntimeError(f"{label} ne doit pas contenir example.com en prod/staging.")


def _validate_storage_config() -> None:
    provider = _storage_provider()
    if provider in {"local", "filesystem"}:
        if settings.ALLOW_LOCAL_STORAGE_IN_PROD:
            _validate_local_storage_root()
            return
        raise RuntimeError("STORAGE_PROVIDER=local interdit en prod/staging.")
    if provider in {"s3", "minio"}:
        bucket = _s3_bucket_value()
        if not bucket:
            raise RuntimeError(
                "S3_BUCKET (ou STORAGE_BUCKET) doit être défini en prod/staging pour STORAGE_PROVIDER=s3/minio."
            )
        if _has_placeholder(bucket):
            raise RuntimeError("S3_BUCKET/STORAGE_BUCKET ne doit pas contenir de placeholder en prod/staging.")
        endpoint = _s3_endpoint_value()
        region = (settings.S3_REGION or "").strip()
        if provider == "minio" and not endpoint:
            raise RuntimeError("S3_ENDPOINT requis pour STORAGE_PROVIDER=minio en prod/staging.")
        if not endpoint and not region:
            raise RuntimeError("S3_REGION requis quand S3_ENDPOINT est absent en prod/staging.")
        for label, value in (
            ("S3_ENDPOINT", endpoint),
            ("S3_ENDPOINT_URL", settings.S3_ENDPOINT_URL or ""),
            ("S3_REGION", region),
            ("S3_ACCESS_KEY", _s3_access_key_value()),
            ("S3_ACCESS_KEY_ID", settings.S3_ACCESS_KEY_ID or ""),
            ("S3_SECRET_KEY", _s3_secret_key_value()),
            ("S3_SECRET_ACCESS_KEY", settings.S3_SECRET_ACCESS_KEY or ""),
            ("S3_KMS_KEY_ID", settings.S3_KMS_KEY_ID or ""),
        ):
            if _has_placeholder(value):
                raise RuntimeError(f"{label} ne doit pas contenir de placeholder en prod/staging.")
        access_key = _s3_access_key_value()
        secret_key = _s3_secret_key_value()
        if (access_key and not secret_key) or (secret_key and not access_key):
            raise RuntimeError("S3_ACCESS_KEY et S3_SECRET_KEY doivent être fournis ensemble en prod/staging.")
        if not access_key and not secret_key:
            if not _has_iam_role():
                raise RuntimeError(
                    "S3_ACCESS_KEY/S3_SECRET_KEY manquants: fournir les clés ou configurer un rôle IAM "
                    "(AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE, "
                    "ou AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/FULL_URI) en prod/staging."
                )
        if settings.S3_OBJECT_LOCK_ENABLED:
            mode = (settings.S3_OBJECT_LOCK_MODE or "").strip().upper()
            if mode not in {"GOVERNANCE", "COMPLIANCE"}:
                raise RuntimeError(
                    "S3_OBJECT_LOCK_MODE doit valoir GOVERNANCE ou COMPLIANCE quand S3_OBJECT_LOCK_ENABLED=true."
                )
            if settings.S3_OBJECT_LOCK_RETENTION_DAYS is None or settings.S3_OBJECT_LOCK_RETENTION_DAYS <= 0:
                raise RuntimeError("S3_OBJECT_LOCK_RETENTION_DAYS doit être > 0 quand S3_OBJECT_LOCK_ENABLED=true.")
            if not settings.S3_BUCKET_VERSIONING:
                raise RuntimeError("S3_BUCKET_VERSIONING=true requis quand S3_OBJECT_LOCK_ENABLED=true.")
        return
    raise RuntimeError(f"STORAGE_PROVIDER invalide: {provider}.")


def _validate_db_runtime_config() -> None:
    pool_size = int(getattr(settings, "DB_POOL_SIZE", 0) or 0)
    max_overflow = int(getattr(settings, "DB_MAX_OVERFLOW", 0) or 0)
    pool_timeout = int(getattr(settings, "DB_POOL_TIMEOUT_SECONDS", 0) or 0)
    pool_recycle = int(getattr(settings, "DB_POOL_RECYCLE_SECONDS", 0) or 0)
    statement_timeout = int(getattr(settings, "DB_STATEMENT_TIMEOUT_MS", 0) or 0)
    lock_timeout = int(getattr(settings, "DB_LOCK_TIMEOUT_MS", 0) or 0)
    app_name = (getattr(settings, "DB_APPLICATION_NAME", "") or "").strip()
    if pool_size <= 0:
        raise RuntimeError("DB_POOL_SIZE doit être > 0 en prod/staging.")
    if max_overflow < 0:
        raise RuntimeError("DB_MAX_OVERFLOW doit être >= 0 en prod/staging.")
    if pool_timeout <= 0:
        raise RuntimeError("DB_POOL_TIMEOUT_SECONDS doit être > 0 en prod/staging.")
    if pool_recycle <= 0:
        raise RuntimeError("DB_POOL_RECYCLE_SECONDS doit être > 0 en prod/staging.")
    if statement_timeout <= 0 or statement_timeout > 120_000:
        raise RuntimeError("DB_STATEMENT_TIMEOUT_MS doit être défini entre 1 et 120000 en prod/staging.")
    if lock_timeout <= 0 or lock_timeout > statement_timeout:
        raise RuntimeError("DB_LOCK_TIMEOUT_MS doit être > 0 et inférieur au statement timeout en prod/staging.")
    if not app_name:
        raise RuntimeError("DB_APPLICATION_NAME doit être défini en prod/staging.")


def _validate_legal_acceptance_config() -> None:
    if _is_prod_env() and bool(settings.LEGAL_ACCEPTANCE_TEST_MODE):
        raise RuntimeError(
            "LEGAL_ACCEPTANCE_TEST_MODE est réservé aux tests jetables et doit rester false en prod/staging."
        )
    if bool(settings.LEGAL_TERMS_ACCEPTANCE_REQUIRED) and not _has_value(settings.NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS):
        raise RuntimeError(
            "LEGAL_TERMS_ACCEPTANCE_REQUIRED=true requiert NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS en prod/staging."
        )
    if bool(settings.LEGAL_DPA_ACCEPTANCE_REQUIRED) and not _has_value(settings.NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA):
        raise RuntimeError(
            "LEGAL_DPA_ACCEPTANCE_REQUIRED=true requiert NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA en prod/staging."
        )
    required_hashes = (
        (
            "LEGAL_TERMS_ACCEPTANCE_REQUIRED",
            bool(settings.LEGAL_TERMS_ACCEPTANCE_REQUIRED),
            "LEGAL_DOC_SHA256_TERMS",
            settings.LEGAL_DOC_SHA256_TERMS,
        ),
        (
            "LEGAL_DPA_ACCEPTANCE_REQUIRED",
            bool(settings.LEGAL_DPA_ACCEPTANCE_REQUIRED),
            "LEGAL_DOC_SHA256_DPA",
            settings.LEGAL_DOC_SHA256_DPA,
        ),
    )
    for required_name, required, hash_name, raw_hash in required_hashes:
        if not required:
            continue
        normalized_hash = (raw_hash or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", normalized_hash):
            raise RuntimeError(
                f"{required_name}=true requiert {hash_name}, empreinte SHA-256 hexadécimale sur 64 caractères."
            )
        slug = "terms" if hash_name == "LEGAL_DOC_SHA256_TERMS" else "dpa"
        version = (
            settings.NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS
            if slug == "terms"
            else settings.NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA
        )
        if not is_adopted_legal_document(slug, version, normalized_hash):
            raise RuntimeError(
                f"{required_name}=true refuse le document {slug} version {version or '<vide>'}: "
                "la paire version/empreinte n'est pas répertoriée comme formellement adoptée."
            )


def _validate_prod_config(origins: list[str]) -> None:
    if not _is_prod_env():
        return
    if not _has_value(settings.TRUSTED_HOSTS):
        raise RuntimeError("TRUSTED_HOSTS doit être configuré en prod/staging.")
    if not origins or any("*" in origin for origin in origins):
        raise RuntimeError("CORS_ORIGINS doit être configuré sur le domaine front (pas de wildcard) en prod/staging.")
    if not _has_value(settings.PUBLIC_BASE_URL):
        raise RuntimeError("PUBLIC_BASE_URL doit être défini en prod/staging.")
    _validate_connected_mode_rollout_prod_config()
    _validate_seqino_prod_config()
    _validate_chorus_prod_config()
    public_host = _normalize_host(settings.PUBLIC_BASE_URL)
    if not public_host:
        raise RuntimeError("PUBLIC_BASE_URL invalide en prod/staging.")
    public_base_scheme = (urlparse(settings.PUBLIC_BASE_URL).scheme or "").strip().lower()
    if public_base_scheme != "https":
        raise RuntimeError("PUBLIC_BASE_URL doit utiliser https en prod/staging.")
    if not _is_secure_cookie_env():
        raise RuntimeError("COOKIE_SECURE=true requis en prod/staging lorsque PUBLIC_BASE_URL utilise https.")
    if not _has_value(settings.PLATFORM_ALLOWED_HOSTS):
        raise RuntimeError("PLATFORM_ALLOWED_HOSTS requis en prod/staging (SSRF protection).")
    if _has_value(settings.FRONTEND_BASE_URL):
        frontend_host = _normalize_host(settings.FRONTEND_BASE_URL)
        if not frontend_host:
            raise RuntimeError("FRONTEND_BASE_URL invalide en prod/staging.")
        frontend_reg = _registrable_domain(frontend_host)
        public_reg = _registrable_domain(public_host)
        if frontend_reg and public_reg and frontend_reg != public_reg:
            warning_msg = (
                "FRONTEND_BASE_URL et PUBLIC_BASE_URL ne partagent pas le même domaine registrable: "
                "cookies tiers (cross-site) => risque de 'session expired' et blocage navigateur. "
                "Recommande: même domaine via reverse proxy. "
                "Exige: COOKIE_SAMESITE=none, COOKIE_SECURE=true et STRICT_COOKIE_CONFIG=false. "
                f"FRONTEND_BASE_URL={settings.FRONTEND_BASE_URL} PUBLIC_BASE_URL={settings.PUBLIC_BASE_URL}."
            )
            logger.warning(warning_msg)
            if settings.STRICT_COOKIE_CONFIG:
                raise RuntimeError(
                    "Config cookies incompatible avec des domaines front/back differents: "
                    "mettre STRICT_COOKIE_CONFIG=false ou utilisez le meme domaine."
                )
            samesite = (settings.COOKIE_SAMESITE or "lax").strip().lower()
            if samesite != "none":
                raise RuntimeError("COOKIE_SAMESITE=none requis quand front/back sont sur des domaines differents.")
            if not _is_secure_cookie_env():
                raise RuntimeError("COOKIE_SECURE=true requis quand front/back sont sur des domaines differents.")
    allowed_hosts = _parse_hosts(_allowed_hosts_value())
    if not allowed_hosts:
        raise RuntimeError("ALLOWED_HOSTS/TRUSTED_HOSTS doit être configuré (sans wildcard) en prod/staging.")
    if any("*" in host for host in allowed_hosts):
        raise RuntimeError("ALLOWED_HOSTS/TRUSTED_HOSTS ne doit pas contenir de wildcard en prod/staging.")
    billing_required = bool(settings.BILLING_ENABLED or settings.SUBSCRIPTION_REQUIRED)
    if billing_required:
        if _has_value(settings.STRIPE_API_BASE):
            raise RuntimeError("STRIPE_API_BASE personnalisé interdit en prod/staging.")
        if not _has_value(settings.STRIPE_SECRET_KEY) or not _has_value(settings.STRIPE_WEBHOOK_SECRET):
            raise RuntimeError(
                "Stripe requis: STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET doivent être configurés en prod/staging."
            )
        _validate_stripe_redirect_url(settings.STRIPE_SUCCESS_URL, "STRIPE_SUCCESS_URL")
        _validate_stripe_redirect_url(settings.STRIPE_CANCEL_URL, "STRIPE_CANCEL_URL")
        _validate_stripe_redirect_url(
            settings.STRIPE_CUSTOMER_PORTAL_RETURN_URL,
            "STRIPE_CUSTOMER_PORTAL_RETURN_URL",
        )
        portal_configuration_id = _clean_stripe_config_value(
            settings.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID
        )
        if not portal_configuration_id or not portal_configuration_id.startswith("bpc_"):
            raise RuntimeError(
                "Stripe requis: STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID doit cibler une configuration "
                "Billing Portal dédiée et sûre en prod/staging."
            )
        missing_price = []
        for key in settings.missing_stripe_subscription_prices():
            if key == "starter_monthly":
                missing_price.append("STRIPE_PRICE_STARTER_MONTHLY (ou STRIPE_PRICE_STARTER)")
            elif key == "pro_monthly":
                missing_price.append("STRIPE_PRICE_PRO_MONTHLY (ou STRIPE_PRICE_PRO)")
            elif key == "starter_yearly":
                missing_price.append("STRIPE_PRICE_STARTER_YEARLY")
            elif key == "pro_yearly":
                missing_price.append("STRIPE_PRICE_PRO_YEARLY")
        if missing_price:
            raise RuntimeError(
                "Stripe requis: variables de prix manquantes en prod/staging: " + ", ".join(missing_price) + "."
            )
    policy = (settings.BILLING_OVERAGE_POLICY or "").strip().lower()
    if policy not in {"strict", "best_effort"}:
        raise RuntimeError("BILLING_OVERAGE_POLICY doit être strict ou best_effort en prod/staging.")
    if settings.SEQINO_WELCOME_TOKENS_PRO < 0:
        raise RuntimeError("SEQINO_WELCOME_TOKENS_PRO doit être supérieur ou égal à 0 en prod/staging.")
    if not 1024 <= int(settings.STRIPE_WEBHOOK_MAX_BYTES or 0) <= 1024 * 1024:
        raise RuntimeError(
            "STRIPE_WEBHOOK_MAX_BYTES doit être compris entre 1024 et 1048576 en prod/staging."
        )
    if settings.BILLING_OVERAGE_RATE_EUR < 0:
        raise RuntimeError("BILLING_OVERAGE_RATE_EUR doit être supérieur ou égal à 0 en prod/staging.")
    if settings.SEQINO_COST_PER_FLOW_EUR is not None and settings.SEQINO_COST_PER_FLOW_EUR <= 0:
        raise RuntimeError("SEQINO_COST_PER_FLOW_EUR doit être supérieur à 0 en prod/staging.")
    if not _is_secret_key_strong(settings.SECRET_KEY):
        raise RuntimeError("SECRET_KEY trop faible ou par défaut en prod/staging.")
    _validate_legal_acceptance_config()
    _validate_storage_config()
    if _legal_archive_required():
        provider = _storage_provider()
        if provider not in {"s3", "minio"}:
            raise RuntimeError(
                "Archivage immuable: STORAGE_PROVIDER=s3|minio requis (stockage immuable) en prod/staging."
            )
        if not settings.S3_OBJECT_LOCK_ENABLED:
            raise RuntimeError("Archivage immuable: S3_OBJECT_LOCK_ENABLED=true requis (immutabilite) en prod/staging.")
        if not settings.S3_BUCKET_VERSIONING:
            raise RuntimeError(
                "Archivage immuable: S3_BUCKET_VERSIONING=true requis (versioning bucket) en prod/staging."
            )
        if (settings.S3_OBJECT_LOCK_MODE or "").strip().upper() not in {"GOVERNANCE", "COMPLIANCE"}:
            raise RuntimeError("Archivage immuable: S3_OBJECT_LOCK_MODE=GOVERNANCE|COMPLIANCE requis.")
        if settings.S3_OBJECT_LOCK_RETENTION_DAYS is None or settings.S3_OBJECT_LOCK_RETENTION_DAYS <= 0:
            raise RuntimeError("Archivage immuable: S3_OBJECT_LOCK_RETENTION_DAYS > 0 requis.")
    keyring, invalid_keys = _parse_pdp_encryption_keys(settings.PDP_ENCRYPTION_KEYS)
    if _has_value(settings.PDP_ENCRYPTION_KEYS) and (invalid_keys or not keyring):
        raise RuntimeError("PDP_ENCRYPTION_KEYS invalide (format attendu: kid:secret,kid2:secret2) en prod/staging.")
    if keyring:
        active_kid = (settings.PDP_ENCRYPTION_KID or keyring[0][0]).strip()
        active_secret = None
        for kid, secret in keyring:
            if kid == active_kid:
                active_secret = secret
                break
        if settings.PDP_ENCRYPTION_KID and not active_secret:
            raise RuntimeError("PDP_ENCRYPTION_KID ne correspond a aucune entree de PDP_ENCRYPTION_KEYS.")
        if active_secret is None:
            active_secret = keyring[0][1]
        if (active_secret or "").strip() == (settings.SECRET_KEY or "").strip():
            raise RuntimeError("PDP_ENCRYPTION_KEYS doit utiliser une cle distincte de SECRET_KEY en prod/staging.")
    else:
        if not _has_value(settings.PDP_ENCRYPTION_KEY):
            raise RuntimeError("PDP_ENCRYPTION_KEY (ou PDP_ENCRYPTION_KEYS) doit etre defini en prod/staging.")
        if (settings.PDP_ENCRYPTION_KEY or "").strip() == (settings.SECRET_KEY or "").strip():
            raise RuntimeError("PDP_ENCRYPTION_KEY doit etre distincte de SECRET_KEY en prod/staging.")
    if not _has_value(settings.REDIS_URL):
        raise RuntimeError("REDIS_URL doit être configuré en prod/staging.")
    if settings.DISABLE_RATE_LIMITS and not settings.RATE_LIMITS_BREAK_GLASS:
        raise RuntimeError("DISABLE_RATE_LIMITS=true interdit en prod/staging sans RATE_LIMITS_BREAK_GLASS=true.")
    _validate_db_runtime_config()
    cookie_domain = _normalize_host(settings.COOKIE_DOMAIN)
    if cookie_domain and not _cookie_domain_allows_host(public_host, cookie_domain):
        raise RuntimeError(
            f"COOKIE_DOMAIN ({settings.COOKIE_DOMAIN}) ne correspond pas au domaine PUBLIC_BASE_URL "
            f"({settings.PUBLIC_BASE_URL})."
        )
    samesite = (settings.COOKIE_SAMESITE or "lax").strip().lower()
    if samesite == "none" and not _is_secure_cookie_env():
        raise RuntimeError("COOKIE_SAMESITE=none requiert COOKIE_SECURE=true en prod/staging.")
    if samesite != "none":
        mismatched = []
        for origin in origins:
            origin_host = _normalize_host(origin)
            if origin_host and origin_host != public_host:
                mismatched.append(origin)
        if mismatched:
            msg = (
                "COOKIE_SAMESITE doit être 'none' quand CORS_ORIGINS contient un domaine différent "
                "de PUBLIC_BASE_URL (cookies bloqués en cross-domain). "
                f"PUBLIC_BASE_URL={settings.PUBLIC_BASE_URL} CORS_ORIGINS={', '.join(mismatched)}."
            )
            if settings.STRICT_COOKIE_CONFIG:
                raise RuntimeError(msg)
            logger.warning(msg)
    if settings.TRIAL_LIFECYCLE_CLEANUP_ENABLED and not settings.TRIAL_LIFECYCLE_NOTIFICATIONS_ENABLED:
        raise RuntimeError(
            "TRIAL_LIFECYCLE_CLEANUP_ENABLED=true requiert "
            "TRIAL_LIFECYCLE_NOTIFICATIONS_ENABLED=true en prod/staging."
        )
    if settings.TRIAL_LIFECYCLE_NOTIFICATIONS_ENABLED:
        if settings.TRIAL_PRE_ANONYMIZATION_NOTICE_DAYS >= settings.TRIAL_INACTIVE_ANONYMIZE_DAYS:
            raise RuntimeError(
                "TRIAL_PRE_ANONYMIZATION_NOTICE_DAYS doit être strictement inférieur à "
                "TRIAL_INACTIVE_ANONYMIZE_DAYS en prod/staging."
            )
        if not settings.SMTP_ENABLED:
            raise RuntimeError(
                "TRIAL_LIFECYCLE_NOTIFICATIONS_ENABLED=true requiert SMTP_ENABLED=true en prod/staging."
            )
        if not (
            _has_value(settings.SMTP_HOST)
            and _has_value(settings.SMTP_USERNAME)
            and _has_value(settings.SMTP_PASSWORD)
        ):
            raise RuntimeError(
                "TRIAL_LIFECYCLE_NOTIFICATIONS_ENABLED=true requiert "
                "SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD en prod/staging."
            )
    if settings.REQUIRE_EMAIL_VERIFICATION:
        if not settings.SMTP_ENABLED:
            raise RuntimeError("REQUIRE_EMAIL_VERIFICATION=true requiert SMTP_ENABLED=true en prod/staging.")
        if not (
            _has_value(settings.SMTP_HOST) and _has_value(settings.SMTP_USERNAME) and _has_value(settings.SMTP_PASSWORD)
        ):
            raise RuntimeError(
                "REQUIRE_EMAIL_VERIFICATION=true requiert SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD en prod/staging."
            )
    if settings.SMTP_ENABLED:
        if not (
            _has_value(settings.SMTP_HOST) and _has_value(settings.SMTP_USERNAME) and _has_value(settings.SMTP_PASSWORD)
        ):
            raise RuntimeError("SMTP_* requis quand SMTP_ENABLED=true en prod/staging.")
    if (settings.DEMO_MODE_ENABLED or settings.DEMO_MODE_ALLOW_RESET) and (
        settings.DEMO_MODE_ADMIN_PASSWORD or ""
    ).strip() == _DEFAULT_DEMO_PASSWORD:
        raise RuntimeError(
            "DEMO_MODE_ADMIN_PASSWORD doit être aléatoire en prod/staging "
            "quand DEMO_MODE_ENABLED ou DEMO_MODE_ALLOW_RESET est actif."
        )


def validate_prod_config(origins: list[str]) -> None:
    if not _is_prod_env():
        return
    _validate_prod_config(origins)


def validate_cookie_cors(origins: list[str]) -> None:
    if not auth_cookie_mode_enabled():
        return
    if not origins:
        raise RuntimeError("CORS_ORIGINS doit être configuré quand AUTH_COOKIE_MODE=true.")
    if any("*" in origin for origin in origins):
        raise RuntimeError("CORS_ORIGINS ne doit pas contenir de wildcard quand AUTH_COOKIE_MODE=true.")


_LOCALHOST_HOSTS = {"localhost", "localhost.localdomain", "127.0.0.1", "::1"}


def enforce_runtime_env_sanity() -> None:
    """
    Bloque le démarrage si un domaine public https est utilisé avec un APP_ENV non-prod.
    """
    if _is_prod_env():
        return
    if not is_prod_like():
        return
    logger = logging.getLogger("startup.env")
    logger.error(
        "Runtime env sanity check failed: APP_ENV=%s PUBLIC_BASE_URL=%s",
        settings.APP_ENV,
        settings.PUBLIC_BASE_URL,
    )
    raise RuntimeError(
        "Configuration dangereuse: APP_ENV non-prod avec PUBLIC_BASE_URL https sur un domaine public. "
        f"APP_ENV={settings.APP_ENV} PUBLIC_BASE_URL={settings.PUBLIC_BASE_URL}. "
        "Attendu: APP_ENV=prod|production|staging pour un domaine public, "
        "ou PUBLIC_BASE_URL sur localhost/127.0.0.1."
    )


def enforce_http_generic_allowlist_sanity() -> None:
    if not settings.ENABLE_HTTP_GENERIC_CONNECTOR:
        return
    if not is_prod_like():
        return
    if _has_value(settings.PLATFORM_ALLOWED_HOSTS):
        return
    logger = logging.getLogger("startup.http_generic")
    logger.error(
        "HTTP generic connector enabled without PLATFORM_ALLOWED_HOSTS on prod-like env. APP_ENV=%s PUBLIC_BASE_URL=%s",
        settings.APP_ENV,
        settings.PUBLIC_BASE_URL,
    )
    raise RuntimeError(
        "PLATFORM_ALLOWED_HOSTS requis quand ENABLE_HTTP_GENERIC_CONNECTOR=true sur un domaine public https."
    )
