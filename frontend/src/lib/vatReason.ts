type VatReasonLine = {
  line_type?: string | null;
  vat_rate?: number | string | null;
  vat_category?: string | null;
  exemption_reason_code?: string | null;
};

type VatReasonSupplier = {
  vat_regime?: string | null;
  vat_exemption_notice?: string | null;
  vat_number?: string | null;
  vat_on_debits?: boolean | null;
};

const VAT_ZERO_REASON_LABELS_FR: Record<string, string> = {
  "VATEX-FR-FRANCHISE": "TVA non applicable, art. 293 B du CGI",
  "VATEX-FR-CGI261-1": "Exonération de TVA",
  "VATEX-FR-CGI261-2": "Exonération de TVA",
  "VATEX-FR-CGI261-3": "Exonération de TVA",
  "VATEX-FR-CGI261-4": "Exonération de TVA",
  "VATEX-FR-CGI261-5": "Exonération de TVA",
  "VATEX-FR-CGI261-7": "Exonération de TVA",
  "VATEX-FR-CGI261-8": "Exonération de TVA",
  "VATEX-FR-EXO": "Exonération de TVA",
  "VATEX-FR-EXPORT": "Exonération de TVA, exportation",
  "VATEX-EU-G": "Exonération de TVA, exportation",
  "VATEX-EU-IC": "Exonération TVA, livraison intracommunautaire",
  "VATEX-FR-AE": "Autoliquidation",
  "VATEX-EU-AE": "Autoliquidation",
  AE: "Autoliquidation",
};

function withFinalPeriod(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function normalizeVatCode(value: unknown) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

export function isVatFranchiseRegime(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return [
    "franchise",
    "franchise_base",
    "franchise_en_base",
    "micro",
    "micro_entreprise",
    "microentreprise",
    "auto_entrepreneur",
    "autoentrepreneur",
  ].includes(normalized);
}

function supplierVatExemptionNotice(supplier?: VatReasonSupplier | null) {
  const vatNumber = String(supplier?.vat_number || "").trim();
  const exemptionNotice = String(supplier?.vat_exemption_notice || "").trim();
  if (isVatFranchiseRegime(supplier?.vat_regime) || (exemptionNotice && !vatNumber)) {
    return withFinalPeriod(exemptionNotice || VAT_ZERO_REASON_LABELS_FR["VATEX-FR-FRANCHISE"]);
  }
  return "";
}

export function vatLineReasonLabel(line?: VatReasonLine | null, supplier?: VatReasonSupplier | null) {
  if (String(line?.line_type || "item") !== "item") return "";
  const rate = Number(line?.vat_rate || 0);
  const category = normalizeVatCode(line?.vat_category) || "S";
  const code = normalizeVatCode(line?.exemption_reason_code);
  if (rate !== 0 && category === "S" && !code) return "";

  const supplierNotice = supplierVatExemptionNotice(supplier);
  if (supplierNotice && rate === 0) return supplierNotice.replace(/[.!?]+$/, "");

  if (code && VAT_ZERO_REASON_LABELS_FR[code]) return VAT_ZERO_REASON_LABELS_FR[code];
  if (code && /293\s*B/.test(code)) return VAT_ZERO_REASON_LABELS_FR["VATEX-FR-FRANCHISE"];
  if (code && /(AUTOLIQ|REVERSE)/.test(code)) return VAT_ZERO_REASON_LABELS_FR.AE;
  if (code) {
    if (category === "AE") return VAT_ZERO_REASON_LABELS_FR.AE;
    if (category === "O") return `TVA non applicable - ${code}`;
    if (category === "Z") return `TVA à taux zéro - ${code}`;
    return `Exonération de TVA - ${code}`;
  }
  if (category === "AE") return VAT_ZERO_REASON_LABELS_FR.AE;
  if (category === "O") return "TVA non applicable - opération hors champ";
  if (category === "Z") return "TVA à taux zéro";
  if (category === "E") return "Exonération de TVA";
  if (rate === 0) return "Motif TVA 0 à préciser";
  return "";
}

export function documentVatLegalLabel(lines: VatReasonLine[] = [], supplier?: VatReasonSupplier | null) {
  const itemLines = lines.filter((line) => String(line?.line_type || "item") === "item");
  const hasStandardTaxableLine = itemLines.some(
    (line) => (normalizeVatCode(line?.vat_category) || "S") === "S" && Number(line?.vat_rate || 0) !== 0,
  );
  const supplierNotice = supplierVatExemptionNotice(supplier);
  if (supplierNotice && !hasStandardTaxableLine) return supplierNotice;

  const labels: string[] = [];
  itemLines.forEach((line) => {
    const label = vatLineReasonLabel(line, null);
    if (label && !labels.includes(label)) labels.push(label);
  });
  if (labels.length) return withFinalPeriod(labels.join(", "));
  return supplier?.vat_on_debits ? "TVA acquittée d'après les débits" : "";
}
