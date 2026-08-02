from decimal import Decimal, InvalidOperation
import re
from typing import Any, cast

from lxml import etree

from app.config import facturx_profile_forced, settings
from app.services.document_pdf_context import (
    document_has_special_vat_context,
    resolved_vat_exemption_code,
    vat_zero_reason_label,
)
from app.utils.unit_codes import normalize_unit_code

NS = {
    "rsm": "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
    "ram": "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
    "qdt": "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
    "udt": "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
}

POSTAL_CITY_RE = re.compile(r"^\s*(\d{4,5})\s+(.+)$")

FACTURX_PROFILES = {
    "minimum",
    "basic",
    "en16931",
    "extended",
    "extended-ctc-fr",
}

FACTURX_GUIDELINES = {
    "minimum": "urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:minimum",
    "basic": "urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic",
    "en16931": "urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:en16931",
    "extended": "urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended",
    "extended-ctc-fr": "urn:cen.eu:en16931:2017#conformant#urn.cpro.gouv.fr:1p0:extended-ctc-fr",
}

OPERATION_NATURE_CODES = {
    "goods": "LB",
    "services": "PS",
    "mixed": "LBPS",
}


def _trade_tax_exemption_reason(
    *,
    category: str,
    rate: Decimal,
    exemption_code: str,
    supplier: dict[str, Any],
) -> str:
    if rate != 0 and category.upper() == "S":
        return ""
    return vat_zero_reason_label(category, exemption_code, supplier=supplier, rate=rate)


def _append_trade_tax_exemption_code(tax_node: etree.Element, exemption_code: str) -> None:
    if exemption_code:
        etree.SubElement(tax_node, "{%s}ExemptionReasonCode" % NS["ram"]).text = exemption_code


def normalize_facturx_profile(value: str | None) -> str:
    if value is None:
        return "en16931"
    normalized = value.strip().lower().replace(" ", "").replace("_", "-")
    if not normalized:
        return "en16931"
    if normalized not in FACTURX_PROFILES:
        return "en16931"
    return normalized


def resolve_facturx_profile(ctx: dict | None, profile: str | None) -> str:
    normalized = normalize_facturx_profile(profile)
    if profile and normalized != "en16931":
        return normalized
    if ctx is None or not ctx:
        return normalized
    context: dict[str, Any] = ctx
    supplier_raw = context.get("supplier")
    customer_raw = context.get("customer")
    supplier: dict[str, Any] = cast(dict[str, Any], supplier_raw) if isinstance(supplier_raw, dict) else {}
    customer: dict[str, Any] = cast(dict[str, Any], customer_raw) if isinstance(customer_raw, dict) else {}
    supplier_country = (supplier.get("country") or supplier.get("country_code") or "").strip().upper()
    customer_country = (customer.get("country") or customer.get("country_code") or "").strip().upper()
    client_type = (customer.get("client_type") or "business").strip().lower()
    if supplier_country == "FR" and customer_country == "FR" and client_type == "business":
        return "extended-ctc-fr"
    return normalized


def _normalize_country(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().upper()
    return cleaned or None


def _parse_address_lines(raw: str, fallback_country: str | None) -> dict[str, str | None]:
    lines = [line.strip() for line in re.split(r"[\r\n]+", raw) if line.strip()]
    line1 = lines[0] if lines else None
    line2 = None
    postal_code = None
    city = None
    country_code = None
    if len(lines) >= 2:
        match = POSTAL_CITY_RE.match(lines[1])
        if match:
            postal_code = match.group(1)
            city = match.group(2).strip()
        else:
            line2 = lines[1]
            if len(lines) >= 3:
                match = POSTAL_CITY_RE.match(lines[2])
                if match:
                    postal_code = match.group(1)
                    city = match.group(2).strip()
    if len(lines) >= 3:
        last = lines[-1].strip().upper()
        if last.isalpha() and len(last) in (2, 3):
            country_code = last
    if not country_code:
        country_code = _normalize_country(fallback_country)
    if not country_code and postal_code and re.fullmatch(r"\d{5}", postal_code):
        country_code = "FR"
    if not country_code:
        country_code = "FR"
    return {
        "line1": line1,
        "line2": line2,
        "postal_code": postal_code,
        "city": city,
        "country_code": country_code,
    }


def _resolve_address_struct(party: dict[str, Any]) -> dict[str, str | None]:
    struct_raw = party.get("address_struct")
    if isinstance(struct_raw, dict):
        line1 = (struct_raw.get("line1") or "").strip() or None
        line2 = (struct_raw.get("line2") or "").strip() or None
        postal_code = (struct_raw.get("postal_code") or "").strip() or None
        city = (struct_raw.get("city") or "").strip() or None
        country_code = _normalize_country(struct_raw.get("country_code"))
        if any([line1, line2, postal_code, city, country_code]):
            if not country_code:
                country_code = _normalize_country(party.get("country_code") or party.get("country"))
            return {
                "line1": line1,
                "line2": line2,
                "postal_code": postal_code,
                "city": city,
                "country_code": country_code,
            }
    street = (party.get("street") or "").strip() or None
    city = (party.get("city") or "").strip() or None
    postal_code = (party.get("postal_code") or "").strip() or None
    country_code = _normalize_country(party.get("country_code") or party.get("country"))
    if any([street, city, postal_code]):
        if not country_code and postal_code and re.fullmatch(r"\d{5}", postal_code):
            country_code = "FR"
        if not country_code:
            country_code = "FR"
        return {
            "line1": street,
            "line2": None,
            "postal_code": postal_code,
            "city": city,
            "country_code": country_code,
        }
    raw = (party.get("address") or "").strip()
    if raw:
        return _parse_address_lines(raw, party.get("country") or party.get("country_code"))
    return {
        "line1": None,
        "line2": None,
        "postal_code": None,
        "city": None,
        "country_code": country_code,
    }


def _add_postal_address(parent: etree.Element, address: dict[str, str | None]) -> None:
    if not any(address.values()):
        return
    addr = etree.SubElement(parent, "{%s}PostalTradeAddress" % NS["ram"])
    if address.get("postal_code"):
        etree.SubElement(addr, "{%s}PostcodeCode" % NS["ram"]).text = address["postal_code"]
    if address.get("line1"):
        etree.SubElement(addr, "{%s}LineOne" % NS["ram"]).text = address["line1"]
    if address.get("line2"):
        etree.SubElement(addr, "{%s}LineTwo" % NS["ram"]).text = address["line2"]
    if address.get("city"):
        etree.SubElement(addr, "{%s}CityName" % NS["ram"]).text = address["city"]
    if address.get("country_code"):
        etree.SubElement(addr, "{%s}CountryID" % NS["ram"]).text = address["country_code"]


def _resolve_legal_id(party: dict[str, Any], prefer_siren: bool) -> tuple[str | None, str | None]:
    raw = (party.get("legal_id") or party.get("siret") or party.get("siren") or "").strip()
    if not raw:
        return None, None
    digits = re.sub(r"\D", "", raw)
    if prefer_siren and len(digits) >= 9:
        return digits[:9], "0002"
    if len(digits) == 9:
        return digits, "0002"
    if len(digits) == 14:
        return digits, "0009"
    return raw, None


def _add_tax_registrations(parent: etree.Element, vat_number: str | None, fiscal_id: str | None) -> None:
    if vat_number:
        reg = etree.SubElement(parent, "{%s}SpecifiedTaxRegistration" % NS["ram"])
        vat_id = etree.SubElement(reg, "{%s}ID" % NS["ram"])
        vat_id.set("schemeID", "VA")
        vat_id.text = vat_number
        return
    if fiscal_id:
        reg = etree.SubElement(parent, "{%s}SpecifiedTaxRegistration" % NS["ram"])
        fiscal = etree.SubElement(reg, "{%s}ID" % NS["ram"])
        fiscal.set("schemeID", "FC")
        fiscal.text = fiscal_id


def _guideline_id(ctx: dict) -> str:
    override = (ctx.get("facturx_profile") or "").strip()
    if override:
        profile = normalize_facturx_profile(override)
    elif facturx_profile_forced():
        profile = normalize_facturx_profile(settings.FACTURX_PROFILE)
    else:
        profile = resolve_facturx_profile(ctx, settings.FACTURX_PROFILE)
    return FACTURX_GUIDELINES.get(profile, FACTURX_GUIDELINES["en16931"])


def cii_invoice_xml(ctx: dict, include_business_process: bool = True) -> bytes:
    r = etree.Element("{%s}CrossIndustryInvoice" % NS["rsm"], nsmap=NS)

    # -------- Contexte Factur-X / EN16931 ----------
    ctx_node = etree.SubElement(r, "{%s}ExchangedDocumentContext" % NS["rsm"])
    guideline = etree.SubElement(ctx_node, "{%s}GuidelineSpecifiedDocumentContextParameter" % NS["ram"])
    etree.SubElement(guideline, "{%s}ID" % NS["ram"]).text = _guideline_id(ctx)
    operation_nature = (ctx.get("invoice") or {}).get("operation_nature")
    operation_code = OPERATION_NATURE_CODES.get((operation_nature or "").strip().lower())
    if include_business_process and operation_code:
        business_process = etree.SubElement(
            ctx_node,
            "{%s}BusinessProcessSpecifiedDocumentContextParameter" % NS["ram"],
        )
        etree.SubElement(business_process, "{%s}ID" % NS["ram"]).text = operation_code

    # -------- En-tête de facture ----------
    ex = etree.SubElement(r, "{%s}ExchangedDocument" % NS["rsm"])
    etree.SubElement(ex, "{%s}ID" % NS["ram"]).text = ctx["invoice"]["number"]
    invoice_type = ctx.get("invoice", {}).get("type") if isinstance(ctx.get("invoice"), dict) else None
    type_code = "381" if (invoice_type or "").lower() == "credit_note" else "380"
    etree.SubElement(ex, "{%s}TypeCode" % NS["ram"]).text = type_code

    # Date d'émission (format 102 = YYYYMMDD)
    issue_dt = etree.SubElement(ex, "{%s}IssueDateTime" % NS["ram"])
    dt_str = etree.SubElement(
        issue_dt,
        "{%s}DateTimeString" % NS["udt"],
        format="102",
    )
    dt_str.text = ctx["invoice"]["issue_date"].replace("-", "")
    notes: list[str] = []
    if operation_nature:
        notes.append(f"Nature de l'opération : {operation_nature}")
    if (ctx.get("supplier") or {}).get("vat_on_debits") and not document_has_special_vat_context(
        ctx.get("supplier") or {},
        ctx.get("lines") or [],
    ):
        notes.append("Option pour le paiement de la taxe d'après les débits")
    for note_text in notes:
        note = etree.SubElement(ex, "{%s}IncludedNote" % NS["ram"])
        etree.SubElement(note, "{%s}Content" % NS["ram"]).text = note_text

    # -------- Transaction commerciale ----------
    trx = etree.SubElement(r, "{%s}SupplyChainTradeTransaction" % NS["rsm"])

    currency = ctx["invoice"].get("currency", "EUR")
    supplier = ctx.get("supplier") or {}

    # 1) LIGNES EN PREMIER
    for i, L in enumerate([line for line in ctx["lines"] if str(line.get("line_type") or "item").lower() == "item"], 1):
        li = etree.SubElement(trx, "{%s}IncludedSupplyChainTradeLineItem" % NS["ram"])

        # (1) Numéro de ligne
        doc_line = etree.SubElement(li, "{%s}AssociatedDocumentLineDocument" % NS["ram"])
        etree.SubElement(doc_line, "{%s}LineID" % NS["ram"]).text = str(i)

        # (2) Produit / service
        prod = etree.SubElement(li, "{%s}SpecifiedTradeProduct" % NS["ram"])
        etree.SubElement(prod, "{%s}Name" % NS["ram"]).text = L["product_name"]

        # (3) Accord de ligne : prix unitaire (NetPrice uniquement)
        agr_line = etree.SubElement(li, "{%s}SpecifiedLineTradeAgreement" % NS["ram"])
        net_price = etree.SubElement(agr_line, "{%s}NetPriceProductTradePrice" % NS["ram"])
        etree.SubElement(
            net_price,
            "{%s}ChargeAmount" % NS["ram"],
        ).text = f"{L['unit_price']:.2f}"

        # (4) Livraison de ligne : quantité
        delivery = etree.SubElement(li, "{%s}SpecifiedLineTradeDelivery" % NS["ram"])
        etree.SubElement(
            delivery,
            "{%s}BilledQuantity" % NS["ram"],
            unitCode=normalize_unit_code(L.get("unit_code", "C62")),
        ).text = f"{L['quantity']:.2f}"

        # (5) Règlement de ligne : TVA + total ligne
        stl_line = etree.SubElement(li, "{%s}SpecifiedLineTradeSettlement" % NS["ram"])

        tax = etree.SubElement(stl_line, "{%s}ApplicableTradeTax" % NS["ram"])
        etree.SubElement(tax, "{%s}TypeCode" % NS["ram"]).text = "VAT"
        rate = Decimal(str(L.get("vat_rate", 0)))
        category = str(L.get("vat_category", "S") or "S")
        exemption_code = resolved_vat_exemption_code(
            category,
            L.get("exemption_reason_code"),
            supplier=supplier,
            rate=rate,
        )
        exemption_reason = _trade_tax_exemption_reason(
            category=category,
            rate=rate,
            exemption_code=exemption_code,
            supplier=supplier,
        )
        if exemption_reason:
            etree.SubElement(tax, "{%s}ExemptionReason" % NS["ram"]).text = exemption_reason
        etree.SubElement(tax, "{%s}CategoryCode" % NS["ram"]).text = category
        _append_trade_tax_exemption_code(tax, exemption_code)
        etree.SubElement(tax, "{%s}RateApplicablePercent" % NS["ram"]).text = f"{float(rate):.2f}"

        line_sum = etree.SubElement(
            stl_line,
            "{%s}SpecifiedTradeSettlementLineMonetarySummation" % NS["ram"],
        )
        line_total = float(L.get("quantity", 0.0)) * float(L.get("unit_price", 0.0))
        etree.SubElement(
            line_sum,
            "{%s}LineTotalAmount" % NS["ram"],
        ).text = f"{line_total:.2f}"

    # 2) Accord d'en-tête : vendeur / client
    agr = etree.SubElement(trx, "{%s}ApplicableHeaderTradeAgreement" % NS["ram"])

    buyer_reference = (ctx.get("invoice") or {}).get("public_service_code")
    if buyer_reference:
        etree.SubElement(agr, "{%s}BuyerReference" % NS["ram"]).text = str(buyer_reference)

    # ------- Vendeur -------
    seller = etree.SubElement(agr, "{%s}SellerTradeParty" % NS["ram"])
    etree.SubElement(seller, "{%s}Name" % NS["ram"]).text = ctx["supplier"].get("name", "")
    seller_org = etree.SubElement(seller, "{%s}SpecifiedLegalOrganization" % NS["ram"])
    seller_id_value, seller_scheme = _resolve_legal_id(ctx["supplier"], prefer_siren=False)
    seller_id = etree.SubElement(seller_org, "{%s}ID" % NS["ram"])
    if seller_scheme:
        seller_id.set("schemeID", seller_scheme)
    if seller_id_value:
        seller_id.text = seller_id_value
    seller_address = _resolve_address_struct(ctx["supplier"])
    _add_postal_address(seller, seller_address)
    _add_tax_registrations(seller, ctx["supplier"].get("vat_number"), seller_id_value)

    # ------- Débiteur -------
    buyer = etree.SubElement(agr, "{%s}BuyerTradeParty" % NS["ram"])
    etree.SubElement(buyer, "{%s}Name" % NS["ram"]).text = ctx["customer"]["name"]
    buyer_org = etree.SubElement(buyer, "{%s}SpecifiedLegalOrganization" % NS["ram"])
    supplier_country = _normalize_country(ctx["supplier"].get("country") or ctx["supplier"].get("country_code"))
    customer_country = _normalize_country(ctx["customer"].get("country") or ctx["customer"].get("country_code"))
    customer_type = str(ctx["customer"].get("client_type") or "").strip().lower()
    prefer_siren = (
        supplier_country == "FR"
        and customer_country == "FR"
        and customer_type not in {"public", "public_sector", "government", "administration", "b2g"}
    )
    buyer_id_value, buyer_scheme = _resolve_legal_id(ctx["customer"], prefer_siren=prefer_siren)
    buyer_id = etree.SubElement(buyer_org, "{%s}ID" % NS["ram"])
    if buyer_scheme:
        buyer_id.set("schemeID", buyer_scheme)
    if buyer_id_value:
        buyer_id.text = buyer_id_value
    buyer_address = _resolve_address_struct(ctx["customer"])
    _add_postal_address(buyer, buyer_address)
    _add_tax_registrations(buyer, ctx["customer"].get("vat_number"), None)

    purchase_order_number = ctx.get("invoice", {}).get("purchase_order_number")
    if purchase_order_number:
        po_ref = etree.SubElement(agr, "{%s}BuyerOrderReferencedDocument" % NS["ram"])
        etree.SubElement(po_ref, "{%s}IssuerAssignedID" % NS["ram"]).text = purchase_order_number

    # 2.5) Livraison d'en-tête (obligatoire dans la séquence, même vide)
    delivery = etree.SubElement(trx, "{%s}ApplicableHeaderTradeDelivery" % NS["ram"])
    delivery_address = (ctx.get("invoice") or {}).get("delivery_address")
    if delivery_address:
        ship_to = etree.SubElement(delivery, "{%s}ShipToTradeParty" % NS["ram"])
        ship_address = _parse_address_lines(
            str(delivery_address),
            ctx.get("customer", {}).get("country") or ctx.get("customer", {}).get("country_code"),
        )
        _add_postal_address(ship_to, ship_address)

    # 3) Règlement d'en-tête : devise + paiement + TVA + totaux
    stl = etree.SubElement(trx, "{%s}ApplicableHeaderTradeSettlement" % NS["ram"])

    # Devise
    cur = etree.SubElement(stl, "{%s}InvoiceCurrencyCode" % NS["ram"])
    cur.text = currency

    # 3.a) Mode de paiement (TypeCode obligatoire pour Chorus)
    pm = etree.SubElement(stl, "{%s}SpecifiedTradeSettlementPaymentMeans" % NS["ram"])
    # 42 = virement SEPA
    etree.SubElement(pm, "{%s}TypeCode" % NS["ram"]).text = "42"
    iban = (ctx.get("supplier") or {}).get("iban")
    if iban:
        account = etree.SubElement(pm, "{%s}PayeePartyCreditorFinancialAccount" % NS["ram"])
        etree.SubElement(account, "{%s}IBANID" % NS["ram"]).text = str(iban)
    bic = (ctx.get("supplier") or {}).get("bic")
    if bic:
        institution = etree.SubElement(pm, "{%s}PayeeSpecifiedCreditorFinancialInstitution" % NS["ram"])
        etree.SubElement(institution, "{%s}BICID" % NS["ram"]).text = str(bic)

    # 3.b) TVA d'en-tête (dans l'ordre attendu par le XSD)
    vat_groups: dict[tuple[str, Decimal, str | None], dict[str, Decimal]] = {}
    for line in [line for line in ctx.get("lines", []) if str(line.get("line_type") or "item").lower() == "item"]:
        try:
            quantity = Decimal(str(line.get("quantity", 0)))
            unit_price = Decimal(str(line.get("unit_price", 0)))
            rate = Decimal(str(line.get("vat_rate", 0)))
        except (InvalidOperation, TypeError, ValueError):
            continue
        base = quantity * unit_price
        category = str(line.get("vat_category", "S") or "S")
        header_exemption_code = (
            resolved_vat_exemption_code(category, line.get("exemption_reason_code"), supplier=supplier, rate=rate)
            or None
        )
        key = (category, rate, header_exemption_code)
        entry = vat_groups.setdefault(
            key,
            {
                "base": Decimal("0"),
                "tax": Decimal("0"),
            },
        )
        entry["base"] += base
        entry["tax"] += (base * rate) / Decimal("100")
    for allowance in ctx.get("allowances", []) or []:
        try:
            amount = Decimal(str(allowance.get("amount_ht", 0)))
            rate = Decimal(str(allowance.get("vat_rate", 0)))
        except (InvalidOperation, TypeError, ValueError):
            continue
        if amount <= 0:
            continue
        category = str(allowance.get("vat_category", "S") or "S")
        header_exemption_code = (
            resolved_vat_exemption_code(
                category,
                allowance.get("exemption_reason_code"),
                supplier=supplier,
                rate=rate,
            )
            or None
        )
        key = (category, rate, header_exemption_code)
        entry = vat_groups.setdefault(
            key,
            {
                "base": Decimal("0"),
                "tax": Decimal("0"),
            },
        )
        entry["base"] -= amount
        entry["tax"] -= (amount * rate) / Decimal("100")

    if vat_groups:
        for (category, rate, header_exemption_code), amounts in sorted(
            vat_groups.items(),
            key=lambda item: (item[0][0], item[0][1], item[0][2] or ""),
        ):
            tax_header = etree.SubElement(stl, "{%s}ApplicableTradeTax" % NS["ram"])
            etree.SubElement(
                tax_header,
                "{%s}CalculatedAmount" % NS["ram"],
            ).text = format(amounts["tax"], ".2f")
            etree.SubElement(tax_header, "{%s}TypeCode" % NS["ram"]).text = "VAT"
            exemption_reason = _trade_tax_exemption_reason(
                category=category,
                rate=rate,
                exemption_code=str(header_exemption_code or ""),
                supplier=supplier,
            )
            if exemption_reason:
                etree.SubElement(tax_header, "{%s}ExemptionReason" % NS["ram"]).text = exemption_reason
            etree.SubElement(
                tax_header,
                "{%s}BasisAmount" % NS["ram"],
            ).text = format(amounts["base"], ".2f")
            etree.SubElement(tax_header, "{%s}CategoryCode" % NS["ram"]).text = category
            _append_trade_tax_exemption_code(tax_header, str(header_exemption_code or ""))
            etree.SubElement(tax_header, "{%s}RateApplicablePercent" % NS["ram"]).text = format(rate, ".2f")
    else:
        tax_header = etree.SubElement(stl, "{%s}ApplicableTradeTax" % NS["ram"])
        etree.SubElement(
            tax_header,
            "{%s}CalculatedAmount" % NS["ram"],
        ).text = f"{ctx['totals']['vat']:.2f}"
        etree.SubElement(tax_header, "{%s}TypeCode" % NS["ram"]).text = "VAT"
        etree.SubElement(
            tax_header,
            "{%s}BasisAmount" % NS["ram"],
        ).text = f"{ctx['totals']['ht']:.2f}"
        etree.SubElement(tax_header, "{%s}CategoryCode" % NS["ram"]).text = "S"
        item_lines = [line for line in ctx.get("lines", []) if str(line.get("line_type") or "item").lower() == "item"]
        first_line = item_lines[0] if item_lines else {}
        etree.SubElement(tax_header, "{%s}RateApplicablePercent" % NS["ram"]).text = (
            f"{float(first_line.get('vat_rate', 0.0)):.2f}"
        )

    service_date = ctx.get("invoice", {}).get("service_date")
    if service_date:
        period = etree.SubElement(stl, "{%s}BillingSpecifiedPeriod" % NS["ram"])
        start = etree.SubElement(period, "{%s}StartDateTime" % NS["ram"])
        start_str = etree.SubElement(start, "{%s}DateTimeString" % NS["udt"], format="102")
        start_str.text = str(service_date).replace("-", "")

    for allowance in ctx.get("allowances", []) or []:
        try:
            amount = Decimal(str(allowance.get("amount_ht", 0)))
            rate = Decimal(str(allowance.get("vat_rate", 0)))
        except (InvalidOperation, TypeError, ValueError):
            continue
        if amount <= 0:
            continue
        allowance_node = etree.SubElement(stl, "{%s}SpecifiedTradeAllowanceCharge" % NS["ram"])
        indicator = etree.SubElement(allowance_node, "{%s}ChargeIndicator" % NS["ram"])
        etree.SubElement(indicator, "{%s}Indicator" % NS["udt"]).text = "false"
        etree.SubElement(allowance_node, "{%s}ActualAmount" % NS["ram"]).text = format(amount, ".2f")
        reason = str(allowance.get("label") or "Remise").strip()
        etree.SubElement(allowance_node, "{%s}Reason" % NS["ram"]).text = reason or "Remise"
        allowance_tax = etree.SubElement(allowance_node, "{%s}CategoryTradeTax" % NS["ram"])
        etree.SubElement(allowance_tax, "{%s}TypeCode" % NS["ram"]).text = "VAT"
        etree.SubElement(allowance_tax, "{%s}CategoryCode" % NS["ram"]).text = str(
            allowance.get("vat_category", "S") or "S"
        )
        etree.SubElement(allowance_tax, "{%s}RateApplicablePercent" % NS["ram"]).text = format(rate, ".2f")

    payment_terms = ctx.get("invoice", {}).get("payment_terms")
    due_date = ctx.get("invoice", {}).get("due_date")
    if payment_terms or due_date:
        terms = etree.SubElement(stl, "{%s}SpecifiedTradePaymentTerms" % NS["ram"])
        if payment_terms:
            etree.SubElement(terms, "{%s}Description" % NS["ram"]).text = str(payment_terms)
        if due_date:
            due = etree.SubElement(terms, "{%s}DueDateDateTime" % NS["ram"])
            due_str = etree.SubElement(due, "{%s}DateTimeString" % NS["udt"], format="102")
            due_str.text = str(due_date).replace("-", "")

    # 3.c) Totaux
    sums = etree.SubElement(
        stl,
        "{%s}SpecifiedTradeSettlementHeaderMonetarySummation" % NS["ram"],
    )

    totals = ctx.get("totals", {})
    totals_ht = Decimal(str(totals.get("ht", 0)))
    totals_vat = Decimal(str(totals.get("vat", 0)))
    totals_ttc = Decimal(str(totals.get("ttc", 0)))
    allowance_total = Decimal(str(totals.get("allowance", 0)))
    prepaid_total = Decimal(str(totals.get("prepaid", 0)))
    due_total = Decimal(str((ctx.get("invoice") or {}).get("balance_due", totals_ttc - prepaid_total)))
    if (invoice_type or "").lower() != "credit_note" and due_total < Decimal("0"):
        due_total = Decimal("0")

    etree.SubElement(sums, "{%s}LineTotalAmount" % NS["ram"]).text = format(totals_ht + allowance_total, ".2f")

    if allowance_total > Decimal("0"):
        etree.SubElement(sums, "{%s}AllowanceTotalAmount" % NS["ram"]).text = format(allowance_total, ".2f")

    etree.SubElement(sums, "{%s}TaxBasisTotalAmount" % NS["ram"]).text = format(totals_ht, ".2f")

    etree.SubElement(sums, "{%s}TaxTotalAmount" % NS["ram"], currencyID=currency).text = format(totals_vat, ".2f")

    etree.SubElement(sums, "{%s}GrandTotalAmount" % NS["ram"]).text = format(totals_ttc, ".2f")

    etree.SubElement(sums, "{%s}TotalPrepaidAmount" % NS["ram"]).text = format(prepaid_total, ".2f")

    etree.SubElement(sums, "{%s}DuePayableAmount" % NS["ram"]).text = format(due_total, ".2f")

    related_number = (ctx.get("invoice") or {}).get("related_number")
    if related_number and (invoice_type or "").lower() == "credit_note":
        ref = etree.SubElement(stl, "{%s}InvoiceReferencedDocument" % NS["ram"])
        etree.SubElement(ref, "{%s}IssuerAssignedID" % NS["ram"]).text = str(related_number)

    return etree.tostring(r, xml_declaration=True, encoding="UTF-8", pretty_print=True)
