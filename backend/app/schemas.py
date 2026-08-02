from pydantic import (
    AliasChoices,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)
from email_validator import EmailNotValidError, validate_email
from importlib import import_module
from typing import Optional, List, Any, Annotated
import re
from datetime import datetime, date, timezone
from urllib.parse import urlparse
from .config import settings
from .utils.unit_codes import normalize_unit_code
from .utils.money import MAX_DOCUMENT_AMOUNT, MAX_LINE_QUANTITY, ensure_max_abs


def _resolve_pydantic_custom_error() -> type[ValueError]:
    for module_name in ("pydantic.errors", "pydantic"):
        try:
            candidate = getattr(import_module(module_name), "PydanticCustomError")
        except Exception:
            continue
        return candidate

    class _FallbackPydanticCustomError(ValueError):
        """Fallback for older Pydantic versions without PydanticCustomError."""

        def __init__(self, code: str, message: str, ctx: dict | None = None):
            super().__init__(message)
            self.code = code
            self.ctx = ctx or {}

    return _FallbackPydanticCustomError


PydanticCustomError = _resolve_pydantic_custom_error()

WEAK_PASSWORDS = {
    "password",
    "password123",
    "pass123",
    "passw0rd",
    "12345678",
    "123456789",
    "1234567890",
    "123456789012",
    "qwerty123",
    "azerty123",
    "admin123",
    "letmein",
    "welcome",
    "changeme",
    "motdepasse",
    "motdepasse123",
    "bonjour123",
    "iloveyou",
}

FACTURX_PROFILES = {
    "minimum",
    "basic",
    "en16931",
    "extended",
    "extended-ctc-fr",
}
INVOICE_KINDS = {"standard", "deposit", "final"}
INVOICE_TEMPLATE_KEYS = {"classic", "graphite", "ivory"}
INVOICE_TEMPLATE_BOOL_OPTION_KEYS = {
    "show_delivery_address",
    "show_purchase_order_number",
    "show_note",
    "show_vat_totals",
    "delivery_address_differs",
    "legal_terms_default",
    "show_supplier_email",
    "show_supplier_phone",
    "global_vat_enabled",
}
INVOICE_TEMPLATE_OPTION_KEYS = INVOICE_TEMPLATE_BOOL_OPTION_KEYS | {
    "document_title",
    "document_language",
    "document_tags",
    "custom_fields",
    "payment_methods",
    "payment_bank_account",
    "line_columns",
    "advance_payments",
    "requested_advance",
    "delivery_address",
    "operation_nature",
    "legal_mentions_text",
    "legal_footer_text",
    "legal_penalty_prefix",
    "legal_recovery_prefix",
    "legal_discount_text",
    "legal_penalty_rate",
    "legal_recovery_fee",
    "document_discount_input_mode",
    "document_discount_amount_ht",
    "global_vat_draft",
}
INVOICE_LINE_COLUMN_OPTION_IDS = {
    "lineNumber",
    "reference",
    "quantity",
    "unit",
    "unitPrice",
    "vat",
    "discount",
    "baseTotal",
    "discountedTotal",
}
PAYMENT_METHOD_OPTION_IDS = {
    "card",
    "bank_transfer",
    "cheque",
    "cash",
    "direct_debit",
    "cesu",
    "urssaf_aici",
    "payment_app",
}


def _digits_only(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _normalize_fr_identifier(raw: Any, *, lengths: set[int], label: str) -> str | None:
    if raw is None:
        return None
    digits = _digits_only(str(raw).strip())
    if not digits:
        return None
    if len(digits) not in lengths:
        joined = " ou ".join(str(item) for item in sorted(lengths))
        raise ValueError(f"{label} invalide ({joined} chiffres).")
    return digits


def _normalize_chorus_reference(raw: Any, *, max_chars: int, label: str) -> str | None:
    if raw is None:
        return None
    value = str(raw).strip()
    if not value:
        return None
    if len(value) > max_chars:
        raise ValueError(f"{label} trop long (maximum {max_chars} caractères).")
    for char in value:
        codepoint = ord(char)
        if codepoint < 32 or codepoint == 127 or 0xD800 <= codepoint <= 0xDFFF or codepoint in {0xFFFE, 0xFFFF}:
            raise ValueError(f"{label} contient un caractère non autorisé.")
    return value


def _email_test_environment_enabled() -> bool:
    env = (getattr(settings, "APP_ENV", "") or "").strip().lower()
    return env not in {"prod", "production", "staging"}


def _normalize_email(raw: Any) -> str:
    value = str(raw or "").strip()
    if not value:
        raise ValueError("Email obligatoire ou invalide.")
    try:
        normalized = validate_email(
            value,
            check_deliverability=False,
            test_environment=_email_test_environment_enabled(),
        )
    except EmailNotValidError as exc:
        raise ValueError("Email obligatoire ou invalide.") from exc
    return normalized.normalized


ValidatedEmail = Annotated[str, BeforeValidator(_normalize_email)]


def _normalize_vat(raw: Any) -> str | None:
    if raw is None:
        return None
    value = str(raw).strip().replace(" ", "")
    if not value:
        return None
    return value.upper()


def _normalize_iban(raw: Any) -> str | None:
    if raw is None:
        return None
    value = str(raw).strip().replace(" ", "")
    if not value:
        return None
    iban = value.upper()
    if not re.fullmatch(r"[A-Z0-9]+", iban):
        raise ValueError("IBAN invalide (caractères non autorisés).")
    if len(iban) < 15 or len(iban) > 34:
        raise ValueError("IBAN invalide (longueur).")
    remainder = 0
    for ch in iban[4:] + iban[:4]:
        expanded = str(ord(ch) - 55) if "A" <= ch <= "Z" else ch
        for digit in expanded:
            remainder = (remainder * 10 + int(digit)) % 97
    if remainder != 1:
        raise ValueError("IBAN invalide (contrôle).")
    return iban


def _normalize_bic(raw: Any) -> str | None:
    if raw is None:
        return None
    value = str(raw).strip().replace(" ", "")
    if not value:
        return None
    bic = value.upper()
    if not re.fullmatch(r"[A-Z0-9]{8}([A-Z0-9]{3})?", bic):
        raise ValueError("BIC invalide (8 ou 11 caractères alphanumériques).")
    return bic


def _normalize_required_label(raw: Any, *, label: str, max_length: int = 180) -> str:
    value = str(raw or "").strip()
    if not value:
        raise ValueError(f"{label} obligatoire.")
    if len(value) > max_length:
        raise ValueError(f"{label} trop long ({max_length} caractères maximum).")
    return value


def _normalize_optional_http_url(raw: Any, *, label: str = "URL") -> str | None:
    value = str(raw or "").strip()
    if not value:
        return None
    value = value[:512]
    parsed = urlparse(value)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} invalide: utilisez une URL http(s).")
    return value


def _normalize_facturx_profile(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower().replace(" ", "").replace("_", "-")
    if not normalized:
        return None
    return normalized


def _normalize_naf_code(raw: Any) -> str | None:
    if raw is None:
        return None
    value = str(raw).strip().upper().replace(" ", "")
    if not value:
        return None
    compact = value.replace(".", "")
    if not re.fullmatch(r"[0-9]{4}[A-Z]", compact):
        raise ValueError(
            "Code NAF / APE invalide (format attendu : 62.01Z ou 6201Z ; 72.2C est un ancien format NAF 2003)."
        )
    return f"{compact[:2]}.{compact[2:]}"


def _normalize_invoice_template_key(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    if normalized not in INVOICE_TEMPLATE_KEYS:
        raise ValueError("template_key invalide.")
    return normalized


def _normalize_template_option_bool(key: str, raw: Any) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        lowered = raw.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    raise ValueError(f"template_options invalide: {key}.")


def _normalize_document_tags(raw: Any) -> list[str]:
    if raw is None:
        return []
    values = raw if isinstance(raw, list) else str(raw).split(",")
    tags: list[str] = []
    seen: set[str] = set()
    for item in values:
        tag = str(item or "").strip().lstrip("#")[:40]
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        tags.append(tag)
        if len(tags) >= 10:
            break
    return tags


def _normalize_custom_fields(raw: Any) -> list[dict[str, str]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("template_options invalide: custom_fields.")
    fields: list[dict[str, str]] = []
    for item in raw[:12]:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()[:60]
        value = str(item.get("value") or "").strip()[:240]
        if not label and not value:
            continue
        fields.append({"label": label, "value": value})
    return fields


def _normalize_payment_methods(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("template_options invalide: payment_methods.")
    methods: list[str] = []
    for item in raw[: len(PAYMENT_METHOD_OPTION_IDS)]:
        method = str(item or "").strip()
        if method in PAYMENT_METHOD_OPTION_IDS and method not in methods:
            methods.append(method)
    return methods


def _normalize_payment_bank_account(raw: Any) -> dict[str, str] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("template_options invalide: payment_bank_account.")
    bank_id = str(raw.get("id") or "").strip()[:80]
    label = str(raw.get("label") or "").strip()[:80]
    iban = _normalize_iban(raw.get("iban"))
    bic = _normalize_bic(raw.get("bic"))
    if not iban and not bic:
        return None
    payload: dict[str, str] = {"label": label or "RIB de paiement"}
    if bank_id:
        payload["id"] = bank_id
    if iban:
        payload["iban"] = iban
    if bic:
        payload["bic"] = bic
    return payload


def _normalize_line_columns(raw: Any) -> dict[str, bool]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("template_options invalide: line_columns.")
    return {key: bool(raw[key]) for key in INVOICE_LINE_COLUMN_OPTION_IDS if key in raw and isinstance(raw[key], bool)}


def _normalize_advance_payments(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("template_options invalide: advance_payments.")
    payments: list[dict[str, Any]] = []
    for item in raw[:12]:
        if not isinstance(item, dict):
            continue
        try:
            amount_ht = float(item.get("amount_ht") or 0)
            amount_vat = float(item.get("amount_vat") or 0)
            amount_ttc = float(item.get("amount_ttc") or 0)
            vat_rate = float(item.get("vat_rate") or 0)
            percent = float(item.get("percent") or 0)
        except (TypeError, ValueError):
            continue
        if amount_ttc <= 0 and amount_ht <= 0:
            continue
        reference = str(item.get("reference") or "").strip()[:80]
        label = str(item.get("label") or "").strip()[:120]
        source = str(item.get("source") or "").strip()[:40]
        payment = {
            "reference": reference,
            "label": label or "Acompte",
            "source": source or "advance_payment",
            "amount_ht": round(amount_ht, 2),
            "amount_vat": round(amount_vat, 2),
            "amount_ttc": round(amount_ttc, 2),
            "vat_rate": round(vat_rate, 2),
        }
        if 0 < percent <= 100:
            payment["percent"] = round(percent, 2)
        payments.append(payment)
    return payments


def _normalize_requested_advance(raw: Any) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("template_options invalide: requested_advance.")
    try:
        amount_ht = float(raw.get("amount_ht") or 0)
        amount_vat = float(raw.get("amount_vat") or 0)
        amount_ttc = float(raw.get("amount_ttc") or 0)
        vat_rate = float(raw.get("vat_rate") or 0)
        percent = float(raw.get("percent") or 0)
    except (TypeError, ValueError):
        return None
    if amount_ttc <= 0 and amount_ht <= 0:
        return None
    reference = str(raw.get("reference") or "").strip()[:80]
    label = str(raw.get("label") or "").strip()[:120]
    advance = {
        "reference": reference,
        "label": label or "Acompte demandé",
        "source": "requested_advance",
        "amount_ht": round(amount_ht, 2),
        "amount_vat": round(amount_vat, 2),
        "amount_ttc": round(amount_ttc, 2),
        "vat_rate": round(vat_rate, 2),
    }
    if 0 < percent <= 100:
        advance["percent"] = round(percent, 2)
    return advance


def _normalize_template_options(value: dict | None) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("template_options invalide.")
    normalized: dict[str, Any] = {}
    for key, raw in value.items():
        if key not in INVOICE_TEMPLATE_OPTION_KEYS:
            continue
        if key in INVOICE_TEMPLATE_BOOL_OPTION_KEYS:
            normalized[key] = _normalize_template_option_bool(key, raw)
            continue
        if key == "document_language":
            language = str(raw or "").strip().lower().replace("_", "-")
            if language in {"fr-fr", "fr"}:
                normalized[key] = "fr"
                continue
            if language in {"en-gb", "en-us", "en"}:
                normalized[key] = "en"
                continue
            if not language:
                normalized[key] = "fr"
                continue
            raise ValueError("template_options invalide: document_language.")
        if key == "document_title":
            normalized[key] = str(raw or "").strip()[:140]
            continue
        if key == "document_tags":
            normalized[key] = _normalize_document_tags(raw)
            continue
        if key == "custom_fields":
            normalized[key] = _normalize_custom_fields(raw)
            continue
        if key == "payment_methods":
            normalized[key] = _normalize_payment_methods(raw)
            continue
        if key == "payment_bank_account":
            normalized[key] = _normalize_payment_bank_account(raw)
            continue
        if key == "line_columns":
            normalized[key] = _normalize_line_columns(raw)
            continue
        if key == "advance_payments":
            normalized[key] = _normalize_advance_payments(raw)
            continue
        if key == "requested_advance":
            requested_advance = _normalize_requested_advance(raw)
            if requested_advance:
                normalized[key] = requested_advance
            continue
        if key == "operation_nature":
            operation = str(raw or "").strip().lower()
            normalized[key] = operation if operation in {"goods", "services", "mixed"} else "services"
            continue
        if key in {
            "delivery_address",
            "legal_mentions_text",
            "legal_footer_text",
            "legal_penalty_prefix",
            "legal_recovery_prefix",
            "legal_discount_text",
            "document_discount_amount_ht",
        }:
            normalized[key] = str(raw or "").strip()[:1200]
            continue
        if key == "document_discount_input_mode":
            normalized[key] = "amount" if str(raw or "").strip().lower() == "amount" else "percent"
            continue
        if key == "global_vat_draft":
            normalized[key] = raw if isinstance(raw, dict) else {}
            continue
        if key in {"legal_penalty_rate", "legal_recovery_fee"}:
            normalized[key] = str(raw or "").strip()[:16]
            continue
    return normalized


def _is_hex_color(value: str | None) -> bool:
    if value is None:
        return False
    raw = str(value).strip()
    if not raw.startswith("#"):
        return False
    if len(raw) not in {4, 7}:
        return False
    return all(ch in "0123456789abcdefABCDEF" for ch in raw[1:])


def _validate_password(value: str) -> str:
    min_len = int(getattr(settings, "PASSWORD_MIN_LENGTH", 12) or 12)
    max_len = int(getattr(settings, "PASSWORD_MAX_LENGTH", 256) or 256)
    if len(value or "") < min_len:
        raise PydanticCustomError(
            "password_too_short",
            f"Mot de passe trop court (minimum {min_len} caractères).",
        )
    if len(value or "") > max_len:
        raise PydanticCustomError(
            "password_too_long",
            f"Mot de passe trop long (maximum {max_len} caractères).",
        )
    if (value or "").strip().lower() in WEAK_PASSWORDS:
        raise PydanticCustomError(
            "password_too_weak",
            "Mot de passe trop faible. Utilisez une phrase de passe ou un mot de passe plus complexe.",
        )
    return value


def _normalize_vat_rate(value: Any) -> float:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        raise ValueError("Taux de TVA invalide.")
    if rate < 0 or rate > 100:
        raise ValueError("Taux de TVA invalide: choisissez une valeur entre 0 et 100.")
    return rate


def _bounded_float(value: Any, *, label: str, max_abs) -> float:
    amount = ensure_max_abs(value, max_abs, label)
    return float(amount)


def _normalize_document_amount(value: Any, *, label: str = "Montant") -> float:
    return _bounded_float(value, label=label, max_abs=MAX_DOCUMENT_AMOUNT)


def _normalize_line_quantity(value: Any) -> float:
    return _bounded_float(value, label="Quantité", max_abs=MAX_LINE_QUANTITY)


class RegisterPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")  # Ignore deprecated/unknown fields from older clients.
    company_name: str
    email: ValidatedEmail
    password: str
    role: Optional[str] = None
    plan: Optional[str] = None
    billing_period: Optional[str] = None
    checkout_requested: bool = False
    demo_data: bool = False
    demo_preset: Optional[str] = None
    demo_invitation_token: Optional[str] = None
    professional_use_confirmed: bool = False
    accepted_legal_docs: Optional[List[dict[str, Any]]] = None

    @field_validator("company_name")
    def company_name_required(cls, v):
        normalized = (v or "").strip()
        if not normalized:
            raise ValueError("Raison sociale requise.")
        if len(normalized) > 180:
            raise ValueError("Raison sociale trop longue.")
        return normalized

    @field_validator("password")
    def password_policy(cls, v):
        return _validate_password(v)

    @field_validator("role", mode="before")
    def ignore_role(cls, v):
        return None

    @field_validator("plan")
    def validate_plan(cls, v):
        if v is None:
            return None
        normalized = (v or "").strip().lower()
        if normalized == "enterprise":
            return None
        if normalized not in {"starter", "pro"}:
            raise ValueError("Plan invalide. Valeurs acceptées : starter, pro.")
        return normalized

    @field_validator("billing_period")
    def validate_billing_period(cls, v):
        if v is None:
            return None
        normalized = (v or "").strip().lower()
        if normalized not in {"monthly", "yearly"}:
            raise ValueError("Période invalide. Valeurs acceptées : monthly, yearly.")
        return normalized

    @field_validator("demo_preset")
    def validate_demo_preset(cls, v):
        if v is None:
            return None
        normalized = (v or "").strip().lower()
        if not normalized:
            return None
        if normalized not in {"services", "retail", "construction", "public_sector", "health"}:
            raise ValueError("Scénario démo invalide.")
        return normalized

    @field_validator("demo_invitation_token")
    def validate_demo_invitation_token(cls, v):
        if v is None:
            return None
        normalized = (v or "").strip()
        if not normalized:
            return None
        if len(normalized) > 4096:
            raise ValueError("Invitation de démo invalide.")
        return normalized


class LoginPayload(BaseModel):
    email: ValidatedEmail
    password: str = Field(max_length=256)
    mfa_code: Optional[str] = None


class PasswordResetRequest(BaseModel):
    email: ValidatedEmail


class PasswordResetConfirm(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    def password_policy(cls, v):
        return _validate_password(v)


class PasswordChangePayload(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    def password_policy(cls, v):
        return _validate_password(v)


class UserCreate(BaseModel):
    email: ValidatedEmail
    password: str
    role: str = "accountant"

    @field_validator("password")
    def password_policy(cls, v):
        return _validate_password(v)


class UserInviteCreate(BaseModel):
    email: ValidatedEmail
    role: str = "accountant"
    customer_id: Optional[str] = None


class MembershipRoleUpdate(BaseModel):
    role: str


class InviteAccept(BaseModel):
    token: str
    password: str
    name: Optional[str] = None

    @field_validator("password")
    def password_policy(cls, v):
        return _validate_password(v)


class InviteRevoke(BaseModel):
    invite_id: Optional[str] = None
    email: Optional[ValidatedEmail] = None


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str | None = None
    token_type: str = "bearer"


class TokenRefreshRequest(BaseModel):
    refresh_token: str | None = None


class GoogleLoginPayload(BaseModel):
    id_token: str
    mfa_code: Optional[str] = None
    company_name: Optional[str] = None
    professional_use_confirmed: bool = False
    accepted_legal_docs: Optional[List[dict[str, Any]]] = None


class SwitchTenantPayload(BaseModel):
    tenant_id: str


class ApiKeyCreate(BaseModel):
    name: Optional[str] = None
    scopes: Optional[List[str]] = None


class CustomerCreate(BaseModel):
    name: str
    email: Optional[ValidatedEmail] = None
    phone: Optional[str] = None
    contact_name: Optional[str] = None
    address: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    postal_code: Optional[str] = None
    city: Optional[str] = None
    country_code: Optional[str] = None
    siret: Optional[str] = None
    siren: Optional[str] = None
    vat_number: Optional[str] = None
    endpoint_id: Optional[str] = None
    pdp_name: Optional[str] = None
    public_service_code: Optional[str] = None
    public_commitment_reference: Optional[str] = None
    chorus_service_code_required: Optional[bool] = None
    chorus_commitment_required: Optional[bool] = None
    chorus_billing_address_active: Optional[bool] = None
    country: str = "FR"
    client_type: Optional[str] = None
    payment_terms_default: Optional[str] = None
    payment_method_default: Optional[str] = None
    default_vat_rate: Optional[float] = None
    iban: Optional[str] = None
    bic: Optional[str] = None
    internal_note: Optional[str] = None

    @field_validator("name", mode="before")
    def normalize_customer_name(cls, v):
        return _normalize_required_label(v, label="Nom du client")

    @field_validator("siret", mode="before")
    def normalize_customer_siret(cls, v):
        return _normalize_fr_identifier(v, lengths={14}, label="SIRET")

    @field_validator("siren", mode="before")
    def normalize_customer_siren(cls, v):
        return _normalize_fr_identifier(v, lengths={9}, label="SIREN")

    @field_validator("vat_number", mode="before")
    def normalize_customer_vat(cls, v):
        return _normalize_vat(v)

    @field_validator("iban", mode="before")
    def normalize_customer_iban(cls, v):
        return _normalize_iban(v)

    @field_validator("bic", mode="before")
    def normalize_customer_bic(cls, v):
        return _normalize_bic(v)

    @field_validator("country", "country_code", mode="before")
    def normalize_customer_country(cls, v):
        if v is None:
            return None
        raw = str(v).strip().upper()
        return raw or None

    @field_validator("public_service_code", mode="before")
    def normalize_public_service_code(cls, v):
        return _normalize_chorus_reference(v, max_chars=100, label="Code service Chorus")

    @field_validator("public_commitment_reference", mode="before")
    def normalize_public_commitment_reference(cls, v):
        return _normalize_chorus_reference(v, max_chars=10, label="Engagement juridique Chorus")


class CustomerUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[ValidatedEmail] = None
    phone: Optional[str] = None
    contact_name: Optional[str] = None
    address: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    postal_code: Optional[str] = None
    city: Optional[str] = None
    country_code: Optional[str] = None
    siret: Optional[str] = None
    siren: Optional[str] = None
    vat_number: Optional[str] = None
    endpoint_id: Optional[str] = None
    pdp_name: Optional[str] = None
    public_service_code: Optional[str] = None
    public_commitment_reference: Optional[str] = None
    chorus_service_code_required: Optional[bool] = None
    chorus_commitment_required: Optional[bool] = None
    chorus_billing_address_active: Optional[bool] = None
    country: Optional[str] = None
    client_type: Optional[str] = None
    payment_terms_default: Optional[str] = None
    payment_method_default: Optional[str] = None
    default_vat_rate: Optional[float] = None
    iban: Optional[str] = None
    bic: Optional[str] = None
    internal_note: Optional[str] = None

    @field_validator("name", mode="before")
    def normalize_customer_name(cls, v):
        if v is None:
            return None
        return _normalize_required_label(v, label="Nom du client")

    @field_validator("siret", mode="before")
    def normalize_customer_siret(cls, v):
        return _normalize_fr_identifier(v, lengths={14}, label="SIRET")

    @field_validator("siren", mode="before")
    def normalize_customer_siren(cls, v):
        return _normalize_fr_identifier(v, lengths={9}, label="SIREN")

    @field_validator("vat_number", mode="before")
    def normalize_customer_vat(cls, v):
        return _normalize_vat(v)

    @field_validator("iban", mode="before")
    def normalize_customer_iban(cls, v):
        return _normalize_iban(v)

    @field_validator("bic", mode="before")
    def normalize_customer_bic(cls, v):
        return _normalize_bic(v)

    @field_validator("country", "country_code", mode="before")
    def normalize_customer_country(cls, v):
        if v is None:
            return None
        raw = str(v).strip().upper()
        return raw or None

    @field_validator("public_service_code", mode="before")
    def normalize_public_service_code(cls, v):
        return _normalize_chorus_reference(v, max_chars=100, label="Code service Chorus")

    @field_validator("public_commitment_reference", mode="before")
    def normalize_public_commitment_reference(cls, v):
        return _normalize_chorus_reference(v, max_chars=10, label="Engagement juridique Chorus")


class CustomerListOut(BaseModel):
    id: str
    name: str
    client_type: Optional[str] = None
    email: Optional[ValidatedEmail] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    postal_code: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    country_code: Optional[str] = None
    siret: Optional[str] = None
    siren: Optional[str] = None
    vat_number: Optional[str] = None
    endpoint_id: Optional[str] = None
    pdp_name: Optional[str] = None
    public_service_code: Optional[str] = None
    public_commitment_reference: Optional[str] = None
    chorus_service_code_required: Optional[bool] = None
    chorus_commitment_required: Optional[bool] = None
    chorus_billing_address_active: Optional[bool] = None
    payment_terms_default: Optional[str] = None
    payment_method_default: Optional[str] = None
    default_vat_rate: Optional[float] = None
    iban: Optional[str] = None
    bic: Optional[str] = None
    internal_note: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class CustomerContactCreate(BaseModel):
    name: Optional[str] = None
    email: ValidatedEmail
    role: Optional[str] = None  # billing|cc|other
    send_invoices: bool = True
    send_quotes: bool = True
    is_primary: bool = False


class CustomerContactUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[ValidatedEmail] = None
    role: Optional[str] = None
    send_invoices: Optional[bool] = None
    send_quotes: Optional[bool] = None
    is_primary: Optional[bool] = None


class CustomerContactOut(BaseModel):
    id: str
    customer_id: str
    name: Optional[str] = None
    email: ValidatedEmail
    role: str
    send_invoices: bool
    send_quotes: bool
    is_primary: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class InvoiceLineIn(BaseModel):
    product_name: str
    line_type: str = "item"
    display_number: Optional[str] = None
    reference: Optional[str] = None
    source_line_id: Optional[str] = None
    detail: Optional[str] = None
    quantity: float = 1.0
    unit_price: float
    vat_rate: float = 20.0
    vat_category: str = "S"
    exemption_reason_code: Optional[str] = None
    unit_code: str = "C62"
    item_id: Optional[str] = None
    accounting_account: Optional[str] = None

    @field_validator("vat_category")
    def valid_cat(cls, v):
        allowed = {"S", "Z", "AE", "O", "E"}
        if v not in allowed:
            raise ValueError(f"vat_category doit être dans {allowed}")
        return v

    @field_validator("quantity", mode="before")
    def valid_quantity(cls, v):
        return _normalize_line_quantity(v)

    @field_validator("unit_price", mode="before")
    def valid_unit_price(cls, v):
        return _normalize_document_amount(v, label="Prix HT")

    @field_validator("vat_rate", mode="before")
    def valid_vat_rate(cls, v):
        return _normalize_vat_rate(v)

    @field_validator("unit_code", mode="before")
    def valid_unit_code(cls, v):
        return normalize_unit_code(v)

    @field_validator("line_type")
    def valid_line_type(cls, v):
        if v not in {"item", "title", "comment"}:
            raise ValueError("line_type doit être item, title ou comment")
        return v

    @field_validator("display_number", mode="before")
    def clean_display_number(cls, v):
        value = str(v or "").strip()
        return value[:24] or None

    @field_validator("accounting_account", mode="before")
    def valid_accounting_account(cls, v):
        if v is None:
            return None
        normalized = str(v).strip().replace(" ", "")
        if not normalized:
            return None
        if not re.fullmatch(r"[A-Z0-9._-]{3,20}", normalized):
            raise ValueError("Catégorie compta invalide.")
        return normalized


class CreditNoteLineSelection(BaseModel):
    line_id: str
    quantity: float

    @field_validator("quantity")
    def valid_quantity(cls, v):
        if v is None or float(v) <= 0:
            raise ValueError("quantity doit être > 0")
        return float(v)


class CreditNoteCreateFromInvoice(BaseModel):
    """Création d'un avoir partiel guidé à partir d'une facture."""

    note: Optional[str] = None
    lines: List[CreditNoteLineSelection]

    @field_validator("lines")
    def valid_lines(cls, v):
        if not v:
            raise ValueError("Sélectionnez au moins une ligne")
        return v


class InvoiceCreate(BaseModel):
    customer_id: str
    number: Optional[str] = None
    currency: str = "EUR"
    note: Optional[str] = None
    template_key: Optional[str] = None
    template_options: Optional[dict] = None
    purchase_order_number: Optional[str] = None
    public_service_code: Optional[str] = None
    payment_terms: Optional[str] = None
    quote_id: Optional[str] = None
    invoice_kind: str = "standard"
    deposit_invoice_ids: Optional[List[str]] = None
    due_days: Optional[int] = None
    issue_date: Optional[date] = None
    due_date: Optional[datetime] = None
    service_date: Optional[date] = None
    delivery_address: Optional[str] = None
    delivery_address_differs: Optional[bool] = False
    operation_nature: Optional[str] = "services"
    facturx_profile: Optional[str] = None
    type: str = "invoice"
    related_invoice_id: Optional[str] = None
    lines: List[InvoiceLineIn]

    @field_validator("type")
    def valid_type(cls, v):
        if v not in {"invoice", "credit_note"}:
            raise ValueError("type doit être invoice ou credit_note")
        return v

    @field_validator("invoice_kind")
    def valid_invoice_kind(cls, v):
        value = (v or "standard").strip().lower()
        if value not in INVOICE_KINDS:
            raise ValueError("invoice_kind doit être standard, deposit ou final")
        return value

    @field_validator("deposit_invoice_ids")
    def valid_deposit_invoice_ids(cls, v):
        if v is None:
            return None
        cleaned = []
        seen = set()
        for raw in v:
            value = str(raw or "").strip()
            if value and value not in seen:
                cleaned.append(value)
                seen.add(value)
        return cleaned

    @field_validator("operation_nature")
    def valid_operation(cls, v):
        if v is None:
            return "services"
        if v not in {"goods", "services", "mixed"}:
            raise ValueError("operation_nature doit être goods, services ou mixed")
        return v

    @field_validator("facturx_profile")
    def valid_facturx_profile(cls, v):
        normalized = _normalize_facturx_profile(v)
        if normalized is None:
            return None
        if normalized not in FACTURX_PROFILES:
            raise ValueError(f"facturx_profile doit être dans {sorted(FACTURX_PROFILES)}")
        return normalized

    @field_validator("template_key")
    def valid_template_key(cls, v):
        return _normalize_invoice_template_key(v)

    @field_validator("template_options")
    def valid_template_options(cls, v):
        return _normalize_template_options(v)

    @field_validator("public_service_code", mode="before")
    def normalize_public_service_code(cls, v):
        return _normalize_chorus_reference(v, max_chars=100, label="Code service Chorus")


class InvoiceUpdate(BaseModel):
    customer_id: Optional[str] = None
    currency: Optional[str] = None
    note: Optional[str] = None
    payment_terms: Optional[str] = None
    quote_id: Optional[str] = None
    invoice_kind: Optional[str] = None
    deposit_invoice_ids: Optional[List[str]] = None
    due_days: Optional[int] = None
    issue_date: Optional[date] = None
    due_date: Optional[datetime] = None
    service_date: Optional[date] = None
    purchase_order_number: Optional[str] = None
    public_service_code: Optional[str] = None
    delivery_address: Optional[str] = None
    operation_nature: Optional[str] = None
    facturx_profile: Optional[str] = None
    delivery_address_differs: Optional[bool] = None
    template_key: Optional[str] = None
    template_options: Optional[dict] = None
    lines: Optional[List[InvoiceLineIn]] = None

    @field_validator("invoice_kind")
    def valid_update_invoice_kind(cls, v):
        if v is None:
            return None
        value = (v or "standard").strip().lower()
        if value not in INVOICE_KINDS:
            raise ValueError("invoice_kind doit être standard, deposit ou final")
        return value

    @field_validator("deposit_invoice_ids")
    def valid_update_deposit_invoice_ids(cls, v):
        if v is None:
            return None
        cleaned = []
        seen = set()
        for raw in v:
            value = str(raw or "").strip()
            if value and value not in seen:
                cleaned.append(value)
                seen.add(value)
        return cleaned

    @field_validator("operation_nature")
    def valid_update_operation(cls, v):
        if v is None:
            return None
        if v not in {"goods", "services", "mixed"}:
            raise ValueError("operation_nature doit être goods, services ou mixed")
        return v

    @field_validator("facturx_profile")
    def valid_facturx_profile(cls, v):
        normalized = _normalize_facturx_profile(v)
        if normalized is None:
            return None
        if normalized not in FACTURX_PROFILES:
            raise ValueError(f"facturx_profile doit être dans {sorted(FACTURX_PROFILES)}")
        return normalized

    @field_validator("template_key")
    def valid_update_template_key(cls, v):
        return _normalize_invoice_template_key(v)

    @field_validator("template_options")
    def valid_update_template_options(cls, v):
        return _normalize_template_options(v)

    @field_validator("public_service_code", mode="before")
    def normalize_public_service_code(cls, v):
        return _normalize_chorus_reference(v, max_chars=100, label="Code service Chorus")


class InvoiceLineOut(BaseModel):
    id: str
    line_type: str = "item"
    display_number: Optional[str] = None
    reference: Optional[str] = None
    product_name: str
    detail: Optional[str] = None
    quantity: float
    unit_price: float
    vat_rate: float
    vat_category: str
    exemption_reason_code: Optional[str] = None
    unit_code: Optional[str] = "C62"
    accounting_account: Optional[str] = None
    line_total: float
    model_config = ConfigDict(from_attributes=True)

    @field_validator("unit_code", mode="before")
    def valid_unit_code(cls, v):
        return normalize_unit_code(v)


class AccountingLineUpdate(BaseModel):
    id: str
    accounting_account: Optional[str] = None

    @field_validator("accounting_account", mode="before")
    def valid_accounting_account(cls, v):
        if v is None:
            return None
        normalized = str(v).strip().replace(" ", "")
        if not normalized:
            return None
        if not re.fullmatch(r"[A-Z0-9._-]{3,20}", normalized):
            raise ValueError("Catégorie compta invalide.")
        return normalized


class AccountingLinesUpdate(BaseModel):
    lines: List[AccountingLineUpdate]


class PaymentCreate(BaseModel):
    date: Optional[datetime] = None
    method: Optional[str] = None
    amount: float
    reference: Optional[str] = None
    settlement_mode: Optional[str] = None
    accounting_category: Optional[str] = None
    receipt_label: Optional[str] = None
    receipt_url: Optional[str] = None

    @field_validator("amount", mode="before")
    def valid_amount(cls, v):
        return _normalize_document_amount(v, label="Montant réglé")

    @field_validator("settlement_mode")
    def valid_settlement_mode(cls, v):
        value = (v or "").strip().lower()
        if not value:
            return None
        if value not in {"bank", "cash", "manual"}:
            raise ValueError("Mode de justification invalide.")
        return value

    @field_validator("accounting_category", "receipt_label", "method", "reference")
    def clean_payment_text(cls, v):
        value = (v or "").strip()
        return value[:512] or None

    @field_validator("receipt_url", mode="before")
    def valid_receipt_url(cls, v):
        return _normalize_optional_http_url(v, label="Lien justificatif")


class PaymentOut(BaseModel):
    id: str
    date: datetime
    method: Optional[str] = None
    amount: float
    reference: Optional[str] = None
    settlement_mode: Optional[str] = None
    accounting_category: Optional[str] = None
    receipt_label: Optional[str] = None
    receipt_url: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class CreditNoteRefundCreate(BaseModel):
    date: Optional[datetime] = None
    method: Optional[str] = None
    amount: float
    reference: Optional[str] = None

    @field_validator("amount", mode="before")
    def valid_amount(cls, v):
        return _normalize_document_amount(v, label="Montant remboursé")


class CreditNoteRefundOut(BaseModel):
    id: str
    date: datetime
    method: Optional[str] = None
    amount: float
    reference: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class EmailEventOut(BaseModel):
    id: str
    type: str
    to: str
    status: str
    delivery_mode: str = "smtp"
    error: Optional[str] = None
    provider: Optional[str] = None
    provider_message_id: Optional[str] = None
    provider_status: Optional[str] = None
    provider_event_at: Optional[datetime] = None
    created_at: datetime
    sent_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class InvoiceAppliedDepositOut(BaseModel):
    id: str
    quote_id: str
    final_invoice_id: str
    deposit_invoice_id: str
    amount_ht: float
    amount_vat: float
    amount_ttc: float
    vat_rate: Optional[float] = None
    deposit_number: Optional[str] = None
    deposit_issue_date: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class InvoiceOut(BaseModel):
    id: str
    customer_id: str
    quote_id: Optional[str] = None
    invoice_kind: str = "standard"
    applied_deposits: List[InvoiceAppliedDepositOut] = Field(default_factory=list)
    number: Optional[str] = None
    currency: str
    status: str
    issue_date: datetime
    updated_at: Optional[datetime] = None
    service_date: Optional[date] = None
    due_date: Optional[datetime] = None
    payment_terms: Optional[str] = None
    delivery_address: Optional[str] = None
    delivery_address_differs: Optional[bool] = False
    operation_nature: Optional[str] = None
    template_key: Optional[str] = None
    template_options: Optional[dict] = None
    purchase_order_number: Optional[str] = None
    public_service_code: Optional[str] = None
    total_ex_vat: float
    total_vat: float
    total_inc_vat: float
    sent_at: Optional[datetime] = None
    paid_at: Optional[datetime] = None
    reminder_count: int = 0
    last_reminder_at: Optional[datetime] = None
    days_overdue: int = 0
    next_followup_at: Optional[datetime] = None
    next_followup_offset: Optional[int] = None
    followup_state: Optional[str] = None
    followup_block_reason: Optional[str] = None
    followup_schedule: List[dict[str, Any]] = Field(default_factory=list)
    can_followup: bool = False
    last_email_status: Optional[str] = None
    last_email_delivery_mode: Optional[str] = None
    last_email_provider: Optional[str] = None
    last_email_provider_status: Optional[str] = None
    last_email_provider_event_at: Optional[datetime] = None
    last_email_at: Optional[datetime] = None
    last_email_error: Optional[str] = None
    public_enabled: Optional[bool] = None
    public_view_count: Optional[int] = None
    public_first_viewed_at: Optional[datetime] = None
    public_last_viewed_at: Optional[datetime] = None
    type: str = "invoice"
    related_invoice_id: Optional[str] = None
    related_invoice_number: Optional[str] = None
    related_invoice_issue_date: Optional[datetime] = None
    related_invoice_total_inc_vat: Optional[float] = None
    customer_name: Optional[str] = None
    pdfa3_status: Optional[str] = None
    pdfa3_report: Optional[str] = None
    facturx_spec_version: Optional[str] = None
    facturx_profile: Optional[str] = None
    accounting_readiness: Optional[dict[str, Any]] = None
    model_config = ConfigDict(from_attributes=True)


class InvoiceListOut(BaseModel):
    id: str
    customer_id: str
    quote_id: Optional[str] = None
    invoice_kind: str = "standard"
    number: Optional[str] = None
    currency: str
    status: str
    issue_date: datetime
    service_date: Optional[date] = None
    due_date: Optional[datetime] = None
    payment_terms: Optional[str] = None
    delivery_address: Optional[str] = None
    delivery_address_differs: Optional[bool] = False
    operation_nature: Optional[str] = None
    template_key: Optional[str] = None
    template_options: Optional[dict] = None
    purchase_order_number: Optional[str] = None
    public_service_code: Optional[str] = None
    total_ex_vat: float
    total_vat: float
    total_inc_vat: float
    sent_at: Optional[datetime] = None
    paid_at: Optional[datetime] = None
    reminder_count: int = 0
    last_reminder_at: Optional[datetime] = None
    days_overdue: int = 0
    next_followup_at: Optional[datetime] = None
    next_followup_offset: Optional[int] = None
    followup_state: Optional[str] = None
    followup_block_reason: Optional[str] = None
    followup_schedule: List[dict[str, Any]] = Field(default_factory=list)
    can_followup: bool = False
    last_email_status: Optional[str] = None
    last_email_delivery_mode: Optional[str] = None
    last_email_provider: Optional[str] = None
    last_email_provider_status: Optional[str] = None
    last_email_provider_event_at: Optional[datetime] = None
    last_email_at: Optional[datetime] = None
    last_email_error: Optional[str] = None
    public_enabled: Optional[bool] = None
    public_view_count: Optional[int] = None
    public_first_viewed_at: Optional[datetime] = None
    public_last_viewed_at: Optional[datetime] = None
    type: str = "invoice"
    related_invoice_id: Optional[str] = None
    related_invoice_number: Optional[str] = None
    related_invoice_issue_date: Optional[datetime] = None
    related_invoice_total_inc_vat: Optional[float] = None
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    pdfa3_status: Optional[str] = None
    facturx_spec_version: Optional[str] = None
    facturx_profile: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class ClientInvoiceOut(BaseModel):
    id: str
    number: Optional[str] = None
    status: str
    issue_date: datetime
    due_date: Optional[datetime] = None
    total_inc_vat: float
    currency: str
    model_config = ConfigDict(from_attributes=True)


class DocumentAttachmentOut(BaseModel):
    id: str
    filename: str
    label: Optional[str] = None
    content_type: str
    size_bytes: int
    public_visible: bool = False
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class DocumentAttachmentPatch(BaseModel):
    label: Optional[str] = None
    public_visible: Optional[bool] = None


class AttachmentsUsageOut(BaseModel):
    used_bytes: int
    quota_bytes: int
    remaining_bytes: int = 0
    document_attachments_bytes: int = 0
    purchase_attachments_bytes: int = 0
    invoice_artifacts_bytes: int = 0
    legacy_invoice_artifacts_bytes: int = 0
    plan: str
    max_file_bytes: int
    max_per_document: int
    allowed_content_types: List[str] = []
    model_config = ConfigDict(from_attributes=True)


class CreditNoteSummary(BaseModel):
    id: str
    number: Optional[str] = None
    status: str
    issue_date: datetime
    total_inc_vat: float
    model_config = ConfigDict(from_attributes=True)


class InvoiceDetailOut(InvoiceOut):
    note: Optional[str] = None
    lines: List[InvoiceLineOut] = []
    payments: List[PaymentOut] = []
    refunds: List[CreditNoteRefundOut] = []
    refunds_total: float = 0.0
    refund_balance: float = 0.0
    credit_notes: List[CreditNoteSummary] = []
    credit_notes_total: float = 0.0
    credit_notes_total_issued: float = 0.0
    credit_notes_total_draft: float = 0.0
    credit_notes_total_canceled: float = 0.0
    credit_notes_total_all: float = 0.0
    email_events: List[EmailEventOut] = []
    balance_due: float
    card_payment_enabled: bool = False
    card_payment_reason: Optional[str] = None
    has_facturx: bool = False


class CompanyProfile(BaseModel):
    slug: Optional[str] = None
    name: str
    plan: Optional[str] = None
    subscription_status: Optional[str] = None
    trial_end: Optional[datetime] = None
    professional_use_confirmed_at: Optional[datetime] = None
    # Editable
    siret: Optional[str] = None
    rcs: Optional[str] = None
    naf_code: Optional[str] = None
    legal_form: Optional[str] = None
    share_capital: Optional[str] = None
    address: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    postal_code: Optional[str] = None
    city: Optional[str] = None
    country_code: Optional[str] = None
    country: Optional[str] = None
    phone: Optional[str] = None
    vat_number: Optional[str] = None
    vat_on_debits: Optional[bool] = None
    default_sales_vat_rate: Optional[float] = Field(None, ge=0, le=100)
    vat_regime: Optional[str] = None
    transaction_periodicity: Optional[str] = None
    payment_periodicity: Optional[str] = None
    payments_reporting_enabled: Optional[bool] = None
    ereporting_sync_status: Optional[str] = None
    seqino_last_periodicity_sync_at: Optional[datetime] = None
    seqino_last_periodicity_sync_status: Optional[str] = None
    iban: Optional[str] = None
    bic: Optional[str] = None
    logo_url: Optional[str] = None
    legal_mentions: Optional[str] = None
    vat_exemption_notice: Optional[str] = None
    late_payment_interest: Optional[str] = None
    recovery_fee_eur: Optional[float] = None
    discount_terms: Optional[str] = None
    email_subject_default: Optional[str] = None
    email_body_default: Optional[str] = None
    reminder_subject_default: Optional[str] = None
    reminder_body_default: Optional[str] = None
    quote_email_subject_default: Optional[str] = None
    quote_email_body_default: Optional[str] = None
    quote_followup_subject_default: Optional[str] = None
    quote_followup_body_default: Optional[str] = None
    # Devis - portail / acceptation
    quote_acceptance_mode: Optional[str] = None  # simple|otp
    quote_terms_url: Optional[str] = None
    quote_terms_required: Optional[bool] = None
    quote_otp_subject_default: Optional[str] = None
    quote_otp_body_default: Optional[str] = None
    # FEC - overrides
    fec_journal_code: Optional[str] = None
    fec_journal_label: Optional[str] = None
    fec_account_customer: Optional[str] = None
    fec_account_revenue: Optional[str] = None
    fec_account_vat: Optional[str] = None
    email_reply_to: Optional[str] = None
    retention_years: Optional[int] = Field(None, ge=1, le=20)

    model_config = ConfigDict(from_attributes=True)


class CompanyProfileUpdate(BaseModel):
    name: Optional[str] = None
    siret: Optional[str] = None
    rcs: Optional[str] = None
    naf_code: Optional[str] = None
    legal_form: Optional[str] = None
    share_capital: Optional[str] = None
    address: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    postal_code: Optional[str] = None
    city: Optional[str] = None
    country_code: Optional[str] = None
    country: Optional[str] = None
    phone: Optional[str] = None
    vat_number: Optional[str] = None
    vat_on_debits: Optional[bool] = None
    default_sales_vat_rate: Optional[float] = Field(None, ge=0, le=100)
    vat_regime: Optional[str] = None
    transaction_periodicity: Optional[str] = None
    payment_periodicity: Optional[str] = None
    payments_reporting_enabled: Optional[bool] = None
    iban: Optional[str] = None
    bic: Optional[str] = None
    logo_url: Optional[str] = None
    legal_mentions: Optional[str] = None
    vat_exemption_notice: Optional[str] = None
    late_payment_interest: Optional[str] = None
    recovery_fee_eur: Optional[float] = None
    discount_terms: Optional[str] = None
    email_subject_default: Optional[str] = None
    email_body_default: Optional[str] = None
    reminder_subject_default: Optional[str] = None
    reminder_body_default: Optional[str] = None
    quote_email_subject_default: Optional[str] = None
    quote_email_body_default: Optional[str] = None
    quote_followup_subject_default: Optional[str] = None
    quote_followup_body_default: Optional[str] = None
    quote_acceptance_mode: Optional[str] = None
    quote_terms_url: Optional[str] = None
    quote_terms_required: Optional[bool] = None
    quote_otp_subject_default: Optional[str] = None
    quote_otp_body_default: Optional[str] = None
    fec_journal_code: Optional[str] = None
    fec_journal_label: Optional[str] = None
    fec_account_customer: Optional[str] = None
    fec_account_revenue: Optional[str] = None
    fec_account_vat: Optional[str] = None
    email_reply_to: Optional[str] = None
    retention_years: Optional[int] = Field(None, ge=1, le=20)
    professional_use_confirmed: Optional[bool] = None

    @field_validator("fec_account_customer", "fec_account_revenue", "fec_account_vat", mode="before")
    def valid_fec_account(cls, v):
        if v is None:
            return None
        normalized = str(v).strip().replace(" ", "")
        if not normalized:
            return None
        if not re.fullmatch(r"[A-Z0-9._-]{3,20}", normalized):
            raise ValueError("Catégorie compta invalide.")
        return normalized

    @field_validator("quote_acceptance_mode")
    def validate_quote_acceptance_mode(cls, v):
        if v is None:
            return None
        raw = str(v).strip()
        if not raw:
            return None
        allowed = {"simple", "otp"}
        if raw not in allowed:
            raise ValueError("Mode d’acceptation devis invalide (simple|otp).")
        return raw

    @field_validator("quote_terms_url", "quote_otp_subject_default", "quote_otp_body_default", mode="before")
    def normalize_quote_strings(cls, v):
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    @field_validator("siret", mode="before")
    def normalize_siret(cls, v):
        return _normalize_fr_identifier(v, lengths={9, 14}, label="SIRET/SIREN")

    @field_validator("naf_code", mode="before")
    def normalize_naf_code(cls, v):
        return _normalize_naf_code(v)

    @field_validator("vat_number", mode="before")
    def normalize_vat_number(cls, v):
        return _normalize_vat(v)

    @field_validator("iban", mode="before")
    def normalize_iban(cls, v):
        return _normalize_iban(v)

    @field_validator("bic", mode="before")
    def normalize_bic(cls, v):
        return _normalize_bic(v)

    @field_validator("country_code", "country", mode="before")
    def normalize_country(cls, v):
        if v is None:
            return None
        raw = str(v).strip().upper()
        if not raw:
            return None
        if not re.fullmatch(r"[A-Z]{2}", raw):
            raise ValueError("Pays invalide (code ISO2 attendu).")
        return raw

    @model_validator(mode="after")
    def validate_fr_vat(self):
        vat_number = self.vat_number
        if not vat_number:
            return self
        country = (self.country_code or self.country or "").strip().upper()
        if country == "FR" or vat_number.startswith("FR"):
            if not re.fullmatch(r"FR[0-9A-Z]{2}[0-9]{9}", vat_number):
                raise ValueError("TVA FR invalide (format FR + 2 caractères + 9 chiffres).")
        return self


class CompanyBankAccountCreate(BaseModel):
    label: str = "RIB principal"
    iban: Optional[str] = None
    bic: Optional[str] = None
    is_default: bool = False

    @field_validator("label", mode="before")
    def normalize_label(cls, v):
        label = str(v or "").strip()
        if not label:
            return "RIB principal"
        return label[:80]

    @field_validator("iban", mode="before")
    def normalize_bank_iban(cls, v):
        return _normalize_iban(v)

    @field_validator("bic", mode="before")
    def normalize_bank_bic(cls, v):
        return _normalize_bic(v)

    @model_validator(mode="after")
    def require_payment_identifier(self):
        if not self.iban and not self.bic:
            raise ValueError("Renseignez au moins un IBAN ou un BIC.")
        return self


class CompanyBankAccountUpdate(BaseModel):
    label: Optional[str] = None
    iban: Optional[str] = None
    bic: Optional[str] = None
    is_default: Optional[bool] = None

    @field_validator("label", mode="before")
    def normalize_label(cls, v):
        if v is None:
            return None
        label = str(v or "").strip()
        return label[:80] if label else None

    @field_validator("iban", mode="before")
    def normalize_bank_iban(cls, v):
        return _normalize_iban(v)

    @field_validator("bic", mode="before")
    def normalize_bank_bic(cls, v):
        return _normalize_bic(v)


class CompanyBankAccountOut(BaseModel):
    id: str
    label: str
    iban: Optional[str] = None
    bic: Optional[str] = None
    is_default: bool = False
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


TENANT_PRESETS = {"standard", "commerce", "services", "btp"}
TENANT_FEATURE_KEYS = {
    "po",
    "delivery_address",
    "recurring",
    "progress_invoices",
    "catalog_advanced",
    "attachments",
    # stricter validations / behavior
    "compliance_strict",
    "invoice_strict",
    # public portals behavior (nested object)
    "portal",
    # email/PDF presentation (nested object)
    "branding",
    # printed legal mention templates by document kind (nested object)
    "document_legal_templates",
    # commercial signup intent (nested object, does not unlock paid features)
    "billing_request",
    # automatic invoice follow-ups (nested object)
    "dunning",
}
BILLING_REQUEST_FEATURE_KEYS = {
    "requested_plan",
    "active_plan",
    "requested_period",
    "checkout_requested",
    "requires_checkout",
}

PORTAL_THEME_KEYS = {"blue", "indigo", "emerald", "orange", "rose", "slate", "violet"}
PORTAL_QUOTE_CONVERT_MODES = {"auto_issue", "create_draft", "disabled"}
PORTAL_FEATURE_KEYS = {
    "theme",
    "card_payments",
    "show_credit_notes",
    "show_all_documents",
    "confirm_show_all_documents",
    "quote_convert_mode",
    "support_email",
    "footer_note",
}
BRANDING_PDF_TEMPLATE_KEYS = {"classic", "graphite", "ivory"}
BRANDING_FEATURE_KEYS = {
    "pdf_template",
    "email_accent",
    "email_signature",
    "email_footer_note",
}
DOCUMENT_LEGAL_TEMPLATE_KINDS = {"invoice", "quote"}
DOCUMENT_LEGAL_TEMPLATE_BOOL_KEYS = {"legal_terms_default"}
DOCUMENT_LEGAL_TEMPLATE_STRING_KEYS = {
    "legal_footer_text",
    "legal_penalty_prefix",
    "legal_recovery_prefix",
    "legal_discount_text",
    "legal_penalty_rate",
    "legal_recovery_fee",
    "saved_at",
}
DOCUMENT_LEGAL_TEMPLATE_KEYS = DOCUMENT_LEGAL_TEMPLATE_BOOL_KEYS | DOCUMENT_LEGAL_TEMPLATE_STRING_KEYS
DUNNING_FEATURE_KEYS = {
    "enabled",
    "schedule_days",
    "min_interval_hours",
    "attach_pdf",
    "steps",
}


class TenantSettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    tenant_id: str
    preset: str
    features: dict
    onboarding_completed: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class TenantSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preset: Optional[str] = None
    features: Optional[dict] = None
    onboarding_completed: Optional[bool] = None

    @field_validator("preset")
    def valid_preset(cls, v):
        if v is None:
            return v
        if v not in TENANT_PRESETS:
            raise ValueError(f"preset doit être dans {TENANT_PRESETS}")
        return v

    @field_validator("features")
    def valid_features(cls, v):
        if v is None:
            return v
        if not isinstance(v, dict):
            raise ValueError("features doit être un objet")
        unknown = set(v.keys()) - TENANT_FEATURE_KEYS
        if unknown:
            raise ValueError(f"features contient des clés non supportées: {sorted(unknown)}")

        for key, value in v.items():
            if key == "portal":
                if not isinstance(value, dict):
                    raise ValueError("features.portal doit être un objet")
                unknown_portal = set(value.keys()) - PORTAL_FEATURE_KEYS
                if unknown_portal:
                    raise ValueError(f"features.portal contient des clés non supportées: {sorted(unknown_portal)}")

                theme = value.get("theme")
                if theme is not None:
                    theme_norm = str(theme).strip().lower()
                    if theme_norm not in PORTAL_THEME_KEYS:
                        raise ValueError(f"features.portal.theme invalide (attendu: {sorted(PORTAL_THEME_KEYS)})")

                mode = value.get("quote_convert_mode")
                if mode is not None:
                    mode_norm = str(mode).strip().lower()
                    if mode_norm not in PORTAL_QUOTE_CONVERT_MODES:
                        raise ValueError(
                            f"features.portal.quote_convert_mode invalide (attendu: {sorted(PORTAL_QUOTE_CONVERT_MODES)})"
                        )

                for bkey in ("card_payments", "show_credit_notes", "show_all_documents", "confirm_show_all_documents"):
                    if bkey in value and not isinstance(value.get(bkey), bool):
                        raise ValueError(f"features.portal.{bkey} doit être un booléen")

                for skey in ("support_email", "footer_note"):
                    if skey in value and value.get(skey) is not None and not isinstance(value.get(skey), str):
                        raise ValueError(f"features.portal.{skey} doit être une chaîne ou null")

                continue

            if key == "branding":
                if not isinstance(value, dict):
                    raise ValueError("features.branding doit être un objet")
                unknown_branding = set(value.keys()) - BRANDING_FEATURE_KEYS
                if unknown_branding:
                    raise ValueError(f"features.branding contient des clés non supportées: {sorted(unknown_branding)}")

                template = value.get("pdf_template")
                if template is not None:
                    template_norm = str(template).strip().lower()
                    if template_norm not in BRANDING_PDF_TEMPLATE_KEYS:
                        raise ValueError(
                            f"features.branding.pdf_template invalide (attendu: {sorted(BRANDING_PDF_TEMPLATE_KEYS)})"
                        )

                accent = value.get("email_accent")
                if accent is not None:
                    if not isinstance(accent, str):
                        raise ValueError("features.branding.email_accent doit être une chaîne ou null")
                    accent_norm = accent.strip()
                    if accent_norm and not _is_hex_color(accent_norm):
                        raise ValueError("features.branding.email_accent doit être une couleur hex (#RRGGBB)")

                for skey in ("email_signature", "email_footer_note"):
                    if skey in value and value.get(skey) is not None and not isinstance(value.get(skey), str):
                        raise ValueError(f"features.branding.{skey} doit être une chaîne ou null")

                continue

            if key == "document_legal_templates":
                if not isinstance(value, dict):
                    raise ValueError("features.document_legal_templates doit être un objet")
                unknown_template_kinds = set(value.keys()) - DOCUMENT_LEGAL_TEMPLATE_KINDS
                if unknown_template_kinds:
                    raise ValueError(
                        "features.document_legal_templates contient des clés non supportées: "
                        f"{sorted(unknown_template_kinds)}"
                    )

                for template_kind, template_value in value.items():
                    if template_value is None:
                        continue
                    if not isinstance(template_value, dict):
                        raise ValueError(
                            f"features.document_legal_templates.{template_kind} doit être un objet ou null"
                        )
                    unknown_template_keys = set(template_value.keys()) - DOCUMENT_LEGAL_TEMPLATE_KEYS
                    if unknown_template_keys:
                        raise ValueError(
                            f"features.document_legal_templates.{template_kind} contient des clés non supportées: "
                            f"{sorted(unknown_template_keys)}"
                        )
                    for bkey in DOCUMENT_LEGAL_TEMPLATE_BOOL_KEYS:
                        if bkey in template_value and not isinstance(template_value.get(bkey), bool):
                            raise ValueError(
                                f"features.document_legal_templates.{template_kind}.{bkey} doit être un booléen"
                            )
                    for skey in DOCUMENT_LEGAL_TEMPLATE_STRING_KEYS:
                        if skey not in template_value or template_value.get(skey) is None:
                            continue
                        if not isinstance(template_value.get(skey), str):
                            raise ValueError(
                                f"features.document_legal_templates.{template_kind}.{skey} doit être une chaîne ou null"
                            )
                        if len(template_value.get(skey) or "") > 5000:
                            raise ValueError(f"features.document_legal_templates.{template_kind}.{skey} est trop long")

                continue

            if key == "billing_request":
                if not isinstance(value, dict):
                    raise ValueError("features.billing_request doit être un objet")
                unknown_billing = set(value.keys()) - BILLING_REQUEST_FEATURE_KEYS
                if unknown_billing:
                    raise ValueError(f"features.billing_request contient des clés non supportées: {sorted(unknown_billing)}")

                for pkey in ("requested_plan", "active_plan"):
                    plan = value.get(pkey)
                    if plan is not None and str(plan).strip().lower() not in {"starter", "pro"}:
                        raise ValueError(f"features.billing_request.{pkey} invalide")
                period = value.get("requested_period")
                if period is not None and str(period).strip().lower() not in {"monthly", "yearly"}:
                    raise ValueError("features.billing_request.requested_period invalide")
                for bkey in ("checkout_requested", "requires_checkout"):
                    if bkey in value and not isinstance(value.get(bkey), bool):
                        raise ValueError(f"features.billing_request.{bkey} doit être un booléen")

                continue

            if key == "dunning":
                if not isinstance(value, dict):
                    raise ValueError("features.dunning doit être un objet")
                unknown_dunning = set(value.keys()) - DUNNING_FEATURE_KEYS
                if unknown_dunning:
                    raise ValueError(f"features.dunning contient des clés non supportées: {sorted(unknown_dunning)}")

                for bkey in ("enabled", "attach_pdf"):
                    if bkey in value and not isinstance(value.get(bkey), bool):
                        raise ValueError(f"features.dunning.{bkey} doit être un booléen")

                if "min_interval_hours" in value and value.get("min_interval_hours") is not None:
                    try:
                        interval = int(value.get("min_interval_hours"))
                    except Exception:
                        raise ValueError("features.dunning.min_interval_hours doit être un entier")
                    if interval < 1 or interval > 24 * 30:
                        raise ValueError("features.dunning.min_interval_hours doit être entre 1 et 720")

                if "schedule_days" in value and value.get("schedule_days") is not None:
                    sched = value.get("schedule_days")
                    if not isinstance(sched, list):
                        raise ValueError("features.dunning.schedule_days doit être une liste")
                    for item in sched:
                        try:
                            int(item)
                        except Exception:
                            raise ValueError("features.dunning.schedule_days doit contenir des entiers")

                if "steps" in value and value.get("steps") is not None:
                    steps = value.get("steps")
                    if not isinstance(steps, dict):
                        raise ValueError("features.dunning.steps doit être un objet")
                    for step_key, step_value in steps.items():
                        try:
                            int(str(step_key))
                        except Exception:
                            raise ValueError("features.dunning.steps doit être indexé par des offsets entiers")
                        if not isinstance(step_value, dict):
                            raise ValueError(f"features.dunning.steps[{step_key}] doit être un objet")
                        for subkey in ("subject", "body"):
                            if (
                                subkey in step_value
                                and step_value.get(subkey) is not None
                                and not isinstance(step_value.get(subkey), str)
                            ):
                                raise ValueError(
                                    f"features.dunning.steps[{step_key}].{subkey} doit être une chaîne ou null"
                                )

                continue

            if not isinstance(value, bool):
                raise ValueError(f"features.{key} doit être un booléen")
        return v


class FlowTopupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quantity: int = Field(..., gt=0)
    period_start: Optional[date] = None


class FlowTopupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    tenant_id: str
    period_start: date
    quantity: int
    created_at: datetime


class ProductBase(BaseModel):
    name: str
    description: Optional[str] = None
    unit_price: float
    vat_rate: float
    unit_code: Optional[str] = "C62"
    active: Optional[bool] = True

    @field_validator("name")
    def product_name_required(cls, value):
        normalized = (value or "").strip()
        if not normalized:
            raise ValueError("La désignation de l'article est requise.")
        return normalized

    @field_validator("unit_price", mode="before")
    def valid_unit_price(cls, value):
        return _normalize_document_amount(value, label="Prix HT")

    @field_validator("unit_code", mode="before")
    def valid_unit_code(cls, value):
        return normalize_unit_code(value)


class ProductCreate(ProductBase):
    pass


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    unit_price: Optional[float] = None
    vat_rate: Optional[float] = None
    unit_code: Optional[str] = None
    active: Optional[bool] = None

    @field_validator("name")
    def product_name_required(cls, value):
        if value is None:
            return value
        normalized = value.strip()
        if not normalized:
            raise ValueError("La désignation de l'article est requise.")
        return normalized

    @field_validator("unit_price", mode="before")
    def valid_unit_price(cls, value):
        if value is None:
            return value
        return _normalize_document_amount(value, label="Prix HT")

    @field_validator("unit_code", mode="before")
    def valid_unit_code(cls, value):
        return normalize_unit_code(value)


class ProductOut(ProductBase):
    id: str
    model_config = ConfigDict(from_attributes=True)


class TenantSummary(BaseModel):
    id: str
    name: str
    plan: Optional[str] = None
    subscription_status: Optional[str] = None
    trial_end: Optional[datetime] = None
    created_at: datetime
    invoice_count: int = 0

    model_config = ConfigDict(from_attributes=True)


class AuditLogEntry(BaseModel):
    id: str
    created_at: datetime
    action: str
    entity_type: str
    entity_id: str
    actor_email: Optional[str] = None
    payload: Optional[dict] = None


class AuditLogResponse(BaseModel):
    items: List[AuditLogEntry]
    page: int
    page_size: int
    total: int
    pages: int


class PdpConnectRequest(BaseModel):
    provider_slug: str
    auth_type: str
    credentials: dict = Field(default_factory=dict)
    status: Optional[str] = None


class ChorusAdminConnectionProvisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    technical_login: str
    technical_password: SecretStr

    @field_validator("technical_login", mode="before")
    @classmethod
    def validate_technical_login(cls, value: Any) -> str:
        login = str(value or "").strip()
        if not login:
            raise ValueError("Identifiant technique Chorus requis.")
        if ":" in login:
            raise ValueError("L'identifiant technique Chorus ne peut pas contenir ':'.")
        if len(login) > 512:
            raise ValueError("Identifiant technique Chorus trop long.")
        return login

    @field_validator("technical_password")
    @classmethod
    def validate_technical_password(cls, value: SecretStr) -> SecretStr:
        password = value.get_secret_value()
        if not password:
            raise ValueError("Mot de passe technique Chorus requis.")
        if len(password) > 4096:
            raise ValueError("Mot de passe technique Chorus trop long.")
        return value


class ChorusAdminConnectionProvisionOut(BaseModel):
    tenant_id: str
    provider_slug: str
    configured: bool
    status: str
    updated_at: datetime


class ChorusAdminConnectionVerifyOut(BaseModel):
    tenant_id: str
    provider_slug: str
    verified: bool
    status: str
    structure_count: int
    updated_at: datetime


class ChorusAdminConnectionSummaryOut(BaseModel):
    tenant_id: str
    provider_slug: str
    configured: bool
    status: str
    verified_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ChorusAdminPilotActivationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recipient_siret: str

    @field_validator("recipient_siret", mode="before")
    @classmethod
    def validate_recipient_siret(cls, value: Any) -> str:
        normalized = _normalize_fr_identifier(value, lengths={14}, label="SIRET")
        if not normalized:
            raise ValueError("SIRET destinataire requis.")
        return normalized


class ChorusAdminPilotActivationOut(BaseModel):
    tenant_id: str
    provider_slug: str
    activated: bool
    status: str
    updated_at: datetime


class ChorusAdminConnectionRevokeOut(BaseModel):
    tenant_id: str
    provider_slug: str
    revoked: bool
    status: str
    updated_at: datetime


class ChorusDirectoryLookupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    siret: str
    service_code: Optional[str] = None

    @field_validator("siret", mode="before")
    @classmethod
    def validate_siret(cls, value: Any) -> str:
        normalized = _normalize_fr_identifier(value, lengths={14}, label="SIRET")
        if not normalized:
            raise ValueError("SIRET requis.")
        return normalized

    @field_validator("service_code", mode="before")
    @classmethod
    def validate_service_code(cls, value: Any) -> str | None:
        return _normalize_chorus_reference(value, max_chars=100, label="Code service Chorus")


class SeqinoOnboardRequest(BaseModel):
    force: Optional[bool] = False
    accept_mandate: bool = False


class SeqinoMandateCreate(BaseModel):
    siren: str
    name: str
    siret: Optional[str] = None
    suffix: Optional[str] = None
    routing_identifier: Optional[str] = None
    start_date: Optional[datetime] = Field(default=None)
    accept_mandate: bool = False

    @field_validator("start_date", mode="before")
    def normalize_start_date(cls, value):
        if value is None:
            return None
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.replace(tzinfo=timezone.utc)
            return value.astimezone(timezone.utc)
        if isinstance(value, date):
            return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return None
            try:
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                try:
                    parsed_date = date.fromisoformat(raw)
                except ValueError:
                    return value
                return datetime(parsed_date.year, parsed_date.month, parsed_date.day, tzinfo=timezone.utc)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        return value


class SeqinoMandateOut(BaseModel):
    id: str
    mandate_id: str
    provider_slug: str
    siren: Optional[str] = None
    siret: Optional[str] = None
    suffix: Optional[str] = None
    routing_identifier: Optional[str] = None
    name: Optional[str] = None
    start_date: Optional[date] = None
    status: Optional[str] = None
    file_attachment: Optional[Any] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class PdpConnectionOut(BaseModel):
    id: str
    provider_slug: str
    auth_type: str
    status: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class PdpSubmitRequest(BaseModel):
    provider_slug: Optional[str] = None


class PdpTransmissionOut(BaseModel):
    id: str
    provider_slug: str
    external_id: Optional[str] = None
    status: str
    delivery_state: str = "pending"
    attempt_count: int = 0
    events: Optional[List[dict[str, Any]]] = None
    message: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class PdpStatusResponse(BaseModel):
    latest: Optional[PdpTransmissionOut] = None
    history: List[PdpTransmissionOut] = Field(default_factory=list)


class EInvoicingSubmitRequest(BaseModel):
    connector: Optional[str] = None
    validate_sanity_checks: Optional[bool] = Field(
        default=None,
        validation_alias=AliasChoices("validate_sanity_checks", "validate_en16931"),
    )
    force_retry: Optional[bool] = None


class EInvoicingTransmissionOut(BaseModel):
    id: str
    channel: str
    external_id: Optional[str] = None
    status: str
    payload_hash: Optional[str] = None
    delivery_state: str = "pending"
    attempt_count: int = 0
    last_attempt_at: Optional[datetime] = None
    events: Optional[list] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class TransmissionEventOut(BaseModel):
    id: str
    correlation_id: Optional[str] = None
    provider_slug: Optional[str] = None
    external_id: Optional[str] = None
    event_type: str
    status_code_norme: str
    payload_raw: Optional[dict] = None
    occurred_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class EInvoicingTransmissionListItem(BaseModel):
    id: str
    invoice_id: str
    invoice_number: str
    invoice_issue_date: Optional[datetime] = None
    channel: str
    status: str
    delivery_state: str = "pending"
    attempt_count: int = 0
    external_id: Optional[str] = None
    updated_at: Optional[datetime] = None
    message: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class ComplianceReportArchiveItem(BaseModel):
    invoice_id: str
    invoice_number: Optional[str] = None
    invoice_issue_date: Optional[datetime] = None
    invoice_status: Optional[str] = None
    customer_name: Optional[str] = None
    report_status: Optional[str] = None
    report_generated_at: Optional[str] = None
    report_version: Optional[str] = None
    json_available: bool = False
    pdf_available: bool = False
    transmission_status: Optional[str] = None
    transmission_channel: Optional[str] = None
    transmission_updated_at: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class RecipientDirectoryEntryCreate(BaseModel):
    siren: str
    siret: Optional[str] = None
    platform_slug: str
    billing_address: str
    routing_code: Optional[str] = None
    routing_identifier: Optional[str] = None
    platform_attached: Optional[bool] = None
    billing_address_active: Optional[bool] = None
    service_code_required: Optional[bool] = None
    commitment_required: Optional[bool] = None
    service_or_commitment_required: Optional[bool] = None
    public_entity: Optional[bool] = None


class RecipientDirectoryEntryUpdate(BaseModel):
    siren: Optional[str] = None
    siret: Optional[str] = None
    platform_slug: Optional[str] = None
    billing_address: Optional[str] = None
    routing_code: Optional[str] = None
    routing_identifier: Optional[str] = None
    platform_attached: Optional[bool] = None
    billing_address_active: Optional[bool] = None
    service_code_required: Optional[bool] = None
    commitment_required: Optional[bool] = None
    service_or_commitment_required: Optional[bool] = None
    public_entity: Optional[bool] = None


class RecipientDirectoryEntryOut(BaseModel):
    id: str
    siren: str
    siret: Optional[str] = None
    platform_slug: str
    billing_address: str
    routing_code: Optional[str] = None
    routing_identifier: Optional[str] = None
    platform_attached: Optional[bool] = None
    billing_address_active: Optional[bool] = None
    service_code_required: Optional[bool] = None
    commitment_required: Optional[bool] = None
    service_or_commitment_required: Optional[bool] = None
    public_entity: Optional[bool] = None
    raw_payload: Optional[dict] = None
    source: Optional[str] = None
    last_synced_at: Optional[datetime] = None
    ttl_seconds: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class DirectorySyncRunOut(BaseModel):
    id: str
    source: str
    status: str
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    total_requested: int = 0
    total_found: int = 0
    total_created: int = 0
    total_updated: int = 0
    total_skipped: int = 0
    total_errors: int = 0
    error_message: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class EReportingEventCreate(BaseModel):
    tenant_id: str
    type: str
    amounts: Optional[dict] = None
    payment_date: Optional[date] = None
    country: Optional[str] = None
    client_country: Optional[str] = None
    client_vat_number: Optional[str] = None
    client_type: Optional[str] = None
    provider_slug: Optional[str] = None


class EReportingEventCreateRequest(BaseModel):
    type: str
    amounts: Optional[dict] = None
    payment_date: Optional[date] = None
    country: Optional[str] = None
    client_country: Optional[str] = None
    client_vat_number: Optional[str] = None
    client_type: Optional[str] = None
    provider_slug: Optional[str] = None


class EReportingEventOut(BaseModel):
    id: str
    tenant_id: str
    provider_slug: Optional[str] = None
    type: str
    status: str
    external_id: Optional[str] = None
    payload_hash: Optional[str] = None
    amounts: Optional[dict] = None
    payment_date: Optional[date] = None
    country: Optional[str] = None
    client_country: Optional[str] = None
    client_vat_number: Optional[str] = None
    client_type: Optional[str] = None
    attempts: Optional[int] = None
    last_attempt_at: Optional[datetime] = None
    next_retry_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    error_message: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class EReportingEventListResponse(BaseModel):
    items: List[EReportingEventOut]
    page: int
    page_size: int
    total: int
    pages: int


class EReportingEventSendRequest(BaseModel):
    event_ids: Optional[List[str]] = None
    provider_slug: Optional[str] = None
    limit: Optional[int] = None


class EReportingReportGenerateRequest(BaseModel):
    period_start: Optional[date] = None
    period_end: Optional[date] = None
    report_type: Optional[str] = None
    provider_slug: Optional[str] = None


class EReportingReportOut(BaseModel):
    id: str
    tenant_id: str
    provider_slug: Optional[str] = None
    report_type: str
    period_start: date
    period_end: date
    status: str
    external_id: Optional[str] = None
    idempotency_hash: Optional[str] = None
    payload_hash: Optional[str] = None
    line_count: Optional[int] = None
    attempts: Optional[int] = None
    last_attempt_at: Optional[datetime] = None
    next_retry_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    error_message: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class EReportingLineOut(BaseModel):
    id: str
    report_id: str
    source_type: str
    source_id: Optional[str] = None
    event_type: str
    status: str
    external_id: Optional[str] = None
    payload_hash: Optional[str] = None
    amounts: Optional[dict] = None
    payment_date: Optional[date] = None
    country: Optional[str] = None
    client_country: Optional[str] = None
    client_vat_number: Optional[str] = None
    client_type: Optional[str] = None
    error_message: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class EReportingReportListResponse(BaseModel):
    items: List[EReportingReportOut]
    page: int
    page_size: int
    total: int
    pages: int


class EReportingReportDetailResponse(BaseModel):
    report: EReportingReportOut
    lines: List[EReportingLineOut]


class InboundInvoiceAttachmentOut(BaseModel):
    id: str
    kind: str
    sha256: str
    size_bytes: int = 0
    created_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class InboundInvoiceEventOut(BaseModel):
    id: str
    type: str
    payload_hash: Optional[str] = None
    created_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class InboundInvoiceListItem(BaseModel):
    id: str
    provider_slug: Optional[str] = None
    supplier_name: Optional[str] = None
    supplier_siren: Optional[str] = None
    supplier_siret: Optional[str] = None
    invoice_number: Optional[str] = None
    issue_date: Optional[date] = None
    total_ex_vat: Optional[float] = None
    total_vat: Optional[float] = None
    total_ttc: Optional[float] = None
    purchase_paid_total: Optional[float] = None
    purchase_remaining_ttc: Optional[float] = None
    currency: Optional[str] = None
    received_at: Optional[datetime] = None
    format: Optional[str] = None
    status: str
    facturx_profile: Optional[str] = None
    validation_status: Optional[str] = None
    purchase_nature: Optional[str] = None
    accounting_account: Optional[str] = None
    accountant_note: Optional[str] = None
    planned_payment_date: Optional[date] = None
    paid_by_employee: bool = False
    employee_payer_name: Optional[str] = None
    employee_payer_role: Optional[str] = None
    employee_reimbursement_amount: Optional[float] = None
    employee_reimbursement_due_date: Optional[date] = None
    employee_reimbursement_method: Optional[str] = None
    employee_reimbursement_status: Optional[str] = None
    purchase_tags: Optional[list] = None
    purchase_lines: Optional[list] = None
    completion_status: Optional[str] = None
    completion_validated_at: Optional[datetime] = None
    duplicate_of_id: Optional[str] = None
    accounting_readiness: Optional[dict[str, Any]] = None
    purchase_workflow: Optional[dict[str, Any]] = None
    model_config = ConfigDict(from_attributes=True)


class InboundInvoiceOut(BaseModel):
    id: str
    provider_slug: Optional[str] = None
    supplier_name: Optional[str] = None
    supplier_siren: Optional[str] = None
    supplier_siret: Optional[str] = None
    invoice_number: Optional[str] = None
    issue_date: Optional[date] = None
    total_ex_vat: Optional[float] = None
    total_vat: Optional[float] = None
    total_ttc: Optional[float] = None
    purchase_paid_total: Optional[float] = None
    purchase_remaining_ttc: Optional[float] = None
    currency: Optional[str] = None
    received_at: Optional[datetime] = None
    format: Optional[str] = None
    external_message_id: Optional[str] = None
    status: str
    facturx_profile: Optional[str] = None
    validation_status: Optional[str] = None
    validation_errors: Optional[list] = None
    validation_warnings: Optional[list] = None
    validated_at: Optional[datetime] = None
    purchase_nature: Optional[str] = None
    accounting_account: Optional[str] = None
    accountant_note: Optional[str] = None
    planned_payment_date: Optional[date] = None
    paid_by_employee: bool = False
    employee_payer_name: Optional[str] = None
    employee_payer_role: Optional[str] = None
    employee_reimbursement_amount: Optional[float] = None
    employee_reimbursement_due_date: Optional[date] = None
    employee_reimbursement_method: Optional[str] = None
    employee_reimbursement_status: Optional[str] = None
    purchase_tags: Optional[list] = None
    purchase_lines: Optional[list] = None
    completion_status: Optional[str] = None
    completion_validated_at: Optional[datetime] = None
    duplicate_of_id: Optional[str] = None
    attachments: List[InboundInvoiceAttachmentOut] = Field(default_factory=list)
    events: List[InboundInvoiceEventOut] = Field(default_factory=list)
    accounting_readiness: Optional[dict[str, Any]] = None
    purchase_workflow: Optional[dict[str, Any]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class InboundInvoiceListResponse(BaseModel):
    items: List[InboundInvoiceListItem]
    page: int
    page_size: int
    total: int
    pages: int


class InboundInvoiceStatusRequest(BaseModel):
    action: str


# --- Quotes (Devis) ---


class QuoteLineIn(BaseModel):
    product_name: str
    line_type: str = "item"
    display_number: Optional[str] = None
    reference: Optional[str] = None
    detail: Optional[str] = None
    quantity: float = 1.0
    unit_price: float
    vat_rate: float = 20.0
    vat_category: str = "S"
    exemption_reason_code: Optional[str] = None
    unit_code: str = "C62"
    item_id: Optional[str] = None
    accounting_account: Optional[str] = None

    @field_validator("vat_category")
    def valid_cat(cls, v: str) -> str:
        allowed = {"S", "Z", "AE", "O", "E"}
        if v not in allowed:
            raise ValueError(f"vat_category invalide: {v} (valeurs: {sorted(allowed)})")
        return v

    @field_validator("quantity", mode="before")
    def valid_quantity(cls, v):
        return _normalize_line_quantity(v)

    @field_validator("unit_price", mode="before")
    def valid_unit_price(cls, v):
        return _normalize_document_amount(v, label="Prix HT")

    @field_validator("vat_rate", mode="before")
    def valid_vat_rate(cls, v):
        return _normalize_vat_rate(v)

    @field_validator("unit_code", mode="before")
    def valid_unit_code(cls, v):
        return normalize_unit_code(v)

    @field_validator("line_type")
    def valid_line_type(cls, v: str) -> str:
        if v not in {"item", "title", "comment"}:
            raise ValueError("line_type invalide: valeurs autorisées item, title, comment")
        return v

    @field_validator("display_number", mode="before")
    def clean_display_number(cls, v):
        value = str(v or "").strip()
        return value[:24] or None

    @field_validator("accounting_account", mode="before")
    def valid_accounting_account(cls, v):
        if v is None:
            return None
        normalized = str(v).strip().replace(" ", "")
        if not normalized:
            return None
        if not re.fullmatch(r"[A-Z0-9._-]{3,20}", normalized):
            raise ValueError("Catégorie compta invalide.")
        return normalized


class QuoteCreate(BaseModel):
    customer_id: str
    currency: str = "EUR"
    note: Optional[str] = None
    template_key: Optional[str] = None
    template_options: Optional[dict] = None
    payment_terms: Optional[str] = None
    purchase_order_number: Optional[str] = None
    service_date: Optional[date] = None
    valid_until: Optional[date] = None
    lines: List[QuoteLineIn]

    @field_validator("template_key")
    def valid_template_key(cls, v):
        return _normalize_invoice_template_key(v)

    @field_validator("template_options")
    def valid_template_options(cls, v):
        return _normalize_template_options(v)


class QuoteUpdate(BaseModel):
    customer_id: Optional[str] = None
    currency: Optional[str] = None
    note: Optional[str] = None
    template_key: Optional[str] = None
    template_options: Optional[dict] = None
    payment_terms: Optional[str] = None
    purchase_order_number: Optional[str] = None
    service_date: Optional[date] = None
    valid_until: Optional[date] = None
    lines: Optional[List[QuoteLineIn]] = None

    @field_validator("template_key")
    def valid_update_template_key(cls, v):
        return _normalize_invoice_template_key(v)

    @field_validator("template_options")
    def valid_update_template_options(cls, v):
        return _normalize_template_options(v)


class QuoteLineOut(BaseModel):
    id: str
    line_type: str = "item"
    display_number: Optional[str] = None
    reference: Optional[str] = None
    product_name: str
    detail: Optional[str] = None
    quantity: float
    unit_price: float
    vat_rate: float
    vat_category: str = "S"
    exemption_reason_code: Optional[str] = None
    unit_code: str = "C62"
    item_id: Optional[str] = None
    accounting_account: Optional[str] = None
    line_total: float

    model_config = ConfigDict(from_attributes=True)

    @field_validator("unit_code", mode="before")
    def valid_unit_code(cls, v):
        return normalize_unit_code(v)


class QuoteOut(BaseModel):
    id: str
    customer_id: str
    number: Optional[str] = None
    currency: str
    status: str
    issue_date: datetime
    updated_at: Optional[datetime] = None
    valid_until: Optional[date] = None
    service_date: Optional[date] = None
    template_key: Optional[str] = None
    template_options: Optional[dict] = None
    payment_terms: Optional[str] = None
    purchase_order_number: Optional[str] = None
    sent_at: Optional[datetime] = None
    accepted_at: Optional[datetime] = None
    accepted_name: Optional[str] = None
    accepted_email: Optional[str] = None
    rejected_at: Optional[datetime] = None
    rejected_reason: Optional[str] = None
    public_enabled: Optional[bool] = None
    public_view_count: Optional[int] = None
    public_first_viewed_at: Optional[datetime] = None
    public_last_viewed_at: Optional[datetime] = None
    seal_hash: Optional[str] = None
    seal_created_at: Optional[datetime] = None
    accepted_terms_url: Optional[str] = None
    accepted_terms_at: Optional[datetime] = None
    reminder_count: Optional[int] = None
    last_reminder_at: Optional[datetime] = None
    total_ex_vat: float
    total_vat: float
    total_inc_vat: float
    note: Optional[str] = None
    invoice_id: Optional[str] = None
    duplicate_of_id: Optional[str] = None
    duplicate_of_number: Optional[str] = None
    latest_duplicate_id: Optional[str] = None
    latest_duplicate_number: Optional[str] = None
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    lines: Optional[List[QuoteLineOut]] = None
    accounting_readiness: Optional[dict[str, Any]] = None

    model_config = ConfigDict(from_attributes=True)


class QuoteShareOut(BaseModel):
    enabled: bool = False
    public_url: Optional[str] = None
    expires_at: Optional[datetime] = None
    expires_in_days: Optional[int] = None
    validity_days: Optional[int] = None
    expired: bool = False


class InvoiceShareOut(BaseModel):
    enabled: bool = False
    public_url: Optional[str] = None
    expires_at: Optional[datetime] = None
    expires_in_days: Optional[int] = None
    validity_days: Optional[int] = None
    expired: bool = False
    message: Optional[str] = None


class QuoteEmailRequest(BaseModel):
    # Destinataire explicite (optionnel). Si vide: on enverra aux contacts "facturation" du client
    # (ou fallback sur customer.email si aucun contact dédié).
    to: Optional[str] = None
    cc: Optional[str] = None
    bcc: Optional[str] = None
    reply_to: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    include_pdf: bool = True
    include_link: bool = True
    save_as_default: bool = False
    save_subject_template: Optional[str] = None
    save_body_template: Optional[str] = None


class InvoiceFollowupRequest(BaseModel):
    to: Optional[str] = None
    reply_to: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    include_pdf: bool = False
    include_link: bool = True
    save_as_default: bool = False
    save_subject_template: Optional[str] = None
    save_body_template: Optional[str] = None


class QuoteFollowupRequest(BaseModel):
    to: Optional[str] = None
    cc: Optional[str] = None
    bcc: Optional[str] = None
    reply_to: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    include_pdf: bool = False
    include_link: bool = True
    save_as_default: bool = False
    save_subject_template: Optional[str] = None
    save_body_template: Optional[str] = None


class QuoteTimelineEvent(BaseModel):
    id: str
    created_at: datetime
    action: str
    actor_email: Optional[str] = None
    metadata: Optional[dict] = None


class PublicParty(BaseModel):
    name: str
    address: Optional[str] = None
    client_type: Optional[str] = None
    siren: Optional[str] = None
    siret: Optional[str] = None
    vat_number: Optional[str] = None
    vat_regime: Optional[str] = None
    vat_exemption_notice: Optional[str] = None
    naf_code: Optional[str] = None
    logo_url: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    legal_form: Optional[str] = None
    share_capital: Optional[str] = None
    rcs: Optional[str] = None
    vat_on_debits: Optional[bool] = None
    late_payment_interest: Optional[str] = None
    recovery_fee_eur: Optional[float] = None
    discount_terms: Optional[str] = None
    # Optional branding for public portals
    portal_theme: Optional[str] = None
    portal_support_email: Optional[str] = None
    portal_footer_note: Optional[str] = None


class PublicQuoteLine(BaseModel):
    line_type: str = "item"
    display_number: Optional[str] = None
    reference: Optional[str] = None
    product_name: str
    detail: Optional[str] = None
    quantity: float
    unit_price: float
    vat_rate: float
    vat_category: Optional[str] = None
    unit_code: Optional[str] = None
    exemption_reason_code: Optional[str] = None
    line_total: float

    @field_validator("unit_code", mode="before")
    def valid_unit_code(cls, v):
        return normalize_unit_code(v)


class PublicDocumentAttachmentOut(BaseModel):
    id: str
    filename: str
    label: Optional[str] = None
    content_type: str
    size_bytes: int


class PublicQuoteTotals(BaseModel):
    total_ex_vat: float
    total_vat: float
    total_inc_vat: float


class PublicQuoteRequestedAdvance(BaseModel):
    label: str = "Acompte demandé"
    reference: Optional[str] = None
    amount_ht: float = 0.0
    amount_vat: float = 0.0
    amount_ttc: float = 0.0
    vat_rate: Optional[float] = None


class PublicQuoteOut(BaseModel):
    number: Optional[str] = None
    currency: str
    status: str
    issue_date: datetime
    service_date: Optional[date] = None
    valid_until: Optional[date] = None
    payment_terms: Optional[str] = None
    delivery_address: Optional[str] = None
    delivery_address_differs: Optional[bool] = False
    operation_nature: Optional[str] = None
    purchase_order_number: Optional[str] = None
    note: Optional[str] = None
    legal_notice: Optional[str] = None
    payment_iban: Optional[str] = None
    payment_bic: Optional[str] = None
    supplier: PublicParty
    customer: PublicParty
    totals: PublicQuoteTotals
    requested_advance: Optional[PublicQuoteRequestedAdvance] = None
    lines: List[PublicQuoteLine]
    attachments: List[PublicDocumentAttachmentOut] = []
    # Portail / acceptation
    acceptance_mode: Optional[str] = None  # simple|otp
    terms_url: Optional[str] = None
    terms_required: Optional[bool] = None
    seal_hash: Optional[str] = None
    seal_created_at: Optional[datetime] = None
    accepted_at: Optional[datetime] = None
    accepted_name: Optional[str] = None
    accepted_email: Optional[str] = None
    accepted_terms_url: Optional[str] = None
    accepted_terms_at: Optional[datetime] = None
    rejected_at: Optional[datetime] = None
    rejected_reason: Optional[str] = None


class PublicInvoiceLine(BaseModel):
    line_type: str = "item"
    display_number: Optional[str] = None
    reference: Optional[str] = None
    product_name: str
    detail: Optional[str] = None
    quantity: float
    unit_price: float
    vat_rate: float
    vat_category: Optional[str] = None
    unit_code: Optional[str] = None
    exemption_reason_code: Optional[str] = None
    line_total: float

    @field_validator("unit_code", mode="before")
    def valid_unit_code(cls, v):
        return normalize_unit_code(v)


class PublicInvoiceTotals(BaseModel):
    total_ex_vat: float
    total_vat: float
    total_inc_vat: float
    balance_due: float
    allowance: float = 0.0
    prepaid: float = 0.0


class PublicInvoicePaymentInfo(BaseModel):
    iban: Optional[str] = None
    bic: Optional[str] = None
    payment_reference: Optional[str] = None


class PublicPaymentSummary(BaseModel):
    date: datetime
    method: Optional[str] = None
    amount: float
    provider: Optional[str] = None
    receipt_url: Optional[str] = None
    card_brand: Optional[str] = None
    card_last4: Optional[str] = None


class PublicInvoiceOut(BaseModel):
    number: Optional[str] = None
    type: Optional[str] = None  # invoice|credit_note
    currency: str
    status: str
    issue_date: datetime
    service_date: Optional[date] = None
    due_date: Optional[datetime] = None
    payment_terms: Optional[str] = None
    delivery_address: Optional[str] = None
    delivery_address_differs: Optional[bool] = False
    operation_nature: Optional[str] = None
    purchase_order_number: Optional[str] = None
    note: Optional[str] = None
    legal_notice: Optional[str] = None
    supplier: PublicParty
    customer: PublicParty
    totals: PublicInvoiceTotals
    lines: List[PublicInvoiceLine]
    attachments: List[PublicDocumentAttachmentOut] = []
    payment: Optional[PublicInvoicePaymentInfo] = None
    payments: List[PublicPaymentSummary] = []
    payment_tracking_enabled: bool = False
    has_facturx: bool = False
    card_payment_enabled: bool = False
    public_expires_at: Optional[datetime] = None
    public_expires_in_days: Optional[int] = None


class PublicCustomerPortalDoc(BaseModel):
    kind: str  # invoice|credit_note|quote
    id: str
    number: Optional[str] = None
    currency: str
    status: str
    issue_date: datetime
    due_date: Optional[datetime] = None
    valid_until: Optional[date] = None
    total_inc_vat: float
    balance_due: Optional[float] = None
    portal_path: Optional[str] = None
    pdf_path: Optional[str] = None
    facturx_path: Optional[str] = None
    can_pay_by_card: bool = False
    last_payment: Optional[PublicPaymentSummary] = None


class PublicCustomerPortalOut(BaseModel):
    supplier: PublicParty
    customer: PublicParty
    documents: List[PublicCustomerPortalDoc]
    payment_tracking_enabled: bool = False


class PublicCustomerTimelineEvent(BaseModel):
    """Timeline event displayed in the customer unified portal (/c/{token}).

    IMPORTANT: do not include PII (emails, IPs, raw user-agents). Keep it high-level.
    """

    kind: str  # issued|sent|due|payment|refund|email|followup|accept|reject|convert
    label: str
    at: datetime
    amount: Optional[float] = None
    method: Optional[str] = None
    status: Optional[str] = None


class PublicCustomerInvoiceDetailOut(PublicInvoiceOut):
    """Invoice/credit note detail for the unified customer portal."""

    id: str
    payment_tracking_enabled: bool = False
    reminder_count: int = 0
    last_reminder_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    issued_at: Optional[datetime] = None
    paid_at: Optional[datetime] = None
    pdf_path: Optional[str] = None
    facturx_path: Optional[str] = None
    attachments: List[PublicDocumentAttachmentOut] = []
    events: List[PublicCustomerTimelineEvent] = []


class PublicCustomerQuoteDetailOut(PublicQuoteOut):
    """Quote detail for the unified customer portal."""

    id: str
    invoice_id: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_status: Optional[str] = None
    reminder_count: int = 0
    last_reminder_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    pdf_path: Optional[str] = None
    attachments: List[PublicDocumentAttachmentOut] = []
    can_convert: bool = False
    quote_convert_mode: Optional[str] = None
    events: List[PublicCustomerTimelineEvent] = []


class PublicQuoteOtpRequest(BaseModel):
    email: str


class PublicQuoteAcceptRequest(BaseModel):
    name: str
    email: Optional[str] = None
    otp_code: Optional[str] = None
    terms_accepted: Optional[bool] = None


class PublicQuoteRejectRequest(BaseModel):
    name: str
    email: Optional[str] = None
    reason: Optional[str] = None
