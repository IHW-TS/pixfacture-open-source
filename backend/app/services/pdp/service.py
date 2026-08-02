from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from ...models import (
    EInvoicingActionOutbox,
    EInvoicingTransmission,
    Invoice,
    PdpConnection,
    RecipientDirectoryEntry,
    Tenant,
    TransmissionEvent,
)
from ...config import settings
from ...services.einvoicing.lifecycle import BLOCKING_STATUSES, is_transition_allowed, normalize_status
from ... import metrics
from ...services.storage import get_object_bytes
from ...services.action_logs import log_action
from ...utils.crypto import decrypt_payload
from ...utils.public_provider_messages import sanitize_public_provider_message
from ..integration_secrets import enrich_credentials_with_secrets
from ..connected_mode import connected_mode_decision
from ..billable_events import record_billable_event
from ..seqino_tokens import consume_seqino_tokens_or_raise, refund_seqino_tokens_after_certain_failure
from ..seqino_mandates import seqino_has_active_mandate_for_issuer
from ..webhooks import enqueue_einvoicing_webhooks
from . import PdpProvider, StatusResult, TransmissionResult, get_provider
from .utils import PdpPreSubmitCancelled, PdpPreSubmitError, PdpProviderError, retry_async

logger = logging.getLogger("pdp.service")
_HTTP_GENERIC_SLUGS = {"http_generic", "http", "generic"}
# Customer packs collateralise the Seqino sponsor inventory only. Chorus Pro
# is an included Pro channel and must never consume or depend on Seqino stock.
_TOKEN_BILLED_PROVIDER_SLUGS = {"seqino"}
_PROVIDER_EVENT_PAYLOAD_KEYS = {
    "code",
    "correlationid",
    "createdat",
    "date",
    "direction",
    "event",
    "eventid",
    "eventtype",
    "externalid",
    "id",
    "invoiceid",
    "objectid",
    "objecttype",
    "occurredat",
    "reference",
    "status",
    "statuscode",
    "timestamp",
    "updatedat",
    "uuid",
}


def _is_http_generic(provider: PdpProvider, channel: str | None) -> bool:
    slug = (getattr(provider, "slug", "") or "").strip().lower()
    if not slug:
        slug = (channel or "").strip().lower()
    return slug in _HTTP_GENERIC_SLUGS


def sanitize_provider_payload(payload: Any) -> dict[str, Any] | None:
    """Keep only small lifecycle metadata safe for logs/events/webhooks.

    Provider payloads may contain complete EN16931 invoices, attachments,
    technical credentials or personal data. Those belong in controlled artifact
    storage, not in event JSON columns.
    """

    if not isinstance(payload, dict):
        return None
    sanitized: dict[str, Any] = {}
    for raw_key, raw_value in payload.items():
        key = str(raw_key)
        normalized = "".join(ch for ch in key.lower() if ch.isalnum())
        if normalized not in _PROVIDER_EVENT_PAYLOAD_KEYS:
            continue
        if raw_value is None or isinstance(raw_value, (bool, int, float)):
            sanitized[key] = raw_value
        elif isinstance(raw_value, datetime):
            sanitized[key] = raw_value.isoformat()
        elif isinstance(raw_value, str):
            sanitized[key] = raw_value[:300]
    return sanitized or None


def _sanitize_provider_errors(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    sanitized: list[str] = []
    for item in value[:10]:
        if isinstance(item, str):
            text = item.strip()[:300]
        elif isinstance(item, dict):
            code = str(item.get("code") or item.get("error_code") or "").strip()[:80]
            message = str(item.get("message") or item.get("detail") or item.get("libelle") or "").strip()[:300]
            text = f"{code}: {message}" if code and message else (message or code)
        else:
            text = ""
        public_text = sanitize_public_provider_message(text)
        if public_text:
            sanitized.append(public_text)
    return sanitized or None


def _http_generic_error_code(exc: BaseException) -> str | None:
    code = getattr(exc, "code", None)
    if code:
        return str(code)
    message = str(exc or "").lower()
    if "ssrf_blocked" in message:
        return "ssrf_blocked"
    return exc.__class__.__name__


def _token_reference_type_for_provider(provider_slug: str) -> str:
    slug = (provider_slug or "").strip().lower()
    if slug == "choruspro":
        return "chorus_invoice_flow"
    return "seqino_invoice_flow"


def _refund_einvoicing_token_after_failed_submit(
    db: Session,
    tenant_id: str,
    *,
    provider_slug: str,
    reference_id: str | None,
) -> None:
    if not reference_id:
        return
    try:
        refund_seqino_tokens_after_certain_failure(
            db,
            tenant_id,
            reference_type=_token_reference_type_for_provider(provider_slug),
            reference_id=reference_id,
            provider_slug=provider_slug,
        )
    except Exception:
        logger.warning(
            "einvoicing_token_refund_failed",
            extra={"tenant_id": tenant_id, "provider": provider_slug, "reference_id": reference_id},
        )


def _log_http_generic_submit(
    db: Session,
    *,
    tenant_id: str,
    invoice_id: str,
    payload_hash: str | None,
    status: str,
    error_code: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "provider": "http_generic",
        "status": status,
        "payload_hash": payload_hash,
    }
    if error_code:
        payload["error_code"] = error_code
    log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=None,
        action_type="platform_http_generic_submit",
        object_type="invoice",
        object_id=invoice_id,
        metadata=payload,
    )


def _record_billable_submit(
    db: Session,
    *,
    tenant_id: str,
    invoice_id: str,
    channel: str,
    tx: EInvoicingTransmission,
) -> None:
    try:
        assert tx.id is not None
        record_billable_event(
            db,
            tenant_id=tenant_id,
            invoice_id=invoice_id,
            event_type="platform_submit",
            provider_slug=channel,
            status=tx.status,
            source_type="einvoicing_transmission",
            source_id=tx.id,
            occurred_at=tx.created_at,
            commit=True,
        )
    except Exception:
        logger.warning(
            "billable_event_submit_failed",
            extra={"tenant_id": tenant_id, "invoice_id": invoice_id, "channel": channel},
        )


def _raise_if_trialing_transmission(db: Session, tenant_id: str) -> None:
    tenant = db.get(Tenant, tenant_id)
    status = (getattr(tenant, "subscription_status", None) or "").strip().lower()
    if status != "trialing":
        return
    raise PdpProviderError(
        "Les transmissions e-facture réelles sont désactivées pendant l'essai 7 jours. "
        "Vous pouvez préparer vos documents ; l'envoi exige ensuite un abonnement Pro finalisé, un contrat, "
        "un mandat et une configuration opérationnelle.",
        code="trial_einvoicing_transmissions_disabled",
    )


def is_fr_b2b(tenant_country: str | None, customer_country: str | None, client_type: str | None) -> bool:
    customer = (customer_country or "FR").strip().upper()
    tenant = (tenant_country or "FR").strip().upper()
    if customer != "FR" or tenant != "FR":
        return False
    return (client_type or "business").strip().lower() == "business"


def resolve_connection(
    db: Session,
    tenant_id: str,
    provider_slug: str | None = None,
) -> PdpConnection:
    slug = (provider_slug or "").strip().lower()
    q = db.query(PdpConnection).filter(PdpConnection.tenant_id == tenant_id)
    if slug:
        conn = q.filter(PdpConnection.provider_slug == slug).first()
        if not conn:
            raise ValueError("Connexion plateforme agréée introuvable.")
        return conn
    conns = q.order_by(PdpConnection.updated_at.desc(), PdpConnection.created_at.desc()).all()
    if not conns:
        raise ValueError("Aucune connexion plateforme agréée configuree.")
    if len(conns) > 1:
        raise ValueError("Plusieurs connexions plateforme agréée disponibles, precisez provider_slug.")
    return conns[0]


def select_connection_for_customer(
    db: Session,
    tenant_id: str,
    siren: str | None,
    siret: str | None,
) -> PdpConnection | None:
    siren = (siren or "").replace(" ", "") or None
    siret = (siret or "").replace(" ", "") or None
    entry = None
    if siret or siren:
        q = db.query(RecipientDirectoryEntry).filter(RecipientDirectoryEntry.tenant_id == tenant_id)
        if siret:
            entry = (
                q.filter(RecipientDirectoryEntry.siret == siret)
                .order_by(RecipientDirectoryEntry.updated_at.desc())
                .first()
            )
        elif siren:
            entry = (
                q.filter(RecipientDirectoryEntry.siren == siren)
                .order_by(RecipientDirectoryEntry.updated_at.desc())
                .first()
            )
    if entry:
        conn = (
            db.query(PdpConnection)
            .filter(
                PdpConnection.tenant_id == tenant_id,
                PdpConnection.provider_slug == entry.platform_slug,
                PdpConnection.status == "connected",
            )
            .order_by(PdpConnection.updated_at.desc())
            .first()
        )
        if conn:
            return conn
    conns = (
        db.query(PdpConnection)
        .filter(PdpConnection.tenant_id == tenant_id, PdpConnection.status == "connected")
        .order_by(PdpConnection.updated_at.desc(), PdpConnection.created_at.desc())
        .all()
    )
    if len(conns) == 1:
        return conns[0]
    return None


def resolve_provider(conn: PdpConnection, db: Session | None = None) -> tuple[PdpProvider, dict[str, Any]]:
    creds = decrypt_payload(conn.encrypted_credentials) if conn.encrypted_credentials else {}
    if conn.tenant_id:
        creds = dict(creds)
        creds["_tenant_id"] = conn.tenant_id
        if db is not None:
            creds = enrich_credentials_with_secrets(db, conn.tenant_id, creds)
    provider_slug = (conn.provider_slug or "").strip()
    if not provider_slug:
        raise ValueError("provider_slug manquant pour la connexion PDP.")
    provider = get_provider(provider_slug, creds)
    return provider, creds


def payload_hash_from_invoice(inv: Invoice) -> str | None:
    if inv.issued_hash:
        return inv.issued_hash
    if inv.pdf_key and inv.xml_key:
        pdf_bytes = get_object_bytes(inv.pdf_key)
        xml_bytes = get_object_bytes(inv.xml_key)
        if pdf_bytes and xml_bytes:
            import hashlib

            return hashlib.sha256(pdf_bytes + xml_bytes).hexdigest()
    return None


def _verify_stored_invoice_artifact(inv: Invoice, *, key_attr: str, checksum_attr: str, label: str) -> None:
    key = getattr(inv, key_attr, None)
    expected = getattr(inv, checksum_attr, None)
    if not key or not expected:
        return
    payload = get_object_bytes(key)
    if not payload:
        raise PdpProviderError(
            f"Artefact {label} de facture introuvable ou vide. Transmission bloquée.",
            code="artifact_integrity_error",
        )
    actual = hashlib.sha256(payload).hexdigest()
    if actual != expected:
        raise PdpProviderError(
            f"Artefact {label} de facture incohérent avec l'émission. Transmission bloquée.",
            code="artifact_integrity_error",
        )


def ensure_invoice_submission_artifacts_integrity(inv: Invoice) -> None:
    _verify_stored_invoice_artifact(inv, key_attr="pdf_key", checksum_attr="pdf_checksum", label="PDF")
    _verify_stored_invoice_artifact(inv, key_attr="xml_key", checksum_attr="xml_checksum", label="XML")
    _verify_stored_invoice_artifact(inv, key_attr="facturx_key", checksum_attr="facturx_checksum", label="Factur-X")


def _coerce_event_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        raw = value.strip()
        if raw.endswith("Z"):
            raw = raw[:-1]
        try:
            return datetime.fromisoformat(raw)
        except ValueError:
            return datetime.now(timezone.utc).replace(tzinfo=None)
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _build_event(
    *,
    event_type: str,
    status: str,
    message: str | None = None,
    raw_status: str | None = None,
    errors: list[str] | None = None,
    source: str | None = None,
    payload: dict[str, Any] | None = None,
    occurred_at: str | datetime | None = None,
) -> dict[str, Any]:
    return {
        "event_type": event_type,
        "status": status,
        "message": message,
        "raw_status": raw_status,
        "errors": errors,
        "source": source,
        "payload": payload,
        "occurred_at": occurred_at or datetime.now(timezone.utc).isoformat(),
    }


def append_transmission_event(db: Session, tx: EInvoicingTransmission, event: dict[str, Any]) -> None:
    status = event.get("status") or tx.status or "unknown"
    event_type = event.get("event_type") or "status_update"
    occurred_at = _coerce_event_time(event.get("occurred_at"))
    correlation_id = event.get("correlation_id")
    provider_slug = event.get("provider_slug") or tx.channel
    external_id = event.get("external_id") or tx.external_id
    public_message = sanitize_public_provider_message(event.get("message"))
    public_errors = _sanitize_provider_errors(event.get("errors"))
    payload_raw: dict[str, Any] = {
        "message": public_message,
        "raw_status": event.get("raw_status"),
        "errors": public_errors,
        "source": event.get("source"),
        "payload": sanitize_provider_payload(event.get("payload")),
    }
    db.add(
        TransmissionEvent(
            transmission_id=tx.id,
            correlation_id=correlation_id,
            provider_slug=provider_slug,
            external_id=external_id,
            event_type=event_type,
            status_code_norme=status,
            payload_raw=payload_raw,
            occurred_at=occurred_at,
            created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
    )
    timeline = list(tx.events or [])
    timeline.append(
        {
            "event_type": event_type,
            "status": status,
            "message": public_message,
            "raw_status": event.get("raw_status"),
            "errors": public_errors,
            "source": event.get("source"),
            "occurred_at": occurred_at.isoformat(),
        }
    )
    tx.events = timeline


def _summarize_error(exc: BaseException) -> str:
    if isinstance(exc, PdpProviderError):
        return sanitize_public_provider_message(str(exc), fallback="Erreur du connecteur.") or "Erreur du connecteur."
    if isinstance(exc, ValueError):
        return "La soumission n'a pas pu être préparée. Vérifiez le document."
    return "Le résultat de la soumission n'a pas pu être confirmé."


def _submission_error_is_ambiguous(exc: BaseException) -> bool:
    """Whether a remote service may have accepted the request.

    Retryable provider/transport failures and unknown exceptions are treated as
    ambiguous. They must be reconciled, never automatically replayed.
    """

    if isinstance(exc, ValueError):
        return False
    if isinstance(exc, PdpProviderError):
        outcome = (getattr(exc, "submission_outcome", None) or "").strip().lower()
        if outcome == "unknown":
            return True
        if outcome in {"not_sent", "rejected"}:
            return False
        return bool(exc.retryable)
    return True


def _restore_pre_submit_reservation(
    db: Session,
    tx: EInvoicingTransmission,
    *,
    created_new: bool,
    previous: dict[str, Any] | None,
) -> None:
    """Remove or restore an outbox reservation when no provider POST began."""

    persisted = db.get(EInvoicingTransmission, tx.id)
    if persisted is None:
        db.rollback()
        return
    if created_new:
        db.delete(persisted)
    elif previous is not None:
        for field, value in previous.items():
            setattr(persisted, field, value)
        db.add(persisted)
    db.commit()


def provider_action_idempotency_key(
    *,
    tenant_id: str,
    provider_slug: str,
    external_id: str,
    action: str,
    reference_id: str | None = None,
) -> str:
    raw = "|".join(
        [
            tenant_id.strip(),
            provider_slug.strip().lower(),
            external_id.strip(),
            action.strip().lower(),
            (reference_id or "once").strip(),
        ]
    )
    return "einvoice-action:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def execute_idempotent_provider_action(
    db: Session,
    *,
    tenant_id: str,
    provider_slug: str,
    external_id: str,
    action: str,
    callback: Callable[[], Awaitable[Any]],
    transmission_id: str | None = None,
    reference_id: str | None = None,
    force_retry: bool = False,
) -> EInvoicingActionOutbox:
    """Execute one unsafe provider action behind a durable, unique outbox.

    The callback is invoked exactly once per attempt and only after the
    ``submitting`` row is committed. Ambiguous failures require reconciliation;
    they cannot be replayed, even with ``force_retry``.
    """

    provider_value = (provider_slug or "").strip().lower()
    external_value = (external_id or "").strip()
    action_value = (action or "").strip().lower()
    if not tenant_id or not provider_value or not external_value or not action_value:
        raise ValueError("tenant_id, provider_slug, external_id et action sont requis.")
    access = connected_mode_decision(db, tenant_id, provider_value)
    if not access.allowed:
        raise PdpProviderError(access.message, code=access.code or "connected_mode_not_operational", retryable=False)
    if transmission_id:
        owned = (
            db.query(EInvoicingTransmission.id)
            .join(Invoice, EInvoicingTransmission.invoice_id == Invoice.id)
            .filter(
                EInvoicingTransmission.id == transmission_id,
                Invoice.tenant_id == tenant_id,
            )
            .first()
        )
        if not owned:
            raise PdpProviderError(
                "Transmission introuvable pour cette entreprise.",
                code="transmission_not_found",
                retryable=False,
            )
    key = provider_action_idempotency_key(
        tenant_id=tenant_id,
        provider_slug=provider_value,
        external_id=external_value,
        action=action_value,
        reference_id=reference_id,
    )
    row = (
        db.query(EInvoicingActionOutbox).filter(EInvoicingActionOutbox.idempotency_key == key).with_for_update().first()
    )
    if row:
        state = (row.state or "").strip().lower()
        if state in {"submitting", "completed"}:
            return row
        if state == "reconciliation_required":
            raise PdpProviderError(
                "Le résultat de l'action fournisseur est incertain. Réconciliation requise avant toute reprise.",
                code="einvoicing_action_reconciliation_required",
                retryable=False,
            )
        if state == "failed" and not force_retry:
            raise PdpProviderError(
                "La dernière action fournisseur a échoué. Confirmez explicitement une nouvelle tentative.",
                code="einvoicing_action_retry_required",
                retryable=False,
            )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if row is None:
        row = EInvoicingActionOutbox(
            tenant_id=tenant_id,
            transmission_id=transmission_id,
            provider_slug=provider_value,
            external_id=external_value,
            action=action_value,
            idempotency_key=key,
            state="submitting",
            attempt_count=1,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.state = "submitting"
        row.attempt_count = int(row.attempt_count or 0) + 1
        row.error_code = None
        row.error_message = None
        row.updated_at = now
    try:
        db.flush()
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        concurrent = db.query(EInvoicingActionOutbox).filter(EInvoicingActionOutbox.idempotency_key == key).first()
        if concurrent:
            if (concurrent.state or "").strip().lower() == "completed":
                return concurrent
            raise PdpProviderError(
                "Action fournisseur déjà en cours.",
                code="einvoicing_action_in_progress",
                retryable=False,
            ) from exc
        raise PdpProviderError(
            "Action fournisseur déjà en cours.",
            code="einvoicing_action_in_progress",
            retryable=False,
        ) from exc
    db.refresh(row)

    try:
        await callback()
    except asyncio.CancelledError:
        # Once an unsafe callback has started, cancellation cannot prove that
        # the remote action was not received. Keep the durable replay barrier.
        row.state = "reconciliation_required"
        row.error_code = "provider_action_cancelled"
        row.error_message = "Action interrompue après son démarrage ; réconciliation requise."
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(row)
        db.commit()
        raise
    except Exception as exc:
        ambiguous = _submission_error_is_ambiguous(exc)
        row.state = "reconciliation_required" if ambiguous else "failed"
        row.error_code = str(getattr(exc, "code", None) or exc.__class__.__name__)[:120]
        row.error_message = _summarize_error(exc)
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(row)
        db.commit()
        db.refresh(row)
        if ambiguous:
            raise PdpProviderError(
                "Le résultat de l'action fournisseur est incertain. La répétition est bloquée jusqu'à réconciliation.",
                code="einvoicing_action_reconciliation_required",
                retryable=False,
            ) from exc
        raise

    row.state = "completed"
    row.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    row.updated_at = row.completed_at
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _submission_payload_hash(invoice: Invoice, channel: str) -> str | None:
    if (channel or "").strip().lower() in {"chorus", "choruspro"}:
        sealed_artifacts = (
            (getattr(invoice, "pdf_key", None), getattr(invoice, "pdf_checksum", None)),
            (getattr(invoice, "xml_key", None), getattr(invoice, "xml_checksum", None)),
            (getattr(invoice, "facturx_key", None), getattr(invoice, "facturx_checksum", None)),
        )
        if any(not key or not checksum for key, checksum in sealed_artifacts):
            raise PdpProviderError(
                "Les trois artefacts émis et contrôlés sont requis avant transmission Chorus.",
                code="artifact_integrity_error",
                retryable=False,
            )
        # The Chorus-specific PDF is rebuilt deterministically from the sealed
        # PDF and CII XML. Bind idempotency to every immutable source, while
        # retaining the canonical Factur-X seal as an issuance prerequisite.
        checksum_fingerprint = "|".join(str(checksum) for _key, checksum in sealed_artifacts)
        return hashlib.sha256(checksum_fingerprint.encode("ascii")).hexdigest()
    return payload_hash_from_invoice(invoice)


def _submission_idempotency_key(
    *,
    tenant_id: str,
    channel: str,
    invoice_id: str,
    payload_hash: str | None,
) -> str:
    fingerprint = f"{tenant_id}|{channel}|{invoice_id}|{payload_hash or 'unsealed'}"
    return "einvoice:" + hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()


async def _poll_status_with_retry(
    provider: PdpProvider,
    external_id: str,
    *,
    attempts: int = 2,
) -> StatusResult:
    return await retry_async(lambda: provider.poll_status(external_id), attempts=attempts)


def _apply_event(
    db: Session,
    tx: EInvoicingTransmission,
    event: dict[str, Any],
) -> bool:
    previous_status = tx.status
    raw_status = event.get("status")
    event["payload"] = sanitize_provider_payload(event.get("payload"))
    event["errors"] = _sanitize_provider_errors(event.get("errors"))
    normalized_status = normalize_status(str(raw_status) if raw_status is not None else None)
    event["status"] = normalized_status
    if normalized_status and normalized_status != tx.status:
        if not is_transition_allowed(tx.status, normalized_status):
            logger.info(
                "pdp_transition_rejected",
                extra={
                    "transmission_id": tx.id,
                    "from_status": tx.status,
                    "to_status": normalized_status,
                },
            )
            return False
        tx.status = normalized_status
        tx.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    append_transmission_event(db, tx, event)
    if tx.status != previous_status:
        # The customer webhook outbox is a local database write and therefore
        # belongs to the same transaction as the status transition. If it
        # cannot be persisted, the transition must not commit without it.
        enqueue_einvoicing_webhooks(db, tx=tx, event=event)
    return True


async def submit_einvoice(
    db: Session,
    *,
    provider: PdpProvider,
    invoice: Invoice,
    tenant_id: str,
    channel: str,
    ctx: dict | None = None,
    poll_status: bool = True,
    raise_on_error: bool = True,
    source: str | None = None,
    force_retry: bool = False,
    actor_user_id: str | None = None,
) -> EInvoicingTransmission:
    provider_slug = (getattr(provider, "slug", "") or "").strip().lower()
    access = connected_mode_decision(db, tenant_id, provider_slug or channel)
    if not access.allowed:
        raise PdpProviderError(access.message, code=access.code or "connected_mode_not_operational", retryable=False)
    if not invoice.id:
        raise ValueError("invoice.id manquant pour la soumission plateforme agréée.")
    invoice_id = invoice.id
    try:
        locked_invoice = (
            db.query(Invoice).filter(Invoice.id == invoice_id, Invoice.tenant_id == tenant_id).with_for_update().first()
        )
    except OperationalError as exc:
        raise PdpProviderError(
            "Facture en cours de transmission, réessayez dans un instant.",
            code="einvoicing_in_progress",
        ) from exc
    if locked_invoice is None:
        raise PdpProviderError("Facture introuvable pour la transmission.", code="invoice_not_found")
    invoice = locked_invoice
    ensure_invoice_submission_artifacts_integrity(invoice)
    payload_hash = _submission_payload_hash(invoice, channel)
    idempotency_key = _submission_idempotency_key(
        tenant_id=tenant_id,
        channel=channel,
        invoice_id=invoice_id,
        payload_hash=payload_hash,
    )
    last_tx = db.query(EInvoicingTransmission).filter(EInvoicingTransmission.idempotency_key == idempotency_key).first()
    billed_token_reference_id: str | None = None
    if not last_tx and payload_hash:
        last_tx = (
            db.query(EInvoicingTransmission)
            .filter(
                EInvoicingTransmission.invoice_id == invoice_id,
                EInvoicingTransmission.channel == channel,
                EInvoicingTransmission.payload_hash == payload_hash,
            )
            .order_by(EInvoicingTransmission.created_at.desc())
            .first()
        )
    elif not last_tx:
        last_tx = (
            db.query(EInvoicingTransmission)
            .filter(
                EInvoicingTransmission.invoice_id == invoice_id,
                EInvoicingTransmission.channel == channel,
            )
            .order_by(EInvoicingTransmission.created_at.desc())
            .first()
        )
    if last_tx:
        delivery_state = (getattr(last_tx, "delivery_state", None) or "").strip().lower()
        last_status = (last_tx.status or "").strip().lower()
        if delivery_state == "reconciliation_required":
            raise PdpProviderError(
                "Le résultat du dépôt précédent est incertain. Réconciliez le flux Chorus avant toute nouvelle tentative.",
                code="einvoicing_reconciliation_required",
                retryable=False,
            )
        if last_status in BLOCKING_STATUSES or delivery_state == "failed":
            if not force_retry:
                raise PdpProviderError(
                    "Dernière transmission en échec. Confirmez explicitement une nouvelle tentative.",
                    code="einvoicing_retry_required",
                )
        if delivery_state in {"pending", "submitting"}:
            if last_status not in BLOCKING_STATUSES:
                raise PdpProviderError(
                    "Facture en cours de transmission, réessayez dans un instant.",
                    code="einvoicing_in_progress",
                    retryable=False,
                )
        if delivery_state == "delivered" and last_status not in BLOCKING_STATUSES:
            return last_tx
        if delivery_state == "delivered":
            # A provider-side rejection is still a confirmed remote delivery. The
            # same immutable artifact must not be deposited a second time.
            return last_tx
        if last_status not in BLOCKING_STATUSES and delivery_state:
            return last_tx

    created_new_tx = last_tx is None
    previous_tx: dict[str, Any] | None = None
    if last_tx is not None:
        previous_tx = {
            "idempotency_key": last_tx.idempotency_key,
            "external_id": last_tx.external_id,
            "status": last_tx.status,
            "delivery_state": last_tx.delivery_state,
            "attempt_count": last_tx.attempt_count,
            "last_attempt_at": last_tx.last_attempt_at,
            "updated_at": last_tx.updated_at,
            "events": list(last_tx.events or []),
        }

    _raise_if_trialing_transmission(db, tenant_id)

    if provider_slug == "seqino":
        tenant = db.get(Tenant, tenant_id)
        issuer_siret = "".join(ch for ch in ((tenant.siret or "") if tenant else "") if ch.isdigit())
        issuer_siren = issuer_siret[:9] if len(issuer_siret) >= 9 else None
        if not seqino_has_active_mandate_for_issuer(
            tenant_id,
            siren=issuer_siren,
            siret=issuer_siret if len(issuer_siret) == 14 else None,
            db=db,
        ):
            raise PdpProviderError(
                "Mandat Seqino actif requis pour le SIREN/SIRET de l'entreprise émettrice avant envoi.",
                code="seqino_mandate_missing",
            )
    is_http_generic = _is_http_generic(provider, channel)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if last_tx:
        tx = last_tx
        tx.idempotency_key = idempotency_key
        tx.external_id = None
        tx.status = "unknown"
        tx.delivery_state = "submitting"
        tx.attempt_count = int(getattr(tx, "attempt_count", 0) or 0) + 1
        tx.last_attempt_at = now
        tx.updated_at = now
    else:
        tx = EInvoicingTransmission(
            invoice_id=invoice_id,
            channel=channel,
            external_id=None,
            status="unknown",
            payload_hash=payload_hash,
            idempotency_key=idempotency_key,
            delivery_state="submitting",
            attempt_count=1,
            last_attempt_at=now,
            events=[],
            created_at=now,
            updated_at=now,
        )
        db.add(tx)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        existing = (
            db.query(EInvoicingTransmission).filter(EInvoicingTransmission.idempotency_key == idempotency_key).first()
        )
        if existing:
            if (existing.delivery_state or "").strip().lower() == "delivered":
                return existing
            raise PdpProviderError(
                "Facture en cours de transmission, réessayez dans un instant.",
                code="einvoicing_in_progress",
                retryable=False,
            ) from exc
        raise PdpProviderError(
            "Facture en cours de transmission, réessayez dans un instant.",
            code="einvoicing_in_progress",
        ) from exc

    append_transmission_event(
        db,
        tx,
        _build_event(
            event_type="submission_started",
            status="unknown",
            message="Dépôt préparé et verrouillé avant envoi.",
            source=source or "pdp_submit",
        ),
    )

    # The outbox must be durable before any helper that may commit/rollback its
    # own token-ledger transaction, and always before provider I/O.
    db.commit()
    db.refresh(tx)

    if provider_slug in _TOKEN_BILLED_PROVIDER_SLUGS:
        if last_tx and force_retry:
            reference_id = f"invoice_retry:{tx.id}:{tx.attempt_count}"
        else:
            reference_id = f"invoice:{invoice_id}:{payload_hash or 'initial'}"
        billed_token_reference_id = reference_id
        # consume() commits the token ledger and the outbox row atomically in the
        # same SQLAlchemy session.
        try:
            consume_seqino_tokens_or_raise(
                db,
                tenant_id,
                reference_type=_token_reference_type_for_provider(provider_slug),
                reference_id=reference_id,
                provider_slug=provider_slug,
            )
        except Exception:
            # No provider call happened. Remove the technical reservation so a
            # user can retry normally after fixing billing/preflight state.
            persisted = db.get(EInvoicingTransmission, tx.id)
            if persisted is not None and persisted.delivery_state == "submitting":
                db.delete(persisted)
                db.commit()
            raise
        if provider_slug == "seqino" and not seqino_has_active_mandate_for_issuer(
            tenant_id,
            siren=issuer_siren,
            siret=issuer_siret if len(issuer_siret) == 14 else None,
            db=db,
        ):
            # The token helper commits. Re-check immediately afterwards so a
            # concurrent revocation can never be followed by provider I/O.
            refund_seqino_tokens_after_certain_failure(
                db,
                tenant_id,
                reference_type=_token_reference_type_for_provider(provider_slug),
                reference_id=reference_id,
            )
            persisted = db.get(EInvoicingTransmission, tx.id)
            if persisted is not None and persisted.delivery_state == "submitting":
                db.delete(persisted)
                db.commit()
            raise PdpProviderError(
                "Le mandat Seqino a été révoqué avant l'envoi. Aucun jeton n'a été consommé.",
                code="seqino_mandate_missing",
                retryable=False,
            )
    db.refresh(tx)

    submit_ctx = ctx
    if settings.PDP_IDEMPOTENCY_KEY_ENABLED:
        submit_ctx = dict(ctx or {})
        submit_ctx.setdefault("idempotency_key", idempotency_key)

    try:
        # Unsafe POSTs are intentionally single-attempt here. Read-only status
        # reconciliation retains bounded retries in _poll_status_with_retry().
        result: TransmissionResult = await provider.send_invoice(invoice, submit_ctx)
    except PdpPreSubmitCancelled:
        _refund_einvoicing_token_after_failed_submit(
            db,
            tenant_id,
            provider_slug=provider_slug,
            reference_id=billed_token_reference_id,
        )
        _restore_pre_submit_reservation(
            db,
            tx,
            created_new=created_new_tx,
            previous=previous_tx,
        )
        raise
    except asyncio.CancelledError:
        # A raw cancellation means the unsafe provider call may have started.
        # Persist the replay barrier before propagating process/request shutdown.
        tx.delivery_state = "reconciliation_required"
        tx.status = "unknown"
        tx.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        append_transmission_event(
            db,
            tx,
            _build_event(
                event_type="reconciliation_required",
                status="unknown",
                message="Dépôt interrompu après le démarrage possible de l'envoi ; réconciliation requise.",
                source=source or "pdp_submit",
            ),
        )
        db.add(tx)
        db.commit()
        raise
    except PdpPreSubmitError:
        _refund_einvoicing_token_after_failed_submit(
            db,
            tenant_id,
            provider_slug=provider_slug,
            reference_id=billed_token_reference_id,
        )
        _restore_pre_submit_reservation(
            db,
            tx,
            created_new=created_new_tx,
            previous=previous_tx,
        )
        raise
    except Exception as exc:
        submission_outcome = (
            (getattr(exc, "submission_outcome", None) or "").strip().lower()
            if isinstance(exc, PdpProviderError)
            else ""
        )
        if submission_outcome == "not_sent":
            _refund_einvoicing_token_after_failed_submit(
                db,
                tenant_id,
                provider_slug=provider_slug,
                reference_id=billed_token_reference_id,
            )
            _restore_pre_submit_reservation(
                db,
                tx,
                created_new=created_new_tx,
                previous=previous_tx,
            )
            raise
        ambiguous = _submission_error_is_ambiguous(exc)
        tx.delivery_state = "reconciliation_required" if ambiguous else "failed"
        tx.status = "unknown" if ambiguous else "failed"
        tx.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        if not ambiguous:
            _refund_einvoicing_token_after_failed_submit(
                db,
                tenant_id,
                provider_slug=provider_slug,
                reference_id=billed_token_reference_id,
            )
        event = _build_event(
            event_type="reconciliation_required" if ambiguous else "error",
            status=tx.status,
            message=(
                "Résultat du dépôt incertain; nouvelle tentative bloquée jusqu'à réconciliation."
                if ambiguous
                else "Soumission refusée avant confirmation du dépôt."
            ),
            errors=[_summarize_error(exc)],
            source=source or "pdp_submit",
        )
        append_transmission_event(db, tx, event)
        db.add(tx)
        if is_http_generic:
            _log_http_generic_submit(
                db,
                tenant_id=tenant_id,
                invoice_id=invoice_id,
                payload_hash=payload_hash,
                status=tx.delivery_state,
                error_code=_http_generic_error_code(exc),
            )
        log_action(
            db,
            tenant_id=tenant_id,
            actor_user_id=actor_user_id,
            action_type="pdp_submit",
            object_type="invoice",
            object_id=invoice_id,
            metadata={
                "channel": channel,
                "status": tx.status,
                "transmission_id": tx.id,
                "external_id": tx.external_id,
                "payload_hash": tx.payload_hash,
                "source": source,
            },
        )
        db.commit()
        db.refresh(tx)
        _record_billable_submit(
            db,
            tenant_id=tenant_id,
            invoice_id=invoice_id,
            channel=channel,
            tx=tx,
        )
        logger.warning(
            "pdp_submit_failed",
            extra={"invoice_id": invoice_id, "tenant_id": tenant_id, "provider": channel},
        )
        metrics.inc_pdp_submit(channel)
        if raise_on_error:
            if ambiguous:
                raise PdpProviderError(
                    "Le résultat du dépôt est incertain. La nouvelle tentative est bloquée jusqu'à réconciliation.",
                    code="einvoicing_reconciliation_required",
                    retryable=False,
                ) from exc
            raise
        return tx

    status = normalize_status(result.status or "submitted")
    events = list(result.events or [])
    if not events:
        events.append(
            _build_event(
                event_type="submit",
                status=status,
                message=result.message or "Soumission enregistree",
                raw_status=result.raw_status,
                errors=result.errors,
                source=source or "pdp_submit",
            )
        )

    tx.external_id = result.external_id or None
    tx.status = status
    tx.payload_hash = payload_hash or result.payload_hash
    tx.delivery_state = "delivered"
    tx.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(tx)
    for event in events:
        if not event.get("event_type"):
            event["event_type"] = "submit"
        if not event.get("status"):
            event["status"] = status
        if source and not event.get("source"):
            event["source"] = source
        _apply_event(db, tx, event)

    db.add(tx)
    if is_http_generic:
        _log_http_generic_submit(
            db,
            tenant_id=tenant_id,
            invoice_id=invoice_id,
            payload_hash=payload_hash or result.payload_hash,
            status=status,
        )
    log_action(
        db,
        tenant_id=tenant_id,
        actor_user_id=actor_user_id,
        action_type="pdp_submit",
        object_type="invoice",
        object_id=invoice_id,
        metadata={
            "channel": channel,
            "status": tx.status,
            "transmission_id": tx.id,
            "external_id": tx.external_id,
            "payload_hash": tx.payload_hash,
            "source": source,
        },
    )
    # Persist the confirmed remote delivery before any optional read-only poll.
    # A shutdown during polling can then never leave the durable row submitting.
    db.commit()
    db.refresh(tx)
    _record_billable_submit(
        db,
        tenant_id=tenant_id,
        invoice_id=invoice_id,
        channel=channel,
        tx=tx,
    )
    metrics.inc_pdp_submit(channel)

    if poll_status and tx.external_id:
        try:
            status_result = await _poll_status_with_retry(provider, tx.external_id)
        except Exception:
            status_result = None
        if status_result:
            previous_status = tx.status
            _apply_status_result(db, tx, status_result, source=source or "pdp_status")
            if tx.status != previous_status:
                log_action(
                    db,
                    tenant_id=tenant_id,
                    actor_user_id=actor_user_id,
                    action_type="pdp_status_update",
                    object_type="invoice",
                    object_id=invoice_id,
                    metadata={
                        "channel": tx.channel,
                        "transmission_id": tx.id,
                        "from": previous_status,
                        "to": tx.status,
                        "external_id": tx.external_id,
                        "source": source or "pdp_status",
                    },
                )

    db.add(tx)
    db.commit()
    db.refresh(tx)
    return tx


def update_transmission_status(
    db: Session,
    *,
    tx: EInvoicingTransmission,
    tenant_id: str,
    status_result: StatusResult,
    source: str | None = None,
    actor_user_id: str | None = None,
) -> None:
    previous_status = tx.status
    _apply_status_result(db, tx, status_result, source=source or "pdp_status")
    if tx.status != previous_status:
        if not tx.invoice_id:
            return
        log_action(
            db,
            tenant_id=tenant_id,
            actor_user_id=actor_user_id,
            action_type="pdp_status_update",
            object_type="invoice",
            object_id=tx.invoice_id,
            metadata={
                "channel": tx.channel,
                "transmission_id": tx.id,
                "from": previous_status,
                "to": tx.status,
                "external_id": tx.external_id,
                "source": source or "pdp_status",
            },
        )


def _apply_status_result(
    db: Session,
    tx: EInvoicingTransmission,
    status_result: StatusResult,
    *,
    source: str | None = None,
) -> None:
    events = list(status_result.events or [])
    if events:
        for event in events:
            event_status = event.get("status") or status_result.status or tx.status
            event["status"] = normalize_status(str(event_status) if event_status is not None else None)
            if not event.get("event_type"):
                event["event_type"] = "status_update"
            if source and not event.get("source"):
                event["source"] = source
            _apply_event(db, tx, event)
        return
    if not status_result.status:
        return
    event = _build_event(
        event_type="status_update",
        status=status_result.status,
        message="Statut synchronise",
        raw_status=status_result.raw_status,
        errors=status_result.errors,
        source=source,
    )
    _apply_event(db, tx, event)
