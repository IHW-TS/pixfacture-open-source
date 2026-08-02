from collections import defaultdict
from datetime import date
from decimal import Decimal
import re
from typing import Any

from lxml import etree

from .document_pdf_context import document_has_special_vat_context, resolved_vat_exemption_code, vat_zero_reason_label
from .seqino_periodicity_payload import is_vat_franchise_regime
from ..utils.money import calc_line_total, calc_tax_amount, quantize_amount
from ..utils.unit_codes import normalize_unit_code

NS_INVOICE = {
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    None: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
}
NS_CREDIT_NOTE = {
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    None: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
}
NS = NS_INVOICE
OPERATION_NATURE_LABELS = {
    "goods": "livraisons de biens",
    "services": "prestations de services",
    "mixed": "livraisons de biens et prestations de services",
}
VAT_ON_DEBITS_MENTION = "Option pour le paiement de la taxe d'après les débits"
POSTAL_CITY_RE = re.compile(r"^(?P<postal>\d{4,5})\s+(?P<city>.+)$")


def _new_vat_group() -> dict[str, Decimal | str]:
    return {
        "base": Decimal("0.00"),
        "tax": Decimal("0.00"),
        "cat": "S",
        "rate": Decimal("0.00"),
        "exemption_reason_code": "",
    }


def _decimal_from_group(group: dict[str, Decimal | str], key: str) -> Decimal:
    value = group[key]
    return value if isinstance(value, Decimal) else Decimal("0.00")


def _digits(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = "".join(ch for ch in value if ch.isdigit())
    return cleaned or None


def _resolve_type_code(invoice: dict[str, Any]) -> str:
    type_code = str(invoice.get("type_code") or "").strip()
    if type_code in {"380", "381"}:
        return type_code
    doc_type = (invoice.get("type") or "invoice").strip().lower()
    return "381" if doc_type == "credit_note" else "380"


def _party_identification(p: dict[str, Any]) -> tuple[str | None, str | None]:
    legal_id = _digits(p.get("legal_id"))
    siren = _digits(p.get("siren"))
    if legal_id and len(legal_id) == 14:
        return legal_id, "0009"
    if siren and len(siren) == 9:
        return siren, "0002"
    if legal_id and len(legal_id) == 9:
        return legal_id, "0002"
    return None, None


def _fmt_amount(value: Decimal) -> str:
    return f"{value:.2f}"


def _text_or_none(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _append_tax_exemption(
    tax_category: etree._Element,
    *,
    cat: str,
    rate: Decimal,
    exemption_code: str,
    supplier: dict[str, Any] | None,
    ns_map: dict[str | None, str],
) -> None:
    reason = vat_zero_reason_label(cat, exemption_code, supplier=supplier or None, rate=rate)
    if not reason and rate != 0:
        return
    if exemption_code:
        etree.SubElement(tax_category, f"{{{ns_map['cbc']}}}TaxExemptionReasonCode").text = exemption_code
    if reason:
        etree.SubElement(tax_category, f"{{{ns_map['cbc']}}}TaxExemptionReason").text = reason


def _append_document_notes(parent: etree._Element, ctx: dict[str, Any], ns_map: dict[str | None, str]) -> None:
    invoice = ctx.get("invoice", {}) or {}
    supplier = ctx.get("supplier", {}) or {}
    notes: list[str] = []
    note = _text_or_none(invoice.get("note"))
    if note:
        notes.append(note)
    operation_nature = str(invoice.get("operation_nature") or "").strip().lower()
    operation_label = OPERATION_NATURE_LABELS.get(operation_nature)
    if operation_label:
        notes.append(f"Nature de l'opération : {operation_label}")
    if supplier.get("vat_on_debits") and not document_has_special_vat_context(supplier, ctx.get("lines") or []):
        notes.append(VAT_ON_DEBITS_MENTION)
    for note_text in notes:
        etree.SubElement(parent, f"{{{ns_map['cbc']}}}Note").text = note_text


def _parse_address_text(address: Any, *, fallback_country: str | None = None) -> dict[str, str | None]:
    lines = [line.strip() for line in str(address or "").splitlines() if line.strip()]
    country = (fallback_country or "").strip().upper() or None
    if lines:
        last = lines[-1].strip()
        if len(last) in {2, 3} and last.isalpha():
            country = country or last.upper()
            lines = lines[:-1]
    street = lines[0] if lines else None
    postal = None
    city = None
    if lines:
        match = POSTAL_CITY_RE.match(lines[-1])
        if match:
            postal = match.group("postal")
            city = match.group("city").strip()
            if len(lines) > 1:
                street = lines[0]
    return {
        "street": street,
        "postal_code": postal,
        "city": city,
        "country_code": country,
        "raw": "\n".join(lines),
    }


def _append_postal_address(
    parent: etree._Element,
    tag: str,
    address: dict[str, str | None],
    ns_map: dict[str | None, str],
) -> etree._Element:
    node = etree.SubElement(parent, f"{{{ns_map['cac']}}}{tag}")
    street = _text_or_none(address.get("street"))
    city = _text_or_none(address.get("city"))
    postal = _text_or_none(address.get("postal_code"))
    raw = _text_or_none(address.get("raw"))
    country = _text_or_none(address.get("country_code"))
    if street:
        etree.SubElement(node, f"{{{ns_map['cbc']}}}StreetName").text = street
    if city:
        etree.SubElement(node, f"{{{ns_map['cbc']}}}CityName").text = city
    if postal:
        etree.SubElement(node, f"{{{ns_map['cbc']}}}PostalZone").text = postal
    if raw and raw != street and not (city and postal):
        address_line = etree.SubElement(node, f"{{{ns_map['cac']}}}AddressLine")
        etree.SubElement(address_line, f"{{{ns_map['cbc']}}}Line").text = raw
    if country:
        etree.SubElement(
            etree.SubElement(node, f"{{{ns_map['cac']}}}Country"),
            f"{{{ns_map['cbc']}}}IdentificationCode",
        ).text = country
    return node


def _append_delivery(parent: etree._Element, ctx: dict[str, Any], ns_map: dict[str | None, str]) -> None:
    invoice = ctx.get("invoice", {}) or {}
    service_date = _text_or_none(invoice.get("service_date"))
    delivery_address = _text_or_none(invoice.get("delivery_address"))
    if not service_date and not delivery_address:
        return
    delivery = etree.SubElement(parent, f"{{{ns_map['cac']}}}Delivery")
    if service_date:
        etree.SubElement(delivery, f"{{{ns_map['cbc']}}}ActualDeliveryDate").text = service_date
    if delivery_address:
        location = etree.SubElement(delivery, f"{{{ns_map['cac']}}}DeliveryLocation")
        _append_postal_address(
            location,
            "Address",
            _parse_address_text(delivery_address, fallback_country=(ctx.get("customer") or {}).get("country_code")),
            ns_map,
        )


def _payment_terms(invoice: dict[str, Any], ns_map: dict[str | None, str]) -> etree._Element | None:
    payment_terms = _text_or_none(invoice.get("payment_terms"))
    if not payment_terms:
        return None
    node = etree.Element(f"{{{ns_map['cac']}}}PaymentTerms")
    etree.SubElement(node, f"{{{ns_map['cbc']}}}Note").text = payment_terms
    return node


def _related_invoice_number(ctx: dict[str, Any]) -> str | None:
    invoice = (ctx or {}).get("invoice") or {}
    related_number = (invoice.get("related_number") or "").strip()
    if related_number:
        return related_number
    related_invoice = invoice.get("related_invoice")
    if isinstance(related_invoice, dict):
        related_number = (related_invoice.get("number") or "").strip()
        if related_number:
            return related_number
    elif related_invoice:
        related_number = str(related_invoice).strip()
        if related_number:
            return related_number
    return None


def ubl_document_xml(ctx: dict[str, Any]) -> bytes:
    invoice = ctx.get("invoice", {}) or {}
    doc_type = (invoice.get("type") or "").strip().lower()
    if not doc_type:
        doc_type = "credit_note" if _resolve_type_code(invoice) == "381" else "invoice"
    if doc_type == "credit_note":
        return ubl_credit_note_xml(ctx)
    return ubl_invoice_xml(ctx)


def ubl_credit_note_xml(ctx: dict[str, Any]) -> bytes:
    return _ubl_xml(
        ctx,
        ns_map=NS_CREDIT_NOTE,
        root_tag="CreditNote",
        line_tag="CreditNoteLine",
        type_code_tag="CreditNoteTypeCode",
        force_type="credit_note",
    )


def ubl_invoice_xml(ctx: dict[str, Any]) -> bytes:
    return _ubl_xml(
        ctx,
        ns_map=NS_INVOICE,
        root_tag="Invoice",
        line_tag="InvoiceLine",
        type_code_tag="InvoiceTypeCode",
    )


def _ubl_xml(
    ctx: dict[str, Any],
    *,
    ns_map: dict[str | None, str],
    root_tag: str,
    line_tag: str,
    type_code_tag: str,
    force_type: str | None = None,
) -> bytes:
    inv = etree.Element(root_tag, nsmap=ns_map)
    invoice = ctx.get("invoice", {}) or {}
    customization_id = (
        invoice.get("ubl_customization_id")
        or "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0"
    )
    profile_id = invoice.get("ubl_profile_id") or "urn:fdc:peppol.eu:2017:poacc:billing:3.0"
    etree.SubElement(inv, f"{{{ns_map['cbc']}}}CustomizationID").text = customization_id
    etree.SubElement(inv, f"{{{ns_map['cbc']}}}ProfileID").text = profile_id
    etree.SubElement(inv, f"{{{ns_map['cbc']}}}ID").text = str(ctx["invoice"]["number"])
    etree.SubElement(inv, f"{{{ns_map['cbc']}}}IssueDate").text = invoice.get("issue_date") or str(date.today())
    due_date = ctx.get("invoice", {}).get("due_date")
    if due_date:
        etree.SubElement(inv, f"{{{ns_map['cbc']}}}DueDate").text = str(due_date)
    type_code = _resolve_type_code(invoice)
    if force_type == "credit_note" and type_code != "381":
        type_code = "381"
    doc_type = force_type or invoice.get("type")
    if not doc_type:
        doc_type = "credit_note" if type_code == "381" else "invoice"
    is_credit_note = (doc_type or "").strip().lower() == "credit_note"
    etree.SubElement(inv, f"{{{ns_map['cbc']}}}{type_code_tag}").text = type_code
    _append_document_notes(inv, ctx, ns_map)
    service_date = _text_or_none(invoice.get("service_date"))
    if service_date:
        etree.SubElement(inv, f"{{{ns_map['cbc']}}}TaxPointDate").text = service_date
    related_number = _related_invoice_number(ctx)
    if is_credit_note and related_number:
        billing_ref = etree.SubElement(inv, f"{{{ns_map['cac']}}}BillingReference")
        doc_ref = etree.SubElement(billing_ref, f"{{{ns_map['cac']}}}InvoiceDocumentReference")
        etree.SubElement(doc_ref, f"{{{ns_map['cbc']}}}ID").text = related_number
    cur = str(invoice.get("currency", "EUR"))
    etree.SubElement(inv, f"{{{ns_map['cbc']}}}DocumentCurrencyCode").text = cur
    supplier_node = _party("AccountingSupplierParty", ctx.get("supplier", {}) or {})
    inv.append(supplier_node)
    customer_node = _party("AccountingCustomerParty", ctx.get("customer", {}) or {})
    inv.append(customer_node)
    _append_delivery(inv, ctx, ns_map)
    payment_node = _payment_means(ctx.get("supplier", {}) or {}, ns_map)
    if payment_node is not None:
        inv.append(payment_node)
    payment_terms_node = _payment_terms(invoice, ns_map)
    if payment_terms_node is not None:
        inv.append(payment_terms_node)
    supplier = ctx.get("supplier", {}) or {}
    vat_groups: defaultdict[tuple[str, Decimal, str], dict[str, Decimal | str]] = defaultdict(_new_vat_group)
    lines = [line for line in (ctx.get("lines") or []) if str(line.get("line_type") or "item").lower() == "item"]
    line_elements: list[etree._Element] = []
    quantity_tag = "CreditedQuantity" if line_tag == "CreditNoteLine" else "InvoicedQuantity"
    for index, line in enumerate(lines, 1):
        qty = quantize_amount(line["quantity"])
        up = quantize_amount(line["unit_price"])
        rate = quantize_amount(line["vat_rate"])
        cat = str(line.get("vat_category", "S"))
        line_total = line.get("line_total")
        if line_total is None:
            ht = calc_line_total(qty, up)
        else:
            ht = quantize_amount(line_total)
        tax = calc_tax_amount(ht, rate)
        exemption_code = resolved_vat_exemption_code(cat, line.get("exemption_reason_code"), supplier=supplier, rate=rate)
        group = vat_groups[(cat, rate, exemption_code)]
        group["base"] = _decimal_from_group(group, "base") + ht
        group["tax"] = _decimal_from_group(group, "tax") + tax
        group["cat"] = cat
        group["rate"] = rate
        group["exemption_reason_code"] = exemption_code
        il = etree.Element(f"{{{ns_map['cac']}}}{line_tag}")
        line_elements.append(il)
        etree.SubElement(il, f"{{{ns_map['cbc']}}}ID").text = str(index)
        etree.SubElement(
            il,
            f"{{{ns_map['cbc']}}}{quantity_tag}",
            unitCode=normalize_unit_code(line.get("unit_code", "C62")),
        ).text = _fmt_amount(qty)
        etree.SubElement(il, f"{{{ns_map['cbc']}}}LineExtensionAmount", currencyID=cur).text = _fmt_amount(ht)
        item = etree.SubElement(il, f"{{{ns_map['cac']}}}Item")
        etree.SubElement(item, f"{{{ns_map['cbc']}}}Name").text = str(line["product_name"])
        if line.get("item_id"):
            sellers_item = etree.SubElement(item, f"{{{ns_map['cac']}}}SellersItemIdentification")
            etree.SubElement(sellers_item, f"{{{ns_map['cbc']}}}ID").text = str(line["item_id"])
        taxcat = etree.SubElement(item, f"{{{ns_map['cac']}}}ClassifiedTaxCategory")
        etree.SubElement(taxcat, f"{{{ns_map['cbc']}}}ID").text = cat
        if cat not in ("AE", "Z"):
            etree.SubElement(taxcat, f"{{{ns_map['cbc']}}}Percent").text = _fmt_amount(rate)
        etree.SubElement(
            etree.SubElement(taxcat, f"{{{ns_map['cac']}}}TaxScheme"),
            f"{{{ns_map['cbc']}}}ID",
        ).text = "VAT"
        price = etree.SubElement(il, f"{{{ns_map['cac']}}}Price")
        etree.SubElement(price, f"{{{ns_map['cbc']}}}PriceAmount", currencyID=cur).text = _fmt_amount(up)
    for allowance in ctx.get("allowances", []) or []:
        try:
            amount = quantize_amount(allowance.get("amount_ht") or 0)
            rate = quantize_amount(allowance.get("vat_rate") or 0)
        except Exception:
            continue
        if amount <= 0:
            continue
        cat = str(allowance.get("vat_category", "S") or "S")
        exemption_code = resolved_vat_exemption_code(
            cat,
            allowance.get("exemption_reason_code"),
            supplier=supplier,
            rate=rate,
        )
        group = vat_groups[(cat, rate, exemption_code)]
        group["base"] = _decimal_from_group(group, "base") - amount
        group["tax"] = _decimal_from_group(group, "tax") - calc_tax_amount(amount, rate)
        group["cat"] = cat
        group["rate"] = rate
        group["exemption_reason_code"] = exemption_code
        ac = etree.SubElement(inv, f"{{{ns_map['cac']}}}AllowanceCharge")
        etree.SubElement(ac, f"{{{ns_map['cbc']}}}ChargeIndicator").text = "false"
        reason = str(allowance.get("label") or allowance.get("reason") or "Remise").strip()
        etree.SubElement(ac, f"{{{ns_map['cbc']}}}AllowanceChargeReason").text = reason or "Remise"
        etree.SubElement(ac, f"{{{ns_map['cbc']}}}Amount", currencyID=cur).text = _fmt_amount(amount)
        taxcat = etree.SubElement(ac, f"{{{ns_map['cac']}}}TaxCategory")
        etree.SubElement(taxcat, f"{{{ns_map['cbc']}}}ID").text = cat
        if cat not in ("AE", "Z"):
            etree.SubElement(taxcat, f"{{{ns_map['cbc']}}}Percent").text = _fmt_amount(rate)
        etree.SubElement(
            etree.SubElement(taxcat, f"{{{ns_map['cac']}}}TaxScheme"),
            f"{{{ns_map['cbc']}}}ID",
        ).text = "VAT"
    totals = ctx["totals"]
    total_vat = quantize_amount(totals["vat"])
    total_ht = quantize_amount(totals["ht"])
    total_ttc = quantize_amount(totals["ttc"])
    allowance_total = quantize_amount(totals.get("allowance") or 0)
    prepaid_total = quantize_amount(totals.get("prepaid") or 0)
    due_total = quantize_amount((invoice or {}).get("balance_due", total_ttc - prepaid_total))
    if due_total < 0 and not is_credit_note:
        due_total = Decimal("0.00")
    gross_line_total = total_ht + allowance_total
    taxtotal = etree.SubElement(inv, f"{{{ns_map['cac']}}}TaxTotal")
    etree.SubElement(taxtotal, f"{{{ns_map['cbc']}}}TaxAmount", currencyID=cur).text = _fmt_amount(total_vat)
    for group in vat_groups.values():
        cat = str(group.get("cat") or "S")
        rate = _decimal_from_group(group, "rate")
        exemption_code = str(group.get("exemption_reason_code") or "")
        ts = etree.SubElement(taxtotal, f"{{{ns_map['cac']}}}TaxSubtotal")
        etree.SubElement(ts, f"{{{ns_map['cbc']}}}TaxableAmount", currencyID=cur).text = _fmt_amount(
            _decimal_from_group(group, "base")
        )
        etree.SubElement(ts, f"{{{ns_map['cbc']}}}TaxAmount", currencyID=cur).text = _fmt_amount(
            _decimal_from_group(group, "tax")
        )
        catnode = etree.SubElement(ts, f"{{{ns_map['cac']}}}TaxCategory")
        etree.SubElement(catnode, f"{{{ns_map['cbc']}}}ID").text = cat
        if cat not in ("AE", "Z"):
            etree.SubElement(catnode, f"{{{ns_map['cbc']}}}Percent").text = _fmt_amount(rate)
        _append_tax_exemption(
            catnode,
            cat=cat,
            rate=rate,
            exemption_code=exemption_code,
            supplier=supplier,
            ns_map=ns_map,
        )
        etree.SubElement(
            etree.SubElement(catnode, f"{{{ns_map['cac']}}}TaxScheme"),
            f"{{{ns_map['cbc']}}}ID",
        ).text = "VAT"
    lmt = etree.SubElement(inv, f"{{{ns_map['cac']}}}LegalMonetaryTotal")
    etree.SubElement(lmt, f"{{{ns_map['cbc']}}}LineExtensionAmount", currencyID=cur).text = _fmt_amount(gross_line_total)
    etree.SubElement(lmt, f"{{{ns_map['cbc']}}}TaxExclusiveAmount", currencyID=cur).text = _fmt_amount(total_ht)
    etree.SubElement(lmt, f"{{{ns_map['cbc']}}}TaxInclusiveAmount", currencyID=cur).text = _fmt_amount(total_ttc)
    if allowance_total > 0:
        etree.SubElement(lmt, f"{{{ns_map['cbc']}}}AllowanceTotalAmount", currencyID=cur).text = _fmt_amount(
            allowance_total
        )
    if prepaid_total > 0:
        etree.SubElement(lmt, f"{{{ns_map['cbc']}}}PrepaidAmount", currencyID=cur).text = _fmt_amount(prepaid_total)
    etree.SubElement(lmt, f"{{{ns_map['cbc']}}}PayableAmount", currencyID=cur).text = _fmt_amount(due_total)
    for line_element in line_elements:
        inv.append(line_element)
    return etree.tostring(inv, xml_declaration=True, encoding="UTF-8", pretty_print=True)


def _payment_means(supplier: dict[str, Any], ns_map: dict[str | None, str]) -> etree._Element | None:
    iban = str(supplier.get("iban") or "").replace(" ", "").strip()
    bic = str(supplier.get("bic") or "").replace(" ", "").strip()
    if not iban and not bic:
        return None
    node = etree.Element(f"{{{ns_map['cac']}}}PaymentMeans")
    etree.SubElement(node, f"{{{ns_map['cbc']}}}PaymentMeansCode").text = "30"
    account = etree.SubElement(node, f"{{{ns_map['cac']}}}PayeeFinancialAccount")
    if iban:
        etree.SubElement(account, f"{{{ns_map['cbc']}}}ID").text = iban
    if bic:
        branch = etree.SubElement(account, f"{{{ns_map['cac']}}}FinancialInstitutionBranch")
        etree.SubElement(branch, f"{{{ns_map['cbc']}}}ID").text = bic
    return node


def _party(role: str, p: dict[str, Any]) -> etree._Element:
    node = etree.Element(f"{{{NS['cac']}}}{role}")
    party = etree.SubElement(node, f"{{{NS['cac']}}}Party")
    id_value, scheme_id = _party_identification(p or {})
    if id_value and scheme_id:
        etree.SubElement(party, f"{{{NS['cbc']}}}EndpointID", schemeID=scheme_id).text = id_value
        pid = etree.SubElement(party, f"{{{NS['cac']}}}PartyIdentification")
        etree.SubElement(pid, f"{{{NS['cbc']}}}ID", schemeID=scheme_id).text = id_value
    name = p.get("name") or ""
    etree.SubElement(
        etree.SubElement(party, f"{{{NS['cac']}}}PartyName"),
        f"{{{NS['cbc']}}}Name",
    ).text = name
    if name:
        legal = etree.SubElement(party, f"{{{NS['cac']}}}PartyLegalEntity")
        etree.SubElement(legal, f"{{{NS['cbc']}}}RegistrationName").text = name
    addr = etree.SubElement(party, f"{{{NS['cac']}}}PostalAddress")
    address_lines = str(p.get("address") or "").splitlines()
    street = p.get("street") or (address_lines[0].strip() if address_lines else None)
    city = p.get("city")
    postal = p.get("postal_code") or p.get("postal")
    country = (p.get("country_code") or p.get("country") or "").strip().upper() or None
    if street:
        etree.SubElement(addr, f"{{{NS['cbc']}}}StreetName").text = str(street)
    if city:
        etree.SubElement(addr, f"{{{NS['cbc']}}}CityName").text = str(city)
    if postal:
        etree.SubElement(addr, f"{{{NS['cbc']}}}PostalZone").text = str(postal)
    if country:
        etree.SubElement(
            etree.SubElement(addr, f"{{{NS['cac']}}}Country"),
            f"{{{NS['cbc']}}}IdentificationCode",
        ).text = str(country)
    vat_id = p.get("vat_number") or p.get("vat_id")
    if vat_id:
        tax = etree.SubElement(party, f"{{{NS['cac']}}}PartyTaxScheme")
        etree.SubElement(tax, f"{{{NS['cbc']}}}CompanyID").text = str(vat_id)
        etree.SubElement(
            etree.SubElement(tax, f"{{{NS['cac']}}}TaxScheme"),
            f"{{{NS['cbc']}}}ID",
        ).text = "VAT"
    elif role == "AccountingSupplierParty" and id_value and (
        is_vat_franchise_regime(p.get("vat_regime")) or str(p.get("vat_exemption_notice") or "").strip()
    ):
        tax = etree.SubElement(party, f"{{{NS['cac']}}}PartyTaxScheme")
        etree.SubElement(tax, f"{{{NS['cbc']}}}CompanyID").text = id_value
        etree.SubElement(
            etree.SubElement(tax, f"{{{NS['cac']}}}TaxScheme"),
            f"{{{NS['cbc']}}}ID",
        ).text = "FC"
    return node
