from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

from sqlalchemy.orm import Session

from ..models import Customer, Invoice, InvoiceLine, Quote, QuoteLine, Tenant


READINESS_INTENTS = {"save", "send", "issue", "convert", "share", "email", "followup", "credit_note"}


def _text(value: object | None) -> str:
    return str(value or "").strip()


def _has_text(value: object | None) -> bool:
    return bool(_text(value))


def _digits(value: object | None) -> str:
    return "".join(ch for ch in _text(value) if ch.isdigit())


def _is_fr(value: object | None) -> bool:
    return (_text(value) or "FR").upper() == "FR"


def _is_business(customer: Customer | None) -> bool:
    client_type = _text(getattr(customer, "client_type", None)).lower()
    return client_type not in {"individual", "particulier", "consumer", "b2c", "private"}


def _has_legal_id(value: object | None) -> bool:
    return len(_digits(value)) in {9, 14}


def _has_address(entity: object | None) -> bool:
    if entity is None:
        return False
    if _has_text(getattr(entity, "address", None)):
        return True
    return all(_has_text(getattr(entity, attr, None)) for attr in ("address_line1", "postal_code", "city"))


def _amount(value: object | None) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _as_date(value: date | datetime | None) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    return value


def _is_item(line: object) -> bool:
    return _text(getattr(line, "line_type", None) or "item").lower() == "item"


def _billable_lines(lines: Iterable[InvoiceLine | QuoteLine]) -> list[InvoiceLine | QuoteLine]:
    return [line for line in lines if _is_item(line)]


def _line_label(line: object, index: int) -> str:
    return _text(getattr(line, "product_name", None)) or f"Ligne {index}"


def _line_vat_needs_reason(line: object, tenant: Tenant | None) -> bool:
    rate = _amount(getattr(line, "vat_rate", 0))
    category = _text(getattr(line, "vat_category", None) or "S").upper()
    if rate != 0 and category == "S":
        return False
    if _has_text(getattr(line, "exemption_reason_code", None)):
        return False
    if tenant and _has_text(getattr(tenant, "vat_exemption_notice", None)):
        return False
    return True


def _check(
    code: str,
    severity: str,
    label: str,
    message: str,
    *,
    auto_fixable: bool = False,
    action_label: str = "Corriger",
    href: str | None = None,
) -> dict[str, Any]:
    return {
        "code": code,
        "severity": severity,
        "label": label,
        "message": message,
        "auto_fixable": bool(auto_fixable),
        "action_label": action_label,
        **({"href": href} if href else {}),
    }


def _next_action(
    kind: str,
    label: str,
    reason: str,
    *,
    danger_level: str = "info",
    auto_fixable: bool = False,
    api_action: str | None = None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "label": label,
        "reason": reason,
        "danger_level": danger_level,
        "autoFixable": bool(auto_fixable),
        "apiAction": api_action,
    }


def _has_check(checks: Iterable[dict[str, Any]], *codes: str) -> bool:
    expected = set(codes)
    return any(str(check.get("code") or "") in expected for check in checks)


def _auto_fixable(checks: Iterable[dict[str, Any]]) -> bool:
    return any(bool(check.get("auto_fixable")) for check in checks)


def readiness_payload(
    *,
    target_type: str,
    target_id: str,
    intent: str,
    checks: list[dict[str, Any]],
) -> dict[str, Any]:
    blocking_count = sum(1 for check in checks if check.get("severity") == "blocking")
    warning_count = sum(1 for check in checks if check.get("severity") == "warning")
    status = "blocked" if blocking_count else "needs_review" if warning_count else "ready"
    score = max(0, min(100, 100 - blocking_count * 35 - warning_count * 10))
    payload = {
        "target_type": target_type,
        "target_id": target_id,
        "intent": intent if intent in READINESS_INTENTS else "save",
        "status": status,
        "score": score,
        "blocking_count": blocking_count,
        "warning_count": warning_count,
        "checks": checks,
        "autoFixable": _auto_fixable(checks),
    }
    payload["summary"] = summarize_readiness(payload)
    return payload


def summarize_readiness(payload: dict[str, Any]) -> str:
    status = payload.get("status")
    blocking = int(payload.get("blocking_count") or 0)
    warnings = int(payload.get("warning_count") or 0)
    if status == "ready":
        return "Document prêt pour cette action."
    if blocking:
        return f"{blocking} point(s) bloquant(s) à corriger avant de continuer."
    return f"{warnings} point(s) à vérifier avant de continuer."


def can_apply_auto_fix(payload: dict[str, Any]) -> bool:
    return any(check.get("auto_fixable") for check in payload.get("checks") or [])


def _tenant_checks(tenant: Tenant | None) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    if not tenant:
        return [
            _check(
                "tenant_missing",
                "blocking",
                "Entreprise introuvable",
                "Impossible de retrouver le dossier entreprise.",
            )
        ]
    if not _has_text(tenant.name):
        checks.append(
            _check("tenant_name_missing", "blocking", "Entreprise incomplète", "Renseignez le nom de l'entreprise.")
        )
    if not _has_address(tenant):
        checks.append(
            _check(
                "tenant_address_missing",
                "blocking",
                "Adresse entreprise incomplète",
                "Renseignez l'adresse complète de l'entreprise.",
            )
        )
    if _is_fr(getattr(tenant, "country", None)):
        if not _has_legal_id(getattr(tenant, "siret", None)):
            checks.append(
                _check(
                    "tenant_siret_missing",
                    "blocking",
                    "SIRET entreprise manquant",
                    "Renseignez le SIRET de l'entreprise.",
                )
            )
        if not (
            _has_text(getattr(tenant, "vat_number", None)) or _has_text(getattr(tenant, "vat_exemption_notice", None))
        ):
            checks.append(
                _check(
                    "tenant_vat_missing",
                    "blocking",
                    "TVA entreprise à préciser",
                    "Renseignez un numéro de TVA ou une mention d'exonération.",
                )
            )
    if not _has_text(getattr(tenant, "iban", None)) or not _has_text(getattr(tenant, "bic", None)):
        checks.append(
            _check(
                "tenant_bank_details_missing",
                "warning",
                "Coordonnées bancaires à vérifier",
                "IBAN/BIC absents : le client peut manquer d'information pour payer.",
            )
        )
    return checks


def _customer_checks(customer: Customer | None, *, target: str, intent: str) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    if not customer:
        return [_check("customer_missing", "blocking", "Client manquant", "Sélectionnez un client.")]
    if not _has_text(customer.name):
        checks.append(
            _check("customer_name_missing", "blocking", "Nom client manquant", "Renseignez le nom du client.")
        )
    address_severity = "blocking" if target == "invoice" or intent == "convert" else "warning"
    if not _has_address(customer):
        checks.append(
            _check(
                "customer_address_missing",
                address_severity,
                "Adresse client incomplète",
                "Renseignez l'adresse complète du client.",
            )
        )
    if _is_fr(getattr(customer, "country", None)) and _is_business(customer):
        severity = "blocking" if target == "invoice" or intent == "convert" else "warning"
        if not _has_legal_id(getattr(customer, "siret", None) or getattr(customer, "siren", None)):
            checks.append(
                _check(
                    "customer_siret_missing",
                    severity,
                    "SIREN/SIRET client à compléter",
                    "Ajoutez le SIREN ou SIRET du client professionnel français.",
                )
            )
    return checks


def _line_checks(
    *,
    target: str,
    lines: list[InvoiceLine | QuoteLine],
    tenant: Tenant | None,
    intent: str,
) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    item_lines = _billable_lines(lines)
    if not item_lines:
        checks.append(
            _check(
                f"{target}_lines_missing",
                "blocking",
                "Aucune ligne produit/service",
                "Ajoutez au moins une ligne produit ou service.",
            )
        )
        return checks
    for index, line in enumerate(item_lines, start=1):
        label = _line_label(line, index)
        if not _has_text(getattr(line, "product_name", None)):
            checks.append(
                _check(
                    f"{target}_line_name_missing",
                    "blocking",
                    "Désignation manquante",
                    f"La ligne {index} doit avoir une désignation.",
                )
            )
        if _amount(getattr(line, "quantity", None)) <= 0:
            checks.append(
                _check(
                    f"{target}_line_quantity_invalid",
                    "blocking",
                    "Quantité invalide",
                    f"La ligne « {label} » doit avoir une quantité supérieure à 0.",
                )
            )
        if getattr(line, "unit_price", None) is None:
            checks.append(
                _check(
                    f"{target}_line_unit_price_missing",
                    "blocking",
                    "Prix unitaire manquant",
                    f"La ligne « {label} » doit avoir un prix unitaire.",
                )
            )
        if _line_vat_needs_reason(line, tenant):
            severity = "blocking" if intent in {"issue", "convert"} else "warning"
            checks.append(
                _check(
                    f"{target}_line_vat_reason_missing",
                    severity,
                    "Motif TVA à préciser",
                    f"La ligne « {label} » a une TVA à 0 ou non standard : ajoutez un motif/code d'exonération.",
                )
            )
    return checks


def invoice_readiness(db: Session, tenant_id: str, invoice_id: str, intent: str = "issue") -> dict[str, Any]:
    intent = intent if intent in READINESS_INTENTS else "issue"
    invoice = db.get(Invoice, invoice_id)
    if not invoice or invoice.tenant_id != tenant_id:
        return readiness_payload(
            target_type="invoice",
            target_id=invoice_id,
            intent=intent,
            checks=[
                _check("invoice_missing", "blocking", "Facture introuvable", "Impossible de retrouver la facture.")
            ],
        )
    tenant = db.get(Tenant, tenant_id)
    customer = db.get(Customer, invoice.customer_id) if invoice.customer_id else None
    lines = db.query(InvoiceLine).filter(InvoiceLine.invoice_id == invoice.id).order_by(InvoiceLine.id.asc()).all()

    checks: list[dict[str, Any]] = []
    checks.extend(_tenant_checks(tenant))
    checks.extend(_customer_checks(customer, target="invoice", intent=intent))
    checks.extend(_line_checks(target="invoice", lines=lines, tenant=tenant, intent=intent))

    if intent in {"issue", "send", "email", "share", "followup"}:
        if invoice.status == "canceled":
            checks.append(_check("invoice_canceled", "blocking", "Facture annulée", "Cette facture est annulée."))
        if intent == "issue" and (invoice.issued_at or invoice.status != "draft"):
            checks.append(
                _check(
                    "invoice_already_issued",
                    "blocking",
                    "Facture déjà émise",
                    "Une facture émise ne peut plus être réémise depuis ce brouillon.",
                )
            )
        if intent in {"email", "share", "followup"} and invoice.status == "draft":
            checks.append(
                _check(
                    "invoice_not_issued",
                    "blocking",
                    "Facture non émise",
                    "Émettez définitivement la facture avant de l'envoyer ou de partager le lien.",
                )
            )
    if intent == "credit_note" and invoice.type != "invoice":
        checks.append(
            _check("credit_note_source_invalid", "blocking", "Source invalide", "Un avoir doit partir d'une facture.")
        )
    if invoice.type == "credit_note" and not invoice.related_invoice_id:
        checks.append(
            _check(
                "credit_note_origin_missing",
                "blocking",
                "Facture d'origine manquante",
                "Un avoir doit référencer une facture d'origine.",
            )
        )
    if invoice.invoice_kind == "final" and not invoice.quote_id:
        checks.append(
            _check(
                "final_invoice_quote_missing",
                "blocking",
                "Devis source manquant",
                "Une facture finale avec acompte doit rester liée au devis d'origine.",
            )
        )
    if not invoice.payment_terms and not invoice.due_date:
        checks.append(
            _check(
                "invoice_payment_terms_missing",
                "warning",
                "Conditions de paiement absentes",
                "Ajoutez des conditions de paiement avant d'émettre le document.",
            )
        )
    issue_date = _as_date(invoice.issue_date)
    due_date = _as_date(invoice.due_date)
    if not due_date:
        checks.append(
            _check(
                "invoice_due_date_missing",
                "warning",
                "Échéance absente",
                "Renseignez une échéance cohérente avec les conditions de paiement.",
            )
        )
    elif issue_date and due_date < issue_date:
        checks.append(
            _check(
                "invoice_due_date_before_issue",
                "warning",
                "Échéance incohérente",
                "L'échéance est avant la date de facture. Corrigez-la manuellement avant émission.",
            )
        )
    payload = readiness_payload(target_type="invoice", target_id=invoice.id, intent=intent, checks=checks)
    payload["next_action"] = invoice_readiness_next_action(invoice, payload)
    return payload


def quote_readiness(db: Session, tenant_id: str, quote_id: str, intent: str = "send") -> dict[str, Any]:
    intent = intent if intent in READINESS_INTENTS else "send"
    quote = db.get(Quote, quote_id)
    if not quote or quote.tenant_id != tenant_id:
        return readiness_payload(
            target_type="quote",
            target_id=quote_id,
            intent=intent,
            checks=[_check("quote_missing", "blocking", "Devis introuvable", "Impossible de retrouver le devis.")],
        )
    tenant = db.get(Tenant, tenant_id)
    customer = db.get(Customer, quote.customer_id) if quote.customer_id else None
    lines = db.query(QuoteLine).filter(QuoteLine.quote_id == quote.id).order_by(QuoteLine.id.asc()).all()

    checks: list[dict[str, Any]] = []
    checks.extend(_tenant_checks(tenant))
    checks.extend(_customer_checks(customer, target="quote", intent=intent))
    checks.extend(_line_checks(target="quote", lines=lines, tenant=tenant, intent=intent))

    today = date.today()
    if intent in {"save", "send", "share", "email"} and quote.status in {"accepted", "rejected", "invoiced", "expired"}:
        checks.append(
            _check(
                "quote_frozen",
                "blocking",
                "Devis figé",
                "Ce devis est accepté, refusé, expiré ou déjà facturé : le document client ne doit plus être modifié.",
            )
        )
    if not quote.valid_until:
        checks.append(
            _check(
                "quote_valid_until_missing",
                "warning",
                "Date de validité absente",
                "Ajoutez une date de validité avant d'envoyer le devis.",
            )
        )
    elif quote.valid_until < today:
        severity = "blocking" if intent == "convert" else "warning"
        checks.append(
            _check(
                "quote_expired",
                severity,
                "Devis expiré",
                "Le devis est expiré.",
            )
        )
    if intent == "convert":
        if quote.invoice_id:
            checks.append(
                _check(
                    "quote_already_converted",
                    "info",
                    "Facture déjà créée",
                    "Ce devis a déjà une facture liée.",
                )
            )
        elif quote.status == "rejected":
            checks.append(
                _check("quote_rejected", "blocking", "Devis refusé", "Un devis refusé ne peut pas être facturé.")
            )
        elif quote.status != "accepted":
            checks.append(
                _check(
                    "quote_not_accepted",
                    "blocking",
                    "Devis non accepté",
                    "Le client doit accepter le devis avant la création de la facture.",
                )
            )
    if intent == "followup" and quote.status != "sent":
        checks.append(
            _check(
                "quote_followup_not_sent",
                "blocking",
                "Relance impossible",
                "La relance est disponible uniquement pour un devis envoyé.",
            )
        )
    payload = readiness_payload(target_type="quote", target_id=quote.id, intent=intent, checks=checks)
    payload["next_action"] = quote_readiness_next_action(quote, payload)
    return payload


def invoice_readiness_next_action(invoice: Invoice, payload: dict[str, Any]) -> dict[str, Any]:
    checks = list(payload.get("checks") or [])
    status = _text(invoice.status).lower()
    balance_due = _amount(getattr(invoice, "balance_due", None))
    if balance_due == 0 and getattr(invoice, "total_inc_vat", None) is not None:
        balance_due = _amount(getattr(invoice, "total_inc_vat", None))

    if _has_check(checks, "customer_missing"):
        return _next_action(
            "choose_customer",
            "Choisir un client",
            "Un client est requis avant émission ou envoi.",
            danger_level="danger",
        )
    if _has_check(checks, "invoice_lines_missing"):
        return _next_action(
            "add_line",
            "Ajouter une ligne",
            "Au moins une ligne produit ou service est nécessaire.",
            danger_level="danger",
        )
    if status == "paid":
        return _next_action(
            "none_paid",
            "Facture soldée",
            "Aucune action de contrôle prioritaire n'est requise.",
            danger_level="none",
        )
    if getattr(invoice, "type", None) == "credit_note":
        return _next_action(
            "view_document",
            "Voir l'avoir",
            "Le document est un avoir, les actions de relance facture ne s'appliquent pas.",
            danger_level="none",
        )
    if status == "draft":
        return _next_action(
            "issue_invoice",
            "Émettre définitivement",
            "La facture peut être rendue définitive.",
            danger_level="info",
            api_action=f"POST /api/invoices/{invoice.id}/issue",
        )
    if status == "overdue" and balance_due > 0:
        return _next_action(
            "followup",
            "Préparer une relance",
            "La facture est en retard avec un solde restant dû.",
            danger_level="danger",
            api_action=f"POST /api/invoices/{invoice.id}/followup",
        )
    if status in {"issued", "sent", "partial", "overdue"} and not getattr(invoice, "sent_at", None):
        return _next_action(
            "send_invoice",
            "Envoyer",
            "La facture est émise mais aucun envoi client n'est enregistré.",
            danger_level="info",
            api_action=f"POST /api/invoices/{invoice.id}/email",
        )
    if balance_due > 0:
        return _next_action(
            "record_payment",
            "Enregistrer un règlement",
            "Un solde reste à encaisser.",
            danger_level="success",
            api_action=f"POST /api/invoices/{invoice.id}/payments",
        )
    return _next_action(
        "view_document",
        "Voir la facture",
        "Le document est prêt à être consulté.",
        danger_level="none",
    )


def quote_readiness_next_action(quote: Quote, payload: dict[str, Any]) -> dict[str, Any]:
    checks = list(payload.get("checks") or [])
    status = _text(quote.status).lower()

    if _has_check(checks, "customer_missing"):
        return _next_action(
            "choose_customer",
            "Choisir un client",
            "Un client est requis avant l'envoi du devis.",
            danger_level="danger",
        )
    if _has_check(checks, "quote_lines_missing"):
        return _next_action(
            "add_line",
            "Ajouter une ligne",
            "Au moins une ligne produit ou service est nécessaire.",
            danger_level="danger",
        )
    if getattr(quote, "invoice_id", None):
        return _next_action(
            "view_invoice",
            "Voir la facture",
            "Ce devis est déjà relié à une facture.",
            danger_level="none",
            api_action=f"GET /api/invoices/{quote.invoice_id}",
        )
    if status in {"expired", "rejected"} or _has_check(checks, "quote_expired"):
        return _next_action(
            "duplicate_quote",
            "Faire une copie modifiable",
            "Le devis est figé : créez une copie à jour avant de le renvoyer.",
            danger_level="warning",
            api_action=f"POST /api/quotes/{quote.id}/duplicate",
        )
    if status == "accepted":
        return _next_action(
            "create_invoice",
            "Créer la facture",
            "Le client a accepté le devis et aucune facture liée n'existe encore.",
            danger_level="success",
            api_action=f"POST /api/quotes/{quote.id}/convert",
        )
    if status == "sent":
        if int(getattr(quote, "public_view_count", 0) or 0) <= 0:
            return _next_action(
                "copy_link",
                "Copier le lien",
                "Le devis envoyé n'a pas encore été consulté.",
                danger_level="info",
                api_action=f"POST /api/quotes/{quote.id}/share",
            )
        return _next_action(
            "followup",
            "Préparer une relance",
            "Le devis a été consulté mais reste sans réponse.",
            danger_level="warning",
            api_action=f"POST /api/quotes/{quote.id}/followup",
        )
    return _next_action(
        "send_quote",
        "Envoyer le devis",
        "Le devis est prêt à être envoyé au client.",
        danger_level="info",
        api_action=f"POST /api/quotes/{quote.id}/email",
    )
