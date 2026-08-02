"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@/figma/react-router-compat";
import { api, extractUserFacingApiMessage, formatApiError, rawApi, sanitizeUserFacingApiMessage } from "@/lib/api";
import { describeJobProgress, waitForMaybeJob } from "@/lib/jobs";
import { downloadProtectedFile } from "@/lib/download";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { emailDeliveryProof } from "@/lib/emailDeliveryProof";
import {
  digitsOnly,
  formatBicInput,
  formatIbanInput,
  formatPhoneDisplay,
  formatSirenInput,
  formatSiretInput,
  formatVatNumberInput,
} from "@/lib/businessRules";
import { getLegalConfig } from "@/lib/legalConfig";
import { buildInvoiceComplianceUiItems } from "@/lib/invoiceComplianceUi";
import { useCockpit } from "@/lib/useCockpit";
import { useHydrated } from "@/lib/useHydrated";
import { can } from "@/lib/permissions";
import { useSession } from "@/lib/useSession";
import { resolveProductCapabilities } from "@/lib/productCapabilities";
import { isTrialSubscription, restrictCapabilitiesForTrial, TRIAL_LIVE_ACTION_MESSAGE } from "@/lib/trialMode";
import { motion } from "motion/react";
import {
  AppPageHeader,
  DataTable,
  InputField,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { InvoiceDocumentEditor } from "../../components/app/InvoiceDocumentEditor";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { GuidanceTooltip } from "../../components/app/GuidanceTooltip";
import {
  LIST_PAGE_SIZE_OPTIONS,
  ListPagination,
  paginateList,
  usePersistedListPageSize,
} from "../../components/app/ListPagination";
import { ModuleOverview } from "../../components/app/ModuleOverview";
import type { ModuleOverviewStat } from "../../components/app/ModuleOverview";
import InvoiceEmailModal, {
  type EmailDefaultTemplatePayload,
  type InvoiceEmailPayload,
} from "@/components/InvoiceEmailModal";
import CreditNoteModal, { type CreditNoteCreatePayload, type CreditNoteLine } from "@/components/CreditNoteModal";
import { AccountingReadinessPanel } from "@/components/AccountingReadinessPanel";
import { AccountingLineCorrectionPanel } from "@/components/AccountingLineCorrectionPanel";
import {
  AlertTriangle,
  Building2,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Hash,
  Info,
  Mail,
  MapPin,
  Minus,
  Phone,
  Plus,
  Printer,
  ReceiptText,
  RefreshCw,
  Search,
  Send,
  Wallet,
  Pencil,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

const statusMap: Record<string, { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" }> = {
  draft: { label: "Brouillon", color: "muted" },
  issued: { label: "Émise", color: "info" },
  sent: { label: "Envoyée", color: "purple" },
  partial: { label: "Partielle", color: "warn" },
  paid: { label: "Payée", color: "ok" },
  overdue: { label: "En retard", color: "danger" },
  canceled: { label: "Annulée", color: "muted" },
};

const transmissionErrorAction = (err: unknown): { href: string; label: string } | null => {
  const apiErr = err as { code?: string; remediation_url?: string } | null;
  const href = (apiErr?.remediation_url || "").trim();
  if (!href || !href.startsWith("/app/")) return null;
  const code = (apiErr?.code || "").toLowerCase();
  if (code.includes("token") || href.includes("/billing")) {
    return { href, label: "Gérer les jetons" };
  }
  if (code.includes("mandate") || code.includes("seqino") || code.includes("chorus") || href.includes("settings")) {
    return { href, label: "Configurer" };
  }
  return { href, label: "Corriger" };
};

const DEFAULT_PREVIEW_LINE_COLUMNS = {
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
type PreviewLineColumnKey = keyof typeof DEFAULT_PREVIEW_LINE_COLUMNS;

const EMAIL_LOG_ONLY_NOTICE = "Canal email non configuré : message enregistré, mais non envoyé au client.";

function emailDeliveryNotice(result: any, sentLabel: string, queuedLabel = "Email en cours d'envoi.") {
  const delivery = String(result?.delivery || "").toLowerCase();
  const status = String(result?.status || "").toLowerCase();
  if (result?.email_sent === false || delivery === "log_only") return EMAIL_LOG_ONLY_NOTICE;
  if (["queued", "pending", "scheduled"].includes(status)) return queuedLabel;
  if (["sent", "delivered", "success"].includes(status) || result?.email_sent === true) return sentLabel;
  if (delivery === "smtp") return queuedLabel;
  return sentLabel;
}

const initialsFromName = (value?: string | null) => {
  const source = String(value || "").trim();
  if (/factur\\s*x/i.test(source) || /facturx/i.test(source)) return "FX";
  const parts = source.split(/\s+/).filter(Boolean);
  if (!parts.length) return "FX";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
};

function normalizePreviewLineColumns(value: any) {
  const raw = value && typeof value === "object" ? value : {};
  return (Object.keys(DEFAULT_PREVIEW_LINE_COLUMNS) as PreviewLineColumnKey[]).reduce(
    (columns, key) => ({
      ...columns,
      [key]: typeof raw?.[key] === "boolean" ? raw[key] : columns[key],
    }),
    { ...DEFAULT_PREVIEW_LINE_COLUMNS },
  );
}

function money(v: any, c = "EUR") {
  return `${Number(v || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c === "EUR" ? "€" : c}`;
}

function parsePositiveMoneyInput(value: any) {
  const normalized = String(value ?? "")
    .replace(/\s/g, "")
    .replace(",", ".");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function renderEmailTemplateText(template: string, variables: Record<string, string>) {
  return Object.entries(variables)
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((text, [token, rendered]) => text.split(token).join(rendered), template || "");
}

function isTechnicalReplyEmail(value: any) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  const [local, domain] = email.split("@");
  return domain === "example.test" && (local === "info" || local === "no-reply");
}

function firstDocumentContactEmail(...values: any[]) {
  return (
    values
      .map((value) => String(value || "").trim())
      .find((email) => email.includes("@") && !isTechnicalReplyEmail(email)) || ""
  );
}

function reusableEmailTemplateText(value: string, variables: Record<string, string>) {
  return Object.entries(variables)
    .map(([token, rendered]) => [token, String(rendered || "").trim()] as const)
    .filter(([, rendered]) => rendered)
    .sort((a, b) => b[1].length - a[1].length)
    .reduce((text, [token, rendered]) => text.split(rendered).join(token), value || "");
}

function downloadLabel(p: string) {
  if (p.endsWith("/ubl.xml")) return "UBL";
  if (p.endsWith("/cii.xml")) return "CII";
  if (p.endsWith("/facturx.pdf")) return "Factur-X";
  if (p.endsWith("/compliance-report.pdf")) return "Rapport PDF";
  return "Télécharger";
}
function typeLabel(inv: any) {
  if (inv?.type === "quote") return "Devis";
  return inv?.type === "credit_note" ? "Avoir" : "Facture";
}
function toApiDateTime(v?: string | null) {
  const r = (v || "").trim();
  return r ? `${r}T09:00:00` : null;
}

function manualPaymentHelp() {
  return "Banque = compte bancaire, espèces = caisse physique, manuel = régularisation sans mouvement bancaire ou caisse.";
}

function followupOffsetLabel(offset: any) {
  const value = Number(offset);
  if (!Number.isFinite(value)) return "Relance";
  if (value < 0) return `${Math.abs(value)} j avant échéance`;
  if (value === 0) return "À l'échéance";
  return `${value} j après échéance`;
}

function followupStatusLabel(status: any) {
  switch (String(status || "")) {
    case "sent":
      return "Envoyée";
    case "ready":
      return "À envoyer";
    case "planned":
      return "Prévue";
    case "missed":
      return "Ratée";
    case "manual":
      return "Manuelle";
    case "missing_recipient":
      return "Email requis";
    case "blocked":
      return "Bloquée";
    case "settled":
      return "Soldée";
    default:
      return "Prévue";
  }
}

function followupStatusTone(status: any) {
  switch (String(status || "")) {
    case "sent":
    case "settled":
      return "text-[#059669]";
    case "ready":
      return "text-[#dc2626]";
    case "missed":
    case "missing_recipient":
      return "text-[#d97706]";
    case "blocked":
      return "text-[#64748b]";
    default:
      return "text-[#2563eb]";
  }
}

function invoiceFollowupBlockLabel(code: any) {
  switch (String(code || "")) {
    case "invoice_followup_missing_recipient":
      return "Ajoutez un email client ou un contact facturation avant de relancer.";
    case "invoice_followup_no_balance":
      return "Aucune relance prévue : le document est soldé.";
    case "invoice_followup_not_due":
      return "Émettez la facture avant toute relance.";
    case "invoice_followup_credit_note":
      return "Les relances client ne s'appliquent pas aux avoirs.";
    case "invoice_followup_limit":
      return "La limite de relances est atteinte pour cette facture.";
    case "invoice_followup_too_soon":
      return "Une relance a déjà été enregistrée récemment.";
    default:
      return "";
  }
}

function parseFollowupScheduleDaysInput(value: string) {
  const seen = new Set<number>();
  return String(value || "")
    .split(/[,\s;]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((part) => Number.isInteger(part) && part >= -30 && part <= 120)
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    });
}

function formatFollowupScheduleDaysInput(days: any) {
  const list = Array.isArray(days)
    ? days
    : Array.isArray(days?.schedule_days)
      ? days.schedule_days
      : Array.isArray(days?.followup_schedule)
        ? days.followup_schedule.map((item: any) => item?.offset)
        : [];
  const parsed = parseFollowupScheduleDaysInput(list.join(", "));
  return (parsed.length ? parsed : [-2, 3, 10]).join(", ");
}

const PAYMENT_SETTLEMENT_OPTIONS = [
  { value: "bank", label: "Banque", method: "virement", category: "512 Banque" },
  { value: "cash", label: "Espèces", method: "especes", category: "531 Caisse" },
  { value: "manual", label: "Manuel", method: "manuel", category: "Je ne sais pas / demander au comptable · 471" },
];

const PAYMENT_ACCOUNTING_OPTIONS = [
  "512 Banque",
  "531 Caisse",
  "627 Commission bancaire",
  "666 Différence de change",
  "758 Trop-perçu",
  "Je ne sais pas / demander au comptable · 471",
];

function todayInputDate() {
  return new Date().toISOString().slice(0, 10);
}

function paymentSettlementDefaults(mode: string) {
  return PAYMENT_SETTLEMENT_OPTIONS.find((item) => item.value === mode) || PAYMENT_SETTLEMENT_OPTIONS[0];
}

function paymentSettlementLabel(mode: any) {
  return paymentSettlementDefaults(String(mode || "bank")).label;
}

function updatePaymentSettlement(setter: any, mode: string) {
  const defaults = paymentSettlementDefaults(mode);
  setter((current: any) => ({
    ...current,
    settlement_mode: defaults.value,
    method: defaults.method,
    accounting_category:
      !current?.accounting_category ||
      PAYMENT_SETTLEMENT_OPTIONS.some((item) => item.category === current.accounting_category)
        ? defaults.category
        : current.accounting_category,
  }));
}

function compactAddressLines(...values: any[]) {
  const seen = new Set<string>();
  return values
    .flatMap((value) => String(value || "").split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(FR|FRANCE)$/i.test(line))
    .filter((line) => {
      const key = line.replace(/\s+/g, " ").toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function shortRef(value: any) {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  return raw.length > 18 ? `${raw.slice(0, 10)}…${raw.slice(-6)}` : raw;
}

function noteBlocks(value: any) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function looksLikeLegalMention(value: string) {
  return /TVA (sur les encaissements|exigible|non applicable|acquitt[ée]e d['’]apr[èe]s les d[ée]bits)|Option pour le paiement de la taxe d['’]apr[èe]s les d[ée]bits|P[ée]nalit[ée]s de retard|p[ée]nalit[ée]s au taux|Indemnit[ée] forfaitaire|indemnit[ée] forfaitaire|Escompte pour paiement anticip[ée]|Aucun escompte|Late penalties|Fixed recovery fee|No early payment discount|Devis valable|Bon pour accord|Quote valid|Approved/i.test(
    value,
  );
}

function previewDocumentTitle(invoice: any) {
  const fromOptions = String(invoice?.template_options?.document_title || "").trim();
  if (fromOptions) return fromOptions;
  return "";
}

function previewFreeNote(invoice: any, documentTitle: string) {
  const blocks = noteBlocks(invoice?.note)
    .filter((block) => block !== documentTitle)
    .filter((block) => !looksLikeLegalMention(block));
  const templateFreeText = String(
    invoice?.template_options?.legal_mentions_text || invoice?.legal_mentions_text || "",
  ).trim();
  if (templateFreeText && !looksLikeLegalMention(templateFreeText) && !blocks.includes(templateFreeText)) {
    blocks.push(templateFreeText);
  }
  return blocks.join("\n\n");
}

function operationLabel(value: any) {
  const key = String(value || "").toLowerCase();
  if (key === "goods") return "Biens";
  if (key === "mixed") return "Mixte";
  return "Services";
}

function companyVatExemptionLabel(company: any, fallback = "TVA non applicable, art. 293 B du CGI") {
  const vatRegime = String(company?.vat_regime || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const vatNumber = String(company?.vat_number || "").trim();
  const exemptionNotice = String(company?.vat_exemption_notice || "").trim();
  const isFranchise = [
    "franchise",
    "franchise_base",
    "franchise_en_base",
    "micro",
    "micro_entreprise",
    "microentreprise",
    "auto_entrepreneur",
    "autoentrepreneur",
  ].includes(vatRegime);
  if (isFranchise || (exemptionNotice && !vatNumber)) return exemptionNotice || fallback;
  return "";
}

function isCompanyVatFranchise(company: any) {
  const vatRegime = String(company?.vat_regime || "")
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
  ].includes(vatRegime);
}

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

const VAT_ZERO_REASON_LABELS_EN: Record<string, string> = {
  "VATEX-FR-FRANCHISE": "VAT not applicable, French CGI art. 293 B",
  "VATEX-FR-CGI261-1": "VAT exemption",
  "VATEX-FR-CGI261-2": "VAT exemption",
  "VATEX-FR-CGI261-3": "VAT exemption",
  "VATEX-FR-CGI261-4": "VAT exemption",
  "VATEX-FR-CGI261-5": "VAT exemption",
  "VATEX-FR-CGI261-7": "VAT exemption",
  "VATEX-FR-CGI261-8": "VAT exemption",
  "VATEX-FR-EXO": "VAT exemption",
  "VATEX-FR-EXPORT": "VAT exemption, export",
  "VATEX-EU-G": "VAT exemption, export",
  "VATEX-EU-IC": "VAT exemption, intra-EU supply",
  "VATEX-FR-AE": "Reverse charge",
  "VATEX-EU-AE": "Reverse charge",
  AE: "Reverse charge",
};

function normalizeVatCode(value: any) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function previewLineHasStandardTaxableVat(line: any) {
  const category = normalizeVatCode(line?.vat_category || "S") || "S";
  return category === "S" && Number(line?.vat_rate ?? 0) !== 0;
}

function previewDocumentHasStandardTaxableVat(invoice: any) {
  return (invoice?.lines || []).some(
    (line: any) => String(line?.line_type || "item").toLowerCase() === "item" && previewLineHasStandardTaxableVat(line),
  );
}

function previewLineVatReasonLabel(line: any, company: any, language = "fr") {
  const rate = Number(line?.vat_rate ?? 0);
  const rawCategory = normalizeVatCode(line?.vat_category);
  const category = rawCategory || "S";
  const code = normalizeVatCode(line?.exemption_reason_code);
  if (rate !== 0 && category === "S" && !code) return "";
  const companyExemption = companyVatExemptionLabel(
    company,
    language === "en" ? "VAT not applicable, French CGI art. 293 B" : "TVA non applicable, art. 293 B du CGI",
  );
  if (companyExemption) return companyExemption;
  if (rate === 0 && !rawCategory && !code) {
    return language === "en" ? "VAT 0 reason to specify" : "Motif TVA 0 à préciser";
  }
  const labels = language === "en" ? VAT_ZERO_REASON_LABELS_EN : VAT_ZERO_REASON_LABELS_FR;
  if (code && labels[code]) return labels[code];
  if (code && /293\s*B/.test(code)) return labels["VATEX-FR-FRANCHISE"];
  if (code && /(AUTOLIQ|REVERSE)/.test(code)) return labels.AE;
  if (code) {
    if (category === "AE") return labels.AE;
    if (category === "O") return language === "en" ? `VAT not applicable - ${code}` : `TVA non applicable - ${code}`;
    if (category === "Z") return language === "en" ? `Zero-rated VAT - ${code}` : `TVA à taux zéro - ${code}`;
    return language === "en" ? `VAT exemption - ${code}` : `Exonération de TVA - ${code}`;
  }
  if (category === "AE") return labels.AE;
  if (category === "O")
    return language === "en" ? "VAT not applicable - outside scope" : "TVA non applicable - opération hors champ";
  if (category === "Z") return language === "en" ? "Zero-rated VAT" : "TVA à taux zéro";
  if (category === "E") return language === "en" ? "VAT exemption" : "Exonération de TVA";
  return "";
}

function previewVatZeroLabels(invoice: any, company: any, language = "fr") {
  const labels: string[] = [];
  (invoice?.lines || []).forEach((line: any) => {
    if (String(line?.line_type || "item").toLowerCase() !== "item") return;
    const label = previewLineVatReasonLabel(line, company, language);
    if (label && !labels.includes(label)) labels.push(label);
  });
  return labels;
}

function sentence(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function previewVatCollectionLabel(company: any, invoice?: any, language = "fr") {
  const exemption = companyVatExemptionLabel(
    company,
    language === "en" ? "VAT not applicable, French CGI art. 293 B" : "TVA non applicable, art. 293 B du CGI",
  );
  if (exemption && !previewDocumentHasStandardTaxableVat(invoice)) return exemption;
  const zeroLabels = previewVatZeroLabels(invoice, company, language);
  if (zeroLabels.length) return zeroLabels.join(", ");
  if (language === "en") {
    return company?.vat_on_debits ? "VAT on debits" : "";
  }
  return company?.vat_on_debits ? "TVA sur les débits" : "";
}

function previewVatLabelIsSpecial(value: string) {
  const normalized = String(value || "")
    .trim()
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
      "vat due on payments received",
      "vat payable according to debits",
    ].includes(normalized),
  );
}

function formatFacturxProfileLabel(value: any) {
  const profile = String(value || "EN16931").toUpperCase();
  if (profile === "EXTENDED-CTC-FR") return "EN16931 (recommandé) · EXTENDED-CTC-FR";
  return profile === "EN16931" ? "EN16931 (recommandé)" : profile;
}

function hasFacturxArtifact(invoice: any) {
  return invoice?.has_facturx === true;
}

function parsePreviewPenaltyRate(value: string, company: any) {
  const match =
    value.match(/P[ée]nalit[ée]s de retard\s*:\s*([\d,.]+)\s*%/i) ||
    value.match(/p[ée]nalit[ée]s au taux de\s*([\d,.]+)\s*%/i) ||
    value.match(/penalties(?:\s+of)?\s*([\d,.]+)\s*%/i);
  if (match?.[1]) return match[1].replace(".", ",");
  const companyRate = String(company?.late_payment_interest || "").match(/([\d,.]+)/)?.[1];
  return companyRate ? companyRate.replace(".", ",") : "10";
}

function parsePreviewRecoveryFee(value: string, company: any) {
  const match =
    value.match(/recouvrement\s*:\s*([\d,.]+)\s*€/i) ||
    value.match(/recouvrement de\s*([\d,.]+)\s*€/i) ||
    value.match(/recovery fee(?:\s+of)?\s*([\d,.]+)\s*(?:€|EUR)?/i);
  if (match?.[1]) return match[1].replace(".", ",");
  const companyFee = company?.recovery_fee_eur ?? company?.recovery_fee;
  const parsed = Number(String(companyFee ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : "40";
}

function normalizePreviewLegalFooterText(value: any) {
  return String(value || "").replace("Pénalités de retard : taux directeur BCE majoré.", "Pénalités de retard : 10%.");
}

function previewLegalVatSentence(company: any, language = "fr", invoice?: any) {
  const vatRegime = String(company?.vat_regime || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const isFranchise = [
    "franchise",
    "franchise_base",
    "franchise_en_base",
    "micro",
    "micro_entreprise",
    "microentreprise",
    "auto_entrepreneur",
    "autoentrepreneur",
  ].includes(vatRegime);
  if (language === "en") {
    if (
      (isFranchise || (company?.vat_exemption_notice && !company?.vat_number)) &&
      !previewDocumentHasStandardTaxableVat(invoice)
    ) {
      return sentence(company?.vat_exemption_notice || "VAT not applicable, French CGI art. 293 B");
    }
    const zeroLabels = previewVatZeroLabels(invoice, company, language);
    if (zeroLabels.length) return sentence(zeroLabels.join(", "));
    return company?.vat_on_debits ? "VAT payable according to debits." : "";
  }
  const exemption = companyVatExemptionLabel(company);
  if (exemption && !previewDocumentHasStandardTaxableVat(invoice)) return sentence(exemption);
  const zeroLabels = previewVatZeroLabels(invoice, company, language);
  if (zeroLabels.length) return sentence(zeroLabels.join(", "));
  return company?.vat_on_debits ? "TVA acquittée d'après les débits." : "";
}

function ensurePreviewVatReasonInText(text: string, company: any, invoice: any, language = "fr") {
  const cleaned = String(text || "").trim();
  const vatLine = previewLegalVatSentence(company, language, invoice);
  if (!cleaned || !previewVatLabelIsSpecial(vatLine)) return cleaned;
  const normalizedText = cleaned.toLowerCase();
  const normalizedVat = vatLine.replace(/[.!?]+$/, "").toLowerCase();
  if (
    normalizedText.includes(normalizedVat) ||
    /293\s*b|autoliquid|reverse charge|exon[ée]ration|hors champ|outside scope/i.test(cleaned)
  ) {
    return cleaned;
  }
  return `${vatLine} ${cleaned}`.trim();
}

function quotePreviewLegalDiscountText(value: any, language: string) {
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

function previewLegalMentionText(invoice: any, company: any, isInvoice = true) {
  const options =
    invoice?.template_options && typeof invoice.template_options === "object" ? invoice.template_options : {};
  const language = String(options.document_language || "fr")
    .trim()
    .toLowerCase()
    .startsWith("en")
    ? "en"
    : "fr";
  const customFooter = normalizePreviewLegalFooterText(options.legal_footer_text).trim();
  if (!isInvoice) {
    const quoteValidUntil = formatDateFr(
      invoice?.due_date || options.valid_until || options.due_date,
      "la date indiquée",
    );
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
    if (customFooter) return stripQuoteValidity(customFooter);
    const quotePenaltyRate = String(options.legal_penalty_rate || "10").trim() || "10";
    const quoteRecoveryFee = String(options.legal_recovery_fee || "40").trim() || "40";
    const quotePenaltyPrefix =
      String(options.legal_penalty_prefix || "").trim() ||
      (previewVatLabelIsSpecial(previewVatCollectionLabel(company, invoice, language))
        ? previewLegalVatSentence(company, language, invoice) + " "
        : "") +
        (language === "en"
          ? "No early payment discount applies. In case of late payment on an agreed due date, penalties of"
          : "Aucun escompte n'est accordé en cas de paiement anticipé. En cas de retard sur une échéance de paiement convenue, des pénalités au taux de");
    const quoteRecoveryPrefix =
      String(options.legal_recovery_prefix || "").trim() ||
      (language === "en"
        ? "and a fixed recovery fee of"
        : "seront dues à compter du lendemain de l'échéance, ainsi qu'une indemnité forfaitaire de");
    const quoteDiscountText = quotePreviewLegalDiscountText(options.legal_discount_text, language);
    if (
      options.legal_penalty_rate ||
      options.legal_recovery_fee ||
      options.legal_penalty_prefix ||
      options.legal_recovery_prefix ||
      options.legal_discount_text
    ) {
      return ensurePreviewVatReasonInText(
        (
          quotePenaltyPrefix +
          " " +
          quotePenaltyRate +
          " % " +
          quoteRecoveryPrefix +
          " " +
          quoteRecoveryFee +
          " € " +
          quoteDiscountText
        ).trim(),
        company,
        invoice,
        language,
      );
    }
    const legalBlock = noteBlocks(invoice?.note).find((block) => looksLikeLegalMention(block));
    if (legalBlock) return stripQuoteValidity(ensurePreviewVatReasonInText(legalBlock, company, invoice, language));
    if (invoice?.legal_mentions)
      return stripQuoteValidity(
        ensurePreviewVatReasonInText(String(invoice.legal_mentions), company, invoice, language),
      );
    const quoteDefault =
      language === "en"
        ? "No early payment discount applies. In case of late payment on an agreed due date, penalties of " +
          quotePenaltyRate +
          "% and a fixed recovery fee of " +
          quoteRecoveryFee +
          " EUR apply. Quote acceptance records customer approval."
        : "Aucun escompte n'est accordé en cas de paiement anticipé. En cas de retard sur une échéance de paiement convenue, des pénalités au taux de " +
          quotePenaltyRate +
          " % seront exigibles, ainsi qu'une indemnité forfaitaire de " +
          quoteRecoveryFee +
          " € pour frais de recouvrement. L’acceptation du devis vaut accord du client.";
    return stripQuoteValidity(ensurePreviewVatReasonInText(quoteDefault, company, invoice, language));
  }
  if (customFooter) return ensurePreviewVatReasonInText(customFooter, company, invoice, language);
  const optionPenaltyRate = String(options.legal_penalty_rate || "").trim();
  const optionRecoveryFee = String(options.legal_recovery_fee || "").trim();
  const optionPenaltyPrefix = String(options.legal_penalty_prefix || "").trim();
  const optionRecoveryPrefix = String(options.legal_recovery_prefix || "").trim();
  const optionDiscountText = String(options.legal_discount_text || "").trim();
  if (optionPenaltyRate || optionRecoveryFee || optionPenaltyPrefix || optionRecoveryPrefix || optionDiscountText) {
    const vatLine = previewLegalVatSentence(company, language, invoice);
    const penaltyPrefix =
      optionPenaltyPrefix ||
      (language === "en"
        ? [vatLine, "In case of late payment, penalties of"].filter(Boolean).join(" ")
        : [
            vatLine,
            "Aucun escompte n'est accordé en cas de paiement anticipé. En cas de retard de paiement, des pénalités au taux de",
          ]
            .filter(Boolean)
            .join(" "));
    const recoveryPrefix =
      optionRecoveryPrefix ||
      (language === "en"
        ? "and a fixed recovery fee of"
        : "seront dues à compter du lendemain de l'échéance, ainsi qu'une indemnité forfaitaire de");
    const discountText =
      optionDiscountText || (language === "en" ? "apply. No early payment discount." : "pour frais de recouvrement.");
    return ensurePreviewVatReasonInText(
      (
        penaltyPrefix +
        " " +
        (optionPenaltyRate || "10") +
        " % " +
        recoveryPrefix +
        " " +
        (optionRecoveryFee || "40") +
        " € " +
        discountText
      ).trim(),
      company,
      invoice,
      language,
    );
  }
  const legalBlock = noteBlocks(invoice?.note).find((block) => looksLikeLegalMention(block));
  if (legalBlock) return ensurePreviewVatReasonInText(legalBlock, company, invoice, language);
  if (invoice?.legal_mentions)
    return ensurePreviewVatReasonInText(String(invoice.legal_mentions), company, invoice, language);
  const vatLine = previewLegalVatSentence(company, language, invoice);
  const penaltyRate = parsePreviewPenaltyRate("", company);
  const recoveryFee = parsePreviewRecoveryFee("", company);
  const discountTerms = String(company?.discount_terms || "").trim();
  const discountText =
    discountTerms && !/^n[ée]ant$/i.test(discountTerms)
      ? "pour frais de recouvrement. Escompte pour paiement anticipé : " + discountTerms + "."
      : "pour frais de recouvrement.";
  return ensurePreviewVatReasonInText(
    [
      vatLine,
      "Aucun escompte n'est accordé en cas de paiement anticipé. En cas de retard de paiement, des pénalités au taux de",
      penaltyRate,
      "% seront dues à compter du lendemain de l'échéance, ainsi qu'une indemnité forfaitaire de",
      recoveryFee,
      "€",
      discountText,
    ]
      .filter(Boolean)
      .join(" "),
    company,
    invoice,
    language,
  );
}

function paymentMethodLabel(value: any): string {
  if (Array.isArray(value)) {
    const labels: string[] = value
      .map((entry) => paymentMethodLabel(entry))
      .filter((label, index, list) => Boolean(label) && list.indexOf(label) === index);
    if (!labels.length) return "Virement bancaire";
    if (labels.length === 1) return labels[0];
    return `${labels.slice(0, -1).join(", ")} ou ${labels[labels.length - 1]}`;
  }
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
  if (["cheque", "chèque", "check"].includes(key) || key.includes("cheque") || key.includes("chèque")) return "Chèque";
  if (["cash", "especes", "espèces"].includes(key) || key.includes("espece") || key.includes("espèce"))
    return "Espèces";
  if (["card", "carte", "carte_bancaire", "cb"].includes(key) || key.includes("carte")) return "Carte bancaire";
  if (["direct_debit", "prelevement", "prélèvement"].includes(key)) return "Prélèvement bancaire";
  if (key === "cesu") return "CESU";
  if (key === "urssaf_aici") return "Prélèvement Urssaf";
  if (key === "payment_app") return "Application de paiement";
  if (key.includes("manuel")) return "Manuel";
  return "Virement bancaire";
}

const publicClientTypes = new Set(["public", "public_sector", "government", "state", "b2g"]);

function transmissionRouteForCustomer(customer: any, company: any) {
  const clientType = String(customer?.client_type || "business")
    .trim()
    .toLowerCase();
  const customerCountry = String(customer?.country_code || customer?.country || "FR")
    .trim()
    .toUpperCase();
  const companyCountry = String(company?.country_code || company?.country || "FR")
    .trim()
    .toUpperCase();
  if (publicClientTypes.has(clientType)) {
    return {
      key: "chorus",
      label: "Canal public",
      description: "Client public : dépôt et suivi via le canal public.",
      actionable: true,
    };
  }
  if (clientType === "individual") {
    return {
      key: "ereporting",
      label: "E-reporting",
      description: "Particulier : pas d'envoi e-invoicing B2B. Suivi déclaratif via e-reporting selon le périmètre.",
      actionable: false,
    };
  }
  if (customerCountry === "FR" && companyCountry === "FR") {
    return {
      key: "seqino",
      label: "Seqino",
      description: "Client entreprise : transmission via Seqino si le connecteur est actif, sinon export classique.",
      actionable: true,
    };
  }
  return {
    key: "ereporting",
    label: "E-reporting",
    description: "Client hors périmètre FR B2B : déclaration e-reporting plutôt qu'envoi e-invoicing B2B.",
    actionable: false,
  };
}

function transmissionPill(status: string | null | undefined): {
  label: string;
  color: "ok" | "warn" | "danger" | "muted" | "info" | "purple";
} {
  const key = String(status || "")
    .trim()
    .toLowerCase();
  const map: Record<string, { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" }> = {
    submitted: { label: "Soumise", color: "info" },
    sent: { label: "Soumise", color: "info" },
    processing: { label: "En traitement", color: "warn" },
    pending: { label: "En traitement", color: "warn" },
    in_progress: { label: "En traitement", color: "warn" },
    accepted: { label: "Acceptée", color: "ok" },
    delivered: { label: "Acceptée", color: "ok" },
    done: { label: "Acceptée", color: "ok" },
    success: { label: "Acceptée", color: "ok" },
    succeeded: { label: "Acceptée", color: "ok" },
    paid: { label: "Acceptée", color: "ok" },
    available: { label: "Disponible", color: "info" },
    rejected: { label: "Rejetée", color: "danger" },
    refused: { label: "Rejetée", color: "danger" },
    failed: { label: "Échec", color: "danger" },
    error: { label: "Échec", color: "danger" },
    blocked: { label: "Échec", color: "danger" },
    queued: { label: "En file", color: "warn" },
    canceled: { label: "Annulée", color: "muted" },
    cancelled: { label: "Annulée", color: "muted" },
    unknown: { label: "Inconnu", color: "muted" },
  };
  return map[key] || { label: key ? key : "Non transmise", color: "muted" };
}

const GENERIC_TRANSMISSION_MESSAGES = new Set([
  "",
  "accepted",
  "failed",
  "ok",
  "pending",
  "processing",
  "queued",
  "rejected",
  "submitted",
  "unknown",
  "soumission enregistree",
  "soumission enregistrée",
  "statut synchronise",
  "statut synchronisé",
]);

function transmissionStatusGroup(status: string | null | undefined) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  if (["accepted", "delivered", "done", "success", "succeeded"].includes(normalized)) return "accepted";
  if (["rejected", "refused"].includes(normalized)) return "rejected";
  if (["failed", "error", "blocked"].includes(normalized)) return "failed";
  if (["submitted", "processing", "queued", "pending", "sent", "in_progress"].includes(normalized)) return "pending";
  return normalized || "none";
}

function transmissionIsBlocking(status: string | null | undefined) {
  const group = transmissionStatusGroup(status);
  return group === "rejected" || group === "failed";
}

function transmissionDisplayMessage(item: any) {
  const raw = String(item?.message || item?.error_message || item?.rejected_reason || item?.reason || "").trim();
  const safe = sanitizeUserFacingApiMessage(raw, 400, "");
  const group = transmissionStatusGroup(item?.status);
  const isGeneric = GENERIC_TRANSMISSION_MESSAGES.has(safe.toLowerCase());
  if (safe && !(isGeneric && transmissionIsBlocking(item?.status))) return safe;
  if (group === "rejected") return "Motif de rejet non fourni par la plateforme.";
  if (group === "failed") return "Motif d'échec non fourni par la plateforme.";
  return safe || item?.external_id || "—";
}

function providerLabel(value: any) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (key === "choruspro" || key === "chorus") return "Canal public";
  if (key === "seqino") return "Seqino";
  if (!key) return "—";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function invoiceVatRows(invoice: any) {
  const rows = new Map<string, number>();
  let hasZeroVatLine = false;
  (invoice?.lines || []).forEach((line: any) => {
    const rate = Number(line?.vat_rate || 0);
    const base = Number(line?.line_total || 0);
    const vat = base * (rate / 100);
    const key = Number.isFinite(rate) ? String(rate) : "0";
    const category = normalizeVatCode(line?.vat_category || (rate === 0 ? "O" : "S"));
    if (rate === 0 || category !== "S" || line?.exemption_reason_code) hasZeroVatLine = true;
    rows.set(key, (rows.get(key) || 0) + vat);
  });
  if (!rows.size && Number(invoice?.total_vat || 0) !== 0) rows.set("TVA", Number(invoice.total_vat || 0));
  return [...rows.entries()].filter(([rate, value]) => Math.abs(value) > 0.004 || (hasZeroVatLine && rate === "0"));
}

const invoicePreviewOverlineClassName =
  "uppercase tracking-[0.14em] text-[#94a3b8] [font-size:var(--pf-document-text-body)] font-extrabold";

function PreviewMetaCell({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="grid h-[58px] min-w-0 grid-rows-[13px_24px] content-center gap-1 overflow-hidden border-b border-[#dbe3ef] px-3 md:border-b-0 md:border-r last:border-r-0">
      <div className={`flex items-center gap-2 ${invoicePreviewOverlineClassName}`}>
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <span className="truncate text-[#0f172a]" style={{ fontSize: "var(--pf-document-text-body)", fontWeight: 900 }}>
        {value}
      </span>
    </div>
  );
}

function PreviewSupportRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 border-b border-[#e6edf7] py-1.5 last:border-b-0 sm:grid-cols-[116px_minmax(0,1fr)] sm:items-start">
      <span
        className="text-[#94a3b8]"
        style={{ fontSize: "var(--pf-document-text-body)", fontWeight: 700, lineHeight: 1.35 }}
      >
        {label}
      </span>
      <span
        className="min-w-0 break-words text-[#334155] [overflow-wrap:anywhere]"
        style={{ fontSize: "var(--pf-document-text-body)", fontWeight: 650, lineHeight: 1.4 }}
      >
        {children}
      </span>
    </div>
  );
}

function PreviewPartyCard({
  title,
  name,
  addressLines,
  email,
  phone,
  identityRows,
  tinted = false,
}: {
  title: string;
  name: React.ReactNode;
  addressLines: string[];
  email?: string | null;
  phone?: string | null;
  identityRows: Array<{ label: string; value: React.ReactNode; mono?: boolean }>;
  tinted?: boolean;
}) {
  const borderColor = tinted ? "#bfdbfe" : "#e2e8f0";
  const headerBg = tinted ? "linear-gradient(135deg,#eff6ff,#dbeafe)" : "linear-gradient(135deg,#f8fafc,#f1f5f9)";
  const iconClassName = "mt-[0.15rem] h-3.5 w-3.5 shrink-0 text-[#b6c5d8]";
  const inlineIconClassName = "h-3.5 w-3.5 shrink-0 text-[#b6c5d8]";

  return (
    <div
      data-preview-party-card
      className={`overflow-hidden rounded-[14px] border bg-white ${tinted ? "shadow-[0_4px_18px_rgba(29,78,216,0.05)]" : ""}`}
      style={{ borderColor, background: tinted ? "#f8fbff" : "#fff" }}
    >
      <div className="flex h-8 items-center border-b px-3.5" style={{ borderColor, background: headerBg }}>
        <div className={invoicePreviewOverlineClassName}>{title}</div>
      </div>
      <div className="flex min-h-[176px] flex-col gap-2 p-3.5">
        <div
          data-document-party-name
          className="text-[var(--pf-document-text-body)] font-extrabold leading-tight tracking-[-0.01em] text-[#0f172a]"
        >
          {name}
        </div>
        <div className="flex-1 space-y-2.5">
          {addressLines.length ? (
            <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 text-[#64748b]">
              <MapPin className={iconClassName} />
              <div className="space-y-1" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                {addressLines.map((line, index) => (
                  <p key={`${title}-address-${index}`}>{line}</p>
                ))}
              </div>
            </div>
          ) : null}
          {email ? (
            <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-2.5">
              <Mail className={inlineIconClassName} />
              <span className="truncate text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                {email}
              </span>
            </div>
          ) : null}
          {phone ? (
            <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-2.5">
              <Phone className={inlineIconClassName} />
              <span className="text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                {phone}
              </span>
            </div>
          ) : null}
          {identityRows.length ? (
            <div
              className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 border-t border-dashed pt-2"
              style={{ borderColor: tinted ? "#bfdbfe" : "#e2e8f0" }}
            >
              <Building2 className={iconClassName} />
              <div className="grid gap-y-1.5" style={{ fontSize: "0.8125rem", lineHeight: 1.4 }}>
                {identityRows.map((row) => (
                  <div
                    key={`${title}-${row.label}`}
                    data-party-identity-row={row.label}
                    className="grid grid-cols-[74px_minmax(0,1fr)] items-baseline gap-1.5"
                  >
                    <span className="text-[0.75rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">
                      {row.label}
                    </span>
                    <span className={`${row.mono ? "font-mono" : ""} min-w-0 break-words font-semibold text-[#334155]`}>
                      {row.value || "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function previewNumber(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function previewLineKind(line: any) {
  return String(line?.line_type || line?.type || "item").toLowerCase();
}

function isPreviewDiscountLine(line: any) {
  const label = String(line?.product_name || line?.designation || line?.name || "").trim();
  const unitPrice = previewNumber(line?.unit_price ?? line?.unit_price_ht ?? line?.price);
  const lineTotal = previewNumber(line?.line_total ?? line?.total_ht ?? unitPrice);
  return /^remise\b/i.test(label) || unitPrice < 0 || lineTotal < 0;
}

function isPreviewGlobalDiscountLine(line: any) {
  const label = String(line?.product_name || line?.designation || line?.name || "").trim();
  return /^remise\s+globale\b/i.test(label);
}

function previewDiscountPercentFromLabel(label: string) {
  const match = label.match(/remise\s+(?:globale\s+)?([\d,.]+)\s*%/i);
  if (!match) return 0;
  const parsed = Number(match[1].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function previewBaseLineTotal(line: any) {
  const quantity = previewNumber(line?.quantity ?? 0);
  const unitPrice = previewNumber(line?.unit_price ?? line?.unit_price_ht ?? line?.price ?? 0);
  return previewNumber(line?.line_total ?? line?.total_ht ?? quantity * unitPrice);
}

function previewBreakLongTokens(value: any) {
  return String(value ?? "").replace(/([^\s]{18})(?=[^\s])/g, "$1\u200b");
}

function previewDisplayLines(sourceLines: any[]) {
  const result: any[] = [];
  sourceLines.forEach((line) => {
    const kind = previewLineKind(line);
    if (kind !== "item" || !isPreviewDiscountLine(line)) {
      result.push({ ...line });
      return;
    }

    if (isPreviewGlobalDiscountLine(line)) {
      result.push({ ...line });
      return;
    }

    const previousItem = [...result].reverse().find((entry) => previewLineKind(entry) === "item");
    if (!previousItem) {
      result.push({ ...line });
      return;
    }

    const label = String(line?.product_name || line?.designation || line?.name || "");
    const discountAmount = Math.abs(previewBaseLineTotal(line));
    previousItem.__previewDiscountAmount = previewNumber(previousItem.__previewDiscountAmount) + discountAmount;
    previousItem.__previewDiscountPercent =
      previewNumber(previousItem.__previewDiscountPercent) || previewDiscountPercentFromLabel(label);
  });
  return result;
}

export function InvoiceDocumentPreview({
  invoice,
  company,
  customer,
  status,
}: {
  invoice: any;
  company: any;
  customer: any;
  status: { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" };
}) {
  const currency = invoice?.currency || "EUR";
  const legalConfig = getLegalConfig();
  const docLabel = typeLabel(invoice).toUpperCase();
  const isQuotePreview = invoice?.type === "quote";
  const previewAccent = isQuotePreview ? "#7c3aed" : "#1d4ed8";
  const previewRule = isQuotePreview
    ? "linear-gradient(90deg,#7c3aed 0%,#6d28d9 62%,#a855f7 100%)"
    : "linear-gradient(90deg,#2563eb 0%,#4f46e5 62%,#0f766e 100%)";
  const documentTitle = previewDocumentTitle(invoice);
  const freeNote = previewFreeNote(invoice, documentTitle);
  const companyAddress = compactAddressLines(
    company?.address_line1 || company?.address,
    company?.address_line2,
    [company?.postal_code, company?.city].filter(Boolean).join(" "),
    company?.country_code || company?.country,
  );
  const customerAddress = compactAddressLines(
    customer?.address_line1 || customer?.address,
    customer?.address_line2,
    [customer?.postal_code, customer?.city].filter(Boolean).join(" "),
  );
  const paid = Math.max(0, Number(invoice?.total_inc_vat || 0) - Number(invoice?.balance_due || 0));
  const vatRows = invoiceVatRows(invoice);
  const visibleLines = previewDisplayLines(Array.isArray(invoice?.lines) ? invoice.lines : []);
  const totalHT = Number(invoice?.total_ex_vat ?? invoice?.total_ht ?? 0);
  const totalTTC = Number(invoice?.total_inc_vat ?? invoice?.total_ttc ?? 0);
  const balanceDue = Number(invoice?.balance_due ?? totalTTC);
  const allowanceHT = Number(
    invoice?.allowance ?? invoice?.totals?.allowance ?? invoice?.template_options?.allowance ?? 0,
  );
  const hasLineDiscounts = visibleLines.some((line: any) => previewNumber(line?.__previewDiscountAmount) > 0);
  const hasDiscounts = hasLineDiscounts || allowanceHT > 0;
  const lineColumns = normalizePreviewLineColumns(invoice?.template_options?.line_columns);
  const showLineNumberColumn = lineColumns.lineNumber;
  const showLineReferenceColumn = lineColumns.reference;
  const showQuantityColumn = lineColumns.quantity;
  const showUnitColumn = lineColumns.unit;
  const showUnitPriceColumn = lineColumns.unitPrice;
  const showVatColumn = lineColumns.vat;
  const showLineDiscountColumn = hasDiscounts && lineColumns.discount;
  const showBaseTotalColumn = lineColumns.baseTotal;
  const showDiscountedTotalColumn = hasDiscounts && lineColumns.discountedTotal;
  const visibleLineColumnCount =
    1 +
    (showLineNumberColumn ? 1 : 0) +
    (showLineReferenceColumn ? 1 : 0) +
    (showQuantityColumn ? 1 : 0) +
    (showUnitColumn ? 1 : 0) +
    (showUnitPriceColumn ? 1 : 0) +
    (showVatColumn ? 1 : 0) +
    (showLineDiscountColumn ? 1 : 0) +
    (showBaseTotalColumn ? 1 : 0) +
    (showDiscountedTotalColumn ? 1 : 0);
  const lineDiscountTotalHT = visibleLines.reduce(
    (sum: number, line: any) => sum + previewNumber(line?.__previewDiscountAmount),
    0,
  );
  const discountTotalHT = Math.max(allowanceHT, lineDiscountTotalHT);
  const subtotalBeforeDiscountHT = totalHT + discountTotalHT;
  const advancePayments = Array.isArray(invoice?.template_options?.advance_payments)
    ? invoice.template_options.advance_payments
    : [];
  const advanceTotalTTC = advancePayments
    .filter((entry: any) => {
      const source = String(entry?.source || "").trim();
      return source !== "requested_advance";
    })
    .reduce((sum: number, entry: any) => sum + previewNumber(entry?.amount_ttc), 0);
  const requestedAdvance = invoice?.type !== "quote" ? invoice?.template_options?.requested_advance : null;
  const requestedAdvanceAmountTTC =
    requestedAdvance && typeof requestedAdvance === "object" ? previewNumber(requestedAdvance?.amount_ttc) : 0;
  const paidWithoutAdvance = Math.max(0, paid - advanceTotalTTC);
  const companySiretDisplay = formatSiretInput(company?.siret || "") || "";
  const companySirenDisplay =
    formatSirenInput(
      company?.siren ||
        digitsOnly(company?.siret || "").slice(0, 9) ||
        digitsOnly(company?.rcs || legalConfig?.rcsNumber || "").slice(0, 9),
    ) || "";
  const companyVatDisplay =
    formatVatNumberInput(company?.vat_number || "") ||
    formatVatNumberInput(legalConfig?.vatNumber || "") ||
    (isCompanyVatFranchise(company) ? "Franchise en base" : "");
  const companyEmailDisplay = firstDocumentContactEmail(
    company?.email_reply_to,
    company?.email,
    legalConfig?.email,
    legalConfig?.supportEmail,
  );
  const companyPhoneDisplay = formatPhoneDisplay(company?.phone || company?.telephone || "");
  const customerSiretDisplay = formatSiretInput(customer?.siret || "") || "";
  const customerSirenDisplay =
    formatSirenInput(customer?.siren || "") || formatSirenInput(digitsOnly(customer?.siret || "").slice(0, 9)) || "";
  const customerVatDisplay = formatVatNumberInput(customer?.vat_number || "") || "";
  const customerEmailDisplay = String(customer?.email || "").trim();
  const customerPhoneDisplay = formatPhoneDisplay(customer?.phone || "");
  const isIndividualCustomer = ["individual", "particulier", "person"].includes(
    String(customer?.client_type || "")
      .trim()
      .toLowerCase(),
  );
  const legalMention = previewLegalMentionText(invoice, company, !isQuotePreview);
  const previewDocumentLanguage = String(invoice?.template_options?.document_language || "fr")
    .trim()
    .toLowerCase()
    .startsWith("en")
    ? "en"
    : "fr";
  const vatCollectionLabel = previewVatCollectionLabel(company, invoice, previewDocumentLanguage);
  const legalOptions =
    invoice?.template_options && typeof invoice.template_options === "object" ? invoice.template_options : {};
  const legalPenaltyRateRaw = String(
    legalOptions.legal_penalty_rate || parsePreviewPenaltyRate(legalMention, company),
  ).trim();
  const legalRecoveryFeeRaw = String(
    legalOptions.legal_recovery_fee || parsePreviewRecoveryFee(legalMention, company),
  ).trim();
  const legalPenaltyRateLabel = /%|taux|bce/i.test(legalPenaltyRateRaw)
    ? legalPenaltyRateRaw
    : `${legalPenaltyRateRaw.replace(".", ",")} %`;
  const legalRecoveryFeeLabel = /€|eur/i.test(legalRecoveryFeeRaw)
    ? legalRecoveryFeeRaw
    : `${legalRecoveryFeeRaw.replace(".", ",")} €`;
  const legalVatSupportLabel =
    vatCollectionLabel ||
    (invoice?.type === "credit_note"
      ? ""
      : previewDocumentLanguage === "en"
        ? "VAT due on payments received"
        : "TVA exigible à l'encaissement");
  const legalSupportRows = [
    !isQuotePreview && hasFacturxArtifact(invoice)
      ? { label: "Factur-X", value: formatFacturxProfileLabel(invoice?.facturx_profile) }
      : null,
    legalVatSupportLabel ? { label: "TVA", value: legalVatSupportLabel } : null,
    invoice?.purchase_order_number ? { label: "Commande", value: invoice.purchase_order_number } : null,
    legalPenaltyRateLabel ? { label: "Pénalités", value: legalPenaltyRateLabel } : null,
    legalRecoveryFeeLabel ? { label: "Indemnité", value: legalRecoveryFeeLabel } : null,
  ].filter(Boolean) as Array<{ label: string; value: React.ReactNode }>;
  const showLegalSupportCard = legalSupportRows.length > 0;
  const companyIdentityRows = [
    { label: "SIREN", value: companySirenDisplay, mono: true },
    { label: "SIRET", value: companySiretDisplay, mono: true },
    { label: "N° TVA", value: companyVatDisplay, mono: true },
  ].filter((item) => Boolean(item.value)) as Array<{ label: string; value: React.ReactNode; mono?: boolean }>;
  const customerIdentityRows =
    customer && !isIndividualCustomer
      ? [
          { label: "SIREN", value: customerSirenDisplay, mono: true },
          { label: "SIRET", value: customerSiretDisplay, mono: true },
          { label: "N° TVA", value: customerVatDisplay, mono: true },
        ].filter((item) => Boolean(item.value))
      : [];
  const deliveryAddressLines = compactAddressLines(
    invoice?.delivery_address || invoice?.template_options?.delivery_address,
  );
  const hasDifferentDeliveryAddress = Boolean(
    (invoice?.delivery_address_differs || invoice?.template_options?.delivery_address_differs) &&
    deliveryAddressLines.length,
  );
  const deliveryLabel = hasDifferentDeliveryAddress
    ? "Adresse de livraison : différente de la facturation"
    : "Adresse de livraison : identique à la facturation";
  const paymentMethod = paymentMethodLabel(
    invoice?.template_options?.payment_methods ||
      invoice?.template_options?.payment_method ||
      invoice?.payment_method ||
      invoice?.payment_terms,
  );
  const operation = operationLabel(invoice?.template_options?.operation_nature || invoice?.operation_nature);
  const paymentBankAccount =
    invoice?.template_options?.payment_bank_account && typeof invoice.template_options.payment_bank_account === "object"
      ? invoice.template_options.payment_bank_account
      : null;

  return (
    <section
      data-testid="invoice-document-preview"
      className="mx-auto w-full max-w-[1100px] overflow-hidden rounded-[20px] bg-white"
      style={{ border: "1px solid #dbe4ef", boxShadow: "0 24px 58px -40px rgba(15,23,42,0.55)" }}
    >
      <div className="h-1" style={{ background: previewRule }} />
      <div className="relative px-5 py-5 sm:px-7 lg:px-8">
        <div
          className="pointer-events-none absolute right-8 top-8 hidden select-none text-[#f8fafc] md:block"
          style={{ fontSize: "3.5rem", fontWeight: 950, letterSpacing: "-0.06em", lineHeight: 0.85 }}
        >
          {status.label.toUpperCase()}
        </div>

        <div className="relative z-10 flex min-h-[116px] flex-col gap-6 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
            {company?.logo_url ? (
              <div className="flex h-[98px] w-[178px] shrink-0 items-center justify-center rounded-xl border border-[#dbe4ef] bg-white p-4 shadow-[0_8px_26px_rgba(15,23,42,0.05)] md:h-[104px] md:w-[190px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={company.logo_url}
                  alt={company?.name || "Logo"}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : (
              <div
                className="flex h-24 w-24 shrink-0 items-center justify-center rounded-2xl text-2xl font-black text-white"
                style={{
                  background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                  boxShadow: "0 12px 26px -16px rgba(29,78,216,0.75)",
                }}
                aria-label="Logo entreprise"
              >
                {initialsFromName(company?.name)}
              </div>
            )}
          </div>
          <div className="text-left md:min-w-[220px] md:text-right">
            <div className={invoicePreviewOverlineClassName}>{docLabel}</div>
            <div
              className="mt-1"
              style={{
                color: previewAccent,
                fontSize: "1.25rem",
                fontWeight: 900,
                letterSpacing: "-0.03em",
                lineHeight: 1,
              }}
            >
              {invoice?.number || status.label || "Brouillon"}
            </div>
            <div data-testid="invoice-detail-status" className="mt-2 flex md:justify-end">
              <StatusPill status={status.color} label={status.label} />
            </div>
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-[#dbeafe] bg-[#f8fbff] px-3 py-1.5 text-[#64748b] md:justify-end">
              <Hash className="h-3.5 w-3.5" />
              <span style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                {invoice?.number ? "Numéro définitif" : "Numéro attribué après création"}
              </span>
            </div>
          </div>
        </div>

        <div className="my-6 h-px bg-gradient-to-r from-[#bfdbfe] via-[#e2e8f0] to-transparent" />

        <div className="space-y-5">
          {documentTitle ? (
            <div
              className="rounded-xl border border-[#cbd5e1] bg-white px-4 py-3 text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.02)]"
              style={{ fontSize: "0.9375rem", fontWeight: 750 }}
            >
              {documentTitle}
            </div>
          ) : null}

          <div
            data-testid="invoice-preview-meta-band"
            className="mx-auto grid w-[calc(100%-4rem)] min-w-0 grid-cols-1 items-stretch overflow-hidden rounded-xl border border-[#dbe3ef] bg-[#f8fafc] shadow-[0_5px_16px_rgba(15,23,42,0.035)] md:grid-cols-4"
          >
            <PreviewMetaCell
              icon={<Calendar className="h-3 w-3" />}
              label={isQuotePreview ? "Date du devis" : "Date d'émission"}
              value={formatDateFr(invoice?.issue_date, "—")}
            />
            <PreviewMetaCell
              icon={<Calendar className="h-3 w-3" />}
              label="Date de prestation"
              value={formatDateFr(invoice?.service_date || invoice?.date_service, "—")}
            />
            <PreviewMetaCell
              icon={<Clock className="h-3 w-3" />}
              label={isQuotePreview ? "Valable jusqu'au" : "Échéance"}
              value={formatDateFr(invoice?.due_date, "—")}
            />
            <PreviewMetaCell
              icon={<ReceiptText className="h-3 w-3" />}
              label="Conditions"
              value={invoice?.payment_terms || "—"}
            />
          </div>
        </div>

        <div className="mx-auto mt-6 grid w-[calc(100%-4rem)] gap-y-4 lg:grid-cols-[minmax(0,1fr)_72px_minmax(0,1fr)] lg:gap-y-0">
          <PreviewPartyCard
            title="Émetteur"
            name={company?.name || "—"}
            addressLines={companyAddress}
            email={companyEmailDisplay}
            phone={companyPhoneDisplay}
            identityRows={companyIdentityRows}
          />

          <div className="hidden items-center justify-center lg:flex">
            <div className="flex h-full flex-col items-center justify-center gap-3 py-5">
              <div className="w-px flex-1 bg-gradient-to-b from-transparent via-[#e2e8f0] to-transparent" />
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e2e8f0] bg-white text-[#cbd5e1] shadow-sm">
                <ChevronRight className="h-4 w-4" />
              </div>
              <div className="w-px flex-1 bg-gradient-to-b from-transparent via-[#e2e8f0] to-transparent" />
            </div>
          </div>

          <PreviewPartyCard
            title={isQuotePreview ? "Devis pour" : "Facturé à"}
            name={customer?.name || invoice?.customer_name || "Client"}
            addressLines={customerAddress.length ? customerAddress : ["Adresse non renseignée"]}
            email={customerEmailDisplay}
            phone={customerPhoneDisplay}
            identityRows={customerIdentityRows}
            tinted
          />
        </div>

        <div className="mt-8">
          <div className="overflow-hidden rounded-t-xl border border-[#dbe3ef] bg-white">
            <table className="w-full min-w-0 table-fixed border-collapse bg-white">
              <colgroup>
                {showLineNumberColumn ? <col style={{ width: 42 }} /> : null}
                {showLineReferenceColumn ? <col style={{ width: 128 }} /> : null}
                <col />
                {showQuantityColumn ? <col style={{ width: 50 }} /> : null}
                {showUnitColumn ? <col style={{ width: 50 }} /> : null}
                {showUnitPriceColumn ? <col style={{ width: 126 }} /> : null}
                {showVatColumn ? <col style={{ width: 76 }} /> : null}
                {showLineDiscountColumn ? <col style={{ width: 76 }} /> : null}
                {showBaseTotalColumn ? <col style={{ width: 138 }} /> : null}
                {showDiscountedTotalColumn ? <col style={{ width: 142 }} /> : null}
              </colgroup>
              <thead>
                <tr className="border-b border-[#bfdbfe] bg-[#eff6ff] text-[#0f172a]">
                  {showLineNumberColumn ? (
                    <th
                      className="w-10 px-3 py-3 text-center"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                      }}
                    >
                      #
                    </th>
                  ) : null}
                  {showLineReferenceColumn ? (
                    <th
                      className="whitespace-nowrap border-r border-[#dbe3ef] px-4 py-3 text-left"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                      }}
                    >
                      Référence
                    </th>
                  ) : null}
                  <th
                    className="px-4 py-3 text-left"
                    style={{
                      fontSize: "0.66rem",
                      fontWeight: 850,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}
                  >
                    Produit / service
                  </th>
                  {showQuantityColumn ? (
                    <th
                      className="px-4 py-3 text-right"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                      }}
                    >
                      Qté
                    </th>
                  ) : null}
                  {showUnitColumn ? (
                    <th
                      className="px-4 py-3 text-right"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                      }}
                    >
                      Unité
                    </th>
                  ) : null}
                  {showUnitPriceColumn ? (
                    <th
                      className="px-4 py-3 text-right"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                      }}
                    >
                      PU HT
                    </th>
                  ) : null}
                  {showVatColumn ? (
                    <th
                      className="px-4 py-3 text-right"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                      }}
                    >
                      TVA
                    </th>
                  ) : null}
                  {showLineDiscountColumn ? (
                    <th
                      className="px-4 py-3 text-right text-[#c2410c]"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                      }}
                    >
                      Remise
                    </th>
                  ) : null}
                  {showBaseTotalColumn ? (
                    <th
                      className="px-4 py-3 text-right"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                      }}
                    >
                      Total HT
                    </th>
                  ) : null}
                  {showDiscountedTotalColumn ? (
                    <th
                      className="px-4 py-3 text-right text-[#c2410c]"
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 850,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                      }}
                    >
                      HT remisé
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {visibleLines.length ? (
                  visibleLines.map((line: any, index: number) => {
                    const kind = String(line?.line_type || line?.type || "product").toLowerCase();
                    const rawLabel =
                      line.product_name ||
                      line.designation ||
                      line.name ||
                      line.description ||
                      line.detail ||
                      `Ligne ${index + 1}`;
                    const rawDetail = line.detail && line.detail !== rawLabel ? line.detail : "";
                    const label = previewBreakLongTokens(rawLabel);
                    const detail = rawDetail ? previewBreakLongTokens(rawDetail) : "";
                    const quantity = Number(line.quantity ?? 0);
                    const unitPrice = Number(line.unit_price ?? line.unit_price_ht ?? line.price ?? 0);
                    const lineTotal = Number(line.line_total ?? line.total_ht ?? quantity * unitPrice);
                    const discountAmount = previewNumber(line.__previewDiscountAmount);
                    const discountPercent =
                      previewNumber(line.__previewDiscountPercent) ||
                      (lineTotal > 0 && discountAmount > 0 ? (discountAmount / lineTotal) * 100 : 0);
                    const discountedTotal = lineTotal - discountAmount;
                    const vatReasonLabel = previewLineVatReasonLabel(line, company, previewDocumentLanguage);
                    const normalizedVatCollectionLabel = vatCollectionLabel
                      .replace(/[.!?]+$/, "")
                      .trim()
                      .toLowerCase();
                    const normalizedLineVatReasonLabel = vatReasonLabel
                      .replace(/[.!?]+$/, "")
                      .trim()
                      .toLowerCase();
                    const showLineVatReasonLabel =
                      Boolean(vatReasonLabel) && normalizedLineVatReasonLabel !== normalizedVatCollectionLabel;
                    const isSectionLine = kind === "section" || kind === "title";
                    if (kind === "comment" || isSectionLine) {
                      return (
                        <tr key={line.id || index} className="border-t border-[#edf2f7]">
                          {showLineNumberColumn ? (
                            <td
                              className="px-3 py-3 text-center text-[#1d4ed8]"
                              style={{ fontSize: "0.72rem", fontWeight: 800 }}
                            >
                              {line.display_number || index + 1}
                            </td>
                          ) : null}
                          <td
                            colSpan={
                              showLineNumberColumn ? Math.max(visibleLineColumnCount - 1, 1) : visibleLineColumnCount
                            }
                            className={`${isSectionLine ? "font-black text-[#1d4ed8]" : "text-[#475569]"} min-w-0 max-w-full px-4 py-3`}
                            style={{
                              fontSize: "0.8125rem",
                              lineHeight: 1.45,
                              maxWidth: 0,
                              minWidth: 0,
                              overflowWrap: "anywhere",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                            }}
                          >
                            <span
                              data-testid={
                                isSectionLine ? "invoice-preview-section-line" : "invoice-preview-comment-line"
                              }
                              className="block min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-all]"
                            >
                              {label}
                            </span>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={line.id || index} className="border-t border-[#edf2f7]">
                        {showLineNumberColumn ? (
                          <td
                            className="px-3 py-3 text-center text-[#1d4ed8]"
                            style={{ fontSize: "0.72rem", fontWeight: 800 }}
                          >
                            {line.display_number || index + 1}
                          </td>
                        ) : null}
                        {showLineReferenceColumn ? (
                          <td
                            className="border-r border-[#e2e8f0] px-4 py-3 text-left text-[#64748b] tabular-nums"
                            style={{ fontSize: "0.76rem", fontWeight: 750, wordBreak: "break-word" }}
                          >
                            {line.reference || "—"}
                          </td>
                        ) : null}
                        <td
                          className="px-4 py-3 text-[#0f172a]"
                          style={{
                            fontSize: "0.83rem",
                            fontWeight: 650,
                            overflowWrap: "anywhere",
                            wordBreak: "break-all",
                          }}
                        >
                          <span className="block min-w-0 max-w-full break-words [overflow-wrap:anywhere] [word-break:break-all]">
                            {label}
                          </span>
                          {detail ? (
                            <div
                              className="mt-1 min-w-0 max-w-full whitespace-pre-wrap break-words text-[#64748b] [overflow-wrap:anywhere] [word-break:break-all]"
                              style={{ fontSize: "0.75rem", fontWeight: 500 }}
                            >
                              {detail}
                            </div>
                          ) : null}
                        </td>
                        {showQuantityColumn ? (
                          <td
                            className="px-4 py-3 text-right text-[#475569] tabular-nums"
                            style={{ fontSize: "0.82rem" }}
                          >
                            {quantity.toLocaleString("fr-FR")}
                          </td>
                        ) : null}
                        {showUnitColumn ? (
                          <td
                            className="px-4 py-3 text-right text-[#475569] tabular-nums"
                            style={{ fontSize: "0.82rem" }}
                          >
                            {line.unit_code || "—"}
                          </td>
                        ) : null}
                        {showUnitPriceColumn ? (
                          <td
                            className="px-2 py-3 text-right text-[#475569] tabular-nums"
                            style={{ fontSize: "0.72rem", overflow: "hidden", whiteSpace: "nowrap" }}
                          >
                            {money(unitPrice, currency)}
                          </td>
                        ) : null}
                        {showVatColumn ? (
                          <td
                            className="px-2 py-3 text-right text-[#475569] tabular-nums"
                            style={{ fontSize: "0.72rem", overflow: "hidden", whiteSpace: "nowrap" }}
                          >
                            {Number(line.vat_rate || 0).toLocaleString("fr-FR")} %
                            {showLineVatReasonLabel ? (
                              <div
                                className="mt-1 text-[#64748b]"
                                style={{ fontSize: "0.66rem", fontWeight: 650, lineHeight: 1.25 }}
                              >
                                {vatReasonLabel}
                              </div>
                            ) : null}
                          </td>
                        ) : null}
                        {showLineDiscountColumn ? (
                          <td
                            className="px-4 py-3 text-right text-[#c2410c] tabular-nums"
                            style={{ fontSize: "0.82rem", fontWeight: 750 }}
                          >
                            {discountAmount > 0
                              ? `${discountPercent.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`
                              : "—"}
                          </td>
                        ) : null}
                        {showBaseTotalColumn ? (
                          <td
                            className="px-2 py-3 text-right text-[#0f172a] tabular-nums"
                            style={{ fontSize: "0.72rem", fontWeight: 800, overflow: "hidden", whiteSpace: "nowrap" }}
                          >
                            {money(lineTotal, currency)}
                          </td>
                        ) : null}
                        {showDiscountedTotalColumn ? (
                          <td
                            className="px-2 py-3 text-right text-[#c2410c] tabular-nums"
                            style={{ fontSize: "0.72rem", fontWeight: 800, overflow: "hidden", whiteSpace: "nowrap" }}
                          >
                            {money(discountedTotal, currency)}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td
                      colSpan={visibleLineColumnCount}
                      className="px-4 py-6 text-center text-[#94a3b8]"
                      style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                    >
                      Aucune ligne de facturation.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_282px]">
          <div />
          <div className="w-full overflow-hidden rounded-b-xl rounded-t-none border border-t-0 border-[#dbe3ef] bg-white shadow-[0_8px_22px_rgba(15,23,42,0.045)]">
            <div
              className="flex justify-between border-b border-[#e2e8f0]/75 bg-[#f8fafc] px-4 py-2.5 text-[#64748b]"
              style={{ fontSize: "0.8125rem", fontWeight: 700 }}
            >
              <span>{hasDiscounts ? "Sous-total HT" : "Total HT"}</span>
              <strong className="text-[#0f172a]">
                {money(hasDiscounts ? subtotalBeforeDiscountHT : totalHT, currency)}
              </strong>
            </div>
            {hasDiscounts ? (
              <div
                className="flex justify-between border-b border-[#e2e8f0]/75 bg-[#f8fafc] px-4 py-2.5 text-[#c2410c]"
                style={{ fontSize: "0.8125rem", fontWeight: 700 }}
              >
                <span>Remises HT</span>
                <strong>- {money(discountTotalHT, currency)}</strong>
              </div>
            ) : null}
            {hasDiscounts ? (
              <div
                className="flex justify-between border-b border-[#e2e8f0]/75 bg-[#f8fafc] px-4 py-2.5 text-[#475569]"
                style={{ fontSize: "0.8125rem", fontWeight: 800 }}
              >
                <span>Total HT</span>
                <strong className="text-[#0f172a]">{money(totalHT, currency)}</strong>
              </div>
            ) : null}
            {vatRows.map(([rate, value]) => (
              <div
                key={rate}
                className="flex justify-between border-b border-[#e2e8f0]/75 bg-[#f8fafc] px-4 py-2.5 text-[#64748b]"
                style={{ fontSize: "0.8125rem", fontWeight: 700 }}
              >
                <span>{rate === "TVA" ? "TVA" : `TVA ${Number(rate).toLocaleString("fr-FR")} %`}</span>
                <span className="tabular-nums">+ {money(value, currency)}</span>
              </div>
            ))}
            {advanceTotalTTC > 0 ? (
              <div
                className="flex justify-between border-b border-[#e2e8f0]/75 bg-white px-4 py-2.5 text-[#1d4ed8]"
                style={{ fontSize: "0.8125rem", fontWeight: 750 }}
              >
                <span>Acompte déjà versé</span>
                <strong>- {money(advanceTotalTTC, currency)}</strong>
              </div>
            ) : null}
            {paidWithoutAdvance > 0 ? (
              <div
                className="flex justify-between border-b border-[#e2e8f0]/75 bg-white px-4 py-2.5 text-[#047857]"
                style={{ fontSize: "0.8125rem", fontWeight: 750 }}
              >
                <span>Déjà réglé</span>
                <strong>- {money(paidWithoutAdvance, currency)}</strong>
              </div>
            ) : null}
            <div className="relative flex items-center justify-between border-b border-[#c7d2fe]/80 bg-gradient-to-br from-[#eef2ff] to-[#e8edff] px-4 py-3 text-[#4f46e5]">
              <div className="absolute inset-y-0 left-0 w-[2px] bg-gradient-to-b from-[#4f46e5] to-[#1d4ed8]" />
              <span style={{ fontWeight: 800 }}>Total TTC</span>
              <strong className="text-[#312e81]" style={{ fontSize: "0.8125rem" }}>
                {money(totalTTC, currency)}
              </strong>
            </div>
            {requestedAdvanceAmountTTC > 0 ? (
              <div
                className="flex justify-between border-b border-[#e2e8f0]/75 bg-white px-4 py-2.5 text-[#1d4ed8]"
                style={{ fontSize: "0.8125rem", fontWeight: 750 }}
              >
                <span>Acompte demandé au devis</span>
                <strong>{money(requestedAdvanceAmountTTC, currency)}</strong>
              </div>
            ) : null}
            {advanceTotalTTC > 0 || paidWithoutAdvance > 0 ? (
              <div className="flex justify-between bg-[#ecfdf5] px-4 py-2.5 text-[#047857]">
                <span style={{ fontWeight: 800 }}>Reste dû</span>
                <strong>{money(balanceDue, currency)}</strong>
              </div>
            ) : null}
          </div>
        </div>

        <div className={showLegalSupportCard ? "mt-8 grid gap-4 md:grid-cols-2" : "mt-8 grid gap-4"}>
          <div
            data-testid="invoice-preview-delivery-payment-card"
            className="rounded-xl border border-[#d6deea] bg-[#f8fbff] p-2.5"
          >
            <div
              className="text-[#2563eb]"
              style={{ fontSize: "0.625rem", fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}
            >
              Paiement
            </div>
            <div className="mt-2 text-[#475569]">
              <PreviewSupportRow label="Livraison">
                {deliveryLabel}
                {hasDifferentDeliveryAddress ? (
                  <span className="mt-1 block whitespace-pre-line font-normal text-[#64748b]">
                    {deliveryAddressLines.join("\n")}
                  </span>
                ) : null}
              </PreviewSupportRow>
              <PreviewSupportRow label="Nature de l’opération">{operation}</PreviewSupportRow>
              <PreviewSupportRow label="Paiement">{paymentMethod}</PreviewSupportRow>
              {paymentBankAccount?.iban ? (
                <PreviewSupportRow label="IBAN">
                  <span className="block text-[#0f172a]" style={{ fontWeight: 850, overflowWrap: "anywhere" }}>
                    {formatIbanInput(paymentBankAccount.iban)}
                  </span>
                </PreviewSupportRow>
              ) : null}
              {paymentBankAccount?.bic ? (
                <PreviewSupportRow label="BIC">
                  <span className="block text-[#0f172a]" style={{ fontWeight: 850, overflowWrap: "anywhere" }}>
                    {formatBicInput(paymentBankAccount.bic)}
                  </span>
                </PreviewSupportRow>
              ) : null}
              {!paymentBankAccount?.iban && !paymentBankAccount?.bic ? (
                <PreviewSupportRow label="IBAN / BIC">Aucun IBAN/BIC renseigné</PreviewSupportRow>
              ) : null}
            </div>
          </div>
          {showLegalSupportCard ? (
            <div
              data-testid="invoice-preview-mentions-card"
              className="rounded-xl border border-[#d6deea] bg-[#f8fbff] p-2.5"
            >
              <div
                className="text-[#2563eb]"
                style={{ fontSize: "0.625rem", fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}
              >
                Mentions légales
              </div>
              <div className="mt-2 text-[#475569]">
                {legalSupportRows.map((row) => (
                  <PreviewSupportRow key={row.label} label={row.label}>
                    {row.value}
                  </PreviewSupportRow>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {freeNote ? (
          <div
            className="mt-5 min-w-0 overflow-hidden rounded-xl border border-[#dbe4ef] bg-white p-4 text-[#475569] break-words [overflow-wrap:anywhere]"
            style={{ fontSize: "0.8125rem", lineHeight: 1.55, wordBreak: "break-word", whiteSpace: "pre-wrap" }}
          >
            {freeNote}
          </div>
        ) : null}

        <div
          className="mt-5 min-w-0 overflow-hidden rounded-xl border border-[#dbe4ef] bg-white p-4 text-[#334155] break-words [overflow-wrap:anywhere] [&_*]:max-w-full [&_*]:break-words"
          style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}
        >
          <div className="mb-2 text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
            Mention légale imprimée
          </div>
          <div className="min-w-0 max-w-full whitespace-pre-line break-words [overflow-wrap:anywhere] [word-break:break-word]">
            {legalMention}
          </div>
        </div>
      </div>
    </section>
  );
}

function RailSection({
  id,
  title,
  children,
  open = true,
  collapsible = false,
  onToggle,
  icon: Icon,
  tone = "slate",
  rightSlot,
  headingTestId,
  withTopBorder = false,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
  open?: boolean;
  collapsible?: boolean;
  onToggle?: () => void;
  icon?: LucideIcon;
  tone?: "blue" | "green" | "amber" | "red" | "purple" | "slate";
  rightSlot?: React.ReactNode;
  headingTestId?: string;
  withTopBorder?: boolean;
}) {
  const tones = {
    blue: { bg: "#dbeafe", text: "#2563eb", headerBg: "#f8fbff", headerBorder: "#dbeafe" },
    green: { bg: "#dcfce7", text: "#059669", headerBg: "#f8fffb", headerBorder: "#dcfce7" },
    amber: { bg: "#fef3c7", text: "#d97706", headerBg: "#fffdf7", headerBorder: "#fde68a" },
    red: { bg: "#fee2e2", text: "#dc2626", headerBg: "#fffafa", headerBorder: "#fecaca" },
    purple: { bg: "#ede9fe", text: "#7c3aed", headerBg: "#fbfaff", headerBorder: "#ddd6fe" },
    slate: { bg: "#f1f5f9", text: "#64748b", headerBg: "#f8fafc", headerBorder: "#e2e8f0" },
  }[tone];
  const heading = (
    <div data-testid={headingTestId} className="flex min-w-0 items-center gap-2.5">
      {Icon ? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: tones.bg }}>
          <Icon className="h-3.5 w-3.5" style={{ color: tones.text }} />
        </span>
      ) : null}
      <h3 className="pf-invoice-title truncate text-[#0f172a]">{title}</h3>
    </div>
  );

  if (!collapsible) {
    return (
      <section id={id} className="pf-invoice-rail-section last:border-b-0">
        <div
          className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
          style={{ background: tones.headerBg, borderColor: tones.headerBorder }}
        >
          {heading}
          {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
        </div>
        <div className="mt-3 space-y-2.5">{children}</div>
      </section>
    );
  }

  return (
    <section id={id} className={`border-b border-[#eef2f7] last:border-b-0 ${withTopBorder ? "border-t" : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left transition hover:brightness-[0.985]"
        style={{ background: tones.headerBg }}
        aria-expanded={open}
      >
        {heading}
        <span className="flex shrink-0 items-center gap-2">
          {rightSlot}
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-[#94a3b8] transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </span>
      </button>
      {open ? <div className="space-y-2.5 px-4 pb-5 pt-1.5">{children}</div> : null}
    </section>
  );
}

function RailRow({ label, value, nowrap = false }: { label: string; value: React.ReactNode; nowrap?: boolean }) {
  return (
    <div className="pf-invoice-rail-row">
      <span className={`pf-invoice-rail-label ${nowrap ? "pf-invoice-rail-label--nowrap" : ""}`}>{label}</span>
      <span className={`pf-invoice-rail-value ${nowrap ? "pf-invoice-rail-value--nowrap" : ""}`}>{value}</span>
    </div>
  );
}

function InvoicePaymentMetrics({
  total,
  paid,
  due,
  last,
}: {
  total: React.ReactNode;
  paid: React.ReactNode;
  due: React.ReactNode;
  last: React.ReactNode;
}) {
  const metrics = [
    { label: "Total TTC", value: total },
    { label: "Déjà réglé", value: paid },
    { label: "Reste dû", value: due },
    { label: "Dernier paiement", value: last },
  ];

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <div key={metric.label} className="min-w-0 rounded-2xl border border-[#e2e8f0] bg-white px-3 py-2.5">
          <div className="truncate text-[#94a3b8]" style={{ fontSize: "0.72rem", fontWeight: 780 }}>
            {metric.label}
          </div>
          <div
            className="mt-1 min-w-0 break-words text-right text-[#0f172a]"
            style={{ fontSize: "0.86rem", fontWeight: 850, fontVariantNumeric: "tabular-nums" }}
          >
            {metric.value}
          </div>
        </div>
      ))}
    </div>
  );
}

type ClientHistoryTone = "green" | "amber" | "blue" | "purple" | "red" | "slate";

const clientHistoryToneMap: Record<ClientHistoryTone, { bg: string; dot: string; text: string; border: string }> = {
  green: { bg: "#ecfdf5", dot: "#10b981", text: "#047857", border: "#bbf7d0" },
  amber: { bg: "#fffbeb", dot: "#f59e0b", text: "#b45309", border: "#fde68a" },
  blue: { bg: "#eff6ff", dot: "#3b82f6", text: "#1d4ed8", border: "#bfdbfe" },
  purple: { bg: "#f5f3ff", dot: "#8b5cf6", text: "#6d28d9", border: "#ddd6fe" },
  red: { bg: "#fff1f2", dot: "#ef4444", text: "#b91c1c", border: "#fecaca" },
  slate: { bg: "#f8fafc", dot: "#94a3b8", text: "#475569", border: "#e2e8f0" },
};

function transmissionHistoryTone(status: string | null | undefined): ClientHistoryTone {
  const group = transmissionStatusGroup(status);
  if (group === "accepted") return "green";
  if (group === "rejected" || group === "failed") return "red";
  if (group === "pending") return "blue";
  return "slate";
}

function ClientHistoryItem({
  tone,
  title,
  detail,
  date,
  isLast = false,
}: {
  tone: ClientHistoryTone;
  title: string;
  detail?: React.ReactNode;
  date?: React.ReactNode;
  isLast?: boolean;
}) {
  const palette = clientHistoryToneMap[tone];
  return (
    <div className="relative flex gap-3">
      {!isLast ? (
        <span className="absolute left-[10px] top-[22px] h-[calc(100%-12px)] w-px bg-[#edf2f7]" aria-hidden="true" />
      ) : null}
      <span
        className="relative z-10 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: palette.bg, border: `1px solid ${palette.border}` }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: palette.dot }} />
      </span>
      <div className="min-w-0 pb-4">
        <div className="pf-invoice-title text-[#0f172a]">{title}</div>
        {detail ? <div className="pf-invoice-caption mt-0.5 text-[#94a3b8]">{detail}</div> : null}
        {date ? (
          <div className="mt-0.5 font-mono text-[#c8d3e8]" style={{ fontSize: "0.68rem", lineHeight: 1.3 }}>
            {date}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ClientMiniStat({
  label,
  value,
  tone = "blue",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "blue" | "green";
}) {
  const palette =
    tone === "green"
      ? { bg: "#ecfdf5", text: "#059669", border: "#bbf7d0" }
      : { bg: "#f8fafc", text: "#0f172a", border: "#e2e8f0" };
  return (
    <div
      className="rounded-xl border px-3 py-2.5 text-center"
      style={{ background: palette.bg, borderColor: palette.border }}
    >
      <div className="pf-invoice-overline text-[#94a3b8]">{label}</div>
      <div className="pf-invoice-value mt-1 text-[#0f172a]" style={{ color: palette.text }}>
        {value}
      </div>
    </div>
  );
}

type InvoiceHistoryEvent = {
  key: string;
  tone: ClientHistoryTone;
  title: string;
  detail?: React.ReactNode;
  date?: React.ReactNode;
};

function invoiceHistoryEvents({
  invoice,
  customer,
  company,
  latestTransmission,
  lastPayment,
  documentLabelLower,
}: {
  invoice: any;
  customer: any;
  company: any;
  latestTransmission?: any;
  lastPayment?: any;
  documentLabelLower: string;
}): InvoiceHistoryEvent[] {
  const clientEmail = String(customer?.email || invoice?.customer_email || "").trim();
  const emailEvents = Array.isArray(invoice?.email_events) ? invoice.email_events : [];
  const latestEmailEvent = emailEvents.find((event: any) => String(event?.type || "") === "invoice") || emailEvents[0];
  const emailSentAt = latestEmailEvent?.sent_at || latestEmailEvent?.created_at || invoice?.sent_at || null;
  const latestEmailDeliveryMode = String(latestEmailEvent?.delivery_mode || "").toLowerCase();
  const latestEmailStatus = String(latestEmailEvent?.status || "").toLowerCase();
  const latestEmailIsLogOnly = latestEmailDeliveryMode === "log_only" || latestEmailStatus === "log_only";
  const latestEmailProof = emailDeliveryProof(latestEmailEvent);
  const reminderCount = Number(invoice?.reminder_count || 0);
  const reminderAt = invoice?.last_reminder_at || null;
  const createdAt = invoice?.created_at || invoice?.issue_date || null;
  const actorLabel = company?.name ? `Par ${company.name}` : "Par votre équipe";
  const sentTitle = documentLabelLower === "avoir" ? "Avoir envoyé" : "Facture envoyée";
  const createdTitle = documentLabelLower === "avoir" ? "Avoir créé" : "Facture créée";
  const latestTransmissionPill = transmissionPill(latestTransmission?.status);
  const latestTransmissionMessage = latestTransmission ? transmissionDisplayMessage(latestTransmission) : "";

  return [
    lastPayment
      ? {
          key: "payment",
          tone: "green" as ClientHistoryTone,
          title: "Paiement reçu",
          detail: `${money(lastPayment.amount || 0, invoice?.currency || "EUR")} encaissé`,
          date: formatDateTimeFr(lastPayment.date || lastPayment.created_at, "—"),
        }
      : null,
    reminderAt || reminderCount > 0
      ? {
          key: "reminder",
          tone: "amber" as ClientHistoryTone,
          title: "Rappel envoyé",
          detail: `Par email${clientEmail ? ` · ${clientEmail}` : ""}`,
          date: reminderAt ? formatDateTimeFr(reminderAt, "—") : `${reminderCount} relance(s)`,
        }
      : null,
    latestTransmission
      ? {
          key: "transmission",
          tone: transmissionHistoryTone(latestTransmission.status),
          title: `Transmission ${latestTransmissionPill.label.toLowerCase()}`,
          detail:
            latestTransmissionMessage && latestTransmissionMessage !== "—"
              ? latestTransmissionMessage
              : providerLabel(latestTransmission.provider_slug),
          date: formatDateTimeFr(latestTransmission.created_at, "—"),
        }
      : null,
    emailSentAt
      ? {
          key: "sent",
          tone:
            latestEmailProof.status === "danger"
              ? ("red" as ClientHistoryTone)
              : latestEmailIsLogOnly
                ? ("amber" as ClientHistoryTone)
                : ("purple" as ClientHistoryTone),
          title: latestEmailProof.isFailure
            ? "Email en échec"
            : latestEmailIsLogOnly
              ? "Email journalisé"
              : latestEmailProof.shortLabel || sentTitle,
          detail: latestEmailIsLogOnly
            ? "Canal email non configuré : aucun email n'a été envoyé"
            : latestEmailProof.title && latestEmailProof.status !== "muted"
              ? latestEmailProof.title
              : latestEmailStatus === "sent"
                ? "Email de livraison confirmé"
                : latestEmailStatus === "queued"
                  ? "Email en cours d'envoi"
                  : latestEmailStatus === "failed"
                    ? sanitizeUserFacingApiMessage(
                        latestEmailEvent?.error,
                        400,
                        "Configuration email à corriger avant un nouvel envoi",
                      )
                    : latestTransmission
                      ? `Transmission ${providerLabel(latestTransmission.provider_slug)}`
                      : "Envoi enregistré",
          date: formatDateTimeFr(latestEmailProof.date || emailSentAt, "—"),
        }
      : null,
    createdAt
      ? {
          key: "created",
          tone: "slate" as ClientHistoryTone,
          title: createdTitle,
          detail: actorLabel,
          date: formatDateTimeFr(createdAt, "—"),
        }
      : null,
  ].filter(Boolean) as InvoiceHistoryEvent[];
}

function InvoiceClientHistoryPanel({
  invoice,
  customer,
  customerSummary,
}: {
  invoice: any;
  customer: any;
  customerSummary: any;
}) {
  const clientName = customer?.name || invoice?.customer_name || "Client";
  const clientEmail = String(customer?.email || invoice?.customer_email || "").trim();
  const clientInitials = initialsFromName(clientName);
  const clientId = String(customer?.id || invoice?.customer_id || "");
  const clientStats = customerSummary?.stats || {};
  const invoiceCount = Number(clientStats?.invoice_count ?? customer?.invoice_count ?? 1);
  const revenueValue = Number(clientStats?.total_revenue ?? customer?.total_revenue ?? invoice?.total_inc_vat ?? 0);
  const [clientInvoicesOpen, setClientInvoicesOpen] = useState(false);
  const [clientInvoices, setClientInvoices] = useState<any[]>([]);
  const [clientInvoicesLoading, setClientInvoicesLoading] = useState(false);
  const [clientInvoicesError, setClientInvoicesError] = useState<string | null>(null);
  const [clientInvoicesPage, setClientInvoicesPage] = useState(1);
  const [clientInvoicesPageSize, setClientInvoicesPageSize] = usePersistedListPageSize(
    "pixfacture.clientInvoices.pageSize.v1",
  );
  const visibleClientInvoices = useMemo(
    () => paginateList(clientInvoices, clientInvoicesPage, clientInvoicesPageSize),
    [clientInvoices, clientInvoicesPage, clientInvoicesPageSize],
  );

  useEffect(() => {
    if (!clientInvoicesOpen || !clientId) return;
    let cancelled = false;
    setClientInvoicesLoading(true);
    setClientInvoicesError(null);
    setClientInvoicesPage(1);

    rawApi(`/api/invoices?customer_id=${encodeURIComponent(clientId)}&limit=200&offset=0`)
      .then(async (res) => {
        const payload = await res.json().catch(() => []);
        if (!res.ok) throw payload;
        if (!cancelled) {
          const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
          setClientInvoices(items);
        }
      })
      .catch((err) => {
        if (!cancelled) setClientInvoicesError(formatApiError(err, "Liste des factures indisponible."));
      })
      .finally(() => {
        if (!cancelled) setClientInvoicesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clientId, clientInvoicesOpen]);

  return (
    <section className="pf-invoice-rail-section">
      <div className="pf-invoice-overline mb-3 text-[#94a3b8]">Client</div>

      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#10b981] text-white shadow-sm"
          style={{ fontSize: "0.75rem", fontWeight: 700 }}
        >
          {clientInitials}
        </span>
        <div className="min-w-0">
          {clientId ? (
            <Link
              to={`/app/customers/${clientId}`}
              className="block truncate text-[#0f172a] transition hover:text-[#4f46e5] hover:underline hover:underline-offset-2"
              title={`Ouvrir la fiche client ${clientName}`}
              style={{ fontSize: "0.875rem", fontWeight: 680 }}
            >
              {clientName}
            </Link>
          ) : (
            <div className="truncate text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 680 }}>
              {clientName}
            </div>
          )}
          <div className="pf-invoice-caption truncate text-[#4f46e5]">{clientEmail || "Email non renseigné"}</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <ClientMiniStat label="Factures" value={Number.isFinite(invoiceCount) ? invoiceCount : "—"} />
        <ClientMiniStat label="CA total" value={money(revenueValue, invoice?.currency || "EUR")} tone="green" />
      </div>

      <button
        type="button"
        onClick={() => setClientInvoicesOpen(true)}
        disabled={!clientId}
        className="mt-7 flex h-8 w-full items-center justify-center gap-1.5 rounded-full bg-[#eef2ff] px-3 text-[#4f46e5] transition hover:bg-[#e0e7ff] disabled:opacity-45"
        style={{ marginTop: 24, fontSize: "0.75rem", fontWeight: 700 }}
      >
        <FileText className="h-3 w-3" /> Voir les factures
      </button>

      {clientInvoicesOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]/45 px-4 py-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={`Factures de ${clientName}`}
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Fermer la liste des factures"
            onClick={() => setClientInvoicesOpen(false)}
          />
          <div className="relative z-10 flex max-h-[min(86vh,760px)] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-[#dbe4ef] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.28)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#eef2f7] px-5 py-4">
              <div className="min-w-0">
                <div className="text-[#0f172a]" style={{ fontSize: "0.95rem", fontWeight: 850 }}>
                  Factures du client
                </div>
                <div className="mt-0.5 truncate text-[#64748b]" style={{ fontSize: "0.78rem", fontWeight: 560 }}>
                  {clientName} · {Number.isFinite(invoiceCount) ? invoiceCount : clientInvoices.length} facture
                  {(Number.isFinite(invoiceCount) ? invoiceCount : clientInvoices.length) > 1 ? "s" : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setClientInvoicesOpen(false)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#e2e8f0] bg-white text-[#64748b] transition hover:bg-[#f8fafc] hover:text-[#0f172a]"
                aria-label="Fermer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {clientInvoicesLoading ? (
                <div className="px-5 py-10 text-center text-[#94a3b8]" style={{ fontSize: "0.82rem", fontWeight: 650 }}>
                  Chargement des factures...
                </div>
              ) : clientInvoicesError ? (
                <div
                  className="m-5 rounded-xl border border-[#fecaca] bg-[#fff7f7] px-4 py-3 text-[#991b1b]"
                  style={{ fontSize: "0.8rem", fontWeight: 700 }}
                >
                  {clientInvoicesError}
                </div>
              ) : clientInvoices.length ? (
                <div className="divide-y divide-[#eef2f7]">
                  {visibleClientInvoices.map((item) => {
                    const itemStatus = statusMap[String(item?.status || "").toLowerCase()] || {
                      label: item?.status || "-",
                      color: "muted" as const,
                    };
                    return (
                      <Link
                        key={item?.id || item?.number}
                        to={`/app/invoices/${item?.id}`}
                        onClick={() => setClientInvoicesOpen(false)}
                        className="grid gap-3 px-5 py-3.5 transition hover:bg-[#f8fafc] sm:grid-cols-[minmax(0,1fr)_120px_110px_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[#0f172a]" style={{ fontSize: "0.84rem", fontWeight: 820 }}>
                            {item?.number || "Facture brouillon"}
                          </div>
                          <div className="truncate text-[#94a3b8]" style={{ fontSize: "0.72rem", fontWeight: 600 }}>
                            Émise le {formatDateFr(item?.issue_date, "-")}
                          </div>
                        </div>
                        <div className="text-[#0f172a]" style={{ fontSize: "0.8rem", fontWeight: 820 }}>
                          {money(Number(item?.total_inc_vat || 0), item?.currency || invoice?.currency || "EUR")}
                        </div>
                        <StatusPill color={itemStatus.color} label={itemStatus.label} />
                        <ExternalLink className="hidden h-3.5 w-3.5 justify-self-end text-[#2563eb] sm:block" />
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="px-5 py-10 text-center text-[#94a3b8]" style={{ fontSize: "0.82rem", fontWeight: 650 }}>
                  Aucune autre facture à afficher.
                </div>
              )}
            </div>

            {clientInvoices.length > 10 ? (
              <ListPagination
                page={clientInvoicesPage}
                totalItems={clientInvoices.length}
                pageSize={clientInvoicesPageSize}
                pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                itemLabel="facture"
                onPageChange={setClientInvoicesPage}
                onPageSizeChange={(nextPageSize) => {
                  setClientInvoicesPage(1);
                  setClientInvoicesPageSize(nextPageSize);
                }}
                pageSizeAriaLabel="Factures client par page"
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
function InvoiceHistoryTimeline({
  invoice,
  customer,
  company,
  latestTransmission,
  lastPayment,
  documentLabelLower,
  open = true,
  onToggle,
}: {
  invoice: any;
  customer: any;
  company: any;
  latestTransmission?: any;
  lastPayment?: any;
  documentLabelLower: string;
  open?: boolean;
  onToggle?: () => void;
}) {
  const events = invoiceHistoryEvents({
    invoice,
    customer,
    company,
    latestTransmission,
    lastPayment,
    documentLabelLower,
  });

  return (
    <RailSection
      id="invoice-rail-history"
      title="Historique"
      icon={Clock}
      tone="blue"
      headingTestId="invoice-history-heading"
      withTopBorder
      collapsible
      open={open}
      onToggle={onToggle}
    >
      <div className="invoice-history-scrollbar max-h-72 space-y-0 overflow-y-auto pr-1">
        {events.length ? (
          events.map((event, index) => (
            <ClientHistoryItem
              key={event.key}
              tone={event.tone}
              title={event.title}
              detail={event.detail}
              date={event.date}
              isLast={index === events.length - 1}
            />
          ))
        ) : (
          <div className="pf-invoice-caption rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-3 text-[#64748b]">
            Aucun événement client encore enregistré.
          </div>
        )}
      </div>
    </RailSection>
  );
}

type LifecycleStepState = "done" | "active" | "pending";

function lifecycleStepClass(state: LifecycleStepState) {
  if (state === "done") return { bg: "#10b981", text: "#047857", line: "#10b981", soft: "#ecfdf5" };
  if (state === "active") return { bg: "#2563eb", text: "#1d4ed8", line: "#dbeafe", soft: "#eff6ff" };
  return { bg: "#cbd5e1", text: "#94a3b8", line: "#e2e8f0", soft: "#f8fafc" };
}

function transmissionCountsAsSent(latestTransmission?: any) {
  if (!latestTransmission) return false;
  const status = String(latestTransmission?.status || "").toLowerCase();
  return !["failed", "rejected", "refused", "blocked", "error"].includes(status);
}

function getInvoiceLifecycleSteps(invoice: any, latestTransmission?: any, paymentsEnabled = true) {
  const normalized = String(invoice?.status || "draft").toLowerCase();
  const hasBalance = invoice?.balance_due !== undefined && invoice?.balance_due !== null;
  const paid = normalized === "paid" || (normalized !== "draft" && hasBalance && Number(invoice.balance_due) <= 0);
  const sent = Boolean(
    invoice?.sent_at ||
    transmissionCountsAsSent(latestTransmission) ||
    ["sent", "partial", "paid", "overdue"].includes(normalized),
  );
  const waiting = sent && !paid;

  const steps: Array<{
    label: string;
    detail: string;
    icon: LucideIcon;
    state: LifecycleStepState;
  }> = [
    {
      label: "Créée",
      detail: formatDateFr(invoice?.issue_date, "Brouillon"),
      icon: FileText,
      state: normalized === "draft" ? "active" : "done",
    },
    {
      label: "Envoyée",
      detail: invoice?.sent_at ? formatDateFr(invoice.sent_at, "—") : sent ? "Envoyée" : "À envoyer",
      icon: Send,
      state: sent ? "done" : normalized === "draft" ? "pending" : "active",
    },
    {
      label: "En attente",
      detail: paid ? "Soldée" : formatDateFr(invoice?.due_date, "Échéance à suivre"),
      icon: Clock,
      state: paid ? "done" : waiting || normalized === "overdue" ? "active" : "pending",
    },
  ];
  if (paymentsEnabled) {
    steps.push({
      label: "Payée",
      detail: paid
        ? "Règlement reçu"
        : money(invoice?.balance_due || invoice?.total_inc_vat || 0, invoice?.currency || "EUR"),
      icon: CheckCircle2,
      state: paid ? "done" : "pending",
    });
  }
  return steps;
}

function InvoiceLifecycleActionCard({
  invoice,
  latestTransmission,
  paymentsEnabled,
}: {
  invoice: any;
  latestTransmission?: any;
  paymentsEnabled: boolean;
}) {
  const steps = getInvoiceLifecycleSteps(invoice, latestTransmission, paymentsEnabled);

  return (
    <div className="h-full bg-white px-1 py-1">
      <div className="flex h-full flex-col justify-center">
        <div className={`grid gap-2 ${paymentsEnabled ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
          {steps.map((step, index) => {
            const Icon = step.icon;
            const palette = lifecycleStepClass(step.state);
            const connectorColor = step.state === "done" ? palette.bg : "#e2e8f0";
            return (
              <div key={step.label} className="relative flex min-w-0 items-center gap-2">
                {index < steps.length - 1 ? (
                  <span
                    className="pointer-events-none absolute top-3 hidden h-px sm:block"
                    style={{ left: "1.5rem", right: "-0.5rem", background: connectorColor }}
                    aria-hidden="true"
                  />
                ) : null}
                <span
                  className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-4 ring-white"
                  style={{ background: palette.soft, color: palette.bg }}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="relative z-10 min-w-0 bg-white pr-1">
                  <span className="pf-invoice-title block truncate text-[#0f172a]">{step.label}</span>
                  <span
                    className="mt-0.5 block truncate"
                    style={{ color: palette.text, fontSize: "0.68rem", fontWeight: 650 }}
                  >
                    {step.detail}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function InvoiceDetailToolbar({
  invoice,
  status,
  accountingReadiness,
  documentLabel,
  isDraft,
  canDuplicate,
  actionBusy,
  issueProgress,
  liveActionsDisabled,
  onIssue,
  onDuplicate,
}: {
  invoice: any;
  status: { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" };
  accountingReadiness?: any;
  documentLabel: string;
  isDraft: boolean;
  canDuplicate: boolean;
  actionBusy: boolean;
  issueProgress: string | null;
  liveActionsDisabled: boolean;
  onIssue: () => void;
  onDuplicate: () => void;
}) {
  const numberLabel = invoice?.number || documentLabel;

  return (
    <div className="border-b border-[#e2e8f0] bg-white px-4 py-3 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            to="/app/invoices"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#94a3b8] transition hover:bg-[#f8fafc] hover:text-[#0f172a]"
            aria-label="Retour aux factures"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <Link
            to="/app/invoices"
            className="text-[#64748b] transition hover:text-[#1d4ed8]"
            style={{ fontSize: "0.8125rem", fontWeight: 560 }}
          >
            Factures
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-[#cbd5e1]" aria-hidden="true" />
          <span className="pf-invoice-title truncate text-[#0f172a]">{numberLabel}</span>
          {invoice ? <StatusPill status={status.color} label={status.label} /> : null}
          {invoice?.accounting_readiness ? (
            <AccountingReadinessPanel readiness={accountingReadiness || invoice.accounting_readiness} compact />
          ) : null}
        </div>

        {invoice ? (
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton
              onClick={() => window.location.assign(`/app/invoices/new?edit_invoice=${invoice.id}`)}
              disabled={!isDraft || actionBusy}
              title={isDraft ? "Modifier le brouillon" : "Une facture émise doit être corrigée par copie ou avoir."}
            >
              <Pencil className="h-3.5 w-3.5" />
              Modifier
            </SecondaryButton>
            <PrimaryButton
              onClick={onIssue}
              disabled={!isDraft || actionBusy || liveActionsDisabled}
              title={liveActionsDisabled ? TRIAL_LIVE_ACTION_MESSAGE : undefined}
            >
              <Send className="h-3.5 w-3.5" />
              {issueProgress ? "Émission..." : "Émettre définitivement"}
            </PrimaryButton>
            <SecondaryButton onClick={onDuplicate} disabled={!canDuplicate || actionBusy}>
              <Copy className="h-3.5 w-3.5" />
              Créer une copie modifiable
            </SecondaryButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function InvoiceLatePaymentAlert({
  invoice,
  canFollowup,
  actionBusy,
  onFollowup,
}: {
  invoice: any;
  canFollowup: boolean;
  actionBusy: boolean;
  onFollowup: () => void;
}) {
  const dueDate = invoice?.due_date ? new Date(invoice.due_date) : null;
  const balanceDue = Math.max(0, Number(invoice?.balance_due || 0));
  const computedDaysLate = dueDate ? Math.max(0, Math.ceil((Date.now() - dueDate.getTime()) / 86400000)) : 0;
  const daysLate = Math.max(0, Number(invoice?.days_overdue || 0) || computedDaysLate);
  const shouldShow = Boolean(balanceDue > 0 && daysLate > 0);
  if (!shouldShow) return null;
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#fecaca] bg-[#fff1f2] px-4 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-[#ef4444]">
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="pf-invoice-title text-[#b91c1c]">
            Paiement en retard{daysLate ? ` de ${daysLate} jour${daysLate > 1 ? "s" : ""}` : ""}
          </div>
          <div className="pf-invoice-caption mt-0.5 text-[#dc2626]">
            Solde dû : {money(balanceDue, invoice?.currency || "EUR")} — relance recommandée
          </div>
        </div>
      </div>
      {canFollowup ? (
        <button
          type="button"
          onClick={onFollowup}
          disabled={actionBusy}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#fecaca] bg-white px-4 text-[#dc2626] transition hover:bg-[#fef2f2] disabled:cursor-not-allowed disabled:opacity-55"
          style={{ fontSize: "0.8125rem", fontWeight: 650 }}
        >
          <Send className="h-3.5 w-3.5" /> Préparer une relance
        </button>
      ) : null}
    </section>
  );
}

type InvoiceActionTone = "blue" | "green" | "amber" | "red" | "slate";
type InvoiceActionPanel = "transmission" | "encaissement" | "avoirs" | "remboursement" | "relances";

type InvoiceNextAction = {
  label: string;
  description: string;
  icon: LucideIcon;
  tone: InvoiceActionTone;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
};

type InvoiceSummaryModule = {
  label: string;
  detail: string;
  icon: LucideIcon;
  tone: InvoiceActionTone;
  onClick: () => void;
  disabled?: boolean;
  actionLabel?: string;
  active?: boolean;
};

const invoiceActionToneMap: Record<
  InvoiceActionTone,
  { bg: string; border: string; text: string; solid: string; solidHover: string; soft: string }
> = {
  blue: { bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8", solid: "#2563eb", solidHover: "#1d4ed8", soft: "#dbeafe" },
  green: {
    bg: "#ecfdf5",
    border: "#bbf7d0",
    text: "#059669",
    solid: "#10b981",
    solidHover: "#059669",
    soft: "#d1fae5",
  },
  amber: {
    bg: "#fffbeb",
    border: "#fde68a",
    text: "#d97706",
    solid: "#f59e0b",
    solidHover: "#d97706",
    soft: "#fef3c7",
  },
  red: { bg: "#fff1f2", border: "#fecaca", text: "#dc2626", solid: "#ef4444", solidHover: "#dc2626", soft: "#fee2e2" },
  slate: {
    bg: "#f8fafc",
    border: "#e2e8f0",
    text: "#475569",
    solid: "#64748b",
    solidHover: "#475569",
    soft: "#f1f5f9",
  },
};

function InvoiceSummaryModuleCard({ module }: { module: InvoiceSummaryModule }) {
  const Icon = module.icon;
  const tone = invoiceActionToneMap[module.tone];
  return (
    <button
      type="button"
      onClick={module.onClick}
      disabled={module.disabled}
      title={module.detail}
      className="pf-invoice-action-card group flex items-center gap-2.5 px-3 py-2 text-left transition hover:-translate-y-0.5 hover:shadow-[0_12px_24px_-22px_rgba(15,23,42,0.8)] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:shadow-none"
      style={{
        background: module.active ? tone.bg : "#ffffff",
        borderColor: module.active ? tone.border : "#dbe4ef",
        boxShadow: module.active ? `inset 0 0 0 1px ${tone.border}` : undefined,
      }}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: tone.bg, color: tone.text }}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="pf-invoice-action-card-title block">{module.label}</span>
        <span className="pf-invoice-action-card-detail mt-0.5 block">{module.detail}</span>
      </span>
      {module.actionLabel ? (
        <span
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 transition group-hover:bg-white"
          style={{
            borderColor: tone.border,
            background: module.active ? "#ffffff" : tone.bg,
            color: tone.text,
            fontSize: "0.72rem",
            fontWeight: 650,
          }}
        >
          {module.actionLabel}
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </button>
  );
}

function InvoiceSidebarActions({ modules }: { modules: InvoiceSummaryModule[] }) {
  if (!modules.length) return null;
  return (
    <section className="pf-invoice-rail-section">
      <div className="grid gap-2">
        {modules.map((module) => (
          <InvoiceSummaryModuleCard key={module.label} module={module} />
        ))}
      </div>
    </section>
  );
}

function InvoiceFinancialSummary({
  invoice,
  nextAction,
  latestTransmission,
  paymentsEnabled,
}: {
  invoice: any;
  nextAction: InvoiceNextAction;
  latestTransmission?: any;
  paymentsEnabled: boolean;
}) {
  const total = Math.abs(Number(invoice?.total_inc_vat || 0));
  const balanceDue = Math.max(0, Number(invoice?.balance_due || 0));
  const paid = Math.max(0, total - balanceDue);
  const showSettlement = paymentsEnabled && String(invoice?.status || "draft").toLowerCase() !== "draft";
  const NextActionIcon = nextAction.icon;
  const nextActionTone = invoiceActionToneMap[nextAction.tone];
  const statItems = [
    { label: "Montant TTC", value: money(total, invoice?.currency || "EUR"), tone: "#0f172a" },
    ...(showSettlement
      ? [
          { label: "Reçu", value: money(paid, invoice?.currency || "EUR"), tone: "#10b981" },
          {
            label: "Solde dû",
            value: money(balanceDue, invoice?.currency || "EUR"),
            tone: balanceDue > 0 ? "#ef4444" : "#10b981",
          },
        ]
      : []),
  ];

  return (
    <section className="pf-invoice-card">
      <div className="border-b border-[#eef2f7] px-4 py-3">
        <div className="grid gap-3 xl:grid-cols-[minmax(280px,0.74fr)_minmax(520px,1.26fr)] xl:items-stretch">
          <button
            type="button"
            onClick={nextAction.onClick}
            disabled={nextAction.disabled}
            className="flex h-full min-h-[72px] w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={{ background: nextActionTone.soft, color: nextActionTone.text }}
            >
              <NextActionIcon className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0">
              <span className="pf-invoice-overline block text-[#94a3b8]">Prochaine action</span>
              <span className="pf-invoice-title mt-0.5 block text-[#0f172a]">
                {nextAction.loading ? "Traitement..." : nextAction.label}
              </span>
              <span className="pf-invoice-caption mt-0.5 block text-[#64748b]">{nextAction.description}</span>
            </span>
          </button>
          <InvoiceLifecycleActionCard
            invoice={invoice}
            latestTransmission={latestTransmission}
            paymentsEnabled={paymentsEnabled}
          />
        </div>
      </div>
      <div className="space-y-4 p-4">
        <div className={`grid gap-3 ${showSettlement ? "sm:grid-cols-3" : "sm:grid-cols-1"}`}>
          {statItems.map((item) => (
            <div key={item.label} className="pf-invoice-amount-card">
              <div className="pf-invoice-overline text-[#94a3b8]">{item.label}</div>
              <div className="pf-invoice-value mt-1 font-mono" style={{ color: item.tone }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function InvoiceActionPopin({
  title,
  icon: Icon,
  tone,
  onClose,
  children,
}: {
  title: string;
  icon: LucideIcon;
  tone: InvoiceActionTone;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const toneStyle = invoiceActionToneMap[tone];
  return (
    <div
      className="fixed inset-0 z-70 flex items-center justify-center bg-[#0f172a]/35 px-4 py-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[88vh] w-full max-w-3xl overflow-hidden rounded-3xl border border-[#dbe4ef] bg-white shadow-[0_30px_80px_-34px_rgba(15,23,42,0.85)]">
        <div className="flex items-center justify-between gap-3 border-b border-[#eef2f7] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
              style={{ background: toneStyle.bg, color: toneStyle.text }}
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
                {title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#dbe4ef] text-[#64748b] transition hover:bg-[#f8fafc] hover:text-[#0f172a]"
            aria-label="Fermer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(88vh-76px)] overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}

const SERVER_DOCUMENT_PREVIEW_WIDTH = 794;
const SERVER_DOCUMENT_PAGE_HEIGHT = 1123;
const SERVER_DOCUMENT_PREVIEW_MIN_HEIGHT = 240;

export function InvoicePreviewFrame({
  children,
  onPrint,
  htmlPreviewPath,
  previewVersion,
}: {
  children: React.ReactNode;
  onPrint: () => void;
  htmlPreviewPath?: string;
  previewVersion?: string | number | null;
}) {
  const [previewZoomPercent, setPreviewZoomPercent] = useState(100);
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null);
  const [htmlPreviewLoading, setHtmlPreviewLoading] = useState(false);
  const [htmlPreviewError, setHtmlPreviewError] = useState<string | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const localPreviewContentRef = useRef<HTMLDivElement | null>(null);
  const previewPageRef = useRef(1);
  const [previewFitScale, setPreviewFitScale] = useState(1);
  const [previewContentHeight, setPreviewContentHeight] = useState(SERVER_DOCUMENT_PAGE_HEIGHT);
  const [previewPage, setPreviewPage] = useState(1);
  const updateZoom = (delta: number) => {
    setPreviewZoomPercent((value) => Math.min(150, Math.max(50, value + delta)));
  };
  const previewScale = previewZoomPercent / 100;
  const effectivePreviewScale = Number((previewScale * previewFitScale).toFixed(3));
  const zoomLabel = `${previewZoomPercent}%`;
  const previewTotalPages = Math.max(1, Math.ceil(previewContentHeight / SERVER_DOCUMENT_PAGE_HEIGHT));
  const previewViewportMaxHeight = Math.max(
    SERVER_DOCUMENT_PREVIEW_MIN_HEIGHT,
    Math.round(Math.min(previewContentHeight, SERVER_DOCUMENT_PAGE_HEIGHT) * effectivePreviewScale + 40),
  );

  const updateServerPreviewMetrics = useCallback(() => {
    const iframe = previewIframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc?.documentElement || !doc.body) return;
    try {
      doc.documentElement.style.overflow = "hidden";
      doc.body.style.overflow = "hidden";
      const page = doc.querySelector(".page") as HTMLElement | null;
      const pageHeight = page ? Math.max(page.scrollHeight, page.offsetHeight, page.getBoundingClientRect().height) : 0;
      const height = Math.ceil(
        pageHeight ||
          Math.max(
            doc.body.scrollHeight,
            doc.body.offsetHeight,
            doc.documentElement.scrollHeight,
            doc.documentElement.offsetHeight,
          ),
      );
      if (Number.isFinite(height) && height > 0) {
        setPreviewContentHeight(Math.max(SERVER_DOCUMENT_PREVIEW_MIN_HEIGHT, height + 2));
      }
    } catch {
      setPreviewContentHeight(SERVER_DOCUMENT_PAGE_HEIGHT);
    }
  }, []);

  const updateLocalPreviewMetrics = useCallback(() => {
    const node = localPreviewContentRef.current;
    if (!node) return;
    const height = Math.ceil(Math.max(node.scrollHeight, node.offsetHeight));
    if (Number.isFinite(height) && height > 0) {
      setPreviewContentHeight(Math.max(SERVER_DOCUMENT_PREVIEW_MIN_HEIGHT, height));
    }
  }, []);

  const goToPreviewPage = useCallback(
    (page: number) => {
      const nextPage = Math.max(1, Math.min(previewTotalPages, page));
      setPreviewPage(nextPage);
      previewContainerRef.current?.scrollTo({
        top: (nextPage - 1) * SERVER_DOCUMENT_PAGE_HEIGHT * effectivePreviewScale,
        behavior: "smooth",
      });
    },
    [effectivePreviewScale, previewTotalPages],
  );

  const syncPreviewPageFromScroll = useCallback(() => {
    const container = previewContainerRef.current;
    if (!container) return;
    const scaledPageHeight = Math.max(1, SERVER_DOCUMENT_PAGE_HEIGHT * effectivePreviewScale);
    const nextPage = Math.max(
      1,
      Math.min(previewTotalPages, Math.floor((container.scrollTop + scaledPageHeight / 2) / scaledPageHeight) + 1),
    );
    setPreviewPage((current) => (current === nextPage ? current : nextPage));
  }, [effectivePreviewScale, previewTotalPages]);

  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return undefined;
    const updateFitScale = () => {
      const style = window.getComputedStyle(container);
      const horizontalPadding =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const availableWidth = Math.max(1, (container.clientWidth || SERVER_DOCUMENT_PREVIEW_WIDTH) - horizontalPadding);
      const availableHeight =
        typeof window === "undefined" ? SERVER_DOCUMENT_PAGE_HEIGHT : Math.max(760, window.innerHeight - 180);
      const widthScale = availableWidth / SERVER_DOCUMENT_PREVIEW_WIDTH;
      const heightScale = availableHeight / SERVER_DOCUMENT_PAGE_HEIGHT;
      setPreviewFitScale(Math.max(0.3, Math.min(1, widthScale, heightScale)));
    };
    updateFitScale();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateFitScale);
      return () => window.removeEventListener("resize", updateFitScale);
    }
    const observer = new ResizeObserver(updateFitScale);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!htmlPreviewPath) {
      setHtmlPreviewUrl(null);
      setHtmlPreviewLoading(false);
      setHtmlPreviewError(null);
      return;
    }
    let active = true;
    let objectUrl = "";
    setHtmlPreviewLoading(true);
    setHtmlPreviewError(null);
    setHtmlPreviewUrl(null);
    setPreviewContentHeight(SERVER_DOCUMENT_PAGE_HEIGHT);
    setPreviewPage(1);
    rawApi(htmlPreviewPath, { headers: { Accept: "text/html" } })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`preview_html_${res.status}`);
        }
        const html = await res.text();
        const baseHref = typeof window !== "undefined" ? `${window.location.origin}/` : "/";
        const htmlWithBase = html.replace("<head>", `<head><base href="${baseHref}">`);
        objectUrl = URL.createObjectURL(new Blob([htmlWithBase], { type: "text/html;charset=utf-8" }));
        if (active) {
          setPreviewContentHeight(1);
          setHtmlPreviewUrl(objectUrl);
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      })
      .catch(() => {
        if (active) setHtmlPreviewError("Aperçu serveur indisponible, aperçu local affiché.");
      })
      .finally(() => {
        if (active) setHtmlPreviewLoading(false);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [htmlPreviewPath, previewVersion]);

  useEffect(() => {
    setPreviewPage((current) => Math.max(1, Math.min(previewTotalPages, current)));
  }, [previewTotalPages]);

  useEffect(() => {
    previewPageRef.current = previewPage;
  }, [previewPage]);

  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;
    container.scrollTop = (previewPageRef.current - 1) * SERVER_DOCUMENT_PAGE_HEIGHT * effectivePreviewScale;
  }, [effectivePreviewScale]);

  useEffect(() => {
    if (htmlPreviewUrl || htmlPreviewLoading) return undefined;
    updateLocalPreviewMetrics();
    const node = localPreviewContentRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateLocalPreviewMetrics);
    observer.observe(node);
    return () => observer.disconnect();
  }, [htmlPreviewLoading, htmlPreviewUrl, updateLocalPreviewMetrics, children]);

  const openPreviewDocument = useCallback(() => {
    if (htmlPreviewUrl && typeof window !== "undefined") {
      window.open(htmlPreviewUrl, "_blank", "noopener,noreferrer");
      return;
    }
    onPrint();
  }, [htmlPreviewUrl, onPrint]);

  return (
    <section className="pf-invoice-card">
      <div className="flex items-center justify-between border-b border-[#eef2f7] bg-[#fbfdff] px-4 py-3">
        <h2 className="pf-invoice-title text-[#475569]">Aperçu du document</h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => updateZoom(-10)}
            disabled={previewZoomPercent <= 50}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-[#475569] transition hover:border-[#dbe4ef] hover:bg-white hover:text-[#0f172a]"
            aria-label="Réduire l'aperçu"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span
            className="inline-flex h-8 min-w-12 items-center justify-center rounded-lg border border-[#dbe4ef] bg-white px-2 text-[#334155]"
            style={{ fontSize: "0.72rem", fontWeight: 760 }}
          >
            {zoomLabel}
          </span>
          <button
            type="button"
            onClick={() => updateZoom(10)}
            disabled={previewZoomPercent >= 150}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-[#475569] transition hover:border-[#dbe4ef] hover:bg-white hover:text-[#0f172a]"
            aria-label="Agrandir l'aperçu"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <span className="mx-1 h-5 w-px bg-[#e2e8f0]" aria-hidden="true" />
          <button
            type="button"
            onClick={() => goToPreviewPage(previewPage - 1)}
            disabled={previewPage <= 1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-[#475569] transition hover:border-[#dbe4ef] hover:bg-white hover:text-[#0f172a] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Page précédente"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span
            className="inline-flex h-8 min-w-[3.25rem] items-center justify-center rounded-lg border border-[#dbe4ef] bg-white px-2 text-[#334155]"
            style={{ fontSize: "0.72rem", fontWeight: 760 }}
          >
            {previewPage}/{previewTotalPages}
          </span>
          <button
            type="button"
            onClick={() => goToPreviewPage(previewPage + 1)}
            disabled={previewPage >= previewTotalPages}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-[#475569] transition hover:border-[#dbe4ef] hover:bg-white hover:text-[#0f172a] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Page suivante"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <span className="mx-1 h-5 w-px bg-[#e2e8f0]" aria-hidden="true" />
          <button
            type="button"
            onClick={onPrint}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#475569] transition hover:bg-white hover:text-[#0f172a]"
            aria-label="Ouvrir le PDF imprimable"
          >
            <Printer className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={openPreviewDocument}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#475569] transition hover:bg-white hover:text-[#0f172a]"
            aria-label="Ouvrir l'aperçu du document"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div
        ref={previewContainerRef}
        onScroll={syncPreviewPageFromScroll}
        className="overflow-auto bg-[#c9d3e3] px-3 py-5 sm:px-5 lg:px-6"
        style={{ maxHeight: previewTotalPages > 1 ? previewViewportMaxHeight : undefined }}
      >
        <div
          className="mx-auto origin-top"
          style={
            {
              width: SERVER_DOCUMENT_PREVIEW_WIDTH,
              maxWidth: "none",
              zoom: effectivePreviewScale,
            } as React.CSSProperties
          }
        >
          {htmlPreviewPath && htmlPreviewLoading ? (
            <div
              className="rounded-2xl border border-[#dbe4ef] bg-white px-5 py-10 text-center text-[#64748b]"
              style={{ fontSize: "0.82rem", fontWeight: 600 }}
            >
              Chargement de l'aperçu...
            </div>
          ) : htmlPreviewPath && htmlPreviewUrl ? (
            <iframe
              ref={previewIframeRef}
              src={htmlPreviewUrl}
              title="Aperçu du document"
              className="block w-full border-0 bg-white"
              referrerPolicy="no-referrer"
              sandbox="allow-same-origin"
              scrolling="no"
              onLoad={updateServerPreviewMetrics}
              style={{ height: `${previewContentHeight}px`, borderRadius: 18, overflow: "hidden" }}
            />
          ) : (
            <>
              {htmlPreviewError ? (
                <div
                  className="mb-3 rounded-xl border border-[#fed7aa] bg-[#fff7ed] px-4 py-3 text-[#9a3412]"
                  style={{ fontSize: "0.78rem", fontWeight: 700 }}
                >
                  {htmlPreviewError}
                </div>
              ) : null}
              <div ref={localPreviewContentRef}>{children}</div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${active ? "bg-[#2563eb] text-white border-[#2563eb] shadow-sm" : "bg-white border-[#e2e8f0] text-[#64748b] hover:bg-[#f8fafc] hover:border-[#cbd5e1]"}`}
    >
      {children}
    </button>
  );
}

function Paginator({ page, totalPages, count, total, label = "facture(s)", onPrev, onNext }: any) {
  return (
    <div className="flex items-center justify-between pt-1">
      <span className="text-[#94a3b8] text-xs">
        {count} {label} sur {total}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          className="h-8 w-8 flex items-center justify-center rounded-lg border border-[#e2e8f0] bg-white hover:bg-[#f8fafc] transition-colors disabled:opacity-40"
          onClick={onPrev}
          disabled={page <= 1}
          aria-label="Page précédente"
        >
          <ChevronLeft className="w-3.5 h-3.5 text-[#64748b]" aria-hidden="true" />
        </button>
        <span className="px-3 py-1.5 text-xs font-medium text-[#475569] tabular-nums">
          {page} / {totalPages}
        </span>
        <button
          className="h-8 w-8 flex items-center justify-center rounded-lg border border-[#e2e8f0] bg-white hover:bg-[#f8fafc] transition-colors disabled:opacity-40"
          onClick={onNext}
          disabled={page >= totalPages}
          aria-label="Page suivante"
        >
          <ChevronRight className="w-3.5 h-3.5 text-[#64748b]" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function readInvoiceSearchFromLocation() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || params.get("search") || "";
}

/* ════════════════════════════════════════════════ LIST ════ */
export function InvoicesListPage({ initialSearch = "" }: { initialSearch?: string } = {}) {
  const { overview } = useCockpit();
  const { capabilities: sessionCapabilities } = useSession({ autoRefresh: false });
  const paymentsEnabledForList = Boolean(sessionCapabilities?.payments_enabled);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const routeInitialSearch = initialSearch.trim();
  const [search, setSearch] = useState(() => routeInitialSearch || readInvoiceSearchFromLocation());
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const pageSize = 10;

  useEffect(() => {
    const query = routeInitialSearch || readInvoiceSearchFromLocation();
    setPage(1);
    setSearch((current) => (current === query ? current : query));
  }, [routeInitialSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      p.set("limit", String(pageSize));
      p.set("offset", String((page - 1) * pageSize));
      if (statusFilter !== "all") p.set("status", statusFilter);
      if (search.trim()) p.set("q", search.trim());
      const res = await rawApi(`/api/invoices?${p.toString()}`);
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(d, res.status, "Impossible de charger les factures."));
      }
      const data = await res.json().catch(() => []);
      setItems(Array.isArray(data) ? data : []);
      setTotalCount(Number(res.headers.get("x-total-count") || "0") || 0);
    } catch (err) {
      setItems([]);
      setError(formatApiError(err, "Impossible de charger les factures."));
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil((totalCount || 0) / pageSize));
  const stats = useMemo(
    () => ({
      currentTotal: items.reduce((s, i) => s + Number(i.total_inc_vat || 0), 0),
      overdueCount: items.filter((i) => i.status === "overdue").length,
      paidCount: items.filter((i) => i.status === "paid").length,
    }),
    [items],
  );
  const invoiceModule = overview?.modules?.invoices;
  const invoiceSummary = invoiceModule?.summary;
  const invoiceFocus = invoiceModule?.focus || null;
  const invoiceOverviewStats = useMemo<ModuleOverviewStat[]>(() => {
    const rows: ModuleOverviewStat[] = [
      {
        label: "Parc factures",
        value: invoiceSummary?.total_count ?? totalCount,
        detail: `${invoiceSummary?.draft_count ?? 0} brouillon(s) encore en attente`,
        icon: <FileText className="w-4 h-4" />,
        tone: "blue",
      },
      {
        label: "Encours ouvert",
        value: money(invoiceSummary?.open_balance_due ?? 0),
        detail: `${invoiceSummary?.pending_count ?? 0} document(s) encore ouverts`,
        icon: <ReceiptText className="w-4 h-4" />,
        tone: "purple",
      },
      {
        label: "Retards",
        value: invoiceSummary?.overdue_count ?? stats.overdueCount,
        detail: money(invoiceSummary?.overdue_amount ?? 0),
        icon: <AlertTriangle className="w-4 h-4" />,
        tone: (invoiceSummary?.overdue_count ?? 0) > 0 ? "red" : "amber",
      },
      {
        label: "Réglées",
        value: invoiceSummary?.paid_count ?? stats.paidCount,
        detail: `Émis ce mois: ${money(invoiceSummary?.invoiced_month ?? 0)}`,
        icon: <Wallet className="w-4 h-4" />,
        tone: "green",
      },
    ];
    return paymentsEnabledForList ? rows : rows.filter((row) => row.label === "Parc factures");
  }, [invoiceSummary, paymentsEnabledForList, stats.overdueCount, stats.paidCount, totalCount]);

  const filters = [
    { value: "all", label: "Toutes" },
    { value: "draft", label: "Brouillons" },
    { value: "pending", label: "En attente" },
    { value: "issued", label: "Émises" },
    { value: "sent", label: "Envoyées" },
    { value: "partial", label: "Partielles" },
    { value: "paid", label: "Payées" },
    { value: "overdue", label: "En retard" },
  ].filter((item) => paymentsEnabledForList || !["partial", "paid", "overdue"].includes(item.value));

  return (
    <div className="pf-invoice-detail">
      <AppPageHeader
        title="Factures"
        breadcrumb="Facturation"
        description="Brouillons, émission, envoi, PDF, lien public et exports disponibles selon votre plan."
        actions={
          <PrimaryButton onClick={() => window.location.assign("/app/invoices/new")}>
            <Plus className="w-3.5 h-3.5" /> Créer une facture
          </PrimaryButton>
        }
      />

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="p-5 lg:p-6"
      >
        <div className="mx-auto w-full max-w-[1500px] space-y-5">
          {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}

          <ModuleOverview
            eyebrow="Cycle facturation"
            title="Le strict utile pour suivre les factures"
            description="Encours réel et prochain dossier à sécuriser."
            stats={invoiceOverviewStats}
            focus={invoiceFocus}
            compact
            focusAction={
              invoiceFocus?.href ? (
                <Link
                  to={invoiceFocus.href}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
                >
                  Ouvrir le dossier prioritaire
                </Link>
              ) : (
                <span className="text-xs leading-relaxed text-[#708197]">
                  Gardez la création en action principale, puis traitez l'encours avec les filtres ci-dessous.
                </span>
              )
            }
          />

          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {filters.map((f) => (
                <FilterChip
                  key={f.value}
                  active={statusFilter === f.value}
                  onClick={() => {
                    setPage(1);
                    setStatusFilter(f.value);
                  }}
                >
                  {f.label}
                </FilterChip>
              ))}
            </div>
            <div className="flex items-center gap-2 px-3 py-2 border border-[#e2e8f0] rounded-lg bg-white max-w-xs w-full lg:w-auto">
              <Search className="w-4 h-4 text-[#94a3b8] flex-shrink-0" />
              <input
                placeholder="Numéro, commande, client…"
                className="outline-none bg-transparent text-[#374151] placeholder:text-[#94a3b8] flex-1 text-sm"
                value={search}
                onChange={(e) => {
                  setPage(1);
                  setSearch(e.target.value);
                }}
              />
            </div>
          </div>

          {loading ? (
            <LoadingCard label="Chargement des factures…" />
          ) : items.length === 0 ? (
            <EmptyCard
              compact
              className="border-dashed border-[#dbe5ef] shadow-none"
              title="Aucune facture"
              description="Créez une facture pour démarrer votre cycle de facturation."
              action={
                <PrimaryButton onClick={() => window.location.assign("/app/invoices/new")}>
                  <Plus className="w-3.5 h-3.5" /> Créer une facture
                </PrimaryButton>
              }
            />
          ) : (
            <>
              <DataTable headers={["Numéro", "Date", "Échéance", "Client", "Statut", "Total TTC"]}>
                {items.map((inv) => (
                  <tr key={inv.id} className="hover:bg-[#f8fafc] transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        to={`/app/invoices/${inv.id}`}
                        className="text-[#2563eb] hover:text-[#1d4ed8] font-semibold text-sm"
                      >
                        {inv.number || inv.id}
                      </Link>
                      <div className="mt-0.5 text-[#94a3b8] text-xs">{typeLabel(inv)}</div>
                      <div className="pf-mobile-row-summary mt-2 flex flex-wrap items-center gap-1.5">
                        <StatusPill
                          color={(statusMap[inv.status] || { color: "muted" }).color}
                          label={(statusMap[inv.status] || { label: inv.status || "—" }).label}
                        />
                        <span className="rounded-full bg-[#f8fafc] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#475569]">
                          {money(inv.total_inc_vat || 0, inv.currency || "EUR")}
                        </span>
                        <span className="rounded-full bg-[#eff6ff] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#1d4ed8]">
                          {inv.customer_name || "Client —"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[#475569] text-sm">{formatDateFr(inv.issue_date, "—")}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className={inv.status === "overdue" ? "text-[#dc2626] font-medium" : "text-[#475569]"}>
                        {formatDateFr(inv.due_date, "—")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#475569] text-sm">{inv.customer_name || "—"}</td>
                    <td className="px-4 py-3">
                      <StatusPill
                        color={(statusMap[inv.status] || { color: "muted" }).color}
                        label={(statusMap[inv.status] || { label: inv.status || "—" }).label}
                      />
                    </td>
                    <td className="px-4 py-3 text-[#0f172a] text-sm font-bold tabular-nums">
                      {money(inv.total_inc_vat || 0, inv.currency || "EUR")}
                    </td>
                  </tr>
                ))}
              </DataTable>
              <Paginator
                page={page}
                totalPages={totalPages}
                count={items.length}
                total={totalCount}
                onPrev={() => setPage((c) => Math.max(1, c - 1))}
                onNext={() => setPage((c) => Math.min(totalPages, c + 1))}
              />
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

/* ════════════════════════════════════════════════ DETAIL ════ */
export function InvoiceDetailPage() {
  const hydrated = useHydrated();
  const { id } = useParams();
  const { user, subscriptionStatus } = useSession({ autoRefresh: false });
  const trialDraftOnly = isTrialSubscription(subscriptionStatus);
  const canWriteInvoices = can(user, "invoices:write");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<{ error: string; href: string; label: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [customer, setCustomer] = useState<any>(null);
  const [capabilities, setCapabilities] = useState<any>(null);
  const paymentsEnabled = Boolean(capabilities?.payments_enabled);
  const [accountEmail, setAccountEmail] = useState("");
  const [publicSettings, setPublicSettings] = useState<any>(null);
  const [customerSummary, setCustomerSummary] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [transmissionStatus, setTransmissionStatus] = useState<any>(null);
  const [openRailSections, setOpenRailSections] = useState<Record<string, boolean>>({});
  const [actionPanel, setActionPanel] = useState<InvoiceActionPanel | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [followupEmailOpen, setFollowupEmailOpen] = useState(false);
  const [followupSending, setFollowupSending] = useState(false);
  const [followupScheduleDraft, setFollowupScheduleDraft] = useState("-2, 3, 10");
  const [followupScheduleEditing, setFollowupScheduleEditing] = useState(false);
  const [followupScheduleSaving, setFollowupScheduleSaving] = useState(false);
  const [creditNoteOpen, setCreditNoteOpen] = useState(false);
  const [creditNoteSubmitting, setCreditNoteSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [issueProgress, setIssueProgress] = useState<string | null>(null);
  const [transmissionBusy, setTransmissionBusy] = useState(false);
  const [issueMissingFields, setIssueMissingFields] = useState<string[]>([]);
  const [actionErrorDetails, setActionErrorDetails] = useState<unknown[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [refundSaving, setRefundSaving] = useState(false);
  const [paymentBusyId, setPaymentBusyId] = useState<string | null>(null);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [paymentForm, setPaymentForm] = useState<any>({
    amount: "",
    method: "virement",
    reference: "",
    date: todayInputDate(),
    settlement_mode: "bank",
    accounting_category: "512 Banque",
    receipt_label: "",
    receipt_url: "",
  });
  const [paymentEditForm, setPaymentEditForm] = useState<any>({
    amount: "",
    method: "virement",
    reference: "",
    date: "",
    settlement_mode: "bank",
    accounting_category: "512 Banque",
    receipt_label: "",
    receipt_url: "",
  });
  const [refundForm, setRefundForm] = useState<any>({
    amount: "",
    method: "virement",
    reference: "",
    date: todayInputDate(),
  });

  const loadDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const detailRes = await rawApi(`/api/cockpit/invoices/${id}`);
      if (!detailRes.ok) {
        const d = await detailRes.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(d, detailRes.status, "Facture introuvable."));
      }
      const payload = await detailRes.json().catch(() => null);
      const iData = payload?.invoice;
      const loadedCustomer = payload?.customer || null;
      setInvoice(iData);
      setCompany(payload?.company || null);
      setCustomer(loadedCustomer);
      let loadedCapabilities: any = null;
      try {
        const meRes = await rawApi("/api/auth/me");
        const mePayload = meRes.ok ? await meRes.json().catch(() => null) : null;
        loadedCapabilities = restrictCapabilitiesForTrial(
          resolveProductCapabilities(mePayload?.capabilities, mePayload?.plan),
          subscriptionStatus,
        );
        setCapabilities(loadedCapabilities);
        setAccountEmail(String(mePayload?.email || "").trim());
      } catch {
        setCapabilities(null);
        setAccountEmail("");
      }
      try {
        const settingsRes = await rawApi("/api/settings");
        const settingsPayload = settingsRes.ok ? await settingsRes.json().catch(() => null) : null;
        setPublicSettings(settingsPayload || null);
      } catch {
        setPublicSettings(null);
      }
      if (loadedCapabilities?.payments_enabled) {
        try {
          const tenantSettingsRes = await rawApi("/api/settings/tenant");
          const tenantSettingsPayload = tenantSettingsRes.ok ? await tenantSettingsRes.json().catch(() => null) : null;
          const dunning = tenantSettingsPayload?.features?.dunning || {};
          setFollowupScheduleDraft(formatFollowupScheduleDaysInput(dunning.schedule_days || iData?.followup_schedule));
        } catch {
          setFollowupScheduleDraft(formatFollowupScheduleDaysInput(iData?.followup_schedule));
        }
      } else {
        setFollowupScheduleDraft(formatFollowupScheduleDaysInput(iData?.followup_schedule));
      }
      setCustomerSummary(null);
      setPaymentForm({
        amount: iData?.balance_due ? Number(iData.balance_due).toFixed(2) : "",
        method: "virement",
        reference: "",
        date: todayInputDate(),
        settlement_mode: "bank",
        accounting_category: "512 Banque",
        receipt_label: "",
        receipt_url: "",
      });
      setRefundForm({
        amount: iData?.refund_balance ? Number(iData.refund_balance).toFixed(2) : "",
        method: "virement",
        reference: "",
        date: todayInputDate(),
      });
      setEditingPaymentId(null);
      setPaymentEditForm({
        amount: "",
        method: "virement",
        reference: "",
        date: "",
        settlement_mode: "bank",
        accounting_category: "512 Banque",
        receipt_label: "",
        receipt_url: "",
      });
      setShare(payload?.share || null);
      setLoading(false);
      const loadedCustomerId = loadedCustomer?.id || iData?.customer_id;
      if (loadedCustomerId) {
        try {
          const summaryRes = await rawApi(`/api/customers/${loadedCustomerId}/summary`);
          setCustomerSummary(summaryRes.ok ? await summaryRes.json().catch(() => null) : null);
        } catch {
          setCustomerSummary(null);
        }
      }
      if (loadedCapabilities?.einvoicing_enabled) {
        try {
          const txRes = await rawApi(`/api/invoices/${id}/pdp-status`);
          setTransmissionStatus(txRes.ok ? await txRes.json().catch(() => null) : null);
        } catch {
          setTransmissionStatus(null);
        }
      } else {
        setTransmissionStatus(null);
      }
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger la facture."));
      setTransmissionStatus(null);
    } finally {
      setLoading(false);
    }
  }, [id, subscriptionStatus]);
  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (action === "email" && canWriteInvoices && !trialDraftOnly) {
      setEmailOpen(true);
    }
    if (canWriteInvoices && paymentsEnabled && !trialDraftOnly && (action === "followup" || action === "relance")) {
      setActionPanel("relances");
    }
    const panel = params.get("panel") || params.get("action");
    if (canWriteInvoices && paymentsEnabled && (panel === "encaissement" || panel === "payment")) {
      setActionPanel("encaissement");
      setOpenRailSections((prev) => ({ ...prev, encaissement: true }));
    }
  }, [canWriteInvoices, hydrated, id, paymentsEnabled, trialDraftOnly]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const run = async (
    label: string | ((result: any) => string),
    cb: () => Promise<any>,
    fallback = "Cette action n'a pas pu être réalisée.",
  ) => {
    setActionBusy(true);
    setError(null);
    setNotice(null);
    setIssueProgress(null);
    setIssueMissingFields([]);
    setActionErrorDetails([]);
    try {
      const result = await cb();
      setNotice(typeof label === "function" ? label(result) : label);
      await loadDetail();
    } catch (err) {
      const fields = (err as any)?.fields;
      const structuredFields = Array.isArray(fields) ? fields.filter((field) => typeof field === "string") : [];
      if (Array.isArray(fields)) {
        setIssueMissingFields(structuredFields);
      }
      const details = (err as any)?.errors;
      if (Array.isArray(details)) {
        setActionErrorDetails(details);
      }
      setError(
        structuredFields.length || (Array.isArray(details) && details.length) ? null : formatApiError(err, fallback),
      );
    } finally {
      setActionBusy(false);
      setIssueProgress(null);
    }
  };
  const issueInvoice = () => {
    if (!canWriteInvoices) return;
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Émettre cette facture ? Un numéro définitif sera attribué et le document ne sera plus un simple brouillon.",
      )
    ) {
      return;
    }
    return run(
      "Émission terminée.",
      async () => {
        setIssueProgress("Préparation de l'émission");
        const result = await api(`/api/invoices/${id}/issue`, { method: "POST" });
        if (result?.job_id) {
          setIssueProgress("Traitement en cours");
        }
        await waitForMaybeJob(result, {
          onUpdate: (payload) => setIssueProgress(describeJobProgress(payload)),
        });
        setIssueProgress("Rechargement du document");
        return result;
      },
      "Émission impossible.",
    );
  };
  const duplicateInvoice = async () => {
    setActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r: any = await api(`/api/invoices/${id}/duplicate`, { method: "POST" });
      if (!r?.id) throw new Error("Duplication incomplète.");
      setNotice("Brouillon créé.");
      window.location.assign(`/app/invoices/new?edit_invoice=${r.id}`);
    } catch (err) {
      setError(formatApiError(err, "Duplication impossible."));
    } finally {
      setActionBusy(false);
    }
  };
  const sendInvoiceEmail = async (payload: InvoiceEmailPayload) => {
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    setEmailSending(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/invoices/${id}/email`, {
        method: "POST",
        body: JSON.stringify({
          to: payload.to,
          cc: payload.cc || null,
          bcc: payload.bcc || null,
          reply_to: payload.reply_to || null,
          subject: payload.subject,
          body: payload.body,
          format: payload.format,
          attach_invoice: payload.attachInvoice,
          copy_sender: payload.copySender,
          include_link: payload.includeLink,
          save_as_default: Boolean(payload.save_as_default),
          save_subject_template: payload.save_subject_template,
          save_body_template: payload.save_body_template,
        }),
      });
      setEmailOpen(false);
      setNotice(emailDeliveryNotice(result, "Email envoyé."));
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Envoi email impossible."));
    } finally {
      setEmailSending(false);
    }
  };
  const saveInvoiceEmailDefault = async (payload: EmailDefaultTemplatePayload) => {
    await api("/api/company/profile", {
      method: "PATCH",
      body: JSON.stringify({
        email_subject_default: payload.subject_template,
        email_body_default: payload.body_template,
      }),
    });
    setCompany((prev: any) => ({
      ...(prev || {}),
      email_subject_default: payload.subject_template,
      email_body_default: payload.body_template,
    }));
  };
  const openFollowupEmail = () => {
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    setFollowupEmailOpen(true);
  };
  const saveFollowupSchedule = async () => {
    const scheduleDays = parseFollowupScheduleDaysInput(followupScheduleDraft);
    if (!scheduleDays.length) {
      setError("Ajoutez au moins une période valide entre -30 et 120 jours, par exemple -2, 3, 10.");
      return;
    }
    setFollowupScheduleSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/settings/tenant", {
        method: "PATCH",
        body: JSON.stringify({
          features: {
            dunning: {
              schedule_days: scheduleDays,
            },
          },
        }),
      });
      setFollowupScheduleDraft(formatFollowupScheduleDaysInput(scheduleDays));
      setFollowupScheduleEditing(false);
      setNotice("Périodes de relance enregistrées.");
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Enregistrement des périodes impossible."));
    } finally {
      setFollowupScheduleSaving(false);
    }
  };
  const sendFollowupEmail = async (payload: InvoiceEmailPayload) => {
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    setFollowupSending(true);
    setActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/invoices/${id}/followup`, {
        method: "POST",
        body: JSON.stringify({
          to: payload.to,
          reply_to: payload.reply_to || null,
          subject: payload.subject,
          body: payload.body,
          include_link: payload.includeLink,
          include_pdf: payload.attachInvoice,
          save_as_default: Boolean(payload.save_as_default),
          save_subject_template: payload.save_subject_template,
          save_body_template: payload.save_body_template,
        }),
      });
      setFollowupEmailOpen(false);
      setActionPanel(null);
      setNotice(emailDeliveryNotice(result, "Relance envoyée.", "Relance en cours d'envoi."));
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Relance impossible."));
    } finally {
      setActionBusy(false);
      setFollowupSending(false);
    }
  };
  const saveInvoiceFollowupDefault = async (payload: EmailDefaultTemplatePayload) => {
    await api("/api/company/profile", {
      method: "PATCH",
      body: JSON.stringify({
        reminder_subject_default: payload.subject_template,
        reminder_body_default: payload.body_template,
      }),
    });
    setCompany((prev: any) => ({
      ...(prev || {}),
      reminder_subject_default: payload.subject_template,
      reminder_body_default: payload.body_template,
    }));
  };
  const createCreditNote = async (payload: CreditNoteCreatePayload) => {
    if (!id) return;
    setCreditNoteSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/invoices/${id}/credit-note/from-lines`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setCreditNoteOpen(false);
      if (result?.id) {
        window.location.assign(`/app/invoices/${result.id}`);
        return;
      }
      setNotice("Avoir créé.");
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Création de l'avoir impossible."));
    } finally {
      setCreditNoteSubmitting(false);
    }
  };
  const submitTransmission = async () => {
    if (!id || !canWriteInvoices || transmissionBusy) return;
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    if (transmissionReconciliationRequired) {
      setNotice("Résultat du dépôt incertain, ne pas renvoyer.");
      return;
    }
    if (chorusRetryUnsupported) {
      setNotice("Corriger puis créer une nouvelle émission. La resoumission Chorus n’est pas disponible ici.");
      return;
    }
    if (latestTransmission && !latestTransmissionBlocked) {
      setNotice(
        "Cette facture a déjà une transmission en cours ou acceptée. Le renvoi est bloqué pour éviter un doublon.",
      );
      return;
    }
    const isRetry = Boolean(latestTransmissionBlocked);
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        isRetry
          ? `Créer une nouvelle tentative via ${latestTransmissionProviderLabel} ? Vérifiez d’abord que le motif d’échec a été corrigé. Une seule relance sera enregistrée.`
          : `Créer une tentative unique de transmission via ${transmissionRoute.label} ? Une tentative en cours ou acceptée bloquera tout nouvel envoi.`,
      )
    ) {
      return;
    }
    setTransmissionBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, any> = transmissionRoute.key === "chorus" ? { connector: "choruspro" } : {};
      if (latestTransmissionBlocked) payload.force_retry = true;
      const result: any = await api(`/api/platforms/submit/${id}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const channel = providerLabel(result?.channel);
      const deliveryState = String(result?.delivery_state || "")
        .trim()
        .toLowerCase();
      if (deliveryState === "reconciliation_required") {
        setNotice("Résultat du dépôt incertain, ne pas renvoyer.");
      } else if (deliveryState === "delivered") {
        setNotice("Transmission confirmée et déjà enregistrée. Aucun nouvel envoi n’est nécessaire.");
      } else {
        setNotice(
          channel && channel !== "—"
            ? `Demande de transmission enregistrée pour ${channel}. Consultez son statut avant toute nouvelle action.`
            : "Demande de transmission enregistrée. Consultez son statut avant toute nouvelle action.",
        );
      }
      await loadDetail();
    } catch (err) {
      const message = formatApiError(err, "Transmission impossible.");
      const action = transmissionErrorAction(err);
      setError(message);
      setErrorAction(action ? { ...action, error: message } : null);
    } finally {
      setTransmissionBusy(false);
    }
  };
  const registerPayment = async () => {
    if (!paymentsEnabled) return;
    if (!paymentAmountValid) {
      setError(
        `Saisissez un montant de règlement entre 0,01 € et ${money(paymentMaxAmount, invoice?.currency || "EUR")}.`,
      );
      return;
    }
    setPaymentSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/invoices/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          amount: paymentAmount,
          method: paymentForm.method || null,
          reference: paymentForm.reference || null,
          date: toApiDateTime(paymentForm.date),
          settlement_mode: paymentForm.settlement_mode || "bank",
          accounting_category: paymentForm.accounting_category || null,
          receipt_label: paymentForm.receipt_label || null,
          receipt_url: paymentForm.receipt_url || null,
        }),
      });
      setNotice("Règlement enregistré.");
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Ajout impossible."));
    } finally {
      setPaymentSaving(false);
    }
  };
  const registerRefund = async () => {
    if (!paymentsEnabled) return;
    if (!refundAmountValid) {
      setError(
        `Saisissez un montant de remboursement entre 0,01 € et ${money(refundMaxAmount, invoice?.currency || "EUR")}.`,
      );
      return;
    }
    setRefundSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/invoices/${id}/refunds`, {
        method: "POST",
        body: JSON.stringify({
          amount: refundAmount,
          method: refundForm.method || null,
          reference: refundForm.reference || null,
          date: toApiDateTime(refundForm.date),
        }),
      });
      setNotice("Remboursement enregistré.");
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Remboursement impossible."));
    } finally {
      setRefundSaving(false);
    }
  };
  const startEditPayment = (pay: any) => {
    setError(null);
    setNotice(null);
    setEditingPaymentId(pay.id);
    setPaymentEditForm({
      amount: pay?.amount != null ? Number(pay.amount).toFixed(2) : "",
      method: pay?.method || "virement",
      reference: pay?.reference || "",
      date: pay?.date ? new Date(pay.date).toISOString().slice(0, 10) : "",
      settlement_mode: pay?.settlement_mode || "bank",
      accounting_category:
        pay?.accounting_category || paymentSettlementDefaults(pay?.settlement_mode || "bank").category,
      receipt_label: pay?.receipt_label || "",
      receipt_url: pay?.receipt_url || "",
    });
  };
  const savePaymentEdit = async () => {
    if (!paymentsEnabled || !editingPaymentId) return;
    setPaymentBusyId(editingPaymentId);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/invoices/${id}/payments/${editingPaymentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          amount: Number(paymentEditForm.amount || 0),
          method: paymentEditForm.method || null,
          reference: paymentEditForm.reference || null,
          date: toApiDateTime(paymentEditForm.date),
          settlement_mode: paymentEditForm.settlement_mode || "bank",
          accounting_category: paymentEditForm.accounting_category || null,
          receipt_label: paymentEditForm.receipt_label || null,
          receipt_url: paymentEditForm.receipt_url || null,
        }),
      });
      setNotice("Règlement mis à jour.");
      setEditingPaymentId(null);
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Mise à jour impossible."));
    } finally {
      setPaymentBusyId(null);
    }
  };
  const deletePayment = async (pay: any) => {
    if (!paymentsEnabled) return;
    if (typeof window !== "undefined" && !window.confirm(`Supprimer ce règlement de ${money(pay?.amount || 0)} ?`))
      return;
    setPaymentBusyId(pay.id);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/invoices/${id}/payments/${pay.id}`, { method: "DELETE" });
      setNotice("Règlement supprimé.");
      if (editingPaymentId === pay.id) setEditingPaymentId(null);
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setPaymentBusyId(null);
    }
  };
  const updateShare = async (action: "enable" | "rotate" | "disable") => {
    if (!canWriteInvoices) return;
    if (trialDraftOnly && action !== "disable") {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    if (
      action === "disable" &&
      typeof window !== "undefined" &&
      !window.confirm("Désactiver ce lien client ? Le client ne pourra plus accéder à cette facture avec ce lien.")
    ) {
      return;
    }
    if (
      action === "rotate" &&
      typeof window !== "undefined" &&
      !window.confirm("Régénérer ce lien client ? L'ancien lien ne fonctionnera plus.")
    ) {
      return;
    }
    setShareBusy(true);
    setError(null);
    setNotice(null);
    try {
      const path =
        action === "enable"
          ? `/api/invoices/${id}/share`
          : action === "rotate"
            ? `/api/invoices/${id}/share/rotate`
            : `/api/invoices/${id}/share/disable`;
      const r: any = await api(path, { method: "POST" });
      setShare(r);
      setNotice(action === "enable" ? "Lien activé." : action === "rotate" ? "Lien régénéré." : "Lien désactivé.");
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Lien public impossible."));
    } finally {
      setShareBusy(false);
    }
  };
  const copyOrEnableShare = async () => {
    if (!id) return;
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    setShareBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (shareActive && shareUrl) {
        await copyTextToClipboard(shareUrl);
        setShareCopied(true);
        setNotice("Lien client copié.");
        return;
      }
      const result: any = await api(`/api/invoices/${id}/share`, { method: "POST" });
      setShare(result);
      const publicUrl = result?.public_url || null;
      if (publicUrl) {
        await copyTextToClipboard(publicUrl);
        setShareCopied(true);
        setNotice("Lien client activé et copié.");
      } else {
        setNotice("Lien client activé.");
      }
      await loadDetail();
    } catch (err) {
      setError(formatApiError(err, "Lien client impossible."));
    } finally {
      setShareBusy(false);
    }
  };
  const downloadArtifact = async (path: string, open = false) => {
    try {
      setError(null);
      await downloadProtectedFile(path, undefined, open);
      setNotice(`${downloadLabel(path)} prêt.`);
    } catch (err) {
      setError(formatApiError(err, `Export impossible.`));
    }
  };

  const status = statusMap[invoice?.status] || { label: invoice?.status || "—", color: "muted" };
  const documentLabel = typeLabel(invoice);
  const documentLabelLower = documentLabel.toLowerCase();
  const invoicePreviewVersion = [
    invoice?.updated_at,
    invoice?.issued_at,
    invoice?.sent_at,
    invoice?.paid_at,
    invoice?.status,
    invoice?.balance_due,
    invoice?.total_inc_vat,
    Array.isArray(invoice?.payments) ? invoice.payments.length : 0,
    Array.isArray(invoice?.lines) ? invoice.lines.length : 0,
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join("|");
  const companyReplyEmailDisplay = firstDocumentContactEmail(company?.email_reply_to, accountEmail, company?.email);
  const isDraft = invoice?.status === "draft";
  const canEmail = Boolean(
    !trialDraftOnly && canWriteInvoices && invoice && invoice.status !== "draft" && invoice.status !== "canceled",
  );
  const canDuplicate = Boolean(canWriteInvoices && invoice && invoice.type === "invoice");
  const creditNoteLines = useMemo<CreditNoteLine[]>(() => {
    if (!Array.isArray(invoice?.lines)) return [];
    return invoice.lines
      .filter((line: any) => String(line?.line_type || "item") === "item")
      .map((line: any) => ({
        id: String(line.id || ""),
        product_name: String(line.product_name || line.reference || "Ligne"),
        quantity: Math.abs(Number(line.quantity || 0)),
        unit_price: Number(line.unit_price || 0),
        vat_rate: Number(line.vat_rate || 0),
      }))
      .filter((line: CreditNoteLine) => line.id && line.quantity > 0);
  }, [invoice?.lines]);
  const creditNotesTotal = Math.abs(Number(invoice?.credit_notes_total || 0));
  const creditNoteRemaining = Math.max(0, Math.abs(Number(invoice?.total_inc_vat || 0)) - creditNotesTotal);
  const canCreateCreditNote = Boolean(
    !trialDraftOnly &&
    canWriteInvoices &&
    invoice &&
    invoice.type === "invoice" &&
    !["draft", "canceled"].includes(invoice.status) &&
    creditNoteLines.length > 0 &&
    creditNoteRemaining > 0.01,
  );
  const canFollowup = Boolean(
    !trialDraftOnly &&
    paymentsEnabled &&
    canWriteInvoices &&
    invoice &&
    invoice.type === "invoice" &&
    !["draft", "canceled", "paid"].includes(invoice.status) &&
    Number(invoice.balance_due || 0) > 0,
  );
  const canPay = Boolean(
    !trialDraftOnly &&
    paymentsEnabled &&
    canWriteInvoices &&
    invoice &&
    invoice.type === "invoice" &&
    !["draft", "canceled", "paid"].includes(invoice.status) &&
    Number(invoice.balance_due || 0) > 0,
  );
  const paymentAmount = parsePositiveMoneyInput(paymentForm.amount);
  const paymentMaxAmount = Math.max(0, Number(invoice?.balance_due || 0));
  const paymentAmountValid = paymentAmount > 0 && paymentAmount <= paymentMaxAmount;
  const showPaymentCreateForm = Boolean(canPay && !editingPaymentId);
  const showPaymentCard = Boolean(
    !trialDraftOnly &&
    paymentsEnabled &&
    canWriteInvoices &&
    invoice &&
    invoice.type === "invoice" &&
    !["draft", "canceled"].includes(invoice.status),
  );
  const canRefundCreditNote = Boolean(
    !trialDraftOnly &&
    paymentsEnabled &&
    canWriteInvoices &&
    invoice &&
    invoice.type === "credit_note" &&
    !["draft", "canceled", "paid"].includes(invoice.status) &&
    Number(invoice.refund_balance || 0) > 0,
  );
  const refundAmount = parsePositiveMoneyInput(refundForm.amount);
  const refundMaxAmount = Math.max(0, Number(invoice?.refund_balance || 0));
  const refundAmountValid = refundAmount > 0 && refundAmount <= refundMaxAmount;
  const shareUrl = share?.public_url || null;
  const shareExpired = Boolean(share?.enabled && share?.expired);
  const shareActive = Boolean(share?.enabled && !shareExpired);
  const shareStatusLabel = shareExpired ? "Expiré" : shareActive ? "Actif" : "Inactif";
  const shareStatusTone = shareExpired
    ? { bg: "#fef2f2", text: "#dc2626", dot: "#ef4444", border: "#fecaca" }
    : shareActive
      ? { bg: "#f0fdf4", text: "#059669", dot: "#10b981", border: "#bbf7d0" }
      : { bg: "#f8fafc", text: "#64748b", dot: "#cbd5e1", border: "#e2e8f0" };
  const shareExpiryLabel = share?.expires_at ? formatDateFr(share.expires_at, "—") : "—";
  const shareViewCount = Number(share?.view_count ?? share?.views ?? invoice?.public_view_count ?? 0);
  const shareLastViewedAt = share?.last_viewed_at || invoice?.public_last_viewed_at || null;
  const shareLastViewedLabel = shareLastViewedAt ? formatDateTimeFr(shareLastViewedAt, "—") : "—";
  const shareViewSummary =
    shareViewCount > 0
      ? `${shareViewCount} vue(s)${shareLastViewedLabel !== "—" ? ` · dernière consultation ${shareLastViewedLabel}.` : ""}`
      : shareActive
        ? "Aucune consultation enregistrée."
        : "Lien client inactif.";
  const shareMessage =
    share?.message ||
    (share?.enabled && shareExpiryLabel !== "—"
      ? `Le client peut consulter ou télécharger cette facture jusqu'au ${shareExpiryLabel}.`
      : null);
  const transmissionRoute = transmissionRouteForCustomer(customer, company);
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);
  const facturxArtifactAvailable = hasFacturxArtifact(invoice);
  const transmissionRouteOperational =
    transmissionRoute.key === "chorus"
      ? Boolean(capabilities?.chorus_operational)
      : transmissionRoute.key === "seqino"
        ? Boolean(capabilities?.seqino_operational)
        : false;
  const transmissionUnavailableReason = !transmissionRoute.actionable
    ? transmissionRoute.description
    : !einvoicingEnabled
      ? "L’e-facturation structurée est réservée au plan Pro. Les transmissions exigent aussi un connecteur opérationnel."
      : !transmissionRouteOperational
        ? transmissionRoute.key === "chorus"
          ? "Le canal public Chorus n'est pas opérationnel dans la configuration actuelle."
          : "La transmission Seqino n'est pas opérationnelle dans la configuration actuelle."
        : null;
  const ublExportEnabled = Boolean(publicSettings?.ubl_export_enabled);
  const latestTransmission = transmissionStatus?.latest || null;
  const latestTransmissionDeliveryState = String(latestTransmission?.delivery_state || "")
    .trim()
    .toLowerCase();
  const transmissionReconciliationRequired = latestTransmissionDeliveryState === "reconciliation_required";
  const latestTransmissionAttemptCount = Number.isFinite(Number(latestTransmission?.attempt_count))
    ? Math.max(0, Math.trunc(Number(latestTransmission.attempt_count)))
    : null;
  const latestTransmissionPill = transmissionPill(latestTransmission?.status);
  const latestTransmissionBlocked = transmissionIsBlocking(latestTransmission?.status);
  const chorusRetryUnsupported = Boolean(
    transmissionRoute.key === "chorus" && latestTransmission && latestTransmissionBlocked,
  );
  const latestTransmissionMessage = latestTransmission ? transmissionDisplayMessage(latestTransmission) : "";
  const latestTransmissionProviderLabel = latestTransmission
    ? providerLabel(latestTransmission.provider_slug || latestTransmission.channel || transmissionRoute.key)
    : transmissionRoute.label;
  const transmissionHistory = Array.isArray(transmissionStatus?.history) ? transmissionStatus.history.slice(0, 5) : [];
  const canTransmit = Boolean(
    !trialDraftOnly &&
    canWriteInvoices &&
    invoice &&
    invoice.type === "invoice" &&
    einvoicingEnabled &&
    transmissionRouteOperational &&
    transmissionRoute.actionable &&
    !["draft", "canceled"].includes(invoice.status),
  );
  const lastPay =
    paymentsEnabled && Array.isArray(invoice?.payments) && invoice.payments.length > 0 ? invoice.payments[0] : null;
  const invoiceEmailSubjectTemplate = (company?.email_subject_default || `Votre ${documentLabelLower} {number}`).trim();
  const invoiceEmailBodyTemplate = (
    company?.email_body_default ||
    [
      "Bonjour {client},",
      "",
      `Votre ${documentLabelLower} {number} est disponible. Date d'émission : {issue_date}. Montant TTC : {total_ttc} {currency}.`,
      invoice?.type === "credit_note"
        ? "Échéance indiquée : {due_date}."
        : "Elle est à régler au plus tard le {due_date}.",
      "",
      "Vous pouvez la consulter et la télécharger depuis le portail sécurisé. Le PDF est joint à cet email pour vos dossiers.",
      "",
      "Les informations de règlement figurent dans la facture. Si une correction est nécessaire, répondez à cet email avant paiement.",
      "",
      companyReplyEmailDisplay ? "Vous pouvez contacter l'émetteur à cette adresse : {reply_to}" : "",
    ].join("\n")
  ).trim();
  const invoiceFollowupSubjectTemplate = (company?.reminder_subject_default || "Relance - facture {number}").trim();
  const invoiceFollowupBodyTemplate = (
    company?.reminder_body_default ||
    [
      "Bonjour {client},",
      "",
      "Sauf erreur de notre part, la facture {number}, échue le {due_date}, reste à régler.",
      "Montant TTC : {total_ttc} {currency}.",
      "",
      "Si le paiement a déjà été effectué, merci de transmettre la référence du règlement à votre contact habituel. À défaut, merci d'indiquer la date de paiement prévue.",
    ].join("\n")
  ).trim();
  const invoiceEmailTemplateVariables = {
    "{client}": customer?.name || invoice?.customer_name || "client",
    "{company}": company?.name || "votre entreprise",
    "{reply_to}": companyReplyEmailDisplay,
    "{number}": invoice?.number || "",
    "{issue_date}": formatDateFr(invoice?.issue_date, ""),
    "{due_date}": formatDateFr(invoice?.due_date, ""),
    "{total_ht}": money(invoice?.total_ex_vat || 0, invoice?.currency || "EUR"),
    "{total_tva}": money(invoice?.total_vat || 0, invoice?.currency || "EUR"),
    "{total_ttc} {currency}": money(invoice?.total_inc_vat || 0, invoice?.currency || "EUR"),
    "{total_ttc}": money(invoice?.total_inc_vat || 0, invoice?.currency || "EUR"),
    "{currency}": invoice?.currency === "EUR" ? "€" : invoice?.currency || "EUR",
    "{invoice_link}": "le lien sécurisé",
  };
  const invoiceEmailSubject = renderEmailTemplateText(invoiceEmailSubjectTemplate, invoiceEmailTemplateVariables);
  const invoiceEmailBody = renderEmailTemplateText(invoiceEmailBodyTemplate, invoiceEmailTemplateVariables);
  const invoiceFollowupSubject = renderEmailTemplateText(invoiceFollowupSubjectTemplate, invoiceEmailTemplateVariables);
  const invoiceFollowupBody = renderEmailTemplateText(invoiceFollowupBodyTemplate, invoiceEmailTemplateVariables);
  const invoiceAttachmentName = `${invoice?.number || documentLabelLower}.${invoice?.facturx_profile || "EN16931" ? "pdf" : "pdf"}`;
  const isRailOpen = (key: string) => openRailSections[key] !== false;
  const toggleRailSection = (key: string) => {
    setOpenRailSections((prev) => ({ ...prev, [key]: !(prev[key] !== false) }));
  };
  const openRailSection = (key: string) => {
    setOpenRailSections((prev) => (prev[key] !== false ? prev : { ...prev, [key]: true }));
  };
  const focusRailSection = (key: string) => {
    if (key === "transmission" && !einvoicingEnabled) return;
    if (["encaissement", "remboursement", "relances"].includes(key) && !paymentsEnabled) return;
    if (
      key === "transmission" ||
      key === "encaissement" ||
      key === "avoirs" ||
      key === "remboursement" ||
      key === "relances"
    ) {
      setActionPanel(key);
      return;
    }
    openRailSection(key);
    if (typeof document === "undefined") return;
    window.setTimeout(() => {
      const node = document.getElementById(`invoice-rail-${key}`);
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
  };
  const scrollToPaymentCard = () => {
    setActionPanel("encaissement");
  };
  const paidAmount = Math.max(0, Number(invoice?.total_inc_vat || 0) - Number(invoice?.balance_due || 0));
  const balanceDueAmount = Math.max(0, Number(invoice?.balance_due || 0));
  const invoiceNextAction: InvoiceNextAction = (() => {
    if (!invoice) {
      return {
        label: "Charger le document",
        description: "Le document doit être disponible avant de choisir l'action.",
        icon: FileText,
        tone: "slate",
        onClick: () => undefined,
        disabled: true,
      };
    }
    if (isDraft) {
      if (trialDraftOnly) {
        return {
          label: "Abonnement requis",
          description: TRIAL_LIVE_ACTION_MESSAGE,
          icon: Send,
          tone: "blue",
          onClick: () => undefined,
          disabled: true,
        };
      }
      return {
        label: "Émettre la facture",
        description: "Rendez le document définitif avant l'envoi ou la transmission disponible selon votre plan.",
        icon: Send,
        tone: "blue",
        onClick: issueInvoice,
        disabled: actionBusy || !canWriteInvoices,
        loading: actionBusy,
      };
    }
    if (invoice.type === "credit_note") {
      if (canRefundCreditNote) {
        return {
          label: "Enregistrer le remboursement",
          description: "Saisissez le remboursement pour solder cet avoir.",
          icon: Wallet,
          tone: "green",
          onClick: () => focusRailSection("remboursement"),
          disabled: refundSaving,
          loading: refundSaving,
        };
      }
      return {
        label: "Avoir soldé",
        description: "Aucune action requise. Vous pouvez consulter le document ou son historique.",
        icon: CheckCircle2,
        tone: "slate",
        onClick: () => focusRailSection("document"),
        disabled: true,
      };
    }
    if (invoice.status === "overdue" && canFollowup) {
      return {
        label: "Relancer le client",
        description: `Solde dû : ${money(balanceDueAmount, invoice?.currency || "EUR")}. Une relance est recommandée.`,
        icon: Send,
        tone: "red",
        onClick: openFollowupEmail,
        disabled: actionBusy,
        loading: actionBusy,
      };
    }
    if (transmissionReconciliationRequired) {
      return {
        label: "Dépôt à rapprocher",
        description: "Résultat du dépôt incertain, ne pas renvoyer.",
        icon: AlertTriangle,
        tone: "red",
        onClick: () => setActionPanel("transmission"),
      };
    }
    if (chorusRetryUnsupported) {
      return {
        label: `Transmission ${latestTransmissionPill.label.toLowerCase()}`,
        description: "Corriger puis créer une nouvelle émission. La resoumission Chorus n’est pas disponible.",
        icon: AlertTriangle,
        tone: "red",
        onClick: () => setActionPanel("transmission"),
      };
    }
    if (canTransmit && latestTransmissionBlocked) {
      return {
        label: `Transmission ${latestTransmissionPill.label.toLowerCase()}`,
        description:
          latestTransmissionMessage && latestTransmissionMessage !== "—"
            ? latestTransmissionMessage
            : "Consultez le motif avant de corriger ou relancer l'envoi.",
        icon: AlertTriangle,
        tone: "red",
        onClick: () => setActionPanel("transmission"),
      };
    }
    if (canTransmit && !latestTransmission) {
      return {
        label: "Transmettre",
        description: "Envoyez la facture vers le circuit e-facturation configuré.",
        icon: Zap,
        tone: "blue",
        onClick: submitTransmission,
        disabled: transmissionBusy,
        loading: transmissionBusy,
      };
    }
    if (canEmail && !invoice.sent_at) {
      return {
        label: "Envoyer par email",
        description: "Préparez l'email avec le PDF joint et le lien client.",
        icon: Mail,
        tone: "blue",
        onClick: () => setEmailOpen(true),
        disabled: emailSending,
        loading: emailSending,
      };
    }
    if (canPay) {
      return {
        label: "Enregistrer un règlement",
        description: "Saisissez l'encaissement reçu par banque, espèces ou marquage manuel.",
        icon: Wallet,
        tone: "green",
        onClick: scrollToPaymentCard,
      };
    }
    if (canCreateCreditNote) {
      return {
        label: "Créer un avoir",
        description: "Créditez une partie ou la totalité de la facture si nécessaire.",
        icon: ReceiptText,
        tone: "amber",
        onClick: () => setCreditNoteOpen(true),
        disabled: creditNoteSubmitting,
        loading: creditNoteSubmitting,
      };
    }
    return {
      label: paymentsEnabled ? "Règlement" : "Document disponible",
      description: paymentsEnabled ? "Paiement complet." : "Aucune autre action urgente pour ce document.",
      icon: CheckCircle2,
      tone: "slate",
      onClick: () => (paymentsEnabled ? focusRailSection("encaissement") : focusRailSection("document")),
      disabled: true,
    };
  })();
  const followupIsNext = invoice?.type === "invoice" && invoice?.status === "overdue" && canFollowup;
  const canSubmitTransmission =
    invoice?.type === "invoice" &&
    !isDraft &&
    canTransmit &&
    !transmissionReconciliationRequired &&
    !chorusRetryUnsupported &&
    (!latestTransmission || latestTransmissionBlocked);
  const latestTransmissionGroup = transmissionStatusGroup(latestTransmission?.status);
  const transmissionLocksRetry = Boolean(
    transmissionReconciliationRequired || (latestTransmission && !latestTransmissionBlocked),
  );
  const transmissionAlreadySent = latestTransmissionGroup === "accepted";
  const transmissionActionAvailable = Boolean(canSubmitTransmission);
  const transmissionSummaryActionLabel = transmissionBusy
    ? "..."
    : transmissionReconciliationRequired
      ? "À rapprocher"
      : transmissionAlreadySent
        ? "Déjà transmis"
        : latestTransmissionGroup === "pending"
          ? "En cours"
          : chorusRetryUnsupported
            ? "Suivi"
            : latestTransmissionBlocked
              ? "Relancer"
              : transmissionActionAvailable
                ? "Transmettre"
                : "Voir";
  const emailActionAvailable = invoice?.type === "invoice" && !isDraft && canEmail && !invoice?.sent_at;
  const transmissionIsNext = !followupIsNext && transmissionActionAvailable;
  const emailIsNext = !followupIsNext && !transmissionIsNext && emailActionAvailable;
  const encaissementIsNext =
    invoice?.type === "invoice" && !followupIsNext && !transmissionIsNext && !emailIsNext && canPay;
  const avoirIsNext =
    invoice?.type === "invoice" &&
    !followupIsNext &&
    !transmissionIsNext &&
    !emailIsNext &&
    !encaissementIsNext &&
    canCreateCreditNote;
  const invoiceSummaryModulesRaw: InvoiceSummaryModule[] =
    invoice?.type === "credit_note"
      ? [
          {
            label: "Transmission",
            detail: latestTransmission
              ? latestTransmissionPill.label
              : isDraft
                ? "Après émission"
                : transmissionRoute.label,
            icon: Zap,
            tone: "blue",
            onClick: () => setActionPanel("transmission"),
            disabled: !invoice || isDraft || transmissionLocksRetry,
            actionLabel: transmissionBusy ? "..." : "Voir",
            active: actionPanel === "transmission" || transmissionIsNext,
          },
          {
            label: "Règlement",
            detail:
              Number(invoice?.refund_balance || 0) > 0
                ? `À rembourser ${money(invoice?.refund_balance || 0, invoice?.currency || "EUR")}`
                : "Avoir soldé",
            icon: Wallet,
            tone: "green",
            onClick: () => setActionPanel("remboursement"),
            disabled: !invoice || isDraft,
            actionLabel: canRefundCreditNote ? "Saisir" : "Voir",
            active: actionPanel === "remboursement" || canRefundCreditNote,
          },
          {
            label: "Email",
            detail: invoice?.sent_at ? "Déjà envoyé au client" : canEmail ? "À envoyer au client" : "Après émission",
            icon: Mail,
            tone: "blue",
            onClick: () => setEmailOpen(true),
            disabled: !canEmail,
            actionLabel: emailSending ? "..." : invoice?.sent_at ? "Voir" : "Envoyer",
            active: emailIsNext,
          },
          {
            label: "Avoir",
            detail: invoice?.number || "Numéro après émission",
            icon: FileText,
            tone: "amber",
            onClick: () => focusRailSection("document"),
            actionLabel: "Ouvrir",
            active: actionPanel === "avoirs",
          },
        ]
      : [
          {
            label: "Transmission",
            detail: latestTransmission
              ? latestTransmissionPill.label
              : canTransmit
                ? "À transmettre"
                : isDraft
                  ? "Après émission"
                  : transmissionUnavailableReason || transmissionRoute.label,
            icon: Zap,
            tone: "blue",
            onClick: () => setActionPanel("transmission"),
            disabled: !invoice || isDraft || transmissionLocksRetry,
            actionLabel: transmissionSummaryActionLabel,
            active: actionPanel === "transmission" || transmissionIsNext,
          },
          {
            label: "Règlement",
            detail:
              balanceDueAmount > 0
                ? `Reste dû ${money(balanceDueAmount, invoice?.currency || "EUR")}`
                : `Reçu ${money(paidAmount, invoice?.currency || "EUR")}`,
            icon: Wallet,
            tone: "green",
            onClick: () => setActionPanel("encaissement"),
            disabled: !showPaymentCard,
            actionLabel: canPay ? "Saisir" : "Voir",
            active: actionPanel === "encaissement" || encaissementIsNext,
          },
          {
            label: "Email",
            detail: invoice?.sent_at ? "Déjà envoyé au client" : canEmail ? "À envoyer au client" : "Après émission",
            icon: Mail,
            tone: "blue",
            onClick: () => setEmailOpen(true),
            disabled: !canEmail,
            actionLabel: emailSending ? "..." : invoice?.sent_at ? "Voir" : "Envoyer",
            active: emailIsNext,
          },
          {
            label: "Avoir",
            detail:
              creditNoteRemaining > 0.01
                ? `${money(creditNoteRemaining, invoice?.currency || "EUR")} créditable`
                : creditNotesTotal > 0
                  ? "Déjà créditée"
                  : isDraft
                    ? "Après émission"
                    : "Aucun avoir",
            icon: ReceiptText,
            tone: "amber",
            onClick: () => setActionPanel("avoirs"),
            disabled: !invoice || isDraft,
            actionLabel: creditNoteSubmitting ? "..." : canCreateCreditNote ? "Créer" : "Voir",
            active: actionPanel === "avoirs" || avoirIsNext,
          },
          {
            label: "Relance",
            detail: canFollowup
              ? invoice?.next_followup_at
                ? `Prochaine ${formatDateFr(invoice.next_followup_at, "—")}`
                : "Préparer un rappel"
              : invoice?.status === "paid"
                ? "Soldée"
                : invoiceFollowupBlockLabel(invoice?.followup_block_reason) || "À suivre",
            icon: Clock,
            tone: canFollowup ? "red" : "blue",
            onClick: () => setActionPanel("relances"),
            disabled: !invoice || isDraft || invoice?.status === "paid" || invoice?.status === "canceled",
            actionLabel: canFollowup ? "Préparer" : "Voir",
            active: actionPanel === "relances" || followupIsNext,
          },
        ];
  const invoiceSummaryModules = invoiceSummaryModulesRaw.filter((module) => {
    if (module.label === "Transmission") return einvoicingEnabled;
    if (module.label === "Règlement" || module.label === "Relance") return paymentsEnabled;
    return true;
  });
  const issueChecklistItems = buildInvoiceComplianceUiItems({
    fields: issueMissingFields,
    errors: actionErrorDetails,
    invoiceId: invoice?.id || id,
    customerId: invoice?.customer_id,
  });
  const actionPanelAllowed =
    actionPanel !== "transmission" || einvoicingEnabled
      ? !["encaissement", "remboursement", "relances"].includes(String(actionPanel)) || paymentsEnabled
      : false;
  const actionPanelMeta = !actionPanelAllowed
    ? null
    : actionPanel === "transmission"
      ? { title: "Transmission", icon: Zap, tone: "blue" as InvoiceActionTone }
      : actionPanel === "encaissement"
        ? { title: "Règlement", icon: balanceDueAmount > 0 ? Wallet : CheckCircle2, tone: "green" as InvoiceActionTone }
        : actionPanel === "avoirs"
          ? { title: "Avoir", icon: ReceiptText, tone: "amber" as InvoiceActionTone }
          : actionPanel === "remboursement"
            ? { title: "Remboursement", icon: Wallet, tone: "green" as InvoiceActionTone }
            : actionPanel === "relances"
              ? {
                  title: "Relances",
                  icon: Clock,
                  tone: canFollowup ? ("red" as InvoiceActionTone) : ("blue" as InvoiceActionTone),
                }
              : null;
  const showLegacyActionRails = false;
  const renderActionPanelContent = () => {
    if (!paymentsEnabled && (actionPanel === "encaissement" || actionPanel === "remboursement")) {
      return (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-[12px] leading-5 text-sky-900">
          Le suivi des paiements et des remboursements est réservé au plan Pro.
        </div>
      );
    }
    if (actionPanel === "transmission") {
      return (
        <div className="space-y-4">
          <div aria-live="polite" className="rounded-2xl border border-[#dbe4ef] bg-[#f8fafc] px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="pf-invoice-overline text-[#94a3b8]">Circuit</div>
                <div className="mt-1 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                  {transmissionRoute.label}
                </div>
              </div>
              <StatusPill status={latestTransmissionPill.color} label={latestTransmissionPill.label} />
            </div>
            <p className="pf-invoice-body mt-2 text-[#64748b]">{transmissionRoute.description}</p>
          </div>
          {latestTransmission ? (
            <div className="rounded-2xl border border-[#e2e8f0] bg-white px-4 py-3">
              <RailRow label="Statut" value={latestTransmissionPill.label} />
              <RailRow label="Plateforme" value={latestTransmissionProviderLabel} />
              <RailRow label="Référence" value={shortRef(latestTransmission.external_id)} />
              <RailRow
                label="Tentatives"
                value={
                  latestTransmissionAttemptCount === null ? "Non communiqué" : String(latestTransmissionAttemptCount)
                }
              />
              <RailRow
                label="Mise à jour"
                value={formatDateTimeFr(latestTransmission.updated_at || latestTransmission.created_at, "—")}
              />
              {latestTransmissionMessage && latestTransmissionMessage !== "—" ? (
                <div className="mt-3 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2">
                  <div className="pf-invoice-overline text-[#94a3b8]">Motif / message</div>
                  <p className="pf-invoice-caption mt-1 text-[#334155]">{latestTransmissionMessage}</p>
                </div>
              ) : null}
            </div>
          ) : null}
          {transmissionHistory.length ? (
            <div className="rounded-2xl border border-[#e2e8f0] bg-white px-4 py-3">
              <div className="pf-invoice-overline text-[#94a3b8]">Transmissions récentes</div>
              <div className="mt-3 space-y-3">
                {transmissionHistory.map((event: any) => {
                  const eventPill = transmissionPill(event?.status);
                  const eventMessage = transmissionDisplayMessage(event);
                  return (
                    <div
                      key={event?.id || `${event?.provider_slug || "transmission"}-${event?.created_at || "date"}`}
                      className="rounded-xl border border-[#edf2f7] bg-[#f8fafc] px-3 py-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="pf-invoice-caption font-semibold text-[#334155]">
                          {providerLabel(event?.provider_slug || event?.channel || transmissionRoute.key)}
                        </div>
                        <StatusPill status={eventPill.color} label={eventPill.label} />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-[#64748b]">
                        <span>{formatDateTimeFr(event?.updated_at || event?.created_at, "—")}</span>
                        {event?.external_id ? <span>Réf. {shortRef(event.external_id)}</span> : null}
                      </div>
                      {eventMessage && eventMessage !== "—" ? (
                        <p className="pf-invoice-caption mt-1.5 text-[#475569]">{eventMessage}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {transmissionReconciliationRequired ? (
            <div className="rounded-2xl border border-[#f59e0b] bg-[#fffbeb] px-4 py-3 text-[#92400e]">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="pf-invoice-caption font-semibold">Résultat du dépôt incertain, ne pas renvoyer.</p>
                  <p className="pf-invoice-caption mt-1">
                    {latestTransmissionAttemptCount === null
                      ? "Nombre de tentatives non communiqué"
                      : `${latestTransmissionAttemptCount} tentative(s) enregistrée(s)`}
                    {" · "}
                    dernière mise à jour {formatDateTimeFr(latestTransmission?.updated_at, "non communiquée")}.
                  </p>
                </div>
              </div>
            </div>
          ) : latestTransmission && !latestTransmissionBlocked ? (
            <div className="rounded-2xl border border-[#dbeafe] bg-[#eff6ff] px-4 py-3 text-[#1e3a8a]">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="pf-invoice-caption">
                  Une transmission existe déjà. Aucun nouvel envoi ne peut être lancé tant que son statut ne permet pas
                  explicitement une relance.
                </p>
              </div>
            </div>
          ) : latestTransmissionBlocked ? (
            <div className="rounded-2xl border border-[#fee2e2] bg-[#fef2f2] px-4 py-3 text-[#991b1b]">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="pf-invoice-caption">
                  Cette alerte concerne la transmission réglementaire via {latestTransmissionProviderLabel}, pas l'email
                  client.{" "}
                  {chorusRetryUnsupported
                    ? "Corriger puis créer une nouvelle émission. Aucune resoumission Chorus n’est proposée ici."
                    : "Corrigez le motif d'échec avant de relancer la transmission."}
                </p>
              </div>
            </div>
          ) : transmissionUnavailableReason ? (
            <div className="rounded-2xl border border-[#fde68a] bg-[#fffbeb] px-4 py-3 text-[#92400e]">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="pf-invoice-caption">{transmissionUnavailableReason}</p>
              </div>
            </div>
          ) : null}
          <div
            className={`grid gap-2 ${
              !transmissionReconciliationRequired && !chorusRetryUnsupported && canEmail ? "sm:grid-cols-2" : ""
            }`}
          >
            {!transmissionReconciliationRequired && !chorusRetryUnsupported ? (
              <PrimaryButton onClick={submitTransmission} disabled={!canSubmitTransmission || transmissionBusy}>
                <Send className="h-3.5 w-3.5" />
                {transmissionBusy
                  ? "Transmission..."
                  : latestTransmissionBlocked
                    ? "Relancer la transmission"
                    : "Transmettre"}
              </PrimaryButton>
            ) : null}
            {canEmail ? (
              <SecondaryButton onClick={() => setEmailOpen(true)} disabled={actionBusy || emailSending}>
                <Mail className="h-3.5 w-3.5" /> Envoyer par email
              </SecondaryButton>
            ) : null}
          </div>
        </div>
      );
    }
    if (actionPanel === "relances") {
      const schedule = Array.isArray(invoice?.followup_schedule) ? invoice.followup_schedule : [];
      const state = String(invoice?.followup_state || "");
      const nextDate = invoice?.next_followup_at ? formatDateTimeFr(invoice.next_followup_at, "—") : null;
      const blockLabel = invoiceFollowupBlockLabel(invoice?.followup_block_reason);
      const scheduleDraftDays = parseFollowupScheduleDaysInput(followupScheduleDraft);
      return (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="pf-invoice-overline text-[#1d4ed8]">Planning prévu</div>
                <p className="pf-invoice-body mt-1 text-[#1e3a8a]">
                  {blockLabel ||
                    (nextDate
                      ? `Prochaine relance : ${nextDate}.`
                      : state === "eligible_now"
                        ? "Relance possible maintenant."
                        : "Aucune relance automatique immédiate. Les périodes restent personnalisables.")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFollowupScheduleEditing((value) => !value)}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-[#bfdbfe] bg-white px-3 text-sm font-bold text-[#1d4ed8] transition hover:bg-[#f8fafc]"
              >
                {followupScheduleEditing ? "Masquer les périodes" : "Personnaliser les périodes"}
              </button>
            </div>
            {followupScheduleEditing ? (
              <div className="mt-4 rounded-2xl border border-[#bfdbfe] bg-white p-3">
                <InputField
                  label="Jours de relance"
                  value={followupScheduleDraft}
                  onChange={(event) => setFollowupScheduleDraft(event.target.value)}
                  placeholder="-2, 3, 10, 15"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {(scheduleDraftDays.length ? scheduleDraftDays : [-2, 3, 10]).map((day, index) => (
                    <span
                      key={`${day}-${index}`}
                      className="rounded-full border border-[#dbeafe] bg-[#eff6ff] px-2.5 py-1 text-xs font-bold text-[#1d4ed8]"
                    >
                      Relance {index + 1} · {followupOffsetLabel(day)}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs font-semibold leading-5 text-[#64748b]">
                  Valeurs relatives à l'échéance : -2 = deux jours avant, 3 = trois jours après.
                </p>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <SecondaryButton
                    onClick={() => {
                      setFollowupScheduleDraft(formatFollowupScheduleDaysInput(invoice?.followup_schedule));
                      setFollowupScheduleEditing(false);
                    }}
                    disabled={followupScheduleSaving}
                  >
                    Annuler
                  </SecondaryButton>
                  <PrimaryButton onClick={saveFollowupSchedule} disabled={followupScheduleSaving}>
                    {followupScheduleSaving ? "Enregistrement..." : "Enregistrer les périodes"}
                  </PrimaryButton>
                </div>
              </div>
            ) : null}
          </div>

          {schedule.length ? (
            <div className="grid gap-2">
              {schedule.map((item: any) => (
                <div
                  key={`${item.index}-${item.offset}`}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-[#e2e8f0] bg-white px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[#0f172a]" style={{ fontSize: "0.82rem", fontWeight: 850 }}>
                      Relance {item.index} · {item.label || followupOffsetLabel(item.offset)}
                    </div>
                    <div className="mt-0.5 text-[#94a3b8]" style={{ fontSize: "0.72rem", fontWeight: 700 }}>
                      {item.scheduled_at ? formatDateFr(item.scheduled_at, "—") : "Date à calculer"}
                    </div>
                  </div>
                  <span className={`shrink-0 text-right text-[0.75rem] font-bold ${followupStatusTone(item.status)}`}>
                    {followupStatusLabel(item.status)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3 text-[#64748b]">
              Aucun planning automatique configuré pour cette facture.
            </div>
          )}

          <div className="rounded-2xl border border-[#dbe4ef] bg-white p-4">
            <PrimaryButton
              onClick={openFollowupEmail}
              disabled={!canFollowup || actionBusy || followupSending}
              title={!canFollowup ? blockLabel || "Relance indisponible" : undefined}
            >
              <Send className="h-3.5 w-3.5" />
              Préparer une relance
            </PrimaryButton>
          </div>
        </div>
      );
    }
    if (actionPanel === "avoirs") {
      return (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#eef2f7] bg-[#f8fafc] px-4 py-4">
              <div className="pf-invoice-overline text-[#94a3b8]">Déjà crédité</div>
              <div className="pf-invoice-value mt-1 font-mono text-[#0f172a]">
                {money(creditNotesTotal, invoice?.currency || "EUR")}
              </div>
            </div>
            <div className="rounded-2xl border border-[#fde68a] bg-[#fffbeb] px-4 py-4">
              <div className="pf-invoice-overline text-[#92400e]">Reste créditable</div>
              <div className="pf-invoice-value mt-1 font-mono text-[#92400e]">
                {money(creditNoteRemaining, invoice?.currency || "EUR")}
              </div>
            </div>
          </div>
          {canCreateCreditNote ? (
            <PrimaryButton onClick={() => setCreditNoteOpen(true)} disabled={creditNoteSubmitting}>
              <ReceiptText className="h-3.5 w-3.5" /> Créer un avoir
            </PrimaryButton>
          ) : (
            <div className="pf-invoice-body rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3 text-[#64748b]">
              {invoice?.status === "draft"
                ? "Émets la facture avant de créer un avoir."
                : creditNoteRemaining <= 0.01
                  ? "Cette facture est déjà intégralement créditée."
                  : "Aucune ligne créditable."}
            </div>
          )}
          {Array.isArray(invoice?.credit_notes) && invoice.credit_notes.length ? (
            <div className="space-y-2">
              {invoice.credit_notes.map((note: any) => (
                <Link
                  key={note.id}
                  to={`/app/invoices/${note.id}`}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-[#e2e8f0] bg-white px-4 py-3 transition hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
                >
                  <span className="min-w-0">
                    <span className="pf-invoice-title block truncate text-[#0f172a]">
                      {note.number || "Avoir brouillon"}
                    </span>
                    <span className="pf-invoice-caption block text-[#94a3b8]">
                      {formatDateFr(note.issue_date, "—")}
                    </span>
                  </span>
                  <span className="pf-invoice-title shrink-0 text-[#0f172a]">
                    {money(Math.abs(Number(note.total_inc_vat || 0)), invoice?.currency || "EUR")}
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    if (actionPanel === "remboursement") {
      return (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <RailRow
              label="Montant de l'avoir"
              value={money(Math.abs(Number(invoice?.total_inc_vat || 0)), invoice?.currency || "EUR")}
            />
            <RailRow label="Déjà remboursé" value={money(invoice?.refunds_total || 0, invoice?.currency || "EUR")} />
            <RailRow label="À rembourser" value={money(invoice?.refund_balance || 0, invoice?.currency || "EUR")} />
          </div>
          {canRefundCreditNote ? (
            <div className="space-y-3 rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] p-4">
              <InputField
                label="Date"
                type="date"
                value={refundForm.date || ""}
                onChange={(e) => setRefundForm((p: any) => ({ ...p, date: e.target.value }))}
              />
              <InputField
                label="Montant"
                type="number"
                min="0.01"
                step="0.01"
                value={refundForm.amount || ""}
                onChange={(e) => setRefundForm((p: any) => ({ ...p, amount: e.target.value }))}
              />
              <SelectField
                label="Mode"
                value={refundForm.method || "virement"}
                onChange={(e) => setRefundForm((p: any) => ({ ...p, method: e.target.value }))}
              >
                <option value="virement">Virement</option>
                <option value="cheque">Chèque</option>
                <option value="especes">Espèces</option>
                <option value="manuel">Manuel</option>
              </SelectField>
              <InputField
                label="Référence"
                value={refundForm.reference || ""}
                onChange={(e) => setRefundForm((p: any) => ({ ...p, reference: e.target.value }))}
                placeholder="Réf. remboursement"
              />
              <PrimaryButton
                onClick={registerRefund}
                disabled={refundSaving || !canRefundCreditNote || !refundAmountValid}
              >
                {refundSaving ? "…" : "Enregistrer le remboursement"}
              </PrimaryButton>
            </div>
          ) : (
            <div
              className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3 text-[#64748b]"
              style={{ fontSize: "0.78rem", lineHeight: 1.5 }}
            >
              {invoice?.status === "draft" ? "Émets l'avoir avant de rembourser." : "Avoir soldé."}
            </div>
          )}
        </div>
      );
    }
    return (
      <div id="invoice-payment-card" className="space-y-4">
        <InvoicePaymentMetrics
          total={money(invoice?.total_inc_vat || 0, invoice?.currency || "EUR")}
          paid={money(
            Math.max(0, Number(invoice?.total_inc_vat || 0) - Number(invoice?.balance_due || 0)),
            invoice?.currency || "EUR",
          )}
          due={money(invoice?.balance_due || 0, invoice?.currency || "EUR")}
          last={lastPay ? money(lastPay.amount || 0, invoice?.currency || "EUR") : "—"}
        />
        {invoice?.status === "overdue" ? (
          <div
            className="rounded-2xl border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-[#991b1b]"
            style={{ fontSize: "0.78rem", fontWeight: 650 }}
          >
            Facture en retard. Relance ou règlement conseillé.
          </div>
        ) : null}
        {showPaymentCreateForm ? (
          <div className="space-y-3 rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] p-4">
            <div className="grid grid-cols-3 gap-1.5">
              {PAYMENT_SETTLEMENT_OPTIONS.map((option) => {
                const active = (paymentForm.settlement_mode || "bank") === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updatePaymentSettlement(setPaymentForm, option.value)}
                    className={`h-9 rounded-lg border px-2 transition ${
                      active
                        ? "border-[#2563eb] bg-white text-[#1d4ed8] shadow-sm"
                        : "border-[#dbe4ef] bg-[#f8fbff] text-[#64748b] hover:border-[#bfdbfe]"
                    }`}
                    style={{ fontSize: "0.72rem", fontWeight: 800 }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <InputField
              label="Date"
              type="date"
              value={paymentForm.date || ""}
              onChange={(e) => setPaymentForm((p: any) => ({ ...p, date: e.target.value }))}
            />
            <InputField
              label="Montant"
              type="number"
              min="0.01"
              step="0.01"
              value={paymentForm.amount || ""}
              onChange={(e) => setPaymentForm((p: any) => ({ ...p, amount: e.target.value }))}
            />
            <SelectField
              label="Mode"
              value={paymentForm.method || "virement"}
              onChange={(e) => setPaymentForm((p: any) => ({ ...p, method: e.target.value }))}
            >
              <option value="virement">Virement</option>
              <option value="cheque">Chèque</option>
              <option value="especes">Espèces</option>
              <option value="manuel">Manuel</option>
            </SelectField>
            <SelectField
              label="Compte de règlement"
              value={paymentForm.accounting_category || "512 Banque"}
              onChange={(e) => setPaymentForm((p: any) => ({ ...p, accounting_category: e.target.value }))}
            >
              {PAYMENT_ACCOUNTING_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectField>
            <InputField
              label={(paymentForm.settlement_mode || "bank") === "manual" ? "Motif" : "Référence"}
              value={paymentForm.reference || ""}
              onChange={(e) => setPaymentForm((p: any) => ({ ...p, reference: e.target.value }))}
              placeholder={
                (paymentForm.settlement_mode || "bank") === "manual"
                  ? "Marquage sans transaction"
                  : "Réf. virement, chèque ou reçu"
              }
            />
            <InputField
              label="Justificatif"
              value={paymentForm.receipt_label || ""}
              onChange={(e) => setPaymentForm((p: any) => ({ ...p, receipt_label: e.target.value }))}
              placeholder="Libellé banque, caisse ou note comptable"
            />
            <InputField
              label="Lien justificatif"
              value={paymentForm.receipt_url || ""}
              onChange={(e) => setPaymentForm((p: any) => ({ ...p, receipt_url: e.target.value }))}
              placeholder="URL du reçu ou de la preuve comptable"
            />
            <PrimaryButton onClick={registerPayment} disabled={paymentSaving || !canPay || !paymentAmountValid}>
              {paymentSaving ? "…" : "Enregistrer le règlement"}
            </PrimaryButton>
          </div>
        ) : showPaymentCard && Number(invoice?.balance_due || 0) > 0 ? (
          <div
            className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3 text-[#64748b]"
            style={{ fontSize: "0.78rem" }}
          >
            {manualPaymentHelp()}
          </div>
        ) : null}
        {(invoice?.payments || []).length ? (
          <div className="space-y-2">
            {invoice.payments.map((pay: any) => (
              <div key={pay.id} className="rounded-2xl border border-[#e2e8f0] bg-white px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-[#0f172a]" style={{ fontSize: "0.78rem" }}>
                      {money(pay.amount || 0, invoice?.currency || "EUR")}
                    </div>
                    <div className="text-[#94a3b8]" style={{ fontSize: "0.68rem" }}>
                      {formatDateTimeFr(pay.date, "—")} · {paymentSettlementLabel(pay.settlement_mode)} ·{" "}
                      {pay.accounting_category || "cat. à compléter"}
                    </div>
                    <div className="text-[#64748b]" style={{ fontSize: "0.68rem" }}>
                      {pay.receipt_label || shortRef(pay.reference)}
                      {pay.receipt_url ? (
                        <>
                          {" · "}
                          <a
                            href={pay.receipt_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-bold text-[#2563eb] hover:underline"
                          >
                            Preuve
                          </a>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#bfdbfe] bg-[#eff6ff] text-[#2563eb]"
                      onClick={() => startEditPayment(pay)}
                      aria-label="Modifier le règlement"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#fecaca] bg-[#fef2f2] text-[#dc2626] disabled:opacity-50"
                      onClick={() => void deletePayment(pay)}
                      disabled={paymentBusyId === pay.id}
                      aria-label="Supprimer le règlement"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {editingPaymentId ? (
          <div className="space-y-3 rounded-2xl border border-[#dbe4ef] bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="font-bold text-[#0f172a]" style={{ fontSize: "0.82rem" }}>
                Modifier le règlement
              </div>
              <button
                className="text-xs font-bold text-[#64748b] hover:text-[#0f172a]"
                onClick={() => setEditingPaymentId(null)}
              >
                Fermer
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {PAYMENT_SETTLEMENT_OPTIONS.map((option) => {
                const active = (paymentEditForm.settlement_mode || "bank") === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updatePaymentSettlement(setPaymentEditForm, option.value)}
                    className={`h-9 rounded-lg border px-2 transition ${active ? "border-[#2563eb] bg-[#eff6ff] text-[#1d4ed8]" : "border-[#dbe4ef] bg-white text-[#64748b] hover:border-[#bfdbfe]"}`}
                    style={{ fontSize: "0.72rem", fontWeight: 800 }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <InputField
              label="Date"
              type="date"
              value={paymentEditForm.date || ""}
              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, date: e.target.value }))}
            />
            <InputField
              label="Montant"
              type="number"
              min="0"
              step="0.01"
              value={paymentEditForm.amount || ""}
              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, amount: e.target.value }))}
            />
            <SelectField
              label="Mode"
              value={paymentEditForm.method || "virement"}
              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, method: e.target.value }))}
            >
              <option value="virement">Virement</option>
              <option value="cheque">Chèque</option>
              <option value="especes">Espèces</option>
              <option value="manuel">Manuel</option>
            </SelectField>
            <SelectField
              label="Compte de règlement"
              value={paymentEditForm.accounting_category || "512 Banque"}
              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, accounting_category: e.target.value }))}
            >
              {PAYMENT_ACCOUNTING_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectField>
            <InputField
              label={(paymentEditForm.settlement_mode || "bank") === "manual" ? "Motif" : "Référence"}
              value={paymentEditForm.reference || ""}
              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, reference: e.target.value }))}
              placeholder="Réf."
            />
            <InputField
              label="Justificatif"
              value={paymentEditForm.receipt_label || ""}
              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, receipt_label: e.target.value }))}
              placeholder="Libellé banque, caisse ou note comptable"
            />
            <InputField
              label="Lien justificatif"
              value={paymentEditForm.receipt_url || ""}
              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, receipt_url: e.target.value }))}
              placeholder="URL du reçu ou de la preuve comptable"
            />
            <div className="grid gap-2">
              <PrimaryButton onClick={savePaymentEdit} disabled={paymentBusyId === editingPaymentId}>
                {paymentBusyId === editingPaymentId ? "…" : "Enregistrer"}
              </PrimaryButton>
              <SecondaryButton onClick={() => setEditingPaymentId(null)}>Annuler</SecondaryButton>
            </div>
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="pf-invoice-detail min-h-screen">
      <InvoiceDetailToolbar
        invoice={invoice}
        status={status}
        accountingReadiness={invoice?.accounting_readiness}
        documentLabel={documentLabel}
        isDraft={isDraft}
        canDuplicate={canDuplicate}
        actionBusy={actionBusy}
        issueProgress={issueProgress}
        liveActionsDisabled={trialDraftOnly}
        onIssue={issueInvoice}
        onDuplicate={duplicateInvoice}
      />

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="p-5 lg:p-6"
      >
        <div className="w-full space-y-5">
          {trialDraftOnly ? (
            <NoticeBanner tone="info" title="Essai Pro · brouillons uniquement">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{TRIAL_LIVE_ACTION_MESSAGE}</span>
                <Link
                  to="/app/billing"
                  className="rounded-full border border-[#bfdbfe] bg-white px-3 py-1 text-xs font-extrabold text-[#1d4ed8] hover:bg-[#eff6ff]"
                >
                  Choisir un abonnement
                </Link>
              </div>
            </NoticeBanner>
          ) : null}
          {issueProgress ? (
            <NoticeBanner tone="info" title="Émission de la facture" className="pf-invoice-job-status">
              <div className="flex flex-wrap items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>{issueProgress}</span>
              </div>
            </NoticeBanner>
          ) : null}
          {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
          {error ? (
            <NoticeBanner tone="danger">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{error}</span>
                {errorAction?.error === error ? (
                  <Link
                    to={errorAction.href}
                    className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-50"
                  >
                    {errorAction.label}
                  </Link>
                ) : null}
              </div>
            </NoticeBanner>
          ) : null}
          {invoice ? (
            <AccountingLineCorrectionPanel
              documentId={invoice.id}
              documentType="invoice"
              status={invoice.status}
              lines={invoice.lines}
              onSaved={loadDetail}
            />
          ) : null}
          {!hydrated && loading ? (
            <EmptyCard title="Facture" description="Ouverture de la facture." />
          ) : loading ? (
            <LoadingCard label="Chargement de la facture…" />
          ) : !invoice ? (
            <EmptyCard title="Facture introuvable" description="Ce document n'a pas pu être chargé." />
          ) : (
            <>
              {issueChecklistItems.length ? (
                <section className="panel rounded-2xl border border-[#fed7aa] bg-[#fff7ed] p-5">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#ffedd5] text-[#c2410c]">
                      <AlertTriangle className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
                        Facture à compléter
                      </h2>
                      <p className="mt-1 text-[#9a3412]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                        Corrigez ces éléments avant de relancer l’émission.
                      </p>
                      <div className="mt-3 space-y-2">
                        {issueChecklistItems.map((item) => (
                          <div
                            key={item.key}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#fed7aa] bg-white px-3 py-2"
                          >
                            <span className="text-[#7c2d12]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                              {item.label}
                            </span>
                            <Link
                              to={item.href}
                              className="text-[#1d4ed8] hover:text-[#1e40af]"
                              style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                            >
                              {item.actionLabel}
                            </Link>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              ) : null}

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
                <div className="space-y-4">
                  <InvoiceLatePaymentAlert
                    invoice={invoice}
                    canFollowup={canFollowup}
                    actionBusy={actionBusy}
                    onFollowup={openFollowupEmail}
                  />
                  <InvoiceFinancialSummary
                    invoice={invoice}
                    nextAction={invoiceNextAction}
                    latestTransmission={latestTransmission}
                    paymentsEnabled={paymentsEnabled}
                  />
                  <InvoicePreviewFrame
                    onPrint={() => downloadArtifact(`/api/invoices/${id}/pdf?inline=1`, true)}
                    htmlPreviewPath={`/api/invoices/${id}/preview.html`}
                    previewVersion={invoicePreviewVersion}
                  >
                    <InvoiceDocumentPreview invoice={invoice} company={company} customer={customer} status={status} />
                  </InvoicePreviewFrame>
                </div>

                <aside className="pf-invoice-rail self-start xl:sticky xl:top-0">
                  <InvoiceClientHistoryPanel invoice={invoice} customer={customer} customerSummary={customerSummary} />

                  <InvoiceSidebarActions modules={invoiceSummaryModules} />

                  <InvoiceHistoryTimeline
                    invoice={invoice}
                    customer={customer}
                    company={company}
                    latestTransmission={latestTransmission}
                    lastPayment={lastPay}
                    documentLabelLower={documentLabelLower}
                    open={isRailOpen("history")}
                    onToggle={() => toggleRailSection("history")}
                  />

                  {showLegacyActionRails ? (
                    <RailSection
                      id="invoice-rail-transmission"
                      title="Transmission"
                      icon={Zap}
                      tone="blue"
                      collapsible
                      open={isRailOpen("transmission")}
                      onToggle={() => toggleRailSection("transmission")}
                    >
                      <div />
                    </RailSection>
                  ) : null}

                  <RailSection
                    id="invoice-rail-document"
                    title="Document"
                    icon={FileText}
                    tone="blue"
                    collapsible
                    open={isRailOpen("document")}
                    onToggle={() => toggleRailSection("document")}
                  >
                    <RailRow label="Numéro" value={invoice?.number || "Brouillon"} />
                    <RailRow label="Client" value={customer?.name || invoice?.customer_name || "—"} />
                    <RailRow label="Émission" value={formatDateFr(invoice?.issue_date, "—")} />
                    <RailRow label="Échéance" value={formatDateFr(invoice?.due_date, "—")} />
                    <RailRow label="Commande" value={invoice?.purchase_order_number || "—"} />
                    {invoice?.type === "credit_note" ? (
                      <div className="rounded-xl border border-[#dbeafe] bg-[#eff6ff] px-3 py-2">
                        <div
                          className="text-[#64748b]"
                          style={{ fontSize: "0.68rem", fontWeight: 800, textTransform: "uppercase" }}
                        >
                          Facture source
                        </div>
                        {invoice?.related_invoice_id ? (
                          <Link
                            to={`/app/invoices/${invoice.related_invoice_id}`}
                            className="mt-1 block truncate text-[#1d4ed8] transition hover:text-[#1e40af]"
                            style={{ fontSize: "0.78rem", fontWeight: 900 }}
                          >
                            {invoice.related_invoice_number || shortRef(invoice.related_invoice_id)}
                          </Link>
                        ) : (
                          <div className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.78rem", fontWeight: 800 }}>
                            Non rattachée
                          </div>
                        )}
                        {invoice?.related_invoice_issue_date || invoice?.related_invoice_total_inc_vat ? (
                          <div className="mt-1 text-[#64748b]" style={{ fontSize: "0.68rem", fontWeight: 700 }}>
                            {formatDateFr(invoice?.related_invoice_issue_date, "—")} ·{" "}
                            {money(
                              Math.abs(Number(invoice?.related_invoice_total_inc_vat || 0)),
                              invoice?.currency || "EUR",
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {invoice?.type === "invoice" &&
                    Array.isArray(invoice?.credit_notes) &&
                    invoice.credit_notes.length ? (
                      <div className="space-y-2 rounded-xl border border-[#fed7aa] bg-[#fffbeb] px-3 py-2">
                        <div
                          className="text-[#92400e]"
                          style={{ fontSize: "0.68rem", fontWeight: 800, textTransform: "uppercase" }}
                        >
                          Avoirs liés
                        </div>
                        {invoice.credit_notes.map((note: any) => (
                          <Link
                            key={note.id}
                            to={`/app/invoices/${note.id}`}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5 text-[#0f172a] transition hover:bg-[#fff7ed]"
                            style={{ fontSize: "0.72rem", fontWeight: 850 }}
                          >
                            <span className="min-w-0 truncate">{note.number || "Avoir brouillon"}</span>
                            <span className="shrink-0 text-[#92400e]">
                              {money(Math.abs(Number(note.total_inc_vat || 0)), invoice?.currency || "EUR")}
                            </span>
                          </Link>
                        ))}
                      </div>
                    ) : null}
                    {facturxArtifactAvailable ? (
                      <RailRow label="Factur-X" value={formatFacturxProfileLabel(invoice?.facturx_profile)} />
                    ) : null}
                  </RailSection>

                  {showLegacyActionRails ? (
                    invoice?.type === "invoice" ? (
                      <RailSection
                        id="invoice-rail-avoirs"
                        title="Avoirs"
                        icon={ReceiptText}
                        tone="amber"
                        collapsible
                        open={isRailOpen("avoirs")}
                        onToggle={() => toggleRailSection("avoirs")}
                      >
                        <div className="space-y-3">
                          <RailRow label="Déjà crédité" value={money(creditNotesTotal, invoice?.currency || "EUR")} />
                          <RailRow
                            label="Reste créditable"
                            value={money(creditNoteRemaining, invoice?.currency || "EUR")}
                          />
                          {canCreateCreditNote ? (
                            <div
                              className="rounded-xl border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-[#92400e]"
                              style={{ fontSize: "0.75rem", lineHeight: 1.45 }}
                            >
                              L'avoir se crée depuis la carte Avoirs des actions financières.
                            </div>
                          ) : (
                            <div
                              className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-[#64748b]"
                              style={{ fontSize: "0.75rem", lineHeight: 1.45 }}
                            >
                              {invoice.status === "draft"
                                ? "Émettez la facture avant de créer un avoir."
                                : creditNoteRemaining <= 0.01
                                  ? "Cette facture est déjà intégralement créditée."
                                  : "Aucune ligne créditable."}
                            </div>
                          )}
                          {Array.isArray(invoice.credit_notes) && invoice.credit_notes.length ? (
                            <div className="space-y-2">
                              {invoice.credit_notes.map((note: any) => (
                                <Link
                                  key={note.id}
                                  to={`/app/invoices/${note.id}`}
                                  className="flex items-center justify-between gap-3 rounded-xl border border-[#e2e8f0] bg-white px-3 py-2 transition hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
                                >
                                  <span className="min-w-0">
                                    <span
                                      className="block truncate text-[#0f172a]"
                                      style={{ fontSize: "0.78rem", fontWeight: 850 }}
                                    >
                                      {note.number || "Avoir brouillon"}
                                    </span>
                                    <span
                                      className="block text-[#94a3b8]"
                                      style={{ fontSize: "0.68rem", fontWeight: 700 }}
                                    >
                                      {formatDateFr(note.issue_date, "—")}
                                    </span>
                                  </span>
                                  <span
                                    className="shrink-0 text-[#0f172a]"
                                    style={{ fontSize: "0.78rem", fontWeight: 850 }}
                                  >
                                    {money(Math.abs(Number(note.total_inc_vat || 0)), invoice?.currency || "EUR")}
                                  </span>
                                </Link>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </RailSection>
                    ) : (
                      <RailSection
                        id="invoice-rail-remboursement"
                        title="Remboursement"
                        icon={ReceiptText}
                        tone="amber"
                        collapsible
                        open={isRailOpen("remboursement")}
                        onToggle={() => toggleRailSection("remboursement")}
                      >
                        <div className="space-y-3">
                          <RailRow
                            label="Montant de l'avoir"
                            value={money(Math.abs(Number(invoice?.total_inc_vat || 0)), invoice?.currency || "EUR")}
                          />
                          <RailRow
                            label="Déjà remboursé"
                            value={money(invoice?.refunds_total || 0, invoice?.currency || "EUR")}
                          />
                          <RailRow
                            label="À rembourser"
                            value={money(invoice?.refund_balance || 0, invoice?.currency || "EUR")}
                          />
                          {canRefundCreditNote ? (
                            <div className="space-y-3 rounded-xl border border-[#bfdbfe] bg-[#eff6ff] p-3">
                              <InputField
                                label="Date"
                                type="date"
                                value={refundForm.date || ""}
                                onChange={(e) => setRefundForm((p: any) => ({ ...p, date: e.target.value }))}
                              />
                              <InputField
                                label="Montant"
                                type="number"
                                min="0.01"
                                step="0.01"
                                value={refundForm.amount || ""}
                                onChange={(e) => setRefundForm((p: any) => ({ ...p, amount: e.target.value }))}
                              />
                              <SelectField
                                label="Mode"
                                value={refundForm.method || "virement"}
                                onChange={(e) => setRefundForm((p: any) => ({ ...p, method: e.target.value }))}
                              >
                                <option value="virement">Virement</option>
                                <option value="cheque">Chèque</option>
                                <option value="especes">Espèces</option>
                                <option value="manuel">Manuel</option>
                              </SelectField>
                              <InputField
                                label="Référence"
                                value={refundForm.reference || ""}
                                onChange={(e) => setRefundForm((p: any) => ({ ...p, reference: e.target.value }))}
                                placeholder="Réf. remboursement"
                              />
                              <PrimaryButton
                                onClick={registerRefund}
                                disabled={refundSaving || !canRefundCreditNote || !refundAmountValid}
                              >
                                {refundSaving ? "…" : "Enregistrer le remboursement"}
                              </PrimaryButton>
                            </div>
                          ) : (
                            <div
                              className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-[#64748b]"
                              style={{ fontSize: "0.75rem", lineHeight: 1.45 }}
                            >
                              {invoice.status === "draft" ? "Émettez l'avoir avant de rembourser." : "Avoir soldé."}
                            </div>
                          )}
                          {Array.isArray(invoice.refunds) && invoice.refunds.length ? (
                            <div className="space-y-2">
                              {invoice.refunds.map((refund: any) => (
                                <div key={refund.id} className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                                  <div className="font-bold text-[#0f172a]" style={{ fontSize: "0.78rem" }}>
                                    {money(refund.amount || 0, invoice?.currency || "EUR")}
                                  </div>
                                  <div className="text-[#94a3b8]" style={{ fontSize: "0.68rem", fontWeight: 700 }}>
                                    {formatDateTimeFr(refund.date, "—")} · {refund.method || "mode non précisé"}
                                  </div>
                                  {refund.reference ? (
                                    <div className="text-[#64748b]" style={{ fontSize: "0.68rem" }}>
                                      {shortRef(refund.reference)}
                                    </div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </RailSection>
                    )
                  ) : null}

                  {showLegacyActionRails ? (
                    <RailSection
                      id="invoice-rail-encaissement"
                      title="Encaissement"
                      icon={Wallet}
                      tone="green"
                      collapsible
                      open={isRailOpen("encaissement")}
                      onToggle={() => toggleRailSection("encaissement")}
                    >
                      <div id="invoice-payment-card" className="space-y-3">
                        <InvoicePaymentMetrics
                          total={money(invoice?.total_inc_vat || 0, invoice?.currency || "EUR")}
                          paid={money(
                            Math.max(0, Number(invoice?.total_inc_vat || 0) - Number(invoice?.balance_due || 0)),
                            invoice?.currency || "EUR",
                          )}
                          due={money(invoice?.balance_due || 0, invoice?.currency || "EUR")}
                          last={lastPay ? money(lastPay.amount || 0, invoice?.currency || "EUR") : "—"}
                        />

                        {invoice.status === "overdue" ? (
                          <div
                            className="rounded-xl border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[#991b1b]"
                            style={{ fontSize: "0.75rem", fontWeight: 650 }}
                          >
                            Facture en retard. Relance ou règlement conseillé.
                          </div>
                        ) : null}

                        {showPaymentCreateForm ? (
                          <div className="space-y-3 rounded-xl border border-[#bfdbfe] bg-[#eff6ff] p-3">
                            <div className="grid grid-cols-3 gap-1.5">
                              {PAYMENT_SETTLEMENT_OPTIONS.map((option) => {
                                const active = (paymentForm.settlement_mode || "bank") === option.value;
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => updatePaymentSettlement(setPaymentForm, option.value)}
                                    className={`h-9 rounded-lg border px-2 transition ${
                                      active
                                        ? "border-[#2563eb] bg-white text-[#1d4ed8] shadow-sm"
                                        : "border-[#dbe4ef] bg-[#f8fbff] text-[#64748b] hover:border-[#bfdbfe]"
                                    }`}
                                    style={{ fontSize: "0.72rem", fontWeight: 800 }}
                                  >
                                    {option.label}
                                  </button>
                                );
                              })}
                            </div>
                            <InputField
                              label="Date"
                              type="date"
                              value={paymentForm.date || ""}
                              onChange={(e) => setPaymentForm((p: any) => ({ ...p, date: e.target.value }))}
                            />
                            <InputField
                              label="Montant"
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={paymentForm.amount || ""}
                              onChange={(e) => setPaymentForm((p: any) => ({ ...p, amount: e.target.value }))}
                            />
                            <SelectField
                              label="Mode"
                              value={paymentForm.method || "virement"}
                              onChange={(e) => setPaymentForm((p: any) => ({ ...p, method: e.target.value }))}
                            >
                              <option value="virement">Virement</option>
                              <option value="cheque">Chèque</option>
                              <option value="especes">Espèces</option>
                              <option value="manuel">Manuel</option>
                            </SelectField>
                            <SelectField
                              label="Compte de règlement"
                              value={paymentForm.accounting_category || "512 Banque"}
                              onChange={(e) =>
                                setPaymentForm((p: any) => ({ ...p, accounting_category: e.target.value }))
                              }
                            >
                              {PAYMENT_ACCOUNTING_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </SelectField>
                            <InputField
                              label={(paymentForm.settlement_mode || "bank") === "manual" ? "Motif" : "Référence"}
                              value={paymentForm.reference || ""}
                              onChange={(e) => setPaymentForm((p: any) => ({ ...p, reference: e.target.value }))}
                              placeholder={
                                (paymentForm.settlement_mode || "bank") === "manual"
                                  ? "Marquage sans transaction"
                                  : "Réf. virement, chèque ou reçu"
                              }
                            />
                            <InputField
                              label="Justificatif"
                              value={paymentForm.receipt_label || ""}
                              onChange={(e) => setPaymentForm((p: any) => ({ ...p, receipt_label: e.target.value }))}
                              placeholder="Libellé banque, caisse ou note comptable"
                            />
                            <InputField
                              label="Lien justificatif"
                              value={paymentForm.receipt_url || ""}
                              onChange={(e) => setPaymentForm((p: any) => ({ ...p, receipt_url: e.target.value }))}
                              placeholder="URL du reçu ou de la preuve comptable"
                            />
                            <PrimaryButton
                              onClick={registerPayment}
                              disabled={paymentSaving || !canPay || !paymentAmountValid}
                            >
                              {paymentSaving ? "…" : "Enregistrer le règlement"}
                            </PrimaryButton>
                          </div>
                        ) : showPaymentCard && Number(invoice?.balance_due || 0) > 0 ? (
                          <div
                            className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-[#64748b]"
                            style={{ fontSize: "0.75rem" }}
                          >
                            {manualPaymentHelp()}
                          </div>
                        ) : null}

                        {(invoice.payments || []).length ? (
                          <div className="space-y-2">
                            {invoice.payments.map((pay: any) => (
                              <div key={pay.id} className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div>
                                    <div className="font-bold text-[#0f172a]" style={{ fontSize: "0.78rem" }}>
                                      {money(pay.amount || 0, invoice?.currency || "EUR")}
                                    </div>
                                    <div className="text-[#94a3b8]" style={{ fontSize: "0.68rem" }}>
                                      {formatDateTimeFr(pay.date, "—")} · {paymentSettlementLabel(pay.settlement_mode)}{" "}
                                      · {pay.accounting_category || "cat. à compléter"}
                                    </div>
                                    <div className="text-[#64748b]" style={{ fontSize: "0.68rem" }}>
                                      {pay.receipt_label || shortRef(pay.reference)}
                                      {pay.receipt_url ? (
                                        <>
                                          {" · "}
                                          <a
                                            href={pay.receipt_url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="font-bold text-[#2563eb] hover:underline"
                                          >
                                            Preuve
                                          </a>
                                        </>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="flex gap-1">
                                    <button
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#bfdbfe] bg-[#eff6ff] text-[#2563eb]"
                                      onClick={() => startEditPayment(pay)}
                                      aria-label="Modifier le règlement"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#fecaca] bg-[#fef2f2] text-[#dc2626] disabled:opacity-50"
                                      onClick={() => void deletePayment(pay)}
                                      disabled={paymentBusyId === pay.id}
                                      aria-label="Supprimer le règlement"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {editingPaymentId ? (
                          <div className="space-y-3 rounded-xl border border-[#dbe4ef] bg-white p-3">
                            <div className="flex items-center justify-between">
                              <div className="font-bold text-[#0f172a]" style={{ fontSize: "0.82rem" }}>
                                Modifier le règlement
                              </div>
                              <button
                                className="text-xs font-bold text-[#64748b] hover:text-[#0f172a]"
                                onClick={() => setEditingPaymentId(null)}
                              >
                                Fermer
                              </button>
                            </div>
                            <div className="grid grid-cols-3 gap-1.5">
                              {PAYMENT_SETTLEMENT_OPTIONS.map((option) => {
                                const active = (paymentEditForm.settlement_mode || "bank") === option.value;
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => updatePaymentSettlement(setPaymentEditForm, option.value)}
                                    className={`h-9 rounded-lg border px-2 transition ${
                                      active
                                        ? "border-[#2563eb] bg-[#eff6ff] text-[#1d4ed8]"
                                        : "border-[#dbe4ef] bg-white text-[#64748b] hover:border-[#bfdbfe]"
                                    }`}
                                    style={{ fontSize: "0.72rem", fontWeight: 800 }}
                                  >
                                    {option.label}
                                  </button>
                                );
                              })}
                            </div>
                            <InputField
                              label="Date"
                              type="date"
                              value={paymentEditForm.date || ""}
                              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, date: e.target.value }))}
                            />
                            <InputField
                              label="Montant"
                              type="number"
                              min="0"
                              step="0.01"
                              value={paymentEditForm.amount || ""}
                              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, amount: e.target.value }))}
                            />
                            <SelectField
                              label="Mode"
                              value={paymentEditForm.method || "virement"}
                              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, method: e.target.value }))}
                            >
                              <option value="virement">Virement</option>
                              <option value="cheque">Chèque</option>
                              <option value="especes">Espèces</option>
                              <option value="manuel">Manuel</option>
                            </SelectField>
                            <SelectField
                              label="Compte de règlement"
                              value={paymentEditForm.accounting_category || "512 Banque"}
                              onChange={(e) =>
                                setPaymentEditForm((p: any) => ({ ...p, accounting_category: e.target.value }))
                              }
                            >
                              {PAYMENT_ACCOUNTING_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </SelectField>
                            <InputField
                              label={(paymentEditForm.settlement_mode || "bank") === "manual" ? "Motif" : "Référence"}
                              value={paymentEditForm.reference || ""}
                              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, reference: e.target.value }))}
                              placeholder="Réf."
                            />
                            <InputField
                              label="Justificatif"
                              value={paymentEditForm.receipt_label || ""}
                              onChange={(e) =>
                                setPaymentEditForm((p: any) => ({ ...p, receipt_label: e.target.value }))
                              }
                              placeholder="Libellé banque, caisse ou note comptable"
                            />
                            <InputField
                              label="Lien justificatif"
                              value={paymentEditForm.receipt_url || ""}
                              onChange={(e) => setPaymentEditForm((p: any) => ({ ...p, receipt_url: e.target.value }))}
                              placeholder="URL du reçu ou de la preuve comptable"
                            />
                            <div className="grid gap-2">
                              <PrimaryButton onClick={savePaymentEdit} disabled={paymentBusyId === editingPaymentId}>
                                {paymentBusyId === editingPaymentId ? "…" : "Enregistrer"}
                              </PrimaryButton>
                              <SecondaryButton onClick={() => setEditingPaymentId(null)}>Annuler</SecondaryButton>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </RailSection>
                  ) : null}

                  <RailSection
                    id="invoice-rail-partage"
                    title="Partage client"
                    icon={Globe}
                    tone="blue"
                    rightSlot={
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
                        style={{
                          background: shareStatusTone.bg,
                          border: `1px solid ${shareStatusTone.border}`,
                          color: shareStatusTone.text,
                          fontSize: "0.62rem",
                          fontWeight: 800,
                        }}
                      >
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: shareStatusTone.dot }} />
                        {shareStatusLabel}
                      </span>
                    }
                    collapsible
                    open={isRailOpen("partage")}
                    onToggle={() => toggleRailSection("partage")}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="min-w-0 flex-1 truncate rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 font-mono text-[#64748b]"
                        style={{ fontSize: "0.68rem" }}
                        title={shareUrl || "Aucun lien actif"}
                      >
                        {shareUrl || "Aucun lien actif"}
                      </div>
                      <GuidanceTooltip content="Copie le lien public du document.">
                        <button
                          type="button"
                          onClick={async () => {
                            if (!shareUrl) return;
                            await copyTextToClipboard(shareUrl);
                            setShareCopied(true);
                            setNotice("Lien copié.");
                            window.setTimeout(() => setShareCopied(false), 1400);
                          }}
                          disabled={!shareUrl}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#e2e8f0] bg-white text-[#64748b] transition hover:border-[#bfdbfe] hover:bg-[#eff6ff] hover:text-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-45"
                          aria-label="Copier le lien public"
                        >
                          {shareCopied ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-[#059669]" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </GuidanceTooltip>
                    </div>

                    <div
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[#94a3b8]"
                      style={{ fontSize: "0.72rem" }}
                    >
                      <span className="text-[#64748b]">{shareViewSummary}</span>
                    </div>

                    {shareMessage ? (
                      <div
                        className="rounded-xl px-3 py-2 leading-5"
                        style={{
                          background: shareStatusTone.bg,
                          border: `1px solid ${shareStatusTone.border}`,
                          color: shareStatusTone.text,
                          fontSize: "0.74rem",
                          fontWeight: 700,
                        }}
                      >
                        {shareMessage}
                      </div>
                    ) : null}

                    <div className="flex gap-2">
                      {!shareActive && canWriteInvoices ? (
                        <GuidanceTooltip content="Créez un lien portail sécurisé que vous pouvez envoyer au client.">
                          <button
                            type="button"
                            onClick={() => updateShare("enable")}
                            disabled={shareBusy}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 transition disabled:cursor-not-allowed disabled:opacity-55"
                            style={{
                              background: "#f0fdf4",
                              borderColor: "#bbf7d0",
                              color: "#059669",
                              fontSize: "0.75rem",
                              fontWeight: 800,
                            }}
                          >
                            <Globe className="h-3.5 w-3.5" />
                            <span>{shareExpired ? "Renouveler le lien" : "Activer le lien"}</span>
                          </button>
                        </GuidanceTooltip>
                      ) : (
                        <>
                          <GuidanceTooltip content="Ouvrez le portail client pour vérifier ce que le client verra.">
                            <button
                              type="button"
                              onClick={() => {
                                if (!shareUrl) return;
                                window.open(shareUrl, "_blank", "noopener,noreferrer");
                              }}
                              disabled={!shareUrl}
                              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#e2e8f0] bg-white px-3 py-2 text-[#334155] transition hover:border-[#bfdbfe] hover:bg-[#eff6ff] hover:text-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-55"
                              style={{ fontSize: "0.75rem", fontWeight: 800 }}
                            >
                              <ExternalLink className="h-3.5 w-3.5" /> Ouvrir
                            </button>
                          </GuidanceTooltip>
                          {canWriteInvoices ? (
                            <GuidanceTooltip content="Désactive l'accès client à ce lien public.">
                              <button
                                type="button"
                                onClick={() => updateShare("disable")}
                                disabled={shareBusy}
                                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 transition disabled:cursor-not-allowed disabled:opacity-55"
                                style={{
                                  background: "#fef2f2",
                                  borderColor: "#fecaca",
                                  color: "#dc2626",
                                  fontSize: "0.75rem",
                                  fontWeight: 800,
                                }}
                              >
                                <X className="h-3.5 w-3.5" /> Désactiver
                              </button>
                            </GuidanceTooltip>
                          ) : null}
                          {canWriteInvoices ? (
                            <GuidanceTooltip content="Régénère un nouveau lien et invalide l'ancien.">
                              <button
                                type="button"
                                onClick={() => updateShare("rotate")}
                                disabled={shareBusy}
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#e2e8f0] bg-white text-[#64748b] transition hover:border-[#bfdbfe] hover:bg-[#eff6ff] hover:text-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-55"
                                aria-label="Régénérer le lien"
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                              </button>
                            </GuidanceTooltip>
                          ) : null}
                        </>
                      )}
                    </div>
                  </RailSection>
                </aside>
              </div>
            </>
          )}
        </div>
      </motion.div>

      {actionPanel && actionPanelMeta ? (
        <InvoiceActionPopin
          title={actionPanelMeta.title}
          icon={actionPanelMeta.icon}
          tone={actionPanelMeta.tone}
          onClose={() => setActionPanel(null)}
        >
          {renderActionPanelContent()}
        </InvoiceActionPopin>
      ) : null}

      <InvoiceEmailModal
        open={!trialDraftOnly && emailOpen}
        previewEndpoint={id ? `/api/invoices/${id}/email/preview` : null}
        defaultEmail={customer?.email || invoice?.customer_email || ""}
        defaultFrom={companyReplyEmailDisplay}
        defaultSubject={invoiceEmailSubject}
        defaultBody={invoiceEmailBody}
        defaultAttachmentName={invoiceAttachmentName}
        showAttachmentFormat={einvoicingEnabled && facturxArtifactAvailable}
        attachmentLabel={
          einvoicingEnabled && facturxArtifactAvailable
            ? "Ajouter la facture en pièce jointe"
            : "Ajouter le PDF de la facture en pièce jointe"
        }
        helperText={
          einvoicingEnabled && facturxArtifactAvailable
            ? "La pièce jointe sera envoyée en Factur-X PDF."
            : "La pièce jointe disponible est le PDF de la facture."
        }
        showSaveDefault
        saveDefaultLabel="Enregistrer ce mail par défaut"
        saveDefaultHelp="Le texte sera réutilisé et adapté automatiquement aux prochaines factures."
        saveDefaultStorageKey="pixfacture:invoice-email-default"
        templateVariables={invoiceEmailTemplateVariables}
        onSaveDefault={saveInvoiceEmailDefault}
        submitting={emailSending}
        onSubmit={sendInvoiceEmail}
        onClose={() => setEmailOpen(false)}
      />
      <InvoiceEmailModal
        open={!trialDraftOnly && paymentsEnabled && followupEmailOpen}
        previewEndpoint={id ? `/api/invoices/${id}/followup/preview` : null}
        previewKind="followup"
        title="Relancer la facture par email"
        submitLabel="Envoyer la relance"
        defaultEmail={customer?.email || invoice?.customer_email || ""}
        allowEmptyRecipient
        recipientPlaceholder="Contacts facturation du client"
        defaultFrom={companyReplyEmailDisplay}
        defaultSubject={invoiceFollowupSubject}
        defaultBody={invoiceFollowupBody}
        defaultAttachmentName={invoiceAttachmentName}
        defaultAttachInvoice={false}
        showAttachmentFormat={false}
        showCopySender={false}
        showCcBcc={false}
        attachmentLabel="Ajouter le PDF de la facture en pièce jointe"
        helperText="L'aperçu reprend exactement le contenu qui sera envoyé au client."
        showSaveDefault
        saveDefaultLabel="Enregistrer cette relance par défaut"
        saveDefaultHelp="Le texte sera réutilisé et adapté automatiquement aux prochaines relances."
        saveDefaultStorageKey="pixfacture:invoice-followup-email-default"
        templateVariables={invoiceEmailTemplateVariables}
        onSaveDefault={saveInvoiceFollowupDefault}
        submitting={followupSending}
        onSubmit={sendFollowupEmail}
        onClose={() => setFollowupEmailOpen(false)}
      />
      <CreditNoteModal
        open={creditNoteOpen}
        invoiceNumber={invoice?.number || null}
        currency={invoice?.currency || "EUR"}
        lines={creditNoteLines}
        submitting={creditNoteSubmitting}
        onSubmit={createCreditNote}
        onClose={() => setCreditNoteOpen(false)}
      />
    </div>
  );
}

/* ════════════════════════════════════════════════ NEW ════ */
export function InvoiceNewPage() {
  return <InvoiceDocumentEditor mode="invoice" backHref="/app/invoices" />;
}
