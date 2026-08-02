from __future__ import annotations

import logging
import shutil
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from typing import Iterable, Optional, Tuple

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from .. import metrics
from ..config import settings


logger = logging.getLogger(__name__)


_S3_CLIENT = None
_OBJECT_LOCK_STATE: dict[str, object] = {
    "checked": False,
    "enabled": False,
    "default_mode": None,
    "default_retention_days": None,
}
_OBJECT_LOCK_STATUS_PUBLIC_ERROR = "Vérification de la protection Object Lock indisponible."


@dataclass
class ObjectMeta:
    size: int
    content_type: str | None = None
    etag: str | None = None


@dataclass
class StorageStream:
    body: Iterable[bytes]
    content_length: int
    total_size: int
    content_type: str | None = None
    etag: str | None = None


def _provider() -> str:
    return (settings.STORAGE_PROVIDER or "local").strip().lower()


def storage_provider() -> str:
    return _provider()


def list_object_keys(*, prefix: str = "", max_objects: int = 100_000) -> tuple[str, ...]:
    """Return a bounded, complete inventory of the configured object store.

    Public-launch sanitisation uses this internal primitive to retain a private
    deletion manifest for every prelaunch object, including orphaned exports
    that no longer have a database row.  A truncated inventory is worse than
    no inventory, so the function fails closed at the explicit bound.
    """

    provider = _provider()
    normalized_prefix = str(prefix or "").lstrip("/").replace("\\", "/")
    if max_objects < 1:
        raise ValueError("max_objects doit être strictement positif.")

    keys: list[str] = []
    try:
        if provider in {"s3", "minio"}:
            paginator = _s3_client().get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=_bucket(), Prefix=normalized_prefix):
                for item in page.get("Contents") or []:
                    key = str(item.get("Key") or "").strip()
                    if key:
                        keys.append(key)
                    if len(keys) > max_objects:
                        raise RuntimeError("Inventaire stockage trop volumineux; revue opérateur requise.")
        elif provider in {"local", "filesystem"}:
            root = _local_root()
            if not os.path.isdir(root):
                return ()
            for directory, _subdirectories, filenames in os.walk(root):
                for filename in filenames:
                    path = os.path.join(directory, filename)
                    key = os.path.relpath(path, root).replace(os.sep, "/")
                    if key.startswith(normalized_prefix):
                        keys.append(key)
                    if len(keys) > max_objects:
                        raise RuntimeError("Inventaire stockage trop volumineux; revue opérateur requise.")
        else:
            raise RuntimeError("STORAGE_PROVIDER ne permet pas un inventaire exhaustif.")
    except Exception as exc:
        _log_storage_failure("list_object_keys", provider, exc)
        raise RuntimeError("Inventaire exhaustif du stockage impossible.") from exc
    return tuple(sorted(set(keys)))


def _log_storage_failure(operation: str, provider: str, exc: Exception) -> None:
    metrics.inc_operational_event("storage_failure")
    logger.exception(
        "storage_failure",
        extra={"operation": operation, "storage_provider": provider, "error_type": type(exc).__name__},
    )


def _bucket() -> str:
    bucket = (settings.STORAGE_BUCKET or settings.S3_BUCKET or "").strip()
    if not bucket:
        raise RuntimeError("STORAGE_BUCKET manquant pour le stockage S3.")
    return bucket


def _s3_client():
    global _S3_CLIENT
    if _S3_CLIENT is not None:
        return _S3_CLIENT
    endpoint = (settings.S3_ENDPOINT or settings.S3_ENDPOINT_URL or "").strip() or None
    region = (settings.S3_REGION or "").strip() or None
    access_key = (settings.S3_ACCESS_KEY or settings.S3_ACCESS_KEY_ID or "").strip() or None
    secret_key = (settings.S3_SECRET_KEY or settings.S3_SECRET_ACCESS_KEY or "").strip() or None
    addressing_style = "path" if endpoint or getattr(settings, "S3_FORCE_PATH_STYLE", False) else "virtual"
    config = Config(s3={"addressing_style": addressing_style})
    _S3_CLIENT = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=config,
    )
    return _S3_CLIENT


def _object_lock_enabled() -> bool:
    return bool(getattr(settings, "S3_OBJECT_LOCK_ENABLED", False))


def _normalize_object_lock_mode(value: str | None) -> str | None:
    if not value:
        return None
    mode = value.strip().upper()
    if mode not in {"GOVERNANCE", "COMPLIANCE"}:
        raise RuntimeError("S3_OBJECT_LOCK_MODE invalide (GOVERNANCE ou COMPLIANCE attendu).")
    return mode


def _normalize_retention_days(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        days = int(value)
    except (TypeError, ValueError):
        raise RuntimeError("S3_OBJECT_LOCK_RETENTION_DAYS invalide.")
    if days <= 0:
        raise RuntimeError("S3_OBJECT_LOCK_RETENTION_DAYS doit etre > 0.")
    return days


def _fetch_object_lock_configuration() -> dict[str, object]:
    try:
        resp = _s3_client().get_object_lock_configuration(Bucket=_bucket())
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in {"ObjectLockConfigurationNotFoundError", "NoSuchObjectLockConfiguration"}:
            raise RuntimeError("Object Lock non active sur le bucket S3.")
        raise RuntimeError("Verification Object Lock impossible (acces ou configuration).") from exc
    cfg = resp.get("ObjectLockConfiguration") or {}
    enabled = cfg.get("ObjectLockEnabled") == "Enabled"
    rule = cfg.get("Rule", {}) or {}
    retention = rule.get("DefaultRetention", {}) or {}
    default_mode = retention.get("Mode")
    default_days = retention.get("Days")
    default_years = retention.get("Years")
    if default_years and not default_days:
        default_days = int(default_years) * 365
    return {
        "enabled": enabled,
        "default_mode": default_mode,
        "default_retention_days": default_days,
    }


def _ensure_object_lock_configured(
    *,
    apply_retention: bool = True,
    retain_until: datetime | None = None,
) -> dict[str, object]:
    if not _object_lock_enabled():
        return {}
    provider = _provider()
    if provider not in {"s3", "minio"}:
        raise RuntimeError("Object Lock S3 disponible uniquement avec STORAGE_PROVIDER=s3|minio.")
    state = _OBJECT_LOCK_STATE
    if not state["checked"]:
        config = _fetch_object_lock_configuration()
        state["checked"] = True
        state["enabled"] = config.get("enabled", False)
        state["default_mode"] = config.get("default_mode")
        state["default_retention_days"] = config.get("default_retention_days")
    if not state["enabled"]:
        raise RuntimeError("Object Lock non actif sur le bucket S3.")
    extra: dict[str, object] = {}
    if not apply_retention:
        return extra
    retention_days = _normalize_retention_days(getattr(settings, "S3_OBJECT_LOCK_RETENTION_DAYS", None))
    if retain_until is None and retention_days is None and not state.get("default_retention_days"):
        raise RuntimeError(
            "Object Lock configure mais aucune retention definie (S3_OBJECT_LOCK_RETENTION_DAYS ou retention par defaut du bucket)."
        )
    mode = _normalize_object_lock_mode(getattr(settings, "S3_OBJECT_LOCK_MODE", None))
    if retain_until is not None:
        if retain_until.tzinfo is None:
            retain_until = retain_until.replace(tzinfo=timezone.utc)
        extra["ObjectLockMode"] = mode or "COMPLIANCE"
        extra["ObjectLockRetainUntilDate"] = retain_until
        return extra
    if retention_days is not None:
        extra["ObjectLockMode"] = mode or "COMPLIANCE"
        extra["ObjectLockRetainUntilDate"] = datetime.now(timezone.utc) + timedelta(days=retention_days)
    return extra


def object_lock_status() -> dict[str, object]:
    report: dict[str, object] = {
        "enabled": _object_lock_enabled(),
        "ok": None,
        "mode": None,
        "retention_days": None,
        "bucket_default_mode": None,
        "bucket_default_retention_days": None,
        "error": None,
    }
    if not report["enabled"]:
        return report
    try:
        _ensure_object_lock_configured()
        report["ok"] = True
        report["mode"] = _normalize_object_lock_mode(getattr(settings, "S3_OBJECT_LOCK_MODE", None))
        report["retention_days"] = _normalize_retention_days(getattr(settings, "S3_OBJECT_LOCK_RETENTION_DAYS", None))
        report["bucket_default_mode"] = _OBJECT_LOCK_STATE.get("default_mode")
        report["bucket_default_retention_days"] = _OBJECT_LOCK_STATE.get("default_retention_days")
    except Exception as exc:
        metrics.inc_operational_event("storage_failure")
        logger.warning(
            "storage_object_lock_status_failed",
            extra={
                "operation": "object_lock_status",
                "storage_provider": _provider(),
                "error_type": type(exc).__name__,
            },
        )
        report["ok"] = False
        report["error"] = _OBJECT_LOCK_STATUS_PUBLIC_ERROR
    return report


def storage_integrity_info() -> dict[str, object]:
    provider = _provider()
    info: dict[str, object] = {"provider": provider}
    if provider in {"s3", "minio"}:
        info["s3"] = {
            "kms": bool(settings.S3_KMS_KEY_ID),
            "object_lock": object_lock_status(),
        }
    return info


def _local_root() -> str:
    root = (settings.STORAGE_LOCAL_ROOT or settings.STORAGE_LOCAL_PATH or "./storage").strip() or "./storage"
    return os.path.abspath(root)


def _local_path(key: str) -> str:
    safe_key = (key or "").lstrip("/").replace("\\", "/")
    root = _local_root()
    full_path = os.path.abspath(os.path.join(root, safe_key))
    if full_path != root and not full_path.startswith(root + os.sep):
        raise ValueError("Cle stockage invalide.")
    return full_path


def invoice_artifact_key(invoice_id: str, kind: str) -> str:
    kind = (kind or "").strip().lower()
    if kind == "pdf":
        filename = "issued.pdf"
    elif kind == "xml":
        filename = "facturx.xml"
    elif kind == "facturx":
        filename = "facturx.pdf"
    elif kind == "ubl":
        filename = "ubl.xml"
    elif kind == "compliance_report_json":
        filename = "compliance_report.json"
    elif kind == "compliance_report_pdf":
        filename = "compliance_report.pdf"
    else:
        raise ValueError("Type d'artefact inconnu.")
    return f"invoices/{invoice_id}/{filename}"


def inbound_attachment_key(inbound_invoice_id: str, kind: str) -> str:
    kind = (kind or "").strip().lower()
    if kind == "pdf":
        filename = "invoice.pdf"
    elif kind == "xml":
        filename = "invoice.xml"
    else:
        raise ValueError("Type de piece jointe inconnu.")
    return f"inbox/{inbound_invoice_id}/{filename}"


def put_object(
    key: str,
    data: bytes,
    content_type: str | None = None,
    *,
    legal_archive: bool = False,
    retain_until: datetime | None = None,
) -> None:
    provider = _provider()
    try:
        if provider in {"s3", "minio"}:
            extra: dict[str, object] = {}
            if content_type:
                extra["ContentType"] = content_type
            if settings.S3_KMS_KEY_ID:
                extra["ServerSideEncryption"] = "aws:kms"
                extra["SSEKMSKeyId"] = settings.S3_KMS_KEY_ID
            if legal_archive:
                extra.update(_ensure_object_lock_configured(retain_until=retain_until))
            _s3_client().put_object(Bucket=_bucket(), Key=key, Body=data, **extra)
            return
        if provider in {"local", "filesystem"}:
            path = _local_path(key)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(data)
            return
        raise RuntimeError(f"STORAGE_PROVIDER inconnu: {provider}")
    except Exception as exc:
        _log_storage_failure("put_object", provider, exc)
        raise


def copy_object(
    src_key: str,
    dst_key: str,
    content_type: str | None = None,
    *,
    legal_archive: bool = False,
    retain_until: datetime | None = None,
) -> None:
    """Copy an object within the configured storage.

    Notes:
    - Used for quote -> invoice conversion (attachments carry over).
    - For S3/MinIO we use server-side copy when possible.
    - For local storage we copy the file on disk.
    """

    provider = _provider()
    try:
        if provider in {"s3", "minio"}:
            extra: dict[str, object] = {}
            if settings.S3_KMS_KEY_ID:
                extra["ServerSideEncryption"] = "aws:kms"
                extra["SSEKMSKeyId"] = settings.S3_KMS_KEY_ID
            if legal_archive:
                extra.update(_ensure_object_lock_configured(retain_until=retain_until))

            kwargs: dict[str, object] = {
                "Bucket": _bucket(),
                "Key": dst_key,
                "CopySource": {"Bucket": _bucket(), "Key": src_key},
            }
            # If content_type is provided we must replace metadata to ensure it is set.
            if content_type:
                kwargs["ContentType"] = content_type
                kwargs["MetadataDirective"] = "REPLACE"
            kwargs.update(extra)
            _s3_client().copy_object(**kwargs)
            return
        if provider in {"local", "filesystem"}:
            src_path = _local_path(src_key)
            dst_path = _local_path(dst_key)
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
            shutil.copyfile(src_path, dst_path)
            return
        raise RuntimeError(f"STORAGE_PROVIDER inconnu: {provider}")
    except Exception as exc:
        _log_storage_failure("copy_object", provider, exc)
        raise


def delete_object(key: str) -> None:
    provider = _provider()
    try:
        if provider in {"s3", "minio"}:
            _s3_client().delete_object(Bucket=_bucket(), Key=key)
            return
        if provider in {"local", "filesystem"}:
            path = _local_path(key)
            try:
                os.remove(path)
            except FileNotFoundError:
                return
            return
        raise RuntimeError(f"STORAGE_PROVIDER inconnu: {provider}")
    except Exception as exc:
        _log_storage_failure("delete_object", provider, exc)
        raise


def head_object(key: str) -> Optional[ObjectMeta]:
    provider = _provider()
    if provider in {"s3", "minio"}:
        try:
            resp = _s3_client().head_object(Bucket=_bucket(), Key=key)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        return ObjectMeta(
            size=int(resp.get("ContentLength") or 0),
            content_type=resp.get("ContentType"),
            etag=_strip_etag(resp.get("ETag")),
        )
    if provider in {"local", "filesystem"}:
        path = _local_path(key)
        if not os.path.exists(path):
            return None
        return ObjectMeta(size=os.path.getsize(path))
    raise RuntimeError(f"STORAGE_PROVIDER inconnu: {provider}")


def get_object_bytes(key: str) -> Optional[bytes]:
    stream = get_object_stream(key)
    if not stream:
        return None
    return b"".join(stream.body)


def get_object_stream(key: str, byte_range: Tuple[int, int] | None = None) -> Optional[StorageStream]:
    provider = _provider()
    try:
        if provider in {"s3", "minio"}:
            meta = head_object(key)
            if not meta:
                return None
            kwargs: dict[str, str] = {}
            if byte_range:
                start, end = byte_range
                kwargs["Range"] = f"bytes={start}-{end}"
            resp = _s3_client().get_object(Bucket=_bucket(), Key=key, **kwargs)
            body = resp["Body"]
            content_length = int(resp.get("ContentLength") or 0)
            return StorageStream(
                body=_iter_s3_body(body),
                content_length=content_length,
                total_size=meta.size,
                content_type=resp.get("ContentType") or meta.content_type,
                etag=_strip_etag(resp.get("ETag")) or meta.etag,
            )
        if provider in {"local", "filesystem"}:
            path = _local_path(key)
            if not os.path.exists(path):
                return None
            total_size = os.path.getsize(path)
            if byte_range:
                start, end = byte_range
                content_length = end - start + 1
                body = _iter_file(path, start=start, end=end)
            else:
                content_length = total_size
                body = _iter_file(path, start=0, end=None)
            return StorageStream(
                body=body,
                content_length=content_length,
                total_size=total_size,
            )
        raise RuntimeError(f"STORAGE_PROVIDER inconnu: {provider}")
    except Exception as exc:
        _log_storage_failure("get_object_stream", provider, exc)
        raise


def run_storage_diagnostic(prefix: str = "diagnostic/") -> tuple[bool, int, str | None]:
    safe_prefix = (prefix or "diagnostic/").strip()
    if not safe_prefix.endswith("/"):
        safe_prefix += "/"
    key = f"{safe_prefix}{uuid.uuid4().hex}.txt"
    payload = f"diagnostic:{uuid.uuid4().hex}".encode("utf-8")
    start = time.perf_counter()
    error: str | None = None
    ok = False
    try:
        put_object(key, payload, content_type="text/plain")
        stored = get_object_bytes(key)
        if stored != payload:
            raise RuntimeError("diagnostic_payload_mismatch")
        ok = True
    except Exception as exc:
        error = _safe_storage_error(exc)
        logger.warning("Storage diagnostic failed: %s", error)
    finally:
        try:
            delete_object(key)
        except Exception:
            pass
    latency_ms = int(round((time.perf_counter() - start) * 1000))
    return ok, latency_ms, error


def run_storage_readiness_check(prefix: str = "diagnostic/readyz/") -> tuple[bool, int, str | None]:
    provider = _provider()
    if provider in {"s3", "minio"} and _object_lock_enabled():
        start = time.perf_counter()
        try:
            _s3_client().head_bucket(Bucket=_bucket())
            _ensure_object_lock_configured()
            return True, int(round((time.perf_counter() - start) * 1000)), None
        except Exception as exc:
            return False, int(round((time.perf_counter() - start) * 1000)), _safe_storage_error(exc)
    return run_storage_diagnostic(prefix=prefix)


def parse_range_header(value: str | None, total_size: int) -> Tuple[int, int] | None:
    if not value:
        return None
    header = value.strip().lower()
    if not header.startswith("bytes="):
        return None
    range_part = header.split("=", 1)[1].split(",", 1)[0].strip()
    if "-" not in range_part:
        return None
    start_raw, end_raw = range_part.split("-", 1)
    if start_raw == "":
        try:
            length = int(end_raw)
        except ValueError:
            return None
        if length <= 0:
            return None
        start = max(total_size - length, 0)
        end = total_size - 1
    else:
        try:
            start = int(start_raw)
        except ValueError:
            return None
        if end_raw:
            try:
                end = int(end_raw)
            except ValueError:
                return None
        else:
            end = total_size - 1
    if start < 0 or start >= total_size:
        return None
    end = min(end, total_size - 1)
    if end < start:
        return None
    return start, end


def _safe_storage_error(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code")
        return code or "S3Error"
    if isinstance(exc, RuntimeError):
        message = str(exc).strip()
        if message:
            return message
    return exc.__class__.__name__


def _strip_etag(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip('"')


def _iter_s3_body(body, chunk_size: int = 1024 * 1024):
    try:
        while True:
            chunk = body.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        try:
            body.close()
        except Exception:
            pass


def _iter_file(path: str, start: int = 0, end: int | None = None, chunk_size: int = 1024 * 1024):
    with open(path, "rb") as handle:
        handle.seek(start)
        remaining = (end - start + 1) if end is not None else None
        while True:
            if remaining is not None and remaining <= 0:
                break
            read_size = chunk_size if remaining is None else min(chunk_size, remaining)
            chunk = handle.read(read_size)
            if not chunk:
                break
            if remaining is not None:
                remaining -= len(chunk)
            yield chunk
