import logging
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import getaddresses
from pathlib import Path

from fastapi import HTTPException
from jinja2 import Environment, FileSystemLoader, select_autoescape

from ..config import settings

logger = logging.getLogger(__name__)

EMAIL_TEMPLATES = Environment(
    loader=FileSystemLoader(Path(__file__).resolve().parents[1] / "templates" / "email"),
    autoescape=select_autoescape(["html", "xml"]),
)


def _smtp() -> tuple[str, int, str | None, str | None, str | None, bool]:
    if not settings.SMTP_HOST:
        raise RuntimeError("SMTP non configuré")
    return (
        settings.SMTP_HOST,
        settings.SMTP_PORT,
        settings.SMTP_USERNAME,
        settings.SMTP_PASSWORD,
        settings.SMTP_FROM,
        settings.SMTP_STARTTLS,
    )


def smtp_diagnostic_payload() -> dict:
    smtp_enabled = bool(getattr(settings, "SMTP_ENABLED", False))
    host = (settings.SMTP_HOST or "").strip()
    username = (settings.SMTP_USERNAME or "").strip()
    password = (settings.SMTP_PASSWORD or "").strip()
    from_ok = bool((settings.SMTP_FROM or "").strip() or username)
    smtp_configured = bool(smtp_enabled and host and username and password)
    return {
        "smtp_configured": smtp_configured,
        "provider": "smtp",
        "from_ok": from_ok,
    }


def email_delivery_status_payload(reply_to: str | None = None) -> dict:
    diagnostic = smtp_diagnostic_payload()
    smtp_configured = bool(diagnostic.get("smtp_configured"))
    delivery_mode = "smtp" if smtp_configured else "log_only"
    from_email = (settings.SMTP_FROM or settings.SMTP_USERNAME or "").strip() or None
    reply_to_value = (reply_to or "").strip() or None
    return {
        "smtp_configured": smtp_configured,
        "delivery_mode": delivery_mode,
        "delivery_mode_label": "Email actif" if smtp_configured else "Envoi email non configuré",
        "can_send_real_email": smtp_configured,
        "provider": diagnostic.get("provider") or "smtp",
        "from_ok": bool(diagnostic.get("from_ok")),
        "from_email": from_email,
        "reply_to": reply_to_value,
        "message": (
            "Les emails seront envoyés via le canal email configuré."
            if smtp_configured
            else "Canal email non configuré : le message sera préparé et journalisé, sans envoi réel."
        ),
    }


def assert_smtp_ready_or_raise(action: str | None = None) -> bool:
    payload = smtp_diagnostic_payload()
    if payload["smtp_configured"]:
        return True
    env = (settings.APP_ENV or "").strip().lower()
    prod_like = env in {"prod", "production", "staging"}
    if prod_like:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "smtp_not_configured",
                "message": "Emails transactionnels inactifs : finalisez la configuration email avant l'envoi réel.",
            },
        )
    if action:
        logger.warning("SMTP disabled -> log-only for %s.", action)
    return False


def _make_text_from_html(html: str) -> str:
    clean = re.sub("<[^<]+?>", "", html or "")
    return re.sub(r"\s+", " ", clean).strip()


def _address_values(value: list[str] | str | None) -> list[str]:
    raw_values = [value] if isinstance(value, str) else list(value or [])
    normalized = [raw.replace(";", ",") for raw in raw_values if raw]
    addresses = [address.strip() for _, address in getaddresses(normalized) if address.strip()]
    if addresses:
        return addresses
    return [part.strip() for raw in normalized for part in re.split(r"[,;\s]+", raw) if part.strip()]


_BLOCKED_CUSTOM_HEADERS = {
    "bcc",
    "cc",
    "content-transfer-encoding",
    "content-type",
    "date",
    "from",
    "mime-version",
    "reply-to",
    "sender",
    "subject",
    "to",
}


def _safe_custom_headers(headers: dict[str, str] | None) -> dict[str, str]:
    safe: dict[str, str] = {}
    for raw_name, raw_value in (headers or {}).items():
        name = str(raw_name or "").strip()
        value = str(raw_value or "").strip()
        if not name or not value:
            continue
        if "\r" in name or "\n" in name or "\r" in value or "\n" in value:
            continue
        if name.lower() in _BLOCKED_CUSTOM_HEADERS:
            continue
        safe[name] = value[:500]
    return safe


def render_email_template(name: str, context: dict) -> str:
    return EMAIL_TEMPLATES.get_template(name).render(**(context or {}))


def send_email(
    to: str,
    subject: str,
    text: str = "",
    attachments: list[tuple[str, bytes, str]] | None = None,
    reply_to: str | None = None,
    cc: list[str] | str | None = None,
    bcc: list[str] | str | None = None,
    html: str | None = None,
    template: str | None = None,
    context: dict | None = None,
    headers: dict[str, str] | None = None,
) -> None:
    if template and not html:
        html = render_email_template(template, context or {})
    if not text and html:
        text = _make_text_from_html(html)
    host, port, user, pwd, sender, starttls = _smtp()
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender or user or ""
    to_values = _address_values(to)
    if not to_values:
        raise RuntimeError("Aucun destinataire email")
    msg["To"] = ", ".join(to_values)
    cc_values = _address_values(cc)
    bcc_values = _address_values(bcc)
    if cc_values:
        msg["Cc"] = ", ".join(cc_values)
    if reply_to:
        msg["Reply-To"] = reply_to
    for header_name, header_value in _safe_custom_headers(headers).items():
        msg[header_name] = header_value
    if html:
        msg.set_content(text or "")
        msg.add_alternative(html, subtype="html")
    else:
        msg.set_content(text or "")
    for filename, data, content_type in attachments or []:
        maintype, subtype = (content_type.split("/", 1) + ["octet-stream"])[:2]
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    ctx = ssl.create_default_context()
    with smtplib.SMTP(host, port) as s:
        if starttls:
            s.starttls(context=ctx)
        if user and pwd:
            s.login(user, pwd)
        recipients = [*to_values, *cc_values, *bcc_values]
        s.send_message(msg, to_addrs=recipients)
