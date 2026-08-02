import hashlib
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Lead
from ..services import rate_limit
from ..services.email import send_email, smtp_diagnostic_payload
from ..utils.pii import hash_email


logger = logging.getLogger("leads")

LEAD_RATE_LIMIT = 10
LEAD_WINDOW_SECONDS = 10 * 60
LEAD_MESSAGE_MAX_LENGTH = 2000

router = APIRouter(prefix="/api", tags=["leads"])


def _normalize_optional(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _lead_rate_limit_key(ip: str, user_agent: str) -> str:
    ua = (user_agent or "unknown").strip()
    ua_hash = hashlib.sha256(ua.encode("utf-8")).hexdigest()[:12]
    ip_value = (ip or "unknown").strip() or "unknown"
    return f"leads:{ip_value}:{ua_hash}"


def _lead_message_preview(message: str, limit: int = 240) -> str:
    if not message:
        return ""
    line = message.strip().splitlines()[0].strip()
    if len(line) > limit:
        return f"{line[:limit].rstrip()}..."
    return line


class LeadPayload(BaseModel):
    email: EmailStr | None = None
    company: str | None = None
    message: str = Field(..., max_length=LEAD_MESSAGE_MAX_LENGTH)
    source: str | None = None
    website: str | None = None
    utm_source: str | None = None
    utm_medium: str | None = None
    utm_campaign: str | None = None
    utm_term: str | None = None
    utm_content: str | None = None

    @field_validator(
        "email",
        "company",
        "source",
        "website",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        mode="before",
    )
    @classmethod
    def _strip_optional(cls, value: str | None) -> str | None:
        return _normalize_optional(value)

    @field_validator("message")
    @classmethod
    def _strip_message(cls, value: str) -> str:
        if value is None:
            raise ValueError("Message requis.")
        normalized = str(value).strip()
        if not normalized:
            raise ValueError("Message requis.")
        if len(normalized) > LEAD_MESSAGE_MAX_LENGTH:
            raise ValueError("Message trop long.")
        return normalized


def _notify_sales(lead: Lead, message: str) -> None:
    sales_email = (settings.SALES_EMAIL or "").strip()
    if not sales_email:
        return
    if not smtp_diagnostic_payload().get("smtp_configured"):
        return
    preview = _lead_message_preview(message)
    subject_hint = lead.company or lead.email or "contact"
    subject = f"Nouveau lead ({subject_hint})"
    utm = {
        "utm_source": lead.utm_source,
        "utm_medium": lead.utm_medium,
        "utm_campaign": lead.utm_campaign,
        "utm_term": lead.utm_term,
        "utm_content": lead.utm_content,
    }
    utm_lines = [f"{k}: {v}" for k, v in utm.items() if v]
    body_lines = [
        "Nouveau lead capté via /contact.",
        "",
        f"Email: {lead.email or '-'}",
        f"Société: {lead.company or '-'}",
        f"Message (aperçu): {preview or '-'}",
        f"Source: {lead.source or '-'}",
    ]
    if utm_lines:
        body_lines.append("")
        body_lines.append("UTM:")
        body_lines.extend(utm_lines)
    if lead.ip or lead.user_agent:
        body_lines.append("")
        body_lines.append(f"IP: {lead.ip or '-'}")
        body_lines.append(f"User-Agent: {lead.user_agent or '-'}")
    text = "\n".join(body_lines).strip()
    try:
        send_email(
            sales_email,
            subject,
            text=text,
            reply_to=lead.email,
        )
    except Exception:
        logger.exception("lead_notify_failed", extra={"email_hash": hash_email(lead.email or "")})


@router.post("/leads")
def create_lead(
    body: LeadPayload,
    request: Request,
    db: Session = Depends(get_db),
):
    if body.website:
        raise HTTPException(status_code=400, detail={"code": "invalid_request", "message": "Requête invalide."})
    ip = request.client.host if request.client else "unknown"
    user_agent = (request.headers.get("user-agent") or "").strip()
    key = _lead_rate_limit_key(ip, user_agent)
    if rate_limit.hit(key, LEAD_RATE_LIMIT, LEAD_WINDOW_SECONDS):
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "Trop de demandes, réessayez plus tard."},
        )
    email = body.email.strip().lower() if body.email else None
    company = body.company.strip() if body.company else None
    source = body.source.strip() if body.source else None
    message = body.message.strip()
    lead = Lead(
        email=email,
        company=company,
        message=message,
        source=source or "contact_page",
        utm_source=body.utm_source,
        utm_medium=body.utm_medium,
        utm_campaign=body.utm_campaign,
        utm_term=body.utm_term,
        utm_content=body.utm_content,
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        ip=ip,
        user_agent=user_agent,
    )
    db.add(lead)
    db.commit()
    db.refresh(lead)

    logger.info(
        json.dumps(
            {
                "event": "lead_captured",
                "email_hash": hash_email(email or ""),
                "company_present": bool(company),
                "source": lead.source,
                "user_agent_present": bool(user_agent),
            },
            separators=(",", ":"),
            ensure_ascii=True,
        )
    )
    _notify_sales(lead, message)
    return {"ok": True}
