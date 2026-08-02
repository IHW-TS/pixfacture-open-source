from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from ..models import Customer, Invoice, Quote, Tenant
from ..services.invoices.amounts import invoice_balance_due_amount


def _fmt_date(value: date | datetime | None) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        value = value.date()
    return value.strftime("%d/%m/%Y")


def _fmt_amount(value: object | None, currency: str | None = "EUR") -> str:
    try:
        amount = Decimal(str(value or 0)).quantize(Decimal("0.01"))
    except Exception:
        amount = Decimal("0.00")
    return f"{amount:.2f} {currency or 'EUR'}"


def _customer_email(customer: Customer | None) -> str:
    return str(getattr(customer, "email", None) or "").strip()


def _customer_name(customer: Customer | None) -> str:
    return str(getattr(customer, "name", None) or "votre entreprise").strip()


def _tenant_name(tenant: Tenant | None) -> str:
    return str(getattr(tenant, "name", None) or "Votre fournisseur").strip()


def build_quote_email_draft(db: Session, quote: Quote, intent: str) -> dict[str, Any]:
    tenant = db.get(Tenant, quote.tenant_id)
    customer = db.get(Customer, quote.customer_id)
    intent = (intent or "send").strip().lower()
    number = quote.number or "votre devis"
    total = _fmt_amount(quote.total_inc_vat, quote.currency)
    valid_until = _fmt_date(quote.valid_until)
    customer_name = _customer_name(customer)
    if intent == "followup":
        subject = f"Relance - devis {number}"
        body = (
            f"Bonjour {customer_name},\n\n"
            f"Nous revenons vers vous au sujet du devis {number}, d'un montant de {total}."
        )
        if valid_until:
            body += f" Il reste valable jusqu'au {valid_until}."
        body += "\n\nVous pouvez le consulter et l'accepter depuis le lien sécurisé."
        reason = "Relance d'un devis envoyé, non encore accepté."
    elif intent == "accepted_thanks":
        subject = f"Merci pour votre acceptation - devis {number}"
        body = f"Bonjour {customer_name},\n\nNous confirmons l'acceptation du devis {number}."
        reason = "Confirmation après acceptation client."
    else:
        subject = f"Votre devis {number}"
        body = f"Bonjour {customer_name},\n\nVotre devis {number} est disponible. Montant TTC : {total}."
        if valid_until:
            body += f" Il est valable jusqu'au {valid_until}."
        body += "\n\nPour l'accepter, ouvrez le devis depuis le lien sécurisé."
        reason = "Envoi initial du devis au client."
    warnings = []
    if not _customer_email(customer):
        warnings.append("Aucun email principal n'est renseigné sur le client.")
    return {
        "subject": subject,
        "body": body,
        "to": _customer_email(customer),
        "include_public_link": True,
        "attach_pdf": intent == "send",
        "reason": reason,
        "warnings": warnings,
        "company_name": _tenant_name(tenant),
    }


def build_invoice_email_draft(db: Session, invoice: Invoice, intent: str) -> dict[str, Any]:
    tenant = db.get(Tenant, invoice.tenant_id)
    customer = db.get(Customer, invoice.customer_id)
    intent = (intent or "send").strip().lower()
    label = "avoir" if invoice.type == "credit_note" else "facture"
    number = invoice.number or f"votre {label}"
    total = _fmt_amount(abs(Decimal(str(invoice.total_inc_vat or 0))), invoice.currency)
    due_date = _fmt_date(invoice.due_date)
    customer_name = _customer_name(customer)
    if intent in {"before_due", "overdue_soft", "overdue_firm", "followup"}:
        balance = invoice_balance_due_amount(invoice.total_inc_vat, invoice.template_options, credits=0, paid=0)
        subject = f"Relance - facture {number}"
        body = f"Bonjour {customer_name},\n\nSauf erreur, la facture {number} présente un solde de {_fmt_amount(balance, invoice.currency)}."
        if due_date:
            body += f" Échéance : {due_date}."
        reason = "Relance de règlement."
        attach_pdf = False
    elif intent == "payment_received":
        subject = f"Paiement reçu - facture {number}"
        body = f"Bonjour {customer_name},\n\nNous confirmons la réception du règlement de la facture {number}."
        reason = "Confirmation de paiement."
        attach_pdf = False
    elif intent == "credit_note_send":
        subject = f"Votre avoir {number}"
        body = f"Bonjour {customer_name},\n\nVotre avoir {number} est disponible. Montant : {total}."
        reason = "Envoi d'un avoir au client."
        attach_pdf = True
    else:
        subject = f"Votre {label} {number}"
        body = f"Bonjour {customer_name},\n\nVotre {label} {number} est disponible. Montant TTC : {total}."
        if due_date and invoice.type != "credit_note":
            body += f" Échéance : {due_date}."
        reason = "Envoi initial du document au client."
        attach_pdf = True
    warnings = []
    if not _customer_email(customer):
        warnings.append("Aucun email principal n'est renseigné sur le client.")
    return {
        "subject": subject,
        "body": body,
        "to": _customer_email(customer),
        "include_public_link": True,
        "attach_pdf": attach_pdf,
        "reason": reason,
        "warnings": warnings,
        "company_name": _tenant_name(tenant),
    }
