import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { AppPageHeader, StatusPill, NoticeBanner } from "../../components/app/AppPageHeader";
import { ActionMenu, ActionMenuButton, ActionMenuLink } from "../../../src/figma/app/components/app/AppPageHeader";
import {
  Plus,
  RefreshCw,
  Send,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowRight,
  ArrowUpDown,
  CheckSquare,
  SlidersHorizontal,
  Columns3,
  FileText,
  Download,
  Copy,
  Mail,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { api, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDateFr } from "@/lib/dateFormat";
import { downloadProtectedFile } from "@/lib/download";
import { useHydrated } from "@/lib/useHydrated";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import {
  SalesListBlock,
  SalesMetricCard,
  SalesMetricsGrid,
  SalesPeriodControl,
  type SalesPeriodPreset,
  getSalesPeriodRange,
  getSalesTheme,
  salesPeriodOptions,
  toSalesMonthInputValue,
} from "../../../src/figma/app/components/app/SalesModuleLayout";
import { ListPagination } from "../../../src/figma/app/components/app/ListPagination";
import { GuidanceTooltip } from "../../../src/figma/app/components/app/GuidanceTooltip";
import { can } from "@/lib/permissions";
import { useSession } from "@/lib/useSession";
import { isTrialSubscription, TRIAL_LIVE_ACTION_MESSAGE } from "@/lib/trialMode";

const statusMap: Record<string, { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" }> = {
  draft: { label: "Brouillon", color: "muted" },
  sent: { label: "Envoyé", color: "info" },
  accepted: { label: "Accepté", color: "ok" },
  rejected: { label: "Refusé", color: "danger" },
  invoiced: { label: "Facturé", color: "purple" },
  expired: { label: "Expiré", color: "muted" },
};

function money(value: any, currency = "EUR", fractionDigits = 2) {
  return `${Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
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
  const palette = ["#7c3aed", "#16a34a", "#2563eb", "#f59e0b", "#06b6d4", "#ec4899", "#f97316", "#14b8a6"];
  const text = String(value || "Client");
  return palette[text.charCodeAt(0) % palette.length];
}

function isInteractiveRowTarget(target: EventTarget | null) {
  return target instanceof Element
    ? Boolean(target.closest("a,button,input,select,textarea,label,[role='button'],[data-no-row-open='true']"))
    : false;
}

function quoteRowTone(status: any) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "rejected" || normalized === "expired")
    return { iconBg: "#fef2f2", iconColor: "#dc2626", hover: "hover:bg-red-50/30" };
  if (normalized === "accepted" || normalized === "invoiced")
    return { iconBg: "#ecfdf5", iconColor: "#059669", hover: "hover:bg-emerald-50/20" };
  if (normalized === "draft") return { iconBg: "#f8fafc", iconColor: "#64748b", hover: "hover:bg-[#fafbfe]" };
  return { iconBg: "#f5f3ff", iconColor: "#7c3aed", hover: "hover:bg-[#faf7ff]" };
}

function quoteNumberDisplay(quote: any) {
  const rawReference = String(quote?.number || quote?.id || "").trim();
  const isDraft = String(quote?.status || "").toLowerCase() === "draft";
  if (isDraft) {
    return {
      label: "Brouillon",
      title: rawReference ? `Référence provisoire : ${rawReference}` : "Numéro attribué à l'envoi",
    };
  }
  return {
    label: quote?.number || "—",
    title: quote?.id && quote?.number ? `Référence technique : ${quote.id}` : undefined,
  };
}

function isAcceptedOrInvoicedQuote(quote: any) {
  return ["accepted", "invoiced"].includes(String(quote?.status || "").toLowerCase());
}

function isQuoteEmailSent(quote: any) {
  const status = String(quote?.status || "").toLowerCase();
  return Boolean(quote?.sent_at) || ["sent", "accepted", "rejected", "invoiced", "expired"].includes(status);
}

type QuoteColumnKey =
  | "issue_date"
  | "valid_until"
  | "customer"
  | "email"
  | "signature"
  | "status"
  | "total_ht"
  | "total_ttc";
type QuoteSortKey = QuoteColumnKey | "number";
type SortDirection = "asc" | "desc";
type QuoteExportScope = "filtered" | "selection";
type QuoteExportFormat = "pdf";
type QuoteCustomerOption = { id: string; name?: string; email?: string };

const QUOTE_PAGE_SIZE_STORAGE_KEY = "pixfacture.quotes.pageSize.v1";
const QUOTE_METRIC_PERIOD_STORAGE_KEY = "pixfacture.quotes.metricPeriod.v1";
const QUOTE_METRIC_MONTH_STORAGE_KEY = "pixfacture.quotes.metricMonth.v1";
const QUOTE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const QUOTE_ROUTE_TABS = ["all", "draft", "sent", "accepted", "invoiced", "rejected", "expired"];

const quoteExportFormats: Record<QuoteExportFormat, { label: string; filename: string }> = {
  pdf: { label: "PDF devis", filename: "devis.pdf" },
};

const quoteColumnOptions: { key: QuoteColumnKey; label: string }[] = [
  { key: "issue_date", label: "Date" },
  { key: "valid_until", label: "Validité" },
  { key: "customer", label: "Client" },
  { key: "email", label: "Email" },
  { key: "signature", label: "Signature" },
  { key: "status", label: "Statut" },
  { key: "total_ht", label: "Total HT" },
  { key: "total_ttc", label: "Total TTC" },
];

function QuoteColumnHeader({
  children,
  align = "left",
  sortKey,
  sortState,
  onSort,
}: {
  children: ReactNode;
  align?: "left" | "center" | "right";
  sortKey?: QuoteSortKey;
  sortState?: { key: QuoteSortKey; direction: SortDirection } | null;
  onSort?: (key: QuoteSortKey) => void;
}) {
  const active = Boolean(sortKey && sortState?.key === sortKey);
  const SortIcon = active ? (sortState?.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  const inner = (
    <>
      <span>{children}</span>
      <SortIcon
        className={`h-3 w-3 ${active ? "text-[#8b5cf6]" : "text-[#cbd5e1] group-hover:text-[#8b5cf6]"}`}
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
        className={`group inline-flex w-full items-center gap-1.5 transition-colors hover:text-[#7c3aed] ${
          align === "right"
            ? "justify-end text-right"
            : align === "center"
              ? "justify-center text-center"
              : "justify-start text-left"
        } ${active ? "pf-sort-header-active pf-sort-header-quotes text-[#7c3aed]" : ""}`}
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

function quoteSortValue(quote: any, key: QuoteSortKey) {
  if (key === "number") return normalizeSortText(quote?.number || quote?.id || "");
  if (key === "customer") return normalizeSortText(quote?.customer_name || quote?.customer?.name || "");
  if (key === "issue_date") return sortDateValue(quote?.issue_date);
  if (key === "valid_until") return sortDateValue(quote?.valid_until);
  if (key === "email") return isQuoteEmailSent(quote) ? 1 : 0;
  if (key === "signature") return isAcceptedOrInvoicedQuote(quote) || quote?.accepted_at ? 1 : 0;
  if (key === "total_ht") return Number(quote?.total_ex_vat || 0);
  if (key === "total_ttc") return Number(quote?.total_inc_vat || 0);
  if (key === "status") return normalizeSortText(statusMap[quote?.status]?.label || quote?.status || "");
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

function quoteCustomerOptionLabel(customer: QuoteCustomerOption) {
  return customer.name || customer.email || "Client";
}

function readStoredQuotePageSize() {
  if (typeof window === "undefined") return 10;
  try {
    const value = Number(window.localStorage.getItem(QUOTE_PAGE_SIZE_STORAGE_KEY));
    return QUOTE_PAGE_SIZE_OPTIONS.includes(value as (typeof QUOTE_PAGE_SIZE_OPTIONS)[number]) ? value : 10;
  } catch {
    return 10;
  }
}

function readStoredQuoteMetricPeriod(): SalesPeriodPreset {
  if (typeof window === "undefined") return "current_month";
  try {
    const raw = window.localStorage.getItem(QUOTE_METRIC_PERIOD_STORAGE_KEY) as SalesPeriodPreset | null;
    return raw && salesPeriodOptions.some((option) => option.value === raw) ? raw : "current_month";
  } catch {
    return "current_month";
  }
}

function readStoredQuoteMetricMonth() {
  if (typeof window === "undefined") return toSalesMonthInputValue(new Date());
  try {
    const raw = window.localStorage.getItem(QUOTE_METRIC_MONTH_STORAGE_KEY);
    return raw && /^\d{4}-\d{2}$/.test(raw) ? raw : toSalesMonthInputValue(new Date());
  } catch {
    return toSalesMonthInputValue(new Date());
  }
}

function readQuoteTabFromLocation() {
  if (typeof window === "undefined") return "all";
  const params = new URLSearchParams(window.location.search);
  const value = String(params.get("status") || params.get("tab") || "").toLowerCase();
  return QUOTE_ROUTE_TABS.includes(value) ? value : "all";
}

export function QuotesListPage() {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const { user, subscriptionStatus } = useSession({ autoRefresh: false });
  const trialDraftOnly = isTrialSubscription(subscriptionStatus);
  const canWriteQuotes = can(user, "quotes:write");
  const canConvertQuotes = can(user, "quotes:convert");
  const [quotes, setQuotes] = useState<any[]>([]);
  const [summaryMetrics, setSummaryMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowActionBusy, setRowActionBusy] = useState<string | null>(null);
  const [tab, setTab] = useState(() => readQuoteTabFromLocation());
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => readStoredQuotePageSize());
  const [metricPeriod, setMetricPeriod] = useState<SalesPeriodPreset>(() => readStoredQuoteMetricPeriod());
  const [metricMonth, setMetricMonth] = useState(() => readStoredQuoteMetricMonth());
  const [totalCount, setTotalCount] = useState(0);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [exportToolsOpen, setExportToolsOpen] = useState(false);
  const [exportScope, setExportScope] = useState<QuoteExportScope>("selection");
  const [exportFormat, setExportFormat] = useState<QuoteExportFormat>("pdf");
  const [customers, setCustomers] = useState<QuoteCustomerOption[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sortState, setSortState] = useState<{ key: QuoteSortKey; direction: SortDirection } | null>(null);
  const [minTotalHt, setMinTotalHt] = useState("");
  const [maxTotalHt, setMaxTotalHt] = useState("");
  const [emailFilter, setEmailFilter] = useState("all");
  const [signatureFilter, setSignatureFilter] = useState("all");
  const [visibleColumns, setVisibleColumns] = useState<Record<QuoteColumnKey, boolean>>({
    issue_date: true,
    valid_until: true,
    customer: true,
    email: false,
    signature: false,
    status: true,
    total_ht: false,
    total_ttc: true,
  });
  const [selectedQuoteIds, setSelectedQuoteIds] = useState<string[]>([]);
  const metricPeriodRange = useMemo(() => getSalesPeriodRange(metricPeriod, metricMonth), [metricMonth, metricPeriod]);

  const buildQuoteListParams = useCallback(
    (limit: number, offset: number) => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      if (tab !== "all") params.set("status", tab === "accepted" ? "accepted" : tab);
      if (search.trim()) params.set("q", search.trim());
      if (selectedCustomerId) params.set("customer_id", selectedCustomerId);
      if (minTotalHt.trim()) params.set("min_total_ht", minTotalHt.trim());
      if (maxTotalHt.trim()) params.set("max_total_ht", maxTotalHt.trim());
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      if (emailFilter !== "all") params.set("email", emailFilter);
      if (signatureFilter !== "all") params.set("signature", signatureFilter);
      return params;
    },
    [emailFilter, endDate, maxTotalHt, minTotalHt, search, selectedCustomerId, signatureFilter, startDate, tab],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = buildQuoteListParams(pageSize, (page - 1) * pageSize);
      const res = await rawApi(`/api/quotes?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Impossible de charger les devis."));
      }
      const payload = await res.json().catch(() => []);
      const nextQuotes = Array.isArray(payload) ? payload : [];
      setQuotes(nextQuotes);
      setTotalCount(Number(res.headers.get("x-total-count") || String(nextQuotes.length)) || 0);
    } catch (err) {
      setQuotes([]);
      setTotalCount(0);
      setError(formatApiError(err, "Impossible de charger les devis."));
    } finally {
      setLoading(false);
    }
  }, [buildQuoteListParams, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("start_date", metricPeriodRange.start);
      params.set("end_date", metricPeriodRange.end);
      const res = await rawApi(`/api/quotes/metrics?${params.toString()}`);
      if (!res.ok) return;
      const payload = await res.json().catch(() => null);
      setSummaryMetrics(payload && typeof payload === "object" ? payload : null);
    } catch {
      setSummaryMetrics(null);
    }
  }, [metricPeriodRange.end, metricPeriodRange.start]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(QUOTE_PAGE_SIZE_STORAGE_KEY, String(pageSize));
    } catch {
      // ignore storage failures
    }
  }, [pageSize]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(QUOTE_METRIC_PERIOD_STORAGE_KEY, metricPeriod);
  }, [metricPeriod]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(QUOTE_METRIC_MONTH_STORAGE_KEY, metricMonth);
  }, [metricMonth]);

  useEffect(() => {
    let cancelled = false;
    rawApi("/api/customers?limit=200&offset=0")
      .then(async (res) => {
        if (!res.ok) throw new Error("customers");
        const payload = await res.json().catch(() => []);
        if (!cancelled) setCustomers(Array.isArray(payload) ? payload : []);
      })
      .catch(() => {
        if (!cancelled) setCustomers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(() => {
    if (summaryMetrics) return summaryMetrics;
    const totals = quotes.reduce(
      (acc, quote) => {
        acc.total += 1;
        acc.amount += Number(quote.total_inc_vat || 0);
        if (quote.status === "draft") acc.draft += 1;
        if (quote.status === "sent") acc.sent += 1;
        if (quote.status === "accepted") acc.accepted += 1;
        if (quote.status === "invoiced") acc.invoiced += 1;
        if (quote.status === "rejected") acc.rejected += 1;
        if (quote.status === "expired") acc.expired += 1;
        return acc;
      },
      { total: 0, amount: 0, draft: 0, sent: 0, accepted: 0, invoiced: 0, rejected: 0, expired: 0 },
    );
    return {
      total_count: totals.total || totalCount,
      pipeline_amount: totals.amount,
      draft_count: totals.draft,
      sent_count: totals.sent,
      accepted_count: totals.accepted,
      invoiced_count: totals.invoiced,
      rejected_count: totals.rejected,
      expired_count: totals.expired,
    };
  }, [quotes, summaryMetrics, totalCount]);
  const tabs = useMemo(() => {
    const localCount = (status: string) => quotes.filter((q) => q.status === status).length;
    const currentStatusCount = (status: string, fallback: any) =>
      tab === status ? Number(totalCount ?? quotes.length ?? 0) : Number(fallback ?? localCount(status) ?? 0);
    return [
      {
        val: "all",
        label: "Tous",
        count: summary.total_count ?? totalCount ?? quotes.length,
        accent: "module" as const,
      },
      {
        val: "draft",
        label: "Brouillons",
        count: currentStatusCount("draft", summary.draft_count),
        accent: "muted" as const,
      },
      {
        val: "sent",
        label: "Envoyés",
        count: currentStatusCount("sent", summary.sent_count),
        accent: "info" as const,
      },
      {
        val: "accepted",
        label: "À facturer",
        count: currentStatusCount("accepted", summary.accepted_count),
        accent: "success" as const,
      },
      {
        val: "rejected",
        label: "Refusés",
        count: currentStatusCount("rejected", summary.rejected_count),
        accent: "danger" as const,
      },
    ];
  }, [quotes, summary, tab, totalCount]);

  const acceptedCount =
    tab === "accepted"
      ? Number(totalCount ?? quotes.length ?? 0)
      : (summary.accepted_count ?? quotes.filter((q) => q.status === "accepted").length);
  const invoicedCount =
    tab === "invoiced"
      ? Number(totalCount ?? quotes.length ?? 0)
      : (summary.invoiced_count ?? quotes.filter((q) => q.status === "invoiced").length);
  const acceptedReadyCount = acceptedCount;
  const sentCount =
    tab === "sent"
      ? Number(totalCount ?? quotes.length ?? 0)
      : (summary.sent_count ?? quotes.filter((q) => q.status === "sent").length);
  const rejectedCount =
    tab === "rejected"
      ? Number(totalCount ?? quotes.length ?? 0)
      : (summary.rejected_count ?? quotes.filter((q) => q.status === "rejected").length);
  const pipelineAmount = summary.pipeline_amount ?? quotes.reduce((sum, q) => sum + Number(q.total_inc_vat || 0), 0);
  const filteredQuotes = quotes;
  const pageQuotes = useMemo(() => {
    if (!sortState) return filteredQuotes;
    return [...filteredQuotes].sort((left, right) =>
      compareSortValues(quoteSortValue(left, sortState.key), quoteSortValue(right, sortState.key), sortState.direction),
    );
  }, [filteredQuotes, sortState]);
  const pageQuoteIds = useMemo(() => pageQuotes.map((quote) => String(quote.id)).filter(Boolean), [pageQuotes]);
  const selectedQuoteCount = pageQuoteIds.filter((quoteId) => selectedQuoteIds.includes(quoteId)).length;
  const selectedQuotes = useMemo(
    () => pageQuotes.filter((quote) => selectedQuoteIds.includes(String(quote.id))),
    [pageQuotes, selectedQuoteIds],
  );
  const selectedDraftQuotes = useMemo(
    () => selectedQuotes.filter((quote) => String(quote.status || "").toLowerCase() === "draft"),
    [selectedQuotes],
  );
  const allPageQuotesSelected = pageQuoteIds.length > 0 && selectedQuoteCount === pageQuoteIds.length;
  const toggleQuoteSelection = (quoteId: string) => {
    setSelectedQuoteIds((current) =>
      current.includes(quoteId) ? current.filter((id) => id !== quoteId) : [...current, quoteId],
    );
  };
  const toggleQuotePageSelection = () => {
    setSelectedQuoteIds((current) => {
      if (allPageQuotesSelected) return current.filter((id) => !pageQuoteIds.includes(id));
      const next = new Set(current);
      pageQuoteIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
  };
  const toggleSort = (key: QuoteSortKey) => {
    setSortState((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  };
  useEffect(() => {
    setPage(1);
  }, [emailFilter, endDate, maxTotalHt, minTotalHt, search, selectedCustomerId, signatureFilter, startDate, tab]);
  useEffect(() => {
    const visibleIds = new Set(pageQuoteIds);
    setSelectedQuoteIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [pageQuoteIds]);
  const totalPages = Math.max(1, Math.ceil((totalCount || 0) / pageSize));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const theme = getSalesTheme("quotes");
  const hasActiveFilters =
    tab !== "all" ||
    search.trim().length > 0 ||
    Boolean(selectedCustomerId) ||
    Boolean(startDate) ||
    Boolean(endDate) ||
    minTotalHt.trim().length > 0 ||
    maxTotalHt.trim().length > 0 ||
    emailFilter !== "all" ||
    signatureFilter !== "all";
  const activeAdvancedFilterCount = [
    tab !== "all",
    Boolean(selectedCustomerId),
    Boolean(startDate),
    Boolean(endDate),
    minTotalHt.trim().length > 0,
    maxTotalHt.trim().length > 0,
    emailFilter !== "all",
    signatureFilter !== "all",
  ].filter(Boolean).length;
  const resetFilters = () => {
    setPage(1);
    setSearch("");
    setTab("all");
    setSelectedCustomerId("");
    setStartDate("");
    setEndDate("");
    setMinTotalHt("");
    setMaxTotalHt("");
    setEmailFilter("all");
    setSignatureFilter("all");
  };
  const downloadQuotePdf = async (quote: any) => {
    if (!quote?.id) return;
    setRowActionBusy(`pdf:${quote.id}`);
    setError(null);
    try {
      await downloadProtectedFile(`/api/quotes/${quote.id}/pdf`);
    } catch (err: any) {
      setError(formatApiError(err, "Téléchargement PDF impossible."));
    } finally {
      setRowActionBusy(null);
    }
  };

  const fetchFilteredQuoteExportTargets = async () => {
    const targets: any[] = [];
    const limit = 200;
    let offset = 0;
    let expectedTotal: number | null = null;
    while (expectedTotal === null || targets.length < expectedTotal) {
      const params = buildQuoteListParams(limit, offset);
      const res = await rawApi(`/api/quotes?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Impossible de préparer l'export des devis."));
      }
      const payload = await res.json().catch(() => []);
      const pageTargets = Array.isArray(payload) ? payload : [];
      targets.push(...pageTargets);
      expectedTotal = Number(res.headers.get("x-total-count") || String(targets.length)) || targets.length;
      if (pageTargets.length === 0 || targets.length >= 1000) break;
      offset += limit;
    }
    return targets;
  };

  const downloadQuotePdfs = async (requestedScope?: QuoteExportScope) => {
    const scope = requestedScope === "filtered" || requestedScope === "selection" ? requestedScope : exportScope;
    if (scope === "selection" && selectedQuotes.length === 0) {
      setError("Sélectionnez au moins un devis avant d'exporter la sélection.");
      return;
    }
    setRowActionBusy("bulk-pdf");
    setError(null);
    try {
      const targets = scope === "selection" ? selectedQuotes : await fetchFilteredQuoteExportTargets();
      if (targets.length === 0) {
        setError(
          scope === "selection"
            ? "Sélectionnez au moins un devis avant d'exporter la sélection."
            : "Aucun devis à exporter avec les filtres actuels.",
        );
        return;
      }
      for (const quote of targets) {
        await downloadProtectedFile(`/api/quotes/${quote.id}/pdf`);
      }
      setNotice(
        `${targets.length} PDF devis téléchargé${targets.length > 1 ? "s" : ""} depuis ${
          scope === "selection" ? "la sélection" : "la vue filtrée"
        }.`,
      );
    } catch (err: any) {
      setError(formatApiError(err, "Téléchargement des PDF impossible."));
    } finally {
      setRowActionBusy(null);
    }
  };

  const deleteDraftQuotes = async (targets: any[]) => {
    if (!canWriteQuotes) return;
    const draftTargets = targets.filter((quote) => String(quote?.status || "").toLowerCase() === "draft" && quote?.id);
    const ignoredCount = Math.max(0, targets.length - draftTargets.length);
    if (draftTargets.length === 0) {
      setError("Sélectionnez au moins un devis brouillon à supprimer.");
      return;
    }
    if (typeof window !== "undefined") {
      const warning = ignoredCount
        ? `\n${ignoredCount} devis non brouillon ne sera pas supprimé.`
        : "\nCette action ne touche pas les devis envoyés ou acceptés.";
      const confirmed = window.confirm(
        `Supprimer ${draftTargets.length} devis brouillon${draftTargets.length > 1 ? "s" : ""} ?${warning}`,
      );
      if (!confirmed) return;
    }
    setRowActionBusy("delete-draft-quotes");
    setError(null);
    setNotice(null);
    try {
      for (const quote of draftTargets) {
        await api(`/api/quotes/${quote.id}`, { method: "DELETE" });
      }
      const deletedIds = new Set(draftTargets.map((quote) => String(quote.id)));
      setSelectedQuoteIds((current) => current.filter((id) => !deletedIds.has(id)));
      setNotice(`${draftTargets.length} devis brouillon${draftTargets.length > 1 ? "s supprimés" : " supprimé"}.`);
      await load();
      await loadSummary();
    } catch (err: any) {
      setError(formatApiError(err, "Suppression des brouillons impossible."));
    } finally {
      setRowActionBusy(null);
    }
  };

  const copyQuotePortalLink = async (quote: any) => {
    if (!quote?.id || !canWriteQuotes) return;
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    const status = String(quote.status || "").toLowerCase();
    if (["draft", "rejected", "invoiced", "expired"].includes(status)) {
      setError("Ce devis doit être envoyé ou accepté avant de copier un lien client.");
      return;
    }
    setRowActionBusy(`share:${quote.id}`);
    setError(null);
    setNotice(null);
    try {
      const current = await rawApi(`/api/quotes/${quote.id}/share`).catch(() => null);
      const currentPayload = current?.ok ? await current.json().catch(() => null) : null;
      let publicUrl = currentPayload?.public_url || null;
      if (!publicUrl) {
        const enabled: any = await api(`/api/quotes/${quote.id}/share`, { method: "POST" });
        publicUrl = enabled?.public_url || null;
      }
      if (!publicUrl) {
        throw new Error("Lien client indisponible.");
      }
      await copyTextToClipboard(publicUrl);
      setNotice(`Lien client copié pour ${quote.number || "le devis"}.`);
    } catch (err: any) {
      setError(formatApiError(err, "Impossible de préparer le lien client."));
    } finally {
      setRowActionBusy(null);
    }
  };
  const convertQuoteToInvoice = async (quote: any) => {
    if (!quote?.id || !canConvertQuotes) return;
    setRowActionBusy(`convert:${quote.id}`);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/quotes/${quote.id}/convert`, { method: "POST" });
      setNotice(
        result?.invoice_id
          ? `Facture créée depuis ${quote.number || "le devis"}.`
          : `Conversion lancée pour ${quote.number || "le devis"}.`,
      );
      await load();
      await loadSummary();
    } catch (err: any) {
      setError(formatApiError(err, "Conversion du devis impossible."));
    } finally {
      setRowActionBusy(null);
    }
  };
  const quotePrimaryAction = (quote: any) => {
    const status = String(quote?.status || "").toLowerCase();
    if (quote?.invoice_id) {
      return {
        label: "Facture",
        icon: FileText,
        title: "Ouvrir la facture liée",
        href: `/app/invoices/${quote.invoice_id}`,
      };
    }
    if (status === "accepted" && canConvertQuotes) {
      return {
        label: "Préparer facture",
        icon: RefreshCw,
        title: "Ouvrir le devis accepté pour créer la facture",
        href: `/app/quotes/${quote.id}`,
      };
    }
    if (!trialDraftOnly && status === "sent" && canWriteQuotes) {
      return {
        label: "Écrire",
        icon: Mail,
        title: "Préparer un message de suivi",
        href: `/app/quotes/${quote.id}?action=followup`,
      };
    }
    if (!trialDraftOnly && status === "draft" && canWriteQuotes) {
      return {
        label: "Envoyer",
        icon: Mail,
        title: "Préparer l'email client",
        href: `/app/quotes/${quote.id}?action=email`,
      };
    }
    return {
      label: "Ouvrir",
      icon: ArrowRight,
      title: "Ouvrir le détail",
      href: `/app/quotes/${quote.id}`,
    };
  };
  const showColumn = (key: QuoteColumnKey) => visibleColumns[key] !== false;
  const toggleColumn = (key: QuoteColumnKey) => {
    setVisibleColumns((current) => ({ ...current, [key]: !current[key] }));
  };
  return (
    <div>
      <AppPageHeader
        title="Devis"
        breadcrumb="Vente"
        description="Devis, statuts et conversion en facture."
        actions={
          canWriteQuotes ? (
            <div className="flex flex-wrap items-center gap-2">
              <GuidanceTooltip content="Démarrez un devis vierge. Vous pouvez ensuite le convertir en facture si le client accepte.">
                <Link
                  to="/app/quotes/new"
                  className="pf-cta-link inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-white transition-all hover:-translate-y-[1px]"
                  style={{
                    fontSize: "var(--pf-app-text-body)",
                    fontWeight: 700,
                    color: "#ffffff",
                    background: theme.gradient,
                    boxShadow: `0 10px 22px -16px ${theme.accent}bb`,
                  }}
                >
                  <Plus className="w-3.5 h-3.5" /> Créer un devis
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
            <NoticeBanner variant="warn" title="Pipeline commercial">
              {error}
            </NoticeBanner>
          ) : null}
          {notice ? (
            <NoticeBanner variant="success" title="Action effectuée">
              {notice}
            </NoticeBanner>
          ) : null}

          <SalesMetricsGrid>
            <SalesMetricCard
              tone="quotes"
              density="client"
              label="Devis"
              value={summary.total_count ?? quotes.length}
              detail={metricPeriodRange.label}
              icon={<Send className="h-4 w-4" />}
            />
            <SalesMetricCard
              tone="quotes"
              density="client"
              accent="info"
              label="Envoi"
              value={sentCount}
              detail={`Pipeline ${money(pipelineAmount)} · ${metricPeriodRange.label}`}
              icon={<Clock className="h-4 w-4" />}
            />
            <SalesMetricCard
              tone="quotes"
              density="client"
              accent="success"
              label="Acceptés"
              value={acceptedCount}
              detail={
                invoicedCount > 0
                  ? `${acceptedReadyCount} à transformer · ${invoicedCount} déjà facturé(s)`
                  : `À transformer · ${metricPeriodRange.label}`
              }
              icon={<CheckCircle2 className="h-4 w-4" />}
            />
            <SalesMetricCard
              tone="quotes"
              density="client"
              accent="danger"
              label="Refusés"
              value={rejectedCount}
              detail={`À retravailler · ${metricPeriodRange.label}`}
              icon={<XCircle className="h-4 w-4" />}
            />
          </SalesMetricsGrid>

          <SalesListBlock
            tone="quotes"
            density="client"
            filters={tabs.map((item) => ({
              value: item.val,
              label: item.label,
              count: item.count,
              accent: item.accent,
            }))}
            filterValue={tab}
            onFilterChange={(value) => {
              setPage(1);
              setTab(value);
            }}
            searchValue={search}
            onSearchChange={(value) => {
              setPage(1);
              setSearch(value);
            }}
            searchPlaceholder="N°, client, commande..."
            searchWidth="18rem"
            leftExtras={
              selectedQuoteCount > 0 ? (
                <ActionMenu label="Actions" badge={selectedQuoteCount} triggerVariant="purple">
                  <ActionMenuButton icon={Download} onClick={() => downloadQuotePdfs("selection")}>
                    Exporter les devis sélectionnés
                  </ActionMenuButton>
                  {canWriteQuotes && selectedDraftQuotes.length > 0 ? (
                    <ActionMenuButton
                      icon={Trash2}
                      disabled={rowActionBusy === "delete-draft-quotes"}
                      onClick={() => void deleteDraftQuotes(selectedQuotes)}
                    >
                      Supprimer les brouillons sélectionnés
                    </ActionMenuButton>
                  ) : null}
                  {selectedQuotes[0]?.id ? (
                    <ActionMenuLink to={`/app/quotes/${selectedQuotes[0].id}`} icon={ArrowRight}>
                      Ouvrir le premier devis
                    </ActionMenuLink>
                  ) : null}
                  <ActionMenuButton icon={CheckSquare} onClick={() => setSelectedQuoteIds([])}>
                    Désélectionner
                  </ActionMenuButton>
                </ActionMenu>
              ) : null
            }
            rightExtras={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <SalesPeriodControl
                  tone="quotes"
                  value={metricPeriod}
                  onChange={(nextValue) => {
                    setPage(1);
                    setMetricPeriod(nextValue as SalesPeriodPreset);
                  }}
                  monthValue={metricMonth}
                  onMonthChange={(nextValue) => {
                    setPage(1);
                    setMetricMonth(nextValue);
                  }}
                />
                <GuidanceTooltip content="Affiche les filtres détaillés : montant, email envoyé, acceptation et colonnes visibles.">
                  <button
                    type="button"
                    aria-pressed={advancedFiltersOpen}
                    onClick={() => setAdvancedFiltersOpen((current) => !current)}
                    className={`pf-filter-button inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-3 transition-colors ${
                      advancedFiltersOpen || activeAdvancedFilterCount > 0
                        ? "border-transparent bg-[#f5f3ff] text-[#6d28d9]"
                        : "border-transparent bg-[#f1f5f9] text-[#6d28d9]"
                    }`}
                    style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Filtres
                    {activeAdvancedFilterCount > 0 ? (
                      <span
                        className="rounded-full bg-[#6d28d9] px-1.5 py-0.5 text-white"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 900 }}
                      >
                        {activeAdvancedFilterCount}
                      </span>
                    ) : null}
                    {advancedFiltersOpen ? (
                      <span className="text-[#6d28d9]/65" aria-hidden="true">
                        ×
                      </span>
                    ) : null}
                  </button>
                </GuidanceTooltip>
                <GuidanceTooltip content="Afficher les options d'export des devis.">
                  <button
                    type="button"
                    onClick={() => setExportToolsOpen((current) => !current)}
                    aria-label="Exporter les devis"
                    aria-pressed={exportToolsOpen}
                    title="Exporter les devis"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#7c3aed] text-white shadow-[0_2px_6px_rgba(124,58,237,0.24)] transition-all hover:brightness-95"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                </GuidanceTooltip>
              </div>
            }
          >
            {advancedFiltersOpen ? (
              <div data-testid="quote-filters-panel" className="pf-filter-panel border-b border-[#e5edf5] bg-[#f8fafc]">
                <div className="grid divide-y divide-[#e5edf5] lg:grid-cols-[0.95fr_0.95fr_1fr] lg:divide-x lg:divide-y-0">
                  <section className="px-4 py-4">
                    <div
                      className="mb-3 flex items-center gap-1.5 uppercase tracking-[0.04em] text-[#475569]"
                      style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 700 }}
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 text-[#6d28d9]" /> Montants
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
                          onChange={(event) => setMinTotalHt(event.target.value)}
                          placeholder="500"
                          className="mt-1 h-9 w-full rounded-xl border border-[#e9d5ff] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#6d28d9] focus:ring-2 focus:ring-[#6d28d9]/15"
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
                          onChange={(event) => setMaxTotalHt(event.target.value)}
                          placeholder="5000"
                          className="mt-1 h-9 w-full rounded-xl border border-[#e9d5ff] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#6d28d9] focus:ring-2 focus:ring-[#6d28d9]/15"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        />
                      </label>
                    </div>
                  </section>

                  <section className="px-4 py-4">
                    <div
                      className="mb-3 flex items-center gap-1.5 uppercase tracking-[0.04em] text-[#475569]"
                      style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 700 }}
                    >
                      <Send className="h-3.5 w-3.5 text-[#6d28d9]" /> Suivi client
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label
                        className="block text-[#64748b]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                      >
                        Email
                        <select
                          value={emailFilter}
                          onChange={(event) => setEmailFilter(event.target.value)}
                          className="mt-1 h-9 w-full rounded-xl border border-[#e9d5ff] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#6d28d9] focus:ring-2 focus:ring-[#6d28d9]/15"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        >
                          <option value="all">Tous</option>
                          <option value="sent">Envoyés</option>
                          <option value="not_sent">Non envoyés</option>
                        </select>
                      </label>
                      <label
                        className="block text-[#64748b]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 600 }}
                      >
                        Acceptation
                        <select
                          value={signatureFilter}
                          onChange={(event) => setSignatureFilter(event.target.value)}
                          className="mt-1 h-9 w-full rounded-xl border border-[#e9d5ff] bg-white px-3 font-medium text-[#0f172a] outline-none focus:border-[#6d28d9] focus:ring-2 focus:ring-[#6d28d9]/15"
                          style={{ fontSize: "var(--pf-app-text-body)" }}
                        >
                          <option value="all">Tous</option>
                          <option value="signed">Acceptés</option>
                          <option value="not_signed">Non acceptés</option>
                        </select>
                      </label>
                    </div>
                  </section>

                  <section className="px-4 py-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div
                        className="flex items-center gap-1.5 uppercase tracking-[0.04em] text-[#475569]"
                        style={{ fontSize: "var(--pf-app-text-overline)", fontWeight: 700 }}
                      >
                        <Columns3 className="h-3.5 w-3.5 text-[#6d28d9]" /> Colonnes affichées
                      </div>
                      {hasActiveFilters ? (
                        <GuidanceTooltip content="Réinitialise les filtres et revient à tous les devis.">
                          <button
                            type="button"
                            onClick={resetFilters}
                            className="text-[#6d28d9] transition-colors hover:text-[#5b21b6]"
                            style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                          >
                            Réinitialiser
                          </button>
                        </GuidanceTooltip>
                      ) : null}
                    </div>
                    <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
                      {quoteColumnOptions.map((column) => (
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
                            className="h-4 w-4 rounded border-[#cbd5e1] text-[#6d28d9]"
                            style={{ accentColor: "#6d28d9" }}
                          />
                          <span>{column.label}</span>
                        </label>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            ) : null}

            {exportToolsOpen ? (
              <div data-testid="quote-export-panel" className="border-b border-[#ddd6fe] bg-[#f5f3ff] px-4 py-3">
                <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-end 2xl:justify-between">
                  <div className="grid flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(240px,1.15fr)_minmax(160px,0.72fr)_minmax(160px,0.72fr)_minmax(220px,1fr)]">
                    <label
                      className="text-[#475569]"
                      style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                    >
                      Client
                      <select
                        value={selectedCustomerId}
                        onChange={(event) => {
                          setPage(1);
                          setSelectedCustomerId(event.target.value);
                        }}
                        className="mt-1 h-11 w-full rounded-xl border border-[#ddd6fe] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#7c3aed] focus:ring-2 focus:ring-[#7c3aed]/15"
                        style={{ fontSize: "var(--pf-app-text-body)" }}
                      >
                        <option value="">Tous les clients</option>
                        {customers.map((customer) => (
                          <option key={customer.id} value={customer.id}>
                            {quoteCustomerOptionLabel(customer)}
                          </option>
                        ))}
                      </select>
                    </label>
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
                        className="mt-1 h-11 min-w-[10rem] w-full rounded-xl border border-[#ddd6fe] bg-white px-3 text-[#0f172a] outline-none focus:border-[#7c3aed] focus:ring-2 focus:ring-[#7c3aed]/15"
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
                        className="mt-1 h-11 min-w-[10rem] w-full rounded-xl border border-[#ddd6fe] bg-white px-3 text-[#0f172a] outline-none focus:border-[#7c3aed] focus:ring-2 focus:ring-[#7c3aed]/15"
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
                        onChange={(event) => setExportFormat(event.target.value as QuoteExportFormat)}
                        className="mt-1 h-11 min-w-[13.75rem] w-full rounded-xl border border-[#ddd6fe] bg-white px-3 font-bold text-[#0f172a] outline-none focus:border-[#7c3aed] focus:ring-2 focus:ring-[#7c3aed]/15"
                        style={{ fontSize: "var(--pf-app-text-body)" }}
                      >
                        {Object.entries(quoteExportFormats).map(([value, item]) => (
                          <option key={value} value={value}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 2xl:justify-end">
                    <GuidanceTooltip content="Exporte les devis qui correspondent aux filtres affichés.">
                      <button
                        type="button"
                        onClick={() => setExportScope("filtered")}
                        aria-label={`Exporter les devis filtrés, ${totalCount || filteredQuotes.length} devis`}
                        className={`rounded-full border px-3 py-1.5 transition-colors ${
                          exportScope === "filtered"
                            ? "border-[#7c3aed] bg-white text-[#7c3aed]"
                            : "border-[#ddd6fe] bg-[#faf5ff] text-[#64748b] hover:bg-white"
                        }`}
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                      >
                        Devis filtrés · {totalCount || filteredQuotes.length}
                      </button>
                    </GuidanceTooltip>
                    <GuidanceTooltip content="Exporte uniquement les devis cochés dans la liste.">
                      <button
                        type="button"
                        onClick={() => selectedQuoteCount > 0 && setExportScope("selection")}
                        disabled={selectedQuoteCount === 0}
                        aria-label={`Exporter les devis sélectionnés, ${selectedQuoteCount} devis cochés`}
                        className={`rounded-full border px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          exportScope === "selection"
                            ? "border-[#7c3aed] bg-white text-[#7c3aed]"
                            : "border-[#ddd6fe] bg-[#faf5ff] text-[#64748b] hover:bg-white"
                        }`}
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                      >
                        Devis cochés · {selectedQuoteCount}
                      </button>
                    </GuidanceTooltip>
                    <GuidanceTooltip
                      content={`Télécharge les ${quoteExportFormats[exportFormat].label} avec le périmètre choisi.`}
                    >
                      <button
                        type="button"
                        onClick={() => void downloadQuotePdfs()}
                        aria-label={
                          exportScope === "selection" ? "Exporter les devis sélectionnés" : "Exporter les devis filtrés"
                        }
                        disabled={
                          (exportScope === "selection" && selectedQuoteCount === 0) || rowActionBusy === "bulk-pdf"
                        }
                        className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[#7c3aed] px-4 text-white shadow-[0_10px_22px_-16px_rgba(124,58,237,0.8)] transition-all hover:-translate-y-[1px] hover:bg-[#6d28d9] disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 900 }}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {exportScope === "selection" ? "Exporter les devis sélectionnés" : "Exporter les devis filtrés"}
                      </button>
                    </GuidanceTooltip>
                  </div>
                </div>
              </div>
            ) : null}

            {!hydrated || loading ? (
              <div className="px-5 py-14 text-center text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-body)" }}>
                Chargement des devis…
              </div>
            ) : filteredQuotes.length === 0 ? (
              <div className="px-5 py-14 text-center">
                <div className="flex flex-col items-center gap-2">
                  <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                    <Send className="h-5 w-5 text-[#cbd5e1]" />
                  </div>
                  <p className="text-[#64748b]" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 500 }}>
                    {hasActiveFilters ? "Aucun résultat pour ces filtres" : "Aucun devis pour l'instant"}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-body)" }}>
                    {search
                      ? `"${search}" ne correspond à aucun devis.`
                      : hasActiveFilters
                        ? "Modifie ou réinitialise les filtres pour élargir la liste."
                        : "Créez un devis pour commencer votre pipeline commercial."}
                  </p>
                  {hasActiveFilters ? (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="mt-1 text-[#6d28d9] transition-colors hover:text-[#5b21b6]"
                      style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 500 }}
                    >
                      Voir tous les devis
                    </button>
                  ) : canWriteQuotes ? (
                    <Link
                      to="/app/quotes/new"
                      className="pf-cta-link mt-2 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-white transition-all"
                      style={{
                        fontSize: "var(--pf-app-text-body)",
                        fontWeight: 500,
                        color: "#ffffff",
                        background: theme.accent,
                      }}
                    >
                      <Plus className="w-3.5 h-3.5" /> Créer un devis
                    </Link>
                  ) : (
                    <span className="mt-2 text-xs font-medium text-[#64748b]">Consultation seule pour votre rôle.</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto bg-white">
                <table className="pf-data-table w-full min-w-[940px]">
                  <thead className="sticky top-0 z-10">
                    <tr style={{ borderBottom: "1px solid #f0f2f8" }}>
                      <th
                        className="w-[240px] px-4 py-2.5 text-left"
                        style={{
                          fontSize: "var(--pf-app-text-overline)",
                          fontWeight: 900,
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          color: "#94a3b8",
                          background: "#fafbfe",
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={allPageQuotesSelected}
                            onChange={toggleQuotePageSelection}
                            aria-label="Sélectionner les devis de la page"
                            className="h-[15px] w-[15px] rounded border-[#d1dcec]"
                            style={{ accentColor: "#7c3aed" }}
                          />
                          <QuoteColumnHeader sortKey="number" sortState={sortState} onSort={toggleSort}>
                            Numéro
                          </QuoteColumnHeader>
                        </div>
                      </th>
                      {showColumn("customer") ? (
                        <th
                          className="px-3 py-2 text-left"
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 900,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                            background: "#fafbfe",
                          }}
                        >
                          <QuoteColumnHeader sortKey="customer" sortState={sortState} onSort={toggleSort}>
                            Client
                          </QuoteColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("issue_date") ? (
                        <th
                          className="px-3 py-2 text-left"
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 900,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                            background: "#fafbfe",
                          }}
                        >
                          <QuoteColumnHeader sortKey="issue_date" sortState={sortState} onSort={toggleSort}>
                            Date
                          </QuoteColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("valid_until") ? (
                        <th
                          className="px-3 py-2 text-left"
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 900,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                            background: "#fafbfe",
                          }}
                        >
                          <QuoteColumnHeader sortKey="valid_until" sortState={sortState} onSort={toggleSort}>
                            Validité
                          </QuoteColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("email") ? (
                        <th
                          className="px-3 py-2 text-left"
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 900,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                            background: "#fafbfe",
                          }}
                        >
                          <QuoteColumnHeader sortKey="email" sortState={sortState} onSort={toggleSort}>
                            Email
                          </QuoteColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("signature") ? (
                        <th
                          className="px-3 py-2 text-left"
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 900,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                            background: "#fafbfe",
                          }}
                        >
                          <QuoteColumnHeader sortKey="signature" sortState={sortState} onSort={toggleSort}>
                            Acceptation
                          </QuoteColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("total_ht") ? (
                        <th
                          className="px-3 py-2 text-right"
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 900,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                            background: "#fafbfe",
                          }}
                        >
                          <QuoteColumnHeader align="right" sortKey="total_ht" sortState={sortState} onSort={toggleSort}>
                            Total HT
                          </QuoteColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("total_ttc") ? (
                        <th
                          className="px-3 py-2 text-right"
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 900,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                            background: "#fafbfe",
                          }}
                        >
                          <QuoteColumnHeader
                            align="right"
                            sortKey="total_ttc"
                            sortState={sortState}
                            onSort={toggleSort}
                          >
                            Total TTC
                          </QuoteColumnHeader>
                        </th>
                      ) : null}
                      {showColumn("status") ? (
                        <th
                          className="w-[150px] px-3 py-2 text-center"
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 900,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                            background: "#fafbfe",
                          }}
                        >
                          <QuoteColumnHeader align="center" sortKey="status" sortState={sortState} onSort={toggleSort}>
                            Statut
                          </QuoteColumnHeader>
                        </th>
                      ) : null}
                      <th className="w-[230px] px-3 py-2 text-right" style={{ background: "#fafbfe" }} />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f8f9fd]">
                    {pageQuotes.map((q) => {
                      const numberDisplay = quoteNumberDisplay(q);
                      const rowTone = quoteRowTone(q.status);
                      const isDraftQuote = String(q.status || "").toLowerCase() === "draft";
                      const canShareQuote =
                        !trialDraftOnly &&
                        !["draft", "rejected", "invoiced", "expired"].includes(String(q.status || "").toLowerCase());
                      const customerName = q.customer_name || "Client";
                      const customerEmail = String(q.customer_email || q.customer?.email || "").trim();
                      const customerId = String(q.customer_id || q.customer?.id || "");
                      const primaryAction = quotePrimaryAction(q);
                      const PrimaryActionIcon = primaryAction.icon;
                      const quoteStatus = String(q.status || "").toLowerCase();
                      const canOpenLinkedInvoice = Boolean(q.invoice_id);
                      const canPrepareQuoteInvoice = quoteStatus === "accepted" && !q.invoice_id;
                      const canPrepareQuoteFollowup = !trialDraftOnly && quoteStatus === "sent";
                      const canPrepareQuoteEmail = !trialDraftOnly && quoteStatus === "draft";
                      return (
                        <tr
                          key={q.id}
                          role="link"
                          tabIndex={0}
                          onClick={(event) => {
                            if (isInteractiveRowTarget(event.target)) return;
                            navigate(`/app/quotes/${q.id}`);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            if (isInteractiveRowTarget(event.target)) return;
                            event.preventDefault();
                            navigate(`/app/quotes/${q.id}`);
                          }}
                          className={`group pf-clickable-row border-l-2 border-transparent transition-colors ${rowTone.hover}`}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex min-w-0 items-center gap-3">
                              <input
                                type="checkbox"
                                checked={selectedQuoteIds.includes(String(q.id))}
                                onChange={() => toggleQuoteSelection(String(q.id))}
                                aria-label={`Sélectionner ${numberDisplay.label}`}
                                className="h-[15px] w-[15px] flex-shrink-0 rounded border-[#d1dcec]"
                                style={{ accentColor: "#7c3aed" }}
                              />
                              <Link
                                to={`/app/quotes/${q.id}`}
                                className="flex min-w-0 items-center gap-2 transition-colors"
                                title={numberDisplay.title}
                              >
                                <span
                                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg"
                                  style={{ background: rowTone.iconBg }}
                                >
                                  <FileText className="h-3 w-3" style={{ color: rowTone.iconColor }} />
                                </span>
                                <span
                                  className="pf-doc-number truncate font-mono"
                                  style={{
                                    color: isDraftQuote ? "#64748b" : theme.strong,
                                    fontSize: "var(--pf-app-text-body)",
                                    fontWeight: 900,
                                  }}
                                >
                                  {numberDisplay.label}
                                </span>
                              </Link>
                              <div className="pf-mobile-row-summary mt-2 flex flex-wrap items-center gap-1.5">
                                <StatusPill {...(statusMap[q.status] || { label: q.status || "—", color: "muted" })} />
                                <span className="rounded-full bg-[#f8fafc] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#475569]">
                                  {money(q.total_inc_vat || 0, q.currency || "EUR", 2)}
                                </span>
                                <span className="rounded-full bg-[#f5f3ff] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#6d28d9]">
                                  {customerName}
                                </span>
                                <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#64748b]">
                                  Validité {formatDateFr(q.valid_until, "—")}
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
                                    fontWeight: 900,
                                  }}
                                >
                                  {customerInitials(customerName)}
                                </span>
                                <div className="min-w-0">
                                  {customerId ? (
                                    <Link
                                      to={`/app/customers/${customerId}`}
                                      className="pf-row-title block truncate text-[#0f172a] transition hover:text-[#6d28d9] hover:underline hover:underline-offset-2"
                                      title={`Ouvrir la fiche client ${customerName}`}
                                      style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700, lineHeight: 1.15 }}
                                    >
                                      {customerName}
                                    </Link>
                                  ) : (
                                    <p
                                      className="pf-row-title truncate text-[#0f172a]"
                                      style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700, lineHeight: 1.15 }}
                                    >
                                      {customerName}
                                    </p>
                                  )}
                                  <p
                                    className="pf-row-subtitle mt-0.5 hidden truncate text-[#94a3b8] lg:block"
                                    style={{ fontSize: "var(--pf-app-text-overline)", lineHeight: 1.15 }}
                                  >
                                    {customerEmail || "Email non renseigné"}
                                  </p>
                                </div>
                              </div>
                            </td>
                          ) : null}
                          {showColumn("issue_date") ? (
                            <td
                              className="px-3 py-2.5 text-[#6b7494]"
                              style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 600 }}
                            >
                              {formatDateFr(q.issue_date, "—")}
                            </td>
                          ) : null}
                          {showColumn("valid_until") ? (
                            <td
                              className="px-3 py-2.5 text-[#6b7494]"
                              style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                            >
                              {formatDateFr(q.valid_until, "—")}
                            </td>
                          ) : null}
                          {showColumn("email") ? (
                            <td className="px-3 py-2.5">
                              <StatusPill
                                color={isQuoteEmailSent(q) ? "info" : "muted"}
                                label={isQuoteEmailSent(q) ? "Envoyé" : "Non envoyé"}
                              />
                            </td>
                          ) : null}
                          {showColumn("signature") ? (
                            <td className="px-3 py-2.5">
                              <StatusPill
                                color={isAcceptedOrInvoicedQuote(q) || q.accepted_at ? "ok" : "warn"}
                                label={isAcceptedOrInvoicedQuote(q) || q.accepted_at ? "Accepté" : "À signer"}
                              />
                            </td>
                          ) : null}
                          {showColumn("total_ht") ? (
                            <td
                              className="px-3 py-2.5 text-right text-[#0f172a]"
                              style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 900 }}
                            >
                              {money(q.total_ex_vat || 0, q.currency || "EUR", 2)}
                            </td>
                          ) : null}
                          {showColumn("total_ttc") ? (
                            <td className="px-3 py-2.5 text-right">
                              <span
                                className="pf-table-amount font-mono text-[#0f172a]"
                                style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 900 }}
                              >
                                {money(q.total_inc_vat || 0, q.currency || "EUR", 2)}
                              </span>
                            </td>
                          ) : null}
                          {showColumn("status") ? (
                            <td className="w-[150px] px-3 py-2.5 text-center">
                              <StatusPill {...(statusMap[q.status] || { label: q.status || "—", color: "muted" })} />
                            </td>
                          ) : null}
                          <td className="pf-row-actions-cell px-3 py-2.5" data-no-row-open="true">
                            <div
                              className="pf-row-actions flex items-center justify-end gap-1.5"
                              data-no-row-open="true"
                            >
                              {"href" in primaryAction ? (
                                <Link
                                  to={primaryAction.href}
                                  className="pf-primary-row-action inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#ddd6fe] bg-[#f5f3ff] px-2.5 text-[#6d28d9] transition-colors hover:bg-[#ede9fe]"
                                  title={primaryAction.title}
                                  aria-label={`${primaryAction.label} ${numberDisplay.label}`}
                                  style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                                >
                                  <PrimaryActionIcon className="h-3.5 w-3.5" />
                                  {primaryAction.label}
                                </Link>
                              ) : (
                                <button
                                  type="button"
                                  onClick={primaryAction.onClick}
                                  disabled={primaryAction.disabled}
                                  className="pf-primary-row-action inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#ddd6fe] bg-[#f5f3ff] px-2.5 text-[#6d28d9] transition-colors hover:bg-[#ede9fe] disabled:cursor-not-allowed disabled:opacity-50"
                                  title={primaryAction.title}
                                  aria-label={`${primaryAction.label} ${numberDisplay.label}`}
                                  style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                                >
                                  <PrimaryActionIcon className="h-3.5 w-3.5" />
                                  {primaryAction.label}
                                </button>
                              )}
                              <ActionMenu
                                label={`Actions ${numberDisplay.label}`}
                                iconOnly
                                triggerIcon={MoreHorizontal}
                                className="pf-row-action-menu"
                              >
                                <ActionMenuButton
                                  icon={Download}
                                  disabled={rowActionBusy === `pdf:${q.id}`}
                                  onClick={() => void downloadQuotePdf(q)}
                                >
                                  Télécharger le PDF
                                </ActionMenuButton>
                                {canWriteQuotes ? (
                                  <ActionMenuButton
                                    icon={Copy}
                                    disabled={!canShareQuote || rowActionBusy === `share:${q.id}`}
                                    onClick={() => void copyQuotePortalLink(q)}
                                  >
                                    Copier le lien client
                                  </ActionMenuButton>
                                ) : null}
                                {canWriteQuotes && isDraftQuote ? (
                                  <ActionMenuButton
                                    icon={Trash2}
                                    disabled={rowActionBusy === "delete-draft-quotes"}
                                    onClick={() => void deleteDraftQuotes([q])}
                                  >
                                    Supprimer le brouillon
                                  </ActionMenuButton>
                                ) : null}
                                {canOpenLinkedInvoice && primaryAction.href !== `/app/invoices/${q.invoice_id}` ? (
                                  <ActionMenuLink to={`/app/invoices/${q.invoice_id}`} icon={FileText}>
                                    Ouvrir la facture
                                  </ActionMenuLink>
                                ) : null}
                                {canConvertQuotes &&
                                canPrepareQuoteInvoice &&
                                primaryAction.href !== `/app/quotes/${q.id}` ? (
                                  <ActionMenuLink to={`/app/quotes/${q.id}`} icon={RefreshCw}>
                                    Préparer facture
                                  </ActionMenuLink>
                                ) : null}
                                {canWriteQuotes &&
                                canPrepareQuoteFollowup &&
                                primaryAction.href !== `/app/quotes/${q.id}?action=followup` ? (
                                  <ActionMenuLink to={`/app/quotes/${q.id}?action=followup`} icon={Mail}>
                                    Préparer un suivi
                                  </ActionMenuLink>
                                ) : null}
                                {canWriteQuotes &&
                                canPrepareQuoteEmail &&
                                primaryAction.href !== `/app/quotes/${q.id}?action=email` ? (
                                  <ActionMenuLink to={`/app/quotes/${q.id}?action=email`} icon={Mail}>
                                    Préparer l'email
                                  </ActionMenuLink>
                                ) : null}
                                <ActionMenuLink to={`/app/quotes/${q.id}`} icon={ArrowRight}>
                                  Ouvrir le détail
                                </ActionMenuLink>
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

            <ListPagination
              page={page}
              totalItems={totalCount || filteredQuotes.length}
              pageSize={pageSize}
              pageSizeOptions={QUOTE_PAGE_SIZE_OPTIONS}
              pageSizeAriaLabel="Devis par page"
              itemLabel="devis"
              pluralLabel="devis"
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPage(1);
                setPageSize(nextPageSize);
              }}
              action={
                <div className="flex items-center gap-3">
                  {hasActiveFilters ? (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="text-xs font-medium text-[#6d28d9] transition-colors hover:text-[#5b21b6]"
                    >
                      Réinitialiser
                    </button>
                  ) : null}
                </div>
              }
            />
          </SalesListBlock>
        </div>
      </WorkbenchPage>
    </div>
  );
}

export { QuoteDetailPage, QuoteNewPage } from "../../../src/figma/app/pages/app/QuotesPage";
