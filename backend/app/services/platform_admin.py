import logging

from sqlalchemy.orm import Session

from app.models import User
from app.utils.pii import mask_email

logger = logging.getLogger("admin.promote")


def _normalize_email(value: str | None) -> str:
    return (value or "").strip().lower()


def promote_platform_admin(db: Session, email: str) -> User | None:
    normalized = _normalize_email(email)
    if not normalized:
        return None
    user = db.query(User).filter(User.email == normalized).first()
    if not user:
        return None
    if not user.is_admin:
        user.is_admin = True
    if (user.status or "active") != "active":
        user.status = "active"
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info("Platform admin promoted: %s", mask_email(normalized))
    return user
