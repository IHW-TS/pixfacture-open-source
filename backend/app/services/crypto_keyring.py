import base64
import hashlib
from typing import Iterable

from cryptography.fernet import Fernet, InvalidToken

from ..config import settings, _parse_pdp_encryption_keys


class KeyringError(RuntimeError):
    pass


def _fernet_from_secret(secret: str) -> Fernet:
    key_source = (secret or "").strip()
    if not key_source:
        raise KeyringError("Missing encryption key")
    digest = hashlib.sha256(key_source.encode("utf-8")).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def _keyring_entries() -> list[tuple[str, str]]:
    entries, invalid = _parse_pdp_encryption_keys(settings.PDP_ENCRYPTION_KEYS)
    if invalid:
        raise KeyringError("Invalid PDP_ENCRYPTION_KEYS format")
    if entries:
        return entries
    legacy = (settings.PDP_ENCRYPTION_KEY or "").strip()
    if legacy:
        return [("legacy", legacy)]
    raise KeyringError("Missing PDP_ENCRYPTION_KEYS")


def _active_key() -> tuple[str, str]:
    entries = _keyring_entries()
    desired = (settings.PDP_ENCRYPTION_KID or entries[0][0]).strip()
    for kid, secret in entries:
        if kid == desired:
            return kid, secret
    return entries[0]


def _iter_candidates(kid: str | None, entries: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    items = list(entries)
    if kid:
        for candidate_kid, secret in items:
            if candidate_kid == kid:
                return [(candidate_kid, secret)] + [(k, s) for k, s in items if k != kid]
    return items


def encrypt_value(value: str | bytes) -> tuple[str, bytes]:
    raw = value.encode("utf-8") if isinstance(value, str) else value
    kid, secret = _active_key()
    token = _fernet_from_secret(secret).encrypt(raw)
    return kid, token


def decrypt_value(token: bytes | str | None, kid: str | None) -> bytes:
    if not token:
        return b""
    token_bytes = token.encode("utf-8") if isinstance(token, str) else token
    entries = _keyring_entries()
    for candidate_kid, secret in _iter_candidates(kid, entries):
        try:
            return _fernet_from_secret(secret).decrypt(token_bytes)
        except InvalidToken:
            continue
    raise KeyringError("Invalid encrypted value")
