import asyncio
import base64
import hashlib
import httpx
import json
import logging
import re
import time
import unicodedata

from dataclasses import dataclass
from typing import Any, Dict

from ..config import settings
from ..utils.pdp_errors import PdpPreSubmitCancelled, PdpPreSubmitError, PdpProviderError
from ..utils.ssrf import validate_outbound_url

_TOKEN_CACHE: dict[str, dict[str, Any]] = {}
_TOKEN_LOCKS: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Lock]] = {}
_REDIS_CLIENT = None

TOKEN_REFRESH_BUFFER_SECONDS = 60
TOKEN_DEFAULT_TTL_SECONDS = 3600
TOKEN_CACHE_KEY_PREFIX = "chorus:token:"
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_BASE_SECONDS = 0.5
MAX_REPORT_ERRORS = 10
MAX_PUBLIC_ERROR_CHARS = 300

CHORUS_ACCOUNT_ATTACHMENTS_PATH = "cpro/utilisateurs/v1/monCompte/recuperer/rattachements"
CHORUS_RECIPIENT_SEARCH_PATH = "cpro/transverses/v1/rechercher/destinataire"
CHORUS_SIRET_INFORMATION_PATH = "cpro/transverses/v1/consulter/information/siret"
CHORUS_STRUCTURE_DETAIL_PATH = "cpro/structures/v1/consulter"
CHORUS_STRUCTURE_SERVICES_PATH = "cpro/structures/v1/rechercher/services"
CHORUS_STRUCTURE_SERVICE_DETAIL_PATH = "cpro/structures/v1/consulter/service"

_ACTIVE_CHORUS_STATUSES = frozenset(
    {
        "ACTIF",
        "ACTIVE",
        "ACCEPTE",
        "ACCEPTEE",
        "RATTACHE",
        "RATTACHEE",
        "VALIDE",
        "VALIDEE",
    }
)


def build_chorus_cpro_account(technical_login: str, technical_password: str) -> str:
    """Build the opaque PISTE header value without logging either credential."""

    login = (technical_login or "").strip()
    if not login or ":" in login or not technical_password:
        raise ValueError("Identifiants techniques Chorus invalides.")
    encoded = base64.b64encode(f"{login}:{technical_password}".encode("utf-8")).decode("ascii")
    if not chorus_cpro_account_is_valid(encoded):
        raise ValueError("Identifiants techniques Chorus invalides.")
    return encoded


def chorus_cpro_account_is_valid(value: str | None) -> bool:
    """Validate the PISTE ``cpro-account`` header shape without exposing it."""

    encoded = (value or "").strip()
    if not encoded:
        return False
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return False
    login, separator, password = decoded.partition(":")
    return bool(separator and login.strip() and password)


def _normalized_chorus_status(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Z0-9]+", "_", text.upper()).strip("_")


def _chorus_status_is_active(value: Any) -> bool:
    return _normalized_chorus_status(value) in _ACTIVE_CHORUS_STATUSES


def _chorus_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    normalized = _normalized_chorus_status(value)
    if normalized in {"1", "TRUE", "VRAI", "OUI", "YES", "ACTIF", "ACTIVE"}:
        return True
    if normalized in {"0", "FALSE", "FAUX", "NON", "NO", "INACTIF", "INACTIVE"}:
        return False
    return None


def _chorus_text(value: Any, *, max_chars: int = 300) -> str | None:
    return _safe_provider_text(value, max_chars=max_chars)


def _chorus_identifier(value: Any) -> int | str | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    text = str(value).strip()
    if not text or len(text) > 80:
        return None
    return int(text) if text.isdigit() else text


@dataclass(frozen=True)
class ChorusReportRequest:
    """Contract shared by ``consulterCR`` and ``consulterCRDetaille``."""

    numero_flux_depot: str

    def to_payload(self) -> dict[str, str]:
        value = (self.numero_flux_depot or "").strip()
        if not value:
            raise PdpProviderError(
                "Identifiant de flux Chorus manquant.",
                code="chorus_external_id_missing",
                retryable=False,
            )
        return {"numeroFluxDepot": value}


@dataclass(frozen=True)
class ChorusReport:
    numero_flux_depot: str
    raw_status: str
    code_retour: int | None
    libelle: str | None
    errors: list[str]
    date_status: str | None = None
    filename: str | None = None
    interface_code: str | None = None

    def to_public_dict(self) -> dict[str, Any]:
        """Return only the fields needed by lifecycle reconciliation.

        Chorus responses can contain a base64 report and business identifiers. They
        must not be persisted wholesale in transmission events or exposed to users.
        """

        return {
            "numeroFluxDepot": self.numero_flux_depot,
            "etatCourantDepotFlux": self.raw_status,
            "codeRetour": self.code_retour,
            "libelle": self.libelle,
            "errors": list(self.errors),
            "dateHeureEtatCourantFlux": self.date_status,
            "nomFichier": self.filename,
            "codeInterfaceDepotFlux": self.interface_code,
        }


def _extra_fields() -> Dict[str, Any]:
    raw = settings.CHORUS_SUBMIT_EXTRA_JSON or ""
    try:
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


def _validated_chorus_url(url: str) -> str:
    try:
        return validate_outbound_url(url)
    except ValueError as exc:
        raise PdpProviderError(str(exc), code="chorus_url_blocked", retryable=False) from exc


def configured_syntaxe_flux() -> str | None:
    value = _extra_fields().get("syntaxeFlux")
    if value is None:
        value = _extra_fields().get("syntaxe_flux")
    raw = str(value or "").strip()
    return raw or None


def extract_chorus_external_id(payload: dict[str, Any]) -> str | None:
    value = (
        payload.get("identifiantFlux")
        or payload.get("id")
        or payload.get("submission_id")
        or payload.get("uuid")
        or payload.get("numeroFluxDepot")
    )
    external_id = str(value or "").strip()
    return external_id or None


def _safe_provider_text(value: Any, *, max_chars: int = MAX_PUBLIC_ERROR_CHARS) -> str | None:
    if value is None:
        return None
    text = "".join(
        " " if ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF or ord(char) in {0xFFFE, 0xFFFF} else char
        for char in str(value)
    )
    text = text.strip()
    text = re.sub(r"\s+", " ", text)
    return text[:max_chars] or None


def _report_errors(payload: dict[str, Any]) -> list[str]:
    values: list[Any] = []
    for key in ("listeErreurDP", "listeErreursDP", "listeErreurTechnique", "listeErreursTechniques"):
        raw = payload.get(key)
        if isinstance(raw, list):
            values.extend(raw)
        elif isinstance(raw, dict):
            values.append(raw)
    errors: list[str] = []
    for entry in values:
        if not isinstance(entry, dict):
            continue
        message = None
        for key in ("libelleErreurDP", "libelleErreur", "message", "libelle"):
            message = _safe_provider_text(entry.get(key))
            if message:
                break
        code = _safe_provider_text(entry.get("codeErreur"), max_chars=80)
        if code and message:
            errors.append(f"{code}: {message}")
        elif message:
            errors.append(message)
        elif code:
            errors.append(code)
        if len(errors) >= MAX_REPORT_ERRORS:
            break
    return errors


def parse_chorus_report(
    payload: Any,
    *,
    external_id: str,
) -> ChorusReport:
    """Validate and normalize a consulterCR/consulterCRDetaille response."""

    if not isinstance(payload, dict):
        raise PdpProviderError(
            "Réponse de suivi Chorus invalide.",
            code="chorus_status_response_invalid",
            retryable=True,
        )
    code_raw = payload.get("codeRetour")
    code_retour: int | None = None
    if code_raw is not None:
        try:
            code_retour = int(code_raw)
        except (TypeError, ValueError) as exc:
            raise PdpProviderError(
                "Réponse de suivi Chorus invalide.",
                code="chorus_status_response_invalid",
                retryable=True,
            ) from exc
        if code_retour != 0:
            raise PdpProviderError(
                f"Chorus n'a pas pu consulter le flux (code {code_retour}).",
                code="chorus_status_rejected",
                retryable=False,
            )
    raw_status = _safe_provider_text(
        payload.get("etatCourantDepotFlux")
        or payload.get("EtatCourantFlux")
        or payload.get("etatCourantFlux"),
        max_chars=120,
    )
    if not raw_status:
        raise PdpProviderError(
            "Réponse de suivi Chorus sans état de flux exploitable.",
            code="chorus_status_response_invalid",
            retryable=True,
        )
    response_external_id = _safe_provider_text(
        payload.get("numeroFluxDepot") or payload.get("NumeroFluxDepot"),
        max_chars=120,
    )
    if response_external_id and response_external_id != external_id:
        raise PdpProviderError(
            "Le compte-rendu Chorus ne correspond pas au flux demandé.",
            code="chorus_status_mismatch",
            retryable=False,
        )
    return ChorusReport(
        numero_flux_depot=external_id,
        raw_status=raw_status,
        code_retour=code_retour,
        libelle=_safe_provider_text(payload.get("libelle")),
        errors=_report_errors(payload),
        date_status=_safe_provider_text(
            payload.get("dateHeureEtatCourantFlux") or payload.get("DateHeureEtatCourantFlux"),
            max_chars=80,
        ),
        filename=_safe_provider_text(
            payload.get("nomFichier") or payload.get("nomFichierFlux") or payload.get("NomFichierFlux"),
            max_chars=255,
        ),
        interface_code=_safe_provider_text(
            payload.get("codeInterfaceDepotFlux")
            or payload.get("codeInterfaceFlux")
            or payload.get("CodeInterfaceFlux"),
            max_chars=120,
        ),
    )


def _chorus_token_error(exc: httpx.HTTPStatusError) -> PdpProviderError:
    response = exc.response
    status = response.status_code if response is not None else 0
    retryable = status in {408, 425, 429, 500, 502, 503, 504}
    if status in {401, 403}:
        return PdpProviderError(
            "Authentification PISTE refusée. Vérifiez les identifiants Chorus.",
            code="chorus_auth_failed",
            retryable=False,
        )
    if status == 429:
        return PdpProviderError(
            "Limite PISTE atteinte, réessayez plus tard.",
            code="chorus_rate_limited",
            retryable=True,
        )
    if retryable:
        return PdpProviderError(
            f"Service PISTE indisponible (HTTP {status}).",
            code="chorus_unavailable",
            retryable=True,
        )
    return PdpProviderError(
        f"Erreur d'authentification PISTE (HTTP {status or 'inconnu'}).",
        code="chorus_auth_failed",
        retryable=False,
    )


def _chorus_transport_error(exc: httpx.RequestError) -> PdpProviderError:
    if isinstance(exc, httpx.TimeoutException):
        return PdpProviderError(
            "Timeout lors de l'appel Chorus/PISTE.",
            code="chorus_timeout",
            retryable=True,
            submission_outcome="unknown",
        )
    return PdpProviderError(
        "Service Chorus/PISTE temporairement inaccessible.",
        code="chorus_unavailable",
        retryable=True,
        submission_outcome="unknown",
    )


def _chorus_submit_error(exc: httpx.HTTPStatusError) -> PdpProviderError:
    response = exc.response
    status = response.status_code if response is not None else 0
    retryable = status in {408, 425, 429, 500, 502, 503, 504}
    if status in {401, 403}:
        return PdpProviderError(
            "Authentification ou autorisation Chorus refusée.",
            code="chorus_auth_failed",
            retryable=False,
            submission_outcome="not_sent",
        )
    if status == 404:
        return PdpProviderError(
            "Endpoint Chorus introuvable. Vérifiez CHORUS_API_BASE et CHORUS_SUBMIT_PATH.",
            code="chorus_submit_endpoint_missing",
            retryable=False,
            submission_outcome="not_sent",
        )
    if status == 409:
        return PdpProviderError(
            "Dépôt Chorus déjà existant ou conflit de traitement.",
            code="chorus_submit_conflict",
            retryable=False,
            submission_outcome="unknown",
        )
    if status == 429:
        return PdpProviderError(
            "Limite Chorus atteinte, réessayez plus tard.",
            code="chorus_rate_limited",
            retryable=True,
            submission_outcome="not_sent",
        )
    if status in {400, 422}:
        return PdpProviderError(
            "Chorus a rejeté le dépôt. Vérifiez le destinataire public et le document.",
            code="chorus_submit_rejected",
            retryable=False,
            submission_outcome="rejected",
        )
    if retryable:
        return PdpProviderError(
            f"Service Chorus indisponible (HTTP {status}).",
            code="chorus_unavailable",
            retryable=True,
            submission_outcome="unknown",
        )
    return PdpProviderError(
        f"Erreur Chorus lors du dépôt (HTTP {status or 'inconnu'}).",
        code="chorus_submit_failed",
        retryable=False,
        submission_outcome="rejected",
    )


def _chorus_status_error(exc: httpx.HTTPStatusError) -> PdpProviderError:
    response = exc.response
    status = response.status_code if response is not None else 0
    if status in {401, 403}:
        return PdpProviderError(
            "Consultation Chorus refusée pour ce compte technique.",
            code="chorus_status_forbidden",
            retryable=False,
        )
    if status == 404:
        return PdpProviderError(
            "Flux Chorus introuvable.",
            code="chorus_status_not_found",
            retryable=False,
        )
    if status == 429:
        return PdpProviderError(
            "Limite de consultation Chorus atteinte, réessayez plus tard.",
            code="chorus_rate_limited",
            retryable=True,
        )
    retryable = status in {408, 425, 500, 502, 503, 504}
    return PdpProviderError(
        f"Service de suivi Chorus indisponible (HTTP {status or 'inconnu'}).",
        code="chorus_status_unavailable" if retryable else "chorus_status_failed",
        retryable=retryable,
    )


def _now() -> float:
    return time.time()

def _token_cache_key(client_id: str, token_url: str) -> str:
    raw = f"{client_id}|{token_url}".encode("utf-8")
    return TOKEN_CACHE_KEY_PREFIX + hashlib.sha256(raw).hexdigest()

def _get_token_lock(cache_key: str) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    existing = _TOKEN_LOCKS.get(cache_key)
    if existing:
        existing_loop, lock = existing
        if existing_loop is loop:
            return lock
    lock = asyncio.Lock()
    _TOKEN_LOCKS[cache_key] = (loop, lock)
    return lock

def _get_redis():
    global _REDIS_CLIENT
    if not settings.REDIS_URL:
        return None
    if _REDIS_CLIENT is not None:
        return _REDIS_CLIENT
    try:
        from redis import Redis
        _REDIS_CLIENT = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    except Exception:
        _REDIS_CLIENT = None
    return _REDIS_CLIENT

def _get_cached_token(cache_key: str) -> str | None:
    now = _now()
    cached = _TOKEN_CACHE.get(cache_key)
    if cached:
        expires_at = cached.get("expires_at") or 0
        if expires_at - now > TOKEN_REFRESH_BUFFER_SECONDS:
            return cached.get("token")
    redis = _get_redis()
    if not redis:
        return None
    try:
        token = redis.get(cache_key)
        ttl = redis.ttl(cache_key)
    except Exception:
        return None
    if not token or ttl is None:
        return None
    if ttl <= TOKEN_REFRESH_BUFFER_SECONDS:
        return None
    _TOKEN_CACHE[cache_key] = {"token": token, "expires_at": now + ttl}
    return token

def _store_token(cache_key: str, token: str, expires_in: int) -> None:
    now = _now()
    expires_at = now + expires_in
    _TOKEN_CACHE[cache_key] = {"token": token, "expires_at": expires_at}
    redis = _get_redis()
    if not redis:
        return
    ttl = int(expires_at - now)
    if ttl <= 0:
        return
    try:
        redis.set(cache_key, token, ex=ttl)
    except Exception:
        return

async def _request_with_retry(client: httpx.AsyncClient, method: str, url: str, **kwargs) -> httpx.Response:
    delay = RETRY_BACKOFF_BASE_SECONDS
    last_exc: Exception | None = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            response = await client.request(method, url, **kwargs)
        except httpx.RequestError as exc:
            last_exc = exc
            if attempt >= RETRY_ATTEMPTS:
                raise
        else:
            if response.status_code < 500 or attempt >= RETRY_ATTEMPTS:
                return response
        await asyncio.sleep(delay)
        delay *= 2
    if last_exc:
        raise last_exc
    raise RuntimeError("Chorus request failed without response")


class ChorusClient:
    def __init__(
        self,
        *,
        client_id: str | None = None,
        client_secret: str | None = None,
        token_url: str | None = None,
        api_base: str | None = None,
        submit_path: str | None = None,
        status_path: str | None = None,
        cpro_account: str | None = None,
    ):
        self.client_id = client_id or settings.PISTE_CLIENT_ID or ""
        self.client_secret = client_secret or settings.PISTE_CLIENT_SECRET or ""
        self.token_url = token_url or settings.PISTE_TOKEN_URL or ""
        self.api_base = (api_base or settings.CHORUS_API_BASE or "").rstrip("/")
        self.submit_path = (submit_path or settings.CHORUS_SUBMIT_PATH or "").lstrip("/")
        self.status_path = (status_path or settings.CHORUS_STATUS_PATH or "").lstrip("/")
        # Never fall back to a process-wide Chorus account: it represents the
        # tenant's public structure and must be resolved from IntegrationSecret.
        self.cpro_account = (cpro_account or "").strip()
        self.logger = logging.getLogger("chorus")

    def _require_cpro_account(self) -> str:
        account = (self.cpro_account or "").strip()
        if not account:
            raise PdpProviderError(
                "Compte technique Chorus requis pour cette entreprise.",
                code="chorus_cpro_account_missing",
                retryable=False,
            )
        if not chorus_cpro_account_is_valid(account):
            raise PdpProviderError(
                "Compte technique Chorus invalide pour cette entreprise.",
                code="chorus_cpro_account_invalid",
                retryable=False,
            )
        return account

    async def _token(self) -> str:
        cache_key = _token_cache_key(self.client_id, self.token_url)
        cached = _get_cached_token(cache_key)
        if cached:
            return cached
        lock = _get_token_lock(cache_key)
        async with lock:
            cached = _get_cached_token(cache_key)
            if cached:
                return cached
            try:
                async with httpx.AsyncClient(timeout=60) as c:
                    r = await _request_with_retry(
                        c,
                        "POST",
                        _validated_chorus_url(self.token_url),
                        data={
                            "grant_type": "client_credentials",
                            "client_id": self.client_id,
                            "client_secret": self.client_secret,
                            "scope": "openid",
                        },
                    )
            except httpx.RequestError as exc:
                raise _chorus_transport_error(exc) from exc
            try:
                r.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise _chorus_token_error(exc) from exc
            data = r.json()
            token = data.get("access_token")
            if not token:
                raise PdpProviderError("Token Chorus manquant.", code="chorus_token_missing", retryable=True)
            try:
                expires_in = int(data.get("expires_in") or TOKEN_DEFAULT_TTL_SECONDS)
            except (TypeError, ValueError):
                expires_in = TOKEN_DEFAULT_TTL_SECONDS
            if expires_in <= 0:
                expires_in = TOKEN_DEFAULT_TTL_SECONDS
            _store_token(cache_key, token, expires_in)
            return token

    async def _post_read_only(self, path: str, request_payload: dict[str, Any]) -> dict[str, Any]:
        """Call one fixed Chorus read endpoint and return a validated JSON object.

        Provider payloads are deliberately not logged and callers only receive
        the explicitly sanitized fields exposed by the public methods below.
        """

        if not self.api_base.strip():
            raise PdpProviderError(
                "Configuration Chorus manquante.",
                code="chorus_read_config_missing",
                retryable=False,
            )
        cpro_account = self._require_cpro_account()
        token = await self._token()
        url = _validated_chorus_url(f"{self.api_base}/{path.lstrip('/')}")
        headers = {
            "Authorization": f"Bearer {token}",
            "cpro-account": cpro_account,
            "Content-Type": "application/json;charset=UTF-8",
        }
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                response = await _request_with_retry(
                    client,
                    "POST",
                    url,
                    headers=headers,
                    json=request_payload,
                )
        except httpx.RequestError as exc:
            raise _chorus_transport_error(exc) from exc
        if response.status_code != 200:
            if response.status_code in {401, 403}:
                raise PdpProviderError(
                    "La consultation Chorus n'est pas autorisée.",
                    code="chorus_read_forbidden",
                    retryable=False,
                )
            retryable = response.status_code in {408, 425, 429, 500, 502, 503, 504}
            raise PdpProviderError(
                "La consultation Chorus a échoué.",
                code="chorus_read_unavailable" if retryable else "chorus_read_failed",
                retryable=retryable,
            )
        try:
            payload = response.json()
        except Exception as exc:
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            ) from exc
        if not isinstance(payload, dict):
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            )
        try:
            code_retour = int(str(payload.get("codeRetour")).strip())
        except (TypeError, ValueError) as exc:
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            ) from exc
        if code_retour != 0:
            raise PdpProviderError(
                "La consultation Chorus a été refusée.",
                code="chorus_read_rejected",
                retryable=False,
            )
        return payload

    async def get_account_attachment_summary(self, *, expected_siret: str | None = None) -> dict[str, Any]:
        request_payload = {
            "parametresRecherche": {
                "nbResultatsParPage": 100,
                "pageResultatDemandee": 1,
                "triColonne": "IdStructure",
                "triSens": "Ascendant",
            }
        }
        payload = await self._post_read_only(CHORUS_ACCOUNT_ATTACHMENTS_PATH, request_payload)
        raw_items = payload.get("listeStructureRattachement")
        if not isinstance(raw_items, list):
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            )
        expected = "".join(ch for ch in (expected_siret or "") if ch.isdigit())
        expected_attached = False
        matched_structure_id: int | str | None = None
        for item in raw_items[:100]:
            if not isinstance(item, dict):
                continue
            item_siret = "".join(ch for ch in str(item.get("identifiantStructure") or "") if ch.isdigit())
            if not expected or item_siret != expected:
                continue
            # Chorus production currently returns ``ACTIF`` for a usable
            # technical user while the structure attachment is ``VALIDEE``.
            # Both belong to the provider's active status vocabulary; do not
            # reject a valid account by requiring the same literal on both
            # fields.
            if not _chorus_status_is_active(item.get("statutUtilisateur")):
                continue
            if not _chorus_status_is_active(
                item.get("statutRattachementStructure")
            ):
                continue
            expected_attached = True
            matched_structure_id = _chorus_identifier(item.get("idStructure") or item.get("idStructureCPP"))
            break
        total_value = (payload.get("parametresRetour") or {}).get("total") if isinstance(
            payload.get("parametresRetour"), dict
        ) else None
        try:
            structure_count = max(0, int(str(total_value)))
        except (TypeError, ValueError):
            structure_count = len(raw_items)
        return {
            "structure_count": structure_count,
            "expected_siret_attached": expected_attached,
            "matched_structure_id": matched_structure_id,
        }

    async def search_public_recipient(self, siret: str) -> list[dict[str, Any]]:
        request_payload = {
            "identifiant": siret,
            "typeStructure": "PUBLIQUE",
            "parametresRecherche": {
                "nbResultatsParPage": 10,
                "pageResultatDemandee": 1,
                "triColonne": "Siret",
                "triSens": "Ascendant",
            },
        }
        payload = await self._post_read_only(CHORUS_RECIPIENT_SEARCH_PATH, request_payload)
        raw_items = payload.get("listeDestinataires")
        if not isinstance(raw_items, list):
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            )
        recipients: list[dict[str, Any]] = []
        for item in raw_items[:10]:
            if not isinstance(item, dict):
                continue
            normalized_siret = "".join(ch for ch in str(item.get("siret") or "") if ch.isdigit())
            structure_id = _chorus_identifier(item.get("idStructureCPP"))
            if len(normalized_siret) != 14 or structure_id is None:
                continue
            recipients.append(
                {
                    "siret": normalized_siret,
                    "idStructureCPP": structure_id,
                    "nomDestinataire": _chorus_text(item.get("nomDestinataire")),
                    "adresseCodePostal": _chorus_text(item.get("adresseCodePostal"), max_chars=20),
                    "adresseVille": _chorus_text(item.get("adresseVille"), max_chars=200),
                }
            )
        return recipients

    async def get_siret_information(self, siret: str) -> dict[str, Any]:
        payload = await self._post_read_only(
            CHORUS_SIRET_INFORMATION_PATH,
            {"siretStructure": siret},
        )
        returned_siret = "".join(ch for ch in str(payload.get("siret") or "") if ch.isdigit())
        active = _chorus_bool(payload.get("estActif"))
        if len(returned_siret) != 14 or active is None:
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            )
        return {"siret": returned_siret, "active": active}

    async def get_structure_details(self, structure_id: int | str) -> dict[str, Any]:
        payload = await self._post_read_only(
            CHORUS_STRUCTURE_DETAIL_PATH,
            {"idStructureCPP": structure_id, "codeLangue": "fr"},
        )
        information = payload.get("informationGenerales")
        parameters = payload.get("parametres")
        if not isinstance(information, dict) or not isinstance(parameters, dict):
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            )
        structure_type = information.get("structurePriveePublique")
        normalized_type = _normalized_chorus_status(structure_type)
        public_flag = normalized_type in {"PUBLIC", "PUBLIQUE"} if normalized_type else None
        return {
            "idStructureCPP": _chorus_identifier(structure_id),
            "designation": _chorus_text(
                information.get("designationStructure")
                or information.get("nomStructure")
                or information.get("designation")
            ),
            "public": public_flag,
            "service_code_required": _chorus_bool(parameters.get("codeServiceDoitEtreRenseigne")),
            "commitment_required": _chorus_bool(parameters.get("numeroEJDoitEtreRenseigne")),
            "service_or_commitment_required": _chorus_bool(parameters.get("gestionNumeroEJOuCodeService")),
        }

    async def get_structure_services(self, structure_id: int | str) -> list[dict[str, Any]]:
        request_payload = {
            "idStructure": structure_id,
            "parametresRechercherServicesStructure": {
                "nbResultatsParPage": 100,
                "pageResultatDemandee": 1,
                "triColonne": "CodeService",
                "triSens": "Ascendant",
            },
        }
        payload = await self._post_read_only(CHORUS_STRUCTURE_SERVICES_PATH, request_payload)
        raw_items = payload.get("listeServices")
        if not isinstance(raw_items, list):
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            )
        services: list[dict[str, Any]] = []
        for item in raw_items[:100]:
            if not isinstance(item, dict):
                continue
            active = _chorus_bool(item.get("estActif"))
            if active is None:
                active = _chorus_status_is_active(item.get("statutService"))
            code = _chorus_text(item.get("codeService"), max_chars=100)
            if active is not True or not code:
                continue
            services.append(
                {
                    "codeService": code,
                    "libelleService": _chorus_text(item.get("libelleService"), max_chars=200),
                    "idService": _chorus_identifier(item.get("idService")),
                }
            )
        return services

    async def get_structure_service_details(
        self,
        structure_id: int | str,
        service_id: int | str,
        *,
        expected_code: str,
    ) -> dict[str, Any]:
        payload = await self._post_read_only(
            CHORUS_STRUCTURE_SERVICE_DETAIL_PATH,
            {"idStructure": structure_id, "idService": service_id, "codeLangue": "fr"},
        )
        information = payload.get("informationsGenerales")
        parameters = payload.get("parametres")
        if not isinstance(information, dict) or not isinstance(parameters, dict):
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            )
        returned_code = _chorus_text(information.get("codeService"), max_chars=100)
        if returned_code != expected_code:
            raise PdpProviderError(
                "Réponse Chorus incohérente.",
                code="chorus_read_response_mismatch",
                retryable=False,
            )
        returned_service_id = _chorus_identifier(information.get("idService"))
        if returned_service_id is not None and str(returned_service_id) != str(service_id):
            raise PdpProviderError(
                "Réponse Chorus incohérente.",
                code="chorus_read_response_mismatch",
                retryable=False,
            )
        returned_structure_id = _chorus_identifier(information.get("idStructure"))
        if returned_structure_id is not None and str(returned_structure_id) != str(structure_id):
            raise PdpProviderError(
                "Réponse Chorus incohérente.",
                code="chorus_read_response_mismatch",
                retryable=False,
            )
        commitment_required = _chorus_bool(parameters.get("numeroEngagement"))
        if commitment_required is None:
            raise PdpProviderError(
                "Réponse Chorus invalide.",
                code="chorus_read_response_invalid",
                retryable=False,
            )
        return {"commitment_required": commitment_required}

    async def submit_multipart(
        self,
        file_bytes: bytes,
        filename: str,
        content_type: str = "application/xml",
        idempotency_key: str | None = None,
    ) -> dict:
        """
        Envoie un flux facture à Chorus en JSON (comme le curl de test) :

        {
          "syntaxeFlux": "...",
          "nomFichier": "xxx.xml",
          "fichierFlux": "<base64 du fichier>",
          ... CHORUS_SUBMIT_EXTRA_JSON ...
        }
        """
        if not self.submit_path.strip():
            raise PdpPreSubmitError(
                "CHORUS_SUBMIT_PATH doit être configuré avant dépôt Chorus.",
                code="chorus_config_missing",
            )
        try:
            cpro_account = self._require_cpro_account()
        except PdpProviderError as exc:
            raise PdpPreSubmitError(str(exc), code=exc.code, retryable=exc.retryable) from exc

        payload: Dict[str, Any] = _extra_fields() or {}
        if not str(payload.get("syntaxeFlux") or payload.get("syntaxe_flux") or "").strip():
            raise PdpPreSubmitError(
                "CHORUS_SUBMIT_EXTRA_JSON.syntaxeFlux doit être configuré avant dépôt Chorus.",
                code="chorus_syntaxe_flux_missing",
            )

        try:
            tok = await self._token()
        except asyncio.CancelledError as exc:
            # No invoice POST can have started while the OAuth token is still
            # being acquired. Let the durable outbox discard this reservation.
            raise PdpPreSubmitCancelled from exc
        except PdpProviderError as exc:
            # OAuth/configuration failed before the invoice endpoint was called.
            raise PdpPreSubmitError(str(exc), code=exc.code, retryable=exc.retryable) from exc
        try:
            url = _validated_chorus_url(f"{self.api_base}/{self.submit_path}")
        except PdpProviderError as exc:
            raise PdpPreSubmitError(str(exc), code=exc.code, retryable=exc.retryable) from exc

        # On impose nomFichier et fichierFlux quels que soient les extra fields
        payload["nomFichier"] = filename
        payload["fichierFlux"] = base64.b64encode(file_bytes).decode("ascii")

        headers = {
            "Authorization": f"Bearer {tok}",
            "cpro-account": cpro_account,
            # Très important pour éviter le 415 Unsupported Media Type
            "Content-Type": "application/json;charset=UTF-8",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
            headers["X-Idempotency-Key"] = idempotency_key

        try:
            async with httpx.AsyncClient(timeout=120) as c:
                # A deposit is not replayed automatically. Chorus does not
                # guarantee the custom idempotency headers; an ambiguous timeout
                # is reconciled from the durable outbox instead.
                r = await c.request("POST", url, headers=headers, json=payload)
        except httpx.RequestError as exc:
            raise _chorus_transport_error(exc) from exc

        encoded_size = len(payload.get("fichierFlux", ""))
        self.logger.info(
            json.dumps({
                "event": "chorus_submit",
                "status_code": r.status_code,
                "url": url,
                "syntaxe_flux": str(payload.get("syntaxeFlux") or payload.get("syntaxe_flux") or ""),
                "payload_base64_chars": encoded_size,
            })
        )

        # On garde le message Chorus en cas d'erreur HTTP
        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise _chorus_submit_error(exc) from exc

        try:
            return r.json()
        except Exception as exc:
            raise PdpProviderError(
                "Réponse de dépôt Chorus invalide.",
                code="chorus_submit_response_invalid",
                retryable=False,
                submission_outcome="unknown",
            ) from exc

    async def get_status(self, external_id: str) -> dict:
        if not self.status_path.strip():
            raise PdpProviderError(
                "CHORUS_STATUS_PATH doit être configuré avant consultation du statut Chorus.",
                code="chorus_config_missing",
            )
        cpro_account = self._require_cpro_account()
        request_payload = ChorusReportRequest(external_id).to_payload()
        try:
            tok = await self._token()
        except httpx.RequestError as exc:
            raise _chorus_transport_error(exc) from exc
        path = self.status_path or ""
        # PISTE exposes consulterCR/consulterCRDetaille as POST services. Keep
        # support for a configured {id} template only at URL construction time;
        # the official numeroFluxDepot JSON body is always sent.
        url = f"{self.api_base}/{path}".replace("{id}", external_id)
        url = _validated_chorus_url(url)
        headers = {
            "Authorization": f"Bearer {tok}",
            "cpro-account": cpro_account,
            "Content-Type": "application/json;charset=UTF-8",
        }

        try:
            async with httpx.AsyncClient(timeout=60) as c:
                r = await _request_with_retry(c, "POST", url, headers=headers, json=request_payload)
        except httpx.RequestError as exc:
            raise _chorus_transport_error(exc) from exc

        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise _chorus_status_error(exc) from exc
        try:
            payload = r.json()
        except Exception as exc:
            raise PdpProviderError(
                "Réponse de suivi Chorus invalide.",
                code="chorus_status_response_invalid",
                retryable=True,
            ) from exc
        return parse_chorus_report(payload, external_id=external_id).to_public_dict()
