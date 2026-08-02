from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

from ..config import settings
from ..utils.url_security import parse_and_validate_outbound_url

logger = logging.getLogger(__name__)

DEFAULT_BASE_URLS = {
    "recherche": "https://recherche-entreprises.api.gouv.fr",
    "entreprise": "https://entreprise.data.gouv.fr/api/sirene/v3",
    "insee": "https://api.insee.fr/entreprises/sirene/V3",
}

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_BASE_SECONDS = 0.4

_CACHE: dict[str, dict[str, Any]] = {}


class SireneLookupError(RuntimeError):
    pass


class SireneNotConfigured(RuntimeError):
    pass


class SireneNotFound(RuntimeError):
    pass


@dataclass(frozen=True)
class SireneLookupResult:
    siren: str
    siret: str | None
    vat_number: str | None
    naf_code: str | None
    legal_category_code: str | None
    client_type: str | None
    name: str | None
    address_line1: str | None
    address_line2: str | None
    postal_code: str | None
    city: str | None
    country: str | None
    source: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "siren": self.siren,
            "siret": self.siret,
            "vat_number": self.vat_number,
            "naf_code": self.naf_code,
            "legal_category_code": self.legal_category_code,
            "client_type": self.client_type,
            "name": self.name,
            "address_line1": self.address_line1,
            "address_line2": self.address_line2,
            "postal_code": self.postal_code,
            "city": self.city,
            "country": self.country,
            "source": self.source,
        }


def _normalize_digits(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _cache_key(siren: str | None, siret: str | None) -> str:
    return f"{siren or ''}:{siret or ''}"


def _cache_get(key: str) -> dict[str, Any] | None:
    cached = _CACHE.get(key)
    if not cached:
        return None
    expires_at = cached.get("expires_at") or 0
    if expires_at <= time.time():
        _CACHE.pop(key, None)
        return None
    return cached.get("value")


def _cache_set(key: str, value: dict[str, Any], ttl_seconds: int) -> None:
    _CACHE[key] = {"value": value, "expires_at": time.time() + max(0, ttl_seconds)}


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
    raise RuntimeError("SIRENE request failed without response")


def _provider_name() -> str:
    raw = (settings.SIRENE_PROVIDER or "").strip().lower()
    if not raw:
        return "recherche"
    if raw in {"off", "false", "disabled", "none"}:
        return "disabled"
    return raw


def _base_url(provider: str) -> str:
    override = (settings.SIRENE_API_BASE_URL or "").strip()
    if override:
        return override.rstrip("/")
    return DEFAULT_BASE_URLS.get(provider, "").rstrip("/")


def _build_headers() -> dict[str, str]:
    token = (settings.SIRENE_API_TOKEN or settings.INSEE_API_KEY or "").strip()
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _compose_address(parts: list[Any]) -> str | None:
    cleaned = [p.strip() for p in parts if p and str(p).strip()]
    if not cleaned:
        return None
    return " ".join(cleaned)


def _fr_vat_number(siren: str | None) -> str | None:
    normalized = _normalize_digits(siren)
    if len(normalized) != 9:
        return None
    key = (12 + 3 * (int(normalized) % 97)) % 97
    return f"FR{key:02d}{normalized}"


def _normalize_naf_code(value: Any) -> str | None:
    raw = _text(value)
    if not raw:
        return None
    compact = raw.upper().replace(" ", "").replace(".", "")
    if len(compact) != 5:
        return raw.upper()
    return f"{compact[:2]}.{compact[2:]}"


def _normalize_legal_category_code(value: Any) -> str | None:
    raw = _text(value)
    if not raw:
        return None
    digits = _normalize_digits(raw)
    return digits[:4] if len(digits) >= 4 else None


def _infer_client_type_from_legal_category(value: Any) -> str | None:
    code = _normalize_legal_category_code(value)
    if code and code.startswith("7"):
        return "public"
    raw_text = _text(value)
    if not raw_text:
        return None
    raw = raw_text.casefold()
    public_markers = (
        "administration",
        "collectiv",
        "commune",
        "departement",
        "département",
        "etablissement public",
        "établissement public",
        "etat",
        "état",
        "region",
        "région",
        "service de l'etat",
        "service de l'état",
        "syndicat mixte",
    )
    if any(marker in raw for marker in public_markers):
        return "public"
    return "business"


def _parse_recherche(payload: dict[str, Any], siren: str, siret: str | None) -> SireneLookupResult | None:
    results = payload.get("results") or payload.get("data") or []
    if not isinstance(results, list) or not results:
        return None
    picked: dict[str, Any] | None = None
    for item in results:
        if not isinstance(item, dict):
            continue
        item_siren = _normalize_digits(item.get("siren") or item.get("numero_siren"))
        if item_siren and item_siren != siren:
            continue
        if siret:
            siege = _as_dict(item.get("siege"))
            item_siret = _normalize_digits(siege.get("siret") or item.get("siret"))
            if item_siret and item_siret != siret:
                continue
        picked = item
        break
    if not picked:
        picked = results[0] if isinstance(results[0], dict) else None
    if not picked:
        return None
    siege = _as_dict(picked.get("siege"))
    name = (
        picked.get("nom_complet")
        or picked.get("denomination")
        or picked.get("nom_raison_sociale")
        or picked.get("nom")
    )
    legal_category = (
        picked.get("categorie_juridique")
        or picked.get("categorie_juridique_unite_legale")
        or picked.get("nature_juridique")
        or picked.get("forme_juridique")
        or picked.get("libelle_nature_juridique")
    )
    addr_line1 = _compose_address([
        siege.get("numero_voie"),
        siege.get("type_voie"),
        siege.get("libelle_voie"),
    ])
    addr_line2 = _compose_address([siege.get("complement_adresse")])
    postal_code = siege.get("code_postal") or siege.get("code_postal_siege")
    city = siege.get("libelle_commune") or siege.get("commune")
    resolved_siret = _normalize_digits(siege.get("siret") or picked.get("siret") or siret)
    return SireneLookupResult(
        siren=siren,
        siret=resolved_siret or None,
        vat_number=_fr_vat_number(siren),
        naf_code=_normalize_naf_code(
            siege.get("activite_principale")
            or siege.get("activite_principale_etablissement")
            or picked.get("activite_principale")
            or picked.get("activite_principale_unite_legale")
        ),
        legal_category_code=_normalize_legal_category_code(legal_category),
        client_type=_infer_client_type_from_legal_category(legal_category),
        name=_text(name),
        address_line1=addr_line1,
        address_line2=addr_line2,
        postal_code=_text(postal_code),
        city=_text(city),
        country="FR",
        source="sirene_recherche",
    )


def _parse_entreprise(payload: dict[str, Any], siren: str, siret: str | None) -> SireneLookupResult | None:
    etablissement = _as_dict(payload.get("etablissement"))
    if not etablissement:
        etablissement = _as_dict(payload.get("data"))
    if not etablissement:
        return None
    unite_legale = _as_dict(etablissement.get("unite_legale"))
    if not unite_legale:
        unite_legale = _as_dict(payload.get("unite_legale"))
    name = (
        unite_legale.get("denomination")
        or unite_legale.get("denomination_usuelle")
        or unite_legale.get("nom_raison_sociale")
        or unite_legale.get("nom")
    )
    legal_category = (
        unite_legale.get("categorie_juridique")
        or unite_legale.get("categorie_juridique_unite_legale")
        or unite_legale.get("nature_juridique")
        or unite_legale.get("forme_juridique")
        or unite_legale.get("libelle_nature_juridique")
    )
    addr = _as_dict(etablissement.get("adresse"))
    addr_line1 = _compose_address([
        addr.get("numero_voie"),
        addr.get("type_voie"),
        addr.get("libelle_voie"),
    ])
    addr_line2 = _compose_address([addr.get("complement_adresse")])
    postal_code = addr.get("code_postal")
    city = addr.get("libelle_commune") or addr.get("commune")
    resolved_siret = _normalize_digits(etablissement.get("siret") or siret)
    resolved_siren = _normalize_digits(etablissement.get("siren") or siren)
    if not resolved_siren:
        return None
    return SireneLookupResult(
        siren=resolved_siren,
        siret=resolved_siret or None,
        vat_number=_fr_vat_number(resolved_siren),
        naf_code=_normalize_naf_code(
            etablissement.get("activite_principale")
            or etablissement.get("activite_principale_etablissement")
            or unite_legale.get("activite_principale")
            or unite_legale.get("activite_principale_unite_legale")
        ),
        legal_category_code=_normalize_legal_category_code(legal_category),
        client_type=_infer_client_type_from_legal_category(legal_category),
        name=_text(name),
        address_line1=addr_line1,
        address_line2=addr_line2,
        postal_code=_text(postal_code),
        city=_text(city),
        country="FR",
        source="sirene_entreprise",
    )


def _parse_insee(payload: dict[str, Any], siren: str, siret: str | None) -> SireneLookupResult | None:
    if not isinstance(payload, dict):
        return None
    unite_legale = _as_dict(payload.get("uniteLegale"))
    etablissement = _as_dict(payload.get("etablissement"))
    target = etablissement or unite_legale or {}
    name = (
        target.get("denominationUniteLegale")
        or target.get("denominationUsuelle1UniteLegale")
        or target.get("nomUniteLegale")
        or target.get("denomination")
    )
    legal_category = (
        unite_legale.get("categorieJuridiqueUniteLegale")
        or unite_legale.get("categorie_juridique_unite_legale")
        or unite_legale.get("categorie_juridique")
        or target.get("categorieJuridiqueUniteLegale")
        or target.get("categorie_juridique_unite_legale")
        or target.get("categorie_juridique")
        or target.get("nature_juridique")
    )
    addr = _as_dict(target.get("adresseEtablissement"))
    addr_line1 = _compose_address([
        addr.get("numeroVoieEtablissement"),
        addr.get("typeVoieEtablissement"),
        addr.get("libelleVoieEtablissement"),
    ])
    addr_line2 = _compose_address([addr.get("complementAdresseEtablissement")])
    postal_code = addr.get("codePostalEtablissement")
    city = addr.get("libelleCommuneEtablissement")
    resolved_siret = _normalize_digits(target.get("siret") or siret)
    return SireneLookupResult(
        siren=siren,
        siret=resolved_siret or None,
        vat_number=_fr_vat_number(siren),
        naf_code=_normalize_naf_code(
            target.get("activitePrincipaleEtablissement")
            or target.get("activitePrincipaleUniteLegale")
            or etablissement.get("activitePrincipaleEtablissement")
            or unite_legale.get("activitePrincipaleUniteLegale")
        ),
        legal_category_code=_normalize_legal_category_code(legal_category),
        client_type=_infer_client_type_from_legal_category(legal_category),
        name=_text(name),
        address_line1=addr_line1,
        address_line2=addr_line2,
        postal_code=_text(postal_code),
        city=_text(city),
        country="FR",
        source="sirene_insee",
    )


def lookup_company(siren: str | None, siret: str | None) -> dict[str, Any]:
    siren_norm = _normalize_digits(siren)
    siret_norm = _normalize_digits(siret)
    if siret_norm and len(siret_norm) != 14:
        raise ValueError("siret_invalid")
    if siren_norm and len(siren_norm) != 9:
        raise ValueError("siren_invalid")
    if not siren_norm and siret_norm:
        siren_norm = siret_norm[:9]
    if not siren_norm:
        raise ValueError("siren_missing")

    cache_ttl = int(getattr(settings, "SIRENE_LOOKUP_CACHE_SECONDS", 86400) or 86400)
    key = _cache_key(siren_norm, siret_norm)
    cached = _cache_get(key)
    if cached:
        return cached

    provider = _provider_name()
    if provider == "disabled":
        raise SireneNotConfigured("sirene_disabled")
    base_url = _base_url(provider)
    if not base_url:
        raise SireneNotConfigured("sirene_base_url_missing")

    timeout = httpx.Timeout(
        connect=5.0,
        read=float(getattr(settings, "SIRENE_LOOKUP_TIMEOUT_SECONDS", 8) or 8),
        write=10.0,
        pool=5.0,
    )

    headers = _build_headers()
    if provider == "insee" and not headers:
        raise SireneNotConfigured("sirene_token_missing")

    result: SireneLookupResult | None = None
    if provider == "recherche":
        url = f"{base_url.rstrip('/')}/search"
        params = {"q": siret_norm or siren_norm, "page": "1", "per_page": "1"}
        request_url = parse_and_validate_outbound_url(url)
        with httpx.Client(timeout=timeout) as client:
            response = _request_with_retry(client, "GET", request_url, params=params, headers=headers)
        if response.status_code == 404:
            raise SireneNotFound("sirene_not_found")
        if response.status_code >= 400:
            raise SireneLookupError(f"lookup_failed:{response.status_code}")
        payload = response.json()
        result = _parse_recherche(payload, siren_norm, siret_norm)
    elif provider == "entreprise":
        if siret_norm:
            url = f"{base_url.rstrip('/')}/etablissements/{siret_norm}"
        else:
            url = f"{base_url.rstrip('/')}/unites_legales/{siren_norm}"
        request_url = parse_and_validate_outbound_url(url)
        with httpx.Client(timeout=timeout) as client:
            response = _request_with_retry(client, "GET", request_url, headers=headers)
        if response.status_code == 404:
            raise SireneNotFound("sirene_not_found")
        if response.status_code >= 400:
            raise SireneLookupError(f"lookup_failed:{response.status_code}")
        payload = response.json()
        result = _parse_entreprise(payload, siren_norm, siret_norm)
    elif provider == "insee":
        if siret_norm:
            url = f"{base_url.rstrip('/')}/siret/{siret_norm}"
        else:
            url = f"{base_url.rstrip('/')}/siren/{siren_norm}"
        request_url = parse_and_validate_outbound_url(url)
        with httpx.Client(timeout=timeout) as client:
            response = _request_with_retry(client, "GET", request_url, headers=headers)
        if response.status_code == 404:
            raise SireneNotFound("sirene_not_found")
        if response.status_code >= 400:
            raise SireneLookupError(f"lookup_failed:{response.status_code}")
        payload = response.json()
        result = _parse_insee(payload, siren_norm, siret_norm)
    else:
        raise SireneNotConfigured("sirene_provider_invalid")

    if not result:
        raise SireneNotFound("sirene_not_found")
    payload = result.as_dict()
    _cache_set(key, payload, cache_ttl)
    return payload
