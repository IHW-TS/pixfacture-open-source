from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from ..models import ActionLog
from ..utils.audit import sanitize_action_log_metadata, sanitize_action_log_payload

logger = logging.getLogger("action_log")


def log_action(
    db: Session,
    *,
    tenant_id: str,
    actor_user_id: str | None,
    action_type: str,
    object_type: str,
    object_id: str,
    metadata: dict | list | str | None = None,
    commit: bool = False,
) -> ActionLog:
    payload = sanitize_action_log_payload(metadata) if metadata is not None else None
    metadata_json = sanitize_action_log_metadata(metadata) if metadata is not None else None
    log = ActionLog(
        tenant_id=tenant_id,
        user_id=actor_user_id,
        entity=object_type,
        entity_id=object_id,
        action=action_type,
        payload=payload,
        metadata_json=metadata_json,
    )
    db.add(log)
    if commit:
        db.commit()
    return log


def safe_log_action(
    db: Session,
    *,
    tenant_id: str,
    actor_user_id: str | None,
    action_type: str,
    object_type: str,
    object_id: str,
    metadata: dict | list | str | None = None,
    commit: bool = False,
) -> None:
    try:
        log_action(
            db,
            tenant_id=tenant_id,
            actor_user_id=actor_user_id,
            action_type=action_type,
            object_type=object_type,
            object_id=object_id,
            metadata=metadata,
            commit=commit,
        )
    except Exception:
        if commit:
            try:
                db.rollback()
            except Exception:
                pass
        logger.exception("action_log_failed", extra={"action_type": action_type, "object_type": object_type})
