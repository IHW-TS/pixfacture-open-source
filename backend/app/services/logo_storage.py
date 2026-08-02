from __future__ import annotations

import uuid
from urllib.parse import quote

from ..config import settings
from .storage import put_object, storage_provider
from .storage import _bucket, _s3_client


_LOGO_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
}


def detect_logo_content_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    return None


def save_logo(tenant_id: str, data: bytes, content_type: str) -> tuple[str, str]:
    detected = detect_logo_content_type(data)
    if not detected:
        raise ValueError("Logo binaire invalide.")
    declared = (content_type or "").strip().lower()
    if declared and declared not in _LOGO_EXTENSIONS:
        raise ValueError("Logo content_type invalide.")
    if declared and declared != detected:
        raise ValueError("Logo content_type incohérent.")
    content_type = detected
    ext = _LOGO_EXTENSIONS.get(content_type)
    if not ext:
        raise ValueError("Logo content_type invalide.")
    storage_key = f"logos/{tenant_id}/{uuid.uuid4().hex}{ext}"
    put_object(storage_key, data, content_type=content_type)
    return storage_key, get_logo_url(tenant_id, storage_key) or ""


def get_logo_url(tenant_id: str, storage_key: str) -> str | None:
    if not storage_key:
        return None
    provider = storage_provider()
    public_base = _public_base_url()
    if provider in {"s3", "minio"} and not public_base:
        presigned = _presigned_logo_url(storage_key)
        if presigned:
            return presigned
    return _proxy_logo_url(storage_key, public_base)


def _public_base_url() -> str:
    base = (settings.PUBLIC_BASE_URL or settings.FRONTEND_BASE_URL or "").strip()
    return base.rstrip("/") if base else ""


def _proxy_logo_url(storage_key: str, base: str) -> str:
    encoded_key = quote(storage_key)
    path = f"/api/company/logo?key={encoded_key}"
    if base:
        return f"{base}{path}"
    return path


def _presigned_logo_url(storage_key: str, expires_in: int = 600) -> str | None:
    try:
        return _s3_client().generate_presigned_url(
            "get_object",
            Params={"Bucket": _bucket(), "Key": storage_key},
            ExpiresIn=expires_in,
        )
    except Exception:
        return None
