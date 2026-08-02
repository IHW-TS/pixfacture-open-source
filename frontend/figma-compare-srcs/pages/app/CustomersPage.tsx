import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ActionMenu, AppPageHeader, NoticeBanner, StatCard } from "../../components/app/AppPageHeader";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  Building2,
  CheckSquare,
  Download,
  FileText,
  Plus,
  Settings,
  TrendingUp,
  Upload,
  Users,
  X,
} from "lucide-react";
import { apiFetch, apiUpload, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { downloadProtectedFile } from "@/lib/download";
import { fetchPaginatedList } from "@/lib/paginatedFetch";
import { can } from "@/lib/permissions";
import { useHydrated } from "@/lib/useHydrated";
import { useSession } from "@/lib/useSession";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import { SalesListBlock, SalesPeriodControl } from "../../../src/figma/app/components/app/SalesModuleLayout";
import { ListPagination, paginateList } from "../../../src/figma/app/components/app/ListPagination";
import { GuidanceTooltip } from "../../../src/figma/app/components/app/GuidanceTooltip";

const CUSTOMER_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const CUSTOMER_PAGE_SIZE_STORAGE_KEY = "pixfacture.customers.pageSize.v1";
const CUSTOMER_API_PAGE_LIMIT = 200;
const CUSTOMER_LIST_MAX_PREFETCH = 1000;

function readStoredCustomerPageSize() {
  if (typeof window === "undefined") return CUSTOMER_PAGE_SIZE_OPTIONS[0];
  const stored = Number(window.localStorage.getItem(CUSTOMER_PAGE_SIZE_STORAGE_KEY));
  return CUSTOMER_PAGE_SIZE_OPTIONS.some((option) => option === stored) ? stored : CUSTOMER_PAGE_SIZE_OPTIONS[0];
}

function money(value: any) {
  return `${Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

function moneyDetailed(value: any) {
  return `${Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

function csvEscape(value: any) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function isInteractiveRowTarget(target: EventTarget | null) {
  return target instanceof Element
    ? Boolean(target.closest("a,button,input,select,textarea,label,[role='button'],[data-no-row-open='true']"))
    : false;
}

function statusConfig(item: any) {
  const risk = String(item?.risk_level || "").toLowerCase();
  const segment = String(item?.segment || "").toLowerCase();

  if (["new_business"].includes(segment)) return { label: "Nouveau", color: "info" as const, kind: "new" as const };
  if (segment === "at_risk" || ["critical", "high"].includes(risk)) {
    return { label: "À suivre", color: "warn" as const, kind: "risk" as const };
  }
  if (segment === "watchlist" || ["medium"].includes(risk)) {
    return { label: "À suivre", color: "warn" as const, kind: "risk" as const };
  }
  return { label: "Actif", color: "ok" as const, kind: "active" as const };
}

function hasInvoiceActivity(item: any) {
  return Number(item?.portfolio?.invoice_count_total ?? item?.invoice_count_total ?? item?.invoices ?? 0) > 0;
}

function statusKind(item: any) {
  return statusConfig(item?.portfolio || item).kind;
}

function portfolioNumber(item: any, keys: string[]) {
  const source = item?.portfolio || {};
  for (const key of keys) {
    const value = Number(source[key] ?? item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function portfolioOptionalNumber(item: any, keys: string[]) {
  const source = item?.portfolio || {};
  for (const key of keys) {
    const raw = source[key] ?? item?.[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function portfolioSegmentLabel(item: any) {
  const source = item?.portfolio || {};
  const explicit = String(source.segment_label || source.segment || "").trim();
  if (explicit) return explicit.replaceAll("_", " ");
  return item?.status?.label || statusConfig(source || item).label;
}

function daysLabel(value: any) {
  if (value === null || value === undefined || value === "") return "Non disponible";
  const days = Number(value);
  if (!Number.isFinite(days)) return "Non disponible";
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return "1 jour";
  return `${days} jours`;
}

function textValue(value: any) {
  return String(value || "").trim();
}

function customerAddressLabel(customer: any) {
  const direct = textValue(customer.address).split(/\r?\n/).find(Boolean);
  const structured = [
    customer.address_line1,
    [customer.postal_code, customer.city].map(textValue).filter(Boolean).join(" "),
  ]
    .map(textValue)
    .filter(Boolean);
  return direct || structured.join(" · ");
}

function customerContactLabel(customer: any) {
  const contact = textValue(customer.contact_name);
  const email = textValue(customer.email || customer.portfolio?.customer_email);
  if (contact && email) return `${contact} · ${email}`;
  return contact || email || "Contact non renseigné";
}

function customerSecondaryContactLabel(customer: any) {
  const phone = textValue(customer.phone);
  const address = customerAddressLabel(customer);
  return phone || address || "Téléphone/adresse à compléter";
}

type CustomerTypeFilter = "all" | "business" | "individual" | "public";
type CustomerSortKey = "client" | "contact" | "type" | "activity" | "openBalance" | "overdue";
type CustomerSortDirection = "asc" | "desc";

function normalizeCustomerType(item: any): CustomerTypeFilter {
  const raw = String(item?.client_type || "").toLowerCase();
  if (raw === "individual") return "individual";
  if (["public", "public_sector", "government", "state", "b2g"].includes(raw)) return "public";
  return "business";
}

function customerTypeLabel(item: any) {
  const type = normalizeCustomerType(item);
  if (type === "individual") return "Particulier";
  if (type === "public") return "Public";
  return "Entreprise";
}

function customerTypeClasses(item: any) {
  const type = normalizeCustomerType(item);
  if (type === "individual") return "border-[#ddd6fe] bg-[#f5f3ff] text-[#7c3aed]";
  if (type === "public") return "border-[#fed7aa] bg-[#fff7ed] text-[#c2410c]";
  return "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]";
}

function matchesStatusFilter(item: any, filter: StatusFilter) {
  if (filter === "all") return true;

  if (filter === "active") return hasInvoiceActivity(item);
  if (filter === "new") return statusKind(item) === "new";
  if (filter === "risk") return statusKind(item) === "risk";

  return false;
}

function matchesTypeFilter(item: any, filter: CustomerTypeFilter) {
  if (filter === "all") return true;
  return normalizeCustomerType(item) === filter;
}

const countryFlags: Record<string, string> = {
  FR: "🇫🇷",
  DE: "🇩🇪",
  BE: "🇧🇪",
  CH: "🇨🇭",
  LU: "🇱🇺",
  ES: "🇪🇸",
  IT: "🇮🇹",
  US: "🇺🇸",
};

type StatusFilter = "all" | "active" | "new" | "risk";
type CustomerPeriodFilter = "30" | "today" | "7" | "90" | "all";

const customerTypeTabs: { val: CustomerTypeFilter; label: string }[] = [
  { val: "all", label: "Tous" },
  { val: "business", label: "Entreprises" },
  { val: "individual", label: "Particuliers" },
  { val: "public", label: "Public" },
];
const CUSTOMER_DEFAULT_PERIOD: CustomerPeriodFilter = "all";
const customerPeriodOptions: { value: CustomerPeriodFilter; label: string }[] = [
  { value: "30", label: "30 derniers jours" },
  { value: "today", label: "Aujourd'hui" },
  { value: "7", label: "7 derniers jours" },
  { value: "90", label: "90 derniers jours" },
  { value: "all", label: "Tout l'historique" },
];

const customerListGridClassWithPayments =
  "grid min-w-[1120px] grid-cols-[1.75rem_minmax(13rem,1fr)_minmax(12rem,1fr)_minmax(8rem,0.75fr)_minmax(9rem,0.75fr)_minmax(9rem,0.75fr)_minmax(9rem,0.75fr)_2.5rem] items-center gap-5";
const customerRowContentGridClassWithPayments =
  "group col-span-7 grid min-w-0 grid-cols-[minmax(13rem,1fr)_minmax(12rem,1fr)_minmax(8rem,0.75fr)_minmax(9rem,0.75fr)_minmax(9rem,0.75fr)_minmax(9rem,0.75fr)_2.5rem] items-center gap-5";
const customerListGridClassWithoutPayments =
  "grid min-w-[820px] grid-cols-[1.75rem_minmax(13rem,1fr)_minmax(12rem,1fr)_minmax(8rem,0.75fr)_minmax(9rem,0.75fr)_2.5rem] items-center gap-5";
const customerRowContentGridClassWithoutPayments =
  "group col-span-5 grid min-w-0 grid-cols-[minmax(13rem,1fr)_minmax(12rem,1fr)_minmax(8rem,0.75fr)_minmax(9rem,0.75fr)_2.5rem] items-center gap-5";
const PAYMENT_CUSTOMER_SORT_KEYS = new Set<CustomerSortKey>(["openBalance", "overdue"]);

const customerSortColumns: Array<{
  key?: CustomerSortKey;
  label: string;
  className: string;
  align?: "left" | "center" | "right";
}> = [
  {
    key: "client",
    label: "Client",
    className: "min-w-0",
  },
  { key: "contact", label: "Contact", className: "min-w-0" },
  { key: "type", label: "Type", className: "min-w-0", align: "center" },
  { key: "activity", label: "Activité", className: "min-w-0" },
  { key: "openBalance", label: "Encours ouvert", className: "min-w-0", align: "right" },
  { key: "overdue", label: "En retard", className: "min-w-0", align: "right" },
  { label: "", className: "min-w-0 text-right" },
];

function matchesCustomerPeriod(item: any, filter: CustomerPeriodFilter) {
  if (filter === "all") return true;
  const days = portfolioOptionalNumber(item, ["days_since_last_activity"]);
  if (days === null) return true;
  if (filter === "today") return days <= 0;
  return days <= Number(filter);
}

export function CustomersListPage() {
  const hydrated = useHydrated();
  const { user, capabilities } = useSession();
  const canWriteCustomers = can(user, "customers:write");
  const canExportCustomers = can(user, "customers:export");
  const canManageCustomers = can(user, "admin");
  const paymentsEnabled = Boolean(capabilities?.payments_enabled);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [customerTotalCount, setCustomerTotalCount] = useState<number | null>(null);
  const [customersTruncated, setCustomersTruncated] = useState(false);
  const [portfolio, setPortfolio] = useState<any>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [subscriptionGate, setSubscriptionGate] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<CustomerTypeFilter>("all");
  const [customerPeriodFilter, setCustomerPeriodFilter] = useState<CustomerPeriodFilter>(CUSTOMER_DEFAULT_PERIOD);
  const [sortState, setSortState] = useState<{ key: CustomerSortKey; direction: CustomerSortDirection } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => readStoredCustomerPageSize());
  const [portfolioMode, setPortfolioMode] = useState(false);
  const [customerExportToolsOpen, setCustomerExportToolsOpen] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [dedupeConfirmArmed, setDedupeConfirmArmed] = useState(false);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const customerListGridClass = paymentsEnabled
    ? customerListGridClassWithPayments
    : customerListGridClassWithoutPayments;
  const customerRowContentGridClass = paymentsEnabled
    ? customerRowContentGridClassWithPayments
    : customerRowContentGridClassWithoutPayments;
  const visibleCustomerSortColumns = customerSortColumns.filter(
    (column) => !column.key || paymentsEnabled || !PAYMENT_CUSTOMER_SORT_KEYS.has(column.key),
  );
  const portfolioViewEnabled = paymentsEnabled && portfolioMode;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      setSubscriptionGate(null);
      setPermissionDenied(null);

      try {
        const customersPayload = await fetchPaginatedList<any>({
          rawApi,
          endpoint: "/api/customers",
          limit: CUSTOMER_API_PAGE_LIMIT,
          maxItems: CUSTOMER_LIST_MAX_PREFETCH,
        });
        if (cancelled) return;
        setCustomers(customersPayload.items);
        setCustomerTotalCount(customersPayload.total);
        setCustomersTruncated(customersPayload.truncated);
      } catch (err: any) {
        if (!cancelled) {
          const response = err?.response;
          const payload = err?.payload;
          const detail = payload?.detail;
          const code = typeof detail === "object" ? detail?.code : payload?.code;
          if (response?.status === 402 || code === "subscription_required") {
            const message = extractUserFacingApiMessage(
              payload,
              response?.status,
              "Cette page nécessite un abonnement actif.",
            );
            setSubscriptionGate(
              /^abonnement requis\.?$/i.test(String(message).trim())
                ? "Choisissez un abonnement pour réactiver l'accès aux clients."
                : message,
            );
            setError(null);
            return;
          }
          if (response?.status === 403 || code === "forbidden") {
            setPermissionDenied(
              "Votre rôle ne permet pas d'ouvrir la base clients. Demandez un accès à l'administrateur de l'espace.",
            );
            setError(null);
            return;
          }
          if (process.env.NODE_ENV === "development") {
            console.warn("[customers] customer list unavailable", err);
          }
          setCustomers([]);
          setCustomerTotalCount(null);
          setCustomersTruncated(false);
          setSubscriptionGate(null);
          setPermissionDenied(null);
          setError(formatApiError(err, "Impossible de charger les clients."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadCustomers = useCallback(async () => {
    const payload = await fetchPaginatedList<any>({
      rawApi,
      endpoint: "/api/customers",
      limit: CUSTOMER_API_PAGE_LIMIT,
      maxItems: CUSTOMER_LIST_MAX_PREFETCH,
    });
    setCustomers(payload.items);
    setCustomerTotalCount(payload.total);
    setCustomersTruncated(payload.truncated);
  }, []);

  const loadPortfolio = useCallback(async () => {
    if (!paymentsEnabled) {
      setPortfolio(null);
      setPortfolioLoaded(false);
      return;
    }
    setPortfolioLoading(true);
    setError(null);
    try {
      const portfolioRes = await rawApi("/api/ops/customer-portfolio");
      const portfolioPayload = portfolioRes.ok ? await portfolioRes.json().catch(() => null) : null;
      setPortfolio(portfolioPayload || null);
      setPortfolioLoaded(portfolioRes.ok);
      if (!portfolioRes.ok) {
        setError((current) => current || "Portefeuille client indisponible.");
      }
    } catch (err) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[customers] portfolio unavailable", err);
      }
      setPortfolio(null);
      setPortfolioLoaded(true);
      setError((current) => current || "Portefeuille client indisponible.");
    } finally {
      setPortfolioLoading(false);
    }
  }, [paymentsEnabled]);

  useEffect(() => {
    if (!paymentsEnabled || portfolioLoaded || portfolioLoading) return;
    void loadPortfolio();
  }, [loadPortfolio, paymentsEnabled, portfolioLoaded, portfolioLoading]);

  useEffect(() => {
    if (paymentsEnabled) return;
    setPortfolioMode(false);
    setPortfolio(null);
    setPortfolioLoaded(false);
    setPortfolioLoading(false);
    setSortState((current) => (current && PAYMENT_CUSTOMER_SORT_KEYS.has(current.key) ? null : current));
  }, [paymentsEnabled]);

  const merged = useMemo(() => {
    const portfolioItems = Array.isArray(portfolio?.items) ? portfolio.items : [];
    const byId = new Map(portfolioItems.map((item: any) => [item.customer_id, item]));

    const base = customers.map((customer) => {
      const p = byId.get(customer.id) || {};
      return {
        ...customer,
        portfolio: p,
        client_type: customer.client_type || p.client_type || "business",
        countryCode: String(customer.country_code || customer.country || p.country_code || "FR").toUpperCase(),
        totalRevenue: Number(p.lifetime_revenue || p.revenue_12m || 0),
        invoices: Number(p.invoice_count_total || 0),
        status: statusConfig(p),
      };
    });

    for (const item of portfolioItems) {
      if (!base.find((customer) => customer.id === item.customer_id)) {
        const countryCode = String(item.country_code || item.country || "FR").toUpperCase();
        base.push({
          id: item.customer_id,
          name: item.customer_name,
          email: item.customer_email || null,
          client_type: item.client_type || "business",
          country: countryCode,
          countryCode,
          siret: null,
          vat_number: null,
          portfolio: item,
          totalRevenue: Number(item.lifetime_revenue || item.revenue_12m || 0),
          invoices: Number(item.invoice_count_total || 0),
          status: statusConfig(item),
        });
      }
    }

    return base;
  }, [customers, portfolio]);

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return merged;

    return merged.filter((customer) => {
      const haystack = [
        customer.name,
        customer.email,
        customer.countryCode,
        customer.siret,
        customer.vat_number,
        customer.phone,
        customer.address,
        customer.address_line1,
        customer.postal_code,
        customer.city,
        customerTypeLabel(customer),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [merged, search]);

  const periodFiltered = useMemo(() => {
    return searched.filter((customer) => matchesCustomerPeriod(customer, customerPeriodFilter));
  }, [customerPeriodFilter, searched]);

  const filtered = useMemo(() => {
    return periodFiltered.filter((customer) => {
      return matchesTypeFilter(customer, typeFilter);
    });
  }, [periodFiltered, typeFilter]);
  const sortedCustomers = useMemo(() => {
    if (!sortState) return filtered;
    const direction = sortState.direction === "asc" ? 1 : -1;
    const valueFor = (customer: any) => {
      if (sortState.key === "client") return String(customer.name || "").toLowerCase();
      if (sortState.key === "contact") return customerContactLabel(customer).toLowerCase();
      if (sortState.key === "type") return customerTypeLabel(customer).toLowerCase();
      if (sortState.key === "activity") {
        const days = portfolioOptionalNumber(customer, ["days_since_last_activity"]);
        return days === null ? Number.MAX_SAFE_INTEGER : days;
      }
      if (sortState.key === "openBalance") {
        return portfolioOptionalNumber(customer, ["open_balance", "open_balance_due", "balance_due"]) ?? -1;
      }
      if (sortState.key === "overdue") {
        return portfolioOptionalNumber(customer, ["overdue_balance", "overdue_balance_due"]) ?? -1;
      }
      return String(customer.name || "").toLowerCase();
    };
    return [...filtered].sort((a, b) => {
      const aValue = valueFor(a);
      const bValue = valueFor(b);
      if (typeof aValue === "number" && typeof bValue === "number") {
        return (aValue - bValue) * direction;
      }
      return String(aValue).localeCompare(String(bValue), "fr", { sensitivity: "base" }) * direction;
    });
  }, [filtered, sortState]);
  const pageCustomers = useMemo(() => paginateList(sortedCustomers, page, pageSize), [sortedCustomers, page, pageSize]);
  const pageCustomerIds = useMemo(
    () => pageCustomers.map((customer) => String(customer.id)).filter(Boolean),
    [pageCustomers],
  );
  const selectedCustomers = useMemo(
    () => filtered.filter((customer) => selectedCustomerIds.includes(String(customer.id))),
    [filtered, selectedCustomerIds],
  );
  const allPageCustomersSelected =
    pageCustomerIds.length > 0 && pageCustomerIds.every((customerId) => selectedCustomerIds.includes(customerId));
  const toggleCustomerSelection = (customerId: string) => {
    setSelectedCustomerIds((current) =>
      current.includes(customerId) ? current.filter((id) => id !== customerId) : [...current, customerId],
    );
  };
  const toggleCustomerPageSelection = () => {
    setSelectedCustomerIds((current) => {
      if (allPageCustomersSelected) return current.filter((id) => !pageCustomerIds.includes(id));
      const next = new Set(current);
      pageCustomerIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
  };

  useEffect(() => {
    setPage(1);
  }, [customerPeriodFilter, search, typeFilter, sortState]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CUSTOMER_PAGE_SIZE_STORAGE_KEY, String(pageSize));
  }, [pageSize]);

  useEffect(() => {
    const visibleIds = new Set(filtered.map((customer) => String(customer.id)));
    setSelectedCustomerIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [filtered]);

  const totalCustomers = customerTotalCount ?? merged.length;
  const customerListHasIncompleteLocalFilters = customersTruncated || totalCustomers > customers.length;
  const totalRevenue = merged.reduce((sum, item) => sum + Number(item.totalRevenue || 0), 0);
  const typeCount = (type: CustomerTypeFilter) =>
    type === "all" ? periodFiltered.length : periodFiltered.filter((item) => matchesTypeFilter(item, type)).length;
  const openBalanceTotal = filtered.reduce(
    (sum, item) => sum + portfolioNumber(item, ["open_balance", "open_balance_due", "balance_due"]),
    0,
  );
  const overdueBalanceTotal = filtered.reduce(
    (sum, item) => sum + portfolioNumber(item, ["overdue_balance", "overdue_balance_due"]),
    0,
  );
  const portfolioFollowUpCount = filtered.filter((item) => matchesStatusFilter(item, "risk")).length;
  const dormantCount = filtered.filter((item) => portfolioNumber(item, ["days_since_last_activity"]) >= 90).length;
  const portfolioRows = useMemo(() => {
    return [...filtered]
      .sort((a, b) => {
        const riskDelta = (statusKind(b) === "risk" ? 1 : 0) - (statusKind(a) === "risk" ? 1 : 0);
        if (riskDelta !== 0) return riskDelta;
        const overdueDelta =
          portfolioNumber(b, ["overdue_balance", "overdue_balance_due"]) -
          portfolioNumber(a, ["overdue_balance", "overdue_balance_due"]);
        if (overdueDelta !== 0) return overdueDelta;
        const openDelta =
          portfolioNumber(b, ["open_balance", "open_balance_due", "balance_due"]) -
          portfolioNumber(a, ["open_balance", "open_balance_due", "balance_due"]);
        if (openDelta !== 0) return openDelta;
        return Number(b.totalRevenue || 0) - Number(a.totalRevenue || 0);
      })
      .slice(0, 6);
  }, [filtered]);

  const toggleSort = (key: CustomerSortKey) => {
    setSortState((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      return { key, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  };

  const isLoading = !hydrated || loading || (portfolioViewEnabled && portfolioLoading);

  const exportCsv = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await downloadProtectedFile("/api/customers/export.csv", "clients.csv");
      setNotice("Export de tous les clients lancé.");
    } catch (err) {
      setError(formatApiError(err, "Export CSV impossible."));
    } finally {
      setBusy(false);
    }
  };

  const downloadCustomersRowsCsv = (rowsSource: any[], filename: string, message: string) => {
    if (typeof window === "undefined" || rowsSource.length === 0) return;
    const headers = ["Nom", "Email", "Téléphone", "Type", "SIREN", "SIRET", "N° TVA", "Pays", "Factures"];
    if (paymentsEnabled) headers.push("Encours", "Retard");
    const rows = [
      headers,
      ...rowsSource.map((customer) => {
        const row = [
          customer.name || "",
          customer.email || "",
          customer.phone || "",
          customer.customer_type || customer.type || "",
          customer.siren || "",
          customer.siret || "",
          customer.vat_number || "",
          customer.country || "",
          portfolioNumber(customer, ["invoice_count_total", "invoices"]),
        ];
        if (paymentsEnabled) {
          row.push(
            moneyDetailed(portfolioNumber(customer, ["open_balance", "open_balance_due", "balance_due"])),
            moneyDetailed(portfolioNumber(customer, ["overdue_balance", "overdue_balance_due"])),
          );
        }
        return row;
      }),
    ];
    const blob = new Blob([rows.map((row) => row.map(csvEscape).join(";")).join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    setNotice(message);
  };

  const exportSelectedCustomersCsv = () => {
    downloadCustomersRowsCsv(
      selectedCustomers,
      "clients_selection.csv",
      `${selectedCustomers.length} client${selectedCustomers.length > 1 ? "s" : ""} exporté(s).`,
    );
  };

  const exportFilteredCustomersCsv = () => {
    downloadCustomersRowsCsv(
      filtered,
      "clients_vue_filtree.csv",
      `${filtered.length} client${filtered.length > 1 ? "s" : ""} exporté(s) avec les filtres affichés.`,
    );
  };

  const importCsv = async (event: any) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result: any = await apiUpload("/api/customers/import", formData);
      const imported = Number(result?.imported || 0);
      const skipped = Number(result?.skipped || 0);
      setNotice(`Import terminé : ${imported} créé(s), ${skipped} ignoré(s).`);

      await reloadCustomers();
    } catch (err) {
      setError(formatApiError(err, "Import CSV impossible."));
    } finally {
      setBusy(false);
      if (event.target) event.target.value = "";
    }
  };

  const loadDuplicates = async () => {
    setDuplicatesOpen(true);
    setDuplicatesLoading(true);
    setError(null);
    setNotice(null);
    setDedupeConfirmArmed(false);
    try {
      const res = await rawApi("/api/customers/duplicates");
      const payload = res.ok ? await res.json().catch(() => []) : await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Impossible de charger les doublons."));
      }
      setDuplicates(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setDuplicates([]);
      setError(formatApiError(err, "Impossible de charger les doublons."));
    } finally {
      setDuplicatesLoading(false);
    }
  };

  const cleanDuplicates = async () => {
    setDuplicatesLoading(true);
    setError(null);
    setNotice(null);
    try {
      const payload: any = await apiFetch("/api/customers/deduplicate", { method: "POST" });
      const removed = Array.isArray(payload?.removed) ? payload.removed.length : Number(payload?.removed || 0);
      const skipped = Array.isArray(payload?.skipped) ? payload.skipped.length : Number(payload?.skipped || 0);
      setNotice(`Doublons traités : ${removed} supprimé(s), ${skipped} conservé(s).`);
      setDedupeConfirmArmed(false);
      await loadDuplicates();
      await reloadCustomers();
    } catch (err) {
      setError(formatApiError(err, "Nettoyage des doublons impossible."));
    } finally {
      setDuplicatesLoading(false);
    }
  };

  const requestCleanDuplicates = () => {
    if (duplicates.length === 0 || duplicatesLoading) return;
    if (!dedupeConfirmArmed) {
      setDedupeConfirmArmed(true);
      setNotice(
        "Vérifiez les groupes ci-dessous, puis confirmez le nettoyage. Les clients liés à des documents ou au portail seront conservés.",
      );
      return;
    }
    void cleanDuplicates();
  };
  return (
    <div>
      <AppPageHeader
        title="Clients"
        breadcrumb="CRM"
        description="Clients — SIRET, TVA, portail et historique."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {paymentsEnabled ? (
              <GuidanceTooltip content="Ouvrez la lecture portefeuille avec encours, activité et clients à suivre.">
                <button
                  type="button"
                  onClick={() => setPortfolioMode((value) => !value)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#fed7aa] bg-white px-3 text-[#ea580c] transition-colors hover:bg-[#fff7ed]"
                  style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}
                >
                  <TrendingUp className="h-3.5 w-3.5" />
                  {portfolioMode ? "Liste clients" : "Portefeuille client"}
                </button>
              </GuidanceTooltip>
            ) : null}
            {canWriteCustomers ? (
              <GuidanceTooltip content="Crée une fiche client. Le type professionnel ou particulier se choisit dans le formulaire.">
                <Link
                  to="/app/customers/new"
                  className="pf-cta-link inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#ea580c] bg-[#f97316] px-3.5 text-white shadow-[0_8px_18px_-14px_rgba(234,88,12,0.95)] transition-colors hover:bg-[#ea580c]"
                  style={{ color: "#ffffff", fontSize: "var(--pf-app-text-body)", fontWeight: 760 }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Créer un client
                </Link>
              </GuidanceTooltip>
            ) : null}
          </div>
        }
      />

      <WorkbenchPage>
        <div className="space-y-5">
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={importCsv} />
          {notice ? (
            <NoticeBanner variant="success" title="Clients">
              {notice}
            </NoticeBanner>
          ) : null}
          {subscriptionGate ? (
            <NoticeBanner variant="warn" title="Abonnement requis">
              <>
                {subscriptionGate}{" "}
                <Link to="/app/billing/paywall" className="font-semibold underline underline-offset-2">
                  Choisir un abonnement
                </Link>
              </>
            </NoticeBanner>
          ) : null}
          {permissionDenied ? (
            <NoticeBanner variant="warn" title="Accès insuffisant">
              <>
                {permissionDenied}{" "}
                <Link to="/contact" className="font-semibold underline underline-offset-2">
                  Contacter l'admin
                </Link>
              </>
            </NoticeBanner>
          ) : null}
          {error ? (
            <NoticeBanner variant="warn" title={portfolioViewEnabled ? "Portefeuille client" : "Clients"}>
              {error}
            </NoticeBanner>
          ) : null}
          {customerListHasIncompleteLocalFilters ? (
            <NoticeBanner variant="warn" title="Base clients volumineuse">
              <>
                {customers.length.toLocaleString("fr-FR")} client{customers.length > 1 ? "s" : ""} chargé
                {customers.length > 1 ? "s" : ""} sur {totalCustomers.toLocaleString("fr-FR")}. L'export “Tous” reste
                complet; les filtres, tris et exports de vue portent sur la tranche chargée.
              </>
            </NoticeBanner>
          ) : null}

          {duplicatesOpen ? (
            <div className="rounded-2xl border border-[#fed7aa] bg-[#fff7ed] p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div
                    className="flex items-center gap-2 text-[#9a3412]"
                    style={{ fontSize: "0.875rem", fontWeight: 900 }}
                  >
                    <AlertTriangle className="h-4 w-4" /> Doublons clients
                  </div>
                  <p className="mt-1 text-[#9a3412]/80" style={{ fontSize: "0.8125rem" }}>
                    Détection par email, SIRET ou numéro de TVA. Les clients liés à des factures sont conservés.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <GuidanceTooltip content="Relance la détection des doublons à partir des emails, SIRET et numéros de TVA.">
                    <button
                      type="button"
                      onClick={loadDuplicates}
                      disabled={duplicatesLoading}
                      className="rounded-xl border border-[#fdba74] bg-white px-3 py-2 text-[#c2410c] transition-colors hover:bg-[#fff7ed] disabled:opacity-50"
                      style={{ fontSize: "0.75rem", fontWeight: 800 }}
                    >
                      Actualiser
                    </button>
                  </GuidanceTooltip>
                  <GuidanceTooltip content="Fusionne uniquement les doublons sûrs. Les clients liés à des factures sont conservés.">
                    <button
                      type="button"
                      onClick={requestCleanDuplicates}
                      disabled={duplicatesLoading || duplicates.length === 0}
                      className={`rounded-xl border px-3 py-2 transition-colors disabled:opacity-50 ${
                        dedupeConfirmArmed
                          ? "border-[#dc2626] bg-[#fef2f2] text-[#dc2626] hover:bg-white"
                          : "border-[#fb923c] bg-[#fff7ed] text-[#c2410c] hover:bg-white"
                      }`}
                      style={{ fontSize: "0.75rem", fontWeight: 900 }}
                    >
                      {dedupeConfirmArmed ? "Confirmer nettoyage" : "Nettoyer doublons"}
                    </button>
                  </GuidanceTooltip>
                  <GuidanceTooltip content="Ferme le panneau sans modifier les clients.">
                    <button
                      type="button"
                      onClick={() => setDuplicatesOpen(false)}
                      aria-label="Fermer le panneau des doublons"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#fed7aa] bg-white text-[#9a3412] transition-colors hover:bg-[#fff7ed]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </GuidanceTooltip>
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-[#fed7aa] bg-white">
                {duplicatesLoading ? (
                  <div
                    className="px-4 py-5 text-center text-[#9a3412]/70"
                    style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                  >
                    Analyse des doublons…
                  </div>
                ) : duplicates.length === 0 ? (
                  <div
                    className="px-4 py-5 text-center text-[#15803d]"
                    style={{ fontSize: "0.8125rem", fontWeight: 800 }}
                  >
                    Aucun doublon détecté.
                  </div>
                ) : (
                  <div className="divide-y divide-[#ffedd5]">
                    {duplicates.map((cluster, index) => (
                      <div
                        key={`${cluster.field}-${cluster.value}-${index}`}
                        className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(120px,0.7fr)_minmax(160px,1fr)_minmax(180px,1.2fr)]"
                      >
                        <div className="text-[#9a3412]" style={{ fontSize: "0.75rem", fontWeight: 900 }}>
                          {cluster.field === "vat_number" ? "TVA" : String(cluster.field || "").toUpperCase()}
                        </div>
                        <div className="break-all text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 800 }}>
                          {cluster.value || "—"}
                        </div>
                        <div className="text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                          Garder {String(cluster.keep || "").slice(0, 8)} · supprimer {(cluster.remove || []).length}{" "}
                          doublon(s)
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              {
                label: "Total clients",
                value: totalCustomers,
                sub: "Toutes origines",
                accent: "blue" as const,
                icon: <Users className="h-4 w-4" />,
              },
              {
                label: "CA total cumulé",
                value: money(totalRevenue),
                sub: "Toutes factures",
                accent: "green" as const,
                icon: <Building2 className="h-4 w-4" />,
              },
              {
                label: "Entreprises",
                value: typeCount("business"),
                sub: "Clients professionnels",
                accent: "purple" as const,
                icon: <TrendingUp className="h-4 w-4" />,
              },
              {
                label: "Particuliers",
                value: typeCount("individual"),
                sub: "Clients non professionnels",
                accent: "amber" as const,
                icon: <Users className="h-4 w-4" />,
              },
            ].map((card, index) => {
              return (
                <div key={card.label} className="w-full rounded-2xl text-left">
                  <StatCard
                    label={card.label}
                    value={card.value}
                    sub={card.sub}
                    accent={card.accent}
                    icon={card.icon}
                  />
                </div>
              );
            })}
          </div>

          {portfolioViewEnabled ? (
            <div className="rounded-2xl border border-[#dbeafe] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e0ecff] px-4 py-4">
                <div>
                  <p className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 900 }}>
                    Portefeuille client
                  </p>
                  <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                    Encours, retards et clients à suivre directement dans la page Clients.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPortfolioMode(false)}
                  className="rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-3 py-1 text-[#1d4ed8] transition-colors hover:bg-white"
                  style={{ fontSize: "0.6875rem", fontWeight: 900 }}
                >
                  Revenir à la liste
                </button>
              </div>

              <div className="grid gap-3 border-b border-[#eef2ff] p-4 md:grid-cols-4">
                {[
                  {
                    label: "Encours ouvert",
                    value: money(openBalanceTotal),
                    sub: "Factures non soldées",
                    icon: <FileText className="h-4 w-4" />,
                  },
                  {
                    label: "En retard",
                    value: money(overdueBalanceTotal),
                    sub: "À relancer en priorité",
                    icon: <AlertTriangle className="h-4 w-4" />,
                  },
                  {
                    label: "À suivre",
                    value: portfolioFollowUpCount,
                    sub: "Signal portefeuille",
                    icon: <TrendingUp className="h-4 w-4" />,
                  },
                  {
                    label: "Inactifs 90j+",
                    value: dormantCount,
                    sub: "À réactiver",
                    icon: <Users className="h-4 w-4" />,
                  },
                ].map((metric) => (
                  <div key={metric.label} className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] p-3">
                    <div className="flex items-center gap-2 text-[#1d4ed8]">
                      {metric.icon}
                      <span
                        style={{
                          fontSize: "0.6875rem",
                          fontWeight: 900,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        {metric.label}
                      </span>
                    </div>
                    <p className="mt-2 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 900 }}>
                      {metric.value}
                    </p>
                    <p className="mt-0.5 text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 650 }}>
                      {metric.sub}
                    </p>
                  </div>
                ))}
              </div>

              <div className="divide-y divide-[#eef2ff]">
                {isLoading ? (
                  <div
                    className="px-4 py-5 text-center text-[#94a3b8]"
                    style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                  >
                    Chargement du portefeuille…
                  </div>
                ) : portfolioRows.length === 0 ? (
                  <div
                    className="px-4 py-5 text-center text-[#64748b]"
                    style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                  >
                    Aucun client à analyser pour l'instant.
                  </div>
                ) : (
                  portfolioRows.map((customer) => {
                    const openBalance = portfolioNumber(customer, ["open_balance", "open_balance_due", "balance_due"]);
                    const overdueBalance = portfolioNumber(customer, ["overdue_balance", "overdue_balance_due"]);
                    const daysSinceActivity = portfolioNumber(customer, ["days_since_last_activity"]);
                    const invoiceTotal = portfolioNumber(customer, ["invoice_count_total"]);
                    const unpaidCount = portfolioNumber(customer, ["unpaid_invoice_count"]);
                    return (
                      <Link
                        key={`portfolio-${customer.id}`}
                        to={`/app/customers/${customer.id}`}
                        className="grid gap-3 px-4 py-3.5 transition-colors hover:bg-[#f8fafc] md:grid-cols-[minmax(180px,1.4fr)_minmax(120px,0.8fr)_minmax(120px,0.8fr)_minmax(120px,0.8fr)_minmax(120px,0.8fr)_auto]"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 900 }}>
                            {customer.name || "Client"}
                          </p>
                          <p className="truncate text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 650 }}>
                            {portfolioSegmentLabel(customer)}
                          </p>
                        </div>
                        <div>
                          <p
                            className="text-[#94a3b8]"
                            style={{
                              fontSize: "0.625rem",
                              fontWeight: 900,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                            }}
                          >
                            Factures
                          </p>
                          <p className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 850 }}>
                            {unpaidCount > 0
                              ? `${unpaidCount} impayée${unpaidCount > 1 ? "s" : ""}`
                              : `${invoiceTotal || customer.invoices || 0} facture${(invoiceTotal || customer.invoices || 0) > 1 ? "s" : ""}`}
                          </p>
                        </div>
                        <div>
                          <p
                            className="text-[#94a3b8]"
                            style={{
                              fontSize: "0.625rem",
                              fontWeight: 900,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                            }}
                          >
                            Encours
                          </p>
                          <p className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 850 }}>
                            {moneyDetailed(openBalance)}
                          </p>
                        </div>
                        <div>
                          <p
                            className="text-[#94a3b8]"
                            style={{
                              fontSize: "0.625rem",
                              fontWeight: 900,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                            }}
                          >
                            Retard
                          </p>
                          <p
                            className={overdueBalance > 0 ? "text-[#dc2626]" : "text-[#15803d]"}
                            style={{ fontSize: "0.8125rem", fontWeight: 850 }}
                          >
                            {moneyDetailed(overdueBalance)}
                          </p>
                        </div>
                        <div>
                          <p
                            className="text-[#94a3b8]"
                            style={{
                              fontSize: "0.625rem",
                              fontWeight: 900,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                            }}
                          >
                            Dernière activité
                          </p>
                          <p className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 850 }}>
                            {daysLabel(daysSinceActivity)}
                          </p>
                        </div>
                        <div className="flex items-center justify-start text-[#2563eb] md:justify-end">
                          <ArrowUpRight className="h-4 w-4" />
                        </div>
                      </Link>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}

          {!portfolioViewEnabled ? (
            <SalesListBlock
              tone="clients"
              density="client"
              filters={customerTypeTabs.map((tab) => ({
                value: tab.val,
                label: tab.label,
                count: typeCount(tab.val),
                accent:
                  tab.val === "individual"
                    ? ("purple" as const)
                    : tab.val === "public"
                      ? ("warning" as const)
                      : ("module" as const),
              }))}
              filterValue={typeFilter}
              onFilterChange={(value) => {
                setPage(1);
                setTypeFilter(value as CustomerTypeFilter);
              }}
              searchValue={search}
              onSearchChange={(value) => {
                setPage(1);
                setSearch(value);
              }}
              searchPlaceholder="Nom, email, SIRET, TVA..."
              searchWidth="16rem"
              leftExtras={
                selectedCustomers.length > 0 ? (
                  <ActionMenu
                    label="Actions"
                    badge={selectedCustomers.length}
                    triggerVariant="orange"
                    items={[
                      ...(canExportCustomers
                        ? [
                            {
                              label: "Exporter les clients sélectionnés",
                              icon: Download,
                              onClick: exportSelectedCustomersCsv,
                            },
                          ]
                        : []),
                      ...(selectedCustomers[0]?.id
                        ? [
                            {
                              label: "Ouvrir le premier client",
                              icon: ArrowRight,
                              href: `/app/customers/${selectedCustomers[0].id}`,
                            },
                          ]
                        : []),
                      { divider: true, label: "" },
                      {
                        label: "Désélectionner",
                        icon: CheckSquare,
                        onClick: () => setSelectedCustomerIds([]),
                      },
                    ]}
                  />
                ) : null
              }
              rightExtras={
                <div className="flex shrink-0 items-center gap-1.5">
                  <SalesPeriodControl
                    tone="clients"
                    value={customerPeriodFilter}
                    onChange={(nextValue) => setCustomerPeriodFilter(nextValue as CustomerPeriodFilter)}
                    options={customerPeriodOptions}
                    ariaLabel="Période d'activité clients"
                  />
                  {canWriteCustomers || canExportCustomers || canManageCustomers ? (
                    <ActionMenu
                      label="Importer / exporter"
                      iconOnly
                      triggerIcon={Settings}
                      triggerVariant="orange"
                      className="pf-toolbar-tools-menu"
                      items={[
                        ...(canWriteCustomers
                          ? [
                              {
                                label: busy ? "Import en cours" : "Importer CSV",
                                icon: Upload,
                                onClick: () => {
                                  if (!busy) fileInputRef.current?.click();
                                },
                              },
                            ]
                          : []),
                        ...(canExportCustomers
                          ? [
                              {
                                label: "Exporter",
                                icon: Download,
                                onClick: () => {
                                  if (!busy) setCustomerExportToolsOpen((current) => !current);
                                },
                              },
                            ]
                          : []),
                        ...(canManageCustomers
                          ? [
                              ...(canWriteCustomers || canExportCustomers ? [{ divider: true, label: "" }] : []),
                              {
                                label: duplicatesOpen ? "Doublons ouverts" : "Vérifier les doublons",
                                icon: AlertTriangle,
                                onClick: () => {
                                  if (!busy) void loadDuplicates();
                                },
                              },
                            ]
                          : []),
                      ]}
                    />
                  ) : null}
                </div>
              }
            >
              {customerExportToolsOpen ? (
                <div data-testid="customer-export-panel" className="border-b border-[#fed7aa] bg-[#fff7ed] p-3">
                  <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-end 2xl:justify-between">
                    <div className="grid flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(220px,0.75fr)_minmax(360px,1fr)]">
                      <label
                        className="text-[#475569]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                      >
                        Format
                        <div
                          className="mt-1 flex h-11 items-center rounded-xl border border-[#fed7aa] bg-white px-3 text-[#0f172a]"
                          style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                        >
                          CSV clients
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
                            onClick={() => void exportCsv()}
                            disabled={busy}
                            className="rounded-full border border-[#fed7aa] bg-[#fffaf5] px-3 py-1.5 text-[#ea580c] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                          >
                            Tous · {totalCustomers}
                          </button>
                          <button
                            type="button"
                            onClick={exportFilteredCustomersCsv}
                            disabled={filtered.length === 0 || customerListHasIncompleteLocalFilters}
                            className="rounded-full border border-[#f97316] bg-white px-3 py-1.5 text-[#ea580c] transition-colors hover:bg-[#fff7ed] disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                          >
                            Clients filtrés · {filtered.length}
                          </button>
                          <button
                            type="button"
                            onClick={exportSelectedCustomersCsv}
                            disabled={selectedCustomers.length === 0}
                            className="rounded-full border border-[#fed7aa] bg-[#fffaf5] px-3 py-1.5 text-[#ea580c] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                          >
                            Clients cochés · {selectedCustomers.length}
                          </button>
                        </div>
                      </label>
                    </div>
                    <GuidanceTooltip content="Télécharge le CSV selon le périmètre choisi.">
                      <button
                        type="button"
                        onClick={selectedCustomers.length > 0 ? exportSelectedCustomersCsv : exportFilteredCustomersCsv}
                        disabled={
                          busy ||
                          (selectedCustomers.length === 0 &&
                            (filtered.length === 0 || customerListHasIncompleteLocalFilters))
                        }
                        className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[#f97316] px-4 text-white shadow-[0_10px_22px_-16px_rgba(234,88,12,0.8)] transition-all hover:-translate-y-[1px] hover:bg-[#ea580c] disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 900 }}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {selectedCustomers.length > 0
                          ? "Exporter les clients sélectionnés"
                          : "Exporter les clients filtrés"}
                      </button>
                    </GuidanceTooltip>
                  </div>
                </div>
              ) : null}

              {isLoading ? (
                <div className="px-5 py-14 text-center text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  Chargement des clients…
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                      <Users className="h-5 w-5 text-[#cbd5e1]" />
                    </div>
                    <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                      {typeFilter !== "all" || search || customerPeriodFilter !== CUSTOMER_DEFAULT_PERIOD
                        ? "Aucun résultat pour ces filtres"
                        : "Aucun client pour l'instant"}
                    </p>
                    <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                      {search
                        ? `"${search}" ne correspond à aucun client.`
                        : typeFilter !== "all" || customerPeriodFilter !== CUSTOMER_DEFAULT_PERIOD
                          ? "Change le type de client, la période ou réinitialise la recherche."
                          : "Ajoutez votre premier client pour créer devis et factures plus vite."}
                    </p>
                    {typeFilter !== "all" || search || customerPeriodFilter !== CUSTOMER_DEFAULT_PERIOD ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSearch("");
                          setTypeFilter("all");
                          setCustomerPeriodFilter(CUSTOMER_DEFAULT_PERIOD);
                        }}
                        className="mt-1 text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                        style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                      >
                        Voir tous les clients
                      </button>
                    ) : canWriteCustomers ? (
                      <Link
                        to="/app/customers/new"
                        className="pf-cta-link mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[#ea580c] bg-[#f97316] px-3 py-2 text-white transition-colors hover:bg-[#ea580c]"
                        style={{ color: "#ffffff", fontSize: "0.8125rem", fontWeight: 700 }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Créer un client
                      </Link>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <div
                    className={`pf-data-list-header ${customerListGridClass} px-4 py-2.5`}
                    style={{ borderBottom: "1px solid #f1f5f9", background: "#fafbfd" }}
                  >
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={allPageCustomersSelected}
                        onChange={toggleCustomerPageSelection}
                        aria-label="Sélectionner les clients de la page"
                        className="h-[15px] w-[15px] rounded border-[#d1dcec]"
                        style={{ accentColor: "#f97316" }}
                      />
                    </div>
                    {visibleCustomerSortColumns.map((column) => {
                      const isActive = Boolean(column.key && sortState?.key === column.key);
                      return (
                        <div
                          key={column.label || column.className}
                          className={column.className}
                          style={{
                            fontSize: "var(--pf-app-text-overline)",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "#94a3b8",
                          }}
                        >
                          {column.key ? (
                            <button
                              type="button"
                              onClick={() => toggleSort(column.key!)}
                              className={`group inline-flex w-full items-center gap-1.5 transition-colors hover:text-[#ea580c] ${
                                column.align === "right"
                                  ? "justify-end text-right"
                                  : column.align === "center"
                                    ? "justify-center text-center"
                                    : "justify-start text-left"
                              } ${isActive ? "pf-sort-header-active text-[#ea580c]" : ""}`}
                              style={{
                                fontSize: "inherit",
                                fontWeight: "inherit",
                                letterSpacing: "inherit",
                                lineHeight: "inherit",
                                textTransform: "inherit",
                              }}
                              aria-label={`Trier par ${column.label}`}
                              aria-pressed={isActive}
                            >
                              <span>{column.label}</span>
                              <span
                                className={`inline-flex h-3.5 w-3.5 items-center justify-center transition-colors ${
                                  isActive ? "text-[#f97316]" : "text-[#cbd5e1] group-hover:text-[#f97316]"
                                }`}
                                aria-hidden="true"
                              >
                                {isActive ? (
                                  sortState?.direction === "asc" ? (
                                    <ArrowUp className="h-3.5 w-3.5" />
                                  ) : (
                                    <ArrowDown className="h-3.5 w-3.5" />
                                  )
                                ) : (
                                  <ArrowUpDown className="h-3.5 w-3.5" />
                                )}
                              </span>
                            </button>
                          ) : (
                            column.label
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {pageCustomers.map((customer, index) => {
                    const isLast = index === pageCustomers.length - 1;
                    const countryCode = String(customer.countryCode || customer.country || "FR").toUpperCase();
                    const contactLabel = customerContactLabel(customer);
                    const secondaryContactLabel = customerSecondaryContactLabel(customer);
                    const openBalance = portfolioOptionalNumber(customer, [
                      "open_balance",
                      "open_balance_due",
                      "balance_due",
                    ]);
                    const overdueBalance = portfolioOptionalNumber(customer, [
                      "overdue_balance",
                      "overdue_balance_due",
                    ]);
                    const maxOverdueDays = portfolioOptionalNumber(customer, ["max_overdue_days"]);
                    const daysSinceActivity = portfolioOptionalNumber(customer, ["days_since_last_activity"]);
                    const activityLabel =
                      daysSinceActivity === null
                        ? customer.invoices > 0
                          ? `${customer.invoices} facture${customer.invoices > 1 ? "s" : ""}`
                          : "Pas encore facturé"
                        : daysLabel(daysSinceActivity);

                    return (
                      <div
                        key={customer.id}
                        role="link"
                        tabIndex={0}
                        aria-label={`Ouvrir ${customer.name || "ce client"}`}
                        onClick={(event) => {
                          if (isInteractiveRowTarget(event.target)) return;
                          window.location.assign(`/app/customers/${customer.id}`);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          if (isInteractiveRowTarget(event.target)) return;
                          event.preventDefault();
                          window.location.assign(`/app/customers/${customer.id}`);
                        }}
                        className={`pf-data-list-row pf-clickable-row ${customerListGridClass} px-4 py-3.5 transition-colors hover:bg-[#f8fafc]`}
                        style={{ borderBottom: isLast ? "none" : "1px solid #f8fafc" }}
                      >
                        <input
                          type="checkbox"
                          readOnly
                          checked={selectedCustomerIds.includes(String(customer.id))}
                          aria-label={`Sélectionner ${customer.name || "ce client"}`}
                          className="h-[15px] w-[15px] flex-shrink-0 rounded border-[#d1dcec]"
                          style={{ accentColor: "#f97316" }}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleCustomerSelection(String(customer.id));
                          }}
                        />
                        <Link
                          to={`/app/customers/${customer.id}`}
                          className={customerRowContentGridClass}
                          aria-label={`Ouvrir ${customer.name || "ce client"}`}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div
                              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full"
                              style={{ background: "#fff7ed" }}
                            >
                              <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: "#ea580c" }}>
                                {String(customer.name || "?")
                                  .charAt(0)
                                  .toUpperCase()}
                              </span>
                            </div>

                            <div className="min-w-0">
                              <p
                                className="pf-row-title truncate text-[#0f172a] transition-colors group-hover:text-[#ea580c]"
                                style={{ fontSize: "0.875rem", fontWeight: 600 }}
                              >
                                {customer.name || "Client"}
                              </p>
                              <p className="pf-row-subtitle truncate text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                                <span>{contactLabel}</span>
                                <span className="hidden sm:inline">
                                  {" "}
                                  · {countryFlags[countryCode] || "🌍"} {countryCode}
                                </span>
                              </p>
                              <div className="pf-mobile-row-summary mt-2 flex flex-wrap items-center gap-1.5">
                                <span className="rounded-full bg-[#fff7ed] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#ea580c]">
                                  {customerTypeLabel(customer)}
                                </span>
                                {paymentsEnabled ? (
                                  <>
                                    <span className="rounded-full bg-[#f8fafc] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#475569]">
                                      Encours {openBalance === null ? "—" : moneyDetailed(openBalance)}
                                    </span>
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${
                                        Number(overdueBalance || 0) > 0
                                          ? "bg-[#fef2f2] text-[#dc2626]"
                                          : "bg-[#f0fdf4] text-[#15803d]"
                                      }`}
                                    >
                                      Retard{" "}
                                      {Number(overdueBalance || 0) > 0
                                        ? moneyDetailed(Number(overdueBalance || 0))
                                        : "0,00 €"}
                                    </span>
                                  </>
                                ) : null}
                                <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#64748b]">
                                  {activityLabel}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="min-w-0">
                            <p className="truncate text-[#64748b]" style={{ fontSize: "0.8125rem", fontWeight: 650 }}>
                              {secondaryContactLabel}
                            </p>
                            <p className="truncate text-[#94a3b8]" style={{ fontSize: "0.6875rem", fontWeight: 650 }}>
                              {customer.siret || customer.vat_number || customer.siren || "Identifiant à compléter"}
                            </p>
                          </div>

                          <div className="flex min-w-0 justify-center">
                            <span
                              className={`inline-flex rounded-full border px-2 py-0.5 ${customerTypeClasses(customer)}`}
                              style={{ fontSize: "0.6875rem", fontWeight: 800 }}
                            >
                              {customerTypeLabel(customer)}
                            </span>
                          </div>

                          <div className="flex min-w-0 items-center gap-1.5">
                            <FileText className="h-3.5 w-3.5 text-[#cbd5e1]" />
                            <div className="min-w-0">
                              <p className="truncate text-[#64748b]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                                {activityLabel}
                              </p>
                              <p className="truncate text-[#94a3b8]" style={{ fontSize: "0.6875rem", fontWeight: 650 }}>
                                {customer.invoices} facture{customer.invoices > 1 ? "s" : ""}
                              </p>
                            </div>
                          </div>

                          {paymentsEnabled ? (
                            <>
                              <div className="min-w-0 text-right">
                                <span style={{ fontSize: "0.875rem", fontWeight: 800, color: "#0f172a" }}>
                                  {openBalance === null ? "—" : moneyDetailed(openBalance)}
                                </span>
                                <p
                                  className={Number(overdueBalance || 0) > 0 ? "text-[#dc2626]" : "text-[#94a3b8]"}
                                  style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                                >
                                  {openBalance === null
                                    ? "Non calculé"
                                    : Number(openBalance || 0) > 0
                                      ? "À encaisser"
                                      : "Solde ouvert"}
                                </p>
                              </div>

                              <div className="min-w-0 text-right">
                                <span
                                  className={Number(overdueBalance || 0) > 0 ? "text-[#dc2626]" : "text-[#15803d]"}
                                  style={{ fontSize: "0.8125rem", fontWeight: 800 }}
                                >
                                  {Number(overdueBalance || 0) > 0
                                    ? moneyDetailed(Number(overdueBalance || 0))
                                    : "0,00 €"}
                                </span>
                                <p
                                  className={Number(overdueBalance || 0) > 0 ? "text-[#dc2626]" : "text-[#94a3b8]"}
                                  style={{ fontSize: "0.6875rem", fontWeight: 700 }}
                                >
                                  {Number(overdueBalance || 0) > 0
                                    ? maxOverdueDays && maxOverdueDays > 0
                                      ? String(Math.round(maxOverdueDays)) + " j retard"
                                      : "À relancer"
                                    : "Aucun retard"}
                                </p>
                              </div>
                            </>
                          ) : null}

                          <div className="flex min-w-0 items-center justify-end gap-1.5 text-[#f97316] transition-colors group-hover:text-[#ea580c]">
                            <span
                              className="pf-action-icon pf-action-icon--customer"
                              aria-label="Ouvrir"
                              title="Ouvrir"
                            >
                              <ArrowRight className="h-3.5 w-3.5 flex-shrink-0" />
                            </span>
                          </div>
                        </Link>
                      </div>
                    );
                  })}
                </div>
              )}

              <ListPagination
                page={page}
                totalItems={filtered.length}
                pageSize={pageSize}
                pageSizeOptions={CUSTOMER_PAGE_SIZE_OPTIONS}
                pageSizeAriaLabel="Clients par page"
                itemLabel="client"
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPage(1);
                  setPageSize(nextPageSize);
                }}
                action={
                  typeFilter !== "all" || customerPeriodFilter !== CUSTOMER_DEFAULT_PERIOD || search || sortState ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setTypeFilter("all");
                        setCustomerPeriodFilter(CUSTOMER_DEFAULT_PERIOD);
                        setSortState(null);
                      }}
                      className="text-xs font-medium text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                    >
                      Réinitialiser
                    </button>
                  ) : null
                }
              />
            </SalesListBlock>
          ) : null}
        </div>
      </WorkbenchPage>
    </div>
  );
}

export { CustomerDetailPage, CustomerNewPage } from "../../../src/figma/app/pages/app/CustomersPage";
