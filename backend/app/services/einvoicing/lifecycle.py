from __future__ import annotations

from enum import Enum


class LifecycleStatus(str, Enum):
    UNKNOWN = "unknown"
    SUBMITTED = "submitted"
    PROCESSING = "processing"
    AVAILABLE = "available"
    ACCEPTED = "accepted"
    REFUSED = "refused"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    PAID = "paid"
    CASHED = "cashed"
    FAILED = "failed"


STATUS_LABELS: dict[str, str] = {
    LifecycleStatus.UNKNOWN.value: "Inconnu",
    LifecycleStatus.SUBMITTED.value: "Deposee",
    LifecycleStatus.PROCESSING.value: "En traitement",
    LifecycleStatus.AVAILABLE.value: "Mise a disposition",
    LifecycleStatus.ACCEPTED.value: "Acceptee",
    LifecycleStatus.REFUSED.value: "Refusee",
    LifecycleStatus.REJECTED.value: "Rejetee",
    LifecycleStatus.CANCELLED.value: "Annulee",
    LifecycleStatus.PAID.value: "Payee",
    LifecycleStatus.CASHED.value: "Encaissee",
    LifecycleStatus.FAILED.value: "Echec",
}

BLOCKING_STATUSES = {
    LifecycleStatus.REJECTED.value,
    LifecycleStatus.REFUSED.value,
    LifecycleStatus.FAILED.value,
}

FINAL_STATUSES = {
    LifecycleStatus.REJECTED.value,
    LifecycleStatus.REFUSED.value,
    LifecycleStatus.CANCELLED.value,
    LifecycleStatus.PAID.value,
    LifecycleStatus.CASHED.value,
    LifecycleStatus.FAILED.value,
}

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    LifecycleStatus.UNKNOWN.value: {
        LifecycleStatus.UNKNOWN.value,
        LifecycleStatus.SUBMITTED.value,
        LifecycleStatus.PROCESSING.value,
        LifecycleStatus.AVAILABLE.value,
        LifecycleStatus.ACCEPTED.value,
        LifecycleStatus.REFUSED.value,
        LifecycleStatus.REJECTED.value,
        LifecycleStatus.CANCELLED.value,
        LifecycleStatus.PAID.value,
        LifecycleStatus.CASHED.value,
        LifecycleStatus.FAILED.value,
    },
    LifecycleStatus.SUBMITTED.value: {
        LifecycleStatus.SUBMITTED.value,
        LifecycleStatus.PROCESSING.value,
        LifecycleStatus.AVAILABLE.value,
        LifecycleStatus.ACCEPTED.value,
        LifecycleStatus.REJECTED.value,
        LifecycleStatus.REFUSED.value,
        LifecycleStatus.CANCELLED.value,
        LifecycleStatus.PAID.value,
        LifecycleStatus.FAILED.value,
        LifecycleStatus.CASHED.value,
    },
    LifecycleStatus.PROCESSING.value: {
        LifecycleStatus.PROCESSING.value,
        LifecycleStatus.AVAILABLE.value,
        LifecycleStatus.ACCEPTED.value,
        LifecycleStatus.REJECTED.value,
        LifecycleStatus.REFUSED.value,
        LifecycleStatus.CANCELLED.value,
        LifecycleStatus.PAID.value,
        LifecycleStatus.CASHED.value,
        LifecycleStatus.FAILED.value,
    },
    LifecycleStatus.AVAILABLE.value: {
        LifecycleStatus.AVAILABLE.value,
        LifecycleStatus.ACCEPTED.value,
        LifecycleStatus.REFUSED.value,
        LifecycleStatus.REJECTED.value,
        LifecycleStatus.CANCELLED.value,
        LifecycleStatus.PAID.value,
        LifecycleStatus.CASHED.value,
        LifecycleStatus.FAILED.value,
    },
    LifecycleStatus.ACCEPTED.value: {
        LifecycleStatus.ACCEPTED.value,
        LifecycleStatus.PAID.value,
        LifecycleStatus.CASHED.value,
        LifecycleStatus.CANCELLED.value,
    },
    LifecycleStatus.PAID.value: {LifecycleStatus.PAID.value, LifecycleStatus.CASHED.value},
    LifecycleStatus.CASHED.value: {LifecycleStatus.CASHED.value},
    LifecycleStatus.REJECTED.value: {LifecycleStatus.REJECTED.value},
    LifecycleStatus.REFUSED.value: {LifecycleStatus.REFUSED.value},
    LifecycleStatus.CANCELLED.value: {LifecycleStatus.CANCELLED.value},
    LifecycleStatus.FAILED.value: {LifecycleStatus.FAILED.value},
}

_STATUS_MAP = {
    "accepted": LifecycleStatus.ACCEPTED.value,
    "accepte": LifecycleStatus.ACCEPTED.value,
    "acknowledged": LifecycleStatus.PROCESSING.value,
    "approved": LifecycleStatus.ACCEPTED.value,
    "done": LifecycleStatus.ACCEPTED.value,
    "ok": LifecycleStatus.ACCEPTED.value,
    "processed": LifecycleStatus.ACCEPTED.value,
    "delivered": LifecycleStatus.AVAILABLE.value,
    "available": LifecycleStatus.AVAILABLE.value,
    "mise_a_disposition": LifecycleStatus.AVAILABLE.value,
    "mise_a_dispo": LifecycleStatus.AVAILABLE.value,
    "processing": LifecycleStatus.PROCESSING.value,
    "pending": LifecycleStatus.PROCESSING.value,
    "en_cours": LifecycleStatus.PROCESSING.value,
    "in_progress": LifecycleStatus.PROCESSING.value,
    "received": LifecycleStatus.PROCESSING.value,
    "submitted": LifecycleStatus.SUBMITTED.value,
    "created": LifecycleStatus.SUBMITTED.value,
    "sent": LifecycleStatus.SUBMITTED.value,
    "queued": LifecycleStatus.SUBMITTED.value,
    "deposee": LifecycleStatus.SUBMITTED.value,
    "rejected": LifecycleStatus.REJECTED.value,
    "rejete": LifecycleStatus.REJECTED.value,
    "rejetee": LifecycleStatus.REJECTED.value,
    "invalid": LifecycleStatus.REJECTED.value,
    "refused": LifecycleStatus.REFUSED.value,
    "refuse": LifecycleStatus.REFUSED.value,
    "refusee": LifecycleStatus.REFUSED.value,
    "declined": LifecycleStatus.REFUSED.value,
    "cancelled": LifecycleStatus.CANCELLED.value,
    "canceled": LifecycleStatus.CANCELLED.value,
    "annule": LifecycleStatus.CANCELLED.value,
    "annulee": LifecycleStatus.CANCELLED.value,
    "paid": LifecycleStatus.PAID.value,
    "paye": LifecycleStatus.PAID.value,
    "payee": LifecycleStatus.PAID.value,
    "acquitted": LifecycleStatus.PAID.value,
    "settled": LifecycleStatus.PAID.value,
    "cashed": LifecycleStatus.CASHED.value,
    "collected": LifecycleStatus.CASHED.value,
    "encaisse": LifecycleStatus.CASHED.value,
    "encaissee": LifecycleStatus.CASHED.value,
    "failed": LifecycleStatus.FAILED.value,
    "error": LifecycleStatus.FAILED.value,
    "ko": LifecycleStatus.FAILED.value,
    "erreur": LifecycleStatus.FAILED.value,
}


def normalize_status(value: str | None) -> str:
    if not value:
        return LifecycleStatus.UNKNOWN.value
    key = value.strip().lower().replace(" ", "_").replace("-", "_")
    return _STATUS_MAP.get(key, LifecycleStatus.UNKNOWN.value)


def is_transition_allowed(current: str | None, target: str | None) -> bool:
    if not target:
        return False
    current_value = (current or LifecycleStatus.UNKNOWN.value).strip().lower() or LifecycleStatus.UNKNOWN.value
    target_value = target.strip().lower()
    allowed = ALLOWED_TRANSITIONS.get(current_value)
    if allowed is None:
        return target_value == current_value
    return target_value in allowed
