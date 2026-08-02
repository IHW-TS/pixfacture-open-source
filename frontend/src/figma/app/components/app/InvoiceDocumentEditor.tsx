"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { Link } from "@/figma/react-router-compat";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { motion } from "motion/react";
import { api, apiUpload, formatApiError, rawApi } from "@/lib/api";
import { waitForMaybeJob } from "@/lib/jobs";
import { getLegalConfig } from "@/lib/legalConfig";
import { useSession } from "@/lib/useSession";
import { isTrialSubscription, TRIAL_LIVE_ACTION_MESSAGE } from "@/lib/trialMode";
import {
  PAYMENT_PRESETS,
  addDays,
  applyPaymentPreset,
  companyLegalMentionsDefaults,
  formatIbanInput,
  formatPhoneDisplay,
  formatSirenInput,
  formatSiretInput,
  formatVatNumberInput,
  inferPaymentPreset,
  isValidBic,
  isValidFrenchVatNumber,
  isValidIban,
  normalizeIban,
} from "@/lib/businessRules";
import { Card, DisclosureCard, PrimaryButton, PrimaryLinkButton, StatusPill } from "./AppPageHeader";
import { LoadingCard, NoticeBanner } from "./Feedback";
import { GuidanceTooltip } from "./GuidanceTooltip";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Calendar,
  Archive,
  ChevronDown,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  CreditCard,
  FileText,
  Hash,
  GripVertical,
  Info,
  Eye,
  EyeOff,
  LayoutTemplate,
  LockKeyhole,
  Mail,
  MapPin,
  Phone,
  Pencil,
  Plus,
  Package2,
  ReceiptText,
  Save,
  Search,
  Send,
  Settings2,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react";

const FACTURX_PROFILES = [
  { value: "minimum", label: "Minimum" },
  { value: "basic", label: "Basic" },
  { value: "en16931", label: "EN16931 (recommandé)" },
  { value: "extended", label: "Extended" },
  { value: "extended-ctc-fr", label: "Extended CTC FR" },
];

const VAT_CATEGORY_OPTIONS = [
  { value: "S", label: "Standard" },
  { value: "Z", label: "Taux zéro" },
  { value: "AE", label: "Autoliquidation" },
  { value: "O", label: "Hors champ" },
  { value: "E", label: "Exonéré" },
];

const UNIT_CODE_SUGGESTIONS = [
  "C62",
  "H87",
  "HUR",
  "DAY",
  "MON",
  "ANN",
  "E48",
  "KGM",
  "GRM",
  "TNE",
  "LTR",
  "MLT",
  "MTR",
  "MTK",
  "MTQ",
  "SET",
];

const SALES_ACCOUNT_OPTIONS = [
  { value: "701", label: "701 - Produits finis" },
  { value: "704", label: "704 - Travaux" },
  { value: "705", label: "705 - Études" },
  { value: "706", label: "706 - Services" },
  { value: "707", label: "707 - Marchandises" },
  { value: "708", label: "708 - Activités annexes" },
  { value: "7085", label: "7085 - Ports/frais" },
  { value: "471", label: "Je ne sais pas / demander au comptable · 471" },
];

const CURRENT_DRAFT_VERSION = 2;
const STORAGE_PREFIX = "teoman-document-editor-v2";
const RECENT_PREFIX = "teoman-document-editor-recent-lines";
const RECENT_CUSTOMERS_PREFIX = "teoman-document-editor-recent-customers";
const NO_INVOICE_DEPOSIT_DEFAULT_PERCENT = "10";
const ADVANCE_VAT_RATE_OPTIONS = [
  { value: "20", label: "20 %" },
  { value: "10", label: "10 %" },
  { value: "5.5", label: "5,5 %" },
  { value: "2.1", label: "2,1 %" },
  { value: "0", label: "0 %" },
];
const DEFAULT_GLOBAL_VAT_DRAFT = {
  vat_rate: "20",
  vat_category: "S",
  exemption_reason_code: "",
  unit_code: "C62",
};
const VAT_FRANCHISE_REASON_CODE = "VATEX-FR-FRANCHISE";
const VAT_FRANCHISE_GLOBAL_DRAFT = {
  vat_rate: "0",
  vat_category: "E",
  exemption_reason_code: VAT_FRANCHISE_REASON_CODE,
  unit_code: "C62",
};

function isBusinessClientType(value: any) {
  const type = String(value || "business")
    .trim()
    .toLowerCase();
  return !["individual", "particulier", "consumer", "b2c", "private"].includes(type);
}
const CUSTOM_PAYMENT_PRESET_ID = "manual";
const DEFAULT_PAYMENT_METHOD_IDS = ["bank_transfer", "cheque", "card"];
const PAYMENT_METHOD_OPTIONS = [
  { id: "card", label: "Carte bancaire", phrase: "carte bancaire" },
  { id: "bank_transfer", label: "Virement bancaire", phrase: "virement bancaire" },
  { id: "cheque", label: "Chèque", phrase: "chèque" },
  { id: "cash", label: "Espèce", phrase: "espèce" },
  { id: "direct_debit", label: "Prélèvement bancaire", phrase: "prélèvement bancaire" },
  { id: "cesu", label: "CESU", phrase: "CESU" },
  { id: "urssaf_aici", label: "Prélèvement Urssaf (AICI)", phrase: "prélèvement Urssaf" },
  { id: "payment_app", label: "Application de paiement", phrase: "application de paiement" },
] as const;
const PAYMENT_METHOD_MENU_OPTIONS = PAYMENT_METHOD_OPTIONS.slice(0, 5);
const PAYMENT_METHOD_COMPACT_LABELS: Record<string, string> = {
  cash: "Espèces",
};
const PAYMENT_METHOD_PHRASE_ORDER = [
  "bank_transfer",
  "cheque",
  "card",
  "direct_debit",
  "cash",
  "cesu",
  "urssaf_aici",
  "payment_app",
];
type SideOptionId = "document" | "models" | "vat" | "discount" | "deposit";
type SideOptionItem = { id: SideOptionId; label: string; icon: typeof LayoutTemplate; help: string };
const DOCUMENT_THEME = {
  invoice: {
    accentColor: "#1d4ed8",
    accentStrong: "#1e40af",
    accentLight: "#eff6ff",
    accentSubtle: "#dbeafe",
    accentBorder: "#bfdbfe",
    accentShadow: "rgba(29,78,216,0.35)",
    totalText: "#312e81",
    totalRule: "#1d4ed8",
  },
  quote: {
    accentColor: "#7c3aed",
    accentStrong: "#6d28d9",
    accentLight: "#f5f3ff",
    accentSubtle: "#ede9fe",
    accentBorder: "#ddd6fe",
    accentShadow: "rgba(124,58,237,0.35)",
    totalText: "#4c1d95",
    totalRule: "#7c3aed",
  },
} as const;
const DOCUMENT_COPY = {
  fr: {
    invoiceLabel: "FACTURE",
    quoteLabel: "DEVIS",
    draftWatermark: "BROUILLON",
    editStatus: "Modification",
    draftStatus: "Brouillon",
    numberAfterCreation: "Numéro attribué après création",
    invoiceTitle: "Titre de la facture",
    quoteTitle: "Titre du devis",
    issueDate: "Date d'émission",
    quoteDate: "Date du devis",
    serviceDate: "Date de prestation",
    dueDate: "Échéance",
    validUntil: "Valable jusqu'au",
    terms: "Conditions",
    issuer: "Émetteur",
    billedTo: "Facturé à",
    quotedTo: "Devis pour",
    selectClient: "Choisir un client",
    changeClient: "Changer de client",
    searchClient: "Rechercher un client (nom, email...)",
    searchClientShort: "Rechercher un client...",
    noClientFound: "Aucun client trouvé",
    addClient: "Ajouter un client",
    lineNumber: "N°",
    reference: "Référence",
    productService: "Produit / service",
    designation: "Désignation",
    quantity: "Qté",
    unit: "Unité",
    unitPriceHT: "PU HT",
    vat: "TVA",
    discount: "Remise",
    totalHT: "Total HT",
    discountedHT: "HT remisé",
    discountHT: "Remise HT",
    subtotalTTC: "Sous-total TTC",
    discountsTTC: "Remises TTC",
    totalTTC: "Total TTC",
    advancePaid: "Acompte déjà versé",
    remainingDue: "Reste dû",
    payment: "Paiement",
    delivery: "Livraison",
    deliveryDifferent: "Adresse de livraison : différente de la facturation",
    addDeliveryDifferent: "+ Adresse de livraison différente",
    deliveryPlaceholder: "Adresse de livraison",
    operationNature: "Nature de l’opération",
    paymentMethod: "Moyen de paiement",
    rib: "IBAN / BIC",
    noRib: "Aucun IBAN/BIC renseigné",
    paymentRib: "Coordonnées bancaires",
    legalMentions: "Mentions légales",
    status: "Statut",
    purchaseOrder: "Commande",
    penalties: "Pénalités",
    recovery: "Indemnité forfaitaire",
    freeTextPlaceholder: "Texte libre",
    printedLegalMention: "Mention légale imprimée",
    default: "Par défaut",
    edit: "Éditer",
    add: "Ajouter",
    vatCash: "TVA sur les encaissements.",
    vatDebit: "TVA acquittée d'après les débits.",
    vatExempt: "TVA non applicable, art. 293 B du CGI.",
    latePenaltyPrefix:
      "Aucun escompte n'est accordé en cas de paiement anticipé. En cas de retard de paiement, des pénalités au taux de",
    recoveryPrefix: "seront dues à compter du lendemain de l'échéance, ainsi qu'une indemnité forfaitaire de",
    earlyDiscount: "pour frais de recouvrement.",
  },
  en: {
    invoiceLabel: "INVOICE",
    quoteLabel: "QUOTE",
    draftWatermark: "DRAFT",
    editStatus: "Editing",
    draftStatus: "Draft",
    numberAfterCreation: "Number assigned after creation",
    invoiceTitle: "Invoice title",
    quoteTitle: "Quote title",
    issueDate: "Issue date",
    quoteDate: "Quote date",
    serviceDate: "Service date",
    dueDate: "Due date",
    validUntil: "Valid until",
    terms: "Terms",
    issuer: "Issuer",
    billedTo: "Bill to",
    quotedTo: "Quote for",
    selectClient: "Select a customer",
    changeClient: "Change customer",
    searchClient: "Search customer (name, email...)",
    searchClientShort: "Search customer...",
    noClientFound: "No customer found",
    addClient: "Add customer",
    lineNumber: "No.",
    reference: "Reference",
    productService: "Product / service",
    designation: "Description",
    quantity: "Qty",
    unit: "Unit",
    unitPriceHT: "Unit price excl. VAT",
    vat: "VAT",
    discount: "Discount",
    totalHT: "Total excl. VAT",
    discountedHT: "Excl. VAT after discount",
    discountHT: "Discount excl. VAT",
    subtotalTTC: "Subtotal incl. VAT",
    discountsTTC: "Discounts incl. VAT",
    totalTTC: "Total incl. VAT",
    advancePaid: "Advance already paid",
    remainingDue: "Amount due",
    payment: "Payment",
    delivery: "Delivery",
    deliveryDifferent: "Delivery address: different from billing",
    addDeliveryDifferent: "+ Different delivery address",
    deliveryPlaceholder: "Delivery address",
    operationNature: "Operation nature",
    paymentMethod: "Payment method",
    rib: "IBAN / BIC",
    noRib: "No IBAN/BIC provided",
    paymentRib: "Payment bank details",
    legalMentions: "Legal notices",
    status: "Status",
    purchaseOrder: "Purchase order",
    penalties: "Penalties",
    recovery: "Recovery fee",
    freeTextPlaceholder: "Free text",
    printedLegalMention: "Printed legal notice",
    default: "Default",
    edit: "Edit",
    add: "Add",
    vatCash: "VAT due on payments received.",
    vatDebit: "VAT payable according to debits.",
    vatExempt: "VAT not applicable, French CGI art. 293 B.",
    latePenaltyPrefix: "In case of late payment, penalties of",
    recoveryPrefix: "and a fixed recovery fee of",
    earlyDiscount: "apply. No early payment discount.",
  },
} as const;
const PAYMENT_METHOD_TRANSLATIONS: Record<"fr" | "en", Record<string, { label?: string; phrase: string }>> = {
  fr: {
    card: { phrase: "carte bancaire" },
    bank_transfer: { phrase: "virement bancaire" },
    cheque: { phrase: "chèque" },
    cash: { label: "Espèces", phrase: "espèce" },
    direct_debit: { phrase: "prélèvement bancaire" },
    cesu: { phrase: "CESU" },
    urssaf_aici: { phrase: "prélèvement Urssaf" },
    payment_app: { phrase: "application de paiement" },
  },
  en: {
    card: { label: "Card", phrase: "card" },
    bank_transfer: { label: "Bank transfer", phrase: "bank transfer" },
    cheque: { label: "Cheque", phrase: "cheque" },
    cash: { label: "Cash", phrase: "cash" },
    direct_debit: { label: "Direct debit", phrase: "direct debit" },
    cesu: { label: "CESU", phrase: "CESU" },
    urssaf_aici: { label: "Urssaf debit", phrase: "Urssaf debit" },
    payment_app: { label: "Payment app", phrase: "payment app" },
  },
};
const DEFAULT_TEMPLATE_OPTIONS = {
  show_delivery_address: true,
  show_purchase_order_number: true,
  show_note: true,
  show_supplier_email: true,
  show_supplier_phone: true,
  document_title: "",
  document_language: "fr",
  delivery_address: "",
  delivery_address_differs: false,
  document_tags: [] as string[],
  custom_fields: [] as Array<{ label: string; value: string }>,
  payment_bank_account: null as null | { id?: string; label?: string; iban?: string; bic?: string },
  payment_methods: DEFAULT_PAYMENT_METHOD_IDS,
  operation_nature: "services",
  legal_terms_default: true,
  legal_mentions_text: "",
  legal_footer_text: "",
  legal_penalty_prefix: "",
  legal_recovery_prefix: "",
  legal_discount_text: "",
  legal_penalty_rate: "10",
  legal_recovery_fee: "40",
  line_columns: {
    lineNumber: false,
    reference: false,
    quantity: true,
    unit: false,
    unitPrice: true,
    vat: true,
    discount: false,
    baseTotal: true,
    discountedTotal: false,
  },
  document_discount_input_mode: "percent",
  document_discount_amount_ht: "",
  global_vat_enabled: false,
  global_vat_draft: { ...DEFAULT_GLOBAL_VAT_DRAFT },
  advance_payments: [] as Array<{
    reference?: string;
    label?: string;
    source?: string;
    amount_ht: number;
    amount_vat: number;
    amount_ttc: number;
    vat_rate: number;
  }>,
  requested_advance: null as null | {
    reference?: string;
    label?: string;
    amount_ht?: number;
    amount_vat?: number;
    amount_ttc?: number;
    vat_rate?: number;
    percent?: number;
  },
};
const LOCAL_DOCUMENT_TEMPLATE_STORAGE_KEY = "teoman-document-editor-saved-layout-v1";
const LOCAL_DOCUMENT_TEMPLATES_STORAGE_KEY = "teoman-document-editor-named-templates-v1";
const LINE_COLUMNS_STORAGE_KEY = "teoman-document-editor-line-columns-v6";
type LineColumnId =
  | "lineNumber"
  | "reference"
  | "quantity"
  | "unit"
  | "unitPrice"
  | "vat"
  | "discount"
  | "baseTotal"
  | "discountedTotal";
type LineColumnVisibility = Record<LineColumnId, boolean>;
type CatalogFilterMode = "active" | "document" | "all" | "archived";
const DEFAULT_LINE_COLUMN_VISIBILITY: LineColumnVisibility = {
  lineNumber: false,
  reference: false,
  quantity: true,
  unit: false,
  unitPrice: true,
  vat: true,
  discount: false,
  baseTotal: true,
  discountedTotal: false,
};
const LINE_COLUMN_OPTIONS: Array<{ id: LineColumnId; label: string }> = [
  { id: "lineNumber", label: "N°" },
  { id: "reference", label: "Référence" },
  { id: "quantity", label: "Quantité" },
  { id: "unit", label: "Unité" },
  { id: "unitPrice", label: "PU HT" },
  { id: "vat", label: "TVA %" },
  { id: "discount", label: "Remise" },
  { id: "baseTotal", label: "Total HT" },
  { id: "discountedTotal", label: "HT remisé" },
];
const QUICK_LINE_PRESETS = [
  {
    id: "subscription",
    label: "Abonnement",
    product_name: "Abonnement SaaS",
    quantity: 1,
    unit_price: 390,
    vat_rate: 20,
    accounting_account: "706",
  },
  {
    id: "service",
    label: "Prestation",
    product_name: "Prestation de service",
    quantity: 1,
    unit_price: 650,
    vat_rate: 20,
    accounting_account: "706",
  },
  {
    id: "support",
    label: "Support",
    product_name: "Support & accompagnement",
    quantity: 1,
    unit_price: 180,
    vat_rate: 20,
    accounting_account: "706",
  },
  {
    id: "product",
    label: "Produit",
    product_name: "Licence / produit",
    quantity: 1,
    unit_price: 990,
    vat_rate: 20,
    accounting_account: "707",
  },
];

type ClientInfoVisibilityKey = "address" | "email" | "phone" | "identity";
type PartyEditSection =
  | "issuer-all"
  | "issuer-contact"
  | "issuer-identity"
  | "client-all"
  | "client-contact"
  | "client-identity";
type DetailRow = { label: string; value: string; mono?: boolean; multiline?: boolean };

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function splitDocumentTags(value: any) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const tags: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry: any) => {
    const tag = String(entry || "")
      .trim()
      .replace(/^#/, "")
      .slice(0, 40);
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  });
  return tags.slice(0, 10);
}

function normalizeCustomFields(value: any) {
  if (!Array.isArray(value)) return [];
  return value
    .map((field) => ({
      id: String(field?.id || uid()),
      label: String(field?.label || "").slice(0, 60),
      value: String(field?.value || "").slice(0, 240),
    }))
    .filter((field) => field.label.trim() || field.value.trim())
    .slice(0, 12);
}

function normalizePaymentMethodIds(value: any) {
  const raw = Array.isArray(value) ? value : DEFAULT_PAYMENT_METHOD_IDS;
  const ids = raw
    .map((entry: any) => String(entry || ""))
    .filter((id: string) => PAYMENT_METHOD_OPTIONS.some((option) => option.id === id));
  return ids.length ? ids.slice(0, PAYMENT_METHOD_OPTIONS.length) : DEFAULT_PAYMENT_METHOD_IDS;
}

function normalizeCustomerPaymentMethodId(value: any) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
  const aliases: Record<string, string> = {
    virement: "bank_transfer",
    virement_bancaire: "bank_transfer",
    bank: "bank_transfer",
    bank_transfer: "bank_transfer",
    transfer: "bank_transfer",
    cheque: "cheque",
    chèque: "cheque",
    check: "cheque",
    carte: "card",
    carte_bancaire: "card",
    cb: "card",
    card: "card",
    cash: "cash",
    espèces: "cash",
    especes: "cash",
    prélèvement: "direct_debit",
    prelevement: "direct_debit",
    direct_debit: "direct_debit",
  };
  const normalized = aliases[raw] || raw;
  return PAYMENT_METHOD_OPTIONS.some((option) => option.id === normalized) ? normalized : null;
}

function samePaymentMethodIds(left: any[], right: any[]) {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}

function isVatFranchiseRegime(value: any) {
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

function isGenericPaymentTerms(value: any) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return ["30 jours", "30 jours date de facture", "30 jours fin de mois", "paiement sous 30 jours"].includes(
    normalized,
  );
}

function customerDefaultVatRateInput(customer: any) {
  const rate = Number(customer?.default_vat_rate);
  return Number.isFinite(rate) ? decimalInputValue(rate) : "";
}

function isCompanyVatFranchise(company: any) {
  return isVatFranchiseRegime(company?.vat_regime);
}

function companyDefaultSalesVatRateInput(company: any) {
  const rate = Number(company?.default_sales_vat_rate);
  return Number.isFinite(rate) ? decimalInputValue(rate) : "";
}

function defaultSalesVatRateNumber(company: any, customer?: any, fallback = 20) {
  if (isCompanyVatFranchise(company)) return 0;
  const customerRate = Number(customer?.default_vat_rate);
  if (Number.isFinite(customerRate)) return customerRate;
  const companyRate = Number(company?.default_sales_vat_rate);
  if (Number.isFinite(companyRate)) return companyRate;
  return fallback;
}

function defaultSalesVatRateInput(company: any, customer?: any, fallback = 20) {
  return decimalInputValue(defaultSalesVatRateNumber(company, customer, fallback));
}

function dueDateFromPaymentTerms(baseDate: string, paymentTerms: any) {
  const value = String(paymentTerms || "")
    .trim()
    .toLowerCase();
  if (!value) return { date: "", days: 0 };
  const days = /comptant|immédiat|immediat|réception|reception/.test(value)
    ? 0
    : Math.max(0, Number(value.match(/(\d+)/)?.[1] || 30));
  const date = addDays(baseDate, days);
  if (/fin de mois|fdm/.test(value) && date) {
    const monthEnd = new Date(date);
    if (!Number.isNaN(monthEnd.getTime())) {
      monthEnd.setMonth(monthEnd.getMonth() + 1, 0);
      return { date: dateInputValue(monthEnd), days: signedDiffDays(baseDate, dateInputValue(monthEnd)) };
    }
  }
  return { date, days };
}

function normalizeLineColumnVisibility(value: any): LineColumnVisibility {
  const raw = value && typeof value === "object" ? value : {};
  return LINE_COLUMN_OPTIONS.reduce<LineColumnVisibility>(
    (visibility, option) => ({
      ...visibility,
      [option.id]: typeof raw?.[option.id] === "boolean" ? raw[option.id] : visibility[option.id],
    }),
    { ...DEFAULT_LINE_COLUMN_VISIBILITY },
  );
}

function normalizeGlobalVatDraft(value: any) {
  const raw = value && typeof value === "object" ? value : {};
  const rawRate = String(raw.vat_rate ?? DEFAULT_GLOBAL_VAT_DRAFT.vat_rate).trim();
  const vatRate = rawRate || DEFAULT_GLOBAL_VAT_DRAFT.vat_rate;
  const vatRateNumber = numberInputValue(vatRate);
  const rawCategory =
    String(raw.vat_category || "")
      .trim()
      .toUpperCase() || defaultVatCategoryForRate(vatRate);
  const vatCategory = vatRateNumber > 0 ? "S" : rawCategory === "S" ? "O" : rawCategory;
  return {
    vat_rate: vatRate,
    vat_category: vatCategory,
    exemption_reason_code: String(raw.exemption_reason_code || "").trim(),
    unit_code:
      String(raw.unit_code || DEFAULT_GLOBAL_VAT_DRAFT.unit_code)
        .trim()
        .toUpperCase()
        .slice(0, 8) || DEFAULT_GLOBAL_VAT_DRAFT.unit_code,
  };
}

function normalizeTemplateOptionsForForm(value: any) {
  const raw = value && typeof value === "object" ? value : {};
  const language = String(raw.document_language || DEFAULT_TEMPLATE_OPTIONS.document_language)
    .trim()
    .toLowerCase()
    .startsWith("en")
    ? "en"
    : "fr";
  return {
    show_delivery_address: raw.show_delivery_address !== false,
    show_purchase_order_number: raw.show_purchase_order_number !== false,
    show_note: raw.show_note !== false,
    show_supplier_email: raw.show_supplier_email !== false,
    show_supplier_phone: raw.show_supplier_phone !== false,
    delivery_address: String(raw.delivery_address || "").slice(0, 1200),
    delivery_address_differs: Boolean(raw.delivery_address_differs),
    document_title: String(raw.document_title || "").slice(0, 140),
    document_language: language,
    document_tags: splitDocumentTags(raw.document_tags),
    custom_fields: normalizeCustomFields(raw.custom_fields),
    payment_bank_account:
      raw.payment_bank_account && typeof raw.payment_bank_account === "object" ? raw.payment_bank_account : null,
    payment_methods: normalizePaymentMethodIds(raw.payment_methods),
    operation_nature: ["goods", "services", "mixed"].includes(String(raw.operation_nature || "services"))
      ? String(raw.operation_nature || "services")
      : "services",
    legal_terms_default: typeof raw.legal_terms_default === "boolean" ? raw.legal_terms_default : true,
    legal_mentions_text: String(raw.legal_mentions_text || ""),
    legal_footer_text: normalizeLegalFooterText(raw.legal_footer_text),
    legal_penalty_prefix: String(raw.legal_penalty_prefix || ""),
    legal_recovery_prefix: String(raw.legal_recovery_prefix || ""),
    legal_discount_text: String(raw.legal_discount_text || ""),
    legal_penalty_rate: String(raw.legal_penalty_rate || DEFAULT_TEMPLATE_OPTIONS.legal_penalty_rate),
    legal_recovery_fee: String(raw.legal_recovery_fee || DEFAULT_TEMPLATE_OPTIONS.legal_recovery_fee),
    line_columns: normalizeLineColumnVisibility(raw.line_columns),
    document_discount_input_mode: raw.document_discount_input_mode === "amount" ? "amount" : "percent",
    document_discount_amount_ht: String(raw.document_discount_amount_ht || ""),
    global_vat_enabled: Boolean(raw.global_vat_enabled),
    global_vat_draft: normalizeGlobalVatDraft(raw.global_vat_draft),
    show_vat_totals: raw.show_vat_totals !== false,
    advance_payments: Array.isArray(raw.advance_payments) ? raw.advance_payments : [],
    requested_advance:
      raw.requested_advance && typeof raw.requested_advance === "object" ? raw.requested_advance : null,
  };
}

function isCustomerPaymentBankAccount(value: any) {
  if (!value || typeof value !== "object") return false;
  const id = String(value.id || "").trim();
  const label = String(value.label || "")
    .trim()
    .toLowerCase();
  return id.startsWith("customer:") || label === "rib client";
}

function buildTemplateOptions(form: any) {
  const base = normalizeTemplateOptionsForForm(form?.template_options);
  const legalTermsDefault =
    typeof form?.legal_terms_default === "boolean" ? form.legal_terms_default : base.legal_terms_default;
  const deliveryAddress = String(form?.delivery_address ?? base.delivery_address ?? "")
    .trim()
    .slice(0, 1200);
  const deliveryAddressDiffers = Boolean(
    (form?.delivery_address_differs ?? base.delivery_address_differs) && deliveryAddress,
  );
  return {
    ...base,
    document_title: String(form?.document_title || base.document_title || "")
      .trim()
      .slice(0, 140),
    document_language: String(form?.document_language || base.document_language || "fr").startsWith("en") ? "en" : "fr",
    document_tags: splitDocumentTags(form?.document_tags ?? base.document_tags),
    delivery_address: deliveryAddressDiffers ? deliveryAddress : "",
    delivery_address_differs: deliveryAddressDiffers,
    payment_methods: normalizePaymentMethodIds(form?.payment_methods ?? base.payment_methods),
    operation_nature: ["goods", "services", "mixed"].includes(
      String(form?.operation_nature || base.operation_nature || "services"),
    )
      ? String(form?.operation_nature || base.operation_nature || "services")
      : "services",
    legal_terms_default: legalTermsDefault,
    legal_mentions_text: String(form?.legal_mentions_text ?? base.legal_mentions_text ?? ""),
    legal_footer_text: normalizeLegalFooterText(form?.legal_footer_text ?? base.legal_footer_text ?? ""),
    legal_penalty_prefix: legalTermsDefault
      ? ""
      : String(form?.legal_penalty_prefix ?? base.legal_penalty_prefix ?? ""),
    legal_recovery_prefix: legalTermsDefault
      ? ""
      : String(form?.legal_recovery_prefix ?? base.legal_recovery_prefix ?? ""),
    legal_discount_text: legalTermsDefault ? "" : String(form?.legal_discount_text ?? base.legal_discount_text ?? ""),
    legal_penalty_rate: String(form?.legal_penalty_rate || base.legal_penalty_rate || "10"),
    legal_recovery_fee: String(form?.legal_recovery_fee || base.legal_recovery_fee || "40"),
    line_columns: normalizeLineColumnVisibility(form?.line_columns ?? base.line_columns),
    custom_fields: normalizeCustomFields(form?.custom_fields ?? base.custom_fields).map(({ label, value }) => ({
      label: label.trim(),
      value: value.trim(),
    })),
  };
}

function emptyLine(vatRate: any = "") {
  return {
    id: uid(),
    line_type: "item",
    display_number: null,
    reference: "",
    product_name: "",
    detail: "",
    quantity: "",
    unit_price: "",
    vat_rate: vatRate,
    vat_category: "S",
    unit_code: "C62",
    exemption_reason_code: "",
    item_id: null,
    discount_percent: "",
    discount_amount_ht: "",
    discount_input_mode: "percent",
    accounting_account: "",
  };
}

function franchiseVatLine(line: any) {
  if (String(line?.line_type || "item").toLowerCase() !== "item") return line;
  const nextLine = {
    ...line,
    vat_rate: 0,
    vat_category: "E",
    exemption_reason_code: VAT_FRANCHISE_REASON_CODE,
  };
  return String(line?.vat_rate ?? "") === "0" &&
    String(line?.vat_category || "")
      .trim()
      .toUpperCase() === "E" &&
    String(line?.exemption_reason_code || "")
      .trim()
      .toUpperCase() === VAT_FRANCHISE_REASON_CODE
    ? line
    : nextLine;
}

function commentLineFromText(text: any) {
  const value = String(text || "").trim();
  return {
    ...emptyLine(),
    line_type: "comment",
    product_name: value,
    detail: value,
    quantity: 0,
    unit_price: 0,
    vat_rate: 0,
    vat_category: "S",
  };
}

function lineTypeOf(line: any) {
  const type = String(line?.line_type || "item").toLowerCase();
  return ["title", "comment"].includes(type) ? type : "item";
}

function lineCommentText(line: any) {
  return String(line?.detail || "").trim();
}

function isItemLine(line: any) {
  return lineTypeOf(line) === "item";
}

function isCommentLine(line: any) {
  return lineTypeOf(line) === "comment";
}

function itemLineGroupRange(lines: any[], index: number) {
  if (index < 0 || index >= lines.length) return null;
  const end = isItemLine(lines[index]) && isCommentLine(lines[index + 1]) ? index + 1 : index;
  return { start: index, end };
}

function targetLineBlockRange(lines: any[], index: number) {
  if (index < 0 || index >= lines.length) return null;
  if (isCommentLine(lines[index]) && isItemLine(lines[index - 1])) {
    return { start: index - 1, end: index };
  }
  return itemLineGroupRange(lines, index);
}

function lineGroupRemovalIds(lines: any[], id: string) {
  const index = lines.findIndex((line) => line.id === id);
  if (index === -1) return [];
  const range = itemLineGroupRange(lines, index);
  if (!range) return [];
  return lines.slice(range.start, range.end + 1).map((line) => line.id);
}

function removeLineAndAttachedComment(lines: any[], id: string) {
  if (!Array.isArray(lines) || lines.length <= 1) return lines;
  const ids = lineGroupRemovalIds(lines, id);
  if (!ids.length) return lines;
  const nextLines = lines.filter((line) => !ids.includes(line.id));
  return nextLines.length > 0 ? nextLines : [emptyLine()];
}

function splitInlineItemComments(lines: any[]) {
  const sourceLines = Array.isArray(lines) ? lines : [];
  const nextLines: any[] = [];
  sourceLines.forEach((line, index) => {
    const inlineComment = lineTypeOf(line) === "item" ? lineCommentText(line) : "";
    if (!inlineComment) {
      nextLines.push(line);
      return;
    }
    const followingLine = sourceLines[index + 1];
    const followingText = String(followingLine?.detail || followingLine?.product_name || "").trim();
    nextLines.push({ ...line, detail: "" });
    if (!(lineTypeOf(followingLine) === "comment" && followingText === inlineComment)) {
      nextLines.push(commentLineFromText(inlineComment));
    }
  });
  return nextLines;
}

function loadLineColumnVisibility(): LineColumnVisibility {
  if (typeof window === "undefined") return DEFAULT_LINE_COLUMN_VISIBILITY;
  try {
    const raw = window.localStorage.getItem(LINE_COLUMNS_STORAGE_KEY);
    if (!raw) return DEFAULT_LINE_COLUMN_VISIBILITY;
    const parsed = JSON.parse(raw);
    return normalizeLineColumnVisibility(parsed);
  } catch {
    return DEFAULT_LINE_COLUMN_VISIBILITY;
  }
}

function numberInputValue(value: any) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(",", ".");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function strictNumberInputValue(value: any) {
  const raw = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(",", ".");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatVatRateInputDisplay(value: any) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\s+/g, "").replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return raw;
  const [integerPart, decimalPart = ""] = normalized.split(".");
  const trimmedDecimal = decimalPart.replace(/0+$/, "");
  return trimmedDecimal ? `${integerPart},${trimmedDecimal}` : integerPart;
}

function sanitizeAccountingAccount(value: any) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, "")
    .slice(0, 20);
}

function defaultSalesAccountingAccount(operationNature: any, configuredAccount?: any) {
  const configured = sanitizeAccountingAccount(configuredAccount);
  const nature = String(operationNature || "").toLowerCase();
  if (nature === "goods" && (!configured || configured === "706")) return "707";
  if (configured) return configured;
  return "706";
}

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.max(36, element.scrollHeight)}px`;
}

function editorLine(line: any, fallbackVatRate = 20) {
  const discountPercent = numberInputValue(line?.discount_percent);
  const discountAmount = numberInputValue(line?.discount_amount_ht);
  const resolvedVatRate = Number.isFinite(Number(line?.vat_rate))
    ? Number(line?.vat_rate)
    : Number(fallbackVatRate || 20);
  const resolvedVatCategory =
    String(line?.vat_category || "")
      .trim()
      .toUpperCase() || (resolvedVatRate === 0 ? "O" : "S");
  return {
    id: uid(),
    line_type: ["title", "comment"].includes(String(line?.line_type || "").toLowerCase())
      ? String(line?.line_type || "").toLowerCase()
      : "item",
    display_number: line?.display_number == null ? null : String(line.display_number).trim(),
    reference: String(line?.reference || "").slice(0, 80),
    product_name: line?.product_name || "",
    detail: line?.detail || "",
    quantity: Number(line?.quantity || 1),
    unit_price: Number(line?.unit_price || 0),
    vat_rate: vatRateForCategory(resolvedVatCategory, resolvedVatRate, fallbackVatRate),
    vat_category: resolvedVatCategory,
    unit_code: String(line?.unit_code || "C62")
      .trim()
      .toUpperCase(),
    exemption_reason_code: String(line?.exemption_reason_code || "").trim(),
    item_id: line?.item_id || null,
    discount_percent: discountPercent > 0 ? Math.min(discountPercent, 100) : "",
    discount_amount_ht: discountAmount > 0 ? roundMoney(discountAmount) : "",
    discount_input_mode: line?.discount_input_mode === "amount" ? "amount" : "percent",
    accounting_account: String(line?.accounting_account || "").trim(),
  };
}

function buildSeedLine(seed: any, fallbackVatRate: number) {
  return editorLine({
    product_name: seed?.product_name || seed?.name || "",
    detail: seed?.detail || seed?.description || "",
    quantity: Number(seed?.quantity || 1),
    unit_price: Number(seed?.unit_price || 0),
    vat_rate: Number(seed?.vat_rate ?? fallbackVatRate),
    vat_category: seed?.vat_category,
    unit_code: seed?.unit_code,
    exemption_reason_code: seed?.exemption_reason_code,
    item_id: seed?.item_id || seed?.id || null,
    accounting_account: seed?.accounting_account || "",
    discount_percent: "",
    discount_amount_ht: "",
  });
}

function buildSeedLines(seed: any, fallbackVatRate: number) {
  return splitInlineItemComments([buildSeedLine(seed, fallbackVatRate)]);
}

function money(value: any, currency = "EUR") {
  const amount = Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount} ${currency === "EUR" ? "€" : currency}`;
}

function decimalInputValue(value: any) {
  return Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function normalizeVatRateOptionValue(value: any) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = numberInputValue(raw);
  if (!Number.isFinite(parsed)) return "";
  return String(parsed).replace(/\.0+$/, "");
}

function advanceVatSelectValue(value: any) {
  const normalized = normalizeVatRateOptionValue(value);
  if (!normalized) return "";
  return ADVANCE_VAT_RATE_OPTIONS.some((option) => option.value === normalized) ? normalized : "custom";
}

function dateDisplayFr(value: any) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString("fr-FR");
}

function normalizeFrenchDateInput(value: any) {
  const raw = String(value || "").trim();
  const compact = raw.replace(/[^\d]/g, "");
  const match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  const compactMatch = compact.length === 8 ? compact.match(/^(\d{2})(\d{2})(\d{4})$/) : null;
  const parts = match || compactMatch;
  if (!parts) return raw;
  const day = Number(parts[1]);
  const month = Number(parts[2]);
  const year = Number(parts[3]);
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900 || year > 2200) return raw;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function frenchList(values: string[]) {
  const filtered = values.map((value) => value.trim()).filter(Boolean);
  if (!filtered.length) return "";
  if (filtered.length === 1) return filtered[0];
  if (filtered.length === 2) return `${filtered[0]} ou ${filtered[1]}`;
  return `${filtered.slice(0, -1).join(", ")} ou ${filtered[filtered.length - 1]}`;
}

function lineDiscountPercent(line: any) {
  const explicitAmount = numberInputValue(line?.discount_amount_ht);
  const base = lineBaseTotalHT(line);
  if (explicitAmount > 0 && base > 0) {
    return Math.min(100, roundMoney((Math.min(explicitAmount, base) / base) * 100));
  }
  return clampDiscountPercent(line?.discount_percent);
}

function clampDiscountPercent(value: any) {
  const direct = numberInputValue(value);
  if (!Number.isFinite(direct) || direct <= 0) return 0;
  return Math.min(direct, 100);
}

function lineBaseUnitPrice(line: any) {
  return roundMoney(numberInputValue(line?.unit_price));
}

function lineBaseTotalHT(line: any) {
  return roundMoney(numberInputValue(line?.quantity) * lineBaseUnitPrice(line));
}

function lineDiscountedUnitPrice(line: any) {
  const quantity = numberInputValue(line?.quantity);
  const baseTotal = lineBaseTotalHT(line);
  const discountAmount = lineDiscountAmountHT(line);
  if (!quantity || !discountAmount) return lineBaseUnitPrice(line);
  return roundMoney(Math.max(baseTotal - discountAmount, 0) / quantity);
}

function lineTotalHT(line: any) {
  const base = lineBaseTotalHT(line);
  if (base <= 0) return roundMoney(base);
  return roundMoney(Math.max(base - lineDiscountAmountHT(line), 0));
}

function lineDiscountAmountHT(line: any) {
  const base = lineBaseTotalHT(line);
  const explicitAmount = numberInputValue(line?.discount_amount_ht);
  if (explicitAmount > 0) return roundMoney(Math.min(explicitAmount, Math.max(base, 0)));
  const percent = clampDiscountPercent(line?.discount_percent);
  return percent > 0 ? roundMoney(Math.max(base, 0) * (percent / 100)) : 0;
}

function defaultVatCategoryForRate(rate: any) {
  if (!String(rate ?? "").trim()) return "S";
  return numberInputValue(rate) === 0 ? "O" : "S";
}

function vatRateForCategory(category: any, currentRate: any, fallbackRate: any = 20) {
  const normalized = String(category || "")
    .trim()
    .toUpperCase();
  if (normalized && normalized !== "S") return 0;
  const current = numberInputValue(currentRate);
  if (current > 0) return current;
  const fallback = numberInputValue(fallbackRate);
  return fallback > 0 ? fallback : 20;
}

function lineVatCategory(line: any) {
  const normalized = String(line?.vat_category || "")
    .trim()
    .toUpperCase();
  return normalized || defaultVatCategoryForRate(line?.vat_rate);
}

function lineUnitCode(line: any) {
  return (
    String(line?.unit_code || "")
      .trim()
      .toUpperCase()
      .slice(0, 8) || "C62"
  );
}

function lineExemptionReasonCode(line: any) {
  const normalized = String(line?.exemption_reason_code || "").trim();
  if (!normalized) return null;
  const rawRate = String(line?.vat_rate ?? "").trim();
  const rate = numberInputValue(line?.vat_rate);
  const category = lineVatCategory(line);
  if (rawRate && rate === 0) return normalized;
  if (category !== "S") return normalized;
  return null;
}

function lineRequiresExemptionCode(line: any) {
  if (String(line?.line_type || "item") !== "item") return false;
  if (!String(line?.product_name || "").trim()) return false;
  const rawRate = String(line?.vat_rate ?? "").trim();
  const rawCategory = String(line?.vat_category || "")
    .trim()
    .toUpperCase();
  if (!rawRate && (!rawCategory || rawCategory === "S")) return false;
  const rate = numberInputValue(line?.vat_rate);
  return Boolean(rawRate && rate === 0) || lineVatCategory(line) !== "S";
}

function lineHasExplicitAdvancedCompliance(line: any) {
  return (
    lineVatCategory(line) !== defaultVatCategoryForRate(line?.vat_rate) ||
    lineUnitCode(line) !== "C62" ||
    Boolean(lineExemptionReasonCode(line))
  );
}

function lineNeedsAdvancedComplianceAttention(line: any, _company?: any, _copy?: { vatExempt: string }) {
  return lineRequiresExemptionCode(line) && !lineExemptionReasonCode(line);
}

function invoiceLineCompletenessIssues(lines: any[]) {
  const itemLines = lines.filter(
    (line) => String(line?.line_type || "item") === "item" && String(line?.product_name || "").trim(),
  );
  const issues: string[] = [];
  if (!itemLines.length) {
    issues.push("au moins une désignation");
    return issues;
  }
  const hasInvalidQuantity = itemLines.some((line) => {
    const quantity = strictNumberInputValue(line?.quantity);
    return quantity === null || quantity <= 0;
  });
  const hasMissingUnitPrice = itemLines.some((line) => strictNumberInputValue(line?.unit_price) === null);
  const hasMissingVatRate = itemLines.some((line) => strictNumberInputValue(line?.vat_rate) === null);
  if (hasInvalidQuantity) issues.push("quantité supérieure à 0");
  if (hasMissingUnitPrice) issues.push("prix HT renseigné");
  if (hasMissingVatRate) issues.push("taux de TVA renseigné");
  return issues;
}

function isDiscountLine(line: any) {
  if (String(line?.line_type || "item") !== "item") return false;
  if (/acompte/i.test(String(line?.product_name || ""))) return false;
  return lineBaseTotalHT(line) < 0 || Number(line?.unit_price || 0) < 0;
}

function isDocumentDiscountLine(line: any) {
  return /remise\s+(globale|totale|facture|document)/i.test(String(line?.product_name || ""));
}

function extractDiscountPercent(line: any) {
  const direct = numberInputValue(line?.discount_percent);
  if (Number.isFinite(direct) && direct > 0) return Math.min(direct, 100);
  const match = String(line?.product_name || "").match(/remise\s+([0-9]+(?:[.,][0-9]+)?)\s*%/i);
  if (!match) return null;
  const parsed = Number(String(match[1]).replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : null;
}

function discountReferenceAmount(line: any) {
  const direct = Number(line?.discount_base_amount);
  if (Number.isFinite(direct) && direct > 0) return roundMoney(direct);
  const percent = extractDiscountPercent(line);
  const reduction = Math.abs(lineBaseTotalHT(line));
  if (!percent || !reduction) return null;
  return roundMoney(reduction / (percent / 100));
}

function applyLegacyDiscountToLines(lines: any[], legacyDiscount: any) {
  const amount = numberInputValue(legacyDiscount?.amount);
  const explicitPercent = numberInputValue(legacyDiscount?.percent_hint ?? legacyDiscount?.percent);
  const baseAmount = numberInputValue(legacyDiscount?.base_amount ?? legacyDiscount?.baseAmount);
  if (!amount || !lines.length) return lines;

  if (explicitPercent > 0 && explicitPercent <= 100) {
    const targetIndex = baseAmount
      ? lines.findIndex((line) => Math.abs(lineBaseTotalHT(line) - baseAmount) < 0.02)
      : lines.findIndex((line) => lineBaseTotalHT(line) > 0);
    const safeIndex = targetIndex >= 0 ? targetIndex : 0;
    return lines.map((line, index) =>
      index === safeIndex ? { ...line, discount_percent: roundMoney(explicitPercent), discount_open: true } : line,
    );
  }

  const subtotal = lines.reduce((sum, line) => sum + Math.max(lineBaseTotalHT(line), 0), 0);
  const inferredPercent = subtotal > 0 ? roundMoney((amount / subtotal) * 100) : 0;
  if (!inferredPercent || inferredPercent > 100) return lines;
  return lines.map((line) =>
    lineBaseTotalHT(line) > 0 ? { ...line, discount_percent: inferredPercent, discount_open: true } : line,
  );
}

function extractEditorState(sourceLines: any[], fallbackVatRate = 20) {
  const visibleLines: any[] = [];
  let discountAmount = 0;
  let discountPercent: number | null = null;
  let discountBaseAmount: number | null = null;
  let documentDiscountAmount = 0;
  let documentDiscountPercent: number | null = null;
  let documentDiscountBaseAmount = 0;

  sourceLines.forEach((line) => {
    const normalized = editorLine(line, fallbackVatRate);
    const sourceLineType = String(line?.line_type || "")
      .trim()
      .toLowerCase();
    const sourceQuantity = numberInputValue(line?.quantity);
    const sourceUnitPrice = numberInputValue(line?.unit_price);
    const sourceVatRate = numberInputValue(line?.vat_rate);
    const sourceLabel = String(line?.product_name || "").trim();
    const previousVisibleLine = visibleLines[visibleLines.length - 1];
    const looksLikeLegacyComment =
      normalized.line_type === "item" &&
      (!sourceLineType || sourceLineType === "item") &&
      Boolean(sourceLabel) &&
      sourceQuantity === 0 &&
      sourceUnitPrice === 0 &&
      sourceVatRate === 0 &&
      !String(line?.reference || "").trim() &&
      !String(line?.detail || "").trim() &&
      String(previousVisibleLine?.line_type || "item") === "item" &&
      lineBaseTotalHT(previousVisibleLine) !== 0;
    if (looksLikeLegacyComment) {
      visibleLines.push(
        editorLine(
          {
            ...line,
            line_type: "comment",
            product_name: sourceLabel,
            detail: sourceLabel,
            quantity: 0,
            unit_price: 0,
            vat_rate: 0,
          },
          fallbackVatRate,
        ),
      );
      return;
    }
    if (isDiscountLine(normalized)) {
      if (isDocumentDiscountLine(line)) {
        documentDiscountAmount = roundMoney(documentDiscountAmount + Math.abs(lineBaseTotalHT(normalized)));
        if (documentDiscountPercent === null) documentDiscountPercent = extractDiscountPercent(line);
        documentDiscountBaseAmount = roundMoney(
          documentDiscountBaseAmount + Number(discountReferenceAmount(line) || 0),
        );
      } else {
        const previousLine = visibleLines[visibleLines.length - 1];
        const previousBase = previousLine ? lineBaseTotalHT(previousLine) : 0;
        const discountLineAmount = Math.abs(lineBaseTotalHT(normalized));
        const inferredLinePercent = previousBase > 0 ? roundMoney((discountLineAmount / previousBase) * 100) : 0;
        if (previousLine && inferredLinePercent > 0 && inferredLinePercent <= 100) {
          previousLine.discount_percent = Math.min(
            100,
            roundMoney(lineDiscountPercent(previousLine) + inferredLinePercent),
          );
          previousLine.discount_open = true;
        } else {
          discountAmount = roundMoney(discountAmount + discountLineAmount);
          if (discountPercent === null) discountPercent = extractDiscountPercent(line);
          if (discountBaseAmount === null) discountBaseAmount = discountReferenceAmount(line);
        }
      }
      return;
    }
    visibleLines.push(normalized);
  });

  const normalizedLines = splitInlineItemComments(visibleLines.length ? visibleLines : [emptyLine()]);
  const lines = applyLegacyDiscountToLines(normalizedLines, {
    amount: discountAmount,
    percent_hint: discountPercent,
    base_amount: discountBaseAmount,
  });
  const documentDiscountBase =
    documentDiscountBaseAmount > 0
      ? documentDiscountBaseAmount
      : roundMoney(lines.reduce((sum, line) => sum + Math.max(lineTotalHT(line), 0), 0));
  const inferredDocumentDiscountPercent =
    documentDiscountAmount > 0 && documentDiscountBase > 0
      ? roundMoney((documentDiscountAmount / documentDiscountBase) * 100)
      : 0;

  return {
    lines,
    document_discount_percent:
      documentDiscountPercent !== null && documentDiscountPercent > 0
        ? roundMoney(documentDiscountPercent)
        : inferredDocumentDiscountPercent > 0
          ? Math.min(inferredDocumentDiscountPercent, 100)
          : "",
  };
}

function extractEditorLines(sourceLines: any[], fallbackVatRate = 20) {
  return extractEditorState(sourceLines, fallbackVatRate).lines;
}

function buildDocumentDiscountLines(lines: any[], percentValue: any) {
  const percent = clampDiscountPercent(percentValue);
  if (!percent) return [];
  const groups = new Map<
    string,
    { rate: number; vat_category: string; exemption_reason_code: string | null; base: number }
  >();
  lines.forEach((line) => {
    if (String(line?.line_type || "item") !== "item") return;
    if (!String(line?.product_name || "").trim()) return;
    const base = lineTotalHT(line);
    if (base <= 0) return;
    const rate = numberInputValue(line.vat_rate);
    const vatCategory = lineVatCategory(line);
    const exemptionReason = lineExemptionReasonCode(line);
    const key = `${rate}|${vatCategory}|${exemptionReason || ""}`;
    const current = groups.get(key) || {
      rate,
      vat_category: vatCategory,
      exemption_reason_code: exemptionReason,
      base: 0,
    };
    current.base = roundMoney(current.base + base);
    groups.set(key, current);
  });
  const entries = Array.from(groups.values()).filter((entry) => entry.base > 0);
  const hasMultipleRates = entries.length > 1;
  return entries
    .map((entry) => {
      const amount = roundMoney(entry.base * (percent / 100));
      const categoryLabel =
        entry.vat_category !== defaultVatCategoryForRate(entry.rate) ? ` · Cat. ${entry.vat_category}` : "";
      const rateLabel = `TVA ${entry.rate}%${categoryLabel}`;
      return {
        id: `document-discount-${entry.rate}-${entry.vat_category}-${entry.exemption_reason_code || "none"}`,
        product_name: hasMultipleRates
          ? `Remise globale ${roundMoney(percent)}% - ${rateLabel}`
          : `Remise globale ${roundMoney(percent)}%`,
        quantity: 1,
        unit_price: -amount,
        vat_rate: entry.rate,
        vat_category: entry.vat_category,
        exemption_reason_code: entry.exemption_reason_code,
        unit_code: "C62",
        item_id: null,
        discount_percent: "",
      };
    })
    .filter((line) => Math.abs(line.unit_price) > 0);
}

function buildLineDiscountLine(line: any) {
  const percent = lineDiscountPercent(line);
  const amount = lineDiscountAmountHT(line);
  const productName = String(line?.product_name || "").trim();
  if (!percent || !amount || !productName) return null;
  return {
    id: `${line.id || uid()}-discount`,
    reference: "",
    product_name: `Remise ${roundMoney(percent)}% - ${productName}`,
    quantity: 1,
    unit_price: -amount,
    vat_rate: numberInputValue(line.vat_rate),
    vat_category: lineVatCategory(line),
    exemption_reason_code: lineExemptionReasonCode(line),
    unit_code: "C62",
    item_id: null,
    accounting_account: line?.accounting_account || null,
    discount_percent: "",
  };
}

function buildPayloadLines(lines: any[], documentDiscountPercent: any, fallbackAccountingAccount?: any) {
  const linePayload = lines.flatMap((line) => {
    const base = normalizeLine(line, fallbackAccountingAccount);
    if (!base.product_name) return [];
    if (base.line_type !== "item") return [base];
    const discountLine = buildLineDiscountLine(line);
    return discountLine ? [base, normalizeLine(discountLine, fallbackAccountingAccount)] : [base];
  });
  const documentDiscountPayload = buildDocumentDiscountLines(lines, documentDiscountPercent).map((line) =>
    normalizeLine(line, fallbackAccountingAccount),
  );
  return [...linePayload, ...documentDiscountPayload];
}

function signedMoney(value: any, currency = "EUR") {
  const amount = roundMoney(value);
  if (amount < 0) return `- ${money(Math.abs(amount), currency)}`;
  if (amount > 0) return `+ ${money(amount, currency)}`;
  return money(0, currency);
}

function dateInputValue(value: any) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function createInitialDocumentForm(customerId = "") {
  const today = dateInputValue(new Date());
  const defaultDueDate = addDays(today, 30);
  return {
    customer_id: customerId,
    quote_id: "",
    currency: "EUR",
    issue_date: today,
    service_date: today,
    due_date: defaultDueDate,
    valid_until: defaultDueDate,
    payment_terms: "30 jours date de facture",
    purchase_order_number: "",
    delivery_address: "",
    delivery_address_differs: false,
    document_title: "",
    note: "",
    operation_nature: "services",
    facturx_profile: "en16931",
    template_key: "classic",
    template_options: normalizeTemplateOptionsForForm(null),
    document_language: "fr",
    document_tags: "",
    custom_fields: [],
    document_discount_percent: "",
    payment_methods: DEFAULT_PAYMENT_METHOD_IDS,
    payment_delay_days: "",
    legal_terms_default: true,
    legal_mentions_text: "",
    legal_footer_text: "",
    legal_penalty_prefix: "",
    legal_recovery_prefix: "",
    legal_discount_text: "",
    legal_penalty_rate: "10",
    legal_recovery_fee: "40",
  };
}

function signedDiffDays(fromDate: string | null | undefined, toDate: string | null | undefined) {
  if (!fromDate || !toDate) return 0;
  const start = new Date(fromDate);
  const end = new Date(toDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function companyAddress(company: any) {
  return [
    company?.address_line1 || company?.address,
    company?.address_line2,
    [company?.postal_code, company?.city].filter(Boolean).join(" "),
    company?.country_code || company?.country,
  ]
    .filter(Boolean)
    .join("\n");
}

function customerAddress(customer: any) {
  return [
    customer?.address_line1 || customer?.address,
    customer?.address_line2,
    [customer?.postal_code, customer?.city].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function hasInvoicePartyAddress(party: any) {
  if (!party) return false;
  if (String(party?.address || "").trim()) return true;
  return Boolean(
    String(party?.address_line1 || "").trim() &&
    String(party?.postal_code || "").trim() &&
    String(party?.city || "").trim(),
  );
}

function digitsOnly(value: any) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeLegalFooterText(value: any) {
  return String(value || "").replace("Pénalités de retard : taux directeur BCE majoré.", "Pénalités de retard : 10%.");
}

type DocumentLegalTemplateKind = "invoice" | "quote";

function normalizeDocumentLegalTemplate(value: any) {
  if (!value || typeof value !== "object") return null;
  return {
    legal_terms_default: typeof value.legal_terms_default === "boolean" ? value.legal_terms_default : false,
    legal_footer_text: normalizeLegalFooterText(value.legal_footer_text).slice(0, 5000),
    legal_penalty_prefix: String(value.legal_penalty_prefix || "").slice(0, 5000),
    legal_recovery_prefix: String(value.legal_recovery_prefix || "").slice(0, 5000),
    legal_discount_text: String(value.legal_discount_text || "").slice(0, 5000),
    legal_penalty_rate: String(value.legal_penalty_rate || "10").slice(0, 32),
    legal_recovery_fee: String(value.legal_recovery_fee || "40").slice(0, 32),
    saved_at: typeof value.saved_at === "string" ? value.saved_at : "",
  };
}

function getDocumentLegalTemplate(features: any, kind: DocumentLegalTemplateKind) {
  return normalizeDocumentLegalTemplate(features?.document_legal_templates?.[kind]);
}

function applyDocumentLegalTemplateToForm(form: any, template: any) {
  const normalized = normalizeDocumentLegalTemplate(template);
  if (!normalized) return form;
  const fields = {
    legal_terms_default: normalized.legal_terms_default,
    legal_footer_text: normalized.legal_footer_text,
    legal_penalty_prefix: normalized.legal_penalty_prefix,
    legal_recovery_prefix: normalized.legal_recovery_prefix,
    legal_discount_text: normalized.legal_discount_text,
    legal_penalty_rate: normalized.legal_penalty_rate,
    legal_recovery_fee: normalized.legal_recovery_fee,
  };
  return {
    ...form,
    ...fields,
    legal_terms_default: fields.legal_terms_default,
  };
}

function formatLegalTemplateSavedAt(value: any) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function normalizePhoneInput(value: any) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasInternationalPrefix = raw.startsWith("+");
  const digits = digitsOnly(raw).slice(0, 15);
  if (!digits) return "";
  return formatPhoneDisplay(hasInternationalPrefix ? `+${digits}` : digits);
}

function withFinalPeriod(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const VAT_ZERO_REASON_LABELS: Record<string, { fr: string; en: string }> = {
  "VATEX-FR-FRANCHISE": {
    fr: "TVA non applicable, art. 293 B du CGI",
    en: "VAT not applicable, French CGI art. 293 B",
  },
  "VATEX-FR-CGI261-1": { fr: "Exonération de TVA", en: "VAT exemption" },
  "VATEX-FR-CGI261-2": { fr: "Exonération de TVA", en: "VAT exemption" },
  "VATEX-FR-CGI261-3": { fr: "Exonération de TVA", en: "VAT exemption" },
  "VATEX-FR-CGI261-4": { fr: "Exonération de TVA", en: "VAT exemption" },
  "VATEX-FR-CGI261-5": { fr: "Exonération de TVA", en: "VAT exemption" },
  "VATEX-FR-CGI261-7": { fr: "Exonération de TVA", en: "VAT exemption" },
  "VATEX-FR-CGI261-8": { fr: "Exonération de TVA", en: "VAT exemption" },
  "VATEX-FR-EXO": { fr: "Exonération de TVA", en: "VAT exemption" },
  "VATEX-FR-EXPORT": { fr: "Exonération de TVA, exportation", en: "VAT exemption, export" },
  "VATEX-EU-G": { fr: "Exonération de TVA, exportation", en: "VAT exemption, export" },
  "VATEX-EU-IC": { fr: "Exonération TVA, livraison intracommunautaire", en: "VAT exemption, intra-EU supply" },
  "VATEX-FR-AE": { fr: "Autoliquidation", en: "Reverse charge" },
  "VATEX-EU-AE": { fr: "Autoliquidation", en: "Reverse charge" },
  AE: { fr: "Autoliquidation", en: "Reverse charge" },
};

function appendVatLegalDetails(baseLabel: string, line: any, language: "fr" | "en") {
  const label = String(baseLabel || "").trim();
  if (!label) return "";
  void language;
  const code = normalizeVatReasonCode(lineExemptionReasonCode(line));
  if (!code) return label;
  if (VAT_ZERO_REASON_LABELS[code]) return label;
  if (/293\s*B/.test(code)) return label;
  if (/(AUTOLIQ|REVERSE)/.test(code)) return label;
  if (label.toUpperCase().includes(code)) return label;
  return `${label} - ${code}`;
}

function vatLabelLanguage(copy: { vatExempt: string }) {
  return /VAT|French CGI/i.test(copy.vatExempt) ? "en" : "fr";
}

function normalizeVatReasonCode(value: any) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function companyVatExemptionNotice(company: any, copy: { vatExempt: string }) {
  const vatNumber = String(company?.vat_number || "").trim();
  const exemptionNotice = String(company?.vat_exemption_notice || "").trim();
  if (isVatFranchiseRegime(company?.vat_regime) || (exemptionNotice && !vatNumber)) {
    return withFinalPeriod(exemptionNotice || copy.vatExempt);
  }
  return "";
}

function lineVatReasonLabel(line: any, company: any, copy: { vatExempt: string }) {
  if (String(line?.line_type || "item") !== "item") return "";
  const language = vatLabelLanguage(copy);
  const rate = numberInputValue(line?.vat_rate);
  const rawCategory = normalizeVatReasonCode(line?.vat_category);
  const category = rawCategory || "S";
  const code = normalizeVatReasonCode(lineExemptionReasonCode(line));
  if (rate !== 0 && category === "S" && !code) return "";
  if ((rate === 0 || category !== "S") && !code) {
    return language === "en" ? "VAT 0 reason to specify" : "Motif TVA 0 à préciser";
  }
  const companyExemption = companyVatExemptionNotice(company, copy);
  if (companyExemption && code === "VATEX-FR-FRANCHISE") return appendVatLegalDetails(companyExemption, line, language);
  const localized = (key: string) => VAT_ZERO_REASON_LABELS[key]?.[language] || "";
  if (code && localized(code)) return appendVatLegalDetails(localized(code), line, language);
  if (code && /293\s*B/.test(code)) return appendVatLegalDetails(localized("VATEX-FR-FRANCHISE"), line, language);
  if (code && /(AUTOLIQ|REVERSE)/.test(code)) return appendVatLegalDetails(localized("AE"), line, language);
  if (code) {
    if (category === "AE") return appendVatLegalDetails(localized("AE"), line, language);
    if (category === "O")
      return appendVatLegalDetails(language === "en" ? "VAT not applicable" : "TVA non applicable", line, language);
    if (category === "Z")
      return appendVatLegalDetails(language === "en" ? "Zero-rated VAT" : "TVA à taux zéro", line, language);
    return appendVatLegalDetails(language === "en" ? "VAT exemption" : "Exonération de TVA", line, language);
  }
  if (category === "AE") return appendVatLegalDetails(localized("AE"), line, language);
  if (category === "O")
    return appendVatLegalDetails(
      language === "en" ? "VAT not applicable - outside scope" : "TVA non applicable - opération hors champ",
      line,
      language,
    );
  if (category === "Z")
    return appendVatLegalDetails(language === "en" ? "Zero-rated VAT" : "TVA à taux zéro", line, language);
  if (category === "E")
    return appendVatLegalDetails(language === "en" ? "VAT exemption" : "Exonération de TVA", line, language);
  return "";
}

function companyVatLegalLine(
  company: any,
  copy: { vatExempt: string; vatDebit: string; vatCash: string },
  sourceLines: any[] = [],
) {
  const companyExemption = companyVatExemptionNotice(company, copy);
  const hasStandardTaxableLine = sourceLines.some(
    (line) =>
      String(line?.line_type || "item") === "item" &&
      normalizeVatReasonCode(line?.vat_category || "S") === "S" &&
      numberInputValue(line?.vat_rate) !== 0,
  );
  const zeroVatLabels: string[] = [];
  sourceLines.forEach((line) => {
    if (String(line?.line_type || "item") !== "item") return;
    const label = lineVatReasonLabel(line, company, copy);
    if (/motif tva 0 à préciser|vat 0 reason to specify/i.test(label)) return;
    if (label && !zeroVatLabels.includes(label)) zeroVatLabels.push(label);
  });
  if (zeroVatLabels.length) {
    return withFinalPeriod(zeroVatLabels.join(", "));
  }
  if (companyExemption && !hasStandardTaxableLine) {
    return companyExemption;
  }
  return company?.vat_on_debits ? copy.vatDebit : "";
}

function isSpecialVatLegalLine(value: string) {
  const normalized = String(value || "")
    .trim()
    .replace(/[.!?]+$/, "")
    .toLowerCase();
  return Boolean(
    normalized &&
    ![
      "tva sur les débits",
      "tva sur les debits",
      "tva sur les encaissements",
      "tva acquittée d'après les débits",
      "tva acquittée d’après les débits",
      "vat on debits",
      "vat payable according to debits",
      "vat due on payments received",
    ].includes(normalized),
  );
}

function ensureVatLegalLineInText(text: string, vatLine: string) {
  const cleaned = String(text || "").trim();
  if (!cleaned || !isSpecialVatLegalLine(vatLine)) return cleaned;
  const normalizedText = cleaned.toLowerCase();
  const normalizedVat = vatLine.replace(/[.!?]+$/, "").toLowerCase();
  if (normalizedText.includes(normalizedVat)) {
    return cleaned;
  }
  return `${vatLine} ${cleaned}`.trim();
}

function quoteLegalDiscountTextValue(value: any, language: "fr" | "en") {
  const trimmed = String(value || "").trim();
  const legacyDefaults = new Set([
    "pour frais de recouvrement. Signature précédée de la mention “Bon pour accord”.",
    'apply. Signature must be preceded by "Approved".',
  ]);
  if (trimmed && !legacyDefaults.has(trimmed)) return trimmed;
  return language === "en"
    ? "apply. Quote acceptance records customer approval."
    : "pour frais de recouvrement. L’acceptation du devis vaut accord du client.";
}

function documentFooterLegalNote(company: any, isInvoice: boolean, form?: any) {
  const customFooterText = normalizeLegalFooterText(form?.legal_footer_text);
  const language = String(form?.document_language || form?.template_options?.document_language || "fr")
    .trim()
    .toLowerCase()
    .startsWith("en")
    ? "en"
    : "fr";
  const copy = DOCUMENT_COPY[language];
  if (isInvoice) {
    const vatLine = companyVatLegalLine(company, copy, form?.lines || []);
    if (customFooterText.trim()) return ensureVatLegalLineInText(customFooterText.trim(), vatLine);
    const penaltyRate = String(form?.legal_penalty_rate || "10").trim() || "10";
    const recoveryFee = String(form?.legal_recovery_fee || "40").trim() || "40";
    const penaltyPrefix = String(form?.legal_penalty_prefix || "").trim() || `${vatLine} ${copy.latePenaltyPrefix}`;
    const recoveryPrefix = String(form?.legal_recovery_prefix || "").trim() || copy.recoveryPrefix;
    const discountText = String(form?.legal_discount_text || "").trim() || copy.earlyDiscount;
    return `${penaltyPrefix} ${penaltyRate} % ${recoveryPrefix} ${recoveryFee} € ${discountText}`.trim();
  }
  const vatLine = companyVatLegalLine(company, copy, form?.lines || []);
  const stripQuoteValidity = (value: string) => {
    const validityPattern =
      language === "en" ? /(^|\s)Quote valid until [^.]*\./i : /(^|\s)Devis valable jusqu['’]au [^.]*\./i;
    const acceptancePattern =
      language === "en"
        ? /(^|\s)After acceptance, payment is due under the stated terms[^.]*\./i
        : /(^|\s)Après acceptation du devis, le règlement intervient selon les conditions indiquées[^.]*\./i;
    return value
      .replace(validityPattern, " ")
      .replace(acceptancePattern, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  };
  if (customFooterText.trim()) return stripQuoteValidity(ensureVatLegalLineInText(customFooterText, vatLine));
  const vatPrefix = isSpecialVatLegalLine(vatLine) ? `${vatLine} ` : "";
  const penaltyRate = String(form?.legal_penalty_rate || "10").trim() || "10";
  const recoveryFee = String(form?.legal_recovery_fee || "40").trim() || "40";
  const discountText = quoteLegalDiscountTextValue(form?.legal_discount_text, language);
  return (
    vatPrefix +
    (language === "en"
      ? "No early payment discount applies. In case of late payment on an agreed due date, penalties of " +
        penaltyRate +
        "% and a fixed recovery fee of " +
        recoveryFee +
        " EUR " +
        discountText
      : "Aucun escompte n'est accordé en cas de paiement anticipé. En cas de retard sur une échéance de paiement convenue, des pénalités au taux de " +
        penaltyRate +
        " % seront exigibles, ainsi qu'une indemnité forfaitaire de " +
        recoveryFee +
        " € " +
        discountText)
  );
}

function normalizeLine(line: any, fallbackAccountingAccount?: any) {
  const lineType = ["title", "comment"].includes(String(line?.line_type || "").toLowerCase())
    ? String(line?.line_type || "").toLowerCase()
    : "item";
  const label = String(line?.product_name || "").trim();
  if (lineType !== "item") {
    const detail = String(line?.detail || "").trim();
    const cleanLabel = label === "Commentaire..." || label === "Commentaire" ? "" : label;
    const text = lineType === "title" ? label || "Titre de section" : detail || cleanLabel;
    return {
      line_type: lineType,
      display_number:
        String(line?.display_number || "")
          .trim()
          .slice(0, 24) || null,
      reference:
        String(line?.reference || "")
          .trim()
          .slice(0, 80) || null,
      product_name: text,
      detail: lineType === "comment" ? text : detail,
      quantity: 0,
      unit_price: 0,
      vat_rate: 0,
      vat_category: "S",
      exemption_reason_code: null,
      unit_code: "C62",
      item_id: null,
      accounting_account: null,
    };
  }
  return {
    line_type: "item",
    display_number:
      String(line?.display_number || "")
        .trim()
        .slice(0, 24) || null,
    reference:
      String(line?.reference || "")
        .trim()
        .slice(0, 80) || null,
    product_name: label,
    detail: String(line?.detail || "").trim() || null,
    quantity: numberInputValue(line?.quantity),
    unit_price: lineBaseUnitPrice(line),
    vat_rate: numberInputValue(line?.vat_rate),
    vat_category: lineVatCategory(line),
    exemption_reason_code: lineExemptionReasonCode(line),
    unit_code: lineUnitCode(line),
    item_id: line?.item_id || null,
    accounting_account:
      sanitizeAccountingAccount(line?.accounting_account) ||
      sanitizeAccountingAccount(fallbackAccountingAccount) ||
      null,
  };
}

function roundMoney(value: any) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function buildDepositSeedFromQuote(quote: any, percent: number, fallbackVatRate = 20) {
  const ratio = Math.min(0.95, Math.max(0.05, Number(percent || 30) / 100));
  const reference = quote?.number || quote?.id || "devis";
  const sourceLines = Array.isArray(quote?.lines) ? quote.lines : [];
  const groupedBases = new Map<
    string,
    { vat_rate: number; vat_category: string; exemption_reason_code: string | null; base: number }
  >();

  if (sourceLines.length) {
    sourceLines.forEach((line: any) => {
      const vatRate = Number.isFinite(Number(line?.vat_rate)) ? Number(line?.vat_rate) : Number(fallbackVatRate || 20);
      const vatCategory = lineVatCategory(line);
      const exemptionReason = lineExemptionReasonCode(line);
      const lineBase = Number.isFinite(Number(line?.line_total))
        ? Number(line?.line_total)
        : Number(line?.quantity || 0) * Number(line?.unit_price || 0);
      const key = `${vatRate}|${vatCategory}|${exemptionReason || ""}`;
      const current = groupedBases.get(key) || {
        vat_rate: vatRate,
        vat_category: vatCategory,
        exemption_reason_code: exemptionReason,
        base: 0,
      };
      current.base = roundMoney((current.base || 0) + lineBase);
      groupedBases.set(key, current);
    });
  } else {
    const vatRate = Number(fallbackVatRate || 20);
    groupedBases.set(`${vatRate}|${defaultVatCategoryForRate(vatRate)}|`, {
      vat_rate: vatRate,
      vat_category: defaultVatCategoryForRate(vatRate),
      exemption_reason_code: null,
      base: roundMoney(quote?.total_ex_vat || 0),
    });
  }

  const seeds = Array.from(groupedBases.values())
    .filter((entry) => Number(entry.base || 0) > 0)
    .map((entry, index, entries) => ({
      id: uid(),
      product_name:
        entries.length === 1
          ? `Acompte ${percent}% · ${reference}`
          : `Acompte ${percent}% · TVA ${entry.vat_rate}% · ${reference}`,
      quantity: 1,
      unit_price: roundMoney(Number(entry.base || 0) * ratio),
      vat_rate: Number.isFinite(Number(entry.vat_rate)) ? Number(entry.vat_rate) : Number(fallbackVatRate || 20),
      vat_category: entry.vat_category,
      exemption_reason_code: entry.exemption_reason_code,
      unit_code: "C62",
    }));

  return seeds.length ? seeds : [emptyLine()];
}

function buildDocumentNote(form: any, _company?: any, _isInvoice = false) {
  const note = String(form?.note || "").trim();
  const freeText = String(form?.legal_mentions_text || "").trim();
  const parts: string[] = [];
  if (note) parts.push(note);
  if (freeText && !parts.includes(freeText)) parts.push(freeText);
  return parts.join("\n\n") || null;
}

function cleanBic(value: any) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizedInvoiceEditStatus(invoice: any) {
  return String(invoice?.status ?? invoice?.state ?? invoice?.document_status ?? invoice?.workflow_status ?? "")
    .trim()
    .toLowerCase();
}

function isEditableDraftInvoice(invoice: any) {
  const status = normalizedInvoiceEditStatus(invoice);
  return status === "draft" || status === "brouillon";
}

function invoiceStatusDisplay(status: string) {
  const labels: Record<string, string> = {
    draft: "Brouillon",
    sent: "Envoyée",
    issued: "Émise",
    paid: "Payée",
    overdue: "En retard",
    canceled: "Annulée",
    cancelled: "Annulée",
    partially_paid: "Partiellement payée",
    partial_paid: "Partiellement payée",
    brouillon: "Brouillon",
  };
  return labels[status] || status || "finalisée";
}

export function InvoiceDocumentEditor({ mode, backHref }: { mode: "invoice" | "quote"; backHref: string }) {
  const { capabilities, subscriptionStatus } = useSession({ autoRefresh: false });
  const trialDraftOnly = isTrialSubscription(subscriptionStatus);
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);
  const seqinoOperational = einvoicingEnabled && Boolean(capabilities?.seqino_operational);
  const router = useRouter();
  const searchParams = useSearchParams();
  const isInvoice = mode === "invoice";
  const localDocumentTemplateKind = isInvoice ? "invoice" : "quote";
  const documentLegalTemplateKind: DocumentLegalTemplateKind = isInvoice ? "invoice" : "quote";
  const fromQuote = isInvoice ? searchParams.get("from_quote") : null;
  const editInvoiceId = isInvoice ? searchParams.get("edit_invoice") : null;
  const editQuoteId = !isInvoice ? searchParams.get("edit_quote") : null;
  const isEditingExistingInvoice = isInvoice && Boolean(editInvoiceId);
  const isEditingExistingQuote = !isInvoice && Boolean(editQuoteId);
  const isEditingExistingDocument = isEditingExistingInvoice || isEditingExistingQuote;
  const customerSeed = searchParams.get("customer_id") || "";
  const itemSeed = searchParams.get("item_id") || "";
  const smartPrefill = searchParams.get("prefill") === "smart";
  const sourceQuoteId = isInvoice ? searchParams.get("source_quote") : null;
  const sourceSeed = isInvoice ? searchParams.get("seed") : null;
  const depositPercent = isInvoice
    ? Math.min(90, Math.max(5, Number(searchParams.get("deposit_percent") || "30") || 30))
    : 30;
  const draftScope = isEditingExistingDocument
    ? `edit:${editInvoiceId || editQuoteId}`
    : `new:${customerSeed || "global"}:${itemSeed || "blank"}`;
  const storageKey = `${STORAGE_PREFIX}:${mode}:${draftScope}`;
  const recentKey = `${RECENT_PREFIX}:${mode}`;
  const documentTheme = isInvoice ? DOCUMENT_THEME.invoice : DOCUMENT_THEME.quote;
  const accentColor = documentTheme.accentColor;
  const accentLight = documentTheme.accentLight;
  const accentSubtle = documentTheme.accentSubtle;
  const accentBorder = documentTheme.accentBorder;
  const editorBackHref = isEditingExistingInvoice
    ? `/app/invoices/${editInvoiceId}`
    : isEditingExistingQuote
      ? `/app/quotes/${editQuoteId}`
      : backHref;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitIntent, setSubmitIntent] = useState<"draft" | "issue" | null>(null);
  const [convertingQuote, setConvertingQuote] = useState(Boolean(fromQuote));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lockedInvoiceToEdit, setLockedInvoiceToEdit] = useState<any>(null);
  const [editingDocumentStatus, setEditingDocumentStatus] = useState<string>("");
  const [autosavedAt, setAutosavedAt] = useState<string | null>(null);
  const [seedContext, setSeedContext] = useState<any>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogPanelTargetLineId, setCatalogPanelTargetLineId] = useState<string | null>(null);
  const [catalogFilterMode, setCatalogFilterMode] = useState<CatalogFilterMode>("active");
  const [catalogEditorOpen, setCatalogEditorOpen] = useState(false);
  const [catalogEditingItemId, setCatalogEditingItemId] = useState<string | null>(null);
  const [catalogEditorTouched, setCatalogEditorTouched] = useState(false);
  const [catalogEditorBusy, setCatalogEditorBusy] = useState(false);
  const [catalogQuickCreateLineId, setCatalogQuickCreateLineId] = useState<string | null>(null);
  const [catalogEditorError, setCatalogEditorError] = useState<string | null>(null);
  const [catalogItemForm, setCatalogItemForm] = useState({
    name: "",
    description: "",
    unit_price: "",
    vat_rate: "20",
    unit_code: "",
    active: true,
  });
  const [customerQuery, setCustomerQuery] = useState("");
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  const [directoryEntry, setDirectoryEntry] = useState<any>(null);
  const [mobileAsideOpen, setMobileAsideOpen] = useState(false);
  const [documentDiscountOpen, setDocumentDiscountOpen] = useState(false);
  const [documentDiscountInputMode, setDocumentDiscountInputMode] = useState<"percent" | "amount">("percent");
  const [documentDiscountAmountInput, setDocumentDiscountAmountInput] = useState("");
  const [lineDiscountsEnabled, setLineDiscountsEnabled] = useState(false);
  const [globalVatEnabled, setGlobalVatEnabled] = useState(false);
  const [globalVatDraft, setGlobalVatDraft] = useState({ ...DEFAULT_GLOBAL_VAT_DRAFT });
  const [advancedComplianceEnabled, setAdvancedComplianceEnabled] = useState(false);
  const [discountChoiceOpen, setDiscountChoiceOpen] = useState(false);
  const [discountHideMenuOpen, setDiscountHideMenuOpen] = useState(false);
  const [lineAddMenuOpen, setLineAddMenuOpen] = useState(false);
  const [lineColumnsMenuOpen, setLineColumnsMenuOpen] = useState(false);
  const [depositActionMenuOpen, setDepositActionMenuOpen] = useState(false);
  const [depositInvoiceMenuOpen, setDepositInvoiceMenuOpen] = useState(false);
  const [catalogLineMenuOpenId, setCatalogLineMenuOpenId] = useState<string | null>(null);
  const [lineColumnVisibility, setLineColumnVisibility] = useState<LineColumnVisibility>(() =>
    loadLineColumnVisibility(),
  );
  const [lineComplianceOpenIds, setLineComplianceOpenIds] = useState<string[]>([]);
  const [lineAccountingCustomOpenIds, setLineAccountingCustomOpenIds] = useState<string[]>([]);
  const clientInfoVisibility = useMemo<Record<ClientInfoVisibilityKey, boolean>>(
    () => ({
      address: true,
      email: true,
      phone: true,
      identity: true,
    }),
    [],
  );
  const [partyEditSection, setPartyEditSection] = useState<PartyEditSection | null>(null);
  const [partyEditDraft, setPartyEditDraft] = useState<Record<string, string>>({});
  const [savingPartyInfo, setSavingPartyInfo] = useState(false);
  const [focusedComplianceField, setFocusedComplianceField] = useState<string | null>(null);
  const [unitCodeMenuOpenId, setUnitCodeMenuOpenId] = useState<string | null>(null);
  const [activeCompactPanel, setActiveCompactPanel] = useState<"clients" | "catalog" | null>(null);
  const [sideOptionOpen, setSideOptionOpen] = useState<SideOptionId | null>(null);
  const [sideOptionsCollapsed, setSideOptionsCollapsed] = useState(false);
  const [documentModelOptions, setDocumentModelOptions] = useState<any[]>([]);
  const [documentModelQuery, setDocumentModelQuery] = useState("");
  const [documentModelPickerOpen, setDocumentModelPickerOpen] = useState(false);
  const [applyingDocumentModel, setApplyingDocumentModel] = useState(false);
  const [localDocumentTemplates, setLocalDocumentTemplates] = useState<any[]>([]);
  const [selectedLocalTemplateId, setSelectedLocalTemplateId] = useState("");
  const [localTemplateName, setLocalTemplateName] = useState("");
  const [paymentPreset, setPaymentPreset] = useState("30");
  const [paymentMenuOpen, setPaymentMenuOpen] = useState(false);
  const [paymentMethodsMenuOpen, setPaymentMethodsMenuOpen] = useState(false);
  const [tenantFeatures, setTenantFeatures] = useState<any>(null);
  const [legalTemplateMenuOpen, setLegalTemplateMenuOpen] = useState(false);
  const [legalTemplateSaving, setLegalTemplateSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [deletingLogo, setDeletingLogo] = useState(false);
  const compactScrollRef = useRef<HTMLDivElement | null>(null);
  const clientChoiceRef = useRef<HTMLDivElement | null>(null);
  const paymentMenuRef = useRef<HTMLDivElement | null>(null);
  const lineColumnsMenuRef = useRef<HTMLDivElement | null>(null);
  const bankEditorRef = useRef<HTMLDivElement | null>(null);
  const depositActionMenuRef = useRef<HTMLDivElement | null>(null);
  const depositInvoicePickerRef = useRef<HTMLDivElement | null>(null);
  const legalTemplateMenuRef = useRef<HTMLDivElement | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextAutosaveRef = useRef(false);
  const catalogLineMenuCloseTimerRef = useRef<number | null>(null);
  const [company, setCompany] = useState<any>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [catalogItems, setCatalogItems] = useState<any[]>([]);
  const [recentLines, setRecentLines] = useState<any[]>([]);
  const [recentCustomerIds, setRecentCustomerIds] = useState<string[]>([]);
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [form, setForm] = useState<any>(() => createInitialDocumentForm(customerSeed));
  const [lines, setLines] = useState<any[]>([emptyLine()]);
  const selectedCustomer = useMemo(
    () => customers.find((item) => item.id === form.customer_id) || null,
    [customers, form.customer_id],
  );
  const companyVatFranchise = isCompanyVatFranchise(company);
  const hasProtectedLocalDraft = useMemo(() => {
    if (!autosavedAt || saving || submitIntent) return false;
    const hasMeaningfulLine = lines.some((line: any) => {
      const text = [
        line?.reference,
        line?.product_name,
        line?.description,
        line?.comment,
        line?.name,
        lineCommentText(line),
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" ");
      const amount = Number(line?.unit_price ?? line?.price ?? line?.amount ?? 0);
      return Boolean(text) || (Number.isFinite(amount) && amount !== 0);
    });
    const hasMeaningfulForm = Boolean(
      String(form?.customer_id || "").trim() ||
      String(form?.document_title || "").trim() ||
      String(form?.note || "").trim() ||
      String(form?.purchase_order_number || "").trim() ||
      String(form?.delivery_address || "").trim(),
    );
    return hasMeaningfulLine || hasMeaningfulForm;
  }, [autosavedAt, form, lines, saving, submitIntent]);
  const [lineActionMenuOpenId, setLineActionMenuOpenId] = useState<string | null>(null);
  const clearCatalogLineMenuCloseTimer = useCallback(() => {
    if (catalogLineMenuCloseTimerRef.current !== null) {
      window.clearTimeout(catalogLineMenuCloseTimerRef.current);
      catalogLineMenuCloseTimerRef.current = null;
    }
  }, []);
  const openLineCatalogMenu = useCallback(
    (lineId: string) => {
      clearCatalogLineMenuCloseTimer();
      setCatalogLineMenuOpenId(lineId);
    },
    [clearCatalogLineMenuCloseTimer],
  );
  const closeLineCatalogMenu = useCallback(() => {
    clearCatalogLineMenuCloseTimer();
    setCatalogLineMenuOpenId(null);
  }, [clearCatalogLineMenuCloseTimer]);
  const scheduleLineCatalogMenuClose = useCallback(
    (lineId: string) => {
      clearCatalogLineMenuCloseTimer();
      catalogLineMenuCloseTimerRef.current = window.setTimeout(() => {
        setCatalogLineMenuOpenId((openId) => (openId === lineId ? null : openId));
        catalogLineMenuCloseTimerRef.current = null;
      }, 320);
    },
    [clearCatalogLineMenuCloseTimer],
  );
  const [draggedLineId, setDraggedLineId] = useState<string | null>(null);
  const [lineDragTarget, setLineDragTarget] = useState<{
    id: string;
    placement: "before" | "after";
  } | null>(null);
  const [depositPanelOpen, setDepositPanelOpen] = useState(false);
  const [depositDraft, setDepositDraft] = useState({
    reference: "",
    amount_ht: "",
    vat_rate: "20",
    invoice_id: "",
    quote_id: "",
    customer_id: "",
    currency: "",
  });
  const [depositInvoiceOptions, setDepositInvoiceOptions] = useState<any[]>([]);
  const [noInvoiceDepositOpen, setNoInvoiceDepositOpen] = useState(false);
  const [noInvoiceDepositDraft, setNoInvoiceDepositDraft] = useState({
    reference: "",
    percent: "",
    amount_ttc: "0,00",
    vat_rate: "20",
  });
  const [noInvoiceDepositInputMode, setNoInvoiceDepositInputMode] = useState<"percent" | "amount">("percent");
  const [bankEditorOpen, setBankEditorOpen] = useState(false);
  const [bankDraft, setBankDraft] = useState({
    id: "",
    label: "Coordonnées principales",
    iban: "",
    bic: "",
    is_default: false,
  });
  const [bankDetailsError, setBankDetailsError] = useState<string | null>(null);
  const [savingBankDetails, setSavingBankDetails] = useState(false);
  const legalConfig = useMemo(() => {
    try {
      return getLegalConfig();
    } catch {
      return null;
    }
  }, []);
  const defaultAdvanceVatRate = useMemo(() => {
    if (companyVatFranchise) return "0";
    const rates = lines
      .filter((line) => String(line?.line_type || "item") === "item" && String(line?.product_name || "").trim())
      .map((line) => numberInputValue(line?.vat_rate))
      .filter((rate) => Number.isFinite(rate));
    if (rates.length && rates.every((rate) => Math.abs(rate - rates[0]) < 0.0001)) {
      return decimalInputValue(rates[0]);
    }
    const customerRate = Number(selectedCustomer?.default_vat_rate);
    if (Number.isFinite(customerRate)) return decimalInputValue(customerRate);
    return companyDefaultSalesVatRateInput(company) || "20";
  }, [company, companyVatFranchise, lines, selectedCustomer?.default_vat_rate]);
  const defaultAdvanceVatRateRef = useRef("20");
  useEffect(() => {
    defaultAdvanceVatRateRef.current = defaultAdvanceVatRate;
  }, [defaultAdvanceVatRate]);
  useEffect(() => () => clearCatalogLineMenuCloseTimer(), [clearCatalogLineMenuCloseTimer]);
  useEffect(() => {
    if (!companyVatFranchise) return;
    setGlobalVatEnabled(false);
    setGlobalVatDraft((prev) =>
      prev.vat_rate === VAT_FRANCHISE_GLOBAL_DRAFT.vat_rate &&
      prev.vat_category === VAT_FRANCHISE_GLOBAL_DRAFT.vat_category &&
      prev.exemption_reason_code === VAT_FRANCHISE_GLOBAL_DRAFT.exemption_reason_code
        ? prev
        : { ...VAT_FRANCHISE_GLOBAL_DRAFT },
    );
    setLineColumnVisibility((current) => (current.vat ? current : { ...current, vat: true }));
    setLines((prev) => {
      let changed = false;
      const next = prev.map((line) => {
        const normalized = franchiseVatLine(line);
        if (normalized !== line) changed = true;
        return normalized;
      });
      return changed ? next : prev;
    });
    setDepositDraft((prev) => (String(prev.vat_rate || "") === "0" ? prev : { ...prev, vat_rate: "0" }));
    setNoInvoiceDepositDraft((prev) => (String(prev.vat_rate || "") === "0" ? prev : { ...prev, vat_rate: "0" }));
  }, [companyVatFranchise]);
  const restoreAdvancePaymentState = useCallback(
    (templateOptions: any) => {
      const fallbackAdvanceVatRate = defaultAdvanceVatRateRef.current || "20";
      const advances = Array.isArray(templateOptions?.advance_payments) ? templateOptions.advance_payments : [];
      const invoiceAdvance = advances.find((entry: any) => {
        const source = String(entry?.source || "");
        return source !== "manual_advance_payment" && source !== "requested_advance";
      });
      const manualAdvance = advances.find((entry: any) => {
        const source = String(entry?.source || "");
        return isInvoice
          ? source === "manual_advance_payment"
          : source === "requested_advance" || source === "manual_advance_payment";
      });

      if (isInvoice && invoiceAdvance) {
        setDepositPanelOpen(true);
        setDepositDraft({
          reference: String(invoiceAdvance.reference || invoiceAdvance.label || ""),
          amount_ht: decimalInputValue(invoiceAdvance.amount_ht || 0),
          vat_rate: String(invoiceAdvance.vat_rate || fallbackAdvanceVatRate),
          invoice_id: String(invoiceAdvance.invoice_id || ""),
          quote_id: String(invoiceAdvance.quote_id || ""),
          customer_id: String(invoiceAdvance.customer_id || ""),
          currency: String(invoiceAdvance.currency || ""),
        });
      } else {
        setDepositPanelOpen(false);
        setDepositDraft({
          reference: "",
          amount_ht: "",
          vat_rate: fallbackAdvanceVatRate,
          invoice_id: "",
          quote_id: "",
          customer_id: "",
          currency: "",
        });
      }

      if (manualAdvance) {
        setNoInvoiceDepositOpen(true);
        setNoInvoiceDepositInputMode(manualAdvance.percent ? "percent" : "amount");
        setNoInvoiceDepositDraft({
          reference: String(manualAdvance.reference || ""),
          percent: manualAdvance.percent ? decimalInputValue(manualAdvance.percent) : "",
          amount_ttc: decimalInputValue(manualAdvance.amount_ttc || 0),
          vat_rate: String(manualAdvance.vat_rate || fallbackAdvanceVatRate),
        });
      } else {
        setNoInvoiceDepositOpen(false);
        setNoInvoiceDepositInputMode("percent");
        setNoInvoiceDepositDraft({ reference: "", percent: "", amount_ttc: "0,00", vat_rate: fallbackAdvanceVatRate });
      }
    },
    [isInvoice],
  );

  useEffect(() => {
    if (!fromQuote) {
      setConvertingQuote(false);
      return;
    }
    let cancelled = false;
    const convert = async () => {
      setConvertingQuote(true);
      setError(null);
      setNotice("Conversion du devis en facture en cours…");
      try {
        const result: any = await api(`/api/quotes/${fromQuote}/convert`, { method: "POST" });
        const invoiceId = result?.invoice_id;
        if (!invoiceId) throw new Error("Conversion réussie mais facture introuvable.");
        if (!cancelled) router.replace(`/app/invoices/${invoiceId}`);
      } catch (err) {
        if (!cancelled) {
          setError(formatApiError(err, "Conversion du devis impossible."));
          setNotice(null);
          setConvertingQuote(false);
        }
      }
    };
    void convert();
    return () => {
      cancelled = true;
    };
  }, [fromQuote, router]);

  useEffect(() => {
    let cancelled = false;
    const loadData = async () => {
      setLoading(true);
      setError(null);
      setLockedInvoiceToEdit(null);
      try {
        let customersPayload: any[] = [];
        let catalogItemsPayload: any[] = [];
        let recentLinesPayload: any[] = [];
        let bankAccountsPayload: any[] = [];
        let tenantFeaturesPayload: any = null;
        let companyPayload: any = null;
        let invoiceEditLocked = false;
        const [
          companyRes,
          tenantSettingsRes,
          bankAccountsRes,
          customersRes,
          itemsRes,
          sourceQuoteRes,
          editQuoteRes,
          editInvoiceRes,
          depositInvoicesRes,
          modelDocumentsRes,
        ] = await Promise.allSettled([
          rawApi("/api/company/profile"),
          rawApi("/api/settings/tenant"),
          rawApi("/api/company/bank-accounts"),
          rawApi("/api/customers?limit=200&offset=0"),
          rawApi("/api/items?include_inactive=true"),
          sourceQuoteId ? rawApi(`/api/quotes/${sourceQuoteId}`) : Promise.resolve(null),
          editQuoteId ? rawApi(`/api/quotes/${editQuoteId}`) : Promise.resolve(null),
          editInvoiceId ? rawApi(`/api/cockpit/invoices/${editInvoiceId}`) : Promise.resolve(null),
          rawApi("/api/invoices?limit=100&offset=0&invoice_kind=deposit"),
          rawApi(isInvoice ? "/api/invoices?limit=100&offset=0" : "/api/quotes?limit=100&offset=0"),
        ]);

        if (cancelled) return;

        if (companyRes.status === "fulfilled" && companyRes.value.ok) {
          companyPayload = await companyRes.value.json().catch(() => null);
          setCompany(companyPayload);
        } else {
          setCompany(null);
        }

        if (tenantSettingsRes.status === "fulfilled" && tenantSettingsRes.value.ok) {
          const payload = await tenantSettingsRes.value.json().catch(() => null);
          tenantFeaturesPayload = payload?.features || null;
          setTenantFeatures(tenantFeaturesPayload);
        } else {
          tenantFeaturesPayload = null;
          setTenantFeatures(null);
        }

        if (bankAccountsRes.status === "fulfilled" && bankAccountsRes.value.ok) {
          const payload = await bankAccountsRes.value.json().catch(() => []);
          bankAccountsPayload = Array.isArray(payload) ? payload : [];
          setBankAccounts(bankAccountsPayload);
          setSelectedBankAccountId((current) => {
            const currentAccount = bankAccountsPayload.find((account: any) => account?.id === current);
            const defaultAccount =
              bankAccountsPayload.find((account: any) => account?.is_default) || bankAccountsPayload[0] || null;
            return currentAccount?.id || defaultAccount?.id || "";
          });
        } else {
          bankAccountsPayload = [];
          setBankAccounts([]);
          setSelectedBankAccountId("");
        }

        if (customersRes.status === "fulfilled" && customersRes.value.ok) {
          const payload = await customersRes.value.json().catch(() => []);
          customersPayload = Array.isArray(payload) ? payload : [];
          setCustomers(customersPayload);
        } else {
          customersPayload = [];
          setCustomers([]);
        }

        if (depositInvoicesRes.status === "fulfilled" && depositInvoicesRes.value?.ok) {
          const payload = await depositInvoicesRes.value.json().catch(() => []);
          setDepositInvoiceOptions(
            Array.isArray(payload)
              ? payload.filter((invoice: any) => {
                  const status = String(invoice?.status || "").toLowerCase();
                  const kind = String(invoice?.invoice_kind || "").toLowerCase();
                  return kind === "deposit" && !["draft", "canceled", "cancelled"].includes(status);
                })
              : [],
          );
        } else {
          setDepositInvoiceOptions([]);
        }

        if (modelDocumentsRes.status === "fulfilled" && modelDocumentsRes.value?.ok) {
          const payload = await modelDocumentsRes.value.json().catch(() => []);
          const currentDocumentId = editInvoiceId || editQuoteId || "";
          setDocumentModelOptions(
            (Array.isArray(payload) ? payload : [])
              .filter((document: any) => document?.id && document.id !== currentDocumentId)
              .slice(0, 100),
          );
        } else {
          setDocumentModelOptions([]);
        }

        if (itemsRes.status === "fulfilled" && itemsRes.value.ok) {
          const payload = await itemsRes.value.json().catch(() => []);
          catalogItemsPayload = Array.isArray(payload) ? payload : [];
          setCatalogItems(catalogItemsPayload);
        } else {
          catalogItemsPayload = [];
          setCatalogItems([]);
        }

        if (typeof window !== "undefined") {
          try {
            const recentRaw = window.localStorage.getItem(recentKey);
            const parsed = recentRaw ? JSON.parse(recentRaw) : [];
            recentLinesPayload = Array.isArray(parsed) ? parsed : [];
            setRecentLines(recentLinesPayload);
          } catch {
            recentLinesPayload = [];
            setRecentLines([]);
          }

          try {
            const templatesRaw = window.localStorage.getItem(LOCAL_DOCUMENT_TEMPLATES_STORAGE_KEY);
            const parsedTemplates = templatesRaw ? JSON.parse(templatesRaw) : [];
            const legacyRaw = window.localStorage.getItem(LOCAL_DOCUMENT_TEMPLATE_STORAGE_KEY);
            const legacyTemplate = legacyRaw ? JSON.parse(legacyRaw) : null;
            const normalizedTemplates = Array.isArray(parsedTemplates)
              ? parsedTemplates
                  .filter((entry: any) => entry?.id && entry?.payload)
                  .map((entry: any) => ({
                    ...entry,
                    kind: entry.kind || entry.payload?.kind || entry.payload?.document_kind || "",
                  }))
                  .filter((entry: any) => entry.kind === localDocumentTemplateKind)
              : [];
            const hasBaseTemplate = normalizedTemplates.some((entry: any) => entry?.id === "base");
            const legacyKind = legacyTemplate?.kind || legacyTemplate?.document_kind || legacyTemplate?.mode || "";
            setLocalDocumentTemplates(
              legacyTemplate && legacyKind === localDocumentTemplateKind && !hasBaseTemplate
                ? [
                    {
                      id: "base",
                      name: "Modèle de base",
                      kind: localDocumentTemplateKind,
                      saved_at: legacyTemplate.saved_at || new Date().toISOString(),
                      payload: legacyTemplate,
                    },
                    ...normalizedTemplates,
                  ]
                : normalizedTemplates,
            );
          } catch {
            setLocalDocumentTemplates([]);
          }

          try {
            const recentCustomersRaw = window.localStorage.getItem(RECENT_CUSTOMERS_PREFIX);
            const parsedCustomers = recentCustomersRaw ? JSON.parse(recentCustomersRaw) : [];
            setRecentCustomerIds(Array.isArray(parsedCustomers) ? parsedCustomers.filter(Boolean) : []);
          } catch {
            setRecentCustomerIds([]);
          }

          const restoreLocalDraft = () => {
            try {
              const raw = window.localStorage.getItem(storageKey);
              if (!raw) return false;
              const parsed = JSON.parse(raw);
              if (!parsed || parsed.version !== CURRENT_DRAFT_VERSION || typeof parsed !== "object") {
                window.localStorage.removeItem(storageKey);
                return false;
              }

              if (parsed.form && typeof parsed.form === "object") {
                setForm((prev: any) => ({ ...prev, ...parsed.form }));
              }
              if (parsed.lineColumnVisibility || parsed.form?.template_options?.line_columns) {
                setLineColumnVisibility(
                  normalizeLineColumnVisibility(
                    parsed.lineColumnVisibility || parsed.form.template_options.line_columns,
                  ),
                );
              }
              if (Array.isArray(parsed.lines) && parsed.lines.length > 0) {
                setLines(splitInlineItemComments(parsed.lines));
              }
              if (typeof parsed.paymentPreset === "string") {
                setPaymentPreset(parsed.paymentPreset);
              }
              if (typeof parsed.selectedBankAccountId === "string") {
                setSelectedBankAccountId(parsed.selectedBankAccountId);
              }
              setDocumentDiscountOpen(Boolean(parsed.documentDiscountOpen));
              setDocumentDiscountInputMode(parsed.documentDiscountInputMode === "amount" ? "amount" : "percent");
              setDocumentDiscountAmountInput(String(parsed.documentDiscountAmountInput || ""));
              setLineDiscountsEnabled(Boolean(parsed.lineDiscountsEnabled));
              setGlobalVatEnabled(Boolean(parsed.globalVatEnabled));
              setGlobalVatDraft(normalizeGlobalVatDraft(parsed.globalVatDraft));
              setAdvancedComplianceEnabled(Boolean(parsed.advancedComplianceEnabled));
              setLineComplianceOpenIds(Array.isArray(parsed.lineComplianceOpenIds) ? parsed.lineComplianceOpenIds : []);
              setDepositPanelOpen(Boolean(parsed.depositPanelOpen));
              if (parsed.depositDraft && typeof parsed.depositDraft === "object") {
                setDepositDraft({
                  reference: String(parsed.depositDraft.reference || ""),
                  amount_ht: String(parsed.depositDraft.amount_ht || ""),
                  vat_rate: String(parsed.depositDraft.vat_rate || defaultAdvanceVatRateRef.current || "20"),
                  invoice_id: String(parsed.depositDraft.invoice_id || ""),
                  quote_id: String(parsed.depositDraft.quote_id || ""),
                  customer_id: String(parsed.depositDraft.customer_id || ""),
                  currency: String(parsed.depositDraft.currency || ""),
                });
              }
              setDepositInvoiceMenuOpen(false);
              setNoInvoiceDepositOpen(Boolean(parsed.noInvoiceDepositOpen));
              setNoInvoiceDepositInputMode(parsed.noInvoiceDepositInputMode === "amount" ? "amount" : "percent");
              if (parsed.noInvoiceDepositDraft && typeof parsed.noInvoiceDepositDraft === "object") {
                setNoInvoiceDepositDraft({
                  reference: String(parsed.noInvoiceDepositDraft.reference || ""),
                  percent: String(parsed.noInvoiceDepositDraft.percent || ""),
                  amount_ttc: String(parsed.noInvoiceDepositDraft.amount_ttc || "0,00"),
                  vat_rate: String(parsed.noInvoiceDepositDraft.vat_rate || defaultAdvanceVatRateRef.current || "20"),
                });
              }
              setCustomerQuery("");
              setClientDropdownOpen(false);
              setAutosavedAt(typeof parsed.saved_at === "string" ? parsed.saved_at : null);
              setNotice((current) => current || "Brouillon local restauré.");
              return true;
            } catch {
              window.localStorage.removeItem(storageKey);
              return false;
            }
          };

          if (!fromQuote && !sourceQuoteId && !editQuoteId && !editInvoiceId) {
            const restoredLocalDraft = restoreLocalDraft();
            if (!restoredLocalDraft) {
              skipNextAutosaveRef.current = true;
              setForm(
                applyDocumentLegalTemplateToForm(
                  createInitialDocumentForm(customerSeed),
                  getDocumentLegalTemplate(tenantFeaturesPayload, documentLegalTemplateKind),
                ),
              );
              const customerMatch = customersPayload.find((entry: any) => entry?.id === customerSeed);
              const fallbackVatRate = defaultSalesVatRateNumber(companyPayload, customerMatch);
              const itemMatch = itemSeed ? catalogItemsPayload.find((entry: any) => entry?.id === itemSeed) : null;
              const recentLineMatch = smartPrefill
                ? recentLinesPayload.find((entry: any) => String(entry?.product_name || "").trim())
                : null;
              const prefillLine = itemMatch || recentLineMatch;
              setLines(
                prefillLine
                  ? buildSeedLines(prefillLine, fallbackVatRate)
                  : [emptyLine(defaultSalesVatRateInput(companyPayload))],
              );
              setPaymentPreset("30");
              setDocumentDiscountOpen(false);
              setLineDiscountsEnabled(false);
              setAdvancedComplianceEnabled(false);
              setLineComplianceOpenIds([]);
              setDepositPanelOpen(false);
              setDepositDraft({
                reference: "",
                amount_ht: "",
                vat_rate: defaultAdvanceVatRateRef.current || "20",
                invoice_id: "",
                quote_id: "",
                customer_id: "",
                currency: "",
              });
              setDepositInvoiceMenuOpen(false);
              setNoInvoiceDepositOpen(false);
              setNoInvoiceDepositInputMode("percent");
              setNoInvoiceDepositDraft({
                reference: "",
                percent: "",
                amount_ttc: "0,00",
                vat_rate: defaultAdvanceVatRateRef.current || "20",
              });
              setCustomerQuery("");
              setClientDropdownOpen(false);
              setSeedContext(null);
              setAutosavedAt(null);
              if (smartPrefill && (customerSeed || prefillLine)) {
                const parts = [
                  customerMatch?.name ? `client ${customerMatch.name}` : customerSeed ? "client sélectionné" : "",
                  prefillLine?.name || prefillLine?.product_name
                    ? `ligne ${prefillLine.name || prefillLine.product_name}`
                    : "",
                ].filter(Boolean);
                setNotice(parts.length ? `Document prérempli avec ${parts.join(" et ")}.` : null);
              }
            }
          }

          if (
            isInvoice &&
            sourceQuoteId &&
            sourceSeed === "deposit" &&
            sourceQuoteRes.status === "fulfilled" &&
            sourceQuoteRes.value?.ok
          ) {
            const quoteSeed = await sourceQuoteRes.value.json().catch(() => null);
            if (quoteSeed?.id) {
              const customerMatch = customersPayload.find((entry: any) => entry.id === quoteSeed.customer_id);
              const fallbackVatRate = defaultSalesVatRateNumber(companyPayload, customerMatch);
              const cashPreset = applyPaymentPreset(dateInputValue(new Date()), "cash");
              setForm((prev: any) => ({
                ...prev,
                customer_id: quoteSeed.customer_id || prev.customer_id,
                quote_id: quoteSeed.id || prev.quote_id || "",
                currency: quoteSeed.currency || prev.currency || "EUR",
                payment_terms: `Acompte ${depositPercent}% à la commande`,
                due_date: cashPreset.dueDate,
                purchase_order_number: quoteSeed.purchase_order_number || prev.purchase_order_number || "",
                note: `Facture d'acompte liée au devis ${quoteSeed.number || quoteSeed.id}. Ajuste les lignes si nécessaire avant création.`,
              }));
              setLines(buildDepositSeedFromQuote(quoteSeed, depositPercent, fallbackVatRate));
              setPaymentPreset("cash");
              setSeedContext({
                kind: "deposit",
                percent: depositPercent,
                quoteId: quoteSeed.id,
                quoteNumber: quoteSeed.number || quoteSeed.id,
              });
              setNotice(
                `Facture d'acompte ${depositPercent}% préremplie depuis le devis ${quoteSeed.number || quoteSeed.id}.`,
              );
            }
          }

          if (isInvoice && editInvoiceId && editInvoiceRes.status === "fulfilled" && editInvoiceRes.value?.ok) {
            const invoicePayload = await editInvoiceRes.value.json().catch(() => null);
            const invoiceToEdit = invoicePayload?.invoice || null;
            if (invoiceToEdit?.id) {
              setEditingDocumentStatus(String(invoiceToEdit.status || ""));
              if (!isEditableDraftInvoice(invoiceToEdit)) {
                invoiceEditLocked = true;
                setLockedInvoiceToEdit(invoiceToEdit);
                setNotice(null);
              } else {
                const templateOptions = normalizeTemplateOptionsForForm(invoiceToEdit.template_options);
                setLineColumnVisibility(templateOptions.line_columns);
                setDocumentDiscountInputMode(
                  templateOptions.document_discount_input_mode === "amount" ? "amount" : "percent",
                );
                setDocumentDiscountAmountInput(String(templateOptions.document_discount_amount_ht || ""));
                setGlobalVatEnabled(Boolean(templateOptions.global_vat_enabled));
                setGlobalVatDraft(normalizeGlobalVatDraft(templateOptions.global_vat_draft));
                restoreAdvancePaymentState(templateOptions);
                const paymentBankAccount = invoiceToEdit.template_options?.payment_bank_account;
                if (paymentBankAccount?.id) {
                  if (!isCustomerPaymentBankAccount(paymentBankAccount))
                    setSelectedBankAccountId(paymentBankAccount.id);
                } else if (
                  !isCustomerPaymentBankAccount(paymentBankAccount) &&
                  (paymentBankAccount?.iban || paymentBankAccount?.bic)
                ) {
                  const matchingAccount = bankAccountsPayload.find(
                    (account: any) =>
                      cleanBic(account?.bic) === cleanBic(paymentBankAccount?.bic) ||
                      normalizeIban(account?.iban) === normalizeIban(paymentBankAccount?.iban),
                  );
                  if (matchingAccount?.id) setSelectedBankAccountId(matchingAccount.id);
                }
                setForm((prev: any) => ({
                  ...prev,
                  customer_id: invoiceToEdit.customer_id || prev.customer_id,
                  quote_id: invoiceToEdit.quote_id || prev.quote_id || "",
                  currency: invoiceToEdit.currency || prev.currency || "EUR",
                  issue_date: dateInputValue(invoiceToEdit.issue_date || invoiceToEdit.service_date || new Date()),
                  service_date: dateInputValue(invoiceToEdit.service_date || invoiceToEdit.issue_date || new Date()),
                  due_date: dateInputValue(invoiceToEdit.due_date || ""),
                  payment_terms: invoiceToEdit.payment_terms || "",
                  purchase_order_number: invoiceToEdit.purchase_order_number || "",
                  delivery_address: invoiceToEdit.delivery_address || "",
                  delivery_address_differs: Boolean(invoiceToEdit.delivery_address_differs),
                  document_title: templateOptions.document_title || prev.document_title || "",
                  note: invoiceToEdit.note || "",
                  operation_nature: invoiceToEdit.operation_nature || "services",
                  facturx_profile: invoiceToEdit.facturx_profile || "en16931",
                  template_key: invoiceToEdit.template_key || "classic",
                  template_options: templateOptions,
                  document_language: templateOptions.document_language,
                  document_tags: templateOptions.document_tags.join(", "),
                  custom_fields: templateOptions.custom_fields,
                  payment_methods: templateOptions.payment_methods,
                  legal_terms_default: templateOptions.legal_terms_default,
                  legal_mentions_text: templateOptions.legal_mentions_text,
                  legal_footer_text: templateOptions.legal_footer_text,
                  legal_penalty_prefix: templateOptions.legal_penalty_prefix,
                  legal_recovery_prefix: templateOptions.legal_recovery_prefix,
                  legal_discount_text: templateOptions.legal_discount_text,
                  legal_penalty_rate: templateOptions.legal_penalty_rate,
                  legal_recovery_fee: templateOptions.legal_recovery_fee,
                }));
                const customerMatch = customersPayload.find((entry: any) => entry.id === invoiceToEdit.customer_id);
                const extractedInvoice = extractEditorState(
                  Array.isArray(invoiceToEdit.lines) ? invoiceToEdit.lines : [],
                  defaultSalesVatRateNumber(companyPayload, customerMatch),
                );
                setForm((prev: any) => ({
                  ...prev,
                  document_discount_percent: extractedInvoice.document_discount_percent || "",
                }));
                setLines(extractedInvoice.lines);
                setPaymentPreset(inferPaymentPreset(invoiceToEdit.payment_terms || ""));
                setNotice(`Mode modification activé pour ${invoiceToEdit.number || "cette facture"}.`);
              }
            }
          }

          if (!isInvoice && editQuoteId && editQuoteRes.status === "fulfilled" && editQuoteRes.value?.ok) {
            const quoteToEdit = await editQuoteRes.value.json().catch(() => null);
            if (quoteToEdit?.id) {
              setEditingDocumentStatus(String(quoteToEdit.status || ""));
              const templateOptions = normalizeTemplateOptionsForForm(quoteToEdit.template_options);
              setLineColumnVisibility(templateOptions.line_columns);
              setDocumentDiscountInputMode(
                templateOptions.document_discount_input_mode === "amount" ? "amount" : "percent",
              );
              setDocumentDiscountAmountInput(String(templateOptions.document_discount_amount_ht || ""));
              setGlobalVatEnabled(Boolean(templateOptions.global_vat_enabled));
              setGlobalVatDraft(normalizeGlobalVatDraft(templateOptions.global_vat_draft));
              restoreAdvancePaymentState(templateOptions);
              const paymentBankAccount = quoteToEdit.template_options?.payment_bank_account;
              if (paymentBankAccount?.id) {
                if (!isCustomerPaymentBankAccount(paymentBankAccount)) setSelectedBankAccountId(paymentBankAccount.id);
              } else if (
                !isCustomerPaymentBankAccount(paymentBankAccount) &&
                (paymentBankAccount?.iban || paymentBankAccount?.bic)
              ) {
                const matchingAccount = bankAccountsPayload.find(
                  (account: any) =>
                    cleanBic(account?.bic) === cleanBic(paymentBankAccount?.bic) ||
                    normalizeIban(account?.iban) === normalizeIban(paymentBankAccount?.iban),
                );
                if (matchingAccount?.id) setSelectedBankAccountId(matchingAccount.id);
              }
              setForm((prev: any) => ({
                ...prev,
                customer_id: quoteToEdit.customer_id || prev.customer_id,
                currency: quoteToEdit.currency || prev.currency || "EUR",
                issue_date: dateInputValue(quoteToEdit.issue_date || quoteToEdit.service_date || new Date()),
                service_date: dateInputValue(quoteToEdit.service_date || quoteToEdit.issue_date || new Date()),
                due_date: dateInputValue(quoteToEdit.valid_until || ""),
                valid_until: dateInputValue(quoteToEdit.valid_until || ""),
                payment_terms: quoteToEdit.payment_terms || "",
                purchase_order_number: quoteToEdit.purchase_order_number || "",
                delivery_address: templateOptions.delivery_address || "",
                delivery_address_differs: Boolean(templateOptions.delivery_address_differs),
                document_title: templateOptions.document_title || prev.document_title || "",
                note: quoteToEdit.note || "",
                operation_nature: templateOptions.operation_nature || "services",
                template_key: quoteToEdit.template_key || "classic",
                template_options: templateOptions,
                document_language: templateOptions.document_language,
                document_tags: templateOptions.document_tags.join(", "),
                custom_fields: templateOptions.custom_fields,
                payment_methods: templateOptions.payment_methods,
                legal_terms_default: templateOptions.legal_terms_default,
                legal_mentions_text: templateOptions.legal_mentions_text,
                legal_footer_text: templateOptions.legal_footer_text,
                legal_penalty_prefix: templateOptions.legal_penalty_prefix,
                legal_recovery_prefix: templateOptions.legal_recovery_prefix,
                legal_discount_text: templateOptions.legal_discount_text,
                legal_penalty_rate: templateOptions.legal_penalty_rate,
                legal_recovery_fee: templateOptions.legal_recovery_fee,
              }));
              const customerMatch = customersPayload.find((entry: any) => entry.id === quoteToEdit.customer_id);
              const extractedQuote = extractEditorState(
                Array.isArray(quoteToEdit.lines) ? quoteToEdit.lines : [],
                defaultSalesVatRateNumber(companyPayload, customerMatch),
              );
              setForm((prev: any) => ({
                ...prev,
                document_discount_percent: extractedQuote.document_discount_percent || "",
              }));
              setLines(extractedQuote.lines);
              setPaymentPreset(inferPaymentPreset(quoteToEdit.payment_terms || ""));
              setNotice(`Mode modification activé pour ${quoteToEdit.number || "ce devis"}.`);
            }
          }

          if (!fromQuote && !sourceQuoteId && (editInvoiceId || editQuoteId) && !invoiceEditLocked) {
            restoreLocalDraft();
          }
        }
      } catch (err) {
        if (!cancelled) setError(formatApiError(err, "Impossible de charger l'éditeur."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadData();
    return () => {
      cancelled = true;
    };
  }, [
    depositPercent,
    editInvoiceId,
    editQuoteId,
    fromQuote,
    customerSeed,
    documentLegalTemplateKind,
    itemSeed,
    localDocumentTemplateKind,
    smartPrefill,
    isEditingExistingQuote,
    isInvoice,
    recentKey,
    restoreAdvancePaymentState,
    sourceQuoteId,
    sourceSeed,
    storageKey,
  ]);

  useEffect(() => {
    const selected = selectedBankAccountId
      ? bankAccounts.find((account) => account?.id === selectedBankAccountId) || null
      : null;
    setBankDraft({
      id: selected?.id || "",
      label: selected?.label || "Coordonnées principales",
      iban: formatIbanInput(selected?.iban || ""),
      bic: cleanBic(selected?.bic || ""),
      is_default: Boolean(selected?.is_default),
    });
  }, [bankAccounts, company?.bic, company?.iban, selectedBankAccountId]);

  useEffect(() => {
    if (loading || fromQuote || lockedInvoiceToEdit || typeof window === "undefined") return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      const payload = {
        version: CURRENT_DRAFT_VERSION,
        form,
        lines,
        paymentPreset,
        selectedBankAccountId,
        documentDiscountOpen,
        documentDiscountInputMode,
        documentDiscountAmountInput,
        lineDiscountsEnabled,
        globalVatEnabled,
        globalVatDraft,
        advancedComplianceEnabled,
        lineComplianceOpenIds,
        depositPanelOpen,
        depositDraft,
        noInvoiceDepositOpen,
        noInvoiceDepositDraft,
        noInvoiceDepositInputMode,
        lineColumnVisibility,
        saved_at: new Date().toISOString(),
      };
      window.localStorage.setItem(storageKey, JSON.stringify(payload));
      setAutosavedAt(payload.saved_at);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    form,
    lines,
    paymentPreset,
    selectedBankAccountId,
    documentDiscountOpen,
    documentDiscountInputMode,
    documentDiscountAmountInput,
    lineDiscountsEnabled,
    globalVatEnabled,
    globalVatDraft,
    advancedComplianceEnabled,
    lineComplianceOpenIds,
    depositPanelOpen,
    depositDraft,
    noInvoiceDepositOpen,
    noInvoiceDepositDraft,
    noInvoiceDepositInputMode,
    lineColumnVisibility,
    loading,
    fromQuote,
    lockedInvoiceToEdit,
    storageKey,
  ]);

  useEffect(() => {
    if (!hasProtectedLocalDraft || typeof window === "undefined") return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasProtectedLocalDraft]);

  useEffect(() => {
    if (!hasProtectedLocalDraft || typeof document === "undefined" || typeof window === "undefined") return;
    const handleDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") || "";
      if (!href || href.startsWith("#")) return;

      let targetUrl: URL;
      try {
        targetUrl = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (targetUrl.origin !== window.location.origin) return;
      if (targetUrl.pathname === window.location.pathname && targetUrl.search === window.location.search) return;

      const confirmed = window.confirm(
        "Un brouillon local est enregistré sur cet appareil. Créez ou enregistrez le brouillon avant de quitter si vous voulez le rendre disponible partout.",
      );
      if (!confirmed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", handleDocumentClick, true);
    return () => document.removeEventListener("click", handleDocumentClick, true);
  }, [hasProtectedLocalDraft]);

  useEffect(() => {
    const query = customerQuery.trim();
    if (query.length < 2 || typeof window === "undefined") return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await rawApi(`/api/customers?limit=20&offset=0&q=${encodeURIComponent(query)}`);
        if (!res.ok || cancelled) return;
        const payload = await res.json().catch(() => []);
        if (!Array.isArray(payload) || cancelled) return;
        setCustomers((prev) => {
          const byId = new Map<string, any>();
          [...prev, ...payload].forEach((customer) => {
            if (customer?.id) byId.set(customer.id, customer);
          });
          return Array.from(byId.values());
        });
      } catch {
        // Keep the locally loaded list usable if the search endpoint is unavailable.
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [customerQuery]);

  useEffect(() => {
    if (!seqinoOperational || !isInvoice || !selectedCustomer) {
      setDirectoryEntry(null);
      return;
    }
    const siren = String(selectedCustomer.siren || "").replace(/\D/g, "");
    const siret = String(selectedCustomer.siret || "").replace(/\D/g, "");
    const routingCode = String(selectedCustomer.routing_code || "").trim();
    if (!siren && !siret) {
      setDirectoryEntry(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams();
    if (siren) params.set("siren", siren);
    if (siret) params.set("siret", siret);
    if (routingCode) params.set("routing_code", routingCode);
    rawApi(`/api/directory/lookup?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setDirectoryEntry(null);
          return;
        }
        setDirectoryEntry(await res.json());
      })
      .catch(() => {
        if (!cancelled) setDirectoryEntry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isInvoice, selectedCustomer, seqinoOperational]);

  const selectedDirectoryInfo = directoryEntry;
  const selectedCustomerCountry = String(
    selectedCustomer?.country || selectedCustomer?.country_code || "FR",
  ).toUpperCase();
  const selectedCustomerIsBusiness = isBusinessClientType(selectedCustomer?.client_type);
  const selectedCustomerShowsLegalIdentity = Boolean(selectedCustomer && selectedCustomerIsBusiness);
  const customerLegalIdRequired =
    Boolean(selectedCustomer) && isInvoice && selectedCustomerCountry === "FR" && selectedCustomerIsBusiness;
  const customerLegalIdRecommended =
    Boolean(selectedCustomer) && !isInvoice && selectedCustomerCountry === "FR" && selectedCustomerIsBusiness;
  const customerLegalIdExpected = customerLegalIdRequired || customerLegalIdRecommended;
  const customerLegalIdPresent = selectedCustomer
    ? selectedCustomerCountry === "FR"
      ? Boolean(selectedCustomer?.siren || selectedCustomer?.siret)
      : Boolean(selectedCustomer?.vat_number)
    : false;
  const customerLegalIdOk = selectedCustomer ? !customerLegalIdExpected || customerLegalIdPresent : false;
  const customerAddressRequired =
    Boolean(selectedCustomer) && isInvoice && selectedCustomerCountry === "FR" && selectedCustomerIsBusiness;
  const customerAddressOk = selectedCustomer ? hasInvoicePartyAddress(selectedCustomer) : false;
  const companySiretDisplay = formatSiretInput(company?.siret || "") || "";
  const companySirenDisplay =
    formatSirenInput(
      digitsOnly(company?.siret || "").slice(0, 9) ||
        digitsOnly(company?.rcs || legalConfig?.rcsNumber || "").slice(0, 9),
    ) || "";
  const companyVatDisplay =
    formatVatNumberInput(company?.vat_number || "") ||
    formatVatNumberInput(legalConfig?.vatNumber || "") ||
    (isVatFranchiseRegime(company?.vat_regime) ? "Franchise en base" : "");
  const companyEmailDisplay = String(company?.email_reply_to || legalConfig?.email || "").trim();
  const companyPhoneDisplay = formatPhoneDisplay(company?.phone || "");
  const companyAddressDisplay = companyAddress(company);
  const companyCountryDisplay = String(company?.country_code || company?.country || "")
    .trim()
    .toUpperCase();
  const companyAddressLines = companyAddressDisplay
    .split("\n")
    .filter(Boolean)
    .filter(
      (line) =>
        String(line || "")
          .trim()
          .toUpperCase() !== companyCountryDisplay,
    );
  const companyMissingFields = [
    !String(company?.name || "").trim() ? "raison sociale" : null,
    digitsOnly(company?.siret || "").length !== 14 ? "SIRET" : null,
    !companyAddressDisplay ? "adresse" : null,
    String(company?.country || company?.country_code || "FR").toUpperCase() === "FR" &&
    !String(company?.vat_number || company?.vat_exemption_notice || "").trim()
      ? "TVA ou exonération"
      : null,
    String(company?.country || company?.country_code || "FR").toUpperCase() === "FR" &&
    !String(company?.late_payment_interest || "").trim()
      ? "pénalités de retard"
      : null,
  ].filter(Boolean) as string[];
  const companyProfileReady = companyMissingFields.length === 0;
  const companyProfileBlockReason = companyProfileReady
    ? null
    : `Complétez le dossier entreprise : ${companyMissingFields.join(", ")}.`;
  const companyLogoUrl = String(company?.logo_url || company?.logoUrl || "").trim();
  const logoBusy = uploadingLogo || deletingLogo;
  const updateCompanyLogoState = (logoUrl: string) => {
    setCompany((prev: any) =>
      prev && typeof prev === "object" ? { ...prev, logo_url: logoUrl, logoUrl } : { logo_url: logoUrl, logoUrl },
    );
  };
  const resetLogoInput = () => {
    if (logoInputRef.current) logoInputRef.current.value = "";
  };
  const uploadCompanyLogoFromDocument = async (file?: File | null) => {
    if (!file || logoBusy) return;
    setUploadingLogo(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const result: any = await apiUpload("/api/company/logo", body);
      const logoUrl = String(result?.logo_url || "").trim();
      if (!logoUrl) throw new Error("Logo non retourné par le serveur.");
      updateCompanyLogoState(logoUrl);
      setNotice("Logo entreprise mis à jour.");
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour le logo."));
    } finally {
      resetLogoInput();
      setUploadingLogo(false);
    }
  };
  const deleteCompanyLogoFromDocument = async () => {
    if (!companyLogoUrl || logoBusy) return;
    setDeletingLogo(true);
    setError(null);
    try {
      await api("/api/company/profile", {
        method: "PATCH",
        body: JSON.stringify({ logo_url: null }),
      });
      updateCompanyLogoState("");
      setNotice("Logo entreprise supprimé.");
    } catch (err) {
      setError(formatApiError(err, "Impossible de supprimer le logo."));
    } finally {
      setDeletingLogo(false);
    }
  };
  const selectedBankAccount = selectedBankAccountId
    ? bankAccounts.find((account) => account?.id === selectedBankAccountId) || null
    : null;
  const rawTemplatePaymentBankAccount =
    form.template_options?.payment_bank_account &&
    typeof form.template_options.payment_bank_account === "object" &&
    (form.template_options.payment_bank_account.iban || form.template_options.payment_bank_account.bic)
      ? form.template_options.payment_bank_account
      : null;
  const templatePaymentBankAccount = isCustomerPaymentBankAccount(rawTemplatePaymentBankAccount)
    ? null
    : rawTemplatePaymentBankAccount;
  const companyFallbackBankAccount =
    company?.iban || company?.bic
      ? {
          label: "Coordonnées bancaires",
          iban: company?.iban || null,
          bic: company?.bic || null,
        }
      : null;
  const paymentBankDisplay = selectedBankAccount || templatePaymentBankAccount || companyFallbackBankAccount;
  const selectedBankAccountTemplatePayload =
    selectedBankAccount?.iban || selectedBankAccount?.bic
      ? {
          id: selectedBankAccount.id || undefined,
          label: selectedBankAccount.label || "Coordonnées bancaires",
          iban: selectedBankAccount.iban || null,
          bic: selectedBankAccount.bic || null,
        }
      : templatePaymentBankAccount
        ? {
            id: templatePaymentBankAccount.id || undefined,
            label: templatePaymentBankAccount.label || "Coordonnées bancaires",
            iban: templatePaymentBankAccount.iban || null,
            bic: templatePaymentBankAccount.bic || null,
          }
        : companyFallbackBankAccount
          ? {
              label: companyFallbackBankAccount.label,
              iban: companyFallbackBankAccount.iban || null,
              bic: companyFallbackBankAccount.bic || null,
            }
          : null;
  const normalizedBankDraftIban = normalizeIban(bankDraft.iban);
  const normalizedBankDraftBic = cleanBic(bankDraft.bic);
  const bankDraftIbanInvalid = Boolean(normalizedBankDraftIban && !isValidIban(normalizedBankDraftIban));
  const bankDraftBicInvalid = Boolean(normalizedBankDraftBic && !isValidBic(normalizedBankDraftBic));
  const issuerIdentityRows: DetailRow[] = [
    { label: "SIREN", value: companySirenDisplay },
    { label: "SIRET", value: companySiretDisplay },
    { label: "N° TVA", value: companyVatDisplay },
  ].filter((item) => Boolean(item.value));
  const customerSiretDisplay = formatSiretInput(selectedCustomer?.siret || "") || "";
  const customerSirenDisplay =
    formatSirenInput(selectedCustomer?.siren || "") ||
    formatSirenInput(digitsOnly(selectedCustomer?.siret || "").slice(0, 9)) ||
    "";
  const customerVatDisplay = formatVatNumberInput(selectedCustomer?.vat_number || "") || "";
  const customerEmailDisplay = String(selectedCustomer?.email || "").trim();
  const customerPhoneDisplay = formatPhoneDisplay(selectedCustomer?.phone || "");
  const customerAddressDisplay = selectedCustomer ? customerAddress(selectedCustomer) : "";
  const customerAddressLines = customerAddressDisplay.split("\n").filter(Boolean);
  const customerIdentityRows: DetailRow[] = selectedCustomerShowsLegalIdentity
    ? [
        {
          label: "SIREN",
          value: customerSirenDisplay || (customerLegalIdRequired ? "À compléter" : ""),
        },
        { label: "SIRET", value: customerSiretDisplay },
        { label: "N° TVA", value: customerVatDisplay },
      ].filter((item) => Boolean(item.value))
    : [];
  const filteredCustomers = useMemo(() => {
    const query = String(customerQuery || "")
      .trim()
      .toLowerCase();
    const sorted = [...customers].sort((a, b) => {
      const aIndex = recentCustomerIds.indexOf(a.id);
      const bIndex = recentCustomerIds.indexOf(b.id);
      if (aIndex === -1 && bIndex === -1) return String(a?.name || "").localeCompare(String(b?.name || ""));
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });
    if (!query) return sorted.slice(0, 12);
    return sorted
      .filter((item) => `${item?.name || ""} ${item?.email || ""} ${item?.siret || ""}`.toLowerCase().includes(query))
      .slice(0, 12);
  }, [customerQuery, customers, recentCustomerIds]);

  const activeCatalogItems = useMemo(
    () => (Array.isArray(catalogItems) ? catalogItems.filter((item) => item?.active !== false) : []),
    [catalogItems],
  );
  const archivedCatalogItems = useMemo(
    () => (Array.isArray(catalogItems) ? catalogItems.filter((item) => item?.active === false) : []),
    [catalogItems],
  );
  const catalogLineItemIds = useMemo(
    () =>
      new Set(
        lines
          .filter((line) => String(line?.line_type || "item") === "item")
          .map((line) => String(line?.item_id || "").trim())
          .filter(Boolean),
      ),
    [lines],
  );
  const catalogLineNames = useMemo(
    () =>
      new Set(
        lines
          .filter((line) => String(line?.line_type || "item") === "item")
          .map((line) =>
            String(line?.product_name || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    [lines],
  );
  const catalogItemIsOnDocument = useCallback(
    (item: any) => {
      const itemId = String(item?.id || "").trim();
      const itemName = String(item?.name || "")
        .trim()
        .toLowerCase();
      return Boolean(itemId && catalogLineItemIds.has(itemId)) || Boolean(itemName && catalogLineNames.has(itemName));
    },
    [catalogLineItemIds, catalogLineNames],
  );
  const documentCatalogItems = useMemo(
    () => (Array.isArray(catalogItems) ? catalogItems.filter(catalogItemIsOnDocument) : []),
    [catalogItemIsOnDocument, catalogItems],
  );
  const visibleCatalogItems = useMemo(() => {
    if (catalogFilterMode === "document") return documentCatalogItems;
    if (catalogFilterMode === "archived") return archivedCatalogItems;
    if (catalogFilterMode === "all") return Array.isArray(catalogItems) ? catalogItems : [];
    return activeCatalogItems;
  }, [activeCatalogItems, archivedCatalogItems, catalogFilterMode, catalogItems, documentCatalogItems]);
  const filteredCatalogItems = useMemo(() => {
    const query = String(catalogQuery || "")
      .trim()
      .toLowerCase();
    const base = Array.isArray(visibleCatalogItems) ? visibleCatalogItems : [];
    if (!query) return base;
    return base
      .filter((item) =>
        `${item?.name || ""} ${item?.description || ""} ${item?.unit_code || ""}`.toLowerCase().includes(query),
      )
      .slice(0, 80);
  }, [catalogQuery, visibleCatalogItems]);
  const catalogPanelTargetLine = useMemo(
    () => (catalogPanelTargetLineId ? lines.find((line) => line.id === catalogPanelTargetLineId) || null : null),
    [catalogPanelTargetLineId, lines],
  );

  useEffect(() => {
    if (!catalogEditorOpen || catalogEditingItemId || catalogEditorTouched || !catalogPanelTargetLine) return;
    setCatalogItemForm((prev) => ({
      ...prev,
      name: String(catalogPanelTargetLine.product_name || "").trim(),
      description: String(catalogPanelTargetLine.detail || "").trim(),
      unit_price:
        catalogPanelTargetLine.unit_price != null && String(catalogPanelTargetLine.unit_price).trim() !== ""
          ? String(catalogPanelTargetLine.unit_price)
          : "",
      vat_rate: companyVatFranchise
        ? "0"
        : catalogPanelTargetLine.vat_rate != null && String(catalogPanelTargetLine.vat_rate).trim() !== ""
          ? String(catalogPanelTargetLine.vat_rate)
          : defaultSalesVatRateInput(company, selectedCustomer),
      unit_code:
        String(catalogPanelTargetLine.unit_code || "")
          .trim()
          .toUpperCase() || "",
    }));
  }, [
    catalogEditorOpen,
    catalogEditorTouched,
    catalogEditingItemId,
    catalogPanelTargetLine,
    company,
    companyVatFranchise,
    company?.default_sales_vat_rate,
    selectedCustomer,
    selectedCustomer?.default_vat_rate,
  ]);
  const filteredDocumentModelOptions = useMemo(() => {
    const query = String(documentModelQuery || "")
      .trim()
      .toLowerCase();
    const base = Array.isArray(documentModelOptions) ? documentModelOptions : [];
    if (!query) return base.slice(0, 30);
    return base
      .filter((document: any) => {
        const haystack = [
          document?.customer_name,
          document?.customer?.name,
          document?.customer_email,
          document?.number,
          document?.id,
          document?.status,
          document?.total_inc_vat,
          document?.total_ttc,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 30);
  }, [documentModelOptions, documentModelQuery]);
  const recentCustomers = useMemo(() => {
    const ordered = recentCustomerIds.map((id) => customers.find((item) => item.id === id)).filter(Boolean);
    const fallback = filteredCustomers.filter((customer) => !ordered.some((entry: any) => entry.id === customer.id));
    return [...ordered, ...fallback].slice(0, 5);
  }, [customers, filteredCustomers, recentCustomerIds]);

  const documentDiscountPercent = clampDiscountPercent(form.document_discount_percent);
  const documentDiscountLines = useMemo(
    () => buildDocumentDiscountLines(lines, documentDiscountPercent),
    [lines, documentDiscountPercent],
  );
  const depositAmountHT = roundMoney(numberInputValue(depositDraft.amount_ht));
  const depositVatRate = numberInputValue(depositDraft.vat_rate || 20);
  const depositVatAmount = roundMoney(depositAmountHT * (depositVatRate / 100));
  const depositAmountTTC = roundMoney(depositAmountHT + depositVatAmount);
  const totalLines = useMemo(() => [...lines, ...documentDiscountLines], [documentDiscountLines, lines]);
  const documentLanguage = String(
    form.document_language || normalizeTemplateOptionsForForm(form.template_options).document_language || "fr",
  )
    .trim()
    .toLowerCase()
    .startsWith("en")
    ? "en"
    : "fr";
  const documentCopy = DOCUMENT_COPY[documentLanguage];
  const filledLines = useMemo(
    () =>
      lines.filter((line) => String(line?.line_type || "item") === "item" && String(line?.product_name || "").trim()),
    [lines],
  );
  const rawAdvancedComplianceIssues = useMemo(
    () => filledLines.filter((line) => lineNeedsAdvancedComplianceAttention(line, company, documentCopy)),
    [company, documentCopy, filledLines],
  );
  const advancedComplianceIssues = useMemo(
    () => (advancedComplianceEnabled ? rawAdvancedComplianceIssues : []),
    [advancedComplianceEnabled, rawAdvancedComplianceIssues],
  );
  const advancedComplianceVisible = advancedComplianceEnabled;
  const normalizedGlobalVatRate = String(globalVatDraft.vat_rate || "").trim();
  const globalVatRateNumber = numberInputValue(normalizedGlobalVatRate);
  const globalVatCategory =
    String(globalVatDraft.vat_category || "")
      .trim()
      .toUpperCase() || defaultVatCategoryForRate(normalizedGlobalVatRate);
  const globalVatExemptionReason = String(globalVatDraft.exemption_reason_code || "")
    .trim()
    .toUpperCase();
  const globalVatUnitCode =
    String(globalVatDraft.unit_code || "C62")
      .trim()
      .toUpperCase()
      .slice(0, 8) || "C62";
  const globalVatNeedsReason = globalVatRateNumber === 0 || globalVatCategory !== "S";
  const documentDiscountBaseHT = useMemo(
    () =>
      roundMoney(
        lines.reduce((sum, line) => {
          if (String(line?.line_type || "item") !== "item") return sum;
          if (!String(line?.product_name || "").trim()) return sum;
          return sum + Math.max(lineTotalHT(line), 0);
        }, 0),
      ),
    [lines],
  );

  const applyGlobalVatToLines = useCallback(() => {
    if (companyVatFranchise) return;
    const nextCategory = globalVatRateNumber > 0 ? "S" : globalVatCategory === "S" ? "O" : globalVatCategory;
    const nextVatRate = globalVatRateNumber > 0 ? normalizedGlobalVatRate || "20" : "0";
    const nextExemptionReason = nextCategory === "S" && globalVatRateNumber > 0 ? "" : globalVatExemptionReason;
    setAdvancedComplianceEnabled(globalVatRateNumber === 0 || nextCategory !== "S");
    setLineColumnVisibility((current) => (current.vat ? current : { ...current, vat: true }));
    setForm((prev: any) => ({
      ...prev,
      legal_terms_default: true,
      legal_footer_text: "",
      legal_penalty_prefix: "",
      legal_recovery_prefix: "",
      legal_discount_text: "",
    }));
    setLines((current) => {
      let changed = false;
      const nextLines = current.map((line) => {
        if (String(line?.line_type || "item") !== "item") return line;
        const nextLine = {
          ...line,
          vat_rate: nextVatRate,
          vat_category: nextCategory,
          exemption_reason_code: nextExemptionReason,
        };
        if (
          String(line.vat_rate ?? "") !== String(nextLine.vat_rate ?? "") ||
          lineVatCategory(line) !== nextLine.vat_category ||
          String(line.exemption_reason_code || "") !== String(nextLine.exemption_reason_code || "")
        ) {
          changed = true;
        }
        return nextLine;
      });
      return changed ? nextLines : current;
    });
  }, [companyVatFranchise, globalVatCategory, globalVatExemptionReason, globalVatRateNumber, normalizedGlobalVatRate]);

  const vatLegalSourceLines = filledLines;

  const totals = useMemo(() => {
    const totalHT = totalLines.reduce((sum, line) => sum + lineTotalHT(line), 0);
    const totalVAT = totalLines.reduce(
      (sum, line) => sum + lineTotalHT(line) * (numberInputValue(line.vat_rate) / 100),
      0,
    );
    return {
      totalHT: roundMoney(totalHT),
      totalVAT: roundMoney(totalVAT),
      totalTTC: roundMoney(totalHT + totalVAT),
    };
  }, [totalLines]);
  const filledLineCount = useMemo(
    () =>
      lines.filter((line) => String(line?.line_type || "item") === "item" && String(line?.product_name || "").trim())
        .length,
    [lines],
  );
  const hasAtLeastOneLine = filledLineCount > 0;
  const invoiceLineIssues = useMemo(() => invoiceLineCompletenessIssues(lines), [lines]);
  const invoiceLinesReady = invoiceLineIssues.length === 0;
  const invoiceLineBlockReason = invoiceLinesReady ? null : `Complétez les lignes : ${invoiceLineIssues.join(", ")}.`;

  const vatBreakdown = useMemo(() => {
    const groups = new Map<number, { base: number; vat: number }>();
    totalLines.forEach((line) => {
      const rate = numberInputValue(line.vat_rate);
      const base = lineTotalHT(line);
      const entry = groups.get(rate) || { base: 0, vat: 0 };
      entry.base += base;
      entry.vat += base * (rate / 100);
      groups.set(rate, entry);
    });
    return Array.from(groups.entries())
      .filter(([, entry]) => Math.abs(entry.base) > 0.004 || Math.abs(entry.vat) > 0.004)
      .sort((a, b) => a[0] - b[0]);
  }, [totalLines]);
  const lineDiscountTotalHT = useMemo(
    () => roundMoney(lines.reduce((sum, line) => sum + lineDiscountAmountHT(line), 0) * -1),
    [lines],
  );
  const documentDiscountTotalHT = useMemo(
    () => roundMoney(documentDiscountLines.reduce((sum, line) => sum + lineTotalHT(line), 0)),
    [documentDiscountLines],
  );
  const documentDiscountAmountHT = useMemo(
    () => roundMoney(Math.abs(documentDiscountTotalHT)),
    [documentDiscountTotalHT],
  );
  const discountTotalHT = useMemo(
    () => roundMoney(lineDiscountTotalHT + documentDiscountTotalHT),
    [documentDiscountTotalHT, lineDiscountTotalHT],
  );
  const discountBaseHT = useMemo(
    () =>
      roundMoney(
        lines.reduce((sum, line) => {
          if (String(line?.line_type || "item") !== "item") return sum;
          if (!String(line?.product_name || "").trim()) return sum;
          return sum + Math.max(lineBaseTotalHT(line), 0);
        }, 0),
      ),
    [lines],
  );
  const discountBaseTTC = useMemo(
    () =>
      roundMoney(
        lines.reduce((sum, line) => {
          if (String(line?.line_type || "item") !== "item") return sum;
          if (!String(line?.product_name || "").trim()) return sum;
          const base = Math.max(lineBaseTotalHT(line), 0);
          const vatRate = numberInputValue(line.vat_rate);
          return sum + base * (1 + vatRate / 100);
        }, 0),
      ),
    [lines],
  );
  const discountTotalTTC = useMemo(
    () => roundMoney(totals.totalTTC - discountBaseTTC),
    [discountBaseTTC, totals.totalTTC],
  );
  const noInvoiceDepositPercent = numberInputValue(noInvoiceDepositDraft.percent);
  const noInvoiceDepositAmountTTC = noInvoiceDepositOpen
    ? roundMoney(numberInputValue(noInvoiceDepositDraft.amount_ttc))
    : 0;
  const noInvoiceRemainingDue = noInvoiceDepositOpen
    ? roundMoney(Math.max(totals.totalTTC - noInvoiceDepositAmountTTC, 0))
    : totals.totalTTC;
  const noInvoiceDepositVatRate = numberInputValue(noInvoiceDepositDraft.vat_rate || defaultAdvanceVatRate);
  const noInvoiceDepositAmountHT = roundMoney(noInvoiceDepositAmountTTC / (1 + noInvoiceDepositVatRate / 100));
  const noInvoiceDepositExceedsTotal =
    noInvoiceDepositOpen && noInvoiceDepositAmountTTC > Math.max(totals.totalTTC, 0) + 0.01;
  const linkedDepositInvoiceIds = useMemo(() => {
    const invoiceId = String(depositDraft.invoice_id || "").trim();
    return depositPanelOpen && invoiceId ? [invoiceId] : [];
  }, [depositDraft.invoice_id, depositPanelOpen]);
  const invoiceKindForPayload = useMemo(() => {
    if (!isInvoice) return undefined;
    if (seedContext?.kind === "deposit") return "deposit";
    if (linkedDepositInvoiceIds.length > 0) return "final";
    return "standard";
  }, [isInvoice, linkedDepositInvoiceIds.length, seedContext?.kind]);
  const quoteIdForPayload = useMemo(() => {
    if (!isInvoice) return null;
    if (seedContext?.quoteId) return String(seedContext.quoteId);
    if (form.quote_id) return String(form.quote_id);
    if (depositDraft.quote_id) return String(depositDraft.quote_id);
    return null;
  }, [depositDraft.quote_id, form.quote_id, isInvoice, seedContext?.quoteId]);
  useEffect(() => {
    if (!noInvoiceDepositOpen || noInvoiceDepositInputMode !== "percent") return;
    const percent = numberInputValue(noInvoiceDepositDraft.percent);
    const nextAmount =
      totals.totalTTC > 0 && percent > 0 ? decimalInputValue(roundMoney(totals.totalTTC * (percent / 100))) : "0,00";
    setNoInvoiceDepositDraft((prev) => (prev.amount_ttc === nextAmount ? prev : { ...prev, amount_ttc: nextAmount }));
  }, [noInvoiceDepositDraft.percent, noInvoiceDepositInputMode, noInvoiceDepositOpen, totals.totalTTC]);
  useEffect(() => {
    if (!noInvoiceDepositOpen || noInvoiceDepositInputMode !== "amount") return;
    const amount = numberInputValue(noInvoiceDepositDraft.amount_ttc);
    const nextPercent =
      totals.totalTTC > 0 && amount > 0 ? decimalInputValue(roundMoney((amount / totals.totalTTC) * 100)) : "";
    setNoInvoiceDepositDraft((prev) => (prev.percent === nextPercent ? prev : { ...prev, percent: nextPercent }));
  }, [noInvoiceDepositDraft.amount_ttc, noInvoiceDepositInputMode, noInvoiceDepositOpen, totals.totalTTC]);
  const advancePaymentEntries = useMemo(() => {
    const hasAppliedDepositDeduction = lines.some(
      (line) =>
        String(line?.line_type || "item") === "item" &&
        numberInputValue(line?.unit_price) < 0 &&
        /^acompte\b/i.test(String(line?.product_name || "").trim()),
    );
    const entries: Array<{
      reference?: string;
      invoice_id?: string;
      quote_id?: string;
      customer_id?: string;
      currency?: string;
      label: string;
      source: string;
      amount_ht: number;
      amount_vat: number;
      amount_ttc: number;
      vat_rate: number;
      percent?: number;
    }> = [];
    if (isInvoice && depositPanelOpen && depositAmountTTC > 0 && !hasAppliedDepositDeduction) {
      const reference = String(depositDraft.reference || "").trim();
      entries.push({
        reference,
        label: reference ? `Acompte facture ${reference}` : "Acompte facture",
        source: "deposit_invoice",
        invoice_id: String(depositDraft.invoice_id || "").trim() || undefined,
        quote_id: String(depositDraft.quote_id || "").trim() || undefined,
        customer_id: String(depositDraft.customer_id || "").trim() || undefined,
        currency: String(depositDraft.currency || form.currency || "").trim() || undefined,
        amount_ht: depositAmountHT,
        amount_vat: depositVatAmount,
        amount_ttc: depositAmountTTC,
        vat_rate: depositVatRate,
      });
    }
    if (noInvoiceDepositOpen && noInvoiceDepositAmountTTC > 0) {
      const reference = String(noInvoiceDepositDraft.reference || "").trim();
      entries.push({
        reference,
        label: reference || (isInvoice ? "Acompte" : "Acompte demandé"),
        source: isInvoice ? "manual_advance_payment" : "requested_advance",
        amount_ht: noInvoiceDepositAmountHT,
        amount_vat: roundMoney(noInvoiceDepositAmountTTC - noInvoiceDepositAmountHT),
        amount_ttc: noInvoiceDepositAmountTTC,
        vat_rate: noInvoiceDepositVatRate,
        percent: noInvoiceDepositPercent > 0 ? roundMoney(noInvoiceDepositPercent) : undefined,
      });
    }
    return entries;
  }, [
    depositAmountHT,
    depositAmountTTC,
    depositDraft.reference,
    depositDraft.invoice_id,
    depositDraft.quote_id,
    depositDraft.customer_id,
    depositDraft.currency,
    depositPanelOpen,
    depositVatAmount,
    depositVatRate,
    isInvoice,
    lines,
    noInvoiceDepositDraft.reference,
    noInvoiceDepositAmountHT,
    noInvoiceDepositAmountTTC,
    noInvoiceDepositOpen,
    noInvoiceDepositPercent,
    noInvoiceDepositVatRate,
    form.currency,
  ]);
  const advancePaymentTotalTTC = useMemo(
    () => roundMoney(advancePaymentEntries.reduce((sum, entry) => sum + Number(entry.amount_ttc || 0), 0)),
    [advancePaymentEntries],
  );
  const amountDueAfterAdvance = useMemo(
    () => roundMoney(Math.max(totals.totalTTC - advancePaymentTotalTTC, 0)),
    [advancePaymentTotalTTC, totals.totalTTC],
  );
  useEffect(() => {
    if (!documentDiscountOpen || documentDiscountInputMode !== "amount") return;
    const base = Math.max(documentDiscountBaseHT, 0);
    const rawAmount = Math.max(numberInputValue(documentDiscountAmountInput), 0);
    const amount = Math.min(rawAmount, base);
    const nextPercent = base > 0 && amount > 0 ? String(roundMoney((amount / base) * 100)) : "";
    setForm((prev: any) =>
      String(prev.document_discount_percent || "") === nextPercent
        ? prev
        : { ...prev, document_discount_percent: nextPercent },
    );
  }, [documentDiscountAmountInput, documentDiscountBaseHT, documentDiscountInputMode, documentDiscountOpen]);
  useEffect(() => {
    if (documentDiscountInputMode === "amount") return;
    const nextAmount = documentDiscountAmountHT > 0 ? decimalInputValue(documentDiscountAmountHT) : "";
    setDocumentDiscountAmountInput((current) => (current === nextAmount ? current : nextAmount));
  }, [documentDiscountAmountHT, documentDiscountInputMode]);
  const showDocumentDiscountPanel = documentDiscountOpen || documentDiscountPercent > 0;
  const showDiscountSummaryRows = showDocumentDiscountPanel || lineDiscountTotalHT < 0 || documentDiscountTotalHT < 0;
  const showDiscountTtcRows = false;
  const showLineDiscountColumns =
    lineDiscountsEnabled ||
    lineDiscountTotalHT < 0 ||
    lineColumnVisibility.discount ||
    lineColumnVisibility.discountedTotal;
  const showLineNumberColumn = lineColumnVisibility.lineNumber;
  const showLineReferenceColumn = lineColumnVisibility.reference;
  const showQuantityColumn = lineColumnVisibility.quantity;
  const showUnitColumn = lineColumnVisibility.unit;
  const showUnitPriceColumn = lineColumnVisibility.unitPrice;
  const showVatColumn = lineColumnVisibility.vat;
  const showLineDiscountInputColumn = showLineDiscountColumns && lineColumnVisibility.discount;
  const showBaseTotalColumn = lineColumnVisibility.baseTotal;
  const showDiscountedTotalColumn = showLineDiscountColumns && lineColumnVisibility.discountedTotal;
  const summaryTemplateOptions = normalizeTemplateOptionsForForm(form.template_options);
  const showVatTotalsInSummary =
    showVatColumn || advancedComplianceVisible || summaryTemplateOptions.show_vat_totals !== false;
  const lineTableGridClassName = "xl:[grid-template-columns:var(--line-grid-template)]";
  const lineTableGridTemplate = useMemo(() => {
    const columns = ["28px"];
    if (showLineNumberColumn) columns.push("minmax(40px,46px)");
    if (showLineReferenceColumn) columns.push("minmax(112px,0.34fr)");
    columns.push("minmax(220px,1fr)");
    if (showQuantityColumn) columns.push("minmax(48px,58px)");
    if (showUnitColumn) columns.push("minmax(50px,62px)");
    if (showUnitPriceColumn) columns.push("minmax(92px,0.34fr)");
    if (showVatColumn) columns.push("minmax(66px,78px)");
    if (showLineDiscountInputColumn) columns.push("minmax(92px,0.3fr)");
    if (showBaseTotalColumn) columns.push("minmax(108px,0.38fr)");
    if (showDiscountedTotalColumn) columns.push("minmax(112px,0.4fr)");
    return columns.join(" ");
  }, [
    showBaseTotalColumn,
    showDiscountedTotalColumn,
    showLineNumberColumn,
    showLineReferenceColumn,
    showLineDiscountInputColumn,
    showQuantityColumn,
    showUnitColumn,
    showUnitPriceColumn,
    showVatColumn,
  ]);
  const lineTableGridStyle = { "--line-grid-template": lineTableGridTemplate } as CSSProperties;
  const lineControlClassName =
    "h-8 w-full rounded-lg border border-[#cbd5e1] bg-white px-2.5 py-1 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]";
  const lineCompoundControlClassName =
    "flex h-8 w-full items-center rounded-lg border border-[#cbd5e1] bg-white text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe]";
  const lineTextControlFrameClassName =
    "flex h-8 min-w-0 w-full items-center overflow-hidden rounded-lg border border-[#cbd5e1] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe]";
  const numberInputNoSpinnerClassName =
    "[appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none";
  const legalEditableTextClassName =
    "inline border-0 bg-transparent p-0 text-[#475569] outline-none ring-0 shadow-none focus:border-transparent focus:outline-none focus:ring-0 focus-visible:outline-none";
  const legalEditableTextStyle = {
    border: 0,
    boxShadow: "none",
    display: "inline",
    fontSize: "0.78125rem",
    fontWeight: 500,
    lineHeight: 1.7,
    outline: "none",
  } as CSSProperties;
  const compactMoneyStyle = {
    fontSize: "0.75rem",
    fontVariantNumeric: "tabular-nums",
    lineHeight: 1.1,
  } as CSSProperties;
  const lineOrangeControlClassName =
    "h-7 w-full rounded-lg border border-[#fdba74] bg-white px-2.5 py-1 text-[#0f172a] shadow-[0_1px_2px_rgba(194,65,12,0.05)] outline-none transition placeholder:text-[#fb923c] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]";
  const lineOrangeInlineControlClassName =
    "h-7 w-full rounded-lg border border-[#fdba74] bg-white px-2 py-1 text-[#0f172a] shadow-[0_1px_2px_rgba(194,65,12,0.05)] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:text-[#0f172a] focus:ring-2 focus:ring-[#bfdbfe]";
  const unitCodeMenuClassName =
    "absolute left-0 right-0 top-[calc(100%+0.25rem)] z-50 max-h-56 overflow-auto rounded-lg border border-[#fdba74] bg-white p-1 shadow-[0_14px_34px_rgba(15,23,42,0.18)]";
  const unitCodeMenuItemClassName =
    "block w-full rounded-md px-2.5 py-1.5 text-left font-semibold text-[#0f172a] transition hover:bg-[#fff7ed]";
  const destructiveIconButtonClassName =
    "border-[#fecaca] bg-[#fef2f2] text-[#ef4444] hover:border-[#fca5a5] hover:bg-[#fee2e2] hover:text-[#dc2626]";
  const partyContactBlockClassName = "space-y-2.5";
  const partyIdentityGridClassName = "grid gap-y-1";
  const partyIdentityRowClassName = "grid min-w-0 grid-cols-[70px_minmax(0,1fr)] items-start gap-2";
  const partyIdentityLabelClassName = "text-[#94a3b8] [font-size:0.75rem] font-semibold";
  const partyEditIconButtonClassName = isInvoice
    ? "inline-flex h-6 w-6 shrink-0 items-center justify-center justify-self-end rounded-full text-[#2563eb] transition hover:bg-[#eff6ff] hover:text-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe]"
    : "inline-flex h-6 w-6 shrink-0 items-center justify-center justify-self-end rounded-full text-[#7c3aed] transition hover:bg-[#f5f3ff] hover:text-[#6d28d9] focus:outline-none focus:ring-2 focus:ring-[#ddd6fe]";
  const partyEditInputClassName =
    "h-7 min-w-0 rounded-lg border border-[#bfdbfe] bg-white px-2 text-[#0f172a] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]";
  const partyIconClassName = "mt-[0.3125rem] h-3.5 w-3.5 text-[#b6c5d8]";
  const partyIdentityIconClassName = "mt-[0.125rem] h-3.5 w-3.5 text-[#b6c5d8]";
  const partyAddressIconClassName = "mt-2 h-3.5 w-3.5 text-[#b6c5d8]";
  const partyInlineIconClassName = "h-3.5 w-3.5 text-[#b6c5d8]";
  const paperOverlineClassName = "text-[#94a3b8] [font-size:0.78125rem] font-semibold";
  const paperMetaControlClassName =
    "mt-2.5 h-9 w-full rounded-lg border border-[#cbd5e1] bg-white px-3 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]";
  const paperNestedControlClassName =
    "h-9 w-full rounded-lg border border-[#cbd5e1] bg-white px-3 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]";
  const paperInlineControlClassName =
    "box-border block h-8 w-full min-w-0 max-w-full rounded-lg border border-[#cbd5e1] bg-white px-2 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]";
  const lineToolbarButtonBaseClassName =
    "inline-flex h-7 w-auto items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 text-center shadow-none transition";
  const lineToolbarBlueButtonClassName = `${lineToolbarButtonBaseClassName} border-transparent bg-transparent text-[#1d4ed8] hover:border-[#bfdbfe] hover:bg-[#eff6ff] hover:text-[#1e40af]`;
  const lineToolbarOrangeButtonClassName = `${lineToolbarButtonBaseClassName} border-[#fed7aa] bg-white text-[#c2410c] hover:bg-[#fff7ed]`;
  const lineSideActionButtonClassName = isInvoice
    ? "inline-flex h-7 w-7 items-center justify-center rounded-lg text-[#2563eb] transition hover:bg-[#eff6ff] hover:text-[#1d4ed8]"
    : "inline-flex h-7 w-7 items-center justify-center rounded-lg text-[#7c3aed] transition hover:bg-[#f5f3ff] hover:text-[#6d28d9]";
  const lineSideActionMenuClassName = isInvoice
    ? "absolute left-0 top-8 z-50 w-[270px] rounded-xl border border-[#bfdbfe] bg-white p-1.5 text-[#0f172a] shadow-[0_16px_36px_rgba(37,99,235,0.16)]"
    : "absolute left-0 top-8 z-50 w-[270px] rounded-xl border border-[#ddd6fe] bg-white p-1.5 text-[#0f172a] shadow-[0_16px_36px_rgba(124,58,237,0.16)]";
  const lineSideActionMenuItemClassName = isInvoice
    ? "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[#eff6ff]"
    : "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[#f5f3ff]";
  const invoiceDueOffsetDays = signedDiffDays(form.issue_date || form.service_date, form.due_date || form.valid_until);
  const invoiceDueDateInvalid = Boolean((form.due_date || form.valid_until) && invoiceDueOffsetDays < 0);
  const selectedPaymentMethodIds = useMemo(() => {
    const raw = Array.isArray(form.payment_methods) ? form.payment_methods : DEFAULT_PAYMENT_METHOD_IDS;
    return raw
      .map((id: any) => String(id || ""))
      .filter((id: string) => PAYMENT_METHOD_OPTIONS.some((option) => option.id === id));
  }, [form.payment_methods]);
  const defaultLineAccountingAccount = useMemo(
    () => defaultSalesAccountingAccount(form.operation_nature, company?.fec_account_revenue),
    [company?.fec_account_revenue, form.operation_nature],
  );
  const docLabel = isInvoice ? documentCopy.invoiceLabel : documentCopy.quoteLabel;
  const documentTitleLabel = isInvoice ? documentCopy.invoiceTitle : documentCopy.quoteTitle;
  const advancePaymentLabel = isInvoice
    ? documentCopy.advancePaid
    : documentLanguage === "en"
      ? "Requested advance"
      : "Acompte demandé au devis";
  const remainingAfterAdvanceLabel = isInvoice
    ? documentCopy.remainingDue
    : documentLanguage === "en"
      ? "Remaining balance"
      : "Solde après acompte";
  const manualAdvanceOptionLabel =
    documentLanguage === "en"
      ? isInvoice
        ? "Advance already paid"
        : "Requested advance"
      : isInvoice
        ? "Acompte déjà versé"
        : "Acompte demandé";
  const manualAdvanceOptionHelp =
    documentLanguage === "en"
      ? isInvoice
        ? "Deduct an advance already paid without a dedicated invoice."
        : "Ask for an advance to be paid when the quote is accepted."
      : isInvoice
        ? "Déduire un acompte déjà payé sans facture dédiée."
        : "Prévoir un acompte à régler à l'acceptation du devis.";
  const paymentMethodPhrases = PAYMENT_METHOD_PHRASE_ORDER.map((id) =>
    selectedPaymentMethodIds.includes(id) ? PAYMENT_METHOD_TRANSLATIONS[documentLanguage][id]?.phrase : null,
  ).filter(Boolean) as string[];
  const paymentMethodLabel =
    documentLanguage === "en"
      ? paymentMethodPhrases.join(", ") || "payment method to be confirmed"
      : frenchList(paymentMethodPhrases) || "moyen de paiement à définir";
  const primaryPaymentMethodId =
    selectedPaymentMethodIds.find((id: string) => PAYMENT_METHOD_MENU_OPTIONS.some((option) => option.id === id)) ||
    DEFAULT_PAYMENT_METHOD_IDS[0];
  const paymentDelayDays = String(form.payment_delay_days || "").trim() || String(Math.max(0, invoiceDueOffsetDays));
  const vatLegalLineDisplay = companyVatLegalLine(company, documentCopy, vatLegalSourceLines);
  const legalPenaltyRateDisplay = String(form.legal_penalty_rate || "").trim() || "10";
  const legalRecoveryFeeDisplay = String(form.legal_recovery_fee || "").trim() || "40";
  const quoteLegalPenaltyPrefix =
    (isSpecialVatLegalLine(vatLegalLineDisplay) ? vatLegalLineDisplay + " " : "") +
    (documentLanguage === "en"
      ? "No early payment discount applies. In case of late payment on an agreed due date, penalties of"
      : "Aucun escompte n'est accordé en cas de paiement anticipé. En cas de retard sur une échéance de paiement convenue, des pénalités au taux de");
  const legalFooterUsesDefaultText =
    form.legal_terms_default !== false && !normalizeLegalFooterText(form.legal_footer_text);
  const quoteLegalDiscountText = quoteLegalDiscountTextValue(form.legal_discount_text, documentLanguage);
  const legalPenaltyPrefixDisplay = legalFooterUsesDefaultText
    ? isInvoice
      ? vatLegalLineDisplay + " " + documentCopy.latePenaltyPrefix
      : quoteLegalPenaltyPrefix
    : String(form.legal_penalty_prefix || "").trim() ||
      (isInvoice ? vatLegalLineDisplay + " " + documentCopy.latePenaltyPrefix : quoteLegalPenaltyPrefix);
  const legalRecoveryPrefixDisplay = legalFooterUsesDefaultText
    ? documentCopy.recoveryPrefix
    : String(form.legal_recovery_prefix || "").trim() || documentCopy.recoveryPrefix;
  const legalDiscountTextDisplay = isInvoice
    ? legalFooterUsesDefaultText
      ? documentCopy.earlyDiscount
      : String(form.legal_discount_text || "").trim() || documentCopy.earlyDiscount
    : legalFooterUsesDefaultText
      ? quoteLegalDiscountTextValue("", documentLanguage)
      : quoteLegalDiscountText;
  const savedDocumentLegalTemplate = useMemo(
    () => getDocumentLegalTemplate(tenantFeatures, documentLegalTemplateKind),
    [tenantFeatures, documentLegalTemplateKind],
  );
  const savedDocumentLegalTemplateDate = formatLegalTemplateSavedAt(savedDocumentLegalTemplate?.saved_at);
  const documentKindLabel = isInvoice ? "facture" : "devis";
  const documentDateCheckLabel = isInvoice ? "Échéance cohérente" : "Validité cohérente";
  const documentDateCheckHint = isInvoice
    ? "Jamais avant la date du document."
    : "Date de validité présente et jamais avant la date du devis.";
  const readiness = useMemo(() => {
    const companyReady = companyProfileReady;
    const lineReady = invoiceLinesReady;
    const dueReady = !invoiceDueDateInvalid && Boolean(form.due_date || form.valid_until);
    const bankReady = Boolean(paymentBankDisplay?.iban || paymentBankDisplay?.bic);
    const checks = [
      {
        label: "Entreprise complète",
        ok: companyReady,
        required: true,
        hint: companyProfileReady ? "Raison sociale, SIRET et adresse." : companyProfileBlockReason || "",
      },
      {
        label: "Client sélectionné",
        ok: Boolean(selectedCustomer),
        required: true,
        hint: "Choisissez une fiche client existante.",
      },
      {
        label: "Identifiant client",
        ok: customerLegalIdOk,
        required: customerLegalIdRequired,
        hint:
          selectedCustomerCountry === "FR" && selectedCustomerIsBusiness
            ? isInvoice
              ? "SIREN/SIRET requis pour une facture B2B FR."
              : "SIREN/SIRET recommandé avant envoi pour préparer la facture si le devis est accepté."
            : selectedCustomerCountry === "FR"
              ? "Particulier : aucun SIREN/SIRET client requis."
              : "TVA recommandée hors France.",
      },
      {
        label: "Adresse client",
        ok: customerAddressOk,
        required: customerAddressRequired,
        hint: `Nom, adresse, code postal et ville du client doivent apparaître sur ${isInvoice ? "la facture" : "le devis"}.`,
      },
      {
        label: "Au moins une ligne",
        ok: lineReady,
        required: true,
        hint: invoiceLineBlockReason || "Désignation, quantité, prix HT et TVA prêts.",
      },
      {
        label: "Codification TVA",
        ok: rawAdvancedComplianceIssues.length === 0,
        required: rawAdvancedComplianceIssues.length > 0,
        hint:
          rawAdvancedComplianceIssues.length > 0
            ? `${rawAdvancedComplianceIssues.length} ligne(s) à compléter : motif TVA/VATEX requis pour TVA 0% ou catégorie non standard.`
            : "Prête pour les cas TVA avancés si besoin.",
      },
      {
        label: documentDateCheckLabel,
        ok: dueReady,
        required: true,
        hint: documentDateCheckHint,
      },
      {
        label: "Coordonnées de paiement",
        ok: bankReady,
        required: false,
        hint: "IBAN/BIC de l'entreprise émettrice repris dans le document.",
      },
      {
        label: "Adresse de livraison",
        ok: true,
        required: false,
        hint:
          form.delivery_address_differs && !String(form.delivery_address || "").trim()
            ? "Ignorée tant qu'elle reste vide."
            : "Imprimée uniquement si elle diffère de l'adresse de facturation.",
      },
    ];
    return {
      checks,
      score: Math.round((checks.filter((item) => item.ok).length / checks.length) * 100),
    };
  }, [
    companyProfileReady,
    companyProfileBlockReason,
    customerAddressOk,
    customerAddressRequired,
    customerLegalIdOk,
    customerLegalIdRequired,
    form,
    invoiceLineBlockReason,
    invoiceLinesReady,
    isInvoice,
    invoiceDueDateInvalid,
    rawAdvancedComplianceIssues.length,
    selectedCustomer,
    selectedCustomerIsBusiness,
    selectedCustomerCountry,
    paymentBankDisplay?.iban,
    paymentBankDisplay?.bic,
    documentDateCheckHint,
    documentDateCheckLabel,
  ]);
  const invalidAccountingLineLabels = useMemo(() => {
    let itemIndex = 0;
    return lines.flatMap((line, index) => {
      if (String(line?.line_type || "item") !== "item") return [];
      itemIndex += 1;
      const account = sanitizeAccountingAccount(line?.accounting_account);
      if (!account || account.length >= 3) return [];
      return [String(line?.display_number || "").trim() || String(itemIndex || index + 1)];
    });
  }, [lines]);

  const nextPrimaryAction = useMemo(() => {
    if (!companyProfileReady) return companyProfileBlockReason || "Complétez le dossier entreprise.";
    if (!selectedCustomer) return `Choisissez d'abord le client du ${documentKindLabel}.`;
    if (customerLegalIdRequired && !customerLegalIdOk)
      return "Ajoutez le SIREN ou SIRET du client avant de créer cette facture B2B France.";
    if (customerAddressRequired && !customerAddressOk)
      return "Complétez l'adresse du client avant de créer cette facture B2B France.";
    if (!invoiceLinesReady)
      return (
        invoiceLineBlockReason ||
        (isInvoice
          ? "Renseignez la prestation à facturer : désignation, quantité, prix HT et TVA."
          : "Renseignez la prestation du devis : désignation, quantité, prix HT et TVA.")
      );
    if (invalidAccountingLineLabels.length > 0)
      return `Corrigez le compte comptable ligne ${invalidAccountingLineLabels[0]} : minimum 3 caractères.`;
    if (rawAdvancedComplianceIssues.length > 0)
      return `Précisez la codification TVA sur ${rawAdvancedComplianceIssues.length} ligne(s) avant d'enregistrer.`;
    if (totals.totalHT < 0 || totals.totalTTC < 0)
      return "Réduisez la remise : le total du document ne peut pas devenir négatif.";
    if (invoiceDueDateInvalid)
      return isInvoice
        ? "Corrigez l'échéance : elle ne peut pas être avant la date du document."
        : "Corrigez la validité : elle ne peut pas être avant la date du devis.";
    if (isInvoice && !paymentBankDisplay?.iban)
      return "Ajoutez l'IBAN/BIC de l'entreprise si vous voulez l'imprimer sur ce document.";
    if (isEditingExistingInvoice) return "Le brouillon peut être mis à jour puis émis quand tout est prêt.";
    if (isEditingExistingQuote) return "Le devis peut être mis à jour puis renvoyé au client.";
    return isInvoice
      ? "Le document est assez propre pour être créé puis envoyé ou payé."
      : "Le devis est prêt à être créé et envoyé pour accord.";
  }, [
    selectedCustomer,
    companyProfileReady,
    companyProfileBlockReason,
    customerAddressOk,
    customerAddressRequired,
    customerLegalIdOk,
    customerLegalIdRequired,
    invoiceLineBlockReason,
    invoiceLinesReady,
    invalidAccountingLineLabels,
    isInvoice,
    paymentBankDisplay?.iban,
    totals.totalHT,
    totals.totalTTC,
    rawAdvancedComplianceIssues.length,
    invoiceDueDateInvalid,
    isEditingExistingInvoice,
    isEditingExistingQuote,
    documentKindLabel,
  ]);
  const submitBlockReason = useMemo(() => {
    if (lockedInvoiceToEdit) return "Cette facture finalisée n'est pas modifiable dans l'éditeur.";
    if (!companyProfileReady) return companyProfileBlockReason || "Complétez le dossier entreprise.";
    if (!form.customer_id)
      return isInvoice
        ? "Choisissez un client avant d'émettre ou créer la facture."
        : "Choisissez un client avant de créer le devis.";
    if (customerLegalIdRequired && !customerLegalIdOk) return "Renseignez le SIREN ou le SIRET du client.";
    if (customerAddressRequired && !customerAddressOk) return "Complétez l'adresse du client.";
    if (!invoiceLinesReady) return invoiceLineBlockReason || "Complétez les lignes du document.";
    if (invalidAccountingLineLabels.length > 0)
      return `Catégorie compta ligne ${invalidAccountingLineLabels[0]} : minimum 3 caractères.`;
    if (rawAdvancedComplianceIssues.length > 0) return "Précisez le motif TVA 0 demandé.";
    if (totals.totalHT < 0 || totals.totalTTC < 0) return "La remise rend le total négatif.";
    if (invoiceDueDateInvalid)
      return isInvoice ? "Corrigez l'échéance avant création." : "Corrigez la validité avant création.";
    return null;
  }, [
    form.customer_id,
    companyProfileReady,
    companyProfileBlockReason,
    customerAddressRequired,
    customerAddressOk,
    customerLegalIdRequired,
    customerLegalIdOk,
    invoiceLineBlockReason,
    invoiceLinesReady,
    invalidAccountingLineLabels,
    rawAdvancedComplianceIssues.length,
    totals.totalHT,
    totals.totalTTC,
    invoiceDueDateInvalid,
    lockedInvoiceToEdit,
    isInvoice,
  ]);
  const submitDisabled = saving || Boolean(submitBlockReason);

  const compactEditorMode = true;
  const selectedCustomerDefaultId = selectedCustomer?.id || "";
  const selectedCustomerDefaultPaymentTerms = selectedCustomer?.payment_terms_default || "";
  const selectedCustomerDefaultPaymentMethod = selectedCustomer?.payment_method_default || "";

  useEffect(() => {
    if (!selectedCustomerDefaultId || isEditingExistingDocument) return;
    const customerPaymentTerms = String(selectedCustomerDefaultPaymentTerms || "").trim();
    const customerPaymentMethodId = normalizeCustomerPaymentMethodId(selectedCustomerDefaultPaymentMethod);
    setForm((prev: any) => {
      const next = { ...prev };
      let changed = false;
      const currentPaymentTerms = String(prev.payment_terms || "").trim();
      if (customerPaymentTerms && (!currentPaymentTerms || isGenericPaymentTerms(currentPaymentTerms))) {
        const due = dueDateFromPaymentTerms(prev.issue_date || prev.service_date, customerPaymentTerms);
        next.payment_terms = customerPaymentTerms;
        if (due.date) {
          next.due_date = due.date;
          if (!isInvoice) next.valid_until = due.date;
          next.payment_delay_days = String(due.days);
        }
        changed = true;
      }
      const currentPaymentMethods = Array.isArray(prev.payment_methods)
        ? normalizePaymentMethodIds(prev.payment_methods)
        : [];
      if (
        customerPaymentMethodId &&
        (!currentPaymentMethods.length || samePaymentMethodIds(currentPaymentMethods, DEFAULT_PAYMENT_METHOD_IDS))
      ) {
        next.payment_methods = [customerPaymentMethodId];
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [
    selectedCustomerDefaultId,
    selectedCustomerDefaultPaymentTerms,
    selectedCustomerDefaultPaymentMethod,
    isEditingExistingDocument,
    isInvoice,
  ]);

  useEffect(() => {
    if (!selectedCustomer?.id || typeof window === "undefined") return;
    setRecentCustomerIds((prev) => {
      const next = [selectedCustomer.id, ...prev.filter((id) => id !== selectedCustomer.id)].slice(0, 6);
      if (JSON.stringify(next) !== JSON.stringify(prev)) {
        window.localStorage.setItem(RECENT_CUSTOMERS_PREFIX, JSON.stringify(next));
      }
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [selectedCustomer?.id]);

  useEffect(() => {
    setDirectoryEntry(null);
  }, [isInvoice, selectedCustomer?.id]);

  useEffect(() => {
    if (companyVatFranchise) return;
    const defaultVatRate = defaultSalesVatRateNumber(company, selectedCustomer);
    if (!Number.isFinite(defaultVatRate)) return;
    setLines((prev) =>
      prev.map((line, index) =>
        index === 0 && !String(line?.product_name || "").trim()
          ? {
              ...line,
              vat_rate: defaultVatRate,
              vat_category:
                lineVatCategory(line) === defaultVatCategoryForRate(line?.vat_rate)
                  ? defaultVatCategoryForRate(defaultVatRate)
                  : lineVatCategory(line),
            }
          : line,
      ),
    );
  }, [
    company,
    company?.default_sales_vat_rate,
    companyVatFranchise,
    selectedCustomer,
    selectedCustomer?.id,
    selectedCustomer?.default_vat_rate,
  ]);

  const setFormField = (key: string, value: any) => {
    if (key === "due_date") {
      setPaymentPreset(CUSTOM_PAYMENT_PRESET_ID);
    }
    setForm((prev: any) => {
      const next = { ...prev, [key]: value };
      if (key === "due_date") {
        next.payment_delay_days = value
          ? String(Math.max(0, signedDiffDays(prev.issue_date || prev.service_date, value)))
          : "";
        if (!isInvoice) next.valid_until = value;
      }
      if (key === "issue_date" && isInvoice && paymentPreset !== CUSTOM_PAYMENT_PRESET_ID) {
        const preset = PAYMENT_PRESETS.find((item) => item.id === paymentPreset);
        if (preset) {
          const applied = applyPaymentPreset(value || prev.issue_date || prev.service_date, preset.id);
          next.due_date = applied.dueDate;
          next.payment_delay_days = String(applied.preset.days);
        }
      } else if (key === "issue_date" && isInvoice && prev.due_date) {
        next.payment_delay_days = String(
          Math.max(0, signedDiffDays(value || prev.issue_date || prev.service_date, prev.due_date)),
        );
      }
      return next;
    });
  };

  const setDocumentPaymentBankAccount = (bankAccountId: string) => {
    setSelectedBankAccountId(bankAccountId);
    setForm((prev: any) => ({
      ...prev,
      template_options: {
        ...normalizeTemplateOptionsForForm(prev.template_options),
        payment_bank_account: null,
      },
    }));
  };

  const selectInvoiceCustomer = (customerId: string) => {
    setFormField("customer_id", customerId);
    setDepositDraft((prev) =>
      prev.customer_id && prev.customer_id !== customerId
        ? {
            reference: "",
            amount_ht: "",
            vat_rate: defaultAdvanceVatRate,
            invoice_id: "",
            quote_id: "",
            customer_id: "",
            currency: "",
          }
        : prev,
    );
    setClientDropdownOpen(false);
    setCustomerQuery("");
    cancelPartyEdit();
  };

  const currentGlobalVatTemplateDraft = () =>
    normalizeGlobalVatDraft(
      companyVatFranchise
        ? VAT_FRANCHISE_GLOBAL_DRAFT
        : {
            vat_rate: normalizedGlobalVatRate || DEFAULT_GLOBAL_VAT_DRAFT.vat_rate,
            vat_category: globalVatCategory,
            exemption_reason_code: globalVatExemptionReason,
            unit_code: globalVatUnitCode,
          },
    );

  const buildCurrentTemplateOptions = () => ({
    ...buildTemplateOptions(form),
    payment_bank_account: selectedBankAccountTemplatePayload,
    line_columns: lineColumnVisibility,
    document_discount_input_mode: documentDiscountInputMode,
    document_discount_amount_ht: documentDiscountInputMode === "amount" ? documentDiscountAmountInput : "",
    global_vat_enabled: false,
    global_vat_draft: currentGlobalVatTemplateDraft(),
    advance_payments: advancePaymentEntries,
  });

  const applyModelBankAccount = (templateOptions: any) => {
    const paymentBankAccount = templateOptions?.payment_bank_account;
    if (!paymentBankAccount || isCustomerPaymentBankAccount(paymentBankAccount)) return;
    if (paymentBankAccount?.id && bankAccounts.some((account: any) => account?.id === paymentBankAccount.id)) {
      setSelectedBankAccountId(paymentBankAccount.id);
      return;
    }
    if (paymentBankAccount?.iban || paymentBankAccount?.bic) {
      const matchingAccount = bankAccounts.find(
        (account: any) =>
          cleanBic(account?.bic) === cleanBic(paymentBankAccount?.bic) ||
          normalizeIban(account?.iban) === normalizeIban(paymentBankAccount?.iban),
      );
      if (matchingAccount?.id) setSelectedBankAccountId(matchingAccount.id);
    }
  };

  const applyReusableDocumentSnapshot = (snapshot: any, sourceLabel: string) => {
    const sourceForm = snapshot?.form && typeof snapshot.form === "object" ? snapshot.form : {};
    const templateOptions = {
      ...normalizeTemplateOptionsForForm(sourceForm.template_options),
      advance_payments: [],
    };
    setLineColumnVisibility(templateOptions.line_columns);
    setGlobalVatEnabled(Boolean(templateOptions.global_vat_enabled));
    setGlobalVatDraft(normalizeGlobalVatDraft(templateOptions.global_vat_draft));
    const sourceCustomerId = sourceForm.customer_id || "";
    const customerMatch = customers.find((entry: any) => entry.id === sourceCustomerId);
    const extracted = extractEditorState(
      Array.isArray(snapshot?.lines) ? snapshot.lines : [],
      defaultSalesVatRateNumber(company, customerMatch),
    );
    const documentTags = Array.isArray(sourceForm.document_tags)
      ? sourceForm.document_tags.join(", ")
      : String(sourceForm.document_tags ?? templateOptions.document_tags.join(", "));
    const customFields = normalizeCustomFields(sourceForm.custom_fields ?? templateOptions.custom_fields);
    const paymentMethods = normalizePaymentMethodIds(sourceForm.payment_methods ?? templateOptions.payment_methods);

    setForm((prev: any) => ({
      ...prev,
      customer_id: sourceCustomerId || prev.customer_id,
      currency: sourceForm.currency || prev.currency || "EUR",
      payment_terms: sourceForm.payment_terms || prev.payment_terms,
      purchase_order_number: sourceForm.purchase_order_number || "",
      delivery_address: sourceForm.delivery_address || templateOptions.delivery_address || "",
      delivery_address_differs: Boolean(
        sourceForm.delivery_address_differs ?? templateOptions.delivery_address_differs,
      ),
      document_title: sourceForm.document_title || templateOptions.document_title || "",
      note: sourceForm.note || "",
      operation_nature:
        sourceForm.operation_nature || templateOptions.operation_nature || prev.operation_nature || "services",
      facturx_profile: sourceForm.facturx_profile || prev.facturx_profile || "en16931",
      template_key: sourceForm.template_key || prev.template_key || "classic",
      template_options: templateOptions,
      document_language: sourceForm.document_language || templateOptions.document_language,
      document_tags: documentTags,
      custom_fields: customFields,
      document_discount_percent: sourceForm.document_discount_percent ?? extracted.document_discount_percent ?? "",
      payment_methods: paymentMethods,
      payment_delay_days: sourceForm.payment_delay_days || prev.payment_delay_days || "",
      legal_terms_default:
        typeof sourceForm.legal_terms_default === "boolean" ? sourceForm.legal_terms_default : prev.legal_terms_default,
      legal_mentions_text: sourceForm.legal_mentions_text ?? prev.legal_mentions_text,
      legal_footer_text: sourceForm.legal_footer_text ?? prev.legal_footer_text,
      legal_penalty_prefix: sourceForm.legal_penalty_prefix ?? prev.legal_penalty_prefix,
      legal_recovery_prefix: sourceForm.legal_recovery_prefix ?? prev.legal_recovery_prefix,
      legal_discount_text: sourceForm.legal_discount_text ?? prev.legal_discount_text,
      legal_penalty_rate: sourceForm.legal_penalty_rate ?? prev.legal_penalty_rate,
      legal_recovery_fee: sourceForm.legal_recovery_fee ?? prev.legal_recovery_fee,
    }));
    setLines(extracted.lines);
    applyModelBankAccount(templateOptions);
    setPaymentPreset(inferPaymentPreset(sourceForm.payment_terms || ""));
    setNotice(`${sourceLabel} appliqué.`);
  };

  const buildReusableDocumentFormSnapshot = (source: any, templateOptions: any) => ({
    customer_id: source?.customer_id || "",
    currency: source?.currency || "EUR",
    payment_terms: source?.payment_terms || "",
    purchase_order_number: source?.purchase_order_number || "",
    delivery_address: source?.delivery_address || templateOptions.delivery_address || "",
    delivery_address_differs: Boolean(source?.delivery_address_differs ?? templateOptions.delivery_address_differs),
    document_title: source?.document_title || templateOptions.document_title || "",
    note: source?.note || "",
    operation_nature: source?.operation_nature || templateOptions.operation_nature || "services",
    facturx_profile: source?.facturx_profile || "en16931",
    template_key: source?.template_key || "classic",
    template_options: templateOptions,
    document_language: source?.document_language || templateOptions.document_language || "fr",
    document_tags: Array.isArray(source?.document_tags)
      ? source.document_tags.join(", ")
      : String(source?.document_tags ?? templateOptions.document_tags.join(", ")),
    custom_fields: normalizeCustomFields(source?.custom_fields ?? templateOptions.custom_fields),
    document_discount_percent: source?.document_discount_percent ?? "",
    payment_methods: normalizePaymentMethodIds(source?.payment_methods ?? templateOptions.payment_methods),
    payment_delay_days: source?.payment_delay_days || "",
    legal_terms_default: typeof source?.legal_terms_default === "boolean" ? source.legal_terms_default : true,
    legal_mentions_text: source?.legal_mentions_text || "",
    legal_footer_text: source?.legal_footer_text || "",
    legal_penalty_prefix: source?.legal_penalty_prefix || "",
    legal_recovery_prefix: source?.legal_recovery_prefix || "",
    legal_discount_text: source?.legal_discount_text || "",
    legal_penalty_rate: source?.legal_penalty_rate || "10",
    legal_recovery_fee: source?.legal_recovery_fee || "40",
  });

  const buildReusableDocumentTemplatePayload = () => {
    const templateOptions = {
      ...buildCurrentTemplateOptions(),
      advance_payments: [],
    };
    return {
      version: 2,
      document_type: mode,
      form: buildReusableDocumentFormSnapshot(
        {
          ...form,
          template_options: templateOptions,
        },
        templateOptions,
      ),
      lines,
      template_key: form.template_key || "classic",
      template_options: templateOptions,
      payment_terms: form.payment_terms || "",
      operation_nature: form.operation_nature || "services",
      facturx_profile: form.facturx_profile || "en16931",
      saved_at: new Date().toISOString(),
    };
  };

  const persistLocalDocumentTemplates = (templates: any[]) => {
    const normalized = templates
      .filter((entry) => entry?.id && entry?.payload)
      .map((entry) => ({
        id: String(entry.id),
        name: String(entry.name || "Modèle sans nom").trim() || "Modèle sans nom",
        kind: entry.kind || localDocumentTemplateKind,
        saved_at: entry.saved_at || new Date().toISOString(),
        payload: { ...entry.payload, kind: entry.kind || localDocumentTemplateKind },
      }));
    setLocalDocumentTemplates(normalized);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCAL_DOCUMENT_TEMPLATES_STORAGE_KEY, JSON.stringify(normalized));
    }
    return normalized;
  };

  const saveLocalDocumentTemplate = (options: { forceNew?: boolean } = {}) => {
    if (typeof window === "undefined") return;
    const payload = { ...buildReusableDocumentTemplatePayload(), kind: localDocumentTemplateKind };
    window.localStorage.setItem(LOCAL_DOCUMENT_TEMPLATE_STORAGE_KEY, JSON.stringify(payload));
    const typedName = options.forceNew ? "" : localTemplateName.trim();
    const selectedTemplate = options.forceNew
      ? null
      : localDocumentTemplates.find((entry: any) => entry.id === selectedLocalTemplateId);
    const existingByName = typedName
      ? localDocumentTemplates.find(
          (entry: any) =>
            String(entry.name || "")
              .trim()
              .toLowerCase() === typedName.toLowerCase(),
        )
      : null;
    const existing = selectedTemplate || existingByName;
    const customerName = String(selectedCustomer?.name || "").trim();
    const documentTitle = String(form.document_title || "").trim();
    const documentDate = String(form.issue_date || form.quote_date || "").trim();
    const generatedName = [isInvoice ? "Facture" : "Devis", documentTitle || customerName, documentDate]
      .filter(Boolean)
      .join(" · ");
    const name =
      typedName ||
      existing?.name ||
      generatedName ||
      `${isInvoice ? "Facture" : "Devis"} modèle ${localDocumentTemplates.length + 1}`;
    const id = existing?.id || uid();
    const nextTemplates = [
      { id, name, kind: localDocumentTemplateKind, saved_at: payload.saved_at, payload },
      ...localDocumentTemplates.filter((entry: any) => entry.id !== id),
    ].slice(0, 20);
    const savedTemplates = persistLocalDocumentTemplates(nextTemplates);
    setSelectedLocalTemplateId(id);
    setLocalTemplateName(savedTemplates.find((entry: any) => entry.id === id)?.name || name);
    setNotice(`Modèle "${name}" enregistré.`);
  };

  const applyLocalDocumentTemplate = (templateId = selectedLocalTemplateId) => {
    if (typeof window === "undefined") return;
    const selectedTemplate =
      localDocumentTemplates.find((entry: any) => entry.id === templateId) || localDocumentTemplates[0] || null;
    try {
      const payload =
        selectedTemplate?.payload ||
        JSON.parse(window.localStorage.getItem(LOCAL_DOCUMENT_TEMPLATE_STORAGE_KEY) || "null");
      if (!payload) {
        setNotice("Aucun modèle enregistré pour le moment.");
        return;
      }
      if (selectedTemplate?.id) {
        setSelectedLocalTemplateId(selectedTemplate.id);
        setLocalTemplateName(selectedTemplate.name || "");
      }
      if (payload?.form || Array.isArray(payload?.lines)) {
        applyReusableDocumentSnapshot(payload, selectedTemplate?.name || "Modèle");
        return;
      }
      const templateOptions = normalizeTemplateOptionsForForm(payload?.template_options);
      setLineColumnVisibility(templateOptions.line_columns);
      setDocumentDiscountInputMode(templateOptions.document_discount_input_mode === "amount" ? "amount" : "percent");
      setDocumentDiscountAmountInput(String(templateOptions.document_discount_amount_ht || ""));
      setGlobalVatEnabled(Boolean(templateOptions.global_vat_enabled));
      setGlobalVatDraft(normalizeGlobalVatDraft(templateOptions.global_vat_draft));
      setForm((prev: any) => ({
        ...prev,
        template_key: payload?.template_key || prev.template_key || "classic",
        template_options: {
          ...templateOptions,
          advance_payments: [],
        },
        document_title: templateOptions.document_title || prev.document_title || "",
        document_language: templateOptions.document_language,
        document_tags: templateOptions.document_tags.join(", "),
        custom_fields: templateOptions.custom_fields,
        payment_methods: templateOptions.payment_methods,
        legal_terms_default: templateOptions.legal_terms_default,
        legal_mentions_text: templateOptions.legal_mentions_text,
        legal_footer_text: templateOptions.legal_footer_text,
        legal_penalty_prefix: templateOptions.legal_penalty_prefix,
        legal_recovery_prefix: templateOptions.legal_recovery_prefix,
        legal_discount_text: templateOptions.legal_discount_text,
        legal_penalty_rate: templateOptions.legal_penalty_rate,
        legal_recovery_fee: templateOptions.legal_recovery_fee,
        payment_terms: payload?.payment_terms || prev.payment_terms,
        operation_nature: payload?.operation_nature || prev.operation_nature,
        facturx_profile: payload?.facturx_profile || prev.facturx_profile,
      }));
      setNotice(`${selectedTemplate?.name || "Modèle local"} appliqué.`);
    } catch {
      setError("Le modèle local enregistré est illisible.");
    }
  };

  const deleteLocalDocumentTemplate = () => {
    if (!selectedLocalTemplateId) {
      setNotice("Sélectionnez un modèle à supprimer.");
      return;
    }
    const deleted = localDocumentTemplates.find((entry: any) => entry.id === selectedLocalTemplateId);
    const nextTemplates = persistLocalDocumentTemplates(
      localDocumentTemplates.filter((entry: any) => entry.id !== selectedLocalTemplateId),
    );
    const nextSelected = nextTemplates[0] || null;
    setSelectedLocalTemplateId(nextSelected?.id || "");
    setLocalTemplateName(nextSelected?.name || "");
    setNotice(deleted?.name ? `Modèle "${deleted.name}" supprimé.` : "Modèle supprimé.");
  };

  const applySelectedDocumentModel = async (documentId: string) => {
    if (!documentId) return;
    setApplyingDocumentModel(true);
    setError(null);
    try {
      const payload: any = await api(isInvoice ? `/api/cockpit/invoices/${documentId}` : `/api/quotes/${documentId}`);
      const source = isInvoice ? payload?.invoice || payload : payload;
      if (!source?.id) throw new Error("Document modèle introuvable.");
      const templateOptions = {
        ...normalizeTemplateOptionsForForm(source.template_options),
        advance_payments: [],
      };
      setLineColumnVisibility(templateOptions.line_columns);
      const extractedSource = extractEditorState(Array.isArray(source.lines) ? source.lines : [], 20);
      applyReusableDocumentSnapshot(
        {
          form: buildReusableDocumentFormSnapshot(
            {
              ...source,
              document_title: templateOptions.document_title,
              document_language: templateOptions.document_language,
              document_tags: templateOptions.document_tags.join(", "),
              custom_fields: templateOptions.custom_fields,
              document_discount_percent: extractedSource.document_discount_percent,
              payment_methods: templateOptions.payment_methods,
            },
            templateOptions,
          ),
          lines: Array.isArray(source.lines) ? source.lines : [],
        },
        `Modèle repris depuis ${source.number || source.id}`,
      );
    } catch (err) {
      setError(formatApiError(err, "Impossible d'appliquer ce modèle."));
    } finally {
      setApplyingDocumentModel(false);
    }
  };

  const updateLine = (id: string, field: string, value: any) => {
    const currentLine = lines.find((line) => line.id === id);
    if (companyVatFranchise && ["vat_rate", "vat_category", "exemption_reason_code"].includes(field)) {
      setLines((prev) => prev.map((line) => (line.id === id ? franchiseVatLine(line) : line)));
      return;
    }
    const shouldOpenVatReasonPanel =
      (field === "vat_rate" && String(value ?? "").trim() && numberInputValue(value) === 0) ||
      (field === "vat_category" &&
        (String(value || "")
          .trim()
          .toUpperCase() || defaultVatCategoryForRate(currentLine?.vat_rate)) !== "S");
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== id) return line;
        if (field === "vat_rate") {
          const previousDefaultCategory = defaultVatCategoryForRate(line?.vat_rate);
          const nextRate = value;
          const nextDefaultCategory = defaultVatCategoryForRate(nextRate);
          const nextRateNumber = numberInputValue(nextRate);
          const nextCategory =
            nextRateNumber > 0
              ? "S"
              : lineVatCategory(line) === previousDefaultCategory
                ? nextDefaultCategory
                : lineVatCategory(line);
          return {
            ...line,
            vat_rate: value,
            vat_category: nextCategory,
            exemption_reason_code: nextRateNumber > 0 && nextCategory === "S" ? "" : line.exemption_reason_code,
          };
        }
        if (field === "vat_category") {
          const nextCategory =
            String(value || "")
              .trim()
              .toUpperCase() || defaultVatCategoryForRate(line?.vat_rate);
          const nextRate = vatRateForCategory(
            nextCategory,
            line?.vat_rate,
            defaultSalesVatRateNumber(company, selectedCustomer),
          );
          return {
            ...line,
            vat_category: nextCategory,
            vat_rate: nextRate,
            exemption_reason_code:
              nextCategory === "S" && numberInputValue(nextRate) > 0 ? "" : line.exemption_reason_code,
          };
        }
        if (field === "unit_code") {
          return {
            ...line,
            unit_code: String(value || "")
              .trim()
              .toUpperCase()
              .slice(0, 8),
          };
        }
        if (field === "exemption_reason_code") {
          return {
            ...line,
            exemption_reason_code: String(value || "")
              .trim()
              .toUpperCase(),
          };
        }
        if (field === "accounting_account") {
          return {
            ...line,
            accounting_account: sanitizeAccountingAccount(value),
          };
        }
        if (field === "product_name") {
          return {
            ...line,
            product_name: value,
            item_id: String(value || "").trim() === String(line?.product_name || "").trim() ? line.item_id : null,
          };
        }
        if (field === "discount_percent") {
          return {
            ...line,
            discount_percent: value,
            discount_amount_ht: value ? "" : line.discount_amount_ht,
          };
        }
        if (field === "discount_amount_ht") {
          return {
            ...line,
            discount_amount_ht: value,
            discount_percent: value ? "" : line.discount_percent,
          };
        }
        return { ...line, [field]: value };
      }),
    );
    if (shouldOpenVatReasonPanel) {
      setAdvancedComplianceEnabled(true);
      setLineColumnVisibility((current) => ({
        ...current,
        vat: true,
      }));
      setLineComplianceOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setFocusedComplianceField(`${id}:exemption_reason_code`);
    }
  };

  const catalogItemCommentText = (item: any) => String(item?.description || "").trim();

  const buildCatalogItemLines = (item: any, fallbackVatRate: number) =>
    companyVatFranchise
      ? buildSeedLines(
          { ...item, vat_rate: 0, detail: catalogItemCommentText(item), description: catalogItemCommentText(item) },
          0,
        ).map(franchiseVatLine)
      : buildSeedLines(
          { ...item, detail: catalogItemCommentText(item), description: catalogItemCommentText(item) },
          fallbackVatRate,
        );
  const selectedCustomerLineVatRate = companyVatFranchise ? "0" : defaultSalesVatRateInput(company, selectedCustomer);

  const addLine = (seed?: any) => {
    const fallbackVatRate = defaultSalesVatRateNumber(company, selectedCustomer);
    if (!seed) {
      const line = emptyLine(selectedCustomerLineVatRate);
      setLines((prev) => [...prev, companyVatFranchise ? franchiseVatLine(line) : line]);
      return;
    }
    const seedLines = buildSeedLines(seed, fallbackVatRate);
    setLines((prev) => [...prev, ...(companyVatFranchise ? seedLines.map(franchiseVatLine) : seedLines)]);
  };

  const createLineByType = (lineType: "item" | "title" | "comment" = "item") => {
    if (lineType === "item") {
      const line = emptyLine(selectedCustomerLineVatRate);
      return companyVatFranchise ? franchiseVatLine(line) : line;
    }
    return {
      ...emptyLine(),
      line_type: lineType,
      product_name: lineType === "title" ? "Titre de la section" : "",
      detail: "",
      quantity: 0,
      unit_price: 0,
      vat_rate: 0,
      vat_category: "S",
    };
  };

  const addPresentationLine = (lineType: "title" | "comment") => {
    setLines((prev) => [...prev, createLineByType(lineType)]);
    setNotice(lineType === "title" ? "Titre ajouté dans les lignes." : "Commentaire ajouté dans les lignes.");
  };

  const insertLineRelative = (
    id: string,
    position: "above" | "below",
    lineType: "item" | "title" | "comment" = "item",
  ) => {
    setLines((prev) => {
      const index = prev.findIndex((line) => line.id === id);
      if (index === -1) return [...prev, createLineByType(lineType)];
      const range = itemLineGroupRange(prev, index);
      const insertAt = position === "above" ? index : (range?.end ?? index) + 1;
      return [...prev.slice(0, insertAt), createLineByType(lineType), ...prev.slice(insertAt)];
    });
    setLineActionMenuOpenId(null);
    setNotice(position === "above" ? "Ligne ajoutée au-dessus." : "Ligne ajoutée en dessous.");
  };

  const removeLine = (id: string) => {
    const removedIds = lineGroupRemovalIds(lines, id);
    setLines((prev) => removeLineAndAttachedComment(prev, id));
    setLineComplianceOpenIds((prev) => prev.filter((lineId) => !removedIds.includes(lineId)));
    setLineAccountingCustomOpenIds((prev) => prev.filter((lineId) => !removedIds.includes(lineId)));
    setLineActionMenuOpenId((openId) => (openId === id ? null : openId));
  };

  const moveLineTo = (sourceId: string, targetId: string, placement: "before" | "after") => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setLines((prev) => {
      const sourceIndex = prev.findIndex((line) => line.id === sourceId);
      const targetIndex = prev.findIndex((line) => line.id === targetId);
      if (sourceIndex === -1 || targetIndex === -1) return prev;
      const sourceRange = itemLineGroupRange(prev, sourceIndex);
      const targetRange = targetLineBlockRange(prev, targetIndex);
      if (!sourceRange || !targetRange) return prev;
      if (targetRange.start >= sourceRange.start && targetRange.start <= sourceRange.end) return prev;
      const movedLines = prev.slice(sourceRange.start, sourceRange.end + 1);
      const remaining = prev.filter((_, index) => index < sourceRange.start || index > sourceRange.end);
      const nextTargetIndex = remaining.findIndex((line) => line.id === targetId);
      if (nextTargetIndex === -1) return prev;
      const nextTargetRange = targetLineBlockRange(remaining, nextTargetIndex);
      if (!nextTargetRange) return prev;
      const insertIndex = placement === "after" ? nextTargetRange.end + 1 : nextTargetRange.start;
      return [
        ...remaining.slice(0, Math.max(0, Math.min(insertIndex, remaining.length))),
        ...movedLines,
        ...remaining.slice(Math.max(0, Math.min(insertIndex, remaining.length))),
      ];
    });
  };

  const lineDragHandlers = (targetId: string) => ({
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!draggedLineId || draggedLineId === targetId) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      const placement = event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
      event.dataTransfer.dropEffect = "move";
      setLineDragTarget((current) =>
        current?.id === targetId && current?.placement === placement ? current : { id: targetId, placement },
      );
    },
    onDragLeave: () => {
      setLineDragTarget((current) => (current?.id === targetId ? null : current));
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData("text/plain") || draggedLineId || "";
      moveLineTo(sourceId, targetId, lineDragTarget?.id === targetId ? lineDragTarget.placement : "before");
      setDraggedLineId(null);
      setLineDragTarget(null);
      setLineActionMenuOpenId(null);
    },
  });

  const catalogItemName = String(catalogItemForm.name || "").trim();
  const parsedCatalogUnitPrice = Number(String(catalogItemForm.unit_price || "0").replace(",", "."));
  const parsedCatalogVatRate = Number(String(catalogItemForm.vat_rate || "20").replace(",", "."));
  const catalogItemFormCanSave =
    Boolean(catalogItemName) &&
    Number.isFinite(parsedCatalogUnitPrice) &&
    parsedCatalogUnitPrice >= 0 &&
    Number.isFinite(parsedCatalogVatRate) &&
    parsedCatalogVatRate >= 0;
  const catalogEditingItem = useMemo(
    () => catalogItems.find((item) => String(item?.id || "") === String(catalogEditingItemId || "")) || null,
    [catalogEditingItemId, catalogItems],
  );

  const closeCompactPanel = useCallback(() => {
    setActiveCompactPanel(null);
    setCatalogPanelTargetLineId(null);
    setCatalogEditorOpen(false);
    setCatalogEditingItemId(null);
    setCatalogEditorTouched(false);
    setCatalogEditorError(null);
  }, []);

  const resetCatalogEditor = (item?: any, seedLine?: any) => {
    const sourceLine = seedLine || null;
    setCatalogEditingItemId(item?.id || null);
    setCatalogEditorTouched(false);
    setCatalogItemForm({
      name: item?.name || sourceLine?.product_name || "",
      description: item?.description || sourceLine?.detail || "",
      unit_price:
        item?.unit_price != null
          ? String(item.unit_price)
          : sourceLine?.unit_price != null
            ? String(sourceLine.unit_price)
            : "",
      vat_rate: companyVatFranchise
        ? "0"
        : item?.vat_rate != null
          ? String(item.vat_rate)
          : sourceLine?.vat_rate != null
            ? String(sourceLine.vat_rate)
            : defaultSalesVatRateInput(company, selectedCustomer),
      unit_code: item?.unit_code || sourceLine?.unit_code || "",
      active: item?.active !== false,
    });
    setCatalogEditorError(null);
    setCatalogEditorOpen(true);
  };

  const updateCatalogItemForm = (patch: Partial<typeof catalogItemForm>) => {
    setCatalogEditorTouched(true);
    setCatalogItemForm((prev) => ({ ...prev, ...patch }));
  };

  const openCatalogManager = (lineId?: string | null) => {
    setCatalogPanelTargetLineId(lineId || null);
    setCatalogFilterMode("active");
    setCatalogQuery("");
    setCatalogEditorOpen(false);
    setCatalogEditingItemId(null);
    setCatalogEditorTouched(false);
    setCatalogEditorError(null);
    closeLineCatalogMenu();
    setLineActionMenuOpenId(null);
    setActiveCompactPanel("catalog");
  };

  const openCatalogQuickCreate = async (line: any) => {
    const lineId = String(line?.id || "");
    const name = String(line?.product_name || "").trim();
    if (!lineId) return;
    if (!name) {
      openCatalogManager(lineId);
      return;
    }
    const exactMatch =
      catalogItems.find(
        (item) =>
          String(item?.name || "")
            .trim()
            .toLowerCase() === name.toLowerCase(),
      ) || null;
    if (exactMatch) {
      applyCatalogItemToLine(lineId, exactMatch);
      return;
    }
    if (catalogQuickCreateLineId) return;
    const unitPrice = Number(String(line?.unit_price ?? "").replace(",", "."));
    const vatRate = companyVatFranchise
      ? 0
      : Number(String(line?.vat_rate ?? defaultSalesVatRateNumber(company, selectedCustomer)).replace(",", "."));
    const payload = {
      name,
      description: String(line?.detail || "").trim() || null,
      unit_price: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      vat_rate: companyVatFranchise ? 0 : Number.isFinite(vatRate) && vatRate >= 0 ? vatRate : 20,
      unit_code:
        String(line?.unit_code || "")
          .trim()
          .toUpperCase() || "C62",
      active: true,
    };
    setCatalogQuickCreateLineId(lineId);
    closeLineCatalogMenu();
    setLineActionMenuOpenId(null);
    setError(null);
    try {
      const saved: any = await api("/api/items", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setCatalogItems((prev) => {
        const savedId = String(saved?.id || "");
        return savedId ? [saved, ...prev.filter((item) => String(item?.id || "") !== savedId)] : [saved, ...prev];
      });
      applyCatalogItemToLine(lineId, saved);
      setNotice("Article créé dans le catalogue et appliqué à la ligne.");
    } catch (err) {
      setError(formatApiError(err, "Création dans le catalogue impossible."));
    } finally {
      setCatalogQuickCreateLineId(null);
    }
  };

  const applyCatalogItem = (item: any) => {
    if (catalogItemIsOnDocument(item)) {
      setNotice(`Article déjà présent sur le document : ${item?.name || "article"}.`);
      return;
    }
    const fallbackVatRate = defaultSalesVatRateNumber(company, selectedCustomer);
    setLines((prev) => [...prev, ...buildCatalogItemLines(item, fallbackVatRate)]);
    setNotice(`Article ajouté : ${item?.name || "article"}.`);
  };

  const applyCatalogItemFromManager = (item: any) => {
    if (catalogPanelTargetLineId) {
      applyCatalogItemToLine(catalogPanelTargetLineId, item);
      closeCompactPanel();
      return;
    }
    applyCatalogItem(item);
    closeCompactPanel();
  };

  const catalogMatchesForLine = (line: any) => {
    const query = String(line?.product_name || "")
      .trim()
      .toLowerCase();
    if (!query || query.length < 2) return [];
    return catalogItems
      .filter((item) => item?.active !== false)
      .filter((item) => {
        const label = `${item?.name || ""} ${item?.description || ""}`.trim().toLowerCase();
        return (
          label.includes(query) ||
          query.includes(
            String(item?.name || "")
              .trim()
              .toLowerCase(),
          )
        );
      })
      .slice(0, 5);
  };

  const catalogSuggestionsForLine = (line: any) => {
    const matches = catalogMatchesForLine(line);
    if (matches.length) return matches;
    return catalogItems.filter((item) => item?.active !== false).slice(0, 5);
  };

  const catalogExactMatchForLine = (line: any) => {
    const name = String(line?.product_name || "")
      .trim()
      .toLowerCase();
    if (!name) return null;
    return (
      catalogItems.find(
        (item) =>
          String(item?.name || "")
            .trim()
            .toLowerCase() === name,
      ) || null
    );
  };
  const catalogPanelTargetExactMatch = catalogPanelTargetLine ? catalogExactMatchForLine(catalogPanelTargetLine) : null;
  const catalogPanelTargetCanBeSaved = Boolean(
    catalogPanelTargetLine && !catalogPanelTargetExactMatch && String(catalogPanelTargetLine.product_name || "").trim(),
  );

  const applyCatalogItemToLine = (lineId: string, item: any) => {
    const vatRate = Number(item?.vat_rate ?? defaultSalesVatRateNumber(company, selectedCustomer));
    const commentText = catalogItemCommentText(item);
    setLines((prev) => {
      const index = prev.findIndex((line) => line.id === lineId);
      if (index === -1) return prev;
      const currentLine = prev[index];
      const appliedVatRate = companyVatFranchise ? 0 : Number.isFinite(vatRate) ? vatRate : currentLine.vat_rate || 20;
      const previousInlineDetail = String(currentLine?.detail || "").trim();
      const targetCommentText = commentText || previousInlineDetail;
      const next = [...prev];
      next[index] = {
        ...currentLine,
        reference: item?.reference || currentLine.reference || "",
        product_name: item?.name || currentLine.product_name || "",
        detail: "",
        quantity: Number(currentLine?.quantity || 1) || 1,
        unit_price: item?.unit_price ?? currentLine.unit_price ?? "",
        vat_rate: appliedVatRate,
        vat_category: companyVatFranchise ? "E" : defaultVatCategoryForRate(appliedVatRate),
        exemption_reason_code: companyVatFranchise
          ? VAT_FRANCHISE_REASON_CODE
          : currentLine.exemption_reason_code || "",
        unit_code: item?.unit_code || currentLine.unit_code || "C62",
        item_id: item?.id || currentLine.item_id || null,
        accounting_account: item?.accounting_account || currentLine.accounting_account || "",
      };
      const followingLine = next[index + 1];
      const followingText = String(followingLine?.detail || followingLine?.product_name || "").trim();
      const followingIsComment = lineTypeOf(followingLine) === "comment";
      const shouldUpdateFollowingComment = followingIsComment;
      if (targetCommentText) {
        if (shouldUpdateFollowingComment) {
          next[index + 1] = {
            ...followingLine,
            product_name: targetCommentText,
            detail: targetCommentText,
          };
        } else {
          next.splice(index + 1, 0, commentLineFromText(targetCommentText));
        }
      } else if (followingIsComment) {
        next.splice(index + 1, 1);
      }
      return next;
    });
    closeLineCatalogMenu();
    setNotice(`Ligne préremplie depuis le catalogue : ${item?.name || "article"}.`);
  };

  const saveCatalogItem = async () => {
    if (catalogEditorBusy) return;
    if (!catalogItemName) {
      setCatalogEditorError("La désignation de l'article est requise.");
      return;
    }
    if (!Number.isFinite(parsedCatalogUnitPrice) || parsedCatalogUnitPrice < 0) {
      setCatalogEditorError("Prix unitaire HT invalide.");
      return;
    }
    if (!Number.isFinite(parsedCatalogVatRate) || parsedCatalogVatRate < 0) {
      setCatalogEditorError("Taux de TVA invalide.");
      return;
    }
    const normalizedCatalogUnitCode =
      String(catalogItemForm.unit_code || catalogPanelTargetLine?.unit_code || "")
        .trim()
        .toUpperCase() || "C62";
    const payload = {
      name: catalogItemName,
      description: String(catalogItemForm.description || "").trim() || null,
      unit_price: parsedCatalogUnitPrice,
      vat_rate: companyVatFranchise ? 0 : parsedCatalogVatRate,
      unit_code: normalizedCatalogUnitCode,
      active: catalogItemForm.active !== false,
    };
    setCatalogEditorBusy(true);
    setCatalogEditorError(null);
    setError(null);
    try {
      const saved: any = await api(catalogEditingItemId ? `/api/items/${catalogEditingItemId}` : "/api/items", {
        method: catalogEditingItemId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setCatalogItems((prev) => [saved, ...prev.filter((item) => item?.id !== saved?.id)]);
      const applyToTargetLine = Boolean(catalogPanelTargetLineId && saved?.active !== false);
      if (applyToTargetLine && catalogPanelTargetLineId) {
        applyCatalogItemToLine(catalogPanelTargetLineId, saved);
      }
      setCatalogEditorOpen(false);
      setCatalogEditingItemId(null);
      setCatalogEditorTouched(false);
      setNotice(catalogEditingItemId ? "Article mis à jour." : "Article créé dans le catalogue.");
      if (applyToTargetLine) closeCompactPanel();
    } catch (err) {
      setCatalogEditorError(formatApiError(err, "Enregistrement impossible."));
    } finally {
      setCatalogEditorBusy(false);
    }
  };

  const setCatalogItemActive = async (item: any, active: boolean) => {
    if (catalogEditorBusy || !item?.id) return;
    if (
      !active &&
      typeof window !== "undefined" &&
      !window.confirm(`Archiver l'article « ${item.name || "Sans nom"} » ?`)
    ) {
      return;
    }
    setCatalogEditorBusy(true);
    setCatalogEditorError(null);
    setError(null);
    try {
      const saved: any = active
        ? await api(`/api/items/${item.id}`, { method: "PUT", body: JSON.stringify({ active: true }) })
        : await api(`/api/items/${item.id}`, { method: "DELETE" });
      setCatalogItems((prev) =>
        active
          ? [saved, ...prev.filter((entry) => entry?.id !== saved?.id)]
          : prev.map((entry) => (entry?.id === item.id ? { ...entry, active: false } : entry)),
      );
      if (catalogEditingItemId === item.id) {
        setCatalogItemForm((prev) => ({ ...prev, active }));
      }
      setNotice(active ? "Article réactivé." : "Article archivé.");
    } catch (err) {
      setCatalogEditorError(formatApiError(err, active ? "Réactivation impossible." : "Archivage impossible."));
    } finally {
      setCatalogEditorBusy(false);
    }
  };

  const deleteCatalogItemPermanently = async (item: any) => {
    if (catalogEditorBusy || !item?.id) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Supprimer définitivement l'article « ${item.name || "Sans nom"} » ?`)
    ) {
      return;
    }
    setCatalogEditorBusy(true);
    setCatalogEditorError(null);
    setError(null);
    try {
      await api(`/api/items/${encodeURIComponent(String(item.id))}?permanent=true`, { method: "DELETE" });
      setCatalogItems((prev) => prev.filter((entry) => entry?.id !== item.id));
      setCatalogEditorOpen(false);
      setCatalogEditingItemId(null);
      setNotice("Article supprimé du catalogue.");
    } catch (err) {
      setCatalogEditorError(formatApiError(err, "Suppression impossible."));
    } finally {
      setCatalogEditorBusy(false);
    }
  };

  const appendClientNoteSnippet = (kind: "title" | "comment") => {
    const snippet = kind === "title" ? "Titre de section : " : "Commentaire client : ";
    setForm((prev: any) => ({
      ...prev,
      note: [String(prev.note || "").trim(), snippet].filter(Boolean).join("\n\n"),
    }));
    setNotice(
      kind === "title"
        ? "Titre ajouté dans la note visible client."
        : "Commentaire ajouté dans la note visible client.",
    );
  };

  const applyBankAccounts = (accounts: any[], preferredId?: string) => {
    const normalized = Array.isArray(accounts) ? accounts.filter((account) => account?.id) : [];
    const fallback = preferredId ? normalized.find((account) => account.id === preferredId) || null : null;
    setBankAccounts(normalized);
    setSelectedBankAccountId(fallback?.id || "");
    if (fallback?.is_default || (!company?.iban && !company?.bic)) {
      setCompany((prev: any) => ({ ...(prev || {}), iban: fallback?.iban || null, bic: fallback?.bic || null }));
    }
    return fallback;
  };

  const refreshBankAccounts = async (preferredId?: string) => {
    const res = await rawApi("/api/company/bank-accounts");
    if (!res.ok) throw new Error("Impossible de recharger les coordonnées bancaires.");
    const payload = await res.json().catch(() => []);
    return applyBankAccounts(Array.isArray(payload) ? payload : [], preferredId);
  };

  const startNewBankAccount = () => {
    const hasExistingBankDetails = bankAccounts.length > 0 || Boolean(company?.iban || company?.bic);
    setBankDetailsError(null);
    setBankDraft({
      id: "",
      label: hasExistingBankDetails ? "Coordonnées secondaires" : "Coordonnées principales",
      iban: "",
      bic: "",
      is_default: !hasExistingBankDetails,
    });
    setBankEditorOpen(true);
  };

  const startEditBankAccount = () => {
    const account = selectedBankAccount || paymentBankDisplay;
    setBankDetailsError(null);
    setBankDraft({
      id: account?.id || "",
      label: account?.label || "Coordonnées principales",
      iban: formatIbanInput(account?.iban || ""),
      bic: cleanBic(account?.bic || ""),
      is_default: Boolean(account?.is_default),
    });
    setBankEditorOpen(true);
  };

  const saveBankDetails = async () => {
    if (savingBankDetails) return;
    const iban = normalizeIban(bankDraft.iban) || null;
    const bic = cleanBic(bankDraft.bic) || null;
    const scrollBankEditorIntoView = () => {
      window.setTimeout(() => bankEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
    };
    const failBankDetails = (message: string) => {
      setBankDetailsError(message);
      setError(message);
      scrollBankEditorIntoView();
    };
    if (!iban && !bic) {
      failBankDetails("Renseignez au moins un IBAN ou un BIC pour enregistrer les coordonnées bancaires.");
      return;
    }
    if (iban && !isValidIban(iban)) {
      failBankDetails("IBAN invalide. Vérifiez le numéro avant d'enregistrer les coordonnées bancaires.");
      return;
    }
    if (bic && !isValidBic(bic)) {
      failBankDetails("BIC / SWIFT invalide. Le format attendu contient 8 ou 11 caractères.");
      return;
    }
    setSavingBankDetails(true);
    setError(null);
    setBankDetailsError(null);
    try {
      const body = JSON.stringify({
        label: bankDraft.label || "Coordonnées principales",
        iban,
        bic,
        is_default: Boolean(bankDraft.is_default || bankAccounts.length === 0),
      });
      const saved: any = await api(
        bankDraft.id ? `/api/company/bank-accounts/${bankDraft.id}` : "/api/company/bank-accounts",
        { method: bankDraft.id ? "PATCH" : "POST", body },
      );
      await refreshBankAccounts(saved?.id || bankDraft.id);
      setBankEditorOpen(false);
      setNotice(bankDraft.id ? "Coordonnées bancaires mises à jour." : "Coordonnées bancaires ajoutées.");
    } catch (err) {
      setError(formatApiError(err, "Impossible d'enregistrer les coordonnées bancaires."));
      setBankDetailsError(formatApiError(err, "Impossible d'enregistrer les coordonnées bancaires."));
    } finally {
      setSavingBankDetails(false);
    }
  };

  const clearBankDetails = async () => {
    if (savingBankDetails || !selectedBankAccount?.id) return;
    setSavingBankDetails(true);
    setError(null);
    try {
      await api(`/api/company/bank-accounts/${selectedBankAccount.id}`, { method: "DELETE" });
      await refreshBankAccounts();
      setBankEditorOpen(false);
      setNotice("Coordonnées bancaires retirées.");
    } catch (err) {
      setError(formatApiError(err, "Impossible de retirer les coordonnées bancaires."));
    } finally {
      setSavingBankDetails(false);
    }
  };

  const duplicateLine = (id: string) => {
    setLines((prev) => {
      const index = prev.findIndex((line) => line.id === id);
      if (index === -1) return prev;
      const range = itemLineGroupRange(prev, index);
      if (!range) return prev;
      const duplicatedLines = prev.slice(range.start, range.end + 1).map((line) => ({ ...line, id: uid() }));
      return [...prev.slice(0, range.end + 1), ...duplicatedLines, ...prev.slice(range.end + 1)];
    });
    setNotice(isInvoice ? "Ligne de facture dupliquée." : "Ligne de devis dupliquée.");
    setLineActionMenuOpenId(null);
  };

  const clearDocumentDiscount = () => {
    setFormField("document_discount_percent", "");
    setDocumentDiscountOpen(false);
    setDocumentDiscountInputMode("percent");
    setDocumentDiscountAmountInput("");
    setDiscountChoiceOpen(false);
    setDiscountHideMenuOpen(false);
  };

  const setLineDiscountControlsVisible = (visible: boolean) => {
    setLineDiscountsEnabled(visible);
    setLineColumnVisibility((current) => ({
      ...current,
      discount: visible,
      discountedTotal: visible,
    }));
    setDiscountChoiceOpen(false);
    setDiscountHideMenuOpen(false);
    if (!visible) {
      setLines((current) =>
        current.map((line) => ({
          ...line,
          discount_percent: "",
          discount_amount_ht: "",
          discount_input_mode: "percent",
        })),
      );
    }
  };

  const setDocumentDiscountControlsVisible = (visible: boolean) => {
    setDiscountChoiceOpen(false);
    setDiscountHideMenuOpen(false);
    if (visible) {
      setDocumentDiscountOpen(true);
      if (documentDiscountInputMode === "amount" && !String(documentDiscountAmountInput || "").trim()) {
        setDocumentDiscountAmountInput(documentDiscountAmountHT > 0 ? decimalInputValue(documentDiscountAmountHT) : "");
      }
      return;
    }
    clearDocumentDiscount();
  };

  const changeDocumentDiscountInputMode = (mode: "percent" | "amount") => {
    setDocumentDiscountInputMode(mode);
    setDocumentDiscountOpen(true);
    if (mode === "amount") {
      setDocumentDiscountAmountInput(documentDiscountAmountHT > 0 ? decimalInputValue(documentDiscountAmountHT) : "");
    }
  };

  const setLineDiscountInputMode = (id: string, mode: "percent" | "amount") => {
    setLines((current) =>
      current.map((line) => {
        if (line.id !== id) return line;
        if (mode === "amount") {
          const amount = lineDiscountAmountHT(line);
          return {
            ...line,
            discount_input_mode: "amount",
            discount_amount_ht: amount > 0 ? decimalInputValue(amount) : "",
            discount_percent: "",
          };
        }
        const percent = lineDiscountPercent(line);
        return {
          ...line,
          discount_input_mode: "percent",
          discount_percent: percent > 0 ? decimalInputValue(percent) : "",
          discount_amount_ht: "",
        };
      }),
    );
  };

  const selectLineAccountingAccount = (id: string, value: string) => {
    if (value === "custom") {
      setLineAccountingCustomOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      return;
    }
    setLineAccountingCustomOpenIds((prev) => prev.filter((lineId) => lineId !== id));
    updateLine(id, "accounting_account", value);
  };

  const clearLineAccounting = (id: string) => {
    setLines((prev) => prev.map((line) => (line.id === id ? { ...line, accounting_account: "" } : line)));
    setLineAccountingCustomOpenIds((prev) => prev.filter((lineId) => lineId !== id));
  };

  const setAdvancedComplianceOptionsVisible = (visible: boolean) => {
    setAdvancedComplianceEnabled(visible);
    setLineComplianceOpenIds(
      visible
        ? lines
            .filter((line) => String(line?.line_type || "item") === "item")
            .filter(
              (line) =>
                lineNeedsAdvancedComplianceAttention(line, company, documentCopy) ||
                lineHasExplicitAdvancedCompliance(line),
            )
            .map((line) => line.id)
            .filter(Boolean)
        : [],
    );
    if (visible) {
      setLineColumnVisibility((current) => ({
        ...current,
        vat: true,
      }));
    }
  };

  const toggleDocumentPanel = (panel: "clients" | "catalog") => {
    if (panel === "catalog") {
      if (activeCompactPanel === "catalog" && !catalogPanelTargetLineId) {
        closeCompactPanel();
        return;
      }
      openCatalogManager(null);
      return;
    }
    setActiveCompactPanel((current) => {
      if (current === panel) return null;
      setCatalogPanelTargetLineId(null);
      setCatalogEditorOpen(false);
      return panel;
    });
  };

  const toggleLineColumn = (columnId: LineColumnId) => {
    setLineColumnVisibility((current) => {
      const next = { ...current, [columnId]: !current[columnId] };
      if (columnId === "discount" || columnId === "discountedTotal") {
        const visible = next.discount || next.discountedTotal || lineDiscountTotalHT < 0;
        setLineDiscountsEnabled(visible);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!clientDropdownOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!clientChoiceRef.current?.contains(event.target as Node)) {
        setClientDropdownOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setClientDropdownOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clientDropdownOpen]);

  useEffect(() => {
    if (!activeCompactPanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCompactPanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeCompactPanel, closeCompactPanel]);

  useEffect(() => {
    if (
      !lineAddMenuOpen &&
      !lineColumnsMenuOpen &&
      !discountChoiceOpen &&
      !discountHideMenuOpen &&
      !paymentMethodsMenuOpen &&
      !paymentMenuOpen &&
      !sideOptionOpen
    )
      return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLineAddMenuOpen(false);
        setLineColumnsMenuOpen(false);
        setDiscountChoiceOpen(false);
        setDiscountHideMenuOpen(false);
        setPaymentMethodsMenuOpen(false);
        setPaymentMenuOpen(false);
        setSideOptionOpen(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    lineAddMenuOpen,
    lineColumnsMenuOpen,
    discountChoiceOpen,
    discountHideMenuOpen,
    paymentMethodsMenuOpen,
    paymentMenuOpen,
    sideOptionOpen,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LINE_COLUMNS_STORAGE_KEY, JSON.stringify(lineColumnVisibility));
  }, [lineColumnVisibility]);

  useEffect(() => {
    if (!lineColumnsMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!lineColumnsMenuRef.current?.contains(event.target as Node)) {
        setLineColumnsMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [lineColumnsMenuOpen]);

  useEffect(() => {
    if (!legalTemplateMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!legalTemplateMenuRef.current?.contains(event.target as Node)) {
        setLegalTemplateMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLegalTemplateMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [legalTemplateMenuOpen]);

  useEffect(() => {
    if (!lineActionMenuOpenId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-line-action-menu-root="true"]')) return;
      setLineActionMenuOpenId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLineActionMenuOpenId(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [lineActionMenuOpenId]);

  useEffect(() => {
    if (!depositActionMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!depositActionMenuRef.current?.contains(event.target as Node)) {
        setDepositActionMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDepositActionMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [depositActionMenuOpen]);

  useEffect(() => {
    if (!depositInvoiceMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!depositInvoicePickerRef.current?.contains(event.target as Node)) {
        setDepositInvoiceMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDepositInvoiceMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [depositInvoiceMenuOpen]);

  useEffect(() => {
    if (!paymentMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!paymentMenuRef.current?.contains(event.target as Node)) {
        setPaymentMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [paymentMenuOpen]);

  useEffect(() => {
    if (!unitCodeMenuOpenId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-unit-code-menu-root='true']")) {
        setUnitCodeMenuOpenId(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUnitCodeMenuOpenId(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [unitCodeMenuOpenId]);

  const changePaymentPreset = (presetId: string) => {
    if (presetId === CUSTOM_PAYMENT_PRESET_ID) {
      setPaymentPreset(CUSTOM_PAYMENT_PRESET_ID);
      return;
    }
    const applied = applyPaymentPreset(form.issue_date || form.service_date, presetId);
    setPaymentPreset(presetId);
    setForm((prev: any) => ({
      ...prev,
      payment_terms: applied.paymentTerms,
      due_date: applied.dueDate,
      ...(!isInvoice ? { valid_until: applied.dueDate } : {}),
      payment_delay_days: String(
        applied.preset?.days ?? PAYMENT_PRESETS.find((item) => item.id === presetId)?.days ?? "",
      ),
    }));
  };

  const changePaymentTermsManually = (value: string) => {
    setPaymentPreset(CUSTOM_PAYMENT_PRESET_ID);
    setFormField("payment_terms", value);
  };

  const changePrimaryPaymentMethod = (methodId: string) => {
    if (!PAYMENT_METHOD_OPTIONS.some((option) => option.id === methodId)) return;
    setForm((prev: any) => ({ ...prev, payment_methods: [methodId] }));
  };

  const changeLegalPenaltyRate = (value: string) => {
    const cleaned = value
      .replace(/[^\d.,]/g, "")
      .replace(",", ".")
      .slice(0, 6);
    if (!cleaned) return;
    setFormField("legal_penalty_rate", cleaned);
  };

  const changeLegalRecoveryFee = (value: string) => {
    const cleaned = value
      .replace(/[^\d.,]/g, "")
      .replace(",", ".")
      .slice(0, 8);
    if (!cleaned) return;
    setFormField("legal_recovery_fee", cleaned);
  };

  const resetLegalFooterDefaults = () => {
    setForm((prev: any) => ({
      ...prev,
      legal_terms_default: true,
      legal_footer_text: "",
      legal_penalty_prefix: "",
      legal_recovery_prefix: "",
      legal_discount_text: "",
      legal_penalty_rate: "10",
      legal_recovery_fee: "40",
    }));
    setLegalTemplateMenuOpen(false);
  };

  const saveCurrentLegalTemplate = async () => {
    if (legalTemplateSaving) return;
    setLegalTemplateSaving(true);
    setError(null);
    const payload = {
      legal_terms_default: false,
      legal_footer_text: normalizeLegalFooterText(form.legal_footer_text),
      legal_penalty_prefix: String(form.legal_penalty_prefix || legalPenaltyPrefixDisplay || "").trim(),
      legal_recovery_prefix: String(form.legal_recovery_prefix || legalRecoveryPrefixDisplay || "").trim(),
      legal_discount_text: String(form.legal_discount_text || legalDiscountTextDisplay || "").trim(),
      legal_penalty_rate: String(legalPenaltyRateDisplay || "10").trim(),
      legal_recovery_fee: String(legalRecoveryFeeDisplay || "40").trim(),
      saved_at: new Date().toISOString(),
    };
    try {
      const response: any = await api("/api/settings/tenant", {
        method: "PATCH",
        body: JSON.stringify({
          features: {
            document_legal_templates: {
              [documentLegalTemplateKind]: payload,
            },
          },
        }),
      });
      setTenantFeatures((current: any) => ({
        ...(response?.features || current || {}),
        document_legal_templates: {
          ...((response?.features || current || {})?.document_legal_templates || {}),
          [documentLegalTemplateKind]: payload,
        },
      }));
      setLegalTemplateMenuOpen(false);
      setNotice(
        isInvoice
          ? "Modèle de mention facture enregistré pour les prochaines factures."
          : "Modèle de mention devis enregistré pour les prochains devis.",
      );
    } catch (err) {
      setError(formatApiError(err, "Impossible d'enregistrer cette mention comme modèle."));
    } finally {
      setLegalTemplateSaving(false);
    }
  };

  const setPartyDraftField = (field: string, value: string) => {
    setPartyEditDraft((prev) => ({ ...prev, [field]: field === "phone" ? normalizePhoneInput(value) : value }));
  };

  const startPartyEdit = (section: PartyEditSection) => {
    if (section.startsWith("client") && !selectedCustomer?.id) return;
    setError(null);
    setClientDropdownOpen(false);
    setPartyEditSection(section);
    if (section === "issuer-all") {
      setPartyEditDraft({
        name: String(company?.name || ""),
        address_line1: String(company?.address_line1 || company?.address || ""),
        address_line2: String(company?.address_line2 || ""),
        postal_code: String(company?.postal_code || ""),
        city: String(company?.city || ""),
        email_reply_to: companyEmailDisplay,
        phone: companyPhoneDisplay,
        siren: digitsOnly(companySirenDisplay),
        siret: digitsOnly(companySiretDisplay),
        vat_number: companyVatDisplay,
      });
      return;
    }
    if (section === "issuer-contact") {
      setPartyEditDraft({
        name: String(company?.name || ""),
        address_line1: String(company?.address_line1 || company?.address || ""),
        address_line2: String(company?.address_line2 || ""),
        postal_code: String(company?.postal_code || ""),
        city: String(company?.city || ""),
        email_reply_to: companyEmailDisplay,
        phone: companyPhoneDisplay,
      });
      return;
    }
    if (section === "issuer-identity") {
      setPartyEditDraft({
        siren: digitsOnly(companySirenDisplay),
        siret: digitsOnly(companySiretDisplay),
        vat_number: companyVatDisplay,
      });
      return;
    }
    if (section === "client-all") {
      setPartyEditDraft({
        name: String(selectedCustomer?.name || ""),
        address_line1: String(selectedCustomer?.address_line1 || selectedCustomer?.address || ""),
        address_line2: String(selectedCustomer?.address_line2 || ""),
        postal_code: String(selectedCustomer?.postal_code || ""),
        city: String(selectedCustomer?.city || ""),
        email: String(selectedCustomer?.email || ""),
        phone: String(selectedCustomer?.phone || ""),
        siren: String(selectedCustomer?.siren || ""),
        siret: String(selectedCustomer?.siret || ""),
        vat_number: String(selectedCustomer?.vat_number || ""),
      });
      return;
    }
    if (section === "client-contact") {
      setPartyEditDraft({
        name: String(selectedCustomer?.name || ""),
        address_line1: String(selectedCustomer?.address_line1 || selectedCustomer?.address || ""),
        address_line2: String(selectedCustomer?.address_line2 || ""),
        postal_code: String(selectedCustomer?.postal_code || ""),
        city: String(selectedCustomer?.city || ""),
        email: String(selectedCustomer?.email || ""),
        phone: String(selectedCustomer?.phone || ""),
      });
      return;
    }
    setPartyEditDraft({
      siren: String(selectedCustomer?.siren || ""),
      siret: String(selectedCustomer?.siret || ""),
      vat_number: String(selectedCustomer?.vat_number || ""),
    });
  };

  const cancelPartyEdit = () => {
    setPartyEditSection(null);
    setPartyEditDraft({});
  };

  const savePartyEdit = async () => {
    if (!partyEditSection) return;
    setSavingPartyInfo(true);
    setError(null);
    try {
      if (partyEditSection === "issuer-all") {
        const nextSiren = digitsOnly(partyEditDraft.siren);
        const nextSiret = digitsOnly(partyEditDraft.siret);
        const legalId =
          nextSiret && (!nextSiren || nextSiret.startsWith(nextSiren)) ? nextSiret : nextSiren || nextSiret;
        const payload = {
          name: String(partyEditDraft.name || company?.name || "Entreprise").trim(),
          address_line1: String(partyEditDraft.address_line1 || "").trim(),
          address_line2: String(partyEditDraft.address_line2 || "").trim(),
          postal_code: String(partyEditDraft.postal_code || "").trim(),
          city: String(partyEditDraft.city || "").trim(),
          email_reply_to: String(partyEditDraft.email_reply_to || "").trim(),
          phone: String(partyEditDraft.phone || "").trim(),
          siret: legalId,
          vat_number: String(partyEditDraft.vat_number || "")
            .trim()
            .toUpperCase(),
        };
        const updatedCompany: any = await api("/api/company/profile", {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setCompany((prev: any) => ({ ...(prev || {}), ...(updatedCompany || {}), ...payload }));
        setNotice("Informations émetteur mises à jour.");
      } else if (partyEditSection === "issuer-contact") {
        const payload = {
          name: String(partyEditDraft.name || company?.name || "Entreprise").trim(),
          address_line1: String(partyEditDraft.address_line1 || "").trim(),
          address_line2: String(partyEditDraft.address_line2 || "").trim(),
          postal_code: String(partyEditDraft.postal_code || "").trim(),
          city: String(partyEditDraft.city || "").trim(),
          email_reply_to: String(partyEditDraft.email_reply_to || "").trim(),
          phone: String(partyEditDraft.phone || "").trim(),
        };
        const updatedCompany: any = await api("/api/company/profile", {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setCompany((prev: any) => ({ ...(prev || {}), ...(updatedCompany || {}), ...payload }));
        setNotice("Informations émetteur mises à jour.");
      } else if (partyEditSection === "issuer-identity") {
        const nextSiren = digitsOnly(partyEditDraft.siren);
        const nextSiret = digitsOnly(partyEditDraft.siret);
        const legalId =
          nextSiret && (!nextSiren || nextSiret.startsWith(nextSiren)) ? nextSiret : nextSiren || nextSiret;
        const payload = {
          siret: legalId,
          vat_number: String(partyEditDraft.vat_number || "")
            .trim()
            .toUpperCase(),
        };
        const updatedCompany: any = await api("/api/company/profile", {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setCompany((prev: any) => ({ ...(prev || {}), ...(updatedCompany || {}), ...payload }));
        setNotice("Identifiants émetteur mis à jour.");
      } else {
        if (!selectedCustomer?.id) return;
        const isAllEdit = partyEditSection === "client-all";
        const isIdentityEdit = partyEditSection === "client-identity";
        const clientLegalPayload = selectedCustomerIsBusiness
          ? {
              siren: digitsOnly(partyEditDraft.siren),
              siret: digitsOnly(partyEditDraft.siret),
              vat_number: String(partyEditDraft.vat_number || "")
                .trim()
                .toUpperCase(),
            }
          : {
              siren: "",
              siret: "",
              vat_number: "",
            };
        const payload = isAllEdit
          ? {
              name: String(partyEditDraft.name || selectedCustomer?.name || "Client").trim(),
              address_line1: String(partyEditDraft.address_line1 || "").trim(),
              address_line2: String(partyEditDraft.address_line2 || "").trim(),
              postal_code: String(partyEditDraft.postal_code || "").trim(),
              city: String(partyEditDraft.city || "").trim(),
              email: String(partyEditDraft.email || "").trim(),
              phone: String(partyEditDraft.phone || "").trim(),
              ...clientLegalPayload,
            }
          : isIdentityEdit
            ? clientLegalPayload
            : {
                name: String(partyEditDraft.name || selectedCustomer?.name || "Client").trim(),
                address_line1: String(partyEditDraft.address_line1 || "").trim(),
                address_line2: String(partyEditDraft.address_line2 || "").trim(),
                postal_code: String(partyEditDraft.postal_code || "").trim(),
                city: String(partyEditDraft.city || "").trim(),
                email: String(partyEditDraft.email || "").trim(),
                phone: String(partyEditDraft.phone || "").trim(),
              };
        const updatedCustomer: any = await api(`/api/customers/${selectedCustomer.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setCustomers((prev) =>
          prev.map((customer) =>
            customer.id === selectedCustomer.id ? { ...customer, ...(updatedCustomer || {}), ...payload } : customer,
          ),
        );
        setNotice(isIdentityEdit ? "Identifiants client mis à jour." : "Informations client mises à jour.");
      }
      cancelPartyEdit();
    } catch (err: any) {
      setError(formatApiError(err, "Impossible de mettre à jour les informations du document."));
    } finally {
      setSavingPartyInfo(false);
    }
  };

  const issuerContactEditing = partyEditSection === "issuer-all" || partyEditSection === "issuer-contact";
  const issuerIdentityEditing = partyEditSection === "issuer-all" || partyEditSection === "issuer-identity";
  const clientContactEditing = partyEditSection === "client-all" || partyEditSection === "client-contact";
  const clientIdentityEditing = partyEditSection === "client-all" || partyEditSection === "client-identity";

  const renderPartyEditActions = (className = "") => (
    <div className={`flex shrink-0 items-center justify-end gap-1.5 ${className}`}>
      <button
        type="button"
        onClick={cancelPartyEdit}
        disabled={savingPartyInfo}
        aria-label="Annuler"
        className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-[#dbe3ef] bg-white px-2 text-[#64748b] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60"
        style={{ fontSize: "0.6875rem", fontWeight: 850 }}
      >
        X
      </button>
      <button
        type="button"
        onClick={() => void savePartyEdit()}
        disabled={savingPartyInfo}
        className="inline-flex h-7 min-w-9 items-center justify-center rounded-lg bg-[#2563eb] px-2.5 text-white transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: accentColor, fontSize: "0.6875rem", fontWeight: 900 }}
      >
        {savingPartyInfo ? "..." : "OK"}
      </button>
    </div>
  );

  const renderPartyInlineInput = (
    field: string,
    ariaLabel: string,
    options: {
      autoFocus?: boolean;
      className?: string;
      inputMode?: "text" | "email" | "tel" | "numeric";
      mono?: boolean;
      placeholder?: string;
    } = {},
  ) => (
    <input
      aria-label={ariaLabel}
      value={partyEditDraft[field] || ""}
      onChange={(event) => setPartyDraftField(field, event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") void savePartyEdit();
        if (event.key === "Escape") cancelPartyEdit();
      }}
      autoFocus={options.autoFocus}
      inputMode={options.inputMode}
      maxLength={field === "phone" ? 24 : undefined}
      placeholder={options.placeholder}
      className={`${partyEditInputClassName} ${options.mono ? "font-mono" : ""} ${options.className || ""}`}
      style={{ fontSize: "0.8125rem", fontWeight: 750 }}
    />
  );

  const toggleSupplierContactVisibility = (field: "email" | "phone") => {
    const optionKey = field === "email" ? "show_supplier_email" : "show_supplier_phone";
    setForm((prev: any) => {
      const options = normalizeTemplateOptionsForForm(prev.template_options);
      return {
        ...prev,
        template_options: {
          ...options,
          [optionKey]: !options[optionKey],
        },
      };
    });
  };

  const renderSupplierVisibilityToggle = (field: "email" | "phone", visible: boolean) => {
    const HiddenIcon = visible ? Eye : EyeOff;
    const label =
      field === "email"
        ? visible
          ? "Masquer l'email sur le document"
          : "Afficher l'email sur le document"
        : visible
          ? "Masquer le téléphone sur le document"
          : "Afficher le téléphone sur le document";
    return (
      <GuidanceTooltip content={label}>
        <button
          type="button"
          onClick={() => toggleSupplierContactVisibility(field)}
          aria-label={label}
          title={label}
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition ${
            visible
              ? "border-[#cfe0ff] bg-white text-[#2563eb] hover:bg-[#eff6ff]"
              : "border-[#e2e8f0] bg-[#f8fafc] text-[#94a3b8] hover:bg-white"
          }`}
        >
          <HiddenIcon className="h-3.5 w-3.5" />
        </button>
      </GuidanceTooltip>
    );
  };

  const renderTooltipText = (label: string, content: string, className = "", style?: CSSProperties) => (
    <GuidanceTooltip content={content}>
      <span
        tabIndex={0}
        data-document-tooltip-label
        className={`inline-flex cursor-help rounded-sm focus:outline-none focus:ring-2 focus:ring-[#bfdbfe] ${className}`}
        style={style}
      >
        {label}
      </span>
    </GuidanceTooltip>
  );

  const clearDraft = () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem(LINE_COLUMNS_STORAGE_KEY);
      if (isEditingExistingDocument) {
        skipNextAutosaveRef.current = true;
        setNotice("Modifications locales annulées. Rechargement de la version enregistrée…");
        window.setTimeout(() => window.location.reload(), 0);
        return;
      }
    }
    skipNextAutosaveRef.current = true;
    const customerMatch = customers.find((entry: any) => entry?.id === customerSeed) || null;
    const defaultLineVatRate = defaultSalesVatRateInput(company, customerMatch);
    const defaultAdvanceRate = defaultAdvanceVatRateRef.current || defaultAdvanceVatRate || "20";
    setForm(createInitialDocumentForm(customerSeed));
    setLines([emptyLine(defaultLineVatRate)]);
    setPaymentPreset("30");
    setPaymentMenuOpen(false);
    setPaymentMethodsMenuOpen(false);
    setSelectedBankAccountId("");
    setDocumentDiscountOpen(false);
    setDocumentDiscountInputMode("percent");
    setDocumentDiscountAmountInput("");
    setLineDiscountsEnabled(false);
    setGlobalVatEnabled(false);
    setGlobalVatDraft({ ...DEFAULT_GLOBAL_VAT_DRAFT });
    setAdvancedComplianceEnabled(false);
    setDiscountChoiceOpen(false);
    setDiscountHideMenuOpen(false);
    setLineAddMenuOpen(false);
    setLineColumnsMenuOpen(false);
    setDepositActionMenuOpen(false);
    setDepositInvoiceMenuOpen(false);
    setLineColumnVisibility({ ...DEFAULT_LINE_COLUMN_VISIBILITY });
    setLineComplianceOpenIds([]);
    setLineAccountingCustomOpenIds([]);
    setPartyEditSection(null);
    setPartyEditDraft({});
    setCatalogQuery("");
    setCatalogPanelTargetLineId(null);
    setCatalogFilterMode("active");
    setCatalogEditorOpen(false);
    setCatalogEditingItemId(null);
    setCatalogEditorTouched(false);
    setCatalogEditorBusy(false);
    setCatalogQuickCreateLineId(null);
    setCatalogEditorError(null);
    setDirectoryEntry(null);
    setMobileAsideOpen(false);
    setFocusedComplianceField(null);
    setUnitCodeMenuOpenId(null);
    setSideOptionOpen(null);
    setSideOptionsCollapsed(false);
    setDocumentModelQuery("");
    setDocumentModelPickerOpen(false);
    setApplyingDocumentModel(false);
    setSelectedLocalTemplateId("");
    setLocalTemplateName("");
    setLegalTemplateMenuOpen(false);
    setBankEditorOpen(false);
    setBankDetailsError(null);
    setDepositPanelOpen(false);
    setDepositDraft({
      reference: "",
      amount_ht: "",
      vat_rate: defaultAdvanceRate,
      invoice_id: "",
      quote_id: "",
      customer_id: "",
      currency: "",
    });
    setNoInvoiceDepositOpen(false);
    setNoInvoiceDepositInputMode("percent");
    setNoInvoiceDepositDraft({ reference: "", percent: "", amount_ttc: "0,00", vat_rate: defaultAdvanceRate });
    setCustomerQuery("");
    setClientDropdownOpen(false);
    closeLineCatalogMenu();
    setLineActionMenuOpenId(null);
    setDraggedLineId(null);
    setLineDragTarget(null);
    closeCompactPanel();
    setSeedContext(null);
    setError(null);
    setAutosavedAt(null);
    setNotice("Brouillon local effacé.");
  };

  const submit = async (intent: "draft" | "issue" = "draft") => {
    if (saving) return;
    if (intent === "issue" && trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    if (lockedInvoiceToEdit) {
      setError(null);
      setNotice("Cette facture est verrouillée : corrige-la via un avoir ou une duplication.");
      return;
    }
    setSaving(true);
    setSubmitIntent(intent);
    setError(null);
    setNotice(null);
    try {
      if (!companyProfileReady) throw new Error(companyProfileBlockReason || "Complétez le dossier entreprise.");
      if (!form.customer_id) throw new Error("Choisissez un client avant de créer le document.");
      if (customerLegalIdRequired && !customerLegalIdOk) {
        throw new Error("Renseignez le SIREN ou le SIRET du client avant d'enregistrer une facture B2B France.");
      }
      if (customerAddressRequired && !customerAddressOk) {
        throw new Error("Complétez l'adresse du client avant d'enregistrer une facture B2B France.");
      }
      const normalizedLines = lines
        .map((line) => normalizeLine(line, defaultLineAccountingAccount))
        .filter((line) => line.product_name);
      const normalizedItemLines = normalizedLines.filter((line) => line.line_type === "item");
      if (!normalizedItemLines.length) throw new Error("Ajoutez au moins une ligne avec une désignation.");
      if (!invoiceLinesReady) {
        throw new Error(invoiceLineBlockReason || "Complétez les lignes : quantité, prix HT et TVA.");
      }
      if (invalidAccountingLineLabels.length > 0) {
        throw new Error(`Catégorie compta ligne ${invalidAccountingLineLabels[0]} : minimum 3 caractères.`);
      }
      const issueComplianceIssues = rawAdvancedComplianceIssues;
      if (issueComplianceIssues.length > 0) {
        setAdvancedComplianceOptionsVisible(true);
        throw new Error(
          intent === "issue"
            ? `Précisez la codification TVA sur ${issueComplianceIssues.length} ligne(s) avant d'émettre la facture.`
            : `Précisez la codification TVA sur ${issueComplianceIssues.length} ligne(s) avant d'enregistrer le document.`,
        );
      }
      const linesForPayload = companyVatFranchise ? lines.map(franchiseVatLine) : lines;
      const payloadLines = buildPayloadLines(
        linesForPayload,
        form.document_discount_percent,
        defaultLineAccountingAccount,
      );
      const finalPayloadLines = payloadLines;
      if (totals.totalHT < 0 || totals.totalTTC < 0) {
        throw new Error("La remise ou l'acompte est trop élevé : le total du document ne peut pas devenir négatif.");
      }
      if (advancePaymentTotalTTC > Math.max(totals.totalTTC, 0)) {
        throw new Error("L'acompte ne peut pas dépasser le total TTC du document.");
      }
      if (isInvoice && depositPanelOpen && depositAmountTTC > 0 && linkedDepositInvoiceIds.length === 0) {
        throw new Error(
          "Sélectionnez une facture d'acompte existante dans la liste, ou utilisez l'acompte sans facture.",
        );
      }
      if (isInvoice && invoiceKindForPayload === "final" && !quoteIdForPayload) {
        throw new Error("Une facture finale avec acompte facturé doit être liée au devis d'origine.");
      }
      if (invoiceDueDateInvalid) {
        throw new Error(
          isInvoice
            ? "Corrigez l'échéance : elle ne peut pas être avant la date du document."
            : "Corrigez la validité : elle ne peut pas être avant la date du devis.",
        );
      }
      if (intent === "issue" && isInvoice && typeof window !== "undefined") {
        const confirmed = window.confirm(
          "Émettre cette facture ? Un numéro définitif sera attribué et le document ne sera plus un simple brouillon.",
        );
        if (!confirmed) return;
      }
      const currentTemplateOptions = buildCurrentTemplateOptions();
      const invoiceQuoteIdForPayload = invoiceKindForPayload === "standard" ? null : quoteIdForPayload;
      const deliveryAddressForPayload = String(form.delivery_address || "").trim();
      const deliveryAddressDiffersForPayload = Boolean(form.delivery_address_differs && deliveryAddressForPayload);
      const payload = isInvoice
        ? {
            customer_id: form.customer_id,
            currency: form.currency || "EUR",
            note: buildDocumentNote(form, company, true),
            template_key: form.template_key || "classic",
            template_options: currentTemplateOptions,
            payment_terms: form.payment_terms || null,
            due_days: invoiceDueOffsetDays,
            issue_date: form.issue_date || null,
            due_date: form.due_date || null,
            service_date: form.service_date || null,
            purchase_order_number: form.purchase_order_number || null,
            quote_id: invoiceQuoteIdForPayload,
            invoice_kind: invoiceKindForPayload,
            deposit_invoice_ids: linkedDepositInvoiceIds.length ? linkedDepositInvoiceIds : null,
            delivery_address: deliveryAddressDiffersForPayload ? deliveryAddressForPayload : null,
            delivery_address_differs: deliveryAddressDiffersForPayload,
            operation_nature: form.operation_nature || "services",
            ...(einvoicingEnabled ? { facturx_profile: form.facturx_profile || null } : {}),
            lines: finalPayloadLines,
          }
        : {
            customer_id: form.customer_id,
            currency: form.currency || "EUR",
            note: buildDocumentNote(form, company, false),
            template_key: form.template_key || "classic",
            template_options: currentTemplateOptions,
            payment_terms: form.payment_terms || null,
            service_date: form.service_date || null,
            valid_until: form.due_date || form.valid_until || null,
            purchase_order_number: form.purchase_order_number || null,
            lines: payloadLines,
          };
      const createAndIssueInvoice = isInvoice && intent === "issue" && !isEditingExistingInvoice;
      const saved: any =
        isInvoice && isEditingExistingInvoice
          ? await api(`/api/invoices/${editInvoiceId}`, {
              method: "PATCH",
              body: JSON.stringify({
                customer_id: form.customer_id,
                currency: form.currency || "EUR",
                note: buildDocumentNote(form, company, true),
                template_key: form.template_key || "classic",
                template_options: currentTemplateOptions,
                payment_terms: form.payment_terms || null,
                due_days: invoiceDueOffsetDays,
                issue_date: form.issue_date || null,
                due_date: form.due_date || null,
                service_date: form.service_date || null,
                purchase_order_number: form.purchase_order_number || null,
                quote_id: invoiceQuoteIdForPayload,
                invoice_kind: invoiceKindForPayload,
                deposit_invoice_ids: linkedDepositInvoiceIds.length ? linkedDepositInvoiceIds : null,
                delivery_address: deliveryAddressDiffersForPayload ? deliveryAddressForPayload : null,
                delivery_address_differs: deliveryAddressDiffersForPayload,
                operation_nature: form.operation_nature || "services",
                ...(einvoicingEnabled ? { facturx_profile: form.facturx_profile || null } : {}),
                lines: finalPayloadLines,
              }),
            })
          : !isInvoice && isEditingExistingQuote
            ? await api(`/api/quotes/${editQuoteId}`, {
                method: "PATCH",
                body: JSON.stringify({
                  customer_id: form.customer_id,
                  currency: form.currency || "EUR",
                  note: buildDocumentNote(form, company, false),
                  template_key: form.template_key || "classic",
                  template_options: currentTemplateOptions,
                  payment_terms: form.payment_terms || null,
                  purchase_order_number: form.purchase_order_number || null,
                  service_date: form.service_date || null,
                  valid_until: form.due_date || form.valid_until || null,
                  lines: payloadLines,
                }),
              })
            : await api(createAndIssueInvoice ? "/api/invoices?issue=1" : isInvoice ? "/api/invoices" : "/api/quotes", {
                method: "POST",
                body: JSON.stringify(payload),
              });
      if (!saved?.id) throw new Error("Document enregistré mais identifiant introuvable.");

      if (intent === "issue" && isInvoice && !createAndIssueInvoice) {
        setNotice("Émission en cours...");
        const issueResult = await api(`/api/invoices/${saved.id}/issue`, { method: "POST" });
        await waitForMaybeJob(issueResult);
      }

      if (typeof window !== "undefined") {
        const recentPayload = normalizedItemLines
          .filter((line) => Number(line.unit_price || 0) >= 0)
          .filter((line) => line.product_name)
          .slice(0, 8)
          .concat(recentLines)
          .reduce((acc: any[], line: any) => {
            if (
              acc.some(
                (item) =>
                  item.product_name === line.product_name &&
                  Number(item.unit_price || 0) === Number(line.unit_price || 0),
              )
            )
              return acc;
            acc.push(line);
            return acc;
          }, [])
          .slice(0, 10);
        window.localStorage.setItem(recentKey, JSON.stringify(recentPayload));
        window.localStorage.removeItem(storageKey);
      }

      router.push(
        isInvoice
          ? `/app/invoices/${saved.id}`
          : isEditingExistingQuote
            ? `/app/quotes/${saved.id}`
            : `/app/quotes/${saved.id}`,
      );
    } catch (err) {
      setError(
        formatApiError(
          err,
          isInvoice
            ? isEditingExistingInvoice
              ? "Modification de la facture impossible."
              : "Création de la facture impossible."
            : isEditingExistingQuote
              ? "Modification du devis impossible."
              : "Création du devis impossible.",
        ),
      );
    } finally {
      setSaving(false);
      setSubmitIntent(null);
    }
  };

  const applyDepositInvoiceAmounts = (invoice: any) => {
    const totalHT = roundMoney(Number(invoice?.total_ex_vat || 0));
    const totalVAT = roundMoney(Number(invoice?.total_vat || 0));
    const amountHT = totalHT;
    const amountVAT = totalVAT;
    const vatRate = amountHT > 0 ? roundMoney((amountVAT / amountHT) * 100) : 0;
    setDepositDraft({
      reference: invoice?.number || invoice?.id || "",
      amount_ht: decimalInputValue(amountHT),
      vat_rate: String(vatRate || 0),
      invoice_id: String(invoice?.id || ""),
      quote_id: String(invoice?.quote_id || ""),
      customer_id: String(invoice?.customer_id || ""),
      currency: String(invoice?.currency || ""),
    });
    setForm((prev: any) => ({
      ...prev,
      customer_id: prev.customer_id || invoice?.customer_id || "",
      quote_id: invoice?.quote_id || prev.quote_id || "",
      currency: invoice?.currency || prev.currency || "EUR",
    }));
  };

  const selectableDepositInvoiceOptions = useMemo(() => {
    return depositInvoiceOptions.filter((invoice: any) => {
      const status = String(invoice?.status || "").toLowerCase();
      const kind = String(invoice?.invoice_kind || "").toLowerCase();
      if (kind !== "deposit") return false;
      if (["draft", "canceled", "cancelled"].includes(status)) return false;
      if (form.customer_id && invoice?.customer_id && invoice.customer_id !== form.customer_id) return false;
      if (form.currency && invoice?.currency && invoice.currency !== form.currency) return false;
      return true;
    });
  }, [depositInvoiceOptions, form.currency, form.customer_id]);

  const changeDepositReference = async (value: string) => {
    const normalized = value.trim().toLowerCase();
    const selected = selectableDepositInvoiceOptions.find((invoice: any) => {
      const number = String(invoice?.number || "")
        .trim()
        .toLowerCase();
      const id = String(invoice?.id || "")
        .trim()
        .toLowerCase();
      return normalized && (number === normalized || id === normalized);
    });
    if (!selected) {
      setDepositDraft((prev) => ({
        ...prev,
        reference: value,
        amount_ht: normalized ? "" : prev.amount_ht,
        invoice_id: "",
        quote_id: "",
        customer_id: "",
        currency: "",
      }));
      return;
    }
    try {
      const payload: any = await api(`/api/cockpit/invoices/${selected.id}`);
      applyDepositInvoiceAmounts(payload?.invoice || selected);
    } catch {
      applyDepositInvoiceAmounts(selected);
    }
  };
  const filteredDepositInvoiceOptions = useMemo(() => {
    const query = String(depositDraft.reference || "")
      .trim()
      .toLowerCase();
    return selectableDepositInvoiceOptions
      .filter((invoice: any) => {
        if (!query) return true;
        const haystack = [invoice?.number, invoice?.id, invoice?.customer_name, invoice?.status, invoice?.total_inc_vat]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 30);
  }, [depositDraft.reference, selectableDepositInvoiceOptions]);
  const selectDepositInvoice = async (invoice: any) => {
    const value = invoice?.number || invoice?.id || "";
    setDepositInvoiceMenuOpen(false);
    await changeDepositReference(value);
  };
  const isDepositDeductionLine = (line: any) =>
    String(line?.line_type || "item") === "item" &&
    numberInputValue(line?.unit_price) < 0 &&
    /^acompte\b/i.test(String(line?.product_name || "").trim());

  const sideOptionItems: SideOptionItem[] = [
    {
      id: "document",
      label: "Document",
      icon: FileText,
      help: "Ouvrez le dossier entreprise, la fiche client ou effacez uniquement ce brouillon local.",
    },
    {
      id: "models",
      label: "Modèles",
      icon: LayoutTemplate,
      help: "Reprends un document récent ou applique un modèle enregistré pour éviter la ressaisie.",
    },
    {
      id: "vat",
      label: "TVA",
      icon: ReceiptText,
      help: "Règle le mode de TVA et les options nécessaires à la conformité des lignes.",
    },
    {
      id: "discount",
      label: "Remise",
      icon: Coins,
      help: "Affiche les remises globales ou par ligne quand le document en a besoin.",
    },
    {
      id: "deposit",
      label: "Acompte",
      icon: ReceiptText,
      help: "Déduis un acompte déjà facturé ou payé avant le solde final.",
    },
  ];
  const sideOptionButtonClassName =
    "group flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-[#0f172a] transition hover:bg-[#f8fafc]";
  const sideOptionPanelClassName = "border-t border-[#eef2f7] bg-[#fbfdff] px-4 py-3";
  const sideMiniButtonClassName =
    "inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-[#d6deea] bg-white px-2 text-[#334155] shadow-sm transition hover:bg-[#f8fafc]";
  const sideFieldLabelClassName = "block text-[#64748b]";
  const sideFieldClassName =
    "w-full rounded-lg border border-[#d6deea] bg-white px-2 py-1 text-[#0f172a] outline-none transition placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]";
  const sideAccentMiniIconStyle = { color: accentColor } as CSSProperties;
  const sideOptionTone = (id: SideOptionId) => {
    if (id === "document") return { bg: "#ecfdf5", color: "#059669", border: "#bbf7d0" };
    if (id === "models") return { bg: "#eef2ff", color: "#4f46e5", border: "#c7d2fe" };
    if (id === "vat" || id === "discount") return { bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" };
    return { bg: "#fffbeb", color: "#d97706", border: "#fde68a" };
  };
  const sideOptionStatusLabel = (id: SideOptionId) => {
    if (id === "vat" && globalVatEnabled) return "Action";
    if (id === "vat" && advancedComplianceVisible) return "Actif";
    if (id === "discount" && (showDocumentDiscountPanel || showLineDiscountColumns)) return "Actif";
    if (id === "deposit" && (depositPanelOpen || noInvoiceDepositOpen)) return "Actif";
    return null;
  };
  const formatDocumentModelLabel = (document: any) => {
    const reference = String(document?.number || document?.id || (isInvoice ? "Facture" : "Devis"));
    const customerName = String(document?.customer_name || document?.customer?.name || "").trim();
    const amount = Number(document?.total_inc_vat ?? document?.total_ttc ?? document?.total ?? 0);
    const amountLabel =
      Number.isFinite(amount) && amount > 0 ? money(amount, document?.currency || form.currency || "EUR") : "";
    return [reference, customerName, amountLabel].filter(Boolean).join(" - ");
  };
  const sidePrimaryLabel = saving
    ? submitIntent === "issue"
      ? "Émission..."
      : isEditingExistingDocument
        ? "Enregistrement..."
        : "Création..."
    : isInvoice
      ? isEditingExistingInvoice
        ? "Enregistrer"
        : "Créer le brouillon"
      : isEditingExistingQuote
        ? "Enregistrer"
        : "Créer le brouillon";
  const renderSideOptionPanel = (optionId: SideOptionId) => {
    if (optionId === "document") {
      const clearDraftButtonLabel = isEditingExistingDocument
        ? "Revenir à la version enregistrée"
        : "Supprimer le brouillon local";
      const clearDraftTooltip = isEditingExistingDocument
        ? "Annule seulement les modifications conservées dans ce navigateur et recharge la version déjà enregistrée."
        : "Efface uniquement la saisie conservée dans ce navigateur. Le document déjà enregistré n'est pas supprimé.";
      const ClearDraftIcon = isEditingExistingDocument ? ArrowLeft : Trash2;
      return (
        <div className={`${sideOptionPanelClassName} space-y-2.5`}>
          <div className="grid gap-1.5">
            <GuidanceTooltip content="Complétez les informations légales qui seront reprises sur vos factures et devis.">
              <Link
                to="/app/company"
                className={`${sideMiniButtonClassName} w-full justify-start`}
                style={{ fontSize: "0.6875rem", fontWeight: 800 }}
              >
                <Building2 className="h-3.5 w-3.5" style={sideAccentMiniIconStyle} /> Dossier entreprise
              </Link>
            </GuidanceTooltip>
            {selectedCustomer ? (
              <GuidanceTooltip
                content={
                  selectedCustomerShowsLegalIdentity
                    ? "Ouvrez la fiche client pour vérifier l'adresse, le SIRET et les contacts."
                    : "Ouvrez la fiche client pour vérifier l'adresse et les contacts."
                }
              >
                <Link
                  to={`/app/customers/${selectedCustomer.id}`}
                  className={`${sideMiniButtonClassName} w-full justify-start`}
                  style={{ fontSize: "0.6875rem", fontWeight: 800 }}
                >
                  <User className="h-3.5 w-3.5" style={sideAccentMiniIconStyle} /> Ouvrir le client
                </Link>
              </GuidanceTooltip>
            ) : null}
          </div>
          <GuidanceTooltip content={clearDraftTooltip}>
            <button
              type="button"
              onClick={clearDraft}
              className={`${sideMiniButtonClassName} w-full justify-start text-[#dc2626] hover:bg-[#fef2f2]`}
              style={{ fontSize: "0.6875rem", fontWeight: 800 }}
            >
              <ClearDraftIcon className="h-3.5 w-3.5" /> {clearDraftButtonLabel}
            </button>
          </GuidanceTooltip>
        </div>
      );
    }

    if (optionId === "models") {
      return (
        <div className={`${sideOptionPanelClassName} space-y-3`}>
          <div
            className="relative"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDocumentModelPickerOpen(false);
              }
            }}
          >
            <Search className="pointer-events-none absolute left-2.5 top-3.5 h-3.5 w-3.5 -translate-y-1/2 text-[#94a3b8]" />
            <input
              data-testid="document-model-search"
              aria-label={isInvoice ? "Reprendre une facture existante" : "Reprendre un devis existant"}
              value={documentModelQuery}
              disabled={applyingDocumentModel}
              onChange={(event) => {
                setDocumentModelQuery(event.target.value);
                setDocumentModelPickerOpen(true);
              }}
              onFocus={() => setDocumentModelPickerOpen(true)}
              onClick={() => setDocumentModelPickerOpen(true)}
              placeholder={
                applyingDocumentModel
                  ? "Application du document..."
                  : isInvoice
                    ? "Reprendre une facture existante..."
                    : "Reprendre un devis existant..."
              }
              className={`${sideFieldClassName} pl-8 disabled:cursor-wait disabled:bg-[#f8fafc]`}
              style={{ fontSize: "0.6875rem", fontWeight: 750 }}
            />
            {documentModelPickerOpen ? (
              <div
                data-testid="document-model-select"
                className="absolute left-0 right-0 top-[2.1rem] z-20 max-h-56 overflow-auto rounded-lg border border-[#d6deea] bg-white p-1.5 shadow-[0_14px_30px_rgba(15,23,42,0.14)]"
              >
                <div className="px-2 py-1 text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 850 }}>
                  {isInvoice ? "Factures existantes" : "Devis existants"}
                </div>
                {filteredDocumentModelOptions.length ? (
                  filteredDocumentModelOptions.map((document: any) => (
                    <button
                      key={document.id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDocumentModelPickerOpen(false);
                        void applySelectedDocumentModel(document.id);
                      }}
                      className="block w-full rounded-md px-2 py-1.5 text-left text-[#0f172a] hover:bg-[#f8fafc]"
                      style={{ fontSize: "0.6875rem", fontWeight: 750 }}
                    >
                      <span className="block truncate">{formatDocumentModelLabel(document)}</span>
                      <span className="block truncate text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 650 }}>
                        {document?.status || "document"} · reprendre ce contenu
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-2 py-2 text-[#64748b]" style={{ fontSize: "0.6875rem", fontWeight: 700 }}>
                    Aucun document existant trouvé
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2 text-[#94a3b8]" style={{ fontSize: "0.625rem", fontWeight: 850 }}>
            <span className="h-px flex-1 bg-[#e2e8f0]" />
            ou
            <span className="h-px flex-1 bg-[#e2e8f0]" />
          </div>

          <div className="grid gap-1.5">
            <div className="text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 850 }}>
              Modèles enregistrés
            </div>
            <select
              aria-label="Choisir un modèle enregistré"
              value={selectedLocalTemplateId}
              onChange={(event) => {
                const value = event.target.value;
                if (!value) return;
                const selectedTemplate = localDocumentTemplates.find((entry: any) => entry.id === value);
                setSelectedLocalTemplateId(value);
                setLocalTemplateName(selectedTemplate?.name || "");
                applyLocalDocumentTemplate(value);
              }}
              className={sideFieldClassName}
              style={{
                fontSize: "0.6875rem",
                fontWeight: 750,
                color: selectedLocalTemplateId ? "#0f172a" : "#94a3b8",
              }}
            >
              <option value="" disabled hidden>
                Modèle enregistré
              </option>
              {localDocumentTemplates.map((template: any) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            <GuidanceTooltip
              content={
                isInvoice
                  ? "Enregistre la facture actuelle comme modèle réutilisable."
                  : "Enregistre le devis actuel comme modèle réutilisable."
              }
            >
              <button
                type="button"
                data-testid="save-document-model-button"
                onClick={() => saveLocalDocumentTemplate({ forceNew: true })}
                className={`${sideMiniButtonClassName} w-full justify-start`}
                style={{ fontSize: "0.625rem", fontWeight: 800 }}
              >
                <Save className="h-3 w-3" style={sideAccentMiniIconStyle} />{" "}
                {isInvoice ? "Enregistrer cette facture comme modèle" : "Enregistrer ce devis comme modèle"}
              </button>
            </GuidanceTooltip>
            {selectedLocalTemplateId ? (
              <GuidanceTooltip content="Supprime seulement ce modèle enregistré localement, pas les factures ou devis existants.">
                <button
                  type="button"
                  onClick={deleteLocalDocumentTemplate}
                  className={`${sideMiniButtonClassName} w-full justify-start text-[#dc2626] hover:bg-[#fef2f2]`}
                  style={{ fontSize: "0.625rem", fontWeight: 800 }}
                >
                  <Trash2 className="h-3 w-3" /> Supprimer ce modèle
                </button>
              </GuidanceTooltip>
            ) : null}
            {!localDocumentTemplates.length ? (
              <div className="text-[#94a3b8]" style={{ fontSize: "0.625rem", fontWeight: 700 }}>
                Aucun modèle enregistré.
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    if (optionId === "vat") {
      return (
        <div className={`${sideOptionPanelClassName} space-y-2`}>
          <label
            className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 transition ${
              companyVatFranchise ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${
              globalVatEnabled && !companyVatFranchise
                ? "border-[#2563eb] bg-[#eff6ff] text-[#1d4ed8]"
                : "border-[#dbeafe] bg-white text-[#334155] hover:bg-[#f8fbff]"
            }`}
            style={{ fontSize: "0.6875rem", fontWeight: 850, lineHeight: 1.25 }}
            title={companyVatFranchise ? "Franchise en base : la TVA est déjà verrouillée à 0 %." : undefined}
          >
            <input
              type="checkbox"
              checked={companyVatFranchise ? false : globalVatEnabled}
              disabled={companyVatFranchise}
              onChange={(event) => {
                if (companyVatFranchise) return;
                const checked = event.target.checked;
                setGlobalVatEnabled(checked);
                if (checked) {
                  setLineColumnVisibility((current) => ({ ...current, vat: true }));
                  setGlobalVatDraft((prev) => {
                    const currentRate = String(prev.vat_rate || "").trim() || "20";
                    const currentCategory =
                      String(prev.vat_category || "")
                        .trim()
                        .toUpperCase() || defaultVatCategoryForRate(currentRate);
                    return {
                      ...prev,
                      vat_rate: currentRate,
                      vat_category:
                        numberInputValue(currentRate) > 0 ? "S" : currentCategory === "S" ? "O" : currentCategory,
                    };
                  });
                }
              }}
              className="mt-0.5 h-3.5 w-3.5 rounded accent-[#2563eb]"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[#1d4ed8]" style={{ fontSize: "0.75rem", fontWeight: 900 }}>
                Appliquer à toutes les lignes
              </span>
              <span className="mt-0.5 block text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 650 }}>
                Raccourci de saisie : les lignes restent modifiables après application.
              </span>
            </span>
          </label>
          {globalVatEnabled ? (
            <div
              className="rounded-lg border border-[#bfdbfe] bg-[#f8fbff] p-2.5 text-[#0f172a]"
              style={{ fontSize: "0.6875rem", fontWeight: 800 }}
            >
              <div className="grid gap-2">
                <label className="grid gap-1">
                  <span className="text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 900 }}>
                    Taux
                  </span>
                  <div
                    className={`flex h-9 overflow-hidden rounded-lg border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe] ${
                      globalVatNeedsReason && !globalVatExemptionReason ? "border-[#fdba74]" : "border-[#cbd5e1]"
                    }`}
                  >
                    <input
                      aria-label="Taux de TVA à appliquer aux lignes"
                      inputMode="decimal"
                      value={globalVatDraft.vat_rate}
                      onChange={(event) => {
                        const nextRate = event.target.value;
                        const nextRateNumber = numberInputValue(nextRate);
                        setGlobalVatDraft((prev) => ({
                          ...prev,
                          vat_rate: nextRate,
                          vat_category: nextRateNumber > 0 ? "S" : prev.vat_category === "S" ? "O" : prev.vat_category,
                          exemption_reason_code: nextRateNumber > 0 ? "" : prev.exemption_reason_code,
                        }));
                      }}
                      placeholder="0"
                      className="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-right text-[#0f172a] shadow-none outline-none ring-0 placeholder:text-[#94a3b8] focus:border-transparent focus:outline-none focus:ring-0 focus-visible:outline-none"
                      style={{ fontSize: "0.8125rem", fontWeight: 850 }}
                    />
                    <span
                      className={`flex h-full w-9 items-center justify-center border-l ${
                        globalVatNeedsReason
                          ? "border-[#fed7aa] bg-[#fff7ed] text-[#c2410c]"
                          : "border-[#e2e8f0] bg-[#f8fafc] text-[#64748b]"
                      }`}
                      style={{ fontSize: "0.75rem", fontWeight: 900 }}
                    >
                      %
                    </span>
                  </div>
                </label>

                <label className="grid gap-1">
                  <span className="text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 900 }}>
                    Catégorie
                  </span>
                  <span className="relative block">
                    <select
                      aria-label="Catégorie TVA à appliquer aux lignes"
                      value={globalVatCategory}
                      onChange={(event) => {
                        const nextCategory = String(event.target.value || "S").toUpperCase();
                        setGlobalVatDraft((prev) => {
                          const nextRate = vatRateForCategory(
                            nextCategory,
                            prev.vat_rate,
                            defaultSalesVatRateNumber(company, selectedCustomer),
                          );
                          return {
                            ...prev,
                            vat_rate: String(nextRate),
                            vat_category: nextCategory,
                            exemption_reason_code:
                              nextCategory === "S" && nextRate > 0 ? "" : prev.exemption_reason_code,
                          };
                        });
                      }}
                      className="h-9 w-full appearance-none rounded-lg border border-[#cbd5e1] bg-white px-2 pr-8 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                      style={{ fontSize: "0.75rem", fontWeight: 800 }}
                    >
                      {VAT_CATEGORY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748b]"
                    />
                  </span>
                </label>

                <label className="grid gap-1">
                  <span className="text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 900 }}>
                    Motif ou VATEX
                  </span>
                  <input
                    aria-label="Motif TVA 0 à appliquer aux lignes"
                    value={globalVatDraft.exemption_reason_code}
                    onChange={(event) =>
                      setGlobalVatDraft((prev) => ({
                        ...prev,
                        exemption_reason_code: event.target.value,
                      }))
                    }
                    placeholder={
                      globalVatNeedsReason ? "Ex : article 293 B, VATEX..." : "Uniquement si TVA 0 ou non standard"
                    }
                    disabled={!globalVatNeedsReason}
                    className={`h-9 w-full rounded-lg border px-2 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition placeholder:text-[#cbd5e1] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe] disabled:bg-[#f8fafc] disabled:text-[#94a3b8] ${
                      globalVatNeedsReason && !globalVatExemptionReason ? "border-[#fdba74]" : "border-[#cbd5e1]"
                    }`}
                    style={{ fontSize: "0.75rem", fontWeight: 800 }}
                  />
                </label>

                <div>
                  <button
                    type="button"
                    onClick={() => {
                      applyGlobalVatToLines();
                      if (globalVatNeedsReason && !globalVatExemptionReason) {
                        setNotice("TVA appliquée aux lignes. Renseignez le motif ou VATEX pour compléter la mention.");
                        return;
                      }
                      setNotice("TVA appliquée aux lignes. Les lignes restent modifiables.");
                    }}
                    className="inline-flex h-9 w-full shrink-0 items-center justify-center rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-3 text-[#1d4ed8] transition hover:border-[#93c5fd] hover:bg-[#dbeafe] focus:border-[#2563eb] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe]"
                    style={{ fontSize: "0.6875rem", fontWeight: 900 }}
                  >
                    Appliquer aux lignes
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      );
    }

    if (optionId === "discount") {
      const lineDiscountEnabled = showLineDiscountColumns;
      const globalDiscountEnabled = showDocumentDiscountPanel;
      return (
        <div className={`${sideOptionPanelClassName} space-y-2`}>
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 transition ${
              lineDiscountEnabled
                ? "border-[#c2410c] bg-[#fff7ed] text-[#9a3412]"
                : "border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f8fafc]"
            }`}
            style={{ fontSize: "0.6875rem", fontWeight: 850, lineHeight: 1.25 }}
          >
            <input
              type="checkbox"
              checked={lineDiscountEnabled}
              onChange={(event) => setLineDiscountControlsVisible(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded accent-[#c2410c]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">Remise par ligne</span>
              <span className="mt-0.5 block text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 650 }}>
                Affiche une remise différente sur chaque ligne.
              </span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 transition ${
              globalDiscountEnabled
                ? "border-[#c2410c] bg-[#fff7ed] text-[#9a3412]"
                : "border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f8fafc]"
            }`}
            style={{ fontSize: "0.6875rem", fontWeight: 850, lineHeight: 1.25 }}
          >
            <input
              type="checkbox"
              checked={globalDiscountEnabled}
              onChange={(event) => setDocumentDiscountControlsVisible(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded accent-[#c2410c]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">Remise globale</span>
              <span className="mt-0.5 block text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 650 }}>
                S'applique au total après les remises de ligne.
              </span>
            </span>
          </label>
          {globalDiscountEnabled ? (
            <div
              className="rounded-lg border border-[#fed7aa] bg-[#fffaf2] px-2.5 py-2 text-[#9a3412]"
              style={{ fontSize: "0.625rem", fontWeight: 750, lineHeight: 1.35 }}
            >
              La remise globale se modifie dans le total, sur la ligne {documentCopy.discountHT}.
            </div>
          ) : null}
        </div>
      );
    }

    if (optionId === "deposit") {
      return (
        <div className={`${sideOptionPanelClassName} space-y-2`}>
          {isInvoice ? (
            <label
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-[#bfdbfe] bg-white px-2.5 py-2 text-[#0f172a] transition hover:bg-[#eff6ff]"
              style={{ fontSize: "0.6875rem", fontWeight: 850, lineHeight: 1.35 }}
            >
              <input
                type="checkbox"
                checked={depositPanelOpen}
                onChange={(event) => setDepositPanelOpen(event.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-[#bfdbfe] accent-[#2563eb]"
              />
              <span>
                <span className="block">Acompte facturé</span>
                <span className="block font-semibold text-[#64748b]" style={{ fontSize: "0.625rem" }}>
                  Déduire une facture d'acompte existante.
                </span>
              </span>
            </label>
          ) : null}
          <label
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-[#bfdbfe] bg-white px-2.5 py-2 text-[#0f172a] transition hover:bg-[#eff6ff]"
            style={{ fontSize: "0.6875rem", fontWeight: 850, lineHeight: 1.35 }}
          >
            <input
              type="checkbox"
              checked={noInvoiceDepositOpen}
              onChange={(event) => {
                const checked = event.target.checked;
                setNoInvoiceDepositOpen(checked);
                if (checked) {
                  setNoInvoiceDepositInputMode("percent");
                  setNoInvoiceDepositDraft((prev) => ({
                    percent: prev.percent || NO_INVOICE_DEPOSIT_DEFAULT_PERCENT,
                    amount_ttc:
                      prev.amount_ttc && numberInputValue(prev.amount_ttc) > 0
                        ? prev.amount_ttc
                        : decimalInputValue(
                            roundMoney(
                              totals.totalTTC *
                                (numberInputValue(prev.percent || NO_INVOICE_DEPOSIT_DEFAULT_PERCENT) / 100),
                            ),
                          ),
                    reference: prev.reference || "",
                    vat_rate: prev.vat_rate || defaultAdvanceVatRate,
                  }));
                } else {
                  setNoInvoiceDepositInputMode("percent");
                  setNoInvoiceDepositDraft({
                    reference: "",
                    percent: "",
                    amount_ttc: "0,00",
                    vat_rate: defaultAdvanceVatRate,
                  });
                }
              }}
              className="mt-0.5 h-3.5 w-3.5 rounded border-[#bfdbfe] accent-[#2563eb]"
            />
            <span>
              <span className="block">{manualAdvanceOptionLabel}</span>
              <span className="block font-semibold text-[#64748b]" style={{ fontSize: "0.625rem" }}>
                {manualAdvanceOptionHelp}
              </span>
            </span>
          </label>
        </div>
      );
    }

    return null;
  };
  const createInvoicePrimaryIssue = isInvoice && !isEditingExistingInvoice && !trialDraftOnly;
  const mobilePrimarySubmitIntent: "draft" | "issue" = createInvoicePrimaryIssue ? "issue" : "draft";
  const mobilePrimaryLabel = saving
    ? mobilePrimarySubmitIntent === "issue"
      ? "Émission..."
      : isEditingExistingDocument
        ? "Enregistrement..."
        : "Création..."
    : mobilePrimarySubmitIntent === "issue"
      ? "Émettre facture"
      : isEditingExistingDocument
        ? "Enregistrer"
        : "Créer";
  const sideOptionsCard = (
    <Card
      padding={false}
      data-testid="invoice-side-options"
      className="pf-invoice-card overflow-hidden border border-[#dbe4ef] bg-white"
      style={{ boxShadow: "var(--pf-invoice-card-shadow)" }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[#eef2f7] bg-white px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 750 }}>
            Options avancées
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setSideOptionOpen(null);
            setSideOptionsCollapsed(true);
            if (compactEditorMode) setMobileAsideOpen(false);
          }}
          aria-label="Réduire les options avancées"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[#dbe4ef] bg-white text-[#64748b] hover:bg-[#f8fafc] hover:text-[#0f172a]"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {sideOptionsCollapsed ? (
        <div className="border-b border-[#eef2f7] bg-white px-4 py-3">
          <button
            type="button"
            onClick={() => {
              setSideOptionsCollapsed(false);
              setSideOptionOpen("document");
            }}
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-[#d6deea] bg-white text-[#334155] transition hover:bg-[#f8fafc]"
            style={{ fontSize: "0.78125rem", fontWeight: 850 }}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Afficher les options
          </button>
        </div>
      ) : (
        <div className="divide-y divide-[#eef2f7]">
          {sideOptionItems.map((item) => {
            const Icon = item.icon;
            const active = sideOptionOpen === item.id;
            const statusLabel = sideOptionStatusLabel(item.id);
            const tone = sideOptionTone(item.id);
            const highlighted = active || Boolean(statusLabel);
            return (
              <div key={item.id}>
                <GuidanceTooltip content={item.help} side="left">
                  <button
                    type="button"
                    onClick={() => {
                      setSideOptionsCollapsed(false);
                      setSideOptionOpen(active ? null : item.id);
                    }}
                    aria-expanded={active}
                    className={`${sideOptionButtonClassName} m-1.5 rounded-xl border`}
                    style={{
                      fontSize: "0.8125rem",
                      fontWeight: highlighted ? 800 : 650,
                      background: highlighted ? tone.bg : undefined,
                      borderColor: highlighted ? tone.border : "transparent",
                      color: highlighted ? tone.color : "#0f172a",
                      boxShadow: highlighted ? `0 0 0 1px ${tone.border}` : "none",
                    }}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2.5">
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
                        style={{
                          background: highlighted ? "white" : tone.bg,
                          borderColor: tone.border,
                          color: tone.color,
                        }}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="truncate">{item.label}</span>
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      {statusLabel ? (
                        <span
                          className="rounded-full border px-2 py-0.5"
                          style={{
                            borderColor: tone.border,
                            background: tone.bg,
                            color: tone.color,
                            fontSize: "0.625rem",
                            fontWeight: 750,
                          }}
                        >
                          {statusLabel}
                        </span>
                      ) : null}
                      <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 transition-transform ${active ? "rotate-180" : ""}`}
                        style={{ color: highlighted ? tone.color : "#94a3b8" }}
                      />
                    </span>
                  </button>
                </GuidanceTooltip>
                {active ? renderSideOptionPanel(item.id) : null}
              </div>
            );
          })}
        </div>
      )}
      <div className="space-y-2 border-t border-[#eef2f7] bg-white px-4 py-3">
        {trialDraftOnly && isInvoice ? (
          <div className="rounded-xl border border-[#bfdbfe] bg-[#eff6ff] px-3 py-2 text-[0.6875rem] leading-5 text-[#1e3a8a]">
            <p>{TRIAL_LIVE_ACTION_MESSAGE}</p>
            <Link to="/app/billing" className="mt-1 inline-flex font-extrabold text-[#1d4ed8] hover:underline">
              Choisir un abonnement
            </Link>
          </div>
        ) : null}
        {createInvoicePrimaryIssue ? (
          <GuidanceTooltip
            content={submitBlockReason || "Crée la facture, attribue un numéro définitif et lance l'émission."}
          >
            <button
              type="button"
              onClick={() => submit("issue")}
              disabled={submitDisabled}
              aria-label="Émettre facture"
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-full px-3 text-white shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
              style={{ fontSize: "0.78125rem", fontWeight: 900, background: submitDisabled ? undefined : accentColor }}
            >
              <Send className="h-3 w-3" />
              {saving && submitIntent === "issue" ? "Émission..." : "Émettre facture"}
            </button>
          </GuidanceTooltip>
        ) : null}
        <GuidanceTooltip
          content={
            submitBlockReason ||
            (isEditingExistingDocument
              ? "Sauvegarde les modifications sans changer le statut du document."
              : "Crée un brouillon modifiable avant l'envoi au client.")
          }
        >
          <button
            type="button"
            onClick={() => submit("draft")}
            disabled={submitDisabled}
            aria-label={
              isEditingExistingDocument
                ? "Enregistrer le document"
                : isInvoice
                  ? "Créer le brouillon de facture"
                  : "Créer le brouillon de devis"
            }
            className={
              createInvoicePrimaryIssue
                ? "inline-flex h-8 w-full items-center justify-center gap-2 rounded-full border border-[#d6deea] bg-white px-3 text-[#334155] shadow-sm transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:text-[#94a3b8]"
                : "inline-flex h-9 w-full items-center justify-center gap-2 rounded-full px-3 text-white shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
            }
            style={{
              fontSize: "0.78125rem",
              fontWeight: 900,
              background: !createInvoicePrimaryIssue && !submitDisabled ? accentColor : undefined,
            }}
          >
            <Save className="h-3 w-3" /> {sidePrimaryLabel}
          </button>
        </GuidanceTooltip>
        {isInvoice && !createInvoicePrimaryIssue && !trialDraftOnly ? (
          <GuidanceTooltip
            content={submitBlockReason || "Enregistre, attribue un numéro définitif et prépare l'envoi de la facture."}
          >
            <button
              type="button"
              onClick={() => submit("issue")}
              disabled={submitDisabled}
              aria-label="Émettre facture"
              className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-full border border-[#bfdbfe] bg-white px-3 text-[#1d4ed8] shadow-sm transition hover:bg-[#eff6ff] disabled:cursor-not-allowed disabled:border-[#d6deea] disabled:text-[#94a3b8]"
              style={{ fontSize: "0.78125rem", fontWeight: 900 }}
            >
              <Send className="h-3 w-3" />
              {saving && submitIntent === "issue" ? "Émission..." : "Émettre facture"}
            </button>
          </GuidanceTooltip>
        ) : null}
      </div>
    </Card>
  );

  if (convertingQuote) {
    return (
      <div>
        <div className="p-6 lg:p-8">
          {notice ? <NoticeBanner tone="info">{notice}</NoticeBanner> : null}
          {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
          {!error ? <LoadingCard label="Création de la facture en cours…" /> : null}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 lg:p-8">
        <LoadingCard label="Chargement de l'éditeur document…" />
      </div>
    );
  }

  if (lockedInvoiceToEdit) {
    const lockedStatus = normalizedInvoiceEditStatus(lockedInvoiceToEdit);
    const lockedReference = lockedInvoiceToEdit?.number || lockedInvoiceToEdit?.id || "cette facture";
    const lockedCustomer = lockedInvoiceToEdit?.customer_name || lockedInvoiceToEdit?.customer?.name || "";

    return (
      <div className="pf-invoice-detail min-h-screen bg-[#eef3f8]" data-invoice-editor-page>
        <div className="p-6 lg:p-8">
          <div className="mx-auto max-w-3xl space-y-4">
            <Link
              to={editorBackHref}
              className="inline-flex items-center gap-1.5 text-[#64748b] hover:text-[#0f172a]"
              style={{ fontSize: "0.8125rem", fontWeight: 600 }}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Retour
            </Link>
            <Card>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#eff6ff] text-[#1d4ed8]">
                  <LockKeyhole className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1 space-y-4">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status="info" label={invoiceStatusDisplay(lockedStatus)} />
                      <span className="text-[#64748b]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                        {lockedReference}
                      </span>
                    </div>
                    <h1
                      className="text-[#0f172a]"
                      style={{ fontSize: "1.35rem", fontWeight: 850, lineHeight: 1.15, letterSpacing: 0 }}
                    >
                      Facture verrouillée
                    </h1>
                    <p className="max-w-2xl text-[#475569]" style={{ fontSize: "0.875rem", lineHeight: 1.6 }}>
                      Facture finalisée : crée un avoir ou une copie modifiable depuis sa fiche pour corriger sans
                      modifier l’original.
                    </p>
                    {lockedCustomer ? (
                      <p className="text-[#64748b]" style={{ fontSize: "0.8125rem", fontWeight: 650 }}>
                        Client : {lockedCustomer}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <PrimaryLinkButton to={editorBackHref}>Retour à la facture</PrimaryLinkButton>
                    <Link
                      to={backHref}
                      className="inline-flex h-10 items-center justify-center rounded-full border border-[#d6deea] bg-white px-4 text-[#334155] shadow-sm transition hover:bg-[#f8fafc]"
                      style={{ fontSize: "0.8125rem", fontWeight: 850 }}
                    >
                      Continuer vers la liste
                    </Link>
                  </div>
                </div>
              </div>
            </Card>
            <NoticeBanner tone="info">
              Les champs de l'éditeur restent fermés pour éviter une modification visuelle qui serait refusée à
              l'enregistrement.
            </NoticeBanner>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pf-invoice-detail min-h-screen bg-[#eef3f8]" data-invoice-editor-page>
      <div className="sticky top-0 z-30 border-b border-[#e2e8f0] bg-white/95 backdrop-blur" data-invoice-print-chrome>
        <div className="flex w-full items-center justify-between gap-4 px-4 py-2.5 pl-14 lg:pl-4 lg:pr-6">
          <div className="min-w-0">
            {compactEditorMode ? (
              <div className="flex items-center gap-5">
                <Link
                  to={editorBackHref}
                  className="inline-flex items-center gap-1.5 text-[#64748b] hover:text-[#0f172a]"
                  style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Retour
                </Link>
                <h1
                  className="inline-flex min-w-0 items-center gap-2 text-[#0f172a]"
                  style={{ fontSize: "0.95rem", fontWeight: 700 }}
                >
                  <span
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg"
                    style={{ background: accentLight, color: accentColor }}
                  >
                    <FileText className="h-4 w-4" />
                  </span>
                  <span className="truncate">
                    {isInvoice
                      ? isEditingExistingInvoice
                        ? "Modifier la facture"
                        : "Nouvelle facture"
                      : isEditingExistingQuote
                        ? "Modifier le devis"
                        : "Nouveau devis"}
                  </span>
                </h1>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-[#64748b]" style={{ fontSize: "0.75rem" }}>
                  <Link to={editorBackHref} className="inline-flex items-center gap-1.5 hover:text-[#0f172a]">
                    <ArrowLeft className="h-3.5 w-3.5" /> Retour
                  </Link>
                  <span>•</span>
                  <span>
                    {isInvoice
                      ? isEditingExistingInvoice
                        ? "Modification facture"
                        : "Création facture"
                      : isEditingExistingQuote
                        ? "Modification devis"
                        : "Création devis"}
                  </span>
                </div>
                <h1 className="mt-1 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                  {isInvoice
                    ? isEditingExistingInvoice
                      ? "Modifier la facture"
                      : "Nouvelle facture"
                    : isEditingExistingQuote
                      ? "Modifier le devis"
                      : "Nouveau devis"}
                </h1>
                <p className="mt-1 max-w-2xl text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                  {nextPrimaryAction}
                  {autosavedAt
                    ? ` · brouillon ${new Date(autosavedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
                    : ""}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="w-full px-4 py-5 pb-28 lg:px-6 lg:pb-8" data-invoice-print-stage>
        {error ? (
          <div className="mx-auto mb-4 w-full max-w-[1460px]">
            <NoticeBanner tone="danger">{error}</NoticeBanner>
          </div>
        ) : null}
        {notice ? (
          <div className="mx-auto mb-4 w-full max-w-[1460px]">
            <NoticeBanner tone="info">{notice}</NoticeBanner>
          </div>
        ) : null}
        {companyProfileBlockReason ? (
          <div className="mx-auto mb-4 w-full max-w-[1460px]">
            <NoticeBanner tone="warning">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  {companyProfileBlockReason} Ce document ne peut pas être créé tant que ces informations manquent.
                </span>
                <Link
                  to="/app/company"
                  className="inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-[#f59e0b] bg-white px-3 text-[#92400e] transition hover:bg-[#fffbeb]"
                  style={{ fontSize: "0.75rem", fontWeight: 900 }}
                >
                  Compléter maintenant
                </Link>
              </div>
            </NoticeBanner>
          </div>
        ) : null}
        {seedContext?.kind === "deposit" ? (
          <div className="mx-auto mb-4 w-full max-w-[1460px]">
            <NoticeBanner tone="info">
              Facture d'acompte {seedContext.percent}% préremplie depuis le devis {seedContext.quoteNumber}. Vous pouvez
              ajuster les lignes, l'échéance et la note avant création.
            </NoticeBanner>
          </div>
        ) : null}
        {compactEditorMode && activeCompactPanel ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]/45 px-3 py-4 backdrop-blur-sm sm:px-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compact-editor-panel-title"
          >
            <button
              type="button"
              aria-label="Fermer le panneau"
              className="absolute inset-0 cursor-default"
              onClick={closeCompactPanel}
            />
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="relative z-10 flex max-h-[min(92vh,820px)] w-full max-w-[1360px] flex-col overflow-hidden rounded-[24px] border border-[#bfd7ff] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.32)]"
            >
              <div className="h-1.5 w-full bg-[#dbeafe]" />
              <div className="flex flex-col gap-3 border-b border-[#dbeafe] bg-[#eff6ff] px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <div className="min-w-0">
                  <div
                    id="compact-editor-panel-title"
                    className="truncate text-[#0f172a]"
                    style={{ fontSize: "0.875rem", fontWeight: 850 }}
                  >
                    {activeCompactPanel === "clients"
                      ? "Choisir un client"
                      : catalogPanelTargetLine
                        ? "Choisir un article pour cette ligne"
                        : "Catalogue d'articles"}
                  </div>
                  {activeCompactPanel === "clients" || !catalogPanelTargetLine ? (
                    <div className="mt-0.5 truncate text-[#64748b]" style={{ fontSize: "0.6875rem" }}>
                      {activeCompactPanel === "clients"
                        ? "Sélection rapide, la facture reste visible derrière."
                        : "Consulte, crée ou mets à jour les articles réutilisables."}
                    </div>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
                  {activeCompactPanel === "clients" ? (
                    <>
                      <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-[#bfdbfe] bg-white px-3 shadow-sm sm:max-w-[390px]">
                        <Search className="h-3.5 w-3.5 text-[#2563eb]" />
                        <input
                          type="search"
                          value={customerQuery}
                          onChange={(event) => setCustomerQuery(event.target.value)}
                          autoComplete="new-password"
                          autoCorrect="off"
                          spellCheck={false}
                          placeholder="Rechercher un client (nom, email...)"
                          className="w-full bg-transparent text-[#0f172a] outline-none placeholder:text-[#94a3b8]"
                          style={{ fontSize: "0.75rem" }}
                        />
                      </div>
                      <Link
                        to="/app/customers/new"
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[#1d4ed8] bg-[#1d4ed8] px-2.5 text-white shadow-sm transition hover:bg-[#1e40af]"
                        style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                      >
                        <Plus className="h-3 w-3" /> Client
                      </Link>
                    </>
                  ) : null}
                  {activeCompactPanel === "catalog" ? (
                    <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-[#bfdbfe] bg-white px-3 shadow-sm sm:max-w-[420px]">
                      <Search className="h-3.5 w-3.5 text-[#2563eb]" />
                      <input
                        value={catalogQuery}
                        onChange={(event) => setCatalogQuery(event.target.value)}
                        placeholder="Rechercher un article..."
                        className="w-full bg-transparent text-[#0f172a] outline-none placeholder:text-[#94a3b8]"
                        style={{ fontSize: "0.75rem" }}
                      />
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={closeCompactPanel}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#bfdbfe] bg-white text-[#2563eb] shadow-sm transition hover:bg-[#dbeafe] hover:text-[#1d4ed8]"
                    aria-label="Fermer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div data-testid="document-compact-controls" className="min-h-0 overflow-hidden bg-[#fbfdff] p-3 sm:p-4">
                {activeCompactPanel === "clients" ? (
                  <div className="space-y-2">
                    <div ref={compactScrollRef} className="max-h-[min(58vh,360px)] overflow-y-auto pr-1">
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
                        {filteredCustomers.map((customer) => {
                          const active = customer.id === form.customer_id;
                          const customerIsBusiness = isBusinessClientType(customer?.client_type);
                          const customerIdentifier = customerIsBusiness
                            ? formatSiretInput(customer.siret || "") ||
                              formatSirenInput(customer.siren || "") ||
                              formatVatNumberInput(customer.vat_number || "") ||
                              "Identifiant à compléter"
                            : "Particulier";
                          return (
                            <button
                              key={customer.id}
                              type="button"
                              onClick={() => {
                                setFormField("customer_id", customer.id);
                                setActiveCompactPanel(null);
                              }}
                              className={`dropdown__item min-h-[78px] rounded-xl border px-2.5 py-2.5 text-left transition-all ${
                                active
                                  ? "shadow-[0_8px_18px_rgba(37,99,235,0.16)]"
                                  : "border-[#dbe3f0] bg-white hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
                              }`}
                              style={active ? { borderColor: accentBorder, background: accentLight } : undefined}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div
                                    className="truncate text-[#0f172a]"
                                    style={{ fontSize: "0.75rem", fontWeight: 850 }}
                                  >
                                    {customer.name}
                                  </div>
                                  <div className="mt-1 truncate text-[#64748b]" style={{ fontSize: "0.6875rem" }}>
                                    {customer.email || "Email à compléter"}
                                  </div>
                                </div>
                                {active ? (
                                  <span
                                    className="inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-white"
                                    style={{ fontSize: "0.625rem", fontWeight: 800, background: accentColor }}
                                  >
                                    Actif
                                  </span>
                                ) : null}
                              </div>
                              <div className="mt-2 truncate text-[#94a3b8]" style={{ fontSize: "0.625rem" }}>
                                {customerIdentifier}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {!filteredCustomers.length ? (
                        <div
                          className="rounded-xl border border-dashed border-[#bfdbfe] bg-white px-4 py-8 text-center text-[#64748b]"
                          style={{ fontSize: "0.75rem" }}
                        >
                          Aucun client ne correspond à la recherche.
                        </div>
                      ) : null}
                    </div>
                    <div className="text-[#64748b]" style={{ fontSize: "0.6875rem" }}>
                      <span>{filteredCustomers.length} client(s) affiché(s)</span>
                    </div>
                  </div>
                ) : null}

                {activeCompactPanel === "catalog" ? (
                  <div
                    className={`grid min-h-0 gap-3 ${catalogEditorOpen ? "lg:grid-cols-[minmax(0,1fr)_380px]" : ""}`}
                  >
                    <div className="min-h-0">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {[
                            { value: "active", label: "Actifs", count: activeCatalogItems.length },
                            {
                              value: "document",
                              label: isInvoice ? "Sur facture" : "Sur devis",
                              count: documentCatalogItems.length,
                            },
                            { value: "all", label: "Tous", count: catalogItems.length },
                            { value: "archived", label: "Archivés", count: archivedCatalogItems.length },
                          ].map((filter) => {
                            const active = catalogFilterMode === filter.value;
                            return (
                              <button
                                key={filter.value}
                                type="button"
                                onClick={() => setCatalogFilterMode(filter.value as CatalogFilterMode)}
                                className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 transition ${
                                  active
                                    ? "bg-[#2563eb] text-white shadow-sm"
                                    : "border border-[#dbe3f0] bg-white text-[#475569] hover:bg-[#eff6ff]"
                                }`}
                                style={{ fontSize: "0.75rem", fontWeight: 850 }}
                              >
                                {filter.label}
                                <span
                                  className={`rounded-full px-1.5 py-0.5 ${
                                    active ? "bg-white/20 text-white" : "bg-[#eef2ff] text-[#64748b]"
                                  }`}
                                  style={{ fontSize: "0.625rem", fontWeight: 850 }}
                                >
                                  {filter.count}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => resetCatalogEditor()}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#2563eb] px-2.5 text-white shadow-sm transition hover:bg-[#1d4ed8]"
                            style={{ fontSize: "0.75rem", fontWeight: 850 }}
                          >
                            <Plus className="h-3.5 w-3.5" /> Nouvel article
                          </button>
                        </div>
                      </div>
                      <div ref={compactScrollRef} className="max-h-[min(58vh,470px)] overflow-y-auto pr-1">
                        {filteredCatalogItems.length ? (
                          <div className="space-y-2">
                            {filteredCatalogItems.map((item) => {
                              const archived = item?.active === false;
                              const alreadyOnDocument = catalogItemIsOnDocument(item);
                              const unitCode = String(item?.unit_code || "C62")
                                .trim()
                                .toUpperCase();
                              const showUnitBadge = Boolean(unitCode && unitCode !== "C62");
                              return (
                                <div
                                  key={item.id || item.name}
                                  data-testid={item?.id ? `catalog-item-${item.id}` : undefined}
                                  className="grid gap-2 rounded-xl border border-[#dbe3f0] bg-[#fbfdff] px-3 py-2 transition hover:border-[#93c5fd] hover:bg-[#eff6ff] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                                >
                                  <div className="min-w-0">
                                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                      <Package2 className="h-4 w-4 shrink-0 text-[#2563eb]" />
                                      <div
                                        className="truncate text-[#0f172a]"
                                        style={{ fontSize: "0.8125rem", fontWeight: 900 }}
                                      >
                                        {item?.name || "Article"}
                                      </div>
                                      <StatusPill
                                        status={archived ? "muted" : "ok"}
                                        label={archived ? "Archivé" : "Actif"}
                                      />
                                      {alreadyOnDocument ? (
                                        <span
                                          className="inline-flex rounded-full bg-[#e0f2fe] px-1.5 py-0.5 text-[#0369a1]"
                                          style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                                        >
                                          Déjà sur le document
                                        </span>
                                      ) : null}
                                      <span
                                        className="inline-flex rounded-full bg-[#e0f2fe] px-1.5 py-0.5 text-[#0369a1]"
                                        style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                                      >
                                        {money(item?.unit_price || 0, form.currency)}
                                      </span>
                                      <span
                                        className="inline-flex rounded-full bg-[#eef2ff] px-1.5 py-0.5 text-[#4338ca]"
                                        style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                                      >
                                        TVA {Number(item?.vat_rate || 0)}%
                                      </span>
                                      {showUnitBadge ? (
                                        <span
                                          className="inline-flex rounded-full bg-[#f8fafc] px-1.5 py-0.5 text-[#64748b]"
                                          style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                                        >
                                          Unité {unitCode}
                                        </span>
                                      ) : null}
                                    </div>
                                    <div className="mt-1 truncate text-[#64748b]" style={{ fontSize: "0.71875rem" }}>
                                      {item?.description || "Sans commentaire"}
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                                    <GuidanceTooltip
                                      content={
                                        catalogPanelTargetLine
                                          ? "Utiliser sur la ligne sélectionnée."
                                          : "Ajouter au document."
                                      }
                                    >
                                      <button
                                        type="button"
                                        onClick={() => applyCatalogItemFromManager(item)}
                                        disabled={archived}
                                        aria-label={catalogPanelTargetLine ? "Utiliser l'article" : "Ajouter l'article"}
                                        title={catalogPanelTargetLine ? "Utiliser" : "Ajouter"}
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#bfdbfe] bg-white text-[#1d4ed8] transition hover:bg-[#eff6ff] disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        <Plus className="h-3.5 w-3.5" />
                                      </button>
                                    </GuidanceTooltip>
                                    <GuidanceTooltip content="Modifier l'article.">
                                      <button
                                        type="button"
                                        onClick={() => resetCatalogEditor(item)}
                                        aria-label="Modifier l'article"
                                        title="Modifier"
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#dbe3f0] bg-white text-[#475569] transition hover:bg-[#f8fafc]"
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                    </GuidanceTooltip>
                                    <GuidanceTooltip
                                      content={archived ? "Réactiver l'article." : "Archiver l'article."}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => void setCatalogItemActive(item, archived)}
                                        disabled={catalogEditorBusy}
                                        aria-label={archived ? "Réactiver l'article" : "Archiver l'article"}
                                        title={archived ? "Réactiver" : "Archiver"}
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#ccfbf1] bg-[#f0fdfa] text-[#0f766e] transition hover:bg-[#ccfbf1] disabled:cursor-wait disabled:opacity-60"
                                      >
                                        {archived ? (
                                          <CheckCircle2 className="h-3.5 w-3.5" />
                                        ) : (
                                          <Archive className="h-3.5 w-3.5" />
                                        )}
                                      </button>
                                    </GuidanceTooltip>
                                    <GuidanceTooltip content="Supprimer définitivement l'article.">
                                      <button
                                        type="button"
                                        onClick={() => void deleteCatalogItemPermanently(item)}
                                        disabled={catalogEditorBusy}
                                        aria-label="Supprimer l'article"
                                        title="Supprimer"
                                        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition disabled:cursor-wait disabled:opacity-60 ${destructiveIconButtonClassName}`}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </GuidanceTooltip>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-[#bfdbfe] bg-[#fbfdff] px-5 py-10 text-center">
                            <Package2 className="mb-3 h-7 w-7 text-[#93c5fd]" />
                            <div className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 900 }}>
                              Aucun article trouvé
                            </div>
                            <div
                              className="mt-1 max-w-sm text-[#64748b]"
                              style={{ fontSize: "0.75rem", lineHeight: 1.5 }}
                            >
                              {catalogQuery.trim()
                                ? "Aucun article ne correspond à cette recherche."
                                : catalogFilterMode === "active"
                                  ? "Aucun article actif dans le catalogue."
                                  : catalogFilterMode === "document"
                                    ? isInvoice
                                      ? "Aucun article du catalogue n'est affiché dans cette facture."
                                      : "Aucun article du catalogue n'est affiché dans ce devis."
                                    : "Aucun article ne correspond à ce filtre."}
                            </div>
                            <button
                              type="button"
                              onClick={() => resetCatalogEditor(undefined, catalogPanelTargetLine)}
                              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#2563eb] px-3 text-white shadow-sm transition hover:bg-[#1d4ed8]"
                              style={{ fontSize: "0.75rem", fontWeight: 850 }}
                            >
                              <Plus className="h-3.5 w-3.5" />{" "}
                              {catalogPanelTargetCanBeSaved ? "Ajouter au catalogue" : "Nouvel article"}
                            </button>
                          </div>
                        )}
                      </div>
                      <div
                        className="mt-3 border-t border-[#dbeafe] pt-3 text-[#64748b]"
                        style={{ fontSize: "0.6875rem" }}
                      >
                        <span>{filteredCatalogItems.length} article(s) affiché(s)</span>
                      </div>
                    </div>
                    {catalogEditorOpen ? (
                      <div
                        data-testid="catalog-editor-panel"
                        className="rounded-2xl border border-[#bfdbfe] bg-white p-4 shadow-sm"
                      >
                        <div className="space-y-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 900 }}>
                                {catalogEditingItemId ? "Modifier l'article" : "Nouvel article"}
                              </div>
                              <div className="mt-0.5 text-[#64748b]" style={{ fontSize: "0.6875rem" }}>
                                L'article sera disponible dans les devis et factures.
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {catalogEditingItemId && catalogEditingItem ? (
                                <>
                                  <GuidanceTooltip
                                    content={
                                      catalogEditingItem.active === false
                                        ? "Réactiver cet article dans le catalogue."
                                        : "Archiver cet article sans le supprimer définitivement."
                                    }
                                  >
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void setCatalogItemActive(
                                          catalogEditingItem,
                                          catalogEditingItem.active === false,
                                        )
                                      }
                                      disabled={catalogEditorBusy}
                                      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border bg-white transition disabled:cursor-wait disabled:opacity-60 ${
                                        catalogEditingItem.active === false
                                          ? "border-[#bbf7d0] text-[#059669] hover:bg-[#f0fdf4]"
                                          : "border-[#99f6e4] text-[#0f766e] hover:bg-[#f0fdfa]"
                                      }`}
                                      aria-label={
                                        catalogEditingItem.active === false
                                          ? "Réactiver l'article"
                                          : "Archiver l'article"
                                      }
                                      title={
                                        catalogEditingItem.active === false
                                          ? "Réactiver l'article"
                                          : "Archiver l'article"
                                      }
                                    >
                                      {catalogEditingItem.active === false ? (
                                        <CheckCircle2 className="h-4 w-4" />
                                      ) : (
                                        <Archive className="h-4 w-4" />
                                      )}
                                    </button>
                                  </GuidanceTooltip>
                                  <GuidanceTooltip content="Supprimer définitivement cet article du catalogue.">
                                    <button
                                      type="button"
                                      onClick={() => void deleteCatalogItemPermanently(catalogEditingItem)}
                                      disabled={catalogEditorBusy}
                                      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition disabled:cursor-wait disabled:opacity-60 ${destructiveIconButtonClassName}`}
                                      aria-label="Supprimer l'article"
                                      title="Supprimer l'article"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  </GuidanceTooltip>
                                </>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => setCatalogEditorOpen(false)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#dbe3f0] bg-white text-[#64748b] transition hover:bg-[#f8fafc]"
                                aria-label="Fermer l'éditeur article"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                          {catalogEditorError ? <NoticeBanner tone="warning">{catalogEditorError}</NoticeBanner> : null}
                          <label className="block">
                            <span className="mb-1 flex items-center gap-2 text-[#475569]">
                              <span style={{ fontSize: "0.75rem", fontWeight: 800 }}>Désignation</span>
                              {catalogEditingItemId && catalogEditingItem ? (
                                <StatusPill
                                  status={catalogEditingItem.active === false ? "muted" : "ok"}
                                  label={catalogEditingItem.active === false ? "Archivé" : "Actif"}
                                />
                              ) : null}
                            </span>
                            <input
                              value={catalogItemForm.name}
                              onChange={(event) => updateCatalogItemForm({ name: event.target.value })}
                              placeholder="Ex. Maintenance mensuelle"
                              className="h-9 w-full rounded-lg border border-[#cbd5e1] bg-white px-3 text-[#0f172a] outline-none transition placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                              style={{ fontSize: "0.8125rem" }}
                            />
                          </label>
                          <label className="block">
                            <span
                              className="mb-1 block text-[#475569]"
                              style={{ fontSize: "0.75rem", fontWeight: 800 }}
                            >
                              Commentaire
                            </span>
                            <textarea
                              rows={2}
                              value={catalogItemForm.description}
                              onChange={(event) => updateCatalogItemForm({ description: event.target.value })}
                              placeholder="Commentaire repris sous la ligne du document"
                              className="w-full resize-none rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-[#0f172a] outline-none transition placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                              style={{ fontSize: "0.8125rem", lineHeight: 1.45 }}
                            />
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="block">
                              <span
                                className="mb-1 block text-[#475569]"
                                style={{ fontSize: "0.75rem", fontWeight: 800 }}
                              >
                                Prix HT
                              </span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={catalogItemForm.unit_price}
                                onChange={(event) => updateCatalogItemForm({ unit_price: event.target.value })}
                                className={`${numberInputNoSpinnerClassName} h-9 w-full rounded-lg border border-[#cbd5e1] bg-white px-3 text-right text-[#0f172a] outline-none transition focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]`}
                                style={{ fontSize: "0.8125rem" }}
                              />
                            </label>
                            <label className="block">
                              <span
                                className="mb-1 block text-[#475569]"
                                style={{ fontSize: "0.75rem", fontWeight: 800 }}
                              >
                                TVA %
                              </span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={catalogItemForm.vat_rate}
                                onChange={(event) => updateCatalogItemForm({ vat_rate: event.target.value })}
                                disabled={companyVatFranchise}
                                className={`${numberInputNoSpinnerClassName} h-9 w-full rounded-lg border border-[#cbd5e1] bg-white px-3 text-right text-[#0f172a] outline-none transition focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]`}
                                style={{ fontSize: "0.8125rem" }}
                              />
                            </label>
                          </div>
                          <div className="flex flex-wrap justify-end gap-2 border-t border-[#e2e8f0] pt-3">
                            <button
                              type="button"
                              onClick={() => setCatalogEditorOpen(false)}
                              disabled={catalogEditorBusy}
                              className="inline-flex h-9 items-center rounded-lg border border-[#dbe3f0] bg-white px-3 text-[#475569] transition hover:bg-[#f8fafc] disabled:cursor-wait disabled:opacity-60"
                              style={{ fontSize: "0.75rem", fontWeight: 850 }}
                            >
                              Annuler
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveCatalogItem()}
                              disabled={catalogEditorBusy || !catalogItemFormCanSave}
                              className="inline-flex h-9 items-center rounded-lg bg-[#2563eb] px-3 text-white shadow-sm transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-60"
                              style={{ fontSize: "0.75rem", fontWeight: 900 }}
                            >
                              {catalogEditorBusy
                                ? "Enregistrement..."
                                : catalogEditingItemId
                                  ? "Enregistrer"
                                  : catalogPanelTargetLineId
                                    ? "Créer et utiliser sur cette ligne"
                                    : "Créer l'article"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </motion.div>
          </div>
        ) : null}
        <div
          data-invoice-print-layout
          className={`mx-auto grid w-full max-w-[1460px] grid-cols-1 gap-5 xl:gap-6 ${
            compactEditorMode
              ? "xl:grid-cols-[minmax(0,1100px)_310px] xl:items-start xl:justify-center"
              : "xl:grid-cols-[minmax(0,1100px)_310px] xl:items-start xl:justify-center"
          }`}
        >
          <div data-testid="document-editor-canvas" data-invoice-print-root>
            <div
              className="relative mx-auto w-full max-w-[1100px] overflow-hidden rounded-[20px] border border-[#e2e8f0] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.03),0_16px_52px_rgba(15,23,42,0.09)] xl:mx-0"
              data-invoice-print-paper
            >
              <div
                className="h-1 w-full"
                style={{
                  background: `linear-gradient(90deg, ${accentColor} 0%, #4f46e5 45%, #7c3aed 72%, #0d9488 100%)`,
                }}
              />
              <div className="pointer-events-none absolute right-8 top-5 select-none text-[clamp(3.5rem,7vw,5.5rem)] font-black leading-none tracking-[-0.06em] text-[#0f1e36]/[0.025]">
                {isEditingExistingDocument ? docLabel : documentCopy.draftWatermark}
              </div>
              <div className="relative px-5 pb-6 pt-4 lg:px-8 lg:pb-8 lg:pt-5">
                <div className="mb-4 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="flex min-w-0 items-start">
                    <div className="group relative h-[98px] w-[178px] shrink-0 overflow-hidden rounded-xl border border-[#e2e8f0] bg-white shadow-[0_6px_18px_rgba(15,23,42,0.06)] md:h-[104px] md:w-[190px]">
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept="image/png,image/jpeg"
                        className="sr-only"
                        aria-label="Importer le logo entreprise"
                        data-testid="invoice-logo-file-input"
                        onChange={(event) => void uploadCompanyLogoFromDocument(event.target.files?.[0])}
                      />
                      {companyLogoUrl ? (
                        <>
                          <Image
                            src={companyLogoUrl}
                            alt=""
                            width={190}
                            height={104}
                            className="h-full w-full object-contain p-4"
                            loading="lazy"
                            unoptimized
                          />
                          <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
                            <GuidanceTooltip content="Remplacer le logo entreprise pour les prochains documents.">
                              <button
                                type="button"
                                aria-label="Remplacer le logo entreprise"
                                data-testid="invoice-logo-replace"
                                disabled={logoBusy}
                                onClick={() => logoInputRef.current?.click()}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border bg-white shadow-sm transition hover:bg-white focus:outline-none focus:ring-2 disabled:cursor-wait disabled:opacity-60"
                                style={{
                                  borderColor: accentBorder,
                                  color: accentColor,
                                  ["--tw-ring-color" as any]: accentBorder,
                                }}
                              >
                                {uploadingLogo ? (
                                  <Upload className="h-4 w-4 animate-pulse" />
                                ) : (
                                  <Pencil className="h-4 w-4" />
                                )}
                              </button>
                            </GuidanceTooltip>
                            <GuidanceTooltip content="Supprimer le logo entreprise pour les prochains documents.">
                              <button
                                type="button"
                                aria-label="Supprimer le logo entreprise"
                                data-testid="invoice-logo-delete"
                                disabled={logoBusy}
                                onClick={() => void deleteCompanyLogoFromDocument()}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#fecaca] bg-white text-[#dc2626] shadow-sm transition hover:bg-[#fef2f2] focus:outline-none focus:ring-2 focus:ring-[#fecaca] disabled:cursor-wait disabled:opacity-60"
                              >
                                <Trash2 className={`h-4 w-4 ${deletingLogo ? "animate-pulse" : ""}`} />
                              </button>
                            </GuidanceTooltip>
                          </div>
                        </>
                      ) : (
                        <button
                          type="button"
                          aria-label="Ajouter le logo entreprise"
                          data-testid="invoice-logo-add"
                          disabled={logoBusy}
                          onClick={() => logoInputRef.current?.click()}
                          className="flex h-full w-full flex-col items-center justify-center gap-2 text-[#1d4ed8] transition hover:bg-[#eff6ff] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#bfdbfe]"
                          style={{ color: accentColor }}
                        >
                          <span
                            className="inline-flex h-10 w-10 items-center justify-center rounded-full border"
                            style={{ borderColor: accentBorder, background: accentLight }}
                          >
                            {uploadingLogo ? (
                              <Upload className="h-5 w-5 animate-pulse" />
                            ) : (
                              <Plus className="h-5 w-5" />
                            )}
                          </span>
                          <span style={{ fontSize: "0.75rem", fontWeight: 850 }}>
                            {uploadingLogo ? "Envoi..." : "Ajouter un logo"}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="relative z-10 text-left md:min-w-[220px] md:text-right">
                    <div className={paperOverlineClassName}>{docLabel}</div>
                    <div
                      className="mt-1 text-[1.25rem] font-black leading-none tracking-[-0.03em]"
                      style={{ color: accentColor }}
                    >
                      {isEditingExistingDocument ? documentCopy.editStatus : documentCopy.draftStatus}
                    </div>
                    <div
                      className="mt-2 inline-flex items-center gap-2 rounded-full border bg-[#f8fbff] px-3 py-1.5 text-[#64748b] md:justify-end"
                      style={{ borderColor: accentBorder }}
                    >
                      <Hash className="h-3.5 w-3.5" />
                      <span style={{ fontSize: "0.78125rem", fontWeight: 700 }}>
                        {documentCopy.numberAfterCreation}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mb-5 h-px bg-gradient-to-r from-[#bfdbfe] via-[#e2e8f0] to-transparent" />

                <div className="mb-7 w-full">
                  <div
                    data-testid="invoice-paper-meta-band"
                    className="grid w-full min-w-0 grid-cols-1 items-stretch overflow-visible rounded-xl border border-[#dbe3ef] bg-[#f8fbff] shadow-[0_5px_16px_rgba(15,23,42,0.035)] md:grid-cols-2 lg:grid-cols-4"
                  >
                    <label className="grid h-[62px] min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[13px_28px] content-center gap-1 overflow-hidden border-b border-[#dbe3ef] px-3 py-0 md:border-r lg:border-b-0">
                      <span className={`flex items-center gap-2 ${paperOverlineClassName}`}>
                        <Calendar className="h-3 w-3" /> {isInvoice ? documentCopy.issueDate : documentCopy.quoteDate}
                      </span>
                      <input
                        type="text"
                        inputMode="numeric"
                        data-testid="paper-issue-date"
                        value={dateDisplayFr(form.issue_date || form.service_date || "")}
                        onChange={(event) => setFormField("issue_date", normalizeFrenchDateInput(event.target.value))}
                        readOnly={!isInvoice}
                        aria-readonly={!isInvoice}
                        title={
                          isInvoice
                            ? undefined
                            : "La date du devis est générée à la création. Modifiez la date de prestation si nécessaire."
                        }
                        placeholder="jj/mm/aaaa"
                        className={`${paperInlineControlClassName} ${
                          !isInvoice ? "cursor-not-allowed bg-slate-100 text-slate-500" : ""
                        }`}
                        style={{
                          boxSizing: "border-box",
                          fontSize: "0.78125rem",
                          fontWeight: 650,
                          maxWidth: "100%",
                          minWidth: 0,
                          width: "100%",
                        }}
                      />
                    </label>
                    <label className="grid h-[62px] min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[13px_28px] content-center gap-1 overflow-hidden border-b border-[#dbe3ef] px-3 py-0 lg:border-b-0 lg:border-r">
                      <span className={`flex items-center gap-2 ${paperOverlineClassName}`}>
                        <Calendar className="h-3 w-3" /> {documentCopy.serviceDate}
                      </span>
                      <input
                        type="text"
                        inputMode="numeric"
                        data-testid="paper-service-date"
                        value={dateDisplayFr(form.service_date || "")}
                        onChange={(event) => setFormField("service_date", normalizeFrenchDateInput(event.target.value))}
                        placeholder="jj/mm/aaaa"
                        className={paperInlineControlClassName}
                        style={{
                          boxSizing: "border-box",
                          fontSize: "0.78125rem",
                          fontWeight: 650,
                          maxWidth: "100%",
                          minWidth: 0,
                          width: "100%",
                        }}
                      />
                    </label>
                    <label className="grid h-[62px] min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[13px_28px] content-center gap-1 overflow-hidden border-b border-[#dbe3ef] px-3 py-0 md:border-r lg:border-b-0">
                      <span className={`flex items-center gap-2 ${paperOverlineClassName}`}>
                        <Clock className="h-3 w-3" /> {isInvoice ? documentCopy.dueDate : documentCopy.validUntil}
                      </span>
                      <input
                        type="text"
                        inputMode="numeric"
                        data-testid="paper-due-date"
                        value={dateDisplayFr(form.due_date || form.valid_until || "")}
                        onChange={(event) => setFormField("due_date", normalizeFrenchDateInput(event.target.value))}
                        placeholder="jj/mm/aaaa"
                        className={paperInlineControlClassName}
                        style={{
                          boxSizing: "border-box",
                          fontSize: "0.78125rem",
                          fontWeight: 650,
                          maxWidth: "100%",
                          minWidth: 0,
                          width: "100%",
                        }}
                      />
                    </label>
                    <div
                      ref={paymentMenuRef}
                      className="relative z-30 grid h-[62px] min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[13px_28px] content-center gap-1 overflow-visible px-3 py-0"
                    >
                      <span className={`flex items-center gap-2 ${paperOverlineClassName}`}>
                        <ReceiptText className="h-3 w-3" /> {documentCopy.terms}
                      </span>
                      <div className="flex h-7 min-w-0 overflow-hidden rounded-lg border border-[#cbd5e1] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe]">
                        <input
                          aria-label="Conditions de paiement"
                          data-testid="paper-payment-terms"
                          value={form.payment_terms || ""}
                          readOnly={paymentPreset !== CUSTOM_PAYMENT_PRESET_ID}
                          onChange={(event) => {
                            if (paymentPreset !== CUSTOM_PAYMENT_PRESET_ID) return;
                            changePaymentTermsManually(event.target.value);
                            setPaymentMenuOpen(false);
                          }}
                          onFocus={() => {
                            if (paymentPreset !== CUSTOM_PAYMENT_PRESET_ID) setPaymentMenuOpen(true);
                          }}
                          placeholder="Ex: Paiement comptant"
                          className="h-full min-w-0 flex-1 truncate bg-transparent px-2 text-[#0f172a] outline-none placeholder:text-[#94a3b8] read-only:cursor-pointer"
                          style={{
                            boxSizing: "border-box",
                            fontSize: "0.78125rem",
                            fontWeight: 650,
                            maxWidth: "100%",
                            minWidth: 0,
                            width: "100%",
                          }}
                        />
                        <button
                          type="button"
                          aria-label="Afficher les échéances de paiement"
                          aria-expanded={paymentMenuOpen}
                          data-testid="paper-payment-menu-button"
                          onClick={() => setPaymentMenuOpen((current) => !current)}
                          className="flex h-full w-7 shrink-0 items-center justify-center border-l border-transparent bg-transparent text-[#64748b] transition hover:bg-[#eff6ff]"
                          style={{ color: paymentMenuOpen ? accentColor : undefined }}
                        >
                          <ChevronDown
                            className={`h-3.5 w-3.5 transition ${paymentMenuOpen ? "rotate-180" : ""}`}
                            strokeWidth={2.2}
                          />
                        </button>
                      </div>
                      {paymentMenuOpen ? (
                        <div
                          role="listbox"
                          aria-label="Choix des conditions de paiement"
                          data-testid="paper-payment-menu"
                          className="absolute right-3 top-[calc(100%-0.15rem)] z-40 w-[min(calc(100%-1.5rem),260px)] overflow-hidden rounded-xl border bg-white shadow-[0_18px_40px_rgba(15,23,42,0.14)]"
                          style={{ borderColor: accentBorder }}
                        >
                          {PAYMENT_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              role="option"
                              aria-selected={paymentPreset === preset.id}
                              data-testid={`paper-payment-preset-option-${preset.id}`}
                              onClick={() => {
                                changePaymentPreset(preset.id);
                                setPaymentMenuOpen(false);
                              }}
                              className="flex w-full flex-col items-start gap-0.5 border-b border-[#eef2ff] px-3 py-2 text-left text-[#0f172a] transition last:border-b-0 hover:bg-[#f8fafc]"
                            >
                              <span style={{ fontSize: "0.78125rem", fontWeight: 650 }}>{preset.label}</span>
                              <span className="text-[#64748b]" style={{ fontSize: "0.78125rem", fontWeight: 500 }}>
                                {preset.paymentTerms}
                              </span>
                            </button>
                          ))}
                          <button
                            type="button"
                            role="option"
                            aria-selected={paymentPreset === CUSTOM_PAYMENT_PRESET_ID}
                            data-testid="paper-payment-preset-option-manual"
                            onClick={() => {
                              setPaymentPreset(CUSTOM_PAYMENT_PRESET_ID);
                              setFormField("payment_terms", "");
                              setPaymentMenuOpen(false);
                            }}
                            className="flex w-full items-center px-3 py-2 text-left text-[#0f172a] transition hover:bg-[#f8fafc]"
                            style={{ fontSize: "0.78125rem", fontWeight: 650 }}
                          >
                            Personnalisé
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="mb-6 grid gap-y-4 lg:grid-cols-[minmax(0,1fr)_56px_minmax(0,1fr)] lg:gap-y-0">
                  <div
                    data-testid="document-issuer-card"
                    className="overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white"
                  >
                    <div
                      data-testid="document-issuer-card-header"
                      className="flex h-10 items-center justify-between gap-3 border-b border-[#e2e8f0] bg-gradient-to-br from-[#f8fafc] to-[#f1f5f9] px-4"
                    >
                      {renderTooltipText(
                        documentCopy.issuer,
                        "Informations de votre entreprise reprises sur le document. Le crayon ouvre l'édition rapide sur place.",
                        paperOverlineClassName,
                      )}
                      <div className="flex shrink-0 items-center gap-1.5">
                        {issuerContactEditing ? (
                          renderPartyEditActions()
                        ) : partyEditSection?.startsWith("issuer") ? null : (
                          <GuidanceTooltip content="Modifier le nom, l'adresse, l'email, le téléphone, le SIREN, le SIRET et la TVA de l'émetteur sans quitter le document.">
                            <button
                              type="button"
                              onClick={() => startPartyEdit("issuer-all")}
                              aria-label="Modifier l'émetteur"
                              title="Modifier l'émetteur"
                              data-party-edit-action
                              className={partyEditIconButtonClassName}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </GuidanceTooltip>
                        )}
                      </div>
                    </div>
                    <div className="flex min-h-[206px] flex-col gap-2.5 p-4">
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3">
                        {issuerContactEditing ? (
                          renderPartyInlineInput("name", "Nom émetteur", {
                            autoFocus: true,
                            className: "font-extrabold",
                            placeholder: "Entreprise",
                          })
                        ) : (
                          <div
                            data-document-party-name
                            className="whitespace-normal [font-size:0.9375rem] font-extrabold leading-tight tracking-[-0.01em] text-[#0f172a] [overflow-wrap:anywhere]"
                          >
                            {company?.name || "Entreprise"}
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <div data-testid="issuer-contact-block" className={partyContactBlockClassName}>
                          {issuerContactEditing ? (
                            <>
                              <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-3 text-[#64748b]">
                                <MapPin className={partyIconClassName} />
                                <div className="space-y-1">
                                  {renderPartyInlineInput("address_line1", "Adresse émetteur", {
                                    placeholder: "Adresse",
                                  })}
                                  {renderPartyInlineInput("address_line2", "Complément émetteur", {
                                    placeholder: "Complément",
                                  })}
                                  <div className="grid gap-1.5 sm:grid-cols-[92px_minmax(0,1fr)]">
                                    {renderPartyInlineInput("postal_code", "Code postal émetteur", {
                                      inputMode: "numeric",
                                      placeholder: "CP",
                                    })}
                                    {renderPartyInlineInput("city", "Ville émetteur", { placeholder: "Ville" })}
                                  </div>
                                </div>
                              </div>
                              <div className="grid grid-cols-[16px_minmax(0,1fr)_32px] items-center gap-3">
                                <Mail className={partyInlineIconClassName} />
                                {renderPartyInlineInput("email_reply_to", "Email émetteur", {
                                  inputMode: "email",
                                  placeholder: "Email",
                                })}
                                {renderSupplierVisibilityToggle("email", summaryTemplateOptions.show_supplier_email)}
                              </div>
                              <div className="grid grid-cols-[16px_minmax(0,1fr)_32px] items-center gap-3">
                                <Phone className={partyInlineIconClassName} />
                                {renderPartyInlineInput("phone", "Téléphone émetteur", {
                                  inputMode: "tel",
                                  placeholder: "Téléphone",
                                })}
                                {renderSupplierVisibilityToggle("phone", summaryTemplateOptions.show_supplier_phone)}
                              </div>
                            </>
                          ) : (
                            <>
                              {companyAddressLines.length ? (
                                <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-3 text-[#64748b]">
                                  <MapPin className={partyIconClassName} />
                                  <div className="space-y-1" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                                    {companyAddressLines.map((line, lineIndex) => (
                                      <p key={`issuer-address-${lineIndex}`}>{line}</p>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                              {summaryTemplateOptions.show_supplier_email && companyEmailDisplay ? (
                                <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-3">
                                  <Mail className={partyInlineIconClassName} />
                                  <span className="truncate text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                                    {companyEmailDisplay}
                                  </span>
                                </div>
                              ) : null}
                              {summaryTemplateOptions.show_supplier_phone && companyPhoneDisplay ? (
                                <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-3">
                                  <Phone className={partyInlineIconClassName} />
                                  <span className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                                    {companyPhoneDisplay}
                                  </span>
                                </div>
                              ) : null}
                            </>
                          )}
                          {issuerIdentityRows.length || issuerIdentityEditing ? (
                            <div
                              data-testid="issuer-identity-block"
                              className="relative grid grid-cols-[16px_minmax(0,1fr)] items-start gap-3 border-t border-dashed border-[#e2e8f0] pt-3"
                            >
                              <Building2 className={partyIdentityIconClassName} />
                              <div className="absolute right-0 top-2.5 z-10 flex items-center justify-end">
                                {partyEditSection === "issuer-identity" ? renderPartyEditActions() : null}
                              </div>
                              <div className="min-w-0 pr-8">
                                {issuerIdentityEditing ? (
                                  <div
                                    className={`${partyIdentityGridClassName} text-[#64748b]`}
                                    style={{ fontSize: "0.75rem", lineHeight: 1.38 }}
                                  >
                                    <div data-party-identity-row="SIREN" className={partyIdentityRowClassName}>
                                      <span className={partyIdentityLabelClassName}>SIREN</span>
                                      {renderPartyInlineInput("siren", "SIREN émetteur", {
                                        autoFocus: partyEditSection === "issuer-identity",
                                        className: "font-semibold",
                                        inputMode: "numeric",
                                      })}
                                    </div>
                                    <div data-party-identity-row="SIRET" className={partyIdentityRowClassName}>
                                      <span className={partyIdentityLabelClassName}>SIRET</span>
                                      {renderPartyInlineInput("siret", "SIRET émetteur", {
                                        className: "font-semibold",
                                        inputMode: "numeric",
                                      })}
                                    </div>
                                    <div data-party-identity-row="N° TVA" className={partyIdentityRowClassName}>
                                      <span className={partyIdentityLabelClassName}>N° TVA</span>
                                      {renderPartyInlineInput("vat_number", "N° TVA émetteur", {
                                        className: "font-semibold",
                                      })}
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    className={`${partyIdentityGridClassName} text-[#64748b]`}
                                    style={{ fontSize: "0.75rem", lineHeight: 1.38 }}
                                  >
                                    {issuerIdentityRows.map((row) => (
                                      <div
                                        key={`invoice-issuer-${row.label}`}
                                        data-party-identity-row={row.label}
                                        className={partyIdentityRowClassName}
                                      >
                                        <span className={partyIdentityLabelClassName}>{row.label}</span>
                                        <span
                                          data-party-editable-field
                                          data-party-identity-value
                                          className={`${row.mono ? "font-mono" : ""} min-w-0 truncate whitespace-nowrap font-semibold text-[#334155]`}
                                        >
                                          {row.value}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="hidden items-center justify-center lg:flex">
                    <div className="flex h-full flex-col items-center justify-center gap-3 py-5">
                      <div className="w-px flex-1 bg-gradient-to-b from-transparent via-[#e2e8f0] to-transparent" />
                      <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e2e8f0] bg-white text-[#cbd5e1] shadow-sm">
                        <ArrowRight className="h-4 w-4" />
                      </div>
                      <div className="w-px flex-1 bg-gradient-to-b from-transparent via-[#e2e8f0] to-transparent" />
                    </div>
                  </div>

                  <div
                    data-testid="document-client-card"
                    className="overflow-visible rounded-2xl border bg-[#f8fbff] shadow-[0_4px_18px_rgba(29,78,216,0.05)]"
                    style={{ borderColor: accentBorder }}
                  >
                    <div
                      data-testid="document-client-card-header"
                      className="flex h-10 items-center justify-between gap-3 rounded-t-2xl border-b px-4"
                      style={{
                        borderColor: accentBorder,
                        background: `linear-gradient(135deg, ${accentLight}, ${accentSubtle})`,
                      }}
                    >
                      {renderTooltipText(
                        isInvoice ? documentCopy.billedTo : documentCopy.quotedTo,
                        isInvoice
                          ? "Informations du client facturé. Les crayons permettent de modifier les champs sans quitter le document."
                          : "Informations du client destinataire du devis. Les crayons permettent de modifier les champs sans quitter le document.",
                        paperOverlineClassName,
                      )}
                      {selectedCustomer ? (
                        <div className="flex shrink-0 items-center gap-1.5">
                          {clientContactEditing ? (
                            renderPartyEditActions()
                          ) : partyEditSection?.startsWith("client") ? null : (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setCustomerQuery("");
                                  setClientDropdownOpen((current) => !current);
                                }}
                                aria-label="Changer le client"
                                aria-expanded={clientDropdownOpen}
                                data-testid="client-choice-button"
                                className="inline-flex shrink-0 items-center gap-2 text-[#1d4ed8] transition hover:text-[#1e40af] hover:underline"
                                style={{ color: accentColor, fontSize: "0.78125rem", fontWeight: 650 }}
                              >
                                <span>{documentCopy.changeClient}</span>
                                <ChevronDown
                                  className={`h-3.5 w-3.5 transition-transform ${
                                    clientDropdownOpen ? "rotate-180" : ""
                                  }`}
                                  strokeWidth={2.5}
                                />
                              </button>
                              <GuidanceTooltip
                                content={
                                  selectedCustomerShowsLegalIdentity
                                    ? "Modifier le nom, l'adresse, l'email, le téléphone, le SIREN, le SIRET et la TVA du client sans quitter le document."
                                    : "Modifier le nom, l'adresse, l'email et le téléphone du client sans quitter le document."
                                }
                              >
                                <button
                                  type="button"
                                  onClick={() => startPartyEdit("client-all")}
                                  aria-label="Modifier les informations du client"
                                  title="Modifier les informations du client"
                                  data-party-edit-action
                                  className={`${partyEditIconButtonClassName} hover:bg-white`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              </GuidanceTooltip>
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex min-h-[206px] flex-col gap-2.5 p-4">
                      <div ref={clientChoiceRef} className="relative z-20">
                        {!selectedCustomer ? (
                          <div className="relative min-w-0">
                            <User
                              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
                              style={{ color: accentColor }}
                            />
                            <input
                              type="search"
                              value={customerQuery}
                              onFocus={() => setClientDropdownOpen(true)}
                              onChange={(event) => {
                                setCustomerQuery(event.target.value);
                                setClientDropdownOpen(true);
                              }}
                              autoComplete="new-password"
                              autoCorrect="off"
                              spellCheck={false}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && filteredCustomers[0]?.id) {
                                  event.preventDefault();
                                  selectInvoiceCustomer(filteredCustomers[0].id);
                                }
                              }}
                              placeholder={documentCopy.searchClient}
                              aria-label="Rechercher et sélectionner un client"
                              data-testid="client-choice-button"
                              className="h-10 w-full rounded-xl border border-[#bfdbfe] bg-white py-1.5 pl-9 pr-10 text-[0.8125rem] font-semibold text-[#0f172a] shadow-sm outline-none transition placeholder:text-[#64748b] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                            />
                            <ChevronDown
                              className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94a3b8] transition-transform ${
                                clientDropdownOpen ? "rotate-180" : ""
                              }`}
                            />
                          </div>
                        ) : (
                          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3">
                            {clientContactEditing ? (
                              renderPartyInlineInput("name", "Nom client", {
                                autoFocus: true,
                                className: "font-extrabold",
                                placeholder: "Client",
                              })
                            ) : (
                              <div
                                data-document-party-name
                                className="min-w-0 whitespace-normal [font-size:0.9375rem] font-extrabold leading-tight tracking-[-0.01em] text-[#0f172a] [overflow-wrap:anywhere]"
                              >
                                {selectedCustomer.name}
                              </div>
                            )}
                          </div>
                        )}
                        {clientDropdownOpen ? (
                          <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-[#d6deea] bg-white shadow-[0_18px_40px_rgba(15,23,42,0.18)]">
                            {selectedCustomer ? (
                              <div className="border-b border-[#edf2f7] p-2">
                                <div className="relative">
                                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94a3b8]" />
                                  <input
                                    type="search"
                                    value={customerQuery}
                                    onChange={(event) => setCustomerQuery(event.target.value)}
                                    autoComplete="new-password"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter" && filteredCustomers[0]?.id) {
                                        event.preventDefault();
                                        selectInvoiceCustomer(filteredCustomers[0].id);
                                      }
                                    }}
                                    autoFocus
                                    placeholder={documentCopy.searchClientShort}
                                    className="h-9 w-full rounded-lg border border-[#e2e8f0] bg-[#f8fafc] py-2 pl-8 pr-3 text-[#0f172a] outline-none placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                    style={{ fontSize: "0.8125rem" }}
                                  />
                                </div>
                              </div>
                            ) : null}
                            <div className="max-h-[240px] overflow-y-auto py-1">
                              {filteredCustomers.length ? (
                                filteredCustomers.map((customer: any, index: number) => {
                                  const active = customer.id === form.customer_id;
                                  const initial =
                                    String(customer?.name || "?")
                                      .trim()
                                      .charAt(0)
                                      .toUpperCase() || "?";
                                  const bubbleColors = ["#ef4444", "#eab308", "#34d399", "#60a5fa", "#a78bfa"];
                                  return (
                                    <button
                                      key={customer.id}
                                      type="button"
                                      onClick={() => selectInvoiceCustomer(customer.id)}
                                      className={`dropdown__item flex min-h-12 w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                                        active ? "bg-[#e2e8f0]" : "hover:bg-[#f1f5f9]"
                                      }`}
                                    >
                                      <span
                                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-black text-white"
                                        style={{ background: bubbleColors[index % bubbleColors.length] }}
                                      >
                                        {initial}
                                      </span>
                                      <span className="min-w-0">
                                        <span
                                          className="block truncate text-[#334155]"
                                          style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                                        >
                                          {customer.name}
                                        </span>
                                        {customer.email ? (
                                          <span
                                            className="block truncate text-[#94a3b8]"
                                            style={{ fontSize: "0.6875rem" }}
                                          >
                                            {customer.email}
                                          </span>
                                        ) : null}
                                      </span>
                                    </button>
                                  );
                                })
                              ) : (
                                <div
                                  className="px-3 py-4 text-center text-[#94a3b8]"
                                  style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                                >
                                  {documentCopy.noClientFound}
                                </div>
                              )}
                            </div>
                            <div className="border-t border-[#edf2f7] p-2">
                              <Link
                                to="/app/customers/new"
                                className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#1d4ed8] bg-[#2563eb] text-white shadow-sm transition hover:border-[#1e40af] hover:bg-[#1d4ed8]"
                                style={{
                                  borderColor: accentColor,
                                  background: accentColor,
                                  fontSize: "0.75rem",
                                  fontWeight: 900,
                                }}
                              >
                                <Plus className="h-3.5 w-3.5" />
                                {documentCopy.addClient}
                              </Link>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex-1">
                        <div data-testid="client-contact-block" className={partyContactBlockClassName}>
                          {selectedCustomer && clientContactEditing ? (
                            <>
                              <div>
                                <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-3 text-[#64748b]">
                                  <MapPin className={partyAddressIconClassName} />
                                  <div className="space-y-1">
                                    {renderPartyInlineInput("address_line1", "Adresse client", {
                                      placeholder: "Adresse",
                                    })}
                                    {renderPartyInlineInput("address_line2", "Complément client", {
                                      placeholder: "Complément",
                                    })}
                                    <div className="grid gap-1.5 sm:grid-cols-[92px_minmax(0,1fr)]">
                                      {renderPartyInlineInput("postal_code", "Code postal client", {
                                        inputMode: "numeric",
                                        placeholder: "CP",
                                      })}
                                      {renderPartyInlineInput("city", "Ville client", { placeholder: "Ville" })}
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-3">
                                <Mail className={partyInlineIconClassName} />
                                {renderPartyInlineInput("email", "Email client", {
                                  inputMode: "email",
                                  placeholder: "Email",
                                })}
                              </div>
                              <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-3">
                                <Phone className={partyInlineIconClassName} />
                                {renderPartyInlineInput("phone", "Téléphone client", {
                                  inputMode: "tel",
                                  placeholder: "Téléphone",
                                })}
                              </div>
                            </>
                          ) : (
                            <>
                              {clientInfoVisibility.address && customerAddressLines.length ? (
                                <div>
                                  <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-3 text-[#64748b]">
                                    <MapPin className={partyAddressIconClassName} />
                                    <div className="space-y-1" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                                      <span className="sr-only">Adresse</span>
                                      {customerAddressLines.map((line, lineIndex) => (
                                        <p key={`customer-address-${lineIndex}`}>{line}</p>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                              {selectedCustomer && clientInfoVisibility.email ? (
                                <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-3">
                                  <Mail className={partyInlineIconClassName} />
                                  <span className="min-w-0 truncate text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                                    {customerEmailDisplay || "Email à compléter"}
                                  </span>
                                </div>
                              ) : null}
                              {selectedCustomer && clientInfoVisibility.phone ? (
                                <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-3">
                                  <Phone className={partyInlineIconClassName} />
                                  <span className="min-w-0 truncate text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                                    {customerPhoneDisplay || "Téléphone à compléter"}
                                  </span>
                                </div>
                              ) : null}
                            </>
                          )}
                          {clientInfoVisibility.identity &&
                          selectedCustomerShowsLegalIdentity &&
                          (customerIdentityRows.length || clientIdentityEditing) ? (
                            <div
                              data-testid="client-identity-block"
                              className="relative grid grid-cols-[16px_minmax(0,1fr)] items-start gap-3 border-t border-dashed border-[#bfdbfe] pt-3 text-[#1d4ed8]"
                              style={{ borderColor: accentBorder, color: accentColor }}
                            >
                              <Building2 className={partyIdentityIconClassName} />
                              <div className="absolute right-0 top-2.5 z-10 flex items-center justify-end">
                                {selectedCustomer?.id && partyEditSection === "client-identity"
                                  ? renderPartyEditActions()
                                  : null}
                              </div>
                              <div className="min-w-0 pr-8">
                                {selectedCustomer && clientIdentityEditing ? (
                                  <div
                                    className={`${partyIdentityGridClassName} text-[#64748b]`}
                                    style={{ fontSize: "0.75rem", lineHeight: 1.38 }}
                                  >
                                    <span className="sr-only">SIREN / SIRET TVA intracom.</span>
                                    <div data-party-identity-row="SIREN" className={partyIdentityRowClassName}>
                                      <span className={partyIdentityLabelClassName}>SIREN</span>
                                      {renderPartyInlineInput("siren", "SIREN client", {
                                        autoFocus: partyEditSection === "client-identity",
                                        className: "font-semibold",
                                        inputMode: "numeric",
                                      })}
                                    </div>
                                    <div data-party-identity-row="SIRET" className={partyIdentityRowClassName}>
                                      <span className={partyIdentityLabelClassName}>SIRET</span>
                                      {renderPartyInlineInput("siret", "SIRET client", {
                                        className: "font-semibold",
                                        inputMode: "numeric",
                                      })}
                                    </div>
                                    <div data-party-identity-row="N° TVA" className={partyIdentityRowClassName}>
                                      <span className={partyIdentityLabelClassName}>N° TVA</span>
                                      {renderPartyInlineInput("vat_number", "N° TVA client", {
                                        className: "font-semibold",
                                      })}
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    className={`${partyIdentityGridClassName} text-[#64748b]`}
                                    style={{ fontSize: "0.75rem", lineHeight: 1.38 }}
                                  >
                                    <span className="sr-only">SIREN / SIRET TVA intracom.</span>
                                    {customerIdentityRows.map((row) => (
                                      <div
                                        key={`invoice-customer-${row.label}`}
                                        data-party-identity-row={row.label}
                                        className={partyIdentityRowClassName}
                                      >
                                        <span className={partyIdentityLabelClassName}>{row.label}</span>
                                        <span
                                          data-party-editable-field
                                          data-party-identity-value
                                          className={`${row.mono ? "font-mono" : ""} min-w-0 truncate whitespace-nowrap font-semibold text-[#334155]`}
                                        >
                                          {row.value}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : null}
                          {seqinoOperational && selectedCustomer && selectedDirectoryInfo ? (
                            <div className="rounded-xl border border-[#bfdbfe] bg-white/70 px-3 py-2 text-[#2563eb]">
                              <div style={{ fontSize: "0.6875rem", fontWeight: 850 }}>Synchronisation Seqino</div>
                              <div
                                className="mt-1 space-y-0.5 text-[#64748b]"
                                style={{ fontSize: "0.6875rem", lineHeight: 1.5 }}
                              >
                                <div>Plateforme: {selectedDirectoryInfo.platform_slug || "—"}</div>
                                <div>Adresse de facturation: {selectedDirectoryInfo.billing_address || "—"}</div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <label data-testid="document-title-section" className="mb-5 mt-4 block">
                  <span className="sr-only">{documentTitleLabel}</span>
                  <input
                    value={form.document_title || ""}
                    onChange={(event) => setFormField("document_title", event.target.value)}
                    placeholder={documentTitleLabel}
                    aria-label={documentTitleLabel}
                    className="h-9 w-full rounded-xl border border-[#cbd5e1] bg-white px-3 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.02)] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                    style={{ fontSize: "0.78125rem", fontWeight: 700 }}
                  />
                </label>
                <div
                  id="document-lines-section"
                  className="overflow-visible rounded-t-xl border border-[#dbe3ef] bg-white shadow-[0_5px_16px_rgba(15,23,42,0.035)]"
                >
                  {!compactEditorMode ? (
                    <div className="flex flex-wrap gap-2 border-b border-[#e2e8f0] bg-white px-3 py-2">
                      {QUICK_LINE_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => addLine(preset)}
                          className="rounded-full border border-[#d6deea] bg-white px-3 py-1.5 text-[#475569] hover:bg-[#f8fafc]"
                          style={{ fontSize: "0.75rem", fontWeight: 700 }}
                        >
                          + {preset.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="relative">
                    <div className="rounded-none bg-white">
                      <div className="overflow-visible rounded-none">
                        <div
                          className={`hidden gap-2 border-b px-2 py-1.5 xl:grid ${lineTableGridClassName}`}
                          style={
                            {
                              "--line-grid-template": lineTableGridTemplate,
                              borderColor: accentBorder,
                              background: accentLight,
                              fontSize: "0.78125rem",
                              fontWeight: 650,
                              color: "#0f172a",
                              textTransform: "none",
                              letterSpacing: 0,
                            } as CSSProperties
                          }
                        >
                          <div
                            ref={lineColumnsMenuRef}
                            className="relative flex w-full min-w-0 justify-self-stretch items-center justify-center text-center"
                          >
                            <GuidanceTooltip content="Choisissez les colonnes utiles pour saisir ce document. Les colonnes masquées ne sont pas supprimées.">
                              <button
                                type="button"
                                onClick={() => setLineColumnsMenuOpen((open) => !open)}
                                aria-label="Personnaliser les colonnes"
                                aria-expanded={lineColumnsMenuOpen}
                                data-testid="line-columns-settings"
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-transparent transition hover:bg-white focus:bg-white focus:outline-none focus:ring-2"
                                style={{ color: accentColor, ["--tw-ring-color" as any]: accentBorder }}
                              >
                                <Settings2 className="h-4 w-4" />
                              </button>
                            </GuidanceTooltip>
                            {lineColumnsMenuOpen ? (
                              <div
                                data-testid="line-columns-menu"
                                className="absolute left-0 top-8 z-50 w-[220px] rounded-xl border bg-white p-2 text-left normal-case tracking-normal text-[#0f172a] shadow-[0_16px_36px_rgba(37,99,235,0.16)]"
                                style={{ borderColor: accentBorder }}
                              >
                                <div
                                  className="px-2 pb-2"
                                  style={{ color: accentColor, fontSize: "0.75rem", fontWeight: 900 }}
                                >
                                  Colonnes du tableau
                                </div>
                                <label
                                  className="flex cursor-not-allowed items-center gap-2 rounded-lg px-2 py-1.5 text-[#64748b]"
                                  style={{ fontSize: "0.75rem", fontWeight: 750 }}
                                >
                                  <input
                                    type="checkbox"
                                    checked
                                    readOnly
                                    className="h-3.5 w-3.5 rounded border-[#cbd5e1]"
                                  />
                                  {documentCopy.productService}
                                </label>
                                <div className="my-1 border-t border-[#e2e8f0]" />
                                {LINE_COLUMN_OPTIONS.map((option) => (
                                  <label
                                    key={option.id}
                                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[#334155] transition"
                                    style={{ fontSize: "0.75rem", fontWeight: 750 }}
                                    onMouseEnter={(event) => {
                                      event.currentTarget.style.background = accentLight;
                                    }}
                                    onMouseLeave={(event) => {
                                      event.currentTarget.style.background = "";
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={lineColumnVisibility[option.id]}
                                      onChange={() => toggleLineColumn(option.id)}
                                      className={`h-3.5 w-3.5 rounded border-[#cbd5e1] ${
                                        isInvoice ? "accent-[#2563eb]" : "accent-[#7c3aed]"
                                      }`}
                                    />
                                    {option.label}
                                  </label>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          {showLineNumberColumn ? (
                            <span
                              data-testid="line-header-number"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center text-center"
                            >
                              {documentCopy.lineNumber}
                            </span>
                          ) : null}
                          {showLineReferenceColumn ? (
                            <span
                              data-testid="line-header-reference"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center border-r border-[#dbe3ef] pr-3 text-center"
                            >
                              {documentCopy.reference}
                            </span>
                          ) : null}
                          <span
                            data-testid="line-header-name"
                            className="flex w-full min-w-0 justify-self-stretch items-center justify-center gap-1.5 text-center"
                          >
                            {documentCopy.productService}
                          </span>
                          {showQuantityColumn ? (
                            <span
                              data-testid="line-header-quantity"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center text-center"
                            >
                              {documentCopy.quantity}
                            </span>
                          ) : null}
                          {showUnitColumn ? (
                            <span
                              data-testid="line-header-unit"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center text-center"
                            >
                              {documentCopy.unit}
                            </span>
                          ) : null}
                          {showUnitPriceColumn ? (
                            <span
                              data-testid="line-header-unit-price"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center text-center"
                            >
                              {documentCopy.unitPriceHT}
                            </span>
                          ) : null}
                          {showVatColumn ? (
                            <span
                              data-testid="line-header-vat"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center text-center"
                            >
                              {documentCopy.vat}
                            </span>
                          ) : null}
                          {showLineDiscountInputColumn ? (
                            <span
                              data-testid="line-header-discount"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center text-center text-[#c2410c]"
                            >
                              {documentCopy.discount}
                            </span>
                          ) : null}
                          {showBaseTotalColumn ? (
                            <span
                              data-testid="line-header-base-total"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center text-center"
                            >
                              {documentCopy.totalHT}
                            </span>
                          ) : null}
                          {showDiscountedTotalColumn ? (
                            <span
                              data-testid="line-header-total"
                              className="flex w-full min-w-0 justify-self-stretch items-center justify-center text-center text-[#c2410c]"
                            >
                              {documentCopy.discountedHT}
                            </span>
                          ) : null}
                        </div>
                        {lines.map((line, index) => {
                          const lineTotal = lineTotalHT(line);
                          const baseLineTotal = lineBaseTotalHT(line);
                          const discountPercent = lineDiscountPercent(line);
                          const hasAppliedLineDiscount = discountPercent > 0;
                          const lineComplianceNeedsAttention = lineNeedsAdvancedComplianceAttention(
                            line,
                            company,
                            documentCopy,
                          );
                          const lineComplianceOpen = lineComplianceOpenIds.includes(line.id);
                          const lineComplianceVisible =
                            lineComplianceNeedsAttention || (advancedComplianceVisible && lineComplianceOpen);
                          const categoryComplianceFieldId = `${line.id}:vat_category`;
                          const exemptionComplianceFieldId = `${line.id}:exemption_reason_code`;
                          const unitComplianceFieldId = `${line.id}:unit_code`;
                          const compactVatCategoryIsDefault = lineVatCategory(line) === "S";
                          const compactUnitCodeIsDefault = lineUnitCode(line) === "C62";
                          const showCategoryPlaceholder =
                            compactVatCategoryIsDefault && focusedComplianceField !== categoryComplianceFieldId;
                          const showExemptionPlaceholder =
                            !String(line.exemption_reason_code || "").trim() &&
                            focusedComplianceField !== exemptionComplianceFieldId;
                          const showUnitPlaceholder =
                            compactUnitCodeIsDefault && focusedComplianceField !== unitComplianceFieldId;
                          const lineType = String(line?.line_type || "item");
                          const itemLineNumber = lines
                            .slice(0, index + 1)
                            .filter((candidate) => String(candidate?.line_type || "item") === "item").length;
                          const lineDisplayNumber =
                            Object.prototype.hasOwnProperty.call(line, "display_number") && line.display_number !== null
                              ? String(line.display_number)
                              : String(itemLineNumber);
                          const lineAccountingAccount = sanitizeAccountingAccount(line?.accounting_account);
                          const lineAccountingIsPreset = SALES_ACCOUNT_OPTIONS.some(
                            (option) => option.value === lineAccountingAccount,
                          );
                          const lineAccountingCustomOpen = lineAccountingCustomOpenIds.includes(line.id);
                          const lineAccountingOptionValue =
                            lineAccountingCustomOpen || (lineAccountingAccount && !lineAccountingIsPreset)
                              ? "custom"
                              : lineAccountingAccount || "";
                          const depositDeductionLine = isDepositDeductionLine(line);
                          const lineActionMenuOpen = lineActionMenuOpenId === line.id;
                          const lineCatalogSuggestions =
                            lineType === "item" && !depositDeductionLine ? catalogSuggestionsForLine(line) : [];
                          const lineCatalogExactMatch =
                            lineType === "item" && !depositDeductionLine ? catalogExactMatchForLine(line) : null;
                          const lineProductName = String(line?.product_name || "").trim();
                          const lineIsCatalogTarget = Boolean(
                            activeCompactPanel === "catalog" && catalogPanelTargetLineId === line.id,
                          );
                          const showLineCatalogMenu =
                            catalogLineMenuOpenId === line.id && lineType === "item" && !depositDeductionLine;
                          const lineSideActions = (
                            <div
                              data-line-action-menu-root="true"
                              className="relative flex h-8 items-center justify-end xl:justify-center"
                            >
                              <GuidanceTooltip content="Cliquez pour dupliquer, ajouter, commenter ou supprimer la ligne. Maintenez et glissez pour changer l'ordre.">
                                <button
                                  type="button"
                                  draggable
                                  onDragStart={(event) => {
                                    setDraggedLineId(line.id);
                                    setLineDragTarget(null);
                                    setLineActionMenuOpenId(null);
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData("text/plain", line.id);
                                  }}
                                  onDragEnd={() => {
                                    setDraggedLineId(null);
                                    setLineDragTarget(null);
                                  }}
                                  onClick={() =>
                                    setLineActionMenuOpenId((openId) => (openId === line.id ? null : line.id))
                                  }
                                  aria-label={`Options ligne ${index + 1}`}
                                  aria-expanded={lineActionMenuOpen}
                                  aria-haspopup="dialog"
                                  data-testid={`line-side-options-${index + 1}`}
                                  className={`${lineSideActionButtonClassName} group cursor-grab active:cursor-grabbing`}
                                >
                                  <Pencil
                                    className={`h-4 w-4 ${
                                      draggedLineId === line.id ? "hidden" : "block group-hover:hidden"
                                    }`}
                                  />
                                  <GripVertical
                                    className={`h-4 w-4 ${
                                      draggedLineId === line.id ? "block" : "hidden group-hover:block"
                                    }`}
                                  />
                                </button>
                              </GuidanceTooltip>
                              {lineActionMenuOpen ? (
                                <div
                                  data-testid={`line-side-menu-${index + 1}`}
                                  role="group"
                                  aria-label={`Actions ligne ${index + 1}`}
                                  className={lineSideActionMenuClassName}
                                >
                                  <button
                                    type="button"
                                    onClick={() => duplicateLine(line.id)}
                                    className={lineSideActionMenuItemClassName}
                                    style={{ fontSize: "0.75rem", fontWeight: 800 }}
                                  >
                                    <Copy className="h-3.5 w-3.5" style={{ color: accentColor }} /> Dupliquer
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => insertLineRelative(line.id, "above", "item")}
                                    className={lineSideActionMenuItemClassName}
                                    style={{ fontSize: "0.75rem", fontWeight: 800 }}
                                  >
                                    <Plus className="h-3.5 w-3.5" style={{ color: accentColor }} /> Ligne au-dessus
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => insertLineRelative(line.id, "below", "item")}
                                    className={lineSideActionMenuItemClassName}
                                    style={{ fontSize: "0.75rem", fontWeight: 800 }}
                                  >
                                    <Plus className="h-3.5 w-3.5" style={{ color: accentColor }} /> Ligne dessous
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => insertLineRelative(line.id, "below", "comment")}
                                    className={lineSideActionMenuItemClassName}
                                    style={{ fontSize: "0.75rem", fontWeight: 800 }}
                                  >
                                    <FileText className="h-3.5 w-3.5" style={{ color: accentColor }} /> Commentaire
                                  </button>
                                  <div className="my-1 border-t border-[#e2e8f0]" />
                                  {lineType === "item" ? (
                                    <>
                                      <div
                                        id={`line-accounting-menu-${index + 1}`}
                                        data-testid={`line-accounting-menu-${index + 1}`}
                                        role="group"
                                        aria-label={`Catégorie compta ligne ${index + 1}`}
                                        className="mx-0.5 my-1 box-border grid min-w-0 max-w-full gap-1.5 overflow-hidden rounded-xl border border-[#dbeafe] bg-[#f8fbff] p-1.5"
                                      >
                                        <div
                                          className="flex min-w-0 items-center gap-2 text-[#0f172a]"
                                          style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                                        >
                                          <Hash className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />
                                          <GuidanceTooltip content="Catégorie utilisée pour préparer l'export comptable. Laissez Auto sauf demande du cabinet.">
                                            <span className="min-w-0 flex-1 cursor-help truncate" tabIndex={0}>
                                              Catégorie compta
                                            </span>
                                          </GuidanceTooltip>
                                        </div>
                                        <div className="relative min-w-0 overflow-hidden">
                                          <select
                                            aria-label={`Catégorie compta ligne ${index + 1}`}
                                            title="Catégorie utilisée pour préparer l'export comptable de cette ligne."
                                            value={lineAccountingOptionValue}
                                            onChange={(event) =>
                                              selectLineAccountingAccount(line.id, event.target.value)
                                            }
                                            className="block box-border h-8 w-full min-w-0 max-w-full appearance-none cursor-pointer truncate rounded-lg border border-[#bfdbfe] bg-white px-2 py-1 pr-7 font-semibold text-[#0f172a] outline-none transition hover:border-[#60a5fa] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                            style={{
                                              width: "100%",
                                              minWidth: 0,
                                              maxWidth: "100%",
                                              minInlineSize: 0,
                                              maxInlineSize: "100%",
                                              fontSize: "0.6875rem",
                                            }}
                                          >
                                            <option value="">Auto - {defaultLineAccountingAccount}</option>
                                            {SALES_ACCOUNT_OPTIONS.map((option) => (
                                              <option key={option.value} value={option.value}>
                                                {option.label}
                                              </option>
                                            ))}
                                            <option value="custom">Code fourni par mon comptable</option>
                                          </select>
                                          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748b]" />
                                        </div>
                                        {lineAccountingOptionValue === "custom" ? (
                                          <label
                                            className="grid gap-1 text-[#64748b]"
                                            style={{ fontSize: "0.6875rem", fontWeight: 800 }}
                                          >
                                            Code personnalisé
                                            <input
                                              aria-label={`Code comptable fourni par mon comptable ligne ${index + 1}`}
                                              value={lineAccountingAccount}
                                              onChange={(event) =>
                                                updateLine(
                                                  line.id,
                                                  "accounting_account",
                                                  sanitizeAccountingAccount(event.target.value),
                                                )
                                              }
                                              placeholder={defaultLineAccountingAccount}
                                              className="h-8 w-full rounded-lg border border-[#bfdbfe] bg-white px-2 py-1 font-mono text-[#0f172a] outline-none placeholder:text-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                              style={{ fontSize: "0.75rem", fontWeight: 850 }}
                                            />
                                            {lineAccountingAccount && lineAccountingAccount.length < 3 ? (
                                              <span
                                                className="text-[#dc2626]"
                                                style={{ fontSize: "0.6875rem", fontWeight: 800 }}
                                              >
                                                Minimum 3 caractères.
                                              </span>
                                            ) : null}
                                          </label>
                                        ) : null}
                                        {lineAccountingAccount ? (
                                          <button
                                            type="button"
                                            onClick={() => clearLineAccounting(line.id)}
                                            className="inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-lg border border-[#bfdbfe] bg-white text-[#1d4ed8] transition hover:bg-[#eff6ff]"
                                            style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                                          >
                                            <X className="h-3.5 w-3.5" />
                                            Revenir au compte automatique
                                          </button>
                                        ) : null}
                                      </div>
                                    </>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => removeLine(line.id)}
                                    className={`${lineSideActionMenuItemClassName} text-[#dc2626] hover:bg-[#fef2f2]`}
                                    style={{ fontSize: "0.75rem", fontWeight: 800 }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" /> Supprimer
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                          if (lineType === "title") {
                            return (
                              <div
                                key={line.id}
                                {...lineDragHandlers(line.id)}
                                data-testid={`invoice-title-row-${index + 1}`}
                                className={`grid grid-cols-1 gap-2 border-b border-[#e2e8f0] bg-[#f8fbff] px-2 py-2 xl:grid-cols-[30px_minmax(0,1fr)] ${
                                  lineDragTarget?.id === line.id ? "ring-2 ring-[#93c5fd] ring-inset" : ""
                                }`}
                              >
                                {lineSideActions}
                                <div className="flex items-center">
                                  <input
                                    aria-label={`Titre de section ligne ${index + 1}`}
                                    value={line.product_name || ""}
                                    onChange={(event) => updateLine(line.id, "product_name", event.target.value)}
                                    placeholder="Titre de la section"
                                    className="h-8 min-w-0 flex-1 rounded-lg border border-[#bfdbfe] bg-white px-2.5 text-[#1d4ed8] outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                    style={{ fontSize: "0.8125rem", fontWeight: 900 }}
                                  />
                                </div>
                              </div>
                            );
                          }
                          if (lineType === "comment") {
                            const commentValue =
                              line.product_name === "Commentaire..." || line.product_name === "Commentaire"
                                ? ""
                                : line.detail || line.product_name || "";
                            return (
                              <div
                                key={line.id}
                                {...lineDragHandlers(line.id)}
                                data-testid={`invoice-comment-row-${index + 1}`}
                                className={`grid grid-cols-1 gap-2 border-b border-[#e2e8f0] bg-white px-2 py-2 xl:grid-cols-[30px_minmax(0,1fr)] ${
                                  lineDragTarget?.id === line.id ? "ring-2 ring-[#93c5fd] ring-inset" : ""
                                }`}
                              >
                                {lineSideActions}
                                <div className="flex items-start">
                                  <textarea
                                    aria-label={`Commentaire ligne ${index + 1}`}
                                    ref={autoResizeTextarea}
                                    value={commentValue}
                                    onInput={(event) => autoResizeTextarea(event.currentTarget)}
                                    onChange={(event) => {
                                      autoResizeTextarea(event.currentTarget);
                                      updateLine(line.id, "detail", event.target.value);
                                      updateLine(line.id, "product_name", event.target.value);
                                    }}
                                    placeholder="Commentaire..."
                                    rows={1}
                                    className="min-h-9 min-w-0 flex-1 resize-none overflow-hidden rounded-lg border border-[#d6deea] bg-white px-2.5 py-1.5 text-[#334155] outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                    style={{ fontSize: "0.8125rem", lineHeight: 1.35 }}
                                  />
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div
                              key={line.id}
                              {...lineDragHandlers(line.id)}
                              data-testid={`invoice-line-row-${index + 1}`}
                              data-deposit-deduction={depositDeductionLine ? "true" : undefined}
                              className={`border-b px-2 py-2 last:border-0 ${
                                lineIsCatalogTarget
                                  ? "border-[#bfdbfe] bg-[#eff6ff] shadow-[inset_3px_0_0_#2563eb]"
                                  : depositDeductionLine
                                    ? "border-[#bfdbfe] bg-[#eff6ff]/45 hover:bg-[#eff6ff]/70"
                                    : "border-[#e2e8f0] hover:bg-[#f8fafc]/70"
                              } ${
                                lineDragTarget?.id === line.id || lineIsCatalogTarget
                                  ? "ring-2 ring-[#93c5fd] ring-inset"
                                  : ""
                              }`}
                            >
                              <div
                                className={`grid grid-cols-1 gap-2 xl:items-start ${lineTableGridClassName}`}
                                style={lineTableGridStyle}
                              >
                                {lineSideActions}
                                {showLineNumberColumn ? (
                                  <div className="min-w-0 w-full">
                                    <div
                                      className="mb-1 text-[#94a3b8] xl:hidden"
                                      style={{
                                        fontSize: "0.625rem",
                                        fontWeight: 700,
                                        textTransform: "uppercase",
                                        letterSpacing: "0.05em",
                                      }}
                                    >
                                      {documentCopy.lineNumber}
                                    </div>
                                    <GuidanceTooltip content="Numéro de ligne visible dans l'éditeur. Vous pouvez le corriger si besoin.">
                                      <input
                                        aria-label={`Numéro ligne ${index + 1}`}
                                        inputMode="numeric"
                                        data-line-number-input
                                        data-testid={`line-number-${index + 1}`}
                                        value={lineDisplayNumber}
                                        onChange={(event) => updateLine(line.id, "display_number", event.target.value)}
                                        className={`${lineControlClassName} text-center tabular-nums`}
                                        style={{ fontSize: "0.875rem", fontWeight: 900 }}
                                      />
                                    </GuidanceTooltip>
                                  </div>
                                ) : null}
                                {showLineReferenceColumn ? (
                                  <div className="min-w-0 w-full border-r border-[#e2e8f0] pr-3">
                                    <div
                                      className="mb-1 text-[#94a3b8] xl:hidden"
                                      style={{
                                        fontSize: "0.625rem",
                                        fontWeight: 700,
                                        textTransform: "uppercase",
                                        letterSpacing: "0.05em",
                                      }}
                                    >
                                      {documentCopy.reference}
                                    </div>
                                    <input
                                      aria-label={`Référence ligne ${index + 1}`}
                                      value={line.reference || ""}
                                      onChange={(event) => updateLine(line.id, "reference", event.target.value)}
                                      placeholder="Réf."
                                      className={lineControlClassName}
                                      style={{ fontSize: "0.875rem" }}
                                    />
                                  </div>
                                ) : null}
                                <div className="relative min-w-0 w-full">
                                  <div className="mb-1 flex items-center justify-between gap-2 xl:hidden">
                                    <div
                                      className={depositDeductionLine ? "text-[#1d4ed8]" : "text-[#94a3b8]"}
                                      style={{
                                        fontSize: "0.625rem",
                                        fontWeight: 700,
                                        textTransform: "uppercase",
                                        letterSpacing: "0.05em",
                                      }}
                                    >
                                      {documentCopy.designation}
                                    </div>
                                  </div>
                                  {depositDeductionLine ? (
                                    <div
                                      data-testid={`deposit-deduction-badge-${index + 1}`}
                                      className="mb-1 inline-flex items-center gap-1 rounded-full border border-[#bfdbfe] bg-white px-2 py-0.5 text-[#1d4ed8]"
                                      style={{ fontSize: "0.625rem", fontWeight: 850 }}
                                    >
                                      <ReceiptText className="h-3 w-3" /> Acompte déduit
                                    </div>
                                  ) : null}
                                  <div
                                    className={`${lineTextControlFrameClassName} ${
                                      depositDeductionLine ? "border-[#bfdbfe] bg-white text-[#1d4ed8]" : ""
                                    }`}
                                  >
                                    <input
                                      aria-label={`Désignation ligne ${index + 1}`}
                                      value={line.product_name || ""}
                                      onFocus={() => openLineCatalogMenu(line.id)}
                                      onClick={() => openLineCatalogMenu(line.id)}
                                      onBlur={() => scheduleLineCatalogMenuClose(line.id)}
                                      onChange={(event) => {
                                        updateLine(line.id, "product_name", event.target.value);
                                        openLineCatalogMenu(line.id);
                                      }}
                                      placeholder={`Ligne ${index + 1} — désignation`}
                                      className="h-full min-w-0 flex-1 truncate border-0 bg-transparent px-2.5 py-1 text-[#0f172a] outline-none placeholder:text-[#94a3b8] focus:outline-none focus:ring-0"
                                      style={{ fontSize: "0.8125rem" }}
                                    />
                                  </div>
                                  {showLineCatalogMenu ? (
                                    <div
                                      className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-40 overflow-hidden rounded-xl border bg-white shadow-[0_16px_36px_rgba(37,99,235,0.16)]"
                                      style={{ borderColor: accentBorder }}
                                    >
                                      {lineCatalogSuggestions.length && lineProductName && !lineCatalogExactMatch ? (
                                        <div className="space-y-1.5 px-2 py-2 text-[#64748b]">
                                          <button
                                            type="button"
                                            data-testid={`line-catalog-quick-add-${index + 1}`}
                                            onMouseDown={(event) => event.preventDefault()}
                                            onClick={() => void openCatalogQuickCreate(line)}
                                            disabled={catalogQuickCreateLineId === line.id}
                                            className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition disabled:cursor-wait disabled:opacity-60"
                                            style={{ color: accentColor, fontSize: "0.75rem", fontWeight: 850 }}
                                          >
                                            <Plus className="h-3.5 w-3.5 shrink-0" />
                                            <span className="shrink-0">
                                              {catalogQuickCreateLineId === line.id
                                                ? "Ajout en cours..."
                                                : "Ajouter cette ligne"}
                                            </span>
                                            <span className="min-w-0 truncate text-[#64748b]">{lineProductName}</span>
                                          </button>
                                        </div>
                                      ) : null}
                                      {lineCatalogSuggestions.length ? (
                                        <div className="max-h-48 overflow-y-auto py-1">
                                          {lineCatalogSuggestions.map((item) => (
                                            <button
                                              key={item.id || item.name}
                                              type="button"
                                              onMouseDown={(event) => event.preventDefault()}
                                              onClick={() => applyCatalogItemToLine(line.id, item)}
                                              className="flex w-full items-start gap-3 px-3 py-2 text-left transition"
                                              onMouseEnter={(event) => {
                                                event.currentTarget.style.background = accentLight;
                                              }}
                                              onMouseLeave={(event) => {
                                                event.currentTarget.style.background = "";
                                              }}
                                            >
                                              <span className="min-w-0">
                                                <span
                                                  className="block truncate text-[#0f172a]"
                                                  style={{ fontSize: "0.75rem", fontWeight: 850 }}
                                                >
                                                  {item?.name || "Article"}
                                                </span>
                                                <span
                                                  className="block truncate text-[#64748b]"
                                                  style={{ fontSize: "0.6875rem" }}
                                                >
                                                  {money(item?.unit_price || 0, form.currency)} · TVA{" "}
                                                  {Number(item?.vat_rate || 20)}%
                                                </span>
                                              </span>
                                            </button>
                                          ))}
                                        </div>
                                      ) : (
                                        <div className="space-y-1.5 px-2 py-2 text-[#64748b]">
                                          {lineProductName ? (
                                            <button
                                              type="button"
                                              data-testid={`line-catalog-quick-add-${index + 1}`}
                                              onMouseDown={(event) => event.preventDefault()}
                                              onClick={() => void openCatalogQuickCreate(line)}
                                              disabled={catalogQuickCreateLineId === line.id}
                                              className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition disabled:cursor-wait disabled:opacity-60"
                                              style={{ color: accentColor, fontSize: "0.75rem", fontWeight: 850 }}
                                            >
                                              <Plus className="h-3.5 w-3.5 shrink-0" />
                                              <span className="shrink-0">
                                                {catalogQuickCreateLineId === line.id
                                                  ? "Ajout en cours..."
                                                  : "Ajouter cette ligne"}
                                              </span>
                                              <span className="min-w-0 truncate text-[#64748b]">{lineProductName}</span>
                                            </button>
                                          ) : null}
                                          <button
                                            type="button"
                                            aria-label={`Voir le catalogue ligne ${index + 1}`}
                                            data-testid={`line-catalog-open-${index + 1}`}
                                            onMouseDown={(event) => event.preventDefault()}
                                            onClick={() => openCatalogManager(line.id)}
                                            className="inline-flex h-8 w-full items-center justify-center rounded-lg border bg-white px-3 transition hover:bg-white focus:outline-none focus:ring-2"
                                            style={{
                                              borderColor: accentBorder,
                                              color: accentColor,
                                              fontSize: "0.75rem",
                                              fontWeight: 850,
                                              ["--tw-ring-color" as any]: accentBorder,
                                            }}
                                          >
                                            Voir le catalogue
                                          </button>
                                        </div>
                                      )}
                                      {lineCatalogSuggestions.length ? (
                                        <div
                                          className="space-y-1.5 border-t bg-[#f8fbff] p-2"
                                          style={{ borderColor: accentBorder }}
                                        >
                                          <button
                                            type="button"
                                            aria-label={`Voir le catalogue ligne ${index + 1}`}
                                            data-testid={`line-catalog-open-${index + 1}`}
                                            onMouseDown={(event) => event.preventDefault()}
                                            onClick={() => openCatalogManager(line.id)}
                                            className="inline-flex h-8 w-full items-center justify-center rounded-lg border bg-white px-3 transition hover:bg-white focus:outline-none focus:ring-2"
                                            style={{
                                              borderColor: accentBorder,
                                              color: accentColor,
                                              fontSize: "0.75rem",
                                              fontWeight: 850,
                                              ["--tw-ring-color" as any]: accentBorder,
                                            }}
                                          >
                                            Voir le catalogue
                                          </button>
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                                <div className="grid grid-cols-2 gap-2 xl:contents">
                                  {showQuantityColumn ? (
                                    <div className="min-w-0 w-full">
                                      <div
                                        className="mb-1 text-[#94a3b8] xl:hidden"
                                        style={{
                                          fontSize: "0.625rem",
                                          fontWeight: 700,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.05em",
                                        }}
                                      >
                                        {documentCopy.quantity}
                                      </div>
                                      <input
                                        aria-label={`Quantité ligne ${index + 1}`}
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={line.quantity}
                                        onChange={(event) => updateLine(line.id, "quantity", event.target.value)}
                                        className={`${lineControlClassName} ${numberInputNoSpinnerClassName} text-right`}
                                        style={{ fontSize: "0.875rem" }}
                                      />
                                    </div>
                                  ) : null}
                                  {showUnitColumn ? (
                                    <div className="min-w-0 w-full">
                                      <div
                                        className="mb-1 text-[#94a3b8] xl:hidden"
                                        style={{
                                          fontSize: "0.625rem",
                                          fontWeight: 700,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.05em",
                                        }}
                                      >
                                        {documentCopy.unit}
                                      </div>
                                      <input
                                        aria-label={`Unité ligne ${index + 1}`}
                                        value={lineUnitCode(line)}
                                        onChange={(event) => updateLine(line.id, "unit_code", event.target.value)}
                                        list="invoice-unit-code-suggestions"
                                        placeholder="C62"
                                        className={`${lineControlClassName} text-center uppercase`}
                                        style={{ fontSize: "0.875rem" }}
                                      />
                                    </div>
                                  ) : null}
                                  {showUnitPriceColumn ? (
                                    <div className="min-w-0 w-full">
                                      <div
                                        className="mb-1 text-[#94a3b8] xl:hidden"
                                        style={{
                                          fontSize: "0.625rem",
                                          fontWeight: 700,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.05em",
                                        }}
                                      >
                                        {documentCopy.unitPriceHT}
                                      </div>
                                      <input
                                        aria-label={`Prix unitaire HT ligne ${index + 1}`}
                                        type="number"
                                        min={depositDeductionLine ? undefined : "0"}
                                        step="0.01"
                                        value={line.unit_price}
                                        onChange={(event) => updateLine(line.id, "unit_price", event.target.value)}
                                        className={`${lineControlClassName} ${numberInputNoSpinnerClassName} text-right ${
                                          depositDeductionLine
                                            ? "border-[#bfdbfe] bg-white font-bold text-[#1d4ed8]"
                                            : ""
                                        }`}
                                        style={{ fontSize: "0.875rem" }}
                                      />
                                    </div>
                                  ) : null}
                                  {showVatColumn ? (
                                    <div className="min-w-0 w-full">
                                      <div
                                        className="mb-1 text-[#94a3b8] xl:hidden"
                                        style={{
                                          fontSize: "0.625rem",
                                          fontWeight: 700,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.05em",
                                        }}
                                      >
                                        {documentCopy.vat}
                                      </div>
                                      <div
                                        className={`flex h-8 w-full items-center justify-end gap-1 rounded-lg border border-[#cbd5e1] bg-white px-2 text-right text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition hover:border-[#93c5fd] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe] ${
                                          companyVatFranchise ? "bg-[#f8fafc] opacity-70" : ""
                                        }`}
                                        style={{ fontSize: "0.8125rem", fontVariantNumeric: "tabular-nums" }}
                                      >
                                        <input
                                          aria-label={`TVA ligne ${index + 1}`}
                                          inputMode="decimal"
                                          value={formatVatRateInputDisplay(line.vat_rate)}
                                          onChange={(event) => updateLine(line.id, "vat_rate", event.target.value)}
                                          disabled={companyVatFranchise}
                                          title={
                                            companyVatFranchise
                                              ? "Franchise en base : TVA désactivée sur les lignes."
                                              : undefined
                                          }
                                          placeholder="0"
                                          className={`h-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-right shadow-none outline-none ring-0 focus:border-transparent focus:outline-none focus:ring-0 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 ${
                                            companyVatFranchise ? "cursor-not-allowed text-[#94a3b8]" : "text-[#0f172a]"
                                          }`}
                                          style={{
                                            border: 0,
                                            boxShadow: "none",
                                            fontSize: "0.8125rem",
                                            fontWeight: 700,
                                            fontVariantNumeric: "tabular-nums",
                                            outline: "none",
                                          }}
                                        />
                                        <span
                                          className="text-[#64748b]"
                                          style={{
                                            fontSize: "0.75rem",
                                            fontWeight: 800,
                                            fontVariantNumeric: "tabular-nums",
                                          }}
                                        >
                                          %
                                        </span>
                                      </div>
                                    </div>
                                  ) : null}
                                  {showLineDiscountInputColumn ? (
                                    <div className="min-w-0 w-full">
                                      <div
                                        className={`mb-1 ${hasAppliedLineDiscount ? "text-[#c2410c]" : "text-[#94a3b8]"} xl:hidden`}
                                        style={{
                                          fontSize: "0.625rem",
                                          fontWeight: 700,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.05em",
                                        }}
                                      >
                                        {documentCopy.discount}
                                      </div>
                                      <div
                                        data-testid="line-discount-column"
                                        className={`isolate flex h-8 w-full min-w-0 max-w-full overflow-hidden rounded-lg border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe] ${
                                          hasAppliedLineDiscount
                                            ? "border-[#fdba74] text-[#c2410c]"
                                            : "border-[#cbd5e1] text-[#64748b]"
                                        }`}
                                      >
                                        <input
                                          aria-label={`Remise ligne ${index + 1}`}
                                          inputMode="decimal"
                                          value={
                                            line.discount_input_mode === "amount"
                                              ? line.discount_amount_ht
                                              : (line.discount_percent ?? "")
                                          }
                                          onChange={(event) =>
                                            updateLine(
                                              line.id,
                                              line.discount_input_mode === "amount"
                                                ? "discount_amount_ht"
                                                : "discount_percent",
                                              event.target.value,
                                            )
                                          }
                                          placeholder="0"
                                          className={`h-full min-w-[42px] flex-1 border-0 bg-transparent px-2 text-right shadow-none outline-none ring-0 focus:border-transparent focus:outline-none focus:ring-0 focus-visible:outline-none ${
                                            hasAppliedLineDiscount
                                              ? "text-[#c2410c] placeholder:text-[#fdba74]"
                                              : "text-[#0f172a] placeholder:text-[#94a3b8]"
                                          }`}
                                          style={{ fontSize: "clamp(0.625rem, 0.72vw, 0.8125rem)", fontWeight: 850 }}
                                        />
                                        <div className="flex h-full shrink-0 overflow-hidden border-l border-[#e2e8f0] bg-[#f8fafc]">
                                          {(["percent", "amount"] as const).map((discountMode) => {
                                            const activeMode =
                                              line.discount_input_mode === "amount" ? "amount" : "percent";
                                            const active = activeMode === discountMode;
                                            return (
                                              <button
                                                key={discountMode}
                                                type="button"
                                                onClick={() => setLineDiscountInputMode(line.id, discountMode)}
                                                aria-label={`Mode réduction, ligne ${index + 1} : ${
                                                  discountMode === "amount" ? "euros" : "pourcentage"
                                                }`}
                                                className={`flex h-full w-6 items-center justify-center transition ${
                                                  active
                                                    ? "bg-[#c2410c]/85 text-white"
                                                    : "bg-[#fff7ed] text-[#9a3412] hover:bg-[#ffedd5]"
                                                }`}
                                                style={{ fontSize: "0.6875rem", fontWeight: 900 }}
                                              >
                                                {discountMode === "amount" ? "€" : "%"}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    </div>
                                  ) : null}
                                  {showBaseTotalColumn ? (
                                    <div className="min-w-0 w-full">
                                      <div
                                        className="mb-1 text-[#94a3b8] xl:hidden"
                                        style={{
                                          fontSize: "0.625rem",
                                          fontWeight: 700,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.05em",
                                        }}
                                      >
                                        {documentCopy.totalHT}
                                      </div>
                                      <div
                                        data-testid="line-base-total-value"
                                        className={`flex h-8 min-w-0 items-center justify-end overflow-hidden rounded-lg border px-2.5 py-1 text-right ${
                                          depositDeductionLine
                                            ? "border-[#bfdbfe] bg-white text-[#1d4ed8]"
                                            : hasAppliedLineDiscount
                                              ? "border-[#fed7aa] bg-white text-[#9a3412]"
                                              : "border-[#e2e8f0] bg-[#f8fafc] text-[#0f172a]"
                                        }`}
                                        style={{ ...compactMoneyStyle, fontWeight: 700 }}
                                        title={money(baseLineTotal, form.currency)}
                                      >
                                        {hasAppliedLineDiscount ? (
                                          <span
                                            data-testid="line-base-total-struck"
                                            className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[#9a3412]"
                                          >
                                            {money(baseLineTotal, form.currency)}
                                          </span>
                                        ) : (
                                          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                                            {money(baseLineTotal, form.currency)}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  ) : null}
                                  {showDiscountedTotalColumn ? (
                                    <div className="min-w-0 w-full">
                                      <div
                                        className={`mb-1 ${hasAppliedLineDiscount ? "text-[#c2410c]" : "text-[#94a3b8]"} xl:hidden`}
                                        style={{
                                          fontSize: "0.625rem",
                                          fontWeight: 700,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.05em",
                                        }}
                                      >
                                        HT remisé
                                      </div>
                                      <div
                                        data-testid="line-total-value"
                                        className={`flex h-8 min-w-0 items-center justify-end overflow-hidden rounded-lg border px-2.5 py-1 text-right ${
                                          hasAppliedLineDiscount
                                            ? "border-[#fdba74] bg-white text-[#c2410c]"
                                            : "border-[#e2e8f0] bg-[#f8fafc] text-[#0f172a]"
                                        }`}
                                        style={{ ...compactMoneyStyle, fontWeight: 800 }}
                                        title={money(lineTotal, form.currency)}
                                      >
                                        <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                                          {money(lineTotal, form.currency)}
                                        </span>
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                              {lineComplianceVisible ? (
                                <div
                                  data-testid={`line-compliance-panel-${index + 1}`}
                                  className="mt-1 rounded-lg border border-[#fdba74] bg-[#fff7ed] px-1.5 py-1 text-[#9a3412]"
                                >
                                  <div className="grid gap-1 lg:grid-cols-[138px_210px_126px_28px] lg:items-center lg:justify-end">
                                    <label className="relative min-w-0">
                                      <span className="sr-only">Catégorie TVA</span>
                                      {showCategoryPlaceholder ? (
                                        <span
                                          aria-hidden="true"
                                          className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 text-[#94a3b8]"
                                          style={{ fontSize: "0.8125rem", fontWeight: 750 }}
                                        >
                                          Catégorie TVA
                                        </span>
                                      ) : null}
                                      <select
                                        aria-label={`Catégorie TVA ligne ${index + 1}`}
                                        title="Code fiscal de la ligne : standard, exonérée, hors champ, autoliquidation ou taux zéro."
                                        value={lineVatCategory(line)}
                                        onFocus={() => setFocusedComplianceField(categoryComplianceFieldId)}
                                        onBlur={() => setFocusedComplianceField(null)}
                                        onChange={(event) => updateLine(line.id, "vat_category", event.target.value)}
                                        className={`${lineOrangeInlineControlClassName} appearance-none pr-8 ${
                                          showCategoryPlaceholder ? "text-transparent" : ""
                                        }`}
                                        style={{ fontSize: "0.8125rem", fontWeight: 750 }}
                                      >
                                        {VAT_CATEGORY_OPTIONS.map((option) => (
                                          <option key={option.value} value={option.value}>
                                            {option.label}
                                          </option>
                                        ))}
                                      </select>
                                      <ChevronDown
                                        aria-hidden="true"
                                        className="pointer-events-none absolute right-2 top-1/2 z-20 h-3.5 w-3.5 -translate-y-1/2 text-[#64748b]"
                                      />
                                    </label>
                                    <label className="relative min-w-0">
                                      <span className="sr-only">Motif TVA 0 ou exonération</span>
                                      {showExemptionPlaceholder ? (
                                        <span
                                          aria-hidden="true"
                                          className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 text-[#94a3b8]"
                                          style={{ fontSize: "0.8125rem", fontWeight: 750 }}
                                        >
                                          Motif TVA 0
                                        </span>
                                      ) : null}
                                      <input
                                        aria-label={`Motif TVA 0 ou exonération ligne ${index + 1}`}
                                        title="Mention ou code VATEX qui justifie une TVA à 0 %. Requis pour l'e-facturation."
                                        value={line.exemption_reason_code || ""}
                                        onFocus={() => setFocusedComplianceField(exemptionComplianceFieldId)}
                                        onBlur={() => setFocusedComplianceField(null)}
                                        onChange={(event) =>
                                          updateLine(line.id, "exemption_reason_code", event.target.value)
                                        }
                                        placeholder=""
                                        className={`${lineOrangeInlineControlClassName} ${
                                          lineComplianceNeedsAttention ? "shadow-[0_0_0_1px_rgba(249,115,22,0.15)]" : ""
                                        }`}
                                        style={{ fontSize: "0.8125rem", fontWeight: 750 }}
                                      />
                                    </label>
                                    <label data-unit-code-menu-root="true" className="relative min-w-0">
                                      <span className="sr-only">Unité UN/ECE</span>
                                      {showUnitPlaceholder ? (
                                        <span
                                          aria-hidden="true"
                                          className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 text-[#94a3b8]"
                                          style={{ fontSize: "0.8125rem", fontWeight: 750 }}
                                        >
                                          Unité (UN/ECE)
                                        </span>
                                      ) : null}
                                      <input
                                        aria-label={`Unité ligne ${index + 1}`}
                                        title="Code unité normalisé utilisé dans les XML d'e-facturation. C62 = unité/pièce."
                                        value={showUnitPlaceholder ? "" : lineUnitCode(line)}
                                        onFocus={() => {
                                          setFocusedComplianceField(unitComplianceFieldId);
                                          setUnitCodeMenuOpenId(line.id);
                                        }}
                                        onBlur={() => setFocusedComplianceField(null)}
                                        onChange={(event) => updateLine(line.id, "unit_code", event.target.value)}
                                        placeholder=""
                                        className={`${lineOrangeInlineControlClassName} pr-8 uppercase`}
                                        style={{ fontSize: "0.8125rem", fontWeight: 750 }}
                                      />
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setFocusedComplianceField(unitComplianceFieldId);
                                          setUnitCodeMenuOpenId((current) => (current === line.id ? null : line.id));
                                        }}
                                        aria-label={`Afficher les unités ligne ${index + 1}`}
                                        aria-expanded={unitCodeMenuOpenId === line.id}
                                        className="absolute right-1 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-[#64748b] transition hover:bg-[#fff7ed] hover:text-[#c2410c]"
                                      >
                                        <ChevronDown className="h-3.5 w-3.5" />
                                      </button>
                                      {unitCodeMenuOpenId === line.id ? (
                                        <div className={unitCodeMenuClassName}>
                                          {UNIT_CODE_SUGGESTIONS.map((unitCode) => (
                                            <button
                                              key={`${line.id}-${unitCode}`}
                                              type="button"
                                              onMouseDown={(event) => event.preventDefault()}
                                              onClick={() => {
                                                updateLine(line.id, "unit_code", unitCode);
                                                setFocusedComplianceField(null);
                                                setUnitCodeMenuOpenId(null);
                                              }}
                                              className={unitCodeMenuItemClassName}
                                              style={{ fontSize: "0.75rem" }}
                                            >
                                              {unitCode}
                                            </button>
                                          ))}
                                        </div>
                                      ) : null}
                                    </label>
                                    <div className="flex items-center justify-center">
                                      <button
                                        type="button"
                                        onClick={() => removeLine(line.id)}
                                        aria-label={`Supprimer la ligne ${index + 1}`}
                                        title="Supprimer la ligne"
                                        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border p-0 leading-none shadow-sm transition ${destructiveIconButtonClassName}`}
                                      >
                                        <Trash2 className="block h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                      <datalist id="invoice-unit-code-suggestions">
                        {UNIT_CODE_SUGGESTIONS.map((unitCode) => (
                          <option key={unitCode} value={unitCode} />
                        ))}
                      </datalist>
                    </div>
                  </div>
                </div>

                {isInvoice && depositPanelOpen ? (
                  <div data-testid="invoice-deposit-bank-panel" className="-mt-px">
                    <div
                      data-testid="deposit-table"
                      className="w-full overflow-visible rounded-b-2xl border border-t-0 border-[#dbe3ef] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
                    >
                      <div
                        data-testid="deposit-table-header"
                        className="hidden grid-cols-[28px_minmax(180px,1.7fr)_minmax(92px,0.62fr)_minmax(92px,0.62fr)_minmax(92px,0.62fr)] items-center gap-1 border-b border-[#bfdbfe] bg-[#eff6ff] px-2 py-1.5 text-[#0f172a] lg:grid"
                        style={{
                          fontSize: "0.78125rem",
                          fontWeight: 650,
                          textTransform: "none",
                          letterSpacing: 0,
                        }}
                      >
                        <div aria-hidden="true" />
                        <div className="text-center">Facture d'acompte</div>
                        <div className="text-center">HT</div>
                        <div className="text-center">TVA</div>
                        <div className="text-center">TTC</div>
                      </div>
                      <div
                        data-testid="deposit-table-row"
                        className="grid grid-cols-1 gap-2 border-b border-[#e2e8f0] bg-white px-2 py-2 sm:grid-cols-2 lg:grid-cols-[28px_minmax(180px,1.7fr)_minmax(92px,0.62fr)_minmax(92px,0.62fr)_minmax(92px,0.62fr)] lg:items-center lg:gap-1"
                      >
                        <div ref={depositActionMenuRef} className="relative flex items-center justify-center">
                          <button
                            type="button"
                            onClick={() => setDepositActionMenuOpen((open) => !open)}
                            aria-label="Options facture d'acompte"
                            aria-expanded={depositActionMenuOpen}
                            className={lineSideActionButtonClassName}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          {depositActionMenuOpen ? (
                            <div className={lineSideActionMenuClassName}>
                              <button
                                type="button"
                                onClick={() => {
                                  addPresentationLine("comment");
                                  setDepositActionMenuOpen(false);
                                }}
                                className={lineSideActionMenuItemClassName}
                                style={{ fontSize: "0.75rem", fontWeight: 800 }}
                              >
                                <FileText className="h-3.5 w-3.5" style={{ color: accentColor }} /> Commentaire
                              </button>
                              <div className="my-1 border-t border-[#e2e8f0]" />
                              <button
                                type="button"
                                onClick={() => {
                                  setDepositPanelOpen(false);
                                  setDepositActionMenuOpen(false);
                                }}
                                className={`${lineSideActionMenuItemClassName} text-[#dc2626] hover:bg-[#fef2f2]`}
                                style={{ fontSize: "0.75rem", fontWeight: 800 }}
                              >
                                <Trash2 className="h-3.5 w-3.5" /> Supprimer
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <div ref={depositInvoicePickerRef} className="relative min-w-0 sm:col-span-2 lg:col-span-1">
                          <div className={lineTextControlFrameClassName}>
                            <input
                              aria-label="Numéro facture d'acompte"
                              value={depositDraft.reference}
                              onFocus={() => setDepositInvoiceMenuOpen(true)}
                              onChange={(event) => {
                                setDepositInvoiceMenuOpen(true);
                                void changeDepositReference(event.target.value);
                              }}
                              placeholder="Numéro facture d'acompte"
                              className="h-full min-w-0 flex-1 truncate bg-white px-2.5 text-[#0f172a] outline-none placeholder:text-[#94a3b8]"
                              style={{ fontSize: "0.8125rem" }}
                            />
                          </div>
                          {depositInvoiceMenuOpen ? (
                            <div
                              data-testid="deposit-invoice-menu"
                              className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-50 overflow-hidden rounded-xl border border-[#bfdbfe] bg-white text-left shadow-[0_18px_40px_rgba(15,23,42,0.16)]"
                            >
                              <div className="max-h-[250px] overflow-y-auto py-1">
                                {filteredDepositInvoiceOptions.length ? (
                                  filteredDepositInvoiceOptions.map((invoice: any) => (
                                    <button
                                      key={invoice?.id || invoice?.number}
                                      type="button"
                                      onClick={() => void selectDepositInvoice(invoice)}
                                      className="flex min-h-12 w-full items-start gap-3 px-3 py-2 text-left transition hover:bg-[#eff6ff]"
                                    >
                                      <span className="min-w-0">
                                        <span
                                          className="block truncate text-[#0f172a]"
                                          style={{ fontSize: "0.75rem", fontWeight: 900 }}
                                        >
                                          {invoice?.number || invoice?.id || "Facture"}
                                        </span>
                                        <span
                                          className="block truncate text-[#64748b]"
                                          style={{ fontSize: "0.6875rem", fontWeight: 750 }}
                                        >
                                          {invoice?.customer_name || "Client"} ·{" "}
                                          {money(
                                            Number(invoice?.total_inc_vat || 0),
                                            invoice?.currency || form.currency,
                                          )}
                                        </span>
                                      </span>
                                    </button>
                                  ))
                                ) : (
                                  <div
                                    className="px-3 py-4 text-center text-[#94a3b8]"
                                    style={{ fontSize: "0.75rem", fontWeight: 750 }}
                                  >
                                    Aucune facture d'acompte émise compatible
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                        <input
                          aria-label="Montant HT acompte"
                          inputMode="decimal"
                          value={depositDraft.amount_ht}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => setDepositDraft((prev) => ({ ...prev, amount_ht: event.target.value }))}
                          placeholder="0,00"
                          data-testid="deposit-amount-ht-input"
                          className={`${lineControlClassName} ${numberInputNoSpinnerClassName} text-right tabular-nums`}
                          style={{ fontSize: "0.875rem", fontVariantNumeric: "tabular-nums" }}
                        />
                        <label
                          className={`${lineCompoundControlClassName} pf-document-focus-field relative gap-1 px-2.5 pr-7 tabular-nums ${
                            companyVatFranchise ? "opacity-70" : ""
                          }`}
                          title={
                            companyVatFranchise
                              ? "Franchise en base : TVA d'acompte désactivée."
                              : "Taux de TVA. Saisissez le taux exact à appliquer."
                          }
                        >
                          <select
                            aria-label="TVA"
                            value={advanceVatSelectValue(depositDraft.vat_rate) || "custom"}
                            onChange={(event) => {
                              if (companyVatFranchise) return;
                              const value = event.target.value;
                              setDepositDraft((prev) => ({ ...prev, vat_rate: value === "custom" ? "" : value }));
                            }}
                            disabled={companyVatFranchise}
                            data-testid="deposit-vat-rate-select"
                            className="min-w-0 flex-1 appearance-none bg-transparent text-right text-[#0f172a] outline-none"
                            style={{ fontSize: "0.8125rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
                          >
                            {ADVANCE_VAT_RATE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                TVA {option.label}
                              </option>
                            ))}
                            <option value="custom">TVA personnalisée</option>
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748b]" />
                          {advanceVatSelectValue(depositDraft.vat_rate) === "custom" ||
                          !String(depositDraft.vat_rate || "").trim() ? (
                            <span className="ml-1 flex w-[56px] items-center gap-1 rounded-md border border-[#dbeafe] bg-white px-1.5">
                              <input
                                aria-label="TVA personnalisée"
                                inputMode="decimal"
                                value={String(depositDraft.vat_rate || "")}
                                onFocus={(event) => event.currentTarget.select()}
                                onChange={(event) =>
                                  setDepositDraft((prev) => ({ ...prev, vat_rate: event.target.value }))
                                }
                                disabled={companyVatFranchise}
                                placeholder="Taux"
                                className={`${numberInputNoSpinnerClassName} min-w-0 flex-1 bg-transparent text-right text-[#0f172a] outline-none`}
                                style={{ fontSize: "0.75rem", fontWeight: 850 }}
                              />
                              <span className="text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 900 }}>
                                %
                              </span>
                            </span>
                          ) : null}
                        </label>
                        <div
                          aria-label="TTC acompte"
                          data-testid="deposit-ttc-value"
                          className="flex h-8 min-w-0 items-center justify-end overflow-hidden rounded-lg border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-1 text-right text-[#0f172a]"
                          style={{ ...compactMoneyStyle, fontWeight: 800 }}
                        >
                          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                            {depositAmountTTC ? money(depositAmountTTC, form.currency) : "0,00"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {false ? (
                  <div
                    data-testid="document-discount-panel"
                    className="mt-4 grid gap-3 rounded-2xl border border-[#fed7aa] bg-[#fff7ed] px-4 py-3 text-[#9a3412] lg:grid-cols-[1fr_220px_170px_auto] lg:items-center"
                  >
                    <div>
                      <div style={{ fontSize: "0.8125rem", fontWeight: 850 }}>
                        Remise globale {isInvoice ? "facture" : "devis"}
                      </div>
                      <p
                        data-testid="document-discount-base"
                        className="mt-0.5 text-[#c2410c]"
                        style={{ fontSize: "0.75rem", fontWeight: 600 }}
                      >
                        S'applique après les remises de ligne, sur {money(documentDiscountBaseHT, form.currency)} HT.
                      </p>
                    </div>
                    <label
                      className="flex items-center justify-between gap-2 rounded-xl border border-[#fdba74] bg-white px-3 py-2 text-[#9a3412]"
                      style={{ fontSize: "0.75rem", fontWeight: 800 }}
                    >
                      <span>Taux global</span>
                      <span className="flex items-center gap-1">
                        <input
                          aria-label="Taux global récapitulatif"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={form.document_discount_percent ?? ""}
                          onChange={(event) => setFormField("document_discount_percent", event.target.value)}
                          className={`h-8 w-20 rounded-lg border border-[#fed7aa] bg-white px-2 text-right text-[#0f172a] ${numberInputNoSpinnerClassName}`}
                          style={{ fontSize: "0.8125rem", fontWeight: 800 }}
                        />
                        %
                      </span>
                    </label>
                    <div
                      data-testid="document-discount-total"
                      className="flex items-center justify-between rounded-xl border border-[#fdba74] bg-white px-3 py-2"
                      style={{ fontSize: "0.8125rem", fontWeight: 850 }}
                    >
                      <span>Remise HT</span>
                      <span>
                        {documentDiscountPercent > 0
                          ? money(documentDiscountTotalHT, form.currency)
                          : money(0, form.currency)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={clearDocumentDiscount}
                      aria-label="Retirer cette remise"
                      title="Retirer cette remise"
                      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-sm transition ${destructiveIconButtonClassName}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}

                <div className="-mt-px flex flex-col items-end">
                  {false ? (
                    <div data-testid="invoice-payment-card" className="w-full">
                      <section className="rounded-[20px] border border-[#dbe3ef] bg-white p-4 shadow-[0_8px_26px_rgba(15,23,42,0.04)]">
                        <div className="relative mb-3">
                          <button
                            type="button"
                            data-testid="invoice-payment-methods-summary"
                            onClick={() => setPaymentMethodsMenuOpen((open) => !open)}
                            className="flex min-h-10 w-full items-center justify-between gap-3 rounded-xl border border-[#dbe3ef] bg-[#f8fafc] px-3 py-2 text-left transition hover:bg-white"
                          >
                            <span className="min-w-0">
                              <span className="block text-[#64748b]" style={{ fontSize: "0.625rem", fontWeight: 900 }}>
                                Moyens de paiement
                              </span>
                              <span
                                className="block truncate text-[#0f172a]"
                                style={{ fontSize: "0.8125rem", fontWeight: 850 }}
                              >
                                {paymentMethodLabel}
                              </span>
                            </span>
                            <ChevronDown
                              className={`h-3.5 w-3.5 shrink-0 text-[#64748b] transition ${paymentMethodsMenuOpen ? "rotate-180" : ""}`}
                            />
                          </button>
                          {paymentMethodsMenuOpen ? (
                            <div
                              data-testid="invoice-payment-methods-menu"
                              className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-50 overflow-hidden rounded-xl border border-[#bfdbfe] bg-white shadow-[0_18px_40px_rgba(15,23,42,0.16)]"
                            >
                              <div className="grid gap-1 p-2">
                                {PAYMENT_METHOD_MENU_OPTIONS.map((method) => {
                                  const active = selectedPaymentMethodIds.includes(method.id);
                                  return (
                                    <button
                                      key={method.id}
                                      type="button"
                                      onClick={() => changePrimaryPaymentMethod(method.id)}
                                      className="flex h-8 items-center justify-between rounded-lg px-2.5 text-left transition hover:bg-[#eff6ff]"
                                      style={{
                                        color: active ? "#1d4ed8" : "#334155",
                                        background: active ? "#eff6ff" : undefined,
                                        fontSize: "0.75rem",
                                        fontWeight: 850,
                                      }}
                                    >
                                      {method.label}
                                      {active ? <span className="text-[#1d4ed8]">OK</span> : null}
                                    </button>
                                  );
                                })}
                              </div>
                              <button
                                type="button"
                                onClick={() => setPaymentMethodsMenuOpen(false)}
                                className="flex h-9 w-full items-center justify-center border-t border-[#e2e8f0] bg-[#f8fafc] text-[#1d4ed8] transition hover:bg-[#eff6ff]"
                                style={{ fontSize: "0.75rem", fontWeight: 900 }}
                              >
                                Enregistrer
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <div
                            className="flex items-center gap-2 uppercase tracking-[0.18em] text-[#94a3b8]"
                            style={{ fontSize: "0.625rem", fontWeight: 900 }}
                          >
                            <Building2 className="h-3.5 w-3.5 text-[#1d4ed8]" /> Coordonnées bancaires
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={startNewBankAccount}
                              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#bfdbfe] bg-white px-3 text-[#1d4ed8] transition hover:bg-[#eff6ff]"
                              style={{ fontSize: "0.75rem", fontWeight: 850 }}
                            >
                              <Plus className="h-3.5 w-3.5" />
                              Ajouter IBAN / BIC
                            </button>
                            {paymentBankDisplay?.iban || paymentBankDisplay?.bic ? (
                              <button
                                type="button"
                                onClick={startEditBankAccount}
                                aria-label="Modifier IBAN / BIC"
                                title="Modifier IBAN / BIC"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#bfdbfe] bg-white text-[#1d4ed8] transition hover:bg-[#eff6ff]"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <div className="mt-3 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-3">
                          <select
                            data-testid="invoice-bank-account-select"
                            aria-label="Sélectionner des coordonnées bancaires"
                            value={selectedBankAccountId}
                            onChange={(event) => setSelectedBankAccountId(event.target.value)}
                            className="mb-2 h-9 w-full rounded-lg border border-[#d6deea] bg-white px-2.5 text-[#0f172a] outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                            style={{ fontSize: "0.75rem", fontWeight: 800 }}
                          >
                            {paymentBankDisplay?.iban || paymentBankDisplay?.bic ? (
                              <option value="">{paymentBankDisplay?.label || "Coordonnées société"}</option>
                            ) : (
                              <option value="">Aucun IBAN/BIC</option>
                            )}
                            {bankAccounts.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.label || "Coordonnées bancaires"}
                                {account.is_default ? " · défaut" : ""}
                              </option>
                            ))}
                          </select>
                          <div className="flex items-center justify-between gap-3">
                            <div className="truncate text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 900 }}>
                              {paymentBankDisplay?.label || "Aucun IBAN/BIC émetteur"}
                            </div>
                            {selectedBankAccount?.is_default ? (
                              <span
                                className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-[#15803d]"
                                style={{ fontSize: "0.625rem", fontWeight: 900 }}
                              >
                                Défaut
                              </span>
                            ) : null}
                          </div>
                          {paymentBankDisplay?.iban || paymentBankDisplay?.bic ? (
                            <div className="mt-2 grid gap-1.5">
                              {paymentBankDisplay?.iban ? (
                                <div
                                  className="truncate font-mono text-[#334155]"
                                  style={{ fontSize: "0.75rem", fontWeight: 800 }}
                                >
                                  IBAN {formatIbanInput(paymentBankDisplay.iban)}
                                </div>
                              ) : null}
                              {paymentBankDisplay?.bic ? (
                                <div
                                  className="truncate font-mono text-[#64748b]"
                                  style={{ fontSize: "0.6875rem", fontWeight: 750 }}
                                >
                                  BIC {cleanBic(paymentBankDisplay.bic)}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="mt-2 text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 750 }}>
                              Aucun IBAN/BIC renseigné.
                            </div>
                          )}
                        </div>
                        {bankEditorOpen ? (
                          <div
                            ref={bankEditorRef}
                            className="mt-3 grid gap-2 rounded-xl border border-[#dbeafe] bg-white p-3 sm:grid-cols-2"
                          >
                            {bankAccounts.length > 1 ? (
                              <label
                                className="block text-[#64748b] sm:col-span-2"
                                style={{ fontSize: "0.75rem", fontWeight: 800 }}
                              >
                                Coordonnées à modifier
                                <select
                                  data-testid="invoice-bank-account-editor-select"
                                  aria-label="Sélectionner des coordonnées bancaires"
                                  value={selectedBankAccountId}
                                  onChange={(event) => setSelectedBankAccountId(event.target.value)}
                                  className="mt-1 h-10 w-full rounded-xl border border-[#d6deea] bg-white px-3 text-[#0f172a] outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                  style={{ fontSize: "0.8125rem", fontWeight: 750 }}
                                >
                                  {bankAccounts.map((account) => (
                                    <option key={account.id} value={account.id}>
                                      {account.label || "Coordonnées bancaires"}
                                      {account.is_default ? " · défaut" : ""}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ) : null}
                            <label
                              className="block text-[#64748b] sm:col-span-2"
                              style={{ fontSize: "0.75rem", fontWeight: 800 }}
                            >
                              Nom affiché
                              <input
                                value={bankDraft.label}
                                onChange={(event) => {
                                  setBankDetailsError(null);
                                  setBankDraft((prev) => ({ ...prev, label: event.target.value }));
                                }}
                                placeholder="Coordonnées principales"
                                className="mt-1 h-10 w-full rounded-xl border border-[#d6deea] bg-white px-3 text-[#0f172a] outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                style={{ fontSize: "0.8125rem", fontWeight: 750 }}
                              />
                            </label>
                            <label className="block text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 800 }}>
                              IBAN
                              <input
                                value={bankDraft.iban}
                                onChange={(event) => {
                                  setBankDetailsError(null);
                                  setBankDraft((prev) => ({ ...prev, iban: formatIbanInput(event.target.value) }));
                                }}
                                aria-invalid={bankDraftIbanInvalid}
                                placeholder="FR76..."
                                className={`mt-1 h-10 w-full rounded-xl border bg-white px-3 font-mono text-[#0f172a] outline-none focus:ring-2 ${
                                  bankDraftIbanInvalid
                                    ? "border-[#fca5a5] focus:border-[#dc2626] focus:ring-[#fecaca]"
                                    : "border-[#d6deea] focus:border-[#2563eb] focus:ring-[#bfdbfe]"
                                }`}
                                style={{ fontSize: "0.8125rem" }}
                              />
                            </label>
                            <label className="block text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 800 }}>
                              BIC
                              <input
                                value={bankDraft.bic}
                                onChange={(event) => {
                                  setBankDetailsError(null);
                                  setBankDraft((prev) => ({ ...prev, bic: cleanBic(event.target.value) }));
                                }}
                                aria-invalid={bankDraftBicInvalid}
                                placeholder="AGRIFRPPXXX"
                                className={`mt-1 h-10 w-full rounded-xl border bg-white px-3 font-mono text-[#0f172a] outline-none focus:ring-2 ${
                                  bankDraftBicInvalid
                                    ? "border-[#fca5a5] focus:border-[#dc2626] focus:ring-[#fecaca]"
                                    : "border-[#d6deea] focus:border-[#2563eb] focus:ring-[#bfdbfe]"
                                }`}
                                style={{ fontSize: "0.8125rem" }}
                              />
                            </label>
                            <label
                              className="inline-flex items-center gap-2 text-[#64748b] sm:col-span-2"
                              style={{ fontSize: "0.75rem", fontWeight: 800 }}
                            >
                              <input
                                type="checkbox"
                                checked={bankDraft.is_default}
                                onChange={(event) =>
                                  setBankDraft((prev) => ({ ...prev, is_default: event.target.checked }))
                                }
                                className="h-4 w-4 rounded border-[#cbd5e1] accent-[#2563eb]"
                              />
                              Coordonnées par défaut entreprise
                            </label>
                            {bankDetailsError ? (
                              <div
                                className="rounded-xl border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[#b91c1c] sm:col-span-2"
                                style={{ fontSize: "0.75rem", fontWeight: 750 }}
                              >
                                {bankDetailsError}
                              </div>
                            ) : null}
                            <div className="grid gap-2 sm:col-span-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                              <button
                                type="button"
                                onClick={saveBankDetails}
                                disabled={savingBankDetails}
                                className="inline-flex h-10 items-center justify-center rounded-xl bg-[#1d4ed8] px-4 text-white shadow-sm hover:bg-[#1e40af] disabled:cursor-not-allowed disabled:opacity-50"
                                style={{ fontSize: "0.8125rem", fontWeight: 900 }}
                              >
                                {savingBankDetails ? "Enregistrement..." : "Enregistrer IBAN / BIC"}
                              </button>
                              {selectedBankAccount?.id ? (
                                <button
                                  type="button"
                                  onClick={clearBankDetails}
                                  disabled={savingBankDetails}
                                  aria-label="Supprimer les coordonnées sélectionnées"
                                  title="Supprimer les coordonnées sélectionnées"
                                  className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border px-3 shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${destructiveIconButtonClassName}`}
                                  style={{ fontSize: "0.75rem", fontWeight: 850 }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Supprimer
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => setBankEditorOpen(false)}
                                className="inline-flex h-10 items-center justify-center rounded-xl border border-[#d6deea] bg-white px-3 text-[#334155] transition hover:bg-[#f8fafc]"
                                style={{ fontSize: "0.75rem", fontWeight: 850 }}
                              >
                                Annuler
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </section>
                    </div>
                  ) : null}
                  <div
                    data-testid="document-totals-summary"
                    className="w-full max-w-[310px] justify-self-end overflow-hidden rounded-b-[18px] rounded-t-none border border-t-0 border-[#dbe3ef] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)]"
                  >
                    {showDiscountSummaryRows ? (
                      <div
                        data-testid="discount-subtotal-ht"
                        className="flex items-center justify-between gap-3 border-b border-[#fed7aa] bg-[#fffaf2] px-4 py-2 text-[#9a3412]"
                        style={{ fontSize: "0.75rem", fontWeight: 800 }}
                      >
                        <span className="shrink-0">Sous-total HT</span>
                        <span
                          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right"
                          style={{ ...compactMoneyStyle, fontWeight: 800 }}
                          title={money(discountBaseHT, form.currency)}
                        >
                          {money(discountBaseHT, form.currency)}
                        </span>
                      </div>
                    ) : null}
                    {showDiscountSummaryRows ? (
                      <div
                        data-testid="discount-total-ht"
                        className="flex items-center justify-between gap-3 border-b border-[#fed7aa] bg-[#fff7ed] px-4 py-2 text-[#c2410c]"
                        style={{ fontSize: "0.8125rem", fontWeight: 850 }}
                      >
                        <span className="shrink-0">{documentCopy.discountHT}</span>
                        {showDocumentDiscountPanel ? (
                          <div
                            data-testid="document-discount-total-summary"
                            className="flex h-8 w-[88px] overflow-hidden rounded-lg border border-[#fdba74] bg-white text-[#c2410c] shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe]"
                          >
                            <span className="sr-only">{money(discountTotalHT, form.currency)}</span>
                            <input
                              aria-label="Remise globale"
                              inputMode="decimal"
                              value={
                                documentDiscountInputMode === "amount"
                                  ? documentDiscountAmountInput
                                  : (form.document_discount_percent ?? "")
                              }
                              onChange={(event) => {
                                setDocumentDiscountOpen(true);
                                if (documentDiscountInputMode === "amount") {
                                  setDocumentDiscountAmountInput(event.target.value);
                                  return;
                                }
                                setFormField("document_discount_percent", event.target.value);
                              }}
                              placeholder="0"
                              className="h-full min-w-0 flex-1 border-0 bg-transparent px-1 text-right text-[#0f172a] shadow-none outline-none ring-0 placeholder:text-[#fdba74] focus:border-transparent focus:outline-none focus:ring-0 focus-visible:outline-none"
                              style={{ fontSize: "clamp(0.625rem, 0.72vw, 0.8125rem)", fontWeight: 850 }}
                            />
                            <div className="flex h-full shrink-0 border-l border-[#fed7aa] bg-[#fffaf2]">
                              {(["percent", "amount"] as const).map((discountMode) => {
                                const active = documentDiscountInputMode === discountMode;
                                return (
                                  <button
                                    key={`document-discount-${discountMode}`}
                                    type="button"
                                    onClick={() => changeDocumentDiscountInputMode(discountMode)}
                                    className={`flex h-full w-5 items-center justify-center transition ${
                                      active
                                        ? "bg-[#c2410c]/85 text-white"
                                        : "bg-[#fff7ed] text-[#9a3412] hover:bg-[#ffedd5]"
                                    }`}
                                    style={{ fontSize: "0.6875rem", fontWeight: 900 }}
                                  >
                                    {discountMode === "amount" ? "€" : "%"}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <span
                            data-testid="document-discount-total-summary"
                            className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right"
                            style={{ ...compactMoneyStyle, fontWeight: 850 }}
                            title={money(discountTotalHT, form.currency)}
                          >
                            {money(discountTotalHT, form.currency)}
                          </span>
                        )}
                      </div>
                    ) : null}
                    {showDiscountTtcRows ? (
                      <div
                        data-testid="discount-subtotal-ttc"
                        className="flex items-center justify-between gap-3 border-b border-[#fed7aa] bg-[#fffaf2] px-4 py-2 text-[#9a3412]"
                        style={{ fontSize: "0.75rem", fontWeight: 800 }}
                      >
                        <span className="shrink-0">{documentCopy.subtotalTTC}</span>
                        <span
                          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right"
                          style={{ ...compactMoneyStyle, fontWeight: 800 }}
                          title={money(discountBaseTTC, form.currency)}
                        >
                          {money(discountBaseTTC, form.currency)}
                        </span>
                      </div>
                    ) : null}
                    {showDiscountTtcRows ? (
                      <div
                        data-testid="discount-total-ttc"
                        className="flex items-center justify-between gap-3 border-b border-[#fed7aa] bg-[#fff7ed] px-4 py-2 text-[#c2410c]"
                        style={{ fontSize: "0.75rem", fontWeight: 850 }}
                      >
                        <span className="shrink-0">{documentCopy.discountsTTC}</span>
                        <span
                          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right"
                          style={{ ...compactMoneyStyle, fontWeight: 850 }}
                          title={money(discountTotalTTC, form.currency)}
                        >
                          {money(discountTotalTTC, form.currency)}
                        </span>
                      </div>
                    ) : null}
                    <div
                      className="flex items-center justify-between gap-3 border-b border-[#e2e8f0] bg-[#f8fafc] px-4 py-2.5 text-[#64748b]"
                      style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                    >
                      <span className="shrink-0">{documentCopy.totalHT}</span>
                      <span
                        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right text-[#0f172a]"
                        style={{ ...compactMoneyStyle, fontWeight: 700 }}
                        title={money(totals.totalHT, form.currency)}
                      >
                        {money(totals.totalHT, form.currency)}
                      </span>
                    </div>
                    {showVatTotalsInSummary
                      ? vatBreakdown.map(([rate, values]) => (
                          <div
                            key={String(rate)}
                            className="flex items-center justify-between gap-3 border-b px-4 py-2.5"
                            style={{
                              borderColor: Number(rate) === 0 ? accentBorder : "#e2e8f0",
                              background: Number(rate) === 0 ? accentLight : "#f8fafc",
                              color: Number(rate) === 0 ? accentColor : "#64748b",
                              fontSize: "0.8125rem",
                              fontWeight: 700,
                            }}
                          >
                            <span className="shrink-0">
                              {documentCopy.vat} {rate}%
                            </span>
                            <span
                              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right"
                              style={{
                                ...compactMoneyStyle,
                                color: Number(rate) === 0 ? accentColor : "#0f172a",
                                fontWeight: 700,
                              }}
                              title={signedMoney(values.vat, form.currency)}
                            >
                              {signedMoney(values.vat, form.currency)}
                            </span>
                          </div>
                        ))
                      : null}
                    <div
                      className="flex items-center justify-between gap-3 border-b px-4 py-2.5"
                      style={{
                        borderColor: accentBorder,
                        background: `linear-gradient(135deg, ${accentLight}, ${accentSubtle})`,
                        color: accentColor,
                      }}
                    >
                      <span className="shrink-0" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                        {documentCopy.totalTTC}
                      </span>
                      <span
                        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right"
                        style={{ ...compactMoneyStyle, color: documentTheme.totalText, fontWeight: 700 }}
                        title={money(totals.totalTTC, form.currency)}
                      >
                        {money(totals.totalTTC, form.currency)}
                      </span>
                    </div>
                    {advancePaymentTotalTTC > 0 ? (
                      <>
                        <div
                          className="flex items-center justify-between gap-3 border-b border-[#dbe3ef] bg-white px-4 py-2.5 text-[#64748b]"
                          style={{ fontSize: "0.75rem", fontWeight: 750 }}
                        >
                          <span className="shrink-0">{advancePaymentLabel}</span>
                          <span
                            className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right"
                            style={{ ...compactMoneyStyle, color: accentColor, fontWeight: 750 }}
                            title={`- ${money(advancePaymentTotalTTC, form.currency)}`}
                          >
                            - {money(advancePaymentTotalTTC, form.currency)}
                          </span>
                        </div>
                        <div
                          className="flex items-center justify-between gap-3 bg-[#f0fdf4] px-4 py-2.5 text-[#15803d]"
                          style={{ fontSize: "0.8125rem", fontWeight: 850 }}
                        >
                          <span className="shrink-0">{remainingAfterAdvanceLabel}</span>
                          <span
                            className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right"
                            style={{ ...compactMoneyStyle, fontWeight: 850 }}
                            title={money(amountDueAfterAdvance, form.currency)}
                          >
                            {money(amountDueAfterAdvance, form.currency)}
                          </span>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>

                {false ? (
                  <div className="mt-5 grid gap-4">
                    <div className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] p-4">
                      <div
                        className="mb-2 uppercase tracking-[0.18em] text-[#94a3b8]"
                        style={{ fontSize: "0.625rem", fontWeight: 700 }}
                      >
                        Note visible client
                      </div>
                      <textarea
                        rows={5}
                        value={form.note || ""}
                        onChange={(event) => setFormField("note", event.target.value)}
                        placeholder="Précision visible sur le devis, par exemple une référence projet ou une condition particulière."
                        className="w-full rounded-xl border border-[#d6deea] bg-white px-3 py-2 text-[#0f172a]"
                        style={{ fontSize: "0.875rem", resize: "none" }}
                      />
                    </div>
                  </div>
                ) : null}

                {false ? (
                  <div data-testid="document-routing-options" className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-3">
                      <span className="mb-1 block text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                        N° de commande
                      </span>
                      <input
                        value={form.purchase_order_number || ""}
                        onChange={(event) => setFormField("purchase_order_number", event.target.value)}
                        placeholder="Optionnel"
                        className="w-full rounded-xl border border-[#d6deea] bg-white px-3 py-2 text-[#0f172a]"
                        style={{ fontSize: "0.8125rem" }}
                      />
                    </label>
                    {isInvoice ? (
                      <>
                        {einvoicingEnabled ? (
                          <label className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-3">
                            <span
                              className="mb-1 block text-[#64748b]"
                              style={{ fontSize: "0.75rem", fontWeight: 700 }}
                            >
                              Profil Factur-X
                            </span>
                            <select
                              value={form.facturx_profile}
                              onChange={(event) => setFormField("facturx_profile", event.target.value)}
                              className="w-full rounded-xl border border-[#d6deea] bg-white px-3 py-2 text-[#0f172a]"
                              style={{ fontSize: "0.8125rem" }}
                            >
                              {FACTURX_PROFILES.map((profile) => (
                                <option key={profile.value} value={profile.value}>
                                  {profile.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        <label className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-3">
                          <span className="mb-1 block text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                            Nature de l’opération
                          </span>
                          <select
                            value={form.operation_nature}
                            onChange={(event) => setFormField("operation_nature", event.target.value)}
                            aria-label="Nature de l'opération"
                            className="w-full rounded-xl border border-[#d6deea] bg-white px-3 py-2 text-[#0f172a]"
                            style={{ fontSize: "0.8125rem" }}
                          >
                            <option value="services">Services</option>
                            <option value="goods">Biens</option>
                            <option value="mixed">Mixte</option>
                          </select>
                        </label>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {true ? (
                  <div data-testid="invoice-legal-footer" className="mt-5 space-y-4">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <section
                        data-testid="invoice-delivery-payment-card"
                        className="rounded-xl border border-[#d6deea] bg-[#f8fbff] p-2.5"
                      >
                        <div
                          className="flex items-center justify-between gap-3 text-[#2563eb]"
                          style={{ color: accentColor, fontSize: "0.78125rem", fontWeight: 650 }}
                        >
                          <span className="inline-flex items-center gap-2">
                            <CreditCard className="h-3.5 w-3.5" />
                            {renderTooltipText(
                              documentCopy.payment,
                              "Paramètres de livraison, nature d'opération, moyen de paiement et IBAN/BIC imprimés sur le document.",
                            )}
                          </span>
                        </div>
                        <div
                          className="mt-3 divide-y divide-[#e2e8f0] text-[#475569]"
                          style={{ fontSize: "0.78125rem", lineHeight: 1.45 }}
                        >
                          <div className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-start">
                            {renderTooltipText(
                              documentCopy.delivery,
                              "Adresse de livraison imprimée sur le document. Laisse vide si elle est identique à l'adresse de facturation.",
                              "font-semibold text-[#64748b]",
                              { fontSize: "0.78125rem", fontWeight: 600 },
                            )}
                            <div className="min-w-0">
                              <GuidanceTooltip content="Ajouter ou modifier une adresse de livraison différente de l'adresse de facturation.">
                                <button
                                  type="button"
                                  data-testid="delivery-address-toggle"
                                  onClick={() =>
                                    setFormField("delivery_address_differs", !Boolean(form.delivery_address_differs))
                                  }
                                  className="text-left font-semibold transition hover:underline"
                                  style={{ color: accentColor, fontSize: "0.78125rem", fontWeight: 500 }}
                                >
                                  {form.delivery_address_differs
                                    ? documentCopy.deliveryDifferent
                                    : documentCopy.addDeliveryDifferent}
                                </button>
                              </GuidanceTooltip>
                              {form.delivery_address_differs ? (
                                <textarea
                                  data-testid="delivery-address-inline"
                                  value={form.delivery_address || ""}
                                  onChange={(event) => setFormField("delivery_address", event.target.value)}
                                  placeholder={documentCopy.deliveryPlaceholder}
                                  rows={2}
                                  className="mt-1.5 min-h-14 w-full resize-y rounded-lg border border-[#bfdbfe] bg-white px-2.5 py-2 text-[#1d4ed8] outline-none placeholder:text-[#60a5fa] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                  style={{ fontSize: "0.78125rem", lineHeight: 1.45 }}
                                />
                              ) : null}
                            </div>
                          </div>
                          <label className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
                            {renderTooltipText(
                              documentCopy.operationNature,
                              "Type d'opération utilisé pour la conformité et la lecture comptable du document.",
                              "font-semibold text-[#64748b]",
                              { fontSize: "0.78125rem", fontWeight: 600 },
                            )}
                            <select
                              value={form.operation_nature}
                              onChange={(event) => setFormField("operation_nature", event.target.value)}
                              aria-label="Nature de l'opération"
                              className="h-8 w-full rounded-lg border border-[#cbd5e1] bg-white px-2.5 text-[#0f172a] outline-none transition hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                              style={{ fontSize: "0.78125rem", fontWeight: 650 }}
                            >
                              <option value="services">Services</option>
                              <option value="goods">Biens</option>
                              <option value="mixed">Mixte</option>
                            </select>
                          </label>
                          <div className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
                            {renderTooltipText(
                              documentCopy.paymentMethod,
                              "Moyen de paiement attendu et repris dans la mention de règlement.",
                              "font-semibold text-[#64748b]",
                              { fontSize: "0.78125rem", fontWeight: 600 },
                            )}
                            <div className="grid min-w-0 gap-2">
                              <select
                                aria-label={`Moyen de paiement : ${paymentMethodLabel}`}
                                value={primaryPaymentMethodId}
                                onChange={(event) => changePrimaryPaymentMethod(event.target.value)}
                                className="h-8 w-full rounded-lg border border-[#cbd5e1] bg-white px-2.5 text-[#0f172a] outline-none transition hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                style={{ fontSize: "0.78125rem", fontWeight: 650 }}
                              >
                                {PAYMENT_METHOD_MENU_OPTIONS.map((method) => (
                                  <option key={method.id} value={method.id}>
                                    {PAYMENT_METHOD_TRANSLATIONS[documentLanguage][method.id]?.label ||
                                      PAYMENT_METHOD_COMPACT_LABELS[method.id] ||
                                      method.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          {paymentBankDisplay?.iban || paymentBankDisplay?.bic ? (
                            <div data-testid="invoice-payment-rib-details" className="grid gap-0 py-1">
                              {paymentBankDisplay?.iban ? (
                                <div className="grid min-h-0 gap-2 py-0 sm:grid-cols-[92px_minmax(0,1fr)_24px] sm:items-center">
                                  {renderTooltipText(
                                    "IBAN",
                                    "IBAN de l'entreprise émettrice imprimé pour recevoir le virement.",
                                    "font-semibold text-[#64748b]",
                                    { fontSize: "0.78125rem", fontWeight: 600 },
                                  )}
                                  <div
                                    className="min-w-0 whitespace-normal text-left text-[#334155]"
                                    style={{
                                      fontSize: "0.78125rem",
                                      fontWeight: 850,
                                      lineHeight: 1.45,
                                      overflowWrap: "anywhere",
                                    }}
                                  >
                                    {formatIbanInput(paymentBankDisplay.iban)}
                                  </div>
                                  <GuidanceTooltip content="Modifier les coordonnées bancaires de l'entreprise dans Mon entreprise.">
                                    <Link
                                      to="/app/company"
                                      aria-label="Modifier IBAN / BIC"
                                      title="Modifier IBAN / BIC"
                                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center justify-self-end rounded-md bg-transparent text-[#1d4ed8] transition hover:text-[#1e40af] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe]"
                                      style={{ color: accentColor }}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Link>
                                  </GuidanceTooltip>
                                </div>
                              ) : null}
                              {paymentBankDisplay?.bic ? (
                                <div className="grid min-h-0 gap-2 py-0 sm:grid-cols-[92px_minmax(0,1fr)_24px] sm:items-center">
                                  {renderTooltipText(
                                    "BIC",
                                    "BIC de l'entreprise émettrice imprimé pour recevoir le virement.",
                                    "font-semibold text-[#64748b]",
                                    { fontSize: "0.78125rem", fontWeight: 600 },
                                  )}
                                  <div
                                    className="min-w-0 whitespace-normal text-left text-[#334155]"
                                    style={{
                                      fontSize: "0.78125rem",
                                      fontWeight: 850,
                                      lineHeight: 1.45,
                                      overflowWrap: "anywhere",
                                    }}
                                  >
                                    {cleanBic(paymentBankDisplay.bic)}
                                  </div>
                                  <span aria-hidden="true" />
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_minmax(0,1fr)_24px] sm:items-start">
                              {renderTooltipText(
                                documentCopy.rib,
                                "Coordonnées bancaires de l'entreprise émettrice imprimées pour recevoir le virement.",
                                "font-semibold text-[#64748b]",
                                { fontSize: "0.78125rem", fontWeight: 600 },
                              )}
                              <Link
                                to="/app/company"
                                data-testid="invoice-bank-account-add"
                                className="inline-flex h-8 w-fit items-center justify-center gap-1.5 rounded-lg border border-[#bfdbfe] bg-white px-3 text-[#1d4ed8] transition hover:bg-[#eff6ff]"
                                style={{
                                  borderColor: accentBorder,
                                  color: accentColor,
                                  fontSize: "0.78125rem",
                                  fontWeight: 750,
                                }}
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Ajouter IBAN / BIC
                              </Link>
                              <span aria-hidden="true" />
                            </div>
                          )}
                        </div>
                      </section>
                      <section
                        data-testid="invoice-mentions-card"
                        className="rounded-xl border border-[#d6deea] bg-[#f8fbff] p-2.5"
                      >
                        <div
                          className="flex items-center justify-between gap-3 text-[#2563eb]"
                          style={{ color: accentColor, fontSize: "0.78125rem", fontWeight: 650 }}
                        >
                          <span className="inline-flex items-center gap-2">
                            <ReceiptText className="h-3.5 w-3.5" />
                            {renderTooltipText(
                              documentCopy.legalMentions,
                              "Mentions légales et réglages de conformité repris sur le document.",
                            )}
                          </span>
                        </div>
                        <div
                          className="mt-3 divide-y divide-[#e2e8f0] text-[#475569]"
                          style={{ fontSize: "0.78125rem", lineHeight: 1.45 }}
                        >
                          <label className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
                            {renderTooltipText(
                              "TVA",
                              "Réglage TVA repris depuis Mon entreprise. Il est imprimé seulement en cas de débits, franchise ou exonération.",
                              "font-semibold text-[#64748b]",
                              { fontSize: "0.78125rem", fontWeight: 600 },
                            )}
                            <div className="flex min-w-0 items-center gap-2">
                              <div
                                className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-[#dbe4ef] bg-[#f8fafc] px-2 text-[#0f172a]"
                                style={{ fontSize: "0.78125rem", fontWeight: 650 }}
                              >
                                <span className="truncate">
                                  {isVatFranchiseRegime(company?.vat_regime)
                                    ? "Franchise en base"
                                    : company?.vat_on_debits
                                      ? "TVA sur les débits"
                                      : "TVA exigible à l'encaissement"}
                                </span>
                              </div>
                              <GuidanceTooltip content="Modifier la TVA dans Mon entreprise.">
                                <Link
                                  to="/app/company"
                                  aria-label="Modifier la TVA dans Mon entreprise"
                                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-white transition hover:bg-white focus:outline-none focus:ring-2"
                                  style={{
                                    borderColor: accentBorder,
                                    color: accentColor,
                                    ["--tw-ring-color" as any]: accentBorder,
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Link>
                              </GuidanceTooltip>
                            </div>
                          </label>
                          {isInvoice && einvoicingEnabled ? (
                            <label className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
                              {renderTooltipText(
                                "Factur-X",
                                "PDF contenant un XML de facture électronique. EN16931 convient à une facture standard.",
                                "font-semibold text-[#64748b]",
                                { fontSize: "0.78125rem", fontWeight: 600 },
                              )}
                              <select
                                value={form.facturx_profile}
                                onChange={(event) => setFormField("facturx_profile", event.target.value)}
                                className="h-8 w-full rounded-lg border border-[#cbd5e1] bg-white px-2 text-[#0f172a] outline-none transition hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                                style={{ fontSize: "0.78125rem", fontWeight: 650 }}
                              >
                                {FACTURX_PROFILES.map((profile) => (
                                  <option key={profile.value} value={profile.value}>
                                    {profile.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          <label className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
                            {renderTooltipText(
                              documentCopy.purchaseOrder,
                              "Référence de commande du client, utile pour son rapprochement achat et ses validations internes.",
                              "font-semibold text-[#64748b]",
                              { fontSize: "0.78125rem", fontWeight: 600 },
                            )}
                            <input
                              value={form.purchase_order_number || ""}
                              onChange={(event) => setFormField("purchase_order_number", event.target.value)}
                              placeholder="N° de bon de commande"
                              className="h-8 w-full rounded-lg border border-[#cbd5e1] bg-white px-2.5 text-[#0f172a] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                              style={{ fontSize: "0.78125rem", fontWeight: 650 }}
                            />
                          </label>
                          <label className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_78px] sm:items-center">
                            {renderTooltipText(
                              documentCopy.penalties,
                              "Taux des pénalités de retard appliqué si le règlement intervient après l'échéance.",
                              "font-semibold text-[#64748b]",
                              { fontSize: "0.78125rem", fontWeight: 600 },
                            )}
                            <span className="flex h-7 items-center gap-1 rounded-lg border border-[#cbd5e1] bg-white px-2 text-[#0f172a] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe]">
                              <input
                                inputMode="decimal"
                                value={legalPenaltyRateDisplay}
                                onChange={(event) => changeLegalPenaltyRate(event.target.value)}
                                className="min-w-0 flex-1 bg-transparent text-right outline-none"
                                style={{ fontSize: "0.78125rem", fontWeight: 650 }}
                              />
                              <span className="text-[#64748b]" style={{ fontSize: "0.78125rem", fontWeight: 500 }}>
                                %
                              </span>
                            </span>
                          </label>
                          <label className="grid min-h-10 gap-2 py-1.5 sm:grid-cols-[92px_78px] sm:items-center">
                            {renderTooltipText(
                              documentCopy.recovery,
                              "Indemnité forfaitaire de recouvrement due entre professionnels en cas de retard de paiement.",
                              "font-semibold text-[#64748b]",
                              { fontSize: "0.78125rem", fontWeight: 600 },
                            )}
                            <span className="flex h-7 items-center gap-1 rounded-lg border border-[#cbd5e1] bg-white px-2 text-[#0f172a] focus-within:border-[#2563eb] focus-within:ring-2 focus-within:ring-[#bfdbfe]">
                              <input
                                inputMode="decimal"
                                value={legalRecoveryFeeDisplay}
                                onChange={(event) => changeLegalRecoveryFee(event.target.value)}
                                className="min-w-0 flex-1 bg-transparent text-right outline-none"
                                style={{ fontSize: "0.78125rem", fontWeight: 650 }}
                              />
                              <span className="text-[#64748b]" style={{ fontSize: "0.78125rem", fontWeight: 500 }}>
                                €
                              </span>
                            </span>
                          </label>
                        </div>
                      </section>
                    </div>
                    <div className="space-y-2">
                      <textarea
                        aria-label={documentCopy.freeTextPlaceholder}
                        ref={autoResizeTextarea}
                        rows={1}
                        value={form.legal_mentions_text || ""}
                        onInput={(event) => autoResizeTextarea(event.currentTarget)}
                        onChange={(event) => {
                          autoResizeTextarea(event.currentTarget);
                          setForm((prev: any) => ({
                            ...prev,
                            legal_terms_default: false,
                            legal_mentions_text: event.target.value,
                          }));
                        }}
                        placeholder={documentCopy.freeTextPlaceholder}
                        className="min-h-9 w-full resize-none overflow-hidden rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-[#334155] outline-none transition placeholder:text-[#94a3b8] hover:border-[#93c5fd] focus:border-[#2563eb] focus:ring-2 focus:ring-[#bfdbfe]"
                        style={{ fontSize: "0.71875rem", lineHeight: 1.45, overflowWrap: "anywhere" }}
                      />
                      {noInvoiceDepositOpen ? (
                        <div
                          data-testid="no-invoice-deposit-row"
                          className="mt-2 flex flex-wrap items-center justify-center gap-2 text-center text-[#1d4ed8]"
                        >
                          <span
                            className="inline-flex min-h-8 items-center justify-center text-[#64748b]"
                            style={{ fontSize: "0.6875rem", fontWeight: 800 }}
                          >
                            {advancePaymentLabel}
                          </span>
                          <label
                            className="pf-document-focus-field flex h-8 min-w-[150px] max-w-[172px] items-center overflow-hidden rounded-lg border border-[#bfdbfe] bg-white text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:ring-2 focus-within:ring-[#bfdbfe]"
                            style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                          >
                            <input
                              aria-label={
                                noInvoiceDepositInputMode === "percent"
                                  ? "Pourcentage de l'acompte"
                                  : "Montant de l'acompte"
                              }
                              inputMode="decimal"
                              value={
                                noInvoiceDepositInputMode === "percent"
                                  ? noInvoiceDepositDraft.percent
                                  : noInvoiceDepositDraft.amount_ttc
                              }
                              onFocus={(event) => event.currentTarget.select()}
                              onChange={(event) => {
                                if (noInvoiceDepositInputMode === "percent") {
                                  const nextPercent = event.target.value;
                                  const percent = numberInputValue(nextPercent);
                                  const nextAmount =
                                    totals.totalTTC > 0 && percent > 0
                                      ? decimalInputValue(roundMoney(totals.totalTTC * (percent / 100)))
                                      : "0,00";
                                  setNoInvoiceDepositDraft((prev) => ({
                                    ...prev,
                                    percent: nextPercent,
                                    amount_ttc: nextAmount,
                                  }));
                                  return;
                                }
                                const nextAmount = event.target.value;
                                const amount = numberInputValue(nextAmount);
                                const nextPercent =
                                  totals.totalTTC > 0 && amount > 0
                                    ? decimalInputValue(roundMoney((amount / totals.totalTTC) * 100))
                                    : "";
                                setNoInvoiceDepositDraft((prev) => ({
                                  ...prev,
                                  percent: nextPercent,
                                  amount_ttc: nextAmount,
                                }));
                              }}
                              className="min-w-0 flex-1 bg-transparent px-2 text-right text-[#0f172a] outline-none"
                              style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                            />
                            <span
                              className="flex h-full shrink-0 border-l border-[#bfdbfe]"
                              aria-label="Mode de saisie de l'acompte"
                            >
                              {(["percent", "amount"] as const).map((mode) => (
                                <button
                                  key={mode}
                                  type="button"
                                  onClick={() => setNoInvoiceDepositInputMode(mode)}
                                  className={`min-w-9 px-2 transition ${
                                    noInvoiceDepositInputMode === mode
                                      ? "bg-[#2563eb] text-white"
                                      : "bg-white text-[#1d4ed8] hover:bg-[#eff6ff]"
                                  }`}
                                >
                                  {mode === "percent" ? "%" : form.currency}
                                </button>
                              ))}
                            </span>
                          </label>
                          <label
                            className={`pf-document-focus-field relative flex h-8 min-w-[156px] items-center gap-1 rounded-lg border border-[#bfdbfe] bg-white px-2 pr-7 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:ring-2 focus-within:ring-[#bfdbfe] ${
                              companyVatFranchise ? "opacity-70" : ""
                            }`}
                            title={
                              companyVatFranchise
                                ? "Franchise en base : TVA d'acompte désactivée."
                                : "Taux de TVA utilisé si une facture d'acompte est créée. Il ne transforme pas l'acompte demandé en paiement encaissé."
                            }
                          >
                            <span className="sr-only">TVA</span>
                            <select
                              aria-label="TVA"
                              value={advanceVatSelectValue(noInvoiceDepositDraft.vat_rate) || "custom"}
                              onChange={(event) => {
                                if (companyVatFranchise) return;
                                const value = event.target.value;
                                setNoInvoiceDepositDraft((prev) => ({
                                  ...prev,
                                  vat_rate: value === "custom" ? "" : value,
                                }));
                              }}
                              disabled={companyVatFranchise}
                              className="min-w-0 flex-1 appearance-none bg-transparent text-right text-[#0f172a] outline-none"
                              style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                            >
                              {ADVANCE_VAT_RATE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  TVA {option.label}
                                </option>
                              ))}
                              <option value="custom">TVA personnalisée</option>
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748b]" />
                            {advanceVatSelectValue(noInvoiceDepositDraft.vat_rate) === "custom" ||
                            !String(noInvoiceDepositDraft.vat_rate || "").trim() ? (
                              <span className="ml-1 flex w-[54px] items-center gap-1 rounded-md border border-[#dbeafe] bg-white px-1.5">
                                <input
                                  aria-label="TVA personnalisée"
                                  inputMode="decimal"
                                  value={noInvoiceDepositDraft.vat_rate}
                                  onFocus={(event) => event.currentTarget.select()}
                                  onChange={(event) =>
                                    setNoInvoiceDepositDraft((prev) => ({ ...prev, vat_rate: event.target.value }))
                                  }
                                  disabled={companyVatFranchise}
                                  placeholder="Taux"
                                  className={`${numberInputNoSpinnerClassName} min-w-0 flex-1 bg-transparent text-right text-[#0f172a] outline-none`}
                                  style={{ fontSize: "0.6875rem", fontWeight: 850 }}
                                />
                                <span className="text-[#64748b]" style={{ fontSize: "0.6875rem", fontWeight: 900 }}>
                                  %
                                </span>
                              </span>
                            ) : null}
                          </label>
                          <label
                            className="pf-document-focus-field flex h-8 min-w-[170px] max-w-[260px] flex-1 items-center justify-center rounded-lg border border-[#bfdbfe] bg-white px-2 shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[#93c5fd] focus-within:ring-2 focus-within:ring-[#bfdbfe]"
                            title={
                              isInvoice
                                ? "Référence interne du règlement d'acompte."
                                : "Libellé affiché au client pour identifier l'acompte demandé."
                            }
                          >
                            <span className="sr-only">
                              {isInvoice ? "Référence du règlement d'acompte" : "Libellé de l'acompte demandé"}
                            </span>
                            <input
                              value={noInvoiceDepositDraft.reference}
                              onChange={(event) =>
                                setNoInvoiceDepositDraft((prev) => ({ ...prev, reference: event.target.value }))
                              }
                              placeholder={isInvoice ? "Référence règlement" : "Libellé affiché"}
                              className="min-w-0 flex-1 bg-transparent text-[#0f172a] outline-none placeholder:text-[#94a3b8]"
                              style={{ fontSize: "0.6875rem", fontWeight: 800 }}
                            />
                          </label>
                          <span
                            className="inline-flex h-8 min-w-[112px] items-center justify-center rounded-lg border border-[#dbeafe] bg-[#f8fbff] px-2 text-[#0f172a]"
                            style={{ fontSize: "0.6875rem", fontWeight: 900 }}
                          >
                            {remainingAfterAdvanceLabel} :{" "}
                            {money(noInvoiceRemainingDue, form.currency).replace(" €", " EUR")}
                          </span>
                          <GuidanceTooltip
                            content={
                              isInvoice
                                ? "Retire cette déduction d'acompte du document."
                                : "Retire l'acompte demandé sur ce devis."
                            }
                          >
                            <button
                              type="button"
                              aria-label={isInvoice ? "Retirer l'acompte sans facture" : "Retirer l'acompte demandé"}
                              onClick={() => {
                                setNoInvoiceDepositOpen(false);
                                setNoInvoiceDepositInputMode("percent");
                                setNoInvoiceDepositDraft({
                                  reference: "",
                                  percent: "",
                                  amount_ttc: "0,00",
                                  vat_rate: defaultAdvanceVatRate,
                                });
                              }}
                              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${destructiveIconButtonClassName}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </GuidanceTooltip>
                        </div>
                      ) : null}
                      <div className="rounded-xl border border-[#cbd5e1] bg-white px-3 py-2.5">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          {renderTooltipText(
                            documentCopy.printedLegalMention,
                            "Texte légal final imprimé sur le document avec les conditions de règlement.",
                            "font-semibold text-[#64748b]",
                            { fontSize: "0.6875rem" },
                          )}
                          <div
                            ref={legalTemplateMenuRef}
                            className="relative flex shrink-0 items-center gap-1.5"
                            data-legal-template-menu-root="true"
                          >
                            <button
                              type="button"
                              aria-label="Options de mention légale"
                              aria-expanded={legalTemplateMenuOpen}
                              onClick={() => setLegalTemplateMenuOpen((current) => !current)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border bg-white transition"
                              style={{ borderColor: accentBorder, color: accentColor }}
                            >
                              <Settings2 className="h-3.5 w-3.5" />
                            </button>
                            {legalTemplateMenuOpen ? (
                              <div
                                className="absolute right-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-4rem)] overflow-hidden rounded-xl border bg-white p-1.5 text-left shadow-[0_18px_45px_rgba(15,23,42,0.18)]"
                                style={{ borderColor: accentBorder }}
                              >
                                <button
                                  type="button"
                                  onClick={resetLegalFooterDefaults}
                                  className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-[#1d4ed8] transition hover:bg-[#eff6ff]"
                                  style={{ fontSize: "0.75rem", fontWeight: 850 }}
                                >
                                  <Settings2 className="mt-0.5 h-3.5 w-3.5" />
                                  <span>Revenir au texte par défaut</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void saveCurrentLegalTemplate()}
                                  disabled={legalTemplateSaving}
                                  className="mt-1 flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-[#047857] transition hover:bg-[#ecfdf5] disabled:cursor-not-allowed disabled:opacity-60"
                                  style={{ fontSize: "0.75rem", fontWeight: 850 }}
                                >
                                  <Save className="mt-0.5 h-3.5 w-3.5" />
                                  <span>
                                    {legalTemplateSaving
                                      ? "Enregistrement..."
                                      : "Enregistrer cette mention pour les prochains documents"}
                                  </span>
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <p
                          className="min-w-0 break-words text-[#475569] [overflow-wrap:anywhere]"
                          style={{ fontSize: "0.75rem", lineHeight: 1.7 }}
                        >
                          <span className="inline align-baseline">
                            <span
                              key={`legal-penalty-prefix-${legalPenaltyPrefixDisplay}`}
                              role="textbox"
                              aria-label="Texte avant pénalités"
                              contentEditable
                              suppressContentEditableWarning
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  event.currentTarget.blur();
                                }
                              }}
                              onBlur={(event) => {
                                const value = event.currentTarget.textContent || "";
                                setForm((prev: any) => ({
                                  ...prev,
                                  legal_terms_default: false,
                                  legal_footer_text: "",
                                  legal_penalty_prefix: value,
                                }));
                              }}
                              className={legalEditableTextClassName}
                              style={legalEditableTextStyle}
                            >
                              {legalPenaltyPrefixDisplay}
                            </span>
                            {"\u00a0"}
                            <span
                              title="% de pénalités"
                              className="inline-flex h-6 items-center rounded-md px-1.5"
                              style={{ background: accentLight, color: accentColor, fontWeight: 900 }}
                            >
                              {legalPenaltyRateDisplay}%
                            </span>
                          </span>{" "}
                          <span className="inline align-baseline">
                            <span
                              key={`legal-recovery-prefix-${legalRecoveryPrefixDisplay}`}
                              role="textbox"
                              aria-label="Texte avant indemnité forfaitaire"
                              contentEditable
                              suppressContentEditableWarning
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  event.currentTarget.blur();
                                }
                              }}
                              onBlur={(event) => {
                                const value = event.currentTarget.textContent || "";
                                setForm((prev: any) => ({
                                  ...prev,
                                  legal_terms_default: false,
                                  legal_footer_text: "",
                                  legal_recovery_prefix: value,
                                }));
                              }}
                              className={legalEditableTextClassName}
                              style={legalEditableTextStyle}
                            >
                              {legalRecoveryPrefixDisplay}
                            </span>
                            {"\u00a0"}
                            <span
                              title="€ d'indemnité"
                              className="inline-flex h-6 items-center rounded-md px-1.5"
                              style={{ background: accentLight, color: accentColor, fontWeight: 900 }}
                            >
                              {legalRecoveryFeeDisplay} €
                            </span>
                          </span>{" "}
                          <span
                            key={`legal-discount-text-${legalDiscountTextDisplay}`}
                            role="textbox"
                            aria-label="Texte escompte"
                            contentEditable
                            suppressContentEditableWarning
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                            }}
                            onBlur={(event) => {
                              const value = event.currentTarget.textContent || "";
                              setForm((prev: any) => ({
                                ...prev,
                                legal_terms_default: false,
                                legal_footer_text: "",
                                legal_discount_text: value,
                              }));
                            }}
                            className={legalEditableTextClassName}
                            style={legalEditableTextStyle}
                          >
                            {legalDiscountTextDisplay}
                          </span>
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {compactEditorMode ? (
            <>
              {mobileAsideOpen ? (
                <button
                  type="button"
                  aria-label="Fermer les options avancées"
                  className="fixed inset-0 z-40 bg-[#0f172a]/35 backdrop-blur-[2px] xl:hidden"
                  onClick={() => setMobileAsideOpen(false)}
                />
              ) : null}
              <div
                className={`${
                  mobileAsideOpen
                    ? "fixed inset-x-3 bottom-20 z-50 block max-h-[calc(100vh-7rem)] overflow-y-auto rounded-2xl"
                    : "hidden"
                } xl:sticky xl:top-20 xl:z-auto xl:block xl:max-h-none xl:overflow-visible xl:rounded-none xl:self-start`}
                data-invoice-print-aside
              >
                {sideOptionsCard}
              </div>
            </>
          ) : null}

          {!compactEditorMode ? (
            <div
              className={`${mobileAsideOpen ? "space-y-4" : "hidden"} lg:block lg:space-y-4 xl:sticky xl:top-20`}
              data-invoice-print-aside
            >
              {compactEditorMode ? (
                <>
                  <Card>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                          Clients
                        </div>
                      </div>
                      <Link
                        to="/app/customers/new"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#e2e8f0] bg-white px-3 py-2 text-[#374151] hover:bg-[#f8fafc]"
                        style={{ fontSize: "0.75rem", fontWeight: 600 }}
                      >
                        <Plus className="h-3.5 w-3.5" /> Nouveau
                      </Link>
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                      <Search className="h-4 w-4 text-[#94a3b8]" />
                      <input
                        type="search"
                        value={customerQuery}
                        onChange={(event) => setCustomerQuery(event.target.value)}
                        autoComplete="new-password"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="Rechercher un client (nom, email...)"
                        className="w-full bg-transparent text-[#0f172a] outline-none"
                        style={{ fontSize: "0.8125rem" }}
                      />
                    </div>
                    <div className="mt-3 space-y-2">
                      {recentCustomers.slice(0, customerQuery.trim() ? 5 : 3).map((customer: any) => {
                        const active = customer.id === form.customer_id;
                        return (
                          <button
                            key={customer.id}
                            type="button"
                            onClick={() => setFormField("customer_id", customer.id)}
                            className={`dropdown__item w-full rounded-2xl border px-3 py-3 text-left transition-all ${active ? "bg-white shadow-[0_4px_14px_rgba(15,23,42,0.06)]" : "border-[#e2e8f0] bg-white hover:bg-[#f8fafc]"}`}
                            style={active ? { borderColor: accentBorder, background: accentLight } : undefined}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div
                                  className="truncate text-[#0f172a]"
                                  style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                                >
                                  {customer.name}
                                </div>
                                <div className="mt-1 truncate text-[#64748b]" style={{ fontSize: "0.75rem" }}>
                                  {customer.email || "Email à compléter"}
                                </div>
                              </div>
                              {active ? (
                                <span
                                  className="inline-flex h-6 items-center rounded-full px-2 text-white"
                                  style={{ fontSize: "0.6875rem", fontWeight: 700, background: accentColor }}
                                >
                                  Actif
                                </span>
                              ) : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </Card>

                  {seqinoOperational && isInvoice && selectedCustomer && selectedDirectoryInfo ? (
                    <Card className="card">
                      <div className="mb-2 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                        Synchronisation Seqino
                      </div>
                      <div className="space-y-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                        <div>Plateforme: {selectedDirectoryInfo.platform_slug || "—"}</div>
                        <div>Adresse de facturation: {selectedDirectoryInfo.billing_address || "—"}</div>
                      </div>
                    </Card>
                  ) : null}

                  <Card>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                          Conformité
                        </div>
                        <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                          Lecture rapide de ce qui manque avant création.
                        </p>
                      </div>
                      <span
                        className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-[#0f172a]"
                        style={{ fontSize: "0.75rem", fontWeight: 700 }}
                      >
                        {readiness.score}%
                      </span>
                    </div>
                    <div className="space-y-2">
                      {readiness.checks.map((check: any) => (
                        <div
                          key={check.label}
                          className="flex items-start justify-between gap-3 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="text-[#0f172a]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                              {check.label}
                            </div>
                            <div className="mt-1 text-[#64748b]" style={{ fontSize: "0.6875rem", lineHeight: 1.5 }}>
                              {check.hint}
                            </div>
                          </div>
                          <StatusPill status={check.ok ? "ok" : "warn"} label={check.ok ? "OK" : "À faire"} />
                        </div>
                      ))}
                    </div>
                  </Card>
                </>
              ) : (
                <>
                  {sideOptionsCard}

                  <Card>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                          Client
                        </div>
                        <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                          Sélectionnez la bonne fiche, puis complétez les réglages utiles dans les panneaux plus bas.
                        </p>
                      </div>
                      <Link
                        to="/app/customers/new"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#e2e8f0] bg-white px-3 py-2 text-[#374151] hover:bg-[#f8fafc]"
                        style={{ fontSize: "0.75rem", fontWeight: 600 }}
                      >
                        <Plus className="h-3.5 w-3.5" /> Nouveau
                      </Link>
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                      <Search className="h-4 w-4 text-[#94a3b8]" />
                      <input
                        type="search"
                        value={customerQuery}
                        onChange={(event) => setCustomerQuery(event.target.value)}
                        autoComplete="new-password"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="Rechercher un client (nom, email...)"
                        className="w-full bg-transparent text-[#0f172a] outline-none"
                        style={{ fontSize: "0.8125rem" }}
                      />
                    </div>
                    {!customerQuery && recentCustomerIds.length ? (
                      <div className="mt-3 flex gap-2 overflow-x-auto pb-1 lg:flex-wrap">
                        {recentCustomerIds.slice(0, 3).map((id) => {
                          const customer = customers.find((item) => item.id === id);
                          if (!customer) return null;
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setFormField("customer_id", id)}
                              className={`rounded-full border px-3 py-1.5 ${form.customer_id === id ? "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]" : "border-[#e2e8f0] bg-white text-[#475569] hover:bg-[#f8fafc]"}`}
                              style={{ fontSize: "0.75rem", fontWeight: 700 }}
                            >
                              {customer.name}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="mt-3 max-h-[260px] space-y-2 overflow-auto pr-1">
                      {filteredCustomers.map((customer) => {
                        const active = customer.id === form.customer_id;
                        const customerIsBusiness = isBusinessClientType(customer?.client_type);
                        const customerIdentifier = customerIsBusiness
                          ? formatSiretInput(customer.siret || "") ||
                            formatSirenInput(customer.siren || "") ||
                            formatVatNumberInput(customer.vat_number || "") ||
                            "Identifiant à compléter"
                          : "Particulier";
                        return (
                          <button
                            key={customer.id}
                            type="button"
                            onClick={() => setFormField("customer_id", customer.id)}
                            className={`dropdown__item w-full rounded-2xl border px-3 py-3 text-left transition-all ${active ? "border-[#bfdbfe] bg-[#eff6ff] shadow-[0_4px_14px_rgba(29,78,216,0.08)]" : "border-[#e2e8f0] bg-white hover:bg-[#f8fafc]"}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                                  {customer.name}
                                </div>
                                <div className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem" }}>
                                  {customer.email || "Pas d'email"}
                                </div>
                              </div>
                              {active ? (
                                <span
                                  className="inline-flex h-6 items-center rounded-full bg-[#1d4ed8] px-2 text-white"
                                  style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                                >
                                  Actif
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-2 text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                              {customerIdentifier}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </Card>

                  {seqinoOperational && isInvoice && selectedCustomer && selectedDirectoryInfo ? (
                    <Card className="card">
                      <div className="mb-2 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                        Synchronisation Seqino
                      </div>
                      <div className="space-y-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                        <div>Plateforme: {selectedDirectoryInfo.platform_slug || "—"}</div>
                        <div>Adresse de facturation: {selectedDirectoryInfo.billing_address || "—"}</div>
                      </div>
                    </Card>
                  ) : null}

                  <Card>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                          Résumé
                        </div>
                        <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                          Le document reste centré. Le rail sert juste à confirmer l’essentiel.
                        </p>
                      </div>
                      <div
                        className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-[#0f172a]"
                        style={{ fontSize: "0.75rem", fontWeight: 700 }}
                      >
                        {money(totals.totalTTC, form.currency)}
                      </div>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-3">
                        <div
                          className="text-[#94a3b8]"
                          style={{
                            fontSize: "0.6875rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Client
                        </div>
                        <div className="mt-1 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                          {selectedCustomer?.name || "À choisir"}
                        </div>
                      </div>
                      <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-3">
                        <div
                          className="text-[#94a3b8]"
                          style={{
                            fontSize: "0.6875rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Lignes
                        </div>
                        <div className="mt-1 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                          {filledLineCount || 0}
                        </div>
                      </div>
                      <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-3">
                        <div
                          className="text-[#94a3b8]"
                          style={{
                            fontSize: "0.6875rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Préparation
                        </div>
                        <div className="mt-1 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                          {readiness.score}%
                        </div>
                      </div>
                      <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-3">
                        <div
                          className="text-[#94a3b8]"
                          style={{
                            fontSize: "0.6875rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Échéance
                        </div>
                        <div className="mt-1 text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                          {form.due_date || form.valid_until || "À définir"}
                        </div>
                      </div>
                    </div>
                    <div
                      className="mt-4 rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-3 text-[#475569]"
                      style={{ fontSize: "0.75rem", lineHeight: 1.6 }}
                    >
                      <strong className="text-[#0f172a]">Prochaine action :</strong> {nextPrimaryAction}
                    </div>
                  </Card>
                </>
              )}

              <>
                <DisclosureCard
                  title="Catalogue"
                  description="Ajoutez rapidement un article existant sans surcharger le document."
                  defaultOpen={false}
                  badge={
                    <span
                      className="inline-flex items-center rounded-full px-2.5 py-1 bg-[#f1f5f9] text-[#64748b]"
                      style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                    >
                      Optionnel
                    </span>
                  }
                >
                  <div>
                    <div className="flex items-center gap-2 rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                      <Search className="h-4 w-4 text-[#94a3b8]" />
                      <input
                        value={catalogQuery}
                        onChange={(event) => setCatalogQuery(event.target.value)}
                        placeholder="Rechercher un article…"
                        className="w-full bg-transparent text-[#0f172a] outline-none"
                        style={{ fontSize: "0.8125rem" }}
                      />
                    </div>
                    <div className="mt-2 space-y-2">
                      {filteredCatalogItems.map((item) => (
                        <button
                          key={item.id || item.name}
                          type="button"
                          onClick={() => applyCatalogItem(item)}
                          className="w-full rounded-xl border border-[#e2e8f0] bg-white px-3 py-2 text-left hover:bg-[#f8fafc]"
                        >
                          <div className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                            {item?.name || "Article"}
                          </div>
                          <div className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem" }}>
                            {money(item?.unit_price || 0, form.currency)} · TVA {Number(item?.vat_rate || 20)}%
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </DisclosureCard>
              </>
            </div>
          ) : null}
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[#dbe4ef] bg-white/96 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] backdrop-blur lg:hidden">
        <div className="flex w-full items-center gap-3">
          <button
            type="button"
            onClick={() =>
              setMobileAsideOpen((prev) => {
                const next = !prev;
                if (next && !sideOptionOpen) {
                  setSideOptionsCollapsed(false);
                  setSideOptionOpen("document");
                }
                return next;
              })
            }
            className="inline-flex items-center justify-center rounded-xl border px-3 py-2 text-white shadow-sm hover:opacity-95"
            style={{ fontSize: "0.75rem", fontWeight: 700, borderColor: accentColor, background: accentColor }}
          >
            {mobileAsideOpen ? "Masquer" : "Options"}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[#0f172a]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
              {selectedCustomer?.name || "Client à choisir"}
            </div>
            <div className="truncate text-[#64748b]" style={{ fontSize: "0.6875rem" }}>
              {lines.filter((line) => String(line?.product_name || "").trim()).length} ligne(s) ·{" "}
              {money(totals.totalTTC, form.currency)}
            </div>
          </div>
          <PrimaryButton
            onClick={() => submit(mobilePrimarySubmitIntent)}
            disabled={submitDisabled}
            title={submitBlockReason || undefined}
            className="shrink-0"
            style={{
              background: accentColor,
              boxShadow: `0 1px 3px ${isInvoice ? "rgba(29,78,216,0.35)" : "rgba(124,58,237,0.35)"}, inset 0 1px 0 rgba(255,255,255,0.15)`,
            }}
          >
            {mobilePrimaryLabel}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
