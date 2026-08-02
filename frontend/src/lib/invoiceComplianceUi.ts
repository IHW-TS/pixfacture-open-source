export type InvoiceComplianceUiItem = {
  key: string;
  label: string;
  href: string;
  actionLabel: string;
};

type ParsedComplianceIssue = {
  field: string;
  message: string;
};

const DOCUMENT_FIELD_PATTERN = /^(tenant|customer|invoice)(?:\.[A-Za-z0-9_:-]+)+$/i;
const LINE_FIELD_PATTERN = /^lines\[(\d+)]\.([A-Za-z0-9_.:-]+)$/i;
const PREFIXED_DOCUMENT_FIELD_PATTERN =
  /^((?:tenant|customer|invoice)(?:\.[A-Za-z0-9_:-]+)+|lines\[\d+]\.[A-Za-z0-9_.:-]+)\s*:\s*(.*)$/i;

const FIELD_LABELS: Record<string, string> = {
  "tenant.name": "Renseignez le nom de votre entreprise.",
  "tenant.address": "Complétez l’adresse de votre entreprise.",
  "tenant.address_line1": "Complétez l’adresse de votre entreprise.",
  "tenant.postal_code": "Complétez le code postal de votre entreprise.",
  "tenant.city": "Complétez la ville de votre entreprise.",
  "tenant.siren": "Renseignez le SIREN de votre entreprise.",
  "tenant.siret": "Renseignez le SIRET de votre entreprise.",
  "tenant.vat_number": "Renseignez le numéro de TVA ou la mention d’exonération de votre entreprise.",
  "tenant.vat_exemption_notice": "Renseignez la mention d’exonération de TVA de votre entreprise.",
  "tenant.late_payment_interest": "Renseignez les pénalités de retard applicables.",
  "tenant.vat_on_debits": "Vérifiez la mention relative à la TVA sur les débits.",
  "customer.name": "Renseignez le nom du client.",
  "customer.address": "Complétez l’adresse du client.",
  "customer.address_line1": "Complétez l’adresse du client.",
  "customer.postal_code": "Complétez le code postal du client.",
  "customer.city": "Complétez la ville du client.",
  "customer.siren": "Renseignez le SIREN ou le SIRET du client.",
  "customer.siret": "Renseignez le SIREN ou le SIRET du client.",
  "customer.vat_number": "Renseignez le numéro de TVA du client.",
  "invoice.number": "Vérifiez la numérotation de la facture.",
  "invoice.issue_date": "Renseignez la date d’émission.",
  "invoice.due_date": "Renseignez la date d’échéance.",
  "invoice.payment_terms": "Renseignez les conditions ou la date de paiement.",
  "invoice.operation_nature": "Choisissez la nature de l’opération : biens, services ou mixte.",
  "invoice.delivery_address": "Renseignez l’adresse de livraison lorsqu’elle diffère de l’adresse de facturation.",
  "invoice.service_date": "Renseignez la date de prestation.",
  "invoice.lines": "Ajoutez au moins une ligne facturable.",
  "invoice.lines.product_name": "Renseignez la désignation de chaque ligne.",
  "invoice.lines.quantity": "Corrigez la quantité d’au moins une ligne.",
  "invoice.lines.unit_price": "Renseignez le prix unitaire de chaque ligne.",
  "invoice.total_ex_vat": "Vérifiez le total hors taxes et le montant des lignes.",
  "invoice.total_vat": "Vérifiez le total de TVA et les taux appliqués aux lignes.",
  "invoice.total_inc_vat": "Vérifiez que le total TTC correspond au total HT augmenté de la TVA.",
};

const normalizeField = (value: unknown) => {
  if (typeof value !== "string") return "";
  const field = value.trim();
  if (DOCUMENT_FIELD_PATTERN.test(field) || LINE_FIELD_PATTERN.test(field)) return field.toLowerCase();
  return "";
};

const parseComplianceIssue = (value: unknown): ParsedComplianceIssue => {
  let field = "";
  let message = "";

  if (typeof value === "string") {
    message = value.trim();
  } else if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    field = normalizeField(item.field);
    const candidate = item.message ?? item.msg ?? item.detail;
    if (typeof candidate === "string") message = candidate.trim();
  }

  const prefixed = message.match(PREFIXED_DOCUMENT_FIELD_PATTERN);
  if (prefixed) {
    field = normalizeField(prefixed[1]) || field;
    message = prefixed[2].trim();
  } else if (!field) {
    field = normalizeField(message);
    if (field) message = "";
  }

  return { field, message };
};

const genericFieldLabel = (field: string) => {
  if (field.startsWith("tenant.")) return "Complétez les informations de votre entreprise.";
  if (field.startsWith("customer.")) return "Complétez les informations du client.";
  if (field.startsWith("invoice.") || field.startsWith("lines[")) {
    return "Complétez les informations de la facture.";
  }
  return "Une information obligatoire doit être complétée.";
};

const lineFieldLabel = (field: string) => {
  const match = field.match(LINE_FIELD_PATTERN);
  if (!match) return "";
  const line = Number(match[1]);
  const suffix = match[2].toLowerCase();
  const prefix = Number.isFinite(line) && line > 0 ? `Ligne ${line}` : "Une ligne";
  if (suffix === "exemption_reason_code") return `${prefix} : renseignez le motif d’exonération de TVA.`;
  if (suffix === "quantity") return `${prefix} : corrigez la quantité.`;
  if (suffix === "unit_code" || suffix === "unit") return `${prefix} : choisissez une unité valide.`;
  if (suffix === "unit_price") return `${prefix} : renseignez le prix unitaire.`;
  if (suffix === "product_name" || suffix === "description") return `${prefix} : renseignez la désignation.`;
  if (suffix === "vat_rate" || suffix === "vat_category") return `${prefix} : vérifiez la TVA.`;
  return `${prefix} : complétez les informations demandées.`;
};

const knownMessageLabel = (message: string) => {
  const clean = message
    .replace(/\s*\(location:\s*[^)]*\)\s*$/i, "")
    .replace(/\s*\(spec\s*2027\+?\)\s*/gi, " ")
    .replace(/\s*-\s*cat[eé]gories?\s+LB\/?PS\/?LBPS\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (/nature de l.op[eé]ration|biens\/?services\/?mixte/i.test(clean)) {
    return "Choisissez la nature de l’opération : biens, services ou mixte.";
  }
  if (/siren.*client|client.*siren/i.test(clean)) return "Renseignez le SIREN ou le SIRET du client.";
  if (/motif d.exon[eé]ration.*tva/i.test(clean))
    return "Renseignez le motif d’exonération de TVA sur la ligne concernée.";
  if (/date de prestation/i.test(clean)) return "Renseignez la date de prestation.";
  if (/montant ht manquant/i.test(clean)) return "Renseignez le total hors taxes.";
  if (/montant tva manquant/i.test(clean)) return "Renseignez le total de TVA.";
  if (/montant ttc manquant/i.test(clean)) return "Renseignez le total TTC.";
  if (/total ht (?:incoh[eé]rent|ne correspond)/i.test(clean)) {
    return "Vérifiez que le total HT correspond à la somme des lignes.";
  }
  if (/total tva (?:incoh[eé]rent|ne correspond)/i.test(clean)) {
    return "Vérifiez que le total de TVA correspond aux lignes.";
  }
  if (/total ttc|montant ttc.*(?:[eé]gal|correspond)/i.test(clean)) {
    return "Vérifiez que le total TTC correspond au total HT augmenté de la TVA.";
  }
  if (/unit code|billedquantity|br-[a-z0-9-]+|un\/?ece/i.test(clean)) {
    return "Vérifiez la quantité et l’unité des lignes de la facture.";
  }
  if (/en\s*16931|factur-?x|crossindustryinvoice|schematron|namespace|\bxml\b|\bubl\b|\bcii\b/i.test(clean)) {
    return "Vérifiez les informations de la facture avant de relancer l’action.";
  }
  if (/lignes?=|total=|\[[a-z]+]|(?:tenant|customer|invoice)\.|lines\[\d+]/i.test(clean)) {
    return "Vérifiez les informations et les montants de la facture.";
  }
  return "";
};

const fieldLabel = (field: string, message: string) => {
  const dynamicLineLabel = lineFieldLabel(field);
  if (dynamicLineLabel) return dynamicLineLabel;
  const known = FIELD_LABELS[field];
  if (known) return known;
  return knownMessageLabel(message) || genericFieldLabel(field);
};

const issueDestination = (field: string, invoiceId?: string | null, customerId?: string | null) => {
  if (field.startsWith("tenant.")) {
    return { href: "/app/company", actionLabel: "Compléter l’entreprise" };
  }
  if (field.startsWith("customer.")) {
    return {
      href: customerId ? `/app/customers/${encodeURIComponent(customerId)}` : "/app/customers",
      actionLabel: "Compléter le client",
    };
  }
  return {
    href: invoiceId ? `/app/invoices/new?edit_invoice=${encodeURIComponent(invoiceId)}` : "/app/invoices",
    actionLabel: "Modifier la facture",
  };
};

const complianceItem = (
  value: unknown,
  invoiceId?: string | null,
  customerId?: string | null,
): InvoiceComplianceUiItem => {
  const parsed = parseComplianceIssue(value);
  const destination = issueDestination(parsed.field, invoiceId, customerId);
  const label = parsed.field
    ? fieldLabel(parsed.field, parsed.message)
    : knownMessageLabel(parsed.message) || "Une information de la facture doit être corrigée.";
  const key = parsed.field || `message:${label.toLocaleLowerCase("fr-FR")}`;
  return { key, label, ...destination };
};

export function buildInvoiceComplianceUiItems(params: {
  fields?: unknown[] | null;
  errors?: unknown[] | null;
  invoiceId?: string | null;
  customerId?: string | null;
}): InvoiceComplianceUiItem[] {
  const values = [
    ...(Array.isArray(params.fields) ? params.fields : []),
    ...(Array.isArray(params.errors) ? params.errors : []),
  ];
  const byKey = new Map<string, InvoiceComplianceUiItem>();
  const visibleLabels = new Set<string>();

  for (const value of values) {
    const item = complianceItem(value, params.invoiceId, params.customerId);
    const visibleKey = `${item.label.toLocaleLowerCase("fr-FR")}|${item.href}`;
    if (byKey.has(item.key) || visibleLabels.has(visibleKey)) continue;
    byKey.set(item.key, item);
    visibleLabels.add(visibleKey);
  }

  return Array.from(byKey.values());
}

export function sanitizeStructuredInvoiceErrorDetail(value: unknown): string | null {
  const parsed = parseComplianceIssue(value);
  if (parsed.field) return fieldLabel(parsed.field, parsed.message);
  return knownMessageLabel(parsed.message) || null;
}
