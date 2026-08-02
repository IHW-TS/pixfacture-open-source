from __future__ import annotations

import csv
import codecs
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..config import settings
from ..db import get_db
from ..deps import (
    require_product_feature,
    require_subscription_active,
    require_tenant_admin,
    require_viewer_or_admin,
    AuthUser,
)
from ..models import RecipientDirectoryEntry, Customer, DirectorySyncRun, PdpConnection, Tenant
from ..schemas import (
    ChorusDirectoryLookupRequest,
    RecipientDirectoryEntryCreate,
    RecipientDirectoryEntryOut,
    DirectorySyncRunOut,
)
from ..core.plans import Plan
from ..services.directory import (
    _upsert_entry,
    list_directory_connectors,
    lookup_directory_entry,
    is_ppf_configured,
)
from ..services.connected_mode import ensure_connected_mode_operational
from ..services.pdp.service import resolve_provider
from ..services.pdp.utils import PdpProviderError
from ..services.chorus import ChorusClient, chorus_cpro_account_is_valid
from ..services.integration_secrets import enrich_credentials_with_secrets, resolve_chorus_cpro_account
from ..services.product_capabilities import normalize_plan
from ..services.action_logs import log_action
from ..utils.seqino_http import seqino_http_status
from ..jobs.directory import enqueue_directory_refresh


router = APIRouter(
    prefix="/api/directory",
    tags=["directory"],
    dependencies=[
        Depends(require_product_feature("einvoicing_enabled")),
        Depends(require_viewer_or_admin),
    ],
)

MAX_DIRECTORY_CSV_BYTES = 5 * 1024 * 1024
MAX_DIRECTORY_CSV_ROWS = 10_000
CSV_CHUNK_SIZE = 64 * 1024
CSV_SNIFF_BYTES = 2048

def _normalize_digits(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _seqino_entry_stale(entry: RecipientDirectoryEntry | None) -> bool:
    if not entry or (entry.source or "").strip().lower() != "seqino":
        return entry is None
    if not entry.last_synced_at:
        return True
    ttl = int(entry.ttl_seconds or 86400)
    return entry.last_synced_at + timedelta(seconds=ttl) <= datetime.now(timezone.utc).replace(tzinfo=None)


async def _lookup_seqino_entry(
    db: Session,
    *,
    tenant_id: str,
    siren: str,
    siret: str | None,
    routing_code: str | None,
) -> RecipientDirectoryEntry | None:
    connection = (
        db.query(PdpConnection)
        .filter(
            PdpConnection.tenant_id == tenant_id,
            PdpConnection.provider_slug == "seqino",
            PdpConnection.status == "connected",
        )
        .first()
    )
    if not connection:
        return None
    ensure_connected_mode_operational(db, tenant_id, "seqino")
    provider, _credentials = resolve_provider(connection, db)
    lookup = getattr(provider, "lookup_directory", None)
    if not callable(lookup):
        return None
    try:
        items = await lookup(siren)
    except PdpProviderError as exc:
        raise HTTPException(
            status_code=seqino_http_status(exc.code),
            detail={
                "code": exc.code or "seqino_directory_failed",
                "message": "La consultation de l'annuaire plateforme partenaire a échoué.",
            },
        ) from exc
    selected = None
    for item in items:
        item_siret = _normalize_digits(str(item.get("siret") or "")) or None
        item_routing = str(item.get("routing_identifier") or item.get("suffix") or "").strip()
        if siret and item_siret != siret:
            continue
        if routing_code and item_routing != routing_code:
            continue
        selected = item
        break
    if not selected and not siret and not routing_code and items:
        selected = items[0]
    if not selected:
        return None
    peppol_address = str(selected.get("peppol_address") or "").strip()
    if not peppol_address:
        return None
    selected_siret = _normalize_digits(str(selected.get("siret") or "")) or None
    payload = {
        "siren": siren,
        "siret": selected_siret,
        "platform_slug": "seqino",
        "billing_address": peppol_address,
        "routing_code": selected.get("suffix") or selected.get("routing_code_label"),
        "routing_identifier": selected.get("routing_identifier"),
        "platform_attached": bool(selected.get("addressable", True)),
        "billing_address_active": bool(selected.get("addressable", True)),
        "service_code_required": None,
        "commitment_required": selected.get("legal_commitment_management"),
        "public_entity": None,
        "raw_payload": {
            "name": selected.get("name"),
            "administrative_status": selected.get("administrative_status"),
            "establishment_nature": selected.get("establishment_nature"),
        },
        "ttl_seconds": 86400,
    }
    entry = _upsert_entry(
        db,
        tenant_id,
        payload,
        source="seqino",
        now=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.commit()
    db.refresh(entry)
    return entry


def _chorus_read_client(db: Session, tenant_id: str) -> ChorusClient:
    credentials = enrich_credentials_with_secrets(db, tenant_id, {})
    return ChorusClient(
        client_id=credentials.get("piste_client_id"),
        client_secret=credentials.get("piste_client_secret"),
        token_url=credentials.get("piste_token_url"),
        api_base=credentials.get("chorus_api_base"),
        cpro_account=credentials.get("chorus_cpro_account"),
    )


def _chorus_lookup_not_found() -> HTTPException:
    return HTTPException(
        404,
        detail={
            "code": "chorus_recipient_not_found",
            "message": "Destinataire public actif introuvable dans l'annuaire Chorus.",
        },
    )


def _raise_chorus_lookup_failure(exc: PdpProviderError) -> None:
    code = str(getattr(exc, "code", "") or "")
    if code in {"chorus_cpro_account_missing", "chorus_cpro_account_invalid", "chorus_read_config_missing"}:
        raise HTTPException(
            409,
            detail={"code": "chorus_connection_not_configured", "message": "Connexion Chorus non configurée."},
        ) from exc
    if code in {"chorus_auth_failed", "chorus_read_forbidden"}:
        raise HTTPException(
            409,
            detail={"code": "chorus_verification_failed", "message": "La vérification Chorus a échoué."},
        ) from exc
    raise HTTPException(
        502,
        detail={"code": "chorus_read_failed", "message": "La consultation Chorus est indisponible."},
    ) from exc


def _raise_csv_too_large() -> None:
    max_mb = MAX_DIRECTORY_CSV_BYTES // (1024 * 1024)
    raise HTTPException(
        400,
        detail={
            "code": "directory_csv_too_large",
            "message": f"CSV trop volumineux (max {max_mb}MB).",
        },
    )


def _iter_csv_rows(file: UploadFile):
    if not file:
        raise HTTPException(400, detail={"code": "csv_empty", "message": "CSV vide."})
    try:
        file.file.seek(0)
    except Exception:
        pass
    decoder = codecs.getincrementaldecoder("utf-8-sig")()
    total_bytes = 0
    sample_bytes = file.file.read(CSV_SNIFF_BYTES)
    total_bytes += len(sample_bytes)
    if total_bytes == 0:
        raise HTTPException(400, detail={"code": "csv_empty", "message": "CSV vide."})
    if total_bytes > MAX_DIRECTORY_CSV_BYTES:
        _raise_csv_too_large()
    try:
        sample_text = decoder.decode(sample_bytes)
    except UnicodeDecodeError:
        raise HTTPException(400, detail={"code": "csv_invalid_encoding", "message": "Encodage CSV invalide (UTF-8 attendu)."})
    sample = sample_text[:CSV_SNIFF_BYTES]
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.get_dialect("excel")

    def line_iter():
        nonlocal total_bytes
        buffer = sample_text
        while True:
            while True:
                newline_idx = buffer.find("\n")
                if newline_idx == -1:
                    break
                line = buffer[: newline_idx + 1]
                buffer = buffer[newline_idx + 1 :]
                yield line
            chunk = file.file.read(CSV_CHUNK_SIZE)
            if not chunk:
                break
            total_bytes += len(chunk)
            if total_bytes > MAX_DIRECTORY_CSV_BYTES:
                _raise_csv_too_large()
            try:
                buffer += decoder.decode(chunk)
            except UnicodeDecodeError:
                raise HTTPException(400, detail={"code": "csv_invalid_encoding", "message": "Encodage CSV invalide (UTF-8 attendu)."})
        try:
            buffer += decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            raise HTTPException(400, detail={"code": "csv_invalid_encoding", "message": "Encodage CSV invalide (UTF-8 attendu)."})
        if buffer:
            yield buffer

    reader = csv.DictReader(line_iter(), dialect=dialect)
    try:
        first_row = next(reader)
        has_first_row = True
    except StopIteration:
        first_row = None
        has_first_row = False
    if not reader.fieldnames:
        raise HTTPException(400, detail={"code": "csv_missing_header", "message": "En-tetes CSV manquants."})
    if has_first_row:
        yield first_row
    for row in reader:
        yield row


def _pick_value(row: dict, keys: list[str]) -> str | None:
    for key in keys:
        if key in row and row[key] is not None:
            value = str(row[key]).strip()
            if value:
                return value
    return None


def _pick_bool(row: dict, keys: list[str]) -> bool | None:
    value = _pick_value(row, keys)
    if value is None:
        return None
    raw = value.strip().lower()
    if raw in {"1", "true", "vrai", "yes", "oui", "y", "active", "actif", "required", "obligatoire"}:
        return True
    if raw in {"0", "false", "faux", "no", "non", "n", "inactive", "inactif", "optional", "facultatif"}:
        return False
    return None


@router.get("/connectors")
def list_connectors():
    return {"connectors": [c.as_dict() for c in list_directory_connectors()]}


@router.get("/entries", response_model=list[RecipientDirectoryEntryOut])
def list_entries(
    siren: str | None = None,
    siret: str | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_subscription_active),
):
    q = db.query(RecipientDirectoryEntry).filter(RecipientDirectoryEntry.tenant_id == user.tenant_id)
    if siren:
        q = q.filter(RecipientDirectoryEntry.siren == _normalize_digits(siren))
    if siret:
        q = q.filter(RecipientDirectoryEntry.siret == _normalize_digits(siret))
    return q.order_by(RecipientDirectoryEntry.updated_at.desc()).all()


@router.get("/lookup", response_model=RecipientDirectoryEntryOut)
async def lookup_entry(
    siren: str | None = None,
    siret: str | None = None,
    routing_code: str | None = None,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_subscription_active),
):
    if not siren and not siret:
        raise HTTPException(400, detail={"code": "directory_lookup_required", "message": "SIREN ou SIRET requis."})
    entry = lookup_directory_entry(
        db,
        user.tenant_id,
        siren=siren,
        siret=siret,
        routing_code=routing_code,
        allow_remote=not settings.EINVOICING_EXPORT_ONLY,
    )
    siren_norm = _normalize_digits(siren) or (_normalize_digits(siret)[:9] if siret else "")
    siret_norm = _normalize_digits(siret) or None
    if not settings.EINVOICING_EXPORT_ONLY and siren_norm and _seqino_entry_stale(entry):
        seqino_entry = await _lookup_seqino_entry(
            db,
            tenant_id=user.tenant_id,
            siren=siren_norm,
            siret=siret_norm,
            routing_code=routing_code,
        )
        entry = seqino_entry or entry
    if not entry:
        raise HTTPException(404, detail={"code": "directory_entry_missing", "message": "Aucune entree pour ce destinataire."})
    return entry


@router.post("/chorus/lookup", response_model=RecipientDirectoryEntryOut)
async def lookup_chorus_recipient(
    payload: ChorusDirectoryLookupRequest,
    response: Response,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
):
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant or tenant.deleted_at is not None:
        raise HTTPException(404, detail={"code": "tenant_not_found", "message": "Entreprise introuvable."})
    if normalize_plan(tenant.plan) not in {Plan.PRO, Plan.ENTERPRISE}:
        raise HTTPException(
            403,
            detail={"code": "plan_upgrade_required", "message": "Le plan Pro est requis pour consulter Chorus."},
        )
    if (tenant.subscription_status or "").strip().lower() != "active":
        raise HTTPException(
            409,
            detail={
                "code": "subscription_reactivation_required",
                "message": "Un abonnement Pro actif est requis pour consulter Chorus.",
            },
        )
    connection = (
        db.query(PdpConnection)
        .filter(
            PdpConnection.tenant_id == tenant.id,
            PdpConnection.provider_slug == "choruspro",
            PdpConnection.status.in_({"verified", "connected"}),
        )
        .first()
    )
    tenant_siret = _normalize_digits(tenant.siret)
    if (
        not connection
        or len(tenant_siret) != 14
        or connection.verified_siret != tenant_siret
        or not connection.verified_structure_id
        or connection.verified_at is None
    ):
        raise HTTPException(
            409,
            detail={"code": "chorus_connection_not_verified", "message": "Connexion Chorus non vérifiée."},
        )
    cpro_account = resolve_chorus_cpro_account(db, tenant.id)
    if not chorus_cpro_account_is_valid(cpro_account):
        raise HTTPException(
            409,
            detail={"code": "chorus_connection_not_configured", "message": "Connexion Chorus non configurée."},
        )

    client = _chorus_read_client(db, tenant.id)
    try:
        siret_information = await client.get_siret_information(payload.siret)
        if siret_information.get("siret") != payload.siret or siret_information.get("active") is not True:
            raise _chorus_lookup_not_found()
        recipients = await client.search_public_recipient(payload.siret)
        exact_recipients = [item for item in recipients if item.get("siret") == payload.siret]
        if len(exact_recipients) != 1:
            raise _chorus_lookup_not_found()
        selected = exact_recipients[0]
        structure_id = selected.get("idStructureCPP")
        if structure_id is None:
            raise _chorus_lookup_not_found()
        details = await client.get_structure_details(structure_id)
        if details.get("public") is not True:
            raise _chorus_lookup_not_found()
        services = await client.get_structure_services(structure_id)

        selected_service = None
        service_commitment_required = False
        service_rules_complete = False
        if payload.service_code:
            matching_services = [
                service for service in services if service.get("codeService") == payload.service_code
            ]
            if len(matching_services) != 1 or matching_services[0].get("idService") is None:
                raise _chorus_lookup_not_found()
            active_service = matching_services[0]
            service_details = await client.get_structure_service_details(
                structure_id,
                active_service["idService"],
                expected_code=payload.service_code,
            )
            service_commitment_required = bool(service_details["commitment_required"])
            service_rules_complete = True
            selected_service = {
                "codeService": active_service["codeService"],
                "libelleService": active_service.get("libelleService"),
                "commitmentRequired": service_commitment_required,
            }
    except HTTPException:
        raise
    except PdpProviderError as exc:
        _raise_chorus_lookup_failure(exc)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    sanitized_services = [
        {
            "codeService": service["codeService"],
            "libelleService": service.get("libelleService"),
        }
        for service in services
        if service.get("codeService")
    ]
    structure_commitment_required = details.get("commitment_required")
    if structure_commitment_required is None:
        effective_commitment_required = service_commitment_required if service_rules_complete else None
    else:
        effective_commitment_required = bool(structure_commitment_required or service_commitment_required)
    entry = _upsert_entry(
        db,
        tenant.id,
        {
            "siren": payload.siret[:9],
            "siret": payload.siret,
            "platform_slug": "choruspro",
            "billing_address": payload.siret,
            "routing_code": payload.service_code,
            "routing_identifier": str(structure_id),
            "platform_attached": True,
            # This flag is backed by consulterInformationSiret.estActif. It is
            # not inferred from the presence of a postal address.
            "billing_address_active": True,
            "service_code_required": details.get("service_code_required"),
            "commitment_required": effective_commitment_required,
            "service_or_commitment_required": details.get("service_or_commitment_required"),
            "public_entity": True,
            "raw_payload": {
                "idStructureCPP": structure_id,
                "designation": details.get("designation") or selected.get("nomDestinataire"),
                "services": sanitized_services,
                "selected_service": selected_service,
                "service_rules_complete": service_rules_complete,
            },
            "ttl_seconds": 24 * 60 * 60,
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
    db.commit()
    db.refresh(entry)
    response.headers["Cache-Control"] = "no-store"
    return entry


@router.post("/refresh")
def refresh_directory(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_subscription_active),
):
    ensure_connected_mode_operational(db, user.tenant_id)
    if not is_ppf_configured():
        raise HTTPException(400, detail={"code": "ppf_not_configured", "message": "Annuaire PPF non configuré."})
    return enqueue_directory_refresh(user.tenant_id)


@router.get("/status")
def directory_status(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_subscription_active),
):
    total_customers = db.query(Customer).filter(Customer.tenant_id == user.tenant_id).count()
    with_endpoint = (
        db.query(Customer)
        .filter(
            Customer.tenant_id == user.tenant_id,
            Customer.endpoint_id.isnot(None),
            Customer.endpoint_id != "",
        )
        .count()
    )
    coverage_rate = round((with_endpoint / total_customers) * 100, 1) if total_customers else 0.0
    ppf_entries = (
        db.query(RecipientDirectoryEntry)
        .filter(RecipientDirectoryEntry.tenant_id == user.tenant_id, RecipientDirectoryEntry.source == "ppf")
        .count()
    )
    last_ppf_sync = (
        db.query(func.max(RecipientDirectoryEntry.last_synced_at))
        .filter(RecipientDirectoryEntry.tenant_id == user.tenant_id, RecipientDirectoryEntry.source == "ppf")
        .scalar()
    )
    runs = (
        db.query(DirectorySyncRun)
        .filter(DirectorySyncRun.tenant_id == user.tenant_id)
        .order_by(DirectorySyncRun.started_at.desc())
        .limit(5)
        .all()
    )
    recent_syncs = [DirectorySyncRunOut.model_validate(run).model_dump() for run in runs]
    return {
        "ppf_configured": is_ppf_configured(),
        "coverage": {
            "total_customers": total_customers,
            "with_endpoint": with_endpoint,
            "coverage_rate": coverage_rate,
        },
        "ppf_entries": ppf_entries,
        "last_ppf_sync_at": last_ppf_sync,
        "recent_syncs": recent_syncs,
    }


@router.post("/entries", response_model=RecipientDirectoryEntryOut)
def create_entry(
    payload: RecipientDirectoryEntryCreate,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_subscription_active),
):
    ensure_connected_mode_operational(db, user.tenant_id)
    siren = _normalize_digits(payload.siren)
    siret = _normalize_digits(payload.siret) if payload.siret else None
    entry = RecipientDirectoryEntry(
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
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.post("/import")
def import_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(require_tenant_admin),
    _: AuthUser = Depends(require_subscription_active),
):
    ensure_connected_mode_operational(db, user.tenant_id)
    rows = _iter_csv_rows(file)
    created = 0
    updated = 0
    errors: list[dict] = []
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    total = 0

    for idx, row in enumerate(rows, start=2):
        total += 1
        if MAX_DIRECTORY_CSV_ROWS and total > MAX_DIRECTORY_CSV_ROWS:
            db.rollback()
            raise HTTPException(
                400,
                detail={
                    "code": "directory_csv_too_many_rows",
                    "message": f"Import limite a {MAX_DIRECTORY_CSV_ROWS} lignes.",
                },
            )
        siren = _pick_value(row, ["siren", "SIREN"])
        siret = _pick_value(row, ["siret", "SIRET"])
        platform_slug = _pick_value(row, ["platform_slug", "platform", "plateforme_slug", "plateforme", "platforme"])
        billing_address = _pick_value(row, ["adresse_facturation", "billing_address", "address", "adresse"])
        routing_code = _pick_value(row, ["routing_code", "code_routage", "routingCode"])
        routing_identifier = _pick_value(row, ["routing_identifier", "identifiant_routage", "endpoint_id"])
        platform_attached = _pick_bool(row, ["platform_attached", "plateforme_rattachee"])
        billing_address_active = _pick_bool(row, ["billing_address_active", "adresse_facturation_active", "adresse_active"])
        service_code_required = _pick_bool(row, ["service_code_required", "code_service_required", "code_service_obligatoire"])
        commitment_required = _pick_bool(row, ["commitment_required", "engagement_required", "engagement_juridique_obligatoire"])
        public_entity = _pick_bool(row, ["public_entity", "entite_publique", "secteur_public"])

        siren_norm = _normalize_digits(siren)
        siret_norm = _normalize_digits(siret) if siret else None

        if not siren_norm or len(siren_norm) != 9:
            errors.append({"row": idx, "field": "siren", "message": "SIREN invalide (9 chiffres)."})
            continue
        if siret_norm and len(siret_norm) != 14:
            errors.append({"row": idx, "field": "siret", "message": "SIRET invalide (14 chiffres)."})
            continue
        if not platform_slug:
            errors.append({"row": idx, "field": "platform_slug", "message": "Plateforme manquante."})
            continue
        query = db.query(RecipientDirectoryEntry).filter(
            RecipientDirectoryEntry.tenant_id == user.tenant_id,
            RecipientDirectoryEntry.siren == siren_norm,
        )
        if siret_norm:
            query = query.filter(RecipientDirectoryEntry.siret == siret_norm)
        else:
            query = query.filter(RecipientDirectoryEntry.siret.is_(None))
        entry = query.first()

        if entry:
            entry.platform_slug = platform_slug.strip()
            entry.billing_address = (billing_address or "").strip()
            entry.routing_code = (routing_code or "").strip() or None
            entry.routing_identifier = (routing_identifier or "").strip() or None
            entry.platform_attached = platform_attached
            entry.billing_address_active = billing_address_active
            entry.service_code_required = service_code_required
            entry.commitment_required = commitment_required
            entry.public_entity = public_entity
            entry.source = "import"
            entry.updated_at = now
            updated += 1
        else:
            entry = RecipientDirectoryEntry(
                tenant_id=user.tenant_id,
                siren=siren_norm,
                siret=siret_norm,
                platform_slug=platform_slug.strip(),
                billing_address=(billing_address or "").strip(),
                routing_code=(routing_code or "").strip() or None,
                routing_identifier=(routing_identifier or "").strip() or None,
                platform_attached=platform_attached,
                billing_address_active=billing_address_active,
                service_code_required=service_code_required,
                commitment_required=commitment_required,
                public_entity=public_entity,
                source="import",
                created_at=now,
                updated_at=now,
            )
            db.add(entry)
            created += 1

    db.commit()
    return {
        "ok": True,
        "created": created,
        "updated": updated,
        "errors": errors,
        "total": total,
    }
