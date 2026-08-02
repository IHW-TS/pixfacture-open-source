"use client";

import { type ChangeEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/figma/react-router-compat";
import { api, apiFetch, formatApiError, rawApi, sanitizeUserFacingApiMessage } from "@/lib/api";
import { downloadProtectedFile } from "@/lib/download";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { resolveProFeatureGate } from "@/lib/productCapabilities";
import { useSession } from "@/lib/useSession";
import { useWorkspaceSummary } from "@/lib/useWorkspaceSummary";
import { useHydrated } from "@/lib/useHydrated";
import { SEQINO_MANDATE_CONSENT_TEXT } from "@/lib/seqinoConsent";
import {
  ActionMenu,
  ActionMenuButton,
  ActionMenuLink,
  ActionMenuSeparator,
  AppPageHeader,
  Card,
  DangerButton,
  DataTable,
  DisclosureCard,
  InputField,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SelectField,
  StatCard,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { GuidanceTooltip, InlineHelpTooltip } from "../../components/app/GuidanceTooltip";
import { SeqinoTokenNotice } from "../../components/app/SeqinoTokenNotice";
import { UpgradeNoticeCard } from "../../components/app/UpgradeNoticeCard";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import { AccountingReadinessPanel } from "@/components/AccountingReadinessPanel";
import {
  SalesListBlock,
  SalesMetricCard,
  SalesMetricsGrid,
  getModuleTheme,
} from "../../components/app/SalesModuleLayout";
import {
  LIST_PAGE_SIZE_OPTIONS,
  ListPagination,
  paginateList,
  usePersistedListPageSize,
} from "../../components/app/ListPagination";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Building2,
  Car,
  Check,
  CheckCircle,
  CheckSquare,
  ChevronDown,
  CreditCard,
  Download,
  ExternalLink,
  FileDown,
  FileText,
  Globe,
  Inbox,
  Mail,
  Minus,
  Pencil,
  Percent,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Send,
  Shield,
  Upload,
  Wallet,
  Trash2,
  X,
  XCircle,
} from "lucide-react";

type EinvoicingPillTone = "ok" | "warn" | "danger" | "muted" | "info" | "purple";

const PURCHASE_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const PURCHASE_PAGE_SIZE_STORAGE_KEY = "pixfacture.purchases.pageSize.v1";
const PURCHASE_COMPLETION_DRAFT_VERSION = 1;
const PURCHASE_COMPLETION_DRAFT_PREFIX = "pixfacture.purchase.completionDraft.v1";
const MANUAL_PURCHASE_DRAFT_VERSION = 1;
const MANUAL_PURCHASE_DRAFT_PREFIX = "pixfacture.purchase.manualDraft.v1";

function localDraftKey(prefix: string, id: string) {
  return `${prefix}:${id}`;
}

function readLocalDraft(key: string, version: number) {
  if (typeof window === "undefined" || !key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== version || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalDraft(key: string, payload: Record<string, any>) {
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Local drafts are a best-effort safety net; storage quota errors must not block the editor.
  }
}

function removeLocalDraft(key: string) {
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function readStoredPurchasePageSize() {
  if (typeof window === "undefined") return PURCHASE_PAGE_SIZE_OPTIONS[0];
  const stored = Number(window.localStorage.getItem(PURCHASE_PAGE_SIZE_STORAGE_KEY));
  return PURCHASE_PAGE_SIZE_OPTIONS.some((option) => option === stored) ? stored : PURCHASE_PAGE_SIZE_OPTIONS[0];
}

function money(value: any, currency = "EUR") {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency === "EUR" ? "€" : currency}`;
}

function titleCase(value: string | null | undefined) {
  const raw = (value || "").toString().trim();
  if (!raw) return "—";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (m) => m.toUpperCase());
}

function isInteractiveRowTarget(target: EventTarget | null) {
  return target instanceof Element
    ? Boolean(target.closest("a,button,input,select,textarea,label,[role='button'],[data-no-row-open='true']"))
    : false;
}

function inboxEventLabel(value: string | null | undefined) {
  const normalized = (value || "").toString().trim().toLowerCase();
  const map: Record<string, string> = {
    manual_purchase_created: "Achat manuel créé",
    purchase_completion_saved: "Complétion achat enregistrée",
    purchase_completion_validated: "Complétion achat validée",
    purchase_vat_correction_saved: "Correction TVA enregistrée",
    purchase_vat_correction_validated: "Correction TVA validée",
    acknowledged: "Réception acquittée",
    accepted: "Document accepté",
    rejected: "Document rejeté",
    correction_requested: "Correction fournisseur demandée",
  };
  return map[normalized] || titleCase(normalized || "événement");
}

function numericAmount(value: any) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function inputDateToday() {
  return new Date().toISOString().slice(0, 10);
}

function purchaseFormatLabel(value: string | null | undefined) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "expense_report") return "Note de frais";
  if (normalized === "mileage") return "Frais kilométriques";
  return titleCase(value || "Facture");
}

type ManualPurchaseKind = "expense_report" | "mileage";
type PurchaseKindFilter = "all" | "invoice" | ManualPurchaseKind;
type PurchaseSortDirection = "asc" | "desc";
type PurchaseSortKey = "supplier" | "invoice" | "payment" | "amount" | "status";
type PurchaseSortState = { key: PurchaseSortKey; direction: PurchaseSortDirection };

const purchaseLineInputClass =
  "h-9 w-full rounded-lg border border-[#cbd5e1] bg-white px-2.5 text-[#0f172a] outline-none transition-all placeholder:text-[#94a3b8] focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15 disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#94a3b8]";

function createPurchaseLineDraft(base: any = {}) {
  return {
    label: base?.label || "",
    total_ex_vat: purchaseInputAmount(base?.total_ex_vat),
    vat_rate:
      base?.vat_rate === 0 || base?.vat_rate ? purchaseInputAmount(base.vat_rate) : base?.total_vat === 0 ? "0" : "20",
    total_vat: purchaseInputAmount(base?.total_vat),
    accounting_account: base?.accounting_account || "",
    purchase_nature: base?.purchase_nature || "service",
    vat_category: base?.vat_category || "",
    exemption_reason_code: base?.exemption_reason_code || "",
    vat_exemption_reason: base?.vat_exemption_reason || "",
    vat_zero_reason: base?.vat_zero_reason || "",
    vat_reverse_charge: Boolean(base?.vat_reverse_charge),
    source: base?.source || "",
  };
}

function createManualPurchaseDraft(kind: ManualPurchaseKind) {
  return {
    supplier_name: kind === "mileage" ? "Indemnités kilométriques" : "",
    invoice_number: "",
    issue_date: inputDateToday(),
    total_ex_vat: "",
    total_vat: "0",
    total_ttc: "",
    currency: "EUR",
    note: "",
    distance_km: "",
    vehicle_type: "Voiture",
    round_trip: false,
    purchase_lines: [createPurchaseLineDraft({ purchase_nature: "service", vat_rate: kind === "mileage" ? 0 : 20 })],
  };
}

function countEnabledConnectors(enabled: any) {
  return Object.values(enabled || {}).filter(Boolean).length;
}

function readinessOverallPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  if (normalized === "ready") return { color: "ok", label: "Prêt" };
  if (normalized === "partial") return { color: "warn", label: "Partiel" };
  if (normalized === "not_ready") return { color: "danger", label: "À configurer" };
  return { color: "muted", label: titleCase(normalized || "inconnu") };
}

function readinessCheckPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  if (["ok", "ready"].includes(normalized)) return { color: "ok", label: "OK" };
  if (["missing", "todo", "partial", "not_ready"].includes(normalized))
    return { color: "warn", label: normalized === "partial" ? "Partiel" : "À faire" };
  if (["error", "failed"].includes(normalized)) return { color: "danger", label: "Erreur" };
  if (["na", "roadmap"].includes(normalized))
    return { color: "muted", label: normalized === "na" ? "Non requis" : "Roadmap" };
  return { color: "muted", label: titleCase(normalized || "inconnu") };
}

function onboardingDirectoryPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  if (normalized === "ok") return { color: "ok", label: "Synchronisé" };
  if (normalized === "error") return { color: "danger", label: "Erreur" };
  if (["disabled", "na"].includes(normalized)) return { color: "muted", label: "Non activé" };
  if (normalized === "never") return { color: "warn", label: "Jamais synchronisé" };
  return { color: "muted", label: titleCase(normalized || "inconnu") };
}

function transmissionPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  const map: Record<string, { color: EinvoicingPillTone; label: string }> = {
    accepted: { color: "ok", label: "Acceptée" },
    available: { color: "ok", label: "Disponible" },
    paid: { color: "ok", label: "Payée" },
    submitted: { color: "info", label: "Soumise" },
    sent: { color: "info", label: "Envoyée" },
    queued: { color: "warn", label: "En file" },
    processing: { color: "warn", label: "En cours" },
    pending: { color: "warn", label: "En attente" },
    failed: { color: "danger", label: "Échec" },
    rejected: { color: "danger", label: "Rejetée" },
    refused: { color: "danger", label: "Refusée" },
    blocked: { color: "danger", label: "Bloquée" },
  };
  return map[normalized] || { color: "muted", label: titleCase(normalized || "inconnu") };
}

function transmissionStatusGroup(status: string | null | undefined) {
  const normalized = (status || "").toLowerCase();
  if (["accepted", "available", "paid", "done", "ok", "delivered"].includes(normalized)) return "success";
  if (["submitted", "sent", "queued", "created"].includes(normalized)) return "submitted";
  if (["processing", "pending", "in_progress"].includes(normalized)) return "processing";
  if (["failed", "error", "blocked"].includes(normalized)) return "failed";
  if (["rejected", "refused", "invalid"].includes(normalized)) return "rejected";
  return normalized || "unknown";
}

function inboxStatusPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  const map: Record<string, { color: EinvoicingPillTone; label: string }> = {
    received: { color: "info", label: "Reçue" },
    acknowledged: { color: "purple", label: "Acquittée" },
    accepted: { color: "ok", label: "Acceptée" },
    rejected: { color: "danger", label: "Rejetée" },
    correction_requested: { color: "warn", label: "Correction demandée" },
    imported: { color: "muted", label: "Importée" },
  };
  return map[normalized] || { color: "muted", label: titleCase(normalized || "inconnu") };
}

function validationPill(status: string | null | undefined): { color: EinvoicingPillTone; label: string } {
  const normalized = (status || "").toLowerCase();
  const map: Record<string, { color: EinvoicingPillTone; label: string }> = {
    valid: { color: "ok", label: "Valide" },
    warning: { color: "warn", label: "Avertissement" },
    unavailable: { color: "warn", label: "À vérifier" },
    invalid: { color: "danger", label: "Pièce à corriger" },
    skipped: { color: "muted", label: "Non vérifiée" },
  };
  return map[normalized] || { color: "muted", label: normalized ? titleCase(normalized) : "—" };
}

function validationHelpText(status: string | null | undefined) {
  const normalized = (status || "").toLowerCase();
  if (normalized === "invalid" || normalized === "failed") {
    return "Le paiement peut être enregistré, mais le justificatif fournisseur ne passe pas les contrôles e-facture. Remplacez la pièce avant un export comptable strict.";
  }
  if (normalized === "unavailable") {
    return "Le contrôle automatique n'a pas pu confirmer la conformité du justificatif. Vérifiez la pièce avant export comptable.";
  }
  if (normalized === "warning") {
    return "Le justificatif est exploitable, mais certains points doivent être vérifiés avant export.";
  }
  return null;
}

function purchaseWorkflowPill(workflow: any): { color: EinvoicingPillTone; label: string } {
  const normalized = String(workflow?.state || "new").toLowerCase();
  const labelMap: Record<string, string> = {
    new: "À traiter",
    reviewing: "En revue",
    awaiting_supplier: "Fournisseur",
    approved: "Validé achat",
    ready_to_pay: "À payer",
    booked: "Payé",
  };
  const label = workflow?.state_label || labelMap[normalized] || titleCase(normalized.replaceAll("_", " "));
  const map: Record<string, { color: EinvoicingPillTone; label: string }> = {
    new: { color: "info", label },
    reviewing: { color: "warn", label },
    awaiting_supplier: { color: "danger", label },
    approved: { color: "purple", label },
    ready_to_pay: { color: "purple", label },
    booked: { color: "ok", label },
  };
  return map[normalized] || { color: "muted", label };
}

function purchasePaymentPill(item: any, workflow: any): { color: EinvoicingPillTone; label: string } {
  const state = String(workflow?.state || "new").toLowerCase();
  const reimbursement = String(item?.employee_reimbursement_status || "").toLowerCase();
  if (state === "booked") return { color: "ok", label: "Payé" };
  if (Boolean(item?.paid_by_employee) && reimbursement !== "reimbursed")
    return { color: "warn", label: "À rembourser" };
  if (purchaseNeedsCompletion(item)) return { color: "warn", label: "À compléter" };
  if (state === "approved") return { color: "purple", label: "Validé achat" };
  if (state === "ready_to_pay") return { color: "purple", label: "À payer" };
  if (state === "awaiting_supplier") return { color: "danger", label: "Fournisseur" };
  if (state === "reviewing") return { color: "info", label: "À vérifier" };
  return { color: "info", label: "À traiter" };
}

function purchasePaymentDateLabel(item: any) {
  const dateValue = item?.paid_by_employee
    ? item?.employee_reimbursement_due_date || item?.planned_payment_date
    : item?.planned_payment_date;
  return dateValue ? formatDateFr(dateValue) : "À planifier";
}

function purchasePaymentContext(item: any) {
  if (item?.paid_by_employee) {
    return `Remboursement ${purchaseEmployeeMethodLabel(item?.employee_reimbursement_method)}`;
  }
  const account = purchaseAccountingAccountLabel(item?.accounting_account);
  return account || "Paiement fournisseur";
}

function purchaseRemainingAmount(item: any, workflow: any) {
  const state = String(workflow?.state || "new").toLowerCase();
  if (state === "booked") return 0;
  if (item?.purchase_remaining_ttc !== undefined && item?.purchase_remaining_ttc !== null) {
    return numericAmount(item.purchase_remaining_ttc);
  }
  if (item?.purchase_paid_total !== undefined && item?.purchase_paid_total !== null) {
    return Math.max(0, numericAmount(item?.total_ttc) - numericAmount(item.purchase_paid_total));
  }
  return numericAmount(item?.total_ttc);
}

function purchaseRemainingLabel(item: any, workflow: any) {
  const state = String(workflow?.state || "new").toLowerCase();
  if (state === "booked") return "Soldé";
  const remaining = Math.abs(purchaseRemainingAmount(item, workflow));
  const total = numericAmount(item?.total_ttc);
  const prefix = total < 0 ? "À recevoir" : "À régler";
  return `${prefix} ${money(remaining, item?.currency || "EUR")}`;
}

function purchaseCashFlowMeta(item: any) {
  const amount = numericAmount(item?.total_ttc);
  if (amount < 0) {
    return {
      amount: Math.abs(amount),
      color: "#059669",
      bg: "#ecfdf5",
      border: "#bbf7d0",
      icon: Plus,
      label: "Entrée",
      sign: "+",
    };
  }
  if (amount > 0) {
    return {
      amount,
      color: "#dc2626",
      bg: "#fef2f2",
      border: "#fecaca",
      icon: Minus,
      label: "Sortie",
      sign: "-",
    };
  }
  return {
    amount: 0,
    color: "#64748b",
    bg: "#f8fafc",
    border: "#e2e8f0",
    icon: Minus,
    label: "Neutre",
    sign: "",
  };
}

function normalizePurchaseSortText(value: any) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function purchaseSortDateValue(value: any) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function purchaseSortValue(item: any, workflow: any, key: PurchaseSortKey) {
  if (key === "supplier")
    return normalizePurchaseSortText(`${item?.supplier_name || ""} ${item?.supplier_siret || ""}`);
  if (key === "invoice") {
    return `${purchaseSortDateValue(item?.issue_date)} ${normalizePurchaseSortText(item?.invoice_number || item?.id)}`;
  }
  if (key === "payment") {
    const dateValue = item?.paid_by_employee
      ? item?.employee_reimbursement_due_date || item?.planned_payment_date
      : item?.planned_payment_date;
    return `${purchaseSortDateValue(dateValue)} ${normalizePurchaseSortText(purchasePaymentContext(item))}`;
  }
  if (key === "amount") return numericAmount(item?.total_ttc);
  return normalizePurchaseSortText(purchasePaymentPill(item, workflow).label);
}

function comparePurchaseSortValues(left: string | number, right: string | number) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "fr", { numeric: true, sensitivity: "base" });
}

function comparePurchases(left: any, right: any, sortState: PurchaseSortState, workflowStatesMap: Record<string, any>) {
  const leftWorkflow = workflowStatesMap[left?.id] || {};
  const rightWorkflow = workflowStatesMap[right?.id] || {};
  const result = comparePurchaseSortValues(
    purchaseSortValue(left, leftWorkflow, sortState.key),
    purchaseSortValue(right, rightWorkflow, sortState.key),
  );
  if (result !== 0) return sortState.direction === "asc" ? result : -result;
  return normalizePurchaseSortText(left?.id).localeCompare(normalizePurchaseSortText(right?.id), "fr", {
    numeric: true,
    sensitivity: "base",
  });
}

function PurchaseColumnHeader({
  children,
  sortKey,
  sortState,
  onSort,
  align = "left",
}: {
  children: string;
  sortKey: PurchaseSortKey;
  sortState: PurchaseSortState;
  onSort: (key: PurchaseSortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const active = sortState.key === sortKey;
  const Icon = active ? (sortState.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={`Trier par ${children}`}
      aria-pressed={active}
      className={`group inline-flex w-full items-center gap-1.5 transition-colors hover:text-[#15803d] ${
        align === "right"
          ? "justify-end text-right"
          : align === "center"
            ? "justify-center text-center"
            : "justify-start text-left"
      } ${active ? "pf-sort-header-active text-[#15803d]" : ""}`}
      style={{
        fontSize: "var(--pf-app-table-header)",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        lineHeight: 1.15,
      }}
    >
      <span>{children}</span>
      <Icon className={`h-3.5 w-3.5 ${active ? "text-[#16a34a]" : "text-[#cbd5e1] group-hover:text-[#16a34a]"}`} />
    </button>
  );
}

function purchaseKindKey(item: any): Exclude<PurchaseKindFilter, "all"> {
  const format = String(item?.format || "").toLowerCase();
  if (format === "expense_report") return "expense_report";
  if (format === "mileage") return "mileage";
  return "invoice";
}

function purchaseNeedsCompletion(item: any) {
  const validation = String(item?.validation_status || "").toLowerCase();
  const completion = String(item?.completion_status || "").toLowerCase();
  const kind = purchaseKindKey(item);
  const supplierReady = Boolean(String(item?.supplier_name || "").trim());
  const employeePayerReady = !item?.paid_by_employee || Boolean(String(item?.employee_payer_name || "").trim());
  const purchaseLines = Array.isArray(item?.purchase_lines) ? item.purchase_lines : [];
  const lineAccountingReady =
    purchaseLines.filter((line: any) => numericAmount(line?.total_ex_vat) > 0).length > 0 &&
    purchaseLines
      .filter((line: any) => numericAmount(line?.total_ex_vat) > 0)
      .every((line: any) => purchaseAccountingAccountReady(line?.accounting_account));
  const hasMissingSignals =
    !supplierReady ||
    !employeePayerReady ||
    (kind === "invoice" && !String(item?.invoice_number || "").trim()) ||
    !item?.issue_date ||
    numericAmount(item?.total_ttc) < 0 ||
    (!purchaseAccountingAccountReady(item?.accounting_account) && !lineAccountingReady) ||
    ["invalid", "warning", "unavailable"].includes(validation) ||
    (kind === "invoice" && validation === "skipped");
  return completion !== "completed" || hasMissingSignals;
}

function purchaseNeedsVatCorrection(item: any) {
  const validation = String(item?.validation_status || "").toLowerCase();
  const status = String(item?.status || "").toLowerCase();
  const completion = String(item?.completion_status || "").toLowerCase();
  const reviewedAt = String(item?.completion_validated_at || "").trim();
  const currency = String(item?.currency || "EUR").toUpperCase();
  const totalHt = numericAmount(item?.total_ex_vat);
  const totalVat = numericAmount(item?.total_vat);
  const totalTtc = numericAmount(item?.total_ttc);
  const lines = Array.isArray(item?.purchase_lines) ? item.purchase_lines : [];
  const zeroVatMissingReason =
    totalTtc > 0 &&
    totalVat <= 0 &&
    (!lines.length ||
      lines.some((line: any) => {
        const lineHt = numericAmount(line?.total_ex_vat);
        const lineVat = numericAmount(line?.total_vat);
        return lineHt > 0 && lineVat <= 0 && !purchaseLineZeroVatHasReason(line);
      }));
  return (
    completion !== "completed" ||
    (zeroVatMissingReason && !reviewedAt) ||
    Math.abs(totalHt + totalVat - totalTtc) > 0.02 ||
    ["rejected", "duplicate", "canceled"].includes(status) ||
    ["invalid", "failed", "unavailable", "warning"].includes(validation) ||
    currency !== "EUR"
  );
}

const purchaseAccountingAccountOptions = [
  { value: "", label: "Non renseigné" },
  { value: "604", label: "Études / prestations achetées · 604" },
  { value: "606", label: "Fournitures · 606" },
  { value: "607", label: "Marchandises · 607" },
  { value: "611", label: "Sous-traitance · 611" },
  { value: "613", label: "Location · 613" },
  { value: "615", label: "Entretien / maintenance · 615" },
  { value: "622", label: "Honoraires · 622" },
  { value: "623", label: "Publicité · 623" },
  { value: "625", label: "Déplacements / repas · 625" },
  { value: "626", label: "Hébergement / télécom · 626" },
  { value: "627", label: "Frais bancaires · 627" },
  { value: "471", label: "Je ne sais pas / demander au comptable · 471" },
];

const PURCHASE_ACCOUNT_CUSTOM_VALUE = "__custom_account__";

function sanitizePurchaseAccountingAccount(value: any) {
  return String(value || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9._-]/g, "")
    .slice(0, 20);
}

function isPurchaseAccountingPreset(value: any) {
  const clean = String(value || "").trim();
  return purchaseAccountingAccountOptions.some((option) => option.value === clean);
}

function PurchaseAccountingAccountField({
  label,
  help,
  value,
  disabled,
  onChange,
  selectClassName,
  inputClassName,
  selectStyle,
}: {
  label?: string;
  help?: ReactNode;
  value: any;
  disabled?: boolean;
  onChange: (value: string) => void;
  selectClassName: string;
  inputClassName?: string;
  selectStyle?: any;
}) {
  const generatedId = useId();
  const selectId = `purchase-account-${generatedId.replace(/:/g, "")}`;
  const customInputId = `${selectId}-custom`;
  const cleanValue = String(value || "").trim();
  const [customMode, setCustomMode] = useState(Boolean(cleanValue && !isPurchaseAccountingPreset(cleanValue)));
  const accountHelp =
    help ||
    (label
      ? "Catégorie utilisée pour classer l'achat dans le dossier comptable. Laissez vide si vous voulez la compléter plus tard."
      : null);
  const selectedValue =
    customMode || (cleanValue && !isPurchaseAccountingPreset(cleanValue)) ? PURCHASE_ACCOUNT_CUSTOM_VALUE : cleanValue;

  useEffect(() => {
    if (cleanValue && !isPurchaseAccountingPreset(cleanValue)) {
      setCustomMode(true);
    }
  }, [cleanValue]);

  const select = (
    <>
      <select
        id={selectId}
        disabled={disabled}
        value={selectedValue}
        onChange={(event) => {
          if (event.target.value === PURCHASE_ACCOUNT_CUSTOM_VALUE) {
            setCustomMode(true);
            if (isPurchaseAccountingPreset(cleanValue)) onChange("");
            return;
          }
          setCustomMode(false);
          onChange(event.target.value);
        }}
        className={selectClassName}
        style={selectStyle}
        aria-label={label || "Catégorie compta"}
      >
        {purchaseAccountingAccountOptions.map((option) => (
          <option key={option.value || "empty"} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value={PURCHASE_ACCOUNT_CUSTOM_VALUE}>Code fourni par mon comptable</option>
      </select>
      {customMode ? (
        <input
          id={customInputId}
          disabled={disabled}
          value={cleanValue}
          onChange={(event) => onChange(sanitizePurchaseAccountingAccount(event.target.value))}
          placeholder="Ex. 625000"
          className={inputClassName || selectClassName}
          style={selectStyle}
          aria-label={label ? `${label} personnalisé` : "Catégorie compta personnalisée"}
        />
      ) : null}
    </>
  );

  if (!label) {
    return <div className="grid min-w-0 gap-1">{select}</div>;
  }

  return (
    <div className="min-w-0">
      <label
        htmlFor={selectId}
        className="mb-1.5 flex items-center gap-1.5"
        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 500, color: "#374151" }}
      >
        <span>{label}</span>
        {accountHelp ? <InlineHelpTooltip content={accountHelp} className="h-4 w-4" /> : null}
      </label>
      <div className="grid min-w-0 gap-1.5">{select}</div>
    </div>
  );
}

const purchaseEmployeeVehicleOptions = ["Voiture", "Deux roues", "Utilitaire"];
const purchaseEmployeeFiscalPowerOptions = ["3 CV et moins", "4 CV", "5 CV", "6 CV", "7 CV et plus"];
const purchaseNatureOptions = [
  { value: "", label: "Non renseigné" },
  { value: "service", label: "Service" },
  { value: "product", label: "Produit" },
];

function purchaseEmployeeRoleLabel(value: any) {
  return String(value || "manager") === "employee" ? "Salarié" : "Dirigeant";
}

function purchaseEmployeeMethodLabel(value: any) {
  const map: Record<string, string> = {
    bank_transfer: "Virement",
    cash: "Espèces",
    expense_report: "Autre",
    other: "Autre",
  };
  return map[String(value || "")] || "Virement";
}

function purchaseEmployeeReimbursementPill(status: any): { color: EinvoicingPillTone; label: string } {
  const normalized = String(status || "to_reimburse").toLowerCase();
  if (normalized === "reimbursed") return { color: "ok", label: "Remboursé" };
  if (normalized === "not_reimbursed") return { color: "muted", label: "Non remboursable" };
  return { color: "warn", label: "À rembourser" };
}

function createPurchaseEmployeePayerDraft(base: any = {}) {
  return {
    name: base?.name || "",
    role: base?.role || "manager",
    user_label: base?.user_label || "",
    accounting_account: base?.default_accounting_account || base?.accounting_account || "",
    reimbursement_method: base?.reimbursement_method || "bank_transfer",
    vehicle_type: base?.vehicle_type || "Voiture",
    fiscal_power: base?.fiscal_power || "3 CV et moins",
    notes: base?.notes || "",
  };
}

function createPurchasePaymentDraft(item: any = {}, amountOverride?: number | null) {
  const amount = amountOverride !== undefined ? amountOverride : numericAmount(item?.total_ttc);
  return {
    date: inputDateToday(),
    amount: purchaseAmountToInput(amount),
    method: "Virement bancaire",
    reference: "",
    settlement_mode: "bank",
    accounting_category: "512",
    receipt_label: "",
    receipt_url: "",
    receipt_file: null as File | null,
  };
}

function purchasePaymentAccountForMode(mode: any) {
  const clean = String(mode || "")
    .trim()
    .toLowerCase();
  if (clean === "cash") return "531";
  if (clean === "bank" || clean === "card") return "512";
  if (clean === "manual" || clean === "other") return "";
  return "512";
}

function purchasePersonInitials(name: any) {
  const clean = String(name || "").trim();
  if (!clean) return "PI";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function purchaseAccountingAccountLabel(value: any) {
  const clean = String(value || "").trim();
  return purchaseAccountingAccountOptions.find((option) => option.value === clean)?.label || clean;
}

function purchaseAccountingAccountReady(value: any) {
  const clean = String(value || "")
    .replace(/\s/g, "")
    .toUpperCase();
  return Boolean(clean) && !clean.startsWith("471") && clean !== "MANUAL" && clean !== "CUSTOM";
}

function purchaseVatRateValue(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(String(value).replace(",", "."));
  return Number.isFinite(numeric) ? roundPurchaseAmount(numeric) : null;
}

function purchaseVatRateLabel(value: any) {
  const rate = purchaseVatRateValue(value);
  if (rate === null) return "";
  return `TVA ${String(rate).replace(".", ",")} %`;
}

function purchaseLineZeroVatHasReason(line: any) {
  const category = String(line?.vat_category || "").toUpperCase();
  return (
    ["AE", "E", "O", "Z", "G", "K"].includes(category) ||
    Boolean(String(line?.exemption_reason_code || "").trim()) ||
    Boolean(String(line?.vat_exemption_reason || "").trim()) ||
    Boolean(String(line?.vat_zero_reason || "").trim()) ||
    Boolean(line?.vat_reverse_charge)
  );
}

function purchaseLineZeroVatNeedsReason(line: any) {
  const lineHt = parsePurchaseAmount(line?.total_ex_vat);
  const lineVat = parsePurchaseAmount(line?.total_vat);
  const rate = purchaseVatRateValue(line?.vat_rate);
  return Number(lineHt || 0) > 0 && Number(lineVat || 0) <= 0 && rate === 0 && !purchaseLineZeroVatHasReason(line);
}

function purchaseLineZeroVatReasonLabel(line: any) {
  if (line?.vat_reverse_charge) return "Autoliquidation";
  return (
    String(line?.vat_zero_reason || "").trim() ||
    String(line?.vat_exemption_reason || "").trim() ||
    String(line?.exemption_reason_code || "").trim() ||
    String(line?.vat_category || "").trim()
  );
}

function purchaseValidationEntryLabel(entry: any) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "Point de contrôle à vérifier.";
  return (
    String(entry.message || "").trim() ||
    String(entry.label || "").trim() ||
    String(entry.title || "").trim() ||
    String(entry.code || "")
      .replace(/_/g, " ")
      .trim() ||
    "Point de contrôle à vérifier."
  );
}

function purchaseValidationEntryTargetId(entry: any) {
  const text =
    `${purchaseValidationEntryLabel(entry)} ${typeof entry === "object" ? JSON.stringify(entry) : ""}`.toLowerCase();
  if (text.includes("tva") || text.includes("vat") || text.includes("ligne") || text.includes("montant ht")) {
    return "purchase-lines-section";
  }
  if (text.includes("compte") || text.includes("compta") || text.includes("account") || text.includes("nature")) {
    return "purchase-accounting-section";
  }
  if (text.includes("paiement") || text.includes("ttc") || text.includes("échéance") || text.includes("echeance")) {
    return "purchase-payment-section";
  }
  if (text.includes("fournisseur") || text.includes("supplier") || text.includes("rembourser")) {
    return "purchase-document-section";
  }
  return "purchase-form-main";
}

function scrollToPurchaseCorrection(entry: any) {
  if (typeof document === "undefined") return;
  const target = document.getElementById(purchaseValidationEntryTargetId(entry));
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => {
    const focusable = target?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, 250);
}

function purchaseInputAmount(value: any) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value || "");
  return String(numeric).replace(".", ",");
}

function roundPurchaseAmount(value: number) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function purchaseAmountToInput(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return String(roundPurchaseAmount(Number(value))).replace(".", ",");
}

function purchaseVatAmountFromRate(totalExVat: any, vatRate: any) {
  const parsedHt = parsePurchaseAmount(totalExVat);
  const parsedRate = parsePurchaseAmount(vatRate);
  if (parsedHt === null || parsedRate === null) return null;
  return roundPurchaseAmount(parsedHt * (parsedRate / 100));
}

function purchaseAmountsAreCoherent(totalTtc: number | null, totalHt: number | null, totalVat: number | null) {
  if (totalTtc === null || totalHt === null || totalVat === null) return true;
  return Math.abs(roundPurchaseAmount(totalHt + totalVat) - roundPurchaseAmount(totalTtc)) <= 0.01;
}

function normalizePurchaseLineDrafts(lines: any[] | null | undefined) {
  const normalizedLines = (Array.isArray(lines) ? lines : [])
    .map((line) => {
      const totalExVat = parsePurchaseAmount(line?.total_ex_vat);
      if (totalExVat === null || totalExVat <= 0) return null;
      const vatRate = parsePurchaseAmount(line?.vat_rate);
      const explicitVat = parsePurchaseAmount(line?.total_vat);
      const hasZeroVatReason =
        Boolean(String(line?.vat_category || "").trim()) ||
        Boolean(String(line?.exemption_reason_code || "").trim()) ||
        Boolean(String(line?.vat_exemption_reason || "").trim()) ||
        Boolean(String(line?.vat_zero_reason || "").trim()) ||
        Boolean(line?.vat_reverse_charge);
      const effectiveVatRate =
        vatRate !== null
          ? vatRate
          : explicitVat !== null
            ? roundPurchaseAmount((explicitVat * 100) / totalExVat)
            : hasZeroVatReason
              ? 0
              : 20;
      const calculatedVat = vatRate !== null ? purchaseVatAmountFromRate(totalExVat, effectiveVatRate) : null;
      const totalVat =
        calculatedVat !== null
          ? calculatedVat
          : explicitVat !== null
            ? roundPurchaseAmount(explicitVat)
            : roundPurchaseAmount(totalExVat * (effectiveVatRate / 100));
      return {
        label: String(line?.label || "").trim() || null,
        total_ex_vat: roundPurchaseAmount(totalExVat),
        vat_rate: roundPurchaseAmount(effectiveVatRate),
        total_vat: totalVat,
        accounting_account: String(line?.accounting_account || "").trim() || null,
        purchase_nature: String(line?.purchase_nature || "").trim() || null,
        vat_category: String(line?.vat_category || "").trim() || null,
        exemption_reason_code: String(line?.exemption_reason_code || "").trim() || null,
        vat_exemption_reason: String(line?.vat_exemption_reason || "").trim() || null,
        vat_zero_reason: String(line?.vat_zero_reason || "").trim() || null,
        vat_reverse_charge: Boolean(line?.vat_reverse_charge),
        source: String(line?.source || "").trim() || null,
      };
    })
    .filter(Boolean) as Array<{
    label: string | null;
    total_ex_vat: number;
    vat_rate: number;
    total_vat: number;
    accounting_account: string | null;
    purchase_nature: string | null;
    vat_category: string | null;
    exemption_reason_code: string | null;
    vat_exemption_reason: string | null;
    vat_zero_reason: string | null;
    vat_reverse_charge: boolean;
    source: string | null;
  }>;
  const totalExVat = roundPurchaseAmount(normalizedLines.reduce((sum, line) => sum + line.total_ex_vat, 0));
  const totalVat = roundPurchaseAmount(normalizedLines.reduce((sum, line) => sum + line.total_vat, 0));
  return {
    lines: normalizedLines,
    total_ex_vat: totalExVat,
    total_vat: totalVat,
    total_ttc: roundPurchaseAmount(totalExVat + totalVat),
  };
}

function applyPurchaseVatRateToLines(lines: any[] | null | undefined, vatRate: number) {
  const safeLines = Array.isArray(lines) && lines.length ? lines : [createPurchaseLineDraft()];
  return safeLines.map((line) => {
    const totalExVat = parsePurchaseAmount(line?.total_ex_vat);
    const patch: Record<string, any> = {
      ...line,
      vat_rate: purchaseAmountToInput(vatRate),
    };
    if (totalExVat !== null && totalExVat > 0) {
      patch.total_vat = purchaseAmountToInput(roundPurchaseAmount(totalExVat * (vatRate / 100)));
    }
    return patch;
  });
}

function purchaseSupplierVatRules(entry: any) {
  return (Array.isArray(entry?.vat_rules) ? entry.vat_rules : [])
    .map((rule: any) => ({
      accounting_account: String(rule?.accounting_account || "").trim(),
      purchase_nature: String(rule?.purchase_nature || "").trim(),
      vat_rate: purchaseInputAmount(rule?.vat_rate),
    }))
    .filter(
      (rule: any) => (rule.accounting_account || rule.purchase_nature) && purchaseVatRateValue(rule.vat_rate) !== null,
    );
}

function purchaseSupplierVatRulesMeta(entry: any) {
  const rules = purchaseSupplierVatRules(entry);
  if (!rules.length) return null;
  return `${rules.length} exception${rules.length > 1 ? "s" : ""} TVA`;
}

function purchaseSupplierVatRateForLine(entry: any, line: any) {
  const account = String(line?.accounting_account || "").trim();
  const nature = String(line?.purchase_nature || "").trim();
  let bestRate: number | null = null;
  let bestScore = -1;
  for (const rule of purchaseSupplierVatRules(entry)) {
    if (rule.accounting_account && rule.accounting_account !== account) continue;
    if (rule.purchase_nature && rule.purchase_nature !== nature) continue;
    const score = (rule.accounting_account ? 2 : 0) + (rule.purchase_nature ? 1 : 0);
    const rate = purchaseVatRateValue(rule.vat_rate);
    if (rate !== null && score > bestScore) {
      bestRate = rate;
      bestScore = score;
    }
  }
  return bestRate ?? purchaseVatRateValue(entry?.default_vat_rate);
}

function applyPurchaseSupplierVatRulesToLines(lines: any[] | null | undefined, supplier: any) {
  const safeLines = Array.isArray(lines) && lines.length ? lines : [createPurchaseLineDraft()];
  const defaultAccount = String(supplier?.default_accounting_account || "").trim();
  const defaultNature = String(supplier?.default_purchase_nature || "").trim();
  return safeLines.map((line) => {
    const lineWithDefaults = {
      ...line,
      accounting_account: line?.accounting_account || defaultAccount,
      purchase_nature: line?.purchase_nature || defaultNature,
    };
    const rate = purchaseSupplierVatRateForLine(supplier, lineWithDefaults);
    return rate === null ? lineWithDefaults : applyPurchaseVatRateToLines([lineWithDefaults], rate)[0];
  });
}

function purchaseDefaultVatRateFromDraft(draft: any) {
  const normalized = normalizePurchaseLineDrafts(draft?.purchase_lines);
  const lineRates = Array.from(
    new Set(
      normalized.lines
        .filter((line) => Number(line.total_ex_vat || 0) > 0 && Number(line.total_vat || 0) > 0)
        .map((line) => roundPurchaseAmount(Number(line.vat_rate || 0))),
    ),
  );
  if (lineRates.length === 1) return lineRates[0];
  const totalHt = parsePurchaseAmount(draft?.total_ex_vat);
  const totalVat = parsePurchaseAmount(draft?.total_vat);
  if (totalHt !== null && totalHt > 0 && totalVat !== null && totalVat > 0) {
    return roundPurchaseAmount((totalVat / totalHt) * 100);
  }
  return null;
}

function purchaseLineDraftsFromItem(item: any) {
  const rawLines = Array.isArray(item?.purchase_lines) ? item.purchase_lines : [];
  if (rawLines.length) return rawLines.map((line: any) => createPurchaseLineDraft(line));
  const totalExVat = parsePurchaseAmount(purchaseInputAmount(item?.total_ex_vat));
  if (totalExVat !== null && totalExVat > 0) {
    const totalVat = parsePurchaseAmount(purchaseInputAmount(item?.total_vat)) || 0;
    const rate = totalExVat > 0 ? roundPurchaseAmount((totalVat / totalExVat) * 100) : 20;
    return [
      createPurchaseLineDraft({
        label: item?.invoice_number || item?.supplier_name || "",
        total_ex_vat: totalExVat,
        total_vat: totalVat,
        vat_rate: rate,
        accounting_account: item?.accounting_account || "",
        purchase_nature: item?.purchase_nature || "service",
      }),
    ];
  }
  return [
    createPurchaseLineDraft({
      accounting_account: item?.accounting_account || "",
      purchase_nature: item?.purchase_nature || "service",
    }),
  ];
}

function derivePurchaseHtVatFromTtc(totalTtc: number | null, vatRate = 20) {
  if (totalTtc === null || totalTtc <= 0) return { total_ex_vat: "", total_vat: "" };
  const ht = roundPurchaseAmount(totalTtc / (1 + vatRate / 100));
  const vat = roundPurchaseAmount(totalTtc - ht);
  return {
    total_ex_vat: purchaseAmountToInput(ht),
    total_vat: purchaseAmountToInput(vat),
  };
}

function normalizePurchaseAmountsForSave(draft: any) {
  const totalTtc = parsePurchaseAmount(draft.total_ttc);
  let totalHt = parsePurchaseAmount(draft.total_ex_vat);
  let totalVat = parsePurchaseAmount(draft.total_vat);
  if (totalTtc !== null && totalTtc > 0 && !purchaseAmountsAreCoherent(totalTtc, totalHt, totalVat)) {
    const derived = derivePurchaseHtVatFromTtc(totalTtc);
    totalHt = parsePurchaseAmount(derived.total_ex_vat);
    totalVat = parsePurchaseAmount(derived.total_vat);
  }
  return {
    total_ttc: totalTtc,
    total_ex_vat: totalHt,
    total_vat: totalVat,
  };
}

function purchaseIsoDate(value: any) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function purchasePaymentDelayDays(issueIso: string, paymentIso: string) {
  if (!issueIso || !paymentIso) return "";
  const issue = new Date(`${issueIso}T00:00:00`);
  const payment = new Date(`${paymentIso}T00:00:00`);
  if (Number.isNaN(issue.getTime()) || Number.isNaN(payment.getTime())) return "";
  const days = Math.round((payment.getTime() - issue.getTime()) / 86400000);
  return days >= 0 ? String(days) : "";
}

function createPurchaseCompletionDraft(item: any = {}) {
  const kind = purchaseKindKey(item);
  const issueDate = purchaseIsoDate(item?.issue_date);
  const plannedPaymentDate =
    purchaseIsoDate(item?.planned_payment_date) || (issueDate ? addDaysToIsoDate(issueDate, 30) : "");
  const shouldTrackEmployeeReimbursement =
    Boolean(item?.paid_by_employee) || kind === "expense_report" || kind === "mileage";
  const employeeReimbursementSource =
    item?.employee_reimbursement_amount !== null &&
    item?.employee_reimbursement_amount !== undefined &&
    item?.employee_reimbursement_amount !== ""
      ? item.employee_reimbursement_amount
      : shouldTrackEmployeeReimbursement
        ? item?.total_ttc
        : "";
  const totalTtc = parsePurchaseAmount(purchaseInputAmount(item?.total_ttc));
  const totalHt = parsePurchaseAmount(purchaseInputAmount(item?.total_ex_vat));
  const totalVat = parsePurchaseAmount(purchaseInputAmount(item?.total_vat));
  const normalizedTotals =
    totalTtc !== null && totalTtc > 0 && !purchaseAmountsAreCoherent(totalTtc, totalHt, totalVat)
      ? derivePurchaseHtVatFromTtc(totalTtc)
      : {
          total_ex_vat: purchaseInputAmount(item?.total_ex_vat),
          total_vat: purchaseInputAmount(item?.total_vat),
        };
  return {
    supplier_name: item?.supplier_name || "",
    supplier_siren: item?.supplier_siren || "",
    supplier_siret: item?.supplier_siret || "",
    invoice_number: item?.invoice_number || "",
    issue_date: issueDate,
    total_ex_vat: normalizedTotals.total_ex_vat,
    total_vat: normalizedTotals.total_vat,
    total_ttc: purchaseInputAmount(item?.total_ttc),
    currency: item?.currency || "EUR",
    purchase_nature: item?.purchase_nature || "service",
    accounting_account: item?.accounting_account || "",
    accountant_note: item?.accountant_note || "",
    planned_payment_date: plannedPaymentDate,
    payment_delay_days: purchasePaymentDelayDays(issueDate, plannedPaymentDate) || "30",
    paid_by_employee: shouldTrackEmployeeReimbursement,
    employee_payer_name: item?.employee_payer_name || "",
    employee_payer_role: item?.employee_payer_role || "manager",
    employee_reimbursement_amount: purchaseInputAmount(employeeReimbursementSource),
    employee_reimbursement_due_date:
      purchaseIsoDate(item?.employee_reimbursement_due_date) ||
      (shouldTrackEmployeeReimbursement ? plannedPaymentDate : ""),
    employee_reimbursement_method: item?.employee_reimbursement_method || "bank_transfer",
    employee_reimbursement_status: item?.employee_reimbursement_status || "to_reimburse",
    purchase_lines: purchaseLineDraftsFromItem(item),
  };
}

function parsePurchaseAmount(value: string) {
  const normalized = String(value || "")
    .replace(/\s/g, "")
    .replace(",", ".");
  if (!normalized) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function addDaysToIsoDate(baseIso: string, days: number) {
  const base = baseIso ? new Date(`${baseIso}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return "";
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function normalizePurchaseRecentList(values: any[]) {
  const seen = new Set<string>();
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLocaleLowerCase("fr-FR");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function purchaseSupplierName(entry: any) {
  return String(entry?.supplier_name || entry?.name || "").trim();
}

function purchaseCustomerMatchReasonLabel(reason: any) {
  const normalized = String(reason || "").trim();
  const labels: Record<string, string> = {
    siret: "SIRET",
    siren: "SIREN",
    vat_number: "N° TVA",
    name: "nom",
  };
  return labels[normalized] || "coordonnées";
}

function purchaseSupplierDuplicateFieldLabel(field: any) {
  return purchaseCustomerMatchReasonLabel(field);
}

function purchaseSupplierCustomerMatchLabel(entry: any) {
  const match = entry?.customer_match;
  if (!match?.name) return "";
  return `Aussi client : ${match.name} · ${purchaseCustomerMatchReasonLabel(match.reason)}`;
}

function purchaseSupplierDetailsMeta(entry: any) {
  const bits = [
    entry?.supplier_siret || entry?.supplier_siren
      ? `SIREN/SIRET ${entry.supplier_siret || entry.supplier_siren}`
      : null,
    entry?.default_accounting_account ? purchaseAccountingAccountLabel(entry.default_accounting_account) : null,
    entry?.default_vat_rate !== null && entry?.default_vat_rate !== undefined
      ? purchaseVatRateLabel(entry.default_vat_rate)
      : null,
    purchaseSupplierVatRulesMeta(entry),
    entry?.default_payment_delay_days ? `${entry.default_payment_delay_days} jours` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function purchaseSupplierMeta(entry: any) {
  return [purchaseSupplierCustomerMatchLabel(entry), purchaseSupplierDetailsMeta(entry)].filter(Boolean).join(" · ");
}

function employeePayerName(entry: any) {
  return String(typeof entry === "string" ? entry : entry?.name || "").trim();
}

function purchaseEmployeePayerMeta(entry: any) {
  const bits = [
    purchaseEmployeeRoleLabel(entry?.role),
    purchaseEmployeeMethodLabel(entry?.reimbursement_method),
    entry?.default_accounting_account ? purchaseAccountingAccountLabel(entry.default_accounting_account) : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function PurchaseLinesEditor({
  lines,
  disabled = false,
  compact = false,
  onChange,
}: {
  lines: any[];
  disabled?: boolean;
  compact?: boolean;
  onChange: (lines: any[]) => void;
}) {
  const safeLines = Array.isArray(lines) && lines.length ? lines : [createPurchaseLineDraft()];
  const totals = normalizePurchaseLineDrafts(safeLines);
  const updateLine = (index: number, patch: Record<string, any>) => {
    onChange(
      safeLines.map((line, lineIndex) => {
        if (lineIndex !== index) return line;
        const nextLine = { ...line, ...patch };
        if (
          !Object.prototype.hasOwnProperty.call(patch, "total_vat") &&
          (Object.prototype.hasOwnProperty.call(patch, "total_ex_vat") ||
            Object.prototype.hasOwnProperty.call(patch, "vat_rate"))
        ) {
          const calculatedVat = purchaseVatAmountFromRate(nextLine.total_ex_vat, nextLine.vat_rate);
          if (calculatedVat !== null) {
            nextLine.total_vat = purchaseAmountToInput(calculatedVat);
          }
        }
        if (
          Object.prototype.hasOwnProperty.call(patch, "total_vat") &&
          !Object.prototype.hasOwnProperty.call(patch, "vat_rate")
        ) {
          const parsedHt = parsePurchaseAmount(nextLine.total_ex_vat);
          const parsedVat = parsePurchaseAmount(nextLine.total_vat);
          if (parsedHt !== null && parsedHt > 0 && parsedVat !== null) {
            nextLine.vat_rate = purchaseAmountToInput(roundPurchaseAmount((parsedVat / parsedHt) * 100));
          }
        }
        return nextLine;
      }),
    );
  };
  const removeLine = (index: number) => {
    const nextLines = safeLines.filter((_, lineIndex) => lineIndex !== index);
    onChange(nextLines.length ? nextLines : [createPurchaseLineDraft()]);
  };

  if (compact) {
    return (
      <div>
        <div className="overflow-x-auto rounded-lg border border-[#dbe4ef] bg-white">
          <div className="min-w-[900px]">
            <div className="grid grid-cols-[1.25fr_0.55fr_0.5fr_0.55fr_0.6fr_1fr_0.8fr_2rem] border-b border-[#dbe4ef] bg-[#f8fafc] px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[#64748b]">
              <span>Désignation</span>
              <span>HT</span>
              <span className="flex items-center gap-1">
                TVA %
                <InlineHelpTooltip
                  content="Taux de TVA appliqué à cette ligne. Mets 0 seulement si la facture indique une exonération, une autoliquidation ou un hors champ."
                  className="h-4 w-4 normal-case"
                />
              </span>
              <span>TVA</span>
              <span>TTC</span>
              <span className="flex items-center gap-1">
                Catégorie compta
                <InlineHelpTooltip
                  content="Catégorie pour cette ligne. Elle sert à l'export comptable et peut être différente de la catégorie par défaut de l'achat."
                  className="h-4 w-4 normal-case"
                />
              </span>
              <span>Type</span>
              <span />
            </div>
            <div className="divide-y divide-[#e2e8f0] bg-white">
              {safeLines.map((line, index) => {
                const lineHt = parsePurchaseAmount(line.total_ex_vat);
                const calculatedLineVat = purchaseVatAmountFromRate(line.total_ex_vat, line.vat_rate);
                const lineVat = calculatedLineVat ?? parsePurchaseAmount(line.total_vat);
                const lineTtc =
                  lineHt !== null || lineVat !== null
                    ? roundPurchaseAmount(Number(lineHt || 0) + Number(lineVat || 0))
                    : 0;
                const zeroVatNeedsReason = purchaseLineZeroVatNeedsReason(line);
                const zeroVatReason = purchaseLineZeroVatReasonLabel(line);
                return (
                  <div key={index}>
                    <div className="grid grid-cols-[1.25fr_0.55fr_0.5fr_0.55fr_0.6fr_1fr_0.8fr_2rem] items-center gap-2 px-3 py-3">
                      <input
                        disabled={disabled}
                        value={line.label || ""}
                        onChange={(event) => updateLine(index, { label: event.target.value })}
                        placeholder="Référence"
                        className="h-9 w-full rounded-lg border border-[#dbe4ef] bg-white px-2.5 text-[12px] font-semibold text-[#0f172a] outline-none transition-all placeholder:text-[#94a3b8] focus:border-[#5B5FEE] focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                      />
                      <input
                        disabled={disabled}
                        inputMode="decimal"
                        value={line.total_ex_vat || ""}
                        onChange={(event) => updateLine(index, { total_ex_vat: event.target.value })}
                        placeholder="0,00"
                        className="h-9 w-full rounded-lg border border-[#dbe4ef] bg-white px-2.5 text-[12px] font-bold text-[#0f172a] outline-none transition-all placeholder:text-[#94a3b8] focus:border-[#5B5FEE] focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                      />
                      <input
                        disabled={disabled}
                        inputMode="decimal"
                        value={line.vat_rate || ""}
                        onChange={(event) => updateLine(index, { vat_rate: event.target.value })}
                        placeholder="TVA %"
                        className="h-9 w-full rounded-lg border border-orange-200 bg-white px-2.5 text-[12px] font-bold text-orange-700 outline-none transition-all placeholder:text-orange-300 focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                      />
                      <input
                        disabled={disabled}
                        inputMode="decimal"
                        value={line.total_vat || ""}
                        onChange={(event) => updateLine(index, { total_vat: event.target.value })}
                        placeholder="0,00"
                        className="h-9 w-full rounded-lg border border-[#dbe4ef] bg-white px-2.5 text-[12px] font-bold text-[#0f172a] outline-none transition-all placeholder:text-[#94a3b8] focus:border-[#5B5FEE] focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                      />
                      <span className="text-[12px] font-bold text-[#0f172a]">{money(lineTtc)}</span>
                      <PurchaseAccountingAccountField
                        value={line.accounting_account || ""}
                        disabled={disabled}
                        onChange={(value) => updateLine(index, { accounting_account: value })}
                        selectClassName="h-9 w-full cursor-pointer rounded-lg border border-[#dbe4ef] bg-white px-2.5 text-[12px] font-semibold text-[#334155] outline-none transition-all focus:border-[#5B5FEE] focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                      />
                      <select
                        disabled={disabled}
                        value={line.purchase_nature || ""}
                        onChange={(event) => updateLine(index, { purchase_nature: event.target.value })}
                        className="h-9 w-full cursor-pointer rounded-lg border border-[#dbe4ef] bg-white px-2.5 text-[12px] font-semibold text-[#334155] outline-none transition-all focus:border-[#5B5FEE] focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                      >
                        {purchaseNatureOptions.map((option) => (
                          <option key={option.value || "empty"} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={disabled || safeLines.length <= 1}
                        onClick={() => removeLine(index)}
                        className="inline-flex h-9 w-8 items-center justify-center rounded-lg border border-[#fecaca] bg-white text-[#dc2626] transition-colors hover:bg-[#fef2f2] disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="Supprimer la ligne"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {zeroVatNeedsReason || zeroVatReason ? (
                      <div className="grid grid-cols-[1.25fr_1.05fr_2.4fr_2rem] gap-2 px-3 pb-3">
                        <span
                          title={
                            zeroVatNeedsReason
                              ? "Choisissez la catégorie TVA et indiquez le motif légal ou comptable qui justifie la TVA à 0."
                              : "Motif TVA 0 déjà renseigné pour cette ligne."
                          }
                          className={`inline-flex h-8 items-center rounded-lg border px-2.5 text-[11px] font-bold ${
                            zeroVatNeedsReason
                              ? "border-orange-200 bg-orange-50 text-orange-700"
                              : "border-emerald-200 bg-emerald-50 text-emerald-700"
                          }`}
                        >
                          {zeroVatNeedsReason ? "Motif TVA 0 requis" : `TVA 0 : ${zeroVatReason}`}
                        </span>
                        <select
                          disabled={disabled}
                          aria-label={`Catégorie TVA ligne ${index + 1}`}
                          title="Catégorie fiscale transmise avec la ligne si la TVA est à 0 ou non standard."
                          value={line.vat_category || ""}
                          onChange={(event) => updateLine(index, { vat_category: event.target.value })}
                          className="h-8 rounded-lg border border-[#E8EAF0] bg-white px-2 text-[12px] font-semibold text-[#334155] outline-none focus:border-[#5B5FEE] focus:ring-2 focus:ring-indigo-100"
                        >
                          <option value="">Catégorie TVA</option>
                          <option value="E">Exonérée</option>
                          <option value="AE">Autoliquidation</option>
                          <option value="O">Hors champ</option>
                          <option value="Z">Taux zéro</option>
                        </select>
                        <input
                          disabled={disabled}
                          aria-label={`Motif TVA 0 ligne ${index + 1}`}
                          title="Mention imprimée ou transmise pour expliquer pourquoi cette ligne est sans TVA."
                          value={line.vat_zero_reason || line.vat_exemption_reason || ""}
                          onChange={(event) =>
                            updateLine(index, {
                              vat_zero_reason: event.target.value,
                              vat_exemption_reason: event.target.value,
                            })
                          }
                          placeholder="Motif imprimé / transmis pour TVA 0"
                          className="h-8 rounded-lg border border-[#E8EAF0] bg-white px-2 text-[12px] font-semibold text-[#334155] outline-none placeholder:text-[#94a3b8] focus:border-[#5B5FEE] focus:ring-2 focus:ring-indigo-100"
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange([...safeLines, createPurchaseLineDraft()])}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#bbf7d0] bg-white px-2.5 text-[12px] font-bold text-[#15803d] transition-colors hover:bg-[#f0fdf4] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus className="h-3.5 w-3.5" />
            Ajouter une ligne
          </button>
          <div className="flex flex-wrap justify-end gap-2 text-[12px] font-bold text-[#475569]">
            <span className="rounded-full bg-[#f8fafc] px-2.5 py-1">HT {money(totals.total_ex_vat)}</span>
            <span className="rounded-full bg-[#f8fafc] px-2.5 py-1">TVA {money(totals.total_vat)}</span>
            <span className="rounded-full bg-[#ecfdf5] px-2.5 py-1 text-[#15803d]">TTC {money(totals.total_ttc)}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#dbe7f3] bg-[#f8fafc] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-[#0f172a]" style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}>
              Répartition TVA et comptes comptables
            </p>
            <InlineHelpTooltip content="Découpe l'achat par taux de TVA ou par compte comptable quand une facture contient plusieurs natures de dépenses." />
          </div>
          <p className="text-[#64748b]" style={{ fontSize: "var(--pf-app-text-caption)", lineHeight: 1.45 }}>
            Une ligne par taux ou compte comptable. Les totaux sont recalculés à l’enregistrement.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...safeLines, createPurchaseLineDraft()])}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#bbf7d0] bg-white px-2.5 text-[#15803d] transition-colors hover:bg-[#f0fdf4] disabled:cursor-not-allowed disabled:opacity-60"
          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
        >
          <Plus className="h-3.5 w-3.5" />
          Ligne
        </button>
      </div>
      <div className="space-y-2">
        {safeLines.map((line, index) => (
          <div
            key={index}
            className="grid gap-2 rounded-lg border border-[#e2e8f0] bg-white p-2 sm:grid-cols-[1.2fr_0.58fr_0.52fr_0.58fr_1fr_0.82fr_2rem]"
          >
            <input
              disabled={disabled}
              value={line.label || ""}
              onChange={(event) => updateLine(index, { label: event.target.value })}
              placeholder="Libellé"
              className={purchaseLineInputClass}
              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 700 }}
            />
            <input
              disabled={disabled}
              inputMode="decimal"
              value={line.total_ex_vat || ""}
              onChange={(event) => updateLine(index, { total_ex_vat: event.target.value })}
              placeholder="HT"
              className={purchaseLineInputClass}
              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
            />
            <input
              disabled={disabled}
              inputMode="decimal"
              value={line.vat_rate || ""}
              onChange={(event) => updateLine(index, { vat_rate: event.target.value })}
              placeholder="TVA %"
              className={purchaseLineInputClass}
              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
            />
            <input
              disabled={disabled}
              inputMode="decimal"
              value={line.total_vat || ""}
              onChange={(event) => updateLine(index, { total_vat: event.target.value })}
              placeholder="TVA €"
              className={purchaseLineInputClass}
              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
            />
            <PurchaseAccountingAccountField
              value={line.accounting_account || ""}
              disabled={disabled}
              onChange={(value) => updateLine(index, { accounting_account: value })}
              selectClassName={purchaseLineInputClass}
              selectStyle={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
            />
            <select
              disabled={disabled}
              value={line.purchase_nature || ""}
              onChange={(event) => updateLine(index, { purchase_nature: event.target.value })}
              className={purchaseLineInputClass}
              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
            >
              {purchaseNatureOptions.map((option) => (
                <option key={option.value || "empty"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={disabled || safeLines.length <= 1}
              onClick={() => removeLine(index)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#fecaca] bg-white text-[#dc2626] transition-colors hover:bg-[#fef2f2] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Supprimer la ligne"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div
        className="mt-3 flex flex-wrap justify-end gap-2 text-[#475569]"
        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
      >
        <span className="rounded-full bg-white px-2.5 py-1">HT {money(totals.total_ex_vat)}</span>
        <span className="rounded-full bg-white px-2.5 py-1">TVA {money(totals.total_vat)}</span>
        <span className="rounded-full bg-[#ecfdf5] px-2.5 py-1 text-[#15803d]">TTC {money(totals.total_ttc)}</span>
      </div>
    </div>
  );
}

function PurchaseDetailSection({
  id,
  title,
  help,
  badge,
  actions,
  tone = "document",
  children,
}: {
  id?: string;
  title: string;
  help?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  tone?: "document" | "muted";
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-24 border-t border-[#e2e8f0] bg-white pt-5 first:border-t-0 first:pt-0 ${
        tone === "muted" ? "mt-1 border-t border-dashed border-[#cbd5e1]" : ""
      }`}
    >
      <div
        className={`mb-3 flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between ${
          tone === "muted" ? "border-[#e2e8f0] bg-[#f8fafc]" : "border-[#bfdbfe] bg-[#eff6ff]"
        }`}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#334155]">{title}</p>
          {help ? <InlineHelpTooltip content={help} /> : null}
          {badge}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function PurchasePartyPicker({
  id,
  label,
  required,
  value,
  open,
  options,
  placeholder,
  emptyLabel,
  createLabel,
  canCreate,
  createBusy,
  onOpenChange,
  onQueryChange,
  onSelect,
  onCreate,
  getOptionKey,
  getOptionLabel,
  getOptionSubLabel,
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  open: boolean;
  options: any[];
  placeholder: string;
  emptyLabel: string;
  createLabel: string;
  canCreate: boolean;
  createBusy?: boolean;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (value: string) => void;
  onSelect: (option: any) => void;
  onCreate: () => void;
  getOptionKey: (option: any) => string;
  getOptionLabel: (option: any) => string;
  getOptionSubLabel?: (option: any) => string;
}) {
  const listId = `${id}-listbox`;
  const cleanValue = String(value || "").trim();
  const visibleOptions = options.filter((option) => getOptionLabel(option)).slice(0, 8);
  const showCreateAction = canCreate && cleanValue.length > 0;

  return (
    <div
      className="relative"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          onOpenChange(false);
        }
      }}
    >
      <label
        htmlFor={id}
        className="mb-1.5 block text-[#374151]"
        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 500 }}
      >
        {label} {required ? <span className="text-[#ef4444]">*</span> : null}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94a3b8]" />
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          autoComplete="off"
          value={value}
          onFocus={() => onOpenChange(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onOpenChange(false);
            }
          }}
          onChange={(event) => {
            onQueryChange(event.target.value);
            onOpenChange(true);
          }}
          placeholder={placeholder}
          className="w-full rounded-lg border border-[#dbe7f3] bg-white px-9 py-2 text-[#0f172a] shadow-[0_1px_2px_rgba(0,0,0,0.04)] outline-none transition-all placeholder:text-[#94a3b8] focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
          style={{ fontSize: "var(--pf-app-text-body)" }}
        />
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94a3b8]" />
      </div>

      {open ? (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+0.45rem)] z-40 overflow-hidden rounded-xl border border-[#bbf7d0] bg-white shadow-[0_18px_44px_-24px_rgba(15,23,42,0.45)]"
        >
          <div className="max-h-60 overflow-y-auto p-2">
            {visibleOptions.length ? (
              visibleOptions.map((option) => {
                const optionLabel = getOptionLabel(option);
                const selected = cleanValue.toLocaleLowerCase("fr-FR") === optionLabel.toLocaleLowerCase("fr-FR");
                const subLabel = getOptionSubLabel?.(option);
                return (
                  <button
                    key={getOptionKey(option)}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onSelect(option)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[#0f172a] transition-colors hover:bg-[#f0fdf4]"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                  >
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#dcfce7] text-[#15803d]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                    >
                      {purchasePersonInitials(optionLabel)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{optionLabel}</span>
                      {subLabel ? (
                        <span
                          className="block truncate text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                        >
                          {subLabel}
                        </span>
                      ) : null}
                    </span>
                    {selected ? <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-[#16a34a]" /> : null}
                  </button>
                );
              })
            ) : (
              <div
                className="px-3 py-4 text-center text-[#64748b]"
                style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 650 }}
              >
                {emptyLabel}
              </div>
            )}
          </div>
          {showCreateAction ? (
            <button
              type="button"
              disabled={createBusy}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onCreate}
              className="flex w-full items-center justify-between gap-3 border-t border-[#bbf7d0] bg-[#f0fdf4] px-4 py-3 text-left text-[#15803d] transition-colors hover:bg-[#dcfce7] disabled:cursor-wait disabled:opacity-60"
              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
            >
              <span className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                {createBusy ? "Création..." : createLabel}
              </span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type PurchaseSummaryAccent = "blue" | "green" | "amber" | "red" | "purple" | "cyan";

function PurchaseSummaryCard({
  label,
  value,
  sub,
  accent,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: PurchaseSummaryAccent;
  icon?: ReactNode;
}) {
  const palette: Record<PurchaseSummaryAccent, { iconBg: string; iconColor: string; topBar: string }> = {
    blue: { iconBg: "#dbeafe", iconColor: "#1d4ed8", topBar: "#1d4ed8" },
    green: { iconBg: "#dcfce7", iconColor: "#16a34a", topBar: "#16a34a" },
    amber: { iconBg: "#fef3c7", iconColor: "#d97706", topBar: "#d97706" },
    red: { iconBg: "#fee2e2", iconColor: "#dc2626", topBar: "#dc2626" },
    purple: { iconBg: "#ede9fe", iconColor: "#7c3aed", topBar: "#7c3aed" },
    cyan: { iconBg: "#cffafe", iconColor: "#0891b2", topBar: "#0891b2" },
  };
  const tone = palette[accent];

  return (
    <div className="relative min-h-[104px] overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_22px_rgba(15,23,42,0.04)]">
      <div className="absolute left-0 right-0 top-0 h-[3px]" style={{ background: tone.topBar }} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className="text-[#94a3b8]"
            style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase" }}
          >
            {label}
          </div>
          <div className="mt-3 truncate text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 750, lineHeight: 1.15 }}>
            {value}
          </div>
          {sub ? (
            <div className="mt-1 truncate text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
              {sub}
            </div>
          ) : null}
        </div>
        {icon ? (
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
            style={{ background: tone.iconBg, color: tone.iconColor }}
          >
            {icon}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function purchaseSummaryAccent(color: EinvoicingPillTone | undefined): PurchaseSummaryAccent {
  if (color === "ok") return "green";
  if (color === "danger") return "red";
  if (color === "warn") return "amber";
  if (color === "purple") return "purple";
  if (color === "info") return "blue";
  return "cyan";
}

function canDeleteInboundInvoice(item: any) {
  const providerSlug = String(item?.provider_slug || "")
    .trim()
    .toLowerCase();
  return ["manual_import", "mock", "dummy"].includes(providerSlug);
}

function purchaseOpsGuidance(item: any, workflow?: any) {
  const status = String(item?.status || "").toLowerCase();
  const validation = String(item?.validation_status || "").toLowerCase();
  const workflowState = String(workflow?.state || "").toLowerCase();
  if (workflowState === "ready_to_pay") {
    return {
      tone: "ok",
      title: "Enregistrer le règlement",
      description:
        "Le document est marqué à payer. La prochaine étape est la saisie du règlement fournisseur ou son rapprochement CSV.",
      bullets: [
        "Vérifier l'échéance et la date de paiement prévue.",
        "Rattacher le document à une référence de virement ou à l'export comptable.",
      ],
    };
  }
  if (workflowState === "approved") {
    return {
      tone: "ok",
      title: "Préparer le paiement",
      description:
        "La revue achat est terminée. Il reste à le faire basculer dans le flux finance/compta au bon moment.",
      bullets: [
        "Conserver la note interne ou la preuve de validation achat.",
        "Passer ensuite le dossier en “à payer” pour donner une lecture claire au suivi des paiements.",
      ],
    };
  }
  if (workflowState === "reviewing") {
    return {
      tone: "warn",
      title: "Finaliser la revue interne",
      description:
        "Le document est déjà dans un cycle de contrôle. La priorité est maintenant de confirmer la cohérence métier et documentaire.",
      bullets: [
        "Comparer la facture au bon de commande, contrat ou prestation reçue.",
        "Documenter la décision interne avant d'approuver ou de demander un retour fournisseur.",
      ],
    };
  }
  if (workflowState === "awaiting_supplier") {
    return {
      tone: "danger",
      title: "Attendre un retour fournisseur",
      description:
        "Le document est gelé dans l'attente d'une correction ou d'une clarification. Ne le laisse pas revenir dans la file sans contexte.",
      bullets: [
        "Conserver l'explication interne dans la note opérateur.",
        "Relancer le fournisseur si aucune nouvelle version n'arrive dans le délai attendu.",
      ],
    };
  }
  if (validation === "invalid") {
    return {
      tone: "danger",
      title: "Demander une correction fournisseur",
      description:
        "Le document reçu n'est pas assez fiable pour un traitement propre. Reviens vers le fournisseur avant de le valider.",
      bullets: [
        "Vérifier les erreurs de structure et les champs obligatoires manquants.",
        "Conserver la pièce jointe mais éviter de la considérer comme validée côté achat.",
        "Utiliser le bouton de demande de correction si le canal fournisseur le permet.",
      ],
    };
  }
  if (["correction_requested", "rejected"].includes(status)) {
    return {
      tone: "warn",
      title: "Attendre une version corrigée",
      description:
        "Le document a déjà fait l'objet d'un retour. Gardez la trace, puis contrôlez la prochaine version à réception.",
      bullets: [
        "Suivre l'historique pour justifier le rejet ou la demande de correction.",
        "Ne pas lancer le paiement tant qu'une version acceptable n'est pas reçue.",
      ],
    };
  }
  if (validation === "warning") {
    return {
      tone: "warn",
      title: "Valider avec contrôle renforcé",
      description:
        "La facture fournisseur est exploitable, mais certains points demandent une revue humaine avant de l'intégrer au flux achat.",
      bullets: [
        "Vérifier le montant TTC, la TVA et le numéro de facture fournisseur.",
        "Comparer avec le bon de commande ou la dépense attendue.",
        "Accepter seulement si l'écart métier est compris et documenté.",
      ],
    };
  }
  if (status === "accepted") {
    return {
      tone: "ok",
      title: "Préparer le paiement fournisseur",
      description:
        "Le document est validé côté réception. La prochaine étape logique est l'ordonnancement du paiement et le suivi fournisseur.",
      bullets: [
        "Planifier le règlement dans le bon cycle de paiement.",
        "Conserver la facture dans la piste d'audit achat / fournisseur.",
      ],
    };
  }
  if (status === "acknowledged") {
    return {
      tone: "info",
      title: "Contrôler puis accepter",
      description:
        "La facture a bien été reçue côté plateforme. Il reste à valider le contenu métier avant d'enclencher le traitement fournisseur.",
      bullets: [
        "Contrôler fournisseur, référence et cohérence des montants.",
        "Accepter la facture si la réception métier est correcte.",
      ],
    };
  }
  return {
    tone: "info",
    title: "Analyser le document reçu",
    description: "Le document est arrivé dans la file achats.",
    bullets: [
      "Vérifier le fournisseur et le numéro de facture.",
      "Comparer avec l'achat attendu ou la prestation reçue.",
      "Choisir ensuite accepter, rejeter ou demander une correction.",
    ],
  };
}

function ereportingPill(status: string | null | undefined) {
  const normalized = (status || "").toLowerCase();
  const map: Record<string, { color: any; label: string }> = {
    sent: { color: "ok", label: "Envoyé" },
    completed: { color: "ok", label: "Terminé" },
    ready: { color: "info", label: "Prêt" },
    queued: { color: "warn", label: "En file" },
    pending: { color: "warn", label: "En attente" },
    failed: { color: "danger", label: "Échec" },
    error: { color: "danger", label: "Erreur" },
    draft: { color: "muted", label: "Brouillon" },
  };
  return map[normalized] || { color: "muted", label: titleCase(normalized || "inconnu") };
}

function compliancePill(status: string | null | undefined) {
  const normalized = (status || "").toLowerCase();
  if (normalized === "ok") return { color: "ok", label: "Conforme" };
  if (normalized === "warning") return { color: "warn", label: "À surveiller" };
  if (normalized === "blocked") return { color: "danger", label: "Bloquant" };
  return { color: "muted", label: titleCase(normalized || "inconnu") };
}

function prettyProvider(slug: string | null | undefined) {
  const normalized = (slug || "").trim().toLowerCase();
  const map: Record<string, string> = {
    seqino: "Seqino",
    chorus: "Canal public",
    choruspro: "Canal public",
    manual_import: "Import manuel",
    http_generic: "HTTP générique",
    generic_http: "HTTP générique",
    dummy: "Démonstration",
    mock: "Démonstration",
  };
  return map[normalized] || titleCase(normalized || "inconnu");
}

const GENERIC_TRANSMISSION_MESSAGES = new Set([
  "",
  "accepted",
  "available",
  "blocked",
  "created",
  "delivered",
  "done",
  "error",
  "failed",
  "in_progress",
  "invalid",
  "ok",
  "paid",
  "pending",
  "processing",
  "queued",
  "rejected",
  "refused",
  "sent",
  "submitted",
  "unknown",
  "soumission enregistree",
  "soumission enregistrée",
  "statut synchronise",
  "statut synchronisé",
]);

function transmissionDisplayMessage(item: any) {
  const raw = String(item?.message || "").trim();
  const safe = sanitizeUserFacingApiMessage(raw, 400, "");
  const generic = GENERIC_TRANSMISSION_MESSAGES.has(safe.toLowerCase());
  const group = transmissionStatusGroup(item?.status);
  if (safe && !(generic && (group === "rejected" || group === "failed"))) return safe;
  if (group === "rejected" || group === "failed") return "Motif non fourni par la plateforme.";
  return safe || item?.external_id || "—";
}

async function readJson(path: string) {
  const res = await rawApi(path);
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = payload?.detail;
    const message = sanitizeUserFacingApiMessage(
      (typeof detail === "string" ? detail : detail?.message) ||
        payload?.message ||
        payload?.error?.message ||
        res.statusText,
      res.status,
      "Action indisponible pour le moment.",
    );
    const err: any = new Error(message);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function ActionLink({ to, children, className = "" }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-white transition-all shadow-sm ${className}`}
      style={{
        fontSize: "0.8125rem",
        fontWeight: 500,
        background: "#2563eb",
      }}
    >
      {children}
    </Link>
  );
}

function SectionEmpty({
  title,
  description,
  href,
  cta,
}: {
  title: string;
  description: string;
  href?: string;
  cta?: string;
}) {
  return (
    <EmptyCard
      title={title}
      description={description}
      action={href ? <ActionLink to={href}>{cta || "Configurer"}</ActionLink> : undefined}
    />
  );
}

function ExportOnlyModeNotice({ seqinoOnly = false }: { seqinoOnly?: boolean }) {
  return (
    <NoticeBanner tone="info" title="Mode export actif">
      {seqinoOnly ? "Les transmissions Seqino" : "Les transmissions Seqino/Chorus"} ne sont pas activées pour cet
      espace. Vous pouvez préparer et exporter vos documents Factur-X/CII, et UBL si ce format est disponible, sans
      envoi connecté.
    </NoticeBanner>
  );
}

function useRouteId() {
  const params = useParams();
  const raw = params?.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

const EINV_CHECK_LINKS: Record<string, string> = {
  company_profile: "/app/company",
  first_customer: "/app/customers",
  first_item: "/app/invoices/new",
  first_quote: "/app/quotes/new",
  first_invoice: "/app/invoices/new",
  pdp_connection: "/app/einvoicing",
  mandate: "/app/einvoicing",
  directory: "/app/directory",
  ereporting: "/app/e-reporting",
  sandbox_test: "/app/settings/sandbox",
};

function einvoicingHrefFromKey(key: string | null | undefined) {
  const normalized = String(key || "")
    .trim()
    .toLowerCase();
  return EINV_CHECK_LINKS[normalized] || "/app/einvoicing";
}

function describeMissingFields(fields: any) {
  if (!Array.isArray(fields) || !fields.length) return "Configuration à finaliser.";
  return `Champs à compléter : ${fields.join(", ")}`;
}

export function B2BEinvoicingPage() {
  const hydrated = useHydrated();
  const { capabilities, loading: sessionLoading } = useSession();
  const { summary } = useWorkspaceSummary();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<any>(null);
  const [onboarding, setOnboarding] = useState<any>(null);
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const seqinoOperational = einvoicingEnabled && Boolean(capabilities?.seqino_operational);

  const load = useCallback(async () => {
    if (!seqinoOperational) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [readinessRes, onboardingRes] = await Promise.allSettled([
        readJson("/api/einvoicing/readiness?mode=connected"),
        readJson("/api/platforms/onboarding-status"),
      ]);

      const messages: string[] = [];

      if (readinessRes.status === "fulfilled") setReadiness(readinessRes.value || null);
      else {
        setReadiness(null);
        messages.push(formatApiError(readinessRes.reason, "Checklist e-invoicing indisponible."));
      }

      if (onboardingRes.status === "fulfilled") setOnboarding(onboardingRes.value || null);
      else {
        setOnboarding(null);
        messages.push(formatApiError(onboardingRes.reason, "Statut plateforme indisponible."));
      }

      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  }, [seqinoOperational]);

  useEffect(() => {
    if (sessionLoading) return;
    if (!einvoicingEnabled || !seqinoOperational) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [load, sessionLoading, einvoicingEnabled, seqinoOperational]);

  const overall = readinessOverallPill(readiness?.overall_status);
  const connectorsCount = countEnabledConnectors(onboarding?.enabled_connectors);
  const lastSuccess = onboarding?.exchanges?.last_success;
  const setupPercent = Number(summary?.setup?.percent || 0);
  const setupCompleted = Number(summary?.setup?.completed || 0);
  const setupTotal = Number(summary?.setup?.total || 0);

  const nextActions = useMemo(() => {
    const summaryActions = Array.isArray(summary?.next_actions) ? summary.next_actions : [];
    if (summaryActions.length) {
      return summaryActions.slice(0, 4).map((action: any, index: number) => ({
        key: action.key || `summary-action-${index}`,
        label: action.label || titleCase(action.key || `action-${index + 1}`),
        reason: action.reason || "Étape recommandée pour débloquer la mise en service.",
        href: action.href || einvoicingHrefFromKey(action.key),
      }));
    }

    const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
    return checks
      .filter((item: any) => {
        const tone = readinessCheckPill(item.status).color;
        return tone !== "ok" && tone !== "muted";
      })
      .slice(0, 4)
      .map((item: any, index: number) => ({
        key: item.id || `readiness-action-${index}`,
        label: titleCase(item.id),
        reason: describeMissingFields(item.missing_fields),
        href: einvoicingHrefFromKey(item.id),
      }));
  }, [readiness, summary]);

  const checklistRows = useMemo(() => {
    const setupSteps = Array.isArray(summary?.setup?.steps) ? summary.setup.steps : [];
    if (setupSteps.length) {
      return setupSteps.slice(0, 6).map((step: any, index: number) => ({
        key: step.key || `summary-step-${index}`,
        label: step.label || titleCase(step.key || `step-${index + 1}`),
        reason: step.reason || "Action à compléter pour finaliser la mise en route.",
        href: step.href || einvoicingHrefFromKey(step.key),
        pill: readinessCheckPill(step.done ? "ok" : "missing"),
        done: Boolean(step.done),
      }));
    }

    const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
    return checks.slice(0, 6).map((item: any, index: number) => ({
      key: item.id || `readiness-step-${index}`,
      label: titleCase(item.id),
      reason: describeMissingFields(item.missing_fields),
      href: einvoicingHrefFromKey(item.id),
      pill: readinessCheckPill(item.status),
      done: readinessCheckPill(item.status).color === "ok",
    }));
  }, [readiness, summary]);

  const primaryAction = nextActions[0] || checklistRows.find((item: any) => !item.done) || null;

  return (
    <div>
      <AppPageHeader
        title="Pilotage e-facturation B2B"
        breadcrumb="E-facturation"
        description={
          !sessionLoading && einvoicingEnabled && !seqinoOperational
            ? "Préparation des documents structurés en mode export, sans transmission connectée."
            : "Lecture simple pour savoir si l’espace est prêt, quoi faire ensuite et quels points bloquent encore les premiers envois."
        }
        actions={
          sessionLoading ? null : !einvoicingEnabled ? (
            <StatusPill status="warn" label={einvoicingGate.statusLabel} />
          ) : seqinoOperational ? (
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          ) : (
            <StatusPill status="info" label="Mode export" />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={
              einvoicingGate.reactivationRequired ? einvoicingGate.statusLabel : "E-facturation disponible sur Pro"
            }
            description={
              einvoicingGate.reactivationDescription ||
              "Le plan Starter conserve la facturation classique. Pro ouvre la préparation e-facturation ; Seqino et les opérations connectées exigent séparément un contrat, un mandat et une configuration opérationnelle."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={einvoicingGate.reactivationNote || undefined}
          />
        ) : null}
        {!sessionLoading && einvoicingEnabled && !seqinoOperational ? <ExportOnlyModeNotice seqinoOnly /> : null}
        <SeqinoTokenNotice enabled={Boolean(capabilities?.seqino_operational && capabilities?.token_topup_enabled)} />
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        {hydrated && sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled || !seqinoOperational ? null : hydrated && loading ? (
          <LoadingCard label="Chargement de la vue e-facturation…" />
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="relative overflow-hidden">
                <div className="absolute left-0 right-0 top-0 h-[3px] bg-[#3b82f6]" />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">Progression</div>
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#eff6ff] text-[#1d4ed8]">
                    <Shield className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-2 text-[1.45rem] font-[800] tracking-[-0.03em] text-[#0f172a]">{setupPercent}%</div>
                <div className="mt-1.5 text-[0.73rem] text-[#94a3b8]">
                  {setupCompleted} étape(s) validée(s) sur {setupTotal || 0}
                </div>
              </Card>

              <Card className="relative overflow-hidden">
                <div className="absolute left-0 right-0 top-0 h-[3px] bg-[#d97706]" />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">Connecteurs</div>
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#fffbeb] text-[#d97706]">
                    <Globe className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-2 text-[1.45rem] font-[800] tracking-[-0.03em] text-[#0f172a]">
                  {connectorsCount}
                </div>
                <div className="mt-1.5 text-[0.73rem] text-[#94a3b8]">
                  {Number(onboarding?.mandate?.active_count || 0)} mandat(s) actif(s)
                </div>
              </Card>

              <Card className="relative overflow-hidden">
                <div
                  className={`absolute left-0 right-0 top-0 h-[3px] ${
                    onboardingDirectoryPill(onboarding?.directory?.status).color === "ok"
                      ? "bg-[#16a34a]"
                      : onboardingDirectoryPill(onboarding?.directory?.status).color === "danger"
                        ? "bg-[#ef4444]"
                        : "bg-[#7c3aed]"
                  }`}
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">
                    Synchro Seqino
                  </div>
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#f5f3ff] text-[#7c3aed]">
                    <Building2 className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-2 text-[1.05rem] font-[800] tracking-[-0.03em] text-[#0f172a] leading-[1.2]">
                  {onboardingDirectoryPill(onboarding?.directory?.status).label}
                </div>
                <div className="mt-1.5 text-[0.73rem] text-[#94a3b8]">
                  {lastSuccess ? `Dernier succès ${formatDateFr(lastSuccess)}` : "Aucun succès récent"}
                </div>
              </Card>
            </div>

            <Card className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">
                  À faire maintenant
                </div>
                <div className="mt-2 text-[1rem] font-[800] text-[#0f172a]">
                  {primaryAction?.label || "Prochaine étape à confirmer"}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {primaryAction ? <ActionLink to={primaryAction.href}>Ouvrir</ActionLink> : null}
                <SecondaryButton onClick={() => void load()}>
                  <RefreshCw className="w-3.5 h-3.5" /> Recharger
                </SecondaryButton>
              </div>
            </Card>

            <Card>
              <SectionTitle action={<StatusPill {...overall} />}>Checklist essentielle</SectionTitle>
              <div className="space-y-3">
                {checklistRows.length ? (
                  checklistRows.map((item: any, index: number) => (
                    <div
                      key={item.key}
                      className="flex items-start gap-3 rounded-2xl border border-[#e2e8f0] bg-white px-4 py-3.5 transition-all hover:border-[#fecaca] hover:bg-[#fffafa]"
                    >
                      <div
                        className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full ${
                          item.done ? "bg-[#16a34a] text-white" : "bg-[#f8fafc] text-[#64748b]"
                        }`}
                      >
                        {item.done ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <span className="text-xs font-bold">{index + 1}</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-[#334155]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                            {item.label}
                          </div>
                          <StatusPill {...item.pill} />
                        </div>
                        {!item.done ? (
                          <p className="mt-1.5 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.6 }}>
                            {item.reason}
                          </p>
                        ) : null}
                      </div>
                      {!item.done ? (
                        <ActionLink to={item.href} className="!px-3 !py-1.5 !text-xs">
                          Ouvrir
                        </ActionLink>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="text-[#94a3b8] text-sm">
                    Checklist indisponible pour le moment. Commencez par compléter l’entreprise, puis configurez la
                    plateforme.
                  </p>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export function SetupEinvoicingPage() {
  const hydrated = useHydrated();
  const { capabilities, loading: sessionLoading, user } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<any>(null);
  const [onboarding, setOnboarding] = useState<any>(null);
  const [seqinoStatus, setSeqinoStatus] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [mandateConsent, setMandateConsent] = useState(false);
  const [activationBusy, setActivationBusy] = useState(false);
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const seqinoOperational = einvoicingEnabled && Boolean(capabilities?.seqino_operational);
  const chorusOperational = einvoicingEnabled && Boolean(capabilities?.chorus_operational);
  const einvoicingOperational =
    einvoicingEnabled && Boolean(capabilities?.einvoicing_operational || seqinoOperational || chorusOperational);
  const canManageIntegration =
    user?.is_admin === true || ["owner", "admin"].includes(String(user?.role || "").toLowerCase());

  const load = useCallback(async () => {
    if (!einvoicingOperational) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [readinessRes, onboardingRes, seqinoStatusRes, companyRes] = await Promise.allSettled([
        readJson("/api/einvoicing/readiness?mode=connected"),
        readJson("/api/platforms/onboarding-status"),
        canManageIntegration && seqinoOperational
          ? readJson("/api/platforms/seqino/onboarding-status")
          : Promise.resolve(null),
        readJson("/api/company/profile"),
      ]);

      const messages: string[] = [];
      if (readinessRes.status === "fulfilled") setReadiness(readinessRes.value || null);
      else messages.push(formatApiError(readinessRes.reason, "Checklist indisponible."));
      if (onboardingRes.status === "fulfilled") setOnboarding(onboardingRes.value || null);
      else messages.push(formatApiError(onboardingRes.reason, "Onboarding indisponible."));
      if (seqinoStatusRes.status === "fulfilled") setSeqinoStatus(seqinoStatusRes.value || null);
      else messages.push(formatApiError(seqinoStatusRes.reason, "Statut d’activation Seqino indisponible."));
      if (companyRes.status === "fulfilled") setCompany(companyRes.value || null);
      else messages.push(formatApiError(companyRes.reason, "Profil entreprise indisponible."));
      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  }, [canManageIntegration, einvoicingOperational, seqinoOperational]);

  useEffect(() => {
    if (sessionLoading) return;
    if (!einvoicingEnabled || !einvoicingOperational) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [load, sessionLoading, einvoicingEnabled, einvoicingOperational]);

  const checksById = useMemo(() => {
    const entries = new Map();
    for (const item of readiness?.checks || []) entries.set(item.id, item);
    return entries;
  }, [readiness]);

  const onboardingUrl = useMemo(() => {
    const raw = String(seqinoStatus?.onboarding_url || "").trim();
    if (!raw) return null;
    try {
      const parsed = new URL(raw);
      return parsed.protocol === "https:" ? parsed.toString() : null;
    } catch {
      return null;
    }
  }, [seqinoStatus?.onboarding_url]);
  const seqinoStatusValue = String(seqinoStatus?.status || "NOT_STARTED")
    .trim()
    .toUpperCase();
  const activeMandateCount = Math.max(
    Number(seqinoStatus?.mandate_active_count || 0),
    Number(onboarding?.mandate?.active_count || 0),
  );
  const seqinoConnected = Boolean(seqinoStatus?.connected) && activeMandateCount > 0;
  const seqinoStatusPill = seqinoConnected
    ? { status: "ok" as const, label: "Activation validée" }
    : seqinoStatusValue === "NOT_STARTED"
      ? { status: "muted" as const, label: "Non démarrée" }
      : seqinoStatusValue.includes("REJECT") || seqinoStatusValue.includes("ERROR")
        ? { status: "danger" as const, label: "Action requise" }
        : { status: "warn" as const, label: "Validation en cours" };

  const activateSeqino = async () => {
    if (!seqinoOperational || !canManageIntegration || activationBusy) return;
    if (!mandateConsent) {
      setError("Confirmez le mandat et la transmission des informations nécessaires à Seqino avant de continuer.");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `${SEQINO_MANDATE_CONSENT_TEXT}\n\nConfirmer l’activation et ouvrir le parcours de vérification KYB chez Seqino ?`,
      )
    ) {
      return;
    }
    setActivationBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/platforms/seqino/mandates/default", {
        method: "POST",
        body: JSON.stringify({ accept_mandate: true }),
      });
      const result: any = await api("/api/platforms/seqino/onboard", {
        method: "POST",
        body: JSON.stringify({ force: false, accept_mandate: true }),
      });
      setSeqinoStatus(result || null);
      setMandateConsent(false);
      setNotice(
        result?.connected
          ? "Mandat Seqino actif et connexion validée."
          : "Mandat préparé. Finalisez maintenant la vérification KYB avec le lien sécurisé Seqino.",
      );
      await load();
    } catch (err) {
      setError(formatApiError(err, "Activation Seqino impossible. Vérifiez le profil entreprise puis réessayez."));
    } finally {
      setActivationBusy(false);
    }
  };

  const steps = useMemo(() => {
    const companyCheck = checksById.get("company_profile");
    const pdpCheck = checksById.get("pdp_connection");
    const eReportingCheck = checksById.get("ereporting");
    const sandboxCheck = checksById.get("sandbox_test");

    const connectedSteps = [
      {
        key: "company_profile",
        title: "Profil entreprise",
        description: "SIRET, TVA, adresse, RCS et informations légales pour émettre sans blocage.",
        status:
          companyCheck?.status ||
          (company?.siret &&
          (company?.vat_number || company?.vat_exemption_notice) &&
          (company?.address_line1 || company?.address)
            ? "ok"
            : "missing"),
        href: "/app/company",
      },
      {
        key: "pdp_connection",
        title: seqinoOperational ? "Seqino / connecteur" : "Chorus Pro / connecteur",
        description: seqinoOperational
          ? "Connexion Seqino pour les échanges B2B."
          : "Connexion au canal public Chorus Pro pour les échanges B2G.",
        status: pdpCheck?.status || (countEnabledConnectors(onboarding?.enabled_connectors) > 0 ? "ok" : "missing"),
        href: seqinoOperational ? "/app/einvoicing#seqino-activation" : "/app/integrations",
      },
      ...(seqinoOperational
        ? [
            {
              key: "mandate",
              title: "Mandat de réception",
              description: "Nécessaire pour la réception et certains statuts via Seqino.",
              status: onboarding?.mandate?.required
                ? Number(onboarding?.mandate?.active_count || 0) > 0
                  ? "ok"
                  : "missing"
                : "na",
              href: "/app/einvoicing#seqino-activation",
            },
            {
              key: "directory",
              title: "Synchronisation Seqino",
              description: "Synchroniser les destinataires via Seqino, sans configuration manuelle dans PixFacture.",
              status:
                onboarding?.directory?.status === "ok"
                  ? "ok"
                  : onboarding?.directory?.status === "error"
                    ? "error"
                    : onboarding?.directory?.status === "disabled"
                      ? "na"
                      : "todo",
              href: "/app/einvoicing#seqino-status",
            },
          ]
        : []),
      {
        key: "ereporting",
        title: "E-reporting",
        description: "Configurer les périodicités et la production des rapports si requis.",
        status: eReportingCheck?.status || "na",
        href: "/app/e-reporting",
      },
      {
        key: "sandbox_test",
        title: "Test & première transmission",
        description: "Lancer un essai dans l’environnement de test puis vérifier un premier succès de transmission.",
        status: sandboxCheck?.status || (onboarding?.exchanges?.last_success ? "ok" : "todo"),
        href: "/app/settings/sandbox",
      },
    ];
    return connectedSteps;
  }, [checksById, onboarding, company, seqinoOperational]);

  const doneCount = steps.filter((step) => readinessCheckPill(step.status).color === "ok").length;
  const overall = readinessOverallPill(readiness?.overall_status);

  return (
    <div>
      <AppPageHeader
        title="Préparer la facturation électronique"
        breadcrumb="E-facturation"
        description={
          !sessionLoading && einvoicingEnabled && !einvoicingOperational
            ? "Préparez et exportez vos documents structurés, sans transmission connectée pour le moment."
            : "Feuille de route courte et orientée action, de la configuration au premier échange conforme."
        }
        actions={
          sessionLoading ? null : !einvoicingEnabled ? (
            <StatusPill status="warn" label={einvoicingGate.statusLabel} />
          ) : einvoicingOperational ? (
            <StatusPill {...overall} />
          ) : (
            <StatusPill status="info" label="Mode export" />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={
              einvoicingGate.reactivationRequired
                ? einvoicingGate.statusLabel
                : "Assistant e-facturation réservé au plan Pro"
            }
            description={
              einvoicingGate.reactivationDescription ||
              "Starter couvre la gestion commerciale classique. Le plan Pro ouvre la préparation e-facturation ; tout échange via une plateforme agréée exige ensuite un contrat, un mandat valide et une configuration opérationnelle."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={
              einvoicingGate.reactivationNote ||
              "Le passage au plan Pro n’active pas automatiquement une connexion externe."
            }
          />
        ) : null}
        {!sessionLoading && einvoicingEnabled && !einvoicingOperational ? <ExportOnlyModeNotice /> : null}
        <SeqinoTokenNotice enabled={Boolean(seqinoOperational && capabilities?.token_topup_enabled)} />
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? (
          <NoticeBanner tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </NoticeBanner>
        ) : null}

        {!sessionLoading && einvoicingOperational ? (
          <div className="bg-[#eff6ff] border border-[#bfdbfe] rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <h3 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 700 }}>
                Progression {doneCount}/{steps.length}
              </h3>
              <p className="text-[#475569] mt-1" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
                Commencez par le dossier société, puis la plateforme et l’annuaire. Ce parcours permet de valider les
                prérequis avant le premier échange.
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <ActionLink to="/app/company">Compléter l’entreprise</ActionLink>
              <SecondaryButton onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5" /> Recharger
              </SecondaryButton>
            </div>
          </div>
        ) : null}

        {!sessionLoading && seqinoOperational ? (
          <Card id="seqino-activation" className="scroll-mt-6">
            <SectionTitle action={<StatusPill {...seqinoStatusPill} />}>Activation Seqino</SectionTitle>
            <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
              <div className="space-y-4">
                <p className="text-[#475569]" style={{ fontSize: "0.8125rem", lineHeight: 1.65 }}>
                  L’activation crée le mandat de réception de cette entreprise, puis un lien sécurisé vers Seqino pour
                  la vérification d’identité de l’entreprise (KYB). L’abonnement Pro seul ne vaut pas mandat.
                </p>
                {!canManageIntegration ? (
                  <NoticeBanner tone="info">
                    Seul un propriétaire ou administrateur peut accepter le mandat. Demandez-lui de terminer cette étape
                    depuis cet écran.
                  </NoticeBanner>
                ) : seqinoConnected ? (
                  <NoticeBanner tone="success">
                    Le mandat est actif. Les échanges restent soumis aux contrôles du dossier entreprise et au statut
                    opérationnel affiché avant chaque transmission.
                  </NoticeBanner>
                ) : (
                  <>
                    <label className="flex items-start gap-3 rounded-xl border border-[#dbe4ef] bg-[#f8fafc] p-4">
                      <input
                        type="checkbox"
                        checked={mandateConsent}
                        onChange={(event) => setMandateConsent(event.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-[#94a3b8] text-[#1d4ed8]"
                      />
                      <span className="text-[#334155]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                        <span className="block font-semibold">{SEQINO_MANDATE_CONSENT_TEXT}</span>
                        <span className="mt-1 block">
                          Cette activation transmet à Seqino les données d’identification nécessaires au raccordement, à
                          la réception et au suivi réglementaire. Je confirme être habilité à engager l’entreprise.
                        </span>
                      </span>
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      <PrimaryButton
                        type="button"
                        onClick={() => void activateSeqino()}
                        disabled={!mandateConsent || activationBusy}
                      >
                        <Shield className="h-3.5 w-3.5" />
                        {activationBusy
                          ? "Activation…"
                          : activeMandateCount > 0
                            ? "Reprendre l’activation"
                            : "Activer le mandat"}
                      </PrimaryButton>
                      <Link
                        to="/legal/einvoicing-scope"
                        className="text-sm font-semibold text-[#1d4ed8] hover:underline"
                      >
                        Consulter le périmètre et les responsabilités
                      </Link>
                    </div>
                  </>
                )}
              </div>

              <div id="seqino-status" className="scroll-mt-6 rounded-xl border border-[#e2e8f0] bg-white p-4">
                <div className="text-[#0f172a] text-sm font-semibold">État de l’activation</div>
                <dl className="mt-3 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-[#64748b]">Statut KYB</dt>
                    <dd className="font-medium text-[#334155]">{titleCase(seqinoStatusValue)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-[#64748b]">Mandats actifs</dt>
                    <dd className="font-medium text-[#334155]">{activeMandateCount}</dd>
                  </div>
                </dl>
                {onboardingUrl ? (
                  <a
                    href={onboardingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#1d4ed8] px-3 py-2 text-sm font-semibold text-white hover:bg-[#1e40af]"
                  >
                    Continuer la vérification chez Seqino <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
                {canManageIntegration && seqinoStatusValue !== "NOT_STARTED" ? (
                  <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading || activationBusy}
                    className="mt-3 block text-sm font-semibold text-[#1d4ed8] hover:underline disabled:opacity-60"
                  >
                    J’ai terminé : vérifier le statut
                  </button>
                ) : null}
                <p className="mt-3 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                  Le lien ouvre un service externe Seqino. Ne transmettez aucun secret dans le support ou par email.
                </p>
              </div>
            </div>
          </Card>
        ) : null}

        {hydrated && sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled || !einvoicingOperational ? null : hydrated && loading ? (
          <LoadingCard label="Chargement de la checklist…" />
        ) : (
          <div className="grid xl:grid-cols-[1.35fr_1fr] gap-6 items-start">
            <div className="space-y-4">
              {steps.map((step, index) => {
                const pill = readinessCheckPill(step.status);
                return (
                  <Card
                    key={step.key}
                    className={
                      pill.color === "ok" ? "border-[#86efac]" : pill.color === "danger" ? "border-[#fecaca]" : ""
                    }
                  >
                    <div className="flex items-start gap-4">
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${pill.color === "ok" ? "bg-[#16a34a] text-white" : pill.color === "danger" ? "bg-[#dc2626] text-white" : "bg-[#f1f5f9] text-[#64748b]"}`}
                      >
                        {pill.color === "ok" ? (
                          <Check className="w-4 h-4" />
                        ) : pill.color === "danger" ? (
                          <XCircle className="w-4 h-4" />
                        ) : (
                          <span className="text-xs font-bold">{index + 1}</span>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2 mb-1.5">
                          <h3 className="text-[#0f172a] text-[0.9375rem] font-semibold">{step.title}</h3>
                          <StatusPill {...pill} />
                        </div>
                        <p className="text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
                          {step.description}
                        </p>
                        <div className="mt-3">
                          <Link
                            to={step.href}
                            className="inline-flex items-center gap-1 text-[#1d4ed8] hover:text-[#1e40af] text-sm font-semibold"
                          >
                            Ouvrir <ArrowRight className="w-3 h-3" />
                          </Link>
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>

            <div className="space-y-6">
              <Card>
                <SectionTitle>Pré-requis à préparer</SectionTitle>
                <div className="space-y-2">
                  {(readiness?.prerequisites || []).map((item: string) => (
                    <div key={item} className="flex items-start gap-2 text-[#374151] text-sm">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </div>
                  ))}
                  {!readiness?.prerequisites?.length ? (
                    <p className="text-[#94a3b8] text-sm">Aucun prérequis disponible pour le moment.</p>
                  ) : null}
                </div>
              </Card>

              <Card>
                <SectionTitle>Derniers signaux</SectionTitle>
                <div className="space-y-3 text-[#374151] text-sm">
                  <div className="flex items-center justify-between">
                    <span>Synchro Seqino</span>
                    <StatusPill {...onboardingDirectoryPill(onboarding?.directory?.status)} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Dernier succès</span>
                    <span className="text-[#64748b]">{formatDateTimeFr(onboarding?.exchanges?.last_success)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Dernière erreur</span>
                    <span className="text-[#64748b] text-right max-w-[14rem]">
                      {onboarding?.exchanges?.error_summary
                        ? sanitizeUserFacingApiMessage(
                            onboarding.exchanges.error_summary,
                            400,
                            "Le dernier échange n'a pas abouti.",
                          )
                        : "Aucune"}
                    </span>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function IntegrationsPage() {
  const hydrated = useHydrated();
  const { capabilities, loading: sessionLoading } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [onboarding, setOnboarding] = useState<any>(null);
  const [testingSlug, setTestingSlug] = useState<string | null>(null);
  const [disconnectingSlug, setDisconnectingSlug] = useState<string | null>(null);
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const seqinoOperational = einvoicingEnabled && Boolean(capabilities?.seqino_operational);
  const chorusOperational = einvoicingEnabled && Boolean(capabilities?.chorus_operational);
  const einvoicingOperational =
    einvoicingEnabled && Boolean(capabilities?.einvoicing_operational || seqinoOperational || chorusOperational);

  const load = useCallback(async () => {
    if (!einvoicingOperational) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [connectorsRes, connectionsRes, onboardingRes] = await Promise.allSettled([
        readJson("/api/platforms/connectors"),
        readJson("/api/platforms/connections"),
        readJson("/api/platforms/onboarding-status"),
      ]);

      const messages: string[] = [];
      if (connectorsRes.status === "fulfilled")
        setConnectors(Array.isArray(connectorsRes.value?.connectors) ? connectorsRes.value.connectors : []);
      else messages.push(formatApiError(connectorsRes.reason, "Catalogue des connecteurs indisponible."));

      if (connectionsRes.status === "fulfilled")
        setConnections(Array.isArray(connectionsRes.value) ? connectionsRes.value : []);
      else {
        setConnections([]);
        messages.push(formatApiError(connectionsRes.reason, "Connexions indisponibles."));
      }

      if (onboardingRes.status === "fulfilled") setOnboarding(onboardingRes.value || null);
      else messages.push(formatApiError(onboardingRes.reason, "Statut d’onboarding indisponible."));

      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  }, [einvoicingOperational]);

  useEffect(() => {
    if (sessionLoading) return;
    if (!einvoicingEnabled || !einvoicingOperational) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [load, sessionLoading, einvoicingEnabled, einvoicingOperational]);

  const connectionBySlug = useMemo(() => {
    const map = new Map();
    for (const item of connections) map.set((item.provider_slug || "").toLowerCase(), item);
    return map;
  }, [connections]);

  const testConnection = async (slug: string) => {
    if (!einvoicingOperational || !slug) return;
    setTestingSlug(slug);
    setNotice(null);
    setError(null);
    try {
      const result: any = await api(`/api/platforms/test/${slug}`, { method: "POST" });
      setNotice(result?.message || `Test ${prettyProvider(slug)} OK.`);
    } catch (err) {
      setError(formatApiError(err, `Test ${prettyProvider(slug)} impossible.`));
    } finally {
      setTestingSlug(null);
    }
  };

  const disconnect = async (slug: string) => {
    if (!einvoicingOperational || !slug) return;
    if (!window.confirm(`Déconnecter ${prettyProvider(slug)} ?`)) return;
    setDisconnectingSlug(slug);
    setNotice(null);
    setError(null);
    try {
      await api(`/api/platforms/connections?provider_slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
      setNotice(`${prettyProvider(slug)} déconnecté.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, `Déconnexion ${prettyProvider(slug)} impossible.`));
    } finally {
      setDisconnectingSlug(null);
    }
  };

  const connectedCount = connections.filter((item) => (item.status || "").toLowerCase() === "connected").length;

  return (
    <div>
      <AppPageHeader
        title="Plateformes & connecteurs"
        breadcrumb="E-facturation"
        description="Centre de pilotage des connecteurs, de leur statut et des contrôles disponibles."
        actions={
          sessionLoading ? null : !einvoicingEnabled ? (
            <StatusPill status="warn" label={einvoicingGate.statusLabel} />
          ) : einvoicingOperational ? (
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          ) : (
            <StatusPill status="info" label="Mode export" />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={
              einvoicingGate.reactivationRequired ? einvoicingGate.statusLabel : "Connecteurs réservés au plan Pro"
            }
            description={
              einvoicingGate.reactivationDescription ||
              "Pro ouvre la préparation des connecteurs. Leur test et leur exploitation exigent séparément un contrat, un mandat et une configuration opérationnelle."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={einvoicingGate.reactivationNote || undefined}
          />
        ) : null}
        {!sessionLoading && einvoicingEnabled && !einvoicingOperational ? <ExportOnlyModeNotice /> : null}
        <SeqinoTokenNotice enabled={Boolean(seqinoOperational && capabilities?.token_topup_enabled)} />
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? (
          <NoticeBanner tone="success" onDismiss={() => setNotice(null)} autoDismissMs={6000}>
            {notice}
          </NoticeBanner>
        ) : null}

        {!sessionLoading && einvoicingOperational ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Connecteurs disponibles"
              value={connectors.length}
              sub="Catalogue disponible"
              accent="blue"
              icon={<Globe className="w-4 h-4" />}
            />
            <StatCard
              label="Connexions actives"
              value={connectedCount}
              sub="Espace courant"
              accent="green"
              icon={<CheckCircle className="w-4 h-4" />}
            />
            <StatCard
              label="Mandats actifs"
              value={onboarding?.mandate?.active_count || 0}
              sub={onboarding?.mandate?.required ? "requis pour la plateforme" : "non requis actuellement"}
              accent="purple"
              icon={<Shield className="w-4 h-4" />}
            />
            <StatCard
              label="Dernier succès"
              value={formatDateTimeFr(onboarding?.exchanges?.last_success)}
              sub={
                onboarding?.exchanges?.error_summary
                  ? sanitizeUserFacingApiMessage(
                      onboarding.exchanges.error_summary,
                      400,
                      "Le dernier échange n'a pas abouti.",
                    )
                  : "Pas d’erreur récente"
              }
              accent={onboarding?.exchanges?.last_success ? "green" : "amber"}
              icon={<Send className="w-4 h-4" />}
            />
          </div>
        ) : null}

        {hydrated && sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled || !einvoicingOperational ? null : hydrated && loading ? (
          <LoadingCard label="Chargement des plateformes…" />
        ) : (
          <>
            {onboarding?.errors?.length ? (
              <NoticeBanner tone="warning">
                <div className="space-y-1">
                  <div style={{ fontWeight: 600 }}>Points bloquants ou incomplets</div>
                  {onboarding.errors.map((item: any) => (
                    <div key={item.code} className="text-sm">
                      {sanitizeUserFacingApiMessage(item.message, 400, "Une étape de préparation reste à terminer.")}
                      {item.hint
                        ? ` — ${sanitizeUserFacingApiMessage(item.hint, 400, "Consultez l'étape correspondante.")}`
                        : ""}
                    </div>
                  ))}
                </div>
              </NoticeBanner>
            ) : null}

            <div className="space-y-6">
              <Card>
                <SectionTitle>Connecteurs</SectionTitle>
                <div className="space-y-3">
                  {connectors.length === 0 ? (
                    <p className="text-[#94a3b8] text-sm">
                      Aucun connecteur activé pour cet espace. Vérifiez le plan Pro et le dossier entreprise, puis
                      contactez le support si cela persiste.
                    </p>
                  ) : (
                    connectors.map((connector) => {
                      const current = connectionBySlug.get((connector.slug || "").toLowerCase());
                      const active = (current?.status || "").toLowerCase() === "connected";
                      return (
                        <div key={connector.slug} className="border border-[#e2e8f0] rounded-xl p-4 bg-[#f8fafc]">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="text-[#0f172a] text-sm font-semibold">
                                  {connector.label || prettyProvider(connector.slug)}
                                </div>
                                <StatusPill
                                  status={active ? "ok" : "muted"}
                                  label={active ? "Connecté" : "Non connecté"}
                                />
                              </div>
                              <p className="text-[#64748b] mt-1 text-xs leading-relaxed">
                                {connector.description ||
                                  "Connecteur disponible pour l’émission, la réception ou le suivi de statut."}
                              </p>
                              <div className="mt-2 text-[#64748b] text-xs">
                                Type {titleCase(connector.kind)} · Auth {titleCase(connector.auth_type)}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2 justify-end">
                              {active ? (
                                <>
                                  <SecondaryButton
                                    disabled={testingSlug === connector.slug}
                                    onClick={() => void testConnection(connector.slug)}
                                  >
                                    <Check className="w-3.5 h-3.5" />{" "}
                                    {testingSlug === connector.slug ? "Test…" : "Tester"}
                                  </SecondaryButton>
                                  <DangerButton
                                    disabled={disconnectingSlug === connector.slug}
                                    onClick={() => void disconnect(connector.slug)}
                                  >
                                    <XCircle className="w-3.5 h-3.5" />{" "}
                                    {disconnectingSlug === connector.slug ? "Déconnexion…" : "Déconnecter"}
                                  </DangerButton>
                                </>
                              ) : (
                                <ActionLink to="/app/einvoicing" className="!px-3 !py-1.5">
                                  Configurer
                                </ActionLink>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </Card>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <SectionTitle>État global</SectionTitle>
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span>Mandat requis</span>
                      <StatusPill
                        status={onboarding?.mandate?.required ? "warn" : "muted"}
                        label={onboarding?.mandate?.required ? "Oui" : "Non"}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Synchro Seqino</span>
                      <StatusPill {...onboardingDirectoryPill(onboarding?.directory?.status)} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Dernière synchro</span>
                      <span className="text-[#64748b]">{formatDateTimeFr(onboarding?.directory?.last_sync)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Dernière erreur</span>
                      <span className="text-[#64748b] text-right max-w-[14rem]">
                        {onboarding?.directory?.error || onboarding?.exchanges?.error_summary
                          ? sanitizeUserFacingApiMessage(
                              onboarding?.directory?.error || onboarding?.exchanges?.error_summary,
                              400,
                              "La dernière synchronisation n'a pas abouti.",
                            )
                          : "Aucune"}
                      </span>
                    </div>
                  </div>
                </Card>

                <Card>
                  <SectionTitle>Parcours conseillé</SectionTitle>
                  <div className="space-y-2 text-[#374151] text-sm">
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>Compléter la société et les clients FR.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>Activer au moins un connecteur et tester la connexion.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>Signez le mandat si vous voulez la réception et certains statuts.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-[#059669] flex-shrink-0 mt-0.5" />
                      <span>Valider l’annuaire et une première transmission réelle.</span>
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function TransmissionsPage() {
  const hydrated = useHydrated();
  const { capabilities, loading: sessionLoading } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistedListPageSize("pixfacture.transmissions.pageSize.v1");
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const einvoicingOperational =
    einvoicingEnabled &&
    Boolean(
      capabilities?.einvoicing_operational || capabilities?.seqino_operational || capabilities?.chorus_operational,
    );

  const load = useCallback(async () => {
    if (!einvoicingEnabled) {
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const transmissionsRes = await readJson("/api/platforms/transmissions");
      setItems(Array.isArray(transmissionsRes) ? transmissionsRes : []);
    } catch (err) {
      setItems([]);
      setError(formatApiError(err, "Impossible de charger les transmissions."));
    } finally {
      setLoading(false);
    }
  }, [einvoicingEnabled]);

  useEffect(() => {
    if (sessionLoading) return;
    void load();
  }, [load, sessionLoading]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      const status = (item.status || "").toLowerCase();
      const visibleStatus = transmissionPill(item.status).label;
      const provider = prettyProvider(item.channel);
      const message = transmissionDisplayMessage(item);
      const haystack =
        `${item.invoice_number || ""} ${item.invoice_id || ""} ${item.channel || ""} ${provider} ${status} ${visibleStatus} ${item.external_id || ""} ${message}`.toLowerCase();
      const matchSearch = !query || haystack.includes(query);
      const matchStatus = statusFilter === "all" || transmissionStatusGroup(status) === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [items, search, statusFilter]);
  const pageItems = useMemo(() => paginateList(filtered, page, pageSize), [filtered, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const totalErrors = filtered.filter((item) =>
    ["failed", "rejected", "refused", "blocked"].includes((item.status || "").toLowerCase()),
  ).length;
  const totalOk = filtered.filter((item) =>
    ["accepted", "available", "paid"].includes((item.status || "").toLowerCase()),
  ).length;
  const totalPending = filtered.length - totalErrors - totalOk;
  const transmissionTabs = [
    { value: "all", label: "Toutes" },
    { value: "success", label: "Réussies" },
    { value: "submitted", label: "Envoyées" },
    { value: "processing", label: "En cours" },
    { value: "failed", label: "Échecs" },
    { value: "rejected", label: "Rejets" },
  ] as const;
  const tabCount = (status: (typeof transmissionTabs)[number]["value"]) =>
    status === "all" ? items.length : items.filter((item) => transmissionStatusGroup(item.status) === status).length;
  const hasTransmissionFilters = Boolean(search.trim()) || statusFilter !== "all";
  const transmissionExportPath = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (search.trim()) params.set("search", search.trim());
    const query = params.toString();
    return `/api/platforms/transmissions/export.csv${query ? `?${query}` : ""}`;
  }, [search, statusFilter]);

  return (
    <div>
      <AppPageHeader
        title="Transmissions"
        breadcrumb="E-facturation"
        description="Historique centralisé des statuts d’envoi pour faciliter le suivi opérationnel et le support."
        actions={
          sessionLoading ? null : einvoicingEnabled ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!einvoicingOperational ? <StatusPill status="info" label="Mode export" /> : null}
              <SecondaryButton
                onClick={() => void downloadProtectedFile(transmissionExportPath, "transmissions.csv")}
                aria-label="Exporter la vue filtrée des transmissions"
                title="Exporte uniquement les transmissions correspondant aux filtres affichés."
              >
                <Download className="w-3.5 h-3.5" /> Exporter la vue filtrée
              </SecondaryButton>
              <SecondaryButton onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
              </SecondaryButton>
            </div>
          ) : (
            <StatusPill status="warn" label={einvoicingGate.statusLabel} />
          )
        }
      />
      <WorkbenchPage>
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={
              einvoicingGate.reactivationRequired ? einvoicingGate.statusLabel : "Transmissions disponibles sur Pro"
            }
            description={
              einvoicingGate.reactivationDescription ||
              "Le plan Starter conserve les devis, factures et PDF. L’historique des transmissions e-facturation et les exports associés sont disponibles avec le plan Pro."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={einvoicingGate.reactivationNote || undefined}
          />
        ) : null}
        {!sessionLoading && einvoicingEnabled && !einvoicingOperational ? <ExportOnlyModeNotice /> : null}
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        {hydrated && sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled ? null : (
          <>
            <SalesMetricsGrid>
              <SalesMetricCard
                tone="transmissions"
                density="client"
                accent="info"
                label="Lignes"
                value={filtered.length}
                detail="Après filtres"
                icon={<FileText className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="transmissions"
                density="client"
                accent="success"
                label="Succès"
                value={totalOk}
                detail="Acceptées / disponibles"
                icon={<CheckCircle className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="transmissions"
                density="client"
                accent="warning"
                label="En attente"
                value={totalPending}
                detail="À suivre"
                icon={<RefreshCw className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="transmissions"
                density="client"
                accent="danger"
                label="Erreurs"
                value={totalErrors}
                detail="Rejets / échecs"
                icon={<AlertCircle className="h-4 w-4" />}
              />
            </SalesMetricsGrid>

            <SalesListBlock
              tone="transmissions"
              density="client"
              filters={transmissionTabs.map((tab) => ({
                value: tab.value,
                label: tab.label,
                count: tabCount(tab.value),
              }))}
              filterValue={statusFilter}
              onFilterChange={(value) => setStatusFilter(value as (typeof transmissionTabs)[number]["value"])}
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder="Facture, canal, message…"
              searchWidth="20rem"
            >
              {hydrated && loading ? (
                <div className="px-5 py-14 text-center text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  Chargement des transmissions…
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                      <FileText className="h-5 w-5 text-[#cbd5e1]" />
                    </div>
                    <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                      {hasTransmissionFilters ? "Aucun résultat" : "Aucune transmission"}
                    </p>
                    <p className="max-w-xl text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                      {hasTransmissionFilters
                        ? "Aucune transmission ne correspond aux filtres actifs."
                        : einvoicingOperational
                          ? "Les transmissions réalisées depuis le cœur facture apparaîtront ici avec leur statut le plus récent."
                          : "Aucun envoi connecté n’est activé. Les transmissions déjà enregistrées restent consultables ici."}
                    </p>
                    {hasTransmissionFilters ? (
                      <button
                        type="button"
                        onClick={() => {
                          setStatusFilter("all");
                          setSearch("");
                        }}
                        className="mt-1 inline-flex items-center justify-center rounded-xl px-4 py-2 text-white transition-all"
                        style={{
                          fontSize: "0.8125rem",
                          fontWeight: 600,
                          background: "#2563eb",
                          boxShadow: "0 1px 3px rgba(29,78,216,0.4), inset 0 1px 0 rgba(255,255,255,0.15)",
                        }}
                      >
                        Réinitialiser les filtres
                      </button>
                    ) : (
                      <Link
                        to="/app/invoices"
                        className="mt-1 inline-flex items-center justify-center rounded-xl px-4 py-2 text-white transition-all"
                        style={{
                          fontSize: "0.8125rem",
                          fontWeight: 600,
                          background: "#2563eb",
                          boxShadow: "0 1px 3px rgba(29,78,216,0.4), inset 0 1px 0 rgba(255,255,255,0.15)",
                        }}
                      >
                        Ouvrir les factures
                      </Link>
                    )}
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="pf-data-table w-full">
                    <thead>
                      <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                        {["Facture", "Date", "Canal", "Statut", "Mise à jour", "Motif / message", "Action"].map(
                          (header, index) => (
                            <th
                              key={`${header}-${index}`}
                              className="px-5 py-3.5 text-left"
                              style={{
                                fontSize: "0.625rem",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                letterSpacing: "0.08em",
                                color: "#94a3b8",
                                background: "#fafbfd",
                              }}
                            >
                              {header}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {pageItems.map((item) => (
                        <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                          <td className="px-5 py-4">
                            <Link
                              to={`/app/invoices/${item.invoice_id}`}
                              className="text-[#1d4ed8] hover:text-[#1e40af] text-sm font-semibold"
                            >
                              {item.invoice_number || item.invoice_id}
                            </Link>
                          </td>
                          <td className="px-5 py-4 text-[#64748b] text-xs">{formatDateFr(item.invoice_issue_date)}</td>
                          <td className="px-5 py-4 text-[#374151] text-sm">{prettyProvider(item.channel)}</td>
                          <td className="px-5 py-4">
                            <StatusPill {...transmissionPill(item.status)} />
                          </td>
                          <td className="px-5 py-4 text-[#64748b] text-xs">{formatDateTimeFr(item.updated_at)}</td>
                          <td className="px-5 py-4 text-[#64748b]" style={{ fontSize: "0.75rem", maxWidth: 300 }}>
                            {transmissionDisplayMessage(item)}
                          </td>
                          <td className="px-5 py-4">
                            <Link
                              to={`/app/invoices/${item.invoice_id}`}
                              className="text-[#1d4ed8] hover:text-[#1e40af] text-xs font-semibold"
                            >
                              Ouvrir
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <ListPagination
                page={page}
                totalItems={filtered.length}
                pageSize={pageSize}
                pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                itemLabel="transmission"
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPage(1);
                  setPageSize(nextPageSize);
                }}
                pageSizeAriaLabel="Transmissions par page"
                action={
                  statusFilter !== "all" || search ? (
                    <button
                      type="button"
                      onClick={() => {
                        setStatusFilter("all");
                        setSearch("");
                      }}
                      className="text-xs font-medium text-[#4338ca] transition-colors hover:text-[#3730a3]"
                    >
                      Réinitialiser
                    </button>
                  ) : (
                    <span className="text-xs text-[#94a3b8]">Vue transmissions unifiée</span>
                  )
                }
              />
            </SalesListBlock>
          </>
        )}
      </WorkbenchPage>
    </div>
  );
}

export function DirectoryPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<any>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lookupValue, setLookupValue] = useState("");
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [form, setForm] = useState({ siren: "", siret: "", platform_slug: "", billing_address: "" });
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const seqinoOperational = einvoicingEnabled && Boolean(capabilities?.seqino_operational);

  const resetForm = () => {
    setEditingId(null);
    setForm({ siren: "", siret: "", platform_slug: connectors[0]?.slug || "", billing_address: "" });
  };

  const load = useCallback(async () => {
    if (!einvoicingEnabled || !seqinoOperational) {
      setLoading(false);
      setError(null);
      setEntries([]);
      setConnectors([]);
      setStatusInfo(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [statusRes, entriesRes, connectorsRes] = await Promise.allSettled([
        readJson("/api/directory/status"),
        readJson("/api/platforms/endpoints"),
        readJson("/api/directory/connectors"),
      ]);

      const messages: string[] = [];
      if (statusRes.status === "fulfilled") setStatusInfo(statusRes.value || null);
      else messages.push(formatApiError(statusRes.reason, "Statut annuaire indisponible."));

      if (entriesRes.status === "fulfilled") setEntries(Array.isArray(entriesRes.value) ? entriesRes.value : []);
      else {
        setEntries([]);
        messages.push(formatApiError(entriesRes.reason, "Adresses destinataires indisponibles."));
      }

      if (connectorsRes.status === "fulfilled") {
        const next = Array.isArray(connectorsRes.value?.connectors) ? connectorsRes.value.connectors : [];
        setConnectors(next);
        setForm((prev) => ({ ...prev, platform_slug: prev.platform_slug || next[0]?.slug || "" }));
      } else {
        setConnectors([]);
      }

      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  }, [einvoicingEnabled, seqinoOperational]);

  useEffect(() => {
    if (sessionLoading) return;
    void load();
  }, [load, sessionLoading]);

  const saveEntry = async () => {
    if (!seqinoOperational) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        siren: form.siren.trim(),
        siret: form.siret.trim() || null,
        platform_slug: form.platform_slug.trim(),
        billing_address: form.billing_address.trim(),
      };
      if (editingId) {
        await api(`/api/platforms/endpoints/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
        setNotice("Adresse destinataire mise à jour.");
      } else {
        await api("/api/platforms/endpoints", { method: "POST", body: JSON.stringify(payload) });
        setNotice("Adresse destinataire ajoutée.");
      }
      resetForm();
      await load();
    } catch (err) {
      setError(formatApiError(err, "Enregistrement impossible."));
    } finally {
      setBusy(false);
    }
  };

  const deleteEntry = async (entry: any) => {
    if (!seqinoOperational) return;
    if (!window.confirm(`Supprimer l’entrée ${entry.siren}${entry.siret ? ` / ${entry.siret}` : ""} ?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/platforms/endpoints/${entry.id}`, { method: "DELETE" });
      setNotice("Entrée supprimée.");
      if (editingId === entry.id) resetForm();
      await load();
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setBusy(false);
    }
  };

  const queueRefresh = async () => {
    if (!seqinoOperational) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/directory/refresh", { method: "POST" });
      setNotice("Synchronisation Seqino lancée. Son avancement reste visible dans le statut de l’annuaire.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Synchronisation impossible."));
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (file: File | undefined) => {
    if (!file || !seqinoOperational) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const result: any = await apiFetch("/api/directory/import", { method: "POST", body });
      setNotice(
        `Import terminé : ${Number(result?.created || 0)} créée(s), ${Number(result?.updated || 0)} mise(s) à jour.`,
      );
      await load();
    } catch (err) {
      setError(formatApiError(err, "Import CSV impossible."));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    if (!seqinoOperational) return;
    const digits = lookupValue.replace(/\D+/g, "");
    if (!digits) return;
    setLookupError(null);
    setLookupResult(null);
    try {
      const query = digits.length >= 14 ? `siret=${digits}` : `siren=${digits.slice(0, 9)}`;
      const result = await readJson(`/api/directory/lookup?${query}`);
      setLookupResult(result || null);
    } catch (err) {
      setLookupError(formatApiError(err, "Aucune entrée trouvée."));
    }
  };

  return (
    <div>
      <AppPageHeader
        title="Synchronisation Seqino"
        breadcrumb="E-facturation"
        description="Synchronisation des destinataires via Seqino."
        actions={
          sessionLoading ? null : seqinoOperational ? (
            <div className="flex gap-2">
              <SecondaryButton onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
              </SecondaryButton>
              <PrimaryButton onClick={() => fileInputRef.current?.click()}>
                <Upload className="w-3.5 h-3.5" /> Import CSV
              </PrimaryButton>
            </div>
          ) : !einvoicingEnabled ? (
            <StatusPill status="warn" label={einvoicingGate.statusLabel} />
          ) : (
            <StatusPill status="info" label="Mode export" />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={
              einvoicingGate.reactivationRequired
                ? einvoicingGate.statusLabel
                : "Synchronisation Seqino disponible avec Pro"
            }
            description={
              einvoicingGate.reactivationDescription ||
              "En Starter, gérez vos clients, devis et factures classiques. L’annuaire et les échanges Seqino sont réservés au plan Pro, sous réserve d’un contrat, d’un mandat et d’une configuration opérationnelle."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={einvoicingGate.reactivationNote || undefined}
          />
        ) : !seqinoOperational ? (
          <NoticeBanner tone="info" title="Mode export actif">
            La connexion Seqino n’est pas activée sur cette instance : aucune synchronisation, recherche, import ou
            modification d’adresse connectée n’est proposée. Vous pouvez continuer à préparer vos documents et ouvrir
            les{" "}
            <Link to="/app/settings/export" className="underline font-medium">
              exports
            </Link>{" "}
            ou consulter l’
            <Link to="/app/einvoicing" className="underline font-medium">
              historique des transmissions
            </Link>
            .
          </NoticeBanner>
        ) : (
          <>
            {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
            {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                void importCsv(event.target.files?.[0]);
                event.target.value = "";
              }}
            />

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Synchro Seqino"
                value={statusInfo?.ppf_configured ? "Oui" : "Non"}
                sub="Connexion Seqino"
                accent={statusInfo?.ppf_configured ? "green" : "amber"}
                icon={<Globe className="w-4 h-4" />}
              />
              <StatCard
                label="Couverture clients"
                value={`${Number(statusInfo?.coverage?.coverage_rate || 0)}%`}
                sub={`${Number(statusInfo?.coverage?.with_endpoint || 0)} / ${Number(statusInfo?.coverage?.total_customers || 0)} clients`}
                accent="blue"
                icon={<Building2 className="w-4 h-4" />}
              />
              <StatCard
                label="Entrées Seqino"
                value={Number(statusInfo?.ppf_entries || 0)}
                sub="Mises en cache"
                accent="purple"
                icon={<FileText className="w-4 h-4" />}
              />
              <StatCard
                label="Dernière synchro"
                value={formatDateTimeFr(statusInfo?.last_ppf_sync_at)}
                sub="Historique Seqino"
                accent={statusInfo?.last_ppf_sync_at ? "green" : "cyan"}
                icon={<RefreshCw className="w-4 h-4" />}
              />
            </div>

            {loading ? (
              <LoadingCard label="Chargement de la synchronisation Seqino…" />
            ) : (
              <div className="grid xl:grid-cols-[1.2fr_1fr] gap-6 items-start">
                <div className="space-y-6">
                  <Card>
                    <SectionTitle
                      action={
                        <SecondaryButton disabled={busy} onClick={() => void queueRefresh()}>
                          <RefreshCw className="w-3.5 h-3.5" /> Relancer la synchro
                        </SecondaryButton>
                      }
                    >
                      Adresses destinataires
                    </SectionTitle>
                    {entries.length === 0 ? (
                      <SectionEmpty
                        title="Aucune adresse manuelle"
                        description="Ajoutez ici les destinataires prioritaires pour fiabiliser les premiers échanges avant d’automatiser le reste."
                      />
                    ) : (
                      <DataTable
                        headers={[
                          "SIREN / SIRET",
                          "Plateforme",
                          "Adresse de facturation",
                          "Source",
                          "Mis à jour",
                          "Action",
                        ]}
                      >
                        {entries.map((entry) => (
                          <tr key={entry.id} className="hover:bg-[#f8fafc] transition-colors">
                            <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                              {entry.siren}
                              {entry.siret ? (
                                <span className="text-[#94a3b8] font-normal"> / {entry.siret}</span>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-[#374151] text-sm">{prettyProvider(entry.platform_slug)}</td>
                            <td className="px-4 py-3 text-[#64748b]" style={{ fontSize: "0.75rem", maxWidth: 260 }}>
                              {entry.billing_address}
                            </td>
                            <td className="px-4 py-3">
                              <StatusPill
                                status={
                                  entry.source === "ppf" ? "info" : entry.source === "manual" ? "purple" : "muted"
                                }
                                label={titleCase(entry.source || "manuel")}
                              />
                            </td>
                            <td className="px-4 py-3 text-[#64748b] text-xs">
                              {formatDateTimeFr(entry.updated_at || entry.last_synced_at)}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex gap-2">
                                <SecondaryButton
                                  className="!px-3 !py-1.5"
                                  onClick={() => {
                                    setEditingId(entry.id);
                                    setForm({
                                      siren: entry.siren || "",
                                      siret: entry.siret || "",
                                      platform_slug: entry.platform_slug || connectors[0]?.slug || "",
                                      billing_address: entry.billing_address || "",
                                    });
                                  }}
                                >
                                  Modifier
                                </SecondaryButton>
                                <DangerButton className="!px-3 !py-1.5" onClick={() => void deleteEntry(entry)}>
                                  Supprimer
                                </DangerButton>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </DataTable>
                    )}
                  </Card>

                  <Card>
                    <SectionTitle>Dernières synchronisations</SectionTitle>
                    {(statusInfo?.recent_syncs || []).length === 0 ? (
                      <p className="text-[#94a3b8] text-sm">Aucune synchronisation enregistrée.</p>
                    ) : (
                      <div className="space-y-3">
                        {(statusInfo?.recent_syncs || []).map((run: any) => (
                          <div
                            key={run.id}
                            className="flex items-start justify-between gap-3 p-4 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]"
                          >
                            <div>
                              <div className="text-[#0f172a] text-sm font-semibold">
                                {titleCase(run.source || "annuaire")}
                              </div>
                              <p className="text-[#64748b] mt-1 text-xs">
                                {run.total_found || 0} trouvée(s), {run.total_created || 0} créée(s),{" "}
                                {run.total_updated || 0} mise(s) à jour.
                              </p>
                            </div>
                            <div className="text-right">
                              <StatusPill
                                status={(run.status || "").toLowerCase() === "failed" ? "danger" : "ok"}
                                label={(run.status || "").toLowerCase() === "failed" ? "Erreur" : "OK"}
                              />
                              <div className="text-[#94a3b8] mt-1 text-xs">
                                {formatDateTimeFr(run.finished_at || run.started_at)}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>

                <div className="space-y-6">
                  <Card>
                    <SectionTitle>
                      {editingId ? "Modifier une adresse destinataire" : "Ajouter une adresse destinataire"}
                    </SectionTitle>
                    <div className="space-y-4">
                      <InputField
                        label="SIREN"
                        value={form.siren}
                        onChange={(event) => setForm((prev) => ({ ...prev, siren: event.target.value }))}
                        placeholder="123456789"
                      />
                      <InputField
                        label="SIRET (optionnel)"
                        value={form.siret}
                        onChange={(event) => setForm((prev) => ({ ...prev, siret: event.target.value }))}
                        placeholder="12345678900010"
                      />
                      <SelectField
                        label="Plateforme"
                        value={form.platform_slug}
                        onChange={(event) => setForm((prev) => ({ ...prev, platform_slug: event.target.value }))}
                      >
                        {(connectors.length ? connectors : [{ slug: "manual", label: "Manuel" }]).map((item) => (
                          <option key={item.slug} value={item.slug}>
                            {item.label || prettyProvider(item.slug)}
                          </option>
                        ))}
                      </SelectField>
                      <div>
                        <label className="block text-[#374151] mb-1.5 text-sm font-medium">
                          Adresse de facturation
                        </label>
                        <textarea
                          value={form.billing_address}
                          onChange={(event) => setForm((prev) => ({ ...prev, billing_address: event.target.value }))}
                          rows={4}
                          placeholder="Adresse déclarative de facturation"
                          className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-sm"
                        />
                      </div>
                      <div className="flex gap-2">
                        <PrimaryButton disabled={busy} onClick={() => void saveEntry()}>
                          {editingId ? "Enregistrer" : "Ajouter"}
                        </PrimaryButton>
                        {editingId ? <SecondaryButton onClick={resetForm}>Annuler</SecondaryButton> : null}
                      </div>
                    </div>
                  </Card>

                  <Card>
                    <SectionTitle
                      action={
                        <SecondaryButton onClick={() => void lookup()}>
                          <Search className="w-3.5 h-3.5" /> Rechercher
                        </SecondaryButton>
                      }
                    >
                      Lookup rapide
                    </SectionTitle>
                    <div className="space-y-3">
                      <InputField
                        label="SIREN ou SIRET"
                        value={lookupValue}
                        onChange={(event) => setLookupValue(event.target.value)}
                        placeholder="123456789 ou 12345678900010"
                      />
                      {lookupError ? <p className="text-[#dc2626] text-xs">{lookupError}</p> : null}
                      {lookupResult ? (
                        <div className="p-3 rounded-xl bg-[#f8fafc] border border-[#e2e8f0] space-y-1.5 text-sm">
                          <div className="text-[#0f172a]" style={{ fontWeight: 600 }}>
                            {lookupResult.siren}
                            {lookupResult.siret ? ` / ${lookupResult.siret}` : ""}
                          </div>
                          <div className="text-[#64748b]">{prettyProvider(lookupResult.platform_slug)}</div>
                          <div className="text-[#64748b]">{lookupResult.billing_address}</div>
                        </div>
                      ) : null}
                    </div>
                  </Card>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function readInboxFiltersFromLocation() {
  if (typeof window === "undefined") {
    return {
      receivedFrom: "",
      receivedTo: "",
      issueFrom: "",
      issueTo: "",
      search: "",
      status: "all",
      boardFilter: "all",
      purchaseKind: "all" as PurchaseKindFilter,
      vatCorrections: false,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const filterIntent =
    `${params.get("filter") || ""} ${params.get("focus") || ""} ${params.get("tva") || ""}`.toLowerCase();
  const normalizedFilter = filterIntent.replace(/[\s-]+/g, "_");
  const boardFilter =
    normalizedFilter.includes("ready_to_pay") || normalizedFilter.includes("a_payer")
      ? "ready_to_pay"
      : normalizedFilter.includes("to_complete") || normalizedFilter.includes("a_completer")
        ? "to_complete"
        : normalizedFilter.includes("paid") || normalizedFilter.includes("payes")
          ? "paid"
          : normalizedFilter.includes("received") || normalizedFilter.includes("recues")
            ? "received"
            : normalizedFilter.includes("vat_correction") ||
                normalizedFilter.includes("corrections_tva") ||
                normalizedFilter.includes("tva")
              ? "vat_corrections"
              : "all";
  const purchaseKind: PurchaseKindFilter =
    normalizedFilter.includes("expense_report") || normalizedFilter.includes("note_de_frais")
      ? "expense_report"
      : normalizedFilter.includes("mileage") ||
          normalizedFilter.includes("frais_km") ||
          normalizedFilter.includes("kilometrique")
        ? "mileage"
        : normalizedFilter.includes("invoice") || normalizedFilter.includes("facture")
          ? "invoice"
          : "all";
  return {
    receivedFrom: params.get("received_from") || "",
    receivedTo: params.get("received_to") || "",
    issueFrom: params.get("issue_from") || "",
    issueTo: params.get("issue_to") || "",
    search: params.get("q") || params.get("search") || "",
    status: params.get("status") || "all",
    boardFilter,
    purchaseKind,
    vatCorrections:
      params.get("vat_correction") === "1" ||
      filterIntent.includes("vat_correction") ||
      filterIntent.includes("vat_corrections") ||
      filterIntent.includes("corrections_tva") ||
      filterIntent.includes("tva"),
  };
}

const INBOX_LIST_PAGE_SIZE = 100;
const SERVER_PURCHASE_BOARD_FILTERS = new Set([
  "all",
  "received",
  "vat_corrections",
  "to_complete",
  "ready_to_pay",
  "paid",
]);

function inboxQueryForPage(queryString: string, page: number, pageSize = INBOX_LIST_PAGE_SIZE) {
  const params = new URLSearchParams(queryString);
  params.set("page", String(page));
  params.set("page_size", String(pageSize));
  return params.toString();
}

async function readInboxPage(queryString: string, page: number, pageSize = INBOX_LIST_PAGE_SIZE) {
  const payload: any = await readJson(`/api/inbox?${inboxQueryForPage(queryString, page, pageSize)}`);
  const basePayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const payloadItems = Array.isArray(payload) ? payload : Array.isArray(basePayload.items) ? basePayload.items : [];
  return {
    ...basePayload,
    items: payloadItems,
    page: Number(basePayload.page || page),
    page_size: Number(basePayload.page_size || pageSize),
    total: Number(basePayload.total || basePayload.count || payloadItems.length || 0),
    pages: Math.max(1, Number(basePayload.pages || Math.ceil(payloadItems.length / pageSize) || 1)),
  };
}

function InboxListView() {
  const location = useLocation();
  const navigate = useNavigate();
  const { capabilities, loading: sessionLoading } = useSession();
  const importRef = useRef<HTMLInputElement | null>(null);
  const isPurchasesView = location.pathname.startsWith("/app/purchases");
  const inboxGate = resolveProFeatureGate(capabilities, isPurchasesView ? "purchases" : "einvoicing");
  const purchasesEnabled = inboxGate.enabled;
  const basePath = isPurchasesView ? "/app/purchases" : "/app/inbox";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [recentImportedItem, setRecentImportedItem] = useState<any | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [listMeta, setListMeta] = useState({ page: 1, page_size: INBOX_LIST_PAGE_SIZE, total: 0, pages: 1 });
  const [connection, setConnection] = useState<any>(null);
  const [purchaseWorkflow, setPurchaseWorkflow] = useState<any>(null);
  const [search, setSearch] = useState(() => readInboxFiltersFromLocation().search);
  const [statusFilter, setStatusFilter] = useState(() => readInboxFiltersFromLocation().status);
  const [validationFilter, setValidationFilter] = useState("all");
  const [issueFrom, setIssueFrom] = useState(() => readInboxFiltersFromLocation().issueFrom);
  const [issueTo, setIssueTo] = useState(() => readInboxFiltersFromLocation().issueTo);
  const [receivedFrom, setReceivedFrom] = useState(() => readInboxFiltersFromLocation().receivedFrom);
  const [receivedTo, setReceivedTo] = useState(() => readInboxFiltersFromLocation().receivedTo);
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [showFilters, setShowFilters] = useState(() => {
    const initial = readInboxFiltersFromLocation();
    return Boolean(
      initial.search ||
      initial.status !== "all" ||
      initial.issueFrom ||
      initial.issueTo ||
      initial.receivedFrom ||
      initial.receivedTo,
    );
  });
  const [boardFilter, setBoardFilter] = useState(() =>
    readInboxFiltersFromLocation().vatCorrections ? "vat_corrections" : readInboxFiltersFromLocation().boardFilter,
  );
  const [purchaseKindFilter, setPurchaseKindFilter] = useState<PurchaseKindFilter>(
    () => readInboxFiltersFromLocation().purchaseKind,
  );
  const [busyImport, setBusyImport] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rowWorkflowBusy, setRowWorkflowBusy] = useState<string | null>(null);
  const [bulkWorkflowBusy, setBulkWorkflowBusy] = useState<string | null>(null);
  const [purchaseExportBusy, setPurchaseExportBusy] = useState(false);
  const [purchaseExportToolsOpen, setPurchaseExportToolsOpen] = useState(false);
  const [manualPurchaseKind, setManualPurchaseKind] = useState<ManualPurchaseKind | null>(null);
  const [manualPurchaseDraft, setManualPurchaseDraft] = useState<any>(() =>
    createManualPurchaseDraft("expense_report"),
  );
  const [manualPurchaseBusy, setManualPurchaseBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [purchasePage, setPurchasePage] = useState(1);
  const [purchasePageSize, setPurchasePageSize] = useState(() => readStoredPurchasePageSize());
  const [purchaseSortState, setPurchaseSortState] = useState<PurchaseSortState>({
    key: "supplier",
    direction: "asc",
  });
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState<Set<string>>(() => new Set());
  const [bulkVatCorrectionRate, setBulkVatCorrectionRate] = useState("20");
  const [bulkVatApplyToLines, setBulkVatApplyToLines] = useState(false);
  const [purchaseReferencesOpen, setPurchaseReferencesOpen] = useState(false);
  const [purchaseReferencesTab, setPurchaseReferencesTab] = useState<"suppliers" | "people">("suppliers");
  const [purchaseReferencesSearch, setPurchaseReferencesSearch] = useState("");
  const [purchaseReferencesLoading, setPurchaseReferencesLoading] = useState(false);
  const [purchaseReferencesError, setPurchaseReferencesError] = useState<string | null>(null);
  const [purchaseSupplierReferences, setPurchaseSupplierReferences] = useState<any[]>([]);
  const [purchaseSupplierDuplicateGroups, setPurchaseSupplierDuplicateGroups] = useState<any[]>([]);
  const [purchaseEmployeeReferences, setPurchaseEmployeeReferences] = useState<any[]>([]);
  const [purchaseReferenceDeleting, setPurchaseReferenceDeleting] = useState<string | null>(null);
  const [purchaseSupplierConsolidating, setPurchaseSupplierConsolidating] = useState<string | null>(null);
  const [purchaseReferenceSaving, setPurchaseReferenceSaving] = useState<string | null>(null);
  const [purchaseReferenceEditing, setPurchaseReferenceEditing] = useState<{
    kind: "supplier" | "person";
    id: string;
  } | null>(null);
  const [purchaseReferenceEditDraft, setPurchaseReferenceEditDraft] = useState<Record<string, any>>({});

  const statusOptions = [
    { value: "all", label: "Tous les statuts" },
    { value: "received", label: "Reçues" },
    { value: "acknowledged", label: "Acquittées" },
    { value: "accepted", label: "Acceptées" },
    { value: "rejected", label: "Rejetées" },
    { value: "correction_requested", label: "Correction demandée" },
    { value: "imported", label: "Importées" },
  ];
  const validationOptions = [
    { value: "all", label: "Toutes validations" },
    { value: "valid", label: "Valides" },
    { value: "invalid", label: "Invalides" },
    { value: "warning", label: "Avec avertissement" },
    { value: "unavailable", label: "Contrôle indisponible" },
    { value: "skipped", label: "Non vérifiées" },
  ];

  const buildQueryString = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (statusFilter !== "all") params.set("status", statusFilter);
    else if (isPurchasesView && boardFilter === "received") params.set("status", "received");
    if (validationFilter !== "all") params.set("validation_status", validationFilter);
    if (isPurchasesView && boardFilter === "vat_corrections") params.set("vat_correction", "1");
    if (isPurchasesView && ["to_complete", "ready_to_pay", "paid"].includes(boardFilter)) {
      params.set("purchase_board", boardFilter);
    }
    if (isPurchasesView && purchaseKindFilter !== "all") params.set("purchase_kind", purchaseKindFilter);
    if (isPurchasesView && amountMin.trim()) params.set("amount_min", amountMin.trim().replace(",", "."));
    if (isPurchasesView && amountMax.trim()) params.set("amount_max", amountMax.trim().replace(",", "."));
    if (issueFrom) params.set("issue_from", issueFrom);
    if (issueTo) params.set("issue_to", issueTo);
    if (receivedFrom) params.set("received_from", receivedFrom);
    if (receivedTo) params.set("received_to", receivedTo);
    return params.toString();
  }, [
    amountMax,
    amountMin,
    boardFilter,
    isPurchasesView,
    issueFrom,
    issueTo,
    purchaseKindFilter,
    receivedFrom,
    receivedTo,
    search,
    statusFilter,
    validationFilter,
  ]);

  const load = useCallback(async () => {
    if (sessionLoading || !purchasesEnabled) return;
    setLoading(true);
    setError(null);
    try {
      const queryString = buildQueryString();
      const listPage = isPurchasesView ? purchasePage : 1;
      const listPageSize = isPurchasesView ? purchasePageSize : INBOX_LIST_PAGE_SIZE;
      const [listRes, summaryRes, connectionRes, workflowRes] = await Promise.allSettled([
        readInboxPage(queryString, listPage, listPageSize),
        readJson(`/api/inbox/summary?${queryString}`),
        readJson("/api/inbox/connection"),
        isPurchasesView ? readJson("/api/ops/purchase-workflow-summary") : Promise.resolve(null),
      ]);
      const messages: string[] = [];
      if (listRes.status === "fulfilled") {
        const rawLoadedItems = Array.isArray(listRes.value?.items) ? listRes.value.items : [];
        const endpointReturnedUnpagedList = isPurchasesView && rawLoadedItems.length > listPageSize;
        const loadedItems = endpointReturnedUnpagedList
          ? rawLoadedItems.slice((listPage - 1) * listPageSize, listPage * listPageSize)
          : rawLoadedItems;
        const shouldPinRecentImport =
          Boolean(recentImportedItem?.id) &&
          isPurchasesView &&
          listPage === 1 &&
          boardFilter === "all" &&
          purchaseKindFilter === "all" &&
          statusFilter === "all" &&
          validationFilter === "all" &&
          !search.trim() &&
          !issueFrom &&
          !issueTo &&
          !receivedFrom &&
          !receivedTo &&
          !amountMin &&
          !amountMax;
        const nextItems =
          shouldPinRecentImport &&
          !loadedItems.some((entry: any) => String(entry?.id) === String(recentImportedItem.id))
            ? [recentImportedItem, ...loadedItems].slice(0, listPageSize)
            : loadedItems;
        setItems(nextItems);
        const total = Math.max(
          Number(listRes.value?.total || 0),
          endpointReturnedUnpagedList ? rawLoadedItems.length : nextItems.length,
        );
        setListMeta({
          page: Number(listRes.value?.page || listPage),
          page_size: Number(listRes.value?.page_size || listPageSize),
          total,
          pages: Math.max(1, Number(listRes.value?.pages || Math.ceil(total / listPageSize) || 1)),
        });
      } else {
        setItems([]);
        setListMeta({ page: listPage, page_size: listPageSize, total: 0, pages: 1 });
        messages.push(formatApiError(listRes.reason, "Inbox indisponible."));
      }
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value || null);
      else setSummary(null);
      if (connectionRes.status === "fulfilled") setConnection(connectionRes.value || null);
      else setConnection(null);
      if (workflowRes.status === "fulfilled") setPurchaseWorkflow(workflowRes.value || null);
      else setPurchaseWorkflow(null);
      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  }, [
    amountMax,
    amountMin,
    boardFilter,
    buildQueryString,
    isPurchasesView,
    issueFrom,
    issueTo,
    purchaseKindFilter,
    purchasePage,
    purchasePageSize,
    receivedFrom,
    receivedTo,
    recentImportedItem,
    search,
    statusFilter,
    validationFilter,
    purchasesEnabled,
    sessionLoading,
  ]);

  const loadPurchaseReferences = useCallback(async () => {
    if (!isPurchasesView || !purchaseReferencesOpen) return;
    setPurchaseReferencesLoading(true);
    setPurchaseReferencesError(null);
    const query = encodeURIComponent(purchaseReferencesSearch.trim());
    try {
      const [suppliersRes, peopleRes, duplicatesRes] = await Promise.allSettled([
        readJson(`/api/inbox/suppliers?q=${query}&limit=50&include_history=false`),
        readJson(`/api/inbox/employee-payers?q=${query}&limit=50&include_history=false`),
        readJson("/api/inbox/suppliers/duplicates"),
      ]);
      if (suppliersRes.status === "fulfilled") {
        setPurchaseSupplierReferences(Array.isArray(suppliersRes.value?.items) ? suppliersRes.value.items : []);
      } else {
        setPurchaseSupplierReferences([]);
      }
      if (peopleRes.status === "fulfilled") {
        setPurchaseEmployeeReferences(Array.isArray(peopleRes.value?.items) ? peopleRes.value.items : []);
      } else {
        setPurchaseEmployeeReferences([]);
      }
      if (duplicatesRes.status === "fulfilled") {
        setPurchaseSupplierDuplicateGroups(Array.isArray(duplicatesRes.value?.items) ? duplicatesRes.value.items : []);
      } else {
        setPurchaseSupplierDuplicateGroups([]);
      }
      const firstError =
        suppliersRes.status === "rejected"
          ? suppliersRes.reason
          : peopleRes.status === "rejected"
            ? peopleRes.reason
            : null;
      if (firstError) setPurchaseReferencesError(formatApiError(firstError, "Fiches fournisseurs indisponibles."));
    } finally {
      setPurchaseReferencesLoading(false);
    }
  }, [isPurchasesView, purchaseReferencesOpen, purchaseReferencesSearch]);

  useEffect(() => {
    if (sessionLoading || !purchasesEnabled) return;
    const timer = window.setTimeout(
      () => {
        void load();
      },
      search.trim() ? 180 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [load, purchasesEnabled, reloadKey, search, sessionLoading]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        void loadPurchaseReferences();
      },
      purchaseReferencesSearch.trim() ? 180 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [loadPurchaseReferences, purchaseReferencesSearch]);

  useEffect(() => {
    setPurchaseReferenceEditing(null);
    setPurchaseReferenceEditDraft({});
  }, [purchaseReferencesOpen, purchaseReferencesTab]);

  useEffect(() => {
    if (!purchaseReferencesOpen && !manualPurchaseKind) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (manualPurchaseKind) setManualPurchaseKind(null);
      if (purchaseReferencesOpen) setPurchaseReferencesOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [manualPurchaseKind, purchaseReferencesOpen]);

  useEffect(() => {
    if (statusFilter !== "all" || validationFilter !== "all") {
      setShowFilters(true);
    }
  }, [statusFilter, validationFilter]);

  useEffect(() => {
    setPurchasePage(1);
  }, [
    amountMax,
    amountMin,
    boardFilter,
    issueFrom,
    issueTo,
    purchaseKindFilter,
    receivedFrom,
    receivedTo,
    search,
    statusFilter,
    validationFilter,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PURCHASE_PAGE_SIZE_STORAGE_KEY, String(purchasePageSize));
  }, [purchasePageSize]);

  useEffect(() => {
    const itemIds = new Set(items.map((item) => String(item.id)));
    setSelectedPurchaseIds((current) => {
      const next = new Set(Array.from(current).filter((id) => itemIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setBusyImport(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const imported: any = await apiFetch("/api/inbox/import", { method: "POST", body });
      setRecentImportedItem(imported && imported.id ? imported : null);
      const validationStatus = String(imported?.validation_status || "").toLowerCase();
      const validationMessages = [
        ...(Array.isArray(imported?.validation_errors) ? imported.validation_errors : []),
        ...(Array.isArray(imported?.validation_warnings) ? imported.validation_warnings : []),
      ]
        .filter(Boolean)
        .slice(0, 2)
        .join(" ");
      setSearch("");
      setStatusFilter("all");
      setValidationFilter("all");
      setIssueFrom("");
      setIssueTo("");
      setReceivedFrom("");
      setReceivedTo("");
      setAmountMin("");
      setAmountMax("");
      setBoardFilter("all");
      setPurchaseKindFilter("all");
      setPurchasePage(1);
      setSelectedPurchaseIds(new Set());
      if (validationStatus === "invalid") {
        setError(
          `Fichier importé mais non conforme : ${validationMessages || "ouvrez le document pour voir les contrôles."} Il reste affiché dans Tous.`,
        );
      } else if (validationStatus === "warning" || validationStatus === "unavailable") {
        setNotice(
          `Document importé dans Tous avec contrôle à vérifier${validationMessages ? ` : ${validationMessages}` : "."}`,
        );
      } else {
        setNotice("Facture fournisseur importée et affichée dans Tous.");
      }
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(formatApiError(err, "Import refusé : le fichier n'est pas une facture conforme."));
    } finally {
      setBusyImport(false);
    }
  };

  const deleteImportedItem = async (item: any) => {
    if (!canDeleteInboundInvoice(item)) return;
    const label = item?.invoice_number || item?.supplier_name || item?.id || "ce document";
    if (!window.confirm(`Supprimer ${label} ?`)) return;
    setDeletingId(String(item.id));
    setError(null);
    setNotice(null);
    try {
      await api(`/api/inbox/${item.id}`, { method: "DELETE" });
      setNotice("Document importé supprimé.");
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
    } finally {
      setDeletingId(null);
    }
  };

  const deletePurchaseReference = async (kind: "supplier" | "person", entry: any) => {
    const id = String(entry?.id || "");
    if (!id) return;
    const label = kind === "supplier" ? purchaseSupplierName(entry) : employeePayerName(entry);
    if (!window.confirm(`Supprimer la fiche "${label || "sans nom"}" ?`)) return;
    setPurchaseReferenceDeleting(id);
    setPurchaseReferencesError(null);
    setNotice(null);
    try {
      await api(`/api/inbox/${kind === "supplier" ? "suppliers" : "employee-payers"}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (kind === "supplier") {
        setPurchaseSupplierReferences((current) => current.filter((row) => String(row?.id || "") !== id));
      } else {
        setPurchaseEmployeeReferences((current) => current.filter((row) => String(row?.id || "") !== id));
      }
      setNotice(
        kind === "supplier"
          ? "Fournisseur supprimé des fiches mémorisées."
          : "Personne supprimée des fiches mémorisées.",
      );
      await loadPurchaseReferences();
    } catch (err) {
      setPurchaseReferencesError(formatApiError(err, "Suppression impossible."));
    } finally {
      setPurchaseReferenceDeleting(null);
    }
  };

  const consolidatePurchaseSupplierDuplicate = async (group: any) => {
    const keepId = String(group?.keep || "").trim();
    const removeIds = (Array.isArray(group?.remove) ? group.remove : [])
      .map((value: any) => String(value || "").trim())
      .filter(Boolean)
      .filter((value: string) => value !== keepId);
    if (!keepId || removeIds.length === 0) return;
    const items = Array.isArray(group?.items) ? group.items : [];
    const keep = items.find((item: any) => String(item?.id) === keepId);
    const keepLabel = purchaseSupplierName(keep) || "la fiche conservée";
    const removeCount = removeIds.length;
    if (
      !window.confirm(
        `Consolider ${removeCount} fiche${removeCount > 1 ? "s" : ""} doublon vers "${keepLabel}" ? Les achats existants ne seront pas modifiés.`,
      )
    ) {
      return;
    }
    setPurchaseSupplierConsolidating(keepId);
    setPurchaseReferencesError(null);
    setNotice(null);
    try {
      await api("/api/inbox/suppliers/duplicates/consolidate", {
        method: "POST",
        body: JSON.stringify({ keep_id: keepId, remove_ids: removeIds }),
      });
      setNotice(`Doublon fournisseur consolidé vers "${keepLabel}".`);
      await loadPurchaseReferences();
    } catch (err) {
      setPurchaseReferencesError(formatApiError(err, "Consolidation impossible."));
    } finally {
      setPurchaseSupplierConsolidating(null);
    }
  };

  const startPurchaseReferenceEdit = (kind: "supplier" | "person", entry: any) => {
    const id = String(entry?.id || "");
    if (!id) return;
    setPurchaseReferencesError(null);
    setPurchaseReferenceEditing({ kind, id });
    setPurchaseReferenceEditDraft(
      kind === "supplier"
        ? {
            name: purchaseSupplierName(entry),
            supplier_siren: entry?.supplier_siren || "",
            supplier_siret: entry?.supplier_siret || "",
            vat_number: entry?.vat_number || "",
            accounting_account: entry?.default_accounting_account || "",
            payment_delay_days: entry?.default_payment_delay_days ?? "",
            purchase_nature: entry?.default_purchase_nature || "",
            vat_rate: purchaseInputAmount(entry?.default_vat_rate),
            vat_rules: purchaseSupplierVatRules(entry),
            notes: entry?.notes || "",
          }
        : {
            name: employeePayerName(entry),
            role: entry?.role || "manager",
            user_label: entry?.user_label || "",
            accounting_account: entry?.default_accounting_account || "",
            reimbursement_method: entry?.reimbursement_method || "bank_transfer",
            vehicle_type: entry?.vehicle_type || "",
            fiscal_power: entry?.fiscal_power || "",
            notes: entry?.notes || "",
          },
    );
  };

  const updatePurchaseReferenceEdit = (key: string, value: any) => {
    setPurchaseReferenceEditDraft((current) => ({ ...current, [key]: value }));
  };

  const updatePurchaseSupplierVatRule = (index: number, patch: Record<string, any>) => {
    setPurchaseReferenceEditDraft((current) => {
      const rules = Array.isArray(current?.vat_rules) ? current.vat_rules : [];
      const nextRules = rules.map((rule: any, ruleIndex: number) =>
        ruleIndex === index ? { ...rule, ...patch } : rule,
      );
      return { ...current, vat_rules: nextRules };
    });
  };

  const addPurchaseSupplierVatRule = () => {
    setPurchaseReferenceEditDraft((current) => ({
      ...current,
      vat_rules: [
        ...(Array.isArray(current?.vat_rules) ? current.vat_rules : []),
        { accounting_account: "", purchase_nature: "", vat_rate: "" },
      ],
    }));
  };

  const removePurchaseSupplierVatRule = (index: number) => {
    setPurchaseReferenceEditDraft((current) => ({
      ...current,
      vat_rules: (Array.isArray(current?.vat_rules) ? current.vat_rules : []).filter(
        (_: any, ruleIndex: number) => ruleIndex !== index,
      ),
    }));
  };

  const savePurchaseReferenceEdit = async () => {
    if (!purchaseReferenceEditing) return;
    const id = purchaseReferenceEditing.id;
    const name = String(purchaseReferenceEditDraft.name || "").trim();
    if (!name) {
      setPurchaseReferencesError(
        purchaseReferenceEditing.kind === "supplier"
          ? "Le nom du fournisseur est obligatoire."
          : "Le nom de la personne est obligatoire.",
      );
      return;
    }
    const delayRaw = purchaseReferenceEditDraft.payment_delay_days;
    const delay =
      delayRaw === "" || delayRaw == null || Number.isNaN(Number(delayRaw))
        ? null
        : Math.max(0, Math.min(Number(delayRaw), 365));
    const body =
      purchaseReferenceEditing.kind === "supplier"
        ? {
            name,
            supplier_siren: purchaseReferenceEditDraft.supplier_siren || null,
            supplier_siret: purchaseReferenceEditDraft.supplier_siret || null,
            vat_number: purchaseReferenceEditDraft.vat_number || null,
            accounting_account: purchaseReferenceEditDraft.accounting_account || null,
            payment_delay_days: delay,
            purchase_nature: purchaseReferenceEditDraft.purchase_nature || null,
            vat_rate: purchaseVatRateValue(purchaseReferenceEditDraft.vat_rate),
            vat_rules: purchaseSupplierVatRules(purchaseReferenceEditDraft).map((rule: any) => ({
              accounting_account: rule.accounting_account || null,
              purchase_nature: rule.purchase_nature || null,
              vat_rate: purchaseVatRateValue(rule.vat_rate),
            })),
            notes: purchaseReferenceEditDraft.notes || null,
          }
        : {
            name,
            role: purchaseReferenceEditDraft.role || "manager",
            user_label: purchaseReferenceEditDraft.user_label || null,
            accounting_account: purchaseReferenceEditDraft.accounting_account || null,
            reimbursement_method: purchaseReferenceEditDraft.reimbursement_method || null,
            vehicle_type: purchaseReferenceEditDraft.vehicle_type || null,
            fiscal_power: purchaseReferenceEditDraft.fiscal_power || null,
            notes: purchaseReferenceEditDraft.notes || null,
          };
    setPurchaseReferenceSaving(id);
    setPurchaseReferencesError(null);
    setNotice(null);
    try {
      await api(
        `/api/inbox/${purchaseReferenceEditing.kind === "supplier" ? "suppliers" : "employee-payers"}/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      );
      setNotice(
        purchaseReferenceEditing.kind === "supplier" ? "Fournisseur mis à jour." : "Personne à rembourser mise à jour.",
      );
      setPurchaseReferenceEditing(null);
      setPurchaseReferenceEditDraft({});
      await loadPurchaseReferences();
    } catch (err) {
      setPurchaseReferencesError(formatApiError(err, "Mise à jour impossible."));
    } finally {
      setPurchaseReferenceSaving(null);
    }
  };

  const totals = summary?.totals || {};
  const invalidCount = Number(summary?.validation_counts?.invalid || 0);
  const receivedCount = Number(summary?.status_counts?.received || 0);
  const workflowStatesMap = useMemo(() => {
    const map: Record<string, any> = { ...(purchaseWorkflow?.items_by_invoice || {}) };
    for (const item of items) {
      if (item?.id && item?.purchase_workflow) {
        map[String(item.id)] = item.purchase_workflow;
      }
    }
    return map;
  }, [items, purchaseWorkflow]);
  const reviewingCount = Number(purchaseWorkflow?.states?.reviewing || 0);
  const readyToPayCount = Number(purchaseWorkflow?.states?.ready_to_pay || 0);
  const exportPath = `/api/inbox/export?${buildQueryString()}`;
  const purchaseTheme = getModuleTheme("purchases");
  const purchaseKindOptions: Array<{ value: PurchaseKindFilter; label: string }> = [
    { value: "all", label: "Tous types" },
    { value: "invoice", label: "Factures" },
    { value: "expense_report", label: "Notes de frais" },
    { value: "mileage", label: "Frais km" },
  ];
  const purchaseKindFilteredItems = items.filter((item) => {
    if (purchaseKindFilter === "all") return true;
    return purchaseKindKey(item) === purchaseKindFilter;
  });
  const visibleReceivedCount = purchaseKindFilteredItems.filter(
    (item) => String(item.status || "").toLowerCase() === "received",
  ).length;
  const visibleReviewingCount = purchaseKindFilteredItems.filter(
    (item) => String(workflowStatesMap[item.id]?.state || "").toLowerCase() === "reviewing",
  ).length;
  const visibleReadyCount = purchaseKindFilteredItems.filter((item) => {
    const state = String(workflowStatesMap[item.id]?.state || "").toLowerCase();
    return state === "approved" || state === "ready_to_pay";
  }).length;
  const visiblePaidCount = purchaseKindFilteredItems.filter(
    (item) => String(workflowStatesMap[item.id]?.state || "").toLowerCase() === "booked",
  ).length;
  const visibleInvalidCount = purchaseKindFilteredItems.filter(
    (item) => String(item.validation_status || "").toLowerCase() === "invalid",
  ).length;
  const visibleCompletionCount = purchaseKindFilteredItems.filter(purchaseNeedsCompletion).length;
  const visibleVatCorrectionCount = purchaseKindFilteredItems.filter(purchaseNeedsVatCorrection).length;
  const purchaseBoardCounts = summary?.purchase_board_counts || {};
  const purchaseBoardAmounts = summary?.purchase_board_amounts || {};
  const purchaseTabs = [
    { value: "all", label: "Tous", count: Number(purchaseBoardCounts.all ?? purchaseKindFilteredItems.length) },
    {
      value: "vat_corrections",
      label: "Corrections TVA",
      count: Number(purchaseBoardCounts.vat_corrections ?? visibleVatCorrectionCount),
    },
    {
      value: "to_complete",
      label: "À compléter",
      count: Number(purchaseBoardCounts.to_complete ?? visibleCompletionCount),
    },
    { value: "ready_to_pay", label: "À payer", count: Number(purchaseBoardCounts.ready_to_pay ?? visibleReadyCount) },
    { value: "paid", label: "Payés", count: Number(purchaseBoardCounts.paid ?? visiblePaidCount) },
  ];
  const amountMinValue = amountMin.trim() ? Number(amountMin.replace(",", ".")) : null;
  const amountMaxValue = amountMax.trim() ? Number(amountMax.replace(",", ".")) : null;
  const visibleItems = purchaseKindFilteredItems
    .filter((item) => {
      if (!isPurchasesView || boardFilter === "all") return true;
      if (SERVER_PURCHASE_BOARD_FILTERS.has(boardFilter)) return true;
      if (boardFilter === "received") return String(item.status || "").toLowerCase() === "received";
      if (boardFilter === "vat_corrections") return purchaseNeedsVatCorrection(item);
      if (boardFilter === "to_complete") return purchaseNeedsCompletion(item);
      if (boardFilter === "invalid") return String(item.validation_status || "").toLowerCase() === "invalid";
      if (boardFilter === "paid") {
        return String(workflowStatesMap[item.id]?.state || "").toLowerCase() === "booked";
      }
      if (boardFilter === "ready_to_pay") {
        const state = String(workflowStatesMap[item.id]?.state || "").toLowerCase();
        return state === "approved" || state === "ready_to_pay";
      }
      if (boardFilter === "to_match") {
        const state = String(workflowStatesMap[item.id]?.state || "").toLowerCase();
        return state === "approved" || state === "ready_to_pay";
      }
      return String(workflowStatesMap[item.id]?.state || "").toLowerCase() === boardFilter;
    })
    .filter((item) => {
      if (!isPurchasesView) return true;
      const amount = numericAmount(item.total_ex_vat);
      if (amountMinValue !== null && Number.isFinite(amountMinValue) && amount < amountMinValue) return false;
      if (amountMaxValue !== null && Number.isFinite(amountMaxValue) && amount > amountMaxValue) return false;
      return true;
    });
  const hasClientSidePurchaseFilters = isPurchasesView && !SERVER_PURCHASE_BOARD_FILTERS.has(boardFilter);
  const serverPurchaseTotal = Math.max(Number(totals.count || listMeta.total || 0), visibleItems.length);
  const purchaseListTotalItems = hasClientSidePurchaseFilters ? visibleItems.length : serverPurchaseTotal;
  const purchaseTotalTtc = hasClientSidePurchaseFilters
    ? visibleItems.reduce((sum, item) => sum + numericAmount(item.total_ttc), 0)
    : Number(totals.total_ttc ?? visibleItems.reduce((sum, item) => sum + numericAmount(item.total_ttc), 0));
  const purchaseTotalHt = hasClientSidePurchaseFilters
    ? visibleItems.reduce((sum, item) => sum + numericAmount(item.total_ex_vat), 0)
    : Number(totals.total_ex_vat ?? visibleItems.reduce((sum, item) => sum + numericAmount(item.total_ex_vat), 0));
  const purchaseTotalVat = hasClientSidePurchaseFilters
    ? visibleItems.reduce((sum, item) => sum + numericAmount(item.total_vat), 0)
    : Number(totals.total_vat ?? visibleItems.reduce((sum, item) => sum + numericAmount(item.total_vat), 0));
  const visibleReadyToPayAmount = visibleItems.reduce((sum, item) => {
    const state = String(workflowStatesMap[item.id]?.state || "").toLowerCase();
    return state === "ready_to_pay" || state === "approved"
      ? sum + purchaseRemainingAmount(item, workflowStatesMap[item.id])
      : sum;
  }, 0);
  const visibleBookedAmount = visibleItems.reduce((sum, item) => {
    return String(workflowStatesMap[item.id]?.state || "").toLowerCase() === "booked"
      ? sum + numericAmount(item.total_ttc)
      : sum;
  }, 0);
  const readyToPayAmount = hasClientSidePurchaseFilters
    ? visibleReadyToPayAmount
    : Number(purchaseBoardAmounts.ready_to_pay ?? visibleReadyToPayAmount);
  const bookedAmount = hasClientSidePurchaseFilters
    ? visibleBookedAmount
    : Number(purchaseBoardAmounts.paid ?? visibleBookedAmount);
  const sortedPurchaseItems = useMemo(
    () => [...visibleItems].sort((left, right) => comparePurchases(left, right, purchaseSortState, workflowStatesMap)),
    [purchaseSortState, visibleItems, workflowStatesMap],
  );
  const purchasePageRows = sortedPurchaseItems;
  const purchasePageIds = purchasePageRows.map((item) => String(item.id));
  const selectedPurchaseCount = selectedPurchaseIds.size;
  const purchaseExportLabel = selectedPurchaseCount > 0 ? "Exporter la sélection" : "Exporter la vue filtrée";
  const purchaseExportTitle =
    selectedPurchaseCount > 0
      ? "Exporte uniquement les achats cochés dans la liste."
      : "Exporte uniquement les achats correspondant aux filtres affichés.";
  const purchaseExportCriteria = [
    search.trim() ? `Recherche : ${search.trim()}` : null,
    boardFilter !== "all"
      ? `Vue : ${purchaseTabs.find((tab) => tab.value === boardFilter)?.label || boardFilter}`
      : null,
    purchaseKindFilter !== "all"
      ? `Type : ${purchaseKindOptions.find((option) => option.value === purchaseKindFilter)?.label || purchaseKindFilter}`
      : null,
    statusFilter !== "all"
      ? `Statut : ${statusOptions.find((option) => option.value === statusFilter)?.label || statusFilter}`
      : null,
    validationFilter !== "all"
      ? `Contrôle : ${validationOptions.find((option) => option.value === validationFilter)?.label || validationFilter}`
      : null,
    issueFrom ? `Émise dès le ${formatDateFr(issueFrom)}` : null,
    issueTo ? `Émise jusqu'au ${formatDateFr(issueTo)}` : null,
    receivedFrom ? `Reçue dès le ${formatDateFr(receivedFrom)}` : null,
    receivedTo ? `Reçue jusqu'au ${formatDateFr(receivedTo)}` : null,
    amountMin.trim() ? `HT min. ${amountMin.trim()} €` : null,
    amountMax.trim() ? `HT max. ${amountMax.trim()} €` : null,
  ].filter(Boolean) as string[];
  const allPurchasePageSelected =
    purchasePageIds.length > 0 && purchasePageIds.every((id) => selectedPurchaseIds.has(id));
  const togglePurchaseSort = (key: PurchaseSortKey) => {
    setPurchaseSortState((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  };
  const togglePurchaseSelection = (id: string) => {
    setSelectedPurchaseIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const togglePurchasePageSelection = () => {
    setSelectedPurchaseIds((current) => {
      const next = new Set(current);
      if (allPurchasePageSelected) purchasePageIds.forEach((id) => next.delete(id));
      else purchasePageIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const clearPurchaseSelection = () => setSelectedPurchaseIds(new Set());
  const firstSelectedPurchaseId = Array.from(selectedPurchaseIds)[0] || "";
  const hasPurchaseFilters =
    boardFilter !== "all" ||
    purchaseKindFilter !== "all" ||
    statusFilter !== "all" ||
    validationFilter !== "all" ||
    Boolean(search || issueFrom || issueTo || receivedFrom || receivedTo || amountMin || amountMax);
  const purchaseFilterCount = [
    boardFilter !== "all",
    purchaseKindFilter !== "all",
    statusFilter !== "all",
    validationFilter !== "all",
    Boolean(search),
    Boolean(issueFrom || issueTo || receivedFrom || receivedTo),
    Boolean(amountMin || amountMax),
  ].filter(Boolean).length;
  const purchaseAsyncState = busyImport
    ? {
        title: "Import fournisseur",
        detail: "Analyse du fichier et contrôles Factur-X/XML en cours.",
      }
    : purchaseExportBusy
      ? {
          title: "Export achats",
          detail: "Préparation du CSV avec les filtres actuellement affichés.",
        }
      : manualPurchaseBusy
        ? {
            title: manualPurchaseKind === "mileage" ? "Ajout des frais kilométriques" : "Ajout de la note de frais",
            detail: "Création de l'achat manuel et mise à jour de la liste.",
          }
        : bulkWorkflowBusy
          ? {
              title: "Traitement groupé achats",
              detail:
                bulkWorkflowBusy === "vat_correction"
                  ? "Application des corrections TVA sur les lignes sélectionnées."
                  : bulkWorkflowBusy === "vat_validation"
                    ? "Validation des corrections TVA sélectionnées."
                    : "Mise à jour des statuts sélectionnés.",
            }
          : rowWorkflowBusy
            ? {
                title: "Mise à jour achat",
                detail: "Enregistrement du nouveau statut et rechargement de la liste.",
              }
            : null;
  const resetPurchasesFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setValidationFilter("all");
    setIssueFrom("");
    setIssueTo("");
    setReceivedFrom("");
    setReceivedTo("");
    setAmountMin("");
    setAmountMax("");
    setBoardFilter("all");
    setPurchaseKindFilter("all");
    clearPurchaseSelection();
  };
  const downloadPurchasesExport = useCallback(
    async (_kind: "csv" | "accounting" = "csv", requestedScope?: "filtered" | "selection") => {
      setPurchaseExportBusy(true);
      setError(null);
      setNotice(null);
      try {
        const selectedIds =
          requestedScope === "filtered"
            ? []
            : requestedScope === "selection" || !requestedScope
              ? Array.from(selectedPurchaseIds)
              : [];
        let path = exportPath;
        if (selectedIds.length > 0) {
          const params = new URLSearchParams();
          selectedIds.forEach((id) => params.append("ids", id));
          path = `/api/inbox/export?${params.toString()}`;
        }
        await downloadProtectedFile(path, "achats_fournisseurs.csv");
        setNotice(
          selectedIds.length > 0
            ? `CSV achats lancé pour ${selectedIds.length} achat${selectedIds.length > 1 ? "s" : ""} sélectionné${selectedIds.length > 1 ? "s" : ""}.`
            : "CSV achats lancé avec les filtres affichés.",
        );
      } catch (err) {
        setError(formatApiError(err, "Export achats impossible."));
      } finally {
        setPurchaseExportBusy(false);
      }
    },
    [exportPath, selectedPurchaseIds],
  );
  const bulkUpdatePurchaseWorkflow = async (state: string) => {
    const selectedItems = items.filter((item) => selectedPurchaseIds.has(String(item.id)));
    if (!selectedItems.length) return;
    if (state === "booked") {
      setError("Le paiement fournisseur doit être enregistré depuis le détail de l'achat.");
      return;
    }
    setBulkWorkflowBusy(state);
    setError(null);
    setNotice(null);
    try {
      await Promise.all(
        selectedItems.map((item) => {
          const currentWorkflow = workflowStatesMap[item.id] || {};
          return api(`/api/ops/purchase-workflow/${item.id}`, {
            method: "POST",
            body: JSON.stringify({
              state,
              owner_role: currentWorkflow.owner_role || "accountant",
              note: currentWorkflow.note || "",
            }),
          });
        }),
      );
      const label = purchaseWorkflowPill({ state }).label.toLowerCase();
      setNotice(
        `${selectedItems.length} achat${selectedItems.length > 1 ? "s" : ""} passé${selectedItems.length > 1 ? "s" : ""} ${label}.`,
      );
      clearPurchaseSelection();
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(formatApiError(err, "Mise à jour groupée impossible."));
    } finally {
      setBulkWorkflowBusy(null);
    }
  };
  const bulkApplyPurchaseVatCorrection = async () => {
    const invoiceIds = Array.from(selectedPurchaseIds);
    if (!invoiceIds.length) return;
    const useSupplierRules = bulkVatCorrectionRate === "supplier";
    setBulkWorkflowBusy("vat_correction");
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/inbox/vat-corrections/bulk-apply", {
        method: "POST",
        body: JSON.stringify({
          invoice_ids: invoiceIds,
          use_supplier_rules: useSupplierRules,
          apply_to_purchase_lines: bulkVatApplyToLines,
          ...(useSupplierRules ? {} : { vat_rate: Number(bulkVatCorrectionRate || 20) }),
        }),
      });
      const updated = Number(result?.updated_count || 0);
      const skipped = Number(result?.skipped_count || 0);
      const details =
        skipped > 0
          ? ` ${skipped} ignoré${skipped > 1 ? "s" : ""} car déjà corrigé, ventilé, sans règle fournisseur ou non éligible.`
          : "";
      const ruleLabel = useSupplierRules ? "avec les règles fournisseur" : `avec TVA ${bulkVatCorrectionRate} %`;
      const lineLabel = bulkVatApplyToLines ? " lignes ventilées incluses" : "";
      setNotice(
        `${updated} achat${updated > 1 ? "s" : ""} corrigé${updated > 1 ? "s" : ""} ${ruleLabel}${lineLabel}.${details}`,
      );
      clearPurchaseSelection();
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(formatApiError(err, "Correction TVA groupée impossible."));
    } finally {
      setBulkWorkflowBusy(null);
    }
  };
  const bulkValidatePurchaseVatCorrections = async () => {
    const invoiceIds = Array.from(selectedPurchaseIds);
    if (!invoiceIds.length) return;
    setBulkWorkflowBusy("vat_validation");
    setError(null);
    setNotice(null);
    try {
      const result: any = await api("/api/inbox/vat-corrections/bulk-validate", {
        method: "POST",
        body: JSON.stringify({
          invoice_ids: invoiceIds,
          cabinet_comment: "Correction TVA revue depuis la liste achats.",
        }),
      });
      const validated = Number(result?.validated_count || 0);
      const skipped = Number(result?.skipped_count || 0);
      const details = skipped > 0 ? ` ${skipped} à corriger manuellement.` : "";
      setNotice(`${validated} correction${validated > 1 ? "s" : ""} TVA validée${validated > 1 ? "s" : ""}.${details}`);
      clearPurchaseSelection();
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(formatApiError(err, "Validation TVA groupée impossible."));
    } finally {
      setBulkWorkflowBusy(null);
    }
  };
  const openManualPurchase = useCallback((kind: ManualPurchaseKind) => {
    const stored = readLocalDraft(localDraftKey(MANUAL_PURCHASE_DRAFT_PREFIX, kind), MANUAL_PURCHASE_DRAFT_VERSION);
    const restoredDraft =
      stored?.kind === kind && stored?.draft && typeof stored.draft === "object"
        ? { ...createManualPurchaseDraft(kind), ...stored.draft }
        : createManualPurchaseDraft(kind);
    setManualPurchaseDraft(restoredDraft);
    setManualPurchaseKind(kind);
    setError(null);
    setNotice(stored?.kind === kind && stored?.draft ? "Brouillon d'achat manuel restauré." : null);
  }, []);

  useEffect(() => {
    if (!manualPurchaseKind) return;
    const timer = window.setTimeout(() => {
      const key = localDraftKey(MANUAL_PURCHASE_DRAFT_PREFIX, manualPurchaseKind);
      if (JSON.stringify(manualPurchaseDraft) === JSON.stringify(createManualPurchaseDraft(manualPurchaseKind))) {
        removeLocalDraft(key);
        return;
      }
      writeLocalDraft(key, {
        version: MANUAL_PURCHASE_DRAFT_VERSION,
        kind: manualPurchaseKind,
        draft: manualPurchaseDraft,
        saved_at: new Date().toISOString(),
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [manualPurchaseDraft, manualPurchaseKind]);

  useEffect(() => {
    const openImport = () => importRef.current?.click();
    const openExpense = () => openManualPurchase("expense_report");
    const openMileage = () => openManualPurchase("mileage");
    const exportPurchases = () => void downloadPurchasesExport("accounting");
    const exportPurchasesCsv = () => void downloadPurchasesExport("csv");
    const toggleExportPanel = () => setPurchaseExportToolsOpen((current) => !current);
    const openReferences = () => setPurchaseReferencesOpen(true);
    window.addEventListener("pixfacture:purchases-import", openImport);
    window.addEventListener("pixfacture:purchases-expense", openExpense);
    window.addEventListener("pixfacture:purchases-mileage", openMileage);
    window.addEventListener("pixfacture:purchases-export", exportPurchases);
    window.addEventListener("pixfacture:purchases-export-accounting", exportPurchases);
    window.addEventListener("pixfacture:purchases-export-csv", exportPurchasesCsv);
    window.addEventListener("pixfacture:purchases-export-panel", toggleExportPanel);
    window.addEventListener("pixfacture:purchases-references", openReferences);
    return () => {
      window.removeEventListener("pixfacture:purchases-import", openImport);
      window.removeEventListener("pixfacture:purchases-expense", openExpense);
      window.removeEventListener("pixfacture:purchases-mileage", openMileage);
      window.removeEventListener("pixfacture:purchases-export", exportPurchases);
      window.removeEventListener("pixfacture:purchases-export-accounting", exportPurchases);
      window.removeEventListener("pixfacture:purchases-export-csv", exportPurchasesCsv);
      window.removeEventListener("pixfacture:purchases-export-panel", toggleExportPanel);
      window.removeEventListener("pixfacture:purchases-references", openReferences);
    };
  }, [downloadPurchasesExport, openManualPurchase]);

  const saveManualPurchase = async () => {
    if (!manualPurchaseKind) return;
    const supplierName = String(manualPurchaseDraft.supplier_name || "").trim();
    const purchaseLines = normalizePurchaseLineDrafts(manualPurchaseDraft.purchase_lines);
    const hasPurchaseLines = purchaseLines.lines.length > 0;
    const manualTotalHt = parsePurchaseAmount(String(manualPurchaseDraft.total_ex_vat ?? "")) ?? 0;
    const manualTotalVat = parsePurchaseAmount(String(manualPurchaseDraft.total_vat ?? "")) ?? 0;
    const manualTotalTtc = parsePurchaseAmount(
      String(manualPurchaseDraft.total_ttc || manualPurchaseDraft.total_ex_vat || ""),
    );
    const totalTtc = hasPurchaseLines ? purchaseLines.total_ttc : manualTotalTtc;
    if (!supplierName) {
      setError("Renseignez le fournisseur ou le salarié avant d'ajouter l'achat.");
      return;
    }
    if (totalTtc === null || !Number.isFinite(totalTtc) || totalTtc < 0) {
      setError("Renseignez un montant TTC valide.");
      return;
    }
    if (!hasPurchaseLines && !purchaseAmountsAreCoherent(totalTtc, manualTotalHt, manualTotalVat)) {
      setError("Corrigez les montants : HT + TVA doit correspondre au TTC.");
      return;
    }
    if (hasPurchaseLines && purchaseLines.lines.some((line: any) => purchaseLineZeroVatNeedsReason(line))) {
      setError("Renseignez le motif de TVA 0 avant d'ajouter cet achat.");
      return;
    }
    setManualPurchaseBusy(true);
    setError(null);
    setNotice(null);
    try {
      const noteDetails =
        manualPurchaseKind === "mileage"
          ? [
              manualPurchaseDraft.note,
              manualPurchaseDraft.distance_km ? `${manualPurchaseDraft.distance_km} km` : "",
              manualPurchaseDraft.vehicle_type,
              manualPurchaseDraft.round_trip ? "aller-retour" : "",
            ]
              .filter(Boolean)
              .join(" · ")
          : manualPurchaseDraft.note;
      const kind = manualPurchaseKind;
      await api("/api/inbox/manual-purchase", {
        method: "POST",
        body: JSON.stringify({
          kind,
          supplier_name: supplierName,
          invoice_number: manualPurchaseDraft.invoice_number || null,
          issue_date: manualPurchaseDraft.issue_date || null,
          total_ex_vat: hasPurchaseLines
            ? purchaseLines.total_ex_vat
            : manualPurchaseDraft.total_ex_vat
              ? Number(String(manualPurchaseDraft.total_ex_vat).replace(",", "."))
              : null,
          total_vat: hasPurchaseLines
            ? purchaseLines.total_vat
            : manualPurchaseDraft.total_vat
              ? Number(String(manualPurchaseDraft.total_vat).replace(",", "."))
              : 0,
          total_ttc: totalTtc,
          currency: manualPurchaseDraft.currency || "EUR",
          note: noteDetails || null,
          purchase_lines: hasPurchaseLines ? purchaseLines.lines : null,
        }),
      });
      removeLocalDraft(localDraftKey(MANUAL_PURCHASE_DRAFT_PREFIX, kind));
      setManualPurchaseKind(null);
      setManualPurchaseDraft(createManualPurchaseDraft(kind));
      setNotice(kind === "mileage" ? "Frais kilométriques ajoutés." : "Note de frais ajoutée.");
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(formatApiError(err, "Impossible d'ajouter cet achat manuel."));
    } finally {
      setManualPurchaseBusy(false);
    }
  };
  const updatePurchaseWorkflow = async (item: any, state: string) => {
    setRowWorkflowBusy(`${item.id}:${state}`);
    setError(null);
    setNotice(null);
    try {
      const currentWorkflow = workflowStatesMap[item.id] || {};
      await api(`/api/ops/purchase-workflow/${item.id}`, {
        method: "POST",
        body: JSON.stringify({
          state,
          owner_role: currentWorkflow.owner_role || "accountant",
          note: currentWorkflow.note || "",
        }),
      });
      setNotice(`Achat ${purchaseWorkflowPill({ state }).label.toLowerCase()} mis à jour.`);
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour l'état achat."));
    } finally {
      setRowWorkflowBusy(null);
    }
  };
  const purchaseReferenceRows =
    purchaseReferencesTab === "suppliers" ? purchaseSupplierReferences : purchaseEmployeeReferences;
  const purchaseReferenceEmptyLabel =
    purchaseReferencesTab === "suppliers"
      ? "Aucune fiche fournisseur mémorisée."
      : "Aucune personne à rembourser mémorisée.";
  const purchaseSupplierDuplicateGroupCount = purchaseSupplierDuplicateGroups.filter(
    (group) => Array.isArray(group?.items) && group.items.length > 1,
  ).length;
  const purchaseSupplierDuplicateRemoveCount = purchaseSupplierDuplicateGroups.reduce(
    (total, group) => total + (Array.isArray(group?.remove) ? group.remove.length : 0),
    0,
  );
  if (!sessionLoading && !purchasesEnabled) {
    return (
      <UpgradeNoticeCard
        title={
          inboxGate.reactivationRequired
            ? inboxGate.statusLabel
            : isPurchasesView
              ? "Achats disponibles avec le plan Pro"
              : "Factures reçues disponibles avec le plan Pro"
        }
        description={
          inboxGate.reactivationDescription ||
          (isPurchasesView
            ? "Starter reste centré sur les clients, devis et factures PDF. Passez à Pro pour gérer les factures fournisseurs, notes de frais et paiements associés."
            : "Starter ne donne pas accès à la réception e-facturation. Passez à Pro pour préparer les factures reçues, sous réserve d’un connecteur réellement configuré.")
        }
        ctaLabel={inboxGate.ctaLabel}
        ctaHref={inboxGate.ctaHref}
        note={inboxGate.reactivationNote || undefined}
      />
    );
  }
  if (isPurchasesView) {
    return (
      <>
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? (
          <NoticeBanner tone="success" onDismiss={() => setNotice(null)} autoDismissMs={6000}>
            {notice}
          </NoticeBanner>
        ) : null}
        {purchaseAsyncState ? (
          <NoticeBanner tone="info" title={purchaseAsyncState.title}>
            <span className="inline-flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {purchaseAsyncState.detail}
            </span>
          </NoticeBanner>
        ) : null}
        <input
          ref={importRef}
          type="file"
          aria-label="Importer une facture fournisseur"
          accept="application/pdf,application/xml,text/xml,.pdf,.xml"
          className="hidden"
          onChange={(event) => {
            void importFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />

        {purchaseReferencesOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]/45 px-3 py-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            onClick={() => setPurchaseReferencesOpen(false)}
          >
            <div
              className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4 border-b border-[#e2e8f0] px-5 py-4">
                <div>
                  <h2 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 800 }}>
                    Fiches fournisseurs
                  </h2>
                  <p
                    className="mt-1 text-[#64748b]"
                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                  >
                    Fiches réutilisées dans les achats : fournisseurs et personnes à rembourser.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPurchaseReferencesOpen(false)}
                  className="rounded-full p-2 text-[#64748b] transition-colors hover:bg-[#f1f5f9]"
                  aria-label="Fermer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="border-b border-[#e2e8f0] bg-[#f8fafc] px-5 py-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex flex-wrap gap-2">
                    {[
                      {
                        value: "suppliers" as const,
                        label: "Fournisseurs",
                        count: purchaseSupplierReferences.filter((entry) => entry?.id).length,
                      },
                      {
                        value: "people" as const,
                        label: "Personnes à rembourser",
                        count: purchaseEmployeeReferences.filter((entry) => entry?.id).length,
                      },
                    ].map((tab) => (
                      <button
                        key={tab.value}
                        type="button"
                        onClick={() => setPurchaseReferencesTab(tab.value)}
                        className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 transition-colors ${
                          purchaseReferencesTab === tab.value
                            ? "bg-[#15803d] text-white"
                            : "bg-white text-[#15803d] hover:bg-[#f0fdf4]"
                        }`}
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                      >
                        {tab.label}
                        <span
                          className={`rounded-full px-1.5 py-0.5 ${
                            purchaseReferencesTab === tab.value
                              ? "bg-white/20 text-white"
                              : "bg-[#e2e8f0] text-[#64748b]"
                          }`}
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                        >
                          {tab.count}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="relative min-w-0 md:w-80">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94a3b8]" />
                    <input
                      value={purchaseReferencesSearch}
                      onChange={(event) => setPurchaseReferencesSearch(event.target.value)}
                      placeholder="Rechercher une fiche..."
                      className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white pl-9 pr-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                      style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                    />
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {purchaseReferencesError ? (
                  <div
                    className="mb-3 rounded-xl border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[#991b1b]"
                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                  >
                    {purchaseReferencesError}
                  </div>
                ) : null}
                {purchaseReferencesTab === "suppliers" && purchaseSupplierDuplicateGroupCount ? (
                  <div className="mb-3">
                    {purchaseSupplierDuplicateGroupCount ? (
                      <div className="rounded-xl border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-[#9a3412]">
                        <div
                          className="flex items-center gap-2"
                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 900 }}
                        >
                          <AlertCircle className="h-4 w-4" />
                          {purchaseSupplierDuplicateGroupCount} groupe
                          {purchaseSupplierDuplicateGroupCount > 1 ? "s" : ""} de doublons fournisseur
                        </div>
                        <p
                          className="mt-1 text-[#7c2d12]"
                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 650 }}
                        >
                          {purchaseSupplierDuplicateRemoveCount} fiche
                          {purchaseSupplierDuplicateRemoveCount > 1 ? "s" : ""} peut être désactivée après vérification
                          des clés communes.
                        </p>
                        <div className="mt-2 space-y-1.5">
                          {purchaseSupplierDuplicateGroups.slice(0, 3).map((group) => {
                            const keepId = String(group?.keep || "");
                            const removeCount = Array.isArray(group?.remove) ? group.remove.length : 0;
                            const items = Array.isArray(group?.items) ? group.items : [];
                            const keep = items.find((item: any) => String(item?.id) === keepId);
                            const groupKey = `${group?.field || "field"}-${group?.value || "value"}-${keepId}`;
                            return (
                              <div
                                key={groupKey}
                                className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5"
                              >
                                <span
                                  className="min-w-0 truncate text-[#9a3412]"
                                  style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 850 }}
                                >
                                  {purchaseSupplierDuplicateFieldLabel(group?.field)}{" "}
                                  {String(group?.value || "").slice(0, 18)}
                                  {keep ? ` · garder ${purchaseSupplierName(keep)}` : ""}
                                  {removeCount ? ` · ${removeCount} doublon${removeCount > 1 ? "s" : ""}` : ""}
                                </span>
                                <button
                                  type="button"
                                  disabled={!keepId || removeCount === 0 || purchaseSupplierConsolidating === keepId}
                                  onClick={() => void consolidatePurchaseSupplierDuplicate(group)}
                                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[#fdba74] bg-[#fff7ed] px-2 text-[#9a3412] transition-colors hover:bg-[#ffedd5] disabled:cursor-wait disabled:opacity-60"
                                  style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                                >
                                  <CheckSquare className="h-3.5 w-3.5" />
                                  {purchaseSupplierConsolidating === keepId ? "En cours" : "Consolider"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {purchaseReferencesLoading ? (
                  <div
                    className="py-12 text-center text-[#94a3b8]"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                  >
                    Chargement des fiches...
                  </div>
                ) : purchaseReferenceRows.filter((entry) => entry?.id).length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[#cbd5e1] bg-[#f8fafc] px-4 py-10 text-center">
                    <p className="text-[#0f172a]" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}>
                      {purchaseReferenceEmptyLabel}
                    </p>
                    <p
                      className="mt-1 text-[#64748b]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                    >
                      Les fiches se créent depuis les champs de recherche quand vous qualifiez un achat.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white">
                    {purchaseReferenceRows
                      .filter((entry) => entry?.id)
                      .map((entry) => {
                        const isSupplier = purchaseReferencesTab === "suppliers";
                        const label = isSupplier ? purchaseSupplierName(entry) : employeePayerName(entry);
                        const meta = isSupplier ? purchaseSupplierMeta(entry) : purchaseEmployeePayerMeta(entry);
                        const supplierDetailsMeta = isSupplier ? purchaseSupplierDetailsMeta(entry) : meta;
                        const customerMatch = isSupplier ? entry?.customer_match : null;
                        const customerMatchLabel = isSupplier ? purchaseSupplierCustomerMatchLabel(entry) : "";
                        const dateValue = entry.last_used_at || entry.last_received_at;
                        const entryId = String(entry.id);
                        const isEditing =
                          purchaseReferenceEditing?.id === entryId &&
                          purchaseReferenceEditing.kind === (isSupplier ? "supplier" : "person");
                        return (
                          <div
                            key={`${purchaseReferencesTab}-${entryId}`}
                            className="border-b border-[#eef2f7] px-4 py-3 last:border-b-0"
                          >
                            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                              <div className="flex min-w-0 items-center gap-3">
                                <span
                                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#dcfce7] text-[#15803d]"
                                  style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                                >
                                  {purchasePersonInitials(label)}
                                </span>
                                <div className="min-w-0">
                                  <span
                                    className="block truncate text-[#0f172a]"
                                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                                  >
                                    {label}
                                  </span>
                                  <span
                                    className="block truncate text-[#64748b]"
                                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                                  >
                                    {supplierDetailsMeta || "Fiche mémorisée"}
                                    {dateValue ? ` · Dernière utilisation ${formatDateFr(dateValue)}` : ""}
                                  </span>
                                  {customerMatch?.id ? (
                                    <div className="mt-1 flex flex-wrap items-center gap-2">
                                      <span
                                        className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-2 text-[#1d4ed8]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                                      >
                                        <Building2 className="h-3.5 w-3.5" />
                                        {customerMatchLabel}
                                      </span>
                                      <Link
                                        to={`/app/customers/${customerMatch.id}`}
                                        className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[#0f4cc9] transition-colors hover:bg-[#eff6ff]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                                      >
                                        Ouvrir la fiche client
                                        <ArrowRight className="h-3.5 w-3.5" />
                                      </Link>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => startPurchaseReferenceEdit(isSupplier ? "supplier" : "person", entry)}
                                  className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${
                                    isEditing
                                      ? "border-[#bbf7d0] bg-[#f0fdf4] text-[#15803d]"
                                      : "border-[#dbe7f3] bg-white text-[#475569] hover:bg-[#f8fafc]"
                                  }`}
                                  title="Modifier la fiche"
                                  aria-label={`Modifier ${label || "la fiche"}`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={purchaseReferenceDeleting === entryId}
                                  onClick={() =>
                                    void deletePurchaseReference(isSupplier ? "supplier" : "person", entry)
                                  }
                                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#fecaca] bg-white text-[#dc2626] transition-colors hover:bg-[#fef2f2] disabled:cursor-wait disabled:opacity-60"
                                  title="Supprimer la fiche"
                                  aria-label={`Supprimer ${label || "la fiche"}`}
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                            {isEditing ? (
                              <div className="mt-3 rounded-xl border border-[#bbf7d0] bg-[#f8fff9] p-3">
                                {isSupplier ? (
                                  <div className="grid gap-3 md:grid-cols-2">
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        Nom fournisseur
                                      </span>
                                      <input
                                        value={purchaseReferenceEditDraft.name || ""}
                                        onChange={(event) => updatePurchaseReferenceEdit("name", event.target.value)}
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      />
                                    </label>
                                    <PurchaseAccountingAccountField
                                      label="Catégorie compta"
                                      value={purchaseReferenceEditDraft.accounting_account || ""}
                                      onChange={(value) => updatePurchaseReferenceEdit("accounting_account", value)}
                                      selectClassName="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                      selectStyle={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                    />
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        TVA par défaut
                                      </span>
                                      <input
                                        inputMode="decimal"
                                        value={purchaseReferenceEditDraft.vat_rate || ""}
                                        onChange={(event) =>
                                          updatePurchaseReferenceEdit("vat_rate", event.target.value)
                                        }
                                        placeholder="20"
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      />
                                    </label>
                                    <div className="space-y-2 rounded-xl border border-[#dbe7f3] bg-white p-3 md:col-span-2">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                          <span
                                            className="block text-[#0f172a]"
                                            style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                                          >
                                            Exceptions TVA par compte ou nature
                                          </span>
                                          <span
                                            className="block text-[#64748b]"
                                            style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                                          >
                                            Prioritaires sur la TVA par défaut.
                                          </span>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={addPurchaseSupplierVatRule}
                                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] px-2.5 text-[#15803d]"
                                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                                        >
                                          <Plus className="h-3.5 w-3.5" />
                                          Exception
                                        </button>
                                      </div>
                                      <div className="space-y-2">
                                        {(Array.isArray(purchaseReferenceEditDraft.vat_rules)
                                          ? purchaseReferenceEditDraft.vat_rules
                                          : []
                                        ).map((rule: any, ruleIndex: number) => (
                                          <div
                                            key={`supplier-vat-rule-${ruleIndex}`}
                                            className="grid gap-2 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-2 sm:grid-cols-[1fr_1fr_0.7fr_2rem]"
                                          >
                                            <PurchaseAccountingAccountField
                                              value={rule.accounting_account || ""}
                                              onChange={(value) =>
                                                updatePurchaseSupplierVatRule(ruleIndex, { accounting_account: value })
                                              }
                                              selectClassName="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                              selectStyle={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 700 }}
                                            />
                                            <select
                                              value={rule.purchase_nature || ""}
                                              onChange={(event) =>
                                                updatePurchaseSupplierVatRule(ruleIndex, {
                                                  purchase_nature: event.target.value,
                                                })
                                              }
                                              className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 700 }}
                                            >
                                              {purchaseNatureOptions.map((option) => (
                                                <option key={option.value || "empty"} value={option.value}>
                                                  {option.label}
                                                </option>
                                              ))}
                                            </select>
                                            <input
                                              inputMode="decimal"
                                              value={rule.vat_rate || ""}
                                              onChange={(event) =>
                                                updatePurchaseSupplierVatRule(ruleIndex, {
                                                  vat_rate: event.target.value,
                                                })
                                              }
                                              placeholder="TVA %"
                                              className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                                            />
                                            <button
                                              type="button"
                                              onClick={() => removePurchaseSupplierVatRule(ruleIndex)}
                                              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#fecaca] bg-white text-[#dc2626]"
                                              aria-label="Supprimer l'exception TVA"
                                            >
                                              <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        SIREN
                                      </span>
                                      <input
                                        value={purchaseReferenceEditDraft.supplier_siren || ""}
                                        onChange={(event) =>
                                          updatePurchaseReferenceEdit("supplier_siren", event.target.value)
                                        }
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      />
                                    </label>
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        SIRET
                                      </span>
                                      <input
                                        value={purchaseReferenceEditDraft.supplier_siret || ""}
                                        onChange={(event) =>
                                          updatePurchaseReferenceEdit("supplier_siret", event.target.value)
                                        }
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      />
                                    </label>
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        N° TVA
                                      </span>
                                      <input
                                        value={purchaseReferenceEditDraft.vat_number || ""}
                                        onChange={(event) =>
                                          updatePurchaseReferenceEdit("vat_number", event.target.value)
                                        }
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      />
                                    </label>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                      <label className="space-y-1">
                                        <span
                                          className="text-[#64748b]"
                                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                        >
                                          Délai paiement
                                        </span>
                                        <input
                                          type="number"
                                          min={0}
                                          max={365}
                                          value={purchaseReferenceEditDraft.payment_delay_days ?? ""}
                                          onChange={(event) =>
                                            updatePurchaseReferenceEdit("payment_delay_days", event.target.value)
                                          }
                                          className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                          style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                        />
                                      </label>
                                      <label className="space-y-1">
                                        <span
                                          className="text-[#64748b]"
                                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                        >
                                          Nature
                                        </span>
                                        <select
                                          value={purchaseReferenceEditDraft.purchase_nature || ""}
                                          onChange={(event) =>
                                            updatePurchaseReferenceEdit("purchase_nature", event.target.value)
                                          }
                                          className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                          style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                        >
                                          <option value="">Non renseignée</option>
                                          <option value="service">Service</option>
                                          <option value="product">Produit</option>
                                        </select>
                                      </label>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="grid gap-3 md:grid-cols-2">
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        Nom
                                      </span>
                                      <input
                                        value={purchaseReferenceEditDraft.name || ""}
                                        onChange={(event) => updatePurchaseReferenceEdit("name", event.target.value)}
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      />
                                    </label>
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        Profil
                                      </span>
                                      <select
                                        value={purchaseReferenceEditDraft.role || "manager"}
                                        onChange={(event) => updatePurchaseReferenceEdit("role", event.target.value)}
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      >
                                        <option value="manager">Dirigeant</option>
                                        <option value="employee">Salarié</option>
                                      </select>
                                    </label>
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        Utilisateur rattaché
                                      </span>
                                      <input
                                        value={purchaseReferenceEditDraft.user_label || ""}
                                        onChange={(event) =>
                                          updatePurchaseReferenceEdit("user_label", event.target.value)
                                        }
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      />
                                    </label>
                                    <PurchaseAccountingAccountField
                                      label="Catégorie compta"
                                      value={purchaseReferenceEditDraft.accounting_account || ""}
                                      onChange={(value) => updatePurchaseReferenceEdit("accounting_account", value)}
                                      selectClassName="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                      selectStyle={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                    />
                                    <label className="space-y-1">
                                      <span
                                        className="text-[#64748b]"
                                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                      >
                                        Remboursement
                                      </span>
                                      <select
                                        value={purchaseReferenceEditDraft.reimbursement_method || "bank_transfer"}
                                        onChange={(event) =>
                                          updatePurchaseReferenceEdit("reimbursement_method", event.target.value)
                                        }
                                        className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                      >
                                        <option value="bank_transfer">Virement</option>
                                        <option value="cash">Espèces</option>
                                        <option value="other">Autre</option>
                                      </select>
                                    </label>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                      <label className="space-y-1">
                                        <span
                                          className="text-[#64748b]"
                                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                        >
                                          Véhicule
                                        </span>
                                        <input
                                          value={purchaseReferenceEditDraft.vehicle_type || ""}
                                          onChange={(event) =>
                                            updatePurchaseReferenceEdit("vehicle_type", event.target.value)
                                          }
                                          className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                          style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                        />
                                      </label>
                                      <label className="space-y-1">
                                        <span
                                          className="text-[#64748b]"
                                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                        >
                                          Puissance fiscale
                                        </span>
                                        <input
                                          value={purchaseReferenceEditDraft.fiscal_power || ""}
                                          onChange={(event) =>
                                            updatePurchaseReferenceEdit("fiscal_power", event.target.value)
                                          }
                                          className="h-9 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                          style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                        />
                                      </label>
                                    </div>
                                  </div>
                                )}
                                <label className="mt-3 block space-y-1">
                                  <span
                                    className="text-[#64748b]"
                                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                                  >
                                    Note interne
                                  </span>
                                  <textarea
                                    value={purchaseReferenceEditDraft.notes || ""}
                                    onChange={(event) => updatePurchaseReferenceEdit("notes", event.target.value)}
                                    className="min-h-20 w-full rounded-lg border border-[#dbe7f3] bg-white px-3 py-2 text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                                  />
                                </label>
                                <div className="mt-3 flex flex-wrap justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPurchaseReferenceEditing(null);
                                      setPurchaseReferenceEditDraft({});
                                    }}
                                    className="inline-flex h-9 items-center justify-center rounded-lg border border-[#dbe7f3] bg-white px-3 text-[#475569] transition-colors hover:bg-[#f8fafc]"
                                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                                  >
                                    Annuler
                                  </button>
                                  <button
                                    type="button"
                                    disabled={purchaseReferenceSaving === entryId}
                                    onClick={() => void savePurchaseReferenceEdit()}
                                    className="inline-flex h-9 items-center justify-center rounded-lg bg-[#15803d] px-3 text-white transition-colors hover:bg-[#166534] disabled:cursor-wait disabled:opacity-60"
                                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                                  >
                                    {purchaseReferenceSaving === entryId ? "Enregistrement..." : "Enregistrer"}
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {manualPurchaseKind ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]/45 px-3 py-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            onClick={() => setManualPurchaseKind(null)}
          >
            <div
              className="max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4 border-b border-[#e2e8f0] px-5 py-4">
                <div>
                  <h2 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 800 }}>
                    {manualPurchaseKind === "mileage" ? "Frais kilométriques" : "Note de frais"}
                  </h2>
                  <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}>
                    Saisie manuelle ajoutée aux achats et reprise dans le suivi des paiements, sans connexion bancaire.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setManualPurchaseKind(null)}
                  className="rounded-full p-2 text-[#64748b] transition-colors hover:bg-[#f1f5f9]"
                  aria-label="Fermer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
                <InputField
                  label={manualPurchaseKind === "mileage" ? "Salarié / dirigeant" : "Fournisseur / personne"}
                  value={manualPurchaseDraft.supplier_name}
                  onChange={(event) =>
                    setManualPurchaseDraft((prev: any) => ({ ...prev, supplier_name: event.target.value }))
                  }
                  placeholder={manualPurchaseKind === "mileage" ? "Nom du salarié" : "Nom du fournisseur"}
                />
                <InputField
                  label="Date"
                  type="date"
                  value={manualPurchaseDraft.issue_date}
                  onChange={(event) =>
                    setManualPurchaseDraft((prev: any) => ({ ...prev, issue_date: event.target.value }))
                  }
                />
                <InputField
                  label="Référence"
                  value={manualPurchaseDraft.invoice_number}
                  onChange={(event) =>
                    setManualPurchaseDraft((prev: any) => ({ ...prev, invoice_number: event.target.value }))
                  }
                  placeholder="Optionnel"
                />
                <InputField
                  label="Montant TTC"
                  inputMode="decimal"
                  value={manualPurchaseDraft.total_ttc}
                  onChange={(event) =>
                    setManualPurchaseDraft((prev: any) => ({ ...prev, total_ttc: event.target.value }))
                  }
                  placeholder="0,00"
                />
                <InputField
                  label="Montant HT"
                  inputMode="decimal"
                  value={manualPurchaseDraft.total_ex_vat}
                  onChange={(event) =>
                    setManualPurchaseDraft((prev: any) => ({ ...prev, total_ex_vat: event.target.value }))
                  }
                  placeholder="Optionnel"
                />
                <InputField
                  label="TVA"
                  inputMode="decimal"
                  value={manualPurchaseDraft.total_vat}
                  onChange={(event) =>
                    setManualPurchaseDraft((prev: any) => ({ ...prev, total_vat: event.target.value }))
                  }
                  placeholder="0,00"
                />
                <div className="md:col-span-2">
                  <PurchaseLinesEditor
                    lines={manualPurchaseDraft.purchase_lines}
                    disabled={manualPurchaseBusy}
                    onChange={(lines) => {
                      const totals = normalizePurchaseLineDrafts(lines);
                      setManualPurchaseDraft((prev: any) => ({
                        ...prev,
                        purchase_lines: lines,
                        ...(totals.lines.length
                          ? {
                              total_ex_vat: purchaseAmountToInput(totals.total_ex_vat),
                              total_vat: purchaseAmountToInput(totals.total_vat),
                              total_ttc: purchaseAmountToInput(totals.total_ttc),
                            }
                          : {}),
                      }));
                    }}
                  />
                </div>
                {manualPurchaseKind === "mileage" ? (
                  <>
                    <InputField
                      label="Distance (km)"
                      inputMode="decimal"
                      value={manualPurchaseDraft.distance_km}
                      onChange={(event) =>
                        setManualPurchaseDraft((prev: any) => ({ ...prev, distance_km: event.target.value }))
                      }
                      placeholder="0"
                    />
                    <SelectField
                      label="Type de véhicule"
                      value={manualPurchaseDraft.vehicle_type}
                      onChange={(event) =>
                        setManualPurchaseDraft((prev: any) => ({ ...prev, vehicle_type: event.target.value }))
                      }
                    >
                      <option value="Voiture">Voiture</option>
                      <option value="Deux roues">Deux roues</option>
                    </SelectField>
                    <label className="flex items-center gap-2 text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                      <input
                        type="checkbox"
                        checked={Boolean(manualPurchaseDraft.round_trip)}
                        onChange={(event) =>
                          setManualPurchaseDraft((prev: any) => ({ ...prev, round_trip: event.target.checked }))
                        }
                      />
                      Aller-retour
                    </label>
                  </>
                ) : null}
                <div className="md:col-span-2">
                  <label className="mb-1.5 block text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                    Notes
                  </label>
                  <textarea
                    value={manualPurchaseDraft.note}
                    onChange={(event) => setManualPurchaseDraft((prev: any) => ({ ...prev, note: event.target.value }))}
                    placeholder="Motif, contexte ou information comptable"
                    className="min-h-[96px] w-full rounded-lg border border-[#e2e8f0] bg-white px-3.5 py-2.5 text-sm text-[#0f172a] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all placeholder:text-[#94a3b8] focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-[#e2e8f0] bg-[#f8fafc] px-5 py-4">
                <SecondaryButton onClick={() => setManualPurchaseKind(null)}>Annuler</SecondaryButton>
                <PrimaryButton disabled={manualPurchaseBusy} onClick={() => void saveManualPurchase()}>
                  {manualPurchaseBusy
                    ? "Ajout..."
                    : manualPurchaseKind === "mileage"
                      ? "Ajouter les frais km"
                      : "Ajouter la note de frais"}
                </PrimaryButton>
              </div>
            </div>
          </div>
        ) : null}

        <div className="space-y-4">
          <div className="space-y-4">
            <SalesMetricsGrid>
              <SalesMetricCard
                tone="purchases"
                density="client"
                label="Achats visibles"
                value={money(purchaseTotalTtc)}
                detail={`${purchaseListTotalItems} ligne${purchaseListTotalItems > 1 ? "s" : ""} · HT ${money(purchaseTotalHt)}`}
                icon={<Wallet className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="purchases"
                density="client"
                accent="warning"
                label="À traiter"
                value={visibleReceivedCount}
                detail="Factures reçues à qualifier"
                icon={<Inbox className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="purchases"
                density="client"
                accent="info"
                label="En revue"
                value={visibleReviewingCount}
                detail="Contrôle interne en cours"
                icon={<CheckCircle className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="purchases"
                density="client"
                accent="success"
                label="À payer"
                value={money(readyToPayAmount)}
                detail={`${visibleReadyCount} achat${visibleReadyCount > 1 ? "s" : ""} à régler · payé ${money(bookedAmount)}`}
                icon={<Check className="h-4 w-4" />}
              />
            </SalesMetricsGrid>

            <SalesListBlock
              tone="purchases"
              density="client"
              filters={purchaseTabs.map((tab) => ({
                value: tab.value,
                label: tab.label,
                count: tab.count,
                accent:
                  tab.value === "invalid"
                    ? "danger"
                    : tab.value === "to_complete" || tab.value === "received"
                      ? "warning"
                      : tab.value === "ready_to_pay" || tab.value === "paid"
                        ? "success"
                        : tab.value === "to_match" || tab.value === "reviewing"
                          ? "info"
                          : "module",
              }))}
              filterValue={boardFilter}
              onFilterChange={setBoardFilter}
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder="Fournisseur, facture, SIREN..."
              searchWidth="20rem"
              leftExtras={
                selectedPurchaseCount > 0 ? (
                  <ActionMenu
                    label="Actions"
                    badge={selectedPurchaseCount}
                    triggerVariant="success"
                    className="shrink-0"
                  >
                    {boardFilter === "vat_corrections" ? (
                      <>
                        <div className="space-y-2 px-3 py-2">
                          <label
                            className="block text-[#64748b]"
                            style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                          >
                            Taux TVA
                            <select
                              value={bulkVatCorrectionRate}
                              onChange={(event) => setBulkVatCorrectionRate(event.target.value)}
                              className="mt-1 h-9 w-full rounded-lg border border-[#bfdbfe] bg-white px-3 text-[#1d4ed8] outline-none transition focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15"
                              style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                              title="Taux à appliquer aux achats sélectionnés sans TVA"
                            >
                              <option value="supplier">Règle fournisseur</option>
                              <option value="20">TVA 20 %</option>
                              <option value="10">TVA 10 %</option>
                              <option value="5.5">TVA 5,5 %</option>
                              <option value="2.1">TVA 2,1 %</option>
                            </select>
                          </label>
                          <label
                            className="inline-flex w-full items-center gap-2 rounded-lg bg-[#eff6ff] px-3 py-2 text-[#1d4ed8]"
                            style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                            title="Appliquer aussi aux lignes ventilées sans TVA, ligne par ligne."
                          >
                            <input
                              type="checkbox"
                              checked={bulkVatApplyToLines}
                              onChange={(event) => setBulkVatApplyToLines(event.target.checked)}
                              className="h-3.5 w-3.5 rounded border-[#bfdbfe] text-[#2563eb] focus:ring-[#2563eb]"
                            />
                            Lignes ventilées
                          </label>
                        </div>
                        <ActionMenuSeparator />
                        <ActionMenuButton
                          icon={Percent}
                          disabled={Boolean(bulkWorkflowBusy)}
                          onClick={() => void bulkApplyPurchaseVatCorrection()}
                        >
                          Appliquer la TVA
                        </ActionMenuButton>
                        <ActionMenuButton
                          icon={CheckCircle}
                          disabled={Boolean(bulkWorkflowBusy)}
                          onClick={() => void bulkValidatePurchaseVatCorrections()}
                        >
                          Valider TVA
                        </ActionMenuButton>
                        {firstSelectedPurchaseId ? (
                          <ActionMenuLink to={`${basePath}/${firstSelectedPurchaseId}`} icon={ArrowRight}>
                            Ouvrir correction
                          </ActionMenuLink>
                        ) : null}
                      </>
                    ) : (
                      <ActionMenuButton
                        icon={CreditCard}
                        disabled={Boolean(bulkWorkflowBusy)}
                        onClick={() => void bulkUpdatePurchaseWorkflow("ready_to_pay")}
                      >
                        Marquer prêt à payer
                      </ActionMenuButton>
                    )}
                    <ActionMenuSeparator />
                    <ActionMenuButton
                      icon={CheckSquare}
                      disabled={Boolean(bulkWorkflowBusy)}
                      onClick={clearPurchaseSelection}
                    >
                      Désélectionner
                    </ActionMenuButton>
                  </ActionMenu>
                ) : null
              }
              rightExtras={
                <div className="flex shrink-0 items-center gap-1.5">
                  <ActionMenu
                    label="Importer / exporter"
                    iconOnly
                    triggerIcon={Settings}
                    triggerVariant="success"
                    className="pf-toolbar-tools-menu"
                  >
                    <ActionMenuButton icon={Upload} disabled={busyImport} onClick={() => importRef.current?.click()}>
                      {busyImport ? "Import en cours" : "Importer une facture"}
                    </ActionMenuButton>
                    <ActionMenuButton
                      icon={Download}
                      disabled={purchaseExportBusy}
                      onClick={() => setPurchaseExportToolsOpen((current) => !current)}
                    >
                      Exporter
                    </ActionMenuButton>
                  </ActionMenu>
                </div>
              }
            >
              {purchaseExportToolsOpen ? (
                <div data-testid="purchase-export-panel" className="border-b border-[#bbf7d0] bg-[#f0fdf4] p-3">
                  <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-end 2xl:justify-between">
                    <div className="grid flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(220px,0.65fr)_minmax(260px,0.8fr)_minmax(320px,1fr)]">
                      <label
                        className="text-[#475569]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                      >
                        Format
                        <div
                          className="mt-1 flex h-11 items-center rounded-xl border border-[#86efac] bg-white px-3 text-[#0f172a]"
                          style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                        >
                          CSV achats
                        </div>
                      </label>
                      <label
                        className="text-[#475569]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                      >
                        Périmètre
                        <div className="mt-1 flex min-h-11 flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void downloadPurchasesExport("csv", "filtered")}
                            className="rounded-full border border-[#16a34a] bg-white px-3 py-1.5 text-[#15803d] transition-colors hover:bg-[#dcfce7]"
                            style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                          >
                            Vue filtrée · {listMeta.total || visibleItems.length}
                          </button>
                          <button
                            type="button"
                            onClick={() => void downloadPurchasesExport("csv", "selection")}
                            disabled={selectedPurchaseCount === 0}
                            className="rounded-full border border-[#86efac] bg-white px-3 py-1.5 text-[#15803d] transition-colors hover:bg-[#dcfce7] disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                          >
                            Sélection · {selectedPurchaseCount}
                          </button>
                        </div>
                      </label>
                      <div
                        className="min-w-0 text-[#475569]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                      >
                        Critères repris
                        <div className="mt-1 flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-[#86efac] bg-white px-2.5 py-2">
                          {purchaseExportCriteria.length > 0 ? (
                            purchaseExportCriteria.map((criterion) => (
                              <span
                                key={criterion}
                                className="rounded-full bg-[#f0fdf4] px-2 py-1 text-[#15803d]"
                                style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 850 }}
                              >
                                {criterion}
                              </span>
                            ))
                          ) : (
                            <span
                              className="text-[#64748b]"
                              style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 750 }}
                            >
                              Tous les achats visibles
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <GuidanceTooltip content="Télécharge le CSV avec le périmètre choisi.">
                      <button
                        type="button"
                        onClick={() =>
                          void downloadPurchasesExport("csv", selectedPurchaseCount > 0 ? "selection" : "filtered")
                        }
                        disabled={purchaseExportBusy}
                        className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-white shadow-[0_10px_22px_-16px_rgba(21,128,61,0.8)] transition-all hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50"
                        style={{
                          fontSize: "var(--pf-app-text-body)",
                          fontWeight: 900,
                          background: purchaseTheme.strong,
                        }}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {purchaseExportBusy
                          ? "Export..."
                          : selectedPurchaseCount > 0
                            ? "Exporter la sélection"
                            : "Exporter la vue filtrée"}
                      </button>
                    </GuidanceTooltip>
                  </div>
                </div>
              ) : null}
              {showFilters ? (
                <div
                  data-testid="purchase-filters-panel"
                  className="pf-filter-panel border-b border-[#e5edf5] bg-[#f8fafc]"
                >
                  <div className="grid divide-y divide-[#e5edf5] lg:grid-cols-[0.9fr_1fr_1.1fr] lg:divide-x lg:divide-y-0">
                    <section className="px-4 py-4">
                      <div
                        className="mb-3 flex items-center gap-1.5 uppercase tracking-[0.08em] text-[#64748b]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                      >
                        <FileText className="h-3.5 w-3.5 text-[#15803d]" /> Type et statut
                      </div>
                      <div className="space-y-3">
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                        >
                          Type d'achat
                          <select
                            value={purchaseKindFilter}
                            onChange={(event) => setPurchaseKindFilter(event.target.value as PurchaseKindFilter)}
                            className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          >
                            {purchaseKindOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                        >
                          Statut
                          <select
                            value={statusFilter}
                            onChange={(event) => setStatusFilter(event.target.value)}
                            className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          >
                            {statusOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </section>

                    <section className="px-4 py-4">
                      <div
                        className="mb-3 flex items-center gap-1.5 uppercase tracking-[0.08em] text-[#64748b]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                      >
                        <CheckCircle className="h-3.5 w-3.5 text-[#15803d]" /> Validation
                      </div>
                      <div className="space-y-3">
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                        >
                          Contrôle
                          <select
                            value={validationFilter}
                            onChange={(event) => setValidationFilter(event.target.value)}
                            className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          >
                            {validationOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label
                            className="block text-[#64748b]"
                            style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                          >
                            Émise dès le
                            <input
                              type="date"
                              value={issueFrom}
                              onChange={(event) => setIssueFrom(event.target.value)}
                              className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                              style={{ fontSize: "var(--pf-app-text-body)" }}
                            />
                          </label>
                          <label
                            className="block text-[#64748b]"
                            style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                          >
                            Jusqu'au
                            <input
                              type="date"
                              value={issueTo}
                              onChange={(event) => setIssueTo(event.target.value)}
                              className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                              style={{ fontSize: "var(--pf-app-text-body)" }}
                            />
                          </label>
                        </div>
                      </div>
                    </section>

                    <section className="px-4 py-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div
                          className="flex items-center gap-1.5 uppercase tracking-[0.08em] text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                        >
                          <Wallet className="h-3.5 w-3.5 text-[#15803d]" /> Réception et montant
                        </div>
                        {hasPurchaseFilters ? (
                          <button
                            type="button"
                            onClick={resetPurchasesFilters}
                            className="text-[#15803d] transition-colors hover:text-[#166534]"
                            style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                          >
                            Réinitialiser
                          </button>
                        ) : null}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                        >
                          Reçue dès le
                          <input
                            type="date"
                            value={receivedFrom}
                            onChange={(event) => setReceivedFrom(event.target.value)}
                            className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          />
                        </label>
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                        >
                          Jusqu'au
                          <input
                            type="date"
                            value={receivedTo}
                            onChange={(event) => setReceivedTo(event.target.value)}
                            className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          />
                        </label>
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                        >
                          HT min.
                          <input
                            inputMode="decimal"
                            value={amountMin}
                            onChange={(event) => setAmountMin(event.target.value)}
                            placeholder="500"
                            className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          />
                        </label>
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 800 }}
                        >
                          HT max.
                          <input
                            inputMode="decimal"
                            value={amountMax}
                            onChange={(event) => setAmountMax(event.target.value)}
                            placeholder="5000"
                            className="mt-1 h-9 w-full rounded-xl border border-[#86efac] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          />
                        </label>
                      </div>
                    </section>
                  </div>
                </div>
              ) : null}

              {loading ? (
                <div className="px-5 py-14 text-center text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  Chargement des achats fournisseurs...
                </div>
              ) : visibleItems.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                      <Inbox className="h-5 w-5 text-[#cbd5e1]" />
                    </div>
                    <p className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                      {hasPurchaseFilters ? "Aucun achat ne correspond aux filtres." : "Aucun achat fournisseur"}
                    </p>
                    <p className="max-w-xl text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                      Importe une facture d'achat ou ajoute une dépense manuelle pour alimenter le suivi fournisseur.
                    </p>
                    <div className="mt-2 flex flex-wrap justify-center gap-2">
                      <PrimaryButton disabled={busyImport} onClick={() => importRef.current?.click()}>
                        <Upload className="h-3.5 w-3.5" /> {busyImport ? "Import..." : "Importer"}
                      </PrimaryButton>
                      {!hasPurchaseFilters ? (
                        <>
                          <SecondaryButton onClick={() => openManualPurchase("expense_report")}>
                            <Wallet className="h-3.5 w-3.5" /> Note de frais
                          </SecondaryButton>
                          <SecondaryButton onClick={() => openManualPurchase("mileage")}>
                            <Car className="h-3.5 w-3.5" /> Frais km
                          </SecondaryButton>
                        </>
                      ) : null}
                      {hasPurchaseFilters ? (
                        <SecondaryButton onClick={resetPurchasesFilters}>Réinitialiser</SecondaryButton>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto bg-white">
                  <table className="pf-data-table pf-purchases-table w-full min-w-[940px]">
                    <thead className="sticky top-0 z-10">
                      <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <th className="w-[240px] bg-[#fafbfd] px-4 py-2.5 text-left">
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={allPurchasePageSelected}
                              onChange={togglePurchasePageSelection}
                              aria-label="Sélectionner les achats de la page"
                              className="h-[15px] w-[15px] flex-shrink-0 rounded border-[#cbd5e1] accent-[#15803d]"
                            />
                            <PurchaseColumnHeader
                              sortKey="supplier"
                              sortState={purchaseSortState}
                              onSort={togglePurchaseSort}
                            >
                              Fournisseur
                            </PurchaseColumnHeader>
                          </div>
                        </th>
                        {[
                          { label: "Facture", sortKey: "invoice" as PurchaseSortKey },
                          { label: "Paiement", sortKey: "payment" as PurchaseSortKey },
                          { label: "Montant", sortKey: "amount" as PurchaseSortKey },
                          { label: "Statut", sortKey: "status" as PurchaseSortKey },
                        ].map((column) => (
                          <th
                            key={column.sortKey}
                            className="px-3 py-1.5 text-left"
                            style={{
                              background: "#fafbfd",
                            }}
                          >
                            <PurchaseColumnHeader
                              sortKey={column.sortKey}
                              sortState={purchaseSortState}
                              onSort={togglePurchaseSort}
                              align={column.sortKey === "amount" ? "right" : "left"}
                            >
                              {column.label}
                            </PurchaseColumnHeader>
                          </th>
                        ))}
                        <th
                          className="w-[180px] px-3 py-1.5 text-right"
                          style={{
                            fontSize: "var(--pf-app-table-header)",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            lineHeight: 1.15,
                            color: "#94a3b8",
                            background: "#fafbfd",
                          }}
                        >
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#f8f9fd]">
                      {purchasePageRows.map((item) => {
                        const workflow = workflowStatesMap[item.id];
                        const paymentPill = purchasePaymentPill(item, workflow);
                        const workflowState = String(workflow?.state || "").toLowerCase();
                        const needsCompletion = purchaseNeedsCompletion(item);
                        const cashFlow = purchaseCashFlowMeta(item);
                        const CashFlowIcon = cashFlow.icon;
                        const purchasePrimaryState =
                          needsCompletion || workflowState === "booked" || workflowState === "ready_to_pay"
                            ? ""
                            : "ready_to_pay";
                        const purchasePrimaryLabel = needsCompletion
                          ? "Compléter"
                          : workflowState === "booked"
                            ? "Ouvrir"
                            : workflowState === "ready_to_pay"
                              ? "Régler"
                              : "Prêt à payer";
                        const PurchasePrimaryIcon = needsCompletion
                          ? Pencil
                          : workflowState === "booked"
                            ? ArrowRight
                            : workflowState === "ready_to_pay"
                              ? Wallet
                              : CreditCard;
                        return (
                          <tr
                            key={item.id}
                            role="link"
                            tabIndex={0}
                            aria-label={`Ouvrir ${item.supplier_name || "cet achat"}`}
                            onClick={(event) => {
                              if (isInteractiveRowTarget(event.target)) return;
                              navigate(`${basePath}/${item.id}`);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              if (isInteractiveRowTarget(event.target)) return;
                              event.preventDefault();
                              navigate(`${basePath}/${item.id}`);
                            }}
                            className="pf-clickable-row group cursor-pointer border-l-2 border-transparent transition-colors hover:bg-[#f0fdf4]"
                          >
                            <td className="px-3 py-2.5">
                              <div className="flex min-w-0 items-center gap-3">
                                <input
                                  type="checkbox"
                                  checked={selectedPurchaseIds.has(String(item.id))}
                                  onChange={() => togglePurchaseSelection(String(item.id))}
                                  aria-label={`Sélectionner ${item.supplier_name || "cet achat"}`}
                                  className="h-[15px] w-[15px] flex-shrink-0 rounded border-[#cbd5e1] accent-[#15803d]"
                                />
                                <Link
                                  to={`${basePath}/${item.id}`}
                                  className="flex min-w-0 items-center gap-2 transition-colors hover:opacity-80"
                                  aria-label={`Ouvrir ${item.supplier_name || "cet achat"}`}
                                >
                                  <span
                                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border"
                                    style={{
                                      background: cashFlow.bg,
                                      borderColor: cashFlow.border,
                                      color: cashFlow.color,
                                    }}
                                  >
                                    <FileText className="h-3 w-3" />
                                  </span>
                                  <span className="flex min-w-0 flex-col">
                                    <span className="pf-row-title truncate" style={{ color: purchaseTheme.strong }}>
                                      {item.supplier_name || "Fournisseur"}
                                    </span>
                                    <span
                                      className="pf-row-subtitle mt-0.5 truncate"
                                      title={item.invoice_number || item.id}
                                    >
                                      {item.invoice_number || "Numéro à renseigner"}
                                    </span>
                                    <span className="pf-mobile-row-summary mt-1 flex-wrap items-center gap-1.5 text-[#64748b]">
                                      <span className="font-semibold text-[#0f172a]">
                                        {money(numericAmount(item.total_ttc), item.currency || "EUR")}
                                      </span>
                                      <span aria-hidden="true">·</span>
                                      <span>{paymentPill.label}</span>
                                      <span aria-hidden="true">·</span>
                                      <span>{purchasePaymentDateLabel(item)}</span>
                                    </span>
                                  </span>
                                </Link>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="min-w-0">
                                <div
                                  className="truncate text-[#0f172a]"
                                  style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 600 }}
                                >
                                  {formatDateFr(item.issue_date)}
                                </div>
                                <div className="pf-row-subtitle mt-0.5 truncate">
                                  Reçue {formatDateFr(item.received_at)}
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="min-w-0">
                                <div
                                  className="truncate text-[#0f172a]"
                                  style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 600 }}
                                >
                                  {purchasePaymentDateLabel(item)}
                                </div>
                                <div className="pf-row-subtitle mt-0.5 truncate" title={purchasePaymentContext(item)}>
                                  {purchasePaymentContext(item)}
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <div className="flex min-w-0 items-center justify-end gap-2">
                                <span
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
                                  style={{
                                    background: cashFlow.bg,
                                    borderColor: cashFlow.border,
                                    color: cashFlow.color,
                                  }}
                                  aria-label={cashFlow.label}
                                >
                                  <CashFlowIcon className="h-3.5 w-3.5" />
                                </span>
                                <div className="min-w-0">
                                  <div className="pf-table-amount truncate" style={{ color: cashFlow.color }}>
                                    {cashFlow.sign} {money(cashFlow.amount, item.currency || "EUR")}
                                  </div>
                                  <div className="pf-row-subtitle mt-0.5 truncate">
                                    {purchaseRemainingLabel(item, workflow)}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <StatusPill {...paymentPill} />
                                {workflowState === "reviewing" ? <StatusPill color="info" label="Revue" /> : null}
                              </div>
                            </td>
                            <td className="pf-row-actions-cell px-3 py-2.5 text-right">
                              <div className="pf-row-actions inline-flex items-center justify-end gap-2">
                                {purchasePrimaryState ? (
                                  <button
                                    type="button"
                                    onClick={() => void updatePurchaseWorkflow(item, purchasePrimaryState)}
                                    disabled={rowWorkflowBusy === `${item.id}:${purchasePrimaryState}`}
                                    className="pf-primary-row-action pf-purchase-primary-action inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] px-2.5 text-[#15803d] transition-colors hover:bg-[#dcfce7] disabled:cursor-not-allowed disabled:opacity-50"
                                    aria-label={`${purchasePrimaryLabel} ${item.supplier_name || "cet achat"}`}
                                    title={"Préparer cet achat pour le règlement fournisseur"}
                                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                                  >
                                    <PurchasePrimaryIcon className="h-3.5 w-3.5" />
                                    {purchasePrimaryLabel}
                                  </button>
                                ) : (
                                  <Link
                                    to={`${basePath}/${item.id}`}
                                    className="pf-primary-row-action pf-purchase-primary-action inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] px-2.5 text-[#15803d] transition-colors hover:bg-[#dcfce7]"
                                    aria-label={`${purchasePrimaryLabel} ${item.supplier_name || "cet achat"}`}
                                    title={needsCompletion ? "Compléter l'achat" : "Ouvrir l'achat"}
                                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                                  >
                                    <PurchasePrimaryIcon className="h-3.5 w-3.5" />
                                    {purchasePrimaryLabel}
                                  </Link>
                                )}
                                <Link
                                  to={`${basePath}/${item.id}`}
                                  className="pf-action-icon pf-action-icon--purchase shrink-0"
                                  aria-label={`${needsCompletion ? "Compléter" : "Ouvrir"} ${item.supplier_name || "cet achat"}`}
                                  title={needsCompletion ? "Compléter l'achat" : "Ouvrir l'achat"}
                                >
                                  <ArrowRight className="h-3.5 w-3.5" />
                                </Link>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <ListPagination
                page={hasClientSidePurchaseFilters ? 1 : purchasePage}
                totalItems={purchaseListTotalItems}
                pageSize={purchasePageSize}
                visibleItemsCount={purchasePageRows.length}
                pageSizeOptions={PURCHASE_PAGE_SIZE_OPTIONS}
                pageSizeAriaLabel="Achats par page"
                itemLabel="achat"
                onPageChange={setPurchasePage}
                onPageSizeChange={(nextPageSize) => {
                  setPurchasePage(1);
                  setPurchasePageSize(nextPageSize);
                }}
                action={
                  hasPurchaseFilters ? (
                    <button
                      type="button"
                      onClick={resetPurchasesFilters}
                      className="text-xs font-medium text-[#15803d] transition-colors hover:text-[#166534]"
                    >
                      Réinitialiser
                    </button>
                  ) : (
                    <span className="text-xs text-[#94a3b8]">
                      {hasClientSidePurchaseFilters ? "Filtre appliqué sur la page affichée" : "Vue achats paginée"}
                    </span>
                  )
                }
              />
            </SalesListBlock>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
      {notice ? (
        <NoticeBanner tone="success" onDismiss={() => setNotice(null)} autoDismissMs={6000}>
          {notice}
        </NoticeBanner>
      ) : null}
      {purchaseAsyncState ? (
        <NoticeBanner tone="info" title={purchaseAsyncState.title}>
          <span className="inline-flex items-center gap-2">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {purchaseAsyncState.detail}
          </span>
        </NoticeBanner>
      ) : null}
      <input
        ref={importRef}
        type="file"
        aria-label="Importer une facture fournisseur"
        accept="application/pdf,application/xml,text/xml,.pdf,.xml"
        className="hidden"
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <Card className="border-[#dbeafe] bg-[#eff6ff]">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-1.5 max-w-3xl">
            <div className="text-[#0f172a] text-[0.9375rem] font-bold">
              {isPurchasesView ? "Achats & fournisseurs" : "Réception fournisseurs"}
            </div>
            <p className="text-[#475569]" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
              {connection?.active
                ? `Réception connectée : ${(connection.providers || []).map((item: any) => item.label).join(", ") || "—"}. Suivi des factures fournisseurs, validations et principaux émetteurs.`
                : "Aucune plateforme active. Importez un PDF Factur-X ou un XML pour contrôler vos achats fournisseurs."}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <StatusPill
                color={connection?.active ? "ok" : "warn"}
                label={connection?.active ? "Réception connectée" : "Import manuel"}
              />
              <StatusPill
                color={invalidCount > 0 ? "danger" : "muted"}
                label={invalidCount > 0 ? `${invalidCount} invalide(s)` : "Aucune erreur critique"}
              />
              {totals.latest_received_at ? (
                <StatusPill color="info" label={`Dernière réception ${formatDateTimeFr(totals.latest_received_at)}`} />
              ) : null}
              {isPurchasesView ? (
                <StatusPill color={readyToPayCount > 0 ? "purple" : "muted"} label={`${readyToPayCount} à payer`} />
              ) : null}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap xl:justify-end">
            <PrimaryButton disabled={busyImport} onClick={() => importRef.current?.click()}>
              <Upload className="w-3.5 h-3.5" /> {busyImport ? "Import…" : "Importer"}
            </PrimaryButton>
            <ActionMenu label="Plus">
              <ActionMenuButton
                icon={Download}
                onClick={() => void downloadPurchasesExport()}
                aria-label={purchaseExportLabel}
                title={purchaseExportTitle}
              >
                {purchaseExportBusy ? "Export en cours..." : purchaseExportLabel}
              </ActionMenuButton>
              <ActionMenuButton icon={RefreshCw} onClick={() => setReloadKey((current) => current + 1)}>
                Rafraîchir
              </ActionMenuButton>
              {!connection?.active ? (
                <ActionMenuLink to="/app/einvoicing" icon={Globe}>
                  Configurer la plateforme
                </ActionMenuLink>
              ) : null}
            </ActionMenu>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          label="Factures reçues"
          value={Number(totals.count || 0)}
          sub="Selon les filtres"
          accent="blue"
          icon={<Inbox className="w-4 h-4" />}
        />
        <StatCard
          label="À traiter"
          value={receivedCount}
          sub="Statut reçue"
          accent="amber"
          icon={<Mail className="w-4 h-4" />}
        />
        <StatCard
          label={isPurchasesView ? "En revue" : "Validation KO"}
          value={isPurchasesView ? reviewingCount : invalidCount}
          sub={isPurchasesView ? "Circuit achat" : "Structure à corriger"}
          accent={isPurchasesView ? "amber" : "red"}
          icon={isPurchasesView ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
        />
        <StatCard
          label={isPurchasesView ? "À payer" : "30 jours"}
          value={isPurchasesView ? readyToPayCount : money(totals.last_30_days_ttc || 0)}
          sub={isPurchasesView ? "Prêts à payer" : `${Number(totals.last_30_days_count || 0)} facture(s)`}
          accent={isPurchasesView ? "cyan" : "green"}
          icon={isPurchasesView ? <Check className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
        />
      </div>

      <div className="space-y-4">
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="grid md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
              <div className="flex items-center gap-2 px-3 py-2 border border-[#e2e8f0] rounded-xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <Search className="w-4 h-4 text-[#94a3b8]" />
                <input
                  placeholder="Fournisseur, n° facture, SIREN…"
                  className="outline-none bg-transparent text-[#374151] placeholder:text-[#94a3b8] flex-1 text-sm"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <SecondaryButton onClick={() => setShowFilters((value) => !value)}>
                <SlidersHorizontal className="w-3.5 h-3.5" /> {showFilters ? "Masquer les filtres" : "Filtres"}
              </SecondaryButton>
            </div>

            {showFilters ? (
              <div className="grid md:grid-cols-2 gap-3">
                <SelectField
                  label="Statut"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Validation"
                  value={validationFilter}
                  onChange={(event) => setValidationFilter(event.target.value)}
                >
                  {validationOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectField>
              </div>
            ) : null}
          </div>

          {loading ? (
            <LoadingCard label="Chargement des achats fournisseurs…" />
          ) : items.length === 0 ? (
            <SectionEmpty
              title="Aucune facture fournisseur"
              description="Importe un Factur-X ou configure une plateforme pour centraliser les achats et leur validation."
              href={connection?.active ? undefined : "/app/einvoicing"}
              cta={connection?.active ? undefined : "Configurer la plateforme"}
            />
          ) : isPurchasesView ? (
            <DataTable headers={["Fournisseur", "Réception", "Montant", "Prochaine étape", "Action"]}>
              {items.map((item) => {
                const workflow = workflowStatesMap[item.id];
                const guidance = purchaseOpsGuidance(item, workflow);
                return (
                  <tr
                    key={item.id}
                    role="link"
                    tabIndex={0}
                    aria-label={`Ouvrir ${item.supplier_name || "achat"}`}
                    onClick={(event) => {
                      if (isInteractiveRowTarget(event.target)) return;
                      navigate(`${basePath}/${item.id}`);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      if (isInteractiveRowTarget(event.target)) return;
                      event.preventDefault();
                      navigate(`${basePath}/${item.id}`);
                    }}
                    className="pf-clickable-row transition-colors hover:bg-[#f8fafc]"
                  >
                    <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                      <div>{item.supplier_name || "Fournisseur"}</div>
                      <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem", fontWeight: 500 }}>
                        {item.invoice_number || item.id} ·{" "}
                        {item.supplier_siret || item.supplier_siren || prettyProvider(item.provider_slug)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[#64748b] text-xs">
                      <div>{formatDateTimeFr(item.received_at)}</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <StatusPill {...validationPill(item.validation_status)} />
                        <StatusPill {...purchaseWorkflowPill(workflow)} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[#374151] text-sm">
                      <div style={{ fontWeight: 700, color: "#0f172a" }}>
                        {money(item.total_ttc, item.currency || "EUR")}
                      </div>
                      <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                        {titleCase(item.format || "—")} · {inboxStatusPill(item.status).label}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[#64748b] text-xs leading-relaxed">
                      <div className="text-[#0f172a]" style={{ fontWeight: 700 }}>
                        {guidance.title}
                      </div>
                      <div className="text-[#64748b]">{guidance.description}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`${basePath}/${item.id}`}
                        className="text-[#1d4ed8] hover:text-[#1e40af] text-xs font-semibold"
                      >
                        Ouvrir
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          ) : (
            <DataTable
              headers={[
                "Fournisseur",
                "Facture",
                "Réception",
                "Total TTC",
                "Format",
                "Statut",
                "Validation",
                "Traitement",
                "Action",
              ]}
            >
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                  <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                    {item.supplier_name || "Fournisseur"}
                    <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem", fontWeight: 500 }}>
                      {item.supplier_siret || item.supplier_siren || prettyProvider(item.provider_slug)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[#374151] text-sm">{item.invoice_number || item.id}</td>
                  <td className="px-4 py-3 text-[#64748b] text-xs">
                    <div>{formatDateTimeFr(item.received_at)}</div>
                    <div className="text-[#cbd5e1]">Émise le {formatDateFr(item.issue_date)}</div>
                  </td>
                  <td className="px-4 py-3 text-[#374151] text-sm">{money(item.total_ttc, item.currency || "EUR")}</td>
                  <td className="px-4 py-3 text-[#64748b] text-xs">{titleCase(item.format || "—")}</td>
                  <td className="px-4 py-3">
                    <StatusPill {...inboxStatusPill(item.status)} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill {...validationPill(item.validation_status)} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill {...purchaseWorkflowPill(workflowStatesMap[item.id])} />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to={`${basePath}/${item.id}`}
                      className="text-[#1d4ed8] hover:text-[#1e40af] text-xs font-semibold"
                    >
                      Ouvrir
                    </Link>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      </div>
    </>
  );
}

function InboxDetailView({
  invoiceId,
  onPurchaseHeaderReadiness,
}: {
  invoiceId: string;
  onPurchaseHeaderReadiness?: (readiness: any) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const purchaseProofInputRef = useRef<HTMLInputElement | null>(null);
  const completionDraftBaselineRef = useRef("");
  const { user } = useSession();
  const isPurchasesView = location.pathname.startsWith("/app/purchases");
  const basePath = isPurchasesView ? "/app/purchases" : "/app/inbox";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [item, setItem] = useState<any>(null);
  const [workflow, setWorkflow] = useState<any>(null);
  const [workflowDraft, setWorkflowDraft] = useState<any>({ state: "reviewing", owner_role: "accountant", note: "" });
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [completionDraft, setCompletionDraft] = useState<any>(() => createPurchaseCompletionDraft());
  const [completionBusy, setCompletionBusy] = useState<"save" | "validate" | null>(null);
  const [purchaseEditMode, setPurchaseEditMode] = useState(false);
  const [supplierQuery, setSupplierQuery] = useState("");
  const [supplierOptions, setSupplierOptions] = useState<any[]>([]);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [supplierSaving, setSupplierSaving] = useState(false);
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [employeePayerOptions, setEmployeePayerOptions] = useState<any[]>([]);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [employeeModalOpen, setEmployeeModalOpen] = useState(false);
  const [employeeDraft, setEmployeeDraft] = useState<any>(() => createPurchaseEmployeePayerDraft());
  const [employeeSaving, setEmployeeSaving] = useState(false);
  const [supplierPaymentModalOpen, setSupplierPaymentModalOpen] = useState(false);
  const [supplierPaymentDraft, setSupplierPaymentDraft] = useState<any>(() => createPurchasePaymentDraft());
  const [supplierPaymentSaving, setSupplierPaymentSaving] = useState(false);
  const [autoClassifyBusy, setAutoClassifyBusy] = useState(false);
  const [supplierPayments, setSupplierPayments] = useState<any[]>([]);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [pdfPreviewError, setPdfPreviewError] = useState<string | null>(null);
  const [purchasePreviewKind, setPurchasePreviewKind] = useState<"pdf" | "image" | null>(null);
  const [purchaseProofUploading, setPurchaseProofUploading] = useState(false);
  const [purchaseDownloadBusy, setPurchaseDownloadBusy] = useState<string | null>(null);
  const [purchaseAttachmentBusy, setPurchaseAttachmentBusy] = useState<string | null>(null);
  const [purchaseReplaceAttachmentId, setPurchaseReplaceAttachmentId] = useState<string | null>(null);
  const [selectedPurchaseAttachmentId, setSelectedPurchaseAttachmentId] = useState<string | null>(null);

  useEffect(() => {
    if (!onPurchaseHeaderReadiness) return;
    if (!isPurchasesView) {
      onPurchaseHeaderReadiness(null);
      return;
    }
    onPurchaseHeaderReadiness(item?.accounting_readiness || null);
    return () => onPurchaseHeaderReadiness(null);
  }, [isPurchasesView, item?.accounting_readiness, onPurchaseHeaderReadiness]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, workflowData, paymentsData] = await Promise.all([
        readJson(`/api/inbox/${invoiceId}`),
        isPurchasesView ? readJson(`/api/ops/purchase-workflow/${invoiceId}`) : Promise.resolve(null),
        isPurchasesView ? readJson(`/api/inbox/${invoiceId}/payments`) : Promise.resolve([]),
      ]);
      const serverCompletionDraft = createPurchaseCompletionDraft(data || {});
      const serverCompletionSnapshot = JSON.stringify(serverCompletionDraft);
      const localCompletionDraft = isPurchasesView
        ? readLocalDraft(localDraftKey(PURCHASE_COMPLETION_DRAFT_PREFIX, invoiceId), PURCHASE_COMPLETION_DRAFT_VERSION)
        : null;
      const restoredCompletionDraft =
        localCompletionDraft?.draft && typeof localCompletionDraft.draft === "object"
          ? { ...serverCompletionDraft, ...localCompletionDraft.draft }
          : serverCompletionDraft;

      completionDraftBaselineRef.current = serverCompletionSnapshot;
      setItem(data || null);
      setCompletionDraft(restoredCompletionDraft);
      if (
        localCompletionDraft?.draft &&
        typeof localCompletionDraft.draft === "object" &&
        JSON.stringify(restoredCompletionDraft) !== serverCompletionSnapshot
      ) {
        setNotice((current) => current || "Brouillon local restauré.");
      }
      setSupplierPaymentDraft(createPurchasePaymentDraft(data || {}));
      setSupplierPayments(Array.isArray(paymentsData) ? paymentsData : []);
      setPurchaseEditMode(false);
      setSupplierQuery(data?.supplier_name || "");
      setEmployeeQuery(data?.employee_payer_name || "");
      if (data?.employee_payer_name) {
        setEmployeePayerOptions((prev) =>
          normalizePurchaseRecentList([
            ...prev.map((entry) => entry?.name || entry),
            String(data.employee_payer_name).trim(),
          ])
            .filter(Boolean)
            .map((name) => ({ name })),
        );
      }
      setWorkflow(workflowData || null);
      if (workflowData) {
        setWorkflowDraft({
          state: workflowData.state || "reviewing",
          owner_role: workflowData.owner_role || "accountant",
          note: workflowData.note || "",
        });
      }
    } catch (err) {
      setItem(null);
      setWorkflow(null);
      setError(formatApiError(err, "Impossible de charger la facture reçue."));
    } finally {
      setLoading(false);
    }
  }, [invoiceId, isPurchasesView]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isPurchasesView || loading || !item?.id) return;
    const key = localDraftKey(PURCHASE_COMPLETION_DRAFT_PREFIX, String(item.id));
    const timer = window.setTimeout(() => {
      const serialized = JSON.stringify(completionDraft);
      if (!serialized || serialized === completionDraftBaselineRef.current) {
        removeLocalDraft(key);
        return;
      }
      writeLocalDraft(key, {
        version: PURCHASE_COMPLETION_DRAFT_VERSION,
        item_id: item.id,
        draft: completionDraft,
        saved_at: new Date().toISOString(),
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [completionDraft, isPurchasesView, item?.id, loading]);

  useEffect(() => {
    if (!isPurchasesView) return;
    let alive = true;
    const query = encodeURIComponent(employeeQuery || completionDraft.employee_payer_name || "");
    readJson(`/api/inbox/employee-payers?q=${query}&limit=12`)
      .then((payload) => {
        if (alive) setEmployeePayerOptions(Array.isArray(payload?.items) ? payload.items : []);
      })
      .catch(() => {
        if (alive) setEmployeePayerOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [completionDraft.employee_payer_name, employeeQuery, isPurchasesView]);

  useEffect(() => {
    if (!isPurchasesView || !item) return;
    let alive = true;
    const query = encodeURIComponent(supplierQuery || completionDraft.supplier_name || "");
    readJson(`/api/inbox/suppliers?q=${query}&limit=12`)
      .then((payload) => {
        if (!alive) return;
        setSupplierOptions(Array.isArray(payload?.items) ? payload.items : []);
      })
      .catch(() => {
        if (alive) setSupplierOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [completionDraft.supplier_name, isPurchasesView, item, supplierQuery]);

  useEffect(() => {
    if (!isPurchasesView || !item) {
      setPdfPreviewUrl(null);
      setPdfPreviewError(null);
      setPurchasePreviewKind(null);
      return;
    }
    const previewableAttachments = (item.attachments || []).filter((attachment: any) => {
      const kind = String(attachment.kind || "").toLowerCase();
      return kind === "pdf" || ["png", "jpg", "jpeg", "webp"].includes(kind);
    });
    const previewAttachment =
      previewableAttachments.find((attachment: any) => String(attachment.id) === selectedPurchaseAttachmentId) ||
      previewableAttachments[0];
    if (!previewAttachment) {
      setPdfPreviewUrl(null);
      setPdfPreviewError(null);
      setPurchasePreviewKind(null);
      return;
    }
    const previewKind = String(previewAttachment.kind || "").toLowerCase() === "pdf" ? "pdf" : "image";
    let alive = true;
    let objectUrl: string | null = null;
    setPdfPreviewError(null);
    setPurchasePreviewKind(previewKind);
    rawApi(`/api/inbox/${item.id}/attachments/${previewAttachment.id}?inline=1`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Aperçu indisponible.");
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (alive) setPdfPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (alive) {
          setPdfPreviewUrl(null);
          setPurchasePreviewKind(null);
          setPdfPreviewError("Aperçu indisponible. Télécharge la pièce jointe pour la consulter.");
        }
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isPurchasesView, item, selectedPurchaseAttachmentId]);

  useEffect(() => {
    if (!purchaseReplaceAttachmentId || typeof window === "undefined") return;
    const clearReplaceModeIfPickerWasCancelled = () => {
      window.setTimeout(() => {
        if (!purchaseProofInputRef.current?.files?.length) {
          setPurchaseReplaceAttachmentId(null);
        }
      }, 250);
    };
    window.addEventListener("focus", clearReplaceModeIfPickerWasCancelled);
    return () => window.removeEventListener("focus", clearReplaceModeIfPickerWasCancelled);
  }, [purchaseReplaceAttachmentId]);

  const canReply =
    !!item?.external_message_id &&
    !!item?.provider_slug &&
    !["manual_import", "dummy", "mock"].includes((item?.provider_slug || "").toLowerCase());
  const guidance = purchaseOpsGuidance(item, workflow);
  const statusPill = inboxStatusPill(item?.status);
  const currentValidationPill = validationPill(item?.validation_status);
  const currentWorkflowPill = purchaseWorkflowPill(workflow);
  const summaryCards: Array<{
    label: string;
    value: string;
    sub?: string;
    accent: PurchaseSummaryAccent;
    icon?: ReactNode;
  }> = item
    ? [
        {
          label: "Statut",
          value: statusPill.label,
          sub: prettyProvider(item.provider_slug),
          accent: purchaseSummaryAccent(statusPill.color),
          icon: <Inbox className="h-3.5 w-3.5" />,
        },
        {
          label: "Validation",
          value: currentValidationPill.label,
          sub: item.facturx_profile ? `Profil ${item.facturx_profile}` : "Profil non détecté",
          accent: purchaseSummaryAccent(currentValidationPill.color),
          icon: <CheckCircle className="h-3.5 w-3.5" />,
        },
        {
          label: "Total TTC",
          value: money(item.total_ttc, item.currency || "EUR"),
          sub: `Émise le ${formatDateFr(item.issue_date)}`,
          accent: "blue",
          icon: <FileText className="h-3.5 w-3.5" />,
        },
        {
          label: "Réception",
          value: formatDateTimeFr(item.received_at),
          sub: item.invoice_number || item.id,
          accent: "purple",
          icon: <Mail className="h-3.5 w-3.5" />,
        },
        ...(isPurchasesView
          ? [
              {
                label: "Traitement achat",
                value: currentWorkflowPill.label,
                sub: workflow?.owner_role ? `Responsable ${titleCase(workflow.owner_role)}` : "Aucun pilote",
                accent: purchaseSummaryAccent(currentWorkflowPill.color),
                icon: <Check className="h-3.5 w-3.5" />,
              },
            ]
          : []),
      ]
    : [];
  const detailRows = item
    ? [
        ["Fournisseur", item.supplier_name || "—"],
        ["SIREN / SIRET", `${item.supplier_siren || "—"}${item.supplier_siret ? ` / ${item.supplier_siret}` : ""}`],
        ["Numéro facture", item.invoice_number || "—"],
        ["Format", titleCase(item.format || "—")],
        ["Montant HT", money(item.total_ex_vat, item.currency || "EUR")],
        ["Montant TVA", money(item.total_vat, item.currency || "EUR")],
      ]
    : [];

  const uploadPurchaseAttachment = async (
    file: File | null | undefined,
    options: {
      reload?: boolean;
      notice?: boolean;
      showBusy?: boolean;
      resetMessages?: boolean;
      throwOnError?: boolean;
    } = {},
  ) => {
    if (!item || !isPurchasesView || !file) return null;
    const showBusy = options.showBusy !== false;
    if (showBusy) setPurchaseProofUploading(true);
    if (options.resetMessages !== false) {
      setError(null);
      setNotice(null);
    }
    try {
      const body = new FormData();
      body.append("file", file);
      const uploaded: any = await apiFetch(`/api/inbox/${item.id}/attachments`, { method: "POST", body });
      if (uploaded?.id) setSelectedPurchaseAttachmentId(String(uploaded.id));
      if (options.reload !== false) await load();
      if (options.notice !== false) setNotice("Justificatif joint au dossier achat.");
      return uploaded;
    } catch (err) {
      const message = formatApiError(err, "Impossible de joindre le justificatif.");
      if (options.throwOnError) throw new Error(message);
      setError(message);
      return null;
    } finally {
      if (showBusy) setPurchaseProofUploading(false);
    }
  };

  const handlePurchaseProofFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    event.target.value = "";
    if (!file) {
      setPurchaseReplaceAttachmentId(null);
      return;
    }
    if (purchaseReplaceAttachmentId) {
      const attachmentId = purchaseReplaceAttachmentId;
      setPurchaseReplaceAttachmentId(null);
      void replacePurchaseAttachment(attachmentId, file);
      return;
    }
    void uploadPurchaseAttachment(file);
  };

  const downloadPurchaseAttachment = async (attachment: any, filename: string, openInNewTab = false) => {
    if (!item || !attachment?.id) return;
    const attachmentId = String(attachment.id);
    setPurchaseDownloadBusy(attachmentId);
    setError(null);
    try {
      await downloadProtectedFile(`/api/inbox/${item.id}/attachments/${attachmentId}`, filename, openInNewTab);
      setNotice(openInNewTab ? "Ouverture du justificatif lancée." : "Téléchargement du justificatif lancé.");
    } catch (err) {
      setError(formatApiError(err, "Téléchargement du justificatif impossible."));
    } finally {
      setPurchaseDownloadBusy(null);
    }
  };

  const deletePurchaseAttachment = async (
    attachment: any,
    options: { confirm?: boolean; reload?: boolean; notice?: boolean } = {},
  ) => {
    if (!item || !attachment?.id) return false;
    const attachmentId = String(attachment.id);
    if (
      options.confirm !== false &&
      !window.confirm(
        "Supprimer ce justificatif du dossier achat ? S'il contient plusieurs pages, elles seront toutes retirées.",
      )
    ) {
      return false;
    }
    setPurchaseAttachmentBusy(attachmentId);
    setError(null);
    try {
      await apiFetch(`/api/inbox/${item.id}/attachments/${attachmentId}`, { method: "DELETE" });
      if (selectedPurchaseAttachmentId === attachmentId) setSelectedPurchaseAttachmentId(null);
      if (options.reload !== false) await load();
      if (options.notice !== false) setNotice("Justificatif supprimé.");
      return true;
    } catch (err) {
      setError(formatApiError(err, "Suppression du justificatif impossible."));
      return false;
    } finally {
      setPurchaseAttachmentBusy(null);
    }
  };

  const replacePurchaseAttachment = async (attachmentId: string, file: File) => {
    if (!item) return;
    const previous = (item.attachments || []).find((attachment: any) => String(attachment.id) === attachmentId);
    if (!previous) {
      void uploadPurchaseAttachment(file);
      return;
    }
    setPurchaseAttachmentBusy(attachmentId);
    setPurchaseProofUploading(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const replaced: any = await apiFetch(`/api/inbox/${item.id}/attachments/${attachmentId}`, {
        method: "PUT",
        body,
      });
      setSelectedPurchaseAttachmentId(String(replaced?.id || attachmentId));
      setNotice("Justificatif remplacé.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Remplacement du justificatif impossible."));
    } finally {
      setPurchaseAttachmentBusy(null);
      setPurchaseProofUploading(false);
    }
  };

  const saveWorkflow = async () => {
    if (!item || !isPurchasesView) return;
    if (workflowDraft.state === "booked") {
      setError("Enregistre le règlement fournisseur pour passer cet achat en payé.");
      return;
    }
    setWorkflowBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data: any = await api(`/api/ops/purchase-workflow/${item.id}`, {
        method: "POST",
        body: JSON.stringify(workflowDraft),
      }).then((res: any) => res);
      setWorkflow(data || null);
      setWorkflowDraft({
        state: data?.state || workflowDraft.state || "reviewing",
        owner_role: data?.owner_role || workflowDraft.owner_role || "accountant",
        note: data?.note || workflowDraft.note || "",
      });
      setNotice("Traitement achat mis à jour.");
    } catch (err) {
      setError(formatApiError(err, "Impossible de mettre à jour le traitement achat."));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const autoClassifyPurchaseAccounting = async () => {
    if (!item || !isPurchasesView) return;
    setAutoClassifyBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/inbox/${item.id}/accounting/auto-classify`, { method: "POST" });
      setNotice(result?.message || "Catégorisation compta mise à jour.");
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible de classer automatiquement cet achat."));
    } finally {
      setAutoClassifyBusy(false);
    }
  };

  const updateCompletionDraft = (patch: Record<string, any>) => {
    setCompletionDraft((prev: any) => ({ ...prev, ...patch }));
  };

  const updateCompletionPurchaseLines = (lines: any[]) => {
    const totals = normalizePurchaseLineDrafts(lines);
    updateCompletionDraft({
      purchase_lines: lines,
      ...(totals.lines.length
        ? {
            total_ex_vat: purchaseAmountToInput(totals.total_ex_vat),
            total_vat: purchaseAmountToInput(totals.total_vat),
            total_ttc: purchaseAmountToInput(totals.total_ttc),
            ...(tracksEmployeePayment && !completionDraft.employee_reimbursement_amount
              ? { employee_reimbursement_amount: purchaseAmountToInput(totals.total_ttc) }
              : {}),
          }
        : {}),
    });
  };

  const updateEmployeePaymentMode = (enabled: boolean) => {
    updateCompletionDraft({
      paid_by_employee: enabled,
      employee_payer_role: enabled ? completionDraft.employee_payer_role || "manager" : "manager",
      employee_reimbursement_amount: enabled
        ? completionDraft.employee_reimbursement_amount || completionDraft.total_ttc
        : "",
      employee_reimbursement_due_date: enabled
        ? completionDraft.employee_reimbursement_due_date || completionDraft.planned_payment_date
        : "",
      employee_reimbursement_method: enabled
        ? completionDraft.employee_reimbursement_method || "bank_transfer"
        : "bank_transfer",
      employee_reimbursement_status: enabled
        ? completionDraft.employee_reimbursement_status || "to_reimburse"
        : "to_reimburse",
    });
  };

  const rememberSupplierName = async (name: string) => {
    const clean = String(name || "").trim();
    if (!clean) return;
    setSupplierSaving(true);
    try {
      const payload: any = await api("/api/inbox/suppliers", {
        method: "POST",
        body: JSON.stringify({
          name: clean,
          supplier_siren: completionDraft.supplier_siren || null,
          supplier_siret: completionDraft.supplier_siret || null,
          accounting_account: completionDraft.accounting_account || null,
          payment_delay_days: completionDraft.payment_delay_days ? Number(completionDraft.payment_delay_days) : null,
          purchase_nature: completionDraft.purchase_nature || null,
          vat_rate: purchaseDefaultVatRateFromDraft(completionDraft),
        }),
      });
      const item = payload?.item;
      if (item?.supplier_name) {
        setSupplierOptions((prev) => [
          item,
          ...prev.filter(
            (entry) =>
              purchaseSupplierName(entry).toLocaleLowerCase("fr-FR") !==
              String(item.supplier_name).toLocaleLowerCase("fr-FR"),
          ),
        ]);
        setSupplierQuery(item.supplier_name);
        applySupplierOption(item.supplier_name, item);
      }
      setNotice("Fournisseur ajouté au référentiel.");
    } catch (err) {
      setError(formatApiError(err, "Impossible d'ajouter le fournisseur."));
    } finally {
      setSupplierSaving(false);
    }
  };

  const rememberEmployeePayer = async (name: string, overrides: any = {}) => {
    const clean = String(name || overrides?.name || "").trim();
    if (!clean) return;
    try {
      const payload: any = await api("/api/inbox/employee-payers", {
        method: "POST",
        body: JSON.stringify({
          name: clean,
          role: overrides.role || completionDraft.employee_payer_role || "manager",
          user_label: overrides.user_label || null,
          accounting_account: overrides.accounting_account || completionDraft.accounting_account || null,
          reimbursement_method:
            overrides.reimbursement_method || completionDraft.employee_reimbursement_method || "bank_transfer",
          vehicle_type: overrides.vehicle_type || null,
          fiscal_power: overrides.fiscal_power || null,
          notes: overrides.notes || null,
        }),
      });
      const item = payload?.item;
      if (item?.name) {
        setEmployeePayerOptions((prev) => [
          item,
          ...prev.filter((entry) => employeePayerName(entry).toLowerCase() !== String(item.name).toLowerCase()),
        ]);
        setEmployeeQuery(item.name);
      }
      setNotice("Salarié ou dirigeant ajouté au référentiel.");
      return item;
    } catch (err) {
      setError(formatApiError(err, "Impossible d'ajouter la personne."));
      return null;
    }
  };

  const updateIssueDate = (value: string) => {
    const delay = String(completionDraft.payment_delay_days || "").trim();
    const patch: Record<string, any> = { issue_date: value };
    if (delay) {
      patch.planned_payment_date = addDaysToIsoDate(value, Number(delay));
      if (completionDraft.paid_by_employee && !completionDraft.employee_reimbursement_due_date) {
        patch.employee_reimbursement_due_date = patch.planned_payment_date;
      }
    }
    updateCompletionDraft(patch);
  };

  const updatePlannedPaymentDate = (value: string) => {
    updateCompletionDraft({
      planned_payment_date: value,
      payment_delay_days: purchasePaymentDelayDays(
        completionDraft.issue_date || purchaseIsoDate(item?.issue_date),
        value,
      ),
    });
  };

  const applySupplierOption = (name: string, forcedOption?: any) => {
    const option =
      forcedOption ||
      supplierOptions.find(
        (entry) => purchaseSupplierName(entry).toLocaleLowerCase("fr-FR") === name.toLocaleLowerCase("fr-FR"),
      );
    const delay = option?.default_payment_delay_days;
    const patch: Record<string, any> = {
      supplier_name: name,
    };
    if (option) {
      patch.supplier_siren = option?.supplier_siren || "";
      patch.supplier_siret = option?.supplier_siret || "";
      if (option?.default_accounting_account) patch.accounting_account = option.default_accounting_account;
      if (option?.default_purchase_nature) patch.purchase_nature = option.default_purchase_nature;
      const nextLines = applyPurchaseSupplierVatRulesToLines(completionDraft.purchase_lines, option);
      const supplierVatRate =
        nextLines
          .map((line: any) => purchaseVatRateValue(line?.vat_rate))
          .find((rate: number | null) => rate !== null) ?? purchaseVatRateValue(option?.default_vat_rate);
      if (
        supplierVatRate !== null ||
        option?.default_accounting_account ||
        option?.default_purchase_nature ||
        purchaseSupplierVatRules(option).length
      ) {
        const total = parsePurchaseAmount(completionDraft.total_ttc);
        const existingVat = parsePurchaseAmount(completionDraft.total_vat);
        if (supplierVatRate !== null && total !== null && total > 0 && (existingVat === null || existingVat <= 0)) {
          const derived = derivePurchaseHtVatFromTtc(total, supplierVatRate);
          if (nextLines.length === 1) {
            nextLines[0] = {
              ...nextLines[0],
              total_ex_vat: derived.total_ex_vat,
              total_vat: derived.total_vat,
              vat_rate: purchaseAmountToInput(supplierVatRate),
            };
          }
          patch.purchase_lines = nextLines;
          patch.total_ex_vat = derived.total_ex_vat;
          patch.total_vat = derived.total_vat;
        } else {
          const lineTotals = normalizePurchaseLineDrafts(nextLines);
          patch.purchase_lines = nextLines;
          if (lineTotals.lines.length) {
            patch.total_ex_vat = purchaseAmountToInput(lineTotals.total_ex_vat);
            patch.total_vat = purchaseAmountToInput(lineTotals.total_vat);
            patch.total_ttc = purchaseAmountToInput(lineTotals.total_ttc);
          }
        }
      }
      if (delay !== null && delay !== undefined && delay !== "") {
        patch.payment_delay_days = String(delay);
        patch.planned_payment_date = addDaysToIsoDate(
          completionDraft.issue_date || purchaseIsoDate(item?.issue_date),
          Number(delay),
        );
      }
    }
    updateCompletionDraft(patch);
    setSupplierQuery(name);
    setSupplierPickerOpen(false);
  };

  const updatePlannedPaymentDelayInput = (value: string) => {
    const normalized = value.replace(/[^\d]/g, "").slice(0, 3);
    const patch: Record<string, any> = { payment_delay_days: normalized };
    if (normalized) {
      patch.planned_payment_date = addDaysToIsoDate(
        completionDraft.issue_date || purchaseIsoDate(item?.issue_date),
        Number(normalized),
      );
    }
    updateCompletionDraft(patch);
  };

  const currentUserLabel = String((user as any)?.name || (user as any)?.email || "").trim();

  const addEmployeePayerOption = async () => {
    const name = String(completionDraft.employee_payer_name || employeeQuery || "").trim();
    if (!name) return;
    setEmployeeSaving(true);
    const item = await rememberEmployeePayer(name, {
      name,
      role: completionDraft.employee_payer_role || "manager",
      user_label: currentUserLabel,
      accounting_account: completionDraft.accounting_account,
      reimbursement_method: completionDraft.employee_reimbursement_method || "bank_transfer",
    });
    if (item?.name) {
      applyEmployeePayerOption(item.name, item);
    }
    setEmployeeSaving(false);
  };

  const saveEmployeePayerReference = async () => {
    setEmployeeSaving(true);
    const item = await rememberEmployeePayer(employeeDraft.name, employeeDraft);
    if (item?.name) {
      applyEmployeePayerOption(item.name, item);
      setEmployeeModalOpen(false);
    }
    setEmployeeSaving(false);
  };

  const applyEmployeePayerOption = (name: string, forcedOption?: any) => {
    const option = forcedOption || employeePayerOptions.find((entry) => employeePayerName(entry) === name);
    updateCompletionDraft({
      employee_payer_name: name,
      employee_payer_role: option?.role || completionDraft.employee_payer_role || "manager",
      employee_reimbursement_method:
        option?.reimbursement_method || completionDraft.employee_reimbursement_method || "bank_transfer",
      accounting_account: option?.default_accounting_account || completionDraft.accounting_account,
    });
    setEmployeeQuery(name);
    setEmployeePickerOpen(false);
  };

  const canRememberSupplier = Boolean(String(completionDraft.supplier_name || "").trim());
  const canRememberEmployeePayer = Boolean(String(completionDraft.employee_payer_name || "").trim());
  const purchaseAttachments = Array.isArray(item?.attachments) ? item.attachments : [];
  const purchaseProofAttachment = purchaseAttachments.find((attachment: any) =>
    ["pdf", "xml", "png", "jpg", "jpeg", "webp"].includes(String(attachment.kind || "").toLowerCase()),
  );
  const selectedPurchaseAttachment =
    purchaseAttachments.find((attachment: any) => String(attachment.id) === selectedPurchaseAttachmentId) ||
    purchaseProofAttachment ||
    purchaseAttachments[0] ||
    null;
  const pdfAttachment = purchaseAttachments.find(
    (attachment: any) => String(attachment.kind || "").toLowerCase() === "pdf",
  );
  const purchaseKind = item ? purchaseKindKey(item) : "invoice";
  const isMileagePurchase = purchaseKind === "mileage";
  const isExpenseReportPurchase = purchaseKind === "expense_report";
  const hasSupplier = Boolean(String(completionDraft.supplier_name || "").trim());
  const hasEmployeePayer = Boolean(String(completionDraft.employee_payer_name || "").trim());
  const tracksEmployeePayment = Boolean(completionDraft.paid_by_employee);
  const employeeMarkedNotReimbursable =
    tracksEmployeePayment &&
    String(completionDraft.employee_reimbursement_status || "").toLowerCase() === "not_reimbursed";
  const completionPurchaseLines = normalizePurchaseLineDrafts(completionDraft.purchase_lines);
  const hasCompletionPurchaseLines = completionPurchaseLines.lines.length > 0;
  const completionLinesAccountingReady =
    hasCompletionPurchaseLines &&
    completionPurchaseLines.lines.every((line) => purchaseAccountingAccountReady(line.accounting_account));
  const completionLinesVatRateMissing = (
    Array.isArray(completionDraft.purchase_lines) ? completionDraft.purchase_lines : []
  ).some((line: any) => !String(line?.vat_rate || "").trim());
  const completionTotalTtcValue = hasCompletionPurchaseLines
    ? completionPurchaseLines.total_ttc
    : parsePurchaseAmount(completionDraft.total_ttc);
  const completionTotalVatValue = hasCompletionPurchaseLines
    ? completionPurchaseLines.total_vat
    : parsePurchaseAmount(completionDraft.total_vat);
  const completionTotalHtValue = hasCompletionPurchaseLines
    ? completionPurchaseLines.total_ex_vat
    : parsePurchaseAmount(completionDraft.total_ex_vat);
  const completionTotalTtc = Number(completionTotalTtcValue ?? 0);
  const completionTotalVat = Number(completionTotalVatValue ?? 0);
  const completionTotalTtcMissing =
    completionTotalTtcValue === null || !Number.isFinite(completionTotalTtc) || completionTotalTtc < 0;
  const completionAmountsIncoherent = hasCompletionPurchaseLines
    ? false
    : !purchaseAmountsAreCoherent(completionTotalTtcValue, completionTotalHtValue, completionTotalVatValue);
  const completionHeaderZeroVatMissing =
    !hasCompletionPurchaseLines && completionTotalTtc > 0 && completionTotalVat === 0;
  const completionLinesZeroVatMissing = completionPurchaseLines.lines.some((line: any) =>
    purchaseLineZeroVatNeedsReason(line),
  );
  const completionZeroVatMissing = completionHeaderZeroVatMissing || completionLinesZeroVatMissing;

  const completionMissingFields = item
    ? [
        !hasSupplier ? "fournisseur" : null,
        tracksEmployeePayment && !employeeMarkedNotReimbursable && !hasEmployeePayer ? "personne à rembourser" : null,
        !isMileagePurchase && !isExpenseReportPurchase && !String(completionDraft.invoice_number || "").trim()
          ? "numéro"
          : null,
        !completionDraft.issue_date ? "date" : null,
        completionTotalTtcMissing ? "montant TTC" : null,
        completionAmountsIncoherent ? "totaux HT/TVA/TTC" : null,
        !purchaseAccountingAccountReady(completionDraft.accounting_account) && !completionLinesAccountingReady
          ? "compte comptable"
          : null,
        completionZeroVatMissing ? "motif TVA 0" : null,
      ].filter(Boolean)
    : [];
  const purchaseWorkflowState = String(workflow?.state || "").toLowerCase();
  const purchaseIsReadyToPay = purchaseWorkflowState === "ready_to_pay";
  const purchaseIsBooked = purchaseWorkflowState === "booked";
  const purchaseIsLocked = purchaseIsBooked && !purchaseEditMode;
  const draftTotalTtc = completionTotalTtcValue;
  const draftTotalHt = completionTotalHtValue;
  const draftTotalVat = completionTotalVatValue;
  const purchaseCurrency = completionDraft.currency || item?.currency || "EUR";
  const purchaseDisplayTotalTtc = draftTotalTtc !== null ? draftTotalTtc : item?.total_ttc || 0;
  const purchaseDisplayTotalHt = draftTotalHt !== null ? draftTotalHt : item?.total_ex_vat || 0;
  const purchaseDisplayTotalVat = draftTotalVat !== null ? draftTotalVat : item?.total_vat || 0;
  const purchasePaidTotal = roundPurchaseAmount(
    supplierPayments.reduce((sum, payment) => sum + numericAmount(payment?.amount), 0),
  );
  const purchaseRemainingTtc = roundPurchaseAmount(
    Math.max(0, numericAmount(purchaseDisplayTotalTtc) - purchasePaidTotal),
  );
  const purchaseIsFree = roundPurchaseAmount(numericAmount(purchaseDisplayTotalTtc)) <= 0;
  const purchaseDisplayIssueDate = completionDraft.issue_date || purchaseIsoDate(item?.issue_date);
  const purchaseDisplayPaymentDate =
    completionDraft.planned_payment_date || purchaseIsoDate(item?.planned_payment_date);
  const draftAmountsIncoherent = completionAmountsIncoherent;

  const saveCompletion = async (validate = false) => {
    if (!item || !isPurchasesView) return;
    setCompletionBusy(validate ? "validate" : "save");
    setError(null);
    setNotice(null);
    try {
      const normalizedAmounts = normalizePurchaseAmountsForSave(completionDraft);
      const purchaseLines = normalizePurchaseLineDrafts(completionDraft.purchase_lines);
      const hasPurchaseLines = purchaseLines.lines.length > 0;
      const data: any = await api(`/api/inbox/${item.id}/completion`, {
        method: "PATCH",
        body: JSON.stringify({
          supplier_name: completionDraft.supplier_name || null,
          supplier_siren: completionDraft.supplier_siren || null,
          supplier_siret: completionDraft.supplier_siret || null,
          invoice_number: completionDraft.invoice_number || null,
          issue_date: completionDraft.issue_date || null,
          total_ex_vat: hasPurchaseLines ? purchaseLines.total_ex_vat : normalizedAmounts.total_ex_vat,
          total_vat: hasPurchaseLines ? purchaseLines.total_vat : normalizedAmounts.total_vat,
          total_ttc: hasPurchaseLines ? purchaseLines.total_ttc : normalizedAmounts.total_ttc,
          currency: completionDraft.currency || "EUR",
          purchase_nature: completionDraft.purchase_nature || null,
          accounting_account: completionDraft.accounting_account || null,
          purchase_lines: hasPurchaseLines ? purchaseLines.lines : null,
          accountant_note: completionDraft.accountant_note || null,
          planned_payment_date: completionDraft.planned_payment_date || null,
          paid_by_employee: Boolean(completionDraft.paid_by_employee),
          employee_payer_name: completionDraft.paid_by_employee ? completionDraft.employee_payer_name || null : null,
          employee_payer_role: completionDraft.paid_by_employee ? completionDraft.employee_payer_role || null : null,
          employee_reimbursement_amount: completionDraft.paid_by_employee
            ? parsePurchaseAmount(completionDraft.employee_reimbursement_amount) ||
              (hasPurchaseLines ? purchaseLines.total_ttc : parsePurchaseAmount(completionDraft.total_ttc))
            : null,
          employee_reimbursement_due_date: completionDraft.paid_by_employee
            ? completionDraft.employee_reimbursement_due_date || completionDraft.planned_payment_date || null
            : null,
          employee_reimbursement_method: completionDraft.paid_by_employee
            ? completionDraft.employee_reimbursement_method || "bank_transfer"
            : null,
          employee_reimbursement_status: completionDraft.paid_by_employee
            ? completionDraft.employee_reimbursement_status || "to_reimburse"
            : null,
          validate,
        }),
      });
      const savedCompletionDraft = createPurchaseCompletionDraft(data || {});
      completionDraftBaselineRef.current = JSON.stringify(savedCompletionDraft);
      removeLocalDraft(localDraftKey(PURCHASE_COMPLETION_DRAFT_PREFIX, String(item.id)));
      setItem(data || null);
      setCompletionDraft(savedCompletionDraft);
      if (validate) {
        const currentState = String(workflow?.state || "").toLowerCase();
        const validatedTotalTtc = numericAmount(
          data?.total_ttc ?? (hasPurchaseLines ? purchaseLines.total_ttc : normalizedAmounts.total_ttc),
        );
        const isFreePurchase = validatedTotalTtc <= 0;
        const isNonReimbursableEmployeePurchase =
          Boolean(data?.paid_by_employee ?? completionDraft.paid_by_employee) &&
          String(data?.employee_reimbursement_status ?? completionDraft.employee_reimbursement_status ?? "")
            .toLowerCase()
            .trim() === "not_reimbursed";
        const nextWorkflow: any = await api(`/api/ops/purchase-workflow/${item.id}`, {
          method: "POST",
          body: JSON.stringify({
            state:
              currentState === "booked" || isFreePurchase || isNonReimbursableEmployeePurchase
                ? "booked"
                : "ready_to_pay",
            owner_role: workflow?.owner_role || "accountant",
            note: isNonReimbursableEmployeePurchase
              ? "Achat validé comme non remboursable : aucun règlement à enregistrer."
              : isFreePurchase
                ? "Achat gratuit validé : aucun règlement fournisseur à enregistrer."
                : workflow?.note ||
                  (completionDraft.planned_payment_date
                    ? `Paiement programmé au ${formatDateFr(completionDraft.planned_payment_date)}.`
                    : "Paiement fournisseur prêt à programmer."),
          }),
        });
        setWorkflow(nextWorkflow || null);
        setWorkflowDraft({
          state: nextWorkflow?.state || "reviewing",
          owner_role: nextWorkflow?.owner_role || "accountant",
          note: nextWorkflow?.note || "",
        });
      }
      setNotice(
        validate
          ? employeeMarkedNotReimbursable
            ? "Achat non remboursable validé et clôturé."
            : numericAmount(data?.total_ttc) <= 0
              ? "Achat gratuit validé et soldé."
              : "Achat complété et paiement programmé."
          : "Complétion achat enregistrée.",
      );
    } catch (err) {
      setError(formatApiError(err, validate ? "Validation impossible." : "Enregistrement impossible."));
    } finally {
      setCompletionBusy(null);
    }
  };

  const openSupplierPaymentModal = () => {
    if (!item || !isPurchasesView) return;
    setSupplierPaymentDraft(
      createPurchasePaymentDraft(
        item,
        purchaseRemainingTtc > 0 ? purchaseRemainingTtc : numericAmount(purchaseDisplayTotalTtc),
      ),
    );
    setSupplierPaymentModalOpen(true);
  };

  const markPurchasePaid = async () => {
    if (!item || !isPurchasesView) return;
    const amount = parsePurchaseAmount(supplierPaymentDraft.amount);
    if (!amount || amount <= 0) {
      setError("Renseignez un montant de règlement fournisseur supérieur à 0.");
      return;
    }
    const accountingCategory = String(supplierPaymentDraft.accounting_category || "").trim();
    if (!accountingCategory) {
      setError("Renseignez la catégorie de paiement fournisseur avant d'enregistrer.");
      return;
    }
    setSupplierPaymentSaving(true);
    setError(null);
    setNotice(null);
    try {
      const receiptFile = supplierPaymentDraft.receipt_file as File | null;
      let receiptAttached = false;
      if (receiptFile) {
        await uploadPurchaseAttachment(receiptFile, {
          reload: false,
          notice: false,
          resetMessages: false,
          showBusy: false,
          throwOnError: true,
        });
        receiptAttached = true;
      }
      await api(`/api/inbox/${item.id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          date: supplierPaymentDraft.date ? `${supplierPaymentDraft.date}T00:00:00` : null,
          amount,
          method: supplierPaymentDraft.method || "Virement bancaire",
          reference: supplierPaymentDraft.reference || null,
          settlement_mode: supplierPaymentDraft.settlement_mode || "bank",
          accounting_category: accountingCategory,
          receipt_label: supplierPaymentDraft.receipt_label || null,
          receipt_url: supplierPaymentDraft.receipt_url || null,
        }),
      });
      const data: any = await readJson(`/api/ops/purchase-workflow/${item.id}`);
      setWorkflow(data || null);
      setWorkflowDraft({
        state: data?.state || "booked",
        owner_role: data?.owner_role || "accountant",
        note: data?.note || "",
      });
      setSupplierPaymentModalOpen(false);
      setNotice(
        receiptAttached
          ? "Paiement fournisseur enregistré. Justificatif joint au dossier achat."
          : "Paiement fournisseur enregistré.",
      );
      await load();
    } catch (err) {
      setError(formatApiError(err, "Impossible d'enregistrer le paiement fournisseur."));
    } finally {
      setSupplierPaymentSaving(false);
    }
  };

  const runAction = async (action: "accept" | "reject" | "request_correction") => {
    if (!item) return;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/inbox/${item.id}/status`, { method: "POST", body: JSON.stringify({ action }) });
      setNotice(`Action ${titleCase(action)} envoyée.`);
      await load();
    } catch (err) {
      setError(formatApiError(err, "Cette action n'a pas pu être réalisée. Vérifiez les informations puis réessayez."));
    } finally {
      setBusyAction(null);
    }
  };

  const deleteImportedInvoice = async () => {
    if (!item || !canDeleteInboundInvoice(item)) return;
    const label = item?.invoice_number || item?.supplier_name || item?.id || "ce document";
    if (!window.confirm(`Supprimer ${label} ?`)) return;
    setDeleteBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/inbox/${item.id}`, { method: "DELETE" });
      navigate(basePath);
    } catch (err) {
      setError(formatApiError(err, "Suppression impossible."));
      setDeleteBusy(false);
    }
  };

  return (
    <>
      {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
      {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}

      {supplierPaymentModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]/45 px-3 py-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-[#e2e8f0] px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#dcfce7] text-[#15803d]">
                  <Wallet className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 800 }}>
                    Paiement fournisseur
                  </h2>
                  <p
                    className="mt-1 text-[#64748b]"
                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                  >
                    Enregistre le paiement réel pour solder l'achat et l'inclure dans le dossier comptable.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSupplierPaymentModalOpen(false)}
                className="rounded-full p-2 text-[#64748b] transition-colors hover:bg-[#f1f5f9]"
                aria-label="Fermer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="grid gap-3 rounded-2xl border border-[#bbf7d0] bg-[#f0fdf4] p-4 sm:grid-cols-3">
                <div className="min-w-0 rounded-xl border border-[#dcfce7] bg-white/72 px-3 py-2">
                  <div className="text-[#64748b]" style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 700 }}>
                    Total achat
                  </div>
                  <div
                    className="mt-1 break-words text-right text-[#0f172a]"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 850, fontVariantNumeric: "tabular-nums" }}
                  >
                    {money(purchaseDisplayTotalTtc, purchaseCurrency)}
                  </div>
                </div>
                <div className="min-w-0 rounded-xl border border-[#dcfce7] bg-white/72 px-3 py-2">
                  <div className="text-[#64748b]" style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 700 }}>
                    Déjà réglé
                  </div>
                  <div
                    className="mt-1 break-words text-right text-[#0f172a]"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 850, fontVariantNumeric: "tabular-nums" }}
                  >
                    {money(purchasePaidTotal, purchaseCurrency)}
                  </div>
                </div>
                <div className="min-w-0 rounded-xl border border-[#bbf7d0] bg-white px-3 py-2">
                  <div className="text-[#166534]" style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}>
                    Solde à payer
                  </div>
                  <div
                    className="mt-1 break-words text-right text-[#15803d]"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 900, fontVariantNumeric: "tabular-nums" }}
                  >
                    {money(purchaseRemainingTtc, purchaseCurrency)}
                  </div>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <InputField
                  label="Date de paiement"
                  type="date"
                  value={supplierPaymentDraft.date}
                  onChange={(event) => setSupplierPaymentDraft((prev: any) => ({ ...prev, date: event.target.value }))}
                />
                <InputField
                  label="Montant réglé"
                  required
                  inputMode="decimal"
                  value={supplierPaymentDraft.amount}
                  onChange={(event) =>
                    setSupplierPaymentDraft((prev: any) => ({ ...prev, amount: event.target.value }))
                  }
                  placeholder="0,00"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label="Mode de règlement"
                  help="Moyen réellement utilisé pour payer le fournisseur. Il préremplit la catégorie de paiement proposée."
                  value={supplierPaymentDraft.settlement_mode}
                  onChange={(event) =>
                    setSupplierPaymentDraft((prev: any) => ({
                      ...prev,
                      settlement_mode: event.target.value,
                      accounting_category: purchasePaymentAccountForMode(event.target.value),
                      method:
                        event.target.value === "card"
                          ? "Carte bancaire"
                          : event.target.value === "cash"
                            ? "Espèces"
                            : event.target.value === "other"
                              ? "Autre règlement"
                              : "Virement bancaire",
                    }))
                  }
                >
                  <option value="bank">Virement bancaire</option>
                  <option value="card">Carte bancaire</option>
                  <option value="cash">Espèces</option>
                  <option value="other">Autre règlement</option>
                </SelectField>
                <InputField
                  label="Référence"
                  help="Référence bancaire ou interne du paiement. Elle facilite le rapprochement avec le relevé."
                  value={supplierPaymentDraft.reference}
                  onChange={(event) =>
                    setSupplierPaymentDraft((prev: any) => ({ ...prev, reference: event.target.value }))
                  }
                  placeholder="Ex. VIR-20260531"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label="Compte de règlement"
                  help="Catégorie compta du moyen de paiement : 512 pour banque, 531 pour caisse."
                  value={supplierPaymentDraft.accounting_category}
                  onChange={(event) =>
                    setSupplierPaymentDraft((prev: any) => ({ ...prev, accounting_category: event.target.value }))
                  }
                >
                  <option value="512">512 - Banque</option>
                  <option value="531">531 - Caisse</option>
                  <option value="580">580 - Virements internes</option>
                  <option value="">Compte à préciser</option>
                </SelectField>
                <InputField
                  label="Libellé justificatif"
                  help="Nom court du justificatif associé au paiement, par exemple relevé bancaire ou reçu."
                  value={supplierPaymentDraft.receipt_label}
                  onChange={(event) =>
                    setSupplierPaymentDraft((prev: any) => ({ ...prev, receipt_label: event.target.value }))
                  }
                  placeholder="Relevé bancaire, reçu, note..."
                />
              </div>
              <InputField
                label="Lien justificatif"
                help="Lien externe vers le justificatif si le fichier est déjà stocké ailleurs. Vous pouvez aussi joindre un fichier ci-dessous."
                value={supplierPaymentDraft.receipt_url}
                onChange={(event) =>
                  setSupplierPaymentDraft((prev: any) => ({ ...prev, receipt_url: event.target.value }))
                }
                placeholder="https://..."
              />
              <label className="block" htmlFor="supplier-payment-proof-file">
                <span
                  className="mb-1 flex items-center gap-1.5 text-[#475569]"
                  style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                >
                  <span>Fichier justificatif</span>
                </span>
                <input
                  id="supplier-payment-proof-file"
                  type="file"
                  aria-label="Fichier justificatif"
                  accept="application/pdf,application/xml,text/xml,image/png,image/jpeg,image/webp,.pdf,.xml,.png,.jpg,.jpeg,.webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    setSupplierPaymentDraft((prev: any) => ({
                      ...prev,
                      receipt_file: file,
                      receipt_label: prev.receipt_label || file?.name || "",
                    }));
                  }}
                  className="sr-only"
                />
                <span className="flex min-h-10 items-center gap-2 rounded-xl border border-[#cbd5e1] bg-white px-3 py-2 text-[#0f172a]">
                  <span
                    className="inline-flex h-7 shrink-0 items-center rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-3 text-[#1d4ed8]"
                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                  >
                    Choisir un fichier
                  </span>
                  <span
                    className="min-w-0 truncate text-[#64748b]"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650 }}
                  >
                    {supplierPaymentDraft.receipt_file?.name || "Aucun fichier choisi"}
                  </span>
                </span>
                <span
                  className="mt-1 block text-[#64748b]"
                  style={{ fontSize: "var(--pf-app-text-caption)", lineHeight: 1.35 }}
                >
                  PDF, XML ou image. Le fichier sera ajouté aux pièces jointes de l'achat.
                </span>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-[#e2e8f0] bg-[#f8fafc] px-5 py-4">
              <SecondaryButton disabled={supplierPaymentSaving} onClick={() => setSupplierPaymentModalOpen(false)}>
                Annuler
              </SecondaryButton>
              <PrimaryButton disabled={supplierPaymentSaving} onClick={() => void markPurchasePaid()}>
                {supplierPaymentSaving ? "Enregistrement..." : "Enregistrer le paiement"}
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}

      {employeeModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]/45 px-3 py-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-[#e2e8f0] px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#dcfce7] text-[#15803d]">
                  <Wallet className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 800 }}>
                    Fiche avance interne
                  </h2>
                  <p
                    className="mt-1 text-[#64748b]"
                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                  >
                    Mémorise la personne et ses règles de remboursement pour les prochains achats.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEmployeeModalOpen(false)}
                className="rounded-full p-2 text-[#64748b] transition-colors hover:bg-[#f1f5f9]"
                aria-label="Fermer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-4 px-5 py-4 lg:grid-cols-[0.82fr_1.18fr]">
              <div className="rounded-2xl border border-[#bbf7d0] bg-[#f0fdf4] p-4">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#15803d] text-white"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 850 }}
                  >
                    {purchasePersonInitials(employeeDraft.name)}
                  </div>
                  <div className="min-w-0">
                    <p
                      className="truncate text-[#0f172a]"
                      style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                    >
                      {employeeDraft.name || "Personne à renseigner"}
                    </p>
                    <p
                      className="truncate text-[#166534]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 650 }}
                    >
                      {purchaseEmployeeRoleLabel(employeeDraft.role)} ·{" "}
                      {purchaseEmployeeMethodLabel(employeeDraft.reimbursement_method)}
                    </p>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  {[
                    [
                      "Catégorie compta",
                      purchaseAccountingAccountLabel(employeeDraft.accounting_account) || "Non renseigné",
                    ],
                    ...(isMileagePurchase
                      ? [
                          [
                            "Véhicule",
                            `${employeeDraft.vehicle_type || "Non renseigné"} · ${employeeDraft.fiscal_power || "—"}`,
                          ],
                        ]
                      : []),
                    ["Rattaché à", employeeDraft.user_label || "Utilisateur courant"],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-[#bbf7d0] bg-white/75 px-3 py-2">
                      <div
                        className="text-[#64748b]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 650 }}
                      >
                        {label}
                      </div>
                      <div
                        className="mt-0.5 truncate text-[#0f172a]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                      >
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-[1.1fr_0.9fr]">
                  <InputField
                    label="Nom prénom"
                    required
                    value={employeeDraft.name}
                    onChange={(event) => setEmployeeDraft((prev: any) => ({ ...prev, name: event.target.value }))}
                    placeholder="Ex. Marie Dupont"
                  />
                  <SelectField
                    label="Profil"
                    value={employeeDraft.role}
                    onChange={(event) => setEmployeeDraft((prev: any) => ({ ...prev, role: event.target.value }))}
                  >
                    <option value="manager">Dirigeant</option>
                    <option value="employee">Salarié</option>
                  </SelectField>
                </div>
                <div className="grid gap-3 md:grid-cols-[1.1fr_0.9fr]">
                  <InputField
                    label="Utilisateur rattaché"
                    value={employeeDraft.user_label}
                    onChange={(event) => setEmployeeDraft((prev: any) => ({ ...prev, user_label: event.target.value }))}
                    placeholder="Email ou nom interne"
                  />
                  <SelectField
                    label="Mode de remboursement"
                    value={employeeDraft.reimbursement_method}
                    onChange={(event) =>
                      setEmployeeDraft((prev: any) => ({ ...prev, reimbursement_method: event.target.value }))
                    }
                  >
                    <option value="bank_transfer">Virement</option>
                    <option value="cash">Espèces</option>
                    <option value="other">Autre</option>
                  </SelectField>
                </div>
                <PurchaseAccountingAccountField
                  label="Catégorie par défaut"
                  value={employeeDraft.accounting_account}
                  onChange={(value) => setEmployeeDraft((prev: any) => ({ ...prev, accounting_account: value }))}
                  selectClassName="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-sm"
                />
                {isMileagePurchase ? (
                  <div className="rounded-2xl border border-[#bbf7d0] bg-[#f7fef9] p-3">
                    <div className="mb-3 flex items-start gap-2">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#dcfce7] text-[#15803d]">
                        <Car className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-[#14532d]" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}>
                          Frais kilométriques
                        </p>
                        <p
                          className="text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                        >
                          À renseigner uniquement pour calculer et justifier une indemnité kilométrique.
                        </p>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <SelectField
                        label="Véhicule utilisé"
                        value={employeeDraft.vehicle_type}
                        onChange={(event) =>
                          setEmployeeDraft((prev: any) => ({ ...prev, vehicle_type: event.target.value }))
                        }
                      >
                        {purchaseEmployeeVehicleOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </SelectField>
                      <SelectField
                        label="Puissance fiscale (carte grise)"
                        value={employeeDraft.fiscal_power}
                        onChange={(event) =>
                          setEmployeeDraft((prev: any) => ({ ...prev, fiscal_power: event.target.value }))
                        }
                      >
                        {purchaseEmployeeFiscalPowerOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </SelectField>
                    </div>
                  </div>
                ) : null}
                <div>
                  <label
                    className="mb-1.5 block text-[#374151]"
                    style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 500 }}
                  >
                    Note interne
                  </label>
                  <textarea
                    value={employeeDraft.notes}
                    onChange={(event) => setEmployeeDraft((prev: any) => ({ ...prev, notes: event.target.value }))}
                    placeholder="Précision utile pour le remboursement ou la comptabilité"
                    className="min-h-[84px] w-full rounded-lg border border-[#dbe7f3] bg-white px-3 py-2 text-[#0f172a] shadow-[0_1px_2px_rgba(0,0,0,0.04)] outline-none placeholder:text-[#94a3b8] focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                    style={{ fontSize: "var(--pf-app-text-body)" }}
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[#e2e8f0] bg-[#f8fafc] px-5 py-4">
              <SecondaryButton onClick={() => setEmployeeModalOpen(false)}>Annuler</SecondaryButton>
              <PrimaryButton
                disabled={employeeSaving || !String(employeeDraft.name || "").trim()}
                onClick={() => void saveEmployeePayerReference()}
              >
                {employeeSaving ? "Enregistrement…" : "Enregistrer la fiche"}
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}

      {loading ? (
        <LoadingCard label="Chargement du détail…" />
      ) : !item ? (
        <SectionEmpty
          title="Facture introuvable"
          description="Le document demandé n’existe pas ou n’est plus accessible sur cet espace."
          href={basePath}
          cta={isPurchasesView ? "Retour aux achats" : "Retour à l’inbox"}
        />
      ) : isPurchasesView ? (
        <div className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[45%_55%] xl:items-stretch">
            <Card
              id="purchase-source-document"
              className="order-2 flex h-full flex-col overflow-hidden border border-[#E8EAF0] xl:order-none"
            >
              <input
                ref={purchaseProofInputRef}
                type="file"
                aria-label="Justificatif d'achat"
                className="sr-only"
                accept="application/pdf,application/xml,text/xml,image/png,image/jpeg,image/webp,.pdf,.xml,.png,.jpg,.jpeg,.webp"
                onChange={handlePurchaseProofFile}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e2e8f0] px-1 pb-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <div className="[&>div]:mb-0 [&_h3]:leading-5">
                    <SectionTitle>Justificatif d'achat</SectionTitle>
                  </div>
                  <InlineHelpTooltip content="Facture, reçu ou pièce source à conserver pour prouver l'achat. Le justificatif de paiement se renseigne au moment du règlement." />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span title={validationHelpText(item.validation_status) || undefined}>
                    <StatusPill {...validationPill(item.validation_status)} />
                  </span>
                  <SecondaryButton
                    data-testid="purchase-proof-upload"
                    className="h-10"
                    disabled={purchaseProofUploading}
                    onClick={() => {
                      setPurchaseReplaceAttachmentId(null);
                      purchaseProofInputRef.current?.click();
                    }}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {purchaseProofUploading ? "Import..." : "Ajouter un justificatif"}
                  </SecondaryButton>
                  {selectedPurchaseAttachment ? (
                    <DangerButton
                      data-testid="purchase-proof-delete"
                      className="h-10"
                      disabled={purchaseAttachmentBusy === String(selectedPurchaseAttachment.id)}
                      onClick={() => void deletePurchaseAttachment(selectedPurchaseAttachment)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Supprimer
                    </DangerButton>
                  ) : null}
                </div>
              </div>
              {validationHelpText(item.validation_status) ? (
                <div className="mt-3 rounded-xl border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-[#9a3412]">
                  <p style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}>
                    {validationHelpText(item.validation_status)}
                  </p>
                </div>
              ) : null}
              <div className="mt-3 flex-1 overflow-hidden rounded-xl border border-[#dbe7f3] bg-white">
                {pdfPreviewUrl && purchasePreviewKind === "pdf" ? (
                  <iframe
                    title="Aperçu de la facture fournisseur"
                    src={pdfPreviewUrl}
                    className="h-[620px] w-full bg-white xl:h-full xl:min-h-[820px]"
                  />
                ) : pdfPreviewUrl && purchasePreviewKind === "image" ? (
                  <div className="flex min-h-[380px] items-start justify-center bg-[#f8fafc] p-3 xl:h-full xl:min-h-[820px]">
                    {/* Blob URL from a private purchase attachment; Next Image cannot optimize it. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={pdfPreviewUrl}
                      alt="Aperçu du justificatif d'achat"
                      className="max-h-[620px] w-auto max-w-full rounded-lg bg-white object-contain shadow-sm xl:max-h-none"
                    />
                  </div>
                ) : (
                  <div className="flex min-h-[380px] flex-col items-center justify-center bg-white px-6 text-center xl:h-full xl:min-h-[820px]">
                    <FileText className="mb-3 h-8 w-8 text-[#94a3b8]" />
                    <p className="font-semibold text-[#0f172a]" style={{ fontSize: "var(--pf-app-text-body)" }}>
                      {pdfPreviewError ||
                        (purchaseProofAttachment
                          ? "Justificatif joint. Aperçu disponible pour les PDF et images."
                          : "Aucun justificatif affichable pour cet achat.")}
                    </p>
                    <p className="mt-1 max-w-md text-[#64748b]" style={{ fontSize: "var(--pf-app-text-caption)" }}>
                      {purchaseProofAttachment
                        ? "Téléchargez la pièce jointe pour la consulter ou ajoutez un PDF si vous voulez un aperçu intégré."
                        : "Joins un PDF ou une image du justificatif pour compléter le dossier, ou exploite le XML déjà importé."}
                    </p>
                  </div>
                )}
              </div>
            </Card>

            <div className="order-1 min-w-0 space-y-4 xl:order-none">
              <div
                id="purchase-form-main"
                data-testid="purchase-invoice-form-preview"
                className="scroll-mt-24 overflow-hidden rounded-2xl border border-[#dbe4ef] bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
              >
                <div className="border-b border-[#dbe4ef] bg-white px-5 py-5 lg:px-7">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                        <p
                          className="min-w-0 max-w-full truncate text-[22px] font-extrabold leading-tight text-gray-900"
                          title={completionDraft.invoice_number || item?.invoice_number || "Facture à qualifier"}
                        >
                          {completionDraft.invoice_number || item?.invoice_number || "Facture à qualifier"}
                        </p>
                        <span
                          className="max-w-[18rem] truncate text-[12px] font-extrabold uppercase tracking-[0.04em] text-[#64748b]"
                          title={completionDraft.supplier_name || item?.supplier_name || "Fournisseur à renseigner"}
                        >
                          {completionDraft.supplier_name || item?.supplier_name || "Fournisseur à renseigner"}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-[#f8fafc] px-2.5 py-1 text-[13px] font-extrabold text-[#0f172a] tabular-nums">
                          {money(purchaseDisplayTotalTtc, purchaseCurrency)}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-[#f8fafc] px-2.5 py-1 text-[12px] font-extrabold text-[#94a3b8]">
                          TVA {money(purchaseDisplayTotalVat, purchaseCurrency)} · HT{" "}
                          {money(purchaseDisplayTotalHt, purchaseCurrency)}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-[#f8fafc] px-2.5 py-1 text-[12px] font-extrabold text-[#64748b]">
                          Date {formatDateFr(purchaseDisplayIssueDate, "Non renseignée")} · Échéance{" "}
                          {formatDateFr(purchaseDisplayPaymentDate, "Non renseignée")}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">
                      <StatusPill {...purchaseWorkflowPill(workflow)} />
                    </div>
                  </div>
                </div>

                <div className="px-5 py-5 lg:px-7 lg:py-6">
                  {purchaseIsLocked ? (
                    <div
                      className="mb-3 rounded-xl border border-[#bbf7d0] bg-[#f0fdf4] px-3 py-2 text-[#166534]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                    >
                      Achat payé : les champs sont verrouillés. Cliquez sur “Modifier l'achat” pour corriger une erreur.
                    </div>
                  ) : null}
                  <fieldset
                    disabled={purchaseIsLocked}
                    className={`m-0 space-y-6 border-0 p-0 ${purchaseIsLocked ? "opacity-70" : ""}`}
                  >
                    <PurchaseDetailSection
                      id="purchase-document-section"
                      title="Émetteur et document"
                      help="Identifie qui a émis la facture et la référence à conserver. En mode remboursement, indique aussi la personne à rembourser."
                      actions={
                        <>
                          {[
                            { label: "Fournisseur", active: !tracksEmployeePayment, value: false },
                            { label: "Remboursement", active: tracksEmployeePayment, value: true },
                          ].map((mode) => (
                            <button
                              key={mode.label}
                              type="button"
                              disabled={purchaseIsLocked}
                              onClick={() => updateEmployeePaymentMode(mode.value)}
                              className={`rounded-xl border px-3.5 py-1.5 text-[12px] font-semibold transition-all ${
                                mode.active
                                  ? "border-[#5B5FEE] bg-indigo-50 text-[#5B5FEE]"
                                  : "border-[#E8EAF0] bg-white text-gray-500 hover:border-gray-300"
                              } disabled:cursor-not-allowed disabled:opacity-60`}
                            >
                              {mode.label}
                            </button>
                          ))}
                        </>
                      }
                    >
                      <div className="space-y-3">
                        <PurchasePartyPicker
                          id="purchase-supplier-picker"
                          label="Fournisseur / marchand"
                          required
                          value={completionDraft.supplier_name}
                          open={supplierPickerOpen}
                          options={supplierOptions}
                          placeholder="Rechercher un fournisseur (nom, SIREN...)"
                          emptyLabel="Aucun fournisseur enregistré."
                          createLabel="Ajouter un fournisseur"
                          canCreate={canRememberSupplier}
                          createBusy={supplierSaving}
                          onOpenChange={setSupplierPickerOpen}
                          onQueryChange={(value) => {
                            updateCompletionDraft({ supplier_name: value, supplier_siren: "", supplier_siret: "" });
                            setSupplierQuery(value);
                          }}
                          onSelect={(option) => applySupplierOption(purchaseSupplierName(option), option)}
                          onCreate={() => void rememberSupplierName(completionDraft.supplier_name || supplierQuery)}
                          getOptionKey={(option) => String(option?.id || purchaseSupplierName(option))}
                          getOptionLabel={purchaseSupplierName}
                          getOptionSubLabel={purchaseSupplierMeta}
                        />
                        {tracksEmployeePayment ? (
                          <PurchasePartyPicker
                            id="purchase-employee-payer-picker"
                            label="Personne à rembourser"
                            required
                            value={completionDraft.employee_payer_name}
                            open={employeePickerOpen}
                            options={employeePayerOptions}
                            placeholder="Rechercher une personne (nom, email...)"
                            emptyLabel="Aucune personne enregistrée."
                            createLabel="Ajouter une personne"
                            canCreate={canRememberEmployeePayer}
                            createBusy={employeeSaving}
                            onOpenChange={setEmployeePickerOpen}
                            onQueryChange={(value) => {
                              updateCompletionDraft({ employee_payer_name: value });
                              setEmployeeQuery(value);
                            }}
                            onSelect={(option) => applyEmployeePayerOption(employeePayerName(option), option)}
                            onCreate={() => void addEmployeePayerOption()}
                            getOptionKey={(option) => String(option?.id || employeePayerName(option))}
                            getOptionLabel={employeePayerName}
                            getOptionSubLabel={purchaseEmployeePayerMeta}
                          />
                        ) : null}
                        <div className="grid gap-3 sm:grid-cols-2">
                          <InputField
                            label={isMileagePurchase || isExpenseReportPurchase ? "Référence" : "N° facture"}
                            required={!isMileagePurchase && !isExpenseReportPurchase}
                            help="Numéro indiqué sur la facture fournisseur. Il sert à retrouver la pièce dans la liste achats et dans l'export comptable."
                            value={completionDraft.invoice_number}
                            onChange={(event) => updateCompletionDraft({ invoice_number: event.target.value })}
                            placeholder="Ex. FA-2026-001"
                          />
                          <InputField
                            label={isMileagePurchase || isExpenseReportPurchase ? "Date dépense" : "Date facture"}
                            required
                            help="Date indiquée sur le justificatif. Elle sert au classement comptable et au calcul de l'échéance."
                            type="date"
                            value={completionDraft.issue_date}
                            onChange={(event) => updateIssueDate(event.target.value)}
                          />
                        </div>
                      </div>
                    </PurchaseDetailSection>

                    <PurchaseDetailSection
                      id="purchase-lines-section"
                      title="Lignes de facture"
                      help="Reprends les lignes importantes de la facture, surtout si plusieurs taux de TVA ou comptes comptables sont présents."
                      badge={
                        completionLinesVatRateMissing ? (
                          <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[10px] font-bold text-orange-600">
                            Taux non renseigné
                          </span>
                        ) : null
                      }
                    >
                      <PurchaseLinesEditor
                        lines={completionDraft.purchase_lines}
                        disabled={purchaseIsLocked}
                        compact
                        onChange={updateCompletionPurchaseLines}
                      />
                    </PurchaseDetailSection>

                    <PurchaseDetailSection
                      id="purchase-payment-section"
                      title="Totaux et paiement"
                      help="Vérifiez que le TTC correspond à HT + TVA. Un achat à 0 € peut être validé si le total TTC est bien égal à zéro."
                    >
                      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
                        <div className="space-y-3">
                          <div className="grid gap-3 sm:grid-cols-3">
                            <InputField
                              label="Total TTC"
                              required
                              help="Montant total à payer indiqué sur la facture, TVA comprise."
                              inputMode="decimal"
                              value={completionDraft.total_ttc}
                              onChange={(event) => {
                                const nextTotal = event.target.value;
                                const total = parsePurchaseAmount(nextTotal);
                                const derived = derivePurchaseHtVatFromTtc(total);
                                updateCompletionDraft({
                                  total_ttc: nextTotal,
                                  ...(total !== null && total > 0 ? derived : {}),
                                  ...(tracksEmployeePayment && !completionDraft.employee_reimbursement_amount
                                    ? { employee_reimbursement_amount: nextTotal }
                                    : {}),
                                });
                              }}
                              placeholder="0,00"
                            />
                            <InputField
                              label="HT"
                              help="Montant hors taxe. Si vous saisissez le TTC, l'application peut recalculer HT et TVA avec le taux standard."
                              inputMode="decimal"
                              value={completionDraft.total_ex_vat}
                              onChange={(event) => {
                                const nextHt = event.target.value;
                                const total = parsePurchaseAmount(completionDraft.total_ttc);
                                const ht = parsePurchaseAmount(nextHt);
                                updateCompletionDraft({
                                  total_ex_vat: nextHt,
                                  ...(total !== null && ht !== null && total >= ht
                                    ? { total_vat: purchaseAmountToInput(total - ht) }
                                    : {}),
                                });
                              }}
                              placeholder="0,00"
                            />
                            <InputField
                              label="TVA"
                              help="Montant de TVA en euros, pas le taux. Pour le taux, utilisez les lignes de facture."
                              inputMode="decimal"
                              value={completionDraft.total_vat}
                              onChange={(event) => {
                                const nextVat = event.target.value;
                                const total = parsePurchaseAmount(completionDraft.total_ttc);
                                const vat = parsePurchaseAmount(nextVat);
                                updateCompletionDraft({
                                  total_vat: nextVat,
                                  ...(total !== null && vat !== null && total >= vat
                                    ? { total_ex_vat: purchaseAmountToInput(total - vat) }
                                    : {}),
                                });
                              }}
                              placeholder="0,00"
                            />
                          </div>
                          {draftAmountsIncoherent ? (
                            <div
                              className="rounded-lg border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-[#9a3412]"
                              style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 750 }}
                            >
                              Le total TTC ne correspond pas à HT + TVA. Corrigez les montants avant de valider l'achat.
                            </div>
                          ) : null}
                          <div className="grid gap-3 sm:grid-cols-[1fr_0.72fr]">
                            <InputField
                              label={completionDraft.paid_by_employee ? "Remboursement prévu" : "Paiement prévu"}
                              help="Date à laquelle le fournisseur doit être payé ou la personne remboursée."
                              type="date"
                              value={completionDraft.planned_payment_date}
                              onChange={(event) => updatePlannedPaymentDate(event.target.value)}
                            />
                            <InputField
                              label="Délai paiement (jours)"
                              help="Nombre de jours entre la date de facture et la date prévue de paiement."
                              inputMode="numeric"
                              value={completionDraft.payment_delay_days}
                              onChange={(event) => updatePlannedPaymentDelayInput(event.target.value)}
                              placeholder="30"
                            />
                          </div>
                          {tracksEmployeePayment ? (
                            <div className="grid gap-3 rounded-lg border border-[#dbe7f3] bg-[#f8fafc] p-3 sm:grid-cols-3">
                              <InputField
                                label="Montant remboursé"
                                inputMode="decimal"
                                value={completionDraft.employee_reimbursement_amount}
                                onChange={(event) =>
                                  updateCompletionDraft({ employee_reimbursement_amount: event.target.value })
                                }
                                placeholder={completionDraft.total_ttc || "0,00"}
                              />
                              <SelectField
                                label="Mode"
                                value={completionDraft.employee_reimbursement_method}
                                onChange={(event) =>
                                  updateCompletionDraft({ employee_reimbursement_method: event.target.value })
                                }
                              >
                                <option value="bank_transfer">Virement</option>
                                <option value="cash">Espèces</option>
                                <option value="other">Autre</option>
                              </SelectField>
                              <SelectField
                                label="Statut"
                                value={completionDraft.employee_reimbursement_status}
                                onChange={(event) =>
                                  updateCompletionDraft({ employee_reimbursement_status: event.target.value })
                                }
                              >
                                <option value="to_reimburse">À rembourser</option>
                                <option value="reimbursed">Remboursé</option>
                                <option value="not_reimbursed">Non remboursable</option>
                              </SelectField>
                            </div>
                          ) : null}
                        </div>
                        <div className="w-full overflow-hidden rounded-lg border border-[#dbe4ef] bg-white lg:ml-auto">
                          {[
                            {
                              label: "Total HT",
                              value: money(purchaseDisplayTotalHt, purchaseCurrency),
                              active: false,
                            },
                            { label: "TVA", value: money(purchaseDisplayTotalVat, purchaseCurrency), active: false },
                            {
                              label: "Total TTC",
                              value: money(purchaseDisplayTotalTtc, purchaseCurrency),
                              active: true,
                            },
                          ].map((metric) => (
                            <div
                              key={metric.label}
                              className={`flex items-center justify-between gap-4 border-b border-[#e2e8f0] px-4 py-3 last:border-b-0 ${
                                metric.active ? "bg-indigo-50 text-indigo-700" : "bg-[#fafbfd] text-[#0f172a]"
                              }`}
                            >
                              <span className="text-[12px] font-bold text-[#64748b]">{metric.label}</span>
                              <span className="whitespace-nowrap text-[15px] font-extrabold tabular-nums">
                                {metric.value}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </PurchaseDetailSection>

                    <PurchaseDetailSection
                      id="purchase-accounting-section"
                      title="Catégorisation compta"
                      help="Classe l'achat pour le dossier comptable. La catégorie par défaut s'applique si les lignes n'ont pas de catégorie propre."
                    >
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                        <SelectField
                          label="Nature de l'opération"
                          help="Indique si l'achat est plutôt un service ou un produit. Cela aide les contrôles comptables et TVA."
                          value={completionDraft.purchase_nature}
                          onChange={(event) => updateCompletionDraft({ purchase_nature: event.target.value })}
                        >
                          <option value="service">Service</option>
                          <option value="product">Produit</option>
                        </SelectField>
                        <PurchaseAccountingAccountField
                          label="Catégorie par défaut"
                          help="Catégorie utilisée si aucune ligne n'a sa propre catégorie. “À valider par mon comptable” doit rester temporaire."
                          value={completionDraft.accounting_account}
                          onChange={(value) => updateCompletionDraft({ accounting_account: value })}
                          selectClassName="w-full cursor-pointer appearance-none rounded-lg bg-white px-3 py-2 text-[#0f172a] transition-all focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/25"
                          selectStyle={{
                            fontSize: "var(--pf-app-text-body)",
                            border: "1px solid rgba(0,0,0,0.08)",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                          }}
                        />
                        <div className="flex items-end">
                          <SecondaryButton
                            className="h-[42px] w-full whitespace-nowrap lg:w-auto"
                            disabled={autoClassifyBusy || purchaseIsLocked}
                            onClick={() => void autoClassifyPurchaseAccounting()}
                          >
                            <SlidersHorizontal className="h-3.5 w-3.5" />
                            {autoClassifyBusy ? "Classement..." : "Classer automatiquement"}
                          </SecondaryButton>
                        </div>
                      </div>
                      <div className="mt-3">
                        <label
                          className="mb-1.5 block text-[#374151]"
                          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 500 }}
                        >
                          Note pour la compta
                        </label>
                        <textarea
                          value={completionDraft.accountant_note}
                          onChange={(event) => updateCompletionDraft({ accountant_note: event.target.value })}
                          placeholder={
                            isMileagePurchase
                              ? "Trajet, kilomètres, motif du déplacement"
                              : "Objet de la dépense, projet ou précision utile"
                          }
                          className="min-h-[82px] w-full rounded-lg border border-[#dbe7f3] bg-white px-3 py-2 text-[#0f172a] shadow-[0_1px_2px_rgba(0,0,0,0.04)] outline-none placeholder:text-[#94a3b8] focus:border-[#15803d] focus:ring-2 focus:ring-[#15803d]/15"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        />
                      </div>
                    </PurchaseDetailSection>
                  </fieldset>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E8EAF0] bg-white/95 px-5 py-3 backdrop-blur lg:px-7">
                  {purchaseIsLocked ? (
                    <span
                      className="rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] px-3 py-2 text-[#166534]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                    >
                      {purchaseIsFree ? "Achat gratuit soldé" : "Achat payé"}
                    </span>
                  ) : canDeleteInboundInvoice(item) ? (
                    <DangerButton disabled={deleteBusy} onClick={() => void deleteImportedInvoice()}>
                      <XCircle className="h-3.5 w-3.5" /> {deleteBusy ? "Suppression..." : "Supprimer"}
                    </DangerButton>
                  ) : (
                    <span />
                  )}
                  {purchaseIsLocked ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      <SecondaryButton onClick={() => setPurchaseEditMode((value) => !value)}>
                        <Pencil className="h-3.5 w-3.5" />
                        Modifier l'achat
                      </SecondaryButton>
                    </div>
                  ) : (
                    <div className="flex flex-wrap justify-end gap-2">
                      <SecondaryButton disabled={Boolean(completionBusy)} onClick={() => void saveCompletion(false)}>
                        {completionBusy === "save" ? "Enregistrement..." : "Enregistrer"}
                      </SecondaryButton>
                      {purchaseIsReadyToPay && !purchaseIsBooked ? (
                        <PrimaryButton disabled={supplierPaymentSaving} onClick={openSupplierPaymentModal}>
                          <CheckCircle className="h-3.5 w-3.5" />
                          Enregistrer règlement
                        </PrimaryButton>
                      ) : (
                        <PrimaryButton
                          disabled={Boolean(completionBusy) || completionMissingFields.length > 0}
                          title={
                            completionMissingFields.length > 0
                              ? `À compléter avant validation : ${completionMissingFields.join(", ")}.`
                              : undefined
                          }
                          onClick={() => void saveCompletion(true)}
                        >
                          {completionBusy === "validate"
                            ? "Validation..."
                            : purchaseIsBooked
                              ? "Mettre à jour"
                              : "Valider pour paiement"}
                        </PrimaryButton>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className={`grid gap-3 sm:grid-cols-2 ${isPurchasesView ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
            {summaryCards.map((card) => (
              <PurchaseSummaryCard key={card.label} {...card} />
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {canReply ? (
              <>
                <PrimaryButton disabled={busyAction === "accept"} onClick={() => void runAction("accept")}>
                  {busyAction === "accept" ? "Envoi…" : "Accepter"}
                </PrimaryButton>
                <DangerButton disabled={busyAction === "reject"} onClick={() => void runAction("reject")}>
                  {busyAction === "reject" ? "Envoi…" : "Rejeter"}
                </DangerButton>
                <SecondaryButton
                  disabled={busyAction === "request_correction"}
                  onClick={() => void runAction("request_correction")}
                >
                  {busyAction === "request_correction" ? "Envoi…" : "Demander correction"}
                </SecondaryButton>
              </>
            ) : null}
            {canDeleteInboundInvoice(item) ? (
              <DangerButton disabled={deleteBusy} onClick={() => void deleteImportedInvoice()}>
                <XCircle className="w-3.5 h-3.5" /> {deleteBusy ? "Suppression…" : "Supprimer l'import"}
              </DangerButton>
            ) : null}
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          </div>

          <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
            <Card className="h-full">
              <SectionTitle>{isPurchasesView ? "Fiche achat" : "Document reçu"}</SectionTitle>
              <div className="mt-3 overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white">
                {detailRows.map(([label, value]) => (
                  <div
                    key={label}
                    className="grid gap-2 border-b border-[#eef2f7] px-4 py-3 last:border-b-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center"
                  >
                    <div
                      className="text-[#94a3b8]"
                      style={{ fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.03em" }}
                    >
                      {label}
                    </div>
                    <div
                      className="min-w-0 break-words text-[#0f172a]"
                      style={{ fontSize: "0.875rem", fontWeight: 600 }}
                    >
                      {value}
                    </div>
                  </div>
                ))}
              </div>

              {item.validation_errors?.length || item.validation_warnings?.length ? (
                <div className="mt-5 space-y-3">
                  {item.validation_errors?.length ? (
                    <div className="p-4 rounded-xl bg-[#fef2f2] border border-[#fecaca]">
                      <div className="text-[#991b1b] text-sm font-bold">Erreurs de validation</div>
                      <ul className="mt-2 space-y-2 text-[#b91c1c] text-xs">
                        {item.validation_errors.map((entry: any, index: number) => (
                          <li
                            key={index}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/60 px-2 py-1.5"
                          >
                            <span className="min-w-0 flex-1">{purchaseValidationEntryLabel(entry)}</span>
                            <button
                              type="button"
                              onClick={() => scrollToPurchaseCorrection(entry)}
                              className="inline-flex h-7 items-center justify-center rounded-lg border border-[#fecaca] bg-white px-2.5 text-[11px] font-extrabold text-[#991b1b] transition-colors hover:bg-[#fef2f2]"
                            >
                              Corriger
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {item.validation_warnings?.length ? (
                    <div className="p-4 rounded-xl bg-[#fffbeb] border border-[#fde68a]">
                      <div className="text-[#92400e] text-sm font-bold">Avertissements</div>
                      <ul className="mt-2 space-y-2 text-[#b45309] text-xs">
                        {item.validation_warnings.map((entry: any, index: number) => (
                          <li
                            key={index}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/60 px-2 py-1.5"
                          >
                            <span className="min-w-0 flex-1">{purchaseValidationEntryLabel(entry)}</span>
                            <button
                              type="button"
                              onClick={() => scrollToPurchaseCorrection(entry)}
                              className="inline-flex h-7 items-center justify-center rounded-lg border border-[#fde68a] bg-white px-2.5 text-[11px] font-extrabold text-[#92400e] transition-colors hover:bg-[#fffbeb]"
                            >
                              Corriger
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>

            <>
              {isPurchasesView ? (
                <Card className="h-full">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <SectionTitle>Suivi du traitement</SectionTitle>
                      <p className="text-[#64748b] -mt-2 text-xs">Suit le passage de la vérification au paiement.</p>
                    </div>
                    <StatusPill {...purchaseWorkflowPill(workflow)} />
                  </div>
                  <div className="mt-4 grid md:grid-cols-2 gap-3">
                    <SelectField
                      label="Étape"
                      value={workflowDraft.state}
                      onChange={(event) => setWorkflowDraft((prev: any) => ({ ...prev, state: event.target.value }))}
                    >
                      <option value="new">Nouveau</option>
                      <option value="reviewing">En revue</option>
                      <option value="awaiting_supplier">En attente fournisseur</option>
                      <option value="approved">Validé achat</option>
                      <option value="ready_to_pay">À payer</option>
                      <option value="booked" disabled>
                        Payé (via règlement)
                      </option>
                    </SelectField>
                    <SelectField
                      label="Responsable"
                      value={workflowDraft.owner_role || "accountant"}
                      onChange={(event) =>
                        setWorkflowDraft((prev: any) => ({ ...prev, owner_role: event.target.value }))
                      }
                    >
                      <option value="owner">Dirigeant</option>
                      <option value="admin">Admin</option>
                      <option value="accountant">Compta</option>
                      <option value="viewer">Lecture seule</option>
                    </SelectField>
                  </div>
                  <div className="mt-4">
                    <label
                      className="mb-1.5 block"
                      style={{ fontSize: "0.8125rem", fontWeight: 500, color: "#374151" }}
                    >
                      Note interne
                    </label>
                    <textarea
                      value={workflowDraft.note || ""}
                      onChange={(event) => setWorkflowDraft((prev: any) => ({ ...prev, note: event.target.value }))}
                      placeholder="Pourquoi ce document est-il gelé, approuvé ou prêt à payer ?"
                      className="w-full min-h-[104px] px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg bg-white text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-sm"
                    />
                  </div>
                  <div className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-4 mt-4">
                    <div className="text-[#0f172a] text-sm font-bold">
                      {workflow?.next_step_title || "Étape suivante"}
                    </div>
                    <p className="text-[#64748b] mt-1 text-xs leading-relaxed">
                      {workflow?.next_step_description || "Aucune indication pour le moment."}
                    </p>
                    {workflow?.updated_at ? (
                      <div className="text-[#94a3b8] mt-2" style={{ fontSize: "0.6875rem" }}>
                        Mis à jour le {formatDateTimeFr(workflow.updated_at)}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex justify-end mt-4">
                    <PrimaryButton disabled={workflowBusy} onClick={() => void saveWorkflow()}>
                      {workflowBusy ? "Enregistrement…" : "Enregistrer le traitement"}
                    </PrimaryButton>
                  </div>
                </Card>
              ) : null}

              <Card className="h-full">
                <SectionTitle>Prochaine action</SectionTitle>
                <div
                  className={`rounded-xl border p-4 ${guidance.tone === "danger" ? "border-[#fecaca] bg-[#fef2f2]" : guidance.tone === "warn" ? "border-[#fde68a] bg-[#fffbeb]" : guidance.tone === "ok" ? "border-[#bbf7d0] bg-[#f0fdf4]" : "border-[#bfdbfe] bg-[#eff6ff]"}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill color={guidance.tone as any} label={guidance.title} />
                    <StatusPill color={inboxStatusPill(item.status).color} label={inboxStatusPill(item.status).label} />
                    <StatusPill
                      color={validationPill(item.validation_status).color}
                      label={validationPill(item.validation_status).label}
                    />
                  </div>
                  <p className="text-[#475569] mt-3" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
                    {guidance.description}
                  </p>
                  <ul className="mt-3 space-y-2 text-[#475569]" style={{ fontSize: "0.75rem", lineHeight: 1.55 }}>
                    {guidance.bullets.map((bullet: string) => (
                      <li key={bullet} className="flex items-start gap-2">
                        <span className="mt-1 inline-block w-1.5 h-1.5 rounded-full bg-[#94a3b8]" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>

              <Card className="h-full">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <SectionTitle>Pièces jointes</SectionTitle>
                  <SecondaryButton
                    disabled={purchaseProofUploading}
                    onClick={() => {
                      setPurchaseReplaceAttachmentId(null);
                      purchaseProofInputRef.current?.click();
                    }}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {purchaseProofUploading ? "Import..." : "Ajouter un justificatif"}
                  </SecondaryButton>
                </div>
                {purchaseAttachments.length === 0 ? (
                  <p className="text-[#94a3b8] text-sm">Aucune pièce jointe disponible.</p>
                ) : (
                  <div className="space-y-3">
                    {purchaseAttachments.map((attachment: any, index: number) => {
                      const attachmentId = String(attachment.id);
                      const kind = String(attachment.kind || "document").toLowerCase();
                      const canOpenInline = kind === "pdf" || ["png", "jpg", "jpeg", "webp"].includes(kind);
                      const active = attachmentId === String(selectedPurchaseAttachment?.id || "");
                      const size = Number(attachment.size_bytes || 0);
                      const actionBusy = purchaseAttachmentBusy === attachmentId;
                      const filename = `${item.invoice_number || item.id}-${index + 1}.${kind || "bin"}`;
                      return (
                        <div
                          key={attachmentId}
                          className={`rounded-xl border p-3 ${
                            active ? "border-[#bfdbfe] bg-[#eff6ff]" : "border-[#e2e8f0] bg-[#f8fafc]"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedPurchaseAttachmentId(attachmentId)}
                            className="block w-full text-left"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[#0f172a] text-sm font-semibold">Justificatif {index + 1}</div>
                                <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                                  {size > 0 ? `${Math.round(size / 1024)} Ko` : "Taille non renseignée"}
                                  {attachment.sha256 ? ` · ${String(attachment.sha256).slice(0, 16)}` : ""}
                                </div>
                              </div>
                              <StatusPill status={active ? "info" : "muted"} label={kind.toUpperCase()} />
                            </div>
                          </button>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <SecondaryButton
                              onClick={() => void downloadPurchaseAttachment(attachment, filename, canOpenInline)}
                              disabled={purchaseDownloadBusy === attachmentId}
                            >
                              <Download className="w-3.5 h-3.5" />
                              {purchaseDownloadBusy === attachmentId
                                ? canOpenInline
                                  ? "Ouverture..."
                                  : "Téléchargement..."
                                : canOpenInline
                                  ? "Ouvrir"
                                  : "Télécharger"}
                            </SecondaryButton>
                            <SecondaryButton
                              disabled={purchaseProofUploading || actionBusy}
                              onClick={() => {
                                setPurchaseReplaceAttachmentId(attachmentId);
                                purchaseProofInputRef.current?.click();
                              }}
                            >
                              <Upload className="h-3.5 w-3.5" />
                              Changer
                            </SecondaryButton>
                            <DangerButton
                              disabled={actionBusy}
                              onClick={() => void deletePurchaseAttachment(attachment)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Supprimer
                            </DangerButton>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>

              {!isPurchasesView ? (
                <Card className="h-full">
                  <SectionTitle>Historique</SectionTitle>
                  {(item.events || []).length === 0 ? (
                    <p className="text-[#94a3b8] text-sm">Aucun événement pour le moment.</p>
                  ) : (
                    <div className="space-y-3">
                      {(item.events || []).map((event: any) => (
                        <div key={event.id} className="p-3 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[#0f172a] text-sm font-semibold">{inboxEventLabel(event.type)}</div>
                            <div className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                              {formatDateTimeFr(event.created_at)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              ) : null}
            </>
          </div>
        </div>
      )}
    </>
  );
}

export function InboxPage() {
  const invoiceId = useRouteId();
  const location = useLocation();
  const isPurchasesView = location.pathname.startsWith("/app/purchases");
  const basePath = isPurchasesView ? "/app/purchases" : "/app/inbox";
  const { capabilities, loading: sessionLoading } = useSession();
  const inboxGate = resolveProFeatureGate(capabilities, isPurchasesView ? "purchases" : "einvoicing");
  const featureBlocked = !sessionLoading && !inboxGate.enabled;
  const [purchaseHeaderReadiness, setPurchaseHeaderReadiness] = useState<any>(null);
  const handlePurchaseHeaderReadiness = useCallback((readiness: any) => {
    setPurchaseHeaderReadiness(readiness || null);
  }, []);
  const purchaseHeaderActions =
    isPurchasesView && !invoiceId && !featureBlocked ? (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("pixfacture:purchases-references"))}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#bbf7d0] bg-white px-3 text-[#15803d] transition-colors hover:bg-[#f0fdf4]"
          style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
          data-testid="purchase-action-references"
        >
          <Building2 className="h-3.5 w-3.5" />
          Fournisseurs & règles
        </button>
        <ActionMenu label="Ajouter une dépense" triggerVariant="success" className="shrink-0">
          <ActionMenuButton
            icon={Wallet}
            onClick={() => window.dispatchEvent(new Event("pixfacture:purchases-expense"))}
            data-testid="purchase-action-expense"
          >
            Ajouter une note de frais
          </ActionMenuButton>
          <ActionMenuButton
            icon={Car}
            onClick={() => window.dispatchEvent(new Event("pixfacture:purchases-mileage"))}
            data-testid="purchase-action-mileage"
          >
            Ajouter des frais kilométriques
          </ActionMenuButton>
        </ActionMenu>
      </div>
    ) : null;

  useEffect(() => {
    setPurchaseHeaderReadiness(null);
  }, [invoiceId, isPurchasesView]);

  return (
    <div>
      <AppPageHeader
        title={
          invoiceId
            ? isPurchasesView
              ? "Achat fournisseur"
              : "Détail facture reçue"
            : isPurchasesView
              ? "Achats"
              : "Réception e-factures"
        }
        breadcrumb={isPurchasesView ? "Achats" : "E-facturation"}
        badge={
          isPurchasesView && invoiceId && purchaseHeaderReadiness ? (
            <div data-testid="purchase-accounting-header-badge">
              <AccountingReadinessPanel readiness={purchaseHeaderReadiness} compact />
            </div>
          ) : undefined
        }
        description={
          invoiceId
            ? undefined
            : isPurchasesView
              ? "Ajoutez vos factures fournisseurs, vérifiez-les, puis suivez leur paiement sans connexion bancaire obligatoire."
              : "Réception fournisseur : import manuel, réception connectée et suivi de validation."
        }
        backHref={invoiceId ? basePath : undefined}
        actions={
          featureBlocked ? (
            <StatusPill status="warn" label={inboxGate.statusLabel} />
          ) : (
            purchaseHeaderActions || undefined
          )
        }
      />
      <WorkbenchPage>
        {sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : featureBlocked ? (
          <UpgradeNoticeCard
            title={
              inboxGate.reactivationRequired
                ? inboxGate.statusLabel
                : isPurchasesView
                  ? "Achats fournisseurs réservés au plan Pro"
                  : "Réception e-factures réservée au plan Pro"
            }
            description={
              inboxGate.reactivationDescription ||
              (isPurchasesView
                ? "Le plan Starter reste centré sur la création de devis et factures. Le suivi des achats fournisseurs, les justificatifs et les contrôles comptables fournisseurs sont inclus dans le plan Pro."
                : "Le plan Starter ne transmet ni ne reçoit de flux e-facture. La réception connectée, les contrôles fournisseurs et les actions Seqino sont disponibles avec le plan Pro.")
            }
            ctaLabel={inboxGate.ctaLabel}
            ctaHref={inboxGate.ctaHref}
            note={inboxGate.reactivationNote || "Le plan Starter garde la génération de devis et factures classiques."}
          />
        ) : invoiceId ? (
          <InboxDetailView invoiceId={invoiceId} onPurchaseHeaderReadiness={handlePurchaseHeaderReadiness} />
        ) : (
          <InboxListView />
        )}
      </WorkbenchPage>
    </div>
  );
}

export function EReportingPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [reportType, setReportType] = useState("transaction");
  const [busy, setBusy] = useState<string | null>(null);
  const [asyncProgress, setAsyncProgress] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const eReportingSendOperational = einvoicingEnabled && Boolean(capabilities?.seqino_operational);

  const load = useCallback(async () => {
    if (!einvoicingEnabled) {
      setReports([]);
      setEvents([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [reportsRes, eventsRes] = await Promise.allSettled([
        readJson("/api/e-reporting/reports?page=1&page_size=50"),
        readJson("/api/e-reporting?page=1&page_size=20"),
      ]);
      const messages: string[] = [];
      if (reportsRes.status === "fulfilled")
        setReports(Array.isArray(reportsRes.value?.items) ? reportsRes.value.items : []);
      else {
        setReports([]);
        messages.push(formatApiError(reportsRes.reason, "Rapports indisponibles."));
      }
      if (eventsRes.status === "fulfilled")
        setEvents(Array.isArray(eventsRes.value?.items) ? eventsRes.value.items : []);
      else setEvents([]);
      setError(messages[0] || null);
    } finally {
      setLoading(false);
    }
  }, [einvoicingEnabled]);

  useEffect(() => {
    if (sessionLoading) return;
    void load();
  }, [load, sessionLoading]);

  const monthBounds = (value: string) => {
    const [yearRaw, monthRaw] = (value || "").split("-");
    const year = Number(yearRaw);
    const monthIndex = Number(monthRaw);
    if (!year || !monthIndex) return null;
    const start = new Date(Date.UTC(year, monthIndex - 1, 1));
    const end = new Date(Date.UTC(year, monthIndex, 0));
    return {
      period_start: start.toISOString().slice(0, 10),
      period_end: end.toISOString().slice(0, 10),
    };
  };

  const generate = async () => {
    const bounds = monthBounds(month);
    if (!bounds) return;
    setBusy("generate");
    setError(null);
    setNotice(null);
    setAsyncProgress("Préparation du rapport à partir de la période sélectionnée.");
    let keepProgress = false;
    try {
      const result: any = await api("/api/e-reporting/reports/generate", {
        method: "POST",
        body: JSON.stringify({ ...bounds, report_type: reportType }),
      });
      keepProgress = Boolean(result?.job_id);
      setAsyncProgress(
        result?.job_id
          ? "Rapport pris en charge. La liste est rechargée et le statut restera visible dans l’historique."
          : "Rapport généré, rechargement de la liste.",
      );
      setNotice("Génération lancée. Son avancement reste visible dans l’historique.");
      await load();
      if (keepProgress) {
        window.setTimeout(() => setAsyncProgress(null), 5000);
      }
    } catch (err) {
      setError(formatApiError(err, "Génération impossible."));
      keepProgress = false;
    } finally {
      setBusy(null);
      if (!keepProgress) setAsyncProgress(null);
    }
  };

  const sendReport = async (reportId: string) => {
    if (!eReportingSendOperational) return;
    setBusy(reportId);
    setError(null);
    setNotice(null);
    setAsyncProgress("Préparation de l'envoi e-reporting.");
    let keepProgress = false;
    try {
      const result: any = await api(`/api/e-reporting/reports/${reportId}/send`, { method: "POST" });
      keepProgress = Boolean(result?.job_id);
      setAsyncProgress(
        result?.job_id
          ? "Envoi pris en charge. Le statut du rapport se mettra à jour dans la liste."
          : "Envoi lancé, rechargement du statut.",
      );
      setNotice("Envoi lancé. Son avancement reste visible dans l’historique.");
      await load();
      if (keepProgress) {
        window.setTimeout(() => setAsyncProgress(null), 5000);
      }
    } catch (err) {
      setError(formatApiError(err, "Envoi impossible."));
      keepProgress = false;
    } finally {
      setBusy(null);
      if (!keepProgress) setAsyncProgress(null);
    }
  };

  const downloadEReportingExport = async (path: string, filename: string, label: string) => {
    setExportBusy(label);
    setError(null);
    setNotice(null);
    setAsyncProgress(`Préparation de l'export ${label}.`);
    try {
      await downloadProtectedFile(path, filename);
      setNotice(`Export ${label} lancé.`);
    } catch (err) {
      setError(formatApiError(err, "Export e-reporting impossible."));
    } finally {
      setExportBusy(null);
      window.setTimeout(() => setAsyncProgress(null), 700);
    }
  };

  const sentCount = reports.filter((report) =>
    ["sent", "completed"].includes((report.status || "").toLowerCase()),
  ).length;
  const failedCount = reports.filter((report) =>
    ["failed", "error"].includes((report.status || "").toLowerCase()),
  ).length;
  const pendingCount = reports.length - sentCount - failedCount;
  const bounds = monthBounds(month);

  return (
    <div>
      <AppPageHeader
        title="E-reporting"
        breadcrumb="E-facturation"
        description={
          !sessionLoading && einvoicingEnabled && !eReportingSendOperational
            ? "Génération et export e-reporting disponibles ; aucun envoi connecté n’est activé pour le moment."
            : "E-reporting en beta Pro selon périmètre. Envoi connecté selon connecteur actif, mandat, configuration et jetons."
        }
        actions={
          sessionLoading ? null : einvoicingEnabled ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!eReportingSendOperational ? <StatusPill status="info" label="Mode export" /> : null}
              <SecondaryButton onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
              </SecondaryButton>
            </div>
          ) : (
            <StatusPill status="warn" label={einvoicingGate.statusLabel} />
          )
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={einvoicingGate.reactivationRequired ? einvoicingGate.statusLabel : "E-reporting disponible avec Pro"}
            description={
              einvoicingGate.reactivationDescription ||
              "Votre plan actuel permet la facturation classique, les devis, factures PDF et exports de base. Passez Pro pour générer, exporter ou envoyer des rapports e-reporting selon votre configuration."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={einvoicingGate.reactivationNote || undefined}
          />
        ) : (
          <>
            {!eReportingSendOperational ? <ExportOnlyModeNotice seqinoOnly /> : null}
            {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
            {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
            {asyncProgress ? (
              <NoticeBanner
                tone="info"
                title={
                  busy === "generate" ? "Génération e-reporting" : busy ? "Envoi e-reporting" : "Export e-reporting"
                }
              >
                <span className="inline-flex items-center gap-2">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  {asyncProgress}
                </span>
              </NoticeBanner>
            ) : null}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Rapports"
                value={reports.length}
                sub="Périodes générées"
                accent="blue"
                icon={<FileText className="w-4 h-4" />}
              />
              <StatCard
                label="Envoyés"
                value={sentCount}
                sub="Succès"
                accent="green"
                icon={<CheckCircle className="w-4 h-4" />}
              />
              <StatCard
                label="En attente"
                value={pendingCount}
                sub="À traiter"
                accent="amber"
                icon={<RefreshCw className="w-4 h-4" />}
              />
              <StatCard
                label="Événements"
                value={events.length}
                sub="Historique récent"
                accent="purple"
                icon={<Mail className="w-4 h-4" />}
              />
            </div>

            <Card>
              <SectionTitle>Générer un rapport</SectionTitle>
              <div className="grid md:grid-cols-3 gap-4 items-end">
                <div>
                  <label className="block text-[#374151] mb-1.5 text-sm font-medium">Mois</label>
                  <input
                    type="month"
                    value={month}
                    onChange={(event) => setMonth(event.target.value)}
                    className="w-full px-3.5 py-2.5 border border-[#e2e8f0] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] text-sm"
                  />
                </div>
                <SelectField label="Type" value={reportType} onChange={(event) => setReportType(event.target.value)}>
                  <option value="transaction">Transactions</option>
                  <option value="payment">Paiements</option>
                </SelectField>
                <div className="flex gap-2">
                  <PrimaryButton disabled={busy === "generate"} onClick={() => void generate()}>
                    {busy === "generate" ? "Génération…" : "Générer"}
                  </PrimaryButton>
                  {bounds ? (
                    <SecondaryButton
                      disabled={Boolean(exportBusy)}
                      onClick={() =>
                        void downloadEReportingExport(
                          `/api/e-reporting/export?format=json&period_start=${bounds.period_start}&period_end=${bounds.period_end}`,
                          `ereporting-${month}.json`,
                          `période ${month}`,
                        )
                      }
                    >
                      {exportBusy === `période ${month}` ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <FileDown className="w-3.5 h-3.5" />
                      )}
                      {exportBusy === `période ${month}` ? "Export..." : "Exporter la période"}
                    </SecondaryButton>
                  ) : null}
                </div>
              </div>
            </Card>

            {loading ? (
              <LoadingCard label="Chargement des rapports e-reporting…" />
            ) : (
              <div className="grid xl:grid-cols-[1.2fr_1fr] gap-6 items-start">
                <Card>
                  <SectionTitle>Rapports générés</SectionTitle>
                  {reports.length === 0 ? (
                    <SectionEmpty
                      title="Aucun rapport"
                      description="Générez une première période pour contrôler les données et préparer l’export."
                    />
                  ) : (
                    <DataTable headers={["Type", "Période", "Statut", "Lignes", "Dernière tentative", "Action"]}>
                      {reports.map((report) => (
                        <tr key={report.id} className="hover:bg-[#f8fafc] transition-colors">
                          <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                            {titleCase(report.report_type)}
                          </td>
                          <td className="px-4 py-3 text-[#374151] text-sm">
                            {formatDateFr(report.period_start)} → {formatDateFr(report.period_end)}
                          </td>
                          <td className="px-4 py-3">
                            <StatusPill {...ereportingPill(report.status)} />
                          </td>
                          <td className="px-4 py-3 text-[#374151] text-sm">{report.line_count ?? "—"}</td>
                          <td className="px-4 py-3 text-[#64748b] text-xs">
                            {formatDateTimeFr(report.last_attempt_at || report.updated_at)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2">
                              <SecondaryButton
                                className="!px-3 !py-1.5"
                                disabled={Boolean(exportBusy)}
                                onClick={() =>
                                  void downloadEReportingExport(
                                    `/api/e-reporting/reports/${report.id}/export`,
                                    `${report.report_type}-${report.id}.json`,
                                    `rapport ${report.report_type}`,
                                  )
                                }
                              >
                                {exportBusy === `rapport ${report.report_type}` ? (
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Download className="w-3.5 h-3.5" />
                                )}
                                {exportBusy === `rapport ${report.report_type}` ? "Export..." : "Exporter le rapport"}
                              </SecondaryButton>
                              {eReportingSendOperational ? (
                                <PrimaryButton
                                  className="!px-3 !py-1.5"
                                  disabled={busy === report.id}
                                  onClick={() => void sendReport(report.id)}
                                >
                                  <Send className="w-3.5 h-3.5" /> {busy === report.id ? "Envoi…" : "Envoyer"}
                                </PrimaryButton>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                  )}
                </Card>

                <Card>
                  <SectionTitle>Événements récents</SectionTitle>
                  {events.length === 0 ? (
                    <p className="text-[#94a3b8] text-sm">Aucun événement e-reporting enregistré.</p>
                  ) : (
                    <div className="space-y-3">
                      {events.map((event) => (
                        <div key={event.id} className="p-3 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[#0f172a] text-sm font-semibold">{titleCase(event.type)}</div>
                              <div className="text-[#64748b] mt-0.5 text-xs">
                                {event.amounts?.total_ttc ? money(event.amounts.total_ttc) : "Montant non renseigné"}
                              </div>
                            </div>
                            <StatusPill {...ereportingPill(event.status)} />
                          </div>
                          <div className="text-[#94a3b8] mt-2" style={{ fontSize: "0.6875rem" }}>
                            {formatDateTimeFr(event.created_at)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ConformiteAppPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const einvoicingGate = resolveProFeatureGate(capabilities, "einvoicing");
  const einvoicingEnabled = einvoicingGate.enabled;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const readinessRes = await readJson("/api/readiness");
      setReadiness(readinessRes || null);
    } catch (err) {
      setError(formatApiError(err, "Checklist de conformité indisponible."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionLoading) return;
    if (!einvoicingEnabled) {
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [einvoicingEnabled, sessionLoading]);

  const items = readiness?.items || [];
  const blockingCount = items.filter((item: any) => item.status === "missing" && item.severity === "p0").length;
  const warningCount = items.filter(
    (item: any) => item.status === "warning" || (item.status === "missing" && item.severity !== "p0"),
  ).length;
  const status = compliancePill(readiness?.status);

  return (
    <div>
      <AppPageHeader
        title="Conformité e-facturation"
        breadcrumb="Conformité"
        description="Vérifiez les informations nécessaires avant de générer ou transmettre une facture électronique."
        actions={
          einvoicingEnabled ? (
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          ) : null
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-6">
        {!sessionLoading && !einvoicingEnabled ? (
          <UpgradeNoticeCard
            title={
              einvoicingGate.reactivationRequired
                ? einvoicingGate.statusLabel
                : "Contrôles e-facturation réservés au plan Pro"
            }
            description={
              einvoicingGate.reactivationDescription ||
              "Starter permet la facturation classique et les PDF. Les contrôles Factur-X, UBL et la préparation e-facturation sont disponibles avec Pro."
            }
            ctaLabel={einvoicingGate.ctaLabel}
            ctaHref={einvoicingGate.ctaHref}
            note={einvoicingGate.reactivationNote || undefined}
          />
        ) : null}
        {einvoicingEnabled && error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}

        {einvoicingEnabled ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              label="Statut global"
              value={status.label}
              sub={readiness?.next_action || "Aucune action prioritaire"}
              accent={status.color === "ok" ? "green" : status.color === "danger" ? "red" : "amber"}
              icon={<Shield className="w-4 h-4" />}
            />
            <StatCard
              label="À corriger"
              value={blockingCount}
              sub="Nécessaire avant utilisation"
              accent={blockingCount ? "red" : "green"}
              icon={<AlertCircle className="w-4 h-4" />}
            />
            <StatCard
              label="À vérifier"
              value={warningCount}
              sub="Informations à compléter"
              accent={warningCount ? "amber" : "green"}
              icon={<CheckCircle className="w-4 h-4" />}
            />
          </div>
        ) : null}

        {sessionLoading ? (
          <LoadingCard label="Chargement des droits…" />
        ) : !einvoicingEnabled ? null : loading ? (
          <LoadingCard label="Chargement de la conformité…" />
        ) : (
          <div className="grid xl:grid-cols-[1.2fr_1fr] gap-6 items-start">
            <Card>
              <SectionTitle>Checklist détaillée</SectionTitle>
              {items.length === 0 ? (
                <p className="text-[#94a3b8] text-sm">Aucune checklist disponible.</p>
              ) : (
                <DataTable headers={["Contrôle", "Statut", "Priorité", "Informations manquantes", "Action conseillée"]}>
                  {items.map((item: any) => (
                    <tr key={item.key} className="hover:bg-[#f8fafc] transition-colors">
                      <td className="px-4 py-3 text-[#0f172a] text-sm font-semibold">
                        {item.label || titleCase(item.key)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill {...readinessCheckPill(item.status)} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill
                          status={item.severity === "p0" ? "danger" : "warn"}
                          label={item.severity === "p0" ? "Prioritaire" : "À vérifier"}
                        />
                      </td>
                      <td className="px-4 py-3 text-[#64748b]" style={{ fontSize: "0.75rem", maxWidth: 260 }}>
                        {item.missing_fields?.length ? item.missing_fields.join(", ") : "—"}
                      </td>
                      <td className="px-4 py-3 text-[#64748b]" style={{ fontSize: "0.75rem", maxWidth: 280 }}>
                        {item.next_action || "—"}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Card>

            <div className="space-y-6">
              <Card>
                <SectionTitle>Actions utiles</SectionTitle>
                <div className="flex flex-col gap-3">
                  <ActionLink to="/app/einvoicing">Ouvrir la checklist</ActionLink>
                  <ActionLink to="/app/settings/export" className="!bg-[#059669]">
                    Dossier comptable
                  </ActionLink>
                  <ActionLink to="/app/invoices" className="!bg-[#7c3aed]">
                    Tester sur une facture
                  </ActionLink>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
