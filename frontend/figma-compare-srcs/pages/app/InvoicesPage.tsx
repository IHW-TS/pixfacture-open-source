import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { AppPageHeader, StatusPill, NoticeBanner } from "../../components/app/AppPageHeader";
import { ActionMenu, ActionMenuButton, ActionMenuLink } from "../../../src/figma/app/components/app/AppPageHeader";
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  FileText,
  CheckCircle2,
  Clock,
  ArrowRight,
  Download,
  Search,
  Check,
  CheckSquare,
  SlidersHorizontal,
  Columns3,
  Euro,
  UserRound,
  Copy,
  Mail,
  Wallet,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { api, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { downloadProtectedFile } from "@/lib/download";
import { emailDeliveryProof } from "@/lib/emailDeliveryProof";
import { useHydrated } from "@/lib/useHydrated";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import {
  SalesListBlock,
  SalesMetricCard,
  SalesMetricsGrid,
  SalesPeriodControl,
  getSalesTheme,
} from "../../../src/figma/app/components/app/SalesModuleLayout";
import { GuidanceTooltip } from "../../../src/figma/app/components/app/GuidanceTooltip";
import { can } from "@/lib/permissions";
import { useSession } from "@/lib/useSession";
import { isTrialSubscription, TRIAL_LIVE_ACTION_MESSAGE } from "@/lib/trialMode";

const statusMap: Record<string, { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" }> = {
  draft: { label: "Brouillon", color: "muted" },
  issued: { label: "Émise", color: "warn" },
  sent: { label: "Envoyée", color: "info" },
  paid: { label: "Payée", color: "ok" },
  overdue: { label: "En retard", color: "danger" },
  partial: { label: "Partielle", color: "warn" },
  canceled: { label: "Annulée", color: "muted" },
};

type InvoiceExportFormat = "csv" | "fec" | "edi-ubl" | "edi-cii" | "archive";
type InvoiceExportScope = "filtered" | "selection";
type InvoiceDocumentTypeFilter = "all" | "invoice" | "credit_note";
type CustomerOption = { id: string; name?: string; email?: string };
type InvoiceMetricCardKey = "created" | "collected" | "pending" | "overdue";
type InvoiceMetricPeriodPreset =
  | "current_month"
  | "previous_month"
  | "last_30_days"
  | "current_quarter"
  | "current_year"
  | "custom_month";
type InvoiceColumnKey =
  | "issue_date"
  | "due_date"
  | "customer"
  | "status"
  | "total_ht"
  | "total_ttc"
  | "currency"
  | "purchase_order_number"
  | "sent_at"
  | "paid_at"
  | "reminder_count"
  | "public_view_count";
type InvoiceSortKey = InvoiceColumnKey | "number" | "followup";
type SortDirection = "asc" | "desc";

const INVOICE_COLUMNS_STORAGE_ID = "pixfacture.invoices.visibleColumns.v4";
const INVOICE_FILTERS_OPEN_STORAGE_ID = "pixfacture.invoices.filtersOpen.v3";
const INVOICE_PAGE_SIZE_STORAGE_ID = "pixfacture.invoices.pageSize.v1";
const INVOICE_METRIC_PERIOD_STORAGE_ID = "pixfacture.invoices.metricPeriod.v1";
const INVOICE_METRIC_MONTH_STORAGE_ID = "pixfacture.invoices.metricMonth.v1";
const INVOICE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const PAYMENT_STATUS_FILTERS = new Set(["pending", "partial", "paid", "overdue"]);
const PAYMENT_ONLY_COLUMNS = new Set<InvoiceColumnKey>(["paid_at", "reminder_count"]);

const invoiceMetricPeriodOptions: { value: InvoiceMetricPeriodPreset; label: string }[] = [
  { value: "current_month", label: "Ce mois" },
  { value: "previous_month", label: "Mois précédent" },
  { value: "last_30_days", label: "30 jours" },
  { value: "current_quarter", label: "Trimestre" },
  { value: "current_year", label: "Année" },
  { value: "custom_month", label: "Mois précis" },
];

const invoiceDocumentTypeOptions: { value: InvoiceDocumentTypeFilter; label: string }[] = [
  { value: "invoice", label: "Factures" },
  { value: "credit_note", label: "Avoirs" },
];

const invoiceMetricCardLabels: Record<InvoiceMetricCardKey, string> = {
  created: "Factures créées",
  collected: "Paiements collectés",
  pending: "Factures à encaisser",
  overdue: "Factures en retard",
};

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function toDateInputValue(value: Date) {
  return `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())}`;
}

function toMonthInputValue(value: Date) {
  return `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}`;
}

function readStoredMetricPeriod(): InvoiceMetricPeriodPreset {
  if (typeof window === "undefined") return "current_month";
  try {
    const raw = window.localStorage.getItem(INVOICE_METRIC_PERIOD_STORAGE_ID) as InvoiceMetricPeriodPreset | null;
    return raw && invoiceMetricPeriodOptions.some((option) => option.value === raw) ? raw : "current_month";
  } catch {
    return "current_month";
  }
}

function readStoredMetricMonth() {
  if (typeof window === "undefined") return toMonthInputValue(new Date());
  try {
    const raw = window.localStorage.getItem(INVOICE_METRIC_MONTH_STORAGE_ID);
    return raw && /^\d{4}-\d{2}$/.test(raw) ? raw : toMonthInputValue(new Date());
  } catch {
    return toMonthInputValue(new Date());
  }
}

function getMonthRange(monthValue: string) {
  const fallback = toMonthInputValue(new Date());
  const [yearRaw, monthRaw] = (monthValue || fallback).split("-");
  const year = Number(yearRaw) || new Date().getFullYear();
  const monthIndex = Math.min(11, Math.max(0, (Number(monthRaw) || 1) - 1));
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  const label = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(start);
  return { start: toDateInputValue(start), end: toDateInputValue(end), label };
}

function getMetricPeriodRange(period: InvoiceMetricPeriodPreset, selectedMonth: string) {
  const today = new Date();
  if (period === "previous_month") {
    return getMonthRange(toMonthInputValue(new Date(today.getFullYear(), today.getMonth() - 1, 1)));
  }
  if (period === "last_30_days") {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return {
      start: toDateInputValue(start),
      end: toDateInputValue(today),
      label: "30 derniers jours",
    };
  }
  if (period === "current_quarter") {
    const quarterIndex = Math.floor(today.getMonth() / 3);
    const start = new Date(today.getFullYear(), quarterIndex * 3, 1);
    const end = new Date(today.getFullYear(), quarterIndex * 3 + 3, 0);
    return {
      start: toDateInputValue(start),
      end: toDateInputValue(end),
      label: `T${quarterIndex + 1} ${today.getFullYear()}`,
    };
  }
  if (period === "current_year") {
    return {
      start: `${today.getFullYear()}-01-01`,
      end: `${today.getFullYear()}-12-31`,
      label: `${today.getFullYear()}`,
    };
  }
  if (period === "custom_month") {
    return getMonthRange(selectedMonth);
  }
  return getMonthRange(toMonthInputValue(today));
}

const defaultInvoiceColumns: Record<InvoiceColumnKey, boolean> = {
  issue_date: true,
  due_date: true,
  customer: true,
  status: true,
  total_ht: false,
  total_ttc: true,
  currency: false,
  purchase_order_number: false,
  sent_at: false,
  paid_at: false,
  reminder_count: false,
  public_view_count: false,
};

function readStoredInvoiceColumns(): Record<InvoiceColumnKey, boolean> {
  if (typeof window === "undefined") return defaultInvoiceColumns;
  try {
    const raw = window.localStorage.getItem(INVOICE_COLUMNS_STORAGE_ID);
    if (!raw) return defaultInvoiceColumns;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultInvoiceColumns;
    return { ...defaultInvoiceColumns, ...parsed };
  } catch {
    return defaultInvoiceColumns;
  }
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function readStoredPageSize() {
  if (typeof window === "undefined") return 10;
  try {
    const value = Number(window.localStorage.getItem(INVOICE_PAGE_SIZE_STORAGE_ID));
    return INVOICE_PAGE_SIZE_OPTIONS.includes(value as (typeof INVOICE_PAGE_SIZE_OPTIONS)[number]) ? value : 10;
  } catch {
    return 10;
  }
}

const invoiceColumnOptions: { key: InvoiceColumnKey; label: string }[] = [
  { key: "issue_date", label: "Date d'émission" },
  { key: "due_date", label: "Échéance" },
  { key: "customer", label: "Client" },
  { key: "status", label: "Statut" },
  { key: "purchase_order_number", label: "N° commande" },
  { key: "sent_at", label: "Envoyée" },
  { key: "paid_at", label: "Payée le" },
  { key: "reminder_count", label: "Relances" },
  { key: "public_view_count", label: "Vues portail" },
  { key: "total_ht", label: "Total HT" },
  { key: "total_ttc", label: "Total TTC" },
  { key: "currency", label: "Devise" },
];

const invoiceTableHeaderStyle = {
  fontSize: "var(--pf-app-table-header)",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "#94a3b8",
  background: "#fafbfe",
};

const invoiceTableHeaderLabelStyle = {
  fontSize: "var(--pf-app-table-header)",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  lineHeight: 1.15,
  color: "#94a3b8",
};

function InvoiceColumnHeader({
  children,
  align = "left",
  sortKey,
  sortState,
  onSort,
}: {
  children: ReactNode;
  align?: "left" | "center" | "right";
  sortKey?: InvoiceSortKey;
  sortState?: { key: InvoiceSortKey; direction: SortDirection } | null;
  onSort?: (key: InvoiceSortKey) => void;
}) {
  const active = Boolean(sortKey && sortState?.key === sortKey);
  const SortIcon = active ? (sortState?.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  const inner = (
    <>
      <span>{children}</span>
      <SortIcon
        className={`h-3 w-3 ${active ? "text-[#3b82f6]" : "text-[#cbd5e1] group-hover:text-[#3b82f6]"}`}
        aria-hidden="true"
      />
    </>
  );
  if (sortKey && onSort) {
    return (
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Trier par ${children}`}
        aria-pressed={active}
        className={`group inline-flex w-full items-center gap-1.5 transition-colors hover:text-[#2563eb] ${
          align === "right"
            ? "justify-end text-right"
            : align === "center"
              ? "justify-center text-center"
              : "justify-start text-left"
        } ${active ? "pf-sort-header-active pf-sort-header-invoices text-[#2563eb]" : ""}`}
        style={invoiceTableHeaderLabelStyle}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${
        align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start"
      }`}
    >
      {inner}
    </span>
  );
}

function normalizeSortText(value: any) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function sortDateValue(value: any) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function invoiceSortValue(invoice: any, key: InvoiceSortKey) {
  if (key === "number") return normalizeSortText(invoice?.number || invoice?.id || "");
  if (key === "customer") return normalizeSortText(invoice?.customer_name || invoice?.customer?.name || "");
  if (key === "followup") {
    return (
      Number(invoice?.days_overdue || overdueDays(invoice?.due_date) || 0) * 1000 + Number(invoice?.reminder_count || 0)
    );
  }
  if (key === "issue_date") return sortDateValue(invoice?.issue_date);
  if (key === "due_date") return sortDateValue(invoice?.due_date);
  if (key === "sent_at") return sortDateValue(invoice?.sent_at);
  if (key === "paid_at") return sortDateValue(invoice?.paid_at);
  if (key === "reminder_count") return Number(invoice?.reminder_count || 0);
  if (key === "public_view_count") return Number(invoice?.public_view_count || 0);
  if (key === "total_ht") return Number(invoice?.total_ex_vat || 0);
  if (key === "total_ttc") return Number(invoice?.total_inc_vat || 0);
  if (key === "purchase_order_number") return normalizeSortText(invoice?.purchase_order_number || "");
  if (key === "currency") return normalizeSortText(invoice?.currency || "EUR");
  if (key === "status") return normalizeSortText(statusMap[invoice?.status]?.label || invoice?.status || "");
  return "";
}

function compareSortValues(a: any, b: any, direction: SortDirection) {
  const multiplier = direction === "asc" ? 1 : -1;
  if (typeof a === "number" || typeof b === "number") {
    return ((Number(a) || 0) - (Number(b) || 0)) * multiplier;
  }
  return (
    String(a || "").localeCompare(String(b || ""), "fr", {
      numeric: true,
      sensitivity: "base",
    }) * multiplier
  );
}

const invoiceTableCellStyle = {
  fontSize: "var(--pf-app-text-body)",
  fontWeight: 500,
  lineHeight: 1.2,
};

const invoiceAmountCellStyle = {
  ...invoiceTableCellStyle,
  fontVariantNumeric: "tabular-nums" as const,
};

const invoiceExportFormats: Record<
  InvoiceExportFormat,
  { label: string; path: string; hint: string; filename: string; requiresEinvoicing?: boolean; requiresUbl?: boolean }
> = {
  csv: {
    label: "CSV ventes",
    path: "/api/invoices/export.csv",
    hint: "Lignes de factures et montants pour contrôle tableur.",
    filename: "factures.csv",
  },
  fec: {
    label: "FEC (DGFiP)",
    path: "/api/invoices/export.fec",
    hint: "Fichier FEC généré avec les comptes renseignés ou par défaut, à valider avec le cabinet.",
    filename: "factures.fec",
  },
  "edi-ubl": {
    label: "EDI UBL (si activé)",
    path: "/api/invoices/export.edi.zip?format=ubl",
    hint: "XML UBL pour échange technique, si activé sur cet environnement.",
    filename: "factures-ubl.zip",
    requiresEinvoicing: true,
    requiresUbl: true,
  },
  "edi-cii": {
    label: "EDI CII",
    path: "/api/invoices/export.edi.zip?format=cii",
    hint: "XML CII pour échange technique.",
    filename: "factures-cii.zip",
    requiresEinvoicing: true,
  },
  archive: {
    label: "Archive documents (ZIP)",
    path: "/api/company/archive.zip",
    hint: "PDF et pièces générées sur la période. Les XML sont inclus uniquement avec Pro.",
    filename: "archive-documents.zip",
  },
};

function money(value: any, currency = "EUR") {
  return `${Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency === "EUR" ? "€" : currency}`;
}

function compactMoney(value: any, currency = "EUR") {
  return `${Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })} ${currency === "EUR" ? "€" : currency}`;
}

function customerInitials(value: any) {
  const text = String(value || "Client").trim();
  const words = text.split(/\s+/).filter(Boolean);
  return (words.length ? words : ["Client"])
    .map((word) => word.slice(0, 1))
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function customerAvatarColor(value: any) {
  const palette = ["#5B5EF4", "#16C784", "#8B5CF6", "#F59E0B", "#06B6D4", "#EC4899", "#F97316", "#14B8A6"];
  const text = String(value || "Client");
  return palette[text.charCodeAt(0) % palette.length];
}

function invoiceRowTone(status: any) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "overdue") return { iconBg: "#fef2f2", iconColor: "#dc2626", hover: "hover:bg-red-50/30" };
  if (normalized === "paid") return { iconBg: "#ecfdf5", iconColor: "#059669", hover: "hover:bg-emerald-50/20" };
  if (normalized === "draft") return { iconBg: "#f8fafc", iconColor: "#64748b", hover: "hover:bg-[#fafbfe]" };
  return { iconBg: "#eef2ff", iconColor: "#4f46e5", hover: "hover:bg-[#fafbfe]" };
}

function invoiceStatusForPlan(invoice: any, paymentsEnabled: boolean) {
  const status = String(invoice?.status || "").toLowerCase();
  if (paymentsEnabled || !PAYMENT_STATUS_FILTERS.has(status)) return status;
  return invoice?.sent_at ? "sent" : "issued";
}

function overdueDaysLabel(value: any) {
  const days = overdueDays(value);
  return days > 0 ? `+${days}j` : "";
}

function overdueDays(value: any) {
  if (!value) return 0;
  const dueDate = new Date(value);
  if (Number.isNaN(dueDate.getTime())) return 0;
  const today = new Date();
  const dueDay = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const todayDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.floor((todayDay - dueDay) / 86400000);
  return days > 0 ? days : 0;
}

function documentTypeLabel(invoice: any) {
  return invoice?.type === "credit_note" ? "Avoir" : "Facture";
}

function invoiceNumberDisplay(invoice: any) {
  const rawNumber = String(invoice?.number || "").trim();
  const rawReference = String(invoice?.id || "").trim();
  const isDraft = String(invoice?.status || "").toLowerCase() === "draft";
  if (isDraft) {
    return {
      label: "Brouillon",
      title: rawReference ? `Référence provisoire : ${rawReference}` : "Numéro attribué à l'émission",
      missing: false,
    };
  }
  if (!rawNumber) {
    return {
      label: "Sans numéro",
      title: rawReference ? `Référence technique : ${rawReference}` : "Numéro non attribué",
      missing: true,
    };
  }
  return {
    label: rawNumber,
    title: rawReference ? `Référence technique : ${rawReference}` : undefined,
    missing: false,
  };
}

function readInvoiceSearchFromLocation() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || params.get("search") || "";
}

function readInvoiceCustomerFromLocation() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("customer_id") || params.get("client_id") || "";
}

function readInvoiceVatCorrectionFromLocation() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const filterIntent =
    `${params.get("filter") || ""} ${params.get("focus") || ""} ${params.get("tva") || ""}`.toLowerCase();
  return (
    params.get("vat_correction") === "1" ||
    filterIntent.includes("vat_correction") ||
    filterIntent.includes("vat_corrections") ||
    filterIntent.includes("corrections_tva") ||
    filterIntent.includes("tva")
  );
}

function readInvoiceDateFiltersFromLocation() {
  if (typeof window === "undefined") {
    return { start: "", end: "", paidStart: "", paidEnd: "", status: "all" };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    start: params.get("start_date") || "",
    end: params.get("end_date") || "",
    paidStart: params.get("paid_start_date") || "",
    paidEnd: params.get("paid_end_date") || "",
    status: params.get("status") || "all",
  };
}

function customerOptionLabel(customer: CustomerOption) {
  return customer.name || customer.email || customer.id;
}

function isInteractiveRowTarget(target: EventTarget | null) {
  return target instanceof Element
    ? Boolean(target.closest("a,button,input,select,textarea,label,[role='button'],[data-no-row-open='true']"))
    : false;
}

function invoiceFollowupEmailProof(invoice: any) {
  return emailDeliveryProof({
    status: invoice?.last_email_status,
    delivery_mode: invoice?.last_email_delivery_mode,
    provider: invoice?.last_email_provider,
    provider_status: invoice?.last_email_provider_status,
    provider_event_at: invoice?.last_email_provider_event_at,
    sent_at: invoice?.last_email_at,
    error: invoice?.last_email_error,
  });
}

function invoiceFollowupSummary(invoice: any) {
  if (invoice?.type === "credit_note") return null;
  const status = String(invoice?.status || "").toLowerCase();
  const reminders = Number(invoice?.reminder_count || 0);
  const hasReminderTrace = reminders > 0 || Boolean(invoice?.last_reminder_at || invoice?.last_email_status);
  if (["draft", "canceled", "paid"].includes(status) && !hasReminderTrace) return null;
  const days = Number(invoice?.days_overdue || 0) || (status === "overdue" ? overdueDays(invoice?.due_date) : 0);
  const priority =
    days > 0
      ? { label: `Retard ${days}j`, className: "border-red-200 bg-red-50 text-[#dc2626]" }
      : { label: "Suivi", className: "border-[#e2e8f0] bg-[#f8fafc] text-[#64748b]" };
  const proof = invoiceFollowupEmailProof(invoice);
  const proofDate = proof.date ? formatDateTimeFr(proof.date, "") : "";
  const proofLabel =
    proof.status !== "muted"
      ? proofDate
        ? `${proof.shortLabel} · ${proofDate}`
        : proof.shortLabel
      : invoice?.last_reminder_at
        ? `Relancée · ${formatDateTimeFr(invoice.last_reminder_at, "—")}`
        : "Aucun email de relance";
  const proofClassName =
    proof.status === "ok"
      ? "text-[#16a34a]"
      : proof.status === "danger"
        ? "text-[#dc2626]"
        : proof.status === "warn"
          ? "text-[#d97706]"
          : proof.status === "info"
            ? "text-[#1d4ed8]"
            : "text-[#94a3b8]";
  const compactProofLabel =
    proof.status === "muted" && !invoice?.last_reminder_at ? (days > 0 ? "À relancer" : "Aucune relance") : proofLabel;
  return {
    priority,
    scheduleLabel: days > 0 ? "Relance manuelle" : "Aucune prévue",
    proofLabel,
    compactProofLabel,
    proofClassName,
    title: proof.title,
  };
}

export function InvoicesListPage({ initialSearch = "" }: { initialSearch?: string } = {}) {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const { user, capabilities, subscriptionStatus, loading: sessionLoading } = useSession();
  const trialDraftOnly = isTrialSubscription(subscriptionStatus);
  const canWriteInvoices = can(user, "invoices:write");
  const canExportInvoices = can(user, "invoices:export");
  const paymentsEnabled = Boolean(capabilities?.payments_enabled);
  const [items, setItems] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [metricCards, setMetricCards] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowActionBusy, setRowActionBusy] = useState<string | null>(null);
  const routeInitialSearch = initialSearch.trim();
  const [search, setSearch] = useState(() => routeInitialSearch || readInvoiceSearchFromLocation());
  const [statusFilter, setStatusFilter] = useState(() => readInvoiceDateFiltersFromLocation().status);
  const [documentTypeFilter, setDocumentTypeFilter] = useState<InvoiceDocumentTypeFilter>("all");
  const [vatCorrectionFilter, setVatCorrectionFilter] = useState(() => readInvoiceVatCorrectionFromLocation());
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(() => readInvoiceCustomerFromLocation());
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [startDate, setStartDate] = useState(() => readInvoiceDateFiltersFromLocation().start);
  const [endDate, setEndDate] = useState(() => readInvoiceDateFiltersFromLocation().end);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([]);
  const [selectedInvoiceTotals, setSelectedInvoiceTotals] = useState<Record<string, number>>({});
  const [exportToolsOpen, setExportToolsOpen] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(() =>
    readStoredBoolean(INVOICE_FILTERS_OPEN_STORAGE_ID, false),
  );
  const [exportScope, setExportScope] = useState<InvoiceExportScope>("selection");
  const [exportFormat, setExportFormat] = useState<InvoiceExportFormat>("csv");
  const [publicSettings, setPublicSettings] = useState<any>(null);
  const [minTotalHt, setMinTotalHt] = useState("");
  const [maxTotalHt, setMaxTotalHt] = useState("");
  const [paidStartDate, setPaidStartDate] = useState(() => readInvoiceDateFiltersFromLocation().paidStart);
  const [paidEndDate, setPaidEndDate] = useState(() => readInvoiceDateFiltersFromLocation().paidEnd);
  const [visibleColumns, setVisibleColumns] = useState<Record<InvoiceColumnKey, boolean>>(() =>
    readStoredInvoiceColumns(),
  );
  const [pageSize, setPageSize] = useState(() => readStoredPageSize());
  const [metricPeriod, setMetricPeriod] = useState<InvoiceMetricPeriodPreset>(() => readStoredMetricPeriod());
  const [metricMonth, setMetricMonth] = useState(() => readStoredMetricMonth());
  const [activeMetricCard, setActiveMetricCard] = useState<InvoiceMetricCardKey | null>(null);
  const [sortState, setSortState] = useState<{ key: InvoiceSortKey; direction: SortDirection } | null>(null);
  const metricPeriodRange = useMemo(() => getMetricPeriodRange(metricPeriod, metricMonth), [metricMonth, metricPeriod]);
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);
  const ublExportEnabled = Boolean(publicSettings?.ubl_export_enabled);
  const availableInvoiceExportFormats = useMemo(
    () =>
      Object.entries(invoiceExportFormats).filter(
        ([, item]) => (!item.requiresEinvoicing || einvoicingEnabled) && (!item.requiresUbl || ublExportEnabled),
      ),
    [einvoicingEnabled, ublExportEnabled],
  );

  const syncMetricCardFilters = useCallback(
    (metric: InvoiceMetricCardKey) => {
      if (!paymentsEnabled && metric !== "created") return;
      setPage(1);
      setSearch("");
      setSelectedCustomerId("");
      setClientSearch("");
      setClientPickerOpen(false);
      setMinTotalHt("");
      setMaxTotalHt("");

      if (metric === "collected") {
        setStatusFilter("all");
        setStartDate("");
        setEndDate("");
        setPaidStartDate(metricPeriodRange.start);
        setPaidEndDate(metricPeriodRange.end);
        return;
      }

      setPaidStartDate("");
      setPaidEndDate("");
      setStartDate(metricPeriodRange.start);
      setEndDate(metricPeriodRange.end);
      if (metric === "pending") {
        setStatusFilter("pending");
      } else if (metric === "overdue") {
        setStatusFilter("overdue");
      } else {
        setStatusFilter("all");
      }
    },
    [metricPeriodRange.end, metricPeriodRange.start, paymentsEnabled],
  );

  useEffect(() => {
    if (!activeMetricCard || (!paymentsEnabled && activeMetricCard !== "created")) return;
    syncMetricCardFilters(activeMetricCard);
  }, [activeMetricCard, paymentsEnabled, syncMetricCardFilters]);

  useEffect(() => {
    if (paymentsEnabled) return;
    setActiveMetricCard(null);
    setPaidStartDate("");
    setPaidEndDate("");
    setStatusFilter((current) => (PAYMENT_STATUS_FILTERS.has(current) ? "all" : current));
    setSortState((current) =>
      current && (current.key === "followup" || PAYMENT_ONLY_COLUMNS.has(current.key as InvoiceColumnKey))
        ? null
        : current,
    );
  }, [paymentsEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(INVOICE_METRIC_PERIOD_STORAGE_ID, metricPeriod);
  }, [metricPeriod]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(INVOICE_METRIC_MONTH_STORAGE_ID, metricMonth);
  }, [metricMonth]);

  useEffect(() => {
    const query = routeInitialSearch || readInvoiceSearchFromLocation();
    const nextVatCorrection = readInvoiceVatCorrectionFromLocation();
    setPage(1);
    setSearch((current) => (current === query ? current : query));
    setVatCorrectionFilter((current) => (current === nextVatCorrection ? current : nextVatCorrection));
  }, [routeInitialSearch]);

  const load = useCallback(async () => {
    if (sessionLoading) return;
    setLoading(true);
    setError(null);
    setMetricsError(null);
    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String((page - 1) * pageSize));
    if (statusFilter !== "all" && (paymentsEnabled || !PAYMENT_STATUS_FILTERS.has(statusFilter))) {
      params.set("status", statusFilter);
    }
    if (documentTypeFilter !== "all") params.set("document_type", documentTypeFilter);
    if (selectedCustomerId) params.set("customer_id", selectedCustomerId);
    if (search.trim()) params.set("q", search.trim());
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    if (minTotalHt.trim()) params.set("min_total_ht", minTotalHt.trim());
    if (maxTotalHt.trim()) params.set("max_total_ht", maxTotalHt.trim());
    if (paymentsEnabled && paidStartDate) params.set("paid_start_date", paidStartDate);
    if (paymentsEnabled && paidEndDate) params.set("paid_end_date", paidEndDate);
    if (vatCorrectionFilter) params.set("vat_correction", "1");

    const listPromise = rawApi(`/api/invoices?${params.toString()}`);

    try {
      const listRes = await listPromise;
      const listPayload = listRes.ok ? await listRes.json().catch(() => []) : [];
      setItems(Array.isArray(listPayload) ? listPayload : []);
      setTotalCount(Number(listRes.headers.get("x-total-count") || "0") || 0);
      if (!listRes.ok) {
        const payload = await listRes.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, listRes.status, "Impossible de charger les factures."));
      }
    } catch (err) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[invoices] list unavailable", err);
      }
      setItems([]);
      setTotalCount(0);
      setError(formatApiError(err, "Impossible de charger les factures."));
    } finally {
      setLoading(false);
    }

    if (!paymentsEnabled) {
      setMetrics(null);
      setMetricCards(null);
      setMetricsError(null);
      return;
    }

    const metricsParams = new URLSearchParams();
    metricsParams.set("start_date", metricPeriodRange.start);
    metricsParams.set("end_date", metricPeriodRange.end);

    try {
      const metricsPromise = rawApi("/api/invoices/metrics");
      const metricsRes = await metricsPromise;
      const metricsPayload = metricsRes.ok ? await metricsRes.json().catch(() => null) : null;
      setMetrics(metricsPayload || null);
      if (!metricsRes.ok) {
        setMetricsError("Indicateurs facturation indisponibles.");
      }
    } catch (err) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[invoices] metrics unavailable", err);
      }
      setMetrics(null);
      setMetricsError("Indicateurs facturation indisponibles.");
    }

    try {
      const indicatorMetricsPromise = rawApi(`/api/invoices/metrics?${metricsParams.toString()}`);
      const indicatorMetricsRes = await indicatorMetricsPromise;
      const indicatorMetricsPayload = indicatorMetricsRes.ok
        ? await indicatorMetricsRes.json().catch(() => null)
        : null;
      setMetricCards(indicatorMetricsPayload || null);
      if (!indicatorMetricsRes.ok) {
        setMetricsError((current) => current || "Indicateurs de période indisponibles.");
      }
    } catch (err) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[invoices] period metrics unavailable", err);
      }
      setMetricCards(null);
      setMetricsError((current) => current || "Indicateurs de période indisponibles.");
    }
  }, [
    endDate,
    documentTypeFilter,
    maxTotalHt,
    metricPeriodRange.end,
    metricPeriodRange.start,
    minTotalHt,
    page,
    pageSize,
    paymentsEnabled,
    paidEndDate,
    paidStartDate,
    search,
    selectedCustomerId,
    sessionLoading,
    startDate,
    statusFilter,
    vatCorrectionFilter,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    rawApi("/api/settings/public")
      .then(async (res) => {
        const payload = res.ok ? await res.json().catch(() => null) : null;
        if (!cancelled) setPublicSettings(payload || null);
      })
      .catch(() => {
        if (!cancelled) setPublicSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const definition = invoiceExportFormats[exportFormat];
    if ((definition?.requiresEinvoicing && !einvoicingEnabled) || (definition?.requiresUbl && !ublExportEnabled)) {
      setExportFormat("csv");
    }
  }, [einvoicingEnabled, exportFormat, ublExportEnabled]);

  useEffect(() => {
    let cancelled = false;
    rawApi("/api/customers?limit=200&offset=0")
      .then(async (res) => {
        const payload = res.ok ? await res.json().catch(() => []) : [];
        if (!cancelled) setCustomers(Array.isArray(payload) ? payload : []);
      })
      .catch((err) => {
        if (process.env.NODE_ENV === "development") {
          console.warn("[invoices] customer filter unavailable", err);
        }
        if (!cancelled) setCustomers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSelectedInvoiceIds([]);
    setSelectedInvoiceTotals({});
    setExportScope("selection");
  }, [
    endDate,
    maxTotalHt,
    minTotalHt,
    page,
    pageSize,
    paidEndDate,
    paidStartDate,
    search,
    selectedCustomerId,
    startDate,
    statusFilter,
    vatCorrectionFilter,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(INVOICE_COLUMNS_STORAGE_ID, JSON.stringify(visibleColumns));
    } catch {
      // Preferences are optional; the list must keep working when storage is blocked.
    }
  }, [visibleColumns]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(INVOICE_FILTERS_OPEN_STORAGE_ID, String(advancedFiltersOpen));
    } catch {
      // ignore storage failures
    }
  }, [advancedFiltersOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(INVOICE_PAGE_SIZE_STORAGE_ID, String(pageSize));
    } catch {
      // ignore storage failures
    }
  }, [pageSize]);

  const sortedItems = useMemo(() => {
    if (!sortState) return items;
    return [...items].sort((left, right) =>
      compareSortValues(
        invoiceSortValue(left, sortState.key),
        invoiceSortValue(right, sortState.key),
        sortState.direction,
      ),
    );
  }, [items, sortState]);
  const visibleInvoiceIds = useMemo(() => sortedItems.map((item) => item.id).filter(Boolean), [sortedItems]);
  const visibleSelectedInvoiceIds = useMemo(
    () => visibleInvoiceIds.filter((id) => selectedInvoiceIds.includes(id)),
    [selectedInvoiceIds, visibleInvoiceIds],
  );
  const selectedInvoices = useMemo(
    () => sortedItems.filter((item) => visibleSelectedInvoiceIds.includes(String(item.id))),
    [sortedItems, visibleSelectedInvoiceIds],
  );
  const selectedDraftInvoices = useMemo(
    () => selectedInvoices.filter((invoice) => String(invoice.status || "").toLowerCase() === "draft"),
    [selectedInvoices],
  );
  const selectedInvoiceCount = visibleSelectedInvoiceIds.length;
  const visibleSelectedCount = visibleSelectedInvoiceIds.length;
  const allVisibleSelected = visibleInvoiceIds.length > 0 && visibleSelectedCount === visibleInvoiceIds.length;
  const clearExportSelection = () => {
    setSelectedInvoiceIds([]);
    setSelectedInvoiceTotals({});
    setExportScope("selection");
  };

  const toggleExportTools = () => {
    if (exportToolsOpen) {
      setClientPickerOpen(false);
      setClientSearch("");
    }
    setExportToolsOpen((current) => !current);
  };

  const toggleSort = (key: InvoiceSortKey) => {
    setSortState((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  };

  const handleStatusFilterChange = useCallback(
    (value: string) => {
      if (!paymentsEnabled && PAYMENT_STATUS_FILTERS.has(value)) return;
      setPage(1);
      setActiveMetricCard(null);
      if (value === "document:invoice" || value === "document:credit_note") {
        setStatusFilter("all");
        setVatCorrectionFilter(false);
        setDocumentTypeFilter(value === "document:invoice" ? "invoice" : "credit_note");
        return;
      }
      if (value === "all") {
        setDocumentTypeFilter("all");
      }
      if (value === "vat_corrections") {
        setStatusFilter("all");
        setVatCorrectionFilter(true);
        setDocumentTypeFilter("all");
        return;
      }
      setVatCorrectionFilter(false);
      setDocumentTypeFilter("all");
      setStatusFilter(value);
    },
    [paymentsEnabled],
  );

  const toggleInvoiceSelection = (invoice: any) => {
    const invoiceId = invoice.id;
    if (!invoiceId) return;
    setSelectedInvoiceIds((current) =>
      current.includes(invoiceId) ? current.filter((id) => id !== invoiceId) : [...current, invoiceId],
    );
    setSelectedInvoiceTotals((current) => {
      if (selectedInvoiceIds.includes(invoiceId)) {
        const next = { ...current };
        delete next[invoiceId];
        return next;
      }
      return { ...current, [invoiceId]: Number(invoice.total_inc_vat || 0) };
    });
  };

  const toggleVisibleSelection = () => {
    if (allVisibleSelected) {
      clearExportSelection();
      return;
    }
    const nextTotals = sortedItems.reduce((acc: Record<string, number>, item: any) => {
      if (item.id) acc[item.id] = Number(item.total_inc_vat || 0);
      return acc;
    }, {});
    setSelectedInvoiceIds(visibleInvoiceIds);
    setSelectedInvoiceTotals(nextTotals);
    if (visibleInvoiceIds.length > 0) {
      setExportScope("selection");
    }
  };

  const buildExportPath = (scope: InvoiceExportScope = exportScope) => {
    const definition = invoiceExportFormats[exportFormat];
    const [basePath, initialQuery = ""] = definition.path.split("?");
    const params = new URLSearchParams(initialQuery);
    if (scope === "selection") {
      visibleSelectedInvoiceIds.forEach((id) => params.append("invoice_ids", id));
    } else {
      if (search.trim()) params.set("q", search.trim());
      if (statusFilter !== "all" && (paymentsEnabled || !PAYMENT_STATUS_FILTERS.has(statusFilter))) {
        params.set("status", statusFilter);
      }
      if (documentTypeFilter !== "all") params.set("document_type", documentTypeFilter);
      if (selectedCustomerId) params.set("customer_id", selectedCustomerId);
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      if (minTotalHt.trim()) params.set("min_total_ht", minTotalHt.trim());
      if (maxTotalHt.trim()) params.set("max_total_ht", maxTotalHt.trim());
      if (paymentsEnabled && paidStartDate) params.set("paid_start_date", paidStartDate);
      if (paymentsEnabled && paidEndDate) params.set("paid_end_date", paidEndDate);
      if (vatCorrectionFilter) params.set("vat_correction", "1");
    }
    const query = params.toString();
    return `${basePath}${query ? `?${query}` : ""}`;
  };

  const triggerExport = async (requestedScope?: InvoiceExportScope) => {
    if (!canExportInvoices) return;
    const scope = requestedScope === "selection" || requestedScope === "filtered" ? requestedScope : exportScope;
    if (scope === "selection" && selectedInvoiceCount === 0) {
      setError("Sélectionnez au moins une facture avant d'exporter la sélection.");
      return;
    }
    setError(null);
    try {
      await downloadProtectedFile(buildExportPath(scope), invoiceExportFormats[exportFormat].filename);
    } catch (err: any) {
      setError(formatApiError(err, "Export impossible avec les filtres actuels."));
    }
  };

  const triggerSelectedInvoicesExport = () => {
    setExportScope("selection");
    void triggerExport("selection");
  };

  const downloadInvoicePdf = async (invoice: any) => {
    if (!invoice?.id) return;
    setRowActionBusy(`pdf:${invoice.id}`);
    setError(null);
    try {
      await downloadProtectedFile(`/api/invoices/${invoice.id}/pdf`);
    } catch (err: any) {
      setError(formatApiError(err, "Téléchargement PDF impossible."));
    } finally {
      setRowActionBusy(null);
    }
  };

  const deleteDraftInvoices = async (targets: any[]) => {
    if (!canWriteInvoices) return;
    const draftTargets = targets.filter(
      (invoice) => String(invoice?.status || "").toLowerCase() === "draft" && invoice?.id,
    );
    const ignoredCount = Math.max(0, targets.length - draftTargets.length);
    if (draftTargets.length === 0) {
      setError("Sélectionnez au moins une facture brouillon à supprimer.");
      return;
    }
    if (typeof window !== "undefined") {
      const warning = ignoredCount
        ? `\n${ignoredCount} facture non brouillon ne sera pas supprimée.`
        : "\nCette action ne touche pas les factures émises ou envoyées.";
      const confirmed = window.confirm(
        `Supprimer ${draftTargets.length} facture brouillon${draftTargets.length > 1 ? "s" : ""} ?${warning}`,
      );
      if (!confirmed) return;
    }
    setRowActionBusy("delete-draft-invoices");
    setError(null);
    setNotice(null);
    try {
      for (const invoice of draftTargets) {
        await api(`/api/invoices/${invoice.id}`, { method: "DELETE" });
      }
      const deletedIds = new Set(draftTargets.map((invoice) => String(invoice.id)));
      setSelectedInvoiceIds((current) => current.filter((id) => !deletedIds.has(id)));
      setSelectedInvoiceTotals((current) => {
        const next = { ...current };
        deletedIds.forEach((id) => {
          delete next[id];
        });
        return next;
      });
      setNotice(`${draftTargets.length} facture brouillon${draftTargets.length > 1 ? "s supprimées" : " supprimée"}.`);
      await load();
    } catch (err: any) {
      setError(formatApiError(err, "Suppression des brouillons impossible."));
    } finally {
      setRowActionBusy(null);
    }
  };

  const copyInvoicePortalLink = async (invoice: any) => {
    if (!invoice?.id || !canWriteInvoices) return;
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    const status = String(invoice.status || "").toLowerCase();
    if (status === "draft" || status === "canceled") {
      setError("Émettez la facture avant de créer un lien client.");
      return;
    }
    setRowActionBusy(`share:${invoice.id}`);
    setError(null);
    setNotice(null);
    try {
      const current = await rawApi(`/api/invoices/${invoice.id}/share`).catch(() => null);
      const currentPayload = current?.ok ? await current.json().catch(() => null) : null;
      let publicUrl = currentPayload?.public_url || null;
      if (!publicUrl) {
        const enabled: any = await api(`/api/invoices/${invoice.id}/share`, { method: "POST" });
        publicUrl = enabled?.public_url || null;
      }
      if (!publicUrl) {
        throw new Error("Lien client indisponible.");
      }
      await copyTextToClipboard(publicUrl);
      setNotice(`Lien client copié pour ${invoice.number || "la facture"}.`);
    } catch (err: any) {
      setError(formatApiError(err, "Impossible de préparer le lien client."));
    } finally {
      setRowActionBusy(null);
    }
  };

  const invoicePrimaryAction = (invoice: any) => {
    const status = invoiceStatusForPlan(invoice, paymentsEnabled);
    if (!trialDraftOnly && paymentsEnabled && canWriteInvoices && invoice?.type === "invoice" && status === "overdue") {
      return {
        label: "Relancer",
        icon: Mail,
        href: `/app/invoices/${invoice.id}?action=followup`,
        title: "Préparer une relance client",
      };
    }
    if (
      !trialDraftOnly &&
      canWriteInvoices &&
      invoice?.type === "invoice" &&
      status === "issued" &&
      !invoice?.sent_at
    ) {
      return {
        label: "Envoyer",
        icon: Mail,
        href: `/app/invoices/${invoice.id}?action=email`,
        title: "Préparer l'email client",
      };
    }
    if (
      paymentsEnabled &&
      canWriteInvoices &&
      invoice?.type !== "credit_note" &&
      !["draft", "canceled", "paid"].includes(status)
    ) {
      return {
        label: "Encaisser",
        icon: Wallet,
        href: `/app/invoices/${invoice.id}?panel=encaissement`,
        title: "Enregistrer un règlement",
      };
    }
    return {
      label: "Ouvrir",
      icon: ArrowRight,
      href: `/app/invoices/${invoice.id}`,
      title: "Ouvrir le détail",
    };
  };

  const statusFilters = useMemo(() => {
    const visibleCounters = items.reduce((acc: any, invoice: any) => {
      acc[invoice.status] = (acc[invoice.status] || 0) + 1;
      return acc;
    }, {});
    const filteredTotal = Number(totalCount ?? items.length ?? 0);
    const currentStatusCount = (status: string, fallback: any) =>
      statusFilter === status ? filteredTotal : Number(fallback ?? visibleCounters[status] ?? 0);
    const counters = {
      draft: currentStatusCount("draft", metrics?.draft_count),
      issued: currentStatusCount("issued", metrics?.issued_count),
      sent: currentStatusCount("sent", metrics?.sent_count),
      partial: currentStatusCount("partial", metrics?.partial_count),
      paid: currentStatusCount("paid", metrics?.paid_count),
      overdue: currentStatusCount("overdue", metrics?.overdue_count),
      pending: currentStatusCount("pending", metrics?.pending_count),
      canceled: currentStatusCount("canceled", metrics?.canceled_count),
    };
    const quickTabs = [
      {
        val: "all",
        label: "Toutes",
        count: Number(metrics?.total_count ?? totalCount ?? items.length),
        accent: "module" as const,
      },
      {
        val: "vat_corrections",
        label: "Corrections TVA",
        count: vatCorrectionFilter ? Number(totalCount ?? items.length) : undefined,
        accent: "warning" as const,
      },
      { val: "pending", label: "En attente", count: counters.pending || 0, accent: "warning" as const },
      { val: "issued", label: "Émises", count: counters.issued || 0, accent: "info" as const },
      { val: "sent", label: "Envoyées", count: counters.sent || 0, accent: "info" as const },
      { val: "partial", label: "Partielles", count: counters.partial || 0, accent: "warning" as const },
      { val: "paid", label: "Payées", count: counters.paid || 0, accent: "success" as const },
      { val: "overdue", label: "En retard", count: counters.overdue || 0, accent: "danger" as const },
      { val: "draft", label: "Brouillons", count: counters.draft || 0, accent: "muted" as const },
      { val: "canceled", label: "Annulées", count: counters.canceled || 0, accent: "muted" as const },
    ];
    return quickTabs.filter((item) => {
      if (!paymentsEnabled && PAYMENT_STATUS_FILTERS.has(item.val)) return false;
      if (
        item.val === "all" ||
        item.val === "pending" ||
        item.val === "issued" ||
        item.val === "sent" ||
        item.val === "overdue"
      ) {
        return true;
      }
      if (item.val === statusFilter) return true;
      if (item.val === "vat_corrections" && vatCorrectionFilter) return true;
      return Number(item.count || 0) > 0;
    });
  }, [items, metrics, paymentsEnabled, statusFilter, totalCount, vatCorrectionFilter]);

  const listFilters = useMemo(() => {
    const [allFilter, ...remainingStatusFilters] = statusFilters;
    const documentTypeFilters = invoiceDocumentTypeOptions.map((option) => ({
      value: `document:${option.value}`,
      label: option.label,
      accent: option.value === "credit_note" ? ("warning" as const) : ("info" as const),
    }));

    return [
      ...(allFilter
        ? [
            {
              value: allFilter.val,
              label: allFilter.label,
              count: allFilter.count,
              accent: allFilter.accent,
            },
          ]
        : []),
      ...documentTypeFilters,
      ...remainingStatusFilters.map((item) => ({
        value: item.val,
        label: item.label,
        count: item.count,
        accent: item.accent,
      })),
    ];
  }, [statusFilters]);

  const effectiveStatusFilter = !paymentsEnabled && PAYMENT_STATUS_FILTERS.has(statusFilter) ? "all" : statusFilter;
  const listFilterValue =
    vatCorrectionFilter || effectiveStatusFilter !== "all"
      ? vatCorrectionFilter
        ? "vat_corrections"
        : effectiveStatusFilter
      : documentTypeFilter !== "all"
        ? `document:${documentTypeFilter}`
        : "all";

  const totalPages = Math.max(1, Math.ceil((totalCount || 0) / pageSize));
  const selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId) || null;
  const hasActiveListFilters = Boolean(
    effectiveStatusFilter !== "all" ||
    documentTypeFilter !== "all" ||
    vatCorrectionFilter ||
    search.trim() ||
    selectedCustomerId ||
    startDate ||
    endDate ||
    minTotalHt.trim() ||
    maxTotalHt.trim() ||
    (paymentsEnabled && Boolean(paidStartDate)) ||
    (paymentsEnabled && Boolean(paidEndDate)),
  );
  const activeAdvancedFilterCount = [
    documentTypeFilter !== "all",
    effectiveStatusFilter !== "all",
    Boolean(selectedCustomerId),
    Boolean(startDate),
    Boolean(endDate),
    Boolean(minTotalHt.trim()),
    Boolean(maxTotalHt.trim()),
    paymentsEnabled && Boolean(paidStartDate),
    paymentsEnabled && Boolean(paidEndDate),
    vatCorrectionFilter,
  ].filter(Boolean).length;
  const resetListFilters = () => {
    setPage(1);
    setActiveMetricCard(null);
    setSearch("");
    setDocumentTypeFilter("all");
    setStatusFilter("all");
    setVatCorrectionFilter(false);
    setSelectedCustomerId("");
    setClientSearch("");
    setClientPickerOpen(false);
    setStartDate("");
    setEndDate("");
    setMinTotalHt("");
    setMaxTotalHt("");
    setPaidStartDate("");
    setPaidEndDate("");
  };
  const emptyDocumentLabel = documentTypeFilter === "credit_note" ? "avoir" : "facture";
  const cardMetrics = metricCards || metrics || {};
  const periodInvoiceCount = Number(cardMetrics?.total_count ?? 0);
  const periodOverdueCount = Number(cardMetrics?.overdue_count ?? 0);
  const periodPendingCount = Number(cardMetrics?.pending_count ?? 0);
  const paidPeriod = Number(cardMetrics?.paid_period ?? cardMetrics?.paid_month ?? 0);
  const theme = getSalesTheme("invoices");
  const filteredExportCustomers = useMemo(() => {
    const query = clientSearch.trim().toLowerCase();
    if (!query) return customers;
    return customers.filter((customer) => {
      const haystack = `${customer.name || ""} ${customer.email || ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [clientSearch, customers]);
  const selectedCustomerLabel = selectedCustomer ? customerOptionLabel(selectedCustomer) : "Tous les clients";
  const showColumn = (key: InvoiceColumnKey) =>
    (paymentsEnabled || !PAYMENT_ONLY_COLUMNS.has(key)) && visibleColumns[key] !== false;
  const availableInvoiceColumnOptions = invoiceColumnOptions.filter(
    (column) => paymentsEnabled || !PAYMENT_ONLY_COLUMNS.has(column.key),
  );
  const toggleColumn = (key: InvoiceColumnKey) => {
    setVisibleColumns((current) => ({ ...current, [key]: !current[key] }));
  };
  return (
    <div>
      <AppPageHeader
        title="Factures"
        breadcrumb="Vente"
        description="Factures, statuts et suivi d'envoi."
        actions={
          canWriteInvoices ? (
            <div className="flex flex-wrap items-center gap-2">
              <GuidanceTooltip content="Démarrez une facture vierge. Les anciens brouillons se reprennent depuis les modèles ou les factures récentes.">
                <Link
                  to="/app/invoices/new"
                  className="pf-cta-link inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-white transition-all hover:-translate-y-[1px]"
                  style={{
                    fontSize: "var(--pf-app-text-body)",
                    fontWeight: 700,
                    color: "#ffffff",
                    background: theme.gradient,
                    boxShadow: `0 10px 22px -16px ${theme.accent}bb`,
                  }}
                >
                  <Plus className="w-3.5 h-3.5" /> Créer une facture
                </Link>
              </GuidanceTooltip>
            </div>
          ) : null
        }
      />
      <WorkbenchPage>
        <div className="space-y-4">
          {trialDraftOnly ? (
            <NoticeBanner variant="warn" title="Essai Pro · brouillons uniquement">
              {TRIAL_LIVE_ACTION_MESSAGE}{" "}
              <Link to="/app/billing" className="font-extrabold text-[#1d4ed8] hover:underline">
                Choisir un abonnement
              </Link>
            </NoticeBanner>
          ) : null}
          {error ? (
            <NoticeBanner variant="warn" title="Facturation">
              {error}
            </NoticeBanner>
          ) : null}
          {notice ? (
            <NoticeBanner variant="success" title="Action effectuée">
              {notice}
            </NoticeBanner>
          ) : null}
          {paymentsEnabled && metricsError && !error ? (
            <NoticeBanner variant="warn" title="Indicateurs">
              {metricsError} La liste reste disponible.
            </NoticeBanner>
          ) : null}

          {paymentsEnabled ? (
            <SalesMetricsGrid>
              <SalesMetricCard
                tone="invoices"
                density="client"
                label="Factures"
                value={periodInvoiceCount}
                detail={`Créées · ${metricPeriodRange.label}`}
                icon={<FileText className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="invoices"
                density="client"
                accent="success"
                label="Collecté"
                value={money(paidPeriod)}
                detail={`Paiements reçus · ${metricPeriodRange.label}`}
                icon={<CheckCircle2 className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="invoices"
                density="client"
                accent="warning"
                label="En attente"
                value={periodPendingCount}
                detail={`À encaisser · ${metricPeriodRange.label}`}
                icon={<Clock className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="invoices"
                density="client"
                accent="danger"
                label="En retard"
                value={periodOverdueCount}
                detail={`À relancer · ${metricPeriodRange.label}`}
                icon={<FileText className="h-4 w-4" />}
              />
            </SalesMetricsGrid>
          ) : null}

          {paymentsEnabled && activeMetricCard ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border bg-white px-4 py-3"
              style={{
                borderColor: `${theme.border}88`,
                boxShadow: "0 1px 3px rgba(15,23,42,0.04)",
              }}
            >
              <div
                className="text-[#475569]"
                style={{ fontSize: "var(--pf-app-text-body)", lineHeight: "var(--pf-app-line-normal)" }}
              >
                Indicateur affiché :{" "}
                <span className="text-[#0f172a]" style={{ fontWeight: 750 }}>
                  {invoiceMetricCardLabels[activeMetricCard]}
                </span>{" "}
                · {metricPeriodRange.label}
              </div>
              <button
                type="button"
                onClick={resetListFilters}
                className="rounded-xl border border-[#dbeafe] bg-[#eff6ff] px-3 py-1.5 text-[#1d4ed8] transition-colors hover:border-[#bfdbfe]"
                style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
              >
                Réinitialiser la liste
              </button>
            </div>
          ) : null}

          <SalesListBlock
            tone="invoices"
            density="client"
            filters={listFilters}
            filterValue={listFilterValue}
            onFilterChange={handleStatusFilterChange}
            searchValue={search}
            onSearchChange={(value) => {
              setPage(1);
              setActiveMetricCard(null);
              setSearch(value);
            }}
            searchPlaceholder="N°, client, commande..."
            searchWidth="18rem"
            leftExtras={
              selectedInvoiceCount > 0 ? (
                <ActionMenu label="Actions" badge={selectedInvoiceCount} triggerVariant="primary">
                  {canExportInvoices ? (
                    <ActionMenuButton icon={Download} onClick={triggerSelectedInvoicesExport}>
                      Exporter les factures sélectionnées
                    </ActionMenuButton>
                  ) : null}
                  {canWriteInvoices && selectedDraftInvoices.length > 0 ? (
                    <ActionMenuButton
                      icon={Trash2}
                      disabled={rowActionBusy === "delete-draft-invoices"}
                      onClick={() => void deleteDraftInvoices(selectedInvoices)}
                    >
                      Supprimer les brouillons sélectionnés
                    </ActionMenuButton>
                  ) : null}
                  {visibleSelectedInvoiceIds[0] ? (
                    <ActionMenuLink to={`/app/invoices/${visibleSelectedInvoiceIds[0]}`} icon={ArrowRight}>
                      Ouvrir la première facture
                    </ActionMenuLink>
                  ) : null}
                  <ActionMenuButton icon={CheckSquare} onClick={clearExportSelection}>
                    Désélectionner
                  </ActionMenuButton>
                </ActionMenu>
              ) : null
            }
            rightExtras={
              <div className="flex flex-wrap items-center justify-end gap-2">
                {paymentsEnabled ? (
                  <SalesPeriodControl
                    tone="invoices"
                    value={metricPeriod}
                    onChange={(nextValue) => setMetricPeriod(nextValue as InvoiceMetricPeriodPreset)}
                    monthValue={metricMonth}
                    onMonthChange={setMetricMonth}
                    options={invoiceMetricPeriodOptions}
                  />
                ) : null}
                <GuidanceTooltip
                  content={
                    paymentsEnabled
                      ? "Affiche les filtres détaillés : client, dates, montants, paiement et colonnes visibles."
                      : "Affiche les filtres détaillés : client, dates, montants et colonnes visibles."
                  }
                >
                  <button
                    type="button"
                    aria-pressed={advancedFiltersOpen}
                    onClick={() => setAdvancedFiltersOpen((current) => !current)}
                    className={`pf-filter-button inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-3 transition-colors ${
                      advancedFiltersOpen || activeAdvancedFilterCount > 0
                        ? "border-transparent bg-[#EFF0FE] text-[#4A4CE0]"
                        : "border-transparent bg-[#EFF0FE] text-[#4A4CE0]"
                    }`}
                    style={{
                      fontSize: "var(--pf-app-text-body)",
                      fontWeight: 700,
                      color: theme.strong,
                    }}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Filtres
                    {activeAdvancedFilterCount > 0 ? (
                      <span
                        className="rounded-full bg-[#5B5EF4] px-1.5 py-0.5 text-white"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                      >
                        {activeAdvancedFilterCount}
                      </span>
                    ) : null}
                    {advancedFiltersOpen ? (
                      <span className="text-[#1d4ed8]/65" aria-hidden="true">
                        ×
                      </span>
                    ) : null}
                  </button>
                </GuidanceTooltip>
                {canExportInvoices ? (
                  <GuidanceTooltip content="Afficher les options d'export des factures.">
                    <button
                      type="button"
                      onClick={toggleExportTools}
                      aria-label="Exporter les factures"
                      aria-pressed={exportToolsOpen}
                      title="Exporter les factures"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#5B5EF4] text-white shadow-[0_2px_6px_rgba(91,94,244,0.24)] transition-all hover:brightness-95"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  </GuidanceTooltip>
                ) : null}
              </div>
            }
          >
            {advancedFiltersOpen ? (
              <div
                data-testid="invoice-filters-panel"
                className="pf-filter-panel border-b border-[#e5edf5] bg-[#f8fafc]"
              >
                <div className="grid divide-y divide-[#e5edf5] lg:grid-cols-[0.95fr_0.95fr_1fr] lg:divide-x lg:divide-y-0">
                  <section className="px-4 py-4">
                    <div
                      className="mb-3 flex items-center gap-1.5 uppercase tracking-[0.04em] text-[#475569]"
                      style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 700 }}
                    >
                      <UserRound className="h-3.5 w-3.5 text-[#1d4ed8]" /> Qui et quand
                    </div>
                    <div className="space-y-3">
                      <label
                        className="block text-[#64748b]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                      >
                        Client
                        <select
                          value={selectedCustomerId}
                          onChange={(event) => {
                            setPage(1);
                            setActiveMetricCard(null);
                            setSelectedCustomerId(event.target.value);
                          }}
                          className="mt-1 h-9 w-full rounded-xl border border-[#dbeafe] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        >
                          <option value="">Tous les clients</option>
                          {customers.map((customer) => (
                            <option key={customer.id} value={customer.id}>
                              {customerOptionLabel(customer)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                        >
                          Émise dès le
                          <input
                            type="date"
                            value={startDate}
                            onChange={(event) => {
                              setPage(1);
                              setActiveMetricCard(null);
                              setStartDate(event.target.value);
                            }}
                            className="mt-1 h-9 w-full rounded-xl border border-[#dbeafe] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          />
                        </label>
                        <label
                          className="block text-[#64748b]"
                          style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                        >
                          Jusqu'au
                          <input
                            type="date"
                            value={endDate}
                            onChange={(event) => {
                              setPage(1);
                              setActiveMetricCard(null);
                              setEndDate(event.target.value);
                            }}
                            className="mt-1 h-9 w-full rounded-xl border border-[#dbeafe] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                            style={{ fontSize: "var(--pf-app-text-body)" }}
                          />
                        </label>
                      </div>
                    </div>
                  </section>

                  <section className="px-4 py-4">
                    <div
                      className="mb-3 flex items-center gap-1.5 uppercase tracking-[0.04em] text-[#475569]"
                      style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 700 }}
                    >
                      <Euro className="h-3.5 w-3.5 text-[#1d4ed8]" />
                      {paymentsEnabled ? "Montants et paiement" : "Montants"}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label
                        className="block text-[#64748b]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                      >
                        HT min.
                        <input
                          inputMode="decimal"
                          value={minTotalHt}
                          onChange={(event) => {
                            setPage(1);
                            setActiveMetricCard(null);
                            setMinTotalHt(event.target.value);
                          }}
                          placeholder="500"
                          className="mt-1 h-9 w-full rounded-xl border border-[#dbeafe] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        />
                      </label>
                      <label
                        className="block text-[#64748b]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                      >
                        HT max.
                        <input
                          inputMode="decimal"
                          value={maxTotalHt}
                          onChange={(event) => {
                            setPage(1);
                            setActiveMetricCard(null);
                            setMaxTotalHt(event.target.value);
                          }}
                          placeholder="5000"
                          className="mt-1 h-9 w-full rounded-xl border border-[#dbeafe] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        />
                      </label>
                      {paymentsEnabled ? (
                        <>
                          <label
                            className="block text-[#64748b]"
                            style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                          >
                            Payée dès le
                            <input
                              type="date"
                              value={paidStartDate}
                              onChange={(event) => {
                                setPage(1);
                                setActiveMetricCard(null);
                                setPaidStartDate(event.target.value);
                              }}
                              className="mt-1 h-9 w-full rounded-xl border border-[#dbeafe] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                              style={{ fontSize: "var(--pf-app-text-body)" }}
                            />
                          </label>
                          <label
                            className="block text-[#64748b]"
                            style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                          >
                            Jusqu'au
                            <input
                              type="date"
                              value={paidEndDate}
                              onChange={(event) => {
                                setPage(1);
                                setActiveMetricCard(null);
                                setPaidEndDate(event.target.value);
                              }}
                              className="mt-1 h-9 w-full rounded-xl border border-[#dbeafe] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                              style={{ fontSize: "var(--pf-app-text-body)" }}
                            />
                          </label>
                        </>
                      ) : null}
                    </div>
                  </section>

                  <section className="px-4 py-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div
                        className="flex items-center gap-1.5 uppercase tracking-[0.04em] text-[#475569]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 700 }}
                      >
                        <Columns3 className="h-3.5 w-3.5 text-[#1d4ed8]" /> Colonnes affichées
                      </div>
                      {hasActiveListFilters ? (
                        <GuidanceTooltip content="Réinitialise les filtres et revient à la liste complète.">
                          <button
                            type="button"
                            onClick={resetListFilters}
                            className="text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                            style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                          >
                            Réinitialiser
                          </button>
                        </GuidanceTooltip>
                      ) : null}
                    </div>
                    <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
                      {availableInvoiceColumnOptions.map((column) => (
                        <label
                          key={column.key}
                          className="inline-flex min-h-6 items-center gap-2 text-[#334155]"
                          style={{
                            fontSize: "var(--pf-app-text-body)",
                            fontWeight: showColumn(column.key) ? 600 : 500,
                            color: showColumn(column.key) ? "#0f172a" : "#475569",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={showColumn(column.key)}
                            onChange={() => toggleColumn(column.key)}
                            className="h-4 w-4 rounded border-[#cbd5e1] text-[#1d4ed8]"
                            style={{ accentColor: "#1d4ed8" }}
                          />
                          <span>{column.label}</span>
                        </label>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            ) : null}

            {exportToolsOpen && canExportInvoices ? (
              <div data-testid="invoice-export-panel" className="border-b border-[#dbeafe] bg-[#eff6ff] p-3">
                <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-end 2xl:justify-between">
                  <div className="grid flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(240px,1.15fr)_minmax(160px,0.72fr)_minmax(160px,0.72fr)_minmax(220px,1fr)]">
                    <div
                      className="relative text-[#475569]"
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setClientPickerOpen(false);
                        }
                      }}
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                    >
                      <span id="invoice-export-client-label">Client</span>
                      <button
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded={clientPickerOpen}
                        aria-labelledby="invoice-export-client-label invoice-export-client-value"
                        onClick={() => {
                          const nextOpen = !clientPickerOpen;
                          setClientPickerOpen(nextOpen);
                          if (nextOpen) setClientSearch("");
                        }}
                        className="mt-1 flex h-11 w-full items-center justify-between gap-2 rounded-xl border border-[#bfdbfe] bg-white px-3 text-left font-bold text-[#0f172a] outline-none transition-colors hover:border-[#93c5fd] focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                        style={{ fontSize: "var(--pf-app-text-body)" }}
                      >
                        <span id="invoice-export-client-value" className="min-w-0 truncate">
                          {selectedCustomerLabel}
                        </span>
                        <ChevronRight
                          className={`h-3.5 w-3.5 shrink-0 text-[#94a3b8] transition-transform ${clientPickerOpen ? "rotate-90" : ""}`}
                        />
                      </button>
                      {clientPickerOpen ? (
                        <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-40 rounded-2xl border border-[#bfdbfe] bg-white p-2 shadow-[0_18px_44px_-24px_rgba(15,23,42,0.45)]">
                          <label className="relative block">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94a3b8]" />
                            <input
                              autoFocus
                              aria-label="Rechercher un client"
                              value={clientSearch}
                              onChange={(event) => setClientSearch(event.target.value)}
                              placeholder="Rechercher un client..."
                              className="h-9 w-full rounded-xl border border-[#e2e8f0] bg-[#f8fafc] pl-9 pr-3 font-semibold text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                              style={{ fontSize: "var(--pf-app-text-body)" }}
                            />
                          </label>
                          <div
                            role="listbox"
                            aria-label="Clients exportables"
                            className="mt-2 max-h-56 overflow-y-auto pr-1"
                          >
                            <button
                              type="button"
                              role="option"
                              aria-selected={!selectedCustomerId}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setPage(1);
                                setSelectedCustomerId("");
                                setClientPickerOpen(false);
                                setClientSearch("");
                              }}
                              className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition-colors ${
                                !selectedCustomerId
                                  ? "bg-[#eff6ff] text-[#1d4ed8]"
                                  : "text-[#334155] hover:bg-[#f8fafc]"
                              }`}
                              style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                            >
                              Tous les clients
                              {!selectedCustomerId ? <Check className="h-3.5 w-3.5" /> : null}
                            </button>
                            {filteredExportCustomers.map((customer) => {
                              const isSelected = customer.id === selectedCustomerId;
                              return (
                                <button
                                  key={customer.id}
                                  type="button"
                                  role="option"
                                  aria-selected={isSelected}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    setPage(1);
                                    setSelectedCustomerId(customer.id);
                                    setClientPickerOpen(false);
                                    setClientSearch("");
                                  }}
                                  className={`mt-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                                    isSelected ? "bg-[#eff6ff] text-[#1d4ed8]" : "text-[#334155] hover:bg-[#f8fafc]"
                                  }`}
                                  style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate">{customerOptionLabel(customer)}</span>
                                    {customer.email ? (
                                      <span
                                        className="block truncate text-[#94a3b8]"
                                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 700 }}
                                      >
                                        {customer.email}
                                      </span>
                                    ) : null}
                                  </span>
                                  {isSelected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                                </button>
                              );
                            })}
                            {filteredExportCustomers.length === 0 ? (
                              <div
                                className="px-3 py-4 text-center text-[#94a3b8]"
                                style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                              >
                                Aucun client trouvé
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <label
                      className="text-[#475569]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                    >
                      Début
                      <input
                        type="date"
                        value={startDate}
                        onChange={(event) => {
                          setPage(1);
                          setStartDate(event.target.value);
                        }}
                        className="mt-1 h-11 min-w-[10rem] w-full rounded-xl border border-[#bfdbfe] bg-white px-3 text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                      />
                    </label>
                    <label
                      className="text-[#475569]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                    >
                      Fin
                      <input
                        type="date"
                        value={endDate}
                        onChange={(event) => {
                          setPage(1);
                          setEndDate(event.target.value);
                        }}
                        className="mt-1 h-11 min-w-[10rem] w-full rounded-xl border border-[#bfdbfe] bg-white px-3 text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                      />
                    </label>
                    <label
                      className="text-[#475569]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                    >
                      Format
                      <select
                        value={exportFormat}
                        onChange={(event) => setExportFormat(event.target.value as InvoiceExportFormat)}
                        className="mt-1 h-11 min-w-[13.75rem] w-full rounded-xl border border-[#bfdbfe] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                        style={{ fontSize: "var(--pf-app-text-body)" }}
                      >
                        {availableInvoiceExportFormats.map(([value, item]) => (
                          <option key={value} value={value}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 2xl:justify-end">
                    <GuidanceTooltip content="Exporte uniquement les factures qui correspondent aux filtres affichés.">
                      <button
                        type="button"
                        onClick={() => setExportScope("filtered")}
                        aria-label={`Exporter les factures filtrées, ${totalCount || items.length} facture(s)`}
                        className={`rounded-full border px-3 py-1.5 transition-colors ${
                          exportScope === "filtered"
                            ? "border-[#1d4ed8] bg-white text-[#1d4ed8]"
                            : "border-[#bfdbfe] bg-[#f8fbff] text-[#64748b] hover:bg-white"
                        }`}
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                      >
                        Factures filtrées · {totalCount || items.length}
                      </button>
                    </GuidanceTooltip>
                    <GuidanceTooltip content="Exporte uniquement les factures cochées dans la liste.">
                      <button
                        type="button"
                        onClick={() => selectedInvoiceCount > 0 && setExportScope("selection")}
                        disabled={selectedInvoiceCount === 0}
                        aria-label={`Exporter les factures sélectionnées, ${selectedInvoiceCount} facture(s) cochée(s)`}
                        className={`rounded-full border px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          exportScope === "selection"
                            ? "border-[#1d4ed8] bg-white text-[#1d4ed8]"
                            : "border-[#bfdbfe] bg-[#f8fbff] text-[#64748b] hover:bg-white"
                        }`}
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                      >
                        Factures cochées · {selectedInvoiceCount}
                      </button>
                    </GuidanceTooltip>
                    <GuidanceTooltip content="Télécharge les factures avec le format et le périmètre choisis.">
                      <button
                        type="button"
                        onClick={() => void triggerExport()}
                        aria-label={
                          exportScope === "selection"
                            ? "Exporter les factures sélectionnées"
                            : "Exporter les factures filtrées"
                        }
                        className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[#1d4ed8] px-4 text-white shadow-[0_10px_22px_-16px_rgba(29,78,216,0.8)] transition-all hover:-translate-y-[1px] hover:bg-[#1e40af] disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={exportScope === "selection" && selectedInvoiceCount === 0}
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 900 }}
                      >
                        <Download className="h-3.5 w-3.5" />{" "}
                        {exportScope === "selection"
                          ? "Exporter les factures sélectionnées"
                          : "Exporter les factures filtrées"}
                      </button>
                    </GuidanceTooltip>
                  </div>
                </div>
              </div>
            ) : null}

            {!hydrated || loading ? (
              <div className="px-5 py-14 text-center text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-body)" }}>
                Chargement des factures…
              </div>
            ) : items.length === 0 ? (
              <div className="px-5 py-14 text-center">
                <div className="flex flex-col items-center gap-2">
                  <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                    <FileText className="h-5 w-5 text-[#cbd5e1]" />
                  </div>
                  <p className="text-[#64748b]" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 500 }}>
                    {hasActiveListFilters
                      ? "Aucun résultat pour ces filtres"
                      : documentTypeFilter === "credit_note"
                        ? "Aucun avoir pour l'instant"
                        : "Aucune facture pour l'instant"}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-body)" }}>
                    {search
                      ? `"${search}" ne correspond à aucun ${emptyDocumentLabel}.`
                      : hasActiveListFilters
                        ? "Modifie ou réinitialise les filtres pour élargir la liste."
                        : "Créez une facture ou importez vos données pour démarrer le suivi."}
                  </p>
                  {hasActiveListFilters ? (
                    <button
                      type="button"
                      onClick={resetListFilters}
                      className="mt-1 text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                      style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 500 }}
                    >
                      Voir toutes les factures
                    </button>
                  ) : canWriteInvoices ? (
                    <Link
                      to="/app/invoices/new"
                      className="pf-cta-link mt-2 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-white transition-all"
                      style={{
                        fontSize: "var(--pf-app-text-body)",
                        fontWeight: 500,
                        color: "#ffffff",
                        background: theme.accent,
                      }}
                    >
                      <Plus className="w-3.5 h-3.5" /> Créer une facture
                    </Link>
                  ) : (
                    <span className="mt-2 text-xs font-medium text-[#64748b]">Consultation seule pour votre rôle.</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto bg-white">
                <table className="pf-data-table w-full min-w-[1120px]">
                  <thead className="sticky top-0 z-10">
                    <tr style={{ borderBottom: "1px solid #f0f2f8" }}>
                      <th className="w-[220px] px-4 py-2.5 text-left" style={{ background: "#fafbfe" }}>
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            aria-label="Sélectionner les factures visibles de cette page"
                            checked={allVisibleSelected}
                            onChange={toggleVisibleSelection}
                            className="h-[15px] w-[15px] rounded border-[#d1dcec] text-[#1d4ed8]"
                            style={{ accentColor: "#1d4ed8" }}
                          />
                          <span style={invoiceTableHeaderLabelStyle}>
                            <InvoiceColumnHeader sortKey="number" sortState={sortState} onSort={toggleSort}>
                              Numéro
                            </InvoiceColumnHeader>
                          </span>
                        </div>
                      </th>
                      {showColumn("customer") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader sortKey="customer" sortState={sortState} onSort={toggleSort}>
                            Client
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {paymentsEnabled && showColumn("customer") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader sortKey="followup" sortState={sortState} onSort={toggleSort}>
                            Suivi relance
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("issue_date") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader sortKey="issue_date" sortState={sortState} onSort={toggleSort}>
                            Émission
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("due_date") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader sortKey="due_date" sortState={sortState} onSort={toggleSort}>
                            Échéance
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("purchase_order_number") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader
                            sortKey="purchase_order_number"
                            sortState={sortState}
                            onSort={toggleSort}
                          >
                            N° commande
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("sent_at") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader sortKey="sent_at" sortState={sortState} onSort={toggleSort}>
                            Envoyée
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("paid_at") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader sortKey="paid_at" sortState={sortState} onSort={toggleSort}>
                            Payée le
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("reminder_count") ? (
                        <th className="px-3 py-2 text-center" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader
                            align="center"
                            sortKey="reminder_count"
                            sortState={sortState}
                            onSort={toggleSort}
                          >
                            Relances
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("public_view_count") ? (
                        <th className="px-3 py-2 text-center" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader
                            align="center"
                            sortKey="public_view_count"
                            sortState={sortState}
                            onSort={toggleSort}
                          >
                            Vues
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("total_ht") ? (
                        <th className="px-3 py-2 text-right" style={{ ...invoiceTableHeaderStyle, minWidth: 104 }}>
                          <InvoiceColumnHeader
                            align="right"
                            sortKey="total_ht"
                            sortState={sortState}
                            onSort={toggleSort}
                          >
                            Total HT
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("total_ttc") ? (
                        <th className="px-3 py-2 text-right" style={{ ...invoiceTableHeaderStyle, minWidth: 112 }}>
                          <InvoiceColumnHeader
                            align="right"
                            sortKey="total_ttc"
                            sortState={sortState}
                            onSort={toggleSort}
                          >
                            Total TTC
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("currency") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader sortKey="currency" sortState={sortState} onSort={toggleSort}>
                            Devise
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("status") ? (
                        <th className="px-3 py-2 text-left" style={invoiceTableHeaderStyle}>
                          <InvoiceColumnHeader sortKey="status" sortState={sortState} onSort={toggleSort}>
                            Statut
                          </InvoiceColumnHeader>
                        </th>
                      ) : null}
                      <th className="w-[230px] px-3 py-2 text-right" style={{ background: "#fafbfe" }} />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f8f9fd]">
                    {sortedItems.map((inv) => {
                      const numberDisplay = invoiceNumberDisplay(inv);
                      const invoiceStatus = invoiceStatusForPlan(inv, paymentsEnabled);
                      const isDraftInvoice = invoiceStatus === "draft";
                      const isOverdueInvoice = paymentsEnabled && invoiceStatus === "overdue";
                      const isPaidInvoice = paymentsEnabled && invoiceStatus === "paid";
                      const canShareInvoice = !trialDraftOnly && !["draft", "canceled"].includes(invoiceStatus);
                      const canRecordPayment =
                        paymentsEnabled &&
                        inv.type !== "credit_note" &&
                        !["draft", "canceled", "paid"].includes(invoiceStatus);
                      const canPrepareInvoiceFollowup =
                        !trialDraftOnly && paymentsEnabled && inv.type === "invoice" && invoiceStatus === "overdue";
                      const canPrepareInvoiceEmail =
                        !trialDraftOnly && inv.type === "invoice" && invoiceStatus === "issued" && !inv.sent_at;
                      const rowTone = invoiceRowTone(invoiceStatus);
                      const customerName = inv.customer_name || "Client";
                      const customerEmail = String(inv.customer_email || inv.customer?.email || "").trim();
                      const customerId = String(inv.customer_id || inv.customer?.id || "");
                      const dueDelay = isOverdueInvoice ? overdueDaysLabel(inv.due_date) : "";
                      const primaryAction = invoicePrimaryAction(inv);
                      const PrimaryActionIcon = primaryAction.icon;
                      const followupSummary = paymentsEnabled ? invoiceFollowupSummary(inv) : null;
                      return (
                        <tr
                          key={inv.id}
                          role="link"
                          tabIndex={0}
                          onClick={(event) => {
                            if (isInteractiveRowTarget(event.target)) return;
                            navigate(`/app/invoices/${inv.id}`);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            if (isInteractiveRowTarget(event.target)) return;
                            event.preventDefault();
                            navigate(`/app/invoices/${inv.id}`);
                          }}
                          className={`group pf-clickable-row border-l-2 border-transparent transition-colors ${rowTone.hover}`}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-3">
                              <input
                                type="checkbox"
                                aria-label={`Sélectionner ${numberDisplay.label}`}
                                checked={selectedInvoiceIds.includes(inv.id)}
                                onChange={() => {
                                  if (!selectedInvoiceIds.includes(inv.id)) {
                                    setExportScope("selection");
                                  }
                                  toggleInvoiceSelection(inv);
                                }}
                                className="h-[15px] w-[15px] rounded border-[#d1dcec] text-[#1d4ed8]"
                                style={{ accentColor: "#1d4ed8" }}
                              />
                              <Link
                                to={`/app/invoices/${inv.id}`}
                                className="flex min-w-0 items-center gap-2 transition-colors"
                                style={{ color: isDraftInvoice || numberDisplay.missing ? "#64748b" : theme.strong }}
                                title={numberDisplay.title}
                                aria-label={`${documentTypeLabel(inv)} ${numberDisplay.label}`}
                              >
                                <span
                                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg"
                                  style={{ background: rowTone.iconBg }}
                                >
                                  <FileText className="h-3 w-3" style={{ color: rowTone.iconColor }} />
                                </span>
                                <span className="flex min-w-0 flex-col">
                                  <span
                                    className="pf-doc-number truncate"
                                    style={{
                                      ...invoiceTableCellStyle,
                                      color: isDraftInvoice || numberDisplay.missing ? "#64748b" : theme.strong,
                                    }}
                                  >
                                    {numberDisplay.label}
                                  </span>
                                  <span
                                    className="mt-0.5 truncate"
                                    style={{
                                      fontSize: "var(--pf-app-text-caption)",
                                      lineHeight: 1.1,
                                      color: isDraftInvoice || numberDisplay.missing ? "#64748b" : "#94a3b8",
                                    }}
                                  >
                                    {documentTypeLabel(inv)}
                                  </span>
                                </span>
                              </Link>
                              <div className="pf-mobile-row-summary mt-2 flex flex-wrap items-center gap-1.5">
                                <StatusPill
                                  {...(statusMap[invoiceStatus] || { label: invoiceStatus || "—", color: "muted" })}
                                />
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${
                                    Number(inv.total_inc_vat || 0) < 0
                                      ? "bg-red-50 text-red-600"
                                      : "bg-[#f8fafc] text-[#475569]"
                                  }`}
                                >
                                  {compactMoney(inv.total_inc_vat || 0, inv.currency || "EUR")}
                                </span>
                                <span className="rounded-full bg-[#eff6ff] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#1d4ed8]">
                                  {customerName}
                                </span>
                                <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#64748b]">
                                  Échéance {formatDateFr(inv.due_date, "—")}
                                </span>
                              </div>
                            </div>
                          </td>
                          {showColumn("customer") ? (
                            <td className="px-3 py-2.5">
                              <div className="flex min-w-0 items-center gap-2.5">
                                <span
                                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-xl text-white"
                                  style={{
                                    background: customerAvatarColor(customerName),
                                    fontSize: "var(--pf-app-text-overline)",
                                    fontWeight: 650,
                                  }}
                                >
                                  {customerInitials(customerName)}
                                </span>
                                <div className="min-w-0">
                                  {customerId ? (
                                    <Link
                                      to={`/app/customers/${customerId}`}
                                      className="pf-row-title block truncate text-[#0f172a] transition hover:text-[#4f46e5] hover:underline hover:underline-offset-2"
                                      title={`Ouvrir la fiche client ${customerName}`}
                                      style={{ ...invoiceTableCellStyle, color: "#1f2a44" }}
                                    >
                                      {customerName}
                                    </Link>
                                  ) : (
                                    <p
                                      className="pf-row-title truncate text-[#0f172a]"
                                      style={{ ...invoiceTableCellStyle, color: "#1f2a44" }}
                                    >
                                      {customerName}
                                    </p>
                                  )}
                                  <p
                                    className="pf-row-subtitle mt-0.5 hidden truncate text-[#94a3b8] lg:block"
                                    style={{ fontSize: "var(--pf-app-text-caption)", lineHeight: 1.15 }}
                                  >
                                    {customerEmail || "Email non renseigné"}
                                  </p>
                                </div>
                              </div>
                            </td>
                          ) : null}
                          {paymentsEnabled && showColumn("customer") ? (
                            <td className="px-3 py-2.5">
                              {followupSummary ? (
                                <div
                                  className="flex min-w-[150px] items-center gap-2"
                                  title={followupSummary.title}
                                  style={{ fontSize: "var(--pf-app-text-caption)", lineHeight: 1.2 }}
                                >
                                  <span
                                    className={`inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 ${followupSummary.priority.className}`}
                                    style={{ fontWeight: 800 }}
                                  >
                                    {followupSummary.priority.label}
                                  </span>
                                  <span
                                    className={`min-w-0 truncate ${followupSummary.proofClassName}`}
                                    style={{ fontWeight: 700 }}
                                  >
                                    {followupSummary.compactProofLabel}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-[#cbd5e1]" style={invoiceTableCellStyle}>
                                  —
                                </span>
                              )}
                            </td>
                          ) : null}
                          {showColumn("issue_date") ? (
                            <td className="px-3 py-2.5 text-[#6b7494]" style={invoiceTableCellStyle}>
                              {formatDateFr(inv.issue_date, "—")}
                            </td>
                          ) : null}
                          {showColumn("due_date") ? (
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={isOverdueInvoice ? "text-[#dc2626]" : "text-[#6b7494]"}
                                  style={invoiceTableCellStyle}
                                >
                                  {formatDateFr(inv.due_date, "—")}
                                </span>
                                {dueDelay ? (
                                  <span
                                    className="rounded-full bg-red-100 px-1.5 py-0.5 font-black text-[#dc2626]"
                                    style={{ fontSize: "var(--pf-app-text-overline)" }}
                                  >
                                    {dueDelay}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                          ) : null}
                          {showColumn("purchase_order_number") ? (
                            <td className="px-3 py-2.5 text-[#8a94ae]" style={invoiceTableCellStyle}>
                              {inv.purchase_order_number || "—"}
                            </td>
                          ) : null}
                          {showColumn("sent_at") ? (
                            <td className="px-3 py-2.5 text-[#6b7494]" style={invoiceTableCellStyle}>
                              {formatDateFr(inv.sent_at, "—")}
                            </td>
                          ) : null}
                          {showColumn("paid_at") ? (
                            <td className="px-3 py-2.5 text-[#6b7494]" style={invoiceTableCellStyle}>
                              {formatDateFr(inv.paid_at, "—")}
                            </td>
                          ) : null}
                          {showColumn("reminder_count") ? (
                            <td className="px-3 py-2.5 text-center">
                              <span
                                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-amber-200 bg-amber-50 px-1.5 text-amber-700"
                                style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600 }}
                              >
                                {Number(inv.reminder_count || 0)}
                              </span>
                            </td>
                          ) : null}
                          {showColumn("public_view_count") ? (
                            <td className="px-3 py-2.5 text-center text-[#8a94ae]" style={invoiceTableCellStyle}>
                              {Number(inv.public_view_count || 0)}
                            </td>
                          ) : null}
                          {showColumn("total_ht") ? (
                            <td
                              className={`px-3 py-2.5 text-right ${
                                Number(inv.total_ex_vat || 0) < 0 ? "text-red-600" : "text-[#0f172a]"
                              }`}
                              style={invoiceAmountCellStyle}
                            >
                              {compactMoney(inv.total_ex_vat || 0, inv.currency || "EUR")}
                            </td>
                          ) : null}
                          {showColumn("total_ttc") ? (
                            <td className="px-3 py-2.5 text-right">
                              <div className="flex w-full min-w-[5.5rem] flex-col items-end">
                                <span
                                  className="pf-table-amount inline-block min-w-[4.75rem] text-right"
                                  style={{
                                    ...invoiceAmountCellStyle,
                                    color: Number(inv.total_inc_vat || 0) < 0 ? "#dc2626" : "#0f172a",
                                  }}
                                >
                                  {compactMoney(inv.total_inc_vat || 0, inv.currency || "EUR")}
                                </span>
                                {isPaidInvoice && Number(inv.total_inc_vat || 0) >= 0 ? (
                                  <span className="mt-0.5 h-0.5 w-12 rounded-full bg-[#16c784]/40" />
                                ) : null}
                              </div>
                            </td>
                          ) : null}
                          {showColumn("currency") ? (
                            <td className="px-3 py-2.5 text-[#6b7494]" style={invoiceTableCellStyle}>
                              {inv.currency || "EUR"}
                            </td>
                          ) : null}
                          {showColumn("status") ? (
                            <td className="px-3 py-2.5">
                              <StatusPill
                                {...(statusMap[invoiceStatus] || { label: invoiceStatus || "—", color: "muted" })}
                              />
                            </td>
                          ) : null}
                          <td className="pf-row-actions-cell px-3 py-2.5" data-no-row-open="true">
                            <div
                              className="pf-row-actions flex items-center justify-end gap-1.5"
                              data-no-row-open="true"
                            >
                              <Link
                                to={primaryAction.href}
                                className="pf-primary-row-action inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-2.5 text-[#1d4ed8] transition-colors hover:bg-[#dbeafe]"
                                aria-label={`${primaryAction.label} ${numberDisplay.label}`}
                                title={primaryAction.title}
                                style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                              >
                                <PrimaryActionIcon className="h-3.5 w-3.5" />
                                {primaryAction.label}
                              </Link>
                              <ActionMenu
                                label={`Actions ${numberDisplay.label}`}
                                iconOnly
                                triggerIcon={MoreHorizontal}
                                className="pf-row-action-menu pf-invoice-row-action-menu"
                              >
                                <ActionMenuButton
                                  icon={Download}
                                  disabled={rowActionBusy === `pdf:${inv.id}`}
                                  onClick={() => void downloadInvoicePdf(inv)}
                                >
                                  Télécharger le PDF
                                </ActionMenuButton>
                                {canWriteInvoices ? (
                                  <ActionMenuButton
                                    icon={Copy}
                                    disabled={!canShareInvoice || rowActionBusy === `share:${inv.id}`}
                                    onClick={() => void copyInvoicePortalLink(inv)}
                                  >
                                    Copier le lien client
                                  </ActionMenuButton>
                                ) : null}
                                {canWriteInvoices && invoiceStatus === "draft" ? (
                                  <ActionMenuButton
                                    icon={Trash2}
                                    disabled={rowActionBusy === "delete-draft-invoices"}
                                    onClick={() => void deleteDraftInvoices([inv])}
                                  >
                                    Supprimer le brouillon
                                  </ActionMenuButton>
                                ) : null}
                                {canWriteInvoices &&
                                canPrepareInvoiceFollowup &&
                                primaryAction.href !== `/app/invoices/${inv.id}?action=followup` ? (
                                  <ActionMenuLink to={`/app/invoices/${inv.id}?action=followup`} icon={Mail}>
                                    Préparer une relance
                                  </ActionMenuLink>
                                ) : null}
                                {canWriteInvoices &&
                                canPrepareInvoiceEmail &&
                                primaryAction.href !== `/app/invoices/${inv.id}?action=email` ? (
                                  <ActionMenuLink to={`/app/invoices/${inv.id}?action=email`} icon={Mail}>
                                    Préparer l'email
                                  </ActionMenuLink>
                                ) : null}
                                {canWriteInvoices &&
                                canRecordPayment &&
                                primaryAction.href !== `/app/invoices/${inv.id}?panel=encaissement` ? (
                                  <ActionMenuLink to={`/app/invoices/${inv.id}?panel=encaissement`} icon={Wallet}>
                                    Enregistrer un règlement
                                  </ActionMenuLink>
                                ) : null}
                                {primaryAction.href !== `/app/invoices/${inv.id}` ? (
                                  <ActionMenuLink to={`/app/invoices/${inv.id}`} icon={ArrowRight}>
                                    Ouvrir le détail
                                  </ActionMenuLink>
                                ) : null}
                              </ActionMenu>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderTop: "1px solid #f1f5f9", background: "#fafbfd" }}
            >
              <span className="text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-body)" }}>
                {items.length} affiché{items.length > 1 ? "s" : ""} sur {totalCount || items.length} document
                {(totalCount || items.length) > 1 ? "s" : ""}
                {hasActiveListFilters ? <span className="ml-1">· filtre actif</span> : null}
              </span>
              <div className="flex items-center gap-3">
                {hasActiveListFilters ? (
                  <button
                    type="button"
                    onClick={resetListFilters}
                    className="text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 500 }}
                  >
                    Réinitialiser
                  </button>
                ) : null}
                <label
                  className="flex items-center gap-2 text-[#64748b]"
                  style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                >
                  Par page
                  <select
                    aria-label="Factures par page"
                    value={pageSize}
                    onChange={(event) => {
                      const nextPageSize = Number(event.target.value);
                      if (
                        !INVOICE_PAGE_SIZE_OPTIONS.includes(nextPageSize as (typeof INVOICE_PAGE_SIZE_OPTIONS)[number])
                      ) {
                        return;
                      }
                      setPage(1);
                      setPageSize(nextPageSize);
                    }}
                    className="h-8 rounded-lg border border-[#e2e8f0] bg-white px-2 text-[#475569] outline-none transition hover:border-[#bfdbfe] focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                  >
                    {INVOICE_PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={page <= 1}
                    aria-label="Page précédente"
                    className="rounded-lg border border-[#e2e8f0] bg-white p-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[#f8fafc] disabled:opacity-40"
                  >
                    <ChevronLeft className="w-3.5 h-3.5 text-[#94a3b8]" />
                  </button>
                  <span
                    className="rounded-lg border border-[#e2e8f0] bg-white px-3 py-1.5 text-[#475569]"
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 500 }}
                  >
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                    disabled={page >= totalPages}
                    aria-label="Page suivante"
                    className="rounded-lg border border-[#e2e8f0] bg-white p-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[#f8fafc] disabled:opacity-40"
                  >
                    <ChevronRight className="w-3.5 h-3.5 text-[#94a3b8]" />
                  </button>
                </div>
              </div>
            </div>
          </SalesListBlock>
        </div>
      </WorkbenchPage>
    </div>
  );
}

export { InvoiceDetailPage, InvoiceNewPage } from "../../../src/figma/app/pages/app/InvoicesPage";
