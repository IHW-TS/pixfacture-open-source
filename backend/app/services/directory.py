from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import httpx
from sqlalchemy.orm import Session

from ..config import settings
from ..models import RecipientDirectoryEntry
from ..utils.ssrf import validate_outbound_url
from .connected_mode import connected_mode_decision

logger = logging.getLogger(__name__)

DEFAULT_LOOKUP_PATH = "/lookup"
DEFAULT_BULK_PATH = "/bulk"
DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=5.0)
DEFAULT_TTL_SECONDS = 24 * 60 * 60
DEFAULT_BULK_PAGE_SIZE = 200
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_BASE_SECONDS = 0.4
RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}

_TOKEN_CACHE: dict[str, dict[str, Any]] = {}
TOKEN_REFRESH_BUFFER_SECONDS = 60
TOKEN_DEFAULT_TTL_SECONDS = 3600


@dataclass(frozen=True)
class DirectoryLookupInput:
    siren: str
    siret: str | None = None
    routing_code: str | None = None


@dataclass
class DirectoryConnector:
    slug: str
    label: str
    status: str = "stub"
    description: str | None = None

    def as_dict(self) -> dict:
        return {
            "slug": self.slug,
            "label": self.label,
            "status": self.status,
            "description": self.description,
        }


def _normalize_digits(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ppf_cache_key() -> str:
    raw = f"{settings.PPF_DIRECTORY_CLIENT_ID}|{settings.PPF_DIRECTORY_TOKEN_URL}"
    return f"ppf-token:{raw}"


def _get_cached_token(cache_key: str) -> str | None:
    now = time.time()
    cached = _TOKEN_CACHE.get(cache_key)
    if not cached:
        return None
    expires_at = cached.get("expires_at") or 0
    if expires_at - now <= TOKEN_REFRESH_BUFFER_SECONDS:
        return None
    return cached.get("token")


def _store_token(cache_key: str, token: str, expires_in: int) -> None:
    expires_at = time.time() + max(0, expires_in)
    _TOKEN_CACHE[cache_key] = {"token": token, "expires_at": expires_at}


def _retry_delay(attempt: int) -> float:
    return min(RETRY_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), 3.0)


def _request_with_retry(client: httpx.Client, method: str, url: str, **kwargs) -> httpx.Response:
    last_exc: Exception | None = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            response = client.request(method, url, **kwargs)
        except httpx.TransportError as exc:
            last_exc = exc
            if attempt >= RETRY_ATTEMPTS:
                raise
        else:
            if response.status_code not in RETRYABLE_STATUS or attempt >= RETRY_ATTEMPTS:
                return response
        time.sleep(_retry_delay(attempt))
    if last_exc:
        raise last_exc
    raise RuntimeError("PPF request failed without response")


def _extract_value(entry: dict[str, Any], keys: Iterable[str]) -> str | None:
    for key in keys:
        if key not in entry:
            continue
        value = entry.get(key)
        if value is None:
            continue
        if isinstance(value, dict):
            for sub_key in ("slug", "code", "name", "label", "value"):
                sub_val = value.get(sub_key)
                if sub_val:
                    return str(sub_val).strip()
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _extract_bool(entry: dict[str, Any], keys: Iterable[str]) -> bool | None:
    for key in keys:
        if key not in entry:
            continue
        value = entry.get(key)
        if value is None:
            continue
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        raw = str(value).strip().lower()
        if not raw:
            continue
        if raw in {"1", "true", "vrai", "yes", "oui", "y", "active", "actif", "required", "obligatoire"}:
            return True
        if raw in {"0", "false", "faux", "no", "non", "n", "inactive", "inactif", "optional", "facultatif"}:
            return False
    return None


def _extract_ttl(entry: dict[str, Any]) -> int | None:
    ttl_raw = _extract_value(entry, ("ttl", "ttl_seconds", "cache_ttl", "validity_seconds"))
    if not ttl_raw:
        return None
    try:
        ttl = int(float(ttl_raw))
    except (TypeError, ValueError):
        return None
    return ttl if ttl > 0 else None


def _extract_entries(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("results", "entries", "destinataires", "items", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return [payload]


def _parse_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    siren = _normalize_digits(_extract_value(entry, ("siren", "numero_siren", "siren_number", "id_siren")))
    siret = _normalize_digits(_extract_value(entry, ("siret", "numero_siret", "siret_number", "id_siret")))
    if not siren and siret and len(siret) >= 9:
        siren = siret[:9]
    platform_slug = _extract_value(
        entry,
        (
            "platform_slug",
            "platform",
            "plateforme",
            "plateforme_slug",
            "pdp",
            "pdp_name",
            "plateforme_agreee",
            "plateforme_immatriculee",
        ),
    )
    billing_address = _extract_value(
        entry,
        (
            "billing_address",
            "adresse_facturation",
            "address",
            "adresse",
            "endpoint_id",
            "endpoint",
            "identifiant_reception",
            "identifiant_routage",
        ),
    )
    routing_code = _extract_value(entry, ("routing_code", "code_routage", "routingCode"))
    routing_identifier = _extract_value(
        entry,
        (
            "routing_identifier",
            "identifiant_routage",
            "identifiantReception",
            "identifiant_reception",
            "endpoint_id",
            "endpoint",
        ),
    )
    platform_attached = _extract_bool(
        entry,
        (
            "platform_attached",
            "plateforme_rattachee",
            "plateforme_attached",
            "rattache_plateforme",
            "rattachee_plateforme",
        ),
    )
    billing_address_active = _extract_bool(
        entry,
        (
            "billing_address_active",
            "adresse_facturation_active",
            "adresse_active",
            "active",
            "actif",
        ),
    )
    service_code_required = _extract_bool(
        entry,
        (
            "service_code_required",
            "code_service_required",
            "codeServiceObligatoire",
            "obligation_code_service",
        ),
    )
    commitment_required = _extract_bool(
        entry,
        (
            "commitment_required",
            "engagement_required",
            "engagement_juridique_required",
            "engagement_juridique_obligatoire",
            "engagementJuridiqueObligatoire",
            "obligation_engagement_juridique",
        ),
    )
    service_or_commitment_required = _extract_bool(
        entry,
        (
            "service_or_commitment_required",
            "gestionNumeroEJOuCodeService",
        ),
    )
    public_entity = _extract_bool(entry, ("public_entity", "entite_publique", "secteur_public", "public"))
    ttl_seconds = _extract_ttl(entry)

    if not platform_slug or not siren:
        return None
    return {
        "siren": siren,
        "siret": siret or None,
        "platform_slug": platform_slug.strip(),
        "billing_address": billing_address.strip() if billing_address else "",
        "routing_code": routing_code.strip() if routing_code else None,
        "routing_identifier": routing_identifier.strip() if routing_identifier else None,
        "platform_attached": platform_attached,
        "billing_address_active": billing_address_active,
        "service_code_required": service_code_required,
        "commitment_required": commitment_required,
        "service_or_commitment_required": service_or_commitment_required,
        "public_entity": public_entity,
        "raw_payload": entry,
        "ttl_seconds": ttl_seconds,
    }


def _should_refresh(entry: RecipientDirectoryEntry, now: datetime) -> bool:
    if (entry.source or "").lower() != "ppf":
        return False
    if not entry.last_synced_at:
        return True
    ttl_seconds = entry.ttl_seconds or DEFAULT_TTL_SECONDS
    return entry.last_synced_at + timedelta(seconds=ttl_seconds) <= now


def is_ppf_configured() -> bool:
    return bool(
        (settings.PPF_DIRECTORY_BASE_URL or "").strip()
        and (settings.PPF_DIRECTORY_CLIENT_ID or "").strip()
        and (settings.PPF_DIRECTORY_CLIENT_SECRET or "").strip()
        and (settings.PPF_DIRECTORY_TOKEN_URL or "").strip()
    )


def _ppf_base_url() -> str:
    return (settings.PPF_DIRECTORY_BASE_URL or "").strip().rstrip("/")


def _validated_url(url: str) -> str:
    try:
        return validate_outbound_url(url)
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc


_HTTPX_CLIENT_FACTORY = httpx.Client


class PPFDirectoryClient:
    def __init__(self, http_client: httpx.Client | None = None):
        self.base_url = _ppf_base_url()
        self.token_url = (settings.PPF_DIRECTORY_TOKEN_URL or "").strip()
        self.client_id = (settings.PPF_DIRECTORY_CLIENT_ID or "").strip()
        self.client_secret = (settings.PPF_DIRECTORY_CLIENT_SECRET or "").strip()
        self.audience = (settings.PPF_DIRECTORY_AUDIENCE or "").strip()
        self._client = http_client or _HTTPX_CLIENT_FACTORY(timeout=DEFAULT_TIMEOUT, follow_redirects=False)
        self._owns_client = http_client is None
        self.logger = logging.getLogger("ppf.directory")

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "PPFDirectoryClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _token(self) -> str:
        cache_key = _ppf_cache_key()
        cached = _get_cached_token(cache_key)
        if cached:
            return cached
        if not self.token_url:
            raise RuntimeError("PPF_DIRECTORY_TOKEN_URL manquant.")
        payload = {
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }
        if self.audience:
            payload["audience"] = self.audience
        response = _request_with_retry(self._client, "POST", _validated_url(self.token_url), data=payload)
        if response.status_code >= 400:
            raise RuntimeError(f"PPF token error ({response.status_code}).")
        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError("PPF token non JSON.") from exc
        token = data.get("access_token")
        if not token:
            raise RuntimeError("PPF access_token manquant.")
        try:
            expires_in = int(data.get("expires_in") or TOKEN_DEFAULT_TTL_SECONDS)
        except (TypeError, ValueError):
            expires_in = TOKEN_DEFAULT_TTL_SECONDS
        _store_token(cache_key, token, expires_in)
        return token

    def _auth_headers(self) -> dict[str, str]:
        token = self._token()
        return {"Authorization": f"Bearer {token}"}

    def lookup(self, siren: str, siret: str | None = None, routing_code: str | None = None) -> dict[str, Any] | None:
        if not self.base_url:
            raise RuntimeError("PPF_DIRECTORY_BASE_URL manquant.")
        url = _validated_url(f"{self.base_url}{DEFAULT_LOOKUP_PATH}")
        params: dict[str, str] = {"siren": siren}
        if siret:
            params["siret"] = siret
        if routing_code:
            params["routing_code"] = routing_code
        response = _request_with_retry(self._client, "GET", url, params=params, headers=self._auth_headers())
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise RuntimeError(f"PPF lookup error ({response.status_code}).")
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError("PPF lookup non JSON.") from exc
        entries = _extract_entries(payload)
        parsed = [_parse_entry(item) for item in entries]
        for item in parsed:
            if not item:
                continue
            if siret and item.get("siret") != siret:
                continue
            if item.get("siren") != siren:
                continue
            if routing_code and item.get("routing_code") != routing_code:
                continue
            return item
        if siret or routing_code:
            return None
        for item in parsed:
            if item:
                return item
        return None

    def lookup_bulk(self, batch: list[DirectoryLookupInput]) -> list[dict[str, Any]]:
        if not self.base_url:
            raise RuntimeError("PPF_DIRECTORY_BASE_URL manquant.")
        url = _validated_url(f"{self.base_url}{DEFAULT_BULK_PATH}")
        payload = {
            "recipients": [
                {
                    "siren": item.siren,
                    "siret": item.siret,
                    "routing_code": item.routing_code,
                }
                for item in batch
            ]
        }
        response = _request_with_retry(self._client, "POST", url, json=payload, headers=self._auth_headers())
        if response.status_code == 404:
            return []
        if response.status_code >= 400:
            raise RuntimeError(f"PPF bulk error ({response.status_code}).")
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError("PPF bulk non JSON.") from exc
        entries = _extract_entries(payload)
        parsed = []
        for item in entries:
            parsed_item = _parse_entry(item)
            if parsed_item:
                parsed.append(parsed_item)
        return parsed


def list_directory_connectors() -> list[DirectoryConnector]:
    ppf_ready = is_ppf_configured()
    return [
        DirectoryConnector(
            slug="manual_csv",
            label="Import CSV (manuel)",
            status="ready",
            description="Import interne depuis un fichier CSV.",
        ),
        DirectoryConnector(
            slug="ppf_directory",
            label="Annuaire officiel PPF",
            status="ready" if ppf_ready else "missing_config",
            description="API officielle (OAuth2). Configurez les credentials PPF.",
        ),
    ]


def _find_cached_entry(db: Session, tenant_id: str, siren: str | None, siret: str | None) -> RecipientDirectoryEntry | None:
    q = db.query(RecipientDirectoryEntry).filter(RecipientDirectoryEntry.tenant_id == tenant_id)
    if siret:
        q = q.filter(RecipientDirectoryEntry.siret == siret)
    elif siren:
        q = q.filter(RecipientDirectoryEntry.siren == siren)
    return q.order_by(RecipientDirectoryEntry.updated_at.desc()).first()


def _upsert_entry(
    db: Session,
    tenant_id: str,
    payload: dict[str, Any],
    *,
    source: str = "ppf",
    now: datetime | None = None,
) -> RecipientDirectoryEntry:
    now = now or _now()
    siren = _normalize_digits(payload.get("siren"))
    siret = _normalize_digits(payload.get("siret")) if payload.get("siret") else None
    q = db.query(RecipientDirectoryEntry).filter(
        RecipientDirectoryEntry.tenant_id == tenant_id,
        RecipientDirectoryEntry.siren == siren,
    )
    if siret:
        q = q.filter(RecipientDirectoryEntry.siret == siret)
    else:
        q = q.filter(RecipientDirectoryEntry.siret.is_(None))
    entry = q.first()
    if entry:
        entry.platform_slug = payload["platform_slug"]
        entry.billing_address = payload["billing_address"]
        entry.routing_code = payload.get("routing_code")
        entry.routing_identifier = payload.get("routing_identifier")
        entry.platform_attached = payload.get("platform_attached")
        entry.billing_address_active = payload.get("billing_address_active")
        entry.service_code_required = payload.get("service_code_required")
        entry.commitment_required = payload.get("commitment_required")
        entry.service_or_commitment_required = payload.get("service_or_commitment_required")
        entry.public_entity = payload.get("public_entity")
        entry.raw_payload = payload.get("raw_payload")
        entry.source = source
        entry.last_synced_at = now
        entry.ttl_seconds = payload.get("ttl_seconds")
        entry.updated_at = now
        return entry
    entry = RecipientDirectoryEntry(
        tenant_id=tenant_id,
        siren=siren,
        siret=siret,
        platform_slug=payload["platform_slug"],
        billing_address=payload["billing_address"],
        routing_code=payload.get("routing_code"),
        routing_identifier=payload.get("routing_identifier"),
        platform_attached=payload.get("platform_attached"),
        billing_address_active=payload.get("billing_address_active"),
        service_code_required=payload.get("service_code_required"),
        commitment_required=payload.get("commitment_required"),
        service_or_commitment_required=payload.get("service_or_commitment_required"),
        public_entity=payload.get("public_entity"),
        raw_payload=payload.get("raw_payload"),
        source=source,
        last_synced_at=now,
        ttl_seconds=payload.get("ttl_seconds"),
        created_at=now,
        updated_at=now,
    )
    db.add(entry)
    return entry


def lookup_directory_entry(
    db: Session,
    tenant_id: str,
    siren: str | None,
    siret: str | None = None,
    routing_code: str | None = None,
    *,
    allow_remote: bool = True,
) -> RecipientDirectoryEntry | None:
    siren_norm = _normalize_digits(siren) or None
    siret_norm = _normalize_digits(siret) if siret else None
    if not siren_norm and not siret_norm:
        return None
    if siret_norm and len(siret_norm) == 14:
        siren_norm = siret_norm[:9]
    cached = _find_cached_entry(db, tenant_id, siren_norm, siret_norm)
    # Export-only and non-entitled callers may reuse tenant-local preparation
    # data, but must never refresh it through the PPF connector.
    if not allow_remote:
        return cached
    if cached and not _should_refresh(cached, _now()):
        return cached
    access = connected_mode_decision(db, tenant_id, "ppf")
    if not access.allowed:
        return cached
    if not is_ppf_configured():
        return cached
    if not siren_norm:
        return cached
    try:
        with PPFDirectoryClient() as client:
            payload = client.lookup(siren_norm, siret_norm, routing_code=routing_code)
    except Exception:
        logger.exception("ppf_directory_lookup_failed")
        return cached
    if not payload:
        return cached
    entry = _upsert_entry(db, tenant_id, payload, source="ppf", now=_now())
    db.commit()
    db.refresh(entry)
    return entry


def sync_bulk(
    db: Session,
    tenant_id: str,
    inputs: list[DirectoryLookupInput],
    *,
    page_size: int | None = None,
) -> dict[str, Any]:
    if not inputs:
        return {"ok": True, "requested": 0, "found": 0, "created": 0, "updated": 0, "skipped": 0, "errors": 0}
    access = connected_mode_decision(db, tenant_id, "ppf")
    if not access.allowed:
        return {
            "ok": True,
            "requested": len(inputs),
            "found": 0,
            "created": 0,
            "updated": 0,
            "skipped": len(inputs),
            "errors": 0,
            "blocked_reason": access.code or "connected_mode_not_operational",
        }
    if not is_ppf_configured():
        return {"ok": False, "error": {"code": "ppf_not_configured", "message": "Annuaire PPF non configure."}}
    size = page_size or DEFAULT_BULK_PAGE_SIZE
    pages = [inputs[i : i + size] for i in range(0, len(inputs), size)]
    summary = {"ok": True, "requested": len(inputs), "found": 0, "created": 0, "updated": 0, "skipped": 0, "errors": 0}
    now = _now()
    with PPFDirectoryClient() as client:
        for page in pages:
            try:
                entries = client.lookup_bulk(page)
            except Exception:
                summary["errors"] += 1
                logger.exception("ppf_directory_bulk_failed")
                continue
            summary["found"] += len(entries)
            for payload in entries:
                q = db.query(RecipientDirectoryEntry).filter(
                    RecipientDirectoryEntry.tenant_id == tenant_id,
                    RecipientDirectoryEntry.siren == payload["siren"],
                )
                if payload.get("siret"):
                    q = q.filter(RecipientDirectoryEntry.siret == payload["siret"])
                else:
                    q = q.filter(RecipientDirectoryEntry.siret.is_(None))
                existing = q.first()
                _upsert_entry(db, tenant_id, payload, source="ppf", now=now)
                if existing:
                    summary["updated"] += 1
                else:
                    summary["created"] += 1
            db.commit()
    return summary
