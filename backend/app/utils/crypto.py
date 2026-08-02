import base64
import hashlib
import json

from cryptography.fernet import Fernet, InvalidToken

from ..config import settings, _parse_pdp_encryption_keys


def _fernet_from_secret(secret: str) -> Fernet:
    key_source = (secret or "").strip()
    if not key_source:
        raise RuntimeError("Missing encryption key")
    digest = hashlib.sha256(key_source.encode("utf-8")).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def _keyring_entries() -> list[tuple[str, str]]:
    entries, _ = _parse_pdp_encryption_keys(settings.PDP_ENCRYPTION_KEYS)
    return entries


def _active_key() -> tuple[str, str]:
    keyring = _keyring_entries()
    if keyring:
        desired_kid = (settings.PDP_ENCRYPTION_KID or keyring[0][0]).strip()
        for kid, secret in keyring:
            if kid == desired_kid:
                return kid, secret
        return keyring[0]
    key_source = (settings.PDP_ENCRYPTION_KEY or settings.SECRET_KEY or "").strip()
    if not key_source:
        raise RuntimeError("Missing encryption key")
    fallback_kid = (settings.PDP_ENCRYPTION_KID or "legacy").strip() or "legacy"
    return fallback_kid, key_source


def _candidate_keys() -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []
    for kid, secret in _keyring_entries():
        candidates.append((kid, secret))
    if settings.PDP_ENCRYPTION_KEY:
        key_source = settings.PDP_ENCRYPTION_KEY.strip()
        if key_source:
            kid = (settings.PDP_ENCRYPTION_KID or "legacy").strip() or "legacy"
            candidates.append((kid, key_source))
    if settings.SECRET_KEY:
        key_source = settings.SECRET_KEY.strip()
        if key_source:
            candidates.append(("legacy", key_source))
    deduped: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in candidates:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped


def encrypt_payload(payload: dict) -> bytes:
    kid, secret = _active_key()
    wrapper = {"kid": kid, "data": payload or {}}
    raw = json.dumps(wrapper, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return _fernet_from_secret(secret).encrypt(raw)


def decrypt_payload(token: bytes | str | None) -> dict:
    if not token:
        return {}
    token_bytes = token.encode("utf-8") if isinstance(token, str) else token
    keyring = _keyring_entries()
    known_kids = {kid for kid, _ in keyring}
    for kid, secret in _candidate_keys():
        try:
            raw = _fernet_from_secret(secret).decrypt(token_bytes)
        except InvalidToken:
            continue
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            return {}
        if isinstance(payload, dict) and "kid" in payload and "data" in payload:
            payload_kid = str(payload.get("kid") or "").strip()
            data = payload.get("data")
            if payload_kid and payload_kid != kid and payload_kid in known_kids:
                continue
            return data if isinstance(data, dict) else {}
        if isinstance(payload, dict):
            return payload
        return {}
    raise ValueError("Invalid encrypted payload")
