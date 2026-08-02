from __future__ import annotations

import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from .pdp_outbound import httpx_request_with_log
from .pdp_errors import PdpProviderError
from .public_provider_messages import sanitize_public_provider_message


def _normalize_uuid(value: str | None) -> str | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


def new_correlation_id() -> str:
    return str(uuid.uuid4())


def ensure_correlation_id(value: str | None = None) -> str:
    normalized = _normalize_uuid(value)
    return normalized or new_correlation_id()


class SeqinoHttpError(PdpProviderError):
    def __init__(
        self,
        message: str,
        *,
        code: str,
        status_code: int,
        retryable: bool = False,
        correlation_id: str | None = None,
        problem_type: str | None = None,
        type_url: str | None = None,
        warnings: list[str] | None = None,
        provider_errors: list[str] | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message, code=code, retryable=retryable)
        self.status_code = status_code
        self.correlation_id = correlation_id
        self.problem_type = problem_type
        self.type_url = type_url
        self.warnings = list(warnings or [])
        self.provider_errors = list(provider_errors or [])
        self.retry_after_seconds = retry_after_seconds


def _correlation_id_from_response(resp: httpx.Response) -> str | None:
    try:
        return resp.extensions.get("correlation_id")
    except Exception:
        return None


def _message_from_payload(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        for key in ("detail", "message", "error", "title", "description"):
            text = _message_from_payload(raw.get(key))
            if text:
                return text
        errors = raw.get("errors") or raw.get("violations") or raw.get("issues")
        text = _message_from_payload(errors)
        if text:
            return text
        return None
    if isinstance(raw, list):
        parts = []
        for item in raw:
            text = _message_from_payload(item)
            if text:
                parts.append(text)
            if len(parts) >= 3:
                break
        return " ; ".join(parts) if parts else None
    text = str(raw).strip()
    return text or None


def _response_message(resp: httpx.Response) -> str | None:
    try:
        payload = resp.json()
    except Exception:
        text = (resp.text or "").strip()
        return text[:300] if text else None
    return _message_from_payload(payload)


def _normalized_string_list(value: Any, *, limit: int = 20) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = str(item).strip()[:500]
        if text:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _problem_metadata(resp: httpx.Response) -> dict[str, Any]:
    try:
        payload = resp.json()
    except Exception:
        payload = None
    if not isinstance(payload, dict):
        return {
            "problem_type": None,
            "type_url": None,
            "warnings": [],
            "provider_errors": [],
        }
    problem_type = str(payload.get("type") or "").strip()[:300] or None
    type_url = str(payload.get("type_url") or "").strip()[:1000] or None
    return {
        "problem_type": problem_type,
        "type_url": type_url,
        "warnings": _normalized_string_list(payload.get("warnings")),
        "provider_errors": _normalized_string_list(payload.get("errors")),
    }


def _retry_after_seconds(resp: httpx.Response) -> float | None:
    value = str(resp.headers.get("retry-after") or "").strip()
    if not value:
        return None
    try:
        return max(0.0, min(float(value), 86_400.0))
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(value)
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        delay = (retry_at - datetime.now(timezone.utc)).total_seconds()
        return max(0.0, min(delay, 86_400.0))
    except (TypeError, ValueError, OverflowError):
        return None


def seqino_http_status(code: str | None, *, default_status: int = 502) -> int:
    if not code:
        return default_status
    if code in {"einvoicing_retry_required"}:
        return 409
    if code in {"token_balance_insufficient"}:
        return 402
    if code in {
        "seqino_mandate_missing",
        "seqino_not_ready",
        "trial_einvoicing_transmissions_disabled",
        "trial_seqino_transmissions_disabled",
    }:
        return 409
    if code in {"seqino_not_found"}:
        return 404
    if code in {"seqino_token_missing", "seqino_client_missing", "seqino_link_missing", "seqino_config_missing"}:
        return 400
    if code in {"chorus_config_missing", "chorus_syntaxe_flux_missing"}:
        return 409
    if code in {"chorus_submit_rejected"}:
        return 422
    if code in {"chorus_submit_conflict"}:
        return 409
    if code in {"chorus_rate_limited"}:
        return 429
    if code in {"chorus_unavailable", "chorus_auth_failed", "chorus_external_id_missing", "chorus_submit_endpoint_missing"}:
        return 502 if code != "chorus_unavailable" else 503
    if code in {"chorus_timeout"}:
        return 504
    if code in {"seqino_request_rejected", "seqino_validation_failed"}:
        return 422
    if code in {"seqino_conflict"}:
        return 409
    if code in {"seqino_rate_limited"}:
        return 429
    if code in {"seqino_unavailable"}:
        return 503
    if code in {"seqino_timeout"}:
        return 504
    return default_status


def seqino_error_from_response(resp: httpx.Response) -> SeqinoHttpError:
    status = resp.status_code
    corr_id = _correlation_id_from_response(resp)
    retryable = status in {408, 425, 429, 500, 502, 503, 504}
    metadata = _problem_metadata(resp)
    error_context = {
        **metadata,
        "retry_after_seconds": _retry_after_seconds(resp),
    }
    if status in {401, 403}:
        return SeqinoHttpError(
            "Authentification plateforme partenaire échouée.",
            code="seqino_auth_failed",
            status_code=502,
            retryable=retryable,
            correlation_id=corr_id,
            **error_context,
        )
    if status == 404:
        return SeqinoHttpError(
            "Ressource plateforme partenaire introuvable.",
            code="seqino_not_found",
            status_code=404,
            retryable=False,
            correlation_id=corr_id,
            **error_context,
        )
    if status in {400, 422}:
        details = sanitize_public_provider_message(_response_message(resp))
        message = (
            f"Requete plateforme partenaire rejetee: {details}"
            if details
            else "Requete plateforme partenaire rejetee. Verifiez les donnees du document."
        )
        return SeqinoHttpError(
            message,
            code="seqino_request_rejected",
            status_code=422,
            retryable=False,
            correlation_id=corr_id,
            **error_context,
        )
    if status == 409:
        details = sanitize_public_provider_message(_response_message(resp))
        message = (
            f"Conflit plateforme partenaire: {details}"
            if details
            else "Conflit plateforme partenaire. Actualisez le statut avant de reessayer."
        )
        return SeqinoHttpError(
            message,
            code="seqino_conflict",
            status_code=409,
            retryable=False,
            correlation_id=corr_id,
            **error_context,
        )
    if status == 429:
        return SeqinoHttpError(
            "Limite de debit plateforme partenaire atteinte.",
            code="seqino_rate_limited",
            status_code=429,
            retryable=True,
            correlation_id=corr_id,
            **error_context,
        )
    if status >= 500:
        return SeqinoHttpError(
            f"Service plateforme partenaire indisponible (HTTP {status}).",
            code="seqino_unavailable",
            status_code=503,
            retryable=True,
            correlation_id=corr_id,
            **error_context,
        )
    return SeqinoHttpError(
        f"Erreur plateforme partenaire (HTTP {status}).",
        code="seqino_request_failed",
        status_code=502,
        retryable=retryable,
        correlation_id=corr_id,
        **error_context,
    )


def seqino_error_from_exception(exc: httpx.RequestError) -> SeqinoHttpError:
    is_timeout = isinstance(exc, httpx.TimeoutException)
    code = "seqino_timeout" if is_timeout else "seqino_unreachable"
    status_code = 504 if is_timeout else 502
    message = "Timeout plateforme partenaire." if is_timeout else "Connexion plateforme partenaire impossible."
    return SeqinoHttpError(
        message,
        code=code,
        status_code=status_code,
        retryable=True,
    )


def seqino_raise_for_status(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    raise seqino_error_from_response(resp)


async def seqino_request_checked(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    raise_for_status: bool = True,
    **kwargs: Any,
) -> httpx.Response:
    try:
        resp = await seqino_request(client, method, url, **kwargs)
    except httpx.RequestError as exc:
        raise seqino_error_from_exception(exc) from exc
    if raise_for_status:
        seqino_raise_for_status(resp)
    return resp


async def seqino_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    tenant_id: str | None = None,
    correlation_id: str | None = None,
    provider: str = "seqino",
    **kwargs: Any,
) -> httpx.Response:
    corr_id = ensure_correlation_id(correlation_id)
    resp = await httpx_request_with_log(
        client,
        method,
        url,
        tenant_id=tenant_id,
        correlation_id=corr_id,
        provider=provider,
        **kwargs,
    )
    resp.extensions["correlation_id"] = corr_id
    return resp
