from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
from xml.etree import ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import (
    Customer,
    Invoice,
    PdpAccount,
    PdpConnection,
    PdpMandate,
    RecipientDirectoryEntry,
    DirectorySyncRun,
    EInvoicingTransmission,
    TransmissionEvent,
    Submission,
    Tenant,
)
from ..schemas import (
    ChorusAdminConnectionRevokeOut,
    ChorusAdminConnectionSummaryOut,
    ChorusAdminConnectionProvisionOut,
    ChorusAdminConnectionProvisionRequest,
    ChorusAdminConnectionVerifyOut,
    ChorusAdminPilotActivationOut,
    ChorusAdminPilotActivationRequest,
    PdpConnectRequest,
    PdpConnectionOut,
    SeqinoOnboardRequest,
    SeqinoMandateCreate,
    SeqinoMandateOut,
    RecipientDirectoryEntryCreate,
    RecipientDirectoryEntryUpdate,
    RecipientDirectoryEntryOut,
    EInvoicingTransmissionOut,
    EInvoicingTransmissionListItem,
    EInvoicingSubmitRequest,
    TransmissionEventOut,
)
from ..core.plans import Plan
from ..deps import (
    current_user,
    require_accountant_or_admin,
    require_product_feature,
    require_platform_admin,
    require_paid_subscription,
    require_paid_subscription_or_trial,
    require_tenant_admin,
    require_viewer_or_admin,
    AuthUser,
)
from ..validators.invoice_sanity_checks import validate_invoice_ctx
from ..services.pdp import get_provider, list_providers
from ..services.pdp.service import submit_einvoice, update_transmission_status
from ..services.directory import _upsert_entry, is_ppf_configured
from ..services.connected_mode import (
    ensure_connected_mode_operational,
    ensure_connected_mode_rollout_allowed,
)
from ..services.usage import UsageQuotaExceeded
from ..services.seqino import SeqinoClient
from ..services.seqino_onboarding import (
    create_onboarding_link,
    delete_client as delete_seqino_client,
    fetch_onboarding_status,
    get_client as get_seqino_client,
    get_or_create_client,
    normalize_onboarding_url,
    update_client as update_seqino_client,
)
from ..services import seqino_mandates
from ..services.seqino_mandates import seqino_has_active_mandate
from ..services.integration_secrets import (
    CHORUS_CPRO_ACCOUNT_KEY,
    enrich_credentials_with_secrets,
    resolve_chorus_cpro_account,
    resolve_seqino_credentials,
    upsert_integration_secret,
)
from ..services.chorus import ChorusClient, build_chorus_cpro_account, chorus_cpro_account_is_valid
from ..services.product_capabilities import normalize_plan
from ..services.facturx import FacturxValidationError
from ..services.storage import get_object_bytes
from ..services.pdp.utils import PdpProviderError
from ..services.action_logs import log_action
from ..utils.seqino_http import SeqinoHttpError, seqino_http_status
from ..utils.ssrf import validate_outbound_url
from ..utils.pdp_accounts import get_pdp_account_metadata
from ..utils.public_errors import sanitize_public_error_message
from ..utils.public_provider_messages import sanitize_public_provider_message


logger = logging.getLogger(__name__)

_SUCCESS_STATUSES = {"accepted", "available", "paid"}
_ERROR_STATUSES = {"failed", "rejected", "refused", "blocked"}
CSV_INJECTION_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_ACTIVE_MANDATE_STATUSES = {"ACTIVE"}
_SEQINO_MANDATE_SYNC_PUBLIC_ERROR = "Synchronisation des mandats indisponible."
_SEQINO_MANDATE_CONSENT_VERSION = "seqino-mandate-2026-07-v1"
_SEQINO_MANDATE_CONSENT_TEXT = (
    "J'autorise PixFacture à créer et administrer auprès de Seqino le mandat "
    "de facturation électronique décrit à l'écran pour mon entreprise."
)
_CHORUS_QUALIFIED_DIRECTORY_SOURCES = frozenset({"choruspro"})
_CHORUS_QUALIFICATION_DEFAULT_TTL_SECONDS = 24 * 60 * 60
_CHORUS_QUALIFICATION_MAX_TTL_SECONDS = 24 * 60 * 60


class SeqinoDefaultMandateRequest(BaseModel):
    accept_mandate: bool = False


def _record_seqino_mandate_consent(
    db: Session,
    *,
    user: AuthUser,
    request: Request,
    object_id: str,
    scope: str,
) -> None:
    user_agent = str(request.headers.get("user-agent") or "").strip()[:500] or None
    source_ip = request.client.host if request.client else None
    log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="seqino_mandate_consent_accepted",
        object_type="pdp_mandate_consent",
        object_id=object_id,
        metadata={
            "accepted": True,
            "consent_version": _SEQINO_MANDATE_CONSENT_VERSION,
            "consent_text": _SEQINO_MANDATE_CONSENT_TEXT,
            "consent_text_sha256": hashlib.sha256(_SEQINO_MANDATE_CONSENT_TEXT.encode("utf-8")).hexdigest(),
            "scope": scope,
            "accepted_at": datetime.now(timezone.utc).isoformat(),
            "source_ip": source_ip,
            "user_agent": user_agent,
        },
        commit=True,
    )


class EInvoicingReconcileRequest(BaseModel):
    external_id: str


PUBLIC_CLIENT_TYPES = {"public", "public_sector", "government", "state", "b2g"}


def _sanitize_csv_cell(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    if not text:
        return ""
    if text[0] in CSV_INJECTION_PREFIXES:
        return "'" + text
    return text


def _has_value(value: object | None) -> bool:
    if value is None:
        return False
    return bool(str(value).strip())


def _seqino_demo_mode() -> bool:
    return bool(getattr(settings, "SEQINO_DEMO_MODE", False))


def _seqino_onboarding_link_is_current(value: str | None) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    try:
        expires_at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > datetime.now(timezone.utc)


def _seqino_configured(db: Session | None = None, tenant_id: str | None = None) -> bool:
    if _seqino_demo_mode():
        return True
    if db and tenant_id:
        access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id)
    else:
        access_token = settings.SEQINO_ACCESS_TOKEN or settings.SEQINO_API_KEY
        sponsor_id = settings.SEQINO_SPONSOR_ID
    return bool(_has_value(settings.SEQINO_BASE_URL) and _has_value(sponsor_id) and _has_value(access_token))


def _seqino_missing_config() -> list[str]:
    missing: list[str] = []
    if _seqino_demo_mode():
        return missing
    if not _has_value(settings.SEQINO_BASE_URL):
        missing.append("SEQINO_BASE_URL")
    if not (_has_value(settings.SEQINO_ACCESS_TOKEN) or _has_value(settings.SEQINO_API_KEY)):
        missing.append("SEQINO_ACCESS_TOKEN")
        missing.append("SEQINO_API_KEY")
    if not _has_value(settings.SEQINO_SPONSOR_ID):
        missing.append("SEQINO_SPONSOR_ID")
    return missing


def _chorus_configured(db: Session | None = None, tenant_id: str | None = None) -> bool:
    return not _chorus_missing_config(db, tenant_id)


def _chorus_server_bootstrap_ready() -> bool:
    """Check server-owned Chorus prerequisites without resolving a provider.

    The tenant technical account is intentionally excluded: creating the
    connection is the operation that stores it.
    """

    try:
        extra = json.loads(settings.CHORUS_SUBMIT_EXTRA_JSON or "{}")
    except Exception:
        return False
    syntax = extra.get("syntaxeFlux") or extra.get("syntaxe_flux") if isinstance(extra, dict) else None
    return all(
        _has_value(value)
        for value in (
            settings.PISTE_CLIENT_ID,
            settings.PISTE_CLIENT_SECRET,
            settings.PISTE_TOKEN_URL,
            settings.CHORUS_API_BASE,
            settings.CHORUS_SUBMIT_PATH,
            settings.CHORUS_STATUS_PATH,
            syntax,
        )
    )


def _chorus_missing_config(db: Session | None = None, tenant_id: str | None = None) -> list[str]:
    if db and tenant_id:
        creds = enrich_credentials_with_secrets(db, tenant_id, {"_tenant_id": tenant_id})
    else:
        creds = {}
    try:
        provider = get_provider("choruspro", creds)
    except Exception:
        return ["CHORUS_PROVIDER"]
    missing_config_fn = getattr(provider, "missing_server_config", None)
    if not callable(missing_config_fn):
        return []
    return list(missing_config_fn())


def _ppf_directory_enabled() -> bool:
    return bool(getattr(settings, "NEXT_PUBLIC_ENABLE_PPF_DIRECTORY", False))


def _tx_timestamp(tx: EInvoicingTransmission | None) -> datetime | None:
    if not tx:
        return None
    return tx.updated_at or tx.created_at


_GENERIC_TRANSMISSION_MESSAGES = {
    "",
    "accepted",
    "available",
    "blocked",
    "created",
    "delivered",
    "done",
    "error",
    "failed",
    "in_progress",
    "invalid",
    "ok",
    "paid",
    "pending",
    "processing",
    "queued",
    "rejected",
    "refused",
    "sent",
    "submitted",
    "unknown",
    "soumission enregistree",
    "soumission enregistrée",
    "statut synchronise",
    "statut synchronisé",
}
_TRANSMISSION_MESSAGE_KEYS = (
    "rejection_reason",
    "rejectionReason",
    "reject_reason",
    "rejectReason",
    "refusal_reason",
    "refusalReason",
    "reason",
    "reason_code",
    "reasonCode",
    "status_reason",
    "statusReason",
    "error_message",
    "errorMessage",
    "message",
    "detail",
    "details",
    "description",
    "label",
)
_TRANSMISSION_ERROR_KEYS = (
    "errors",
    "error",
    "validation_errors",
    "validationErrors",
    "issues",
    "violations",
    "reasons",
)


def _is_generic_transmission_message(value: str | None) -> bool:
    return (value or "").strip().lower() in _GENERIC_TRANSMISSION_MESSAGES


def _normalize_transmission_message(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        for key in _TRANSMISSION_MESSAGE_KEYS:
            candidate = _normalize_transmission_message(value.get(key))
            if candidate:
                return candidate
        code = _normalize_transmission_message(value.get("code") or value.get("status_code") or value.get("statusCode"))
        field = _normalize_transmission_message(value.get("field") or value.get("path"))
        if code and field:
            return f"{field}: {code}"
        return None
    if isinstance(value, list):
        messages = []
        for item in value:
            candidate = _normalize_transmission_message(item)
            if candidate:
                messages.append(candidate)
            if len(messages) >= 3:
                break
        return " ; ".join(messages) if messages else None
    text = sanitize_public_provider_message(value, max_chars=500)
    if not text or _is_generic_transmission_message(text):
        return None
    return text


def _extract_transmission_message_from_payload(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return _normalize_transmission_message(payload)
    for key in _TRANSMISSION_ERROR_KEYS:
        candidate = _normalize_transmission_message(payload.get(key))
        if candidate:
            return candidate
    for key in _TRANSMISSION_MESSAGE_KEYS:
        candidate = _normalize_transmission_message(payload.get(key))
        if candidate:
            return candidate
    nested_payload = payload.get("payload")
    if isinstance(nested_payload, dict):
        candidate = _extract_transmission_message_from_payload(nested_payload)
        if candidate:
            return candidate
    return None


def _transmission_fallback_message(tx: EInvoicingTransmission) -> str | None:
    status_group = _transmission_status_group(tx.status)
    if status_group in {"rejected", "failed"}:
        return "Motif non fourni par la plateforme."
    return None


def _last_raw_transmission_message(tx: EInvoicingTransmission) -> str | None:
    events = tx.events if isinstance(tx.events, list) else None
    if events:
        for event in reversed(events):
            if not isinstance(event, dict):
                continue
            raw = event.get("message") or event.get("status")
            public_message = sanitize_public_provider_message(raw, max_chars=500)
            if public_message:
                return public_message
    for event in reversed(getattr(tx, "lifecycle_events", []) or []):
        payload = event.payload_raw if isinstance(event.payload_raw, dict) else {}
        raw = payload.get("message") if isinstance(payload, dict) else None
        public_message = sanitize_public_provider_message(raw, max_chars=500)
        if public_message:
            return public_message
    return None


def _transmission_message(tx: EInvoicingTransmission | None) -> str | None:
    if not tx:
        return None
    events = tx.events if isinstance(tx.events, list) else None
    if events:
        for event in reversed(events):
            if not isinstance(event, dict):
                continue
            candidate = _extract_transmission_message_from_payload(event)
            if candidate:
                return candidate
    for event in reversed(getattr(tx, "lifecycle_events", []) or []):
        payload = event.payload_raw if isinstance(event.payload_raw, dict) else None
        candidate = _extract_transmission_message_from_payload(payload)
        if candidate:
            return candidate
    return _transmission_fallback_message(tx) or _last_raw_transmission_message(tx)


def _transmission_status_group(status: str | None) -> str:
    normalized = (status or "").strip().lower()
    if normalized in {"accepted", "available", "paid", "done", "ok", "delivered"}:
        return "success"
    if normalized in {"submitted", "sent", "queued", "created"}:
        return "submitted"
    if normalized in {"processing", "pending", "in_progress"}:
        return "processing"
    if normalized in {"failed", "error", "blocked"}:
        return "failed"
    if normalized in {"rejected", "refused", "invalid"}:
        return "rejected"
    return normalized or "unknown"


def _transmission_channel_label(channel: str | None) -> str:
    normalized = (channel or "").strip().lower()
    return {
        "seqino": "Plateforme partenaire",
        "chorus": "Canal public",
        "choruspro": "Canal public",
        "manual_import": "Import manuel",
        "http_generic": "HTTP générique",
        "generic_http": "HTTP générique",
        "dummy": "Dummy",
        "mock": "Mock",
    }.get(normalized, normalized or "inconnu")


def _transmission_overview_rows(db: Session, tenant_id: str, *, limit: int = 100):
    return (
        db.query(EInvoicingTransmission, Invoice)
        .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
        .filter(Invoice.tenant_id == tenant_id)
        .order_by(EInvoicingTransmission.updated_at.desc(), EInvoicingTransmission.created_at.desc())
        .limit(limit)
        .all()
    )


def _ctx(db, inv):
    from .invoices import _ctx as make

    return make(db, inv)


def _normalize_connector(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    return "choruspro" if normalized in {"chorus", "chorus_pro"} else normalized


def _connector_matches(requested: str | None, actual: str | None) -> bool:
    requested_norm = _normalize_connector(requested)
    actual_norm = _normalize_connector(actual)
    if not requested_norm:
        return True
    if requested_norm == actual_norm:
        return True
    chorus_aliases = {"chorus", "choruspro"}
    return requested_norm in chorus_aliases and actual_norm in chorus_aliases


def _get_transmission_for_external_id(
    db: Session,
    tenant_id: str,
    external_id: str,
    *,
    requested_connector: str | None = None,
) -> EInvoicingTransmission:
    tx = (
        db.query(EInvoicingTransmission)
        .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
        .filter(EInvoicingTransmission.external_id == external_id, Invoice.tenant_id == tenant_id)
        .order_by(EInvoicingTransmission.created_at.desc())
        .first()
    )
    if not tx:
        raise _error(404, "transmission_missing", "Transmission introuvable")
    if not _connector_matches(requested_connector, tx.channel):
        raise _error(
            409,
            "connector_mismatch",
            "Le connecteur demandé ne correspond pas à la transmission.",
        )
    return tx


def _normalize_client_type(customer: Customer | None) -> str:
    return (getattr(customer, "client_type", None) or "business").strip().lower()


def _is_public_customer(customer: Customer | None) -> bool:
    return _normalize_client_type(customer) in PUBLIC_CLIENT_TYPES


def _is_public_invoice_recipient(invoice: Invoice, customer: Customer | None) -> bool:
    buyer_snapshot = invoice.buyer_snapshot if isinstance(invoice.buyer_snapshot, dict) else {}
    snapshot_type = str(buyer_snapshot.get("client_type") or "").strip().lower()
    return (snapshot_type or _normalize_client_type(customer)) in PUBLIC_CLIENT_TYPES


def _digits(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _latest_recipient_directory_entry(
    db: Session,
    tenant_id: str,
    customer: Customer | None,
    *,
    sources: frozenset[str] | None = None,
) -> RecipientDirectoryEntry | None:
    if not customer:
        return None
    siret = _digits(getattr(customer, "siret", None)) or None
    siren = _digits(getattr(customer, "siren", None)) or (siret[:9] if siret and len(siret) >= 9 else None)
    if not siret and not siren:
        return None
    q = db.query(RecipientDirectoryEntry).filter(RecipientDirectoryEntry.tenant_id == tenant_id)
    if siret:
        q = q.filter(RecipientDirectoryEntry.siret == siret)
    else:
        q = q.filter(RecipientDirectoryEntry.siren == siren)
    if sources:
        q = q.filter(
            func.lower(func.trim(func.coalesce(RecipientDirectoryEntry.source, ""))).in_(sources),
            RecipientDirectoryEntry.last_synced_at.is_not(None),
        )
    return q.order_by(
        RecipientDirectoryEntry.last_synced_at.desc().nullslast(),
        RecipientDirectoryEntry.updated_at.desc(),
    ).first()


def _chorus_qualification_ttl_seconds(entry: RecipientDirectoryEntry) -> int:
    try:
        requested = int(entry.ttl_seconds or _CHORUS_QUALIFICATION_DEFAULT_TTL_SECONDS)
    except (TypeError, ValueError):
        requested = _CHORUS_QUALIFICATION_DEFAULT_TTL_SECONDS
    return min(max(requested, 60), _CHORUS_QUALIFICATION_MAX_TTL_SECONDS)


def _utc_naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _trusted_chorus_directory_entry(
    db: Session,
    tenant_id: str,
    invoice: Invoice,
) -> RecipientDirectoryEntry | None:
    buyer_snapshot = invoice.buyer_snapshot if isinstance(invoice.buyer_snapshot, dict) else {}
    siret = _digits(str(buyer_snapshot.get("siret") or buyer_snapshot.get("legal_id") or ""))
    if len(siret) != 14:
        return None
    entries = (
        db.query(RecipientDirectoryEntry)
        .filter(
            RecipientDirectoryEntry.tenant_id == tenant_id,
            RecipientDirectoryEntry.siret == siret,
            func.lower(func.trim(func.coalesce(RecipientDirectoryEntry.source, ""))).in_(
                _CHORUS_QUALIFIED_DIRECTORY_SOURCES
            ),
            RecipientDirectoryEntry.last_synced_at.is_not(None),
        )
        .all()
    )
    return entries[0] if len(entries) == 1 else None


def _issued_chorus_references(
    invoice: Invoice,
) -> tuple[str | None, str | None, str | None, str | None]:
    xml_bytes = get_object_bytes(invoice.xml_key) if invoice.xml_key else None
    if not xml_bytes:
        return None, None, None, None
    try:
        root = ET.fromstring(xml_bytes)
    except Exception:
        return None, None, None, None
    buyer_reference = None
    purchase_order_reference = None
    buyer_identifier = None
    buyer_scheme = None
    for element in root.iter():
        local_name = element.tag.rsplit("}", 1)[-1]
        if local_name == "BuyerReference" and buyer_reference is None:
            buyer_reference = (element.text or "").strip() or None
        if local_name != "BuyerOrderReferencedDocument":
            if local_name == "BuyerTradeParty" and buyer_identifier is None:
                for organization in element.iter():
                    if organization.tag.rsplit("}", 1)[-1] != "SpecifiedLegalOrganization":
                        continue
                    for child in organization:
                        if child.tag.rsplit("}", 1)[-1] == "ID":
                            buyer_identifier = (child.text or "").strip() or None
                            buyer_scheme = (child.attrib.get("schemeID") or "").strip() or None
                            break
                    break
            continue
        for child in element.iter():
            if child.tag.rsplit("}", 1)[-1] == "IssuerAssignedID":
                purchase_order_reference = (child.text or "").strip() or None
                break
    return buyer_reference, purchase_order_reference, buyer_identifier, buyer_scheme


def _valid_chorus_reference(value: str, *, max_chars: int) -> bool:
    return bool(value) and len(value) <= max_chars and all(
        ord(char) >= 32
        and ord(char) != 127
        and not 0xD800 <= ord(char) <= 0xDFFF
        and ord(char) not in {0xFFFE, 0xFFFF}
        for char in value
    )


def _validate_chorus_public_requirements(
    db: Session,
    tenant_id: str,
    customer: Customer | None,
    invoice: Invoice,
) -> None:
    entry = _trusted_chorus_directory_entry(db, tenant_id, invoice)
    if entry is None:
        raise _error(
            409,
            "chorus_recipient_qualification_required",
            "La qualification Chorus du destinataire public doit être actualisée avant l’envoi.",
            fields=["recipient_directory_entry.source"],
        )

    last_synced_at = _utc_naive(entry.last_synced_at)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if last_synced_at is None or last_synced_at + timedelta(seconds=_chorus_qualification_ttl_seconds(entry)) <= now:
        raise _error(
            409,
            "chorus_recipient_qualification_required",
            "La qualification Chorus du destinataire public doit être actualisée avant l’envoi.",
            fields=["recipient_directory_entry.last_synced_at"],
        )

    address_active = entry.billing_address_active
    if address_active is False:
        raise _error(
            400,
            "chorus_billing_address_inactive",
            "Adresse de facturation Chorus inactive pour ce destinataire.",
        )
    service_code_required = entry.service_code_required
    commitment_required = entry.commitment_required
    service_or_commitment_required = entry.service_or_commitment_required
    unknown_fields = []
    snapshot_siret = _digits(str((invoice.buyer_snapshot or {}).get("siret") or ""))
    if str(entry.billing_address or "").strip() != snapshot_siret:
        unknown_fields.append("recipient_directory_entry.billing_address")
    if address_active is None:
        unknown_fields.append("recipient_directory_entry.billing_address_active")
    if service_code_required is None:
        unknown_fields.append("recipient_directory_entry.service_code_required")
    if commitment_required is None:
        unknown_fields.append("recipient_directory_entry.commitment_required")
    if service_or_commitment_required is None:
        unknown_fields.append("recipient_directory_entry.service_or_commitment_required")
    if entry.public_entity is not True:
        unknown_fields.append("recipient_directory_entry.public_entity")
    if entry.platform_attached is not True:
        unknown_fields.append("recipient_directory_entry.platform_attached")
    if unknown_fields:
        raise _error(
            409,
            "chorus_recipient_qualification_required",
            "La qualification Chorus du destinataire public doit être actualisée avant l’envoi.",
            fields=unknown_fields,
        )
    service_code = (getattr(invoice, "public_service_code", None) or "").strip()
    commitment_reference = (getattr(invoice, "purchase_order_number", None) or "").strip()
    raw_payload = entry.raw_payload if isinstance(entry.raw_payload, dict) else {}
    raw_services = raw_payload.get("services") if isinstance(raw_payload.get("services"), list) else []
    active_service_codes = [
        str(service.get("codeService") or "").strip()
        for service in raw_services
        if isinstance(service, dict) and str(service.get("codeService") or "").strip()
    ]
    if service_code:
        if not _valid_chorus_reference(service_code, max_chars=100) or active_service_codes.count(service_code) != 1:
            raise _error(
                400,
                "chorus_service_code_invalid",
                "Le code service figé dans la facture n'est pas un service Chorus actif. Corrigez puis réémettez.",
                fields=["invoice.public_service_code"],
            )
        selected_service = raw_payload.get("selected_service")
        if (
            raw_payload.get("service_rules_complete") is not True
            or not isinstance(selected_service, dict)
            or str(selected_service.get("codeService") or "").strip() != service_code
            or not isinstance(selected_service.get("commitmentRequired"), bool)
        ):
            raise _error(
                409,
                "chorus_recipient_qualification_required",
                "Le service Chorus sélectionné doit être requalifié avant transmission.",
                fields=["recipient_directory_entry.raw_payload.selected_service"],
            )
    if service_code_required and not service_code:
        raise _error(
            400,
            "chorus_service_code_required",
            "Code service Chorus requis pour ce destinataire public.",
            fields=["invoice.public_service_code"],
        )
    if commitment_required and not commitment_reference:
        raise _error(
            400,
            "chorus_commitment_required",
            "Engagement juridique requis dans la facture émise. Corrigez puis réémettez.",
            fields=["invoice.purchase_order_number"],
        )
    if service_or_commitment_required and not (service_code or commitment_reference):
        raise _error(
            400,
            "chorus_service_or_commitment_required",
            "Un code service ou un engagement juridique doit être figé dans la facture émise.",
            fields=["invoice.public_service_code", "invoice.purchase_order_number"],
        )
    if commitment_reference and not _valid_chorus_reference(commitment_reference, max_chars=10):
        raise _error(
            400,
            "chorus_commitment_invalid",
            "L'engagement juridique Chorus de la facture est invalide. Corrigez puis réémettez.",
            fields=["invoice.purchase_order_number"],
        )
    artifact_service_code, artifact_commitment, artifact_buyer_siret, artifact_buyer_scheme = (
        _issued_chorus_references(invoice)
    )
    qualified_siret = _digits(entry.siret)
    if artifact_buyer_siret != qualified_siret or artifact_buyer_scheme != "0009":
        raise _error(
            400,
            "chorus_buyer_artifact_mismatch",
            "Le SIRET public qualifié ne correspond pas à l'acheteur de l'artefact émis.",
            fields=["invoice.buyer_snapshot.siret"],
        )
    if service_code and artifact_service_code != service_code:
        raise _error(
            400,
            "chorus_service_code_artifact_mismatch",
            "Le code service est absent de l'artefact émis. Corrigez puis réémettez la facture.",
            fields=["invoice.public_service_code"],
        )
    if commitment_reference and artifact_commitment != commitment_reference:
        raise _error(
            400,
            "chorus_commitment_artifact_mismatch",
            "L'engagement juridique est absent de l'artefact émis. Corrigez puis réémettez la facture.",
            fields=["invoice.purchase_order_number"],
        )


def _require_connector_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    if settings.ALLOW_TENANT_CONNECTORS:
        role = (user.role or "").lower()
        if user.is_admin or (role in {"owner", "admin"} and user.tenant_id):
            return user
        raise HTTPException(403, "Accès réservé à l'administrateur de l'espace.")
    return require_platform_admin(user)


def _is_prod_like() -> bool:
    env = (settings.APP_ENV or "").strip().lower()
    return env in {"prod", "production", "staging"}


def _export_hint_for_code(code: str | None) -> str | None:
    normalized = (code or "").strip().lower()
    if normalized in {"seqino_mandate_missing", "seqino_not_ready", "mandate_missing"}:
        return "Vous pouvez continuer en mode export sans plateforme."
    return None


def _error(
    status_code: int,
    code: str,
    message: str,
    *,
    hint: str | None = None,
    **extra: Any,
) -> HTTPException:
    detail: dict[str, Any] = {"code": code, "message": message}
    final_hint = hint or _export_hint_for_code(code)
    if final_hint:
        detail["hint"] = final_hint
    if extra:
        detail.update(extra)
    return HTTPException(status_code=status_code, detail=detail)


def _provider_error_status(exc: PdpProviderError) -> int:
    if isinstance(exc, SeqinoHttpError):
        return exc.status_code
    code = (exc.code or "").strip().lower()
    if code == "artifact_integrity_error":
        return 409
    if code == "chorus_status_forbidden":
        return 403
    if code == "chorus_status_not_found":
        return 404
    if code in {"chorus_config_missing", "chorus_syntaxe_flux_missing"}:
        return 409
    if code in {
        "chorus_facturx_invalid",
        "chorus_facturx_profile_invalid",
        "chorus_facturx_profile_unsupported",
    }:
        return 422
    if code == "chorus_facturx_busy":
        return 503
    if code in {
        "chorus_cpro_account_missing",
        "einvoicing_in_progress",
        "einvoicing_reconciliation_required",
    }:
        return 409
    if code in {"chorus_external_id_missing", "chorus_submit_endpoint_missing"}:
        return 502
    if code in {"chorus_auth_failed"}:
        return 502
    if code in {"chorus_submit_conflict"}:
        return 409
    if code in {"chorus_submit_rejected"}:
        return 422
    if code in {"chorus_rate_limited"}:
        return 429
    if code in {"chorus_unavailable"}:
        return 503
    if code in {"chorus_timeout"}:
        return 504
    return seqino_http_status(exc.code)


def _append_event(events: list[dict[str, Any]] | None, status: str, message: str | None = None) -> list[dict[str, Any]]:
    timeline = list(events or [])
    timeline.append(
        {
            "event_type": "status_update",
            "status": status,
            "message": message,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    return timeline


def _resolve_connection(db: Session, tenant_id: str, connector_slug: str) -> tuple[PdpConnection | None, dict]:
    conn = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.provider_slug == connector_slug)
        .first()
    )
    if not conn:
        return None, {}
    if (conn.status or "").lower() != "connected":
        if connector_slug == "seqino":
            raise _error(409, "seqino_connection_missing", "Connexion plateforme partenaire inactive ou non finalisee.")
        raise _error(400, "connection_inactive", "Connexion plateforme inactive.")
    from ..utils.crypto import decrypt_payload

    creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
    if tenant_id:
        creds = dict(creds)
        creds["_tenant_id"] = tenant_id
        creds = enrich_credentials_with_secrets(db, tenant_id, creds)
    return conn, creds


async def get_status_impl(
    submission_id: str,
    connector: str | None,
    db: Session,
    user: AuthUser,
) -> dict[str, Any]:
    connector_slug = _normalize_connector(connector)
    tx = _get_transmission_for_external_id(
        db,
        user.tenant_id,
        submission_id,
        requested_connector=connector_slug,
    )
    connector_slug = _normalize_connector(tx.channel)
    ensure_connected_mode_operational(db, user.tenant_id, connector_slug)

    if connector_slug == "seqino" and not seqino_has_active_mandate(user.tenant_id, db=db):
        raise _error(
            409,
            "seqino_mandate_missing",
            "Mandat de plateforme agréée actif requis pour consulter le statut.",
        )

    if connector_slug in {"chorus", "choruspro"}:
        connector_slug = "choruspro"
        creds = enrich_credentials_with_secrets(db, user.tenant_id, {"_tenant_id": user.tenant_id})
    else:
        conn, creds = _resolve_connection(db, user.tenant_id, connector_slug)
        if not conn and connector_slug != "dummy":
            raise _error(400, "connection_missing", "Connexion plateforme manquante.")

    try:
        connector_impl = get_provider(connector_slug, creds)
    except Exception:
        raise _error(400, "connector_unknown", "Connector plateforme inconnu.")
    try:
        status_result = await connector_impl.poll_transmission_status(submission_id)
    except PdpProviderError as exc:
        status_code = _provider_error_status(exc)
        raise _error(status_code, exc.code or "status_failed", str(exc))

    update_transmission_status(
        db,
        tx=tx,
        tenant_id=user.tenant_id,
        status_result=status_result,
        source="platforms_status",
        actor_user_id=user.id,
    )
    _update_submission_status(db, tx, status_result)
    db.add(tx)
    db.commit()

    return {"status": status_result.status, "connector": connector_slug}


def _submission_raw(tx: EInvoicingTransmission, status_result: Any | None = None) -> dict[str, Any] | None:
    raw: dict[str, Any] = {}
    if tx.events:
        raw["events"] = tx.events
    if status_result is not None:
        status_events = getattr(status_result, "events", None)
        if status_events:
            raw["events"] = status_events
        raw_status = getattr(status_result, "raw_status", None)
        if raw_status:
            raw["raw_status"] = raw_status
        errors = getattr(status_result, "errors", None)
        if errors:
            raw["errors"] = errors
    return raw or None


def _record_submission(db: Session, inv: Invoice, channel: str, tx: EInvoicingTransmission) -> Submission:
    channel_value = "chorus" if channel in {"chorus", "choruspro"} else channel
    submission = None
    if tx.external_id:
        submission = (
            db.query(Submission)
            .filter(
                Submission.invoice_id == inv.id,
                Submission.channel == channel_value,
                Submission.external_id == tx.external_id,
            )
            .order_by(Submission.created_at.asc())
            .first()
        )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if submission is None:
        submission = Submission(
            invoice_id=inv.id,
            channel=channel_value,
            status=tx.status,
            external_id=tx.external_id,
            raw=_submission_raw(tx),
            created_at=now,
            updated_at=now,
        )
    else:
        submission.status = tx.status
        submission.raw = _submission_raw(tx)
        submission.updated_at = now
    db.add(submission)
    db.commit()
    db.refresh(submission)
    return submission


def _mark_invoice_sent_after_submission(
    db: Session,
    inv: Invoice,
    tx: EInvoicingTransmission,
    user: AuthUser,
) -> None:
    if (tx.delivery_state or "").strip().lower() != "delivered":
        return
    if _transmission_status_group(tx.status) in {"failed", "rejected"}:
        return
    invoice = db.get(Invoice, inv.id)
    if not invoice or invoice.tenant_id != user.tenant_id:
        return
    changed = False
    if not invoice.sent_at:
        invoice.sent_at = datetime.now(timezone.utc).replace(tzinfo=None)
        changed = True
    if invoice.status == "issued":
        invoice.status = "sent"
        changed = True
    if not changed:
        return
    db.add(invoice)
    log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="invoice_mark_sent",
        object_type="invoice",
        object_id=invoice.id,
        metadata={
            "reason": "platform_submission",
            "transmission_id": tx.id,
            "channel": tx.channel,
            "status": tx.status,
            "external_id": tx.external_id,
        },
    )
    db.commit()


def _update_submission_status(
    db: Session,
    tx: EInvoicingTransmission,
    status_result: Any,
) -> None:
    submission = (
        db.query(Submission)
        .filter(Submission.external_id == tx.external_id, Submission.invoice_id == tx.invoice_id)
        .order_by(Submission.updated_at.desc(), Submission.created_at.desc())
        .first()
    )
    if not submission:
        return
    submission.status = status_result.status or submission.status
    submission.raw = _submission_raw(tx, status_result)
    submission.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(submission)


def _seqino_credentials(db: Session, tenant_id: str) -> tuple[str, str | None, str]:
    conn = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.provider_slug == "seqino")
        .order_by(PdpConnection.updated_at.desc())
        .first()
    )
    account = (
        db.query(PdpAccount)
        .filter(PdpAccount.tenant_id == tenant_id, PdpAccount.provider == "seqino")
        .order_by(PdpAccount.updated_at.desc())
        .first()
    )
    if not conn and not account:
        raise _error(404, "seqino_connection_missing", "Connexion plateforme partenaire manquante.")
    from ..utils.crypto import decrypt_payload

    try:
        creds = decrypt_payload(conn.encrypted_credentials) if conn and conn.encrypted_credentials else {}
    except Exception:
        logger.warning("Seqino credentials decrypt failed", extra={"tenant_id": tenant_id})
        creds = {}
    access_token, sponsor_id = resolve_seqino_credentials(db, tenant_id)
    if not access_token and not _seqino_demo_mode():
        raise _error(400, "seqino_token_missing", "Token plateforme partenaire manquant pour les mandats.")
    if _seqino_demo_mode():
        access_token = access_token or "demo"
        sponsor_id = sponsor_id or "demo"
    if not access_token:
        raise _error(400, "seqino_token_missing", "Token plateforme partenaire manquant pour les mandats.")
    client_id = creds.get("client_id") or creds.get("seqino_client_id")
    if not client_id and account:
        client_id = account.provider_client_id or get_pdp_account_metadata(account).get("provider_account_id")
    if not client_id:
        raise _error(400, "seqino_client_missing", "client_id plateforme partenaire manquant pour les mandats.")
    return access_token, sponsor_id, str(client_id)


def _ensure_demo_mandate(db: Session, tenant: Tenant) -> None:
    existing = (
        db.query(PdpMandate).filter(PdpMandate.tenant_id == tenant.id, PdpMandate.provider_slug == "seqino").first()
    )
    if existing:
        return
    siret_digits = "".join(ch for ch in (tenant.siret or "") if ch.isdigit())
    siren = siret_digits[:9] if len(siret_digits) >= 9 else None
    mandate = PdpMandate(
        tenant_id=tenant.id,
        provider_slug="seqino",
        mandate_id=f"demo-mandate-{uuid4().hex[:8]}",
        status="ACTIVE",
        name=tenant.name,
        siren=siren,
        siret=tenant.siret,
    )
    db.add(mandate)


def _upsert_pdp_mandate(db: Session, tenant_id: str, data: dict[str, Any]) -> PdpMandate | None:
    mandate_id = (data.get("mandate_id") or "").strip()
    if not mandate_id:
        return None
    mandate = (
        db.query(PdpMandate).filter(PdpMandate.tenant_id == tenant_id, PdpMandate.mandate_id == mandate_id).first()
    )
    if not mandate:
        mandate = PdpMandate(
            tenant_id=tenant_id,
            provider_slug="seqino",
            mandate_id=mandate_id,
        )
        db.add(mandate)

    for field in ("siren", "siret", "suffix", "routing_identifier", "name", "start_date", "status", "file_attachment"):
        value = data.get(field)
        if value is not None:
            setattr(mandate, field, value)
    return mandate


def _is_active_mandate_status(status: str | None) -> bool:
    return (status or "").strip().upper() in _ACTIVE_MANDATE_STATUSES


def _digits_only(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _tenant_default_directory_entry(tenant: Tenant) -> dict[str, str]:
    siret_digits = _digits_only(tenant.siret)
    siren = siret_digits[:9] if len(siret_digits) >= 9 else ""
    name = (tenant.name or "").strip()
    if not name:
        raise _error(
            422,
            "company_name_missing",
            "Renseignez le nom de l'entreprise avant d'activer la plateforme partenaire.",
        )
    if len(siren) != 9:
        raise _error(
            422,
            "company_siren_missing",
            "Renseignez un SIRET valide dans Mon entreprise avant d'activer la plateforme partenaire.",
        )
    entry: dict[str, str] = {
        "siren": siren,
        "name": name,
    }
    if len(siret_digits) == 14:
        entry["siret"] = siret_digits
    return entry


def _latest_seqino_mandate_for_entry(
    db: Session,
    tenant_id: str,
    entry_payload: dict[str, str],
    *,
    mandate_id: str | None = None,
) -> PdpMandate | None:
    if mandate_id:
        existing = (
            db.query(PdpMandate)
            .filter(
                PdpMandate.tenant_id == tenant_id,
                PdpMandate.provider_slug == "seqino",
                PdpMandate.mandate_id == mandate_id,
            )
            .order_by(PdpMandate.updated_at.desc())
            .first()
        )
        if existing:
            return existing

    query = db.query(PdpMandate).filter(
        PdpMandate.tenant_id == tenant_id,
        PdpMandate.provider_slug == "seqino",
        PdpMandate.siren == entry_payload["siren"],
    )
    siret = entry_payload.get("siret")
    if siret:
        query = query.filter(PdpMandate.siret == siret)
    return query.order_by(PdpMandate.updated_at.desc()).first()


def _seqino_mandate_start_date_iso() -> str:
    utc_today = datetime.now(timezone.utc).date()
    return datetime(utc_today.year, utc_today.month, utc_today.day, tzinfo=timezone.utc).isoformat()


async def _ensure_seqino_default_mandate_for_client(
    db: Session,
    tenant: Tenant,
    *,
    access_token: str,
    sponsor_id: str | None,
    client_id: str,
    existing_mandate_id: str | None = None,
    force: bool = False,
) -> PdpMandate:
    entry_payload = _tenant_default_directory_entry(tenant)
    tenant_id = str(tenant.id)
    if not force:
        local_mandate = _latest_seqino_mandate_for_entry(
            db,
            tenant_id,
            entry_payload,
            mandate_id=existing_mandate_id,
        )
        if local_mandate:
            return local_mandate

    mandate_payload: dict[str, Any] = {
        "directory_entry": entry_payload,
        "start_date": _seqino_mandate_start_date_iso(),
    }
    result = await seqino_mandates.create_mandate(
        mandate_payload,
        access_token=access_token,
        client_id=client_id,
        sponsor_id=sponsor_id,
        tenant_id=tenant_id,
    )
    raw_payload = result.get("payload") if isinstance(result, dict) else None
    merged_payload = dict(mandate_payload)
    if isinstance(raw_payload, dict):
        merged_payload.update(raw_payload)
        if isinstance(mandate_payload.get("directory_entry"), dict) and isinstance(
            raw_payload.get("directory_entry"), dict
        ):
            merged_payload["directory_entry"] = {
                **mandate_payload["directory_entry"],
                **raw_payload["directory_entry"],
            }
    normalized = seqino_mandates.normalize_mandate_item(merged_payload)
    if not normalized.get("mandate_id"):
        normalized["mandate_id"] = result.get("mandate_id")
    mandate = _upsert_pdp_mandate(db, tenant_id, normalized)
    if not mandate:
        raise ValueError("mandate_id manquant pour le mandat PDP.")
    return mandate


def _seqino_active_mandate_count(db: Session, tenant_id: str) -> int:
    rows = (
        db.query(PdpMandate.status)
        .filter(PdpMandate.tenant_id == tenant_id, PdpMandate.provider_slug == "seqino")
        .all()
    )
    return sum(1 for (status,) in rows if _is_active_mandate_status(status))


def _seqino_connection(db: Session, tenant_id: str) -> PdpConnection | None:
    return (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.provider_slug == "seqino")
        .order_by(PdpConnection.updated_at.desc())
        .first()
    )


def _apply_seqino_connection_status(
    db: Session,
    tenant_id: str,
    *,
    conn: PdpConnection | None = None,
    active_count: int | None = None,
    demote_when_missing: bool = False,
) -> int:
    db.flush()
    connection = conn or _seqino_connection(db, tenant_id)
    count = _seqino_active_mandate_count(db, tenant_id) if active_count is None else active_count
    if not connection:
        return count
    next_status = None
    if count > 0 and (connection.status or "").lower() != "connected":
        next_status = "connected"
    elif demote_when_missing and count == 0 and (connection.status or "").lower() == "connected":
        next_status = "pending"
    if next_status:
        connection.status = next_status
        connection.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(connection)
    return count


async def _sync_seqino_mandates_from_remote(
    db: Session,
    tenant_id: str,
    *,
    demote_when_missing: bool = False,
) -> tuple[list[PdpMandate], int]:
    access_token, sponsor_id, client_id = _seqino_credentials(db, tenant_id)
    items = await seqino_mandates.list_mandates(
        access_token=access_token,
        client_id=client_id,
        sponsor_id=sponsor_id,
        tenant_id=tenant_id,
    )
    mandates: list[PdpMandate] = []
    remote_active_count = 0
    for item in items:
        normalized = seqino_mandates.normalize_mandate_item(item)
        if _is_active_mandate_status(normalized.get("status")):
            remote_active_count += 1
        mandate = _upsert_pdp_mandate(db, tenant_id, normalized)
        if mandate:
            mandates.append(mandate)
    active_count = _apply_seqino_connection_status(
        db,
        tenant_id,
        active_count=remote_active_count,
        demote_when_missing=demote_when_missing,
    )
    return mandates, active_count


def build_router(prefix: str = "") -> APIRouter:
    router = APIRouter(
        prefix=prefix,
        tags=["platforms"],
        dependencies=[Depends(require_product_feature("einvoicing_enabled"))],
    )

    @router.get("/connectors")
    def list_connectors(user: AuthUser = Depends(require_viewer_or_admin)):
        _ = user
        return {"connectors": [p.metadata() for p in list_providers()]}

    @router.get("/connections", response_model=list[PdpConnectionOut])
    def list_connections(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        return (
            db.query(PdpConnection)
            .filter(PdpConnection.tenant_id == user.tenant_id)
            .order_by(PdpConnection.updated_at.desc())
            .all()
        )

    @router.get("/test-connection")
    async def test_connection(
        connector: str | None = Query(default=None),
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        connector_slug = _normalize_connector(connector)
        if not connector_slug:
            raise _error(400, "connector_required", "Sélectionnez une plateforme agréée.")
        ensure_connected_mode_operational(db, user.tenant_id, connector_slug)

        conn, creds = _resolve_connection(db, user.tenant_id, connector_slug)
        if not conn:
            raise _error(404, "connection_missing", "Connexion plateforme manquante.")

        try:
            connector_impl = get_provider(connector_slug, creds)
        except Exception:
            raise _error(501, "connector_not_supported", "Cette plateforme n’est pas prise en charge.")

        try:
            result = await connector_impl.test_connection()
        except Exception:
            result = {"ok": False, "message": "Echec du test de connexion."}

        if not isinstance(result, dict):
            ok = bool(result)
            if not ok:
                raise _error(400, "connector_invalid_config", "Echec du test de connexion.")
            return {"ok": ok, "message": "Connexion OK.", "connector": connector_slug}

        ok = bool(result.get("ok"))
        message = result.get("message") or ("Connexion OK." if ok else "Connexion en echec.")
        if not ok:
            raise _error(400, "connector_invalid_config", message)
        return {"ok": ok, "message": message, "connector": connector_slug}

    @router.get("/test/{provider_slug}")
    @router.post("/test/{provider_slug}")
    async def test_connection_slug(
        provider_slug: str,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        connector_slug = _normalize_connector(provider_slug)
        if not connector_slug:
            raise _error(400, "connector_required", "Sélectionnez une plateforme agréée.")
        ensure_connected_mode_operational(db, user.tenant_id, connector_slug)

        conn, creds = _resolve_connection(db, user.tenant_id, connector_slug)
        if not conn:
            raise _error(400, "connection_missing", "Connexion plateforme manquante ou inactive.")

        try:
            connector_impl = get_provider(connector_slug, creds)
        except Exception:
            raise _error(501, "connector_not_supported", "Cette plateforme n’est pas prise en charge.")

        try:
            result = await connector_impl.test_connection()
        except Exception:
            result = {"ok": False, "message": "Echec du test de connexion."}

        if not isinstance(result, dict):
            ok = bool(result)
            if not ok:
                raise _error(400, "connector_invalid_config", "Echec du test de connexion.")
            return {"ok": ok}
        ok = bool(result.get("ok"))
        message = result.get("message") or ("Connexion OK." if ok else "Connexion en echec.")
        if not ok:
            raise _error(400, "connector_invalid_config", message)
        return {"ok": ok, "message": message}

    @router.post("/connections", response_model=PdpConnectionOut)
    def upsert_connection(
        payload: PdpConnectRequest,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(_require_connector_admin),
    ):
        provider_slug = _normalize_connector(payload.provider_slug)
        if not provider_slug:
            raise _error(400, "provider_slug_required", "provider_slug requis")
        if provider_slug == "choruspro":
            raise _error(
                403,
                "chorus_server_managed",
                "La connexion Chorus est gérée par l'administrateur de la plateforme.",
            )
        # Connector creation is the step that makes tenant-scoped credentials
        # operational. Requiring an already operational connector here would
        # make first-time setup impossible. Export-only remains fail-closed.
        if settings.EINVOICING_EXPORT_ONLY:
            ensure_connected_mode_operational(db, user.tenant_id, provider_slug)
        if provider_slug == "choruspro" and not _chorus_server_bootstrap_ready():
            raise _error(
                409,
                "connected_mode_not_operational",
                "Le mode connecté n'est pas opérationnel pour ce fournisseur.",
            )
        if provider_slug == "seqino":
            raw_credentials = dict(payload.credentials or {})
            if any(
                key in raw_credentials
                for key in ("access_token", "token", "api_key", "authorization", "sponsor_id", "pdp_sponsor_id")
            ):
                logger.warning("Seqino credentials payload contains server-managed fields; ignoring.")
            raise _error(403, "seqino_server_managed", "Connexion plateforme partenaire gérée côté serveur.")

        auth_type = (payload.auth_type or "").strip().lower()
        if auth_type not in {"api_key", "oauth"}:
            raise _error(400, "auth_type_invalid", "auth_type invalide")

        try:
            raw_credentials = dict(payload.credentials or {})
            chorus_cpro_account: str | None = None
            if provider_slug == "choruspro":
                chorus_cpro_account = (
                    str(
                        raw_credentials.pop("chorus_cpro_account", None)
                        or raw_credentials.pop("cpro_account", None)
                        or ""
                    ).strip()
                    or None
                )
            creds = dict(raw_credentials)
            creds["_tenant_id"] = user.tenant_id
            creds = enrich_credentials_with_secrets(db, user.tenant_id, creds)
            if chorus_cpro_account:
                creds["chorus_cpro_account"] = chorus_cpro_account
            connector_impl = get_provider(provider_slug, creds)
        except Exception:
            raise _error(400, "connector_unknown", "Connector plateforme inconnu ou non supporte")

        missing_fn = getattr(connector_impl, "missing_server_config", None)
        if callable(missing_fn):
            missing = missing_fn()
            if missing:
                missing_str = ", ".join(missing)
                raise _error(
                    400,
                    "connector_invalid_config",
                    f"Config serveur manquante: {missing_str}.",
                    missing=missing,
                )

        if provider_slug in {"http_generic", "http", "generic"}:
            base_url = (payload.credentials or {}).get("base_url")
            if not base_url:
                raise _error(400, "base_url_required", f"base_url requis pour {provider_slug}.")
            try:
                validate_outbound_url(str(base_url))
            except ValueError as exc:
                raise _error(400, "base_url_invalid", str(exc))

        from ..utils.crypto import encrypt_payload

        encrypted = encrypt_payload(raw_credentials)
        conn = (
            db.query(PdpConnection)
            .filter(PdpConnection.tenant_id == user.tenant_id, PdpConnection.provider_slug == provider_slug)
            .first()
        )
        if not conn:
            conn = PdpConnection(
                tenant_id=user.tenant_id,
                provider_slug=provider_slug,
                auth_type=auth_type,
            )

        conn.auth_type = auth_type
        conn.encrypted_credentials = encrypted
        conn.status = (payload.status or "connected").strip().lower()

        if provider_slug == "choruspro" and chorus_cpro_account:
            upsert_integration_secret(
                db,
                tenant_id=user.tenant_id,
                secret_key=CHORUS_CPRO_ACCOUNT_KEY,
                secret_value=chorus_cpro_account,
            )

        db.add(conn)
        db.commit()
        db.refresh(conn)
        return conn

    @router.post("/seqino/onboard")
    async def seqino_onboard(
        request: Request,
        payload: SeqinoOnboardRequest | None = None,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_paid_subscription_or_trial),
        __: AuthUser = Depends(require_product_feature("seqino_enabled")),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        tenant = db.get(Tenant, user.tenant_id)
        if not tenant:
            raise _error(404, "tenant_missing", "Entreprise introuvable.")

        conn = (
            db.query(PdpConnection)
            .filter(PdpConnection.tenant_id == user.tenant_id, PdpConnection.provider_slug == "seqino")
            .first()
        )
        from ..utils.crypto import decrypt_payload, encrypt_payload

        creds = decrypt_payload(conn.encrypted_credentials) if conn and conn.encrypted_credentials else {}
        access_token, sponsor_id = resolve_seqino_credentials(db, user.tenant_id)
        if not access_token and not _seqino_demo_mode():
            raise _error(400, "seqino_token_missing", "Token plateforme partenaire manquant pour l'onboarding.")
        if _seqino_demo_mode():
            access_token = access_token or "demo"
            sponsor_id = sponsor_id or "demo"
        if not access_token:
            raise _error(400, "seqino_token_missing", "Token plateforme partenaire manquant.")
        existing_client_id = creds.get("seqino_client_id") or creds.get("client_id")
        existing_link_id = creds.get("seqino_onboarding_link_id") or creds.get("seqino_link_id")
        existing_mandate_id = creds.get("seqino_mandate_id") or creds.get("seqino_onboarding_mandate_id")
        raw_existing_link_url = creds.get("seqino_onboarding_url")
        existing_link_url = normalize_onboarding_url(raw_existing_link_url)
        if existing_link_url and existing_link_url != raw_existing_link_url:
            creds["seqino_onboarding_url"] = existing_link_url
            conn.encrypted_credentials = encrypt_payload(creds)
            conn.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.add(conn)
            db.commit()
        existing_status = creds.get("seqino_onboarding_status")
        existing_expires_at = creds.get("seqino_onboarding_expires_at")
        force = bool(payload.force) if payload else False
        accepted_mandate = bool(payload.accept_mandate) if payload else False

        if not existing_mandate_id and not accepted_mandate:
            raise _error(
                400,
                "seqino_mandate_consent_required",
                "Confirmez explicitement l'activation du mandat Seqino avant de continuer.",
            )
        if accepted_mandate:
            _record_seqino_mandate_consent(
                db,
                user=user,
                request=request,
                object_id=existing_mandate_id or user.tenant_id,
                scope="default_onboarding_mandate",
            )

        if (
            existing_client_id
            and existing_mandate_id
            and existing_link_url
            and _seqino_onboarding_link_is_current(existing_expires_at)
            and not force
        ):
            return {
                "ok": True,
                "already_onboarded": True,
                "client_id": existing_client_id,
                "link_id": existing_link_id or existing_mandate_id,
                "mandate_id": existing_mandate_id,
                "onboarding_url": existing_link_url,
                "status": existing_status,
            }

        try:
            client_result = await get_or_create_client(
                tenant,
                access_token=access_token,
                contact_email=user.email,
                sponsor_id=sponsor_id,
                existing_client_id=None if force else existing_client_id,
            )
            client_id = str(client_result.get("client_id") or "").strip()
            if not client_id:
                raise ValueError("client_id plateforme partenaire manquant.")
            mandate = await _ensure_seqino_default_mandate_for_client(
                db,
                tenant,
                access_token=access_token,
                sponsor_id=sponsor_id,
                client_id=client_id,
                existing_mandate_id=None if force else existing_mandate_id,
                force=force,
            )
            result = await create_onboarding_link(
                tenant=tenant,
                access_token=access_token,
                client_id=client_id,
                mandate_id=mandate.mandate_id,
                sponsor_id=sponsor_id,
            )
        except HTTPException:
            raise
        except ValueError as exc:
            raise _error(400, "seqino_onboarding_invalid", str(exc))
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "seqino_onboarding_failed", str(exc))
        except Exception:
            raise _error(502, "seqino_onboarding_failed", "Erreur lors de l'onboarding plateforme partenaire.")

        link_id = result["link_id"]
        mandate_id = result.get("mandate_id") or link_id
        onboarding_url = result["onboarding_url"]
        for key in ("access_token", "token", "api_key", "authorization", "sponsor_id", "pdp_sponsor_id"):
            creds.pop(key, None)
        creds["client_id"] = client_id
        creds["seqino_client_id"] = client_id
        creds["seqino_onboarding_link_id"] = link_id
        creds["seqino_mandate_id"] = mandate_id
        creds.pop("seqino_link_id", None)
        creds["seqino_onboarding_url"] = onboarding_url
        if result.get("expires_at"):
            creds["seqino_onboarding_expires_at"] = result["expires_at"]
        creds["seqino_onboarding_status"] = "PENDING"

        encrypted = encrypt_payload(creds)
        if not conn:
            conn = PdpConnection(
                tenant_id=user.tenant_id,
                provider_slug="seqino",
                auth_type="api_key",
            )
        conn.auth_type = conn.auth_type or "api_key"
        conn.encrypted_credentials = encrypted
        conn.status = "pending"
        conn.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)

        db.add(conn)
        db.commit()
        db.refresh(conn)
        if _seqino_demo_mode():
            _ensure_demo_mandate(db, tenant)
            db.commit()
        return {
            "ok": True,
            "client_id": client_id,
            "link_id": link_id,
            "mandate_id": mandate_id,
            "onboarding_url": onboarding_url,
            "expires_at": result.get("expires_at"),
            "status": "PENDING",
        }

    @router.get("/seqino/onboarding-status")
    async def seqino_onboarding_status(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_product_feature("seqino_enabled")),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        conn = (
            db.query(PdpConnection)
            .filter(PdpConnection.tenant_id == user.tenant_id, PdpConnection.provider_slug == "seqino")
            .first()
        )
        account = (
            db.query(PdpAccount)
            .filter(PdpAccount.tenant_id == user.tenant_id, PdpAccount.provider == "seqino")
            .order_by(PdpAccount.updated_at.desc())
            .first()
        )
        if not conn:
            if account and account.provider_client_id:
                metadata = get_pdp_account_metadata(account)
                status = account.status or metadata.get("status") or metadata.get("onboarding_status") or "PENDING"
                mandate_active_count = _seqino_active_mandate_count(db, user.tenant_id)
                status_key = str(status).strip().lower()
                mandate_id = metadata.get("mandate_id") or metadata.get("onboarding_mandate_id")
                link_id = metadata.get("onboarding_link_id") or metadata.get("link_id") or mandate_id
                return {
                    "ok": True,
                    "connected": mandate_active_count > 0 or status_key in {"active", "connected"},
                    "status": status,
                    "link_id": link_id,
                    "mandate_id": mandate_id,
                    "onboarding_url": normalize_onboarding_url(metadata.get("onboarding_url")),
                    "client_id": account.provider_client_id,
                    "mandate_active_count": mandate_active_count,
                    "mandate_sync_error": None,
                }
            return {
                "ok": True,
                "connected": False,
                "status": "NOT_STARTED",
                "link_id": None,
                "onboarding_url": None,
                "client_id": None,
            }

        from ..utils.crypto import decrypt_payload, encrypt_payload

        creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
        account_metadata = get_pdp_account_metadata(account)

        access_token, sponsor_id = resolve_seqino_credentials(db, user.tenant_id)
        if not access_token and not _seqino_demo_mode():
            raise _error(400, "seqino_token_missing", "Token plateforme partenaire manquant.")
        if _seqino_demo_mode():
            access_token = access_token or "demo"
            sponsor_id = sponsor_id or "demo"
        if not access_token:
            raise _error(400, "seqino_token_missing", "Token plateforme partenaire manquant.")
        client_id = creds.get("seqino_client_id") or creds.get("client_id")
        if not client_id and account:
            client_id = account.provider_client_id or account_metadata.get("provider_account_id")
        if not client_id:
            raise _error(400, "seqino_client_missing", "client_id plateforme partenaire manquant.")
        link_id = (
            creds.get("seqino_onboarding_link_id")
            or creds.get("seqino_link_id")
            or account_metadata.get("onboarding_link_id")
            or account_metadata.get("link_id")
        )
        mandate_id = (
            creds.get("seqino_mandate_id")
            or creds.get("seqino_onboarding_mandate_id")
            or account_metadata.get("mandate_id")
            or account_metadata.get("onboarding_mandate_id")
        )
        legacy_link_as_mandate = False
        resolved_mandate_from_sync = False
        if not mandate_id:
            try:
                synced_mandates, _active_count = await _sync_seqino_mandates_from_remote(
                    db,
                    user.tenant_id,
                    demote_when_missing=False,
                )
                for synced_mandate in synced_mandates:
                    if synced_mandate.mandate_id:
                        mandate_id = synced_mandate.mandate_id
                        resolved_mandate_from_sync = True
                        break
            except Exception:
                db.rollback()
        if not mandate_id and link_id:
            raw_link = str(link_id).strip()
            if raw_link and not raw_link.lower().startswith(("link", "onb")):
                mandate_id = raw_link
                legacy_link_as_mandate = True
        if not mandate_id:
            raise _error(400, "seqino_mandate_missing", "mandate_id plateforme partenaire manquant.")

        try:
            result = await fetch_onboarding_status(
                access_token=access_token,
                client_id=client_id,
                mandate_id=mandate_id,
                sponsor_id=sponsor_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_onboarding_invalid", str(exc))
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "seqino_onboarding_failed", str(exc))
        except Exception:
            raise _error(502, "seqino_onboarding_failed", "Erreur lors de la recuperation du statut PDP.")

        status = result.get("status") or "PENDING"
        mandate_sync_error = None
        mandate_active_count = _seqino_active_mandate_count(db, user.tenant_id)
        try:
            _mandates, mandate_active_count = await _sync_seqino_mandates_from_remote(
                db,
                user.tenant_id,
                demote_when_missing=False,
            )
        except (ValueError, PdpProviderError) as exc:
            logger.warning(
                "seqino_mandate_sync_failed",
                extra={
                    "target_tenant_id": str(user.tenant_id),
                    "error_type": type(exc).__name__,
                    "provider_code": getattr(exc, "code", None),
                },
            )
            mandate_sync_error = _SEQINO_MANDATE_SYNC_PUBLIC_ERROR
        except Exception as exc:
            logger.warning(
                "seqino_mandate_sync_failed",
                extra={
                    "target_tenant_id": str(user.tenant_id),
                    "error_type": type(exc).__name__,
                    "provider_code": None,
                },
            )
            mandate_sync_error = _SEQINO_MANDATE_SYNC_PUBLIC_ERROR

        if mandate_id and not creds.get("seqino_mandate_id"):
            creds["seqino_mandate_id"] = mandate_id
        if not link_id or legacy_link_as_mandate or resolved_mandate_from_sync:
            link_id = mandate_id
        if link_id and (
            resolved_mandate_from_sync or legacy_link_as_mandate or not creds.get("seqino_onboarding_link_id")
        ):
            creds["seqino_onboarding_link_id"] = link_id
            creds.pop("seqino_link_id", None)
        creds["seqino_onboarding_status"] = status
        if mandate_active_count > 0:
            conn.status = "connected"
        else:
            conn.status = "pending"
        for key in ("access_token", "token", "api_key", "authorization", "sponsor_id", "pdp_sponsor_id"):
            creds.pop(key, None)
        conn.encrypted_credentials = encrypt_payload(creds)
        conn.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(conn)
        db.commit()
        db.refresh(conn)

        return {
            "ok": True,
            "status": status,
            "link_id": link_id,
            "mandate_id": mandate_id,
            "onboarding_url": normalize_onboarding_url(creds.get("seqino_onboarding_url")),
            "client_id": creds.get("seqino_client_id") or creds.get("client_id"),
            "connected": (conn.status or "").lower() == "connected",
            "mandate_active_count": mandate_active_count,
            "mandate_sync_error": mandate_sync_error,
        }

    @router.get("/seqino/client")
    async def seqino_get_client(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_product_feature("seqino_enabled")),
        __: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        access_token, sponsor_id, client_id = _seqino_credentials(db, user.tenant_id)
        try:
            result = await get_seqino_client(
                access_token=access_token,
                client_id=client_id,
                sponsor_id=sponsor_id,
                tenant_id=user.tenant_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_client_invalid", str(exc))
        except PdpProviderError as exc:
            raise _error(_provider_error_status(exc), exc.code or "seqino_client_read_failed", str(exc))
        allowed_fields = {
            "client_id",
            "organization_name",
            "contact_email",
            "external_ref",
            "status",
            "created_at",
            "updated_at",
        }
        return {key: value for key, value in result.items() if key in allowed_fields}

    @router.put("/seqino/client/sync")
    async def seqino_sync_client(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_product_feature("seqino_enabled")),
        __: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        tenant = db.get(Tenant, user.tenant_id)
        if not tenant:
            raise _error(404, "tenant_missing", "Entreprise introuvable.")
        access_token, sponsor_id, client_id = _seqino_credentials(db, user.tenant_id)
        try:
            result = await update_seqino_client(
                tenant,
                access_token=access_token,
                client_id=client_id,
                contact_email=user.email,
                sponsor_id=sponsor_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_client_invalid", str(exc))
        except PdpProviderError as exc:
            raise _error(_provider_error_status(exc), exc.code or "seqino_client_sync_failed", str(exc))
        log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action_type="seqino_client_synced",
            object_type="pdp_client",
            object_id=client_id,
            metadata={"provider": "seqino"},
        )
        db.commit()
        return {"ok": True, "client_id": result["client_id"]}

    @router.delete("/seqino/client")
    async def seqino_offboard_client(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_product_feature("seqino_enabled")),
        __: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        mandate_count = (
            db.query(func.count(PdpMandate.id))
            .filter(
                PdpMandate.tenant_id == user.tenant_id,
                PdpMandate.provider_slug == "seqino",
            )
            .scalar()
        )
        if int(mandate_count or 0) > 0:
            raise _error(
                409,
                "seqino_client_has_mandates",
                "Supprimez tous les mandats Seqino avant de fermer le client plateforme partenaire.",
            )
        access_token, sponsor_id, client_id = _seqino_credentials(db, user.tenant_id)
        try:
            await delete_seqino_client(
                access_token=access_token,
                client_id=client_id,
                sponsor_id=sponsor_id,
                tenant_id=user.tenant_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_client_invalid", str(exc))
        except PdpProviderError as exc:
            raise _error(_provider_error_status(exc), exc.code or "seqino_client_delete_failed", str(exc))

        from ..utils.crypto import decrypt_payload, encrypt_payload

        connection = _seqino_connection(db, user.tenant_id)
        if connection:
            credentials = decrypt_payload(connection.encrypted_credentials) if connection.encrypted_credentials else {}
            for key in (
                "client_id",
                "seqino_client_id",
                "seqino_onboarding_link_id",
                "seqino_mandate_id",
                "seqino_onboarding_url",
                "seqino_onboarding_expires_at",
                "seqino_onboarding_status",
            ):
                credentials.pop(key, None)
            connection.encrypted_credentials = encrypt_payload(credentials)
            connection.status = "disconnected"
            connection.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.add(connection)
        account = (
            db.query(PdpAccount).filter(PdpAccount.tenant_id == user.tenant_id, PdpAccount.provider == "seqino").first()
        )
        if account:
            account.provider_client_id = None
            account.status = "DELETED"
            db.add(account)
        log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action_type="seqino_client_deleted",
            object_type="pdp_client",
            object_id=client_id,
            metadata={"provider": "seqino"},
        )
        db.commit()
        return {"ok": True, "client_id": client_id}

    @router.post("/seqino/mandates/default")
    async def seqino_create_default_mandate(
        payload: SeqinoDefaultMandateRequest,
        request: Request,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_product_feature("seqino_enabled")),
        __: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        if not payload.accept_mandate:
            raise _error(
                400,
                "seqino_mandate_consent_required",
                "Confirmez explicitement l'activation du mandat Seqino avant de continuer.",
            )
        tenant = db.get(Tenant, user.tenant_id)
        if not tenant:
            raise _error(404, "tenant_missing", "Entreprise introuvable.")
        entry_payload = _tenant_default_directory_entry(tenant)
        _record_seqino_mandate_consent(
            db,
            user=user,
            request=request,
            object_id=user.tenant_id,
            scope="default_mandate",
        )

        from ..utils.crypto import decrypt_payload, encrypt_payload

        conn = _seqino_connection(db, user.tenant_id)
        creds = decrypt_payload(conn.encrypted_credentials) if conn and conn.encrypted_credentials else {}
        account = (
            db.query(PdpAccount)
            .filter(PdpAccount.tenant_id == user.tenant_id, PdpAccount.provider == "seqino")
            .order_by(PdpAccount.updated_at.desc())
            .first()
        )
        account_metadata = get_pdp_account_metadata(account)
        access_token, sponsor_id = resolve_seqino_credentials(db, user.tenant_id)
        if not access_token and not _seqino_demo_mode():
            raise _error(400, "seqino_token_missing", "Token plateforme partenaire manquant pour les mandats.")
        if _seqino_demo_mode():
            access_token = access_token or "demo"
            sponsor_id = sponsor_id or "demo"
        if not access_token:
            raise _error(400, "seqino_token_missing", "Token plateforme partenaire manquant pour les mandats.")

        existing_client_id = creds.get("client_id") or creds.get("seqino_client_id")
        if not existing_client_id and account:
            existing_client_id = account.provider_client_id or account_metadata.get("provider_account_id")
        if existing_client_id and not conn:
            conn = PdpConnection(
                tenant_id=user.tenant_id,
                provider_slug="seqino",
                auth_type="api_key",
                status="pending",
            )
            db.add(conn)
        if existing_client_id:
            try:
                _mandates, active_count = await _sync_seqino_mandates_from_remote(
                    db,
                    user.tenant_id,
                    demote_when_missing=False,
                )
                db.commit()
                if active_count > 0:
                    if conn:
                        creds["client_id"] = str(existing_client_id)
                        creds["seqino_client_id"] = str(existing_client_id)
                        conn.encrypted_credentials = encrypt_payload(creds)
                        conn.status = "connected"
                        conn.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                        db.add(conn)
                        db.commit()
                    return {
                        "ok": True,
                        "connected": True,
                        "client_id": existing_client_id,
                        "mandate_active_count": active_count,
                        "status": "ACTIVE",
                        "onboarding_url": None,
                    }
            except (ValueError, PdpProviderError):
                db.rollback()

        existing_mandate = (
            db.query(PdpMandate)
            .filter(
                PdpMandate.tenant_id == user.tenant_id,
                PdpMandate.provider_slug == "seqino",
                PdpMandate.siren == entry_payload["siren"],
            )
            .order_by(PdpMandate.updated_at.desc())
            .first()
        )
        pending_statuses = {"PENDING", "PENDING_KYB", "CREATED", "IN_PROGRESS", "CASE_CREATED"}
        if (
            existing_client_id
            and existing_mandate
            and str(existing_mandate.status or "").strip().upper() in pending_statuses
        ):
            try:
                link_result = await create_onboarding_link(
                    tenant=tenant,
                    access_token=access_token,
                    client_id=str(existing_client_id),
                    mandate_id=existing_mandate.mandate_id,
                    sponsor_id=sponsor_id,
                )
            except ValueError as exc:
                raise _error(400, "seqino_onboarding_invalid", str(exc))
            except PdpProviderError as exc:
                status_code = _provider_error_status(exc)
                raise _error(status_code, exc.code or "seqino_onboarding_failed", str(exc))
            active_count = _apply_seqino_connection_status(db, user.tenant_id)
            creds["client_id"] = str(existing_client_id)
            creds["seqino_client_id"] = str(existing_client_id)
            creds["seqino_mandate_id"] = existing_mandate.mandate_id
            creds["seqino_onboarding_link_id"] = link_result["link_id"]
            creds["seqino_onboarding_url"] = link_result["onboarding_url"]
            if link_result.get("expires_at"):
                creds["seqino_onboarding_expires_at"] = link_result["expires_at"]
            if conn:
                conn.encrypted_credentials = encrypt_payload(creds)
                conn.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                db.add(conn)
            db.commit()
            return {
                "ok": True,
                "connected": active_count > 0,
                "client_id": existing_client_id,
                "mandate_id": existing_mandate.mandate_id,
                "mandate_active_count": active_count,
                "status": existing_mandate.status or "PENDING",
                "reused": True,
                "onboarding_url": link_result["onboarding_url"],
                "expires_at": link_result.get("expires_at"),
            }

        try:
            client_result = await get_or_create_client(
                tenant,
                access_token=access_token,
                contact_email=user.email,
                sponsor_id=sponsor_id,
                existing_client_id=existing_client_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_client_invalid", str(exc))
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "seqino_client_failed", str(exc))
        except Exception:
            raise _error(502, "seqino_client_failed", "Erreur lors de la preparation du client PDP.")

        client_id = str(client_result.get("client_id") or "").strip()
        if not client_id:
            raise _error(400, "seqino_client_missing", "client_id plateforme partenaire manquant.")

        for key in ("access_token", "token", "api_key", "authorization", "sponsor_id", "pdp_sponsor_id"):
            creds.pop(key, None)
        creds["client_id"] = client_id
        creds["seqino_client_id"] = client_id
        creds.setdefault("seqino_onboarding_status", "MANDATE_PENDING")

        if not conn:
            conn = PdpConnection(
                tenant_id=user.tenant_id,
                provider_slug="seqino",
                auth_type="api_key",
            )
        conn.auth_type = conn.auth_type or "api_key"
        conn.encrypted_credentials = encrypt_payload(creds)
        conn.status = "pending"
        conn.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(conn)
        db.flush()

        utc_today = datetime.now(timezone.utc).date()
        start_dt = datetime(utc_today.year, utc_today.month, utc_today.day, tzinfo=timezone.utc)
        mandate_payload: dict[str, Any] = {
            "directory_entry": entry_payload,
            "start_date": start_dt.isoformat(),
        }

        try:
            result = await seqino_mandates.create_mandate(
                mandate_payload,
                access_token=access_token,
                client_id=client_id,
                sponsor_id=sponsor_id,
                tenant_id=user.tenant_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_mandate_invalid", str(exc))
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "seqino_mandate_failed", str(exc))
        except Exception:
            raise _error(502, "seqino_mandate_failed", "Erreur lors de la creation du mandat PDP.")

        raw_payload = result.get("payload") if isinstance(result, dict) else None
        merged_payload = dict(mandate_payload)
        if isinstance(raw_payload, dict):
            merged_payload.update(raw_payload)
            if isinstance(mandate_payload.get("directory_entry"), dict) and isinstance(
                raw_payload.get("directory_entry"), dict
            ):
                merged_payload["directory_entry"] = {
                    **mandate_payload["directory_entry"],
                    **raw_payload["directory_entry"],
                }
        normalized = seqino_mandates.normalize_mandate_item(merged_payload)
        if not normalized.get("mandate_id"):
            normalized["mandate_id"] = result.get("mandate_id")
        mandate = _upsert_pdp_mandate(db, user.tenant_id, normalized)
        if not mandate:
            raise _error(400, "seqino_mandate_invalid", "mandate_id manquant pour le mandat PDP.")

        active_count = _apply_seqino_connection_status(db, user.tenant_id, conn=conn)
        try:
            _remote_mandates, remote_active_count = await _sync_seqino_mandates_from_remote(
                db,
                user.tenant_id,
                demote_when_missing=False,
            )
            active_count = max(active_count, remote_active_count, _seqino_active_mandate_count(db, user.tenant_id))
            _apply_seqino_connection_status(db, user.tenant_id, conn=conn, active_count=active_count)
        except (ValueError, PdpProviderError):
            active_count = max(active_count, _seqino_active_mandate_count(db, user.tenant_id))

        creds["seqino_mandate_id"] = mandate.mandate_id
        if active_count > 0:
            creds["seqino_onboarding_status"] = "ACTIVE"
        conn.encrypted_credentials = encrypt_payload(creds)
        db.add(conn)
        db.commit()
        db.refresh(mandate)
        db.refresh(conn)
        return {
            "ok": True,
            "connected": (conn.status or "").lower() == "connected",
            "client_id": client_id,
            "mandate_id": mandate.mandate_id,
            "mandate_active_count": active_count,
            "status": mandate.status or ("ACTIVE" if active_count > 0 else "PENDING"),
            "onboarding_url": None,
        }

    @router.get("/seqino/mandates", response_model=list[SeqinoMandateOut])
    async def seqino_list_mandates(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_product_feature("seqino_enabled")),
        __: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        try:
            access_token, sponsor_id, client_id = _seqino_credentials(db, user.tenant_id)
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            code = str(detail.get("code") or "").strip().lower()
            if code in {"seqino_connection_missing", "seqino_client_missing"}:
                return []
            raise
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        try:
            items = await seqino_mandates.list_mandates(
                access_token=access_token,
                client_id=client_id,
                sponsor_id=sponsor_id,
                tenant_id=user.tenant_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_mandate_invalid", str(exc))
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "seqino_mandate_failed", str(exc))
        except Exception:
            raise _error(502, "seqino_mandate_failed", "Erreur lors de la recuperation des mandats PDP.")

        mandates: list[PdpMandate] = []
        remote_active_count = 0
        for item in items:
            normalized = seqino_mandates.normalize_mandate_item(item)
            if _is_active_mandate_status(normalized.get("status")):
                remote_active_count += 1
            mandate = _upsert_pdp_mandate(db, user.tenant_id, normalized)
            if mandate:
                mandates.append(mandate)

        _apply_seqino_connection_status(
            db,
            user.tenant_id,
            active_count=remote_active_count,
            demote_when_missing=True,
        )
        db.commit()
        for mandate in mandates:
            db.refresh(mandate)
        return mandates

    @router.post("/seqino/mandates", response_model=SeqinoMandateOut)
    async def seqino_create_mandate(
        payload: SeqinoMandateCreate,
        request: Request,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_product_feature("seqino_enabled")),
        __: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        if not payload.accept_mandate:
            raise _error(
                400,
                "seqino_mandate_consent_required",
                "Confirmez explicitement l'activation du mandat Seqino avant de continuer.",
            )
        _record_seqino_mandate_consent(
            db,
            user=user,
            request=request,
            object_id=user.tenant_id,
            scope="custom_mandate",
        )
        access_token, sponsor_id, client_id = _seqino_credentials(db, user.tenant_id)
        entry_payload: dict[str, Any] = {
            "siren": payload.siren,
            "name": payload.name,
        }
        if payload.siret:
            entry_payload["siret"] = payload.siret
        elif payload.suffix:
            entry_payload["suffix"] = payload.suffix
        if payload.routing_identifier:
            entry_payload["routing_identifier"] = payload.routing_identifier
        mandate_payload: dict[str, Any] = {"directory_entry": entry_payload}
        start_dt = payload.start_date
        if start_dt is None:
            utc_today = datetime.now(timezone.utc).date()
            start_dt = datetime(utc_today.year, utc_today.month, utc_today.day, tzinfo=timezone.utc)
        elif isinstance(start_dt, date) and not isinstance(start_dt, datetime):
            start_dt = datetime(start_dt.year, start_dt.month, start_dt.day, tzinfo=timezone.utc)
        elif start_dt.tzinfo is None:
            start_dt = start_dt.replace(tzinfo=timezone.utc)
        else:
            start_dt = start_dt.astimezone(timezone.utc)
        mandate_payload["start_date"] = start_dt.isoformat()

        try:
            result = await seqino_mandates.create_mandate(
                mandate_payload,
                access_token=access_token,
                client_id=client_id,
                sponsor_id=sponsor_id,
                tenant_id=user.tenant_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_mandate_invalid", str(exc))
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "seqino_mandate_failed", str(exc))
        except Exception:
            raise _error(502, "seqino_mandate_failed", "Erreur lors de la creation du mandat PDP.")

        raw_payload = result.get("payload") if isinstance(result, dict) else None
        merged_payload = dict(mandate_payload)
        if isinstance(raw_payload, dict):
            merged_payload.update(raw_payload)
            if isinstance(mandate_payload.get("directory_entry"), dict) and isinstance(
                raw_payload.get("directory_entry"), dict
            ):
                merged_payload["directory_entry"] = {
                    **mandate_payload["directory_entry"],
                    **raw_payload["directory_entry"],
                }
        normalized = seqino_mandates.normalize_mandate_item(merged_payload)
        if not normalized.get("mandate_id"):
            normalized["mandate_id"] = result.get("mandate_id")

        mandate = _upsert_pdp_mandate(db, user.tenant_id, normalized)
        if not mandate:
            raise _error(400, "seqino_mandate_invalid", "mandate_id manquant pour le mandat PDP.")
        _apply_seqino_connection_status(db, user.tenant_id)
        db.commit()
        db.refresh(mandate)
        return mandate

    @router.delete("/seqino/mandates/{mandate_id}")
    async def seqino_delete_mandate(
        mandate_id: str,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
        _: AuthUser = Depends(require_product_feature("seqino_enabled")),
        __: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        mandate = (
            db.query(PdpMandate)
            .filter(PdpMandate.tenant_id == user.tenant_id, PdpMandate.mandate_id == mandate_id)
            .first()
        )
        if not mandate:
            raise _error(404, "seqino_mandate_missing", "Mandat Seqino introuvable pour cette entreprise.")
        access_token, sponsor_id, client_id = _seqino_credentials(db, user.tenant_id)
        try:
            await seqino_mandates.delete_mandate(
                mandate_id,
                access_token=access_token,
                client_id=client_id,
                sponsor_id=sponsor_id,
                tenant_id=user.tenant_id,
            )
        except ValueError as exc:
            raise _error(400, "seqino_mandate_invalid", str(exc))
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "seqino_mandate_failed", str(exc))
        except Exception:
            raise _error(502, "seqino_mandate_failed", "Erreur lors de la suppression du mandat PDP.")

        (
            db.query(PdpMandate)
            .filter(PdpMandate.tenant_id == user.tenant_id, PdpMandate.mandate_id == mandate_id)
            .delete(synchronize_session=False)
        )
        _apply_seqino_connection_status(db, user.tenant_id, demote_when_missing=True)
        log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action_type="seqino_mandate_revoked",
            object_type="pdp_mandate",
            object_id=mandate_id,
            metadata={"provider": "seqino"},
        )
        db.commit()
        return {"ok": True, "mandate_id": mandate_id}

    @router.get("/seqino/capabilities")
    def seqino_capabilities(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        if _seqino_demo_mode():
            return {"mandates_enabled": True, "missing": []}
        missing: list[str] = []
        access_token, sponsor_id = resolve_seqino_credentials(db, user.tenant_id)
        if not access_token:
            missing.append("Accès à la plateforme")
        if not sponsor_id:
            missing.append("Identifiant sponsor")
        mandates_enabled = bool(access_token and sponsor_id)
        return {"mandates_enabled": mandates_enabled, "missing": missing}

    @router.get("/seqino/preflight")
    async def seqino_preflight(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        ensure_connected_mode_operational(db, user.tenant_id, "seqino")
        if _seqino_demo_mode():
            mandate_active = seqino_has_active_mandate(user.tenant_id, db=db)
            return {
                "ok": True,
                "missing": [],
                "status": "demo",
                "mandate_active": mandate_active,
            }
        access_token, sponsor_id = resolve_seqino_credentials(db, user.tenant_id)
        missing = []
        if not _has_value(settings.SEQINO_BASE_URL):
            missing.append("Adresse du service")
        if not access_token:
            missing.append("Accès à la plateforme")
        if not sponsor_id:
            missing.append("Identifiant sponsor")
        if missing:
            return {
                "ok": False,
                "missing": missing,
                "status": "missing_config",
                "mandate_active": _seqino_active_mandate_count(db, user.tenant_id) > 0,
            }
        try:
            _mandates, active_count = await _sync_seqino_mandates_from_remote(
                db,
                user.tenant_id,
                demote_when_missing=True,
            )
            db.commit()
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            code = str(detail.get("code") or "seqino_preflight_failed")
            message = sanitize_public_error_message(
                detail.get("message"),
                status_code=400,
                fallback="La vérification de la plateforme agréée a échoué.",
            )
            return {
                "ok": False,
                "missing": missing,
                "status": code,
                "mandate_active": False,
                "message": message,
                "hint": _export_hint_for_code(code),
            }
        except (ValueError, PdpProviderError) as exc:
            code = getattr(exc, "code", None) or "seqino_preflight_failed"
            return {
                "ok": False,
                "missing": missing,
                "status": code,
                "mandate_active": False,
                "message": sanitize_public_error_message(
                    exc,
                    status_code=400,
                    fallback="La vérification de la plateforme agréée a échoué.",
                ),
                "hint": _export_hint_for_code(code),
            }
        except Exception:
            return {
                "ok": False,
                "missing": missing,
                "status": "seqino_preflight_failed",
                "mandate_active": False,
                "message": "Synchronisation des mandats de plateforme agréée indisponible.",
                "hint": _export_hint_for_code("seqino_preflight_failed"),
            }
        mandate_active = active_count > 0
        try:
            client = SeqinoClient.from_credentials(
                access_token=access_token or "",
                sponsor_id=sponsor_id,
            )
        except ValueError:
            return {
                "ok": False,
                "missing": missing,
                "status": "missing_config",
                "mandate_active": mandate_active,
            }
        ping = await client.ping(tenant_id=user.tenant_id)
        if not bool(ping.get("ok")):
            status = ping.get("code") or "seqino_not_ready"
            return {
                "ok": False,
                "missing": missing,
                "status": status,
                "mandate_active": mandate_active,
                "message": sanitize_public_error_message(
                    ping.get("error"),
                    status_code=400,
                    fallback="La vérification de la plateforme agréée a échoué.",
                ),
                "hint": _export_hint_for_code(status),
            }
        if not mandate_active:
            return {
                "ok": False,
                "missing": missing,
                "status": "seqino_mandate_missing",
                "mandate_active": False,
                "message": "Mandat de plateforme agréée requis pour activer la connexion.",
                "hint": _export_hint_for_code("seqino_mandate_missing"),
            }
        return {
            "ok": True,
            "missing": missing,
            "status": "ready",
            "mandate_active": True,
        }

    @router.delete("/connections")
    def delete_connection(
        provider_slug: str | None = Query(default=None),
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        connector_slug = _normalize_connector(provider_slug)
        if not connector_slug:
            raise _error(400, "provider_slug_required", "Sélectionnez une plateforme agréée.")
        ensure_connected_mode_operational(db, user.tenant_id, connector_slug)
        conn = (
            db.query(PdpConnection)
            .filter(PdpConnection.tenant_id == user.tenant_id, PdpConnection.provider_slug == connector_slug)
            .first()
        )
        if not conn:
            raise _error(404, "connection_missing", "Connexion plateforme introuvable.")
        if connector_slug == "choruspro":
            upsert_integration_secret(
                db,
                tenant_id=user.tenant_id,
                secret_key=CHORUS_CPRO_ACCOUNT_KEY,
                secret_value=None,
            )
        db.delete(conn)
        db.commit()
        return {"ok": True}

    @router.get("/endpoints", response_model=list[RecipientDirectoryEntryOut])
    def list_endpoints(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_viewer_or_admin),
    ):
        return (
            db.query(RecipientDirectoryEntry)
            .filter(RecipientDirectoryEntry.tenant_id == user.tenant_id)
            .order_by(RecipientDirectoryEntry.updated_at.desc())
            .all()
        )

    @router.post("/endpoints", response_model=RecipientDirectoryEntryOut)
    def create_endpoint(
        payload: RecipientDirectoryEntryCreate,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        ensure_connected_mode_operational(db, user.tenant_id)
        siren = payload.siren.replace(" ", "") if payload.siren else ""
        siret = payload.siret.replace(" ", "") if payload.siret else None
        endpoint = RecipientDirectoryEntry(
            tenant_id=user.tenant_id,
            siren=siren,
            siret=siret,
            platform_slug=payload.platform_slug.strip(),
            billing_address=payload.billing_address.strip(),
            routing_code=(payload.routing_code or "").strip() or None,
            routing_identifier=(payload.routing_identifier or "").strip() or None,
            platform_attached=payload.platform_attached,
            billing_address_active=payload.billing_address_active,
            service_code_required=payload.service_code_required,
            commitment_required=payload.commitment_required,
            public_entity=payload.public_entity,
            source="manual",
            created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            updated_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(endpoint)
        db.commit()
        db.refresh(endpoint)
        return endpoint

    @router.patch("/endpoints/{endpoint_id}", response_model=RecipientDirectoryEntryOut)
    def update_endpoint(
        endpoint_id: str,
        payload: RecipientDirectoryEntryUpdate,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        ensure_connected_mode_operational(db, user.tenant_id)
        endpoint = db.get(RecipientDirectoryEntry, endpoint_id)
        if not endpoint or endpoint.tenant_id != user.tenant_id:
            raise _error(404, "endpoint_missing", "Endpoint introuvable")

        updates = payload.model_dump(exclude_unset=True)
        if "siren" in updates and updates["siren"] is not None:
            updates["siren"] = updates["siren"].replace(" ", "")
        if "siret" in updates and updates["siret"] is not None:
            updates["siret"] = updates["siret"].replace(" ", "")
        for key, value in updates.items():
            setattr(endpoint, key, value)
        endpoint.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)

        db.add(endpoint)
        db.commit()
        db.refresh(endpoint)
        return endpoint

    @router.delete("/endpoints/{endpoint_id}")
    def delete_endpoint(
        endpoint_id: str,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ):
        ensure_connected_mode_operational(db, user.tenant_id)
        endpoint = db.get(RecipientDirectoryEntry, endpoint_id)
        if not endpoint or endpoint.tenant_id != user.tenant_id:
            raise _error(404, "endpoint_missing", "Endpoint introuvable")
        db.delete(endpoint)
        db.commit()
        return {"ok": True}

    @router.get("/transmissions", response_model=list[EInvoicingTransmissionListItem])
    def list_transmissions_overview(
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_viewer_or_admin),
    ):
        rows = _transmission_overview_rows(db, user.tenant_id, limit=100)
        items: list[EInvoicingTransmissionListItem] = []
        for tx, inv in rows:
            items.append(
                EInvoicingTransmissionListItem(
                    id=tx.id,
                    invoice_id=tx.invoice_id,
                    invoice_number=inv.number,
                    invoice_issue_date=inv.issue_date,
                    channel=tx.channel,
                    status=tx.status,
                    delivery_state=tx.delivery_state,
                    attempt_count=tx.attempt_count,
                    external_id=tx.external_id,
                    updated_at=tx.updated_at,
                    message=_transmission_message(tx),
                )
            )
        return items

    @router.get("/transmissions/export.csv")
    def export_transmissions_csv(
        status: str = Query(default="all"),
        search: str = Query(default=""),
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_viewer_or_admin),
    ):
        normalized_status = (status or "all").strip().lower()
        query = (search or "").strip().lower()
        rows = _transmission_overview_rows(db, user.tenant_id, limit=1000)

        output = io.StringIO()
        writer = csv.writer(output, delimiter=";")
        writer.writerow(["Facture", "Date", "Canal", "Statut", "Mis à jour", "ID externe", "Message"])

        exported_count = 0
        for tx, inv in rows:
            status_value = (tx.status or "").strip().lower()
            status_group = _transmission_status_group(status_value)
            if normalized_status not in {"", "all"} and normalized_status not in {status_value, status_group}:
                continue

            channel_label = _transmission_channel_label(tx.channel)
            message = _transmission_message(tx) or ""
            haystack = " ".join(
                [
                    str(inv.number or ""),
                    str(tx.invoice_id or ""),
                    str(tx.channel or ""),
                    channel_label,
                    status_value,
                    status_group,
                    str(tx.external_id or ""),
                    message,
                ]
            ).lower()
            if query and query not in haystack:
                continue

            writer.writerow(
                [
                    _sanitize_csv_cell(inv.number or tx.invoice_id),
                    inv.issue_date.isoformat() if inv.issue_date else "",
                    _sanitize_csv_cell(channel_label),
                    _sanitize_csv_cell(status_value),
                    (tx.updated_at or tx.created_at).isoformat() if tx.updated_at or tx.created_at else "",
                    _sanitize_csv_cell(tx.external_id),
                    _sanitize_csv_cell(message),
                ]
            )
            exported_count += 1

        log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action_type="export_csv",
            object_type="einvoicing_transmissions",
            object_id=user.tenant_id,
            metadata={"format": "csv", "rows": exported_count, "status": normalized_status, "search": search},
            commit=True,
        )
        filename = f"transmissions-{date.today().isoformat()}.csv"
        return Response(
            content=output.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @router.get("/transmissions/{invoice_id}", response_model=list[EInvoicingTransmissionOut])
    def list_transmissions(
        invoice_id: str,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_viewer_or_admin),
    ):
        inv = db.get(Invoice, invoice_id)
        if not inv or inv.tenant_id != user.tenant_id:
            raise _error(404, "invoice_missing", "Facture introuvable")
        return (
            db.query(EInvoicingTransmission)
            .filter(EInvoicingTransmission.invoice_id == inv.id)
            .order_by(EInvoicingTransmission.created_at.desc())
            .all()
        )

    @router.post("/transmissions/{transmission_id}/reconcile", response_model=EInvoicingTransmissionOut)
    async def reconcile_transmission(
        transmission_id: str,
        payload: EInvoicingReconcileRequest,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_accountant_or_admin),
        _: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        tx = (
            db.query(EInvoicingTransmission)
            .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
            .filter(
                EInvoicingTransmission.id == transmission_id,
                Invoice.tenant_id == user.tenant_id,
            )
            .first()
        )
        if not tx:
            raise _error(404, "transmission_missing", "Transmission introuvable.")
        connector_slug = _normalize_connector(tx.channel)
        ensure_connected_mode_operational(db, user.tenant_id, connector_slug)
        if (tx.delivery_state or "").strip().lower() != "reconciliation_required":
            raise _error(
                409,
                "reconciliation_not_required",
                "Cette transmission ne nécessite pas de réconciliation.",
            )
        external_id = (payload.external_id or "").strip()
        if not external_id:
            raise _error(400, "external_id_required", "Numéro de flux Chorus requis.")
        if connector_slug in {"chorus", "choruspro"}:
            connector_slug = "choruspro"
            creds = enrich_credentials_with_secrets(db, user.tenant_id, {"_tenant_id": user.tenant_id})
        else:
            conn, creds = _resolve_connection(db, user.tenant_id, connector_slug)
            if not conn and connector_slug != "dummy":
                raise _error(400, "connection_missing", "Connexion plateforme manquante.")
        try:
            connector_impl = get_provider(connector_slug, creds)
            status_result = await connector_impl.poll_transmission_status(external_id)
        except PdpProviderError as exc:
            raise _error(_provider_error_status(exc), exc.code or "reconciliation_failed", str(exc))
        except Exception:
            raise _error(502, "reconciliation_failed", "Impossible de réconcilier le flux pour le moment.")

        tx.external_id = external_id
        tx.delivery_state = "delivered"
        tx.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        update_transmission_status(
            db,
            tx=tx,
            tenant_id=user.tenant_id,
            status_result=status_result,
            source="platforms_reconcile",
            actor_user_id=user.id,
        )
        log_action(
            db,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action_type="pdp_reconcile",
            object_type="invoice",
            object_id=tx.invoice_id,
            metadata={
                "channel": tx.channel,
                "transmission_id": tx.id,
                "external_id": tx.external_id,
                "status": tx.status,
            },
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        return tx

    @router.post("/submit/{invoice_id}", response_model=EInvoicingTransmissionOut)
    async def submit_platform(
        invoice_id: str,
        payload: EInvoicingSubmitRequest | None = None,
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_accountant_or_admin),
        _: AuthUser = Depends(require_paid_subscription),
    ):
        requested_connector = _normalize_connector(payload.connector if payload else None)
        if requested_connector == "dummy" and _is_prod_like() and not settings.ALLOW_DUMMY_IN_PROD:
            raise _error(403, "dummy_forbidden", "Connecteur dummy interdit en prod/staging.")
        if settings.EINVOICING_EXPORT_ONLY:
            ensure_connected_mode_operational(db, user.tenant_id, requested_connector)
        if requested_connector == "choruspro" and not _chorus_server_bootstrap_ready():
            raise _error(
                409,
                "connected_mode_not_operational",
                "Le mode connecté n'est pas opérationnel pour ce fournisseur.",
            )
        inv = db.get(Invoice, invoice_id)
        if not inv or inv.tenant_id != user.tenant_id:
            raise _error(404, "invoice_missing", "Facture introuvable")
        customer = db.get(Customer, inv.customer_id) if inv.customer_id else None
        if inv.status not in {"issued", "sent", "paid", "overdue", "partial"}:
            raise _error(400, "invoice_not_issued", "La facture doit etre emise avant soumission.")
        if not inv.pdf_key or not inv.xml_key:
            raise _error(
                400,
                "invoice_artifacts_missing",
                "Artefacts d'emission manquants. Emettez la facture d'abord.",
            )

        connector_slug = requested_connector
        if not connector_slug:
            if _is_public_invoice_recipient(inv, customer):
                connector_slug = "choruspro"
            else:
                ensure_connected_mode_operational(db, user.tenant_id, "seqino")
                _apply_seqino_connection_status(db, inv.tenant_id)
                conn = (
                    db.query(PdpConnection)
                    .filter(
                        PdpConnection.tenant_id == inv.tenant_id,
                        PdpConnection.status == "connected",
                        PdpConnection.provider_slug != "dummy",
                    )
                    .order_by(PdpConnection.updated_at.desc())
                    .first()
                )
                if not conn:
                    conn = (
                        db.query(PdpConnection)
                        .filter(
                            PdpConnection.tenant_id == inv.tenant_id,
                            PdpConnection.provider_slug != "dummy",
                        )
                        .order_by(PdpConnection.updated_at.desc())
                        .first()
                    )
                    if not conn:
                        raise _error(
                            409,
                            "missing_pdp_connection",
                            "Connectez une plateforme agréée ou utilisez le mode export.",
                        )
                connector_slug = conn.provider_slug
        if connector_slug in {"chorus", "choruspro"}:
            if not _is_public_invoice_recipient(inv, customer):
                raise _error(
                    400,
                    "connector_customer_mismatch",
                    "Le canal public est réservé aux clients publics.",
                )
            connector_slug = "choruspro"

        ensure_connected_mode_operational(db, user.tenant_id, connector_slug)

        if connector_slug == "dummy" and _is_prod_like() and not settings.ALLOW_DUMMY_IN_PROD:
            raise _error(403, "dummy_forbidden", "Connecteur dummy interdit en prod/staging.")

        if connector_slug == "choruspro":
            _validate_chorus_public_requirements(db, inv.tenant_id, customer, inv)
            creds = enrich_credentials_with_secrets(db, inv.tenant_id, {"_tenant_id": inv.tenant_id})
        else:
            conn, creds = _resolve_connection(db, inv.tenant_id, connector_slug)
            if not conn and connector_slug != "dummy":
                if connector_slug == "seqino":
                    raise _error(409, "seqino_connection_missing", "Connexion plateforme partenaire manquante.")
                raise _error(400, "connection_missing", "Connexion plateforme manquante.")

        try:
            connector = get_provider(connector_slug, creds)
        except Exception:
            raise _error(400, "connector_unknown", "Connector plateforme inconnu.")
        missing_config_fn = getattr(connector, "missing_server_config", None)
        missing_config = missing_config_fn() if callable(missing_config_fn) else []
        if missing_config:
            raise _error(
                409,
                "connector_config_missing",
                "La connexion à la plateforme agréée n’est pas complètement configurée. Contactez l’assistance.",
            )
        ctx = _ctx(db, inv)

        validate_required = connector.requires_sanity_checks
        if payload and payload.validate_sanity_checks is not None:
            validate_required = bool(payload.validate_sanity_checks)
        if validate_required:
            errs = validate_invoice_ctx(ctx)
            if errs:
                raise HTTPException(
                    400,
                    {
                        "code": "sanity_checks_failed",
                        "message": "Le document contient des informations a corriger avant transmission.",
                        "errors": errs,
                    },
                )

        force_retry = bool(payload.force_retry) if payload else False
        if connector_slug == "choruspro" and force_retry:
            raise _error(
                409,
                "chorus_force_retry_forbidden",
                "Une facture Chorus ne peut pas être redéposée de force. Réconciliez le dépôt existant.",
            )
        try:
            tx = await submit_einvoice(
                db,
                provider=connector,
                invoice=inv,
                tenant_id=inv.tenant_id,
                channel=connector_slug,
                ctx=ctx,
                poll_status=True,
                raise_on_error=True,
                source="platforms_submit",
                force_retry=force_retry,
                actor_user_id=user.id,
            )
        except UsageQuotaExceeded:
            raise
        except FacturxValidationError as exc:
            raise HTTPException(
                422,
                {
                    "code": exc.code,
                    "message": str(exc),
                    "issues": getattr(exc, "issues", []),
                    "doc_url": getattr(exc, "issues", [{}])[0].get("doc_url") if getattr(exc, "issues", None) else None,
                },
            )
        except ValueError as exc:
            message = str(exc) or "Soumission invalide."
            raise _error(400, "submission_invalid", message)
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            extra: dict[str, Any] = {}
            provider_code = (exc.code or "").strip().lower()
            if provider_code == "seqino_mandate_missing":
                extra["remediation_url"] = "/app/setup/einvoicing"
            if provider_code in {"token_balance_insufficient", "trial_seqino_transmissions_disabled"}:
                extra["remediation_url"] = "/app/billing"
            raise _error(status_code, exc.code or "submission_failed", str(exc), **extra)
        except Exception:
            raise _error(502, "submission_failed", "Erreur lors de la soumission plateforme.")
        _record_submission(db, inv, tx.channel, tx)
        _mark_invoice_sent_after_submission(db, inv, tx, user)
        return tx

    @router.get("/status/{submission_id}")
    async def get_status(
        submission_id: str,
        connector: str | None = Query(default=None),
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_viewer_or_admin),
        _: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        return await get_status_impl(submission_id, connector, db, user)

    @router.get("/events/{submission_id}")
    async def list_events(
        submission_id: str,
        connector: str | None = Query(default=None),
        db: Session = Depends(get_db),
        user: AuthUser = Depends(require_viewer_or_admin),
        _: AuthUser = Depends(require_paid_subscription_or_trial),
    ):
        connector_slug = _normalize_connector(connector)
        tx = _get_transmission_for_external_id(
            db,
            user.tenant_id,
            submission_id,
            requested_connector=connector_slug,
        )
        connector_slug = _normalize_connector(tx.channel)

        db_events = (
            db.query(TransmissionEvent)
            .filter(TransmissionEvent.transmission_id == tx.id)
            .order_by(TransmissionEvent.occurred_at.asc(), TransmissionEvent.created_at.asc())
            .all()
        )
        if db_events:
            return {
                "events": [TransmissionEventOut.model_validate(ev).model_dump() for ev in db_events],
                "connector": connector_slug,
            }
        if tx.events:
            legacy_events = []
            for idx, ev in enumerate(tx.events or []):
                legacy_events.append(
                    {
                        "id": f"legacy-{tx.id}-{idx}",
                        "event_type": ev.get("event_type") or "status_update",
                        "status_code_norme": ev.get("status") or "unknown",
                        "payload_raw": {
                            "message": ev.get("message"),
                            "raw_status": ev.get("raw_status"),
                            "errors": ev.get("errors"),
                            "source": ev.get("source"),
                        },
                        "occurred_at": ev.get("occurred_at") or ev.get("at"),
                    }
                )
            return {"events": legacy_events, "connector": connector_slug}

        ensure_connected_mode_operational(db, user.tenant_id, connector_slug)
        if connector_slug == "seqino" and not seqino_has_active_mandate(user.tenant_id, db=db):
            raise _error(
                409,
                "seqino_mandate_missing",
                "Mandat de plateforme agréée actif requis pour consulter les événements.",
            )

        if connector_slug in {"chorus", "choruspro"}:
            connector_slug = "choruspro"
            creds = enrich_credentials_with_secrets(db, user.tenant_id, {"_tenant_id": user.tenant_id})
        else:
            conn, creds = _resolve_connection(db, user.tenant_id, connector_slug)
            if not conn and connector_slug != "dummy":
                raise _error(400, "connection_missing", "Connexion plateforme manquante.")

        try:
            connector_impl = get_provider(connector_slug, creds)
        except Exception:
            raise _error(400, "connector_unknown", "Connector plateforme inconnu.")

        try:
            status_result = await connector_impl.poll_transmission_status(submission_id)
        except PdpProviderError as exc:
            status_code = _provider_error_status(exc)
            raise _error(status_code, exc.code or "status_failed", str(exc))
        update_transmission_status(
            db,
            tx=tx,
            tenant_id=user.tenant_id,
            status_result=status_result,
            source="platforms_status",
            actor_user_id=user.id,
        )
        db.add(tx)
        db.commit()
        db_events = (
            db.query(TransmissionEvent)
            .filter(TransmissionEvent.transmission_id == tx.id)
            .order_by(TransmissionEvent.occurred_at.asc(), TransmissionEvent.created_at.asc())
            .all()
        )
        if db_events:
            return {
                "events": [TransmissionEventOut.model_validate(ev).model_dump() for ev in db_events],
                "connector": connector_slug,
            }

        events = _append_event([], status_result.status, "Statut synchronise")
        fallback = []
        for idx, ev in enumerate(events):
            fallback.append(
                {
                    "id": f"ephemeral-{submission_id}-{idx}",
                    "event_type": ev.get("event_type") or "status_update",
                    "status_code_norme": ev.get("status") or "unknown",
                    "payload_raw": {"message": ev.get("message")},
                    "occurred_at": ev.get("occurred_at") or ev.get("at"),
                }
            )
        return {"events": fallback, "connector": connector_slug}

    return router


admin_router = APIRouter(tags=["platforms-admin"])


def _admin_chorus_tenant(db: Session, tenant_id: str, *, require_active_pro: bool = True) -> Tenant:
    tenant = db.get(Tenant, tenant_id)
    if not tenant or tenant.deleted_at is not None:
        raise _error(404, "tenant_not_found", "Entreprise introuvable.")
    if not require_active_pro:
        return tenant
    if normalize_plan(tenant.plan) not in {Plan.PRO, Plan.ENTERPRISE}:
        raise _error(
            403,
            "plan_upgrade_required",
            "Le plan Pro est requis pour configurer Chorus Pro.",
            required_plan=Plan.PRO.value,
        )
    if (tenant.subscription_status or "").strip().lower() != "active":
        raise _error(
            409,
            "subscription_reactivation_required",
            "Un abonnement Pro actif est requis pour configurer Chorus Pro.",
        )
    return tenant


def _tenant_chorus_connections(db: Session, tenant_id: str) -> list[PdpConnection]:
    rows = (
        db.query(PdpConnection)
        .filter(
            PdpConnection.tenant_id == tenant_id,
            PdpConnection.provider_slug.in_({"chorus", "choruspro"}),
        )
        .order_by(PdpConnection.updated_at.desc())
        .all()
    )
    return sorted(rows, key=lambda row: (row.provider_slug != "choruspro",), reverse=False)


def _canonicalize_chorus_connection(
    db: Session,
    tenant_id: str,
    *,
    now: datetime,
) -> PdpConnection | None:
    connections = _tenant_chorus_connections(db, tenant_id)
    canonical = next((row for row in connections if row.provider_slug == "choruspro"), None)
    if canonical is None and connections:
        canonical = connections[0]
        canonical.provider_slug = "choruspro"
    for connection in connections:
        if connection is canonical:
            continue
        connection.status = "revoked"
        connection.encrypted_credentials = None
        connection.verified_siret = None
        connection.verified_structure_id = None
        connection.verified_at = None
        connection.updated_at = now
        db.add(connection)
    return canonical


def _chorus_read_client(db: Session, tenant_id: str) -> ChorusClient:
    credentials = enrich_credentials_with_secrets(db, tenant_id, {})
    return ChorusClient(
        client_id=credentials.get("piste_client_id"),
        client_secret=credentials.get("piste_client_secret"),
        token_url=credentials.get("piste_token_url"),
        api_base=credentials.get("chorus_api_base"),
        cpro_account=credentials.get("chorus_cpro_account"),
    )


def _raise_chorus_read_failure(exc: PdpProviderError) -> None:
    code = str(getattr(exc, "code", "") or "")
    if code in {"chorus_cpro_account_missing", "chorus_cpro_account_invalid", "chorus_read_config_missing"}:
        raise _error(409, "chorus_connection_not_configured", "Connexion Chorus non configurée.") from exc
    if code in {"chorus_auth_failed", "chorus_read_forbidden"}:
        raise _error(409, "chorus_verification_failed", "La vérification Chorus a échoué.") from exc
    raise _error(502, "chorus_read_failed", "La consultation Chorus est temporairement indisponible.") from exc


@admin_router.get(
    "/admin/tenants/{tenant_id}/choruspro/connection",
    response_model=ChorusAdminConnectionSummaryOut,
)
def get_chorus_connection_for_tenant(
    tenant_id: str,
    response: Response,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_platform_admin),
):
    tenant = _admin_chorus_tenant(db, tenant_id, require_active_pro=False)
    connections = _tenant_chorus_connections(db, tenant.id)
    connection = next((row for row in connections if row.provider_slug == "choruspro"), None)
    cpro_account = resolve_chorus_cpro_account(db, tenant.id)
    configured = bool(connection and chorus_cpro_account_is_valid(cpro_account))
    tenant_siret = _digits(tenant.siret)
    binding_current = bool(
        connection
        and len(tenant_siret) == 14
        and connection.verified_siret == tenant_siret
        and connection.verified_structure_id
        and connection.verified_at is not None
    )
    status = (connection.status or "disconnected") if connection else "missing"
    if status in {"verified", "connected"} and not binding_current:
        status = "configured" if configured else "disconnected"
    response.headers["Cache-Control"] = "no-store"
    return ChorusAdminConnectionSummaryOut(
        tenant_id=tenant.id,
        provider_slug="choruspro",
        configured=configured,
        status=status,
        verified_at=connection.verified_at if binding_current else None,
        updated_at=connection.updated_at if connection else None,
    )


@admin_router.put(
    "/admin/tenants/{tenant_id}/choruspro/connection",
    response_model=ChorusAdminConnectionProvisionOut,
)
def provision_chorus_connection_for_tenant(
    tenant_id: str,
    payload: ChorusAdminConnectionProvisionRequest,
    response: Response,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_platform_admin),
):
    """Provision tenant credentials without activating Chorus or calling PISTE."""

    tenant = _admin_chorus_tenant(db, tenant_id)

    technical_password = payload.technical_password.get_secret_value()
    cpro_account = build_chorus_cpro_account(payload.technical_login, technical_password)
    del technical_password

    upsert_integration_secret(
        db,
        tenant_id=tenant.id,
        secret_key=CHORUS_CPRO_ACCOUNT_KEY,
        secret_value=cpro_account,
    )
    del cpro_account

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    connection = _canonicalize_chorus_connection(db, tenant.id, now=now)
    if connection is None:
        connection = PdpConnection(
            tenant_id=tenant.id,
            provider_slug="choruspro",
            auth_type="oauth",
            status="configured",
            created_at=now,
            updated_at=now,
        )
    else:
        connection.provider_slug = "choruspro"
        connection.auth_type = "oauth"
        connection.status = "configured"
        connection.updated_at = now
    # Chorus has no per-connection credential blob. The sole credential is the
    # tenant-scoped IntegrationSecret written above.
    connection.encrypted_credentials = None
    connection.verified_siret = None
    connection.verified_structure_id = None
    connection.verified_at = None
    db.add(connection)
    db.flush()
    log_action(
        db,
        tenant_id=tenant.id,
        actor_user_id=user.id,
        action_type="chorus_connection_configured",
        object_type="pdp_connection",
        object_id=connection.id,
        metadata={"provider_slug": "choruspro", "status": "configured"},
    )
    db.commit()
    db.refresh(connection)
    response.headers["Cache-Control"] = "no-store"
    return ChorusAdminConnectionProvisionOut(
        tenant_id=tenant.id,
        provider_slug="choruspro",
        configured=True,
        status="configured",
        updated_at=connection.updated_at,
    )


@admin_router.post(
    "/admin/tenants/{tenant_id}/choruspro/verify",
    response_model=ChorusAdminConnectionVerifyOut,
)
async def verify_chorus_connection_for_tenant(
    tenant_id: str,
    response: Response,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_platform_admin),
):
    tenant = _admin_chorus_tenant(db, tenant_id)
    tenant_siret = _digits(tenant.siret)
    if len(tenant_siret) != 14:
        raise _error(
            409,
            "chorus_tenant_structure_not_attached",
            "Le SIRET du tenant doit être rattaché au compte technique Chorus.",
        )
    connections = _tenant_chorus_connections(db, tenant.id)
    connection = connections[0] if connections else None
    initial_status = (connection.status or "").strip().lower() if connection else ""
    if not connection or initial_status not in {"configured", "verified", "connected"}:
        raise _error(409, "chorus_connection_not_configured", "Connexion Chorus non configurée.")
    cpro_account = resolve_chorus_cpro_account(db, tenant.id)
    if not chorus_cpro_account_is_valid(cpro_account):
        raise _error(409, "chorus_connection_not_configured", "Connexion Chorus non configurée.")
    try:
        summary = await _chorus_read_client(db, tenant.id).get_account_attachment_summary(
            expected_siret=tenant_siret
        )
    except PdpProviderError as exc:
        if initial_status in {"verified", "connected"}:
            connection.status = "configured"
            connection.verified_siret = None
            connection.verified_structure_id = None
            connection.verified_at = None
            connection.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.add(connection)
            db.commit()
        _raise_chorus_read_failure(exc)
    if not summary.get("expected_siret_attached") or summary.get("matched_structure_id") is None:
        if initial_status in {"verified", "connected"}:
            connection.status = "configured"
            connection.verified_siret = None
            connection.verified_structure_id = None
            connection.verified_at = None
            connection.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.add(connection)
            db.commit()
        raise _error(
            409,
            "chorus_tenant_structure_not_attached",
            "Le SIRET du tenant n'est pas rattaché au compte technique Chorus.",
        )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    connection = _canonicalize_chorus_connection(db, tenant.id, now=now) or connection
    connection.provider_slug = "choruspro"
    verified_status = "connected" if initial_status == "connected" else "verified"
    connection.status = verified_status
    connection.verified_siret = tenant_siret
    connection.verified_structure_id = str(summary["matched_structure_id"])
    connection.verified_at = now
    connection.updated_at = now
    db.add(connection)
    db.flush()
    structure_count = int(summary.get("structure_count") or 0)
    log_action(
        db,
        tenant_id=tenant.id,
        actor_user_id=user.id,
        action_type="chorus_connection_verified",
        object_type="pdp_connection",
        object_id=connection.id,
        metadata={
            "provider_slug": "choruspro",
            "status": verified_status,
            "structure_count": structure_count,
        },
    )
    db.commit()
    db.refresh(connection)
    response.headers["Cache-Control"] = "no-store"
    return ChorusAdminConnectionVerifyOut(
        tenant_id=tenant.id,
        provider_slug="choruspro",
        verified=True,
        status=verified_status,
        structure_count=structure_count,
        updated_at=connection.updated_at,
    )


@admin_router.post(
    "/admin/tenants/{tenant_id}/choruspro/pilot/activate",
    response_model=ChorusAdminPilotActivationOut,
)
async def activate_chorus_pilot_for_tenant(
    tenant_id: str,
    payload: ChorusAdminPilotActivationRequest,
    response: Response,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_platform_admin),
):
    tenant = _admin_chorus_tenant(db, tenant_id)
    connections = _tenant_chorus_connections(db, tenant.id)
    connection = next((row for row in connections if row.provider_slug == "choruspro"), None)
    tenant_siret = _digits(tenant.siret)
    if (
        not connection
        or (connection.status or "").strip().lower() != "verified"
        or len(tenant_siret) != 14
        or connection.verified_siret != tenant_siret
        or not connection.verified_structure_id
        or connection.verified_at is None
    ):
        raise _error(409, "chorus_connection_not_verified", "Connexion Chorus non vérifiée.")
    if not chorus_cpro_account_is_valid(resolve_chorus_cpro_account(db, tenant.id)):
        raise _error(409, "chorus_connection_not_configured", "Connexion Chorus non configurée.")
    if settings.EINVOICING_EXPORT_ONLY:
        raise _error(409, "export_only", "Le mode export uniquement interdit l'activation du pilote Chorus.")
    ensure_connected_mode_rollout_allowed(db, tenant.id, "choruspro")

    entries = (
        db.query(RecipientDirectoryEntry)
        .filter(
            RecipientDirectoryEntry.tenant_id == tenant.id,
            RecipientDirectoryEntry.siret == payload.recipient_siret,
            RecipientDirectoryEntry.source == "choruspro",
            RecipientDirectoryEntry.platform_slug == "choruspro",
        )
        .all()
    )
    if len(entries) > 1:
        raise _error(409, "chorus_recipient_qualification_required", "Destinataire Chorus à requalifier.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    existing_entry = entries[0] if entries else None
    selected_service_code = str(getattr(existing_entry, "routing_code", None) or "").strip() or None
    client = _chorus_read_client(db, tenant.id)
    try:
        siret_information = await client.get_siret_information(payload.recipient_siret)
        recipients = await client.search_public_recipient(payload.recipient_siret)
        exact_recipients = [item for item in recipients if item.get("siret") == payload.recipient_siret]
        if (
            siret_information.get("siret") != payload.recipient_siret
            or siret_information.get("active") is not True
            or len(exact_recipients) != 1
        ):
            raise _error(409, "chorus_recipient_qualification_required", "Destinataire Chorus à requalifier.")
        selected_recipient = exact_recipients[0]
        structure_id = selected_recipient.get("idStructureCPP")
        if structure_id is None:
            raise _error(409, "chorus_recipient_qualification_required", "Destinataire Chorus à requalifier.")
        details = await client.get_structure_details(structure_id)
        if details.get("public") is not True:
            raise _error(409, "chorus_recipient_qualification_required", "Destinataire Chorus à requalifier.")
        services = await client.get_structure_services(structure_id)
        selected_service = None
        service_rules_complete = False
        service_commitment_required = False
        if selected_service_code:
            matching_services = [
                service for service in services if service.get("codeService") == selected_service_code
            ]
            if len(matching_services) != 1 or matching_services[0].get("idService") is None:
                raise _error(409, "chorus_recipient_qualification_required", "Service Chorus à requalifier.")
            active_service = matching_services[0]
            service_details = await client.get_structure_service_details(
                structure_id,
                active_service["idService"],
                expected_code=selected_service_code,
            )
            service_commitment_required = bool(service_details["commitment_required"])
            service_rules_complete = True
            selected_service = {
                "codeService": selected_service_code,
                "libelleService": active_service.get("libelleService"),
                "commitmentRequired": service_commitment_required,
            }
    except HTTPException:
        raise
    except PdpProviderError as exc:
        _raise_chorus_read_failure(exc)

    structure_commitment_required = details.get("commitment_required")
    if structure_commitment_required is None:
        effective_commitment_required = service_commitment_required if service_rules_complete else None
    else:
        effective_commitment_required = bool(structure_commitment_required or service_commitment_required)
    entry = _upsert_entry(
        db,
        tenant.id,
        {
            "siren": payload.recipient_siret[:9],
            "siret": payload.recipient_siret,
            "platform_slug": "choruspro",
            "billing_address": payload.recipient_siret,
            "routing_code": selected_service_code,
            "routing_identifier": str(structure_id),
            "platform_attached": True,
            "billing_address_active": True,
            "service_code_required": details.get("service_code_required"),
            "commitment_required": effective_commitment_required,
            "service_or_commitment_required": details.get("service_or_commitment_required"),
            "public_entity": True,
            "raw_payload": {
                "idStructureCPP": structure_id,
                "designation": details.get("designation") or selected_recipient.get("nomDestinataire"),
                "services": [
                    {
                        "codeService": service["codeService"],
                        "libelleService": service.get("libelleService"),
                    }
                    for service in services
                    if service.get("codeService")
                ],
                "selected_service": selected_service,
                "service_rules_complete": service_rules_complete,
            },
            "ttl_seconds": _CHORUS_QUALIFICATION_DEFAULT_TTL_SECONDS,
        },
        source="choruspro",
        now=now,
    )
    db.add(entry)
    db.flush()
    log_action(
        db,
        tenant_id=tenant.id,
        actor_user_id=user.id,
        action_type="chorus_recipient_qualified",
        object_type="recipient_directory_entry",
        object_id=entry.id,
        metadata={"provider_slug": "choruspro", "status": "qualified"},
    )
    last_synced_at = _utc_naive(entry.last_synced_at)
    if (
        last_synced_at is None
        or last_synced_at + timedelta(seconds=_chorus_qualification_ttl_seconds(entry)) <= now
        or entry.public_entity is not True
        or entry.platform_attached is not True
        or entry.billing_address_active is not True
        or entry.billing_address != payload.recipient_siret
        or entry.service_code_required is None
        or entry.commitment_required is None
        or entry.service_or_commitment_required is None
    ):
        raise _error(409, "chorus_recipient_qualification_required", "Destinataire Chorus à requalifier.")

    connection = _canonicalize_chorus_connection(db, tenant.id, now=now) or connection
    connection.status = "connected"
    connection.updated_at = now
    db.add(connection)
    db.flush()
    log_action(
        db,
        tenant_id=tenant.id,
        actor_user_id=user.id,
        action_type="chorus_pilot_activated",
        object_type="pdp_connection",
        object_id=connection.id,
        metadata={"provider_slug": "choruspro", "status": "connected"},
    )
    db.commit()
    db.refresh(connection)
    response.headers["Cache-Control"] = "no-store"
    return ChorusAdminPilotActivationOut(
        tenant_id=tenant.id,
        provider_slug="choruspro",
        activated=True,
        status="connected",
        updated_at=connection.updated_at,
    )


@admin_router.delete(
    "/admin/tenants/{tenant_id}/choruspro/connection",
    response_model=ChorusAdminConnectionRevokeOut,
)
def revoke_chorus_connection_for_tenant(
    tenant_id: str,
    response: Response,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_platform_admin),
):
    tenant = _admin_chorus_tenant(db, tenant_id, require_active_pro=False)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    connections = _tenant_chorus_connections(db, tenant.id)
    for connection in connections:
        connection.status = "revoked"
        connection.encrypted_credentials = None
        connection.verified_siret = None
        connection.verified_structure_id = None
        connection.verified_at = None
        connection.updated_at = now
        db.add(connection)
    upsert_integration_secret(
        db,
        tenant_id=tenant.id,
        secret_key=CHORUS_CPRO_ACCOUNT_KEY,
        secret_value=None,
    )
    object_id = connections[0].id if connections else tenant.id
    log_action(
        db,
        tenant_id=tenant.id,
        actor_user_id=user.id,
        action_type="chorus_connection_revoked",
        object_type="pdp_connection",
        object_id=object_id,
        metadata={"provider_slug": "choruspro", "status": "revoked"},
    )
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return ChorusAdminConnectionRevokeOut(
        tenant_id=tenant.id,
        provider_slug="choruspro",
        revoked=True,
        status="revoked",
        updated_at=now,
    )


onboarding_router = APIRouter(tags=["platforms"])


class OnboardingEventIn(BaseModel):
    event: str
    mode: str | None = None
    reason: str | None = None
    source: str | None = None


@onboarding_router.get("/onboarding-status")
def onboarding_status(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    enabled_connectors = {
        "seqino": False,
        "chorus": False,
        "generic_http": False,
    }
    seqino_connection = False
    chorus_connection = False
    generic_connection = False
    connections = db.query(PdpConnection).filter(PdpConnection.tenant_id == user.tenant_id).all()
    for conn in connections:
        slug = (conn.provider_slug or "").strip().lower()
        if slug == "seqino":
            enabled_connectors["seqino"] = True
            seqino_connection = True
        elif slug in {"chorus", "choruspro"}:
            chorus_connection = (conn.status or "").strip().lower() == "connected"
        elif slug in {"http_generic", "http", "generic"}:
            enabled_connectors["generic_http"] = True
            generic_connection = True

    mandate_required = bool(seqino_connection)
    active_count = _seqino_active_mandate_count(db, user.tenant_id)
    last_mandate_update = (
        db.query(func.max(PdpMandate.updated_at)).filter(PdpMandate.tenant_id == user.tenant_id).scalar()
    )

    directory_enabled = _ppf_directory_enabled()
    if not directory_enabled:
        directory_last_sync = None
        directory_status = "disabled"
        directory_error = None
    else:
        last_directory_run = (
            db.query(DirectorySyncRun)
            .filter(DirectorySyncRun.tenant_id == user.tenant_id)
            .order_by(DirectorySyncRun.started_at.desc())
            .first()
        )
        if last_directory_run:
            directory_last_sync = last_directory_run.finished_at or last_directory_run.started_at
            if (last_directory_run.status or "").lower() == "failed":
                directory_status = "error"
                directory_error = "La synchronisation de l'annuaire a échoué. Réessayez dans quelques instants."
            else:
                directory_status = "ok"
                directory_error = None
        else:
            directory_last_sync = None
            directory_status = "never"
            directory_error = None

    tx_query = (
        db.query(EInvoicingTransmission)
        .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
        .filter(Invoice.tenant_id == user.tenant_id)
    )
    last_success_tx = (
        tx_query.filter(
            EInvoicingTransmission.status.in_(_SUCCESS_STATUSES),
            EInvoicingTransmission.delivery_state == "delivered",
        )
        .order_by(EInvoicingTransmission.updated_at.desc(), EInvoicingTransmission.created_at.desc())
        .first()
    )
    last_error_tx = (
        tx_query.filter(
            EInvoicingTransmission.status.in_(_ERROR_STATUSES)
            | EInvoicingTransmission.delivery_state.in_({"failed", "reconciliation_required"})
        )
        .order_by(EInvoicingTransmission.updated_at.desc(), EInvoicingTransmission.created_at.desc())
        .first()
    )
    error_summary = "Le dernier échange n'a pas abouti." if last_error_tx else None
    errors: list[dict[str, str]] = []
    seen_codes: set[str] = set()

    def _push_error(code: str, message: str, hint: str | None = None) -> None:
        if code in seen_codes:
            return
        seen_codes.add(code)
        payload: dict[str, str] = {"code": code, "message": message}
        if hint:
            payload["hint"] = hint
        errors.append(payload)

    chorus_configured = chorus_connection and _chorus_configured(db, user.tenant_id)
    enabled_connectors["chorus"] = chorus_configured

    if not any(enabled_connectors.values()):
        _push_error(
            "connector_missing",
            "Aucune plateforme connectée active.",
            "Finalisez la configuration de la plateforme partenaire ou du canal public.",
        )

    if seqino_connection and not _seqino_configured(db, user.tenant_id):
        _push_error(
            "seqino_config_missing",
            "La plateforme partenaire n'est pas encore activée pour cet espace.",
            "Contactez le support pour terminer l'activation du connecteur.",
        )
    if chorus_connection and not chorus_configured:
        _push_error(
            "chorus_config_missing",
            "Le canal public Chorus Pro n'est pas encore activé pour cet espace.",
            "Contactez le support pour terminer la qualification du raccordement.",
        )
    if generic_connection and not settings.ENABLE_HTTP_GENERIC_CONNECTOR:
        _push_error(
            "http_generic_disabled",
            "Ce connecteur personnalisé n'est pas disponible pour votre espace.",
            "Utilisez un connecteur pris en charge ou contactez le support.",
        )
    if mandate_required and active_count == 0:
        _push_error(
            "seqino_mandate_missing",
            "Mandat requis pour activer la réception/statuts via la plateforme partenaire.",
            "Finalisez la préparation de la plateforme partenaire ou utilisez le mode export pour démarrer.",
        )
    if directory_status == "error":
        _push_error(
            "directory_sync_failed",
            directory_error or "Synchro annuaire en erreur.",
            "Relancer la synchronisation annuaire.",
        )
    if directory_enabled and directory_status == "never" and not is_ppf_configured():
        _push_error(
            "ppf_not_configured",
            "L'annuaire de routage n'est pas encore disponible.",
            "Contactez le support ou poursuivez en mode export.",
        )
    if last_error_tx:
        _push_error(
            "exchange_failed",
            "Le dernier échange n'a pas abouti.",
            "Consultez la transmission concernée ou contactez le support avec sa référence.",
        )

    return {
        "enabled_connectors": enabled_connectors,
        "mandate": {
            "required": mandate_required,
            "active_count": active_count,
            "last_updated": last_mandate_update,
        },
        "directory": {
            "last_sync": directory_last_sync,
            "status": directory_status,
            "error": directory_error,
        },
        "exchanges": {
            "last_success": _tx_timestamp(last_success_tx),
            "last_error": _tx_timestamp(last_error_tx),
            "error_summary": error_summary,
        },
        "errors": errors,
    }


@onboarding_router.post("/onboarding-event")
def onboarding_event(
    payload: OnboardingEventIn,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_viewer_or_admin),
    _: AuthUser = Depends(require_product_feature("einvoicing_enabled")),
):
    ensure_connected_mode_operational(db, user.tenant_id)
    event = (payload.event or "").strip()
    if not event:
        raise _error(400, "event_required", "event requis")
    log_payload = {
        "event": event,
        "mode": payload.mode,
        "reason": payload.reason,
        "source": payload.source,
    }
    log_action(
        db,
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        action_type="onboarding_event",
        object_type="einvoicing_onboarding",
        object_id=user.tenant_id,
        metadata=log_payload,
    )
    db.commit()
    return {"ok": True}


router = build_router()
