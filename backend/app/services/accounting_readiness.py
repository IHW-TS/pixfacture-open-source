from __future__ import annotations

from decimal import Decimal
from typing import Any

from ..models import InboundInvoice, Invoice, InvoiceLine, Payment, Quote, QuoteLine
from .accounting_categories import (
    account_needs_completion,
    suggest_purchase_category_from_text,
    suggest_settlement_category_from_mode,
)


def _is_blank(value: object) -> bool:
    return not str(value or "").strip()


def _accounting_account_needs_completion(value: object) -> bool:
    return account_needs_completion(value)


def _money_is_nonzero(value: object) -> bool:
    try:
        return Decimal(str(value or 0)).copy_abs() > Decimal("0.0001")
    except Exception:
        return False


def _limited_examples(values: list[str], limit: int = 4) -> list[str]:
    clean = [str(value or "").strip() for value in values if str(value or "").strip()]
    return clean[:limit]


def _warning(
    *,
    code: str,
    scope: str,
    label: str,
    count: int,
    examples: list[str],
    action: str,
    href: str | None = None,
    cta_label: str | None = None,
    severity: str = "warning",
    user_label: str | None = None,
    action_label: str | None = None,
    suggested_category: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if count <= 0:
        return None
    return {
        "code": code,
        "scope": scope,
        "label": label,
        "count": count,
        "examples": _limited_examples(examples),
        "action": action,
        "href": href,
        "cta_label": cta_label,
        "severity": severity,
        "user_label": user_label or label,
        "action_label": action_label or cta_label or "Corriger",
        "suggested_category": suggested_category,
    }


def _payload(warnings: list[dict[str, Any] | None], *, target_type: str) -> dict[str, Any]:
    filtered = [warning for warning in warnings if warning]
    return {
        "target_type": target_type,
        "status": "needs_review" if filtered else "ready",
        "warnings_count": len(filtered),
        "warnings": filtered,
    }


def invoice_accounting_readiness(
    invoice: Invoice,
    *,
    lines: list[InvoiceLine],
    payments: list[Payment],
) -> dict[str, Any]:
    line_examples: list[str] = []
    line_count = 0
    for line in lines:
        if not _money_is_nonzero(line.line_total) or not _accounting_account_needs_completion(line.accounting_account):
            continue
        line_count += 1
        line_examples.append(f"{invoice.number or invoice.id} - {line.product_name}")

    payment_category_examples: list[str] = []
    payment_category_count = 0
    payment_mode_examples: list[str] = []
    payment_mode_count = 0
    for payment in payments:
        label = f"{invoice.number or invoice.id} - {payment.amount} {invoice.currency or 'EUR'}"
        if _is_blank(payment.accounting_category):
            payment_category_count += 1
            payment_category_examples.append(label)
        if _is_blank(payment.settlement_mode):
            payment_mode_count += 1
            payment_mode_examples.append(label)

    invoice_is_draft = str(invoice.status or "").lower() == "draft"
    invoice_accounting_href = (
        f"/app/invoices/new?edit_invoice={invoice.id}" if invoice_is_draft else "#accounting-correction"
    )
    invoice_accounting_action = (
        "Choisir la catégorie compta de la ligne avant émission. La catégorie “À valider par mon comptable” est temporaire et doit être corrigée avant un export final."
        if invoice_is_draft
        else "Facture déjà émise : le document client reste figé. Corriger uniquement la catégorie compta interne utilisée pour l’export."
    )

    return _payload(
        [
            _warning(
                code="invoice_lines_missing_account",
                scope="sales",
                label="Catégorie compta à choisir sur des lignes de vente",
                count=line_count,
                examples=line_examples,
                action=invoice_accounting_action,
                href=invoice_accounting_href,
                cta_label="Modifier la facture" if invoice_is_draft else "Corriger la catégorie",
            ),
            _warning(
                code="payments_missing_category",
                scope="payments",
                label="Paiements sans catégorie de règlement",
                count=payment_category_count,
                examples=payment_category_examples,
                action="Choisir Banque ou Caisse pour classer le règlement dans le dossier comptable.",
                suggested_category=suggest_settlement_category_from_mode("bank"),
            ),
            _warning(
                code="payments_missing_mode",
                scope="payments",
                label="Paiements sans mode de règlement",
                count=payment_mode_count,
                examples=payment_mode_examples,
                action="Indiquer le mode de règlement manuel, caisse ou banque.",
            ),
        ],
        target_type="invoice",
    )


def quote_accounting_readiness(quote: Quote, *, lines: list[QuoteLine]) -> dict[str, Any]:
    line_examples: list[str] = []
    line_count = 0
    for line in lines:
        if not _money_is_nonzero(line.line_total) or not _accounting_account_needs_completion(line.accounting_account):
            continue
        line_count += 1
        line_examples.append(f"{quote.number or quote.id} - {line.product_name}")

    quote_is_draft = str(quote.status or "").lower() == "draft"
    quote_accounting_href = f"/app/quotes/new?edit_quote={quote.id}" if quote_is_draft else "#accounting-correction"
    quote_accounting_action = (
        "Choisir la catégorie compta de la ligne avant envoi ou conversion. La catégorie “À valider par mon comptable” est temporaire."
        if quote_is_draft
        else "Devis déjà envoyé ou figé : le document client reste inchangé. Corriger uniquement la catégorie compta interne."
    )

    return _payload(
        [
            _warning(
                code="quote_lines_missing_account",
                scope="sales",
                label="Catégorie compta à choisir sur des lignes de devis",
                count=line_count,
                examples=line_examples,
                action=quote_accounting_action,
                href=quote_accounting_href,
                cta_label="Modifier le devis" if quote_is_draft else "Corriger la catégorie",
            ),
        ],
        target_type="quote",
    )


def purchase_accounting_readiness(purchase: InboundInvoice) -> dict[str, Any]:
    purchase_label = purchase.invoice_number or purchase.supplier_name or purchase.id
    validation_status = str(purchase.validation_status or "").lower()
    validation_count = 1 if validation_status in {"invalid", "failed", "unavailable"} else 0
    validation_examples = [str(purchase_label)] if validation_count else []
    validation_label = (
        "Pièce fournisseur à corriger"
        if validation_status in {"invalid", "failed"}
        else "Contrôle fournisseur à vérifier"
    )
    validation_action = (
        "Le justificatif ne passe pas les contrôles Factur-X/XML. "
        "Remplacez la pièce ou isolez cet achat avant un export comptable strict."
        if validation_status in {"invalid", "failed"}
        else "Le contrôle automatique n'a pas pu confirmer la conformité du justificatif. "
        "Vérifiez la pièce avant export comptable."
    )
    completion_count = 0
    completion_examples: list[str] = []
    if str(purchase.completion_status or "").lower() != "completed":
        completion_count = 1
        completion_examples.append(str(purchase_label))

    missing_purchase_account = 0
    missing_purchase_account_examples: list[str] = []
    missing_line_account = 0
    missing_line_account_examples: list[str] = []
    raw_lines = purchase.purchase_lines if isinstance(purchase.purchase_lines, list) else []
    if raw_lines:
        for index, raw_line in enumerate(raw_lines, start=1):
            line = raw_line if isinstance(raw_line, dict) else {}
            account = str(line.get("accounting_account") or purchase.accounting_account or "").strip()
            if _money_is_nonzero(line.get("total_ex_vat")) and _accounting_account_needs_completion(account):
                missing_line_account += 1
                missing_line_account_examples.append(f"{purchase_label} - ligne {index}")
    elif _accounting_account_needs_completion(purchase.accounting_account):
        missing_purchase_account = 1
        missing_purchase_account_examples.append(str(purchase_label))

    missing_issue_date = 0
    missing_issue_examples: list[str] = []
    if purchase.issue_date is None:
        missing_issue_date = 1
        missing_issue_examples.append(str(purchase_label))

    return _payload(
        [
            _warning(
                code="purchase_document_validation",
                scope="purchases",
                label=validation_label,
                count=validation_count,
                examples=validation_examples,
                action=validation_action,
                href="#purchase-source-document",
                cta_label="Voir le justificatif",
                severity="blocking",
            ),
            _warning(
                code="purchases_not_completed",
                scope="purchases",
                label="Fiche achat à compléter",
                count=completion_count,
                examples=completion_examples,
                action="Finaliser la fiche achat ou la mettre à part avant l’export compta.",
                href="#purchase-form-main",
                cta_label="Corriger la fiche",
            ),
            _warning(
                code="purchases_missing_account",
                scope="purchases",
                label="Dépenses à catégoriser",
                count=missing_purchase_account,
                examples=missing_purchase_account_examples,
                action="Choisir une catégorie compta pour l’achat. “À valider par mon comptable” est temporaire et doit être corrigé avant un export final.",
                href="#purchase-accounting-section",
                cta_label="Choisir la catégorie",
                suggested_category=suggest_purchase_category_from_text(
                    f"{purchase.supplier_name or ''} {purchase.invoice_number or ''} {purchase.accountant_note or ''}"
                ),
            ),
            _warning(
                code="purchase_lines_missing_account",
                scope="purchases",
                label="Catégorie compta à choisir sur une ou plusieurs lignes",
                count=missing_line_account,
                examples=missing_line_account_examples,
                action="Compléter les catégories ligne par ligne ou appliquer une règle fournisseur. “À valider par mon comptable” est temporaire.",
                href="#purchase-lines-section",
                cta_label="Corriger les lignes",
                suggested_category=suggest_purchase_category_from_text(
                    " ".join(
                        str((raw if isinstance(raw, dict) else {}).get("label") or "")
                        for raw in (purchase.purchase_lines if isinstance(purchase.purchase_lines, list) else [])
                    )
                ),
            ),
            _warning(
                code="purchases_missing_issue_date",
                scope="purchases",
                label="Date de facture fournisseur manquante",
                count=missing_issue_date,
                examples=missing_issue_examples,
                action="Ajouter la date de facture fournisseur pour rattacher l’achat à la bonne période.",
                href="#purchase-document-section",
                cta_label="Ajouter la date",
            ),
        ],
        target_type="purchase",
    )
