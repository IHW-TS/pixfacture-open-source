from __future__ import annotations

import re
from typing import Any

from .public_provider_messages import sanitize_public_provider_message


_NOT_FOUND_MESSAGES = {
    "not found",
    "resource not found",
    "ressource non trouvée",
    "ressource non trouvee",
}
_TECHNICAL_FIELD_NAME = re.compile(
    r"\b(?:tenant_id|provider_slug|invoice_id|customer_id|quote_id|external_id|"
    r"request_id|trace_id|job_id|artifact_kind|artifact|backfill|dummy|mock|provider|tenant|connector|pdp|"
    r"secret|password|passwd|"
    r"access[_ -]?token|api[_ -]?key|bearer[_ -]?token)\b|\bartefacts?\s+EDI\b",
    re.IGNORECASE,
)
_PYTHON_REPR = re.compile(
    r"(?:<[^>]+ object at 0x[0-9a-f]+>|\b(?:KeyError|TypeError|AttributeError|RuntimeError|"
    r"ValueError|AssertionError)\s*[:(]|\b(?:invalid literal for|not enough values to unpack|"
    r"has no attribute|is not json serializable|unexpected keyword argument|"
    r"missing required positional argument|duplicate key value|unique constraint|foreign key constraint|"
    r"xmlschema|xpath|lxml)\b|\{https?://|\bline\s+\d+\s*,?\s*column\s+\d+\b)",
    re.IGNORECASE,
)
_HTML_MARKUP = re.compile(r"<\s*/?\s*[a-z][^>]*>", re.IGNORECASE)
_BIDI_CONTROLS = re.compile(r"[\u202a-\u202e\u2066-\u2069]")

_STATUS_FALLBACKS = {
    400: "Requête invalide.",
    401: "Authentification requise.",
    402: "Cette opération nécessite un abonnement ou des jetons disponibles.",
    403: "Vous n’êtes pas autorisé à effectuer cette action.",
    404: "Ressource introuvable.",
    405: "Cette action n’est pas disponible.",
    409: "Cette action n’est pas possible dans l’état actuel.",
    410: "Cette fonctionnalité n’est plus disponible.",
    413: "Le fichier envoyé est trop volumineux.",
    415: "Format de fichier non pris en charge.",
    422: "Les données saisies sont invalides.",
    429: "Trop de demandes. Réessayez dans quelques instants.",
}

_FIELD_LABELS = {
    "address": "Adresse",
    "address_line1": "Adresse",
    "amount": "Montant",
    "amounts": "Montants",
    "bic": "BIC",
    "city": "Ville",
    "client_country": "Pays du client",
    "client_type": "Type de client",
    "client_vat_number": "Numéro de TVA du client",
    "company_name": "Nom de l’entreprise",
    "country": "Pays",
    "country_code": "Pays",
    "currency": "Devise",
    "customer_id": "Client",
    "description": "Description",
    "due_date": "Date d’échéance",
    "email": "Adresse e-mail",
    "event_ids": "Événements",
    "event_type": "Type d’événement",
    "first_name": "Prénom",
    "iban": "IBAN",
    "invoice_id": "Facture",
    "last_name": "Nom",
    "limit": "Limite",
    "lines": "Lignes du document",
    "name": "Nom",
    "password": "Mot de passe",
    "payment_date": "Date de paiement",
    "period_end": "Fin de période",
    "period_start": "Début de période",
    "phone": "Téléphone",
    "postal_code": "Code postal",
    "provider_slug": "Plateforme agréée",
    "quantity": "Quantité",
    "quote_id": "Devis",
    "report_type": "Type de rapport",
    "siren": "SIREN",
    "siret": "SIRET",
    "subject": "Objet",
    "to": "Destinataire",
    "unit_price": "Prix unitaire",
    "vat_number": "Numéro de TVA",
    "vat_rate": "Taux de TVA",
}


def public_error_fallback(status_code: int) -> str:
    if status_code >= 500:
        return "Service momentanément indisponible. Réessayez dans quelques instants."
    return _STATUS_FALLBACKS.get(status_code, "Une erreur est survenue. Vérifiez les informations saisies.")


def public_field_label(field: Any) -> str:
    raw = str(field or "").strip()
    if not raw:
        return "Champ"
    return _FIELD_LABELS.get(raw.lower(), "Champ")


def sanitize_public_error_message(
    value: Any,
    *,
    status_code: int = 400,
    fallback: str | None = None,
    max_chars: int = 300,
) -> str:
    """Return user-facing copy while rejecting dependency and implementation details."""

    safe_fallback = fallback or public_error_fallback(status_code)
    if value is None:
        return safe_fallback
    raw = _BIDI_CONTROLS.sub("", str(value)).strip()
    if raw.lower().rstrip(".") in _NOT_FOUND_MESSAGES:
        return "Ressource introuvable."
    if _TECHNICAL_FIELD_NAME.search(raw) or _PYTHON_REPR.search(raw) or _HTML_MARKUP.search(raw):
        return safe_fallback
    sanitized = sanitize_public_provider_message(raw, fallback=safe_fallback, max_chars=max_chars)
    if not sanitized:
        return safe_fallback
    return sanitized


def friendly_validation_message(errors: list[dict[str, Any]] | None) -> str:
    """Translate one Pydantic validation error without echoing values or internals."""

    if not errors:
        return public_error_fallback(422)
    error = errors[0] or {}
    location = error.get("loc") or []
    field = next(
        (
            part
            for part in reversed(location)
            if isinstance(part, str) and part.lower() not in {"body", "query", "path", "header", "cookie"}
        ),
        None,
    )
    label = public_field_label(field)
    error_type = str(error.get("type") or "").lower()
    raw_message = str(error.get("msg") or "").strip()
    lowered = raw_message.lower()

    if "missing" in error_type or "field required" in lowered or lowered == "required":
        return f"{label} : ce champ est obligatoire."
    if field == "email" or "email" in error_type:
        return "Adresse e-mail invalide."
    if "string_too_short" in error_type or "too short" in lowered:
        return f"{label} : la valeur saisie est trop courte."
    if "string_too_long" in error_type or "too long" in lowered:
        return f"{label} : la valeur saisie est trop longue."
    if any(marker in error_type for marker in ("date", "datetime")):
        return f"{label} : date invalide."
    if any(marker in error_type for marker in ("greater_than", "less_than", "multiple_of", "finite_number")):
        return f"{label} : valeur hors limites."
    if any(marker in error_type for marker in ("int_", "float_", "decimal_", "number_")):
        return f"{label} : nombre invalide."
    if "bool" in error_type:
        return f"{label} : valeur oui/non invalide."
    if "list" in error_type:
        return f"{label} : liste invalide."
    if "literal" in error_type or "enum" in error_type:
        return f"{label} : choix invalide."
    if error_type.startswith("value_error") or lowered.startswith("value error"):
        business_message = re.sub(r"^value error,\s*", "", raw_message, flags=re.IGNORECASE)
        return sanitize_public_error_message(
            business_message,
            status_code=422,
            fallback=f"{label} : valeur invalide.",
        )
    return f"{label} : valeur invalide."
